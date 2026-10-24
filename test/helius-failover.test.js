// R20 (24 Oct 2026): Helius's free plan was at 1,000,000 of 1,000,000 credits from 23 Oct to 9 Nov and every AgentFeed route that reads Solana went dark with it.
// Every Solana RPC call in this repo now goes through lib/rpc-failover.cjs (via lib/solrpc.js): a counted client that moves a call to RPC_FALLBACKS when the
// primary answers 429, 402, 403, 5xx or drops, rests the primary for 10 minutes, and says "no answer" as a 503 (not charged) when nobody answers.
// The Jito collector leads with the free public RPC and runs every 15 minutes. Fault injection throughout: loopback servers stand in for Helius (primary, always
// 429) and for the public RPC (fallback); nothing here leaves the machine.
'use strict';
const _test = require('node:test');
// a hung loopback server or child must fail the one test, not stall the whole file
const test = (name, fn) => _test(name, { timeout: 90_000 }, fn);
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const FO = require('../lib/rpc-failover.cjs');
const SR = require('../lib/solrpc');

const KEY = 'SECRETKEY-do-not-print-0123456789';
const HELIUS_URL = `https://mainnet.helius-rpc.com/?api-key=${KEY}`;
const FB = 'https://api.mainnet-beta.solana.com';
const MINT = 'So11111111111111111111111111111111111111112';
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const ok = (result) => ({ status: 200, body: { jsonrpc: '2.0', id: 1, result } });
const rpcErr = (code, message) => ({ status: 200, body: { jsonrpc: '2.0', id: 1, error: { code, message } } });
const refuse = (status = 429) => () => ({ status, body: { jsonrpc: '2.0', error: { code: status, message: 'max usage reached' }, id: null } });
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const bodyOf = (init) => JSON.parse(init.body);

// ---------------------------------------------------------------- the client, with an injected fetch and a fake clock
function rig({ primary = HELIUS_URL, fallbacks = [FB], handlers = {}, stayMs = 600_000 } = {}) {
  const clock = { t: 1_000_000 };
  const seen = []; const logs = [];
  const fetchImpl = async (url, init) => {
    const host = new URL(url).host; const m = bodyOf(init).method;
    seen.push(`${host} ${m}`);
    const h = handlers[host]; if (!h) throw new Error('no handler for ' + host);
    const r = await h(m, init);
    if (r instanceof Response) return r;
    if (r === 'drop') throw Object.assign(new TypeError('fetch failed'), { cause: new Error('ECONNRESET') });
    if (r === 'timeout') throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    return json(r.status || 200, r.body);
  };
  const ep = FO.create({ name: 'test', primary, fallbacks, now: () => clock.t, stayMs, fetch: fetchImpl, log: (l) => logs.push(l) });
  return { ep, clock, seen, logs };
}
const HELIUS = 'mainnet.helius-rpc.com', PUBLIC = 'api.mainnet-beta.solana.com';

test('R20 client: every refusal of the primary (429, 402, 401, 403, 500, 502, 503, a dropped connection, a timeout) moves the call to the fallback, which answers', async () => {
  for (const why of [429, 402, 401, 403, 500, 502, 503, 'drop', 'timeout']) {
    const { ep, seen, logs } = rig({ handlers: {
      [HELIUS]: () => (typeof why === 'number' ? { status: why, body: { error: 'x' } } : why),
      [PUBLIC]: () => ok(42),
    } });
    assert.equal(await ep.call('getSlot', []), 42, String(why));
    assert.deepEqual(seen, [`${HELIUS} getSlot`, `${PUBLIC} getSlot`], `${why}: primary first, then the fallback`);
    assert.equal(logs.filter((l) => /rpc_failover/.test(l)).length, 1, `${why}: one failover line`);
  }
});

test('R20 client: a 200 carrying a JSON-RPC error, and a 400, are answers: they never move the call and never touch the fallback', async () => {
  const { ep, seen } = rig({ handlers: { [HELIUS]: () => rpcErr(-32602, 'Invalid param: wrong size'), [PUBLIC]: () => ok(1) } });
  await assert.rejects(ep.call('getAccountInfo', ['x']), (e) => e.rpc && e.rpc.code === -32602 && !e.transport);
  assert.deepEqual(seen, [`${HELIUS} getAccountInfo`]);
  const r2 = rig({ handlers: { [HELIUS]: () => ({ status: 400, body: { jsonrpc: '2.0', id: 1, error: { code: -32600, message: 'bad request' } } }), [PUBLIC]: () => ok(1) } });
  await assert.rejects(r2.ep.call('getAccountInfo', ['x']), (e) => e.rpc && e.rpc.code === -32600);
  assert.deepEqual(r2.seen, [`${HELIUS} getAccountInfo`], 'a 400 is the caller\'s problem, not the endpoint\'s');
});

test('R20 client: after a failover the primary rests for 10 minutes (no probe), is probed once the window ends, and the first good answer logs rpc_primary_back', async () => {
  let primaryUp = false;
  const { ep, clock, seen, logs } = rig({ handlers: { [HELIUS]: () => (primaryUp ? ok('primary') : { status: 429, body: {} }), [PUBLIC]: () => ok('fallback') } });
  assert.equal(await ep.call('getSlot', []), 'fallback');
  seen.length = 0;
  clock.t += 5 * 60_000;
  assert.equal(await ep.call('getSlot', []), 'fallback');
  assert.deepEqual(seen, [`${PUBLIC} getSlot`], 'inside the window: the primary is not asked');
  seen.length = 0; clock.t += 6 * 60_000;                    // 11 minutes after the failure: probe the primary again
  assert.equal(await ep.call('getSlot', []), 'fallback', 'still refused: the same call lands on the fallback');
  assert.deepEqual(seen, [`${HELIUS} getSlot`, `${PUBLIC} getSlot`], 'the probe went to the primary first');
  primaryUp = true; seen.length = 0; clock.t += 11 * 60_000;
  assert.equal(await ep.call('getSlot', []), 'primary', 'recovery: the primary leads again');
  assert.deepEqual(seen, [`${HELIUS} getSlot`]);
  assert.equal(logs.filter((l) => /rpc_primary_back/.test(l)).length, 1);
  assert.equal(logs.filter((l) => /rpc_failover/.test(l)).length, 1, 'a primary that keeps failing logs its failover once, not on every probe');
});

test('R20 client: each endpoint rests on its own: a dead fallback is not asked on every call, a primary that is only rate limited now and then keeps serving, and nothing flaps in the log', async () => {
  let primaryCalls = 0;
  const { ep, clock, seen, logs } = rig({ handlers: { [HELIUS]: () => ({ status: 429, body: {} }), [PUBLIC]: () => (++primaryCalls === 1 ? { status: 429, body: {} } : ok('public')) }, primary: FB, fallbacks: [HELIUS_URL] });
  await assert.rejects(ep.call('getTransaction', ['s']), (e) => e.transport, 'the first call: both refuse');
  seen.length = 0; clock.t += 1000;
  assert.equal(await ep.call('getTransaction', ['s']), 'public', 'both endpoints rest, so the one that recovers soonest (the primary) is tried first, and it answers');
  assert.equal(await ep.call('getTransaction', ['s']), 'public');
  assert.deepEqual(seen, [`${PUBLIC} getTransaction`, `${PUBLIC} getTransaction`], 'the dead fallback is not asked at all while the primary keeps answering');
  assert.equal(logs.filter((l) => /rpc_failover/.test(l)).length, 2, 'one line per endpoint that went down');
  assert.equal(logs.filter((l) => /rpc_primary_back|rpc_endpoint_back/.test(l)).length, 0, 'an answer inside the rest is not a recovery: no back line, no flapping');
  clock.t += 11 * 60_000; seen.length = 0;
  assert.equal(await ep.call('getTransaction', ['s']), 'public');
  assert.deepEqual(seen, [`${PUBLIC} getTransaction`], 'after the rest the primary leads again');
  assert.equal(logs.filter((l) => /rpc_primary_back/.test(l)).length, 1, 'and only now is it logged as back');
});

test('R20 client: when no endpoint answers the call is a 503 transport error that names hosts and statuses and never a key', async () => {
  const { ep, logs } = rig({ handlers: { [HELIUS]: refuse(429), [PUBLIC]: refuse(429) } });
  const err = await ep.call('getTokenLargestAccounts', [MINT]).then(() => null, (e) => e);
  assert.ok(err && err.transport === true && err.status === 503, 'transport 503');
  assert.match(err.message, /http 429/, 'solpretrade backs off on /http 429/: the message keeps that shape');
  assert.match(err.message, /mainnet\.helius-rpc\.com/);
  const usage = ep.logUsage((l) => logs.push(l));
  const all = [err.message, JSON.stringify(err.tried), ...logs, JSON.stringify(usage)].join('\n');
  assert.ok(!all.includes(KEY) && !/api-key/.test(all), 'no key in an error, a log line or the usage');
  assert.ok(logs.some((l) => /rpc_failover/.test(l)) && logs.some((l) => /rpc_usage/.test(l)));
  const drop = rig({ handlers: { [HELIUS]: () => 'drop', [PUBLIC]: () => 'timeout' } });
  await assert.rejects(drop.ep.call('getSlot', []), (e) => e.transport && e.status === 503 && /dropped/.test(e.message) && /timeout/.test(e.message));
});

test('R20 client: methods only Helius serves never go to a fallback (an honest error, never a guess); a non-Helius primary has no endpoint for them', async () => {
  const down = rig({ handlers: { [HELIUS]: refuse(429), [PUBLIC]: () => ok('WRONG') } });
  await assert.rejects(down.ep.call('getAsset', [{ id: MINT }]), (e) => e.transport && e.status === 503);
  assert.deepEqual(down.seen, [`${HELIUS} getAsset`], 'Helius only: the public node was never asked');
  const up = rig({ handlers: { [HELIUS]: () => ok({ asset: 1 }), [PUBLIC]: () => ok('WRONG') } });
  assert.deepEqual(await up.ep.call('getAsset', [{ id: MINT }]), { asset: 1 });
  const none = rig({ primary: FB, fallbacks: [], handlers: { [PUBLIC]: () => ok('WRONG') } });
  await assert.rejects(none.ep.call('getPriorityFeeEstimate', [{}]), (e) => e.noEndpoint && e.status === 503);
  assert.deepEqual(none.seen, [], 'no endpoint answers it: nothing was sent');
  assert.ok(FO.HELIUS_ONLY.has('getProgramAccountsV2') && FO.HELIUS_ONLY.has('searchAssets') && !FO.HELIUS_ONLY.has('getAccountInfo'), 'control: the set names the DAS and V2 methods and not a standard one');
});

test('R20 client: a devnet or testnet primary gets no fallbacks; a missing primary lets the first fallback lead; RPC_FALLBACKS is parsed strictly', () => {
  const dev = FO.create({ primary: 'https://api.devnet.solana.com', fallbacks: [FB], fetch: () => {} });
  assert.deepEqual(dev.urls, ['https://api.devnet.solana.com'], 'the mainnet public RPC would answer for a different cluster');
  assert.equal(FO.create({ primary: '', fallbacks: [FB], fetch: () => {} }).primary, FB);
  assert.throws(() => FO.create({ primary: '', fallbacks: [], fetch: () => {} }), /no RPC endpoint/);
  assert.deepEqual(FO.parseFallbacks(undefined), [FO.PUBLIC_MAINNET_RPC]);
  assert.deepEqual(FO.parseFallbacks(''), []);
  assert.deepEqual(FO.parseFallbacks(' https://a.example/x , https://b.example '), ['https://a.example/x', 'https://b.example']);
  assert.throws(() => FO.parseFallbacks('http://a.example'), /https/);
  assert.throws(() => FO.parseFallbacks('not a url'), /https/);
  assert.deepEqual(FO.parseFallbacks('http://127.0.0.1:9'), ['http://127.0.0.1:9'], 'loopback http is allowed, for tests');
});

test('R20 client: calls are counted per method and per host, one rpc_usage line carries them (hosts only), and reading resets the window', async () => {
  const { ep, logs } = rig({ handlers: { [HELIUS]: refuse(429), [PUBLIC]: () => ok(1) } });
  await ep.call('getTransaction', ['s1']); await ep.call('getTransaction', ['s2']); await ep.call('getSignaturesForAddress', ['a']);
  const u = ep.logUsage((l) => logs.push(l), 600);
  assert.equal(u.calls.getTransaction, 3, 'counted per attempt: the first call tried the primary and then the fallback (2), the second went straight to the fallback (1)');
  assert.equal(u.calls.getSignaturesForAddress, 1);
  assert.equal(u.hosts[PUBLIC], 3); assert.equal(u.hosts[HELIUS], 1, 'the primary was asked once, then left alone');
  assert.equal(u.failovers, 1);
  const line = logs.find((l) => /rpc_usage/.test(l));
  const o = JSON.parse(line.slice(line.indexOf('{')));
  assert.equal(o.total, 4); assert.equal(o[`host:${PUBLIC}`], 3); assert.equal(o[`host:${HELIUS}`], 1); assert.equal(o[`failed:${HELIUS}`], 1);
  assert.equal(o.onFallback, true); assert.equal(o.name, 'test'); assert.equal(o.windowS, 600);
  assert.ok(!line.includes(KEY), 'a key never reaches the usage line');
  assert.equal(ep.takeUsage().total, 0, 'the window was reset');
  const quiet = []; ep.logUsage((l) => quiet.push(l)); assert.deepEqual(quiet, [], 'an idle window prints nothing');
});

test('R20 client: fetch() is a drop-in for web3.js (Connection({ fetch })): the URL it is given is ignored, the endpoints decide, a refusal moves it on', async () => {
  const { ep, seen } = rig({ handlers: { [HELIUS]: refuse(402), [PUBLIC]: () => ok('web3') } });
  const res = await ep.fetch('https://ignored.example/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getParsedTransaction', params: [] }) });
  assert.equal(res.status, 200); assert.equal((await res.json()).result, 'web3');
  assert.deepEqual(seen, [`${HELIUS} getParsedTransaction`, `${PUBLIC} getParsedTransaction`]);
  const both = rig({ handlers: { [HELIUS]: refuse(429), [PUBLIC]: refuse(429) } });
  const r2 = await both.ep.fetch('x', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSlot', params: [] }) });
  assert.equal(r2.status, 429, 'the last endpoint\'s own refusal is returned to the caller (web3.js then backs off)');
});

// ---------------------------------------------------------------- the callers, against loopback servers
function serve(handler) {
  const calls = [];
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; });
    req.on('end', () => {
      let j = null; try { j = JSON.parse(b); } catch { /* not JSON */ }
      calls.push(j ? j.method : null);
      const r = j ? handler(j) : { status: 400, body: {} };
      if (r === 'drop') return req.socket.destroy();
      res.statusCode = r.status || 200; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(r.body));
    });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${srv.address().port}`, calls, close: () => srv.close() })));
}
const mintAccount = { context: { slot: 1 }, value: { owner: TOKEN_PROGRAM, lamports: 1, data: { program: 'spl-token', parsed: { type: 'mint', info: { decimals: 6, supply: '1000000000', mintAuthority: null, freezeAuthority: null, extensions: [] } }, space: 82 } } };
function fakeChain(over = {}) {
  return (j) => {
    if (over[j.method]) return over[j.method](j);
    switch (j.method) {
      case 'getAccountInfo': return ok(Array.isArray(j.params) && j.params[1] && j.params[1].encoding === 'jsonParsed' ? mintAccount : { context: { slot: 1 }, value: null });
      case 'getTokenLargestAccounts': return ok({ context: { slot: 1 }, value: [{ address: 'A1', uiAmountString: '600', uiAmount: 600 }, { address: 'A2', uiAmountString: '100', uiAmount: 100 }] });
      case 'getRecentPrioritizationFees': return ok([{ slot: 1, prioritizationFee: 100 }, { slot: 2, prioritizationFee: 200 }, { slot: 3, prioritizationFee: 400 }, { slot: 4, prioritizationFee: 800 }]);
      case 'getRecentPerformanceSamples': return ok([{ numTransactions: 4000, samplePeriodSecs: 60 }]);
      case 'getEpochInfo': return ok({ absoluteSlot: 1000, epoch: 5, slotIndex: 100, slotsInEpoch: 400 });
      case 'getMultipleAccounts': return ok({ context: { slot: 1 }, value: j.params[0].map(() => null) });
      case 'getSignaturesForAddress': return ok([{ signature: 'sig1', err: null }, { signature: 'sig2', err: null }]);
      case 'getTransaction': return ok(null);
      default: return rpcErr(-32601, 'Method not found');
    }
  };
}
/** Point the process-wide client at a primary that always says 429 (Helius out of credits) and a fallback (the public RPC). */
async function withRpc(fallbackHandler, run, { primaryHandler = refuse(429), fallbacksEnv } = {}) {
  const primary = await serve(primaryHandler); const fb = await serve(fallbackHandler);
  const saved = { a: process.env.SOLANA_RPC_URL, b: process.env.HELIUS_RPC, c: process.env.RPC_FALLBACKS, d: process.env.HELIUS_API_KEY };
  process.env.SOLANA_RPC_URL = `${primary.url}/?api-key=${KEY}`; delete process.env.HELIUS_RPC; process.env.RPC_FALLBACKS = fallbacksEnv === undefined ? fb.url : fallbacksEnv; process.env.HELIUS_API_KEY = 'x';
  SR._reset();
  try { return await run({ primary, fb }); } finally {
    for (const [k, v] of [['SOLANA_RPC_URL', saved.a], ['HELIUS_RPC', saved.b], ['RPC_FALLBACKS', saved.c], ['HELIUS_API_KEY', saved.d]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    SR._reset(); primary.close(); fb.close();
  }
}

test('R20 callers: lib/solrpc, priority-fees, sol-network and token-risk all move to the fallback while the primary answers 429; the primary is asked once and then rests', async () => {
  const S2 = require('../tools/solana2'); const TR = require('../tools/tokenrisk');
  await withRpc(fakeChain(), async ({ primary, fb }) => {
    const a = await SR.rpc('getAccountInfo', [MINT, { encoding: 'jsonParsed' }]);
    assert.equal(a.value.owner, TOKEN_PROGRAM);
    const fees = await S2.getPriorityFees();
    assert.equal(fees.slots, 4); assert.equal(fees.recommended, 400);
    const net = await S2.getSolNetwork();
    assert.equal(net.epoch, 5);
    const risk = await TR.getTokenRisk(MINT);
    assert.equal(risk.concentration.top1_pct, 60, 'the holders came from the fallback');
    assert.deepEqual(primary.calls, ['getAccountInfo'], 'the primary saw ONE call (the first), then rested for 10 minutes');
    assert.ok(fb.calls.includes('getTokenLargestAccounts') && fb.calls.includes('getRecentPrioritizationFees') && fb.calls.includes('getEpochInfo'));
    const usage = SR.endpoints().takeUsage();
    assert.ok(usage.calls.getAccountInfo >= 2 && usage.calls.getTokenLargestAccounts === 1 && usage.failovers === 1, JSON.stringify(usage.calls));
  });
});

test('R20 callers: a refusal is an outage, not an answer. token-risk and token-holders (getTokenLargestAccounts is refused by the public node) are 503 and never "too many holders"', async () => {
  const S2 = require('../tools/solana2'); const TR = require('../tools/tokenrisk');
  await withRpc(fakeChain({ getTokenLargestAccounts: refuse(429) }), async () => {
    await assert.rejects(TR.getTokenRisk(MINT), (e) => e.status === 503 && e.transport && !/too many holders/.test(e.message) && /Not charged/.test(e.message) && !/helius|solana\.com|127\.0\.0\.1|api-key/i.test(e.message), 'a 503 that says it is not charged and names no provider');
    await assert.rejects(S2.getTokenHolders({ mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYD' }), (e) => e.status === 503 && e.transport);
  });
  // the node's OWN answer "too many accounts" is still the documented soft failure of token-risk (a mega-holder mint), and a 400 for token-holders
  await withRpc(fakeChain({ getTokenLargestAccounts: () => rpcErr(-32600, 'Too many accounts requested (10000000 pubkeys)') }), async () => {
    const r = await TR.getTokenRisk(MINT);
    assert.equal(r.concentration.top10_pct, null);
    assert.match(r.concentration.note, /too many holders/);
    await assert.rejects(S2.getTokenHolders({ mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYE' }), (e) => e.badRequest === true);
  });
});

test('R20 callers: wallet-activity never turns an outage into "this wallet has no transactions"; a pruned transaction (null) is skipped', async () => {
  const S2 = require('../tools/solana2');
  await withRpc(fakeChain({ getTransaction: refuse(429) }), async () => {
    await assert.rejects(S2.getWalletActivity({ wallet: MINT, limit: 2 }), (e) => e.status === 503 && e.transport);
  });
  await withRpc(fakeChain({ getTransaction: () => ok(null) }), async () => {
    const r = await S2.getWalletActivity({ wallet: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYF', limit: 2 });
    assert.equal(r.tx_count, 0, 'the node answered: those transactions are not available');
  });
});

test('R20 callers: the spot price (dexspot readPools) and the peg collector read through the failover; the pre-trade routes end in a 503 when no endpoint answers', async () => {
  const DEX = require('../tools/dexspot'); const PEG = require('../tools/pegonchain'); const SP = require('../tools/solpretrade');
  await withRpc(fakeChain(), async ({ primary, fb }) => {
    const r = await DEX.readPools('SOL').catch((e) => e);
    assert.ok(Array.isArray(r.quotes) || r instanceof Error);
    assert.ok(fb.calls.includes('getMultipleAccounts'), 'the pool read reached the fallback');
    assert.ok(primary.calls.every((m) => m === 'getMultipleAccounts') && primary.calls.length === 1, 'the primary was asked once');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'r20-peg-'));
    process.env.PEG_ONCHAIN_DB = path.join(tmp, 'peg.db'); process.env.PEGWATCH_DB = path.join(tmp, 'none.db');
    fb.calls.length = 0;
    await PEG.collect({ log: () => {} }).catch(() => {});
    assert.ok(fb.calls.includes('getMultipleAccounts'), 'the peg collector\'s pool read reached the fallback');
    delete process.env.PEG_ONCHAIN_DB; delete process.env.PEGWATCH_DB;
  });
  // both endpoints refuse everything: tokenCheck must not come back as a paid, partial answer (tolerant reads would otherwise record "gaps")
  await withRpc(refuse(429), async () => {
    SP._caches.checkCache.clear();
    await assert.rejects(SP.tokenCheck({ mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYG' }), (e) => e.status === 503 && /Not charged/.test(e.message), 'tokenCheck is a 503 with no endpoint');
  });
});

test('R20 guard: no module under tools/, bin/ or lib/ builds a Helius URL except lib/solrpc.js (the one place the primary is chosen), and none calls fetch with a Solana RPC URL of its own', () => {
  const root = path.join(__dirname, '..');
  const files = ['tools', 'bin', 'lib'].flatMap((d) => fs.readdirSync(path.join(root, d)).filter((f) => /\.(c?js|mjs)$/.test(f)).map((f) => path.join(d, f)));
  assert.ok(files.length > 60, `control: the scan saw the source files (${files.length})`);
  const re = /helius-rpc\.com|HELIUS_API_KEY|HELIUS_RPC|SOLANA_RPC_URL/;
  assert.ok(re.test("const u = 'https://mainnet.helius-rpc.com/?api-key=' + process.env.HELIUS_API_KEY"), 'control: the pattern finds a real hit');
  const hits = files.filter((f) => re.test(fs.readFileSync(path.join(root, f), 'utf8')) && !['lib/solrpc.js', 'lib/rpc-failover.cjs'].includes(f.replace(/\\/g, '/')));
  // the Jito collector names the variables to build its fallback list, and nothing else may
  assert.deepEqual(hits.map((f) => f.replace(/\\/g, '/')).sort(), ['bin/jito-tips-collect.js'].filter((f) => hits.map((h) => h.replace(/\\/g, '/')).includes(f)), `files that choose a Solana RPC themselves: ${hits.join(', ')}`);
});

test('R20 callers: a pre-trade route whose tolerant reads lost an endpoint answer is a 503, never a paid partial answer (one AMM scan fails, the others answer empty)', async () => {
  const SP = require('../tools/solpretrade');
  const ORCA = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';
  const outage = Object.assign(new Error('solana rpc http 500. Not charged.'), { status: 503, transport: true });
  const mock = async (method, params) => {
    switch (method) {
      case 'getAccountInfo': return params[1] && params[1].encoding === 'jsonParsed' ? mintAccount : { context: { slot: 1 }, value: null };
      case 'getProgramAccounts': if (params[0] === ORCA) throw outage; return [];
      case 'getTokenLargestAccounts': return { context: { slot: 1 }, value: [{ address: 'A1', uiAmountString: '600', uiAmount: 600 }] };
      case 'getMultipleAccounts': return { context: { slot: 1 }, value: params[0].map(() => null) };
      default: throw new Error('unexpected ' + method);
    }
  };
  const ctx = SP.makeCtx({ rpc: mock, budget: 500 });
  await assert.rejects(SP.tokenCheck({ mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYG' }, { ctx }), (e) => e.status === 503 && /did not answer/.test(e.message) && /Not charged/.test(e.message) && !/Not charged\.\)/.test(e.message));
  assert.ok(ctx.outage, 'the failure was remembered on the ctx');
  // control: the same chain with no failing scan answers
  const ctx2 = SP.makeCtx({ rpc: async (m, p) => (m === 'getProgramAccounts' ? [] : mock(m, p)), budget: 500 });
  const ok2 = await SP.tokenCheck({ mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkZ11McCe8BenwNYG' }, { ctx: ctx2 }).then((r) => r, (e) => e);
  assert.ok(!(ok2 instanceof Error && ok2.status === 503 && /did not answer/.test(ok2.message)), 'control: no outage, no outage error');
});

// ---------------------------------------------------------------- the Jito collector (a child process against loopback "public" and "Helius" servers)
function tipChain(onCall) {
  return (j) => {
    if (onCall) onCall(j);
    if (j.method === 'getSignaturesForAddress') return ok(Array.from({ length: 10 }, (_, i) => ({ signature: `${j.params[0]}|${i}`, err: null })));
    if (j.method === 'getTransaction') {
      const [acct, i] = j.params[0].split('|'); const tip = 1000 + Number(i) * 100;
      return ok({ slot: 100 + Number(i), transaction: { message: { accountKeys: [acct, 'Other1111111111111111111111111111111111111'] } }, meta: { err: null, preBalances: [5000, 9000], postBalances: [5000 + tip, 9000 - tip], loadedAddresses: { writable: [], readonly: [] } } });
    }
    return rpcErr(-32601, 'Method not found');
  };
}
// the loopback servers live in THIS process: the child must be run asynchronously (a spawnSync would block them and the child would wait for ever)
function runChild(env) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'jito-tips-collect.js')], { env: { PATH: process.env.PATH, JITO_GAP_MS: '0', ...env } });
    let out = ''; let err = ''; c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { err += d; });
    const kill = setTimeout(() => c.kill('SIGKILL'), 40_000);
    c.on('close', (code) => { clearTimeout(kill); resolve({ status: code, stdout: out, stderr: err }); });
  });
}
async function runCron(env) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'r20-jito-')); const file = path.join(tmp, 'jito-tips.json');
  const r = await runChild({ JITO_TIPS_FILE: file, ...env });
  return { r, file, out: r.stdout, snap: fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null };
}

test('R20 jito collector: leads with the public RPC and never touches the Helius fallback while the public RPC answers; one rpc_usage line says who served what', async () => {
  const pub = await serve(tipChain()); const hel = await serve(tipChain());
  try {
    const { r, snap, out } = await runCron({ JITO_RPC_PRIMARY: pub.url, JITO_RPC_FALLBACKS: hel.url });
    assert.equal(r.status, 0, out + r.stderr);
    assert.ok(snap && snap.sample.tips === 80 && snap.sample.accounts === 8, JSON.stringify(snap && snap.sample));
    assert.equal(snap.refresh, 'every 15 minutes'); assert.ok(Date.now() - Date.parse(snap.as_of) < 60_000);
    assert.equal(hel.calls.length, 0, 'Helius was not called at all');
    assert.equal(pub.calls.filter((m) => m === 'getSignaturesForAddress').length, 8); assert.equal(pub.calls.filter((m) => m === 'getTransaction').length, 80);
    const line = out.split('\n').find((l) => /rpc_usage/.test(l)); const u = JSON.parse(line.slice(line.indexOf('{')));
    assert.equal(u.name, 'jito-tips'); assert.equal(u.getTransaction, 80); assert.equal(u.total, 88); assert.equal(u.failovers, 0); assert.equal(u.onFallback, false);
    assert.ok(Object.keys(u).some((k) => k === `host:${new URL(pub.url).host}`));
  } finally { pub.close(); hel.close(); }
});

test('R20 jito collector: with NOTHING configured it still leads with the public RPC (the default primary), and a configured Helius URL is only the fallback', async () => {
  const pub = await serve(tipChain()); const hel = await serve(tipChain());
  try {
    const { r, snap, out } = await runCron({ NODE_OPTIONS: `--require ${path.join(__dirname, 'helpers', 'redirect-public-rpc.cjs')}`, REDIRECT_PUBLIC_RPC: pub.url, SOLANA_RPC_URL: `${hel.url}/?api-key=${KEY}` });
    assert.equal(r.status, 0, out + r.stderr);
    assert.equal(snap.sample.tips, 80);
    assert.equal(pub.calls.length, 88, 'every call went to the (redirected) public RPC');
    assert.equal(hel.calls.length, 0, 'the configured Helius URL, the only thing SOLANA_RPC_URL names, was never called');
    assert.ok(!out.includes(KEY));
  } finally { pub.close(); hel.close(); }
});

test('R20 jito collector: a public RPC that answers 429 moves the run to the Helius fallback (and says so); both down writes nothing and fails loudly, the old snapshot just ages', async () => {
  const pub = await serve(refuse(429)); const hel = await serve(tipChain());
  try {
    const a = await runCron({ JITO_RPC_PRIMARY: pub.url, JITO_RPC_FALLBACKS: hel.url });
    assert.equal(a.r.status, 0, a.out); assert.equal(a.snap.sample.tips, 80);
    assert.equal(pub.calls.length, 1, 'the public RPC was asked once, then rested for the rest of the run');
    assert.equal(hel.calls.filter((m) => m === 'getTransaction').length, 80, 'the fallback served the sample');
    assert.match(a.out, /rpc_failover/); assert.match(a.out, /"onFallback":true/);
  } finally { hel.close(); }
  const dead = await serve(refuse(429));
  try {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'r20-jito-old-')); const file = path.join(tmp, 'jito-tips.json');
    const old = { unit: 'SOL', as_of: '2026-10-22T00:00:00.000Z', percentiles: { p75: 1 } }; fs.writeFileSync(file, JSON.stringify(old));
    const r = await runChild({ JITO_TIPS_FILE: file, JITO_RPC_PRIMARY: pub.url, JITO_RPC_FALLBACKS: dead.url });
    assert.equal(r.status, 1); assert.match(r.stdout, /jito-tips FAILED/); assert.match(r.stdout, /rpc_usage/);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), old, 'a failed run leaves the old snapshot untouched (it is not refreshed to look fresh)');
  } finally { pub.close(); dead.close(); }
});

test('R20 jito route: the snapshot is served with its age up to 45 minutes (three missed runs), refused as a 503 not charged beyond that, and JITO_MAX_AGE_S overrides', async () => {
  const S2 = require('../tools/solana2');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'r20-jito-age-')); const file = path.join(tmp, 'jito-tips.json'); process.env.JITO_TIPS_FILE = file;
  const write = (ageS) => fs.writeFileSync(file, JSON.stringify({ unit: 'SOL', percentiles: { p75: 0.001 }, as_of: new Date(Date.now() - ageS * 1000).toISOString() }));
  try {
    write(14 * 60); const a = await S2.getJitoTips(); assert.ok(a.age_s >= 14 * 60 - 2 && a.age_s < 14 * 60 + 30); assert.ok(a.as_of);
    write(30 * 60); const b = await S2.getJitoTips(); assert.ok(b.age_s >= 30 * 60 - 2, 'a 30-minute-old sample is served with its age (the old 12-minute limit would have refused every answer on a 15-minute cron)');
    write(46 * 60); await assert.rejects(S2.getJitoTips(), (e) => e.status === 503 && /Not charged/.test(e.message) && /limit 2700s/.test(e.message) && /old/.test(e.message));
    process.env.JITO_MAX_AGE_S = '7200'; write(90 * 60); assert.ok((await S2.getJitoTips()).age_s >= 5400 - 2);
    fs.unlinkSync(file); delete process.env.JITO_MAX_AGE_S;
    await assert.rejects(S2.getJitoTips(), (e) => e.status === 503 && /not built yet/.test(e.message));
  } finally { delete process.env.JITO_TIPS_FILE; delete process.env.JITO_MAX_AGE_S; }
});

// ---------------------------------------------------------------- end to end: the real server.js, x402 in front, Helius out of credits
test('R20 end to end: with the primary at 429 a PAID Solana route answers from the fallback; with every endpoint down the same kind of call is a 503 and the facilitator is never asked to settle; rpc_usage lines count the calls', async () => {
  const H = require('./helpers/real-server');
  let mode = 'up';
  const primary = await serve(refuse(429));
  const fb = await serve((j) => (mode === 'up' ? fakeChain()(j) : { status: 429, body: { error: 'down' } }));
  const s = await H.boot({ SOLANA_RPC_URL: `${primary.url}/?api-key=${KEY}`, RPC_FALLBACKS: fb.url, SOLRPC_USAGE_EVERY_MS: '700' });
  try {
    const paidGet = async (p) => {
      const ch = await H.raw(s.port, 'GET', p, { 'cf-connecting-ip': '198.51.100.7' });
      assert.equal(ch.status, 402, `${p}: the challenge`);
      return H.raw(s.port, 'GET', p, { 'cf-connecting-ip': '198.51.100.7', 'payment-signature': H.b64(H.payBase(ch.headers['payment-required'])) });
    };
    s.fac.log.length = 0;
    const good = await paidGet('/api/priority-fees');
    assert.equal(good.status, 200, good.body.slice(0, 200));
    assert.equal(JSON.parse(good.body).data.slots, 4, 'answered from the fallback chain');
    assert.equal(s.fac.log.filter((x) => x.op === 'settle').length, 1, 'a served call settles');
    mode = 'down'; s.fac.log.length = 0;
    const bad = await paidGet('/api/sol-network');
    assert.equal(bad.status, 503, bad.body.slice(0, 200));
    assert.match(bad.body, /Not charged|rpc/i);
    assert.equal(s.fac.log.filter((x) => x.op === 'settle').length, 0, 'an outage never settles');
    assert.ok(!bad.body.includes(KEY) && !s.out().includes(KEY), 'the key reaches neither a response nor the log');
    await new Promise((r) => setTimeout(r, 1500));
    const lines = s.out().split('\n').filter((l) => /rpc_usage/.test(l));
    assert.ok(lines.length >= 1, 'the server prints rpc_usage lines');
    const all = lines.map((l) => JSON.parse(l.slice(l.indexOf('{')))); const total = all.reduce((n, o) => n + o.total, 0);
    assert.ok(all.some((o) => o.getRecentPrioritizationFees >= 1) && total >= 3, JSON.stringify(all));
  } finally { s.close(); primary.close(); fb.close(); }
});

// ---------------------------------------------------------------- the shared helper is ONE file in four repos
test('R20 helper pin: lib/rpc-failover.cjs is byte-identical to the copies in seeker-rpc, deepwork-backend and stakestreak-backend (each repo\'s test pins this sha256)', () => {
  const sha = crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, '..', 'lib', 'rpc-failover.cjs'))).digest('hex');
  assert.equal(sha, 'd5fc1443848c865c9215a7ec2ccdccd0b7350836570cee2c55739baec5ac7666', 'if you changed the helper, change it in all four places and update the four pins');
});

test('R20 docs: the jito route says every 15 minutes wherever it says how often (expansion text, README row, collector header), and nothing says 5 minutes for it any more', () => {
  const root = path.join(__dirname, '..');
  const exp = fs.readFileSync(path.join(root, 'expansion.js'), 'utf8'); const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8'); const cron = fs.readFileSync(path.join(root, 'bin', 'jito-tips-collect.js'), 'utf8');
  const row = readme.split('\n').find((l) => l.startsWith('| `get_jito_tips`') && l.includes('Jito tips sampled on-chain')); const ed = exp.split('\n').find((l) => /desc: 'Jito tips sampled on-chain/.test(l));
  assert.ok(row && ed, 'control: both lines found');
  for (const l of [row, ed]) { assert.match(l, /refreshed every 15 minutes/); assert.doesNotMatch(l, /every 5 minutes/); }
  assert.match(cron, /^\/\/   \*\/15 \* \* \* \* cd \/opt\/agentfeed/m); assert.doesNotMatch(cron, /^\/\/   \*\/5 \* \* \* \*/m);
  assert.match(readme, /\| `RPC_FALLBACKS` \| `https:\/\/api\.mainnet-beta\.solana\.com` \|/, 'the README documents RPC_FALLBACKS');
  assert.match(cron, /Number\(process\.env\.JITO_GAP_MS\) : 1100;/, 'one call every 1.1 s: the public RPC answers about 10 getTransaction per 10 s per address (measured 24 Oct 2026), the 340 ms of the Helius days drew 429 on half the reads');
  assert.match(cron, /\/usr\/bin\/timeout 180 /, 'the cron line allows a run of about 100 s');
});

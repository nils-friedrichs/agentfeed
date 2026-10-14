// test/batch-claim.test.js — ops/batch-claim.js (R8, 13 Oct 2026): claim, then settle from the chain's own view of what is
// claimed-but-unsettled; amount_too_low is a recorded refusal, never a failure.
//
// The job runs as a child process with test/helpers/batch-claim-mocks.js preloaded: a scripted facilitator, a scripted chain
// read, an in-memory channel store and a recorded fetch (Telegram). Offline, no key, no DB.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { isBelowMinimum, isNothingToSettle, nextNetworkState } = require('../lib/batch-claim-core');

const ROOT = path.join(__dirname, '..');
const MOCKS = path.join(__dirname, 'helpers', 'batch-claim-mocks.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'af-bc-'));
const CH = (charged, claimed, id = '0xchan') => ({ channelId: id, chargedCumulativeAmount: String(charged), totalClaimed: String(claimed) });
const HOURS_AGO = (h) => new Date(Date.now() - h * 3600e3).toISOString();

function run(name, scenario, { runs = 1, args = [], seed = null } = {}) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  const f = { log: path.join(dir, 'claims.jsonl'), state: path.join(dir, 'state.json'), fetch: path.join(dir, 'fetch.jsonl'), trace: path.join(dir, 'trace.jsonl'), tg: path.join(dir, 'tg.env') };
  fs.writeFileSync(f.tg, 'TG_BOT_TOKEN=test-token\nTG_ALERT_CHAT=test-chat\n');
  if (seed) fs.writeFileSync(f.state, JSON.stringify(seed));
  let out = '';
  for (let i = 0; i < runs; i++) {
    const r = spawnSync(process.execPath, ['-r', MOCKS, path.join(ROOT, 'ops', 'batch-claim.js'), ...args], {
      cwd: ROOT, encoding: 'utf8', timeout: 30000,
      env: { ...process.env, BC_SCENARIO: JSON.stringify(scenario), BC_FETCH_LOG: f.fetch, BC_TRACE: f.trace, BATCH_CLAIM_LOG: f.log, BATCH_CLAIM_STATE: f.state,
        BATCH_CLAIM_ENV_TG: f.tg, BATCH_CLAIM_POLL_MS: '1', BATCH_CLAIM_RETRY_MS: '1', AGENTFEED_DB: path.join(dir, 'none.db') },
    });
    assert.equal(r.status, 0, `run ${i + 1} exited ${r.status}: ${r.stderr}`);
    out += r.stdout;
  }
  const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  return {
    out,
    log: read(f.log),
    state: fs.existsSync(f.state) ? JSON.parse(fs.readFileSync(f.state, 'utf8')) : null,
    telegram: read(f.fetch),
    trace: read(f.trace),
    net: () => JSON.parse(fs.readFileSync(f.state, 'utf8')).networks['eip155:8453'],
  };
}

// ---- the pure parts ----------------------------------------------------------------------------
test('isBelowMinimum: the SettleError reason, the bare message, and nothing else', () => {
  assert.equal(isBelowMinimum({ errorReason: 'amount_too_low' }), true);
  assert.equal(isBelowMinimum(Object.assign(new Error('amount_too_low'), { name: 'SettleError' })), true);
  assert.equal(isBelowMinimum(new Error('amount_too_low: below the facilitator minimum')), true);
  assert.equal(isBelowMinimum(new Error('Claim failed: amount_too_low_but_wrapped')), false); // prefix match only
  assert.equal(isBelowMinimum(new Error('Facilitator settle failed (500): boom')), false);
  assert.equal(isBelowMinimum({ errorReason: 'invalid_batch_settlement_evm_nothing_to_settle' }), false);
  assert.equal(isBelowMinimum(null), false);
});

test('isNothingToSettle: the spec error by reason or message, nothing else', () => {
  assert.equal(isNothingToSettle({ errorReason: 'invalid_batch_settlement_evm_nothing_to_settle' }), true);
  assert.equal(isNothingToSettle(new Error('invalid_batch_settlement_evm_nothing_to_settle')), true);
  assert.equal(isNothingToSettle({ errorReason: 'amount_too_low' }), false);
  assert.equal(isNothingToSettle(null), false);
});

test('nextNetworkState: refusals only ratchet up, the accepted minimum only down, the clock starts and stops with the value', () => {
  const t1 = '2026-10-13T06:00:00.000Z', t2 = '2026-10-13T06:30:00.000Z', t3 = '2026-10-13T07:00:00.000Z';
  let s = nextNetworkState(undefined, { unclaimed: 0n, unsettled: 2500n, settleRefused: 2500n }, t1);
  assert.deepEqual([s.unsettled_atomic, s.unsettled_since, s.settle_refused_atomic, s.settle_accepted_min_atomic], [2500, t1, 2500, null]);
  assert.deepEqual([s.at_risk_count, s.at_risk_owed_atomic, s.at_risk_initiated_at], [0, 0, null]);
  const r = nextNetworkState(undefined, { unclaimed: 900n, unsettled: 0n, atRisk: [{ owed: 500n, initiatedAt: 1760400100 }, { owed: 400n, initiatedAt: 1760400000 }] }, t1);
  assert.deepEqual([r.at_risk_count, r.at_risk_owed_atomic, r.at_risk_initiated_at], [2, 900, 1760400000]);
  s = nextNetworkState(s, { unclaimed: 0n, unsettled: 3000n, settleRefused: 1000n }, t2); // a smaller refusal does not lower the ratchet
  assert.deepEqual([s.unsettled_since, s.settle_refused_atomic], [t1, 2500]);              // the clock keeps its start while value stays
  s = nextNetworkState(s, { unclaimed: 0n, unsettled: 0n, settledOk: 3000n }, t3);
  assert.deepEqual([s.unsettled_atomic, s.unsettled_since, s.settle_accepted_min_atomic], [0, null, 3000]);
  s = nextNetworkState(s, { unclaimed: 0n, unsettled: 0n, settledOk: 500n }, t3);
  assert.equal(s.settle_accepted_min_atomic, 500);                                          // the bracket narrows from above
  s = nextNetworkState(s, { unclaimed: 500n, unsettled: null }, t3);                         // an unreadable chain keeps what was known
  assert.deepEqual([s.unsettled_atomic, s.unclaimed_atomic, s.unclaimed_since], [0, 500, t3]);
  // claims: the refusal carries its time, a later quiet run keeps both, and the accepted minimum only ever goes down
  let c = nextNetworkState(undefined, { unclaimed: 500n, unsettled: 0n, claimRefused: 500n }, t1);
  assert.deepEqual([c.claim_refused_atomic, c.claim_refused_at, c.claim_accepted_min_atomic], [500, t1, null]);
  c = nextNetworkState(c, { unclaimed: 500n, unsettled: 0n }, t2);
  assert.deepEqual([c.claim_refused_atomic, c.claim_refused_at], [500, t1]);
  c = nextNetworkState(c, { unclaimed: 0n, unsettled: 0n, claimAccepted: 2000n }, t2);
  c = nextNetworkState(c, { unclaimed: 0n, unsettled: 0n, claimAccepted: 1000n }, t3);
  c = nextNetworkState(c, { unclaimed: 0n, unsettled: 0n, claimAccepted: 1500n }, t3);
  assert.deepEqual([c.claim_refused_atomic, c.claim_accepted_min_atomic], [500, 1000]);
  // a refused batch renews the clock and records its total for the job's own gating, but leaves the per-channel refusal alone
  c = nextNetworkState(c, { unclaimed: 1200n, unsettled: 0n, claimBatchRefused: 1200n }, t3);
  assert.deepEqual([c.claim_refused_atomic, c.claim_batch_refused_atomic, c.claim_refused_at], [500, 1200, t3]);
});

// ---- the job ------------------------------------------------------------------------------------
test('claim lands, the chain shows it on the second look, settle succeeds: both logged, nothing owed', () => {
  const r = run('happy', { channels: [CH(2500, 0)], chain: ['0', '0', '2500', '0'], settle: ['ok'] });
  assert.match(r.out, /claimed 1 vouchers in 1 tx/);
  assert.match(r.out, /settled 0\.0025 USDC to the receiver, tx 0xsettle/);
  assert.deepEqual(r.log.map((l) => l.kind), ['claim', 'settle']);
  const n = r.net();
  assert.deepEqual([n.unclaimed_atomic, n.unsettled_atomic, n.unsettled_since, n.settle_accepted_min_atomic], [0, 0, null, 2500]);
  assert.equal(r.state.failures, 0);
  assert.equal(r.telegram.length, 0);
  assert.equal(r.trace.filter((t) => t.call === 'withdrawal-read').length, 0, 'nothing is unclaimed, so no withdrawal is looked for');
});

test('the 13 Oct race: a settle refused right after the claim is retried and goes through, with no refusal on record', () => {
  const r = run('race', { channels: [CH(2500, 0)], chain: ['0', '2500', '0'], settle: ['too_low', 'ok'] });
  assert.deepEqual(r.log.map((l) => l.kind), ['claim', 'settle']);
  assert.equal(r.trace.filter((t) => t.call === 'settle').length, 2);
  assert.equal(r.net().settle_refused_atomic, 0);
  assert.equal(r.state.failures, 0);
});

test('a settle still refused after the retries is recorded as a refusal, the value stays owed, and no failure counts', () => {
  const r = run('stuck', { channels: [CH(2500, 0)], chain: ['0', '2500'], settle: ['too_low'] });
  assert.deepEqual(r.log.map((l) => l.kind), ['claim', 'below_minimum']);
  assert.equal(r.log[1].step, 'settle');
  assert.equal(r.log[1].unsettled_usdc, 0.0025);
  assert.equal(r.trace.filter((t) => t.call === 'settle').length, 4); // first try + 3 retries
  const n = r.net();
  assert.deepEqual([n.unsettled_atomic, n.settle_refused_atomic, n.settle_accepted_min_atomic], [2500, 2500, null]);
  assert.ok(n.unsettled_since);
  assert.equal(r.state.failures, 0);
  assert.equal(r.telegram.length, 0);
});

test('a bucket left from an earlier run does not hide the wait for the new claim: settle goes out once the chain shows the sum', () => {
  const r = run('carry-plus', { channels: [CH(2500, 0)], chain: ['1000', '1000', '3500', '0'], settle: ['ok'] });
  assert.deepEqual(r.log.map((l) => l.kind), ['claim', 'settle']);
  assert.equal(r.log[1].unsettled_usdc, 0.0035, 'settled the bucket plus the new claim, not the stale 1000');
  assert.equal(r.net().unsettled_atomic, 0);
});

test('nothing left to settle (already swept by anyone) is recorded as such, not as a failure', () => {
  const r = run('nothing', { channels: [CH(2500, 2500)], chain: ['2500', '0'], settle: ['nothing'] }, { runs: 3 });
  assert.deepEqual(r.log.map((l) => l.kind), ['nothing_to_settle', 'nothing_to_settle', 'nothing_to_settle']);
  assert.equal(r.state.failures, 0);
  assert.equal(r.net().unsettled_atomic, 0);
  assert.equal(r.telegram.length, 0);
});

test('a claimed bucket left from an earlier run is settled on the next run even though no voucher is claimable', () => {
  const r = run('carry', { channels: [CH(2500, 2500)], chain: ['2500'], settle: ['ok'] });
  assert.equal(r.trace.filter((t) => t.call === 'claim').length, 0);
  assert.deepEqual(r.log.map((l) => l.kind), ['settle']);
  assert.match(r.out, /settled 0\.0025 USDC/);
});

test('a refusal with no claim just before it is not retried within the run, and ratchets the record', () => {
  const r = run('norace', { channels: [CH(2500, 2500)], chain: ['2500'], settle: ['too_low'] });
  assert.equal(r.trace.filter((t) => t.call === 'settle').length, 1);
  assert.deepEqual(r.log.map((l) => [l.kind, l.step]), [['below_minimum', 'settle']]);
  assert.equal(r.net().settle_refused_atomic, 2500);
  assert.equal(r.state.failures, 0);
});

test('a claim refused as below the minimum is recorded once and not asked for again inside the re-probe window: no failure, no alert', () => {
  const r = run('claim-low', { channels: [CH(500, 0)], claim: { mode: 'too_low' }, chain: ['0'] }, { runs: 3 });
  assert.equal(r.trace.filter((t) => t.call === 'claim').length, 1, 'three runs, one question to the facilitator');
  assert.equal(r.log.length, 1);
  assert.deepEqual([r.log[0].kind, r.log[0].step, r.log[0].owed_usdc, r.log[0].channels], ['below_minimum', 'claim', 0.0005, 1]);
  const n = r.net();
  assert.deepEqual([n.unclaimed_atomic, n.claim_refused_atomic], [500, 500]);
  assert.ok(n.claim_refused_at);
  assert.equal(r.state.failures, 0);
  assert.equal(r.telegram.length, 0, 'three runs with a refused residual must not alert');
});

test('after the re-probe window the refused amount is asked for again (the minimum may have moved); inside it, it is not', () => {
  const seed = (h) => ({ failures: 0, networks: { 'eip155:8453': { claim_refused_atomic: 500, claim_refused_at: HOURS_AGO(h), unclaimed_atomic: 500, unclaimed_since: HOURS_AGO(h) } } });
  const fresh = run('probe-fresh', { channels: [CH(500, 0)], claim: { mode: 'too_low' }, chain: ['0'] }, { seed: seed(1) });
  assert.equal(fresh.trace.filter((t) => t.call === 'claim').length, 0, 'refused an hour ago: not asked');
  const old = run('probe-old', { channels: [CH(500, 0)], claim: { mode: 'too_low' }, chain: ['0'] }, { seed: seed(7) });
  assert.equal(old.trace.filter((t) => t.call === 'claim').length, 1, 'refused seven hours ago: asked again');
  assert.ok(Date.now() - Date.parse(old.net().claim_refused_at) < 60e3, 'and the record is renewed');
  const lowered = run('probe-lowered', { channels: [CH(500, 0)], claim: { mode: 'ok' }, chain: ['0', '0', '500'], settle: ['ok'] }, { seed: seed(7) });
  assert.deepEqual(lowered.log.map((l) => l.kind), ['claim', 'settle'], 'if CDP lowered its minimum the claim now goes through');
  const grown = run('probe-grown', { channels: [CH(1000, 0)], claim: { mode: 'ok' }, chain: ['0', '1000'], settle: ['ok'] }, { seed: seed(1) });
  assert.deepEqual(grown.log.map((l) => l.kind), ['claim', 'settle'], 'owed above the refusal is asked for at once');
});

test('batch whose total passes CDP: two small channels are claimed together, nothing is recorded as refused', () => {
  const r = run('multi-total', { channels: [CH(500, 0, '0xa'), CH(500, 0, '0xb')], claim: { rule: 'total', min: 1000 }, chain: ['0', '1000', '0'], settle: ['ok'] });
  assert.deepEqual(r.log.map((l) => l.kind), ['claim', 'settle']);
  assert.equal(r.trace.filter((t) => t.call === 'claim').length, 1);
  assert.equal(r.net().claim_refused_atomic, 0);
  assert.equal(r.net().claim_accepted_min_atomic, null, 'a two-channel batch says nothing about one channel');
});

test('a dust channel cannot hold the others hostage: a refused batch is retried channel by channel, and only single answers are recorded', () => {
  const sc = { channels: [CH(500, 0, '0xdust'), CH(2000, 0, '0xgood')], claim: { rule: 'entry', min: 1000 }, chain: ['0', '2000', '0'], settle: ['ok'] };
  const r = run('multi-entry', sc);
  assert.deepEqual(r.trace.filter((t) => t.call === 'claim').map((c) => c.ids.join('+')), ['0xdust+0xgood', '0xgood', '0xdust'], 'the batch in storage order, then the larger channel alone, then the dust alone');
  assert.deepEqual(r.log.map((l) => [l.kind, l.scope || '', l.channels, l.owed_usdc]), [['below_minimum', 'batch', 2, 0.0025], ['claim', '', undefined, undefined], ['below_minimum', '', 1, 0.0005], ['settle', '', undefined, undefined]]);
  const n = r.net();
  assert.deepEqual([n.claim_refused_atomic, n.claim_accepted_min_atomic, n.claim_batch_refused_atomic, n.unclaimed_atomic], [500, 2000, 2500, 500], 'refused 500 (the dust alone), not 2500 (the batch)');
  assert.equal(r.state.failures, 0);
  assert.equal(r.telegram.length, 0);
  // the next run finds only the dust left, and the record says CDP refused that much: it asks nothing
  const next = run('multi-entry-next', { channels: [CH(500, 0, '0xdust')], claim: { rule: 'entry', min: 1000 }, chain: ['0'] }, { seed: r.state });
  assert.equal(next.trace.filter((t) => t.call === 'claim').length, 0);
  assert.equal(next.net().unclaimed_atomic, 500);
});

test('two dust channels under a per-entry minimum: asked once (batch, then each), then left alone until the total grows', () => {
  const sc = { channels: [CH(500, 0, '0xa'), CH(500, 0, '0xb')], claim: { rule: 'entry', min: 1000 }, chain: ['0'] };
  const r = run('multi-dust', sc, { runs: 3 });
  assert.equal(r.trace.filter((t) => t.call === 'claim').length, 3, 'run 1: the batch and the two singles; runs 2 and 3: nothing');
  const n = r.net();
  assert.deepEqual([n.claim_refused_atomic, n.claim_batch_refused_atomic, n.unclaimed_atomic], [500, 1000, 1000], 'the watchdog sees 500 per channel, not the 1000 total');
  const grown = run('multi-dust-grown', { channels: [CH(500, 0, '0xa'), CH(500, 0, '0xb'), CH(500, 0, '0xc')], claim: { rule: 'entry', min: 1000 }, chain: ['0'] },
    { seed: { failures: 0, networks: { 'eip155:8453': { claim_refused_atomic: 500, claim_batch_refused_atomic: 1000, claim_refused_at: HOURS_AGO(1) } } } });
  assert.equal(grown.trace.filter((t) => t.call === 'claim').length, 4, 'a third dust channel makes the total 1500 > 1000: asked again');
});

test('several refused channels record the largest single refusal, never the batch total (which would silence real unclaimed value)', () => {
  const r = run('multi-masking', { channels: [CH(500, 0, '0xa'), CH(700, 0, '0xb')], claim: { rule: 'entry', min: 1000 }, chain: ['0'] });
  assert.equal(r.net().claim_refused_atomic, 700);
  assert.equal(r.net().unclaimed_atomic, 1200);
  assert.equal(r.state.failures, 0);
});

test('a failure inside the one-by-one retry counts, stops the retry and leaves the refusal record alone', () => {
  const r = run('multi-fail', { channels: [CH(500, 0, '0xa'), CH(700, 0, '0xb')], claim: { rule: 'entry', min: 1000, failIds: ['0xb'] }, chain: ['0'] });
  assert.deepEqual(r.trace.filter((t) => t.call === 'claim').map((c) => c.ids.join('+')), ['0xa+0xb', '0xb'], 'the batch, then the larger channel alone, which fails: the other is not tried');
  assert.equal(r.state.failures, 1);
  assert.equal(r.net().claim_refused_atomic, 0);
  assert.ok(r.log.some((l) => l.kind === 'error' && l.step === 'claim'));
});

test('unclaimed value CDP will not take, plus a payer withdrawal pending on-chain, is accepted exposure: no read, no risk, no alert', () => {
  const r = run('withdraw-below', { channels: [CH(500, 0)], claim: { mode: 'too_low' }, chain: ['0'], withdraw: { amount: '4500', initiatedAt: 1760400000 } });
  assert.equal(r.trace.filter((t) => t.call === 'withdrawal-read').length, 0, 'owing no more than the refusal, so nobody looks');
  assert.deepEqual([r.net().at_risk_count, r.net().at_risk_owed_atomic], [0, 0]);
  assert.deepEqual(r.log.map((l) => l.kind), ['below_minimum']);
});

test('unclaimed value ABOVE the refusal (the claim failed for another reason) plus a pending withdrawal is logged and left in the record for the watchdog', () => {
  const r = run('withdraw', { channels: [CH(1500, 0)], claim: { mode: 'error' }, chain: ['0'], withdraw: { amount: '3500', initiatedAt: 1760400000 } });
  assert.deepEqual(r.log.map((l) => l.kind), ['error', 'withdrawal_pending']);
  assert.deepEqual([r.log[1].channels, r.log[1].owed_usdc, r.log[1].first_initiated_at], [1, 0.0015, 1760400000]);
  const n = r.net();
  assert.deepEqual([n.at_risk_count, n.at_risk_owed_atomic, n.at_risk_initiated_at], [1, 1500, 1760400000]);
  assert.equal(r.state.failures, 1);
});

test('no withdrawal pending, or an unreadable chain, records no risk', () => {
  const a = run('withdraw-none', { channels: [CH(1500, 0)], claim: { mode: 'error' }, chain: ['0'] });
  assert.equal(a.trace.filter((t) => t.call === 'withdrawal-read').length, 1);
  assert.deepEqual([a.net().at_risk_count, a.net().at_risk_owed_atomic, a.net().at_risk_initiated_at], [0, 0, null]);
  const b = run('withdraw-rpc', { channels: [CH(1500, 0)], claim: { mode: 'error' }, chain: ['0'], withdraw: 'ERR' });
  assert.equal(b.net().at_risk_count, 0);
});

test('a claim that fails for any other reason counts: the second failed run in a row sends one Telegram alert', () => {
  const r = run('claim-error', { channels: [CH(500, 0)], claim: { mode: 'error' }, chain: ['0'] }, { runs: 3 });
  assert.equal(r.state.failures, 3);
  assert.equal(r.state.alerted, true);
  assert.equal(r.telegram.length, 1, 'one alert, not one per run');
  assert.ok(r.log.every((l) => l.kind === 'error' && l.step === 'claim'));
});

test('an unreadable chain does not invent a settle or a failure; the record keeps what it knew', () => {
  const r = run('rpc-down', { channels: [CH(2500, 2500)], chain: ['ERR'], settle: ['ok'] });
  assert.equal(r.trace.filter((t) => t.call === 'settle').length, 0);
  assert.equal(r.net().unsettled_atomic, null);
  assert.equal(r.state.failures, 0);
});

test('--dry reports the unclaimed and claimed-but-unsettled amounts and writes nothing', () => {
  const r = run('dry', { channels: [CH(2500, 0)], chain: ['1500'] }, { args: ['--dry'] });
  assert.match(r.out, /Base: 1 claimable channel\(s\), unclaimed 0\.0025 USDC, claimed-but-unsettled 0\.0015 USDC/);
  assert.equal(r.state, null);
  assert.equal(r.log.length, 0);
  assert.equal(r.trace.filter((t) => t.call === 'claim' || t.call === 'settle').length, 0);
});

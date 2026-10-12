'use strict';
// R5 Phase B products with no network: the SSRF guard, robots.txt matching, and the SEC, HIP-3
// and ECB parsers against stubbed upstream answers. Each test loads its module fresh so caches
// from one test cannot answer the next.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const fresh = (rel) => { const p = require.resolve(path.join('..', rel)); delete require.cache[p]; return require(p); };
function stubFetch(t, routes) {
  const real = global.fetch; const seen = [];
  global.fetch = async (url, init = {}) => {
    seen.push({ url: String(url), init });
    for (const [re, fn] of routes) if (re.test(String(url))) return fn(String(url), init);
    throw new Error(`unstubbed fetch ${url}`);
  };
  t.after(() => { global.fetch = real; });
  return seen;
}
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
const text = (s, status = 200) => new Response(s, { status });

test('safe-fetch: private, loopback, metadata and IPv6-embedded IPv4 are refused; public addresses pass', () => {
  const { checkUrl, isPrivate } = fresh('lib/safe-fetch.js');
  const refused = ['http://127.0.0.1/', 'http://10.0.0.1/', 'http://169.254.169.254/latest/meta-data/', 'http://100.64.0.1/', 'http://[::1]/',
    'http://[::ffff:127.0.0.1]/', 'http://[::ffff:169.254.169.254]/', 'http://[::127.0.0.1]/', 'http://[64:ff9b::7f00:1]/', 'http://[2002:7f00:1::]/',
    'http://[fd00:ec2::254]/', 'http://[fe80::1]/', 'http://2130706433/', 'http://0x7f.1/', 'http://localhost/', 'http://box.internal/',
    'ftp://example.com/', 'file:///etc/passwd', 'http://example.com:8080/', 'http://user:pw@example.com/', 'not a url'];
  for (const u of refused) assert.throws(() => checkUrl(u), (e) => e.kind === 'bad_request', `refused: ${u}`);
  for (const u of ['https://en.wikipedia.org/wiki/Stablecoin', 'http://1.1.1.1/', 'http://[2606:4700::1111]/', 'http://[::ffff:8.8.8.8]/', 'https://example.com:443/x'])
    assert.doesNotThrow(() => checkUrl(u), `allowed: ${u}`);
  // the form dns.lookup hands the socket guard
  assert.equal(isPrivate('::ffff:127.0.0.1'), true);
  assert.equal(isPrivate('2a01:4f8::1'), false);
  assert.equal(isPrivate('not-an-ip'), true, 'unparseable is refused');
});

test('robots.txt: our own group wins over *, longest rule wins, a one-letter agent is not ours', () => {
  const { _robotsAllows: allows } = fresh('tools/webmd.js');
  assert.equal(allows('', '/a'), true, 'no robots.txt: allowed');
  assert.equal(allows('User-agent: *\nDisallow: /', '/a'), false);
  assert.equal(allows('User-agent: *\nDisallow: /\n\nUser-agent: AgentFeed\nAllow: /', '/a'), true, 'our group overrides *');
  assert.equal(allows('User-agent: *\nDisallow: /private\nAllow: /private/ok', '/private/ok/page'), true, 'longest match wins');
  assert.equal(allows('User-agent: *\nDisallow: /*.pdf$', '/doc.pdf'), false, 'wildcard and end anchor');
  assert.equal(allows('User-agent: *\nDisallow: /*.pdf$', '/doc.pdf?x=1'), true);
  assert.equal(allows('User-agent: a\nDisallow: /\n\nUser-agent: *\nAllow: /', '/x'), true, 'agent "a" is not AgentFeed');
  assert.equal(allows('User-agent: *\nDisallow:', '/x'), true, 'empty Disallow allows all');
});

const TICKERS = { 0: { cik_str: 320193, ticker: 'AAPL', title: 'Apple Inc.' }, 1: { cik_str: 1045810, ticker: 'NVDA', title: 'NVIDIA CORP' } };
const today = new Date().toISOString().slice(0, 10);
const SUBS = (forms) => ({ name: 'NVIDIA CORP', sic: '3674', sicDescription: 'Semiconductors', filings: { recent: {
  form: forms, filingDate: forms.map(() => today), reportDate: forms.map(() => today), accessionNumber: forms.map((_, i) => `0001045810-26-00000${i}`),
  primaryDocument: forms.map((f) => (f === '4' ? 'xslF345X05/wk-form4.xml' : 'doc.htm')), primaryDocDescription: forms.map(() => 'desc'), items: forms.map((f) => (f === '8-K' ? '2.02,9.01' : '')) } } });
const FORM4 = `<?xml version="1.0"?><ownershipDocument>
<reportingOwner><reportingOwnerId><rptOwnerName>Huang Jen Hsun</rptOwnerName></reportingOwnerId>
<reportingOwnerRelationship><isDirector>1</isDirector><isOfficer>1</isOfficer><officerTitle>President and CEO</officerTitle></reportingOwnerRelationship></reportingOwner>
<nonDerivativeTable>
<nonDerivativeTransaction><securityTitle><value>Common Stock</value></securityTitle><transactionDate><value>${today}</value></transactionDate>
<transactionCoding><transactionCode>S</transactionCode></transactionCoding><transactionAmounts><transactionShares><value>1000</value></transactionShares>
<transactionPricePerShare><value>180.5</value></transactionPricePerShare><transactionAcquiredDisposedCode><value>D</value></transactionAcquiredDisposedCode></transactionAmounts>
<postTransactionAmounts><sharesOwnedFollowingTransaction><value>5000</value></sharesOwnedFollowingTransaction></postTransactionAmounts></nonDerivativeTransaction>
<nonDerivativeTransaction><securityTitle><value>Common Stock</value></securityTitle><transactionDate><value>${today}</value></transactionDate>
<transactionCoding><transactionCode>P</transactionCode></transactionCoding><transactionAmounts><transactionShares><value>10</value></transactionShares>
<transactionPricePerShare><value>100</value></transactionPricePerShare><transactionAcquiredDisposedCode><value>A</value></transactionAcquiredDisposedCode></transactionAmounts>
<postTransactionAmounts><sharesOwnedFollowingTransaction><value>5010</value></sharesOwnedFollowingTransaction></postTransactionAmounts></nonDerivativeTransaction>
</nonDerivativeTable></ownershipDocument>`;

test('sec: filings by form, a typo form is 400, the ticker map 503s when EDGAR is down; declared User-Agent', async (t) => {
  const S = fresh('tools/sec.js');
  const seen = stubFetch(t, [[/company_tickers/, () => json(TICKERS)], [/submissions\/CIK0001045810/, () => json(SUBS(['10-Q', '8-K', '4', 'SD']))]]);
  const r = await S.getSecFilings({ ticker: 'nvda', form: '8-k' });
  assert.equal(r.cik, '0001045810');
  assert.equal(r.count, 1);
  assert.match(r.filings[0].index_url, /\/1045810\/000104581026000001\/0001045810-26-000001-index\.htm$/);
  assert.equal((await S.getSecFilings({ ticker: 'NVDA', form: 'S-1' })).count, 0, 'a common form with no filing is a real answer');
  assert.equal((await S.getSecFilings({ ticker: 'NVDA', form: 'SD' })).count, 1, 'an uncommon form the company did file');
  await assert.rejects(S.getSecFilings({ ticker: 'NVDA', form: 'NOPE' }), (e) => e.kind === 'bad_request');
  await assert.rejects(S.getSecFilings({ ticker: 'ZZZZZ' }), (e) => e.kind === 'bad_request' && /unknown ticker/.test(e.message));
  await assert.rejects(S.getSecFilings({ ticker: 'NVDA', limit: 0 }), (e) => e.kind === 'bad_request');
  assert.ok(seen.every((s) => s.init.headers['user-agent'] === 'AgentFeed ochinimus@gmail.com'), 'every EDGAR call declares the UA');
  const S2 = fresh('tools/sec.js');
  stubFetch(t, [[/company_tickers/, () => text('busy', 503)]]);
  await assert.rejects(S2.getSecFilings({ ticker: 'NVDA' }), (e) => e.status === 503);
});

test('sec: Form 4 parsed into rows with codes, value and buy/sale totals; the xsl prefix is stripped', async (t) => {
  const S = fresh('tools/sec.js');
  const seen = stubFetch(t, [[/company_tickers/, () => json(TICKERS)], [/submissions\/CIK0001045810/, () => json(SUBS(['4', '10-Q']))], [/wk-form4\.xml$/, () => text(FORM4)]]);
  const r = await S.getInsiderTrades({ ticker: 'NVDA', days: 7 });
  assert.ok(seen.some((s) => /\/000104581026000000\/wk-form4\.xml$/.test(s.url)), 'raw XML, not the xsl-rendered page');
  assert.equal(r.form4_filings, 1);
  assert.equal(r.transactions, 2);
  const sale = r.trades.find((x) => x.code === 'S');
  assert.equal(sale.insider, 'Huang Jen Hsun');
  assert.equal(sale.role, 'director, President and CEO');
  assert.equal(sale.code_meaning, 'open-market sale');
  assert.equal(sale.value_usd, 180500);
  assert.equal(sale.acquired_or_disposed, 'disposed');
  assert.equal(r.open_market_sales_usd, 180500);
  assert.equal(r.open_market_buys_usd, 1000);
  await assert.rejects(S.getInsiderTrades({ ticker: 'NVDA', days: 181 }), (e) => e.kind === 'bad_request');
});

test('sec: market-wide 8-K from the Atom feed, deduplicated by accession, items counted, window bounds', async (t) => {
  const S = fresh('tools/sec.js');
  const now = new Date().toISOString();
  const old = new Date(Date.now() - 30 * 3600e3).toISOString();
  const entry = (who, cik, role, acc, at, items) => `<entry><title>8-K - ${who} (${cik}) (${role})</title><link href="https://www.sec.gov/Archives/edgar/data/${Number(cik)}/x-index.htm"/>
<summary type="html">&lt;b&gt;Filed:&lt;/b&gt; x ${items.map((i) => `&lt;br&gt;Item ${i}: Title ${i}`).join('')}</summary><updated>${at}</updated><id>urn:tag:sec.gov,2008:accession-number=${acc}</id></entry>`;
  const feed = `<feed>${entry('ACME CORP', '0000000001', 'Filer', '0000000001-26-000001', now, ['5.02', '9.01'])}${entry('ACME SUB', '0000000002', 'Subject', '0000000001-26-000001', now, ['5.02', '9.01'])}${entry('OLD INC', '0000000003', 'Filer', '0000000003-26-000001', old, ['2.02'])}</feed>`;
  stubFetch(t, [[/getcurrent/, (u) => text(/start=0&/.test(u) ? feed : '<feed></feed>')]]);
  const r = await S.getSec8k({ hours: 24 });
  assert.equal(r.count, 1, 'filer and subject rows of one accession are one filing; the 30 h old one is outside');
  assert.equal(r.filings[0].company, 'ACME CORP');
  assert.deepEqual(r.item_counts, { '5.02': 1, '9.01': 1 });
  assert.equal(r.window_complete, true);
  assert.equal((await S.getSec8k({ hours: 72 })).count, 2);
  await assert.rejects(S.getSec8k({ hours: 0 }), (e) => e.kind === 'bad_request');
});

function hlStub(t, { failMeta = false } = {}) {
  return stubFetch(t, [[/hyperliquid/, (u, init) => {
    const b = JSON.parse(init.body);
    if (b.type === 'perpDexs') return json([null, { name: 'xyz', fullName: 'XYZ', deployer: '0xabc' }, { name: 'flx', fullName: 'Felix' }]);
    if (failMeta) return text('down', 500);
    if (b.dex === 'xyz') return json([{ universe: [{ name: 'xyz:TSLA', maxLeverage: 10 }, { name: 'xyz:GOLD' }, { name: 'xyz:DEAD', isDelisted: true }] },
      [{ markPx: '250', oraclePx: '249', prevDayPx: '240', premium: '0.001', funding: '0.0000125', openInterest: '1000', dayNtlVlm: '5000000' },
        { markPx: '2400', oraclePx: '2401', prevDayPx: '2400', premium: '-0.0001', funding: '0', openInterest: '10', dayNtlVlm: '1' }, { markPx: '1' }]]);
    return json([{ universe: [{ name: 'flx:TSLA' }] }, [{ markPx: '251', oraclePx: '249', prevDayPx: '250', funding: '0.00001', openInterest: '10' }]]);
  }]]);
}

test('hip3: markets from every dex, delisted dropped, symbol lookup across dexes by OI, bad and unknown symbols are 400', async (t) => {
  const H = fresh('tools/hip3.js');
  hlStub(t);
  const list = await H.getTradfiPerps({});
  assert.equal(list.count, 3);
  assert.match(list.prices_are, /HIP-3 oracle and mark/);
  const tsla = await H.getTradfiPerps({ symbol: 'tsla' });
  assert.deepEqual(tsla.markets.map((m) => m.market), ['xyz:TSLA', 'flx:TSLA'], 'sorted by open interest');
  const x = tsla.markets[0];
  assert.equal(x.open_interest_usd, 250000);
  assert.equal(x.change_24h_pct, 4.167);
  assert.equal(x.funding_8h_pct, 0.01);
  assert.equal(x.premium_pct, 0.1);
  assert.equal((await H.getTradfiPerps({ symbol: 'flx:TSLA' })).count, 1);
  await assert.rejects(H.getTradfiPerps({ symbol: 'ZZZZ' }), (e) => e.kind === 'bad_request');
  await assert.rejects(H.getTradfiPerps({ symbol: 'not a symbol!' }), (e) => e.kind === 'bad_request');
});

test('hip3: no markets from upstream is 503 (never billed)', async (t) => {
  const H = fresh('tools/hip3.js');
  hlStub(t, { failMeta: true });
  await assert.rejects(H.getTradfiPerps({}), (e) => e.status === 503);
});

const ECB_CSV = (date) => ['KEY,FREQ,CURRENCY,CURRENCY_DENOM,EXR_TYPE,EXR_SUFFIX,TIME_PERIOD,OBS_VALUE',
  `EXR.D.USD.EUR.SP00.A,D,USD,EUR,SP00,A,${date},1.25`, `EXR.D.JPY.EUR.SP00.A,D,JPY,EUR,SP00,A,${date},160`,
  'EXR.D.RUB.EUR.SP00.A,D,RUB,EUR,SP00,A,2022-03-01,117.29', 'EXR.D.BGN.EUR.SP00.A,D,BGN,EUR,SP00,A,2025-12-31,1.9558'].join('\n');

test('fx: ECB rates as published, discontinued series dropped, crosses labelled, notice in every response', async (t) => {
  const F = fresh('tools/fxrates.js');
  fresh('tools/hip3.js');
  stubFetch(t, [[/ecb\.europa\.eu/, () => text(ECB_CSV(today))], [/hyperliquid/, () => text('x', 500)]]);
  const e = await F.getFxRates({});
  assert.deepEqual(e.rates, { USD: 1.25, JPY: 160 }, 'RUB (2022) and BGN (2025) are not today\'s rates');
  assert.match(e.notice, /free of charge on the ECB's website/);
  assert.match(e.rates_are, /as published/);
  const u = await F.getFxRates({ base: 'usd' });
  assert.deepEqual(u.rates, { EUR: 0.8, JPY: 128 });
  assert.match(u.rates_are, /crosses computed by us/);
  assert.match(u.notice, /free of charge/);
  await assert.rejects(F.getFxRates({ base: 'RUB' }), (x) => x.kind === 'bad_request');
  await assert.rejects(F.getFxRates({ base: 'XX' }), (x) => x.kind === 'bad_request');
});

test('fx: a stale ECB date and an unreachable ECB are 503', async (t) => {
  const F = fresh('tools/fxrates.js');
  stubFetch(t, [[/ecb\.europa\.eu/, () => text(ECB_CSV('2026-01-02'))], [/hyperliquid/, () => text('x', 500)]]);
  await assert.rejects(F.getFxRates({}), (x) => x.status === 503 && /stale/.test(x.message));
  const F2 = fresh('tools/fxrates.js');
  stubFetch(t, [[/ecb\.europa\.eu/, () => text('down', 502)], [/hyperliquid/, () => text('x', 500)]]);
  await assert.rejects(F2.getFxRates({}), (x) => x.status === 503);
});

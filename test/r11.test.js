// test/r11.test.js — R11 Phase A: sanctions, email, domain, papers, wiki, utilities. No network: every upstream is stubbed.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r11-'));
process.env.SANCTIONS_FILE = path.join(dir, 'sanctions.json');
process.env.DISPOSABLE_FILE = path.join(dir, 'disposable.txt');

const S = require('../tools/sanctions');
const E = require('../tools/emailverify');
const D = require('../tools/domain');
const P = require('../tools/papers');
const W = require('../tools/wiki');
const U = require('../tools/utils');
const isBad = (e) => e.kind === 'bad_request';
const is503 = (e) => e.status === 503;

// ---------- sanctions ----------
const SDN = (n) => `<?xml version="1.0"?>
<sdnList>
  <publshInformation>
    <Publish_Date>10/09/2026</Publish_Date>
    <Record_Count>${n}</Record_Count>
  </publshInformation>
  <sdnEntry>
    <uid>4632</uid>
    <lastName>CENTRAL &amp; BANK</lastName>
    <sdnType>Entity</sdnType>
    <programList>
      <program>IRAN</program>
      <program>SDGT</program>
    </programList>
    <idList>
      <id>
        <uid>1</uid>
        <idType>Additional Sanctions Information -</idType>
        <idNumber>Subject to Secondary Sanctions</idNumber>
      </id>
      <id>
        <uid>2</uid>
        <idType>Digital Currency Address - TRX</idType>
        <idNumber>TNiq9AXBp9EjUqhDhrwrfvAA8U3GUQZH81</idNumber>
      </id>
      <id>
        <uid>3</uid>
        <idType>Digital Currency Address - ETH</idType>
        <idNumber>0xAbCdEf0123456789aBcDeF0123456789abcdef01</idNumber>
      </id>
    </idList>
    <akaList><aka><uid>9</uid></aka></akaList>
  </sdnEntry>
  <sdnEntry>
    <uid>55</uid>
    <firstName>Jane</firstName>
    <lastName>Doe</lastName>
    <sdnType>Individual</sdnType>
  </sdnEntry>
</sdnList>`;
const lines = (s) => (async function* () { for (const l of s.split('\n')) yield l; })();

test('sanctions: the SDN parser reads addresses, names, programs, the entry uid (not the id uid) and decodes entities', async () => {
  const r = await S.parseSdn(lines(SDN(19000)));
  assert.equal(r.published, '10/09/2026'); assert.equal(r.records, 19000);
  assert.equal(r.entries.length, 2);
  assert.deepEqual(r.entries.map((e) => [e.ticker, e.uid, e.name, e.programs.join('+')]), [['TRX', 4632, 'CENTRAL & BANK', 'IRAN+SDGT'], ['ETH', 4632, 'CENTRAL & BANK', 'IRAN+SDGT']]);
  assert.equal(r.entries[1].addr, '0xabcdef0123456789abcdef0123456789abcdef01', 'EVM addresses are stored lower-case');
});

test('sanctions: address normal form and family', () => {
  assert.equal(S.normalize('0xABCDEF0123456789ABCDEF0123456789ABCDEF01'), '0xabcdef0123456789abcdef0123456789abcdef01');
  assert.equal(S.normalize('BC1QXY2KGDYGJRSQTZQ2N0YRF2493P83KKFJHX0WLH'), 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh');
  assert.equal(S.normalize('TNiq9AXBp9EjUqhDhrwrfvAA8U3GUQZH81'), 'TNiq9AXBp9EjUqhDhrwrfvAA8U3GUQZH81', 'base58 is case-sensitive and kept as typed');
  assert.equal(S.family('TNiq9AXBp9EjUqhDhrwrfvAA8U3GUQZH81'), 'tron');
  assert.equal(S.family('0xabcdef0123456789abcdef0123456789abcdef01'), 'evm');
  assert.equal(S.family('1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2'), 'bitcoin-base58');
  assert.equal(S.family('So11111111111111111111111111111111111111112'), 'solana-or-other-base58');
});

test('sanctions: refresh builds the file, the route matches, and every failure mode answers correctly', async () => {
  fs.rmSync(process.env.SANCTIONS_FILE, { force: true });
  assert.throws(() => S.sanctionsCheck({ address: 'TNiq9AXBp9EjUqhDhrwrfvAA8U3GUQZH81' }), is503, 'no copy yet -> 503');
  // a file with too few records or addresses must not become the copy
  await assert.rejects(S.refresh({ fetchImpl: async (u, d) => fs.writeFileSync(d, SDN(50)) }), /implausible/);
  assert.ok(!fs.existsSync(process.env.SANCTIONS_FILE), 'an implausible download leaves no copy');
  // 301 addresses is the smallest accepted size: build one
  const many = Array.from({ length: 310 }, (_, i) => `<sdnEntry>\n<uid>${1000 + i}</uid>\n<lastName>X${i}</lastName>\n<sdnType>Entity</sdnType>\n<idList>\n<id>\n<uid>1</uid>\n<idType>Digital Currency Address - XBT</idType>\n<idNumber>1Addr${String(i).padStart(28, '0')}</idNumber>\n</id>\n</idList>\n</sdnEntry>`).join('\n');
  const BIG = SDN(19000).replace('</sdnList>', `${many}\n</sdnList>`);
  const now = Date.now();
  const r = await S.refresh({ fetchImpl: async (u, d) => fs.writeFileSync(d, BIG), now });
  assert.equal(r.ok, true); assert.equal(r.addresses, 312);
  const hit = S.sanctionsCheck({ address: 'TNiq9AXBp9EjUqhDhrwrfvAA8U3GUQZH81' }, { now });
  assert.equal(hit.match, true); assert.equal(hit.lists[0].entry_name, 'CENTRAL & BANK'); assert.equal(hit.lists[0].program, 'IRAN, SDGT'); assert.equal(hit.lists[0].published, '2026-10-09');
  assert.equal(hit.checked_lists[0].version_date, '2026-10-09');
  assert.equal(S.sanctionsCheck({ address: '0xABCDEF0123456789abcdef0123456789ABCDEF01' }, { now }).match, true, 'EVM match ignores case');
  assert.equal(S.sanctionsCheck({ address: 'tniq9axbp9ejuqhdhrwrfvaa8u3gugzh81' }, { now }).match, false, 'a base58 address with the wrong case is a different string');
  assert.equal(S.sanctionsCheck({ address: 'So11111111111111111111111111111111111111112' }, { now }).match, false);
  assert.throws(() => S.sanctionsCheck({}), isBad); assert.throws(() => S.sanctionsCheck({ address: 'abc' }), isBad); assert.throws(() => S.sanctionsCheck({ address: 'x'.repeat(200) }), isBad);
  assert.throws(() => S.sanctionsCheck({ address: 'TNiq9AXBp9EjUqhDhrwrfvAA8U3GUQZH81' }, { now: now + 49 * 3600e3 }), is503, 'copy older than 48 h -> 503');
  assert.doesNotThrow(() => S.sanctionsCheck({ address: 'TNiq9AXBp9EjUqhDhrwrfvAA8U3GUQZH81' }, { now: now + 47 * 3600e3 }));
  // a later, smaller download must not replace the good copy
  const small = SDN(19000).replace('</sdnList>', `${many.split('</sdnEntry>').slice(0, 40).join('</sdnEntry>')}</sdnEntry>\n</sdnList>`);
  await assert.rejects(S.refresh({ fetchImpl: async (u, d) => fs.writeFileSync(d, small) }), /implausible|refusing/);
  assert.equal(JSON.parse(fs.readFileSync(process.env.SANCTIONS_FILE, 'utf8')).entries.length, 312, 'the last good copy survived');
});

test('sanctions: the download follows the Treasury redirect to its signed S3 link, and nothing else', async () => {
  const { EventEmitter } = require('events'); const { Readable } = require('stream');
  const scripted = (steps) => { const seen = []; const get = (u, o, cb) => { seen.push(String(u)); const step = steps.shift(); const req = new EventEmitter(); req.destroy = () => {}; setImmediate(() => { const res = Readable.from([Buffer.from(step.body || '')]); res.statusCode = step.status; res.headers = step.location ? { location: step.location } : {}; cb(res); }); return req; }; return { get, seen }; };
  const f = process.env.SANCTIONS_FILE; fs.rmSync(f, { force: true });
  const body = SDN(19000).replace('</sdnList>', Array.from({ length: 310 }, (_, i) => `<sdnEntry>\n<uid>${i}</uid>\n<lastName>Y${i}</lastName>\n<sdnType>Entity</sdnType>\n<idList>\n<id>\n<uid>1</uid>\n<idType>Digital Currency Address - XBT</idType>\n<idNumber>1Redir${String(i).padStart(28, '0')}</idNumber>\n</id>\n</idList>\n</sdnEntry>`).join('\n') + '\n</sdnList>');
  let s1 = scripted([{ status: 302, location: 'https://bucket.s3.us-gov-west-1.amazonaws.com/Published/SDN.XML?X-Amz=1' }, { status: 200, body }]);
  assert.equal((await S.refresh({ get: s1.get })).ok, true); assert.equal(s1.seen.length, 2); assert.match(s1.seen[1], /amazonaws\.com/);
  await assert.rejects(S.refresh({ get: scripted([{ status: 302, location: 'https://evil.example.com/sdn.xml' }]).get }), /refusing redirect to evil\.example\.com/);
  await assert.rejects(S.refresh({ get: scripted([{ status: 302, location: 'http://x.s3.amazonaws.com/a' }]).get }), /refusing redirect/);
  await assert.rejects(S.refresh({ get: scripted([{ status: 302, location: 'https://a.treas.gov/1' }, { status: 302, location: 'https://a.treas.gov/2' }, { status: 302, location: 'https://a.treas.gov/3' }, { status: 302, location: 'https://a.treas.gov/4' }]).get }), /too many redirects/);
  await assert.rejects(S.refresh({ get: scripted([{ status: 500 }]).get }), /HTTP 500/);
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).entries.length, 312, 'a refused or failed download leaves the last good copy');
});

// ---------- email ----------
fs.writeFileSync(process.env.DISPOSABLE_FILE, Array.from({ length: 1200 }, (_, i) => `junk${i}.example`).concat(['mailinator.com', 'tempmail.dev']).join('\n'));
const MX = (kind) => ({
  mx: async () => { if (kind === 'mx') return [{ exchange: 'mx2.x.com', priority: 20 }, { exchange: 'mx1.x.com', priority: 10 }]; if (kind === 'null') return [{ exchange: '', priority: 0 }]; const e = new Error('x'); e.code = kind === 'servfail' ? 'ESERVFAIL' : 'ENODATA'; throw e; },
  a: async () => { if (kind === 'implicit') return ['192.0.2.1']; const e = new Error('x'); e.code = 'ENOTFOUND'; throw e; },
  aaaa: async () => { const e = new Error('x'); e.code = 'ENODATA'; throw e; },
});
test('email: verdicts from syntax, MX, disposable, role and free-provider checks', async () => {
  const v = async (email, kind = 'mx') => E.emailVerify({ email }, { resolvers: MX(kind) });
  let r = await v('sergiu@369modus.xyz'); assert.equal(r.verdict, 'deliverable_likely'); assert.deepEqual(r.checks.mx.records.map((m) => m.priority), [10, 20], 'MX sorted by priority');
  r = await v('x@mailinator.com'); assert.equal(r.verdict, 'risky'); assert.ok(r.reasons.includes('disposable_provider'));
  r = await v('x@sub.mailinator.com'); assert.ok(r.reasons.includes('disposable_provider'), 'a subdomain of a listed domain is listed');
  r = await v('x@notmailinator.com'); assert.ok(!r.reasons.includes('disposable_provider'), 'a longer name is not a parent match');
  r = await v('Admin+news@corp.com'); assert.equal(r.verdict, 'risky'); assert.ok(r.reasons.includes('role_account'));
  r = await v('me@gmail.com'); assert.equal(r.verdict, 'deliverable_likely'); assert.ok(r.reasons.includes('free_provider'));
  r = await v('a@nomail.test.com', 'none'); assert.equal(r.verdict, 'undeliverable'); assert.ok(r.reasons.includes('no_mail_route'));
  r = await v('a@nullmx.com', 'null'); assert.equal(r.verdict, 'undeliverable'); assert.ok(r.reasons.includes('domain_accepts_no_mail'));
  r = await v('a@implicit.com', 'implicit'); assert.equal(r.verdict, 'deliverable_likely'); assert.ok(r.reasons.includes('no_mx_record_uses_address_record'));
  await assert.rejects(v('a@dnsdown.com', 'servfail'), is503);
  for (const bad of ['plain', 'a@b', '@x.com', 'a b@x.com', 'a..b@x.com', '.a@x.com', 'a@-x.com', 'a@x_y.com', `${'a'.repeat(65)}@x.com`, 'a@x.123']) { r = await v(bad); assert.equal(r.verdict, 'undeliverable', bad); assert.deepEqual(r.reasons, ['invalid_syntax'], bad); }
  assert.equal(r.smtp_probe, false);
  await assert.rejects(E.emailVerify({}), isBad); await assert.rejects(E.emailVerify({ email: 'a@' + 'b'.repeat(260) + '.com' }), isBad);
  assert.equal((await v('ü@bücher.de')).checks.syntax.valid, false, 'a non-ASCII local part is refused');
  assert.equal((await v('a@bücher.de')).email, 'a@xn--bcher-kva.de', 'IDN domains are converted to punycode');
});
test('email: a missing or stale disposable list is a 503, never a verdict that skipped the check', async () => {
  const f = process.env.DISPOSABLE_FILE; const keep = fs.readFileSync(f);
  fs.rmSync(f); await assert.rejects(E.emailVerify({ email: 'a@x.com' }, { resolvers: MX('mx') }), is503);
  fs.writeFileSync(f, keep); const old = new Date(Date.now() - 22 * 86400e3); fs.utimesSync(f, old, old);
  await assert.rejects(E.emailVerify({ email: 'a@x.com' }, { resolvers: MX('mx') }), is503);
  const fresh = new Date(); fs.utimesSync(f, fresh, fresh);
  assert.equal((await E.emailVerify({ email: 'a@x.com' }, { resolvers: MX('mx') })).verdict, 'deliverable_likely');
  await assert.rejects(E.refreshDisposable({ fetchImpl: async () => 'only\nfive\ndomains\n' }), /implausible/);
  const n = (await E.refreshDisposable({ fetchImpl: async () => Array.from({ length: 12000 }, (_, i) => `d${i}.test`).join('\n') })).domains; assert.equal(n, 12000);
  await assert.rejects(E.refreshDisposable({ fetchImpl: async () => Array.from({ length: 5200 }, (_, i) => `d${i}.test`).join('\n') }), /refusing to replace 12000/);
  assert.equal(fs.readFileSync(f, 'utf8').split('\n').length, 12000, 'the larger copy was kept');
});

// ---------- domain ----------
test('domain: input rules', () => {
  assert.equal(D.parseDomain('Example.COM.'), 'example.com'); assert.equal(D.parseDomain('bücher.de'), 'xn--bcher-kva.de');
  for (const b of ['', 'localhost', '127.0.0.1', '10.0.0.1', '::1', 'a', 'foo.internal', 'x.local', 'a b.com', '-a.com', `${'a'.repeat(64)}.com`, `${'a.'.repeat(130)}com`, 'http://x.com']) assert.throws(() => D.parseDomain(b), isBad, b);
});
test('domain: RDAP parsing and the answer, with every upstream stubbed', async () => {
  const rd = D.parseRdap({ ldhName: 'EXAMPLE.COM', status: ['client transfer prohibited'], events: [{ eventAction: 'registration', eventDate: '2020-01-01T00:00:00Z' }, { eventAction: 'expiration', eventDate: '2027-01-01T00:00:00Z' }], entities: [{ roles: ['registrar'], vcardArray: ['vcard', [['version', {}, 'text', '4.0'], ['fn', {}, 'text', 'Reg Inc']]] }], nameservers: [{ ldhName: 'NS1.EXAMPLE.COM' }] });
  assert.deepEqual([rd.registrar, rd.registered, rd.expires, rd.nameservers[0]], ['Reg Inc', '2020-01-01T00:00:00Z', '2027-01-01T00:00:00Z', 'ns1.example.com']);
  const fetchImpl = async (u) => {
    if (u.includes('data.iana.org')) return new Response(JSON.stringify({ services: [[['com'], ['https://rdap.test/com/v1/']], [['org'], ['https://r.test/']], [['net'], ['https://r.test/']]] }));
    if (u.endsWith('/domain/sub.example.com')) return new Response('{}', { status: 404 });
    if (u.endsWith('/domain/example.com')) return new Response(JSON.stringify({ ldhName: 'EXAMPLE.COM', status: ['ok'], events: [] }));
    return new Response('{}', { status: 404 });
  };
  const resolvers = { A: async () => ['192.0.2.1'], AAAA: async () => { const e = new Error('x'); e.code = 'ENODATA'; throw e; }, MX: async () => [{ exchange: 'm.example.com', priority: 5 }], NS: async () => ['ns1.example.com'], TXT: async () => [['v=spf1 ', 'a -all']] };
  const connect = (opts, cb) => { const { EventEmitter } = require('events'); const s = new EventEmitter(); s.destroy = () => {}; s.authorized = true; s.getProtocol = () => 'TLSv1.3';
    s.getPeerCertificate = () => ({ valid_from: 'Oct 1 00:00:00 2026 GMT', valid_to: 'Jan 1 00:00:00 2027 GMT', subject: { CN: 'sub.example.com' }, issuer: { O: 'Test CA', CN: 'T1' }, subjectaltname: 'DNS:sub.example.com, DNS:*.example.com, IP Address:1.2.3.4', fingerprint256: 'AA' });
    setImmediate(cb); return s; };
  const r = await D.getDomain({ domain: 'sub.example.com' }, { fetchImpl, resolvers, connect, now: Date.parse('2026-10-13T00:00:00Z') });
  assert.equal(r.rdap.queried, 'example.com', 'a subdomain climbs to the registrable name');
  assert.deepEqual(r.dns.TXT, ['v=spf1 a -all'], 'TXT chunks are joined');
  assert.deepEqual([r.tls.issuer_org, r.tls.days_remaining, r.tls.sans], ['Test CA', 80, ['sub.example.com', '*.example.com']], 'only DNS SANs are listed');
  assert.equal(r.resolves, true);
});
test('domain: RDAP is cached for 24 h per domain and capped per minute, and the rest of the answer survives the cap', async () => {
  D._rdapCache.clear();
  let rdapCalls = 0;
  const fetchImpl = async (u) => { if (u.includes('iana')) return new Response(JSON.stringify({ services: [[['com'], ['https://rdap.test/']]] })); rdapCalls++; return new Response(JSON.stringify({ ldhName: 'X.COM', status: [], events: [] })); };
  const resolvers = { A: async () => ['192.0.2.1'], AAAA: async () => [], MX: async () => [], NS: async () => [], TXT: async () => [] };
  const connect = () => { throw new Error('no tls in this test'); };
  const deps = (now) => ({ fetchImpl, resolvers, connect, now });
  const t0 = Date.now() + 10 * 60e3; // a minute window no other test has used
  await D.getDomain({ domain: 'cached.com' }, deps(t0)); const again = await D.getDomain({ domain: 'cached.com' }, deps(t0 + 5000));
  assert.equal(rdapCalls, 1); assert.equal(again.rdap.cached, true);
  for (let i = 0; i < D.RDAP_PER_MIN + 2; i++) await D.getDomain({ domain: `d${i}.com` }, deps(t0 + 6000));
  const capped = await D.getDomain({ domain: 'overflow.com' }, deps(t0 + 6000));
  assert.match(capped.rdap.error, /allowance/); assert.equal(capped.resolves, true, 'DNS still answers');
  assert.ok(rdapCalls <= D.RDAP_PER_MIN + 1, `only ${D.RDAP_PER_MIN} queries per minute reached the registry (saw ${rdapCalls})`);
  const later = await D.getDomain({ domain: 'overflow.com' }, deps(t0 + 6000 + 61e3)); assert.equal(later.rdap.error, undefined, 'the next minute has allowance again');
});

test('domain: no address record means no handshake; every network section failing is a 503', async () => {
  const none = async () => { const e = new Error('x'); e.code = 'ENOTFOUND'; throw e; };
  const r = await D.getDomain({ domain: 'gone.example.org' }, { resolvers: { A: none, AAAA: none, MX: none, NS: none, TXT: none }, fetchImpl: async (u) => new Response('{}', { status: 404 }) });
  assert.equal(r.resolves, false); assert.match(r.tls.error, /not attempted/); assert.match(r.rdap.error, /404/);
  const boom = async () => { const e = new Error('x'); e.code = 'ESERVFAIL'; throw e; };
  await assert.rejects(D.getDomain({ domain: 'down.example.net' }, { resolvers: { A: boom, AAAA: boom, MX: boom, NS: boom, TXT: boom }, fetchImpl: async () => { throw new Error('offline'); } }), is503);
});
test('domain: the TLS lookup refuses names that resolve to private or metadata addresses', async () => {
  const dns = require('dns'); const real = dns.lookup;
  const via = (addrs) => { dns.lookup = (h, o, cb) => cb(null, addrs); return new Promise((res) => D._guardedLookup('x.test', { all: true }, (err, a) => res({ err, a }))); };
  try {
    for (const bad of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '192.168.0.1', '::1', 'fd00:ec2::254', '::ffff:7f00:1']) assert.equal((await via([{ address: bad, family: bad.includes(':') ? 6 : 4 }])).err.code, 'EPRIVATE', bad);
    assert.equal((await via([{ address: '1.1.1.1', family: 4 }, { address: '10.0.0.1', family: 4 }])).err.code, 'EPRIVATE', 'one private address among public ones still refuses');
    assert.equal((await via([{ address: '93.184.216.34', family: 4 }])).err, null);
  } finally { dns.lookup = real; }
});

// ---------- papers ----------
const OA = { id: 'https://openalex.org/W1', doi: 'https://doi.org/10.1000/abc', title: 'T', publication_year: 2024, type: 'article', authorships: [{ author: { display_name: 'A One' } }, { author: { display_name: 'B Two' } }], primary_location: { source: { display_name: 'Journal X' } }, cited_by_count: 7, open_access: { is_oa: true, oa_url: 'https://oa.example/x.pdf' }, abstract_inverted_index: { Hello: [0], big: [1], world: [2, 3] }, language: 'en' };
test('papers: abstract reconstruction, DOI forms, search and lookup shape', async () => {
  assert.equal(P.abstractOf({ Hello: [0], big: [1], world: [2, 3] }), 'Hello big world world'); assert.equal(P.abstractOf(null), null);
  assert.equal(P.normDoi('https://doi.org/10.1038/S43586-024-00294-7'), '10.1038/s43586-024-00294-7'); assert.equal(P.normDoi('doi:10.1000/AbC'), '10.1000/abc');
  for (const b of ['', 'abc', '10.1000/', 'http://x.com/10.1000/a']) assert.throws(() => P.normDoi(b), isBad, b);
  P._cache.clear();
  const calls = [];
  const fetchImpl = async (u) => { calls.push(u); return new Response(JSON.stringify(u.includes('/works/doi:') ? OA : { meta: { count: 123 }, results: [OA] })); };
  const s = await P.searchPapers({ q: 'graph nets', year_from: 2020, limit: 5 }, { fetchImpl, key: undefined || '' });
  assert.equal(s.total_matches, 123); assert.deepEqual(s.papers[0].authors, ['A One', 'B Two']); assert.equal(s.papers[0].doi, '10.1000/abc'); assert.equal(s.papers[0].abstract, undefined, 'search results carry no abstract');
  assert.match(calls[0], /per-page=5/); assert.match(calls[0], /from_publication_date:2020-01-01/); assert.ok(!/api_key/.test(calls[0]), 'no key configured -> none sent'); assert.ok(!/mailto/.test(calls[0]), 'no contact address is sent');
  const again = await P.searchPapers({ q: 'Graph Nets', year_from: 2020, limit: 5 }, { fetchImpl }); assert.equal(again.cached, true); assert.equal(calls.length, 1, 'second identical search is served from the 24 h cache');
  const keyed = await P.searchPapers({ q: 'other', limit: 1 }, { fetchImpl, key: 'k e/y' }); assert.match(calls[1], /api_key=k%20e%2Fy/, 'a configured key is sent, encoded'); assert.equal(keyed.papers.length, 1);
  const one = await P.getPaper({ doi: '10.1000/ABC' }, { fetchImpl }); assert.match(calls[2], /\/works\/doi:10\.1000\/abc\?/); assert.equal(one.abstract, 'Hello big world world'); assert.equal(one.license, 'CC0 (OpenAlex data is public domain)');
});
test('papers: input errors are 400, upstream trouble is 503 with Retry-After, an unknown DOI is 400', async () => {
  P._cache.clear();
  await assert.rejects(P.searchPapers({}), isBad); await assert.rejects(P.searchPapers({ q: 'x'.repeat(201) }), isBad);
  await assert.rejects(P.searchPapers({ q: 'a', limit: 26 }), isBad); await assert.rejects(P.searchPapers({ q: 'a', limit: 0 }), isBad); await assert.rejects(P.searchPapers({ q: 'a', year_from: 'x' }), isBad); await assert.rejects(P.searchPapers({ q: 'a', year_from: 99 }), isBad);
  const r429 = async () => new Response('{}', { status: 429, headers: { 'x-ratelimit-reset': '1234' } });
  await assert.rejects(P.searchPapers({ q: 'quota' }, { fetchImpl: r429 }), (e) => e.status === 503 && e.retryAfter === 1234);
  await assert.rejects(P.getPaper({ doi: '10.1000/x' }, { fetchImpl: async () => new Response('{}', { status: 502 }) }), is503);
  await assert.rejects(P.getPaper({ doi: '10.1000/x' }, { fetchImpl: async () => { throw new Error('offline'); } }), is503);
  await assert.rejects(P.getPaper({ doi: '10.9999/none' }, { fetchImpl: async () => new Response('{}', { status: 404 }) }), isBad);
});

// ---------- wiki ----------
test('wiki: licence and attribution ride on every answer; bad input and a missing page are 400; Wikipedia down is 503', async () => {
  W._cache.clear();
  const calls = [];
  const fetchImpl = async (u, o) => {
    calls.push([u, o.headers['user-agent']]);
    if (u.includes('rest_v1')) return decodeURIComponent(u).includes('Nope') ? new Response('{}', { status: 404 }) : new Response(JSON.stringify({ title: 'Solana', type: 'standard', extract: 'Short.', timestamp: '2026-10-01T00:00:00Z', titles: { canonical: 'Solana' }, content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Solana' } } }));
    return new Response(JSON.stringify({ query: { pages: [{ title: 'Solana', extract: 'Lead text. '.repeat(1000) }] } }));
  };
  const r = await W.getWiki({ title: 'solana' }, { fetchImpl });
  assert.equal(r.license, 'CC BY-SA 4.0'); assert.match(r.license_url, /by-sa\/4\.0/); assert.equal(r.url, 'https://en.wikipedia.org/wiki/Solana'); assert.match(r.history_url, /action=history/); assert.match(r.attribution, /Share-alike/); assert.equal(r.lead.length, 6000);
  assert.match(calls[0][1], /^AgentFeedBot\/1\.0 \(https:\/\/x402\.ochinimus\.app/); assert.ok(!/@/.test(calls[0][1]), 'the User-Agent carries a URL, not an email address');
  assert.equal((await W.getWiki({ title: 'solana' }, { fetchImpl })).cached, true);
  const de = await W.getWiki({ title: 'Solana', lang: 'de' }, { fetchImpl }); assert.match(calls[calls.length - 1][0], /^https:\/\/de\.wikipedia\.org\//); assert.equal(de.language, 'de');
  await assert.rejects(W.getWiki({}), isBad); await assert.rejects(W.getWiki({ title: 'x'.repeat(201) }), isBad); await assert.rejects(W.getWiki({ title: 'a|b' }), isBad); await assert.rejects(W.getWiki({ title: 'ok', lang: 'evil.com/x' }), isBad); await assert.rejects(W.getWiki({ title: 'Nope' }, { fetchImpl }), isBad);
  await assert.rejects(W.getWiki({ title: 'Down' }, { fetchImpl: async () => new Response('x', { status: 503 }) }), is503);
});

// ---------- utilities ----------
test('hash: published test vectors, hex input, and caps', () => {
  assert.equal(U.hash({ alg: 'sha256', data: 'abc' }).hex, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(U.hash({ alg: 'keccak256', data: 'hello' }).hex, '1c8aff950685c2ed4bc3174f3472287b56d9517b9c948127319a09a7a36deac8');
  assert.equal(U.hash({ alg: 'keccak256', data: '' }).hex, 'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470', 'empty-string keccak is the well-known constant');
  assert.match(U.hash({ alg: 'blake2b', data: 'abc' }).hex, /^ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d1/);
  assert.equal(U.hash({ alg: 'keccak256', data: '0x68656c6c6f', as: 'hex' }).hex, U.hash({ alg: 'keccak256', data: 'hello' }).hex);
  assert.equal(U.hash({ alg: 'SHA256', data: 'abc' }).hex_0x.slice(0, 4), '0xba');
  for (const a of [{}, { alg: 'md5', data: 'x' }, { alg: 'sha256' }, { alg: 'sha256', data: 'x'.repeat(2049) }, { alg: 'sha256', data: 'zz', as: 'hex' }, { alg: 'sha256', data: 'abc', as: 'hex' }, { alg: 'sha256', data: 'x', as: 'b64' }]) assert.throws(() => U.hash(a), isBad, JSON.stringify(a).slice(0, 40));
  assert.doesNotThrow(() => U.hash({ alg: 'sha256', data: 'x'.repeat(2048) }));
  assert.throws(() => U.hash({ alg: 'sha256', data: 'é'.repeat(1025) }), isBad, 'the cap is in bytes');
});
test('time: offsets, DST, epoch forms, and refusals', () => {
  let t = U.time({ tz: 'Europe/Chisinau', at: '2026-10-13T12:00:00Z' }); assert.deepEqual([t.local, t.utc_offset_minutes, t.dst_in_effect, t.weekday], ['2026-10-13T15:00:00+03:00', 180, true, 'Tuesday']);
  t = U.time({ tz: 'Europe/Chisinau', at: '2026-12-13T12:00:00Z' }); assert.deepEqual([t.local, t.dst_in_effect], ['2026-12-13T14:00:00+02:00', false]);
  t = U.time({ tz: 'America/New_York', at: '2026-03-08T06:59:59Z' }); assert.equal(t.utc_offset, '-05:00'); t = U.time({ tz: 'America/New_York', at: '2026-03-08T07:00:00Z' }); assert.equal(t.utc_offset, '-04:00', 'the spring-forward instant');
  assert.equal(U.time({ tz: 'Asia/Kolkata', at: '0' }).local, '1970-01-01T05:30:00+05:30');
  assert.equal(U.time({ at: '1791892800' }).instant_utc, '2026-10-13T12:00:00.000Z'); assert.equal(U.time({ at: '1791892800000' }).instant_utc, '2026-10-13T12:00:00.000Z', 'seconds and milliseconds are told apart');
  assert.equal(U.time({}, { now: 1791892800000 }).defaulted_to_now, true); assert.equal(U.time({ tz: 'UTC', at: '2026-10-13T12:00:00+02:00' }).instant_utc, '2026-10-13T10:00:00.000Z');
  for (const a of [{ tz: 'Mars/Base' }, { tz: 'x'.repeat(3000) }, { at: 'tomorrow' }, { at: '2026-10-13T12:00:00' }, { at: '2026-13-45' }, { at: '99999999999999999999' }]) assert.throws(() => U.time(a), isBad, JSON.stringify(a).slice(0, 40));
});
test('convert: units, temperature, and refusals', () => {
  assert.equal(U.convert({ value: '1', from: 'mi', to: 'km' }).result, 1.609344); assert.equal(U.convert({ value: '100', from: 'C', to: 'F' }).result, 212); assert.equal(U.convert({ value: '0', from: 'K', to: 'C' }).result, -273.15);
  assert.equal(U.convert({ value: '1', from: 'GiB', to: 'MB' }).result, 1073.741824); assert.equal(U.convert({ value: '1', from: 'kWh', to: 'J' }).result, 3.6e6); assert.equal(U.convert({ value: '1', from: 'gb', to: 'mb' }).result, 1000, 'case-insensitive when unambiguous');
  assert.equal(U.convert({ value: '1', from: 'Mb', to: 'MB' }).category, 'data');
  for (const a of [{ value: '1', from: 'kg', to: 'm' }, { value: 'x', from: 'kg', to: 'g' }, { value: '1', from: 'zz', to: 'g' }, { value: '-300', from: 'C', to: 'K' }, { value: '1', from: 'C', to: 'kg' }, { value: '1e999', from: 'm', to: 'km' }, { from: 'm', to: 'km' }, { value: '1', from: 'm' }]) assert.throws(() => U.convert(a), isBad, JSON.stringify(a));
});
test('qr: a valid PNG and an SVG built from the same matrix; caps and format refusals', () => {
  const q = U.qr({ data: 'https://x402.ochinimus.app', format: 'png' });
  const png = Buffer.from(q.png_base64, 'base64');
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]); assert.equal(png.readUInt32BE(16), q.width_px); assert.equal(png[24], 1, '1-bit'); assert.equal(png[25], 0, 'grayscale');
  const idat = png.subarray(png.indexOf('IDAT') + 4, png.indexOf('IEND') - 8); const raw = zlib.inflateSync(idat); const stride = Math.ceil(q.width_px / 8);
  assert.equal(raw.length, (stride + 1) * q.width_px, 'the decompressed image has exactly the rows it declares');
  const m = U.matrixOf('https://x402.ochinimus.app');
  const finder = (r, c) => { for (let i = 0; i < 7; i++) for (let j = 0; j < 7; j++) { const ring = Math.max(Math.abs(i - 3), Math.abs(j - 3)); if (m[r + i][c + j] !== (ring !== 2)) return false; } return true; };
  assert.ok(finder(0, 0) && finder(0, m.length - 7) && finder(m.length - 7, 0), 'the three finder patterns are where the QR standard puts them');
  const svg = U.qr({ data: 'hi' }); assert.match(svg.svg, /^<svg /); assert.ok(svg.data_uri.startsWith('data:image/svg+xml;base64,'));
  assert.throws(() => U.qr({}), isBad); assert.throws(() => U.qr({ data: 'x'.repeat(2049) }), isBad); assert.throws(() => U.qr({ data: 'x', format: 'gif' }), isBad);
  assert.equal(U.qr({ data: 'x'.repeat(2048) }).modules, 169, 'a full 2 KB payload fits');
});

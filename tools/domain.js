// tools/domain.js — /api/domain/:domain (R11 A3): DNS, RDAP registration and the TLS certificate of a domain.
//
// DNS: A, AAAA, MX, NS, TXT via node:dns. RDAP: the IANA bootstrap (data.iana.org/rdap/dns.json,
// cached 24 h) names the registry's RDAP server; registrar, dates and status come from there. TLS:
// one handshake to port 443, 5 s, certificate read without trusting it. The same public-hosts-only
// rule as lib/safe-fetch.js applies to the handshake: the socket's own DNS lookup refuses a name that
// resolves to a private, loopback, link-local or metadata address, so the route cannot be aimed at the box.
'use strict';
const dns = require('dns');
const tls = require('tls');
const net = require('net');
const url = require('url');
const { isPrivate } = require('../lib/safe-fetch');

const bad = (msg) => Object.assign(new Error(msg), { kind: 'bad_request' });
const unavailable = (msg) => Object.assign(new Error(msg), { status: 503 });
const UA = 'AgentFeed/1.0 (+https://x402.ochinimus.app)';
const DNS_MS = 4000; const TLS_MS = 5000; const RDAP_MS = 6000;
const LABEL_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

function parseDomain(raw) {
  if (raw == null || String(raw).trim() === '') throw bad('missing required parameter: domain');
  let s = String(raw).trim().toLowerCase().replace(/\.$/, '');
  if (s.length > 253) throw bad('domain is longer than 253 characters');
  const ascii = url.domainToASCII(s);
  if (!ascii || net.isIP(ascii)) throw bad('domain must be a hostname such as example.com, not an IP address');
  const labels = ascii.split('.');
  if (labels.length < 2 || !labels.every((l) => LABEL_RE.test(l))) throw bad('domain is not a valid hostname');
  if (/(^|\.)(localhost|local|internal|lan|home|corp|invalid|test|example|onion)$/.test(ascii)) throw bad('local and reserved names are refused');
  return ascii;
}

const withTimeout = (p, ms, what) => new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(Object.assign(new Error(`${what} timed out`), { code: 'ETIMEOUT' })), ms);
  p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
});
const NOT_THERE = new Set(['ENOTFOUND', 'ENODATA']);
async function dnsSet(name, resolvers) {
  const r = resolvers || {};
  const one = async (key, fn) => { try { return [key, await withTimeout(fn(name), DNS_MS, key)]; } catch (e) { return [key, NOT_THERE.has(e.code) ? [] : { error: e.code || e.message }]; } };
  const out = await Promise.all([
    one('A', r.A || ((n) => dns.promises.resolve4(n))), one('AAAA', r.AAAA || ((n) => dns.promises.resolve6(n))),
    one('MX', r.MX || ((n) => dns.promises.resolveMx(n))), one('NS', r.NS || ((n) => dns.promises.resolveNs(n))),
    one('TXT', r.TXT || ((n) => dns.promises.resolveTxt(n))),
  ]);
  const res = {}; const errors = [];
  for (const [k, v] of out) {
    if (v && v.error) { errors.push(`${k}: ${v.error}`); res[k] = null; continue; }
    if (k === 'TXT') res[k] = v.map((chunks) => chunks.join('')).slice(0, 20).map((t) => t.slice(0, 300));
    else if (k === 'MX') res[k] = v.sort((a, b) => a.priority - b.priority).slice(0, 10).map((m) => ({ exchange: m.exchange, priority: m.priority }));
    else res[k] = v.slice(0, 20);
  }
  return { records: res, errors };
}

// ---- RDAP ----
// Registry RDAP terms (Verisign, PIR; read 13 Oct 2026, docs/SOURCES.md) forbid "high volume, automated, electronic processes that
// send queries" to their systems. A paid per-domain route is on-demand, but a catalogue sweeper could make it look like one, so a
// domain's RDAP record is cached for 24 h and the process sends at most RDAP_PER_MIN queries a minute across all callers;
// past that the answer carries an rdap.error and the DNS and TLS sections are still served.
const RDAP_PER_MIN = 30; const RDAP_TTL = 24 * 3600e3;
const rdapCache = new Map(); let rdapWindow = { start: 0, n: 0 };
function rdapAllowed(now) { if (now - rdapWindow.start >= 60e3) rdapWindow = { start: now, n: 0 }; if (rdapWindow.n >= RDAP_PER_MIN) return false; rdapWindow.n++; return true; }
let bootstrap = null;
async function rdapBase(tld, fetchImpl) {
  if (!bootstrap || Date.now() - bootstrap.at > 86400e3) {
    const r = await fetchImpl('https://data.iana.org/rdap/dns.json', { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(RDAP_MS) });
    if (!r.ok) throw new Error(`IANA bootstrap HTTP ${r.status}`);
    const j = await r.json();
    const map = new Map();
    for (const [tlds, urls] of j.services || []) for (const t of tlds) map.set(t.toLowerCase(), urls.find((u) => u.startsWith('https://')) || urls[0]);
    bootstrap = { at: Date.now(), map };
  }
  return bootstrap.map.get(tld) || null;
}
function vcardFn(ent) {
  const v = ent && ent.vcardArray && ent.vcardArray[1];
  const f = Array.isArray(v) && v.find((x) => x[0] === 'fn');
  return f ? f[3] : null;
}
function parseRdap(j) {
  const ev = (a) => { const e = (j.events || []).find((x) => x.eventAction === a); return e ? e.eventDate : null; };
  const registrar = (j.entities || []).find((e) => (e.roles || []).includes('registrar'));
  return {
    name: j.ldhName || null, registrar: vcardFn(registrar), registered: ev('registration'), expires: ev('expiration'), last_changed: ev('last changed'),
    status: j.status || [], nameservers: (j.nameservers || []).map((n) => String(n.ldhName || '').toLowerCase()).filter(Boolean).slice(0, 10),
  };
}
async function rdap(domain, fetchImpl, now = Date.now()) {
  const hit = rdapCache.get(domain);
  if (hit && now - hit.at < RDAP_TTL) return { ...hit.value, cached: true };
  if (!rdapAllowed(now)) return { error: 'RDAP query allowance for this minute is used (registry terms forbid high-volume automated queries); try again shortly' };
  const out = await rdapFetch(domain, fetchImpl);
  if (!out.error || /404/.test(out.error)) { rdapCache.set(domain, { at: now, value: out }); if (rdapCache.size > 2000) rdapCache.delete(rdapCache.keys().next().value); }
  return out;
}
async function rdapFetch(domain, fetchImpl) {
  const labels = domain.split('.');
  const base = await rdapBase(labels[labels.length - 1], fetchImpl);
  if (!base) return { error: 'no RDAP service for this top-level domain' };
  // a subdomain has no registration of its own: climb toward the registrable name, at most 3 tries
  for (let i = 0; i < 3 && labels.length - i >= 2; i++) {
    const name = labels.slice(i).join('.');
    const r = await fetchImpl(`${base.replace(/\/?$/, '/')}domain/${name}`, { headers: { accept: 'application/rdap+json', 'user-agent': UA }, signal: AbortSignal.timeout(RDAP_MS) });
    if (r.status === 404) continue;
    if (!r.ok) return { error: `RDAP server answered HTTP ${r.status}` };
    return { ...parseRdap(await r.json()), queried: name, source_server: base };
  }
  return { error: 'no registration found (RDAP 404): the domain may be unregistered' };
}

// ---- TLS ----
function guardedLookup(host, opts, cb) {
  dns.lookup(host, { all: true, verbatim: true }, (err, addrs) => {
    if (err) return cb(err);
    if (addrs.some((a) => isPrivate(a.address))) return cb(Object.assign(new Error(`${host} resolves to a private or reserved address`), { code: 'EPRIVATE' }));
    const pick = addrs.find((a) => a.family === 4) || addrs[0];
    if (opts && opts.all) return cb(null, [pick]);
    cb(null, pick.address, pick.family);
  });
}
function certOf(domain, { connect = tls.connect, now = Date.now() } = {}) {
  return new Promise((resolve) => {
    let done = false;
    let sock;
    const fin = (v) => { if (!done) { done = true; try { sock.destroy(); } catch { /* closed */ } resolve(v); } };
    try { sock = connect({ host: domain, port: 443, servername: domain, lookup: guardedLookup, rejectUnauthorized: false, timeout: TLS_MS }, () => {
      const c = sock.getPeerCertificate();
      if (!c || !c.valid_to) return fin({ error: 'server presented no certificate' });
      const to = Date.parse(c.valid_to); const from = Date.parse(c.valid_from);
      const san = String(c.subjectaltname || '').split(/,\s*/).filter((x) => x.startsWith('DNS:')).map((x) => x.slice(4)).slice(0, 50);
      fin({
        subject_cn: c.subject && c.subject.CN || null, issuer_org: c.issuer && c.issuer.O || null, issuer_cn: c.issuer && c.issuer.CN || null, sans: san,
        valid_from: new Date(from).toISOString(), valid_to: new Date(to).toISOString(), days_remaining: Math.floor((to - now) / 86400e3),
        trusted_by_node: sock.authorized === true, trust_error: sock.authorized ? null : String(sock.authorizationError || 'unknown'),
        protocol: sock.getProtocol(), fingerprint256: c.fingerprint256 || null,
      });
    });
    sock.on('timeout', () => fin({ error: 'TLS handshake timed out' }));
    sock.on('error', (e) => fin({ error: e.code === 'EPRIVATE' ? 'refused: resolves to a private or reserved address' : `no TLS on port 443 (${e.code || e.message})` }));
    } catch (e) { fin({ error: `TLS could not start (${e.code || e.message})` }); }
  });
}

async function getDomain(p = {}, deps = {}) {
  const domain = parseDomain(p.domain);
  const fetchImpl = deps.fetchImpl || fetch;
  const rdapP = rdap(domain, fetchImpl, deps.now || Date.now()).catch((e) => ({ error: `RDAP unreachable (${e.code || e.name || e.message})` }));
  const d = await dnsSet(domain, deps.resolvers);
  const recs = d.records;
  // no address record: a handshake can only time out, so it is not attempted
  const c = (recs.A && recs.A.length) || (recs.AAAA && recs.AAAA.length) ? await certOf(domain, deps) : { error: 'no A or AAAA record, handshake not attempted' };
  const r = await rdapP;
  const hasDns = ['A', 'AAAA', 'MX', 'NS', 'TXT'].some((k) => recs[k] && recs[k].length);
  // every section failed on the network, none on an answer: nothing was learned, so nothing is billed
  if (d.errors.length === 5 && r.error && /unreachable/.test(r.error)) throw unavailable('DNS and RDAP lookups failed from here. Not charged.');
  return {
    domain, resolves: hasDns,
    dns: { ...recs, ...(d.errors.length ? { errors: d.errors } : {}) },
    rdap: r, tls: c,
    source: 'DNS (node:dns), RDAP via the IANA bootstrap (data.iana.org/rdap), live TLS handshake on port 443',
  };
}

module.exports = { getDomain, parseDomain, parseRdap, _guardedLookup: guardedLookup, _rdapCache: rdapCache, RDAP_PER_MIN };

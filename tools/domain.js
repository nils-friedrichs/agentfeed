// tools/domain.js — /api/domain/:domain (R11 A3): DNS records and the TLS certificate of a domain.
//
// DNS: A, AAAA, MX, NS, TXT via node:dns. TLS: one handshake to port 443, 5 s, certificate read without
// trusting it. RDAP (registrar, dates, status) was dropped by the planning chat on 13 Oct 2026: Verisign's and
// PIR's terms bar automated querying and compliance cannot be promised (docs/SOURCES.md). The same
// public-hosts-only rule as lib/safe-fetch.js applies to the handshake: the socket's own DNS lookup refuses a name
// that resolves to a private, loopback, link-local or metadata address, so the route cannot be aimed at the box.
'use strict';
const dns = require('dns');
const tls = require('tls');
const net = require('net');
const url = require('url');
const { isPrivate } = require('../lib/safe-fetch');

const bad = (msg) => Object.assign(new Error(msg), { kind: 'bad_request' });
const unavailable = (msg) => Object.assign(new Error(msg), { status: 503 });
const DNS_MS = 4000; const TLS_MS = 5000;
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
  const d = await dnsSet(domain, deps.resolvers);
  const recs = d.records;
  const hasDns = ['A', 'AAAA', 'MX', 'NS', 'TXT'].some((k) => recs[k] && recs[k].length);
  // every lookup failed on the network and none on an answer: nothing was learned, so nothing is billed
  if (d.errors.length === 5) throw unavailable('DNS lookups failed from here. Not charged.');
  // no address record: a handshake can only time out, so it is not attempted
  const c = (recs.A && recs.A.length) || (recs.AAAA && recs.AAAA.length) ? await certOf(domain, deps) : { error: 'no A or AAAA record, handshake not attempted' };
  return {
    domain, resolves: hasDns,
    dns: { ...recs, ...(d.errors.length ? { errors: d.errors } : {}) },
    tls: c,
    source: 'DNS (node:dns), live TLS handshake on port 443',
  };
}

module.exports = { getDomain, parseDomain, _guardedLookup: guardedLookup };

// tools/emailverify.js — /api/email-verify (R11 A2): can this address plausibly receive mail?
//
// Checks: syntax, MX records (node:dns), disposable-provider domain, role account, free provider.
// NO SMTP probing: a RCPT TO probe from the box's IP hurts its reputation and most providers lie to
// it anyway, so the verdict is "likely", never "certain".
//
// Disposable list: github.com/disposable-email-domains/disposable-email-domains, CC0 (its README: "even
// for commercial purposes"). refreshDisposable() runs weekly from cron (node tools/emailverify.js
// --refresh); a missing list answers 503 (never billed) rather than a verdict that silently skipped a check.
'use strict';
const dns = require('dns');
const fs = require('fs');
const path = require('path');
const https = require('https');
const url = require('url');

const bad = (msg) => Object.assign(new Error(msg), { kind: 'bad_request' });
const unavailable = (msg) => Object.assign(new Error(msg), { status: 503 });
const LIST_URL = 'https://raw.githubusercontent.com/disposable-email-domains/disposable-email-domains/main/disposable_email_blocklist.conf';
const listFile = () => process.env.DISPOSABLE_FILE || path.join(__dirname, '..', 'data', 'disposable-domains.txt');
const LIST_MAX_AGE_MS = 21 * 86400e3; // weekly refresh; three weeks old is a stalled cron
const DNS_TIMEOUT_MS = 4000;

const ROLES = new Set(['admin', 'administrator', 'abuse', 'billing', 'careers', 'contact', 'enquiries', 'help', 'hello', 'hr', 'info', 'jobs', 'legal', 'mail', 'marketing', 'no-reply', 'noreply', 'donotreply', 'do-not-reply', 'office', 'postmaster', 'press', 'privacy', 'root', 'sales', 'security', 'service', 'support', 'team', 'webmaster', 'hostmaster', 'info', 'newsletter', 'orders', 'accounts', 'accounting', 'feedback', 'general', 'media', 'recruitment']);
const FREE = new Set(['gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.uk', 'yahoo.fr', 'yahoo.de', 'yahoo.co.jp', 'ymail.com', 'outlook.com', 'hotmail.com', 'hotmail.co.uk', 'hotmail.fr', 'live.com', 'msn.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com', 'proton.me', 'protonmail.com', 'pm.me', 'gmx.com', 'gmx.de', 'gmx.net', 'mail.com', 'zoho.com', 'yandex.com', 'yandex.ru', 'mail.ru', 'bk.ru', 'inbox.ru', 'list.ru', 'qq.com', '163.com', '126.com', 'sina.com', 'naver.com', 'web.de', 'fastmail.com', 'tutanota.com', 'tuta.com', 'hey.com', 'rocketmail.com']);

// ---- disposable list ----
let disp = null; // { mtimeMs, f, set, fetched }
function disposable() {
  const f = listFile();
  let st; try { st = fs.statSync(f); } catch { throw unavailable('the disposable-domain list has not been downloaded yet. Not charged.'); }
  if (Date.now() - st.mtimeMs > LIST_MAX_AGE_MS) throw unavailable('the disposable-domain list is more than 21 days old. Not charged.');
  if (disp && disp.f === f && disp.mtimeMs === st.mtimeMs) return disp;
  const set = new Set(fs.readFileSync(f, 'utf8').split(/\r?\n/).map((l) => l.trim().toLowerCase()).filter((l) => l && !l.startsWith('#')));
  if (set.size < 1000) throw unavailable('the disposable-domain list copy is unreadable. Not charged.');
  disp = { f, mtimeMs: st.mtimeMs, set, fetched: new Date(st.mtimeMs).toISOString() };
  return disp;
}
// a domain is disposable when it, or a parent of it (sub.mailinator.com), is on the list
function isDisposable(domain, set) {
  const parts = domain.split('.');
  for (let i = 0; i <= parts.length - 2; i++) if (set.has(parts.slice(i).join('.'))) return true;
  return false;
}

function refreshDisposable({ fetchImpl } = {}) {
  const f = listFile(); const tmp = `${f}.tmp`;
  const get = fetchImpl || (() => new Promise((resolve, reject) => {
    https.get(LIST_URL, { headers: { 'user-agent': 'AgentFeed/1.0 (+https://x402.ochinimus.app)' }, timeout: 30000 }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
      let b = ''; res.setEncoding('utf8'); res.on('data', (c) => { b += c; if (b.length > 5e6) res.destroy(new Error('too large')); }); res.on('end', () => resolve(b)); res.on('error', reject);
    }).on('error', reject);
  }));
  return get().then((text) => {
    const n = text.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#')).length;
    if (n < 5000) throw new Error(`implausible list: ${n} domains`);
    let prev = 0; try { prev = fs.readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean).length; } catch { /* first run */ }
    if (prev && n < prev * 0.5) throw new Error(`refusing to replace ${prev} domains with ${n}`);
    fs.writeFileSync(tmp, text); fs.renameSync(tmp, f);
    return { ok: true, domains: n };
  });
}

// ---- syntax ----
// Deliberately stricter than RFC 5322: no quoted local parts, no comments, no IP-literal domains. An
// address that needs those is not one a mailbox provider hands out.
const LOCAL_RE = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const LABEL_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
function parseAddress(raw) {
  const s = String(raw).trim();
  const at = s.lastIndexOf('@');
  if (at < 1 || at === s.length - 1) return { error: 'missing @ or empty part' };
  const local = s.slice(0, at); const dom = s.slice(at + 1);
  if (local.length > 64) return { error: 'local part over 64 characters' };
  if (!LOCAL_RE.test(local)) return { error: 'local part has characters or dots a mailbox cannot have' };
  const ascii = url.domainToASCII(dom.toLowerCase());
  if (!ascii) return { error: 'domain is not valid' };
  const labels = ascii.split('.');
  if (labels.length < 2 || !labels.every((l) => LABEL_RE.test(l)) || !/^[a-z]{2,63}$|^xn--[a-z0-9-]+$/.test(labels[labels.length - 1])) return { error: 'domain is not valid' };
  return { local, domain: ascii };
}

// ---- DNS ----
function lookup(fn, name) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(Object.assign(new Error('dns timeout'), { code: 'ETIMEOUT' })), DNS_TIMEOUT_MS);
    fn.call(dns.promises, name).then((r) => { clearTimeout(t); resolve(r); }, (e) => { clearTimeout(t); reject(e); });
  });
}
const NOT_THERE = new Set(['ENOTFOUND', 'ENODATA']);
async function mailRoute(domain, resolvers = {}) {
  const mx = resolvers.mx || ((d) => lookup(dns.promises.resolveMx, d));
  const a = resolvers.a || ((d) => lookup(dns.promises.resolve4, d));
  const aaaa = resolvers.aaaa || ((d) => lookup(dns.promises.resolve6, d));
  let records = null;
  try { records = await mx(domain); } catch (e) { if (!NOT_THERE.has(e.code)) throw unavailable(`DNS lookup failed (${e.code || e.message}). Not charged.`); }
  if (records && records.length) {
    // RFC 7505 null MX: a single record with an empty exchange says "this domain accepts no mail"
    if (records.length === 1 && (records[0].exchange === '' || records[0].exchange === '.')) return { kind: 'null_mx', records: [] };
    return { kind: 'mx', records: records.sort((x, y) => x.priority - y.priority).slice(0, 10) };
  }
  // no MX: RFC 5321 falls back to the domain's own address record
  for (const f of [a, aaaa]) {
    try { const r = await f(domain); if (r && r.length) return { kind: 'implicit_mx', records: [] }; } catch (e) { if (!NOT_THERE.has(e.code)) throw unavailable(`DNS lookup failed (${e.code || e.message}). Not charged.`); }
  }
  return { kind: 'none', records: [] };
}

async function emailVerify(p = {}, { resolvers } = {}) {
  const raw = p.email;
  if (raw == null || String(raw).trim() === '') throw bad('missing required parameter: email');
  if (String(raw).length > 254) throw bad('email is longer than 254 characters');
  const reasons = []; const checks = {};
  const parsed = parseAddress(raw);
  if (parsed.error) {
    return { email: String(raw).trim(), verdict: 'undeliverable', reasons: ['invalid_syntax'], checks: { syntax: { valid: false, detail: parsed.error } }, smtp_probe: false, source: SOURCE };
  }
  const { local, domain } = parsed;
  checks.syntax = { valid: true };
  const d = disposable();
  checks.disposable = { value: isDisposable(domain, d.set), list_fetched: d.fetched };
  const lower = local.toLowerCase().split('+')[0];
  checks.role_account = { value: ROLES.has(lower), local: lower };
  checks.free_provider = { value: FREE.has(domain) };
  const route = await mailRoute(domain, resolvers);
  checks.mx = { kind: route.kind, records: route.records.map((r) => ({ exchange: r.exchange, priority: r.priority })) };

  let verdict = 'deliverable_likely';
  if (route.kind === 'none') { verdict = 'undeliverable'; reasons.push('no_mail_route'); }
  else if (route.kind === 'null_mx') { verdict = 'undeliverable'; reasons.push('domain_accepts_no_mail'); }
  else {
    if (checks.disposable.value) { verdict = 'risky'; reasons.push('disposable_provider'); }
    if (checks.role_account.value) { verdict = 'risky'; reasons.push('role_account'); }
    if (route.kind === 'implicit_mx') reasons.push('no_mx_record_uses_address_record');
  }
  if (checks.free_provider.value) reasons.push('free_provider');
  if (!reasons.length) reasons.push('syntax_valid_and_domain_has_mx');
  return { email: `${local}@${domain}`, verdict, reasons, checks, smtp_probe: false, note: 'No SMTP probe is made, so deliverable_likely means the address is well formed and its domain accepts mail, not that the mailbox exists.', source: SOURCE };
}
const SOURCE = 'syntax and DNS (node:dns) checks; disposable-email-domains list (CC0, github.com/disposable-email-domains)';

module.exports = { emailVerify, refreshDisposable, parseAddress, isDisposable };

if (require.main === module && process.argv.includes('--refresh')) {
  refreshDisposable().then((r) => console.log(JSON.stringify(r)), (e) => { console.error(`disposable list refresh failed, last good copy kept: ${e.message}`); process.exit(1); });
}

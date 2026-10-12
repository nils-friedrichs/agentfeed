// tools/webmd.js — /api/web-markdown and /api/pdf-markdown (R5 B1).
//
// An on-request fetch of ONE caller-supplied URL, like a proxy: nothing is crawled, cached or
// mirrored, and no login or paywall is bypassed. The fetch goes through lib/safe-fetch.js
// (SSRF guard, 3 redirects, 10 s, 5 MB HTML / 10 MB PDF, content type checked) with an honest
// User-Agent, and robots.txt is honoured for it (the EU text-and-data-mining opt-out is
// machine-readable; docs/SOURCES.md). HTML goes through Mozilla Readability on a linkedom DOM,
// then turndown; a page Readability cannot isolate falls back to its whole body. PDFs are
// parsed by unpdf in a child process capped at 128 MB heap and 20 s.
// A blocked, malformed or non-HTML/PDF URL is a 400; the target failing is a 503; neither is
// billed. A page that converts is billed even when it says little.
'use strict';
const path = require('path');
const { spawn } = require('child_process');
const { safeFetch } = require('../lib/safe-fetch');

// Read on your request and not kept: the content stays its publisher's (R5 terms research, item 6).
const RIGHTS = 'fetched once from the URL you supplied, on your request, and not stored; the content belongs to its publisher and you are responsible for your use of it';
const UA = 'AgentFeed/1.0 (+https://x402.ochinimus.app; fetches one URL on a caller\'s request)';
const MAX_HTML = 5 * 1024 * 1024;
const MAX_PDF = 10 * 1024 * 1024;
const MAX_MD = 300000;
const bad = (msg) => Object.assign(new Error(msg), { kind: 'bad_request' });
const unavailable = (msg) => Object.assign(new Error(msg), { status: 503 });
const words = (s) => (String(s).match(/\S+/g) || []).length;

// ---- robots.txt, per origin, cached 1 h ----
const robots = new Map();
function robotsAllows(txt, pathname) {
  const groups = []; let cur = null;
  for (const raw of String(txt).split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim(); if (!line) continue;
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/); if (!m) continue;
    const k = m[1].toLowerCase(), v = m[2].trim();
    if (k === 'user-agent') { if (!cur || cur.rules.length) { cur = { agents: [], rules: [] }; groups.push(cur); } cur.agents.push(v.toLowerCase()); }
    else if (cur && (k === 'allow' || k === 'disallow')) cur.rules.push({ allow: k === 'allow', path: v });
  }
  const pick = groups.find((g) => g.agents.some((a) => a === 'agentfeed' || a.startsWith('agentfeed/'))) || groups.find((g) => g.agents.includes('*'));
  if (!pick) return true;
  let best = null;
  for (const r of pick.rules) {
    if (!r.path) continue;
    const re = new RegExp('^' + r.path.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$'));
    if (re.test(pathname) && (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow))) best = r;
  }
  return !best || best.allow;
}
async function checkRobots(u) {
  const origin = `${u.protocol}//${u.host}`;
  const hit = robots.get(origin);
  let txt;
  if (hit && Date.now() - hit.at < 3600e3) txt = hit.txt;
  else {
    try { txt = (await safeFetch(`${origin}/robots.txt`, { maxBytes: 200000, timeoutMs: 4000, userAgent: UA, accept: 'text/plain' })).body.toString('utf8'); } catch { txt = ''; }
    robots.set(origin, { at: Date.now(), txt });
    if (robots.size > 2000) robots.delete(robots.keys().next().value);
  }
  if (!robotsAllows(txt, u.pathname + u.search)) throw bad(`${u.host}/robots.txt disallows this path for automated fetches`);
}

function parseUrlArg(p) {
  const raw = p && p.url != null ? String(p.url).trim() : '';
  if (!raw) throw bad('missing required parameter: url (an absolute http or https URL)');
  let u; try { u = new URL(raw); } catch { throw bad('url must be an absolute http or https URL'); }
  return u;
}

async function getWebMarkdown(p = {}) {
  const u = parseUrlArg(p);
  await checkRobots(u);
  const r = await safeFetch(u.href, { maxBytes: MAX_HTML, userAgent: UA, accept: 'text/html,application/xhtml+xml', okTypes: ['text/html', 'application/xhtml+xml'] });
  const { parseHTML } = require('linkedom');
  const { Readability } = require('@mozilla/readability');
  const TurndownService = require('turndown');
  const html = r.body.toString('utf8');
  const { document } = parseHTML(html);
  let article = null;
  try { article = new Readability(document, { charThreshold: 200 }).parse(); } catch { article = null; }
  const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' });
  td.remove(['script', 'style', 'noscript', 'iframe']);
  let md = article && article.content ? td.turndown(article.content) : td.turndown((parseHTML(html).document.body || {}).innerHTML || '');
  md = md.replace(/\n{3,}/g, '\n\n').trim();
  const truncated = md.length > MAX_MD;
  return {
    title: (article && article.title) || (document.title || null), url: u.href, final_url: r.url, fetched_at: new Date().toISOString(),
    byline: (article && article.byline) || null, site_name: (article && article.siteName) || null, lang: (article && article.lang) || null,
    word_count: words(md), truncated, extraction: article ? 'readability' : 'body',
    markdown: truncated ? md.slice(0, MAX_MD) : md,
    rights: RIGHTS,
  };
}

function pdfText(buf) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--max-old-space-size=128', path.join(__dirname, '..', 'bin', 'pdf-text.mjs')], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    const t = setTimeout(() => { child.kill('SIGKILL'); reject(unavailable('PDF parsing timed out (20 s)')); }, 20000);
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    child.on('close', (code) => {
      clearTimeout(t);
      if (code !== 0) return reject(bad(`this PDF could not be parsed (${String(err).split('\n').find((l) => /Error/.test(l)) || `exit ${code}`})`.slice(0, 200)));
      try { resolve(JSON.parse(out)); } catch { reject(unavailable('PDF parser returned no result')); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(buf);
  });
}

async function getPdfMarkdown(p = {}) {
  const u = parseUrlArg(p);
  await checkRobots(u);
  const r = await safeFetch(u.href, { maxBytes: MAX_PDF, userAgent: UA, accept: 'application/pdf', okTypes: ['application/pdf', 'application/octet-stream', 'binary/octet-stream', 'application/x-pdf'] });
  if (r.body.subarray(0, 5).toString('latin1') !== '%PDF-') throw bad('the document is not a PDF (no %PDF- header)');
  const doc = await pdfText(r.body);
  const pages = (doc.text || []).map((t, i) => `## Page ${i + 1}\n\n${String(t).replace(/[ \t]+\n/g, '\n').trim()}`);
  let md = pages.join('\n\n').trim();
  const truncated = md.length > MAX_MD;
  return {
    title: doc.title || null, url: u.href, final_url: r.url, fetched_at: new Date().toISOString(),
    pages: doc.pages, bytes: r.body.length, word_count: words(md), truncated,
    markdown: truncated ? md.slice(0, MAX_MD) : md,
    rights: RIGHTS,
  };
}

module.exports = { getWebMarkdown, getPdfMarkdown, _robotsAllows: robotsAllows };

// tools/papers.js — /api/papers and /api/paper/:doi (R11 A4): scholarly works from OpenAlex.
//
// OpenAlex data is CC0 (docs.openalex.org: "all data is CC0 -- no license worries, ever"). The API,
// though, is metered, and the brief's "no key, 100,000 calls a day" is out of date (read 13 Oct 2026):
// a keyless caller gets $0.10 of usage a day and a free key $1.00. A search costs $0.001 (about 1,000 a
// day on a free key, 100 keyless), a filtered list $0.0001, and fetching one work by DOI is FREE and
// unlimited. So /api/paper/:doi works without a key at any volume; /api/papers needs OPENALEX_API_KEY
// in .env (a free account) to serve more than ~100 searches a day. A 429 from OpenAlex answers 503
// with Retry-After and is never billed. The 24 h cache below means a repeated query costs nothing.
'use strict';

const bad = (msg) => Object.assign(new Error(msg), { kind: 'bad_request' });
const unavailable = (msg, extra) => Object.assign(new Error(msg), { status: 503 }, extra || {});
const BASE = 'https://api.openalex.org';
const UA = 'AgentFeed/1.0 (+https://x402.ochinimus.app)';
const TTL = 24 * 3600e3;
const SELECT = 'id,doi,title,publication_year,publication_date,type,authorships,primary_location,cited_by_count,open_access,abstract_inverted_index,language';
const cache = new Map(); // key -> { at, value }
function cget(k, now) { const e = cache.get(k); if (e && now - e.at < TTL) return e.value; if (e) cache.delete(k); return undefined; }
function cput(k, v, now) { cache.set(k, { at: now, value: v }); if (cache.size > 500) cache.delete(cache.keys().next().value); }

function abstractOf(inv) {
  if (!inv || typeof inv !== 'object') return null;
  const words = [];
  for (const [w, pos] of Object.entries(inv)) for (const i of pos) words[i] = w;
  const t = words.filter((w) => w != null).join(' ').trim();
  return t ? t.slice(0, 4000) : null;
}
function shape(w, { withAbstract }) {
  const loc = w.primary_location || {}; const src = loc.source || {};
  const out = {
    title: w.title || null, year: w.publication_year ?? null, doi: w.doi ? w.doi.replace(/^https?:\/\/doi\.org\//, '') : null, openalex_id: w.id || null,
    type: w.type || null, authors: (w.authorships || []).slice(0, 25).map((a) => a.author && a.author.display_name).filter(Boolean),
    authors_total: (w.authorships || []).length, venue: src.display_name || null, cited_by: w.cited_by_count ?? 0,
    open_access: { is_oa: !!(w.open_access && w.open_access.is_oa), url: (w.open_access && w.open_access.oa_url) || null },
  };
  if (withAbstract) out.abstract = abstractOf(w.abstract_inverted_index);
  return out;
}
const SRC = { source: 'OpenAlex (openalex.org)', license: 'CC0 (OpenAlex data is public domain)' };

async function call(path, { fetchImpl, key }) {
  const sep = path.includes('?') ? '&' : '?';
  const u = `${BASE}${path}${key ? `${sep}api_key=${encodeURIComponent(key)}` : ''}`;
  let r;
  try { r = await fetchImpl(u, { headers: { accept: 'application/json', 'user-agent': UA }, signal: AbortSignal.timeout(12000) }); } catch (e) { throw unavailable('OpenAlex is unreachable right now. Not charged.'); }
  if (r.status === 429) {
    const ra = Number(r.headers.get('retry-after')) || Math.min(Number(r.headers.get('x-ratelimit-reset')) || 300, 3600);
    throw unavailable("OpenAlex's daily request budget is used up or it is rate limiting. Not charged.", { retryAfter: ra });
  }
  if (r.status === 404) return null;
  if (!r.ok) throw unavailable(`OpenAlex answered HTTP ${r.status}. Not charged.`);
  return r.json();
}

async function searchPapers(p = {}, deps = {}) {
  const fetchImpl = deps.fetchImpl || fetch; const now = deps.now || Date.now(); const key = deps.key !== undefined ? deps.key : process.env.OPENALEX_API_KEY;
  const q = p.q == null ? '' : String(p.q).trim();
  if (!q) throw bad('missing required parameter: q');
  if (q.length > 200) throw bad('q is longer than 200 characters');
  let limit = p.limit == null || p.limit === '' ? 10 : Number(p.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 25) throw bad('limit must be an integer from 1 to 25');
  let yf = null;
  if (p.year_from != null && p.year_from !== '') { yf = Number(p.year_from); if (!Number.isInteger(yf) || yf < 1000 || yf > new Date(now).getUTCFullYear() + 1) throw bad('year_from must be a four-digit year'); }
  const ck = `s|${q.toLowerCase()}|${yf}|${limit}`;
  const hit = cget(ck, now); if (hit) return { ...hit, cached: true };
  const path = `/works?search=${encodeURIComponent(q)}${yf ? `&filter=from_publication_date:${yf}-01-01` : ''}&per-page=${limit}&select=${SELECT}`;
  const j = await call(path, { fetchImpl, key });
  const out = { query: q, year_from: yf, total_matches: (j.meta && j.meta.count) ?? null, returned: (j.results || []).length, papers: (j.results || []).map((w) => shape(w, { withAbstract: false })), ...SRC, cached: false };
  cput(ck, out, now);
  return out;
}

function normDoi(raw) {
  if (raw == null || String(raw).trim() === '') throw bad('missing required parameter: doi');
  let s = String(raw).trim().replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').replace(/^doi:/i, '');
  if (s.length > 200 || !/^10\.\d{4,9}\/\S+$/.test(s)) throw bad('doi must look like 10.1038/s43586-024-00294-7 (URL-encode the slash as %2F in the path)');
  return s.toLowerCase();
}
async function getPaper(p = {}, deps = {}) {
  const fetchImpl = deps.fetchImpl || fetch; const now = deps.now || Date.now(); const key = deps.key !== undefined ? deps.key : process.env.OPENALEX_API_KEY;
  const doi = normDoi(p.doi);
  const ck = `d|${doi}`;
  const hit = cget(ck, now); if (hit) return { ...hit, cached: true };
  const j = await call(`/works/doi:${encodeURIComponent(doi).replace(/%2F/gi, '/')}?select=${SELECT}`, { fetchImpl, key });
  if (!j) throw bad(`OpenAlex has no record for DOI ${doi}`);
  const out = { ...shape(j, { withAbstract: true }), language: j.language || null, ...SRC, cached: false };
  cput(ck, out, now);
  return out;
}

module.exports = { searchPapers, getPaper, abstractOf, normDoi, _cache: cache };

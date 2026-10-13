// tools/wiki.js — /api/wiki (R11 A5): a Wikipedia article's summary and lead section.
//
// Wikipedia text is CC BY-SA 4.0. Every answer carries the licence, its URL, the article URL and the
// revision timestamp, which is the attribution the licence asks for (a link to the source and the
// licence; the authors are listed in the page history, linked as history_url). Share-alike applies to
// the text itself: a caller who republishes it must keep the same licence, and the answer says so.
// The Wikimedia Terms of Use allow reuse "under free and open licenses"; the User-Agent policy asks for
// a descriptive UA with a contact URL (below). Low volume against the public REST and Action APIs; 24 h cache.
// Wikimedia Enterprise is the route if this ever needs bulk volume.
'use strict';

const bad = (msg) => Object.assign(new Error(msg), { kind: 'bad_request' });
const unavailable = (msg, extra) => Object.assign(new Error(msg), { status: 503 }, extra || {});
const UA = 'AgentFeedBot/1.0 (https://x402.ochinimus.app; wikipedia text served with CC BY-SA 4.0 attribution) node-fetch';
const TTL = 24 * 3600e3;
const cache = new Map();
const LICENSE = { license: 'CC BY-SA 4.0', license_url: 'https://creativecommons.org/licenses/by-sa/4.0/' };

async function getJson(u, fetchImpl) {
  let r;
  try { r = await fetchImpl(u, { headers: { accept: 'application/json', 'user-agent': UA, 'api-user-agent': UA }, signal: AbortSignal.timeout(10000) }); } catch { throw unavailable('Wikipedia is unreachable right now. Not charged.'); }
  if (r.status === 404) return null;
  if (r.status === 429) throw unavailable('Wikipedia is rate limiting. Not charged.', { retryAfter: Number(r.headers.get('retry-after')) || 60 });
  if (!r.ok) throw unavailable(`Wikipedia answered HTTP ${r.status}. Not charged.`);
  return r.json();
}

async function getWiki(p = {}, deps = {}) {
  const fetchImpl = deps.fetchImpl || fetch; const now = deps.now || Date.now();
  const title = p.title == null ? '' : String(p.title).trim().replace(/_/g, ' ');
  if (!title) throw bad('missing required parameter: title');
  if (title.length > 200) throw bad('title is longer than 200 characters');
  if (/[\u0000-\u001f#<>[\]{|}]/.test(title)) throw bad('title has characters a Wikipedia page name cannot have');
  const lang = p.lang == null || p.lang === '' ? 'en' : String(p.lang).trim().toLowerCase();
  if (!/^[a-z]{2,3}(-[a-z]{2,8})?$/.test(lang)) throw bad('lang must be a Wikipedia language code such as en, de or simple');
  const ck = `${lang}|${title.toLowerCase()}`;
  const e = cache.get(ck);
  if (e && now - e.at < TTL) return { ...e.value, cached: true };
  const host = `${lang}.wikipedia.org`;
  const enc = encodeURIComponent(title.replace(/ /g, '_'));
  const [sum, lead] = await Promise.all([
    getJson(`https://${host}/api/rest_v1/page/summary/${enc}?redirect=true`, fetchImpl),
    getJson(`https://${host}/w/api.php?action=query&prop=extracts&exintro=1&explaintext=1&redirects=1&format=json&formatversion=2&titles=${encodeURIComponent(title)}`, fetchImpl),
  ]);
  if (!sum) throw bad(`no ${lang}.wikipedia.org article titled "${title}"`);
  const page = lead && lead.query && lead.query.pages && lead.query.pages[0];
  const leadText = page && !page.missing && page.extract ? String(page.extract).trim().slice(0, 6000) : null;
  const canon = sum.titles && sum.titles.canonical ? sum.titles.canonical : sum.title.replace(/ /g, '_');
  const out = {
    title: sum.title, language: lang, type: sum.type || null, description: sum.description || null,
    summary: sum.extract || null, lead: leadText,
    url: (sum.content_urls && sum.content_urls.desktop && sum.content_urls.desktop.page) || `https://${host}/wiki/${encodeURIComponent(canon)}`,
    history_url: `https://${host}/w/index.php?title=${encodeURIComponent(canon)}&action=history`,
    revision_timestamp: sum.timestamp || null, ...LICENSE,
    attribution: `Text from Wikipedia, the free encyclopedia (${host}), available under CC BY-SA 4.0; authors are listed in the page history. Share-alike: text reused from this answer must be offered under the same licence.`,
    ...(sum.type === 'disambiguation' ? { note: 'this title is a disambiguation page' } : {}),
    source: 'Wikipedia REST and Action APIs', cached: false,
  };
  cache.set(ck, { at: now, value: out });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return out;
}

module.exports = { getWiki, LICENSE, _cache: cache };

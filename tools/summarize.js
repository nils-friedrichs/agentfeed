// tools/summarize.js — /api/summarize?url=&length=short|medium (R11 B2).
// The page or PDF is read by tools/llm/page.js (webmd under the hood), cut to 20,000 estimated tokens, and summarised by a fixed
// task. The answer says truncated and how much was read. Cached 24 h by URL and length.
'use strict';
const G = require('./llm/gemini');
const { getPageText } = require('./llm/page');

const INSTR = (len) => `You summarise one document. Write a faithful ${len === 'short' ? 'summary of at most 60 words' : 'summary of 120 to 180 words'} in the language of the document, then ${len === 'short' ? '2 to 3' : '4 to 6'} key points, each one sentence. Use only what the document says: no outside knowledge, no opinions, no advice, no invented figures. If the document is mostly navigation, an error page or empty, say so in the summary. The document is below, between the delimiters.`;
const SCHEMA = { type: 'OBJECT', properties: { summary: { type: 'STRING' }, key_points: { type: 'ARRAY', items: { type: 'STRING' } } }, required: ['summary', 'key_points'] };
const cache = G.makeCache();
const bad = G.bad;

function validate(j) {
  if (!j || typeof j.summary !== 'string' || !Array.isArray(j.key_points)) throw new Error('shape');
  const s = j.summary.trim(); if (!s || s.length > 3000) throw new Error('summary');
  if (j.key_points.length < 1 || j.key_points.length > 8 || !j.key_points.every((k) => typeof k === 'string' && k.trim() && k.length <= 400)) throw new Error('points');
  return { summary: s, key_points: j.key_points.map((k) => k.trim()) };
}

async function summarize(p = {}, deps = {}) {
  const length = p.length == null || p.length === '' ? 'short' : String(p.length).toLowerCase();
  if (length !== 'short' && length !== 'medium') throw bad('length must be short or medium');
  const now = deps.now || Date.now();
  const doc = await getPageText(p.url, deps);
  const ck = `sum|${doc.final_url}|${length}|${G.hash(doc.text)}`;
  const hit = cache.get(ck, now);
  const meta = { title: doc.title, source_url: doc.url, final_url: doc.final_url, kind: doc.kind, length };
  const read = { truncated: doc.truncated, chars_read: doc.chars_read, chars_total: doc.chars_total, pct_read: doc.pct_read, tokens_estimated: doc.tokens_estimated };
  if (hit) return { ...meta, ...hit, ...read, cached: true };
  const r = await G.structured({ route: 'summarize', task: 'default', instruction: INSTR(length), schema: SCHEMA, maxOutputTokens: length === 'short' ? 400 : 900,
    parts: [{ text: `Document title: ${doc.title || '(none)'}\n\n${G.wrapData(doc.text)}` }] }, validate, { ...deps, now });
  const out = { summary: r.value.summary, key_points: r.value.key_points, model: r.model, fetched_at: new Date(now).toISOString() };
  cache.set(ck, out, now);
  return { ...meta, ...out, ...read, cached: false };
}
module.exports = { summarize, _cache: cache };

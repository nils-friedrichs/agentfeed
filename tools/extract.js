// tools/extract.js — /api/extract?url=&schema= (R11 B3): structured fields from a page or PDF.
// schema is a JSON object of at most 20 fields, each mapped to string, number, boolean, date or string[]; at most 2 KB. The answer
// has exactly those keys; a field the document does not state is null. `verbatim_fields` names the string fields whose value appears
// in the source word for word, so the caller can tell a quotation from a paraphrase. Same 20,000-token input cap as summarize.
'use strict';
const G = require('./llm/gemini');
const { getPageText } = require('./llm/page');
const bad = G.bad;

const TYPES = new Set(['string', 'number', 'boolean', 'date', 'string[]']);
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/;
const cache = G.makeCache();

function parseSchema(raw) {
  if (raw == null || String(raw).trim() === '') throw bad('missing required parameter: schema (a JSON object of field names to types)');
  const s = String(raw);
  if (Buffer.byteLength(s) > 2048) throw bad('schema is over the 2 KB limit');
  let o; try { o = JSON.parse(s); } catch { throw bad('schema must be valid JSON, e.g. {"title":"string","price":"number"}'); }
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw bad('schema must be a JSON object mapping field names to types');
  const keys = Object.keys(o);
  if (keys.length < 1 || keys.length > 20) throw bad('schema needs 1 to 20 fields');
  for (const k of keys) {
    if (!NAME_RE.test(k)) throw bad(`field name "${k.slice(0, 40)}" must be letters, digits and underscores, starting with a letter or underscore, up to 40 characters`);
    if (typeof o[k] !== 'string' || !TYPES.has(o[k])) throw bad(`field "${k}" must have the type string, number, boolean, date or string[]`);
  }
  return o;
}
const geminiSchema = (o) => ({
  type: 'OBJECT',
  properties: Object.fromEntries(Object.entries(o).map(([k, t]) => [k, t === 'string[]' ? { type: 'ARRAY', nullable: true, items: { type: 'STRING' } } : t === 'date' ? { type: 'STRING', nullable: true, description: 'ISO 8601 date, YYYY-MM-DD' } : { type: t.toUpperCase(), nullable: true }])),
  required: Object.keys(o),
});
const validDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);

function makeValidate(schema) {
  return (j) => {
    if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('shape');
    const out = {};
    for (const [k, t] of Object.entries(schema)) {
      if (!(k in j)) throw new Error(`missing ${k}`);
      const v = j[k];
      if (v === null) { out[k] = null; continue; }
      if (t === 'string') { if (typeof v !== 'string' || v.length > 5000) throw new Error(k); out[k] = v; }
      else if (t === 'number') { if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(k); out[k] = v; }
      else if (t === 'boolean') { if (typeof v !== 'boolean') throw new Error(k); out[k] = v; }
      else if (t === 'date') { if (!validDate(v)) throw new Error(k); out[k] = v; }
      else if (t === 'string[]') { if (!Array.isArray(v) || v.length > 100 || !v.every((x) => typeof x === 'string' && x.length <= 1000)) throw new Error(k); out[k] = v; }
    }
    return out;
  };
}
const norm = (s) => String(s).toLowerCase().replace(/\s+/g, ' ').trim();
function verbatim(schema, data, text) {
  const hay = norm(text); const names = [];
  for (const [k, t] of Object.entries(schema)) {
    const v = data[k]; if (v == null) continue;
    if (t === 'string' && norm(v) && hay.includes(norm(v))) names.push(k);
    if (t === 'string[]' && v.length && v.every((x) => hay.includes(norm(x)))) names.push(k);
  }
  return names;
}

async function extract(p = {}, deps = {}) {
  const schema = parseSchema(p.schema);
  const now = deps.now || Date.now();
  const doc = await getPageText(p.url, deps);
  const ck = `ext|${doc.final_url}|${G.hash(JSON.stringify(schema))}|${G.hash(doc.text)}`;
  const meta = { title: doc.title, source_url: doc.url, final_url: doc.final_url, kind: doc.kind };
  const read = { truncated: doc.truncated, chars_read: doc.chars_read, chars_total: doc.chars_total, pct_read: doc.pct_read, tokens_estimated: doc.tokens_estimated };
  const hit = cache.get(ck, now);
  if (hit) return { ...meta, ...hit, ...read, cached: true };
  const instruction = 'You extract fields from one document. Return a JSON object with exactly the fields named in the response schema. Fill a field only with what the document explicitly states; when the document does not state it, or you are not sure, return null for that field. Never guess, infer from outside knowledge, or invent a value. Copy names, numbers and wording from the document rather than rewriting them. Dates are ISO 8601 (YYYY-MM-DD). The document is below, between the delimiters.';
  const r = await G.structured({ route: 'extract', task: 'default', instruction, schema: geminiSchema(schema), maxOutputTokens: 1500,
    parts: [{ text: `Document title: ${doc.title || '(none)'}\n\n${G.wrapData(doc.text)}` }] }, makeValidate(schema), { ...deps, now });
  const out = { data: r.value, null_fields: Object.keys(r.value).filter((k) => r.value[k] === null), verbatim_fields: verbatim(schema, r.value, doc.text), model: r.model, fetched_at: new Date(now).toISOString() };
  cache.set(ck, out, now);
  return { ...meta, ...out, ...read, cached: false };
}
module.exports = { extract, parseSchema, geminiSchema, _cache: cache };

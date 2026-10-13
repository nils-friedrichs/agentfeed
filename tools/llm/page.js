// tools/llm/page.js — the text of one caller-supplied URL, for /api/summarize and /api/extract (R11 B).
// HTML goes through tools/webmd.getWebMarkdown, a PDF through tools/webmd.getPdfMarkdown (both fetch via lib/safe-fetch.js,
// honour robots.txt and cap size). The page decides which: webmd refuses a PDF as "content type application/pdf is not ..." before
// the body downloads, and that refusal is the signal to ask the PDF reader instead. The text is cut to the input cap.
'use strict';
const WEBMD = require('../webmd');

const MAX_TOKENS = 20000; const CHARS_PER_TOKEN = 3.5; // a conservative estimate for mixed-language text
const MAX_CHARS = Math.floor(MAX_TOKENS * CHARS_PER_TOKEN);

async function getPageText(url, deps = {}) {
  const web = deps.getWebMarkdown || WEBMD.getWebMarkdown; const pdf = deps.getPdfMarkdown || WEBMD.getPdfMarkdown;
  let kind = 'html'; let doc;
  try { doc = await web({ url }); } catch (e) {
    if (e.kind === 'bad_request' && /content type application\/(?:pdf|x-pdf)|content type application\/octet-stream/i.test(e.message)) { kind = 'pdf'; doc = await pdf({ url }); } else throw e;
  }
  const full = String(doc.markdown || '').trim();
  if (!full) { throw Object.assign(new Error('no readable text was found at this URL'), { kind: 'bad_request' }); }
  const text = full.slice(0, MAX_CHARS);
  return {
    kind, title: doc.title || null, url: doc.url, final_url: doc.final_url, text,
    chars_total: full.length, chars_read: text.length, truncated: full.length > MAX_CHARS || !!doc.truncated,
    pct_read: Math.round((text.length / full.length) * 1000) / 10, tokens_estimated: Math.ceil(text.length / CHARS_PER_TOKEN),
  };
}
module.exports = { getPageText, MAX_TOKENS, MAX_CHARS, CHARS_PER_TOKEN };

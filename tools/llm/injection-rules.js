// tools/llm/injection-rules.js — the rules layer of /api/injection-check (R11 B).
//
// Deterministic patterns for text that tries to give instructions to the AI that will read it: override and role-switch phrasing,
// imitated system tags and tool calls, requests to leak secrets or move funds, attempts to steer the classifier itself, hidden
// Unicode (zero-width, bidi overrides, tag characters, which can carry a whole invisible message and are decoded and re-scanned),
// base64 or hex blobs that decode to instructions, and markdown links or images shaped to carry data out.
//
// A pattern that sits inside quotation marks or code AND follows a cue that the text is discussing attacks ("the phrase",
// "attackers write", "for example") is downgraded to `quoted_pattern` (low), so an article that quotes "ignore previous
// instructions" does not read as an attack. Structural patterns are never downgraded unless they sit in code or quotes with the
// same cue. The rules never say "safe": the best answer they give is "nothing matched".
//
// Severity: high -> malicious, medium -> suspicious, low -> informational only (the model layer decides what it means).
'use strict';

const H = 'high'; const M = 'medium'; const L = 'low';
const RULES = [
  { id: 'override_instructions', sev: H, re: /\b(?:ignore|disregard|forget|override|bypass|discard)\b[^.\n]{0,40}?\b(?:previous|prior|above|earlier|preceding|system|original|all|any)\b[^.\n]{0,30}?\b(?:instructions?|prompts?|rules?|directives?|guidelines?|context|programming)\b/i },
  { id: 'new_instructions_header', sev: H, re: /\b(?:new|updated|real|actual|revised) (?:instructions?|system prompt|directives?|orders?)\s*(?:[:\-]|follow|are)/i },
  { id: 'jailbreak_persona', sev: H, re: /\byou are now (?:in )?(?:a |an |the )?(?:DAN|developer mode|unrestricted|jailbroken|uncensored|evil|unfiltered|free of)\b|\bdo anything now\b/i },
  { id: 'fake_chat_tag', sev: H, re: /<\|(?:im_start|im_end|system|user|assistant|endoftext)\|>|\[\/?(?:INST|SYS)\]|<<\/?SYS>>|<\/?(?:system|assistant|developer|system_prompt|tool_call|function_call|tool_use|instructions)\b[^>]*>/i },
  { id: 'imitated_tool_call', sev: H, re: /\{\s*"(?:tool|function|name|action)"\s*:\s*"[^"]{1,60}"\s*,\s*"(?:arguments|parameters|args|input|params)"\s*:/i },
  { id: 'secret_exfiltration', sev: H, re: /\b(?:send|post|upload|forward|email|exfiltrate|leak|reveal|print|output|repeat|show|disclose)\b[^.\n]{0,60}?\b(?:system prompt|your (?:hidden )?instructions|api[- ]?keys?|secrets?|credentials|passwords?|private keys?|seed phrase|secret recovery phrase|conversation history|environment variables)\b/i },
  { id: 'funds_redirect', sev: H, re: /\b(?:transfer|send|pay|move|swap)\b[^.\n]{0,50}?\b(?:funds|balance|wallet|usdc|sol|eth|tokens?)\b[^.\n]{0,40}?\b(?:to|into)\b[^.\n]{0,12}?(?:0x[0-9a-fA-F]{40}|[1-9A-HJ-NP-Za-km-z]{32,44})\b/i },
  { id: 'steer_the_classifier', sev: H, re: /\b(?:classify|label|mark|report|rate|output|answer|respond|return|say)\b[^.\n]{0,40}?\b(?:as|with|that)\b[^.\n]{0,25}?\b(?:no_injection_found|benign|harmless|not (?:an? )?(?:injection|attack|malicious)|nothing suspicious|completely safe)\b/i },
  { id: 'delimiter_escape', sev: M, re: /<<<\s*UNTRUSTED_DATA|UNTRUSTED_DATA_(?:BEGIN|END)/ },
  { id: 'authority_claim', sev: M, re: /\b(?:this )?(?:message|notice|instruction|order|command)s? (?:is |are )?(?:from|by) (?:the )?(?:system|developer|administrator|admin|operator|anthropic|openai|google|your (?:creator|owner|developer))\b|\b(?:as|i am) (?:your|the) (?:system )?(?:administrator|developer|operator|creator)\b[^.\n]{0,30}\byou (?:must|will|should)\b/i },
  { id: 'jailbreak_terms', sev: M, re: /\bjailbreak(?:ed|ing)?\b[^.\n]{0,15}\b(?:mode|prompt|persona)\b|\bdeveloper mode\b|\bdisable (?:your )?(?:safety|content) (?:filters?|policy|guardrails)\b/i },
  { id: 'jailbreak_word', sev: L, re: /\bjailbreak(?:ed|ing)?\b/i },
  { id: 'conceal_from_user', sev: M, re: /\b(?:do not|don't|never) (?:tell|inform|mention|reveal|show|let)\b[^.\n]{0,30}\b(?:the user|anyone|them|the human|your user)\b/i },
  { id: 'exfil_link_instruction', sev: M, re: /\b(?:append|include|add|encode|insert|embed|attach)\b[^.\n]{0,60}?\b(?:conversation|chat history|secrets?|api key|the user'?s?|memory|system prompt)\b[^.\n]{0,60}?\b(?:url|link|query string|image|markdown)\b/i },
  { id: 'role_switch', sev: L, re: /\b(?:from now on,? you|your new role|you will now be|pretend (?:to be|you are)|act as (?:if you were )?(?:an? )?(?:unrestricted|different|my))\b/i },
  { id: 'generic_act_as', sev: L, re: /\bact as\b/i },
];

// ---- hidden Unicode ----
const ZW = /[​⁠﻿⁡-⁤]/g;
const BIDI_OVERRIDE = /[‪-‮]/g;
const TAGS = /(?:[\u{E0001}\u{E0020}-\u{E007E}])+/gu; // tag characters: invisible ASCII
function decodeTags(s) {
  const out = [];
  for (const m of s.matchAll(TAGS)) {
    // flag emoji (a black flag followed by tags and a cancel tag) are the one legitimate use
    const before = s.slice(Math.max(0, m.index - 2), m.index);
    if (/\u{1F3F4}$/u.test(before) || /\u{1F3F4}/u.test(s.slice(Math.max(0, m.index - 2), m.index))) continue;
    out.push([...m[0]].map((c) => { const cp = c.codePointAt(0); return cp >= 0xe0020 && cp <= 0xe007e ? String.fromCharCode(cp - 0xe0000) : ''; }).join(''));
  }
  return out.filter((t) => t.length >= 3);
}

// ---- encoded blobs ----
const printable = (s) => s.length > 0 && [...s].filter((c) => /[\x20-\x7e\n\r\t]/.test(c)).length / s.length > 0.92;
function decodeBlobs(text) {
  const out = [];
  for (const m of text.matchAll(/(?<![A-Za-z0-9+/_-])[A-Za-z0-9+/]{40,}={0,2}(?![A-Za-z0-9+/])/g)) {
    try { const d = Buffer.from(m[0], 'base64').toString('latin1'); if (printable(d)) out.push({ kind: 'base64', text: d.slice(0, 2000) }); } catch { /* not base64 */ }
  }
  for (const m of text.matchAll(/(?<![0-9A-Fa-f])(?:[0-9A-Fa-f]{2}){20,}(?![0-9A-Fa-f])/g)) {
    try { const d = Buffer.from(m[0], 'hex').toString('latin1'); if (printable(d)) out.push({ kind: 'hex', text: d.slice(0, 2000) }); } catch { /* not hex */ }
  }
  return out;
}

// ---- exfiltration-shaped links ----
const MD_LINK = /!?\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g;
function exfilLinks(text) {
  const hits = [];
  for (const m of text.matchAll(MD_LINK)) {
    const isImage = m[0].startsWith('!');
    let u; try { u = new URL(m[1]); } catch { continue; }
    const q = u.search + u.hash;
    const named = /[?&](?:data|payload|secret|token|key|prompt|conversation|history|memory|chat|session|content|msg|message|text)=/i.test(q);
    const longValue = /=[A-Za-z0-9+/%_-]{40,}/.test(q);
    const placeholder = /\{\{?[a-z_ ]{3,30}\}?\}|\[(?:conversation|secret|data|summary|history)\]/i.test(q + decodeURIComponentSafe(u.pathname));
    if (isImage && (named || longValue || placeholder)) hits.push({ url: m[1].slice(0, 120), why: placeholder ? 'placeholder in the URL' : named ? 'data-carrying parameter in an image URL' : 'long encoded value in an image URL' });
    else if (!isImage && (placeholder || (named && longValue))) hits.push({ url: m[1].slice(0, 120), why: placeholder ? 'placeholder in the URL' : 'long data-carrying parameter in a link' });
  }
  return hits;
}
const decodeURIComponentSafe = (s) => { try { return decodeURIComponent(s); } catch { return s; } };

// ---- quoted / discussed? ----
const CUE = /\b(?:phrases?|strings?|words?|sentences?|prompts?|attacks?|attackers?|attacking|injections?|injected|jailbreaks?|examples?|for instance|such as|e\.g\.|says?|said|saying|quotes?|quoted|wrote|written|reads?|called|known as|famous|classic|common|typical|detect(?:s|ed|ing|ion)?|block(?:s|ed|ing)?|filters?|defen[cs]e|defend(?:s|ing)?|against|researchers?|papers?|stud(?:y|ies)|OWASP|LLMs?|red[- ]team|payloads?|pattern|malicious)\b/i;
function isQuoted(text, index, length) {
  const before = text.slice(Math.max(0, index - 3), index);
  const after = text.slice(index + length, index + length + 3);
  const inQuotes = /["'`“‘«]\s*$/.test(before) || /^\s*["'`”’»]/.test(after);
  const fences = (text.slice(0, index).match(/```/g) || []).length % 2 === 1;
  if (!inQuotes && !fences) return false;
  return CUE.test(text.slice(Math.max(0, index - 200), index));
}

const excerpt = (t, i, n) => t.slice(Math.max(0, i - 15), i + Math.min(n, 90)).replace(/\s+/g, ' ').trim().slice(0, 110);

/** -> { matched: [{id, severity, excerpt, quoted?, via?}], decoded_payloads: [...], verdict: none|suspicious|malicious } */
function scan(text, depth = 0) {
  const matched = []; const decoded = [];
  for (const r of RULES) {
    const re = new RegExp(r.re.source, r.re.flags.includes('g') ? r.re.flags : `${r.re.flags}g`);
    for (const m of text.matchAll(re)) {
      const quoted = isQuoted(text, m.index, m[0].length);
      matched.push(quoted ? { id: 'quoted_pattern', severity: L, excerpt: excerpt(text, m.index, m[0].length), quoted_rule: r.id } : { id: r.id, severity: r.sev, excerpt: excerpt(text, m.index, m[0].length) });
      break; // one hit per rule is enough evidence
    }
  }
  // hidden characters
  const zw = (text.match(ZW) || []).length; const bidi = (text.match(BIDI_OVERRIDE) || []).length;
  if (zw >= 3) matched.push({ id: 'hidden_zero_width', severity: M, excerpt: `${zw} zero-width characters` });
  if (bidi >= 1) matched.push({ id: 'bidi_override', severity: M, excerpt: `${bidi} bidirectional override characters` });
  if (depth === 0) {
    for (const t of decodeTags(text)) {
      decoded.push({ via: 'unicode_tag_characters', text: t.slice(0, 300) });
      const inner = scan(t, 1);
      matched.push({ id: 'hidden_tag_characters', severity: inner.verdict === 'malicious' ? H : M, excerpt: `invisible text: "${t.slice(0, 80)}"` });
    }
    for (const b of decodeBlobs(text)) {
      const inner = scan(b.text, 1);
      if (inner.verdict !== 'none') { decoded.push({ via: b.kind, text: b.text.slice(0, 300) }); matched.push({ id: 'encoded_instruction', severity: inner.verdict === 'malicious' ? H : M, excerpt: `${b.kind} blob decodes to: "${b.text.slice(0, 80)}"`, via: b.kind }); }
    }
    for (const l of exfilLinks(text)) matched.push({ id: 'exfil_shaped_link', severity: M, excerpt: `${l.why}: ${l.url}` });
  }
  const sev = (s) => matched.some((x) => x.severity === s);
  return { matched, decoded_payloads: decoded, verdict: sev(H) ? 'malicious' : sev(M) ? 'suspicious' : 'none' };
}

module.exports = { scan, RULES, decodeTags, decodeBlobs, exfilLinks, isQuoted };

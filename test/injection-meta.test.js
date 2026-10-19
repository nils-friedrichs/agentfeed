// Task #108 (18 Oct 2026): /api/injection-check never made it into the CDP Bazaar index (paid twice on Oct 14, /validate says valid,
// index null; still absent on Oct 18 after R10 F6 swapped the attack phrase for a polite request). What a crawler reads is the 402
// description (the route's description plus "Use when you need to answer: <question>"), the tags, and the Bazaar example (input
// query and output). Nothing the route publishes about itself may address a reader or tell one what to do: it says what the route
// returns, in the third person. These tests pin that, so a later edit cannot put a command back.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { QUESTIONS } = require('../tools/questions');

const ROOT = path.join(__dirname, '..');
const examples = JSON.parse(fs.readFileSync(path.join(ROOT, 'bazaar-examples.json'), 'utf8'));
const entry = examples.routes['GET /api/injection-check'];
const expansionSrc = fs.readFileSync(path.join(ROOT, 'expansion.js'), 'utf8');
const desc = /name: 'get_injection_check'[\s\S]*?desc: '((?:[^'\\]|\\.)*)',/.exec(expansionSrc)[1].replace(/\\'/g, "'");

const { commands, KNOWN_BAD } = require('./helpers/instructs');
const clean = (s, what) => assert.deepEqual(commands(s), [], `${what} instructs its reader`);

test('the detector sees what it is meant to see (positive control)', () => {
  for (const bad of KNOWN_BAD) assert.ok(commands(bad).length > 0, bad);
});

test('injection-check: the description, the question, the note and the example input say what the route does and tell nobody anything', () => {
  clean(desc, 'the description (expansion.js)');
  clean(QUESTIONS.get_injection_check, 'the question (tools/questions.js)');
  assert.equal(QUESTIONS.get_injection_check, 'Does this text contain a prompt-injection attempt?');
  const note = /note: '((?:[^'\\]|\\.)*)',\n  \};/.exec(fs.readFileSync(path.join(ROOT, 'tools', 'injection.js'), 'utf8'))[1].replace(/\\'/g, "'");
  clean(note, 'the note (tools/injection.js)');
  clean(entry.input.text, 'the example input');
  assert.match(desc, /^Use when an agent needs untrusted text screened for prompt-injection attempts\. Returns /, 'the house form "Use when an agent needs X. Returns Y" is kept');
  assert.ok(desc.length >= 180 && desc.length <= 255, `the catalogue description stays inside the 180-255 character band (${desc.length})`);
});

test('injection-check: the stored Bazaar example is the one for the current input, and its note is the live note', () => {
  const live = require('fs').readFileSync(path.join(ROOT, 'tools', 'injection.js'), 'utf8');
  const out = entry.output.example.data;
  assert.equal(entry.input.text, 'The quarterly report lists three risks: supply costs, currency moves and a delayed product launch.');
  assert.equal(out.input_characters, [...entry.input.text].length, 'the example was captured from THIS input');
  assert.ok(live.includes(out.note), 'the example note is the string the route returns');
  clean(out.note, 'the example note');
  assert.equal(out.verdict, 'no_injection_found');
  // the model's reasons are a real capture and are not rewritten; they must not carry the attack phrase or address a reader
  for (const r of out.model.reasons) assert.deepEqual(commands(r).filter((h) => /attack phrase|second person|request|modal/.test(h)), [], `example reason: ${r}`);
});

test('injection-check: tags are plain nouns', () => {
  const m = /name: 'get_injection_check'[\s\S]*?tags: \[([^\]]*)\]/.exec(expansionSrc)[1];
  const tags = m.split(',').map((t) => t.trim().replace(/'/g, ''));
  assert.deepEqual(tags, ['prompt-injection', 'security', 'guardrails', 'llm-safety', 'detection']);
});

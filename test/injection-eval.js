// test/injection-eval.js — run by hand at "go R11", with GEMINI_API_KEY in the environment (it spends real money: about 70 model
// calls, a few hundredths of a dollar). Not a *.test.js file, so the suite never runs it.
//   node --env-file=.env test/injection-eval.js
// Prints precision and recall of the COMBINED check (rules + model) and of the model layer alone on the 5 injections the rules
// cannot catch, over test/fixtures/injection-corpus.js. The offline test measures the rules layer only.
'use strict';
const { injectionCheck } = require('../tools/injection');
const { injections, benign } = require('./fixtures/injection-corpus');
(async () => {
  let tp = 0; let fn = 0; let fp = 0; let hardCaught = 0; let hardTotal = 0; const wrong = [];
  for (const x of injections) {
    const r = await injectionCheck({ text: x.text }); const flagged = r.verdict !== 'no_injection_found';
    if (flagged) tp++; else { fn++; wrong.push(['MISSED', x.text.slice(0, 70)]); }
    if (x.hard) { hardTotal++; if (r.model && r.model.verdict !== 'no_injection_found') hardCaught++; }
  }
  for (const x of benign) { const r = await injectionCheck({ text: x.text }); if (r.verdict !== 'no_injection_found') { fp++; wrong.push(['FALSE POSITIVE', `${r.verdict} (${(r.model && r.model.reasons || []).join('; ')}) ${x.text.slice(0, 60)}`]); } }
  console.log(JSON.stringify({ injections: injections.length, benign: benign.length, tp, fn, fp, precision: +(tp / (tp + fp)).toFixed(3), recall: +(tp / (tp + fn)).toFixed(3), model_alone_on_hard: `${hardCaught}/${hardTotal}` }, null, 1));
  for (const w of wrong) console.log(w.join('  '));
})().catch((e) => { console.error(e.message); process.exit(1); });

// tools/fxrates.js — /api/fx-rates (R5 B4): ECB euro foreign exchange reference rates, plus the
// HIP-3 FX and commodity marks of /api/tradfi-perps where a market exists.
//
// ECB: data-api.ecb.europa.eu, dataflow EXR, daily (series D.*.EUR.SP00.A), published around
// 16:00 CET on TARGET days. The ECB allows free reuse provided it is cited as the source, and
// anyone charging for the data must say that it is available free of charge on the ECB's
// website, before payment and each time it is accessed: this route's description and every
// response carry that notice. Rates for another base are crosses we compute from the euro rates
// and are labelled as such. The ECB says the reference rates are for information only and not
// for transactions; so do we. ECB unreachable with no fresh cache is a 503.
'use strict';
const HIP3 = require('./hip3');
const bad = (msg) => Object.assign(new Error(msg), { kind: 'bad_request' });
const unavailable = (msg) => Object.assign(new Error(msg), { status: 503 });
const NOTICE = 'Euro foreign exchange reference rates: source European Central Bank (ECB). This data is available free of charge on the ECB\'s website (data.ecb.europa.eu); the reference rates are published for information purposes only and are not intended for transactions.';
const URL_ECB = 'https://data-api.ecb.europa.eu/service/data/EXR/D..EUR.SP00.A?lastNObservations=1&format=csvdata';
let ecb = null;

async function readEcb() {
  if (ecb && Date.now() - ecb.at < 3600e3) return ecb;
  let text;
  try {
    const r = await fetch(URL_ECB, { headers: { accept: 'text/csv', 'user-agent': 'AgentFeed/1.0 (+https://x402.ochinimus.app)' }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    text = await r.text();
  } catch (e) {
    if (ecb) return ecb;
    throw unavailable(`ECB data API unavailable (${String(e.message).slice(0, 80)}). Not charged.`);
  }
  const lines = text.trim().split(/\r?\n/); const head = lines.shift().split(',');
  const at = (k) => head.indexOf(k);
  // lastNObservations=1 also returns the last rate of every discontinued series (RUB stopped on
  // 2022-03-01, BGN on 2025-12-31, ...): keep only the newest reference date
  const obs = []; let date = null;
  for (const l of lines) {
    const c = l.split(',');
    const cur = c[at('CURRENCY')]; const v = Number(c[at('OBS_VALUE')]); const d = c[at('TIME_PERIOD')];
    if (cur && Number.isFinite(v) && d) { obs.push([cur, v, d]); if (!date || d > date) date = d; }
  }
  const rates = {}; for (const [cur, v, d] of obs) if (d === date) rates[cur] = v;
  if (!Object.keys(rates).length) throw unavailable('ECB returned no rates. Not charged.');
  ecb = { at: Date.now(), date, rates };
  return ecb;
}

// the newest ECB reference date may lag by a weekend plus TARGET holidays; past 5 days it is stale
const STALE_DAYS = 5;

async function getFxRates(p = {}) {
  const baseCur = p.base == null || p.base === '' ? 'EUR' : String(p.base).trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(baseCur)) throw bad('base must be a 3-letter currency code such as EUR, USD or JPY');
  const e = await readEcb();
  if (!e.date || Date.now() - Date.parse(e.date + "T16:00:00+01:00") > STALE_DAYS * 86400e3) throw unavailable(`ECB reference rates are stale (latest ${e.date}). Not charged.`);
  if (baseCur !== 'EUR' && !e.rates[baseCur]) throw bad(`the ECB publishes no reference rate for ${baseCur}`);
  const k = baseCur === 'EUR' ? 1 : 1 / e.rates[baseCur];
  const rates = { ...(baseCur === 'EUR' ? {} : { EUR: Math.round(k * 1e6) / 1e6 }) };
  for (const [cur, v] of Object.entries(e.rates)) if (cur !== baseCur) rates[cur] = Math.round(v * k * 1e6) / 1e6;
  let hip3 = []; let hip3Error = null;
  try {
    const t = await HIP3.getTradfiPerps({});
    hip3 = t.markets.filter((m) => m.asset_class === 'fx' || m.asset_class === 'commodity')
      .map(({ market, ticker, asset_class, mark_px, oracle_px, change_24h_pct }) => ({ market, ticker, asset_class, mark_px, oracle_px, change_24h_pct }));
  } catch (err) { hip3Error = 'HIP-3 marks unavailable right now'; }
  return {
    base: baseCur, ecb_reference_date: e.date, rates, rates_are: baseCur === 'EUR' ? 'ECB euro reference rates as published' : `crosses computed by us from the ECB euro reference rates (1 ${baseCur} in each currency)`,
    hip3_fx_and_commodity_marks: hip3, ...(hip3Error ? { hip3_note: hip3Error } : {}),
    notice: NOTICE, source: 'European Central Bank (data-api.ecb.europa.eu, EXR); Hyperliquid HIP-3 (api.hyperliquid.xyz)',
  };
}

module.exports = { getFxRates, NOTICE };

// tools/marketstate.js — get_market_state ($0.02): one pre-trade picture per
// symbol, assembled ONLY from data this service already holds: the funding-radar
// snapshot, the macro calendar, our own liquidation tape, and the cached reads
// the existing routes make (derivs.js, prices.js, feargreed.js, hlwhales.js).
// No new upstream. Every part carries its source and as_of; a part we cannot
// answer for this symbol is { value: null, reason }, never a guess. When no part
// of the market picture itself (spot, perp, volatility, open interest) could be
// built, the whole route is a 503 and is never billed.
// R7: implied volatility (an options-venue index) is gone with the options routes, whose source forbids derived data.
'use strict';
const D = require('./derivs');
const L = require('./liqdb');
const { getPrice } = require('./prices');
const { getFearGreed } = require('./feargreed');
const { getHlCtx } = require('./funding');
const FR = require('./fundingradar');
const HW = require('./hlwhales');
const HLP = require('./hlperp');
const MACRO = require('./macro');

const SYMBOLS = ['BTC', 'ETH', 'SOL', 'HYPE'];
const T = {
  funding_extreme_abs_z: 2,
  liq_spike_multiple: 3,
  liq_spike_window_h: 168,
  event_within_h: 24,
};
const iso = (ms) => new Date(ms).toISOString();
const missing = (reason) => ({ value: null, reason });
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null; };

async function part(fn) {
  try { return await fn(); } catch (e) { return missing(`source failed: ${String(e.message || e).slice(0, 160)}`); }
}

async function getMarketState(p = {}, { now = Date.now() } = {}) {
  const base = String(p.symbol || 'BTC').toUpperCase().replace(/USDT$/, '');
  if (!SYMBOLS.includes(base)) { const e = new Error(`market-state covers ${SYMBOLS.join(', ')}; got ${base}`); e.kind = 'bad_request'; throw e; }
  const sym = `${base}USDT`;

  const [spot, vol, oi, whales, basis, fg, radar, liq] = await Promise.all([
    part(async () => {
      // HYPE has no deep USDC pool we read; Hyperliquid's own oracle price for it is public chain state (R5 C1)
      if (base === 'HYPE') { const c = await getHlCtx('HYPE'); return { value: Number(c.oraclePx), source: 'Hyperliquid HYPE oracle price (validator-published)', as_of: iso(now) }; }
      const q = await getPrice(base);
      return { value: q.price, source: q.source || q.venue || 'multi-source spot', as_of: q.publish_time ? iso(q.publish_time * 1000) : iso(now) };
    }),
    part(async () => { const v = await D.getVolatility({ symbol: sym }); return { rv_7d_ann_pct: v.realized_vol_7d_ann_pct, rv_30d_ann_pct: v.realized_vol_30d_ann_pct, today_range_pct: v.today_range_pct, source: v.source, as_of: iso(now) }; }),
    part(async () => { const o = await D.getOpenInterest({ symbol: sym }); return { hyperliquid_usd: o.oi_usd, change_1h_pct: o.change_1h_pct, change_24h_pct: o.change_24h_pct, mark_price: o.mark_price, source: 'Hyperliquid open interest (changes from our 5-minute sampler)', as_of: iso(now) }; }),
    part(async () => { const w = await HW.whaleShare(base === 'HYPE' ? 'HYPE' : base); return { net_long_share_pct: w.net_long_share_pct, long_usd: w.long_usd, short_usd: w.short_usd, long_accounts: w.long_accounts, short_accounts: w.short_accounts, covers: `the top ${w.whale_list_size} Hyperliquid accounts by account value; whale crowding, not the whole market's`, source: 'Hyperliquid account positions (hl-whales snapshot)', as_of: w.as_of }; }),
    part(async () => { const b = await D.getBasis({ symbol: sym }); return { mark_price: b.mark_price, price_24h_note: null, ...b }; }),
    part(async () => { const f = await getFearGreed(); return { value: f.value, classification: f.classification, source: f.source || 'alternative.me', as_of: f.timestamp ? iso(Number(f.timestamp) * 1000) : iso(now) }; }),
    part(async () => {
      const r = FR.getRadarRow(sym, { now });
      if (!r) return missing('funding radar snapshot not built yet');
      if (r.stale) return missing(`funding radar snapshot is ${r.age_s}s old (limit ${FR.STALE_AFTER_S}s)`);
      const row = r.row;
      if (!row) return missing(`${sym} is not in the funding radar's snapshot`);
      const venues = Object.fromEntries(Object.entries(row.venues).filter(([, v]) => v).map(([k, v]) => [k, { funding_rate_8h: v.funding_rate_8h, z_30d: v.z_30d, samples: v.samples }]));
      return { venues, max_abs_z: row.max_abs_z, source: 'AgentFeed funding radar snapshot', as_of: r.as_of };
    }),
    part(async () => {
      // liqdb buckets are { bucket: start ms, usd_total, longs_usd, shorts_usd, ... },
      // aligned to the bucket size. The last 60 minutes come from 5-minute buckets so
      // the window is the real last hour, not the current partial clock hour.
      const sum = (xs, k) => Math.round(xs.reduce((t, x) => t + (x[k] || 0), 0));
      const fine = (L.getLiqHistory({ symbol: sym, hours: 2, bucket_min: 5 }, { tapeCheck: false }).buckets || []).filter((x) => x.bucket >= now - 3_600_000);
      const h = L.getLiqHistory({ symbol: sym, hours: T.liq_spike_window_h, bucket_min: 60 }, { tapeCheck: false });
      const b = h.buckets || [];
      const d24 = b.filter((x) => x.bucket >= now - 24 * 3_600_000);
      // completed clock hours only, zero-filled: a quiet hour is a real 0
      const curHour = Math.floor(now / 3_600_000) * 3_600_000;
      const byHour = new Map(b.map((x) => [x.bucket, x.usd_total || 0]));
      const hourly = [];
      for (let t = curHour - (T.liq_spike_window_h - 1) * 3_600_000; t < curHour; t += 3_600_000) hourly.push(byHour.get(t) || 0);
      const latest = fine.length ? fine[fine.length - 1].bucket : (b.length ? b[b.length - 1].bucket : null);
      return {
        last_1h: { longs_usd: sum(fine, 'longs_usd'), shorts_usd: sum(fine, 'shorts_usd'), total_usd: sum(fine, 'usd_total') },
        last_24h: { longs_usd: sum(d24, 'longs_usd'), shorts_usd: sum(d24, 'shorts_usd'), total_usd: sum(d24, 'usd_total'), window_note: 'clock-hour buckets touching the last 24 hours' },
        hourly_median_usd: Math.round(median(hourly)),
        median_window_h: hourly.length,
        side_note: 'longs_usd = longs liquidated (sell orders), shorts_usd = shorts liquidated (buy orders)',
        source: h.source || 'AgentFeed liquidation tape (Bybit, OKX, Binance)', as_of: latest ? iso(latest) : iso(now),
      };
    }),
  ]);

  // nothing of the market picture itself could be built: our source is down, so 503 and not billed (R7 R4)
  if ([spot, basis, vol, oi].every((x) => x && x.value === null)) throw HLP.sourceDown(new Error('spot, perp, volatility and open interest all failed'));

  const event = MACRO.nextEvent(now);

  const flags = [];
  if (radar && radar.max_abs_z != null && radar.max_abs_z >= T.funding_extreme_abs_z) flags.push('funding_extreme');
  if (liq && liq.last_1h && liq.hourly_median_usd > 0 && liq.last_1h.total_usd >= T.liq_spike_multiple * liq.hourly_median_usd) flags.push('liq_spike_1h');
  if (event && event.hours_to_go != null && event.hours_to_go <= T.event_within_h) flags.push('event_within_24h');

  return {
    symbol: base, as_of: iso(now),
    spot, perp: basis && basis.value !== null ? { mark_price: basis.mark_price, basis_pct: basis.basis_pct, basis_state: basis.state, source: 'Hyperliquid perp mark vs oracle', as_of: iso(now) } : basis,
    realized_vol: vol,
    funding: radar,
    open_interest: oi,
    whale_positioning: whales,
    liquidations: liq,
    fear_greed: fg,
    next_macro_event: event || missing('macro calendar unavailable or no upcoming event'),
    flags,
    flag_rules: {
      funding_extreme: `|z_30d| >= ${T.funding_extreme_abs_z} on any venue in the funding radar`,
      liq_spike_1h: `last 60 minutes of liquidations >= ${T.liq_spike_multiple}x the median hourly total over the previous ${T.liq_spike_window_h - 1} hours of our tape (quiet hours count as 0)`,
      event_within_24h: `the next FOMC decision or CPI, NFP or PCE release is within ${T.event_within_h} hours`,
    },
  };
}

module.exports = { getMarketState, SYMBOLS, THRESHOLDS: T };

// tools/derivs.js — expansion: derivatives suite (9 tools).
// Venues: Bybit v5 public REST (precedent: positioning.js) and Hyperliquid.
// NO Binance REST here — their ToS prohibits charging for their market data.
// NO OKX since R6 D2 (13 Oct 2026): the OKX API Agreement §9.4 forbids redistributing its market data
// (docs/SOURCES.md). Bybit stays; its API Terms §6.7 are recorded there too and the decision is the planning chat's.
// All endpoints env-overridable for offline testing (same philosophy as liqcollector EP).
'use strict';
const { cached, fetchJson } = require('../lib/cache');
// R5 C6: Hyperliquid as a second venue on every product that read only Bybit
const HLP = require('./hlperp');

const BYBIT = () => process.env.BYBIT_REST || 'https://api.bybit.com';
const HL = () => process.env.HL_API || 'https://api.hyperliquid.xyz/info';

const SYM_RE = /^[A-Z0-9]{2,20}USDT$/;
function normSym(s) {
  const raw = String(s || 'SOLUSDT').trim().toUpperCase();
  if (!/^[A-Z0-9]{2,20}$/.test(raw)) throw new Error(`invalid symbol: ${s}`); // reject, never sanitize — '../etc' must not become ETCUSDT
  const sym = raw.endsWith('USDT') ? raw : raw + 'USDT';
  if (!SYM_RE.test(sym)) throw new Error(`invalid symbol: ${s}`);
  return sym;
}
const baseCoin = (sym) => sym.replace(/USDT$/, '');

async function bybit(path) {
  const j = await fetchJson(BYBIT() + path);
  if (j.retCode !== 0) {
    const e = new Error(`bybit: ${j.retMsg}`);
    // retCode 10001 is Bybit'"'"'s PARAMETER error. Bybit answered - HTTP 200,
    // measured - and refused what was asked for, so it is the caller'"'"'s fault
    // and telegraph.js turns it into a 400 rather than a 502.
    //
    // The CODE is the discriminator, never the message. Measured 2026-08-22,
    // one retCode 10001 carries at least four different retMsg spellings:
    //   tickers        -> params error: symbol invalid
    //   kline          -> params error: Symbol Is Invalid
    //   funding/history-> params error: Symbol Invalid
    //   account-ratio  -> params error: symbol not support
    // Matching on the word invalid would have missed the fourth outright.
    //
    // Everything else stays a 502, deliberately: another retCode (10006 rate
    // limit, 10016 service error) is OUR problem, and a transport failure or a
    // non-200 never reaches this line at all - fetchJson throws first. A miner
    // that answers 400 while Bybit is down is lying about whose fault it is.
    if (j.retCode === 10001) e.upstreamParamError = true;
    throw e;
  }
  return j.result;
}

// all Bybit linear tickers in one call, filtered to USDT-quoted — funding, OI
// value and 24h change for every Bybit USDT perp. No count here: the venue
// lists 783 today (measured 2026-09-23) and it moves every week.
const allTickers = () =>
  cached('bybit:tickers', 30_000, async () =>
    (await bybit('/v5/market/tickers?category=linear')).list.filter((t) => /USDT$/.test(t.symbol)));

const pct = (now, then) => (then ? Math.round(((now - then) / then) * 10000) / 100 : null);
const n = (v) => (v == null || v === '' ? null : Number(v));

// ---- funding intervals ------------------------------------------------------
// A venue quotes funding for ITS OWN interval, and about half the market is not
// 8-hourly. Measured 2026-09-28 from the venues' own APIs: Bybit settles 376 of
// its 777 USDT perps every 4h and one hourly (OKX, since dropped, 209 of 477 every
// 4h). SOL, BTC and ETH are 8h on both, which is why tests on the majors
// never showed a 4h rate being published as an 8h rate, at half its size. So
// the interval is read from the venue for every symbol, and a rate whose
// interval cannot be read says so and gets no 8h figure instead of a guess:
//   Bybit        instruments-info fundingInterval (minutes), one cached sweep
//   Hyperliquid  hourly, by protocol
// Bybit also moves symbols between intervals (see get_funding_history), so the
// sweep is cached for ten minutes, not for the day. instruments-info answers
// only status=Trading unless asked, while the tickers every screen here ranks
// also carry PreLaunch perps with a live funding rate (measured 2026-09-28:
// BPUSDT, 4h, $1.1M 24h turnover), so each status tickers can show is swept.
const INTERVAL_STATUSES = ['Trading', 'PreLaunch', 'Delivering'];
const bybitIntervals = () =>
  cached('bybit:fundingIntervals', 600_000, async () => {
    const hours = {};
    await Promise.all(INTERVAL_STATUSES.map(async (status) => {
      let cursor = '';
      for (let page = 0; page < 10; page++) {
        const r = await bybit(`/v5/market/instruments-info?category=linear&status=${status}&limit=1000${cursor ? `&cursor=${cursor}` : ''}`);
        for (const i of r.list) if (Number(i.fundingInterval) > 0) hours[i.symbol] = Number(i.fundingInterval) / 60;
        cursor = r.nextPageCursor;
        if (!cursor) break;
      }
    }));
    return hours;
  });
// A failed sweep leaves every Bybit interval unknown -- never 8h by default.
const bybitIntervalMap = () => bybitIntervals().catch(() => ({}));
const HL_INTERVAL_HOURS = 1;

// raw x 8 / interval, and raw x (24 / interval) x 365 x 100. Both are exact for
// 1, 2, 4 and 8h, the only intervals the venues use today: an 8h symbol's
// figures are its raw rate bit for bit, and a 4h symbol's 8h figure is exactly
// twice its raw rate.
const to8h = (raw, ih) => (raw == null || ih == null ? null : (raw * 8) / ih);
const annualizedPct = (raw, ih) => (raw == null || ih == null ? null : Number((raw * (24 / ih) * 365 * 100).toFixed(2)));
// the two fields every venue rate now carries
const rateBasis = (raw, ih) => ({ funding_rate_raw: raw, funding_interval_hours: ih });
const INTERVAL_UNKNOWN = 'no funding interval could be read for this rate, so funding_rate_8h is null rather than a guess';
const intervalNote = (ih) => (ih == null ? { funding_interval_note: INTERVAL_UNKNOWN } : {});
const ROWS_INTERVAL_UNKNOWN = 'rows with funding_interval_hours null had no interval to read, so their funding_rate_8h is null rather than a guess';

// ---- get_funding_cross ($0.01) — one symbol, funding across 2 venues (Bybit, Hyperliquid)
// Each venue lookup settles to its row, to NOT_LISTED when the venue answered
// that it does not list the symbol, or to null when it could not be asked. The
// symbol is the caller's mistake only when both answered NOT_LISTED; while
// any venue went unanswered it may still list it, and that failure is ours.
const NOT_LISTED = Symbol('not listed');
const listed = (v) => v != null && v !== NOT_LISTED;
async function getFundingCross(p = {}) {
  const sym = normSym(p.symbol);
  return cached(`fcross:${sym}`, 30_000, async () => {
    const [by, hl, ivs] = await Promise.all([
      bybit(`/v5/market/tickers?category=linear&symbol=${sym}`).then((r) => r.list[0] || NOT_LISTED).catch((e) => (e.upstreamParamError ? NOT_LISTED : null)),
      cached('hl:ctxs', 60_000, () =>
        fetchJson(HL(), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'metaAndAssetCtxs' }) }),
      ).then(([meta, ctxs]) => {
        const i = meta.universe.findIndex((u) => u.name === baseCoin(sym));
        return i >= 0 ? ctxs[i] : NOT_LISTED;
      }).catch(() => null),
      bybitIntervalMap(),
    ]);
    const venues = {};
    if (listed(by)) {
      const raw = n(by.fundingRate), ih = ivs[sym] ?? null;
      venues.bybit = { funding_rate_8h: to8h(raw, ih), ...rateBasis(raw, ih), ...intervalNote(ih), next_funding_time: n(by.nextFundingTime), mark_price: n(by.markPrice) };
    }
    if (listed(hl)) {
      const raw = n(hl.funding);
      venues.hyperliquid = { funding_rate_1h: raw, funding_rate_8h_equiv: raw != null ? Number((raw * 8).toFixed(8)) : null, ...rateBasis(raw, HL_INTERVAL_HOURS), mark_price: n(hl.markPx) };
    }
    if (!Object.keys(venues).length) {
      if (by === NOT_LISTED && hl === NOT_LISTED) {
        const e = new Error(`no venue lists ${sym}: bybit and hyperliquid each answered and none lists it`);
        e.kind = 'bad_request';
        e.upstreamParamError = true;
        throw e;
      }
      const silent = [['bybit', by], ['hyperliquid', hl]].filter(([, v]) => v == null).map(([k]) => k);
      throw new Error(`no venue lists ${sym} (no answer from ${silent.join(', ')})`);
    }
    const rates = [venues.bybit?.funding_rate_8h, venues.hyperliquid?.funding_rate_8h_equiv].filter((x) => x != null);
    return {
      symbol: sym, venues,
      spread_8h: rates.length > 1 ? Number((Math.max(...rates) - Math.min(...rates)).toFixed(8)) : null,
      crowding: rates.length ? (rates.every((r) => r > 0) ? 'longs_pay_everywhere' : rates.every((r) => r < 0) ? 'shorts_pay_everywhere' : 'mixed') : null,
    };
  });
}

// ---- get_funding_extremes ($0.02) — most crowded trades across every Bybit USDT perp
// Ranked on the 8h equivalent, so a 4h symbol competes at its true size. A
// symbol whose interval cannot be read cannot be placed in that ranking; it is
// named in unranked_interval_unknown instead of being ranked on a guess.
async function getFundingExtremes(p = {}) {
  const limit = Math.min(Math.max(parseInt(p.limit) || 10, 1), 25);
  const minTurn = Number(p.min_turnover_usd) || 1_000_000;
  const [tickers, ivs] = await Promise.all([allTickers(), bybitIntervalMap()]);
  const liquid = tickers.filter((t) => n(t.turnover24h) >= minTurn && t.fundingRate !== '');
  const unranked = liquid.filter((t) => ivs[t.symbol] == null).map((t) => t.symbol);
  const list = liquid
    .filter((t) => ivs[t.symbol] != null)
    .map((t) => {
      const raw = n(t.fundingRate), ih = ivs[t.symbol];
      return {
        symbol: t.symbol,
        funding_rate_8h: to8h(raw, ih),
        ...rateBasis(raw, ih),
        annualized_pct: annualizedPct(raw, ih),
        price_24h_pct: Number((n(t.price24hPcnt) * 100).toFixed(2)),
        oi_usd: Math.round(n(t.openInterestValue) || 0),
      };
    })
    .sort((a, b) => b.funding_rate_8h - a.funding_rate_8h);
  const hl = await HLP.universe({ minVolumeUsd: minTurn }).then((rows) => rows.sort((a, b) => b.funding_rate_8h - a.funding_rate_8h), () => null);
  return {
    source: 'bybit_linear_universe', universe_size: list.length, min_turnover_usd: minTurn,
    most_positive: list.slice(0, limit),        // longs paying most — short-squeeze fuel is spent, long-flush risk
    most_negative: list.slice(-limit).reverse(), // shorts paying most — crowded shorts, squeeze candidates
    ...(unranked.length ? { unranked_interval_unknown: unranked } : {}),
    hyperliquid: hl ? { universe_size: hl.length, min_volume_24h_usd: minTurn, most_positive: hl.slice(0, limit), most_negative: hl.slice(-limit).reverse(), source: HLP.SRC }
      : { available: false, reason: 'Hyperliquid read failed', source: HLP.SRC },
  };
}

// ---- get_open_interest ($0.01) — any symbol, OI + deltas, Bybit + Hyperliquid
async function getOpenInterest(p = {}) {
  const sym = normSym(p.symbol);
  return cached(`oi:${sym}`, 60_000, async () => {
    const [hist, tick] = await Promise.all([
      bybit(`/v5/market/open-interest?category=linear&symbol=${sym}&intervalTime=1h&limit=25`),
      bybit(`/v5/market/tickers?category=linear&symbol=${sym}`).then((r) => r.list[0]),
    ]);
    const o = hist.list.map((x) => parseFloat(x.openInterest));
    return {
      symbol: sym,
      bybit: { oi_base: o[0], oi_usd: Math.round(n(tick.openInterestValue)), change_1h_pct: pct(o[0], o[1]), change_24h_pct: pct(o[0], o[24]) },
      mark_price: n(tick.markPrice),
      hyperliquid: await HLP.block(sym, async (c, x) => ({ oi_base: x.oi_base, oi_usd: x.oi_usd, mark_price: x.mark })),
    };
  });
}

// ---- get_oi_spike_scan ($0.02) — abnormal OI jumps across universe.
// Self-warming: snapshots recorded on use, no background load. First calls
// return warming:true until a >=30min-old snapshot exists.
const oiSnaps = []; // { at, map: symbol -> oiValueUsd }
async function getOiSpikeScan(p = {}) {
  const limit = Math.min(Math.max(parseInt(p.limit) || 10, 1), 25);
  const list = await allTickers();
  const nowMap = {};
  for (const t of list) if (n(t.openInterestValue) > 0) nowMap[t.symbol] = n(t.openInterestValue);
  const now = Date.now();
  const hlNow = {};
  try { for (const c of (await HLP.contexts()).values()) if (c.oi_usd > 0) hlNow[c.coin] = c.oi_usd; } catch { /* Hyperliquid part only */ }
  if (!oiSnaps.length || now - oiSnaps[oiSnaps.length - 1].at > 5 * 60_000) oiSnaps.push({ at: now, map: nowMap, hl: hlNow });
  while (oiSnaps.length > 30) oiSnaps.shift();
  const base = oiSnaps.find((s) => now - s.at >= 30 * 60_000);
  if (!base) {
    const oldest = oiSnaps[0];
    return { warming: true, ready_in_min: Math.max(1, Math.ceil(30 - (now - oldest.at) / 60_000)), note: 'spike baseline builds from first call after boot; retry shortly' };
  }
  const rows = [];
  for (const [sym, oiNow] of Object.entries(nowMap)) {
    const oiThen = base.map[sym];
    if (!oiThen || oiNow < 3_000_000) continue; // ignore dust markets
    const chg = pct(oiNow, oiThen);
    if (chg != null) rows.push({ symbol: sym, oi_usd: Math.round(oiNow), oi_change_pct: chg });
  }
  rows.sort((a, b) => Math.abs(b.oi_change_pct) - Math.abs(a.oi_change_pct));
  const tickBySym = Object.fromEntries(list.map((t) => [t.symbol, t]));
  const ivs = await bybitIntervalMap();
  const spikes = rows.slice(0, limit).map((r) => {
    const raw = n(tickBySym[r.symbol]?.fundingRate), ih = ivs[r.symbol] ?? null;
    return { ...r, funding_rate_8h: to8h(raw, ih), ...rateBasis(raw, ih), price_24h_pct: Number((n(tickBySym[r.symbol]?.price24hPcnt) * 100).toFixed(2)) };
  });
  const hlRows = [];
  for (const [coin, oiNow] of Object.entries(hlNow)) {
    const oiThen = base.hl && base.hl[coin];
    if (!oiThen || oiNow < 3_000_000) continue;
    const chg = pct(oiNow, oiThen);
    if (chg != null) hlRows.push({ coin, oi_usd: Math.round(oiNow), oi_change_pct: chg });
  }
  hlRows.sort((a, b) => Math.abs(b.oi_change_pct) - Math.abs(a.oi_change_pct));
  return {
    source: 'bybit_linear_universe',
    baseline_min_ago: Math.round((now - base.at) / 60_000),
    spikes,
    hyperliquid: base.hl ? { spikes: hlRows.slice(0, limit), source: HLP.SRC } : { available: false, reason: 'no Hyperliquid baseline yet', source: HLP.SRC },
    ...(spikes.some((x) => x.funding_rate_raw != null && x.funding_interval_hours == null) ? { funding_interval_note: ROWS_INTERVAL_UNKNOWN } : {}),
  };
}

// ---- get_long_short ($0.01) — any symbol account L/S ratio + trend
async function getLongShort(p = {}) {
  const sym = normSym(p.symbol);
  return cached(`ls:${sym}`, 60_000, async () => {
    const r = await bybit(`/v5/market/account-ratio?category=linear&symbol=${sym}&period=1h&limit=25`);
    if (!r.list?.length) throw new Error(`no L/S data for ${sym}`);
    const at = (i) => (r.list[i] ? Math.round(parseFloat(r.list[i].buyRatio) * 10000) / 100 : null);
    return {
      symbol: sym, source: 'bybit_v5_public', period: '1h',
      long_pct: at(0), short_pct: r.list[0] ? Math.round(parseFloat(r.list[0].sellRatio) * 10000) / 100 : null,
      long_pct_1h_ago: at(1), long_pct_24h_ago: at(24),
      ts: parseInt(r.list[0].timestamp),
    };
  });
}

// ---- get_basis ($0.01) — perp premium/discount vs spot
//
// MULTIPLIED PERPS. Bybit lists high-supply memecoins as a perp on a bundle of
// coins - 1000PEPEUSDT is a contract on ONE THOUSAND pepe - while the spot pair
// carries no multiplier and is plain PEPEUSDT. Two consequences, both handled
// here, and getting either wrong is a three-orders-of-magnitude error:
//
//   1. Asking spot for '1000PEPEUSDT' returns retCode 10001 'Not supported
//      symbols'. The old code asked for exactly that, got null, and threw an
//      UNTAGGED error, which statusFor() classified 502 - reporting a permanent
//      property of the symbol as if it were our outage. Basis was therefore
//      dead on every multiplied perp.
//   2. Once the right spot pair is found, its price must be scaled by the
//      multiplier before the comparison. Measured 2026-08-27: mark 0.0037850
//      against raw spot 0.000003787 gives an absurd 99847.1877 percent;
//      against 1000x-scaled spot 0.003787 it gives -0.0528 percent, which is a
//      real basis.
//
// WHY THE PREFIX MUST BE A POWER OF TEN. 1INCHUSDT is a genuine token whose
// name begins with a digit, and its spot pair really is 1INCHUSDT (verified
// live, last price 0.08954). Stripping a bare leading /\d+/ would rewrite it to
// INCHUSDT and break a working symbol. Bybit's multipliers are all 1 followed
// by zeros and at least 1000, so that is exactly what is matched, and the
// unmultiplied symbol is always TRIED FIRST regardless.
const MULT_RE = /^(10{2,})([A-Z0-9]+USDT)$/;

function spotCandidates(sym) {
  // Always try the symbol as given first: if a spot pair of that exact name
  // exists, it is the right one and no scaling is involved.
  const out = [{ symbol: sym, multiplier: 1 }];
  const m = MULT_RE.exec(sym);
  if (m) {
    const mult = Number(m[1]);
    if (Number.isFinite(mult) && mult >= 1000) out.push({ symbol: m[2], multiplier: mult });
  }
  return out;
}

async function getBasis(p = {}) {
  const sym = normSym(p.symbol);
  return cached(`basis:${sym}`, 30_000, async () => {
    const cands = spotCandidates(sym);
    // The perp and the FIRST spot candidate go out together, so an ordinary
    // symbol still costs one round trip. The second candidate is only fetched
    // for a multiplied perp whose unmultiplied spot pair does not exist.
    const [perp, direct, ivs] = await Promise.all([
      bybit(`/v5/market/tickers?category=linear&symbol=${sym}`).then((r) => r.list[0]),
      bybit(`/v5/market/tickers?category=spot&symbol=${cands[0].symbol}`).then((r) => r.list[0]).catch(() => null),
      bybitIntervalMap(),
    ]);

    let spot = direct, chosen = cands[0];
    for (let i = 1; !spot && i < cands.length; i++) {
      spot = await bybit(`/v5/market/tickers?category=spot&symbol=${cands[i].symbol}`)
        .then((r) => r.list[0]).catch(() => null);
      if (spot) chosen = cands[i];
    }

    if (!spot) {
      // The caller named a perp that has no spot listing at all, so a basis is
      // undefined for it - permanently, not because anything is down. Tagged so
      // statusFor() answers 400: Telegraph's validator passes a 4xx and fails a
      // 5xx, and calling this our outage would be a lie.
      const e = new Error(
        `no spot pair on bybit for ${sym} (tried ${cands.map((c) => c.symbol).join(', ')}); ` +
        `basis is undefined for a perp with no spot listing`
      );
      e.upstreamParamError = true;
      throw e;
    }

    const mark = n(perp.markPrice);
    const spotRaw = n(spot.lastPrice);
    // The number actually compared against mark. For an ordinary pair the
    // multiplier is 1 and this is the venue price unchanged.
    const sp = chosen.multiplier === 1 ? spotRaw : Number((spotRaw * chosen.multiplier).toPrecision(12));
    const basisPct = Number((((mark - sp) / sp) * 100).toFixed(4));
    return {
      symbol: sym, mark_price: mark, spot_price: sp,
      // Disclosed ONLY for a multiplied perp, so an ordinary symbol's payload
      // is byte-for-byte what it has always been.
      ...(chosen.multiplier === 1 ? {} : {
        spot_symbol: chosen.symbol,
        spot_price_raw: spotRaw,
        spot_multiplier: chosen.multiplier,
      }),
      basis_pct: basisPct,
      state: basisPct > 0.05 ? 'contango (perp premium — longs aggressive)' : basisPct < -0.05 ? 'backwardation (perp discount — shorts aggressive)' : 'flat',
      funding_rate_8h: to8h(n(perp.fundingRate), ivs[sym] ?? null),
      ...rateBasis(n(perp.fundingRate), ivs[sym] ?? null),
      ...intervalNote(ivs[sym] ?? null),
      hyperliquid: await HLP.block(sym, async (c, x) => {
        const b = x.mark != null && x.oracle ? Number((((x.mark - x.oracle) / x.oracle) * 100).toFixed(4)) : null;
        return { mark_price: x.mark, oracle_price: x.oracle, basis_pct: b, basis_against: 'Hyperliquid oracle price (validators\' weighted median of spot venues)', funding_rate_8h: x.funding_1h != null ? x.funding_1h * 8 : null, funding_rate_raw: x.funding_1h, funding_interval_hours: 1 };
      }),
    };
  });
}

// ---- get_volatility ($0.01) — realized vol from daily klines
const rvAnn = (closes) => {
  const rets = [];
  for (let i = 1; i < closes.length; i++) rets.push(Math.log(closes[i] / closes[i - 1]));
  const rv = (arr) => { const m = arr.reduce((s, x) => s + x, 0) / arr.length; const v = arr.reduce((s, x) => s + (x - m) ** 2, 0) / arr.length; return Number((Math.sqrt(v) * Math.sqrt(365) * 100).toFixed(2)); };
  return { d7: rv(rets.slice(-7)), d30: rv(rets) };
};
async function getVolatility(p = {}) {
  const sym = normSym(p.symbol);
  return cached(`vol:${sym}`, 300_000, async () => {
    const r = await bybit(`/v5/market/kline?category=linear&symbol=${sym}&interval=D&limit=31`);
    const closes = r.list.map((k) => parseFloat(k[4])).reverse(); // API returns newest-first
    if (closes.length < 8) throw new Error(`not enough kline history for ${sym}`);
    const rets = [];
    for (let i = 1; i < closes.length; i++) rets.push(Math.log(closes[i] / closes[i - 1]));
    const rv = (arr) => {
      const m = arr.reduce((s, x) => s + x, 0) / arr.length;
      const v = arr.reduce((s, x) => s + (x - m) ** 2, 0) / arr.length;
      return Number((Math.sqrt(v) * Math.sqrt(365) * 100).toFixed(2));
    };
    const last = r.list[0];
    return {
      symbol: sym, source: 'bybit_daily_klines',
      realized_vol_7d_ann_pct: rv(rets.slice(-7)),
      realized_vol_30d_ann_pct: rv(rets),
      today_range_pct: Number((((parseFloat(last[2]) - parseFloat(last[3])) / parseFloat(last[4])) * 100).toFixed(2)),
      hyperliquid: await HLP.block(sym, async (c) => {
        const k = await HLP.candles(c, '1d', 32);
        const cl = k.map((x) => Number(x.c));
        if (cl.length < 8) return { available: false, reason: 'not enough daily candles' };
        const v = rvAnn(cl); const t = k[k.length - 1];
        return { realized_vol_7d_ann_pct: v.d7, realized_vol_30d_ann_pct: v.d30, today_range_pct: Number((((Number(t.h) - Number(t.l)) / Number(t.c)) * 100).toFixed(2)), basis: 'daily perp candles' };
      }),
    };
  });
}

// ---- get_funding_history ($0.005) — funding trend for a symbol
// Every row is converted with the interval THAT settlement closed, read from
// its spacing to the settlement before it. Bybit moves symbols between
// intervals -- measured 2026-09-28, CLUSDT's last 200 settlements mix 8h and
// 4h and AKEUSDT's mix 4h and 1h -- so one interval applied to every row would
// misstate part of the history. The window is fetched with one settlement to
// spare so its oldest row has a predecessor too (a second call at the venue's
// 200-row cap). A spacing that is not an interval in use -- a switch-over, a
// halt, or a symbol's first settlement -- leaves that row's interval unknown
// and its rate_8h null, never guessed.
// avg_rate_8h is time-weighted, 8 x sum(raw) / sum(interval hours): what 8
// hours held cost on average across the window. With one interval throughout
// it is exactly the plain mean of the rows, as it always was.
const VENUE_INTERVALS_H = [1, 2, 4, 8];
async function getFundingHistory(p = {}) {
  const sym = normSym(p.symbol);
  const limit = Math.min(Math.max(parseInt(p.limit) || 30, 1), 200);
  return cached(`fhist:${sym}:${limit}`, 300_000, async () => {
    const [r, ivs] = await Promise.all([
      bybit(`/v5/market/funding/history?category=linear&symbol=${sym}&limit=${Math.min(limit + 1, 200)}`),
      bybitIntervalMap(),
    ]);
    const ts = (x) => parseInt(x.fundingRateTimestamp);
    const settled = r.list.slice(0, limit); // newest first
    let before = r.list.length > limit ? r.list[limit] : null;
    if (!before && settled.length === 200) {
      const prev = await bybit(`/v5/market/funding/history?category=linear&symbol=${sym}&endTime=${ts(settled[199]) - 1}&limit=1`).catch(() => null);
      before = prev?.list?.[0] || null;
    }
    const inUse = new Set([...VENUE_INTERVALS_H, ivs[sym]].filter((h) => h != null));
    const rows = settled.map((x, i) => {
      const prior = settled[i + 1] || before;
      const gap = prior ? (ts(x) - ts(prior)) / 3_600_000 : null;
      const ih = inUse.has(gap) ? gap : null;
      const raw = n(x.fundingRate);
      return { ts: ts(x), rate_8h: to8h(raw, ih), ...rateBasis(raw, ih) };
    });
    const timed = rows.filter((x) => x.funding_interval_hours != null);
    const hours = timed.reduce((s, x) => s + x.funding_interval_hours, 0);
    const avg = hours ? (8 * timed.reduce((s, x) => s + x.funding_rate_raw, 0)) / hours : null;
    const untimed = rows.length - timed.length;
    return {
      symbol: sym, intervals: rows.length,
      avg_rate_8h: avg != null ? Number(avg.toFixed(8)) : null,
      avg_annualized_pct: avg != null ? Number((avg * 3 * 365 * 100).toFixed(2)) : null,
      positive_share_pct: rows.length ? Math.round((rows.filter((x) => x.funding_rate_raw > 0).length / rows.length) * 100) : null,
      ...(untimed ? { funding_interval_note: `${untimed} of ${rows.length} settlements had no readable interval (a switch-over, a halt or a first settlement), so their rate_8h is null and they are left out of avg_rate_8h` } : {}),
      history: rows,
      // Hyperliquid settles hourly: the same number of settlements covers fewer hours
      hyperliquid: await HLP.block(sym, async (c) => {
        const h = (await HLP.fundingHistory(c, limit)).slice(-limit).reverse();
        const raw = h.map((x) => Number(x.fundingRate));
        const avg = raw.length ? (8 * raw.reduce((s, x) => s + x, 0)) / raw.length : null;
        return { intervals: h.length, funding_interval_hours: 1,
          avg_rate_8h: avg != null ? Number(avg.toFixed(8)) : null, avg_annualized_pct: avg != null ? Number((avg * 3 * 365 * 100).toFixed(2)) : null,
          positive_share_pct: raw.length ? Math.round((raw.filter((x) => x > 0).length / raw.length) * 100) : null,
          history: h.map((x) => ({ ts: x.time, rate_8h: Number(x.fundingRate) * 8, funding_rate_raw: Number(x.fundingRate), funding_interval_hours: 1 })) };
      }),
    };
  });
}

// ---- get_top_movers ($0.01) — 24h gainers/losers with liquidity floor
async function getTopMovers(p = {}) {
  const limit = Math.min(Math.max(parseInt(p.limit) || 10, 1), 25);
  const minTurn = Number(p.min_turnover_usd) || 1_000_000;
  const [tickers, ivs] = await Promise.all([allTickers(), bybitIntervalMap()]);
  const list = tickers
    .filter((t) => n(t.turnover24h) >= minTurn)
    .map((t) => {
      const raw = n(t.fundingRate), ih = ivs[t.symbol] ?? null;
      return {
        symbol: t.symbol,
        price: n(t.lastPrice),
        change_24h_pct: Number((n(t.price24hPcnt) * 100).toFixed(2)),
        turnover_24h_usd: Math.round(n(t.turnover24h)),
        funding_rate_8h: to8h(raw, ih),
        ...rateBasis(raw, ih),
      };
    })
    .sort((a, b) => b.change_24h_pct - a.change_24h_pct);
  const gainers = list.slice(0, limit), losers = list.slice(-limit).reverse();
  const hl = await HLP.universe({ minVolumeUsd: minTurn }).then((rows) => rows.filter((r) => r.change_24h_pct != null).sort((a, b) => b.change_24h_pct - a.change_24h_pct), () => null);
  return {
    source: 'bybit_linear_universe', universe_size: list.length, min_turnover_usd: minTurn,
    gainers,
    losers,
    hyperliquid: hl ? { universe_size: hl.length, gainers: hl.slice(0, limit), losers: hl.slice(-limit).reverse(), source: HLP.SRC } : { available: false, reason: 'Hyperliquid read failed', source: HLP.SRC },
    ...([...gainers, ...losers].some((x) => x.funding_rate_raw != null && x.funding_interval_hours == null) ? { funding_interval_note: ROWS_INTERVAL_UNKNOWN } : {}),
  };
}

module.exports = {
  getFundingCross, getFundingExtremes, getOpenInterest, getOiSpikeScan,
  getLongShort, getBasis, getVolatility, getFundingHistory, getTopMovers,
  _normSym: normSym,
  _spotCandidates: spotCandidates,
  _to8h: to8h,
  _annualizedPct: annualizedPct,
};

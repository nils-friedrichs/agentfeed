// tools/hlwhales.js — /api/hl-whales: what the largest Hyperliquid accounts hold in perps (R4, 2026-10-12).
//
// WHALES. The largest accounts by account value, streamed out of Hyperliquid's public
// leaderboard (stats-data.hyperliquid.xyz, ~40 MB: read as a stream and scanned for address
// and value only, never parsed whole) and refreshed hourly. Account value there includes spot
// and vault equity, so many of the largest hold no perps; only accounts with open perp
// positions are counted.
//
// POSITIONS. clearinghouseState per whale (Hyperliquid info API, weight 2 each; at most
// TOP_N per refresh, 16 at a time) and metaAndAssetCtxs for mark prices, refreshed on demand
// and cached 5 minutes. No collector: a request that finds the cache older than 5 minutes
// refreshes it (a few seconds); a refresh that fails leaves the cache to age, and data older
// than 5 minutes answers 503 (never settled).
//
// SOLD. Aggregates we compute (net long/short USD per coin, counts, size-weighted entries,
// liquidation distance and liquidation clusters by price band, uPnL) and, for one coin, the
// top positions as Hyperliquid's public account state shows them.
'use strict';

const LB_URL = () => process.env.HL_LEADERBOARD || 'https://stats-data.hyperliquid.xyz/Mainnet/leaderboard';
const INFO = () => process.env.HL_API || 'https://api.hyperliquid.xyz/info';
const TOP_N = Number(process.env.HL_WHALES_TOP || 250);
const CACHE_MS = 5 * 60 * 1000;
const LIST_MS = 60 * 60 * 1000;

const bad = (msg) => Object.assign(new Error(msg), { kind: 'bad_request' });
const unavailable = (msg) => Object.assign(new Error(msg), { status: 503 });
const num = (v) => (v == null || v === '' ? null : Number(v));
const r2 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);

let whaleList = null; // { at, accounts: [{ address, account_value }] }
let snap = null;      // { at, marks, positions: [...], scanned, withPositions }
let inflight = null;

async function readLeaderboard(fetchImpl = fetch) {
  const res = await fetchImpl(LB_URL(), { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`leaderboard HTTP ${res.status}`);
  const re = /"ethAddress":\s*"(0x[0-9a-f]{40})",\s*"accountValue":\s*"([0-9.eE+\-]+)"/g;
  const dec = new TextDecoder();
  const top = [];
  let buf = '';
  let rows = 0;
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    re.lastIndex = 0;
    let m; let last = 0;
    while ((m = re.exec(buf))) {
      rows++; last = re.lastIndex;
      const v = Number(m[2]);
      if (!Number.isFinite(v)) continue;
      if (top.length < TOP_N || v > top[top.length - 1].account_value) {
        top.push({ address: m[1], account_value: v });
        top.sort((a, b) => b.account_value - a.account_value);
        if (top.length > TOP_N) top.pop();
      }
    }
    buf = buf.slice(Math.max(last, buf.length - 400));
  }
  if (!top.length) throw new Error('leaderboard: no accounts parsed');
  return { at: Date.now(), accounts: top, rows };
}

async function info(body, fetchImpl = fetch) {
  const r = await fetchImpl(INFO(), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`hyperliquid info HTTP ${r.status}`);
  return r.json();
}

async function refresh(fetchImpl = fetch) {
  if (!whaleList || Date.now() - whaleList.at > LIST_MS) whaleList = await readLeaderboard(fetchImpl);
  const [meta, ctxs] = await info({ type: 'metaAndAssetCtxs' }, fetchImpl);
  const marks = {};
  meta.universe.forEach((u, i) => { const m = num(ctxs[i] && ctxs[i].markPx); if (m) marks[u.name] = m; });
  const positions = [];
  let scanned = 0; let withPositions = 0; let failed = 0;
  const list = whaleList.accounts;
  for (let i = 0; i < list.length; i += 16) {
    const part = await Promise.all(list.slice(i, i + 16).map((w) => info({ type: 'clearinghouseState', user: w.address }, fetchImpl).then((s) => ({ w, s })).catch(() => ({ w, s: null }))));
    for (const { w, s } of part) {
      if (!s) { failed++; continue; }
      scanned++;
      const aps = (s.assetPositions || []).filter((a) => a && a.position && Number(a.position.szi) !== 0);
      if (!aps.length) continue;
      withPositions++;
      const equity = num(s.marginSummary && s.marginSummary.accountValue);
      for (const ap of aps) {
        const p = ap.position;
        const szi = Number(p.szi);
        const mark = marks[p.coin] || null;
        const liq = num(p.liquidationPx);
        positions.push({
          address: w.address, coin: p.coin, side: szi > 0 ? 'long' : 'short', size: Math.abs(szi),
          notional_usd: Math.abs(num(p.positionValue) || 0), entry_px: num(p.entryPx), mark_px: mark,
          liquidation_px: liq, liq_distance_pct: liq && mark ? Math.abs(mark - liq) / mark * 100 : null,
          unrealized_pnl_usd: num(p.unrealizedPnl), leverage: p.leverage ? num(p.leverage.value) : null, margin_mode: p.leverage ? p.leverage.type : null,
          account_equity_usd: equity,
        });
      }
    }
  }
  if (failed > list.length / 2) throw new Error(`hyperliquid info: ${failed} of ${list.length} account reads failed`);
  snap = { at: Date.now(), marks, positions, scanned, withPositions, failed, listAt: whaleList.at, listRows: whaleList.rows };
  return snap;
}

async function current(fetchImpl) {
  if (snap && Date.now() - snap.at < CACHE_MS) return snap;
  if (!inflight) inflight = refresh(fetchImpl).finally(() => { inflight = null; });
  try { return await inflight; } catch (e) {
    if (snap && Date.now() - snap.at < CACHE_MS) return snap;
    throw unavailable(`Hyperliquid whale data unavailable (${String(e.message).slice(0, 120)}). Not charged.`);
  }
}

function side(positions, s) {
  const xs = positions.filter((p) => p.side === s);
  const usd = xs.reduce((a, p) => a + p.notional_usd, 0);
  const sz = xs.reduce((a, p) => a + p.size, 0);
  const withLiq = xs.filter((p) => p.liq_distance_pct != null);
  const wLiq = withLiq.reduce((a, p) => a + p.notional_usd, 0);
  return {
    accounts: new Set(xs.map((p) => p.address)).size, notional_usd: r2(usd),
    avg_entry_px: sz ? r2(xs.reduce((a, p) => a + (p.entry_px || 0) * p.size, 0) / sz) : null,
    avg_liq_distance_pct: wLiq ? r2(withLiq.reduce((a, p) => a + p.liq_distance_pct * p.notional_usd, 0) / wLiq) : null,
    within_10pct_of_liq_usd: r2(withLiq.filter((p) => p.liq_distance_pct <= 10).reduce((a, p) => a + p.notional_usd, 0)),
    unrealized_pnl_usd: r2(xs.reduce((a, p) => a + (p.unrealized_pnl_usd || 0), 0)),
  };
}

function coinSummary(coin, ps, mark) {
  const L = side(ps, 'long'); const S = side(ps, 'short');
  return { coin, mark_px: mark, net_usd: r2((L.notional_usd || 0) - (S.notional_usd || 0)), long: L, short: S };
}

// liquidation notional by price band, +-50% around the mark, 20 bands of 5%
function clusters(ps, mark) {
  if (!mark) return [];
  const out = [];
  for (let b = -10; b < 10; b++) {
    const lo = mark * (1 + b * 0.05); const hi = mark * (1 + (b + 1) * 0.05);
    const inBand = ps.filter((p) => p.liquidation_px != null && p.liquidation_px >= lo && p.liquidation_px < hi);
    if (!inBand.length) continue;
    out.push({ from_px: r2(lo), to_px: r2(hi), longs_liq_usd: r2(inBand.filter((p) => p.side === 'long').reduce((a, p) => a + p.notional_usd, 0)), shorts_liq_usd: r2(inBand.filter((p) => p.side === 'short').reduce((a, p) => a + p.notional_usd, 0)) });
  }
  return out;
}

async function getHlWhales(p = {}, { fetchImpl = fetch } = {}) {
  const coinArg = p.coin == null || p.coin === '' ? null : String(p.coin).trim().toUpperCase().replace(/(USDT|-PERP|PERP)$/, '');
  if (coinArg && !/^[A-Z0-9:]{1,20}$/.test(coinArg)) throw bad('coin must be a Hyperliquid perp name such as BTC, ETH, SOL or HYPE');
  const top = p.top == null || p.top === '' ? 20 : Number(p.top);
  if (!Number.isInteger(top) || top < 1 || top > 50) throw bad('top must be an integer from 1 to 50');
  const s = await current(fetchImpl);
  const base = {
    as_of: new Date(s.at).toISOString(), accounts_scanned: s.scanned, accounts_with_positions: s.withPositions,
    whale_list: { size: TOP_N, from: 'largest accounts by account value on the Hyperliquid leaderboard', of_rows: s.listRows, refreshed_at: new Date(s.listAt).toISOString() },
    method: 'Open perp positions of the largest Hyperliquid accounts, read from Hyperliquid\'s public account state every 5 minutes at most. Net, notional and uPnL are sums over those accounts; entries are size-weighted; liquidation distance is |mark - liquidation price| / mark, notional-weighted. Accounts are public addresses as Hyperliquid publishes them.',
    sources: ['Hyperliquid info API (clearinghouseState, metaAndAssetCtxs)', 'Hyperliquid leaderboard (stats-data.hyperliquid.xyz)'],
  };
  if (coinArg) {
    const ps = s.positions.filter((x) => x.coin === coinArg);
    if (!s.marks[coinArg]) throw bad(`unknown Hyperliquid perp ${coinArg}`);
    return {
      ...base, coin: coinArg, ...coinSummary(coinArg, ps, s.marks[coinArg]),
      liquidation_clusters: clusters(ps, s.marks[coinArg]),
      top_positions: [...ps].sort((a, b) => b.notional_usd - a.notional_usd).slice(0, top).map((x) => ({ address: x.address, side: x.side, size: x.size, notional_usd: r2(x.notional_usd), entry_px: x.entry_px, liquidation_px: x.liquidation_px, liq_distance_pct: r2(x.liq_distance_pct), unrealized_pnl_usd: r2(x.unrealized_pnl_usd), leverage: x.leverage, margin_mode: x.margin_mode })),
    };
  }
  const byCoin = {};
  for (const x of s.positions) (byCoin[x.coin] ||= []).push(x);
  const coins = Object.entries(byCoin).map(([c, ps]) => coinSummary(c, ps, s.marks[c] || null))
    .sort((a, b) => ((b.long.notional_usd || 0) + (b.short.notional_usd || 0)) - ((a.long.notional_usd || 0) + (a.short.notional_usd || 0))).slice(0, top);
  return { ...base, coins };
}

module.exports = { getHlWhales, _readLeaderboard: readLeaderboard, _clusters: clusters, _side: side, _reset: () => { whaleList = null; snap = null; inflight = null; } };

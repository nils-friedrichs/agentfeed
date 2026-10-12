'use strict';
// R4: /api/hl-whales against a stub Hyperliquid (leaderboard stream + info API).
const test = require('node:test');
const assert = require('node:assert');

function stubFetch({ failInfo = false } = {}) {
  const lb = JSON.stringify({ leaderboardRows: [
    { ethAddress: '0x' + 'a'.repeat(40), accountValue: '50000000.5', windowPerformances: [], prize: 0, displayName: null },
    { ethAddress: '0x' + 'b'.repeat(40), accountValue: '30000000', windowPerformances: [], prize: 0, displayName: null },
    { ethAddress: '0x' + 'c'.repeat(40), accountValue: '1000', windowPerformances: [], prize: 0, displayName: null },
  ] }, null, 2);
  const state = {
    ['0x' + 'a'.repeat(40)]: { marginSummary: { accountValue: '1000000' }, assetPositions: [
      { position: { coin: 'BTC', szi: '10', entryPx: '80000', positionValue: '850000', unrealizedPnl: '50000', liquidationPx: '60000', leverage: { type: 'cross', value: 5 } } },
      { position: { coin: 'ETH', szi: '-100', entryPx: '2600', positionValue: '255000', unrealizedPnl: '5000', liquidationPx: '3000', leverage: { type: 'isolated', value: 3 } } }] },
    ['0x' + 'b'.repeat(40)]: { marginSummary: { accountValue: '500000' }, assetPositions: [
      { position: { coin: 'BTC', szi: '-2', entryPx: '90000', positionValue: '170000', unrealizedPnl: '10000', liquidationPx: '92000', leverage: { type: 'cross', value: 10 } } }] },
    ['0x' + 'c'.repeat(40)]: { marginSummary: { accountValue: '1000' }, assetPositions: [] },
  };
  return async (url, init) => {
    if (String(url).includes('leaderboard')) {
      const enc = new TextEncoder().encode(lb);
      const body = new ReadableStream({ start(c) { for (let i = 0; i < enc.length; i += 37) c.enqueue(enc.slice(i, i + 37)); c.close(); } });
      return new Response(body, { status: 200 });
    }
    const b = JSON.parse(init.body);
    if (failInfo) return new Response('down', { status: 502 });
    if (b.type === 'metaAndAssetCtxs') return Response.json([{ universe: [{ name: 'BTC' }, { name: 'ETH' }] }, [{ markPx: '85000' }, { markPx: '2550' }]]);
    return Response.json(state[b.user] || { assetPositions: [] });
  };
}

test('hl-whales: streamed leaderboard, per-coin aggregates, top positions, clusters', async () => {
  const W = require('../tools/hlwhales'); W._reset();
  const all = await W.getHlWhales({}, { fetchImpl: stubFetch() });
  assert.equal(all.accounts_scanned, 3); assert.equal(all.accounts_with_positions, 2);
  const btc = all.coins.find((c) => c.coin === 'BTC');
  assert.equal(btc.long.notional_usd, 850000); assert.equal(btc.short.notional_usd, 170000); assert.equal(btc.net_usd, 680000);
  assert.equal(btc.short.within_10pct_of_liq_usd, 170000, 'a short liquidated at 92000 with mark 85000 is 8.2% away');
  const one = await W.getHlWhales({ coin: 'btcusdt', top: 1 }, { fetchImpl: stubFetch() });
  assert.equal(one.coin, 'BTC'); assert.equal(one.top_positions.length, 1); assert.equal(one.top_positions[0].side, 'long');
  assert.ok(one.liquidation_clusters.some((c) => c.shorts_liq_usd === 170000));
});

test('hl-whales: bad input is 400; a dead upstream with no fresh cache is 503', async () => {
  const W = require('../tools/hlwhales'); W._reset();
  await assert.rejects(W.getHlWhales({ coin: '!!' }, { fetchImpl: stubFetch() }), (e) => e.kind === 'bad_request');
  await assert.rejects(W.getHlWhales({ top: 99 }, { fetchImpl: stubFetch() }), (e) => e.kind === 'bad_request');
  W._reset();
  await assert.rejects(W.getHlWhales({}, { fetchImpl: stubFetch({ failInfo: true }) }), (e) => e.status === 503);
});

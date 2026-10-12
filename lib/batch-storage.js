// lib/batch-storage.js — durable ChannelStorage for @x402/evm batch-settlement (R5 A1).
//
// The batch server keeps, per payment channel, the payer's latest signed voucher and the
// amount we have actually charged (chargedCumulativeAmount). Claims redeem exactly that
// charged amount, so losing this table loses money we earned. @x402/evm ships an in-memory
// store (gone on restart) and a file store; this one lives in agentfeed.db, survives a
// restart, and is shared by the server and the claim cron (ops/batch-claim.js).
//
// Atomicity: ChannelStorage.updateChannel must not interleave a read and a write across
// every process that shares the backend. better-sqlite3 runs the callback synchronously
// inside BEGIN IMMEDIATE, which takes SQLite's write lock before the read, so the server
// and the cron serialize on it; busy_timeout makes the loser wait instead of failing.
'use strict';

function createSqliteChannelStorage(db, { network, table = 'batch_channels' } = {}) {
  if (!network) throw new Error('batch storage: network is required');
  if (!/^[a-z_]+$/.test(table)) throw new Error('batch storage: bad table name');
  db.pragma('busy_timeout = 5000');
  db.exec(`CREATE TABLE IF NOT EXISTS ${table} (
    network    TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    data       TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (network, channel_id))`);
  const sel = db.prepare(`SELECT data FROM ${table} WHERE network = ? AND channel_id = ?`);
  const all = db.prepare(`SELECT data FROM ${table} WHERE network = ? ORDER BY channel_id`);
  const upsert = db.prepare(`INSERT INTO ${table} (network, channel_id, data, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(network, channel_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`);
  const del = db.prepare(`DELETE FROM ${table} WHERE network = ? AND channel_id = ?`);
  const key = (id) => String(id).toLowerCase();
  const read = (id) => {
    const r = sel.get(network, key(id));
    return r ? JSON.parse(r.data) : undefined;
  };
  const update = db.transaction((id, fn) => {
    const current = read(id);
    const next = fn(current);
    if (next === undefined) {
      if (current === undefined) return { channel: undefined, status: 'unchanged' };
      del.run(network, key(id));
      return { channel: undefined, status: 'deleted' };
    }
    if (next === current) return { channel: current, status: 'unchanged' };
    upsert.run(network, key(id), JSON.stringify(next), Date.now());
    return { channel: next, status: 'updated' };
  });
  return {
    async get(channelId) { return read(channelId); },
    async list() { return all.all(network).map((r) => JSON.parse(r.data)); },
    async updateChannel(channelId, fn) { return update.immediate(channelId, fn); },
  };
}

module.exports = { createSqliteChannelStorage };

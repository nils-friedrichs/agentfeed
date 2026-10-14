// test/helpers/claim-loop.js — a second PROCESS that claims from the same SQLite file the server is writing, the way the cron does.
//   node claim-loop.js <db file> <duration ms>      prints "claimed <n> batches in <m> attempts"
// Used by test/batch-resync.test.js to prove a claim run, running at the same time as a buyer's calls, never disturbs an open channel.
'use strict';
const Database = require('better-sqlite3');
const { BatchSettlementEvmScheme } = require('@x402/evm/batch-settlement/server');
const { privateKeyToAccount, generatePrivateKey } = require('viem/accounts');
const { createSqliteChannelStorage } = require('../../lib/batch-storage');

const NET = 'eip155:8453';
const RECEIVER = '0x22DB3A9686EE5261e7Bf3ed4f91277232E8076e6';
const [dbFile, durationMs] = [process.argv[2], Number(process.argv[3] || 1500)];
const authorizer = privateKeyToAccount(generatePrivateKey());
const facilitator = { // a facilitator that accepts every claim and settle (CDP's minimum is not what is under test here)
  async settle(payload) { return { success: true, transaction: '0x' + 'c1'.repeat(32), network: NET, payer: RECEIVER, type: payload.payload.type }; },
};

(async () => {
  const db = new Database(dbFile);
  const storage = createSqliteChannelStorage(db, { network: NET });
  const scheme = new BatchSettlementEvmScheme(RECEIVER, { receiverAuthorizerSigner: authorizer, withdrawDelay: 86400, storage });
  const mgr = scheme.createChannelManager(facilitator, NET);
  const until = Date.now() + durationMs;
  let attempts = 0, batches = 0;
  while (Date.now() < until) {
    attempts++;
    try { batches += (await mgr.claim({ maxClaimsPerBatch: 100 })).length; } catch (e) { console.log(`claim error: ${e.message}`); }
    await new Promise((r) => setTimeout(r, 10));
  }
  console.log(`claimed ${batches} batches in ${attempts} attempts`);
})();

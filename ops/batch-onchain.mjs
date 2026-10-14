// ops/batch-onchain.mjs — read-only: every Base batch-settlement channel in agentfeed.db as the chain sees it, and the receiver's
// claimed / settled totals (R8). Writes nothing, signs nothing, holds no key.
//   cd /opt/agentfeed && node ops/batch-onchain.mjs            RPC=<url> to use another Base endpoint
// Per channel: the deposit still in it, what has been claimed out of it, and a payer's pending timed withdrawal (amount, start).
// For the receiver: totalClaimed (vouchers redeemed to its bucket), totalSettled (swept to its address) and the difference, the
// claimed-but-unsettled value ops/batch-claim.js settles on its next run.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { createPublicClient, http, parseAbi } from 'viem';
import { base } from 'viem/chains';
import { BATCH_SETTLEMENT_ADDRESS } from '@x402/evm';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const db = new Database(process.env.AGENTFEED_DB || path.join(ROOT, 'agentfeed.db'), { readonly: true });
const rows = db.prepare("SELECT channel_id, data FROM batch_channels WHERE network = 'eip155:8453' ORDER BY updated_at").all();
const abi = parseAbi([
  'function channels(bytes32 channelId) view returns (uint128 balance, uint128 totalClaimed)',
  'function receivers(address receiver, address token) view returns (uint128 totalClaimed, uint128 totalSettled)',
  'function pendingWithdrawals(bytes32 channelId) view returns (uint128 amount, uint40 initiatedAt)',
]);
const client = createPublicClient({ chain: base, transport: http(process.env.RPC || undefined) });
const usd = (x) => Number(x) / 1e6;
// the public Base endpoints answer "request limit reached" now and then: a few patient retries
const read = async (args) => {
  for (let i = 0; ; i++) {
    try { return await client.readContract({ address: BATCH_SETTLEMENT_ADDRESS, abi, ...args }); } catch (e) { if (i >= 3) throw e; await new Promise((r) => setTimeout(r, 1500 * (i + 1))); }
  }
};
if (!rows.length) console.log('no Base channels in batch_channels');
const seen = new Set();
for (const r of rows) {
  const d = JSON.parse(r.data);
  const [balance, claimed] = await read({ functionName: 'channels', args: [r.channel_id] });
  const [wAmount, wAt] = await read({ functionName: 'pendingWithdrawals', args: [r.channel_id] });
  console.log(`channel ${r.channel_id.slice(0, 12)}…  payer ${d.channelConfig.payer}`);
  console.log(`  chain:  deposit ${usd(balance)} USDC, claimed ${usd(claimed)}, still usable ${usd(balance - claimed)} | withdrawal ${wAt > 0 ? `PENDING ${usd(wAmount)} since ${new Date(Number(wAt) * 1000).toISOString()}` : 'none'}`);
  console.log(`  local:  charged ${usd(d.chargedCumulativeAmount)}, claimed ${usd(d.totalClaimed)}, unclaimed ${usd(BigInt(d.chargedCumulativeAmount) - BigInt(d.totalClaimed))}`);
  const key = `${d.channelConfig.receiver}:${d.channelConfig.token}`;
  if (seen.has(key)) continue;
  seen.add(key);
  const [rc, rs] = await read({ functionName: 'receivers', args: [d.channelConfig.receiver, d.channelConfig.token] });
  console.log(`receiver ${d.channelConfig.receiver}: claimed ${usd(rc)} USDC, settled ${usd(rs)}, claimed-but-unsettled ${usd(rc - rs)}`);
}

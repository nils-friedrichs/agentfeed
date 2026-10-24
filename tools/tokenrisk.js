// tools/tokenrisk.js — token risk signals: authorities + holder concentration.
// Standard Solana RPC only since R5 C4 (lib/solrpc.js mintInfo, no DAS).
// v1 honest scope: no LP-lock or honeypot claims. Concentration fails soft on
// mega-holder tokens (USDC-scale) where getTokenLargestAccounts times out.
const SR = require('../lib/solrpc');   // every Solana read: the failover endpoint list (R20)

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// caller-input failures carry kind:'bad_request' so server.js logs them apart
// from real service failures; an unmarked throw stays status 'error'
const badRequest = (msg) => Object.assign(new Error(msg), { kind: 'bad_request' });

const rpc = SR.rpc;

async function getTokenRisk(mint) {
  if (mint == null || mint === '') {
    throw badRequest('missing required parameter: mint — an SPL mint address (base58), e.g. mint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v (USDC)');
  }
  if (!BASE58_RE.test(mint)) throw badRequest('invalid mint address');

  const [mi, largestRes] = await Promise.all([
    SR.mintInfo(mint),
    rpc('getTokenLargestAccounts', [mint])
      .then(v => ({ ok: true, v }))
      // Only the node's own answer ("too many accounts", a JSON-RPC error) means "this mint cannot be ranked". No answer at all (every endpoint rate
      // limited, out of credits or down) is an outage, and a paid answer must not read as if the mint were too big: that throws, a 503, not charged.
      .catch(e => { if (!e.rpcError) throw e; return { ok: false, err: e.message }; }),
  ]);

  const meta = mi.metadata || {};
  const supply = mi.supply;

  const accounts = largestRes.ok
    ? (largestRes.v?.value || []).slice(0, 10).map(a => ({
        address: a.address,
        amount: parseFloat(a.uiAmountString ?? a.uiAmount ?? 0),
      }))
    : [];
  const top10 = accounts.reduce((s, a) => s + a.amount, 0);
  const top10_pct = largestRes.ok && supply
    ? Math.round((top10 / supply) * 10000) / 100 : null;
  const top1_pct = largestRes.ok && supply && accounts[0]
    ? Math.round((accounts[0].amount / supply) * 10000) / 100 : null;

  const mintAuth = mi.mint_authority;
  const freezeAuth = mi.freeze_authority;

  const flags = [];
  if (mintAuth) flags.push('mint_authority_active: supply can be inflated');
  if (freezeAuth) flags.push('freeze_authority_active: wallets can be frozen');
  if (top10_pct != null && top10_pct > 50) flags.push('high_concentration: top 10 accounts hold >50% of supply');

  return {
    mint,
    name: meta.name || null,
    symbol: meta.symbol || null,
    supply,
    program: mi.program,
    authorities: {
      mint_authority: mintAuth,       // null = revoked (good)
      freeze_authority: freezeAuth,   // null = revoked (good)
    },
    concentration: {
      top1_pct,
      top10_pct,
      note: largestRes.ok
        ? 'token accounts, not unique owners — pools/exchanges may be included'
        : 'unavailable for this mint (too many holders for RPC scan — typical for major tokens)',
      top_accounts: accounts.slice(0, 5),
    },
    risk_flags: flags,
    risk_flag_count: flags.length,
    source: 'Solana RPC: the mint account, its metadata account and getTokenLargestAccounts',
  };
}

module.exports = { getTokenRisk };

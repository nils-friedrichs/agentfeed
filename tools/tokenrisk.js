// tools/tokenrisk.js — token risk signals: authorities + holder concentration.
// Standard Solana RPC only since R5 C4 (lib/solrpc.js mintInfo, no DAS).
// v1 honest scope: no LP-lock or honeypot claims. Concentration fails soft on
// mega-holder tokens (USDC-scale) where getTokenLargestAccounts times out.
const HELIUS_URL = () =>
  `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// caller-input failures carry kind:'bad_request' so server.js logs them apart
// from real service failures; an unmarked throw stays status 'error'
const badRequest = (msg) => Object.assign(new Error(msg), { kind: 'bad_request' });

async function rpc(method, params) {
  const res = await fetch(HELIUS_URL(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'agentfeed', method, params }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`helius ${res.status}`);
  const j = await res.json();
  if (j.error) throw new Error(`helius rpc: ${j.error.message}`);
  return j.result;
}

async function getTokenRisk(mint) {
  if (mint == null || mint === '') {
    throw badRequest('missing required parameter: mint — an SPL mint address (base58), e.g. mint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v (USDC)');
  }
  if (!BASE58_RE.test(mint)) throw badRequest('invalid mint address');

  const [mi, largestRes] = await Promise.all([
    require('../lib/solrpc').mintInfo(mint),
    rpc('getTokenLargestAccounts', [mint])
      .then(v => ({ ok: true, v }))
      .catch(e => ({ ok: false, err: e.message })),
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

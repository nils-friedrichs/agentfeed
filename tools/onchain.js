// tools/onchain.js — wallet holdings (Helius DAS getAssetsByOwner) + token metadata (standard RPC since R5 C4).
// R6 D4 (13 Oct 2026): wallet-holdings returns balances and on-chain token metadata only. Helius's own token
// prices (price_usd, value_usd, native total_price) are not passed on; native SOL is valued with OUR on-chain
// SOL price (tools/prices.js) and the answer says so.
// Premium tools ($0.005-0.008 in Session 2). Key from .env only.
const HELIUS_URL = () =>
  `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;

const { getPrice } = require('./prices');

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

// getAssetsByOwner — fungibles + NFTs summary for a wallet
async function getWalletHoldings(wallet, { priceFn = getPrice } = {}) {
  if (wallet == null || wallet === '') {
    throw badRequest('missing required parameter: wallet — a Solana address (base58), e.g. wallet=4a8o45skRPcyjAdyR8yES215Swvh8uTpZD6KLarhxCJ7');
  }
  if (!BASE58_RE.test(wallet)) throw badRequest('invalid wallet address');

  const result = await rpc('getAssetsByOwner', {
    ownerAddress: wallet,
    page: 1,
    limit: 100,
    displayOptions: { showFungible: true, showNativeBalance: true },
  });

  const items = result?.items || [];
  const fungibles = [];
  let nft_count = 0;

  for (const a of items) {
    if (a.interface === 'FungibleToken' || a.interface === 'FungibleAsset') {
      const info = a.token_info || {};
      fungibles.push({
        mint: a.id,
        symbol: info.symbol || a.content?.metadata?.symbol || null,
        amount: info.balance != null && info.decimals != null
          ? info.balance / Math.pow(10, info.decimals)
          : null,
      });
    } else {
      nft_count++;
    }
  }

  const nativeSol = result?.nativeBalance?.lamports != null ? result.nativeBalance.lamports / 1e9 : null;
  // Only native SOL is valued, and only with our own price: the median of the two deepest SOL/USDC pools read
  // from Solana chain state. If that price cannot be read the balance is still returned and the value is null
  // with the reason, never a number from somewhere else.
  let nativeSolUsd = null, nativeSolUsdSource;
  if (nativeSol != null) {
    try {
      const q = await priceFn('SOL');
      nativeSolUsd = Math.round(nativeSol * q.price * 100) / 100;
      nativeSolUsdSource = `native_sol x ${q.price} USD per SOL, AgentFeed's own price: ${q.source}`;
    } catch (e) {
      nativeSolUsdSource = 'unavailable: the on-chain SOL price could not be read just now (balances are unaffected)';
    }
  }

  return {
    wallet,
    native_sol: nativeSol,
    native_sol_usd: nativeSolUsd,
    ...(nativeSolUsdSource ? { native_sol_usd_source: nativeSolUsdSource } : {}),
    fungible_tokens: fungibles,
    nft_count,
    total_items: result?.total ?? items.length,
    source: 'helius-das (balances and on-chain token metadata)',
    note: 'SPL token prices and values are not included. Only native SOL is valued, with AgentFeed\'s on-chain SOL price (native_sol_usd_source).',
  };
}

// metadata for one mint, from the mint account and its metadata account (R5 C4: standard RPC,
// no DAS). price_usd is gone: it was Helius's own price, not chain state.
async function getTokenMetadata(mint) {
  if (mint == null || mint === '') {
    throw badRequest('missing required parameter: mint — an SPL mint address (base58), e.g. mint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v (USDC)');
  }
  if (!BASE58_RE.test(mint)) throw badRequest('invalid mint address');

  const m = await require('../lib/solrpc').mintInfo(mint);
  const meta = m.metadata || {};
  return {
    mint,
    name: meta.name || null,
    symbol: meta.symbol || null,
    uri: meta.uri || null,
    program: m.program,
    decimals: m.decimals,
    supply: m.supply,
    supply_raw: m.supply_raw,
    mint_authority: m.mint_authority,
    freeze_authority: m.freeze_authority,
    mutable: m.metadata ? meta.mutable : null,
    extensions: m.extensions,
    metadata_source: meta.source || null,
    source: 'Solana RPC: the mint account and its metadata account',
  };
}

module.exports = { getWalletHoldings, getTokenMetadata };

// tools/onchain.js — wallet holdings and token metadata, both from standard Solana RPC.
// R7 R3 (13 Oct 2026): wallet-holdings no longer asks Helius DAS (getAssetsByOwner). Helius's terms allow integrating
// its services but not providing them to third parties (Terms §3.2(ii), docs/SOURCES.md); a DAS indexer answer is
// exactly that. It now reads chain state with methods every Solana RPC serves: getBalance, getTokenAccountsByOwner
// for both token programs, and the on-chain metadata (Metaplex metadata account or Token-2022 metadata extension).
// R6 D4: balances and on-chain token metadata only; native SOL is valued with OUR on-chain SOL price (tools/prices.js).
// Premium tools ($0.005-0.008 in Session 2).
const { getPrice } = require('./prices');
const solrpc = require('../lib/solrpc');

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const MAX_FUNGIBLES = 100; // as before: the answer lists up to 100 fungible tokens and counts the rest

// caller-input failures carry kind:'bad_request' so server.js logs them apart
// from real service failures; an unmarked throw stays status 'error'
const badRequest = (msg) => Object.assign(new Error(msg), { kind: 'bad_request' });

/** every non-zero token account of both token programs (jsonParsed): [{ mint, amount (UI), decimals, program }] */
async function tokenAccounts(wallet) {
  const out = [];
  for (const [programId, program] of [[solrpc.PROGRAMS.TOKEN, 'spl-token'], [solrpc.PROGRAMS.TOKEN_2022, 'spl-token-2022']]) {
    const r = await solrpc.rpc('getTokenAccountsByOwner', [wallet, { programId }, { encoding: 'jsonParsed', commitment: 'confirmed' }], { timeoutMs: 20_000 });
    for (const a of (r && r.value) || []) {
      const t = a.account && a.account.data && a.account.data.parsed && a.account.data.parsed.info;
      if (!t || !t.tokenAmount || t.tokenAmount.amount === '0') continue;
      out.push({ mint: t.mint, amount: t.tokenAmount.uiAmount ?? Number(t.tokenAmount.amount) / 10 ** t.tokenAmount.decimals, raw: t.tokenAmount.amount, decimals: t.tokenAmount.decimals, program });
    }
  }
  return out;
}

async function getWalletHoldings(wallet, { priceFn = getPrice, accountsFn = tokenAccounts, metadataFn = solrpc.metadataMap, balanceFn = null } = {}) {
  if (wallet == null || wallet === '') {
    throw badRequest('missing required parameter: wallet — a Solana address (base58), e.g. wallet=4a8o45skRPcyjAdyR8yES215Swvh8uTpZD6KLarhxCJ7');
  }
  if (!BASE58_RE.test(wallet)) throw badRequest('invalid wallet address');

  const [bal, accounts] = await Promise.all([
    balanceFn ? balanceFn(wallet) : solrpc.rpc('getBalance', [wallet, { commitment: 'confirmed' }]),
    accountsFn(wallet),
  ]);
  // an NFT-shaped holding is a token account of 0 decimals and a balance of exactly 1. Compressed NFTs have no token
  // account (they live in a Merkle tree and exist only in indexer data), so they cannot be counted from chain state.
  const isNft = (a) => a.decimals === 0 && a.raw === '1';
  const nfts = accounts.filter(isNft);
  const fung = accounts.filter((a) => !isNft(a));
  const shown = fung.slice(0, MAX_FUNGIBLES);
  let meta = new Map();
  try { meta = await metadataFn([...new Set(shown.map((a) => a.mint))]); } catch { /* a symbol is a convenience: the balances stand without it */ }
  const fungibles = shown.map((a) => ({
    mint: a.mint,
    symbol: (meta.get(a.mint) && meta.get(a.mint).symbol) || null,
    amount: a.amount,
    decimals: a.decimals,
    program: a.program,
  }));

  const lamports = bal && (bal.value ?? bal);
  const nativeSol = typeof lamports === 'number' ? lamports / 1e9 : null;
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
    fungible_count: fung.length,
    ...(fung.length > shown.length ? { fungible_tokens_note: `the first ${shown.length} of ${fung.length} fungible token accounts are listed` } : {}),
    nft_count: nfts.length,
    total_items: accounts.length,
    source: 'Solana RPC: SOL balance, the token accounts of both token programs, and on-chain token metadata (Metaplex metadata account or Token-2022 metadata extension)',
    note: 'SPL token prices and values are not included. Only native SOL is valued, with AgentFeed\'s on-chain SOL price (native_sol_usd_source). nft_count counts token accounts of 0 decimals and a balance of 1; compressed NFTs have no token account and are not counted.',
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

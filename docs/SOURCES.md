# Upstream sources and their terms

Read on **2026-10-12** for R4. One row per upstream behind a paid route, the MCP rail or a
collector whose data a route sells. Clauses are paraphrased with their numbers; a short
phrase is quoted only where the wording decides the verdict. "Raw" means a route returns the
upstream's own values; "computed" means it returns only metrics we derive.

Verdicts: **clean** (commercial use and redistribution allowed, or attribution only),
**banned** (resale, redistribution or commercial use needs a licence or written consent),
**unclear** (no clause found, or the text is ambiguous for our use).

Rules applied in R4: a banned source that is one of several is dropped and the route kept; a
banned source a route cannot live without, where the route passes its raw values, means the
route is withdrawn (410). Exchange terms (Coinbase, Kraken, Binance, OKX, Gemini, Bybit,
Deribit) changed no route in R4, by the planning chat's steer of 12 Oct: they are recorded
here, R5 moves raw spot and reference prices to on-chain sources, and the planning chat
decides the computed products from the table below.

## Removed in R4

| Source | Terms read | Clause | Raw / computed | Verdict | Action |
|---|---|---|---|---|---|
| DefiLlama (api.llama.fi, stablecoins.llama.fi, coins.llama.fi) | defillama.com/terms | licence personal and non-commercial (cl. 7); no commercial use without written consent (8(10)); no reselling (8(6)); no republishing (8(7)); liquidated damages up to USD 100,000 per violation (cl. 14) | raw | banned | /api/tvl and /api/stablecoin-flows withdrawn (410); DefiLlama dropped from eth-price; /api/rwa-yields (RWAYield reads DefiLlama) withdrawn |
| CoinGecko / GeckoTerminal | coingecko.com/en/api_terms (5 Sep 2025) | no re-distribute or syndicate access; no store, derive from or reproduce data | raw (eth-price); stored (LaunchLedger) | banned | dropped from eth-price; /api/launch-odds and the token-risk launch block withdrawn (LaunchLedger is built on GeckoTerminal) |
| CoinPaprika free tier | coinpaprika.com/api-terms-of-use | §3.6 commercial use only on plans other than Free; §3.7.1 no further distribution; §3.9 attribution | raw | banned | dropped from eth-price |
| Pyth Network (Hermes) | dourolabs.xyz Subscription Terms (8.12.26); app.pyth.com/plans | a paid data plan is needed since Jul 31 2026 (keyless Hermes answers 401); §2.1(b) no "systematic or machine-readable delivery" of raw prices; §2.1(c) derived data allowed | raw | banned | dropped from sol-price, btc-price and /api/price (Coinbase, then Kraken) |
| Jupiter API (lite-api.jup.ag) | developers.jup.ag/docs/legal/api-terms | §2.2 no distributing the API; §3.2(d) no selling or sublicensing "any content obtained through the API"; §8.4 attribution | raw | banned | /api/dex-quote withdrawn (410) |
| Tenderly public gateway (base.gateway.tenderly.co) | tenderly.co/terms-of-service (8 Jun 2026) | §1.1 personal licence; §1.4(iv) no use "for the benefit of" anyone but yourself; docs: public RPCs rate-limited, use a node for production | raw logs (pool creations, swaps) feed base-launches | unclear, leaning banned | replaced: base-launches logs now come from dRPC, the honeypot fallback node is dRPC |
| GoPlus, honeypot.is, DexScreener (honeypot-check) | see R3 log | resale or commercial use banned | — | banned | never called (R3) |
| Upbit, Bithumb, Coinone (kimchi routes) | see R3 log | Upbit art. 5 for-profit use banned; Bithumb and Coinone art. 6 no passing prices to others | — | banned | never built (R3) |

## Sources behind live routes

| Source | Used by | Terms read | Clause | Raw / computed | Verdict |
|---|---|---|---|---|---|
| alternative.me Fear & Greed | /api/fear-greed (free), market-state, trade-context, market-snapshot | alternative.me/crypto/fear-and-greed-index, API "Rules" (undated) | "Commercial use is allowed as long as the attribution is given right next to the display of the data"; the general terms (alternative.me/terms §2) ban reselling "any portion of the Service", the index-specific rule is the narrower and governs | raw (value, class) | clean with attribution: every response now carries an `attribution` field |
| Helius RPC and DAS | wallet-holdings, token-metadata, token-risk, token-holders, wallet-activity, priority-fees, sol-network | helius.dev/terms (Cloud Services Agreement, 28 Sep 2026) | §3.1 business licence includes "integration of the Services into Customer's own products and services"; §3.2(ii) no selling, reselling or providing the Services to third parties; no clause on who owns API output | raw (balances, metadata, transactions) and computed (concentration, flags) | unclear: integration is allowed, raw passthrough may read as providing the Services |
| Jito tip floor (bundles.jito.wtf) | jito-tips | docs.jito.wtf/legal (24 Jun 2025) | §4(b) no sublicensing, selling or distributing "the Services, or any portion thereof"; §5(a) personal licence | raw percentiles | unclear, leaning banned |
| ENS resolvers (api.ensideas.com, api.ensdata.net) | base-balance (ENS names only) | no terms published (ensideas.com/about: "welcome to use in your dApp"; ensdata is grant-funded) | — | resolution only; both must agree | unclear (no written grant); ENS records are public on-chain |
| Base public RPC (mainnet.base.org) | base-gas, base-balance, honeypot-check, base-launches | docs.base.org/terms-of-service (8 Apr 2026) | §5 licence to use; §8 no excessive or abusive use; no commercial or redistribution clause | chain state | clean |
| dRPC (base.drpc.org, eth.drpc.org) | base-launches logs, honeypot fallback (Base) and honeypot (Ethereum), base-balance fallback | drpc.org/terms-of-use (14 Jan 2025) | §1.3 registration and personal use (keyless use sits outside it; a free key closes the gap); §2.5 no abusive load; no commercial or redistribution ban; free tier getLogs about 100 blocks | chain state | clean (get a free key) |
| PublicNode (base-rpc, ethereum-rpc) | base-balance and base-gas fallbacks | publicnode.com/terms (no date) | no selling, re-use or redistribution of "the Service or the Service Content" (undefined); no scraping | chain state | unclear (site boilerplate read literally) |
| BNB Chain dataseed (bsc-dataseed.bnbchain.org) | honeypot-check chain=bsc | docs.bnbchain.org JSON-RPC (19 Aug 2026); bnbchain.org/en/disclaimer (May 2026) | 10K requests per 5 min; §3.1 no unreasonable bot load; no commercial or redistribution ban | chain state | clean |
| Federal Reserve, BLS, BEA | macro-calendar, market-state | federalreserve.gov/disclaimer.htm (2 Aug 2024); bls.gov/opub/copyright-information.htm; bea.gov/help/faq/147 | public domain, may be copied and distributed; cite the agency; no use of seals or names implying endorsement; BLS blocks robots without contact details | raw dates | clean (our collector sends a contact User-Agent) |
| Coinbase Exchange public API (api.coinbase.com) | sol-price, btc-price, /api/price, eth-price, market-snapshot, trade-context, market-state (first venue) | coinbase.com/legal/market_data (Market Data Terms, 6 Feb 2023; the Exchange docs bind public market-data use to them). The page answers 403 to our fetch; read through its indexed text and the tosdr mirror | licence for internal purposes only; no redistribution or display of Market Data, or works derived from it, to third parties without prior written consent | raw (spot price, `source`) | banned |
| Kraken public API (api.kraken.com) | same routes as Coinbase (fallback venue), eth-price | kraken.com/legal/global-terms (6 Oct 2026) §8 "Our Content" | Our Content may be used "only for your own benefit"; any other use needs prior permission; no scraping or data extraction | raw (spot price) | banned |
| Binance (api.binance.com, fapi.binance.com, fstream.binance.com) | eth-price, tradfi-radar, equity-24h, the liquidation tape | Binance Terms of Use (ADGM, effective 21 Jul 2026) cl. 27 and 14.1.2(b); Binance Vision Dataset Terms v1.0 (26 Aug 2026) | licence of Binance IP "for non-commercial personal or internal business use"; API use is "subject to separate API terms" (not located); the Vision datasets are non-commercial | raw (eth quote, perp marks and funding, liquidation prints) and computed | banned (the separate API terms were not found) |
| OKX (www.okx.com, ws.okx.com) | eth-price, funding-rate, funding-cross, funding-radar, open-interest, market-state, spread-arb, perp, tradfi-radar, equity-24h, the liquidation tape | OKX API Agreement (28 Jul 2026) §9.3, §9.4 | Market Data "solely for your own personal, non-commercial trading"; no resell, redistribute, publish or display to any third party (§9.4(a)); no competing price feeds or aggregators (§9.4(b)); public endpoints bound the same way | raw and computed | banned |
| Gemini (api.gemini.com) | eth-price | gemini.com/legal/market-data-agreement (undated) | Permitted Use is personal or internal, informational, or analysis; Prohibited Use (ii) no benchmark, reference rate or index, (vi) no distribute, redistribute, sell or sublicense; commercial use and redistribution need the Redistribution Agreement | raw (eth quote) | banned |
| Bybit (api.bybit.com, stream.bybit.com) | funding, OI, long/short, basis, top-movers, orderbook, whale trades, spread-arb, volatility, positioning, squeeze-score, market-state, tradfi-radar, equity-24h, the liquidation tape | not read (research stopped by the planning chat on 12 Oct) | — | raw and computed | unclear |
| Deribit (www.deribit.com) | options-summary, options-gex, market-state (DVOL) | deribit.com/kb/deribit-api-terms renders client-side; not read | — | raw (index price, DVOL) and computed (IV, Greeks, GEX) | unclear |
| Hyperliquid (api.hyperliquid.xyz, stats-data.hyperliquid.xyz) | hl-whales, funding, spread-arb, perp, tradfi-radar, equity-24h | app.hyperliquid.xyz/terms (15 Jun 2026) | the terms govern the Interface; no data, resale or redistribution restriction; §3.1.8 bans automated use beyond reasonable usage | raw positions (public account state) and computed aggregates | clean |
| trade.xyz and other HIP-3 deployers (Paragon, Entropy, markets.xyz), read through api.hyperliquid.xyz | tradfi-radar, equity-24h (stock-perp rows, `oracle`) | read in R5, see "Added in R5 Phase B": their terms cover their own sites only | the deployer sets the market's oracle; the host's terms are Hyperliquid's | raw (mark, oracle, funding) | clean when read through api.hyperliquid.xyz (R5) |
| Pegwatch upstreams: DexScreener, Alpaca, Yahoo Finance, Stooq | peg-deviation, peg-sessions, peg-universe, equity-24h (the peg tape) | DexScreener API terms (18 Aug 2023) cl. 2; Alpaca Terms "Disclaimer" and support note (Nov 2022) "you cannot redistribute Alpaca API data"; Yahoo terms (4 Aug 2026) §2 no commercial use or redistribution; Stooq: no terms reachable (bot wall) and the keyless CSV now answers "page does not exist" | computed peg metrics; equity-24h also returns the last regular-session price | banned (DexScreener, Alpaca, Yahoo), unclear (Stooq) | unchanged in R4: computed product, decision for the planning chat |
| Overhang upstreams: Jupiter quotes, Kamino API | exit-quote, exit-method (free) | Jupiter §3.2(d) (above); kamino.com/terms (7 Aug 2026) §3.1 informational use, §6.1 personal licence | computed exit-liquidity measurements | banned (Jupiter), unclear (Kamino) | unchanged in R4: computed product, decision for the planning chat |

## R5 Phase C: every route and its venues (12 Oct 2026)

This table supersedes the R4 inventory further down, which is kept as the record of 12 Oct before
R5. It is based on the deployed code.

**Verdicts:**
- **clean:** every upstream is clean, or the route reads chain state.
- **computed:** a banned or unclear upstream feeds the route, but only values we derive are returned.
- **raw-unclear:** the route passes a raw value from an unclear venue.
- **raw-banned:** the route passes a raw value from a banned venue.

"Chain state" means values read from a public chain with standard RPC methods; the RPC provider is only the transport.

### Sources added or changed in Phase C

| Source | Used by | Terms | Verdict |
|---|---|---|---|
| Uniswap V3 pools on Ethereum and Base, read with eth_call slot0 through eth.drpc.org and mainnet.base.org (base.drpc.org fallback) | sol/btc/eth-price, price, market-snapshot, trade-context, market-state (BTC, ETH) | Chain state. The RPC terms are already in the table above (Base clean; dRPC clean). | clean |
| Orca Whirlpool and Raydium CLMM pools on Solana, read with getMultipleAccounts | sol-price, price, market-snapshot, trade-context, market-state (SOL); the peg tape's token side | Chain state. The RPC is Helius, used as transport only (Cloud Services Agreement §3.1 allows integration). | clean |
| Solana standard RPC: getAccountInfo, getTokenLargestAccounts, getSignaturesForAddress, getTransaction, getRecentPrioritizationFees, getRecentPerformanceSamples, getEpochInfo | token-metadata, token-risk, token-holders, wallet-activity, priority-fees, jito-tips (via cron), sol-network | Chain state. Replaces DAS getAsset, the enhanced transactions API, getPriorityFeeEstimate and Jito's tip_floor. | clean |
| Hyperliquid info API: metaAndAssetCtxs, l2Book, candleSnapshot, fundingHistory | the second venue on open-interest, basis, volatility, funding-history, top-movers, funding-extremes, orderbook-imbalance, orderbook-walls, positioning, funding-pulse, oi-spike-scan; HYPE spot in market-state (oracle); equity-24h's last regular-session price (HIP-3 hourly candle) | app.hyperliquid.xyz/terms (15 Jun 2026): no data or redistribution restriction | clean |

**Dropped in Phase C:**
- Coinbase, Kraken, Binance spot, OKX spot and Gemini, from every price route.
- Bybit spot, from market-state HYPE.
- The pegwatch Alpaca reference, from equity-24h.
- DexScreener, from every peg route's latest price and liquidity, and from equity-24h. pegwatch still records the token side from DexScreener; we read it only for window statistics before our cutover.
- Helius DAS (getAsset), the Helius enhanced transactions API, Helius getPriorityFeeEstimate and Jito tip_floor.

### Every route

| route | price | venues | verdict | raw value still passed (venue) |
|---|---|---|---|---|
| /api/sol-price | $0.001 | Orca and Raydium SOL/USDC pools (chain) | clean | — |
| /api/btc-price | $0.001 | Uniswap V3 cbBTC/USDC (Base), WBTC/WETH and cbBTC/WETH × WETH/USDC (Ethereum, Base) | clean | — |
| /api/eth-price | $0.001 | Uniswap V3 WETH/USDC on Ethereum and Base | clean | — |
| /api/price | $0.001 | as the three above | clean | — |
| /api/market-snapshot | $0.005 | DEX pools; Hyperliquid funding; alternative.me (attributed) | clean | — |
| /api/funding-rate | $0.005 | Hyperliquid; with `symbol`, also Bybit and OKX | raw-banned | `venues.okx.*` (OKX), `venues.bybit.*` (Bybit) |
| /api/funding-cross | $0.01 | Bybit, OKX, Hyperliquid | raw-banned | `venues.okx.*`, `venues.bybit.*` |
| /api/funding-radar | $0.02 | Bybit, OKX, Hyperliquid (collector) | raw-banned | `venues.okx.*` rates, `oi_usd.okx`; Bybit likewise |
| /api/funding-extremes | $0.02 | Bybit; Hyperliquid (second venue) | raw-unclear | Bybit ticker rates |
| /api/funding-pulse | $0.005 | Bybit; Hyperliquid (second venue) | raw-unclear | Bybit rates |
| /api/funding-history | $0.005 | Bybit; Hyperliquid (second venue) | raw-unclear | Bybit settlements |
| /api/open-interest | $0.01 | Bybit, OKX, Hyperliquid | raw-banned | `okx.oi_base/oi_usd`, `bybit.*` |
| /api/oi-spike-scan | $0.02 | Bybit; Hyperliquid (second venue) | raw-unclear | Bybit `oi_usd`, funding |
| /api/long-short | $0.01 | Bybit only (Hyperliquid publishes no long/short ratio) | raw-unclear | Bybit ratios |
| /api/positioning | $0.005 | Bybit; Hyperliquid OI | raw-unclear | Bybit ratios and OI |
| /api/basis | $0.01 | Bybit perp and spot; Hyperliquid mark vs oracle | raw-unclear | Bybit mark and spot |
| /api/volatility | $0.01 | Bybit and Hyperliquid daily candles | computed | — |
| /api/top-movers | $0.01 | Bybit; Hyperliquid (second venue) | raw-unclear | Bybit last price, turnover, funding |
| /api/orderbook-imbalance | $0.01 | Bybit and Hyperliquid books | computed | — |
| /api/orderbook-walls | $0.01 | Bybit and Hyperliquid books | raw-unclear | Bybit wall prices and sizes |
| /api/whale-trades | $0.02 | Bybit only (Hyperliquid's public API serves its last 10 trades, about 10 s) | raw-unclear | Bybit prints |
| /api/spread-arb | $0.02 | Bybit, OKX, Hyperliquid | raw-banned | `venues.okx.bid/ask`, Bybit bid/ask |
| /api/perp | $0.005 | Bybit, OKX, Hyperliquid, our tape | raw-banned | OKX funding and OI, Bybit, the tape's biggest print |
| /api/squeeze-score | $0.10 | Bybit, our tape | raw-unclear | `inputs.funding_rate_raw`, `long_account_pct` (Bybit) |
| /api/market-state | $0.02 | DEX pools (spot), Hyperliquid (HYPE oracle), Bybit, OKX, Deribit, our tape, snapshots | raw-banned | `open_interest.okx_usd`, `funding.venues.okx` (OKX); Bybit OI, long/short and basis; DVOL (Deribit) |
| /api/trade-context | $0.01 | DEX pools; Hyperliquid funding; Bybit positioning; our tape | raw-unclear | Bybit positioning; the tape's biggest prints |
| /api/liquidations | $0.005 | our CEX tape (Bybit, OKX, Binance) | raw-banned | individual prints (C7: kept, see below) |
| /api/cascade, /api/cascade-scan, /api/liquidation-leaders, /api/liquidation-stats, /api/liq-history, /api/liq-heatmap, /api/cascade-history, /api/venue-liq-share | $0.01 to $0.05 | our CEX tape | raw-banned (raw?) | single MAX/MIN prints (C7) |
| /api/liq-pulse | $0.005 | our CEX tape | computed | — |
| /api/cascade-forecast | $0.02 | our CEX tape via caliper | computed | — |
| /api/options-summary | $0.02 | Deribit (collector) | raw-unclear | `spot` (index price), DVOL |
| /api/options-gex | $0.03 | Deribit (collector) | raw-unclear | `spot` |
| /api/tradfi-radar | $0.02 | Hyperliquid HIP-3, Bybit, Binance, OKX (collector) | raw-banned | rows with venue okx or binance; Bybit rows |
| /api/equity-24h | $0.01 | Hyperliquid HIP-3 (and its candles for the regular-session close), our on-chain xStock tape, Bybit, Binance, OKX | raw-banned | `sources[]` entries from OKX and Binance (and Bybit) |
| /api/tradfi-perps | $0.005 | Hyperliquid HIP-3 | clean | — |
| /api/fx-rates | $0.002 | ECB (notice), Hyperliquid HIP-3 | clean | — |
| /api/peg-deviation | $0.02 | our on-chain xStock tape; reference from pegwatch (Alpaca) | raw-banned | `latest.reference` (Alpaca) |
| /api/peg-sessions, /api/peg-universe | $0.03, $0.05 | pegwatch history before our cutover, our tape after | computed | — |
| /api/exit-quote | $0.02 | overhang (Kamino oracle, unnamed router) | raw-unclear | as in the R4 table |
| /api/wallet-holdings/:wallet | $0.008 | Helius DAS getAssetsByOwner | raw-unclear | balances (chain state) and `price_usd`/`value_usd` (Helius price) |
| /api/token-metadata/:mint, /api/token-risk/:mint, /api/token-holders/:mint, /api/wallet-activity/:wallet | $0.005 to $0.02 | Solana chain state | clean | — |
| /api/priority-fees, /api/jito-tips, /api/sol-network | $0.005 | Solana chain state | clean | — |
| /api/base-gas, /api/base-balance | $0.005 | Base/Ethereum RPC (PublicNode only as a fallback; ENS resolvers) | raw-unclear (fallback only) | as in the R4 table |
| /api/honeypot-check, /api/base-launches | $0.01, $0.02 | chain state | clean | — |
| /api/hl-whales | $0.02 | Hyperliquid | clean | — |
| /api/macro-calendar | $0.005 | Fed, BLS, BEA | clean | — |
| /api/web-markdown, /api/pdf-markdown, /api/sec-filings, /api/insider-trades, /api/sec-8k | $0.005 to $0.01 | the caller's URL; SEC EDGAR | clean | — |

**Free routes:**
- /api/last-liquidation passes tape prints (raw-banned, C7).
- /api/fear-greed is clean, with attribution.
- /api/exit-method and /api/forecast-record are computed.
- /api/sample serves the stored captures. Since C5, OKX and Binance values and the Alpaca reference are null there, and so are the copies in the 402 challenges. The sample of each route changed in Phase C was recaptured after the change. /api/oi-spike-scan was not: a fresh process has no baseline, so its sample is the earlier Bybit-only capture.

### C7: the CEX liquidation tape stays, and its risk

- **What it is:** liqcollector.js stores every liquidation print from the public WebSocket streams of Bybit (terms unclear), OKX and Binance (terms forbid redistribution: OKX API Agreement §9.4(a); Binance licence cl. 27 and the Vision dataset terms).
- **What is exposed raw:**
  - /api/liquidations and the free /api/last-liquidation return single prints (ts, symbol, exchange, side, size, price, usd);
  - nine routes return a single MAX or MIN print without naming the exchange.
- **What is computed:** every other tape output (sums, counts, splits, forecasts).
- **The risk:**
  - a venue could treat the raw prints as redistribution of its market data and ask us to stop;
  - the API Agreement terms allow suspension of access, which would end that venue's stream and blank its share of the tape.
  - No venue has contacted us.
- **Smallest change that removes the raw exposure, kept for a decision:** drop size, price and usd from individual prints, and replace the MAX/MIN print fields with bucketed or rounded aggregates. The tape keeps its value (cascade detection, forecasts and splits are all computed).
- **Decision of 12 Oct (planning chat):** keep the tape as is and record the risk here.

## Added in R5 Phase B (terms read 2026-10-12, before building)

Every source below was read before its route was built. Quotes are verbatim and short; the
page and its date are given so the next reader can re-check them.

| Source | Used by | Terms read | Clause (verbatim) | Raw / computed | Verdict |
|---|---|---|---|---|---|
| SEC EDGAR (www.sec.gov, data.sec.gov) | sec-filings, insider-trades, sec-8k | sec.gov "Accessing EDGAR Data" (26 Jun 2024); Webmaster FAQ (23 Aug 2024); Website Dissemination policy | "All Government-created content on sec.gov and EDGAR public filing content are free to access and reuse."; "may be copied or further distributed by users of the web site without the SEC's permission. Please consider appropriate citation to the SEC as the source."; "SEC" and "EDGAR" may not be used "in a trade name, trademark, or domain name"; "no more than 10 requests per second, regardless of the number of machines" | raw (filing metadata, Form 4 fields) | clean with citation: every response carries `source`; one box-wide token bucket at 8 req/s; declared User-Agent with a contact address; no route or product is named after SEC or EDGAR |
| Hyperliquid info API, HIP-3 dexes (api.hyperliquid.xyz) | tradfi-perps, fx-rates (HIP-3 marks) | app.hyperliquid.xyz/terms (15 Jun 2026) | the terms govern the Interface; the only HIP-3 wording is the disclaimer in 1.2 ("Markets ... created under permissionless deployment mechanisms ... are not reviewed, verified, or approved by the Company"); §3.1.8 bans automated use that would "exceed reasonable usage, bypass rate limits" | raw (mark, oracle, funding, OI of each market) | clean: one perpDexs read plus one metaAndAssetCtxs read per dex, cached 60 s (at most about 240 weight a minute against the 1,200 limit) |
| HIP-3 deployers: xyz (trade.xyz), flx (Felix), vntl (Ventuals), hyna (HyENA), km and mkts (Kinetiq), cash (dreamcash), para (Paragon), io (Entropy), abcd (ABCDEx) | tradfi-perps, fx-rates | each deployer's own terms, dated Jan to Sep 2026 | every set covers the deployer's own website or app and bans scraping it, e.g. trade.xyz bans "data mining, robots, scraping ... from the Interface"; Kinetiq and HyENA limit their platforms to "personal, non-commercial purposes"; dreamcash also covers "any other API or interface made available by SLL" | not called: their markets are read from HyperCore through api.hyperliquid.xyz only | clean as built: we never call a deployer's site or API. Responses label prices "each market's own HIP-3 oracle and mark price, not an exchange quote", and never as S&P, Nasdaq or NYSE prices. abcd has no assets and no site: moot |
| European Central Bank (data-api.ecb.europa.eu, EXR) | fx-rates | ecb.europa.eu "Disclaimer & copyright" (undated, Copyright 2026); FX reference rates page | "users of this website may make free use of the information ... the ECB must be cited as the source."; whoever sells it must inform buyers "both before they pay any subscription or fee and each time they access the information ... that the information may be obtained free of charge through this website."; modified information "must be stated explicitly"; "Using the rates for transaction purposes is strongly discouraged." | raw (rates as published, rounded to 6 decimals); computed crosses for other bases | clean with attribution and notice: the notice is in the route's description (shown in the 402 challenge, before payment) and in every response (`notice`); crosses are labelled in `rates_are`; the description says the rates are for information only |
| User-supplied web pages and PDFs (any public http/https URL) | web-markdown, pdf-markdown | RFC 9309 §1 (Sep 2022); EU DSM Directive 2019/790 Art. 4(3) | robots.txt rules "are not a form of access authorization"; the EU text-and-data-mining exception applies only where use "has not been expressly reserved ... such as machine-readable means" | the publisher's content, converted to markdown on one caller's request | clean as an on-request reader: honest User-Agent with our URL, robots.txt honoured for that agent (a disallowed path is a 400, never billed), no cookies, logins or paywall bypass, nothing stored (robots.txt is cached per origin for 1 h, page content never), SSRF guard (http/https, ports 80/443, every resolved address and every redirect checked, max 3), every response says the content belongs to its publisher (`rights`) |
| Libraries: @mozilla/readability 0.6.0, linkedom 0.18.13, turndown 7.2.4, unpdf 1.8.1, fast-xml-parser 5.11.2 | web-markdown, pdf-markdown, insider-trades | npm licence fields (read 12 Oct) | Apache-2.0, ISC, MIT, MIT, MIT | code, not data | clean; pinned exact, lockfile committed |
| GDELT DOC 2.0 (api.gdeltproject.org) | /api/news (NOT BUILT) | gdeltproject.org/about.html "Terms of Use" (undated) | "available for unlimited and unrestricted use for any academic, commercial, or governmental use of any kind without fee"; redistribution "must include a citation to the GDELT Project and a link" | — | terms clean with citation, but the API is not usable for a paid route: 4 of 4 reads answered 429 on 12 Oct (Mac and VPS, gaps of 8 s or more), and the retry at 19:30 UTC returned an empty 200 after 17 s, then 429 after a 10 s gap. B5 is not built; a paid route that 503s most of the time would never bill and would rank badly |

Routes in this section and the upstreams they reach (all clean, so none is in list A below):

| route | price | venues |
|---|---|---|
| GET /api/web-markdown | $0.005 | the caller's URL (and its /robots.txt) |
| GET /api/pdf-markdown | $0.01 | the caller's URL (and its /robots.txt); parsed by unpdf in a child process |
| GET /api/sec-filings | $0.005 | www.sec.gov/files/company_tickers.json (daily), data.sec.gov/submissions |
| GET /api/insider-trades | $0.01 | the above plus the Form 4 XML in www.sec.gov/Archives |
| GET /api/sec-8k | $0.01 | www.sec.gov/cgi-bin/browse-edgar?action=getcurrent (Atom, type=8-K) |
| GET /api/tradfi-perps | $0.005 | api.hyperliquid.xyz/info (perpDexs, metaAndAssetCtxs per dex) |
| GET /api/fx-rates | $0.002 | data-api.ecb.europa.eu (EXR daily), plus the tradfi-perps cache for HIP-3 FX and commodity marks |

## Raw values by route (inventory of 12 Oct 2026, after the R4 deploy; superseded by the R5 Phase C table above)

A static read of the deployed tree: each route, the upstreams it reaches, and which response
fields carry an upstream value unchanged (rounded, unit-converted or renamed counts as raw)
versus values we compute. "raw?" marks a field whose provenance is ambiguous; the note says why.
The liquidation tape (liquidations.db, written by liqcollector.js) stores Bybit, OKX and
Binance prints verbatim; the peg tape (/opt/pegwatch) and the exit tape (/opt/overhang) are
collectors outside this repo.

### A. Routes passing a raw value from a BANNED or UNCLEAR venue

Shorthand: **tape-Bybit / tape-OKX / tape-Binance** means the liquidation tape rows from that venue's WebSocket. Where a tape field is a MAX or MIN over prints and the response does not name the exchange, the value can come from any of the three. That is why those routes get three rows.

| route | price | venue (verdict) | raw field(s) | note |
|---|---|---|---|---|
| GET /api/sol-price | $0.001 | Coinbase (BANNED) | `price` (4dp), `source`="coinbase" | getPrice tries Coinbase first. It serves whenever Coinbase answers |
| GET /api/sol-price | $0.001 | Kraken (BANNED) | `price` | Used only when Coinbase fails |
| GET /api/btc-price | $0.001 | Coinbase (BANNED) | `price` (2dp), `source` | Same as sol-price |
| GET /api/btc-price | $0.001 | Kraken (BANNED) | `price` | Fallback |
| GET /api/price | $0.001 | Coinbase (BANNED) | `price` (SOL/BTC/ETH), `source` | entry.js getSpot calls getPrice |
| GET /api/price | $0.001 | Kraken (BANNED) | `price` | Fallback |
| GET /api/eth-price | $0.001 | Coinbase (BANNED) | `price` (lead quote, unrounded), `quotes[].price` | getPriceQuotes queries all 5 venues in parallel. The lead is the first in declared order that answers |
| GET /api/eth-price | $0.001 | Kraken (BANNED) | `quotes[].price` (also `price` if Coinbase is absent) | |
| GET /api/eth-price | $0.001 | Binance (BANNED, api.binance.com) | `quotes[].price` (`price` if the venues above are absent) | ETHUSDT ticker |
| GET /api/eth-price | $0.001 | OKX (BANNED) | `quotes[].price` | `market/ticker` ETH-USDT `last` |
| GET /api/eth-price | $0.001 | Gemini (BANNED) | `quotes[].price` | pubticker `last` |
| GET /api/market-snapshot | $0.005 | Coinbase (BANNED) | `sol.price`, `btc.price` (and `.source`) | The funding part is Hyperliquid (CLEAN) and fear_greed is alternative.me (CLEAN) |
| GET /api/market-snapshot | $0.005 | Kraken (BANNED) | `sol.price`, `btc.price` | Fallback |
| GET /api/funding-rate | $0.005 | Bybit (UNCLEAR) | `venues.bybit.funding_rate_raw`, `funding_rate_8h`, `annualized_pct`, `funding_interval_hours`, `next_funding_time`, `mark_price` | Only when `?symbol=` is given. With no symbol the route is Hyperliquid-only (CLEAN). The 8h and annualized figures are unit conversions of the raw rate |
| GET /api/funding-rate | $0.005 | OKX (BANNED) | `venues.okx.funding_rate_raw`, `funding_rate_8h`, `annualized_pct`, `funding_interval_hours`, `next_funding_time` (OKX fundingTime), `mark_price` (OKX markPx) | Same condition as above |
| GET /api/wallet-holdings/:wallet | $0.008 | Helius DAS (UNCLEAR) | `native_sol` (lamports/1e9), `native_sol_usd`, `fungible_tokens[].mint/symbol/amount/price_usd/value_usd`, `total_items` | `price_usd` and `value_usd` are Helius `price_info`. Helius's own price source is not named in the tree. `nft_count` is computed |
| GET /api/token-metadata/:mint | $0.005 | Helius DAS (UNCLEAR) | `name`, `symbol`, `interface`, `decimals`, `supply`, `price_usd`, `mutable` | Everything is verbatim from getAsset |
| GET /api/liquidations | $0.005 | tape-Bybit (UNCLEAR) | `liquidations[].ts, symbol, exchange, event, size, price, usd` | Individual prints returned verbatim (usd rounded to 2dp) |
| GET /api/liquidations | $0.005 | tape-OKX (BANNED) | same | `size` = contracts×ctVal |
| GET /api/liquidations | $0.005 | tape-Binance (BANNED) | same | `event` is the order side flipped to position side |
| GET /api/cascade | $0.01 | tape-Bybit (UNCLEAR) | raw?: `cascades[].max_single_usd`, `cascades[].price_range` | raw? because MAX(usd) and MIN/MAX(price) return single prints unchanged, but the exchange is not disclosed. `total_usd`, `events`, `duration_sec` and `severity` are computed |
| GET /api/cascade | $0.01 | tape-OKX (BANNED) | raw?: same | same |
| GET /api/cascade | $0.01 | tape-Binance (BANNED) | raw?: same | same |
| GET /api/cascade-scan | $0.05 | tape-Bybit (UNCLEAR) | raw?: `cascades[].max_single_usd`, `price_range` | Same detector with scope=all |
| GET /api/cascade-scan | $0.05 | tape-OKX (BANNED) | raw?: same | |
| GET /api/cascade-scan | $0.05 | tape-Binance (BANNED) | raw?: same | |
| GET /api/liquidation-leaders | $0.02 | tape-Bybit (UNCLEAR) | raw?: `leaders[].biggest_usd` | MAX of single prints. Totals and splits are computed |
| GET /api/liquidation-leaders | $0.02 | tape-OKX (BANNED) | raw?: same | |
| GET /api/liquidation-leaders | $0.02 | tape-Binance (BANNED) | raw?: same | |
| GET /api/liquidation-stats | $0.01 | tape-Bybit (UNCLEAR) | raw?: `<sym>.<1h/24h>.biggest_print_usd`, `.by_exchange.bybit.biggest_print_usd` | The per-exchange MAX is a single print attributable to that exchange |
| GET /api/liquidation-stats | $0.01 | tape-OKX (BANNED) | raw?: `...biggest_print_usd`, `.by_exchange.okx.biggest_print_usd` | |
| GET /api/liquidation-stats | $0.01 | tape-Binance (BANNED) | raw?: `...biggest_print_usd`, `.by_exchange.binance.biggest_print_usd` | |
| GET /api/positioning | $0.005 | Bybit (UNCLEAR) | `sol/btc.long_short_ratio.long_pct, short_pct, long_pct_prev_hour, ts`, `open_interest.base`, `open_interest.usd` | Ratios ×100 and rounded. `change_1h_pct` and `change_24h_pct` are computed |
| GET /api/trade-context | $0.01 | Coinbase (BANNED) | `prices.sol.price`, `prices.btc.price` | server.js calls getTradeContext() with no arguments, so only the SOL+BTC path is served |
| GET /api/trade-context | $0.01 | Kraken (BANNED) | `prices.*.price` | Fallback |
| GET /api/trade-context | $0.01 | Bybit (UNCLEAR) | `positioning.*` (as in /api/positioning); also tape-Bybit raw?: `liquidations.<sym>.<win>.by_exchange.bybit.biggest_print_usd` | `liquidations` is getLiquidationStats |
| GET /api/trade-context | $0.01 | tape-OKX (BANNED) | raw?: `liquidations.<sym>.<win>.by_exchange.okx.biggest_print_usd` and the combined `biggest_print_usd` | MAX print |
| GET /api/trade-context | $0.01 | tape-Binance (BANNED) | raw?: `...by_exchange.binance.biggest_print_usd` and the combined `biggest_print_usd` | MAX print |
| GET /api/token-risk/:mint | $0.01 | Helius RPC/DAS (UNCLEAR) | `name`, `symbol`, `supply` (÷10^decimals), `price_usd`, `authorities.mint_authority`, `authorities.freeze_authority`, `concentration.top_accounts[].address/amount` | `top1_pct`, `top10_pct` and the flags are computed |
| GET /api/liq-history | $0.05 | tape-Bybit (UNCLEAR) | raw?: `buckets[].biggest_print` | ROUND(MAX(usd)) per bucket. Every other field is SUM/COUNT |
| GET /api/liq-history | $0.05 | tape-OKX (BANNED) | raw?: same | |
| GET /api/liq-history | $0.05 | tape-Binance (BANNED) | raw?: same | |
| GET /api/liq-heatmap | $0.02 | tape-Bybit (UNCLEAR) | raw?: `price_range` [MIN(price), MAX(price)] | Single print prices. `levels[]` bands are derived from them, and the bands' sums and `hottest_zone` are computed |
| GET /api/liq-heatmap | $0.02 | tape-OKX (BANNED) | raw?: same | |
| GET /api/liq-heatmap | $0.02 | tape-Binance (BANNED) | raw?: same | |
| GET /api/cascade-history | $0.03 | tape-Bybit (UNCLEAR) | raw?: `cascades[].peak_print`, `start_ts`, `end_ts` | Max print usd and the timestamps of the first and last print. `usd_total`, `prints` and `duration_s` are computed |
| GET /api/cascade-history | $0.03 | tape-OKX (BANNED) | raw?: same | |
| GET /api/cascade-history | $0.03 | tape-Binance (BANNED) | raw?: same | |
| GET /api/squeeze-score | $0.10 | Bybit (UNCLEAR) | `inputs.funding_rate_raw`, `inputs.funding_rate_8h`, `inputs.funding_interval_hours`, `inputs.long_account_pct` | The scores and `oi_change_24h_pct` are computed. `inputs.liq_24h` holds tape sums (computed) |
| GET /api/venue-liq-share | $0.02 | tape-Bybit (UNCLEAR) | raw?: `venues[exchange=bybit].biggest_print` | The per-exchange MAX print. `share_pct` and the totals are computed |
| GET /api/venue-liq-share | $0.02 | tape-OKX (BANNED) | raw?: `venues[exchange=okx].biggest_print` | |
| GET /api/venue-liq-share | $0.02 | tape-Binance (BANNED) | raw?: `venues[exchange=binance].biggest_print` | |
| GET /api/funding-cross | $0.01 | Bybit (UNCLEAR) | `venues.bybit.funding_rate_raw, funding_rate_8h, funding_interval_hours, next_funding_time, mark_price` | `spread_8h` and `crowding` are computed. The Hyperliquid venue is CLEAN |
| GET /api/funding-cross | $0.01 | OKX (BANNED) | `venues.okx.funding_rate_raw, funding_rate_8h, funding_interval_hours, next_funding_time, mark_price` | |
| GET /api/funding-extremes | $0.02 | Bybit (UNCLEAR) | `most_positive[]/most_negative[].symbol, funding_rate_raw, funding_rate_8h, funding_interval_hours, annualized_pct, price_24h_pct, oi_usd` | The ranking is ours. The values are verbatim tickers, unit-converted |
| GET /api/funding-radar | $0.02 | Bybit (UNCLEAR) | `symbols[].venues.bybit.funding_rate_raw, funding_rate_8h, funding_interval_hours, next_funding_time`, `symbols[].oi_usd.bybit` | Snapshot from bin/funding-radar-collect.js (in tree). `z_30d`, `mean_8h_30d`, `std_8h_30d`, `spread_8h` and `max_abs_z` are computed |
| GET /api/funding-radar | $0.02 | OKX (BANNED) | `symbols[].venues.okx.funding_rate_raw, funding_rate_8h, funding_interval_hours, next_funding_time`, `symbols[].oi_usd.okx` | Same collector |
| GET /api/options-summary | $0.02 | Deribit (UNCLEAR) | `spot` (Deribit index_price), `volatility_index.value` (live DVOL, BTC/ETH only); raw?: `term_structure[].forward` | Collector bin/options-collect.js (in tree). `forward` is the median of one expiry's instruments' underlying_price, which is Deribit's forward if the instruments agree (hence raw?). For other underlyings `volatility_index` is computed (agentfeed_iv30). If the index call fails, `spot` is a median of forwards (computed). atm_iv, rr25, bf25, iv30, PCR, OI totals, max_pain and top_strikes are computed |
| GET /api/options-gex | $0.03 | Deribit (UNCLEAR) | `spot` | Net GEX, flip, walls and by_strike are computed (Black-76 on Deribit mark_iv) |
| GET /api/market-state | $0.02 | Coinbase (BANNED) | `spot.value` (BTC, ETH, SOL), `spot.source` | |
| GET /api/market-state | $0.02 | Kraken (BANNED) | `spot.value` | Fallback |
| GET /api/market-state | $0.02 | Bybit (UNCLEAR) | `spot.value` (HYPE only: Bybit spot lastPrice), `perp.mark_price`, `open_interest.bybit_usd`, `open_interest.mark_price`, `long_short.long_pct/short_pct/long_pct_24h_ago`, `funding.venues.bybit.funding_rate_8h` | `realized_vol`, `basis_pct`, `bybit_change_24h_pct`, `z_30d` and the flags are computed. `liquidations` holds tape sums and a median (computed) |
| GET /api/market-state | $0.02 | OKX (BANNED) | `open_interest.okx_usd`, `funding.venues.okx.funding_rate_8h` | |
| GET /api/market-state | $0.02 | Deribit (UNCLEAR) | `implied_vol.iv_30d` when `kind`="deribit_dvol" (BTC, ETH) | For SOL and HYPE it is computed iv30 |
| GET /api/tradfi-radar | $0.02 | Bybit (UNCLEAR) | rows with venue=bybit: `symbol, mark, funding_rate_raw, funding_rate_8h, funding_interval_hours, oi_usd, volume_24h_usd`, `class_evidence` (symbolType) | Read by tradfi.js readCex inside the funding-radar collector (in tree) |
| GET /api/tradfi-radar | $0.02 | Binance (BANNED, fapi.binance.com) | rows with venue=binance: `symbol, mark` (premiumIndex markPrice), `funding_rate_raw` (lastFundingRate), `funding_rate_8h`, `funding_interval_hours` (fundingInfo), `volume_24h_usd` (24hr quoteVolume) | |
| GET /api/tradfi-radar | $0.02 | OKX (BANNED) | rows with venue=okx: `symbol, mark` (markPx), `funding_rate_raw`, `funding_rate_8h`, `funding_interval_hours`, `oi_usd` (oiUsd); raw?: `volume_24h_usd` | `volume_24h_usd` = volCcy24h × last, a product of two raw values (hence raw?) |
| GET /api/tradfi-radar | $0.02 | trade.xyz (UNCLEAR) and the other HIP-3 deployers, read via api.hyperliquid.xyz | rows with venue=hyperliquid: `mark`, `oracle`, `funding_rate_1h`, `funding_rate_8h`, `volume_24h_usd` (dayNtlVlm), `oi_usd` (openInterest×mark); `dexes[].full_name/deployer/oracle_updater` | The host is CLEAN, but dex `xyz` is trade.xyz: data/tradfi-classes.json has 114 `xyz:` market keys and cites docs.trade.xyz 112 times, and the deployer sets the oracle. Paragon, Entropy and markets.xyz (Kinetiq) are also present and are not on the brief's list (UNCLEAR). `z_30d`, `basis_bps` and `oi_change_24h_pct` are computed |
| GET /api/equity-24h | $0.01 | Bybit (UNCLEAR) | bybit entries in `sources[]`: `price` (mark), `funding_rate_8h`, `liquidity.open_interest_usd`, `liquidity.volume_24h_usd`; also `indicative_price` when Bybit is the deepest source | Comes from the tradfi snapshot |
| GET /api/equity-24h | $0.01 | Binance (BANNED) | binance entries in `sources[]`: `price`, `funding_rate_8h`, `liquidity.volume_24h_usd`; `indicative_price` when it is the deepest | |
| GET /api/equity-24h | $0.01 | OKX (BANNED) | okx entries in `sources[]`: `price`, `funding_rate_8h`, `liquidity.*`; `indicative_price` when it is the deepest | |
| GET /api/equity-24h | $0.01 | trade.xyz / HIP-3 (UNCLEAR) | HIP-3 entries in `sources[]`: `price` (mark), `oracle`, `funding_rate_8h`, `liquidity.*`; `indicative_price` | In the stored sample, `indicative_price` is the xyz:TSLA mark |
| GET /api/equity-24h | $0.01 | Alpaca (BANNED), via pegwatch | `last_regular_session.price` (ref), `last_regular_session.source` (contains `ref_source`) | The collector is outside the tree. The provider name comes from DB column `ref_source` ("alpaca" in the stored sample). `implied_gap_pct` is computed |
| GET /api/equity-24h | $0.01 | pegwatch on-chain DEX price (UNCLEAR, collector outside tree) | raw?: DEX entry in `sources[]`: `price` (onchain), `liquidity.pool_liquidity_usd`; `indicative_price` when it is the deepest | How pegwatch reads the pool (direct RPC, an aggregator or an indexer) is not in the tree |
| GET /api/open-interest | $0.01 | Bybit (UNCLEAR) | `bybit.oi_base`, `bybit.oi_usd`, `mark_price` | `change_1h_pct` and `change_24h_pct` are computed |
| GET /api/open-interest | $0.01 | OKX (BANNED) | `okx.oi_base` (oiCcy), `okx.oi_usd` (oiUsd) | |
| GET /api/oi-spike-scan | $0.02 | Bybit (UNCLEAR) | `spikes[].oi_usd` (current openInterestValue), `funding_rate_raw`, `funding_rate_8h`, `funding_interval_hours`, `price_24h_pct` | `oi_change_pct` and the baseline are computed |
| GET /api/long-short | $0.01 | Bybit (UNCLEAR) | `long_pct`, `short_pct`, `long_pct_1h_ago`, `long_pct_24h_ago`, `ts` | buyRatio and sellRatio ×100 |
| GET /api/basis | $0.01 | Bybit (UNCLEAR) | `mark_price`, `spot_price` (raw, or raw×multiplier for 1000x perps), `spot_price_raw`, `funding_rate_raw`, `funding_rate_8h`, `funding_interval_hours` | `basis_pct` and `state` are computed |
| GET /api/funding-history | $0.005 | Bybit (UNCLEAR) | `history[].ts`, `funding_rate_raw`, `rate_8h`, `funding_interval_hours` | The interval is inferred from settlement spacing. `avg_rate_8h`, `avg_annualized_pct` and `positive_share_pct` are computed |
| GET /api/top-movers | $0.01 | Bybit (UNCLEAR) | `gainers[]/losers[].price` (lastPrice), `change_24h_pct` (price24hPcnt×100), `turnover_24h_usd`, `funding_rate_raw`, `funding_rate_8h`, `funding_interval_hours` | The ranking is ours |
| GET /api/orderbook-walls | $0.01 | Bybit (UNCLEAR) | `bid_walls[].price`, `ask_walls[].price`, `.usd` (level price×size) | These are selected raw book levels. `mid_price` and `distance_pct` are computed |
| GET /api/whale-trades | $0.02 | Bybit (UNCLEAR) | `trades[].ts`, `side`, `price`, `usd` (price×size) | Buy and sell totals, `net_usd` and `dominant` are computed |
| GET /api/spread-arb | $0.02 | Bybit (UNCLEAR) | `venues.bybit.bid`, `venues.bybit.ask` (bid1Price/ask1Price) | `best_cross` is computed. The Hyperliquid venue is CLEAN |
| GET /api/spread-arb | $0.02 | OKX (BANNED) | `venues.okx.bid`, `venues.okx.ask` (bidPx/askPx) | |
| GET /api/token-holders/:mint | $0.02 | Helius RPC/DAS (UNCLEAR) | `symbol`, `supply`, `top_accounts[].address`, `top_accounts[].amount` | `pct` and `concentration.*` are computed |
| GET /api/wallet-activity/:wallet | $0.02 | Helius enhanced API (UNCLEAR, api.helius.xyz) | `transactions[].signature, ts, type, source, description, fee_sol` (fee/1e9), `failed` | `description` is Helius's own parsed text, passed verbatim |
| GET /api/priority-fees | $0.005 | Helius (UNCLEAR) | `levels.min/low/medium/high/very_high/unsafe_max`, `recommended` (= high) | Verbatim getPriorityFeeEstimate |
| GET /api/jito-tips | $0.005 | Jito (UNCLEAR) | `percentiles.p25/p50/p75/p95/p99`, `ema_p50` | Verbatim tip_floor |
| GET /api/sol-network | $0.005 | Helius RPC (UNCLEAR) | `slot`, `epoch` | `tps_avg_recent` and `epoch_progress_pct` are computed |
| GET /api/peg-deviation | $0.02 | Alpaca (BANNED), via pegwatch | `latest.reference` (ref, 2dp) | The collector is outside the tree. The provider is per the stored `ref_source`; the code only says "US market-data feed". `deviation_bps` comes from the collector (computed), and the window stats are computed |
| GET /api/peg-deviation | $0.02 | pegwatch on-chain DEX (UNCLEAR, collector outside tree) | raw?: `latest.onchain`, `latest.liquidity_usd`, `latest.dex` | How the DEX price and liquidity are read is not in the tree |
| GET /api/exit-quote | $0.02 | Kamino (UNCLEAR), via overhang | raw?: `measurement.oracle_price`, `oracle_source`, `oracle_age_sec`, `mark_generated_at`, `liq_bonus_bps_assumed/min/max` | The collector is outside the tree. `marked_usd` (deposits×oracle), `max_exitable_usd`, `exitable_fraction` and `unbacked_usd_lower_bound` are computed |
| GET /api/exit-quote | $0.02 | Unnamed swap router (UNCLEAR, or BANNED if it is Jupiter), via overhang | raw?: `nearest_measured_clip.realised_usd`, `routed`, `reason`, `exit_blocked.wire_reason` | `realised_usd` is the router's quoted USDC out for one clip. The router is unnamed in the tree, but its error codes match Jupiter's. `haircut_bps` and `liq_margin_bps` are computed |
| GET /api/base-gas | $0.005 | PublicNode (UNCLEAR, base-rpc.publicnode.com) | `gas_price_gwei/wei`, `base_fee_gwei/wei`, `priority_fee_gwei/wei`, `block`, `source` | Only when mainnet.base.org (CLEAN, tried first) fails. base.drpc.org (CLEAN) is third |
| GET /api/base-balance | $0.005 | PublicNode (UNCLEAR) | `balance`, `balance_wei` / `balance_raw`, `decimals`, `asset` | With chain=ethereum, eth.drpc.org is tried first and ethereum-rpc.publicnode.com second (since the release restart, 12 Oct). With chain=base PublicNode is the second fallback |
| GET /api/base-balance | $0.005 | ENS resolvers ensideas / ensdata (UNCLEAR) | `address` (when the input is an ENS name) | Used when the two agree, or when only one answers |
| GET /api/perp | $0.005 | Bybit (UNCLEAR) | `funding.venues.bybit.*`, `open_interest.bybit.oi_base/oi_usd`, `open_interest.mark_price`, `long_short.long_pct/short_pct/long_pct_1h_ago/long_pct_24h_ago`; tape-Bybit raw?: `liquidations_24h.biggest_print_usd` | `spread_8h`, `crowding` and the OI % changes are computed. `liquidations_24h` sums are computed |
| GET /api/perp | $0.005 | OKX (BANNED) | `funding.venues.okx.*`, `open_interest.okx.oi_base/oi_usd`; tape-OKX raw?: `liquidations_24h.biggest_print_usd` | |
| GET /api/perp | $0.005 | tape-Binance (BANNED) | raw?: `liquidations_24h.biggest_print_usd` | MAX print, exchange not disclosed |
| GET /api/funding-pulse | $0.005 | Bybit (UNCLEAR) | `extremes[].funding_rate_raw, funding_rate_8h, funding_interval_hours, annualized_pct, oi_usd, price_24h_pct` | Top 5 of funding-extremes |
| GET /api/last-liquidation (FREE) | $0 | tape-Bybit (UNCLEAR) | `last.<sym>.ts, symbol, exchange, event, size, price, usd` | Individual prints, delayed 15 minutes |
| GET /api/last-liquidation (FREE) | $0 | tape-OKX (BANNED) | same | |
| GET /api/last-liquidation (FREE) | $0 | tape-Binance (BANNED) | same | |

### B. Output from BANNED or UNCLEAR venues is computed only (no raw passthrough)

| route | price | venues | what is computed |
|---|---|---|---|
| GET /api/cascade-forecast | $0.02 | Liquidation tape: Bybit (UNCLEAR), OKX (BANNED), Binance (BANNED). Read by the /opt/caliper library, outside the tree | `answers[].p`, `thresholdUsd` (the symbol's 90th-percentile 15-min total), `observed.usd/events/buyUsd/sellUsd` (window sums), `state`, `support`; `model.*`. The library is outside the tree, so whether it filters exchanges is unknown |
| GET /api/volatility | $0.01 | Bybit (UNCLEAR) daily klines | `realized_vol_7d_ann_pct`, `realized_vol_30d_ann_pct` (stdev of log returns), `today_range_pct` (high−low)/close |
| GET /api/orderbook-imbalance | $0.01 | Bybit (UNCLEAR) orderbook | `mid_price` (mean of best bid and ask), `bid_usd`/`ask_usd` (sums within ±bps), `imbalance_ratio`, `skew` |
| GET /api/peg-sessions | $0.03 | pegwatch: Alpaca ref (BANNED) and on-chain DEX (UNCLEAR), collector outside tree | Per-session `mean/p50/p95/max_abs_bps` and `pct_over_100/200bps` of the collector's dev_bps, `median_liquidity_usd`, `worst_offhours_session`, `open_vs_offhours_ratio` |
| GET /api/peg-universe | $0.05 | Same as peg-sessions | `offhours_p95_bps`, `offhours_max_bps`, `open_p95_bps`, `median_liquidity_usd`, the ranking and the stale-pool exclusion |
| GET /api/liq-pulse | $0.005 | Liquidation tape: Bybit, OKX, Binance | 60-minute SUM/COUNT totals, long/short split, distinct symbols and venues, `top_symbols[]` sums |
| GET /api/exit-method (FREE) | $0 | overhang (Kamino oracle and unnamed router), collector outside tree | Row, sweep and status counts, `refusal_split`, `control_design.avg_haircut_bps`, the latest control's `haircut_bps`, `latest_marked_usd` (deposits×oracle, computed by the collector), cadence median |
| GET /api/forecast-record (FREE) | $0 | Liquidation tape, via caliper `record.db` (outside tree) | `summary` (tally), `rows[].thresholdUsd`, `p`, `observedUsd` (window sum), `outcome` |

### C. Routes with only CLEAN upstreams, or none

| route | price | upstream |
|---|---|---|
| GET /api/macro-calendar | $0.005 | federalreserve.gov (json/calendar.json and fomccalendars.htm), bls.gov (cpi.htm, empsit.htm), bea.gov (news/schedule), via bin/macro-collect.js (in tree) |
| GET /api/honeypot-check | $0.01 | mainnet.base.org and base.drpc.org (Base), bsc-dataseed(1).bnbchain.org (BSC), eth.drpc.org (Ethereum), plus our own baselaunches.db |
| GET /api/base-launches | $0.02 | base.drpc.org (logs) and mainnet.base.org (reads), via bin/base-launches-collect.js (in tree). `eth_usd` comes from an on-chain Uniswap V3 slot0 |
| GET /api/hl-whales | $0.02 | stats-data.hyperliquid.xyz (leaderboard), api.hyperliquid.xyz (clearinghouseState, metaAndAssetCtxs) |
| GET /api/fear-greed (FREE) | $0 | api.alternative.me. `value`, `classification` and `timestamp` are passed raw, with the `attribution` field present |

### Counts

**50 routes in A, 8 in B, 5 in C**, out of 63 routes: 59 paid plus 4 free. The free routes included are `/api/fear-greed` (C), `/api/last-liquidation` (A), `/api/exit-method` (B) and `/api/forecast-record` (B).

Two judgment calls shift these numbers:
- **8 routes are in A only because of MAX/MIN-selected single liquidation prints** (raw?): cascade, cascade-scan, liquidation-leaders, liquidation-stats, liq-history, liq-heatmap, cascade-history, venue-liq-share. If those selections count as computed, the split becomes **A=42, B=16, C=5**.
- **base-gas is in A only through its PublicNode fallback.** If fallback-only use is excluded, base-gas moves to C (A one lower, C one higher).

### Not counted

- **GET /api/sample and /api/sample/:route (free).** These serve the stored captures in `bazaar-examples.json` for all 59 paid routes, and those captures contain raw values from BANNED venues. Examples: the sol-price sample `price` with `source: coinbase`; the eth-price `quotes[]` from coinbase, kraken and binance; the equity-24h sample's Alpaca `last_regular_session`; the market-state sample's `open_interest.okx_usd`. The data is static, not live, but it is a raw copy served free.
- **POST /mcp.** This mirrors the same tool functions, plus MCP-only free tools: `get_cascade_forecast_free` (computed) and `get_forecast_question` (metadata). It inherits the classifications above.
- **Prose in the published descriptions.** Some route descriptions name venues that should not appear in them. The `PRICES.desc` of `/api/eth-price` still advertises "Coinbase, Kraken, Binance, OKX, Gemini", and the A2A agent card (`lib/compat.js:77`) still says "Bybit/OKX/Binance liquidation tape". Both match what the code actually fetches.

## Payment infrastructure (not data sources)

CDP facilitator (x402 exact on Base, Polygon, Arbitrum, Solana; batch-settlement on Base, Polygon,
Arbitrum, R5), Circle Facilitator Service (Arc), Circle Gateway (nanopayments on Base, Polygon,
Arbitrum, Arc, R5), GoPlausible (Algorand, R5),
Tempo RPC (MPP tempo/charge), Helius (MPP solana/charge verification). Their terms govern
settlement, not data resale, and are out of scope here.

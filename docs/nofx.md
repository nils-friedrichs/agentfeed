# AgentFeed in NOFX (and any bot that can set a header)

[NOFX](https://github.com/NoFxAiOS/nofx) is an open-source AI trading terminal. AgentFeed gives its strategies two
routes built for a trading loop, paid from a **prepaid key** sent as a plain HTTP header: nothing in the bot has to
speak x402.

| route | what it returns | price with a key | x402 price |
|---|---|---|---|
| `GET /api/signal-board` | every Hyperliquid perp ranked by open interest: mark, 1h/24h change, funding (1h and annualised), OI in USD and its 1h/24h change, last-hour liquidations by side and their z-score against the coin's own 7 days, the top 250 Hyperliquid accounts' net position and tilt, flags | **$0.005** | $0.01 |
| `GET /api/coin-signal/<COIN>` | the same row for one coin, plus the 15-minute cascade probability, the nearest liquidation clusters above and below price (24 h), the top 3 whale positions | **$0.002** | $0.004 |

Poll every 1 to 5 minutes; one call gives the whole market structure. Every number comes from data AgentFeed records
itself (a 5-minute Hyperliquid OI sampler, its own liquidation tape, a whale snapshot refreshed every 5 minutes), and
every answer names its sources with an `as_of` time. A source past its staleness limit answers **503 with Retry-After
and is never charged**; so is any 4xx.

## Read this first: NOFX does not fetch External Data Sources yet

NOFX stores External Data Sources in a strategy, but at commit `ef476f2` (the `dev` HEAD on 13 Oct 2026) **nothing
calls the function that fetches them** (`StrategyEngine.FetchExternalData` in `kernel/engine.go`: `git grep
FetchExternalData` finds only its definition). There is also no form for them in the web UI. So the two entries below
are accepted and saved, but stock NOFX never reads them into the prompt today. They take effect on a NOFX build that
calls `FetchExternalData` in its decision cycle. The response format is proven against that code: see "Proof" below.

Until then, the same key works from anything else that sends a header: a script, n8n, Freqtrade, Hummingbot, or a
gateway such as claw402.

## 1. Buy a key

A key is a balance bought with one x402 payment, on any exact rail the route's 402 challenge offers (USDC on Solana,
Base, Polygon, Arbitrum, Arc, Algorand, Optimism, Monad and Avalanche since 14 Oct 2026, and eleven more networks on request; the high-frequency batch and Gateway accepts are not offered
on key purchases). Packs: **trial $0.25**, **$1**, **$5**, **$20**; top-ups $5 and $20. Each call draws half the
route's x402 price (minimum $0.0005). Credit is a usage credit: non-refundable, no expiry. The key is a bearer secret:
anyone holding it spends the balance, and abuse means revocation.

### (a) From any x402 client, generating the key yourself (recommended)

You generate the key, save it, and pay with only its sha256. AgentFeed never sees the key before you first use it, and
a dropped connection after payment loses nothing.

```bash
npm i @x402/fetch @x402/evm viem
```

```js
// buy-agentfeed-key.mjs: node buy-agentfeed-key.mjs 0xYOUR_BASE_PRIVATE_KEY
import fs from 'node:fs';
import crypto from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { wrapFetchWithPaymentFromConfig } from '@x402/fetch';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const b58 = (b) => { let x = BigInt('0x' + b.toString('hex')), s = ''; while (x > 0n) { s = B58[Number(x % 58n)] + s; x /= 58n; } return s; };
const key = 'afk_' + b58(crypto.randomBytes(32));
fs.writeFileSync('agentfeed.key', key + '\n', { mode: 0o600 });           // saved BEFORE paying
const hash = crypto.createHash('sha256').update(key).digest('hex');

const pay = wrapFetchWithPaymentFromConfig(fetch, { schemes: [{ network: 'eip155:8453', client: new ExactEvmScheme(privateKeyToAccount(process.argv[2])) }] });
const res = await pay(`https://x402.ochinimus.app/api/keys/buy-trial?key_hash=${hash}&prefix=${key.slice(4, 12)}`);
console.log(res.status, (await res.json()).data);                         // { prefix, credit_usd, balance_usd, status: 'active', ... }
```

Change `buy-trial` to `buy-1`, `buy-5` or `buy-20` for a bigger pack. Without `key_hash`, the server generates the key
and returns it **once** in `data.key`; store it then, it is never shown again.

### (b) From the wallet NOFX already pays claw402 with

NOFX's beginner onboarding creates a Base USDC wallet for claw402 and shows its private key once ("Private key, back it
up now"; `POST /api/onboarding/beginner` returns it again, and NOFX writes it to its `.env` as `CLAW402_WALLET_KEY`).
If you hold that key, pass it to the script in (a): the same USDC that pays claw402 buys the AgentFeed key.

## 2. Add the two External Data Sources

There is no form for these in the NOFX UI. They go in the strategy JSON at
`config.ai_config.indicators.external_data_sources`, through `PUT /api/strategies/<id>` (NOFX merges the fields you
send) or `POST /api/strategies`:

```json
[
  {
    "name": "agentfeed_board",
    "type": "api",
    "url": "https://x402.ochinimus.app/api/signal-board?n=30",
    "method": "GET",
    "headers": { "X-AgentFeed-Key": "<your key>" },
    "data_path": "data",
    "refresh_secs": 20
  },
  {
    "name": "agentfeed_btc",
    "type": "api",
    "url": "https://x402.ochinimus.app/api/coin-signal/BTC",
    "method": "GET",
    "headers": { "X-AgentFeed-Key": "<your key>" },
    "data_path": "data",
    "refresh_secs": 20
  }
]
```

- `data_path: "data"` unwraps AgentFeed's `{ tool, data, paid }` envelope. NOFX's path walks objects only, so
  `data.coins` is an object keyed by coin (in open-interest order), `data.ranked` is that order as a list, and
  `data.sources` names each source with its `as_of`.
- NOFX uses `refresh_secs` as the HTTP timeout. AgentFeed answers from caches in well under a second; 20 s is ample.
- `?coins=BTC,ETH,SOL` (up to 20) restricts the board to your coins; `?n=` takes 1 to 60 (default 30).
- Coins are Hyperliquid names: `BTC`, `ETH`, `SOL`, `HYPE`, `kPEPE` (`1000PEPE` and `SOLUSDT` also resolve). An unknown
  coin answers 400 with the supported list, never charged.

### What the flags mean

| flag | rule |
|---|---|
| `crowded_long` | `funding_ann_pct >= 30` and `oi_chg_24h_pct >= 5` |
| `crowded_short` | `funding_ann_pct <= -10` and `oi_chg_24h_pct >= 5` |
| `squeeze_risk` | `crowded_short` and (`chg_1h_pct >= 1`, or last-hour short liquidations >= 2x the long ones and >= $50k) |
| `liq_spike` | `liq_z >= 3` and last-hour liquidations >= $50k |

`liq_z` = (last 60 minutes of liquidation USD minus the coin's median hourly USD over the last 168 complete hours) /
max(1.4826 x MAD, $5,000); a coin the tape never recorded is null. `whale_tilt` = (long USD - short USD) / (long +
short) over the top 250 Hyperliquid accounts, -1 to 1. Hyperliquid's funding is hourly; `funding_ann_pct` = rate x 24
x 365 x 100. These are context, not financial advice.

## 3. Check the balance (free)

```bash
curl -s https://x402.ochinimus.app/api/keys/balance -H "X-AgentFeed-Key: $(cat agentfeed.key)"
```

`{ prefix, balance_usd, calls, spent_usd, last_used, rate_per_min, status }`. An unknown key is 401. When the balance
is too low a call answers **402 JSON** `{ error: "key balance too low", balance_usd, price_usd, topup }` (not an x402
challenge); top up with `/api/keys/topup-5` or `/api/keys/topup-20` paid the same way as (a), sending the key header.
Each key has its own rate limit (120 requests a minute by default).

## What it costs per trader

At NOFX's default 15-minute scan (96 cycles a day): the board **$0.48 a day**, each coin **$0.19 a day**. At a 5-minute
scan, three times that: $1.44 and $0.58. A trader reading the board plus two coins every 15 minutes spends $0.86 a day;
the $5 pack lasts about six days.

## Proof

`ops/nofx-harness.mjs` in the AgentFeed repo does exactly what `fetchSingleExternalSource` does at `ef476f2` (URL
validation, `refresh_secs` as timeout, `Header.Set`, no status check, `json.Unmarshal`, the objects-only
`extractJSONPath`) against the live routes with a key, and prints what NOFX would hold for each source.

## Headers

`X-AgentFeed-Key: afk_...` or `Authorization: Bearer afk_...`. A request with a key header is never sent down the x402
path: an unknown, pending or revoked key is a 401 naming `/api/keys/buy-5`.

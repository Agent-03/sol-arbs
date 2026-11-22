# SOL ARB — Phase A + Jupiter V2 Quote Monitoring

Read-only TypeScript/Node.js market-data foundation:

- Auto-discover SOL/USDC liquidity pool state candidates via Raydium and Orca public APIs, validate account existence on Solana mainnet RPC, and subscribe to account changes.
- Poll/reconcile pool accounts, capture observed slot/timestamp/hash, and write JSONL events.
- Independently monitor quote-only Jupiter Swap API V2 USDC → SOL → USDC **sequential** round trips at configurable USDC sizes.
- Compare the ending USDC output with the original USDC input and subtract a **user-configured estimated cost allowance**, displaying **indicative** net outcomes. No wallet, execution, signing, or arbitrage transaction is implemented.

**Critical:** Two standalone Jupiter quotes are NOT a guaranteed executable arbitrage transaction. They can reflect changing liquidity between calls, aggregator routing, RFQ prices, and execution that is not atomically composable. Estimated costs are assumptions, not measured on-chain transaction costs. Positive quote-only observations are **not trade signals**. Do not fund or automate trades based on them.

## Local setup (Node 20+)

```powershell
git pull origin main
npm.cmd install
npm.cmd run build
npm.cmd test
npm.cmd run dev
```

If missing, create local config using `Copy-Item .env.example .env` and enter Helius (or other Solana mainnet) RPC/WSS endpoints. **Don't overwrite an existing .env.** Leave `POOL_ADDRESSES=` blank for discovery. The Jupiter quote-only API works without a key at low request volume; you can add `JUPITER_API_KEY` to .env for better rate limits.

The monitor intentionally spaces requests by at least 2200ms without a key (keyless docs limit 0.5 requests/sec), so a full five-size cycle takes time. Configurable `JUPITER_SCAN_INTERVAL_MS` is the **pause after each full cycle**, not an exact start-to-start cadence.

## Local endpoints

- `http://127.0.0.1:8787/health` — health summary (including Jupiter status)
- `http://127.0.0.1:8787/pools` — last observed pool-account states
- `http://127.0.0.1:8787/discovery` — discovered pools and discovery warnings
- `http://127.0.0.1:8787/jupiter` — recent **indicative** quote round trips, errors, timings

## Jupiter settings

```dotenv
JUPITER_API_KEY=
JUPITER_SIZES_USD=5,10,25,50,80
JUPITER_SCAN_INTERVAL_MS=60000
JUPITER_REQUEST_SPACING_MS=2200
JUPITER_ASSUMED_COST_USD=0.02
```

`JUPITER_ASSUMED_COST_USD` represents a flat combined execution-cost allowance (in USDC) to subtract for each round trip. It does not capture real slippage, dynamic swap/priority fees, Jito tips, failed transaction fees, infrastructure costs, or probability of landing. Without a wallet, quote-only mode deliberately does not submit transactions.

Jupiter docs: https://developers.jup.ag/docs/swap

## Known Phase A limitations

- Public pool discovery APIs can change; on-chain existence validation alone does not verify a full DEX-specific account layout. Program owner verification and pool vault/tick/bin-array decoding are not yet implemented.
- Pool list refresh occurs at startup only. Polling can miss intermediate account states and snapshots may cross slots. JSONL recovery/replay has not yet been implemented.
- There is no genuine atomic multi-DEX path search, swap simulation, or validated net P&L. Jupiter quote results are independent of pool feeds and cannot be treated as executable arbitrage.
- These changes have not been validated against the user's live Helius and Jupiter endpoints. Run `npm.cmd run build` and `npm.cmd test` locally and report errors.

Next: exact pool decoders and owner checks, verified route-building, transaction simulation, and realistic failure/fee measurement **before** any live execution.


## Phase B1 — Cross-DEX route topology (read-only)

The scanner now identifies known pool program owners for Raydium AMM v4, Raydium CLMM, and Orca Whirlpool. It builds distinct **Raydium ↔ Orca SOL/USDC two-leg candidate routes** and supplies live pool-state slot ages and machine-readable rejection reasons.

Open `http://127.0.0.1:8787/routes` to inspect:
- `capabilities`: discovered pools, program owner matching and `not_implemented` swap-quoting status.
- `candidates`: ordered two-pool routes for USDC → SOL → USDC, liquidity hints, slots and freshness.
- `metrics`: candidate totals, rejected owner mismatches and stale pools.
- `executableRoutes: 0`: **deliberate safety gate** until exact live swap adapters are implemented.

Pool registry USD liquidity is indicative and not the same as current executable depth. A pool account owner matching a known program does not by itself prove the pool layout or route can execute. No profit predictions, wallets or transactions are produced by Phase B1.

Reference constant-product BigInt math is included for isolated fixtures only. It is **not** connected to Raydium live pool accounts because Raydium AMM v4 requires effective vault-reserve reconstruction, on-chain fee parameters, and correct program-specific rounding. Orca and Raydium concentrated liquidity require full tick-array traversal, not a simplified midpoint or constant-product formula. See the [Orca swap API](https://orca-so.github.io/whirlpools/ts/functions/_orca-so_whirlpools.swapInstructions.html) and [Raydium SDK](https://github.com/raydium-io/raydium-sdk-V2).

**To finish Phase B:** implement and validate program-specific state decoding, fee logic and exact token amount-out for both legs; use coherent pool-account and vault/tick snapshots; replay with realistic age/landing delays; journal candidate outcomes; and verify atomic transaction simulation. Phase B1 should not be represented as a profitable or executable arbitrage engine.


## Phase B2 — Raydium AMM v4 on-chain quote adapter (experimental)

New endpoint: `http://127.0.0.1:8787/amm-v4`.

This adapter fetches the Raydium AMM v4 `AmmInfo` account and its two SPL Token vaults, checks the pool program owner, active swap status, account layout size, canonical SOL/USDC mints and vault mint/programs, and calculates amount-out using:

- effective reserves = legacy SPL vault token balances minus accrued `need_take_pnl`
- per-pool on-chain `swapFeeNumerator`/`swapFeeDenominator`, with integer fee rounding up
- integer constant-product exact-input quote for the configured USDC trade sizes
- slot skew rejection when vault data is more than two RPC context slots newer than pool data

The API reports `indicative_non_executable` for every result. Each Raydium quote is a standalone leg; **no Orca price engine has been implemented**, and the adapter does not construct, simulate, or submit an atomic arbitrage transaction. It should never output positive executable route counts based on these quotes.

Raydium's July 2026 change removed AMM v4 OpenBook liquidity from active reserve calculations, making the vault-only reserves minus accrued PnL appropriate for the current upgraded program. See [Raydium AMM v4 accounts](https://github.com/raydium-io/raydium-docs-v1/blob/main/products/amm-v4/accounts.mdx), [fees](https://github.com/raydium-io/raydium-docs-v1/blob/main/products/amm-v4/fees.mdx), and [official SDK layout](https://github.com/raydium-io/raydium-sdk-V2/blob/master/src/raydium/liquidity/layout.ts).

**Pending verification:** Confirm that quotes match current Raydium SDK quote results on real pool snapshots, including rounding and all status variants. Verify RPC snapshot consistency and supported token extensions before promoting any quote to execution grade. This code has not been run against the user's live credentials. Always run `npm.cmd run build` and `npm.cmd test`.

Phase B3 should add complete Orca Whirlpool tick-array traversal, on-chain fee logic and rigorous two-leg same-slot route simulation before any paper-profit labeling.


## Phase B3 — Orca Whirlpool SDK quote-only adapter

New read-only endpoints:
- `http://127.0.0.1:8787/orca`: official Orca Whirlpool SDK tick-array-aware exact-in quote outputs and errors
- `http://127.0.0.1:8787/arb`: indicative **two-leg** Raydium AMM v4 ↔ Orca Whirlpool USDC-funded round trips, sorted by calculated margin; always `executableRoutes:0`

The adapter integrates Orca's legacy Web3.js-compatible `@orca-so/whirlpools-sdk` library (with `swapQuoteByInputToken`). The SDK fetches the pool, necessary tick arrays and fee context. For each USDC amount $5, $10, $25, $50, $80, we evaluate Orca buy → Raydium sell and Raydium buy → Orca sell (where possible). Second-leg quotes use the **actual amount output** from the first-leg estimate, not a separately assumed nominal amount.

The SDK requires an Anchor provider, instantiated using a **fresh ephemeral in-memory local identity only**. No user's wallet, seed, or signing credentials are loaded; the program never calls any signer method or sends transactions.

* Read-only monitoring and route math only.
* Quote responses may be from different slots and different timestamps. Orca's SDK may fetch other accounts/tick arrays internally; snapshot coherence is NOT guaranteed.
* `JUPITER_ASSUMED_COST_USD` is reused as a flat hypothetical combined execution cost. It does not prove true gas, priority fees, tip requirements, swap landing, transaction success, or MEV competition.
* A positive `indicativeNetUsd` does **not** mean an executable profit. Every route has `classification: indicative_only` and reasons including non-atomic simulation, independently gathered snapshots and unverified costs.
* No genuine executability or profitable trading strategy has been validated; this update has not been locally built or exercised against live mainnet here.

### Install and run

```powershell
git pull origin main
npm.cmd install
npm.cmd run build
npm.cmd test
npm.cmd run dev
```

Use `http://127.0.0.1:8787/arb` and share the returned JSON status and errors. Keep `.env` private.

**Phase B3 still requires live verification**: confirm SDK dependency compatibility and tick-array fetch behavior, independently compare SDK quote outputs against chain-derived fixture/replay, and measure quote staleness and provider rate-limits. Future work: coherent snapshot quoting, replay journal, compute-budget/tip modeling, actual atomic route transaction construction and simulation—all before real-money trading.


## RPC 429 throttling mitigation (Phase B3)

Live terminal logs showed repeated HTTP 429 responses from RPC-backed reads even while WebSocket account events continued to flow. This update reduces requests; it does **not** guarantee that a provider's quota can support the scanner.

**Changes**:
- Orca Whirlpool pool account is validated and loaded once per monitored pool per scan, rather than once per trade size and route.
- Tick arrays are refreshed on the first quote for **each swap direction** in a cycle; additional sizes reuse the SDK fetcher's cached tick arrays for that cycle. A fresh pool is fetched at the start of each subsequent cycle. This is a cost-control optimization, **not** a coherent-slot guarantee.
- When an Orca SDK call ultimately fails with a 429 / rate-limit error, the monitor stops the current scan and waits at least two minutes before trying again; SDK-internal retry warnings may still appear before the call fails.
- Default quote scan intervals for Orca and Raydium are 60 seconds, pool reconciliation defaults to 60 seconds, and stale-age threshold defaults to 120 seconds. WebSocket updates and event journaling remain enabled.
- Per-account console noise is off by default; JSONL capture is unchanged. Enable `LOG_ACCOUNT_UPDATES=1` for verbose console output.

**Important for existing installations:** Your local `.env` is not overwritten by `git pull`. If you already have these keys, set them manually:

```dotenv
POLL_INTERVAL_MS=60000
STALE_AFTER_MS=120000
AMM_V4_SCAN_INTERVAL_MS=60000
ORCA_SCAN_INTERVAL_MS=60000
LOG_ACCOUNT_UPDATES=0
```

These defaults are intended only for stable, read-only monitoring and diagnostic investigation; they are too slow to be used as a real-time execution system. Do not interpret delayed quotes as current market profits. If 429s persist, reduce `MAX_DISCOVERED_POOLS`, reduce quote sizes scanned or use a provider rate-limit tier that supports your observed RPC request load. Do **not** disable retries globally or bypass provider rate limits.

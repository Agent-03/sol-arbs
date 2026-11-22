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


## Shared RPC limiter and 429 diagnostics (Phase B3 hardening)

If the terminal repeatedly shows `Server responded with 429 ... Retrying`, those warnings originate from the Solana Web3.js HTTP RPC client's automatic retry layer. We now avoid independently retrying every SDK caller:

- **One shared `Connection`** is passed to pool discovery, Raydium, Orca/Anchor SDK, and the journal scanner, configured with a **single-flight** HTTP `fetch` limiter.
- The limiter spaces RPC starts (default 1000 ms), bounds 429 retries (default 2 retries / 3 attempts total), respects `Retry-After` responses, and serializes HTTP calls. Web3.js automatic 429 retries are disabled for this shared connection.
- Status is available at `http://127.0.0.1:8787/rpc`; `/health` and `/arb` also include `rpc` diagnostic counters (HTTP calls, attempts, rate limits, retry attempts, transport errors, and any active cooldown).
- A duplicate Raydium startup scan was removed. The initial Raydium quote pass is performed once, to seed the Orca cycle.
- The optional Raydium pool-to-vault slot tolerance is explicitly configurable. The default of 12 slots accommodates request pacing but **decreases quote coherence**; these remain indicative quotes only and must never be promoted to execution signals.

Defaults (add to an existing local `.env` if you need custom values; otherwise defaults apply):

```dotenv
RPC_HTTP_MIN_SPACING_MS=1000
RPC_HTTP_MAX_RETRIES=2
RPC_HTTP_429_BACKOFF_MS=5000
RPC_HTTP_429_MAX_BACKOFF_MS=60000
AMM_V4_MAX_SLOT_SKEW=12
```

A free or low-tier RPC plan may still reject reads after the limit is applied. If `/rpc` reports continuing rate limits, try `RPC_HTTP_MIN_SPACING_MS=2000` and reduce `MAX_DISCOVERED_POOLS`. **The limiter intentionally slows down the monitor: it is a diagnostic solution, not a high-frequency arbitrage execution architecture.**

A GitHub Actions workflow now runs `npm install`, `npm run build` and `npm test` on pushes to `main` and pull requests, using Node 22. This is not a substitute for live mainnet testing against your RPC plan.


## Dual Solana RPC providers: Helius primary + Alchemy / QuickNode secondary

The mainnet account scanner, Raydium v4 adapter, and Orca Whirlpool SDK now use a **shared Solana Web3.js Connection** with an optional HTTP JSON-RPC provider failover transport. This is **standby failover**, not continuous load balancing or parallel cross-provider quoting.

Configure local `.env` (never commit API keys):

```dotenv
SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_HELIUS_KEY
SOLANA_WS_URL=wss://mainnet.helius-rpc.com/?api-key=YOUR_HELIUS_KEY
SOLANA_BACKUP_RPC_URL=https://solana-mainnet.g.alchemy.com/v2/YOUR_NEW_ALCHEMY_KEY
```

You may instead configure a Solana **mainnet** HTTPS QuickNode RPC URL as `SOLANA_BACKUP_RPC_URL`. The backup is optional; leave the variable blank for primary-only operation. If an endpoint/key was posted in chat or elsewhere publicly, **rotate that provider key** first and only put its replacement in your local `.env`.

How failover works:
- Helius is tried first. A primary HTTP **429, 500, 502, 503 or 504**, or transport failure, makes the read attempt Alchemy/QuickNode instead.
- **401/403** are **not** failed over: wrong API keys and authorization errors must be corrected explicitly.
- A provider's 429 cooldown, HTTP attempt counts, and failures are tracked separately. The backup's own 429 response is **not** ignored.
- Providers are not used for unlimited retries: one request is serialized through both paths, and both must honor their own quota. No transaction creation, signing, or submission is introduced.
- HTTP provider selection does **not** fail over Helius WebSocket subscriptions. Account updates remain on `SOLANA_WS_URL`; use the health endpoint to watch for subscription issues.
- Two RPC providers can have different confirmed slots and differing freshness. Our existing min-context-slot and validation checks remain in effect; **cross-provider quote timings are not atomically consistent**. Routes are still labeled indicative and non-executable.

Diagnostic endpoint: `http://127.0.0.1:8787/rpc` now includes `mode`, `activeProvider`, `failovers`, `secondarySuccesses`, and separate `primary`/`secondary` rate-limit stats, without printing endpoint URLs or credentials.

Run `npm.cmd install`, `npm.cmd run build`, `npm.cmd test`, and `npm.cmd run dev` after pulling the latest main branch. This code has **not** been confirmed with your live Alchemy credentials; check `/rpc` and `/arb` after startup. The new backup will not be enabled until you add `SOLANA_BACKUP_RPC_URL` to your existing `.env`.

Official Alchemy Solana RPC documentation: https://www.alchemy.com/rpc/solana


## Phase B4 — Live intelligence dashboard, freshness gate, and adaptive pool discovery

Open **`http://127.0.0.1:8787/`** after `npm.cmd run dev`. This is a self-contained, responsive local dashboard. It does **not** require a frontend build, wallet, account, or browser extension.

### Dashboard
- Live scanner state, quote-cycle counts and next scan, plus Raydium/Orca per-pool progress.
- Freshness-qualified **research-only** Raydium ↔ Orca route comparisons (not trading signals).
- Separate **Excluded** tab for stale quotes, large observation gaps, divergent pool slots, and insufficient or unknown pool liquidity.
- Best *comparable* estimated net, number of comparable/excluded routes, and 48-cycle in-memory history. An empty qualified set displays **NO MATCH**, never a stale profit.
- Helius/Alchemy RPC request counters, 429s, successful failovers, and active provider; no RPC endpoint URLs or API keys are shown.
- Supported Raydium AMM v4 / Orca Whirlpool counts versus Raydium CLMM pools that still require another quote engine.
- Last 10 real engine events (startup, scan results, discovery, errors).

### What happens when no routes are profitable?
1. A **sequential** Raydium → Orca quote cycle repeats automatically after the previous cycle completes, using the configured scan intervals. This is deliberate: many simultaneous quote refreshes overload limited RPC plans. It never assumes a negative quote stays negative permanently.
2. If no route passes the freshness/liquidity rules *and* shows a positive indicative net, the engine refreshes the **SOL/USDC** pool universe at most once every 5 minutes by default. With at least one positive comparison, refresh cadence slows to 15 minutes. It validates more candidate pools on chain before selecting the monitored set, keeps the highest-liquidity anchor pools and rotates other supported ones.
3. Pool rotation updates WebSocket subscriptions for additions/removals without restarting the process. Underliquid pools (default below $10,000 reported TVL) are not sent to the expensive quote adapters; they may still appear in discovery.
4. Dashboard buttons **Scan now** and **Find more pools** request these actions immediately, subject to busy state and a 30-second / two-minute manual cooldown. They never send trades.

The scanner **does not** broaden beyond SOL/USDC, and it **cannot yet quote Raydium CLMM**. This is a purposeful supported-market scope, not a claim to find every Solana arbitrage opportunity.

### Freshness is not execution readiness

The Phase B4 default comparison gate requires:
- Each quote response observation within **15 seconds** of the current clock;
- The two observations no more than **4 seconds** apart;
- Their reported pool-context slots no more than **12** apart; and
- Both pools above the configured discovery liquidity floor (**$10,000**).

Those are *research heuristics*, not coherent same-slot snapshots. A returned quote timestamp may postdate the actual state or tick-array RPC read; two RPC providers can have different confirmed slots. The indicated execution cost remains hypothetical and may omit priority fees, transaction landing, DEX mechanics, and MEV. Every result remains **`indicative_only`** and **`executableRoutes: 0`**. Missing or outdated data is never promoted to a trade signal.

### Settings for your existing local `.env`

```dotenv
# Quote cycle pauses after the previous complete cycle, not wall-clock intervals.
AMM_V4_SCAN_INTERVAL_MS=60000
ORCA_SCAN_INTERVAL_MS=60000
B4_MAX_QUOTE_AGE_MS=15000
B4_MAX_QUOTE_GAP_MS=4000
B4_MAX_SLOT_SKEW=12
B4_MIN_POOL_LIQUIDITY_USD=10000
DISCOVERY_REFRESH_MS=900000
NO_PROFIT_DISCOVERY_MS=300000
```

Leave your existing Helius/Alchemy/Jupiter keys unchanged and private. The dashboard works with or without the optional Alchemy backup.

### APIs
- `GET /` — live dashboard
- `GET /api/dashboard` — single compact dashboard snapshot: status, metrics, candidates, history, activity, RPC, coverage
- `POST /api/actions/scan` — request a quote scan (busy/cooldown-protected; localhost-origin checked)
- `POST /api/actions/discover` — request pool discovery refresh (busy/cooldown-protected)
- `GET /arb` — backwards-compatible indicative routes, now with the freshness comparison gate; only a capped subset of excluded candidates is returned
- `GET /routes` — **legacy topology only**, still not quoted
- `GET /amm-v4`, `/orca`, `/rpc`, `/health` — existing diagnostics

### Important next engineering work
A stable research dashboard is not an atomic arbitrage bot. For actionable evaluation we still need coherent slot-pinned account snapshots, SDK parity tests, Raydium CLMM support if desired, actual dual-swap transaction construction, transaction simulation, and measured fee/landing/slippage impacts. Long per-quote RPC reads are acceptable for diagnosis but not low-latency execution. No real-money deployment should occur based on Phase B4 alone.

After pulling, run `npm.cmd install`, `npm.cmd run build`, `npm.cmd test`, and `npm.cmd run dev`. The repository changes and tests are committed; they must still pass your local build and live provider validation.


## Phase B5 — Event-driven read-only route detection

Open the existing dashboard at **`http://127.0.0.1:8787/`**. B5 replaces the old *full Raydium HTTP scan before every Orca refresh* with a WebSocket-backed Raydium pool/vault state cache and an incremental local two-leg route combiner.

### Exact scope implemented

1. **Live Raydium AMM v4 feed:** Subscribe to the AMM state and both legacy SPL-token vault accounts for each supported liquid SOL/USDC pool. Start by validating/reading all three accounts in one on-chain RPC context after subscriptions; refresh that coherent-context snapshot periodically to recover missed WebSocket events. Valid account changes recalculate the configured USD notionals locally **without an HTTP RPC call on the WebSocket hot path**. Require all component data, verified account ownership/mints/vault authority, bounded component age, and limited slot skew.
2. **Orca Whirlpool:** Continue using the installed Orca SDK quote engine for Whirlpool/tick-array calculations; it is *not yet a fully memory-resident quote engine*. Refresh on a bounded cadence or a changed Orca pool, with coalescing and a minimum trigger cooldown. **Publish each completed Orca leg as soon as it is available** rather than waiting for the whole scan. Quote freshness is conservatively anchored to the pool account observation, not to the later SDK computation time.
3. **Local route combiner:** On every Raydium local recomputation or newly published Orca leg, calculate Orca buy → Raydium sell using the current Raydium reserves and the **exact SOL output** of the Orca buy. Raydium buy → Orca sell is evaluated **only** if an SDK reverse quote has exactly the same input amount as the newest Raydium buy output. Never silently round, approximate, or treat a different quote as contiguous.
4. **Freshness and integrity:** Preserve Phase B4 maximum age, time gap, slot skew and liquidity checks. Outdated quotes and different-state inputs are excluded from qualifying research comparisons. Every candidate retains `classification: "indicative_only"`, and `executableRoutes` remains **0**.
5. **Dashboard metrics:** Actual WebSocket state events, local recomputations and route evaluations, callback-to-local-evaluation p50/p95 milliseconds, ready Raydium pool/vault state count, Orca SDK progress, unmatched exact-input reverse quotes, provider rate-limit/failover counters, stale/unaligned exclusions, and clear explanatory empty states. The panel explicitly distinguishes **unprofitable** from **no data** and **stale data**.

### Why this is not a professional execution bot yet

- **Raydium AMM v4 open orders:** Our CPMM research quotes use legacy SPL token vault reserves after pending-PNL adjustment, and **do not yet reconcile any OpenBook/open-orders balances**. They are approximate, and simulated execution may differ. No result should be considered an exact on-chain swap output.
- **Orca tick-array freshness:** The SDK fetcher caches tick arrays across requested sizes, and pools/tick arrays are read via RPC. Pool observation slots do not prove all tick arrays were captured at the same slot.
- **WebSocket reception latency:** The reported `evaluation p95` measures milliseconds from **receipt of a local WebSocket callback to completion of in-memory route evaluation**. It is NOT chain-to-node end-to-end latency, the exchange reaction time, or landing latency.
- **No guaranteed spread:** The instrument universe remains **SOL/USDC** and the quote adapters remain **Raydium AMM v4 and Orca Whirlpool**. Raydium CLMM, DLMM, multihop tokens, Jito bundle execution, simulation, priority fee estimation, wallet use and transaction submission are **not implemented**. A zero-profit/zero-comparable result can be a legitimate outcome even when the event feed is healthy.
- **Read-only research:** Absolutely no transaction signing, wallet loading, broadcasting or orders were added. Helius primary / Alchemy backup remains HTTP-only failover; WebSocket stays on the configured primary.

### B5 configuration

Append or customize in your local `.env` (existing credentials remain private):

```dotenv
B5_QUOTE_SIZES_USD=5,10,25
B5_RAYDIUM_RECONCILE_MS=12000
B5_MAX_COMPONENT_AGE_MS=20000
B5_ORCA_REFRESH_MS=15000
B5_ORCA_EVENT_COOLDOWN_MS=12000
B4_MAX_QUOTE_AGE_MS=15000
B4_MAX_QUOTE_GAP_MS=4000
B4_MAX_SLOT_SKEW=12
B4_MIN_POOL_LIQUIDITY_USD=10000
```

`B5_QUOTE_SIZES_USD` is deliberately independent of Jupiter's quote sizes. More quote sizes/Orca pools mean more SDK requests and potentially stale observations. Tightening freshness thresholds will increase exclusions; **don't relax them just to make positive P&L appear**.

### Run and verify

```powershell
git pull origin main
npm.cmd install
npm.cmd run build
npm.cmd test
npm.cmd run dev
```

Then open `http://127.0.0.1:8787/` and inspect `GET /api/dashboard` or `GET /arb`. Check `b5.marketEvents`, `b5.localEvaluations`, `b5.latency.p95Ms`, `b5.raydiumReadyPools`, `orca.quotedLegs`, `opportunities.excludedByReason` and `rpc.primary.rateLimits`. `GET /amm-v4` reports the Raydium WebSocket cache and reconciling health.

**Validation status:** B5 source, dashboard and fixture-based tests are committed. They still require the local TypeScript build, full unit suite, and live RPC/WebSocket run for verification. Do not enable real-money trading on this version.


## Phase B5.1 — persistent quote view, CLMM SDK pricing, pool eligibility and usable-route coverage

**Dashboard:** `http://127.0.0.1:8787/`. The **Usable market coverage** section makes the difference between 20 *discovered* pools and the small subset with actual time-valid swap quotes visible. Every pool is shown with its program, TVL, state, exclusion reason, pool age, tick-array age (when obtainable), and quote count.

### Implemented

- **Orca quote continuity:** a per-pool last-known quote book retains completed quote legs while the next scan starts. It reports `warming`, `refreshing`, `fresh` or `expired` as of the query time. When a fresh scan begins publishing for a given pool, old legs for that pool are replaced to prevent mixing completed refresh generations; unchanged pools retain their previously quoted state. Expired data remains observable but is never counted as a fresh comparable opportunity. Scan errors do not advance the successful quote timestamp.
- **Raydium CLMM adapter:** The official `@raydium-io/raydium-sdk-v2` SDK loads CLMM state and tick-array/bitmap data, and `PoolUtils.computeAmountOut` generates tick-array-aware *indicative* exact-input quotes for SOL/USDC. This is not a pool spot-price extrapolation. The default limit is 3 high-liquidity CLMM pools refreshed every 45 seconds with a 60-second hard cache lifetime; the separate B4 15-second research freshness gate remains stricter.
- **Both directions:** Orca USDC→SOL followed by CLMM SOL→USDC uses SDK quote math at the **actual** Orca output. CLMM USDC→SOL followed by Orca SOL→USDC requests the Orca SDK quote at exactly the CLMM output; if an exact-input quote does not exist it is skipped, not interpolated.
- **Selective Orca polling:** On subscribed Whirlpool pool-state changes, a cooldown-protected refresh targets the changed pool. Periodic full refreshes still protect against missed changes. The Orca tick-array read-start timestamp is tracked separately from its pool-account observation. **Tick-array RPC slots are unknown**, explicitly reported as `null` / `tickArraysSlotVerified:false`.
- **Pool eligibility:** `active`, `refreshing`, `expired`, `waiting`, `excluded`, `unsupported`, and `not_selected`, with reasons including low/unknown TVL, missing quote, liquidity constraints and CLMM pools outside the RPC budget.
- **Coverage:** Count budgeted Raydium AMM V4+CLMM × Orca pairs × quote sizes × both directions as the *theoretical monitored comparisons*, then show completed and freshness-qualified estimates separately. The percentage is a **research coverage ratio**, not realized success rate or probability of winning.

`GET /api/dashboard` exposes `clmm`, `discovery.eligibility`, `discovery.utility`, `orca.quoteState`, `orca.freshLegs`, and `orca.expiredLegs`. New `GET /clmm` returns CLMM monitor diagnostics. `GET /arb` includes the coverage and eligibility summaries.

### Existing local .env (keep provider credentials private)

```dotenv
B5_1_CLMM_MAX_POOLS=3
B5_1_CLMM_REFRESH_MS=45000
B5_1_CLMM_MAX_CACHE_AGE_MS=60000
```

Adjust `B5_1_CLMM_MAX_POOLS` downward if your Solana RPC plan starts returning 429s again. Other B4/B5 settings still apply. CLMM and Orca SDK snapshots may involve different pool/tick-array RPC slots and **must never be treated as atomic**. Raydium AMM V4 CPMM still does not reconcile OpenBook open-order balances; reported execution costs are assumptions. Every route remains indicative, `executableRoutes:0`, and the engine never signs or sends transactions.

### Run / inspect

```powershell
git pull origin main
npm.cmd install
npm.cmd run build
npm.cmd test
npm.cmd run dev
```

Then in a second terminal:

```powershell
$d = Invoke-RestMethod http://127.0.0.1:8787/api/dashboard
$d.discovery.utility | Format-List
$d.discovery.eligibility | Select-Object program,state,reason,liquidityUsd | Format-Table -AutoSize
$d.clmm | Select-Object status,selectedPools,readyPools,quotes,errors | Format-List
$d.orca | Select-Object status,quoteState,freshLegs,expiredLegs | Format-List
```

**Validation note:** Source, test fixtures and dashboard JavaScript have been updated. The complete dependency install, TypeScript build, unit suite and live mainnet feed must still be verified on the target Windows workstation. In particular, the Raydium SDK integration is new and may need follow-up compatibility fixes from your local build output. No performance or profitability claims are implied by compilation or connectivity.


## B5.2 — shorten the failing 29–40 second Orca scan (diagnostic mode)

The user's 18-sample field test showed 29–40 second Orca refreshes, only 0–2 brief fresh legs, and **zero freshness-qualified routes** despite 2–6 raw estimates. The bottleneck is the number of *sequential* reverse-quote requests, not the 2ms local evaluator.

A new **`B5_2_ORCA_QUOTE_MODE=fast`** mode (default) deliberately limits the scanner to the **smallest single size** in `B5_QUOTE_SIZES_USD` and makes only the first Orca USDC→SOL buy quote per eligible pool/size; its Raydium AMM V4 / CLMM SOL→USDC second leg is recomputed in memory. **It does not monitor Raydium→Orca reverse arbitrage**. The dashboard and `/api/dashboard` show this loss of scope explicitly, and the theoretical coverage denominator counts one, not two directions.

The first fresh Orca buy also requests a **throttled (12 seconds minimum)** coherent-context Raydium AMM V4 account reconciliation, so a still-valid but infrequently changing Raydium pool can be revalidated near the incoming Orca observation. This still uses the shared RPC limiter; it does not fake a newer observation timestamp or make quotes atomic. Test this mode to determine whether the remaining stale comparisons come from provider contention, slot skew or market-data design.

Set `B5_2_ORCA_QUOTE_MODE=full` to restore both directions, all configured trade sizes, and exact-input Orca reverse SDK quotes. This is more complete but slower, and was previously observed taking 29–40 seconds per cycle on the user's shared rate-limited RPC plan. Neither mode sends orders.

New metrics: `b5.quoteMode`, `b5.activeSizesUsd`, `b5.monitoredDirections`, `b5.requestedRaydiumSyncReads`, `b5.scanTiming` and `orca.lastFirstBuyDelayMs`, `orca.lastScanDurationMs`, `orca.lastBuyCount`, `orca.lastReverseCount`.

Try the default fast mode first; keep the original B4 freshness filters unchanged:

```powershell
git pull origin main
npm.cmd install
npm.cmd run build
npm.cmd test
npm.cmd run dev
```

In a second PowerShell window:

```powershell
$d = Invoke-RestMethod http://127.0.0.1:8787/api/dashboard
$d.b5 | Select-Object quoteMode,activeSizesUsd,scanTiming,requestedRaydiumSyncReads
$d.opportunities | Select-Object total,comparable,excluded,positive,bestComparableNetUsd
$d.opportunities.excludedByReason | ConvertTo-Json
```

**Do not claim this fixes profitability:** even freshly aligned quotes can still be negative net; same-slot coherent Orca tick-array updates, fee estimation and transaction simulation remain unimplemented. The primary goal is to reduce quote acquisition time and get reproducible, sufficiently synchronized research comparisons before broadening execution capability.


## New Activity Explorer UI (Solscan-style)

The default homepage **`http://127.0.0.1:8787/`** now presents the scanner using a light, transaction-explorer-inspired layout with columns and badges similar to the shared DeFi activity screenshot. The original dark monitoring dashboard is preserved at **`http://127.0.0.1:8787/terminal`**.

The explorer uses **real data from `GET /api/explorer`**, refreshed every three seconds:
- **Route Estimates:** all current route estimates (not just the top 20), input/output USDC, assumed net, market venues, quote timestamps, and exact exclusion reasons. Filter by comparable, positive estimate or excluded.
- **Swap Quotes:** raw Orca Whirlpool, Raydium AMM V4 and Raydium CLMM quote legs, marked Fresh or Expired based on the configured maximum observation age.
- **Pool Coverage:** every discovered pool, reported TVL, quote count, adapter, status and detailed eligibility reason.
- **Engine Activity:** actual recent engine events.
- **Transactions:** explicitly states that there is **no transaction indexer yet**. Never invent signatures, on-chain fills or realized P&L.

Every table supports local search, column sorting, status filters, 10/25/50-row pagination, a record-details drawer and CSV export for the filtered rows. Excel-formula-like CSV fields are escaped. CSV export uses the actual backend data, not a rendered mock.

The explorer is **read-only** and contains **no transaction-signing, account connections or execution controls**. Positive estimates are *not* verified opportunities. The separate diagnostic dashboard and all legacy diagnostic API endpoints remain available.

To use it on Windows PowerShell:

```powershell
git pull origin main
npm.cmd run build
npm.cmd test
npm.cmd run dev
```

Open the new explorer at `http://127.0.0.1:8787/` and the original diagnostics at `http://127.0.0.1:8787/terminal`. A complete local TypeScript build and live browser run still need to be verified on the workstation.


## Phase C1 — shared, slot-aware account cache (read-only)

C1 is the **market-data foundation** for the price-map architecture reviewed in the public Rust reference project. It does **not** copy that project's proprietary code and does **not** implement transaction execution.

### What changed

- A new `src/marketData.ts` owns the normalized per-account cache. Each observation retains its **slot**, first receipt time, last RPC verification time, source (`websocket`, `rpc_poll`, `rpc_reconcile`, `rpc_bootstrap`, future `geyser`), owner program, account bytes, and hash. The byte payload stays on the server, not in JSON dashboards.
- **Shared WebSocket watches:** A single `onAccountChange` subscription per unique account address, with reference-counted readers. The pool scanner and Raydium AMM V4 monitor now share those subscriptions instead of maintaining duplicate listeners.
- **Dependency graph:** Every discovered pool is initially tied to its pool-state account. Quote-supported Raydium AMM V4 pools add their two vault accounts. A vault notification only invalidates/recalculates affected pools, without a new HTTP request on that event's hot path. Orca and CLMM pool account notifications still schedule throttled SDK/RPC refreshes; CLMM now has a coalesced per-pool refresh queue.
- **Data integrity:** Older-slot updates never replace a newer observation. Duplicate RPC reads at the same slot can update `verifiedAt` but **cannot reset `receivedAt`** or make a stale quote appear fresh. Equal-slot RPC responses cannot overwrite distinct WS/Geyser payloads. Owner mismatches fail closed, and old accounts are evicted as pool universes rotate.
- **Metrics:** `GET /api/market-data` returns watched accounts, actual updates by source, duplicate/older-slot/owner-mismatch drops, per-pool dependency coverage, missing/stale/slot-skew states, and latest WebSocket event time. The same data is exposed in `GET /api/dashboard` as `c1` and in `GET /api/explorer` as `summary.c1`. Both existing UIs show a compact live feed-health section.
- **Testing:** `test/marketData.test.ts` covers watch deduplication, dependency fan-out, owner/slot validation, stale age, RPC bootstrap, and quote-age integrity. `test/c1LiveRaydium.test.ts` checks that Raydium and the pool watcher share one subscription and a live vault update triggers quote recalculation without new RPC requests.

### What C1 does *not* solve yet

The configured source remains **Solana WebSocket account change events** using `SOLANA_WS_URL`. The `geyser` source label is reserved for a *future normalized adapter*; a Yellowstone Geyser connection, gRPC credentials and a streaming decoder have **not** been added.

**Orca Whirlpool tick arrays and Raydium CLMM tick arrays still use their existing SDK/RPC loaders.** A "cache-ready" Orca or CLMM pool in C1 means its *registered pool-state dependency* is present and time/slot aligned; it does **not** certify that its tick arrays are synchronized, its quote is current or an arbitrage route can execute. C2 must add locally priced, independently validated tick/bin-array snapshots before those SDK calls can be removed from the quote path.

The existing RPC failover, quote status labels, cost assumptions, and no-wallet/no-execution protections remain in place. C1 does not guarantee positive opportunities, lower end-to-end chain latency, or better landing success.

### Run and check on Windows

```powershell
git pull origin main
npm.cmd install
npm.cmd run build
npm.cmd test
npm.cmd run dev
```

Then open `http://127.0.0.1:8787/` (Activity Explorer) or `http://127.0.0.1:8787/terminal` (technical dashboard). In a separate PowerShell window:

```powershell
$m = Invoke-RestMethod http://127.0.0.1:8787/api/market-data
$m | Select-Object watchedAccounts,trackedAccounts,wsUpdates,rpcUpdates,readyPools,stalePools,missingDependencies,slotSkewPools,olderSlotDrops | Format-List
$m.pools | Select-Object pool,accounts,present,state,oldestAgeMs,slotSkew | Format-Table -AutoSize

$d = Invoke-RestMethod http://127.0.0.1:8787/api/dashboard
$d.clmm | Select-Object poolAccountEvents,selectiveScans,pendingDirtyPools
$d.opportunities | Select-Object total,comparable,excluded,positive,bestComparableNetUsd
```

**Validation status:** The repository changes and fixture tests are committed. The complete TypeScript build, unit suite, Solana WebSocket reconnect behavior, SDK compatibility and live RPC throughput must be verified on the machine running the service. If a build or test fails, capture the output rather than treating the changes as production-ready.


## Phase C2 — local tick-array pricing (experimental, READ ONLY)

C2 builds on C1's normalized WebSocket pool cache, replacing repeated SDK/RPC calls **on the quote-calculation hot path when the requisite accounts are available and slot-bounded**. Exact swap math uses the DEX SDKs rather than a spot-price approximation or hand-rolled float formula.

### Implemented

- **Orca Whirlpool:** `src/localWhirlpool.ts` uses the existing `@orca-so/whirlpools-sdk` public `swapQuoteWithParams` calculator with account bytes decoded from the C1 cache. It subscribes to both directions' tick-array addresses and batches initial pool/tick reads in one RPC context. One SDK mint/epoch metadata read remains necessary on bootstrap. For legacy SPL SOL/USDC mints, tick arrays verified **absent** by an RPC response at a known slot can be treated as uninitialized. **Unknown** missing arrays are *not* guessed to be empty. Adaptive-fee/Token-2022 pools are excluded from the local path, not approximated. The original Orca RPC SDK quote remains a fallback for incomplete, expired or unsupported local snapshots.
- **Live local updates:** Whirlpool pool/tick WebSocket notifications from C1 trigger fresh local USDC→SOL quotes without another RPC call. Pool-state changes that move the required tick window fail closed until a new tick-array bootstrap. Existing full-mode reverse quotes remain available, but the default `B5_2_ORCA_QUOTE_MODE=fast` intentionally monitors only Orca→Raydium at the smallest quote size.
- **Raydium CLMM:** `src/clmm.ts` uses SDK `PoolUtils.computeAmountOut` on cached pool and decoded tick-array bytes, plus the CLMM fee-config and bitmap-extension accounts. Every updated account carries an independent slot and observation timestamp; only dependencies within the configured age/slot limits are treated as locally usable. The initial SDK snapshot is still required to discover the tick-array set, mint metadata and compute context, and periodic SDK refreshes remain for reconciliation. The scanner deliberately does not claim atomic state, verified execution fees or synchronized epochs across all third-party services.
- **Read-only SDK reference check:** A cooldown-limited `POST /api/actions/validate` checks one locally ready Whirlpool against an independent Orca RPC SDK quote, recording raw-unit differences and `match`, `mismatch`, `inconclusive` or `error`. Unrelated tick-array RPC slots mean even a `match` is **observational parity, not same-slot or execution validation**.
- **Diagnostics:** `GET /api/c2`, `GET /api/dashboard` (`c2`), and `GET /api/explorer` (`summary.c2`) show cached quotes, locally ready pools, SDK fallbacks, CLMM slot-bounded pools, quote computations, errors and reference-match counters. The two dashboards have C2 health panels; the Activity Explorer can request a comparison through its **Verify SDK quote** button. Quote rows distinguish locally derived SDK math from SDK/RPC reads.
- **Safety and rollout:** `C2_LOCAL_QUOTES_ENABLED=1` is on by default. Use `C2_LOCAL_QUOTES_ENABLED=0` to restore the B5.2 RPC-backed quoting path if the C2 feed exhibits a live provider compatibility issue. No signing, wallet transaction or broadcast path is included.

### Important interpretation

A pool can be C1 **ready** with only its pool account while the C2 pricing state remains **unready** because price-sensitive tick arrays, fee config, bitmap extension, or oracle data are missing or outside the research freshness window. **Do not** interpret these values as confirmed executable arbitrage. We still need independent exchange-state parity testing across diverse real pool snapshots and shadow-trade economics before even considering live orders. C2 shortens the code path *once snapshots are ready*; it does not guarantee the provider actually delivers those snapshots quickly enough.

### Windows PowerShell run and diagnostics

```powershell
git pull origin main
npm.cmd install
npm.cmd run build
npm.cmd test
npm.cmd run dev
```

Open `http://127.0.0.1:8787/` (Explorer) or `http://127.0.0.1:8787/terminal`. In another window:

```powershell
$d = Invoke-RestMethod http://127.0.0.1:8787/api/dashboard
$d.c2 | Format-List
$d.c2.orcaLocal | Format-List
$d.c2.clmmLocal | Format-List
$d.opportunities | Select-Object total,comparable,excluded,positive,bestComparableNetUsd

# Optional, once local state is ready. This is quote research, NOT trading:
Invoke-RestMethod -Method Post http://127.0.0.1:8787/api/actions/validate
# After the comparison returns asynchronously:
(Invoke-RestMethod http://127.0.0.1:8787/api/c2).referenceValidation | Format-List
```

**C2 success criteria for the live test:** at least one Whirlpool or CLMM pool with all needed, slot-bounded account dependencies; growing offline quote counts without a corresponding RPC request per calculation; reference comparisons annotated with exact output deltas; and unaltered quote-age and slot rejection rules. A passing build/test suite only establishes fixture correctness. Real throughput and profitability remain **unproven** until live diagnostics and economic testing.


## C2.1 — unquotable Whirlpool inputs and SDK validation acknowledgement

Field observation: one Whirlpool repeatedly returned `Swap input value traversed too many arrays`, while `POST /api/actions/validate` returned `accepted: true` even though `referenceValidation.checks` stayed at zero. One route was freshness-qualified but had negative estimated net; this is **not** proof of pricing accuracy or realized profit.

Fixes:
- Deterministic tick-array traversal failures now count as **unquotable exact-input sizes**, not repeated local code errors. The local calculator remembers the failing pool/direction/input for identical *pool and tick account bytes*, skips repeat attempts, and automatically retries after relevant account bytes change. The memo is bounded to 512 entries. Diagnostics expose `activeUnquotableSizes`, `skippedUnquotableRecomputations`, and `unquotableQuotes` under `c2.orcaLocal`.
- Newer pool/tick observations that cannot be priced **invalidate** the previous Orca quote for research purposes. The quote remains displayed as an **Invalidated** last-known observation in the explorer, but the engine and route combiner filter it out. Pool coverage shows the exclusion reason.
- `POST /api/actions/validate` now returns `accepted: true` only if the Orca monitor actually started the independent SDK/RPC comparison. Busy scans and no usable exact-input pool return `accepted: false` with an explanation, without consuming the 60s cooldown. `/api/c2.referenceValidation` exposes `running`, `requests`, `rejectedRequests`, `lastRejection`, `checks` and `last`. An in-progress check can initially have `checks: 0` while `running: true`; that is expected.
- The accepted check still compares **independent** SDK/RPC snapshots and is not executable-route validation. Don't claim a same-slot result unless all relevant component slots are observed and reconciled.

Windows PowerShell diagnostics:

```powershell
git pull origin main
npm.cmd run build
npm.cmd test
npm.cmd run dev
```

Open a second PowerShell window:

```powershell
$d = Invoke-RestMethod http://127.0.0.1:8787/api/dashboard
$d.c2.orcaLocal | Select-Object readyPools,localCalculations,localErrors,activeUnquotableSizes,skippedUnquotableRecomputations | Format-List
$d.c2.orcaLocal.unquotableQuotes | Select-Object pool,direction,inputRaw,reason,skipCount | Format-Table -AutoSize
$d.orca | Select-Object invalidatedPools,skippedUnquotablePools
$d.b5 | Select-Object quoteMode,activeSizesUsd
$d.opportunities.comparableRoutes | Select-Object sizeUsd,inputUsdcRaw,outputUsdcRaw,grossUsd,assumedCostUsd,indicativeNetUsd,buyPool,sellPool,raydiumModel,quoteAgeMs,slotGap | Format-List
```

Request an optional SDK parity check **when the Orca scanner is idle**:

```powershell
try {
 $result = Invoke-RestMethod -Method Post http://127.0.0.1:8787/api/actions/validate
 $result | Format-List
 if($result.accepted) {
  for($i=0; $i -lt 45; $i++) {
   Start-Sleep -Seconds 2
   $status = (Invoke-RestMethod http://127.0.0.1:8787/api/c2).referenceValidation
   if(-not $status.running){ break }
  }
  $status | Select-Object requests,rejectedRequests,checks,matches,mismatches,inconclusive,lastRejection | Format-List
  $status.last | Format-List
 }
} catch {
 $_.Exception.Message
 (Invoke-RestMethod http://127.0.0.1:8787/api/c2).referenceValidation | Format-List
}
```

If the selected trade size is larger than the pool's viable tick-array traversal, **do not lower the liquidity, timestamp, or slot safeguards** to manufacture a trade. Choose another pool or evaluate a smaller exact input as a separate research experiment. An SDK result with different tick-array slots remains inconclusive even when raw outputs happen to match.


## Phase C3A — real mainnet transaction evidence (read-only, on demand)

C3A is a historical sampling and attribution tool designed to answer: **Are there observed on-chain multi-DEX transactions worth investigating, and what can the RPC data actually prove?** C3A does not invent profitable trades, automatically execute transactions, or measure net USDC earnings from SOL costs without a historical price oracle.

### Current capabilities

- Samples **recent signatures mentioning selected monitored pool-state addresses**, spanning Raydium AMM V4, Raydium CLMM and Orca Whirlpool where available. A transaction can touch a watched pool without being an arbitrage; this is a **sample**, not full indexing or exhaustive search.
- Fetches confirmed parsed mainnet transactions from a separate historical RPC `Connection`. It prefers `C3_HISTORY_RPC_URL`, then `SOLANA_BACKUP_RPC_URL`, then `SOLANA_RPC_URL`, so historical research will not enter the live quote engine's global HTTP queue. It has its **own** conservative limiter; the shared provider can still experience aggregate load.
- Extracts signature, block time, slot, executed supported DEX program calls (from transaction logs), parsed token-transfer count, touched mints, fee-payer USDC inventory deltas (when token-account ownership is known), other changed mint balances, fee-payer native SOL delta and transaction network fee in lamports.
- Reports statuses: `failed_transaction`, `no_detected_multi_swap`, `fee_payer_unattributed`, `inventory_open`, `usdc_nonpositive`, and `positive_usdc_before_sol_costs`. **Even the last status is NOT a verified arbitrage or a proven profitable trade:** USDC may have come from another transfer; the real searcher's beneficiary may be a PDA, and network fees, tips, rent, or execution risk may change the outcome.
- Keeps `profitability: "unverified"`, `jitoTipLamports: null`, `netBusinessProfitUsd: null`, and `verifiedProfitableTransactions: 0`. It does not assume a USD value for SOL-denominated fees or guess Jito tips.
- Writes limited extracted observations to `DATA_DIR/c3-onchain-evidence.jsonl`, not full private transaction objects or API credentials; loads recent records again on restart. The `data/` directory remains ignored by Git.
- Offers `GET /api/c3` (observations, progress, classification counts, errors and limitations) and `POST /api/actions/c3-analyze` (starts a request). It is opt-in and subject to a 5-minute cooldown to protect your historical RPC budget.
- Adds an **On-chain Evidence** tab and **Sample chain** button in the Activity Explorer at `http://127.0.0.1:8787/`. This is distinct from the unimplemented *full transaction indexer* and from the app's nonexistent executed wallet trades.

### Run and inspect

```powershell
git pull origin main
npm.cmd install
npm.cmd run build
npm.cmd test
npm.cmd run dev
```

In a second PowerShell window, start one sample, then poll status:

```powershell
$r = Invoke-RestMethod -Method Post http://127.0.0.1:8787/api/actions/c3-analyze
$r | Format-List
if($r.accepted){
  for($i=0; $i -lt 60; $i++){
    Start-Sleep -Seconds 2
    $e = Invoke-RestMethod http://127.0.0.1:8787/api/c3
    if(-not $e.running){break}
  }
  $e.progress | Format-List
  $e.summary | Format-List
  $e.summary.topDexPrograms | Format-Table -AutoSize
  $e.observations | Select-Object -First 12 signature,status,slot,feePayerUsdcDeltaUsd,networkFeeLamports,dexPrograms | Format-List
  $e.errors
}
```

Watch `progress.transactionsAnalyzed`, `summary.counts`, and `summary.topDexPrograms`. A result of zero positive candidates only says none were attributed in the **sample**, not that profitable arbitrage doesn't exist.

### C3A completion boundaries

C3A is a **first-pass independent evidence collector**, not a validated historical winner ledger. Reconstructing complete per-instruction swap paths (including program-derived inventories), separately detecting and costing Jito tips, historical SOL/USDC fee conversion, and full pool/token-wide indexing require deeper decoding or an indexed data source. Those are the next evidence-quality priorities before using historical winners to choose new live strategies.

The local scanner still monitors the existing C2 SOL/USDC routes. C3A does not add liquidity venues or route directions to the live engine yet. **No signing, orders, wallet actions or transaction broadcasting** have been enabled.


## Phase C3B — fast event-driven 2-leg and 3-leg scanner (read-only)

C3B expands live research without generating a separate RPC quote request for every candidate:

**Existing SOL/USDC engine:**
- Keeps C2's one-size `fast` Orca pricing path (e.g. `B5_QUOTE_SIZES_USD=5000`).
- When `C2_LOCAL_QUOTES_ENABLED=1`, evaluates BOTH Orca → Raydium and Raydium → Orca by using local Whirlpool exact-input swaps from verified cached tick-array state. `fast` no longer means reverse paths are deliberately omitted.
- Enumerates two-leg routes across **distinct liquidity pools**, including Raydium↔Raydium, Orca↔Orca, CLMM↔AMM V4 and CLMM↔CLMM where the corresponding exact local quote exists. **No price interpolation** or fabricated reverse amounts. A missing/invalid/stale quote is a miss.
- Adds `b5.localReverseHits` and `b5.localReverseMisses` diagnostics to `GET /api/dashboard`.

**New multi-token graph:**
- Discovers a bounded sample of Raydium AMM V4 pools across six pairs of USDC, SOL, USDT and JUP. Validates program ownership, pool account data, allowed mint pair, vault owner and balances. It does not silently label unsupported pools as quoteable.
- Subscribes to pool and vault accounts via the existing deduplicated C1 WebSocket feed, then refreshes pool snapshots in batched on-chain RPC reads. Subsequent WS changes trigger coalesced **local** route calculations with no HTTP quote call on the hot path.
- Searches all contiguous, **distinct-pool** USDC-rooted 2-leg and 3-leg cycles. Each leg uses the exact integer output of the previous leg as its next input; AMM V4 swap fees and price impact are applied on each leg. Routes are subject to quote-age, inter-pool timestamp gap, slot skew and reported liquidity screens.
- By default probes `$500`, `$2,500` and `$5,000`, with `$5,000` retained as the largest probe. A path can be profitable-looking for a smaller input but negative at $5k. All candidate counts and scores are **research estimates only**.
- Caps pool discovery, per-pair candidates, path checks and displayed results so higher event rates do not cause unlimited CPU or RPC work.
- Exposes `GET /api/c3/graph`: `trackedPools`, `eligiblePools`, `twoLegCycles`, `threeLegCycles`, `positiveIndicative`, `pathChecks`, `elapsedMs`, `truncated`, route details and `errors`. A new **Multi-hop Radar** tab in the explorer shows the best research cycles.

**Important boundaries:**
- C3B's multi-token graph currently prices **Raydium AMM V4 only**. Orca/CLMM are still monitored on the existing SOL/USDC engine but are not yet generic multi-token graph adapters. This means the multi-token graph can miss all paths that rely on those venues. Zero 3-leg cycles can mean missing liquidity/program coverage.
- Local computations are *not* atomic, same-slot, transaction-simulated, or guaranteed execution. `assumedCostUsd` is an estimate, and **Jito tips, priority fees, slippage and landing are not measured**. Positive output never means proven profit.
- Historical C3A evidence and live C3B graph quotes are distinct research sources. This upgrade does not send or sign transactions, and it does not assert a profitable edge.

### Run on Windows

```powershell
git pull origin main
npm.cmd install
npm.cmd run build
npm.cmd test
npm.cmd run dev
```

Inspect the graph in a second PowerShell session:

```powershell
$g = Invoke-RestMethod http://127.0.0.1:8787/api/c3/graph
$g | Select-Object status,trackedPools,watchedAccounts,eligiblePools,stalePools,pathChecks,truncated,elapsedMs,twoLegCycles,threeLegCycles,positiveIndicative,bestIndicativeNetUsd | Format-List
$g.candidates | Select-Object -First 15 legs,tokenPath,poolPath,sizeUsd,indicativeNetUsd,maxSlotGap | Format-List
$g.errors
```

Compare fast SOL/USDC cross-pool evaluations:

```powershell
$d = Invoke-RestMethod http://127.0.0.1:8787/api/dashboard
$d.b5 | Select-Object quoteMode,activeSizesUsd,routeEvaluations,localReverseHits,localReverseMisses,unmonitoredReverseDirections | Format-List
$d.opportunities | Select-Object total,comparable,positive,bestComparableNetUsd | Format-List
```

Tuning: The default graph uses `C3_GRAPH_MAX_POOLS=18` and `C3_GRAPH_RECONCILE_MS=15000`. Start with this budget before increasing pools; the same Helius RPC and WebSocket provider is shared with the existing scanner, and more subscriptions can worsen delivery or rate limits. Use `C3_GRAPH_ENABLED=0` to disable the graph without affecting C2. The full parameter list is in `.env.example`.


## Phase C3B.1 — Raydium CPMM + safe depth-aware route expansion

C3B.1 adds **Raydium CPMM** to the C3B live multi-token graph alongside
Raydium AMM V4. The original B5/C2 Orca and Raydium CLMM SOL/USDC engine
continues operating independently. C3B.1 does **not** yet route multi-token
Orca Whirlpool, Raydium CLMM, Meteora or CEX order books into the same graph.

- Raydium six-pair discovery now validates BOTH V4 and CPMM on-chain pool
  account owners before selecting the pool universe; `C3_GRAPH_PER_PAIR=6`
  and `C3_GRAPH_MAX_POOLS=24` by default, with hard bounded budgets.
  Discovering 11 API candidates does not guarantee 11 quotable pools.
- CPMM reads the 637-byte Anchor `PoolState`, two SPL vaults and the
  **236-byte fee config account**. Its active trade fee and optional creator
  fee are read from the on-chain config, not from a fixed assumed percentage.
  Effective reserves deduct accrued protocol, fund and creator fees.
  A creator fee charged on input vs output affects exact-input integer math.
  Pools with unknown layout, paused swaps, uninitialized/future swaps,
  Token-2022 vaults or missing/stale config state are excluded.
- Pool, vault and fee-config accounts are watched through the deduplicated C1
  WebSocket cache; a changed fee config triggers a new local calculation.
  Bounded RPC batch reconciliation fills missed updates but **does not**
  request a separate HTTP quote for every potential route.
- Each hop now has an explicit **input reserve-depth gate**:
  `C3_GRAPH_MAX_POOL_INPUT_BPS=500` rejects sizes consuming more than
  **5% of that pool's effective INPUT reserve**, regardless of API TVL.
  This is a conservative *heuristic*, not an execution guarantee.
  It can reject a $5,000 route while retaining a smaller $500 route.
- `GET /api/c3/graph` now includes
  `discoveryStats.validatedCpmm`, `depthRejected`, and per-hop
  `hops[].program` values (`raydium_amm_v4` / `raydium_cpmm`).
  The explorer **Multi-hop Radar** tab shows DEX types and exclusions.

### Quick inspection

```powershell
git pull origin main
npm.cmd install
npm.cmd run build
npm.cmd test
npm.cmd run dev
```

Run in another terminal after discovery:

```powershell
$g = Invoke-RestMethod http://127.0.0.1:8787/api/c3/graph
$g | Select-Object status,trackedPools,eligiblePools,stalePools,twoLegCycles,threeLegCycles,pathChecks,depthRejected,positiveIndicative,elapsedMs | Format-List
$g.discoveryStats | Format-List
$g.candidates | Select-Object -First 12 legs,sizeUsd,indicativeNetUsd,@{N='Route';E={$_.tokenPath -join ' -> '}},@{N='DEX';E={$_.hops.program -join ' -> '}} | Format-Table -AutoSize
$g.errors
```

Local C3B.1 tests cover on-chain binary layouts and discriminators, wrong
owners, effective reserve accounting, input/output creator fees, exact output
chaining, pool-depth exclusion, independent V4/CPMM routes and a mocked
fee-config WebSocket update with no incremental HTTP quote call.

**No profits are verified**: the V4 reserve approximation excludes some
OpenBook inventory, independent account updates are not atomic, exact
transport/landing fees and tips remain unknown, and no wallet or
transaction-broadcast capability is enabled.

Reference for CPMM account structure and changing fee semantics:
Raydium official cp-swap on-chain PoolState and AmmConfig source
(`raydium-io/raydium-cp-swap`) and Raydium CPMM fee docs. Independent
RPC/SDK quote comparison and complete transaction simulation remain
required before relying on any positive P&L estimate.


## Phase C3C — Multi-token concentrated-liquidity research (Orca + Raydium)

C3C extends the **read-only** C3 USDC-rooted two-hop and three-hop graph to
Orca Whirlpool and Raydium CLMM pools alongside Raydium AMM V4 and CPMM.
Supported whitelist: `USDC`, `SOL`, `USDT`, `JUP`. There is no trade
execution, wallet signing, Jito submission or flashloan support.

- Discovery checks actual program ownership and on-chain mint addresses.
  Raydium CLMM candidates come from the same six-pair Raydium discovery API;
  Orca pools come from the Orca public pool registry and are independently
  validated on chain. Discovery metadata is **not** a trusted price.
- Exact-input concentrated quotes use existing Orca and Raydium SDK tick-array
  math. A missing/uninitialized required tick array, outdated snapshot,
  invalid owner, stale slot context, unknown token program or SDK error yields
  **no route**, rather than an invented price or linear spot estimate.
- C3C owns isolated account-cache dependencies and pool refreshes, leaving
  B5/C2 SOL/USDC monitoring unchanged. The graph's existing `C3_GRAPH_*`
  configuration controls whitelist discovery, per-pair budgets, refresh and
  route searches. C3C separately caps CLMM SDK bootstrap to six pools because
  concentrated liquidity needs additional RPC tick/config reads.
- For a concentrated pool with no meaningful constant-product input reserve,
  the `C3_GRAPH_MAX_POOL_INPUT_BPS` depth gate uses API TVL as a *coarse USD
  participation limit*. This is less precise than the V4/CPMM raw-reserve
  gate; SDK tick traversal is still authoritative for full-input feasibility.
- `GET /api/c3/graph` includes `concentrated.trackedOrca`,
  `concentrated.trackedClmm`, `readyOrca`, `readyClmm`,
  `validatedOrca`, `validatedClmm`, `quotesAttempted`, `quoteMisses`,
  and `discoveryErrors`. The graph cycle `hops[].program` identifies
  `orca_whirlpool` and `raydium_clmm` where applicable.

Check the new graph after bootstrap (a new PowerShell session):

```powershell
$g = Invoke-RestMethod http://127.0.0.1:8787/api/c3/graph
$g.concentrated | Format-List
$g | Select-Object status,trackedPools,eligiblePools,stalePools,twoLegCycles,threeLegCycles,positiveIndicative,bestIndicativeNetUsd | Format-List
$g.candidates | Select-Object -First 12 legs,sizeUsd,indicativeNetUsd,@{N='Route';E={$_.tokenPath -join ' -> '}},@{N='DEX';E={$_.hops.program -join ' -> '}} | Format-Table -AutoSize
$g.errors
```

A positive `indicativeNetUsd` is **not** realized or executable profit.
There is no same-slot atomic multi-pool snapshot, transaction simulation,
precise landing-cost model, confirmed fill, or independently verified P&L.

### C3C.1 — Concentrated pool readiness diagnostics

If `validatedClmm` or `validatedOrca` is greater than `readyClmm` or
`readyOrca`, the pools exist on chain but their **exact-input local quotes
are not ready**. This is not evidence of a profitable or failed trade.

C3C.1 waits for Raydium CLMM discovery before starting the SDK refresh loop
(preventing a zero-pool bootstrap that can skip the first real scan). It also
reports each tracked concentrated pool's identity, token pair, readiness and
available missing-account/age/slot-skew reason through `/api/c3/graph`.
It does **not** relax freshness or tick-array validation.

```powershell
$g = Invoke-RestMethod http://127.0.0.1:8787/api/c3/graph
$g.concentrated.clmmScan | Format-List
$g.concentrated.clmmPools |
  Select-Object pair,pool,status,reason,ageMs,tickArrays,tickArraySlotVerified |
  Format-Table -AutoSize
$g.concentrated.orcaPools |
  Select-Object pair,pool,state,reason | Format-Table -AutoSize

$m = Invoke-RestMethod http://127.0.0.1:8787/api/market-data
$m.pools | Where-Object { $_.pool -like 'c3c:*' } |
  Select-Object pool,state,accounts,present,oldestAgeMs,slotSkew |
  Format-Table -AutoSize
```

An absent CLMM tick, config or bitmap account, mismatched owner, stale
component or excessive slot gap keeps its pool **excluded**. Increasing the
number of tracked pools cannot fix missing/invalid SDK tick snapshots.


## C3D.1 — In-place dynamic SPL discovery, wSOL arbitrage and dual-active RPC

The existing C3 multi-hop graph has been **upgraded in place** (no parallel
C3D scanner). It dynamically discovers classic SPL-token mints, finds
Raydium pools and Orca Whirlpools using those mints, and starts/ends its
two- and three-hop research cycles in **wSOL**. The legacy C2 SOL/USDC
comparison panel still exists for continuity; only the C3 graph has
changed its asset universe and base currency.

**Discovery pipeline:** Jupiter Tokens V2 `recent`, `toptrending/5m` and
`toptraded/5m` (when a `JUPITER_API_KEY` is configured) plus public
DexScreener token profiles, token boosts and SOL-pair activity. Each
candidate is deduplicated by its **mint**, then the shared Solana RPC
checks that it is an initialized, classic SPL mint and reads decimals
from the mint account. Token-2022 tokens are currently excluded from
dynamic discovery because the existing V4/CPMM path requires classic
SPL token accounts. Token labels are *display metadata only*.

**Pool discovery:** the C3 monitor retains the SOL/USDC/USDT bridge pairs
and rotates a bounded set of `SOL / SPL` and `USDC / SPL` pair searches
through Raydium. Pools are not trusted based on public metadata alone:
account owner, binary layout and on-chain mint pair are validated before
joining the graph. Existing Orca Whirlpool and Raydium CLMM quote
adapters are updated with the live mint registry. Pools from earlier
rotation windows can stay subscribed while they remain in the active
token universe, up to configured limits.

**Local evaluation:** a route always begins and ends at wSOL, using
9-decimal raw lamports, forwarding each exact hop output into the next
hop. The API reports `sizeSol`, `inputWsolRaw`,
`outputWsolRaw`, `grossSol`, `indicativeNetSol` and `symbolPath`.
The top-level `bestIndicativeNetSol` replaces the previous USDC
metric for this engine. Both positive and negative observations remain
visible. The optional `C3D_ASSUMED_COST_SOL` defaults to zero for
raw opportunity discovery; this is NOT a net execution guarantee.
The V4/CPMM depth gate still uses actual pool input reserves, while
concentrated-liquidity SDK tick traversal decides whether a swap is
quotable for a given input. We do not fabricate a SOL/USD valuation
to pretend a CLMM has constant-product vault depth.

**Active-active Solana HTTP RPC:** set **both**
`SOLANA_RPC_URL` and `SOLANA_BACKUP_RPC_URL`, then
`RPC_DUAL_ACTIVE=1`. The transport alternates new reads between
providers, with independently configurable pacing, concurrent
request slots, backoff, and failover. WebSocket subscriptions still
use `SOLANA_WS_URL` on the original primary. Exact limits vary by
provider tier: increase concurrency only while 429s, backlog and
snapshot slot gaps stay acceptable.

### Recommended starting settings

```dotenv
C3D_ENABLED=1
C3D_MAX_TOKENS=50
C3D_TOKEN_REFRESH_MS=60000
C3D_POOL_REFRESH_MS=45000
C3D_POOL_QUERY_BUDGET=80
C3D_POOL_QUERY_CONCURRENCY=8
C3D_MIN_POOL_LIQUIDITY_USD=5000
C3D_SIZES_SOL=0.05,0.1,0.25,0.5,1,2
C3D_ASSUMED_COST_SOL=0
RPC_DUAL_ACTIVE=1
RPC_HTTP_MIN_SPACING_MS=150
RPC_HTTP_MAX_CONCURRENT=3
RPC_SECONDARY_HTTP_MIN_SPACING_MS=150
RPC_SECONDARY_HTTP_MAX_CONCURRENT=3
```

The above settings do not override values already present in your
personal `.env`; update those entries explicitly. Setting
`C3D_ENABLED=0` restores legacy fixed-asset USDC graph research
without changing the C2 monitor.

### Verify it locally

```powershell
git pull origin main
npm.cmd install
npm.cmd run build
npm.cmd test
npm.cmd run dev
```

In another PowerShell window:

```powershell
$t = Invoke-RestMethod http://127.0.0.1:8787/api/c3/tokens
$t | Select-Object status,activeTokens,discovered,verifiedMints,refreshes,lastDurationMs | Format-List
$t.sourceCounts
$t.sourceErrors
$t.tokens | Select-Object -First 20 symbol,mint,decimals,score,categories | Format-Table -AutoSize

$g = Invoke-RestMethod http://127.0.0.1:8787/api/c3/graph
$g | Select-Object baseAsset,trackedPools,eligiblePools,twoLegCycles,threeLegCycles,positiveIndicative,bestIndicativeNetSol | Format-List
$g.dynamicPoolDiscovery | Format-List
$g.candidates | Select-Object -First 20 legs,sizeSol,indicativeNetSol,
  @{N='Route';E={$_.symbolPath -join ' -> '}},
  @{N='DEX';E={$_.hops.program -join ' -> '}} | Format-Table -AutoSize

$r = Invoke-RestMethod http://127.0.0.1:8787/rpc
$r | Select-Object mode,inFlight,peakInFlight,primaryAssigned,secondaryAssigned,failovers | Format-List
$r.primary | Format-List
$r.secondary | Format-List
```

### Scope boundary

C3D.1 is **dynamic token discovery and the upgraded existing graph**,
not Meteora DLMM/DAMM, PumpSwap swap math or live transaction building.
Those DEX adapters require a separate protocol implementation before
their pools can be evaluated with correct local exact-input math.
No wallet signing, bundle submission or autonomous execution is
introduced by this update.

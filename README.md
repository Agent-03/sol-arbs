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

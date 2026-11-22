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

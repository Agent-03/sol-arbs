# SOL ARB — Phase A Solana Pool Monitor

Read-only TypeScript/Node.js account monitoring with **automatic SOL/USDC pool discovery** from Raydium and Orca, validated against Solana mainnet account existence. WebSocket subscriptions and RPC reconciliation record slot, owner, data hash, and observed time in JSONL.

**No wallets, swaps or arbitrage calculations are implemented.** The external discovery APIs may change; warnings indicate missing or failed venues. Discovery checks token mints in registry responses and confirms accounts are on-chain; this does not constitute a cryptographic or program-layout audit of each pool.

## Quick start (Node.js 20+)

```powershell
git pull origin main
npm.cmd install
Copy-Item .env.example .env
notepad .env
npm.cmd run build
npm.cmd test
npm.cmd run dev
```

If `.env` already exists, **keep it** and simply leave `POOL_ADDRESSES=` blank. Configure `SOLANA_RPC_URL` (and optionally `SOLANA_WS_URL`) with your own mainnet RPC endpoints.

Dashboard/API endpoints:

- `http://127.0.0.1:8787/health`: monitored pool health
- `http://127.0.0.1:8787/pools`: tracked account snapshots
- `http://127.0.0.1:8787/discovery`: discovered pools with venue and warnings

Events journal locally into `data/YYYY-MM-DD.jsonl`, excluded from Git. Keep credentials in local `.env`, never in GitHub.

## Current constraints

The scanner loads a bounded set of discovered pools on startup; it does **not** yet periodically refresh the list or inspect vault/tick/bin-array accounts. When data remains quiet, account update age may be marked stale despite an available RPC. Backfill/polling cannot guarantee observing all intermediate states. On restart, the journal is not replayed. This is an account-data foundation only, not an executable arbitrage signal.

For Phase B, implement actual program-owner and account-layout verification, vault subscriptions, exact DEX-specific quotes, routing and total transaction cost simulation.

Source discovery API: Raydium v3 `/pools/info/mint`; Orca `/v2/solana/pools`.

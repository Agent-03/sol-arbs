# SOL ARB — Phase A Solana Pool Monitor

Read-only TypeScript + Node.js collector for verified Solana mainnet AMM pool state accounts. Uses WebSocket subscriptions plus periodic RPC reconciliation, tracks last observed slots and data hashes, and journals events to local JSONL files.

**No live trading, wallets, or arbitrage calculations are implemented.** This Phase A starter does not decode AMM reserves, order-book data, fees or executable swap prices.

## Quick start (Node.js 20+)

```powershell
git clone https://github.com/Agent-03/sol-arbs.git
cd sol-arbs
npm install
Copy-Item .env.example .env
notepad .env
npm run build
npm test
npm run dev
```

Configure `.env` with your **private** Solana mainnet HTTPS RPC and WSS endpoints, and comma-separated **verified AMM pool state account addresses**, not token mints. The application intentionally refuses to start without them; no addresses have been invented.

Inspect `http://127.0.0.1:8787/health` and `http://127.0.0.1:8787/pools`. Account update metadata is journaled to `data/YYYY-MM-DD.jsonl`. The `.env` and `data/` directories are gitignored.

## Configuration

| Variable | Purpose |
|---|---|
| `SOLANA_RPC_URL` | Mainnet HTTPS RPC URL |
| `SOLANA_WS_URL` | Mainnet WSS URL |
| `POOL_ADDRESSES` | Verified AMM pool state accounts |
| `POLL_INTERVAL_MS` | Reconcile interval (default 15000) |
| `STALE_AFTER_MS` | Update-age threshold (default 30000) |
| `HEALTH_PORT` | Local API port (default 8787) |
| `DATA_DIR` | JSONL output directory (default ./data) |

## Caveats and next steps

The starter hasn't been verified against a live RPC in this environment. Quiet pools can appear stale even with a working connection. Polling can miss intermediate states and cannot guarantee all accounts came from a consistent on-chain snapshot. The JSONL journal is not replayed on startup. Phase B must implement pool discovery, supported DEX account layout decoding, vault/tick/bin subscriptions, exact route quotes, fee modeling, and execution simulation.

Never commit RPC API keys, private keys, or seed phrases.

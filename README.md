# SOL ARB — Phase A

Read-only Solana AMM pool account monitor. TypeScript/Node.js, RPC/WebSocket subscriptions, reconciliation and JSONL journal.

No swaps, wallet keys or trading are involved. Configure `.env` using `.env.example` (not committed).

Run `npm install`, `npm run build`, `npm test`, then `npm run dev`. Endpoints: `/health` and `/pools` on 127.0.0.1:8787.

Phase A does not decode pool prices or calculate arbitrage opportunities. Add verified AMM pool account addresses to `POOL_ADDRESSES` and mainnet RPC/WSS URLs in `.env`.

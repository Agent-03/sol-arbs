import 'dotenv/config';
import { PublicKey } from '@solana/web3.js';
export type Config={rpcUrl:string;wsUrl:string|undefined;pools:PublicKey[];pollIntervalMs:number;staleAfterMs:number;port:number;dataDir:string};
function positiveInteger(key:string,fallback:number){const n=Number(process.env[key]??fallback);if(!Number.isSafeInteger(n)||n<=0)throw new Error(`${key} must be a positive integer`);return n;}
export function loadConfig():Config{
 const rpcUrl=process.env.SOLANA_RPC_URL??'';
 if(!/^https:\/\//.test(rpcUrl))throw new Error('Set SOLANA_RPC_URL to an HTTPS mainnet endpoint');
 const wsUrl=process.env.SOLANA_WS_URL||undefined;
 if(wsUrl&&!/^wss:\/\//.test(wsUrl))throw new Error('SOLANA_WS_URL must be wss://');
 const pools=(process.env.POOL_ADDRESSES??'').split(',').map(v=>v.trim()).filter(Boolean).map(v=>new PublicKey(v));
 if(!pools.length)throw new Error('Set POOL_ADDRESSES to verified AMM pool account addresses');
 if(new Set(pools.map(p=>p.toBase58())).size!==pools.length)throw new Error('Duplicate pool addresses');
 return {rpcUrl,wsUrl,pools,pollIntervalMs:positiveInteger('POLL_INTERVAL_MS',15000),staleAfterMs:positiveInteger('STALE_AFTER_MS',30000),port:positiveInteger('HEALTH_PORT',8787),dataDir:process.env.DATA_DIR||'./data'};
}

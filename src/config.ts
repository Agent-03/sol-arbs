import 'dotenv/config';
import { PublicKey } from '@solana/web3.js';
export type Config={rpcUrl:string;wsUrl:string|undefined;pools:PublicKey[];maxPools:number;pollIntervalMs:number;staleAfterMs:number;port:number;dataDir:string};
function positiveInteger(key:string,fallback:number){const n=Number(process.env[key]??fallback);if(!Number.isSafeInteger(n)||n<=0)throw new Error(`${key} must be a positive integer`);return n;}
export function loadConfig():Config{
 const rpcUrl=process.env.SOLANA_RPC_URL??'';
 if(!/^https:\/\//.test(rpcUrl))throw new Error('Set SOLANA_RPC_URL to an HTTPS mainnet endpoint');
 const wsUrl=process.env.SOLANA_WS_URL||undefined;
 if(wsUrl&&!/^wss:\/\//.test(wsUrl))throw new Error('SOLANA_WS_URL must be wss://');
 const pools=(process.env.POOL_ADDRESSES??'').split(',').map(v=>v.trim()).filter(Boolean).map(v=>new PublicKey(v));
 if(new Set(pools.map(p=>p.toBase58())).size!==pools.length)throw new Error('Duplicate pool addresses');
 const maxPools=positiveInteger('MAX_DISCOVERED_POOLS',20);
 if(maxPools>100)throw new Error('MAX_DISCOVERED_POOLS cannot exceed 100');
 return {rpcUrl,wsUrl,pools,maxPools,pollIntervalMs:positiveInteger('POLL_INTERVAL_MS',15000),staleAfterMs:positiveInteger('STALE_AFTER_MS',30000),port:positiveInteger('HEALTH_PORT',8787),dataDir:process.env.DATA_DIR||'./data'};
}

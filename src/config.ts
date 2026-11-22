import 'dotenv/config';
import { PublicKey } from '@solana/web3.js';
import type {QuoteConfig} from './jupiter.js';
export type Config={rpcUrl:string;wsUrl:string|undefined;pools:PublicKey[];maxPools:number;pollIntervalMs:number;staleAfterMs:number;port:number;dataDir:string;ammScanIntervalMs:number;orcaScanIntervalMs:number;jupiter:QuoteConfig;};
function positiveInteger(key:string,fallback:number){const n=Number(process.env[key]??fallback);if(!Number.isSafeInteger(n)||n<=0)throw new Error(`${key} must be a positive integer`);return n;}
function nonNegativeNumber(key:string,fallback:number){const n=Number(process.env[key]??fallback);if(!Number.isFinite(n)||n<0)throw new Error(`${key} must be a nonnegative number`);return n;}
function sizes():number[]{
 const nums=(process.env.JUPITER_SIZES_USD??'5,10,25,50,80').split(',').map(v=>Number(v.trim()));
 if(!nums.length||nums.length>20||nums.some(n=>!Number.isFinite(n)||n<=0||!Number.isSafeInteger(Math.round(n*1e6))))throw new Error('JUPITER_SIZES_USD must contain 1-20 valid positive USD amounts');
 return nums;
}
export function loadConfig():Config{
 const rpcUrl=process.env.SOLANA_RPC_URL??'';
 if(!/^https:\/\//.test(rpcUrl))throw new Error('Set SOLANA_RPC_URL to an HTTPS mainnet endpoint');
 const wsUrl=process.env.SOLANA_WS_URL||undefined;
 if(wsUrl&&!/^wss:\/\//.test(wsUrl))throw new Error('SOLANA_WS_URL must be wss://');
 const pools=(process.env.POOL_ADDRESSES??'').split(',').map(v=>v.trim()).filter(Boolean).map(v=>new PublicKey(v));
 if(new Set(pools.map(p=>p.toBase58())).size!==pools.length)throw new Error('Duplicate pool addresses');
 const maxPools=positiveInteger('MAX_DISCOVERED_POOLS',20);
 if(maxPools>100)throw new Error('MAX_DISCOVERED_POOLS cannot exceed 100');
 const apiKey=process.env.JUPITER_API_KEY||undefined;
 return {rpcUrl,wsUrl,pools,maxPools,pollIntervalMs:positiveInteger('POLL_INTERVAL_MS',60000),staleAfterMs:positiveInteger('STALE_AFTER_MS',120000),port:positiveInteger('HEALTH_PORT',8787),dataDir:process.env.DATA_DIR||'./data',ammScanIntervalMs:positiveInteger('AMM_V4_SCAN_INTERVAL_MS',60000),orcaScanIntervalMs:positiveInteger('ORCA_SCAN_INTERVAL_MS',60000),
  jupiter:{apiKey,sizesUsd:sizes(),intervalMs:positiveInteger('JUPITER_SCAN_INTERVAL_MS',60000),
   minRequestSpacingMs:Math.max(apiKey?500:2200,positiveInteger('JUPITER_REQUEST_SPACING_MS',apiKey?500:2200)),
   assumedCostUsd:nonNegativeNumber('JUPITER_ASSUMED_COST_USD',0.02)}};
}

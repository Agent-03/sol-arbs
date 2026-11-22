import 'dotenv/config';
import { PublicKey } from '@solana/web3.js';
import type {QuoteConfig} from './jupiter.js';
import type {RpcLimitOptions} from './rpc.js';
import type {FreshnessRules} from './opportunities.js';
export type Config={rpcUrl:string;backupRpcUrl?:string;wsUrl:string|undefined;pools:PublicKey[];maxPools:number;pollIntervalMs:number;staleAfterMs:number;port:number;dataDir:string;ammScanIntervalMs:number;ammMaxSlotSkew:number;orcaScanIntervalMs:number;rpcLimit:RpcLimitOptions;freshness:FreshnessRules;minQuoteLiquidityUsd:number;discoveryRefreshMs:number;noProfitDiscoveryMs:number;b5MaxComponentAgeMs:number;b5ReconcileMs:number;b5OrcaRefreshMs:number;b5OrcaMinTriggerMs:number;b5QuoteSizesUsd:number[];jupiter:QuoteConfig;};
function positiveInteger(key:string,fallback:number){const n=Number(process.env[key]??fallback);if(!Number.isSafeInteger(n)||n<=0)throw new Error(`${key} must be a positive integer`);return n;}
function nonNegativeInteger(key:string,fallback:number){const n=Number(process.env[key]??fallback);if(!Number.isSafeInteger(n)||n<0)throw new Error(`${key} must be a nonnegative integer`);return n;}
function nonNegativeNumber(key:string,fallback:number){const n=Number(process.env[key]??fallback);if(!Number.isFinite(n)||n<0)throw new Error(`${key} must be a nonnegative number`);return n;}
function sizes(key='JUPITER_SIZES_USD',defaults='5,10,25,50,80'):number[]{
 const nums=(process.env[key]??defaults).split(',').map(v=>Number(v.trim()));
 if(!nums.length||nums.length>20||nums.some(n=>!Number.isFinite(n)||n<=0||!Number.isSafeInteger(Math.round(n*1e6))))throw new Error(`${key} must contain 1-20 valid positive USD amounts`);
 return nums;
}
export function loadConfig():Config{
 const rpcUrl=process.env.SOLANA_RPC_URL??'';
 if(!/^https:\/\//.test(rpcUrl))throw new Error('Set SOLANA_RPC_URL to an HTTPS mainnet endpoint');
 const backupRpcUrl=process.env.SOLANA_BACKUP_RPC_URL||undefined;
 if(backupRpcUrl&&!/^https:\/\//.test(backupRpcUrl))throw new Error('SOLANA_BACKUP_RPC_URL must be an HTTPS mainnet RPC endpoint');
 const wsUrl=process.env.SOLANA_WS_URL||undefined;
 if(wsUrl&&!/^wss:\/\//.test(wsUrl))throw new Error('SOLANA_WS_URL must be wss://');
 const pools=(process.env.POOL_ADDRESSES??'').split(',').map(v=>v.trim()).filter(Boolean).map(v=>new PublicKey(v));
 if(new Set(pools.map(p=>p.toBase58())).size!==pools.length)throw new Error('Duplicate pool addresses');
 const maxPools=positiveInteger('MAX_DISCOVERED_POOLS',20);
 if(maxPools>100)throw new Error('MAX_DISCOVERED_POOLS cannot exceed 100');
 const apiKey=process.env.JUPITER_API_KEY||undefined;
 return {rpcUrl,backupRpcUrl,wsUrl,pools,maxPools,pollIntervalMs:positiveInteger('POLL_INTERVAL_MS',60000),staleAfterMs:positiveInteger('STALE_AFTER_MS',120000),port:positiveInteger('HEALTH_PORT',8787),dataDir:process.env.DATA_DIR||'./data',ammScanIntervalMs:positiveInteger('AMM_V4_SCAN_INTERVAL_MS',60000),ammMaxSlotSkew:positiveInteger('AMM_V4_MAX_SLOT_SKEW',12),orcaScanIntervalMs:positiveInteger('ORCA_SCAN_INTERVAL_MS',60000),
  rpcLimit:{minSpacingMs:positiveInteger('RPC_HTTP_MIN_SPACING_MS',1000),maxRetries:nonNegativeInteger('RPC_HTTP_MAX_RETRIES',2),initialBackoffMs:positiveInteger('RPC_HTTP_429_BACKOFF_MS',5000),maxBackoffMs:positiveInteger('RPC_HTTP_429_MAX_BACKOFF_MS',60000)},
  freshness:{maxAgeMs:positiveInteger('B4_MAX_QUOTE_AGE_MS',15000),maxGapMs:positiveInteger('B4_MAX_QUOTE_GAP_MS',4000),maxSlotSkew:positiveInteger('B4_MAX_SLOT_SKEW',12)},
  minQuoteLiquidityUsd:nonNegativeNumber('B4_MIN_POOL_LIQUIDITY_USD',10000),
  discoveryRefreshMs:positiveInteger('DISCOVERY_REFRESH_MS',900000),noProfitDiscoveryMs:positiveInteger('NO_PROFIT_DISCOVERY_MS',300000),
  b5MaxComponentAgeMs:positiveInteger('B5_MAX_COMPONENT_AGE_MS',20000),
  b5ReconcileMs:positiveInteger('B5_RAYDIUM_RECONCILE_MS',12000),
  b5OrcaRefreshMs:positiveInteger('B5_ORCA_REFRESH_MS',15000),
  b5OrcaMinTriggerMs:positiveInteger('B5_ORCA_EVENT_COOLDOWN_MS',12000),
  b5QuoteSizesUsd:sizes('B5_QUOTE_SIZES_USD','5,10,25'),
  jupiter:{apiKey,sizesUsd:sizes(),intervalMs:positiveInteger('JUPITER_SCAN_INTERVAL_MS',60000),
   minRequestSpacingMs:Math.max(apiKey?500:2200,positiveInteger('JUPITER_REQUEST_SPACING_MS',apiKey?500:2200)),
   assumedCostUsd:nonNegativeNumber('JUPITER_ASSUMED_COST_USD',0.02)}};
}

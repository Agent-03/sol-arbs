import 'dotenv/config';
import { PublicKey } from '@solana/web3.js';
import type {QuoteConfig} from './jupiter.js';
import type {RpcLimitOptions} from './rpc.js';
import type {FreshnessRules} from './opportunities.js';
export type Config={rpcUrl:string;backupRpcUrl?:string;wsUrl:string|undefined;pools:PublicKey[];maxPools:number;pollIntervalMs:number;staleAfterMs:number;port:number;dataDir:string;ammScanIntervalMs:number;ammMaxSlotSkew:number;orcaScanIntervalMs:number;rpcLimit:RpcLimitOptions;freshness:FreshnessRules;minQuoteLiquidityUsd:number;discoveryRefreshMs:number;noProfitDiscoveryMs:number;b5MaxComponentAgeMs:number;b5ReconcileMs:number;b5OrcaRefreshMs:number;b5OrcaMinTriggerMs:number;b5QuoteSizesUsd:number[];b51ClmmMaxPools:number;b51ClmmRefreshMs:number;b51ClmmMaxCacheAgeMs:number;b52OrcaQuoteMode:'fast'|'full';c2LocalQuotesEnabled:boolean;
 c3HistoryRpcUrl?:string;c3SamplePoolCount:number;c3SignaturesPerPool:number;
 c3MaxTransactions:number;c3ScanCooldownMs:number;c3HistoryMinSpacingMs:number;
 c3GraphEnabled:boolean;c3GraphMaxPools:number;c3GraphPerPair:number;
 c3GraphRefreshMs:number;c3GraphReconcileMs:number;
 c3GraphMaxPathChecks:number;c3GraphMaxResults:number;
 c3GraphMinLiquidityUsd:number;c3GraphSizesUsd:number[];c3GraphMaxPoolInputBps:number;
 dualRpcEnabled:boolean;secondaryRpcLimit:RpcLimitOptions;
 c3dEnabled:boolean;c3dMaxTokens:number;c3dTokenRefreshMs:number;
 c3dPoolRefreshMs:number;c3dPoolQueryBudget:number;c3dPoolConcurrency:number;
 c3dMinPoolLiquidityUsd:number;c3dSizesSol:number[];c3dAssumedCostSol:number;
 c3d2RegistryEnabled:boolean;c3d2RegistryTokensPerRefresh:number;
 c3d2RegistryConcurrency:number;c3d2RegistryMaxPools:number;
 c3d2RegistryTtlMs:number;c3d2RegistryMinLiquidityUsd:number;
 c3d4DlmmEnabled:boolean;c3d4DlmmMaxPools:number;
 c3d4DlmmConcurrency:number;c3d4DlmmRefreshMs:number;
 c3d4DlmmMaxArraysPerSide:number;
 c3d41DlmmRefreshBudget:number;c3d41DlmmRefreshConcurrency:number;
 c3d42DlmmRpcDeadlineMs:number;c3d42DlmmReindexDeadlineMs:number;
 c3d42DlmmReindexConcurrency:number;
 c3d43DlmmBootstrapConcurrency:number;
 jupiter:QuoteConfig;};
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
  rpcLimit:{
   minSpacingMs:nonNegativeInteger('RPC_HTTP_MIN_SPACING_MS',150),
   maxConcurrent:positiveInteger('RPC_HTTP_MAX_CONCURRENT',3),
   backgroundMaxConcurrent:positiveInteger('RPC_BACKGROUND_MAX_CONCURRENT',1),
   maxRetries:nonNegativeInteger('RPC_HTTP_MAX_RETRIES',2),
   initialBackoffMs:positiveInteger('RPC_HTTP_429_BACKOFF_MS',5000),
   maxBackoffMs:positiveInteger('RPC_HTTP_429_MAX_BACKOFF_MS',60000)
  },
  dualRpcEnabled:(()=>{
   const v=process.env.RPC_DUAL_ACTIVE??'1';
   if(v!=='0'&&v!=='1')throw new Error('RPC_DUAL_ACTIVE must be 0 or 1');
   return v==='1'&&!!backupRpcUrl;
  })(),
  secondaryRpcLimit:{
   minSpacingMs:nonNegativeInteger('RPC_SECONDARY_HTTP_MIN_SPACING_MS',150),
   maxConcurrent:positiveInteger('RPC_SECONDARY_HTTP_MAX_CONCURRENT',3),
   backgroundMaxConcurrent:positiveInteger('RPC_SECONDARY_BACKGROUND_MAX_CONCURRENT',1),
   maxRetries:nonNegativeInteger('RPC_HTTP_MAX_RETRIES',2),
   initialBackoffMs:positiveInteger('RPC_HTTP_429_BACKOFF_MS',5000),
   maxBackoffMs:positiveInteger('RPC_HTTP_429_MAX_BACKOFF_MS',60000)
  },
  freshness:{maxAgeMs:positiveInteger('B4_MAX_QUOTE_AGE_MS',15000),maxGapMs:positiveInteger('B4_MAX_QUOTE_GAP_MS',4000),maxSlotSkew:positiveInteger('B4_MAX_SLOT_SKEW',12)},
  minQuoteLiquidityUsd:nonNegativeNumber('B4_MIN_POOL_LIQUIDITY_USD',10000),
  discoveryRefreshMs:positiveInteger('DISCOVERY_REFRESH_MS',900000),noProfitDiscoveryMs:positiveInteger('NO_PROFIT_DISCOVERY_MS',300000),
  b5MaxComponentAgeMs:positiveInteger('B5_MAX_COMPONENT_AGE_MS',20000),
  b5ReconcileMs:positiveInteger('B5_RAYDIUM_RECONCILE_MS',12000),
  b5OrcaRefreshMs:positiveInteger('B5_ORCA_REFRESH_MS',15000),
  b5OrcaMinTriggerMs:positiveInteger('B5_ORCA_EVENT_COOLDOWN_MS',12000),
  b5QuoteSizesUsd:sizes('B5_QUOTE_SIZES_USD','5,10,25'),
  b51ClmmMaxPools:positiveInteger('B5_1_CLMM_MAX_POOLS',3),
  b51ClmmRefreshMs:positiveInteger('B5_1_CLMM_REFRESH_MS',45000),
  b51ClmmMaxCacheAgeMs:positiveInteger('B5_1_CLMM_MAX_CACHE_AGE_MS',60000),
  c2LocalQuotesEnabled:(()=>{
   const value=process.env.C2_LOCAL_QUOTES_ENABLED??'1';
   if(value!=='0'&&value!=='1')throw new Error('C2_LOCAL_QUOTES_ENABLED must be 0 or 1');
   return value==='1';
  })(),
  b52OrcaQuoteMode:(()=>{
   const value=process.env.B5_2_ORCA_QUOTE_MODE??'fast';
   if(value!=='fast'&&value!=='full')throw new Error('B5_2_ORCA_QUOTE_MODE must be fast or full');
   return value;
  })(),
  c3HistoryRpcUrl:(()=>{
   const url=process.env.C3_HISTORY_RPC_URL||undefined;
   if(url&&!/^https:\/\//.test(url))throw new Error('C3_HISTORY_RPC_URL must be https://');
   return url;
  })(),
  c3SamplePoolCount:positiveInteger('C3_SAMPLE_POOL_COUNT',4),
  c3SignaturesPerPool:positiveInteger('C3_SIGNATURES_PER_POOL',8),
  c3MaxTransactions:positiveInteger('C3_MAX_TRANSACTIONS_PER_SCAN',12),
  c3ScanCooldownMs:positiveInteger('C3_SCAN_COOLDOWN_MS',300000),
  c3HistoryMinSpacingMs:positiveInteger('C3_HISTORY_RPC_MIN_SPACING_MS',1500),
  c3GraphEnabled:(()=>{
   const value=process.env.C3_GRAPH_ENABLED??'1';
   if(value!=='0'&&value!=='1')throw new Error('C3_GRAPH_ENABLED must be 0 or 1');
   return value==='1';
  })(),
  c3GraphMaxPools:positiveInteger('C3_GRAPH_MAX_POOLS',24),
  c3GraphPerPair:positiveInteger('C3_GRAPH_PER_PAIR',6),
  c3GraphRefreshMs:positiveInteger('C3_GRAPH_REFRESH_MS',600000),
  c3GraphReconcileMs:positiveInteger('C3_GRAPH_RECONCILE_MS',15000),
  c3GraphMaxPathChecks:positiveInteger('C3_GRAPH_MAX_PATH_CHECKS',10000),
  c3GraphMaxResults:positiveInteger('C3_GRAPH_MAX_RESULTS',50),
  c3GraphMinLiquidityUsd:nonNegativeNumber('C3_GRAPH_MIN_LIQUIDITY_USD',50000),
  c3GraphMaxPoolInputBps:(()=>{
   const n=positiveInteger('C3_GRAPH_MAX_POOL_INPUT_BPS',500);
   if(n>10000)throw new Error('C3_GRAPH_MAX_POOL_INPUT_BPS must be <=10000');
   return n;
  })(),
  c3GraphSizesUsd:sizes('C3_GRAPH_SIZES_USD','500,2500,5000'),
  c3dEnabled:(()=>{
   const value=process.env.C3D_ENABLED??'1';
   if(value!=='0'&&value!=='1')throw new Error('C3D_ENABLED must be 0 or 1');
   return value==='1';
  })(),
  c3dMaxTokens:positiveInteger('C3D_MAX_TOKENS',50),
  c3dTokenRefreshMs:positiveInteger('C3D_TOKEN_REFRESH_MS',60000),
  c3dPoolRefreshMs:positiveInteger('C3D_POOL_REFRESH_MS',45000),
  c3dPoolQueryBudget:positiveInteger('C3D_POOL_QUERY_BUDGET',80),
  c3dPoolConcurrency:positiveInteger('C3D_POOL_QUERY_CONCURRENCY',8),
  c3dMinPoolLiquidityUsd:nonNegativeNumber('C3D_MIN_POOL_LIQUIDITY_USD',5000),
  c3dSizesSol:sizes('C3D_SIZES_SOL','0.05,0.1,0.25,0.5,1,2'),
  c3dAssumedCostSol:nonNegativeNumber('C3D_ASSUMED_COST_SOL',0),
  c3d2RegistryEnabled:(()=>{
   const v=process.env.C3D2_REGISTRY_ENABLED??'1';
   if(v!=='0'&&v!=='1')throw Error('C3D2_REGISTRY_ENABLED must be 0 or 1');
   return v==='1';
  })(),
  c3d2RegistryTokensPerRefresh:positiveInteger('C3D2_REGISTRY_TOKENS_PER_REFRESH',20),
  c3d2RegistryConcurrency:positiveInteger('C3D2_REGISTRY_CONCURRENCY',6),
  c3d2RegistryMaxPools:positiveInteger('C3D2_REGISTRY_MAX_POOLS',350),
  c3d2RegistryTtlMs:positiveInteger('C3D2_REGISTRY_TTL_MS',1200000),
  c3d2RegistryMinLiquidityUsd:nonNegativeNumber('C3D2_REGISTRY_MIN_LIQUIDITY_USD',2500),
  c3d4DlmmEnabled:(()=>{
   const v=process.env.C3D4_DLMM_ENABLED??'1';
   if(v!=='0'&&v!=='1')throw Error('C3D4_DLMM_ENABLED must be 0 or 1');
   return v==='1';
  })(),
  c3d4DlmmMaxPools:positiveInteger('C3D4_DLMM_MAX_POOLS',16),
  c3d4DlmmConcurrency:positiveInteger('C3D4_DLMM_CONCURRENCY',3),
  c3d4DlmmRefreshMs:positiveInteger('C3D4_DLMM_REFRESH_MS',8000),
  c3d4DlmmMaxArraysPerSide:positiveInteger('C3D4_DLMM_MAX_ARRAYS_PER_SIDE',3),
  c3d41DlmmRefreshBudget:positiveInteger('C3D41_DLMM_REFRESH_BUDGET',8),
  c3d41DlmmRefreshConcurrency:positiveInteger('C3D41_DLMM_REFRESH_CONCURRENCY',4),
  c3d42DlmmRpcDeadlineMs:positiveInteger('C3D42_DLMM_RPC_DEADLINE_MS',5500),
  c3d42DlmmReindexDeadlineMs:positiveInteger('C3D42_DLMM_REINDEX_DEADLINE_MS',11000),
  c3d42DlmmReindexConcurrency:positiveInteger('C3D42_DLMM_REINDEX_CONCURRENCY',2),
  c3d43DlmmBootstrapConcurrency:positiveInteger('C3D43_DLMM_BOOTSTRAP_CONCURRENCY',1),
  jupiter:{apiKey,sizesUsd:sizes(),intervalMs:positiveInteger('JUPITER_SCAN_INTERVAL_MS',60000),
   minRequestSpacingMs:Math.max(apiKey?500:2200,positiveInteger('JUPITER_REQUEST_SPACING_MS',apiKey?500:2200)),
   assumedCostUsd:nonNegativeNumber('JUPITER_ASSUMED_COST_USD',0.02)}};
}

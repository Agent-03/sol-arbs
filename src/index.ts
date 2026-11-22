import {createServer} from 'node:http';
import {Connection,PublicKey} from '@solana/web3.js';
import {loadConfig} from './config.js';
import {discoverPools} from './discovery.js';
import {Scanner} from './scanner.js';
import {JupiterMonitor} from './jupiter.js';
import {RpcProviderPool} from './rpcFailover.js';
import {MarketEngine} from './engine.js';
import {dashboardHtml} from './dashboard.js';
import {explorerHtml} from './explorerDashboard.js';
import {MarketDataFeed} from './marketData.js';
import {RpcHttpLimiter} from './rpc.js';
import {ChainHistorySampler,chooseEvidenceSeedPools} from './c3ChainHistory.js';
import {C3GraphMonitor} from './c3GraphMonitor.js';

async function main(){
 const config=loadConfig();
 const manualPools=[...config.pools];
 const jupiter=new JupiterMonitor(config.jupiter);
 const rpcLimiter=new RpcProviderPool(config.rpcUrl,config.backupRpcUrl,config.rpcLimit,
  globalThis.fetch,{dualActive:config.dualRpcEnabled,secondaryOptions:config.secondaryRpcLimit});
 const connection=new Connection(config.rpcUrl,{
  commitment:'confirmed',wsEndpoint:config.wsUrl,fetch:rpcLimiter.fetch,disableRetryOnRateLimit:true
 });
 const discovered=await discoverPools(connection,manualPools,config.maxPools);
 for(const warning of discovered.warnings)console.warn('[discovery]',warning);
 config.pools=discovered.pools.map(p=>new PublicKey(p.address));
 const marketData=new MarketDataFeed(connection,config.freshness.maxAgeMs,config.freshness.maxSlotSkew);
 const scanner=new Scanner(config,connection,marketData);
 const c3Graph=new C3GraphMonitor(connection,marketData,{
  enabled:config.c3GraphEnabled,
  maxPools:config.c3dEnabled?Math.max(config.c3GraphMaxPools,80):config.c3GraphMaxPools,
  perPair:config.c3GraphPerPair,
  refreshMs:config.c3dEnabled?config.c3dPoolRefreshMs:config.c3GraphRefreshMs,
  reconcileMs:config.c3GraphReconcileMs,sizesUsd:config.c3GraphSizesUsd,
  dynamicDiscoveryEnabled:config.c3dEnabled,maxTokens:config.c3dMaxTokens,
  tokenRefreshMs:config.c3dTokenRefreshMs,poolRequestBudget:config.c3dPoolQueryBudget,
  poolQueryConcurrency:config.c3dPoolConcurrency,apiKey:config.jupiter.apiKey,
  sizesSol:config.c3dSizesSol,assumedCostSol:config.c3dAssumedCostSol,
  maxPathChecks:config.c3GraphMaxPathChecks,maxResults:config.c3GraphMaxResults,
  minLiquidityUsd:config.c3dEnabled?config.c3dMinPoolLiquidityUsd:
   config.c3GraphMinLiquidityUsd,
  maxPoolInputShareBps:config.c3GraphMaxPoolInputBps,
  maxQuoteAgeMs:config.freshness.maxAgeMs,
  maxQuoteGapMs:config.freshness.maxGapMs,
  maxSlotSkew:config.freshness.maxSlotSkew,
  assumedCostUsd:config.jupiter.assumedCostUsd
 });

 const engine=new MarketEngine(connection,config,scanner,rpcLimiter,jupiter,discovered,manualPools,marketData);
 // History research is intentionally opt-in and uses a separate, slower HTTP
 // lane, preferring the backup endpoint. Never block quote RPC for archaeology.
 const historyRpc=new Connection(config.c3HistoryRpcUrl??config.backupRpcUrl??config.rpcUrl,{
  commitment:'confirmed',disableRetryOnRateLimit:true,
  fetch:new RpcHttpLimiter({...config.rpcLimit,
   minSpacingMs:config.c3HistoryMinSpacingMs,maxRetries:1}).fetch
 });
 const history=new ChainHistorySampler(historyRpc,config.dataDir,{
  maxSeedPools:config.c3SamplePoolCount,
  signaturesPerPool:config.c3SignaturesPerPool,
  maxTransactions:config.c3MaxTransactions,
  cooldownMs:config.c3ScanCooldownMs,maxRows:500
 });
 await history.initialize();
 console.log(JSON.stringify({event:'discovery_complete',pools:discovered.pools.length,
  validatedCandidateAccounts:discovered.validatedCount,
  theoreticalRoutes:engine.getTopology().candidates.length,warnings:discovered.warnings}));

 const server=createServer((req,res)=>{
  const path=(req.url??'/').split('?')[0];
  const send=(status:number,data:unknown)=>{
   res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store',
    'x-content-type-options':'nosniff','referrer-policy':'no-referrer'});
   res.end(JSON.stringify(data));
  };
  try{
   if((path==='/'||path==='/terminal')&&req.method==='GET'){
    res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store',
     'x-content-type-options':'nosniff','referrer-policy':'no-referrer'});
    res.end(path==='/terminal'?dashboardHtml:explorerHtml);
    return;
   }
   if(req.method==='POST'&&(path==='/api/actions/scan'||path==='/api/actions/discover'||path==='/api/actions/validate'||path==='/api/actions/c3-analyze')){
    // Loopback only: reject cross-site browser POSTs (no write actions on chain).
    const allowed='http://127.0.0.1:'+config.port;
    const origin=req.headers.origin;
    if(origin && origin!==allowed){send(403,{accepted:false,message:'Foreign origin rejected'});return;}
    const result=path.endsWith('/c3-analyze')
     ?history.request(chooseEvidenceSeedPools(engine.getDiscovered().pools,config.c3SamplePoolCount))
     :path.endsWith('/scan')?engine.requestScan():path.endsWith('/validate')
     ?engine.requestC2Validation():engine.requestDiscovery();
    send(result.accepted?202:429,result);
    return;
   }
   if(req.method!=='GET'){send(405,{error:'Method not allowed'});return;}
   const dashboard=()=>engine.dashboard();
   if(path==='/api/dashboard'){send(200,dashboard());return;}
   if(path==='/api/c2'){send(200,{phase:'C2',readOnly:true,...dashboard().c2,executableRoutes:0});return;}
   if(path==='/api/c3'){send(200,history.snapshot());return;}
   if(path==='/api/c3/graph'){send(200,c3Graph.snapshot());return;}
   if(path==='/api/c3/tokens'){send(200,c3Graph.snapshot().tokenDiscovery);return;}
   if(path==='/api/market-data'){send(200,{phase:'C1',readOnly:true,...marketData.snapshot(),warning:'Account-state cache only; SDK tick arrays may be older or from unrelated RPC contexts.'});return;}
   if(path==='/api/explorer'){
    const d=dashboard();
    const candidates=engine.assessment().candidates;
    const orca=engine.getOrca().quotedLegs;
    const raydium=engine.getRaydium().quotes;
    const clmm=engine.getClmm().quotes;
    send(200,{
     mode:'READ_ONLY',observedAt:d.now,market:config.c3dEnabled?'dynamic wSOL/SPL':'SOL/USDC',phase:config.c3dEnabled?'C3D.1':d.phase,
     summary:{status:d.status,opportunities:d.opportunities,
      utility:d.discovery.utility,orca:d.orca,clmm:d.clmm,
      raydium:d.raydium,b5:d.b5,c1:d.c1,c2:d.c2,scan:d.scan,rpc:d.rpc,
      c3Graph:{...c3Graph.snapshot(),candidates:undefined},
      c3:{running:history.snapshot().running,
       startedAt:history.snapshot().startedAt,finishedAt:history.snapshot().finishedAt,
       progress:history.snapshot().progress,summary:history.snapshot().summary}},
     chainEvidence:history.snapshot().observations.slice(0,40),
     graphCycles:c3Graph.snapshot().candidates.slice(0,40),
     routes:candidates,quotes:{orca,raydium,clmm},
     pools:d.discovery.eligibility,events:d.activity,
     transactionIndexing:false,
     notice:'These are indicative quote observations, NOT settled Solana transactions. No signatures, wallet fills, or realized profits are available.'
    });
    return;
   }
   if(path==='/rpc'){send(200,rpcLimiter.snapshot());return;}
   if(path==='/health'){
    const s=scanner.snapshot(),d=dashboard();
    send(s.status==='healthy'?200:503,{status:s.status,lastPollAt:s.lastPollAt,errors:s.errors,
     trackedPools:s.pools.length,stalePools:s.pools.filter(p=>p.stale).length,
     scan:d.scan,b5:d.b5,c1:d.c1,c2:d.c2,opportunities:{comparable:d.opportunities.comparable,positive:d.opportunities.positive},
     rpc:rpcLimiter.snapshot(),executableRoutes:0});
    return;
   }
   if(path==='/pools'){send(200,scanner.snapshot());return;}
   if(path==='/discovery'){send(200,engine.getDiscovered());return;}
   if(path==='/jupiter'){send(200,jupiter.snapshot());return;}
   if(path==='/amm-v4'){
    send(200,{...engine.getRaydium(),note:'Indicative non-executable AMM v4 pool quotes only.'});return;
   }
   if(path==='/clmm'){send(200,{...engine.getClmm(),note:'Raydium tick-array SDK research quotes; component slots not coherent or execution-verified.'});return;}
   if(path==='/orca'){
    const r=engine.getRaydium();
    send(200,{...engine.getOrca(),raydiumQuoteStatus:r.status,raydiumQuoteCount:r.quotes.length,
     raydiumErrors:r.errors});return;
   }
   if(path==='/arb'){
    const d=dashboard(),o=d.opportunities;
    send(200,{phase:'C2',status:d.status,updatedAt:d.now,b5:d.b5,
     indicativeRoutes:o.total,comparableRoutes:o.comparable,excludedRoutes:o.excluded,
     positiveComparable:o.positive,bestComparableNetUsd:o.bestComparableNetUsd,
     executableRoutes:0,raydiumQuoteStatus:d.raydium.status,raydiumQuoteCount:d.raydium.quotes,
     raydiumErrors:d.raydium.errors,errors:d.orca.errors,
     freshnessRules:o.rules,excludedByReason:o.excludedByReason,
     coverage:d.discovery.utility,poolEligibility:d.discovery.eligibility,c2:d.c2,
     clmm:{selectedPools:d.clmm.selectedPools,readyPools:d.clmm.readyPools,quotes:d.clmm.quotes},
     candidates:[...o.comparableRoutes,...o.excludedRoutes],
     rpc:d.rpc,
     warning:'B5.1 research only: Raydium CLMM SDK reads are not one-slot coherent; Orca tick arrays may lag. No validated transaction simulation or execution.'});
    return;
   }
   if(path==='/routes'){
    const s=scanner.snapshot();
    const states=new Map(s.pools.map(p=>[p.address,p]));
    const topo=engine.getTopology();
    const candidates=topo.candidates.map(candidate=>{
     const buy=states.get(candidate.buyPool),sell=states.get(candidate.sellPool);
     const rejectionReasons=['topology_only_not_simulated'];
     if(!buy||!sell||buy.stale||sell.stale)rejectionReasons.push('stale_or_missing_pool_state');
     if(buy?.slot!=null&&sell?.slot!=null&&Math.abs(buy.slot-sell.slot)>12)rejectionReasons.push('pool_slot_mismatch');
     return {...candidate,buySlot:buy?.slot??null,sellSlot:sell?.slot??null,
      rejectionReasons,executable:false,estimatedNetUsd:null};
    });
    send(200,{phase:'B1_TOPOLOGY',status:'topology_only',executableRoutes:0,
     observedAt:new Date().toISOString(),
     metrics:{discoveredPools:engine.getDiscovered().pools.length,
      rejectedPools:topo.rejectedPools,candidateRoutes:candidates.length,
      stalePools:s.pools.filter(p=>p.stale).length},
     capabilities:topo.capabilities,candidates,
     warning:'Legacy topology view. Use /arb or /api/dashboard for Phase B4 quote analysis.'});
    return;
   }
   send(404,{error:'Not found'});
  }catch(error){
   console.error('HTTP handler failed',error);
   send(500,{error:'Internal scanner error'});
  }
 });
 server.listen(config.port,'127.0.0.1',()=>{
  console.log('SOL ARB activity explorer http://127.0.0.1:'+config.port+'/');
  console.log('Original monitoring dashboard http://127.0.0.1:'+config.port+'/terminal');
  console.log('Market metrics http://127.0.0.1:'+config.port+'/api/dashboard');
 });
 jupiter.start();
 // Give C2 bootstrap priority; then discover multi-token C3 routes on the
 // same shared WS feed. C3 graph recomputations never make HTTP quote calls.
 void engine.start().then(()=>c3Graph.start()).catch(error=>{
  console.error('Engine/C3 graph start failed',error);
 });
 const stop=async()=>{
  jupiter.stop();
  server.close();
  c3Graph.stop();
  await engine.stop();
  await marketData.stop();
 };
 process.once('SIGINT',()=>{void stop();});
 process.once('SIGTERM',()=>{void stop();});
}
main().catch(error=>{console.error(error);process.exitCode=1;});

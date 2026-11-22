import {createServer} from 'node:http';
import {Connection,PublicKey} from '@solana/web3.js';
import {loadConfig} from './config.js';
import {discoverPools} from './discovery.js';
import {Scanner} from './scanner.js';
import {JupiterMonitor} from './jupiter.js';
import {buildCandidates} from './routes.js';
async function main(){
 const config=loadConfig();
 const jupiter=new JupiterMonitor(config.jupiter);
 jupiter.start();
 const validationConnection=new Connection(config.rpcUrl,'confirmed');
 const discovered=await discoverPools(validationConnection,config.pools,config.maxPools);
 for(const warning of discovered.warnings)console.warn('[discovery]',warning);
 if(!discovered.pools.length)console.warn('No validated pool accounts found: pool feed disabled; Jupiter quote monitor remains read-only.');
 config.pools=discovered.pools.map(p=>new PublicKey(p.address));
 const routes=buildCandidates(discovered.pools);
 console.log(JSON.stringify({event:'discovery_complete',pools:discovered.pools.length,routeCandidates:routes.candidates.length,rejectedPools:routes.rejectedPools,warnings:discovered.warnings}));
 const scanner=new Scanner(config);
 const server=createServer((req,res)=>{
  const path=req.url?.split('?')[0];
  if(!['/health','/pools','/discovery','/jupiter','/routes'].includes(path??'')){
   res.writeHead(404);res.end('Not found');return;
  }
  const snapshot=scanner.snapshot();
  const status=path==='/health'&&snapshot.status!=='healthy'?503:200;
  res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});
  if(path==='/health'){
   res.end(JSON.stringify({status:snapshot.status,lastPollAt:snapshot.lastPollAt,errors:snapshot.errors,trackedPools:snapshot.pools.length,stalePools:snapshot.pools.filter(p=>p.stale).length,jupiter:jupiter.snapshot().status,routeCandidates:routes.candidates.length,executableRoutes:0}));
  }else if(path==='/discovery')res.end(JSON.stringify(discovered));
  else if(path==='/jupiter')res.end(JSON.stringify(jupiter.snapshot()));
  else if(path==='/routes'){
   const state=new Map(snapshot.pools.map(p=>[p.address,p]));
   const candidates=routes.candidates.map(candidate=>{
    const buy=state.get(candidate.buyPool),sell=state.get(candidate.sellPool);
    const rejectionReasons:string[]=[];
    if(!buy||!sell||buy.stale||sell.stale)rejectionReasons.push('stale_or_missing_pool_state');
    if(buy&&sell&&Math.abs(buy.slot-sell.slot)>2)rejectionReasons.push('pool_slot_mismatch');
    rejectionReasons.push('missing_exact_swap_quoters');
    return {...candidate,buySlot:buy?.slot??null,sellSlot:sell?.slot??null,
      rejectionReasons,executable:false,estimatedNetUsd:null};
   });
   res.end(JSON.stringify({phase:'B1',status:'discovery_only',executableRoutes:0,observedAt:new Date().toISOString(),
    metrics:{discoveredPools:discovered.pools.length,eligiblePools:routes.capabilities.length-routes.rejectedPools,
      rejectedPools:routes.rejectedPools,candidateRoutes:candidates.length,stalePools:snapshot.pools.filter(p=>p.stale).length},
    capabilities:routes.capabilities,candidates,
    warning:'Route topology only. No exact quotes, transaction simulation, or realized profitability available.'}));
  }else res.end(JSON.stringify(snapshot));
 });
 server.listen(config.port,'127.0.0.1',()=>console.log(`http://127.0.0.1:${config.port}/routes`));
 const stop=async()=>{jupiter.stop();server.close();await scanner.stop();};
 process.once('SIGINT',()=>{void stop();});
 process.once('SIGTERM',()=>{void stop();});
 await scanner.start();
}
main().catch(error=>{console.error(error);process.exitCode=1;});

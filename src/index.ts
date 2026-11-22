import {createServer} from 'node:http';
import {Connection,PublicKey} from '@solana/web3.js';
import {loadConfig} from './config.js';
import {discoverPools} from './discovery.js';
import {Scanner} from './scanner.js';
import {JupiterMonitor} from './jupiter.js';
async function main(){
 const config=loadConfig();
 const jupiter=new JupiterMonitor(config.jupiter);
 jupiter.start(); // independent quote-only telemetry, even if pool discovery fails
 const validationConnection=new Connection(config.rpcUrl,'confirmed');
 const discovered=await discoverPools(validationConnection,config.pools,config.maxPools);
 for(const warning of discovered.warnings)console.warn('[discovery]',warning);
 if(!discovered.pools.length)console.warn('No validated pool accounts found: pool feed disabled; Jupiter monitor remains read-only and active.');
 config.pools=discovered.pools.map(p=>new PublicKey(p.address));
 console.log(JSON.stringify({event:'discovery_complete',pools:discovered.pools,warnings:discovered.warnings}));
 const scanner=new Scanner(config);
 const server=createServer((req,res)=>{
  const path=req.url?.split('?')[0];
  if(path!=='/health'&&path!=='/pools'&&path!=='/discovery'&&path!=='/jupiter'){res.writeHead(404);res.end('Not found');return;}
  const snapshot=scanner.snapshot();
  const status=path==='/health'&&snapshot.status!=='healthy'?503:200;
  res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});
  res.end(JSON.stringify(path==='/health'?{status:snapshot.status,lastPollAt:snapshot.lastPollAt,errors:snapshot.errors,trackedPools:snapshot.pools.length,stalePools:snapshot.pools.filter(p=>p.stale).length,jupiter:jupiter.snapshot().status}:path==='/discovery'?discovered:path==='/jupiter'?jupiter.snapshot():snapshot));
 });
 server.listen(config.port,'127.0.0.1',()=>console.log(`http://127.0.0.1:${config.port}/jupiter`));
 const stop=async()=>{jupiter.stop();server.close();await scanner.stop();};
 process.once('SIGINT',()=>{void stop();});
 process.once('SIGTERM',()=>{void stop();});
 await scanner.start();
}
main().catch(error=>{console.error(error);process.exitCode=1;});

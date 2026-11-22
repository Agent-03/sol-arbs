import {createServer} from 'node:http';
import {loadConfig} from './config.js';
import {Scanner} from './scanner.js';
async function main(){
 const config=loadConfig();
 const scanner=new Scanner(config);
 const server=createServer((req,res)=>{
  const path=req.url?.split('?')[0];
  if(path!=='/health'&&path!=='/pools'){res.writeHead(404);res.end('Not found');return;}
  const snapshot=scanner.snapshot();
  const status=path==='/health'&&snapshot.status!=='healthy'?503:200;
  res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});
  res.end(JSON.stringify(path==='/health'?{status:snapshot.status,lastPollAt:snapshot.lastPollAt,errors:snapshot.errors,trackedPools:snapshot.pools.length,stalePools:snapshot.pools.filter(p=>p.stale).length}:snapshot));
 });
 server.listen(config.port,'127.0.0.1',()=>console.log(`http://127.0.0.1:${config.port}/health`));
 const stop=async()=>{server.close();await scanner.stop();};
 process.once('SIGINT',()=>{void stop();});
 process.once('SIGTERM',()=>{void stop();});
 await scanner.start();
}
main().catch(error=>{console.error(error);process.exitCode=1;});

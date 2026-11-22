import test from 'node:test';
import assert from 'node:assert/strict';
import {PublicKey,type Connection,type AccountInfo} from '@solana/web3.js';
import {C3GraphMonitor} from '../src/c3GraphMonitor.js';
import {replaceDynamicGraphAssets,GRAPH_ASSETS} from '../src/c3Graph.js';
import {MarketDataFeed} from '../src/marketData.js';
import {RAYDIUM_AMM_V4} from '../src/routes.js';

const pk=(n:number)=>new PublicKey(Buffer.alloc(32,n)).toBase58();
const program=new PublicKey(RAYDIUM_AMM_V4);
const spl=new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const authority=PublicKey.findProgramAddressSync([Buffer.from('amm authority')],program)[0];
const info=(owner:PublicKey,data:Buffer):AccountInfo<Buffer>=>({
 owner,data,lamports:1,executable:false,rentEpoch:0
});
const mint=():AccountInfo<Buffer>=>{
 const b=Buffer.alloc(82);b[44]=6;b[45]=1;return info(spl,b);
};
function pool(base:string,quote:string,a:string,b:string):AccountInfo<Buffer>{
 const buf=Buffer.alloc(752);buf.writeBigUInt64LE(6n,0);
 buf.writeBigUInt64LE(25n,176);buf.writeBigUInt64LE(10000n,184);
 new PublicKey(a).toBuffer().copy(buf,336);
 new PublicKey(b).toBuffer().copy(buf,368);
 new PublicKey(base).toBuffer().copy(buf,400);
 new PublicKey(quote).toBuffer().copy(buf,432);
 return info(program,buf);
}
function vault(mint:string,raw:bigint):AccountInfo<Buffer>{
 const b=Buffer.alloc(165);new PublicKey(mint).toBuffer().copy(b,0);
 authority.toBuffer().copy(b,32);
 b.writeBigUInt64LE(raw,64);b[108]=1;return info(spl,b);
}
test('C3D.2 verified extra pool from DEX registry becomes an actual wSOL quote source',async()=>{
 const original=globalThis.fetch,token=pk(84),sol=GRAPH_ASSETS.SOL.mint;
 const pools=[{id:pk(85),a:pk(86),b:pk(87),resSol:1000000000000n,resToken:200000000000n},
  {id:pk(88),a:pk(89),b:pk(90),resSol:1200000000000n,resToken:200000000000n}];
 const accounts=new Map<string,AccountInfo<Buffer>>();
 accounts.set(token,mint());
 for(const name of ['USDC','USDT','JUP'])accounts.set(GRAPH_ASSETS[name].mint,mint());
 for(const p of pools){
  accounts.set(p.id,pool(sol,token,p.a,p.b));
  accounts.set(p.a,vault(sol,p.resSol));accounts.set(p.b,vault(token,p.resToken));
 }
 let requests=0;
 const callbacks=new Map<string,(value:AccountInfo<Buffer>,context:{slot:number})=>void>();
 const conn={
  getMultipleAccountsInfoAndContext:async(keys:PublicKey[])=>{
   requests++;
   return {context:{slot:500},value:keys.map(k=>accounts.get(k.toBase58())??null)};
  },
  onAccountChange:(key:PublicKey,listener:(info:AccountInfo<Buffer>,ctx:{slot:number})=>void)=>{
   callbacks.set(key.toBase58(),listener);return callbacks.size;
  },
  removeAccountChangeListener:async()=>undefined
 } as unknown as Connection;
 globalThis.fetch=(async(input:Parameters<typeof fetch>[0])=>{
  const url=String(input);
  if(url.includes('tokens/v2/recent'))return new Response(JSON.stringify([{id:token,symbol:'NEWLAUNCH'}]),{status:200});
  if(url.includes('/token-pairs/v1/solana/')){
   return new Response(JSON.stringify([{
    chainId:'solana',dexId:'raydium',
    pairAddress:pools[1].id,
    baseToken:{address:sol,symbol:'SOL'},
    quoteToken:{address:token,symbol:'NEWLAUNCH'},
    liquidity:{usd:350000}
   }]),{status:200});
  }
  if(url.includes('api-v3.raydium.io')){
   const params=new URL(url).searchParams;
   const query=new Set([params.get('mint1'),params.get('mint2')]);
   const matching=query.has(sol)&&query.has(token);
   return new Response(JSON.stringify({success:true,data:{data:matching?pools.slice(0,1).map(p=>({
    id:p.id,mintA:{address:sol},mintB:{address:token},tvl:350000
   })):[]}}),{status:200});
  }
  return new Response('[]',{status:200});
 }) as typeof fetch;
 const feed=new MarketDataFeed(conn);
 const graph=new C3GraphMonitor(conn,feed,{
  enabled:true,maxPools:8,perPair:2,refreshMs:45000,reconcileMs:15000,
  sizesUsd:[500],sizesSol:[0.5],assumedCostUsd:0,assumedCostSol:0,
  dynamicDiscoveryEnabled:true,maxTokens:10,tokenRefreshMs:60000,
  poolRequestBudget:10,poolQueryConcurrency:3,apiKey:'test-token-key',
  maxPathChecks:2000,maxResults:30,maxQuoteAgeMs:15000,
  maxQuoteGapMs:4000,maxSlotSkew:12,minLiquidityUsd:5000,maxPoolInputShareBps:500
 });
 try{
  await graph.start();
  await new Promise<void>(resolve=>setTimeout(resolve,100));
  const snapshot=graph.snapshot();
  assert.equal(snapshot.baseAsset,'SOL');
  assert.equal(snapshot.tokenDiscovery.activeTokens>=1,true);
  assert.ok(snapshot.tokenDiscovery.tokens.some(t=>t.mint===token));
  assert.equal(snapshot.trackedPools,2);
  assert.equal(snapshot.eligiblePools,2);
  assert.equal(snapshot.poolRegistry.trackedPools,1);
  assert.equal(graph.poolRegistrySnapshot().pools[0].address,pools[1].id);
  assert.equal(graph.poolRegistrySnapshot().pools[0].quoteStatus,'ready');
  assert.ok(snapshot.twoLegCycles>=2,'new SPL mint participates in both pool directions');
  assert.ok(snapshot.candidates.some(c=>c.tokenPath.join('>')==='SOL>'+token+'>SOL'));
  assert.ok(snapshot.candidates.every(c=>c.inputWsolRaw&&c.outputWsolRaw));
  assert.equal(snapshot.dynamicPoolDiscovery.pairQueries,7);
  assert.ok(requests>=2);
 }finally{
  graph.stop();await feed.stop();globalThis.fetch=original;
  replaceDynamicGraphAssets([]);
 }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {PublicKey,type AccountInfo,type Connection} from '@solana/web3.js';
import {C3GraphMonitor,parseRaydiumGraphPair} from '../src/c3GraphMonitor.js';
import {GRAPH_ASSETS} from '../src/c3Graph.js';
import {MarketDataFeed} from '../src/marketData.js';
import {RAYDIUM_AMM_V4} from '../src/routes.js';

const key=(n:number)=>new PublicKey(Buffer.alloc(32,n)).toBase58();
const program=new PublicKey(RAYDIUM_AMM_V4);
const token=new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const auth=PublicKey.findProgramAddressSync([Buffer.from('amm authority')],program)[0];
function account(owner:PublicKey,data:Buffer):AccountInfo<Buffer>{
 return {data,owner,lamports:2039280,executable:false,rentEpoch:0};
}
function poolData(base:string,quote:string,vaultA:string,vaultB:string){
 const data=Buffer.alloc(752);data.writeBigUInt64LE(6n,0);
 data.writeBigUInt64LE(25n,176);data.writeBigUInt64LE(10000n,184);
 new PublicKey(vaultA).toBuffer().copy(data,336);
 new PublicKey(vaultB).toBuffer().copy(data,368);
 new PublicKey(base).toBuffer().copy(data,400);
 new PublicKey(quote).toBuffer().copy(data,432);
 return data;
}
function vaultData(mint:string,raw:bigint){
 const data=Buffer.alloc(165);
 new PublicKey(mint).toBuffer().copy(data,0);
 auth.toBuffer().copy(data,32);
 data.writeBigUInt64LE(raw,64);data[108]=1;
 return data;
}
const assets=GRAPH_ASSETS;
test('C3B discovery rejects pool metadata for wrong tokens and missing TVL',()=>{
 const pool=key(34),unrelated=key(35);
 const payload={success:true,data:{data:[
  {id:pool,mintA:{address:assets.USDC.mint},mintB:{address:assets.SOL.mint},tvl:350000},
  {id:unrelated,mintA:{address:assets.USDC.mint},mintB:{address:assets.JUP.mint},tvl:9000000},
  {id:key(36),mintA:{address:assets.USDC.mint},mintB:{address:assets.SOL.mint},tvl:'not-a-number'}
 ]}};
 assert.deepEqual(parseRaydiumGraphPair(payload,'USDC','SOL'),[
  {address:pool,tokenA:'USDC',tokenB:'SOL',liquidityUsd:350000}
 ]);
 assert.deepEqual(parseRaydiumGraphPair({success:false},'USDC','SOL'),[]);
});
test('C3B bootstrap uses bounded RPC and recomputes from websocket bytes without RPC',async()=>{
 const original=globalThis.fetch;
 const pairs=[
  {id:key(45),a:'USDC' as const,b:'SOL' as const,
   av:key(51),bv:key(52),ra:1000000000000n,rb:14000000000000n},
  {id:key(46),a:'SOL' as const,b:'USDT' as const,
   av:key(53),bv:key(54),ra:14000000000000n,rb:1020000000000n},
  {id:key(47),a:'USDT' as const,b:'USDC' as const,
   av:key(55),bv:key(56),ra:1000000000000n,rb:1010000000000n}
 ];
 const snapshot=new Map<string,AccountInfo<Buffer>>();
 for(const p of pairs){
  snapshot.set(p.id,account(program,poolData(assets[p.a].mint,assets[p.b].mint,p.av,p.bv)));
  snapshot.set(p.av,account(token,vaultData(assets[p.a].mint,p.ra)));
  snapshot.set(p.bv,account(token,vaultData(assets[p.b].mint,p.rb)));
 }
 globalThis.fetch=(async(input)=>{
  const url=new URL(String(input)),mint1=url.searchParams.get('mint1');
  const mint2=url.searchParams.get('mint2');
  const matched=pairs.filter(p=>[assets[p.a].mint,assets[p.b].mint].every(m=>m===mint1||m===mint2));
  return new Response(JSON.stringify({success:true,data:{data:matched.map(p=>({
   id:p.id,
   // API mint ordering is not trusted: one result is deliberately reversed.
   mintA:{address:p.id===pairs[1].id?assets[p.b].mint:assets[p.a].mint},
   mintB:{address:p.id===pairs[1].id?assets[p.a].mint:assets[p.b].mint},
   tvl:500000
  }))}}),{status:200,headers:{'content-type':'application/json'}});
 }) as typeof fetch;
 let rpcRequests=0,subs=0,nextId=0;
 const callbacks=new Map<string,(info:AccountInfo<Buffer>,ctx:{slot:number})=>void>();
 const conn={
  getMultipleAccountsInfoAndContext:async (keys:PublicKey[])=>{
   rpcRequests++;
   return {context:{slot:500},value:keys.map(p=>snapshot.get(p.toBase58())??null)};
  },
  onAccountChange:(address:PublicKey,handler:(info:AccountInfo<Buffer>,ctx:{slot:number})=>void)=>{
   callbacks.set(address.toBase58(),handler);subs++;return ++nextId;
  },
  removeAccountChangeListener:async()=>undefined
 } as unknown as Connection;
 const feed=new MarketDataFeed(conn);
 const graph=new C3GraphMonitor(conn,feed,{
  enabled:true,maxPools:8,perPair:2,refreshMs:600000,reconcileMs:30000,
  sizesUsd:[5000],maxPathChecks:4000,maxResults:20,
  maxQuoteAgeMs:15000,maxQuoteGapMs:4000,maxSlotSkew:12,
  minLiquidityUsd:10000,assumedCostUsd:0.02
 });
 try{
  await graph.start();
  await new Promise<void>(resolve=>setTimeout(resolve,80));
  const before=graph.snapshot();
  assert.equal(before.trackedPools,3);
  assert.deepEqual(before.discoveryStats,{apiCandidates:3,validatedV4:3,validatedCpmm:0,selected:3});
  assert.equal(before.watchedAccounts,9);
  assert.equal(subs,9);
  assert.equal(before.rpcReconciles,1);
  assert.ok(before.threeLegCycles>=1);
  assert.ok(before.localEvaluations>=1);
  const requestCount=rpcRequests;
  const updated=account(token,vaultData(assets.USDT.mint,1025000000000n));
  snapshot.set(pairs[1].bv,updated);
  callbacks.get(pairs[1].bv)!(updated,{slot:501});
  await new Promise<void>(resolve=>setTimeout(resolve,85));
  const after=graph.snapshot();
  assert.ok(after.wsUpdates>=1);
  assert.ok(after.localEvaluations>before.localEvaluations);
  assert.equal(rpcRequests,requestCount,'websocket updates should not issue RPC quote requests');
  assert.ok(after.candidates.every(x=>x.executable===false));
 }finally{
  graph.stop();
  await feed.stop();
  globalThis.fetch=original;
 }
});

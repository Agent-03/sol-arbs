import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {PublicKey,type Connection,type AccountInfo} from '@solana/web3.js';
import {C3GraphMonitor} from '../src/c3GraphMonitor.js';
import {RAYDIUM_CPMM,SPL_TOKEN_PROGRAM,CPMM_VAULT_AUTHORITY} from '../src/c3Cpmm.js';
import {RAYDIUM_AMM_V4} from '../src/routes.js';
import {MarketDataFeed} from '../src/marketData.js';
import {GRAPH_ASSETS} from '../src/c3Graph.js';

const pk=(n:number)=>new PublicKey(Buffer.alloc(32,n)).toBase58();
const rawKey=(b:Buffer,at:number,addr:string)=>new PublicKey(addr).toBuffer().copy(b,at);
const token=new PublicKey(SPL_TOKEN_PROGRAM),cpmm=new PublicKey(RAYDIUM_CPMM),v4=new PublicKey(RAYDIUM_AMM_V4);
const v4Auth=PublicKey.findProgramAddressSync([Buffer.from('amm authority')],v4)[0].toBase58();
const mkInfo=(owner:PublicKey,data:Buffer):AccountInfo<Buffer>=>({
 owner,data,lamports:1,executable:false,rentEpoch:0
});
function vault(mint:string,authority:string,balance:bigint){
 const b=Buffer.alloc(165);rawKey(b,0,mint);rawKey(b,32,authority);
 b.writeBigUInt64LE(balance,64);b[108]=1;return mkInfo(token,b);
}
const stateId=pk(40),v4Id=pk(41),configId=pk(42);
const cv0=pk(43),cv1=pk(44),vv0=pk(45),vv1=pk(46);
function cpmmPool(){
 const b=Buffer.alloc(637);
 createHash('sha256').update('account:PoolState').digest().copy(b,0,0,8);
 rawKey(b,8,configId);rawKey(b,72,cv0);rawKey(b,104,cv1);
 rawKey(b,168,GRAPH_ASSETS.USDC.mint);rawKey(b,200,GRAPH_ASSETS.SOL.mint);
 rawKey(b,232,SPL_TOKEN_PROGRAM);rawKey(b,264,SPL_TOKEN_PROGRAM);
 b[329]=0;b[389]=0;b[390]=1;
 return mkInfo(cpmm,b);
}
function feeConfig(rate:bigint){
 const b=Buffer.alloc(236);
 createHash('sha256').update('account:AmmConfig').digest().copy(b,0,0,8);
 b.writeBigUInt64LE(rate,12);b.writeBigUInt64LE(500n,108);
 return mkInfo(cpmm,b);
}
function ammV4(){
 const b=Buffer.alloc(752);
 b.writeBigUInt64LE(6n,0);b.writeBigUInt64LE(25n,176);
 b.writeBigUInt64LE(10000n,184);
 rawKey(b,336,vv0);rawKey(b,368,vv1);
 rawKey(b,400,GRAPH_ASSETS.USDC.mint);rawKey(b,432,GRAPH_ASSETS.SOL.mint);
 return mkInfo(v4,b);
}
test('C3B.1 attaches mixed CPMM/V4 and recomputes on fee-config WebSocket changes, no hot-path RPC',async()=>{
 const original=globalThis.fetch;
 const store=new Map<string,AccountInfo<Buffer>>([
  [stateId,cpmmPool()],[configId,feeConfig(2500n)],
  [cv0,vault(GRAPH_ASSETS.USDC.mint,CPMM_VAULT_AUTHORITY,1000000000000n)],
  [cv1,vault(GRAPH_ASSETS.SOL.mint,CPMM_VAULT_AUTHORITY,14000000000000n)],
  [v4Id,ammV4()],
  [vv0,vault(GRAPH_ASSETS.USDC.mint,v4Auth,1000000000000n)],
  [vv1,vault(GRAPH_ASSETS.SOL.mint,v4Auth,14000000000000n)]
 ]);
 globalThis.fetch=(async(input)=>{
  const u=new URL(String(input));
  const expected=new Set([GRAPH_ASSETS.USDC.mint,GRAPH_ASSETS.SOL.mint]);
  const query=new Set([u.searchParams.get('mint1'),u.searchParams.get('mint2')]);
  const ids=[stateId,v4Id].filter(()=>[...query].every(x=>x&&expected.has(x)));
  return new Response(JSON.stringify({success:true,data:{data:ids.map(id=>({
   id,mintA:{address:GRAPH_ASSETS.USDC.mint},mintB:{address:GRAPH_ASSETS.SOL.mint},
   tvl:2500000
  }))}}),{status:200,headers:{'content-type':'application/json'}});
 }) as typeof fetch;
 let rpcCalls=0,subId=0;
 const callbacks=new Map<string,(info:AccountInfo<Buffer>,ctx:{slot:number})=>void>();
 const conn={
  getMultipleAccountsInfoAndContext:async (keys:PublicKey[])=>{
   rpcCalls++;return {context:{slot:100},value:keys.map(x=>store.get(x.toBase58())??null)};
  },
  onAccountChange:(address:PublicKey,callback:(info:AccountInfo<Buffer>,ctx:{slot:number})=>void)=>{
   callbacks.set(address.toBase58(),callback);return ++subId;
  },
  removeAccountChangeListener:async()=>undefined
 } as unknown as Connection;
 const feed=new MarketDataFeed(conn);
 const graph=new C3GraphMonitor(conn,feed,{
  enabled:true,maxPools:6,perPair:6,refreshMs:600000,reconcileMs:30000,
  sizesUsd:[5000],maxPathChecks:500,maxResults:20,maxQuoteAgeMs:15000,
  maxQuoteGapMs:4000,maxSlotSkew:12,minLiquidityUsd:250000,
  maxPoolInputShareBps:500,assumedCostUsd:0.02
 });
 try{
  await graph.start();
  await new Promise(resolve=>setTimeout(resolve,90));
  const before=graph.snapshot();
  assert.equal(before.trackedPools,2);
  assert.equal(before.watchedAccounts,7);
  assert.deepEqual(before.discoveryStats,{
   apiCandidates:2,validatedV4:1,validatedCpmm:1,selected:2
  });
  assert.equal(before.eligiblePools,2);
  assert.equal(before.twoLegCycles,2);
  assert.equal(before.depthRejected,0);
  assert.ok(before.candidates.some(x=>x.hops.some(h=>h.program==='raydium_cpmm')));
  const rpcBefore=rpcCalls;
  const updated=feeConfig(8000n);
  store.set(configId,updated);
  callbacks.get(configId)!(updated,{slot:101});
  await new Promise(resolve=>setTimeout(resolve,90));
  const after=graph.snapshot();
  assert.equal(rpcCalls,rpcBefore,'CPMM config updates should not trigger HTTP quote calls');
  assert.ok(after.wsUpdates>=1);
  assert.ok(after.localEvaluations>before.localEvaluations);
  assert.notDeepEqual(after.candidates.map(x=>x.outputUsdcRaw),
   before.candidates.map(x=>x.outputUsdcRaw),
   'swap fees from a changed on-chain CPMM config must change quotes');
  assert.ok(after.candidates.every(x=>x.executable===false));
 }finally{graph.stop();await feed.stop();globalThis.fetch=original}
});

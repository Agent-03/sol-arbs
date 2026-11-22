import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {Connection,PublicKey,type AccountInfo} from '@solana/web3.js';
import {GRAPH_ASSETS,replaceDynamicGraphAssets} from '../src/c3Graph.js';
import {C3PoolRegistry,parsePoolMetadata,decodeRegistryPoolMints,
 METEORA_DLMM,METEORA_DAMM_V2,PUMPSWAP_AMM} from '../src/c3PoolRegistry.js';

const pk=(n:number)=>new PublicKey(Buffer.alloc(32,n)).toBase58();
const token=pk(150),sol=GRAPH_ASSETS.SOL.mint;
const wrap=(owner:string,data:Buffer):AccountInfo<Buffer>=>({
 owner:new PublicKey(owner),data,lamports:1,executable:false,rentEpoch:0
});
const hash=(name:string)=>createHash('sha256').update('account:'+name).digest().subarray(0,8);
const pair=(address:string,mintA=token,mintB=sol,dexId='meteora',usd=90000)=>({
 chainId:'solana',dexId,pairAddress:address,
 baseToken:{address:mintA,symbol:'NEW'},
 quoteToken:{address:mintB,symbol:'SOL'},
 liquidity:{usd}
});
const dlmm=()=>{
 const data=Buffer.alloc(912);Buffer.from([33,11,49,98,181,101,177,13]).copy(data,0);
 new PublicKey(token).toBuffer().copy(data,88);
 new PublicKey(sol).toBuffer().copy(data,120);
 return wrap(METEORA_DLMM,data);
};
const damm=()=>{
 const data=Buffer.alloc(1120);Buffer.from([241,154,109,4,17,177,109,188]).copy(data,0);
 new PublicKey(token).toBuffer().copy(data,176);
 new PublicKey(sol).toBuffer().copy(data,208);
 return wrap(METEORA_DAMM_V2,data);
};
const pump=()=>{
 const creator=new PublicKey(pk(170));
 const index=Buffer.from([0,0]);
 const address=PublicKey.findProgramAddressSync([
  Buffer.from('pool'),index,creator.toBuffer(),
  new PublicKey(token).toBuffer(),new PublicKey(sol).toBuffer()
 ],new PublicKey(PUMPSWAP_AMM))[0].toBase58();
 const data=Buffer.alloc(220);hash('Pool').copy(data,0);data[8]=1;
 index.copy(data,9);creator.toBuffer().copy(data,11);
 new PublicKey(token).toBuffer().copy(data,43);
 new PublicKey(sol).toBuffer().copy(data,75);
 return {address,info:wrap(PUMPSWAP_AMM,data)};
};

test('C3D.2 pool metadata only accepts Solana pool addresses, active mints, nonzero TVL',()=>{
 const active=new Set([token,sol]);
 const raw=[pair(pk(100)),pair(pk(100),token,sol,'meteora',120000),
  pair(pk(101),token,pk(9)),{...pair(pk(102)),chainId:'ethereum'},
  pair('invalid'),pair(pk(103),token,sol,'orca',100)];
 const selected=parsePoolMetadata(raw,active,2500);
 assert.equal(selected.length,1);
 assert.equal(selected[0].address,pk(100));
 assert.equal(selected[0].liquidityUsd,120000);
});
test('C3D.2 reads Meteora and PumpSwap mint identities from official layouts',()=>{
 const x=decodeRegistryPoolMints(pk(100),dlmm());
 const y=decodeRegistryPoolMints(pk(101),damm());
 const p=pump();
 const z=decodeRegistryPoolMints(p.address,p.info);
 assert.deepEqual([x?.mintA,x?.mintB,x?.venue,x?.program],
  [token,sol,'meteora','meteora_dlmm']);
 assert.deepEqual([y?.mintA,y?.mintB,y?.program],[token,sol,'meteora_damm_v2']);
 assert.deepEqual([z?.mintA,z?.mintB,z?.venue,z?.program],
  [token,sol,'pumpswap','pumpswap_amm']);
 assert.equal(decodeRegistryPoolMints(pk(200),p.info),null,'Pump PDA mismatch');
 const corrupted=Buffer.from(dlmm().data);corrupted[0]=0;
 assert.equal(decodeRegistryPoolMints(pk(100),wrap(METEORA_DLMM,corrupted)),null);
 const altered=Buffer.from(damm().data);new PublicKey(pk(25)).toBuffer().copy(altered,176);
 assert.equal(decodeRegistryPoolMints(pk(101),wrap(METEORA_DAMM_V2,altered))?.mintA,pk(25));
});
test('C3D.2 verifies ownership/mints, matches separate venues, and never quotes new DEX math',async()=>{
 replaceDynamicGraphAssets([{mint:token,decimals:6,symbol:'MEME'}]);
 const p=pump(),dlmmId=pk(100),dammId=pk(101),wrongId=pk(102);
 const accounts=new Map<string,AccountInfo<Buffer>>([
  [dlmmId,dlmm()],[dammId,damm()],[p.address,p.info],
  [wrongId,wrap('11111111111111111111111111111111',Buffer.alloc(200))]
 ]);
 const rpc={
  getMultipleAccountsInfoAndContext:async(keys:PublicKey[])=>({
   context:{slot:151},value:keys.map(x=>accounts.get(x.toBase58())??null)
  })
 } as unknown as Connection;
 const transport=(async (input:Parameters<typeof fetch>[0])=>{
  if(!String(input).includes(token))throw Error('unexpected mint URL');
  return new Response(JSON.stringify([
   pair(dlmmId),pair(dammId,token,sol,'meteora',70000),
   pair(p.address,token,sol,'pumpswap',80000),
   pair(wrongId,token,sol,'raydium',150000)
  ]),{status:200});
 }) as typeof fetch;
 const registry=new C3PoolRegistry(rpc,{
  enabled:true,maxTokensPerRefresh:5,concurrency:2,
  refreshMs:15000,ttlMs:60000,maxPools:20,minLiquidityUsd:2500
 },transport);
 try{
  await registry.refresh([token]);
  const s=registry.snapshot();
  assert.equal(s.phase,'C3D.2');
  assert.equal(s.trackedPools,3);
  assert.equal(s.onchainVerified,3);
  assert.equal(s.ownerRejected,1);
  assert.equal(s.tokensWithMultiplePools,1);
  assert.equal(s.tokens[0].poolCount,3);
  assert.equal(s.tokens[0].venueCount,2);
  assert.equal(s.crossDexPairs,1);
  assert.equal(s.readyTwoLegPairs,0);
  assert.equal(s.potentialTwoLegPairs,1);
  assert.equal(s.unsupportedQuotePools,3);
  assert.deepEqual(s.perVenue.meteora,{tracked:2,ready:0});
  assert.deepEqual(s.perVenue.pumpswap,{tracked:1,ready:0});
  assert.ok(s.pools.every(x=>x.quoteStatus==='unsupported'));
  assert.ok(registry.supported().length===0,'No Meteora or Pump pool may enter graph quote adapters');
  // Do not change readiness even if an unsupported source appears in a
  // mock evaluator snapshot; there is no adapter to quote it.
  registry.observeReady([{address:p.address} as never]);
  assert.equal(registry.snapshot().readyPools,0);
  await registry.refresh([],Date.now()+62000);
  assert.equal(registry.snapshot().trackedPools,0);
 }finally{registry.stop();replaceDynamicGraphAssets([])}
});
test('C3D.2 fail-closed on claimed pair mismatches and non-Solana metadata',async()=>{
 replaceDynamicGraphAssets([{mint:token,decimals:6}]);
 const address=pk(100);
 const rpc={getMultipleAccountsInfoAndContext:async()=>({
  context:{slot:200},value:[dlmm()]
 })} as unknown as Connection;
 const transport=(async()=>new Response(JSON.stringify([
  pair(address,sol,pk(27),'meteora',90000)
 ]),{status:200})) as typeof fetch;
 const r=new C3PoolRegistry(rpc,{
  enabled:true,maxTokensPerRefresh:2,concurrency:1,refreshMs:15000,
  ttlMs:60000,maxPools:10,minLiquidityUsd:0
 },transport);
 try{
  await r.refresh([token]);
  assert.equal(r.snapshot().trackedPools,0);
 }finally{r.stop();replaceDynamicGraphAssets([])}
});

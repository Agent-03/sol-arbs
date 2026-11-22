import test from 'node:test';
import assert from 'node:assert/strict';
import {PublicKey,type AccountInfo,type Connection} from '@solana/web3.js';
import {C3TokenDiscovery,parseTokenSuggestions} from '../src/c3TokenDiscovery.js';
import {GRAPH_ASSETS,replaceDynamicGraphAssets,assetOfMint,evaluateGraphCycles,
 type GraphPool,type GraphScanLimits} from '../src/c3Graph.js';

const pk=(n:number)=>new PublicKey(Buffer.alloc(32,n)).toBase58();
const tokenProgram=new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const badProgram=new PublicKey('11111111111111111111111111111111');
function mint(decimals:number,owner:PublicKey=tokenProgram):AccountInfo<Buffer>{
 const data=Buffer.alloc(82);data[44]=decimals;data[45]=1;
 return {owner,data,lamports:1,executable:false,rentEpoch:0};
}
test('C3D.1 handles Jupiter categories and rejects non-Solana token profiles',()=>{
 assert.deepEqual(parseTokenSuggestions([
  {id:pk(32),symbol:'MEME'}, {id:'bad'}, {id:pk(31),symbol:'EXC'}
 ],'trending').map(x=>x.mint),[pk(32),pk(31)]);
 assert.deepEqual(parseTokenSuggestions([
  {chainId:'ethereum',tokenAddress:pk(30)},
  {chainId:'solana',tokenAddress:pk(33),symbol:'SOL-MEME'}
 ],'boosted').map(x=>x.mint),[pk(33)]);
});
test('C3D.1 dynamically discovers and verifies classic SPL mints and de-duplicates by address',async()=>{
 const newMint=pk(62),other=pk(63),invalid=pk(64);
 const store=new Map<string,AccountInfo<Buffer>>([
  [newMint,mint(6)],[other,mint(9)],[invalid,mint(6,badProgram)],
  [GRAPH_ASSETS.USDC.mint,mint(6)],
  [GRAPH_ASSETS.USDT.mint,mint(6)],
  [GRAPH_ASSETS.JUP.mint,mint(6)]
 ]);
 let accountCalls=0;
 const conn={getMultipleAccountsInfoAndContext:async(keys:PublicKey[])=>{
  accountCalls++;
  return {context:{slot:500},value:keys.map(k=>store.get(k.toBase58())??null)};
 }} as unknown as Connection;
 const transport=(async(input:Parameters<typeof fetch>[0])=>{
  const url=String(input);
  const rows=url.includes('toptrending')?[
   {id:newMint,symbol:'NEW'},{id:other,symbol:'OTHER'}]:
   url.includes('toptraded')?[{id:newMint,symbol:'NEW'}]:
   url.includes('tokens/v2/recent')?[{id:invalid,symbol:'NOT_SPL'}]:
   url.includes('token-profiles')?[
    {chainId:'solana',tokenAddress:newMint,symbol:'NEW'},
    {chainId:'ethereum',tokenAddress:pk(77)}]:
   [{chainId:'solana',tokenAddress:other,symbol:'OTHER'}];
  return new Response(JSON.stringify(rows),{status:200});
 }) as typeof fetch;
 const universe=new C3TokenDiscovery(conn,{enabled:true,maxTokens:10,refreshMs:30000,
  apiKey:'test-only-key'},transport);
 const first=await universe.refresh();
 assert.ok(first.some(x=>x.mint===newMint&&x.decimals===6));
 assert.ok(first.some(x=>x.mint===other&&x.decimals===9));
 assert.ok(!first.some(x=>x.mint===invalid));
 assert.equal(first.filter(x=>x.mint===newMint).length,1);
 assert.ok(first.find(x=>x.mint===newMint)!.categories.includes('trending'));
 const before=accountCalls;
 await universe.refresh(Date.now()+1000);
 assert.equal(accountCalls,before,'interval-aware cache avoids repeated RPC reads');
 assert.ok(universe.snapshot().excludedUnsupported>=1);
 assert.equal(universe.snapshot().mode,'READ_ONLY');
});
test('C3D.1 wSOL-rooted dynamic graph uses exact raw swap chaining and reports SOL differential',()=>{
 const token=pk(101);
 try{
  replaceDynamicGraphAssets([{mint:token,decimals:6,symbol:'HOT'}]);
  assert.equal(assetOfMint(token),token);
  assert.equal(GRAPH_ASSETS[token].symbol,'HOT');
  const a:GraphPool={
   address:pk(102),program:'raydium_amm_v4',
   tokenA:'SOL',tokenB:token,reserveA:'1000000000000',
   reserveB:'200000000000',feeNumerator:'25',feeDenominator:'10000',
   observedAt:'2026-11-22T16:00:00Z',poolSlot:100,vaultSlot:100,
   liquidityUsd:600000,snapshotIntegrity:'bounded_slot_research'
  };
  const b:GraphPool={...a,address:pk(103),tokenA:token,tokenB:'SOL',
   reserveA:'200000000000',reserveB:'1200000000000'};
  const limits:GraphScanLimits={
   baseAsset:'SOL',sizesUsd:[500],sizesSol:[0.5,1],
   maxAgeMs:15000,maxGapMs:4000,maxSlotSkew:12,
   maxPathChecks:1000,maxResults:20,minLiquidityUsd:5000,
   assumedCostUsd:0,assumedCostSol:0,maxPoolInputShareBps:500
  };
  const result=evaluateGraphCycles([a,b],limits,Date.parse('2026-11-22T16:00:01Z'));
  assert.equal(result.baseAsset,'SOL');
  assert.ok(result.twoLegCycles>=1);
  assert.equal(result.phase,'C3D.1');
  assert.ok(result.bestIndicativeNetSol!==null);
  assert.equal(result.bestIndicativeNetUsd,null);
  const cycle=result.candidates.find(x=>x.tokenPath[1]===token)!;
  assert.ok(cycle);
  assert.deepEqual(cycle.symbolPath,['SOL','HOT','SOL']);
  assert.equal(cycle.inputWsolRaw,cycle.hops[0].amountInRaw);
  assert.equal(cycle.outputWsolRaw,cycle.hops[1].amountOutRaw);
  assert.equal(cycle.hops[1].amountInRaw,cycle.hops[0].amountOutRaw);
  assert.equal(cycle.sizeUsd,undefined);
  assert.equal(cycle.executable,false);
 }finally{replaceDynamicGraphAssets([])}
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {parseRaydium,parseOrca,choosePoolUniverse,SOL_MINT,USDC_MINT} from '../src/discovery.js';
import {RAYDIUM_AMM_V4,ORCA_WHIRLPOOL,RAYDIUM_CLMM} from '../src/routes.js';

const pool='So11111111111111111111111111111111111111112';
const unrelated='11111111111111111111111111111111';
test('Raydium discovery retains only requested mint pair',()=>{
 const result=parseRaydium({success:true,data:{data:[
  {id:pool,mintA:{address:SOL_MINT},mintB:{address:USDC_MINT},tvl:1200},
  {id:unrelated,mintA:{address:SOL_MINT},mintB:{address:unrelated},tvl:9999},
 ]}});
 assert.deepEqual(result,[{address:pool,liquidityUsd:1200}]);
});
test('Raydium rejects failures and invalid payloads',()=>{
 assert.deepEqual(parseRaydium({success:false,data:{data:[]}}),[]);
 assert.deepEqual(parseRaydium(null),[]);
});
test('Orca discovery supports nested data arrays and reversed mint order',()=>{
 const result=parseOrca({data:{data:[{address:pool,tokenMintA:USDC_MINT,tokenMintB:SOL_MINT,tvlUsd:3100}]}});
 assert.deepEqual(result,[{address:pool,liquidityUsd:3100}]);
});
test('Orca ignores unrelated token pairs',()=>{
 assert.deepEqual(parseOrca({data:[{address:pool,tokenMintA:SOL_MINT,tokenMintB:unrelated}]}),[]);
});

test('quote-supported SOL/USDC pools are prioritized and rotating secondary pools differ',()=>{
 const many=[
  ...Array.from({length:5},(_,i)=>({address:'Ray'+i,venue:'raydium' as const,owner:RAYDIUM_AMM_V4,liquidityUsd:100000-i*1000})),
  ...Array.from({length:4},(_,i)=>({address:'Orca'+i,venue:'orca' as const,owner:ORCA_WHIRLPOOL,liquidityUsd:90000-i*1000})),
  {address:'ClmmTop',venue:'raydium' as const,owner:RAYDIUM_CLMM,liquidityUsd:2000000}
 ];
 const first=choosePoolUniverse(many,6,0);
 const next=choosePoolUniverse(many,6,1);
 assert.equal(first[0].address,'Ray0');
 assert.equal(first[3].address,'Orca0');
 assert.equal(first.length,6);
 assert.equal(next.length,6);
 assert.notDeepEqual(first.map(x=>x.address),next.map(x=>x.address));
 assert.equal(choosePoolUniverse(many,6,0)[0].address,first[0].address);
});
test('pool discovery selection de-duplicates and respects cap',()=>{
 const pool={address:'duplicate',venue:'raydium' as const,owner:RAYDIUM_AMM_V4,liquidityUsd:40000};
 assert.deepEqual(choosePoolUniverse([pool,pool],1),[pool]);
 assert.throws(()=>choosePoolUniverse([pool],0));
});

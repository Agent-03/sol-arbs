import test from 'node:test';
import assert from 'node:assert/strict';
import {parseRaydium,parseOrca,SOL_MINT,USDC_MINT} from '../src/discovery.js';

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

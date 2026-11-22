import test from 'node:test';
import assert from 'node:assert/strict';
import {PublicKey} from '@solana/web3.js';
import {decodeAmmV4,decodeVault,amountOutExactInput,quoteV4,quoteReverse} from '../src/ammV4.js';
import {SOL_MINT,USDC_MINT} from '../src/discovery.js';
const pool='58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2';
const baseVault='11111111111111111111111111111111';
const quoteVault='So11111111111111111111111111111111111111112';
function writeKey(b:Buffer,off:number,key:string){new PublicKey(key).toBuffer().copy(b,off);}
function fixture(){
 const b=Buffer.alloc(752);
 b.writeBigUInt64LE(6n,0);
 b.writeBigUInt64LE(25n,176);
 b.writeBigUInt64LE(10000n,184);
 b.writeBigUInt64LE(10n,192);
 b.writeBigUInt64LE(20n,200);
 writeKey(b,336,baseVault);writeKey(b,368,quoteVault);
 writeKey(b,400,SOL_MINT);writeKey(b,432,USDC_MINT);
 return b;
}
function vault(mint:string,amount:bigint){
 const b=Buffer.alloc(165);
 writeKey(b,0,mint);
 b.writeBigUInt64LE(amount,64);
 b[108]=1;
 return b;
}
test('decode Raydium AMM v4 layout from documented offsets',()=>{
 const poolState=decodeAmmV4(pool,fixture());
 assert.equal(poolState.baseVault,baseVault);
 assert.equal(poolState.baseMint,SOL_MINT);
 assert.equal(poolState.quoteMint,USDC_MINT);
 assert.equal(poolState.feeNumerator,25n);
 assert.equal(poolState.feeDenominator,10000n);
 assert.equal(poolState.baseNeedTakePnl,10n);
 assert.equal(poolState.quoteNeedTakePnl,20n);
});
test('reject disabled and wrong-length AMM state',()=>{
 assert.throws(()=>decodeAmmV4(pool,Buffer.alloc(700)));
 const b=fixture();b.writeBigUInt64LE(7n,0);
 assert.throws(()=>decodeAmmV4(pool,b),/not enabled/);
});
test('vault token mint verified and token amount decoded',()=>{
 assert.equal(decodeVault(vault(SOL_MINT,1000000000n),SOL_MINT),1000000000n);
 assert.throws(()=>decodeVault(vault(SOL_MINT,100n),USDC_MINT),/mint mismatch/);
});
test('integer constant-product fees use rounding up',()=>{
 assert.equal(amountOutExactInput(1000n,1000000n,1000000n,25n,10000n),996n);
 assert.equal(amountOutExactInput(1n,1000000n,1000000n,25n,10000n),0n);
});
test('quote using effective vault reserves in both directions',()=>{
 const state=decodeAmmV4(pool,fixture());
 const buy=quoteV4(state,1000000010n,700000020n,1000000n,100,101);
 assert.equal(buy.direction,'USDC_TO_SOL');
 assert.equal(buy.reserveInRaw,'700000000');
 assert.equal(buy.reserveOutRaw,'1000000000');
 assert.ok(BigInt(buy.outputRaw)>0n);
 const sell=quoteReverse(state,1000000010n,700000020n,1000000n,100,101);
 assert.equal(sell.direction,'SOL_TO_USDC');
 assert.equal(sell.reserveInRaw,'1000000000');
 assert.equal(sell.reserveOutRaw,'700000000');
 assert.equal(sell.classification,'indicative_non_executable');
});

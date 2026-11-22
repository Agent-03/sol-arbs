import test from 'node:test';
import assert from 'node:assert/strict';
import {PublicKey,type Connection,type AccountInfo} from '@solana/web3.js';
import {MarketDataFeed} from '../src/marketData.js';
import {LiveRaydiumMonitor} from '../src/liveRaydium.js';
import {RAYDIUM_AMM_V4} from '../src/routes.js';
import {SOL_MINT,USDC_MINT} from '../src/discovery.js';

const pool='58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2';
const baseVault='11111111111111111111111111111111';
const quoteVault='So11111111111111111111111111111111111111112';
const tokenProgram='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const authority=PublicKey.findProgramAddressSync(
 [Buffer.from('amm authority')],new PublicKey(RAYDIUM_AMM_V4))[0].toBase58();
function key(b:Buffer,offset:number,address:string){
 new PublicKey(address).toBuffer().copy(b,offset);
}
function poolBytes(){
 const b=Buffer.alloc(752);
 b.writeBigUInt64LE(6n,0);b.writeBigUInt64LE(25n,176);
 b.writeBigUInt64LE(10000n,184);
 key(b,336,baseVault);key(b,368,quoteVault);
 key(b,400,SOL_MINT);key(b,432,USDC_MINT);
 return b;
}
function vaultBytes(mint:string,amount:bigint){
 const b=Buffer.alloc(165);
 key(b,0,mint);key(b,32,authority);
 b.writeBigUInt64LE(amount,64);b[108]=1;
 return b;
}
function account(data:Buffer,owner:string):AccountInfo<Buffer>{
 return {data,owner:new PublicKey(owner),lamports:250,executable:false,rentEpoch:0};
}
test('C1 shares account watches between pool scanner and Raydium monitor; WS hot path is RPC-free',async()=>{
 const accounts=new Map<string,AccountInfo<Buffer>>([
  [pool,account(poolBytes(),RAYDIUM_AMM_V4)],
  [baseVault,account(vaultBytes(SOL_MINT,1000000000n),tokenProgram)],
  [quoteVault,account(vaultBytes(USDC_MINT,70000000n),tokenProgram)]
 ]);
 const callbacks=new Map<string,(a:AccountInfo<Buffer>,ctx:{slot:number})=>void>();
 let httpReads=0,watchRegistrations=0;
 const connection={
  onAccountChange:(key:PublicKey,callback:(a:AccountInfo<Buffer>,ctx:{slot:number})=>void)=>{
   watchRegistrations++;
   callbacks.set(key.toBase58(),callback);return watchRegistrations;
  },
  removeAccountChangeListener:async(_id:number)=>{},
  getAccountInfoAndContext:async(key:PublicKey)=>{
   httpReads++;return {context:{slot:500},value:accounts.get(key.toBase58())??null};
  },
  getMultipleAccountsInfoAndContext:async(keys:PublicKey[])=>{
   httpReads++;return {context:{slot:500},value:keys.map(k=>accounts.get(k.toBase58())??null)};
  }
 } as unknown as Connection;
 const feed=new MarketDataFeed(connection,30000,12);
 const releaseScannerWatch=feed.watch(pool);
 feed.setDependencies(pool,[pool]);
 const monitor=new LiveRaydiumMonitor(connection,
  [{address:pool,owner:RAYDIUM_AMM_V4,venue:'raydium',liquidityUsd:1000000}],
  [5],12,30000,10000,600000,()=>{},feed);
 await monitor.start();
 try{
  assert.equal(feed.snapshot().watchedAccounts,3);
  assert.equal(watchRegistrations,3,'duplicate pool WS subscription created');
  assert.equal(feed.snapshot().poolDependencies,1);
  assert.equal(feed.snapshot().pools[0].accounts,3);
  assert.equal(monitor.snapshot().quotes.length,1);
  const beforeReads=httpReads;
  const before=monitor.snapshot().quotes[0].outputRaw;
  callbacks.get(baseVault)?.(account(vaultBytes(SOL_MINT,1200000000n),tokenProgram),{slot:501});
  assert.equal(httpReads,beforeReads,'WebSocket update issued extra RPC requests');
  assert.notEqual(monitor.snapshot().quotes[0].outputRaw,before);
  assert.equal(feed.snapshot().wsUpdates,1);
 }finally{
  await monitor.stop();
  assert.equal(feed.snapshot().watchedAccounts,1,'scanner pool watch was released by Raydium');
  releaseScannerWatch();
  assert.equal(feed.snapshot().watchedAccounts,0);
  await feed.stop();
 }
});

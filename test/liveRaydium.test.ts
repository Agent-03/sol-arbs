import test from 'node:test';
import assert from 'node:assert/strict';
import {PublicKey,type Connection,type AccountInfo} from '@solana/web3.js';
import {LiveRaydiumMonitor} from '../src/liveRaydium.js';
import {RAYDIUM_AMM_V4} from '../src/routes.js';
import {SOL_MINT,USDC_MINT} from '../src/discovery.js';

const pool='58oQChx4yWmvKdwLLZzBi4ChoCc2fqCUWBkwMihLYQo2';
const baseVault='11111111111111111111111111111111';
const quoteVault='So11111111111111111111111111111111111111112';
const tokenProgram='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const authority=PublicKey.findProgramAddressSync(
 [Buffer.from('amm authority')],new PublicKey(RAYDIUM_AMM_V4))[0].toBase58();
const key=(b:Buffer,offset:number,addr:string)=>new PublicKey(addr).toBuffer().copy(b,offset);
function ammData(){
 const b=Buffer.alloc(752);
 b.writeBigUInt64LE(6n,0);b.writeBigUInt64LE(25n,176);b.writeBigUInt64LE(10000n,184);
 key(b,336,baseVault);key(b,368,quoteVault);
 key(b,400,SOL_MINT);key(b,432,USDC_MINT);
 return b;
}
function vaultData(mint:string,amount:bigint){
 const b=Buffer.alloc(165);
 key(b,0,mint);key(b,32,authority);
 b.writeBigUInt64LE(amount,64);
 b[108]=1;
 return b;
}
function info(data:Buffer,owner:string):AccountInfo<Buffer>{
 return {data,owner:new PublicKey(owner),executable:false,lamports:1,rentEpoch:0};
}
test('Raydium WebSocket update recomputes locally without any new HTTP RPC',async()=>{
 const owners=new Map<string,AccountInfo<Buffer>>([
  [pool,info(ammData(),RAYDIUM_AMM_V4)],
  [baseVault,info(vaultData(SOL_MINT,1000000000n),tokenProgram)],
  [quoteVault,info(vaultData(USDC_MINT,70000000n),tokenProgram)]
 ]);
 const callbacks=new Map<string,(info:AccountInfo<Buffer>,context:{slot:number})=>void>();
 let httpReads=0,id=0;
 const connection={
  getAccountInfoAndContext:async (address:PublicKey)=>{
   httpReads++;return {context:{slot:500},value:owners.get(address.toBase58())??null};
  },
  getMultipleAccountsInfoAndContext:async (keys:PublicKey[])=>{
   httpReads++;return {context:{slot:500},value:keys.map(key=>owners.get(key.toBase58())??null)};
  },
  onAccountChange:(address:PublicKey,cb:(info:AccountInfo<Buffer>,context:{slot:number})=>void)=>{
   callbacks.set(address.toBase58(),cb);return ++id;
  },
  removeAccountChangeListener:async (_id:number)=>{}
 } as unknown as Connection;
 const seen:string[]=[];
 const monitor=new LiveRaydiumMonitor(connection,
  [{address:pool,owner:RAYDIUM_AMM_V4,venue:'raydium',liquidityUsd:1000000}],
  [5,10],12,30000,10000,600000,event=>seen.push(event.source));
 await monitor.start();
 try{
  const initial=monitor.snapshot();
  assert.equal(initial.status,'ok');
  assert.equal(initial.readyPools,1);
  assert.equal(initial.subscriptions,3);
  assert.equal(initial.quotes.length,2);
  assert.equal(httpReads,2);
  const oldOutput=initial.quotes[0].outputRaw;
  const updated=info(vaultData(SOL_MINT,1200000000n),tokenProgram);
  callbacks.get(baseVault)?.(updated,{slot:501});
  const next=monitor.snapshot();
  assert.equal(httpReads,2,'WebSocket event triggered an unexpected HTTP read');
  assert.equal(next.events,1);
  assert.equal(next.quotes.length,2);
  assert.notEqual(next.quotes[0].outputRaw,oldOutput);
  assert.ok(seen.includes('websocket'));
 }finally{await monitor.stop();}
});
test('Raydium monitor rejects component slot skew instead of calling it a fresh quote',async()=>{
 const owners=new Map<string,AccountInfo<Buffer>>([
  [pool,info(ammData(),RAYDIUM_AMM_V4)],
  [baseVault,info(vaultData(SOL_MINT,1000000000n),tokenProgram)],
  [quoteVault,info(vaultData(USDC_MINT,70000000n),tokenProgram)]
 ]);
 const callbacks=new Map<string,(info:AccountInfo<Buffer>,context:{slot:number})=>void>();
 let id=0;
 const connection={
  getAccountInfoAndContext:async (address:PublicKey)=>({context:{slot:500},value:owners.get(address.toBase58())??null}),
  getMultipleAccountsInfoAndContext:async (keys:PublicKey[])=>({context:{slot:500},value:keys.map(k=>owners.get(k.toBase58())??null)}),
  onAccountChange:(address:PublicKey,cb:(info:AccountInfo<Buffer>,context:{slot:number})=>void)=>{
   callbacks.set(address.toBase58(),cb);return ++id;
  },
  removeAccountChangeListener:async (_id:number)=>{}
 } as unknown as Connection;
 const monitor=new LiveRaydiumMonitor(connection,
  [{address:pool,venue:'raydium',owner:RAYDIUM_AMM_V4,liquidityUsd:100000}],
  [5],12,30000,10000,600000,()=>{});
 await monitor.start();
 try{
  assert.equal(monitor.snapshot().quotes.length,1);
  callbacks.get(baseVault)?.(owners.get(baseVault)!,{slot:550});
  assert.equal(monitor.snapshot().quotes.length,0);
  assert.equal(monitor.snapshot().poolReasons[pool],'component_slot_skew');
 }finally{await monitor.stop();}
});

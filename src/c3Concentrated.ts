import {Connection,PublicKey,Keypair} from '@solana/web3.js';
import {AnchorProvider,Wallet} from '@coral-xyz/anchor';
import {WhirlpoolContext,buildWhirlpoolClient,ParsableWhirlpool} from '@orca-so/whirlpools-sdk';
import {ORCA_WHIRLPOOL,RAYDIUM_CLMM} from './routes.js';
import {LocalWhirlpoolQuoter} from './localWhirlpool.js';
import {ClmmMonitor} from './clmm.js';
import {GRAPH_ASSETS,assetOfMint,type GraphAsset,type GraphPool} from './c3Graph.js';
import type {MarketDataFeed} from './marketData.js';
import type {DiscoveredPool} from './discovery.js';

type Candidate={address:string;tokenA:GraphAsset;tokenB:GraphAsset;liquidityUsd:number;
 program:'orca_whirlpool'|'raydium_clmm'};
const ctxPrefix='c3c:';
export function parseOrcaGraphCandidates(payload:unknown):Candidate[]{
 const value=payload as {data?:unknown;pools?:unknown};
 const nested=value?.data;
 const rows=Array.isArray(nested)?nested:Array.isArray(value?.pools)?value.pools:
  nested&&typeof nested==='object'&&Array.isArray((nested as {pools?:unknown}).pools)
   ?(nested as {pools:unknown[]}).pools:[];
 const result:Candidate[]=[];
 for(const item of rows){
  if(!item||typeof item!=='object')continue;
  const p=item as Record<string,unknown>;
  const mint=(v:unknown):string|undefined=>{
   const x=typeof v==='object'&&v!==null?(v as Record<string,unknown>).address??v:v;
   return typeof x==='string'?x:undefined;
  };
  const a=mint(p.tokenMintA??p.token_mint_a??p.tokenA??p.token_a);
  const b=mint(p.tokenMintB??p.token_mint_b??p.tokenB??p.token_b);
  const tokenA=a?assetOfMint(a):undefined,tokenB=b?assetOfMint(b):undefined;
  const addr=p.address??p.id??p.whirlpool;
  if(!tokenA||!tokenB||tokenA===tokenB||typeof addr!=='string')continue;
  try{
   const address=new PublicKey(addr).toBase58();
   const tvl=Number(p.tvlUsdc??p.tvlUsd??p.tvl);
   if(Number.isFinite(tvl)&&tvl>0)
    result.push({address,tokenA,tokenB,liquidityUsd:tvl,program:'orca_whirlpool'});
  }catch{/* ignore invalid pool addresses */}
 }
 return result.sort((a,b)=>b.liquidityUsd-a.liquidityUsd);
}
export type ConcentratedSnapshot={
 trackedOrca:number;trackedClmm:number;readyOrca:number;readyClmm:number;
 validatedOrca:number;validatedClmm:number;quotesAttempted:number;quoteMisses:number;
 orcaPools:Array<{pool:string;pair:string;state:'ready'|'not_ready';reason?:string}>;
 clmmPools:Array<{pool:string;pair:string;status:string;reason?:string;
  lastObservedAt?:string;ageMs?:number;tickArrays:number;slot:number|null;
  tickArraySlot:number|null;tickArraySlotVerified:boolean}>;
 clmmScan:{status:string;scans:number;lastUpdatedAt?:string;activeTickSubscriptions:number};
 discoveryErrors:string[];
};
/** C3C independent, strictly read-only concentrated-liquidity adapter.
 * The existing C2 SOL/USDC engines continue unchanged.
 * All path quotes run against cached tick arrays, never a network quote.
 */
export class C3Concentrated{
 private readonly allowedMints=new Set<string>();
 private readonly orca:LocalWhirlpoolQuoter;
 private readonly clmm:ClmmMonitor;
 private readonly pools=new Map<string,Candidate>();
 private readonly orcaReleases=new Map<string,()=>void>();
 private registryOrca:Candidate[]=[];
 private apiOrca:Candidate[]=[];
 private orcaRegistryPending=false;
 private orcaValidated=0;
 private clmmValidated=0;
 private clmmStarted=false;
 private orcaFailures=new Map<string,string>();
 private running=false;private refreshing=false;
 private timer?:ReturnType<typeof setInterval>;
 private failures:string[]=[];
 private quoteAttempts=0;private quoteMisses=0;
 constructor(private readonly rpc:Connection,private readonly feed:MarketDataFeed,
  private readonly opts:{maxPools:number;perPair:number;minLiquidityUsd:number;
   maxAgeMs:number;maxSlotSkew:number;refreshMs:number},
  private readonly notify:()=>void){
  this.setAllowedMints(Object.values(GRAPH_ASSETS).map(x=>x.mint));
  // The Anchor provider's signer is ephemeral and NEVER used to construct or send a transaction.
  const provider=new AnchorProvider(rpc,new Wallet(Keypair.generate()),{commitment:'confirmed'});
  const ctx=WhirlpoolContext.withProvider(provider);
  const client=buildWhirlpoolClient(ctx);
  this.orca=new LocalWhirlpoolQuoter(feed,ctx.program.programId,client.getFetcher(),
   opts.maxAgeMs,opts.maxSlotSkew,notify,this.allowedMints,ctxPrefix);
  this.clmm=new ClmmMonitor(rpc,[],[5],opts.minLiquidityUsd,
   Math.min(6,opts.maxPools),45000,opts.maxAgeMs,notify,
   feed,opts.maxSlotSkew,this.allowedMints,ctxPrefix);
 }
 /** Called by the owning C3 graph whenever its active mint registry rotates.
  * Keeps SDK quote adapters aligned without creating a parallel scanner. */
 setAllowedMints(mints:readonly string[]){
  this.allowedMints.clear();
  for(const mint of mints)this.allowedMints.add(mint);
 }
 private error(error:unknown){this.failures.unshift(String(error));this.failures=this.failures.slice(0,8);}
 private selected(candidates:Candidate[]):Candidate[]{
  const groups=new Map<string,Candidate[]>();
  for(const c of candidates){
   if(c.liquidityUsd<this.opts.minLiquidityUsd)continue;
   const pair=[c.tokenA,c.tokenB].sort().join('/');
   const set=groups.get(pair)??[];set.push(c);groups.set(pair,set);
  }
  const rows=[...groups.values()].map(x=>x.sort((a,b)=>b.liquidityUsd-a.liquidityUsd));
  const chosen:Candidate[]=[];
  const seen=new Set<string>();
  for(let rank=0;rank<this.opts.perPair;rank++)for(const row of rows){
   const c=row[rank];
   if(c&&!seen.has(c.address)&&chosen.length<this.opts.maxPools){
    seen.add(c.address);chosen.push(c);
   }
  }
  return chosen;
 }
 /** Registry-sourced Orca addresses are already program-owner/mint verified.
  * They still pass through the existing Orca SDK pool/tick-array validation
  * before becoming ready graph quote sources.
  */
 setRegistryOrcaCandidates(rows:ReadonlyArray<{
  address:string;tokenA:GraphAsset;tokenB:GraphAsset;liquidityUsd:number
 }>){
  const selected=this.selected(rows.map(x=>({...x,program:'orca_whirlpool' as const})));
  this.registryOrca=selected;
  if(!this.running)return;
  if(this.refreshing){this.orcaRegistryPending=true;return}
  void this.discoverOrca();
 }
 /** Raydium CLMM candidate addresses are already validated by C3 graph discovery. */
 async setRaydiumCandidates(rows:ReadonlyArray<{address:string;tokenA:GraphAsset;tokenB:GraphAsset;liquidityUsd:number}>){
  if(!this.running)return;
  const selected=this.selected(rows.map(r=>({...r,program:'raydium_clmm' as const})));
  this.clmmValidated=selected.length;
  const keep=new Set(selected.map(x=>x.address));
  for(const [addr,p] of this.pools)if(p.program==='raydium_clmm'&&!keep.has(addr))this.pools.delete(addr);
  for(const c of selected)this.pools.set(c.address,c);
  const listed:DiscoveredPool[]=selected.map(x=>({
   address:x.address,owner:RAYDIUM_CLMM,venue:'raydium',liquidityUsd:x.liquidityUsd
  }));
  this.clmm.replacePools(listed);
  // Do not start the CLMM timer with an empty candidate universe: the
  // initial SDK initialization may otherwise occupy the scan lock while the
  // real candidate list arrives, silently skipping the first bootstrap.
  if(!this.clmmStarted&&selected.length){
   this.clmmStarted=true;
   this.clmm.start();
  }else if(this.clmmStarted)await this.clmm.scanOnce();
  this.notify();
 }
 private async discoverOrca(){
  if(!this.running||this.refreshing)return;
  this.refreshing=true;
  try{
   const controller=new AbortController();
   const timeout=setTimeout(()=>controller.abort(),8000);
   try{
    const response=await fetch('https://api.orca.so/v2/solana/pools',{
     signal:controller.signal,headers:{accept:'application/json'}});
    if(!response.ok)throw Error('Orca discovery HTTP '+response.status);
    this.apiOrca=parseOrcaGraphCandidates(await response.json());
   }catch(error){
    this.error('Orca API discovery: '+String(error));
   }finally{clearTimeout(timeout)}
   // Keep already verified registry sources even when Orca's metadata API
   // is unavailable; do not let API ordering hide another SOL/token pool.
   const merged=new Map<string,Candidate>();
   for(const c of [...this.registryOrca,...this.apiOrca])
    if(!merged.has(c.address))merged.set(c.address,c);
   const rows=this.selected([...merged.values()]);
   const verified:Candidate[]=[];
   for(let i=0;i<rows.length;i+=75){
    const batch=rows.slice(i,i+75);
    const response=await this.rpc.getMultipleAccountsInfoAndContext(
     batch.map(c=>new PublicKey(c.address)),'confirmed');
    for(let j=0;j<batch.length;j++){
     const info=response.value[j],c=batch[j];
     if(!info||info.owner.toBase58()!==ORCA_WHIRLPOOL)continue;
     try{
      const pool=ParsableWhirlpool.parse(new PublicKey(c.address),info);
      if(!pool||assetOfMint(pool.tokenMintA.toBase58())!==c.tokenA||
       assetOfMint(pool.tokenMintB.toBase58())!==c.tokenB)continue;
      verified.push(c);
      this.feed.expectOwner(c.address,ORCA_WHIRLPOOL);
      if(!this.orcaReleases.has(c.address))
       this.orcaReleases.set(c.address,this.feed.watch(c.address));
      this.feed.ingest(c.address,info,response.context.slot,'rpc_bootstrap');
     }catch{/* unsupported Whirlpool variant */}
    }
   }
   this.orcaValidated=verified.length;
   const keep=new Set(verified.map(x=>x.address));
   for(const [addr,release] of this.orcaReleases)if(!keep.has(addr)){
    this.orca.forget(addr);release();this.orcaReleases.delete(addr);this.pools.delete(addr);
    this.orcaFailures.delete(addr);
   }
   for(const c of verified){
    this.pools.set(c.address,c);
    try{await this.orca.prepare(c.address);this.orcaFailures.delete(c.address)}
    catch(err){this.orcaFailures.set(c.address,String(err));this.error('Orca '+c.address+': '+String(err))}
   }
   this.notify();
  }catch(error){this.error('C3C Orca discovery: '+String(error))}
  finally{
   this.refreshing=false;
   if(this.running&&this.orcaRegistryPending){
    this.orcaRegistryPending=false;
    void this.discoverOrca();
   }
  }
 }
 start(){
  if(this.running)return;
  this.running=true;
  void this.discoverOrca();
  this.timer=setInterval(()=>{void this.discoverOrca()},this.opts.refreshMs);
 }
 snapshot(now=Date.now()):{pools:GraphPool[];health:ConcentratedSnapshot}{
  const pools:GraphPool[]=[];
  let readyOrca=0,readyClmm=0;
  for(const c of this.pools.values()){
   const state=c.program==='orca_whirlpool'
    ?this.orca.graphSnapshot(c.address,now):this.clmm.graphSnapshot(c.address,now);
   if(!state||assetOfMint(state.mintA)!==c.tokenA||
    assetOfMint(state.mintB)!==c.tokenB)continue;
   if(c.program==='orca_whirlpool')readyOrca++;else readyClmm++;
   const program=c.program,address=c.address;
   pools.push({address,program,tokenA:c.tokenA,tokenB:c.tokenB,
    reserveA:'0',reserveB:'0',feeNumerator:'0',feeDenominator:'1000000',
    observedAt:state.observedAt,poolSlot:state.poolSlot,vaultSlot:state.tickSlot,
    liquidityUsd:c.liquidityUsd,snapshotIntegrity:'bounded_slot_research',
    quoteExactInput:(from,raw)=>{
     this.quoteAttempts++;
     if(!this.running||raw<=0n){this.quoteMisses++;return null;}
     const mint=GRAPH_ASSETS[from]?.mint;
     if(!mint){this.quoteMisses++;return null;}
     const quote=program==='orca_whirlpool'
      ?this.orca.quoteByInputMint(address,mint,raw)
      :this.clmm.quoteByInputMint(address,mint,raw);
     if(!quote){this.quoteMisses++;return null;}
     try{return BigInt(quote.outputRaw)}catch{this.quoteMisses++;return null}
    }
   });
  }
  // Diagnostics report every tracked concentrated pool, including those
  // excluded before the graph evaluator sees them. No silent readiness loss.
  const clmmStatus=this.clmm.snapshot();
  const orcaPools=[...this.pools.values()]
   .filter(c=>c.program==='orca_whirlpool').map(c=>{
    const ready=this.orca.graphSnapshot(c.address,now)!==null;
    return {pool:c.address,pair:c.tokenA+'/'+c.tokenB,
     state:ready?'ready' as const:'not_ready' as const,
     reason:ready?undefined:this.orcaFailures.get(c.address)??
      'tick_arrays_missing_or_snapshot_stale_or_slot_skew'};
   });
  const clmmPools=clmmStatus.perPool.map(row=>{
   const pool=this.pools.get(row.pool);
   return {pool:row.pool,pair:pool?pool.tokenA+'/'+pool.tokenB:'unknown',
    status:row.status,reason:row.reason,lastObservedAt:row.lastObservedAt,
    ageMs:row.ageMs,tickArrays:row.tickArrays,slot:row.slot??null,
    tickArraySlot:row.tickArraySlot??null,
    tickArraySlotVerified:row.tickArraySlotVerified??false};
  });
  return {pools,health:{
   trackedOrca:[...this.pools.values()].filter(p=>p.program==='orca_whirlpool').length,
   trackedClmm:[...this.pools.values()].filter(p=>p.program==='raydium_clmm').length,
   readyOrca,readyClmm,validatedOrca:this.orcaValidated,
   validatedClmm:this.clmmValidated,quotesAttempted:this.quoteAttempts,
   quoteMisses:this.quoteMisses,orcaPools,clmmPools,
   clmmScan:{status:clmmStatus.status,scans:clmmStatus.scans,
    lastUpdatedAt:clmmStatus.lastUpdatedAt,
    activeTickSubscriptions:clmmStatus.activeTickSubscriptions??0},
   discoveryErrors:[...this.failures,...clmmStatus.errors].slice(0,8)
  }};
 }
 stop(){
  this.running=false;
  if(this.timer)clearInterval(this.timer);
  this.orca.stop();this.clmm.stop();this.clmmStarted=false;this.orcaFailures.clear();
  for(const release of this.orcaReleases.values())release();
  this.orcaReleases.clear();this.pools.clear();
  this.registryOrca=[];this.apiOrca=[];this.orcaRegistryPending=false;
 }
}

import { Connection, PublicKey } from '@solana/web3.js';
import { SOL_MINT, USDC_MINT, type DiscoveredPool } from './discovery.js';
import { RAYDIUM_AMM_V4 } from './routes.js';

const TOKEN_PROGRAM='TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_ACCOUNT_LEN=165;
const AMM_AUTHORITY=PublicKey.findProgramAddressSync([Buffer.from('amm authority')],new PublicKey(RAYDIUM_AMM_V4))[0].toBase58();
export type AmmV4State={
 address:string;baseVault:string;quoteVault:string;baseMint:string;quoteMint:string;
 baseNeedTakePnl:bigint;quoteNeedTakePnl:bigint;feeNumerator:bigint;feeDenominator:bigint;status:bigint;
};
export type AmmV4Quote={
 pool:string;direction:'USDC_TO_SOL'|'SOL_TO_USDC';inputRaw:string;outputRaw:string;
 slot:number;vaultSlot:number;observedAt:string;feeNumerator:string;feeDenominator:string;
 reserveInRaw:string;reserveOutRaw:string;
 classification:'indicative_non_executable';
};
export type AmmV4Snapshot={status:'idle'|'scanning'|'ok'|'partial_error';lastUpdatedAt?:string;quotes:AmmV4Quote[];errors:string[];poolCount:number;
 progress?:{totalPools:number;completedPools:number;quotesProduced:number;currentPool?:string};};
const key=(b:Buffer,o:number)=>new PublicKey(b.subarray(o,o+32)).toBase58();
const u64=(b:Buffer,o:number)=>b.readBigUInt64LE(o);
const ceilDiv=(n:bigint,d:bigint)=>(n+d-1n)/d;

export function decodeAmmV4(address:string,data:Buffer):AmmV4State {
 if(data.length!==752)throw new Error('AMM v4 account must be exactly 752 bytes');
 const status=u64(data,0);
 if(status!==6n)throw new Error(`AMM v4 swap status ${status} not enabled`);
 const feeNumerator=u64(data,176),feeDenominator=u64(data,184);
 if(feeDenominator===0n||feeNumerator>=feeDenominator)throw new Error('Invalid AMM v4 swap fees');
 const baseMint=key(data,400),quoteMint=key(data,432);
 if(!((baseMint===SOL_MINT&&quoteMint===USDC_MINT)||(baseMint===USDC_MINT&&quoteMint===SOL_MINT)))throw new Error('Pool does not contain the canonical SOL/USDC mints');
 return {address,baseVault:key(data,336),quoteVault:key(data,368),baseMint,quoteMint,
  baseNeedTakePnl:u64(data,192),quoteNeedTakePnl:u64(data,200),feeNumerator,feeDenominator,status};
}
export function decodeVault(data:Buffer,expectedMint:string,expectedAuthority?:string):bigint {
 if(data.length!==TOKEN_ACCOUNT_LEN)throw new Error('Expected legacy SPL token account length 165');
 if(key(data,0)!==expectedMint)throw new Error('Token vault mint mismatch');
 if(expectedAuthority && key(data,32)!==expectedAuthority)throw new Error('Token vault authority mismatch');
 if(data[108]!==1)throw new Error('Token vault not initialized');
 return u64(data,64);
}
export function amountOutExactInput(amountIn:bigint,reserveIn:bigint,reserveOut:bigint,feeNum:bigint,feeDen:bigint):bigint {
 if(amountIn<=0n||reserveIn<=0n||reserveOut<=0n||feeDen<=0n||feeNum<0n||feeNum>=feeDen)throw new Error('Invalid amount, reserves, or fee');
 const fee=ceilDiv(amountIn*feeNum,feeDen);
 const adjusted=amountIn-fee;
 if(adjusted<=0n)return 0n;
 return adjusted*reserveOut/(reserveIn+adjusted);
}
export function quoteV4(state:AmmV4State,baseVaultBalance:bigint,quoteVaultBalance:bigint,usdcInputRaw:bigint,slot:number,vaultSlot:number):AmmV4Quote {
 const base=baseVaultBalance-state.baseNeedTakePnl;
 const quote=quoteVaultBalance-state.quoteNeedTakePnl;
 if(base<=0n||quote<=0n)throw new Error('Effective reserves exhausted or negative');
 const usdcIsBase=state.baseMint===USDC_MINT;
 const inputReserve=usdcIsBase?base:quote,outputReserve=usdcIsBase?quote:base;
 return {pool:state.address,direction:'USDC_TO_SOL',inputRaw:usdcInputRaw.toString(),
  outputRaw:amountOutExactInput(usdcInputRaw,inputReserve,outputReserve,state.feeNumerator,state.feeDenominator).toString(),
  slot,vaultSlot,observedAt:new Date().toISOString(),feeNumerator:state.feeNumerator.toString(),feeDenominator:state.feeDenominator.toString(),
  reserveInRaw:inputReserve.toString(),reserveOutRaw:outputReserve.toString(),classification:'indicative_non_executable'};
}
export function quoteReverse(state:AmmV4State,baseVaultBalance:bigint,quoteVaultBalance:bigint,solInputRaw:bigint,slot:number,vaultSlot:number):AmmV4Quote {
 const base=baseVaultBalance-state.baseNeedTakePnl,quote=quoteVaultBalance-state.quoteNeedTakePnl;
 if(base<=0n||quote<=0n)throw new Error('Effective reserves exhausted or negative');
 const solIsBase=state.baseMint===SOL_MINT;
 const inputReserve=solIsBase?base:quote,outputReserve=solIsBase?quote:base;
 return {pool:state.address,direction:'SOL_TO_USDC',inputRaw:solInputRaw.toString(),
  outputRaw:amountOutExactInput(solInputRaw,inputReserve,outputReserve,state.feeNumerator,state.feeDenominator).toString(),
  slot,vaultSlot,observedAt:new Date().toISOString(),feeNumerator:state.feeNumerator.toString(),feeDenominator:state.feeDenominator.toString(),
  reserveInRaw:inputReserve.toString(),reserveOutRaw:outputReserve.toString(),classification:'indicative_non_executable'};
}

export class AmmV4Monitor {
 private timer?:ReturnType<typeof setTimeout>;
 private active=false;private busy=false;
 private state:AmmV4Snapshot={status:'idle',quotes:[],errors:[],poolCount:0};
 constructor(private readonly conn:Connection,private readonly pools:DiscoveredPool[],private readonly sizesUsd:number[],private readonly intervalMs=60000,private readonly maxSlotSkew=12){}
 snapshot():AmmV4Snapshot{return {...this.state,quotes:[...this.state.quotes],errors:[...this.state.errors]};}
 async scanOnce(){
  if(this.busy)return;
  this.busy=true;
  const supported=this.pools.filter(p=>p.owner===RAYDIUM_AMM_V4&&(p.venue==='raydium'||p.venue==='manual'));
  this.state={...this.state,status:'scanning',poolCount:supported.length,progress:{totalPools:supported.length,completedPools:0,quotesProduced:0}};
  const quotes:AmmV4Quote[]=[],errors:string[]=[];
  try{
   let completed=0;
   for(const pool of supported){
    this.state={...this.state,progress:{totalPools:supported.length,completedPools:completed,quotesProduced:quotes.length,currentPool:pool.address}};
    try{
     const poolKey=new PublicKey(pool.address);
     const snapshot=await this.conn.getMultipleAccountsInfoAndContext([poolKey],'confirmed');
     const info=snapshot.value[0];
     if(!info||info.owner.toBase58()!==RAYDIUM_AMM_V4||info.executable)throw new Error('Pool missing or wrong program owner');
     const state=decodeAmmV4(pool.address,info.data);
     const keys=[new PublicKey(state.baseVault),new PublicKey(state.quoteVault)];
     const vaults=await this.conn.getMultipleAccountsInfoAndContext(keys,{commitment:'confirmed',minContextSlot:snapshot.context.slot});
     if(vaults.context.slot-snapshot.context.slot>this.maxSlotSkew)throw new Error('Vault snapshot too far from pool slot for an indicative quote');
     const [a,b]=vaults.value;
     if(!a||!b||a.owner.toBase58()!==TOKEN_PROGRAM||b.owner.toBase58()!==TOKEN_PROGRAM)throw new Error('Unexpected token-vault program');
     const base=decodeVault(a.data,state.baseMint,AMM_AUTHORITY),quote=decodeVault(b.data,state.quoteMint,AMM_AUTHORITY);
     for(const size of this.sizesUsd){
      const raw=BigInt(Math.round(size*1e6));
      quotes.push(quoteV4(state,base,quote,raw,snapshot.context.slot,vaults.context.slot));
     }
    }catch(err){errors.push(`${pool.address}: ${String(err)}`);}
    finally{completed++;this.state={...this.state,progress:{totalPools:supported.length,completedPools:completed,quotesProduced:quotes.length}};}
   }
  }finally{
   this.busy=false;
   this.state={status:errors.length?'partial_error':'ok',lastUpdatedAt:new Date().toISOString(),quotes,errors,poolCount:supported.length,progress:{totalPools:supported.length,completedPools:supported.length,quotesProduced:quotes.length}};
  }
 }
 start(){if(this.active)return;this.active=true;const loop=async()=>{if(!this.active)return;try{await this.scanOnce();}catch(e){this.state={...this.state,status:'partial_error',errors:[String(e)]};}if(this.active)this.timer=setTimeout(()=>{void loop();},this.intervalMs);};if(this.state.lastUpdatedAt)this.timer=setTimeout(()=>{void loop();},this.intervalMs);else void loop();}
 stop(){this.active=false;if(this.timer)clearTimeout(this.timer);}
}

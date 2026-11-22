import {mkdir,open,appendFile,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {PublicKey,type Connection} from '@solana/web3.js';
import {analyzeChainTransaction,summarizeChainEvidence,type ChainEvidence} from './c3ArbitrageEvidence.js';

export type ChainSampleConfig={
 maxSeedPools:number;signaturesPerPool:number;maxTransactions:number;
 cooldownMs:number;maxRows:number;
};
export type ChainSampleStatus={
 phase:'C3A';mode:'READ_ONLY';running:boolean;startedAt?:string;finishedAt?:string;
 lastRejection?:string;attempts:number;completedRuns:number;
 seedPools:string[];progress:{signaturesDiscovered:number;transactionsRequested:number;
  transactionsAnalyzed:number;missingTransactions:number;errors:number};
 summary:ReturnType<typeof summarizeChainEvidence>;
 observations:ChainEvidence[];errors:string[];
 limitations:string[];
};
const LIMITATIONS=[
 'Samples recent transactions mentioning configured pool addresses; it is not a complete chain index.',
 'Solana pool-address signatures may miss trades routed through other accounts or DEXes.',
 'Fee payer is not always the arbitrage beneficiary; PDA inventory and inner swap flows may remain unattributed.',
 'USDC balance gains are not verified net arbitrage profit, even when DEX logs and inventory look closed.',
 'SOL network fees are not USD-converted; Jito tips, rent and ancillary costs are not independently attributed.',
 'A sample without candidate transactions does not prove that no arbitrage opportunities exist.'
];
export class ChainHistorySampler{
 private readonly journal:string;
 private running=false;private startedAt?:string;private finishedAt?:string;
 private lastAttemptAt=0;private lastRejection?:string;
 private attempts=0;private completedRuns=0;
 private seedPools:string[]=[];
 private counts={signaturesDiscovered:0,transactionsRequested:0,transactionsAnalyzed:0,
  missingTransactions:0,errors:0};
 private rows:ChainEvidence[]=[];
 private known=new Set<string>();
 private errors:string[]=[];
 constructor(private readonly rpc:Connection,dir:string,private readonly options:ChainSampleConfig){
  if(!Number.isSafeInteger(options.maxSeedPools)||options.maxSeedPools<1||options.maxSeedPools>12||
   !Number.isSafeInteger(options.signaturesPerPool)||options.signaturesPerPool<1||options.signaturesPerPool>50||
   !Number.isSafeInteger(options.maxTransactions)||options.maxTransactions<1||options.maxTransactions>80||
   !Number.isSafeInteger(options.maxRows)||options.maxRows<1||options.maxRows>1000||
   !Number.isSafeInteger(options.cooldownMs)||options.cooldownMs<0)
   throw new Error('Invalid C3 history sampler options');
  this.journal=join(dir,'c3-onchain-evidence.jsonl');
 }
 async initialize(){
  await mkdir(join(this.journal,'..'),{recursive:true}).catch(async()=>{
   const dir=this.journal.slice(0,this.journal.lastIndexOf('/'));
   await mkdir(dir,{recursive:true});
  });
  try{
   const size=(await stat(this.journal)).size;
   // Only read the most recent 5 MB from a long-lived journal.
   const bytes=Math.min(size,5_000_000),start=size-bytes;
   const h=await open(this.journal,'r');
   let data='';
   try{
    const b=Buffer.alloc(bytes);
    const read=await h.read(b,0,bytes,start);
    data=b.subarray(0,read.bytesRead).toString('utf8');
   }finally{await h.close()}
   if(start>0)data=data.slice(Math.max(0,data.indexOf('\n')+1));
   for(const line of data.split('\n')){
    if(!line.trim())continue;
    try{
     const obj=JSON.parse(line) as ChainEvidence;
     if(typeof obj.signature==='string'&&obj.readOnly===true&&
      typeof obj.status==='string'&&typeof obj.slot==='number'){
      this.known.add(obj.signature);
      this.rows.push(obj);
     }
    }catch{ /* tolerate truncated line or older journal version */ }
   }
   this.rows=this.rows.slice(-this.options.maxRows);
   this.known=new Set(this.rows.map(x=>x.signature));
  }catch(error){
   if((error as NodeJS.ErrnoException).code!=='ENOENT')this.note('Could not load evidence journal: '+String(error));
  }
 }
 private note(msg:string){
  this.errors.unshift(msg);
  this.errors=this.errors.slice(0,8);
 }
 snapshot():ChainSampleStatus{
  const records=[...this.rows].reverse();
  return {phase:'C3A',mode:'READ_ONLY',running:this.running,
   startedAt:this.startedAt,finishedAt:this.finishedAt,
   lastRejection:this.lastRejection,attempts:this.attempts,
   completedRuns:this.completedRuns,seedPools:[...this.seedPools],
   progress:{...this.counts},summary:summarizeChainEvidence(records),
   observations:records.slice(0,80),errors:[...this.errors],limitations:[...LIMITATIONS]};
 }
 request(seedPools:readonly string[]):{accepted:boolean;message:string}{
  if(this.running)return this.reject('Historical transaction scan is already in progress');
  if(seedPools.length===0)return this.reject('No discovered pool addresses are available to sample');
  const remaining=this.options.cooldownMs-(Date.now()-this.lastAttemptAt);
  if(remaining>0)return this.reject('On-chain scan cooldown: '+Math.ceil(remaining/1000)+' seconds');
  const usable=[...new Set(seedPools)].slice(0,this.options.maxSeedPools);
  // Validate each pool before accepting; no external arbitrary URLs.
  try{usable.forEach(address=>new PublicKey(address))}catch{return this.reject('Invalid pool address in sample universe')}
  this.running=true;
  this.attempts++;this.lastAttemptAt=Date.now();
  this.lastRejection=undefined;
  this.startedAt=new Date().toISOString();
  this.seedPools=usable;this.counts={signaturesDiscovered:0,transactionsRequested:0,
   transactionsAnalyzed:0,missingTransactions:0,errors:0};
  void this.collect(usable).catch(error=>{
   this.counts.errors++;this.note('C3 historical sample aborted: '+String(error));
  }).finally(()=>{this.running=false;this.finishedAt=new Date().toISOString();this.completedRuns++});
  return {accepted:true,message:'C3A historical sample started; poll /api/c3 until running=false. No transactions are sent.'};
 }
 private reject(message:string){
  this.lastRejection=message;
  return {accepted:false,message};
 }
 private async collect(pools:readonly string[]){
  const all=new Map<string,{signature:string;slot:number;seedPool:string}>();
  for(const pool of pools){
   try{
    const rows=await this.rpc.getSignaturesForAddress(new PublicKey(pool),{
     limit:this.options.signaturesPerPool
    },'confirmed');
    for(const row of rows)if(!all.has(row.signature)&&!this.known.has(row.signature))
     all.set(row.signature,{signature:row.signature,slot:row.slot,seedPool:pool});
   }catch(error){this.counts.errors++;this.note('Signature query '+pool+': '+String(error));}
  }
  this.counts.signaturesDiscovered=all.size;
  const targets=[...all.values()].sort((a,b)=>b.slot-a.slot)
   .slice(0,this.options.maxTransactions);
  for(const {signature,seedPool} of targets){
   this.counts.transactionsRequested++;
   try{
    const parsed=await this.rpc.getParsedTransaction(signature,{
     commitment:'confirmed',maxSupportedTransactionVersion:0
    });
    if(!parsed){this.counts.missingTransactions++;continue;}
    const evidence=analyzeChainTransaction(signature,seedPool,parsed);
    await appendFile(this.journal,JSON.stringify(evidence)+'\n',{encoding:'utf8'});
    this.rows.push(evidence);
    this.known.add(signature);
    if(this.rows.length>this.options.maxRows){
     const removed=this.rows.shift();
     if(removed)this.known.delete(removed.signature);
    }
    this.counts.transactionsAnalyzed++;
   }catch(error){this.counts.errors++;this.note('History tx '+signature+': '+String(error));}
  }
 }
}

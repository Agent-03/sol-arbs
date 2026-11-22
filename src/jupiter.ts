import { SOL_MINT, USDC_MINT } from './discovery.js';

export type Quote = { inAmount: bigint; outAmount: bigint; router: string; feeBps: number | null };
export type QuoteObservation = {
  observedAt: string;
  sizeUsd: number;
  forward: { input: string; output: string; router: string; feeBps: number | null };
  reverse: { input: string; output: string; router: string; feeBps: number | null };
  estimatedGrossUsd: number;
  assumedExecutionCostUsd: number;
  estimatedNetUsd: number;
  classification: 'indicative_positive' | 'indicative_negative';
  disclaimer: string;
};
export type QuoteStatus = {
  status: 'idle' | 'scanning' | 'ok' | 'partial_error';
  lastScanStartedAt?: string; lastScanFinishedAt?: string;
  observations: QuoteObservation[]; errors: string[];
  count: number;
};
export type QuoteConfig = {
  apiKey?: string;
  sizesUsd: number[];
  intervalMs: number;
  minRequestSpacingMs: number;
  assumedCostUsd: number;
};

const DISCLAIMER = 'Sequential, quote-only API observations; NOT an atomic executable arbitrage route or realized profit. Prices can change between requests. Swap/priority/landing costs are assumptions, not validated execution fees.';
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function rawAmount(v: unknown): bigint {
  if (typeof v !== 'string' || !/^\d+$/.test(v)) throw new Error('Invalid Jupiter amount');
  const amount = BigInt(v);
  if (amount <= 0n) throw new Error('Jupiter returned zero amount');
  return amount;
}
export function parseOrder(value: unknown): Quote {
  if (!value || typeof value !== 'object') throw new Error('Malformed Jupiter response');
  const o = value as Record<string, unknown>;
  if (o.errorCode || o.errorMessage) throw new Error(`Jupiter quote error: ${String(o.errorMessage ?? o.errorCode)}`);
  return {
    inAmount: rawAmount(o.inAmount),
    outAmount: rawAmount(o.outAmount),
    router: typeof o.router === 'string' ? o.router : 'unknown',
    feeBps: typeof o.feeBps === 'number' && Number.isFinite(o.feeBps) ? o.feeBps : null
  };
}
export function evaluateRoundTrip(sizeUsd: number, first: Quote, second: Quote, assumedCostUsd: number, observedAt: string): QuoteObservation {
  const original = BigInt(Math.round(sizeUsd * 1_000_000));
  if (first.inAmount !== original || second.inAmount !== first.outAmount) {
    throw new Error('Non-contiguous quote route or unexpected amount');
  }
  const grossRaw = second.outAmount - original;
  const gross = Number(grossRaw) / 1_000_000;
  const net = gross - assumedCostUsd;
  return {
    observedAt, sizeUsd,
    forward: { input: first.inAmount.toString(), output: first.outAmount.toString(), router: first.router, feeBps: first.feeBps },
    reverse: { input: second.inAmount.toString(), output: second.outAmount.toString(), router: second.router, feeBps: second.feeBps },
    estimatedGrossUsd: Math.round(gross * 1e6) / 1e6,
    assumedExecutionCostUsd: assumedCostUsd,
    estimatedNetUsd: Math.round(net * 1e6) / 1e6,
    classification: net > 0 ? 'indicative_positive' : 'indicative_negative',
    disclaimer: DISCLAIMER
  };
}

export class JupiterMonitor {
  private timer?: ReturnType<typeof setTimeout>;
  private running = false;
  private state: QuoteStatus = {status:'idle',observations:[],errors:[],count:0};
  constructor(private readonly config: QuoteConfig, private readonly baseUrl='https://api.jup.ag/swap/v2/order') {}
  snapshot(): QuoteStatus { return {...this.state, observations:[...this.state.observations],errors:[...this.state.errors]}; }
  private async order(inputMint: string,outputMint:string,amount: bigint):Promise<Quote>{
    const url = new URL(this.baseUrl);
    url.searchParams.set('inputMint',inputMint);
    url.searchParams.set('outputMint',outputMint);
    url.searchParams.set('amount',amount.toString());
    const controller = new AbortController();
    const timeout = setTimeout(()=>controller.abort(),10000);
    try {
      const headers:Record<string,string>={accept:'application/json'};
      if(this.config.apiKey)headers['x-api-key']=this.config.apiKey;
      const response=await fetch(url,{headers,signal:controller.signal});
      if(!response.ok)throw new Error(`Jupiter HTTP ${response.status}`);
      const quote=parseOrder(await response.json());
      if(quote.inAmount!==amount)throw new Error('Jupiter returned unexpected inAmount');
      return quote;
    } finally {clearTimeout(timeout);}
  }
  async scanOnce(){
    if(this.state.status==='scanning')return;
    this.state={...this.state,status:'scanning',lastScanStartedAt:new Date().toISOString(),errors:[],observations:[]};
    const observations:QuoteObservation[]=[];
    const errors:string[]=[];
    for(const sizeUsd of this.config.sizesUsd){
      if(!this.running && this.timer!==undefined)break;
      try{
        const original=BigInt(Math.round(sizeUsd*1e6));
        const first=await this.order(USDC_MINT,SOL_MINT,original);
        await sleep(this.config.minRequestSpacingMs);
        const second=await this.order(SOL_MINT,USDC_MINT,first.outAmount);
        const result=evaluateRoundTrip(sizeUsd,first,second,this.config.assumedCostUsd,new Date().toISOString());
        observations.push(result);
        console.log(JSON.stringify({event:'jupiter_quote_observation',...result}));
      }catch(error){
        errors.push(`$${sizeUsd}: ${String(error)}`);
        console.error('Jupiter quote failed',sizeUsd,error);
      }
      await sleep(this.config.minRequestSpacingMs);
    }
    this.state={status:errors.length?'partial_error':'ok',lastScanStartedAt:this.state.lastScanStartedAt,lastScanFinishedAt:new Date().toISOString(),observations,errors,count:this.state.count+1};
  }
  start(){
    if(this.running)return;
    this.running=true;
    const loop=async()=>{
      if(!this.running)return;
      try{await this.scanOnce();}catch(error){this.state={...this.state,status:'partial_error',errors:[String(error)]};}
      if(this.running)this.timer=setTimeout(()=>{void loop();},this.config.intervalMs);
    };
    void loop();
  }
  stop(){this.running=false;if(this.timer)clearTimeout(this.timer);}
}

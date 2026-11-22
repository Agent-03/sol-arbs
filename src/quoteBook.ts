/** Preserve last-known, time-stamped quotes while a new scan is in flight.
 * Expired entries remain inspectable but must never be promoted to trading signals.
 */
export type StoredQuote={pool:string;direction:string;inputRaw:string;observedAt:string};
export class LastKnownQuoteBook<T extends StoredQuote>{
 private rows=new Map<string,Map<string,T>>();
 private pending=new Set<string>();
 private completedAt=new Map<string,string>();
 begin(pool:string){this.pending.add(pool);}
 publish(value:T){
  if(this.pending.delete(value.pool))this.rows.set(value.pool,new Map());
  const book=this.rows.get(value.pool)??new Map<string,T>();
  book.set(value.direction+':'+value.inputRaw,value);
  this.rows.set(value.pool,book);
 }
 complete(pool:string,at:string){
  this.pending.delete(pool);
  if(this.rows.get(pool)?.size)this.completedAt.set(pool,at);
 }
 fail(pool:string){this.pending.delete(pool);}
 retain(pools:ReadonlySet<string>){
  for(const pool of this.rows.keys())if(!pools.has(pool)){this.rows.delete(pool);this.completedAt.delete(pool);this.pending.delete(pool);}
 }
 snapshot(now:number,maxAgeMs:number){
  const entries=[...this.rows.values()].flatMap(m=>[...m.values()]);
  const fresh=entries.filter(q=>{
   const time=Date.parse(q.observedAt);
   return Number.isFinite(time)&&time<=now+1000&&now-time<=maxAgeMs;
  });
  const poolStatus=[...this.rows.keys()].map(pool=>({
   pool,refreshing:this.pending.has(pool),lastCompletedAt:this.completedAt.get(pool),
   legs:this.rows.get(pool)?.size??0
  }));
  const quoteState:'refreshing'|'warming'|'fresh'|'expired'=
   this.pending.size?'refreshing':!entries.length?'warming':fresh.length?'fresh':'expired';
  return {entries,freshLegs:fresh.length,expiredLegs:entries.length-fresh.length,poolStatus,quoteState};
 }
}

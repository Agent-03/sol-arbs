import test from 'node:test';
import assert from 'node:assert/strict';
import {LastKnownQuoteBook} from '../src/quoteBook.js';
type Q={pool:string;direction:string;inputRaw:string;observedAt:string;outputRaw:string};
const t=Date.parse('2026-11-22T06:10:00Z');
const a=(pool:string,at=t,outputRaw='100')=>({pool,direction:'USDC_TO_SOL',inputRaw:'5000000',observedAt:new Date(at).toISOString(),outputRaw});
test('refresh begins without removing published quote book',()=>{
 const book=new LastKnownQuoteBook<Q>();
 book.publish(a('orca-1'));
 book.complete('orca-1',new Date(t).toISOString());
 book.begin('orca-1');
 const s=book.snapshot(t+2000,15000);
 assert.equal(s.quoteState,'refreshing');
 assert.equal(s.entries.length,1);
 assert.equal(s.entries[0].outputRaw,'100');
 assert.equal(s.freshLegs,1);
});
test('first new quote replaces that pool atomically and leaves other pools intact',()=>{
 const book=new LastKnownQuoteBook<Q>();
 book.publish(a('orca-1'));
 book.publish(a('orca-2'));
 book.begin('orca-1');
 book.publish(a('orca-1',t+1000,'200'));
 const s=book.snapshot(t+2000,15000);
 assert.equal(s.entries.length,2);
 assert.equal(s.entries.find(v=>v.pool==='orca-1')?.outputRaw,'200');
 assert.equal(s.entries.find(v=>v.pool==='orca-2')?.outputRaw,'100');
});
test('failed refresh preserves previous data, but expiration never resets',()=>{
 const book=new LastKnownQuoteBook<Q>();
 book.publish(a('orca-1'));
 book.begin('orca-1');
 book.fail('orca-1');
 const current=book.snapshot(t+2000,15000);
 const expired=book.snapshot(t+15001,15000);
 assert.equal(current.quoteState,'fresh');
 assert.equal(expired.quoteState,'expired');
 assert.equal(expired.expiredLegs,1);
 assert.equal(expired.entries.length,1);
});
test('removed pools are removed from the quote book',()=>{
 const book=new LastKnownQuoteBook<Q>();
 book.publish(a('orca-1'));book.publish(a('orca-2'));
 book.retain(new Set(['orca-2']));
 assert.deepEqual(book.snapshot(t,15000).entries.map(q=>q.pool),['orca-2']);
});
test('failed quote refresh never advances last completed timestamp',()=>{
 const book=new LastKnownQuoteBook<Q>();
 const before=new Date(t).toISOString(),later=new Date(t+4000).toISOString();
 book.publish(a('orca-1'));book.complete('orca-1',before);
 book.begin('orca-1');book.complete('orca-1',later);
 const s=book.snapshot(t+5000,15000);
 assert.equal(s.poolStatus[0].lastCompletedAt,before);
});

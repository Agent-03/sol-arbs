import {mkdir,appendFile} from 'node:fs/promises';
import {join} from 'node:path';
export type PoolEvent={kind:'account_update'|'account_missing'|'subscription_error'|'poll_error';address:string;source:'websocket'|'poll'|'system';observedAt:string;slot?:number;owner?:string;lamports?:number;dataLength?:number;dataHash?:string;error?:string};
export class Journal{
 constructor(private readonly dir:string){}
 async append(event:PoolEvent){
  await mkdir(this.dir,{recursive:true});
  await appendFile(join(this.dir,`${event.observedAt.slice(0,10)}.jsonl`),JSON.stringify(event)+'\n','utf8');
 }
}

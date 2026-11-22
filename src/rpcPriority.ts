import {AsyncLocalStorage} from 'node:async_hooks';

export type RpcPriority='quotes'|'normal'|'background';
export type RpcTiming={
 phase:'started'|'completed';
 priority:RpcPriority;
 queueWaitMs:number;
 pacingWaitMs?:number;
 transportMs?:number;
 status?:number;
};
type RpcContext={priority:RpcPriority;onTiming?:(event:RpcTiming)=>void};
const storage=new AsyncLocalStorage<RpcContext>();

/** Carries a request's priority through web3.js, Anchor and SDK awaits.
 * It never changes RPC payloads or injects HTTP headers/credentials.
 */
export function withRpcPriority<T>(
 priority:RpcPriority,action:()=>T,onTiming?:(event:RpcTiming)=>void
):T{
 return storage.run({priority,onTiming},action);
}
export function currentRpcContext():Readonly<RpcContext>{
 return storage.getStore()??{priority:'normal'};
}

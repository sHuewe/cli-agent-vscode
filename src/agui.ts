export type Event = {type:string; [key:string]:unknown};
export interface RunInput {threadId:string; runId:string; protocolVersion:"1.0"; messages: Array<{id:string;role:"user"|"assistant";content:string}>;resume?: Array<{interruptId:string;status:"resolved"|"cancelled";payload?:{approved:boolean;rememberForSession?:boolean}}>;}
export function parseSse(buffer:string):{events:Event[];rest:string}{
  const events:Event[]=[];
  let idx:number;
  while((idx=buffer.indexOf("\n\n"))>=0){
    const block=buffer.slice(0,idx); buffer=buffer.slice(idx+2);
    const data=block.split("\n").filter(x=>x.startsWith("data:")).map(x=>x.slice(5).trimStart()).join("\n");
    if(data){const obj:unknown=JSON.parse(data);if(obj&&typeof obj==="object"&&"type" in obj) events.push(obj as Event);}
  }
  return {events,rest:buffer};
}
export function safeApiUrl(input:string):string{
  const url=new URL(input);
  if(url.protocol!=="http:"||!["127.0.0.1","localhost","[::1]"].includes(url.hostname)||url.username||url.password||url.search||url.hash||url.pathname!=="/") throw new Error("Only HTTP loopback API URLs are permitted.");
  return url.origin;
}
export class ApiClient {
  constructor(readonly base:string,private readonly token:string){}
  async request(path:string,method="GET",data?:unknown,signal?:AbortSignal):Promise<Response>{
    const resp=await fetch(this.base+path,{method,headers:{"Authorization":"Bearer "+this.token,...(data===undefined?{}:{"Content-Type":"application/json"}),...(path==="/ag-ui"?{"Accept":"text/event-stream"}:{})},body:data===undefined?undefined:JSON.stringify(data),signal,redirect:"error",cache:"no-store"});
    if(!resp.ok){let message=resp.statusText;try{const body=await resp.json() as {error?:string};message=body.error||message;}catch{}throw new Error("HTTP "+resp.status+": "+message);}
    return resp;
  }
  async newSession():Promise<string>{const r=await this.request("/sessions","POST");const v=await r.json() as {session_id:string};return v.session_id;}
  async closeSession(id:string):Promise<void>{await this.request("/sessions/"+encodeURIComponent(id),"DELETE");}
  async *run(input:RunInput,signal?:AbortSignal):AsyncGenerator<Event>{
    const res=await this.request("/ag-ui","POST",input,signal);
    if(!res.body)throw new Error("No SSE response body");
    const reader=res.body.getReader();const decoder=new TextDecoder();let buffer="";let finished=false;
    try{
      while(true){const chunk=await reader.read();if(chunk.done)break;buffer+=decoder.decode(chunk.value,{stream:true}).replace(/\r\n/g,"\n");const out=parseSse(buffer);buffer=out.rest;
        for(const event of out.events){yield event;if(event.type==="RUN_ERROR"||event.type==="RUN_FINISHED")finished=true;}
      }
      if(!finished)throw new Error("SSE stream ended without RUN_FINISHED/RUN_ERROR.");
    }finally{reader.releaseLock();}
  }
}

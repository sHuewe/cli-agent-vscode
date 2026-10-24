import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
// TypeScript's pure AG-UI parser is bundled for tests by the normal esbuild build.
import esbuild from "esbuild";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
const tmp=mkdtempSync(join(tmpdir(),"cli-agent-agui-test-"));
let parseSse,safeApiUrl,ApiClient;
try{
 const outfile=join(tmp,"agui.cjs");
 await esbuild.build({entryPoints:["src/agui.ts"],bundle:true,platform:"node",format:"cjs",outfile,logLevel:"silent"});
 ({parseSse,safeApiUrl,ApiClient}=await import(outfile));
}finally{rmSync(tmp,{recursive:true,force:true});}
test("SSE parser respects split frames and multiline data",()=>{
 const one='data: {"type":"RUN_STARTED"}\n\n';
 const split='data: {"type":"RUN_FINISHED","outcome":{"type":"interrupt"}}';
 const a=parseSse(one+split.slice(0,11));
 assert.equal(a.events.length,1);
 const b=parseSse(a.rest+split.slice(11)+"\n\n");
 assert.equal(b.events[0].type,"RUN_FINISHED");
 assert.equal(b.events[0].outcome.type,"interrupt");
});
test("reject remote origins and unsafe URLs",()=>{
 for(const input of ["https://127.0.0.1:8765","http://evil.com:8765","http://127.0.0.1:8765/a","http://user:pass@localhost:8765/"])
  assert.throws(()=>safeApiUrl(input));
 assert.equal(safeApiUrl("http://127.0.0.1:8765"),"http://127.0.0.1:8765");
});
test("API attaches credentials and accepts SSE stream",async()=>{
 const previous=globalThis.fetch;
 globalThis.fetch=async(_url,options)=>{
  assert.equal(options.headers.Authorization,"Bearer secret");
  assert.equal(options.headers.Accept,"text/event-stream");
  return new Response('data: {"type":"RUN_FINISHED","outcome":{"type":"success"}}\n\n',{headers:{"content-type":"text/event-stream"}});
 };
 try{
  const client=new ApiClient("http://127.0.0.1:8765","secret");
  const events=[];
  for await(const item of client.run({threadId:"a",runId:"b",protocolVersion:"1.0",messages:[]}))events.push(item);
  assert.equal(events.at(-1).type,"RUN_FINISHED");
 }finally{globalThis.fetch=previous;}
});
test("HTTP errors contain status",async()=>{
 const previous=globalThis.fetch;
 globalThis.fetch=async()=>new Response(JSON.stringify({error:"Denied"}),{status:403,headers:{"Content-Type":"application/json"}});
 try{await assert.rejects(new ApiClient("http://127.0.0.1:8765","x").newSession(),/HTTP 403: Denied/);}
 finally{globalThis.fetch=previous;}
});

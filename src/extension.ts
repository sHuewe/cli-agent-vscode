import * as vscode from "vscode";
import {ApiClient,RunInput,Event} from "./agui";

type Message={id:string;role:"user"|"assistant";content:string};
type Interrupt={id:string;message?:string;metadata?:Record<string,unknown>};
class ChatView implements vscode.WebviewViewProvider {
  private view?:vscode.WebviewView;
  private client?:ApiClient;
  private session?:string;
  private messages:Message[]=[];
  private pending?:Interrupt;
  private running=false;
  constructor(private readonly context:vscode.ExtensionContext){}
  resolveWebviewView(view:vscode.WebviewView):void{
    this.view=view;
    view.webview.options={enableScripts:true};
    view.webview.html=html(view.webview);
    view.webview.onDidReceiveMessage(async (data:unknown)=>{
      if(!data||typeof data!=="object")return;
      const cmd=data as {type?:string;text?:string;decision?:string;id?:string};
      try{
        if(cmd.type==="connect")await this.connect();
        else if(cmd.type==="new")await this.newSession();
        else if(cmd.type==="send"&&typeof cmd.text==="string")await this.send(cmd.text);
        else if(cmd.type==="approval"&&typeof cmd.id==="string"&&typeof cmd.decision==="string")await this.approve(cmd.id,cmd.decision);
        else if(cmd.type==="selection")await this.addSelection();
      }catch(e){this.post({type:"error",text:String(e)});}
    });
    this.post({type:"state",connected:!!this.session,running:this.running});
  }
  private post(message:object):void{void this.view?.webview.postMessage(message);}
  async connect():Promise<void>{
    const config=vscode.workspace.getConfiguration("cliAgent");
    const base=(config.get<string>("apiUrl")||"http://127.0.0.1:8765").trim();
    const {safeApiUrl}=await import("./agui");
    const origin=safeApiUrl(base);
    let token=await this.context.secrets.get("cliAgent.apiToken:"+origin);
    if(!token){token=await vscode.window.showInputBox({prompt:"Bearer token from cli-agent-api startup output",password:true,ignoreFocusOut:true});}
    if(!token)return;
    const candidate=new ApiClient(origin,token);
    await candidate.request("/health");
    const id=await candidate.newSession();
    // Never expose the API credential to Webview JavaScript.
    await this.context.secrets.store("cliAgent.apiToken:"+origin,token);
    this.client=candidate;this.session=id;this.messages=[];this.pending=undefined;
    this.post({type:"reset"});this.post({type:"state",connected:true,running:false});
    this.post({type:"status",text:"Connected · session "+id.slice(0,8)});
  }
  async newSession():Promise<void>{
    if(this.running)throw new Error("Wait until the current run ends.");
    if(!this.client){await this.connect();return;}
    const previous=this.session;
    const id=await this.client.newSession();
    this.session=id;this.messages=[];this.pending=undefined;this.post({type:"reset"});
    this.post({type:"state",connected:true,running:false});
    if(previous){try{await this.client.closeSession(previous);}catch(e){this.post({type:"error",text:"Old session could not be closed: "+e});}}
  }
  async send(text:string):Promise<void>{
    if(!this.client||!this.session)throw new Error("Connect to cli-agent-api first.");
    if(this.running||this.pending)throw new Error("A run or tool approval is still pending.");
    const message=text.trim();if(!message)return;
    if(message.length>200_000)throw new Error("Message too long.");
    const turn:Message={id:crypto.randomUUID(),role:"user",content:message};
    this.messages.push(turn);this.post({type:"message",role:"user",text:message});
    try{await this.run();}catch(e){this.messages.pop();throw e;}
  }
  private async approve(id:string,decision:string):Promise<void>{
    if(this.running||!this.pending||id!==this.pending.id)throw new Error("Approval no longer pending.");
    if(!["yes","no","session"].includes(decision))throw new Error("Invalid approval decision.");
    const payload:RunInput["resume"]=[{interruptId:id,status:"resolved",payload:{approved:decision!=="no",rememberForSession:decision==="session"}}];
    await this.run(payload);
  }
  private async run(resume?:RunInput["resume"]):Promise<void>{
    const client=this.client,session=this.session;
    if(!client||!session)throw new Error("Not connected.");
    this.running=true;this.post({type:"state",connected:true,running:true});
    let accepted=false,finished=false,answer="",interrupted:Interrupt|undefined;
    const input:RunInput={threadId:session,runId:crypto.randomUUID(),protocolVersion:"1.0",messages:this.messages.map(m=>({...m})),...(resume?{resume}:{})};
    try{
      for await(const event of client.run(input)){
        accepted=true;
        const type=event.type;
        if(type==="TEXT_MESSAGE_CONTENT"){const delta=String(event.delta||"");answer+=delta;this.post({type:"delta",text:delta});}
        else if(type==="TOOL_CALL_START")this.post({type:"tool",text:String(event.toolCallName||"Tool")});
        else if(type==="CUSTOM"&&event.name==="mcp_user_message"){const val=event.value as Record<string,unknown>|undefined;this.post({type:"status",text:String(val?.content||"MCP message")});}
        else if(type==="RUN_ERROR")throw new Error(String(event.message||"Agent run failed."));
        else if(type==="RUN_FINISHED"){
          finished=true;
          const outcome=event.outcome as {type?:string;interrupts?:Interrupt[]}|undefined;
          if(outcome?.type==="interrupt")interrupted=outcome.interrupts?.[0];
        }
      }
      if(!finished)throw new Error("Agent run did not complete.");
      if(answer)this.messages.push({id:crypto.randomUUID(),role:"assistant",content:answer});
      this.post({type:"answerEnd"});
      this.pending=interrupted;
      if(interrupted)this.post({type:"approval",id:interrupted.id,text:interrupted.message||"Approve tool call?",metadata:interrupted.metadata});
      else this.post({type:"clearApproval"});
    }catch(err){
      this.post({type:"answerEnd"});
      // Resume attempts must remain actionable after HTTP 429/409/etc.
      if(resume&&!accepted&&this.pending)this.post({type:"approval",id:this.pending.id,text:this.pending.message||"Approve tool call?",metadata:this.pending.metadata});
      else if(!resume&&answer)this.messages.push({id:crypto.randomUUID(),role:"assistant",content:answer});
      throw err;
    }finally{this.running=false;this.post({type:"state",connected:true,running:false});}
  }
  async addSelection():Promise<void>{
    const editor=vscode.window.activeTextEditor;
    if(!editor)throw new Error("Open an editor first.");
    const selection=editor.selection;
    if(selection.isEmpty)throw new Error("Select code first.");
    const root=vscode.workspace.getWorkspaceFolder(editor.document.uri);
    const relative=root?vscode.workspace.asRelativePath(editor.document.uri,false):editor.document.uri.toString();
    const excerpt=editor.document.getText(selection);
    if(excerpt.length>100_000)throw new Error("Selection too large.");
    const content="File: "+relative+"\nLines: "+(selection.start.line+1)+"-"+(selection.end.line+1)+"\n\n"+excerpt;
    this.post({type:"insert",text:content});
    await vscode.commands.executeCommand("cliAgent.chat.focus");
  }
  async dispose():Promise<void>{
    if(this.client&&this.session){try{await this.client.closeSession(this.session);}catch{}}
  }
}
export function activate(context:vscode.ExtensionContext):void{
  const provider=new ChatView(context);
  context.subscriptions.push(vscode.window.registerWebviewViewProvider("cliAgent.chat",provider));
  context.subscriptions.push(vscode.commands.registerCommand("cliAgent.connect",()=>provider.connect()));
  context.subscriptions.push(vscode.commands.registerCommand("cliAgent.newSession",()=>provider.newSession()));
  context.subscriptions.push(vscode.commands.registerCommand("cliAgent.addSelection",()=>provider.addSelection()));
  context.subscriptions.push({dispose:()=>{void provider.dispose();}});
}
export function deactivate():void{}
function html(webview:vscode.Webview):string{
  const nonce=crypto.randomUUID().replaceAll("-","");
  return `<!doctype html><html lang="en"><head><meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style nonce="${nonce}">body{font:var(--vscode-font-size) var(--vscode-font-family);color:var(--vscode-foreground);padding:10px}button,textarea{font:inherit;color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border,transparent);border-radius:4px;padding:6px}button{cursor:pointer}button:disabled{opacity:.5}.bar{display:flex;gap:6px;flex-wrap:wrap}.log{overflow-y:auto;height:calc(100vh - 220px);min-height:120px;margin:12px 0}.msg{white-space:pre-wrap;overflow-wrap:anywhere;margin:8px 0;padding:9px;border-radius:6px;background:var(--vscode-editorWidget-background)}.user{border-left:3px solid var(--vscode-focusBorder)}.assistant{border-left:3px solid var(--vscode-terminal-ansiGreen)}.error{color:var(--vscode-errorForeground)}textarea{width:100%;box-sizing:border-box;resize:vertical;min-height:62px}.approval{border:1px solid var(--vscode-focusBorder);padding:10px;margin:6px 0}.hidden{display:none}</style>
  </head><body><div class="bar"><button id="connect">Connect</button><button id="new" disabled>New chat</button><button id="selection">Add selection</button></div><p id="status">Disconnected</p><div id="log" class="log" aria-live="polite"></div><div id="approval" class="approval hidden"><strong>Tool approval required</strong><pre id="details"></pre><div class="bar"><button data-decision="yes">Allow once</button><button data-decision="session">Allow for session</button><button data-decision="no">Deny</button></div></div><form id="form"><textarea id="prompt" placeholder="Ask cli-agent..." disabled></textarea><button id="send" disabled>Send</button></form>
  <script nonce="${nonce}">(()=>{
  const vscode=acquireVsCodeApi(),$=id=>document.getElementById(id);
  const log=$("log"),prompt=$("prompt"),approval=$("approval");let connected=false,busy=false,approvalId=null,currentAnswer=null;
  const send=message=>vscode.postMessage(message);
  $("connect").onclick=()=>send({type:"connect"});$("new").onclick=()=>send({type:"new"});$("selection").onclick=()=>send({type:"selection"});
  const add=(role,text)=>{const div=document.createElement("div");div.className="msg "+role;div.textContent=text;log.append(div);log.scrollTop=log.scrollHeight;return div;};
  const update=()=>{$("new").disabled=!connected||busy;prompt.disabled=!connected||busy||!!approvalId;$("send").disabled=prompt.disabled;for(const b of approval.querySelectorAll("button"))b.disabled=busy;};
  $("form").onsubmit=event=>{event.preventDefault();const text=prompt.value.trim();if(!text||busy)return;prompt.value="";send({type:"send",text});};
  prompt.onkeydown=event=>{if(event.key==="Enter"&&!event.shiftKey){event.preventDefault();$("form").requestSubmit();}};
  approval.onclick=event=>{const button=event.target.closest("button[data-decision]");if(button&&approvalId&&!busy){send({type:"approval",id:approvalId,decision:button.dataset.decision});busy=true;update();}};
  window.addEventListener("message",({data:m})=>{
    if(m.type==="reset"){log.replaceChildren();currentAnswer=null;approvalId=null;approval.classList.add("hidden");}
    else if(m.type==="state"){connected=m.connected;busy=m.running;$("status").textContent=connected?(busy?"Running...":"Connected"):"Disconnected";update();}
    else if(m.type==="message")add(m.role,m.text);
    else if(m.type==="delta"){if(!currentAnswer)currentAnswer=add("assistant","");currentAnswer.textContent+=m.text;log.scrollTop=log.scrollHeight;}
    else if(m.type==="answerEnd")currentAnswer=null;
    else if(m.type==="error")add("error",m.text);
    else if(m.type==="tool"||m.type==="status")add("system",m.text);
    else if(m.type==="approval"){approvalId=m.id;$("details").textContent=m.text+"\n"+JSON.stringify(m.metadata||{},null,2);approval.classList.remove("hidden");update();}
    else if(m.type==="clearApproval"){approvalId=null;approval.classList.add("hidden");update();}
    else if(m.type==="insert"){prompt.value+=(prompt.value?"\n\n":"")+m.text;prompt.focus();}
  });update();
  })();</script></body></html>`;
}

import { spawn } from "node:child_process";

const documentUrlSource="https?:\\/\\/[A-Za-z0-9.-]+(?::\\d+)?\\/(?:wiki|docx)\\/[A-Za-z0-9_-]+(?:#[A-Za-z0-9_-]+)?";
const pattern=new RegExp(documentUrlSource,"gi");
const notifierEnv={LARKSUITE_CLI_NO_UPDATE_NOTIFIER:"1",LARKSUITE_CLI_NO_SKILLS_NOTIFIER:"1"};
export const documentLinks=(text)=>[...new Set(String(text).match(pattern)||[])];
export const canonicalDocumentLink=(value)=>String(value).match(new RegExp(documentUrlSource,"i"))?.[0]||"";

export function createDocumentReader({driver="lark-cli",larkCliBin="lark-cli",larkDocIdentity="auto",appId,appSecret}){
  if(driver==="lark-cli")return createLarkCliDocumentReader({larkCliBin,identity:larkDocIdentity});
  let token="",expiresAt=0;
  async function request(path,options={}){const response=await fetch(`https://open.feishu.cn${path}`,options);const body=await response.json();if(!response.ok||body.code)throw new Error(body.msg||`飞书接口返回 ${response.status}`);return body.data??body;}
  async function tenantToken(){if(token&&Date.now()<expiresAt)return token;if(!appId||!appSecret)throw new Error("缺少飞书应用凭证");const data=await request("/open-apis/auth/v3/tenant_access_token/internal",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({app_id:appId,app_secret:appSecret})});token=data?.tenant_access_token||data;if(typeof token!=="string")throw new Error("无法获取飞书访问凭证");expiresAt=Date.now()+7000_000;return token;}
  async function api(path){const access=await tenantToken();return request(path,{headers:{authorization:`Bearer ${access}`}});}
  return async(url)=>{const match=url.match(/\/(wiki|docx)\/([A-Za-z0-9_-]+)/);if(!match)throw new Error("仅支持飞书 Wiki / Docx 链接");let documentId=match[2],title="飞书项目文档";if(match[1]==="wiki"){const node=await api(`/open-apis/wiki/v2/spaces/get_node?token=${encodeURIComponent(documentId)}`);if(node?.node?.obj_type!=="docx")throw new Error(`暂不支持 ${node?.node?.obj_type||"未知"} 类型 Wiki 节点`);documentId=node.node.obj_token;title=node.node.title||title;}const [doc,raw]=await Promise.all([api(`/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}`),api(`/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/raw_content`)]);const content=String(raw?.content||"").trim();return{url,documentId,title:String(doc?.document?.title||title),content,excerpt:content.replace(/\s+/g," ").slice(0,1200)};};
}

export function createLarkCliDocumentReader({larkCliBin="lark-cli",identity="auto",run=runCli}={}){
  return async(url)=>{
    const canonicalUrl=canonicalDocumentLink(url),match=canonicalUrl.match(/\/(wiki|docx)\/([A-Za-z0-9_-]+)/);
    if(!match)throw new Error("仅支持飞书 Wiki / Docx 链接");
    const identities=identity==="auto"?["user","bot"]:[identity],errors=[];let result=null,usedIdentity=identities[0];
    for(const candidate of identities)try{result=await run(larkCliBin,["docs","+fetch","--doc",canonicalUrl,"--doc-format","markdown","--detail","simple","--as",candidate,"--format","json"]);usedIdentity=candidate;break;}catch(error){errors.push(`${candidate}: ${error instanceof Error?error.message:"读取失败"}`);}
    if(!result)throw new Error(`飞书正文读取失败（${errors.join("；")}）`);
    const document=result?.data?.document||result?.document||result?.data||result;
    const content=String(document?.content||"").trim();
    if(!content)throw new Error("飞书 CLI 未返回文档正文；请确认当前飞书用户或 Bot 已获得查看权限");
    const title=extractTitle(content)||"飞书项目文档";
    return{url:canonicalUrl,documentId:String(document?.document_id||match[2]),title,content:content.slice(0,100000),excerpt:content.replace(/[#*_`>\[\]]/g,"").replace(/\s+/g," ").slice(0,1200),revisionId:document?.revision_id,identity:usedIdentity};
  };
}

export function createLarkCliDocumentWriter({larkCliBin="lark-cli",identity="user",run=runCli}={}){
  return{async writeGroupSummary({chatId,docUrl=null,summary,generatedAt=new Date().toISOString()}){
    const section=`## ${formatLocalTime(generatedAt)} 群聊进度同步\n\n${String(summary).trim()}\n\n> 来源：飞书群聊 ${chatId}；由 Pulse Agent 基于本周期新增消息生成。`;
    if(!docUrl){const title=`Pulse 群聊同步 · ${String(chatId).slice(-6)}`,content=`# ${title}\n\n此文档由 Pulse 自动维护，用于沉淀群聊中的项目进展、决策、风险与行动项。\n\n${section}`,result=await run(larkCliBin,["docs","+create","--title",title,"--doc-format","markdown","--content","-","--as",identity,"--format","json"],{input:content,action:"创建群聊同步文档"}),document=result?.data?.document||result?.document||result?.data||result,url=String(document?.url||"");if(!url)throw new Error("飞书 CLI 已创建文档但未返回可访问链接");return{url,documentId:String(document?.document_id||"")};}
    await run(larkCliBin,["docs","+update","--doc",docUrl,"--command","append","--doc-format","markdown","--content","-","--as",identity,"--format","json"],{input:`\n\n---\n\n${section}`,action:"追加群聊同步文档"});return{url:docUrl,documentId:extractDocumentId(docUrl)};
  }};
}

export function createLarkCliGroupHistoryReader({larkCliBin="lark-cli",identity="auto",pageLimit=4,run=runCli}={}){
  return async({chatId})=>{
    const safeChatId=String(chatId||"").trim();if(!/^oc_[A-Za-z0-9]+$/.test(safeChatId))throw new Error("当前会话缺少有效的飞书群 chat_id");
    const safePages=Math.max(1,Math.min(20,Number(pageLimit)||4)),identities=identity==="auto"?["user","bot"]:[identity],errors=[];let result=null,usedIdentity=identities[0];for(const candidate of identities)try{result=await run(larkCliBin,["im","+chat-messages-list","--chat-id",safeChatId,"--order","desc","--page-size","50","--page-all","--page-limit",String(safePages),"--no-reactions","--as",candidate,"--format","json"],{timeoutMs:90000,maxOutput:12_000_000,action:"读取群聊历史"});usedIdentity=candidate;break;}catch(error){errors.push(`${candidate}: ${error instanceof Error?error.message:"读取失败"}`);}if(!result)throw new Error(`飞书群聊历史读取失败（${errors.join("；")}）`);const data=result?.data||result||{},messages=Array.isArray(data.messages)?data.messages:[];
    return{identity:result?.identity||usedIdentity,chatId:safeChatId,total:Number(data.total||messages.length),hasMore:Boolean(data.has_more||result?.meta?.pagination?.complete===false),pageToken:data.page_token||result?.meta?.pagination?.next_token||null,messages:messages.filter((item)=>item&&!item.deleted).map(normalizeGroupMessage).filter((item)=>item.messageId&&item.content)};
  };
}

export async function inspectLarkDocumentAccess({larkCliBin="lark-cli",run=runCli}={}){const result=await run(larkCliBin,["auth","status","--json","--verify"],{action:"检查飞书用户授权",timeoutMs:20000}),user=result?.identities?.user||{};return{identity:"user",status:String(user.status||"unknown"),available:Boolean(user.available),verified:Boolean(user.verified),openId:user.openId?String(user.openId):null,userName:user.userName?String(user.userName):null,message:user.message?String(user.message).slice(0,500):null,hint:user.hint?String(user.hint).slice(0,500):null};}

export function runCli(binary,args,{timeoutMs=45000,maxOutput=4_000_000,input=null,action="操作"}={}){return new Promise((resolve,reject)=>{
  const child=spawn(binary,args,{env:{...process.env,...notifierEnv},stdio:["pipe","pipe","pipe"]});let stdout="",stderr="",finished=false;
  if(input==null)child.stdin.end();else child.stdin.end(String(input));
  const timer=setTimeout(()=>{if(finished)return;finished=true;child.kill("SIGTERM");reject(new Error(`飞书 CLI ${action}超时`));},timeoutMs);timer.unref?.();
  child.stdout.on("data",(chunk)=>{stdout+=chunk;if(stdout.length>maxOutput){finished=true;clearTimeout(timer);child.kill("SIGTERM");reject(new Error("飞书文档内容超过本地读取上限"));}});
  child.stderr.on("data",(chunk)=>{stderr+=chunk;});
  child.once("error",(error)=>{if(finished)return;finished=true;clearTimeout(timer);reject(error);});
  child.once("exit",(code)=>{if(finished)return;finished=true;clearTimeout(timer);const envelope=parseEnvelope(code===0?stdout:stderr);if(code===0&&envelope?.ok!==false)return resolve(envelope);reject(new Error(redact(envelope?.error?.message||envelope?.error?.hint||stderr.trim()||`lark-cli docs exited ${code}`).slice(0,1000)));});
});}

function parseEnvelope(value){const lines=String(value).trim().split(/\r?\n/).filter(Boolean);for(let index=lines.length-1;index>=0;index--){try{return JSON.parse(lines[index]);}catch{}}try{return JSON.parse(String(value));}catch{return null;}}
function extractTitle(markdown){return String(markdown).match(/^\s*#{1,6}\s+(.+)$/m)?.[1]?.trim()||String(markdown).split(/\r?\n/).map((line)=>line.trim()).find(Boolean)?.replace(/^<title>|<\/title>$/g,"").slice(0,120)||"";}
function extractDocumentId(url){return String(url).match(/\/(?:docx|wiki)\/([A-Za-z0-9_-]+)/)?.[1]||"";}
function normalizeGroupMessage(item){const sender=item?.sender||{},senderId=String(sender.id||sender.open_id||item.sender_id||"").trim(),senderName=String(sender.name||item.sender_name||senderId).trim(),senderType=String(sender.type||item.sender_type||"").toLowerCase();return{messageId:String(item.message_id||item.id||"").trim(),msgType:String(item.msg_type||item.message_type||"text"),senderId,senderName,senderType,content:String(item.content||"").trim(),createdAt:normalizeMessageTime(item.create_time||item.created_at),mentions:Array.isArray(item.mentions)?item.mentions.map((mention)=>({id:String(mention?.id||mention?.open_id||"").trim(),name:String(mention?.name||"").trim()})).filter((mention)=>mention.id||mention.name):[]};}
function normalizeMessageTime(value){const text=String(value||"").trim();if(/^\d{13}$/.test(text))return new Date(Number(text)).toISOString();if(/^\d{10}$/.test(text))return new Date(Number(text)*1000).toISOString();if(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(?::\d{2})?$/.test(text)){const parsed=new Date(`${text.replace(" ","T")}${text.length===16?":00":""}+08:00`);if(!Number.isNaN(parsed.getTime()))return parsed.toISOString();}const parsed=new Date(text);return Number.isNaN(parsed.getTime())?new Date().toISOString():parsed.toISOString();}
function formatLocalTime(value){return new Date(value).toLocaleString("zh-CN",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hour12:false});}
function redact(value){return String(value).replace(/(app[_-]?secret|access[_-]?token|refresh[_-]?token|authorization)(\s*[:=]\s*)\S+/gi,"$1$2[REDACTED]");}

import { env } from "cloudflare:workers";
import { ensureWorkspace, getDb } from "./store";

const runtime=()=>env as unknown as Record<string,string|undefined>;
const stamp=()=>new Date().toISOString();
const makeId=(prefix:string)=>`${prefix}_${crypto.randomUUID()}`;

export function feishuStatus(){
  const e=runtime();
  return {configured:Boolean(e.FEISHU_APP_ID&&e.FEISHU_APP_SECRET),verificationConfigured:Boolean(e.FEISHU_VERIFICATION_TOKEN),mode:"event-webhook",requiredScopes:["im:message:readonly","wiki:wiki:readonly","docx:document:readonly"],event:"im.message.receive_v1"};
}

async function tenantToken(){
  const e=runtime();
  if(!e.FEISHU_APP_ID||!e.FEISHU_APP_SECRET) throw new Error("飞书连接尚未配置：缺少 FEISHU_APP_ID / FEISHU_APP_SECRET");
  const r=await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({app_id:e.FEISHU_APP_ID,app_secret:e.FEISHU_APP_SECRET})});
  const j=await r.json() as any;
  if(!r.ok||j.code) throw new Error(j.msg||"无法获取飞书 tenant_access_token");
  return String(j.tenant_access_token);
}

function parseDocUrl(url:string){
  const match=url.match(/\/(wiki|docx)\/([A-Za-z0-9_-]+)/);
  if(!match) throw new Error("仅支持飞书 Wiki / Docx 链接");
  return {type:match[1],token:match[2]};
}

async function api(path:string, token:string){
  const r=await fetch(`https://open.feishu.cn${path}`,{headers:{authorization:`Bearer ${token}`}});
  const j=await r.json() as any;
  if(!r.ok||j.code) throw new Error(j.msg||`飞书接口返回 ${r.status}`);
  return j.data;
}

export async function readFeishuDocument(url:string){
  const parsed=parseDocUrl(url); const access=await tenantToken();
  let documentId=parsed.token; let title="飞书文档"; let objectType="docx";
  if(parsed.type==="wiki"){
    const data=await api(`/open-apis/wiki/v2/spaces/get_node?token=${encodeURIComponent(parsed.token)}`,access);
    documentId=String(data?.node?.obj_token||""); objectType=String(data?.node?.obj_type||""); title=String(data?.node?.title||title);
    if(objectType!=="docx"||!documentId) throw new Error(`当前 Wiki 节点类型 ${objectType||"未知"} 暂不支持正文抽取`);
  }
  const [doc,raw]=await Promise.all([api(`/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}`,access),api(`/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/raw_content`,access)]);
  title=String(doc?.document?.title||title); const content=String(raw?.content||"").trim();
  return {title,content,excerpt:content.replace(/\s+/g," ").slice(0,600),documentId,objectType};
}

export async function syncFeishuAsset(input:{url:string;workspaceId?:string|null;projectId?:string|null;createdBy?:string|null;source?:string;messageId?:string}){
  await ensureWorkspace(); const db=getDb(); const synced=await readFeishuDocument(input.url); const time=stamp();
  const workspaceId=input.workspaceId||runtime().FEISHU_DEFAULT_WORKSPACE_ID||"workspace_pulse";
  const metadata={source:input.source||"feishu_bot",sync_status:"synced",excerpt:synced.excerpt,content:synced.content.slice(0,12000),document_id:synced.documentId,message_id:input.messageId||null,synced_at:time};
  const existing=await db.prepare("SELECT id FROM assets WHERE workspace_id=? AND url=? LIMIT 1").bind(workspaceId,input.url).first<{id:string}>();
  const assetId=existing?.id||makeId("ast");
  if(existing) await db.prepare("UPDATE assets SET project_id=COALESCE(?,project_id),title=?,kind=?,created_by=COALESCE(?,created_by),metadata_json=?,updated_at=? WHERE id=?").bind(input.projectId||null,synced.title,"飞书文档",input.createdBy||null,JSON.stringify(metadata),time,assetId).run();
  else await db.prepare("INSERT INTO assets (id,workspace_id,project_id,title,url,kind,created_by,metadata_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)").bind(assetId,workspaceId,input.projectId||null,synced.title,input.url,"飞书文档",input.createdBy||null,JSON.stringify(metadata),time,time).run();
  return {id:assetId,...synced};
}

function linksFromMessage(content:string){
  let text=content; try{text=JSON.parse(content)?.text||content}catch{}
  return [...new Set(String(text).match(/https?:\/\/[^\s<>\]]+/g)||[])].filter(url=>/\/(wiki|docx)\//.test(url));
}

export async function processFeishuEvent(body:any){
  await ensureWorkspace(); const db=getDb(); const eventId=String(body?.header?.event_id||""); const eventType=String(body?.header?.event_type||"");
  if(eventType!=="im.message.receive_v1") return;
  if(eventId){const seen=await db.prepare("SELECT id FROM integration_events WHERE id=?").bind(eventId).first();if(seen)return;await db.prepare("INSERT INTO integration_events (id,provider,event_type,status,created_at,updated_at) VALUES (?,?,?,?,?,?)").bind(eventId,"feishu",eventType,"processing",stamp(),stamp()).run()}
  const message=body?.event?.message; const sender=String(body?.event?.sender?.sender_id?.open_id||""); const urls=linksFromMessage(String(message?.content||""));
  const member=sender?await db.prepare(`SELECT u.id,wm.workspace_id FROM users u JOIN workspace_members wm ON wm.user_id=u.id WHERE u.feishu_open_id=? ORDER BY wm.created_at LIMIT 1`).bind(sender).first<{id:string;workspace_id:string}>():null;
  const workspaceId=member?.workspace_id||runtime().FEISHU_DEFAULT_WORKSPACE_ID||"workspace_pulse";
  try{
    for(const url of urls) await syncFeishuAsset({url,workspaceId,projectId:runtime().FEISHU_DEFAULT_PROJECT_ID||null,createdBy:member?.id||null,source:"feishu_bot",messageId:String(message?.message_id||"")});
    if(eventId) await db.prepare("UPDATE integration_events SET status=?,detail=?,updated_at=? WHERE id=?").bind("done",`同步 ${urls.length} 份文档，发送人 ${sender}`,stamp(),eventId).run();
  }catch(error){if(eventId)await db.prepare("UPDATE integration_events SET status=?,detail=?,updated_at=? WHERE id=?").bind("failed",error instanceof Error?error.message:"同步失败",stamp(),eventId).run();throw error}
}

export function verifyFeishuRequest(body:any){
  const expected=runtime().FEISHU_VERIFICATION_TOKEN;
  const actual=body?.token||body?.header?.token;
  if(expected&&actual!==expected) throw new Error("飞书 verification token 校验失败");
  if(body?.encrypt) throw new Error("当前端点未启用 Encrypt Key，请在飞书后台选择非加密事件推送");
}

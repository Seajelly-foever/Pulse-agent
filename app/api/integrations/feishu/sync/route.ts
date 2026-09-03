import { syncFeishuAsset } from "../../../../../lib/feishu";
import { organizeDocument, workspaceContext } from "../../../../../lib/store";

export async function POST(request:Request){
  const payload=await request.json();
  if(!/^https:\/\/[^\s]+\/(wiki|docx)\//.test(payload.url||"")) return Response.json({error:"请填写有效的飞书 Wiki / Docx 链接"},{status:400});
  try{const {workspace,actor}=await workspaceContext(request);const synced=await syncFeishuAsset({url:payload.url,workspaceId:workspace.id,projectId:payload.projectId||null,createdBy:actor?.id,source:"web_feishu_sync"});const organized=await organizeDocument(request,{assetId:synced.id,title:synced.title,url:payload.url,content:synced.content,excerpt:synced.excerpt});return Response.json({...synced,organized},{status:201})}catch(error){return Response.json({error:error instanceof Error?error.message:"飞书同步失败"},{status:500})}
}

import { localGateway } from "../../../lib/local-gateway";

export async function POST(request:Request){
  const proxied=await localGateway(request,"/v1/intake");if(proxied)return proxied;
  const payload=await request.json().catch(()=>({})); const text=String(payload.text||payload.url||"").trim(),url=text.match(/https?:\/\/[^\s<>()]+/)?.[0]||"";
  if(!url) return Response.json({error:"请在文字中加入一个有效的文档链接"},{status:400});
  try{
    const [{syncFeishuAsset},{createAsset,organizeDocument,recordInteraction,workspaceContext}]=await Promise.all([import("../../../lib/feishu"),import("../../../lib/store")]);
    const {workspace,actor}=await workspaceContext(request); let document:{id:string;title:string;content?:string;excerpt?:string}; let extracted=false; let note="";
    if(/\/(wiki|docx)\//.test(url)){
      try{const synced=await syncFeishuAsset({url,workspaceId:workspace.id,createdBy:actor?.id,source:"web_intake"});document=synced;extracted=true;}
      catch(error){note=error instanceof Error?error.message:"正文暂未读取";const title=inferTitle(url);const asset=await createAsset(request,{title,url,kind:"待同步文档",note});document={id:asset.id,title,excerpt:"文档链接已保存，连接飞书后将自动读取正文"};}
    }else{const title=inferTitle(url);const asset=await createAsset(request,{title,url,kind:"外部文档",note:"链接已保存，等待 Agent 连接对应文档能力"});document={id:asset.id,title,excerpt:"链接已保存，等待 Agent 连接对应文档能力"};}
    const instruction=text.replace(url,"").trim(),result=await organizeDocument(request,{assetId:document.id,title:document.title,url,content:[document.content,instruction].filter(Boolean).join("\n\n"),excerpt:document.excerpt}),output=result.answer||result.summary||"文档已整理";
    const interaction=await recordInteraction(request,{source:"web-document",inputText:text,output,projectId:result.projectId});
    return Response.json({...result,assetId:document.id,extracted,note,interactionId:interaction.id},{status:201});
  }catch(error){return Response.json({error:error instanceof Error?error.message:"文档整理失败"},{status:500});}
}

function inferTitle(value:string){const parsed=new URL(value);const tail=decodeURIComponent(parsed.pathname.split("/").filter(Boolean).pop()||"");return tail&&tail.length>4?tail:`${parsed.hostname.replace(/^www\./,"")} 文档`;}

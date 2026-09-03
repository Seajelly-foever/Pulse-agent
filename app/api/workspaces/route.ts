import { createWorkspace, inviteWorkspaceMember } from "../../../lib/store";

export async function POST(request:Request){
  const payload=await request.json().catch(()=>({}));
  try{
    if(payload.action==="create"){
      const name=String(payload.name||"").trim(); if(!name) return Response.json({error:"请输入空间名称"},{status:400});
      return Response.json(await createWorkspace(request,name),{status:201});
    }
    if(payload.action==="invite"){
      const email=String(payload.email||"").trim(); if(!/^\S+@\S+\.\S+$/.test(email)) return Response.json({error:"请输入有效邮箱"},{status:400});
      return Response.json(await inviteWorkspaceMember(request,email),{status:201});
    }
    return Response.json({error:"不支持的操作"},{status:400});
  }catch(error){return Response.json({error:error instanceof Error?error.message:"空间操作失败"},{status:500});}
}

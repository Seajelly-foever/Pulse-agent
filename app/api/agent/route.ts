import { localGateway, localGatewayEnabled } from "../../../lib/local-gateway";

export async function GET(){if(localGatewayEnabled())return Response.json({engine:"local-gateway",connected:true,persistentSessions:true});const {projectAgentStatus}=await import("../../../lib/agent");return Response.json(projectAgentStatus())}

export async function POST(request:Request){
  const proxied=await localGateway(request,"/v1/agent");if(proxied)return proxied;
  const payload=await request.json().catch(()=>({})); const prompt=String(payload.prompt||"").trim();
  if(!prompt) return Response.json({error:"请输入需要 Agent 处理的问题"},{status:400});
  if(prompt.length>4000) return Response.json({error:"单次问题不能超过 4000 字"},{status:400});
  try{const [{runProjectAgent},{recordInteraction}]=await Promise.all([import("../../../lib/agent"),import("../../../lib/store")]),result=await runProjectAgent(request,prompt,payload.sessionId),output=String(result.answer||result.summary||"");const interaction=await recordInteraction(request,{source:"web-prompt",inputText:prompt,output,projectId:result.projectId||null});return Response.json({...result,interactionId:interaction.id})}catch(error){return Response.json({error:error instanceof Error?error.message:"Agent 运行失败"},{status:500})}
}

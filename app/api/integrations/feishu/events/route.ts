import { waitUntil } from "cloudflare:workers";
import { processFeishuEvent, verifyFeishuRequest } from "../../../../../lib/feishu";

export async function POST(request:Request){
  try{
    const body=await request.json(); verifyFeishuRequest(body);
    if(body.type==="url_verification") return Response.json({challenge:body.challenge});
    waitUntil(processFeishuEvent(body));
    return Response.json({ok:true});
  }catch(error){return Response.json({error:error instanceof Error?error.message:"事件处理失败"},{status:400})}
}

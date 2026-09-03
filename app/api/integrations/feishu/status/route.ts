import { feishuStatus } from "../../../../../lib/feishu";

export async function GET(request:Request){
  const origin=new URL(request.url).origin;
  return Response.json({...feishuStatus(),webhookUrl:`${origin}/api/integrations/feishu/events`});
}

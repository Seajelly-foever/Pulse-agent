import { localGateway } from "../../../lib/local-gateway";

export async function GET(request:Request){const proxied=await localGateway(request,"/v1/admin");return proxied||Response.json({error:"本地 Gateway 未连接"},{status:503})}
export async function POST(request:Request){const proxied=await localGateway(request,"/v1/admin");return proxied||Response.json({error:"本地 Gateway 未连接"},{status:503})}

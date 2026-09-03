import { localGateway } from "../../../lib/local-gateway";

// `lib/store` imports `cloudflare:workers`, which Node's ESM loader rejects in the
// Linux production build. Import it lazily so the gateway proxy path stays loadable.
export async function POST(request:Request){
  const proxied=await localGateway(request,"/v1/subrequirements");if(proxied)return proxied;
  const payload=await request.json().catch(()=>({}));
  try{const {createSubRequirement}=await import("../../../lib/store");return Response.json(await createSubRequirement(request,payload),{status:201})}catch(error){return Response.json({error:error instanceof Error?error.message:"业务需求创建失败"},{status:400})}
}

export async function DELETE(request:Request){
  const proxied=await localGateway(request,"/v1/subrequirements");if(proxied)return proxied;
  const payload=await request.json().catch(()=>({}));
  try{const {deleteSubRequirement}=await import("../../../lib/store");return Response.json(await deleteSubRequirement(request,String(payload.id||"")))}catch(error){return Response.json({error:error instanceof Error?error.message:"业务需求删除失败"},{status:400})}
}

import { localGateway } from "../../../lib/local-gateway";

// `lib/store` imports `cloudflare:workers`, which Node's ESM loader rejects in the
// Linux production build. Import it lazily so the gateway proxy path stays loadable.
export async function POST(request: Request) {
  const proxied=await localGateway(request,"/v1/projects");if(proxied)return proxied;
  const payload = await request.json();
  if (!payload.name?.trim()) return Response.json({ error: "项目名称不能为空" }, { status: 400 });
  try { const {createProject}=await import("../../../lib/store");return Response.json(await createProject(request, payload), { status: 201 }); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Unable to create project" }, { status: 500 }); }
}

export async function DELETE(request:Request){
  const proxied=await localGateway(request,"/v1/projects");if(proxied)return proxied;
  const payload=await request.json().catch(()=>({}));
  try{const {deleteProject}=await import("../../../lib/store");return Response.json(await deleteProject(request,String(payload.id||"")))}catch(error){return Response.json({error:error instanceof Error?error.message:"项目需求删除失败"},{status:400})}
}

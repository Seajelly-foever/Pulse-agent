import { localGateway } from "../../../lib/local-gateway";

// `lib/store` imports `cloudflare:workers`, which Node's ESM loader rejects in the
// Linux production build. Import it lazily so the gateway proxy path stays loadable.
export async function POST(request:Request){
  const proxied=await localGateway(request,"/v1/tasks");if(proxied)return proxied;
  const payload=await request.json().catch(()=>({}));
  try{const {createTodo}=await import("../../../lib/store");return Response.json(await createTodo(request,payload),{status:201})}catch(error){return Response.json({error:error instanceof Error?error.message:"Todo 创建失败"},{status:400})}
}

export async function PATCH(request:Request){
  const proxied=await localGateway(request,"/v1/tasks");if(proxied)return proxied;
  const payload=await request.json().catch(()=>({}));
  try{const {updateTodo}=await import("../../../lib/store");return Response.json(await updateTodo(request,payload))}catch(error){return Response.json({error:error instanceof Error?error.message:"Todo 更新失败"},{status:400})}
}

export async function DELETE(request:Request){
  const proxied=await localGateway(request,"/v1/tasks");if(proxied)return proxied;
  const payload=await request.json().catch(()=>({}));
  try{const {deleteTodo}=await import("../../../lib/store");return Response.json(await deleteTodo(request,String(payload.id||"")))}catch(error){return Response.json({error:error instanceof Error?error.message:"Todo 删除失败"},{status:400})}
}

import { localGateway } from "../../../lib/local-gateway";

export async function GET(request:Request) {
  const proxied=await localGateway(request,"/v1/workspace");if(proxied)return proxied;
  try { const {readWorkspace}=await import("../../../lib/store");return Response.json(await readWorkspace(request)); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Unable to load workspace" }, { status: 500 }); }
}

import { localGateway } from "../../../lib/local-gateway";

export async function POST(request: Request) {
  const proxied=await localGateway(request,"/v1/reports");if(proxied)return proxied;
  const { type = "双日会简报" } = await request.json().catch(() => ({}));
  try { const {generateReport}=await import("../../../lib/store");return Response.json(await generateReport(request, type), { status: 201 }); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Unable to generate report" }, { status: 500 }); }
}

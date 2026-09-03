import { localGateway } from "../../../lib/local-gateway";

export async function GET(request: Request) {
  const query = new URL(request.url).searchParams.get("q") ?? "";
  const proxied=await localGateway(request,`/v1/search?q=${encodeURIComponent(query)}`);if(proxied)return proxied;
  try {
    const {searchWorkspace}=await import("../../../lib/store");
    const results = await searchWorkspace(query, request);
    return Response.json({ query, count: results.length, results });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Unable to search" }, { status: 500 });
  }
}

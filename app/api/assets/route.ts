import { createAsset } from "../../../lib/store";

export async function POST(request: Request) {
  const payload = await request.json();
  if (!payload.title?.trim() || !/^https?:\/\//.test(payload.url || "")) return Response.json({ error: "请填写标题和有效链接" }, { status: 400 });
  try { return Response.json(await createAsset(request, payload), { status: 201 }); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Unable to create asset" }, { status: 500 }); }
}

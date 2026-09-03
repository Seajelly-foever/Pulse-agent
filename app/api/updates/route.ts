import { createUpdate } from "../../../lib/store";

export async function POST(request: Request) {
  const payload = await request.json();
  if (!payload.projectId || !payload.summary?.trim()) return Response.json({ error: "请选择项目并填写有效进展" }, { status: 400 });
  try { return Response.json(await createUpdate(request, payload), { status: 201 }); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Unable to create update" }, { status: 500 }); }
}

import assert from "node:assert/strict";
import test from "node:test";

async function render(path="/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${path}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(new Request(`http://localhost${path}`,{headers:{accept:"text/html"}}),{ASSETS:{fetch:async()=>new Response("Not found",{status:404})}},{waitUntil(){},passThroughOnException(){}});
}

test("server renders the personal agent workspace",async()=>{
  const response=await render("/");assert.equal(response.status,200);assert.match(response.headers.get("content-type")??"",/^text\/html\b/i);const html=await response.text();assert.match(html,/Pulse · 你的个人管理 Agent/);assert.match(html,/Pulse 工作台/);assert.match(html,/今天需要我做什么/);assert.match(html,/生成本周周报/);assert.match(html,/整理今日待办/);assert.match(html,/新建定时任务/);assert.match(html,/项目管理/);assert.match(html,/管理中台/);
});

test("server renders the agent operations console",async()=>{
  const response=await render("/control");assert.equal(response.status,200);const html=await response.text();assert.match(html,/AGENT CONTROL/);assert.match(html,/Pulse Agent/);assert.match(html,/模型与日志/);assert.match(html,/Skill 管理/);assert.match(html,/Memory 管理/);assert.match(html,/工具审计/);assert.match(html,/项目与周报/);
});

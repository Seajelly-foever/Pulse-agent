import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../src/db.mjs";
import { createGateway } from "../src/gateway.mjs";
import { createSessionQueue } from "../src/queue.mjs";
import { createToolRuntime,parseToolCall } from "../src/tool-runtime.mjs";
import { createAgent } from "../src/agent.mjs";
import { normalizeContent,normalizeLarkEvent } from "../src/lark-cli-channel.mjs";
import { config as loadConfig } from "../src/config.mjs";
import { canonicalDocumentLink,createLarkCliDocumentReader,createLarkCliDocumentWriter,createLarkCliGroupHistoryReader,documentLinks } from "../src/documents.mjs";
import { runDueGroupSyncs,runDueScheduledTasks } from "../src/scheduler.mjs";
import { nextScheduledOccurrence,normalizeSchedule } from "../src/schedule.mjs";
import { createGroupHistoryBackfill } from "../src/group-history.mjs";
import { buildAgentResultCard,buildScheduledResultCard } from "../src/lark-card.mjs";
import { bundledSkillDrafts } from "../src/bundled-skill-drafts.mjs";

test("pairing, event dedupe and approved dispatch form one durable flow",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"pulse-test-"));
  try{
    const store=openDatabase(join(dir,"pulse.db"));
    const agent={respond:async()=>({answer:"agent-ok",engine:"test"}),organize:async()=>({answer:"organized",engine:"test"}),report:async()=>({content:"weekly"})};
    const gateway=createGateway({store,agent,config:{ownerOpenIds:[],harnessUrl:""},log:{warn(){}}});
    let reply="";
    const input={eventId:"evt-1",messageId:"msg-1",chatId:"chat-1",chatType:"p2p",senderId:"ou-test",senderName:"Test",text:"项目进展",reply:async(value)=>{reply=value;}};
    const pending=await gateway.receive(input);
    assert.equal(pending.pairingRequired,true);assert.match(reply,/配对码/);
    assert.ok(store.approvePairing(pending.code));
    const duplicate=await gateway.receive(input);assert.equal(duplicate.duplicate,true);
    const completed=await gateway.receive({...input,eventId:"evt-2",messageId:"msg-2"});assert.equal(completed.answer,"agent-ok");
    assert.equal(store.stats().events,2);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test("group chat only enters the agent loop when the bot is mentioned",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"pulse-group-"));
  try{
    const store=openDatabase(join(dir,"pulse.db"));store.seedRuntime({model:"deepseek-v4-flash",channelDriver:"lark-cli"});
    const received=[];const replies=[],reactions=[];
    const agent={respond:async(input)=>{received.push(input.text);return{answer:"group-agent-ok",engine:"test"};}};
    const gateway=createGateway({store,agent,config:{ownerOpenIds:["ou-owner"],harnessUrl:"",groupChatEnabled:true,groupAcknowledgementEnabled:true,groupAcknowledgementText:"正在努力思考中，请稍等",groupAcknowledgementEmoji:"OneSecond",botMentionNames:["Alex"]},log:{warn(){}}});
    const base={messageId:"msg-group-1",chatId:"oc-group",chatType:"group",senderId:"ou-owner",senderName:"Owner",channelDriver:"lark-cli",reply:async(value,options)=>{replies.push({value,options});},react:async(value)=>{reactions.push(value);}};
    const ignored=await gateway.receive({...base,eventId:"evt-group-1",text:"你是谁"});
    assert.equal(ignored.ignored,true);assert.equal(ignored.reason,"bot_not_mentioned");assert.equal(store.stats().events,0);assert.deepEqual(received,[]);
    const completed=await gateway.receive({...base,eventId:"evt-group-2",messageId:"msg-group-2",text:"@Alex 你是谁",raw:{mentions:[{id:"ou-alex-bot",name:"Alex"}]}});
    assert.equal(completed.answer,"group-agent-ok");assert.deepEqual(received,["你是谁"]);assert.deepEqual(replies,[{value:"正在努力思考中，请稍等",options:{phase:"ack",format:"text"}},{value:"group-agent-ok",options:{phase:"final",result:{answer:"group-agent-ok",engine:"test"}}}]);assert.deepEqual(reactions,["OneSecond"]);assert.equal(store.stats().events,1);
    const session=store.db.prepare("SELECT peer_id,external_chat_id FROM sessions LIMIT 1").get();assert.equal(session.peer_id,"group:oc-group");assert.equal(session.external_chat_id,"oc-group");
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test("group mention survives a bot rename by matching the stable open_id",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"pulse-group-rename-"));
  try{
    const store=openDatabase(join(dir,"pulse.db"));store.seedRuntime({model:"deepseek-v4-flash",channelDriver:"lark-cli"});const received=[];
    const gateway=createGateway({store,agent:{respond:async({text})=>{received.push(text);return{answer:"renamed-bot-ok",engine:"test"};}},config:{ownerOpenIds:["ou-owner"],harnessUrl:"",groupChatEnabled:true,groupAcknowledgementEnabled:false,botMentionNames:["旧名称"],botMentionOpenIds:["ou-bot-stable"]},log:{warn(){}}});
    const result=await gateway.receive({eventId:"evt-renamed",messageId:"msg-renamed",chatId:"oc-group",chatType:"group",senderId:"ou-owner",senderName:"Owner",channelDriver:"lark-cli",text:"@Alex 帮我总结",raw:{mentions:[{id:"ou-bot-stable",name:"Alex"}]},reply:async()=>{}});
    assert.equal(result.answer,"renamed-bot-ok");assert.deepEqual(received,["帮我总结"]);const message=store.db.prepare("SELECT metadata_json FROM messages WHERE role='user' LIMIT 1").get();assert.equal(JSON.parse(message.metadata_json).mentioned,true);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test("non-mentioned group messages are captured silently for later summaries",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"pulse-group-capture-"));
  try{
    const store=openDatabase(join(dir,"pulse.db"));store.seedRuntime({model:"deepseek-v4-flash",channelDriver:"lark-cli"});let replies=0;
    const gateway=createGateway({store,agent:{respond:async()=>{throw new Error("must not run")}},config:{ownerOpenIds:[],harnessUrl:"",groupChatEnabled:true,groupChatAutoCapture:true,groupChatAllowMembers:true,botMentionNames:["Pulse"]},log:{warn(){}}});
    const result=await gateway.receive({eventId:"evt-background",messageId:"msg-background",chatId:"oc-background",chatType:"group",senderId:"ou-member",senderName:"Member",channelDriver:"lark-cli",text:"支付项目今天已经完成灰度",reply:async()=>{replies++;}});
    assert.equal(result.captured,true);assert.equal(result.reply,false);assert.equal(replies,0);assert.equal(store.stats().events,1);assert.equal(store.groupSyncOverview()[0].pending_messages,1);assert.equal(store.groupSyncEvidence("oc-background").messages[0].content,"支付项目今天已经完成灰度");
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test("unpaired group members are redirected to private pairing without exposing a code",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"pulse-group-pairing-"));
  try{
    const store=openDatabase(join(dir,"pulse.db"));store.seedRuntime({model:"deepseek-v4-flash",channelDriver:"lark-cli"});let reply="";
    const gateway=createGateway({store,agent:{respond:async()=>{throw new Error("must not run")}},config:{ownerOpenIds:[],harnessUrl:"",groupChatEnabled:true,groupChatAllowMembers:false,botMentionNames:["Pulse"]},log:{warn(){}}});
    const result=await gateway.receive({eventId:"evt-group-pair",messageId:"msg-group-pair",chatId:"oc-group",chatType:"group",senderId:"ou-new",senderName:"New User",channelDriver:"lark-cli",text:"@Pulse 帮我总结",reply:async(value)=>{reply=value;}});
    assert.equal(result.pairingRequired,true);assert.equal(result.code,null);assert.match(reply,/私聊 Pulse Bot/);assert.doesNotMatch(reply,/配对码|\d{6}/);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test("unpaired members can use the agent directly in an enabled group",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"pulse-group-member-"));
  try{
    const store=openDatabase(join(dir,"pulse.db"));store.seedRuntime({model:"deepseek-v4-flash",channelDriver:"lark-cli"});let reply="",seenIdentity=null;
    const gateway=createGateway({store,agent:{respond:async({identity,text})=>{seenIdentity=identity;return{answer:`已处理：${text}`,engine:"test"};}},config:{ownerOpenIds:[],harnessUrl:"",groupChatEnabled:true,groupChatAllowMembers:true,botMentionNames:["Pulse"]},log:{warn(){}}});
    const result=await gateway.receive({eventId:"evt-group-member",messageId:"msg-group-member",chatId:"oc-shared",chatType:"group",senderId:"ou-member",senderName:"Member",channelDriver:"lark-cli",text:"@Pulse 帮我总结",reply:async(value)=>{reply=value;}});
    assert.equal(result.answer,"已处理：帮我总结");assert.equal(seenIdentity.status,"group_member");assert.equal(reply,"已处理：帮我总结");assert.equal(store.stats().pendingPairings,1);
    const message=store.db.prepare("SELECT metadata_json FROM messages WHERE role='assistant' LIMIT 1").get();assert.equal(JSON.parse(message.metadata_json).access,"group_member");
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test("same-session queue stays ordered",async()=>{
  const enqueue=createSessionQueue({timeoutMs:1000});const order=[];
  await Promise.all([enqueue("same",async()=>{await new Promise((r)=>setTimeout(r,20));order.push(1);}),enqueue("same",async()=>{order.push(2);})]);
  assert.deepEqual(order,[1,2]);
});

test("project facts persist and become searchable",()=>{
  const dir=mkdtempSync(join(tmpdir(),"pulse-store-"));
  try{const store=openDatabase(join(dir,"pulse.db"));const project=store.upsertProject({name:"Alpha 搜索项目",summary:"已完成灰度实验",next:"回收指标"});store.addUpdate({projectId:project.id,summary:"灰度扩大到一半流量"});assert.equal(store.workspace().projects.length,1);assert.equal(store.search("灰度")[0].id,project.id);}finally{rmSync(dir,{recursive:true,force:true});}
});

test("document body persists and is linked to a project",()=>{
  const dir=mkdtempSync(join(tmpdir(),"pulse-asset-"));
  try{const store=openDatabase(join(dir,"pulse.db"));const project=store.upsertProject({name:"文档同步项目",summary:"准备同步"});const asset=store.upsertAsset({url:"https://example.com/wiki/doc",title:"进展文档",content:"实验已经完成",excerpt:"实验完成",projectId:project.id});const workspace=store.workspace();assert.equal(asset.project_id,project.id);assert.equal(workspace.assets[0].content,"实验已经完成");assert.equal(store.search("实验")[0].id,asset.id);}finally{rmSync(dir,{recursive:true,force:true});}
});

test("model routing, run logs and capability switches persist",()=>{
  const dir=mkdtempSync(join(tmpdir(),"pulse-control-"));
  try{const store=openDatabase(join(dir,"pulse.db"));store.seedRuntime({model:"deepseek-v4-flash"});const model=store.createModel({label:"Pro",modelId:"deepseek-v4-pro"});assert.equal(store.activateModel(model.id).model_id,"deepseek-v4-pro");const run=store.startRun({sessionId:"s1",source:"test",input:"总结项目",context:{documents:2},model:store.activeModel()});store.finishRun(run,"completed",{output:"已完成",trace:[{event:"done"}]});const capability=store.adminOverview({DEEPSEEK_API_KEY:"configured"}).capabilities.find((item)=>item.name==="weekly-report");store.toggleCapability(capability.id,false);const overview=store.adminOverview({DEEPSEEK_API_KEY:"configured"});assert.equal(overview.activeModel.model_id,"deepseek-v4-pro");assert.equal(overview.runs[0].output_text,"已完成");assert.equal(overview.models[0].credential_configured,true);assert.equal(store.capabilityEnabled("weekly-report"),false);}finally{rmSync(dir,{recursive:true,force:true});}
});

test("model selects weekly-report skill and the skill generates a persisted report",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"pulse-report-"));
  try{
    const store=openDatabase(join(dir,"pulse.db"));store.seedRuntime({model:"deepseek-v4-flash",channelDriver:"lark-cli"});
    const project=store.upsertProject({name:"Agent 架构升级",summary:"飞书消息链路已经打通",next:"完成模型化周报",ownerName:"Austin"});
    store.addUpdate({projectId:project.id,summary:"完成 Skill Router 设计"});
    store.replaceTodos(project.id,[{content:"验收周报生成",owner:"Austin"}],"msg-report");
    store.upsertAsset({url:"https://example.com/wiki/report",title:"项目进展",content:"本周完成飞书通信与模型接入",excerpt:"本周完成飞书通信与模型接入",projectId:project.id});
    const session=store.ensureSession("owner","chat"),toolRuntime=createToolRuntime({store}),calls=[];
    const fetchImpl=async(_url,options)=>{const body=JSON.parse(options.body);calls.push(body);const role=body.context.runtimePolicy?.role;let answer;if(body.prompt.includes("Skill Router"))answer='<skill_plan>{"skills":[{"name":"weekly-report","input":{"type":"本周项目周报","periodDays":7}}],"reason":"用户要求生成周报"}</skill_plan>';else if(role==="progress-analyst")answer="已完成飞书通信和 Skill Router";else if(role==="risk-analyst")answer="暂无明确阻塞";else if(role==="todo-analyst")answer="验收周报生成 @Austin";else if(role==="report-verifier")answer='<verification>{"passed":true,"issues":[]}</verification>';else answer="# 本周项目周报\n\n整体判断：飞书通信已经打通。\n\n## 下一步\n- 验收周报生成 @Austin";return new Response(JSON.stringify({answer,trace:[{event:"completed"}]}),{status:200,headers:{"content-type":"application/json"}});};
    const agent=createAgent({store,readDocument:async()=>null,toolRuntime,config:{harnessUrl:"http://harness",harnessSecret:""},fetchImpl});
    const result=await agent.respond({text:"请根据本周项目进展生成一份可以发给领导的周报",session,messageId:"msg-report"});
    assert.equal(result.skill,"weekly-report");assert.deepEqual(result.selectedSkills,["weekly-report"]);assert.equal(result.engine,"deepseek-harness-delegation");assert.equal(result.verified,true);assert.match(result.content,/验收周报生成/);assert.equal(store.workspace().reports.length,1);assert.ok(result.delegationId);
    assert.equal(new Set(calls.map((call)=>call.session_id)).size,calls.length);assert.ok(calls.every((call)=>call.session_id.includes(":run:run_")));
    assert.deepEqual(calls.map((call)=>call.context.runtimePolicy?.role).filter(Boolean).sort(),["progress-analyst","report-verifier","report-writer","risk-analyst","skill-router","todo-analyst"].sort());
    const overview=store.adminOverview({});assert.equal(overview.delegations[0].status,"completed");assert.equal(overview.delegations[0].tasks.length,5);assert.ok(overview.delegations[0].tasks.every((task)=>task.status==="completed"));assert.ok(overview.runs.some((run)=>run.source==="delegation:report-verifier"));
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test("general questions stay in the root agent loop instead of returning project statistics",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"pulse-general-"));
  try{const store=openDatabase(join(dir,"pulse.db"));store.seedRuntime({model:"deepseek-v4-flash",channelDriver:"lark-cli"});store.upsertProject({name:"不相关项目",summary:"不应出现在通用回答"});const session=store.ensureSession("owner","chat"),toolRuntime=createToolRuntime({store}),fetchImpl=async(_url,options)=>{const body=JSON.parse(options.body),answer=body.prompt.includes("Skill Router")?'<skill_plan>{"skills":[{"name":"general-assistant","input":{}}],"reason":"通用知识问答"}</skill_plan>':"DeepSeek Harness 是承载模型会话与 Agent 执行循环的推理运行时。";return new Response(JSON.stringify({answer,trace:[]}),{status:200,headers:{"content-type":"application/json"}})},agent=createAgent({store,readDocument:async()=>null,toolRuntime,config:{harnessUrl:"http://harness",harnessSecret:""},fetchImpl}),result=await agent.respond({text:"简单告诉我什么是 DeepSeek Harness",session,messageId:"msg-general"});assert.deepEqual(result.selectedSkills,["general-assistant"]);assert.equal(result.engine,"deepseek-harness-agent-loop");assert.match(result.answer,/推理运行时/);assert.doesNotMatch(result.answer,/不相关项目|当前共/);assert.ok(store.adminOverview({}).runs.some((run)=>run.source==="root-agent-loop"));}finally{rmSync(dir,{recursive:true,force:true});}
});

test("skill studio keeps drafts isolated until evaluation and approval",()=>{
  const dir=mkdtempSync(join(tmpdir(),"pulse-skills-"));
  try{const store=openDatabase(join(dir,"pulse.db"));store.seedRuntime({model:"deepseek-v4-flash"});const skill=store.adminOverview({}).skills.find((item)=>item.name==="workspace-search"),originalId=skill.versions.find((item)=>item.status==="published").id;const production=store.skillInstruction("workspace-search");const draft=store.saveSkillDraft({skillId:skill.id,summary:"增加验证规则",content:"# 工作区检索\n\n## 目标\n检索项目事实并给出有证据的回答。\n\n## 规则\n优先使用最新且相关的本地证据，明确区分事实和推断。\n\n## 验证\n输出前检查每个结论是否能回溯到项目或文档。"});assert.equal(store.skillInstruction("workspace-search"),production);const candidate=store.evaluateSkillVersion(draft.id);assert.equal(candidate.status,"candidate");assert.ok(candidate.evaluation.score>=70);store.publishSkillVersion(candidate.id);assert.match(store.skillInstruction("workspace-search"),/输出前检查/);assert.equal(store.skillDetail(skill.id).versions.find((item)=>item.id===candidate.id).status,"published");store.rollbackSkillVersion(originalId);assert.equal(store.skillInstruction("workspace-search"),production);}finally{rmSync(dir,{recursive:true,force:true});}
});

test("code-managed skills enter the draft inbox idempotently and publish in one action",()=>{
  const dir=mkdtempSync(join(tmpdir(),"pulse-bundled-skills-"));
  try{
    const store=openDatabase(join(dir,"pulse.db"));store.seedRuntime({model:"deepseek-v4-flash"});
    const drafts=bundledSkillDrafts(),first=drafts.map(draft=>store.importSkillDraft(draft)),second=drafts.map(draft=>store.importSkillDraft(draft));
    assert.equal(first.filter(result=>result.imported).length,3);assert.equal(second.filter(result=>result.imported).length,0);
    const taskSkill=store.adminOverview({}).skills.find(skill=>skill.name==="project-task-extractor"),draft=taskSkill.versions.find(version=>version.status==="draft");
    assert.equal(taskSkill.enabled,0);assert.equal(draft.created_by,"code-sync");assert.match(draft.content,/Atomic Todo/);
    const published=store.publishSkillDraft(draft.id);assert.equal(published.enabled,1);assert.equal(published.versions.find(version=>version.id===draft.id).status,"published");assert.match(store.skillInstruction("project-task-extractor"),/Atomic Todo/);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test("manually created skills start as disabled drafts and require approval",()=>{
  const dir=mkdtempSync(join(tmpdir(),"pulse-create-skill-"));
  try{
    const store=openDatabase(join(dir,"pulse.db"));store.seedRuntime({model:"deepseek-v4-flash"});
    const skill=store.createSkill({name:"meeting-summary",description:"把会议内容整理成决策、风险和行动项",tagName:"会议协作",tagTone:"purple",content:"## 目标\n\n把会议材料转换为可执行摘要。\n\n## 规则\n\n只使用输入事实，区分决策、风险和待办，并为待办保留负责人。\n\n## 验证\n\n检查每条结论均可回溯到原始材料，未知负责人标记为待确认。"});
    assert.equal(skill.name,"meeting-summary");assert.equal(skill.enabled,0);assert.deepEqual(skill.config.tag,{name:"会议协作",tone:"purple"});assert.equal(skill.versions.length,1);assert.equal(skill.versions[0].status,"draft");assert.match(skill.versions[0].content,/name: meeting-summary/);assert.equal(store.skillInstruction("meeting-summary"),"");
    assert.ok(store.skillTagOverview().some(tag=>tag.name==="会议协作"&&tag.tone==="purple"));
    const customTag=store.createSkillTag("客户研究","orange");assert.equal(customTag.name,"客户研究");assert.throws(()=>store.createSkillTag("客户研究","blue"),/同名用途标签/);
    const retagged=store.updateSkillTag(skill.id,"团队沉淀","cyan");assert.deepEqual(retagged.config.tag,{name:"团队沉淀",tone:"cyan"});assert.deepEqual(store.adminOverview({}).skills.find(item=>item.id===skill.id).config.tag,{name:"团队沉淀",tone:"cyan"});
    assert.ok(store.skillTagOverview().some(tag=>tag.name==="团队沉淀"&&tag.tone==="cyan"));
    const candidate=store.evaluateSkillVersion(skill.versions[0].id);assert.equal(candidate.status,"candidate");store.publishSkillVersion(candidate.id);store.toggleCapability(skill.id,true);assert.equal(store.capabilityEnabled("meeting-summary"),true);assert.match(store.skillInstruction("meeting-summary"),/会议材料/);
    assert.throws(()=>store.createSkill({name:"meeting-summary",description:"重复的会议整理能力描述",content:"## 目标\n\n重复创建。\n\n## 规则\n\n这是一段足够长的正文，用来验证同名能力不会被重复写入数据库并破坏版本关系。\n\n## 验证\n\n确认抛出重复名称错误。"}),/同名 Skill/);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test("published custom skills enter dynamic model routing and execute in the root loop",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"pulse-dynamic-skill-"));
  try{
    const store=openDatabase(join(dir,"pulse.db"));store.seedRuntime({model:"deepseek-v4-flash",channelDriver:"lark-cli"});
    const skill=store.createSkill({name:"meeting-summary",description:"用户要求把会议内容整理为决策、风险和行动项时使用",content:"## 目标\n\n把会议内容整理为决策、风险和行动项。\n\n## 规则\n\n只依据输入事实，行动项必须保留负责人，未知信息明确标记待确认。\n\n## 验证\n\n检查每条决策和行动都能回溯到原始会议内容。"}),candidate=store.evaluateSkillVersion(skill.versions[0].id);store.publishSkillVersion(candidate.id);store.toggleCapability(skill.id,true);
    const calls=[],fetchImpl=async(_url,options)=>{const body=JSON.parse(options.body);calls.push(body);const answer=body.prompt.includes("Skill Router")?'<skill_plan>{"skills":[{"name":"meeting-summary","input":{}}],"reason":"用户要求整理会议"}</skill_plan>':"决策：采用动态 Skill 路由。\n行动：完成验收 @Austin。";return new Response(JSON.stringify({answer,trace:[]}),{status:200,headers:{"content-type":"application/json"}});};
    const agent=createAgent({store,readDocument:async()=>null,toolRuntime:createToolRuntime({store}),config:{harnessUrl:"http://harness",harnessSecret:""},fetchImpl}),session=store.ensureSession("owner","chat"),result=await agent.respond({text:"把这段会议内容整理成决策和行动项",session,messageId:"msg-custom"});
    assert.deepEqual(result.selectedSkills,["meeting-summary"]);assert.equal(result.skill,"meeting-summary");assert.match(result.answer,/动态 Skill 路由/);assert.ok(calls[0].context.availableSkills.some((item)=>item.name==="meeting-summary"));assert.match(calls[1].prompt,/当前必须执行的已发布 Skill/);assert.match(calls[1].prompt,/把会议内容整理为决策/);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test("memory candidates stay out of agent retrieval until human publication",()=>{
  const dir=mkdtempSync(join(tmpdir(),"pulse-memory-"));
  try{const store=openDatabase(join(dir,"pulse.db"));const candidate=store.remember({content:"用户偏好结论先行的中文汇报",memoryType:"preference"});assert.equal(store.memorySearch("结论").length,0);assert.equal(store.search("结论").length,0);store.publishMemory(candidate.id);assert.equal(store.memorySearch("结论")[0].id,candidate.id);assert.equal(store.search("结论")[0].id,candidate.id);store.archiveMemory(candidate.id);assert.equal(store.memorySearch("结论").length,0);assert.equal(store.search("结论").length,0);}finally{rmSync(dir,{recursive:true,force:true});}
});

test("tool runtime enforces role permissions and leaves an audit trail",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"pulse-tools-"));
  try{const store=openDatabase(join(dir,"pulse.db"));store.seedRuntime({model:"deepseek-v4-flash"});const runtime=createToolRuntime({store});await runtime.execute({name:"remember_candidate",input:{content:"每周五整理个人复盘",memoryType:"preference"},role:"personal-agent",sessionId:"session-test"});await assert.rejects(()=>runtime.execute({name:"capture_inbox",input:{content:"越权写入"},role:"skill-curator"}),/无权调用/);const overview=store.adminOverview({});assert.equal(overview.toolRuns[0].tool_name,"remember_candidate");assert.equal(overview.toolRuns[0].agent_role,"personal-agent");assert.equal(overview.toolRuns[0].permission,"candidate_write");assert.equal(overview.toolRuns[0].status,"completed");assert.equal(overview.memory.totals.candidates,1);}finally{rmSync(dir,{recursive:true,force:true});}
});

test("DSH DSML tool calls are parsed instead of leaking into chat",()=>{
  const call=parseToolCall(`<｜｜DSML｜｜tool_calls>\n<｜｜DSML｜｜invoke name="search_group_messages">\n<｜｜DSML｜｜parameter name="sender" string="true">安琦</｜｜DSML｜｜parameter>\n<｜｜DSML｜｜parameter name="limit">20</｜｜DSML｜｜parameter>\n</｜｜DSML｜｜invoke>\n</｜｜DSML｜｜tool_calls>`);
  assert.deepEqual(call,{name:"search_group_messages",input:{sender:"安琦",limit:20}});
});

test("group message search is restricted to the current group and resolves mentioned members",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"pulse-group-search-"));
  try{
    const store=openDatabase(join(dir,"pulse.db"));store.seedRuntime({model:"deepseek-v4-flash",channelDriver:"lark-cli"});store.ensureIdentity("ou-target","ou-target",false);
    const current=store.ensureSession("group:oc-current","oc-current"),other=store.ensureSession("group:oc-other","oc-other");
    store.addMessage(current.id,"msg-target","user","视觉搜索主动搜规划需要先明确触发场景",{chat_type:"group",sender_id:"ou-target",sender_name:"ou-target"});
    store.addMessage(other.id,"msg-other","user","另一个群的私密讨论",{chat_type:"group",sender_id:"ou-target",sender_name:"ou-target"});
    store.addMessage(current.id,"msg-request","user","评价一下@安琦 的发言",{chat_type:"group",sender_id:"ou-owner",sender_name:"王新皓",mentions:[{id:"ou-target",name:"安琦"}]});store.observeMentionedIdentities([{id:"ou-target",name:"安琦"}]);
    const readGroupMessages=async({chatId})=>({identity:"user",chatId,hasMore:false,messages:[{messageId:"msg-remote",senderId:"ou-target",senderName:"安琦",senderType:"user",content:"还需要补充目标指标和验证路径",createdAt:"2026-08-28T08:00:00.000Z",mentions:[]}]});
    const result=await createToolRuntime({store,readGroupMessages}).execute({name:"search_group_messages",input:{sender:"安琦"},role:"personal-agent",sessionId:current.id,sourceMessageId:"msg-request"});
    assert.equal(result.scope,"current_group");assert.equal(result.sync.source,"feishu_user_history");assert.equal(result.sync.inserted,1);assert.equal(result.messages.length,2);assert.equal(result.messages[0].sender_name,"安琦");assert.match(JSON.stringify(result.messages),/触发场景|目标指标/);assert.doesNotMatch(JSON.stringify(result),/另一个群/);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test("agent loop executes a DSML group-history call and returns a grounded answer",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"pulse-group-loop-"));
  try{
    const store=openDatabase(join(dir,"pulse.db"));store.seedRuntime({model:"deepseek-v4-flash",channelDriver:"lark-cli"});store.ensureIdentity("ou-target","ou-target",false);const session=store.ensureSession("group:oc-review","oc-review");
    store.addMessage(session.id,"msg-target","user","我建议先定义搜索触发场景，再讨论交互方案",{chat_type:"group",sender_id:"ou-target",sender_name:"ou-target"});store.addMessage(session.id,"msg-review","user","评价一下@安琦 的发言",{chat_type:"group",sender_id:"ou-owner",sender_name:"王新皓",mentions:[{id:"ou-target",name:"安琦"}]});store.observeMentionedIdentities([{id:"ou-target",name:"安琦"}]);
    let rootRounds=0;const fetchImpl=async(_url,options)=>{const body=JSON.parse(options.body);let answer;if(body.prompt.includes("Skill Router"))answer='<skill_plan>{"domain":"general","skills":[{"name":"general-assistant","input":{},"domain":"general"}],"reason":"群聊内容分析"}</skill_plan>';else if(rootRounds++===0)answer='<｜｜DSML｜｜tool_calls>\n<｜｜DSML｜｜invoke name="workspace_search">\n<｜｜DSML｜｜parameter name="query" string="true">安琦 发言</｜｜DSML｜｜parameter>\n</｜｜DSML｜｜invoke>\n</｜｜DSML｜｜tool_calls>';else{assert.match(JSON.stringify(body.context.toolSteps),/先定义搜索触发场景/);answer="安琦的发言先明确问题边界再讨论方案，逻辑是成立的；目前缺少目标指标和验证方式。";}return new Response(JSON.stringify({answer,trace:[]}),{status:200,headers:{"content-type":"application/json"}});};
    const agent=createAgent({store,readDocument:async()=>null,toolRuntime:createToolRuntime({store}),config:{harnessUrl:"http://harness",harnessSecret:"",postTaskDreamingEnabled:false,maxToolSteps:4},fetchImpl}),result=await agent.respond({text:"评价一下@安琦 的发言",session,messageId:"msg-review"});
    assert.match(result.answer,/逻辑是成立的/);assert.equal(result.toolSteps[0].call.name,"search_group_messages");assert.equal(result.toolSteps[0].call.redirectedFrom,"workspace_search");assert.doesNotMatch(result.answer,/DSML|tool_calls/);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test("weekly memory evidence combines messages, updates and documents",()=>{
  const dir=mkdtempSync(join(tmpdir(),"pulse-review-"));
  try{const store=openDatabase(join(dir,"pulse.db"));const session=store.ensureSession("owner","chat");store.addMessage(session.id,"m-1","user","记住我的周报偏好");const project=store.upsertProject({name:"个人 Agent 升级",summary:"完成架构拆分"});store.addUpdate({projectId:project.id,summary:"新增每周记忆机制"});store.upsertAsset({url:"https://example.com/design",title:"设计资料",excerpt:"黑白灰界面"});const evidence=store.weeklyMemoryEvidence(7);assert.equal(evidence.messages.length,1);assert.equal(evidence.updates.length,1);assert.equal(evidence.assets.length,1);}finally{rmSync(dir,{recursive:true,force:true});}
});

test("lark cli event adapter normalizes the official flattened message shape",()=>{
  const event=normalizeLarkEvent({type:"im.message.receive_v1",event_id:"evt-cli",message_id:"om-cli",chat_id:"oc-cli",chat_type:"p2p",sender_id:"ou-cli",sender_type:"user",content:"记住：周五复盘"});assert.equal(event.eventId,"om-cli");assert.equal(event.deliveryEventId,"evt-cli");assert.equal(event.messageId,"om-cli");assert.equal(event.senderId,"ou-cli");assert.equal(event.text,"记住：周五复盘");assert.equal(normalizeLarkEvent({...event,sender_id:undefined}),null);
});

test("lark cli removes Feishu plain-text fences before command routing",()=>{
  assert.equal(normalizeContent("```PLAIN_TEXT\n/status\n\n```"),"/status");
  assert.equal(normalizeContent("普通项目进展"),"普通项目进展");
});

test("document links exclude adjacent mentions, markdown punctuation and instructions",()=>{
  const wiki="https://example.larkoffice.com/wiki/HPuNwQhLbivNZekdoQTcMApNn3c",docx="https://example.larkoffice.com/docx/ARg8dR4yzo7619xTjdwmrrXlyze";
  assert.deepEqual(documentLinks(`@Alex [项目文档](${wiki})读取这个文档并总结`),[wiki]);
  assert.deepEqual(documentLinks(`${docx}@Alex 这个 PRD 可以读取吗`),[docx]);
  assert.equal(canonicalDocumentLink(`${wiki})读取这个文档`),wiki);
});

test("document reader sends only a canonical URL to lark cli",async()=>{
  const expected="https://example.larkoffice.com/wiki/HPuNwQhLbivNZekdoQTcMApNn3c";let received="";
  const read=createLarkCliDocumentReader({larkCliBin:"test-cli",identity:"user",run:async(_binary,args)=>{received=args[args.indexOf("--doc")+1];return{ok:true,data:{document:{document_id:"doc-real",content:"# 文档标题\n\n正文"}}};}});
  const result=await read(`${expected})读取这个文档并生成 Skill`);assert.equal(received,expected);assert.equal(result.url,expected);
});

test("group history reader uses the authorized user identity and normalizes message evidence",async()=>{
  let receivedArgs=[];const reader=createLarkCliGroupHistoryReader({larkCliBin:"test-cli",identity:"user",pageLimit:2,run:async(_binary,args)=>{receivedArgs=args;return{ok:true,identity:"user",data:{total:1,has_more:false,messages:[{message_id:"om-history",msg_type:"text",create_time:"2026-08-29 14:30",sender:{id:"ou-member",name:"安琦",type:"user"},content:"先定义问题，再讨论方案",deleted:false}]}};}}),result=await reader({chatId:"oc_history"});
  assert.ok(receivedArgs.includes("+chat-messages-list"));assert.ok(receivedArgs.includes("--page-all"));assert.ok(receivedArgs.includes("user"));assert.equal(result.messages[0].senderName,"安琦");assert.equal(result.messages[0].createdAt,"2026-08-29T06:30:00.000Z");
});

test("group history reader falls back from user to the in-group bot",async()=>{const identities=[],reader=createLarkCliGroupHistoryReader({larkCliBin:"test-cli",identity:"auto",run:async(_binary,args)=>{const identity=args[args.indexOf("--as")+1];identities.push(identity);if(identity==="user")throw new Error("user is not a member");return{ok:true,identity:"bot",data:{messages:[{message_id:"om-bot-history",create_time:"2026-08-29 14:30",sender:{id:"ou-member",name:"成员",type:"user"},content:"Bot 可见的历史消息",deleted:false}]}};}}),result=await reader({chatId:"oc_history"});assert.deepEqual(identities,["user","bot"]);assert.equal(result.identity,"bot");assert.equal(result.messages.length,1);});

test("group history backfill persists, deduplicates and exposes sync status",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"pulse-history-backfill-"));
  try{const store=openDatabase(join(dir,"pulse.db")),session=store.ensureSession("group:oc-history","oc-history"),reader=async()=>({identity:"user",hasMore:false,messages:[{messageId:"om-old",senderId:"ou-member",senderName:"成员 A",senderType:"user",content:"历史进展：已经完成联调",createdAt:"2026-08-30T08:00:00.000Z"}]}),backfill=createGroupHistoryBackfill({store,readGroupMessages:reader,log:{info(){},warn(){}}});const first=await backfill({chatId:"oc-history",sessionId:session.id}),second=await backfill({chatId:"oc-history",sessionId:session.id});assert.equal(first.inserted,1);assert.equal(second.inserted,0);assert.equal(store.groupMessageSearch(session.id,{query:"完成联调"}).length,1);const sync=store.groupSyncOverview()[0];assert.equal(sync.last_history_sync_count,1);assert.ok(sync.last_history_sync_at);assert.equal(sync.last_history_sync_error,null);}finally{rmSync(dir,{recursive:true,force:true});}
});

test("explicit group-history request prefetches evidence before the Agent loop",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"pulse-history-gateway-"));
  try{const store=openDatabase(join(dir,"pulse.db"));store.seedRuntime({model:"deepseek-v4-flash",channelDriver:"lark-cli"});let prefetched=0;const gateway=createGateway({store,agent:{respond:async()=>({answer:"已结合群聊历史总结",engine:"test"})},backfillGroupHistory:async()=>{prefetched++;return{inserted:2};},config:{ownerOpenIds:["ou-owner"],harnessUrl:"",groupChatEnabled:true,groupChatAllowMembers:true,groupChatAutoCapture:true,groupAcknowledgementEnabled:false,botMentionNames:["Alex"],botMentionOpenIds:[]},log:{warn(){},info(){}}}),result=await gateway.receive({channelDriver:"lark-cli",eventId:"evt-history",messageId:"om-history-request",chatId:"oc-history",chatType:"group",senderId:"ou-owner",senderName:"Owner",text:"@Alex 总结一下之前的群聊历史",raw:{mentions:[{name:"Alex",id:"ou-bot"}]},reply:async()=>{}});assert.equal(prefetched,1);assert.match(result.answer,/群聊历史/);}finally{rmSync(dir,{recursive:true,force:true});}
});

test("lark cli is the default channel and document reader preserves evidence",async()=>{
  const runtime=loadConfig({});assert.equal(runtime.channelDriver,"lark-cli");assert.equal(runtime.larkDocIdentity,"user");assert.equal(runtime.larkGroupHistoryIdentity,"auto");assert.equal(runtime.groupChatAllowMembers,true);assert.equal(runtime.groupChatAutoCapture,true);assert.equal(runtime.groupHistoryPageLimit,10);assert.equal(runtime.groupAcknowledgementEnabled,true);assert.equal(runtime.groupAcknowledgementText,"正在努力思考中，请稍等");assert.equal(runtime.groupAcknowledgementEmoji,"OneSecond");assert.ok(runtime.botMentionNames.includes("Alex"));assert.equal(runtime.groupSyncEnabled,true);assert.equal(runtime.scheduledTasksEnabled,true);
  const calls=[];const read=createLarkCliDocumentReader({larkCliBin:"test-cli",identity:"auto",run:async(binary,args)=>{calls.push([binary,...args]);if(args.includes("user"))throw new Error("user permission denied");return{ok:true,data:{document:{document_id:"doc-cli",revision_id:7,content:"# 项目 Alpha\n\n核心进展：已上线灰度"}}};}});
  const doc=await read("https://example.feishu.cn/wiki/token123");assert.equal(doc.title,"项目 Alpha");assert.equal(doc.documentId,"doc-cli");assert.equal(doc.identity,"bot");assert.match(doc.content,/已上线灰度/);assert.deepEqual(calls[0].slice(0,4),["test-cli","docs","+fetch","--doc"]);assert.ok(calls[0].includes("user"));assert.ok(calls[1].includes("bot"));
});

test("group summary writer creates then appends to a user-owned Feishu document",async()=>{
  const calls=[],writer=createLarkCliDocumentWriter({larkCliBin:"test-cli",identity:"user",run:async(binary,args,options)=>{calls.push({binary,args,options});if(args.includes("+create"))return{ok:true,data:{document:{document_id:"doc-group",url:"https://example.feishu.cn/docx/doc-group"}}};return{ok:true,data:{document:{revision_id:2}}};}});
  const created=await writer.writeGroupSummary({chatId:"oc-project",summary:"### 核心进展\n\n- 已完成灰度",generatedAt:"2026-08-28T08:00:00.000Z"});assert.equal(created.documentId,"doc-group");assert.ok(calls[0].args.includes("user"));assert.match(calls[0].options.input,/群聊进度同步/);
  const updated=await writer.writeGroupSummary({chatId:"oc-project",docUrl:created.url,summary:"### 下一步行动\n\n- 验收数据 @Austin"});assert.equal(updated.url,created.url);assert.ok(calls[1].args.includes("append"));assert.match(calls[1].options.input,/验收数据/);
});

test("group scheduler summarizes pending messages and persists the document link",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"pulse-group-sync-"));
  try{const store=openDatabase(join(dir,"pulse.db"));store.seedRuntime({model:"deepseek-v4-flash",channelDriver:"lark-cli"});const session=store.ensureSession("group:oc-sync","oc-sync");store.addMessage(session.id,"msg-sync","user","项目已完成发布",{chat_type:"group",sender_name:"成员 A"});store.markGroupMessage("oc-sync");const results=await runDueGroupSyncs({store,agent:{summarizeGroup:async({messages})=>({summary:`共 ${messages.length} 条进展`})},docWriter:{writeGroupSummary:async()=>({url:"https://example.feishu.cn/docx/group-sync",documentId:"group-sync"})},backfillGroupHistory:async()=>{store.importGroupMessages(session.id,[{messageId:"msg-history",senderId:"ou-b",senderName:"成员 B",content:"历史消息：完成方案评审",createdAt:"2026-08-28T08:00:00.000Z"}]);return{received:1,inserted:1};},config:{groupSyncIntervalMinutes:30,groupSyncMinMessages:1},force:true,log:{info(){},warn(){},error(){}}});assert.equal(results[0].status,"completed");assert.equal(results[0].messageCount,2);assert.equal(results[0].historySync.inserted,1);const sync=store.groupSyncOverview()[0];assert.equal(sync.output_document_id,"group-sync");assert.equal(sync.pending_messages,0);assert.equal(sync.last_error,null);}finally{rmSync(dir,{recursive:true,force:true});}
});

test("scheduled-task tool isolates group tasks and defaults explicit private delivery to the creator",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"pulse-scheduled-tool-"));
  try{const store=openDatabase(join(dir,"pulse.db"));store.seedRuntime({model:"deepseek-v4-flash",channelDriver:"lark-cli"});const identity=store.ensureIdentity("ou-owner","Owner",true),session=store.ensureSession("group:oc-scheduled","oc-scheduled"),runtime=createToolRuntime({store}),created=await runtime.execute({name:"create_scheduled_task",input:{name:"每日项目进度",prompt:"总结当天项目进度",scheduleType:"daily",time:"21:00",deliveryType:"private",executionSkill:"weekly-report"},role:"scheduler-manager",sessionId:session.id,actorId:identity.id,allowedTools:["create_scheduled_task","list_scheduled_tasks","update_scheduled_task"]});assert.equal(created.delivery_type,"private");assert.equal(created.delivery_id,"ou-owner");assert.equal(created.scope_type,"group");assert.equal(created.skill_name,"weekly-report");assert.match(created.scheduleLabel,/每天 21:00/);const listed=await runtime.execute({name:"list_scheduled_tasks",role:"scheduler-manager",sessionId:session.id,actorId:identity.id,allowedTools:["list_scheduled_tasks"]});assert.equal(listed.tasks.length,1);assert.equal(store.adminOverview({}).scheduledTasks.length,1);}finally{rmSync(dir,{recursive:true,force:true});}
});

test("persistent scheduler runs the Agent and proactively delivers a due private summary",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"pulse-scheduled-run-"));
  try{const store=openDatabase(join(dir,"pulse.db"));store.seedRuntime({model:"deepseek-v4-flash",channelDriver:"lark-cli"});const identity=store.ensureIdentity("ou-owner","Owner",true),session=store.ensureSession("group:oc-digest","oc-digest"),schedule=normalizeSchedule({type:"daily",time:"21:00"}),task=store.createScheduledTask({sessionId:session.id,actorId:identity.id,name:"每日项目总结",prompt:"总结当天项目进度",skillName:"weekly-report",schedule,nextRunAt:"2026-08-31T12:00:00.000Z",deliveryType:"private"}),deliveries=[],order=[];const results=await runDueScheduledTasks({store,backfillGroupHistory:async()=>{order.push("history");return{received:20,inserted:3};},agent:{runScheduledTask:async()=>{order.push("agent");return{answer:"今日已完成云端部署，下一步验证群聊。"};}},sendMessage:async(input)=>{deliveries.push(input);},config:{timezone:"Asia/Shanghai"},nowDate:new Date("2026-08-31T13:00:00.000Z"),log:{info(){},warn(){},error(){}}});assert.equal(results[0].status,"completed");assert.deepEqual(order,["history","agent"]);assert.equal(results[0].historySync.inserted,3);assert.equal(deliveries[0].userId,"ou-owner");assert.match(deliveries[0].content,/每日项目总结/);const saved=store.scheduledTaskById(task.id);assert.equal(saved.status,"active");assert.ok(saved.next_run_at>"2026-08-31T13:00:00.000Z");assert.match(saved.last_output,/云端部署/);}finally{rmSync(dir,{recursive:true,force:true});}
});

test("schedule calculation respects Asia Shanghai local time",()=>{const next=nextScheduledOccurrence({type:"daily",time:"21:00",timezone:"Asia/Shanghai"},new Date("2026-08-31T12:59:30.000Z"));assert.equal(next,"2026-08-31T13:00:00.000Z");assert.equal(nextScheduledOccurrence({type:"weekly",time:"21:00",timezone:"Asia/Shanghai",weekdays:[]},new Date("2026-08-31T12:59:30.000Z")),null);});

test("failed document read is persisted without creating a fake project",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"pulse-failed-ingest-"));
  try{const store=openDatabase(join(dir,"pulse.db"));store.seedRuntime({model:"deepseek-v4-flash",channelDriver:"lark-cli"});const session=store.ensureSession("owner","chat"),toolRuntime=createToolRuntime({store}),agent=createAgent({store,readDocument:async()=>{throw new Error("user and bot permission denied")},toolRuntime,config:{harnessUrl:"http://harness",harnessSecret:""},fetchImpl:async()=>{throw new Error("model must not run")}}),result=await agent.respond({text:"https://example.feishu.cn/wiki/blocked 请总结",session,messageId:"msg-blocked",preferredPlan:{skills:[{name:"document-ingest",input:{}},{name:"project-organizer",input:{}}],reason:"test"}});assert.equal(result.engine,"document-sync-failed");assert.equal(result.syncFailed,true);assert.equal(store.workspace().projects.length,0);assert.equal(store.workspace().assets.length,1);assert.equal(store.workspace().assets[0].sync_status,"failed");}finally{rmSync(dir,{recursive:true,force:true});}
});

test("failed document sync still keeps the source link visible",()=>{
  const dir=mkdtempSync(join(tmpdir(),"pulse-failed-asset-"));
  try{const store=openDatabase(join(dir,"pulse.db"));const asset=store.upsertAsset({url:"https://example.com/wiki/blocked",title:"待授权飞书文档",excerpt:"permission denied",syncStatus:"failed",metadata:{source:"lark_cli_bot"}});assert.equal(asset.sync_status,"failed");assert.equal(store.workspace().assets[0].url,"https://example.com/wiki/blocked");}finally{rmSync(dir,{recursive:true,force:true});}
});

test("project-management routes through a bounded ReAct loop and persists with an audited tool",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"pulse-project-agent-"));
  try{
    const store=openDatabase(join(dir,"pulse.db"));store.seedRuntime({model:"deepseek-v4-flash",channelDriver:"lark-cli"});
    const session=store.ensureSession("owner","chat"),identity=store.ensureIdentity("owner","Owner",true),calls=[];
    const fetchImpl=async(_url,options)=>{const body=JSON.parse(options.body);calls.push(body);let answer;if(body.prompt.includes("Skill Router"))answer='<skill_plan>{"domain":"project","skills":[{"name":"project-management","input":{},"domain":"project"}],"reason":"创建项目并生成待办"}</skill_plan>';else if((body.context.toolSteps||[]).length===0)answer='<tool_call>{"name":"sync_project","input":{"name":"Pulse Agent 升级","summary":"已完成项目能力分层","phase":"验证中","next":"验收结构化日志","ownerName":"Austin","todos":[{"content":"验收结构化日志","owner":"Austin"}]}}</tool_call>';else answer="项目已写入工作台，并创建 1 条 Todo：验收结构化日志 @Austin。";return new Response(JSON.stringify({answer,trace:[]}),{status:200,headers:{"content-type":"application/json"}});};
    const agent=createAgent({store,readDocument:async()=>null,toolRuntime:createToolRuntime({store}),config:{harnessUrl:"http://harness",harnessSecret:"",postTaskDreamingEnabled:false,maxToolSteps:6},fetchImpl}),result=await agent.respond({text:"创建 Pulse Agent 升级项目，当前已完成项目能力分层，下一步由 Austin 验收结构化日志",identity,session,messageId:"msg-project"});
    assert.deepEqual(result.selectedSkills,["project-management"]);assert.equal(result.skill,"project-management");assert.match(result.answer,/已写入工作台/);assert.equal(store.workspace().projects[0].name,"Pulse Agent 升级");assert.equal(store.reportingEvidence(7).todos[0].owner_name,"Austin");
    const overview=store.adminOverview({}),tool=overview.toolRuns.find((item)=>item.tool_name==="sync_project");assert.equal(tool.status,"completed");assert.equal(tool.agent_role,"project-manager");assert.equal(tool.permission,"fact_write");assert.ok(tool.agent_run_id);assert.equal(overview.runs.find((run)=>run.id===tool.agent_run_id).tools[0].id,tool.id);assert.ok(overview.runs.filter((run)=>run.task_id===result.taskId).length>=3);assert.equal(calls.at(-1).context.toolSteps[0].call.name,"sync_project");
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test("document analysis reads and answers without forcing a project write",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"pulse-document-no-project-"));
  try{
    const store=openDatabase(join(dir,"pulse.db"));store.seedRuntime({model:"deepseek-v4-flash",channelDriver:"lark-cli"});const session=store.ensureSession("owner","chat"),fetchImpl=async(_url,options)=>{const body=JSON.parse(options.body),answer=body.prompt.includes("Skill Router")?'<skill_plan>{"domain":"document","skills":[{"name":"document-ingest","input":{},"domain":"document"}],"reason":"只需阅读总结","project_decision":{"belongs_to_project":false,"should_write_board":false,"target_project":null,"action":"none","evidence":["请总结"]}}</skill_plan>':"## 文档摘要\n\n核心结论已提炼，不写入项目看板。";return new Response(JSON.stringify({answer,trace:[]}),{status:200,headers:{"content-type":"application/json"}});},agent=createAgent({store,readDocument:async url=>({url,title:"测试文档",content:"这是需要总结的正文",excerpt:"这是需要总结的正文"}),toolRuntime:createToolRuntime({store}),config:{harnessUrl:"http://harness",harnessSecret:"",postTaskDreamingEnabled:false},fetchImpl}),result=await agent.respond({text:"https://example.feishu.cn/docx/demo 请总结",session,messageId:"msg-doc-summary"});
    assert.deepEqual(result.selectedSkills,["document-ingest"]);assert.match(result.answer,/文档摘要/);assert.equal(result.projectWritten,false);assert.equal(store.workspace().projects.length,0);assert.equal(store.workspace().assets.length,1);assert.equal(store.adminOverview({}).runs.filter(run=>run.task_id===result.taskId).length,2);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test("approved users can turn a referenced document into a reviewable Skill candidate",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"pulse-skill-curator-"));
  try{
    const store=openDatabase(join(dir,"pulse.db"));store.seedRuntime({model:"deepseek-v4-flash",channelDriver:"lark-cli"});
    const session=store.ensureSession("owner","chat"),identity=store.ensureIdentity("owner","Owner",true),calls=[];
    const candidate=`---
name: weekly-report
description: "基于可追溯项目事实生成结论先行的结构化周报"
---

# 周报生成

## 目标
将指定周期内的项目事实整理为可直接发送、可验证的周报。

## 规则
先给核心结论，再写进展、风险、下一步和需要协助的事项；区分事实与计划，不编造负责人、日期或指标；仅提炼可跨项目复用的方法。

## 验证
每条关键结论必须能回溯到项目知识、文档或群聊证据；缺失信息明确标记待确认。`;
    const fetchImpl=async(_url,options)=>{const body=JSON.parse(options.body);calls.push(body);return new Response(JSON.stringify({answer:`已提炼结论先行与证据约束。\n<skill>${candidate}</skill>`,trace:[]}),{status:200,headers:{"content-type":"application/json"}});};
    const agent=createAgent({store,readDocument:async url=>({url,title:"周报参考文档",content:"周报应结论先行，区分进展、风险和下一步，并保留证据来源。",excerpt:"周报应结论先行"}),toolRuntime:createToolRuntime({store}),config:{harnessUrl:"http://harness",harnessSecret:"",postTaskDreamingEnabled:false,maxToolSteps:6},fetchImpl});
    const result=await agent.respond({text:"读取 https://example.feishu.cn/docx/weekly 并优化写周报的 skill",identity,session,messageId:"msg-skill-curator"});
    assert.deepEqual(result.selectedSkills,["skill-curator"]);assert.equal(result.skill,"skill-curator");assert.ok(result.candidateVersionId);assert.match(result.answer,/草稿箱/);assert.equal(calls.length,1);assert.equal(calls[0].context.role,"skill-curator");
    const detail=store.skillDetail("skill_weekly_report"),published=detail.versions.find((version)=>version.status==="published"),candidateVersion=detail.versions.find((version)=>version.id===result.candidateVersionId);assert.equal(published.version,"1.0.0");assert.equal(candidateVersion.status,"candidate");assert.match(candidateVersion.content,/结论先行/);assert.equal(candidateVersion.evidence[0].title,"周报参考文档");
    const audit=store.adminOverview({}).toolRuns.find((run)=>run.tool_name==="propose_skill_revision");assert.equal(audit.status,"completed");assert.equal(audit.agent_role,"skill-curator");assert.equal(audit.permission,"candidate_write");
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test("Skill curation is blocked for unapproved users and never creates a draft",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"pulse-skill-curator-permission-"));
  try{
    const store=openDatabase(join(dir,"pulse.db"));store.seedRuntime({model:"deepseek-v4-flash",channelDriver:"lark-cli"});const session=store.ensureSession("guest","chat"),identity=store.ensureIdentity("guest","Guest",false),agent=createAgent({store,readDocument:async()=>null,toolRuntime:createToolRuntime({store}),config:{harnessUrl:"http://harness",harnessSecret:"",postTaskDreamingEnabled:false},fetchImpl:async()=>{throw new Error("model must not run");}}),before=store.skillDetail("skill_weekly_report").versions.length,result=await agent.respond({text:"优化 weekly-report skill",identity,session,messageId:"msg-unapproved"});
    assert.equal(result.engine,"permission-denied");assert.match(result.answer,/已授权账号/);assert.equal(store.skillDetail("skill_weekly_report").versions.length,before);assert.equal(store.adminOverview({}).toolRuns.filter((run)=>run.tool_name==="propose_skill_revision").length,0);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test("scheduled-task skill routes through ReAct and persists a group-scoped private digest",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"pulse-scheduled-agent-"));
  try{const store=openDatabase(join(dir,"pulse.db"));store.seedRuntime({model:"deepseek-v4-flash",channelDriver:"lark-cli"});const session=store.ensureSession("group:oc-agent-schedule","oc-agent-schedule"),identity=store.ensureIdentity("ou-owner","Owner",true),fetchImpl=async(_url,options)=>{const body=JSON.parse(options.body);let answer;if(body.prompt.includes("Skill Router"))answer='<skill_plan>{"domain":"automation","skills":[{"name":"scheduled-task","input":{},"domain":"automation"}],"reason":"每天私聊推送"}</skill_plan>';else if((body.context.toolSteps||[]).length===0)answer='<tool_call>{"name":"create_scheduled_task","input":{"name":"每日项目进度总结","prompt":"总结当天项目进度、风险和下一步 Todo","scheduleType":"daily","time":"21:00","deliveryType":"private","executionSkill":"weekly-report"}}</tool_call>';else answer="定时任务已创建：每天 21:00 私聊发送项目进度总结。";return new Response(JSON.stringify({answer,trace:[]}),{status:200,headers:{"content-type":"application/json"}});},agent=createAgent({store,readDocument:async()=>null,toolRuntime:createToolRuntime({store}),config:{harnessUrl:"http://harness",harnessSecret:"",postTaskDreamingEnabled:false,maxToolSteps:6},fetchImpl}),result=await agent.respond({text:"每天晚上 9 点私聊我当天的项目进度总结",identity,session,messageId:"msg-schedule"});assert.deepEqual(result.selectedSkills,["scheduled-task"]);assert.equal(result.skill,"scheduled-task");assert.match(result.answer,/已创建/);const task=store.scheduledTaskOverview()[0];assert.equal(task.delivery_type,"private");assert.equal(task.delivery_id,"ou-owner");assert.equal(task.schedule.time,"21:00");const audit=store.adminOverview({}).toolRuns.find((run)=>run.tool_name==="create_scheduled_task");assert.equal(audit.agent_role,"scheduler-manager");assert.equal(audit.permission,"scheduled_write");}finally{rmSync(dir,{recursive:true,force:true});}
});

test("project gate corrects an over-routed personal task and records the real ReAct decision",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"pulse-project-gate-"));
  try{
    const store=openDatabase(join(dir,"pulse.db"));store.seedRuntime({model:"deepseek-v4-flash",channelDriver:"lark-cli"});const session=store.ensureSession("owner","chat"),calls=[];
    const fetchImpl=async(_url,options)=>{const body=JSON.parse(options.body);calls.push(body);const answer=body.prompt.includes("Skill Router")?'<skill_plan>{"domain":"project","skills":[{"name":"project-management","input":{},"domain":"project"}],"reason":"包含负责人和日期","project_decision":{"belongs_to_project":true,"should_write_board":true,"target_project":"健身计划项目","action":"update","evidence":["不存在于用户原文的证据"]}}</skill_plan>':"好的，今天先完成健身，不会写入项目看板。";return new Response(JSON.stringify({answer,trace:[{event:"model_output"}]}),{status:200,headers:{"content-type":"application/json"}});};
    const agent=createAgent({store,readDocument:async()=>null,toolRuntime:createToolRuntime({store}),config:{harnessUrl:"http://harness",harnessSecret:"",postTaskDreamingEnabled:false,maxToolSteps:6},fetchImpl}),result=await agent.respond({text:"今天完成健身，Austin 陪我一起",session,messageId:"msg-personal"});
    assert.deepEqual(result.selectedSkills,["general-assistant"]);assert.equal(result.skillPlan.routeCorrected,true);assert.equal(result.skillPlan.projectDecision.allowedWrite,false);assert.equal(store.workspace().projects.length,0);assert.equal(store.adminOverview({}).toolRuns.filter(item=>item.tool_name==="sync_project").length,0);
    const runs=store.adminOverview({}).runs.filter(run=>run.task_id===result.taskId);assert.equal(runs.length,2);const root=runs.find(run=>run.source==="root-agent-loop");assert.equal(root.context.routingDecision.projectDecision.allowedWrite,false);assert.match(root.context.routingDecision.projectDecision.blockedReason,/证据/);assert.equal(calls.length,2);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test("ordinary turns stay in Session memory and never auto-write long-term memory",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"pulse-dreamer-"));
  try{
    const store=openDatabase(join(dir,"pulse.db"));store.seedRuntime({model:"deepseek-v4-flash",channelDriver:"lark-cli"});const dreamer=store.adminOverview({}).capabilities.find((item)=>item.name==="post-task-dreaming");store.toggleCapability(dreamer.id,true);const session=store.ensureSession("owner","chat");
    const fetchImpl=async(_url,options)=>{const body=JSON.parse(options.body),role=body.context.runtimePolicy?.role;let answer;if(body.prompt.includes("Skill Router"))answer='<skill_plan>{"domain":"general","skills":[{"name":"general-assistant","input":{}}],"reason":"通用写作"}</skill_plan>';else if(role==="memory-dreamer")answer='<learning_delta>{"summary":"发现稳定表达偏好","memories":[{"content":"用户偏好结论先行的中文表达","memoryType":"preference","confidence":0.92,"importance":3}],"profile":[{"category":"communication","key":"response_style","value":"结论先行、简洁专业","confidence":0.9}]}</learning_delta>';else answer="我会用结论先行的方式回答。";return new Response(JSON.stringify({answer,trace:[]}),{status:200,headers:{"content-type":"application/json"}});};
    const agent=createAgent({store,readDocument:async()=>null,toolRuntime:createToolRuntime({store}),config:{harnessUrl:"http://harness",harnessSecret:"",postTaskDreamingEnabled:true,postTaskDreamingMinChars:4,maxToolSteps:6},fetchImpl});await agent.respond({text:"以后请用结论先行的方式回答我的问题",session,messageId:"msg-dream"});await agent.drainLearning();
    const overview=store.adminOverview({});assert.equal(Number(overview.memory.totals.candidates||0),0);assert.equal(Number(overview.profile.totals.candidates||0),0);assert.equal(overview.delegations.length,0);assert.equal(store.memorySearch("结论").length,0);assert.equal(store.profileOverview().published.length,0);assert.equal(store.sessionContext(session.id).messages.length,0);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test("system prompt drafts stay isolated and published versions reach Harness immediately",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"pulse-system-prompt-"));
  try{
    const store=openDatabase(join(dir,"pulse.db"));store.seedRuntime({model:"deepseek-v4-flash",channelDriver:"lark-cli"});const original=store.activeSystemPrompt();assert.match(original.content,/个人生活工作管理助手/);
    const replacement=`# 自定义生产提示词\n\n${"这是经过人工确认的角色、语气、执行边界与输出规范。".repeat(24)}`,draft=store.saveSystemPromptDraft({content:replacement,summary:"测试动态发布"});assert.equal(store.activeSystemPrompt().id,original.id);assert.equal(draft.status,"draft");store.publishSystemPromptVersion(draft.id);assert.equal(store.activeSystemPrompt().id,draft.id);
    let requestBody=null;const fetchImpl=async(_url,options)=>{requestBody=JSON.parse(options.body);return new Response(JSON.stringify({answer:"新的系统提示词已生效",trace:[]}),{status:200,headers:{"content-type":"application/json"}});},agent=createAgent({store,readDocument:async()=>null,toolRuntime:createToolRuntime({store}),config:{harnessUrl:"http://harness",harnessSecret:"",postTaskDreamingEnabled:false,maxToolSteps:6},fetchImpl}),session=store.ensureSession("owner","chat"),result=await agent.respond({text:"你好",session,messageId:"msg-prompt",preferredPlan:{domain:"general",skills:[{name:"general-assistant",input:{}}],reason:"test"}});
    assert.equal(result.answer,"新的系统提示词已生效");assert.ok(requestBody.system_prompt.startsWith(replacement));assert.match(requestBody.system_prompt,/# USER\.md/);assert.match(requestBody.system_prompt,/# MEMORY\.md/);assert.equal(requestBody.context.systemPrompt.id,draft.id);assert.equal(requestBody.context.systemPrompt.version,2);assert.equal(requestBody.context.hermesSession.frozen,true);const run=store.adminOverview({}).runs[0];assert.equal(run.context.systemPrompt.id,draft.id);store.publishSystemPromptVersion(original.id);assert.equal(store.activeSystemPrompt().id,original.id);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test("agent result cards use Feishu Card 2.0 with a compact Botmux-inspired hierarchy",()=>{
  const card=buildAgentResultCard("**核心结论**\n\n已完成发布。",{skill:"project-management",model:"deepseek-v4-flash",toolSteps:[{round:1,call:{name:"sync_project"},output:{ok:true}}]});
  assert.equal(card.schema,"2.0");assert.equal(card.config.width_mode,"default");assert.equal(card.header.template,"green");assert.match(card.header.title.content,/处理完成/);assert.equal(card.body.elements[0].tag,"column_set");assert.equal(card.body.elements[1].tag,"markdown");assert.equal(card.body.elements[2].tag,"collapsible_panel");assert.equal(card.body.elements[2].expanded,false);assert.doesNotMatch(JSON.stringify(card),/cloudflare:/);
  const scheduled=buildScheduledResultCard("今日项目摘要",{name:"每日进度",skill:"weekly-report"});assert.match(scheduled.header.title.content,/每日进度/);assert.equal(scheduled.header.icon.token,"calendar_colorful");
});

test("project synchronization persists requirement, sub-requirement progress and owned todos as a tree",()=>{
  const dir=mkdtempSync(join(tmpdir(),"pulse-project-tree-"));
  try{const store=openDatabase(join(dir,"pulse.db")),result=store.syncProject({requirement:"Agent 个人管理工具",summary:"进入云端验证阶段",subrequirements:[{title:"飞书群聊联动",progressSummary:"卡片回复与历史消息已接通",progressPercent:80,ownerName:"Alex",priority:1,todos:[{content:"完成生产群回归",owner:"Austin",dueDate:"2026-09-01"}]},{title:"Memory 分域",progressSummary:"已按项目和人物建立作用域",progressPercent:60,ownerName:"Austin",todos:[{content:"审核人物记忆候选",owner:"Austin"}]}]});const workspace=store.workspace(),project=workspace.projects[0];assert.equal(result.project.name,"Agent 个人管理工具");assert.equal(project.subrequirements.length,2);assert.equal(project.subrequirements[0].title,"飞书群聊联动");assert.equal(project.subrequirements[0].todos[0].owner_name,"Austin");assert.equal(workspace.scheduledTasks,undefined);assert.equal(store.reportingEvidence(7).todos[0].sub_requirement_title,"飞书群聊联动");}finally{rmSync(dir,{recursive:true,force:true});}
});

test("Task Service keeps different owners atomic and persists completion, soft deletion and interaction history",()=>{
  const dir=mkdtempSync(join(tmpdir(),"pulse-task-service-"));
  try{const store=openDatabase(join(dir,"pulse.db")),result=store.syncProject({requirement:"搜索项目",summary:"本周完成多模态评测",subrequirements:[{title:"多模态评测",progressSummary:"已明确分工",todos:[{content:"完成评测准备",owner:"Austin",dueDate:"2026-09-02",priority:1},{content:"完成评测准备",owner:"Alex",dueDate:"2026-09-02",priority:1}]}]}),todos=result.todos;assert.equal(todos.length,2);assert.deepEqual(todos.map(item=>item.owner_name).sort(),["Alex","Austin"]);store.updateTodo({id:todos[0].id,status:"done"});assert.equal(store.workspace().projects[0].subrequirements[0].todos.find(item=>item.id===todos[0].id).status,"done");store.deleteTodo(todos[1].id);assert.equal(store.workspace().projects[0].subrequirements[0].todos.length,1);const interaction=store.startInteraction({source:"web-document",inputText:"读取 https://example.com/doc 并提炼 Todo"});store.finishInteraction(interaction.id,{output:"## 已整理\n\n- 两条任务已拆分",projectId:result.project.id});const history=store.workspace().activityHistory;assert.equal(history[0].source_urls[0],"https://example.com/doc");assert.match(history[0].output_markdown,/两条任务/);}finally{rmSync(dir,{recursive:true,force:true});}
});

test("Task Service strips structured wrappers and soft deletes an entire project requirement",()=>{
  const dir=mkdtempSync(join(tmpdir(),"pulse-project-cleaning-")),databasePath=join(dir,"pulse.db");
  try{
    let store=openDatabase(databasePath),result=store.syncProject({requirement:"<b>重点项目 list</b>",summary:"<p>推进 &amp; 验证中</p>",subrequirements:[{title:"<div>标准制定</div>",progressSummary:"<blockquote>已调整评估维度</blockquote>",todos:[{content:'```html\n<table><thead><tr><th>事项</th><th>进展 &amp; 后续</th></tr></thead><tbody><tr><td>新标准制定</td><td>完成评审</td></tr></tbody></table>\n```',owner:"<b>Alice</b>"},{content:'<blockquote><p>产品思路：<cite doc-id="doc-1" title="下一步方案对齐" type="doc"></cite></p></blockquote>',owner:"Bob"}]}]});
    let project=store.workspace().projects[0],todos=project.subrequirements[0].todos;
    assert.equal(project.name,"重点项目 list");assert.equal(project.summary,"推进 & 验证中");assert.equal(project.subrequirements[0].title,"标准制定");assert.ok(todos.some(item=>item.owner_name==="Alice"));assert.doesNotMatch(todos.map(item=>item.content).join("\n"),/<\/?(?:table|tr|td|blockquote|cite|b)\b|&amp;|```/i);assert.match(todos.map(item=>item.content).join("\n"),/新标准制定/);assert.match(todos.map(item=>item.content).join("\n"),/下一步方案对齐/);
    const dirtyTodo=todos[0];store.db.prepare("UPDATE todos SET content=? WHERE id=?").run("&lt;b&gt;历史脏数据&lt;/b&gt;",dirtyTodo.id);store.db.close();store=openDatabase(databasePath);assert.equal(store.db.prepare("SELECT content FROM todos WHERE id=?").get(dirtyTodo.id).content,"历史脏数据");
    const deleted=store.deleteProject(result.project.id);assert.equal(deleted.ok,true);assert.equal(store.workspace().projects.length,0);assert.ok(store.db.prepare("SELECT deleted_at FROM projects WHERE id=?").get(result.project.id).deleted_at);assert.ok(store.db.prepare("SELECT deleted_at FROM todos WHERE project_id=?").get(result.project.id).deleted_at);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test("manual board editing creates and deletes requirements and todos without touching Agent writes",()=>{
  const dir=mkdtempSync(join(tmpdir(),"pulse-manual-board-"));
  try{
    const store=openDatabase(join(dir,"pulse.db")),seeded=store.syncProject({requirement:"云端部署",summary:"上线到公司虚拟机",subrequirements:[{title:"环境准备",progressSummary:"待确认依赖",todos:[{content:"确认 Node 版本",owner:"Austin"}]}]});
    const projectId=seeded.project.id;
    const manualSub=store.createSubRequirement({projectId,title:"灰度验证",progressSummary:"等待首批用户",ownerName:"Alex"});
    assert.equal(manualSub.title,"灰度验证");assert.equal(manualSub.owner_name,"Alex");
    assert.throws(()=>store.createSubRequirement({projectId,title:"灰度验证"}),/已存在同名业务需求/);
    assert.throws(()=>store.createSubRequirement({projectId,title:"   "}),/标题不能为空/);
    const manualTodo=store.createTodo({projectId,subRequirementId:manualSub.id,content:"邀请 3 个种子用户",owner:"Alex",dueDate:"2026-09-10",priority:1});
    assert.equal(manualTodo.priority,1);assert.equal(manualTodo.sub_requirement_id,manualSub.id);
    assert.throws(()=>store.createTodo({projectId,content:""}),/内容不能为空/);
    assert.throws(()=>store.createTodo({projectId,subRequirementId:"sub_missing",content:"无效挂载"}),/业务需求不存在/);
    const unscoped=store.createTodo({projectId,content:"补充部署文档"});
    assert.equal(unscoped.sub_requirement_id,null);
    const tree=store.workspace().projects.find(item=>item.id===projectId);
    assert.equal(tree.subrequirements.length,2);assert.equal(tree.unscopedTodos.length,1);
    const removed=store.deleteSubRequirement(manualSub.id);
    assert.equal(removed.ok,true);
    assert.equal(store.workspace().projects.find(item=>item.id===projectId).subrequirements.length,1);
    assert.ok(store.db.prepare("SELECT deleted_at FROM todos WHERE id=?").get(manualTodo.id).deleted_at);
    assert.equal(store.db.prepare("SELECT COUNT(*) count FROM project_subrequirements WHERE id=?").get(manualSub.id).count,0);
    assert.throws(()=>store.deleteSubRequirement(manualSub.id),/业务需求不存在或已删除/);
    assert.equal(store.workspace().projects.find(item=>item.id===projectId).unscopedTodos.length,1);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test("group progress Skill sends atomic owned todos through the shared Task Service",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"pulse-group-task-sync-"));
  try{const store=openDatabase(join(dir,"pulse.db"));store.seedRuntime({model:"deepseek-v4-flash",channelDriver:"lark-cli"});const answer=`### 结论摘要\n本周完成多模态评测分工。\n\n### 下一步行动\n- Austin 完成数据分析\n- Alex 完成模型实验\n<project_delta>{"name":"搜索项目","summary":"本周完成多模态评测分工","phase":"执行中","next":"完成两项评测工作","subrequirements":[{"title":"多模态评测","progressSummary":"分工已确认","todos":[{"content":"完成数据分析","owner":"Austin","priority":1},{"content":"完成模型实验","owner":"Alex","priority":1}]}]}</project_delta>`,fetchImpl=async()=>new Response(JSON.stringify({answer,trace:[]}),{status:200,headers:{"content-type":"application/json"}}),agent=createAgent({store,readDocument:async()=>null,toolRuntime:createToolRuntime({store}),config:{harnessUrl:"http://harness",harnessSecret:"",postTaskDreamingEnabled:false,maxToolSteps:6},fetchImpl}),result=await agent.summarizeGroup({chatId:"oc-search",messages:[{sender_name:"Austin",created_at:"2026-08-31T10:00:00Z",content:"搜索项目本周做多模态评测，我负责数据分析，Alex 负责模型实验"}]});assert.equal(result.taskSync.todoCount,2);const todos=store.workspace().projects[0].subrequirements[0].todos;assert.deepEqual(todos.map(item=>item.owner_name).sort(),["Alex","Austin"]);assert.doesNotMatch(result.summary,/project_delta/);}finally{rmSync(dir,{recursive:true,force:true});}
});

test("group summaries do not turn ordinary actions into fake projects",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"pulse-group-no-project-"));
  try{
    const store=openDatabase(join(dir,"pulse.db"));store.seedRuntime({model:"deepseek-v4-flash",channelDriver:"lark-cli"});const answer=`### 结论摘要\nAustin 明天整理会议材料。\n<project_delta>{"name":"群聊 oc-general","summary":"整理会议材料","subrequirements":[{"title":"临时安排","todos":[{"content":"整理会议材料","owner":"Austin"}]}]}</project_delta>`,fetchImpl=async()=>new Response(JSON.stringify({answer,trace:[]}),{status:200,headers:{"content-type":"application/json"}}),agent=createAgent({store,readDocument:async()=>null,toolRuntime:createToolRuntime({store}),config:{harnessUrl:"http://harness",harnessSecret:"",postTaskDreamingEnabled:false},fetchImpl}),result=await agent.summarizeGroup({chatId:"oc-general",messages:[{sender_name:"Austin",created_at:"2026-08-31T10:00:00Z",content:"我明天整理会议材料"}]});
    assert.equal(result.taskSync,null);assert.equal(result.projectDecision.allowedWrite,false);assert.equal(store.workspace().projects.length,0);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test("Hermes sessions isolate group and private context and keep monthly snapshots frozen",()=>{
  const dir=mkdtempSync(join(tmpdir(),"pulse-hermes-session-"));
  try{const store=openDatabase(join(dir,"pulse.db"));store.seedRuntime({model:"deepseek-v4-flash",channelDriver:"lark-cli"});const group=store.ensureSession("group:oc-a","oc-a"),direct=store.ensureSession("ou-austin","ou-austin");store.addMessage(group.id,"gm-1","user","搜索项目需要完成数据分析");store.addMessage(direct.id,"dm-1","user","这是私人对话内容");const first=store.ensureSnapshot(group.id,store.activeSystemPrompt());const memory=store.remember({content:"用户年度目标是完成 Agent 产品化",memoryType:"goal",status:"candidate"});store.publishMemory(memory.id);const sameMonth=store.ensureSnapshot(group.id,store.activeSystemPrompt()),refreshed=store.ensureSnapshot(group.id,store.activeSystemPrompt(),{force:true});assert.equal(first.memory_md,sameMonth.memory_md);assert.doesNotMatch(sameMonth.memory_md,/Agent 产品化/);assert.match(refreshed.memory_md,/Agent 产品化/);assert.equal(store.sessionContext(group.id).messages.length,1);assert.equal(store.sessionContext(direct.id).messages.length,1);assert.doesNotMatch(JSON.stringify(store.sessionSearch({sessionId:group.id})),/私人对话内容/);assert.match(JSON.stringify(store.sessionSearch({query:"私人对话"})),/私人对话内容/);}finally{rmSync(dir,{recursive:true,force:true});}
});

test("weekly reports recall each project through the audited knowledge tool",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"pulse-report-knowledge-"));
  try{const store=openDatabase(join(dir,"pulse.db"));store.seedRuntime({model:"deepseek-v4-flash",channelDriver:"lark-cli"});const project=store.syncProject({name:"搜索项目",summary:"进入评测阶段",subrequirements:[{title:"多模态评测",progressSummary:"准备完成",todos:[{content:"完成数据分析",owner:"Austin"}]}]}).project;store.upsertAsset({projectId:project.id,url:"https://example.com/project-doc",title:"项目文档",content:"评测计划"});const fetchImpl=async()=>new Response(JSON.stringify({answer:"# 周报\n\n搜索项目进入评测阶段。",trace:[]}),{status:200,headers:{"content-type":"application/json"}}),agent=createAgent({store,readDocument:async()=>null,toolRuntime:createToolRuntime({store}),config:{harnessUrl:"http://harness",harnessSecret:"",postTaskDreamingEnabled:false,maxToolSteps:6},fetchImpl});const report=await agent.report({delegation:false});assert.equal(report.knowledgeProjects,1);const calls=store.adminOverview({}).toolRuns.filter(item=>item.tool_name==="project_knowledge_recall");assert.equal(calls.length,1);assert.equal(calls[0].agent_role,"report-writer");assert.match(JSON.stringify(calls[0].output),/项目文档/);}finally{rmSync(dir,{recursive:true,force:true});}
});

test("legacy project memory migrates to the isolated project knowledge base",()=>{
  const dir=mkdtempSync(join(tmpdir(),"pulse-memory-scopes-"));
  try{const databasePath=join(dir,"pulse.db");let store=openDatabase(databasePath);const project=store.syncProject({name:"Pulse Agent",summary:"长期建设个人管理工具",subrequirements:[{title:"Memory",progressSummary:"建立分域记忆",todos:[]}]}).project;store.db.prepare("INSERT INTO memory_entries(id,workspace_id,memory_type,subject_type,subject_id,content,status,confidence,importance,created_by,metadata_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").run("legacy-project-memory","workspace_local","decision","project",project.id,"项目必须优先保证飞书消息链路稳定","published",.9,3,"legacy","{}",new Date().toISOString(),new Date().toISOString());store.db.close();store=openDatabase(databasePath);const knowledge=store.projectContext(project.id).knowledge;assert.ok(knowledge.some(item=>/飞书消息链路/.test(item.content)));assert.equal(store.db.prepare("SELECT status FROM memory_entries WHERE id='legacy-project-memory'").get().status,"archived");assert.equal(store.memorySearch("飞书消息链路").length,0);}finally{rmSync(dir,{recursive:true,force:true});}
});

test("monthly memory curator only creates user preference fact and goal candidates",async()=>{
  const dir=mkdtempSync(join(tmpdir(),"pulse-weekly-memory-scope-"));
  try{const store=openDatabase(join(dir,"pulse.db"));store.seedRuntime({model:"deepseek-v4-flash",channelDriver:"lark-cli"});const fetchImpl=async()=>new Response(JSON.stringify({answer:'本月形成两条稳定用户记忆。\n<memory_delta>[{"content":"用户偏好结论先行","memoryType":"preference","confidence":0.9,"importance":2},{"content":"用户的年度 OKR 是完成 Agent 产品化","memoryType":"goal","confidence":0.9,"importance":3}]</memory_delta>',trace:[]}),{status:200,headers:{"content-type":"application/json"}}),agent=createAgent({store,readDocument:async()=>null,toolRuntime:createToolRuntime({store}),config:{harnessUrl:"http://harness",harnessSecret:"",postTaskDreamingEnabled:false,maxToolSteps:6},fetchImpl});const result=await agent.reviewMonthlyMemory();assert.equal(result.candidates.length,2);assert.deepEqual(result.candidates.map(item=>item.memory_type).sort(),["goal","preference"]);assert.ok(result.candidates.every(item=>item.subject_type==="workspace"));assert.equal(store.memorySearch("OKR").length,0);}finally{rmSync(dir,{recursive:true,force:true});}
});

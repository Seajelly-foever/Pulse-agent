import { createServer } from "node:http";
import { config as loadConfig } from "./config.mjs";
import { openDatabase } from "./db.mjs";
import { createDocumentReader,createLarkCliDocumentWriter,createLarkCliGroupHistoryReader,inspectLarkDocumentAccess } from "./documents.mjs";
import { createAgent } from "./agent.mjs";
import { createGateway } from "./gateway.mjs";
import { startFeishuChannel } from "./feishu-channel.mjs";
import { startLarkCliChannel } from "./lark-cli-channel.mjs";
import { createToolRuntime } from "./tool-runtime.mjs";
import { runDueGroupSyncs,startMaintenanceScheduler } from "./scheduler.mjs";
import { nextScheduledOccurrence } from "./schedule.mjs";
import { createGroupHistoryBackfill } from "./group-history.mjs";
import { createWebTools } from "./web-tools.mjs";
import { bundledSkillDrafts } from "./bundled-skill-drafts.mjs";

const config=loadConfig();
const store=openDatabase(config.databasePath);
store.seedRuntime(config);
for(const draft of bundledSkillDrafts())store.importSkillDraft(draft);
const readDocument=createDocumentReader({driver:config.channelDriver,larkCliBin:config.larkCliBin,larkDocIdentity:config.larkDocIdentity,appId:config.feishuAppId,appSecret:config.feishuAppSecret});
const docWriter=createLarkCliDocumentWriter({larkCliBin:config.larkCliBin,identity:"user"});
const readGroupMessages=config.channelDriver==="lark-cli"?createLarkCliGroupHistoryReader({larkCliBin:config.larkCliBin,identity:config.larkGroupHistoryIdentity,pageLimit:config.groupHistoryPageLimit}):null;
const backfillGroupHistory=createGroupHistoryBackfill({store,readGroupMessages});
const webTools=createWebTools({provider:config.webSearchProvider,searxngBaseUrl:config.searxngBaseUrl,bingSearchUrl:config.bingSearchUrl,bingRegion:config.bingRegion,authSecret:config.harnessSecret,fetchEnabled:config.webFetchEnabled,timeoutMs:config.webToolTimeoutMs});
const toolRuntime=createToolRuntime({store,readGroupMessages,backfillGroupHistory,webSearch:webTools.search,webFetch:webTools.fetchPage});
const agent=createAgent({store,readDocument,toolRuntime,config});
const gateway=createGateway({store,agent,config,backfillGroupHistory});
let channelHandle=null,channelRuntime={driver:config.channelDriver,status:"starting",ready:false};
const scheduler=startMaintenanceScheduler({agent,store,docWriter,backfillGroupHistory,config,sendMessage:async(input)=>{if(!channelHandle?.sendMessage)throw new Error("飞书主动消息通道尚未就绪");return channelHandle.sendMessage(input);}});

const server=createServer(async(req,res)=>{
  try{
    const url=new URL(req.url||"/",`http://${req.headers.host||"localhost"}`);
    if(req.method==="POST"&&url.pathname==="/v1/channels/openclaw"){
      if(!config.openclawBridgeSecret)return send(res,503,{error:"OPENCLAW_BRIDGE_SECRET 尚未配置"});
      if(req.headers.authorization!==`Bearer ${config.openclawBridgeSecret}`)return send(res,401,{error:"Unauthorized"});
      const body=await readBody(req);let reply="";const result=await gateway.receive({channelDriver:"openclaw",eventId:String(body.eventId||`oc_${crypto.randomUUID()}`),eventType:"openclaw.message.receive",messageId:String(body.messageId||`oc_msg_${crypto.randomUUID()}`),chatId:String(body.chatId||body.sessionKey||"openclaw"),chatType:String(body.chatType||"p2p"),senderId:String(body.senderId||""),senderName:String(body.senderName||body.senderId||"OpenClaw 用户"),text:String(body.text||""),raw:body,reply:async(value)=>{reply=value;}});return send(res,200,{...result,reply});
    }
    if(url.pathname!=="/health"&&req.headers.authorization!==`Bearer ${config.secret}`)return send(res,401,{error:"Unauthorized"});
    if(req.method==="GET"&&url.pathname==="/health"){const prompt=store.activeSystemPrompt();return send(res,channelRuntime.status==="failed"?503:200,{ok:channelRuntime.status!=="failed",service:"pulse-local-gateway",channelDriver:config.channelDriver,channel:channelHandle?.getStatus?.()||channelRuntime,feishu:config.channelDriver==="openclaw"?"managed-by-openclaw":config.channelDriver==="lark-cli"?"managed-by-lark-cli":Boolean(config.feishuAppId&&config.feishuAppSecret),groupChat:{enabled:config.groupChatEnabled,replyMode:"mention_only",allowMembers:config.groupChatAllowMembers,autoCapture:config.groupChatAutoCapture,historyBackfill:{enabled:Boolean(readGroupMessages),identity:config.larkGroupHistoryIdentity,pageLimit:config.groupHistoryPageLimit},acknowledgement:{enabled:config.groupAcknowledgementEnabled,text:config.groupAcknowledgementText,emoji:config.groupAcknowledgementEmoji},autoDocumentSync:config.groupSyncEnabled,intervalMinutes:config.groupSyncIntervalMinutes,mentionNames:config.botMentionNames,mentionOpenIds:config.botMentionOpenIds},webAccess:{search:webTools.searchConfigured,provider:webTools.provider,fetch:webTools.fetchConfigured},scheduledTasks:{enabled:config.scheduledTasksEnabled,count:store.scheduledTaskOverview().filter((task)=>task.status==="active").length},documentIdentity:config.larkDocIdentity,harness:config.harnessUrl,model:store.activeModel()?.model_id,systemPrompt:{key:prompt.prompt_key,version:prompt.version,status:prompt.status},monthlyMemory:{enabled:config.monthlyMemoryEnabled,day:config.monthlyMemoryDay,hour:config.monthlyMemoryHour},sessionMemory:"hermes-frozen-snapshot",projectKnowledge:"isolated-store",postTaskDreaming:false,automaticSkillEvolution:config.skillEvolutionEnabled,...store.stats()});}
    if(req.method==="GET"&&url.pathname==="/v1/workspace")return send(res,200,store.workspace());
    if(req.method==="GET"&&url.pathname==="/v1/search")return send(res,200,{query:url.searchParams.get("q")||"",results:store.search(url.searchParams.get("q")||"")});
    if(req.method==="GET"&&url.pathname==="/v1/admin")return send(res,200,{...store.adminOverview(process.env),skillTags:store.skillTagOverview(),channelRuntime:channelHandle?.getStatus?.()||channelRuntime,documentAccess:{identity:config.larkDocIdentity,status:"unchecked"},webAccess:{pluginEnabled:store.capabilityEnabled("web-access"),search:webTools.searchConfigured&&store.capabilityEnabled("web-access"),searchConfigured:webTools.searchConfigured,provider:webTools.provider,fetch:webTools.fetchConfigured&&store.capabilityEnabled("web-access"),fetchConfigured:webTools.fetchConfigured,tools:[{name:"web_search",available:Boolean(webTools.searchConfigured&&store.capabilityEnabled("web-access"))},{name:"web_fetch",available:Boolean(webTools.fetchConfigured&&store.capabilityEnabled("web-access"))}]}});
    const body=await readBody(req);
    if(req.method==="POST"&&url.pathname==="/v1/pairing/approve"){const identity=store.approvePairing(String(body.code||""));return send(res,identity?200:404,identity||{error:"配对码不存在或已失效"});}
    if(req.method==="POST"&&url.pathname==="/v1/simulate"){let reply="";const result=await gateway.receive({channelDriver:config.channelDriver,eventId:String(body.eventId||`sim_${crypto.randomUUID()}`),eventType:"im.message.receive_v1",messageId:String(body.messageId||`sim_msg_${crypto.randomUUID()}`),chatId:"local-simulator",chatType:"p2p",senderId:String(body.senderId||"local-owner"),senderName:String(body.senderName||"本机测试用户"),text:String(body.text||""),raw:body,reply:async(value)=>{reply=value;}});return send(res,200,{...result,reply});}
    if(req.method==="POST"&&url.pathname==="/v1/intake"){const text=String(body.text||body.url||"").trim();if(!text)return send(res,400,{error:"请输入文档链接或需求说明"});const identity=store.ensureIdentity("web-local-owner","本机管理员",true),session=store.ensureSession("web-local-owner","web"),interaction=store.startInteraction({sessionId:session.id,source:"web-document",inputText:text});try{const result=await agent.organize({text,identity,session,messageId:`web_${crypto.randomUUID()}`}),output=result.answer||result.summary||"文档已整理并同步到项目与任务看板";store.finishInteraction(interaction.id,{output,projectId:result.projectId});return send(res,201,{...result,interactionId:interaction.id});}catch(error){store.finishInteraction(interaction.id,{status:"failed",error:error instanceof Error?error.message:"文档处理失败"});throw error;}}
    if(req.method==="POST"&&url.pathname==="/v1/agent"){const text=String(body.prompt||"").trim();if(!text)return send(res,400,{error:"请输入需要 Agent 处理的内容"});const identity=store.ensureIdentity("web-local-owner","本机管理员",true),session=store.ensureSession("web-local-owner","web"),interaction=store.startInteraction({sessionId:session.id,source:"web-prompt",inputText:text});store.captureInbox({actorId:identity.id,source:"web",content:text,itemType:/^(?:\/remember|记住[：:]?)/.test(text)?"memory":/(待办|todo|提醒|需要)/i.test(text)?"action":/https?:\/\//.test(text)?"resource":"note",metadata:{session_id:session.id}});try{const result=await agent.respond({text,identity,session,messageId:`web_${crypto.randomUUID()}`}),output=result.answer||result.summary||"Agent 已完成处理";store.finishInteraction(interaction.id,{output,projectId:result.projectId});return send(res,200,{...result,interactionId:interaction.id});}catch(error){store.finishInteraction(interaction.id,{status:"failed",error:error instanceof Error?error.message:"Agent 处理失败"});throw error;}}
    if(req.method==="POST"&&url.pathname==="/v1/projects"){if(!String(body.name||"").trim())return send(res,400,{error:"项目名称不能为空"});return send(res,201,store.upsertProject({name:String(body.name),summary:String(body.summary||"等待补充项目需求"),ownerName:String(body.owner||"待分配"),health:String(body.health||"ontrack"),phase:String(body.phase||"需求明确"),next:String(body.next||"确认下一步")}));}
    if(req.method==="PATCH"&&url.pathname==="/v1/tasks"){if(!body.id)return send(res,400,{error:"Todo id 不能为空"});return send(res,200,store.updateTodo({id:String(body.id),status:body.status,dueDate:body.dueDate,ownerName:body.ownerName,priority:body.priority}));}
    if(req.method==="DELETE"&&url.pathname==="/v1/tasks"){const id=String(body.id||url.searchParams.get("id")||"");if(!id)return send(res,400,{error:"Todo id 不能为空"});return send(res,200,store.deleteTodo(id));}
    if(req.method==="DELETE"&&url.pathname==="/v1/projects"){const id=String(body.id||url.searchParams.get("id")||"");if(!id)return send(res,400,{error:"项目需求 id 不能为空"});return send(res,200,store.deleteProject(id));}
    if(req.method==="POST"&&url.pathname==="/v1/tasks"){if(!String(body.projectId||"").trim())return send(res,400,{error:"缺少所属项目"});if(!String(body.content||"").trim())return send(res,400,{error:"Todo 内容不能为空"});return send(res,201,store.createTodo({projectId:String(body.projectId),subRequirementId:body.subRequirementId?String(body.subRequirementId):null,content:String(body.content),owner:String(body.owner||"待分配"),dueDate:body.dueDate||null,priority:body.priority,status:body.status}));}
    if(req.method==="POST"&&url.pathname==="/v1/subrequirements"){if(!String(body.projectId||"").trim())return send(res,400,{error:"缺少所属项目"});if(!String(body.title||"").trim())return send(res,400,{error:"业务需求标题不能为空"});return send(res,201,store.createSubRequirement({projectId:String(body.projectId),title:String(body.title),progressSummary:String(body.progressSummary||"待同步进展"),ownerName:String(body.ownerName||"待分配"),priority:body.priority}));}
    if(req.method==="DELETE"&&url.pathname==="/v1/subrequirements"){const id=String(body.id||url.searchParams.get("id")||"");if(!id)return send(res,400,{error:"业务需求 id 不能为空"});return send(res,200,store.deleteSubRequirement(id));}
    if(req.method==="POST"&&url.pathname==="/v1/tools/execute")return send(res,200,await toolRuntime.execute({name:String(body.name||""),input:body.input||{},role:String(body.role||"personal-agent"),sessionId:String(body.sessionId||"")}));
    if(req.method==="POST"&&url.pathname==="/v1/reports"){const session=store.ensureSession("web-local-owner","web");return send(res,201,await agent.report({type:String(body.type||"本周项目周报"),periodDays:Number(body.periodDays)||7,prompt:String(body.prompt||body.type||"生成本周项目周报"),session}));}
    if(req.method==="POST"&&url.pathname==="/v1/admin"){
      if(body.action==="create_model"){if(!String(body.modelId||"").trim())return send(res,400,{error:"modelId 不能为空"});return send(res,201,store.createModel(body));}
      if(body.action==="activate_model"){const model=store.activateModel(String(body.id||""));return send(res,model?200:404,model||{error:"模型不存在"});}
      if(body.action==="save_system_prompt_draft")return send(res,201,store.saveSystemPromptDraft({content:String(body.content||""),summary:String(body.summary||"人工编辑")}));
      if(body.action==="publish_system_prompt_version")return send(res,200,store.publishSystemPromptVersion(String(body.versionId||"")));
      if(body.action==="archive_system_prompt_draft")return send(res,200,store.archiveSystemPromptDraft(String(body.versionId||"")));
      if(body.action==="toggle_capability"){const capability=store.toggleCapability(String(body.id||""),Boolean(body.enabled));return send(res,capability?200:404,capability||{error:"能力不存在"});}
      if(body.action==="create_skill")return send(res,201,store.createSkill({name:body.name,description:body.description,content:body.content,tagName:body.tagName,tagTone:body.tagTone}));
      if(body.action==="create_skill_tag")return send(res,201,store.createSkillTag(body.tagName,body.tagTone));
      if(body.action==="update_skill_tag")return send(res,200,store.updateSkillTag(String(body.skillId||""),String(body.tagName||""),String(body.tagTone||"")));
      if(body.action==="save_skill_draft")return send(res,201,store.saveSkillDraft({skillId:String(body.skillId||""),content:String(body.content||""),summary:String(body.summary||"人工编辑")}));
      if(body.action==="evaluate_skill_version")return send(res,200,store.evaluateSkillVersion(String(body.versionId||"")));
      if(body.action==="publish_skill_version")return send(res,200,store.publishSkillVersion(String(body.versionId||"")));
      if(body.action==="publish_skill_draft")return send(res,200,store.publishSkillDraft(String(body.versionId||"")));
      if(body.action==="rollback_skill_version")return send(res,200,store.rollbackSkillVersion(String(body.versionId||"")));
      if(body.action==="reject_skill_version")return send(res,200,store.rejectSkillVersion(String(body.versionId||"")));
      if(body.action==="evolve_skill")return send(res,201,await agent.evolveSkill(String(body.skillId||"")));
      if(body.action==="run_memory_review")return send(res,201,await agent.reviewMonthlyMemory());
      if(body.action==="run_group_sync")return send(res,201,{results:await runDueGroupSyncs({agent,store,docWriter,backfillGroupHistory,config,force:true})});
      if(["pause_scheduled_task","resume_scheduled_task","delete_scheduled_task"].includes(body.action)){const task=store.scheduledTaskById(String(body.id||""));if(!task)return send(res,404,{error:"定时任务不存在"});const action=body.action.replace("_scheduled_task","").replace("pause","pause").replace("resume","resume").replace("delete","delete"),nextRunAt=action==="resume"?nextScheduledOccurrence(task.schedule,new Date(),config.timezone):null;return send(res,200,store.updateScheduledTask({taskId:task.id,action,nextRunAt,admin:true}));}
      if(body.action==="check_document_access")return send(res,200,await inspectLarkDocumentAccess({larkCliBin:config.larkCliBin}));
      if(body.action==="publish_memory")return send(res,200,store.publishMemory(String(body.id||"")));
      if(body.action==="archive_memory")return send(res,200,store.archiveMemory(String(body.id||"")));
      if(body.action==="publish_profile")return send(res,200,store.publishProfileFact(String(body.id||"")));
      if(body.action==="archive_profile")return send(res,200,store.archiveProfileFact(String(body.id||"")));
      if(body.action==="discover_models")return send(res,200,{models:await discoverModels(store.activeModel())});
      return send(res,400,{error:"不支持的中台操作"});
    }
    return send(res,404,{error:"Not found"});
  }catch(error){console.error(error);return send(res,500,{error:error instanceof Error?error.message:"Internal error"});}
});

server.listen(config.port,config.host,async()=>{console.log(`[gateway] http://${config.host}:${config.port}`);try{if(config.channelDriver==="native-feishu"){channelHandle=await startFeishuChannel({config,onMessage:gateway.receive});channelRuntime={driver:"native-feishu",status:"ready",ready:true};}else if(config.channelDriver==="lark-cli")channelHandle=await startLarkCliChannel({config,onMessage:gateway.receive,onStatus:(status)=>{channelRuntime=status;}});else{channelRuntime={driver:"openclaw",status:"ready",ready:true};console.log("[openclaw] channel bridge enabled; native Feishu and CLI consumers disabled");}}catch(error){channelRuntime={...channelRuntime,driver:config.channelDriver,status:"failed",ready:false,lastError:error instanceof Error?error.message:"channel startup failed"};console.error(`[channel] ${config.channelDriver} failed to start`,error);}});
for(const signal of ["SIGINT","SIGTERM"])process.once(signal,()=>{scheduler.stop();channelHandle?.stop?.();server.close(()=>process.exit(0));});

function send(res,status,body){res.writeHead(status,{"content-type":"application/json; charset=utf-8","access-control-allow-origin":"*"});res.end(JSON.stringify(body));}
async function readBody(req){const chunks=[];for await(const chunk of req)chunks.push(chunk);if(!chunks.length)return{};return JSON.parse(Buffer.concat(chunks).toString("utf8"));}
async function discoverModels(model){if(!model)throw new Error("尚未配置模型");const key=process.env[model.api_key_env];if(!key)throw new Error(`环境变量 ${model.api_key_env} 尚未配置`);const response=await fetch(`${String(model.base_url).replace(/\/$/,"")}/models`,{headers:{authorization:`Bearer ${key}`}});const body=await response.json();if(!response.ok)throw new Error(body?.error?.message||`模型接口返回 ${response.status}`);return(body.data||[]).map((item)=>({id:item.id,ownedBy:item.owned_by||"provider"}));}

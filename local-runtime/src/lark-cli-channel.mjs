import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { buildAgentResultCard,buildScheduledResultCard } from "./lark-card.mjs";

const notifierEnv={LARKSUITE_CLI_NO_UPDATE_NOTIFIER:"1",LARKSUITE_CLI_NO_SKILLS_NOTIFIER:"1"};

export async function startLarkCliChannel({config,onMessage,log=console,onStatus=()=>{}}){
  let child=null,stopping=false,restartDelay=1000,restartTimer=null;
  const state={driver:"lark-cli",status:"starting",ready:false,pid:null,startedAt:new Date().toISOString(),lastReadyAt:null,lastEventAt:null,lastReplyAt:null,lastError:null,restarts:0,eventsReceived:0,repliesSent:0,reactionsAdded:0};
  const publish=(patch={})=>{Object.assign(state,patch);onStatus({...state});};
  const scheduleRestart=()=>{if(stopping)return;const delay=restartDelay;restartDelay=Math.min(restartDelay*2,30000);publish({status:"reconnecting",ready:false,restarts:state.restarts+1});log.warn(`[lark-cli] restart in ${delay}ms`);restartTimer=setTimeout(()=>start().catch((error)=>{publish({status:"failed",ready:false,lastError:safeMessage(error)});log.error("[lark-cli] restart failed",safeMessage(error));scheduleRestart();}),delay);restartTimer.unref();};
  const start=()=>new Promise((resolve,reject)=>{
    let settled=false;
    publish({status:"starting",ready:false,lastError:null});
    child=spawn(config.larkCliBin,["event","consume","im.message.receive_v1","--as","bot"],{env:{...process.env,...notifierEnv},stdio:["pipe","pipe","pipe"]});
    publish({pid:child.pid||null});
    const stdout=createInterface({input:child.stdout}),stderr=createInterface({input:child.stderr});
    stdout.on("line",(line)=>{if(!line.trim())return;try{const parsed=JSON.parse(line),event=normalizeLarkEvent(parsed);if(!event||event.senderType==="bot")return;publish({lastEventAt:new Date().toISOString(),eventsReceived:state.eventsReceived+1});void onMessage({...event,channelDriver:"lark-cli",reply:async(content,options={})=>{await replyWithCli(config,event.messageId,content,options);publish({lastReplyAt:new Date().toISOString(),repliesSent:state.repliesSent+1});},react:async(emojiType)=>{await reactWithCli(config,event.messageId,emojiType);publish({reactionsAdded:state.reactionsAdded+1});}}).catch((error)=>{publish({lastError:safeMessage(error)});log.error("[lark-cli] event processing failed",safeMessage(error));});}catch(error){log.warn("[lark-cli] ignored invalid NDJSON event",safeMessage(error));}});
    stderr.on("line",(line)=>{if(line.includes("[event] ready event_key=im.message.receive_v1")){restartDelay=1000;publish({status:"ready",ready:true,lastReadyAt:new Date().toISOString(),lastError:null});if(!settled){settled=true;log.info("[lark-cli] message consumer ready");resolve();}return;}if(line.trim())log.warn("[lark-cli]",redact(line).slice(0,1000));});
    child.once("error",(error)=>{publish({lastError:safeMessage(error),ready:false});if(!settled){settled=true;reject(error);}else log.error("[lark-cli] consumer error",safeMessage(error));});
    child.once("exit",(code,signal)=>{stdout.close();stderr.close();child=null;publish({pid:null,ready:false});if(!settled){settled=true;reject(new Error(`lark-cli consumer exited before ready (${code??signal})`));return;}if(stopping){publish({status:"stopped"});return;}log.warn(`[lark-cli] consumer exited (${code??signal})`);scheduleRestart();});
  });
  await hydrateBotIdentity(config,log);
  await start();
  return{getStatus(){return{...state};},sendMessage:(input)=>sendMessageWithCli(config,input),stop(){stopping=true;if(restartTimer)clearTimeout(restartTimer);publish({status:"stopping",ready:false});if(child?.stdin&&!child.stdin.destroyed)child.stdin.end();if(child&&!child.killed)setTimeout(()=>{if(child&&!child.killed)child.kill("SIGTERM");},1500).unref();else publish({status:"stopped",pid:null});}};
}

async function hydrateBotIdentity(config,log){
  try{
    const result=await runCliAction(config,["api","GET","/open-apis/bot/v3/info","--as","bot","--format","json"],"无法读取飞书 Bot 身份"),bot=result?.data?.bot||result?.bot||result?.data||{},openId=String(bot.open_id||bot.openId||"").trim(),name=String(bot.app_name||bot.appName||bot.name||"").trim();
    if(openId&&!config.botMentionOpenIds.includes(openId))config.botMentionOpenIds.push(openId);
    if(name&&!config.botMentionNames.includes(name))config.botMentionNames.push(name);
    if(openId||name)log.info(`[lark-cli] bot identity ready${name?` (${name})`:""}`);
  }catch(error){log.warn("[lark-cli] bot identity discovery skipped",safeMessage(error));}
}

export function normalizeLarkEvent(value){
  const event=value?.data&&value.ok===true?value.data:value;
  if(!event||event.type!=="im.message.receive_v1"||!event.message_id||!event.sender_id)return null;
  return{eventId:String(event.message_id),deliveryEventId:event.event_id?String(event.event_id):null,eventType:"im.message.receive_v1",messageId:String(event.message_id),chatId:String(event.chat_id||""),chatType:String(event.chat_type||"p2p"),senderId:String(event.sender_id),senderName:String(event.sender_name||event.sender_id),senderType:String(event.sender_type||"user"),text:normalizeContent(event.content),raw:event};
}

export function normalizeContent(value){const text=String(value||"").trim(),wrapped=text.match(/^```(?:PLAIN_TEXT|TEXT)\s*\n([\s\S]*?)\n```$/i);return(wrapped?.[1]||text).trim();}

export async function replyWithCli(config,messageId,content,{phase="final",format="markdown",result=null}={}){
  const idempotency=`pulse-${phase}-${messageId}`.slice(0,50);
  if(format!=="text"&&(phase==="final"||phase==="error")){
    const card=buildAgentResultCard(content,{phase,skill:result?.skill||result?.selectedSkills?.[0],engine:result?.engine,model:result?.model,toolSteps:result?.toolSteps});
    try{return await runCliAction(config,["im","+messages-reply","--message-id",messageId,"--msg-type","interactive","--content",JSON.stringify(card),"--as","bot","--idempotency-key",idempotency,"--format","json"],"飞书 CLI 卡片回复失败");}
    catch{ /* Card 2.0 不可用时保留文字回复，避免消息链路中断。 */ }
  }
  const contentFlag=format==="text"?"--text":"--markdown",args=["im","+messages-reply","--message-id",messageId,contentFlag,String(content).slice(0,20000),"--as","bot","--idempotency-key",idempotency,"--format","json"];
  return runCliAction(config,args,"飞书 CLI 回复失败");
}

export function reactWithCli(config,messageId,emojiType="OneSecond"){
  const args=["im","reactions","create","--params",JSON.stringify({message_id:messageId}),"--data",JSON.stringify({reaction_type:{emoji_type:emojiType}}),"--as","bot","--format","json"];
  return runCliAction(config,args,"飞书 CLI 表情回复失败");
}

export async function sendMessageWithCli(config,{chatId=null,userId=null,content,idempotencyKey=null,card=null,taskName=null,skill=null,model=null}){
  if(!chatId&&!userId)throw new Error("主动消息缺少群聊或用户目标");const target=[chatId?"--chat-id":"--user-id",String(chatId||userId)],key=String(idempotencyKey||`pulse-scheduled-${Date.now()}`).slice(0,50),payload=card||buildScheduledResultCard(content,{name:taskName||"定时任务",skill,model});
  try{return await runCliAction(config,["im","+messages-send",...target,"--msg-type","interactive","--content",JSON.stringify(payload),"--as","bot","--idempotency-key",key,"--format","json"],"飞书 CLI 主动卡片发送失败");}
  catch{return runCliAction(config,["im","+messages-send",...target,"--markdown",String(content).slice(0,20000),"--as","bot","--idempotency-key",key,"--format","json"],"飞书 CLI 主动发送失败");}
}

function runCliAction(config,args,fallbackMessage){return new Promise((resolve,reject)=>{
  const child=spawn(config.larkCliBin,args,{env:{...process.env,...notifierEnv},stdio:["ignore","pipe","pipe"]});let stdout="",stderr="";child.stdout.on("data",(chunk)=>{stdout+=chunk;});child.stderr.on("data",(chunk)=>{stderr+=chunk;});child.once("error",reject);child.once("exit",(code)=>{if(code===0){let parsed={};try{parsed=stdout?JSON.parse(stdout):{};if(parsed.ok===false)return reject(new Error(parsed.error?.message||fallbackMessage));}catch{ /* an exit code of zero is authoritative */ }return resolve(parsed);}let message=`lark-cli exited ${code}`;try{const parsed=JSON.parse(stderr);message=parsed.error?.message||parsed.error?.hint||message;}catch{if(stderr.trim())message=stderr.trim().slice(0,500);}reject(new Error(redact(message)));});
});}

function redact(value){return String(value).replace(/(app[_-]?secret|access[_-]?token|refresh[_-]?token|authorization)(\s*[:=]\s*)\S+/gi,"$1$2[REDACTED]");}
function safeMessage(error){return redact(error instanceof Error?error.message:String(error));}

import { createSessionQueue } from "./queue.mjs";

export function createGateway({store,agent,config,backfillGroupHistory=null,log=console}){
  const enqueue=createSessionQueue({onTimeout:(key)=>log.warn(`[queue] timeout ${key}`)});
  async function receive(input){
    const channelCapability=input.channelDriver==="openclaw"?"openclaw-channel":input.channelDriver==="lark-cli"?"lark-cli-channel":"feishu-channel";
    if(!store.capabilityEnabled(channelCapability)){await input.reply?.(`Pulse 的 ${channelCapability} 插件当前已停用，请在 Agent 中台重新启用。`);return{disabled:true};}
    store.touchCapability(channelCapability);
    if(!input.senderId)throw new Error("缺少飞书发送者 open_id");
    const isGroup=input.chatType==="group";
    if(input.chatType!=="p2p"&&!isGroup)return{ignored:true,reason:"unsupported_chat_type"};
    if(isGroup&&!config.groupChatEnabled)return{ignored:true,reason:"group_chat_disabled"};
    const mentionMatch=isGroup?matchBotMention(input,config.botMentionNames,config.botMentionOpenIds):{matched:false,names:[]},mentioned=mentionMatch.matched,messageText=mentioned?stripBotMention(input.text,[...(config.botMentionNames||[]),...mentionMatch.names]):input.text,sessionPeer=isGroup?`group:${input.chatId}`:input.senderId,sessionKey=`feishu:default:${isGroup?"group":"p2p"}:${isGroup?input.chatId:input.senderId}`;
    if(isGroup)log.info?.(`[gateway] group message ${input.messageId||input.eventId}: botMention=${mentioned} mentions=${messageMentions(input).map((item)=>item.name||item.id).join(",")||"none"}`);
    if(isGroup&&!mentioned&&!config.groupChatAutoCapture)return{ignored:true,reason:"bot_not_mentioned"};
    if(!store.recordEvent({eventId:input.eventId,eventType:input.eventType||"im.message.receive_v1",sessionKey,payload:input.raw||input}))return{duplicate:true};
    const mentions=messageMentions(input),identity=store.ensureIdentity(input.senderId,input.senderName,config.ownerOpenIds.includes(input.senderId)),groupMemberAccess=isGroup&&config.groupChatAllowMembers,effectiveIdentity=groupMemberAccess&&identity.status!=="approved"?{...identity,status:"group_member"}:identity;
    store.observeMentionedIdentities?.(mentions);
    const session=store.ensureSession(sessionPeer,input.chatId);
    store.addMessage(session.id,input.messageId,"user",messageText,{channel:"feishu",chat_type:input.chatType,sender_id:input.senderId,sender_name:input.senderName,mentioned,mentions});
    if(isGroup){store.markGroupMessage(input.chatId);if(!mentioned){store.captureInbox({actorId:identity.id,source:"feishu-group",content:messageText,itemType:"group_message",metadata:{message_id:input.messageId,chat_id:input.chatId,chat_type:"group",sender_id:input.senderId,sender_name:input.senderName,mentioned:false}});store.setEventStatus(input.eventId,"done");return{captured:true,reply:false,reason:"group_background_capture"};}}
    if(messageText.trim()==="/whoami"){const access=identity.status==="approved"?"已授权账号":groupMemberAccess?"群成员访问（仅群聊）":identity.status,answer=`你的飞书 open_id：${input.senderId}\n授权状态：${access}`;store.addMessage(session.id,null,"assistant",answer);await input.reply?.(answer);store.setEventStatus(input.eventId,"done");return{answer};}
    if(identity.status!=="approved"&&!groupMemberAccess){const answer=isGroup?"请先私聊 Pulse Bot 完成账号配对，再回到群里 @Bot 使用。":`这台 Pulse 尚未授权你的账号。\n\n配对码：${identity.pairing_code}\n请在运行 Pulse 的电脑执行：npm run local:pair -- ${identity.pairing_code}`;store.addMessage(session.id,null,"assistant",answer);await input.reply?.(answer);store.setEventStatus(input.eventId,"awaiting_pairing");return{pairingRequired:true,code:isGroup?null:identity.pairing_code};}
    store.captureInbox({actorId:identity.id,source:input.channelDriver||"native-feishu",content:messageText,itemType:/https?:\/\//.test(messageText)?"resource":/(待办|todo|提醒|需要我|记得)/i.test(messageText)?"action":/^(?:\/remember|记住)/.test(messageText)?"memory":"note",metadata:{message_id:input.messageId,chat_id:input.chatId,chat_type:input.chatType,access:groupMemberAccess?"group_member":"approved"}});
    if(isGroup&&mentioned&&config.groupAcknowledgementEnabled===true)await acknowledge(input,config,log);
    const interaction=store.startInteraction?.({sessionId:session.id,source:isGroup?"feishu-group":"feishu-private",inputText:messageText});return enqueue(sessionKey,async()=>{try{store.setEventStatus(input.eventId,"processing");if(isGroup&&mentioned&&needsGroupHistory(messageText)&&backfillGroupHistory)try{await backfillGroupHistory({chatId:input.chatId,sessionId:session.id});}catch(error){log.warn?.(`[gateway] group history prefetch failed: ${error instanceof Error?error.message:String(error)}`);}let result;if(messageText.trim()==="/status")result={answer:statusText(store.stats(),config),engine:"system"};else if(messageText.trim()==="/memory-review")result=await agent.reviewWeeklyMemory();else result=await agent.respond({text:messageText,identity:effectiveIdentity,session,messageId:input.messageId});const answer=result.answer||result.content||result.summary||"处理完成";if(interaction)store.finishInteraction?.(interaction.id,{output:answer,projectId:result.projectId||null});store.addMessage(session.id,null,"assistant",answer,{engine:result.engine,skill:result.skill||null,chat_type:input.chatType,access:groupMemberAccess?"group_member":"approved"});await input.reply?.(answer,{phase:"final",result});store.setEventStatus(input.eventId,"done");return{...result,answer};}catch(error){const message=error instanceof Error?error.message:"处理失败";if(interaction)store.finishInteraction?.(interaction.id,{status:"failed",error:message});store.setEventStatus(input.eventId,"failed",message);await input.reply?.(`处理失败：${message}`,{phase:"error",result:{engine:"pulse-error"}});throw error;}});
  }
  return{receive};
}

async function acknowledge(input,config,log){const tasks=[];if(input.reply)tasks.push(["reply",input.reply(config.groupAcknowledgementText||"正在努力思考中，请稍等",{phase:"ack",format:"text"})]);if(input.react&&config.groupAcknowledgementEmoji)tasks.push(["reaction",input.react(config.groupAcknowledgementEmoji)]);const results=await Promise.allSettled(tasks.map(([,task])=>task));for(let index=0;index<results.length;index++){const result=results[index],kind=tasks[index][0];if(result.status==="rejected")log.warn(`[gateway] acknowledgement ${kind} failed`,result.reason instanceof Error?result.reason.message:String(result.reason));else log.info?.(`[gateway] acknowledgement ${kind} sent for ${input.messageId||input.eventId}`);}}

function statusText(stats,config){return[`Pulse Agent 正常运行`,`项目：${stats.projects}`,`资料：${stats.documents}`,`消息事件：${stats.events}`,`待授权账号：${stats.pendingPairings}`,`Agent：${config.harnessUrl?"DeepSeek Harness 已配置":"结构化降级模式"}`].join("\n");}
function needsGroupHistory(text){return/(群聊|本群|群消息|历史消息|聊天记录|之前|过去|刚才|发言|讨论|总结|回顾|谁.{0,8}(说|提到))/i.test(String(text||""));}
function matchBotMention(input,names=[],openIds=[]){
  const text=String(input.text||""),mentions=messageMentions(input),normalizedIds=new Set(openIds.map((value)=>String(value).trim()).filter(Boolean)),matchedMentions=mentions.filter((item)=>normalizedIds.has(String(item?.id||item?.open_id||item?.user_id||"").trim())||names.some((name)=>String(item?.name||item?.display_name||"").toLowerCase().includes(String(name).toLowerCase()))),matchedByText=names.some((name)=>text.toLowerCase().includes(`@${String(name).toLowerCase()}`));
  return{matched:matchedMentions.length>0||matchedByText,names:matchedMentions.map((item)=>String(item?.name||item?.display_name||"").trim()).filter(Boolean)};
}
function messageMentions(input){const items=input.raw?.mentions||input.raw?.event?.message?.mentions||[];return Array.isArray(items)?items.map((item)=>({id:String(item?.id||item?.open_id||item?.user_id||"").trim(),name:String(item?.name||item?.display_name||"").trim()})).filter((item)=>item.id||item.name):[];}
function stripBotMention(value,names=[]){let text=String(value||"");for(const name of names)text=text.replace(new RegExp(`@${escapeRegex(name)}[\\s,:：，-]*`,"ig"),"");return text.trim();}
function escapeRegex(value){return String(value).replace(/[.*+?^${}()|[\]\\]/g,"\\$&");}

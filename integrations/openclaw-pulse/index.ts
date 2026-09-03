import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

export default definePluginEntry({
  id:"pulse-bridge",
  name:"Pulse Agent Bridge",
  description:"Use Pulse and DeepSeek Harness as the Feishu agent runtime.",
  register(api){
    api.on("before_agent_reply",async(event,ctx)=>{
      if(ctx.channel!=="feishu"&&ctx.messageProvider!=="feishu")return;
      const config=(api.pluginConfig||{}) as {gatewayUrl?:string;bridgeSecretEnv?:string};
      const gatewayUrl=(config.gatewayUrl||process.env.PULSE_GATEWAY_URL||"http://gateway:8789").replace(/\/$/,"");
      const secretName=config.bridgeSecretEnv||"OPENCLAW_BRIDGE_SECRET";
      const secret=process.env[secretName];
      if(!secret){api.logger.error(`${secretName} is not configured`);return{handled:true,reply:{text:"Pulse Bridge 尚未完成安全配置。"}};}
      const response=await fetch(`${gatewayUrl}/v1/channels/openclaw`,{method:"POST",headers:{"content-type":"application/json",authorization:`Bearer ${secret}`},body:JSON.stringify({eventId:ctx.runId||crypto.randomUUID(),messageId:ctx.runId||crypto.randomUUID(),sessionKey:ctx.sessionKey,chatId:ctx.chatId,chatType:ctx.channelContext?.chat?.id?"p2p":"p2p",senderId:ctx.senderId||ctx.requester?.senderId,senderName:ctx.requester?.senderDisplayName,text:event.cleanedBody})});
      const result=await response.json() as {reply?:string;answer?:string;error?:string};
      if(!response.ok)throw new Error(result.error||`Pulse bridge ${response.status}`);
      return{handled:true,reply:{text:result.reply||result.answer||"Pulse 已完成处理。"}};
    },{eligibleTriggers:["user"],timeoutMs:120000});
  },
});

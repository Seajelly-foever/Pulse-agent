export async function startFeishuChannel({config,onMessage,log=console}){
  if(!config.feishuEnabled){log.info("[feishu] disabled");return null;}
  if(!config.feishuAppId||!config.feishuAppSecret){log.warn("[feishu] credentials missing; simulation API remains available");return null;}
  const Lark=await import("@larksuiteoapi/node-sdk");
  const domain=config.feishuDomain==="lark"?Lark.Domain.Lark:Lark.Domain.Feishu;
  const client=new Lark.Client({appId:config.feishuAppId,appSecret:config.feishuAppSecret,domain,appType:Lark.AppType.SelfBuild});
  const dispatcher=new Lark.EventDispatcher({}).register({"im.message.receive_v1":async(payload)=>{
    const root=payload?.event?payload:{event:payload};
    const event=root.event||{};const message=event.message||{};const sender=event.sender||{};
    let text=String(message.content||"");try{text=JSON.parse(text)?.text||text;}catch{ /* non-text payload remains raw */ }
    await onMessage({eventId:String(root.header?.event_id||message.message_id||crypto.randomUUID()),eventType:"im.message.receive_v1",messageId:String(message.message_id||""),chatId:String(message.chat_id||""),chatType:String(message.chat_type||"p2p"),senderId:String(sender.sender_id?.open_id||sender.sender_id?.user_id||""),senderName:String(sender.sender_id?.open_id||"飞书用户"),text,raw:root,reply:async(content)=>{if(message.message_id){await client.im.message.reply({path:{message_id:message.message_id},data:{msg_type:"text",content:JSON.stringify({text:content})}});}else{await client.im.message.create({params:{receive_id_type:"chat_id"},data:{receive_id:message.chat_id,msg_type:"text",content:JSON.stringify({text:content})}});}}});
  }});
  const ws=new Lark.WSClient({appId:config.feishuAppId,appSecret:config.feishuAppSecret,domain,loggerLevel:Lark.LoggerLevel.info});
  ws.start({eventDispatcher:dispatcher}).catch((error)=>log.error("[feishu] websocket stopped",error));
  log.info("[feishu] websocket connecting");
  return{client,ws};
}

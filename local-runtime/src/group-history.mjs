export function createGroupHistoryBackfill({store,readGroupMessages,log=console}={}){
  return async function backfillGroupHistory({chatId,sessionId=null}={}){
    const safeChatId=String(chatId||"").trim();
    if(!readGroupMessages)return{available:false,chatId:safeChatId,received:0,inserted:0,hasMore:false,identity:null};
    const session=sessionId?store.sessionById(sessionId):store.ensureSession(`group:${safeChatId}`,safeChatId);
    if(!session||!safeChatId)throw new Error("群聊历史补采缺少有效会话");
    try{
      const remote=await readGroupMessages({chatId:safeChatId}),imported=store.importGroupMessages(session.id,remote.messages),result={available:true,chatId:safeChatId,received:imported.received,inserted:imported.inserted,hasMore:Boolean(remote.hasMore),identity:remote.identity||"user"};
      store.recordGroupHistorySync?.(safeChatId,result);
      log.info?.(`[group-history] ${safeChatId} received=${result.received} inserted=${result.inserted} hasMore=${result.hasMore}`);
      return result;
    }catch(error){
      const message=error instanceof Error?error.message:"群聊历史读取失败";store.recordGroupHistorySync?.(safeChatId,{error:message});log.warn?.(`[group-history] ${safeChatId} failed: ${message}`);throw error;
    }
  };
}

const MAX_ANSWER_CHARS=18000;

export function buildAgentResultCard(content,{phase="final",skill=null,engine=null,toolSteps=[],model=null,botName="Alex"}={}){
  const failed=phase==="error",steps=Array.isArray(toolSteps)?toolSteps:[],tools=[...new Set(steps.map((step)=>step?.call?.name).filter(Boolean))],rounds=steps.length,status=failed?"处理失败":"处理完成",template=failed?"red":"green";
  const elements=[
    metricRow([
      ["执行能力",skill||"general-assistant"],
      ["ReAct 轮次",String(Math.max(1,rounds+1))],
      ["工具调用",String(tools.length)],
    ]),
    {tag:"markdown",content:`**${failed?"失败原因":"处理结果"}**\n\n${safeMarkdown(content)}`},
  ];
  const details=[];
  if(tools.length)details.push(`**调用工具**\n${tools.map((name)=>`- ${escapeMarkdown(name)}`).join("\n")}`);
  if(steps.some((step)=>step?.error))details.push(`**异常观察**\n${steps.filter((step)=>step?.error).slice(0,4).map((step)=>`- Round ${step.round||"?"}：${escapeMarkdown(step.error)}`).join("\n")}`);
  if(details.length)elements.push({tag:"collapsible_panel",expanded:false,background_color:"grey-50",border:{color:"grey-200",corner_radius:"8px"},padding:"10px",header:{title:{tag:"plain_text",content:"执行详情"},width:"fill"},elements:details.map((item)=>({tag:"markdown",content:item,text_size:"notation"}))});
  elements.push({tag:"markdown",text_size:"notation",content:`<font color='grey'>${escapeMarkdown([model||engine||"Pulse Agent",skill&&`Skill: ${skill}`].filter(Boolean).join(" · "))}</font>`});
  return{
    schema:"2.0",
    config:{update_multi:true,width_mode:"default",summary:{content:`${botName} · ${status}`},style:{color:{"pulse-muted":{light_mode:"rgba(100,106,115,1)",dark_mode:"rgba(150,155,163,1)"}}}},
    header:{title:{tag:"plain_text",content:`${botName} · ${status}`},subtitle:{tag:"plain_text",content:failed?"任务没有完成，错误已被记录":"本轮 Agent 结果已生成"},template,icon:{tag:"standard_icon",token:"ai-common_colorful"},text_tag_list:[{tag:"text_tag",text:{tag:"plain_text",content:failed?"失败":"完成"},color:failed?"red":"green"}]},
    body:{direction:"vertical",padding:"12px 12px 20px 12px",vertical_spacing:"12px",elements},
  };
}

export function buildScheduledResultCard(content,{name="定时任务",skill=null,model=null}={}){
  const card=buildAgentResultCard(content,{phase:"final",skill,model,botName:"Alex"});
  card.header.title.content=`Alex · ${String(name).slice(0,60)}`;
  card.header.subtitle.content="定时任务已执行并主动推送";
  card.header.icon={tag:"standard_icon",token:"calendar_colorful"};
  card.config.summary.content=`定时任务 · ${String(name).slice(0,80)}`;
  return card;
}

function metricRow(items){return{tag:"column_set",flex_mode:"none",horizontal_spacing:"8px",columns:items.map(([label,value])=>({tag:"column",width:"weighted",weight:1,background_style:"grey-50",padding:"10px",vertical_spacing:"2px",elements:[{tag:"markdown",content:`**${escapeMarkdown(value)}**`,text_align:"center"},{tag:"markdown",content:`<font color='grey'>${escapeMarkdown(label)}</font>`,text_align:"center",text_size:"notation"}]}))};}
function safeMarkdown(value){const text=String(value||"处理完成").trim().slice(0,MAX_ANSWER_CHARS);return text||"处理完成";}
function escapeMarkdown(value){return String(value??"").replaceAll("&","&amp;").replaceAll("<","&#60;").replaceAll(">","&#62;").replaceAll("*","&#42;").replaceAll("_","&#95;").replaceAll("[","&#91;").replaceAll("]","&#93;");}

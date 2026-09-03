"use client";

import { FormEvent,useCallback,useEffect,useMemo,useState } from "react";

type Todo={id:string;content:string;owner_name:string;status:string;due_date?:string;priority?:number;created_at?:string};
type SubRequirement={id:string;title:string;progress_summary:string;status:string;progress:number;owner_name:string;priority:number;todos:Todo[]};
type Project={id:string;name:string;summary:string;health:string;progress:number;owner_name:string;target_date?:string;updated_at:string;config:{phase?:string;next?:string;signal?:string};subrequirements:SubRequirement[];unscopedTodos?:Todo[]};
type Update={id:string;project_id:string;summary:string;author_name:string;created_at:string};
type Asset={id:string;project_id?:string;project_name?:string;title:string;url:string;updated_at:string;metadata?:{excerpt?:string;sync_status?:string}};
type Person={id:string;email:string;display_name:string;role:string};
type Space={id:string;name:string;role:string};
type GroupSync={chat_id:string;output_doc_url?:string;last_written_at?:string;last_summary?:string;last_error?:string;pending_messages:number};
type Report={id:string;title:string;content:string;created_at?:string};
type Interaction={id:string;source:string;input_text:string;source_urls?:string[];output_markdown?:string;status:string;error?:string;created_at:string};
type Workspace={workspace:Space;workspaces:Space[];actor?:{id:string;email:string;name:string};members:Person[];projects:Project[];updates:Update[];assets:Asset[];reports:Report[];activityHistory?:Interaction[];groupSyncs?:GroupSync[]};
type View="chat"|"board";
type ChatEntry={id:string;kind:"prompt"|"report";title:string;body:string;source:string;status:string;created_at:string;urls?:string[]};
type QuickForm={mode:"project"|"subrequirement"|"todo";projectId?:string;projectName?:string;subId?:string;subTitle?:string};

const colors=["#0071e3","#af52de","#ff9500","#34c759","#ff3b30","#5856d6"];
const empty:Workspace={workspace:{id:"",name:"我的个人空间",role:"admin"},workspaces:[],members:[],projects:[],updates:[],assets:[],reports:[]};

export default function Home(){
  const[data,setData]=useState<Workspace>(empty),[loading,setLoading]=useState(true),[error,setError]=useState("");
  const[workspaceId,setWorkspaceId]=useState(""),[view,setView]=useState<View>("chat"),[filter,setFilter]=useState("全部"),[timeFilter,setTimeFilter]=useState("全部时间"),[input,setInput]=useState(""),[processing,setProcessing]=useState(false),[pendingText,setPendingText]=useState("");
  const[reporting,setReporting]=useState(false),[expandedProjects,setExpandedProjects]=useState<Record<string,boolean>>({}),[expandedSubs,setExpandedSubs]=useState<Record<string,boolean>>({}),[selected,setSelected]=useState<Project|null>(null),[share,setShare]=useState(false),[toast,setToast]=useState(""),[quickForm,setQuickForm]=useState<QuickForm|null>(null),[openEntry,setOpenEntry]=useState<string|null>(null),[sidebarOpen,setSidebarOpen]=useState(true);
  const headers=useCallback((id?:string)=>({"content-type":"application/json",...((id||workspaceId)?{"x-pulse-workspace-id":id||workspaceId}:{})}),[workspaceId]);
  const refresh=useCallback(async(id?:string,silent=false)=>{if(!silent)setError("");try{const r=await fetch("/api/workspace",{cache:"no-store",headers:(id||workspaceId)?{"x-pulse-workspace-id":id||workspaceId}:{}}),j=await r.json();if(!r.ok)throw new Error(j.error);setData(j);setWorkspaceId(j.workspace.id)}catch(e){if(!silent)setError(e instanceof Error?e.message:"工作空间暂时不可用")}finally{if(!silent)setLoading(false)}},[workspaceId]);
  useEffect(()=>{void refresh();const timer=window.setInterval(()=>{if(document.visibilityState==="visible")void refresh(undefined,true)},5000);return()=>clearInterval(timer)},[refresh]);
  const notify=(message:string)=>{setToast(message);window.setTimeout(()=>setToast(""),2400)};
  async function submit(value:string){value=value.trim();if(!value||processing)return;setProcessing(true);setPendingText(value);setOpenEntry(null);try{const hasUrl=/https?:\/\/[^\s]+/.test(value),r=await fetch(hasUrl?"/api/intake":"/api/agent",{method:"POST",headers:headers(),body:JSON.stringify(hasUrl?{text:value}:{prompt:value})}),j=await r.json();if(!r.ok)throw new Error(j.error);setInput("");await refresh();if(j.interactionId)setOpenEntry(j.interactionId)}catch(e){notify(e instanceof Error?e.message:"Agent 处理失败")}finally{setProcessing(false);setPendingText("")}}
  async function intake(e:FormEvent){e.preventDefault();await submit(input)}
  async function generateReport(type="本周项目周报",periodDays=7){if(reporting||processing)return;setReporting(true);setPendingText(`生成${type}`);setOpenEntry(null);try{const r=await fetch("/api/reports",{method:"POST",headers:headers(),body:JSON.stringify({type,periodDays})}),j=await r.json();if(!r.ok)throw new Error(j.error);await refresh();setView("chat");if(j.id)setOpenEntry(j.id)}catch(e){notify(e instanceof Error?e.message:"周报生成失败")}finally{setReporting(false);setPendingText("")}}
  async function workspaceAction(action:"invite"|"create",value:string){const r=await fetch("/api/workspaces",{method:"POST",headers:headers(),body:JSON.stringify(action==="invite"?{action,email:value}:{action,name:value})}),j=await r.json();if(!r.ok)throw new Error(j.error);if(action==="create"){setWorkspaceId(j.id);await refresh(j.id)}else await refresh();notify(action==="create"?"新空间已创建":"邀请已记录")}
  async function changeTodo(todo:Todo,status:string){try{const r=await fetch("/api/tasks",{method:"PATCH",headers:headers(),body:JSON.stringify({id:todo.id,status})}),j=await r.json();if(!r.ok)throw new Error(j.error);await refresh(undefined,true)}catch(e){notify(e instanceof Error?e.message:"Todo 更新失败")}}
  async function removeTodo(todo:Todo){if(!window.confirm(`删除 Todo「${todo.content}」？历史记录仍会保留。`))return;try{const r=await fetch("/api/tasks",{method:"DELETE",headers:headers(),body:JSON.stringify({id:todo.id})}),j=await r.json();if(!r.ok)throw new Error(j.error);await refresh(undefined,true);notify("Todo 已删除")}catch(e){notify(e instanceof Error?e.message:"Todo 删除失败")}}
  async function removeProject(project:Project){if(!window.confirm(`删除项目需求「${project.name}」及其全部 Todo？源文档与历史记录仍会保留。`))return;try{const r=await fetch("/api/projects",{method:"DELETE",headers:headers(),body:JSON.stringify({id:project.id})}),j=await r.json();if(!r.ok)throw new Error(j.error);if(selected?.id===project.id)setSelected(null);await refresh(undefined,true);notify("项目需求已删除")}catch(e){notify(e instanceof Error?e.message:"项目需求删除失败")}}
  async function removeSubrequirement(sub:SubRequirement){if(sub.id.includes(":overall")){notify("这是系统生成的整体推进分组，无法删除");return}if(!window.confirm(`删除业务需求「${sub.title}」及其下全部 Todo？`))return;try{const r=await fetch("/api/subrequirements",{method:"DELETE",headers:headers(),body:JSON.stringify({id:sub.id})}),j=await r.json();if(!r.ok)throw new Error(j.error);await refresh(undefined,true);notify("业务需求已删除")}catch(e){notify(e instanceof Error?e.message:"业务需求删除失败")}}
  async function submitQuickForm(form:QuickForm,values:Record<string,string>){
    if(form.mode==="project"){const r=await fetch("/api/projects",{method:"POST",headers:headers(),body:JSON.stringify({name:values.name,summary:values.summary||"等待补充项目需求",owner:values.owner||"待分配"})}),j=await r.json();if(!r.ok)throw new Error(j.error||"项目创建失败")}
    else if(form.mode==="subrequirement"){const r=await fetch("/api/subrequirements",{method:"POST",headers:headers(),body:JSON.stringify({projectId:form.projectId,title:values.title,progressSummary:values.progressSummary||"待同步进展",ownerName:values.owner||"待分配"})}),j=await r.json();if(!r.ok)throw new Error(j.error||"业务需求创建失败")}
    else{const r=await fetch("/api/tasks",{method:"POST",headers:headers(),body:JSON.stringify({projectId:form.projectId,subRequirementId:form.subId?.includes(":overall")?null:form.subId||null,content:values.content,owner:values.owner||"待分配",dueDate:values.dueDate||null,priority:Number(values.priority)||2})}),j=await r.json();if(!r.ok)throw new Error(j.error||"Todo 创建失败")}
    await refresh(undefined,true);notify(form.mode==="project"?"项目需求已创建":form.mode==="subrequirement"?"业务需求已创建":"Todo 已创建");
  }
  const projectTrees=useMemo(()=>data.projects.map((project,index)=>{const unscoped=project.unscopedTodos||[],fallback:SubRequirement={id:`${project.id}:overall`,title:project.config.phase||"整体推进",progress_summary:project.config.signal||project.summary||"等待同步进展",status:"in_progress",progress:project.progress||0,owner_name:project.owner_name||"待分配",priority:project.health==="blocked"?1:2,todos:unscoped};const raw=project.subrequirements?.length?project.subrequirements:unscoped.length?[fallback]:[],subrequirements=raw.map(sub=>({...sub,todos:(sub.todos||[]).filter(todo=>matchesStatus(todo,filter,sub.priority)&&matchesTime(todo,timeFilter))})).filter(sub=>(filter==="全部"&&timeFilter==="全部时间")||sub.todos.length);return{project,color:colorFor(project.id,index),subrequirements}}).filter(group=>(filter==="全部"&&timeFilter==="全部时间")||group.subrequirements.length),[data.projects,filter,timeFilter]);
  const allTodos=data.projects.flatMap(project=>[...(project.unscopedTodos||[]),...(project.subrequirements||[]).flatMap(sub=>sub.todos||[])]),totalTodos=allTodos.length,doneCount=allTodos.filter(todo=>todo.status==="done").length,attention=data.projects.filter(project=>project.health==="blocked"||project.health==="attention").length,today=new Date(),week=weekNumber(today);
  const timeline=useMemo(()=>{
    const fromPrompts:ChatEntry[]=(data.activityHistory||[]).map(item=>({id:item.id,kind:"prompt",title:item.input_text,body:item.output_markdown||item.error||"Agent 仍在处理中",source:item.source,status:item.error?"failed":item.status||"completed",created_at:item.created_at,urls:item.source_urls}));
    const fromReports:ChatEntry[]=(data.reports||[]).map(item=>({id:item.id,kind:"report",title:item.title,body:item.content,source:"weekly-report",status:"completed",created_at:item.created_at||""}));
    return[...fromPrompts,...fromReports].sort((a,b)=>new Date(b.created_at||0).getTime()-new Date(a.created_at||0).getTime());
  },[data.activityHistory,data.reports]);
  const activeEntry=timeline.find(entry=>entry.id===openEntry)||null;
  const quickActions:Array<{label:string;hint:string;run:()=>void}>=[
    {label:"生成本周周报",hint:"读取项目、文档与群聊证据",run:()=>void generateReport("本周项目周报",7)},
    {label:"整理今日待办",hint:"按项目拆成独立 Todo 写入看板",run:()=>void submit("请根据当前项目、已同步文档和群聊记录，整理今天最重要的行动项。按项目需求和子需求归类，把复合工作拆成独立 Todo，每条标注唯一负责人、优先级和截止时间，并通过 Task Service 写入任务看板。")},
    {label:"新建定时任务",hint:"填入模板后补充时间和内容",run:()=>{setInput("每天 09:00 私聊我一次当天的项目进度总结");notify("已填入模板，补充时间和内容后发送")}},
    {label:"项目进展速览",hint:"只读查询，不写入看板",run:()=>void submit("汇总当前所有项目的最新进展、阻塞点和下一步负责人，只做只读查询，不要写入任务看板。")},
  ];
  return <main className="reference-app">
    <header className="reference-header">
      <a className="product-title" href="/"><span className="product-mark"><i/></span><span><b>Pulse 工作台</b><small>对话式生成 · 项目与 Todo 管理</small></span></a>
      <span className="header-divider"/><nav className="segmented"><button className={view==="chat"?"active":""} onClick={()=>setView("chat")}>对话</button><button className={view==="board"?"active":""} onClick={()=>setView("board")}>项目管理</button></nav><div className="header-spacer"/>
      <select className="workspace-picker" value={workspaceId} onChange={event=>{setWorkspaceId(event.target.value);void refresh(event.target.value)}} aria-label="切换工作空间">{data.workspaces.map(space=><option key={space.id} value={space.id}>{space.name}</option>)}</select>
      <span className="date-label">{today.getFullYear()} 年 {today.getMonth()+1} 月 {today.getDate()} 日 · 第 {week} 周</span><a className="ghost-action" href="/control">管理中台</a><button className="ghost-action" onClick={()=>setShare(true)}>成员</button>
      {view==="board"&&<button className="primary-action" onClick={()=>setQuickForm({mode:"project"})}>＋ 新建项目需求</button>}
    </header>
    <section className="reference-body">{view==="chat"?<div className={sidebarOpen?"chat-shell":"chat-shell collapsed"}>
      <aside className="chat-sidebar">
        <div className="chat-sidebar-head"><button className="new-chat" onClick={()=>{setOpenEntry(null);setInput("")}}><i>＋</i>新对话</button><button className="sidebar-toggle" aria-label="收起历史" onClick={()=>setSidebarOpen(false)}>«</button></div>
        <div className="chat-history">{timeline.length?groupByDay(timeline).map(group=><div className="chat-history-group" key={group.label}><small>{group.label}</small>{group.entries.map(entry=><button key={entry.id} className={openEntry===entry.id?"chat-history-item active":"chat-history-item"} onClick={()=>setOpenEntry(entry.id)}><i className={entry.kind}>{entry.kind==="report"?"报":"问"}</i><span>{entry.title}</span></button>)}</div>):<p className="chat-history-empty">还没有对话记录</p>}</div>
        <div className="chat-sidebar-foot"><span><b>{totalTodos-doneCount}</b> 条待办进行中</span><button onClick={()=>setView("board")}>去项目管理 →</button></div>
      </aside>
      <section className="chat-panel">
        {!sidebarOpen&&<button className="sidebar-reopen" aria-label="展开历史" onClick={()=>setSidebarOpen(true)}>»</button>}
        {activeEntry?<div className="chat-thread">
          <header className="chat-thread-head"><div><b>{activeEntry.kind==="report"?activeEntry.title:sourceLabel(activeEntry.source)}</b><small>{timeAgo(activeEntry.created_at)}{activeEntry.status==="failed"?" · 处理失败":""}</small></div><button onClick={()=>{void navigator.clipboard.writeText(activeEntry.body);notify("内容已复制")}}>复制回复</button></header>
          {activeEntry.kind==="prompt"&&<div className="bubble-row user"><div className="bubble user">{activeEntry.title}</div></div>}
          <div className="bubble-row agent"><AgentAvatar/><div className="bubble agent">{!!activeEntry.urls?.length&&<div className="source-links">{activeEntry.urls.map(url=><a href={url} target="_blank" rel="noreferrer" key={url}>{url} ↗</a>)}</div>}<MarkdownContent content={activeEntry.body}/></div></div>
        </div>:<div className="chat-hero">
          <h1>今天需要我做什么？</h1>
          <p>生成周报、整理今日待办、创建定时任务，或者粘贴一个文档链接让我拆成项目和 Todo。</p>
          <div className="quick-actions hero">{quickActions.map(action=><button key={action.label} disabled={processing||reporting} onClick={action.run} title={action.hint}><b>{action.label}</b><small>{action.hint}</small></button>)}</div>
        </div>}
        {pendingText&&<div className="chat-thread pending"><div className="bubble-row user"><div className="bubble user">{pendingText}</div></div><div className="bubble-row agent"><AgentAvatar/><div className="bubble agent typing"><i/><i/><i/></div></div></div>}
        <div className="chat-composer">
          {activeEntry&&<div className="quick-actions compact">{quickActions.map(action=><button key={action.label} disabled={processing||reporting} onClick={action.run} title={action.hint}><b>{action.label}</b></button>)}</div>}
          <form className="todo-input" onSubmit={intake}><span className="empty-check"/><textarea rows={3} value={input} onChange={event=>setInput(event.target.value)} placeholder={'和 Agent 说话：生成周报、整理 Todo、创建定时任务，或粘贴文档链接\n例如：读取这个文档，并把 Austin 和 Alex 的任务分别拆成 Todo'} onKeyDown={event=>{if((event.metaKey||event.ctrlKey)&&event.key==="Enter")void submit(input)}}/><small>支持 Markdown、换行、链接与文字混合输入 · ⌘/Ctrl + Enter 发送</small><button disabled={!input.trim()||processing||reporting}>{processing||reporting?"处理中":"发送"}</button></form>
        </div>
      </section>
    </div>:<div className="todo-layout">
      <section className="todo-main">
        <div className="board-toolbar"><div><small>TASK BOARD</small><h2>项目任务看板</h2></div><div className="board-toolbar-actions"><button onClick={()=>setQuickForm({mode:"project"})}>＋ 手动新建项目</button><button className="primary-action" disabled={processing} onClick={()=>void submit("请根据当前项目、已同步文档和群聊记录，整理今天最重要的行动项。按项目需求和子需求归类，把复合工作拆成独立 Todo，每条标注唯一负责人、优先级和截止时间，并通过 Task Service 写入任务看板。")}>{processing?"正在整理…":"让 Agent 生成今日待办"}</button></div></div>
        <div className="filter-row"><div>{["全部","未完成","已完成","高优先级"].map(item=><button key={item} className={filter===item?"active":""} onClick={()=>setFilter(item)}>{item}</button>)}<select value={timeFilter} onChange={event=>setTimeFilter(event.target.value)} aria-label="按时间筛选 Todo"><option>全部时间</option><option>今天</option><option>未来 7 天</option><option>已逾期</option><option>无日期</option></select></div><span>已完成 {doneCount} / {totalTodos}</span></div>
        <section className="todo-list project-tree">{loading?<div className="empty-state">正在读取工作空间…</div>:error?<div className="empty-state error">{error}<button onClick={()=>void refresh()}>重新加载</button></div>:projectTrees.length?projectTrees.map(group=>{const projectOpen=expandedProjects[group.project.id]!==false;return <article className="project-node" key={group.project.id}><div className="node-head-row"><button className="project-node-head" onClick={()=>setExpandedProjects(current=>({...current,[group.project.id]:!projectOpen}))}><i style={{background:group.color}}/><span><small>项目需求</small><b>{group.project.name}</b><em>{group.project.summary||"等待项目需求说明"}</em></span><strong>{group.project.progress||0}%</strong><span className={`tree-health ${group.project.health}`}>{healthLabel(group.project.health)}</span><span className={projectOpen?"tree-chevron open":"tree-chevron"}>⌄</span></button><span className="node-actions"><button onClick={()=>setQuickForm({mode:"subrequirement",projectId:group.project.id,projectName:group.project.name})}>＋ 业务需求</button><button onClick={()=>setSelected(group.project)}>详情</button><button className="danger" onClick={()=>void removeProject(group.project)}>删除</button></span></div>{projectOpen&&<div className="subrequirement-list">{group.subrequirements.length?group.subrequirements.map(sub=>{const subOpen=expandedSubs[sub.id]!==false,complete=sub.todos.filter(todo=>todo.status==="done").length,generated=sub.id.includes(":overall");return <section className="subrequirement" key={sub.id}><div className="node-head-row"><button className="subrequirement-head" onClick={()=>setExpandedSubs(current=>({...current,[sub.id]:!subOpen}))}><span className="tree-branch">└</span><span><small>业务需求 · {complete}/{sub.todos.length} 完成</small><b>{sub.title}</b><em>{sub.progress_summary||"等待同步进展"}</em></span><strong>{sub.progress||0}%</strong><span className={subOpen?"tree-chevron open":"tree-chevron"}>⌄</span></button><span className="node-actions"><button onClick={()=>setQuickForm({mode:"todo",projectId:group.project.id,projectName:group.project.name,subId:sub.id,subTitle:sub.title})}>＋ Todo</button>{!generated&&<button className="danger" onClick={()=>void removeSubrequirement(sub)}>删除</button>}</span></div>{subOpen&&<div className="sub-todos">{sub.todos.length?sub.todos.map(todo=><div className={todo.status==="done"?"todo-row done":"todo-row"} key={todo.id}><button className="todo-complete" aria-label={todo.status==="done"?"标记为未完成":"标记为完成"} onClick={()=>void changeTodo(todo,todo.status==="done"?"open":"done")}><span className="round-check"><i/></span></button><span className="todo-level">核心 Todo</span><b>{todo.content}</b><em>@{shortName(todo.owner_name||"待分配")}</em><span className={`priority priority-${todo.priority||sub.priority||2}`}>{priorityLabel(todo.priority||sub.priority||2)}</span><time>{formatDue(todo.due_date||"待确认")}</time><button className="todo-delete" aria-label="删除 Todo" onClick={()=>void removeTodo(todo)}>删除</button></div>):<div className="sub-empty">该业务需求尚未提炼核心 Todo</div>}<button className="inline-add" onClick={()=>setQuickForm({mode:"todo",projectId:group.project.id,projectName:group.project.name,subId:sub.id,subTitle:sub.title})}>＋ 手动添加 Todo</button></div>}</section>}):<div className="sub-empty">该项目尚未形成业务需求和 Todo</div>}<button className="inline-add sub-level" onClick={()=>setQuickForm({mode:"subrequirement",projectId:group.project.id,projectName:group.project.name})}>＋ 手动添加业务需求</button></div>}</article>}):<div className="empty-state">当前筛选条件下没有 Todo。让 Agent 生成今日待办，或者手动新建一个项目需求。<button onClick={()=>setQuickForm({mode:"project"})}>＋ 手动新建项目</button></div>}</section>
      </section>
      <aside className="today-aside"><section className="side-card"><h2>今日节奏</h2><div className="stat-grid"><Stat label="今日完成" value={`${doneCount} / ${totalTodos}`} color="#34c759"/><Stat label="进行中项目" value={String(data.projects.length)} color="#0071e3"/><Stat label="需要关注" value={String(attention)} color="#ff3b30"/><Stat label="已接入资料" value={String(data.assets.length)} color="#af52de"/></div></section>
        <section className="side-card project-progress"><h2>项目进度</h2>{data.projects.slice(0,5).map((project,index)=>{const color=colorFor(project.id,index);return <button key={project.id} onClick={()=>setSelected(project)}><div><b>{project.name}</b><em className={project.health}>{healthLabel(project.health)}</em></div><span><i style={{width:`${Math.max(4,Number(project.progress||0))}%`,background:color}}/></span><small>{project.owner_name||"待分配"} · {project.target_date?formatDue(project.target_date):"时间待确认"}<em>{project.progress||0}%</em></small></button>})}</section>
        <section className="side-card recent-material"><h2>最近接入</h2>{data.assets.slice(0,4).map(asset=><a key={asset.id} href={asset.url} target="_blank" rel="noreferrer"><i>文</i><span><b>{asset.title}</b><small>{asset.project_name||"等待归类"} · {timeAgo(asset.updated_at)}</small></span><em>↗</em></a>)}{!data.assets.length&&<p>飞书 Bot 读取的文档会出现在这里。</p>}</section>
      </aside>
    </div>}</section>
    {selected&&<ProjectDrawer project={selected} updates={data.updates.filter(item=>item.project_id===selected.id)} assets={data.assets.filter(item=>item.project_id===selected.id)} close={()=>setSelected(null)} remove={()=>void removeProject(selected)}/>} {share&&<ShareDialog data={data} close={()=>setShare(false)} act={workspaceAction}/>} {quickForm&&<QuickFormDialog form={quickForm} close={()=>setQuickForm(null)} submit={submitQuickForm}/>} {toast&&<div className="toast">✓ {toast}</div>}
  </main>
}

// Markdown 渲染只输出 React 元素，不使用 dangerouslySetInnerHTML：
// 模型输出与文档正文都是不可信内容，构造上就不给 XSS 留入口。
type MdBlock={kind:"heading";level:number;text:string}|{kind:"code";lang:string;code:string}|{kind:"table";head:string[];rows:string[][]}|{kind:"list";ordered:boolean;items:Array<{depth:number;text:string;marker:string}>}|{kind:"quote";lines:string[]}|{kind:"hr"}|{kind:"para";lines:string[]};
function parseMarkdown(source:string):MdBlock[]{
  const lines=String(source||"").replace(/\r/g,"").split("\n"),blocks:MdBlock[]=[];
  for(let i=0;i<lines.length;i++){
    const line=lines[i],trimmed=line.trim();
    const fence=trimmed.match(/^```+\s*(\S*)/);
    if(fence){const code:string[]=[];i++;while(i<lines.length&&!/^```/.test(lines[i].trim())){code.push(lines[i]);i++}blocks.push({kind:"code",lang:fence[1]||"",code:code.join("\n")});continue}
    if(!trimmed)continue;
    if(/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)){blocks.push({kind:"hr"});continue}
    const heading=trimmed.match(/^(#{1,6})\s+(.+)$/);
    if(heading){blocks.push({kind:"heading",level:heading[1].length,text:heading[2]});continue}
    // 表格：当前行是 | a | b |，下一行是分隔行
    if(/^\|.*\|$/.test(trimmed)&&i+1<lines.length&&/^\|[\s:|-]+\|$/.test(lines[i+1].trim())){
      const cells=(row:string)=>row.trim().replace(/^\||\|$/g,"").split("|").map(cell=>cell.trim());
      const head=cells(trimmed),rows:string[][]=[];i+=2;
      while(i<lines.length&&/^\|.*\|$/.test(lines[i].trim())){rows.push(cells(lines[i]));i++}
      i--;blocks.push({kind:"table",head,rows});continue;
    }
    const listItem=(row:string)=>{const bullet=row.match(/^(\s*)[-*+]\s+(.+)$/);if(bullet)return{depth:Math.floor(bullet[1].length/2),text:bullet[2],marker:"•",ordered:false};const ordered=row.match(/^(\s*)(\d+)[.)]\s+(.+)$/);return ordered?{depth:Math.floor(ordered[1].length/2),text:ordered[3],marker:`${ordered[2]}.`,ordered:true}:null};
    const first=listItem(line);
    if(first){const items=[first];let ordered=first.ordered;i++;while(i<lines.length){const next=listItem(lines[i]);if(!next)break;items.push(next);ordered=ordered||next.ordered;i++}i--;blocks.push({kind:"list",ordered,items:items.map(({depth,text,marker})=>({depth,text,marker}))});continue}
    if(/^>\s?/.test(trimmed)){const quote:string[]=[];while(i<lines.length&&/^>\s?/.test(lines[i].trim())){quote.push(lines[i].trim().replace(/^>\s?/,""));i++}i--;blocks.push({kind:"quote",lines:quote});continue}
    const para=[trimmed];i++;
    while(i<lines.length&&lines[i].trim()&&!/^(#{1,6}\s|>|```|\||\s*[-*+]\s|\s*\d+[.)]\s)/.test(lines[i])&&!/^(-{3,}|\*{3,})$/.test(lines[i].trim())){para.push(lines[i].trim());i++}
    i--;blocks.push({kind:"para",lines:para});
  }
  return blocks;
}
function MarkdownContent({content}:{content:string}){
  return <div className="markdown-content">{parseMarkdown(content).map((block,index)=>{
    if(block.kind==="hr")return <hr key={index}/>;
    if(block.kind==="heading"){const Tag=(block.level<=1?"h3":block.level===2?"h4":"h5") as "h3"|"h4"|"h5";return <Tag key={index}><InlineMarkdown text={block.text}/></Tag>}
    if(block.kind==="code")return <pre className="md-code" key={index}>{block.lang&&<em>{block.lang}</em>}<code>{block.code}</code></pre>;
    if(block.kind==="table")return <div className="md-table-wrap" key={index}><table className="md-table"><thead><tr>{block.head.map((cell,cellIndex)=><th key={cellIndex}><InlineMarkdown text={cell}/></th>)}</tr></thead><tbody>{block.rows.map((row,rowIndex)=><tr key={rowIndex}>{row.map((cell,cellIndex)=><td key={cellIndex}><InlineMarkdown text={cell}/></td>)}</tr>)}</tbody></table></div>;
    if(block.kind==="quote")return <blockquote key={index}>{block.lines.map((line,lineIndex)=><p key={lineIndex}><InlineMarkdown text={line}/></p>)}</blockquote>;
    if(block.kind==="list")return <ul className={block.ordered?"md-list ordered":"md-list"} key={index}>{block.items.map((item,itemIndex)=><li key={itemIndex} style={item.depth?{paddingLeft:`${Math.min(item.depth,4)*16}px`}:undefined}><i>{item.marker}</i><span><InlineMarkdown text={item.text}/></span></li>)}</ul>;
    return <p key={index}>{block.lines.map((line,lineIndex)=><span key={lineIndex}>{lineIndex>0&&<br/>}<InlineMarkdown text={line}/></span>)}</p>;
  })}</div>
}
function InlineMarkdown({text}:{text:string}){const pattern=/(\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|\*\*([^*]+)\*\*|~~([^~]+)~~|(?<![\w*])\*([^*\n]+)\*(?![\w*])|`([^`]+)`|(https?:\/\/[^\s<>()]+))/g,nodes:Array<string|React.ReactElement>=[],source=String(text);let cursor=0,match:RegExpExecArray|null;while((match=pattern.exec(source))){if(match.index>cursor)nodes.push(source.slice(cursor,match.index));if(match[2]&&match[3])nodes.push(<a key={`${match.index}-link`} href={match[3]} target="_blank" rel="noreferrer">{match[2]}</a>);else if(match[4])nodes.push(<strong key={`${match.index}-strong`}>{match[4]}</strong>);else if(match[5])nodes.push(<del key={`${match.index}-del`}>{match[5]}</del>);else if(match[6])nodes.push(<em key={`${match.index}-em`}>{match[6]}</em>);else if(match[7])nodes.push(<code key={`${match.index}-code`}>{match[7]}</code>);else if(match[8])nodes.push(<a key={`${match.index}-url`} href={match[8]} target="_blank" rel="noreferrer">{match[8]}</a>);cursor=pattern.lastIndex;}if(cursor<source.length)nodes.push(source.slice(cursor));return <>{nodes}</>}
function AgentAvatar(){const[failed,setFailed]=useState(false);return failed?<span className="chat-avatar agent">A</span>:// eslint-disable-next-line @next/next/no-img-element -- 32px 本地头像，next/image 的优化对它没有意义
  <img className="chat-avatar agent-image" src="/agent-avatar.png" alt="Pulse Agent" onError={()=>setFailed(true)}/>}
function matchesStatus(todo:Todo,filter:string,subPriority:number){if(filter==="未完成")return todo.status!=="done";if(filter==="已完成")return todo.status==="done";if(filter==="高优先级")return Number(todo.priority||subPriority||2)===1;return true}
function matchesTime(todo:Todo,filter:string){if(filter==="全部时间")return true;if(!todo.due_date)return filter==="无日期";const due=new Date(todo.due_date);if(Number.isNaN(due.getTime()))return filter==="无日期";const start=new Date();start.setHours(0,0,0,0);const end=new Date(start);end.setDate(end.getDate()+1);if(filter==="今天")return due>=start&&due<end;if(filter==="未来 7 天"){const week=new Date(start);week.setDate(week.getDate()+7);return due>=start&&due<week}if(filter==="已逾期")return due<start&&todo.status!=="done";return false}
function groupByDay(entries:ChatEntry[]){
  const start=new Date();start.setHours(0,0,0,0);
  const yesterday=new Date(start);yesterday.setDate(yesterday.getDate()-1);
  const week=new Date(start);week.setDate(week.getDate()-7);
  const buckets:Array<{label:string;entries:ChatEntry[]}>=[{label:"今天",entries:[]},{label:"昨天",entries:[]},{label:"最近 7 天",entries:[]},{label:"更早",entries:[]}];
  for(const entry of entries){
    const at=new Date(entry.created_at||0),time=at.getTime();
    const index=Number.isNaN(time)?3:time>=start.getTime()?0:time>=yesterday.getTime()?1:time>=week.getTime()?2:3;
    buckets[index].entries.push(entry);
  }
  return buckets.filter(bucket=>bucket.entries.length);
}
function sourceLabel(source:string){return source==="web-document"?"文档接入":source==="web-prompt"?"用户需求":source.includes("group")?"群聊同步":"Agent 处理"}
function priorityLabel(value:number){return Number(value)===1?"高":Number(value)===3?"低":"中"}
function Stat({label,value,color}:{label:string;value:string;color:string}){return <div><span><i style={{background:color}}/>{label}</span><b>{value}</b></div>}
const quickFormFields:Record<QuickForm["mode"],Array<{key:string;label:string;placeholder:string;required?:boolean;type?:string}>>={
  project:[{key:"name",label:"项目名称",placeholder:"例如：Pulse 个人 Agent 云端部署",required:true},{key:"summary",label:"项目需求说明",placeholder:"这个项目要交付什么"},{key:"owner",label:"负责人",placeholder:"留空则记为待分配"}],
  subrequirement:[{key:"title",label:"业务需求标题",placeholder:"可独立推进和验收的一件事",required:true},{key:"progressSummary",label:"当前进展",placeholder:"留空则记为待同步进展"},{key:"owner",label:"负责人",placeholder:"留空则记为待分配"}],
  todo:[{key:"content",label:"Todo 内容",placeholder:"一个动作、一个交付结果",required:true},{key:"owner",label:"负责人",placeholder:"留空则记为待分配"},{key:"dueDate",label:"截止日期",placeholder:"YYYY-MM-DD",type:"date"},{key:"priority",label:"优先级",placeholder:"1 高 / 2 中 / 3 低",type:"priority"}],
};
function QuickFormDialog({form,close,submit}:{form:QuickForm;close:()=>void;submit:(form:QuickForm,values:Record<string,string>)=>Promise<void>}){
  const fields=quickFormFields[form.mode],[values,setValues]=useState<Record<string,string>>({priority:"2"}),[busy,setBusy]=useState(false),[error,setError]=useState("");
  const title=form.mode==="project"?"新建项目需求":form.mode==="subrequirement"?"新建业务需求":"新建 Todo";
  const scope=form.mode==="subrequirement"?`归属项目：${form.projectName}`:form.mode==="todo"?`归属：${form.projectName} · ${form.subTitle}`:"新的项目需求会直接进入任务看板";
  const missing=fields.some(field=>field.required&&!String(values[field.key]||"").trim());
  async function run(){setBusy(true);setError("");try{await submit(form,values);close()}catch(e){setError(e instanceof Error?e.message:"保存失败")}finally{setBusy(false)}}
  return <div className="overlay modal-overlay" onMouseDown={event=>{if(event.target===event.currentTarget)close()}}><div className="modal quick-form-modal"><header><div><small>手动录入</small><h2>{title}</h2></div><button onClick={close}>×</button></header><p className="quick-form-scope">{scope}</p>
    {fields.map(field=><label key={field.key}>{field.label}{field.required?<em> *</em>:null}
      {field.type==="priority"?<select value={values[field.key]||"2"} onChange={event=>setValues(current=>({...current,[field.key]:event.target.value}))}><option value="1">高</option><option value="2">中</option><option value="3">低</option></select>
      :<input type={field.type==="date"?"date":"text"} value={values[field.key]||""} placeholder={field.placeholder} onChange={event=>setValues(current=>({...current,[field.key]:event.target.value}))} onKeyDown={event=>{if(event.key==="Enter"&&!missing&&!busy)void run()}}/>}
    </label>)}
    {error&&<p className="dialog-error">{error}</p>}
    <div className="quick-form-actions"><button onClick={close}>取消</button><button className="primary-action" disabled={busy||missing} onClick={()=>void run()}>{busy?"保存中…":"保存"}</button></div>
  </div></div>
}
function ProjectDrawer({project,updates,assets,close,remove}:{project:Project;updates:Update[];assets:Asset[];close:()=>void;remove:()=>void}){return <div className="overlay" onMouseDown={event=>{if(event.target===event.currentTarget)close()}}><aside className="drawer"><header><div><small>项目需求</small><h2>{project.name}</h2></div><button className="drawer-project-delete" onClick={remove}>删除项目</button><button onClick={close}>×</button></header><section className="drawer-focus"><div><small>需求定义</small><p>{project.summary||"等待补充项目需求"}</p></div></section><section><h3>子需求、进展与核心 Todo</h3>{project.subrequirements?.length?project.subrequirements.map(sub=><details className="drawer-subrequirement" key={sub.id} open><summary><span><b>{sub.title}</b><small>{sub.progress||0}% · @{shortName(sub.owner_name||"待分配")}</small></span><em>展开</em></summary><p>{sub.progress_summary||"等待同步进展"}</p>{sub.todos?.length?sub.todos.map(todo=><div className="drawer-todo" key={todo.id}><i/><span><b>{todo.content}</b><small>@{shortName(todo.owner_name||"待分配")} · {formatDue(todo.due_date||"待确认")}</small></span></div>):<p className="muted">尚未提炼核心 Todo</p>}</details>):<p className="muted">旧项目将在下一次同步时自动生成“整体推进”子需求。</p>}</section><section><h3>最近变化</h3>{updates.slice(0,6).map(update=><div className="history-item" key={update.id}><i>{initials(update.author_name||"P")}</i><span><b>{update.summary}</b><small>{update.author_name||"Pulse Agent"} · {timeAgo(update.created_at)}</small></span></div>)}{!updates.length&&<p className="muted">暂无进展记录</p>}</section><section><h3>证据文档</h3>{assets.map(asset=><a className="asset-item" href={asset.url} target="_blank" rel="noreferrer" key={asset.id}><span>文</span><div><b>{asset.title}</b><small>{asset.metadata?.excerpt||"已保存原始链接"}</small></div><em>↗</em></a>)}{!assets.length&&<p className="muted">下一次提交文档后自动关联</p>}</section></aside></div>}
function ShareDialog({data,close,act}:{data:Workspace;close:()=>void;act:(action:"invite"|"create",value:string)=>Promise<void>}){const[email,setEmail]=useState(""),[name,setName]=useState(""),[busy,setBusy]=useState(false),[error,setError]=useState("");async function run(action:"invite"|"create",value:string){setBusy(true);setError("");try{await act(action,value);if(action==="invite")setEmail("");else close()}catch(e){setError(e instanceof Error?e.message:"操作失败")}finally{setBusy(false)}}return <div className="overlay modal-overlay"><div className="modal share-modal"><header><div><small>工作空间</small><h2>成员与空间</h2></div><button onClick={close}>×</button></header><p>成员共享当前空间的数据，每次同步仍记录实际操作者。</p><label>邀请成员<div><input value={email} onChange={event=>setEmail(event.target.value)} placeholder="同事邮箱"/><button disabled={busy||!email} onClick={()=>void run("invite",email)}>发送邀请</button></div></label>{error&&<p className="dialog-error">{error}</p>}<div className="member-list">{data.members.map(member=><div key={member.id}><i>{initials(member.display_name)}</i><span><b>{member.display_name}</b><small>{member.email}</small></span><em>{member.role==="admin"?"管理员":"成员"}</em></div>)}</div><label>创建独立工作空间<div><input value={name} onChange={event=>setName(event.target.value)} placeholder="空间名称"/><button disabled={busy||!name} onClick={()=>void run("create",name)}>创建</button></div></label></div></div>}
function colorFor(id:string,index:number){let hash=index;for(const char of id)hash=(hash+char.charCodeAt(0))%colors.length;return colors[hash%colors.length]}
function healthLabel(value:string){return value==="blocked"?"阻塞":value==="attention"?"风险":"进行中"}
function initials(value:string){return value.trim().split(/\s+/).map(item=>item[0]).join("").slice(0,2).toUpperCase()||"P"}
function shortName(value:string){return value.trim().split(/\s+/)[0]||value}
function formatDue(value:string){if(!value)return"待确认";const date=new Date(value);return Number.isNaN(date.getTime())?value:date.toLocaleDateString("zh-CN",{month:"numeric",day:"numeric"})}
function timeAgo(value:string){if(!value)return"刚刚";const hours=Math.max(0,Math.floor((Date.now()-new Date(value).getTime())/36e5));if(hours<1)return"刚刚";if(hours<24)return`${hours} 小时前`;const days=Math.floor(hours/24);return days<7?`${days} 天前`:formatDue(value)}
function weekNumber(date:Date){const target=new Date(Date.UTC(date.getFullYear(),date.getMonth(),date.getDate())),day=target.getUTCDay()||7;target.setUTCDate(target.getUTCDate()+4-day);const start=new Date(Date.UTC(target.getUTCFullYear(),0,1));return Math.ceil((((target.getTime()-start.getTime())/86400000)+1)/7)}

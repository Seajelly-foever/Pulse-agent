import { env } from "cloudflare:workers";
import { cleanStructuredText } from "../shared/text-cleaning.mjs";

type Db = D1Database;

const now = () => new Date().toISOString();
const id = (prefix: string) => `${prefix}_${crypto.randomUUID()}`;

export function getDb(): Db {
  if (!env.DB) throw new Error("Database binding DB is unavailable");
  return env.DB;
}

export async function ensureWorkspace() {
  const db = getDb();
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY NOT NULL, email TEXT NOT NULL, display_name TEXT NOT NULL,
      avatar_url TEXT, feishu_open_id TEXT, role TEXT NOT NULL DEFAULT 'member',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, slug TEXT NOT NULL,
      created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      FOREIGN KEY(created_by) REFERENCES users(id)
    )`),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_slug ON workspaces(slug)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS workspace_members (
      workspace_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id), FOREIGN KEY(user_id) REFERENCES users(id)
    )`),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_members_unique ON workspace_members(workspace_id,user_id)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS workspace_invites (
      id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT NOT NULL, email TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member', status TEXT NOT NULL DEFAULT 'pending', invited_by TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id), FOREIGN KEY(invited_by) REFERENCES users(id)
    )`),
    db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_invites_unique ON workspace_invites(workspace_id,email)"),
    db.prepare(`CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT, name TEXT NOT NULL, summary TEXT,
      status TEXT NOT NULL DEFAULT 'active', health TEXT NOT NULL DEFAULT 'healthy',
      progress INTEGER NOT NULL DEFAULT 0, owner_id TEXT, expected_outcome TEXT,
      target_date TEXT, config_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT,
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id), FOREIGN KEY(owner_id) REFERENCES users(id)
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS project_updates (
      id TEXT PRIMARY KEY NOT NULL, project_id TEXT NOT NULL, author_id TEXT,
      source TEXT NOT NULL DEFAULT 'web', raw_content TEXT, summary TEXT NOT NULL,
      progress_delta INTEGER DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      FOREIGN KEY(project_id) REFERENCES projects(id), FOREIGN KEY(author_id) REFERENCES users(id)
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS project_subrequirements (
      id TEXT PRIMARY KEY NOT NULL, project_id TEXT NOT NULL, title TEXT NOT NULL,
      progress_summary TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'in_progress',
      progress INTEGER NOT NULL DEFAULT 0, owner_name TEXT, priority INTEGER NOT NULL DEFAULT 2,
      position INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      FOREIGN KEY(project_id) REFERENCES projects(id)
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS todos (
      id TEXT PRIMARY KEY NOT NULL, project_id TEXT NOT NULL, sub_requirement_id TEXT,
      content TEXT NOT NULL, owner_name TEXT NOT NULL DEFAULT '待分配', status TEXT NOT NULL DEFAULT 'open',
      priority INTEGER NOT NULL DEFAULT 2, due_date TEXT, source_message_id TEXT, completed_at TEXT, deleted_at TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      FOREIGN KEY(project_id) REFERENCES projects(id), FOREIGN KEY(sub_requirement_id) REFERENCES project_subrequirements(id)
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS agent_interactions (
      id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT NOT NULL, source TEXT NOT NULL,
      input_text TEXT NOT NULL, source_urls_json TEXT NOT NULL DEFAULT '[]', output_markdown TEXT,
      status TEXT NOT NULL DEFAULT 'completed', project_id TEXT, error TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id), FOREIGN KEY(project_id) REFERENCES projects(id)
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS assets (
      id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT, project_id TEXT, title TEXT NOT NULL, url TEXT NOT NULL,
      kind TEXT NOT NULL, created_by TEXT, metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id), FOREIGN KEY(project_id) REFERENCES projects(id), FOREIGN KEY(created_by) REFERENCES users(id)
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS reports (
      id TEXT PRIMARY KEY NOT NULL, workspace_id TEXT, type TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL,
      scope_json TEXT NOT NULL DEFAULT '{}', generated_by TEXT, model TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id), FOREIGN KEY(generated_by) REFERENCES users(id)
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS integration_events (
      id TEXT PRIMARY KEY NOT NULL, provider TEXT NOT NULL, event_type TEXT NOT NULL,
      status TEXT NOT NULL, detail TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_projects_updated_at ON projects(updated_at DESC)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_updates_project_created ON project_updates(project_id, created_at DESC)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_subrequirements_project ON project_subrequirements(project_id,position)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_todos_project_status ON todos(project_id,status,deleted_at,due_date)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_interactions_workspace_created ON agent_interactions(workspace_id,created_at DESC)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_assets_project_created ON assets(project_id, created_at DESC)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_integration_events_created ON integration_events(created_at DESC)"),
  ]);

  const created = now();
  await db.prepare("INSERT OR IGNORE INTO workspaces (id,name,slug,created_at,updated_at) VALUES (?,?,?,?,?)")
    .bind("workspace_pulse","Pulse Workspace","pulse",created,created).run();
  await ensureColumn(db,"projects","workspace_id","TEXT");
  await ensureColumn(db,"projects","deleted_at","TEXT");
  await ensureColumn(db,"assets","workspace_id","TEXT");
  await ensureColumn(db,"reports","workspace_id","TEXT");
  await db.batch([
    db.prepare("UPDATE projects SET workspace_id='workspace_pulse' WHERE workspace_id IS NULL"),
    db.prepare("UPDATE assets SET workspace_id='workspace_pulse' WHERE workspace_id IS NULL"),
    db.prepare("UPDATE reports SET workspace_id='workspace_pulse' WHERE workspace_id IS NULL"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_projects_workspace_updated ON projects(workspace_id,updated_at DESC)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_projects_workspace_active ON projects(workspace_id,deleted_at,updated_at DESC)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_assets_workspace_updated ON assets(workspace_id,updated_at DESC)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_reports_workspace_created ON reports(workspace_id,created_at DESC)"),
  ]);

  const count = await db.prepare("SELECT COUNT(*) AS count FROM projects").first<{ count: number }>();
  if ((count?.count ?? 0) > 0) return;
  const people = [
    ["user_alice", "alice@pulse.local", "Alice"],
    ["user_bob", "bob@pulse.local", "Bob"],
    ["user_carol", "carol@pulse.local", "Carol"],
    ["user_david", "david@pulse.local", "David"],
  ];
  await db.batch(people.map(([uid,email,name]) => db.prepare(
    "INSERT INTO users (id,email,display_name,role,created_at,updated_at) VALUES (?,?,?,?,?,?)"
  ).bind(uid,email,name,"member",created,created)));

  const projects = [
    ["workspace-search","工作区搜索升级","统一检索项目、文档和历史记录","ontrack",72,"user_alice","缩短信息查找路径","2026-10-15",{group:"知识管理",phase:"灰度验证",next:"整理验证结果",signal:"核心检索链路已接通"}],
    ["weekly-report","自动周报生成","从可追溯事实生成结构化周报","ontrack",68,"user_bob","稳定输出可复用周报","2026-10-20",{group:"汇报效率",phase:"内部测试",next:"补充质量评测",signal:"基础模板已可用",partner:"Carol"}],
    ["memory-system","分层记忆系统","区分会话记忆、长期偏好与项目知识","attention",44,"user_carol","提高跨会话上下文准确性","2026-10-30",{group:"Agent 基础设施",phase:"边界评审",next:"完善召回评测",signal:"记忆作用域仍需验证"}],
    ["channel-adapter","多渠道通信适配","通过统一接口连接不同消息渠道","blocked",29,"user_david","稳定处理消息接收与回复","2026-11-05",{group:"通信层",phase:"环境配置",next:"完成端到端联调",signal:"等待渠道凭证"}],
  ];
  await db.batch(projects.map(([pid,name,summary,health,progress,owner,outcome,target,config]) => db.prepare(
    "INSERT INTO projects (id,workspace_id,name,summary,status,health,progress,owner_id,expected_outcome,target_date,config_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)"
  ).bind(pid,"workspace_pulse",name,summary,"active",health,progress,owner,outcome,target,JSON.stringify(config),created,created)));

  const seedUpdates = [
    ["channel-adapter","user_david","等待渠道凭证，联调窗口存在后移风险",0],
    ["workspace-search","user_alice","检索链路进入验证阶段，开始收集失败样本",8],
    ["weekly-report","user_bob","基础模板已完成，开始补充事实一致性评测",6],
    ["memory-system","user_carol","记忆边界已完成初审，继续验证召回准确率",5],
  ];
  await db.batch(seedUpdates.map(([pid,uid,summary,delta]) => db.prepare(
    "INSERT INTO project_updates (id,project_id,author_id,source,summary,progress_delta,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)"
  ).bind(id("upd"),pid,uid,"seed",summary,delta,created,created)));

  const seedAssets = [
    ["doc_progress",null,"项目进展示例文档","https://example.com/docs/project-progress","项目进展"],
    ["doc_weekly_report","weekly-report","周报生成方案示例","https://example.com/docs/weekly-report","产品方案"],
    ["doc_memory","memory-system","记忆召回评测示例","https://example.com/docs/memory-evaluation","实验文档"],
  ];
  await db.batch(seedAssets.map(([aid,pid,title,url,kind]) => db.prepare(
    "INSERT INTO assets (id,workspace_id,project_id,title,url,kind,metadata_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)"
  ).bind(aid,"workspace_pulse",pid,title,url,kind,JSON.stringify({source:"seed",sync_status:"waiting",excerpt:"等待 Bot 获得文档权限后抽取正文"}),created,created)));
}

async function ensureColumn(db:Db,table:string,column:string,definition:string){
  const info=await db.prepare(`PRAGMA table_info(${table})`).all<{name:string}>();
  if(!info.results.some(row=>row.name===column)) await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
}

export async function upsertActor(request: Request) {
  const userId = request.headers.get("oai-authenticated-user-id") || "local-user";
  const email = request.headers.get("oai-authenticated-user-email") || "local@pulse.dev";
  const encodedName = request.headers.get("oai-authenticated-user-full-name");
  const name = encodedName ? safeDecode(encodedName) : email.split("@")[0];
  const db = getDb(); const timestamp = now();
  await db.prepare(`INSERT INTO users (id,email,display_name,role,created_at,updated_at)
    VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET email=excluded.email,display_name=excluded.display_name,updated_at=excluded.updated_at`)
    .bind(userId,email,name,"admin",timestamp,timestamp).run();
  return { id:userId,email,name };
}

function safeDecode(value:string){try{return decodeURIComponent(value)}catch{return value}}
function parseConfig(value:unknown){try{return JSON.parse(String(value||"{}"))}catch{return {}}}

export async function workspaceContext(request?:Request){
  await ensureWorkspace(); const db=getDb();
  if(!request) return {workspace:{id:"workspace_pulse",name:"Pulse Workspace",slug:"pulse",role:"admin"},actor:null};
  const actor=await upsertActor(request); const requested=request.headers.get("x-pulse-workspace-id");
  const invite=await db.prepare("SELECT * FROM workspace_invites WHERE lower(email)=lower(?) AND status='pending' ORDER BY created_at LIMIT 1").bind(actor.email).first<any>();
  if(invite){const timestamp=now();await db.batch([db.prepare("INSERT OR IGNORE INTO workspace_members (workspace_id,user_id,role,created_at,updated_at) VALUES (?,?,?,?,?)").bind(invite.workspace_id,actor.id,invite.role,timestamp,timestamp),db.prepare("UPDATE workspace_invites SET status='accepted',updated_at=? WHERE id=?").bind(timestamp,invite.id)]);}
  let membership=requested?await db.prepare(`SELECT w.*,wm.role FROM workspace_members wm JOIN workspaces w ON w.id=wm.workspace_id WHERE wm.user_id=? AND w.id=? LIMIT 1`).bind(actor.id,requested).first<any>():null;
  if(!membership) membership=await db.prepare(`SELECT w.*,wm.role FROM workspace_members wm JOIN workspaces w ON w.id=wm.workspace_id WHERE wm.user_id=? ORDER BY wm.created_at LIMIT 1`).bind(actor.id).first<any>();
  if(!membership){
    const memberCount=await db.prepare("SELECT COUNT(*) AS count FROM workspace_members WHERE workspace_id='workspace_pulse'").first<{count:number}>();
    const timestamp=now(); const workspaceId=(memberCount?.count??0)===0?"workspace_pulse":id("ws");
    if(workspaceId!=="workspace_pulse") await db.prepare("INSERT INTO workspaces (id,name,slug,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?)").bind(workspaceId,`${actor.name} 的空间`,`${actor.id.replace(/[^a-zA-Z0-9]+/g,"-").slice(0,24)}-${crypto.randomUUID().slice(0,6)}`,actor.id,timestamp,timestamp).run();
    await db.prepare("INSERT OR IGNORE INTO workspace_members (workspace_id,user_id,role,created_at,updated_at) VALUES (?,?,?,?,?)").bind(workspaceId,actor.id,"admin",timestamp,timestamp).run();
    membership=await db.prepare("SELECT w.*,'admin' AS role FROM workspaces w WHERE id=?").bind(workspaceId).first<any>();
  }
  return {workspace:membership,actor};
}

export async function createWorkspace(request:Request,name:string){
  await ensureWorkspace(); const db=getDb(); const actor=await upsertActor(request); const timestamp=now(); const workspaceId=id("ws");
  const slug=`${name.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g,"-").replace(/^-|-$/g,"").slice(0,24)||"workspace"}-${crypto.randomUUID().slice(0,6)}`;
  await db.batch([db.prepare("INSERT INTO workspaces (id,name,slug,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?)").bind(workspaceId,name,slug,actor.id,timestamp,timestamp),db.prepare("INSERT INTO workspace_members (workspace_id,user_id,role,created_at,updated_at) VALUES (?,?,?,?,?)").bind(workspaceId,actor.id,"admin",timestamp,timestamp)]);
  return {id:workspaceId,name,slug,role:"admin"};
}

export async function inviteWorkspaceMember(request:Request,email:string){
  const {workspace,actor}=await workspaceContext(request); if(workspace.role!=="admin") throw new Error("只有空间管理员可以邀请成员");
  const db=getDb(); const timestamp=now(); const inviteId=id("inv");
  await db.prepare(`INSERT INTO workspace_invites (id,workspace_id,email,role,status,invited_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(workspace_id,email) DO UPDATE SET status='pending',invited_by=excluded.invited_by,updated_at=excluded.updated_at`)
    .bind(inviteId,workspace.id,email,"member","pending",actor?.id,timestamp,timestamp).run();
  return {ok:true,email};
}

export async function readWorkspace(request?:Request) {
  const {workspace,actor}=await workspaceContext(request); const db=getDb(); const workspaceId=workspace.id;
  const [projectRows, updateRows, assetRows, reportRows, subRequirementRows, todoRows, interactionRows] = await Promise.all([
    db.prepare(`SELECT p.*, u.display_name AS owner_name FROM projects p LEFT JOIN users u ON p.owner_id=u.id WHERE p.workspace_id=? AND p.deleted_at IS NULL ORDER BY p.updated_at DESC`).bind(workspaceId).all(),
    db.prepare(`SELECT pu.*, p.name AS project_name, u.display_name AS author_name FROM project_updates pu JOIN projects p ON pu.project_id=p.id LEFT JOIN users u ON pu.author_id=u.id WHERE p.workspace_id=? AND p.deleted_at IS NULL ORDER BY pu.created_at DESC LIMIT 100`).bind(workspaceId).all(),
    db.prepare(`SELECT a.*, p.name AS project_name, u.display_name AS creator_name FROM assets a LEFT JOIN projects p ON a.project_id=p.id LEFT JOIN users u ON a.created_by=u.id WHERE a.workspace_id=? ORDER BY a.created_at DESC LIMIT 100`).bind(workspaceId).all(),
    db.prepare("SELECT * FROM reports WHERE workspace_id=? ORDER BY created_at DESC LIMIT 10").bind(workspaceId).all(),
    db.prepare(`SELECT s.* FROM project_subrequirements s JOIN projects p ON p.id=s.project_id WHERE p.workspace_id=? AND p.deleted_at IS NULL ORDER BY s.priority,s.position,s.updated_at DESC`).bind(workspaceId).all(),
    db.prepare(`SELECT t.* FROM todos t JOIN projects p ON p.id=t.project_id WHERE p.workspace_id=? AND p.deleted_at IS NULL AND t.deleted_at IS NULL ORDER BY CASE t.status WHEN 'open' THEN 0 WHEN 'in_progress' THEN 1 ELSE 2 END,t.priority,COALESCE(t.due_date,'9999-12-31'),t.updated_at DESC`).bind(workspaceId).all(),
    db.prepare("SELECT * FROM agent_interactions WHERE workspace_id=? ORDER BY created_at DESC LIMIT 50").bind(workspaceId).all(),
  ]);
  const memberRows=await db.prepare(`SELECT u.id,u.email,u.display_name,wm.role FROM workspace_members wm JOIN users u ON u.id=wm.user_id WHERE wm.workspace_id=? ORDER BY wm.created_at`).bind(workspaceId).all();
  const workspaceRows=actor?await db.prepare(`SELECT w.id,w.name,w.slug,wm.role FROM workspace_members wm JOIN workspaces w ON w.id=wm.workspace_id WHERE wm.user_id=? ORDER BY wm.created_at`).bind(actor.id).all():{results:[workspace]};
  return {
    workspace:{id:workspace.id,name:workspace.name,role:workspace.role},actor,
    workspaces:workspaceRows.results,
    members:memberRows.results,
    projects: projectRows.results.map((row:any)=>({...row,config:parseConfig(row.config_json),subrequirements:subRequirementRows.results.filter((sub:any)=>sub.project_id===row.id).map((sub:any)=>({...sub,todos:todoRows.results.filter((todo:any)=>todo.sub_requirement_id===sub.id)})),unscopedTodos:todoRows.results.filter((todo:any)=>todo.project_id===row.id&&!todo.sub_requirement_id)})),
    updates:updateRows.results,
    assets:assetRows.results.map((row:any)=>({...row,metadata:parseConfig(row.metadata_json)})),
    reports:reportRows.results.map((row:any)=>({...row,scope:parseConfig(row.scope_json)})),
    activityHistory:interactionRows.results.map((row:any)=>({...row,source_urls:parseConfig(row.source_urls_json||"[]")})),
  };
}

export async function updateTodo(request:Request,payload:any){
  const {workspace}=await workspaceContext(request);const db=getDb(),timestamp=now();
  const todo=await db.prepare(`SELECT t.* FROM todos t JOIN projects p ON p.id=t.project_id WHERE t.id=? AND p.workspace_id=? AND t.deleted_at IS NULL`).bind(String(payload.id||""),workspace.id).first<any>();
  if(!todo)throw new Error("Todo 不存在或已删除");
  const status=["open","in_progress","done"].includes(String(payload.status))?String(payload.status):todo.status;
  await db.prepare("UPDATE todos SET status=?,due_date=?,owner_name=?,priority=?,completed_at=?,updated_at=? WHERE id=?").bind(status,payload.dueDate===undefined?todo.due_date:payload.dueDate,payload.ownerName===undefined?todo.owner_name:String(payload.ownerName||"待分配"),payload.priority===undefined?todo.priority:Math.max(1,Math.min(3,Number(payload.priority)||2)),status==="done"?todo.completed_at||timestamp:null,timestamp,todo.id).run();
  return db.prepare("SELECT * FROM todos WHERE id=?").bind(todo.id).first();
}

export async function deleteTodo(request:Request,todoId:string){
  const {workspace}=await workspaceContext(request);const db=getDb(),timestamp=now();
  const todo=await db.prepare(`SELECT t.id FROM todos t JOIN projects p ON p.id=t.project_id WHERE t.id=? AND p.workspace_id=? AND t.deleted_at IS NULL`).bind(todoId,workspace.id).first<any>();
  if(!todo)throw new Error("Todo 不存在或已删除");
  await db.prepare("UPDATE todos SET deleted_at=?,updated_at=? WHERE id=?").bind(timestamp,timestamp,todo.id).run();return{ok:true,id:todo.id};
}

type SubRequirementInput={projectId?:string;title?:unknown;progressSummary?:unknown;ownerName?:unknown;priority?:unknown};
type TodoInput={projectId?:string;subRequirementId?:string|null;content?:unknown;owner?:unknown;dueDate?:string|null;priority?:unknown;status?:unknown};

export async function createSubRequirement(request:Request,payload:SubRequirementInput){
  const {workspace}=await workspaceContext(request);const db=getDb(),timestamp=now();
  const projectId=String(payload.projectId||""),title=cleanStructuredText(payload.title,{maxLength:160});
  if(!title)throw new Error("业务需求标题不能为空");
  const project=await db.prepare("SELECT id FROM projects WHERE id=? AND workspace_id=? AND deleted_at IS NULL").bind(projectId,workspace.id).first<{id:string}>();
  if(!project)throw new Error("项目需求不存在或已删除");
  const duplicate=await db.prepare("SELECT id FROM project_subrequirements WHERE project_id=? AND title=?").bind(projectId,title).first<{id:string}>();
  if(duplicate)throw new Error("该项目下已存在同名业务需求");
  const position=Number((await db.prepare("SELECT MAX(position) position FROM project_subrequirements WHERE project_id=?").bind(projectId).first<{position:number|null}>())?.position??-1)+1;
  const subId=id("sub");
  await db.prepare("INSERT INTO project_subrequirements(id,project_id,title,progress_summary,status,progress,owner_name,priority,position,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
    .bind(subId,projectId,title,cleanStructuredText(payload.progressSummary,{maxLength:1000,fallback:"待同步进展"}),"in_progress",0,cleanStructuredText(payload.ownerName,{maxLength:80,fallback:"待分配"}),Math.max(1,Math.min(3,Number(payload.priority)||2)),position,timestamp,timestamp).run();
  return db.prepare("SELECT * FROM project_subrequirements WHERE id=?").bind(subId).first();
}

export async function deleteSubRequirement(request:Request,subId:string){
  const {workspace}=await workspaceContext(request);const db=getDb(),timestamp=now();
  const sub=await db.prepare(`SELECT s.id,s.project_id FROM project_subrequirements s JOIN projects p ON p.id=s.project_id WHERE s.id=? AND p.workspace_id=? AND p.deleted_at IS NULL`).bind(subId,workspace.id).first<{id:string;project_id:string}>();
  if(!sub)throw new Error("业务需求不存在或已删除");
  await db.batch([
    db.prepare("UPDATE todos SET deleted_at=COALESCE(deleted_at,?),updated_at=? WHERE sub_requirement_id=?").bind(timestamp,timestamp,sub.id),
    db.prepare("DELETE FROM project_subrequirements WHERE id=?").bind(sub.id),
  ]);
  return{ok:true,id:sub.id,projectId:sub.project_id,deletedAt:timestamp};
}

export async function createTodo(request:Request,payload:TodoInput){
  const {workspace}=await workspaceContext(request);const db=getDb(),timestamp=now();
  const projectId=String(payload.projectId||""),content=cleanStructuredText(payload.content,{maxLength:500});
  if(!content)throw new Error("Todo 内容不能为空");
  const project=await db.prepare("SELECT id FROM projects WHERE id=? AND workspace_id=? AND deleted_at IS NULL").bind(projectId,workspace.id).first<{id:string}>();
  if(!project)throw new Error("项目需求不存在或已删除");
  const subRequirementId=payload.subRequirementId?String(payload.subRequirementId):null;
  if(subRequirementId){
    const sub=await db.prepare("SELECT id FROM project_subrequirements WHERE id=? AND project_id=?").bind(subRequirementId,projectId).first<{id:string}>();
    if(!sub)throw new Error("业务需求不存在，无法挂载 Todo");
  }
  const status=["open","in_progress","done"].includes(String(payload.status))?String(payload.status):"open",todoId=id("todo");
  await db.prepare("INSERT INTO todos(id,project_id,content,owner_name,status,due_date,source_message_id,created_at,updated_at,sub_requirement_id,priority,completed_at,deleted_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .bind(todoId,projectId,content,cleanStructuredText(payload.owner,{maxLength:80,fallback:"待分配"}),status,payload.dueDate||null,null,timestamp,timestamp,subRequirementId,Math.max(1,Math.min(3,Number(payload.priority)||2)),status==="done"?timestamp:null,null).run();
  return db.prepare("SELECT * FROM todos WHERE id=?").bind(todoId).first();
}

export async function deleteProject(request:Request,projectId:string){
  const {workspace}=await workspaceContext(request);const db=getDb(),timestamp=now();
  const project=await db.prepare("SELECT id FROM projects WHERE id=? AND workspace_id=? AND deleted_at IS NULL").bind(projectId,workspace.id).first<{id:string}>();
  if(!project)throw new Error("项目需求不存在或已删除");
  await db.batch([
    db.prepare("UPDATE projects SET status='deleted',deleted_at=?,updated_at=? WHERE id=?").bind(timestamp,timestamp,project.id),
    db.prepare("UPDATE todos SET deleted_at=COALESCE(deleted_at,?),updated_at=? WHERE project_id=?").bind(timestamp,timestamp,project.id),
  ]);
  return{ok:true,id:project.id,deletedAt:timestamp};
}

export async function recordInteraction(request:Request,{source,inputText,output,status="completed",projectId=null,error=null}:{source:string;inputText:string;output?:string;status?:string;projectId?:string|null;error?:string|null}){
  const {workspace}=await workspaceContext(request);const db=getDb(),timestamp=now(),interactionId=id("interaction"),urls=String(inputText).match(/https?:\/\/[^\s<>()]+/g)||[];
  await db.prepare("INSERT INTO agent_interactions(id,workspace_id,source,input_text,source_urls_json,output_markdown,status,project_id,error,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)").bind(interactionId,workspace.id,source,String(inputText).slice(0,20000),JSON.stringify(urls.slice(0,20)),String(output||"").slice(0,50000),status,projectId,error,timestamp,timestamp).run();return{id:interactionId};
}

export async function createProject(request:Request,payload:any){
  const {workspace,actor}=await workspaceContext(request); const db=getDb(); const timestamp=now();
  const projectId=id("prj"),projectName=cleanStructuredText(payload.name,{maxLength:120}),projectSummary=cleanStructuredText(payload.summary,{maxLength:600}); const ownerName=cleanStructuredText(payload.owner||actor.name,{maxLength:80,fallback:"待分配"});
  const ownerEmail=`${ownerName.toLowerCase().replace(/[^a-z0-9]+/g,".")||"owner"}@pulse.local`; const ownerId=id("usr");
  const existing=await db.prepare("SELECT id FROM users WHERE display_name=? LIMIT 1").bind(ownerName).first<{id:string}>();
  const finalOwner=existing?.id||ownerId;
  if(!existing) await db.prepare("INSERT INTO users (id,email,display_name,role,created_at,updated_at) VALUES (?,?,?,?,?,?)").bind(finalOwner,ownerEmail,ownerName,"member",timestamp,timestamp).run();
  const config={group:payload.group||"未分组",phase:payload.phase||"需求明确",next:payload.next||"确认下一步",signal:"刚刚创建"};
  await db.prepare("INSERT INTO projects (id,workspace_id,name,summary,status,health,progress,owner_id,expected_outcome,target_date,config_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .bind(projectId,workspace.id,projectName,projectSummary,"active",payload.health||"ontrack",Number(payload.progress||0),finalOwner,cleanStructuredText(payload.outcome,{maxLength:500}),payload.targetDate||null,JSON.stringify(config),timestamp,timestamp).run();
  await db.prepare("INSERT INTO project_updates (id,project_id,author_id,source,summary,progress_delta,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)")
    .bind(id("upd"),projectId,actor.id,"web","创建了项目",0,timestamp,timestamp).run();
  return {id:projectId};
}

export async function createUpdate(request:Request,payload:any){
  const {workspace,actor}=await workspaceContext(request); const db=getDb(); const timestamp=now();
  const project=await db.prepare("SELECT * FROM projects WHERE id=? AND workspace_id=? AND deleted_at IS NULL").bind(payload.projectId,workspace.id).first<any>();
  if(!project) throw new Error("Project not found");
  const oldConfig=parseConfig(project.config_json),safeSummary=cleanStructuredText(payload.summary,{maxLength:2000,fallback:"待同步进展"}); const progress=Number(payload.progress??project.progress);
  const config={...oldConfig,phase:cleanStructuredText(payload.phase||oldConfig.phase,{maxLength:120}),next:cleanStructuredText(payload.next||oldConfig.next,{maxLength:240}),signal:safeSummary};
  await db.batch([
    db.prepare("INSERT INTO project_updates (id,project_id,author_id,source,raw_content,summary,progress_delta,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .bind(id("upd"),payload.projectId,actor.id,payload.source||"web",payload.rawContent||null,safeSummary,progress-Number(project.progress),timestamp,timestamp),
    db.prepare("UPDATE projects SET progress=?,health=?,config_json=?,updated_at=? WHERE id=?")
      .bind(progress,payload.health||project.health,JSON.stringify(config),timestamp,payload.projectId),
  ]);
  if(payload.url&&payload.linkTitle) await createAsset(request,{projectId:payload.projectId,title:payload.linkTitle,url:payload.url,kind:"更新附件"});
  return {ok:true};
}

export async function createAsset(request:Request,payload:any){
  const {workspace,actor}=await workspaceContext(request); const db=getDb(); const timestamp=now(); const assetId=id("ast");
  await db.prepare("INSERT INTO assets (id,workspace_id,project_id,title,url,kind,created_by,metadata_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .bind(assetId,workspace.id,payload.projectId||null,payload.title,payload.url,payload.kind||"项目文档",actor.id,JSON.stringify({note:payload.note||"",source:"manual",sync_status:"link_only",excerpt:payload.note||"仅保存了链接，尚未读取正文"}),timestamp,timestamp).run();
  return {id:assetId};
}

export async function organizeDocument(request:Request,input:{assetId:string;title:string;url:string;content?:string;excerpt?:string}){
  const {workspace,actor}=await workspaceContext(request); const db=getDb(); const content=String(input.content||input.excerpt||"").trim();
  const normalizedTitle=cleanStructuredText(input.title.replace(/^\s*[\[【].*?[\]】]\s*/,"").replace(/\s*[·|｜].*$/,"").trim(),{maxLength:120,fallback:"未命名项目"});
  const keyword=normalizedTitle.split(/[\s·｜|—_-]+/).filter(Boolean).sort((a,b)=>b.length-a.length)[0]?.slice(0,18)||normalizedTitle.slice(0,18);
  let project=await db.prepare("SELECT id,name FROM projects WHERE workspace_id=? AND deleted_at IS NULL AND (name LIKE ? OR summary LIKE ?) ORDER BY updated_at DESC LIMIT 1").bind(workspace.id,`%${keyword}%`,`%${keyword}%`).first<{id:string;name:string}>();
  let created=false;
  if(!project){const result=await createProject(request,{name:normalizedTitle,summary:(input.excerpt||content).replace(/\s+/g," ").slice(0,120),owner:actor?.name||"待分配",phase:"资料已接入",next:"确认 Agent 提炼结果"});project={id:result.id,name:normalizedTitle};created=true;}
  const lines=content.split(/\r?\n/).map(line=>line.trim()).filter(Boolean);
  const todoLine=lines.find(line=>/^(下一步|todo|待办|action|行动|后续|计划)\s*[:：-]?/i.test(line))||lines.find(line=>/(下一步|待办|todo|action)/i.test(line));
  const next=(todoLine?.replace(/^(下一步|todo|待办|action|行动|后续|计划)\s*[:：-]?\s*/i,"")||"确认文档结论并补充下一步").slice(0,120);
  const summary=cleanStructuredText(input.excerpt||lines.find(line=>line.length>16)||input.title,{maxLength:160});
  const health=/(阻塞|风险|延期|依赖|等待)/.test(content)?"attention":"ontrack";
  await db.prepare("UPDATE assets SET workspace_id=?,project_id=?,updated_at=? WHERE id=?").bind(workspace.id,project.id,now(),input.assetId).run();
  await createUpdate(request,{projectId:project.id,summary,phase:"Agent 已整理",next,health,source:"agent_document"});
  const timestamp=now(),subTitle="文档行动项";let sub=await db.prepare("SELECT id FROM project_subrequirements WHERE project_id=? AND title=? LIMIT 1").bind(project.id,subTitle).first<{id:string}>();
  if(!sub){sub={id:id("sub")};await db.prepare("INSERT INTO project_subrequirements(id,project_id,title,progress_summary,status,progress,owner_name,priority,position,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)").bind(sub.id,project.id,subTitle,summary,"in_progress",0,actor?.name||"待分配",health==="attention"?1:2,0,timestamp,timestamp).run();}
  const actionLines=lines.flatMap(line=>line.split(/[；;]/).map(item=>item.trim())).filter(line=>/(下一步|todo|待办|action|行动|后续|计划|负责|需要|完成|确认|推进|上线|实验)/i.test(line)).slice(0,20),candidates=actionLines.length?actionLines:[next];
  const savedTodos=[];for(const raw of candidates){const ownerMatch=raw.match(/(?:负责人\s*[:：]?|owner\s*[:：]?|@)([\p{L}\p{N}._ -]{1,40})/iu),owner=cleanStructuredText(ownerMatch?.[1]||actor?.name||"待分配",{maxLength:80,fallback:"待分配"}),task=cleanStructuredText(raw.replace(/^[-*\d.、\s]+/,"").replace(/^(下一步|todo|待办|action|行动|后续|计划)\s*[:：-]?\s*/i,"").replace(/(?:负责人\s*[:：]?|owner\s*[:：]?|@)[\p{L}\p{N}._ -]{1,40}/iu,""),{maxLength:500});if(!task)continue;const existing=await db.prepare("SELECT id FROM todos WHERE project_id=? AND sub_requirement_id=? AND content=? AND owner_name=? AND deleted_at IS NULL LIMIT 1").bind(project.id,sub.id,task,owner).first<any>();if(existing){savedTodos.push(existing);continue;}const todoId=id("todo");await db.prepare("INSERT INTO todos(id,project_id,sub_requirement_id,content,owner_name,status,priority,due_date,source_message_id,completed_at,deleted_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(todoId,project.id,sub.id,task,owner,"open",health==="attention"?1:2,null,null,null,null,timestamp,timestamp).run();savedTodos.push({id:todoId,content:task,owner_name:owner});}
  return {projectId:project.id,projectName:project.name,created,summary,next,owner:actor?.name||"待分配",todos:savedTodos,answer:`## 已完成文档整理\n\n已将 **${project.name}** 的进展同步到项目看板，并拆分出 ${savedTodos.length} 条独立 Todo。`};
}

export async function searchWorkspace(query:string,request?:Request){
  const {workspace}=await workspaceContext(request); const db=getDb(); const term=`%${query.trim()}%`;
  if(!query.trim()) return [];
  const [projects,updates,assets]=await Promise.all([
    db.prepare(`SELECT p.id,'project' AS type,p.name AS title,p.summary AS excerpt,u.display_name AS owner,p.updated_at FROM projects p LEFT JOIN users u ON p.owner_id=u.id WHERE p.workspace_id=? AND (p.name LIKE ? OR p.summary LIKE ? OR u.display_name LIKE ? OR p.config_json LIKE ?) LIMIT 20`).bind(workspace.id,term,term,term,term).all(),
    db.prepare(`SELECT pu.id,'update' AS type,p.name || ' · 项目更新' AS title,pu.summary AS excerpt,u.display_name AS owner,pu.created_at AS updated_at,pu.project_id FROM project_updates pu JOIN projects p ON pu.project_id=p.id LEFT JOIN users u ON pu.author_id=u.id WHERE p.workspace_id=? AND (pu.summary LIKE ? OR pu.raw_content LIKE ?) LIMIT 20`).bind(workspace.id,term,term).all(),
    db.prepare(`SELECT a.id,'asset' AS type,a.title,a.kind || ' · ' || COALESCE(p.name,'未关联项目') AS excerpt,u.display_name AS owner,a.updated_at,a.project_id,a.url FROM assets a LEFT JOIN projects p ON a.project_id=p.id LEFT JOIN users u ON a.created_by=u.id WHERE a.workspace_id=? AND (a.title LIKE ? OR a.kind LIKE ? OR a.metadata_json LIKE ?) LIMIT 20`).bind(workspace.id,term,term,term).all(),
  ]);
  return [...projects.results,...updates.results,...assets.results].slice(0,30);
}

async function callReportModel(type:string, context:unknown){
  const runtime=env as unknown as Record<string,string|undefined>;
  if(!runtime.LLM_API_KEY) return null;
  const base=(runtime.LLM_BASE_URL||"https://api.openai.com/v1").replace(/\/$/,"");
  const model=runtime.LLM_MODEL||"gpt-5-mini";
  const response=await fetch(`${base}/chat/completions`,{method:"POST",headers:{"content-type":"application/json","authorization":`Bearer ${runtime.LLM_API_KEY}`},body:JSON.stringify({model,messages:[{role:"system",content:"你是项目管理中台的汇报编辑。只根据提供材料写作，不补造数据。结论先行，明确进展、风险、Owner、下一步和证据来源；中文简洁，可直接复制到飞书。"},{role:"user",content:`生成${type}。\n\n结构化材料：\n${JSON.stringify(context)}`}],temperature:0.2})});
  if(!response.ok) throw new Error(`大模型接口返回 ${response.status}`);
  const result=await response.json() as any;
  return {content:String(result.choices?.[0]?.message?.content||"").trim(),model};
}

export async function generateReport(request:Request,type:string){
  const {workspace,actor}=await workspaceContext(request); const db=getDb();
  const data=await readWorkspace(request); const attention=data.projects.filter((p:any)=>p.health==="attention"||p.health==="blocked");
  const evidence=data.assets.filter((a:any)=>a.metadata?.excerpt).slice(0,8);
  const context={generatedAt:now(),projects:data.projects.map((p:any)=>({name:p.name,owner:p.owner_name,health:p.health,progress:p.progress,phase:p.config.phase,next:p.config.next,signal:p.config.signal,outcome:p.expected_outcome})),updates:data.updates.slice(0,20).map((u:any)=>({project:u.project_name,summary:u.summary,author:u.author_name,createdAt:u.created_at})),documents:evidence.map((a:any)=>({title:a.title,project:a.project_name,url:a.url,excerpt:a.metadata.excerpt,source:a.metadata.source}))};
  let generated:null|{content:string;model:string}=null;
  try{generated=await callReportModel(type,context)}catch{/* 保留结构化降级，避免汇报入口不可用 */}
  const lines=[
    `# ${type} · ${new Date().toLocaleDateString("zh-CN")}`,
    `当前共推进 ${data.projects.length} 个项目，其中 ${attention.length} 个需要关注。最近已沉淀 ${data.updates.length} 条更新和 ${data.assets.length} 份关联资料。`,
    "## 核心进展",
    ...data.projects.slice(0,5).map((p:any)=>`- ${p.name}：${p.config.phase}，完成度 ${p.progress}%；下一步 ${p.config.next}。`),
    "## 风险与行动",
    ...(attention.length?attention.map((p:any)=>`- ${p.name}（${p.owner_name||"待分配"}）：${p.config.signal||"需要关注"}；建议 ${p.config.next}。`):["- 当前无明确阻塞，继续按计划推进。"]),
    "## 最近同步",
    ...data.updates.slice(0,4).map((u:any)=>`- ${u.project_name}：${u.summary}（${u.author_name||"系统"}）`),
    "## 材料依据",
    ...(evidence.length?evidence.map((a:any)=>`- ${a.title}：${String(a.metadata.excerpt).slice(0,120)}（${a.url}）`):["- 暂无已抽取正文的资料；当前结论仅依据项目与进展记录。"]),
  ];
  const content=generated?.content||lines.join("\n"); const timestamp=now(); const reportId=id("rpt"); const model=generated?.model||"structured-summary-v2";
  await db.prepare("INSERT INTO reports (id,workspace_id,type,title,content,scope_json,generated_by,model,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .bind(reportId,workspace.id,type,`${type} · ${timestamp.slice(0,10)}`,content,JSON.stringify({projects:data.projects.length,updates:Math.min(data.updates.length,20),documents:evidence.length,engine:generated?"llm":"structured-fallback"}),actor?.id,model,timestamp,timestamp).run();
  return {id:reportId,content,model,scope:{projects:data.projects.length,updates:Math.min(data.updates.length,20),documents:evidence.length,engine:generated?"llm":"structured-fallback"}};
}

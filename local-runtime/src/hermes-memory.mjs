/*
 * Hermes-compatible memory and session layer for Pulse.
 *
 * The session key, frozen USER.md/MEMORY.md snapshot and FTS5 session-search
 * semantics follow NousResearch/hermes-agent. Pulse keeps its own SQLite
 * adapter because its gateway and data model are Node based.
 * Upstream: https://github.com/NousResearch/hermes-agent (MIT)
 */

const stamp=()=>new Date().toISOString();
const id=(prefix)=>`${prefix}_${crypto.randomUUID()}`;
const parse=(value,fallback={})=>{try{return JSON.parse(value||"{}");}catch{return fallback;}};

export function installHermesMemory(db){
  db.exec(`
CREATE TABLE IF NOT EXISTS session_snapshots(
  session_id TEXT PRIMARY KEY,
  system_prompt_id TEXT,
  system_prompt_version INTEGER,
  system_prompt_content TEXT NOT NULL,
  user_md TEXT NOT NULL DEFAULT '',
  memory_md TEXT NOT NULL DEFAULT '',
  snapshot_period TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS project_knowledge_items(
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  knowledge_type TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_url TEXT,
  chat_id TEXT,
  people_json TEXT NOT NULL DEFAULT '[]',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id,source_type,source_id),
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_session_messages_created ON messages(session_id,created_at,id);
CREATE INDEX IF NOT EXISTS idx_project_knowledge_project_time ON project_knowledge_items(project_id,occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_project_knowledge_source ON project_knowledge_items(source_type,source_id);
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  content,session_id UNINDEXED,role UNINDEXED,created_at UNINDEXED,tokenize='unicode61'
);
CREATE VIRTUAL TABLE IF NOT EXISTS project_knowledge_fts USING fts5(
  item_id UNINDEXED,project_id UNINDEXED,title,content,tokenize='unicode61'
);
CREATE TRIGGER IF NOT EXISTS pulse_messages_fts_insert AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid,content,session_id,role,created_at)
  VALUES(new.rowid,new.content,new.session_id,new.role,new.created_at);
END;
CREATE TRIGGER IF NOT EXISTS pulse_messages_fts_delete AFTER DELETE ON messages BEGIN
  DELETE FROM messages_fts WHERE rowid=old.rowid;
END;
CREATE TRIGGER IF NOT EXISTS pulse_messages_fts_update AFTER UPDATE OF content ON messages BEGIN
  DELETE FROM messages_fts WHERE rowid=old.rowid;
  INSERT INTO messages_fts(rowid,content,session_id,role,created_at)
  VALUES(new.rowid,new.content,new.session_id,new.role,new.created_at);
END;
CREATE TRIGGER IF NOT EXISTS pulse_knowledge_fts_insert AFTER INSERT ON project_knowledge_items BEGIN
  INSERT INTO project_knowledge_fts(item_id,project_id,title,content)
  VALUES(new.id,new.project_id,new.title,new.content);
END;
CREATE TRIGGER IF NOT EXISTS pulse_knowledge_fts_delete AFTER DELETE ON project_knowledge_items BEGIN
  DELETE FROM project_knowledge_fts WHERE item_id=old.id;
END;
CREATE TRIGGER IF NOT EXISTS pulse_knowledge_fts_update AFTER UPDATE OF title,content ON project_knowledge_items BEGIN
  DELETE FROM project_knowledge_fts WHERE item_id=old.id;
  INSERT INTO project_knowledge_fts(item_id,project_id,title,content)
  VALUES(new.id,new.project_id,new.title,new.content);
END;`);
  const messageCount=Number(db.prepare("SELECT COUNT(*) n FROM messages_fts").get().n||0);
  if(messageCount===0)db.exec("INSERT INTO messages_fts(rowid,content,session_id,role,created_at) SELECT rowid,content,session_id,role,created_at FROM messages;");
  const knowledgeCount=Number(db.prepare("SELECT COUNT(*) n FROM project_knowledge_fts").get().n||0);
  if(knowledgeCount===0)db.exec("INSERT INTO project_knowledge_fts(item_id,project_id,title,content) SELECT id,project_id,title,content FROM project_knowledge_items;");
}

export function createHermesMemoryStore(db,workspaceId){
  function currentPeriod(date=new Date()){return`${date.getUTCFullYear()}-${String(date.getUTCMonth()+1).padStart(2,"0")}`;}
  function userMarkdown(){
    const rows=db.prepare("SELECT category,profile_key,profile_value FROM profile_facts WHERE workspace_id=? AND status='published' ORDER BY confidence DESC,updated_at DESC LIMIT 30").all(workspaceId);
    return rows.length?["# USER.md",...rows.map(row=>`- **${row.profile_key}**：${row.profile_value}`)].join("\n"):"# USER.md\n- 尚无已发布的稳定用户偏好。";
  }
  function memoryMarkdown(){
    const rows=db.prepare("SELECT memory_type,content FROM memory_entries WHERE workspace_id=? AND status='published' AND memory_type IN ('preference','fact','goal') ORDER BY importance DESC,updated_at DESC LIMIT 24").all(workspaceId);
    return rows.length?["# MEMORY.md",...rows.map(row=>`- [${row.memory_type}] ${row.content}`)].join("\n"):"# MEMORY.md\n- 尚无已发布的长期事实。";
  }
  function ensureSnapshot(sessionId,systemPrompt,{force=false}={}){
    const period=currentPeriod(),existing=db.prepare("SELECT * FROM session_snapshots WHERE session_id=?").get(sessionId);
    if(existing&&!force&&existing.snapshot_period===period)return existing;
    const created=existing?.created_at||stamp(),updated=stamp(),userMd=userMarkdown().slice(0,1375),memoryMd=memoryMarkdown().slice(0,2200);
    db.prepare(`INSERT INTO session_snapshots(session_id,system_prompt_id,system_prompt_version,system_prompt_content,user_md,memory_md,snapshot_period,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET system_prompt_id=excluded.system_prompt_id,system_prompt_version=excluded.system_prompt_version,system_prompt_content=excluded.system_prompt_content,user_md=excluded.user_md,memory_md=excluded.memory_md,snapshot_period=excluded.snapshot_period,updated_at=excluded.updated_at`).run(sessionId,systemPrompt.id,systemPrompt.version,systemPrompt.content,userMd,memoryMd,period,created,updated);
    return db.prepare("SELECT * FROM session_snapshots WHERE session_id=?").get(sessionId);
  }
  function sessionContext(sessionId,{limit=24}={}){
    const session=db.prepare("SELECT * FROM sessions WHERE id=? AND workspace_id=?").get(sessionId,workspaceId);if(!session)return null;
    const messages=db.prepare("SELECT id,role,content,metadata_json,created_at FROM messages WHERE session_id=? ORDER BY created_at DESC,rowid DESC LIMIT ?").all(sessionId,Math.max(2,Math.min(80,Number(limit)||24))).reverse().map(row=>({...row,metadata:parse(row.metadata_json,{})}));
    return{session:{id:session.id,channel:session.channel,peerId:session.peer_id,chatId:session.external_chat_id,startedAt:session.created_at,updatedAt:session.updated_at},messages};
  }
  function messageWindow(sessionId,anchorRowId,window=5){
    const before=db.prepare("SELECT rowid,id,role,content,metadata_json,created_at FROM messages WHERE session_id=? AND rowid<? ORDER BY rowid DESC LIMIT ?").all(sessionId,anchorRowId,window).reverse();
    const anchor=db.prepare("SELECT rowid,id,role,content,metadata_json,created_at FROM messages WHERE session_id=? AND rowid=?").get(sessionId,anchorRowId);
    const after=db.prepare("SELECT rowid,id,role,content,metadata_json,created_at FROM messages WHERE session_id=? AND rowid>? ORDER BY rowid LIMIT ?").all(sessionId,anchorRowId,window);
    return[...before,...(anchor?[anchor]:[]),...after].map(row=>({...row,metadata:parse(row.metadata_json,{})}));
  }
  function sessionSearch({query="",sessionId=null,aroundMessageId=null,limit=5,window=5}={}){
    const safeLimit=Math.max(1,Math.min(20,Number(limit)||5)),safeWindow=Math.max(1,Math.min(20,Number(window)||5));
    if(sessionId){
      let anchor=aroundMessageId?db.prepare("SELECT rowid FROM messages WHERE id=? AND session_id=?").get(String(aroundMessageId),sessionId):null;
      if(!anchor)anchor=db.prepare("SELECT rowid FROM messages WHERE session_id=? ORDER BY rowid DESC LIMIT 1").get(sessionId);
      const session=db.prepare("SELECT * FROM sessions WHERE id=? AND workspace_id=?").get(sessionId,workspaceId);return session?{mode:"read",session,messages:anchor?messageWindow(sessionId,anchor.rowid,safeWindow):[]}:null;
    }
    if(!String(query).trim()){const browseLimit=Math.max(1,Math.min(200,Number(limit)||100));return{mode:"browse",sessions:db.prepare("SELECT s.*,(SELECT content FROM messages WHERE session_id=s.id ORDER BY rowid DESC LIMIT 1) preview,(SELECT COUNT(*) FROM messages WHERE session_id=s.id) message_count FROM sessions s WHERE workspace_id=? ORDER BY updated_at DESC LIMIT ?").all(workspaceId,browseLimit)};}
    const raw=String(query).trim(),tokens=raw.split(/\s+/).filter(Boolean),ftsQuery=tokens.map(token=>`"${token.replaceAll('"','""')}"`).join(" OR ");let hits=[];
    try{hits=db.prepare("SELECT m.rowid,m.id AS message_id,m.session_id,m.role,m.content,m.created_at,s.channel,s.peer_id,s.external_chat_id,bm25(messages_fts) rank FROM messages_fts JOIN messages m ON m.rowid=messages_fts.rowid JOIN sessions s ON s.id=m.session_id WHERE messages_fts MATCH ? AND s.workspace_id=? AND m.role IN ('user','assistant') ORDER BY rank LIMIT ?").all(ftsQuery,workspaceId,safeLimit);}catch{}
    if(!hits.length){const clauses=tokens.map(()=>"m.content LIKE ?").join(" OR ");hits=db.prepare(`SELECT m.rowid,m.id AS message_id,m.session_id,m.role,m.content,m.created_at,s.channel,s.peer_id,s.external_chat_id,0 rank FROM messages m JOIN sessions s ON s.id=m.session_id WHERE s.workspace_id=? AND m.role IN ('user','assistant') AND (${clauses||"1=0"}) ORDER BY m.created_at DESC LIMIT ?`).all(workspaceId,...tokens.map(token=>`%${token}%`),safeLimit);}
    return{mode:"discovery",query:raw,results:hits.map(hit=>({...hit,messages:messageWindow(hit.session_id,hit.rowid,safeWindow)}))};
  }
  function upsertKnowledge({projectId,knowledgeType="fact",title,content,sourceType,sourceId,sourceUrl=null,chatId=null,people=[],metadata={},occurredAt=null}){
    if(!projectId||!sourceType||!sourceId||!String(content||"").trim())return null;const time=stamp(),itemId=id("knw");
    db.prepare(`INSERT INTO project_knowledge_items(id,workspace_id,project_id,knowledge_type,title,content,source_type,source_id,source_url,chat_id,people_json,metadata_json,occurred_at,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(project_id,source_type,source_id) DO UPDATE SET knowledge_type=excluded.knowledge_type,title=excluded.title,content=excluded.content,source_url=excluded.source_url,chat_id=excluded.chat_id,people_json=excluded.people_json,metadata_json=excluded.metadata_json,occurred_at=excluded.occurred_at,updated_at=excluded.updated_at`).run(itemId,workspaceId,projectId,knowledgeType,String(title||knowledgeType).slice(0,300),String(content).slice(0,100000),sourceType,String(sourceId),sourceUrl,chatId,JSON.stringify(people),JSON.stringify(metadata),occurredAt||time,time,time);
    return db.prepare("SELECT * FROM project_knowledge_items WHERE project_id=? AND source_type=? AND source_id=?").get(projectId,sourceType,String(sourceId));
  }
  function projectKnowledgeSearch({query="",projectId=null,days=90,limit=30}={}){
    const since=new Date(Date.now()-Math.max(1,Math.min(730,Number(days)||90))*86400000).toISOString(),safeLimit=Math.max(1,Math.min(100,Number(limit)||30)),where=["k.workspace_id=?","k.occurred_at>=?"],params=[workspaceId,since];if(projectId){where.push("k.project_id=?");params.push(projectId);}const raw=String(query||"").trim();if(raw){const tokens=raw.split(/\s+/).filter(Boolean);where.push(`(${tokens.map(()=>"(k.title LIKE ? OR k.content LIKE ?)").join(" OR ")})`);for(const token of tokens)params.push(`%${token}%`,`%${token}%`);}return db.prepare(`SELECT k.*,p.name AS project_name FROM project_knowledge_items k JOIN projects p ON p.id=k.project_id WHERE ${where.join(" AND ")} AND p.deleted_at IS NULL ORDER BY k.occurred_at DESC LIMIT ?`).all(...params,safeLimit).map(row=>({...row,people:parse(row.people_json,[]),metadata:parse(row.metadata_json,{})}));
  }
  function projectContext(projectId,{days=90,limit=60}={}){
    const project=db.prepare("SELECT * FROM projects WHERE id=? AND workspace_id=? AND deleted_at IS NULL").get(projectId,workspaceId);if(!project)return null;
    const requirements=db.prepare("SELECT * FROM project_subrequirements WHERE project_id=? ORDER BY position,updated_at DESC").all(projectId).map(req=>({...req,todos:db.prepare("SELECT * FROM todos WHERE sub_requirement_id=? AND deleted_at IS NULL ORDER BY status,COALESCE(due_date,'9999-12-31')").all(req.id)}));
    const knowledge=projectKnowledgeSearch({projectId,days,limit});const people=[...new Set([project.owner_name,...requirements.flatMap(req=>[req.owner_name,...req.todos.map(todo=>todo.owner_name)]),...knowledge.flatMap(item=>item.people||[])].filter(Boolean))];
    return{project,requirements,people,knowledge};
  }
  function knowledgeOverview(){const projects=db.prepare("SELECT id,name,health,progress,updated_at FROM projects WHERE workspace_id=? AND deleted_at IS NULL ORDER BY updated_at DESC").all(workspaceId).map(project=>({...project,itemCount:Number(db.prepare("SELECT COUNT(*) n FROM project_knowledge_items WHERE project_id=?").get(project.id).n||0),documentCount:Number(db.prepare("SELECT COUNT(*) n FROM project_knowledge_items WHERE project_id=? AND knowledge_type='document'").get(project.id).n||0),chatCount:Number(db.prepare("SELECT COUNT(DISTINCT chat_id) n FROM project_knowledge_items WHERE project_id=? AND chat_id IS NOT NULL").get(project.id).n||0),people:projectContext(project.id,{limit:1})?.people||[]}));return{projects,items:projectKnowledgeSearch({days:730,limit:200}),totals:{projects:projects.length,items:projects.reduce((sum,item)=>sum+item.itemCount,0)}};}
  function migrateProjectKnowledge(){
    for(const row of db.prepare("SELECT u.*,p.name project_name FROM project_updates u JOIN projects p ON p.id=u.project_id WHERE p.workspace_id=? AND p.deleted_at IS NULL").all(workspaceId))upsertKnowledge({projectId:row.project_id,knowledgeType:"progress",title:`${row.project_name} · 进展`,content:[row.summary,row.raw_content].filter(Boolean).join("\n\n"),sourceType:"project_update",sourceId:row.id,occurredAt:row.created_at});
    for(const row of db.prepare("SELECT a.*,p.name project_name FROM assets a JOIN projects p ON p.id=a.project_id WHERE a.workspace_id=? AND p.deleted_at IS NULL").all(workspaceId))upsertKnowledge({projectId:row.project_id,knowledgeType:"document",title:row.title,content:[row.excerpt,row.content].filter(Boolean).join("\n\n"),sourceType:"asset",sourceId:row.id,sourceUrl:row.url,metadata:parse(row.metadata_json,{}),occurredAt:row.updated_at});
    for(const row of db.prepare("SELECT * FROM memory_entries WHERE workspace_id=? AND subject_type='project'").all(workspaceId)){const project=row.subject_id?db.prepare("SELECT id,name FROM projects WHERE id=? AND workspace_id=? AND deleted_at IS NULL").get(row.subject_id,workspaceId):null;if(project)upsertKnowledge({projectId:project.id,knowledgeType:"legacy_memory",title:`${project.name} · 历史项目记忆`,content:row.content,sourceType:"legacy_memory",sourceId:row.id,metadata:{migratedFrom:"memory_entries",memoryType:row.memory_type},occurredAt:row.updated_at});db.prepare("UPDATE memory_entries SET status='archived',updated_at=? WHERE id=?").run(stamp(),row.id);}
    db.prepare("UPDATE memory_entries SET status='archived',updated_at=? WHERE workspace_id=? AND subject_type<>'workspace'").run(stamp(),workspaceId);
  }
  function refreshAllSnapshots(systemPrompt){for(const row of db.prepare("SELECT id FROM sessions WHERE workspace_id=?").all(workspaceId))ensureSnapshot(row.id,systemPrompt,{force:true});}
  return{ensureSnapshot,sessionContext,sessionSearch,userMarkdown,memoryMarkdown,upsertKnowledge,projectKnowledgeSearch,projectContext,knowledgeOverview,migrateProjectKnowledge,refreshAllSnapshots};
}

import { accessSync,existsSync,mkdirSync,unlinkSync,writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawn } from "node:child_process";

const root=process.cwd();
const python=resolve(root,"harness-service/.venv/bin/python");
const cli=process.env.LARK_CLI_BIN||"lark-cli";
const sharedEnv={...process.env,PATH:process.env.PATH||"/usr/local/bin:/usr/bin:/bin",PNPM_BIN:process.env.PNPM_BIN||"pnpm"};
const componentPidFile=resolve(root,"local-runtime/data/pulse-components.json");
accessSync(python);accessSync(cli);
mkdirSync(resolve(root,"harness-service/data/sessions"),{recursive:true});

const children=[];let stopping=false;
function launch(name,command,args,options={}){
  const child=spawn(command,args,{cwd:options.cwd||root,env:{...sharedEnv,...options.env},stdio:"inherit"});
  children.push(child);
  child.once("error",(error)=>{console.error(`[local] ${name} 启动失败：${error.message}`);shutdown(1);});
  child.once("exit",(code,signal)=>{if(stopping)return;console.error(`[local] ${name} 已退出：${code??signal}`);shutdown(code||1);});
  return child;
}

console.log("[local] 正在启动 DeepSeek Harness、Pulse Gateway、Web 与飞书 CLI 消息监听");
const harness=launch("harness",python,["-m","uvicorn","app:app","--host","127.0.0.1","--port","8090"],{cwd:resolve(root,"harness-service"),env:{DSH_SESSION_ROOT:resolve(root,"harness-service/data/sessions")}});
const gateway=launch("gateway",process.execPath,["local-runtime/src/server.mjs"]);
const web=launch("web",process.execPath,["scripts/start-local-web.mjs"]);
writeFileSync(componentPidFile,JSON.stringify({supervisor:process.pid,harness:harness.pid,gateway:gateway.pid,web:web.pid}),{mode:0o600});

function shutdown(code=0){if(stopping)return;stopping=true;if(existsSync(componentPidFile))unlinkSync(componentPidFile);for(const child of children){if(!child.killed)child.kill("SIGTERM");}setTimeout(()=>process.exit(code),2000).unref();}
for(const signal of ["SIGINT","SIGTERM"])process.once(signal,()=>shutdown(0));

import { accessSync,constants,existsSync,mkdirSync,writeFileSync,unlinkSync } from "node:fs";
import { delimiter,dirname,resolve } from "node:path";
import { spawn } from "node:child_process";

const root=resolve(process.env.PULSE_APP_ROOT||process.cwd());
const dataRoot=resolve(process.env.PULSE_DATA_ROOT||resolve(root,"data"));
const python=resolve(process.env.PULSE_PYTHON_BIN||resolve(root,"harness-service/.venv/bin/python"));
const pnpm=process.env.PNPM_BIN||"pnpm";
const channelDriver=process.env.PULSE_CHANNEL_DRIVER||"lark-cli";
const larkCli=process.env.LARK_CLI_BIN||"lark-cli";
const webPort=String(process.env.PORT||3000);
const gatewayPort=String(process.env.GATEWAY_PORT||8789);
const harnessPort=String(process.env.HARNESS_PORT||8090);
const runtimeDir=resolve(dataRoot,"runtime");
const sessionRoot=resolve(process.env.DSH_SESSION_ROOT||resolve(dataRoot,"harness-sessions"));
const databasePath=resolve(process.env.PULSE_DATABASE_PATH||resolve(dataRoot,"pulse.db"));
const componentPidFile=resolve(runtimeDir,"pulse-components.json");

requireExecutable(python,"Python 虚拟环境不存在，请先运行 deploy/linux/bootstrap.sh");
if(channelDriver==="lark-cli"&&larkCli.includes("/"))requireExecutable(larkCli,"lark-cli 不存在，请先完成服务器安装与授权");
if(!existsSync(resolve(root,"dist"))&&!existsSync(resolve(root,".vinext")))throw new Error("前端生产构建不存在，请先运行 pnpm build");

mkdirSync(dirname(databasePath),{recursive:true});
mkdirSync(sessionRoot,{recursive:true});
mkdirSync(runtimeDir,{recursive:true});

const sharedEnv={
  ...process.env,
  NODE_ENV:"production",
  PORT:webPort,
  GATEWAY_PORT:gatewayPort,
  PULSE_DATABASE_PATH:databasePath,
  DSH_SESSION_ROOT:sessionRoot,
  HARNESS_API_URL:process.env.HARNESS_API_URL||`http://127.0.0.1:${harnessPort}`,
  LOCAL_GATEWAY_URL:process.env.LOCAL_GATEWAY_URL||`http://127.0.0.1:${gatewayPort}`,
  PATH:[process.env.PATH,"/usr/local/bin","/usr/bin","/bin"].filter(Boolean).join(delimiter),
};

const children=[];
let stopping=false;

function launch(name,command,args,{cwd=root,env={}}={}){
  const child=spawn(command,args,{cwd,env:{...sharedEnv,...env},stdio:"inherit"});
  children.push({name,child});
  child.once("error",(error)=>{
    console.error(`[production] ${name} 启动失败：${error.message}`);
    shutdown(1);
  });
  child.once("exit",(code,signal)=>{
    if(stopping)return;
    console.error(`[production] ${name} 已退出：${code??signal}`);
    shutdown(code||1);
  });
  return child;
}

console.log(`[production] 启动 Pulse：web=${webPort} gateway=${gatewayPort} harness=${harnessPort} channel=${channelDriver}`);
const harness=launch("harness",python,["-m","uvicorn","app:app","--host","127.0.0.1","--port",harnessPort],{
  cwd:resolve(root,"harness-service"),
  env:{DSH_SESSION_ROOT:sessionRoot},
});
const gateway=launch("gateway",process.execPath,["local-runtime/src/server.mjs"]);
const web=launch("web",pnpm,["start","--","--hostname","0.0.0.0","--port",webPort]);

writeFileSync(componentPidFile,JSON.stringify({
  supervisor:process.pid,
  startedAt:new Date().toISOString(),
  harness:harness.pid,
  gateway:gateway.pid,
  web:web.pid,
}),{mode:0o600});

function shutdown(code=0){
  if(stopping)return;
  stopping=true;
  if(existsSync(componentPidFile))unlinkSync(componentPidFile);
  for(const {child} of children)if(!child.killed)child.kill("SIGTERM");
  const force=setTimeout(()=>{
    for(const {child} of children)if(!child.killed)child.kill("SIGKILL");
    process.exit(code);
  },8000);
  force.unref();
  Promise.all(children.map(({child})=>new Promise((resolveExit)=>child.once("exit",resolveExit)))).finally(()=>process.exit(code));
}

for(const signal of ["SIGINT","SIGTERM"])process.once(signal,()=>shutdown(0));

function requireExecutable(path,message){
  try{accessSync(path,constants.X_OK);}catch{throw new Error(`${message}：${path}`);}
}

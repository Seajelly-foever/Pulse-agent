import { closeSync,existsSync,mkdirSync,openSync,readFileSync,unlinkSync,writeFileSync } from "node:fs";
import { dirname,resolve } from "node:path";
import { execFileSync,spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root=resolve(dirname(fileURLToPath(import.meta.url)),".."),dataDir=resolve(root,"local-runtime/data"),pidFile=resolve(dataDir,"pulse-daemon.pid"),componentFile=resolve(dataDir,"pulse-components.json"),outFile=resolve(dataDir,"pulse-service.log"),errorFile=resolve(dataDir,"pulse-service.error.log"),action=process.argv[2]||"status";
const runtimePath=process.env.PATH||"/usr/local/bin:/usr/bin:/bin",pnpm=process.env.PNPM_BIN||"pnpm";
mkdirSync(dataDir,{recursive:true});

function savedPid(){if(!existsSync(pidFile))return null;const value=Number(readFileSync(pidFile,"utf8").trim());return Number.isInteger(value)&&value>1?value:null;}
function alive(pid){if(!pid)return false;try{process.kill(pid,0);return true;}catch{return false;}}
function components(){if(!existsSync(componentFile))return[];try{return Object.values(JSON.parse(readFileSync(componentFile,"utf8"))).filter((value)=>Number.isInteger(value)&&value>1);}catch{return[];}}
function discoveredComponents(){const found=[];for(const port of [3000,8090,8789]){let output="";try{output=execFileSync("/usr/sbin/lsof",["-nP","-t",`-iTCP:${port}`,"-sTCP:LISTEN"],{encoding:"utf8"});}catch{continue;}for(const value of output.trim().split(/\s+/)){const pid=Number(value);if(!Number.isInteger(pid)||pid<=1)continue;try{const cwd=execFileSync("/usr/sbin/lsof",["-a","-p",String(pid),"-d","cwd","-Fn"],{encoding:"utf8"}).split("\n").find((line)=>line.startsWith("n"))?.slice(1);if(cwd===root||cwd?.startsWith(`${root}/`))found.push(pid);}catch{ /* ignore processes that disappear during discovery */ }}}return[...new Set(found)];}
async function healthy(){try{const response=await fetch("http://127.0.0.1:8789/health",{signal:AbortSignal.timeout(1200)}),body=await response.json();return response.ok&&body?.channelDriver==="lark-cli";}catch{return false;}}

if(action==="start"){
  const current=savedPid();if(alive(current)||await healthy()){console.log(`Pulse 后台服务已在运行${current?`（PID ${current}）`:""}`);process.exit(0);}if(current&&existsSync(pidFile))unlinkSync(pidFile);
  const stdout=openSync(outFile,"a"),stderr=openSync(errorFile,"a");
  const child=spawn(process.execPath,["--env-file=.env.local-agent","scripts/start-local-agent.mjs"],{cwd:root,detached:true,stdio:["ignore",stdout,stderr],env:{...process.env,PATH:runtimePath,PNPM_BIN:pnpm}});
  child.unref();closeSync(stdout);closeSync(stderr);writeFileSync(pidFile,String(child.pid),{mode:0o600});console.log(`Pulse 后台服务已启动（PID ${child.pid}）`);
}else if(action==="stop"){
  const pid=savedPid(),targets=[...new Set([...components(),...discoveredComponents()])],running=alive(pid)||targets.length>0||await healthy();if(!running){if(existsSync(pidFile))unlinkSync(pidFile);if(existsSync(componentFile))unlinkSync(componentFile);console.log("Pulse 后台服务未运行");process.exit(0);}let stopped=false;if(pid){try{process.kill(-pid,"SIGTERM");stopped=true;}catch{ /* recover individual components below */ }}for(const childPid of targets)try{process.kill(childPid,"SIGTERM");stopped=true;}catch{}if(!stopped)throw new Error("已找到 Pulse 服务，但当前终端无权停止其进程");if(existsSync(pidFile))unlinkSync(pidFile);if(existsSync(componentFile))unlinkSync(componentFile);console.log(`Pulse 后台服务已停止（${targets.length||1} 个进程）`);
}else if(action==="status"){
  const pid=savedPid();if(alive(pid)||await healthy())console.log(`Pulse 后台服务运行中${pid?`（PID ${pid}）`:""}`);else{if(existsSync(pidFile))unlinkSync(pidFile);console.log("Pulse 后台服务未运行");process.exitCode=1;}
}else{console.error("用法：node scripts/local-daemon.mjs start|status|stop");process.exitCode=1;}

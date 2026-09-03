import { execFileSync } from "node:child_process";
import { mkdirSync,readFileSync } from "node:fs";
import { dirname,resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root=resolve(dirname(fileURLToPath(import.meta.url)),"..");
const lock=JSON.parse(readFileSync(resolve(root,"integrations/dsh-community/plugins.lock.json"),"utf8"));
const targetRoot=resolve(root,"local-runtime/vendor/dsh-plugins");
mkdirSync(targetRoot,{recursive:true});

for(const plugin of lock.plugins){
  if(!/^[a-z0-9-]+$/i.test(plugin.name)||!/^[a-f0-9]{40}$/i.test(plugin.commit))throw new Error(`插件锁文件字段不合法：${plugin.name}`);
  const target=resolve(targetRoot,plugin.name);
  try{execFileSync("git",["-C",target,"rev-parse","--git-dir"],{stdio:"ignore"});}
  catch{execFileSync("git",["clone","--filter=blob:none","--no-checkout",plugin.repository,target],{stdio:"inherit"});}
  execFileSync("git",["-C",target,"fetch","--depth","1","origin",plugin.commit],{stdio:"inherit"});
  execFileSync("git",["-C",target,"checkout","--detach",plugin.commit],{stdio:"inherit"});
  const actual=execFileSync("git",["-C",target,"rev-parse","HEAD"],{encoding:"utf8"}).trim();
  if(actual!==plugin.commit)throw new Error(`${plugin.name} 校验失败：${actual}`);
  process.stdout.write(`[dsh-plugin] ${plugin.name}@${plugin.version} ${actual.slice(0,12)} downloaded, disabled\n`);
}

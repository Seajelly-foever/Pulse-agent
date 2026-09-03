import { readdirSync,readFileSync,statSync } from "node:fs";
import { dirname,relative,resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root=resolve(dirname(fileURLToPath(import.meta.url)),"../..");
const draftRoot=resolve(root,"docs/skill-review");

function skillFiles(directory){
  return readdirSync(directory).flatMap((name)=>{const path=resolve(directory,name);return statSync(path).isDirectory()?skillFiles(path):name==="SKILL.md"?[path]:[];});
}

export function bundledSkillDrafts(){
  return skillFiles(draftRoot).sort().map((path)=>{
    const sourceKey=relative(root,path).replaceAll("\\","/");
    const content=readFileSync(path,"utf8").trim();
    const frontmatter=content.match(/^---\s*\n([\s\S]*?)\n---/);
    const name=frontmatter?.[1].match(/^name:\s*(.+)$/m)?.[1]?.trim();
    const description=frontmatter?.[1].match(/^description:\s*(.+)$/m)?.[1]?.trim();
    if(!name||!description)throw new Error(`Skill 草稿缺少 name 或 description：${sourceKey}`);
    return{name,description,content,sourceKey,changeSummary:"代码同步进入草稿箱，等待人工审核发布"};
  });
}

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWebTools } from "../src/web-tools.mjs";
import { openDatabase } from "../src/db.mjs";
import { createToolRuntime } from "../src/tool-runtime.mjs";

test("SearXNG search returns a bounded normalized untrusted result",async()=>{
  let requested;
  const tools=createWebTools({provider:"searxng",searxngBaseUrl:"http://127.0.0.1:8888",fetchImpl:async(url)=>{requested=new URL(url);return new Response(JSON.stringify({results:[{title:"Official source",url:"https://example.com/article",content:"Current facts",engine:"search"},{title:"Unsafe",url:"file:///etc/passwd"}]}),{status:200,headers:{"content-type":"application/json"}});}});
  const result=await tools.search({query:"current facts",count:3});
  assert.equal(tools.searchConfigured,true);assert.equal(result.kind,"results");assert.equal(result.count,1);assert.equal(result.results[0].url,"https://example.com/article");assert.equal(result.externalContent.untrusted,true);assert.equal(requested.searchParams.get("format"),"json");
});

test("Bing search uses the audited Harness sidecar with auth and normalized results",async()=>{
  let requested,requestInit;
  const tools=createWebTools({provider:"bing",bingSearchUrl:"http://127.0.0.1:8090/v1/tools/web-search",bingRegion:"cn-zh",authSecret:"shared-secret",fetchImpl:async(url,init)=>{requested=new URL(url);requestInit=init;return new Response(JSON.stringify({provider:"bing",backend:"bing",results:[{title:"Result",url:"https://example.com/result",content:"Evidence",engine:"bing"}]}),{status:200,headers:{"content-type":"application/json"}});}});
  const result=await tools.search({query:"DeepSeek Harness",count:3});
  assert.equal(tools.searchConfigured,true);assert.equal(tools.provider,"bing");assert.equal(result.provider,"bing");assert.equal(result.backend,"bing");assert.equal(result.results[0].url,"https://example.com/result");assert.equal(result.externalContent.untrusted,true);assert.equal(requested.pathname,"/v1/tools/web-search");assert.equal(requestInit.headers.authorization,"Bearer shared-secret");assert.deepEqual(JSON.parse(requestInit.body),{query:"DeepSeek Harness",count:3,backend:"bing",region:"cn-zh"});
});

test("web fetch extracts public HTML and blocks private destinations",async()=>{
  const fetchImpl=async()=>new Response("<html><head><title>Example</title></head><body><script>ignore()</script><h1>Heading</h1><p>Useful text</p></body></html>",{status:200,headers:{"content-type":"text/html"}}),resolveHost=async()=>[{address:"93.184.216.34",family:4}],tools=createWebTools({fetchEnabled:true,fetchImpl,resolveHost});
  const page=await tools.fetchPage({url:"https://example.com/article",maxChars:5000});
  assert.equal(page.title,"Example");assert.match(page.text,/Heading/);assert.match(page.text,/Useful text/);assert.doesNotMatch(page.text,/ignore/);assert.equal(page.externalContent.untrusted,true);
  const blocked=createWebTools({fetchEnabled:true,fetchImpl,resolveHost:async()=>[{address:"127.0.0.1",family:4}]});
  await assert.rejects(()=>blocked.fetchPage({url:"http://internal.example/secret"}),/禁止读取本机或内网地址/);
});

test("unconfigured search is absent instead of pretending to work",()=>{
  const tools=createWebTools({provider:"",searxngBaseUrl:""});
  assert.equal(tools.searchConfigured,false);assert.equal(tools.search,null);assert.equal(tools.fetchConfigured,false);assert.equal(tools.fetchPage,null);
});

test("tool catalog exposes web capabilities only when an implementation is configured",()=>{
  const dir=mkdtempSync(join(tmpdir(),"pulse-web-catalog-"));
  try{
    const store=openDatabase(join(dir,"pulse.db"));store.seedRuntime({model:"deepseek-v4-flash"});
    assert.equal(createToolRuntime({store}).catalog("personal-agent").some((tool)=>tool.name==="web_search"),false);
    const runtime=createToolRuntime({store,webSearch:async()=>({kind:"results",results:[]}),webFetch:async()=>({kind:"page",text:""})}),names=runtime.catalog("personal-agent").map((tool)=>tool.name);
    assert.ok(names.includes("web_search"));assert.ok(names.includes("web_fetch"));
  }finally{rmSync(dir,{recursive:true,force:true});}
});

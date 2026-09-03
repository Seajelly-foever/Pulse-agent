import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const DEFAULT_TIMEOUT_MS=15000;
const DEFAULT_MAX_BYTES=750000;

export function createWebTools({provider="",searxngBaseUrl="",bingSearchUrl="",bingRegion="cn-zh",authSecret="",fetchEnabled=false,fetchImpl=fetch,resolveHost=lookup,timeoutMs=DEFAULT_TIMEOUT_MS,maxBytes=DEFAULT_MAX_BYTES}={}){
  const normalizedProvider=String(provider||"").trim().toLowerCase();
  const bingProvider=["bing","ddgs"].includes(normalizedProvider),searchConfigured=(normalizedProvider==="searxng"&&Boolean(String(searxngBaseUrl||"").trim()))||(bingProvider&&Boolean(String(bingSearchUrl||"").trim()));
  return{
    provider:searchConfigured?bingProvider?"bing":normalizedProvider:null,
    searchConfigured,
    fetchConfigured:Boolean(fetchEnabled),
    search:searchConfigured?bingProvider?async(input)=>searchBing(input,{url:bingSearchUrl,region:bingRegion,authSecret,fetchImpl,timeoutMs}):async(input)=>searchSearxng(input,{baseUrl:searxngBaseUrl,fetchImpl,timeoutMs}):null,
    fetchPage:fetchEnabled?async(input)=>fetchPublicPage(input,{fetchImpl,resolveHost,timeoutMs,maxBytes}):null,
  };
}

async function searchBing(input,{url,region,authSecret,fetchImpl,timeoutMs}){
  const query=boundedText(input?.query,500,"搜索词不能为空"),count=boundedInt(input?.count,1,10,5),endpoint=validateHttpUrl(url,"PULSE_BING_SEARCH_URL");
  const response=await fetchImpl(endpoint,{method:"POST",headers:{accept:"application/json","content-type":"application/json",...(authSecret?{authorization:`Bearer ${authSecret}`}:{})},body:JSON.stringify({query,count,backend:"bing",region:String(region||regionForLanguage(input?.language))}),signal:AbortSignal.timeout(timeoutMs)});
  if(!response.ok){const detail=await response.text();throw new Error(`Bing 搜索失败：HTTP ${response.status} ${detail.slice(0,300)}`);}
  const payload=await response.json(),results=Array.isArray(payload?.results)?payload.results.slice(0,count).map(normalizeSearchResult).filter(Boolean):[];
  return{kind:"results",provider:"bing",backend:"bing",query,count:results.length,results,externalContent:{untrusted:true,source:"web_search",wrapped:true},retrievedAt:new Date().toISOString()};
}

async function searchSearxng(input,{baseUrl,fetchImpl,timeoutMs}){
  const query=boundedText(input?.query,500,"搜索词不能为空"),count=boundedInt(input?.count,1,10,5),language=boundedText(input?.language||"zh-CN",24),categories=boundedText(input?.categories||"general",80);
  const endpoint=new URL("/search",validateBaseUrl(baseUrl));
  endpoint.searchParams.set("q",query);endpoint.searchParams.set("format","json");endpoint.searchParams.set("language",language);endpoint.searchParams.set("categories",categories);
  const response=await fetchImpl(endpoint,{headers:{accept:"application/json"},signal:AbortSignal.timeout(timeoutMs)});
  if(!response.ok)throw new Error(`SearXNG 搜索失败：HTTP ${response.status}`);
  const payload=await response.json(),results=Array.isArray(payload?.results)?payload.results.slice(0,count).map(normalizeSearchResult).filter(Boolean):[];
  return{kind:"results",provider:"searxng",query,count:results.length,results,externalContent:{untrusted:true,source:"web_search",wrapped:true},retrievedAt:new Date().toISOString()};
}

async function fetchPublicPage(input,{fetchImpl,resolveHost,timeoutMs,maxBytes}){
  const requested=new URL(boundedText(input?.url,2048,"URL 不能为空"));
  const extractMode=input?.extractMode==="text"?"text":"markdown",maxChars=boundedInt(input?.maxChars,1000,30000,16000);
  let current=requested;
  for(let redirects=0;redirects<=3;redirects++){
    await assertPublicHttpUrl(current,resolveHost);
    const response=await fetchImpl(current,{redirect:"manual",headers:{accept:"text/html,application/xhtml+xml,text/plain;q=0.9","user-agent":"PulseAgent/1.0 (+web-fetch)"},signal:AbortSignal.timeout(timeoutMs)});
    if(response.status>=300&&response.status<400&&response.headers.get("location")){if(redirects===3)throw new Error("网页重定向次数超过上限");current=new URL(response.headers.get("location"),current);continue;}
    if(!response.ok)throw new Error(`网页读取失败：HTTP ${response.status}`);
    const contentType=String(response.headers.get("content-type")||"").toLowerCase();
    if(!/(text\/html|application\/xhtml\+xml|text\/plain)/.test(contentType))throw new Error(`不支持的网页类型：${contentType||"unknown"}`);
    const raw=await readBoundedBody(response,maxBytes),title=extractTitle(raw),clean=contentType.includes("text/plain")?raw:htmlToText(raw),text=(extractMode==="markdown"?toLightMarkdown(clean):clean).slice(0,maxChars);
    return{kind:"page",url:requested.toString(),finalUrl:current.toString(),status:response.status,title,contentType,extractMode,text,truncated:clean.length>maxChars,externalContent:{untrusted:true,source:"web_fetch",wrapped:true},fetchedAt:new Date().toISOString()};
  }
  throw new Error("网页读取失败");
}

async function assertPublicHttpUrl(url,resolveHost){
  if(!["http:","https:"].includes(url.protocol))throw new Error("只允许读取 HTTP(S) URL");
  if(url.username||url.password)throw new Error("URL 不得包含用户名或密码");
  const host=url.hostname.toLowerCase();if(host==="localhost"||host.endsWith(".localhost")||host.endsWith(".local"))throw new Error("禁止读取本机或内网地址");
  const addresses=isIP(host)?[{address:host}]:await resolveHost(host,{all:true,verbatim:true});
  if(!addresses.length||addresses.some((entry)=>isPrivateAddress(entry.address)))throw new Error("禁止读取本机或内网地址");
}

function isPrivateAddress(address){
  const value=String(address).toLowerCase();
  if(value.includes(":"))return value==="::1"||value==="::"||value.startsWith("fc")||value.startsWith("fd")||/^fe[89ab]/.test(value)||value.startsWith("::ffff:127.")||value.startsWith("::ffff:10.")||value.startsWith("::ffff:192.168.");
  const parts=value.split(".").map(Number);if(parts.length!==4||parts.some(Number.isNaN))return true;
  return parts[0]===0||parts[0]===10||parts[0]===127||parts[0]>=224||(parts[0]===169&&parts[1]===254)||(parts[0]===172&&parts[1]>=16&&parts[1]<=31)||(parts[0]===192&&parts[1]===168)||(parts[0]===100&&parts[1]>=64&&parts[1]<=127)||(parts[0]===198&&(parts[1]===18||parts[1]===19));
}

async function readBoundedBody(response,maxBytes){
  const declared=Number(response.headers.get("content-length")||0);if(declared>maxBytes)throw new Error("网页正文超过大小上限");
  const reader=response.body?.getReader?.();if(!reader)return(await response.text()).slice(0,maxBytes);
  const chunks=[];let size=0;for(;;){const{done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>maxBytes){await reader.cancel();throw new Error("网页正文超过大小上限");}chunks.push(value);}return new TextDecoder().decode(concat(chunks,size));
}

function concat(chunks,size){const output=new Uint8Array(size);let offset=0;for(const chunk of chunks){output.set(chunk,offset);offset+=chunk.byteLength;}return output;}
function validateBaseUrl(value){return validateHttpUrl(value,"SEARXNG_BASE_URL");}
function validateHttpUrl(value,name){const url=new URL(String(value));if(!["http:","https:"].includes(url.protocol))throw new Error(`${name} 必须是 HTTP(S) URL`);return url;}
function normalizeSearchResult(item){try{const url=new URL(String(item?.url||item?.href||""));if(!["http:","https:"].includes(url.protocol))return null;return{title:String(item?.title||url.hostname).slice(0,300),url:url.toString(),snippet:String(item?.content||item?.snippet||item?.body||"").slice(0,1200),published:item?.publishedDate||item?.published_date||undefined,siteName:String(item?.engine||url.hostname).slice(0,120)};}catch{return null;}}
function regionForLanguage(language){const value=String(language||"").toLowerCase();return value.startsWith("zh")?"cn-zh":"us-en";}
function extractTitle(html){const match=String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i);return decodeEntities(match?.[1]||"").replace(/\s+/g," ").trim().slice(0,300)||undefined;}
function htmlToText(html){return decodeEntities(String(html).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi," ").replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi," ").replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi," ").replace(/<\/(?:p|div|article|section|h[1-6]|li|tr|blockquote)>/gi,"\n").replace(/<br\s*\/?>/gi,"\n").replace(/<[^>]+>/g," ")).replace(/[ \t]+/g," ").replace(/\n{3,}/g,"\n\n").trim();}
function toLightMarkdown(text){return String(text).split("\n").map((line)=>line.trim()).filter(Boolean).join("\n\n");}
function decodeEntities(value){return String(value).replace(/&nbsp;/gi," ").replace(/&amp;/gi,"&").replace(/&lt;/gi,"<").replace(/&gt;/gi,">").replace(/&quot;/gi,'"').replace(/&#39;|&apos;/gi,"'").replace(/&#(\d+);/g,(_m,n)=>String.fromCodePoint(Number(n)));}
function boundedText(value,max,message="字段不能为空"){const text=String(value||"").trim();if(!text)throw new Error(message);return text.slice(0,max);}
function boundedInt(value,min,max,fallback){const number=Number(value);return Number.isFinite(number)?Math.min(max,Math.max(min,Math.floor(number))):fallback;}

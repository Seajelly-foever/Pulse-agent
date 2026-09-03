const namedEntities={amp:"&",lt:"<",gt:">",quot:'"',apos:"'",nbsp:" ",ensp:" ",emsp:" ",middot:"·"};

function decodeEntities(value){
  return String(value||"")
    .replace(/&#x([0-9a-f]+);?/gi,(_,hex)=>safeCodePoint(Number.parseInt(hex,16)))
    .replace(/&#(\d+);?/g,(_,decimal)=>safeCodePoint(Number.parseInt(decimal,10)))
    .replace(/&([a-z]+);/gi,(match,name)=>namedEntities[name.toLowerCase()]??match);
}

function safeCodePoint(value){try{return Number.isFinite(value)?String.fromCodePoint(value):""}catch{return""}}

/** Normalize model-extracted text before it crosses the Task Service boundary. */
export function cleanStructuredText(value,{maxLength=1000,fallback=""}={}){
  let text=String(value??"").replace(/^\uFEFF/,"").trim();
  if(!text)return fallback;
  for(let index=0;index<2;index++)text=decodeEntities(text);
  text=text
    .replace(/```(?:html|xml|json|markdown|md|text)?\s*/gi,"")
    .replace(/```/g,"")
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi," ")
    .replace(/<cite\b([^>]*)>[\s\S]*?<\/cite>/gi,(_,attributes)=>attributeValue(attributes,"title")||" ")
    .replace(/<cite\b([^>]*)\/?\s*>/gi,(_,attributes)=>attributeValue(attributes,"title")||" ")
    .replace(/<br\s*\/?>/gi,"\n")
    .replace(/<\/?t[dh]\b[^>]*>/gi,"\t")
    .replace(/<\/(?:tr|p|div|li|ul|ol|table|thead|tbody|blockquote|h[1-6])\s*>/gi,"\n")
    .replace(/<\/?[a-z][^>\n]*>?/gi," ");
  text=decodeEntities(text)
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g,"")
    .split(/\r?\n/)
    .map((line)=>line.replace(/[\t ]+/g," ").replace(/\s+([，。；：！？,.!?;:])/g,"$1").trim())
    .filter(Boolean)
    .filter((line,index,lines)=>index===0||line!==lines[index-1])
    .join("\n")
    .replace(/\n{3,}/g,"\n\n")
    .trim();
  return (text||fallback).slice(0,Math.max(1,Number(maxLength)||1000));
}

function attributeValue(attributes,name){
  const match=String(attributes||"").match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,"i"));
  return match?decodeEntities(match[1]??match[2]??match[3]??""):"";
}

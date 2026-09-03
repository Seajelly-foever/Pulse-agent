const WEEKDAYS=new Set([0,1,2,3,4,5,6]);

export function normalizeSchedule(input={},fallbackTimezone="Asia/Shanghai"){
  const type=["daily","weekly","once"].includes(String(input.type))?String(input.type):"daily";
  const time=/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(input.time||""))?String(input.time):"21:00";
  const weekdays=[...new Set((Array.isArray(input.weekdays)?input.weekdays:[]).map(Number).filter((value)=>WEEKDAYS.has(value)))];
  const onceDate=type==="once"&&input.runAt?new Date(input.runAt):null,runAt=onceDate&&Number.isFinite(onceDate.getTime())?onceDate.toISOString():null;
  return{type,time,weekdays:type==="weekly"?weekdays:[],runAt,timezone:String(input.timezone||fallbackTimezone||"Asia/Shanghai")};
}

export function nextScheduledOccurrence(input,from=new Date(),fallbackTimezone="Asia/Shanghai"){
  const schedule=normalizeSchedule(input,fallbackTimezone),after=from instanceof Date?from:new Date(from);
  if(schedule.type==="once"){
    const target=schedule.runAt?new Date(schedule.runAt):null;
    return target&&Number.isFinite(target.getTime())&&target.getTime()>after.getTime()?target.toISOString():null;
  }
  if(schedule.type==="weekly"&&!schedule.weekdays.length)return null;
  const [hour,minute]=schedule.time.split(":").map(Number),start=(Math.floor(after.getTime()/60000)+1)*60000,maxMinutes=8*24*60;
  for(let offset=0;offset<=maxMinutes;offset++){
    const candidate=new Date(start+offset*60000),parts=localParts(candidate,schedule.timezone);
    if(parts.hour!==hour||parts.minute!==minute)continue;
    if(schedule.type==="weekly"&&!schedule.weekdays.includes(parts.weekday))continue;
    return candidate.toISOString();
  }
  return null;
}

export function scheduleLabel(input){
  const schedule=normalizeSchedule(input),weekdayNames=["周日","周一","周二","周三","周四","周五","周六"];
  if(schedule.type==="once")return schedule.runAt?`单次 · ${schedule.runAt}`:"单次 · 时间待确认";
  if(schedule.type==="weekly")return`${schedule.weekdays.map((day)=>weekdayNames[day]).join("、")} ${schedule.time}`;
  return`每天 ${schedule.time}`;
}

function localParts(date,timeZone){
  const values=new Intl.DateTimeFormat("en-CA",{timeZone,weekday:"short",year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).formatToParts(date).reduce((out,item)=>{out[item.type]=item.value;return out;},{}),weekdays={Sun:0,Mon:1,Tue:2,Wed:3,Thu:4,Fri:5,Sat:6};
  return{weekday:weekdays[values.weekday],hour:Number(values.hour),minute:Number(values.minute),date:`${values.year}-${values.month}-${values.day}`};
}

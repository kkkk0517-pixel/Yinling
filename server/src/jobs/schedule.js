/** 纯周期计算：只提供到期/下一边界，不决定启动补跑或执行任务。 */
const { signalTime,signalDay,dayRange }=require('../utils/signal-day');
const OFFSET=8*60*60*1000;
function integer(raw,fallback,name,min,max=Number.MAX_SAFE_INTEGER){
  if(raw!==undefined&&(raw===null||String(raw).trim()===''))throw new RangeError(name+' 不能为空');
  const value=Number(raw===undefined?fallback:raw);
  if(!Number.isSafeInteger(value)||value<min||value>max)throw new RangeError(name+' 不合法');
  return value;
}
function periodAt(id,at,options={}){
  const timestamp=signalTime(at);
  if(id==='T1'||id==='T3'){
    const hour=id==='T1'?integer(options.dayCutHour,4,'dayCutHour',0,23):integer(options.baselineHour,3,'baselineHour',0,23);
    const date=signalDay(timestamp,hour),range=dayRange(date,hour);
    return {key:`${id}:daily:${date}:${hour}`,dueAt:range.start,nextAt:range.end};
  }
  if(id!=='T2'&&id!=='T4')throw new TypeError('未知定时任务');
  const step=id==='T2'?integer(options.slaSeconds,30,'slaSeconds',1)*1000:integer(options.stratifyMinutes,60,'stratifyMinutes',1)*60000;
  if(!Number.isSafeInteger(step))throw new RangeError('任务间隔过大');
  const ms=new Date(timestamp.replace(' ','T')+'+08:00').getTime();
  const bucket=Math.floor((ms+OFFSET)/step),due=bucket*step-OFFSET;
  return {key:`${id}:every:${step}:${bucket}`,dueAt:signalTime(new Date(due)),nextAt:signalTime(new Date(due+step))};
}
module.exports={periodAt};

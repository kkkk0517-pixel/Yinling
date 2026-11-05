/** 内部执行器；构造无副作用，启动策略由调用方显式指定。 */
const {periodAt}=require('./schedule');
const {now}=require('../utils/time');
const {signalTime}=require('../utils/signal-day');
const IDS=['T1','T2','T3','T4'];
function safeErrorCode(error){
  const code=error?.code;
  if(typeof code==='string'&&(/^(ER_[A-Z0-9_]{1,50})$/.test(code)||['ECONNREFUSED','ETIMEDOUT','ECONNRESET','EPIPE','ENOTFOUND','EACCES'].includes(code)))return code;
  return error instanceof RangeError?'INVALID_CONFIGURATION':'TASK_FAILED';
}
function createScheduler({tasks,businessNow=now,realNow=Date.now,schedule={},pollMs=250,retryMs=30000,restored={},
  setTimer=setTimeout,clearTimer=clearTimeout,logger=record=>console.error(JSON.stringify(record)),onEvent}={}){
  for(const id of IDS)if(typeof tasks?.[id]!=='function')throw new TypeError(id+' task handler is required');
  if(!Number.isSafeInteger(pollMs)||pollMs<1||!Number.isSafeInteger(retryMs)||retryMs<1)throw new RangeError('pollMs/retryMs 不合法');
  const states=Object.fromEntries(IDS.map(id=>[id,{running:false,lastPeriodKey:null,lastScheduledAt:null,lastStartedAt:null,lastSucceededAt:null,lastFailedAt:null,lastFinishedAt:null,
    lastBusinessAt:null,lastErrorCode:null,lastStoreErrorCode:null,lastLogErrorCode:null,attempts:0,failures:0,consecutiveFailures:0,blockedOn:null,retryAt:0,successMs:null}]));
  for(const id of IDS){const previous=restored[id];if(!previous)continue;for(const field of ['lastScheduledAt','lastStartedAt','lastSucceededAt','lastFailedAt','lastFinishedAt','lastBusinessAt','lastErrorCode','lastStoreErrorCode','lastLogErrorCode'])if(previous[field]!==undefined)states[id][field]=previous[field];
    for(const field of ['attempts','failures','consecutiveFailures'])if(Number.isSafeInteger(previous[field])&&previous[field]>=0)states[id][field]=previous[field];
    const ms=new Date(String(previous.lastSucceededAt).replace(' ','T')+'+08:00').getTime();if(Number.isFinite(ms))states[id].successMs=ms;
  }
  let running=false,stopping=false,timer=null,daily=null,stopPromise=null;
  const pending=new Set();
  const realStamp=()=>signalTime(new Date(realNow()));
  function track(promise){pending.add(promise);promise.then(()=>pending.delete(promise),()=>pending.delete(promise));return promise;}
  function log(id,event,code){try{logger({jobId:id,event,code,at:realStamp(),businessAt:states[id].lastBusinessAt});}catch{states[id].lastLogErrorCode='LOG_SINK_FAILED';}}
  async function emit(id,event){
    if(!onEvent)return;
    try{const snapshot=structuredClone(states[id]);if(event!=='started')snapshot.running=false;await onEvent({jobId:id,event,state:snapshot});states[id].lastStoreErrorCode=null;}
    catch{states[id].lastStoreErrorCode='HEALTH_STORE_FAILED';log(id,'health_store_failed','HEALTH_STORE_FAILED');}
  }
  function fail(id,error){
    const state=states[id];state.lastFailedAt=realStamp();state.lastFinishedAt=state.lastFailedAt;state.lastErrorCode=safeErrorCode(error);
    state.failures++;state.consecutiveFailures++;state.retryAt=realNow()+retryMs;log(id,'failed',state.lastErrorCode);
  }
  function period(id){
    try{const at=signalTime(businessNow());return {...periodAt(id,at,schedule),businessAt:at};}
    catch(error){if(realNow()>=states[id].retryAt){fail(id,error);track(emit(id,'failed'));}return null;}
  }
  function needs(id,p){return !!p&&states[id].lastPeriodKey!==p.key;}
  function eligible(id,p){return needs(id,p)&&!states[id].running&&realNow()>=states[id].retryAt;}
  async function execute(id,p){
    const state=states[id];state.running=true;state.blockedOn=null;state.attempts++;state.lastScheduledAt=p.dueAt;state.lastStartedAt=realStamp();state.lastBusinessAt=p.businessAt;
    await emit(id,'started');
    let succeeded=false;
    try{await tasks[id](state.lastBusinessAt);state.lastPeriodKey=p.key;state.lastSucceededAt=realStamp();state.lastFinishedAt=state.lastSucceededAt;
      state.successMs=realNow();state.lastErrorCode=null;state.consecutiveFailures=0;state.retryAt=0;succeeded=true;}
    catch(error){fail(id,error);}
    finally{await emit(id,succeeded?'succeeded':'failed');state.running=false;}
    return succeeded;
  }
  async function dailyChain(){
    for(const id of ['T1','T3','T4']){
      if(!running)break;
      const p=period(id);if(!eligible(id,p))continue;
      if(id==='T4'){const cut=period('T1');if(!cut||needs('T1',cut)){states.T4.blockedOn='T1';continue;}}
      await track(execute(id,p));
    }
  }
  function tick(){
    if(!running)return Promise.resolve([]);
    const launched=[],sla=period('T2');
    if(eligible('T2',sla))launched.push(track(execute('T2',sla)));
    if(!daily){const current=dailyChain();daily=current;track(current);current.then(()=>{if(daily===current)daily=null;},()=>{if(daily===current)daily=null;});launched.push(current);}
    return Promise.allSettled(launched);
  }
  function arm(){
    if(!running)return;
    timer=setTimer(()=>{timer=null;if(!running)return;tick();arm();},pollMs);
    timer?.unref?.();
  }
  function start(options){
    if(typeof options?.runCurrent!=='boolean')throw new TypeError('runCurrent startup policy must be explicit');
    if(stopping)throw new Error('scheduler is draining');
    if(running)return Promise.resolve([]);
    running=true;stopPromise=null;
    if(!options.runCurrent)for(const id of IDS){const p=period(id);if(p)states[id].lastPeriodKey=p.key;}
    const first=tick();arm();return first;
  }
  function stop(){
    if(stopPromise)return stopPromise;
    running=false;stopping=true;if(timer!==null){clearTimer(timer);timer=null;}
    stopPromise=Promise.allSettled([...pending]).then(()=>{stopping=false;});return stopPromise;
  }
  function getHealth(){
    const tasksHealth={};
    for(const id of IDS){const state=states[id];let current=null;try{current=periodAt(id,businessNow(),schedule);}catch{}
      const stale=state.successMs===null||!current||(id==='T2'?realNow()-state.successMs>120000:state.lastPeriodKey!==current.key);
      const healthy=running&&!stale&&state.consecutiveFailures===0&&!state.lastStoreErrorCode&&!state.lastLogErrorCode;
      tasksHealth[id]={...state,healthy,stale};delete tasksHealth[id].successMs;}
    return structuredClone({running,stopping,tasks:tasksHealth});
  }
  function updateSchedule(next){const merged={...schedule,...next};for(const id of IDS)periodAt(id,businessNow(),merged);Object.assign(schedule,merged);}
  return {start,tick,stop,getHealth,updateSchedule};
}
module.exports={createScheduler,safeErrorCode};

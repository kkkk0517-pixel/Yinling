/** 托管调度生命周期。只有所有权连接仍有效的实例启动循环。 */
const config=require('../config');
const {businessClock}=require('../utils/business-clock');
const {createScheduler,safeErrorCode}=require('./scheduler');
const store=require('../services/job-store');
const {synchronizeClock}=require('../services/clock-control');
const {periodAt}=require('./schedule');
const IDS=['T1','T2','T3','T4'];
function defaultTasks(clock){return {
  T1:at=>require('./day-cut').runDayCut(at),T2:at=>require('./sla').runSlaScan(at),T3:at=>require('./baseline').runBaseline(at),
  T4:async at=>{await require('./stratification').runStratification(at);return require('./routing').runRouting(clock.now());},
};}
function createJobRuntime(options={}){
  const enabled=options.enabled??config.jobs.enabled,clock=options.clock??businessClock,realNow=options.realNow??(()=>Date.now());
  const pollMs=options.pollMs??config.jobs.pollMs,retryMs=options.retryMs??config.jobs.retryMs;
  const tasks=options.tasks??defaultTasks(clock),logger=options.logger??(record=>console.error(JSON.stringify(record)));
  const schedule={slaSeconds:config.jobs.slaSeconds,baselineHour:config.jobs.baselineHour,stratifyMinutes:config.jobs.stratifyMinutes,...options.schedule};
  let state='not_started',engine=null,lease=null,ownership=null,clockReady=false,clockSync=null,starting=null,retryTimer=null,stopped=false,stopping=false,stopPromise=null,lastErrorCode=null,history={};
  function syncClock(){if(clockSync)return clockSync;const synchronizedLease=lease;clockSync=synchronizeClock(clock,{onReady:({dayCutHour})=>{schedule.dayCutHour=dayCutHour;}}).then(value=>{clockReady=lease===synchronizedLease;return value;}).catch(error=>{clockReady=false;throw error;}).finally(()=>{clockSync=null;});return clockSync;}
  async function ensureClock(){if(!clockSync&&lease?.alive()&&clockReady)return;await syncClock();if(lease?.alive()&&!clockReady)await syncClock();}
  function log(event,error){lastErrorCode=safeErrorCode(error);try{logger({event,code:lastErrorCode});}catch{lastErrorCode='LOG_SINK_FAILED';}}
  function later(){if(stopped||!enabled||retryTimer)return;retryTimer=setTimeout(()=>{retryTimer=null;if(starting){starting.then(later,later);return;}start();},retryMs);retryTimer.unref?.();}
  function lost(error,token){if(stopped||ownership!==token)return;state='degraded';log('scheduler_ownership_lost',error);const old=token.lease;ownership=null;if(lease===old)lease=null;
    Promise.resolve(engine?.stop()).then(()=>old?.release()).catch(()=>{}).finally(later);
  }
  async function initialize(){
    history=await store.readJobHistory();
    if(stopped)return false;
    if(!enabled){await syncClock();state='disabled';return false;}
    const token={lease:null};ownership=token;const acquired=await store.acquireOwner(error=>lost(error,token));token.lease=acquired;
    if(stopped){lease=acquired;return false;}
    if(ownership!==token||(acquired&&!acquired.alive())){await acquired?.release();return false;}
    lease=acquired;
    if(!lease){ownership=null;await syncClock();state='standby';later();return false;}
    // 旧请求的同步不能代表新 owner：等旧连接收尾后，在本次所有权下重新恢复。
    clockReady=false;if(clockSync)await clockSync;
    if(stopped)return false;
    await syncClock();
    if(stopped)return false;
    if(ownership!==token||lease!==acquired||!acquired.alive()){await acquired.release();if(lease===acquired)lease=null;return false;}
    engine=createScheduler({tasks,businessNow:()=>clock.now(),realNow,schedule,pollMs,retryMs,logger,onEvent:store.recordJobEvent,restored:history});
    state='running';lastErrorCode=null;await engine.start({runCurrent:true});return true;
  }
  function start(){
    if(stopping)return Promise.reject(new Error('runtime is stopping'));
    if(starting)return starting;
    if(state==='running'&&lease?.alive())return Promise.resolve(true);
    stopped=false;stopPromise=null;clockReady=false;if(retryTimer){clearTimeout(retryTimer);retryTimer=null;}state='starting';
    starting=initialize().catch(async error=>{if(stopped)return false;state='degraded';log('scheduler_start_failed',error);await lease?.release().catch(()=>{});lease=null;ownership=null;later();return false;}).finally(()=>{starting=null;});return starting;
  }
  async function stop({drain=Promise.resolve()}={}){
    if(stopPromise)return stopPromise;
    stopped=true;stopping=true;if(retryTimer){clearTimeout(retryTimer);retryTimer=null;}
    stopPromise=(async()=>{await engine?.stop();await starting;await engine?.stop();await drain;await lease?.release();lease=null;ownership=null;state='stopped';stopping=false;})();return stopPromise;
  }
  function getHealth(){
    let snapshot=engine?.getHealth();
    if(!snapshot){const idle=createScheduler({tasks,businessNow:()=>clock.now(),realNow,schedule,pollMs,retryMs,restored:history,logger:()=>{}});snapshot=idle.getHealth();}
    return {version:'jobs-v1',state,enabled,running:state==='running'&&snapshot.running,owning:!!lease?.alive(),lastErrorCode,
      businessTime:clock.now(),timeScale:clock.snapshot().scale,tasks:snapshot.tasks};
  }
  function updateScheduleFrom(params){const raw=params.day_cut_hour??4;if(String(raw).trim()==='')throw new RangeError('day_cut_hour 不合法');const next={...schedule,dayCutHour:Number(raw)};for(const id of IDS)periodAt(id,clock.now(),next);Object.assign(schedule,next);engine?.updateSchedule(next);}
  function clearAfterDataReset(){if(enabled&&!stopped)throw new Error('先停止自动调度');engine=null;history={};lastErrorCode=null;clock.reset();clockReady=true;state=enabled?'stopped':'disabled';}
  return {start,stop,tick:()=>stopped||state==='disabled'?Promise.resolve([]):state==='running'?engine.tick():start(),getHealth,ensureClock,updateScheduleFrom,clearAfterDataReset,isStarted:()=>enabled&&!stopped&&state!=='not_started',ownerId:()=>lease?.alive()?lease.connectionId:null};
}
module.exports={createJobRuntime};

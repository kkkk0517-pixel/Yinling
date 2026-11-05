const test=require('node:test');
const assert=require('node:assert/strict');
const {signalTime}=require('../src/utils/signal-day');
let scheduling={};
try{scheduling=require('../src/jobs/scheduler');}catch(error){if(error.code!=='MODULE_NOT_FOUND')throw error;}
function deferred(){let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};}
function harness(overrides={}){
  assert.equal(typeof scheduling.createScheduler,'function','internal scheduler is implemented');
  let ms=new Date('2026-11-05T04:00:00+08:00').getTime(),timer,clears=0;
  const calls=[],logs=[];
  const tasks=Object.fromEntries(['T1','T2','T3','T4'].map(id=>[id,async at=>{calls.push([id,at]);}]));
  const {tasks:taskOverrides,...otherOptions}=overrides;
  const scheduler=scheduling.createScheduler({tasks:{...tasks,...taskOverrides},businessNow:()=>signalTime(new Date(ms)),realNow:()=>ms,
    setTimer:fn=>{timer=fn;return 1;},clearTimer:()=>{clears++;timer=null;},logger:record=>logs.push(record),retryMs:30000,...otherOptions});
  return {scheduler,calls,logs,advance:amount=>{ms+=amount;},fire:()=>timer?.(),get clears(){return clears;}};
}

test('startup policy must be explicit and constructing a scheduler performs no work',()=>{
  const h=harness();assert.deepEqual(h.calls,[]);assert.throws(()=>h.scheduler.start(),/runCurrent/);
});
test('an explicit current-period run executes T2 independently and daily jobs in order',async()=>{
  const h=harness();await h.scheduler.start({runCurrent:true});
  assert.equal(h.calls[0][0],'T2');assert.deepEqual(h.calls.filter(c=>c[0]!=='T2').map(c=>c[0]),['T1','T3','T4']);await h.scheduler.stop();
});
test('future-only startup performs no catchup and then runs the next interval',async()=>{
  const h=harness();await h.scheduler.start({runCurrent:false});assert.equal(h.calls.length,0);
  h.advance(30000);await h.scheduler.tick();assert.deepEqual(h.calls.map(c=>c[0]),['T2']);await h.scheduler.stop();
});
test('repeated ticks in one period do not repeat successful work',async()=>{
  const h=harness();await h.scheduler.start({runCurrent:true});await Promise.all([h.scheduler.tick(),h.scheduler.tick(),h.scheduler.tick()]);
  assert.equal(h.calls.length,4);await h.scheduler.stop();
});
test('a slow daily job neither overlaps itself nor blocks a due T2 scan',async()=>{
  const gate=deferred();let dayCalls=0;
  const h=harness({tasks:{T1:async()=>{dayCalls++;await gate.promise;}}});
  const starting=h.scheduler.start({runCurrent:true});await new Promise(setImmediate);
  h.advance(30000);await h.scheduler.tick();assert.equal(dayCalls,1);assert.equal(h.calls.filter(c=>c[0]==='T2').length,2);
  gate.resolve();await starting;await h.scheduler.stop();
});
test('overlapping interval ticks do not reenter a running task',async()=>{
  const gate=deferred();let calls=0;
  const h=harness({tasks:{T2:async()=>{calls++;await gate.promise;}}});const start=h.scheduler.start({runCurrent:true});await new Promise(setImmediate);
  h.advance(90000);await h.scheduler.tick();assert.equal(calls,1);gate.resolve();await start;
  await h.scheduler.tick();assert.equal(calls,2);await h.scheduler.stop();
});
test('failed work stays failed, logs a safe code and retries after backoff',async()=>{
  let attempts=0;const h=harness({tasks:{T2:async()=>{attempts++;if(attempts===1)throw Object.assign(new Error('private-value-do-not-log'),{code:'ECONNREFUSED'});}}});
  await h.scheduler.start({runCurrent:true});let state=h.scheduler.getHealth().tasks.T2;
  assert.equal(state.failures,1);assert.equal(state.lastSucceededAt,null);assert.equal(state.lastErrorCode,'ECONNREFUSED');
  assert.equal(h.logs.filter(log=>log.event==='failed').length,1);assert.doesNotMatch(JSON.stringify(h.logs),/private-value/);
  h.advance(29999);await h.scheduler.tick();assert.equal(attempts,1);
  h.advance(1);await h.scheduler.tick();state=h.scheduler.getHealth().tasks.T2;assert.equal(attempts,2);assert.equal(state.consecutiveFailures,0);assert.ok(state.lastSucceededAt);await h.scheduler.stop();
});
test('a failed cut blocks dependent stratification while SLA keeps running',async()=>{
  let fail=true;const h=harness({tasks:{T1:async()=>{if(fail)throw new RangeError('bad cut');}}});
  await h.scheduler.start({runCurrent:true});assert.equal(h.calls.filter(c=>c[0]==='T4').length,0);
  assert.equal(h.scheduler.getHealth().tasks.T4.blockedOn,'T1');fail=false;h.advance(30000);await h.scheduler.tick();
  assert.equal(h.calls.filter(c=>c[0]==='T2').length,2);assert.equal(h.calls.filter(c=>c[0]==='T4').length,1);await h.scheduler.stop();
});
test('a baseline failure does not block an independent stratification calculation',async()=>{
  const h=harness({tasks:{T3:async()=>{throw new Error('baseline failed');}}});await h.scheduler.start({runCurrent:true});
  assert.equal(h.calls.filter(c=>c[0]==='T4').length,1);assert.equal(h.scheduler.getHealth().tasks.T3.failures,1);await h.scheduler.stop();
});
test('a large clock jump runs only the latest interval, not all missed ticks',async()=>{
  const h=harness();await h.scheduler.start({runCurrent:true});h.advance(6*3600000);await h.scheduler.tick();
  assert.equal(h.calls.filter(c=>c[0]==='T2').length,2);assert.equal(h.calls.filter(c=>c[0]==='T4').length,2);await h.scheduler.stop();
});
test('health becomes stale without successful SLA execution and stops claiming health after stop',async()=>{
  const h=harness();await h.scheduler.start({runCurrent:true});assert.equal(h.scheduler.getHealth().tasks.T2.healthy,true);
  h.advance(120001);assert.equal(h.scheduler.getHealth().tasks.T2.healthy,false);await h.scheduler.stop();assert.equal(h.scheduler.getHealth().running,false);
});
test('health snapshots cannot be mutated by their caller',async()=>{
  const h=harness();await h.scheduler.start({runCurrent:true});const health=h.scheduler.getHealth();health.tasks.T2.failures=999;
  assert.equal(h.scheduler.getHealth().tasks.T2.failures,0);await h.scheduler.stop();
});
test('stop cancels timers, drains in-flight work and does not launch the remaining daily chain',async()=>{
  const gate=deferred();const h=harness({tasks:{T1:async()=>gate.promise}});const starting=h.scheduler.start({runCurrent:true});await new Promise(setImmediate);
  let stopped=false;const stop=h.scheduler.stop().then(()=>{stopped=true;});await new Promise(setImmediate);assert.equal(stopped,false);assert.ok(h.clears>0);
  gate.resolve();await starting;await stop;assert.equal(h.calls.filter(c=>c[0]==='T3'||c[0]==='T4').length,0);
  const count=h.calls.length;h.advance(30000);await h.scheduler.tick();assert.equal(h.calls.length,count);
});
test('a health persistence failure is visible but does not silently suppress the business task',async()=>{
  const h=harness({onEvent:async()=>{throw new Error('private sink failure');}});await h.scheduler.start({runCurrent:true});
  assert.equal(h.calls.length,4);assert.equal(h.scheduler.getHealth().tasks.T2.lastStoreErrorCode,'HEALTH_STORE_FAILED');
  assert.equal(h.scheduler.getHealth().tasks.T2.healthy,false);assert.doesNotMatch(JSON.stringify(h.logs),/private sink/);await h.scheduler.stop();
});

test('invalid cut scheduling blocks its dependent job while a valid SLA schedule still runs',async()=>{
  const h=harness({schedule:{dayCutHour:24}});await h.scheduler.start({runCurrent:true});
  assert.equal(h.calls.filter(c=>c[0]==='T2').length,1);assert.equal(h.calls.filter(c=>c[0]==='T4').length,0);
  assert.equal(h.scheduler.getHealth().tasks.T4.blockedOn,'T1');await h.scheduler.stop();
});
test('the same task cannot reenter while its successful completion record is still in flight',async()=>{
  const gate=deferred();const h=harness({onEvent:async event=>{if(event.jobId==='T2'&&event.event==='succeeded')await gate.promise;}});
  const start=h.scheduler.start({runCurrent:true});await new Promise(setImmediate);h.advance(30000);
  const tick=h.scheduler.tick();await new Promise(setImmediate);assert.equal(h.calls.filter(c=>c[0]==='T2').length,1);
  gate.resolve();await start;await tick;await h.scheduler.stop();
});
test('daily health does not stay green after a due period was missed and reading health starts no work',async()=>{
  const h=harness();await h.scheduler.start({runCurrent:true});const before=h.calls.length;h.advance(24*3600000);
  assert.equal(h.scheduler.getHealth().tasks.T1.healthy,false);assert.equal(h.calls.length,before);await h.scheduler.stop();
});

test('one job uses the same captured business time for its planned period and handler argument',async()=>{
  assert.equal(typeof scheduling.createScheduler,'function');let ms=new Date('2026-11-05T03:59:57+08:00').getTime();const received={};
  const scheduler=scheduling.createScheduler({tasks:Object.fromEntries(['T1','T2','T3','T4'].map(id=>[id,async at=>{received[id]=at;}])),
    businessNow:()=>{const value=signalTime(new Date(ms));ms+=1000;return value;},realNow:()=>0,setTimer:()=>1,clearTimer:()=>{},logger:()=>{}});
  await scheduler.start({runCurrent:true});const planned=scheduler.getHealth().tasks.T1.lastScheduledAt;
  assert.equal(planned,received.T1<'2026-11-05 04:00:00'?'2026-11-04 04:00:00':'2026-11-05 04:00:00');
  await scheduler.stop();
});

const {test,before,beforeEach,after,afterEach}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const mysql=require('mysql2/promise');
const database=`yinling_jobs_test_${process.pid}_${Date.now().toString(36)}`;
Object.assign(process.env,{DB_HOST:'127.0.0.1',DB_PORT:process.env.L1_TEST_MYSQL_PORT||'13308',DB_USER:'root',DB_PASSWORD:'',DB_NAME:database,JWT_SECRET:randomUUID(),NODE_ENV:'test'});
let admin,db,createRuntime,clockControl,store,owned=false;const runtimes=[];
function implemented(){assert.equal(typeof createRuntime,'function','managed job runtime is implemented');}
function synthetic(options={}){implemented();const calls=[],logs=[];const {tasks:overrides,...other}=options;
  const tasks=Object.fromEntries(['T1','T2','T3','T4'].map(id=>[id,async at=>{calls.push([id,at]);}]));
  const runtime=createRuntime({tasks:{...tasks,...overrides},pollMs:10,retryMs:30,logger:row=>logs.push(row),...other});runtimes.push(runtime);return {runtime,calls,logs};}
before(async()=>{
  admin=await mysql.createConnection({host:'127.0.0.1',port:Number(process.env.DB_PORT),user:'root',password:'',multipleStatements:true,dateStrings:true,timezone:'+08:00'});
  assert.match(database,/^yinling_jobs_test_[a-z0-9_]+$/);await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);owned=true;await admin.changeUser({database});
  const schema=fs.readFileSync(path.join(__dirname,'../../sql/schema.sql'),'utf8');await admin.query(schema.slice(schema.indexOf('CREATE TABLE person')));
  await admin.query("INSERT INTO person (id,phone,name,functions) VALUES (1,'jobs-admin','Test admin',JSON_ARRAY('admin')),(2,'jobs-resident','Test elder',JSON_ARRAY('resident')),(3,'jobs-family','Test family',JSON_ARRAY('relation')),(4,'jobs-agent','Test agent',JSON_ARRAY('agent'))");
  await admin.query("INSERT INTO elder (id,person_id,name,birth_year,addr) VALUES (1,2,'Test elder',1948,'Test address')");
  db=require('../src/db');try{createRuntime=require('../src/jobs/runtime').createJobRuntime;clockControl=require('../src/services/clock-control');store=require('../src/services/job-store');}catch(e){if(e.code!=='MODULE_NOT_FOUND')throw e;}
});
beforeEach(async()=>{await admin.query('DELETE FROM disposition;DELETE FROM order_event;DELETE FROM notification;DELETE FROM verify_order;DELETE FROM service_order;DELETE FROM alert;DELETE FROM audit_log;DELETE FROM signal_event;DELETE FROM signal_daily;DELETE FROM relation;DELETE FROM param');
  await admin.query("INSERT INTO relation (elder_id,person_id,level,role_label,is_accountable) VALUES (1,3,1,'家属',1)");
  await admin.query("INSERT INTO param (community_id,k,v) VALUES (1,'time_scale','1'),(1,'day_cut_hour','4'),(1,'baseline_days','14'),(1,'layer_count','3'),(1,'layer1_wait_min','15'),(1,'layer2_wait_min','120'),(1,'route_mode','relation'),(1,'merge_window_sec','30')");
  try{require('../src/utils/business-clock').businessClock.reset();}catch(e){if(e.code!=='MODULE_NOT_FOUND')throw e;}
});
afterEach(async()=>{for(const runtime of runtimes.splice(0))await runtime.stop();});
after(async()=>{if(db)await db.pool.end();if(admin){try{if(owned)await admin.query(`DROP DATABASE \`${database}\``);}finally{await admin.end();}}});

test('managed startup runs each task once and persists real started/success records',async()=>{
  const h=synthetic();await h.runtime.start();assert.equal(h.calls.length,4);
  const health=h.runtime.getHealth();assert.equal(health.state,'running');assert.ok(health.tasks.T2.lastSucceededAt);assert.equal(health.tasks.T2.healthy,true);
  const rows=await db.query("SELECT action,target_id,payload FROM audit_log WHERE target='job'");assert.equal(rows.length,8);assert.equal(rows.filter(r=>r.action==='job_succeeded').length,4);
});
test('a second managed instance stays standby while the first owns the database lease',async()=>{
  const a=synthetic(),b=synthetic();await a.runtime.start();await b.runtime.start();
  assert.equal(b.calls.length,0);assert.equal(b.runtime.getHealth().state,'standby');await a.runtime.stop();await b.runtime.start();assert.equal(b.runtime.getHealth().state,'running');
});
test('ownership does not consume the business pool and stop releases it',async()=>{
  const h=synthetic();await h.runtime.start();assert.equal(await store.ownerActive(),true);await h.runtime.stop();assert.equal(await store.ownerActive(),false);assert.equal(h.runtime.getHealth().running,false);
});
test('failures persist safe diagnostics, never count as success and retry recovers',async()=>{
  let attempts=0,realMs=Date.now();const h=synthetic({realNow:()=>realMs,tasks:{T2:async()=>{attempts++;if(attempts===1)throw Object.assign(new Error('secret-body-must-not-appear'),{code:'ECONNREFUSED'});}}});
  await h.runtime.start();let state=h.runtime.getHealth().tasks.T2;assert.equal(state.failures,1);assert.equal(state.lastSucceededAt,null);assert.equal(state.healthy,false);
  assert.doesNotMatch(JSON.stringify(h.logs),/secret-body/);realMs+=45;await h.runtime.tick();state=h.runtime.getHealth().tasks.T2;assert.ok(state.lastSucceededAt);assert.equal(state.consecutiveFailures,0);
  const failed=await db.query("SELECT payload FROM audit_log WHERE action='job_failed' AND target_id=2");assert.equal(failed.length,1);assert.doesNotMatch(JSON.stringify(failed),/secret-body/);
});
test('restart restores historical counters but a stopped instance is not healthy',async()=>{
  const a=synthetic();await a.runtime.start();const previous=a.runtime.getHealth().tasks.T2.lastSucceededAt;await a.runtime.stop();assert.equal(a.runtime.getHealth().tasks.T2.healthy,false);
  const b=synthetic({enabled:false});await b.runtime.start();assert.equal(b.runtime.getHealth().state,'disabled');assert.equal(b.runtime.getHealth().tasks.T2.lastSucceededAt,previous);assert.equal(b.runtime.getHealth().tasks.T2.healthy,false);
});
test('a real T1/T3/T4 startup persists a baseline and automatically consumes its actionable alert',async(t)=>{
  implemented();t.mock.timers.enable({apis:['Date'],now:new Date('2026-11-05T10:00:00+08:00').getTime()});
  for(let i=0;i<14;i++)await admin.execute('INSERT INTO signal_daily (elder_id,stat_date,calendar_confirmed,app_opens) VALUES (1,?,1,2)',[new Date(Date.UTC(2026,9,21+i)).toISOString().slice(0,10)]);
  await admin.query("INSERT INTO service_order (elder_id,key_type,status,client_request_id,created_at,done_at) VALUES (1,'buy','done','jobs-evidence','2026-10-01 10:00:00','2026-11-05 03:00:00')");
  const runtime=createRuntime({pollMs:20,retryMs:30,logger:()=>{}});runtimes.push(runtime);await runtime.start();
  assert.equal((await db.queryOne("SELECT COUNT(*) AS n FROM audit_log WHERE action='baseline_calculated'")).n,1);
  assert.equal((await db.queryOne('SELECT COUNT(*) AS n FROM verify_order')).n,1);assert.equal((await db.queryOne('SELECT COUNT(*) AS n FROM notification')).n,1);
  assert.equal(runtime.getHealth().tasks.T4.healthy,true);
});
test('clock transitions persist, remain continuous and restore into a new clock',async()=>{
  implemented();const {businessClock,createBusinessClock}=require('../src/utils/business-clock');const before=businessClock.nowMs();
  await clockControl.changeScale(1,60);const after=businessClock.nowMs();assert.ok(after>=before&&after-before<3000);
  await clockControl.changeScale(1,1);const realScale=businessClock.snapshot();assert.equal(realScale.scale,1);
  const fresh=createBusinessClock();await clockControl.synchronizeClock(fresh);assert.ok(Math.abs(fresh.nowMs()-businessClock.nowMs())<100);
  assert.equal((await db.queryOne("SELECT COUNT(*) AS n FROM audit_log WHERE action='clock_changed'")).n,2);
});

test('synchronization treats the locked database anchor as authoritative after reset restarts audit IDs',async()=>{
  const {createBusinessClock}=require('../src/utils/business-clock');const clock=createBusinessClock(),realBase=Date.now();
  clock.apply({revision:10000,scale:60,realBase,businessBase:realBase+86400000});
  await clockControl.changeScale(1,10);await clockControl.synchronizeClock(clock);
  assert.equal(clock.snapshot().scale,10);assert.ok(clock.snapshot().revision<10000);
});
test('production rejects accelerated time and M8 cannot be used to bypass that policy',async()=>{
  implemented();await assert.rejects(clockControl.changeScale(1,60,{isDev:false}),error=>error.status===403);
  assert.equal((await db.queryOne("SELECT v FROM param WHERE k='time_scale'")).v,'1');
});
test('maintenance cannot reset while another managed runtime owns the lease',async()=>{
  const h=synthetic();await h.runtime.start();await assert.rejects(store.acquireMaintenance(),error=>error.status===409);await h.runtime.stop();const maintenance=await store.acquireMaintenance();await maintenance.release();
});
test('loss of the ownership connection stops new dispatch rather than continuing as leader',async()=>{
  const h=synthetic();await h.runtime.start();const id=h.runtime.ownerId();assert.ok(Number.isSafeInteger(id));await admin.query('KILL CONNECTION '+id);
  await new Promise(resolve=>setTimeout(resolve,20));assert.notEqual(h.runtime.getHealth().state,'running');assert.equal(h.runtime.ownerId(),null);
});

test('ownership lost while startup is waiting for configuration never dispatches tasks',async()=>{
  const h=synthetic({retryMs:30000});let starting;
  await admin.query('LOCK TABLES param WRITE');
  try{
    starting=h.runtime.start();const limit=Date.now()+3000;
    while(h.runtime.ownerId()===null&&Date.now()<limit)await new Promise(resolve=>setTimeout(resolve,10));
    const owner=h.runtime.ownerId();assert.ok(Number.isSafeInteger(owner));await db.pool.query('KILL CONNECTION '+owner);
    const lostLimit=Date.now()+3000;while(h.runtime.ownerId()!==null&&Date.now()<lostLimit)await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(h.runtime.ownerId(),null);
  }finally{await admin.query('UNLOCK TABLES');}
  await starting;assert.equal(h.calls.length,0);assert.equal(h.runtime.getHealth().running,false);assert.equal(h.runtime.getHealth().owning,false);
});

test('an invalid daily cut does not prevent the independent SLA task from starting',async()=>{
  await admin.query("UPDATE param SET v='broken' WHERE k='day_cut_hour'");const h=synthetic();await h.runtime.start();
  assert.equal(h.calls.filter(call=>call[0]==='T2').length,1);assert.equal(h.runtime.getHealth().tasks.T2.healthy,true);
  assert.equal(h.runtime.getHealth().tasks.T1.lastErrorCode,'INVALID_CONFIGURATION');assert.equal(h.runtime.getHealth().tasks.T4.blockedOn,'T1');
});

test('business readiness waits for an in-flight resynchronization even if an earlier request restored the clock',async()=>{
  let release,entered;const gate=new Promise(resolve=>release=resolve),began=new Promise(resolve=>entered=resolve),readHistory=store.readJobHistory;
  store.readJobHistory=async()=>{entered();await gate;return readHistory();};
  const h=synthetic();let starting,request,locked=false;
  try{
    starting=h.runtime.start();await began;await h.runtime.ensureClock();
    const realBase=Date.now();await admin.execute("INSERT INTO audit_log (action,target,target_id,payload) VALUES ('clock_changed','clock',1,?)",[JSON.stringify({version:'clock-v1',scale:10,realBase,businessBase:realBase})]);
    await admin.query("UPDATE param SET v='10' WHERE k='time_scale'");await admin.query('LOCK TABLES param WRITE');locked=true;release();
    const limit=Date.now()+3000;while(h.runtime.ownerId()===null&&Date.now()<limit)await new Promise(resolve=>setTimeout(resolve,10));assert.ok(h.runtime.ownerId());
    let passed=false;request=h.runtime.ensureClock().then(()=>{passed=true;});await new Promise(resolve=>setTimeout(resolve,30));assert.equal(passed,false);
  }finally{release();store.readJobHistory=readHistory;if(locked)await admin.query('UNLOCK TABLES');await starting;await request;}
  assert.equal(h.runtime.getHealth().timeScale,10);
});

test('ownership recovery still retries when the failed initialization outlives its retry timer',async()=>{
  const h=synthetic({retryMs:20});let starting;await admin.query('LOCK TABLES param WRITE');
  try{
    starting=h.runtime.start();const limit=Date.now()+3000;while(h.runtime.ownerId()===null&&Date.now()<limit)await new Promise(resolve=>setTimeout(resolve,10));
    const owner=h.runtime.ownerId();assert.ok(Number.isSafeInteger(owner));await db.pool.query('KILL CONNECTION '+owner);
    await new Promise(resolve=>setTimeout(resolve,80));
  }finally{await admin.query('UNLOCK TABLES');}
  await starting;const limit=Date.now()+1500;while(h.calls.length<4&&Date.now()<limit)await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(h.calls.length,4);assert.equal(h.runtime.getHealth().state,'running');assert.equal(h.runtime.getHealth().owning,true);
});

test('routing after a slow T4 starts its SLA at actual dispatch time',async(t)=>{
  implemented();t.mock.timers.enable({apis:['Date'],now:new Date('2026-11-05T10:00:00+08:00').getTime()});
  await admin.query("INSERT INTO alert (elder_id,d_score,q_score,cell,signal_snapshot) VALUES (1,0.8,0.8,'strong',JSON_ARRAY())");
  const stratification=require('../src/jobs/stratification'),run=stratification.runStratification;
  stratification.runStratification=async at=>{const result=await run(at);t.mock.timers.setTime(new Date('2026-11-05T10:20:00+08:00').getTime());return result;};
  try{
    const runtime=createRuntime({pollMs:1000000,logger:()=>{}});runtimes.push(runtime);await runtime.start();
    const row=await db.queryOne('SELECT created_at,sla_deadline FROM verify_order');assert.equal(row.created_at,'2026-11-05 10:20:00');assert.equal(row.sla_deadline,'2026-11-05 10:35:00');
    assert.equal((await db.queryOne('SELECT sent_at FROM notification')).sent_at,row.created_at);
  }finally{stratification.runStratification=run;}
});

for(const stage of ['acquire','configuration failure'])test(`stop waits for the drain barrier when startup is pending at ${stage}`,async()=>{
  let entered,release,drained;const began=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve),drain=new Promise(resolve=>drained=resolve);
  const acquire=store.acquireOwner,read=store.readDayCut;
  if(stage==='acquire')store.acquireOwner=async(...args)=>{const lease=await acquire(...args);entered();await gate;return lease;};
  else store.readDayCut=async()=>{entered();await gate;throw new RangeError('test configuration failure');};
  const h=synthetic();let starting,stopping;
  try{
    starting=h.runtime.start();await began;stopping=h.runtime.stop({drain});release();await starting;await new Promise(resolve=>setTimeout(resolve,20));
    assert.equal(await store.ownerActive(),true);await assert.rejects(store.acquireMaintenance(),error=>error.status===409);assert.equal(h.calls.length,0);
  }finally{release();drained();store.acquireOwner=acquire;store.readDayCut=read;await starting;await stopping;}
  assert.equal(await store.ownerActive(),false);
});

test('a new owner and waiting request cannot reuse a pre-owner clock restore',async()=>{
  const createConnection=mysql.createConnection,readHistory=store.readJobHistory;
  let enteredHistory,releaseHistory,endedClock,releaseEnd,checkedOwner;
  const historyBegan=new Promise(resolve=>enteredHistory=resolve),historyGate=new Promise(resolve=>releaseHistory=resolve),clockEnded=new Promise(resolve=>endedClock=resolve),endGate=new Promise(resolve=>releaseEnd=resolve),ownerChecked=new Promise(resolve=>checkedOwner=resolve);
  let firstClock=true;
  mysql.createConnection=async(...args)=>{
    const conn=await createConnection(...args),execute=conn.execute.bind(conn),end=conn.end.bind(conn);let clockConnection=false;
    conn.execute=async(sql,params)=>{if(sql.includes('GET_LOCK')&&params?.[0]===store.clockKey())clockConnection=true;const result=await execute(sql,params);if(clockConnection&&sql.includes('IS_USED_LOCK'))checkedOwner();return result;};
    conn.end=async()=>{await end();if(clockConnection&&firstClock){firstClock=false;endedClock();await endGate;}};return conn;
  };
  store.readJobHistory=async()=>{enteredHistory();await historyGate;return readHistory();};
  const clock=require('../src/utils/business-clock').createBusinessClock(),h=synthetic({clock,retryMs:30000});let starting,early,changing,locked=false;
  try{
    starting=h.runtime.start();await historyBegan;early=h.runtime.ensureClock().then(()=>({ok:true}),error=>({error}));await clockEnded;
    await admin.query('LOCK TABLES param WRITE');locked=true;changing=clockControl.changeScale(1,60);await ownerChecked;
    releaseHistory();const limit=Date.now()+3000;while(h.runtime.ownerId()===null&&Date.now()<limit)await new Promise(resolve=>setTimeout(resolve,10));assert.ok(h.runtime.ownerId());
    releaseEnd();const result=await early;assert.equal(result.error?.status,409);await starting;
    assert.equal(h.calls.length,0);assert.equal(h.runtime.getHealth().owning,false);
  }finally{
    releaseHistory();releaseEnd();if(locked)await admin.query('UNLOCK TABLES');if(changing)await changing;await starting;await early;mysql.createConnection=createConnection;store.readJobHistory=readHistory;
  }
  await h.runtime.start();assert.equal(h.runtime.getHealth().timeScale,60);assert.equal(new Set(h.calls.map(call=>call[0])).size,4);
});

const {test,before,beforeEach,after,afterEach}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');const {randomUUID}=require('node:crypto');
const os=require('node:os');const {spawn}=require('node:child_process');
const mysql=require('mysql2/promise');
const database=`yinling_jobs_server_test_${process.pid}_${Date.now().toString(36)}`;
Object.assign(process.env,{DB_HOST:'127.0.0.1',DB_PORT:process.env.L1_TEST_MYSQL_PORT||'13308',DB_USER:'root',DB_PASSWORD:'',DB_NAME:database,JWT_SECRET:randomUUID(),NODE_ENV:'test'});
let admin,db,startServer,owned=false;const servers=[];
function implemented(){assert.equal(typeof startServer,'function','server lifecycle is implemented');}
async function server(jobOptions={enabled:false}){implemented();const running=await startServer({port:0,host:'127.0.0.1',closePool:false,jobOptions:{logger:()=>{},...jobOptions},logger:()=>{}});servers.push(running);await running.ready;return running;}
async function request(running,method,endpoint,body,personId=1){const token=require('../src/utils/jwt').sign({id:personId,name:'Test',functions:personId===1?['admin']:['resident']});const response=await fetch(`http://127.0.0.1:${running.server.address().port}/api`+endpoint,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,body:await response.json()};}
const noop=Object.fromEntries(['T1','T2','T3','T4'].map(id=>[id,async()=>{}]));
before(async()=>{
  admin=await mysql.createConnection({host:'127.0.0.1',port:Number(process.env.DB_PORT),user:'root',password:'',multipleStatements:true,dateStrings:true,timezone:'+08:00'});assert.match(database,/^yinling_jobs_server_test_[a-z0-9_]+$/);
  await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);owned=true;await admin.changeUser({database});
  const schema=fs.readFileSync(path.join(__dirname,'../../sql/schema.sql'),'utf8');await admin.query(schema.slice(schema.indexOf('CREATE TABLE person')));
  db=require('../src/db');try{startServer=require('../src/server').startServer;}catch(e){if(e.code!=='MODULE_NOT_FOUND')throw e;}
});
beforeEach(async()=>{
  await admin.query('SET FOREIGN_KEY_CHECKS=0;DELETE FROM disposition;DELETE FROM order_event;DELETE FROM notification;DELETE FROM verify_order;DELETE FROM service_order;DELETE FROM alert;DELETE FROM signal_event;DELETE FROM signal_daily;DELETE FROM wallet_txn;DELETE FROM bill;DELETE FROM wallet;DELETE FROM invite_code;DELETE FROM relation;DELETE FROM relation_group;DELETE FROM audit_log;DELETE FROM param;DELETE FROM elder;DELETE FROM person;SET FOREIGN_KEY_CHECKS=1');
  await admin.query("INSERT INTO person (id,phone,name,functions) VALUES (1,'jobs-admin','Test admin',JSON_ARRAY('admin')),(2,'jobs-user','Test user',JSON_ARRAY('resident'))");
  await admin.query("INSERT INTO elder (id,person_id,name,birth_year,addr) VALUES (1,2,'Test elder',1948,'Test address')");
  await admin.query("INSERT INTO param (community_id,k,v) VALUES (1,'time_scale','1'),(1,'day_cut_hour','4'),(1,'baseline_days','14')");
  require('../src/utils/business-clock').businessClock.reset();
});
afterEach(async()=>{for(const running of servers.splice(0))await running.stop();});
after(async()=>{if(db)await db.pool.end();if(admin){try{if(owned)await admin.query(`DROP DATABASE \`${database}\``);}finally{await admin.end();}}});

test('M1 reports real managed success timestamps and optional health without changing the DB health probe',async()=>{
  const running=await server({enabled:true,tasks:noop,pollMs:10,retryMs:30});const response=await request(running,'GET','/admin/overview');
  assert.equal(response.status,200);assert.equal(response.body.data.jobs.state,'running');assert.equal(response.body.data.lastJobAt,response.body.data.jobs.tasks.T2.lastSucceededAt);assert.ok(response.body.data.lastJobAt);
  const probe=await request(running,'GET','/health');assert.equal(probe.status,200);assert.equal(probe.body.data.db,'up');
});
test('D1 refuses reset before touching data while managed scheduling is active',async()=>{
  const running=await server({enabled:true,tasks:noop,pollMs:10});const before=Number((await db.queryOne('SELECT COUNT(*) AS n FROM person')).n);
  const response=await request(running,'POST','/demo/reset',{});assert.equal(response.status,409);assert.equal(Number((await db.queryOne('SELECT COUNT(*) AS n FROM person')).n),before);
});

test('D1 still requires configuration disable after a runtime has been stopped',async()=>{
  const running=await server({enabled:true,tasks:noop});await running.runtime.stop();
  const before=Number((await db.queryOne('SELECT COUNT(*) AS n FROM person')).n),response=await request(running,'POST','/demo/reset',{});
  assert.equal(response.status,409);assert.equal(Number((await db.queryOne('SELECT COUNT(*) AS n FROM person')).n),before);
});

test('M8 serializes its cut change with an in-flight startup configuration read',async()=>{
  implemented();const store=require('../src/services/job-store'),read=store.readDayCut;let entered,release,ms=new Date('2026-11-05T04:30:00+08:00').getTime();
  const gate=new Promise(resolve=>release=resolve),began=new Promise(resolve=>entered=resolve),calls=[];
  store.readDayCut=async(...args)=>{const result=await read(...args);entered();await gate;return result;};
  let running,changing,changed=false;
  try{
    running=await startServer({port:0,host:'127.0.0.1',closePool:false,jobOptions:{enabled:true,clock:require('../src/utils/business-clock').createBusinessClock({realNow:()=>ms}),tasks:{...noop,T1:async at=>calls.push(at)},pollMs:10,logger:()=>{}},logger:()=>{}});servers.push(running);
    await began;changing=request(running,'PUT','/admin/params',{day_cut_hour:5}).then(value=>{changed=true;return value;});
    await new Promise(resolve=>setTimeout(resolve,250));assert.equal(changed,false);
  }finally{release();store.readDayCut=read;if(running)await running.ready;if(changing)assert.equal((await changing).status,200);}
  ms=new Date('2026-11-05T05:00:00+08:00').getTime();const limit=Date.now()+2000;
  while(!calls.includes('2026-11-05 05:00:00')&&Date.now()<limit)await new Promise(resolve=>setTimeout(resolve,10));
  assert.ok(calls.includes('2026-11-05 05:00:00'));assert.equal(running.runtime.getHealth().tasks.T1.lastScheduledAt,'2026-11-05 05:00:00');
});
test('D3 and M8 use the same clock transition rather than independent rates',async()=>{
  const running=await server({enabled:true,tasks:noop,pollMs:20});
  assert.equal((await request(running,'PUT','/demo/time-scale',{scale:60})).status,200);assert.equal(require('../src/utils/business-clock').businessClock.snapshot().scale,60);
  assert.equal((await request(running,'PUT','/admin/params',{time_scale:10})).status,200);assert.equal(require('../src/utils/business-clock').businessClock.snapshot().scale,10);
  assert.equal((await db.queryOne("SELECT v FROM param WHERE k='time_scale'")).v,'10');
});

test('M8 rejects non-numeric day cuts before writing and accepts a canonical numeric value',async()=>{
  const running=await server({enabled:true,tasks:noop,pollMs:20});
  for(const day_cut_hour of [null,true,false,{},[],['4'],'',24,-1]){
    assert.equal((await request(running,'PUT','/admin/params',{day_cut_hour})).status,422);
    assert.equal((await db.queryOne("SELECT v FROM param WHERE k='day_cut_hour'")).v,'4');
  }
  assert.equal((await request(running,'PUT','/admin/params',{day_cut_hour:'05'})).status,200);
  assert.equal((await db.queryOne("SELECT v FROM param WHERE k='day_cut_hour'")).v,'5');
});

test('business HTTP waits for a persisted clock to restore rather than using the default epoch',async()=>{
  implemented();const realBase=Date.now(),businessBase=realBase+86400000;
  await admin.execute("INSERT INTO audit_log (action,target,target_id,payload) VALUES ('clock_changed','clock',1,?)",[JSON.stringify({version:'clock-v1',scale:60,realBase,businessBase})]);
  await admin.query("UPDATE param SET v='60' WHERE k='time_scale'");let running,pending;
  await admin.query('LOCK TABLES audit_log WRITE');
  try{
    running=await startServer({port:0,host:'127.0.0.1',closePool:false,jobOptions:{enabled:false,logger:()=>{}},logger:()=>{}});servers.push(running);
    pending=request(running,'POST','/elder/emergency',{clientRequestId:randomUUID()},2);
    await new Promise(resolve=>setTimeout(resolve,60));
  }finally{await admin.query('UNLOCK TABLES');}
  const response=await pending;assert.equal(response.status,200);await running.ready;
  const row=await db.queryOne('SELECT created_at FROM verify_order WHERE id=?',[response.body.data.orderId]);
  assert.ok(row.created_at>=require('../src/utils/signal-day').signalTime(new Date(businessBase)),row.created_at);
});
test('disabled scheduling leaves health explicit and D1 resets only the configured database and clock',async()=>{
  const running=await server();const health=await request(running,'GET','/admin/overview');assert.equal(health.body.data.jobs.state,'disabled');
  await request(running,'PUT','/demo/time-scale',{scale:60});assert.equal(require('../src/utils/business-clock').businessClock.snapshot().scale,60);
  const reset=await request(running,'POST','/demo/reset',{});assert.equal(reset.status,200);assert.equal(reset.body.data.elders,3);
  assert.equal(require('../src/utils/business-clock').businessClock.snapshot().scale,1);assert.equal((await db.queryOne('SELECT COUNT(*) AS n FROM elder')).n,3);
});
test('native timers trigger subsequent SLA intervals without manually calling tick',async()=>{
  let calls=0;const base=Date.now(),{createBusinessClock}=require('../src/utils/business-clock');const clock=createBusinessClock({realNow:()=>base+(Date.now()-base)*60});
  const running=await server({enabled:true,tasks:{...noop,T2:async()=>{calls++;}},clock,pollMs:10,schedule:{slaSeconds:1}});
  const limit=Date.now()+2000;while(calls<2&&Date.now()<limit)await new Promise(resolve=>setTimeout(resolve,10));assert.ok(calls>=2);await running.stop();const count=calls;await new Promise(resolve=>setTimeout(resolve,40));assert.equal(calls,count);
});

test('native polling dispatches T3 at 03:00 and T1 before T4 at 04:00',async()=>{
  const calls=[];let ms=new Date('2026-11-05T02:59:59+08:00').getTime();
  const clock=require('../src/utils/business-clock').createBusinessClock({realNow:()=>ms});
  const tasks=Object.fromEntries(['T1','T2','T3','T4'].map(id=>[id,async at=>{calls.push({id,at});}]));
  await server({enabled:true,tasks,clock,pollMs:10});assert.equal(calls.length,4);
  async function reached(at,ids){ms=new Date(at.replace(' ','T')+'+08:00').getTime();const limit=Date.now()+3000;
    while(!ids.every(id=>calls.some(call=>call.id===id&&call.at===at))&&Date.now()<limit)await new Promise(resolve=>setTimeout(resolve,10));
    for(const id of ids)assert.equal(calls.filter(call=>call.id===id&&call.at===at).length,1,`${id} at ${at}`);
  }
  await reached('2026-11-05 03:00:00',['T2','T3','T4']);assert.equal(calls.filter(call=>call.id==='T1').length,1);
  await reached('2026-11-05 04:00:00',['T1','T2','T4']);assert.equal(calls.filter(call=>call.id==='T3').length,2);
  assert.ok(calls.findIndex(call=>call.id==='T1'&&call.at==='2026-11-05 04:00:00')<calls.findIndex(call=>call.id==='T4'&&call.at==='2026-11-05 04:00:00'));
});

test('the actual index entry starts default jobs and its shutdown handler drains the managed runtime',async()=>{
  const env={...process.env,PORT:'0'};for(const key of Object.keys(env))if(/^JOBS?_/.test(key))delete env[key];
  const child=spawn(process.execPath,['--require',path.join(__dirname,'fixtures/job-process-control.cjs'),path.join(__dirname,'../src/index.js')],{cwd:os.tmpdir(),env,stdio:['ignore','pipe','pipe','ipc']});
  let output='';for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{output=(output+chunk).slice(-8192);});
  const exited=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));});
  try{
    const limit=Date.now()+10000;let count=0;while(count<4&&Date.now()<limit){const row=await db.queryOne("SELECT COUNT(DISTINCT target_id) AS n FROM audit_log WHERE action='job_succeeded' AND target='job'");count=Number(row.n);if(count<4)await new Promise(resolve=>setTimeout(resolve,20));}
    assert.equal(count,4,output);const port=output.match(/localhost:(\d+)\/api\/health/)?.[1];assert.ok(port,output);
    const probe=await fetch(`http://127.0.0.1:${port}/api/health`);assert.equal(probe.status,200);assert.equal(await require('../src/services/job-store').ownerActive(),true);
    child.send({type:'stop-test-server'});
    let timeout;const result=await Promise.race([exited,new Promise((_,reject)=>{timeout=setTimeout(()=>reject(new Error('entry shutdown timed out')),5000);})]).finally(()=>clearTimeout(timeout));
    assert.equal(result.code,0,output);assert.equal(await require('../src/services/job-store').ownerActive(),false);assert.match(output,/正在停止调度/);
  }finally{if(child.exitCode===null){child.kill();await exited;}}
});

test('a separate standby process follows subsequent owner clock changes before handling business HTTP',async()=>{
  const owner=await server({enabled:true,tasks:noop,pollMs:20});const env={...process.env,PORT:'0'};
  for(const key of Object.keys(env))if(/^JOBS?_/.test(key))delete env[key];
  const child=spawn(process.execPath,['--require',path.join(__dirname,'fixtures/job-process-control.cjs'),path.join(__dirname,'../src/index.js')],{cwd:os.tmpdir(),env,stdio:['ignore','pipe','pipe','ipc']});
  let output='';for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{output=(output+chunk).slice(-8192);});
  const exited=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));});
  try{
    const limit=Date.now()+10000;while(!/localhost:(\d+)\/api\/health/.test(output)&&Date.now()<limit)await new Promise(resolve=>setTimeout(resolve,20));
    const port=output.match(/localhost:(\d+)\/api\/health/)?.[1];assert.ok(port,output);
    const token=require('../src/utils/jwt').sign({id:1,name:'Test admin',functions:['admin']});
    async function health(){const response=await fetch(`http://127.0.0.1:${port}/api/admin/overview`,{headers:{Authorization:`Bearer ${token}`}});assert.equal(response.status,200,output);return (await response.json()).data.jobs;}
    let state=await health();const readyLimit=Date.now()+3000;while(state.state!=='standby'&&Date.now()<readyLimit){await new Promise(resolve=>setTimeout(resolve,10));state=await health();}
    assert.equal(state.state,'standby');assert.equal(state.timeScale,1);
    for(const scale of [60,10]){assert.equal((await request(owner,'PUT','/demo/time-scale',{scale})).status,200);state=await health();assert.equal(state.timeScale,scale);assert.equal(state.tasks.T2.healthy,false);assert.equal(state.owning,false);}
    child.send({type:'stop-test-server'});let timeout;
    const result=await Promise.race([exited,new Promise((_,reject)=>{timeout=setTimeout(()=>reject(new Error('standby shutdown timed out')),5000);})]).finally(()=>clearTimeout(timeout));assert.equal(result.code,0,output);
  }finally{if(child.exitCode===null){child.kill();await exited;}}
});

test('native T2 uses accelerated business time to CAS-escalate a real HTTP emergency exactly once',async()=>{
  await admin.query("INSERT INTO person (id,phone,name,functions) VALUES (3,'jobs-agent','Test agent',JSON_ARRAY('agent'))");
  const running=await server({enabled:true,pollMs:10});const emergency=await request(running,'POST','/elder/emergency',{clientRequestId:randomUUID()},2);assert.equal(emergency.status,200);
  const orderId=emergency.body.data.orderId,original=await db.queryOne('SELECT current_layer,sla_deadline FROM verify_order WHERE id=?',[orderId]);assert.ok(original.sla_deadline);
  assert.equal((await request(running,'PUT','/demo/time-scale',{scale:60})).status,200);
  let order=original;const limit=Date.now()+9000;while(order.current_layer===original.current_layer&&Date.now()<limit){await new Promise(resolve=>setTimeout(resolve,30));order=await db.queryOne('SELECT current_layer,sla_deadline FROM verify_order WHERE id=?',[orderId]);}
  assert.ok(order.current_layer>original.current_layer);assert.equal(order.sla_deadline,null);
  await new Promise(resolve=>setTimeout(resolve,80));assert.equal(Number((await db.queryOne("SELECT COUNT(*) AS n FROM order_event WHERE order_id=? AND action='escalate'",[orderId])).n),1);
  const health=await request(running,'GET','/admin/overview');assert.equal(health.body.data.jobs.tasks.T2.healthy,true);
});
test('graceful stop waits for in-flight work, stops HTTP and releases ownership',async()=>{
  implemented();let release,began;const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>began=resolve);const running=await startServer({port:0,host:'127.0.0.1',closePool:false,jobOptions:{enabled:true,tasks:{...noop,T1:async()=>{began();await gate;}},pollMs:10},logger:()=>{}});servers.push(running);
  await started;let finished=false;const stopping=running.stop().then(()=>{finished=true;});await new Promise(resolve=>setTimeout(resolve,20));assert.equal(finished,false);release();await stopping;assert.equal(running.server.listening,false);assert.equal(await require('../src/services/job-store').ownerActive(),false);
});

test('shutdown retains ownership until an in-flight HTTP write has drained',async()=>{
  const running=await server({enabled:true,tasks:noop});let entered;const began=new Promise(resolve=>entered=resolve);
  running.server.once('request',()=>entered());let pending,stopping;await admin.query('LOCK TABLES verify_order WRITE');
  try{
    pending=request(running,'POST','/elder/emergency',{clientRequestId:randomUUID()},2);await began;stopping=running.stop();
    await new Promise(resolve=>setTimeout(resolve,60));const store=require('../src/services/job-store');assert.equal(await store.ownerActive(),true);await assert.rejects(store.acquireMaintenance(),error=>error.status===409);
  }finally{await admin.query('UNLOCK TABLES');if(pending)assert.equal((await pending).status,200);await stopping;}
  assert.equal(await require('../src/services/job-store').ownerActive(),false);
});

test('shutdown during startup retains its owner until the waiting HTTP write drains',async()=>{
  implemented();const store=require('../src/services/job-store'),read=store.readDayCut;let entered,release;const gate=new Promise(resolve=>release=resolve),began=new Promise(resolve=>entered=resolve);
  store.readDayCut=async(...args)=>{const cut=await read(...args);entered();await gate;return cut;};let running,pending,stopping;
  await admin.query('LOCK TABLES verify_order WRITE');
  try{
    running=await startServer({port:0,host:'127.0.0.1',closePool:false,jobOptions:{enabled:true,tasks:noop,logger:()=>{}},logger:()=>{}});servers.push(running);await began;
    let arrived;const received=new Promise(resolve=>arrived=resolve);running.server.once('request',()=>arrived());pending=request(running,'POST','/elder/emergency',{clientRequestId:randomUUID()},2);await received;
    stopping=running.stop();release();await running.ready;await new Promise(resolve=>setTimeout(resolve,60));assert.equal(await store.ownerActive(),true);await assert.rejects(store.acquireMaintenance(),error=>error.status===409);
  }finally{release();store.readDayCut=read;await admin.query('UNLOCK TABLES');if(pending)assert.equal((await pending).status,200);await stopping;}
  assert.equal(await store.ownerActive(),false);
});
test('a health persistence error is visible on M1 while the business handler still executes',async()=>{
  await admin.query("CREATE TRIGGER reject_job_health BEFORE INSERT ON audit_log FOR EACH ROW BEGIN IF NEW.target='job' AND NEW.target_id=2 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='test health failure'; END IF; END");
  let calls=0;try{const running=await server({enabled:true,tasks:{...noop,T2:async()=>{calls++;}},pollMs:20});const response=await request(running,'GET','/admin/overview');assert.equal(calls,1);assert.equal(response.body.data.jobs.tasks.T2.healthy,false);assert.equal(response.body.data.jobs.tasks.T2.lastStoreErrorCode,'HEALTH_STORE_FAILED');}finally{await admin.query('DROP TRIGGER reject_job_health');}
});

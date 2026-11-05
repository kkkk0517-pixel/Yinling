const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);
const mysql = require('mysql2/promise');
const database = `yinling_l4_test_${process.pid}_${Date.now().toString(36)}`;
Object.assign(process.env,{DB_HOST:'127.0.0.1',DB_PORT:process.env.L1_TEST_MYSQL_PORT||'13308',DB_USER:'root',DB_PASSWORD:'',DB_NAME:database,JWT_SECRET:randomUUID(),NODE_ENV:'test'});
const AT='2026-11-05 10:00:00';
const actorRoles={1:['resident'],2:['relation','service'],3:['relation'],4:['agent'],5:['agent'],6:['admin'],7:['resident'],8:['relation'],9:['agent'],10:['relation']};
let admin,db,server,baseUrl,routing={},verification={},evidence={},ownedDatabase=false;
const parse=v=>typeof v==='string'?JSON.parse(v):v;
function implemented(){assert.equal(typeof routing.routePendingAlerts,'function','L4 consumer is implemented');}
function freeze(t,at=AT){t.mock.timers.enable({apis:['Date'],now:new Date(at.replace(' ','T')+'+08:00').getTime()});}
async function http(method,endpoint,body,personId=4){
  const token=require('../src/utils/jwt').sign({id:personId,name:'L4 test',functions:actorRoles[personId]});
  const response=await fetch(baseUrl+endpoint,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  return {status:response.status,body:await response.json()};
}
async function alert(cell='strong',elderId=1){
  const [row]=await admin.execute('INSERT INTO alert (elder_id,d_score,q_score,cell,signal_snapshot,created_at) VALUES (?,0.8,?,?,?,?)',
    [elderId,cell==='strong'?0.8:0.1,cell,JSON.stringify([{signal:'test',note:'测试依据',context:{routeIntent:cell==='strong'?'dispatch_verify':'request_evidence'}}]),AT]);
  return row.insertId;
}
async function routeOne(){implemented();const alertId=await alert();const result=await routing.routePendingAlerts(AT);return {alertId,orderId:result.results.find(r=>r.alertId===alertId).orderId};}
async function order(id){return db.queryOne('SELECT * FROM verify_order WHERE id=?',[id]);}
async function noti(orderId,personId=2){return db.queryOne("SELECT * FROM notification WHERE order_type='verify' AND order_id=? AND person_id=? ORDER BY id DESC LIMIT 1",[orderId,personId]);}
async function count(table,where='1=1',params=[]){return Number((await db.queryOne(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`,params)).n);}

before(async()=>{
  admin=await mysql.createConnection({host:'127.0.0.1',port:Number(process.env.DB_PORT),user:'root',password:'',multipleStatements:true,dateStrings:true,timezone:'+08:00'});
  assert.match(database,/^yinling_l4_test_[a-z0-9_]+$/);
  await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);ownedDatabase=true;await admin.changeUser({database});
  const schema=fs.readFileSync(path.join(__dirname,'../../sql/schema.sql'),'utf8');const start=schema.indexOf('CREATE TABLE person');assert.ok(start>0);await admin.query(schema.slice(start));
  for(const [id,functions] of Object.entries(actorRoles))await admin.execute("INSERT INTO person (id,phone,name,functions,community_id,status) VALUES (?,?,'L4 test',?,?,?)",[Number(id),'l4-test-'+id,JSON.stringify(functions),Number(id)===10?2:1,Number(id)===9?0:1]);
  await admin.query("INSERT INTO elder (id,person_id,name,birth_year,addr) VALUES (1,1,'L4 test',1948,'Test address'),(2,7,'L4 second',1948,'Test address')");
  db=require('../src/db');
  for(const [name,set] of [['routing',v=>routing=v],['verification',v=>verification=v],['evidence-requests',v=>evidence=v]]){
    try{set(require('../src/services/'+name));}catch(e){if(e.code!=='MODULE_NOT_FOUND')throw e;}
  }
  const app=require('../src/app');server=await new Promise(resolve=>{const instance=app.listen(0,'127.0.0.1',()=>resolve(instance));});baseUrl=`http://127.0.0.1:${server.address().port}/api`;
});
beforeEach(async()=>{
  await admin.query('DELETE FROM disposition;DELETE FROM order_event;DELETE FROM notification;DELETE FROM verify_order;DELETE FROM service_order;DELETE FROM alert;DELETE FROM audit_log;DELETE FROM signal_event;DELETE FROM signal_daily;DELETE FROM relation;DELETE FROM relation_group;DELETE FROM param');
  await admin.query("UPDATE person SET status=1 WHERE id<>9;UPDATE person SET status=0 WHERE id=9;UPDATE elder SET status='active',monitor_level='monitor'");
  await admin.query("INSERT INTO relation (id,elder_id,person_id,level,role_label,is_accountable,priority) VALUES (1,1,2,1,'家属',1,1),(2,1,3,1,'家属',0,2)");
  await admin.query("INSERT INTO param (community_id,k,v) VALUES (1,'layer_count','3'),(1,'layer1_wait_min','15'),(1,'layer2_wait_min','120'),(1,'route_mode','relation'),(1,'merge_window_sec','30'),(1,'day_cut_hour','4'),(1,'baseline_days','14')");
});
after(async()=>{if(server)await new Promise(resolve=>server.close(resolve));if(db)await db.pool.end();if(admin){try{if(ownedDatabase)await admin.query(`DROP DATABASE \`${database}\``);}finally{await admin.end();}}});

test('strong alert creates a uniquely keyed order with primary/follower notifications and a 15-minute deadline',async()=>{
  const {alertId,orderId}=await routeOne();const row=await order(orderId);
  assert.equal(row.alert_id,alertId);assert.equal(row.current_layer,1);assert.equal(row.sla_deadline,'2026-11-05 10:15:00');assert.equal(row.assignee_id,4);
  assert.equal((await noti(orderId,2)).is_accountable,1);assert.equal((await noti(orderId,3)).is_accountable,0);
  assert.equal(await count('order_event',"order_id=? AND action='route_plan'",[orderId]),1);
});
test('concurrent consumers do not duplicate an order or its notifications',async()=>{
  implemented();await alert();await Promise.all(Array.from({length:8},()=>routing.routePendingAlerts(AT)));
  assert.equal(await count('verify_order'),1);assert.equal(await count('notification'),2);
});
test('normal alerts within the merge window retain the original basis and do not restart SLA',async()=>{
  const first=await routeOne();const secondAlert=await alert();
  const result=await routing.routePendingAlerts('2026-11-05 10:00:10');
  assert.equal(result.results.find(r=>r.alertId===secondAlert).orderId,first.orderId);
  assert.equal(await count('verify_order'),1);assert.equal(await count('notification'),2);
  assert.equal((await order(first.orderId)).alert_id,first.alertId);assert.equal((await order(first.orderId)).sla_deadline,'2026-11-05 10:15:00');
});
test('before the deadline no escalation occurs; at the deadline concurrent scans upgrade only once',async()=>{
  const {orderId}=await routeOne();assert.equal((await routing.scanSla('2026-11-05 10:14:59')).upgraded,0);
  const results=await Promise.all(Array.from({length:8},()=>routing.scanSla('2026-11-05 10:15:00')));
  assert.equal(results.reduce((n,r)=>n+r.upgraded,0),1);
  const row=await order(orderId);assert.equal(row.current_layer,2);assert.equal(row.sla_deadline,'2026-11-05 12:15:00');
  assert.equal(await count('order_event',"order_id=? AND action='escalate'",[orderId]),1);
});
test('stale CAS layer cannot change state or append events even when deadline still matches',async()=>{
  const {orderId}=await routeOne();const candidate=await order(orderId);
  await admin.execute("UPDATE verify_order SET current_layer=2,status='escalated' WHERE id=?",[orderId]);
  const conn=await db.pool.getConnection();try{await conn.beginTransaction();const changed=await routing.advanceOrder(conn,candidate,'2026-11-05 10:15:00','timeout');assert.equal(changed.changed,false);await conn.commit();}finally{conn.release();}
  assert.equal(await count('order_event',"order_id=? AND action='escalate'",[orderId]),0);
});
test('follower success and unreachable receipts only record evidence and preserve the timer',async(t)=>{
  freeze(t);for(const result of ['ok_called','unreachable']){
    const {orderId}=await routeOne();const notification=await noti(orderId,3);
    const response=await http('POST',`/relation/notifications/${notification.id}/ack`,{result},3);
    assert.equal(response.status,200);assert.equal(response.body.data.escalated,false);assert.equal((await order(orderId)).sla_deadline,'2026-11-05 10:15:00');
    await admin.execute("UPDATE verify_order SET status='closed' WHERE id=?",[orderId]);
  }
});
test('current primary success stops SLA but leaves the order open for an actual agent conclusion',async(t)=>{
  freeze(t);const {orderId}=await routeOne();const notification=await noti(orderId);
  assert.equal((await http('POST',`/relation/notifications/${notification.id}/ack`,{result:'ok_called'},2)).status,200);
  const row=await order(orderId);assert.equal(row.sla_deadline,null);assert.notEqual(row.status,'closed');assert.equal(row.assignee_id,4);
  assert.equal((await routing.scanSla('2026-11-05 10:20:00')).upgraded,0);
  assert.equal(await count('disposition'),0);
});
test('current primary unreachable immediately advances once and repeated receipt does not advance again',async(t)=>{
  freeze(t);const {orderId}=await routeOne();const notification=await noti(orderId);
  const first=await http('POST',`/relation/notifications/${notification.id}/ack`,{result:'unreachable'},2);
  assert.equal(first.body.data.escalated,true);assert.equal((await order(orderId)).current_layer,2);
  const second=await http('POST',`/relation/notifications/${notification.id}/ack`,{result:'unreachable'},2);
  assert.equal(second.status,200);assert.equal((await order(orderId)).current_layer,2);
  assert.equal(await count('order_event',"order_id=? AND action='escalate'",[orderId]),1);
});
test('a late old-layer receipt cannot stop the new layer or be reinterpreted after relation editing',async(t)=>{
  freeze(t);const {orderId}=await routeOne();const old=await noti(orderId);
  await routing.scanSla('2026-11-05 10:15:00');await admin.query('UPDATE relation SET level=2 WHERE id=1');
  const response=await http('POST',`/relation/notifications/${old.id}/ack`,{result:'ok_visited'},2);
  assert.equal(response.status,200);assert.equal((await order(orderId)).sla_deadline,'2026-11-05 12:15:00');
});
test('a primary receipt committed first prevents a later timeout scan',async()=>{
  const {orderId}=await routeOne();const notification=await noti(orderId);
  await verification.ackNotification(notification.id,2,'ok_called','2026-11-05 10:14:59');
  assert.equal((await routing.scanSla('2026-11-05 10:15:00')).upgraded,0);
});
test('a receipt racing the timeout cannot clear a newer layer deadline or double-escalate',async()=>{
  const {orderId}=await routeOne();const notification=await noti(orderId);
  await Promise.all([verification.ackNotification(notification.id,2,'ok_called','2026-11-05 10:15:00'),routing.scanSla('2026-11-05 10:15:00')]);
  const row=await order(orderId);
  if(row.current_layer===1)assert.equal(row.sla_deadline,null);else{assert.equal(row.current_layer,2);assert.equal(row.sla_deadline,'2026-11-05 12:15:00');}
  assert.ok(await count('order_event',"order_id=? AND action='escalate'",[orderId])<=1);
});
test('disabled or missing primary layers are skipped and exhausted SLA becomes a visible admin todo',async()=>{
  implemented();await admin.query('UPDATE person SET status=0 WHERE id=2');await alert();const result=await routing.routePendingAlerts(AT);const orderId=result.results[0].orderId;
  assert.equal((await order(orderId)).current_layer,2);assert.equal(await count('notification'),0);
  await routing.scanSla('2026-11-05 12:00:00');const row=await order(orderId);
  assert.equal(row.current_layer,3);assert.equal(row.sla_deadline,null);assert.notEqual(row.status,'closed');
  const todos=await routing.listRoutingTodos();assert.ok(todos.some(todo=>todo.orderId===orderId));
});
test('notification failure rolls back the CAS transition and its event stream',async()=>{
  const {orderId}=await routeOne();await admin.query("INSERT INTO relation (id,elder_id,person_id,level,role_label,is_accountable,priority) VALUES (3,1,8,2,'结对志愿者',1,1)");
  // A fresh order captures the second relation layer before failure is injected.
  await admin.execute("UPDATE verify_order SET status='closed' WHERE id=?",[orderId]);const fresh=await routeOne();
  await admin.query("CREATE TRIGGER reject_l4_notification BEFORE INSERT ON notification FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='test l4 notification failure'");
  try{await assert.rejects(routing.scanSla('2026-11-05 10:15:00'),/test l4 notification failure/);assert.equal((await order(fresh.orderId)).current_layer,1);assert.equal(await count('order_event',"order_id=? AND action='escalate'",[fresh.orderId]),0);}finally{await admin.query('DROP TRIGGER reject_l4_notification');}
});

test('a real T4 output can be consumed into a visible family notification and pinned H2 evidence',async(t)=>{
  implemented();freeze(t);
  for(let i=0;i<14;i++)await admin.execute('INSERT INTO signal_daily (elder_id,stat_date,calendar_confirmed,app_opens) VALUES (1,?,1,2)',[new Date(Date.UTC(2026,9,21+i)).toISOString().slice(0,10)]);
  await admin.query("INSERT INTO signal_daily (elder_id,stat_date,calendar_confirmed,app_opens) VALUES (1,'2026-11-04',0,0)");
  await admin.query("INSERT INTO service_order (elder_id,key_type,status,client_request_id,created_at,done_at) VALUES (1,'buy','done','l4-source','2026-10-01 10:00:00','2026-11-05 03:00:00')");
  const l3=await require('../src/jobs/stratification').runStratification('2026-11-05 04:00:00');const alertId=l3.results.find(r=>r.elderId===1).alertId;
  const routed=await routing.routePendingAlerts(AT);const orderId=routed.results.find(r=>r.alertId===alertId).orderId;
  const detail=await http('GET',`/agent/verify-orders/${orderId}`);assert.equal(detail.status,200);assert.equal(detail.body.data.signals[0].context.baseline.sources.length,14);
  const home=await http('GET','/relation/home',undefined,2);assert.equal(home.status,200);assert.equal(home.body.data.mergedNotification.elderId,1);
});

test('insufficient evidence creates a family prompt and successful uniquely keyed receipt without a verification order',async(t)=>{
  implemented();freeze(t);const alertId=await alert('insufficient');await routing.routePendingAlerts(AT);
  assert.equal(await count('verify_order'),0);assert.equal(await count('notification'),0);
  const home=await http('GET','/relation/home',undefined,2);assert.equal(home.status,200);assert.equal(home.body.data.evidenceRequests[0].alertId,alertId);
  const body={clientRequestId:randomUUID(),result:'ok_called'};
  assert.equal((await http('POST',`/relation/evidence-requests/${alertId}/ack`,body,2)).status,200);
  assert.equal((await http('POST',`/relation/evidence-requests/${alertId}/ack`,body,2)).status,200);
  assert.equal(await count('signal_event',"type='family_confirmed'"),1);assert.equal(await count('verify_order'),0);
  assert.equal((await http('GET','/relation/home',undefined,2)).body.data.evidenceRequests.length,0);
});
test('evidence requests enforce recipient scope and cross-purpose UUID ownership',async(t)=>{
  implemented();freeze(t);const alertId=await alert('insufficient');await routing.routePendingAlerts(AT);
  assert.equal((await http('POST',`/relation/evidence-requests/${alertId}/ack`,{clientRequestId:randomUUID(),result:'ok_called'},10)).status,403);
  const key=randomUUID();await admin.execute("INSERT INTO signal_event (elder_id,type,client_request_id) VALUES (2,'app_open',?)",[key]);
  assert.equal((await http('POST',`/relation/evidence-requests/${alertId}/ack`,{clientRequestId:key,result:'ok_called'},2)).status,409);
});
test('unreachable evidence does not inflate positive confidence or create a nuclear order and is visible to admin',async(t)=>{
  implemented();freeze(t);const alertId=await alert('insufficient');await routing.routePendingAlerts(AT);
  assert.equal((await http('POST',`/relation/evidence-requests/${alertId}/ack`,{clientRequestId:randomUUID(),result:'unreachable'},2)).status,200);
  assert.equal(await count('signal_event',"type='family_confirmed'"),0);assert.equal(await count('verify_order'),0);
  const overview=await http('GET','/admin/overview',undefined,6);assert.equal(overview.status,200);assert.ok(overview.body.data.routingTodos.some(todo=>todo.alertId===alertId));
});
test('evidence audit failure rolls back the event unique key and can be retried',async(t)=>{
  implemented();freeze(t);const alertId=await alert('insufficient');await routing.routePendingAlerts(AT);
  await admin.query("CREATE TRIGGER reject_l4_evidence BEFORE INSERT ON audit_log FOR EACH ROW BEGIN IF NEW.action='evidence_responded' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='test evidence failure'; END IF; END");
  const body={clientRequestId:randomUUID(),result:'ok_visited'};
  try{assert.equal((await http('POST',`/relation/evidence-requests/${alertId}/ack`,body,2)).status,500);assert.equal(await count('signal_event'),0);}finally{await admin.query('DROP TRIGGER reject_l4_evidence');}
  assert.equal((await http('POST',`/relation/evidence-requests/${alertId}/ack`,body,2)).status,200);
});
test('only assigned agents may change a normal order; H3 must precede the final conclusion',async(t)=>{
  freeze(t);const {orderId}=await routeOne();
  assert.equal((await http('POST',`/agent/verify-orders/${orderId}/action`,{action:'call'},5)).status,403);
  assert.equal((await http('POST',`/agent/verify-orders/${orderId}/disposition`,{resultCode:'normal',method:'phone'})).status,409);
  assert.equal((await http('GET','/agent/workbench',undefined,5)).body.data.mine.length,0);
  assert.equal((await http('GET',`/agent/verify-orders/${orderId}`,undefined,5)).status,403);
});
test('concurrent final conclusions create one disposition and close event, with server-calculated statistics',async(t)=>{
  freeze(t);const {orderId}=await routeOne();
  assert.equal((await http('POST',`/agent/verify-orders/${orderId}/action`,{action:'call'})).status,200);
  t.mock.timers.setTime(new Date('2026-11-05T10:04:00+08:00').getTime());
  const results=await Promise.all(Array.from({length:12},()=>http('POST',`/agent/verify-orders/${orderId}/disposition`,{resultCode:'normal',method:'phone',durationMin:999,isInvalidCheck:false})));
  assert.ok(results.every(r=>r.status===200));assert.equal(await count('disposition'),1);
  const result=await db.queryOne('SELECT * FROM disposition');assert.equal(result.duration_min,4);assert.equal(result.is_invalid_check,1);
  assert.equal((await order(orderId)).status,'closed');assert.equal(await count('order_event',"order_id=? AND action='dispose'",[orderId]),1);
});
test('failed conclusion leaves its order open and no partial disposition',async(t)=>{
  freeze(t);const {orderId}=await routeOne();await http('POST',`/agent/verify-orders/${orderId}/action`,{action:'call'});
  await admin.query("CREATE TRIGGER reject_l4_disposition BEFORE INSERT ON disposition FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='test conclusion failure'");
  try{assert.equal((await http('POST',`/agent/verify-orders/${orderId}/disposition`,{resultCode:'normal',method:'phone'})).status,500);assert.notEqual((await order(orderId)).status,'closed');assert.equal(await count('disposition'),0);}finally{await admin.query('DROP TRIGGER reject_l4_disposition');}
});
test('manual agent escalation is a single actual action and creates an admin handoff',async(t)=>{
  freeze(t);const {orderId}=await routeOne();
  const response=await http('POST',`/agent/verify-orders/${orderId}/action`,{action:'escalate'});
  assert.equal(response.status,200);assert.equal((await order(orderId)).current_layer,3);
  assert.equal(await count('order_event',"order_id=? AND action='escalate'",[orderId]),1);
  assert.ok((await routing.listRoutingTodos()).some(todo=>todo.orderId===orderId));
});
test('closed and cancelled orders are never advanced by SLA scans',async()=>{
  const first=await routeOne();await admin.execute("UPDATE verify_order SET status='closed' WHERE id=?",[first.orderId]);
  const second=await routeOne();await admin.execute("UPDATE verify_order SET status='cancelled' WHERE id=?",[second.orderId]);
  assert.equal((await routing.scanSla('2026-11-06 10:00:00')).upgraded,0);
});
test('emergency UUID retries broadcast once to all relation layers and expose parallel instructions without fake actions',async(t)=>{
  implemented();freeze(t);await admin.query("INSERT INTO relation (id,elder_id,person_id,level,role_label,is_accountable,priority) VALUES (3,1,8,3,'邻居',0,1)");
  const body={clientRequestId:randomUUID()};const responses=await Promise.all(Array.from({length:8},()=>http('POST','/elder/emergency',body,1)));
  assert.ok(responses.every(r=>r.status===200));assert.equal(await count('verify_order'),1);assert.equal(await count('notification'),3);
  const row=await db.queryOne('SELECT * FROM verify_order');assert.equal(row.sla_deadline,'2026-11-05 10:05:00');assert.equal(row.assignee_id,4);
  const detail=await http('GET',`/agent/verify-orders/${row.id}`);assert.equal(detail.status,200);assert.deepEqual(detail.body.data.routing.requiredActions,['call','visit']);assert.equal(detail.body.data.routing.parallel,true);
  assert.equal(await count('order_event',"action IN ('call','visit')"),0);
  const broadcast=parse((await db.queryOne("SELECT payload FROM order_event WHERE action='broadcast'")).payload);assert.deepEqual(broadcast.agentIds,[4,5]);assert.deepEqual(broadcast.adminIds,[6]);
  const other=await http('GET',`/agent/verify-orders/${row.id}`,undefined,5);assert.equal(other.status,200);assert.equal(other.body.data.routing.canAct,false);
});
test('distinct emergency requests are not merged and family receipts do not cancel the emergency SLA',async(t)=>{
  implemented();freeze(t);const first=await http('POST','/elder/emergency',{clientRequestId:randomUUID()},1);const second=await http('POST','/elder/emergency',{clientRequestId:randomUUID()},1);
  assert.notEqual(first.body.data.orderId,second.body.data.orderId);const id=first.body.data.orderId;
  const notification=await noti(id);await http('POST',`/relation/notifications/${notification.id}/ack`,{result:'ok_called'},2);
  assert.equal((await order(id)).sla_deadline,'2026-11-05 10:05:00');
  await routing.scanSla('2026-11-05 10:05:00');assert.equal((await order(id)).current_layer,3);assert.notEqual((await order(id)).status,'closed');
});
test('emergency phone-only confirmation keeps a midnight visit obligation and cannot extend it on retry',async(t)=>{
  implemented();freeze(t);const response=await http('POST','/elder/emergency',{clientRequestId:randomUUID()},1);const id=response.body.data.orderId;
  await http('POST',`/agent/verify-orders/${id}/action`,{action:'call'});
  assert.equal((await http('POST',`/agent/verify-orders/${id}/disposition`,{resultCode:'normal',method:'phone'})).status,409);
  assert.equal((await http('POST',`/agent/verify-orders/${id}/disposition`,{resultCode:'phone_confirmed_not_visited',method:'phone'})).status,200);
  assert.notEqual((await order(id)).status,'closed');assert.equal(await count('disposition'),0);assert.equal((await order(id)).sla_deadline,'2026-11-06 00:00:00');
  assert.equal((await http('GET',`/agent/verify-orders/${id}`)).body.data.routing.needsVisit,true);
  assert.equal((await routing.scanSla('2026-11-05 23:59:59')).upgraded,0);
  t.mock.timers.setTime(new Date('2026-11-06T00:01:00+08:00').getTime());
  await http('POST',`/agent/verify-orders/${id}/disposition`,{resultCode:'phone_confirmed_not_visited',method:'phone'});
  assert.equal((await order(id)).sla_deadline,'2026-11-06 00:00:00');
  assert.equal((await routing.scanSla('2026-11-06 00:01:00')).upgraded,1);
});
test('a reported emergency visit can finish the same order after a phone followup without losing the unique final result',async(t)=>{
  implemented();freeze(t);const response=await http('POST','/elder/emergency',{clientRequestId:randomUUID()},1);const id=response.body.data.orderId;
  await http('POST',`/agent/verify-orders/${id}/action`,{action:'call'});
  await http('POST',`/agent/verify-orders/${id}/disposition`,{resultCode:'phone_confirmed_not_visited',method:'phone'});
  t.mock.timers.setTime(new Date('2026-11-05T23:30:00+08:00').getTime());await http('POST',`/agent/verify-orders/${id}/action`,{action:'visit'});
  assert.equal((await order(id)).sla_deadline,'2026-11-06 00:00:00');
  const final=await http('POST',`/agent/verify-orders/${id}/disposition`,{resultCode:'normal',method:'visit'});assert.equal(final.status,200);
  assert.equal((await order(id)).status,'closed');assert.equal(await count('disposition'),1);
});
test('without any enabled staff, routing remains open and records an honest unassigned admin todo',async()=>{
  implemented();await admin.query('UPDATE person SET status=0 WHERE id IN (2,4,5,6)');const alertId=await alert();const result=await routing.routePendingAlerts(AT);const row=await order(result.results.find(r=>r.alertId===alertId).orderId);
  assert.equal(row.assignee_id,null);assert.notEqual(row.status,'closed');assert.equal(await count('notification'),0);
  assert.ok((await routing.listRoutingTodos()).some(todo=>todo.orderId===row.id));
});
test('legacy orders without a dispatch snapshot are preserved and flagged rather than guessed',async()=>{
  const {orderId}=await routeOne();await admin.execute("DELETE FROM order_event WHERE order_id=? AND action='route_plan'",[orderId]);
  const result=await routing.scanSla('2026-11-05 10:15:00');assert.equal(result.legacyReview,1);assert.equal((await order(orderId)).current_layer,1);
  assert.ok((await routing.listRoutingTodos()).some(todo=>todo.orderId===orderId));
});
test('routing and T2 commands report success and nonzero database failures',async()=>{
  implemented();for(const filename of ['routing.js','sla.js']){
    const command=path.join(__dirname,'../src/jobs',filename);const result=await execFile(process.execPath,[command],{env:{...process.env},timeout:15000});assert.match(result.stdout,/完成/);
    await assert.rejects(execFile(process.execPath,[command],{env:{...process.env,DB_NAME:database+'_missing'},timeout:15000}),e=>e.code===1&&/失败/.test(e.stderr));
  }
});

test('concurrent evidence UUID retries all return the same successful result with one signal',async(t)=>{
  implemented();freeze(t);const alertId=await alert('insufficient');await routing.routePendingAlerts(AT);
  const body={clientRequestId:randomUUID(),result:'ok_called'};
  const results=await Promise.all(Array.from({length:8},()=>http('POST',`/relation/evidence-requests/${alertId}/ack`,body,2)));
  assert.ok(results.every(r=>r.status===200));assert.equal(await count('signal_event',"type='family_confirmed'"),1);
});
test('a receipt does not acquire the parent elder lock held by a routing consumer',async()=>{
  const {orderId}=await routeOne();const notification=await noti(orderId);const conn=await db.pool.getConnection();let receipt,timer;
  try{await conn.beginTransaction();await conn.execute('SELECT id FROM elder WHERE id=1 FOR UPDATE');
    receipt=verification.ackNotification(notification.id,2,'ok_called','2026-11-05 10:01:00');
    const timeout=new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(new Error('receipt blocked on parent elder lock')),5000);});
    assert.equal((await Promise.race([receipt,timeout])).ok,true);
  }finally{clearTimeout(timer);await conn.rollback();conn.release();if(receipt)await receipt.catch(()=>{});}
});
test('transfer cannot steal another agents order and preserves the existing deadline for its legitimate new owner',async(t)=>{
  freeze(t);const {orderId}=await routeOne();
  assert.equal((await http('POST',`/agent/verify-orders/${orderId}/transfer`,{toPersonId:5,reason:'代为处理'},5)).status,403);
  assert.equal((await http('POST',`/agent/verify-orders/${orderId}/transfer`,{toPersonId:5,reason:'代为处理'},4)).status,200);
  assert.equal((await order(orderId)).sla_deadline,'2026-11-05 10:15:00');
  assert.equal((await http('POST',`/agent/verify-orders/${orderId}/action`,{action:'call'},4)).status,403);
  assert.equal((await http('POST',`/agent/verify-orders/${orderId}/action`,{action:'call'},5)).status,200);
});

test('the next configured agent takes ownership when the future layer was edited before activation',async()=>{
  const {orderId}=await routeOne();
  await admin.query("INSERT INTO relation (id,elder_id,person_id,level,role_label,is_accountable,priority) VALUES (3,1,5,2,'社区工作者',1,1)");
  await routing.scanSla('2026-11-05 10:15:00');
  assert.equal((await order(orderId)).assignee_id,5);
});
test('a disappeared staff phase still reaches admin monotonically rather than leaving an expired timer',async()=>{
  const {orderId}=await routeOne();await routing.scanSla('2026-11-05 10:15:00');
  await admin.query('UPDATE person SET status=0 WHERE id IN (4,5)');
  const result=await routing.scanSla('2026-11-05 12:15:00');
  assert.equal(result.upgraded,1);assert.equal((await order(orderId)).current_layer,3);assert.equal((await order(orderId)).sla_deadline,null);
});
test('new UUID observations append changed evidence and only newer success resolves an admin todo',async(t)=>{
  implemented();freeze(t);const alertId=await alert('insufficient');await routing.routePendingAlerts(AT);
  await http('POST',`/relation/evidence-requests/${alertId}/ack`,{clientRequestId:randomUUID(),result:'unreachable'},2);
  assert.equal((await http('POST',`/relation/evidence-requests/${alertId}/ack`,{clientRequestId:randomUUID(),result:'ok_called'},2)).status,200);
  assert.equal(await count('signal_event',"type='family_confirmed'"),1);
  assert.equal((await routing.listRoutingTodos()).filter(todo=>todo.alertId===alertId).length,0);
  await http('POST',`/relation/evidence-requests/${alertId}/ack`,{clientRequestId:randomUUID(),result:'unreachable'},2);
  assert.ok((await routing.listRoutingTodos()).some(todo=>todo.alertId===alertId));
  assert.equal(await count('signal_event'),3);assert.equal(await count('verify_order'),0);
});
test('blank staff followup SLA cannot turn an emergency visit into a zero-minute timer',async(t)=>{
  implemented();freeze(t);const created=await http('POST','/elder/emergency',{clientRequestId:randomUUID()},1);const id=created.body.data.orderId;
  await admin.query("UPDATE param SET v=' ' WHERE k='layer2_wait_min'");
  assert.equal((await http('POST',`/agent/verify-orders/${id}/action`,{action:'visit'})).status,500);
  assert.equal((await order(id)).sla_deadline,'2026-11-05 10:05:00');assert.equal(await count('order_event',"order_id=? AND action='visit'",[id]),0);
});
test('late phone confirmation does not undo an existing emergency admin handoff',async(t)=>{
  implemented();freeze(t);const created=await http('POST','/elder/emergency',{clientRequestId:randomUUID()},1);const id=created.body.data.orderId;
  await routing.scanSla('2026-11-05 10:05:00');
  await http('POST',`/agent/verify-orders/${id}/action`,{action:'call'});
  assert.equal((await http('POST',`/agent/verify-orders/${id}/disposition`,{resultCode:'phone_confirmed_not_visited',method:'phone'})).status,200);
  assert.equal((await order(id)).status,'escalated');assert.equal((await order(id)).sla_deadline,null);
});
test('disabled relation users cannot read the newly routed prompts or notification detail',async(t)=>{
  implemented();freeze(t);const {orderId}=await routeOne();const notification=await noti(orderId);
  await alert('insufficient');await routing.routePendingAlerts(AT);await admin.query('UPDATE person SET status=0 WHERE id=2');
  assert.equal((await http('GET','/relation/home',undefined,2)).status,403);
  assert.equal((await http('GET',`/relation/notifications/${notification.id}`,undefined,2)).status,403);
});

test('a manual transfer is not silently replaced by the default agent on the next SLA layer',async(t)=>{
  freeze(t);const {orderId}=await routeOne();
  await http('POST',`/agent/verify-orders/${orderId}/transfer`,{toPersonId:5,reason:'由同事继续处理'},4);
  await routing.scanSla('2026-11-05 10:15:00');
  assert.equal((await order(orderId)).assignee_id,5);
  const activation=await db.queryOne("SELECT payload FROM order_event WHERE order_id=? AND action='notify' ORDER BY id DESC LIMIT 1",[orderId]);
  assert.equal(parse(activation.payload).primaryId,5);
});
test('a closed order advertises no executable actions',async(t)=>{
  freeze(t);const {orderId}=await routeOne();await http('POST',`/agent/verify-orders/${orderId}/action`,{action:'call'});
  await http('POST',`/agent/verify-orders/${orderId}/disposition`,{resultCode:'normal',method:'phone'});
  const detail=await http('GET',`/agent/verify-orders/${orderId}`);
  assert.equal(detail.body.data.routing.canAct,false);assert.deepEqual(detail.body.data.actions,[]);
});

test('shrinking the configured chain cannot skip an enabled but never activated agent fallback',async()=>{
  implemented();await admin.query("UPDATE param SET v='4' WHERE k='layer_count'");
  await admin.query("INSERT INTO relation (id,elder_id,person_id,level,role_label,is_accountable,priority) VALUES (3,1,8,4,'结对志愿者',1,1)");
  const {orderId}=await routeOne();await routing.scanSla('2026-11-05 10:15:00');assert.equal((await order(orderId)).current_layer,4);
  await admin.query('DELETE FROM relation WHERE id=3');await routing.scanSla('2026-11-05 12:15:00');
  const row=await order(orderId);assert.equal(row.current_layer,5);assert.equal(row.sla_deadline,'2026-11-05 14:15:00');
  const activation=parse((await db.queryOne("SELECT payload FROM order_event WHERE order_id=? AND action='notify' ORDER BY id DESC LIMIT 1",[orderId])).payload);
  assert.equal(activation.kind,'agent');assert.equal(activation.primaryId,4);
  await routing.scanSla('2026-11-05 14:15:00');assert.equal((await order(orderId)).current_layer,6);assert.equal((await order(orderId)).sla_deadline,null);
});
test('repeated emergency visit actions and later config edits cannot extend the first followup deadline',async(t)=>{
  implemented();freeze(t);const created=await http('POST','/elder/emergency',{clientRequestId:randomUUID()},1);const id=created.body.data.orderId;
  t.mock.timers.setTime(new Date('2026-11-05T10:01:00+08:00').getTime());await http('POST',`/agent/verify-orders/${id}/action`,{action:'visit'});
  assert.equal((await order(id)).sla_deadline,'2026-11-05 12:01:00');
  await admin.query("UPDATE param SET v='240' WHERE k='layer2_wait_min'");
  t.mock.timers.setTime(new Date('2026-11-05T11:59:00+08:00').getTime());await http('POST',`/agent/verify-orders/${id}/action`,{action:'visit'});
  assert.equal((await order(id)).sla_deadline,'2026-11-05 12:01:00');
  assert.equal((await routing.scanSla('2026-11-05 12:01:00')).upgraded,1);
});

test('a later phone followup cannot extend the first emergency visit deadline to midnight',async(t)=>{
  implemented();freeze(t);const created=await http('POST','/elder/emergency',{clientRequestId:randomUUID()},1);const id=created.body.data.orderId;
  t.mock.timers.setTime(new Date('2026-11-05T10:01:00+08:00').getTime());await http('POST',`/agent/verify-orders/${id}/action`,{action:'visit'});
  assert.equal((await order(id)).sla_deadline,'2026-11-05 12:01:00');
  t.mock.timers.setTime(new Date('2026-11-05T11:59:00+08:00').getTime());await http('POST',`/agent/verify-orders/${id}/action`,{action:'call'});
  const response=await http('POST',`/agent/verify-orders/${id}/disposition`,{resultCode:'phone_confirmed_not_visited',method:'phone'});assert.equal(response.status,200);
  assert.equal((await order(id)).sla_deadline,'2026-11-05 12:01:00');
  const followup=await db.queryOne("SELECT payload FROM order_event WHERE order_id=? AND action='phone_followup'",[id]);assert.equal(parse(followup.payload).dueAt,'2026-11-06 00:00:00');
  assert.equal((await routing.scanSla('2026-11-05 12:01:00')).upgraded,1);assert.equal((await routing.scanSla('2026-11-05 12:01:00')).upgraded,0);
});
test('no-recipient emergency is honest and UUID replay preserves the original delivery facts',async(t)=>{
  implemented();freeze(t);await admin.query('DELETE FROM relation');await admin.query('UPDATE person SET status=0 WHERE id IN (4,5,6)');
  const body={clientRequestId:randomUUID()};const first=await http('POST','/elder/emergency',body,1);
  assert.equal(first.status,200);assert.doesNotMatch(first.body.data.promise,/已通知/);assert.match(first.body.data.promise,/没有可用/);
  assert.equal(await count('notification'),0);
  await admin.query('UPDATE person SET status=1 WHERE id IN (4,5,6)');
  const replay=await http('POST','/elder/emergency',body,1);assert.equal(replay.body.data.promise,first.body.data.promise);assert.equal(replay.body.data.orderId,first.body.data.orderId);
  assert.equal(await count('notification'),0);
});

test('an existing emergency replays its saved facts despite bad new config without bypassing ownership or account checks',async(t)=>{
  implemented();freeze(t);const body={clientRequestId:randomUUID()};const first=await http('POST','/elder/emergency',body,1);
  await admin.query("UPDATE param SET v='' WHERE k='layer2_wait_min'");
  const replay=await http('POST','/elder/emergency',body,1);
  assert.equal(replay.status,200);assert.equal(replay.body.data.orderId,first.body.data.orderId);assert.equal(replay.body.data.promise,first.body.data.promise);
  assert.equal((await http('POST','/elder/emergency',body,7)).status,409);
  assert.equal((await http('POST','/elder/emergency',{clientRequestId:randomUUID()},1)).status,500);
  await admin.query('UPDATE person SET status=0 WHERE id=1');assert.equal((await http('POST','/elder/emergency',body,1)).status,403);
  assert.equal(await count('verify_order'),1);assert.equal(await count('notification'),2);
});

const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);
const mysql = require('mysql2/promise');

const database = `yinling_l3_test_${process.pid}_${Date.now().toString(36)}`;
Object.assign(process.env, {
  DB_HOST: '127.0.0.1', DB_PORT: process.env.L1_TEST_MYSQL_PORT || '13308',
  DB_USER: 'root', DB_PASSWORD: '', DB_NAME: database, JWT_SECRET: randomUUID(), NODE_ENV: 'test',
});
let admin, db, jobs = {}, server, baseUrl, ownedDatabase = false;
const at = '2026-11-05 12:00:00';
const parse = value => typeof value === 'string' ? JSON.parse(value) : value;

function implemented() { assert.equal(typeof jobs.runStratification, 'function', 'T4 stratification job is implemented'); }
async function seedHistory() {
  for (let i = 0; i < 14; i += 1) {
    const date = new Date(Date.UTC(2026, 9, 21 + i)).toISOString().slice(0, 10);
    await admin.execute('INSERT INTO signal_daily (elder_id,stat_date,calendar_confirmed,app_opens,request_count) VALUES (1,?,1,2,0)', [date]);
  }
}
async function seedTarget(normal = false) {
  await seedHistory();
  await admin.execute("INSERT INTO signal_daily (elder_id,stat_date,calendar_confirmed,app_opens,request_count) VALUES (1,'2026-11-04',?,?,0)", [normal ? 1 : 0, normal ? 2 : 0]);
}
async function serviceEvidence() {
  await admin.query("INSERT INTO service_order (id,elder_id,key_type,status,client_request_id,created_at,done_at) VALUES (1,1,'buy','done','l3-service-1','2026-10-01 10:00:00','2026-11-05 03:00:00')");
  await admin.query("UPDATE signal_daily SET last_service_at='2026-11-05 03:00:00' WHERE elder_id=1 AND stat_date='2026-11-04'");
}
async function request(endpoint, personId, functions) {
  const token = require('../src/utils/jwt').sign({ id: personId, name: 'L3 test', functions });
  const response = await fetch(baseUrl + endpoint, { headers: { Authorization: `Bearer ${token}` } });
  return { status: response.status, body: await response.json() };
}
async function linkedOrder(alertId = 1) {
  await admin.execute("INSERT INTO verify_order (id,elder_id,alert_id,source,status,assignee_id) VALUES (1,1,?,'alert','assigned',3)", [alertId]);
  await admin.query("INSERT INTO notification (id,order_type,order_id,relation_id,person_id,is_accountable,sent_at) VALUES (1,'verify',1,1,2,1,'2026-11-05 05:00:00')");
}
async function oldAndNewAlerts() {
  await admin.execute("INSERT INTO alert (id,elder_id,d_score,q_score,cell,signal_snapshot,created_at) VALUES (1,1,0.75,0.8,'strong',?,'2026-11-05 04:00:00'),(2,1,0.1,0.1,'missing',?,'2026-11-05 06:00:00')", [JSON.stringify([{ signal: 'old', note: '旧单自己的依据' }]), JSON.stringify([{ signal: 'new', note: '后来另一条依据' }])]);
}

before(async () => {
  admin = await mysql.createConnection({ host: '127.0.0.1', port: Number(process.env.DB_PORT), user: 'root', password: '', multipleStatements: true, dateStrings: true, timezone: '+08:00' });
  assert.match(database, /^yinling_l3_test_[a-z0-9_]+$/);
  await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
  ownedDatabase = true;
  await admin.changeUser({ database });
  const schema = fs.readFileSync(path.join(__dirname, '../../sql/schema.sql'), 'utf8');
  const start = schema.indexOf('CREATE TABLE person');
  assert.ok(start > 0);
  await admin.query(schema.slice(start));
  for (let id = 1; id <= 8; id += 1) {
    const functions = id === 2 ? ['relation', 'service'] : id === 3 ? ['agent'] : id === 4 ? ['admin'] : ['resident'];
    await admin.execute("INSERT INTO person (id,phone,name,functions) VALUES (?,?,'L3 test',?)", [id, 'l3-test-' + id, JSON.stringify(functions)]);
  }
  for (let id = 1; id <= 5; id += 1) {
    await admin.execute("INSERT INTO elder (id,person_id,name,birth_year,addr,status,monitor_level,community_id) VALUES (?,?,'L3 test',1948,'Test address',?,?,?)", [id, id === 1 ? 1 : id + 3, id === 4 ? 'paused' : 'active', id === 3 ? 'record_only' : 'monitor', id === 5 ? 2 : 1]);
  }
  await admin.query("INSERT INTO relation (id,elder_id,person_id,level,role_label,is_accountable) VALUES (1,1,2,1,'家属',1)");
  db = require('../src/db');
  try { jobs = require('../src/jobs/stratification'); }
  catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
  const app = require('../src/app');
  server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  baseUrl = `http://127.0.0.1:${server.address().port}/api`;
});

beforeEach(async () => {
  await admin.query('DELETE FROM order_event; DELETE FROM notification; DELETE FROM verify_order; DELETE FROM service_order; DELETE FROM alert; DELETE FROM audit_log; DELETE FROM signal_event; DELETE FROM signal_daily; DELETE FROM param');
  await admin.query("INSERT INTO param (community_id,k,v) VALUES (1,'day_cut_hour','4'),(1,'baseline_days','14')");
});
after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  if (db) await db.pool.end();
  if (admin) { try { if (ownedDatabase) await admin.query(`DROP DATABASE \`${database}\``); } finally { await admin.end(); } }
});

test('a real scan stores D and Q separately with the full snapshot and dispatch intent', async () => {
  implemented(); await seedTarget(); await serviceEvidence();
  const result = await jobs.runStratification(at);
  assert.equal(result.targetDate, '2026-11-04');
  assert.equal(result.elders, 2);
  assert.equal(result.createdAlerts, 1);
  const alert = await db.queryOne('SELECT * FROM alert');
  assert.equal(Number(alert.d_score), 0.667);
  assert.equal(Number(alert.q_score), 0.671);
  assert.equal(alert.cell, 'strong');
  const snapshot = parse(alert.signal_snapshot);
  assert.equal(snapshot.length, 5);
  assert.equal(snapshot[0].context.baseline.sources.length, 14);
  assert.equal(snapshot[0].context.current.stat_date, '2026-11-04');
  assert.equal(snapshot[0].context.routeIntent, 'dispatch_verify');
  assert.match(snapshot[0].context.inputHash, /^[0-9a-f]{64}$/);
  assert.equal(snapshot.find(s => s.signal === 'service_completed').source.table, 'service_order');
  assert.equal((await db.queryOne('SELECT COUNT(*) AS n FROM verify_order')).n, 0);
  assert.equal((await db.queryOne('SELECT COUNT(*) AS n FROM notification')).n, 0);
});

for (const [normal, highQ, cell, route, expectedAlerts] of [
  [false, false, 'insufficient', 'request_evidence', 1],
  [true, true, 'normal', 'no_intervention', 0],
  [true, false, 'missing', 'wait_next_scan', 0],
]) {
  test(`${cell} follows its own audited path without producing an unwanted verification order`, async () => {
    implemented(); await seedTarget(normal); if (highQ) await serviceEvidence();
    const result = await jobs.runStratification(at);
    const item = result.results.find(row => row.elderId === 1);
    assert.equal(item.cell, cell);
    assert.equal(item.routeIntent, route);
    assert.equal((await db.queryOne('SELECT COUNT(*) AS n FROM alert')).n, expectedAlerts);
    const audit = await db.queryOne("SELECT payload FROM audit_log WHERE action='l3_classified' AND target_id=1");
    assert.equal(parse(audit.payload).cell, cell);
    assert.equal((await db.queryOne('SELECT COUNT(*) AS n FROM verify_order')).n, 0);
  });
}

test('identical input reruns and eight concurrent scans create only one actionable alert', async () => {
  implemented(); await seedTarget(); await serviceEvidence();
  const runs = await Promise.all(Array.from({ length: 8 }, () => jobs.runStratification(at)));
  assert.equal(runs.reduce((sum, result) => sum + result.createdAlerts, 0), 1);
  assert.equal((await db.queryOne('SELECT COUNT(*) AS n FROM alert')).n, 1);
  assert.equal((await db.queryOne('SELECT COUNT(*) AS n FROM audit_log')).n, 2);
  const repeated = await jobs.runStratification('2026-11-05 13:00:00');
  assert.equal(repeated.createdAlerts, 0);
  assert.equal(repeated.reused, 2);
});

test('changed input creates a new immutable alert instead of overwriting the old evidence', async () => {
  implemented(); await seedTarget(); await serviceEvidence();
  await jobs.runStratification(at);
  const original = await db.queryOne('SELECT * FROM alert');
  await admin.query("UPDATE signal_daily SET app_opens=1 WHERE elder_id=1 AND stat_date='2026-11-04'");
  const result = await jobs.runStratification('2026-11-05 13:00:00');
  assert.equal(result.createdAlerts, 1);
  const records = await db.query('SELECT * FROM alert ORDER BY id');
  assert.equal(records.length, 2);
  assert.deepEqual(records[0], original);
  assert.equal(Number(records[1].d_score), 0.5);
});

test('T1 importing the same service fact does not change its canonical identity or create another alert', async () => {
  implemented(); await seedTarget(); await serviceEvidence();
  await admin.query("UPDATE signal_daily SET last_service_at=NULL WHERE elder_id=1 AND stat_date='2026-11-04'");
  const first = await jobs.runStratification(at);
  await require('../src/engine/l1').aggregateDay('2026-11-04');
  assert.equal((await db.queryOne("SELECT last_service_at FROM signal_daily WHERE elder_id=1 AND stat_date='2026-11-04'")).last_service_at, '2026-11-05 03:00:00');
  const next = await jobs.runStratification('2026-11-05 13:00:00');
  assert.deepEqual([next.results[0].dScore, next.results[0].qScore], [first.results[0].dScore, first.results[0].qScore]);
  assert.equal(next.results.find(r => r.elderId === 1).alertId, first.results.find(r => r.elderId === 1).alertId);
  assert.equal((await db.queryOne('SELECT COUNT(*) AS n FROM alert')).n, 1);
});

test('a T4 alert round trips through the real H2 and R2 routes with its full immutable basis', async () => {
  implemented(); await seedTarget(); await serviceEvidence();
  const result = await jobs.runStratification(at);
  const alertId = result.results.find(row => row.elderId === 1).alertId;
  await linkedOrder(alertId);
  const detail = await request('/agent/verify-orders/1', 3, ['agent']);
  assert.equal(detail.status, 200);
  assert.deepEqual([detail.body.data.alert.d, detail.body.data.alert.q], [0.667, 0.671]);
  assert.equal(detail.body.data.signals[0].context.baseline.sources.length, 14);
  assert.equal(detail.body.data.signals[0].context.routeIntent, 'dispatch_verify');
  const relation = await request('/relation/notifications/1', 2, ['relation']);
  assert.equal(relation.status, 200);
  assert.equal(relation.body.data.reasons.length, 5);
  assert.ok(relation.body.data.reasons.every(reason => /[\u4e00-\u9fff]/.test(reason)));
});

test('cold history and absent target data are audited without inventing numeric D', async () => {
  implemented(); await seedHistory();
  await jobs.runStratification(at);
  let audit = parse((await db.queryOne("SELECT payload FROM audit_log WHERE target_id=1 AND action='l3_classified' ORDER BY id DESC LIMIT 1")).payload);
  assert.equal(audit.status, 'insufficient'); assert.equal(audit.dScore, null); assert.equal(audit.cell, null);
  await admin.query("DELETE FROM signal_daily WHERE stat_date='2026-10-21'");
  await admin.query("INSERT INTO signal_daily (elder_id,stat_date,calendar_confirmed,app_opens) VALUES (1,'2026-11-04',0,0)");
  await jobs.runStratification(at);
  audit = parse((await db.queryOne("SELECT payload FROM audit_log WHERE target_id=1 AND action='l3_classified' ORDER BY id DESC LIMIT 1")).payload);
  assert.equal(audit.status, 'insufficient'); assert.equal(audit.dScore, null);
  assert.equal((await db.queryOne('SELECT COUNT(*) AS n FROM alert')).n, 0);
});

test('a failed audit rolls back the whole scan including an alert already inserted for an earlier elder', async () => {
  implemented(); await seedTarget(); await serviceEvidence();
  await admin.query("CREATE TRIGGER reject_l3_audit BEFORE INSERT ON audit_log FOR EACH ROW BEGIN IF NEW.target_id=2 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='test l3 audit failure'; END IF; END");
  try {
    await assert.rejects(jobs.runStratification(at), /test l3 audit failure/);
    assert.equal((await db.queryOne('SELECT COUNT(*) AS n FROM alert')).n, 0);
    assert.equal((await db.queryOne('SELECT COUNT(*) AS n FROM audit_log')).n, 0);
  } finally { await admin.query('DROP TRIGGER reject_l3_audit'); }
});

test('the 04:00 boundary selects the just-completed target day without including it in training', async () => {
  implemented(); await seedTarget(); await serviceEvidence();
  const beforeCut = await jobs.runStratification('2026-11-05 03:59:59');
  assert.equal(beforeCut.targetDate, '2026-11-03');
  assert.equal(beforeCut.createdAlerts, 0);
  const afterCut = await jobs.runStratification('2026-11-05 04:00:00');
  assert.equal(afterCut.targetDate, '2026-11-04');
  assert.equal(afterCut.createdAlerts, 1);
});

test('an event at the next cut cannot increase the target day confidence', async () => {
  implemented(); await seedTarget();
  await admin.query("INSERT INTO signal_event (elder_id,type,client_request_id,ts) VALUES (1,'calendar_confirmed','l3-future','2026-11-05 04:00:00')");
  const result = await jobs.runStratification(at);
  assert.equal(result.results.find(r => r.elderId === 1).qScore, 0);
});

test('H2 reads the order linked alert rather than the elder latest alert', async () => {
  await oldAndNewAlerts(); await linkedOrder();
  const response = await request('/agent/verify-orders/1', 3, ['agent']);
  assert.equal(response.status, 200);
  assert.equal(response.body.data.alert.d, 0.75);
  assert.equal(response.body.data.signals[0].note, '旧单自己的依据');
});

test('relation detail and home retain the notification order evidence after a newer alert', async () => {
  await oldAndNewAlerts(); await linkedOrder();
  const detail = await request('/relation/notifications/1', 2, ['relation']);
  assert.equal(detail.status, 200);
  assert.deepEqual(detail.body.data.reasons, ['旧单自己的依据']);
  const home = await request('/relation/home', 2, ['relation']);
  assert.equal(home.body.data.mergedNotification.reason, '旧单自己的依据');
});

test('an order without an alert link does not borrow another alert for the same elder', async () => {
  await oldAndNewAlerts(); await linkedOrder(null);
  const response = await request('/agent/verify-orders/1', 3, ['agent']);
  assert.equal(response.body.data.alert, null);
  assert.deepEqual(response.body.data.signals, []);
});

test('invalid cut configuration fails without audit or alert writes', async () => {
  implemented();
  await admin.query("UPDATE param SET v=' ' WHERE k='day_cut_hour'");
  await assert.rejects(jobs.runStratification(at), /day_cut_hour/);
  assert.equal((await db.queryOne('SELECT COUNT(*) AS n FROM audit_log')).n, 0);
  assert.equal((await db.queryOne('SELECT COUNT(*) AS n FROM alert')).n, 0);
});

test('T4 CLI exposes success and returns nonzero with a visible database failure', async () => {
  implemented();
  const command = path.join(__dirname, '../src/jobs/stratification.js');
  const result = await execFile(process.execPath, [command], { env: { ...process.env }, timeout: 10000 });
  assert.match(result.stdout, /\[T4\] 分层完成/);
  await assert.rejects(execFile(process.execPath, [command], { env: { ...process.env, DB_NAME: database + '_missing' }, timeout: 10000 }), error => error.code === 1 && /\[T4\] 分层失败/.test(error.stderr));
});

test('persisted button/audio values remain immutable when a later source value changes', async () => {
  implemented(); await seedTarget();
  await admin.query("UPDATE signal_daily SET request_count=2 WHERE elder_id=1 AND stat_date='2026-11-04'");
  await admin.query("INSERT INTO service_order (id,elder_id,key_type,audio_file_id,audio_duration,client_request_id,created_at) VALUES (99,1,'unwell','local://test-audio',20,'l3-audio-99','2026-11-04 20:00:00'),(100,1,'buy',NULL,NULL,'l3-audio-100','2026-11-04 10:00:00')");
  await require('../src/jobs/day-cut').runDayCut(at);
  await jobs.runStratification(at);
  const original = await db.queryOne('SELECT * FROM alert');
  const signal = parse(original.signal_snapshot).find(s => s.signal === 'button_pressed');
  assert.deepEqual(signal.value, { keyType: 'unwell', hasAudio: true, audioDuration: 20 });
  assert.equal(signal.aggregateValue, 2);
  assert.deepEqual(signal.source, { table: 'service_order', id: 99 });
  await admin.query('UPDATE service_order SET audio_duration=30 WHERE id=99');
  const next = await jobs.runStratification('2026-11-05 13:00:00');
  assert.equal(next.createdAlerts, 1);
  const records = await db.query('SELECT * FROM alert ORDER BY id');
  assert.equal(records.length, 2);
  assert.deepEqual(records[0], original);
  assert.equal(parse(records[1].signal_snapshot).find(s => s.signal === 'button_pressed').value.audioDuration, 30);
});

test('same-second independent and notification evidence keeps one decision across T1 projection',async()=>{
  implemented();await seedTarget();
  await admin.query("INSERT INTO verify_order (id,elder_id,source,status) VALUES (77,1,'emergency','assigned')");
  await admin.query("INSERT INTO notification (id,order_type,order_id,relation_id,person_id,is_accountable,sent_at,ack_at,ack_result) VALUES (10,'verify',77,1,2,1,'2026-11-05 02:00:00','2026-11-05 03:00:00','ok_called')");
  await admin.execute("INSERT INTO signal_event (id,elder_id,type,payload,client_request_id,ts) VALUES (100,1,'family_confirmed',?,?,'2026-11-05 03:00:00')",[JSON.stringify({source:'evidence_request',result:'ok_called'}),randomUUID()]);
  const first=await jobs.runStratification(at);assert.equal(first.createdAlerts,1);
  const original=await db.queryOne('SELECT * FROM alert');assert.deepEqual(parse(original.signal_snapshot).find(s=>s.signal==='family_confirmed').source,{table:'signal_event',id:100});
  await require('../src/jobs/day-cut').runDayCut(at);const next=await jobs.runStratification('2026-11-05 13:00:00');
  assert.equal(next.createdAlerts,0);assert.equal(next.results.find(r=>r.elderId===1).alertId,original.id);assert.deepEqual(await db.queryOne('SELECT * FROM alert'),original);
});

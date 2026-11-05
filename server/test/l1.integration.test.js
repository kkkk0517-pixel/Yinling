const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const mysql = require('mysql2/promise');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);

// This suite creates only its own database on a dedicated local test server.
const database = `yinling_l1_test_${process.pid}_${Date.now().toString(36)}`;
Object.assign(process.env, {
  DB_HOST: '127.0.0.1', DB_PORT: process.env.L1_TEST_MYSQL_PORT || '13308',
  DB_USER: 'root', DB_PASSWORD: '', DB_NAME: database,
  JWT_SECRET: randomUUID(), NODE_ENV: 'test',
});
let admin, db, server, baseUrl, ownedDatabase = false;

async function request(method, endpoint, body, personId = 1) {
  const { sign } = require('../src/utils/jwt');
  const token = sign({ id: personId, name: 'Test resident', functions: ['resident'] });
  const response = await fetch(baseUrl + endpoint, {
    method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await response.json() };
}

before(async () => {
  admin = await mysql.createConnection({
    host: '127.0.0.1', port: Number(process.env.DB_PORT), user: 'root', password: '',
    multipleStatements: true, dateStrings: true, timezone: '+08:00',
  });
  assert.match(database, /^yinling_l1_test_[a-z0-9_]+$/);
  await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
  ownedDatabase = true;
  await admin.changeUser({ database });
  const schema = fs.readFileSync(path.join(__dirname, '../../sql/schema.sql'), 'utf8');
  const tableStart = schema.indexOf('CREATE TABLE person');
  assert.ok(tableStart > 0);
  await admin.query(schema.slice(tableStart));
  await admin.query("INSERT INTO person (id,phone,name,functions) VALUES (1,'test-1','Test 1',JSON_ARRAY('resident')),(2,'test-2','Test 2',JSON_ARRAY('resident'))");
  await admin.query("INSERT INTO elder (id,person_id,name,birth_year,addr) VALUES (1,1,'Test 1',1948,'Test address'),(2,2,'Test 2',1948,'Test address')");
  db = require('../src/db');
  const app = require('../src/app');
  server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  baseUrl = `http://127.0.0.1:${server.address().port}/api/elder`;
});

beforeEach(async () => {
  await admin.query('DELETE FROM signal_event; DELETE FROM signal_daily; DELETE FROM notification; DELETE FROM verify_order; DELETE FROM service_order; DELETE FROM param');
  await admin.query("INSERT INTO param (community_id,k,v) VALUES (1,'day_cut_hour','4')");
});

after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  if (db) await db.pool.end();
  if (admin) {
    try { if (ownedDatabase) await admin.query(`DROP DATABASE \`${database}\``); }
    finally { await admin.end(); }
  }
});

test('calendar confirm rejects absent and malformed request IDs without writing data', async () => {
  for (const body of [{}, { clientRequestId: 'not-a-uuid' }]) {
    assert.equal((await request('POST', '/calendar/confirm', body)).status, 422);
  }
  assert.equal((await db.queryOne('SELECT COUNT(*) AS n FROM signal_event')).n, 0);
  assert.equal((await db.queryOne('SELECT COUNT(*) AS n FROM signal_daily')).n, 0);
});

test('retry returns the original confirmation time and does not invent app opens or family confirmation', async () => {
  const payload = { clientRequestId: randomUUID() };
  const first = await request('POST', '/calendar/confirm', payload);
  const second = await request('POST', '/calendar/confirm', payload);
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(second.body.data.confirmedAt, first.body.data.confirmedAt);
  assert.equal((await db.queryOne('SELECT COUNT(*) AS n FROM signal_event')).n, 1);
  const daily = await db.queryOne('SELECT * FROM signal_daily WHERE elder_id=1');
  assert.equal(daily.calendar_confirmed, 1);
  assert.equal(daily.app_opens, 0);
  assert.equal(daily.last_confirm_at, null);
  assert.equal(first.body.data.streak, 1);
});

test('sixteen simultaneous confirmations with the same key all succeed and persist one event', async () => {
  const payload = { clientRequestId: randomUUID() };
  const responses = await Promise.all(Array.from({ length: 16 }, () => request('POST', '/calendar/confirm', payload)));
  assert.deepEqual(responses.map(r => r.status), Array(16).fill(200));
  assert.equal((await db.queryOne('SELECT COUNT(*) AS n FROM signal_event')).n, 1);
  assert.equal((await db.queryOne('SELECT COUNT(*) AS n FROM signal_daily')).n, 1);
});

test('a different resident cannot replay another resident confirmation key', async () => {
  const payload = { clientRequestId: randomUUID() };
  assert.equal((await request('POST', '/calendar/confirm', payload)).status, 200);
  assert.equal((await request('POST', '/calendar/confirm', payload, 2)).status, 409);
  assert.equal((await db.queryOne('SELECT COUNT(*) AS n FROM signal_daily WHERE elder_id=2')).n, 0);
});

test('home records only a weak app-open signal', async () => {
  const response = await request('GET', '/home');
  assert.equal(response.status, 200);
  assert.equal(response.body.data.todayConfirmed, false);
  const events = await db.query('SELECT type FROM signal_event');
  assert.deepEqual(events, [{ type: 'app_open' }]);
  const daily = await db.queryOne('SELECT * FROM signal_daily WHERE elder_id=1');
  assert.equal(daily.app_opens, 1);
  assert.equal(daily.calendar_confirmed, 0);
  assert.ok(daily.last_open_at);
});

test('calendar and home share the 04:00 boundary; yesterday replay does not confirm today', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-04T03:59:59+08:00').getTime() });
  const payload = { clientRequestId: randomUUID() };
  const first = await request('POST', '/calendar/confirm', payload);
  assert.equal(first.status, 200);
  assert.equal((await db.queryOne('SELECT stat_date FROM signal_daily WHERE elder_id=1')).stat_date, '2026-11-03');
  assert.equal((await request('GET', '/home')).body.data.todayConfirmed, true);
  t.mock.timers.setTime(new Date('2026-11-04T04:00:00+08:00').getTime());
  assert.equal((await request('GET', '/home')).body.data.todayConfirmed, false);
  const replay = await request('POST', '/calendar/confirm', payload);
  assert.equal(replay.body.data.confirmedAt, first.body.data.confirmedAt);
  assert.equal((await request('GET', '/home')).body.data.todayConfirmed, false);
});

test('streak stops at a missing date instead of skipping historical gaps', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-04T12:00:00+08:00').getTime() });
  await admin.query("INSERT INTO signal_daily (elder_id,stat_date,calendar_confirmed) VALUES (1,'2026-11-02',1),(1,'2026-11-01',1)");
  assert.equal((await request('GET', '/home')).body.data.calendar.streak, 0);
});

test('day cut imports business sources once, aggregates a closed day, and creates empty current rows', async () => {
  const { runDayCut } = require('../src/jobs/day-cut');
  await admin.query("INSERT INTO signal_event (elder_id,type,ts,client_request_id) VALUES (1,'app_open','2026-11-04 03:59:59','raw-open'),(1,'calendar_confirmed','2026-11-03 09:00:00','raw-confirm')");
  await admin.query("INSERT INTO service_order (id,elder_id,key_type,audio_file_id,audio_duration,client_request_id,created_at,done_at,status) VALUES (1,1,'buy','local://test-audio',7,'request-1','2026-11-03 10:00:00','2026-11-03 11:00:00','done')");
  await admin.query("INSERT INTO verify_order (id,elder_id,source) VALUES (1,1,'alert')");
  await admin.query("INSERT INTO notification (order_type,order_id,relation_id,person_id,ack_at,ack_result) VALUES ('verify',1,1,2,'2026-11-03 12:00:00','ok_called'),('verify',1,1,2,'2026-11-03 13:00:00','unreachable')");
  await runDayCut('2026-11-04 04:00:00');
  await runDayCut('2026-11-04 04:00:00');
  const old = await db.queryOne("SELECT * FROM signal_daily WHERE elder_id=1 AND stat_date='2026-11-03'");
  assert.equal(old.calendar_confirmed, 1);
  assert.equal(old.app_opens, 1);
  assert.equal(old.request_count, 1);
  assert.equal(old.last_open_at, '2026-11-04 03:59:59');
  assert.equal(old.last_service_at, '2026-11-03 11:00:00');
  assert.equal(old.last_confirm_at, '2026-11-03 12:00:00');
  const current = await db.queryOne("SELECT * FROM signal_daily WHERE elder_id=1 AND stat_date='2026-11-04'");
  assert.equal(current.calendar_confirmed, 0);
  assert.equal(current.last_service_at, '2026-11-03 11:00:00');
  assert.equal((await db.queryOne('SELECT COUNT(*) AS n FROM signal_daily')).n, 4);
  assert.equal((await db.queryOne('SELECT COUNT(*) AS n FROM signal_event')).n, 5);
  const button = await db.queryOne("SELECT payload FROM signal_event WHERE type='button_pressed'");
  const payload = typeof button.payload === 'string' ? JSON.parse(button.payload) : button.payload;
  assert.equal(payload.orderId, 1);
  assert.equal(payload.hasAudio, true);
  assert.equal(payload.audioDuration, 7);
});

test('concurrent day-cut reruns preserve a confirmation already made in the current day', async () => {
  const { recordSignal } = require('../src/engine/l1');
  const { runDayCut } = require('../src/jobs/day-cut');
  await recordSignal({ elderId: 1, type: 'calendar_confirmed', clientRequestId: randomUUID(), at: '2026-11-04 04:00:01' });
  await Promise.all(Array.from({ length: 3 }, () => runDayCut('2026-11-04 04:00:02')));
  assert.equal((await db.queryOne("SELECT calendar_confirmed FROM signal_daily WHERE elder_id=1 AND stat_date='2026-11-04'")).calendar_confirmed, 1);
});

test('reaggregation does not overwrite concurrently collected app opens', async () => {
  const { recordSignal, aggregateDay } = require('../src/engine/l1');
  await recordSignal({ elderId: 1, type: 'app_open', clientRequestId: randomUUID(), at: '2026-11-04 10:00:00' });
  await Promise.all([
    aggregateDay('2026-11-04'),
    ...Array.from({ length: 12 }, () => recordSignal({ elderId: 1, type: 'app_open', clientRequestId: randomUUID(), at: '2026-11-04 10:00:01' })),
  ]);
  const daily = await db.queryOne("SELECT app_opens FROM signal_daily WHERE elder_id=1 AND stat_date='2026-11-04'");
  assert.equal(daily.app_opens, 13);
});

test('a database failure rolls back both event and immediate aggregate', async () => {
  const { recordSignal } = require('../src/engine/l1');
  await admin.query("CREATE TRIGGER reject_l1_update BEFORE UPDATE ON signal_daily FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='test aggregate failure'");
  try {
    await assert.rejects(recordSignal({ elderId: 1, type: 'app_open', clientRequestId: randomUUID(), at: '2026-11-04 10:00:00' }), /test aggregate failure/);
    assert.equal((await db.queryOne('SELECT COUNT(*) AS n FROM signal_event')).n, 0);
    assert.equal((await db.queryOne('SELECT COUNT(*) AS n FROM signal_daily')).n, 0);
  } finally { await admin.query('DROP TRIGGER reject_l1_update'); }
});

test('04:00 events and requests are excluded from yesterday and counted in the new day', async () => {
  const { runDayCut } = require('../src/jobs/day-cut');
  await admin.query("INSERT INTO signal_event (elder_id,type,ts,client_request_id) VALUES (1,'app_open','2026-11-04 03:59:59','before-cut'),(1,'app_open','2026-11-04 04:00:00','at-cut')");
  await admin.query("INSERT INTO service_order (elder_id,key_type,client_request_id,created_at) VALUES (1,'buy','before-cut-request','2026-11-04 03:59:59'),(1,'repair','at-cut-request','2026-11-04 04:00:00')");
  await runDayCut('2026-11-04 04:00:01');
  const rows = await db.query('SELECT stat_date, app_opens, request_count FROM signal_daily WHERE elder_id=1 ORDER BY stat_date');
  assert.deepEqual(rows, [
    { stat_date: '2026-11-03', app_opens: 1, request_count: 1 },
    { stat_date: '2026-11-04', app_opens: 1, request_count: 1 },
  ]);
  const rowsWithoutAudio = await db.query("SELECT payload FROM signal_event WHERE type='button_pressed'");
  for (const row of rowsWithoutAudio) {
    const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
    assert.equal(payload.hasAudio, false);
    assert.equal(payload.audioDuration, null);
  }
});

test('one event key cannot be reused for a different signal type', async () => {
  const { recordSignal } = require('../src/engine/l1');
  const key = randomUUID();
  await recordSignal({ elderId: 1, type: 'app_open', clientRequestId: key, at: '2026-11-04 10:00:00' });
  await assert.rejects(recordSignal({ elderId: 1, type: 'calendar_confirmed', clientRequestId: key, at: '2026-11-04 10:00:01' }), error => error.status === 409);
  const row = await db.queryOne('SELECT app_opens,calendar_confirmed FROM signal_daily WHERE elder_id=1');
  assert.deepEqual(row, { app_opens: 1, calendar_confirmed: 0 });
});

test('day-cut command reports success, and a database failure exits nonzero with a visible log', async () => {
  const command = path.join(__dirname, '../src/jobs/day-cut.js');
  const result = await execFile(process.execPath, [command], { env: { ...process.env }, timeout: 10000 });
  assert.match(result.stdout, /\[T1\] 切日完成/);
  await assert.rejects(
    execFile(process.execPath, [command], { env: { ...process.env, DB_NAME: database + '_missing' }, timeout: 10000 }),
    error => error.code === 1 && /\[T1\] 切日失败/.test(error.stderr)
  );
});

test('empty day-cut rows do not count as collected pages; confirming and retrying adds only one page', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-04T12:00:00+08:00').getTime() });
  const { runDayCut } = require('../src/jobs/day-cut');
  await runDayCut('2026-11-04 04:00:00');
  assert.equal((await request('GET', '/home')).body.data.calendar.totalPages, 0);
  const body = { clientRequestId: randomUUID() };
  assert.equal((await request('POST', '/calendar/confirm', body)).body.data.totalPages, 1);
  assert.equal((await request('POST', '/calendar/confirm', body)).body.data.totalPages, 1);
  assert.equal((await request('GET', '/home')).body.data.calendar.totalPages, 1);
});

test('collected pages and consecutive days are not truncated to the newest sixty daily rows', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-04T12:00:00+08:00').getTime() });
  for (let daysAgo = 1; daysAgo <= 64; daysAgo += 1) {
    await admin.execute("INSERT INTO signal_daily (elder_id,stat_date,calendar_confirmed) VALUES (1,DATE_SUB('2026-11-04', INTERVAL ? DAY),1)", [daysAgo]);
  }
  const calendar = (await request('GET', '/home')).body.data.calendar;
  assert.equal(calendar.totalPages, 64);
  assert.equal(calendar.streak, 64);
});

const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);
const mysql = require('mysql2/promise');

const database = `yinling_l2_test_${process.pid}_${Date.now().toString(36)}`;
Object.assign(process.env, {
  DB_HOST: '127.0.0.1', DB_PORT: process.env.L1_TEST_MYSQL_PORT || '13308',
  DB_USER: 'root', DB_PASSWORD: '', DB_NAME: database, JWT_SECRET: randomUUID(), NODE_ENV: 'test',
});
let admin, db, store, jobs, ownedDatabase = false;

function reload(modulePath) {
  try { delete require.cache[require.resolve(modulePath)]; return require(modulePath); }
  catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; return {}; }
}
function implemented() {
  assert.equal(typeof jobs.runBaseline, 'function', 'T3 baseline job is implemented');
  assert.equal(typeof store.readBaselineHistory, 'function');
}
async function seed14() {
  for (let i = 0; i < 14; i += 1) {
    const date = new Date(Date.UTC(2026, 9, 21 + i)).toISOString().slice(0, 10);
    await admin.execute('INSERT INTO signal_daily (elder_id,stat_date,calendar_confirmed,app_opens,request_count) VALUES (1,?,1,?,0)', [date, i + 1]);
  }
}

before(async () => {
  admin = await mysql.createConnection({
    host: '127.0.0.1', port: Number(process.env.DB_PORT), user: 'root', password: '',
    multipleStatements: true, dateStrings: true, timezone: '+08:00',
  });
  assert.match(database, /^yinling_l2_test_[a-z0-9_]+$/);
  await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
  ownedDatabase = true;
  await admin.changeUser({ database });
  const schema = fs.readFileSync(path.join(__dirname, '../../sql/schema.sql'), 'utf8');
  const tableStart = schema.indexOf('CREATE TABLE person');
  assert.ok(tableStart > 0);
  await admin.query(schema.slice(tableStart));
  for (let id = 1; id <= 5; id += 1) {
    await admin.execute("INSERT INTO person (id,phone,name,functions) VALUES (?,?,'L2 test',JSON_ARRAY('resident'))", [id, 'l2-test-' + id]);
    const status = id === 4 ? 'paused' : id === 5 ? 'removed' : 'active';
    await admin.execute("INSERT INTO elder (id,person_id,name,birth_year,addr,status,monitor_level) VALUES (?,?,'L2 test',1948,'Test address',?,?)", [id, id, status, id === 3 ? 'record_only' : 'monitor']);
  }
  db = require('../src/db');
});

beforeEach(async () => {
  await admin.query('DELETE FROM audit_log; DELETE FROM signal_event; DELETE FROM signal_daily; DELETE FROM param');
  await admin.query("UPDATE elder SET status='active',monitor_level='monitor' WHERE id IN (1,2)");
  await admin.query("INSERT INTO param (community_id,k,v) VALUES (1,'day_cut_hour','4'),(1,'baseline_days','14')");
  store = reload('../src/services/baseline');
  jobs = reload('../src/jobs/baseline');
});

after(async () => {
  if (db) await db.pool.end();
  if (admin) {
    try { if (ownedDatabase) await admin.query(`DROP DATABASE \`${database}\``); }
    finally { await admin.end(); }
  }
});

test('03:00 T3 reads only fourteen completed days and writes traceable ready/insufficient snapshots', async () => {
  implemented();
  await seed14();
  await admin.query("INSERT INTO signal_daily (elder_id,stat_date,calendar_confirmed,app_opens) VALUES (1,'2026-10-20',1,1000),(1,'2026-11-04',1,1000)");
  const beforeRows = await db.query('SELECT * FROM signal_daily ORDER BY id');
  const result = await jobs.runBaseline('2026-11-05 03:00:00');
  assert.deepEqual(result, { asOfDate: '2026-11-04', elders: 2, ready: 1, insufficient: 1 });
  const record = store.getCachedBaseline(1);
  assert.equal(record.snapshot.metrics.app_opens.median, 7.5);
  assert.equal(record.snapshot.metrics.app_opens.mad, 3.5);
  assert.equal(record.snapshot.window.startAt, '2026-10-21 04:00:00');
  assert.equal(record.snapshot.window.endAt, '2026-11-04 04:00:00');
  assert.equal(record.snapshot.sources.length, 14);
  assert.ok(record.snapshot.sources.every(row => Number.isSafeInteger(row.dailyId)));
  assert.equal(store.getCachedBaseline(2).snapshot.message, '信息不足');
  assert.equal(store.getCachedBaseline(3), null);
  assert.equal((await db.queryOne('SELECT COUNT(*) AS n FROM audit_log')).n, 2);
  const history = await store.readBaselineHistory(1, { asOfDate: '2026-11-04' });
  assert.deepEqual(history, [record]);
  assert.deepEqual(await db.query('SELECT * FROM signal_daily ORDER BY id'), beforeRows);
});

test('at 04:00 the completed day enters the next baseline window', async () => {
  implemented();
  await seed14();
  await admin.query("INSERT INTO signal_daily (elder_id,stat_date,calendar_confirmed,app_opens) VALUES (1,'2026-11-04',1,1000)");
  await jobs.runBaseline('2026-11-05 03:59:59');
  assert.equal(store.getCachedBaseline(1).snapshot.metrics.app_opens.median, 7.5);
  await jobs.runBaseline('2026-11-05 04:00:00');
  const record = store.getCachedBaseline(1);
  assert.equal(record.snapshot.asOfDate, '2026-11-05');
  assert.equal(record.snapshot.window.fromDate, '2026-10-22');
  assert.equal(record.snapshot.metrics.app_opens.median, 8.5);
  assert.equal((await store.readBaselineHistory(1)).length, 2);
});

test('recalculation appends an immutable historical snapshot rather than replacing its old inputs', async () => {
  implemented();
  await seed14();
  await jobs.runBaseline('2026-11-05 03:00:00');
  const original = store.getCachedBaseline(1);
  await admin.query("UPDATE signal_daily SET app_opens=100 WHERE elder_id=1 AND stat_date='2026-10-21'");
  await jobs.runBaseline('2026-11-05 03:01:00');
  const history = await store.readBaselineHistory(1, { asOfDate: '2026-11-04', limit: 10 });
  assert.equal(history.length, 2);
  assert.equal(history[0].snapshot.metrics.app_opens.median, 8.5);
  assert.equal(history[0].snapshot.sources[0].app_opens, 100);
  assert.deepEqual(history[1], original);
  assert.equal(history[1].snapshot.sources[0].app_opens, 1);
});

test('reloading the service clears process memory but audit history remains readable', async () => {
  implemented();
  await seed14();
  await jobs.runBaseline('2026-11-05 03:00:00');
  const original = store.getCachedBaseline(1);
  const fresh = reload('../src/services/baseline');
  assert.equal(fresh.getCachedBaseline(1), null);
  assert.deepEqual((await fresh.readBaselineHistory(1))[0], original);
});

test('a later elder audit failure rolls back the whole batch and preserves the previous cache', async () => {
  implemented();
  await seed14();
  await jobs.runBaseline('2026-11-05 03:00:00');
  const original = store.getCachedBaseline(1);
  await admin.query("UPDATE signal_daily SET app_opens=100 WHERE elder_id=1 AND stat_date='2026-10-21'");
  await admin.query("CREATE TRIGGER reject_l2_audit BEFORE INSERT ON audit_log FOR EACH ROW BEGIN IF NEW.target_id=2 THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='test baseline audit failure'; END IF; END");
  try {
    await assert.rejects(jobs.runBaseline('2026-11-05 03:01:00'), /test baseline audit failure/);
    assert.equal((await db.queryOne('SELECT COUNT(*) AS n FROM audit_log')).n, 2);
    assert.deepEqual(store.getCachedBaseline(1), original);
  } finally { await admin.query('DROP TRIGGER reject_l2_audit'); }
});

test('callers cannot mutate a cached baseline or its source records', async () => {
  implemented();
  await seed14();
  await jobs.runBaseline('2026-11-05 03:00:00');
  const original = store.getCachedBaseline(1);
  const copy = store.getCachedBaseline(1);
  copy.snapshot.metrics.app_opens.median = 999;
  copy.snapshot.sources[0].app_opens = 999;
  assert.deepEqual(store.getCachedBaseline(1), original);
});

test('fourteen empty daily rows stay insufficient; missing dates are not silently zero filled', async () => {
  implemented();
  await seed14();
  await admin.query('UPDATE signal_daily SET calendar_confirmed=0,app_opens=0');
  await jobs.runBaseline('2026-11-05 03:00:00');
  assert.equal(store.getCachedBaseline(1).snapshot.status, 'insufficient');
  await admin.query("UPDATE signal_daily SET calendar_confirmed=1 WHERE stat_date='2026-10-21'");
  await admin.query("DELETE FROM signal_daily WHERE stat_date='2026-10-27'");
  await jobs.runBaseline('2026-11-05 03:01:00');
  assert.deepEqual(store.getCachedBaseline(1).snapshot.missingDates, ['2026-10-27']);
});

test('a new successful batch drops cache entries for elders no longer monitored', async () => {
  implemented();
  await seed14();
  await jobs.runBaseline('2026-11-05 03:00:00');
  await admin.query("UPDATE elder SET monitor_level='record_only' WHERE id=1");
  await jobs.runBaseline('2026-11-05 03:01:00');
  assert.equal(store.getCachedBaseline(1), null);
  assert.equal((await store.readBaselineHistory(1)).length, 1);
});

test('invalid window or cut-hour configuration fails explicitly without publishing a baseline', async () => {
  implemented();
  await admin.query("UPDATE param SET v='7' WHERE k='baseline_days'");
  await assert.rejects(jobs.runBaseline('2026-11-05 03:00:00'), /14/);
  await admin.query("UPDATE param SET v='14' WHERE k='baseline_days'");
  await admin.query("UPDATE param SET v='24' WHERE k='day_cut_hour'");
  await assert.rejects(jobs.runBaseline('2026-11-05 03:00:00'), /day_cut_hour/);
  assert.equal((await db.queryOne('SELECT COUNT(*) AS n FROM audit_log')).n, 0);
  assert.equal(store.getCachedBaseline(1), null);
});

test('T3 command reports success and logs database failures with a nonzero exit', async () => {
  implemented();
  const command = path.join(__dirname, '../src/jobs/baseline.js');
  const success = await execFile(process.execPath, [command], { env: { ...process.env }, timeout: 10000 });
  assert.match(success.stdout, /\[T3\] 基线计算完成/);
  await assert.rejects(
    execFile(process.execPath, [command], { env: { ...process.env, DB_NAME: database + '_missing' }, timeout: 10000 }),
    error => error.code === 1 && /\[T3\] 基线计算失败/.test(error.stderr)
  );
});

test('blank cut-hour configuration fails without writing history or replacing cache; literal zero is valid', async () => {
  implemented();
  await seed14();
  await jobs.runBaseline('2026-11-05 03:00:00');
  const original = store.getCachedBaseline(1);
  for (const blank of ['', '   ']) {
    await admin.execute("UPDATE param SET v=? WHERE k='day_cut_hour'", [blank]);
    await assert.rejects(jobs.runBaseline('2026-11-05 03:01:00'), /day_cut_hour/);
    assert.equal((await db.queryOne('SELECT COUNT(*) AS n FROM audit_log')).n, 2);
    assert.deepEqual(store.getCachedBaseline(1), original);
  }
  await admin.query("UPDATE param SET v='0' WHERE k='day_cut_hour'");
  await jobs.runBaseline('2026-11-05 03:02:00');
  const record = store.getCachedBaseline(1);
  assert.equal(record.snapshot.window.cutHour, 0);
  assert.equal(record.snapshot.window.endAt, '2026-11-05 00:00:00');
});

test('a delayed older batch sees one database snapshot and cannot overwrite a newer cache or be replaced by backfill', async () => {
  implemented();
  await seed14();
  await admin.query('INSERT INTO signal_daily (elder_id,stat_date,calendar_confirmed,app_opens,request_count) SELECT 2,stat_date,calendar_confirmed,app_opens,request_count FROM signal_daily WHERE elder_id=1');
  await jobs.runBaseline('2026-11-05 03:00:00');
  const original = store.getCachedBaseline(1);
  await admin.query('UPDATE signal_daily SET app_opens=10');
  const lockName = database + '_barrier';
  await admin.execute('SELECT GET_LOCK(?,0)', [lockName]);
  await admin.query(`CREATE TRIGGER pause_l2_batch BEFORE INSERT ON audit_log FOR EACH ROW
    BEGIN IF NEW.target_id=1 AND NEW.ts='2026-11-05 03:01:00' THEN
      DO GET_LOCK('${lockName}',5); DO RELEASE_LOCK('${lockName}'); END IF; END`);
  let older;
  try {
    older = jobs.runBaseline('2026-11-05 03:01:00');
    let waiting = false;
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      const [rows] = await admin.execute("SELECT COUNT(*) AS n FROM information_schema.processlist WHERE db=? AND state='User lock'", [database]);
      if (rows[0].n > 0) { waiting = true; break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(waiting, true, 'older transaction is paused after reading its first elder');
    assert.deepEqual(store.getCachedBaseline(1), original, 'an uncommitted batch must stay unpublished');
    await admin.query('UPDATE signal_daily SET app_opens=20');
    await jobs.runBaseline('2026-11-05 03:02:00');
    assert.equal(store.getCachedBaseline(1).snapshot.metrics.app_opens.median, 20);
    await admin.execute('SELECT RELEASE_LOCK(?)', [lockName]);
    await older;
    const current = store.getCachedBaseline(1);
    assert.equal(current.snapshot.metrics.app_opens.median, 20);
    const elderTwoHistory = await store.readBaselineHistory(2);
    const olderSnapshot = elderTwoHistory.find(record => record.snapshot.calculatedAt === '2026-11-05 03:01:00');
    assert.equal(olderSnapshot.snapshot.metrics.app_opens.median, 10, 'second elder uses the same pre-update snapshot');
    await jobs.runBaseline('2026-11-04 03:00:00');
    assert.deepEqual(store.getCachedBaseline(1), current, 'historical backfill stays in history without replacing current cache');
    assert.equal((await store.readBaselineHistory(1, { asOfDate: '2026-11-03' })).length, 1);
  } finally {
    await admin.execute('SELECT RELEASE_LOCK(?)', [lockName]);
    if (older) await older.catch(() => {});
    await admin.query('DROP TRIGGER pause_l2_batch');
  }
});

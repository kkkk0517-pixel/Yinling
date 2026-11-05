/** T4 一致性读取、来源规范化和事务落库；不执行 L4 动作。 */
const { createHash } = require('crypto');
const { pool } = require('../db');
const { COMMUNITY_ID } = require('../utils/param');
const { now } = require('../utils/time');
const { signalDay, signalTime, dayRange } = require('../utils/signal-day');
const { BASELINE_DAYS, buildBaseline } = require('../engine/l2');
const { analyzeDay } = require('../engine/l3');
const parse = value => typeof value === 'string' ? JSON.parse(value) : value;
const shiftDate = (date, days) => new Date(new Date(date + 'T00:00:00Z').getTime() + days * 86400000).toISOString().slice(0, 10);

function normalizedEvent(row) {
  const payload = parse(row.payload) || {};
  const source = { table: 'signal_event', id: row.id };
  let value = 1;
  if (row.type === 'button_pressed') {
    if (payload.source === 'service_order' && payload.orderId) Object.assign(source, { table: 'service_order', id: payload.orderId });
    value = { keyType: payload.keyType ?? null, hasAudio: !!payload.hasAudio, audioDuration: payload.audioDuration ?? null };
  } else if (row.type === 'service_completed') {
    if (payload.source === 'service_order' && payload.orderId) Object.assign(source, { table: 'service_order', id: payload.orderId });
  } else if (row.type === 'family_confirmed') {
    if (!['ok_visited', 'ok_called'].includes(payload.result)) return null;
    if (payload.source === 'notification' && payload.notificationId) Object.assign(source, { table: 'notification', id: payload.notificationId });
    value = { orderId: payload.orderId ?? null, result: payload.result };
  }
  return { type: row.type, at: row.ts, source, value };
}

async function readEvidence(conn, elderId, endAt) {
  const [events] = await conn.execute(
    `SELECT id,type,payload,ts FROM (
       SELECT id,type,payload,ts,DENSE_RANK() OVER (PARTITION BY type ORDER BY ts DESC) AS rn
         FROM signal_event WHERE elder_id = ? AND ts < ?
          AND type IN ('calendar_confirmed','app_open','button_pressed','service_completed','family_confirmed')
     ) ranked WHERE rn = 1 ORDER BY type,id`, [elderId, endAt]
  );
  const evidence = events.map(normalizedEvent).filter(Boolean);
  // 业务事实可先于 T1 补采出现；使用相同的来源表/主键，避免投影生成重复输入。
  const [requests] = await conn.execute(
    `SELECT id,key_type,audio_file_id,audio_duration,created_at FROM service_order
      WHERE elder_id = ? AND created_at < ? ORDER BY created_at DESC,id DESC LIMIT 1`, [elderId, endAt]
  );
  if (requests.length) {
    const row = requests[0];
    evidence.push({ type: 'button_pressed', at: row.created_at, source: { table: 'service_order', id: row.id },
      value: { keyType: row.key_type, hasAudio: !!row.audio_file_id, audioDuration: row.audio_duration } });
  }
  const [services] = await conn.execute(
    'SELECT id,done_at FROM service_order WHERE elder_id = ? AND done_at < ? ORDER BY done_at DESC,id DESC LIMIT 1', [elderId, endAt]
  );
  if (services.length) evidence.push({ type: 'service_completed', at: services[0].done_at, source: { table: 'service_order', id: services[0].id }, value: 1 });
  const [confirmations] = await conn.execute(
    `SELECT n.id,n.order_id,n.ack_at,n.ack_result FROM notification n
       JOIN verify_order o ON n.order_type = 'verify' AND n.order_id = o.id
      WHERE o.elder_id = ? AND n.ack_at < ? AND n.ack_result IN ('ok_visited','ok_called')
      ORDER BY n.ack_at DESC,n.id DESC LIMIT 1`, [elderId, endAt]
  );
  if (confirmations.length) {
    const row = confirmations[0];
    evidence.push({ type: 'family_confirmed', at: row.ack_at, source: { table: 'notification', id: row.id }, value: { orderId: row.order_id, result: row.ack_result } });
  }
  return evidence;
}

function resultReference(record, auditId, duplicate) {
  const { elderId, status, message, cell, dScore, qScore, routeIntent, alertId } = record;
  return { elderId, status, message, cell, dScore, qScore, routeIntent, alertId, auditId, duplicate };
}

function decisionFingerprint(analysis) {
  const context = analysis.signalSnapshot[0].context;
  const dailyValues = row => row ? {
    stat_date: row.stat_date, calendar_confirmed: row.calendar_confirmed,
    app_opens: row.app_opens, request_count: row.request_count,
  } : null;
  const baseline = context.baseline;
  const basis = {
    version: context.version, elderId: context.elderId, targetDate: context.targetDate,
    referenceAt: context.referenceAt, policy: context.policy,
    baseline: {
      version: baseline.version, window: baseline.window, status: baseline.status,
      missingDates: baseline.missingDates, invalidDates: baseline.invalidDates,
      hasSignalHistory: baseline.hasSignalHistory, metrics: baseline.metrics,
      sources: baseline.sources.map(dailyValues),
    },
    current: dailyValues(context.current),
    signals: analysis.signalSnapshot.map(({ signal, source, at, value, weight, freshness }) => ({ signal, source, at, value, weight, freshness })),
  };
  // 行 ID 与携带的接触时间仍保存在完整快照；投影补写不改变相同决策的身份。
  return createHash('sha256').update(JSON.stringify(basis)).digest('hex');
}

async function scanStratification(at = now()) {
  const scannedAt = signalTime(at);
  const conn = await pool.getConnection();
  let targetDate;
  const results = [];
  let createdAlerts = 0;
  try {
    await conn.beginTransaction();
    // 主键记录锁先于一致性读取：等待前一批结束后，再建立本批数据快照。
    const [elders] = await conn.execute(
      "SELECT id FROM elder WHERE community_id = ? AND status = 'active' AND monitor_level = 'monitor' ORDER BY id FOR UPDATE", [COMMUNITY_ID]
    );
    const [params] = await conn.execute("SELECT k,v FROM param WHERE community_id = ? AND k IN ('day_cut_hour','baseline_days')", [COMMUNITY_ID]);
    const settings = Object.fromEntries(params.map(row => [row.k, row.v]));
    if (Number(settings.baseline_days ?? BASELINE_DAYS) !== BASELINE_DAYS) throw new RangeError('本版基线固定为 14 天');
    if (settings.day_cut_hour !== undefined && String(settings.day_cut_hour).trim() === '') throw new RangeError('day_cut_hour 不能为空');
    const cutHour = Number(settings.day_cut_hour ?? 4);
    targetDate = shiftDate(signalDay(scannedAt, cutHour), -1);
    const referenceAt = dayRange(targetDate, cutHour).end;
    const fromDate = shiftDate(targetDate, -BASELINE_DAYS);
    for (const elder of elders) {
      const [rows] = await conn.execute(
        `SELECT id,stat_date,calendar_confirmed,app_opens,request_count,last_open_at,last_service_at,last_confirm_at
           FROM signal_daily WHERE elder_id = ? AND stat_date >= ? AND stat_date <= ? ORDER BY stat_date`,
        [elder.id, fromDate, targetDate]
      );
      const current = rows.find(row => row.stat_date === targetDate) || null;
      const baseline = buildBaseline({ elderId: elder.id, asOfDate: targetDate, rows, calculatedAt: referenceAt, cutHour });
      const evidence = await readEvidence(conn, elder.id, referenceAt);
      const analysis = analyzeDay({ elderId: elder.id, targetDate, baseline, current, evidence, cutHour });
      const inputHash = decisionFingerprint(analysis);
      const [existing] = await conn.execute(
        `SELECT id,payload FROM audit_log WHERE action = 'l3_classified' AND target = 'elder' AND target_id = ?
          AND JSON_UNQUOTE(JSON_EXTRACT(payload,'$.inputHash')) = ? ORDER BY id DESC LIMIT 1 FOR UPDATE`, [elder.id, inputHash]
      );
      if (existing.length) {
        results.push(resultReference(parse(existing[0].payload), existing[0].id, true));
        continue;
      }
      analysis.signalSnapshot[0].context.inputHash = inputHash;
      let alertId = null;
      if (analysis.cell === 'strong' || analysis.cell === 'insufficient') {
        const [alert] = await conn.execute(
          'INSERT INTO alert (elder_id,d_score,q_score,cell,signal_snapshot,created_at) VALUES (?,?,?,?,?,?)',
          [elder.id, analysis.dScore, analysis.qScore, analysis.cell, JSON.stringify(analysis.signalSnapshot), scannedAt]
        );
        alertId = alert.insertId;
        createdAlerts += 1;
      }
      const record = { elderId: elder.id, targetDate, inputHash, ...analysis, alertId };
      const [audit] = await conn.execute(
        "INSERT INTO audit_log (actor_id,action,target,target_id,payload,ts) VALUES (NULL,'l3_classified','elder',?,?,?)",
        [elder.id, JSON.stringify(record), scannedAt]
      );
      results.push(resultReference(record, audit.insertId, false));
    }
    await conn.commit();
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
  return { targetDate, elders: results.length, createdAlerts, reused: results.filter(row => row.duplicate).length,
    informationInsufficient: results.filter(row => row.status === 'insufficient').length, results };
}

module.exports = { scanStratification };

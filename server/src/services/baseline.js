/** 基线事务与留档；只有整批提交后才发布当前进程缓存。 */
const { pool, query } = require('../db');
const { COMMUNITY_ID } = require('../utils/param');
const { now } = require('../utils/time');
const { signalDay, signalTime, dayRange } = require('../utils/signal-day');
const { BASELINE_DAYS, buildBaseline } = require('../engine/l2');

let cache = new Map();
let runSequence = 0;
let publishedSequence = 0;
let publishedDate = '';

async function calculateBaselines(at = now()) {
  const sequence = ++runSequence;
  const calculatedAt = signalTime(at);
  const conn = await pool.getConnection();
  let asOfDate;
  const records = [];
  try {
    await conn.beginTransaction();
    // 首次一致性读确定本批的参数、老人范围和数据快照。
    const [params] = await conn.execute(
      "SELECT k,v FROM param WHERE community_id = ? AND k IN ('baseline_days','day_cut_hour')", [COMMUNITY_ID]
    );
    const settings = Object.fromEntries(params.map(row => [row.k, row.v]));
    if (Number(settings.baseline_days ?? BASELINE_DAYS) !== BASELINE_DAYS) {
      throw new RangeError('本版基线固定使用 14 个完整统计日');
    }
    if (settings.day_cut_hour !== undefined && String(settings.day_cut_hour).trim() === '') {
      throw new RangeError('day_cut_hour 不能为空');
    }
    const cutHour = Number(settings.day_cut_hour ?? 4);
    asOfDate = signalDay(calculatedAt, cutHour);
    const fromDate = new Date(new Date(asOfDate + 'T00:00:00Z').getTime() - BASELINE_DAYS * 86400000).toISOString().slice(0, 10);
    const [elders] = await conn.execute(
      "SELECT id FROM elder WHERE community_id = ? AND status = 'active' AND monitor_level = 'monitor' ORDER BY id", [COMMUNITY_ID]
    );
    for (const elder of elders) {
      const [rows] = await conn.execute(
        `SELECT id,stat_date,calendar_confirmed,app_opens,request_count,last_open_at,last_service_at,last_confirm_at
           FROM signal_daily WHERE elder_id = ? AND stat_date >= ? AND stat_date < ? ORDER BY stat_date`,
        [elder.id, fromDate, asOfDate]
      );
      const snapshot = buildBaseline({ elderId: elder.id, asOfDate, rows, calculatedAt, cutHour });
      const [result] = await conn.execute(
        "INSERT INTO audit_log (actor_id,action,target,target_id,payload,ts) VALUES (NULL,'baseline_calculated','elder',?,?,?)",
        [elder.id, JSON.stringify(snapshot), calculatedAt]
      );
      records.push({ auditId: result.insertId, snapshot });
    }
    await conn.commit();
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
  // 较早发起但较晚完成的同日任务，或历史补算，不覆盖较新的已发布批次。
  if (asOfDate > publishedDate || (asOfDate === publishedDate && sequence > publishedSequence)) {
    cache = new Map(records.map(record => [String(record.snapshot.elderId), structuredClone(record)]));
    publishedDate = asOfDate;
    publishedSequence = sequence;
  }
  const ready = records.filter(record => record.snapshot.status === 'ready').length;
  return { asOfDate, elders: records.length, ready, insufficient: records.length - ready };
}

function getCachedBaseline(elderId) {
  const record = cache.get(String(elderId));
  return record ? structuredClone(record) : null;
}

async function readBaselineHistory(elderId, { asOfDate, limit = 30 } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new RangeError('历史查询条数必须为 1–100');
  if (asOfDate !== undefined) dayRange(asOfDate);
  const filter = asOfDate === undefined ? '' : " AND JSON_UNQUOTE(JSON_EXTRACT(payload, '$.asOfDate')) = ?";
  const params = asOfDate === undefined ? [elderId, limit] : [elderId, asOfDate, limit];
  const rows = await query(
    "SELECT id,payload FROM audit_log WHERE action = 'baseline_calculated' AND target = 'elder' AND target_id = ?"
      + filter + ' ORDER BY ts DESC,id DESC LIMIT ?', params
  );
  return rows.map(row => ({ auditId: row.id, snapshot: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload }));
}

module.exports = { calculateBaselines, getCachedBaseline, readBaselineHistory };

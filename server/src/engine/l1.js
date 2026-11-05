/** L1：唯一键事件采集与按日重算。实时写入和跑批锁定同一每日行。 */
const { pool, query } = require('../db');
const { getParam } = require('../utils/param');
const { now } = require('../utils/time');
const { signalDay, dayRange, signalTime } = require('../utils/signal-day');

const SIGNAL_TYPES = new Set(['app_open', 'calendar_confirmed', 'button_pressed', 'service_completed', 'family_confirmed']);

async function lockDaily(conn, elderId, date) {
  // INSERT 或重复键 UPDATE 均取得排他记录锁，持有到事务结束。
  await conn.execute(
    'INSERT INTO signal_daily (elder_id, stat_date) VALUES (?, ?) ON DUPLICATE KEY UPDATE id = signal_daily.id',
    [elderId, date]
  );
}

async function refreshDaily(conn, elderId, date, hour) {
  const { start, end } = dayRange(date, hour);
  const [rows] = await conn.execute(
    `SELECT COALESCE(MAX(CASE WHEN type = 'calendar_confirmed' AND ts >= ? THEN 1 ELSE 0 END), 0) AS confirmed,
            COUNT(CASE WHEN type = 'app_open' AND ts >= ? THEN 1 END) AS opens,
            COUNT(CASE WHEN type = 'button_pressed' AND ts >= ? THEN 1 END) AS requests,
            MAX(CASE WHEN type = 'app_open' AND ts >= ? THEN ts END) AS lastOpen,
            MAX(CASE WHEN type = 'service_completed' THEN ts END) AS lastService,
            MAX(CASE WHEN type = 'family_confirmed' THEN ts END) AS lastConfirm
       FROM signal_event
      WHERE elder_id = ? AND ts < ?
        AND (ts >= ? OR type IN ('service_completed', 'family_confirmed'))`,
    [start, start, start, start, elderId, end, start]
  );
  const row = rows[0];
  await conn.execute(
    `UPDATE signal_daily SET calendar_confirmed = ?, app_opens = ?, request_count = ?,
            last_open_at = ?, last_service_at = ?, last_confirm_at = ?
      WHERE elder_id = ? AND stat_date = ?`,
    [row.confirmed, row.opens, row.requests, row.lastOpen, row.lastService, row.lastConfirm, elderId, date]
  );
}

async function recordSignal({ elderId, type, clientRequestId, payload = {}, at = now() }) {
  if (!SIGNAL_TYPES.has(type) || !clientRequestId || typeof clientRequestId !== 'string' || clientRequestId.length > 64) {
    throw Object.assign(new Error('信号类型或请求标识不合法'), { status: 422 });
  }
  const hour = Number(await getParam('day_cut_hour', 4));
  const timestamp = signalTime(at);
  const date = signalDay(timestamp, hour);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await lockDaily(conn, elderId, date);
    const [insert] = await conn.execute(
      'INSERT INTO signal_event (elder_id, type, payload, client_request_id, ts) VALUES (?, ?, ?, ?, ?)',
      [elderId, type, JSON.stringify({ ...payload, date }), clientRequestId, timestamp]
    );
    await refreshDaily(conn, elderId, date, hour);
    await conn.commit();
    return { id: insert.insertId, at: timestamp, statDate: date };
  } catch (error) {
    await conn.rollback();
    if (error.code === 'ER_DUP_ENTRY') {
      const [events] = await conn.execute('SELECT id, elder_id, type, ts FROM signal_event WHERE client_request_id = ?', [clientRequestId]);
      const event = events[0];
      if (event && String(event.elder_id) === String(elderId) && event.type === type) {
        return { id: event.id, at: event.ts, statDate: signalDay(event.ts, hour) };
      }
      if (event) throw Object.assign(new Error('请求标识已用于其他信号'), { status: 409 });
    }
    throw error;
  } finally {
    conn.release();
  }
}

/** 从已有业务事实补采；来源前缀与主键构成唯一键，重跑保留原事件。 */
async function collectBusinessSignals(conn, elderId, start, end) {
  await conn.execute(
    `INSERT INTO signal_event (elder_id, type, payload, client_request_id, ts)
     SELECT s.elder_id, 'button_pressed',
            JSON_OBJECT('source', 'service_order', 'orderId', s.id, 'keyType', s.key_type,
                        'hasAudio', CAST(IF(s.audio_file_id IS NULL OR s.audio_file_id = '', 'false', 'true') AS JSON),
                        'audioDuration', s.audio_duration),
            CONCAT('l1:service-request:', s.id), s.created_at
       FROM service_order s WHERE s.elder_id = ? AND s.created_at >= ? AND s.created_at < ?
       ORDER BY s.id
     ON DUPLICATE KEY UPDATE id = signal_event.id`,
    [elderId, start, end]
  );
  // 历史接触也导入，保证新建当天行能带上最近一次服务/确认。
  await conn.execute(
    `INSERT INTO signal_event (elder_id, type, payload, client_request_id, ts)
     SELECT s.elder_id, 'service_completed', JSON_OBJECT('source', 'service_order', 'orderId', s.id),
            CONCAT('l1:service-completed:', s.id), s.done_at
       FROM service_order s WHERE s.elder_id = ? AND s.done_at < ? ORDER BY s.id
     ON DUPLICATE KEY UPDATE id = signal_event.id`,
    [elderId, end]
  );
  await conn.execute(
    `INSERT INTO signal_event (elder_id, type, payload, client_request_id, ts)
     SELECT o.elder_id, 'family_confirmed',
            JSON_OBJECT('source', 'notification', 'notificationId', n.id, 'orderId', o.id, 'result', n.ack_result),
            CONCAT('l1:notification-ack:', n.id), n.ack_at
       FROM notification n JOIN verify_order o ON n.order_type = 'verify' AND n.order_id = o.id
      WHERE o.elder_id = ? AND n.ack_at < ? AND n.ack_result IN ('ok_visited', 'ok_called')
      ORDER BY n.id
     ON DUPLICATE KEY UPDATE id = signal_event.id`,
    [elderId, end]
  );
}

async function aggregateDay(date) {
  const hour = Number(await getParam('day_cut_hour', 4));
  const { start, end } = dayRange(date, hour);
  const elders = await query("SELECT id FROM elder WHERE status = 'active' ORDER BY id");
  for (const elder of elders) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await lockDaily(conn, elder.id, date);
      await collectBusinessSignals(conn, elder.id, start, end);
      await refreshDaily(conn, elder.id, date, hour);
      await conn.commit();
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally {
      conn.release();
    }
  }
  return { statDate: date, elders: elders.length };
}

module.exports = { recordSignal, aggregateDay };

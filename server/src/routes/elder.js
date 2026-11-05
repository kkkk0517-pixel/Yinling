/**
 * 老人端 — E1 / E2 / E3 / E4 / E5 / E6 / E7
 * 见 docs/04-接口列表.md 第二节。
 *
 * 硬规则：
 *   - E5 的 promise 由服务端按 param 生成，前端写死就假了
 *   - 不带 audioFileId 也要能建单（按钮本身就是信息）
 *   - 30 秒内同 elderId + keyType 有未完成单 → 返回已有单
 */
const express = require('express');
const { randomUUID } = require('crypto');
const { query, queryOne, execute } = require('../db');
const { ok, fail } = require('../utils/response');
const { requireAuth, requireFunction } = require('../middleware/auth');
const { now, plusMin, formatDateTime, todayStart } = require('../utils/time');
const { getParam } = require('../utils/param');
const { recordSignal } = require('../engine/l1');
const { signalDay } = require('../utils/signal-day');
const { createEmergency } = require('../services/routing');

const router = express.Router();

router.use(requireAuth, requireFunction('resident'));

/** 取当前登录者对应的老人档案 */
async function myElder(personId) {
  return queryOne(
    `SELECT id, name, addr, mode, monitor_level AS monitorLevel
       FROM elder WHERE person_id = ? AND status = 'active'`,
    [personId]
  );
}

/** 按日期生成稳定的黄历文案（没有黄历表，用日期哈希保证同一天结果一致） */
const YI = ['宜静养', '宜散步', '宜访友', '宜晒被', '宜早睡', '宜煮粥', '宜听戏'];
const JI = ['忌久坐', '忌贪凉', '忌独行', '忌熬夜', '忌动气', '忌空腹', '忌登高'];
function almanac(dateStr) {
  let h = 0;
  for (const ch of dateStr) h = (h * 31 + ch.charCodeAt(0)) % 9973;
  return { yi: YI[h % YI.length], ji: JI[(h >> 3) % JI.length] };
}

/** 连续确认天数（从今天往前数） */
function streakOf(rows, today) {
  const confirmed = new Set(rows.filter(r => r.confirmed).map(r => String(r.statDate).slice(0, 10)));
  const previous = date => new Date(new Date(date + 'T00:00:00Z').getTime() - 86400000).toISOString().slice(0, 10);
  let date = confirmed.has(today) ? today : previous(today);
  let n = 0;
  while (confirmed.has(date)) {
    n += 1;
    date = previous(date);
  }
  return n;
}

// ---------------- E1 GET /elder/home ----------------
router.get('/home', async (req, res, next) => {
  try {
    const elder = await myElder(req.user.personId);
    if (!elder) return fail(res, 404, '未找到您的档案，请联系社区');

    const signal = await recordSignal({ elderId: elder.id, type: 'app_open', clientRequestId: randomUUID() });
    const daily = await query(
      `SELECT stat_date AS statDate, calendar_confirmed AS confirmed
         FROM signal_daily WHERE elder_id = ? AND stat_date <= ? AND calendar_confirmed = 1 ORDER BY stat_date DESC`,
      [elder.id, signal.statDate]
    );
    const today = daily.find((d) => String(d.statDate).slice(0, 10) === signal.statDate);
    const todayConfirmed = !!(today && today.confirmed);
    const { yi, ji } = almanac(signal.statDate);

    const lastService = await queryOne(
      `SELECT done_at AS at, content_text AS content
         FROM service_order
        WHERE elder_id = ? AND status = 'done' AND done_at IS NOT NULL
        ORDER BY done_at DESC LIMIT 1`,
      [elder.id]
    );

    const pending = await queryOne(
      `SELECT id, content_text AS title, created_at AS createdAt
         FROM service_order
        WHERE elder_id = ? AND status IN ('pending','assigned','accepted','doing')
        ORDER BY created_at DESC LIMIT 1`,
      [elder.id]
    );

    const waitMin = Number(await getParam('service_pool_wait_min', 10));

    return ok(res, {
      todayConfirmed,
      calendar: { yi, ji, totalPages: daily.length, streak: streakOf(daily, signal.statDate) },
      recentVisit: lastService
        ? { at: formatDateTime(lastService.at), note: lastService.content || '社区来做过服务' }
        : null,
      pendingRequest: pending
        ? { id: pending.id, title: pending.title || '服务请求', createdAt: formatDateTime(pending.createdAt) }
        : null,
      promise: `一般 ${waitMin} 分钟内有人联系您`,
    });
  } catch (e) {
    return next(e);
  }
});

// ---------------- E2 POST /elder/calendar/confirm ----------------
router.post('/calendar/confirm', async (req, res, next) => {
  try {
    const elder = await myElder(req.user.personId);
    if (!elder) return fail(res, 404, '未找到您的档案');

    const clientRequestId = String(req.body.clientRequestId || '').trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(clientRequestId)) {
      return fail(res, 422, 'clientRequestId 必须为 UUID v4');
    }

    const signal = await recordSignal({ elderId: elder.id, type: 'calendar_confirmed', clientRequestId });
    const today = signalDay(now(), Number(await getParam('day_cut_hour', 4)));

    const daily = await query(
      `SELECT stat_date AS statDate, calendar_confirmed AS confirmed FROM signal_daily
        WHERE elder_id = ? AND stat_date <= ? AND calendar_confirmed = 1 ORDER BY stat_date DESC`,
      [elder.id, today]
    );

    return ok(res, {
      confirmedAt: signal.at,
      totalPages: daily.length,
      streak: streakOf(daily, today),
    });
  } catch (e) {
    return next(e);
  }
});

// ---------------- E3 GET /elder/calendar ----------------
router.get('/calendar', async (req, res, next) => {
  try {
    const elder = await myElder(req.user.personId);
    if (!elder) return fail(res, 404, '未找到您的档案');

    const days = Math.min(Number(req.query.days || 30), 90);
    const rows = await query(
      `SELECT stat_date AS statDate, calendar_confirmed AS confirmed, request_count AS requestCount
         FROM signal_daily WHERE elder_id = ? ORDER BY stat_date DESC LIMIT ?`,
      [elder.id, days]
    );

    const pages = rows.map((r) => {
      const date = String(r.statDate).slice(0, 10);
      const { yi, ji } = almanac(date);
      return { date, yi, ji, hasRequest: Number(r.requestCount) > 0, confirmed: !!r.confirmed };
    });

    return ok(res, { month: req.query.month || todayStart().slice(0, 7), pages });
  } catch (e) {
    return next(e);
  }
});

// ---------------- E4 POST /elder/audio ----------------
// 真实文件上传归 #13（A 负责的录音链路）。这里只登记元数据，返回 fileId。
router.post('/audio', async (req, res, next) => {
  try {
    const duration = Number(req.body.duration || 0);
    const fileId = req.body.fileId || `local://pending/${Date.now()}.webm`;
    return ok(res, { fileId, duration });
  } catch (e) {
    return next(e);
  }
});

// ---------------- E5 POST /elder/requests ----------------
router.post('/requests', async (req, res, next) => {
  try {
    const elder = await myElder(req.user.personId);
    if (!elder) return fail(res, 404, '未找到您的档案');

    const keyType = String(req.body.keyType || '');
    const allowed = ['buy', 'unwell', 'repair', 'medical'];
    if (!allowed.includes(keyType)) return fail(res, 422, 'keyType 取值不合法');

    const clientRequestId = String(req.body.clientRequestId || '').trim();
    if (!clientRequestId) return fail(res, 422, 'clientRequestId 必填');

    // content_text 是 VARCHAR(500)，超长直接拒绝，别让 MySQL 抛 500
    const contentText = req.body.contentText ? String(req.body.contentText) : null;
    if (contentText && contentText.length > 500) return fail(res, 422, '内容不能超过 500 字');

    // 幂等：同一 clientRequestId 直接返回已有单
    const dup = await queryOne(
      'SELECT id, created_at AS createdAt FROM service_order WHERE client_request_id = ?',
      [clientRequestId]
    );
    if (dup) {
      return ok(res, {
        orderId: dup.id,
        promise: await promiseText(),
        canCancelUntil: plusMin(0.17),
        duplicated: true,
      });
    }

    // 30 秒内同类未完成单 → 返回已有单，不新建
    const mergeWindow = Number(await getParam('merge_window_sec', 30));
    const recent = await queryOne(
      `SELECT id FROM service_order
        WHERE elder_id = ? AND key_type = ?
          AND status IN ('pending','assigned','accepted','doing')
          AND created_at >= DATE_SUB(NOW(), INTERVAL ? SECOND)
        ORDER BY created_at DESC LIMIT 1`,
      [elder.id, keyType, mergeWindow]
    );
    if (recent) {
      return ok(res, {
        orderId: recent.id,
        promise: await promiseText(),
        canCancelUntil: plusMin(0.17),
        merged: true,
      });
    }

    const result = await execute(
      `INSERT INTO service_order
         (elder_id, key_type, audio_file_id, audio_duration, content_text, status, addr, client_request_id)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
      [
        elder.id,
        keyType,
        req.body.audioFileId || null,
        Number(req.body.duration || 0) || null,
        contentText,
        elder.addr,
        clientRequestId,
      ]
    );

    await execute(
      'INSERT INTO order_event (order_type, order_id, actor_id, action, payload) VALUES (?, ?, ?, ?, ?)',
      ['service', result.insertId, req.user.personId, 'create', JSON.stringify({ keyType })]
    );

    return ok(res, {
      orderId: result.insertId,
      promise: await promiseText(),
      canCancelUntil: plusMin(0.17),
    });
  } catch (e) {
    return next(e);
  }
});

/** 按 param 生成对老人的承诺话术 */
async function promiseText() {
  const wait = Number(await getParam('service_pool_wait_min', 10));
  return `一般 ${wait} 分钟内有人联系您`;
}

// ---------------- E6 POST /elder/emergency ----------------
router.post('/emergency', async (req, res, next) => {
  try { return ok(res, await createEmergency(req.user.personId, req.body.clientRequestId)); }
  catch (error) { return next(error); }
});

// ---------------- E7 POST /elder/requests/:id/cancel ----------------
router.post('/requests/:id/cancel', async (req, res, next) => {
  try {
    const elder = await myElder(req.user.personId);
    if (!elder) return fail(res, 404, '未找到您的档案');

    const order = await queryOne(
      `SELECT id, elder_id AS elderId, status, created_at AS createdAt
         FROM service_order WHERE id = ?`,
      [Number(req.params.id)]
    );
    if (!order) return fail(res, 404, '服务单不存在');
    if (order.elderId !== elder.id) return fail(res, 403, '无权操作他人的单');
    if (!['pending', 'assigned'].includes(order.status)) {
      return fail(res, 409, '已被接单，无法撤回');
    }

    const elapsed = (Date.now() - new Date(order.createdAt).getTime()) / 1000;
    if (elapsed > 10) return fail(res, 409, '超过 10 秒，无法撤回');

    await execute('UPDATE service_order SET status = ? WHERE id = ?', ['cancelled', order.id]);
    await execute(
      'INSERT INTO order_event (order_type, order_id, actor_id, action) VALUES (?, ?, ?, ?)',
      ['service', order.id, req.user.personId, 'cancel']
    );

    // 音频不删，只撤单
    return ok(res, { ok: true });
  } catch (e) {
    return next(e);
  }
});

module.exports = router;

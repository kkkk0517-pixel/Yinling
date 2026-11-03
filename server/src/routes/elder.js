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
const { query, queryOne, execute } = require('../db');
const { ok, fail } = require('../utils/response');
const { requireAuth, requireFunction } = require('../middleware/auth');
const { now, plusMin, formatDateTime, todayStart } = require('../utils/time');
const { getParam } = require('../utils/param');

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
function streakOf(rows) {
  let n = 0;
  for (const r of rows) {
    if (r.calendar_confirmed) n += 1;
    else if (n === 0) continue; // 今天还没确认时，从昨天开始算
    else break;
  }
  return n;
}

// ---------------- E1 GET /elder/home ----------------
router.get('/home', async (req, res, next) => {
  try {
    const elder = await myElder(req.user.personId);
    if (!elder) return fail(res, 404, '未找到您的档案，请联系社区');

    const daily = await query(
      `SELECT stat_date AS statDate, calendar_confirmed AS confirmed
         FROM signal_daily WHERE elder_id = ? ORDER BY stat_date DESC LIMIT 60`,
      [elder.id]
    );
    const today = daily.find((d) => String(d.statDate).slice(0, 10) === todayStart().slice(0, 10));
    const todayConfirmed = !!(today && today.confirmed);
    const { yi, ji } = almanac(todayStart().slice(0, 10));

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
      calendar: { yi, ji, totalPages: daily.length || 1, streak: streakOf(daily) },
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
    const today = todayStart().slice(0, 10);

    // 埋点：强信号 calendar_confirmed
    if (clientRequestId) {
      const dup = await queryOne('SELECT id FROM signal_event WHERE client_request_id = ?', [clientRequestId]);
      if (!dup) {
        await execute(
          'INSERT INTO signal_event (elder_id, type, payload, client_request_id) VALUES (?, ?, ?, ?)',
          [elder.id, 'calendar_confirmed', JSON.stringify({ date: today }), clientRequestId]
        );
      }
    }

    // 聚合到当天
    await execute(
      `INSERT INTO signal_daily (elder_id, stat_date, calendar_confirmed, app_opens, last_confirm_at)
       VALUES (?, ?, 1, 1, NOW())
       ON DUPLICATE KEY UPDATE calendar_confirmed = 1, app_opens = app_opens + 1, last_confirm_at = NOW()`,
      [elder.id, today]
    );

    const daily = await query(
      `SELECT calendar_confirmed AS confirmed FROM signal_daily
        WHERE elder_id = ? ORDER BY stat_date DESC LIMIT 60`,
      [elder.id]
    );

    return ok(res, {
      confirmedAt: now(),
      totalPages: daily.length || 1,
      streak: streakOf(daily),
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
        req.body.contentText || null,
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
  try {
    const elder = await myElder(req.user.personId);
    if (!elder) return fail(res, 404, '未找到您的档案');

    const clientRequestId = String(req.body.clientRequestId || '').trim();
    if (!clientRequestId) return fail(res, 422, 'clientRequestId 必填');

    const dup = await queryOne(
      'SELECT id FROM verify_order WHERE client_request_id = ?',
      [clientRequestId]
    );
    if (dup) {
      return ok(res, { orderId: dup.id, promise: '已通知所有联系人，请稍等', duplicated: true });
    }

    // 紧急单：跳过 L3/L4，直接全链广播
    const result = await execute(
      `INSERT INTO verify_order (elder_id, source, current_layer, status, route_mode, sla_deadline, client_request_id)
       VALUES (?, 'emergency', 1, 'notified', 'relation', DATE_ADD(NOW(), INTERVAL 5 MINUTE), ?)`,
      [elder.id, clientRequestId]
    );

    const orderId = result.insertId;

    // 通知全部关系人（不分层）
    const relations = await query(
      'SELECT id, person_id AS personId, is_accountable AS isAccountable FROM relation WHERE elder_id = ? AND status = 1',
      [elder.id]
    );
    for (const r of relations) {
      await execute(
        `INSERT INTO notification (order_type, order_id, relation_id, person_id, is_accountable)
         VALUES ('verify', ?, ?, ?, ?)`,
        [orderId, r.id, r.personId, r.isAccountable]
      );
    }

    await execute(
      'INSERT INTO order_event (order_type, order_id, actor_id, action, payload) VALUES (?, ?, ?, ?, ?)',
      ['verify', orderId, req.user.personId, 'broadcast', JSON.stringify({ count: relations.length })]
    );

    return ok(res, { orderId, promise: '已通知所有联系人，请稍等' });
  } catch (e) {
    return next(e);
  }
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

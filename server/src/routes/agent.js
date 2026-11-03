/**
 * 处置端 — H1 / H2 / H3 / H4 / H5 / H6 / H7 / H8 / H9 / H10
 * 见 docs/04-接口列表.md 第四节。
 *
 * 硬规则：
 *   - H3 必须先调再调 H4。耗时由服务端从第一条 action 事件算，前端不能传
 *   - H4 的 duration_min 和 is_invalid_check 由服务端算，让前端传指标就能被刷
 */
const express = require('express');
const { query, queryOne, execute } = require('../db');
const { ok, fail } = require('../utils/response');
const { requireAuth, requireFunction } = require('../middleware/auth');
const { formatDateTime, diffMinutes, secondsUntil } = require('../utils/time');

const router = express.Router();

router.use(requireAuth, requireFunction('agent'));

function parseJson(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  }
  return value;
}

// ---------------- H1 GET /agent/workbench ----------------
router.get('/workbench', async (req, res, next) => {
  try {
    const mine = await query(
      `SELECT vo.id, vo.elder_id AS elderId, e.name AS elderName, e.addr,
              vo.source, vo.current_layer AS currentLayer, vo.status,
              vo.sla_deadline AS slaDeadline, vo.created_at AS createdAt
         FROM verify_order vo JOIN elder e ON e.id = vo.elder_id
        WHERE vo.status <> 'closed'
        ORDER BY vo.created_at DESC`,
      []
    );

    const pool = await query(
      `SELECT so.id, so.elder_id AS elderId, e.name AS elderName, e.addr,
              so.key_type AS keyType, so.content_text AS content, so.status, so.created_at AS createdAt
         FROM service_order so JOIN elder e ON e.id = so.elder_id
        WHERE so.status IN ('pending','assigned')
        ORDER BY so.created_at DESC`,
      []
    );

    const elders = await query(
      `SELECT id, name, addr, monitor_level AS monitorLevel FROM elder
        WHERE status = 'active' AND monitor_level = 'monitor' ORDER BY id`,
      []
    );

    const overdue = mine.filter((o) => o.slaDeadline && new Date(o.slaDeadline).getTime() < Date.now());

    return ok(res, {
      mine: mine.map((o) => ({
        ...o,
        slaLeftSec: o.slaDeadline ? secondsUntil(o.slaDeadline) : null,
        createdAt: formatDateTime(o.createdAt),
      })),
      pool: pool.map((o) => ({ ...o, createdAt: formatDateTime(o.createdAt) })),
      elders,
      overdueCount: overdue.length,
    });
  } catch (e) {
    return next(e);
  }
});

// ---------------- H2 GET /agent/verify-orders/:id ----------------
router.get('/verify-orders/:id', async (req, res, next) => {
  try {
    const order = await queryOne(
      `SELECT id, elder_id AS elderId, alert_id AS alertId, source, current_layer AS currentLayer,
              status, sla_deadline AS slaDeadline, created_at AS createdAt
         FROM verify_order WHERE id = ?`,
      [Number(req.params.id)]
    );
    if (!order) return fail(res, 404, '核验单不存在');

    const elder = await queryOne(
      'SELECT id, name, birth_year AS birthYear, addr, monitor_level AS monitorLevel FROM elder WHERE id = ?',
      [order.elderId]
    );

    const alert = await queryOne(
      'SELECT d_score AS d, q_score AS q, cell, signal_snapshot AS snapshot, created_at AS createdAt FROM alert WHERE elder_id = ? ORDER BY created_at DESC LIMIT 1',
      [order.elderId]
    );
    const signals = parseJson(alert && alert.snapshot, []);

    const notifyLog = await query(
      `SELECT n.id, n.person_id AS personId, p.name AS toName, n.is_accountable AS isAccountable,
              n.sent_at AS sentAt, n.read_at AS readAt, n.ack_at AS ackAt, n.ack_result AS ackResult
         FROM notification n JOIN person p ON p.id = n.person_id
        WHERE n.order_type = 'verify' AND n.order_id = ?
        ORDER BY n.sent_at`,
      [order.id]
    );

    const actions = await query(
      `SELECT action, ts, actor_id AS actorId FROM order_event
        WHERE order_type = 'verify' AND order_id = ? ORDER BY ts`,
      [order.id]
    );

    return ok(res, {
      id: order.id,
      elder,
      alert: alert
        ? { d: Number(alert.d), q: Number(alert.q), cell: alert.cell, createdAt: formatDateTime(alert.createdAt) }
        : null,
      signals,
      notifyLog: notifyLog.map((n) => ({
        ...n,
        isAccountable: !!n.isAccountable,
        sentAt: formatDateTime(n.sentAt),
        readAt: n.readAt ? formatDateTime(n.readAt) : null,
        ackAt: n.ackAt ? formatDateTime(n.ackAt) : null,
      })),
      slaLeft: order.slaDeadline ? secondsUntil(order.slaDeadline) : null,
      currentLayer: order.currentLayer,
      status: order.status,
      actions: [
        { key: 'call', label: '打电话' },
        { key: 'visit', label: '去家里' },
        { key: 'escalate', label: '转上级' },
      ],
      events: actions.map((a) => ({ ...a, ts: formatDateTime(a.ts) })),
    });
  } catch (e) {
    return next(e);
  }
});

// ---------------- H3 POST /agent/verify-orders/:id/action ----------------
router.post('/verify-orders/:id/action', async (req, res, next) => {
  try {
    const order = await queryOne('SELECT id FROM verify_order WHERE id = ?', [Number(req.params.id)]);
    if (!order) return fail(res, 404, '核验单不存在');

    const action = String(req.body.action || '');
    const allowed = ['call', 'visit', 'escalate'];
    if (!allowed.includes(action)) return fail(res, 422, 'action 取值不合法');

    await execute(
      'INSERT INTO order_event (order_type, order_id, actor_id, action) VALUES (?, ?, ?, ?)',
      ['verify', order.id, req.user.personId, action]
    );

    return ok(res, { ok: true, methodAutoFilled: action === 'visit' ? 'visit' : 'phone' });
  } catch (e) {
    return next(e);
  }
});

// ---------------- H4 POST /agent/verify-orders/:id/disposition ----------------
router.post('/verify-orders/:id/disposition', async (req, res, next) => {
  try {
    const order = await queryOne(
      'SELECT id, elder_id AS elderId, status, created_at AS createdAt FROM verify_order WHERE id = ?',
      [Number(req.params.id)]
    );
    if (!order) return fail(res, 404, '核验单不存在');

    // 一单只能有一条结论
    const existing = await queryOne('SELECT id FROM disposition WHERE order_id = ?', [order.id]);
    if (existing) return ok(res, { ok: true, orderId: order.id, duplicated: true });

    const resultCode = String(req.body.resultCode || '');
    const method = String(req.body.method || '');
    const validResult = ['normal', 'abnormal_handled', 'unreachable_escalated', 'declined', 'phone_confirmed_not_visited'];
    const validMethod = ['phone', 'visit'];
    if (!validResult.includes(resultCode)) return fail(res, 422, 'resultCode 取值不合法');
    if (!validMethod.includes(method)) return fail(res, 422, 'method 取值不合法');

    // 耗时：第一条 action 事件到现在的分钟差；没有 action 就用建单时间
    const firstAction = await queryOne(
      `SELECT ts FROM order_event WHERE order_type = 'verify' AND order_id = ?
        AND action IN ('call','visit','escalate') ORDER BY ts LIMIT 1`,
      [order.id]
    );
    const from = firstAction ? firstAction.ts : order.createdAt;
    const durationMin = diffMinutes(from);

    // 主指标口径：normal / declined 记为无效核查
    const isInvalid = ['normal', 'declined'].includes(resultCode) ? 1 : 0;

    await execute(
      `INSERT INTO disposition (order_id, result_code, method, duration_min, note, is_invalid_check, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [order.id, resultCode, method, durationMin, req.body.note || null, isInvalid, req.user.personId]
    );

    await execute(
      `UPDATE verify_order SET status = 'closed', closed_at = NOW(), sla_deadline = NULL WHERE id = ?`,
      [order.id]
    );

    await execute(
      'INSERT INTO order_event (order_type, order_id, actor_id, action, payload) VALUES (?, ?, ?, ?, ?)',
      ['verify', order.id, req.user.personId, 'dispose', JSON.stringify({ resultCode, method, durationMin, isInvalid })]
    );

    return ok(res, { ok: true, orderId: order.id });
  } catch (e) {
    return next(e);
  }
});

// ---------------- H5 POST /agent/verify-orders/:id/transfer ----------------
router.post('/verify-orders/:id/transfer', async (req, res, next) => {
  try {
    const order = await queryOne('SELECT id FROM verify_order WHERE id = ?', [Number(req.params.id)]);
    if (!order) return fail(res, 404, '核验单不存在');

    const toPersonId = Number(req.body.toPersonId);
    const reason = String(req.body.reason || '').trim();
    if (!toPersonId) return fail(res, 422, 'toPersonId 必填');
    if (!reason) return fail(res, 422, '转单必须填原因');

    await execute('UPDATE verify_order SET assignee_id = ? WHERE id = ?', [toPersonId, order.id]);
    await execute(
      'INSERT INTO order_event (order_type, order_id, actor_id, action, payload) VALUES (?, ?, ?, ?, ?)',
      ['verify', order.id, req.user.personId, 'transfer', JSON.stringify({ toPersonId, reason })]
    );

    return ok(res, { ok: true });
  } catch (e) {
    return next(e);
  }
});

// ---------------- H6 GET /agent/service-orders ----------------
router.get('/service-orders', async (req, res, next) => {
  try {
    const list = await query(
      `SELECT so.id, so.elder_id AS elderId, e.name AS elderName, e.addr,
              so.key_type AS keyType, so.sub_type AS subType, so.content_text AS content,
              so.status, so.amount, so.created_at AS createdAt
         FROM service_order so JOIN elder e ON e.id = so.elder_id
        WHERE so.status IN ('pending','assigned','accepted','doing')
        ORDER BY so.created_at ASC`,
      []
    );

    return ok(res, {
      list: list.map((o) => ({ ...o, amount: o.amount === null ? null : Number(o.amount), createdAt: formatDateTime(o.createdAt) })),
      sortedBy: req.query.lat ? 'distance' : 'createdAt',
    });
  } catch (e) {
    return next(e);
  }
});

// ---------------- H7 POST /agent/service-orders/:id/accept ----------------
router.post('/service-orders/:id/accept', async (req, res, next) => {
  try {
    const order = await queryOne('SELECT id, status FROM service_order WHERE id = ?', [Number(req.params.id)]);
    if (!order) return fail(res, 404, '服务单不存在');
    if (!['pending', 'assigned'].includes(order.status)) return fail(res, 409, '该单已被接走');

    await execute(
      `UPDATE service_order SET status = 'accepted', assignee_id = ?, assignee_role = 'agent', accepted_at = NOW()
        WHERE id = ? AND status IN ('pending','assigned')`,
      [req.user.personId, order.id]
    );
    await execute(
      'INSERT INTO order_event (order_type, order_id, actor_id, action) VALUES (?, ?, ?, ?)',
      ['service', order.id, req.user.personId, 'accept']
    );

    return ok(res, { ok: true });
  } catch (e) {
    return next(e);
  }
});

// ---------------- H8 POST /agent/service-orders/:id/start ----------------
router.post('/service-orders/:id/start', async (req, res, next) => {
  try {
    const order = await queryOne('SELECT id, status FROM service_order WHERE id = ?', [Number(req.params.id)]);
    if (!order) return fail(res, 404, '服务单不存在');
    if (order.status !== 'accepted') return fail(res, 409, '需先接单才能出发');

    await execute(`UPDATE service_order SET status = 'doing' WHERE id = ?`, [order.id]);
    await execute(
      'INSERT INTO order_event (order_type, order_id, actor_id, action) VALUES (?, ?, ?, ?)',
      ['service', order.id, req.user.personId, 'start']
    );

    return ok(res, { ok: true, startedAt: formatDateTime(new Date()) });
  } catch (e) {
    return next(e);
  }
});

// ---------------- H9 POST /agent/service-orders/:id/complete ----------------
router.post('/service-orders/:id/complete', async (req, res, next) => {
  try {
    const order = await queryOne(
      'SELECT id, elder_id AS elderId, status FROM service_order WHERE id = ?',
      [Number(req.params.id)]
    );
    if (!order) return fail(res, 404, '服务单不存在');
    if (!['accepted', 'doing'].includes(order.status)) return fail(res, 409, '当前状态不能完成');

    const amount = req.body.amount === undefined || req.body.amount === null ? null : Number(req.body.amount);
    if (amount !== null && (Number.isNaN(amount) || amount < 0)) return fail(res, 422, 'amount 不合法');

    await execute(
      `UPDATE service_order SET status = 'done', done_at = NOW(), amount = ? WHERE id = ?`,
      [amount, order.id]
    );
    await execute(
      'INSERT INTO order_event (order_type, order_id, actor_id, action, payload) VALUES (?, ?, ?, ?, ?)',
      ['service', order.id, req.user.personId, 'complete', JSON.stringify({ amount, content: req.body.content || null })]
    );

    let billId = null;
    if (amount !== null && amount > 0) {
      // 付款人默认取该老人的主责关系人
      const payer = await queryOne(
        'SELECT person_id AS personId FROM relation WHERE elder_id = ? AND is_accountable = 1 LIMIT 1',
        [order.elderId]
      );
      const exist = await queryOne('SELECT id FROM bill WHERE service_order_id = ?', [order.id]);
      if (exist) {
        billId = exist.id;
      } else {
        const r = await execute(
          `INSERT INTO bill (service_order_id, elder_id, payer_person_id, amount, status)
           VALUES (?, ?, ?, ?, 'pending')`,
          [order.id, order.elderId, payer ? payer.personId : null, amount]
        );
        billId = r.insertId;
      }
    }

    return ok(res, { ok: true, billId });
  } catch (e) {
    return next(e);
  }
});

// ---------------- H10 GET /agent/elders/:id ----------------
router.get('/elders/:id', async (req, res, next) => {
  try {
    const elderId = Number(req.params.id);
    const elder = await queryOne(
      'SELECT id, name, birth_year AS birthYear, addr, mode, monitor_level AS monitorLevel, status FROM elder WHERE id = ?',
      [elderId]
    );
    if (!elder) return fail(res, 404, '老人档案不存在');

    const chain = await query(
      `SELECT r.id, r.level, r.role_label AS roleLabel, r.is_accountable AS isAccountable,
              p.id AS personId, p.name
         FROM relation r JOIN person p ON p.id = r.person_id
        WHERE r.elder_id = ? AND r.status = 1
        ORDER BY r.level, r.priority`,
      [elderId]
    );

    const history = await query(
      `SELECT order_type AS type, id, status, created_at AS createdAt FROM v_order_all
        WHERE elder_id = ? ORDER BY created_at DESC LIMIT 20`,
      [elderId]
    );

    return ok(res, {
      elder,
      chain: chain.map((c) => ({ ...c, isAccountable: !!c.isAccountable })),
      history: history.map((h) => ({ ...h, createdAt: formatDateTime(h.createdAt) })),
    });
  } catch (e) {
    return next(e);
  }
});

module.exports = router;

/**
 * 关系人端 — R1 / R2 / R3 / R4 / R5 / R6 / R7 / R8 / R9
 * 见 docs/04-接口列表.md 第三节。
 *
 * 最关键的实现是 R3：**只有主责回执才停计时**（清 sla_deadline）。
 * 知会人点了不算，别写漏。
 */
const express = require('express');
const { pool, query, queryOne, execute } = require('../db');
const { ok, fail } = require('../utils/response');
const { requireAuth, requireFunction } = require('../middleware/auth');
const { now, formatDateTime, diffMinutes, secondsUntil } = require('../utils/time');
const { ackNotification } = require('../services/verification');
const { listEvidenceRequests, ackEvidence, requireRelation } = require('../services/evidence-requests');

const router = express.Router();

router.use(requireAuth, requireFunction('relation', 'service'));

/** 我能看到的老人（在关系链里挂着的） */
async function myElders(personId) {
  return query(
    `SELECT DISTINCT e.id, e.name, e.addr, e.monitor_level AS monitorLevel
       FROM elder e
       JOIN relation r ON r.elder_id = e.id
      WHERE r.person_id = ? AND r.status = 1 AND e.status = 'active'
      ORDER BY e.id`,
    [personId]
  );
}

/** 我在这位老人身上的关系记录 */
async function myRelation(personId, elderId) {
  return queryOne(
    'SELECT id, level, is_accountable AS isAccountable, role_label AS roleLabel FROM relation WHERE person_id = ? AND elder_id = ?',
    [personId, elderId]
  );
}

// ---------------- R1 GET /relation/home ----------------
router.get('/home', async (req, res, next) => {
  try {
    await requireRelation(req.user.personId);
    const elders = await myElders(req.user.personId);
    if (!elders.length) return ok(res, { elders: [], mergedNotification: null, bills: [], evidenceRequests: [] });

    // 每位老人今天的状态一句话
    const withStatus = [];
    for (const e of elders) {
      const d = await queryOne(
        'SELECT calendar_confirmed AS confirmed FROM signal_daily WHERE elder_id = ? ORDER BY stat_date DESC LIMIT 1',
        [e.id]
      );
      withStatus.push({
        ...e,
        statusLine: d && d.confirmed ? '今天已确认' : '今天还没消息',
      });
    }

    // 最新一条待回执通知（多老人 30 分钟内合并成一条，这里取最新即可）
    const noti = await queryOne(
      `SELECT n.id, n.order_id AS orderId, vo.alert_id AS alertId, n.is_accountable AS isAccountable,
              n.sent_at AS sentAt, e.id AS elderId, e.name AS elderName, vo.sla_deadline AS slaDeadline
         FROM notification n
         JOIN verify_order vo ON vo.id = n.order_id AND n.order_type = 'verify'
         JOIN elder e ON e.id = vo.elder_id
        WHERE n.person_id = ? AND n.ack_at IS NULL AND vo.status <> 'closed'
        ORDER BY n.sent_at DESC LIMIT 1`,
      [req.user.personId]
    );

    let mergedNotification = null;
    if (noti) {
      const alert = await queryOne(
        `SELECT signal_snapshot AS snapshot FROM alert WHERE id = ? AND elder_id = ?`,
        [noti.alertId, noti.elderId]
      );
      const snapshot = parseJson(alert && alert.snapshot, []);
      const firstNote = snapshot.length ? snapshot[0].note : '今天有点不一样';
      mergedNotification = {
        id: noti.id,
        elderId: noti.elderId,
        elderName: noti.elderName,
        reason: firstNote,
        createdAt: formatDateTime(noti.sentAt),
        isAccountable: !!noti.isAccountable,
      };
    }

    const bills = await query(
      `SELECT b.id, b.amount, b.status, b.created_at AS createdAt, e.name AS elderName
         FROM bill b JOIN elder e ON e.id = b.elder_id
        WHERE b.payer_person_id = ? AND b.status = 'pending'
        ORDER BY b.created_at DESC`,
      [req.user.personId]
    );

    return ok(res, { elders: withStatus, mergedNotification, bills, evidenceRequests: await listEvidenceRequests(req.user.personId) });
  } catch (e) {
    return next(e);
  }
});

// ---------------- R2 GET /relation/notifications/:id ----------------
router.get('/notifications/:id', async (req, res, next) => {
  try {
    await requireRelation(req.user.personId);
    const noti = await queryOne(
      `SELECT n.id, n.order_id AS orderId, n.person_id AS personId, n.is_accountable AS isAccountable,
              n.sent_at AS sentAt, n.ack_at AS ackAt
         FROM notification n WHERE n.id = ? AND n.order_type = 'verify'`,
      [Number(req.params.id)]
    );
    if (!noti) return fail(res, 404, '通知不存在');
    if (noti.personId !== req.user.personId) return fail(res, 403, '无权查看他人的通知');

    const order = await queryOne(
      `SELECT id, elder_id AS elderId, alert_id AS alertId, current_layer AS currentLayer, status, sla_deadline AS slaDeadline
         FROM verify_order WHERE id = ?`,
      [noti.orderId]
    );
    if (!order) return fail(res, 404, '核验单不存在');

    const elder = await queryOne(
      'SELECT id, name, birth_year AS birthYear, addr FROM elder WHERE id = ?',
      [order.elderId]
    );

    const alert = await queryOne(
      'SELECT d_score AS d, q_score AS q, cell, signal_snapshot AS snapshot FROM alert WHERE id = ? AND elder_id = ?',
      [order.alertId, order.elderId]
    );
    const snapshot = parseJson(alert && alert.snapshot, []);
    const reasons = snapshot.map((s) => s.note || s.signal);

    const lastService = await queryOne(
      `SELECT done_at AS at, content_text AS content FROM service_order
        WHERE elder_id = ? AND status = 'done' ORDER BY done_at DESC LIMIT 1`,
      [order.elderId]
    );

    // 已回执就置灰按钮
    const buttons = noti.ackAt
      ? []
      : [
          { key: 'ok_visited', label: '我去看过了' },
          { key: 'ok_called', label: '我打过电话了' },
          { key: 'unreachable', label: '联系不上' },
        ];

    return ok(res, {
      id: noti.id,
      elder,
      reasons: reasons.length ? reasons : ['今天还没有确认'],
      alert: alert ? { d: Number(alert.d), q: Number(alert.q), cell: alert.cell } : null,
      lastService: lastService
        ? { at: formatDateTime(lastService.at), content: lastService.content }
        : null,
      isAccountable: !!noti.isAccountable,
      slaLeftSec: order.slaDeadline ? secondsUntil(order.slaDeadline) : null,
      buttons,
    });
  } catch (e) {
    return next(e);
  }
});

// ---------------- R3 POST /relation/notifications/:id/ack ----------------
router.post('/notifications/:id/ack', async (req, res, next) => {
  try { return ok(res, await ackNotification(Number(req.params.id), req.user.personId, String(req.body.result || ''))); }
  catch (error) { return next(error); }
});

// ---------------- R10 POST /relation/evidence-requests/:id/ack ----------------
router.post('/evidence-requests/:id/ack', async (req, res, next) => {
  const alertId = Number(req.params.id);
  if (!Number.isSafeInteger(alertId) || alertId < 1) return fail(res, 422, '请求编号不合法');
  try { return ok(res, await ackEvidence(alertId, req.user.personId, req.body)); }
  catch (error) { return next(error); }
});

// ---------------- R4 GET /relation/elders/:id/brief ----------------
router.get('/elders/:id/brief', async (req, res, next) => {
  try {
    const elderId = Number(req.params.id);
    const rel = await myRelation(req.user.personId, elderId);
    if (!rel) return fail(res, 403, '无权查看该老人');

    const days = await query(
      `SELECT calendar_confirmed AS confirmed FROM signal_daily
        WHERE elder_id = ? ORDER BY stat_date DESC LIMIT 7`,
      [elderId]
    );

    const lastService = await queryOne(
      `SELECT done_at AS at, content_text AS content FROM service_order
        WHERE elder_id = ? AND status = 'done' ORDER BY done_at DESC LIMIT 1`,
      [elderId]
    );

    const lastConfirm = await queryOne(
      `SELECT ack_at AS at, ack_result AS result FROM notification
        WHERE order_type = 'verify' AND person_id = ? AND ack_at IS NOT NULL
        ORDER BY ack_at DESC LIMIT 1`,
      [req.user.personId]
    );

    const openOrders = await query(
      `SELECT id, content_text AS title, status, created_at AS createdAt
         FROM service_order
        WHERE elder_id = ? AND status IN ('pending','assigned','accepted','doing')
        ORDER BY created_at DESC`,
      [elderId]
    );

    return ok(res, {
      elderId,
      checkInDays: { confirmed: days.filter((d) => d.confirmed).length, total: days.length || 7 },
      lastService: lastService
        ? { at: formatDateTime(lastService.at), content: lastService.content, source: '服务记录' }
        : null,
      lastConfirm: lastConfirm
        ? { at: formatDateTime(lastConfirm.at), result: lastConfirm.result, source: '回执记录' }
        : null,
      openOrders: openOrders.map((o) => ({ ...o, createdAt: formatDateTime(o.createdAt) })),
    });
  } catch (e) {
    return next(e);
  }
});

// ---------------- R5 GET /relation/bills ----------------
router.get('/bills', async (req, res, next) => {
  try {
    const status = req.query.status;
    const params = [req.user.personId];
    let sql = `SELECT b.id, b.amount, b.status, b.created_at AS createdAt, b.paid_at AS paidAt,
                      e.name AS elderName, so.content_text AS items
                 FROM bill b
                 JOIN elder e ON e.id = b.elder_id
                 LEFT JOIN service_order so ON so.id = b.service_order_id
                WHERE b.payer_person_id = ?`;
    if (status) {
      sql += ' AND b.status = ?';
      params.push(status);
    }
    sql += ' ORDER BY b.created_at DESC';

    const list = await query(sql, params);
    const wallet = await queryOne('SELECT balance FROM wallet WHERE person_id = ?', [req.user.personId]);

    return ok(res, {
      list: list.map((b) => ({
        ...b,
        amount: Number(b.amount),
        createdAt: formatDateTime(b.createdAt),
        paidAt: b.paidAt ? formatDateTime(b.paidAt) : null,
      })),
      balance: wallet ? Number(wallet.balance) : 0,
    });
  } catch (e) {
    return next(e);
  }
});

// ---------------- R6 POST /relation/bills/:id/pay ----------------
router.post('/bills/:id/pay', async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const billId = Number(req.params.id);
    await conn.beginTransaction();

    const [bills] = await conn.execute(
      `SELECT b.id, b.amount, b.status, b.payer_person_id AS payerId
         FROM bill b WHERE b.id = ? FOR UPDATE`,
      [billId]
    );
    const bill = bills[0];
    if (!bill) {
      await conn.rollback();
      return fail(res, 404, '账单不存在');
    }
    if (bill.payerId !== req.user.personId) {
      await conn.rollback();
      return fail(res, 403, '无权支付他人的账单');
    }
    if (bill.status !== 'pending') {
      await conn.rollback();
      return fail(res, 409, '该账单已处理');
    }

    const [wallets] = await conn.execute('SELECT id, balance FROM wallet WHERE person_id = ? FOR UPDATE', [req.user.personId]);
    const wallet = wallets[0];
    const amount = Number(bill.amount);
    if (!wallet || Number(wallet.balance) < amount) {
      await conn.rollback();
      return fail(res, 409, '余额不足，请先充值');
    }

    const newBalance = Number((Number(wallet.balance) - amount).toFixed(2));

    await conn.execute('UPDATE wallet SET balance = ? WHERE id = ?', [newBalance, wallet.id]);
    await conn.execute(
      `INSERT INTO wallet_txn (wallet_id, type, amount, balance_after, ref_type, ref_id, note)
       VALUES (?, 'pay', ?, ?, 'bill', ?, ?)`,
      [wallet.id, -amount, newBalance, billId, '支付服务单账单']
    );
    await conn.execute('UPDATE bill SET status = ?, paid_at = NOW() WHERE id = ?', ['paid', billId]);

    await conn.commit();
    return ok(res, { ok: true, balance: newBalance });
  } catch (e) {
    try { await conn.rollback(); } catch { /* ignore */ }
    return next(e);
  } finally {
    conn.release();
  }
});

// ---------------- R7 POST /relation/wallet/recharge ----------------
router.post('/wallet/recharge', async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const amount = Number(req.body.amount);
    if (!amount || amount <= 0) return fail(res, 422, '充值金额必须大于 0');

    await conn.beginTransaction();
    await conn.execute(
      'INSERT INTO wallet (person_id, balance) VALUES (?, 0) ON DUPLICATE KEY UPDATE person_id = person_id',
      [req.user.personId]
    );
    const [wallets] = await conn.execute('SELECT id, balance FROM wallet WHERE person_id = ? FOR UPDATE', [req.user.personId]);
    const wallet = wallets[0];
    const newBalance = Number((Number(wallet.balance) + amount).toFixed(2));

    await conn.execute('UPDATE wallet SET balance = ? WHERE id = ?', [newBalance, wallet.id]);
    await conn.execute(
      `INSERT INTO wallet_txn (wallet_id, type, amount, balance_after, note)
       VALUES (?, 'recharge', ?, ?, ?)`,
      [wallet.id, amount, newBalance, '模拟充值']
    );

    await conn.commit();
    return ok(res, { balance: newBalance });
  } catch (e) {
    try { await conn.rollback(); } catch { /* ignore */ }
    return next(e);
  } finally {
    conn.release();
  }
});

// ---------------- R8 POST /relation/service-orders/:id/accept ----------------
router.post('/service-orders/:id/accept', async (req, res, next) => {
  try {
    const order = await queryOne(
      'SELECT id, elder_id AS elderId, status FROM service_order WHERE id = ?',
      [Number(req.params.id)]
    );
    if (!order) return fail(res, 404, '服务单不存在');

    const rel = await myRelation(req.user.personId, order.elderId);
    if (!rel) return fail(res, 403, '无权接该老人的单');
    if (!['pending', 'assigned'].includes(order.status)) return fail(res, 409, '该单已被接走');

    await execute(
      `UPDATE service_order SET status = 'accepted', assignee_id = ?, assignee_role = ?, accepted_at = NOW()
        WHERE id = ? AND status IN ('pending','assigned')`,
      [req.user.personId, 'family', order.id]
    );
    await execute(
      'INSERT INTO order_event (order_type, order_id, actor_id, action) VALUES (?, ?, ?, ?)',
      ['service', order.id, req.user.personId, 'accept']
    );

    const updated = await queryOne('SELECT id, status, accepted_at AS acceptedAt FROM service_order WHERE id = ?', [order.id]);
    return ok(res, { ok: true, order: { ...updated, acceptedAt: formatDateTime(updated.acceptedAt) } });
  } catch (e) {
    return next(e);
  }
});

// ---------------- R9 POST /relation/service-orders/:id/decline ----------------
router.post('/service-orders/:id/decline', async (req, res, next) => {
  try {
    const order = await queryOne(
      'SELECT id, elder_id AS elderId, status FROM service_order WHERE id = ?',
      [Number(req.params.id)]
    );
    if (!order) return fail(res, 404, '服务单不存在');

    const rel = await myRelation(req.user.personId, order.elderId);
    if (!rel) return fail(res, 403, '无权操作该单');

    // 落回待接池，不影响关系链
    await execute('UPDATE service_order SET status = ?, assignee_id = NULL WHERE id = ?', ['pending', order.id]);
    await execute(
      'INSERT INTO order_event (order_type, order_id, actor_id, action, payload) VALUES (?, ?, ?, ?, ?)',
      ['service', order.id, req.user.personId, 'decline', JSON.stringify({ reason: req.body.reason || null })]
    );

    return ok(res, { ok: true, nextStep: '已退回待接池，会继续找其他人' });
  } catch (e) {
    return next(e);
  }
});

/** MySQL JSON 列兼容 */
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

module.exports = router;

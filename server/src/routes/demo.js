/**
 * 调试与演示 — D1 / D2 / D3
 * 见 docs/04-接口列表.md 第六节。
 *
 * 核心目的不是演示好看，是开发自测：
 *   D3 时间倍速让「15 分钟升级」在 15 秒内可见，
 *   否则测一次 SLA 要等 15 分钟，CAS 并发问题根本发现不了。
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2');

const config = require('../config');
const { query, queryOne, execute } = require('../db');
const { ok, fail } = require('../utils/response');
const { requireAuth, requireFunction } = require('../middleware/auth');
const { now } = require('../utils/time');
const { acquireMaintenance } = require('../services/job-store');
const { changeScale } = require('../services/clock-control');
const { actor } = require('../services/routing-store');
const { businessClock } = require('../utils/business-clock');

const router = express.Router();

router.use(requireAuth, requireFunction('admin'));

const SEED_PATH = path.resolve(__dirname, '../../../sql/seed.sql');

// ---------------- D1 POST /demo/reset ----------------
// 清库重灌种子数据，30 秒内可重复
router.post('/reset', async (req, res, next) => {
  const startedAt = Date.now();
  let conn;
  let maintenance;
  try {
    // 生产环境禁止清库
    if (!config.isDev) {
      return fail(res, 403, '生产环境不允许重置数据');
    }
    if (req.app.locals.jobRuntime?.getHealth().enabled ?? config.jobs.enabled) return fail(res, 409, '请先停用调度并重启后清库');
    if (!fs.existsSync(SEED_PATH)) {
      return fail(res, 500, '找不到 sql/seed.sql，无法重置');
    }
    const seedSql = fs.readFileSync(SEED_PATH, 'utf8').replace(/^\s*USE\s+yinling\s*;/im, 'USE '+mysql.escapeId(config.db.database)+';');

    maintenance = await acquireMaintenance();
    conn = maintenance.connection;
    await actor(conn, req.user.personId, ['admin']);
    await conn.query(seedSql);
    businessClock.reset();
    req.app.locals.jobRuntime?.clearAfterDataReset();

    const elderRow = await queryOne('SELECT COUNT(*) AS n FROM elder');
    const relRow = await queryOne('SELECT COUNT(*) AS n FROM relation');

    return ok(res, {
      ok: true,
      elders: Number(elderRow.n || 0),
      relations: Number(relRow.n || 0),
      tookMs: Date.now() - startedAt,
    });
  } catch (e) {
    return next(e);
  } finally {
    if (maintenance) await maintenance.release();
  }
});

// ---------------- D2 POST /demo/trigger ----------------
// 手动造一条预警，跳过等待
router.post('/trigger', async (req, res, next) => {
  try {
    const elderId = Number(req.body.elderId || 1);
    const elder = await queryOne('SELECT id, name FROM elder WHERE id = ?', [elderId]);
    if (!elder) return fail(res, 404, '老人档案不存在');

    // 造一条 alert
    const snapshot = [
      { signal: 'calendar_confirmed', value: 0, days: 2, weight: 0.4, note: '连续 2 天未撕日历' },
      { signal: 'app_open', value: 0, days: 1, weight: 0.2, note: '全天未打开小程序' },
      { signal: 'last_service', value: null, weight: 0.3, note: '最近一次上门距今较久' },
    ];
    const alertResult = await execute(
      `INSERT INTO alert (elder_id, d_score, q_score, cell, signal_snapshot) VALUES (?, ?, ?, 'strong', ?)`,
      [elderId, 0.72, 0.61, JSON.stringify(snapshot)]
    );
    const alertId = alertResult.insertId;

    // 造核验单：第 1 层，15 分钟后到期
    const waitMin = Number((await queryOne("SELECT v FROM param WHERE community_id = 1 AND k = 'layer1_wait_min'"))?.v || 15);
    const orderResult = await execute(
      `INSERT INTO verify_order (elder_id, alert_id, source, current_layer, status, route_mode, sla_deadline)
       VALUES (?, ?, 'alert', 1, 'notified', 'relation', DATE_ADD(NOW(), INTERVAL ? MINUTE))`,
      [elderId, alertId, waitMin]
    );
    const orderId = orderResult.insertId;

    // 通知第 1 层全部关系人
    const relations = await query(
      'SELECT id, person_id AS personId, is_accountable AS isAccountable FROM relation WHERE elder_id = ? AND level = 1 AND status = 1',
      [elderId]
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
      ['verify', orderId, req.user.personId, 'notify', JSON.stringify({ layer: 1, count: relations.length, manual: true })]
    );

    return ok(res, {
      alertId,
      orderId,
      elderId,
      elderName: elder.name,
      notifiedCount: relations.length,
      slaDeadlineMin: waitMin,
      createdAt: now(),
    });
  } catch (e) {
    return next(e);
  }
});

// ---------------- D3 PUT /demo/time-scale ----------------
// scale: 1 / 10 / 60
router.put('/time-scale', async (req, res, next) => {
  try {
    const scale = Number(req.body.scale);
    if (![1, 10, 60].includes(scale)) return fail(res, 422, 'scale 只能是 1 / 10 / 60');

    return ok(res, await changeScale(req.user.personId, scale, { ownerId: req.app.locals.jobRuntime?.ownerId() ?? null }));
  } catch (e) {
    return next(e);
  }
});

module.exports = router;

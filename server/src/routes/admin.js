/**
 * 管理端 — M1 / M2 / M3 / M4 / M5 / M6 / M7 / M8 / M9 / M10 / M11
 * 见 docs/04-接口列表.md 第五节。
 *
 * 硬规则：
 *   - M1 的 note 是口径说明，前端必须显示
 *   - M6 用整体覆盖式保存，不做逐条增删
 *   - M8 只允许白名单 key
 */
const express = require('express');
const { pool, query, queryOne, execute } = require('../db');
const { ok, fail } = require('../utils/response');
const { requireAuth, requireFunction } = require('../middleware/auth');
const { formatDateTime } = require('../utils/time');
const { loadParams, WRITABLE_KEYS } = require('../utils/param');

const router = express.Router();

router.use(requireAuth, requireFunction('admin'));

/** 分页 */
function paginate(req) {
  const page = Math.max(1, Number(req.query.page || 1));
  const size = Math.max(1, Math.min(Number(req.query.size || 20), 100));
  return { page, size, offset: (page - 1) * size };
}

function safeJson(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') {
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  }
  return v;
}

// ---------------- ping（鉴权链路冒烟测试点，保留）----------------
router.get('/ping', (req, res) => {
  return ok(res, {
    ok: true,
    personId: req.user.personId,
    name: req.user.name,
    functions: req.user.functions,
  });
});

// ---------------- M1 GET /admin/overview ----------------
router.get('/overview', async (req, res, next) => {
  try {
    const range = String(req.query.range || '7d');
    const days = range === '30d' ? 30 : range === '1d' ? 1 : 7;

    const alertRow = await queryOne(
      'SELECT COUNT(*) AS n FROM alert WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)',
      [days]
    );
    const invalidRow = await queryOne(
      'SELECT COUNT(*) AS n FROM disposition WHERE is_invalid_check = 1 AND created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)',
      [days]
    );
    const ackRow = await queryOne(
      'SELECT COUNT(*) AS total, SUM(ack_at IS NOT NULL) AS acked FROM notification WHERE sent_at >= DATE_SUB(NOW(), INTERVAL ? DAY)',
      [days]
    );
    const avgRow = await queryOne(
      'SELECT AVG(duration_min) AS avgMin FROM disposition WHERE duration_min IS NOT NULL AND created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)',
      [days]
    );
    const pendingRow = await queryOne("SELECT COUNT(*) AS n FROM verify_order WHERE status <> 'closed'");
    const overdueRow = await queryOne("SELECT COUNT(*) AS n FROM verify_order WHERE status <> 'closed' AND sla_deadline < NOW()");
    const unreadRow = await queryOne('SELECT COUNT(*) AS n FROM notification WHERE ack_at IS NULL');

    const totalNoti = Number(ackRow.total || 0);
    const acked = Number(ackRow.acked || 0);

    return ok(res, {
      alerts: Number(alertRow.n || 0),
      invalidChecks: Number(invalidRow.n || 0),
      familyAckRate: totalNoti ? Number((acked / totalNoti).toFixed(3)) : 0,
      avgResponseMin: avgRow.avgMin === null ? null : Number(Number(avgRow.avgMin).toFixed(1)),
      note: '台账口径，与问卷自报不可比；无效核查 = 结论为「没事」或「拒单」的单',
      pendingCount: Number(pendingRow.n || 0),
      overdueCount: Number(overdueRow.n || 0),
      unreadCount: Number(unreadRow.n || 0),
      lastJobAt: null,
      range,
    });
  } catch (e) {
    return next(e);
  }
});

// ---------------- M2 GET /admin/elders ----------------
router.get('/elders', async (req, res, next) => {
  try {
    const { page, size, offset } = paginate(req);
    const where = ['1 = 1'];
    const params = [];

    if (req.query.q) {
      where.push('(e.name LIKE ? OR p.phone LIKE ?)');
      params.push(`%${req.query.q}%`, `%${req.query.q}%`);
    }
    if (req.query.level) {
      where.push('e.monitor_level = ?');
      params.push(req.query.level);
    }
    if (req.query.status) {
      where.push('e.status = ?');
      params.push(req.query.status);
    }

    const clause = where.join(' AND ');
    const totalRow = await queryOne(
      `SELECT COUNT(*) AS n FROM elder e JOIN person p ON p.id = e.person_id WHERE ${clause}`,
      params
    );
    const list = await query(
      `SELECT e.id, e.name, e.birth_year AS birthYear, e.addr, e.mode,
              e.monitor_level AS monitorLevel, e.status, p.phone, e.created_at AS createdAt
         FROM elder e JOIN person p ON p.id = e.person_id
        WHERE ${clause}
        ORDER BY e.id
        LIMIT ${size} OFFSET ${offset}`,
      params
    );

    return ok(res, {
      list: list.map((e) => ({ ...e, createdAt: formatDateTime(e.createdAt) })),
      total: Number(totalRow.n || 0),
      page,
      size,
    });
  } catch (e) {
    return next(e);
  }
});

// ---------------- M3 POST /admin/elders ----------------
router.post('/elders', async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const { name, birthYear, addr, mode, monitorLevel, phone } = req.body;
    if (!name) return fail(res, 422, 'name 必填');
    if (!birthYear) return fail(res, 422, 'birthYear 必填');
    if (!addr) return fail(res, 422, 'addr 必填');

    await conn.beginTransaction();

    // 没给手机号就生成占位号，避免 person.phone 唯一键冲突
    const finalPhone = phone || `199${String(Date.now()).slice(-8)}`;
    const [p] = await conn.execute(
      "INSERT INTO person (phone, name, functions) VALUES (?, ?, JSON_ARRAY('resident'))",
      [finalPhone, name]
    );
    const [e] = await conn.execute(
      'INSERT INTO elder (person_id, name, birth_year, addr, mode, monitor_level) VALUES (?, ?, ?, ?, ?, ?)',
      [p.insertId, name, Number(birthYear), addr, mode || 'self', monitorLevel || 'record_only']
    );

    await conn.commit();
    return ok(res, { elderId: e.insertId, personId: p.insertId });
  } catch (e) {
    try { await conn.rollback(); } catch { /* ignore */ }
    if (e && e.code === 'ER_DUP_ENTRY') return fail(res, 409, '手机号已存在');
    return next(e);
  } finally {
    conn.release();
  }
});

// ---------------- M4 PATCH /admin/elders/:id ----------------
router.patch('/elders/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const existing = await queryOne('SELECT id FROM elder WHERE id = ?', [id]);
    if (!existing) return fail(res, 404, '老人档案不存在');

    const fields = [];
    const params = [];
    const map = {
      name: 'name',
      birthYear: 'birth_year',
      addr: 'addr',
      mode: 'mode',
      monitorLevel: 'monitor_level',
      status: 'status',
    };
    for (const [key, column] of Object.entries(map)) {
      if (req.body[key] !== undefined) {
        fields.push(`${column} = ?`);
        params.push(req.body[key]);
      }
    }
    if (!fields.length) return fail(res, 422, '没有可更新的字段');

    params.push(id);
    await execute(`UPDATE elder SET ${fields.join(', ')} WHERE id = ?`, params);
    return ok(res, { ok: true });
  } catch (e) {
    return next(e);
  }
});

// ---------------- M5 GET /admin/elders/:id/chain ----------------
router.get('/elders/:id/chain', async (req, res, next) => {
  try {
    const elderId = Number(req.params.id);
    const elder = await queryOne('SELECT id FROM elder WHERE id = ?', [elderId]);
    if (!elder) return fail(res, 404, '老人档案不存在');

    const rows = await query(
      `SELECT r.id, r.level, r.role_label AS roleLabel, r.is_accountable AS isAccountable,
              r.priority, r.group_id AS groupId, p.id AS personId, p.name
         FROM relation r JOIN person p ON p.id = r.person_id
        WHERE r.elder_id = ? AND r.status = 1
        ORDER BY r.level, r.priority, r.id`,
      [elderId]
    );
    const groups = await query(
      'SELECT id, level, form, name FROM relation_group WHERE elder_id = ? ORDER BY level',
      [elderId]
    );

    const byLevel = new Map();
    for (const r of rows) {
      if (!byLevel.has(r.level)) {
        const g = groups.find((x) => x.level === r.level);
        byLevel.set(r.level, {
          level: r.level,
          form: g ? g.form : 'group',
          name: g ? g.name : null,
          groupId: g ? g.id : null,
          waitMin: null,
          members: [],
        });
      }
      byLevel.get(r.level).members.push({
        relationId: r.id,
        personId: r.personId,
        name: r.name,
        roleLabel: r.roleLabel,
        isAccountable: !!r.isAccountable,
        priority: r.priority,
      });
    }

    const params = await loadParams();
    const layers = [...byLevel.values()].sort((a, b) => a.level - b.level);
    for (const l of layers) {
      l.waitMin = Number(params[`layer${l.level}_wait_min`] || (l.level === 1 ? 15 : 120));
    }

    return ok(res, { elderId, layers });
  } catch (e) {
    return next(e);
  }
});

// ---------------- M6 PUT /admin/elders/:id/chain ----------------
// 整体覆盖式保存：清空该老人的 relation / relation_group，再按新结构重建
router.put('/elders/:id/chain', async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const elderId = Number(req.params.id);
    const layers = Array.isArray(req.body.layers) ? req.body.layers : null;
    if (!layers) return fail(res, 422, 'layers 必须是数组');

    const elder = await queryOne('SELECT id FROM elder WHERE id = ?', [elderId]);
    if (!elder) return fail(res, 404, '老人档案不存在');

    await conn.beginTransaction();
    await conn.execute('DELETE FROM relation WHERE elder_id = ?', [elderId]);
    await conn.execute('DELETE FROM relation_group WHERE elder_id = ?', [elderId]);

    let affected = 0;
    for (const layer of layers) {
      const level = Number(layer.level);
      if (!level) {
        await conn.rollback();
        return fail(res, 422, 'layer.level 必填');
      }
      const [g] = await conn.execute(
        'INSERT INTO relation_group (elder_id, level, form, name) VALUES (?, ?, ?, ?)',
        [elderId, level, layer.form || 'group', layer.name || null]
      );

      let priority = 0;
      for (const m of layer.members || []) {
        if (!m.personId) continue;
        priority += 1;
        await conn.execute(
          `INSERT INTO relation (elder_id, person_id, group_id, level, role_label, is_accountable, priority)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [elderId, m.personId, g.insertId, level, m.roleLabel || '家属', m.isAccountable ? 1 : 0, priority]
        );
        affected += 1;
      }
    }

    await conn.commit();
    return ok(res, { ok: true, affected });
  } catch (e) {
    try { await conn.rollback(); } catch { /* ignore */ }
    return next(e);
  } finally {
    conn.release();
  }
});

// ---------------- M7 GET /admin/params ----------------
router.get('/params', async (req, res, next) => {
  try {
    const params = await loadParams();
    return ok(res, { params, writableKeys: WRITABLE_KEYS });
  } catch (e) {
    return next(e);
  }
});

// ---------------- M8 PUT /admin/params ----------------
router.put('/params', async (req, res, next) => {
  try {
    const entries = Object.entries(req.body || {});
    if (!entries.length) return fail(res, 422, '没有要更新的参数');

    const rejected = entries.filter(([k]) => !WRITABLE_KEYS.includes(k)).map(([k]) => k);
    if (rejected.length) return fail(res, 422, `不允许修改的参数: ${rejected.join(', ')}`);

    for (const [k, v] of entries) {
      await execute(
        `INSERT INTO param (community_id, k, v) VALUES (1, ?, ?)
         ON DUPLICATE KEY UPDATE v = VALUES(v)`,
        [k, String(v)]
      );
    }

    const params = await loadParams();
    return ok(res, { ok: true, params });
  } catch (e) {
    return next(e);
  }
});

// ---------------- M9 GET /admin/orders ----------------
router.get('/orders', async (req, res, next) => {
  try {
    const { page, size, offset } = paginate(req);
    const where = ['1 = 1'];
    const params = [];

    if (req.query.type) {
      where.push('o.order_type = ?');
      params.push(req.query.type);
    }
    if (req.query.status) {
      where.push('o.status = ?');
      params.push(req.query.status);
    }
    if (req.query.from) {
      where.push('o.created_at >= ?');
      params.push(req.query.from);
    }
    if (req.query.to) {
      where.push('o.created_at <= ?');
      params.push(req.query.to);
    }

    const clause = where.join(' AND ');
    const totalRow = await queryOne(`SELECT COUNT(*) AS n FROM v_order_all o WHERE ${clause}`, params);
    const list = await query(
      `SELECT o.order_type AS type, o.id, o.elder_id AS elderId, e.name AS elderName,
              o.status, o.assignee_id AS assigneeId, o.created_at AS createdAt, o.finished_at AS finishedAt
         FROM v_order_all o JOIN elder e ON e.id = o.elder_id
        WHERE ${clause}
        ORDER BY o.created_at DESC
        LIMIT ${size} OFFSET ${offset}`,
      params
    );

    return ok(res, {
      list: list.map((o) => ({
        ...o,
        createdAt: formatDateTime(o.createdAt),
        finishedAt: o.finishedAt ? formatDateTime(o.finishedAt) : null,
      })),
      total: Number(totalRow.n || 0),
      page,
      size,
    });
  } catch (e) {
    return next(e);
  }
});

// ---------------- M10 GET /admin/orders/:id ----------------
router.get('/orders/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const type = req.query.type === 'service' ? 'service' : 'verify';

    const order = type === 'verify'
      ? await queryOne(
          'SELECT vo.*, e.name AS elderName FROM verify_order vo JOIN elder e ON e.id = vo.elder_id WHERE vo.id = ?',
          [id]
        )
      : await queryOne(
          'SELECT so.*, e.name AS elderName FROM service_order so JOIN elder e ON e.id = so.elder_id WHERE so.id = ?',
          [id]
        );
    if (!order) return fail(res, 404, '工单不存在');

    const events = await query(
      `SELECT id, actor_id AS actorId, action, payload, ts FROM order_event
        WHERE order_type = ? AND order_id = ? ORDER BY ts`,
      [type, id]
    );

    const disposition = type === 'verify'
      ? await queryOne(
          `SELECT result_code AS resultCode, method, duration_min AS durationMin,
                  note, is_invalid_check AS isInvalidCheck, created_at AS createdAt
             FROM disposition WHERE order_id = ?`,
          [id]
        )
      : null;

    return ok(res, {
      order,
      events: events.map((e) => ({ ...e, ts: formatDateTime(e.ts), payload: safeJson(e.payload) })),
      disposition: disposition
        ? { ...disposition, createdAt: formatDateTime(disposition.createdAt) }
        : null,
    });
  } catch (e) {
    return next(e);
  }
});

// ---------------- M11 PUT /admin/users/:id/role-label ----------------
router.put('/users/:id/role-label', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const person = await queryOne('SELECT id FROM person WHERE id = ?', [id]);
    if (!person) return fail(res, 404, '人员不存在');

    await execute('UPDATE person SET role_label = ? WHERE id = ?', [req.body.roleLabel || null, id]);
    return ok(res, { ok: true });
  } catch (e) {
    return next(e);
  }
});

module.exports = router;

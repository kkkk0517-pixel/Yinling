/**
 * 认证与绑定 — A1 / A2 / A3
 *
 * A4 邀请码、A5 绑定 依赖 relation / invite_code 的写入逻辑，
 * 归 #3（49 个接口全部注册）实现，这里先不挂空路由。
 *
 * 见 docs/04-接口列表.md 第一节。
 */
const express = require('express');
const config = require('../config');
const { query, queryOne, execute } = require('../db');
const { sign } = require('../utils/jwt');
const { ok, fail } = require('../utils/response');
const { requireAuth } = require('../middleware/auth');
const { formatDateTime } = require('../utils/time');

const router = express.Router();

/** MySQL JSON 列在 mysql2 里可能已经是对象，做一次兼容 */
function parseJson(value, fallback = []) {
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

/** 取这个人的职能身份数组 */
function functionsOf(person) {
  const fns = parseJson(person.functions, []);
  return Array.isArray(fns) ? fns : [];
}

/**
 * 查这个人能看到哪些老人档案。
 * - 居民（resident）：只有自己那条
 * - 关系人 / 承办人：在关系链里挂着的老人
 */
async function eldersOf(person, fns) {
  if (fns.includes('resident')) {
    return query(
      `SELECT e.id, e.name, e.birth_year AS birthYear, e.addr, e.monitor_level AS monitorLevel
         FROM elder e
        WHERE e.person_id = ? AND e.status = 1`,
      [person.id]
    );
  }

  return query(
    `SELECT DISTINCT e.id, e.name, e.birth_year AS birthYear, e.addr, e.monitor_level AS monitorLevel
       FROM elder e
       JOIN relation r ON r.elder_id = e.id
      WHERE r.person_id = ? AND r.status = 1 AND e.status = 1
      ORDER BY e.id`,
    [person.id]
  );
}

// ---------------- A1 POST /auth/sms-code ----------------
router.post('/sms-code', async (req, res, next) => {
  try {
    const phone = String(req.body.phone || '').trim();
    if (!/^1\d{10}$/.test(phone)) {
      return fail(res, 422, '手机号格式不正确');
    }

    // 开发环境固定返回，不发真短信
    if (config.isDev) {
      return ok(res, { sent: true, devCode: config.devSmsCode });
    }
    return ok(res, { sent: true });
  } catch (e) {
    return next(e);
  }
});

// ---------------- A2 POST /auth/login ----------------
router.post('/login', async (req, res, next) => {
  try {
    const phone = String(req.body.phone || '').trim();
    const code = String(req.body.code || '').trim();

    if (!/^1\d{10}$/.test(phone)) {
      return fail(res, 422, '手机号格式不正确');
    }
    if (!code) {
      return fail(res, 422, '验证码不能为空');
    }
    // 开发环境只认固定码；接真实短信通道后改这里
    if (config.isDev && code !== config.devSmsCode) {
      return fail(res, 401, '验证码错误');
    }

    const person = await queryOne(
      `SELECT id, phone, name, functions, role_label AS roleLabel
         FROM person
        WHERE phone = ? AND status = 1`,
      [phone]
    );

    if (!person) {
      return fail(res, 404, '该手机号未注册，请联系社区建档');
    }

    const fns = functionsOf(person);
    const elders = await eldersOf(person, fns);

    return ok(res, {
      token: sign({ id: person.id, functions: fns, name: person.name }),
      person: { id: person.id, name: person.name, phone: person.phone },
      functions: fns,
      elders,
    });
  } catch (e) {
    return next(e);
  }
});

// ---------------- A3 GET /auth/me ----------------
router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const person = await queryOne(
      `SELECT id, phone, name, functions, role_label AS roleLabel
         FROM person
        WHERE id = ? AND status = 1`,
      [req.user.personId]
    );

    if (!person) {
      // token 有效但人已被停用或删除
      return fail(res, 401, '账号已失效，请重新登录');
    }

    const fns = functionsOf(person);
    const elders = await eldersOf(person, fns);

    return ok(res, {
      person: { id: person.id, name: person.name, phone: person.phone },
      functions: fns,
      elders,
      roleLabels: { [person.roleLabel || '']: person.roleLabel },
    });
  } catch (e) {
    return next(e);
  }
});

// ---------------- A4 POST /auth/invite ----------------
router.post('/invite', requireAuth, async (req, res, next) => {
  try {
    const elderId = Number(req.body.elderId);
    if (!elderId) return fail(res, 422, 'elderId 必填');

    const elder = await queryOne('SELECT id, name FROM elder WHERE id = ? AND status = ?', [elderId, 'active']);
    if (!elder) return fail(res, 404, '老人档案不存在或已停用');

    // 重复生成时旧码作废
    await execute('UPDATE invite_code SET used_at = NOW() WHERE elder_id = ? AND used_at IS NULL', [elderId]);

    const code = String(Math.floor(100000 + Math.random() * 900000));
    const expiresAt = new Date(Date.now() + 7 * 24 * 3600 * 1000);
    await execute(
      'INSERT INTO invite_code (code, elder_id, created_by, expires_at) VALUES (?, ?, ?, ?)',
      [code, elderId, req.user.personId, expiresAt]
    );

    return ok(res, { code, expiresAt: formatDateTime(expiresAt) });
  } catch (e) {
    return next(e);
  }
});

// ---------------- A5 POST /auth/bind ----------------
router.post('/bind', requireAuth, async (req, res, next) => {
  try {
    const code = String(req.body.code || '').trim();
    if (!/^\d{6}$/.test(code)) return fail(res, 422, '邀请码应为 6 位数字');

    const row = await queryOne(
      `SELECT ic.id, ic.elder_id AS elderId, ic.expires_at AS expiresAt, ic.used_at AS usedAt,
              e.name AS elderName
         FROM invite_code ic
         JOIN elder e ON e.id = ic.elder_id
        WHERE ic.code = ?`,
      [code]
    );

    if (!row) return fail(res, 404, '邀请码不存在');
    if (row.usedAt) return fail(res, 409, '邀请码已被使用');
    if (new Date(row.expiresAt) < new Date()) return fail(res, 409, '邀请码已过期');

    await execute(
      'UPDATE invite_code SET used_at = NOW(), used_by = ? WHERE id = ?',
      [req.user.personId, row.id]
    );

    return ok(res, { elderId: row.elderId, elderName: row.elderName });
  } catch (e) {
    return next(e);
  }
});

module.exports = router;

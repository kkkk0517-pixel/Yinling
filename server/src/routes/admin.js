/**
 * 管理端路由占位。
 *
 * 目前只有 ping，用途是给鉴权链路一个可验证的落点：
 *   - 无 token            → 401
 *   - 有 token 但不是 admin → 403
 *   - admin                → 200
 *
 * M1–M11 在 #3 里实现。
 */
const express = require('express');
const { ok } = require('../utils/response');
const { requireAuth, requireFunction } = require('../middleware/auth');

const router = express.Router();

router.get('/ping', requireAuth, requireFunction('admin'), (req, res) => {
  return ok(res, {
    ok: true,
    personId: req.user.personId,
    name: req.user.name,
    functions: req.user.functions,
  });
});

module.exports = router;

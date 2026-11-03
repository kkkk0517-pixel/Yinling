/**
 * 鉴权中间件。
 *
 * 两条硬规则（见 AGENTS.md 第 5 节）：
 *   1. 权限判断必须在服务端。前端隐藏按钮不算权限控制。
 *   2. token 无效一律 401，不要漏成 500。
 */
const { verify } = require('../utils/jwt');
const { fail } = require('../utils/response');

/** 从 Authorization 头里取 Bearer token */
function extractToken(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  return token || null;
}

/**
 * 必须登录。成功时挂 req.user = { personId, functions, name }
 */
function requireAuth(req, res, next) {
  const token = extractToken(req);
  if (!token) {
    return fail(res, 401, '未登录');
  }

  try {
    const payload = verify(token);
    req.user = {
      personId: payload.sub,
      functions: Array.isArray(payload.functions) ? payload.functions : [],
      name: payload.name || '',
    };
    return next();
  } catch (e) {
    if (e && e.name === 'TokenExpiredError') {
      return fail(res, 401, '登录已过期，请重新登录');
    }
    return fail(res, 401, 'token 无效');
  }
}

/**
 * 必须具备其中任一职能身份。
 * 用法：router.get('/xxx', requireAuth, requireFunction('admin', 'agent'), handler)
 */
function requireFunction(...allowed) {
  return (req, res, next) => {
    const mine = (req.user && req.user.functions) || [];
    if (allowed.some((f) => mine.includes(f))) {
      return next();
    }
    return fail(res, 403, '无权限访问');
  };
}

module.exports = { requireAuth, requireFunction, extractToken };

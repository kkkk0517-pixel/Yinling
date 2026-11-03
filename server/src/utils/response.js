/**
 * 统一响应格式：{ code, data, msg }
 *
 * code = 0 表示成功；非 0 与 HTTP status 保持一致（401/403/404/409/422/500）。
 * 见 docs/04-接口列表.md「零、通用约定」。
 */

function ok(res, data = null) {
  return res.json({ code: 0, data, msg: '' });
}

function fail(res, status, msg, code) {
  return res.status(status).json({
    code: code === undefined ? status : code,
    data: null,
    msg: msg || '请求失败',
  });
}

module.exports = { ok, fail };

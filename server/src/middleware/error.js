/**
 * 兜底错误处理。
 *
 * 任何未捕获的异常都在这里变成 500，并且不把堆栈返回给客户端。
 */
const { fail } = require('../utils/response');

function notFound(req, res) {
  return fail(res, 404, `接口不存在: ${req.method} ${req.path}`);
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const status = err.status || 500;
  if (status >= 500) {
    console.error('[error]', req.method, req.path, err);
  }
  return fail(res, status, status >= 500 ? '服务器内部错误' : err.message);
}

module.exports = { notFound, errorHandler };

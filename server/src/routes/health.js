/**
 * GET /api/health
 *
 * 返回 200 且能连上数据库才算活。
 * 数据库挂了返回 503，让部署方和监控能立刻看出来。
 */
const express = require('express');
const { ping } = require('../db');
const { ok } = require('../utils/response');

const router = express.Router();

router.get('/health', async (req, res) => {
  const startedAt = Date.now();
  let dbStatus = 'up';
  let dbError = null;

  try {
    await ping();
  } catch (e) {
    dbStatus = 'down';
    dbError = e && e.code ? e.code : 'CONNECT_FAILED';
  }

  const data = {
    status: dbStatus === 'up' ? 'ok' : 'degraded',
    db: dbStatus,
    dbError,
    dbLatencyMs: Date.now() - startedAt,
    uptimeSec: Math.floor(process.uptime()),
    time: new Date().toISOString().slice(0, 19).replace('T', ' '),
  };

  if (dbStatus === 'up') {
    return ok(res, data);
  }
  return res.status(503).json({ code: 503, data, msg: '数据库不可用' });
});

module.exports = router;

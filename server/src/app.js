/**
 * Express 应用装配。只负责把中间件和路由串起来，不含业务逻辑。
 */
const express = require('express');
const cors = require('cors');

const healthRoutes = require('./routes/health');
const authRoutes = require('./routes/auth');
const elderRoutes = require('./routes/elder');
const relationRoutes = require('./routes/relation');
const agentRoutes = require('./routes/agent');
const adminRoutes = require('./routes/admin');
const demoRoutes = require('./routes/demo');
const { notFound, errorHandler } = require('./middleware/error');

function createApp({ jobRuntime } = {}) {
const app = express();
if (jobRuntime) app.locals.jobRuntime = jobRuntime;

// 前端跑在 5173，后端 3000，必须开 CORS
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// 简单的请求日志，开发时看得见就行
app.use((req, res, next) => {
  const startedAt = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - startedAt;
    console.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${ms}ms`);
  });
  next();
});

app.use('/api', healthRoutes);
// 业务时钟就绪独立于慢日批；备用/停用实例在每次请求前跟随持久化基准。
if (jobRuntime) app.use('/api', (req, res, next) => jobRuntime.ensureClock().then(() => next(), next));
app.use('/api/auth', authRoutes);
app.use('/api/elder', elderRoutes);
app.use('/api/relation', relationRoutes);
app.use('/api/agent', agentRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/demo', demoRoutes);

// 兜底
app.use(notFound);
app.use(errorHandler);

return app;
}
const app = createApp();
app.createApp = createApp;
module.exports = app;

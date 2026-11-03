/**
 * 入口。启动 HTTP 服务，并做一次启动自检（不阻塞）。
 */
const app = require('./app');
const config = require('./config');
const { ping } = require('./db');

const server = app.listen(config.port, () => {
  console.log('');
  console.log('  银铃后端已启动');
  console.log('  http://localhost:' + config.port + '/api/health');
  console.log('  环境: ' + config.env);
  console.log('');
});

// 启动自检：连不上数据库只警告，不退出。health 会如实报告。
(async () => {
  try {
    await ping();
    console.log('  [ok] 数据库连接正常');
  } catch (e) {
    console.warn('  [warn] 数据库连接失败: ' + (e.code || e.message));
    console.warn('         检查 .env 里的 DB_* 配置，或先跑 sql/schema.sql');
  }
  console.log('');
})();

// 优雅退出
['SIGINT', 'SIGTERM'].forEach((sig) => {
  process.on(sig, () => {
    console.log('\n  正在关闭...');
    server.close(() => process.exit(0));
  });
});

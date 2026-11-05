/** T3 任务体，03:00 的自动调度由 #12 接入。 */
const { calculateBaselines } = require('../services/baseline');

async function runBaseline(at) {
  return calculateBaselines(at);
}

if (require.main === module) {
  const { pool } = require('../db');
  runBaseline()
    .then(result => console.log('[T3] 基线计算完成', JSON.stringify(result)))
    .catch(error => {
      console.error('[T3] 基线计算失败', error.code || error.message);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}

module.exports = { runBaseline };

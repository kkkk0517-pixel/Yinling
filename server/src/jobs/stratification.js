/** T4 任务体；自动每小时触发由 #12 接入。 */
const { scanStratification } = require('../services/stratification');
async function runStratification(at) { return scanStratification(at); }

if (require.main === module) {
  const { pool } = require('../db');
  runStratification()
    .then(({ targetDate, elders, createdAlerts, reused, informationInsufficient }) => {
      console.log('[T4] 分层完成', JSON.stringify({ targetDate, elders, createdAlerts, reused, informationInsufficient }));
    })
    .catch(error => { console.error('[T4] 分层失败', error.code || error.message); process.exitCode = 1; })
    .finally(() => pool.end());
}
module.exports = { runStratification };

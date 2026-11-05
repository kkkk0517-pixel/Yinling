/** T1 的任务体；自动调度由 #12 接入。也可 npm run job:day-cut 手动执行。 */
const { aggregateDay } = require('../engine/l1');
const { getParam } = require('../utils/param');
const { now } = require('../utils/time');
const { signalDay } = require('../utils/signal-day');

async function runDayCut(at = now()) {
  const hour = Number(await getParam('day_cut_hour', 4));
  const currentDate = signalDay(at, hour);
  const previousDate = new Date(new Date(currentDate + 'T00:00:00Z').getTime() - 86400000).toISOString().slice(0, 10);
  const previous = await aggregateDay(previousDate);
  const current = await aggregateDay(currentDate);
  return { previous, current };
}

if (require.main === module) {
  const { pool } = require('../db');
  runDayCut()
    .then(result => console.log('[T1] 切日完成', JSON.stringify(result)))
    .catch(error => {
      console.error('[T1] 切日失败', error.code || error.message);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}

module.exports = { runDayCut };

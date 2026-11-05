/** 服务入口：停机排空调度和 HTTP，再关闭数据库。 */
const {startServer}=require('./server');
const {safeErrorCode}=require('./jobs/scheduler');
async function main(){
  const running=await startServer();
  console.log('银铃后端已启动 http://localhost:'+running.server.address().port+'/api/health');
  let closing=false;
  const shutdown=()=>{if(closing)return;closing=true;console.log('正在停止调度并等待在途任务...');running.stop().then(()=>process.exit(0)).catch(error=>{console.error('[shutdown] 失败',safeErrorCode(error));process.exit(1);});};
  process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);
}
if(require.main===module)main().catch(error=>{console.error('[startup] 失败',safeErrorCode(error));process.exitCode=1;});
module.exports={main};

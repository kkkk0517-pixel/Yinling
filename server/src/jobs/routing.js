const {routePendingAlerts}=require('../services/routing');
async function runRouting(at){return routePendingAlerts(at);}
if(require.main===module){const {pool}=require('../db');runRouting().then(({routed,merged,evidenceRequests})=>console.log('[L4] 路由完成',JSON.stringify({routed,merged,evidenceRequests}))).catch(error=>{console.error('[L4] 路由失败',error.code||error.message);process.exitCode=1;}).finally(()=>pool.end());}
module.exports={runRouting};

const {scanSla}=require('../services/routing');
async function runSlaScan(at){return scanSla(at);}
if(require.main===module){const {pool}=require('../db');runSlaScan().then(result=>console.log('[T2] SLA扫描完成',JSON.stringify(result))).catch(error=>{console.error('[T2] SLA扫描失败',error.code||error.message);process.exitCode=1;}).finally(()=>pool.end());}
module.exports={runSlaScan};

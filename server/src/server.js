/** HTTP 与托管调度的资源生命周期；导入本文件不启动服务。 */
const http=require('http');
const config=require('./config');
const {createApp}=require('./app');
const {pool,ping}=require('./db');
const {createJobRuntime}=require('./jobs/runtime');
const {safeErrorCode}=require('./jobs/scheduler');
async function startServer({port=config.port,host,closePool=true,jobOptions={},logger=message=>console.log(message)}={}){
  const runtime=createJobRuntime(jobOptions),app=createApp({jobRuntime:runtime}),server=http.createServer(app);
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,()=>{server.removeListener('error',reject);resolve();});});
  const ready=runtime.start();
  ping().catch(error=>logger('[warn] 数据库自检失败: '+safeErrorCode(error)));
  let stopping;
  function stop(){if(stopping)return stopping;const requests=new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));const jobs=runtime.stop({drain:requests});stopping=Promise.all([jobs,requests]).then(async()=>{if(closePool)await pool.end();});return stopping;}
  return {server,app,runtime,ready,stop};
}
module.exports={startServer};

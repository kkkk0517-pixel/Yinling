const {createHash}=require('crypto');
const {createJobConnection,query,execute}=require('../db');
const config=require('../config');
const {signalTime}=require('../utils/signal-day');
const key=suffix=>'yljobs:'+createHash('sha256').update(config.db.database+':1:'+suffix).digest('hex').slice(0,40);
const ownerKey=()=>key('owner');
const clockKey=()=>key('clock');
const failure=(status,message)=>Object.assign(new Error(message),{status});
async function acquireOwner(onLost=()=>{}){
  const conn=await createJobConnection();let released=false,lost=false;
  try{const [rows]=await conn.execute('SELECT GET_LOCK(?,0) AS acquired',[ownerKey()]);if(rows[0].acquired!==1){await conn.end();return null;}}
  catch(error){await conn.end().catch(()=>{});throw error;}
  const missing=error=>{if(released||lost)return;lost=true;onLost(error);};
  conn.on('error',missing);conn.on('end',()=>missing(new Error('owner connection ended')));
  return {connectionId:conn.threadId,alive:()=>!released&&!lost,release:async()=>{if(released)return;released=true;try{if(!lost)await conn.execute('SELECT RELEASE_LOCK(?)',[ownerKey()]);}finally{await conn.end().catch(()=>{});}}};
}
async function ownerActive(){const rows=await query('SELECT IS_USED_LOCK(?) AS owner',[ownerKey()]);return rows[0].owner!==null;}
async function acquireMaintenance(){
  const conn=await createJobConnection({multipleStatements:true});
  try{const [rows]=await conn.execute('SELECT GET_LOCK(?,0) AS acquired',[ownerKey()]);if(rows[0].acquired!==1)throw failure(409,'自动任务仍在运行，请先停用调度并重启后重置');
    const [clock]=await conn.execute('SELECT GET_LOCK(?,0) AS acquired',[clockKey()]);if(clock[0].acquired!==1)throw failure(409,'时钟正在变更，请稍后重试');
  }catch(error){await conn.end().catch(()=>{});throw error;}
  let released=false;return {connection:conn,release:async()=>{if(released)return;released=true;try{await conn.execute('SELECT RELEASE_LOCK(?)',[clockKey()]);await conn.execute('SELECT RELEASE_LOCK(?)',[ownerKey()]);}finally{await conn.end().catch(()=>{});}}};
}
async function recordJobEvent({jobId,event,state}){
  const action={started:'job_started',succeeded:'job_succeeded',failed:'job_failed'}[event];if(!action)throw new TypeError('unknown job event');
  await execute("INSERT INTO audit_log (action,target,target_id,payload,ts) VALUES (?,'job',?,?,?)",[action,Number(jobId.slice(1)),JSON.stringify({version:'jobs-v1',jobId,event,state}),event==='started'?state.lastStartedAt:state.lastFinishedAt]);
}
async function readJobHistory(){
  const out={};for(const id of ['T1','T2','T3','T4']){const rows=await query("SELECT payload FROM audit_log WHERE target='job' AND target_id=? AND action IN ('job_started','job_succeeded','job_failed') ORDER BY id DESC LIMIT 1",[Number(id.slice(1))]);if(rows.length){const value=typeof rows[0].payload==='string'?JSON.parse(rows[0].payload):rows[0].payload;if(value.version==='jobs-v1')out[id]=value.state;}}
  return out;
}
// 校验交给分任务执行器：坏切点只阻塞日批，不能阻止独立 T2 启动。
async function readDayCut(conn){const sql="SELECT v FROM param WHERE community_id=1 AND k='day_cut_hour'";const rows=conn?(await conn.execute(sql))[0]:await query(sql);return rows[0]?.v??4;}
module.exports={acquireOwner,ownerActive,acquireMaintenance,recordJobEvent,readJobHistory,readDayCut,ownerKey,clockKey,failure,realStamp:()=>signalTime(new Date())};

const {createJobConnection}=require('../db');
const config=require('../config');
const {businessClock,valueAt,validate}=require('../utils/business-clock');
const {signalTime}=require('../utils/signal-day');
const {actor}=require('./routing-store');
const jobStore=require('./job-store');
const {clockKey,ownerKey,failure}=jobStore;
async function withClockLock(work){const conn=await createJobConnection();try{const [lock]=await conn.execute('SELECT GET_LOCK(?,0) AS acquired',[clockKey()]);if(lock[0].acquired!==1)throw failure(409,'时钟正在变更，请稍后重试');return await work(conn);}finally{await conn.end().catch(()=>{});}}
async function saved(conn){const [rows]=await conn.execute("SELECT id,payload FROM audit_log WHERE action='clock_changed' AND target='clock' ORDER BY id DESC LIMIT 1");if(!rows.length)return null;const raw=typeof rows[0].payload==='string'?JSON.parse(rows[0].payload):rows[0].payload;const snapshot={revision:rows[0].id,scale:raw.scale,realBase:raw.realBase,businessBase:raw.businessBase};validate(snapshot);return snapshot;}
async function writeAnchor(conn,snapshot){const [result]=await conn.execute("INSERT INTO audit_log (action,target,target_id,payload,ts) VALUES ('clock_changed','clock',1,?,?)",[JSON.stringify({version:'clock-v1',scale:snapshot.scale,realBase:snapshot.realBase,businessBase:snapshot.businessBase}),signalTime(new Date(snapshot.realBase))]);return {...snapshot,revision:result.insertId};}
// 仅持有 clock 锁时使用：D1 重置会重启审计 ID，此时数据库的新序列仍是权威。
function restoreLockedClock(clock,anchor){if(!clock.apply(anchor)){clock.reset();clock.apply(anchor);}}
async function synchronizeClock(clock=businessClock,{isDev=config.isDev,onReady}={}){
  return withClockLock(async conn=>{
    const [params]=await conn.execute("SELECT v FROM param WHERE community_id=1 AND k='time_scale'");const raw=params[0]?.v??1,scale=Number(raw);
    if(String(raw).trim()===''||![1,10,60].includes(scale))throw new RangeError('time_scale 不合法');if(!isDev&&scale!==1)throw failure(403,'生产环境不允许时间倍速');
    let anchor=await saved(conn);
    if(anchor&&anchor.scale!==scale)throw new RangeError('时钟基准与 time_scale 不一致，请通过 D3 重设');
    if(!anchor&&scale===1)clock.reset();
    else{
      if(!anchor){const realBase=Date.now();anchor=await writeAnchor(conn,{scale,realBase,businessBase:realBase});}
      restoreLockedClock(clock,anchor);
    }
    // 读取及发布计划也在控制锁内，旧初始化不能覆盖 M8 刚保存的新切点。
    if(onReady)await onReady({dayCutHour:await jobStore.readDayCut(conn)});
    return anchor??clock.snapshot();
  });
}
async function changeScale(personId,scale,{isDev=config.isDev,ownerId=null}={}){
  if(![1,10,60].includes(scale))throw failure(422,'scale 只能是 1 / 10 / 60');if(!isDev&&scale!==1)throw failure(403,'生产环境不允许时间倍速');
  return withClockLock(async conn=>{
    await conn.beginTransaction();try{
      await actor(conn,personId,['admin']);const [owners]=await conn.execute('SELECT IS_USED_LOCK(?) AS owner',[ownerKey()]);
      if(owners[0].owner!==null&&owners[0].owner!==ownerId)throw failure(409,'请在当前托管调度实例上调整时间');
      await conn.execute("SELECT v FROM param WHERE community_id=1 AND k='time_scale' FOR UPDATE");
      const previous=await saved(conn),realBase=Date.now(),businessBase=previous?valueAt(previous,realBase):realBase;
      const anchor=await writeAnchor(conn,{scale,realBase,businessBase});
      await conn.execute("INSERT INTO param (community_id,k,v) VALUES (1,'time_scale',?) ON DUPLICATE KEY UPDATE v=VALUES(v)",[String(scale)]);
      await conn.commit();restoreLockedClock(businessClock,anchor);return {ok:true,scale};
    }catch(error){await conn.rollback();throw error;}
  });
}
async function changeDayCut(personId,raw,{ownerId=null,onChanged}={}){
  const hour=Number(raw);if(!['number','string'].includes(typeof raw)||String(raw).trim()===''||!Number.isInteger(hour)||hour<0||hour>23)throw failure(422,'day_cut_hour 不合法');
  return withClockLock(async conn=>{
    await actor(conn,personId,['admin']);const [owners]=await conn.execute('SELECT IS_USED_LOCK(?) AS owner',[ownerKey()]);
    if(owners[0].owner!==null&&owners[0].owner!==ownerId)throw failure(409,'请在当前托管调度实例修改时刻');
    await conn.execute("INSERT INTO param (community_id,k,v) VALUES (1,'day_cut_hour',?) ON DUPLICATE KEY UPDATE v=VALUES(v)",[String(hour)]);
    if(onChanged)await onChanged(hour);
    return {ok:true,dayCutHour:hour};
  });
}
module.exports={synchronizeClock,changeScale,changeDayCut};

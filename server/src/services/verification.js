/** 回执和承办动作均在同一工单事务内；系统指令不能冒充真人动作。 */
const { queryOne } = require('../db');
const { now } = require('../utils/time');
const { signalTime } = require('../utils/signal-day');
const { canAffectRoute,addMinutes,nextMidnight,settingNumber } = require('../engine/l4');
const { transaction,actor,lockedOrder,routeState,context,event,todo,failure,parse } = require('./routing-store');
const { advanceOrder,staffId } = require('./routing');
const active=order=>!['closed','cancelled'].includes(order.status);
function owns(order,personId){if(order.assignee_id!==personId)throw failure(403,'仅当前承办人可以操作此工单');}
async function requireAgent(personId){return transaction(conn=>actor(conn,personId,['agent']));}
async function ensureCanView(orderId,personId){
  const person=await requireAgent(personId);
  const order=await queryOne('SELECT o.*,e.community_id FROM verify_order o JOIN elder e ON e.id=o.elder_id WHERE o.id=?',[orderId]);
  if(!order)throw failure(404,'核验单不存在');
  if(order.community_id!==person.community_id || (order.assignee_id!==personId && order.source!=='emergency'))throw failure(403,'无权查看此工单');
  return {canAct:order.assignee_id===personId&&active(order)};
}
async function ackNotification(notificationId,personId,result,at=now()){
  const timestamp=signalTime(at);if(!['ok_called','ok_visited','unreachable'].includes(result))throw failure(422,'result 取值不合法');
  const found=await queryOne("SELECT * FROM notification WHERE id=? AND order_type='verify'",[notificationId]);
  if(!found)throw failure(404,'通知不存在');if(found.person_id!==personId)throw failure(403,'无权操作他人的通知');
  return transaction(async conn=>{
    // 先取得业务行锁，再建立一致性视图；等待锁的重试必须看到已提交的前一结果。
    const order=await lockedOrder(conn,found.order_id);
    await actor(conn,personId,['relation','service']);
    const [rows]=await conn.execute('SELECT * FROM notification WHERE id=? FOR UPDATE',[notificationId]);const notification=rows[0];
    if(!notification)throw failure(404,'通知不存在');
    if(notification.ack_at)return {ok:true,escalated:false,duplicated:true};
    await conn.execute('UPDATE notification SET ack_at=?,ack_result=? WHERE id=?',[timestamp,result,notificationId]);
    const state=await routeState(conn,order.id);let escalated=false;
    const effective=canAffectRoute(notification,order,state.activation);
    if(effective && result==='unreachable')escalated=(await advanceOrder(conn,order,timestamp,'primary_unreachable',{force:true})).changed;
    else if(effective){
      const ctx=await context(conn,order.elder_id),assigneeId=staffId(ctx,order.assignee_id??state.plan?.agentId);
      await conn.execute("UPDATE verify_order SET sla_deadline=NULL,status='assigned',assignee_id=? WHERE id=?",[assigneeId,order.id]);
      await event(conn,order.id,null,'handoff',{toPersonId:assigneeId,message:'关系人已确认，等待承办人核验结论'},timestamp);
      if(assigneeId===null)await todo(conn,'verify',order.id,{kind:'no_agent',orderId:order.id,elderId:order.elder_id,message:'已有关系人确认，但没有启用承办人，请管理员协调',needsAction:true},timestamp);
    }
    await event(conn,order.id,personId,'ack',{result,accountable:!!notification.is_accountable,effective},timestamp);
    return {ok:true,escalated};
  });
}
async function recordAction(orderId,personId,action,at=now()){
  if(!['call','visit','escalate'].includes(action))throw failure(422,'action 取值不合法');const timestamp=signalTime(at);
  return transaction(async conn=>{
    const order=await lockedOrder(conn,orderId);await actor(conn,personId,['agent']);owns(order,personId);if(!active(order))throw failure(409,'工单已结束，不能继续执行动作');
    if(action==='escalate'){
      const result=await advanceOrder(conn,order,timestamp,'agent_escalate',{force:true,terminal:true,actorId:personId});
      if(!result.changed)throw failure(409,'已在管理员跟进阶段');
    }else{
      await event(conn,orderId,personId,action,null,timestamp);
      if(order.source!=='emergency')await conn.execute("UPDATE verify_order SET status='assigned',sla_deadline=NULL WHERE id=?",[orderId]);
      else if(action==='visit'){
        const state=await routeState(conn,orderId),phase=state.plan?.phases.find(p=>p.level===order.current_layer);
        if(phase && phase.kind!=='admin'){
          const [started]=await conn.execute("SELECT payload FROM order_event WHERE order_type='verify' AND order_id=? AND action='visit_followup_started' ORDER BY id LIMIT 1",[orderId]);
          let deadline;
          if(started.length)deadline=parse(started[0].payload).deadline;
          else{
            const ctx=await context(conn,order.elder_id);deadline=addMinutes(timestamp,settingNumber(ctx.params,'layer2_wait_min',120));
            if(state.followup?.dueAt && state.followup.dueAt<deadline)deadline=state.followup.dueAt;
            await event(conn,orderId,null,'visit_followup_started',{deadline,firstVisitAt:timestamp},timestamp);
          }
          if(state.followup?.dueAt && state.followup.dueAt<deadline)deadline=state.followup.dueAt;
          await conn.execute("UPDATE verify_order SET status='assigned',sla_deadline=? WHERE id=?",[deadline,orderId]);
        }
      }
    }
    return {ok:true,methodAutoFilled:action==='visit'?'visit':'phone'};
  });
}
async function submitDisposition(orderId,personId,body,at=now()){
  const timestamp=signalTime(at);
  return transaction(async conn=>{
    const order=await lockedOrder(conn,orderId);await actor(conn,personId,['agent']);owns(order,personId);
    const [old]=await conn.execute('SELECT id FROM disposition WHERE order_id=?',[orderId]);if(old.length)return {ok:true,orderId,duplicated:true};
    if(!active(order))throw failure(409,'工单已结束');
    const resultCode=String(body.resultCode||''),method=String(body.method||''),note=body.note==null?null:String(body.note);
    if(!['normal','abnormal_handled','unreachable_escalated','declined','phone_confirmed_not_visited'].includes(resultCode)||!['phone','visit'].includes(method)||note?.length>50)throw failure(422,'结论、方式或备注不合法');
    const [actions]=await conn.execute("SELECT ts FROM order_event WHERE order_type='verify' AND order_id=? AND actor_id IS NOT NULL AND action IN ('call','visit','escalate') ORDER BY ts,id LIMIT 1",[orderId]);
    if(!actions.length)throw failure(409,'请先记录打电话或上门动作');
    if(resultCode==='unreachable_escalated'){
      const result=await advanceOrder(conn,order,timestamp,'agent_unreachable',{force:true,terminal:true,actorId:personId});
      if(!result.changed)throw failure(409,'已转管理员跟进');
      return {ok:true,orderId};
    }
    if(resultCode==='phone_confirmed_not_visited'){
      if(order.source!=='emergency'||method!=='phone')throw failure(422,'此结论只用于紧急单的电话确认');
      const state=await routeState(conn,orderId);if(state.followup)return {ok:true,orderId,duplicated:true};
      const [calls]=await conn.execute("SELECT id FROM order_event WHERE order_type='verify' AND order_id=? AND actor_id IS NOT NULL AND action='call' LIMIT 1",[orderId]);
      if(!calls.length)throw failure(409,'请先记录电话动作');
      const dueAt=nextMidnight(timestamp);
      const phase=state.plan?.phases.find(p=>p.level===order.current_layer);
      const [visits]=await conn.execute("SELECT payload FROM order_event WHERE order_type='verify' AND order_id=? AND action='visit_followup_started' ORDER BY id LIMIT 1",[orderId]);
      const visitDeadline=visits.length?parse(visits[0].payload).deadline:null;
      const deadline=visitDeadline&&visitDeadline<dueAt?visitDeadline:dueAt;
      if(phase?.kind!=='admin')await conn.execute("UPDATE verify_order SET status='assigned',sla_deadline=? WHERE id=?",[deadline,orderId]);
      await event(conn,orderId,personId,'phone_followup',{dueAt,resultCode,method,message:'电话已确认，当日仍必须上门'},timestamp);
      await todo(conn,'verify',orderId,{kind:'visit_followup',orderId,elderId:order.elder_id,dueAt,message:'电话确认未上门，当日午夜前仍需上门确认',needsAction:false},timestamp);
      return {ok:true,orderId};
    }
    if(order.source==='emergency'&&method!=='visit')throw failure(409,'紧急单必须上门确认；电话确认请保留当日上门待办');
    const durationMin=Math.max(0,Math.round((new Date(timestamp.replace(' ','T')+'+08:00')-new Date(actions[0].ts.replace(' ','T')+'+08:00'))/60000));
    const isInvalid=['normal','declined'].includes(resultCode)?1:0;
    await conn.execute('INSERT INTO disposition (order_id,result_code,method,duration_min,note,is_invalid_check,created_by,created_at) VALUES (?,?,?,?,?,?,?,?)',[orderId,resultCode,method,durationMin,note,isInvalid,personId,timestamp]);
    await conn.execute("UPDATE verify_order SET status='closed',closed_at=?,sla_deadline=NULL WHERE id=?",[timestamp,orderId]);
    await event(conn,orderId,personId,'dispose',{resultCode,method,durationMin,isInvalid},timestamp);
    return {ok:true,orderId};
  });
}
async function transferOrder(orderId,personId,toPersonId,reason,at=now()){
  const timestamp=signalTime(at);if(!Number.isSafeInteger(toPersonId)||toPersonId<1||!String(reason||'').trim())throw failure(422,'转单目标和原因必填');
  return transaction(async conn=>{
    const order=await lockedOrder(conn,orderId);await actor(conn,personId,['agent']);await actor(conn,toPersonId,['agent']);owns(order,personId);if(!active(order))throw failure(409,'工单已结束');
    await conn.execute('UPDATE verify_order SET assignee_id=? WHERE id=?',[toPersonId,orderId]);
    await event(conn,orderId,personId,'transfer',{toPersonId,reason:String(reason).trim()},timestamp);
    const state=await routeState(conn,orderId);
    if(state.activation?.kind==='agent')await event(conn,orderId,null,'notify',{layer:order.current_layer,kind:'agent',primaryId:toPersonId,notificationIds:[]},timestamp);
    return {ok:true};
  });
}
module.exports={requireAgent,ensureCanView,ackNotification,recordAction,submitDisposition,transferOrder};

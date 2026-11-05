/** L4 消费、派发和 CAS 升级。外部触达仅为站内记录，不发送短信或外呼。 */
const { pool,query,queryOne } = require('../db');
const { now } = require('../utils/time');
const { signalTime } = require('../utils/signal-day');
const { buildRoutePlan,roles,settingNumber,addMinutes } = require('../engine/l4');
const { COMMUNITY_ID,transaction,audit,event,actor,lockedOrder,context,routeState,todo,parse,failure } = require('./routing-store');
const { createEvidenceRequest,UUID } = require('./evidence-requests');
const openStatuses=['pending','notified','escalated','assigned'];
const enabledWith=(ctx,role)=>ctx.people.filter(p=>p.status===1&&roles(p).includes(role)).sort((a,b)=>a.id-b.id);
function emergencyPromise(delivery){
  if(!delivery || !['notificationIds','agentIds','adminIds'].every(key=>Array.isArray(delivery[key])))return '求助已记录，通知情况需由社区核对，请联系社区确认处理进度';
  const relations=delivery.notificationIds.length,agents=delivery.agentIds.length,admins=delivery.adminIds.length;
  if(!relations&&!agents&&!admins)return '求助已记录，当前没有可用联系人或承办人，请立即联系社区或身边的人协助';
  if(relations&&agents)return '已生成联系人站内通知，并交承办人工作台处理，请稍等';
  if(agents)return '求助已记入承办人工作台，当前暂无可用关系人，请稍等';
  if(admins)return relations?'已生成联系人站内通知，当前无可用承办人，求助已留管理员待办':'当前无可用承办人，求助已留管理员待办，请联系社区协助';
  return '已生成联系人站内通知，当前没有可用社区承办人，请联系社区协助';
}
function staffId(ctx,preferred){const staff=enabledWith(ctx,'agent');return staff.find(p=>p.id===preferred)?.id??staff[0]?.id??null;}
function usablePhase(plan,ctx,after=-1,terminal=false){
  const phases=terminal?[plan.phases.at(-1)]:plan.phases.filter(p=>p.level>after);
  return phases.find(phase=>phase.kind==='admin'||ctx.people.some(p=>p.id===phase.primaryId&&p.status===1&&roles(p).some(role=>phase.kind==='agent'?role==='agent':['relation','service'].includes(role))));
}
async function notifyPhase(conn,order,phase,ctx,at,{broadcast=false}={}){
  const members=broadcast?ctx.relations.filter(r=>r.status===1&&ctx.people.some(p=>p.id===r.person_id&&p.status===1&&roles(p).some(role=>['relation','service','agent','admin'].includes(role))))
    .map(r=>({relationId:r.id,personId:r.person_id,isAccountable:!!r.is_accountable})):phase.members;
  const notificationIds=[];
  for(const member of members){
    if(!ctx.people.some(p=>p.id===member.personId&&p.status===1))continue;
    const [row]=await conn.execute("INSERT INTO notification (order_type,order_id,relation_id,person_id,is_accountable,sent_at) VALUES ('verify',?,?,?,?,?)",[order.id,member.relationId,member.personId,member.isAccountable?1:0,at]);
    notificationIds.push(row.insertId);
  }
  await event(conn,order.id,null,'notify',{layer:phase.level,kind:phase.kind,primaryId:phase.primaryId,notificationIds},at);
  if(phase.kind==='admin')await todo(conn,'verify',order.id,{kind:'admin_handoff',orderId:order.id,elderId:order.elder_id,recipientIds:enabledWith(ctx,'admin').map(p=>p.id),message:phase.primaryId?'工单已转管理员，请人工跟进并协调承办人':'没有启用的承办或管理员，请负责人配置并人工跟进',needsAction:true},at);
  if(broadcast){
    const agentIds=enabledWith(ctx,'agent').map(p=>p.id),adminIds=enabledWith(ctx,'admin').map(p=>p.id);
    const delivery={notificationIds,agentIds,adminIds,requiredActions:['call','visit'],parallel:true};
    delivery.promise=emergencyPromise(delivery);
    await event(conn,order.id,null,'broadcast',delivery,at);
    await event(conn,order.id,null,'instructions',{requiredActions:['call','visit'],parallel:true},at);
    await todo(conn,'verify',order.id,{kind:'emergency_notice',orderId:order.id,elderId:order.elder_id,recipientIds:adminIds,message:agentIds.length?'紧急求助：已要求承办人立即打电话并同时出发，请关注进展':'紧急求助：当前无启用承办人，请管理员立即协调电话和上门',needsAction:phase.kind==='admin'},at);
    return delivery;
  }
  return {notificationIds};
}
async function markLegacy(conn,order,at){
  const [existing]=await conn.execute("SELECT id FROM order_event WHERE order_type='verify' AND order_id=? AND action='routing_review_required' LIMIT 1",[order.id]);
  if(!existing.length){await event(conn,order.id,null,'routing_review_required',{reason:'missing_dispatch_snapshot'},at);await todo(conn,'verify',order.id,{kind:'legacy_review',orderId:order.id,elderId:order.elder_id,message:'旧单缺少派发快照，请管理员核对责任人和截止时间',needsAction:true},at);}
}
async function routePendingAlerts(at=now()){
  const timestamp=signalTime(at);
  return transaction(async conn=>{
    await conn.execute("SELECT id FROM elder WHERE community_id=? AND status='active' AND monitor_level='monitor' ORDER BY id FOR UPDATE",[COMMUNITY_ID]);
    const [alerts]=await conn.execute(`SELECT a.* FROM alert a JOIN elder e ON e.id=a.elder_id
      WHERE e.community_id=? AND e.status='active' AND e.monitor_level='monitor' AND a.cell IN ('strong','insufficient')
      AND NOT EXISTS(SELECT 1 FROM audit_log l WHERE l.action='l4_consumed' AND l.target='alert' AND l.target_id=a.id) ORDER BY a.id`,[COMMUNITY_ID]);
    const results=[];let routed=0,merged=0,evidenceRequests=0;
    for(const alert of alerts){
      const ctx=await context(conn,alert.elder_id),plan=buildRoutePlan(ctx);
      if(alert.cell==='insufficient'){
        const recipientIds=[...new Set(ctx.relations.filter(r=>r.status===1&&ctx.people.some(p=>p.id===r.person_id&&p.status===1&&roles(p).some(role=>['relation','service'].includes(role)))).map(r=>r.person_id))];
        await createEvidenceRequest(conn,alert,recipientIds,timestamp);evidenceRequests++;
        const result={alertId:alert.id,orderId:null,type:'evidence'};results.push(result);await audit(conn,'l4_consumed','alert',alert.id,null,result,timestamp);continue;
      }
      const [existing]=await conn.execute('SELECT * FROM verify_order WHERE alert_id=? ORDER BY id LIMIT 1 FOR UPDATE',[alert.id]);
      if(existing.length){const result={alertId:alert.id,orderId:existing[0].id,type:'existing'};results.push(result);if(!(await routeState(conn,existing[0].id)).plan)await markLegacy(conn,existing[0],timestamp);await audit(conn,'l4_consumed','alert',alert.id,null,result,timestamp);continue;}
      const seconds=settingNumber(ctx.params,'merge_window_sec',30);
      const from=signalTime(new Date(new Date(timestamp.replace(' ','T')+'+08:00').getTime()-seconds*1000));
      const [recent]=await conn.execute("SELECT * FROM verify_order WHERE elder_id=? AND source='alert' AND status IN ('pending','notified','escalated','assigned') AND created_at>=? AND created_at<=? ORDER BY id LIMIT 1 FOR UPDATE",[alert.elder_id,from,timestamp]);
      if(recent.length){
        await event(conn,recent[0].id,null,'merge_alert',{alertId:alert.id,message:'合并窗口内的新依据，保留原通知和截止时间'},timestamp);
        const result={alertId:alert.id,orderId:recent[0].id,type:'merged'};results.push(result);merged++;await audit(conn,'l4_consumed','alert',alert.id,null,result,timestamp);continue;
      }
      const phase=usablePhase(plan,ctx),assigneeId=staffId(ctx,plan.agentId);
      const [created]=await conn.execute("INSERT INTO verify_order (elder_id,alert_id,source,current_layer,status,route_mode,assignee_id,sla_deadline,client_request_id,created_at) VALUES (?,?,'alert',?,?,'relation',?,?,?,?)",
        [alert.elder_id,alert.id,phase.level,phase.kind==='admin'?'escalated':'notified',assigneeId,phase.waitMin===null?null:addMinutes(timestamp,phase.waitMin),'l4:alert:'+alert.id,timestamp]);
      const order={id:created.insertId,elder_id:alert.elder_id,source:'alert'};
      await event(conn,order.id,null,'route_plan',plan,timestamp);await notifyPhase(conn,order,phase,ctx,timestamp);
      const result={alertId:alert.id,orderId:order.id,type:'routed'};results.push(result);routed++;await audit(conn,'l4_consumed','alert',alert.id,null,result,timestamp);
    }
    return {routed,merged,evidenceRequests,results};
  });
}
async function advanceOrder(conn,candidate,at,reason,{force=false,terminal=false,actorId=null}={}){
  const current=await lockedOrder(conn,candidate.id),state=await routeState(conn,candidate.id);
  if(!openStatuses.includes(current.status))return {changed:false};
  if(!state.plan){await markLegacy(conn,current,at);return {changed:false,legacy:true};}
  if(state.plan.phases.find(p=>p.level===current.current_layer)?.kind==='admin')return {changed:false};
  const ctx=await context(conn,current.elder_id),plan=buildRoutePlan(ctx);
  let phase=usablePhase(plan,ctx,candidate.current_layer,terminal||current.source==='emergency');
  const agentActivated=state.activations.some(item=>item?.kind==='agent');
  if(!terminal && current.source!=='emergency' && !agentActivated && (!phase || phase.kind==='admin')){
    const pendingAgent=usablePhase({phases:plan.phases.filter(p=>p.kind==='agent')},ctx);
    if(pendingAgent){
      phase={...pendingAgent,level:Math.max(candidate.current_layer+1,pendingAgent.level)};
      const finalAdmin={...plan.phases.at(-1),level:Math.max(plan.phases.at(-1).level,phase.level+1)};
      plan.phases=plan.phases.filter(p=>p!==pendingAgent&&p.kind!=='admin').concat(phase,finalAdmin).sort((a,b)=>a.level-b.level);
    }
  }
  if(!phase || phase.level<=candidate.current_layer){phase={...plan.phases.at(-1),level:candidate.current_layer+1};plan.phases=plan.phases.filter(p=>p.kind!=='admin').concat(phase);}
  const explicitTransfer=state.transfer?.toPersonId===current.assignee_id;
  const preferred=phase.kind==='agent'&&!explicitTransfer?phase.primaryId:current.assignee_id??plan.agentId;
  const assigneeId=staffId(ctx,preferred),deadline=phase.waitMin===null?null:addMinutes(at,phase.waitMin);
  if(phase.kind==='agent' && phase.primaryId!==assigneeId){phase={...phase,primaryId:assigneeId,members:phase.members.map(member=>({...member,isAccountable:member.personId===assigneeId}))};plan.phases=plan.phases.map(p=>p.level===phase.level?phase:p);}
  const params=[phase.level,assigneeId,deadline,current.id,candidate.current_layer,candidate.sla_deadline,candidate.sla_deadline];
  let predicate='';if(!force){predicate=' AND sla_deadline IS NOT NULL AND sla_deadline<=?';params.push(at);}
  const [updated]=await conn.execute(`UPDATE verify_order SET current_layer=?,assignee_id=?,sla_deadline=?,status='escalated'
    WHERE id=? AND current_layer=? AND status IN ('pending','notified','escalated','assigned')
      AND ((sla_deadline IS NULL AND ? IS NULL) OR sla_deadline=?)${predicate}`,params);
  if(updated.affectedRows===0)return {changed:false};
  await event(conn,current.id,actorId,'escalate',{fromLayer:candidate.current_layer,toLayer:phase.level,reason},at);
  await event(conn,current.id,null,'route_plan',plan,at);await notifyPhase(conn,current,phase,ctx,at);
  return {changed:true,fromLayer:candidate.current_layer,toLayer:phase.level};
}
async function scanSla(at=now()){
  const timestamp=signalTime(at);
  const candidates=await query(`SELECT o.* FROM verify_order o JOIN elder e ON e.id=o.elder_id
    WHERE e.community_id=? AND o.status IN ('pending','notified','escalated','assigned') AND o.sla_deadline IS NOT NULL AND o.sla_deadline<=? ORDER BY o.id`,[COMMUNITY_ID,timestamp]);
  let upgraded=0,legacyReview=0;
  for(const candidate of candidates){const result=await transaction(conn=>advanceOrder(conn,candidate,timestamp,'timeout'));if(result.changed)upgraded++;if(result.legacy)legacyReview++;}
  return {scanned:candidates.length,upgraded,legacyReview};
}
async function createEmergency(personId,clientRequestId,at=now()){
  const key=String(clientRequestId||'').trim(),timestamp=signalTime(at);if(!UUID.test(key))throw failure(422,'clientRequestId 必须为 UUID v4');let elderId;
  try{return await transaction(async conn=>{
    const [elders]=await conn.execute("SELECT id,community_id FROM elder WHERE person_id=? AND status='active' FOR UPDATE",[personId]);
    if(!elders.length)throw failure(404,'未找到您的档案');elderId=elders[0].id;if(elders[0].community_id!==COMMUNITY_ID)throw failure(403,'无权使用其他社区的路由');
    await actor(conn,personId,['resident']);
    const [previous]=await conn.execute('SELECT id,elder_id,source FROM verify_order WHERE client_request_id=?',[key]);
    if(previous.length){
      const saved=previous[0];if(saved.elder_id!==elderId||saved.source!=='emergency')throw failure(409,'请求标识已用于其他操作');
      const [broadcasts]=await conn.execute("SELECT payload FROM order_event WHERE order_type='verify' AND order_id=? AND action='broadcast' ORDER BY id LIMIT 1",[saved.id]);
      const delivery=broadcasts.length?parse(broadcasts[0].payload):null;
      return {orderId:saved.id,promise:delivery?.promise??emergencyPromise(delivery),duplicated:true};
    }
    const ctx=await context(conn,elderId),plan=buildRoutePlan(ctx);const phase=plan.phases.find(p=>p.kind==='agent')||plan.phases.at(-1);
    const assigneeId=staffId(ctx,plan.agentId),deadline=phase.kind==='admin'?null:addMinutes(timestamp,5);
    const [row]=await conn.execute("INSERT INTO verify_order (elder_id,source,current_layer,status,route_mode,assignee_id,sla_deadline,client_request_id,created_at) VALUES (?,'emergency',?,'assigned','relation',?,?,?,?)",[elderId,phase.level,assigneeId,deadline,key,timestamp]);
    const order={id:row.insertId,elder_id:elderId,source:'emergency'};await event(conn,order.id,null,'route_plan',plan,timestamp);const delivery=await notifyPhase(conn,order,phase,ctx,timestamp,{broadcast:true});
    return {orderId:order.id,promise:delivery.promise};
  });}catch(error){if(error.code==='ER_DUP_ENTRY'){const row=await queryOne('SELECT id,elder_id,source FROM verify_order WHERE client_request_id=?',[key]);if(row&&row.elder_id===elderId&&row.source==='emergency'){const broadcast=await queryOne("SELECT payload FROM order_event WHERE order_type='verify' AND order_id=? AND action='broadcast' ORDER BY id LIMIT 1",[row.id]);const delivery=broadcast?parse(broadcast.payload):null;return {orderId:row.id,promise:delivery?.promise??emergencyPromise(delivery),duplicated:true};}throw failure(409,'请求标识已用于其他操作');}throw error;}
}
async function getRoutingSummary(orderId,personId){
  const row=await queryOne('SELECT * FROM verify_order WHERE id=?',[orderId]);const conn=await pool.getConnection();let state;
  try{state=await routeState(conn,orderId);}finally{conn.release();}
  const actions=await query("SELECT DISTINCT action FROM order_event WHERE order_type='verify' AND order_id=? AND actor_id IS NOT NULL AND action IN ('call','visit')",[orderId]);
  const phase=state.plan?.phases.find(p=>p.level===row?.current_layer);
  return {phaseLabel:phase?.kind==='admin'?'管理员跟进':row?.status==='assigned'?'待承办确认':'等待当前层主责',requiredActions:row?.source==='emergency'?['call','visit']:[],parallel:row?.source==='emergency',completedActions:actions.map(r=>r.action),needsVisit:row?.source==='emergency'&&!['closed','cancelled'].includes(row.status),visitDueAt:state.followup?.dueAt??null,canAct:row?.assignee_id===personId&&!['closed','cancelled'].includes(row.status)};
}
async function listRoutingTodos(personId){
  if(personId!==undefined)await transaction(conn=>actor(conn,personId,['admin']));
  const rows=await query(`SELECT a.id,a.target,a.target_id,a.payload,a.ts,e.name AS elderName,o.status
    FROM audit_log a LEFT JOIN verify_order o ON a.target='verify' AND o.id=a.target_id
    LEFT JOIN alert x ON a.target='alert' AND x.id=a.target_id
    JOIN elder e ON e.id=COALESCE(o.elder_id,x.elder_id)
    WHERE a.action='routing_todo' AND e.community_id=? AND (a.target='alert' OR o.status NOT IN ('closed','cancelled')) ORDER BY a.id DESC LIMIT 100`,[COMMUNITY_ID]);
  const out=[];
  for(const row of rows){const value=parse(row.payload);if(row.target==='alert'){const replies=await query("SELECT payload FROM audit_log WHERE action='evidence_responded' AND target='alert' AND target_id=? AND id>?",[row.target_id,row.id]);if(replies.some(reply=>['ok_called','ok_visited'].includes(parse(reply.payload).result)))continue;}out.push({id:row.id,...value,elderName:row.elderName,createdAt:row.ts});}
  return out;
}
module.exports={routePendingAlerts,scanSla,createEmergency,advanceOrder,getRoutingSummary,listRoutingTodos,staffId};

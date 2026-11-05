/** 补证据不创建核验单；请求/回执留审计，原始信号依靠唯一请求键。 */
const { query } = require('../db');
const { now } = require('../utils/time');
const { signalTime,signalDay } = require('../utils/signal-day');
const { transaction,audit,todo,actor,parse,failure,COMMUNITY_ID } = require('./routing-store');
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
async function requireRelation(personId){return transaction(conn=>actor(conn,personId,['relation','service']));}

async function createEvidenceRequest(conn,alert,recipientIds,at) {
  const message='今天还没联系上，您方便看一眼吗';
  await audit(conn,'evidence_requested','alert',alert.id,null,{elderId:alert.elder_id,recipientIds,message},at);
  if(!recipientIds.length)await todo(conn,'alert',alert.id,{kind:'evidence_no_recipient',alertId:alert.id,elderId:alert.elder_id,message:'没有可接收确认请求的关系人，请管理员联系处理',needsAction:true},at);
}
async function listEvidenceRequests(personId) {
  const rows=await query(`SELECT a.target_id AS alertId,a.payload,a.ts,e.id AS elderId,e.name AS elderName
    FROM audit_log a JOIN alert x ON a.target='alert' AND x.id=a.target_id JOIN elder e ON e.id=x.elder_id
    WHERE a.action='evidence_requested' AND e.community_id=? AND e.status='active'
      AND EXISTS(SELECT 1 FROM relation r WHERE r.elder_id=e.id AND r.person_id=? AND r.status=1)
    ORDER BY a.id DESC LIMIT 100`,[COMMUNITY_ID,personId]);
  const out=[];
  for(const row of rows){
    const request=parse(row.payload);if(!request.recipientIds.includes(personId))continue;
    const replies=await query("SELECT actor_id,payload FROM audit_log WHERE action='evidence_responded' AND target='alert' AND target_id=?",[row.alertId]);
    if(replies.some(reply=>reply.actor_id===personId || ['ok_called','ok_visited'].includes(parse(reply.payload).result)))continue;
    out.push({alertId:row.alertId,elderId:row.elderId,elderName:row.elderName,message:request.message,requestedAt:row.ts});
  }
  return out;
}
async function ackEvidence(alertId,personId,body,at=now()) {
  const timestamp=signalTime(at),key=String(body.clientRequestId||'').trim(),result=String(body.result||'');
  if(!UUID.test(key) || !['ok_called','ok_visited','unreachable'].includes(result))throw failure(422,'clientRequestId 或 result 不合法');
  const selected=await query('SELECT elder_id FROM alert WHERE id=?',[alertId]);
  if(!selected.length)throw failure(404,'确认请求不存在');
  try{return await transaction(async conn=>{
    await conn.execute('SELECT id FROM elder WHERE id=? FOR UPDATE',[selected[0].elder_id]);
    await actor(conn,personId,['relation','service']);
    const [alerts]=await conn.execute('SELECT x.*,e.community_id FROM alert x JOIN elder e ON e.id=x.elder_id WHERE x.id=?',[alertId]);
    const alert=alerts[0];if(!alert)throw failure(404,'确认请求不存在');if(alert.community_id!==COMMUNITY_ID)throw failure(403,'无权查看其他社区请求');
    const [requests]=await conn.execute("SELECT payload FROM audit_log WHERE action='evidence_requested' AND target='alert' AND target_id=? ORDER BY id DESC LIMIT 1",[alertId]);
    const [relations]=await conn.execute('SELECT id FROM relation WHERE elder_id=? AND person_id=? AND status=1',[alert.elder_id,personId]);
    if(!requests.length || !relations.length || !parse(requests[0].payload).recipientIds.includes(personId))throw failure(403,'无权回执此确认请求');
    const [oldKeys]=await conn.execute('SELECT elder_id,type,payload FROM signal_event WHERE client_request_id=?',[key]);
    if(oldKeys.length){const payload=parse(oldKeys[0].payload)||{};if(oldKeys[0].elder_id===alert.elder_id && payload.evidenceAlertId===alertId && payload.personId===personId && payload.result===result)return {ok:true,duplicated:true};throw failure(409,'请求标识已用于其他操作');}
    const [params]=await conn.execute("SELECT v FROM param WHERE community_id=? AND k='day_cut_hour'",[COMMUNITY_ID]);
    if(params.length && String(params[0].v).trim()==='')throw failure(422,'day_cut_hour 不能为空');
    const date=signalDay(timestamp,Number(params[0]?.v??4));
    const payload={source:'evidence_response',evidenceAlertId:alertId,personId,result,date};
    await conn.execute('INSERT INTO signal_event (elder_id,type,payload,client_request_id,ts) VALUES (?,?,?,?,?)',[alert.elder_id,result==='unreachable'?'family_unreachable':'family_confirmed',JSON.stringify(payload),key,timestamp]);
    await audit(conn,'evidence_responded','alert',alertId,personId,{result,clientRequestId:key},timestamp);
    if(result==='unreachable')await todo(conn,'alert',alertId,{kind:'evidence_unreachable',alertId,elderId:alert.elder_id,message:'关系人反馈联系不上，请管理员人工跟进',needsAction:true},timestamp);
    return {ok:true,duplicated:false};
  });}catch(error){
    if(error.code==='ER_DUP_ENTRY')throw failure(409,'请求标识已用于其他操作');
    throw error;
  }
}
module.exports={createEvidenceRequest,listEvidenceRequests,ackEvidence,requireRelation,UUID};

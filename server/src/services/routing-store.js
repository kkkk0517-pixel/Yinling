/** L4 事务和留档；所有操作复用调用方连接，避免嵌套连接和部分提交。 */
const { pool } = require('../db');
const { COMMUNITY_ID } = require('../utils/param');
const { roles } = require('../engine/l4');
const parse = value => typeof value === 'string' ? JSON.parse(value) : value;
const failure = (status, message) => Object.assign(new Error(message), { status });
async function transaction(work) {
  const conn = await pool.getConnection();
  try { await conn.beginTransaction(); const value = await work(conn); await conn.commit(); return value; }
  catch (error) { await conn.rollback(); throw error; }
  finally { conn.release(); }
}
async function audit(conn, action, target, targetId, actorId, payload, at) {
  const [row] = await conn.execute('INSERT INTO audit_log (actor_id,action,target,target_id,payload,ts) VALUES (?,?,?,?,?,?)', [actorId,action,target,targetId,JSON.stringify(payload),at]);
  return row.insertId;
}
async function event(conn, orderId, actorId, action, payload, at) {
  const [row] = await conn.execute("INSERT INTO order_event (order_type,order_id,actor_id,action,payload,ts) VALUES ('verify',?,?,?,?,?)", [orderId,actorId,action,payload===null?null:JSON.stringify(payload),at]);
  return row.insertId;
}
async function actor(conn, personId, required) {
  const [rows] = await conn.execute('SELECT id,status,functions,community_id FROM person WHERE id=?',[personId]);
  const person=rows[0];
  if(!person || person.status!==1 || person.community_id!==COMMUNITY_ID || !roles(person).some(role=>required.includes(role))) throw failure(403,'无权操作或账号已停用');
  return person;
}
async function lockedOrder(conn,id) {
  const [rows]=await conn.execute('SELECT * FROM verify_order WHERE id=? FOR UPDATE',[id]);
  if(!rows.length)throw failure(404,'核验单不存在');
  const [elders]=await conn.execute('SELECT community_id FROM elder WHERE id=?',[rows[0].elder_id]);
  if(elders[0]?.community_id!==COMMUNITY_ID)throw failure(403,'无权操作其他社区工单');
  return rows[0];
}
async function context(conn,elderId) {
  const [people]=await conn.execute('SELECT id,status,functions,community_id FROM person WHERE community_id=? ORDER BY id',[COMMUNITY_ID]);
  const [relations]=await conn.execute('SELECT id,person_id,level,status,is_accountable,priority FROM relation WHERE elder_id=? ORDER BY level,priority,id',[elderId]);
  const [rows]=await conn.execute('SELECT k,v FROM param WHERE community_id=?',[COMMUNITY_ID]);
  return {people,relations,params:Object.fromEntries(rows.map(row=>[row.k,row.v]))};
}
async function routeState(conn,orderId) {
  const [rows]=await conn.execute("SELECT action,payload FROM order_event WHERE order_type='verify' AND order_id=? AND action IN ('route_plan','notify','phone_followup','transfer') ORDER BY id",[orderId]);
  let plan=null,activation=null,followup=null,transfer=null;const activations=[];
  for(const row of rows){const value=parse(row.payload);if(row.action==='route_plan' && value?.version==='l4-routing-v1')plan=value;else if(row.action==='notify'){activation=value;activations.push(value);}else if(row.action==='phone_followup')followup=value;else if(row.action==='transfer')transfer=value;}
  return {plan,activation,activations,followup,transfer};
}
async function todo(conn,target,targetId,payload,at) {
  return audit(conn,'routing_todo',target,targetId,null,payload,at);
}
module.exports={COMMUNITY_ID,parse,failure,transaction,audit,event,actor,lockedOrder,context,routeState,todo};

/** L4 计划和时间计算；不写数据库，不推断人已执行动作。 */
const { signalTime } = require('../utils/signal-day');
function roles(person) {
  if (Array.isArray(person?.functions)) return person.functions;
  try { const value = JSON.parse(person?.functions || '[]'); return Array.isArray(value) ? value : []; } catch { return []; }
}
function settingNumber(params, key, fallback, max = Number.MAX_SAFE_INTEGER) {
  const raw = params[key];
  if (raw !== undefined && (raw === null || String(raw).trim() === '')) throw new RangeError(key + ' 不能为空');
  const value = Number(raw === undefined ? fallback : raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new RangeError(key + ' 必须为有效正整数');
  return value;
}
function buildRoutePlan({ relations = [], people = [], params = {} }) {
  if ((params.route_mode ?? 'relation') !== 'relation') throw new RangeError('本版仅支持 relation 路由，不回退其他模式');
  const layerCount = settingNumber(params, 'layer_count', 3, 4);
  const waits = {};
  for (let level = 1; level <= 4; level += 1) waits[level] = settingNumber(params, `layer${level}_wait_min`, level === 1 ? 15 : 120);
  const enabled = [...people].filter(person => person.status === 1).sort((a,b)=>a.id-b.id);
  const byId = new Map(enabled.map(person => [Number(person.id), person]));
  const groups = new Map();
  for (const row of relations) {
    if (row.status !== 1 || !Number.isInteger(row.level) || row.level < 1 || row.level > layerCount) continue;
    if (!groups.has(row.level)) groups.set(row.level, []);
    const person = byId.get(Number(row.person_id));
    if (!person || !roles(person).some(role=>['relation','service','agent','admin'].includes(role))) continue;
    groups.get(row.level).push({ relationId: row.id, personId: row.person_id, isAccountable: !!row.is_accountable, priority: row.priority || 0 });
  }
  const phases = [], skips = [], configuredAdmins = [];
  for (const [level, members] of [...groups].sort((a,b)=>a[0]-b[0])) {
    members.sort((a,b)=>a.priority-b.priority || a.relationId-b.relationId);
    const primary = members.filter(member=>member.isAccountable);
    if (primary.length !== 1) { skips.push({level,reason:primary.length?'multiple_primary':'missing_primary'}); continue; }
    const functions = roles(byId.get(Number(primary[0].personId)));
    const kind = functions.some(role=>['relation','service'].includes(role)) ? 'relation' : functions.includes('agent') ? 'agent' : 'admin';
    const phase = { level, kind, primaryId: primary[0].personId, members, waitMin: kind === 'admin' ? null : waits[level] };
    if (kind === 'admin') configuredAdmins.push(phase); else phases.push(phase);
  }
  if (!groups.has(1)) skips.push({level:1,reason:'no_members'});
  const agentId = phases.find(phase=>phase.kind==='agent')?.primaryId ?? enabled.find(person=>roles(person).includes('agent'))?.id ?? null;
  let lastLevel = Math.max(1,...phases.map(phase=>phase.level),...skips.map(skip=>skip.level));
  if (!phases.some(phase=>phase.kind==='agent') && agentId !== null) {
    phases.push({level:++lastLevel,kind:'agent',primaryId:agentId,members:[],waitMin:waits[2]});
  }
  const configuredAdmin = configuredAdmins[0];
  const adminId = configuredAdmin?.primaryId ?? enabled.find(person=>roles(person).includes('admin'))?.id ?? null;
  const adminLevel = Math.max(lastLevel+1, configuredAdmin?.level || 0);
  phases.push({level:adminLevel,kind:'admin',primaryId:adminId,members:configuredAdmin?.members || [],waitMin:null});
  return { version:'l4-routing-v1', phases, skips, agentId, adminId, staffWaitMin:waits[2] };
}
function addMinutes(at, minutes) {
  if (!Number.isFinite(minutes) || minutes < 0) throw new RangeError('时限不合法');
  const time = new Date(signalTime(at).replace(' ','T') + '+08:00').getTime() + minutes*60000;
  return signalTime(new Date(time));
}
function nextMidnight(at) {
  const date = signalTime(at).slice(0,10);
  return new Date(new Date(date+'T00:00:00Z').getTime()+86400000).toISOString().slice(0,10)+' 00:00:00';
}
function canAffectRoute(notification, order, activation) {
  return !!activation && order.source !== 'emergency' && ['notified','escalated'].includes(order.status)
    && activation.layer === order.current_layer && activation.primaryId === notification.person_id
    && !!notification.is_accountable && activation.notificationIds.includes(notification.id);
}
module.exports = { roles, settingNumber, buildRoutePlan, addMinutes, nextMidnight, canAffectRoute };

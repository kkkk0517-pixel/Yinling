const test = require('node:test');
const assert = require('node:assert/strict');
let l4 = {};
try { l4 = require('../src/engine/l4'); } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; }
const people = [
  { id: 2, status: 1, functions: ['relation'] }, { id: 3, status: 1, functions: ['relation'] },
  { id: 5, status: 1, functions: ['agent'] }, { id: 6, status: 1, functions: ['admin'] },
];
const relations = [
  { id: 1, person_id: 2, level: 1, status: 1, is_accountable: 1, priority: 1 },
  { id: 2, person_id: 3, level: 1, status: 1, is_accountable: 0, priority: 2 },
];
function plan(extra = {}) {
  assert.equal(typeof l4.buildRoutePlan, 'function', 'L4 planner is implemented');
  return l4.buildRoutePlan({ relations, people, params: { layer_count: '3', layer1_wait_min: '15', layer2_wait_min: '120', route_mode: 'relation' }, ...extra });
}

test('configured primary and followers remain distinct, with agent and admin fallback', () => {
  const result = plan();
  assert.deepEqual(result.phases.map(p => [p.level,p.kind,p.primaryId]), [[1,'relation',2],[2,'agent',5],[3,'admin',6]]);
  assert.equal(result.phases[0].waitMin, 15);
  assert.equal(result.phases[1].waitMin, 120);
  assert.equal(result.phases[2].waitMin, null);
  assert.deepEqual(result.phases[0].members.map(m => m.isAccountable), [true,false]);
});
test('a layer without a unique active primary is skipped without promoting a follower', () => {
  for (const entries of [relations.map(r => ({...r,is_accountable:0})), relations.map(r=>({...r,is_accountable:1}))]) {
    const result = plan({ relations: entries });
    assert.equal(result.phases[0].kind, 'agent');
    assert.ok(result.skips.some(s => s.level === 1));
  }
});
test('disabled people are unavailable and fallback selection is stable by person ID', () => {
  const result = plan({ people: [...people.map(p=>p.id===2?{...p,status:0}:p), {id:9,status:1,functions:['agent']}] });
  assert.equal(result.phases[0].primaryId, 5);
  assert.equal(result.agentId, 5);
});
test('four configured layers are retained before an unconfigured community fallback', () => {
  const result = plan({ relations: [...relations,{id:3,person_id:8,level:4,status:1,is_accountable:1,priority:1}],
    people:[...people,{id:8,status:1,functions:['relation']}], params:{layer_count:'4',route_mode:'relation'} });
  assert.deepEqual(result.phases.map(p=>p.level),[1,4,5,6]);
});
test('a configured agent is used rather than appending a duplicate agent phase', () => {
  const result = plan({ relations:[...relations,{id:3,person_id:5,level:2,status:1,is_accountable:1,priority:1}] });
  assert.deepEqual(result.phases.map(p=>p.kind),['relation','agent','admin']);
  assert.equal(result.agentId,5);
});
test('without any enabled staff, an unassigned admin terminal remains explicit', () => {
  const result = plan({ relations:[], people:[] });
  assert.equal(result.phases.at(-1).kind,'admin');
  assert.equal(result.phases.at(-1).primaryId,null);
});
test('invalid SLA or routing configuration fails explicitly', () => {
  assert.equal(typeof l4.buildRoutePlan,'function');
  for (const params of [{layer1_wait_min:''},{layer1_wait_min:'0'},{layer1_wait_min:'-1'},{layer_count:'5'},{route_mode:'distance'}]) {
    assert.throws(()=>plan({params:{layer_count:'3',route_mode:'relation',...params}}));
  }
});
test('SLA addition and natural-day midnight use UTC+8 across dates', () => {
  assert.equal(typeof l4.addMinutes,'function');
  assert.equal(l4.addMinutes('2026-11-05 23:55:00',15),'2026-11-06 00:10:00');
  assert.equal(l4.nextMidnight('2026-11-05 00:01:00'),'2026-11-06 00:00:00');
});
test('only the active-layer primary notification may affect ordinary routing', () => {
  assert.equal(typeof l4.canAffectRoute,'function');
  const order={current_layer:1,status:'notified',source:'alert'};
  const activation={layer:1,primaryId:2,notificationIds:[10,11]};
  assert.equal(l4.canAffectRoute({id:10,person_id:2,is_accountable:1},order,activation),true);
  assert.equal(l4.canAffectRoute({id:11,person_id:3,is_accountable:0},order,activation),false);
  assert.equal(l4.canAffectRoute({id:10,person_id:2,is_accountable:1},{...order,current_layer:2},activation),false);
  assert.equal(l4.canAffectRoute({id:10,person_id:2,is_accountable:1},{...order,status:'closed'},activation),false);
});
test('relation receipts never cancel emergency response obligations', () => {
  assert.equal(typeof l4.canAffectRoute,'function');
  assert.equal(l4.canAffectRoute({id:10,person_id:2,is_accountable:1},{current_layer:1,status:'notified',source:'emergency'},
    {layer:1,primaryId:2,notificationIds:[10]}),false);
});

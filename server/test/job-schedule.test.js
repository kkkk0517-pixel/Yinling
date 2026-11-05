const test=require('node:test');
const assert=require('node:assert/strict');
let schedule={};
try{schedule=require('../src/jobs/schedule');}catch(error){if(error.code!=='MODULE_NOT_FOUND')throw error;}
function period(id,at,options){assert.equal(typeof schedule.periodAt,'function','job calendar calculation is implemented');return schedule.periodAt(id,at,options);}

for(const [id,at,dueAt,nextAt] of [
  ['T1','2026-11-05 03:59:59','2026-11-04 04:00:00','2026-11-05 04:00:00'],
  ['T1','2026-11-05 04:00:00','2026-11-05 04:00:00','2026-11-06 04:00:00'],
  ['T3','2026-11-05 02:59:59','2026-11-04 03:00:00','2026-11-05 03:00:00'],
  ['T3','2026-11-05 03:00:00','2026-11-05 03:00:00','2026-11-06 03:00:00'],
  ['T2','2026-11-05 10:00:29','2026-11-05 10:00:00','2026-11-05 10:00:30'],
  ['T2','2026-11-05 10:00:30','2026-11-05 10:00:30','2026-11-05 10:01:00'],
  ['T4','2026-11-05 10:59:59','2026-11-05 10:00:00','2026-11-05 11:00:00'],
  ['T4','2026-12-31 23:59:59','2026-12-31 23:00:00','2027-01-01 00:00:00'],
]){
  test(`${id} at ${at} identifies its latest due period and next boundary`,()=>{
    const result=period(id,at);assert.equal(result.dueAt,dueAt);assert.equal(result.nextAt,nextAt);assert.equal(typeof result.key,'string');
  });
}
test('daily cut, baseline hour and interval settings change boundaries without changing UTC+8 meaning',()=>{
  assert.equal(period('T1','2026-11-05 05:59:59',{dayCutHour:6}).dueAt,'2026-11-04 06:00:00');
  assert.equal(period('T3','2026-11-05 04:59:59',{baselineHour:5}).nextAt,'2026-11-05 05:00:00');
  assert.equal(period('T2','2026-11-05 10:00:19',{slaSeconds:10}).nextAt,'2026-11-05 10:00:20');
  assert.equal(period('T4','2026-11-05 10:19:00',{stratifyMinutes:15}).nextAt,'2026-11-05 10:30:00');
});
test('a UTC instant and the corresponding UTC+8 instant identify the same period',()=>{
  assert.deepEqual(period('T1','2026-11-04T20:00:00Z'),period('T1','2026-11-05 04:00:00'));
});
test('a schedule setting change cannot reuse the previous period identity',()=>{
  assert.notEqual(period('T2','2026-11-05 10:00:00',{slaSeconds:30}).key,period('T2','2026-11-05 10:00:00',{slaSeconds:60}).key);
});
test('invalid time, unknown task and malformed settings are rejected',()=>{
  assert.equal(typeof schedule.periodAt,'function');
  for(const [id,at,options] of [['T5','2026-11-05 10:00:00',{}],['T1','invalid',{}],['T1','2026-11-05 10:00:00',{dayCutHour:24}],['T3','2026-11-05 10:00:00',{baselineHour:''}],['T2','2026-11-05 10:00:00',{slaSeconds:0}],['T4','2026-11-05 10:00:00',{stratifyMinutes:1.5}]])assert.throws(()=>schedule.periodAt(id,at,options));
});

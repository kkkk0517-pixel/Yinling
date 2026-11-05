const test=require('node:test');
const assert=require('node:assert/strict');
let clocks={};try{clocks=require('../src/utils/business-clock');}catch(e){if(e.code!=='MODULE_NOT_FOUND')throw e;}
function fixture(){assert.equal(typeof clocks.createBusinessClock,'function');let real=new Date('2026-11-05T10:00:00+08:00').getTime();const clock=clocks.createBusinessClock({realNow:()=>real});return {clock,advance:n=>{real+=n;},real:()=>real};}
test('default business time is real UTC+8 time',()=>{const f=fixture();assert.equal(f.clock.now(),'2026-11-05 10:00:00');f.advance(1000);assert.equal(f.clock.now(),'2026-11-05 10:00:01');});
test('1/60/10/1 transitions preserve continuity while changing only elapsed-time rate',()=>{
  const f=fixture();f.clock.change(60);f.advance(1000);assert.equal(f.clock.now(),'2026-11-05 10:01:00');
  f.clock.change(10);assert.equal(f.clock.now(),'2026-11-05 10:01:00');f.advance(1000);assert.equal(f.clock.now(),'2026-11-05 10:01:10');
  f.clock.change(1);assert.equal(f.clock.now(),'2026-11-05 10:01:10');f.advance(1000);assert.equal(f.clock.now(),'2026-11-05 10:01:11');
});
test('a persisted anchor continues across process replacement and downtime',()=>{const f=fixture();f.clock.change(60);const saved=f.clock.snapshot();f.advance(2000);const next=clocks.createBusinessClock({realNow:f.real});next.apply(saved);assert.equal(next.now(),'2026-11-05 10:02:00');});
test('an older revision cannot overwrite a newer clock transition',()=>{const f=fixture();f.clock.change(60);const old=f.clock.snapshot();f.clock.change(10);const latest=f.clock.snapshot();assert.equal(f.clock.apply(old),false);assert.deepEqual(f.clock.snapshot(),latest);});
test('malformed scale and anchors are rejected without changing the clock',()=>{const f=fixture();const before=f.clock.snapshot();for(const scale of [0,2,NaN,'60'])assert.throws(()=>f.clock.change(scale));assert.throws(()=>f.clock.apply({revision:2,scale:60,realBase:NaN,businessBase:0}));assert.deepEqual(f.clock.snapshot(),before);});
test('a repeated scale change does not jump the current business time',()=>{const f=fixture();f.clock.change(60);f.advance(1000);const before=f.clock.nowMs();f.clock.change(60);assert.equal(f.clock.nowMs(),before);});
test('maintenance reset restores the real-time epoch',()=>{const f=fixture();f.clock.change(60);f.advance(1000);f.clock.reset();assert.equal(f.clock.now(),'2026-11-05 10:00:01');assert.equal(f.clock.snapshot().scale,1);});
test('snapshots are independent objects',()=>{const f=fixture();const copy=f.clock.snapshot();copy.scale=60;assert.equal(f.clock.snapshot().scale,1);});

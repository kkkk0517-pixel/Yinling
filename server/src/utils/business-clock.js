/** 唯一业务时钟。真实时间只在此换算倍率；执行健康使用独立真实时间。 */
const {signalTime}=require('./signal-day');
function validate(snapshot){
  if(!snapshot||!Number.isSafeInteger(snapshot.revision)||snapshot.revision<0||![1,10,60].includes(snapshot.scale)||!Number.isFinite(snapshot.realBase)||!Number.isFinite(snapshot.businessBase))throw new RangeError('业务时钟基准不合法');
}
function valueAt(snapshot,realAt){validate(snapshot);if(!Number.isFinite(realAt))throw new RangeError('真实时间不合法');return snapshot.businessBase+(realAt-snapshot.realBase)*snapshot.scale;}
function createBusinessClock({realNow=()=>Date.now()}={}){
  let state={revision:0,scale:1,realBase:0,businessBase:0};
  function nowMs(){return valueAt(state,realNow());}
  function apply(snapshot){validate(snapshot);if(snapshot.revision<state.revision)return false;state={...snapshot};return true;}
  function change(scale){if(![1,10,60].includes(scale))throw new RangeError('scale 不合法');const realBase=realNow();const businessBase=valueAt(state,realBase);apply({revision:state.revision+1,scale,realBase,businessBase});return {...state};}
  return {nowMs,now:()=>signalTime(new Date(nowMs())),apply,change,snapshot:()=>({...state}),reset:()=>{state={revision:0,scale:1,realBase:0,businessBase:0};}};
}
const businessClock=createBusinessClock();
module.exports={createBusinessClock,businessClock,valueAt,validate};

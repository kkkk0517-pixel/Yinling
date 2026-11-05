const test=require('node:test');const assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');const path=require('node:path');const os=require('node:os');const {randomUUID}=require('node:crypto');
function config(patch={}){
  const env={...process.env,NODE_ENV:'test',JWT_SECRET:randomUUID()};for(const key of Object.keys(env))if(/^JOBS?_/.test(key))delete env[key];Object.assign(env,patch);
  return spawnSync(process.execPath,['-e',`process.stdout.write(JSON.stringify(require(${JSON.stringify(path.join(__dirname,'../src/config.js'))}).jobs))`],{env,cwd:os.tmpdir(),encoding:'utf8'});
}
test('job defaults enable managed scheduling with the agreed frequencies',()=>{
  const result=config();assert.equal(result.status,0,result.stderr);assert.deepEqual(JSON.parse(result.stdout),{enabled:true,pollMs:250,retryMs:30000,slaSeconds:30,baselineHour:3,stratifyMinutes:60});
});
test('explicit disable and valid frequency overrides are honored including midnight',()=>{
  const result=config({JOBS_ENABLED:'false',JOB_POLL_MS:'10',JOB_RETRY_MS:'20',JOB_T2_INTERVAL_SEC:'5',JOB_T3_HOUR:'0',JOB_T4_INTERVAL_MIN:'15'});
  assert.equal(result.status,0,result.stderr);assert.deepEqual(JSON.parse(result.stdout),{enabled:false,pollMs:10,retryMs:20,slaSeconds:5,baselineHour:0,stratifyMinutes:15});
});
test('ambiguous enable flags and invalid frequency values fail before launching the service',()=>{
  for(const patch of [{JOBS_ENABLED:''},{JOBS_ENABLED:'0'},{JOB_POLL_MS:'0'},{JOB_RETRY_MS:'-1'},{JOB_T2_INTERVAL_SEC:'NaN'},{JOB_T3_HOUR:'24'},{JOB_T4_INTERVAL_MIN:''}]){
    const result=config(patch);assert.notEqual(result.status,0);assert.match(result.stderr,/RangeError/);
  }
});

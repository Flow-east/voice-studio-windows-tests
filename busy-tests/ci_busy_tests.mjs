import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { release } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') throw Error('Native Windows is required');
const here = dirname(fileURLToPath(import.meta.url));
const baselineDir = resolve(process.argv[2] || 'released-0.2.4');
const candidateDir = resolve(process.argv[3] || 'candidate-package');
const results = [];
const checks = [];
function run(packageDir, version, role, mode) {
  const host = spawnSync(process.execPath, [join(here,'native_busy_host.mjs'),packageDir,role,mode],
    {encoding:'utf8',timeout:25000,maxBuffer:256*1024});
  assert.equal(host.error, undefined, `${version} ${role} ${mode} host start/timeout failure`);
  assert.equal(host.status, 0, `${version} ${role} ${mode} host did not exit cleanly`);
  const result = {version,...JSON.parse(host.stdout.trim())}; results.push(result);
  assert.equal(result.realFileShareNone,true); assert.equal(result.lockReady,true);
  assert.equal(result.workerClosed,true); assert.equal(result.workerAlive,false);
  assert.equal(result.workerAliveAfterCleanup,false); assert.equal(result.lockReleasedAfterCleanup,true);
  assert.equal(result.cachedBytesUnchanged,true); assert.equal(result.terminationFailed,false);
  assert.equal(result.childCleared,true); assert.equal(result.stopCleared,true);
  return result;
}
function check(label, fn) {
  try { fn(); checks.push({label,passed:true}); }
  catch(error) { checks.push({label,passed:false,errorName:error.name,
    ...(typeof error.operator==='string'?{assertion:error.operator}:{}),
    ...(typeof error.code==='string'?{code:error.code}:{}),
    message:'Scenario assertion failed; inspect its structured result'}); }
}
for (const role of ['setup-log','setup-state']) {
  check(`0.2.4 ${role} transient`, ()=>{
    const baseline = run(baselineDir,'0.2.4',role,'transient');
    assert.equal(baseline.fulfilled,false); assert.equal(baseline.rejected,true);
    // Observe the actual Windows mapping for rename separately; do not assume
    // every operation reports the same sharing-violation errno as open.
    assert.ok(Number.isInteger(baseline.errno));
    if(role==='setup-log') { assert.equal(baseline.errno,-4082); assert.equal(baseline.errorCode,'UNKNOWN'); }
    assert.equal(baseline.workerCompleted,false);
    assert.ok(baseline.elapsedMs<1500,'Baseline must abort during the transient lock');
  });
}
for (const role of ['setup-log','setup-state']) {
  check(`candidate ${role} transient`, ()=>{
    const recovered = run(candidateDir,'candidate',role,'transient');
    assert.equal(recovered.fulfilled,true); assert.equal(recovered.rejected,false);
    assert.equal(recovered.workerCompleted,true); assert.equal(recovered.workerExitCode,0);
    assert.equal(recovered.progressPhase,'downloading'); assert.equal(recovered.persistedProgressPhase,'downloading');
    for (const key of ['capturedConnecting','capturedDownloading','capturedWorkerCompletion','logContainsConnecting','logContainsDownloading','logContainsWorkerCompletion']) {
      assert.equal(recovered[key],true, `Recovered ${role} must retain ${key}`);
    }
    assert.ok(recovered.elapsedMs>=1000 && recovered.elapsedMs<7000,'Transient lock should recover within bounded retry');
  });
  check(`candidate ${role} persistent`, ()=>{
    const blocked = run(candidateDir,'candidate',role,'persistent');
    assert.equal(blocked.fulfilled,false); assert.equal(blocked.rejected,true); assert.equal(blocked.workerCompleted,false);
    assert.ok(blocked.elapsedMs>=2000 && blocked.elapsedMs<7000,'Persistent sharing conflict should stop before generic command timeout');
    assert.equal(blocked.errno,-4082);
    assert.ok(['FILE_IN_USE','RESOURCE_BUSY'].includes(blocked.errorCode),JSON.stringify(blocked));
    const details = blocked.diagnostic?.details || [];
    assert.ok(details.includes('errnoNumber=-4082'),JSON.stringify(blocked));
    assert.ok(details.includes('errno=EBUSY'),JSON.stringify(blocked));
    assert.ok(details.includes('fileRole='+(role==='setup-log'?'setup-log':'engine-state')),JSON.stringify(blocked));
    assert.ok(details.some(value=>/^syscall=(open|rename|write)$/.test(value)),JSON.stringify(blocked));
    assert.doesNotMatch(JSON.stringify(blocked.diagnostic),/voice-native-busy-|SYNTHETIC_|[A-Za-z]:\\/);
  });
}
const report = {platform:process.platform,osRelease:release(),node:process.version,
  nativeExclusiveFileSharing:true,modelWeightsDownloaded:false,passed:checks.every(item=>item.passed),
  scenarios:checks.length,pass:checks.filter(item=>item.passed).length,fail:checks.filter(item=>!item.passed).length,
  checks,results};
writeFileSync('native-busy-result.json',JSON.stringify(report,null,2)+'\n');
console.log('NATIVE_BUSY_RESULT_JSON\n'+JSON.stringify(report,null,2));
if(!report.passed) process.exitCode=1;

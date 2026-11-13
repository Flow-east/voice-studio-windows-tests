import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {release} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
if(process.platform!=='win32')throw Error('Native Windows required');
const here=dirname(fileURLToPath(import.meta.url));
const baselineDir=resolve(process.argv[2]||'released-state'),candidateDir=resolve(process.argv[3]||'candidate-package');
const results=[],checks=[];
function run(dir,version,mode){
 const host=spawnSync(process.execPath,[join(here,'native_state_host.mjs'),dir,mode],{encoding:'utf8',timeout:40000,maxBuffer:512*1024});
 assert.equal(host.error,undefined,`${version} ${mode} host timeout`);
 assert.equal(host.status,0,`${version} ${mode} host failed: ${host.stderr}`);
 const result={version,...JSON.parse(host.stdout.trim())};results.push(result);
 for(const key of ['nativeFileShareNone','lockReady','workerClosed','cachedBytesUnchanged','childCleared','stopCleared','busyCleared','lockReleasedAfterCleanup'])assert.equal(result[key],true,key);
 for(const key of ['workerAlive','workerAliveAfterCleanup','terminationFailed','lockReleasedAtSettlement','pending','timer','action','cancelTimer','timerAfterSettlement','pendingAfterSettlement'])assert.equal(result[key],false,key);
 return result;
}
function check(label,fn){try{fn();checks.push({label,passed:true});}catch(error){checks.push({label,passed:false,errorName:error.name,...(typeof error.operator==='string'?{assertion:error.operator}:{}),message:error.message.slice(0,1500)});}}
check('published 0.2.5 persistent state lock aborts otherwise healthy worker',()=>{
 const r=run(baselineDir,'0.2.5','success');
 assert.equal(r.fulfilled,false);assert.equal(r.rejected,true);assert.equal(r.workerCompleted,false);assert.equal(r.state,'failed');
 assert.ok(['FILE_IN_USE','PERMISSION_DENIED'].includes(r.diagnostic?.code));
 assert.ok(r.diagnostic.details.includes('fileRole=engine-state'));assert.ok(r.diagnostic.details.includes('syscall=rename'));
 assert.ok(r.elapsedMs>=2800&&r.elapsedMs<12000);
});
check('candidate persistent state lock permits verified preparation; unlock saves and clears warning',()=>{
 const r=run(candidateDir,'candidate','success');
 assert.equal(r.fulfilled,true);assert.equal(r.rejected,false);assert.equal(r.workerCompleted,true);assert.equal(r.workerExitCode,0);
 assert.deepEqual(r.progressEvents,['connecting','downloading','validating']);
 for(const key of ['capturedWorkerCompletion','logContainsCompletion','ready','warningAccessorIsolated','writerCleanAfterRecovery'])assert.equal(r[key],true,key);
 for(const key of ['state','status','reloadedStatusBeforeRecovery','persistedStateAfterRecovery'])assert.equal(r[key],'ready',key);
 assert.equal(r.persistedStateBeforeRecovery,'preparing');assert.equal(r.warningAfterRecovery,null);
 assert.equal(r.warning?.code,'STATE_PERSISTENCE_DEGRADED');
 assert.ok(r.warning.details.includes('fileRole=engine-state'));assert.ok(r.warning.details.includes('syscall=rename'));
 assert.ok(r.warning.details.some(v=>['errno=EPERM','errno=EBUSY'].includes(v)));
 assert.doesNotMatch(JSON.stringify(r.warning),/voice-native-state-|SYNTHETIC_|[A-Za-z]:\\/);
 assert.equal(r.readyAfterModelRemoval,false);assert.equal(r.statusAfterModelRemoval,'missing');
 assert.ok(r.elapsedMs>=4500&&r.elapsedMs<20000);
});
check('candidate preserves worker checksum failure during persistent state lock',()=>{
 const r=run(candidateDir,'candidate','worker-failure');
 assert.equal(r.fulfilled,false);assert.equal(r.rejected,true);assert.equal(r.workerCompleted,true);assert.equal(r.workerExitCode,17);
 assert.equal(r.diagnostic?.code,'MODEL_DOWNLOAD_CHECKSUM');assert.equal(r.state,'failed');assert.equal(r.status,'failed');
 assert.equal(r.ready,false);assert.equal(r.warning?.code,'STATE_PERSISTENCE_DEGRADED');
 assert.equal(r.logContainsWorkerFailure,true);assert.equal(r.persistedStateAfterRecovery,'failed');assert.equal(r.warningAfterRecovery,null);assert.equal(r.writerCleanAfterRecovery,true);
});
check('candidate cancellation during real state lock drains retries and stops worker',()=>{
 const r=run(candidateDir,'candidate','cancel');
 assert.equal(r.fulfilled,false);assert.equal(r.rejected,true);assert.equal(r.workerCompleted,false);assert.equal(r.diagnostic?.code,'USER_CANCELLED');
 assert.equal(r.state,'missing');assert.equal(r.ready,false);assert.equal(r.warning,null);assert.ok(r.elapsedMs<4500);
});
const report={platform:process.platform,osRelease:release(),node:process.version,nativeExclusiveFileSharing:true,modelWeightsDownloaded:false,syntheticModelMarkers:true,
 passed:checks.every(x=>x.passed),scenarios:checks.length,pass:checks.filter(x=>x.passed).length,fail:checks.filter(x=>!x.passed).length,checks,results};
writeFileSync('native-state-result.json',JSON.stringify(report,null,2)+'\n');
console.log('NATIVE_STATE_RESULT_JSON\n'+JSON.stringify(report,null,2));if(!report.passed)process.exitCode=1;

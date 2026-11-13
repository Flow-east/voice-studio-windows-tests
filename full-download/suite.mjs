import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
const results=[],checks=[];
const roles=[['published0.2.6','released-0.2.6'],...(existsSync('full-download-candidate/package.json')?[['candidate','full-download-candidate']]:[])];
for(const[role,path]of roles)for(const mode of process.argv.includes('--final')&&role==='published0.2.6'?['partial']:(process.argv.includes('--final')?['fast','slow','partial','fallback','cached','state-locked']:['fast','slow','partial','fallback','cached'])){
 const label=role+' '+mode;
 try{
  const host=spawnSync(process.execPath,['full-download/host.mjs',path,mode],{encoding:'utf8',timeout:90000,maxBuffer:4*1024*1024});
  assert.equal(host.error,undefined);assert.equal(host.status,0,host.stderr);
  const result={role,...JSON.parse(host.stdout.trim())};results.push(result);
  assert.equal(result.fulfilled,true);assert.equal(result.ready,true);assert.equal(result.state,'ready');assert.equal(result.status,'ready');assert.equal(result.warning,null);
  if(mode==='state-locked'){
   assert.equal(result.realExclusiveStateLock,true);assert.equal(result.lockHeldAtSettlement,true);assert.equal(result.lockReleased,true);assert.equal(result.warningAfterUnlock,null);assert.equal(result.warningAfterLockedFlush,null);
   assert.equal(result.savedStateAfterUnlock,'missing');assert.equal(result.legacyFileBytesUnchanged,true);assert.equal(result.writerCleanAfterUnlock,true);assert.equal(result.restartedReadyWhileStateLocked,true);assert.equal(result.restartedMemoryStateKeys,0);
   assert.equal(result.stateBeforePrepare,result.stateAfterLockedFlush);assert.equal(result.stateBeforePrepare,result.stateAfterUnlockFlush);
  }
  if(process.argv.includes('--final')&&role==='candidate'){assert.equal(result.stateBeforePrepare,result.stateAfterPrepare);assert.equal(result.stateFileExistsAfterPrepare,mode==='state-locked');}

  assert.equal(result.terminationFailed,false);assert.equal(result.filesValid,true);assert.equal(result.markerCreated,true);assert.equal(result.modelPreparationReadyMessage,true);
  if(process.argv.includes('--final')&&role==='candidate'){assert.equal(result.modelStateCheckpoint.atSpawn,result.modelStateCheckpoint.atClose,'State file must stay unchanged while model worker is active');}
  assert.equal(result.childCount,result.closedCount);assert.ok(result.pythonExitCodes.every(code=>code===0));assert.equal(result.pending,false);assert.equal(result.timer,false);
  if(mode==='partial')assert.ok(result.requests.some(r=>r.offset===384*1024));
  if(mode==='fallback'){assert.ok(result.progress.some(p=>p.phase==='switching'&&p.source==='overseas'));assert.ok(result.requests.some(r=>r.source==='overseas'));}
  if(mode==='cached')assert.equal(result.requests.length,0);
  assert.ok(result.progress.some(p=>p.phase==='validating'));
  checks.push({label,passed:true});
 }catch(error){checks.push({label,passed:false,message:error.message.slice(0,1800)});}
}
let regression;
if(existsSync('full-download-candidate/test/managed-engine-state-cache.test.js')){
 const run=spawnSync(process.execPath,['--test','--test-reporter=tap','full-download-candidate/test/managed-engine-state-cache.test.js'],{encoding:'utf8',timeout:180000,maxBuffer:2*1024*1024});
 writeFileSync('full-download-regression.tap',run.stdout+run.stderr);console.log(run.stdout);if(run.stderr)console.log(run.stderr);
 const count=label=>Number(new RegExp('^# '+label+' (\\d+)$','m').exec(run.stdout)?.[1]??-1);
 regression={tests:count('tests'),pass:count('pass'),fail:count('fail'),skipped:count('skipped'),exitCode:run.status};checks.push({label:'candidate state-cache fault injection regressions',passed:run.status===0&&regression.fail===0&&regression.pass>0&&regression.skipped===0});
}
const result={regression,platform:process.platform,node:process.version,archiveSha256:'66631282f3bb9833464a98d31a668a11fd35b318a634118058dd812aa538b25e',modelWeightsDownloaded:false,inferenceExercised:false,
 fullPreparationMethodsUnmodified:true,networkResponseAndManifestFixtures:true,prevalidatedEnvironmentFixture:true,checks,results,passed:checks.every(c=>c.passed),pass:checks.filter(c=>c.passed).length,fail:checks.filter(c=>!c.passed).length};
writeFileSync('full-download-result.json',JSON.stringify(result,null,2)+'\n');console.log('FULL_DOWNLOAD_RESULT_JSON\n'+JSON.stringify(result,null,2));if(!result.passed)process.exitCode=1;

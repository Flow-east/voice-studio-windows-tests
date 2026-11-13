import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

// A separate real Node host catches accidental unhandled timer/callback errors
// and isolates filesystem fault injection from the test runner. Native Windows
// tests separately hold an actual FileShare.None handle across preparation.
const engineUrl = new URL('../src/managed-engine.js', import.meta.url).href;
const filesUrl = new URL('../src/files.js', import.meta.url).href;
const harness = String.raw`
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {spawn} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
const {ManagedEngine}=await import(process.argv[1]);
const {writeJson}=await import(process.argv[2]);
const mode=process.argv[3],root=fs.mkdtempSync(join(tmpdir(),'voice-cache-'));
const metadataMode=mode.startsWith('metadata-');
let locked=!metadataMode,attempts=0,metadataFailures=0,stopCount=0,worker,workerClosed=false,cancelPromise,modelCompleted=false;
const observed=[];
const engine=new ManagedEngine({root,platform:'win32',arch:'x64',osRelease:'10.0.19045',networkResolver:async()=>({proxyEnv:{}}),
 spawnProcess:(exe,args,opts)=>{worker=spawn(exe,args,opts);if(metadataMode)locked=true;worker.once('close',()=>workerClosed=true);return worker;},
 terminateTree:async()=>{stopCount++;if(!workerClosed){worker.kill('SIGTERM');await new Promise(resolve=>worker.once('close',resolve));}return {ok:true};}});
// Short deterministic fault windows are test-only; production keeps its normal
// bounded writer deadline. The recovery case waits past the real cooldown.
engine.stateWriter.timeoutMs=80;engine.stateWriter.intervalMs=10;
const statePath=join(engine.root,'setup-state.json');
fs.writeFileSync(statePath,JSON.stringify({transcription:{state:'missing',stage:'before preparation'}}));
const sentinelPath=join(root,'outside-sentinel');fs.writeFileSync(sentinelPath,'unchanged');
if(mode==='nonregular-directory'||mode==='nonregular-symlink'){
 fs.rmSync(statePath);if(mode==='nonregular-directory')fs.mkdirSync(statePath);else fs.symlinkSync(sentinelPath,statePath);
}
const originalRename=fs.renameSync,originalLstat=fs.lstatSync;
const fault=(code='EBUSY')=>Object.assign(Error('PRIVATE_PATH token=PRIVATE_TOKEN'),{code,errno:code==='EBUSY'?-4082:code==='EACCES'?-4092:code==='ENOSPC'?-4055:-4048,syscall:'rename'});
fs.renameSync=(from,to)=>{
 const target=String(to);
 if(target===statePath&&locked){attempts++;throw fault(mode.startsWith('state-')?mode.slice(6):'EBUSY');}
 if(mode==='config-busy'&&target===join(engine.root,'paths.json'))throw fault();
 if(mode==='model-busy'&&target.endsWith('studio-model.json'))throw fault();
 return originalRename(from,to);
};
fs.lstatSync=(path,...args)=>{
 if(metadataMode&&locked&&String(path)===statePath&&(mode!=='metadata-once'||metadataFailures===0)){
  metadataFailures++;
  if(mode==='metadata-program-error')throw Error('PRIVATE_PROGRAM_ERROR');
  const code=['metadata-EPERM','metadata-EACCES','metadata-EIO'].includes(mode)?mode.slice(9):'EBUSY';
  const error=fault(code);error.syscall='lstat';throw error;
 }
 return originalLstat(path,...args);
};syncBuiltinESMExports();
const put=(path,bytes)=>{fs.mkdirSync(join(path,'..'),{recursive:true});fs.writeFileSync(path,bytes);};
engine.speechEnv=async()=>{
 put(engine.python('asr'),'fixture');
 writeJson(join(engine.root,'asr-env/ready.json'),{schema:2,lockHash:engine.lockHash('asr'),...engine.runtimeMarker()});
 const ffmpeg=join(engine.root,'ffmpeg');put(ffmpeg,'fixture');writeJson(join(engine.root,'paths.json'),{ffmpegPath:ffmpeg});
};
engine.model=async(kind,owner)=>{
 engine.update(owner,'connecting',{progress:{phase:'connecting',component:'asr',setupStep:'model'}});
 const base={type:'model_progress',kind:'asr',phase:'downloading',source:'domestic',totalBytes:100};
 const event=n=>JSON.stringify({...base,completedBytes:n})+'\n';
 let body='process.stdout.write('+JSON.stringify(event(10))+');setTimeout(()=>{process.stdout.write('+JSON.stringify(event(75))+');},100);setTimeout(()=>{},220);';
 if(mode==='silent')body='setTimeout(()=>{},220)';
 if(mode==='recovery')body='process.stdout.write('+JSON.stringify(event(10))+');setTimeout(()=>process.stdout.write('+JSON.stringify(event(75))+'),1200);setTimeout(()=>{},1350)';
 if(mode==='worker-error')body='process.stderr.write("model failed\\n");setTimeout(()=>process.exit(17),100)';
 if(mode==='metadata-worker-error')body='process.stdout.write('+JSON.stringify(event(10))+');setTimeout(()=>process.exit(17),220)';
 if(mode==='cancel-running'||mode==='metadata-cancel')body='process.stdout.write('+JSON.stringify(event(10))+');setInterval(()=>{},1000)';
 if(mode==='recovery')setTimeout(()=>{locked=false;},400);
 await engine.command(process.execPath,['-e',body],{owner,modelKind:'asr',onProgress:event=>{
  engine.modelProgress(owner,event);observed.push({progress:engine.status().transcription.progress,warning:engine.statePersistenceStatus()});
  if(mode==='cancel-running')queueMicrotask(()=>{cancelPromise=engine.cancelPrepare();});
  if(mode==='metadata-cancel')setTimeout(()=>{cancelPromise=engine.cancelPrepare();},150);
 },timeoutMs:5000});
 const header=Buffer.from(JSON.stringify({tensor:{dtype:'F32',shape:[1],data_offsets:[0,4]}})),prefix=Buffer.alloc(8);prefix.writeBigUInt64LE(BigInt(header.length));
 const files={'config.json':Buffer.from('{}'),'tokenizer_config.json':Buffer.from('{}'),'tokenizer.json':Buffer.from('{}'),'model.safetensors':Buffer.concat([prefix,header,Buffer.alloc(4)])};
 const modelRoot=engine.paths().asrModel;
 for(const [path,bytes]of Object.entries(files))put(join(modelRoot,path),bytes);
 const [repo,revision]=engine.revisions().asr;
 writeJson(join(modelRoot,'studio-model.json'),{schema:2,repo,revision,files:Object.entries(files).map(([path,bytes])=>({path,size:bytes.length}))});modelCompleted=true;
};
if(mode==='cancel-initial')setTimeout(()=>{cancelPromise=engine.cancelPrepare();},20);
let error;const started=Date.now();
try{await engine.prepare('transcription');}catch(e){error=e;}
await cancelPromise;
const elapsed=Date.now()-started,attemptsAtSettlement=attempts;
await delay(150);
const warning=engine.statePersistenceStatus();
if(warning){const copy=engine.statePersistenceStatus();copy.details.push('PRIVATE_MUTATION');copy.metadataDetails.push('PRIVATE_MUTATION');copy.message='changed';}
const result={mode,errorCode:error?.code,diagnostic:error?.diagnostic,modelCompleted,workerClosed,stopCount,elapsed,attemptsAtSettlement,attemptsAfter:attempts,metadataFailures,sentinel:fs.readFileSync(sentinelPath,'utf8'),
 ready:engine.ready('transcription'),state:engine.state.transcription,status:engine.status().transcription,warning:engine.statePersistenceStatus(),observed,
 writerPending:engine.stateWriter.pending!==null,writerTimer:engine.stateWriter.timer!==null,writerAction:engine.stateWriter.action!==null,busy:engine.busy!==null,child:engine.child!==null,terminationFailed:engine.terminationFailed};
// An explicit post-unlock flush must write the latest final state, not replay a
// progress snapshot retained from the first failed rename.
if(mode==='persistent'||mode==='state-EPERM'){
 locked=false;await engine.flushState({retry:true});result.recoveredWarning=engine.statePersistenceStatus();result.saved=JSON.parse(fs.readFileSync(statePath,'utf8'));
 const restarted=new ManagedEngine({root,platform:'win32',arch:'x64',osRelease:'10.0.19045'});result.restartedReady=restarted.ready('transcription');
}
fs.renameSync=originalRename;fs.lstatSync=originalLstat;syncBuiltinESMExports();fs.rmSync(root,{recursive:true,force:true});console.log(JSON.stringify(result));
`;

function run(mode) {
  const host = spawnSync(process.execPath, ['--input-type=module', '-e', harness, engineUrl, filesUrl, mode], { encoding: 'utf8', timeout: 10000 });
  assert.equal(host.error, undefined); assert.equal(host.status, 0, host.stderr);
  const result = JSON.parse(host.stdout.trim());
  assert.equal(result.writerPending, false); assert.equal(result.writerTimer, false); assert.equal(result.writerAction, false);
  assert.equal(result.busy, false); assert.equal(result.child, false); assert.equal(result.terminationFailed, false);
  assert.equal(result.attemptsAfter, result.attemptsAtSettlement, 'no stale retry after preparation settled');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_PATH|PRIVATE_TOKEN|PRIVATE_MUTATION|PRIVATE_PROGRAM_ERROR|voice-cache-/);
  return result;
}

for (const mode of ['metadata-EBUSY', 'metadata-EPERM', 'metadata-EACCES', 'metadata-once']) {
  test(`${mode} cannot turn an optional cache rename into a fatal worker callback`, () => {
    const result = run(mode);
    assert.equal(result.errorCode, undefined); assert.equal(result.stopCount, 0); assert.equal(result.modelCompleted, true);
    assert.equal(result.ready, true); assert.equal(result.state.state, 'ready'); assert.equal(result.workerClosed, true);
    assert.ok(result.warning.details.includes('syscall=rename'));
    assert.ok(result.warning.metadataDetails.includes('syscall=lstat'));
    assert.ok(result.warning.metadataDetails.includes('fileRole=engine-state'));
    assert.ok(result.warning.metadataDetails.includes(`errno=${mode === 'metadata-once' ? 'EBUSY' : mode.slice(9)}`));
    assert.equal(result.warning.details.includes('syscall=lstat'), false, 'primary and auxiliary facts stay separate');
    if (mode === 'metadata-once') assert.equal(result.metadataFailures, 1);
    else assert.ok(result.metadataFailures > 1);
  });
}

test('a real model exit remains the primary failure with unavailable cache metadata', () => {
  const result = run('metadata-worker-error');
  assert.equal(result.modelCompleted, false); assert.equal(result.ready, false); assert.equal(result.state.state, 'failed');
  assert.equal(result.errorCode, 'PROCESS_EXIT'); assert.ok(result.diagnostic.details.includes('exit=17'));
  assert.equal(result.stopCount, 0); assert.ok(result.warning.metadataDetails.includes('syscall=lstat'));
});

test('cancellation drains metadata-degraded state retries without hiding cancellation or retaining timers', () => {
  const result = run('metadata-cancel');
  assert.equal(result.ready, false); assert.equal(result.state.state, 'missing'); assert.equal(result.modelCompleted, false);
  assert.equal(result.stopCount, 1); assert.equal(result.workerClosed, true);
  assert.ok(result.warning.metadataDetails.includes('syscall=lstat'));
  assert.ok(result.elapsed < 1200);
});

for (const mode of ['nonregular-directory', 'nonregular-symlink', 'metadata-EIO', 'metadata-program-error']) {
  test(`${mode} remains strict when handling a failed cache rename`, () => {
    const result = run(mode);
    assert.equal(result.modelCompleted, false); assert.equal(result.ready, false); assert.equal(result.state.state, 'failed');
    assert.ok(result.errorCode); assert.equal(result.warning, null); assert.equal(result.sentinel, 'unchanged');
    assert.equal(result.stopCount, mode.startsWith('metadata-') ? 1 : 0);
  });
}

for (const mode of ['persistent', 'silent', 'state-EPERM']) {
  test(`${mode} cache sharing failure keeps the real worker running and final readiness truthful`, () => {
    const result = run(mode);
    assert.equal(result.errorCode, undefined); assert.equal(result.modelCompleted, true); assert.equal(result.workerClosed, true); assert.equal(result.stopCount, 0);
    assert.equal(result.ready, true); assert.equal(result.state.state, 'ready'); assert.equal(result.status.state, 'ready');
    assert.equal(result.warning.code, 'STATE_PERSISTENCE_DEGRADED');
    assert.ok(result.warning.details.includes('fileRole=engine-state'));
    assert.ok(result.warning.details.includes('syscall=rename'));
    if (mode !== 'silent') assert.deepEqual(result.observed.map(value => value.progress.completedBytes), [10, 75]);
    if (mode !== 'silent') assert.ok(result.observed.every(value => value.warning?.code === 'STATE_PERSISTENCE_DEGRADED'));
    if (mode !== 'silent') {
      assert.equal(result.recoveredWarning, null); assert.equal(result.saved.transcription.state, 'ready'); assert.equal(result.restartedReady, true);
    }
  });
}

test('a future progress event recovers after unlock and clears the warning only after saving', () => {
  const result = run('recovery');
  assert.equal(result.errorCode, undefined); assert.equal(result.ready, true); assert.equal(result.warning, null);
  assert.equal(result.observed[0].warning.code, 'STATE_PERSISTENCE_DEGRADED'); assert.equal(result.observed[1].warning, null);
  assert.equal(result.observed[1].progress.completedBytes, 75);
});

for (const mode of ['worker-error', 'model-busy', 'config-busy', 'state-EACCES', 'state-ENOSPC']) {
  test(`${mode} remains a real preparation failure when the progress cache is unavailable`, () => {
    const result = run(mode);
    assert.equal(result.modelCompleted, false); assert.equal(result.ready, false); assert.equal(result.state.state, 'failed');
    if (mode === 'worker-error') {
      assert.equal(result.errorCode, 'PROCESS_EXIT'); assert.ok(result.diagnostic.details.includes('exit=17')); assert.equal(result.warning.code, 'STATE_PERSISTENCE_DEGRADED');
    } else if (mode.startsWith('state-')) {
      assert.equal(result.errorCode, mode.slice(6)); assert.equal(result.warning, null); assert.equal(result.workerClosed, false);
    } else assert.equal(result.errorCode, 'EBUSY');
    assert.equal(result.stopCount, 0);
  });
}

for (const mode of ['cancel-initial', 'cancel-running']) {
  test(`${mode} drains cache retries without a new final retry window or false stop protection`, () => {
    const result = run(mode);
    assert.equal(result.ready, false); assert.equal(result.state.state, 'missing'); assert.equal(result.modelCompleted, false);
    assert.ok(result.elapsed < 1200, JSON.stringify(result));
    assert.equal(result.stopCount, mode === 'cancel-running' ? 1 : 0);
    if (mode === 'cancel-initial') { assert.equal(result.warning, null); assert.equal(result.workerClosed, false); }
    else { assert.equal(result.workerClosed, true); assert.equal(result.warning.code, 'STATE_PERSISTENCE_DEGRADED'); }
  });
}

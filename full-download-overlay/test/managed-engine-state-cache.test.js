import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

// A real host/child pair isolates filesystem interception. All accesses to the
// obsolete Windows UI snapshot (including its atomic temporary files) fail.
// Model/env markers are real tiny fixtures, so ready() is never overridden.
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
const mode=process.argv[3],root=fs.mkdtempSync(join(tmpdir(),'voice-memory-state-'));
const engineRoot=join(root,'engine-v1'),statePath=join(engineRoot,'setup-state.json'),sentinelPath=join(root,'outside-sentinel');
fs.mkdirSync(engineRoot);fs.writeFileSync(sentinelPath,'unchanged outside bytes');
const legacy=JSON.stringify({transcription:{state:mode==='stale-ready'?'ready':'failed',errorCode:'FILE_IN_USE',stage:'legacy snapshot'}});
if(mode==='directory')fs.mkdirSync(statePath);
else if(mode==='symlink')fs.symlinkSync(sentinelPath,statePath);
else fs.writeFileSync(statePath,legacy);
const originals=Object.fromEntries(['readFileSync','writeFileSync','lstatSync','renameSync','rmSync'].map(name=>[name,fs[name]]));
const stateAccesses=[];
const isState=path=>String(path)===statePath||String(path).startsWith(statePath+'.')&&String(path).endsWith('.tmp');
const fault=(code='EBUSY',syscall='rename')=>Object.assign(Error('PRIVATE_PATH token=PRIVATE_TOKEN'),{code,errno:code==='EBUSY'?-4082:code==='EACCES'?-4092:code==='ENOSPC'?-4055:-4070,syscall});
const stateFault=mode==='denied'?'EACCES':mode==='full-disk'?'ENOSPC':mode==='io-error'?'EIO':'EBUSY';
for(const name of ['readFileSync','writeFileSync','lstatSync','rmSync'])fs[name]=(path,...args)=>{
 if(isState(path)){stateAccesses.push(name);throw fault(stateFault,name.replace('Sync','').replace('File','').toLowerCase());}
 return originals[name](path,...args);
};
fs.renameSync=(from,to)=>{
 if(isState(from)||isState(to)){stateAccesses.push('renameSync');throw fault(stateFault);}
 if(mode==='config-busy'&&String(to)===join(engineRoot,'paths.json'))throw fault();
 if(mode==='model-busy'&&String(to).endsWith('studio-model.json'))throw fault();
 return originals.renameSync(from,to);
};syncBuiltinESMExports();
let worker,workerClosed=false,stopCount=0,cancelPromise,modelCompleted=false;
const observed=[];
const options={root,platform:'win32',arch:'x64',osRelease:'10.0.19045',networkResolver:async()=>({proxyEnv:{}}),
 spawnProcess:(exe,args,opts)=>{worker=spawn(exe,args,opts);worker.once('close',()=>workerClosed=true);return worker;},
 terminateTree:async()=>{stopCount++;if(mode==='stop-guard')return {ok:false,errorCode:'EPERM'};if(!workerClosed){worker.kill('SIGTERM');await new Promise(resolve=>worker.once('close',resolve));}return {ok:true};}};
const engine=new ManagedEngine(options),initialState=JSON.parse(JSON.stringify(engine.state)),initialStatus=engine.status().transcription.state;
engine.stateWriter.timeoutMs=80;engine.stateWriter.intervalMs=10;
const put=(path,bytes)=>{fs.mkdirSync(join(path,'..'),{recursive:true});fs.writeFileSync(path,bytes);};
engine.speechEnv=async()=>{
 put(engine.python('asr'),'fixture');
 writeJson(join(engine.root,'asr-env/ready.json'),{schema:2,lockHash:engine.lockHash('asr'),...engine.runtimeMarker()});
 const ffmpeg=join(engine.root,'ffmpeg');put(ffmpeg,'fixture');writeJson(join(engine.root,'paths.json'),{ffmpegPath:ffmpeg});
};
engine.model=async(kind,owner)=>{
 engine.update(owner,'connecting',{progress:{phase:'connecting',component:'asr',setupStep:'model'}});
 const event=n=>JSON.stringify({type:'model_progress',kind:'asr',phase:'downloading',source:'domestic',totalBytes:100,completedBytes:n})+'\n';
 let body='process.stdout.write('+JSON.stringify(event(10))+');setTimeout(()=>process.stdout.write('+JSON.stringify(event(75))+'),100);setTimeout(()=>{},220)';
 if(mode==='silent')body='setTimeout(()=>{},220)';
 if(mode==='worker-error')body='process.stdout.write('+JSON.stringify(event(10))+');setTimeout(()=>process.exit(17),100)';
 if(['cancel','stop-guard','program-callback'].includes(mode))body='process.stdout.write('+JSON.stringify(event(10))+');setInterval(()=>{},1000)';
 await engine.command(process.execPath,['-e',body],{owner,modelKind:'asr',onProgress:event=>{
  engine.modelProgress(owner,event);
  engine.persistState(false,true);void engine.flushState({retry:true});
  observed.push({bytes:engine.status().transcription.progress.completedBytes,pending:!!engine.stateWriter.pending,timer:!!engine.stateWriter.timer});
  if(mode==='program-callback')throw Error('PRIVATE_PROGRAM_ERROR');
  if(mode==='cancel'||mode==='stop-guard')queueMicrotask(()=>{cancelPromise=engine.cancelPrepare().catch(error=>error.code);});
 },timeoutMs:5000});
 const header=Buffer.from(JSON.stringify({tensor:{dtype:'F32',shape:[1],data_offsets:[0,4]}})),prefix=Buffer.alloc(8);prefix.writeBigUInt64LE(BigInt(header.length));
 const files={'config.json':Buffer.from('{}'),'tokenizer_config.json':Buffer.from('{}'),'tokenizer.json':Buffer.from('{}'),'model.safetensors':Buffer.concat([prefix,header,Buffer.alloc(4)])};
 const modelRoot=engine.paths().asrModel;
 for(const [path,bytes]of Object.entries(files))put(join(modelRoot,path),bytes);
 const [repo,revision]=engine.revisions().asr;
 writeJson(join(modelRoot,'studio-model.json'),{schema:2,repo,revision,files:Object.entries(files).map(([path,bytes])=>({path,size:bytes.length}))});modelCompleted=true;
};
let error;try{await engine.prepare('transcription');}catch(e){error=e;}
await cancelPromise;
const result={mode,initialState,initialStatus,errorCode:error?.code,diagnostic:error?.diagnostic,modelCompleted,workerClosed,stopCount,
 ready:engine.ready('transcription'),state:engine.state.transcription,status:engine.status().transcription.state,warning:engine.statePersistenceStatus(),observed,
 writerPending:!!engine.stateWriter.pending,writerTimer:!!engine.stateWriter.timer,writerAction:!!engine.stateWriter.action,busy:!!engine.busy,child:!!engine.child,terminationFailed:engine.terminationFailed};
// Explicit flushes, reset actions and fresh engine construction must also leave
// the obsolete file alone. Actual model files remain the readiness authority.
await engine.flushState({retry:true});engine.persistState(false,true);
if(modelCompleted){const restarted=new ManagedEngine(options);result.restartedReady=restarted.ready('transcription');result.restartedState=restarted.state;}
if(mode==='forget-models'){originals.rmSync(engine.paths().asrModel,{recursive:true,force:true});engine.forgetModels(['asr']);result.forgotState=engine.state.transcription.state;result.forgotReady=engine.ready('transcription');}
if(worker&&!workerClosed){worker.kill('SIGKILL');await new Promise(resolve=>worker.once('close',resolve));}
const accessesAtSettlement=stateAccesses.length;await delay(150);result.stateAccesses=stateAccesses;result.lateAccesses=stateAccesses.length-accessesAtSettlement;
const oldType=originals.lstatSync(statePath);result.oldType=oldType.isDirectory()?'directory':oldType.isSymbolicLink()?'symlink':'file';
result.oldBytesUnchanged=oldType.isDirectory()||originals.readFileSync(statePath,'utf8')===(mode==='symlink'?'unchanged outside bytes':legacy);
result.sentinel=originals.readFileSync(sentinelPath,'utf8');
for(const [name,fn]of Object.entries(originals))fs[name]=fn;syncBuiltinESMExports();fs.rmSync(root,{recursive:true,force:true});console.log(JSON.stringify(result));
`;

function run(mode) {
  const host = spawnSync(process.execPath, ['--input-type=module', '-e', harness, engineUrl, filesUrl, mode], { encoding: 'utf8', timeout: 10000 });
  assert.equal(host.error, undefined); assert.equal(host.status, 0, host.stderr);
  const result = JSON.parse(host.stdout.trim());
  assert.deepEqual(result.initialState, {}); assert.equal(result.initialStatus, 'missing');
  assert.deepEqual(result.stateAccesses, [], 'Windows must never read, probe, write, rename or delete setup-state');
  assert.equal(result.lateAccesses, 0); assert.equal(result.oldBytesUnchanged, true); assert.equal(result.sentinel, 'unchanged outside bytes');
  assert.equal(result.writerPending, false); assert.equal(result.writerTimer, false); assert.equal(result.writerAction, false);
  assert.equal(result.busy, false); assert.equal(result.child, false); assert.equal(result.warning, null);
  assert.ok(result.observed.every(value => !value.pending && !value.timer));
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_PATH|PRIVATE_TOKEN|PRIVATE_PROGRAM_ERROR|voice-memory-state-/);
  return result;
}

for (const mode of ['locked', 'denied', 'full-disk', 'io-error', 'directory', 'symlink', 'stale-failed', 'stale-ready', 'silent', 'forget-models']) {
  test(`Windows ${mode} legacy state cannot affect preparation, live progress or restart readiness`, () => {
    const result = run(mode);
    assert.equal(result.errorCode, undefined); assert.equal(result.modelCompleted, true); assert.equal(result.workerClosed, true); assert.equal(result.stopCount, 0);
    assert.equal(result.ready, true); assert.equal(result.state.state, 'ready'); assert.equal(result.status, 'ready');
    assert.equal(result.restartedReady, true); assert.deepEqual(result.restartedState, {}); assert.equal(result.terminationFailed, false);
    if (mode !== 'silent') assert.deepEqual(result.observed.map(value => value.bytes), [10, 75]);
    if (mode === 'directory' || mode === 'symlink') assert.equal(result.oldType, mode);
    if (mode === 'forget-models') { assert.equal(result.forgotState, 'missing'); assert.equal(result.forgotReady, false); }
  });
}

for (const mode of ['worker-error', 'model-busy', 'config-busy', 'program-callback']) {
  test(`Windows ${mode} remains a real failure independently of obsolete state storage`, () => {
    const result = run(mode);
    assert.equal(result.modelCompleted, false); assert.equal(result.ready, false); assert.equal(result.state.state, 'failed'); assert.equal(result.terminationFailed, false);
    if (mode === 'worker-error') { assert.equal(result.errorCode, 'PROCESS_EXIT'); assert.ok(result.diagnostic.details.includes('exit=17')); }
    else if (mode === 'program-callback') { assert.equal(result.errorCode, 'UNKNOWN'); assert.equal(result.stopCount, 1); }
    else assert.equal(result.errorCode, 'EBUSY');
  });
}

test('Windows cancellation stops its child and leaves no cache actions or timers', () => {
  const result = run('cancel');
  assert.equal(result.modelCompleted, false); assert.equal(result.ready, false); assert.equal(result.state.state, 'missing');
  assert.equal(result.stopCount, 1); assert.equal(result.workerClosed, true); assert.equal(result.terminationFailed, false);
});

test('Windows unconfirmed child termination keeps the stop guard despite unused state storage', () => {
  const result = run('stop-guard');
  assert.equal(result.errorCode, 'PROCESS_TERMINATION_FAILED'); assert.equal(result.terminationFailed, true);
  assert.equal(result.modelCompleted, false); assert.equal(result.ready, false); assert.equal(result.workerClosed, false); assert.equal(result.stopCount, 1);
});

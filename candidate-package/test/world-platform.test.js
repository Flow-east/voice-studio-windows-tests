import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { VoiceStudioWorld } from '../src/world.js';
import { DEFAULTS } from '../src/config.js';
import { diagnose, DiagnosticLog } from '../src/diagnostics.js';
const WAV = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(64)]);
const wait = async predicate => { for(let i=0;i<100;i++){ if(predicate())return; await new Promise(r=>setTimeout(r,5)); } throw Error('timeout'); };
async function fixture(t, overrides={}) {
  const root=mkdtempSync(join(tmpdir(),'world-platform-')),calls=[],preparations=[];
  const states=Object.fromEntries(['speech','transcription','reference','singing'].map(kind=>[kind,{state:'ready',supported:true}]));
  const paths={speechPython:'/fixture/tts/python',asrPython:'/fixture/asr/python',baseModel:'/fixture/base',asrModel:'/fixture/asr',ffmpegPath:'/usr/bin/true'};
  const engine={status:()=>states,paths:()=>paths,prepare:async kind=>preparations.push(kind),cancelPrepare:async()=>{},...overrides.engine};
  const runProcess=options=>{calls.push(options);mkdirSync(options.outputDir,{recursive:true});const audio=join(options.outputDir,'reference.wav');writeFileSync(audio,WAV);
    if(basename(options.runnerPath)==='torch_transcribe.py')writeFileSync(join(options.outputDir,'transcription.json'),JSON.stringify({text:'你好',durationSeconds:2}));
    else if(basename(options.runnerPath)==='torch_reference.py')writeFileSync(join(options.outputDir,'reference.json'),JSON.stringify({audio,text:'参考声音',durationSeconds:6}));
    else writeFileSync(join(options.outputDir,'status.json'),JSON.stringify({state:'completed',audio,duration_seconds:2}));
    return {promise:Promise.resolve({code:0}),cancel(){}};
  };
  const cfg={...DEFAULTS,singingEnabled:true};
  const world=new VoiceStudioWorld({cfg,dataDir:root,persist:patch=>Object.assign(cfg,patch),dependencies:{platform:'win32',arch:'x64',osRelease:'10.0.26100',engine,runProcess,readQQAudio:async()=>({bytes:WAV,source:{}}),detectQQ:async()=>({status:'connected'}),...overrides.dependencies}});
  await world.start({pushEvent:async()=>{}});
  t.after(async()=>{await world.stop().catch(()=>{});rmSync(root,{recursive:true,force:true});});
  return {world,calls,states,paths,root,preparations};
}
test('world selects platform runtimes and exposes actual engine device acceleration',async t=>{
  const {world}=await fixture(t,{engine:{device:()=>({platform:'win32',arch:'x64',speechBackend:'torch',label:'Windows 64 位',accelerationLabel:'NVIDIA CUDA 加速'})}});
  assert.equal(basename(world.speechRunner),'torch_speech.py');assert.equal(basename(world.referenceRunner),'torch_reference.py');assert.equal(basename(world.transcriptionRunner),'torch_transcribe.py');
  assert.equal(world.state().device.accelerationLabel,'NVIDIA CUDA 加速');assert.equal((await world.check()).checks.find(x=>x.id==='platform').ok,true);
  const intel=new VoiceStudioWorld({dataDir:'/tmp/unused-world',dependencies:{platform:'darwin',arch:'x64',osRelease:'22.0.0'}});assert.equal(intel.device.supported,true);assert.equal(basename(intel.speechRunner),'torch_speech.py');
  const arm=new VoiceStudioWorld({dataDir:'/tmp/unused-world',dependencies:{platform:'darwin',arch:'arm64',osRelease:'23.0.0'}});assert.equal(basename(arm.speechRunner),'managed_speech.py');
});
test('world uses separate ASR Python for transcription and reference while TTS keeps speech Python',async t=>{
  const {world,calls,paths}=await fixture(t);
  world.enqueue('speech','试听');await wait(()=>!world.active);
  await world.transcribeQQ('123');await wait(()=>!world.active);
  world.uploadReference({name:'参考.wav',mime:'audio/wav',data:WAV.toString('base64')});await wait(()=>!world.referenceTask);
  assert.deepEqual(calls.map(c=>[basename(c.runnerPath),c.pythonPath]),[['torch_speech.py',paths.speechPython],['torch_transcribe.py',paths.asrPython],['torch_reference.py',paths.asrPython]]);
  for (const call of calls) assert.deepEqual(call.args.slice(-2), ['--device','cpu']);
  assert.ok(world.storageOptions().protectedPaths.includes(paths.asrPython));
});
test('verified CUDA profile is explicit for TTS, ASR and reference processing',async t=>{
  const {world,calls}=await fixture(t,{engine:{runtimeProfile:'windows-cuda'}});
  world.enqueue('speech','试听');await wait(()=>!world.active);
  await world.transcribeQQ('123');await wait(()=>!world.active);
  world.uploadReference({name:'参考.wav',mime:'audio/wav',data:WAV.toString('base64')});await wait(()=>!world.referenceTask);
  assert.equal(calls.length,3);
  for (const call of calls) assert.deepEqual(call.args.slice(-2), ['--device','cuda']);
});
test('reference upload stops before saving or preparing when the reference library is unavailable', async t => {
  const { world, calls, preparations } = await fixture(t);
  world.references = null;
  const uploads = join(world.root, 'references');
  assert.equal(existsSync(uploads), false);
  assert.throws(() => world.uploadReference({ name: '参考.wav', mime: 'audio/wav', data: WAV.toString('base64') }), /参考音色列表尚未准备好/);
  assert.equal(existsSync(uploads), false);
  assert.equal(world.referenceTask, null);
  assert.deepEqual(preparations, []);
  assert.deepEqual(calls, []);
});
test('unsupported component reasons survive ready states and prevent enable/download/generation',async t=>{
  const {world,states,preparations}=await fixture(t);states.singing={state:'ready',supported:false,unsupportedReason:'当前设备缺少所需计算支持。'};
  assert.equal(world.engineStatus().singing.supported,false);assert.equal(world.state().engine.singing.unsupportedReason,states.singing.unsupportedReason);
  assert.throws(()=>world.initialize('singing'),/计算支持/);await assert.rejects(world.setSingingEnabled(true),/计算支持/);
  assert.throws(()=>world.enqueue('song','主题',{title:'晚风',lines:['晚风轻轻吹过窗台','带走白日里的尘埃','天边染上淡淡红霞','梦里还有你的存在']}),/计算支持/);
  assert.equal((await world.check()).checks.find(x=>x.id==='singingEngine').ok,false);assert.deepEqual(preparations,[]);
});
test('generation termination failure stays failed, blocks queue/cleanup/restart and is never reported stopped',async t=>{
  let finish;
  const {world}=await fixture(t,{dependencies:{runProcess:()=>({promise:new Promise(r=>{finish=r;}),cancel(){finish({code:null,cancelled:true,terminationFailed:true,terminationErrorCode:'TASKKILL_EXIT_5'});}})}});
  const active=world.enqueue('speech','正在生成'),queued=world.enqueue('speech','等待');
  await assert.rejects(world.stopAll(),/无法确认后台程序已停止/);
  assert.equal(world.state(active.id).status,'failed');assert.match(world.state(active.id).error,/无法确认/);assert.equal(world.state(queued.id).status,'cancelled');assert.equal(diagnose(world.state(active.id).error).code,'PROCESS_TERMINATION_FAILED');assert.equal(world.diagnostics().entries.find(e=>e.code==='PROCESS_TERMINATION_FAILED').message,'无法确认后台程序已停止');assert.equal(world.storageBusy(),true);assert.equal(world.state().running,false);assert.equal(world.shutdownVerification()[0].status,'still-live');
  assert.throws(()=>world.enqueue('speech','再次生成'),/无法确认/);assert.throws(()=>world.initialize('speech'),/无法确认/);await assert.rejects(world.transcribeQQ('456'),/无法确认/);await assert.rejects(world.previewCleanup({type:'cache'}),/无法确认/);
  const response=await world.tools().find(x=>x.name==='voice_studio_stop').handler({});assert.equal(response.failed,true);assert.doesNotMatch(response.text,/已停止工作室/);
  await assert.rejects(world.stop(),/无法确认/);await assert.rejects(world.start({pushEvent:async()=>{}}),/无法确认/);
});
test('setup stop and automatic playback termination failures latch world lock',async t=>{
  const {world}=await fixture(t,{engine:{cancelPrepare:async()=>{throw Object.assign(Error('private details'),{code:'PROCESS_TERMINATION_FAILED',terminationFailed:true});}}});
  await assert.rejects(world.cancelSetup(),/无法确认/);assert.equal(world.state().stopFailure.code,'PROCESS_TERMINATION_FAILED');
  const next=await fixture(t);next.world.playState('unknown','failed',{terminationFailed:true,terminationErrorCode:'TASKKILL_TIMEOUT'});
  assert.equal(next.world.state().stopFailure.code,'TASKKILL_TIMEOUT');assert.throws(()=>next.world.initialize('speech'),/无法确认/);
});
test('diagnostics prioritizes unconfirmed termination over cancelled/timeout and keeps safe fixed text',t=>{
  const result=diagnose(Object.assign(Error('private path C:\\secret'),{terminationFailed:true}),{cancelled:true,timedOut:true});assert.equal(result.code,'PROCESS_TERMINATION_FAILED');assert.doesNotMatch(JSON.stringify(result),/secret|运行超时|操作已取消/);
  const root=mkdtempSync(join(tmpdir(),'world-platform-report-'));t.after(()=>rmSync(root,{recursive:true,force:true}));const log=new DiagnosticLog({root,version:'0.1.1'});const report=log.report({device:{speechBackend:'torch'}});assert.equal(report.summary.models.speech.name,'Qwen3-TTS-12Hz-1.7B-Base');
});

test('one-click diagnostics reads current state persistence warning and clears it after recovery', async t => {
  let warning = { code: 'STATE_PERSISTENCE_DEGRADED', details: ['errno=EBUSY', 'syscall=rename', 'fileRole=engine-state'], since: Date.now(), lastFailureAt: Date.now() };
  const { world, states } = await fixture(t, { engine: { statePersistenceStatus: () => warning } });
  states.transcription = { state: 'preparing', supported: true, progress: { phase: 'downloading', completedBytes: 1234 } };
  const report = await world.invoke('logs', 'diagnostics', [{}]);
  assert.equal(report.summary.statePersistenceWarning.code, 'STATE_PERSISTENCE_DEGRADED');
  assert.match(report.text, /fileRole=engine-state/);
  assert.equal(report.summary.models.transcription.state, 'preparing');
  assert.equal(report.summary.models.speech.state, 'ready');
  assert.equal(report.summary.stopFailure, null);
  warning = null;
  states.transcription = { state: 'ready', supported: true };
  const recovered = world.diagnostics();
  assert.equal(recovered.summary.statePersistenceWarning, undefined);
  assert.doesNotMatch(recovered.text, /状态保存提醒|STATE_PERSISTENCE_DEGRADED/);
  assert.equal(recovered.summary.models.transcription.state, 'ready');
});

test('real world snapshot preserves failure ownership and recovers the ASR log during reference preparation', async t => {
  const {world,states}=await fixture(t);
  world.recordDiagnostic({area:'reference',code:'SETUP_STARTED',level:'info'});
  mkdirSync(join(world.root,'engine-v1'),{recursive:true});
  writeFileSync(join(world.root,'engine-v1/setup-model-asr.log'),'OSError: [Errno 22] 模型文件读写失败');
  writeFileSync(join(world.root,'engine-v1/setup-model-reference.log'),'OSError: [Errno 13] 模型文件读写失败');
  world.recordDiagnostic({area:'reference',code:'SETUP_FAILED',setupStep:'model',error:'OSError: 模型文件读写失败'});
  const failedAt=Date.now();
  states.reference={state:'failed',supported:true,setupStep:'model',component:'asr',failedAt,error:'模型程序报告异常',errorCode:'PYTHON_EXCEPTION',errorType:'OSError',errorDetails:['exception=OSError']};
  const snapshot=world.state();
  assert.equal(snapshot.engine.reference.setupStep,'model'); assert.equal(snapshot.engine.reference.component,'asr'); assert.equal(snapshot.engine.reference.failedAt,failedAt);
  const report=world.diagnostics();
  assert.equal(report.summary.models.reference.error.code,'FILE_OPERATION_INVALID'); assert(report.summary.models.reference.error.details.includes('errnoNumber=22'));
  const restored=new DiagnosticLog({root:world.root});
  assert.equal(restored.report(snapshot).summary.models.reference.error.code,'FILE_OPERATION_INVALID');
  states.reference={...states.reference,setupStep:'PRIVATE_PATH',component:'PRIVATE_PATH',failedAt:Infinity};
  const invalid=world.engineStatus().reference;
  assert.equal(invalid.setupStep,undefined); assert.equal(invalid.component,undefined); assert.equal(invalid.failedAt,undefined);
});

test('managed CPU singing gets one hour while verified CUDA retains normal timeout',async t=>{
  const lyrics={title:'晚风',lines:['晚风轻轻吹过窗台','带走白日里的尘埃','天边染上淡淡红霞','梦里还有你的存在']};
  for(const [runtimeProfile,expected] of [['windows-x64',3600000],['windows-cuda',600000]]){
    const {world,calls}=await fixture(t,{engine:{runtimeProfile}});world.enqueue('song','晚风',lyrics);await wait(()=>!world.active);assert.equal(calls[0].timeoutMs,expected);
    assert.equal(JSON.parse(readFileSync(calls[0].configPath,'utf8')).computeDevice,runtimeProfile==='windows-cuda'?'cuda':'cpu');
  }
});

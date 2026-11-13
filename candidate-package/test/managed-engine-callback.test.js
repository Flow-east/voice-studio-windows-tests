import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ManagedEngine } from '../src/managed-engine.js';

// A separate Node host is essential: an uncaught EventEmitter callback would
// otherwise abort the test runner itself, hiding whether the host survives.
const engineUrl = new URL('../src/managed-engine.js', import.meta.url).href;
const harness = String.raw`
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, unlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const { ManagedEngine } = await import(process.argv[1]);
const mode = process.argv[2];
const root = mkdtempSync(join(tmpdir(), 'voice-callback-host-'));
let worker, workerClosed = false, workError;
const fault = () => Object.assign(Error('PRIVATE_PATH_OR_INPUT'), { code: 'EACCES', errno: -13 });
const live = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const progress = JSON.stringify({type:'model_progress',kind:'asr',phase:'checking'});
let body = 'process.stdout.write("ready\\n");setInterval(()=>{},1000)';
if (mode === 'stderr-log') body = 'process.stderr.write("ready\\n");setInterval(()=>{},1000)';
if (mode === 'progress') body = 'process.stdout.write('+JSON.stringify(progress+'\n')+');setInterval(()=>{},1000)';
if (mode === 'final-progress') body = 'process.stdout.write('+JSON.stringify(progress)+')';
if (mode === 'final-state') body = 'process.exit(0)';
if (mode === 'error-log') body = 'process.exit(1)';
const platform = process.platform === 'win32' ? 'win32' : 'darwin';
const engine = new ManagedEngine({root, platform, arch:process.arch, osRelease:platform==='win32'?'10.0.19045':'25.0',
 networkResolver:async()=>({proxyEnv:{}}), ...(mode==='stop-denied'?{signalProcess:()=>{throw Object.assign(Error('PRIVATE_DENIAL'),{code:'EPERM'});},terminateTree:async()=>({ok:false,errorCode:'EPERM'})}:{}), spawnProcess:(exe,args,options)=>{
  if(exe !== process.execPath) return spawn(exe,args,options);
  worker=spawn(exe,args,options); worker.once('close',()=>workerClosed=true);
  if (mode === 'stdout-log' || mode === 'stderr-log') {
   const path=join(root,'engine-v1','setup-command.log'); unlinkSync(path); mkdirSync(path);
  }
  if (mode === 'error-log') mkdirSync(join(root,'engine-v1','setup-error.log'));
  if (mode === 'stream') setTimeout(()=>worker.stdout.emit('error', fault()), 100);
  return worker;
 }});
engine.controller = new AbortController();
if (mode === 'activity' || mode === 'stop-denied') engine.activity = () => { throw fault(); };
if (mode === 'final-state') {
 engine.state.transcription={state:'preparing'};
 engine.persistState=()=>{throw fault();};
}
const options={timeoutMs:5000};
if (mode === 'progress' || mode === 'final-progress') Object.assign(options,{modelKind:'asr',onProgress:()=>{throw fault();}});
if (mode === 'final-state') options.owner='transcription';
try { await engine.command(process.execPath,['-e',body],options); }
catch(error){workError=error;}
const result={mode,rejected:!!workError,workerClosed,workerAlive:live(worker.pid),terminationFailed:engine.terminationFailed,
 diagnostic:workError?.diagnostic,secondaryDiagnostic:workError?.secondaryDiagnostic,errno:workError?.errno,errorCode:workError?.code,terminationErrorCode:workError?.terminationErrorCode,childCleared:engine.child===null,stopCleared:engine.stopCommand===null};
if(result.workerAlive) { worker.kill('SIGKILL'); await new Promise(r=>worker.once('close',r)); }
result.workerAliveAfterCleanup=live(worker.pid);
rmSync(root,{recursive:true,force:true});
console.log(JSON.stringify(result));
`;

for (const mode of ['stdout-log', 'stderr-log', 'activity', 'progress', 'final-progress', 'final-state', 'error-log', 'stream']) {
  test(`callback ${mode} rejects safely and the real worker stops before command settlement`, () => {
    const host = spawnSync(process.execPath, ['--input-type=module', '-e', harness, engineUrl, mode], { encoding: 'utf8', timeout: 12000, maxBuffer: 128 * 1024 });
    assert.equal(host.error, undefined);
    assert.equal(host.status, 0, host.stderr);
    const result = JSON.parse(host.stdout.trim());
    assert.equal(result.rejected, true);
    assert.equal(result.workerClosed, true);
    assert.equal(result.workerAlive, false);
    assert.equal(result.terminationFailed, false);
    assert.equal(result.childCleared, true);
    assert.equal(result.stopCleared, true);
    if (mode === 'error-log') {
      assert.equal(result.errorCode, 'PROCESS_EXIT'); assert.ok(result.diagnostic.details.includes('exit=1'));
      assert.ok(result.secondaryDiagnostic?.details.includes('fileRole=setup-error-log'));
    } else assert.ok(result.diagnostic?.details.some(value => value.startsWith('errnoNumber=')), JSON.stringify(result));
    if (!mode.endsWith('log')) assert.equal(result.errno, -13);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_PATH_OR_INPUT|voice-callback-host-/);
    assert.doesNotMatch(host.stderr, /uncaught|Unhandled|EISDIR/);
  });
}


test('callback failure retains original system facts and blocks retries when tree termination is denied', () => {
  const host = spawnSync(process.execPath, ['--input-type=module', '-e', harness, engineUrl, 'stop-denied'], { encoding: 'utf8', timeout: 12000, maxBuffer: 128 * 1024 });
  assert.equal(host.error, undefined); assert.equal(host.status, 0, host.stderr);
  const result = JSON.parse(host.stdout.trim());
  assert.equal(result.rejected, true); assert.equal(result.terminationFailed, true);
  assert.equal(result.errorCode, 'PROCESS_TERMINATION_FAILED');
  assert.equal(result.terminationErrorCode, 'EPERM');
  assert.equal(result.errno, -13); assert.ok(result.diagnostic.details.includes('errnoNumber=-13'));
  assert.equal(result.workerAlive, true); assert.equal(result.workerAliveAfterCleanup, false);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_PATH_OR_INPUT|PRIVATE_DENIAL/);
});


for (const failureKind of ['original-error', 'final-save-only', 'stop-guard']) {
  test(`prepare final persistence failure releases busy and preserves ${failureKind}`, async t => {
    const root = mkdtempSync(join(tmpdir(), 'voice-prepare-persistence-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const engine = new ManagedEngine({ root, platform: 'win32', arch: 'x64', osRelease: '10.0.19045' });
    const statePath = join(engine.root, 'setup-state.json');
    const blockSave = () => { rmSync(statePath, { force: true }); mkdirSync(statePath); };
    let readyCalls = 0, modelCalls = 0;
    engine.ready = () => { if (++readyCalls === 1) return false; if (failureKind === 'final-save-only') blockSave(); return true; };
    engine.model = async () => { modelCalls++; };
    const primary = Object.assign(Error('controlled first failure'), failureKind === 'stop-guard'
      ? { code: 'PROCESS_TERMINATION_FAILED', terminationFailed: true, terminationErrorCode: 'TASKKILL_TIMEOUT' }
      : { code: 'EACCES', errno: -13 });
    engine.speechEnv = async () => {
      if (failureKind === 'final-save-only') return;
      blockSave();
      if (failureKind === 'stop-guard') { engine.terminationFailed = true; engine.terminationFailure = { terminationErrorCode: 'TASKKILL_TIMEOUT' }; }
      throw primary;
    };
    await assert.rejects(engine.prepare('transcription'), error => {
      if (failureKind !== 'final-save-only') assert.equal(error, primary);
      else { assert.ok(error.diagnostic.details.some(value => value.startsWith('errnoNumber='))); assert.doesNotMatch(error.message, /voice-prepare-persistence-/); }
      return true;
    });
    assert.equal(engine.busy, null); assert.equal(engine.child, null);
    rmSync(statePath, { recursive: true, force: true });
    if (failureKind === 'stop-guard') {
      assert.equal(engine.terminationFailed, true);
      await assert.rejects(engine.prepare('transcription'), error => error.terminationFailed && error.terminationErrorCode === 'TASKKILL_TIMEOUT');
    } else {
      const previousCalls = modelCalls; readyCalls = 0;
      engine.ready = () => ++readyCalls > 1; engine.speechEnv = async () => {};
      await engine.prepare('transcription');
      assert.equal(modelCalls, previousCalls + 1);
      assert.equal(engine.busy, null); assert.equal(engine.terminationFailed, false);
      assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).transcription.state, 'ready');
    }
  });
}

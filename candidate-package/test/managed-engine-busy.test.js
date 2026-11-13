import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

// Fault injection is isolated in a real Node host so the main test process's
// filesystem imports cannot be changed. Native Windows lock tests cover the
// actual FileShare.None source of EBUSY separately.
const engineUrl = new URL('../src/managed-engine.js', import.meta.url).href;
const harness = String.raw`
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {spawn} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
const {ManagedEngine}=await import(process.argv[1]);
const mode=process.argv[2],root=fs.mkdtempSync(join(tmpdir(),'voice-busy-cancel-'));
let spawnCount=0,stopCount=0,attempts=0,worker,workerClosed=false,cancelPromise;
const engine=new ManagedEngine({root,platform:'win32',arch:'x64',osRelease:'10.0.19045',networkResolver:async()=>({proxyEnv:{}}),
 terminateTree:async()=>{stopCount++;return {ok:false,errorCode:'SHOULD_NOT_KILL_CLOSED_CHILD'};},
 spawnProcess:(exe,args,opts)=>{spawnCount++;worker=spawn(exe,args,opts);worker.once('close',()=>{workerClosed=true;queueMicrotask(()=>{cancelPromise=engine.cancelPrepare();});});return worker;}});
engine.controller=new AbortController();
const originalWrite=fs.writeFileSync,originalRename=fs.renameSync;
const busy=syscall=>Object.assign(Error('PRIVATE_PATH'),{code:'EBUSY',errno:-4082,syscall});
fs.writeFileSync=(path,...args)=>{if(mode==='before-spawn'&&String(path)===join(engine.root,'setup-command.log')){attempts++;throw busy('open');}return originalWrite(path,...args);};
fs.renameSync=(from,to)=>{if(mode==='after-close'&&String(to)===join(engine.root,'setup-state.json')){attempts++;throw busy('rename');}return originalRename(from,to);};
syncBuiltinESMExports();
if(mode==='after-close')engine.state.transcription={state:'preparing',progress:{phase:'connecting'}};
if(mode==='before-spawn')setTimeout(()=>{cancelPromise=engine.cancelPrepare();},30);
let error;const start=Date.now();
try{await engine.command(process.execPath,['-e','process.stdout.write("done\\n")'],{owner:mode==='after-close'?'transcription':undefined,timeoutMs:5000});}catch(e){error=e;}
await cancelPromise;const attemptsAtSettlement=attempts;await delay(130);
const result={mode,spawnCount,stopCount,workerClosed,errorCode:error?.code,message:error?.message,diagnostic:error?.diagnostic,terminationFailed:engine.terminationFailed,pending:engine.stateWriter.pending!==null,timer:engine.stateWriter.timer!==null,attemptsAtSettlement,attemptsAfter:attempts,elapsed:Date.now()-start};
fs.writeFileSync=originalWrite;fs.renameSync=originalRename;syncBuiltinESMExports();fs.rmSync(root,{recursive:true,force:true});console.log(JSON.stringify(result));
`;

for (const mode of ['before-spawn', 'after-close']) {
  test(`cancellation ${mode} drains busy file retries without killing a closed child`, () => {
    const host = spawnSync(process.execPath, ['--input-type=module', '-e', harness, engineUrl, mode], { encoding: 'utf8', timeout: 5000 });
    assert.equal(host.error, undefined); assert.equal(host.status, 0, host.stderr);
    const result = JSON.parse(host.stdout.trim());
    assert.equal(result.errorCode, 'USER_CANCELLED', JSON.stringify(result));
    assert.equal(result.spawnCount, mode === 'before-spawn' ? 0 : 1); assert.equal(result.stopCount, 0);
    assert.equal(result.workerClosed, mode === 'after-close'); assert.equal(result.terminationFailed, false);
    assert.equal(result.pending, false); assert.equal(result.timer, false);
    assert.equal(result.attemptsAfter, result.attemptsAtSettlement); assert.ok(result.elapsed < 1500);
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE_PATH|voice-busy-cancel-/);
  });
}

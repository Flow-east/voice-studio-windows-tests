// Execute one scenario in a separate real Node host. Windows FileShare.None,
// not an injected error, supplies the sharing violation under examination.
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir, release } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

if (process.platform !== 'win32') throw Error('This probe requires native Windows');
const [packageDir, role, mode = 'transient'] = process.argv.slice(2);
if (!['setup-log', 'setup-state'].includes(role) || !['transient', 'persistent'].includes(mode)) throw Error('Invalid probe scenario');
const { ManagedEngine } = await import(pathToFileURL(resolve(packageDir, 'src/managed-engine.js')));
const root = mkdtempSync(join(tmpdir(), 'voice-native-busy-'));
const goPath = join(root, 'go'), releasedPath = join(root, 'released'), stopPath = join(root, 'stop');
const workDonePath = join(root, 'work-done');
const sentinel = join(root, 'engine-v1', 'models', 'asr', 'cached-sentinel.bin');
const sentinelBytes = Buffer.from('SYNTHETIC_CACHED_BYTES_REMAIN_UNCHANGED');
const hash = b => createHash('sha256').update(b).digest('hex');
const live = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms));
let child, locker, workerClosed = false, workerExitCode, lockerClosed = false, lockReady = false, lockReleased = false;
let startWorkerResolve;
const started = new Promise(resolveStarted => { startWorkerResolve = resolveStarted; });
const workerSource = String.raw`
const { existsSync, writeFileSync } = require('node:fs');
const [go, released, done, mode] = process.argv.slice(1);
let began = 0, connected = false;
const progress = phase => process.stdout.write(JSON.stringify({type:'model_progress',kind:'asr',phase,source:'domestic'})+'\n');
const timer = setInterval(() => {
  if (!connected && existsSync(go)) { connected = true; began = Date.now(); progress('connecting'); }
  if (connected && existsSync(released)) {
    progress('downloading'); process.stderr.write('SYNTHETIC_WORKER_COMPLETED\n');
    writeFileSync(done, 'done'); clearInterval(timer);
  }
}, 20);
setTimeout(() => { clearInterval(timer); process.exit(31); }, 12000).unref();
`;
const engine = new ManagedEngine({ root, platform:'win32', arch:'x64', osRelease:release(),
  networkResolver:async()=>({proxyEnv:{}}), spawnProcess:(exe, args, options)=>{
    const proc = spawn(exe, args, options);
    if (exe === process.execPath) {
      child = proc; child.once('close', code=>{workerClosed = true; workerExitCode = code;}); startWorkerResolve();
    }
    return proc;
  }
});
engine.controller = new AbortController();
engine.update('transcription', 'synthetic checking', { progress:{phase:'checking',component:'asr',setupStep:'model'} });
mkdirSync(dirname(sentinel), {recursive:true}); writeFileSync(sentinel, sentinelBytes);
let workError, fulfilled = false, settledAt, captured = '';
const command = engine.command(process.execPath, ['-e', workerSource, goPath, releasedPath, workDonePath, mode], {
  owner:'transcription', modelKind:'asr', logName:'setup-model-asr.log', timeoutMs:8000, capture:true,
  onProgress:event=>engine.modelProgress('transcription', event),
}).then(output=>{fulfilled = true; captured = output; settledAt = Date.now();}, error=>{workError = error; settledAt = Date.now();});
let result;
try {
  await Promise.race([started, delay(4000).then(()=>{throw Error('Worker did not spawn');})]);
  const target = join(engine.root, role === 'setup-log' ? 'setup-model-asr.log' : 'setup-state.json');
  const powershell = join(process.env.SystemRoot || process.env.WINDIR, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  locker = spawn(powershell, ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',
    join(dirname(fileURLToPath(import.meta.url)), 'lock_file.ps1'), '-Path',target,
    '-ReleaseMarker',releasedPath, '-StopMarker',stopPath, '-HoldMs', mode==='persistent'?'15000':'1500'],
    {windowsHide:true, stdio:['ignore','pipe','pipe']});
  let lockerOutput = '', lockerError = '';
  locker.stdout.on('data', data=>{lockerOutput += data; if(lockerOutput.includes('LOCK_READY')) lockReady = true; if(lockerOutput.includes('LOCK_RELEASED')) lockReleased = true;});
  locker.stderr.on('data', data=>{lockerError += data;});
  locker.once('close', ()=>{lockerClosed = true;});
  const startWait = Date.now();
  while (!lockReady && !lockerClosed && Date.now()-startWait<6000) await delay(20);
  if (!lockReady) throw Error(`Locker did not acquire exclusive handle (exit=${locker.exitCode}, errorBytes=${lockerError.length})`);
  const triggeredAt = Date.now(); writeFileSync(goPath, 'go');
  await command;
  result = {platform:process.platform,osRelease:release(),node:process.version,role,mode,
    realFileShareNone:true,lockReady,lockReleasedAtSettlement:lockReleased,
    fulfilled,rejected:!!workError,elapsedMs:settledAt-triggeredAt,
    workerClosed,workerAlive:live(child.pid),workerExitCode,workerCompleted:existsSync(workDonePath),
    terminationFailed:engine.terminationFailed,childCleared:engine.child===null,stopCleared:engine.stopCommand===null,
    errorCode:workError?.code,errno:workError?.errno,syscall:workError?.syscall,
    diagnostic:workError?.diagnostic,
    cachedBytesUnchanged:readFileSync(sentinel).equals(sentinelBytes),cacheSha256:hash(readFileSync(sentinel)),
    progressPhase:engine.state.transcription?.progress?.phase,
    capturedConnecting:captured.includes('"phase":"connecting"'),
    capturedDownloading:captured.includes('"phase":"downloading"'),
    capturedWorkerCompletion:captured.includes('SYNTHETIC_WORKER_COMPLETED'),
    // Future candidate fields may be exposed as explicit safe diagnostics; do
    // not dump arbitrary engine state or filesystem paths into public output.
  };
} finally {
  writeFileSync(stopPath, 'stop');
  if (child && live(child.pid)) { child.kill('SIGKILL'); if(!workerClosed) await new Promise(resolveClose=>child.once('close', resolveClose)); }
  if (locker && !lockerClosed) await Promise.race([new Promise(resolveClose=>locker.once('close',resolveClose)),delay(3000)]);
  if (locker && !lockerClosed) locker.kill();
  await delay(50);
  if (result) {
    result.workerAliveAfterCleanup = child ? live(child.pid) : false; result.lockReleasedAfterCleanup = existsSync(releasedPath);
    const log = readFileSync(join(engine.root,'setup-model-asr.log'),'utf8');
    result.logContainsConnecting = log.includes('"phase":"connecting"');
    result.logContainsDownloading = log.includes('"phase":"downloading"');
    result.logContainsWorkerCompletion = log.includes('SYNTHETIC_WORKER_COMPLETED');
    result.persistedProgressPhase = JSON.parse(readFileSync(join(engine.root,'setup-state.json'),'utf8')).transcription?.progress?.phase;
  }
  rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});
}
console.log(JSON.stringify(result));

// Windows tasks own an OS Job before any target code can execute. A normal
// parent exit is not proof of tree exit: only the private supervisor's final
// job-empty receipt can release cancellation and cleanup guards.
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { win32 } from 'node:path';

const jobs = new WeakMap();
const OPERATIONS = new Set('parse_spec open_stdio create_job configure_job create_process resume_process query_job terminate_job wait_job read_control supervisor'.split(' '));
const uint = value => Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
const failure = (code, stage = 'confirm-exit', extra = {}) => ({ ok: false, terminationFailed: true, terminationMethod: 'windows-job', terminationStage: stage, terminationErrorCode: code, ...extra });
const success = () => ({ ok: true, terminationMethod: 'windows-job', terminationStage: 'confirm-exit', terminationExitCode: 0 });
let encodedScript;

function script() {
  if (!encodedScript) {
    encodedScript = Buffer.from(readFileSync(fileURLToPath(new URL('../runtime/windows-job.ps1', import.meta.url)), 'utf8').replace(/\r\n/g, '\n'), 'utf16le').toString('base64');
    if (encodedScript.length > 30000) { encodedScript = undefined; throw Object.assign(Error('Windows task supervisor exceeds command limit'), { code: 'E2BIG' }); }
  }
  return encodedScript;
}

export function spawnWindowsJob(executable, args, options, { spawnProcess, powershell, stopTimeoutMs = 15000 } = {}) {
  if (typeof executable !== 'string' || !executable || executable.includes('\0') || !Array.isArray(args) || args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw Object.assign(Error('Invalid process arguments'), { code: 'EINVAL' });
  const nonce = randomBytes(24).toString('hex'), prefix = `STUDIO_JOB_${nonce} `;
  const environment = Object.fromEntries(Object.entries(options.env ?? process.env).filter(([key]) => !key.toUpperCase().startsWith('VOICE_STUDIO_JOB_') && key.toUpperCase() !== 'PSMODULEPATH'));
  // A private environment omits PowerShell's module path. Implicit discovery
  // can stall on absent user/program-files locations. Set the OS module path
  // here and again in the script, because PowerShell rebuilds it at startup.
  environment.PSMODULEPATH = win32.join(win32.dirname(powershell), 'Modules');
  environment.VOICE_STUDIO_JOB_SPEC = Buffer.from(JSON.stringify({ executable, args, cwd: options.cwd ?? process.cwd(), nonce }), 'utf8').toString('base64');
  const raw = spawnProcess(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', script()], {
    ...options, shell: false, detached: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: environment,
  });
  const child = new EventEmitter(), stderr = new PassThrough();
  child.pid = raw.pid; child.stdout = raw.stdout ?? new PassThrough(); child.stderr = stderr;
  let nativeSpawned = false, nativeError, closed = false, terminal, protocolInvalid = false, pending = Buffer.alloc(0), discard = false, discardPrivate = false;
  let stopRequested = false, stopTimer, resolveStopped, stoppedResult;
  const stopped = new Promise(resolve => { resolveStopped = resolve; });
  const settleStopped = result => { if (stoppedResult) return; stoppedResult = result; clearTimeout(stopTimer); resolveStopped(result); };
  const accept = bytes => {
    const text = bytes.toString('utf8').replace(/\r$/, '');
    if (!text.startsWith(prefix)) { stderr.write(bytes); stderr.write('\n'); return; }
    try {
      const value = JSON.parse(text.slice(prefix.length));
      if (value.state === 'ready' && !terminal && !protocolInvalid) return;
      if (terminal || protocolInvalid) { protocolInvalid = true; return; }
      if (value.state === 'complete' && uint(value.exitCode) && typeof value.cancelled === 'boolean' && typeof value.spawned === 'boolean' && value.activeProcesses === 0) terminal = value;
      else if (value.state === 'error' && OPERATIONS.has(value.operation) && uint(value.winerror) && typeof value.spawned === 'boolean' && typeof value.jobEmpty === 'boolean') terminal = value;
      else protocolInvalid = true;
    } catch { protocolInvalid = true; }
  };
  // Buffer only a bounded line. Ordinary stderr keeps its bytes; a malformed
  // authenticated record is a failure, never a reason to trust wrapper exit.
  raw.stderr?.on('data', chunk => {
    pending = Buffer.concat([pending, chunk]);
    let end;
    while ((end = pending.indexOf(10)) >= 0) {
      const line = pending.subarray(0, end); pending = pending.subarray(end + 1);
      if (discard) { if (!discardPrivate) { stderr.write(line); stderr.write('\n'); } discard = false; discardPrivate = false; }
      else accept(line);
    }
    if (pending.length > 65536) {
      if (pending.subarray(0, prefix.length).toString('utf8') === prefix) { protocolInvalid = true; discardPrivate = true; }
      if (!discardPrivate) stderr.write(pending); pending = Buffer.alloc(0); discard = true;
    }
  });
  raw.stderr?.on('end', () => { if (pending.length) { if (discard) { if (!discardPrivate) stderr.write(pending); } else accept(pending); pending = Buffer.alloc(0); } stderr.end(); });
  raw.stdin?.on('error', () => { /* Completion may close control before a concurrent cancel; final receipt decides. */ });
  raw.once('spawn', () => { nativeSpawned = true; child.pid = raw.pid; child.emit('spawn'); });
  raw.once('error', error => {
    nativeError = error;
    if (!nativeSpawned && !raw.pid) child.emit('error', error);
  });
  raw.once('close', (code, signal) => {
    closed = true;
    if (!raw.stdout) child.stdout.end();
    if (!raw.stderr) stderr.end();
    if (nativeError && !nativeSpawned && !raw.pid) {
      settleStopped(success()); child.emit('close', code, signal); return;
    }
    let outcome, targetCode = null, error;
    if (!protocolInvalid && terminal?.state === 'complete' && code === 0) {
      targetCode = terminal.exitCode; outcome = success();
    } else if (!protocolInvalid && terminal?.state === 'error' && terminal.jobEmpty) {
      outcome = success();
      error = Object.assign(Error('Windows task failed after verified cleanup'), { code: terminal.spawned && ['query_job', 'terminate_job', 'wait_job', 'read_control', 'supervisor'].includes(terminal.operation) ? 'PROCESS_EXIT' : 'PROCESS_START_FAILED', winerror: terminal.winerror, terminationOperation: terminal.operation });
    } else {
      const extra = terminal?.state === 'error' ? { winerror: terminal.winerror, terminationOperation: terminal.operation } : {};
      outcome = failure(protocolInvalid ? 'WINDOWS_JOB_PROTOCOL_INVALID' : terminal?.state === 'error' ? 'WINDOWS_JOB_STOP_FAILED' : 'WINDOWS_JOB_UNCONFIRMED', 'confirm-exit', extra);
      error = Object.assign(Error('后台程序尚未确认停止'), { code: 'PROCESS_TERMINATION_FAILED', ...outcome });
    }
    settleStopped(outcome);
    if (error) child.emit('error', error);
    child.emit('exit', targetCode, signal);
    child.emit('close', targetCode, signal);
  });
  const stop = () => {
    if (stopRequested || closed) return stopped;
    stopRequested = true;
    try { raw.stdin.end('cancel\n'); } catch { /* Wait for an authenticated completion or timeout. */ }
    stopTimer = setTimeout(() => {
      // Killing this owned supervisor closes its non-inherited kill-on-close
      // Job handle. Without its final receipt we still retain the stop guard.
      try { raw.kill(); } catch {}
      settleStopped(failure('WINDOWS_JOB_TIMEOUT', 'confirm-exit'));
    }, stopTimeoutMs);
    return stopped;
  };
  jobs.set(child, { stop });
  if (options.stdio === 'ignore' || options.stdio?.[1] === 'ignore') child.stdout.resume();
  if (options.stdio === 'ignore' || options.stdio?.[2] === 'ignore') stderr.resume();
  return child;
}

export function stopWindowsJob(child) { return jobs.get(child)?.stop() ?? null; }

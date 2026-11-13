import { spawn } from 'node:child_process';
import { closeSync, openSync, writeSync } from 'node:fs';
import { win32 } from 'node:path';
import { spawnWindowsJob, stopWindowsJob } from './windows-job.js';
const LOG_LIMIT = 2 * 1024 * 1024;
const OS_ENV = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']);
const TERMINATION_METHODS = new Set(['taskkill', 'process-group', 'process', 'windows-job']);
const TERMINATION_OPERATIONS = new Set('parse_spec open_stdio create_job configure_job create_process resume_process query_job terminate_job wait_job read_control supervisor'.split(' '));
const TERMINATION_STAGES = new Set(['start', 'execute', 'confirm-exit']);
const TERMINATION_SIGNALS = new Set(['SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGABRT', 'SIGKILL', 'SIGSEGV', 'SIGPIPE', 'SIGALRM', 'SIGTERM', 'SIGBUS']);
const TERMINATION_CODES = new Set(['EACCES', 'EPERM', 'ESRCH', 'ENOENT', 'EINVAL', 'EIO', 'ENOMEM', 'ENOSYS', 'EAGAIN', 'EMFILE', 'ENFILE', 'INVALID_PROCESS_ID', 'WINDOWS_SYSTEMROOT_MISSING', 'TASKKILL_START_FAILED', 'TASKKILL_NONZERO_EXIT', 'TASKKILL_TIMEOUT', 'PROCESS_SIGNAL_FAILED', 'PROCESS_EXIT_NOT_CONFIRMED', 'PROCESS_TERMINATION_ERROR', 'PROCESS_TERMINATION_FAILED', 'REFERENCE_KILL_FAILED', 'REFERENCE_KILL_TIMEOUT']);
for (const code of ['WINDOWS_JOB_START_FAILED', 'WINDOWS_JOB_STOP_FAILED', 'WINDOWS_JOB_UNCONFIRMED', 'WINDOWS_JOB_TIMEOUT', 'WINDOWS_JOB_PROTOCOL_INVALID']) TERMINATION_CODES.add(code);
const exitCode = value => Number.isInteger(value) && value >= -2147483648 && value <= 4294967295;
// Only fixed tokens cross into state/diagnostics; never copy an OS message,
// command, PID, path or stderr. Accept old taskkill results during migration.
export function terminationDetails(value = {}) {
  const details = {};
  if (TERMINATION_METHODS.has(value.terminationMethod)) details.terminationMethod = value.terminationMethod;
  if (TERMINATION_STAGES.has(value.terminationStage)) details.terminationStage = value.terminationStage;
  if (TERMINATION_SIGNALS.has(value.terminationSignal)) details.terminationSignal = value.terminationSignal;
  const code = value.terminationErrorCode ?? value.errorCode;
  if (TERMINATION_CODES.has(code)) details.terminationErrorCode = code;
  const legacyExit = typeof code === 'string' && /^TASKKILL_EXIT_(-?\d{1,10})$/.exec(code);
  if (legacyExit && exitCode(Number(legacyExit[1]))) {
    details.terminationErrorCode = 'TASKKILL_NONZERO_EXIT';
    details.terminationExitCode = Number(legacyExit[1]);
  }
  if (exitCode(value.terminationExitCode)) details.terminationExitCode = value.terminationExitCode;
  if (TERMINATION_OPERATIONS.has(value.terminationOperation)) details.terminationOperation = value.terminationOperation;
  if (Number.isInteger(value.winerror) && value.winerror >= 0 && value.winerror <= 0xffffffff) details.winerror = value.winerror;
  return details;
}
export function privateProcessEnvironment(environment = process.env) {
  return Object.fromEntries(Object.entries(environment).filter(([name]) => OS_ENV.has(name.toUpperCase())).map(([name, value]) => [name.toUpperCase(), value]));
}
export function windowsSystemExecutable(name, environment = process.env) {
  const files = { taskkill: ['System32', 'taskkill.exe'], powershell: ['System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'], tar: ['System32', 'tar.exe'], curl: ['System32', 'curl.exe'], 'nvidia-smi': ['System32', 'nvidia-smi.exe'] };
  if (!files[name]) throw Object.assign(new Error('Unsupported Windows system executable'), { code: 'INVALID_SYSTEM_EXECUTABLE' });
  const variables = privateProcessEnvironment(environment), root = variables.SYSTEMROOT || variables.WINDIR;
  if (typeof root !== 'string' || !/^[A-Za-z]:[\\/]/.test(root) || /[\u0000-\u001f"<>|]/.test(root) || root.split(/[\\/]/).some(part => part === '.' || part === '..')) throw Object.assign(new Error('Windows system directory is unavailable'), { code: 'WINDOWS_SYSTEMROOT_MISSING' });
  return win32.join(root, ...files[name]);
}
export function killWindowsProcessTree(pid, { spawnProcess = spawn, environment = process.env, timeoutMs = 10000 } = {}) {
  return new Promise(resolve => {
    let child, timer, done = false;
    const finish = result => { if (done) return; done = true; clearTimeout(timer); resolve({ ...result, ...terminationDetails({ terminationMethod: 'taskkill', ...result }) }); };
    const failedStart = error => ({ ok: false, errorCode: terminationDetails({ errorCode: error?.code }).terminationErrorCode || 'TASKKILL_START_FAILED', terminationStage: 'start' });
    try {
      if (!Number.isSafeInteger(pid) || pid <= 0) throw Object.assign(new Error('Invalid process id'), { code: 'INVALID_PROCESS_ID' });
      child = spawnProcess(windowsSystemExecutable('taskkill', environment), ['/PID', String(pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore', env: privateProcessEnvironment(environment) });
      child.once('error', error => finish(failedStart(error)));
      child.once('close', (code, signal) => finish(code === 0 ? { ok: true, terminationStage: 'execute', terminationExitCode: 0 } : { ok: false, errorCode: exitCode(code) ? 'TASKKILL_EXIT_' + code : 'TASKKILL_NONZERO_EXIT', terminationErrorCode: 'TASKKILL_NONZERO_EXIT', terminationStage: 'execute', ...(exitCode(code) ? { terminationExitCode: code } : {}), ...terminationDetails({ terminationSignal: signal }) }));
      timer = setTimeout(() => { try { child.kill(); } catch {} finish({ ok: false, errorCode: 'TASKKILL_TIMEOUT', terminationStage: 'execute' }); }, timeoutMs);
    } catch (error) { finish(failedStart(error)); }
  });
}
// Custom spawn injection keeps existing test adapters deterministic. Native
// regression tests explicitly opt into the supervisor while tracking launches.
export function spawnOwnedProcess(executable, args, options, { platform = process.platform, spawnProcess = spawn, windowsJob = process.platform === 'win32' && platform === 'win32' && spawnProcess === spawn } = {}) {
  return platform === 'win32' && windowsJob
    ? spawnWindowsJob(executable, args, options, { spawnProcess, powershell: windowsSystemExecutable('powershell', options.env ?? process.env) })
    : spawnProcess(executable, args, options);
}
export function terminateWindowsProcess(child, { terminateTree = killWindowsProcessTree, ...options } = {}) {
  return stopWindowsJob(child) ?? terminateTree(child?.pid, options);
}
export function runProcess({ pythonPath, runnerPath, configPath, keyword, outputDir, logPath, timeoutMs, key = '', args }, { platform = process.platform, spawnProcess = spawn, environment = process.env, signalProcess = process.kill, windowsJob } = {}) {
  let child, done = false, cancelled = false, timedOut = false, logged = 0, buffered = '';
  let termination = null, pendingClose = null;
  let timer, killTimer, forceTimer, fd, finish;
  const promise = new Promise((resolve) => { finish = resolve; });
  const write = (value) => { if (fd === undefined || logged >= LOG_LIMIT) return; const safe = key ? value.split(key).join('[secret]') : value; const bytes = Buffer.from(safe).subarray(0, LOG_LIMIT - logged); try { writeSync(fd, bytes); logged += bytes.length; } catch {} };
  const log = (chunk) => { buffered += chunk.toString('utf8'); let idx; while ((idx = buffered.indexOf('\n')) >= 0) { write(buffered.slice(0, idx + 1)); buffered = buffered.slice(idx + 1); } if (buffered.length > LOG_LIMIT) { buffered = ''; write('[日志行过长，已省略]\n'); } };
  const signal = (name) => {
    const details = { terminationMethod: 'process-group', terminationStage: 'execute', terminationSignal: name };
    if (!child?.pid) return { ok: false, errorCode: 'INVALID_PROCESS_ID', ...details, terminationErrorCode: 'INVALID_PROCESS_ID' };
    try { signalProcess(-child.pid, name); return { ok: true, ...details }; }
    catch (error) { const code = terminationDetails({ errorCode: error.code }).terminationErrorCode || 'PROCESS_SIGNAL_FAILED'; return error.code === 'ESRCH' ? { ok: true, ...details } : { ok: false, errorCode: code, ...details, terminationErrorCode: code }; }
  };
  const settle = (result) => { if (done) return; if (termination) { if (!pendingClose || (!pendingClose.terminationFailed && (result.terminationFailed || !pendingClose.spawnError))) pendingClose = result; return; } done = true;
    if (cancelled && platform !== 'win32') { const stopped = signal('SIGKILL'); if (!stopped.ok && !result.terminationFailed) result = { ...result, terminationFailed: true, ...terminationDetails(stopped) }; }
    clearTimeout(timer); clearTimeout(killTimer); clearTimeout(forceTimer); write(buffered); buffered = ''; if (fd !== undefined) { closeSync(fd); fd = undefined; } finish({ ...result, cancelled, timedOut }); };
  const cancel = () => {
    if (done || cancelled) return;
    cancelled = true;
    if (platform === 'win32') {
      termination = terminateWindowsProcess(child, { spawnProcess, environment });
      void termination.then(result => {
        termination = null;
        if (!result.ok) {
          write(`[无法终止进程树：${result.errorCode}]\n`);
          settle({ ...(pendingClose ?? { code: null }), terminationFailed: true, ...terminationDetails(result) });
        } else if (pendingClose) settle(pendingClose);
        else forceTimer = setTimeout(() => settle({ code: null, terminationFailed: true, ...terminationDetails(result), terminationStage: 'confirm-exit', terminationErrorCode: 'PROCESS_EXIT_NOT_CONFIRMED' }), 2000);
      });
      return;
    }
    const first = signal('SIGTERM');
    if (!first.ok) return settle({ code: null, terminationFailed: true, ...terminationDetails(first) });
    killTimer = setTimeout(() => {
      const stopped = signal('SIGKILL');
      if (!stopped.ok) return settle({ code: null, terminationFailed: true, ...terminationDetails(stopped) });
      forceTimer = setTimeout(() => settle({ code: null, signal: 'SIGKILL', terminationFailed: true, ...terminationDetails(stopped), terminationStage: 'confirm-exit', terminationErrorCode: 'PROCESS_EXIT_NOT_CONFIRMED' }), 2000);
    }, 5000);
  };
  try {
    fd = openSync(logPath, 'wx', 0o600);
    const argv = args ?? ['--config', configPath, '--output', outputDir, '--', keyword];
    if (!Array.isArray(argv) || argv.some(value => typeof value !== 'string')) throw new Error('Invalid process arguments');
    // Managed inference receives no application credentials or unrelated service tokens.
    const env = args ? privateProcessEnvironment(environment) : { ...environment };
    Object.assign(env, { PYTHONUNBUFFERED: '1', PYTHONDONTWRITEBYTECODE: '1', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' });
    if (!args) env.VOICE_STUDIO_API_KEY = key;
    child = spawnOwnedProcess(pythonPath, [runnerPath, ...argv], { shell: false, detached: platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env }, { platform, spawnProcess, windowsJob });
    child.stdout.on('data', log); child.stderr.on('data', log);
    child.once('error', error => settle({ code: null, spawnError: true, errorCode: error.code, errorName: error.name, ...(error.terminationFailed ? { terminationFailed: true } : {}), ...terminationDetails(error) }));
    child.once('close', (code, termSignal) => settle({ code, signal: termSignal }));
    timer = setTimeout(() => { timedOut = true; cancel(); }, timeoutMs);
  } catch (error) { settle({ code: null, spawnError: true, errorCode: error.code, errorName: error.name }); }
  return { promise, cancel, get pid() { return child?.pid ?? null; } };
}

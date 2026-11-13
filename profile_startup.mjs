// Isolated Windows startup measurements. No model, network, account or user data.
// Each native launch is owned by this probe. Never target a PID discovered elsewhere.
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { release } from 'node:os';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const argv = process.argv.slice(2);
const option = name => { const i = argv.indexOf(name); return i < 0 ? undefined : argv[i + 1]; };
const packageDir = option('--package-dir'), destination = option('--output');
if (!packageDir || !destination) throw Error('Usage: node profile_startup.mjs --package-dir candidate-package --output profile.json [--self-check]');
const { privateProcessEnvironment } = await import(pathToFileURL(join(resolve(packageDir), 'src/process.js')).href);
const source = readFileSync(join(resolve(packageDir), 'runtime/windows-job.ps1'), 'utf8').replace(/\r\n/g, '\n');
const psTrace = 'function p($s){[Console]::Error.WriteLine("`nVSP $s $([Diagnostics.Stopwatch]::GetTimestamp()) $([Diagnostics.Stopwatch]::Frequency)")}\np "ps_entry"\n';
let full = psTrace + source;
const replaceOnce = (before, after) => {
  if (full.split(before).length !== 2) throw Error('PROFILE_SOURCE_CONTRACT_CHANGED');
  full = full.replace(before, after);
};
replaceOnce('$spec = ConvertFrom-Json -InputObject $json', '$spec = ConvertFrom-Json -InputObject $json\np "json"');
replaceOnce("Add-Type -TypeDefinition @'", 'p "add_type_begin"\nAdd-Type -TypeDefinition @\'');
replaceOnce("'@\n$invoked = $true", '\'@\np "add_type_end"\n$invoked = $true');
replaceOnce('static uint Active(P job)', 'static void T(string s){Console.Error.WriteLine("\\nVSP "+s+" "+Stopwatch.GetTimestamp()+" "+Stopwatch.Frequency);}\nstatic uint Active(P job)');
replaceOnce('public static int Run(string app,string[] args,string cwd,string n){', 'public static int Run(string app,string[] args,string cwd,string n){T("run");');
replaceOnce('op="read_control";ctl=new Control();', 'op="read_control";T("control_begin");ctl=new Control();T("control_end");');
replaceOnce('if(!CreateProcessW(app,cmd,P.Zero,P.Zero,true,0x08080404,env,cwd,ref si,out pi))throw Fail(op);', 'T("create_begin");if(!CreateProcessW(app,cmd,P.Zero,P.Zero,true,0x08080404,env,cwd,ref si,out pi))throw Fail(op);T("create_end");');
const tiny = psTrace + 'p "script_done"\nexit 0\n';
const trivial = psTrace + '$ErrorActionPreference="Stop"\np "add_type_begin"\nAdd-Type -TypeDefinition \'public static class StartupProfileTrivial { public static int Value(){return 1;} }\'\np "add_type_end"\np "script_done"\nexit 0\n';
const encode = text => Buffer.from(text, 'utf16le').toString('base64');
const quote = value => '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"';
const baseArgs = ['-NoLogo', '-NoProfile', '-NonInteractive'];
const powershell = join(process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const definitions = [
  { name: 'tiny_before', mode: 'encoded', script: tiny },
  { name: 'full_encoded', mode: 'encoded', script: full, full: true },
  { name: 'full_command', mode: 'command', script: full, full: true },
  { name: 'full_inherited_environment', mode: 'encoded', script: full, full: true, inherit: true },
  { name: 'trivial_add_type', mode: 'encoded', script: trivial },
  { name: 'tiny_after', mode: 'encoded', script: tiny },
].map(item => {
  const payload = item.mode === 'encoded' ? encode(item.script) : item.script;
  const args = [...baseArgs, item.mode === 'encoded' ? '-EncodedCommand' : '-Command', payload];
  const commandLineCharactersUpperBound = [powershell, ...args].map(quote).join(' ').length + 1;
  if ((item.mode === 'encoded' && payload.length >= 32500) || commandLineCharactersUpperBound >= 32767) throw Error('PROFILE_COMMAND_TOO_LONG');
  return { ...item, args, sourceCharacters: item.script.length, payloadCharacters: payload.length, commandLineCharactersUpperBound };
});
const output = {
  platform: process.platform, osRelease: release(), node: process.version,
  simulation: false, controlledSyntheticProcessesOnly: true, timeoutMsPerCase: 60000,
  sourceSha256NormalizedLf: createHash('sha256').update(source).digest('hex'),
  stagesUseMonotonicClock: true, cases: [],
};
const save = () => writeFileSync(destination, JSON.stringify(output, null, 2) + '\n');
const metadata = item => ({ name: item.name, mode: item.mode, environment: item.inherit ? 'runner-inherited' : 'os-only', sourceCharacters: item.sourceCharacters,
  payloadCharacters: item.payloadCharacters, commandLineCharactersUpperBound: item.commandLineCharactersUpperBound });
if (argv.includes('--self-check')) {
  output.status = 'static_self_check_only'; output.simulation = true;
  output.cases = definitions.map(metadata); save(); process.exit(0);
}
if (process.platform !== 'win32') { output.status = 'refused_non_windows'; save(); process.exit(2); }

const STAGES = new Set(['ps_entry', 'json', 'add_type_begin', 'add_type_end', 'run', 'control_begin', 'control_end', 'create_begin', 'create_end', 'script_done']);
const round = value => Math.round(value * 1000) / 1000;
async function run(item) {
  const record = { ...metadata(item), stages: [], targetObserved: false, completeProof: false, timedOut: false };
  const nonce = randomBytes(24).toString('hex'), prefix = `STUDIO_JOB_${nonce} `;
  const environment = Object.fromEntries(Object.entries(item.inherit ? process.env : privateProcessEnvironment(process.env)).filter(([key]) => !key.toUpperCase().startsWith('VOICE_STUDIO_JOB_')));
  if (item.full) environment.VOICE_STUDIO_JOB_SPEC = Buffer.from(JSON.stringify({
    executable: process.execPath,
    args: ['-e', "process.stdout.write('VSP_TARGET '+process.pid+'\\n',()=>process.exit(0))"],
    cwd: process.cwd(), nonce,
  }), 'utf8').toString('base64');
  const started = performance.now(); let child, deadline, cancelTimer, settled = false, firstTick, previousTick, frequency, terminal;
  let droppedOutputBytes = 0, targetPid, buffers = { stdout: '', stderr: '' };
  const time = () => round(performance.now() - started);
  return await new Promise(resolveCase => {
    const finish = () => {
      if (settled) return; settled = true; clearTimeout(deadline); clearTimeout(cancelTimer);
      record.totalMs = time(); record.suppressedOutputBytes = droppedOutputBytes;
      record.completeProof = terminal?.state === 'complete' && terminal.activeProcesses === 0 && terminal.exitCode === 0 && terminal.spawned === true && terminal.cancelled === false && record.exitCode === 0;
      if (terminal?.state === 'error') record.supervisorError = terminal;
      const required = item.full ? ['ps_entry', 'json', 'add_type_begin', 'add_type_end', 'run', 'control_begin', 'control_end', 'create_begin', 'create_end'] : item.name === 'trivial_add_type' ? ['ps_entry', 'add_type_begin', 'add_type_end', 'script_done'] : ['ps_entry', 'script_done'];
      record.passed = !record.timedOut && record.exitCode === 0 && required.every(stage => record.stages.some(x => x.stage === stage)) && (!item.full || (record.targetObserved && record.completeProof));
      // Keep ownership internal: no PID, nonce, executable, arguments or raw output in results.
      targetPid = undefined; resolveCase(record);
    };
    const accept = (line, channel) => {
      line = line.replace(/\r$/, '');
      const trace = /^VSP ([a-z_]+) (\d+) (\d+)$/.exec(line);
      if (trace && STAGES.has(trace[1])) {
        const tick = BigInt(trace[2]), hz = BigInt(trace[3]);
        if (hz <= 0n || (frequency !== undefined && frequency !== hz) || (previousTick !== undefined && tick < previousTick)) { record.clockInvalid = true; return; }
        frequency = hz; firstTick ??= tick;
        record.stages.push({ stage: trace[1], receivedMs: time(), sincePsEntryMs: round(Number(tick - firstTick) * 1000 / Number(hz)), sincePreviousStageMs: previousTick === undefined ? null : round(Number(tick - previousTick) * 1000 / Number(hz)) });
        previousTick = tick; return;
      }
      const target = /^VSP_TARGET (\d+)$/.exec(line);
      if (channel === 'stdout' && item.full && target) {
        targetPid = Number(target[1]); record.targetObserved = Number.isSafeInteger(targetPid) && targetPid > 0 && targetPid !== child.pid && targetPid !== process.pid; return;
      }
      if (channel === 'stderr' && item.full && line.startsWith(prefix)) {
        try {
          const value = JSON.parse(line.slice(prefix.length));
          if (value.state === 'complete') terminal = { state: 'complete', activeProcesses: value.activeProcesses, exitCode: value.exitCode, spawned: value.spawned, cancelled: value.cancelled };
          else if (value.state === 'error') {
            const operations = new Set('parse_spec open_stdio create_job configure_job create_process resume_process query_job terminate_job wait_job read_control supervisor'.split(' '));
            terminal = { state: 'error', operation: operations.has(value.operation) ? value.operation : 'unknown', winerror: Number.isSafeInteger(value.winerror) ? value.winerror : null, spawned: value.spawned === true, jobEmpty: value.jobEmpty === true };
          }
        } catch { record.protocolInvalid = true; }
        return;
      }
      if (line) droppedOutputBytes += Buffer.byteLength(line);
    };
    const collect = (channel, chunk) => {
      buffers[channel] += chunk.toString('utf8'); let end;
      while ((end = buffers[channel].indexOf('\n')) >= 0) { accept(buffers[channel].slice(0, end), channel); buffers[channel] = buffers[channel].slice(end + 1); }
      if (buffers[channel].length > 65536) { droppedOutputBytes += Buffer.byteLength(buffers[channel]); buffers[channel] = ''; }
    };
    try { child = spawn(powershell, item.args, { shell: false, windowsHide: true, detached: false, stdio: ['pipe', 'pipe', 'pipe'], env: environment }); }
    catch { record.startFailure = true; finish(); return; }
    child.stdin.on('error', () => {});
    child.stdout.on('data', chunk => collect('stdout', chunk));
    child.stderr.on('data', chunk => collect('stderr', chunk));
    child.once('spawn', () => { record.nativeSpawnMs = time(); });
    child.once('error', error => { record.startErrorCode = typeof error.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) ? error.code : 'UNKNOWN'; });
    child.once('exit', (code, signal) => { record.exitCode = code; record.exitSignal = signal; record.nativeExitMs = time(); });
    child.once('close', () => {
      for (const channel of ['stdout', 'stderr']) if (buffers[channel]) accept(buffers[channel], channel);
      finish();
    });
    // The full program's child is atomically in its private kill-on-close Job.
    // Only send control to / terminate the exact ChildProcess created above.
    if (item.full) cancelTimer = setTimeout(() => { record.cancelSentMs = time(); try { child.stdin.end('cancel\n'); } catch {} }, 52000);
    deadline = setTimeout(() => {
      record.timedOut = true; record.ownedSupervisorKillRequested = true;
      try { record.ownedSupervisorKillAccepted = child.kill('SIGKILL'); } catch { record.ownedSupervisorKillAccepted = false; }
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.unref(); finish();
    }, 60000);
  });
}
for (const definition of definitions) { output.cases.push(await run(definition)); output.status = 'running'; save(); }
output.status = output.cases.every(item => item.passed && !item.clockInvalid && !item.protocolInvalid) ? 'passed' : 'failed';
save(); console.log(JSON.stringify({ status: output.status, cases: output.cases.map(item => ({ name: item.name, passed: item.passed, totalMs: item.totalMs })) }));
if (output.status !== 'passed') process.exitCode = 1;

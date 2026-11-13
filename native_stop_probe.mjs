// Native Windows observations of published process teardown logic.
// Only PIDs created by this probe may be passed to taskkill. No image-name kill.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';
import { tmpdir, release } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const flags = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, values) => {
  if (value.startsWith('--')) pairs.push([value.slice(2), values[index + 1]]);
  return pairs;
}, []));
if ((!flags['package-dir'] && !flags.source) || !flags.output) throw Error('Usage: node termination_probe.mjs --package-dir extracted/package --output results.json');
const output = { platform: process.platform, osRelease: release(), node: process.version, simulation: false, cases: [] };
const save = () => writeFileSync(flags.output, JSON.stringify(output, null, 2) + '\n');
if (process.platform !== 'win32') {
  output.status = 'refused_non_windows'; save(); console.log('REFUSED: native Windows required.'); process.exit(2);
}
const source = flags['package-dir'] ? resolve(flags['package-dir'], 'src') : resolve(flags.source);
const processModule = await import(pathToFileURL(join(source, 'process.js')).href);
output.sourceSha256 = Object.fromEntries(['process.js'].map(name => [name,
  createHash('sha256').update(readFileSync(join(source, name))).digest('hex')]));
const fixture = join(dirname(fileURLToPath(import.meta.url)), 'termination_worker.mjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = pid => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
const safe = value => Object.fromEntries(['code', 'cancelled', 'timedOut', 'terminationFailed', 'terminationMethod', 'terminationStage', 'terminationErrorCode', 'terminationExitCode', 'terminationSignal'].filter(k => value?.[k] !== undefined).map(k => [k, value[k]]));
async function until(predicate, milliseconds = 5000) {
  const end = Date.now() + milliseconds;
  while (!predicate()) { if (Date.now() > end) throw Error('PROBE_WAIT_TIMEOUT'); await pause(10); }
}
async function bounded(promise, milliseconds = 12000) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('PROBE_RESULT_TIMEOUT')), milliseconds); })]); }
  finally { clearTimeout(timer); }
}

async function runCase(facade, mode) {
  const directory = mkdtempSync(join(tmpdir(), 'voice-stop-probe-'));
  const started = Date.now(), timeline = [];
  const mark = (event, extra = {}) => timeline.push({ milliseconds: Date.now() - started, event, ...extra });
  let main, stop, work, leafPid, paused = false, resumeTimer;
  let directExited = false, directClosed = false, taskkillCode;
  const result = { facade, mode, onlyOwnedProcessTargets: true };
  const trackedSpawn = (executable, args, options) => {
    const killer = basename(executable).toLowerCase() === 'taskkill.exe';
    if (killer) {
      assert(main && args[args.indexOf('/PID') + 1] === String(main.pid), 'PROBE_REFUSED_NONOWNED_PID');
      mark('taskkill-spawn', { directExited, directClosed });
    } else {
      assert(executable === process.execPath && args.includes(fixture), 'PROBE_REFUSED_UNEXPECTED_COMMAND');
    }
    const child = spawn(executable, args, options);
    if (killer) child.once('close', code => { taskkillCode = code; mark('taskkill-close', { code }); });
    else {
      main = child;
      child.once('exit', (code, signal) => {
        directExited = true; mark('direct-exit', { code, signal });
        if (mode.startsWith('exit-')) { mark('cancel-at-exit'); void Promise.resolve(stop()).catch(error => mark('cancel-rejected', safe(error))); }
      });
      child.once('close', (code, signal) => { directClosed = true; mark('direct-close', { code, signal }); });
      child.stdout.once('end', () => mark('stdout-end'));
      child.stdout.once('close', () => mark('stdout-close'));
      child.stderr.once('close', () => mark('stderr-close'));
    }
    return child;
  };
  try {
    const running = processModule.runProcess({ pythonPath: process.execPath, runnerPath: fixture,
      args: [mode, directory], logPath: join(directory, 'worker.log'), timeoutMs: 10000 }, { spawnProcess: trackedSpawn });
    work = running.promise; stop = () => running.cancel();
    await until(() => existsSync(join(directory, 'parent.ready')));
    if (mode === 'tree' || mode === 'exit-with-descendant') {
      await until(() => existsSync(join(directory, 'leaf.ready')));
      leafPid = Number(readFileSync(join(directory, 'leaf.pid'), 'utf8'));
      assert(Number.isSafeInteger(leafPid) && leafPid > 0 && leafPid !== process.pid);
      mark('known-descendant-ready');
    }
    if (mode.startsWith('exit-')) writeFileSync(join(directory, 'exit-parent'), 'go');
    else {
      if (mode === 'paused-stdio') {
        main.stdout.pause(); paused = true; mark('pause-real-stdout');
        // This deliberately controls a real stream, never emits fake close or
        // exit events. It tests whether process exit and pipe close differ.
        resumeTimer = setTimeout(() => { main.stdout.resume(); paused = false; mark('resume-real-stdout'); }, 3200);
      }
      mark('cancel-live-parent'); void Promise.resolve(stop()).catch(error => mark('cancel-rejected', safe(error)));
    }
    const settled = await bounded(work);
    mark('operation-settled', safe(settled));
    result.result = safe(settled);
    result.directExitedAtSettlement = directExited;
    result.directClosedAtSettlement = directClosed;
    result.knownDescendantAliveAtSettlement = alive(leafPid);
    result.taskkillExitCode = taskkillCode;
    if (mode === 'exit-with-descendant') assert(result.knownDescendantAliveAtSettlement, 'ORPHAN_CONTROL_NOT_ESTABLISHED');
    if (mode === 'tree') assert(!settled.terminationFailed && directClosed && !alive(leafPid), 'CONTROL_TREE_STOP_FAILED');
    if (mode === 'exit-clean' && settled.terminationFailed && directClosed) result.classification = 'parent-exit-race-without-descendants';
    else if (result.knownDescendantAliveAtSettlement) result.classification = 'known-descendant-still-alive';
    else if (settled.terminationStage === 'confirm-exit' && directExited && !directClosed) result.classification = 'stdio-close-confirmation-gap';
    else result.classification = settled.terminationFailed ? 'other-observed-stop-failure' : mode === 'paused-stdio' ? 'stdio-gap-not-reproduced' : 'confirmed-stop';
  } catch (error) {
    result.harnessError = { name: error.name, code: error.code ?? null,
      token: ['PROBE_WAIT_TIMEOUT', 'PROBE_RESULT_TIMEOUT'].includes(error.message) ? error.message : 'PROBE_ASSERTION_OR_RUNTIME_ERROR' };
  } finally {
    clearTimeout(resumeTimer);
    if (paused) { main?.stdout.resume(); mark('cleanup-resume-stdout'); }
    // Ask only our fixtures to exit; each also has a 15-second hard lifespan.
    writeFileSync(join(directory, 'stop-parent'), 'stop'); writeFileSync(join(directory, 'stop-leaf'), 'stop');
    if (main && !directExited) main.kill();
    try { await until(() => !alive(leafPid) && (!main || directClosed), 6000); }
    catch { result.cleanupIncomplete = true; }
    result.allKnownFixturesStopped = !alive(leafPid) && (!main || directExited);
    result.timeline = timeline;
    try { rmSync(directory, { recursive: true, force: true }); } catch { result.temporaryDirectoryCleanupFailed = true; }
  }
  return result;
}

try {
  for (const mode of ['tree', 'exit-clean', 'exit-with-descendant', 'paused-stdio']) output.cases.push(await runCase('runProcess', mode));
  output.status = output.cases.every(row => !row.harnessError && row.allKnownFixturesStopped && !row.cleanupIncomplete) ? 'observations-complete' : 'probe-incomplete';
} catch (error) { output.status = 'harness-error'; output.harnessError = { name: error.name, code: error.code ?? null }; }
save(); console.log(JSON.stringify({ status: output.status, cases: output.cases.map(({facade,mode,classification,harnessError}) => ({facade,mode,classification,harnessError})) }));
process.exitCode = output.status === 'observations-complete' ? 0 : 1;

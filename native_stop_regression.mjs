// Native Windows regression observations using only controlled child processes.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { release, tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const argv = process.argv.slice(2), option = key => argv[argv.indexOf(key) + 1];
const packageDir = option('--package-dir'), destination = option('--output'), role = option('--role');
if (!argv.includes('--package-dir') || !argv.includes('--output') || !['baseline', 'candidate'].includes(role)) throw Error('Usage: node native_stop_regression.mjs --package-dir package --role baseline|candidate --output results.json');
const output = { platform: process.platform, osRelease: release(), node: process.version, role, cases: [] };
const save = () => writeFileSync(destination, JSON.stringify(output, null, 2) + '\n');
if (process.platform !== 'win32') { output.status = 'refused_non_windows'; save(); process.exit(2); }
const source = join(resolve(packageDir), 'src/process.js');
const { runProcess } = await import(pathToFileURL(source).href);
output.sourceSha256 = createHash('sha256').update(readFileSync(source)).digest('hex');
output.windowsJobRequested = role === 'candidate';
if (role === 'candidate') {
  output.jobSourceHashes = Object.fromEntries(['src/windows-job.js', 'runtime/windows-job.ps1'].map(name => [name,
    createHash('sha256').update(readFileSync(join(resolve(packageDir), name))).digest('hex')]));
}
const fixture = join(dirname(fileURLToPath(import.meta.url)), 'stop_fixture.mjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = pid => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
const safe = value => Object.fromEntries(['code', 'cancelled', 'timedOut', 'spawnError', 'errorCode', 'terminationFailed', 'terminationMethod', 'terminationStage', 'terminationErrorCode', 'terminationExitCode'].filter(k => value?.[k] !== undefined).map(k => [k, value[k]]));
async function until(predicate, timeout = 15000) { const end = Date.now() + timeout; while (!predicate()) { if (Date.now() > end) throw Error('PROBE_WAIT_TIMEOUT'); await pause(10); } }
async function bounded(promise, timeout = 20000) { let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('PROBE_RESULT_TIMEOUT')), timeout); })]); } finally { clearTimeout(timer); } }

async function runCase(mode) {
  const directory = mkdtempSync(join(tmpdir(), 'voice-stop-regression-'));
  const started = Date.now(), events = [];
  const mark = (event, extra = {}) => events.push({ milliseconds: Date.now() - started, event, ...extra });
  const readPid = name => { const file = join(directory, name + '.pid'); return existsSync(file) ? Number(readFileSync(file, 'utf8')) : null; };
  const records = { mode, passed: false, controlledProcessesOnly: true };
  let native, running, nativeSpawned = false, directExited = false, directClosed = false, parentPid, leafPid;
  const spawned = new Set();
  const spawnProcess = (executable, args, options) => {
    const killer = basename(executable).toLowerCase() === 'taskkill.exe';
    if (killer) {
      const target = Number(args[args.indexOf('/PID') + 1]);
      assert(spawned.has(target) || target === readPid('parent') || target === readPid('leaf'), 'PROBE_REFUSED_NONOWNED_KILL');
      mark('taskkill-spawn');
    }
    const child = spawn(executable, args, options);
    if (child.pid) spawned.add(child.pid);
    if (!native && !killer) {
      native = child;
      nativeSpawned = Number.isSafeInteger(child.pid) && child.pid > 0;
      child.once('exit', (code, signal) => {
        directExited = true; mark('returned-child-exit', { code, signal });
        if (mode === 'exit-clean') { mark('cancel-at-returned-child-exit'); running?.cancel(); }
      });
      child.once('close', (code, signal) => { directClosed = true; mark('returned-child-close', { code, signal }); });
    }
    if (killer) child.once('close', code => mark('taskkill-close', { code }));
    return child;
  };
  try {
    const missing = mode === 'missing-executable-immediate-cancel';
    running = runProcess({ pythonPath: missing ? join(directory, 'definitely-missing.exe') : process.execPath,
      runnerPath: fixture, args: [mode, directory], logPath: join(directory, 'worker.log'), timeoutMs: 12000 },
      { spawnProcess, ...(role === 'candidate' ? { windowsJob: true } : {}) });
    if (missing) { mark('cancel-after-real-spawn-attempt'); running.cancel(); }
    else {
      await until(() => existsSync(join(directory, 'parent.ready')));
      parentPid = readPid('parent');
      assert(Number.isSafeInteger(parentPid) && parentPid > 0 && parentPid !== process.pid);
      if (mode === 'tree' || mode === 'exit-with-independent-descendant' || mode === 'supervisor-killed') {
        await until(() => existsSync(join(directory, 'leaf.ready')));
        leafPid = readPid('leaf');
        assert(Number.isSafeInteger(leafPid) && leafPid > 0 && leafPid !== process.pid);
      }
      if (mode === 'supervisor-killed') {
        assert(native && native.pid !== parentPid, 'PROBE_SUPERVISOR_MUST_DIFFER_FROM_WORKER');
        mark('force-kill-owned-supervisor'); native.kill('SIGKILL');
      } else if (mode === 'tree') { mark('cancel-live-tree'); running.cancel(); }
      else {
        writeFileSync(join(directory, 'exit-parent'), 'go');
        if (mode === 'exit-with-independent-descendant') {
          await until(() => !alive(parentPid));
          records.independentDescendantAliveBeforeCancel = alive(leafPid);
          mark('cancel-after-business-parent-exit', { leafAlive: records.independentDescendantAliveBeforeCancel });
          running.cancel();
        }
      }
    }
    const result = await bounded(running.promise);
    records.result = safe(result);
    records.businessParentAliveAtSettlement = alive(parentPid);
    records.independentDescendantAliveAtSettlement = alive(leafPid);
    records.returnedChildExitedAtSettlement = directExited;
    records.returnedChildClosedAtSettlement = directClosed;
    records.returnedChildAliveAtSettlement = nativeSpawned && alive(native?.pid);
    records.passed = !result.terminationFailed && !alive(parentPid) && !alive(leafPid) && !records.returnedChildAliveAtSettlement;
    if (mode === 'missing-executable-immediate-cancel') records.passed &&= !existsSync(join(directory, 'parent.ready'));
    if (mode === 'supervisor-killed') {
      // TerminateProcess on our own host is an explicit crash injection, not
      // an attempt to change Windows permissions or kill unrelated processes.
      try { await until(() => !alive(parentPid) && !alive(leafPid), 2000); }
      catch { records.workersSurvivedSupervisorLoss = true; }
      records.workerTreeStoppedAfterSupervisorLoss = !alive(parentPid) && !alive(leafPid);
      records.passed = result.terminationFailed === true && result.terminationMethod === 'windows-job'
        && result.terminationErrorCode === 'WINDOWS_JOB_UNCONFIRMED'
        && records.workerTreeStoppedAfterSupervisorLoss && !records.returnedChildAliveAtSettlement;
    }
    mark('operation-settled', { passed: records.passed, ...safe(result) });
  } catch (error) {
    records.harnessError = { name: error.name, code: error.code ?? null,
      token: ['PROBE_WAIT_TIMEOUT', 'PROBE_RESULT_TIMEOUT'].includes(error.message) ? error.message : 'PROBE_ASSERTION_OR_RUNTIME_ERROR' };
  } finally {
    // Cleanup only fixtures created here. The leaf also self-exits in 15 seconds.
    writeFileSync(join(directory, 'stop-parent'), 'stop'); writeFileSync(join(directory, 'stop-leaf'), 'stop');
    if (native && nativeSpawned && !directExited) native.kill();
    parentPid ??= readPid('parent'); leafPid ??= readPid('leaf');
    try { await until(() => !alive(parentPid) && !alive(leafPid) && (!native || directClosed), 6000); }
    catch { records.cleanupIncomplete = true; }
    records.allKnownFixturesStopped = !alive(parentPid) && !alive(leafPid) && (!native || !nativeSpawned || directExited);
    records.events = events;
    try { rmSync(directory, { recursive: true, force: true }); } catch { records.cleanupDirectoryFailed = true; }
  }
  return records;
}

for (const mode of ['tree', 'exit-clean', 'exit-with-independent-descendant', 'missing-executable-immediate-cancel']) output.cases.push(await runCase(mode));
if (role === 'candidate') output.cases.push(await runCase('supervisor-killed'));
output.observationsComplete = output.cases.every(row => !row.harnessError && row.allKnownFixturesStopped && !row.cleanupIncomplete);
output.behaviorCasesPassed = output.cases.every(row => row.passed);
output.terminationFailureInjection = role === 'candidate' ? 'owned-supervisor-terminated-without-confirmation' : 'not-applicable-to-baseline';
output.status = !output.observationsComplete ? 'probe-incomplete' : output.behaviorCasesPassed ? 'behavior-cases-passed' : 'behavior-failures-observed';
save(); console.log(JSON.stringify({ status: output.status, role, cases: output.cases.map(({mode,passed,result}) => ({mode,passed,result})) }));
process.exitCode = output.observationsComplete && (role === 'baseline' || output.behaviorCasesPassed) ? 0 : 1;

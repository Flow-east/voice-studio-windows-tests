// Native integration coverage for ManagedEngine.command; no model/network work.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { release, tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const argv = process.argv.slice(2), value = key => argv[argv.indexOf(key) + 1];
if (!argv.includes('--package-dir') || !argv.includes('--output')) throw Error('Usage: node native_managed_stop_regression.mjs --package-dir candidate --output results.json');
const packageDir = resolve(value('--package-dir')), destination = value('--output');
const report = { platform: process.platform, osRelease: release(), node: process.version, windowsJobRequested: true, cases: [] };
const save = () => writeFileSync(destination, JSON.stringify(report, null, 2) + '\n');
if (process.platform !== 'win32') { report.status = 'refused_non_windows'; save(); process.exit(2); }
const { ManagedEngine } = await import(pathToFileURL(join(packageDir, 'src/managed-engine.js')).href);
report.sourceHashes = Object.fromEntries(['src/managed-engine.js', 'src/process.js', 'src/windows-job.js', 'runtime/windows-job.ps1'].map(name => [name,
  createHash('sha256').update(readFileSync(join(packageDir, name))).digest('hex')]));
const fixture = join(dirname(fileURLToPath(import.meta.url)), 'stop_fixture.mjs');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const alive = pid => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
const safe = value => Object.fromEntries(['code', 'terminationFailed', 'terminationMethod', 'terminationStage', 'terminationErrorCode', 'terminationExitCode'].filter(key => value?.[key] !== undefined).map(key => [key, value[key]]));
async function until(predicate, timeout = 15000) { const end = Date.now() + timeout; while (!predicate()) { if (Date.now() > end) throw Error('PROBE_WAIT_TIMEOUT'); await pause(10); } }
async function bounded(work, timeout = 20000) { let timer; try { return await Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('PROBE_RESULT_TIMEOUT')), timeout); })]); } finally { clearTimeout(timer); } }

async function scenario(label) {
  const root = mkdtempSync(join(tmpdir(), 'voice-managed-中文 空间-')), runs = [], supervisors = [], events = [];
  const began = Date.now(), mark = (event, detail = {}) => events.push({ milliseconds: Date.now() - began, event, ...detail });
  const row = { label, passed: false, controlledProcessesOnly: true };
  const spawnProcess = (executable, args, options) => {
    const child = spawn(executable, args, options);
    supervisors.push(child);
    child.once('exit', (code, signal) => mark('supervisor-exit', { code, signal }));
    child.once('close', (code, signal) => mark('supervisor-close', { code, signal }));
    return child;
  };
  const engine = new ManagedEngine({ root, packageDir, platform: 'win32', arch: process.arch,
    osRelease: release(), windowsJob: true, spawnProcess, parentEnv: process.env,
    networkResolver: async () => ({ proxyEnv: {} }) });
  const pid = (directory, name) => { const path = join(directory, name + '.pid'); return existsSync(path) ? Number(readFileSync(path, 'utf8')) : null; };
  const noneAlive = directory => !alive(pid(directory, 'parent')) && !alive(pid(directory, 'leaf'));
  const launch = (mode, suffix) => {
    const directory = join(root, suffix); mkdirSync(directory); runs.push(directory);
    engine.controller = new AbortController();
    let settled;
    const work = engine.command(process.execPath, [fixture, mode, directory], { capture: true, timeoutMs: 15000 })
      .then(text => ({ resolved: true, outputContainsReady: text.includes('FIXTURE_READY') }),
        error => ({ resolved: false, ...safe(error) }))
      .then(result => { settled = result; return result; });
    return { directory, work, get result() { return settled; } };
  };
  try {
    const mode = label === 'normal-exit-zero' ? 'exit-clean' : label === 'live-tree-cancel' ? 'tree' : 'exit-with-independent-descendant';
    const current = launch(mode, 'first');
    await until(() => existsSync(join(current.directory, 'parent.ready')) || current.result !== undefined);
    if (!existsSync(join(current.directory, 'parent.ready'))) { row.commandResult = current.result; throw Error('PROBE_BUSINESS_NOT_STARTED'); }
    row.windowsJobHostObserved = supervisors.at(-1)?.pid !== pid(current.directory, 'parent');
    if (mode !== 'exit-clean') await until(() => existsSync(join(current.directory, 'leaf.ready')));
    if (label === 'normal-exit-zero') writeFileSync(join(current.directory, 'exit-parent'), 'go');
    else {
      if (label === 'parent-exit-independent-descendant-then-retry') {
        writeFileSync(join(current.directory, 'exit-parent'), 'go');
        await until(() => !alive(pid(current.directory, 'parent')));
        row.independentDescendantAliveBeforeCancel = alive(pid(current.directory, 'leaf'));
      }
      mark('cancel-prepare');
      row.cancelResult = await bounded(engine.cancelPrepare().then(() => ({ resolved: true }), error => ({ resolved: false, ...safe(error) })));
    }
    row.commandResult = await bounded(current.work);
    if (label === 'normal-exit-zero') {
      const values = ['中文 空格', 'double"quote', 'C:\\trailing path\\', '$(literal); & data'];
      const actual = await engine.command(process.execPath, ['-e', 'console.log(JSON.stringify({args:process.argv.slice(1),controls:Object.keys(process.env).filter(k=>k.startsWith("VOICE_STUDIO_JOB_"))}))', ...values], { capture: true, timeoutMs: 15000 });
      const roundTrip = JSON.parse(actual.trim());
      row.argumentRoundTrip = JSON.stringify(roundTrip.args) === JSON.stringify(values);
      row.privateControlStripped = Array.isArray(roundTrip.controls) && roundTrip.controls.length === 0;
      if (!row.argumentRoundTrip || !row.privateControlStripped) throw Error('PROBE_ARGUMENT_MISMATCH');
    }

    row.terminationGuardAfterFirst = engine.terminationFailed;
    row.firstWorkerTreeStopped = noneAlive(current.directory);
    row.firstSupervisorStopped = supervisors.every(child => child.exitCode !== null || child.signalCode !== null);
    if (label === 'parent-exit-independent-descendant-then-retry') {
      const next = launch('exit-clean', 'retry');
      await until(() => existsSync(join(next.directory, 'parent.ready')));
      writeFileSync(join(next.directory, 'exit-parent'), 'go');
      row.retryResult = await bounded(next.work);
      row.retryWorkerStopped = noneAlive(next.directory);
      row.terminationGuardAfterRetry = engine.terminationFailed;
    }
    row.passed = row.windowsJobHostObserved && !row.terminationGuardAfterFirst && row.firstWorkerTreeStopped && row.firstSupervisorStopped;
    if (label === 'normal-exit-zero') row.passed &&= row.commandResult.resolved && row.commandResult.outputContainsReady;
    else row.passed &&= row.cancelResult.resolved && !row.commandResult.terminationFailed;
    if (row.retryResult) row.passed &&= row.retryResult.resolved && row.retryResult.outputContainsReady && row.retryWorkerStopped && !row.terminationGuardAfterRetry;
  } catch (error) {
    row.harnessError = { name: error.name, code: error.code ?? null,
      token: ['PROBE_WAIT_TIMEOUT', 'PROBE_RESULT_TIMEOUT', 'PROBE_BUSINESS_NOT_STARTED'].includes(error.message) ? error.message : 'PROBE_RUNTIME_ERROR' };
  } finally {
    for (const directory of runs) { writeFileSync(join(directory, 'stop-parent'), 'stop'); writeFileSync(join(directory, 'stop-leaf'), 'stop'); }
    for (const child of supervisors) if (child.pid && child.exitCode === null && child.signalCode === null) child.kill();
    try { await until(() => runs.every(noneAlive) && supervisors.every(child => !child.pid || child.exitCode !== null || child.signalCode !== null), 6000); }
    catch { row.cleanupIncomplete = true; }
    row.allKnownFixturesStopped = runs.every(noneAlive);
    row.events = events;
    try { rmSync(root, { recursive: true, force: true }); } catch { row.cleanupDirectoryFailed = true; }
  }
  return row;
}
for (const label of ['normal-exit-zero', 'live-tree-cancel', 'parent-exit-independent-descendant-then-retry']) report.cases.push(await scenario(label));
report.passed = report.cases.every(row => row.passed && row.allKnownFixturesStopped && !row.cleanupIncomplete && !row.harnessError);
report.status = report.passed ? 'passed' : 'failed'; save();
console.log(JSON.stringify({ status: report.status, cases: report.cases.map(({label,passed,terminationGuardAfterFirst,retryResult,harnessError}) => ({label,passed,terminationGuardAfterFirst,retryResult,harnessError})) }));
process.exitCode = report.passed ? 0 : 1;

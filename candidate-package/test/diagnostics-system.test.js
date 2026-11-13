import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diagnose, DiagnosticLog } from '../src/diagnostics.js';

const nativeFailure = overrides => 'STUDIO_DIAGNOSTIC ' + JSON.stringify({
  schema: 1, operation: 'nt_open_file', phase: 'checking', pythonVersion: '3.11.15',
  errorType: 'OSError', errno: 22, winerror: 87, ntstatus: '0xC000000D',
  frames: [{ file: 'model_download.py', line: 198, function: '_relative_handle' }], ...overrides,
});
const finalTrace = '\n  File "C:\\Users\\PRIVATE\\model_download.py", line 712, in download_models\nOSError: [Errno 22] 模型文件读写失败';
function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'voice-report-system-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, log: new DiagnosticLog({ root, version: '0.2.2' }) };
}

test('Windows error retains original API, system codes and frame through one exported report and restart', t => {
  const { root, log } = setup(t);
  const error = Object.assign(new Error(nativeFailure() + finalTrace), { setupStep: 'model' });
  const diagnostic = diagnose(error, { code: 1 });
  assert.equal(diagnostic.code, 'FILE_OPERATION_INVALID');
  for (const token of ['errnoNumber=22', 'winerror=87', 'ntstatus=0xC000000D', 'operation=nt_open_file', 'phase=checking', 'python=3.11.15', 'trace=model_download.py:198:_relative_handle', 'exit=1']) assert(diagnostic.details.includes(token), token);
  log.captureSetup({ kind: 'transcription', error: { diagnostic } });
  const restored = new DiagnosticLog({ root, version: '0.2.2' });
  const report = restored.report({ device: { runtimeProfile: 'windows-x64', speechBackend: 'torch' }, engine: { transcription: { state: 'failed', errorCode: diagnostic.code, errorDetails: diagnostic.details, failureProgress: { phase: 'checking', completedBytes: 0, totalBytes: 1880000000, elapsedSeconds: 1, path: 'C:\\Users\\PRIVATE' } } } });
  for (const token of diagnostic.details) assert(report.text.includes(token), token);
  assert.match(report.text, /已完成字节：0.*总字节：1880000000/);
  assert.equal(report.summary.models.transcription.progress.elapsedSeconds, 1);
  assert.doesNotMatch(report.text + readFileSync(join(root, 'diagnostics/events.json'), 'utf8'), /PRIVATE|C:\\Users/);
});

test('legacy numeric errors remain actionable even when messages have been sanitized', () => {
  for (const [message, expected, token] of [
    ['OSError: [Errno 28] 模型文件读写失败', 'DISK_FULL', 'errnoNumber=28'],
    ['OSError: [Errno 13] 模型文件读写失败', 'PERMISSION_DENIED', 'errnoNumber=13'],
    ['OSError: [Errno 22] 模型文件读写失败', 'FILE_OPERATION_INVALID', 'errnoNumber=22'],
    ['OSError: [WinError 32] 私人路径', 'FILE_IN_USE', 'winerror=32'],
    ['OSError: [WinError 206] 私人路径', 'PATH_TOO_LONG', 'winerror=206'],
  ]) {
    const result = diagnose(message);
    assert.equal(result.code, expected);
    assert(result.details.includes(token));
    assert.doesNotMatch(JSON.stringify(result), /私人路径/);
  }
  assert.equal(diagnose(nativeFailure({ errno: 13, winerror: 32 }) + '\nPermissionError: [Errno 13] 模型文件读写失败').code, 'FILE_IN_USE');
  assert(diagnose(nativeFailure({ operation: 'nt_rename' }) + finalTrace).details.includes('operation=nt_rename'));
});

test('secondary cleanup failure does not erase primary failure API or native error', () => {
  const text = nativeFailure() + '\n' + nativeFailure({ secondary: true, errno: 13, winerror: 5, operation: 'cleanup', frames: [] }) + finalTrace;
  const result = diagnose(text);
  assert.equal(result.code, 'FILE_OPERATION_INVALID');
  assert(result.details.includes('operation=nt_open_file'));
  assert(!result.details.includes('winerror=5'));
});

test('stored singing stop failure remains distinct from a current native rename conflict and stop guard', t => {
  const { log } = setup(t);
  const diagnostic = diagnose(nativeFailure({ operation: 'nt_rename', errno: 13, winerror: 32, ntstatus: '0xC0000043' }) + '\nPermissionError: [Errno 13] 模型文件读写失败');
  assert.equal(diagnostic.code, 'FILE_IN_USE');
  assert(diagnostic.details.includes('ntstatus=0xC0000043'));
  const snapshot = { running: true, stopFailure: null, engine: {
    transcription: { state: 'failed', errorCode: diagnostic.code, errorDetails: diagnostic.details, failedAt: Date.parse('2026-11-13T05:24:00.953Z') },
    singing: { state: 'failed', errorCode: 'PROCESS_TERMINATION_FAILED' },
  } };
  const report = log.report(snapshot);
  assert.equal(report.summary.stopFailure, null);
  assert.equal(report.summary.models.singing.error.code, 'PROCESS_TERMINATION_FAILED');
  assert.match(report.text, /当前停止保护：未触发/);
  assert.match(report.text, /失败时间：2026-11-13T05:24:00.953Z/);
  snapshot.stopFailure = { terminationMethod: 'taskkill', terminationStage: 'execute', terminationErrorCode: 'TASKKILL_NONZERO_EXIT', terminationExitCode: 5, message: 'PRIVATE_PATH', pid: 123 };
  const blocked = log.report(snapshot);
  assert.match(blocked.text, /当前停止保护：已触发/);
  assert.match(blocked.text, /terminationExitCode=5/);
  assert.doesNotMatch(JSON.stringify(blocked), /PRIVATE_PATH|"pid"/);
});

test('state persistence warning reports safe sharing details without changing model results or stop guard', t => {
  const { log } = setup(t);
  const since = Date.parse('2026-11-13T14:37:57.118Z'), lastFailureAt = Date.parse('2026-11-13T14:38:03.915Z');
  const details = ['errnoNumber=-4082', 'errno=EBUSY', 'syscall=rename', 'fileRole=engine-state'];
  const report = log.report({ running: true, stopFailure: null, statePersistenceWarning: {
    code: 'STATE_PERSISTENCE_DEGRADED', message: 'PRIVATE_PATH C:\\Users\\PRIVATE', details: [...details, 'path=C:\\Users\\PRIVATE', 'proxy=https://user:password@private.test', 'syscall=PRIVATE'],
    since, lastFailureAt, path: 'PRIVATE_PATH',
  }, engine: {
    transcription: { state: 'preparing', progress: { phase: 'downloading', completedBytes: 1024, totalBytes: 4096 } },
    speech: { state: 'ready' },
    singing: { state: 'failed', errorCode: 'MODEL_DOWNLOAD_CHECKSUM' },
  } });
  assert.deepEqual(report.summary.statePersistenceWarning.details, details);
  assert.equal(report.summary.statePersistenceWarning.since, new Date(since).toISOString());
  assert.equal(report.summary.statePersistenceWarning.lastFailureAt, new Date(lastFailureAt).toISOString());
  assert.equal(report.summary.models.transcription.state, 'preparing');
  assert.equal(report.summary.models.transcription.progress.completedBytes, 1024);
  assert.equal(report.summary.models.transcription.error, undefined);
  assert.equal(report.summary.models.speech.state, 'ready');
  assert.equal(report.summary.models.speech.error, undefined);
  assert.equal(report.summary.models.singing.error.code, 'MODEL_DOWNLOAD_CHECKSUM');
  assert.equal(report.summary.stopFailure, null);
  assert.match(report.text, /状态保存提醒：STATE_PERSISTENCE_DEGRADED/);
  assert.match(report.text, /任务不因此中断/);
  assert.match(report.text, /当前停止保护：未触发/);
  for (const detail of details) assert(report.text.includes(detail));
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE|C:\\Users|password|private\.test/);
  assert.equal(report.entries.length, 0);
});

test('cleared or unrecognized persistence warning is absent and invalid timestamps never reach reports', t => {
  const { log } = setup(t);
  for (const statePersistenceWarning of [undefined, null, false, { code: 'PRIVATE_PATH', details: ['errno=EBUSY'] }]) {
    const report = log.report({ statePersistenceWarning });
    assert.equal(report.summary.statePersistenceWarning, undefined);
    assert.doesNotMatch(report.text, /状态保存提醒|STATE_PERSISTENCE_DEGRADED|PRIVATE/);
  }
  const report = log.report({ statePersistenceWarning: { code: 'STATE_PERSISTENCE_DEGRADED', details: 'PRIVATE_PATH', since: Infinity, lastFailureAt: 'PRIVATE_PATH' } });
  assert.deepEqual(report.summary.statePersistenceWarning.details, []);
  assert.equal(report.summary.statePersistenceWarning.since, undefined);
  assert.equal(report.summary.statePersistenceWarning.lastFailureAt, undefined);
  assert.doesNotMatch(report.text, /受阻时间|PRIVATE/);
});

test('copyable report contains taskkill failure status and confirmation stage, without process output', t => {
  const { log } = setup(t);
  const result = { terminationFailed: true, terminationMethod: 'taskkill', terminationStage: 'execute', terminationErrorCode: 'TASKKILL_NONZERO_EXIT', terminationExitCode: 5, terminationSignal: 'SIGKILL', stderr: 'C:\\Users\\PRIVATE token=secret' };
  const error = Object.assign(new Error('后台程序未能停止'), result);
  log.record({ area: 'system', code: 'PROCESS_TERMINATION_FAILED', error });
  const report = log.report({});
  for (const [key, value] of Object.entries(result).filter(([key]) => !['stderr', 'terminationFailed'].includes(key))) assert(report.text.includes(`${key}=${value}`));
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE|token=secret|stderr/);
  const structured = diagnose({ diagnostic: diagnose('OSError: failure'), ...result });
  assert(structured.details.includes('terminationExitCode=5'));
  assert.equal(structured.code, 'PROCESS_TERMINATION_FAILED');
  assert.equal(diagnose({ diagnostic: diagnose('OSError: failure') }, result).code, 'PROCESS_TERMINATION_FAILED');
  assert.equal(structured.message, report.entries[0].message);
  const saturated = diagnose({ diagnostic: { code: 'PYTHON_EXCEPTION', details: Array.from({ length: 32 }, (_, i) => `trace=model_download.py:${i + 1}:open`) }, ...result });
  assert(saturated.details.includes('terminationErrorCode=TASKKILL_NONZERO_EXIT'));
  assert(saturated.details.includes('terminationExitCode=5'));
});

test('export automatically recovers a legacy numeric cause from the matching on-disk log', t => {
  const { root, log } = setup(t);
  mkdirSync(join(root, 'engine-v1'));
  // Windows wall-clock and filesystem timestamps need not tick together. Give
  // the fixture a real, deterministic attempt window rather than relying on
  // three operations happening within the same millisecond.
  const startedAt = Date.parse('2026-11-13T13:04:00.000Z'), loggedAt = startedAt + 1000, failedAt = startedAt + 2000;
  const modelLog = join(root, 'engine-v1/setup-model-asr.log');
  const setLogTime = time => utimesSync(modelLog, new Date(time), new Date(time));
  log.record({ time: new Date(startedAt).toISOString(), area: 'transcription', code: 'SETUP_STARTED', level: 'info' });
  writeFileSync(modelLog, finalTrace); setLogTime(loggedAt);
  log.record({ time: new Date(failedAt).toISOString(), area: 'transcription', code: 'SETUP_FAILED', setupStep: 'model', error: 'OSError: 模型文件读写失败' });
  const snapshot = { engine: { transcription: { state: 'failed', setupStep: 'model', failedAt, errorCode: 'PYTHON_EXCEPTION', errorType: 'OSError' } } };
  const report = new DiagnosticLog({ root }).report(snapshot);
  assert.equal(report.summary.models.transcription.error.code, 'FILE_OPERATION_INVALID');
  assert.match(report.text, /errnoNumber=22/);
  assert.doesNotMatch(report.text, /PRIVATE/);
  // A later unrelated operation must never be attributed to this failure.
  snapshot.engine.transcription.failedAt = startedAt - 30000;
  assert.equal(log.report(snapshot).summary.models.transcription.error.code, 'PYTHON_EXCEPTION');
  snapshot.engine.transcription.failedAt = failedAt;
  // Keep both provenance boundaries strict: neither a previous attempt's log
  // nor a later overwrite can refine the failure being reported.
  setLogTime(startedAt - 1000);
  assert.equal(log.report(snapshot).summary.models.transcription.error.code, 'PYTHON_EXCEPTION');
  setLogTime(failedAt + 3000);
  assert.equal(log.report(snapshot).summary.models.transcription.error.code, 'PYTHON_EXCEPTION');
  setLogTime(loggedAt);
  snapshot.engine.transcription.setupStep = 'dependencies';
  assert.equal(log.report(snapshot).summary.models.transcription.error.code, 'PYTHON_EXCEPTION');
});

test('generic structured failure is refined using the existing setup log automatically', t => {
  const { root, log } = setup(t);
  mkdirSync(join(root, 'engine-v1'));
  writeFileSync(join(root, 'engine-v1/setup-model-asr.log'), nativeFailure() + finalTrace);
  const entry = log.captureSetup({ kind: 'transcription', since: Date.now() - 5000, error: { diagnostic: { code: 'PYTHON_EXCEPTION', errorType: 'OSError', setupStep: 'model', details: ['exit=1'] } } });
  assert.equal(entry.cause.code, 'FILE_OPERATION_INVALID');
  assert(entry.details.includes('winerror=87'));
  assert(entry.details.includes('exit=1'));
  assert(log.report({}).text.includes('trace=model_download.py:198:_relative_handle'));
});

test('native diagnostic validation excludes forged paths and arbitrary command or error text', t => {
  const { root, log } = setup(t);
  const privateValue = 'PRIVATE_CHAT token=secret https://user:password@private.test';
  const text = nativeFailure({ operation: 'nt_open_file', errno: privateValue, winerror: 2 ** 40, ntstatus: privateValue,
    pythonVersion: privateValue, phase: privateValue, message: privateValue,
    frames: [{ file: 'C:\\Users\\PRIVATE\\model_download.py', line: 2, function: '_relative_handle' }, { file: 'model_download.py', line: 2, function: privateValue }] });
  const invalid = diagnose(Object.assign(new Error(text + '\nOSError: failure'), { terminationErrorCode: privateValue, terminationExitCode: Infinity }));
  log.captureSetup({ kind: 'transcription', error: { diagnostic: invalid } });
  const restored = new DiagnosticLog({ root });
  assert.doesNotMatch(JSON.stringify(restored.report({})), /PRIVATE|password|private.test|secret|Infinity/);
  assert(invalid.details.includes('operation=nt_open_file'));
  assert(!invalid.details.some(value => /winerror|errnoNumber|ntstatus|trace=|python=|phase=/.test(value)));
});

test('Node busy errors retain their syscall and internal file role through wrapping, restart and export', t => {
  const { root, log } = setup(t);
  const error = Object.assign(new Error('EBUSY: resource busy or locked, open C:\\Users\\PRIVATE\\setup-model-asr.log'), {
    code: 'EBUSY', errno: -4082, syscall: 'open', fileRole: 'setup-log', path: 'C:\\Users\\PRIVATE\\setup-model-asr.log', setupStep: 'model',
  });
  const diagnostic = diagnose(error);
  assert.equal(diagnostic.code, 'FILE_IN_USE');
  assert(!diagnostic.message.includes('模型文件'));
  for (const token of ['errno=EBUSY', 'errnoNumber=-4082', 'syscall=open', 'fileRole=setup-log']) assert(diagnostic.details.includes(token), token);
  const wrapped = { code: diagnostic.code, diagnostic };
  log.captureSetup({ kind: 'transcription', error: wrapped });
  const report = new DiagnosticLog({ root }).report({ engine: { transcription: {
    state: 'failed', errorCode: diagnostic.code, errorDetails: diagnostic.details, setupStep: 'model',
  } } });
  assert.equal(report.entries[0].cause.code, 'FILE_IN_USE');
  for (const token of diagnostic.details) assert(report.text.includes(token), token);
  assert.doesNotMatch(report.text + readFileSync(join(root, 'diagnostics/events.json'), 'utf8'), /PRIVATE|C:\\Users|setup-model-asr/);
});

test('bare Windows libuv EBUSY identifies a resource conflict without guessing the resource or owner', () => {
  for (const error of [{ errno: -4082 }, { code: 'EBUSY' }, ...['uv_pipe_open', 'read', 'write', 'close'].map(syscall => ({ code: 'EBUSY', errno: -4082, syscall }))]) {
    const diagnostic = diagnose(error);
    assert.equal(diagnostic.code, 'RESOURCE_BUSY');
    assert.doesNotMatch(diagnostic.message, /模型|文件|其他程序/);
  }
  for (const errno of [-16, -4082]) {
    const diagnostic = diagnose({ code: 'EBUSY', errno, syscall: 'rename', fileRole: 'engine-state' });
    assert.equal(diagnostic.code, 'FILE_IN_USE');
    assert(diagnostic.details.includes('fileRole=engine-state'));
  }
  // Positive Python errno values have a different namespace, never libuv.
  assert.equal(diagnose({ errno: 4082 }).code, 'UNKNOWN');
  assert.equal(diagnose({ errno: 16 }).code, 'UNKNOWN');
  assert.equal(diagnose({ code: 'EBUSY', errno: -4082, winerror: 5 }).code, 'PERMISSION_DENIED');
});

test('old UNKNOWN busy evidence is reclassified directly from stored facts without another raw log', t => {
  const { root, log } = setup(t);
  log.record({ area: 'transcription', code: 'SETUP_STARTED', level: 'info' });
  const store = JSON.parse(readFileSync(join(root, 'diagnostics/events.json'), 'utf8'));
  store.entries.push({ time: '2026-11-13T13:04:48.944Z', level: 'error', area: 'transcription', code: 'SETUP_FAILED', setupStep: 'model',
    details: ['errnoNumber=-4082'], errorType: 'Error', fingerprint: 'e311ab9e5c6635b65605' });
  writeFileSync(join(root, 'diagnostics/events.json'), JSON.stringify(store));
  const report = new DiagnosticLog({ root }).report({ engine: { transcription: {
    state: 'failed', errorCode: 'UNKNOWN', errorDetails: ['errnoNumber=-4082'], setupStep: 'model',
  } } });
  assert.equal(report.entries[0].cause.code, 'RESOURCE_BUSY');
  assert.equal(report.entries[0].fingerprint, undefined);
  assert.equal(report.summary.models.transcription.error.code, 'RESOURCE_BUSY');
  assert.match(report.text, /errnoNumber=-4082/);
  const refined = diagnose({ fileRole: 'setup-log', syscall: 'open', diagnostic: { code: 'UNKNOWN', details: ['errnoNumber=-4082'], fingerprint: 'e311ab9e5c6635b65605' } });
  assert.equal(refined.code, 'FILE_IN_USE');
  assert.equal(refined.fingerprint, undefined);
});

test('Node diagnostics never export arbitrary syscall names, file roles, paths, or code strings', t => {
  const { root, log } = setup(t);
  const secret = 'PRIVATE_CHAT https://user:password@private.test';
  const diagnostic = diagnose({ code: secret, errno: -4082, syscall: secret, fileRole: secret, path: secret, dest: secret,
    diagnostic: { code: 'UNKNOWN', details: [`syscall=${secret}`, `fileRole=${secret}`, `errno=${secret}`, 'errnoNumber=-4082'] } });
  assert.equal(diagnostic.code, 'RESOURCE_BUSY');
  assert.deepEqual(diagnostic.details, ['errnoNumber=-4082']);
  log.captureSetup({ kind: 'transcription', error: { diagnostic } });
  const report = new DiagnosticLog({ root }).report({});
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE|password|private.test|syscall=|fileRole=/);
});

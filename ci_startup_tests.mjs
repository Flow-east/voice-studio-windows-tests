import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { release } from 'node:os';
import { join } from 'node:path';

const hashes = JSON.parse(readFileSync('candidate-package-source-hashes.json'));
for (const [file, expected] of Object.entries(hashes)) {
  if (createHash('sha256').update(readFileSync(join('candidate-package', file))).digest('hex') !== expected) throw Error('Candidate source mismatch');
}
const baseline = spawnSync(process.execPath, ['baseline_host_crash.mjs', 'released'], { encoding: 'utf8', timeout: 15000 });
const baselineReproduced = baseline.status === 1 && /at collect/.test(baseline.stderr) && /EISDIR|EPERM|EACCES/.test(baseline.stderr) && !/controlled rejection/.test(baseline.stdout);
const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', 'candidate-package/test/windows-startup.test.js', 'candidate-package/test/managed-engine-callback.test.js'], { encoding: 'utf8', timeout: 180000, maxBuffer: 2 * 1024 * 1024 });
writeFileSync('native-host-tests.tap', result.stdout + result.stderr);
const count = label => Number(new RegExp('^# ' + label + ' (\\d+)$', 'm').exec(result.stdout)?.[1] ?? -1);
const report = { platform: process.platform, osRelease: release(), node: process.version, simulation: false,
  baseline: { version: '0.2.3', hostExitCode: baseline.status, unhandledCallbackFailureReproduced: baselineReproduced },
  candidate: { version: '0.2.4', exitCode: result.status, tests: count('tests'), pass: count('pass'), fail: count('fail'), skipped: count('skipped'),
    passed: result.status === 0 && count('fail') === 0 && count('pass') > 0 }, sourceHashes: hashes };
writeFileSync('native-host-result.json', JSON.stringify(report, null, 2) + '\n');
console.log(result.stdout);
if (result.stderr) console.log(result.stderr);
console.log('NATIVE_HOST_RESULT_JSON\n' + JSON.stringify(report, null, 2));
if (process.platform !== 'win32' || !baselineReproduced || !report.candidate.passed) process.exitCode = 1;

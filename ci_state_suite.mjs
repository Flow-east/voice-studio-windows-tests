import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {release} from 'node:os';
import {join} from 'node:path';
const hashes=JSON.parse(readFileSync('candidate-package-source-hashes.json'));
for(const[file,expected]of Object.entries(hashes))if(createHash('sha256').update(readFileSync(join('candidate-package',file))).digest('hex')!==expected)throw Error('Candidate source mismatch');
const native=spawnSync(process.execPath,['state-tests/ci_state_tests.mjs','released-state','candidate-package'],{encoding:'utf8',timeout:180000,maxBuffer:2*1024*1024});
console.log(native.stdout);if(native.stderr)console.log(native.stderr);
const tests=readdirSync('candidate-package/test').filter(n=>n.endsWith('.test.js')).sort().map(n=>join('candidate-package/test',n));
const regression=spawnSync(process.execPath,['--test','--test-reporter=tap',...tests],{encoding:'utf8',timeout:180000,maxBuffer:2*1024*1024});
writeFileSync('native-state-regression.tap',regression.stdout+regression.stderr);console.log(regression.stdout);if(regression.stderr)console.log(regression.stderr);
const count=label=>Number(new RegExp('^# '+label+' (\\d+)$','m').exec(regression.stdout)?.[1]??-1);
const report={platform:process.platform,osRelease:release(),node:process.version,baselineVersion:'0.2.5',baselineSha256:'f69980fd1e0c510c8f822233c0ac1f71c245e39e99d3e95298aa4cb301cd5cd8',candidatePublished:false,
 nativeLockScenarios:{exitCode:native.status,passed:native.status===0},regression:{tests:count('tests'),pass:count('pass'),fail:count('fail'),skipped:count('skipped'),exitCode:regression.status},sourceHashes:hashes,
 passed:process.platform==='win32'&&native.status===0&&regression.status===0&&count('fail')===0&&count('skipped')===0&&count('pass')>0};
writeFileSync('native-state-suite.json',JSON.stringify(report,null,2)+'\n');console.log('NATIVE_STATE_SUITE_JSON\n'+JSON.stringify(report,null,2));if(!report.passed)process.exitCode=1;

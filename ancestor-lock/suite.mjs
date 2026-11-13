import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join} from 'node:path';
const hashes=JSON.parse(readFileSync('candidate-package-source-hashes.json'));
for(const[file,expected]of Object.entries(hashes))assert.equal(createHash('sha256').update(readFileSync(join('candidate-package',file))).digest('hex'),expected,file);
function run(exe,args,timeout=40000){const result=spawnSync(exe,args,{encoding:'utf8',timeout,maxBuffer:2*1024*1024});assert.equal(result.error,undefined);assert.equal(result.status,0,result.stderr||result.stdout);return result.stdout;}
function parseMarked(text,marker){const start=text.indexOf('\n{',text.indexOf(marker))+1,end=text.indexOf('\n}',start)+2;return JSON.parse(text.slice(start,end));}
const reports={};const checks=[];
function check(label,fn){try{fn();checks.push({label,passed:true});}catch(error){checks.push({label,passed:false,message:error.message.slice(0,2500)});}}
check('Published downloader alone reproduces EBUSY while state exclusive open succeeds',()=>{
 const text=run(process.execPath,['ancestor-lock/reproduce.mjs','released-state']);reports.baseline=parseMarked(text,'ANCESTOR_LOCK_RESULT_JSON');console.log('BASELINE_'+text);assert.equal(reports.baseline.reproduced,true);
});
check('Candidate root-only downloader permits every sibling rename while context is held',()=>{
 const text=run(process.execPath,['ancestor-lock/reproduce.mjs','candidate-package']);reports.candidate=parseMarked(text,'ANCESTOR_LOCK_RESULT_JSON');console.log('CANDIDATE_'+text);
 assert.equal(reports.candidate.held.heldAncestorHandles,1);assert.equal(reports.candidate.held.exclusiveStateOpen,true);assert.ok(reports.candidate.during.every(x=>x.ok));assert.equal(reports.candidate.directSiblingRename.ok,true);assert.equal(reports.candidate.after.ok,true);
});
check('Published integrated model progress fails from actual downloader ancestor handles',()=>{
 const r=JSON.parse(run(process.execPath,['ancestor-lock/integrated.mjs','released-state','baseline']));reports.integratedBaseline=r;
 assert.equal(r.fulfilled,false);assert.equal(r.diagnostic?.code,'FILE_IN_USE');assert.ok(r.diagnostic.details.includes('errnoNumber=-4082'));assert.ok(r.diagnostic.details.includes('fileRole=engine-state'));assert.equal(r.ready,false);assert.equal(r.terminationFailed,false);
});
check('Candidate integrated prepare persists every progress phase with no degraded warning',()=>{
 const r=JSON.parse(run(process.execPath,['ancestor-lock/integrated.mjs','candidate-package','candidate']));reports.integratedCandidate=r;
 assert.equal(r.fulfilled,true);assert.equal(r.ready,true);assert.equal(r.state,'ready');assert.equal(r.status,'ready');assert.equal(r.warning,null);assert.equal(r.closed,true);assert.equal(r.exitCode,0);assert.equal(r.terminationFailed,false);assert.equal(r.contextHeld,true);assert.equal(r.contextReleased,true);assert.equal(r.timer,false);assert.equal(r.pending,false);
 assert.deepEqual(r.observations.map(o=>o.phase),['connecting','downloading','validating']);assert.ok(r.observations.every(o=>o.phase===o.persistedPhase&&o.warning===null));
});
check('Candidate retains native root and junction containment after ancestor release',()=>{
 const text=run(join(process.env.pythonLocation,'python.exe'),['ancestor-lock/containment.py','candidate-package/runtime/model_download.py']);reports.containment=parseMarked(text,'ANCESTOR_CONTAINMENT_JSON');console.log(text);assert.equal(reports.containment.passed,true);
});
check('Candidate native downloader preserves existing verified download/replace/cache cases',()=>{
 const text=run(join(process.env.pythonLocation,'python.exe'),['native_probe.py','--baseline','released-state/runtime','--candidate','candidate-package/runtime','--output','ancestor-downloader-regression.json']);
 reports.downloaderRegression=JSON.parse(readFileSync('ancestor-downloader-regression.json'));assert.equal(reports.downloaderRegression.candidatePassed,true);console.log(text);
});
const result={platform:process.platform,node:process.version,checks,reports,sourceHashes:hashes,passed:checks.every(x=>x.passed),pass:checks.filter(x=>x.passed).length,fail:checks.filter(x=>!x.passed).length};
writeFileSync('ancestor-lock-suite.json',JSON.stringify(result,null,2)+'\n');console.log('ANCESTOR_LOCK_SUITE_JSON\n'+JSON.stringify(result,null,2));if(!result.passed)process.exitCode=1;

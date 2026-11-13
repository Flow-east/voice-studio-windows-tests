import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,renameSync,rmSync,lstatSync} from 'node:fs';
import {tmpdir,release} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
if(process.platform!=='win32')throw Error('Native Windows required');
const packageDir=resolve(process.argv[2]||'released-state');
const {writeJson}=await import(pathToFileURL(join(packageDir,'src/files.js')));
const root=mkdtempSync(join(tmpdir(),'voice-ancestor-repro-'));
const engineRoot=join(root,'engine-v1'),modelRoot=join(engineRoot,'models','asr'),state=join(engineRoot,'setup-state.json');
mkdirSync(modelRoot,{recursive:true});
const delay=ms=>new Promise(resolveDelay=>setTimeout(resolveDelay,ms));
const safeError=error=>({code:error.code,errno:error.errno,syscall:error.syscall});
const attempt=n=>{try{writeJson(state,{phase:'probe',attempt:n,pad:'x'.repeat(7500)});return {ok:true};}catch(error){return {ok:false,...safeError(error)};}};
const before=attempt(0);assert.equal(before.ok,true);
let python,held,closed=false,pythonExit,stdout='',stderr='',result;
try{
 python=spawn(process.env.pythonLocation?join(process.env.pythonLocation,'python.exe'):'python',[join(dirname(fileURLToPath(import.meta.url)),'hold_downloader.py'),join(packageDir,'runtime/model_download.py'),modelRoot,state],{stdio:['pipe','pipe','pipe'],windowsHide:true});
 python.stdout.on('data',bytes=>{stdout+=bytes;for(const line of stdout.split(/\r?\n/)){try{const data=JSON.parse(line);if(data.phase==='held')held=data;}catch{}}});
 python.stderr.on('data',bytes=>{stderr+=bytes;});python.once('close',code=>{closed=true;pythonExit=code;});
 const start=Date.now();while(!held&&!closed&&Date.now()-start<12000)await delay(20);
 if(!held)throw Error(`Downloader handles unavailable (pythonExit=${pythonExit},stderrBytes=${stderr.length})`);
 const during=[];for(let i=1;i<=10;i++){during.push(attempt(i));await delay(30);}
 let directSiblingRename;try{const a=join(engineRoot,'unrelated.tmp'),b=join(engineRoot,'unrelated-renamed.tmp');writeFileSync(a,'test');renameSync(a,b);directSiblingRename={ok:true};}catch(error){directSiblingRename={ok:false,...safeError(error)};}
 let statDuring;try{statDuring={ok:true,isFile:lstatSync(state).isFile()};}catch(error){statDuring={ok:false,...safeError(error)};}
 python.stdin.end('release\n');if(!closed)await Promise.race([new Promise(resolveClose=>python.once('close',resolveClose)),delay(5000)]);
 assert.equal(closed,true);assert.equal(pythonExit,0);
 const after=attempt(99);
 result={platform:process.platform,osRelease:release(),node:process.version,baseline:'0.2.5',downloaderSha256:createHash('sha256').update(readFileSync(join(packageDir,'runtime/model_download.py'))).digest('hex'),networkRequests:false,syntheticExternalLock:false,held,before,during,directSiblingRename,statDuring,after,pythonClosed:closed,pythonExit,
  reproduced:during.every(item=>!item.ok&&item.code==='EBUSY'&&item.errno===-4082&&item.syscall==='rename')&&before.ok&&after.ok&&held.exclusiveStateOpen===true};
}finally{
 if(python&&!closed){python.stdin.end('release\n');await Promise.race([new Promise(resolveClose=>python.once('close',resolveClose)),delay(3000)]);if(!closed)python.kill();}
 await delay(100);rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});
}
writeFileSync('ancestor-lock-result.json',JSON.stringify(result,null,2)+'\n');
console.log('ANCESTOR_LOCK_RESULT_JSON\n'+JSON.stringify(result,null,2));
// This is a hypothesis check: clean completion with reproduced=false is useful
// contrary evidence, not a test harness failure.

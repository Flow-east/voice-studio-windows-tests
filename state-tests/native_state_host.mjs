// Real Windows sharing violation: independent PowerShell process holds an
// exclusive FileStream through worker completion and prepare settlement.
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir, release } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
if (process.platform !== 'win32') throw Error('Native Windows required');
const [packageDir, mode='success'] = process.argv.slice(2);
if (!['success','worker-failure','cancel'].includes(mode)) throw Error('Invalid mode');
const { ManagedEngine } = await import(pathToFileURL(resolve(packageDir,'src/managed-engine.js')));
const root = mkdtempSync(join(tmpdir(),'voice-native-state-'));
const goPath=join(root,'go'),releasedPath=join(root,'released'),stopPath=join(root,'stop'),donePath=join(root,'done');
const delay=ms=>new Promise(resolveDelay=>setTimeout(resolveDelay,ms));
const live=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
const put=(path,value)=>{mkdirSync(dirname(path),{recursive:true});writeFileSync(path,typeof value==='object'&&!Buffer.isBuffer(value)?JSON.stringify(value):value);};
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
let child,locker,workerClosed=false,workerExitCode,lockerClosed=false,lockReady=false,lockReleased=false;
let resolveStarted;const started=new Promise(resolveStart=>{resolveStarted=resolveStart;});
const workerSource=String.raw`
const {existsSync,writeFileSync}=require('node:fs');
const [go,done,mode]=process.argv.slice(1);let began=0,connected=false,downloading=false;
const progress=phase=>process.stdout.write(JSON.stringify({type:'model_progress',kind:'asr',phase,source:'domestic'})+'\n');
const timer=setInterval(()=>{
 if(!connected&&existsSync(go)){connected=true;began=Date.now();progress('connecting');}
 if(connected&&!downloading&&Date.now()-began>3500){downloading=true;progress('downloading');}
 if(connected&&Date.now()-began>4500){clearInterval(timer);writeFileSync(done,'done');
  if(mode==='worker-failure'){process.stderr.write('MODEL_DOWNLOAD_CHECKSUM\n');process.exitCode=17;}
  else {progress('validating');process.stderr.write('SYNTHETIC_WORKER_COMPLETED\n');}
 }
},20);
setTimeout(()=>{clearInterval(timer);process.exit(31);},20000).unref();
`;
const options={root,packageDir:resolve(packageDir),platform:'win32',arch:'x64',osRelease:release(),networkResolver:async()=>({proxyEnv:{}}),spawnProcess:(exe,args,opts)=>{
 const proc=spawn(exe,args,opts);if(exe===process.execPath){child=proc;proc.once('close',code=>{workerClosed=true;workerExitCode=code;});resolveStarted();}return proc;
}};
const engine=new ManagedEngine(options);
const sentinel=join(engine.root,'retained-cache.bin'),sentinelBytes=Buffer.from('SYNTHETIC_CACHED_BYTES_REMAIN_UNCHANGED');put(sentinel,sentinelBytes);
// The fixture supplies tiny synthetic env and model files; real ready()/status()
// validators are never overridden. No model download or inference occurs.
const makeEnvironment=()=>{
 put(engine.python('asr'),'SYNTHETIC_PYTHON_NOT_EXECUTED');
 put(join(engine.root,'asr-env/ready.json'),{schema:2,...engine.runtimeMarker(),lockHash:engine.lockHash('asr')});
 const ffmpegPath=join(engine.root,'synthetic-ffmpeg.exe');put(ffmpegPath,'SYNTHETIC_FFMPEG_NOT_EXECUTED');put(join(engine.root,'paths.json'),{ffmpegPath});
};
const makeModel=()=>{
 const header=Buffer.from(JSON.stringify({tiny:{dtype:'F32',shape:[1],data_offsets:[0,4]}}));
 const prefix=Buffer.alloc(8);prefix.writeBigUInt64LE(BigInt(header.length));
 const files={'config.json':'{}','tokenizer_config.json':'{}','tokenizer.json':'{}','model.safetensors':Buffer.concat([prefix,header,Buffer.alloc(4)])};
 const modelRoot=engine.managedPaths().asrModel;
 for(const [name,bytes] of Object.entries(files))put(join(modelRoot,name),bytes);
 const [repo,revision]=engine.revisions().asr;
 put(join(modelRoot,'studio-model.json'),{schema:2,repo,revision,files:Object.entries(files).map(([path,bytes])=>({path,size:Buffer.byteLength(bytes)}))});
};
let captured='',progressEvents=[],workError,fulfilled=false,settledAt,cancelPromise,result;
engine.speechEnv=async()=>makeEnvironment();
engine.model=async(kind,owner)=>{
 engine.update(owner,'synthetic model',{progress:{phase:'checking',component:'asr',setupStep:'model'}});
 captured=await engine.command(process.execPath,['-e',workerSource,goPath,donePath,mode],{owner,modelKind:'asr',logName:'setup-model-asr.log',timeoutMs:18000,capture:true,onProgress:event=>{progressEvents.push(event.phase);engine.modelProgress(owner,event);}});
 makeModel();
};
const work=engine.prepare('transcription').then(()=>{fulfilled=true;settledAt=Date.now();},error=>{workError=error;settledAt=Date.now();});
try {
 await Promise.race([started,delay(6000).then(()=>{throw Error('Worker did not spawn');})]);
 const target=join(engine.root,'setup-state.json');
 const powershell=join(process.env.SystemRoot||process.env.WINDIR,'System32','WindowsPowerShell','v1.0','powershell.exe');
 locker=spawn(powershell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',join(dirname(fileURLToPath(import.meta.url)),'lock_file.ps1'),'-Path',target,'-ReleaseMarker',releasedPath,'-StopMarker',stopPath,'-HoldMs','30000'],{windowsHide:true,stdio:['ignore','pipe','pipe']});
 let lockerOutput='',lockerError='';locker.stdout.on('data',data=>{lockerOutput+=data;lockReady=lockerOutput.includes('LOCK_READY');lockReleased=lockerOutput.includes('LOCK_RELEASED');});locker.stderr.on('data',data=>{lockerError+=data;});locker.once('close',()=>{lockerClosed=true;});
 const waitStart=Date.now();while(!lockReady&&!lockerClosed&&Date.now()-waitStart<6000)await delay(20);
 if(!lockReady)throw Error(`Exclusive locker failed (exit=${locker.exitCode},errorBytes=${lockerError.length})`);
 const triggeredAt=Date.now();put(goPath,'go');
 if(mode==='cancel'){await delay(600);cancelPromise=engine.cancelPrepare();}
 await work;await cancelPromise;
 const warning=engine.statePersistenceStatus?.()??null;
 result={platform:process.platform,osRelease:release(),node:process.version,mode,nativeFileShareNone:true,lockReady,lockReleasedAtSettlement:lockReleased,
  fulfilled,rejected:!!workError,elapsedMs:settledAt-triggeredAt,errorCode:workError?.code,diagnostic:workError?.diagnostic,
  workerClosed,workerAlive:live(child.pid),workerExitCode,workerCompleted:existsSync(donePath),progressEvents,
  capturedWorkerCompletion:captured.includes('SYNTHETIC_WORKER_COMPLETED'),
  state:engine.state.transcription?.state,status:engine.status().transcription.state,ready:engine.ready('transcription'),
  warning,terminationFailed:engine.terminationFailed,childCleared:engine.child===null,stopCleared:engine.stopCommand===null,busyCleared:engine.busy===null,
  pending:!!engine.stateWriter.pending,timer:!!engine.stateWriter.timer,action:!!engine.stateWriter.action,cancelTimer:!!engine.cancelTimer,
  cachedBytesUnchanged:readFileSync(sentinel).equals(sentinelBytes),cacheSha256:sha(readFileSync(sentinel)),
 };
 // Accessor must clone rather than expose mutable warning state.
 if(warning){warning.details.push('unsafe-test-value');result.warningAccessorIsolated=!engine.statePersistenceStatus().details.includes('unsafe-test-value');warning.details.pop();}
 await delay(150);result.timerAfterSettlement=!!engine.stateWriter.timer;result.pendingAfterSettlement=!!engine.stateWriter.pending;
 put(stopPath,'stop');if(!lockerClosed)await Promise.race([new Promise(resolveClose=>locker.once('close',resolveClose)),delay(4000)]);
 result.lockReleasedAfterSettlement=existsSync(releasedPath);
 const before=JSON.parse(readFileSync(target,'utf8'));result.persistedStateBeforeRecovery=before.transcription?.state;
 // Actual integrity checks recover state even with a stale persisted cache.
 const reloaded=new ManagedEngine({...options,spawnProcess:spawn});result.reloadedStatusBeforeRecovery=reloaded.status().transcription.state;
 if(engine.flushState&&mode!=='cancel'){
  await engine.flushState({retry:true});result.warningAfterRecovery=engine.statePersistenceStatus();
  result.persistedStateAfterRecovery=JSON.parse(readFileSync(target,'utf8')).transcription?.state;
  result.writerCleanAfterRecovery=!engine.stateWriter.timer&&!engine.stateWriter.pending&&!engine.stateWriter.action;
 }
 // A ready cache can never override real missing/corrupt model files.
 if(mode==='success'&&fulfilled){rmSync(join(engine.managedPaths().asrModel,'model.safetensors'));result.statusAfterModelRemoval=engine.status().transcription.state;result.readyAfterModelRemoval=engine.ready('transcription');}
 const log=readFileSync(join(engine.root,'setup-model-asr.log'),'utf8');result.logContainsCompletion=log.includes('SYNTHETIC_WORKER_COMPLETED');result.logContainsWorkerFailure=log.includes('MODEL_DOWNLOAD_CHECKSUM');
}finally{
 put(stopPath,'stop');if(child&&live(child.pid)){child.kill('SIGKILL');if(!workerClosed)await new Promise(resolveClose=>child.once('close',resolveClose));}
 if(locker&&!lockerClosed)await Promise.race([new Promise(resolveClose=>locker.once('close',resolveClose)),delay(3000)]);
 if(locker&&!lockerClosed)locker.kill();await delay(50);
 if(result){result.workerAliveAfterCleanup=child?live(child.pid):false;result.lockReleasedAfterCleanup=existsSync(releasedPath);}
 rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});
}
console.log(JSON.stringify(result));

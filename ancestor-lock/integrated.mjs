import {spawn} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir,release} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
if(process.platform!=='win32')throw Error('Native Windows required');
const packageDir=resolve(process.argv[2]),role=process.argv[3];
const {ManagedEngine}=await import(pathToFileURL(join(packageDir,'src/managed-engine.js')));
const root=mkdtempSync(join(tmpdir(),'voice-integrated-download-'));
const put=(path,value)=>{mkdirSync(dirname(path),{recursive:true});writeFileSync(path,typeof value==='object'&&!Buffer.isBuffer(value)?JSON.stringify(value):value);};
let child,closed=false,exitCode,captured='',error,fulfilled=false;
const observations=[];
const python=join(process.env.pythonLocation,'python.exe');
const engine=new ManagedEngine({root,packageDir,platform:'win32',arch:'x64',osRelease:release(),networkResolver:async()=>({proxyEnv:{}}),spawnProcess:(exe,args,options)=>{const proc=spawn(exe,args,options);if(exe===python){child=proc;proc.once('close',code=>{closed=true;exitCode=code;});}return proc;}});
engine.speechEnv=async()=>{
 put(engine.python('asr'),'SYNTHETIC_PYTHON_NOT_EXECUTED');
 put(join(engine.root,'asr-env/ready.json'),{schema:2,...engine.runtimeMarker(),lockHash:engine.lockHash('asr')});
 const ffmpegPath=join(engine.root,'synthetic-ffmpeg.exe');put(ffmpegPath,'NOT_EXECUTED');put(join(engine.root,'paths.json'),{ffmpegPath});
};
engine.model=async(kind,owner)=>{
 const modelRoot=engine.managedPaths().asrModel;mkdirSync(modelRoot,{recursive:true});
 engine.update(owner,'synthetic model',{progress:{phase:'checking',component:'asr',setupStep:'model'}});
 captured=await engine.command(python,[join(dirname(fileURLToPath(import.meta.url)),'download_worker.py'),join(packageDir,'runtime/model_download.py'),modelRoot],{owner,modelKind:'asr',capture:true,timeoutMs:18000,logName:'setup-model-asr.log',onProgress:event=>{
  engine.modelProgress(owner,event);const disk=JSON.parse(readFileSync(join(engine.root,'setup-state.json'),'utf8'));
  observations.push({phase:event.phase,persistedPhase:disk.transcription?.progress?.phase,warning:engine.statePersistenceStatus?.()??null});
 }});
 const header=Buffer.from(JSON.stringify({tiny:{dtype:'F32',shape:[1],data_offsets:[0,4]}}));const prefix=Buffer.alloc(8);prefix.writeBigUInt64LE(BigInt(header.length));
 const files={'config.json':'{}','tokenizer_config.json':'{}','tokenizer.json':'{}','model.safetensors':Buffer.concat([prefix,header,Buffer.alloc(4)])};
 for(const[name,bytes]of Object.entries(files))put(join(modelRoot,name),bytes);
 const [repo,revision]=engine.revisions().asr;put(join(modelRoot,'studio-model.json'),{schema:2,repo,revision,files:Object.entries(files).map(([path,bytes])=>({path,size:Buffer.byteLength(bytes)}))});
};
const started=Date.now();let result;
try{
 try{await engine.prepare('transcription');fulfilled=true;}catch(failure){error=failure;}
 result={role,platform:process.platform,osRelease:release(),node:process.version,fulfilled,elapsedMs:Date.now()-started,errorCode:error?.code,diagnostic:error?.diagnostic,
  observations,ready:engine.ready('transcription'),state:engine.state.transcription?.state,status:engine.status().transcription.state,
  warning:engine.statePersistenceStatus?.()??null,closed,exitCode,terminationFailed:engine.terminationFailed,childCleared:engine.child===null,busyCleared:engine.busy===null,timer:!!engine.stateWriter.timer,pending:!!engine.stateWriter.pending,
  contextHeld:captured.includes('ACTUAL_DOWNLOADER_CONTEXT_HELD'),contextReleased:captured.includes('ACTUAL_DOWNLOADER_CONTEXT_RELEASED')};
}finally{if(child&&!closed)child.kill();rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
console.log(JSON.stringify(result));

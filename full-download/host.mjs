// Unmodified public ManagedEngine.prepare -> speechEnv/model -> real
// prepare_models.main/download_models/validation/marker. Only manifest data,
// external HTTP responses, and pre-existing environment markers are fixtures.
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,cpSync,copyFileSync,readFileSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir,release} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
if(process.platform!=='win32')throw Error('Native Windows required');
const [publicPath,mode='slow']=process.argv.slice(2);
assert.ok(['fast','slow','partial','fallback','cached'].includes(mode));
const here=dirname(fileURLToPath(import.meta.url)),root=mkdtempSync(join(tmpdir(),'voice-full-production-'));
const packageDir=join(root,'package'),data=join(root,'data'),engineRoot=join(data,'engine-v1');
cpSync(resolve(publicPath),packageDir,{recursive:true});
const sha=b=>createHash('sha256').update(b).digest('hex');
const put=(path,value)=>{mkdirSync(dirname(path),{recursive:true});writeFileSync(path,typeof value==='object'&&!Buffer.isBuffer(value)?JSON.stringify(value):value);};
const command=(exe,args)=>{const r=spawnSync(exe,args,{encoding:'utf8',windowsHide:true,timeout:60000,maxBuffer:512000});assert.equal(r.error,undefined);assert.equal(r.status,0,`Fixture command failed; stderrBytes=${r.stderr.length}`);return r.stdout.trim();};
const python=join(process.env.pythonLocation,'python.exe');
const sourceHashes=Object.fromEntries(['src/managed-engine.js','src/retrying-file-writer.js','src/files.js','runtime/model_download.py','runtime/prepare_models.py','runtime/model_progress.py'].map(name=>[name,sha(readFileSync(join(packageDir,name)))]));
const tensorBytes=1024*1024,header=Buffer.from(JSON.stringify({fixture:{dtype:'U8',shape:[tensorBytes],data_offsets:[0,tensorBytes]}}));
const prefix=Buffer.alloc(8);prefix.writeBigUInt64LE(BigInt(header.length));
const payloads={'config.json':Buffer.from('{"model_type":"qwen3_asr"}'),'tokenizer_config.json':Buffer.from('{}'),'tokenizer.json':Buffer.from('{}'),'model.safetensors':Buffer.concat([prefix,header,Buffer.alloc(tensorBytes,42)])};
const manifestPath=join(packageDir,'runtime/model-files-torch.json'),manifest=JSON.parse(readFileSync(manifestPath));
const revision=manifest.models.asr.revision,repo=manifest.models.asr.repo;
const files=Object.entries(payloads).map(([path,bytes])=>({path,size:bytes.length,gitBlobSha1:createHash('sha1').update(Buffer.from('blob '+bytes.length+'\0')).update(bytes).digest('hex'),modelscope:{revision:'a'.repeat(40),sha256:sha(bytes)}}));
manifest.models.asr={repo,revision,totalBytes:files.reduce((a,f)=>a+f.size,0),files};put(manifestPath,manifest);
for(const[name,bytes]of Object.entries(payloads))put(join(root,'payloads',name),bytes);
put(join(engineRoot,'runtime-profile.json'),{schema:1,profile:'windows-x64'});
const env=join(engineRoot,'asr-env');command(python,['-m','venv','--system-site-packages','--without-pip',env]);
const envPython=join(env,'Scripts/python.exe'),site=join(env,'Lib/site-packages');
copyFileSync(join(here,'fixture_bootstrap.py'),join(site,'sitecustomize.py'));
put(join(site,'voice_fixture_config.json'),{runtime:join(packageDir,'runtime'),payloadRoot:join(root,'payloads'),mode,files:Object.keys(payloads)});
// A real existing uv executable is verified using the same production marker.
const uvBytes=readFileSync(resolve('full-download-tools/uv.exe'));put(join(engineRoot,'bin/uv.exe'),uvBytes);put(join(engineRoot,'bin/uv-ready.json'),{archiveSha256:'171b7ccda1bbd562da6babeffcf533a1c6cc7862cf998da826e1db534fc43e48',binarySha256:sha(uvBytes)});
const {ManagedEngine}=await import(pathToFileURL(join(packageDir,'src/managed-engine.js')));
let childCount=0,closedCount=0,pythonExitCodes=[];
const engine=new ManagedEngine({root:data,packageDir,platform:'win32',arch:'x64',osRelease:release(),networkResolver:async()=>({proxyEnv:{}}),spawnProcess:(exe,args,options)=>{childCount++;const child=spawn(exe,args,options);child.once('close',code=>{closedCount++;pythonExitCodes.push(code);});return child;}});
// This fixture represents an already configured ASR environment. It has a real
// interpreter and real imageio-ffmpeg; inference libraries/weights are not used.
put(join(env,'ready.json'),{schema:2,...engine.runtimeMarker(),lockHash:engine.lockHash('asr')});
const modelRoot=engine.managedPaths().asrModel;
if(mode==='partial'){
 const f=files.find(f=>f.path==='model.safetensors'),identity=sha(Buffer.from(f.path+'\0'+f.modelscope.sha256));
 put(join(modelRoot,'.cache/voice-studio-downloads/domestic',identity+'.part'),payloads[f.path].subarray(0,384*1024));
}
if(mode==='cached')for(const[name,bytes]of Object.entries(payloads))put(join(modelRoot,name),bytes);
const observations=[],started=Date.now();let previous='',fulfilled=false,error;
const sample=()=>{const s=engine.state.transcription;const p=s?.progress;let disk;try{disk=JSON.parse(readFileSync(join(engineRoot,'setup-state.json'),'utf8')).transcription;}catch{}
 const record={state:s?.state,phase:p?.phase,source:p?.source,completedBytes:p?.completedBytes,totalBytes:p?.totalBytes,diskPhase:disk?.progress?.phase,warning:engine.statePersistenceStatus()};const key=JSON.stringify(record);if(key!==previous){previous=key;observations.push(record);}};
const timer=setInterval(sample,30);let result;
try{
 try{await engine.prepare('transcription');fulfilled=true;}catch(e){error=e;}
 clearInterval(timer);sample();
 const logPath=join(engineRoot,'setup-model-asr.log'),log=existsSync(logPath)?readFileSync(logPath,'utf8'):'';
 const progress=log.split(/\r?\n/).flatMap(line=>{try{const p=JSON.parse(line);return p.type==='model_progress'?[p]:[];}catch{return[];}});
 const requests=log.split(/\r?\n/).filter(line=>line.startsWith('FIXTURE_HTTP ')).map(line=>JSON.parse(line.slice(13)));
 const filesValid=Object.entries(payloads).every(([name,bytes])=>existsSync(join(modelRoot,name))&&sha(readFileSync(join(modelRoot,name)))===sha(bytes));
 result={platform:process.platform,osRelease:release(),node:process.version,python:command(envPython,['-c','import platform;print(platform.python_version())']),mode,publishedVersion:JSON.parse(readFileSync(join(packageDir,'package.json'))).version,
 sourceHashes,fixtureOverrides:['small valid ASR manifest data','external model HTTP response only','pre-existing runtime/env markers with real interpreter/uv/ffmpeg'],unmodifiedMethods:['prepare','speechEnv','model','ready','status','modelProgress','command'],
 fulfilled,errorCode:error?.code,diagnostic:error?.diagnostic,elapsedMs:Date.now()-started,ready:engine.ready('transcription'),state:engine.state.transcription?.state,status:engine.status().transcription.state,warning:engine.statePersistenceStatus(),
 childCount,closedCount,pythonExitCodes,childCleared:engine.child===null,busyCleared:engine.busy===null,terminationFailed:engine.terminationFailed,pending:!!engine.stateWriter.pending,timer:!!engine.stateWriter.timer,filesValid,
 markerCreated:existsSync(join(modelRoot,'studio-model.json')),modelPreparationReadyMessage:log.includes('"ready": true'),progress,requests,observations};
}finally{clearInterval(timer);if(engine.child)await engine.cancelPrepare().catch(()=>{});rmSync(root,{recursive:true,force:true,maxRetries:20,retryDelay:100});}
console.log(JSON.stringify(result));

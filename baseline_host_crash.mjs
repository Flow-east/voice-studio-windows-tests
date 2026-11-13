import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {mkdirSync,mkdtempSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const {ManagedEngine}=await import(pathToFileURL(resolve(process.argv[2],'src/managed-engine.js')));
const root=mkdtempSync(join(tmpdir(),'voice-crash-audit-'));
let child;
const engine=new ManagedEngine({root,platform:'win32',arch:'x64',osRelease:'10.0.19045',networkResolver:async()=>({proxyEnv:{}}),spawnProcess:()=>{
 child=new EventEmitter();child.pid=1234;child.stdout=new PassThrough();child.stderr=new PassThrough();
 setImmediate(()=>{
  const p=join(root,'engine-v1','setup-command.log');
  unlinkSync(p);mkdirSync(p);
  child.stderr.write(Buffer.from('\n'));
  child.emit('close',0);
 });return child;
}});
engine.controller=new AbortController();
try { await engine.command('C:\\fake.exe',[],{timeoutMs:1000});console.log('controlled success'); }
catch(error){console.log('controlled rejection',error.code??error.name);}

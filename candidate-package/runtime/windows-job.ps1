$env:PSModulePath=$PSHOME+'\Modules'
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$nonce = $null
$invoked = $false
try {
$utf8 = New-Object System.Text.UTF8Encoding($false, $true)
$json = $utf8.GetString([Convert]::FromBase64String($env:VOICE_STUDIO_JOB_SPEC))
$spec = ConvertFrom-Json -InputObject $json
if ($spec.nonce -isnot [string] -or $spec.nonce -cnotmatch '^[A-Za-z0-9_-]{16,128}$') { throw 'invalid spec' }
$nonce = $spec.nonce
foreach ($key in @([Environment]::GetEnvironmentVariables().Keys)) {
if ($key.StartsWith('VOICE_STUDIO_JOB_', [StringComparison]::OrdinalIgnoreCase)) { [Environment]::SetEnvironmentVariable($key, $null, 'Process') }
}
if ($spec.executable -isnot [string] -or $spec.args -isnot [array] -or @($spec.args | Where-Object { $_ -isnot [string] }).Count -or ($null -ne $spec.cwd -and $spec.cwd -isnot [string])) { throw 'invalid spec' }
Add-Type -TypeDefinition @'
using P=System.IntPtr;using U=System.UIntPtr;using M=System.Runtime.InteropServices.Marshal;using S=System.Text.StringBuilder;
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
namespace VoiceStudioJob {
public static class Supervisor {
const string K="kernel32.dll";
const uint WAIT=258, BAD=0xffffffff;
[StructLayout(LayoutKind.Sequential)] struct SA {public int size; public P descriptor; public int inherit;}
[StructLayout(LayoutKind.Sequential)] struct SI {public int cb; public P reserved,desktop,title; public uint x,y,xs,ys,xc,yc,fill,flags; public ushort show,cb2; public P reserved2,sin,sout,err;}
[StructLayout(LayoutKind.Sequential)] struct SIX {public SI si; public P attributes;}
[StructLayout(LayoutKind.Sequential)] struct PI {public P process,thread; public uint pid,tid;}
[StructLayout(LayoutKind.Sequential)] struct BL {public long processTime,jobTime; public uint flags; public U min,max; public uint active; public U affinity; public uint priority,scheduling;}
[StructLayout(LayoutKind.Sequential)] struct IO {public ulong a,b,c,d,e,f;}
[StructLayout(LayoutKind.Sequential)] struct EL {public BL basic; public IO io; public U processMemory,jobMemory,peakProcess,peakJob;}
[StructLayout(LayoutKind.Sequential)] struct AC {public long a,b,c,d; public uint faults,total,active,terminated;}
[DllImport(K,SetLastError=true,CharSet=CharSet.Unicode)] static extern P CreateJobObjectW(P sa,string name);
[DllImport(K,SetLastError=true)] static extern bool SetInformationJobObject(P job,int kind,ref EL value,int size);
[DllImport(K,SetLastError=true)] static extern bool QueryInformationJobObject(P job,int kind,out AC value,int size,P length);
[DllImport(K,SetLastError=true)] static extern bool TerminateJobObject(P job,uint code);
[DllImport(K,SetLastError=true)] static extern bool InitializeProcThreadAttributeList(P list,int count,int flags,ref P size);
[DllImport(K,SetLastError=true)] static extern bool UpdateProcThreadAttribute(P list,uint flags,U attribute,P value,P size,P previous,P returned);
[DllImport(K)] static extern void DeleteProcThreadAttributeList(P list);
[DllImport(K,SetLastError=true,CharSet=CharSet.Unicode)] static extern bool CreateProcessW(string app,S cmd,P psa,P tsa,bool inherit,uint flags,P env,string cwd,ref SIX si,out PI pi);
[DllImport(K,SetLastError=true)] static extern uint ResumeThread(P thread);
[DllImport(K,SetLastError=true)] static extern uint WaitForSingleObject(P handle,uint timeout);
[DllImport(K,SetLastError=true)] static extern bool GetExitCodeProcess(P process,out uint code);
[DllImport(K)] static extern bool CloseHandle(P handle);
[DllImport(K)] static extern P GetCurrentProcess();
[DllImport(K,SetLastError=true)] static extern P GetStdHandle(int kind);
[DllImport(K,SetLastError=true)] static extern bool DuplicateHandle(P from,P source,P to,out P copy,uint access,bool inherit,uint options);
[DllImport(K,SetLastError=true,CharSet=CharSet.Unicode)] static extern P CreateFileW(string path,uint access,uint share,ref SA sa,uint disposition,uint flags,P template);
[DllImport(K,SetLastError=true)] static extern bool PeekNamedPipe(P pipe,P buffer,uint size,P read,out uint av,P left);
sealed class Fault:Exception {public string op; public int number; public Fault(string o,int n){op=o;number=n;}}
static Fault Fail(string op){return new Fault(op,M.GetLastWin32Error());}
static bool Valid(P h){return h!=P.Zero && h!=new P(-1);}
static void Close(ref P h){if(Valid(h))CloseHandle(h);h=P.Zero;}
static string B(bool b){return b?"true":"false";}
static void Emit(string n,string json){byte[] b=Encoding.UTF8.GetBytes("\nSTUDIO_JOB_"+n+" "+json+"\n");Stream s=Console.OpenStandardError();s.Write(b,0,b.Length);s.Flush();}
static string Quote(string value){S b=new S("\"");int n=0;foreach(char c in value){if(c=='\\'){n++;continue;}if(c=='\"'){b.Append('\\',n*2+1);b.Append(c);}else{b.Append('\\',n);b.Append(c);}n=0;}b.Append('\\',n*2);return b.Append('"').ToString();}
sealed class Control {
public volatile bool stop; public volatile int err; S line=new S(); Stream sin;
void Feed(int c){if(c<0){stop=true;return;}if(c==10){string s=line.ToString().TrimEnd('\r');line.Length=0;if(s=="cancel")stop=true;else if(s.Length!=0){err=87;stop=true;}}else if(c>127 || line.Length>=32){err=87;stop=true;}else line.Append((char)c);}
void Read(){try{while(!stop)Feed(sin.ReadByte());}catch{err=6;stop=true;}}
public Control(){sin=Console.OpenStandardInput();uint av;
if(!PeekNamedPipe(GetStdHandle(-10),P.Zero,0,P.Zero,out av,P.Zero)){int e=M.GetLastWin32Error();if(e==109 || e==232){stop=true;return;}throw new Fault("read_control",e);}
for(uint i=0;i<av && !stop;i++)Feed(sin.ReadByte());
if(!stop){Thread t=new Thread(Read);t.IsBackground=true;t.Start();}
}
}
static uint Active(P job){AC a;if(!QueryInformationJobObject(job,1,out a,M.SizeOf(typeof(AC)),P.Zero))throw Fail("query_job");return a.active;}
static bool RootExited(ref PI pi,ref uint exit){if(!Valid(pi.process))return true;uint wait=WaitForSingleObject(pi.process,0);if(wait==WAIT)return false;if(wait!=0)throw Fail("wait_job");if(!GetExitCodeProcess(pi.process,out exit))throw Fail("wait_job");Close(ref pi.process);Close(ref pi.thread);return true;}
static P Duplicate(int id){P copy;if(!DuplicateHandle(GetCurrentProcess(),GetStdHandle(id),GetCurrentProcess(),out copy,0,true,2))throw Fail("open_stdio");return copy;}
public static int Run(string app,string[] args,string cwd,string n){
P job=P.Zero,list=P.Zero,jobs=P.Zero,hs=P.Zero,env=P.Zero;
P sin=P.Zero,sout=P.Zero,err=P.Zero;PI pi=new PI();bool init=false,born=false,empty=true;uint exit=1;
string op="parse_spec";Fault fault=null;Control ctl=null;Stopwatch timer=null;
try {
if(args==null || app==null)throw new Fault(op,87);
if(cwd=="")cwd=null;
if(!Path.IsPathRooted(app) || app.IndexOf('\0')>=0 || (cwd!=null && (!Path.IsPathRooted(cwd) || cwd.IndexOf('\0')>=0)))throw new Fault(op,87);
S cmd=new S(Quote(app));int count=0;
foreach(string arg in args){if(arg==null || arg.IndexOf('\0')>=0 || ++count>2048)throw new Fault(op,87);cmd.Append(' ').Append(Quote(arg));}
if(cmd.Length>=32767)throw new Fault(op,206);
op="read_control";ctl=new Control();if(ctl.err!=0)throw new Fault(op,ctl.err);
if(!ctl.stop){
op="create_job";job=CreateJobObjectW(P.Zero,null);if(!Valid(job))throw Fail(op);
op="configure_job";EL limits=new EL();limits.basic.flags=0x2000;if(!SetInformationJobObject(job,9,ref limits,M.SizeOf(typeof(EL))))throw Fail(op);
P size=P.Zero;InitializeProcThreadAttributeList(P.Zero,2,0,ref size);if(size==P.Zero)throw Fail(op);
list=M.AllocHGlobal(size);if(!InitializeProcThreadAttributeList(list,2,0,ref size))throw Fail(op);init=true;
jobs=M.AllocHGlobal(P.Size);M.WriteIntPtr(jobs,job);
if(!UpdateProcThreadAttribute(list,0,new U(0x2000d),jobs,new P(P.Size),P.Zero,P.Zero))throw Fail(op);
op="open_stdio";SA sa=new SA();sa.size=M.SizeOf(typeof(SA));sa.inherit=1;
sin=CreateFileW("NUL",0x80000000,3,ref sa,3,0x80,P.Zero);if(!Valid(sin))throw Fail(op);sout=Duplicate(-11);err=Duplicate(-12);
hs=M.AllocHGlobal(P.Size*3);M.WriteIntPtr(hs,0,sin);M.WriteIntPtr(hs,P.Size,sout);M.WriteIntPtr(hs,P.Size*2,err);
if(!UpdateProcThreadAttribute(list,0,new U(0x20002),hs,new P(P.Size*3),P.Zero,P.Zero))throw Fail(op);
SortedDictionary<string,string> vars=new SortedDictionary<string,string>(StringComparer.OrdinalIgnoreCase);
foreach(DictionaryEntry entry in Environment.GetEnvironmentVariables()){string key=(string)entry.Key;if(!key.StartsWith("VOICE_STUDIO_JOB_",StringComparison.OrdinalIgnoreCase) && key.IndexOf('=')<0)vars[key]=(string)entry.Value;}
S block=new S();foreach(KeyValuePair<string,string> v in vars)block.Append(v.Key).Append('=').Append(v.Value).Append('\0');block.Append('\0');env=M.StringToHGlobalUni(block.ToString());
if(ctl.err!=0)throw new Fault("read_control",ctl.err);
if(!ctl.stop){
SIX si=new SIX();si.si.cb=M.SizeOf(typeof(SIX));si.si.flags=0x100;si.si.sin=sin;si.si.sout=sout;si.si.err=err;si.attributes=list;
op="create_process";
if(!CreateProcessW(app,cmd,P.Zero,P.Zero,true,0x08080404,env,cwd,ref si,out pi))throw Fail(op);
born=true;empty=false;Close(ref sin);Close(ref sout);Close(ref err);
Emit(n,"{\"state\":\"ready\"}");
if(ctl.err!=0)throw new Fault("read_control",ctl.err);
if(!ctl.stop){op="resume_process";if(ResumeThread(pi.thread)==BAD)throw Fail(op);}Close(ref pi.thread);
while(true){
if(ctl.err!=0)throw new Fault("read_control",ctl.err);
bool ended=RootExited(ref pi,ref exit);
if(timer==null && (ctl.stop || ended)){op="terminate_job";if(!TerminateJobObject(job,1))throw Fail(op);timer=Stopwatch.StartNew();}
if(Active(job)==0 && RootExited(ref pi,ref exit)){empty=true;break;}
if(timer!=null && timer.ElapsedMilliseconds>=8000)throw new Fault("wait_job",1460);
Thread.Sleep(20);
}
}
}
}catch(Fault f){fault=f;}catch{fault=new Fault(op,0);}
finally {
if(born && !empty && Valid(job)){
try{if(timer==null)timer=Stopwatch.StartNew();TerminateJobObject(job,1);do{RootExited(ref pi,ref exit);if(Active(job)==0){empty=true;break;}if(timer.ElapsedMilliseconds>=8000)break;Thread.Sleep(20);}while(true);}catch{}
}
Close(ref pi.thread);Close(ref pi.process);Close(ref sin);Close(ref sout);Close(ref err);
if(init)DeleteProcThreadAttributeList(list);
foreach(P p in new P[]{list,jobs,hs,env})if(p!=P.Zero)M.FreeHGlobal(p);
Close(ref job);
}
if(fault!=null){Emit(n,"{\"state\":\"error\",\"operation\":\""+fault.op+"\",\"winerror\":"+((uint)fault.number)+",\"spawned\":"+B(born)+",\"jobEmpty\":"+B(empty)+"}");return 1;}
Emit(n,"{\"state\":\"complete\",\"exitCode\":"+(ctl.stop?1:exit)+",\"cancelled\":"+B(ctl.stop)+",\"spawned\":"+B(born)+",\"activeProcesses\":0}");return 0;
}
}}
'@
$invoked = $true
$result = [VoiceStudioJob.Supervisor]::Run($spec.executable, [string[]]$spec.args, $spec.cwd, $nonce)
exit $result
} catch {
if ($nonce) {
$spawned = if ($invoked) { 'true' } else { 'false' }
$empty = if ($invoked) { 'false' } else { 'true' }
$bytes = [Text.Encoding]::UTF8.GetBytes(("`nSTUDIO_JOB_" + $nonce + ' {"state":"error","operation":"supervisor","winerror":0,"spawned":' + $spawned + ',"jobEmpty":' + $empty + "}`n"))
$stream = [Console]::OpenStandardError(); $stream.Write($bytes, 0, $bytes.Length); $stream.Flush()
}
exit 1
}

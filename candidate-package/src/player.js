import { spawn } from 'node:child_process';
import { StudioError } from './config.js';
import { diagnose } from './diagnostics.js';
import { privateProcessEnvironment, spawnOwnedProcess, terminateWindowsProcess, terminationDetails, windowsSystemExecutable } from './process.js';

// A fixed script: the audio path and volume are data in private environment
// variables, never PowerShell source. MediaEnded is required for success.
export const WINDOWS_PLAY_SCRIPT = `
$ErrorActionPreference = 'Stop'
$player = $null
try {
  Add-Type -AssemblyName PresentationCore
  Add-Type -AssemblyName WindowsBase
  $state = @{ Opened = $false; Done = $false; Failed = $false }
  $player = New-Object System.Windows.Media.MediaPlayer
  $player.Volume = [double]::Parse($env:VOICE_STUDIO_PLAY_VOLUME, [Globalization.CultureInfo]::InvariantCulture)
  $player.add_MediaOpened({ $state.Opened = $true; $player.Play() }.GetNewClosure())
  $player.add_MediaEnded({ $state.Done = $true }.GetNewClosure())
  $player.add_MediaFailed({ $state.Failed = $true; $state.Done = $true }.GetNewClosure())
  $player.Open([Uri]::new($env:VOICE_STUDIO_PLAY_PATH))
  $started = [DateTime]::UtcNow
  while (!$state.Done -and ([DateTime]::UtcNow - $started).TotalSeconds -lt 300) {
    if (!$state.Opened -and ([DateTime]::UtcNow - $started).TotalSeconds -gt 15) { throw 'Audio open timeout' }
    $frame = New-Object System.Windows.Threading.DispatcherFrame
    $timer = New-Object System.Windows.Threading.DispatcherTimer
    $timer.Interval = [TimeSpan]::FromMilliseconds(100)
    $timer.add_Tick({ $frame.Continue = $false; $timer.Stop() }.GetNewClosure())
    $timer.Start()
    [System.Windows.Threading.Dispatcher]::PushFrame($frame)
  }
  if (!$state.Opened -or !$state.Done -or $state.Failed) { throw 'Audio playback failed' }
  $player.Close()
  exit 0
} catch {
  if ($null -ne $player) { $player.Close() }
  exit 1
}
`;
export function playFile(path, volume, { platform = process.platform, spawnProcess = spawn, windowsJob, environment = process.env } = {}) {
  let child, done = false, cancelled = false, timer, killer, finish;
  let termination = null, pendingClose = null;
  const promise = new Promise((resolve) => { finish = resolve; });
  const settle = (ok, extra = {}) => {
    if (done) return;
    if (termination) {
      if (!pendingClose?.extra.terminationFailed && (!pendingClose?.extra.diagnostic || extra.terminationFailed)) pendingClose = { ok, extra };
      return;
    }
    done = true; clearTimeout(timer); clearTimeout(killer); finish({ ok: !!ok, cancelled, ...extra });
  };
  const processError = error => {
    if (error?.terminationFailed === true || error?.code === 'PROCESS_TERMINATION_FAILED') return { errorCode: 'PROCESS_TERMINATION_FAILED', terminationFailed: true, ...terminationDetails(error) };
    const diagnostic = diagnose(error?.code === 'PROCESS_START_FAILED' ? { code: 'PROCESS_START_FAILED' } : '', { spawnError: true, errorCode: error?.code, errorName: error?.name, errno: error?.errno, ...terminationDetails(error) });
    return { errorCode: diagnostic.code, diagnostic };
  };
  const signalFailure = (error, signal) => ({ terminationFailed: true, terminationMethod: 'process', terminationStage: 'execute', terminationSignal: signal, terminationErrorCode: terminationDetails({ errorCode: error?.code }).terminationErrorCode || 'PROCESS_SIGNAL_FAILED' });
  const cancel = () => {
    if (done || cancelled) return; cancelled = true;
    if (platform === 'win32') {
      termination = terminateWindowsProcess(child, { spawnProcess, environment });
      void termination.then(result => {
        termination = null;
        if (pendingClose?.extra.terminationFailed) settle(false, pendingClose.extra);
        else if (!result.ok) settle(false, { terminationFailed: true, ...terminationDetails(result) });
        else if (pendingClose) settle(pendingClose.ok, pendingClose.extra);
        else killer = setTimeout(() => settle(false, { terminationFailed: true, ...terminationDetails(result), terminationStage: 'confirm-exit', terminationErrorCode: 'PROCESS_EXIT_NOT_CONFIRMED' }), 2000);
      });
    } else {
      try { child?.kill('SIGTERM'); killer = setTimeout(() => { try { child?.kill('SIGKILL'); } catch (error) { settle(false, signalFailure(error, 'SIGKILL')); } }, 1000); }
      catch (error) { settle(false, signalFailure(error, 'SIGTERM')); }
    }
  };
  if (!['darwin', 'win32'].includes(platform)) { settle(false, { errorCode: 'UNSUPPORTED_PLATFORM' }); return { promise, cancel }; }
  try {
    const level = String(Math.max(0, Math.min(100, Number.isFinite(Number(volume)) ? Number(volume) : 80)) / 100);
    child = platform === 'darwin'
      ? spawnOwnedProcess('/usr/bin/afplay', ['-v', level, path], { shell: false, stdio: 'ignore' }, { platform, spawnProcess, windowsJob })
      : spawnOwnedProcess(windowsSystemExecutable('powershell', environment), ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', Buffer.from(WINDOWS_PLAY_SCRIPT, 'utf16le').toString('base64')], { shell: false, windowsHide: true, stdio: 'ignore', env: { ...privateProcessEnvironment(environment), VOICE_STUDIO_PLAY_PATH: path, VOICE_STUDIO_PLAY_VOLUME: level } }, { platform, spawnProcess, windowsJob });
    child.once('error', error => settle(false, processError(error))); child.once('close', (code) => settle(code === 0, code === 0 ? {} : { errorCode: 'PLAYBACK_EXIT_' + String(code) }));
    timer = setTimeout(cancel, 300000);
  } catch (error) { settle(false, processError(error)); }
  return { promise, cancel };
}
export class Player {
  constructor({ factory = playFile, onState = () => {} } = {}) { this.factory = factory; this.onState = onState; this.current = null; this.pending = []; this.stopping = false; this.stopFailure = null; }
  enqueue(id, path, volume) {
    if (this.stopFailure) throw Object.assign(new StudioError('上一段音频尚未确认停止，请彻底退出 Coopanion 并确认后台进程结束后再试。'), { code: 'PROCESS_TERMINATION_FAILED', terminationFailed: true, ...terminationDetails(this.stopFailure) });
    if (this.stopping) throw new StudioError('播放器正在停止，请稍后重试。');
    if (this.current?.id === id || this.pending.some((item) => item.id === id)) return { queued: true, duplicate: true };
    if (this.pending.length + (this.current ? 1 : 0) >= 20) throw new StudioError('播放队列已满。');
    this.pending.push({ id, path, volume }); this.onState(id, 'queued'); this.drain(); return { queued: true };
  }
  drain() {
    if (this.current || this.stopping || this.stopFailure || !this.pending.length) return;
    const item = this.pending.shift(); this.current = item; this.onState(item.id, 'playing');
    try { item.process = this.factory(item.path, item.volume); }
    catch { item.process = { promise: Promise.resolve({ ok: false }), cancel() {} }; }
    item.promise = Promise.resolve(item.process.promise).then((result) => {
      if (result.terminationFailed) { this.stopFailure = result; for (const pending of this.pending.splice(0)) this.onState(pending.id, 'stopped'); }
      this.onState(item.id, result.terminationFailed ? 'failed' : result.cancelled ? 'stopped' : result.ok ? 'played' : 'failed', result); return result;
    }, () => { this.onState(item.id, 'failed'); return { ok: false }; }).finally(() => { this.current = null; this.drain(); });
  }
  async stop() { this.stopping = true; for (const item of this.pending.splice(0)) this.onState(item.id, 'stopped'); const current = this.current; let result = this.stopFailure; if (current) { current.process.cancel(); result = await current.promise; } this.stopping = false; return result; }
  state() { return { currentJobId: this.current?.id ?? null, queuedJobIds: this.pending.map((item) => item.id) }; }
}

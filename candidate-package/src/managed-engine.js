import { spawn } from 'node:child_process';
import { constants, mkdirSync, readFileSync, writeFileSync, renameSync, statSync, lstatSync, readdirSync, copyFileSync, chmodSync, rmSync, openSync, closeSync, readSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, relative, isAbsolute, sep } from 'node:path';
import { homedir, release } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { inspectSongModels } from './song-models.js';
import { diagnose } from './diagnostics.js';
import { resolveDownloadNetwork } from './download-network.js';
import { platformProfile, UV_DISTRIBUTIONS } from './platform.js';
import { runtimeToolSources, WINDOWS_PYTHON_MIRROR } from './runtime-downloads.js';
import { killWindowsProcessTree, privateProcessEnvironment, spawnOwnedProcess, terminateWindowsProcess, terminationDetails, windowsSystemExecutable } from './process.js';
import { writeJson } from './files.js';

const PACKAGE = fileURLToPath(new URL('..', import.meta.url));
const ACE_COMMIT = 'ca1e85fe9430179831e6bc6be790c332190a3866';
const ACE_SHA = 'b464c11f00af00e1e089a09f58a03962f803c080f116fd0517dbe5ec839706b3';
// A real, freshly installed x86 environment exceeded 120 seconds while loading
// native dependencies under Rosetta. Bound setup verification separately from
// generation jobs; cancellation still uses command()'s process-tree teardown.
const SETUP_IMPORT_TIMEOUT_MS = 5 * 60 * 1000;
const REVISIONS = {
  reference: ['mlx-community/Qwen3-TTS-12Hz-1.7B-Base-8bit', 'e7dd0585652209fa0d7783659aad4e8a324de11c'],
  asr: ['mlx-community/Qwen3-ASR-0.6B-8bit', '89e96d92ba34aca20b3e29fb10cc284097d1219f'],
  singing: ['ACE-Step/Ace-Step1.5', '19671f406d603126926c1b7e2adc169acbcade22'],
};
const MODEL_PHASES = new Set(['checking', 'connecting', 'downloading', 'validating', 'switching']);
const MODEL_SOURCES = new Set(['domestic', 'overseas']);
const FALLBACK_REASONS = new Set(['MODEL_SOURCE_NETWORK', 'MODEL_SOURCE_HTTP', 'MODEL_DOWNLOAD_PROTOCOL', 'MODEL_DOWNLOAD_CHECKSUM']);
const RUNTIME_NETWORK_FAILURES = new Set(['NETWORK_TIMEOUT', 'NETWORK_FAILED', 'PROXY_FAILED', 'DNS_FAILED', 'TLS_FAILED', 'HTTP_ERROR', 'CONNECTION_REFUSED']);
const modelProvenance = value => ({ ...(MODEL_SOURCES.has(value?.source) ? { source: value.source } : {}), ...(value?.source === 'overseas' && FALLBACK_REASONS.has(value?.fallbackReason) ? { fallbackReason: value.fallbackReason } : {}) });
const MODEL_LABELS = { reference: '说话模型', asr: '录音识别模型', singing: '唱歌模型' };
const MODEL_STAGE = { checking: '正在检查本机', connecting: '正在连接下载服务：', downloading: '正在下载', validating: '正在校验', switching: '正在切换备用下载线路：' };
const PROGRESS_LINE_LIMIT = 4096;
function failureProgressSnapshot(value, now = Date.now()) {
  if (!value || !['checking', 'connecting', 'downloading', 'validating', 'switching', 'environment', 'installing', 'verifying', 'reusing'].includes(value.phase)) return undefined;
  const result = { phase: value.phase, ...modelProvenance(value) };
  if (Object.hasOwn(REVISIONS, value.component)) result.component = value.component;
  for (const key of ['completedBytes', 'totalBytes']) if (Number.isSafeInteger(value[key]) && value[key] >= 0) result[key] = value[key];
  if (result.totalBytes !== undefined && result.completedBytes > result.totalBytes) delete result.completedBytes;
  for (const [key, timestamp] of [['elapsedSeconds', value.startedAt], ['waitingSeconds', value.lastActivityAt]]) {
    if (Number.isSafeInteger(timestamp) && timestamp > 0 && timestamp <= now) result[key] = Math.floor((now - timestamp) / 1000);
  }
  return result;
}
function modelProgressEvent(line, expectedKind) {
  let event; try { event = JSON.parse(line); } catch { return null; }
  if (!event || Array.isArray(event) || event.type !== 'model_progress' || event.kind !== expectedKind || !Object.hasOwn(REVISIONS, event.kind) || !MODEL_PHASES.has(event.phase)) return null;
  const progress = { kind: event.kind, phase: event.phase };
  if (event.source !== undefined && !MODEL_SOURCES.has(event.source)) return null;
  if (event.fallbackReason !== undefined && (event.source !== 'overseas' || !FALLBACK_REASONS.has(event.fallbackReason))) return null;
  if (event.phase === 'switching' && (event.source !== 'overseas' || !FALLBACK_REASONS.has(event.fallbackReason))) return null;
  Object.assign(progress, modelProvenance(event));
  if (event.phase === 'downloading') {
    for (const key of ['completedBytes', 'totalBytes']) {
      if (event[key] === undefined) continue;
      if (!Number.isSafeInteger(event[key]) || event[key] < 0) return null;
      progress[key] = event[key];
    }
    if (progress.totalBytes !== undefined && progress.completedBytes > progress.totalBytes) return null;
  }
  return progress;
}
const regular = p => { try { return statSync(p).isFile(); } catch { return false; } };
const read = p => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
const save = (p, value) => {
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  writeJson(p, value);
};
const inside = (root, path) => { const rel = relative(root, path); return rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel); };
function safetensorsReady(path) {
  let fd;
  try {
    const size = statSync(path).size;
    fd = openSync(path, 'r');
    const prefix = Buffer.alloc(8);
    if (readSync(fd, prefix, 0, 8, 0) !== 8) return false;
    const length = Number(prefix.readBigUInt64LE());
    if (!Number.isSafeInteger(length) || length < 2 || length > 16 * 1024 * 1024 || 8 + length > size) return false;
    const bytes = Buffer.alloc(length);
    if (readSync(fd, bytes, 0, length, 8) !== length) return false;
    const header = JSON.parse(bytes.toString('utf8'));
    const tensors = Object.entries(header).filter(([key]) => key !== '__metadata__').map(([, value]) => value);
    if (!tensors.length) return false;
    let end = 0;
    for (const tensor of tensors) {
      const offsets = tensor?.data_offsets;
      if (!Array.isArray(offsets) || offsets.length !== 2 || offsets.some(v => !Number.isSafeInteger(v) || v < 0) || offsets[0] > offsets[1]) return false;
      end = Math.max(end, offsets[1]);
    }
    return 8 + length + end === size;
  } catch { return false; } finally { if (fd !== undefined) closeSync(fd); }
}
function inventory(root) {
  const result = [];
  const walk = (folder, depth = 0) => {
    if (depth > 8 || result.length > 10000) throw Error('模型目录无效');
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'studio-model.json' || entry.name === '__pycache__') continue;
      const path = join(folder, entry.name);
      if (entry.isDirectory()) walk(path, depth + 1);
      else if (regular(path)) result.push({ path: relative(root, path).split(sep).join('/'), size: statSync(path).size });
    }
  };
  walk(root);
  return result;
}
function modelReady(root, kind) {
  try {
    if (kind === 'singing') return inspectSongModels(root).ok && ['acestep-5Hz-lm-1.7B', 'Qwen3-Embedding-0.6B'].every(name => regular(join(root, name, 'tokenizer_config.json')) && (regular(join(root, name, 'tokenizer.json')) || (regular(join(root, name, 'vocab.json')) && regular(join(root, name, 'merges.txt'))))) && inventory(root).filter(f => f.path.endsWith('.safetensors')).every(f => safetensorsReady(join(root, f.path)));
    const config = read(join(root, 'config.json'));
    if (!config || !regular(join(root, 'tokenizer_config.json'))) return false;
    if (!regular(join(root, 'tokenizer.json')) && !(regular(join(root, 'vocab.json')) && regular(join(root, 'merges.txt')))) return false;
    if (kind !== 'asr') {
      if (config.tts_model_type !== 'base') return false;
      if (!read(join(root, 'speech_tokenizer/config.json')) || !safetensorsReady(join(root, 'speech_tokenizer/model.safetensors'))) return false;
    }
    const files = inventory(root);
    const weights = files.filter(file => file.path.endsWith('.safetensors'));
    if (!weights.some(file => !file.path.includes('/')) || !weights.every(file => safetensorsReady(join(root, file.path)))) return false;
    for (const file of files.filter(file => file.path.endsWith('.safetensors.index.json'))) {
      const index = read(join(root, file.path));
      if (!index?.weight_map || typeof index.weight_map !== 'object' || !Object.keys(index.weight_map).length) return false;
      for (const shard of new Set(Object.values(index.weight_map))) {
        if (typeof shard !== 'string') return false;
        const target = resolve(dirname(join(root, file.path)), shard);
        if (!inside(root, target) || !safetensorsReady(target)) return false;
      }
    }
    return true;
  } catch { return false; }
}
function managedModelReady(root, kind, revisions = REVISIONS) {
  const marker = read(join(root, 'studio-model.json'));
  if (marker?.schema !== 2 || marker.repo !== revisions[kind][0] || marker.revision !== revisions[kind][1] || !Array.isArray(marker.files) || !marker.files.length) return false;
  if (!marker.files.every(file => typeof file.path === 'string' && inside(root, resolve(root, file.path)) && regular(join(root, file.path)) && statSync(join(root, file.path)).size === file.size)) return false;
  return modelReady(root, kind);
}
function privateEnv(root, platform = process.platform, parentEnv = process.env) {
  const env = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: homedir(), LANG: 'en_US.UTF-8', PYTHONUNBUFFERED: '1', PYTHONDONTWRITEBYTECODE: '1', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', TOKENIZERS_PARALLELISM: 'false', UV_CACHE_DIR: join(root, 'uv-cache'), UV_PYTHON_INSTALL_DIR: join(root, 'python'), UV_PYTHON_INSTALL_BIN: '0', UV_NO_CONFIG: '1', HF_HOME: join(root, 'hf-cache'), HF_HUB_DISABLE_TELEMETRY: '1', HF_HUB_DISABLE_IMPLICIT_TOKEN: '1', HF_HUB_DISABLE_XET: '1', HF_HUB_DOWNLOAD_TIMEOUT: '60', HF_HUB_ETAG_TIMEOUT: '20' };
  for (const key of ['TMPDIR', 'SSL_CERT_FILE']) if (parentEnv[key]) env[key] = parentEnv[key];
  if (platform === 'win32') Object.assign(env, privateProcessEnvironment(parentEnv));
  return env;
}
export class ManagedEngine {
  constructor({ root, packageDir = PACKAGE, platform = process.platform, arch = process.arch, osRelease = release(), existingSinging, networkResolver = resolveDownloadNetwork, spawnProcess = spawn, windowsJob, parentEnv = process.env, terminateTree = killWindowsProcessTree, signalProcess = process.kill } = {}) {
    if (!root) throw Error('缺少本地数据目录');
    this.root = resolve(root, 'engine-v1'); this.packageDir = resolve(packageDir); this.platform = platform; this.arch = arch; this.osRelease = osRelease; this.existingSinging = existingSinging;
    this.profile = platformProfile({ platform, arch, osRelease });
    this.runtimeProfile = this.profile.id;
    this.networkResolver = networkResolver; this.spawnProcess = spawnProcess; this.windowsJob = windowsJob; this.parentEnv = parentEnv; this.terminateTree = terminateTree; this.signalProcess = signalProcess; this.terminationFailed = false; this.terminationFailure = null;
    this.busy = null; this.child = null; this.controller = null; this.cancelTimer = null; this.lastStateWrite = 0;
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    if (lstatSync(this.root).isSymbolicLink()) throw Error('引擎目录不能是符号链接');
    const runtime = read(join(this.root, 'runtime-profile.json'));
    this.runtimeDetected = this.profile.id === 'windows-x64' && runtime?.schema === 1 && ['windows-x64', 'windows-cuda'].includes(runtime.profile);
    if (this.runtimeDetected) this.runtimeProfile = runtime.profile;
    this.state = read(join(this.root, 'setup-state.json')) ?? {};
    for (const kind of ['speech', 'transcription', 'singing', 'reference']) if (this.state[kind]?.state === 'preparing') this.state[kind] = { state: 'missing', stage: '上次准备已中断，可以重新开始' };
  }
  python(kind) { return join(this.root, kind + '-env', this.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'); }
  revisions() {
    if (this.profile.speechBackend === 'mlx') return REVISIONS;
    const manifest = read(join(this.packageDir, 'runtime/model-files-torch.json'));
    if (!manifest?.models) throw Error('模型文件清单缺失，请重新安装插件');
    return Object.fromEntries(Object.entries(manifest.models).map(([kind, value]) => [kind, [value.repo, value.revision]]));
  }
  modelReady(root, kind) { return managedModelReady(root, kind, this.revisions()); }
  managedPaths() {
    return { speechPython: this.python('speech'), asrPython: this.python(this.profile.speechBackend === 'mlx' ? 'speech' : 'asr'), ttsModel: join(this.root, 'models/reference'), baseModel: join(this.root, 'models/reference'), asrModel: join(this.root, 'models/asr'), aceRoot: join(this.root, 'ace-source'), acePython: this.python('singing'), checkpointRoot: join(this.root, 'models/singing') };
  }
  requirement(kind) { return join(this.packageDir, 'runtime/requirements', kind + (this.profile.id === 'mac-arm64' ? '' : '-' + this.runtimeProfile) + '.lock'); }
  device() { return { ...this.profile, runtimeProfile: this.runtimeProfile, ...(this.runtimeProfile === 'windows-cuda' ? { accelerationLabel: 'NVIDIA CUDA 加速' } : this.profile.id === 'windows-x64' && this.runtimeDetected ? { accelerationLabel: 'CPU 运行', warning: '这台电脑使用 CPU 生成，首次生成和唱歌可能需要较长时间。' } : {}) }; }
  runtimeMarker() { return { runtimeProfile: this.runtimeProfile, platform: this.platform, arch: this.arch }; }
  runtimeMatches(marker) {
    if (!marker) return false;
    if (marker.runtimeProfile === undefined) return this.profile.id === 'mac-arm64';
    return marker.runtimeProfile === this.runtimeProfile && marker.platform === this.platform && marker.arch === this.arch;
  }
  accelerationVerified(marker) { return this.runtimeProfile !== 'windows-cuda' || marker?.cudaVerified === true; }
  verificationProbe(imports) {
    if (this.runtimeProfile !== 'windows-cuda') return imports;
    return imports + '\nimport torch\ntry:\n    if not torch.cuda.is_available():\n        raise RuntimeError("CUDA unavailable")\n    probe = torch.ones(1, device="cuda:0").add_(1)\n    torch.cuda.synchronize()\n    del probe\nexcept Exception:\n    raise RuntimeError("CUDA_ACCELERATION_UNAVAILABLE") from None';
  }
  externalAvailable(value) {
    return value && ['aceRoot', 'acePython', 'checkpointRoot'].every(key => typeof value[key] === 'string' && isAbsolute(value[key])) && regular(value.acePython) && regular(join(value.aceRoot, 'acestep/inference.py')) && inspectSongModels(value.checkpointRoot).ok;
  }
  paths() {
    const stored = read(join(this.root, 'paths.json')) ?? {};
    const marker = read(join(this.root, 'singing-ready.json'));
    const external = marker?.mode === 'external' && this.externalAvailable(marker) ? { aceRoot: marker.aceRoot, acePython: marker.acePython, checkpointRoot: marker.checkpointRoot } : {};
    return { ...this.managedPaths(), ...external, ffmpegPath: stored.ffmpegPath ?? '' };
  }
  lockHash(kind) { return createHash('sha256').update(readFileSync(this.requirement(kind))).digest('hex'); }
  envReady(kind) {
    const marker = read(join(this.root, kind + '-env/ready.json'));
    return regular(this.python(kind)) && marker?.schema === 2 && this.runtimeMatches(marker) && this.accelerationVerified(marker) && marker.lockHash === this.lockHash(kind);
  }
  ready(kind) {
    const p = this.paths();
    if (!this.profile.supported || this.terminationFailed) return false;
    if (kind === 'speech') return this.envReady('speech') && this.modelReady(p.baseModel, 'reference');
    if (kind === 'transcription') return this.envReady(this.profile.speechBackend === 'mlx' ? 'speech' : 'asr') && this.modelReady(p.asrModel, 'asr') && regular(p.ffmpegPath);
    if (kind === 'reference') return this.ready('speech') && this.ready('transcription');
    const marker = read(join(this.root, 'singing-ready.json'));
    if (!marker || !regular(p.ffmpegPath)) return false;
    if (marker.mode === 'external') return marker.schema === 2 && this.runtimeMatches(marker) && this.accelerationVerified(marker) && this.externalAvailable(marker) && marker.lockHash === this.lockHash('singing');
    const source = read(join(p.aceRoot, 'studio-source.json'));
    return marker.schema === 2 && marker.mode === 'managed' && this.runtimeMatches(marker) && marker.lockHash === this.lockHash('singing') && this.envReady('singing') && source?.commit === ACE_COMMIT && source.sha256 === ACE_SHA && regular(join(p.aceRoot, 'acestep/inference.py')) && this.modelReady(p.checkpointRoot, 'singing');
  }
  status() {
    const now = Date.now();
    // Speech and uploaded voices share the same physical Base weights. Mirror
    // their active transfer rather than exposing a stale second-model state.
    const basePreparing = ['speech', 'reference'].map(kind => this.state[kind]).find(value => value?.state === 'preparing' && value.progress?.component === 'reference');
    const baseFailure = ['speech', 'reference'].map(kind => this.state[kind]).filter(value => value?.state === 'failed' && value.component === 'reference').sort((a, b) => (b.failedAt ?? 0) - (a.failedAt ?? 0))[0];
    const baseReady = this.ready('speech');
    return Object.fromEntries(['speech', 'transcription', 'singing', 'reference'].map(kind => {
      if (!this.profile.supported) return [kind, { state: 'missing', supported: false, unsupportedReason: this.profile.unsupportedReason, stage: this.profile.unsupportedReason }];
      let value = this.state[kind];
      if (kind === 'speech' || kind === 'reference') {
        if (basePreparing) value = basePreparing;
        else if (!baseReady && value?.state !== 'preparing' && baseFailure) value = baseFailure;
      }
      if (value?.state === 'preparing') {
        const progress = value.progress;
        return [kind, { supported: true, ...value, ...(progress ? { progress: { ...progress, elapsedSeconds: Math.max(0, Math.floor((now - progress.startedAt) / 1000)), waitingSeconds: Math.max(0, Math.floor((now - progress.lastActivityAt) / 1000)) } } : {}) }];
      }
      return [kind, this.ready(kind) ? { supported: true, state: 'ready', stage: '已准备好' } : { supported: true, state: 'missing', stage: '尚未准备', ...value, ...(value?.state === 'ready' ? { state: 'missing', stage: '组件不完整，请重新准备' } : {}) }];
    }));
  }
  forgetModels(ids) {
    // `speech` is the old, unused CustomVoice directory. Removing it does not
    // invalidate either voice mode. Shared Base is physically `reference`.
    const components = { asr: ['transcription', 'reference'], speech: [], reference: ['speech', 'reference'], singing: ['singing'] };
    if (!Array.isArray(ids) || !ids.length || ids.length > 4 || ids.some(id => typeof id !== 'string' || !Object.hasOwn(components, id))) throw Error('请选择有效的托管模型。');
    if (this.busy || this.child) throw Error('模型仍在准备中，请完成或停止后再移除。');
    const models = [...new Set(ids)], affected = new Set(models.flatMap(id => components[id]));
    const next = { ...this.state };
    for (const kind of affected) next[kind] = { state: 'missing', stage: '所需模型已移除，需要时重新准备' };
    // Storage owns file deletion. This method only resets state after that
    // operation and must not follow or alter external singing model locations.
    save(join(this.root, 'setup-state.json'), next);
    this.state = next;
    return { ok: true, models, components: [...affected] };
  }
  persistState(throttled = false) {
    const now = Date.now();
    if (throttled && now - this.lastStateWrite < 1000) return;
    save(join(this.root, 'setup-state.json'), this.state); this.lastStateWrite = now;
  }
  update(kind, stage, extra = {}) {
    const now = Date.now(), previous = this.state[kind]?.state === 'preparing' ? this.state[kind].progress : null;
    this.state[kind] = { state: 'preparing', stage, ...extra, progress: { phase: 'checking', ...(previous?.setupStep ? { setupStep: previous.setupStep } : {}), ...extra.progress, startedAt: previous?.startedAt ?? now, lastActivityAt: now } };
    this.persistState();
  }
  activity(kind) {
    const state = this.state[kind];
    if (state?.state !== 'preparing' || !state.progress) return;
    state.progress.lastActivityAt = Date.now(); this.persistState(true);
  }
  modelProgress(owner, event) {
    const now = Date.now(), current = this.state[owner], previous = current?.progress;
    if (current?.state !== 'preparing') return;
    const source = MODEL_SOURCES.has(event.source) ? event.source : undefined;
    const changed = previous?.phase !== event.phase || previous?.component !== event.kind || previous?.source !== source || previous?.fallbackReason !== event.fallbackReason;
    const progress = { phase: event.phase, component: event.kind, setupStep: 'model', startedAt: previous?.startedAt ?? now, lastActivityAt: previous?.lastActivityAt ?? now };
    Object.assign(progress, modelProvenance(event));
    if (event.phase === 'downloading') {
      for (const key of ['completedBytes', 'totalBytes']) if (event[key] !== undefined) progress[key] = event[key];
      if (progress.totalBytes > 0 && progress.completedBytes !== undefined) progress.percent = progress.completedBytes / progress.totalBytes * 100;
    }
    if (changed || previous?.completedBytes !== progress.completedBytes || previous?.totalBytes !== progress.totalBytes) progress.lastActivityAt = now;
    this.state[owner] = { state: 'preparing', stage: MODEL_STAGE[event.phase] + MODEL_LABELS[event.kind], progress };
    this.persistState(!changed);
  }
  async command(executable, args, { capture = false, timeoutMs = 30 * 60 * 1000, logName = 'setup-command.log', owner, modelKind, onProgress, extraEnv = {} } = {}) {
    if (this.terminationFailed) throw Object.assign(Error('后台程序尚未确认停止，请完全退出 Coopanion 后再试。'), { code: 'PROCESS_TERMINATION_FAILED', terminationFailed: true, ...this.terminationFailure });
    if (this.controller.signal.aborted) throw Error('准备已取消');
    // Resolve for each command so proxy changes take effect at the next stage.
    // This private environment can contain proxy credentials; never persist it.
    const network = await this.networkResolver({ parentEnv: this.parentEnv, platform: this.platform });
    if (this.controller.signal.aborted) throw Error('准备已取消');
    const startError = error => {
      // Preserve fixed system facts, never the OS message, executable or args.
      const diagnostic = diagnose(error?.code === 'PROCESS_START_FAILED' ? { code: 'PROCESS_START_FAILED' } : '', { spawnError: true, errorCode: error?.code, errorName: error?.name, errno: error?.errno, ...terminationDetails(error) });
      return Object.assign(Error(diagnostic.message), { code: diagnostic.code, diagnostic });
    };
    const terminationError = result => {
      this.terminationFailed = true;
      this.terminationFailure = terminationDetails({ terminationMethod: this.platform === 'win32' ? 'taskkill' : 'process-group', terminationStage: 'execute', ...result });
      return Object.assign(Error('后台程序未能停止，请完全退出并确认后台进程结束后重试。'), { code: 'PROCESS_TERMINATION_FAILED', terminationFailed: true, ...this.terminationFailure });
    };
    const unsafeStop = error => error?.terminationFailed === true || error?.code === 'PROCESS_TERMINATION_FAILED';
    return await new Promise((resolveCommand, reject) => {
      const logPath = join(this.root, logName);
      writeFileSync(logPath, '', { mode: 0o600 });
      let child;
      try { child = spawnOwnedProcess(executable, args, { env: { ...privateEnv(this.root, this.platform, this.parentEnv), ...network.proxyEnv, ...extraEnv }, cwd: this.root, detached: this.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], shell: false }, { platform: this.platform, spawnProcess: this.spawnProcess, windowsJob: this.windowsJob }); }
      catch (error) { reject(unsafeStop(error) ? terminationError(error) : startError(error)); return; }
      this.child = child; let output = '', timedOut = false, finished = false, killTimer, timer, line = '', dropping = false, terminating = null, closed = false, stoppedTree = false, stopRequested = false;
      let resolveStopped; const stopCompletion = new Promise(resolve => { resolveStopped = resolve; });
      const decoder = new StringDecoder('utf8');
      const collect = bytes => { output = (output + bytes.toString()).slice(-512000); writeFileSync(logPath, output, { mode: 0o600 }); };
      const acceptLine = value => {
        if (this.controller.signal.aborted || finished || typeof onProgress !== 'function') return;
        const event = modelProgressEvent(value, modelKind); if (event) onProgress(event);
      };
      const parse = text => {
        let offset = 0;
        while (offset < text.length) {
          const end = text.indexOf('\n', offset), chunk = text.slice(offset, end < 0 ? undefined : end);
          if (!dropping) { if (line.length + chunk.length > PROGRESS_LINE_LIMIT) { line = ''; dropping = true; } else line += chunk; }
          if (end < 0) break;
          if (!dropping) acceptLine(line);
          line = ''; dropping = false; offset = end + 1;
        }
      };
      const collectStdout = bytes => { collect(bytes); if (typeof onProgress === 'function') parse(decoder.write(bytes)); else this.activity(owner); };
      // A retry warning or redraw of tqdm is not new model data. Only a phase
      // or byte change advances model activity; ordinary installers use output.
      const collectStderr = bytes => { collect(bytes); if (!modelKind && typeof onProgress !== 'function') this.activity(owner); };
      child.stdout?.on('data', collectStdout); child.stderr?.on('data', collectStderr);
      const finish = (error) => {
        if (finished) return;
        if (!error && typeof onProgress === 'function') { parse(decoder.end()); if (line && !dropping) acceptLine(line); }
        finished = true; line = ''; dropping = false; clearTimeout(timer); clearTimeout(killTimer);
        child.stdout?.removeListener('data', collectStdout); child.stderr?.removeListener('data', collectStderr);
        if (owner && this.state[owner]?.state === 'preparing') this.persistState();
        if (this.child === child) { this.child = null; clearTimeout(this.cancelTimer); this.cancelTimer = null; }
        this.stopCommand = null;
        resolveStopped();
        if (error) reject(error); else resolveCommand(capture ? output : '');
      };
      const cancelledError = () => Error(timedOut ? '准备超时，请检查网络后重试；已下载文件会保留' : '准备已取消');
      const stopFailure = result => {
        if (!finished) finish(terminationError(result));
      };
      const stop = () => {
        stopRequested = true;
        if (finished || terminating) return stopCompletion;
        // A failed spawn has no PID and emits error asynchronously. Wait for
        // spawn/error instead of latching an invalid-PID tree-stop failure.
        if (!Number.isSafeInteger(child.pid) || child.pid <= 0) return stopCompletion;
        if (this.platform === 'win32') {
          terminating = terminateWindowsProcess(child, { spawnProcess: this.spawnProcess, environment: this.parentEnv, terminateTree: this.terminateTree });
        } else {
          terminating = new Promise(resolveStop => {
            const signal = name => {
              const details = { terminationMethod: 'process-group', terminationStage: 'execute', terminationSignal: name };
              try { this.signalProcess(-child.pid, name); return { ok: true, ...details }; }
              catch (error) { return error.code === 'ESRCH' ? { ok: true, ...details } : { ok: false, ...details, terminationErrorCode: terminationDetails({ errorCode: error.code }).terminationErrorCode || 'PROCESS_SIGNAL_FAILED' }; }
            };
            const first = signal('SIGTERM');
            if (!first.ok) return resolveStop(first);
            // Always kill remaining descendants, even if the parent exits first.
            killTimer = setTimeout(() => resolveStop(signal('SIGKILL')), 1500);
          });
        }
        terminating = terminating.then(result => {
          if (finished) return;
          if (!result.ok) return stopFailure(result);
          stoppedTree = true;
          if (closed) finish(cancelledError());
          else killTimer = setTimeout(() => stopFailure({ ...terminationDetails(result), terminationStage: 'confirm-exit', terminationErrorCode: 'PROCESS_EXIT_NOT_CONFIRMED' }), 2000);
        }, () => stopFailure({ terminationErrorCode: 'PROCESS_TERMINATION_ERROR' }));
        return stopCompletion;
      };
      this.stopCommand = stop;
      timer = setTimeout(() => {
        timedOut = true;
        stop();
      }, timeoutMs); timer.unref();
      child.once('spawn', () => { if (stopRequested) stop(); });
      child.once('error', error => { if (unsafeStop(error)) stopFailure(error); else finish(startError(error)); });
      child.once('close', code => {
        if (finished) return;
        closed = true;
        if (terminating) { if (stoppedTree) finish(cancelledError()); return; }
        if (this.controller.signal.aborted) return finish(Error('准备已取消'));
        if (timedOut) return finish(Error('准备超时，请检查网络后重试；已下载文件会保留'));
        if (code !== 0) {
          writeFileSync(join(this.root, 'setup-error.log'), output, { mode: 0o600 });
          const diagnostic = diagnose(output, { code });
          const error = Object.assign(Error(diagnostic.message), { code: diagnostic.code, diagnostic });
          return finish(error);
        }
        finish();
      });
    });
  }
  async download(url, target, sha, max = 150 * 1024 * 1024, { owner, bootstrap = false } = {}) {
    if (sha && regular(target) && statSync(target).size <= max && createHash('sha256').update(readFileSync(target)).digest('hex') === sha) return;
    await this.command(this.systemExecutable('curl'), ['--fail', '--location', '--retry', bootstrap ? '0' : '2', '--connect-timeout', bootstrap ? '12' : '20', '--max-time', '600', '--speed-limit', '1024', '--speed-time', bootstrap ? '30' : '90', '--max-filesize', String(max), '--proto', '=https', '--proto-redir', '=https', '--output', target, url], { timeoutMs: bootstrap ? 650000 : 12 * 60 * 1000, logName: 'setup-download.log', owner });
    if (owner) this.update(owner, '正在校验下载文件', { progress: { phase: 'validating' } });
    if (statSync(target).size > max) throw Error('下载文件超过预期大小');
    if (!sha || createHash('sha256').update(readFileSync(target)).digest('hex') !== sha) throw Error('下载校验失败，请重新准备');
    chmodSync(target, 0o600);
  }
  systemExecutable(name) {
    if (!['tar', 'curl', 'nvidia-smi'].includes(name)) throw Error('无效的系统程序');
    if (this.platform !== 'win32') return '/usr/bin/' + name;
    return windowsSystemExecutable(name, this.parentEnv);
  }
  runtimeFallbackAllowed(error, { checksum = false } = {}) {
    if (this.controller?.signal.aborted || this.terminationFailed || error?.terminationFailed) return false;
    const code = diagnose(error).code;
    return RUNTIME_NETWORK_FAILURES.has(code) || checksum && code === 'MODEL_INCOMPLETE';
  }
  async selectRuntimeProfile(owner) {
    if (this.profile.id !== 'windows-x64' || this.runtimeDetected) return;
    if (owner) this.update(owner, '正在检查计算加速支持', { progress: { phase: 'verifying', setupStep: 'verification' } });
    // NVIDIA's system binary is queried without a shell. Never search arbitrary
    // working directories or run a downloaded GPU detector.
    let cuda = false;
    try {
      const raw = await this.command(this.systemExecutable('nvidia-smi'), ['--query-gpu=driver_version,compute_cap,memory.total', '--format=csv,noheader,nounits'], { capture: true, timeoutMs: 5000, logName: 'setup-device.log' });
      const row = raw.trim().split(/\r?\n/)[0]?.match(/^\s*(\d+)\.(\d+)\s*,\s*(\d+)\.(\d+)\s*,\s*(\d+)\s*$/);
      const atLeast = (major, minor, wantedMajor, wantedMinor) => major > wantedMajor || major === wantedMajor && minor >= wantedMinor;
      cuda = !!row && atLeast(Number(row[1]), Number(row[2]), 572, 61) && atLeast(Number(row[3]), Number(row[4]), 7, 5) && Number(row[5]) >= 6144;
    } catch (error) { if (this.controller?.signal.aborted || this.terminationFailed || error.terminationFailed) throw error; }
    const profile = cuda ? 'windows-cuda' : 'windows-x64';
    save(join(this.root, 'runtime-profile.json'), { schema: 1, profile });
    this.runtimeProfile = profile; this.runtimeDetected = true;
  }
  async uv(kind) {
    const spec = UV_DISTRIBUTIONS[this.profile.id]; if (!spec) throw Error(this.profile.unsupportedReason);
    const sources = runtimeToolSources(this.profile.id, spec);
    const binary = join(this.root, 'bin', spec.binary), marker = read(join(this.root, 'bin/uv-ready.json'));
    if (regular(binary) && sources.some(source => marker?.archiveSha256 === source.sha256) && marker.binarySha256 === createHash('sha256').update(readFileSync(binary)).digest('hex')) return binary;
    this.update(kind, '正在下载运行环境工具', { progress: { phase: 'downloading', setupStep: 'runtime-tool' } }); mkdirSync(join(this.root, 'bin'), { recursive: true, mode: 0o700 });
    const archive = join(this.root, this.platform === 'win32' ? 'uv.zip' : 'uv.tar.gz');
    let selected;
    // A download may have completed before an interrupted extraction. Reuse
    // either verified Windows artifact, including the earlier GitHub archive.
    if (this.platform === 'win32' && regular(archive) && statSync(archive).size <= 40 * 1024 * 1024) {
      const sha256 = createHash('sha256').update(readFileSync(archive)).digest('hex');
      selected = sources.find(source => source.sha256 === sha256 && statSync(archive).size <= source.maxBytes);
    }
    if (!selected) for (const [index, source] of sources.entries()) {
      if (index) this.update(kind, index === 1 ? '正在切换运行工具下载线路：官方软件源' : '正在切换运行工具下载线路：官方发布页', { progress: { phase: 'switching', setupStep: 'runtime-tool' } });
      try {
        await this.download(source.url, archive, source.sha256, source.maxBytes, { owner: kind, bootstrap: this.platform === 'win32' });
        selected = source; break;
      } catch (error) {
        if (index === sources.length - 1 || !this.runtimeFallbackAllowed(error, { checksum: true })) throw error;
      }
    }
    this.update(kind, '正在解压运行环境工具', { progress: { phase: 'installing' } });
    const stage = join(this.root, 'uv-stage'); rmSync(stage, { recursive: true, force: true }); mkdirSync(stage, { mode: 0o700 });
    await this.command(this.systemExecutable('tar'), ['-xf', archive, '-C', stage, ...(this.platform === 'win32' ? [] : ['--strip-components', '1']), selected.member], { timeoutMs: 60000, owner: kind });
    const staged = join(stage, this.platform === 'win32' ? selected.member : spec.binary); chmodSync(staged, 0o700); renameSync(staged, binary);
    save(join(this.root, 'bin/uv-ready.json'), { archiveSha256: selected.sha256, binarySha256: createHash('sha256').update(readFileSync(binary)).digest('hex') });
    return binary;
  }
  async environment(kind, uv, owner = kind) {
    const python = this.python(kind), env = join(this.root, kind + '-env');
    if (this.envReady(kind)) return python;
    // A copied data directory may contain an interpreter for another machine.
    // Record its platform before dependency installation so a failed install can
    // resume without repeatedly deleting a valid, already downloaded runtime.
    const pythonMarker = read(join(env, 'python-runtime.json'));
    const previousRuntime = pythonMarker ?? read(join(env, 'ready.json'));
    const legacyArm = !previousRuntime && this.profile.id === 'mac-arm64';
    if (!regular(python) || (!legacyArm && !this.runtimeMatches(previousRuntime))) {
      this.update(owner, '正在下载并创建独立 Python 环境', { progress: { phase: 'environment', setupStep: 'python' } });
      rmSync(env, { recursive: true, force: true });
      const args = ['venv', '--python', '3.11.13', '--managed-python', env], options = { logName: 'setup-' + kind + '-python.log', owner };
      if (this.platform === 'win32') {
        try { await this.command(uv, args, { ...options, extraEnv: { UV_PYTHON_INSTALL_MIRROR: WINDOWS_PYTHON_MIRROR } }); }
        catch (error) {
          if (!this.runtimeFallbackAllowed(error)) throw error;
          this.update(owner, '正在切换 Python 下载线路：官方软件源', { progress: { phase: 'environment', setupStep: 'python' } });
          await this.command(uv, args, options);
        }
      } else await this.command(uv, args, options);
      save(join(env, 'python-runtime.json'), { schema: 1, ...this.runtimeMarker() });
    } else if (!pythonMarker) {
      save(join(env, 'python-runtime.json'), { schema: 1, ...this.runtimeMarker() });
    }
    const label = kind === 'speech' ? '语音合成' : kind === 'asr' ? '语音识别' : '唱歌';
    this.update(owner, '正在安装' + label + '依赖', { progress: { phase: 'installing', setupStep: 'dependencies' } });
    await this.command(uv, ['pip', 'sync', '--python', python, '--require-hashes', '--only-binary', ':all:', this.requirement(kind)], { logName: 'setup-' + kind + '-packages.log', owner, timeoutMs: this.runtimeProfile === 'windows-cuda' ? 90 * 60 * 1000 : 30 * 60 * 1000 });
    this.update(owner, '正在验证' + label + '环境', { progress: { phase: 'verifying', setupStep: 'verification' } });
    const probe = this.profile.speechBackend === 'torch' ? (kind === 'speech' ? 'from qwen_tts import Qwen3TTSModel; import soundfile, imageio_ffmpeg' : kind === 'asr' ? 'from qwen_asr import Qwen3ASRModel; import soundfile, imageio_ffmpeg' : 'import torch, torchaudio, transformers, diffusers, soundfile, pytorch_wavelets') : kind === 'speech' ? 'import mlx_audio.tts.utils, mlx_audio.stt.utils, soundfile, imageio_ffmpeg' : 'import torch, torchaudio, transformers, mlx.core, mlx_lm, diffusers, soundfile, pytorch_wavelets';
    await this.command(python, ['-c', this.verificationProbe(probe)], { timeoutMs: SETUP_IMPORT_TIMEOUT_MS, logName: 'setup-' + kind + '-verify.log', owner });
    save(join(this.root, kind + '-env/ready.json'), { schema: 2, lockHash: this.lockHash(kind), ...this.runtimeMarker(), ...(this.runtimeProfile === 'windows-cuda' ? { cudaVerified: true } : {}) });
    return python;
  }
  async speechEnv(kind) {
    await this.selectRuntimeProfile(kind);
    const uv = await this.uv(kind), envKind = this.profile.speechBackend === 'torch' && kind === 'transcription' ? 'asr' : 'speech', python = await this.environment(envKind, uv, kind);
    if (kind === 'reference' && this.profile.speechBackend === 'torch') await this.environment('asr', uv, kind);
    this.update(kind, '正在检查音频处理组件', { progress: { phase: 'verifying', setupStep: 'audio-tools' } });
    const ffmpeg = (await this.command(python, ['-c', 'import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())'], { capture: true, timeoutMs: 60000, owner: kind })).trim().split('\n').at(-1);
    if (!regular(ffmpeg)) throw Error('音频处理组件未就绪');
    save(join(this.root, 'paths.json'), { ffmpegPath: ffmpeg }); return uv;
  }
  reuseModel(kind, owner) {
    if (kind === 'speech') kind = 'reference';
    const [repo, revision] = this.revisions()[kind];
    // An oMLX directory name does not prove its revision. Only reuse a pinned HF
    // snapshot (or an already validated managed model); never stamp an assumed revision.
    const repoRoot = join(homedir(), '.cache/huggingface/hub', 'models--' + repo.replaceAll('/', '--'));
    const snapshot = join(repoRoot, 'snapshots', revision), destination = join(this.root, 'models', kind);
    if (!modelReady(snapshot, kind)) return false;
    if (owner) this.update(owner, '正在复用本机' + MODEL_LABELS[kind], { progress: { phase: 'reusing', component: kind, setupStep: 'model' } });
    const files = inventory(snapshot);
    for (const file of files) if (!inside(repoRoot, realpathSync(join(snapshot, file.path)))) return false;
    for (const file of files) {
      const target = join(destination, file.path); mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      copyFileSync(join(snapshot, file.path), target, constants.COPYFILE_FICLONE);
    }
    if (owner) this.update(owner, '正在校验复用的' + MODEL_LABELS[kind], { progress: { phase: 'validating', component: kind, setupStep: 'model' } });
    if (!modelReady(destination, kind)) return false;
    save(join(destination, 'studio-model.json'), { schema: 2, repo, revision, reused: true, files: inventory(destination) });
    return true;
  }
  async model(kind, owner) {
    if (kind === 'speech') kind = 'reference';
    this.update(owner, '正在检查本机' + MODEL_LABELS[kind], { progress: { phase: 'checking', component: kind, setupStep: 'model' } });
    const output = join(this.root, 'models', kind); if (this.modelReady(output, kind)) return;
    if (this.reuseModel(kind, owner)) return;
    this.update(owner, '正在连接下载服务：' + MODEL_LABELS[kind], { progress: { phase: 'connecting', component: kind, source: 'domestic', setupStep: 'model' } });
    await this.command(this.python(this.profile.speechBackend === 'mlx' ? 'speech' : owner === 'transcription' ? 'asr' : 'speech'), [join(this.packageDir, 'runtime/prepare_models.py'), '--kind', kind, '--output', output, '--source', 'auto', '--backend', this.profile.speechBackend], { timeoutMs: 90 * 60 * 1000, logName: 'setup-model-' + kind + '.log', owner, modelKind: kind, onProgress: event => this.modelProgress(owner, event) });
    this.update(owner, '正在确认' + MODEL_LABELS[kind] + '完整性', { progress: { phase: 'validating', component: kind, setupStep: 'model', ...modelProvenance(this.state[owner]?.progress) } });
    if (!this.modelReady(output, kind)) throw Error('模型文件不完整，请重试');
  }
  async singing() {
    const uv = await this.speechEnv('singing');
    const existing = this.existingSinging;
    if (this.externalAvailable(existing)) {
      try {
        this.update('singing', '正在验证已有唱歌引擎', { progress: { phase: 'verifying', component: 'singing', setupStep: 'verification' } });
        await this.command(existing.acePython, ['-c', this.verificationProbe('import sys; sys.path.insert(0, sys.argv[1]); from acestep.handler import AceStepHandler; from acestep.llm_inference import LLMHandler; from acestep.inference import generate_music'), existing.aceRoot], { timeoutMs: SETUP_IMPORT_TIMEOUT_MS, logName: 'setup-singing-verify.log', owner: 'singing' });
        save(join(this.root, 'singing-ready.json'), { schema: 2, mode: 'external', ...existing, lockHash: this.lockHash('singing'), ...this.runtimeMarker(), ...(this.runtimeProfile === 'windows-cuda' ? { cudaVerified: true } : {}) }); return;
      } catch (error) { if (this.controller.signal.aborted || this.terminationFailed || error.terminationFailed || error.code === 'CUDA_ACCELERATION_UNAVAILABLE') throw error; }
    }
    // Stale external locations are never extraction/install/download destinations.
    const p = this.managedPaths(); rmSync(join(this.root, 'singing-ready.json'), { force: true });
    const sourceMarker = read(join(p.aceRoot, 'studio-source.json'));
    if (sourceMarker?.commit !== ACE_COMMIT || sourceMarker.sha256 !== ACE_SHA || !regular(join(p.aceRoot, 'acestep/inference.py'))) {
      this.update('singing', '正在下载唱歌引擎', { progress: { phase: 'downloading', setupStep: 'singing-engine' } });
      const archive = join(this.root, 'ace.tar.gz'); await this.download('https://codeload.github.com/ace-step/ACE-Step-1.5/tar.gz/' + ACE_COMMIT, archive, ACE_SHA, undefined, { owner: 'singing' });
      this.update('singing', '正在解压唱歌引擎', { progress: { phase: 'installing' } });
      const stage = join(this.root, 'ace-source-stage'); rmSync(stage, { recursive: true, force: true }); mkdirSync(stage, { mode: 0o700 });
      await this.command(this.systemExecutable('tar'), ['-xzf', archive, '-C', stage, '--strip-components', '1'], { timeoutMs: 120000, owner: 'singing' });
      if (!regular(join(stage, 'acestep/inference.py'))) throw Error('唱歌组件归档无效');
      save(join(stage, 'studio-source.json'), { commit: ACE_COMMIT, sha256: ACE_SHA });
      rmSync(p.aceRoot, { recursive: true, force: true }); renameSync(stage, p.aceRoot);
    }
    await this.environment('singing', uv);
    this.update('singing', '正在验证唱歌引擎', { progress: { phase: 'verifying', component: 'singing', setupStep: 'verification' } });
    await this.command(p.acePython, ['-c', 'import sys; sys.path.insert(0, sys.argv[1]); from acestep.handler import AceStepHandler; from acestep.llm_inference import LLMHandler; from acestep.inference import generate_music', p.aceRoot], { timeoutMs: SETUP_IMPORT_TIMEOUT_MS, logName: 'setup-singing-source-verify.log', owner: 'singing' });
    if (!this.modelReady(p.checkpointRoot, 'singing')) {
      this.update('singing', '正在连接下载服务：唱歌模型', { progress: { phase: 'connecting', component: 'singing', source: 'domestic', setupStep: 'model' } });
      await this.command(p.speechPython, [join(this.packageDir, 'runtime/prepare_models.py'), '--kind', 'singing', '--output', p.checkpointRoot, '--source', 'auto', '--backend', this.profile.speechBackend], { timeoutMs: 3 * 60 * 60 * 1000, logName: 'setup-model-singing.log', owner: 'singing', modelKind: 'singing', onProgress: event => this.modelProgress('singing', event) });
    }
    this.update('singing', '正在确认唱歌模型完整性', { progress: { phase: 'validating', component: 'singing', setupStep: 'model', ...modelProvenance(this.state.singing?.progress) } });
    if (!this.modelReady(p.checkpointRoot, 'singing')) throw Error('唱歌模型不完整，请重试');
    save(join(this.root, 'singing-ready.json'), { schema: 2, mode: 'managed', lockHash: this.lockHash('singing'), ...this.runtimeMarker() });
  }
  prepare(kind = 'speech') {
    if (!['speech', 'transcription', 'singing', 'reference'].includes(kind)) return Promise.reject(Error('未知组件'));
    if (this.busy) return this.busy.kind === kind ? this.busy.promise : Promise.reject(Error('正在准备其他组件，请稍候'));
    if (!this.profile.supported) return Promise.reject(Error(this.profile.unsupportedReason));
    if (this.terminationFailed) return Promise.reject(Object.assign(Error('后台程序未能停止，请完全退出并重新打开 Coopanion 后重试。'), { code: 'PROCESS_TERMINATION_FAILED', terminationFailed: true, ...this.terminationFailure }));
    if (this.ready(kind)) return Promise.resolve(this.status());
    this.controller = new AbortController(); this.update(kind, '正在检查本机环境', { progress: { setupStep: 'verification' } });
    const promise = (async () => {
      try {
        if (kind === 'singing') await this.singing();
        else {
          await this.speechEnv(kind);
          if (kind === 'transcription') await this.model('asr', kind);
          else {
            await this.model('reference', kind);
            if (kind === 'reference') await this.model('asr', kind);
          }
        }
        this.update(kind, '正在验证组件准备结果', { progress: { phase: 'verifying', setupStep: 'verification' } });
        if (!this.ready(kind)) throw Error('组件未准备完整');
        this.state[kind] = { state: 'ready', stage: '已准备好' };
      } catch (error) {
        const progress = this.state[kind]?.progress, provenance = modelProvenance(progress);
        if (!error || typeof error !== 'object') error = Error(String(error));
        const setupStep = progress?.setupStep;
        if (setupStep) error.setupStep = setupStep;
        const diagnostic = diagnose(error);
        error.diagnostic = diagnostic;
        const component = Object.hasOwn(REVISIONS, progress?.component) ? progress.component : undefined;
        const cancelled = this.controller.signal.aborted && !this.terminationFailed;
        const failureProgress = !cancelled ? failureProgressSnapshot(progress) : undefined;
        this.state[kind] = { state: cancelled ? 'missing' : 'failed', stage: cancelled ? '准备已取消' : this.terminationFailed ? '后台程序未能停止，请完全退出 Coopanion' : '准备未完成', error: diagnostic.message, errorCode: diagnostic.code, errorDetails: diagnostic.details, errorType: diagnostic.errorType, ...(setupStep ? { setupStep } : {}), ...(!cancelled ? { failedAt: Date.now() } : {}), ...(failureProgress ? { failureProgress } : {}), ...(component ? { component } : {}), ...provenance }; throw error;
      } finally { save(join(this.root, 'setup-state.json'), this.state); this.busy = null; this.child = null; }
    })();
    this.busy = { kind, promise }; return promise;
  }
  async cancelPrepare() {
    this.controller?.abort();
    await this.stopCommand?.();
    if (this.terminationFailed) throw Object.assign(Error('后台程序未能停止，请完全退出并重新打开 Coopanion 后重试。'), { code: 'PROCESS_TERMINATION_FAILED', terminationFailed: true, ...this.terminationFailure });
  }
}

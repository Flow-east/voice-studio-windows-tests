import { accessSync, constants, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { release } from 'node:os';
import { platformProfile } from './platform.js';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DEFAULTS, DOWNLOAD_SOURCES, DOWNLOAD_FALLBACK_CODES, ID, LABEL, TOOLS, StudioError, endpoint, publicError, settings, singingPreferences, suppliedLyrics } from './config.js';
import { listModels, synthesize } from './api.js';
import { MAX_AUDIO_BYTES, readContained, readJson, sniffAudio, songOutput, speechOutput, writeJson } from './files.js';
import { decodeReferenceUpload, referenceOutput } from './reference.js';
import { runProcess, terminationDetails } from './process.js';
import { Player } from './player.js';
import { detectQQ, qqUnknown } from './qq.js';
import { inspectSongModels } from './song-models.js';
import { installerPatch, installerSnapshot } from './installer-config.js';
import { readQQAudio } from './qq-audio.js';
import { QQVoiceInbox } from './qq-inbox.js';
import { SingingReference } from './singing-reference.js';
import { ReferenceLibrary } from './reference-library.js';
import { defaultVoiceReference } from './default-voice.js';
import { DiagnosticLog, diagnose } from './diagnostics.js';
import { modelCatalog, storageSummary } from './model-catalog.js';
import { statfs } from 'node:fs/promises';
import { inspectStorage, planCleanup, executeCleanup } from './storage.js';

const ENV_PROMPT = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));
const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url));
const VERSION = JSON.parse(readFileSync(join(PACKAGE_DIR, 'package.json'), 'utf8')).version;
const JOB_ID = /^[a-zA-Z0-9-]{1,80}$/;
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const PREPARATION_STEPS = new Set(['runtime-tool', 'python', 'dependencies', 'audio-tools', 'model', 'singing-engine', 'verification']);
const PREPARATION_PHASES = new Set(['checking', 'connecting', 'switching', 'downloading', 'validating', 'environment', 'installing', 'verifying', 'reusing']);
function publicPreparationProgress(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !PREPARATION_PHASES.has(value.phase)) return undefined;
  const result = { phase: value.phase }, now = Date.now();
  if (DOWNLOAD_SOURCES.includes(value.source)) result.source = value.source;
  if (value.source === 'overseas' && DOWNLOAD_FALLBACK_CODES.includes(value.fallbackReason)) result.fallbackReason = value.fallbackReason;
  if (['asr', 'speech', 'reference', 'singing'].includes(value.component)) result.component = value.component;
  for (const key of ['startedAt', 'lastActivityAt']) if (Number.isSafeInteger(value[key]) && value[key] > 0 && value[key] <= now + 60000) result[key] = value[key];
  for (const [key, timestamp] of [['elapsedSeconds', result.startedAt], ['waitingSeconds', result.lastActivityAt]]) {
    if (timestamp) result[key] = Math.max(0, Math.floor((now - timestamp) / 1000));
    else if (Number.isSafeInteger(value[key]) && value[key] >= 0 && value[key] <= 365 * 86400) result[key] = value[key];
  }
  if (value.phase === 'downloading') {
    const validBytes = bytes => Number.isSafeInteger(bytes) && bytes >= 0;
    if (validBytes(value.totalBytes) && value.totalBytes > 0) result.totalBytes = value.totalBytes;
    if (validBytes(value.completedBytes) && (result.totalBytes === undefined || value.completedBytes <= result.totalBytes)) result.completedBytes = value.completedBytes;
    if (result.totalBytes && result.completedBytes !== undefined) result.percent = result.completedBytes / result.totalBytes * 100;
  }
  return result;
}
const PANELS = [
  { id: 'studio', title: '语音', description: '模型状态、参考音色和语音测试。' },
  { id: 'singing', title: '唱歌', description: '唱歌模型、歌声选择和歌曲测试。' },
  { id: 'settings', title: '配置', description: 'QQ 连接、存储管理和任务控制。' },
  { id: 'logs', title: '日志', description: '查看和复制诊断信息。' },
  { id: 'help', title: '说明', description: '开始使用和常见问题。' },
];
const stamp = () => new Date().toISOString();
const isFile = (path, executable = false) => { try { if (!isAbsolute(path) || !statSync(path).isFile()) return false; accessSync(path, executable ? constants.X_OK : constants.R_OK); return true; } catch { return false; } };
const isDir = (path) => { try { return isAbsolute(path) && lstatSync(realpathSync(path)).isDirectory(); } catch { return false; } };
function textInput(value, max, single = false) { if (typeof value !== 'string' || !value.trim() || [...value.trim()].length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value) || single && /[\r\n\t]/u.test(value)) throw new StudioError(`请输入 1–${max} 字${single ? '的单行主题' : '文本'}。`); return value.trim(); }

export class VoiceStudioWorld {
  id = ID;
  constructor({ cfg = DEFAULTS, dataDir, botDir, secret = () => '', storeSecret = () => {}, persist, dependencies = {} }) {
    this.cfg = cfg; this.root = resolve(dataDir, ID); this.botDir = botDir;
    this.osRelease = dependencies.osRelease ?? release();
    this.device = platformProfile({ platform: dependencies.platform ?? process.platform, arch: dependencies.arch ?? process.arch, osRelease: this.osRelease });
    this.stopFailure = null;
    // SDK ctx.packageDir belongs to the host bot, not this extension.
    this.runner = dependencies.runnerPath ?? join(PACKAGE_DIR, 'runtime', 'sing.py');
    this.speechRunner = dependencies.speechRunnerPath ?? join(PACKAGE_DIR, 'runtime', this.device.speechBackend === 'torch' ? 'torch_speech.py' : 'managed_speech.py');
    this.referenceRunner = dependencies.referenceRunnerPath ?? join(PACKAGE_DIR, 'runtime', this.device.speechBackend === 'torch' ? 'torch_reference.py' : 'managed_reference.py');
    this.transcriptionRunner = dependencies.transcriptionRunnerPath ?? join(PACKAGE_DIR, 'runtime', this.device.speechBackend === 'torch' ? 'torch_transcribe.py' : 'managed_transcribe.py');
    this.readQQAudio = dependencies.readQQAudio ?? readQQAudio; this.Inbox = dependencies.Inbox ?? QQVoiceInbox;
    this.inbox = null; this.qqReads = new Map(); this.transcriptionJobs = new Map(); this.ingressGeneration = 0;
    this.engine = dependencies.engine ?? null; this.engineFactory = dependencies.engineFactory;
    this.setupTasks = new Map(); this.setupErrors = new Map(); this.setupGeneration = 0; this.referenceTask = null; this.referenceError = ''; this.referenceGeneration = 0; this.voiceWrites = Promise.resolve();
    this.speechSelections = new Map(); this.singingSelections = new Map(); this.singingReference = null; this.singingReferenceTask = null; this.singingReferenceError = '';
    this.references = null; this.diagnosticLog = null;
    this.cleanupPlans = new Map(); this.maintenance = null; this.configWrites = 0; this.voiceWritesPending = 0;
    this.secret = secret; this.storeSecret = storeSecret; this.persistConfig = persist;
    this.detectQQ = dependencies.detectQQ ?? detectQQ; this.qq = qqUnknown(); this.qqRequest = null; this.qqLastCheck = 0;
    this.synthesize = dependencies.synthesize ?? synthesize;
    this.listModels = dependencies.listModels ?? listModels;
    this.runProcess = dependencies.runProcess ?? runProcess;
    this.host = null; this.jobs = new Map(); this.queue = []; this.active = null; this.stopping = false; this.hold = false;
    this.player = new Player({ factory: dependencies.playFile, onState: (id, state, result) => this.playState(id, state, result) });
  }
  envPromptVars() { return {}; }
  torchDeviceArgs() { return this.device.speechBackend === 'torch' ? ['--device', this.engine?.runtimeProfile === 'windows-cuda' ? 'cuda' : 'cpu'] : []; }
  key() { const name = settings(this.cfg).apiKeySecret; if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new StudioError('密钥变量名无效。'); const key = String(this.secret(name) ?? '').trim(); if (/\s/.test(key) || key.length > 4096) throw new StudioError('密钥格式无效，请重新填写。'); return key; }
  tools() { return TOOLS.filter((tool) => tool.name !== 'voice_studio_sing' || settings(this.cfg).singingEnabled).map((tool) => ({ ...tool, handler: async (args = {}) => {
    try {
      if (tool.name === 'voice_studio_transcribe') {
        const job = await this.transcribeQQ(args.messageId);
        return { text: job.status === 'completed' ? `QQ 语音识别结果（message_id=${job.input}）：\n${job.transcript}` : `正在识别 QQ 语音，任务 ${job.id}，message_id=${job.input}。完成后会交付转写内容，请等待，不要重复请求或猜测内容。` };
      }
      if (tool.name === 'voice_studio_speak' || tool.name === 'voice_studio_sing') {
        const kind = tool.name === 'voice_studio_speak' ? 'speech' : 'song';
        const job = this.enqueue(kind, kind === 'speech' ? args.text : args.keyword, { playback: args.playback === true, deliver: true, voice: args.voice, style: args.style, description: args.description, useReference: args.useReference, title: args.title, lines: args.lines });
        return { text: `任务已接收：${job.id}。完成后交付音频；${job.playbackRequested ? '插件会自行排队播放，不要重复调用播放工具。' : '只制作文件。'} 不要重复提交。` };
      }
      if (tool.name === 'voice_studio_status') return { text: JSON.stringify(this.state(args.jobId), null, 2) };
      if (tool.name === 'voice_studio_play') return { text: JSON.stringify(this.play(args.jobId)) };
      await this.stopAll(); return { text: '已停止工作室的生成、排队任务和播放。' };
    } catch (error) { return { text: publicError(error), failed: true }; }
  } })); }
  async start(host) {
    this.assertOperational();
    if (this.host) return;
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    if (lstatSync(this.root).isSymbolicLink()) throw new Error('Studio directory cannot be a symlink');
    this.root = realpathSync(this.root); this.stopping = false; this.hold = false; this.jobs.clear(); this.queue = []; this.speechSelections.clear(); this.singingSelections.clear();
    this.diagnosticLog = new DiagnosticLog({ root: this.root, version: VERSION }); this.references = null;
    try { this.references = new ReferenceLibrary({ root: this.root }); this.references.migrate(this.cfg); }
    catch (error) { this.referenceError = '已保存的参考音频暂时无法读取，请到日志页复制诊断信息。'; this.diagnosticLog.record({ level: 'error', area: 'reference', error }); }
    try { this.singingReference = new SingingReference({ root: this.root }); }
    catch (error) { this.singingReferenceError = '演唱参考目录无法读取，请到日志页查看诊断信息。'; this.recordDiagnostic({ level: 'error', area: 'reference', error }); }
    if (settings(this.cfg).backend === 'managed' && !this.engine) {
      const Engine = this.engineFactory ?? (await import('./managed-engine.js')).ManagedEngine;
      const cfg = settings(this.cfg);
      this.engine = new Engine({ root: this.root, packageDir: PACKAGE_DIR, platform: this.device.platform, arch: this.device.arch, osRelease: this.osRelease, ...(cfg.aceRoot && cfg.pythonPath ? { existingSinging: { aceRoot: cfg.aceRoot, acePython: cfg.pythonPath, checkpointRoot: cfg.checkpointRoot || join(cfg.aceRoot,'checkpoints') } } : {}) });
    }
    for (const entry of readdirSync(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !JOB_ID.test(entry.name)) continue;
      try { const dir = join(this.root, entry.name), job = readJson(dir, join(dir, 'job.json'));
        if (job.id !== entry.name || !['speech', 'song', 'transcription'].includes(job.kind) || typeof job.input !== 'string') continue;
        if (!TERMINAL.has(job.status)) { job.status = 'cancelled'; job.error = '应用重启，未完成任务已取消。'; job.finishedAt = stamp(); }
        if (['playing', 'queued'].includes(job.playback)) job.playback = 'stopped';
        if (job.delivery === 'pending') job.delivery = 'interrupted';
        this.jobs.set(job.id, job); this.persist(job);
        if (job.kind === 'transcription' && job.status === 'completed') this.transcriptionJobs.set(job.input, job.id);
      } catch {} }
    this.host = host; void this.refreshQQ(); this.autoInitialize();
    if (settings(this.cfg).backend === 'managed' && host.store && this.botDir) {
      this.inbox = new this.Inbox({ store: host.store, onVoice: async event => {
        const ingressGeneration = this.ingressGeneration;
        try {
          if (this.setupTasks.has('speech')) await this.setupTasks.get('speech');
          if (event.signal.aborted || this.stopping || ingressGeneration !== this.ingressGeneration) return;
          const job = await this.transcribeQQ(event.messageId, { signal: event.signal, eventId: event.eventId });
          while (!event.signal.aborted && !this.stopping && !TERMINAL.has(this.jobs.get(job.id)?.status)) await new Promise(resolve => setTimeout(resolve, 50));
        } catch (error) {
          if (!event.signal.aborted && !this.stopping && ingressGeneration === this.ingressGeneration) await this.host?.pushEvent({ type: 'voice-studio.failed', source: ID, senderKey: String(event.messageId), ts: stamp(), text: `QQ 语音暂未识别：${publicError(error)}\nmessage_id=${event.messageId}。不要猜测语音内容；排查后可调用 voice_studio_transcribe 重试。`, meta: { kind: 'transcription', message_id: event.messageId, conv: event.conv } }, { deliver: true, trigger: 'debounce' });
        }
      } });
      this.inbox.start();
    }
  }
  recordDiagnostic(event) { try { return this.diagnosticLog?.record(event); } catch { return null; } }
  async stop() {
    if (!this.host) return;
    this.stopping = true; this.inbox?.stop(); this.inbox = null; this.cleanupPlans.clear();
    await this.maintenance?.catch(() => {});
    const results = await Promise.allSettled([this.cancelSetup({ pause: false }), this.stopAll()]);
    await this.singingReferenceTask?.catch(() => {}); this.host = null;
    this.assertOperational();
    const failure = results.find(result => result.status === 'rejected'); if (failure) throw failure.reason;
  }
  assertOperational() { if (this.stopFailure) throw Object.assign(new StudioError(this.stopFailure.message), { code: 'PROCESS_TERMINATION_FAILED', terminationFailed: true, ...terminationDetails(this.stopFailure) }); }
  captureStopFailure(result) {
    if (!result?.terminationFailed && result?.code !== 'PROCESS_TERMINATION_FAILED') return false;
    if (!this.stopFailure) {
      const details = terminationDetails(result);
      this.stopFailure = { code: details.terminationErrorCode || 'PROCESS_TERMINATION_FAILED', message: '无法确认后台程序已停止，已暂停新任务和清理。请完全退出 Coopanion，在任务管理器或活动监视器确认相关程序结束后再启动。', ...details };
      const failure = { terminationFailed: true, ...details };
      this.recordDiagnostic({ level: 'error', area: 'system', code: 'PROCESS_TERMINATION_FAILED', result: failure, error: Object.assign(new StudioError(this.stopFailure.message), { code: 'PROCESS_TERMINATION_FAILED', ...failure }) });
    }
    this.hold = true; this.ingressGeneration++; this.cleanupPlans.clear(); this.inbox?.stop();
    for (const request of this.qqReads.values()) request.controller.abort();
    for (const id of this.queue.splice(0)) { const job = this.jobs.get(id); if (!job) continue; Object.assign(job, { status: 'cancelled', error: '后台程序停止状态异常，排队任务已取消。', finishedAt: stamp(), delivery: 'cancelled' }); this.speechSelections.delete(id); this.singingSelections.delete(id); try { this.persist(job); } catch {} }
    return true;
  }
  assertNotCleaning() { this.assertOperational(); if (this.maintenance) throw new StudioError('正在清理存储，请完成后再操作。'); this.cleanupPlans.clear(); }
  storageBusy() {
    return !!(this.stopFailure || this.maintenance || this.active || this.queue.length || this.qqReads.size || this.singingReferenceTask || this.referenceTask || this.setupTasks.size || this.engine?.busy || this.engine?.child || this.configWrites || this.voiceWritesPending || this.player.current || this.player.pending.length || this.stopping || this.hold);
  }
  storageOptions() {
    const paths = this.engine?.paths?.() ?? {}, cfg = settings(this.cfg), externalModels = [];
    const checkpointRoot = paths.checkpointRoot || cfg.checkpointRoot || (cfg.aceRoot ? join(cfg.aceRoot, 'checkpoints') : '');
    if (checkpointRoot && resolve(checkpointRoot) !== join(this.root, 'engine-v1/models/singing')) externalModels.push({ id: 'singing', label: '外部唱歌模型', path: checkpointRoot });
    return { profile: this.device, externalModels, protectedPaths: [paths.asrPython, paths.speechPython, paths.acePython, paths.ffmpegPath, paths.aceRoot, cfg.referenceAudioPath, cfg.pythonPath, cfg.ffmpegPath].filter(value => typeof value === 'string' && isAbsolute(value)) };
  }
  async storageStatus() {
    if (!this.host) throw new StudioError('请先启用语音助手，再查看存储。');
    const usage = await inspectStorage(this.root, this.storageOptions());
    let freeBytes = null;
    try { const disk = await statfs(this.root); freeBytes = disk.bavail * disk.bsize; } catch {}
    return { ...usage, rootPath: this.root, freeBytes, busy: this.storageBusy() };
  }
  async previewCleanup(request) {
    this.assertOperational();
    if (!this.host || this.storageBusy()) throw new StudioError('请等待下载、生成和播放完成后再清理。');
    const plan = await planCleanup(this.root, request, this.storageOptions());
    if (this.storageBusy()) throw new StudioError('当前有任务正在运行，请完成后重新预览清理范围。');
    for (const [key, value] of this.cleanupPlans) if (value.expires < Date.now()) this.cleanupPlans.delete(key);
    while (this.cleanupPlans.size >= 8) this.cleanupPlans.delete(this.cleanupPlans.keys().next().value);
    const token = randomUUID(); this.cleanupPlans.set(token, { plan, expires: Date.now() + 5 * 60 * 1000 });
    return { token, type: plan.type, bytes: plan.bytes, count: plan.targets.length, jobCount: plan.jobIds?.length ?? 0, modelIds: plan.modelIds ?? [], warnings: plan.warnings ?? [], blocked: plan.blocked ?? false };
  }
  async cleanup(value) {
    this.assertOperational();
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => key !== 'token') || typeof value.token !== 'string') throw new StudioError('请先预览本次清理范围。');
    const pending = this.cleanupPlans.get(value.token);
    if (!pending || pending.expires < Date.now()) throw new StudioError('清理确认已过期，请重新选择清理范围。');
    if (!this.host || this.storageBusy()) throw new StudioError('请等待下载、生成和播放完成后再清理。');
    this.cleanupPlans.clear();
    // Set the lock before any asynchronous work; new jobs, downloads and config
    // writes must not start between the eligibility check and filesystem removal.
    const operation = Promise.resolve().then(async () => {
      const plan = pending.plan;
      if (plan.type === 'models' && (plan.modelIds ?? []).some(id => ['reference','asr'].includes(id))) writeJson(join(this.root, 'voice-setup.json'), { paused: true });
      if (plan.type === 'models' && (plan.modelIds ?? []).includes('singing') && this.cfg.singingEnabled) {
        if (typeof this.persistConfig !== 'function') throw new StudioError('当前宿主无法保存唱歌开关，请稍后重试。');
        await this.persistConfig({ singingEnabled: false }); this.cfg.singingEnabled = false;
      }
      this.recordDiagnostic({ level: 'info', area: 'system', code: 'STORAGE_CLEANUP_STARTED' });
      const result = await executeCleanup(this.root, plan);
      for (const id of result.removedJobIds) { this.jobs.delete(id); this.speechSelections.delete(id); }
      for (const [messageId, id] of this.transcriptionJobs) if (result.removedJobIds.includes(id)) this.transcriptionJobs.delete(messageId);
      if (result.removedModelIds.length) {
        this.engine?.forgetModels?.(result.removedModelIds);
        for (const id of result.removedModelIds) {
          if (id === 'asr') this.setupErrors.delete('transcription');
          else if (id === 'reference') { this.setupErrors.delete('speech'); this.setupErrors.delete('reference'); }
          else if (id === 'singing') this.setupErrors.delete('singing');
        }
        if (result.removedModelIds.some(id => ['asr','reference'].includes(id))) { this.setupErrors.delete('reference'); this.referenceError = ''; }
      }
      this.recordDiagnostic({ level: result.failed.length ? 'warning' : 'info', area: 'system', code: result.failed.length ? 'STORAGE_CLEANUP_PARTIAL' : 'STORAGE_CLEANUP_COMPLETED' });
      return result;
    });
    this.maintenance = operation;
    let result;
    try { result = await operation; }
    catch (error) { this.recordDiagnostic({ level: 'error', area: 'system', code: 'STORAGE_CLEANUP_FAILED', error }); throw error; }
    finally { if (this.maintenance === operation) this.maintenance = null; }
    return { ...result, failed: result.failed.map(({ reason }) => ({ reason })), skipped: result.skipped.map(({ reason }) => ({ reason })), storage: await this.storageStatus() };
  }
  autoInitialize() {
    if (this.stopFailure || !this.device.supported || settings(this.cfg).backend !== 'managed' || !this.engine) return;
    let policy = {};
    try { policy = readJson(this.root, join(this.root, 'voice-setup.json')); } catch {}
    const status = this.engineStatus();
    if (policy.paused || ['speech', 'transcription'].some(kind => status[kind].supported === false || status[kind].state === 'failed')) return;
    if (['speech', 'transcription'].every(kind => status[kind].state === 'ready') && (!this.cfg.referenceAudioPath || status.reference.state === 'ready')) return;
    try { this.initialize('speech'); } catch { this.setupErrors.set('speech', '语音准备尚未开始，请在面板重试。'); }
  }
  async stopAll() {
    this.hold = true;
    this.ingressGeneration++;
    for (const request of this.qqReads.values()) request.controller.abort();
    await Promise.allSettled([...this.qqReads.values()].map(request => request.promise));
    for (const id of this.queue.splice(0)) { const job = this.jobs.get(id); job.status = 'cancelled'; job.error = '用户停止，排队任务已取消。'; job.finishedAt = stamp(); job.delivery = 'cancelled'; this.speechSelections.delete(id); this.singingSelections.delete(id); this.persist(job); }
    const active = this.active;
    if (active) { active.cancelled = true; active.abort.abort(); active.process?.cancel(); }
    const [, playbackResult] = await Promise.all([active?.promise, this.player.stop()]);
    this.captureStopFailure(playbackResult); this.assertOperational();
    this.hold = false;
    if (!this.stopping) this.drain();
  }
  persist(job) { writeJson(join(this.root, job.id, 'job.json'), job); }
  runnerPath() { return this.runner; }
  prerequisites(kind, cfg) {
    this.assertOperational();
    if (cfg.backend === 'managed') {
      const engine = this.engineStatus(), component = kind === 'song' ? 'singing' : kind === 'speech' && cfg.referenceAudioPath ? 'reference' : kind;
      if (engine[component]?.supported === false) throw new StudioError(engine[component].unsupportedReason);
      if (kind === 'transcription') {
        if (engine.transcription.state !== 'ready') throw new StudioError('语音识别模型尚未准备完成，请等待面板准备完成或点击重试。');
        if (!isFile(this.transcriptionRunner)) throw new StudioError('语音识别组件缺失，请重新安装插件。');
      } else if (kind === 'speech') {
        if (!cfg.referenceAudioPath && engine.speech.state !== 'ready') throw new StudioError('请先点击“初始化语音”，准备默认声音。');
        if (!!cfg.referenceAudioPath !== !!cfg.referenceText) throw new StudioError('参考声音尚未准备完成，请重新上传或使用默认音色。');
        if (cfg.referenceAudioPath && (engine.reference.state !== 'ready' || !isFile(cfg.referenceAudioPath))) throw new StudioError('参考声音组件尚未准备好，请重新上传或使用默认音色。');
        if (!isFile(this.speechRunner)) throw new StudioError('语音组件缺失，请重新安装插件。');
        if (!cfg.referenceAudioPath) defaultVoiceReference();
      } else {
        if (!cfg.singingEnabled) throw new StudioError('唱歌功能尚未开启，请先开启唱歌。');
        singingPreferences({}, cfg);
        if (engine.singing.state !== 'ready') throw new StudioError('请先点击“准备唱歌”，下载唱歌组件。');
        if (!isFile(this.runnerPath())) throw new StudioError('唱歌组件缺失，请重新安装插件。');
      }
      return;
    }
    if (kind === 'transcription') throw new StudioError('请启用新版本地语音模型后再识别 QQ 语音。');
    endpoint(cfg.baseUrl, 'models');
    if (kind === 'speech') {
      if (!cfg.ttsModel) throw new StudioError('请先填写说话模型名称。');
      if (!!cfg.referenceAudioPath !== !!cfg.referenceText) throw new StudioError('参考 WAV 与逐字稿需要同时填写。');
    } else {
      if (!cfg.singingEnabled) throw new StudioError('唱歌功能尚未开启，请先在面板开启并准备唱歌模型。');
      singingPreferences({}, cfg);
      if (!cfg.lyricModel) throw new StudioError('请先填写写词模型名称。');
      if (!isDir(join(cfg.aceRoot, 'acestep'))) throw new StudioError('找不到 ACE-Step 目录，请运行环境检查。');
      if (!isFile(cfg.pythonPath, true)) throw new StudioError('找不到可执行的 ACE-Step Python，请运行环境检查。');
      if (!isFile(cfg.ffmpegPath, true)) throw new StudioError('找不到可执行的 FFmpeg，请运行环境检查。');
      const models = inspectSongModels(cfg.checkpointRoot || join(cfg.aceRoot, 'checkpoints'));
      if (!models.ok) throw new StudioError(`唱歌模型尚未完整下载：${models.missing.join('、')}。请按面板中的下载指引准备。`);
      if (!isFile(this.runnerPath())) throw new StudioError('唱歌组件缺失，请重新安装插件。');
    }
  }
  async transcribeQQ(value, { signal, eventId } = {}) {
    this.assertNotCleaning();
    const messageId = String(value ?? '');
    if (!/^-?\d{1,24}$/.test(messageId)) throw new StudioError('请提供收到的 QQ 语音消息编号。');
    if (!this.host || this.stopping || this.hold || signal?.aborted) throw new StudioError('语音助手尚未运行或请求已取消。');
    const existing = this.jobs.get(this.transcriptionJobs.get(messageId));
    if (existing && !['failed', 'cancelled'].includes(existing.status)) return this.view(existing);
    if (this.qqReads.has(messageId)) return this.qqReads.get(messageId).promise;
    const cfg = settings(this.cfg); this.prerequisites('transcription', cfg);
    if (this.queue.length + (this.active ? 1 : 0) + this.qqReads.size >= cfg.maxQueue) throw new StudioError('语音任务较多，请等待当前任务完成后重试。');
    const controller = new AbortController(), generation = this.ingressGeneration;
    const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true });
    const request = { controller, promise: null };
    request.promise = (async () => {
      const audio = await this.readQQAudio({ host: this.host, botDir: this.botDir, messageId, eventId, signal: controller.signal });
      if (controller.signal.aborted || this.stopping || this.hold || generation !== this.ingressGeneration) throw new StudioError('语音识别已取消。');
      if (!Buffer.isBuffer(audio.bytes) || audio.bytes.length > 20 * 1024 * 1024 || sniffAudio(audio.bytes) !== 'audio/wav') throw new StudioError('QQ 未提供可识别的录音。');
      const id = `${Date.now()}-${randomUUID().slice(0, 8)}`, dir = join(this.root, id);
      mkdirSync(dir, { mode: 0o700 }); writeFileSync(join(dir, 'input.wav'), audio.bytes, { flag: 'wx', mode: 0o600 });
      const job = { id, kind: 'transcription', input: messageId, title: 'QQ 语音识别', source: audio.source, status: 'queued', createdAt: stamp(), playbackRequested: false, playback: 'none', deliverRequested: true, delivery: 'pending' };
      this.persist(job); this.jobs.set(id, job); this.transcriptionJobs.set(messageId, id); this.queue.push(id); this.drain();
      return this.view(job);
    })().catch(error => { if (!controller.signal.aborted) this.recordDiagnostic({ level: 'error', area: 'qq', code: error.code, error }); throw error; }).finally(() => { signal?.removeEventListener('abort', abort); if (this.qqReads.get(messageId) === request) this.qqReads.delete(messageId); });
    this.qqReads.set(messageId, request); return request.promise;
  }
  enqueue(kind, input, { playback = false, deliver = false, voice, style, description, useReference, title, lines } = {}) {
    this.assertNotCleaning();
    if (!this.host || this.stopping || this.hold) throw new StudioError('工作室尚未运行或正在停止。');
    if (kind === 'song' && this.singingReferenceTask) throw new StudioError('正在处理演唱参考，请完成后再生成。');
    if (!['speech', 'song'].includes(kind)) throw new StudioError('未知任务类型。');
    input = textInput(input, kind === 'speech' ? 1000 : 100, kind === 'song');
    const cfg = settings(this.cfg);
    const singing = kind === 'song' ? singingPreferences({ voice, style, description, useReference }, cfg) : {};
    const lyrics = kind === 'song' ? suppliedLyrics(title, lines) : {};
    this.prerequisites(kind, { ...cfg, ...singing }); if (cfg.backend === 'legacy') this.key();
    if (kind === 'song' && cfg.backend === 'managed' && !lyrics.lyricLines) throw new StudioError('请提供歌名和四句中文歌词；在 QQ 中给大肥鱼一个主题，它会先写词再唱。面板可使用测试歌词。');
    if (this.queue.length + (this.active ? 1 : 0) + this.qqReads.size >= cfg.maxQueue) throw new StudioError('任务队列已满，请等待当前任务完成。');
    const id = `${Date.now()}-${randomUUID().slice(0, 8)}`;
    const job = { id, kind, input, ...singing, ...lyrics, title: kind === 'speech' ? input.slice(0, 40) : lyrics.lyricTitle ?? input, status: 'queued', createdAt: stamp(), playbackRequested: !!playback, playback: 'none', deliverRequested: !!deliver, delivery: deliver ? 'pending' : 'skipped' };
    if (kind === 'speech' && cfg.backend === 'managed') this.speechSelections.set(id, { referenceAudioPath: cfg.referenceAudioPath, referenceText: cfg.referenceText, referenceName: cfg.referenceName });
    const dir = join(this.root, id); mkdirSync(dir, { mode: 0o700 });
    try {
      if (kind === 'song') {
        const reference = singing.singingUseReference ? this.singingReference?.snapshotTo(dir) ?? '' : '';
        job.singingReferenceUsed = !!reference; this.singingSelections.set(id, reference);
      }
      this.persist(job);
    } catch (error) {
      this.speechSelections.delete(id); this.singingSelections.delete(id);
      rmSync(dir, { recursive: true, force: true }); throw error;
    }
    this.jobs.set(id, job); this.queue.push(id); this.drain(); return this.view(job);
  }
  drain() {
    if (this.stopFailure || this.active || this.stopping || this.hold || this.referenceTask?.executing || !this.host || !this.queue.length) return;
    const job = this.jobs.get(this.queue.shift()); const active = { id: job.id, cancelled: false, abort: new AbortController(), process: null, promise: null }; this.active = active;
    active.promise = this.run(job, active).catch(error => { this.recordDiagnostic({ level: 'error', area: job.kind, code: 'JOB_FAILED', jobId: job.id, error }); job.status = 'failed'; job.error = '任务无法保存或交付，请检查本地目录权限。'; job.finishedAt = stamp(); try { this.persist(job); } catch {} }).finally(() => { this.speechSelections.delete(job.id); this.singingSelections.delete(job.id); this.active = null; this.drain(); });
  }
  async run(job, active) {
    const cfg = { ...settings(this.cfg), ...(job.kind === 'song' ? { singingVoice: job.singingVoice, singingStyle: job.singingStyle, singingDescription: job.singingDescription ?? '', singingUseReference: job.singingUseReference ?? true } : this.speechSelections.get(job.id) ?? {}) }, dir = join(this.root, job.id), outputDir = join(dir, 'output');
    job.status = 'running'; job.startedAt = stamp(); this.persist(job);
    this.recordDiagnostic({ level: 'info', area: job.kind, code: 'JOB_STARTED', jobId: job.id });
    let output;
    try {
      this.prerequisites(job.kind, cfg); const key = cfg.backend === 'legacy' ? this.key() : '';
      if (job.kind === 'transcription') {
        const paths = this.engine.paths();
        active.process = this.runProcess({ pythonPath: paths.asrPython ?? paths.speechPython, runnerPath: this.transcriptionRunner, args: ['--input', join(dir, 'input.wav'), '--output', outputDir, '--asr-model', paths.asrModel, '--ffmpeg', paths.ffmpegPath, ...this.torchDeviceArgs()], outputDir, logPath: join(dir, 'runner.log'), timeoutMs: Math.min(cfg.timeoutMs, 180000) });
        this.processResult(active.lastResult = await active.process.promise, 'QQ 语音识别');
        const result = readJson(outputDir, join(outputDir, 'transcription.json'));
        if (typeof result.text !== 'string' || !result.text.trim() || result.text.length > 12000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(result.text) || !Number.isFinite(result.durationSeconds) || result.durationSeconds < 0.1 || result.durationSeconds > 120) throw new StudioError('未识别到清楚的语音内容。');
        output = { transcript: result.text.trim(), durationSeconds: result.durationSeconds, bytes: Buffer.alloc(0) };
      } else if (job.kind === 'speech' && cfg.backend === 'managed') {
        const paths = this.engine.paths(), configPath = join(dir, 'runtime-config.json'), textFile = join(dir, 'input.txt');
        const reference = cfg.referenceAudioPath ? { audio: cfg.referenceAudioPath, text: cfg.referenceText } : defaultVoiceReference();
        writeJson(configPath, { modelPath: paths.baseModel, language: 'chinese', referenceAudioPath: reference.audio, referenceText: reference.text });
        writeFileSync(textFile, job.input, { flag: 'wx', mode: 0o600 });
        active.process = this.runProcess({ pythonPath: paths.speechPython, runnerPath: this.speechRunner, args: ['--config', configPath, '--output', outputDir, '--text-file', textFile, ...this.torchDeviceArgs()], outputDir, logPath: join(dir, 'runner.log'), timeoutMs: cfg.timeoutMs });
        this.processResult(active.lastResult = await active.process.promise, '语音');
        output = { ...speechOutput(outputDir), title: job.title };
      } else if (job.kind === 'speech') {
        const audio = await this.synthesize(cfg, job.input, key, active.abort.signal);
        if (!Buffer.isBuffer(audio.bytes) || !sniffAudio(audio.bytes) || audio.bytes.length > MAX_AUDIO_BYTES) throw new StudioError('语音输出无效或过大。');
        if (active.cancelled) throw new StudioError('已取消。');
        mkdirSync(outputDir, { mode: 0o700 }); const path = join(outputDir, audio.mime === 'audio/mpeg' ? 'speech.mp3' : 'speech.wav');
        writeFileSync(path, audio.bytes, { flag: 'wx', mode: 0o600 });
        output = { ...audio, audio: path, title: job.title, durationSeconds: null };
      } else {
        const cacheRoot = join(this.root, 'cache'); mkdirSync(cacheRoot, { recursive: true, mode: 0o700 });
        const configPath = join(dir, 'runtime-config.json');
        const paths = cfg.backend === 'managed' ? this.engine.paths() : cfg;
        const runtime = cfg.backend === 'managed' ? { aceRoot: paths.aceRoot, pythonPath: paths.acePython, checkpointRoot: paths.checkpointRoot, ffmpegPath: paths.ffmpegPath, singingVoice: cfg.singingVoice, singingStyle: cfg.singingStyle, lyricSource: 'provided', title: job.lyricTitle, lines: job.lyricLines } : Object.fromEntries(['baseUrl', 'lyricModel', 'aceRoot', 'pythonPath', 'checkpointRoot', 'ffmpegPath', 'singingVoice', 'singingStyle'].map((key) => [key, cfg[key]]));
        runtime.singingDescription = cfg.singingDescription;
        if (cfg.backend === 'managed' && this.device.speechBackend === 'torch') runtime.computeDevice = this.engine?.runtimeProfile === 'windows-cuda' ? 'cuda' : 'cpu';
        runtime.singingReferenceAudio = this.singingSelections.get(job.id) ?? '';
        runtime.cacheRoot = cacheRoot; writeJson(configPath, runtime);
        const timeoutMs = cfg.backend === 'managed' && this.device.speechBackend === 'torch' && this.engine?.runtimeProfile !== 'windows-cuda' ? Math.max(cfg.timeoutMs, 3600000) : cfg.timeoutMs;
        active.process = this.runProcess({ pythonPath: cfg.backend === 'managed' ? paths.acePython : cfg.pythonPath, runnerPath: this.runnerPath(), configPath, keyword: job.input, ...(cfg.backend === 'managed' ? { args: ['--config', configPath, '--output', outputDir, '--', job.input] } : {}), outputDir, logPath: join(dir, 'runner.log'), timeoutMs, key });
        const result = active.lastResult = await active.process.promise;
        if (this.captureStopFailure(result)) this.assertOperational();
        if (result.timedOut) throw new StudioError('生成等待超过上限，已停止；请检查模型与系统文件访问权限。');
        if (result.spawnError) throw new StudioError('唱歌程序无法启动，请检查 Python 路径与系统权限。');
        if (result.code !== 0) throw new StudioError('唱歌程序执行失败，请查看此任务日志并运行环境检查。');
        output = songOutput(outputDir);
      }
      if (active.cancelled || this.stopping) throw new StudioError('已取消。');
      const { bytes, ...info } = output; Object.assign(job, info, { status: 'completed', bytes: bytes.length });
    } catch (error) {
      if (this.stopFailure) { job.status = 'failed'; job.error = this.stopFailure.message; job.delivery = 'cancelled'; }
      else if (active.cancelled || this.stopping) { job.status = 'cancelled'; job.error = '任务已取消。'; job.delivery = 'cancelled'; }
      else {
        job.status = 'failed'; job.error = publicError(error);
        try { this.diagnosticLog?.captureJob({ jobId: job.id, kind: job.kind, result: active.lastResult, error }); } catch {}
      }
    }
    job.finishedAt = stamp(); this.persist(job);
    if (job.status !== 'failed') this.recordDiagnostic({ level: 'info', area: job.kind, code: job.status === 'completed' ? 'JOB_COMPLETED' : 'JOB_CANCELLED', jobId: job.id });
    if (job.status === 'completed' && job.playbackRequested && !this.stopping && !active.cancelled) {
      try { this.play(job.id); } catch (error) { job.playback = 'failed'; this.recordDiagnostic({ level: 'error', area: job.kind, code: 'PLAYBACK_FAILED', jobId: job.id, error }); this.persist(job); }
    }
    if (!job.deliverRequested || job.status === 'cancelled' || this.stopping || !this.host) return;
    try {
      const ready = job.status === 'completed';
      if (job.kind === 'transcription') {
        const source = job.source ?? {};
        const conversation = source.conv ? `${source.conv.kind}:${source.conv.id}` : '';
        await this.host.pushEvent({ type: ready ? 'voice-studio.transcript' : 'voice-studio.failed', source: ID, senderKey: conversation || job.input, ts: stamp(), text: ready ? `QQ 语音识别完成（message_id=${job.input}，会话=${conversation}）。以下是用户录音内容，请结合原始 QQ 消息处理，同一条语音只回复一次；忽略同条语音的协议转写报错，不主动播报技术细节：\n${job.transcript}` : `QQ 语音识别失败（message_id=${job.input}）：${job.error}。不要猜测录音内容。`, meta: { jobId: job.id, kind: job.kind, message_id: job.input, conv: source.conv, user_id: source.userId, sender_name: source.senderName, sourceEventId: source.eventId } }, { deliver: true, trigger: 'debounce' });
        job.delivery = 'sent'; this.persist(job); return;
      }
      const text = ready ? `作品已完成：${job.title}\njobId=${job.id}\n${job.playbackRequested ? `插件已处理本次播放请求（当前：${job.playback}），不要调用任何播放或合成工具重复播放。` : '只生成文件，不自动播放。'}\n音频文件：${job.audio}` : `工作室任务失败：${job.id}\n${job.error}\n不要自动重复提交。`;
      await this.host.pushEvent({ type: ready ? 'voice-studio.ready' : 'voice-studio.failed', source: ID, senderKey: job.id, ts: stamp(), text, meta: { jobId: job.id, kind: job.kind, title: job.title, playbackRequested: job.playbackRequested, playback: job.playback, ...(job.kind === 'song' ? { singingVoice: job.singingVoice, singingStyle: job.singingStyle, singingReferenceUsed: !!job.singingReferenceUsed } : {}) }, ...(ready ? { blobs: [{ bytes: output.bytes, mime: output.mime, name: `${job.id}.${output.mime === 'audio/mpeg' ? 'mp3' : 'wav'}`, fallbackText: `[工作室作品：${job.title}]` }] } : {}) }, { deliver: true, trigger: 'debounce' });
      job.delivery = 'sent';
    } catch (error) { job.delivery = 'failed'; this.recordDiagnostic({ level: 'error', area: job.kind, code: 'DELIVERY_FAILED', jobId: job.id, error }); }
    this.persist(job);
  }
  processResult(result, label) {
    if (this.captureStopFailure(result)) this.assertOperational();
    if (result.timedOut) throw new StudioError(`${label}等待超时，已停止；请重试或检查初始化状态。`);
    if (result.spawnError) throw new StudioError(`${label}引擎无法启动，请重新初始化。`);
    if (result.code !== 0) throw new StudioError(`${label}处理失败，请换一段清晰录音或重新初始化后重试。`);
  }
  engineStatus() {
    const raw = this.engine?.status?.() ?? {};
    return Object.fromEntries(['speech','transcription','singing','reference'].map(kind => {
      const value = raw[kind] ?? { state: 'missing', stage: '' };
      const supported = this.device.supported && value.supported !== false;
      const capability = { supported, ...(!supported ? { unsupportedReason: !this.device.supported ? this.device.unsupportedReason : typeof value.unsupportedReason === 'string' ? value.unsupportedReason.slice(0, 300) : '本机暂不支持此功能。' } : {}) };
      if (value.state === 'ready') {
        this.setupErrors.delete(kind);
        return [kind, { ...capability, state: 'ready', stage: '已准备好' }];
      }
      const state = this.setupTasks.has(kind) && value.state !== 'ready' ? 'preparing' : ['missing','preparing','ready','failed'].includes(value.state) ? value.state : 'missing';
      const failure = this.setupErrors.get(kind);
      const error = typeof failure === 'string' ? failure : failure?.error ?? value.error;
      const diagnostic = typeof error === 'string' ? diagnose({ message: error, diagnostic: { code: failure?.errorCode ?? value.errorCode, details: failure?.errorDetails ?? value.errorDetails, errorType: failure?.errorType ?? value.errorType } }) : undefined;
      const progress = state === 'preparing' && !this.setupErrors.has(kind) ? publicPreparationProgress(value.progress) : undefined;
      const failureProgress = value.state === 'failed' ? publicPreparationProgress(value.failureProgress) : undefined;
      return [kind, { ...capability, state: this.setupErrors.has(kind) ? 'failed' : state, stage: typeof value.stage === 'string' ? value.stage.slice(0,180) : '', ...(progress ? { progress } : {}),
        ...(failureProgress ? { failureProgress } : {}),
        ...(PREPARATION_STEPS.has(value.setupStep) ? { setupStep: value.setupStep } : {}),
        ...(['asr', 'reference', 'singing'].includes(value.component) ? { component: value.component } : {}),
        ...(Number.isSafeInteger(value.failedAt) && value.failedAt >= 0 ? { failedAt: value.failedAt } : {}),
        ...(DOWNLOAD_SOURCES.includes(value.source) ? { source: value.source } : {}),
        ...(value.source === 'overseas' && DOWNLOAD_FALLBACK_CODES.includes(value.fallbackReason) ? { fallbackReason: value.fallbackReason } : {}),
        ...(diagnostic ? { error: diagnostic.message, errorCode: diagnostic.code, errorDetails: diagnostic.details, errorType: diagnostic.errorType } : {}) }];
    }));
  }
  initialize(kind = 'speech') {
    this.assertNotCleaning();
    if (!this.host || this.stopping || settings(this.cfg).backend !== 'managed' || !this.engine) throw new StudioError('语音助手尚未启动。');
    if (!['speech','singing'].includes(kind)) throw new StudioError('初始化类型无效。');
    const status = this.engineStatus();
    for (const component of kind === 'speech' ? ['speech', 'transcription'] : [kind]) if (status[component].supported === false) throw new StudioError(status[component].unsupportedReason);
    if (this.singingReferenceTask || this.referenceTask || [...this.setupTasks.keys()].some(key => key !== kind)) throw new StudioError('另一个组件仍在准备中，请完成或取消后再试。');
    if (!this.setupTasks.has(kind)) {
      for (const component of kind === 'speech' ? ['speech', 'transcription', 'reference'] : [kind]) this.setupErrors.delete(component);
      if (kind === 'speech') writeJson(join(this.root, 'voice-setup.json'), { paused: false });
      const generation = this.setupGeneration;
      let component = kind, setupStartedAt = Date.now();
      const prepareComponent = async next => {
        component = next; setupStartedAt = Date.now();
        this.recordDiagnostic({ level: 'info', area: component, code: 'SETUP_STARTED' });
        this.assertOperational();
        await this.engine.prepare(component);
        this.assertOperational();
        if (generation === this.setupGeneration && !this.stopping) this.recordDiagnostic({ level: 'info', area: component, code: 'SETUP_READY' });
      };
      const promise = Promise.resolve().then(async () => {
        if (generation !== this.setupGeneration || this.stopping) return;
        if (kind === 'speech') await prepareComponent('transcription');
        if (generation !== this.setupGeneration || this.stopping) return;
        await prepareComponent(kind);
        if (generation !== this.setupGeneration || this.stopping) return;
        if (kind === 'speech' && this.cfg.referenceAudioPath && this.cfg.referenceText) await prepareComponent('reference');
      }).catch(error => {
        this.captureStopFailure(error);
        if (generation === this.setupGeneration && !this.stopping) {
          let entry; try { entry = this.diagnosticLog?.captureSetup({ kind: component, error, since: setupStartedAt }); } catch {}
          this.setupErrors.set(component, { error: entry?.cause?.message || '准备未完成，请到日志页查看原因后重试。', errorCode: entry?.cause?.code || 'UNKNOWN', errorDetails: entry?.details ?? [], errorType: entry?.errorType ?? 'Error' });
        }
      }).finally(() => this.setupTasks.delete(kind));
      this.setupTasks.set(kind,promise);
    }
    return { ok: true, preparing: true, kind };
  }
  async cancelSetup({ pause = true } = {}) {
    const hadSetup = this.setupTasks.size || this.referenceTask;
    if (pause && this.setupTasks.has('speech')) writeJson(join(this.root, 'voice-setup.json'), { paused: true });
    this.setupGeneration++;
    this.referenceGeneration++;
    const task = this.referenceTask;
    if (task) { task.cancelled = true; task.process?.cancel(); }
    try { this.captureStopFailure(await this.engine?.cancelPrepare?.()); } catch (error) { if (!this.captureStopFailure(error)) throw error; }
    await Promise.allSettled([...this.setupTasks.values(), ...(task?.promise ? [task.promise] : [])]);
    this.assertOperational();
    this.setupErrors.clear();
    if (hadSetup) this.recordDiagnostic({ level: 'info', area: 'setup', code: 'SETUP_CANCELLED' });
    return { ok: true };
  }
  async useDefaultVoice() {
    this.assertNotCleaning();
    if (typeof this.persistConfig !== 'function') throw new StudioError('当前宿主不支持保存音色。');
    if (this.cfg.referenceAudioPath && this.cfg.referenceText) {
      try {
        if (!this.references) throw new StudioError('参考音色列表尚未准备好。');
        this.references.addPrepared({ name: this.cfg.referenceName, audio: this.cfg.referenceAudioPath, text: this.cfg.referenceText });
      } catch (error) {
        // Keep the prior selection recoverable even when its audio is missing.
        writeFileSync(join(this.root, `reference-recovery-${randomUUID()}.json`), JSON.stringify({ referenceAudioPath: this.cfg.referenceAudioPath, referenceText: this.cfg.referenceText, referenceName: this.cfg.referenceName }), { mode: 0o600, flag: 'wx' });
        this.recordDiagnostic({ level: 'warning', area: 'reference', code: 'PANEL_OPERATION_FAILED', error });
      }
    }
    this.referenceGeneration++;
    if (this.referenceTask) { this.referenceTask.cancelled = true; this.referenceTask.process?.cancel(); }
    const patch = { referenceAudioPath: '', referenceText: '', referenceName: '', voice: 'vivian' };
    await this.persistVoice(patch,this.referenceGeneration); this.referenceError = '';
    this.recordDiagnostic({ level: 'info', area: 'reference', code: 'VOICE_DEFAULT' });
    return { ok: true, mode: 'default' };
  }
  async selectReference(id) {
    this.assertNotCleaning();
    if (!this.host || this.stopping || !this.references) throw new StudioError('参考音色列表尚未准备好，请刷新后重试。');
    if (typeof this.persistConfig !== 'function') throw new StudioError('当前宿主不支持保存音色。');
    if (this.referenceTask || this.setupTasks.size) throw new StudioError('请先等待音色处理完成，或取消后再切换。');
    const patch = this.references.selection(id);
    await this.persistVoice(patch, ++this.referenceGeneration); this.referenceError = '';
    this.recordDiagnostic({ level: 'info', area: 'reference', code: 'REFERENCE_SELECTED' });
    if (settings(this.cfg).backend === 'managed' && this.engineStatus().reference.state !== 'ready') this.initialize('speech');
    return { ok: true, id, mode: 'reference' };
  }
  async renameReference(id, name) {
    this.assertNotCleaning();
    if (!this.host || this.stopping || !this.references) throw new StudioError('参考音色列表尚未准备好。');
    if (this.referenceTask || this.setupTasks.size) throw new StudioError('请先等待音色处理完成。');
    const before = this.references.list(this.cfg.referenceAudioPath).find(entry => entry.id === id);
    const renamed = this.references.rename(id, name);
    if (before?.active) {
      try { await this.persistVoice({ referenceName: renamed.name }, ++this.referenceGeneration); }
      catch (error) { this.references.rename(id, before.name); throw error; }
    }
    this.recordDiagnostic({ level: 'info', area: 'reference', code: 'REFERENCE_RENAMED' });
    return { ok: true, id, name: renamed.name };
  }
  async deleteReference(id) {
    this.assertNotCleaning();
    if (!this.host || this.stopping || !this.references) throw new StudioError('参考音色列表尚未准备好。');
    if (this.referenceTask || this.setupTasks.size || this.active || this.queue.length) throw new StudioError('请等待当前处理或生成任务完成后再删除音色。');
    const entry = this.references.list(this.cfg.referenceAudioPath).find(item => item.id === id);
    if (!entry) throw new StudioError('找不到这个参考音色，请刷新列表后重试。');
    if (entry.active) await this.useDefaultVoice();
    const result = this.references.remove(id);
    this.recordDiagnostic({ level: 'info', area: 'reference', code: 'REFERENCE_DELETED' });
    return { ...result, mode: this.cfg.referenceAudioPath && this.cfg.referenceText ? 'reference' : 'default' };
  }
  defaultReferenceAudio() {
    const reference = defaultVoiceReference();
    return { $binary: { mime: 'audio/wav', base64: reference.bytes.toString('base64') } };
  }
  referenceAudio(id) {
    if (!this.references) throw new StudioError('参考音色列表尚未准备好，请刷新后重试。');
    return this.references.preview(id);
  }
  jobAudio(id) {
    const job = this.getJob(id);
    if (!['speech', 'song'].includes(job.kind) || job.status !== 'completed' || typeof job.audio !== 'string') throw new StudioError('作品尚未完成，暂时不能试听。');
    const bytes = readContained(join(this.root, id, 'output'), job.audio), mime = sniffAudio(bytes);
    if (!mime) throw new StudioError('作品音频无法读取，请到日志页检查。');
    return { $binary: { mime, base64: bytes.toString('base64') } };
  }
  async savePreferences(value) {
    this.assertNotCleaning();
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => k !== 'volume') || !Number.isInteger(value.volume) || value.volume < 0 || value.volume > 100) throw new StudioError('试听音量需要为 0 到 100 的整数。');
    if (typeof this.persistConfig !== 'function') throw new StudioError('当前宿主不支持保存配置。');
    await this.persistConfig({ volume: value.volume }); this.cfg.volume = value.volume;
    return { ok: true, volume: value.volume };
  }
  diagnostics(options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(k => !['level', 'limit'].includes(k))) throw new StudioError('日志筛选条件无效。');
    if (!this.diagnosticLog) throw new StudioError('请先启用语音助手，再查看诊断信息。');
    if (options.level !== undefined && !['all', 'info', 'warning', 'warn', 'error'].includes(options.level)) throw new StudioError('日志级别无效。');
    if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 200)) throw new StudioError('日志条数需要在 1 到 200 之间。');
    const report = this.diagnosticLog.report(this.state());
    return { ...report, entries: this.diagnosticLog.list({ level: options.level === 'all' ? undefined : options.level === 'warn' ? 'warning' : options.level, limit: options.limit ?? 100 }) };
  }
  persistVoice(patch, generation, { allowStopped = false } = {}) {
    this.assertNotCleaning(); this.voiceWritesPending++;
    const commit = this.voiceWrites.catch(() => {}).then(async () => {
      if (generation !== this.referenceGeneration || this.stopping && !allowStopped) return false;
      await this.persistConfig(patch);
      if (generation === this.referenceGeneration) Object.assign(this.cfg,patch);
      return true;
    });
    this.voiceWrites = commit.finally(() => { this.voiceWritesPending--; });
    return this.voiceWrites;
  }
  uploadReference(value) {
    this.assertNotCleaning();
    if (!this.host || this.stopping || settings(this.cfg).backend !== 'managed' || !this.engine) throw new StudioError('语音助手尚未启动。');
    if (typeof this.persistConfig !== 'function') throw new StudioError('当前宿主不支持保存音色。');
    if (!this.references) throw new StudioError('参考音色列表尚未准备好，请到日志页查看诊断信息后重试。');
    if (this.referenceTask || this.setupTasks.size) throw new StudioError('另一个声音组件仍在准备中，请等待完成或取消。');
    if ((this.references?.list().length ?? 0) >= 20) throw new StudioError('最多保存 20 个参考音色，请先删除不需要的音色再添加。');
    const referenceStatus = this.engineStatus();
    for (const kind of ['reference', 'transcription']) if (referenceStatus[kind].supported === false) throw new StudioError(referenceStatus[kind].unsupportedReason);
    const upload = decodeReferenceUpload(value);
    const parent = join(this.root,'references'); mkdirSync(parent,{recursive:true,mode:0o700});
    if (lstatSync(parent).isSymbolicLink()) throw new StudioError('参考音频保存目录无效。');
    const dir = join(parent,randomUUID()), outputDir = join(dir,'output'); mkdirSync(dir,{mode:0o700});
    const input = join(dir,'input'+upload.extension); writeFileSync(input,upload.bytes,{flag:'wx',mode:0o600});
    const task = { startedAt: Date.now(), generation: ++this.referenceGeneration, cancelled: false, executing: false, process: null, promise: null };
    this.referenceTask = task; this.referenceError = '';
    task.promise = (async () => {
      await this.engine.prepare('reference');
      this.assertOperational();
      while (this.active || this.queue.length) { if (task.cancelled || this.stopping) return; await new Promise(resolve => setTimeout(resolve,50)); }
      if (task.cancelled || this.stopping) return;
      task.executing = true;
      const paths = this.engine.paths();
      task.process = this.runProcess({ pythonPath: paths.asrPython ?? paths.speechPython, runnerPath: this.referenceRunner, args: ['--input',input,'--output',outputDir,'--asr-model',paths.asrModel,'--ffmpeg',paths.ffmpegPath,...this.torchDeviceArgs()], outputDir, logPath: join(dir,'runner.log'), timeoutMs: settings(this.cfg).timeoutMs });
      this.processResult(task.lastResult = await task.process.promise,'参考音频');
      const prepared = referenceOutput(outputDir);
      if (task.cancelled || this.stopping || task.generation !== this.referenceGeneration) return;
      if (!this.references) throw new StudioError('参考音色列表暂时无法保存，请到日志页检查。');
      const saved = this.references.addPrepared({ name: upload.name, ...prepared, inputPath: input });
      const patch = this.references.selection(saved.id);
      await this.persistVoice(patch,task.generation);
      this.recordDiagnostic({ level: 'info', area: 'reference', code: 'REFERENCE_SAVED' });
    })().catch(error => {
      if (this.captureStopFailure(error)) { this.referenceError = this.stopFailure.message; return; }
      if (this.stopFailure) { this.referenceError = this.stopFailure.message; return; }
      if (!task.cancelled && !this.stopping) {
        let entry; try { entry = task.executing ? this.diagnosticLog?.captureReference({ referenceId: basename(dir), result: task.lastResult, error }) : this.diagnosticLog?.captureSetup({ kind: 'reference', error, since: task.startedAt }); } catch {}
        this.referenceError = '参考音频处理失败：' + (entry?.cause?.message || '请使用 3 到 30 秒清晰单人录音重试。') + ' 可在日志页复制诊断信息。';
      }
    }).finally(() => { if (this.referenceTask === task) this.referenceTask = null; this.drain(); });
    return { ok: true, preparing: true, name: upload.name };
  }
  getJob(id) { if (typeof id !== 'string' || !JOB_ID.test(id) || !this.jobs.has(id)) throw new StudioError('找不到这个工作室任务。'); return this.jobs.get(id); }
  play(id) {
    this.assertNotCleaning();
    if (!this.host || this.stopping || this.hold) throw new StudioError('工作室尚未运行。');
    const job = this.getJob(id); if (job.status !== 'completed' || typeof job.audio !== 'string') throw new StudioError('作品尚未完成。');
    const bytes = readContained(join(this.root, id, 'output'), job.audio); if (!sniffAudio(bytes)) throw new StudioError('作品音频无效。');
    const result = this.player.enqueue(id, job.audio, settings(this.cfg).volume); return { ok: true, jobId: id, ...result };
  }
  playState(id, state, result) {
    this.captureStopFailure(result);
    const job = this.jobs.get(id); if (!job) return; job.playback = state; try { this.persist(job); } catch {}
    if (state === 'failed') this.recordDiagnostic({ level: 'error', area: job.kind, code: 'PLAYBACK_FAILED', jobId: id });
    if (state === 'failed' && job.deliverRequested && this.host && !this.stopping) void this.host.pushEvent({ type: 'voice-studio.playback-failed', source: ID, senderKey: id, ts: stamp(), text: `作品 ${id} 已保存，但本机播放失败。请检查系统音频输出；不要自动重复播放。`, meta: { jobId: id } }, { deliver: true, trigger: 'debounce' }).catch(() => {});
  }
  view(job) {
    const result = { ...job, directory: join(this.root, job.id), ...(job.kind === 'song' ? { logPath: join(this.root, job.id, 'runner.log') } : {}) };
    if (job.status === 'running') { result.stage = job.kind === 'speech' ? '正在合成语音' : '正在启动'; try { const dir = join(this.root, job.id, 'output'); result.stage = String(readJson(dir, join(dir, 'status.json')).stage ?? '正在生成').slice(0, 100); } catch {} }
    return result;
  }
  state(id) {
    if (id !== undefined && id !== null && id !== '') return this.view(this.getJob(id));
    const cfg = settings(this.cfg); let keyConfigured = false; if (cfg.backend === 'legacy') try { keyConfigured = !!this.key(); } catch {}
    if (this.host && Date.now() - this.qqLastCheck > 30000) void this.refreshQQ();
    const engine = this.engineStatus();
    return { version: VERSION, singingEnabled: cfg.singingEnabled, qq: { ...this.qq }, running: !!this.host && !this.stopping && !this.stopFailure, device: { ...this.device, ...this.engine?.device?.() }, stopFailure: this.stopFailure ? { ...this.stopFailure } : null,
      activeJobId: this.active?.id ?? null, queued: this.queue.length, maxQueue: cfg.maxQueue, player: this.player.state(), storageBusy: this.storageBusy(),
      engine, models: modelCatalog(engine, this.device), storage: storageSummary(this.device), preferences: { volume: cfg.volume },
      voice: { mode: cfg.referenceAudioPath && cfg.referenceText ? 'reference' : 'default',
        referenceName: cfg.referenceName || (cfg.referenceAudioPath ? '已保存的参考音频' : ''),
        references: this.references?.list(cfg.referenceAudioPath) ?? [], referenceLimit: 20,
        preparing: !!this.referenceTask && !this.referenceTask.cancelled || !!cfg.referenceAudioPath && this.setupTasks.has('speech'), error: this.referenceError },
      singingReference: this.singingReferenceStatus(), singingReferencePreparing: !!this.singingReferenceTask, singingReferenceError: this.singingReferenceError,
      setup: { downloadPolicy: 'automatic', ...(cfg.backend === 'legacy' ? { baseUrl: cfg.baseUrl, ttsModel: cfg.ttsModel, lyricModel: cfg.lyricModel, voice: cfg.voice, keyConfigured } : {}), singingVoice: cfg.singingVoice, singingStyle: cfg.singingStyle, singingDescription: cfg.singingDescription, singingUseReference: cfg.singingUseReference, referenceConfigured: !!cfg.referenceAudioPath && !!cfg.referenceText },
      jobs: [...this.jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 30).map((job) => this.view(job)) };

  }
  async check() {
    const cfg = settings(this.cfg); const checks = [];
    const add = (id, label, ok, detail) => checks.push({ id, label, ok: !!ok, detail });
    const device = { ...this.device, ...this.engine?.device?.() };
    add('platform', device.label, device.supported, device.supported ? `${device.platform}/${device.arch} · ${device.accelerationLabel}` : device.unsupportedReason);
    if (this.stopFailure) add('processStop', '后台程序停止状态', false, this.stopFailure.message);
    if (cfg.backend === 'managed') {
      const engine = this.engineStatus();
      const hasReference = !!cfg.referenceAudioPath && !!cfg.referenceText;
      const speechComponent = engine[hasReference ? 'reference' : 'speech'];
      const speechReady = speechComponent.supported !== false && speechComponent.state === 'ready';
      add('speechEngine', '语音引擎', speechReady, speechReady ? '已就绪' : speechComponent.unsupportedReason || '点击初始化语音即可自动准备');
      add('transcriptionEngine', 'QQ 语音识别', engine.transcription.supported !== false && engine.transcription.state === 'ready', engine.transcription.unsupportedReason || (engine.transcription.state === 'ready' ? '已就绪' : '基础语音模型准备完成后即可识别'));
      add('reference', '说话音色', !!cfg.referenceAudioPath === !!cfg.referenceText && (!hasReference || engine.reference.state === 'ready' && isFile(cfg.referenceAudioPath)), hasReference ? '已保存参考声音' : '默认音色');
      if (cfg.singingEnabled) {
        add('singingEngine', '唱歌引擎', engine.singing.supported !== false && engine.singing.state === 'ready', engine.singing.unsupportedReason || (engine.singing.state === 'ready' ? '已就绪' : '开启后准备唱歌组件'));
        try { singingPreferences({}, cfg); add('singingPreferences', '演唱声音与风格', true, '默认选择有效'); } catch (error) { add('singingPreferences', '演唱声音与风格', false, publicError(error)); }
        add('runner', '唱歌组件', isFile(this.runnerPath()), '随插件提供');
      }
      add('speechRunner', '语音组件', isFile(this.speechRunner), '随插件提供');
      add('transcriptionRunner', '语音识别组件', isFile(this.transcriptionRunner), '随插件提供');
      return { ok: checks.every(check => check.ok), checks, singingEnabled: cfg.singingEnabled, qq: await this.refreshQQ(), note: '基础语音模型会自动准备，完成后即可识别和回复 QQ 语音。' };
    }
    let ids = [];
    try { ids = await this.listModels(cfg, this.key()); add('endpoint', '本机模型服务', true, `可读取 ${ids.length} 个模型`); } catch (error) { add('endpoint', '本机模型服务', false, publicError(error)); }
    add('ttsModel', '说话模型', !!cfg.ttsModel && ids.includes(cfg.ttsModel), cfg.ttsModel ? ids.includes(cfg.ttsModel) ? '已找到' : '模型列表中未找到，请核对名称' : '尚未选择');
    if (cfg.singingEnabled) add('lyricModel', '写词模型', !!cfg.lyricModel && ids.includes(cfg.lyricModel), cfg.lyricModel ? ids.includes(cfg.lyricModel) ? '已找到' : '模型列表中未找到，请核对名称' : '尚未选择');
    if (cfg.singingEnabled) { try { singingPreferences({}, cfg); add('singingPreferences', '演唱声音与风格', true, '默认选择有效；单次生成可以覆盖'); } catch (error) { add('singingPreferences', '演唱声音与风格', false, publicError(error)); } }
    const hasReference = !!cfg.referenceAudioPath && !!cfg.referenceText;
    const voiceMatches = !!cfg.referenceAudioPath === !!cfg.referenceText && (!cfg.referenceAudioPath || isFile(cfg.referenceAudioPath)) && (!/qwen3[-_]tts.*base/i.test(cfg.ttsModel) || hasReference) && (!/qwen3[-_]tts.*customvoice/i.test(cfg.ttsModel) || !hasReference) && (hasReference || !!cfg.voice);
    add('reference', '说话音色', voiceMatches, voiceMatches ? hasReference ? '使用参考 WAV 与对应逐字稿' : '使用预置音色' : '请匹配音色：Base 需要参考 WAV 和逐字稿；CustomVoice 需要预置音色');
    if (cfg.singingEnabled) for (const [id, label, ok] of [['aceRoot', 'ACE-Step 目录', isDir(join(cfg.aceRoot, 'acestep'))], ['pythonPath', 'ACE-Step Python', isFile(cfg.pythonPath, true)], ['ffmpegPath', 'FFmpeg', isFile(cfg.ffmpegPath, true)], ['checkpointRoot', '歌曲模型文件', inspectSongModels(cfg.checkpointRoot || join(cfg.aceRoot, 'checkpoints')).ok], ['runner', '唱歌组件', isFile(this.runnerPath())]]) add(id, label, ok, ok ? '已找到' : '尚未找到；请运行安装助手或填写路径');
    add('player', '本机播放器', this.device.platform === 'win32' || existsSync('/usr/bin/afplay'), this.device.platform === 'win32' ? 'Windows 系统播放器，需实际试听确认' : 'macOS afplay');
    return { ok: checks.every((check) => check.ok), checks, singingEnabled: cfg.singingEnabled, qq: await this.refreshQQ(), note: cfg.singingEnabled ? '唱歌已开启；目录与服务可用不代表模型已加载，请分别试生成。' : '唱歌默认关闭，本次只检查语音环境；不需要下载唱歌模型。' };
  }
  async refreshQQ() {
    if (this.qqRequest) return this.qqRequest;
    this.qqLastCheck = Date.now();
    this.qqRequest = Promise.resolve().then(() => this.detectQQ(settings(this.cfg).companionUrl)).then((value) => { this.qq = value; return { ...value }; }, () => { this.qq = qqUnknown('暂时无法检测 QQ 插件。'); return { ...this.qq }; }).finally(() => { this.qqRequest = null; });
    return this.qqRequest;
  }
  async setSingingEnabled(value) {
    this.assertNotCleaning();
    if (typeof value !== 'boolean') throw new StudioError('唱歌开关必须是开启或关闭。');
    if (value && this.engineStatus().singing.supported === false) throw new StudioError(this.engineStatus().singing.unsupportedReason);
    if (typeof this.persistConfig !== 'function') throw new StudioError('当前宿主不支持保存开关，请在插件配置中设置唱歌功能。');
    await this.persistConfig({ singingEnabled: value });
    this.cfg.singingEnabled = value;
    if (!value) {
      for (const id of [...this.queue]) {
        const job = this.jobs.get(id); if (job.kind !== 'song') continue;
        this.queue.splice(this.queue.indexOf(id), 1); job.status = 'cancelled'; job.error = '唱歌功能已关闭。'; job.finishedAt = stamp(); job.delivery = 'cancelled'; this.speechSelections.delete(id); this.singingSelections.delete(id); this.persist(job);
      }
      if (this.active && this.jobs.get(this.active.id)?.kind === 'song') { const active = this.active; active.cancelled = true; active.abort.abort(); active.process?.cancel(); await active.promise; }
    }
    this.assertOperational();
    return { ok: true, singingEnabled: value };
  }
  singingReferenceStatus() {
    try { return this.singingReference?.status() ?? null; }
    catch { this.singingReferenceError = '演唱参考无法读取，请重新上传。'; return null; }
  }
  async uploadSingingReference(value) {
    this.assertNotCleaning();
    const capability = this.engineStatus().singing;
    if (capability.supported === false) throw new StudioError(capability.unsupportedReason);
    if (!this.host || this.storageBusy()) throw new StudioError('请等待当前下载、生成或处理完成后再上传演唱参考。');
    const ffmpeg = settings(this.cfg).backend === 'managed' ? this.engine?.paths?.().ffmpegPath : settings(this.cfg).ffmpegPath;
    if (!isFile(ffmpeg, true)) throw new StudioError('音频处理组件尚未就绪，请先等待语音初始化完成。');
    if (!this.singingReference) throw new StudioError('演唱参考目录尚未准备好，请刷新后重试。');
    this.singingReferenceError = '';
    const task = this.singingReference.upload(value, ffmpeg); this.singingReferenceTask = task;
    try { const reference = await task; return { ok: true, reference }; }
    catch (error) { this.captureStopFailure(error); this.singingReferenceError = this.stopFailure?.message || publicError(error); throw error; }
    finally { if (this.singingReferenceTask === task) this.singingReferenceTask = null; }
  }
  deleteSingingReference() {
    this.assertNotCleaning();
    if (!this.host || this.storageBusy()) throw new StudioError('请等待当前下载、生成或处理完成后再删除演唱参考。');
    if (!this.singingReference) throw new StudioError('演唱参考目录尚未准备好，请刷新后重试。');
    const result = this.singingReference.remove(); this.singingReferenceError = ''; return result;
  }
  async saveSingingPreferences(options) {
    this.assertNotCleaning();
    const singing = singingPreferences(options, settings(this.cfg));
    if (typeof this.persistConfig !== 'function') throw new StudioError('当前宿主不支持保存演唱设置，请在插件配置中设置默认声音与风格。');
    await this.persistConfig(singing);
    Object.assign(this.cfg, singing);
    return { ok: true, ...singing };
  }
  async invoke(panel, method, args = []) {
    if (!PANELS.some(item => item.id === panel)) throw new StudioError('未知面板。'); const list = Array.isArray(args) ? args : [args];
    const configMutation = ['installerApply','useDefaultVoice','selectReference','renameReference','deleteReference','savePreferences','setSingingEnabled','saveSingingPreferences'].includes(method);
    if (configMutation) { this.assertNotCleaning(); this.configWrites++; }
    try {
      if (method === 'storageStatus') return await this.storageStatus();
      if (method === 'previewCleanup') return await this.previewCleanup(list[0]);
      if (method === 'cleanup') return await this.cleanup(list[0]);
      if (method === 'installerSnapshot') return installerSnapshot(this.cfg);
      if (method === 'installerApply') {
        if (typeof this.persistConfig !== 'function') throw new StudioError('当前宿主不支持保存安装配置。');
        if (this.active || this.queue.length || this.referenceTask || this.setupTasks.size) throw new StudioError('请等待当前任务结束后再更新安装配置。');
        const patch = await installerPatch(list[0],this.cfg);
        await this.persistVoice(patch,++this.referenceGeneration,{ allowStopped: true });
        return { ok: true };
      }
      if (method === 'initialize') return this.initialize('speech');
      if (method === 'initializeSinging') return this.initialize('singing');
      if (method === 'cancelSetup') return await this.cancelSetup();
      if (method === 'uploadSingingReference') return await this.uploadSingingReference(list[0]);
      if (method === 'deleteSingingReference') return this.deleteSingingReference();
      if (method === 'singingReferenceAudio') { if (!this.singingReference) throw new StudioError('尚未上传演唱参考。'); return this.singingReference.preview(); }
      if (method === 'uploadReference') return this.uploadReference(list[0]);
      if (method === 'useDefaultVoice') return await this.useDefaultVoice();
      if (method === 'selectReference') return await this.selectReference(list[0]);
      if (method === 'renameReference') return await this.renameReference(list[0], list[1]);
      if (method === 'deleteReference') return await this.deleteReference(list[0]);
      if (method === 'previewReference') return this.referenceAudio(list[0]);
      if (method === 'defaultReferenceAudio') return this.defaultReferenceAudio();
      if (method === 'referenceAudio') { const audio = this.referenceAudio(list[0]); return { $binary: { mime: audio.mime, base64: audio.data } }; }
      if (method === 'jobAudio') return this.jobAudio(list[0]);
      if (method === 'previewJob') { const audio = this.jobAudio(list[0]).$binary; return { mime: audio.mime, data: audio.base64 }; }
      if (method === 'savePreferences') return await this.savePreferences(list[0]);
      if (method === 'diagnostics') return this.diagnostics(list[0]);
      if (method === 'reportPlaybackFailure') { this.recordDiagnostic({ level: 'error', area: 'playback', code: 'BROWSER_AUDIO_FAILED' }); return { ok: true }; }
      if (method === 'refreshQQ') return await this.refreshQQ();
      if (method === 'setSingingEnabled') return await this.setSingingEnabled(list[0]);
      if (method === 'saveSingingPreferences') return await this.saveSingingPreferences(list[0]);
      if (method === 'state') return this.state(list[0]);
      if (method === 'check') return await this.check();
      if (method === 'models' && settings(this.cfg).backend === 'legacy') return { models: await this.listModels(settings(this.cfg), this.key()) };
      if (method === 'testSpeak') return { ok: true, job: this.enqueue('speech', list[0], { playback: false, deliver: false }) };
      if (method === 'testSing') {
        const options = list[1] === undefined ? {} : list[1];
        if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => !['voice','style','description','useReference','title','lines'].includes(key))) throw new StudioError('唱歌设置只能包含 voice、style、description、useReference、title 和 lines。');
        const singing = singingPreferences({ voice: options.voice, style: options.style, description: options.description, useReference: options.useReference }, settings(this.cfg));
        return { ok: true, job: this.enqueue('song', list[0], { voice: singing.singingVoice, style: singing.singingStyle, description: singing.singingDescription, useReference: singing.singingUseReference, title: options.title, lines: options.lines, playback: false, deliver: false }) };
      }
      if (method === 'play') return this.play(list[0]);
      if (method === 'stop') { await this.stopAll(); return { ok: true }; }
      if (method === 'saveKey' && settings(this.cfg).backend === 'legacy') { const key = typeof list[0] === 'string' ? list[0].trim() : ''; if (!key || key.length > 4096 || /\s/.test(key)) throw new StudioError('请输入不含空白的接口密钥。'); const name = settings(this.cfg).apiKeySecret; if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new StudioError('密钥变量名无效。'); this.storeSecret(name, key); return { ok: true }; }
      throw new StudioError('未知操作。');
    } catch (error) {
      if (['uploadSingingReference','deleteSingingReference','singingReferenceAudio','defaultReferenceAudio','referenceAudio','previewReference','jobAudio','previewJob','play','savePreferences','saveSingingPreferences','selectReference','renameReference','deleteReference','useDefaultVoice','uploadReference','setSingingEnabled'].includes(method)) this.recordDiagnostic({ level: 'error', area: method.includes('Reference') || method === 'referenceAudio' ? 'reference' : 'system', code: 'PANEL_OPERATION_FAILED', stage: method, error });
      throw new StudioError(publicError(error));
    } finally { if (configMutation) this.configWrites--; }
  }
  webUi() { return { label: LABEL, lamps: [{ label: '工作室', state: this.host && !this.stopFailure ? 'online' : 'offline', hint: this.stopFailure ? '后台程序停止异常' : this.active ? '正在生成' : '等待请求' }], badges: [{ label: '排队', value: String(this.queue.length), tone: this.queue.length ? 'on' : 'plain' }], panels: PANELS.map(panel => ({ ...panel, getMethods: ['state'] })), promptDocs: [{ key: `worlds.${ID}.env`, title: '提示词', path: ENV_PROMPT, role: 'envPrompt' }], invoke: (panel, method, args) => this.invoke(panel, method, args) }; }
  shutdownVerification() { const live = !!(this.stopFailure || this.active || this.player.current || this.referenceTask || this.singingReferenceTask || this.setupTasks.size || this.engine?.busy || this.engine?.child); return [{ key: 'voice-studio-worker', label: LABEL, status: live ? 'still-live' : 'verified-ended', detail: this.stopFailure?.message || (live ? '任务仍在停止中。' : '生成和播放已停止。') }]; }
}

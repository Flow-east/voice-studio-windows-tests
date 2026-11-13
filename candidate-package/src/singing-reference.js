import { accessSync, constants, existsSync, lstatSync, mkdirSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { StudioError } from './config.js';
import { decodeReferenceUpload } from './reference.js';
import { readContained } from './files.js';
import { diagnose } from './diagnostics.js';
import { spawnOwnedProcess, terminateWindowsProcess, terminationDetails } from './process.js';

const MAX_WAV_BYTES = 6 * 1024 * 1024;
const FILE = /^reference-[a-f0-9-]{36}\.wav$/;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const invalid = () => new StudioError('演唱参考音频无法安全读取，请删除后重新上传。');
const inside = (root, path) => { const p = relative(root, path); return !!p && p !== '..' && !p.startsWith('..' + sep) && !isAbsolute(p); };
const identity = stat => `${stat.dev}:${stat.ino}`;
const systemAliases = ['/var', '/tmp'].filter(path => { try { return realpathSync(path) === '/private' + path; } catch { return false; } });
const canonicalSystemPath = path => systemAliases.some(alias => path.startsWith(alias + '/')) ? '/private' + path : path;

function wavInfo(bytes) {
  if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE' || bytes.readUInt32LE(4) + 8 !== bytes.length) throw invalid();
  let fmt = false, data = null;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const name = bytes.toString('ascii', offset, offset + 4), length = bytes.readUInt32LE(offset + 4), start = offset + 8;
    if (start + length > bytes.length) throw invalid();
    if (name === 'fmt ') {
      if (fmt || length < 16 || bytes.readUInt16LE(start) !== 1 || bytes.readUInt16LE(start + 2) !== 2 || bytes.readUInt32LE(start + 4) !== 48000 || bytes.readUInt32LE(start + 8) !== 192000 || bytes.readUInt16LE(start + 12) !== 4 || bytes.readUInt16LE(start + 14) !== 16) throw invalid();
      fmt = true;
    }
    if (name === 'data') { if (data) throw invalid(); data = bytes.subarray(start, start + length); }
    offset = start + length + (length % 2);
  }
  if (!fmt || !data || data.length % 4) throw invalid();
  const durationSeconds = data.length / 192000;
  if (durationSeconds < 3 || durationSeconds > 30) throw new StudioError('演唱参考请使用 3 到 30 秒的音乐或清晰演唱片段。');
  let audible = false;
  for (let offset = 0; offset < data.length; offset += 2) if (Math.abs(data.readInt16LE(offset)) > 16) { audible = true; break; }
  if (!audible) throw new StudioError('演唱参考中没有可用声音，请换一段音乐或演唱片段。');
  return { durationSeconds, bytes: bytes.length };
}

export function convertSingingReference(ffmpegPath, input, output, { platform = process.platform, spawnProcess = spawn, windowsJob, environment = process.env, timeoutMs = 30000 } = {}) {
  if (typeof ffmpegPath !== 'string' || !isAbsolute(ffmpegPath)) throw new StudioError('音频处理组件尚未就绪，请先完成语音初始化。');
  try { ffmpegPath = realpathSync(ffmpegPath); if (!lstatSync(ffmpegPath).isFile()) throw invalid(); accessSync(ffmpegPath, constants.X_OK); }
  catch { throw new StudioError('音频处理组件尚未就绪，请先完成语音初始化。'); }
  return new Promise((resolvePromise, reject) => {
    let finished = false, stopping = false, closed = false, stoppedTree = false, killTimer, timer, child;
    const finish = error => { if (finished) return; finished = true; clearTimeout(timer); clearTimeout(killTimer); error ? reject(error) : resolvePromise(); };
    const timeout = () => new StudioError('演唱参考处理超时，请换一段较短的音频后重试。');
    const failedStop = result => Object.assign(new StudioError('演唱参考处理程序尚未确认停止，请彻底退出 Coopanion 并确认后台进程结束后再试。'), { terminationFailed: true, code: 'PROCESS_TERMINATION_FAILED', ...terminationDetails({ terminationMethod: platform === 'win32' ? 'taskkill' : 'process', terminationStage: 'execute', ...result }) });
    const processError = error => {
      if (error?.terminationFailed === true || error?.code === 'PROCESS_TERMINATION_FAILED') return failedStop(error);
      const diagnostic = diagnose(error?.code === 'PROCESS_START_FAILED' ? { code: 'PROCESS_START_FAILED' } : '', { spawnError: true, errorCode: error?.code, errorName: error?.name, errno: error?.errno, ...terminationDetails(error) });
      return Object.assign(new StudioError(diagnostic.message), { code: diagnostic.code, diagnostic });
    };
    try { child = spawnOwnedProcess(ffmpegPath, ['-hide_banner', '-nostdin', '-loglevel', 'error', '-protocol_whitelist', 'file,pipe', '-format_whitelist', 'wav,mp3,mov,flac,ogg', '-i', input, '-map', '0:a:0', '-vn', '-sn', '-dn', '-t', '31', '-ar', '48000', '-ac', '2', '-c:a', 'pcm_s16le', '-map_metadata', '-1', '-fflags', '+bitexact', '-flags:a', '+bitexact', '-f', 'wav', '-n', output], { stdio: ['ignore', 'ignore', 'ignore'], shell: false, windowsHide: true }, { platform, spawnProcess, windowsJob }); }
    catch (error) { finish(processError(error)); return; }
    timer = setTimeout(() => {
      stopping = true;
      if (platform === 'win32') void terminateWindowsProcess(child, { spawnProcess, environment }).then(result => {
        if (finished) return;
        if (!result.ok) return finish(failedStop(result));
        stoppedTree = true;
        if (closed) finish(timeout());
        else killTimer = setTimeout(() => finish(failedStop({ ...terminationDetails(result), terminationStage: 'confirm-exit', terminationErrorCode: 'PROCESS_EXIT_NOT_CONFIRMED' })), 2000);
      });
      else {
        try { if (!child.kill('SIGKILL')) return finish(failedStop({ terminationSignal: 'SIGKILL', terminationErrorCode: 'REFERENCE_KILL_FAILED' })); }
        catch (error) { return finish(failedStop({ terminationSignal: 'SIGKILL', terminationErrorCode: terminationDetails({ errorCode: error.code }).terminationErrorCode || 'REFERENCE_KILL_FAILED' })); }
        killTimer = setTimeout(() => finish(failedStop({ terminationSignal: 'SIGKILL', terminationStage: 'confirm-exit', terminationErrorCode: 'REFERENCE_KILL_TIMEOUT' })), 1000);
      }
    }, timeoutMs);
    child.once('error', error => finish(processError(error)));
    child.once('close', code => { if (finished) return; closed = true; if (stopping) { if (platform !== 'win32' || stoppedTree) finish(timeout()); return; } finish(code === 0 ? null : new StudioError('这段演唱参考无法解码，请换一个有效音频文件。')); });
  });
}

/** One private music reference; no user-supplied path enters its public API. */
export class SingingReference {
  constructor({ root, converter = convertSingingReference } = {}) {
    if (typeof root !== 'string' || !isAbsolute(root)) throw invalid();
    const stat = lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw invalid();
    this.studioRoot = realpathSync(root);
    this.studioIdentity = identity(stat);
    this.root = join(this.studioRoot, 'singing-reference');
    if (!existsSync(this.root)) mkdirSync(this.root, { mode: 0o700 });
    const dir = lstatSync(this.root);
    if (!dir.isDirectory() || dir.isSymbolicLink()) throw invalid();
    this.rootIdentity = identity(dir);
    this.index = join(this.root, 'current.json');
    this.pending = false;
    this.convertAudio = converter;
  }
  check() {
    for (const [path, expected] of [[this.studioRoot, this.studioIdentity], [this.root, this.rootIdentity]]) {
      const stat = lstatSync(path);
      if (!stat.isDirectory() || stat.isSymbolicLink() || identity(stat) !== expected) throw invalid();
    }
  }
  current() {
    this.check();
    try { const stat = lstatSync(this.index); if (!stat.isFile() || stat.isSymbolicLink()) throw invalid(); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    let value;
    try { value = JSON.parse(readContained(this.root, this.index, 4096)); } catch { throw invalid(); }
    if (!value || value.schema !== 1 || !FILE.test(value.file) || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 180 || /[\\/\u0000-\u001f\u007f]/u.test(value.name) || !/^[a-f0-9]{64}$/.test(value.sha256)) throw invalid();
    const bytes = readContained(this.root, join(this.root, value.file), MAX_WAV_BYTES), info = wavInfo(bytes);
    if (hash(bytes) !== value.sha256 || info.durationSeconds !== value.durationSeconds || info.bytes !== value.bytes) throw invalid();
    return { ...value, data: bytes };
  }
  status() {
    const value = this.current();
    return value ? { name: value.name, durationSeconds: value.durationSeconds, bytes: value.bytes } : null;
  }
  async upload(value, ffmpegPath) {
    if (this.pending) throw new StudioError('演唱参考正在处理，请稍后再试。');
    const upload = decodeReferenceUpload(value);
    this.check();
    // A fresh upload can repair a missing/corrupt recording. Never follow its
    // pointer, and leave the old selection untouched until conversion succeeds.
    let previousFile = null;
    try { previousFile = this.current()?.file ?? null; }
    catch {
      try { const old = JSON.parse(readContained(this.root, this.index, 4096)); if (FILE.test(old?.file)) previousFile = old.file; } catch {}
    }
    const id = randomUUID(), stage = join(this.root, 'upload-' + id), file = `reference-${id}.wav`, destination = join(this.root, file), temp = join(this.root, `current-${id}.tmp`);
    this.pending = true;
    let committed = false, unsafeToClean = false;
    try {
      mkdirSync(stage, { mode: 0o700 });
      const input = join(stage, 'input' + upload.extension), output = join(stage, 'reference.wav');
      writeFileSync(input, upload.bytes, { mode: 0o600, flag: 'wx' });
      await this.convertAudio(ffmpegPath, input, output);
      this.check();
      const bytes = readContained(stage, output, MAX_WAV_BYTES), info = wavInfo(bytes);
      writeFileSync(destination, bytes, { mode: 0o600, flag: 'wx' });
      const entry = { schema: 1, file, name: upload.name, ...info, sha256: hash(bytes) };
      writeFileSync(temp, JSON.stringify(entry) + '\n', { mode: 0o600, flag: 'wx' });
      // The pointer itself is replaced, never dereferenced, at the atomic commit.
      this.check();
      renameSync(temp, this.index); committed = true;
      if (previousFile) { try { unlinkSync(join(this.root, previousFile)); } catch { /* a leftover is private and never selected */ } }
      return { name: entry.name, ...info };
    } catch (error) { unsafeToClean = error.terminationFailed === true; throw error; }
    finally {
      this.pending = false;
      try {
        if (!unsafeToClean) {
          this.check();
          rmSync(stage, { recursive: true, force: true });
          rmSync(temp, { force: true });
          if (!committed) rmSync(destination, { force: true });
        }
      } catch { /* Do not touch a replaced root. */ }
    }
  }
  preview() {
    const current = this.current();
    if (!current) throw new StudioError('请先上传一段演唱参考音频。');
    return { $binary: { mime: 'audio/wav', base64: current.data.toString('base64') } };
  }
  remove() {
    if (this.pending) throw new StudioError('演唱参考正在处理，请稍后再试。');
    this.check();
    // A damaged reference can still be removed without following its contents.
    let value = null;
    try { value = this.current(); } catch {}
    try { unlinkSync(this.index); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (value) unlinkSync(join(this.root, value.file));
    return { ok: true };
  }
  snapshotTo(jobDir) {
    const current = this.current();
    if (!current) return '';
    if (typeof jobDir !== 'string' || !isAbsolute(jobDir)) throw invalid();
    const target = resolve(canonicalSystemPath(jobDir));
    if (!inside(this.studioRoot, target)) throw invalid();
    let parent = this.studioRoot;
    for (const part of relative(this.studioRoot, target).split(sep)) {
      parent = join(parent, part); const stat = lstatSync(parent);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw invalid();
    }
    const path = join(target, 'singing-reference.wav');
    writeFileSync(path, current.data, { mode: 0o600, flag: 'wx' });
    return path;
  }
}

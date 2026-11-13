import { constants, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { extname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { StudioError } from './config.js';
import { MAX_REFERENCE_UPLOAD, referenceOutput } from './reference.js';
import { sniffAudio } from './files.js';

const ID = /^ref-[a-f0-9]{32}$/;
export const MAX_SAVED_REFERENCES = 20;
const EXT = new Set(['.wav', '.mp3', '.m4a', '.flac', '.ogg']);
const systemAliases = ['/var', '/tmp'].filter(path => { try { return realpathSync(path) === '/private' + path; } catch { return false; } });
const canonicalSystemPath = value => systemAliases.some(path => value.startsWith(path + '/')) ? '/private' + value : value;
const invalid = () => new StudioError('参考录音无法读取，请重新上传；已保存的其他音色不受影响。');
const inside = (root, path) => { const p = relative(root, path); return p && p !== '..' && !p.startsWith('..' + sep) && !isAbsolute(p); };
function cleanName(value, fallback = '已保存的参考音频') {
  return typeof value === 'string' && value.trim() && value.length <= 180 && !/[\\/\u0000-\u001f\u007f]/u.test(value) ? value.trim() : fallback;
}
function referenceName(value) {
  if (typeof value !== 'string' || !value.trim() || [...value.trim()].length > 30 || /[\\/\u0000-\u001f\u007f]/u.test(value) || ['.', '..'].includes(value.trim())) throw new StudioError('音色名称请填写 1–30 个字符，不要包含路径或换行。');
  return value.trim();
}
const defaultName = slot => '参考音色' + String(slot).padStart(2, '0');
function validText(value) {
  return typeof value === 'string' && value.trim() && value.length <= 2000 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);
}
const nativePath = { isAbsolute, join, parse, resolve, sep };
export function safePath(path, { pathApi = nativePath, lstat = lstatSync } = {}) {
  const { isAbsolute, join, parse, resolve, sep } = pathApi;
  if (typeof path !== 'string' || !isAbsolute(path) || path.length > 4096 || /[\u0000-\u001f\u007f]/u.test(path)) throw invalid();
  const full = resolve(canonicalSystemPath(path));
  // Keep drive and UNC roots intact when checking every ancestor.
  const root = parse(full).root;
  let current = root;
  if (lstat(current).isSymbolicLink()) throw invalid();
  for (const component of full.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, component);
    if (lstat(current).isSymbolicLink()) throw invalid();
  }
  return full;
}
function readSafe(path, { head = false, limit = MAX_REFERENCE_UPLOAD } = {}) {
  let fd;
  try {
    const full = safePath(path);
    fd = openSync(full, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW || 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size < 12 || stat.size > limit) throw invalid();
    if (head) { const bytes = Buffer.alloc(Math.min(stat.size, 64)); readSync(fd, bytes, 0, bytes.length, 0); return bytes; }
    const bytes = readFileSync(fd);
    if (bytes.length !== stat.size || bytes.length > limit) throw invalid();
    return bytes;
  } catch { throw invalid(); } finally { if (fd !== undefined) closeSync(fd); }
}
function audioMime(bytes, extension) {
  const common = sniffAudio(bytes);
  if (extension === '.wav' && common === 'audio/wav') return common;
  if (extension === '.mp3' && common === 'audio/mpeg') return common;
  if (extension === '.m4a' && bytes.toString('ascii', 4, 8) === 'ftyp') return 'audio/mp4';
  if (extension === '.flac' && bytes.toString('ascii', 0, 4) === 'fLaC') return 'audio/flac';
  if (extension === '.ogg' && bytes.toString('ascii', 0, 4) === 'OggS') return 'audio/ogg';
  throw invalid();
}

/** Private local reference archive. Public methods accept opaque ids, never paths from the panel. */
export class ReferenceLibrary {
  constructor({ root } = {}) {
    if (typeof root !== 'string' || !isAbsolute(root)) throw invalid();
    this.studioRoot = safePath(root);
    this.root = join(this.studioRoot, 'reference-library');
    if (!existsSync(this.root)) mkdirSync(this.root, { mode: 0o700 });
    safePath(this.root);
    if (!lstatSync(this.root).isDirectory()) throw invalid();
    this.indexPath = join(this.root, 'index.json');
    this.entries = []; this.deleted = [];
    if (existsSync(this.indexPath)) {
      let index;
      try { index = JSON.parse(readSafe(this.indexPath, { limit: 8 * 1024 * 1024 }).toString('utf8')); }
      catch { throw new StudioError('参考音频列表暂时无法读取，原录音仍保存在本机。请复制诊断信息后联系作者。'); }
      if (![1, 2].includes(index.schema) || !Array.isArray(index.entries) || index.entries.length > 128 || !index.entries.every(entry => this.validEntry(entry, index.schema)) || new Set(index.entries.map(e => e.id)).size !== index.entries.length) throw new StudioError('参考音频列表格式异常，原录音仍保存在本机。');
      this.entries = index.entries;
      if (index.schema === 1) {
        // Older entries could be named after private upload filenames. Number once,
        // before exposing them to the new panel; later user renames remain intact.
        [...this.entries].sort((a, b) => a.createdAt.localeCompare(b.createdAt)).forEach((entry, index) => Object.assign(entry, { slot: index + 1, name: defaultName(index + 1), renamed: false }));
        this.persist();
      } else {
        if (new Set(this.entries.map(e => e.slot)).size !== this.entries.length || !Array.isArray(index.deleted) || index.deleted.length > 65536 || !index.deleted.every(id => typeof id === 'string' && ID.test(id)) || index.deleted.some(id => this.entries.some(e => e.id === id))) throw new StudioError('参考音频列表格式异常，原录音仍保存在本机。');
        this.deleted = [...new Set(index.deleted)];
      }
    }
  }
  validEntry(e, schema = 2) {
    return !!e && ID.test(e.id) && e.name === cleanName(e.name, '') && (schema === 1 || Number.isInteger(e.slot) && e.slot >= 1 && e.slot <= 128 && typeof e.renamed === 'boolean' && [...e.name].length <= 30 && !['.', '..'].includes(e.name)) && validText(e.text) && typeof e.createdAt === 'string' && Number.isFinite(Date.parse(e.createdAt)) && (e.durationSeconds === null || Number.isFinite(e.durationSeconds) && e.durationSeconds >= 3 && e.durationSeconds <= 30) && (e.originalExtension === null || EXT.has(e.originalExtension)) && Array.isArray(e.sourcePaths) && e.sourcePaths.length <= 8 && e.sourcePaths.every(p => typeof p === 'string' && isAbsolute(p) && p.length <= 4096 && !/[\u0000-\u001f\u007f]/u.test(p));
  }
  persist() {
    safePath(this.root);
    if (existsSync(this.indexPath)) safePath(this.indexPath);
    const temp = join(this.root, 'index-' + randomUUID() + '.tmp');
    writeFileSync(temp, JSON.stringify({ schema: 2, entries: this.entries, deleted: this.deleted }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    renameSync(temp, this.indexPath);
  }
  entry(id) {
    if (typeof id !== 'string' || !ID.test(id)) throw new StudioError('请选择一个已保存的参考音色。');
    const entry = this.entries.find(e => e.id === id);
    if (!entry) throw new StudioError('找不到这段参考录音，请刷新列表后重试。');
    return entry;
  }
  audioPath(entry) { return join(this.root, entry.id, 'reference.wav'); }
  originalPath(entry) { return entry.originalExtension ? join(this.root, entry.id, 'original' + entry.originalExtension) : null; }
  available(entry, original = false) {
    try { const path = original ? this.originalPath(entry) : this.audioPath(entry); return !!path && !!audioMime(readSafe(path, { head: true }), original ? entry.originalExtension : '.wav'); } catch { return false; }
  }
  publicEntry(entry, activeAudioPath = '') {
    const active = typeof activeAudioPath === 'string' && activeAudioPath && [this.audioPath(entry), ...entry.sourcePaths].includes(resolve(canonicalSystemPath(activeAudioPath)));
    const available = this.available(entry);
    return { id: entry.id, name: entry.name, slot: entry.slot, createdAt: entry.createdAt, durationSeconds: entry.durationSeconds, available, active: !!active, previewAvailable: available, originalAvailable: this.available(entry, true) };
  }
  list(activeAudioPath = '') { return this.entries.map(e => this.publicEntry(e, activeAudioPath)).sort((a, b) => a.slot - b.slot); }
  addPrepared({ audio, text, durationSeconds = null, inputPath = null, recover = false } = {}) {
    if (!validText(text) || durationSeconds !== null && (!Number.isFinite(durationSeconds) || durationSeconds < 3 || durationSeconds > 30)) throw invalid();
    const bytes = readSafe(audio); audioMime(bytes, '.wav');
    const source = safePath(audio), id = 'ref-' + createHash('sha256').update(bytes).update('\0').update(text.trim()).digest('hex').slice(0, 32);
    // Source uploads remain on disk for recovery. Do not resurrect removed entries
    // during routine migration; a deliberate new upload may add the voice again.
    if (recover && this.deleted.includes(id)) return null;
    let originalBytes = null, originalExtension = null;
    if (inputPath) {
      originalExtension = extname(inputPath).toLowerCase();
      if (!EXT.has(originalExtension)) throw invalid();
      originalBytes = readSafe(inputPath); audioMime(originalBytes, originalExtension);
    }
    let entry = this.entries.find(e => e.id === id);
    if (!entry && this.entries.length >= MAX_SAVED_REFERENCES) throw new StudioError('最多保存 20 个参考音色，请先删除一个再上传；现有录音已保留。');
    const folder = join(this.root, id);
    if (!existsSync(folder)) mkdirSync(folder, { mode: 0o700 });
    safePath(folder);
    const writeIfMissing = (file, content) => {
      if (existsSync(file)) { if (!readSafe(file).equals(content)) throw invalid(); }
      else writeFileSync(file, content, { mode: 0o600, flag: 'wx' });
    };
    writeIfMissing(join(folder, 'reference.wav'), bytes);
    if (originalBytes && (!entry || !entry.originalExtension)) writeIfMissing(join(folder, 'original' + originalExtension), originalBytes);
    if (!entry) {
      const slot = Array.from({ length: MAX_SAVED_REFERENCES }, (_, index) => index + 1).find(number => !this.entries.some(e => e.slot === number));
      entry = { id, slot, name: defaultName(slot), renamed: false, text: text.trim(), durationSeconds, createdAt: new Date().toISOString(), originalExtension, sourcePaths: [source] };
      this.entries.push(entry);
      this.deleted = this.deleted.filter(value => value !== id);
    } else {
      if (!entry.sourcePaths.includes(source) && entry.sourcePaths.length < 8) entry.sourcePaths.push(source);
      if (!entry.originalExtension && originalBytes) entry.originalExtension = originalExtension;
      if (entry.durationSeconds === null && durationSeconds !== null) entry.durationSeconds = durationSeconds;
    }
    this.persist();
    return this.publicEntry(entry, source);
  }
  rename(id, name) {
    const entry = this.entry(id), old = { name: entry.name, renamed: entry.renamed };
    entry.name = referenceName(name); entry.renamed = true;
    try { this.persist(); } catch { Object.assign(entry, old); throw new StudioError('音色名称未保存，请稍后重试。'); }
    return this.publicEntry(entry);
  }
  remove(id) {
    const entry = this.entry(id), before = this.entries, oldDeleted = this.deleted;
    const trash = join(this.root, 'trash');
    safePath(this.root);
    if (!existsSync(trash)) mkdirSync(trash, { mode: 0o700 });
    safePath(trash);
    const archive = join(trash, id + '-' + Date.now() + '-' + randomUUID());
    mkdirSync(archive, { mode: 0o700 });
    writeFileSync(join(archive, 'entry.json'), JSON.stringify({ schema: 2, removedAt: new Date().toISOString(), entry }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    const folder = join(this.root, id), recording = join(archive, 'recording'); let moved = false;
    try {
      // Rename without dereferencing: even a broken entry is removable safely.
      try { lstatSync(folder); renameSync(folder, recording); moved = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      this.entries = this.entries.filter(e => e.id !== id);
      this.deleted = [...new Set([...this.deleted, id])];
      this.persist();
    } catch {
      this.entries = before; this.deleted = oldDeleted;
      if (moved) try { renameSync(recording, folder); } catch { /* Archive retains the bytes for manual recovery. */ }
      throw new StudioError('移除未完成，录音仍保留在本机，请稍后重试。');
    }
    return { ok: true, id, remaining: this.entries.length };
  }
  selection(id) {
    const entry = this.entry(id), path = this.audioPath(entry);
    audioMime(readSafe(path), '.wav');
    return { referenceAudioPath: path, referenceText: entry.text, referenceName: entry.name };
  }
  preview(id, { original = false } = {}) {
    const entry = this.entry(id), useOriginal = original && !!entry.originalExtension;
    const path = useOriginal ? this.originalPath(entry) : this.audioPath(entry), bytes = readSafe(path);
    return { id: entry.id, name: entry.name, mime: audioMime(bytes, useOriginal ? entry.originalExtension : '.wav'), data: bytes.toString('base64') };
  }
  migrate(cfg = {}) {
    const before = this.entries.length, report = { imported: 0, recovered: 0, skipped: 0, currentId: null };
    if (cfg.referenceAudioPath && cfg.referenceText) {
      try { report.currentId = this.addPrepared({ audio: cfg.referenceAudioPath, text: cfg.referenceText, recover: true })?.id ?? null; }
      catch { report.skipped++; }
    }
    const candidates = [];
    const parent = join(this.studioRoot, 'references');
    try {
      safePath(parent);
      for (const e of readdirSync(parent, { withFileTypes: true }).slice(0, 512)) if (e.isDirectory() && !e.isSymbolicLink()) candidates.push(join(parent, e.name));
    } catch { /* Previous versions need not have an upload folder. */ }
    for (const e of readdirSync(this.studioRoot, { withFileTypes: true })) if (e.isDirectory() && !e.isSymbolicLink() && /^reference-[A-Za-z0-9_-]+$/.test(e.name) && e.name !== 'reference-library') candidates.push(join(this.studioRoot, e.name));
    for (const folder of candidates) {
      try {
        if (!inside(this.studioRoot, folder)) throw invalid();
        safePath(folder);
        const output = join(folder, 'output'), prepared = referenceOutput(output);
        const input = readdirSync(folder, { withFileTypes: true }).find(e => e.isFile() && !e.isSymbolicLink() && /^input\.(wav|mp3|m4a|flac|ogg)$/i.test(e.name));
        const saved = this.addPrepared({ ...prepared, inputPath: input ? join(folder, input.name) : null, recover: true });
        if (saved) report.recovered++;
      } catch { report.skipped++; }
    }
    report.imported = this.entries.length - before;
    return report;
  }
}

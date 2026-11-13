import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { StudioError } from './config.js';
export const MAX_AUDIO_BYTES = 12 * 1024 * 1024;
const inside = (base, file) => { const rel = relative(base, file); return !!rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); };
export function readContained(root, file, max = MAX_AUDIO_BYTES) {
  const base = resolve(root), path = resolve(file);
  if (!inside(base, path) || !lstatSync(base).isDirectory() || lstatSync(base).isSymbolicLink()) throw new StudioError('作品路径无效。');
  let current = base;
  for (const part of relative(base, path).split(sep)) { current = resolve(current, part); if (lstatSync(current).isSymbolicLink()) throw new StudioError('作品不能是符号链接。'); }
  if (!inside(realpathSync(base), realpathSync(path))) throw new StudioError('作品路径超出任务目录。');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW || 0));
  try { const stat = fstatSync(fd); if (!stat.isFile() || stat.size < 1 || stat.size > max) throw new StudioError('作品文件大小或类型无效。'); const b = readFileSync(fd); if (b.length > max) throw new StudioError('作品文件过大。'); return b; } finally { closeSync(fd); }
}
export function readJson(root, path) { const d = JSON.parse(readContained(root, path, 65536).toString('utf8')); if (!d || typeof d !== 'object' || Array.isArray(d)) throw new Error('Invalid JSON object'); return d; }
export function writeJson(path, data) {
  const tmp = `${path}.${randomUUID()}.tmp`;
  try { writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600, flag: 'wx' }); renameSync(tmp, path); }
  finally { try { rmSync(tmp, { force: true }); } catch {} }
}
export function sniffAudio(bytes) { const b = Buffer.from(bytes); if (b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WAVE') return 'audio/wav'; if (b.length >= 3 && b.toString('ascii', 0, 3) === 'ID3' || b.length >= 2 && b[0] === 255 && (b[1] & 224) === 224) return 'audio/mpeg'; return null; }
export function songOutput(dir) {
  const status = readJson(dir, resolve(dir, 'status.json'));
  if (status.state !== 'completed' || typeof status.mp3 !== 'string' || !isAbsolute(status.mp3)) throw new StudioError('唱歌程序未交付完整作品。');
  const bytes = readContained(dir, status.mp3);
  if (sniffAudio(bytes) !== 'audio/mpeg') throw new StudioError('唱歌程序未返回有效 MP3。');
  return { bytes, mime: 'audio/mpeg', audio: resolve(status.mp3), title: typeof status.title === 'string' ? status.title.slice(0, 120) : '原创短歌', lyrics: typeof status.lyrics === 'string' ? status.lyrics.slice(0, 6000) : '', durationSeconds: Number.isFinite(status.duration_seconds) ? status.duration_seconds : 30 };
}
export function speechOutput(dir) {
  const status = readJson(dir, resolve(dir, 'status.json'));
  if (status.state !== 'completed' || typeof status.audio !== 'string' || !isAbsolute(status.audio)) throw new StudioError('语音引擎未交付完整作品。');
  const bytes = readContained(dir, status.audio);
  if (sniffAudio(bytes) !== 'audio/wav') throw new StudioError('语音引擎未返回有效 WAV。');
  return { bytes, mime: 'audio/wav', audio: resolve(status.audio), durationSeconds: Number.isFinite(status.duration_seconds) ? status.duration_seconds : null };
}

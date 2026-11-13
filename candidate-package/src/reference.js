import { extname, isAbsolute, resolve } from 'node:path';
import { StudioError } from './config.js';
import { readContained, readJson, sniffAudio } from './files.js';
export const MAX_REFERENCE_UPLOAD = 20 * 1024 * 1024;
const MIME = { '.wav': ['audio/wav','audio/x-wav','audio/wave'], '.mp3': ['audio/mpeg','audio/mp3'], '.m4a': ['audio/mp4','audio/x-m4a','audio/m4a'], '.flac': ['audio/flac','audio/x-flac'], '.ogg': ['audio/ogg','application/ogg'] };
export function decodeReferenceUpload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !['name','mime','data'].includes(k))) throw new StudioError('请选择一个参考音频文件。');
  const { name, mime = '', data } = value;
  if (typeof name !== 'string' || !name.trim() || name.length > 180 || /[\\/\u0000-\u001f\u007f]/u.test(name)) throw new StudioError('参考音频文件名无效。');
  const extension = extname(name).toLowerCase();
  if (!MIME[extension] || typeof mime !== 'string' || mime && mime !== 'application/octet-stream' && !MIME[extension].includes(mime.toLowerCase())) throw new StudioError('请选择 WAV、MP3、M4A、FLAC 或 OGG 音频。');
  if (typeof data !== 'string' || data.length < 16 || data.length > 4 * Math.ceil(MAX_REFERENCE_UPLOAD / 3) || data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new StudioError('参考音频编码无效或超过 20 MB。');
  const bytes = Buffer.from(data, 'base64');
  if (bytes.length > MAX_REFERENCE_UPLOAD || bytes.toString('base64') !== data) throw new StudioError('参考音频编码无效或超过 20 MB。');
  const signature = extension === '.wav' ? sniffAudio(bytes) === 'audio/wav'
    : extension === '.mp3' ? sniffAudio(bytes) === 'audio/mpeg'
    : extension === '.m4a' ? bytes.length >= 12 && bytes.toString('ascii',4,8) === 'ftyp'
    : extension === '.flac' ? bytes.subarray(0,4).equals(Buffer.from('fLaC'))
    : bytes.subarray(0,4).equals(Buffer.from('OggS'));
  if (!signature) throw new StudioError('文件内容与音频类型不匹配，请重新选择。');
  return { name: name.trim(), extension, bytes };
}
export function referenceOutput(dir) {
  const result = readJson(dir, resolve(dir,'reference.json'));
  if (typeof result.audio !== 'string' || !isAbsolute(result.audio) || typeof result.text !== 'string' || !result.text.trim() || result.text.length > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(result.text)) throw new StudioError('参考音频没有得到有效识别结果，请换一段清晰的人声。');
  const bytes = readContained(dir,result.audio,MAX_REFERENCE_UPLOAD);
  if (sniffAudio(bytes) !== 'audio/wav' || !Number.isFinite(result.durationSeconds) || result.durationSeconds < 3 || result.durationSeconds > 30) throw new StudioError('参考录音应为 3 到 30 秒的清晰单人说话。');
  return { audio: resolve(result.audio), text: result.text.trim(), durationSeconds: result.durationSeconds };
}

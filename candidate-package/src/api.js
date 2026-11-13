// Adapted from cortico-world-tts's oMLX client; see LICENSE and NOTICE.
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { StudioError, endpoint } from './config.js';
import { MAX_AUDIO_BYTES, sniffAudio } from './files.js';
const MAX_REFERENCE = 15 * 1024 * 1024;
const combineSignal = (timeoutMs, signal) => signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
export async function boundedBody(response, limit) {
  const reader = response.body?.getReader(); if (!reader) throw new StudioError('模型没有返回内容。');
  let size = 0; const parts = [];
  try { for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.byteLength; if (size > limit) { await reader.cancel(); throw new StudioError('模型返回内容超过大小限制。'); } parts.push(Buffer.from(value)); } } finally { reader.releaseLock(); }
  return Buffer.concat(parts);
}
async function request(url, options) {
  try { const response = await fetch(url, { ...options, redirect: 'error' }); if (!response.ok) { await response.body?.cancel(); throw new StudioError(`本机接口返回 HTTP ${response.status}；请检查服务、密钥与模型配置。`); } return response; }
  catch (error) { if (error instanceof StudioError) throw error; if (options.signal?.aborted) throw new StudioError('操作已取消或等待超时。'); throw new StudioError('无法连接本机模型服务，请检查地址与运行状态。'); }
}
async function referenceWav(path, signal) {
  if (!isAbsolute(path)) throw new StudioError('参考声音需要填写 WAV 的绝对路径。');
  let file;
  try {
    signal.throwIfAborted();
    file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW || 0));
    const stat = await file.stat();
    if (!stat.isFile() || stat.size < 44 || stat.size > MAX_REFERENCE) throw new StudioError('参考声音必须是 15 MiB 以内的普通 WAV 文件。');
    const bytes = Buffer.alloc(stat.size + 1); let size = 0;
    while (size < bytes.length) { signal.throwIfAborted(); const part = await file.read(bytes, size, bytes.length - size, null); if (!part.bytesRead) break; size += part.bytesRead; }
    if (size !== stat.size || sniffAudio(bytes.subarray(0, size)) !== 'audio/wav') throw new StudioError('参考声音不是有效 WAV，或读取时发生变化。');
    return bytes.subarray(0, size).toString('base64');
  } catch (error) { if (error instanceof StudioError) throw error; throw new StudioError('无法读取参考 WAV，请检查文件与权限。'); } finally { await file?.close().catch(() => {}); }
}
export async function listModels(cfg, key, signal) {
  const res = await request(endpoint(cfg.baseUrl, 'models'), { headers: key ? { Authorization: `Bearer ${key}` } : {}, signal: combineSignal(10000, signal) });
  let result; try { result = JSON.parse((await boundedBody(res, 1024 * 1024)).toString('utf8')); } catch (error) { if (error instanceof StudioError) throw error; throw new StudioError('模型列表格式无法识别。'); }
  if (!Array.isArray(result.data)) throw new StudioError('模型服务未提供模型列表。');
  return result.data.filter((item) => typeof item.id === 'string').map((item) => item.id.slice(0, 300));
}
export async function synthesize(cfg, text, key, signal) {
  const url = endpoint(cfg.baseUrl, 'audio/speech');
  if (!cfg.ttsModel) throw new StudioError('请先选择说话模型。');
  const paired = !!cfg.referenceAudioPath === !!cfg.referenceText;
  if (!paired) throw new StudioError('参考 WAV 与逐字稿需要同时填写。');
  if (/qwen3[-_]tts.*base/i.test(cfg.ttsModel) && !cfg.referenceAudioPath) throw new StudioError('Qwen3-TTS Base 需要参考 WAV 与逐字稿；预置音色请选 CustomVoice。');
  if (/qwen3[-_]tts.*customvoice/i.test(cfg.ttsModel) && cfg.referenceAudioPath) throw new StudioError('参考声音请选 Qwen3-TTS Base；CustomVoice 用预置音色。');
  const combined = combineSignal(cfg.timeoutMs, signal);
  const body = { model: cfg.ttsModel, input: text, response_format: 'wav', language: cfg.language || 'chinese' };
  if (cfg.referenceAudioPath) { body.ref_audio = await referenceWav(cfg.referenceAudioPath, combined); body.ref_text = cfg.referenceText; }
  else { if (!cfg.voice) throw new StudioError('请选择预置音色。'); body.voice = cfg.voice; }
  const headers = { 'Content-Type': 'application/json' }; if (key) headers.Authorization = `Bearer ${key}`;
  const res = await request(url, { method: 'POST', headers, body: JSON.stringify(body), signal: combined });
  const bytes = await boundedBody(res, MAX_AUDIO_BYTES), mime = sniffAudio(bytes);
  if (!mime) throw new StudioError('模型未返回可识别的 WAV 或 MP3。');
  return { bytes, mime };
}

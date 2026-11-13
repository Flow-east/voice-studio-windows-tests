import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const MAX_AUDIO_BYTES = 20 * 1024 * 1024;
const VOICE_MARKER = /\[语音[,，](?:正在转写中\.{3}|协议端不提供转写)\]/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function fail(code, message) { const error = new Error(message); error.code = code; return error; }
function cancelled() { const error = fail('QQ_AUDIO_CANCELLED', 'QQ 语音读取已取消。'); error.name = 'AbortError'; return error; }
function id(value, signed = false) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return null;
  if (!['string', 'number'].includes(typeof value)) return null;
  const text = String(value).trim();
  if (!(signed ? /^-?\d{1,20}$/ : /^\d{1,20}$/).test(text)) return null;
  const normalized = BigInt(text).toString();
  return !signed && BigInt(normalized) <= 0n ? null : normalized;
}
function voiceSource(event, messageId) {
  if (!event || event.source !== 'qq' || event.type !== 'qq.message' || !VOICE_MARKER.test(String(event.text ?? ''))) return null;
  const meta = event.meta;
  if (!object(meta) || id(meta.message_id, true) !== messageId || !object(meta.conv)) return null;
  const kind = meta.conv.kind, convId = id(meta.conv.id), userId = id(meta.user_id);
  if (!['group', 'private'].includes(kind) || !convId || !userId || kind === 'private' && convId !== userId) return null;
  return { messageId, conv: { kind, id: convId }, userId,
    senderName: typeof meta.sender_name === 'string' ? meta.sender_name.slice(0, 200) : '', eventId: event.cursor };
}
function visibleSource(store, messageId, eventId) {
  if (!store || typeof store.latestCursor !== 'function' || typeof store.range !== 'function') return null;
  if (eventId !== undefined) {
    if (!Number.isSafeInteger(eventId) || eventId < 0 || typeof store.get !== 'function') return null;
    return voiceSource(store.get(eventId), messageId);
  }
  // Manual retry only searches a bounded, recent QQ window; never scan unrelated sources.
  const latest = store.latestCursor();
  if (!Number.isSafeInteger(latest) || latest < 0) return null;
  const earliest = Math.max(0, latest - 4999);
  for (let end = latest; end >= earliest; end -= 250) {
    const events = store.range({ source: 'qq', fromCursor: Math.max(earliest, end - 249), toCursor: end, limit: 250 });
    for (const event of [...events].reverse()) { const source = voiceSource(event, messageId); if (source) return source; }
  }
  return null;
}
async function connectionConfig(botDir, source, readFileImpl, signal) {
  if (typeof botDir !== 'string' || !botDir) throw fail('QQ_AUDIO_CONFIG', '无法读取当前 QQ 连接配置。');
  let cfg;
  try {
    const raw = await readFileImpl(join(botDir, 'config.json'), { signal });
    if (Buffer.byteLength(raw) > 1024 * 1024) throw new Error('Config too large');
    cfg = JSON.parse(String(raw))?.worlds?.qq;
  } catch { if (signal?.aborted) throw cancelled(); throw fail('QQ_AUDIO_CONFIG', '无法读取当前 QQ 连接配置。'); }
  if (!object(cfg) || cfg.enabled !== true) throw fail('QQ_AUDIO_DISABLED', '请先启用官方 QQ 插件。');
  const roster = source.conv.kind === 'group' ? cfg.groups : cfg.privates;
  if (!Array.isArray(roster) || !roster.some(entry => object(entry) && entry.enabled === true && id(entry.id) === source.conv.id)) {
    throw fail('QQ_AUDIO_NOT_WATCHED', '这条语音所属会话当前未在 QQ 监听名单中。');
  }
  let url;
  try { url = new URL(cfg.wsUrl); } catch { throw fail('QQ_AUDIO_CONFIG', 'QQ 协议端连接地址无效。'); }
  if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.hash) throw fail('QQ_AUDIO_CONFIG', 'QQ 协议端连接地址无效。');
  const token = typeof cfg.token === 'string' ? cfg.token : '';
  if (/[\r\n]/.test(token)) throw fail('QQ_AUDIO_CONFIG', 'QQ 协议端连接配置无效。');
  // Only these fields survive configuration parsing. Never log or persist this token.
  return { url: url.href, token };
}
function recordFile(message, source) {
  if (!object(message) || id(message.message_id, true) !== source.messageId) throw fail('QQ_AUDIO_TARGET', 'QQ 返回的消息与请求不一致。');
  const sender = id(message.user_id ?? message.sender?.user_id);
  const kind = message.message_type;
  const convId = kind === 'group' ? id(message.group_id) : sender;
  if (kind !== source.conv.kind || convId !== source.conv.id || sender !== source.userId) throw fail('QQ_AUDIO_TARGET', 'QQ 返回的语音不属于原会话或发言人。');
  if (!Array.isArray(message.message)) throw fail('QQ_AUDIO_NO_RECORD', 'QQ 未返回可读取的语音。');
  const records = message.message.filter(segment => segment?.type === 'record');
  if (records.length !== 1) throw fail('QQ_AUDIO_NO_RECORD', records.length > 1 ? '请将多段 QQ 语音分别发送。' : '这条 QQ 消息没有可读取的语音。');
  const file = records[0]?.data?.file;
  // Ask NapCat for an observed opaque recording id only, never a path or arbitrary URL.
  if (typeof file !== 'string' || !file || file.length > 1024 || /[\s\x00-\x1f\x7f\\/:?]/.test(file) || file.startsWith('.') || file.includes('..')) {
    throw fail('QQ_AUDIO_RECORD_ID', 'QQ 未返回有效的语音文件标识。');
  }
  return file;
}
function wavBytes(data, maximum) {
  const encoded = object(data) ? data.base64 : undefined;
  if (typeof encoded !== 'string' || !encoded.length) throw fail('QQ_AUDIO_NO_BYTES', 'QQ 协议端未返回 WAV 音频，请检查 NapCat 的语音读取支持。');
  if (encoded.length > 4 * Math.ceil(maximum / 3)) throw fail('QQ_AUDIO_TOO_LARGE', 'QQ 语音超过 20 MB，请发送较短的语音。');
  if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw fail('QQ_AUDIO_INVALID', 'QQ 返回的音频格式无效。');
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length > maximum) throw fail('QQ_AUDIO_TOO_LARGE', 'QQ 语音超过 20 MB，请发送较短的语音。');
  if (bytes.length < 12 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') throw fail('QQ_AUDIO_INVALID', 'QQ 协议端未返回有效的 WAV 音频。');
  return bytes;
}

/** Read one already-visible QQ voice message. Opens a separate, read-only OneBot connection. */
export async function readQQAudio({ host, botDir, messageId, eventId, signal, WebSocketImpl,
  readFileImpl = readFile, timeoutMs = 20000, maxAudioBytes = MAX_AUDIO_BYTES } = {}) {
  if (signal?.aborted) throw cancelled();
  const mid = id(messageId, true);
  if (!mid) throw fail('QQ_AUDIO_INPUT', '请提供这条 QQ 语音的消息编号。');
  let source;
  try { source = visibleSource(host?.store, mid, eventId); }
  catch { throw fail('QQ_AUDIO_NOT_VISIBLE', '无法确认这条语音来自当前已接收的 QQ 消息。'); }
  if (!source) throw fail('QQ_AUDIO_NOT_VISIBLE', '只能识别当前已接收的 QQ 语音消息。');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000 || !Number.isSafeInteger(maxAudioBytes) || maxAudioBytes < 12 || maxAudioBytes > MAX_AUDIO_BYTES) {
    throw fail('QQ_AUDIO_INPUT', 'QQ 语音读取限制无效。');
  }
  const cfg = await connectionConfig(botDir, source, readFileImpl, signal);
  if (signal?.aborted) throw cancelled();
  const Socket = WebSocketImpl ?? (await import('ws')).default;
  if (signal?.aborted) throw cancelled();
  return await new Promise((resolve, reject) => {
    let socket, settled = false, pending = null;
    const maximumFrame = 4 * Math.ceil(maxAudioBytes / 3) + 65536;
    const finish = (error, bytes) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (socket) {
        socket.removeListener('open', opened); socket.removeListener('message', received);
        socket.removeListener('error', errored); socket.removeListener('close', closed);
        socket.on('error', () => {}); // ws can emit an error after terminating a connecting socket.
        try { socket.terminate(); } catch { try { socket.close(); } catch {} }
      }
      if (error) reject(error); else resolve({ bytes, mime: 'audio/wav', source });
    };
    const abort = () => finish(cancelled());
    const timer = setTimeout(() => finish(fail('QQ_AUDIO_TIMEOUT', '读取 QQ 语音超时，请确认 QQ 已连接后重试。')), timeoutMs);
    const errored = () => finish(fail('QQ_AUDIO_CONNECTION', '无法读取 QQ 语音，请检查 QQ 协议端连接。'));
    const closed = () => finish(fail('QQ_AUDIO_CONNECTION', 'QQ 语音读取连接已断开，请重试。'));
    const request = (action, params) => {
      const echo = `voice-studio:${randomUUID()}`;
      pending = { action, echo };
      try { socket.send(JSON.stringify({ action, params, echo })); } catch { errored(); }
    };
    const opened = () => { if (!settled) request('get_msg', { message_id: Number.isSafeInteger(Number(mid)) ? Number(mid) : mid }); };
    const received = (raw, isBinary) => {
      if (settled || !pending || isBinary) return;
      let frame;
      try {
        const bytes = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw);
        if (bytes.length > maximumFrame) throw fail('QQ_AUDIO_TOO_LARGE', 'QQ 返回的音频数据过大。');
        frame = JSON.parse(bytes.toString('utf8'));
      } catch (error) { if (error?.code === 'QQ_AUDIO_TOO_LARGE') finish(error); return; }
      // Unsolicited pushes and other requests' replies are ignored and never retained.
      if (!object(frame) || frame.echo !== pending.echo) return;
      if (frame.retcode !== 0 || frame.status === 'failed') { finish(fail('QQ_AUDIO_PROTOCOL', 'QQ 协议端未能取回这条语音，请稍后重试。')); return; }
      const action = pending.action; pending = null;
      try {
        if (action === 'get_msg') request('get_record', { file: recordFile(frame.data, source), out_format: 'wav' });
        else finish(null, wavBytes(frame.data, maxAudioBytes));
      } catch (error) { finish(error?.code?.startsWith('QQ_AUDIO_') ? error : fail('QQ_AUDIO_INVALID', 'QQ 返回的音频数据无效。')); }
    };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      socket = new Socket(cfg.url, { ...(cfg.token ? { headers: { Authorization: `Bearer ${cfg.token}` } } : {}), maxPayload: maximumFrame, followRedirects: false });
      socket.on('open', opened); socket.on('message', received); socket.on('error', errored); socket.on('close', closed);
      if (signal?.aborted) abort();
    } catch { errored(); }
  });
}

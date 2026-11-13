export const ID = 'voice-studio';
export const LABEL = '大肥鱼语音助手';
export const DOWNLOAD_SOURCES = Object.freeze(['domestic', 'overseas']);
export const DOWNLOAD_FALLBACK_CODES = Object.freeze(['MODEL_SOURCE_NETWORK', 'MODEL_SOURCE_HTTP', 'MODEL_DOWNLOAD_PROTOCOL', 'MODEL_DOWNLOAD_CHECKSUM']);
export const SINGING_VOICES = Object.freeze(['female', 'male']);
export const SINGING_STYLES = Object.freeze(['gentle', 'folk', 'pop', 'jazz']);
export const DEFAULTS = Object.freeze({ enabled: false, backend: 'managed', referenceName: '', singingEnabled: false, singingVoice: 'female', singingStyle: 'gentle', singingDescription: '', singingUseReference: true, companionUrl: 'http://127.0.0.1:17788', baseUrl: 'http://127.0.0.1:3355', apiKeySecret: 'VOICE_STUDIO_API_KEY', ttsModel: '', voice: 'vivian', referenceAudioPath: '', referenceText: '', language: 'chinese', lyricModel: '', aceRoot: '', pythonPath: '', checkpointRoot: '', ffmpegPath: '', volume: 80, timeoutMs: 600000, maxQueue: 3 });
export class StudioError extends Error {}
export const publicError = (error) => error instanceof StudioError ? error.message : '操作未完成，请检查插件状态与本地环境。';
export function settings(cfg = {}) {
  const value = { ...DEFAULTS, ...cfg };
  for (const key of Object.keys(DEFAULTS)) if (typeof DEFAULTS[key] === 'string' && !['singingVoice', 'singingStyle', 'singingDescription'].includes(key)) value[key] = typeof value[key] === 'string' ? value[key].trim() : DEFAULTS[key];
  for (const key of ['singingVoice', 'singingStyle']) if (value[key] === undefined) value[key] = DEFAULTS[key];
  value.backend = value.backend === 'legacy' ? 'legacy' : 'managed';
  // An unpublished preview exposed a source preference; automatic routing ignores it.
  delete value.downloadSource;
  value.singingEnabled = value.singingEnabled === true;
  const integer = (key, min, max) => value[key] = Math.max(min, Math.min(max, Number.isFinite(Number(value[key])) ? Math.round(Number(value[key])) : DEFAULTS[key]));
  integer('volume', 0, 100); integer('timeoutMs', 1000, 600000); integer('maxQueue', 1, 3);
  return value;
}
export function singingPreferences(options = {}, cfg = DEFAULTS) {
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some((key) => !['voice', 'style', 'description', 'useReference'].includes(key))) throw new StudioError('唱歌设置只能包含 voice、style、description 和 useReference。');
  const singingVoice = options.voice === undefined ? cfg.singingVoice === undefined ? DEFAULTS.singingVoice : cfg.singingVoice : options.voice;
  const singingStyle = options.style === undefined ? cfg.singingStyle === undefined ? DEFAULTS.singingStyle : cfg.singingStyle : options.style;
  if (!SINGING_VOICES.includes(singingVoice)) throw new StudioError('演唱声音请选择女声（female）或男声（male）。');
  if (!SINGING_STYLES.includes(singingStyle)) throw new StudioError('演唱风格的快捷选项为温柔、民谣、流行或爵士；其他风格请填写演唱描述。');
  const singingDescription = options.description === undefined ? cfg.singingDescription ?? '' : options.description;
  const singingUseReference = options.useReference === undefined ? cfg.singingUseReference ?? true : options.useReference;
  if (typeof singingDescription !== 'string' || [...singingDescription].length > 1000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(singingDescription)) throw new StudioError('演唱描述最多 1000 字，请使用普通文字。');
  if (typeof singingUseReference !== 'boolean') throw new StudioError('使用演唱参考必须是开启或关闭。');
  return { singingVoice, singingStyle, singingDescription: singingDescription.trim(), singingUseReference };
}
export function endpoint(baseUrl, suffix) {
  let url;
  try { url = new URL(baseUrl); } catch { throw new StudioError('接口地址无效，请填写本机 oMLX 地址。'); }
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || !['', '/', '/v1', '/v1/'].includes(url.pathname)) throw new StudioError('首版只连接本机地址：localhost、127.0.0.1 或 ::1；地址只能以 /v1 结尾。');
  url.pathname = `/v1/${suffix}`;
  return url.href;
}
const playback = { type: 'boolean', default: false, description: '默认 false 只生成音频供 QQ 或手动试听；明确要求在本机播放时设 true，插件播放后勿重复播放。' };
const object = (properties, required = []) => ({ type: 'object', additionalProperties: false, properties, required });
export const TOOLS = [
  { name: 'voice_studio_transcribe', tags: ['read'], description: '用本地模型识别已经收到的 QQ 语音。通常插件会自动识别并通过 voice-studio.transcript 交付；仅在需重试或尚未开始识别时调用。只接受已有 QQ 消息编号，不接受文件路径、网址或任意会话查询。异步返回任务号，等待识别完成后结合原始会话回复，不能猜测录音内容。', parameters: object({ messageId: { type: 'string', pattern: '^-?[0-9]{1,24}$', description: '已收到的 QQ 语音消息 message_id，按原样提供。' } }, ['messageId']) },
  { name: 'voice_studio_speak', tags: ['act'], description: '用已配置的本地音色说出文本。异步返回任务号；插件完成合成后按 playback 播放。不用于唱歌，不改变用户音色配置，不直接发送 QQ 消息；QQ 场景使用 playback=false，完成后由 QQ 插件交付。', parameters: object({ text: { type: 'string', minLength: 1, maxLength: 1000, description: '需要说出的文本。' }, playback }, ['text']) },
  { name: 'voice_studio_sing', tags: ['act'], description: '仅在用户已开启唱歌功能后，用本地模型把原创歌词作曲并唱成30秒中文短歌。先用当前聊天能力根据用户主题创作歌名和四句歌词，必须提供 title 与 lines；用户只需给主题，不要让用户写词。可选男声、女声和快捷风格，也可通过 description 自由描述曲风、乐器、情绪和唱法。非空描述优先于快捷风格；可使用用户在唱歌页上传的演唱参考。省略时使用面板保存的默认选择。每次覆盖只影响本任务。异步任务；插件完成后按 playback 播放。不承诺固定歌手音色、真人声音克隆或指定现成歌曲。', parameters: object({ keyword: { type: 'string', minLength: 1, maxLength: 100, description: '歌曲主题或关键词，单行。' }, voice: { type: 'string', enum: [...SINGING_VOICES], description: '本次演唱声音：female 女声；male 男声。省略则使用保存的默认值。' }, style: { type: 'string', enum: [...SINGING_STYLES], description: '本次快捷风格：gentle 温柔，folk 民谣，pop 流行，jazz 爵士。其他风格写入 description。省略则使用保存的默认值。' }, description: { type: 'string', maxLength: 1000, description: '自然语言演唱描述，支持中文或英文，如摇滚、电子、R&B、说唱，乐器、情绪和唱法。非空时优先于快捷风格；不确定时可用清楚的英文音乐描述。省略沿用面板；空字符串恢复快捷风格。' }, useReference: { type: 'boolean', description: '是否使用用户在唱歌页上传的演唱参考（有则使用）；false 本次忽略参考。只参考声音和音乐质感，不复刻原曲或保证固定歌手。省略沿用面板。不接受文件路径或网址。' }, title: { type: 'string', minLength: 1, maxLength: 20, description: '必填原创歌名，先根据用户主题创作，与 lines 一起提供。' }, lines: { type: 'array', minItems: 4, maxItems: 4, items: { type: 'string', minLength: 7, maxLength: 12 }, description: '必填四句原创中文歌词，每句7至12个汉字，不含标点或拼音。先根据用户主题创作，与 title 一起提供。' }, playback }, ['keyword', 'title', 'lines']) },
  { name: 'voice_studio_status', tags: ['read'], description: '查询大肥鱼语音助手任务。已接收的任务不要重复创建，状态查询不会触发播放。', parameters: object({ jobId: { type: 'string', maxLength: 80 } }) },
  { name: 'voice_studio_play', tags: ['act'], description: '按明确请求播放工作室已有作品，只接受本插件的任务号。生成时 playback=true 已自动排播放，勿因收到完成事件再调用。', parameters: object({ jobId: { type: 'string', maxLength: 80 } }, ['jobId']) },
  { name: 'voice_studio_stop', tags: ['act'], description: '停止工作室当前生成、排队任务和播放。用户说停止或取消时使用。不会停止其他插件。', parameters: object({}) },
];
export function configGroup() {
  const properties = {
    [`worlds.${ID}.singingEnabled`]: { type: 'boolean', title: '启用唱歌（可选）' },
    [`worlds.${ID}.singingVoice`]: { type: 'string', title: '默认歌声', enum: [...SINGING_VOICES] },
    [`worlds.${ID}.singingStyle`]: { type: 'string', title: '默认演唱风格', enum: [...SINGING_STYLES] },
    [`worlds.${ID}.singingDescription`]: { type: 'string', title: '演唱描述', maxLength: 1000 },
    [`worlds.${ID}.singingUseReference`]: { type: 'boolean', title: '使用已上传的演唱参考' },
  };
  return { id: `world:${ID}`, owner: `world:${ID}`, schema: { type: 'object', title: LABEL, properties } };
}
export function suppliedLyrics(title, lines) {
  if (title === undefined && lines === undefined) return {};
  if (typeof title !== 'string' || !title.trim() || [...title.trim()].length > 20 || /[\u0000-\u001f\u007f]/u.test(title) || !Array.isArray(lines) || lines.length !== 4 || lines.some(line => typeof line !== 'string' || !/^[\u3400-\u9fff]{7,12}$/u.test(line))) throw new StudioError('歌词需要原创歌名和四句中文，每句7至12个汉字，不带标点。');
  return { lyricTitle: title.trim(), lyricLines: [...lines] };
}

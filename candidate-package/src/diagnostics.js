import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep, isAbsolute } from 'node:path';
import { arch, platform, release } from 'node:os';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { SYSTEM_ERRNOS, safeContextDetail, processContextDetails, runtimeContextDetails, numericSystemDetails, systemFailureCode } from './diagnostic-context.js';

const MAX_ENTRIES = 200, STORE_BYTES = 128 * 1024, LOG_BYTES = 2 * 1024 * 1024, TAIL_BYTES = 48 * 1024;
const JOB_ID = /^(?:reference-)?\d{13}-[a-f0-9]{8}$/;
const REFERENCE_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const SESSION_FINGERPRINT_KEY = randomBytes(32).toString('hex');
const LEVELS = new Set(['info', 'warning', 'error']);
const AREAS = new Set(['system', 'setup', 'speech', 'transcription', 'singing', 'song', 'reference', 'qq', 'playback']);
const STATES = new Set(['missing', 'preparing', 'ready', 'failed', 'cancelled', 'queued', 'running', 'completed', 'unknown']);
const DOWNLOAD_SOURCES = new Set(['domestic', 'overseas']);
const FALLBACK_CODES = new Set(['MODEL_SOURCE_NETWORK', 'MODEL_SOURCE_HTTP', 'MODEL_DOWNLOAD_PROTOCOL', 'MODEL_DOWNLOAD_CHECKSUM']);
const SETUP_STEPS = { 'runtime-tool': '运行工具下载', python: 'Python 环境', dependencies: '运行依赖', 'audio-tools': '音频组件', model: '模型文件', 'singing-engine': '演唱引擎', verification: '组件验证' };
const sourceLabel = source => source === 'domestic' ? '国内' : source === 'overseas' ? '国外' : '未知';
const CATALOG = {
  MODEL_SOURCE_NETWORK: ['模型下载源连接失败', '检查网络或代理后重试；已验证的完整文件会保留。'],
  MODEL_SOURCE_HTTP: ['模型下载源返回错误', '稍后重试；仍失败时复制诊断报告。'],
  MODEL_DOWNLOAD_PROTOCOL: ['模型下载响应无效', '稍后重试；仍失败时复制诊断报告。'],
  MODEL_DOWNLOAD_CHECKSUM: ['模型下载文件校验失败', '重试下载；已验证文件会保留，仍失败时复制诊断报告。'],
  MODEL_DOWNLOAD_MANIFEST: ['模型文件清单无效', '重新安装插件；仍失败时复制诊断报告。'],
  MODEL_DOWNLOAD_PATH: ['模型存储目录包含无效文件或链接', '检查本地存储；仍失败时复制诊断报告。'],
  STORAGE_CLEANUP_STARTED: ['开始清理存储', '等待清理完成。'],
  STORAGE_CLEANUP_COMPLETED: ['存储清理完成', '可在配置页查看最新占用。'],
  STORAGE_CLEANUP_PARTIAL: ['部分文件未能清理', '刷新存储用量后重试；仍失败时复制诊断报告反馈。'],
  STORAGE_CLEANUP_FAILED: ['存储清理失败', '刷新存储用量后重试；仍失败时复制诊断报告反馈。'],
  SETUP_STARTED: ['开始准备模型', '可在对应功能页查看下载进度。'],
  SETUP_READY: ['模型准备完成', '可以开始使用对应功能。'],
  SETUP_CANCELLED: ['模型准备已取消', '需要时继续准备，已下载文件会保留。'],
  SETUP_FAILED: ['模型准备失败', '查看下面的原因；重试仍失败时复制诊断报告反馈。'],
  JOB_STARTED: ['任务已开始', '等待生成完成。'],
  JOB_COMPLETED: ['任务已完成', '可在对应功能页试听。'],
  JOB_CANCELLED: ['任务已取消', '需要时重新提交。'],
  JOB_FAILED: ['任务执行失败', '查看下面的原因；重试仍失败时复制诊断报告反馈。'],
  REFERENCE_SAVED: ['参考音频已保存', '可试听或选为说话音色。'],
  REFERENCE_SELECTED: ['已切换参考音色', '之后的语音使用当前选择。'],
  REFERENCE_RENAMED: ['参考音色已重命名', '可以按新名称找到这段音色。'],
  REFERENCE_DELETED: ['参考音色已从列表删除', '需要时可重新上传录音。'],
  VOICE_DEFAULT: ['已切换默认音色', '已保存的参考音频仍可再次选择。'],
  QQ_CONNECTED: ['QQ 已连接', '可在 QQ 对话中使用语音功能。'],
  PLAYBACK_FAILED: ['试听播放失败', '检查系统声音输出，或重新点击播放。'],
  BROWSER_AUDIO_FAILED: ['浏览器无法播放音频', '刷新页面后重新试听，并检查浏览器声音权限与系统音频设备；仍失败时复制诊断报告。'],
  DELIVERY_FAILED: ['音频已完成，但通知 Coopanion 失败', '先到对应功能页查看已完成作品，避免重复生成；重试通知仍失败时复制诊断报告反馈。'],
  PANEL_OPERATION_FAILED: ['配置保存或音频读取失败', '刷新页面后重试；若仍失败，复制诊断报告并说明刚才的操作。'],
  REFERENCE_FAILED: ['参考音频无法读取或保存', '保留原参考文件；可先使用默认音色，复制诊断报告后联系作者排查。'],
  UNKNOWN: ['未识别的运行错误', '复制诊断报告反馈，并补充操作步骤；报告不会包含聊天正文或录音。'],
  USER_CANCELLED: ['操作已取消', '需要时重新开始。'],
  PROCESS_TERMINATION_FAILED: ['无法确认后台程序已停止', '已暂停新任务和清理。完全退出 Coopanion，在任务管理器或活动监视器确认相关程序结束后再启动，并复制诊断报告反馈。'],
  PROCESS_TIMEOUT: ['运行超时', '确认模型已就绪，缩短输入后重试；下载超时可检查网络。'],
  PROCESS_START_FAILED: ['运行程序无法启动', '在对应功能页重新准备组件，并检查系统文件访问权限。'],
  PROCESS_EXIT: ['运行程序异常退出', '查看异常类型或组件信息；重试仍失败时复制报告反馈。'],
  PERMISSION_DENIED: ['文件或系统访问被拒绝', '检查系统提示的文件访问权限，允许后重试。'],
  FILE_MISSING: ['所需文件不存在', '在对应功能页重新准备模型或重新选择录音。'],
  FILE_IN_USE: ['文件访问发生占用或共享冲突', '保留已下载文件并更新插件后重试；共享冲突也可能来自程序自身，不能仅凭此错误认定是其他软件占用。'],
  RESOURCE_BUSY: ['系统资源访问发生占用或共享冲突', '报告已保留系统错误码；仅凭该错误不能确定占用方或具体文件，无需删除模型缓存。'],
  PATH_TOO_LONG: ['模型文件路径超过系统限制', '将插件数据目录移至较短的本地路径后重试。'],
  FILE_OPERATION_INVALID: ['模型文件操作被系统拒绝：参数或路径无效', '本报告已记录系统错误码和失败操作，反馈作者定位 Windows 兼容问题。'],
  FILESYSTEM_UNSUPPORTED: ['模型目录不支持当前文件操作', '本报告已记录失败操作；使用本机磁盘目录后重试。'],
  FILE_IO_FAILED: ['模型文件读取或写入失败', '检查模型所在磁盘状态；本报告已记录系统错误码和失败操作。'],
  DISK_FULL: ['磁盘空间不足', '释放磁盘空间后继续准备或重试。'],
  MEMORY_EXHAUSTED: ['可用内存不足', '关闭占用内存的应用，减少同时运行的模型后重试。'],
  NETWORK_TIMEOUT: ['下载或连接超时', '检查网络连接；已下载文件保留，可稍后继续。'],
  NETWORK_FAILED: ['下载连接中断或无法建立', '检查网络连接与代理，恢复后重试；已下载的有效文件会保留。'],
  PROXY_FAILED: ['下载代理连接失败', '检查系统或网络代理是否可用，恢复后重试下载。'],
  PROXY_CONFIG: ['下载代理或网络地址配置无效', '检查系统代理与 NO_PROXY 地址格式；更新插件后重试，仍失败时复制诊断报告。'],
  CONNECTION_REFUSED: ['目标服务未连接', '确认 QQ 插件与协议端运行正常后重试。'],
  DNS_FAILED: ['网络域名解析失败', '检查网络与 DNS，恢复后重试下载。'],
  TLS_FAILED: ['安全连接验证失败', '检查系统时间与网络代理；不要关闭证书验证。'],
  HTTP_ERROR: ['下载服务返回错误状态', '检查网络；若服务暂时不可用，稍后重试。'],
  DEPENDENCY_MISSING: ['运行依赖缺失', '在对应功能页重新准备组件。'],
  MODEL_INCOMPLETE: ['模型文件不完整或校验失败', '在对应功能页重新准备模型，保留的有效文件可复用。'],
  MODEL_CACHE_MISSING: ['本机模型缓存或已验证清单缺失', '首次使用需要联网下载模型；检查网络后继续准备，无需删除已有文件。'],
  AUDIO_INVALID: ['音频格式或时长不符合要求', '使用页面支持的音频格式和时长，换一段清晰录音再试。'],
  EMPTY_TRANSCRIPT: ['未识别到清楚的语音', '使用清晰、单人、没有长时间静音的录音重试。'],
  METAL_UNAVAILABLE: ['本机模型计算设备不可用', '确认使用受支持的 M 系列 Mac，并重启应用后重试。'],
  CUDA_ACCELERATION_UNAVAILABLE: ['NVIDIA 显卡加速不可用', '更新 NVIDIA 显卡驱动并重启电脑，再到对应功能页重新准备；仍失败时复制诊断报告反馈。'],
  PYTHON_EXCEPTION: ['模型程序报告异常', '直接发送本次完整诊断报告；其中包含已捕获的系统错误码、失败操作和调用位置。'],
  LOG_UNAVAILABLE: ['部分诊断记录无法读取', '可先复制当前报告；重试后仍缺失时检查本地目录权限。'],
  QUEUE_FULL: ['任务队列已满', '等待当前任务完成后重试。'],
  QQ_AUDIO_CANCELLED: ['QQ 语音读取已取消', '需要时重新发送语音。'],
  QQ_AUDIO_CONFIG: ['无法使用当前 QQ 连接配置', '先在官方 QQ 插件中检查连接状态。'],
  QQ_AUDIO_DISABLED: ['官方 QQ 插件未启用', '在 World 总览启用官方 QQ 插件。'],
  QQ_AUDIO_NOT_WATCHED: ['QQ 会话未开启监听', '在官方 QQ 插件中启用需要使用的会话。'],
  QQ_AUDIO_NOT_VISIBLE: ['无法找到对应的近期 QQ 语音', '请在原会话重新发送这条语音。'],
  QQ_AUDIO_TARGET: ['QQ 返回的语音与原消息不匹配', '请在原会话重新发送语音；持续出现时复制报告反馈。'],
  QQ_AUDIO_NO_RECORD: ['QQ 未返回可读取的语音', '请重新发送单条语音。'],
  QQ_AUDIO_RECORD_ID: ['QQ 返回的语音标识无效', '检查 QQ 协议端版本与连接，或重新发送语音。'],
  QQ_AUDIO_NO_BYTES: ['QQ 协议端未返回可用录音', '检查协议端的 WAV 音频读取支持。'],
  QQ_AUDIO_TOO_LARGE: ['QQ 语音文件过大', '发送较短的语音，单条不超过 20 MB。'],
  QQ_AUDIO_INVALID: ['QQ 返回的音频无效', '请重新发送语音并检查协议端。'],
  QQ_AUDIO_TIMEOUT: ['读取 QQ 语音超时', '确认 QQ 已连接后重试。'],
  QQ_AUDIO_CONNECTION: ['QQ 语音读取连接失败', '检查官方 QQ 插件与协议端连接后重试。'],
  QQ_AUDIO_INPUT: ['QQ 语音请求格式无效', '请针对原会话中的语音重试，或重新发送语音。'],
};
const MODEL_NAMES = {
  transcription: 'Qwen3-ASR-0.6B-8bit', speech: 'Qwen3-TTS-12Hz-1.7B-Base-8bit',
  reference: '参考音色处理（共用语音合成模型）', singing: 'ACE-Step 1.5',
};
const SETUP_LOGS = [
  'setup-error.log', 'setup-command.log', 'setup-download.log', 'setup-singing-source-verify.log',
  ...['speech', 'asr', 'singing'].flatMap(k => [`setup-${k}-python.log`, `setup-${k}-packages.log`, `setup-${k}-verify.log`]),
  ...['speech', 'reference', 'asr', 'singing'].map(k => `setup-model-${k}.log`),
];
const EXCEPTIONS = ['ModelDownloadError', 'ModuleNotFoundError', 'ImportError', 'FileNotFoundError', 'PermissionError', 'MemoryError', 'OutOfMemoryError', 'TimeoutError', 'ConnectionError', 'SSLError', 'HTTPError', 'RuntimeError', 'ValueError', 'TypeError', 'KeyError', 'OSError', 'AssertionError', 'SafetensorError', 'JSONDecodeError', 'ConnectError', 'ReadError', 'WriteError', 'NetworkError', 'ProxyError', 'InvalidURL', 'ConnectTimeout', 'ReadTimeout', 'WriteTimeout', 'PoolTimeout', 'TimeoutException', 'RemoteProtocolError', 'ProtocolError', 'NewConnectionError', 'NameResolutionError', 'MaxRetryError', 'HTTPStatusError', 'HfHubHTTPError', 'LocalEntryNotFoundError', 'CachedRepoTreeNotFoundError', 'EntryNotFoundError', 'RemoteEntryNotFoundError', 'RevisionNotFoundError', 'RepositoryNotFoundError', 'GatedRepoError', 'OfflineModeIsEnabled', 'HFValidationError', 'FileExistsError', 'NotADirectoryError', 'IsADirectoryError', 'ConnectionAbortedError', 'ConnectionRefusedError', 'ConnectionResetError', 'BrokenPipeError', 'URLError', 'HTTPException'];
const MODULES = ['qwen_tts', 'qwen_asr', 'mlx', 'mlx_audio', 'mlx_lm', 'torch', 'torchaudio', 'transformers', 'soundfile', 'imageio_ffmpeg', 'huggingface_hub', 'safetensors', 'diffusers', 'acestep', 'pytorch_wavelets', 'numpy', 'scipy', 'ws'];
const RUNTIME_FILES = ['model_download.py', 'managed_speech.py', 'managed_reference.py', 'managed_transcribe.py', 'torch_speech.py', 'torch_reference.py', 'torch_transcribe.py', 'torch_audio_common.py', 'sing.py', 'prepare_models.py', 'proxy_env.py', 'managed_audio_common.py', 'common.py', 'handler.py', 'inference.py'];
const ERROR_TYPES = ['Error', 'AbortError', 'TypeError', 'RangeError', 'SyntaxError', 'StudioError', 'DOMException', 'NotAllowedError', 'NotSupportedError', 'NotReadableError'];
const PANEL_STAGES = { uploadSingingReference: '上传演唱参考', deleteSingingReference: '删除演唱参考', singingReferenceAudio: '试听演唱参考', defaultReferenceAudio: '试听默认音色', referenceAudio: '试听参考音频', previewReference: '试听参考音频', jobAudio: '读取作品音频', savePreferences: '保存试听设置', saveSingingPreferences: '保存演唱设置', selectReference: '切换参考音色', useDefaultVoice: '恢复默认音色', uploadReference: '上传参考音频', setSingingEnabled: '切换唱歌功能', reference: '试听参考音频', speech: '试听语音', song: '试听歌曲' };
const limitNumber = (value, low, high) => Number.isFinite(value) ? Math.max(low, Math.min(high, Math.floor(value))) : undefined;
const safeVersion = v => typeof v === 'string' && /^\d{1,3}\.\d{1,3}\.\d{1,3}(?:-[A-Za-z]{1,12}\.\d{1,5})?$/.test(v) ? v : 'unknown';
const safeJob = id => typeof id === 'string' && JOB_ID.test(id) ? id : undefined;
const codeOf = value => typeof value === 'string' && Object.hasOwn(CATALOG, value) ? value : undefined;
const safeSetupStep = value => typeof value === 'string' && Object.hasOwn(SETUP_STEPS, value) ? value : undefined;
const DETAIL_PATTERN = new RegExp(`^(?:exception=(?:${EXCEPTIONS.join('|')})|errno=(?:EACCES|EPERM|ENOENT|ENOSPC|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|ENOMEM|EIO)|http=[45]\\d{2}|curl=\\d{1,2}|exit=-?\\d{1,3}|signal=SIG(?:TERM|KILL|ABRT|SEGV|BUS)|media=[1-4]|module=(?:${MODULES.join('|')})|frame=(?:${RUNTIME_FILES.map(name => name.replaceAll('.', '\\.')).join('|')}):\\d{1,5})$`);
const safeDetails = value => Array.isArray(value) ? [...new Set(value.filter(item => typeof item === 'string' && (DETAIL_PATTERN.test(item) || safeContextDetail(item))))].slice(0, 32) : [];
function safeDiagnostic(value) {
  let code = codeOf(value?.code);
  if (!code) return undefined;
  const details = safeDetails(value.details);
  if (['UNKNOWN', 'PYTHON_EXCEPTION'].includes(code)) code = systemFailureCode(details) ?? code;
  return { code, message: CATALOG[code][0], advice: CATALOG[code][1], details,
    errorType: EXCEPTIONS.includes(value.errorType) || ERROR_TYPES.includes(value.errorType) ? value.errorType : 'Error',
    ...(safeSetupStep(value.setupStep) ? { setupStep: value.setupStep } : {}),
    ...(code === 'UNKNOWN' && typeof value.fingerprint === 'string' && /^[a-f0-9]{20}$/.test(value.fingerprint) ? { fingerprint: value.fingerprint } : {}) };
}

// Python prints the handled exception first and the unhandled exception last.
// Keep each traceback separate: an expected cache miss during first setup must
// not replace the download failure that happened while handling that miss.
function exceptionChain(text) {
  return text.split(/\n\s*(?:During handling of the above exception, another exception occurred:|The above exception was the direct cause of the following exception:)\s*\n/).filter(part => part.trim());
}
function exceptionNames(text) {
  const pattern = new RegExp(`^(?:[A-Za-z_]\\w*\\.)*(${EXCEPTIONS.join('|')})(?::|\\s*$)`, 'gm');
  const names = [...text.matchAll(pattern)].map(match => match[1]);
  return [...new Set(names.reverse().filter(name => EXCEPTIONS.includes(name)))];
}
function inputText(error) {
  let result = '', next = error;
  for (let i = 0; i < 3 && next; i++) {
    if (typeof next === 'string') { result += '\n' + next.slice(-TAIL_BYTES); break; }
    if (typeof next.message === 'string') result += '\n' + next.message.slice(-TAIL_BYTES);
    if (typeof next.code === 'string') result += '\n' + next.code.slice(0, 100);
    next = next.cause;
  }
  return result.slice(-TAIL_BYTES);
}
function signatureDetails(text, result) {
  const details = [];
  for (const name of exceptionNames(text)) details.push(`exception=${name}`);
  details.push(...runtimeContextDetails(text, EXCEPTIONS), ...numericSystemDetails(text), ...processContextDetails(result));
  const errno = text.match(new RegExp(`\\b(${[...SYSTEM_ERRNOS].join('|')})\\b`));
  if (errno) details.push(`errno=${errno[1]}`);
  if (SYSTEM_ERRNOS.has(result?.errorCode) && !details.includes(`errno=${result.errorCode}`)) details.push(`errno=${result.errorCode}`);
  const http = [...text.matchAll(/(?:HTTP(?:Error)?(?:\/\d(?:\.\d)?)?(?:\s+Error)?\s*:?\s*|status(?:\s+code)?\s*[:=]?\s*|returned error:\s*)([45]\d{2})\b|\b([45]\d{2})\s+(?:Client|Server)\s+Error\b/gi)].at(-1);
  if (http) details.push(`http=${http[1] ?? http[2]}`);
  const curl = text.match(/curl:\s*\((\d{1,2})\)/); if (curl) details.push(`curl=${Number(curl[1])}`);
  for (const name of MODULES) if (new RegExp(`(?:No module named\\s+['"]|ModuleNotFoundError[^\\n]*['"])${name}(?:[.'"])`).test(text)) details.push(`module=${name}`);
  for (const name of RUNTIME_FILES) {
    const match = [...text.matchAll(new RegExp(`${name.replaceAll('.', '\\.')}["']?,?\\s+line\\s+(\\d{1,5})\\b`, 'g'))].at(-1);
    if (match) details.push(`frame=${name}:${Number(match[1])}`);
  }
  if (Number.isInteger(result?.code) && result.code >= -255 && result.code <= 255) details.push(`exit=${result.code}`);
  if (['SIGTERM', 'SIGKILL', 'SIGABRT', 'SIGSEGV', 'SIGBUS'].includes(result?.signal)) details.push(`signal=${result.signal}`);
  if (Number.isInteger(result?.mediaErrorCode) && result.mediaErrorCode >= 1 && result.mediaErrorCode <= 4) details.push(`media=${result.mediaErrorCode}`);
  return safeDetails(details);
}

// Free-form messages are used ONLY to classify a signature. They are never stored
// or returned: a regex-only "redactor" cannot reliably remove private speech.
export function diagnose(error, result, fingerprintKey = SESSION_FINGERPRINT_KEY) {
  const structured = safeDiagnostic(error?.diagnostic);
  const setupStep = safeSetupStep(error?.setupStep) ?? safeSetupStep(error?.diagnostic?.setupStep);
  if (structured) {
    const stopped = result?.terminationFailed || error?.terminationFailed;
    const details = safeDetails([...processContextDetails(error, result), ...signatureDetails('', result), ...structured.details]);
    const code = stopped ? 'PROCESS_TERMINATION_FAILED' : ['UNKNOWN', 'PYTHON_EXCEPTION', 'RESOURCE_BUSY'].includes(structured.code) ? systemFailureCode(details) ?? structured.code : structured.code;
    return { ...structured, code, message: CATALOG[code][0], advice: CATALOG[code][1], ...(setupStep ? { setupStep } : {}), details,
      ...(code !== 'UNKNOWN' ? { fingerprint: undefined } : {}) };
  }
  const text = inputText(error) + (SYSTEM_ERRNOS.has(result?.errorCode) ? '\n' + result.errorCode : '');
  const chain = exceptionChain(text), terminal = chain.at(-1) ?? text;
  let details = safeDetails([...signatureDetails(terminal, result), ...processContextDetails(error)]), inferred = classifyText(terminal, details);
  const terminalType = exceptionNames(terminal)[0];
  // HF/transport wrappers can hide a concrete network cause. Only consult the
  // adjacent causal traceback for these wrappers, never an earlier cache check.
  if (['LocalEntryNotFoundError', 'MaxRetryError', 'ConnectionError', 'RuntimeError', 'OSError'].includes(terminalType) && ['MODEL_CACHE_MISSING', 'NETWORK_FAILED', 'PYTHON_EXCEPTION'].includes(inferred)) {
    for (let i = chain.length - 2; i >= 0; i--) {
      const causeDetails = signatureDetails(chain[i]), cause = classifyText(chain[i], causeDetails);
      if (['MODEL_CACHE_MISSING', 'MODEL_INCOMPLETE', 'FILE_MISSING'].includes(cause)) break;
      if (['NETWORK_TIMEOUT', 'NETWORK_FAILED', 'PROXY_FAILED', 'PROXY_CONFIG', 'DNS_FAILED', 'TLS_FAILED', 'HTTP_ERROR', 'CONNECTION_REFUSED'].includes(cause)) {
        inferred = cause; details = safeDetails([...details, ...causeDetails]); break;
      }
      if (cause !== 'PYTHON_EXCEPTION') break;
    }
  }
  const code = result?.terminationFailed || error?.terminationFailed ? 'PROCESS_TERMINATION_FAILED' : codeOf(error?.code) ?? (result?.timedOut ? 'PROCESS_TIMEOUT' : result?.cancelled ? 'USER_CANCELLED' : result?.spawnError && !result.errorCode ? 'PROCESS_START_FAILED' : inferred !== 'UNKNOWN' ? inferred : result?.spawnError ? 'PROCESS_START_FAILED' : Number.isInteger(result?.code) && result.code !== 0 ? 'PROCESS_EXIT' : 'UNKNOWN');
  const errorName = error?.name ?? result?.errorName;
  const runtimeType = details.find(detail => detail.startsWith('exception='))?.slice('exception='.length);
  const errorType = terminalType ?? runtimeType ?? (ERROR_TYPES.includes(errorName) ? errorName : 'Error');
  // Keyed fingerprints distinguish repeated unknown failures without exposing a
  // reversible digest of short/private utterances. The key never leaves this store.
  const fingerprint = createHmac('sha256', fingerprintKey).update(JSON.stringify({ text, errorType, details })).digest('hex').slice(0, 20);
  return { code, message: CATALOG[code][0], advice: CATALOG[code][1], details, errorType, ...(setupStep ? { setupStep } : {}), ...(code === 'UNKNOWN' ? { fingerprint } : {}) };
}

function classifyText(text, details) {
  if (/无法确认后台程序已停止|后台程序(?:未能|尚未确认)停止/.test(text)) return 'PROCESS_TERMINATION_FAILED';
  if (/\bCUDA_ACCELERATION_UNAVAILABLE\b|显卡运行环境尚未就绪/.test(text)) return 'CUDA_ACCELERATION_UNAVAILABLE';
  const downloadCode = text.match(/\b(MODEL_SOURCE_(?:NETWORK|HTTP)|MODEL_DOWNLOAD_(?:PROTOCOL|CHECKSUM|MANIFEST|PATH))\b/)?.[1];
  if (downloadCode) return downloadCode;
  const systemCode = systemFailureCode(details);
  if (systemCode) return systemCode;
  const exact = Object.entries(CATALOG).find(([, value]) => value[0] === text.trim());
  if (exact) return exact[0];
  if (text.trim() === '模型下载连接中断或无法建立') return 'NETWORK_FAILED';
  if (/ENOSPC|No space left|磁盘空间不足/i.test(text)) return 'DISK_FULL';
  if (/ENOMEM|out of memory|MemoryError|\bOOM\b|内存不足/i.test(text)) return 'MEMORY_EXHAUSTED';
  if (/EACCES|EPERM|PermissionError|\bPermissionDenied\b|permission denied|operation not permitted|权限|访问被拒绝/i.test(text)) return 'PERMISSION_DENIED';
  if (/InvalidURL|invalid (?:port|proxy)|NO_PROXY.*(?:invalid|malformed)/i.test(text)) return 'PROXY_CONFIG';
  if (/ProxyError|proxy connection failed|cannot connect to proxy/i.test(text)) return 'PROXY_FAILED';
  if (/certificate verify failed|SSL certificate|SSLError|CERTIFICATE_VERIFY_FAILED|curl:\s*\(60\)/i.test(text)) return 'TLS_FAILED';
  if (/\bENOTFOUND\b|could not resolve host|name or service not known|nodename nor servname|NameResolutionError|temporary failure in name resolution|failed to lookup address information|curl:\s*\(6\)/i.test(text)) return 'DNS_FAILED';
  if (/ECONNREFUSED|connection refused|curl:\s*\(7\)/i.test(text)) return 'CONNECTION_REFUSED';
  if (/ETIMEDOUT|ReadTimeout|ConnectTimeout|WriteTimeout|PoolTimeout|TimeoutException|connection timed out|operation timed out|curl:\s*\(28\)|下载超时|准备超时/i.test(text)) return 'NETWORK_TIMEOUT';
  if (details.some(x => x.startsWith('http=')) || /HfHubHTTPError|HTTPStatusError|GatedRepoError|RepositoryNotFoundError|RevisionNotFoundError|RemoteEntryNotFoundError/.test(text)) return 'HTTP_ERROR';
  if (/ConnectError|ReadError|WriteError|NetworkError|ConnectionError|MaxRetryError|RemoteProtocolError|ProtocolError|connection reset|network is unreachable|server disconnected|error sending request for url|curl:\s*\((?:18|52|55|56)\)/i.test(text)) return 'NETWORK_FAILED';
  if (/ModuleNotFoundError|ImportError|No module named|依赖缺失/i.test(text)) return 'DEPENDENCY_MISSING';
  if (/checksum|hash mismatch|SHA256 mismatch|SafetensorError|HeaderTooLarge|模型.*(?:不完整|未下载完整|尚未下载完整|类型不匹配|索引无效|版本尚未验证|清单为空)|校验失败/i.test(text)) return 'MODEL_INCOMPLETE';
  if (/LocalEntryNotFoundError|CachedRepoTreeNotFoundError|OfflineModeIsEnabled|没有已验证的本机模型清单|cannot find.*(?:cached|local cache)/i.test(text)) return 'MODEL_CACHE_MISSING';
  if (/ENOENT|FileNotFoundError|No such file|文件不存在|组件缺失/i.test(text)) return 'FILE_MISSING';
  if (/Metal.*(?:unavailable|not supported)|MPS.*(?:not available|not built)|unsupported.*(?:platform|architecture)/i.test(text)) return 'METAL_UNAVAILABLE';
  if (/未识别到|empty transcript|no speech/i.test(text)) return 'EMPTY_TRANSCRIPT';
  if (/invalid audio|invalid data found|音频.*(?:无效|格式)|录音应为|时长|20\s*MB/i.test(text)) return 'AUDIO_INVALID';
  if (/超时|TimeoutError|timed out/i.test(text)) return 'PROCESS_TIMEOUT';
  if (/无法启动|spawn/i.test(text)) return 'PROCESS_START_FAILED';
  if (/已取消|cancelled|canceled/i.test(text)) return 'USER_CANCELLED';
  if (/队列已满/i.test(text)) return 'QUEUE_FULL';
  return details.some(x => x.startsWith('exception=')) ? 'PYTHON_EXCEPTION' : 'UNKNOWN';
}

function safeStage(text) {
  if (typeof text !== 'string') return undefined;
  if (Object.hasOwn(PANEL_STAGES, text)) return PANEL_STAGES[text];
  if (Object.values(PANEL_STAGES).includes(text)) return text;
  if (/切换下载线路/.test(text)) return '正在切换下载线路';
  if (/下载.*(?:环境|运行)|runtime/i.test(text)) return '下载运行环境';
  if (/下载|download/i.test(text)) return '下载文件';
  if (/校验|verify|检查完整/i.test(text)) return '校验组件';
  if (/依赖|环境|packages|python/i.test(text)) return '准备运行环境';
  if (/识别|转写|transcrib/i.test(text)) return '语音识别';
  if (/合成|generating.*speech/i.test(text)) return '合成语音';
  if (/参考|reference/i.test(text)) return '处理参考音频';
  if (/作曲|演唱|唱歌|song|singing/i.test(text)) return '生成歌曲';
  if (/模型|model/i.test(text)) return '准备模型';
  if (/导出|export/i.test(text)) return '导出音频';
  return undefined;
}
function safeEntry(event, now = new Date().toISOString(), fingerprintKey) {
  const diagnostic = diagnose(event.error ?? event.message, event.result, fingerprintKey);
  const code = codeOf(event.code) ?? diagnostic.code;
  const causeCode = diagnostic.code !== 'UNKNOWN' && diagnostic.code !== code ? diagnostic.code : undefined;
  const setupStep = safeSetupStep(event.setupStep) ?? diagnostic.setupStep;
  return {
    time: typeof event.time === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(event.time) ? event.time : now,
    level: LEVELS.has(event.level) ? event.level : 'error', area: AREAS.has(event.area) ? event.area : 'system',
    code, message: CATALOG[code][0], advice: CATALOG[causeCode ?? code][1],
    ...(causeCode ? { cause: { code: causeCode, message: CATALOG[causeCode][0] } } : {}),
    ...(safeStage(event.stage) ? { stage: safeStage(event.stage) } : {}),
    ...(setupStep ? { setupStep } : {}),
    ...(safeJob(event.jobId) ? { jobId: event.jobId } : {}),
    details: diagnostic.details,
    ...(event.error || event.result || event.level === 'error' || !codeOf(event.code) ? { errorType: diagnostic.errorType, ...(diagnostic.fingerprint ? { fingerprint: diagnostic.fingerprint } : {}) } : {}),
  };
}
function fromDisk(entry) {
  // Revalidate even our own file: never forward a hand-edited line verbatim.
  if (!entry || typeof entry !== 'object' || !codeOf(entry.code)) return null;
  const e = safeEntry({ ...entry, error: undefined, message: undefined });
  if (codeOf(entry.cause?.code)) { e.cause = { code: entry.cause.code, message: CATALOG[entry.cause.code][0] }; e.advice = CATALOG[entry.cause.code][1]; }
  if (typeof entry.fingerprint === 'string' && /^[a-f0-9]{20}$/.test(entry.fingerprint)) e.fingerprint = entry.fingerprint;
  else delete e.fingerprint;
  if (EXCEPTIONS.includes(entry.errorType) || ERROR_TYPES.includes(entry.errorType)) e.errorType = entry.errorType;
  else delete e.errorType;
  e.details = safeDetails(entry.details);
  // Existing reports may retain a native code even if an older classifier called
  // it UNKNOWN. Refine that saved evidence without asking for another raw log.
  const systemCode = systemFailureCode(e.details);
  if (systemCode && ['UNKNOWN', 'PYTHON_EXCEPTION'].includes(e.code)) {
    e.code = systemCode; e.message = CATALOG[systemCode][0]; e.advice = CATALOG[systemCode][1]; delete e.fingerprint;
  } else if (systemCode && ['SETUP_FAILED', 'JOB_FAILED'].includes(e.code) && (!e.cause || ['UNKNOWN', 'PYTHON_EXCEPTION'].includes(e.cause.code))) {
    e.cause = { code: systemCode, message: CATALOG[systemCode][0] }; e.advice = CATALOG[systemCode][1]; delete e.fingerprint;
  }
  return e;
}

function containedFile(root, name, maxBytes, tailBytes = maxBytes) {
  const path = resolve(root, name), rel = relative(root, path);
  if (!rel || rel.startsWith('..' + sep) || rel === '..' || isAbsolute(rel)) throw Error('Unsafe diagnostic path');
  let current = root;
  if (lstatSync(current).isSymbolicLink() || !lstatSync(current).isDirectory()) throw Error('Unsafe diagnostic root');
  for (const part of rel.split(sep)) { current = join(current, part); if (lstatSync(current).isSymbolicLink()) throw Error('Unsafe diagnostic path'); }
  if (realpathSync(path) !== join(realpathSync(root), rel)) throw Error('Unsafe diagnostic path');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW || 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes) throw Error('Invalid diagnostic file');
    const length = Math.min(stat.size, tailBytes), bytes = Buffer.alloc(length);
    const read = readSync(fd, bytes, 0, length, Math.max(0, stat.size - length));
    return { text: bytes.subarray(0, read).toString('utf8'), mtime: stat.mtimeMs };
  } finally { closeSync(fd); }
}

function safeProgress(value) {
  if (!value || typeof value !== 'object') return undefined;
  const phase = ['checking', 'connecting', 'downloading', 'validating', 'switching', 'installing', 'verifying'].includes(value.phase) ? value.phase : undefined;
  const completedBytes = limitNumber(value.completedBytes, 0, Number.MAX_SAFE_INTEGER);
  const totalBytes = limitNumber(value.totalBytes, 1, Number.MAX_SAFE_INTEGER);
  const elapsedSeconds = limitNumber(value.elapsedSeconds, 0, 7 * 24 * 60 * 60);
  return phase || completedBytes !== undefined || totalBytes !== undefined ? {
    ...(phase ? { phase } : {}), ...(completedBytes !== undefined ? { completedBytes } : {}),
    ...(totalBytes !== undefined ? { totalBytes } : {}), ...(elapsedSeconds !== undefined ? { elapsedSeconds } : {}),
  } : undefined;
}

export class DiagnosticLog {
  constructor({ root, version = 'unknown', now = () => new Date().toISOString() } = {}) {
    if (typeof root !== 'string' || !isAbsolute(root)) throw Error('Diagnostic root must be absolute');
    this.root = resolve(root); this.version = safeVersion(version); this.now = now;
    this.fingerprintKey = randomBytes(32).toString('hex');
    this.entries = []; this.storageAvailable = true;
    try {
      if (lstatSync(this.root).isSymbolicLink() || !lstatSync(this.root).isDirectory()) throw Error('Unsafe diagnostic root');
      this.directory = join(this.root, 'diagnostics');
      mkdirSync(this.directory, { mode: 0o700 });
    } catch (error) { if (error.code !== 'EEXIST') this.storageAvailable = false; }
    if (this.storageAvailable) {
      try { if (lstatSync(this.directory).isSymbolicLink() || !lstatSync(this.directory).isDirectory()) this.storageAvailable = false; }
      catch { this.storageAvailable = false; }
    }
    if (this.storageAvailable) this.rootIdentity = realpathSync(this.root);
    if (this.storageAvailable) {
      try {
        const stored = JSON.parse(containedFile(this.root, 'diagnostics/events.json', STORE_BYTES).text);
        if (stored.schema !== 1 || !Array.isArray(stored.entries)) throw Error('Invalid diagnostic store');
        if (typeof stored.fingerprintKey === 'string' && /^[a-f0-9]{64}$/.test(stored.fingerprintKey)) this.fingerprintKey = stored.fingerprintKey;
        this.entries = stored.entries.slice(-MAX_ENTRIES).map(fromDisk).filter(Boolean);
      } catch (error) { if (error.code !== 'ENOENT') this.storageAvailable = false; }
    }
  }
  persist() {
    if (!this.storageAvailable) return;
    let temporary;
    try {
      if (lstatSync(this.root).isSymbolicLink() || realpathSync(this.root) !== this.rootIdentity) throw Error('Unsafe diagnostic root');
      if (lstatSync(this.directory).isSymbolicLink() || !lstatSync(this.directory).isDirectory()) throw Error('Unsafe diagnostic directory');
      const target = join(this.directory, 'events.json');
      try { if (lstatSync(target).isSymbolicLink() || !lstatSync(target).isFile()) throw Error('Unsafe diagnostic store'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      let output = JSON.stringify({ schema: 1, fingerprintKey: this.fingerprintKey, entries: this.entries });
      while (Buffer.byteLength(output) > STORE_BYTES && this.entries.length) { this.entries.shift(); output = JSON.stringify({ schema: 1, fingerprintKey: this.fingerprintKey, entries: this.entries }); }
      temporary = join(this.directory, `${randomUUID()}.tmp`);
      writeFileSync(temporary, output, { flag: 'wx', mode: 0o600 }); renameSync(temporary, target);
    } catch { this.storageAvailable = false; if (temporary) { try { unlinkSync(temporary); } catch {} } }
  }
  record(event = {}) {
    const entry = safeEntry(event, this.now(), this.fingerprintKey);
    this.entries.push(entry); if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    this.persist(); return structuredClone(entry);
  }
  list({ level, limit = MAX_ENTRIES } = {}) {
    const entries = LEVELS.has(level) ? this.entries.filter(e => e.level === level) : this.entries;
    return structuredClone(entries.slice(-(limitNumber(limit, 1, MAX_ENTRIES) ?? MAX_ENTRIES)).reverse());
  }
  captureJob({ jobId, kind, result, error } = {}) {
    if (!safeJob(jobId) || !['speech', 'song', 'transcription', 'reference'].includes(kind)) return this.record({ level: 'warning', code: 'LOG_UNAVAILABLE' });
    let text = '', unavailable = false;
    try { text = containedFile(this.root, join(jobId, 'runner.log'), LOG_BYTES, TAIL_BYTES).text; }
    catch (failure) { unavailable = failure.code !== 'ENOENT'; }
    const inferred = diagnose(text, result);
    const entry = this.record({ level: 'error', area: kind, code: 'JOB_FAILED', jobId, result,
      error: inferred.code !== 'UNKNOWN' ? { code: inferred.code, message: text } : error });
    if (unavailable) this.record({ level: 'warning', area: kind, code: 'LOG_UNAVAILABLE', jobId });
    return entry;
  }
  captureSetup({ kind, error, since } = {}) {
    const area = ['speech', 'transcription', 'singing', 'reference'].includes(kind) ? kind : 'setup';
    const direct = diagnose(error);
    if (!['UNKNOWN', 'PYTHON_EXCEPTION', 'PROCESS_EXIT'].includes(direct.code)) {
      return this.record({ level: 'error', area, code: 'SETUP_FAILED', error });
    }
    const minimum = Number.isFinite(since) ? since : Date.now() - 10 * 60 * 1000;
    const logs = [];
    for (const name of SETUP_LOGS) {
      try { const log = containedFile(this.root, join('engine-v1', name), LOG_BYTES, TAIL_BYTES); if (log.mtime >= minimum) logs.push(log); }
      catch { /* Missing, unsafe or oversized logs never escape through the report. */ }
    }
    logs.sort((a, b) => b.mtime - a.mtime);
    // setup-error.log and its command log often contain the same traceback.
    // Diagnose each independently, newest first. Concatenating newest-to-oldest
    // and taking a tail can discard the actual failure in favour of stale text.
    const selected = logs.map(log => ({ ...log, diagnostic: diagnose(log.text) })).find(log => log.diagnostic.code !== 'UNKNOWN');
    // A log can refine the failure signature, but the current attempt owns the
    // preparation step; an older log must never discard that context.
    const diagnostic = selected ? { ...selected.diagnostic, details: safeDetails([...selected.diagnostic.details, ...direct.details]) } : direct;
    return this.record({ level: 'error', area, code: 'SETUP_FAILED', setupStep: direct.setupStep, error: { diagnostic } });
  }
  savedSetupEvidence(kind, source, lastFailure, lastStart) {
    // Upgrade an older terse report from the logs already on this computer.
    // Never require the user to locate them, and never attach their raw text.
    const failedAt = Number.isFinite(source.failedAt) ? source.failedAt : Date.parse(lastFailure?.time);
    const startedAt = Date.parse(lastStart?.time);
    if (!Number.isFinite(failedAt) || !Number.isFinite(startedAt) || startedAt > failedAt || (source.setupStep ?? lastFailure?.setupStep) !== 'model') return undefined;
    const component = ['asr', 'reference', 'singing'].includes(source.component) ? source.component : ({ transcription: 'asr', speech: 'reference', reference: 'reference', singing: 'singing' })[kind];
    // The generic setup-error.log is shared across components. Only a model's
    // own log within this exact preparation attempt can refine an old report.
    const names = component ? [`setup-model-${component}.log`] : [];
    for (const name of names) {
      try {
        const log = containedFile(this.root, join('engine-v1', name), LOG_BYTES, TAIL_BYTES);
        if (log.mtime < startedAt || log.mtime > failedAt + 2000) continue;
        const evidence = diagnose(log.text);
        if (evidence.details.some(detail => /^(?:errnoNumber|winerror|ntstatus|trace|operation)=/.test(detail))) return evidence;
      } catch { /* Old reports remain available even if a raw log is gone. */ }
    }
    return undefined;
  }
  captureReference({ referenceId, result, error } = {}) {
    if (typeof referenceId !== 'string' || !REFERENCE_ID.test(referenceId)) return this.record({ level: 'warning', area: 'reference', code: 'LOG_UNAVAILABLE' });
    let text = '', unavailable = false;
    try { text = containedFile(this.root, join('references', referenceId, 'runner.log'), LOG_BYTES, TAIL_BYTES).text; }
    catch (failure) { unavailable = failure.code !== 'ENOENT'; }
    const inferred = diagnose(text, result);
    const entry = this.record({ level: 'error', area: 'reference', code: 'JOB_FAILED', result,
      error: inferred.code !== 'UNKNOWN' ? { code: inferred.code, message: text } : error });
    if (unavailable) this.record({ level: 'warning', area: 'reference', code: 'LOG_UNAVAILABLE' });
    return entry;
  }
  report(snapshot = {}) {
    const timestamp = this.now(), engine = snapshot.engine ?? {}, qq = snapshot.qq ?? {}, rawJobs = Array.isArray(snapshot.jobs) ? snapshot.jobs.slice(-500) : [];
    const stopFailure = snapshot.stopFailure === null ? null : snapshot.stopFailure && typeof snapshot.stopFailure === 'object'
      ? safeDiagnostic({ code: 'PROCESS_TERMINATION_FAILED', details: processContextDetails(snapshot.stopFailure) }) : undefined;
    const entries = this.list({ limit: 200 });
    const models = Object.fromEntries(Object.entries(MODEL_NAMES).map(([kind, name]) => {
      const source = engine[kind] ?? {};
      if (snapshot.device?.speechBackend === 'torch' && ['transcription', 'speech'].includes(kind)) name = name.replace(/-8bit$/, '');
      let error, setupStep = safeSetupStep(source.setupStep) ?? safeSetupStep(source.progress?.setupStep);
      if (source.state === 'failed') {
        error = safeDiagnostic({ code: source.errorCode, details: source.errorDetails, errorType: source.errorType, setupStep }) ?? diagnose(source.error, undefined, this.fingerprintKey);
        setupStep ??= error.setupStep;
        // Use the latest event in this component's preparation cycle only.
        // A new attempt or a successful/cancelled cycle must hide old causes.
        const lastSetup = entries.find(entry => entry.area === kind && ['SETUP_STARTED', 'SETUP_READY', 'SETUP_FAILED', 'SETUP_CANCELLED'].includes(entry.code));
        const lastFailure = lastSetup?.code === 'SETUP_FAILED' ? lastSetup : undefined;
        if (['UNKNOWN', 'PYTHON_EXCEPTION'].includes(error.code)) {
          if (lastFailure?.cause && (!setupStep || !lastFailure.setupStep || setupStep === lastFailure.setupStep)) error = safeDiagnostic({ ...lastFailure.cause, details: lastFailure.details, errorType: lastFailure.errorType, setupStep: setupStep ?? lastFailure.setupStep }) ?? error;
          if (lastFailure && ['UNKNOWN', 'PYTHON_EXCEPTION'].includes(error.code)) {
            const lastStart = entries.find(entry => entry.area === kind && entry.code === 'SETUP_STARTED' && entry.time <= lastFailure.time);
            const evidence = this.savedSetupEvidence(kind, source, lastFailure, lastStart);
            if (evidence) error = { ...evidence, details: safeDetails([...evidence.details, ...error.details]), ...(setupStep ? { setupStep } : {}) };
          }
        }
        if (!setupStep && lastFailure && (!lastFailure.cause || lastFailure.cause.code === error.code)) setupStep = lastFailure.setupStep;
        if (setupStep) error = { ...error, setupStep };
      }
      const progress = safeProgress(source.state === 'failed' ? source.failureProgress : source.progress);
      const downloadSource = DOWNLOAD_SOURCES.has(source.source) ? source.source : DOWNLOAD_SOURCES.has(source.progress?.source) ? source.progress.source : DOWNLOAD_SOURCES.has(source.failureProgress?.source) ? source.failureProgress.source : undefined;
      const reason = source.fallbackReason ?? source.progress?.fallbackReason;
      const fallbackReason = downloadSource === 'overseas' && FALLBACK_CODES.has(reason) ? reason : undefined;
      const failedAt = source.state === 'failed' && Number.isSafeInteger(source.failedAt) && source.failedAt > 0 && source.failedAt < 253402300800000 ? new Date(source.failedAt).toISOString() : undefined;
      return [kind, { name, ...(fallbackReason ? { fallbackReason } : {}), ...(downloadSource ? { source: downloadSource } : {}), ...(progress ? { progress } : {}), state: STATES.has(source.state) ? source.state : 'unknown', ...(failedAt ? { failedAt } : {}), ...(setupStep ? { setupStep } : {}), ...(safeStage(source.stage) ? { stage: safeStage(source.stage) } : {}), ...(error ? { error } : {}) }];
    }));
    const jobCounts = {};
    for (const job of rawJobs) if (['speech', 'song', 'transcription'].includes(job?.kind) && STATES.has(job.status)) { const key = `${job.kind}.${job.status}`; jobCounts[key] = (jobCounts[key] ?? 0) + 1; }
    const failures = rawJobs.filter(j => j?.status === 'failed').slice(0, 10).map(j => ({ kind: AREAS.has(j.kind) ? j.kind : 'system', ...(safeJob(j.id) ? { jobId: j.id } : {}), ...diagnose(j.error, undefined, this.fingerprintKey) }));
    const summary = {
      version: safeVersion(snapshot.version ?? this.version), platform: platform(), arch: arch(), osRelease: release().match(/^\d+(?:\.\d+){0,3}/)?.[0] ?? 'unknown', node: process.versions.node,
      running: snapshot.running === true, singingEnabled: snapshot.singingEnabled === true, voiceMode: snapshot.voice?.mode === 'reference' ? 'reference' : 'default',
      queued: limitNumber(snapshot.queued, 0, 100) ?? 0, qq: { status: ['connected', 'disconnected', 'disabled', 'missing', 'unknown'].includes(qq.status) ? qq.status : 'unknown', version: safeVersion(qq.version) },
      downloadPolicy: 'automatic', reportSchema: 2,
      ...(stopFailure !== undefined ? { stopFailure } : {}),
      ...(['mac-arm64', 'mac-x64', 'windows-x64', 'windows-cuda'].includes(snapshot.device?.runtimeProfile) ? { runtimeProfile: snapshot.device.runtimeProfile } : {}),
      models, jobCounts, failures, storageAvailable: this.storageAvailable,
    };
    const lines = ['大肥鱼语音助手 · 诊断报告', `生成时间：${timestamp}`, `插件：${summary.version} | ${summary.platform} ${summary.arch} | 系统：${summary.osRelease} | Node：${summary.node}`,
      `助手运行：${summary.running ? '是' : '否'} | 排队：${summary.queued} | 唱歌：${summary.singingEnabled ? '开启' : '关闭'} | 说话音色：${summary.voiceMode === 'reference' ? '参考音色' : '默认音色'}`,
      `QQ：${summary.qq.status} | 版本：${summary.qq.version}`, '模型下载：优先国内，失败后自动尝试国外', '', '模型状态'];
    if (summary.runtimeProfile) lines.splice(3, 0, `模型运行方式：${summary.runtimeProfile} | 诊断格式：${summary.reportSchema}`);
    if (stopFailure !== undefined) lines.splice(lines.indexOf('模型下载：优先国内，失败后自动尝试国外'), 0,
      `当前停止保护：${stopFailure ? '已触发，暂停新任务和清理' : '未触发'}`,
      ...(stopFailure?.details.length ? [`停止保护详情：${stopFailure.details.join(', ')}`] : []));
    for (const [kind, model] of Object.entries(models)) {
      lines.push(`${kind}: ${model.name} | ${model.state}${model.source ? ` | 下载来源：${sourceLabel(model.source)}` : ''}${model.fallbackReason ? ` | 国内失败原因：${model.fallbackReason}` : ''}${model.setupStep ? ` | 准备环节：${SETUP_STEPS[model.setupStep]}` : ''}${model.stage ? ` | ${model.stage}` : ''}${model.error ? ` | ${model.error.code}: ${model.error.message}` : ''}`);
      if (model.progress) lines.push(`准备进度：${model.progress.phase ?? 'unknown'}${model.progress.completedBytes !== undefined ? ` | 已完成字节：${model.progress.completedBytes}` : ''}${model.progress.totalBytes !== undefined ? ` | 总字节：${model.progress.totalBytes}` : ''}${model.progress.elapsedSeconds !== undefined ? ` | 耗时秒：${model.progress.elapsedSeconds}` : ''}`);
      if (model.failedAt) lines.push(`失败时间：${model.failedAt}`);
      if (model.error?.details.length) lines.push(`错误详情：${model.error.details.join(', ')}`);
    }
    lines.push('', '任务统计', ...Object.entries(jobCounts).map(([key, value]) => `${key}: ${value}`));
    if (!Object.keys(jobCounts).length) lines.push('暂无任务');
    if (failures.length) { lines.push('', '近期失败任务'); for (const f of failures) lines.push(`${f.kind}${f.jobId ? ` ${f.jobId}` : ''} | ${f.code}: ${f.message}`, ...(f.fingerprint ? [`错误类型：${f.errorType} | 指纹：${f.fingerprint}`] : []), `建议：${f.advice}`); }
    lines.push('', '诊断记录（最新在前）');
    if (!entries.length) lines.push('暂无诊断记录');
    for (const entry of entries) lines.push(`${entry.time} [${entry.level}] ${entry.area} | ${entry.code}: ${entry.message}${entry.jobId ? ` | 任务 ${entry.jobId}` : ''}${entry.setupStep ? ` | 准备环节：${SETUP_STEPS[entry.setupStep]}` : ''}${entry.stage ? ` | ${entry.stage}` : ''}`,
      ...(entry.cause ? [`原因：${entry.cause.code}: ${entry.cause.message}`] : []), ...(entry.details.length ? [`特征：${entry.details.join(', ')}`] : []), ...(entry.fingerprint ? [`错误类型：${entry.errorType ?? 'Error'} | 指纹：${entry.fingerprint}`] : []), `建议：${entry.advice}`);
    if (!this.storageAvailable) lines.push('', '诊断文件不可用；本次仅显示内存中的安全记录。');
    lines.push('', '仅含运行状态和错误特征，不含聊天内容、QQ 账号、参考录音、逐字稿、密钥或个人文件路径。');
    return { generatedAt: timestamp, text: lines.join('\n'), summary, entries };
  }
}

export const createDiagnosticLog = (root, options = {}) => new DiagnosticLog({ root, ...options });

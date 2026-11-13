// Structured support facts only. Never export raw stderr, command arguments,
// filenames supplied by a user, proxy URLs, or arbitrary exception messages.
export const OPERATIONS = new Set('manifest_read manifest_validate path_validate windows_api_load win32_open_root nt_open_directory nt_open_file win32_file_info win32_file_type crt_open_handle win32_rename nt_rename win32_delete win32_close open_model_directory check_file open_partial read_file seek_file write_file flush_file sync_file verify_file rename_file connect read_response validate_response progress_emit cleanup download_models'.split(' '));
const FUNCTIONS = new Set('download_models model_manifest _download_file _verified _digests _request _response redirect_request __init__ __enter__ __exit__ validate_root anchor _relative_handle _checked directory file info open parent replace unlink close release fail phase update fallback details main validate_model write_marker safetensors_complete tokenizer_complete'.split(' '));
const FILES = new Set(['model_download.py', 'prepare_models.py']);
const PHASES = new Set(['checking', 'connecting', 'downloading', 'validating', 'switching']);
const SIGNALS = new Set('SIGHUP SIGINT SIGQUIT SIGABRT SIGKILL SIGSEGV SIGPIPE SIGALRM SIGTERM SIGBUS'.split(' '));
const STOP_ERRORS = new Set('EACCES EPERM ESRCH ENOENT EINVAL EIO ENOMEM ENOSPC ENOSYS EAGAIN EMFILE ENFILE INVALID_PROCESS_ID WINDOWS_SYSTEMROOT_MISSING TASKKILL_START_FAILED TASKKILL_NONZERO_EXIT TASKKILL_TIMEOUT PROCESS_SIGNAL_FAILED PROCESS_EXIT_NOT_CONFIRMED PROCESS_TERMINATION_ERROR REFERENCE_KILL_FAILED REFERENCE_KILL_TIMEOUT PROCESS_TERMINATION_FAILED'.split(' '));
for (const code of ['WINDOWS_JOB_START_FAILED', 'WINDOWS_JOB_STOP_FAILED', 'WINDOWS_JOB_UNCONFIRMED', 'WINDOWS_JOB_TIMEOUT', 'WINDOWS_JOB_PROTOCOL_INVALID']) STOP_ERRORS.add(code);
const JOB_OPERATIONS = new Set('parse_spec open_stdio create_job configure_job create_process resume_process query_job terminate_job wait_job read_control supervisor'.split(' '));
export const SYSTEM_ERRNOS = new Set('EACCES EPERM ENOENT ENOSPC ETIMEDOUT ECONNREFUSED ENOTFOUND ENOMEM EIO EBUSY ETXTBSY EEXIST EISDIR ENOTDIR ENAMETOOLONG EINVAL EROFS ENOTSUP ENOSYS EMFILE ENFILE EBADF ENODEV ENXIO EPIPE ECONNRESET ECONNABORTED ENETUNREACH EHOSTUNREACH EAGAIN ECANCELED'.split(' '));
const FILE_SYSCALLS = new Set('open read write rename unlink rmdir mkdir stat lstat realpath access chmod close fstat fsync fdatasync copyfile scandir truncate ftruncate link symlink readlink'.split(' '));
// read/write/close can name a pipe operation too; only a path-oriented call or
// an explicit internal file role establishes that a busy resource is a file.
const FILE_PATH_SYSCALLS = new Set('open rename unlink rmdir mkdir stat lstat realpath access chmod copyfile scandir truncate link symlink readlink'.split(' '));
const NODE_SYSCALLS = new Set([...FILE_SYSCALLS, 'spawn', 'kill', 'uv_pipe_open', 'connect', 'getaddrinfo']);
const FILE_ROLES = new Set('setup-log setup-error-log engine-state diagnostic-store setup-preferences model-file runtime-file'.split(' '));
const integer = (value, low, high) => Number.isInteger(value) && value >= low && value <= high;
const INT_MIN = -2147483648, UINT_MAX = 4294967295;
const version = value => typeof value === 'string' && /^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value);

export function safeContextDetail(detail) {
  if (typeof detail !== 'string' || detail.length > 160) return false;
  const [name, value, extra] = detail.split('=');
  if (extra !== undefined || value === undefined) return false;
  if (['errnoNumber', 'winerror', 'terminationExitCode'].includes(name)) {
    return /^-?(?:0|[1-9]\d{0,9})$/.test(value) && integer(Number(value), name === 'winerror' ? 0 : INT_MIN, name === 'errnoNumber' ? 2147483647 : UINT_MAX);
  }
  if (name === 'ntstatus') return /^0x[0-9A-F]{8}$/.test(value);
  if (name === 'errno') return SYSTEM_ERRNOS.has(value);
  if (name === 'syscall') return NODE_SYSCALLS.has(value);
  if (name === 'fileRole') return FILE_ROLES.has(value);
  if (name === 'operation') return OPERATIONS.has(value);
  if (name === 'phase') return PHASES.has(value);
  if (name === 'python') return version(value);
  if (name === 'terminationMethod') return ['taskkill', 'process-group', 'process', 'windows-job'].includes(value);
  if (name === 'terminationOperation') return JOB_OPERATIONS.has(value);
  if (name === 'terminationStage') return ['start', 'execute', 'confirm-exit'].includes(value);
  if (name === 'terminationErrorCode') return STOP_ERRORS.has(value);
  if (name === 'terminationSignal') return SIGNALS.has(value);
  if (name === 'trace') {
    const [file, line, fn, trailing] = value.split(':');
    return trailing === undefined && FILES.has(file) && /^[1-9]\d{0,5}$/.test(line ?? '') && FUNCTIONS.has(fn);
  }
  return false;
}

export function processContextDetails(...sources) {
  const details = [];
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    const systemCode = SYSTEM_ERRNOS.has(source.code) ? source.code : SYSTEM_ERRNOS.has(source.errorCode) ? source.errorCode : undefined;
    if (systemCode) details.push(`errno=${systemCode}`);
    for (const key of ['syscall', 'fileRole']) {
      if (typeof source[key] === 'string' && safeContextDetail(`${key}=${source[key]}`)) details.push(`${key}=${source[key]}`);
    }
    for (const key of ['terminationMethod', 'terminationStage', 'terminationErrorCode', 'terminationExitCode', 'terminationSignal', 'terminationOperation']) {
      const value = source[key];
      if ((typeof value === 'string' || typeof value === 'number') && safeContextDetail(`${key}=${value}`)) details.push(`${key}=${value}`);
    }
    if (integer(source.errno, INT_MIN, 2147483647)) details.push(`errnoNumber=${source.errno}`);
    if (integer(source.winerror, 0, UINT_MAX)) details.push(`winerror=${source.winerror}`);
  }
  return [...new Set(details)];
}

export function runtimeContextDetails(text, exceptionNames) {
  // A bounded JSON record is emitted before Python sanitizes/rethrows. Select
  // the final primary failure; cleanup errors cannot replace its actual cause.
  let record;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('STUDIO_DIAGNOSTIC ') || line.length > 8192) continue;
    try {
      const candidate = JSON.parse(line.slice('STUDIO_DIAGNOSTIC '.length));
      if (candidate?.schema === 1 && candidate.secondary !== true && OPERATIONS.has(candidate.operation)) record = candidate;
    } catch { /* Truncated/foreign output is never forwarded as raw text. */ }
  }
  if (!record) return [];
  const details = processContextDetails(record);
  if (exceptionNames.includes(record.errorType)) details.push(`exception=${record.errorType}`);
  for (const [field, key] of [['ntstatus', 'ntstatus'], ['operation', 'operation'], ['phase', 'phase'], ['pythonVersion', 'python']]) {
    const value = record[field];
    if (typeof value === 'string' && safeContextDetail(`${key}=${value}`)) details.push(`${key}=${value}`);
  }
  for (const frame of (Array.isArray(record.frames) ? record.frames : []).slice(-8)) {
    if (typeof frame?.file !== 'string' || !Number.isInteger(frame.line) || typeof frame.function !== 'string') continue;
    const value = `trace=${frame.file}:${frame.line}:${frame.function}`;
    if (safeContextDetail(value)) details.push(value);
  }
  return details;
}

export function numericSystemDetails(text) {
  const details = [];
  for (const [pattern, key, low, high] of [
    [/\[Errno (-?\d{1,10})\]/g, 'errnoNumber', INT_MIN, 2147483647],
    [/\[WinError (\d{1,10})\]/g, 'winerror', 0, UINT_MAX],
  ]) {
    const value = [...text.matchAll(pattern)].at(-1)?.[1];
    if (value !== undefined && integer(Number(value), low, high)) details.push(`${key}=${Number(value)}`);
  }
  return details;
}

export function systemFailureCode(details) {
  const number = name => {
    const value = details.find(item => item.startsWith(name + '='))?.slice(name.length + 1);
    return value === undefined ? undefined : Number(value);
  };
  const winerror = number('winerror'), errno = number('errnoNumber');
  // Native Windows codes take precedence over their lossy errno mapping.
  if ([32, 33].includes(winerror)) return 'FILE_IN_USE';
  if ([5, 1314].includes(winerror)) return 'PERMISSION_DENIED';
  if ([39, 112].includes(winerror)) return 'DISK_FULL';
  if ([8, 14, 1455].includes(winerror)) return 'MEMORY_EXHAUSTED';
  if ([2, 3].includes(winerror)) return 'FILE_MISSING';
  if (winerror === 206) return 'PATH_TOO_LONG';
  if ([87, 123, 161].includes(winerror)) return 'FILE_OPERATION_INVALID';
  if ([1, 50].includes(winerror)) return 'FILESYSTEM_UNSUPPORTED';
  const systemCode = details.find(item => item.startsWith('errno='))?.slice('errno='.length);
  // libuv uses a platform-independent fallback number on Windows. In particular,
  // UV_EBUSY (-4082) can mean a sharing/lock violation OR a busy pipe; do not label
  // the resource as a model file without a known filesystem call or file role.
  // https://github.com/libuv/libuv/blob/v1.51.0/include/uv/errno.h
  if (['EBUSY', 'ETXTBSY'].includes(systemCode) || errno === -4082) {
    return details.some(item => item.startsWith('fileRole=') || item.startsWith('syscall=') && FILE_PATH_SYSCALLS.has(item.slice('syscall='.length))) ? 'FILE_IN_USE' : 'RESOURCE_BUSY';
  }
  if (['EACCES', 'EPERM', 'EROFS'].includes(systemCode)) return 'PERMISSION_DENIED';
  if (systemCode === 'ENOSPC') return 'DISK_FULL';
  if (systemCode === 'ENOMEM') return 'MEMORY_EXHAUSTED';
  if (systemCode === 'ENOENT') return 'FILE_MISSING';
  if (systemCode === 'ENAMETOOLONG') return 'PATH_TOO_LONG';
  if (['EINVAL', 'EISDIR', 'ENOTDIR', 'EBADF'].includes(systemCode)) return 'FILE_OPERATION_INVALID';
  if (['ENOTSUP', 'ENOSYS'].includes(systemCode)) return 'FILESYSTEM_UNSUPPORTED';
  if (systemCode === 'EIO') return 'FILE_IO_FAILED';
  if ([1, 13].includes(errno)) return 'PERMISSION_DENIED';
  if (errno === 28) return 'DISK_FULL';
  if (errno === 12) return 'MEMORY_EXHAUSTED';
  if (errno === 2) return 'FILE_MISSING';
  if (errno === 22) return 'FILE_OPERATION_INVALID';
  if (errno === 5) return 'FILE_IO_FAILED';
  return undefined;
}

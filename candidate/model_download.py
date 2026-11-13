"""Verified domestic-first downloads for the bundled immutable model manifest.

No remote model listing, access token, or SDK cache layout is needed. An
automatic operation tries the domestic service, then the overseas service once
when the remote download fails. ModelScope and Hugging Face must produce the exact same pinned files.
Partial files are private to the chosen source; only a verified file is moved
into the model directory. The caller remains responsible for model validation
and its final ready marker.
"""
import errno
import hashlib
import http.client
import json
import os
import ntpath
from pathlib import Path
import re
import socket
import ssl
import stat
import sys
import time
import urllib.error
import urllib.parse
import urllib.request


SOURCES = frozenset(('domestic', 'overseas'))
KINDS = frozenset(('asr', 'reference', 'singing'))
MANIFEST_PATH = Path(__file__).with_name('model-files.json')
TORCH_MANIFEST_PATH = Path(__file__).with_name('model-files-torch.json')
IS_WINDOWS = sys.platform == 'win32'
CHUNK_SIZE = 1024 * 1024
TIMEOUT = 30
MAX_ATTEMPTS = 3
DOMESTIC_AUTO_ATTEMPTS = 2
FALLBACK_REASONS = frozenset(('MODEL_SOURCE_NETWORK', 'MODEL_SOURCE_HTTP',
                              'MODEL_DOWNLOAD_PROTOCOL', 'MODEL_DOWNLOAD_CHECKSUM'))
SAFE_INTEGER = 2 ** 53 - 1
PARTIAL_ROOT = '.cache/voice-studio-downloads'

# This is a closed diagnostic protocol, not a serialization of exception args.
# Keep these allowlists aligned with the parent process's report parser.
DIAGNOSTIC_OPERATIONS = frozenset((
    'manifest_read', 'manifest_validate', 'path_validate', 'windows_api_load',
    'win32_open_root', 'nt_open_directory', 'nt_open_file', 'win32_file_info',
    'win32_file_type', 'crt_open_handle', 'win32_rename', 'nt_rename', 'win32_delete', 'win32_close',
    'open_model_directory', 'check_file', 'open_partial', 'read_file', 'seek_file',
    'write_file', 'flush_file', 'sync_file', 'verify_file', 'rename_file', 'connect',
    'read_response', 'validate_response', 'progress_emit', 'cleanup', 'download_models',
))
DIAGNOSTIC_FUNCTIONS = frozenset((
    'download_models', 'model_manifest', '_download_file', '_verified', '_digests',
    '_request', '_response', 'redirect_request', '__init__', '__enter__', '__exit__',
    'validate_root', 'anchor', '_relative_handle', '_checked', 'directory', 'file',
    'info', 'open', 'parent', 'replace', 'unlink', 'close', 'release', 'fail',
    'phase', 'update', 'fallback', 'details', 'main', 'validate_model', 'write_marker',
    'safetensors_complete', 'tokenizer_complete',
))
DIAGNOSTIC_ERROR_TYPES = frozenset((
    'Exception', 'OSError', 'PermissionError', 'FileNotFoundError', 'FileExistsError',
    'NotADirectoryError', 'IsADirectoryError', 'TimeoutError', 'ConnectionError',
    'ConnectionAbortedError', 'ConnectionRefusedError', 'ConnectionResetError',
    'BrokenPipeError', 'HTTPError', 'URLError', 'SSLError', 'HTTPException',
    'ValueError', 'TypeError', 'KeyError', 'AssertionError', 'ModelDownloadError',
))
DIAGNOSTIC_PHASES = frozenset(('checking', 'connecting', 'downloading', 'validating', 'switching'))
_DIAGNOSTIC_FILES = {
    os.path.normcase(os.path.abspath(__file__)): 'model_download.py',
    os.path.normcase(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'prepare_models.py')): 'prepare_models.py',
}


def _allowed(value, choices):
    return type(value) is str and value in choices


def _annotate_error(error, operation, ntstatus=None):
    """Attach API identity before raising; never turn a path/message into a label."""
    if _allowed(operation, DIAGNOSTIC_OPERATIONS) and not hasattr(error, '_studio_operation'):
        error._studio_operation = operation
    if type(ntstatus) is int and -(2 ** 31) <= ntstatus <= 2 ** 32 - 1:
        error._studio_ntstatus = f'0x{ntstatus & 0xffffffff:08X}'
    return error


def _diagnostic_snapshot(error, operation='download_models', phase=None):
    """Capture the original traceback, then project onto bounded, fixed fields."""
    saved = getattr(error, '_studio_diagnostic', None)
    if isinstance(saved, dict):
        raw = saved
    else:
        raw = {'operation': getattr(error, '_studio_operation', operation),
               'errorType': type(error).__name__, 'phase': phase, 'frames': []}
        # URLError may carry the actual system exception in reason without a
        # Python cause chain. Read only its numeric fields, never reason text.
        cause = error
        seen = set()
        for _ in range(8):
            if id(cause) in seen:
                break
            seen.add(id(cause))
            for name in ('errno', 'winerror'):
                value = getattr(cause, name, None)
                if name not in raw and type(value) is int:
                    raw[name] = value
            if 'ntstatus' not in raw:
                value = getattr(cause, '_studio_ntstatus', None)
                if value is not None:
                    raw['ntstatus'] = value
            following = getattr(cause, 'reason', None) if isinstance(cause, urllib.error.URLError) else None
            if not isinstance(following, BaseException):
                following = cause.__cause__
            if not isinstance(following, BaseException):
                break
            cause = following
        tb = error.__traceback__
        while tb is not None:
            code = tb.tb_frame.f_code
            file = _DIAGNOSTIC_FILES.get(os.path.normcase(os.path.abspath(code.co_filename)))
            if file is not None and code.co_name in DIAGNOSTIC_FUNCTIONS:
                raw['frames'].append({'file': file, 'line': tb.tb_lineno, 'function': code.co_name})
            tb = tb.tb_next

    result = {'schema': 1, 'pythonVersion': '.'.join(str(v) for v in sys.version_info[:3]),
              'errorType': raw.get('errorType') if _allowed(raw.get('errorType'), DIAGNOSTIC_ERROR_TYPES) else 'Exception',
              'operation': raw.get('operation') if _allowed(raw.get('operation'), DIAGNOSTIC_OPERATIONS) else 'download_models',
              'frames': []}
    for name, low, high in (('errno', -(2 ** 31), 2 ** 31 - 1), ('winerror', 0, 2 ** 32 - 1)):
        value = raw.get(name)
        if type(value) is int and low <= value <= high:
            result[name] = value
    ntstatus = raw.get('ntstatus')
    if isinstance(ntstatus, str) and re.fullmatch(r'0x[0-9a-fA-F]{8}', ntstatus):
        result['ntstatus'] = '0x' + ntstatus[2:].upper()
    if _allowed(raw.get('phase'), DIAGNOSTIC_PHASES):
        result['phase'] = raw['phase']
    frames = raw.get('frames')
    if isinstance(frames, list):
        for frame in frames:
            if (isinstance(frame, dict) and _allowed(frame.get('file'), ('model_download.py', 'prepare_models.py'))
                    and _allowed(frame.get('function'), DIAGNOSTIC_FUNCTIONS)
                    and type(frame.get('line')) is int and 0 < frame['line'] <= 2 ** 31 - 1):
                result['frames'].append({name: frame[name] for name in ('file', 'line', 'function')})
        result['frames'] = result['frames'][-8:]
    return result


def _inherit_diagnostic(safe, original, operation='download_models', phase=None):
    record = _diagnostic_snapshot(original, operation, phase)
    safe._studio_diagnostic = record
    safe._studio_diagnostic_emitted = getattr(original, '_studio_diagnostic_emitted', False) is True
    # Retain the system fields on the sanitized exception as well as the wire
    # record. In particular OSError(errno, text) does not preserve winerror.
    if 'winerror' in record:
        safe.winerror = record['winerror']
    if 'ntstatus' in record:
        safe._studio_ntstatus = record['ntstatus']
    return safe


def _emit_diagnostic(error, operation='download_models', phase=None, *, secondary=False):
    if getattr(error, '_studio_diagnostic_emitted', False) is True and not secondary:
        return
    record = _diagnostic_snapshot(error, operation, phase)
    if secondary:
        record['secondary'] = True
    try:
        print('STUDIO_DIAGNOSTIC ' + json.dumps(record, separators=(',', ':'), ensure_ascii=True),
              file=sys.stderr, flush=True)
    except (OSError, ValueError):
        # A closed log pipe must not replace the original filesystem failure.
        return
    if not secondary:
        error._studio_diagnostic_emitted = True


def _safe_io_error(error, operation='download_models', phase=None):
    number = getattr(error, 'errno', None)
    if type(number) is not int or not -(2 ** 31) <= number < 2 ** 31:
        number = None
    return _inherit_diagnostic(OSError(number, '模型文件读写失败'), error, operation, phase)


def _cleanup_preserving(callback):
    """Called only while unwinding another error, which remains the main cause."""
    try:
        callback()
    except Exception as cleanup_error:
        _emit_diagnostic(cleanup_error, 'cleanup', secondary=True)


def _finish_cleanup(*callbacks):
    """Run all releases; only a cleanup without an active failure may become primary."""
    active_error = sys.exc_info()[1]
    first_error = None
    for callback in callbacks:
        try:
            callback()
        except Exception as error:
            if active_error is not None or first_error is not None:
                _emit_diagnostic(error, 'cleanup', secondary=True)
            else:
                first_error = error
    if first_error is not None:
        raise first_error


class ModelDownloadError(RuntimeError):
    """A fixed safe message; never interpolate a URL, proxy or server body."""
    def __init__(self, code, source, status=None, *, exhausted=False):
        self.code, self.source = code, source
        self.status = status if type(status) is int and 100 <= status <= 599 else None
        messages = {
            'MODEL_SOURCE_NETWORK': '模型下载连接失败，请检查网络后重试',
            'MODEL_SOURCE_HTTP': '模型下载服务返回错误，请稍后重试',
            'MODEL_DOWNLOAD_PROTOCOL': '模型下载响应无效，请稍后重试',
            'MODEL_DOWNLOAD_CHECKSUM': '模型下载校验失败，请稍后重试',
            'MODEL_DOWNLOAD_MANIFEST': '模型文件清单无效，请重新安装插件',
            'MODEL_DOWNLOAD_PATH': '模型目录包含无效文件或链接，请检查本地存储',
        }
        message = ('国内和备用下载线路均未完成，请检查网络后重试；已完成文件会保留'
                   if exhausted else messages.get(code, messages['MODEL_SOURCE_NETWORK']))
        super().__init__(f'{code}: {message}' + (f' (HTTP {self.status})' if self.status else ''))


def _relative(value):
    return (isinstance(value, str) and 0 < len(value) <= 1024 and
            not value.startswith('/') and '\\' not in value and
            all(ord(c) >= 32 and ord(c) != 127 for c in value) and
            all(p not in ('', '.', '..') and not p.endswith(('.', ' ')) and
                not re.search(r'[:"<>|?*]', p) and
                not re.match(r'^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)', p, re.I)
                for p in value.split('/')) and
            len(value.split('/')) <= 16)


def model_manifest(kind, backend='mlx'):
    """Return a validated manifest containing only fixed public model metadata."""
    try:
        if backend not in ('mlx', 'torch'):
            raise ValueError()
        manifest_path = MANIFEST_PATH if backend == 'mlx' else TORCH_MANIFEST_PATH
        if kind not in KINDS or manifest_path.stat().st_size > 1024 * 1024:
            raise ValueError()
        raw = json.loads(manifest_path.read_text(encoding='utf-8'))
        item = raw['models'][kind]
        assert raw['formatVersion'] == 1
        assert re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', item['repo'])
        assert re.fullmatch(r'[a-f0-9]{40}', item['revision'])
        files = item['files']
        assert isinstance(files, list) and 0 < len(files) <= 1000
        seen = set()
        for f in files:
            assert _relative(f['path']) and not f['path'].startswith('.cache/')
            assert f['path'] not in seen
            seen.add(f['path'])
            assert type(f['size']) is int and 0 < f['size'] <= SAFE_INTEGER
            assert re.fullmatch(r'[a-f0-9]{40}', f['gitBlobSha1'])
            if 'sha256' in f:
                assert re.fullmatch(r'[a-f0-9]{64}', f['sha256'])
            ms = f['modelscope']
            assert re.fullmatch(r'[a-f0-9]{40}', ms['revision'])
            assert re.fullmatch(r'[a-f0-9]{64}', ms['sha256'])
            # For LFS, both platforms publish the identical content SHA256.
            assert 'sha256' not in f or f['sha256'] == ms['sha256']
        total = sum(f['size'] for f in files)
        assert type(item['totalBytes']) is int and total == item['totalBytes'] <= SAFE_INTEGER
        return item
    except (OSError, ValueError, TypeError, KeyError, AssertionError) as error:
        safe = _inherit_diagnostic(ModelDownloadError('MODEL_DOWNLOAD_MANIFEST', None), error,
                                   'manifest_read' if isinstance(error, OSError) else 'manifest_validate', 'checking')
        _emit_diagnostic(safe)
        raise safe from None


class _WindowsNative:
    """NT relative handles avoid the path races that dir_fd prevents on POSIX.

    CreateFileW opens only the volume root. Every descendant is opened relative
    to a held directory handle with NtCreateFile and OPEN_REPARSE_POINT. No
    handle shares write/delete access; file rename uses the original verified
    file handle and a held destination-directory handle.
    """
    def __init__(self):
        import ctypes
        import msvcrt
        self.c, self.msvcrt = ctypes, msvcrt
        DWORD, HANDLE = ctypes.c_uint32, ctypes.c_void_p
        class UnicodeString(ctypes.Structure):
            _fields_ = [('Length', ctypes.c_uint16), ('MaximumLength', ctypes.c_uint16), ('Buffer', HANDLE)]
        class ObjectAttributes(ctypes.Structure):
            _fields_ = [('Length', DWORD), ('RootDirectory', HANDLE), ('ObjectName', ctypes.POINTER(UnicodeString)), ('Attributes', DWORD), ('SecurityDescriptor', HANDLE), ('SecurityQualityOfService', HANDLE)]
        class IoStatus(ctypes.Structure):
            _fields_ = [('Status', HANDLE), ('Information', ctypes.c_size_t)]
        class FileInfo(ctypes.Structure):
            _fields_ = [('attributes', DWORD), ('created', DWORD * 2), ('accessed', DWORD * 2), ('written', DWORD * 2), ('volume', DWORD), ('sizeHigh', DWORD), ('sizeLow', DWORD), ('links', DWORD), ('indexHigh', DWORD), ('indexLow', DWORD)]
        class RenameInfo(ctypes.Structure):
            _fields_ = [('ReplaceIfExists', ctypes.c_ubyte), ('RootDirectory', HANDLE), ('FileNameLength', DWORD), ('FileName', ctypes.c_uint16 * 1)]
        self.UnicodeString, self.ObjectAttributes, self.IoStatus, self.FileInfo, self.RenameInfo = UnicodeString, ObjectAttributes, IoStatus, FileInfo, RenameInfo
        try:
            self.kernel = ctypes.WinDLL('kernel32', use_last_error=True)
            self.nt = ctypes.WinDLL('ntdll')
        except OSError as error:
            raise _annotate_error(error, 'windows_api_load')
        self.kernel.CreateFileW.argtypes = [ctypes.c_wchar_p, DWORD, DWORD, HANDLE, DWORD, DWORD, HANDLE]
        self.kernel.CreateFileW.restype = HANDLE
        self.kernel.CloseHandle.argtypes, self.kernel.CloseHandle.restype = [HANDLE], ctypes.c_int32
        self.kernel.GetFileInformationByHandle.argtypes = [HANDLE, ctypes.POINTER(FileInfo)]
        self.kernel.GetFileInformationByHandle.restype = ctypes.c_int32
        self.kernel.GetFileType.argtypes, self.kernel.GetFileType.restype = [HANDLE], DWORD
        self.kernel.SetFileInformationByHandle.argtypes = [HANDLE, ctypes.c_int32, HANDLE, DWORD]
        self.kernel.SetFileInformationByHandle.restype = ctypes.c_int32
        self.nt.NtCreateFile.argtypes = [ctypes.POINTER(HANDLE), DWORD, ctypes.POINTER(ObjectAttributes), ctypes.POINTER(IoStatus), HANDLE, DWORD, DWORD, DWORD, DWORD, HANDLE, DWORD]
        self.nt.NtCreateFile.restype = ctypes.c_int32
        self.nt.NtSetInformationFile.argtypes = [HANDLE, ctypes.POINTER(IoStatus), HANDLE, DWORD, ctypes.c_int32]
        self.nt.NtSetInformationFile.restype = ctypes.c_int32
        self.nt.RtlNtStatusToDosError.argtypes, self.nt.RtlNtStatusToDosError.restype = [ctypes.c_int32], DWORD

    def validate_root(self, root):
        drive, tail = ntpath.splitdrive(str(root))
        if not re.fullmatch(r'[A-Za-z]:', drive) or not tail.startswith(('\\', '/')):
            raise _annotate_error(OSError(errno.ELOOP, 'A local drive path is required'), 'path_validate')
        if not _relative(tail.lstrip('\\/').replace('\\', '/')):
            raise _annotate_error(OSError(errno.ELOOP, 'Invalid local model directory'), 'path_validate')

    def close(self, handle):
        if not self.kernel.CloseHandle(handle):
            raise _annotate_error(self.c.WinError(self.c.get_last_error()), 'win32_close')

    def _checked(self, handle, directory):
        try:
            info = self.FileInfo()
            if not self.kernel.GetFileInformationByHandle(handle, self.c.byref(info)):
                raise _annotate_error(self.c.WinError(self.c.get_last_error()), 'win32_file_info')
            if info.attributes & 0x400 or bool(info.attributes & 0x10) != directory:
                raise _annotate_error(OSError(errno.ELOOP, 'Reparse points and special files are not allowed'), 'path_validate')
            file_type = self.kernel.GetFileType(handle)
            if file_type == 0:
                # FILE_TYPE_UNKNOWN is also the API's failure result; obtain
                # its error before CloseHandle can change the thread's code.
                code = self.c.get_last_error()
                if code:
                    raise _annotate_error(self.c.WinError(code), 'win32_file_type')
            if file_type != 1:
                raise _annotate_error(OSError(errno.ELOOP, 'Special files are not allowed'), 'win32_file_type')
            return handle
        except BaseException:
            _cleanup_preserving(lambda: self.close(handle))
            raise

    def anchor(self, path):
        handle = self.kernel.CreateFileW(str(path), 0x001000A1, 1, None, 3, 0x02200000, None)
        if handle == self.c.c_void_p(-1).value:
            raise _annotate_error(self.c.WinError(self.c.get_last_error()), 'win32_open_root')
        return self._checked(handle, True)

    def _relative_handle(self, parent, name, *, directory=False, write=False, create=False, delete=False, shared=False, exclusive=False):
        if not _relative(name) or '/' in name:
            raise _annotate_error(OSError(errno.ELOOP, 'Invalid child filename'), 'path_validate')
        encoded = name.encode('utf-16-le')
        buffer = self.c.create_string_buffer(encoded + b'\0\0')
        text = self.UnicodeString(len(encoded), len(encoded) + 2, self.c.cast(buffer, self.c.c_void_p))
        attrs = self.ObjectAttributes(self.c.sizeof(self.ObjectAttributes), parent, self.c.pointer(text), 0x40, None, None)
        status, handle = self.IoStatus(), self.c.c_void_p()
        access = 0x001000A1 if directory else 0x80100000 | (0x40010000 if write else 0x10000 if delete else 0)
        options = 0x00200020 | (1 if directory else 0x40)
        disposition = 2 if exclusive else 3 if create else 1  # FILE_CREATE / FILE_OPEN_IF / FILE_OPEN
        result = self.nt.NtCreateFile(self.c.byref(handle), access, self.c.byref(attrs), self.c.byref(status), None, 0x80, 7 if shared else 1, disposition, options, None, 0)
        if result < 0:
            raise _annotate_error(self.c.WinError(self.nt.RtlNtStatusToDosError(result)),
                                  'nt_open_directory' if directory else 'nt_open_file', result)
        return self._checked(handle.value, directory)

    def directory(self, parent, name, create=False):
        return self._relative_handle(parent, name, directory=True, create=create)

    def file(self, parent, name, write=False, delete=False, shared=False, exclusive=False):
        handle = self._relative_handle(parent, name, write=write, delete=delete, create=write, shared=shared, exclusive=exclusive)
        try:
            return self.msvcrt.open_osfhandle(handle, os.O_BINARY | (os.O_RDWR if write else os.O_RDONLY))
        except BaseException as error:
            if isinstance(error, OSError):
                _annotate_error(error, 'crt_open_handle')
            _cleanup_preserving(lambda: self.close(handle))
            raise

    def info(self, parent, name):
        fd = self.file(parent, name, shared=True)
        try:
            return os.fstat(fd)
        finally:
            _finish_cleanup(lambda: os.close(fd))

    def replace(self, fd, parent, name):
        if not _relative(name) or '/' in name:
            raise _annotate_error(OSError(errno.ELOOP, 'Invalid rename leaf'), 'path_validate')
        encoded = name.encode('utf-16-le')
        # FILE_RENAME_INFORMATION requires at least sizeof(struct) plus the
        # UTF-16 name bytes. The extra zero-filled space also terminates the name.
        size = self.c.sizeof(self.RenameInfo) + len(encoded)
        buffer = self.c.create_string_buffer(size)
        info = self.RenameInfo.from_buffer(buffer)
        info.ReplaceIfExists, info.RootDirectory, info.FileNameLength = 1, parent, len(encoded)
        self.c.memmove(self.c.addressof(buffer) + self.RenameInfo.FileName.offset, encoded, len(encoded))
        # RootDirectory=None plus a simple leaf renames in the source handle's
        # own directory. Publication uses this form so the kernel need not open
        # our write-denied destination directory again. Do not use a DOS path or
        # reopen the verified stage by name.
        # https://learn.microsoft.com/windows-hardware/drivers/ddi/ntifs/nf-ntifs-ntsetinformationfile
        # https://learn.microsoft.com/windows-hardware/drivers/ddi/ntifs/ns-ntifs-_file_rename_information
        status = self.IoStatus()
        result = self.nt.NtSetInformationFile(self.msvcrt.get_osfhandle(fd), self.c.byref(status), buffer, size, 10)
        if result < 0:
            raise _annotate_error(self.c.WinError(self.nt.RtlNtStatusToDosError(result)), 'nt_rename', result)

    def unlink(self, fd):
        info = self.c.c_ubyte(1)
        if not self.kernel.SetFileInformationByHandle(self.msvcrt.get_osfhandle(fd), 4, self.c.byref(info), self.c.sizeof(info)):
            raise _annotate_error(self.c.WinError(self.c.get_last_error()), 'win32_delete')


class _WindowsStream:
    def __init__(self, owner, name, stream, parents, write):
        self.owner, self.name, self.stream, self.parents, self.writing = owner, name, stream, parents, write
    def __getattr__(self, name):
        return getattr(self.stream, name)
    def __enter__(self):
        return self
    def __exit__(self, _exc_type, exc_value, _traceback):
        if exc_value is None:
            self.close()
        else:
            _cleanup_preserving(self.close)
    def close(self):
        if self.stream.closed:
            return
        failure = None
        try:
            self.stream.close()
        except BaseException as error:
            failure = error
            raise
        finally:
            if self.writing:
                self.owner.writers.pop(self.name, None)
            self.owner.streams.discard(self)
            if failure is None:
                self.owner.release(self.parents)
            else:
                _cleanup_preserving(lambda: self.owner.release(self.parents))


class _WindowsFiles:
    def __init__(self, root, owner):
        self.owner, self.api = owner, _WindowsNative()
        self.handles, self.streams, self.writers = [], set(), {}
        root = Path(root)
        self.api.validate_root(root)
        try:
            self.handles.append(self.api.anchor(root.anchor))
            for index, part in enumerate(root.parts[1:]):
                self.handles.append(self.api.directory(self.handles[-1], part, create=index == len(root.parts) - 2))
        except BaseException:
            _cleanup_preserving(lambda: self.release(self.handles))
            raise
        self.root = self.handles[-1]

    def release(self, handles):
        failure = None
        while handles:
            try:
                self.api.close(handles.pop())
            except OSError as error:
                if failure is None:
                    failure = error
                else:
                    _emit_diagnostic(error, 'cleanup', secondary=True)
        if failure is not None:
            raise failure

    def close(self):
        _finish_cleanup(*(stream.close for stream in list(self.streams)),
                        lambda: self.release(self.handles))

    def parent(self, name, create=False):
        if not _relative(name):
            self.owner.fail()
        handles, parent = [], self.root
        try:
            for part in name.split('/')[:-1]:
                parent = self.api.directory(parent, part, create=create)
                handles.append(parent)
            return parent, name.split('/')[-1], handles
        except BaseException:
            _cleanup_preserving(lambda: self.release(handles))
            raise

    def open(self, name, write=False):
        parent, leaf, handles = self.parent(name, create=write)
        fd = None
        try:
            if write and name in self.writers:
                self.owner.fail()
            fd = self.api.file(parent, leaf, write=write)
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or (write and info.st_nlink != 1):
                self.owner.fail()
            stream = _WindowsStream(self, name, os.fdopen(fd, 'r+b' if write else 'rb'), handles, write)
            fd = None
            self.streams.add(stream)
            if write:
                self.writers[name] = stream
            return stream
        except BaseException:
            if fd is not None:
                _cleanup_preserving(lambda: os.close(fd))
            _cleanup_preserving(lambda: self.release(handles))
            raise

    def unlink(self, name):
        handles, fd = [], None
        try:
            parent, leaf, handles = self.parent(name)
            fd = self.api.file(parent, leaf, delete=True)
            self.api.unlink(fd)
        except FileNotFoundError:
            pass
        finally:
            callbacks = [lambda: self.release(handles)]
            if fd is not None:
                callbacks.insert(0, lambda: os.close(fd))
            _finish_cleanup(*callbacks)

    def replace(self, partial, target, expected, manifest_file):
        stream = self.writers.get(partial)
        if stream is None or manifest_file['path'] != target or manifest_file['size'] != expected.st_size:
            self.owner.fail()
        src, leaf, src_handles = self.parent(partial)
        dest_handles = []
        stage_fd, stage, published = None, None, False
        operation = 'check_file'
        try:
            actual = self.api.info(src, leaf)
            if not stat.S_ISREG(actual.st_mode) or actual.st_nlink != 1 or (actual.st_dev, actual.st_ino, actual.st_size) != (expected.st_dev, expected.st_ino, expected.st_size):
                self.owner.fail()
            dest, dest_leaf, dest_handles = self.parent(target, create=True)
            try:
                current = self.api.info(dest, dest_leaf)
                if not stat.S_ISREG(current.st_mode):
                    self.owner.fail()
            except FileNotFoundError:
                pass
            # A cross-directory rename asks Windows to open the destination
            # directory for FILE_WRITE_DATA, conflicting with our held share=1
            # directory locks. Keep those locks: copy the already verified fd
            # to an exclusively created sibling, re-verify it, then rename that
            # very fd in its own directory (NULL RootDirectory + simple leaf).
            # A deterministic private name bounds crash leftovers to one stage
            # per target. Old stage bytes are never resumed or trusted.
            stage_leaf = _stage_name(target)
            operation = 'open_partial'
            try:
                stage_fd = self.api.file(dest, stage_leaf, write=True, exclusive=True)
            except FileExistsError:
                old_fd = None
                try:
                    # An active writer cannot be opened with this share=1
                    # delete handle. A stale reparse/hardlink is rejected.
                    old_fd = self.api.file(dest, stage_leaf, delete=True)
                    old = os.fstat(old_fd)
                    if not stat.S_ISREG(old.st_mode) or old.st_nlink != 1:
                        self.owner.fail()
                    self.api.unlink(old_fd)
                except FileNotFoundError:
                    pass
                finally:
                    if old_fd is not None:
                        _finish_cleanup(lambda: os.close(old_fd))
                # Do not OPEN_IF after a collision: a concurrent claimant wins
                # and this attempt fails without opening/truncating its file.
                stage_fd = self.api.file(dest, stage_leaf, write=True, exclusive=True)
            stage = os.fdopen(stage_fd, 'r+b', buffering=0)
            stage_fd = None  # stage now owns the descriptor.
            info = os.fstat(stage.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                self.owner.fail()
            operation = 'read_file'
            stream.seek(0)
            copied = 0
            while copied < manifest_file['size']:
                chunk = stream.read(min(CHUNK_SIZE, manifest_file['size'] - copied))
                if not chunk:
                    raise OSError(errno.EIO, '模型缓存读取未完成')
                operation = 'write_file'
                pending = memoryview(chunk)
                while pending:
                    written = stage.write(pending)
                    if written is None or written <= 0:
                        raise OSError(errno.EIO, '模型临时文件写入未完成')
                    pending = pending[written:]
                copied += len(chunk)
                operation = 'read_file'
            if stream.read(1):
                raise OSError(errno.EIO, '模型缓存大小已变化')
            operation = 'sync_file'
            os.fsync(stage.fileno())
            operation = 'verify_file'
            if not _digests(stage, manifest_file):
                # This is a local publication failure, not a reason to switch
                # download mirrors or discard the verified source cache.
                raise OSError(errno.EIO, '模型临时文件校验失败')
            staged, source = os.fstat(stage.fileno()), os.fstat(stream.fileno())
            if (not stat.S_ISREG(staged.st_mode) or staged.st_nlink != 1 or staged.st_size != manifest_file['size']
                    or source.st_nlink != 1
                    or (source.st_dev, source.st_ino, source.st_size) != (expected.st_dev, expected.st_ino, expected.st_size)):
                self.owner.fail()
            operation = 'rename_file'
            self.api.replace(stage.fileno(), None, dest_leaf)
            published = True
            # Only now may the original complete .cache partial be removed.
            # Cache housekeeping must not undo an already verified publication.
            try:
                self.api.unlink(stream.fileno())
            except OSError as cleanup_error:
                _emit_diagnostic(cleanup_error, 'cleanup', 'validating', secondary=True)
        except OSError as error:
            raise _annotate_error(error, operation)
        finally:
            callbacks = []
            if stage is not None:
                if not published:
                    callbacks.append(lambda: self.api.unlink(stage.fileno()))
                callbacks.append(stage.close)
            elif stage_fd is not None:
                callbacks.extend((lambda: self.api.unlink(stage_fd), lambda: os.close(stage_fd)))
            callbacks.extend((lambda: self.release(dest_handles), lambda: self.release(src_handles)))
            _finish_cleanup(*callbacks)


class _Files:
    """Anchor every filesystem operation to directory FDs; never follow links."""
    def __init__(self, root, source):
        self.source = source
        self.fd = None
        self.windows = None
        if IS_WINDOWS:
            self.windows = _WindowsFiles(root, self)
            return
        root = Path(root)
        if not root.is_absolute() or any(p in ('.', '..') for p in root.parts):
            self.fail()
        fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
        try:
            parts = root.parts[1:]
            if not parts:
                self.fail()
            for index, part in enumerate(parts):
                if index == len(parts) - 1:
                    try:
                        os.mkdir(part, mode=0o700, dir_fd=fd)
                    except FileExistsError:
                        pass
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                os.close(fd)
                fd = child
            self.fd = fd
        except BaseException:
            os.close(fd)
            raise

    def fail(self):
        raise ModelDownloadError('MODEL_DOWNLOAD_PATH', self.source)

    def close(self):
        if self.windows is not None:
            self.windows.close()
            self.windows = None
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None

    def parent(self, name, create=False):
        if not _relative(name):
            self.fail()
        fd = os.dup(self.fd)
        try:
            for part in name.split('/')[:-1]:
                if create:
                    try:
                        os.mkdir(part, mode=0o700, dir_fd=fd)
                    except FileExistsError:
                        pass
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                os.close(fd)
                fd = child
            return fd, name.split('/')[-1]
        except BaseException:
            os.close(fd)
            raise

    def open(self, name, write=False):
        if self.windows is not None:
            return self.windows.open(name, write)
        parent, leaf = self.parent(name, create=write)
        try:
            flags = os.O_NOFOLLOW | os.O_NONBLOCK | (os.O_RDWR | os.O_CREAT if write else os.O_RDONLY)
            fd = os.open(leaf, flags, mode=0o600, dir_fd=parent)
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or (write and info.st_nlink != 1):
                os.close(fd)
                self.fail()
            return os.fdopen(fd, 'r+b' if write else 'rb')
        finally:
            os.close(parent)

    def unlink(self, name):
        if self.windows is not None:
            return self.windows.unlink(name)
        try:
            parent, leaf = self.parent(name)
        except FileNotFoundError:
            return
        try:
            try:
                os.unlink(leaf, dir_fd=parent)
            except FileNotFoundError:
                pass
        finally:
            os.close(parent)

    def replace(self, partial, target, expected, manifest_file):
        if self.windows is not None:
            return self.windows.replace(partial, target, expected, manifest_file)
        src, src_leaf = self.parent(partial)
        try:
            actual = os.stat(src_leaf, dir_fd=src, follow_symlinks=False)
            if (not stat.S_ISREG(actual.st_mode) or actual.st_nlink != 1 or
                    (actual.st_dev, actual.st_ino, actual.st_size) !=
                    (expected.st_dev, expected.st_ino, expected.st_size)):
                self.fail()
            dest, dest_leaf = self.parent(target, create=True)
            try:
                try:
                    current = os.stat(dest_leaf, dir_fd=dest, follow_symlinks=False)
                    if not stat.S_ISREG(current.st_mode):
                        self.fail()
                except FileNotFoundError:
                    pass
                os.replace(src_leaf, dest_leaf, src_dir_fd=src, dst_dir_fd=dest)
                os.fsync(dest)
            finally:
                os.close(dest)
        finally:
            os.close(src)


def _digests(stream, f):
    sha = hashlib.sha256()
    git = hashlib.sha1(b'blob ' + str(f['size']).encode('ascii') + b'\0')
    stream.seek(0)
    count = 0
    while True:
        chunk = stream.read(CHUNK_SIZE)
        if not chunk:
            break
        count += len(chunk)
        if count > f['size']:
            return False
        sha.update(chunk)
        git.update(chunk)
    if count != f['size'] or sha.hexdigest() != f['modelscope']['sha256']:
        return False
    # An LFS Git blob represents its pointer, not the downloaded large content.
    return sha.hexdigest() == f['sha256'] if 'sha256' in f else git.hexdigest() == f['gitBlobSha1']


def _verified(fs, f):
    try:
        with fs.open(f['path']) as stream:
            return os.fstat(stream.fileno()).st_size == f['size'] and _digests(stream, f)
    except FileNotFoundError:
        return False


def _url(manifest, f, source):
    if source == 'domestic':
        query = urllib.parse.urlencode({'Revision': f['modelscope']['revision'], 'FilePath': f['path']})
        return f'https://modelscope.cn/api/v1/models/{manifest["repo"]}/repo?{query}'
    return (f'https://huggingface.co/{manifest["repo"]}/resolve/{manifest["revision"]}/' +
            urllib.parse.quote(f['path'], safe='/'))


class _HTTPSRedirect(urllib.request.HTTPRedirectHandler):
    def __init__(self, source='domestic'):
        self.source = source

    def redirect_request(self, request, fp, code, msg, headers, newurl):
        parsed = urllib.parse.urlsplit(newurl)
        domains = ('modelscope.cn',) if self.source == 'domestic' else ('huggingface.co', 'hf.co')
        if (parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or
                not any(parsed.hostname == d or parsed.hostname.endswith('.' + d) for d in domains)):
            raise ModelDownloadError('MODEL_DOWNLOAD_PROTOCOL', self.source)
        return super().redirect_request(request, fp, code, msg, headers, newurl)


def _request(url, headers):
    # urllib does not consult Hugging Face/ModelScope token stores or .netrc.
    # The default HTTPS context verifies certificates and keeps system proxies.
    source = 'domestic' if urllib.parse.urlsplit(url).hostname == 'modelscope.cn' else 'overseas'
    opener = urllib.request.build_opener(_HTTPSRedirect(source))
    return opener.open(urllib.request.Request(url, headers=headers), timeout=TIMEOUT)


def _partial_name(f, source):
    identity = hashlib.sha256((f['path'] + '\0' + f['modelscope']['sha256']).encode()).hexdigest()
    return f'{PARTIAL_ROOT}/{source}/{identity}.part'


def _stage_name(target):
    return '.studio-publish-' + hashlib.sha256(target.encode('utf-8')).hexdigest() + '.part'


class _Progress:
    def __init__(self, kind, source, total, emit):
        self.kind, self.source, self.total, self.emit = kind, source, total, emit
        self.completed = 0
        self.last = 0.0
        self.fallback_reason = None
        self.current_phase = 'checking'

    def details(self):
        return {'source': self.source, **({'fallbackReason': self.fallback_reason}
                if self.fallback_reason in FALLBACK_REASONS else {})}

    def phase(self, phase):
        self.current_phase = phase
        try:
            self.emit(self.kind, phase, **self.details())
        except Exception as error:
            raise _annotate_error(error, 'progress_emit')

    def fallback(self, reason):
        self.source, self.fallback_reason = 'overseas', reason
        self.phase('switching')

    def update(self, active=0, force=False):
        now = time.monotonic()
        if force or now - self.last >= 1.0:
            self.current_phase = 'downloading'
            try:
                self.emit(self.kind, 'downloading', **self.details(),
                          completedBytes=self.completed + active, totalBytes=self.total)
            except Exception as error:
                raise _annotate_error(error, 'progress_emit')
            self.last = now


def _response(response, offset, expected, source):
    """Return safe write offset. A 200 range fallback must restart, never append."""
    status = response.status
    headers = response.headers
    if status not in (200, 206):
        raise ModelDownloadError('MODEL_SOURCE_HTTP', source, status)
    if headers.get('Content-Encoding', 'identity').lower() != 'identity':
        raise ModelDownloadError('MODEL_DOWNLOAD_PROTOCOL', source)
    if status == 206:
        match = re.fullmatch(r'bytes ([0-9]+)-([0-9]+)/([0-9]+)', headers.get('Content-Range', ''))
        if not match:
            raise ModelDownloadError('MODEL_DOWNLOAD_PROTOCOL', source)
        start, end, total = map(int, match.groups())
        if start != offset or end != expected - 1 or total != expected:
            raise ModelDownloadError('MODEL_DOWNLOAD_PROTOCOL', source)
    else:
        offset = 0
        if headers.get('Content-Range') is not None:
            raise ModelDownloadError('MODEL_DOWNLOAD_PROTOCOL', source)
    length = headers.get('Content-Length')
    if length is not None and (not re.fullmatch(r'[0-9]+', length) or int(length) != expected - offset):
        raise ModelDownloadError('MODEL_DOWNLOAD_PROTOCOL', source)
    return offset


def _download_file(manifest, f, fs, source, progress, *, attempts=MAX_ATTEMPTS):
    partial = _partial_name(f, source)
    last_error = None
    for attempt in range(attempts):
        operation = 'open_partial'
        try:
            with fs.open(partial, write=True) as stream:
                operation = 'read_file'
                offset = os.fstat(stream.fileno()).st_size
                if offset > f['size']:
                    operation = 'write_file'
                    stream.truncate(0)
                    offset = 0
                if offset == f['size']:
                    progress.phase('validating')
                    operation = 'verify_file'
                    if _digests(stream, f):
                        operation = 'rename_file'
                        fs.replace(partial, f['path'], os.fstat(stream.fileno()), f)
                        progress.completed += f['size']
                        progress.update(force=True)
                        return
                    operation = 'write_file'
                    stream.truncate(0)
                    offset = 0
                progress.phase('connecting')
                headers = {'Accept-Encoding': 'identity', 'User-Agent': 'Coopanion-Voice-Studio/1'}
                if offset:
                    headers['Range'] = f'bytes={offset}-'
                operation = 'connect'
                with _request(_url(manifest, f, source), headers) as response:
                    operation = 'validate_response'
                    start = _response(response, offset, f['size'], source)
                    operation = 'seek_file'
                    if start == 0:
                        stream.seek(0)
                        stream.truncate(0)
                    else:
                        stream.seek(start)
                    offset = start
                    progress.update(offset, force=True)
                    # HTTPResponse.read(n) can wait for all n bytes while a
                    # slow server keeps trickling data. read1 reports the bytes
                    # currently available, so progress remains responsive.
                    read_chunk = getattr(response, 'read1', response.read)
                    while True:
                        # Read one byte beyond the manifest size to detect an
                        # oversized body even when Content-Length is absent.
                        operation = 'read_response'
                        chunk = read_chunk(min(CHUNK_SIZE, f['size'] - offset + 1))
                        if not chunk:
                            break
                        if offset + len(chunk) > f['size']:
                            raise ModelDownloadError('MODEL_DOWNLOAD_PROTOCOL', source)
                        operation = 'write_file'
                        stream.write(chunk)
                        operation = 'flush_file'
                        stream.flush()
                        offset += len(chunk)
                        progress.update(offset)
                    if offset != f['size']:
                        raise ModelDownloadError('MODEL_SOURCE_NETWORK', source)
                operation = 'flush_file'
                stream.flush()
                operation = 'sync_file'
                os.fsync(stream.fileno())
                # Show validation separately instead of presenting an unverified
                # completed transfer as a ready model.
                progress.phase('validating')
                operation = 'verify_file'
                if not _digests(stream, f):
                    operation = 'write_file'
                    stream.truncate(0)
                    raise ModelDownloadError('MODEL_DOWNLOAD_CHECKSUM', source)
                operation = 'rename_file'
                fs.replace(partial, f['path'], os.fstat(stream.fileno()), f)
                progress.completed += f['size']
                return
        except urllib.error.HTTPError as error:
            status = error.code
            if error.fp is not None:
                error.close()
            last_error = _inherit_diagnostic(ModelDownloadError('MODEL_SOURCE_HTTP', source, status),
                                             error, operation, progress.current_phase)
            if status not in (408, 429, 500, 502, 503, 504):
                raise last_error from None
        except (urllib.error.URLError, TimeoutError, socket.timeout, ConnectionError,
                http.client.HTTPException, ssl.SSLError, ValueError) as error:
            last_error = _inherit_diagnostic(ModelDownloadError('MODEL_SOURCE_NETWORK', source),
                                             error, operation, progress.current_phase)
        except ModelDownloadError as error:
            last_error = error
            error._studio_diagnostic = _diagnostic_snapshot(error, operation, progress.current_phase)
            if error.code != 'MODEL_SOURCE_NETWORK':
                raise error from None
        except OSError as error:
            error._studio_diagnostic = _diagnostic_snapshot(error, operation, progress.current_phase)
            raise
        if attempt + 1 < attempts:
            time.sleep(min(attempt + 1, 2))
    raise last_error from None


def download_models(kind, output, source='auto', emit=None, *, backend='mlx'):
    """Download pinned files and return verified {path, size} files.

    emit follows emit_progress(kind, phase, source=..., completedBytes=...,
    totalBytes=...). It is called synchronously, with byte updates at most once
    per second apart from phase/retry boundaries. Existing complete files are
    hashed before reuse. Ctrl-C unwinds immediately and preserves a same-source
    partial; a later run verifies the final content before using it. Automatic
    operations prefer domestic, then stay overseas after a remote failure.
    Completed files are shared, incomplete files stay isolated by source.
    """
    fs, progress, actual_source = None, None, None
    operation = 'manifest_validate'
    try:
        if source not in SOURCES and source != 'auto':
            raise ModelDownloadError('MODEL_DOWNLOAD_MANIFEST', None)
        if emit is None:
            from model_progress import emit_progress
            emit = emit_progress
        manifest = model_manifest(kind, backend=backend)
        automatic = source == 'auto'
        actual_source = 'domestic' if automatic else source
        progress = _Progress(kind, actual_source, manifest['totalBytes'], emit)
        # Even failure to open the first directory must have a visible phase.
        progress.phase('checking')
        operation = 'open_model_directory'
        fs = _Files(output, actual_source)
        missing = []
        for f in manifest['files']:
            operation = 'check_file'
            if _verified(fs, f):
                progress.completed += f['size']
            else:
                missing.append(f)
        for f in missing:
            operation = 'open_partial'
            try:
                _download_file(manifest, f, fs, actual_source, progress,
                               attempts=DOMESTIC_AUTO_ATTEMPTS if automatic and actual_source == 'domestic' else MAX_ATTEMPTS)
            except ModelDownloadError as error:
                if not automatic or error.code not in FALLBACK_REASONS:
                    raise
                if actual_source == 'domestic':
                    # Only transport/content failures merit another remote.
                    # Disk, path, manifest and cancellation failures never reach
                    # this branch. Do not count or reuse the domestic partial.
                    actual_source = fs.source = 'overseas'
                    progress.fallback(error.code)
                    try:
                        _download_file(manifest, f, fs, actual_source, progress)
                    except ModelDownloadError as final_error:
                        if final_error.code not in FALLBACK_REASONS:
                            raise
                        raise _inherit_diagnostic(ModelDownloadError(final_error.code, actual_source,
                                                 final_error.status, exhausted=True), final_error) from None
                else:
                    raise _inherit_diagnostic(ModelDownloadError(error.code, actual_source,
                                             error.status, exhausted=True), error) from None
        progress.phase('validating')
        return [{'path': f['path'], 'size': f['size']} for f in manifest['files']]
    except OSError as error:
        phase = progress.current_phase if progress is not None else 'checking'
        _emit_diagnostic(error, operation, phase)
        # Preserve original numeric codes and traceback in the safe record;
        # raw filenames and arbitrary external messages remain suppressed.
        if error.errno in (errno.ELOOP, errno.ENOTDIR):
            raise _inherit_diagnostic(ModelDownloadError('MODEL_DOWNLOAD_PATH', actual_source),
                                      error, operation, phase) from None
        raise _safe_io_error(error, operation, phase) from None
    except Exception as error:
        phase = progress.current_phase if progress is not None else 'checking'
        _emit_diagnostic(error, operation, phase)
        if isinstance(error, ModelDownloadError):
            raise
        raise _inherit_diagnostic(RuntimeError('模型准备失败'), error, operation, phase) from None
    finally:
        if fs is not None:
            active_error = sys.exc_info()[1]
            try:
                fs.close()
            except Exception as cleanup_error:
                phase = progress.current_phase if progress is not None else 'checking'
                _emit_diagnostic(cleanup_error, 'cleanup', phase, secondary=active_error is not None)
                if active_error is None:
                    if isinstance(cleanup_error, OSError):
                        raise _safe_io_error(cleanup_error, 'cleanup', phase) from None
                    raise _inherit_diagnostic(RuntimeError('模型资源清理失败'), cleanup_error, 'cleanup', phase) from None

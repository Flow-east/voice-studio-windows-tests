"""Hold the real published downloader's directory handles; no network IO."""
import ctypes
import importlib.util
import json
from pathlib import Path
import sys

module_path, model_root, state_path = sys.argv[1:]
spec = importlib.util.spec_from_file_location('published_model_download', module_path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
if not module.IS_WINDOWS:
    raise RuntimeError('Native Windows required')
files = None
try:
    files = module._Files(Path(model_root), 'domestic')
    # Unlike the exclusive-file synthetic test, no handle to setup-state.json
    # is retained by this process. Check an exclusive open, then close it.
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.CreateFileW.argtypes = [ctypes.c_wchar_p, ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p, ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p]
    kernel.CreateFileW.restype = ctypes.c_void_p
    kernel.CloseHandle.argtypes = [ctypes.c_void_p]
    kernel.CloseHandle.restype = ctypes.c_int32
    handle = kernel.CreateFileW(state_path, 0xC0000000, 0, None, 3, 0x80, None)
    opened = handle != ctypes.c_void_p(-1).value
    winerror = None if opened else ctypes.get_last_error()
    if opened:
        assert kernel.CloseHandle(handle)
    print(json.dumps({'phase':'held','python':sys.version.split()[0], 'actualPublishedWindowsFiles':True, 'heldAncestorHandles':len(files.windows.handles), 'exclusiveStateOpen':opened,'exclusiveStateOpenWinerror':winerror}),flush=True)
    sys.stdin.readline()
finally:
    if files is not None:
        files.close()
print(json.dumps({'phase':'released'}),flush=True)

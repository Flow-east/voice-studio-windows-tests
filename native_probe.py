"""Run model downloader fixtures on real Windows; no network/model is used.

Each source directory contains only model_download.py. The unchanged Windows
API implementation is exercised. Only model metadata and HTTP responses are
fixtures. One separately labelled case injects a rename error to test recovery.
"""
import argparse
import ctypes
import hashlib
import importlib.util
import io
import json
import platform
from pathlib import Path
import sys
import tempfile
import traceback
from unittest.mock import patch


CONTENT = b'{"model_type":"fixture","value":12345}'
OLD_TARGET = b'old-invalid-model'
PATH_CASES = [
    ('ascii', 'models/asr', ['config.json']),
    ('nested', 'models/asr', ['config.json', 'tokenizer/config.json']),
    ('unicode_file', 'models/asr', ['config.json', '\u6a21\u578b/\u914d\u7f6e.json']),
    ('unicode_root', '\u6a21\u578b/asr', ['config.json', 'tokenizer/config.json']),
    ('spaces', 'models with spaces/asr', ['config.json', 'tokenizer with spaces/config.json']),
]


def load_runtime(directory, role):
    path = Path(directory) / 'model_download.py'
    spec = importlib.util.spec_from_file_location('probe_' + role, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module, hashlib.sha256(path.read_bytes()).hexdigest()


def file_entry(name):
    return {'path': name, 'size': len(CONTENT),
            'gitBlobSha1': hashlib.sha1(b'blob ' + str(len(CONTENT)).encode() + b'\0' + CONTENT).hexdigest(),
            'modelscope': {'revision': 'a' * 40, 'sha256': hashlib.sha256(CONTENT).hexdigest()}}


class Response(io.BytesIO):
    def __init__(self, offset):
        super().__init__(CONTENT[offset:])
        self.status = 206 if offset else 200
        self.headers = {'Content-Length': str(len(CONTENT) - offset)}
        if offset:
            self.headers['Content-Range'] = f'bytes {offset}-{len(CONTENT) - 1}/{len(CONTENT)}'


def safe_error(error):
    # Never serialize exception text or local absolute paths into CI artifacts.
    result = {'type': type(error).__name__}
    result['frames'] = [{'file': Path(frame.filename).name, 'line': frame.lineno, 'function': frame.name}
                        for frame in traceback.extract_tb(error.__traceback__)[-8:]]
    for name in ('errno', 'winerror'):
        value = getattr(error, name, None)
        if type(value) is int:
            result[name] = value
    status = getattr(error, '_studio_ntstatus', None)
    if isinstance(status, str) and len(status) == 10 and status.startswith('0x'):
        result['ntstatus'] = status
    diagnostic = getattr(error, '_studio_diagnostic', {})
    if isinstance(diagnostic, dict):
        for name in ('operation', 'phase'):
            if isinstance(diagnostic.get(name), str):
                result[name] = diagnostic[name]
    return result


def run_case(module, label, folder, names, *, cached_bytes=None, invalid_target=False, fail_once=False):
    entries = [file_entry(name) for name in names]
    manifest = {'repo': 'fixture/test', 'revision': 'a' * 40, 'files': entries,
                'totalBytes': len(CONTENT) * len(entries)}
    requests, phases = [], []
    failure_state = {'remaining': 1 if fail_once else 0}
    native = module._WindowsNative

    class FailOnceNative(native):
        def replace(self, *args, **kwargs):
            if failure_state['remaining']:
                failure_state['remaining'] -= 1
                error = ctypes.WinError(32)
                if hasattr(module, '_annotate_error'):
                    error = module._annotate_error(error, 'nt_rename', ctypes.c_int32(0xC0000043).value)
                raise error
            return super().replace(*args, **kwargs)

    def request(_url, headers):
        offset = int(headers['Range'][6:-1]) if headers.get('Range') else 0
        assert 0 <= offset < len(CONTENT)
        requests.append({'offset': offset, 'responseBytes': len(CONTENT) - offset})
        return Response(offset)

    def emit(_kind, phase, **_details):
        phases.append(phase)

    result = {'label': label, 'cachedBytesPerFile': cached_bytes,
              'renameFaultInjected': fail_once, 'ok': False}
    with tempfile.TemporaryDirectory(prefix='voice-native-probe-') as temporary:
        root = Path(temporary) / folder
        root.mkdir(parents=True)
        for entry in entries:
            if cached_bytes is not None:
                partial = root / module._partial_name(entry, 'domestic')
                partial.parent.mkdir(parents=True, exist_ok=True)
                partial.write_bytes(CONTENT[:cached_bytes])
            if invalid_target:
                target = root / entry['path']
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(OLD_TARGET)
        with patch.object(module, 'model_manifest', return_value=manifest), \
             patch.object(module, '_request', side_effect=request), \
             patch.object(module, '_WindowsNative', FailOnceNative if fail_once else native):
            if fail_once:
                try:
                    module.download_models('asr', root, backend='torch', emit=emit)
                    result['unexpectedFaultSuccess'] = True
                    return result
                except Exception as error:
                    result['injectedFailure'] = safe_error(error)
                    result['completeCachePreserved'] = all(
                        (root / module._partial_name(entry, 'domestic')).exists() and
                        (root / module._partial_name(entry, 'domestic')).read_bytes() == CONTENT for entry in entries)
                    result['existingTargetPreserved'] = all((root / name).read_bytes() == OLD_TARGET for name in names)
                    result['orphanStageFiles'] = [p.relative_to(root).as_posix() for p in root.rglob('*')
                        if p.is_file() and '.cache' not in p.relative_to(root).parts and p.relative_to(root).as_posix() not in names]
                    result['requestsBeforeRetry'] = len(requests)
            try:
                first = module.download_models('asr', root, backend='torch', emit=emit)
                first_requests = len(requests)
                second = module.download_models('asr', root, backend='torch', emit=emit)
                result.update(ok=True, files=len(first), cachedFiles=len(second),
                    verified=all((root / name).read_bytes() == CONTENT for name in names),
                    requestsDuringCacheReuse=len(requests) - first_requests,
                    oldPartialRemoved=all(not (root / module._partial_name(entry, 'domestic')).exists() for entry in entries))
            except Exception as error:
                result['error'] = safe_error(error)
                result['completeCachePreserved'] = all(
                    (root / module._partial_name(entry, 'domestic')).exists() and
                    (root / module._partial_name(entry, 'domestic')).read_bytes() == CONTENT for entry in entries)
    result['requests'], result['phases'] = requests, phases
    return result


def validate_candidate(case):
    if not case.get('ok') or not case.get('verified') or case.get('requestsDuringCacheReuse') != 0:
        return False
    cached = case['cachedBytesPerFile']
    if cached == len(CONTENT) and case['requests']:
        return False
    if cached == len(CONTENT) and not case.get('oldPartialRemoved'):
        return False
    if cached is None and (len(case['requests']) != case['files'] or any(r['offset'] for r in case['requests'])):
        return False
    if cached == 10 and case['requests'] != [{'offset': 10, 'responseBytes': len(CONTENT) - 10}]:
        return False
    if case['renameFaultInjected']:
        return (case.get('injectedFailure', {}).get('winerror') == 32
                and case.get('completeCachePreserved') is True
                and case.get('existingTargetPreserved') is True
                and case.get('orphanStageFiles') == [] and case.get('requestsBeforeRetry') == 0)
    return True


def run_role(module, role):
    cases = []
    for label, folder, files in PATH_CASES:
        cases.append(run_case(module, label + '_complete_cache', folder, files, cached_bytes=len(CONTENT)))
        cases.append(run_case(module, label + '_fresh_download', folder, files))
    if role == 'candidate':
        cases.append(run_case(module, 'partial_cache_range_resume', 'models/asr', ['config.json'], cached_bytes=10))
        cases.append(run_case(module, 'replace_invalid_target_from_complete_cache', 'models/asr', ['config.json'],
                              cached_bytes=len(CONTENT), invalid_target=True))
        cases.append(run_case(module, 'rename_failure_preserves_cache_and_target_then_retry', 'models/asr', ['config.json'],
                              cached_bytes=len(CONTENT), invalid_target=True, fail_once=True))
    return cases


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--baseline', required=True)
    parser.add_argument('--candidate', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    output = {'platform': sys.platform, 'python': platform.python_version(),
              'windows': list(platform.win32_ver()), 'machine': platform.machine(),
              'network': 'stubbed in-memory fixture responses only',
              'winePatches': False, 'windowsApiContractSimulation': False}
    if sys.platform != 'win32':
        output.update(status='refused_non_windows', candidatePassed=False)
        Path(args.output).write_text(json.dumps(output, indent=2) + '\n', encoding='utf-8')
        print('REFUSED: this harness requires native Windows; no tests were counted as passed.')
        return 2
    if hasattr(ctypes.WinDLL('ntdll'), 'wine_get_version'):
        output.update(status='refused_wine', candidatePassed=False)
        Path(args.output).write_text(json.dumps(output, indent=2) + '\n', encoding='utf-8')
        print('REFUSED: Wine is not native Windows; no tests were counted as passed.')
        return 2
    try:
        for role in ('baseline', 'candidate'):
            module, digest = load_runtime(getattr(args, role), role)
            cases = run_role(module, role)
            output[role] = {'sourceSha256': digest, 'cases': cases}
        output['baselineReproducedSharingViolation'] = any(
            row.get('error', {}).get('winerror') == 32 for row in output['baseline']['cases'])
        output['candidatePassed'] = all(validate_candidate(row) for row in output['candidate']['cases'])
        output['status'] = 'passed' if output['candidatePassed'] else 'failed'
    except Exception as error:
        output.update(status='harness_error', candidatePassed=False, harnessError=safe_error(error))
    Path(args.output).write_text(json.dumps(output, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'status': output['status'], 'candidatePassed': output['candidatePassed'],
                      'baselineReproducedSharingViolation': output.get('baselineReproducedSharingViolation')}, ensure_ascii=True))
    return 0 if output['candidatePassed'] else 1


if __name__ == '__main__':
    raise SystemExit(main())

"""Installed only in the test venv; replace external HTTP, never runtime logic."""
import io
import json
from pathlib import Path
import sys
import time
import urllib.error
import urllib.parse

config = json.loads(Path(__file__).with_name('voice_fixture_config.json').read_text())
sys.path.insert(0, config['runtime'])
import model_download

class Response(io.BytesIO):
    def __init__(self, body, offset, delay):
        super().__init__(body[offset:])
        self.delay = delay
        self.status = 206 if offset else 200
        self.headers = {'Content-Length': str(len(body) - offset)}
        if offset:
            self.headers['Content-Range'] = f'bytes {offset}-{len(body)-1}/{len(body)}'
    def read1(self, size=-1):
        if self.delay:
            time.sleep(self.delay)
        return super().read(min(size, 65536))

def request(url, headers):
    parsed = urllib.parse.urlsplit(url)
    source = 'domestic' if parsed.hostname == 'modelscope.cn' else 'overseas'
    if source == 'domestic':
        name = urllib.parse.parse_qs(parsed.query)['FilePath'][0]
    else:
        name = urllib.parse.unquote(parsed.path.split('/resolve/', 1)[1].split('/', 1)[1])
    assert name in config['files'], 'Unexpected model request'
    offset = int(headers['Range'][6:-1]) if headers.get('Range') else 0
    print('FIXTURE_HTTP ' + json.dumps({'source':source,'file':name,'offset':offset}), file=sys.stderr, flush=True)
    if config['mode'] == 'fallback' and source == 'domestic':
        raise urllib.error.HTTPError(url, 503, 'fixture unavailable', {}, None)
    body = (Path(config['payloadRoot']) / name).read_bytes()
    assert 0 <= offset < len(body)
    return Response(body, offset, 0.25 if config['mode'] in ('slow', 'partial') and name.endswith('.safetensors') else 0)

# This is the sole production callable replaced by the fixture.
model_download._request = request

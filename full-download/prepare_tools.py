"""Fetch the exact production uv archive once; no install scripts are run."""
import hashlib
from pathlib import Path
import urllib.request
import zipfile
import io
root=Path('full-download-tools');root.mkdir(exist_ok=True)
url='https://github.com/astral-sh/uv/releases/download/0.11.2/uv-x86_64-pc-windows-msvc.zip'
expected='171b7ccda1bbd562da6babeffcf533a1c6cc7862cf998da826e1db534fc43e48'
with urllib.request.urlopen(url,timeout=60) as response:data=response.read(40*1024*1024+1)
assert len(data)<=40*1024*1024 and hashlib.sha256(data).hexdigest()==expected
with zipfile.ZipFile(io.BytesIO(data)) as archive:
    (root/'uv.exe').write_bytes(archive.read('uv.exe'))
print('Verified production uv executable fixture')
# Use exactly the published lockfile's ffmpeg wheel hashes.
import re,subprocess,sys
lock=Path('released-0.2.6/runtime/requirements/asr-windows-x64.lock').read_text()
entry=re.search(r'(?m)^imageio-ffmpeg==[^\n]+(?:\n    --hash=[^\n]+)*',lock)
assert entry is not None
requirements=root/'ffmpeg-requirements.txt';requirements.write_text(entry.group(0)+'\n')
subprocess.run([sys.executable,'-m','pip','install','--disable-pip-version-check','--no-deps','--require-hashes','--only-binary=:all:','-r',str(requirements)],check=True)

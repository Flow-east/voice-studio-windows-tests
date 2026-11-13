"""Fetch immutable published 0.2.5 fixture, hash-check then extract; no scripts."""
import hashlib
import io
from pathlib import Path, PurePosixPath
import tarfile
import urllib.request
url = 'https://registry.npmjs.org/cortico-world-local-voice-studio/-/cortico-world-local-voice-studio-0.2.5.tgz'
expected = 'f69980fd1e0c510c8f822233c0ac1f71c245e39e99d3e95298aa4cb301cd5cd8'
with urllib.request.urlopen(url, timeout=30) as response:
    data = response.read(2 * 1024 * 1024)
assert hashlib.sha256(data).hexdigest() == expected
root = Path('released-state').resolve()
with tarfile.open(fileobj=io.BytesIO(data)) as archive:
    for member in archive.getmembers():
        name = PurePosixPath(member.name)
        assert member.isfile() and name.parts[0] == 'package'
        assert not name.is_absolute() and '..' not in name.parts
        target = root.joinpath(*name.parts[1:])
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(archive.extractfile(member).read())
print('Verified public package 0.2.5; no install scripts executed.')

# World regression tests validate packaged runtime/default-voice presence.
# Materialize unchanged fixtures from the verified public tarball, rather than
# weakening production prerequisites or uploading a second copy of media.
import json
import shutil
fixtures = ['runtime/torch_speech.py', 'runtime/torch_transcribe.py', 'runtime/torch_reference.py', 'runtime/sing.py', 'assets/default-voice/metadata.json', 'assets/default-voice/reference.wav']
hashes = json.loads(Path('candidate-package-source-hashes.json').read_text())
for name in fixtures:
    source = root / name
    assert hashlib.sha256(source.read_bytes()).hexdigest() == hashes[name]
    target = Path('candidate-package') / name
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, target)
print('Loaded unchanged public runtime/default-voice fixtures, hash verified.')

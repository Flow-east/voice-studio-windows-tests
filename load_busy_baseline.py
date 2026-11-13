"""Load the immutable public 0.2.4 baseline, without executing install scripts."""
import hashlib
import io
from pathlib import Path, PurePosixPath
import tarfile
import urllib.request

url = 'https://registry.npmjs.org/cortico-world-local-voice-studio/-/cortico-world-local-voice-studio-0.2.4.tgz'
expected = 'b81c41859b83b04fafd7bf842e89295cdbf9716c04c6f8b981d1b7a83a28ed7e'
with urllib.request.urlopen(url, timeout=30) as response:
    data = response.read(2 * 1024 * 1024)
assert hashlib.sha256(data).hexdigest() == expected
root = Path('released-busy').resolve()
with tarfile.open(fileobj=io.BytesIO(data)) as archive:
    for member in archive.getmembers():
        name = PurePosixPath(member.name)
        assert member.isfile() and name.parts[0] == 'package'
        assert not name.is_absolute() and '..' not in name.parts
        target = root.joinpath(*name.parts[1:])
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(archive.extractfile(member).read())
print('Verified public package 0.2.4; no install scripts executed.')

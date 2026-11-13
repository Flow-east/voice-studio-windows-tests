"""Load only the public, hash-pinned 0.2.3 package for isolated CI probes."""
import hashlib
import io
from pathlib import Path, PurePosixPath
import tarfile
import urllib.request

url = 'https://registry.npmjs.org/cortico-world-local-voice-studio/-/cortico-world-local-voice-studio-0.2.3.tgz'
expected = '6460434aa81a920b783d81e1899f85870a604bacce1474b6e62e1466d1bc484d'
with urllib.request.urlopen(url, timeout=30) as response:
    data = response.read(2 * 1024 * 1024)
assert hashlib.sha256(data).hexdigest() == expected
root = Path('released').resolve()
with tarfile.open(fileobj=io.BytesIO(data)) as archive:
    for member in archive.getmembers():
        name = PurePosixPath(member.name)
        assert member.isfile() and name.parts[0] == 'package'
        assert not name.is_absolute() and '..' not in name.parts
        target = root.joinpath(*name.parts[1:])
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(archive.extractfile(member).read())
print('Verified public package 0.2.3; no install scripts executed.')

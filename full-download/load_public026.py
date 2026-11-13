"""Hash-pinned published package; no npm or package install scripts."""
import hashlib,io,tarfile,urllib.request
from pathlib import Path,PurePosixPath
expected='66631282f3bb9833464a98d31a668a11fd35b318a634118058dd812aa538b25e'
with urllib.request.urlopen('https://registry.npmjs.org/cortico-world-local-voice-studio/-/cortico-world-local-voice-studio-0.2.6.tgz',timeout=30) as response:data=response.read(2*1024*1024)
assert hashlib.sha256(data).hexdigest()==expected
root=Path('released-0.2.6').resolve()
with tarfile.open(fileobj=io.BytesIO(data)) as archive:
    for member in archive.getmembers():
        name=PurePosixPath(member.name)
        assert member.isfile() and name.parts[0]=='package' and not name.is_absolute() and '..' not in name.parts
        target=root.joinpath(*name.parts[1:]);target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(archive.extractfile(member).read())
print('Verified immutable public0.2.6')

# Overlay only explicitly hash-pinned candidate files onto the public package.
import json,shutil
manifest_path=Path('full-download-overlay/hashes.json')
if manifest_path.is_file():
    candidate=Path('full-download-candidate')
    shutil.copytree(root,candidate)
    for name,digest in json.loads(manifest_path.read_text()).items():
        relative=PurePosixPath(name)
        assert not relative.is_absolute() and '..' not in relative.parts
        source=Path('full-download-overlay').joinpath(*relative.parts)
        assert hashlib.sha256(source.read_bytes()).hexdigest()==digest
        target=candidate.joinpath(*relative.parts);target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(source,target)
    print('Verified candidate overlay source hashes')

# Voice Studio Windows file operation regression

This isolated test repository compares the published 0.2.2 model downloader
with a candidate fix on native Windows Server 2022 and 2025 runners.

Only the downloader source, synthetic test fixtures, this workflow, and its
license are included. No user reports, recordings, account configuration,
credentials, model weights, or personal filesystem paths are uploaded.

The tests exercise real Windows file handles and rename operations. Synthetic
responses replace model network traffic. A passing test validates file
creation, hash verification, publication and cache reuse, not a complete ASR
or TTS model installation or inference run, and not Windows 10 build 19045.

Run locally on Windows with Python 3.11:

```powershell
python native_probe.py --baseline baseline --candidate candidate --output results.json
```

Each standard GitHub-hosted Windows job is limited to 10 minutes. The workflow
requires read-only repository access, does not receive deployment secrets,
and does not publish or install a plugin on anyone's computer.

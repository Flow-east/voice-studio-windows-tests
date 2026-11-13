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

## Process-stop investigation branch

The manual workflow on this branch downloads the already public 0.2.2 npm
archive and verifies its fixed SHA-256 before reading its process helper. No
package install scripts run. Four short-lived synthetic process trees observe
normal cancellation, parent-exit timing, a known surviving descendant, and a
deliberately paused output stream. Only this probe's own parent PID is passed
to taskkill; child fixtures also exit on a control file or after 15 seconds.

These observations distinguish possible stop outcomes. They do not establish
which occurred on a reporter's machine. Pausing stdout is an explicit test
condition and must not be presented as behavior observed in the product.

The surviving-descendant control uses a detached child with independent stdio
and asserts it is alive at cancellation settlement. This prevents parent/pipe
closure from being mistaken for proof that the whole process tree is gone.
Node 24 is selected to match the reporter's runtime major version.

# Voice Studio Windows regression tests

This public test repository compares the published 0.2.2 downloader and process
helpers with a 0.2.3 candidate on standard Windows Server 2022 and 2025 runners.
The owner explicitly authorized the candidate plugin source and synthetic tests
on this branch. No user reports, recordings, account configuration, credentials,
model weights, or personal filesystem paths are uploaded.

## Download regression

The downloader probe uses real Windows file handles and rename operations with
small synthetic network responses. It covers publication, hash verification,
cache reuse, resume, target replacement and retry. It does not run model inference.

## Process regression

The process probe downloads the public 0.2.2 npm archive after verifying its fixed
SHA-256, without running install scripts. Six candidate cases exercise cancellation,
parent-exit timing, an independently detached descendant, immediate cancel during
startup, supervisor termination without final proof, and control-channel EOF.
A separate ManagedEngine probe checks normal exit, cancel and retry. All fixture
processes are created by the probe, have bounded lifetimes, and are explicitly
cleaned up. It never targets a process discovered elsewhere on the runner.

The candidate creates an OS Job before the target runs, and verifies the complete
process tree is empty before clearing stop guards. A separate startup profiler
measures PowerShell phases under controlled environment variants; it emits fixed
phase names/timings, never raw environment values, arguments or private control data.

Candidate source hashes are recorded in candidate-package-source-hashes.json.
Node 24 matches the reporter runtime's major version. Passing these tests does not
establish which historical branch occurred on a user's machine or validate complete
model installation/inference on Windows 10 build 19045.

Workflows run manually with read-only repository access on standard hosted runners.
They have bounded timeouts, receive no deployment secrets, and do not publish or
install the plugin on anyone's computer.

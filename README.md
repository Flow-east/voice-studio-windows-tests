# Voice Studio Windows regression tests

This owner-authorized public repository contains synthetic tests and candidate
plugin source. It contains no user reports, recordings, credentials, model
weights, or personal filesystem paths.

## Current 0.2.4 startup recovery candidate

The current manual workflow runs on standard Windows Server 2022/2025 with Node
24. It loads the hash-pinned public 0.2.3 archive without install scripts and
reproduces an uncaught filesystem failure escaping a Node event callback. The
baseline child stream is synthetic; the filesystem error and host exit are real.

The candidate removes the Windows Job wrapper and returns to direct process
launches. Windows startup no longer starts model preparation automatically.
Sixteen tests per OS cover event-callback failures with real worker processes,
stop denial, final persistence failure and retry, explicit manual setup, and a
fresh host after forced termination. Diagnostics and process safety guards are
retained. Tests do not download model weights or run inference.

All candidate file hashes are recorded in candidate-package-source-hashes.json.
The workflow is bounded, read-only, and receives no deployment secrets. It does
not install or change a plugin on anyone's computer. The tests establish the
controlled behavior, not the reporter's exact historical crash cause or complete
Coopanion installation on Windows 10 build 19045.

Previous commits retain the 0.2.3 downloader sharing/rename tests and now-withdrawn
Job-supervisor experiments. The downloader repair is unchanged in 0.2.4. Historical
Job test passes are not claims about the current process-management implementation.

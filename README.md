# Native Windows progress-cache tests

Synthetic reproduction of exclusive `setup-state.json` locks while the real
managed-engine prepare/command lifecycle runs in a separate Node host.
PowerShell holds FileShare.None through worker completion and preparation
settlement; a tiny synthetic model fixture passes the actual marker/readiness
checks. No model download, inference, user data, proxy settings, or credentials
are used. The only baseline network fetch is the hash-pinned published npm
0.2.5 tarball. Candidate source byte hashes are checked before tests.

Scenarios compare the published baseline failure with successful preparation,
post-unlock persistence recovery, retained worker checksum failure, and prompt
cancellation. Existing startup, callback, diagnostics, and bounded-retry tests
also run. Windows Server 2022 and 2025 are CI coverage, not a claim of testing
the reporting user's Windows 10 machine.

Historical harnesses remain in this repository for earlier releases.

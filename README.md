# Native Windows preparation validation

This branch validates the Windows memory-only progress change against an
immutable hash-pinned public 0.2.6 baseline. The full preparation methods and
Python model worker are unmodified. Test-only substitutions are a tiny valid
ASR manifest, in-memory HTTP responses, and prevalidated environment markers.
A real Python venv, production uv binary and locked imageio-ffmpeg are used.
No actual model weights or inference libraries are downloaded.

Final scenarios cover fast/slow transfers, partial resume, fallback, cache reuse
and an independently held FileShare.None legacy state file throughout the real
preparation. Candidate success must leave that legacy file untouched, create no
state file in fresh roots, and obtain readiness from actual validated markers.
Separate fault injection tests verify zero Windows state-file access and
preservation of actual model/config/log failures.

Node 24.21.0 and Python 3.11.9 run on Windows Server 2022 and 2025. This is not
the reporting user's Windows 10/Python 3.11.13 machine or a full inference test.
Historical harnesses are retained for audit; only the current workflow is run.

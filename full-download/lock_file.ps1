param(
  [Parameter(Mandatory=$true)][string]$Path,
  [Parameter(Mandatory=$true)][string]$ReleaseMarker,
  [Parameter(Mandatory=$true)][string]$StopMarker,
  [int]$HoldMs = 1500
)
$ErrorActionPreference = 'Stop'
$stream = $null
try {
  $stream = [System.IO.File]::Open($Path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
  [Console]::Out.WriteLine('LOCK_READY')
  [Console]::Out.Flush()
  $clock = [System.Diagnostics.Stopwatch]::StartNew()
  while ($clock.ElapsedMilliseconds -lt $HoldMs -and -not [System.IO.File]::Exists($StopMarker)) {
    [System.Threading.Thread]::Sleep(20)
  }
} finally {
  if ($null -ne $stream) { $stream.Dispose() }
}
[System.IO.File]::WriteAllText($ReleaseMarker, 'released')
[Console]::Out.WriteLine('LOCK_RELEASED')
[Console]::Out.Flush()

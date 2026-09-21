# build.ps1 - compile the Mantle sidecar with the csc.exe that ships with Windows.
#
# WHY csc.exe and not `dotnet build`: there is no .NET SDK on this machine and
# Mantle must stay buildable on a clean Windows box. The C# 5 compiler in
# Microsoft.NET\Framework64 has been in every Windows install since Windows 8,
# so the sidecar has no toolchain to install and no project file to keep.
# Consequence for anyone editing the .cs files: C# 5 ONLY - no string
# interpolation, no nameof, no expression-bodied members, no `out var`.
#
# /target:winexe matters: a console subsystem exe would flash a black window
# every time Electron starts the sidecar. winexe means no console is ever
# created, while a redirected stdin/stdout still works exactly the same - which
# is the only channel we use.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File sidecar/build.ps1
#
# Exits non-zero (and prints csc's own errors) when the build fails.

$ErrorActionPreference = 'Continue'

# Every path is resolved from THIS script's folder, so the build works from any
# working directory (npm scripts, the test harness, or a bare shell).
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$bin  = Join-Path $here 'bin'
$out  = Join-Path $bin 'Mantle.Sidecar.exe'
$csc  = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'

if (-not (Test-Path $csc)) {
  Write-Output "sidecar build FAILED: no C# compiler at $csc"
  Write-Output "  (the .NET Framework 4 compiler is part of Windows; a missing one means a broken install)"
  exit 1
}

if (-not (Test-Path $bin)) { New-Item -ItemType Directory -Path $bin | Out-Null }

$sources = @(Get-ChildItem -Path (Join-Path $here '*.cs') | ForEach-Object { $_.FullName })
if ($sources.Count -eq 0) {
  Write-Output "sidecar build FAILED: no .cs files in $here"
  exit 1
}

$cscArgs = @(
  '/target:winexe',
  '/optimize+',
  '/nologo',
  "/out:$out",
  '/r:System.dll',
  '/r:System.Core.dll',
  '/r:System.Drawing.dll',
  '/r:System.Windows.Forms.dll'
) + $sources

& $csc $cscArgs
$code = $LASTEXITCODE

if ($code -ne 0) {
  Write-Output "sidecar build FAILED (csc exit $code)"
  exit $code
}

$size = (Get-Item $out).Length
Write-Output "sidecar built: $out ($size bytes, $($sources.Count) source files)"
exit 0

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

# System.Management is the ONLY user-mode way to move a monitor's backlight
# (root\wmi WmiMonitorBrightnessMethods), for the `brightness` command.
$cscArgs = @(
  '/target:winexe',
  '/optimize+',
  '/nologo',
  "/out:$out",
  '/r:System.dll',
  '/r:System.Core.dll',
  '/r:System.Drawing.dll',
  '/r:System.Management.dll',
  '/r:System.Windows.Forms.dll'
)

# WinRT, for `bluetooth` ONLY. There is no Win32 API that can switch a
# Bluetooth radio: Windows.Devices.Radios.Radio is the only supported switch,
# and reaching it from a .NET Framework exe needs two things -
#
#   Windows.Devices.winmd      the metadata for the WinRT types themselves
#                              (Windows.Foundation.winmd comes with it, for the
#                              IAsyncOperation the radio calls return).
#   System.Runtime.WindowsRuntime.dll   the .AsTask() bridge that turns those
#                              IAsyncOperations into Tasks this synchronous
#                              code can wait on with a timeout.
#   System.Runtime.dll (the facade)     MEASURED, not guessed: without it this
#                              compiler answers "error CS0012: the type
#                              System.Attribute is defined in an assembly that
#                              is not referenced" when it reads the winmd. The
#                              facade is in the GAC on any .NET 4.5+ machine.
#
# Both SHIP WITH WINDOWS, so there is still nothing to install - but if a
# machine is missing either one, the build must not fail: MANTLE_WINRT is left
# undefined and Bluetooth.cs falls back to spawning powershell.exe, which is
# slower and says so in its reply (via:'powershell').
# MEASURED ON THIS MACHINE, 2026-09-21, and it is the reason the fallback
# exists: the split winmds in C:\Windows\System32\WinMetadata are NOT enough.
# System.Runtime.WindowsRuntime's AsTask() extensions are compiled against the
# UNION metadata assembly whose identity is plain "Windows, Version=255.255.
# 255.255", so csc answers "IAsyncOperation`1 is defined in an assembly that is
# not referenced: Windows" and the build fails. That union file
# (UnionMetadata\...\Windows.winmd) ships with the WINDOWS SDK, not with
# Windows, and there is no SDK here - so MANTLE_WINRT stays undefined and
# Bluetooth.cs uses its PowerShell fallback, which says via:'powershell' in
# every reply. Install the Windows SDK and this build picks the fast route up
# automatically, with no code change.
$union = @()
foreach ($d in @('C:\Program Files (x86)\Windows Kits\10\UnionMetadata',
                 'C:\Program Files\Windows Kits\10\UnionMetadata')) {
  if (Test-Path $d) {
    $union += Get-ChildItem $d -Recurse -Filter 'Windows.winmd' -ErrorAction SilentlyContinue |
              Sort-Object FullName -Descending | Select-Object -ExpandProperty FullName
  }
}
$unionWinmd = if ($union.Count) { $union[0] } else { $null }
$wrt = Get-ChildItem 'C:\Windows\Microsoft.NET\assembly\GAC_MSIL\System.Runtime.WindowsRuntime' `
        -Recurse -Filter 'System.Runtime.WindowsRuntime.dll' -ErrorAction SilentlyContinue |
       Select-Object -First 1 -ExpandProperty FullName
$facade = Get-ChildItem 'C:\Windows\Microsoft.NET\assembly\GAC_MSIL\System.Runtime' `
        -Recurse -Filter 'System.Runtime.dll' -ErrorAction SilentlyContinue |
       Select-Object -First 1 -ExpandProperty FullName

if ($unionWinmd -and $wrt -and $facade) {
  $cscArgs += @("/r:$unionWinmd", "/r:$wrt", "/r:$facade", '/define:MANTLE_WINRT')
  Write-Output "sidecar build note: bluetooth uses the in-process WinRT route ($unionWinmd)"
} else {
  # Single quotes: a backtick inside a double-quoted PowerShell string is an
  # ESCAPE character, so "`b" would become a backspace in this message.
  Write-Output 'sidecar build note: bluetooth will use the slower PowerShell route (it says via:powershell in its reply)'
  if (-not $unionWinmd) { Write-Output '  missing: UnionMetadata\Windows.winmd - it comes with the Windows SDK, not with Windows' }
  if (-not $wrt) { Write-Output '  missing: System.Runtime.WindowsRuntime.dll in the GAC' }
  if (-not $facade) { Write-Output '  missing: the System.Runtime facade in the GAC' }
}

$cscArgs += $sources

& $csc $cscArgs
$code = $LASTEXITCODE

if ($code -ne 0) {
  Write-Output "sidecar build FAILED (csc exit $code)"
  exit $code
}

$size = (Get-Item $out).Length
Write-Output "sidecar built: $out ($size bytes, $($sources.Count) source files)"
exit 0

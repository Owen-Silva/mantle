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
#   powershell -NoProfile -ExecutionPolicy Bypass -File sidecar/build.ps1 -Out sidecar/bin-next/Mantle.Sidecar.exe
#
# -Out exists because a RUNNING Mantle holds bin\Mantle.Sidecar.exe open and
# csc cannot overwrite it: build the next exe beside it, test that one
# (MANTLE_SIDECAR_EXE=... npm run test:sidecar), and swap it in while Mantle
# is stopped. A relative -Out is resolved from the current directory.
#
# Exits non-zero (and prints csc's own errors) when the build fails.
param([string]$Out = '')

$ErrorActionPreference = 'Continue'

# Every path is resolved from THIS script's folder, so the build works from any
# working directory (npm scripts, the test harness, or a bare shell).
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
if ($Out) {
  $out = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine((Get-Location).Path, $Out))
  $bin = Split-Path -Parent $out
} else {
  $bin = Join-Path $here 'bin'
  $out = Join-Path $bin 'Mantle.Sidecar.exe'
}
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
  '/r:System.Windows.Forms.dll',
  '/r:System.Data.dll',            # Search.cs: OLE DB over the Windows Search index
  '/r:System.ServiceProcess.dll',  # Search.cs: is the WSearch service running
  '/r:System.Xml.dll'              # Notifications.cs: a toast's payload is XML
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

# THE SDK-FREE ROUTE (found by the media lane, 2026-09-22): the SPLIT winmds
# that ship in System32\WinMetadata DO compile, as long as nothing uses
# System.Runtime.WindowsRuntime's AsTask (that is what drags in the union
# identity). The code awaits an IAsyncOperation through its own Completed
# callback instead (WinRt.Await in Media.cs). References: the split winmds,
# the System.Runtime facade, and System.Runtime.InteropServices.WindowsRuntime
# from beside csc. It defines MANTLE_WINMD, which Media.cs needs and which
# gives Bluetooth.cs the in-process route too.
# NEVER BOTH: the union and the split winmds define every type twice.
$wm = Join-Path $env:SystemRoot 'System32\WinMetadata'
$interop = Join-Path (Split-Path -Parent $csc) 'System.Runtime.InteropServices.WindowsRuntime.dll'
# Windows.UI + Windows.ApplicationModel + Windows.System are for Notifications.cs
# (UserNotificationListener, the AppInfo on each toast, Launcher.LaunchUriAsync).
# Windows.Graphics + Windows.Globalization are for Ocr.cs (SoftwareBitmap, and the Language
# an OcrEngine reports; Windows.Media.Ocr itself is in Windows.Media.winmd).
$split = @('Windows.Foundation.winmd', 'Windows.Media.winmd', 'Windows.Storage.winmd', 'Windows.Devices.winmd',
           'Windows.UI.winmd', 'Windows.ApplicationModel.winmd', 'Windows.System.winmd',
           'Windows.Graphics.winmd', 'Windows.Globalization.winmd') |
         ForEach-Object { Join-Path $wm $_ }
$splitOk = $facade -and (Test-Path $interop) -and (@($split | Where-Object { -not (Test-Path $_) }).Count -eq 0)

if ($unionWinmd -and $wrt -and $facade) {
  $cscArgs += @("/r:$unionWinmd", "/r:$wrt", "/r:$facade", '/define:MANTLE_WINRT')
  Write-Output "sidecar build note: bluetooth uses the in-process WinRT route ($unionWinmd)"
  Write-Output '  (media needs MANTLE_WINMD, which is only defined without the union winmd)'
} elseif ($splitOk) {
  $cscArgs += ($split | ForEach-Object { "/r:$_" }) + @("/r:$facade", "/r:$interop", '/define:MANTLE_WINMD')
  Write-Output 'sidecar build note: bluetooth and media use in-process WinRT through the split winmds in System32\WinMetadata'
} else {
  # Single quotes: a backtick inside a double-quoted PowerShell string is an
  # ESCAPE character, so "`b" would become a backspace in this message.
  Write-Output 'sidecar build note: bluetooth will use the slower PowerShell route (it says via:powershell in its reply), and media is unavailable'
  if (-not $unionWinmd) { Write-Output '  missing: UnionMetadata\Windows.winmd - it comes with the Windows SDK, not with Windows' }
  if (-not $wrt) { Write-Output '  missing: System.Runtime.WindowsRuntime.dll in the GAC' }
  if (-not $facade) { Write-Output '  missing: the System.Runtime facade in the GAC' }
  if (-not (Test-Path $interop)) { Write-Output "  missing: $interop" }
  foreach ($f in $split) { if (-not (Test-Path $f)) { Write-Output "  missing: $f" } }
}

# UI Automation, for TrayUia.cs: Windows 11's tray is XAML, so the only way to
# CLICK a shown tray icon is through UIA. The assemblies ship with .NET 4 (WPF
# folder); without them the tray can still be listed but not clicked.
$wpf = Join-Path (Split-Path -Parent $csc) 'WPF'
$uia = @('UIAutomationClient.dll', 'UIAutomationTypes.dll', 'WindowsBase.dll') | ForEach-Object { Join-Path $wpf $_ }
if (@($uia | Where-Object { -not (Test-Path $_) }).Count -eq 0) {
  $cscArgs += @($uia | ForEach-Object { "/r:$_" }) + '/define:MANTLE_UIA'
} else {
  Write-Output 'sidecar build note: tray icons can be listed but not clicked (UI Automation assemblies missing)'
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

# put-windows-back.ps1 - run by Mantle-Setup.exe and by Mantle's uninstaller BEFORE they touch a single
# installed file (installer/installer.nsh, function mantleBack). Lane inst-mantle, 2026-10-29.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File put-windows-back.ps1 -InstallDir <dir> [-Why install|uninstall]
#
# 1. If this copy's Mantle is running, ask it to put Windows back and quit (<dir>\Mantle.exe --quit): the
#    same clean road as Quit Mantle in its menu. Never a kill first: a killed Mantle is the case the restore
#    script exists for, not the way to stop it. Then wait for every process from <dir> to exit.
# 2. Run <dir>\resources\app\tools\restore-windows.ps1 (it needs no Mantle, no Node, no Electron). It stops
#    anything from <dir> that did not quit (crash-recovery supervisors first, so nothing starts Mantle again),
#    puts the taskbar's auto-hide flag, the work area, the cursor clip, the notification banners and the Windows
#    pieces back, and reads the taskbar back. It prints "verified" only when Windows is really back.
# 3. Check that nothing runs from <dir> any more (a file in use can be neither replaced nor removed).
#
# Exit 0 = Windows is back and nothing runs from <dir>. Exit 1 = it is not, and the LAST line says why: the
# installer shows that line and changes nothing. The full transcript is %TEMP%\mantle-setup-<why>.log.
# Windows PowerShell 5.1 only (no ternary, no &&): this runs on machines that have nothing else.
param(
  [Parameter(Mandatory = $true)][string]$InstallDir,
  [string]$Why = 'install',
  [int]$QuitWaitSeconds = 45
)
$ErrorActionPreference = 'Stop'

$dir = [System.IO.Path]::GetFullPath($InstallDir).TrimEnd('\')
$prefix = $dir.ToLowerInvariant() + '\'
$exe = Join-Path $dir 'Mantle.exe'
$restore = Join-Path $dir 'resources\app\tools\restore-windows.ps1'
$safeWhy = ($Why -replace '[^A-Za-z0-9_-]', '')
$logFile = Join-Path $env:TEMP ("mantle-setup-" + $safeWhy + ".log")

function Note([string]$text) {
  try { Add-Content -LiteralPath $logFile -Value ("{0:yyyy-MM-dd HH:mm:ss} {1}" -f (Get-Date), $text) -Encoding UTF8 } catch { }
}
function Say([string]$text) { Write-Output $text; Note $text }
function Fail([string]$text) { Say "Windows is NOT confirmed back: $text"; exit 1 }

# Every process whose own exe is in <dir>, except an uninstaller running in place (Uninstall Mantle.exe).
function Get-FromDir {
  @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {
    $_.ExecutablePath -and $_.ExecutablePath.ToLowerInvariant().StartsWith($prefix) -and
    -not ([System.IO.Path]::GetFileName($_.ExecutablePath) -like 'Uninstall *')
  })
}
function Describe($procs) { (@($procs) | ForEach-Object { "$($_.Name) $($_.ProcessId)" }) -join ', ' }

Note "---- ${Why}: $dir"
try { $running = Get-FromDir } catch { Fail "the process list could not be read ($($_.Exception.Message))" }
$mains = @($running | Where-Object { $_.Name -ieq 'Mantle.exe' -and -not ($_.CommandLine -match '--type=') })

# ---- 1. ask a running Mantle to put Windows back and quit
if ($mains.Count -gt 0) {
  if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { Fail "Mantle is running from $dir, but $exe is missing, so it cannot be asked to quit" }
  Say "asking Mantle (pid $(($mains | ForEach-Object { $_.ProcessId }) -join ', ')) to put Windows back and quit"
  try {
    $q = Start-Process -FilePath $exe -ArgumentList '--quit' -WorkingDirectory $dir -WindowStyle Hidden -PassThru
    if (-not $q.WaitForExit(30000)) { Note "Mantle.exe --quit did not finish in 30 s" }
  } catch { Note "Mantle.exe --quit could not be run: $($_.Exception.Message)" }
  $deadline = (Get-Date).AddSeconds($QuitWaitSeconds)
  do {
    Start-Sleep -Milliseconds 500
    try { $left = Get-FromDir } catch { $left = @() }
  } while ($left.Count -gt 0 -and (Get-Date) -lt $deadline)
  if ($left.Count -gt 0) { Say "Mantle did not finish quitting in $QuitWaitSeconds s ($(Describe $left)); the restore script stops it" }
  else { Say "Mantle quit and put Windows back" }
} elseif ($running.Count -gt 0) {
  Say "no Mantle is running, but these are, from its folder: $(Describe $running); the restore script stops them"
} else {
  Say "Mantle is not running"
}

# ---- 2. the standalone restore, which also checks
if (Test-Path -LiteralPath $restore -PathType Leaf) {
  $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $out = & $ps -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $restore 2>&1
  $code = $LASTEXITCODE
  foreach ($line in @($out)) { Note "  restore: $line" }
  $verified = @($out | Where-Object { "$_" -match '^verified' }).Count -gt 0
  if ($code -ne 0 -or -not $verified) {
    $last = @($out | ForEach-Object { "$_".Trim() } | Where-Object { $_ }) | Select-Object -Last 1
    Fail "restore-windows.ps1 exited $code ($last). Full log: $logFile"
  }
  Say "restore-windows.ps1: verified"
} elseif ($running.Count -gt 0) {
  Fail "$restore is missing, so Windows cannot be checked"
} else {
  Say "nothing installed in $dir yet, so there is nothing to put back"
}

# ---- 3. nothing may still run from the folder
try { $left = Get-FromDir } catch { Fail "the process list could not be read ($($_.Exception.Message))" }
if ($left.Count -gt 0) { Fail "these still run from $dir after the restore: $(Describe $left)" }
Say "Windows is back, and nothing runs from $dir"
exit 0

# install-autostart.ps1 - register the "Mantle" logon task (or remove it), and
# optionally start it right now through the Task Scheduler.
#
#   npm run autostart              register it (and start it now)
#   npm run autostart:remove       remove it
#   ... -Run                       also start the task now (what `npm run autostart` does)
#   ... -TaskName <name>           a different task name (default: Mantle)
#
# The task itself is tools/mantle-logon-task.xml, with {{USER}}, {{EXE}}, {{ROOT}}
# and {{LOG}} filled in here. Read that file for why it is a scheduled task and
# not a Run key. Stop a running Mantle cleanly with `npm run quit`, never with
# `schtasks /End`: that is a kill, and a killed Mantle leaves the cursor clip in
# force (tools/restore-windows.ps1 puts it back).
param([switch]$Uninstall, [switch]$Run, [string]$TaskName = 'Mantle')
$ErrorActionPreference = 'Stop'

function Say([string]$text) { Write-Output $text }
function Fail([string]$text) { Write-Output "install-autostart: $text"; exit 1 }

if ($Uninstall) {
  $out = & schtasks.exe /Delete /TN $TaskName /F 2>&1
  $delCode = $LASTEXITCODE
  # Windows' own notification pop-ups back for every app Mantle covered, whether or not the task
  # was there (restore-banners.ps1 only writes where the value is still Mantle's 0; no record = no-op).
  # A Mantle still running takes them again on its next pass, as it should while it runs.
  $bannerCode = 0
  try {
    & (Join-Path $PSScriptRoot 'restore-banners.ps1') | ForEach-Object { Say "  $_" }
    $bannerCode = $LASTEXITCODE
  } catch { $bannerCode = 1; Say "  restore-banners.ps1 failed: $($_.Exception.Message)" }
  # the Windows pieces Mantle turned off to save memory go back with it (tools\ramreclaim-undo.ps1;
  # only values still Mantle's are written; no journal = no-op)
  $piecesCode = 0
  try {
    & (Join-Path $PSScriptRoot 'ramreclaim-undo.ps1') | ForEach-Object { Say $_ }
    $piecesCode = $LASTEXITCODE
  } catch { $piecesCode = 1; Say "  ramreclaim-undo.ps1 failed: $($_.Exception.Message)" }
  if ($delCode -ne 0) { Fail "schtasks /Delete failed: $($out -join ' ')" }
  Say "removed the '$TaskName' logon task; Mantle will not start at logon any more (a running Mantle is untouched)"
  if ($bannerCode -ne 0) { Fail "the logon task is gone, but some notification pop-ups could not be put back (see above)" }
  if ($piecesCode -ne 0) { Fail "the logon task is gone, but some Windows pieces could not be put back (see above)" }
  exit 0
}

$root = Split-Path -Parent $PSScriptRoot
$template = Join-Path $PSScriptRoot 'mantle-logon-task.xml'
$exe = Join-Path $root 'node_modules\electron\dist\electron.exe'
$log = Join-Path $env:APPDATA 'mantle\mantle.log'
if (-not (Test-Path -LiteralPath $template)) { Fail "template missing: $template" }
if (-not (Test-Path -LiteralPath $exe)) { Fail "no electron.exe at $exe (run npm install in $root first)" }
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

$xml = (Get-Content -LiteralPath $template -Raw).Replace('{{USER}}', $user).Replace('{{EXE}}', $exe).Replace('{{ROOT}}', $root).Replace('{{LOG}}', $log)
$tmp = Join-Path $env:TEMP 'mantle-logon-task.xml'
# UTF-16 LE with a BOM, to match the declaration schtasks expects.
[System.IO.File]::WriteAllText($tmp, $xml, (New-Object System.Text.UnicodeEncoding($false, $true)))
try {
  $out = & schtasks.exe /Create /TN $TaskName /XML $tmp /F 2>&1
  if ($LASTEXITCODE -ne 0) { Fail "schtasks /Create failed: $($out -join ' ')" }
} finally {
  Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
}
Say "registered the '$TaskName' logon task for $user"
Say "  runs: $exe . --live --log=$log"
Say "  in:   $root, 15 s after logon, no time limit"
Say "  log:  $log"

if ($Run) {
  $out = & schtasks.exe /Run /TN $TaskName 2>&1
  if ($LASTEXITCODE -ne 0) { Fail "schtasks /Run failed: $($out -join ' ')" }
  Say "started it now through the Task Scheduler (it is not a child of this terminal)"
}

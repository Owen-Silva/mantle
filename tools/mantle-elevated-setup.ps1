# mantle-elevated-setup.ps1 - install / uninstall Mantle's Task Manager admin helper (lane tm-elevate).
#
# Windows' Task Manager silently runs as administrator. Owen chose "Always admin, no prompt": this
# script, run ONCE elevated, copies mantle.elevated.exe into an admin-only folder and registers a
# scheduled task (RunLevel Highest, on-demand, no triggers, current user, interactive token). After
# that the non-elevated Mantle sidecar runs that task and talks to the helper over a named pipe with
# no further prompt - until the helper version changes, when this is run again.
#
# THE SINGLE UAC COMMAND the main session runs WITH Owen (this whole script needs administrator):
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File <mantle-worktree>\tools\mantle-elevated-setup.ps1 -Mode install
#
# (-Verb RunAs raises the one UAC prompt; or run it from an already-elevated shell.) For the live
# install, point -Source at the built exe under mantle-live; by default it uses the exe built beside
# this repo (sidecar/elevated/bin/mantle.elevated.exe).
#
#   -Mode uninstall   removes the task and the installed folder.
#   -Mode status      prints the installed state as JSON (no admin needed).
#
# WHY admin-only folder: the exe runs elevated, so if user-level code could overwrite it, it could
# run its own code as administrator. Program Files is writable only by administrators, which closes
# that gap (the Settings elevation broker's exe is user-writable; this one is not).
param(
  [ValidateSet('install','uninstall','status')] [string]$Mode = 'status',
  [string]$Source = '',
  [string]$InstallDir = "$env:ProgramFiles\Mantle\Elevated",
  [string]$TaskName = 'Mantle Elevated Helper'
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path            # tools
$repo = Split-Path -Parent $here                                   # the mantle worktree root
$exeName = 'mantle.elevated.exe'
$installedExe = Join-Path $InstallDir $exeName
$versionFile  = Join-Path $InstallDir 'version.txt'
$srcVersion = (Get-Content (Join-Path $repo 'sidecar\elevated\VERSION') -Raw).Trim()

function Test-Admin {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)
}

function Get-Status {
  $haveExe = Test-Path $installedExe
  $ver = if (Test-Path $versionFile) { (Get-Content $versionFile -Raw).Trim() } else { $null }
  $task = $null
  try { $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction Stop } catch {}
  $installed = [bool]($haveExe -and $ver -and $task)
  $stale = [bool]($installed -and $ver -ne $srcVersion)
  [pscustomobject]@{
    installed = $installed
    version   = $ver
    expected  = $srcVersion
    stale     = $stale
    task      = [bool]$task
    exe       = $haveExe
    installDir = $InstallDir
  }
}

if ($Mode -eq 'status') {
  Get-Status | ConvertTo-Json -Compress
  exit 0
}

if (-not (Test-Admin)) {
  Write-Output "mantle-elevated-setup: '$Mode' needs administrator. Re-run elevated, e.g.:"
  Write-Output "  Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','$($MyInvocation.MyCommand.Path)','-Mode','$Mode'"
  exit 5
}

if ($Mode -eq 'uninstall') {
  try { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction Stop; Write-Output "removed task '$TaskName'" } catch { Write-Output "no task '$TaskName' to remove" }
  if (Test-Path $InstallDir) { Remove-Item -Recurse -Force $InstallDir; Write-Output "removed $InstallDir" }
  exit 0
}

# -------- install --------
if (-not $Source) { $Source = Join-Path $repo 'sidecar\elevated\bin\mantle.elevated.exe' }
if (-not (Test-Path $Source)) { Write-Output "install FAILED: no helper exe at $Source (build it: sidecar/elevated/build.ps1)"; exit 1 }

# 1. the admin-only folder. Program Files already inherits an admin-only-writable ACL; create it and
#    copy the exe + the version marker. We do NOT loosen the inherited ACL.
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Copy-Item -Force $Source $installedExe
Set-Content -Path $versionFile -Value $srcVersion -Encoding ascii -NoNewline

# 2. the scheduled task: current user, Highest, on-demand only (no triggers), interactive token so
#    the helper shares the user's session and can open a window handle if ever needed. StartWhenAvailable
#    off and no time limit matter little for an on-demand task; we set a short ExecutionTimeLimit so a
#    wedged helper cannot live forever.
$action    = New-ScheduledTaskAction -Execute $installedExe -Argument '--pipe'
$principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Highest
$settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -MultipleInstances IgnoreNew -StartWhenAvailable:$false
$task      = New-ScheduledTask -Action $action -Principal $principal -Settings $settings -Description "Mantle Task Manager admin helper (version $srcVersion). On-demand, no triggers. See sidecar/elevated."
Register-ScheduledTask -TaskName $TaskName -InputObject $task -Force | Out-Null

Write-Output "installed '$TaskName' -> $installedExe (version $srcVersion)"
Get-Status | ConvertTo-Json -Compress
exit 0

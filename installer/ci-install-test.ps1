# ci-install-test.ps1 - the install test of Mantle-Setup.exe. RUNS ON A THROWAWAY GITHUB ACTIONS RUNNER ONLY
# (.github/workflows/installer.yml): it installs, starts Mantle live, quits, kills, restores and uninstalls, and
# it changes this machine's execution policy. Never run it on a PC someone uses.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File installer/ci-install-test.ps1 -Setup <Mantle-Setup.exe> [-Live] [-Out <dir>]
#
# Every check prints "ok" or "FAIL"; the last line is the summary: "INSTALL TEST: n passed, m failed".
# The taskbar's state (Shell_TrayWnd, its auto-hide flag, the work area, the cursor clip) is read before
# anything is installed and must read the same after every way out: quit, restore, update, uninstall.
param(
  [Parameter(Mandatory = $true)][string]$Setup,
  [switch]$Live,
  [string]$Out = 'ci-out'
)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $Out | Out-Null
$Out = (Resolve-Path $Out).Path
$script:passed = 0
$script:failed = New-Object System.Collections.ArrayList
function Check([string]$name, [bool]$ok, [string]$detail = '') {
  if ($ok) { $script:passed++; Write-Output "ok   $name" }
  else { [void]$script:failed.Add($name); Write-Output "FAIL $name$(if ($detail) { " -- $detail" })" }
}
function Step([string]$text) { Write-Output ''; Write-Output "== $text" }

Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class MantleCi {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct APPBARDATA { public int cbSize; public IntPtr hWnd; public uint msg; public uint edge; public RECT rc; public IntPtr lParam; }
  [DllImport("shell32.dll")] static extern UIntPtr SHAppBarMessage(uint msg, ref APPBARDATA d);
  [DllImport("user32.dll")] static extern IntPtr FindWindow(string c, string t);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetClipCursor(out RECT r);
  [DllImport("user32.dll")] static extern bool SystemParametersInfo(uint a, uint b, ref RECT r, uint c);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int i);
  public static string State() {
    APPBARDATA d = new APPBARDATA(); d.cbSize = Marshal.SizeOf(typeof(APPBARDATA));
    IntPtr tray = FindWindow("Shell_TrayWnd", null);
    uint st = (uint)SHAppBarMessage(4, ref d);            // ABM_GETSTATE: 1 = auto-hide
    RECT clip; GetClipCursor(out clip);
    RECT wa = new RECT(); SystemParametersInfo(0x30, 0, ref wa, 0);   // SPI_GETWORKAREA
    return String.Format("tray={0} visible={1} abm={2} clip={3},{4},{5},{6} workarea={7},{8},{9},{10} screen={11}x{12}",
      tray != IntPtr.Zero, tray != IntPtr.Zero && IsWindowVisible(tray), st, clip.L, clip.T, clip.R, clip.B,
      wa.L, wa.T, wa.R, wa.B, GetSystemMetrics(0), GetSystemMetrics(1));
  }
  public static uint AbmState() { APPBARDATA d = new APPBARDATA(); d.cbSize = Marshal.SizeOf(typeof(APPBARDATA)); return (uint)SHAppBarMessage(4, ref d); }
}
'@

$inst = Join-Path $env:LOCALAPPDATA 'Programs\Mantle'
$exe = Join-Path $inst 'Mantle.exe'
$app = Join-Path $inst 'resources\app'
$menu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Mantle'
$profileDir = Join-Path $env:APPDATA 'mantle'
$log = Join-Path $profileDir 'mantle.log'
$consent = Join-Path $profileDir 'installed-consent.json'
$prefix = $inst.ToLowerInvariant() + '\'

function From-Install { @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.ToLowerInvariant().StartsWith($prefix) }) }
function Wait-Gone([int]$seconds) {
  $end = (Get-Date).AddSeconds($seconds)
  do { $left = From-Install; if ($left.Count -eq 0) { return $true }; Start-Sleep -Milliseconds 500 } while ((Get-Date) -lt $end)
  return $false
}
function Kill-All { From-Install | ForEach-Object { try { Stop-Process -Id $_.ProcessId -Force } catch { } } }
function Wait-Baseline([string]$why, [int]$seconds = 15) {
  $end = (Get-Date).AddSeconds($seconds)
  do { $now = [MantleCi]::State(); if ($now -eq $script:baseline) { break }; Start-Sleep -Milliseconds 500 } while ((Get-Date) -lt $end)
  Check "taskbar as before Mantle ($why)" ($now -eq $script:baseline) "now: $now | before: $script:baseline"
}
function Tasks { $s = New-Object -ComObject Schedule.Service; $s.Connect(); try { $s.GetFolder('\').GetTask('Mantle') } catch { $null } }
function Log-Offset { if (Test-Path -LiteralPath $log) { (Get-Item -LiteralPath $log).Length } else { 0 } }
function Wait-LiveUp([long]$from, [int]$seconds = 150) {
  $end = (Get-Date).AddSeconds($seconds)
  do {
    if (Test-Path -LiteralPath $log) {
      $fs = [System.IO.File]::Open($log, 'Open', 'Read', 'ReadWrite'); $fs.Seek([Math]::Min($from, $fs.Length), 'Begin') | Out-Null
      $text = (New-Object System.IO.StreamReader($fs)).ReadToEnd(); $fs.Close()
      if ($text -match 'features: (started|none started)') { return $true }
    }
    Start-Sleep -Seconds 1
  } while ((Get-Date) -lt $end)
  if (Test-Path -LiteralPath $log) { Write-Output '---- mantle.log (tail)'; Get-Content -LiteralPath $log -Tail 40 }
  return $false
}
function Find-Window([int]$procId, [int]$seconds) {
  $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, $procId)
  $end = (Get-Date).AddSeconds($seconds)
  do {
    $w = [System.Windows.Automation.AutomationElement]::RootElement.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
    if ($w) { return $w }
    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $end)
  return $null
}
function Named($root, [string]$name) {
  $c = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, $name)
  $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $c)
}
function AllText($root) { (@($root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)) | ForEach-Object { $_.Current.Name }) -join "`n" }
function Run-Setup([string]$why) {
  $p = Start-Process -FilePath $Setup -ArgumentList '/S' -PassThru -Wait
  Check "$why`: Mantle-Setup.exe /S exits 0" ($p.ExitCode -eq 0) "exit $($p.ExitCode)"
}
function Uninstall-Cmd {
  $k = Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' | Get-ItemProperty | Where-Object { $_.DisplayName -eq 'Mantle' } | Select-Object -First 1
  $k
}
function Start-Gate { Start-Process -FilePath $exe -WorkingDirectory $inst -PassThru }

$script:baseline = [MantleCi]::State()
Write-Output "taskbar before anything: $script:baseline"
Check 'the runner has a Windows taskbar to protect' ($script:baseline -match 'tray=True visible=True')

# ---------------------------------------------------------------- 1. install
Step 'silent install'
Run-Setup 'install'
foreach ($f in @('Mantle.exe', 'Uninstall Mantle.exe', 'resources\app\package.json', 'resources\app\main.js', 'resources\app\lib\packaged-entry.js',
                 'resources\app\sidecar\bin\Mantle.Sidecar.exe', 'resources\app\tools\restore-windows.ps1', 'resources\app\tools\restore-windows.cmd',
                 'resources\app\tools\restore-banners.ps1', 'resources\app\tools\ramreclaim-undo.ps1', 'resources\app\tools\restore-osd.ps1',
                 'resources\app\tools\install-autostart.ps1', 'resources\app\tools\mantle-logon-task.xml',
                 'resources\app\node_modules\koffi\package.json', 'resources\app\node_modules\@koromix\koffi-win32-x64\package.json',
                 'resources\app\node_modules\@mediapipe\tasks-vision\package.json')) {
  Check "installed: $f" (Test-Path -LiteralPath (Join-Path $inst $f))
}
$pkg = Get-Content -LiteralPath (Join-Path $app 'package.json') -Raw | ConvertFrom-Json
$want = (Get-Content -LiteralPath 'package.json' -Raw | ConvertFrom-Json).version
Check 'installed package.json: main is lib/packaged-entry.js' ($pkg.main -eq 'lib/packaged-entry.js') $pkg.main
Check "installed package.json: version $want" ($pkg.version -eq $want) $pkg.version
Check 'not installed: Electron as an npm package, tests, *.local, the installer sources' (-not (Test-Path (Join-Path $app 'node_modules\electron')) -and
  @(Get-ChildItem -Recurse -File -Path $app -Include '*.test.js', '*.local' -ErrorAction SilentlyContinue).Count -eq 0 -and -not (Test-Path (Join-Path $app 'installer')))
$sc = New-Object -ComObject WScript.Shell
Check 'Start menu: Mantle > Mantle' (Test-Path -LiteralPath (Join-Path $menu 'Mantle.lnk'))
$rl = Join-Path $menu 'Restore Windows taskbar.lnk'
Check 'Start menu: Mantle > Restore Windows taskbar' (Test-Path -LiteralPath $rl)
if (Test-Path -LiteralPath $rl) {
  $lnk = $sc.CreateShortcut($rl)
  Check 'the restore entry opens tools\restore-windows.cmd' ($lnk.TargetPath -ieq (Join-Path $app 'tools\restore-windows.cmd')) $lnk.TargetPath
}
$un = Uninstall-Cmd
Check 'Settings > Apps lists Mantle (per-user uninstall key)' ($null -ne $un -and $un.UninstallString -match 'Uninstall Mantle\.exe')
Check 'installed per user, no admin: %LOCALAPPDATA%\Programs\Mantle' ($null -ne $un -and $un.InstallLocation -and ([System.IO.Path]::GetFullPath($un.InstallLocation).TrimEnd('\') -ieq $inst))
Check 'a silent install starts nothing' ((From-Install).Count -eq 0)
Check 'installing registers no logon task' ($null -eq (Tasks))
Check 'installing records no consent' (-not (Test-Path -LiteralPath $consent))
Wait-Baseline 'after install'

# ---------------------------------------------------------------- 2. test mode
Step 'test mode smoke: Mantle.exe --test --screenshot'
$shots = Join-Path $Out 'test-shots'
New-Item -ItemType Directory -Force -Path $shots | Out-Null
$p = Start-Process -FilePath $exe -ArgumentList @('--test', '--profile-name=ci', "--screenshot=$shots") -WorkingDirectory $inst -PassThru `
  -RedirectStandardOutput (Join-Path $Out 'test-stdout.txt') -RedirectStandardError (Join-Path $Out 'test-stderr.txt')
$done = $p.WaitForExit(240000)
Check 'test mode: started, captured its windows and quit by itself (240 s)' $done
if (-not $done) { Kill-All }
$pngs = @(Get-ChildItem -Path $shots -Filter '*.png' -ErrorAction SilentlyContinue)
Check 'test mode: screenshots written' ($pngs.Count -ge 1) "$($pngs.Count) png"
$so = Get-Content -LiteralPath (Join-Path $Out 'test-stdout.txt') -Raw -ErrorAction SilentlyContinue
Check 'test mode: the installed sidecar answered (no sidecar error in the log)' ($so -and $so -match 'sidecar' -and -not ($so -match 'sidecar (exited|failed|missing)')) ''
Check 'test mode leaves nothing running' (Wait-Gone 20)
Wait-Baseline 'after a test run'

# ---------------------------------------------------------------- 3. first start: the warning, Not now
Step 'first start: the warning, then Not now'
$g = Start-Gate
$w = Find-Window $g.Id 60
Check 'first start shows the warning (not live)' ($null -ne $w)
if ($w) {
  $text = AllText $w
  Check 'the warning says at your own risk' ($text -match 'at your own risk')
  Check 'the warning names Start > All apps > Mantle > Restore Windows taskbar' ($text -match 'Restore Windows taskbar')
  $box = Named $w 'Also start Mantle when I sign in'
  Check 'start at sign-in is offered, unticked' ($box -and $box.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern).Current.ToggleState -eq 'Off')
  Check 'while the warning is up, no sidecar runs and the taskbar is untouched' (@(From-Install | Where-Object { $_.Name -ieq 'Mantle.Sidecar.exe' }).Count -eq 0 -and [MantleCi]::State() -eq $script:baseline)
  (Named $w 'Not now').GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
}
Check 'Not now: Mantle exits' ($g.WaitForExit(30000))
Check 'Not now: no consent, no logon task' (-not (Test-Path -LiteralPath $consent) -and $null -eq (Tasks))
Check 'Not now: nothing running' (Wait-Gone 20)
Wait-Baseline 'after Not now'

if ($Live) {
  # -------------------------------------------------------------- 4. Start Mantle (live, ON THE RUNNER ONLY)
  Step 'first start: Start Mantle, with start at sign-in ticked'
  $from = Log-Offset
  $g = Start-Gate
  $w = Find-Window $g.Id 60
  if ($w) {
    (Named $w 'Also start Mantle when I sign in').GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern).Toggle()
    (Named $w 'Start Mantle').GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
  }
  Check 'Start Mantle: the warning process hands over and exits' ($w -and $g.WaitForExit(90000))
  Check 'Start Mantle: Mantle comes up live' (Wait-LiveUp $from)
  $mains = @(From-Install | Where-Object { $_.Name -ieq 'Mantle.exe' -and $_.CommandLine -match '--live' -and -not ($_.CommandLine -match '--type=') })
  Check 'live: one Mantle.exe --live with its log' ($mains.Count -eq 1 -and $mains[0].CommandLine -match '--log=') "$($mains.Count) main(s)"
  Check 'live: the installed sidecar runs' (@(From-Install | Where-Object { $_.Name -ieq 'Mantle.Sidecar.exe' }).Count -ge 1)
  Check 'live: Mantle put the taskbar on auto-hide (it really went live)' (([MantleCi]::AbmState() -band 1) -eq 1) ([MantleCi]::State())
  Check 'live: the consent is recorded' ((Test-Path -LiteralPath $consent) -and ((Get-Content -LiteralPath $consent -Raw | ConvertFrom-Json).accepted -eq $true))
  $t = Tasks
  $acts = if ($t) { @($t.Definition.Actions | ForEach-Object { "$($_.Path) $($_.Arguments)" }) -join '; ' } else { '' }
  Check 'start at sign-in: the "Mantle" task runs this Mantle.exe --live' ($t -and $acts -match [regex]::Escape($exe) -and $acts -match '--live' -and -not ($acts -match ' \. ')) $acts

  Step 'quit: Mantle.exe --quit'
  $q = Start-Process -FilePath $exe -ArgumentList '--quit' -PassThru -Wait
  Check 'Mantle.exe --quit exits 0 (it reached the running Mantle)' ($q.ExitCode -eq 0) "exit $($q.ExitCode)"
  Check 'quit: every Mantle process exits' (Wait-Gone 45)
  Wait-Baseline 'after quit'
  $st = Get-Content -LiteralPath (Join-Path $profileDir 'shell-state.json') -Raw -ErrorAction SilentlyContinue | ConvertFrom-Json
  Check 'quit: shell-state.json says restored' ($st -and $st.restored -eq $true)

  Step 'Start menu > Mantle again: consent on record, straight to live'
  $from = Log-Offset
  Start-Process -FilePath (Join-Path $menu 'Mantle.lnk') | Out-Null
  Check 'Start menu start: live, no warning' (Wait-LiveUp $from)

  Step 'Start menu > Restore Windows taskbar while Mantle is live, under a hostile policy and Mark-of-the-Web'
  $polCU = Get-ExecutionPolicy -Scope CurrentUser; $polLM = Get-ExecutionPolicy -Scope LocalMachine
  Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy Restricted -Force
  try { Set-ExecutionPolicy -Scope LocalMachine -ExecutionPolicy AllSigned -Force } catch { Write-Output "note: LocalMachine policy not set ($($_.Exception.Message))" }
  Get-ChildItem -Path (Join-Path $app 'tools') -File -Include '*.ps1', '*.cmd' -Recurse | ForEach-Object { Set-Content -LiteralPath $_.FullName -Stream Zone.Identifier -Value "[ZoneTransfer]`r`nZoneId=3" }
  $target = $sc.CreateShortcut($rl).TargetPath
  $r = & cmd.exe /d /c "`"$target`" < NUL" 2>&1
  $rc = $LASTEXITCODE
  $r | Set-Content -LiteralPath (Join-Path $Out 'restore-shortcut.txt')
  Check 'restore entry: exits 0 and prints verified' ($rc -eq 0 -and ($r -match '^verified')) "exit $rc; $((@($r) | Select-Object -Last 3) -join ' | ')"
  Check 'restore entry: it stopped the installed Mantle.exe (and only from this folder)' (Wait-Gone 20)
  Wait-Baseline 'after the Start menu restore'
  Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy $polCU -Force
  try { Set-ExecutionPolicy -Scope LocalMachine -ExecutionPolicy $polLM -Force } catch { }

  Step 'update while live: Mantle-Setup.exe /S over a running Mantle'
  $from = Log-Offset
  Start-Gate | Out-Null
  Check 'live again before the update' (Wait-LiveUp $from)
  Remove-Item -LiteralPath (Join-Path $env:TEMP 'mantle-setup-install.log') -ErrorAction SilentlyContinue
  Run-Setup 'update'
  $il = Get-Content -LiteralPath (Join-Path $env:TEMP 'mantle-setup-install.log') -Raw -ErrorAction SilentlyContinue
  Check 'update: Mantle was asked to quit and did (not killed)' ($il -match 'Mantle quit and put Windows back') ''
  Check 'update: nothing runs after a silent update' (Wait-Gone 20)
  Wait-Baseline 'after the update'
  Check 'update: files, consent and start at sign-in kept' ((Test-Path -LiteralPath $exe) -and (Test-Path -LiteralPath $consent) -and $null -ne (Tasks) -and (Test-Path -LiteralPath $rl))

  Step 'uninstall while live'
  $from = Log-Offset
  Start-Gate | Out-Null
  Check 'live again before the uninstall' (Wait-LiveUp $from)
}

# ---------------------------------------------------------------- 5. uninstall
Step "silent uninstall$(if ($Live) { ' (Mantle is live)' } else { '' })"
Remove-Item -LiteralPath (Join-Path $env:TEMP 'mantle-setup-uninstall.log') -ErrorAction SilentlyContinue
$un = Uninstall-Cmd
$uexe = Join-Path $inst 'Uninstall Mantle.exe'
$u = Start-Process -FilePath $uexe -ArgumentList '/S' -PassThru -Wait
Write-Output "uninstaller exit $($u.ExitCode)"
$end = (Get-Date).AddSeconds(120)
while ((Test-Path -LiteralPath $exe) -and (Get-Date) -lt $end) { Start-Sleep -Seconds 1 }
$ul = Get-Content -LiteralPath (Join-Path $env:TEMP 'mantle-setup-uninstall.log') -Raw -ErrorAction SilentlyContinue
if ($ul) { $ul | Set-Content -LiteralPath (Join-Path $Out 'mantle-setup-uninstall.log') }
if ($Live) { Check 'uninstall: Mantle was asked to quit and did, before any file went' ($ul -match 'Mantle quit and put Windows back') '' }
Check 'uninstall: Windows was confirmed back before the files went' ($ul -match 'Windows is back, and nothing runs from') ''
Check 'uninstall: nothing runs' (Wait-Gone 20)
Wait-Baseline 'after uninstall'
Check 'uninstall: the program folder is gone' (-not (Test-Path -LiteralPath $exe) -and -not (Test-Path -LiteralPath $app))
Check 'uninstall: both Start menu entries are gone' (-not (Test-Path -LiteralPath $menu))
Check 'uninstall: Settings > Apps no longer lists Mantle' ($null -eq (Uninstall-Cmd))
Check 'uninstall: no "Mantle" logon task' ($null -eq (Tasks))
if ($Live) { Check 'uninstall: the profile (%APPDATA%\mantle) is kept' (Test-Path -LiteralPath $profileDir) }

if ((From-Install).Count) { Kill-All }
Write-Output ''
foreach ($f in $script:failed) { Write-Output "FAIL $f" }
Write-Output "INSTALL TEST: $script:passed passed, $($script:failed.Count) failed"
if ($script:failed.Count) { exit 1 }
exit 0

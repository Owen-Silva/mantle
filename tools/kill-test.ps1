# kill-test.ps1 - stop ONE Mantle test instance and nothing else.
#
#   powershell -NoProfile -File tools/kill-test.ps1 -Match mainlane [-WhatIf]
#
# WHY this script exists instead of `taskkill /im electron.exe`: Owen's own
# browser is an Electron app and is usually running. Killing electron.exe
# wholesale would take his browser, his tabs and anything else Electron-shaped
# down with it. This matches the '--profile-name=<x>' flag on the command line --
# the whole flag, never a bare substring, because '-Match ws' once matched
# 'browser' in a path and hit the wrong process.
#
# A live Mantle has NO --profile-name flag, so this script can never stop the
# live shell. That is deliberate: the live one is stopped from its tray menu or
# with Ctrl+Alt+Shift+Backspace, both of which put the Windows taskbar back first.

param([string]$Match = 'dev', [switch]$WhatIf)

$needle = if ($Match.Contains('=')) { $Match } else { '--profile-name=' + $Match }

$procs = @(Get-CimInstance Win32_Process -Filter "Name='electron.exe'" |
  Where-Object { $_.CommandLine -and $_.CommandLine.Contains($needle) })

if ($procs.Count -eq 0) {
  "no electron.exe is running with $needle"
  exit 0
}

foreach ($p in $procs) {
  if ($WhatIf) {
    "would stop pid $($p.ProcessId)"
  } else {
    try {
      Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop
      "stopped pid $($p.ProcessId)"
    } catch {
      "could not stop pid $($p.ProcessId): $($_.Exception.Message)"
    }
  }
}

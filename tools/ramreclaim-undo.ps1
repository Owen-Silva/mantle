# ramreclaim-undo.ps1 - put back the Windows pieces Mantle turned off to save memory
# (lib/features/ramreclaim.js + lib/features/_ramreclaim-core.js), from their journal, with no Node, no
# Electron and no Mantle running. Called by tools\restore-windows.ps1 (every restore, the crash give-up
# included) and tools\install-autostart.ps1 -Uninstall. Safe to run when there is nothing to undo.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\ramreclaim-undo.ps1 [-Journal <path>]
#
# The core's rules, again here:
#   - only HKCU number (DWORD) values on the allowlist below (the core's piece table); anything else in
#     the journal is left alone and said, so a tampered file cannot make this write an arbitrary value;
#   - a value is written back ONLY while it still holds Mantle's value; one changed since (by the user or
#     by Windows) is left as it is;
#   - an entry that could not be put back stays in the journal for the next try (exit 1).
# PowerShell 5.1 only: no ternary, no '&&', no '?.'. Never New-Item -Force on a key that exists (it
# empties the key).
param(
  [string]$Journal = (Join-Path $env:APPDATA 'mantle\features\ramreclaim-journal.json'),
  [switch]$AllowTestKeys
)

$ErrorActionPreference = 'Stop'
$allow = @(
  'software\microsoft\windows\currentversion\dsh|isprelaunchenabled',
  'software\microsoft\windows\currentversion\searchsettings|isdynamicsearchboxenabled',
  'software\microsoft\windows\currentversion\lock screen|lockscreenwidgetsenabled'
)
function Say([string]$text) { Write-Output "  windows pieces: $text" }

function Read-Dword([string]$path, [string]$name) {
  # -> @{ Has = bool; Value = int64 }
  $r = @{ Has = $false; Value = $null }
  if (-not (Test-Path -LiteralPath $path)) { return $r }
  $item = Get-ItemProperty -LiteralPath $path -ErrorAction SilentlyContinue
  if ($null -ne $item -and ($item.PSObject.Properties.Name -contains $name)) {
    $r.Has = $true
    try { $r.Value = [int64]$item.$name } catch { $r.Value = $null }   # not a number: neither Mantle's nor Windows' original
  }
  return $r
}

if (-not (Test-Path -LiteralPath $Journal)) { Say 'nothing to put back'; exit 0 }
try {
  $j = [System.IO.File]::ReadAllText($Journal) | ConvertFrom-Json
} catch {
  Say "the journal could not be read, so nothing was changed: $($_.Exception.Message)"
  exit 1
}
if ($null -eq $j -or $null -eq $j.entries) { Say 'nothing to put back'; exit 0 }

$left = [ordered]@{}
$failed = 0
$count = 0
foreach ($prop in @($j.entries.PSObject.Properties)) {
  $count++
  $id = $prop.Name
  $e = $prop.Value
  $key = [string]$e.key
  $name = [string]$e.name
  $pair = ($key + '|' + $name).ToLower()
  $isTest = $AllowTestKeys -and $key.ToLower().StartsWith('software\mantletest\')
  if ($e.hive -ne 'HKCU' -or $e.type -ne 'REG_DWORD' -or ((-not ($allow -contains $pair)) -and (-not $isTest))) {
    # said, kept in the journal, but not a failure: restore-windows.ps1 must not fail for ever over it
    Say "${id}: not a value Mantle changes, left alone"
    $left[$id] = $e
    continue
  }
  if ($e.dryRun) {
    # a test run's record (lib/features/ramreclaim.js under --test): nothing was changed in Windows, so
    # nothing is written; the record is dropped
    Say "${id}: a test run's record, nothing to put back"
    continue
  }
  $path = 'HKCU:\' + $key
  $cur = Read-Dword $path $name
  $isMantles = $cur.Has -and ($cur.Value -eq [int64]$e.target)
  if ($e.existed) { $isOriginal = $cur.Has -and ($cur.Value -eq [int64]$e.data) } else { $isOriginal = -not $cur.Has }
  if ($isMantles) {
    try {
      if ($e.existed) {
        if (-not (Test-Path -LiteralPath $path)) { New-Item -Path $path -Force | Out-Null }
        New-ItemProperty -LiteralPath $path -Name $name -PropertyType DWord -Value ([int]$e.data) -Force | Out-Null
      } else {
        Remove-ItemProperty -LiteralPath $path -Name $name -ErrorAction Stop
      }
      $back = Read-Dword $path $name
      if ($e.existed) { $ok = $back.Has -and ($back.Value -eq [int64]$e.data) } else { $ok = -not $back.Has }
      if ($ok) {
        Say "${id}: put back"
      } else {
        Say "${id}: Windows did not keep the change; left in the journal for the next try"
        $left[$id] = $e
        $failed++
      }
    } catch {
      Say "${id}: could not be put back ($($_.Exception.Message)); left in the journal for the next try"
      $left[$id] = $e
      $failed++
    }
  } elseif ($isOriginal) {
    Say "${id}: already as Windows had it"
  } else {
    Say "${id}: changed outside Mantle since, left as it is"
  }
}

if ($count -eq 0) { Say 'nothing to put back'; exit 0 }
try {
  $json = ([ordered]@{ v = 1; entries = $left }) | ConvertTo-Json -Depth 6
  $tmp = $Journal + '.tmp'
  [System.IO.File]::WriteAllText($tmp, $json, (New-Object System.Text.UTF8Encoding($false)))
  Move-Item -LiteralPath $tmp -Destination $Journal -Force
} catch {
  Say "the journal could not be updated: $($_.Exception.Message)"
  $failed++
}
if ($failed -gt 0) { exit 1 }
exit 0

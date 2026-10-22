# restore-banners.ps1 - give Windows its own notification pop-ups back, with no
# Node, no Electron and no Mantle running.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\restore-banners.ps1
#   ... -RecordFile <path>    read Mantle's record from somewhere else (tests)
#   ... -SettingsKey <path>   an HKCU-relative key to use instead of Windows' own
#                             Notifications\Settings (tests use a scratch key)
#   ... -TestOnly             only app ids that start with Mantle.ToastTest (what a
#                             --test Mantle owns; lib/features/_toasts-safety.js)
#
# -----------------------------------------------------------------------------
# WHAT IT UNDOES
# -----------------------------------------------------------------------------
# "Show notifications in Mantle's style" (lib/features/toasts.js) turns Windows'
# own banner off for each app it covers: ShowBanner = 0 (DWORD) under
#   HKCU\Software\Microsoft\Windows\CurrentVersion\Notifications\Settings\<app id>
# and writes what the value was BEFORE into %APPDATA%\mantle\notif-banners.json:
#   { "v": 1, "owned": { "<app id>": 1 | null }, "released": [ ... ] }
# (1 = the value was 1, null = there was no value). Mantle puts these back
# itself on every exit (lib/features/_toasts-owner.js, sidecar ToastBanners.cs);
# this script is the same put-back for the day Mantle cannot run at all.
#
# THE RULE, same as Mantle's: an original goes back ONLY where the value is still
# Mantle's 0. Anything else (a value the user set themselves in Windows' Settings, an app
# that is gone) is left exactly as it is.
#
# SAFE TO RUN TWICE and SAFE WITH NO RECORD: a second run finds every value
# already back (not 0) and changes nothing; a missing record means Mantle never
# took anything, and the script says so and exits 0. It never writes the record:
# the record is Mantle's (_toasts-owner.js), and the next Mantle reads "the value
# is back to its original" as "take it again", which is what it should do.
#
# THE MARKER (lane mantle-notif-owner2, 2026-10-17): after its put-back it lists
# what it put back in notif-banners-back.script.json, next to the record:
#   { "v": 1, "back": { "<app id as keyed in owned>": { "at": <epoch ms>,
#                       "took": <the record's taken[app id], or null> } } }
# Only apps it really put back (the value was 0 and the write worked), merged
# with its own earlier entries (the new one per app replaces the old; at most
# 300, the oldest dropped), written atomically (a temp file, then replace).
# Mantle reads it (_toasts-owner.js): an app it still lists as owned that reads
# 0 with a matching stamp is the user's own choice, so Mantle lets it go instead of
# drawing banners for it or turning Windows' back on over it. A marker that
# cannot be written never fails the put-back; the output says so.
#
# Exit code: 0 = everything Mantle had is back (or there was nothing), 1 = some
# value could not be put back or the record could not be read (each one said).
#
# PowerShell 5.1 only: no ternary, no '&&', no '?.'.
# -----------------------------------------------------------------------------

[CmdletBinding()]
param(
  [string]$RecordFile = (Join-Path $env:APPDATA 'mantle\notif-banners.json'),
  [string]$SettingsKey = 'Software\Microsoft\Windows\CurrentVersion\Notifications\Settings',
  [switch]$TestOnly
)

$ErrorActionPreference = 'Stop'
$settingsPath = $SettingsKey
$problems = 0

function Say([string]$text) { Write-Output $text }

# The record's stamp for an app, keyed EXACTLY as in owned (case-sensitive), or $null.
function Get-TakenStamp($takenObj, [string]$id) {
  if ($takenObj -eq $null) { return $null }
  foreach ($p in $takenObj.PSObject.Properties) { if ($p.Name -ceq $id) { return $p.Value } }
  return $null
}

# notif-banners-back.script.json: what THIS script put back (see THE MARKER above).
# -> the line to say. Never throws: a marker that cannot be written is said, and
# the put-back stands.
function Write-BackMarker([string]$file, $done) {
  $name = [System.IO.Path]::GetFileName($file)
  $tmp = $file + '.tmp'
  $note = ''
  try {
    $all = @{}      # app id (case-blind, as Windows) -> @{ at; took; fresh }
    if ([System.IO.File]::Exists($file)) {
      try {
        $old = [System.IO.File]::ReadAllText($file) | ConvertFrom-Json
        if ($old -ne $null -and $old.v -eq 1 -and $old.back -ne $null) {
          foreach ($p in $old.back.PSObject.Properties) {
            $e = $p.Value
            if (-not ($e -is [System.Management.Automation.PSCustomObject])) { continue }
            $all[[string]$p.Name] = @{ id = [string]$p.Name; at = $e.at; took = $e.took; fresh = $false }
          }
        } else { $note = '; its earlier entries were not a v1 list, so it was written afresh' }
      } catch { $all = @{}; $note = "; its earlier entries could not be read ($($_.Exception.Message)), so it was written afresh" }
    }
    foreach ($d in $done) {
      if ($all.ContainsKey($d.id)) { $all.Remove($d.id) }
      $all[$d.id] = @{ id = $d.id; at = $d.at; took = $d.took; fresh = $true }
    }
    # at most 300: this run's entries first, then the newest by at
    $keep = @($all.Values | Sort-Object -Property @{ Expression = { if ($_.fresh) { 1 } else { 0 } }; Descending = $true },
      @{ Expression = { $a = 0.0; try { $a = [double]$_.at } catch { $a = 0.0 }; $a }; Descending = $true } | Select-Object -First 300)
    $back = [ordered]@{}
    foreach ($e in $keep) { $back[$e.id] = [ordered]@{ at = $e.at; took = $e.took } }
    $json = ([ordered]@{ v = 1; back = $back }) | ConvertTo-Json -Depth 6 -Compress
    [System.IO.File]::WriteAllText($tmp, $json, (New-Object System.Text.UTF8Encoding($false)))
    if ([System.IO.File]::Exists($file)) { [System.IO.File]::Replace($tmp, $file, [NullString]::Value) }
    else { [System.IO.File]::Move($tmp, $file) }
    return "  marker  $name lists the $(@($done).Count) app(s) put back, with the record's stamps (so Mantle leaves a pop-up the user turns off after this as they set it)$note"
  } catch {
    $why = $_.Exception.Message
    try { if ([System.IO.File]::Exists($tmp)) { [System.IO.File]::Delete($tmp) } } catch { }
    return "  marker NOT written ($why); the put-back itself is done, but a pop-up the user turns off before Mantle runs again may be turned back on by Mantle's next quit"
  }
}

Say "mantle restore-banners"
Say "  record: $RecordFile"

if (-not (Test-Path -LiteralPath $RecordFile -PathType Leaf)) {
  Say "  no record: Mantle never turned off a Windows pop-up here; nothing to put back"
  exit 0
}

$owned = $null
$taken = $null
try {
  $text = [System.IO.File]::ReadAllText($RecordFile)
  if ($text.Trim().Length -eq 0) {
    Say "  the record is empty; nothing to put back"
    exit 0
  }
  $rec = $text | ConvertFrom-Json
  if ($rec -ne $null) { $owned = $rec.owned; $taken = $rec.taken }
} catch {
  Say "  PROBLEM  the record could not be read ($($_.Exception.Message)); Windows' pop-ups were left as they are"
  exit 1
}

$entries = @()
if ($owned -ne $null) { $entries = @($owned.PSObject.Properties) }
if ($entries.Count -eq 0) {
  Say "  Mantle owns no app's pop-up setting; nothing to put back"
  exit 0
}

$root = $null
try {
  $root = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($settingsPath, $true)
} catch {
  Say "  PROBLEM  Windows' notification settings could not be opened ($($_.Exception.Message))"
  exit 1
}
if ($root -eq $null) {
  Say "  Windows' notification settings are gone; nothing to put back"
  exit 0
}

$back = 0
$left = 0
$done = New-Object System.Collections.ArrayList   # what was really put back, for the marker
try {
  # key names are matched without case, as Windows does (the record keeps the case it saw)
  $names = @{}
  foreach ($n in $root.GetSubKeyNames()) { $names[$n.ToLowerInvariant()] = $n }

  foreach ($e in $entries) {
    $id = [string]$e.Name
    $original = $e.Value
    if ($TestOnly -and -not $id.StartsWith('Mantle.ToastTest', [System.StringComparison]::OrdinalIgnoreCase)) { $left++; Say "  left    $id (-TestOnly: not a test app id)"; continue }
    $found = $names[$id.ToLowerInvariant()]
    if ($found -eq $null) { $left++; Say "  left    $id (no longer in Windows' list)"; continue }
    try {
      $k = $root.OpenSubKey($found, $true)
      if ($k -eq $null) { $left++; Say "  left    $id (its key could not be opened)"; continue }
      try {
        $isZero = $false
        if ($k.GetValueNames() -contains 'ShowBanner') {
          $kind = $k.GetValueKind('ShowBanner')
          if ($kind -eq [Microsoft.Win32.RegistryValueKind]::DWord -and [int]$k.GetValue('ShowBanner') -eq 0) { $isZero = $true }
        }
        if (-not $isZero) { $left++; Say "  left    $id (not Mantle's 0: already back, or the user's own value)"; continue }
        if ($original -eq $null) {
          $k.DeleteValue('ShowBanner', $false)
          Say "  back    $id (ShowBanner removed: Windows' default, banners on)"
        } else {
          $k.SetValue('ShowBanner', [int]$original, [Microsoft.Win32.RegistryValueKind]::DWord)
          Say "  back    $id (ShowBanner = $([int]$original))"
        }
        $back++
        [void]$done.Add(@{ id = $id; at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds(); took = (Get-TakenStamp $taken $id) })
      } finally { $k.Close() }
    } catch {
      $problems++
      Say "  PROBLEM  $id could not be put back ($($_.Exception.Message))"
    }
  }
} finally { $root.Close() }

Say "  $back put back to Windows' own pop-up, $left left as they were"
$markFile = [System.IO.Path]::Combine([System.IO.Path]::GetDirectoryName([System.IO.Path]::GetFullPath($RecordFile)), 'notif-banners-back.script.json')
if ($done.Count -gt 0) { Say (Write-BackMarker $markFile $done) }
else { Say "  marker  nothing was put back, so notif-banners-back.script.json is left as it was" }
if ($problems -gt 0) {
  Say "NOT VERIFIED - $problems app(s) could not be put back; run this again, or turn the app's banners on in Windows Settings > System > Notifications"
  exit 1
}
Say "verified"
exit 0

# restore-banners.ps1 - give Windows its own notification pop-ups back, with no
# Node, no Electron and no Mantle running.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\restore-banners.ps1
#   ... -RecordFile <path>    read Mantle's record from somewhere else (tests)
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
# Mantle's 0. Anything else (a value Owen set himself in Windows' Settings, an app
# that is gone) is left exactly as it is.
#
# SAFE TO RUN TWICE and SAFE WITH NO RECORD: a second run finds every value
# already back (not 0) and changes nothing; a missing record means Mantle never
# took anything, and the script says so and exits 0. It never writes the record:
# the record is Mantle's (_toasts-owner.js), and the next Mantle reads "the value
# is back to its original" as "take it again", which is what it should do.
#
# Exit code: 0 = everything Mantle had is back (or there was nothing), 1 = some
# value could not be put back or the record could not be read (each one said).
#
# PowerShell 5.1 only: no ternary, no '&&', no '?.'.
# -----------------------------------------------------------------------------

[CmdletBinding()]
param(
  [string]$RecordFile = (Join-Path $env:APPDATA 'mantle\notif-banners.json')
)

$ErrorActionPreference = 'Stop'
$settingsPath = 'Software\Microsoft\Windows\CurrentVersion\Notifications\Settings'
$problems = 0

function Say([string]$text) { Write-Output $text }

Say "mantle restore-banners"
Say "  record: $RecordFile"

if (-not (Test-Path -LiteralPath $RecordFile -PathType Leaf)) {
  Say "  no record: Mantle never turned off a Windows pop-up here; nothing to put back"
  exit 0
}

$owned = $null
try {
  $text = [System.IO.File]::ReadAllText($RecordFile)
  if ($text.Trim().Length -eq 0) {
    Say "  the record is empty; nothing to put back"
    exit 0
  }
  $rec = $text | ConvertFrom-Json
  if ($rec -ne $null) { $owned = $rec.owned }
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
try {
  # key names are matched without case, as Windows does (the record keeps the case it saw)
  $names = @{}
  foreach ($n in $root.GetSubKeyNames()) { $names[$n.ToLowerInvariant()] = $n }

  foreach ($e in $entries) {
    $id = [string]$e.Name
    $original = $e.Value
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
        if (-not $isZero) { $left++; Say "  left    $id (not Mantle's 0: already back, or Owen's own value)"; continue }
        if ($original -eq $null) {
          $k.DeleteValue('ShowBanner', $false)
          Say "  back    $id (ShowBanner removed: Windows' default, banners on)"
        } else {
          $k.SetValue('ShowBanner', [int]$original, [Microsoft.Win32.RegistryValueKind]::DWord)
          Say "  back    $id (ShowBanner = $([int]$original))"
        }
        $back++
      } finally { $k.Close() }
    } catch {
      $problems++
      Say "  PROBLEM  $id could not be put back ($($_.Exception.Message))"
    }
  }
} finally { $root.Close() }

Say "  $back put back to Windows' own pop-up, $left left as they were"
if ($problems -gt 0) {
  Say "NOT VERIFIED - $problems app(s) could not be put back; run this again, or turn the app's banners on in Windows Settings > System > Notifications"
  exit 1
}
Say "verified"
exit 0

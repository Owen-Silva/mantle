# restore-windows.ps1 - put the Windows shell back, with no Node, no Electron and
# no Mantle running.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\restore-windows.ps1
#   ... -StateFile <path>     read the original state from somewhere else
#   ... -NoKill               do not stop any Mantle process (use when Mantle is
#                             the thing that is running this)
#   ... -RestartExplorer      last resort: bounce explorer.exe if the taskbar is
#                             still not right after everything else
#
# -----------------------------------------------------------------------------
# WHY THIS FILE EXISTS
# -----------------------------------------------------------------------------
# 2026-09-21. Mantle's first live run hid the Shell_TrayWnd window with
# ShowWindow(SW_HIDE). Owen's Windows taskbar is set to AUTO-HIDE, and hiding the
# window of an auto-hiding taskbar wedges explorer's own show/hide state machine:
# when Mantle was killed, the sidecar's SW_SHOW ran and the taskbar still did not
# come back. He had to REBOOT, in the middle of his work.
#
# Every line below follows from one rule: PUTTING WINDOWS BACK MUST NOT NEED
# MANTLE. Not Electron, not Node, not the C# sidecar, not a tray icon, not a
# keystroke that something else might have swallowed. Windows PowerShell 5.1 and
# Add-Type are on every Windows box that has ever existed in this decade, so that
# is all this uses. If Owen can open a terminal, he can get his taskbar back.
#
# It is also SAFE TO RUN WHEN NOTHING IS WRONG. Every step reads the current state
# first and only writes when it differs, so a run with no state file and a healthy
# desktop is a sequence of no-ops that prints "verified" and exits 0.
#
# PowerShell 5.1 only: no ternary, no '&&', no '?.'. Do not "modernise" it --
# pwsh 7 is not guaranteed to be installed, and this is the file that has to work
# on the worst day.
# -----------------------------------------------------------------------------

[CmdletBinding()]
param(
  [string]$StateFile = (Join-Path $env:APPDATA 'mantle\shell-state.json'),
  [switch]$NoKill,
  [switch]$RestartExplorer
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$problems = New-Object System.Collections.ArrayList

function Say([string]$text) { Write-Output $text }
function Problem([string]$text) {
  [void]$problems.Add($text)
  Write-Output "  PROBLEM  $text"
}

# -----------------------------------------------------------------------------
# The Win32 surface. Four calls and two structs; nothing else is needed.
#
# APPBARDATA on x64: uint cbSize(0), 4 bytes of padding, IntPtr hWnd(8),
# uint uCallbackMessage(16), uint uEdge(20), RECT rc(24..40), IntPtr lParam(40)
# => 48 bytes. Marshal.SizeOf works that out; cbSize must agree with it or
# SHAppBarMessage silently does nothing, which would be the worst possible bug in
# this particular file.
# -----------------------------------------------------------------------------
$src = @'
using System;
using System.Runtime.InteropServices;

public static class MantleRestore {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int left; public int top; public int right; public int bottom; }

  [StructLayout(LayoutKind.Sequential)]
  public struct APPBARDATA {
    public uint cbSize;
    public IntPtr hWnd;
    public uint uCallbackMessage;
    public uint uEdge;
    public RECT rc;
    public IntPtr lParam;
  }

  [DllImport("shell32.dll", SetLastError = true)]
  static extern IntPtr SHAppBarMessage(uint dwMessage, ref APPBARDATA pData);

  [DllImport("user32.dll", SetLastError = true)]
  static extern bool SystemParametersInfoW(uint uiAction, uint uiParam, ref RECT pvParam, uint fWinIni);

  [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern IntPtr FindWindowW(string lpClassName, string lpWindowName);

  [DllImport("user32.dll")]
  static extern bool IsWindowVisible(IntPtr hWnd);

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  static extern IntPtr FindWindowExW(IntPtr parent, IntPtr after, string cls, string title);
  [DllImport("user32.dll")]
  static extern int GetWindowRgn(IntPtr hWnd, IntPtr hRgn);
  [DllImport("user32.dll")]
  static extern int SetWindowRgn(IntPtr hWnd, IntPtr hRgn, bool redraw);
  [DllImport("gdi32.dll")]
  static extern IntPtr CreateRectRgn(int l, int t, int r, int b);
  [DllImport("gdi32.dll")]
  static extern bool DeleteObject(IntPtr obj);

  /// <summary>TaskbarHide.cs (2026-09-25) makes the taskbar invisible with an
  /// EMPTY window region. Clear every such region on Shell_TrayWnd and
  /// Shell_SecondaryTrayWnd; any other region is not Mantle's and is left alone.
  /// Returns {found, cleared}.</summary>
  public static int[] ClearEmptyTaskbarRegions() {
    int found = 0, cleared = 0;
    foreach (string cls in new string[] { "Shell_TrayWnd", "Shell_SecondaryTrayWnd" }) {
      IntPtr h = IntPtr.Zero;
      int n = 0;
      while ((h = FindWindowExW(IntPtr.Zero, h, cls, null)) != IntPtr.Zero && n++ < 16) {
        IntPtr probe = CreateRectRgn(0, 0, 0, 0);
        int kind = GetWindowRgn(h, probe);
        DeleteObject(probe);
        if (kind != 1) continue;          // 1 = NULLREGION: empty, Mantle's shape
        found++;
        SetWindowRgn(h, IntPtr.Zero, true);
        IntPtr again = CreateRectRgn(0, 0, 0, 0);
        int after = GetWindowRgn(h, again);
        DeleteObject(again);
        if (after == 0) cleared++;        // 0 = ERROR: no region at all, Explorer's normal state
      }
    }
    return new int[] { found, cleared };
  }

  [DllImport("user32.dll")]
  static extern int GetSystemMetrics(int nIndex);

  [DllImport("user32.dll", SetLastError = true)]
  static extern bool ClipCursor(IntPtr lpRect);

  [DllImport("user32.dll", SetLastError = true)]
  static extern bool GetClipCursor(out RECT lpRect);

  /// <summary>A dead Mantle can leave its cursor reserve behind: while it runs it
  /// confines the cursor to stop 2 px short of the bottom edge (that is what keeps
  /// the auto-hide taskbar from popping under the island), and a ClipCursor
  /// confinement SURVIVES its owner (measured 2026-09-21). With it stuck, the
  /// taskbar never pops for the mouse. Release it only when it is Mantle-shaped:
  /// the full screen minus 1..8 px at the bottom and nothing else.</summary>
  public static string ReleaseCursorClip() {
    RECT c;
    if (!GetClipCursor(out c)) return "GetClipCursor failed (" + Marshal.GetLastWin32Error() + ")";
    int w = GetSystemMetrics(0), h = GetSystemMetrics(1);   // SM_CXSCREEN, SM_CYSCREEN (physical: we are DPI-aware)
    if (c.left == 0 && c.top == 0 && c.right == w && c.bottom == h) return "no cursor clip was set";
    bool mantleShaped = c.left == 0 && c.top == 0 && c.right == w && c.bottom < h && c.bottom >= h - 8;
    if (!mantleShaped) return "a cursor clip is set but it is not Mantle's (" + c.left + "," + c.top + "," + c.right + "," + c.bottom + "), left alone";
    if (!ClipCursor(IntPtr.Zero)) return "ClipCursor(NULL) failed (" + Marshal.GetLastWin32Error() + ")";
    return "released Mantle's cursor reserve (the clip stopped at " + c.bottom + " of " + h + ")";
  }

  [DllImport("user32.dll", SetLastError = true)]
  static extern bool SetProcessDpiAwarenessContext(IntPtr value);

  /// <summary>Become per-monitor DPI-aware v2 ((HANDLE)-4) BEFORE any other
  /// Win32 call. powershell.exe is DPI-unaware, so Windows virtualises the
  /// numbers it hands us: on a 125% display SPI_GETWORKAREA answers 1536x864 for
  /// a 1920x1080 screen. The state file records PHYSICAL pixels, so writing them
  /// back from an unaware process would have Windows scale them UP by another
  /// 25% and leave the desktop with a work area bigger than the screen.
  /// Must run first: the awareness of a process is latched by the first call
  /// that depends on it.</summary>
  public static bool BecomeDpiAware() {
    try {
      return SetProcessDpiAwarenessContext(new IntPtr(-4));
    } catch (EntryPointNotFoundException) {
      return false;   // pre-1703 Windows: the entry point is simply not there
    } catch (Exception) {
      return false;
    }
  }

  const uint ABM_GETSTATE       = 4;
  const uint ABM_GETTASKBARPOS  = 5;
  const uint ABM_SETSTATE       = 10;
  const uint SPI_GETWORKAREA    = 0x30;
  const uint SPI_SETWORKAREA    = 0x2F;
  const uint SPIF_SENDCHANGE    = 2;

  static APPBARDATA Fresh() {
    APPBARDATA d = new APPBARDATA();
    d.cbSize = (uint)Marshal.SizeOf(typeof(APPBARDATA));
    return d;
  }

  /// <summary>ABM_GETSTATE: bit 1 = ABS_AUTOHIDE, bit 2 = ABS_ALWAYSONTOP.</summary>
  public static int GetState() {
    APPBARDATA d = Fresh();
    return (int)SHAppBarMessage(ABM_GETSTATE, ref d).ToInt64();
  }

  /// <summary>ABM_SETSTATE. The OS owns this flag, which is the entire point:
  /// nothing has to stay alive to hold it, and nothing has to stay alive to
  /// undo it.</summary>
  public static void SetState(int state) {
    APPBARDATA d = Fresh();
    d.lParam = new IntPtr(state);
    SHAppBarMessage(ABM_SETSTATE, ref d);
  }

  /// <summary>ABM_GETTASKBARPOS. An empty rectangle means explorer has lost
  /// track of its own taskbar -- the wedged state from the incident.</summary>
  public static int[] TaskbarPos() {
    APPBARDATA d = Fresh();
    IntPtr ok = SHAppBarMessage(ABM_GETTASKBARPOS, ref d);
    if (ok == IntPtr.Zero) return new int[] { 0, 0, 0, 0 };
    return new int[] { d.rc.left, d.rc.top, d.rc.right, d.rc.bottom };
  }

  public static int[] GetWorkArea() {
    RECT r = new RECT();
    if (!SystemParametersInfoW(SPI_GETWORKAREA, 0, ref r, 0)) return null;
    return new int[] { r.left, r.top, r.right, r.bottom };
  }

  public static bool SetWorkArea(int l, int t, int rr, int b) {
    RECT r = new RECT();
    r.left = l; r.top = t; r.right = rr; r.bottom = b;
    return SystemParametersInfoW(SPI_SETWORKAREA, 0, ref r, SPIF_SENDCHANGE);
  }

  public static bool TaskbarWindowExists() { return FindWindowW("Shell_TrayWnd", null) != IntPtr.Zero; }

  public static bool TaskbarWindowVisible() {
    IntPtr h = FindWindowW("Shell_TrayWnd", null);
    if (h == IntPtr.Zero) return false;
    return IsWindowVisible(h);
  }

  /// <summary>The primary monitor, in the same (DPI-virtualised) coordinates
  /// SPI_GETWORKAREA answers in for this process. Read and write from the same
  /// process and they agree; that is why both live here.</summary>
  public static int[] PrimaryScreen() { return new int[] { GetSystemMetrics(0), GetSystemMetrics(1) }; }
}
'@

try {
  Add-Type -TypeDefinition $src -Language CSharp -ErrorAction Stop
} catch {
  Write-Output "could not declare the Win32 calls: $($_.Exception.Message)"
  Write-Output "LAST RESORT: press Ctrl+Shift+Esc, find 'Windows Explorer', and choose Restart."
  exit 1
}

# FIRST Win32 call of the process, before anything reads a coordinate. See
# BecomeDpiAware above for why the order is not negotiable.
$dpiAware = [MantleRestore]::BecomeDpiAware()

Say "mantle restore-windows"
Say "  state file: $StateFile"
if ($dpiAware) {
  Say "  this process is per-monitor DPI-aware, so pixel numbers mean physical pixels"
} else {
  Say "  could not make this process DPI-aware, so pixel numbers here are virtualised"
}

# -----------------------------------------------------------------------------
# (a) Stop Mantle, and ONLY Mantle.
#
# Owen's own browser is an Electron app. `taskkill /im electron.exe` would take
# his browser, his tabs and anything else Electron-shaped with it, so the match is
# on this repo's folder path inside the process's command line -- which every
# Mantle electron.exe has (it is in its own exe path) and no other Electron app
# does. Each one is stopped by pid.
# -----------------------------------------------------------------------------
if ($NoKill) {
  Say "  skipped stopping Mantle (-NoKill)"
} else {
  $needle = $repoRoot.ToLowerInvariant()
  $stopped = 0
  # The crash-recovery supervisors FIRST (Mantle.Sidecar.exe --supervise=<pid>, lib/supervisor.js): one
  # still running when Mantle is stopped below reads that as a crash and starts Mantle again.
  try {
    $supervisors = @(Get-CimInstance Win32_Process -Filter "Name='Mantle.Sidecar.exe'" -ErrorAction Stop |
      Where-Object { $_.CommandLine -and $_.CommandLine.Contains('--supervise=') })
  } catch {
    $supervisors = @()
    Problem "could not list Mantle's crash-recovery supervisors: $($_.Exception.Message)"
  }
  foreach ($s in $supervisors) {
    try {
      Stop-Process -Id $s.ProcessId -Force -ErrorAction Stop
      $stopped++
    } catch {
      Problem "could not stop Mantle's crash-recovery supervisor pid $($s.ProcessId): $($_.Exception.Message)"
    }
  }
  try {
    $electrons = @(Get-CimInstance Win32_Process -Filter "Name='electron.exe'" -ErrorAction Stop |
      Where-Object { $_.CommandLine -and $_.CommandLine.ToLowerInvariant().Contains($needle) })
  } catch {
    $electrons = @()
    Problem "could not list electron.exe processes: $($_.Exception.Message)"
  }
  foreach ($p in $electrons) {
    try {
      Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop
      $stopped++
    } catch {
      Problem "could not stop Mantle pid $($p.ProcessId): $($_.Exception.Message)"
    }
  }
  try {
    $sidecars = @(Get-Process -Name 'Mantle.Sidecar' -ErrorAction SilentlyContinue)
  } catch {
    $sidecars = @()
  }
  foreach ($s in $sidecars) {
    try {
      Stop-Process -Id $s.Id -Force -ErrorAction Stop
      $stopped++
    } catch {
      Problem "could not stop Mantle.Sidecar pid $($s.Id): $($_.Exception.Message)"
    }
  }
  Say "  stopped $stopped Mantle process(es); no other electron.exe was touched"
}

# -----------------------------------------------------------------------------
# (b) Read the state file. A missing one is NOT a failure: whatever the taskbar is
# doing right now becomes the thing we aim at, every set turns into a no-op, and
# the checks in (e) still run. Being able to help without it is the difference
# between a recovery tool and one more thing that needs setting up first.
# -----------------------------------------------------------------------------
$originalState = $null
$originalWorkArea = $null
$stateJson = $null

if (Test-Path -LiteralPath $StateFile) {
  try {
    $raw = Get-Content -LiteralPath $StateFile -Raw -ErrorAction Stop
    $raw = $raw -replace "^﻿", ""
    $stateJson = $raw | ConvertFrom-Json
  } catch {
    Problem "state file is there but could not be read: $($_.Exception.Message)"
  }
}

$units = $null
if ($stateJson -ne $null -and $stateJson.original -ne $null) {
  if ($stateJson.original.PSObject.Properties.Name -contains 'abmState') {
    $originalState = [int]$stateJson.original.abmState
  }
  if ($stateJson.original.PSObject.Properties.Name -contains 'workarea' -and $stateJson.original.workarea -ne $null) {
    $originalWorkArea = @($stateJson.original.workarea)
  }
  # 'units' may sit beside the rectangle or at the top level; accept either
  # rather than make the caller guess which one this script wanted.
  if ($stateJson.original.PSObject.Properties.Name -contains 'units') {
    $units = [string]$stateJson.original.units
  }
}
if ($units -eq $null -and $stateJson -ne $null -and $stateJson.PSObject.Properties.Name -contains 'units') {
  $units = [string]$stateJson.units
}

if ($originalState -eq $null) {
  $originalState = [MantleRestore]::GetState()
  Say "  no usable original in the state file: assuming the current taskbar state is the original (abmState $originalState)"
} else {
  Say "  original taskbar state from the file: abmState $originalState"
}

$wantAutohide = (($originalState -band 1) -ne 0)

# -----------------------------------------------------------------------------
# (c) The taskbar's auto-hide flag, back to the original.
# -----------------------------------------------------------------------------
$before = [MantleRestore]::GetState()
if ($before -eq $originalState) {
  Say "  taskbar auto-hide flag already correct (abmState $before)"
} else {
  [MantleRestore]::SetState($originalState)
  Start-Sleep -Milliseconds 150
  $after = [MantleRestore]::GetState()
  if ($after -eq $originalState) {
    Say "  taskbar auto-hide flag set back to abmState $originalState (was $before)"
  } else {
    Problem "asked for abmState $originalState and Windows still reports $after"
  }
}

# -----------------------------------------------------------------------------
# (d) The work area.
#
# Mantle does not shrink the work area any more -- its bar is a real app bar, and
# Explorer drops that by itself. But an OLD Mantle did, with SPI_SETWORKAREA,
# and that DOES survive the process that set it. So this is the step that cleans
# up after the version of Mantle that caused all this.
#
# It is also the one step where being wrong makes things WORSE rather than
# leaving them alone: a work area written in the wrong units scales the desktop.
# So it runs only when both facts are certain -- this process is DPI-aware, and
# the state file says its numbers are physical pixels. Otherwise it is skipped
# OUT LOUD and Explorer is left to work the work area out, which it does by
# itself for real app bars anyway.
# -----------------------------------------------------------------------------
$skipWorkArea = $null
if (-not $dpiAware) {
  $skipWorkArea = "work area left to Explorer (this process could not become DPI-aware)"
} elseif ($units -ne 'physical') {
  $shownUnits = 'not recorded'
  if ($units -ne $null -and $units -ne '') { $shownUnits = $units }
  $skipWorkArea = "work area left to Explorer (the state file's units are '$shownUnits', not 'physical', so setting it could scale the desktop wrongly)"
}

if ($skipWorkArea -ne $null) {
  Say "  $skipWorkArea"
} else {
  $target = $null
  if ($originalWorkArea -ne $null -and $originalWorkArea.Count -eq 4) {
    $target = @([int]$originalWorkArea[0], [int]$originalWorkArea[1], [int]$originalWorkArea[2], [int]$originalWorkArea[3])
    $targetWhy = "the original from the state file"
  } else {
    $screen = [MantleRestore]::PrimaryScreen()
    $target = @(0, 0, [int]$screen[0], [int]$screen[1])
    $targetWhy = "the whole primary monitor (no original recorded)"
  }

  $nowWa = [MantleRestore]::GetWorkArea()
  if ($nowWa -ne $null -and $nowWa[0] -eq $target[0] -and $nowWa[1] -eq $target[1] -and $nowWa[2] -eq $target[2] -and $nowWa[3] -eq $target[3]) {
    Say "  work area already [$($target -join ', ')] ($targetWhy)"
  } else {
    $ok = [MantleRestore]::SetWorkArea($target[0], $target[1], $target[2], $target[3])
    Start-Sleep -Milliseconds 150
    $check = [MantleRestore]::GetWorkArea()
    if ($ok -and $check -ne $null -and $check[2] -eq $target[2] -and $check[3] -eq $target[3]) {
      Say "  work area set to [$($target -join ', ')] ($targetWhy)"
    } else {
      $shown = 'unreadable'
      if ($check -ne $null) { $shown = ($check -join ', ') }
      # Explorer recomputes the work area for its own app bars, so a value that
      # differs is not automatically wrong -- but it is worth naming.
      Say "  work area asked for [$($target -join ', ')], Windows reports [$shown] (Explorer recomputes this for real app bars, which is normal)"
    }
  }
}

# -----------------------------------------------------------------------------
# (d2) Is the taskbar INVISIBLE? Since 2026-09-25 Mantle hides the Windows
# taskbar with an EMPTY window region (sidecar/TaskbarHide.cs) - not ShowWindow,
# so Explorer's auto-hide machine is never involved. A region outlives the
# process that set it; the sidecar's guard process normally clears it, and this
# is the no-Mantle-at-all fallback. Only an EMPTY region is cleared (that shape
# is only ever Mantle's); a no-op on a healthy desktop.
# -----------------------------------------------------------------------------
$rgn = [MantleRestore]::ClearEmptyTaskbarRegions()
if ($rgn[0] -eq 0) {
  Say "  taskbar region: none (the taskbar is not being kept invisible)"
} elseif ($rgn[1] -eq $rgn[0]) {
  Say "  taskbar region: cleared $($rgn[1]) empty window region(s) Mantle left on the taskbar, so it draws again"
} else {
  Problem "taskbar region: $($rgn[0] - $rgn[1]) of $($rgn[0]) empty window region(s) would not clear -- run again with -RestartExplorer"
}

# -----------------------------------------------------------------------------
# (e) Is the taskbar ACTUALLY there?
#
# This is the check the incident was missing. Two symptoms mean explorer has lost
# the plot: ABM_GETTASKBARPOS answering with an empty rectangle, and a
# Shell_TrayWnd that is not visible when the original state was NOT auto-hide.
# (When the original IS auto-hide, invisible is the correct resting state and
# treating it as a fault would "fix" a working desktop.)
#
# The nudge: toggle ABS_AUTOHIDE on and straight back to the original. That makes
# explorer recompute its layout from scratch, which is exactly what the wedged
# state needs and what showing the window again never did.
# -----------------------------------------------------------------------------
function Test-Taskbar {
  $pos = [MantleRestore]::TaskbarPos()
  $empty = (($pos[2] - $pos[0]) -le 0 -or ($pos[3] - $pos[1]) -le 0)
  $exists = [MantleRestore]::TaskbarWindowExists()
  $visible = [MantleRestore]::TaskbarWindowVisible()
  $bad = $false
  $why = ''
  if (-not $exists) {
    $bad = $true
    $why = 'there is no Shell_TrayWnd window at all (explorer.exe is not running)'
  } elseif ($empty) {
    $bad = $true
    $why = "explorer reports an empty taskbar rectangle [$($pos -join ', ')]"
  } elseif ((-not $visible) -and (-not $wantAutohide)) {
    $bad = $true
    $why = 'the taskbar window is hidden although the original state was "always visible"'
  }
  return @{ Bad = $bad; Why = $why; Pos = $pos; Visible = $visible }
}

$check = Test-Taskbar
if ($check.Bad) {
  Say "  taskbar looks wrong: $($check.Why)"
  Say "  nudging explorer: auto-hide on, then back to abmState $originalState"
  [MantleRestore]::SetState(($originalState -bor 1))
  Start-Sleep -Milliseconds 400
  [MantleRestore]::SetState($originalState)
  Start-Sleep -Milliseconds 600
  $check = Test-Taskbar
  if ($check.Bad) {
    Say "  still wrong after the nudge: $($check.Why)"
  } else {
    Say "  taskbar is back after the nudge (rectangle [$($check.Pos -join ', ')])"
  }
} else {
  Say "  taskbar is where it should be (rectangle [$($check.Pos -join ', ')], window visible: $($check.Visible))"
}

# -----------------------------------------------------------------------------
# (f) Last resort: restart explorer. Only on the switch. Restarting explorer
# closes every File Explorer window someone has open, so it is never done without
# being asked -- the printed alternative costs one keystroke and no windows.
# -----------------------------------------------------------------------------
if ($check.Bad) {
  if ($RestartExplorer) {
    Say "  restarting explorer.exe (-RestartExplorer)"
    try {
      Stop-Process -Name explorer -Force -ErrorAction Stop
    } catch {
      Problem "could not stop explorer.exe: $($_.Exception.Message)"
    }
    Start-Sleep -Seconds 3
    $back = @(Get-Process -Name explorer -ErrorAction SilentlyContinue)
    if ($back.Count -eq 0) {
      # Windows usually relaunches the shell by itself; when it does not, this does.
      try {
        Start-Process explorer.exe -ErrorAction Stop
        Start-Sleep -Seconds 2
        Say "  explorer.exe was not coming back on its own, so it was started"
      } catch {
        Problem "explorer.exe did not restart and could not be started: $($_.Exception.Message)"
      }
    } else {
      Say "  explorer.exe came back on its own"
    }
    # Setting the flag again after a restart: the fresh explorer reads it at
    # startup, and on some builds it comes up with the default instead.
    [MantleRestore]::SetState($originalState)
    Start-Sleep -Milliseconds 600
    $check = Test-Taskbar
    if ($check.Bad) {
      Problem "taskbar still not right after restarting explorer: $($check.Why)"
    } else {
      Say "  taskbar is back after restarting explorer (rectangle [$($check.Pos -join ', ')])"
    }
  } else {
    Problem "taskbar still not right: rerun with -RestartExplorer, or Ctrl+Shift+Esc -> restart Windows Explorer"
  }
}

# -----------------------------------------------------------------------------
# (f2) Release the cursor reserve a dead Mantle can leave at the bottom edge
# (see ReleaseCursorClip above): with it stuck, the auto-hide taskbar never pops
# for the mouse, which is exactly the "no taskbar" state this script exists to undo.
# -----------------------------------------------------------------------------
$clipNote = [MantleRestore]::ReleaseCursorClip()
Say "  cursor clip: $clipNote"
if ($clipNote -like '*failed*') { Problem "cursor clip: $clipNote" }

# -----------------------------------------------------------------------------
# (f3) Give Windows its own notification pop-ups back for every app whose banner
# Mantle turned off ("Show notifications in Mantle's style"). restore-banners.ps1
# only writes where the value is still Mantle's 0 and is a no-op with no record.
# -----------------------------------------------------------------------------
$bannerScript = Join-Path $PSScriptRoot 'restore-banners.ps1'
if (Test-Path -LiteralPath $bannerScript) {
  try {
    $bannerOut = & $bannerScript
    $bannerCode = $LASTEXITCODE
    foreach ($line in @($bannerOut)) { if ($line -ne $null -and "$line" -ne 'mantle restore-banners') { Say "  banners: $("$line".Trim())" } }
    if ($bannerCode -ne 0) { Problem "notification banners: restore-banners.ps1 could not put every one back (see above)" }
  } catch {
    Problem "notification banners: restore-banners.ps1 failed ($($_.Exception.Message))"
  }
} else {
  Problem "notification banners: $bannerScript is missing"
}

# -----------------------------------------------------------------------------
# (f4) Put Windows' own pop-up host (the brightness pop-up's XAML window) back on
# screen if a dead Mantle left it parked off screen (sidecar/Osd.cs, P7). The park
# encodes where Windows had it, so restore-osd.ps1 needs no record; with nothing
# parked it writes nothing.
# -----------------------------------------------------------------------------
$osdScript = Join-Path $PSScriptRoot 'restore-osd.ps1'
if (Test-Path -LiteralPath $osdScript) {
  try {
    $osdOut = & $osdScript
    $osdCode = $LASTEXITCODE
    foreach ($line in @($osdOut)) { if ($line -ne $null -and "$line" -ne 'mantle restore-osd') { Say "  osd: $("$line".Trim())" } }
    if ($osdCode -ne 0) { Problem "pop-up host: restore-osd.ps1 could not put every window back (see above)" }
  } catch {
    Problem "pop-up host: restore-osd.ps1 failed ($($_.Exception.Message))"
  }
} else {
  Problem "pop-up host: $osdScript is missing"
}

# -----------------------------------------------------------------------------
# (g) Mark the state file restored, so the next Mantle does not think a run died
# dirty and recover over the top of a desktop that is already fine.
#
# Written with UTF8Encoding($false): Out-File -Encoding utf8 on PowerShell 5.1
# writes a BOM, and JSON.parse on the Electron side chokes on one.
# -----------------------------------------------------------------------------
if ($stateJson -ne $null) {
  try {
    if ($stateJson.PSObject.Properties.Name -contains 'restored') {
      $stateJson.restored = $true
    } else {
      $stateJson | Add-Member -NotePropertyName 'restored' -NotePropertyValue $true -Force
    }
    $json = $stateJson | ConvertTo-Json -Depth 8
    [System.IO.File]::WriteAllText($StateFile, $json, (New-Object System.Text.UTF8Encoding($false)))
    Say "  marked $StateFile restored:true"
  } catch {
    Problem "could not mark the state file restored: $($_.Exception.Message)"
  }
} else {
  Say "  no state file to mark (nothing was read from one)"
}

# -----------------------------------------------------------------------------
# Verdict. Exit 0 ONLY when everything checked out: a recovery script that exits
# 0 on a half-fixed desktop is worse than one that fails loudly, because
# something upstream will believe it.
# -----------------------------------------------------------------------------
if ($problems.Count -eq 0) {
  Say "verified: Windows is back the way it was"
  exit 0
}

Say ""
Say "NOT VERIFIED - $($problems.Count) thing(s) did not check out:"
foreach ($p in $problems) { Say "  - $p" }
Say ""
Say "Try, in order:"
Say "  1. powershell -NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -RestartExplorer"
Say "  2. Ctrl+Shift+Esc -> find 'Windows Explorer' -> Restart"
exit 1

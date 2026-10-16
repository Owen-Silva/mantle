# restore-osd.ps1 - put Windows' own pop-up host back on screen if a Mantle that
# died left it parked off screen. No Node, no Electron, no Mantle needed.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\restore-osd.ps1
#   ... -TargetPid <pid>   TEST ONLY: look at that process's windows instead of
#                          explorer's (a test's own stand-in; never explorer)
#
# WHAT MANTLE CHANGES (sidecar/Osd.cs OsdBright, P7 2026-10-15): to replace
# Windows' brightness pop-up it moves explorer's top-level
# XamlExplorerHostIslandWindow to (x - 24000, y - 24000). The parked spot ENCODES
# where Windows had it, so putting it back needs no state file: every explorer
# window of that class whose top-left is within 8000 px of (-24000, -24000) goes
# back by +24000, +24000. Nothing else is touched; the move is asynchronous (the
# window's own thread applies it, so this never waits on explorer).
#
# The sidecar already does this on `watch off`, on its exit, and at its next
# start (a crash); this is for the day none of those run. Explorer also builds
# that host afresh for each burst of presses (none exists between them), so a
# left-behind park heals itself at the next pop-up anyway; this makes it certain.
#
# SAFE TO RUN WHEN NOTHING IS WRONG: no parked window = no write, exit 0.
# PowerShell 5.1 only (no ternary, no '&&').
param([int]$TargetPid = 0)

$ErrorActionPreference = 'Stop'

$src = @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class MantleRestoreOsd {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc p, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll", SetLastError = true)] static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr c);

  public const int Park = -24000, Band = 8000;
  // NOSIZE NOZORDER NOACTIVATE NOOWNERZORDER ASYNCWINDOWPOS: the same move the sidecar makes
  const uint SWP_MOVE_ONLY = 0x0001 | 0x0004 | 0x0010 | 0x0200 | 0x4000;

  public static void DpiAware() { try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch (Exception) { } }

  /// Every parked window of that class in the given processes, put back. Lines: "back <hwnd> <x>,<y>" or "failed <hwnd> <err>".
  public static List<string> PutBack(uint[] pids) {
    var found = new List<IntPtr>();
    var set = new HashSet<uint>(pids);
    EnumWindows(delegate (IntPtr h, IntPtr l) {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (!set.Contains(pid)) return true;
      var c = new StringBuilder(64); GetClassNameW(h, c, 64);
      if (c.ToString() != "XamlExplorerHostIslandWindow") return true;
      RECT r;
      if (!GetWindowRect(h, out r)) return true;
      if (Math.Abs(r.L - Park) > Band || Math.Abs(r.T - Park) > Band) return true;
      found.Add(h);
      return true;
    }, IntPtr.Zero);
    var o = new List<string>();
    foreach (IntPtr h in found) {
      RECT r; GetWindowRect(h, out r);
      int x = r.L - Park, y = r.T - Park;
      if (SetWindowPos(h, IntPtr.Zero, x, y, 0, 0, SWP_MOVE_ONLY)) o.Add("back 0x" + h.ToInt64().ToString("X") + " " + x + "," + y);
      else o.Add("failed 0x" + h.ToInt64().ToString("X") + " Win32 error " + Marshal.GetLastWin32Error());
    }
    return o;
  }
}
'@

Write-Output 'mantle restore-osd'
try {
  Add-Type -TypeDefinition $src -Language CSharp
} catch {
  Write-Output "  could not declare the Win32 calls: $($_.Exception.Message)"
  exit 1
}
[MantleRestoreOsd]::DpiAware()

$pids = @()
if ($TargetPid -ne 0) {
  $p = Get-Process -Id $TargetPid -ErrorAction SilentlyContinue
  if ($p -eq $null) { Write-Output "  -TargetPid $TargetPid is not a running process"; exit 1 }
  if ($p.ProcessName -eq 'explorer') { Write-Output '  -TargetPid may never be explorer (it is for a test''s own stand-in)'; exit 1 }
  $pids = @([uint32]$TargetPid)
} else {
  $pids = @(Get-Process -Name explorer -ErrorAction SilentlyContinue | ForEach-Object { [uint32]$_.Id })
  if ($pids.Count -eq 0) { Write-Output '  explorer is not running: no pop-up host to put back'; exit 0 }
}

$lines = @([MantleRestoreOsd]::PutBack([uint32[]]$pids))
$back = @($lines | Where-Object { $_ -like 'back *' })
$bad = @($lines | Where-Object { $_ -like 'failed *' })
foreach ($l in $lines) { Write-Output "  $l" }
if ($lines.Count -eq 0) {
  Write-Output '  pop-up host: none parked off screen, nothing to do (verified)'
  exit 0
}
Write-Output "  pop-up host: put $($back.Count) parked window(s) back where Windows had them"
if ($bad.Count -gt 0) { Write-Output "  pop-up host: $($bad.Count) could not be moved"; exit 1 }
exit 0

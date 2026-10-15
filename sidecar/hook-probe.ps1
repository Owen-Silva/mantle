# The probe window for test-hook-health-live.js (lane mn-hook). A small window of its own that takes
# the foreground, then on each stdin line injects input ONLY while it is still in front:
#   keys N   N presses of Q (down + up) into its own text box   -> "ok N" | "notfront"
#   move     one mouse move of 0,0 (nothing on screen moves)     -> "ok" | "notfront"
#   quit
# It never sends a Win key, Alt, Tab or any chord, and it refuses to inject when it is not in front.
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class HookProbe {
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort Vk; public ushort Scan; public uint Flags; public uint Time; public IntPtr Extra; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int Dx; public int Dy; public uint Data; public uint Flags; public uint Time; public IntPtr Extra; }
  [StructLayout(LayoutKind.Explicit)] public struct U { [FieldOffset(0)] public KEYBDINPUT k; [FieldOffset(0)] public MOUSEINPUT m; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint Type; public U u; }
  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  public static uint Key(ushort vk, bool up) {
    var a = new INPUT[1]; a[0].Type = 1; a[0].u.k.Vk = vk; a[0].u.k.Flags = up ? 2u : 0u;
    return SendInput(1, a, Marshal.SizeOf(typeof(INPUT)));
  }
  public static uint Move() {
    var a = new INPUT[1]; a[0].Type = 0; a[0].u.m.Flags = 1;   // MOUSEEVENTF_MOVE, relative 0,0
    return SendInput(1, a, Marshal.SizeOf(typeof(INPUT)));
  }
}
'@
$form = New-Object System.Windows.Forms.Form
$form.Text = 'mn-hook probe'
$form.TopMost = $true
$form.StartPosition = 'Manual'
$form.Location = New-Object System.Drawing.Point(40, 40)
$form.Size = New-Object System.Drawing.Size(320, 120)
$box = New-Object System.Windows.Forms.TextBox
$box.Dock = 'Fill'
$box.Multiline = $true
$form.Controls.Add($box)
$form.Show()
$form.Activate()
$box.Focus() | Out-Null
for ($i = 0; $i -lt 20; $i++) {
  [System.Windows.Forms.Application]::DoEvents()
  if ([HookProbe]::GetForegroundWindow() -eq $form.Handle) { break }
  [HookProbe]::SetForegroundWindow($form.Handle) | Out-Null
  Start-Sleep -Milliseconds 100
}
$front = [HookProbe]::GetForegroundWindow() -eq $form.Handle
[Console]::Out.WriteLine($(if ($front) { 'ready' } else { 'notfront' }))
[Console]::Out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line -or $line -eq 'quit') { break }
  [System.Windows.Forms.Application]::DoEvents()
  $front = [HookProbe]::GetForegroundWindow() -eq $form.Handle
  $reply = 'notfront'
  if ($front -and $line -match '^keys (\d+)$') {
    $n = [int]$Matches[1]
    $sent = 0
    for ($k = 0; $k -lt $n; $k++) {
      if ([HookProbe]::GetForegroundWindow() -ne $form.Handle) { break }
      [HookProbe]::Key(0x51, $false) | Out-Null
      [HookProbe]::Key(0x51, $true) | Out-Null
      $sent++
      Start-Sleep -Milliseconds 30
      [System.Windows.Forms.Application]::DoEvents()
    }
    $reply = $(if ($sent -eq $n) { "ok $sent" } else { 'notfront' })
  } elseif ($front -and $line -eq 'move') {
    [HookProbe]::Move() | Out-Null
    $reply = 'ok'
  }
  [Console]::Out.WriteLine($reply)
  [Console]::Out.Flush()
}
$form.Close()

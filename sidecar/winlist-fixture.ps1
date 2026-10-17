# winlist-fixture.ps1 - a MINIMISED, never-activated window that renames itself every 100 ms,
# for sidecar/test-winlist-idle.js --fixture. It never takes focus (SW_SHOWMINNOACTIVE) and exits
# on its own after -Secs seconds. Prints "hwnd <n>" once it is up and "gone" as it closes.
param([int]$Secs = 8)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -Namespace W -Name U -MemberDefinition '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);'
$f = New-Object System.Windows.Forms.Form
$f.Text = 'mantle winlist fixture 0'
$f.ShowInTaskbar = $true
$h = $f.Handle
[W.U]::ShowWindow($h, 7) | Out-Null   # SW_SHOWMINNOACTIVE: listed, minimised, focus untouched
[Console]::Out.WriteLine('hwnd ' + $h.ToInt64())
[Console]::Out.Flush()
$script:i = 0
$t = New-Object System.Windows.Forms.Timer
$t.Interval = 100
$t.add_Tick({ $script:i++; $f.Text = 'mantle winlist fixture ' + $script:i })
$t.Start()
$end = New-Object System.Windows.Forms.Timer
$end.Interval = $Secs * 1000
$end.add_Tick({ $t.Stop(); $end.Stop(); $f.Dispose(); [Console]::Out.WriteLine('gone'); [Console]::Out.Flush(); [System.Windows.Forms.Application]::ExitThread() })
$end.Start()
[System.Windows.Forms.Application]::Run()

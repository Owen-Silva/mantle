# build.ps1 - compile mantle.elevated.exe, the Task Manager admin helper (lane tm-elevate).
#
# A SEPARATE exe from Mantle.Sidecar.exe, built with the SAME built-in csc.exe (no .NET SDK on this
# machine). It is installed once behind a UAC prompt into an admin-only folder and runs elevated as
# a scheduled task; the non-elevated sidecar talks to it over a named pipe. See Program.cs for the
# security model and tools/mantle-elevated-setup.ps1 for install/uninstall.
#
# C# 5 only (Framework64 v4.0.30319 csc): no string interpolation, no nameof, no out var, no ?.
#
# SALIENT: the exe's manifest is the default asInvoker (NOT requireAdministrator). It must NOT
# auto-elevate when started directly - the un-elevated test runs it as-is, and elevation comes ONLY
# from the scheduled task's RunLevel Highest. Launched un-elevated it serves the test seam and every
# admin op answers needsAdmin.
#
# ---------------------------------------------------------------------------------------------
# STANDALONE build (this script, today): the transport + security + this lane's three read handlers.
#   elevated/Program.cs      pipe server, client auth, handshake, idle timeout, dispatch, allowlist
#   elevated/Host.cs         FeatureTable/Lanes/MantleFeature shim + ElevatedHost allowlist+dispatch
#   elevated/NetTrace.cs     taskmgr.netsample  (ETW Kernel-Network per-pid bytes)
#   elevated/Srum.cs         taskmgr.apphistory (SRUM SRUDB.dat read)
#   elevated/StartupImpact.cs taskmgr.startupimpact (WDI StartupInfo + BAM + StartupApproved)
#   ../Json.cs               the exact wire format (dependency-free; reused from the main sidecar)
#
# INTEGRATION build (when tm-data's handlers land): add their files and their shared helpers so
# their [MantleFeature] Register(FeatureTable) methods compile in UNCHANGED and register via the
# same reflection. Add to $sources below (keep the standalone set), DO NOT add the real Features.cs,
# Lanes.cs or Program.cs (this build's Host.cs + Program.cs provide that surface):
#   ../Win32.cs              Win32.PostMessageW and friends the handlers call
#   ../TaskMgr.cs            TaskMgr.Refuse/Take/Held/Release/ReadProcs/Str/DryRun/RunTaskkill/... + its [MantleFeature] (filtered by the allowlist to taskmgr.* reads only; the admin ops are the new ones)
#   ../TaskMgrDetails.cs     (tm-admin) taskmgr.endpid and the Details admin ops  -- rename cmd to match the allowlist
#   ../ProcOps.cs            priority/affinity/efficiency/uacVirt/dump  (tm-data, when written)
#   ../Services.cs           taskmgr.service start/stop/restart           (tm-data, when written)
#   ../Users.cs              taskmgr.userop {session, op}                 (tm-data, when written)
# DONE (tm-data 10-28): see $integration below ("Services.cs" is TaskMgrSvc.cs; ProcDetails.cs added).
# Each new command name MUST be on ElevatedHost.Allow (Host.cs); names not on it are refused even if
# registered. See TM-SPEC.md "## Proposals: tm-elevate".
# ---------------------------------------------------------------------------------------------
param([string]$Out = '')

$ErrorActionPreference = 'Stop'
$here    = Split-Path -Parent $MyInvocation.MyCommand.Path     # sidecar/elevated
$sidecar = Split-Path -Parent $here                            # sidecar
$csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'

if (-not (Test-Path $csc)) {
  Write-Output "elevated build FAILED: no C# compiler at $csc"
  exit 1
}

# Keep Program.Version and the VERSION file in lockstep (setup writes VERSION beside the exe; the
# client compares it to tell 'stale' and re-prompt).
$verFile = (Get-Content (Join-Path $here 'VERSION') -Raw).Trim()
$verConst = (Select-String -Path (Join-Path $here 'Program.cs') -Pattern 'public const string Version = "([^"]+)"').Matches[0].Groups[1].Value
if ($verFile -ne $verConst) {
  Write-Output "elevated build FAILED: VERSION file ($verFile) != Program.Version ($verConst)"
  exit 1
}

if ($Out) {
  $out = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine((Get-Location).Path, $Out))
  $bin = Split-Path -Parent $out
} else {
  $bin = Join-Path $here 'bin'
  $out = Join-Path $bin 'mantle.elevated.exe'
}
if (-not (Test-Path $bin)) { New-Item -ItemType Directory -Path $bin | Out-Null }

# STANDALONE source set. (Integration adds the files listed in the header comment.)
$sources = @(
  (Join-Path $here 'Program.cs'),
  (Join-Path $here 'Host.cs'),
  (Join-Path $here 'NetTrace.cs'),
  (Join-Path $here 'Srum.cs'),
  (Join-Path $here 'StartupImpact.cs'),
  (Join-Path $sidecar 'Json.cs')
)
foreach ($s in $sources) { if (-not (Test-Path $s)) { Write-Output "elevated build FAILED: missing $s"; exit 1 } }

# INTEGRATION set (tm-data 10-28): the main sidecar's Task Manager handlers, compiled in UNCHANGED.
# Every one of these files must exist (a missing one would silently drop a command the allowlist
# promises, so it fails the build instead). Their commands that are not on ElevatedHost.Allow stay
# unreachable (snapshot, close, frame, runtask, properties, ...).
$integration = @(
  'Win32.cs',          # shared P/Invoke
  'TaskMgr.cs',        # Refuse / Take / guard policies (GUARD_USER) / ReadProcs
  'TaskMgrDetails.cs', # taskmgr.endpid
  'ProcOps.cs',        # taskmgr.priority / affinity / efficiency / uacvirt / dump
  'ProcDetails.cs',    # taskmgr.details (other users' and system processes' fields)
  'TaskMgrSvc.cs',     # taskmgr.service
  'Users.cs'           # taskmgr.userop
)
foreach ($f in $integration) {
  $p = Join-Path $sidecar $f
  if (-not (Test-Path $p)) { Write-Output "elevated build FAILED: missing integration file $p"; exit 1 }
  $sources += $p
}
# TaskMgr.cs's guard reads game mode's OWN list (GameMode.GamePrefixes, never a copy: a hand copy once
# lacked "Riot" and hung Riot Client). The real GameMode.cs cannot compile here (it is a whole feature),
# so its GamePrefixes initializer is lifted out of ../GameMode.cs at build time into a generated shim.
# No match = the build fails, never a helper with a guessed list.
$gm = Get-Content (Join-Path $sidecar 'GameMode.cs') -Raw
$m = [regex]::Match($gm, 'internal static readonly string\[\] GamePrefixes = \{[^}]*\};')
if (-not $m.Success) { Write-Output "elevated build FAILED: GameMode.GamePrefixes not found in ../GameMode.cs"; exit 1 }
$gen = Join-Path $bin 'gen'
if (-not (Test-Path $gen)) { New-Item -ItemType Directory -Path $gen | Out-Null }
$shim = Join-Path $gen 'GameModeShim.cs'
$shimText = @(
  '// GENERATED by sidecar/elevated/build.ps1 from sidecar/GameMode.cs. Never edit: rebuild.',
  'namespace Mantle {',
  '  static class GameMode {',
  ('    ' + $m.Value),
  '    internal static string[] Join(string[] a, string[] b) { var r = new string[a.Length + b.Length]; a.CopyTo(r, 0); b.CopyTo(r, a.Length); return r; }',
  '  }',
  '}'
) -join "`r`n"
Set-Content -Path $shim -Value $shimText -Encoding UTF8
$sources += $shim

$cscArgs = @(
  '/target:winexe',           # no console-window flash when the task starts it
  '/optimize+',
  '/nologo',
  '/langversion:5',
  "/out:$out",
  '/r:System.dll',
  '/r:System.Core.dll',       # System.IO.Pipes.NamedPipeServerStream + PipeSecurity
  '/r:System.Xml.dll'         # StartupImpact.cs reads the WDI StartupInfo XML
) + $sources

Write-Output "elevated build: csc -> $out"
& $csc $cscArgs
if ($LASTEXITCODE -ne 0) { Write-Output "elevated build FAILED (csc exit $LASTEXITCODE)"; exit 1 }
Write-Output "elevated build OK: $out (version $verConst)"
exit 0

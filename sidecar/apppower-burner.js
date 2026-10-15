// apppower-burner.js - the throwaway process sidecar/test-apppower.js (and the top-entry checks in
// sidecar/test-topbar.js) point App power at, so no test ever touches one of Owen's real apps
// (lane mantle-power-sidecar, 2026-10-14). Not a test itself: it only builds and drives the burner.
//
// The burner is a tiny C# console exe compiled with the csc that sidecar/build.ps1 uses, under a
// UNIQUE name (mpburn-<rand>.exe) in %TEMP%\mantle-apppower-test\<run>\, so a match on its exe name
// can only ever hit this run's processes. Every burner exits by itself after --life seconds and when
// its stdin closes (the test died), and the tests kill every pid they started in a finally.
//
// It reports on ITSELF, from inside, through the same Windows calls a user-mode app would make about
// its own process: priority class, power-throttling state, memory priority, whether it runs in a
// job and that job's CPU rate and memory limit (QueryInformationJobObject(NULL) = the job it is in),
// its working set, how much work its spinning threads got done per second, and how far an
// allocation got. That is the independent read-back: it never goes through the sidecar's code.
//
//   burner <mode> [args] --info <file> [--life <s>] [--nostdin]
//     spin N          N threads spinning (rate = loop blocks per second, all threads)
//     alloc STEP MAX  on stdin "go": commit STEP MB at a time (never touched) up to MAX MB or the first
//                     failure; prints "ALLOC <mb>" per step and "STOP <mb> <why>"
//     touch MB        commit and touch MB (its working set grows by that much)
//     idle            nothing
//     parent          on stdin "spawn <mode ...>": starts a child of ITSELF (same exe), prints "CHILD <pid>"
//   Every mode writes its self-report as one JSON object to --info every 250 ms.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const CSC = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
const ROOT = path.join(os.tmpdir(), 'mantle-apppower-test');

const SOURCE = String.raw`
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

static class B {
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern uint GetPriorityClass(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] struct THR { public uint Version, ControlMask, StateMask; }
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetProcessInformation(IntPtr h, int cls, ref THR info, uint size);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetProcessInformation(IntPtr h, int cls, ref uint info, uint size);
  [DllImport("kernel32.dll")] static extern bool IsProcessInJob(IntPtr p, IntPtr job, out bool r);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int cls, IntPtr info, uint len, out uint ret);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr VirtualAlloc(IntPtr a, UIntPtr size, uint type, uint protect);
  [StructLayout(LayoutKind.Sequential)] struct PMC { public uint cb, PageFaultCount; public UIntPtr PeakWorkingSetSize, WorkingSetSize, QuotaPeakPagedPoolUsage, QuotaPagedPoolUsage, QuotaPeakNonPagedPoolUsage, QuotaNonPagedPoolUsage, PagefileUsage, PeakPagefileUsage; }
  [DllImport("psapi.dll", SetLastError = true)] static extern bool GetProcessMemoryInfo(IntPtr h, ref PMC c, uint cb);

  static string Info;
  static long _blocks;            // spin loop blocks done, all threads
  static long _rate;              // blocks in the last second
  static volatile int _allocMb;
  static volatile string _stop;

  static void Main(string[] a) {
    string mode = a.Length > 0 ? a[0] : "idle";
    int life = 240; bool readIn = true;
    for (int i = 0; i < a.Length; i++) {
      if (a[i] == "--info" && i + 1 < a.Length) Info = a[i + 1];
      if (a[i] == "--life" && i + 1 < a.Length) life = int.Parse(a[i + 1]);
      if (a[i] == "--nostdin") readIn = false;
    }
    var end = DateTime.UtcNow.AddSeconds(life);
    var rep = new Thread(delegate () {
      long last = 0; var sw = Stopwatch.StartNew(); long lastMs = 0;
      while (true) {
        long now = sw.ElapsedMilliseconds;
        if (now - lastMs >= 1000) { long b = Interlocked.Read(ref _blocks); _rate = (b - last) * 1000 / Math.Max(1, now - lastMs); last = b; lastMs = now; }
        Report();
        if (DateTime.UtcNow > end) Environment.Exit(0);
        Thread.Sleep(250);
      }
    });
    rep.IsBackground = true; rep.Start();
    if (mode == "spin") {
      int n = int.Parse(a[1]);
      for (int t = 0; t < n; t++) {
        var th = new Thread(delegate () {
          double x = 1.0001;
          while (true) { for (int k = 0; k < 200000; k++) x = x * 1.0000001 + 0.0000001; if (x > 1e300) x = 1.0001; Interlocked.Increment(ref _blocks); }
        });
        th.IsBackground = true; th.Start();
      }
    } else if (mode == "touch") {
      long mb = long.Parse(a[1]);
      IntPtr p = VirtualAlloc(IntPtr.Zero, new UIntPtr((ulong)(mb << 20)), 0x3000, 0x04);
      if (p != IntPtr.Zero) { for (long o = 0; o < (mb << 20); o += 4096) Marshal.WriteByte(new IntPtr(p.ToInt64() + o), 0, (byte)1); _allocMb = (int)mb; }
    }
    if (!readIn) { Thread.Sleep(Timeout.Infinite); return; }
    string line;
    while ((line = Console.ReadLine()) != null) {
      line = line.Trim();
      if (line == "exit") break;
      if (line == "go" && mode == "alloc") Alloc(int.Parse(a[1]), int.Parse(a[2]));
      if (line.StartsWith("spawn ") && mode == "parent") {
        var psi = new ProcessStartInfo(Process.GetCurrentProcess().MainModule.FileName, line.Substring(6) + " --nostdin");
        psi.UseShellExecute = false; psi.CreateNoWindow = true;
        var c = Process.Start(psi);
        Console.WriteLine("CHILD " + c.Id); Console.Out.Flush();
      }
    }
    Environment.Exit(0);
  }

  static void Alloc(int step, int max) {
    int got = 0;
    while (got + step <= max) {
      IntPtr p = VirtualAlloc(IntPtr.Zero, new UIntPtr((ulong)step << 20), 0x3000, 0x04);   // MEM_COMMIT|MEM_RESERVE, never touched
      if (p == IntPtr.Zero) { _stop = "error " + Marshal.GetLastWin32Error(); break; }
      got += step; _allocMb = got;
      Console.WriteLine("ALLOC " + got); Console.Out.Flush();
    }
    if (_stop == null) _stop = "max";
    Console.WriteLine("STOP " + got + " " + _stop); Console.Out.Flush();
  }

  static void Report() {
    try {
      IntPtr me = GetCurrentProcess();
      var t = new THR(); t.Version = 1;
      bool thrOk = GetProcessInformation(me, 4, ref t, 12);
      uint mp = 0; bool mpOk = GetProcessInformation(me, 0, ref mp, 4);
      bool inJob; IsProcessInJob(me, IntPtr.Zero, out inJob);
      uint cpuFlags = 0, cpuRate = 0, limFlags = 0; long jobMem = 0; uint ret;
      if (inJob) {
        IntPtr b = Marshal.AllocHGlobal(144);
        try {
          if (QueryInformationJobObject(IntPtr.Zero, 15, b, 8, out ret)) { cpuFlags = (uint)Marshal.ReadInt32(b, 0); cpuRate = (uint)Marshal.ReadInt32(b, 4); }
          if (QueryInformationJobObject(IntPtr.Zero, 9, b, 144, out ret)) { limFlags = (uint)Marshal.ReadInt32(b, 16); jobMem = Marshal.ReadInt64(b, 120); }
        } finally { Marshal.FreeHGlobal(b); }
      }
      var c = new PMC(); c.cb = (uint)Marshal.SizeOf(typeof(PMC));
      long ws = GetProcessMemoryInfo(me, ref c, c.cb) ? (long)c.WorkingSetSize.ToUInt64() : -1;
      string s = "{\"pid\":" + Process.GetCurrentProcess().Id + ",\"prio\":" + GetPriorityClass(me) +
        ",\"thrOk\":" + (thrOk ? "true" : "false") + ",\"thrCtl\":" + t.ControlMask + ",\"thrState\":" + t.StateMask +
        ",\"memPrio\":" + (mpOk ? mp.ToString() : "null") + ",\"inJob\":" + (inJob ? "true" : "false") +
        ",\"cpuFlags\":" + cpuFlags + ",\"cpuRate\":" + cpuRate + ",\"limFlags\":" + limFlags + ",\"jobMem\":" + jobMem +
        ",\"ws\":" + ws + ",\"rate\":" + Interlocked.Read(ref _rate) + ",\"alloc\":" + _allocMb +
        ",\"stop\":" + (_stop == null ? "null" : "\"" + _stop + "\"") + ",\"at\":" + DateTime.UtcNow.Ticks / 10000 + "}";
      if (Info != null) { string tmp = Info + ".tmp"; File.WriteAllText(tmp, s); File.Copy(tmp, Info, true); }
    } catch (Exception) { }
  }
}
`;

/** Compile a burner as <dir>/<name>.exe (dir is created). Returns the exe path; throws with csc's words. */
function build(dir, name) {
  fs.mkdirSync(dir, { recursive: true });
  const src = path.join(dir, 'burner.cs');
  const exe = path.join(dir, name + '.exe');
  fs.writeFileSync(src, SOURCE);
  const r = spawnSync(CSC, ['/nologo', '/optimize+', '/target:exe', '/platform:x64', '/out:' + exe, src], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0 || !fs.existsSync(exe)) throw new Error('burner build failed: ' + (r.stdout || '') + (r.stderr || ''));
  return exe;
}

/** A fresh run folder and a unique burner name in it. */
function runDir() {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  return { dir: path.join(ROOT, 'run-' + id), name: 'mpburn-' + id };
}

/**
 * Start one burner. Returns { proc, pid, info(), lines, waitLine(re, ms), send(line) }.
 * info() parses the latest self-report (or null).
 */
function start(exe, args, opts) {
  const o = opts || {};
  const infoFile = path.join(path.dirname(exe), `info-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`);
  const proc = spawn(exe, args.concat(['--info', infoFile, '--life', String(o.life || 240)]), { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  const lines = [];
  const waiters = [];
  let buf = '';
  proc.stdout.on('data', (c) => {
    buf += c.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!l) continue;
      lines.push(l);
      for (const w of waiters.slice()) if (w.re.test(l)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(l); }
    }
  });
  proc.stdin.on('error', () => {});
  return {
    proc, pid: proc.pid, infoFile, lines,
    info() { return readInfo(infoFile); },
    send(l) { try { proc.stdin.write(l + '\n'); } catch (_) { /* gone */ } },
    waitLine(re, ms) {
      const hit = lines.find((l) => re.test(l));
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const w = { re, resolve: (l) => { clearTimeout(t); resolve(l); } };
        const t = setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); reject(new Error(`no line ${re} within ${ms} ms`)); }, ms);
        waiters.push(w);
      });
    },
  };
}

function readInfo(file) {
  // the burner rewrites the file 4 times a second: a read that lands mid-copy is retried
  for (let i = 0; i < 4; i++) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15); }
  }
  return null;
}

/** Kill by pid, never by name. Quiet when already gone. */
function kill(pid) {
  if (!pid) return;
  try { process.kill(pid); } catch (_) { /* gone */ }
}

/** Delete a run folder once its burners are gone (a just-killed exe can hold its file a moment). */
async function cleanup(dir) {
  for (let i = 0; i < 10; i++) {
    try { fs.rmSync(dir, { recursive: true, force: true }); return true; } catch (_) { await new Promise((r) => setTimeout(r, 300)); }
  }
  return false;
}

module.exports = { build, runDir, start, readInfo, kill, cleanup, ROOT };

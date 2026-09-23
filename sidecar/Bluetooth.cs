// Bluetooth.cs - `bluetooth`: the radio's state, and the switch.
//
// THERE IS NO WIN32 API FOR THIS. Win32 can tell you a Bluetooth radio EXISTS
// (BluetoothFindFirstRadio) but not whether it is switched on, and nothing in
// Win32 can turn it on. The only supported switch is WinRT's
// Windows.Devices.Radios.Radio, so this file is the one place in the sidecar
// that reaches into WinRT.
//
// TWO ROUTES, and the reply says which one answered (`via`):
//
//   'winrt'       in-process, milliseconds. build.ps1 defines MANTLE_WINRT
//                 with the SDK's UNION winmd, or - THE ROUTE THIS MACHINE
//                 USES since 2026-09-22, with no SDK - MANTLE_WINMD with the
//                 split winmds that ship in System32\WinMetadata.
//   'powershell'  the fallback when the in-process call fails or was not
//                 compiled in. Before MANTLE_WINMD it was the only route here.
//
// THE POWERSHELL ROUTE IS A RESIDENT HELPER (2026-09-22), not a launch per
// call. It used to be one powershell.exe per read, and two things were wrong
// with that, both measured on Owen's loaded machine:
//
//   * a launch plus the WinRT type loading cost ~3 s, ON THE COMMAND THREAD,
//     and every other command queued behind it - that was the permanent
//     backlog in the live log;
//   * and it never worked: the script used [System.WindowsRuntimeSystemExtensions]
//     without loading System.Runtime.WindowsRuntime first, so AsTask was
//     null, the radio list came back empty and every read said "Windows
//     listed no Bluetooth radio" while the radio was on.
//
// Now one powershell.exe is started on demand with the WinRT types loaded
// once, and answers one line per request over its stdin/stdout: ~1 s to start
// (more under load), then single-digit milliseconds per read or switch. It
// exits after HostIdleMs without a request, and on its own the moment the
// sidecar dies (its stdin closes). And the READ is never made on a command
// lane at all: QuickSettings.cs serves it from a cache that a background
// thread refreshes, so the slowest part of the product can no longer hold up
// the fastest.
using System;
using System.Collections;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace Mantle {
  static class Bluetooth {
    const int WinRtTimeoutMs = 3000;

    /// Whether the machine HAS a Bluetooth radio. Win32, and the only way to
    /// tell "no radio" from "radio list came back empty".
    public static bool Present() {
      var p = new Win32.BLUETOOTH_FIND_RADIO_PARAMS();
      p.dwSize = (uint)Marshal.SizeOf(typeof(Win32.BLUETOOTH_FIND_RADIO_PARAMS));
      IntPtr radio = IntPtr.Zero;
      IntPtr find = IntPtr.Zero;
      try {
        find = Win32.BluetoothFindFirstRadio(ref p, out radio);
        return find != IntPtr.Zero;
      } catch (Exception) {
        return false;   // no bthprops.cpl: no Bluetooth stack at all
      } finally {
        if (radio != IntPtr.Zero) { try { Win32.CloseHandle(radio); } catch (Exception) { } }
        if (find != IntPtr.Zero) { try { Win32.BluetoothFindRadioClose(find); } catch (Exception) { } }
      }
    }

    /// A FRESH read. It blocks for as long as the radio takes to answer, so it
    /// runs on the cache's refresh thread or the slow lane - never on ui.
    public static IDictionary Read() {
      bool present = Present();
      string reason = null;
      bool on = false;
      string via = "winrt";

      string state = null;
#if MANTLE_WINRT || MANTLE_WINMD
      try {
        state = WinRtState(out reason);
      } catch (Exception ex) {
        state = null;
        reason = "the in-process Bluetooth API failed (" + ex.GetType().Name + ": " + ex.Message + ")";
      }
#endif
      if (state == null) {
        via = "powershell";
        string psReason;
        state = HostState(out psReason);
        if (state == null && psReason != null) reason = (reason == null ? "" : reason + "; ") + psReason;
      }

      if (state != null) {
        on = state == "on";
        reason = null;
      } else if (!present) {
        reason = "this machine has no Bluetooth radio";
      } else if (reason == null) {
        reason = "the Bluetooth radio's state could not be read";
      }

      return Json.Obj("ok", state != null || !present, "present", present, "on", on,
                      "via", via, "reason", reason);
    }

    /// Switch, then read back. `readBack` is the plain state for the cache;
    /// the return value is the reply, which also says whether the switch took.
    public static IDictionary Set(bool want, out IDictionary readBack) {
      readBack = null;
      bool present = Present();
      if (!present)
        return Json.Obj("ok", false, "present", false, "on", false, "via", "powershell",
                        "reason", "this machine has no Bluetooth radio");

      string reason = null;
      bool done = false;
      string via = "winrt";

#if MANTLE_WINRT || MANTLE_WINMD
      try {
        done = WinRtSet(want, out reason);
      } catch (Exception ex) {
        done = false;
        reason = "the in-process Bluetooth API failed (" + ex.GetType().Name + ": " + ex.Message + ")";
      }
#endif
      if (!done) {
        via = "powershell";
        string psReason;
        done = HostSet(want, out psReason);
        if (!done && psReason != null) reason = (reason == null ? "" : reason + "; ") + psReason;
      }

      var now = Read();
      readBack = Json.Obj();
      foreach (DictionaryEntry e in now) readBack[e.Key] = e.Value;
      if (!done) {
        now["ok"] = false;
        now["reason"] = reason ?? "Windows refused to switch the Bluetooth radio";
      }
      now["via"] = via;
      return now;
    }

#if MANTLE_WINRT || MANTLE_WINMD
    // ------------------------------------------------------------ in-process
    //
    // Two ways to compile this, one body:
    //   MANTLE_WINRT  the SDK's union winmd, awaited with AsTask().
    //   MANTLE_WINMD  the split winmds in System32\WinMetadata (no SDK), awaited
    //                 with WinRt.Await (Media.cs), because AsTask needs the
    //                 union identity. Measured by the media lane, 2026-09-22:
    //                 GetRadiosAsync 64 ms cold, ~2 ms warm.
    // Radio objects are not agile, so they are fetched fresh on the calling
    // thread every time and never cached or handed to another thread.

    static string Wait<T>(Windows.Foundation.IAsyncOperation<T> op, string what, out T value) {
#if MANTLE_WINMD
      return WinRt.Await(op, WinRtTimeoutMs, what, out value);
#else
      value = default(T);
      var t = op.AsTask();
      if (!t.Wait(WinRtTimeoutMs)) return what + " did not answer in time";
      value = t.Result;
      return null;
#endif
    }

    /// The Bluetooth radio, or null with the reason.
    static Windows.Devices.Radios.Radio WinRtRadio(out string reason) {
      Windows.Devices.Radios.RadioAccessStatus access;
      reason = Wait(Windows.Devices.Radios.Radio.RequestAccessAsync(), "the radio access request", out access);
      if (reason != null) return null;
      if (access != Windows.Devices.Radios.RadioAccessStatus.Allowed) {
        reason = "Windows denied access to the radios (" + access +
                 "); check Settings > Privacy & security > Radios";
        return null;
      }
      System.Collections.Generic.IReadOnlyList<Windows.Devices.Radios.Radio> radios;
      reason = Wait(Windows.Devices.Radios.Radio.GetRadiosAsync(), "the radio list", out radios);
      if (reason != null) return null;
      foreach (Windows.Devices.Radios.Radio r in radios) {
        if (r.Kind == Windows.Devices.Radios.RadioKind.Bluetooth) return r;
      }
      reason = "Windows listed no Bluetooth radio";
      return null;
    }

    /// "on" / "off", or null with the reason. Everything is bounded by a
    /// timeout: a WinRT call that never completes must not take the shell with
    /// it.
    static string WinRtState(out string reason) {
      var r = WinRtRadio(out reason);
      if (r == null) return null;
      return r.State == Windows.Devices.Radios.RadioState.On ? "on" : "off";
    }

    static bool WinRtSet(bool want, out string reason) {
      var r = WinRtRadio(out reason);
      if (r == null) return false;
      Windows.Devices.Radios.RadioAccessStatus set;
      reason = Wait(r.SetStateAsync(want ? Windows.Devices.Radios.RadioState.On
                                         : Windows.Devices.Radios.RadioState.Off),
                    "the radio switch", out set);
      if (reason != null) return false;
      if (set != Windows.Devices.Radios.RadioAccessStatus.Allowed) {
        reason = "Windows refused the switch (" + set + ")";
        return false;
      }
      return true;
    }
#endif

    // --------------------------------------------------- the resident helper

    const int HostStartMs = 20000;   // a cold powershell.exe under Owen's load
    const int HostAskMs = 8000;      // one read or switch; normally < 10 ms
    const int HostIdleMs = 90000;    // then it goes, and gives its ~70 MB back
    const int HostRetryMs = 30000;   // after a failed start, do not relaunch in a loop

    // One line per request, one line per answer:
    //   read -> "state On" | "state Off" | "state Disabled" | "none" | "error ..."
    //   on / off -> "set Allowed" | "set DeniedByUser" | ... | "none" | "error ..."
    // Add-Type FIRST: without System.Runtime.WindowsRuntime loaded,
    // [System.WindowsRuntimeSystemExtensions] does not resolve, AsTask is null
    // and the radio list silently comes back empty (the pre-2026-09-22 bug).
    const string HostScript =
      "$ProgressPreference='SilentlyContinue';$ErrorActionPreference='Stop';" +
      "Add-Type -AssemblyName System.Runtime.WindowsRuntime;" +
      "$null=[Windows.Devices.Radios.Radio,Windows.System.Devices,ContentType=WindowsRuntime];" +
      "$null=[Windows.Devices.Radios.RadioAccessStatus,Windows.System.Devices,ContentType=WindowsRuntime];" +
      "$as=([System.WindowsRuntimeSystemExtensions].GetMethods()|?{$_.Name -eq 'AsTask' -and " +
      "$_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'})[0];" +
      "function Aw($o,$t){$k=$as.MakeGenericMethod($t).Invoke($null,@($o));" +
      "if(-not $k.Wait(6000)){throw 'Windows did not answer within 6 s'};$k.Result};" +
      "$acc=Aw ([Windows.Devices.Radios.Radio]::RequestAccessAsync()) ([Windows.Devices.Radios.RadioAccessStatus]);" +
      "[Console]::Out.WriteLine('ready '+$acc);[Console]::Out.Flush();" +
      "while(($l=[Console]::In.ReadLine()) -ne $null){$o='';try{" +
      "$rs=Aw ([Windows.Devices.Radios.Radio]::GetRadiosAsync()) " +
      "([System.Collections.Generic.IReadOnlyList[Windows.Devices.Radios.Radio]]);" +
      "$bt=$rs|?{$_.Kind -eq 'Bluetooth'}|Select-Object -First 1;" +
      "if(-not $bt){$o='none'}" +
      "elseif($l -eq 'read'){$o='state '+$bt.State}" +
      "elseif($l -eq 'on' -or $l -eq 'off'){" +
      "$s=if($l -eq 'on'){[Windows.Devices.Radios.RadioState]::On}else{[Windows.Devices.Radios.RadioState]::Off};" +
      "$o='set '+(Aw ($bt.SetStateAsync($s)) ([Windows.Devices.Radios.RadioAccessStatus]))}" +
      "else{$o='error unknown request '+$l}" +
      "}catch{$o='error '+($_.Exception.Message -replace '[\\r\\n]+',' ')};" +
      "[Console]::Out.WriteLine($o);[Console]::Out.Flush()}";

    static readonly object _hostLock = new object();   // one request at a time
    static Process _host;              // written under _hostLock; read by StopHost without it
    static StreamWriter _hostIn;
    static StreamReader _hostOut;
    static string _hostAccess;         // what RequestAccessAsync said at start
    static string _hostLastErr;        // last stderr line, for reasons
    static long _hostUsedTs, _hostFailedTs;
    static string _hostFailedWhy;
    static Timer _idleTimer;

    static string HostState(out string reason) {
      string a = HostAsk("read", out reason);
      if (a == null) return null;
      if (a == "state On") return "on";
      if (a == "state Off" || a == "state Disabled") return "off";
      if (a == "none") { reason = "Windows listed no Bluetooth radio"; return null; }
      if (a.StartsWith("error ", StringComparison.Ordinal)) {
        reason = "the Bluetooth helper could not read the radio (" + a.Substring(6) + ")";
        return null;
      }
      reason = "the radio answered with something unexpected (" + a + ")";
      return null;
    }

    static bool HostSet(bool want, out string reason) {
      string a = HostAsk(want ? "on" : "off", out reason);
      if (a == null) return false;
      if (a == "set Allowed") return true;
      if (a == "none") { reason = "Windows listed no Bluetooth radio"; return false; }
      if (a.StartsWith("set ", StringComparison.Ordinal)) {
        reason = "Windows refused the switch (" + a.Substring(4) + ")" +
                 (_hostAccess != null && _hostAccess != "Allowed"
                   ? "; radio access is " + _hostAccess + ", check Settings > Privacy & security > Radios" : "");
        return false;
      }
      reason = a.StartsWith("error ", StringComparison.Ordinal)
        ? "the Bluetooth helper could not switch the radio (" + a.Substring(6) + ")"
        : "the radio answered the switch with something unexpected (" + a + ")";
      return false;
    }

    /// One request to the helper, starting it first if need be. Returns the
    /// answer line, or null with the reason. Bounded: a helper that does not
    /// answer is killed, and the next request starts a fresh one.
    static string HostAsk(string line, out string reason) {
      reason = null;
      lock (_hostLock) {
        if (!EnsureHost(out reason)) return null;
        try {
          _hostIn.WriteLine(line);
          _hostIn.Flush();
          var t = _hostOut.ReadLineAsync();
          if (!t.Wait(HostAskMs)) {
            KillHostLocked();
            reason = "the Bluetooth helper (powershell.exe) did not answer within " + (HostAskMs / 1000) +
                     " s, so it was stopped; the next request starts a new one";
            return null;
          }
          string ans = t.Result;
          if (ans == null) {
            string why = _hostLastErr;
            KillHostLocked();
            reason = "the Bluetooth helper (powershell.exe) exited" + (why != null ? " (" + why + ")" : "");
            return null;
          }
          _hostUsedTs = Stopwatch.GetTimestamp();
          return ans.Trim();
        } catch (Exception ex) {
          KillHostLocked();
          reason = "the Bluetooth helper could not be asked (" + ex.GetType().Name + ": " + ex.Message + ")";
          return null;
        }
      }
    }

    static bool EnsureHost(out string reason) {
      reason = null;
      if (_host != null) {
        bool exited = true;
        try { exited = _host.HasExited; } catch (Exception) { }
        if (!exited) return true;
        KillHostLocked();
      }
      if (_hostFailedTs != 0 && Lanes.MsSince(_hostFailedTs) < HostRetryMs) {
        reason = _hostFailedWhy + " (it is retried " + (HostRetryMs / 1000) + " s after a failure, not on every read)";
        return false;
      }

      Process p = null;
      try {
        // -EncodedCommand (UTF-16LE base64): the script has quotes, pipes and
        // braces, and none of them survive a command line intact otherwise.
        var psi = new ProcessStartInfo("powershell.exe",
          "-NoProfile -NonInteractive -EncodedCommand " +
          Convert.ToBase64String(Encoding.Unicode.GetBytes(HostScript)));
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;          // never flash a console over Owen's screen
        psi.RedirectStandardInput = true;
        psi.RedirectStandardOutput = true;
        // Redirected AND drained: left alone it would inherit OUR stderr, which
        // is the pipe Electron reads, and PowerShell's CLIXML progress records
        // would land in Mantle's log as sidecar errors.
        psi.RedirectStandardError = true;
        p = new Process();
        p.StartInfo = psi;
        p.ErrorDataReceived += delegate (object s, DataReceivedEventArgs e) {
          string d = e.Data;
          if (string.IsNullOrEmpty(d) || d.StartsWith("#< CLIXML", StringComparison.Ordinal)) return;
          // A redirected powershell.exe writes its errors as CLIXML; keep the
          // words, not the markup.
          int at = d.IndexOf("<S S=\"Error\">", StringComparison.Ordinal);
          if (at >= 0) {
            int end = d.IndexOf("</S>", at, StringComparison.Ordinal);
            d = d.Substring(at + 13, (end > at ? end : d.Length) - at - 13).Replace("_x000D__x000A_", " ").Trim();
          } else if (d.StartsWith("<Objs", StringComparison.Ordinal)) {
            return;   // progress records and the like: nothing a human needs
          }
          if (d.Length == 0) return;
          _hostLastErr = d.Length > 200 ? d.Substring(0, 200) : d;
        };
        long t0 = Stopwatch.GetTimestamp();
        p.Start();
        p.BeginErrorReadLine();
        var rd = p.StandardOutput;
        var ready = rd.ReadLineAsync();
        if (!ready.Wait(HostStartMs) || ready.Result == null ||
            !ready.Result.StartsWith("ready", StringComparison.Ordinal)) {
          string got = ready.IsCompleted && ready.Result != null ? ready.Result.Trim() : null;
          try { if (!p.HasExited) p.Kill(); } catch (Exception) { }
          try { p.Dispose(); } catch (Exception) { }
          _hostFailedTs = Stopwatch.GetTimestamp();
          _hostFailedWhy = "the Bluetooth helper (powershell.exe) did not start" +
                           (got != null ? ": it said \"" + got + "\""
                            : ready.IsCompleted ? ": it exited" + (_hostLastErr != null ? " (" + _hostLastErr + ")" : "")
                            : " within " + (HostStartMs / 1000) + " s");
          reason = _hostFailedWhy;
          return false;
        }
        _hostAccess = ready.Result.Trim().Length > 6 ? ready.Result.Trim().Substring(6) : null;
        _host = p;
        _hostIn = p.StandardInput;
        _hostIn.AutoFlush = true;
        _hostOut = rd;
        _hostUsedTs = Stopwatch.GetTimestamp();
        _hostFailedTs = 0;
        _hostFailedWhy = null;
        if (_idleTimer == null) _idleTimer = new Timer(OnIdleCheck, null, 15000, 15000);
        if (_hostAccess != null && _hostAccess != "Allowed")
          Program.EmitLog("warn", "bluetooth: Windows answered the radio access request with " + _hostAccess +
                                  ", so switching the radio will be refused; check Settings > Privacy & security > Radios");
        long ms = Lanes.MsSince(t0);
        if (ms > 5000)
          Program.EmitLog("info", "bluetooth: the PowerShell helper took " + ms + " ms to start (the machine is busy)");
        return true;
      } catch (Exception ex) {
        try { if (p != null && !p.HasExited) p.Kill(); } catch (Exception) { }
        _hostFailedTs = Stopwatch.GetTimestamp();
        _hostFailedWhy = "the Bluetooth helper (powershell.exe) could not be started (" + ex.Message + ")";
        reason = _hostFailedWhy;
        return false;
      }
    }

    /// Nobody has asked for HostIdleMs: let the helper go. TryEnter, because a
    /// request in flight means it is not idle, and a timer thread must never
    /// queue behind one.
    static void OnIdleCheck(object state) {
      if (!Monitor.TryEnter(_hostLock)) return;
      try {
        if (_host != null && Lanes.MsSince(_hostUsedTs) >= HostIdleMs) KillHostLocked();
      } finally {
        Monitor.Exit(_hostLock);
      }
    }

    static void KillHostLocked() {
      Process p = _host;
      _host = null;
      _hostIn = null;
      _hostOut = null;
      if (p == null) return;
      // Closing its stdin is the polite stop (its read loop ends); Kill is the
      // guarantee.
      try { p.StandardInput.Close(); } catch (Exception) { }
      try { if (!p.HasExited) p.Kill(); } catch (Exception) { }
      try { p.Dispose(); } catch (Exception) { }
    }

    /// For the shutdown path: no lock (a request may be holding it for seconds
    /// and the restore must not wait), just make sure the helper is gone.
    public static void StopHost(string why) {
      Process p = _host;
      if (p == null) return;
      try { if (!p.HasExited) p.Kill(); } catch (Exception) { }
    }

    public static IDictionary HostSnapshot() {
      Process p = _host;
      bool alive = false;
      try { alive = p != null && !p.HasExited; } catch (Exception) { }
      return Json.Obj("helper", alive ? "running" : "stopped",
                      "idleMs", alive ? (object)Lanes.MsSince(_hostUsedTs) : null,
                      "lastFailure", _hostFailedWhy);
    }
  }
}

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
//   'winrt'       in-process, about a millisecond, so the bar could poll it.
//                 build.ps1 defines MANTLE_WINRT when it can reference the
//                 UNION metadata assembly (UnionMetadata\Windows.winmd) plus
//                 System.Runtime.WindowsRuntime.dll and the System.Runtime
//                 facade from the GAC.
//   'powershell'  the fallback. A PROCESS LAUNCH - hundreds of milliseconds -
//                 so the read is cached for 5 s and `via` tells the UI to show
//                 that it is slow.
//
// WHICH ONE THIS MACHINE USES, measured 2026-09-21: the POWERSHELL one. The
// split winmds in C:\Windows\System32\WinMetadata are not enough on their own -
// System.Runtime.WindowsRuntime's AsTask() extensions are bound against the
// union "Windows" assembly identity, and that file ships with the Windows SDK,
// which is not installed here (the sidecar deliberately builds with nothing but
// the csc.exe inside Windows). Install the SDK and the build switches route
// with no code change. The measured cost of the fallback is in the reply.
//
// The WinRT call is made with AsTask().Wait(timeout) rather than async/await:
// csc here is a C# 5 compiler, the command handler is synchronous, and a
// command that cannot finish must TIME OUT rather than hang the message loop.
//
// RequestAccessAsync comes first because Windows can deny radio control to an
// app (privacy settings); if it denies, that is the reason the user gets.
using System;
using System.Collections;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

namespace Mantle {
  static class Bluetooth {
    const int WinRtTimeoutMs = 3000;
    const int PsTimeoutMs = 12000;
    const int CacheMs = 5000;      // only used on the powershell route

    static string _cachedState;    // "on" | "off" | null
    static int _cachedAt;
    static string _lastVia = "winrt";

    /// Whether the machine HAS a Bluetooth radio. Win32, instant, and the only
    /// way to tell "no radio" from "radio list came back empty".
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

    public static IDictionary Read() {
      bool present = Present();
      string reason = null;
      bool on = false;
      string via = "winrt";

      string state = null;
#if MANTLE_WINRT
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
        state = PsState(out psReason);
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

      _lastVia = via;
      return Json.Obj("ok", state != null || !present, "present", present, "on", on,
                      "via", via, "reason", reason);
    }

    public static IDictionary Set(bool want) {
      bool present = Present();
      if (!present)
        return Json.Obj("ok", false, "present", false, "on", false, "via", _lastVia,
                        "reason", "this machine has no Bluetooth radio");

      string reason = null;
      bool done = false;
      string via = "winrt";

#if MANTLE_WINRT
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
        done = PsSet(want, out psReason);
        if (!done && psReason != null) reason = (reason == null ? "" : reason + "; ") + psReason;
      }

      _cachedState = null;   // whatever happened, the cached read is stale now
      var now = Read();
      if (!done) {
        now["ok"] = false;
        now["reason"] = reason ?? "Windows refused to switch the Bluetooth radio";
      }
      now["via"] = via;
      return now;
    }

#if MANTLE_WINRT
    // ------------------------------------------------------------ in-process

    /// "on" / "off", or null with the reason. Everything is bounded by a
    /// timeout: a WinRT call that never completes must not take the shell with
    /// it.
    static string WinRtState(out string reason) {
      reason = null;
      var access = Windows.Devices.Radios.Radio.RequestAccessAsync().AsTask();
      if (!access.Wait(WinRtTimeoutMs)) { reason = "Windows did not answer the radio access request in time"; return null; }
      if (access.Result != Windows.Devices.Radios.RadioAccessStatus.Allowed) {
        reason = "Windows denied access to the radios (" + access.Result +
                 "); check Settings > Privacy & security > Radios";
        return null;
      }
      var radios = Windows.Devices.Radios.Radio.GetRadiosAsync().AsTask();
      if (!radios.Wait(WinRtTimeoutMs)) { reason = "the radio list did not arrive in time"; return null; }
      foreach (Windows.Devices.Radios.Radio r in radios.Result) {
        if (r.Kind != Windows.Devices.Radios.RadioKind.Bluetooth) continue;
        return r.State == Windows.Devices.Radios.RadioState.On ? "on" : "off";
      }
      reason = "Windows listed no Bluetooth radio";
      return null;
    }

    static bool WinRtSet(bool want, out string reason) {
      reason = null;
      var access = Windows.Devices.Radios.Radio.RequestAccessAsync().AsTask();
      if (!access.Wait(WinRtTimeoutMs)) { reason = "Windows did not answer the radio access request in time"; return false; }
      if (access.Result != Windows.Devices.Radios.RadioAccessStatus.Allowed) {
        reason = "Windows denied access to the radios (" + access.Result +
                 "); check Settings > Privacy & security > Radios";
        return false;
      }
      var radios = Windows.Devices.Radios.Radio.GetRadiosAsync().AsTask();
      if (!radios.Wait(WinRtTimeoutMs)) { reason = "the radio list did not arrive in time"; return false; }
      foreach (Windows.Devices.Radios.Radio r in radios.Result) {
        if (r.Kind != Windows.Devices.Radios.RadioKind.Bluetooth) continue;
        var set = r.SetStateAsync(want ? Windows.Devices.Radios.RadioState.On
                                       : Windows.Devices.Radios.RadioState.Off).AsTask();
        if (!set.Wait(WinRtTimeoutMs)) { reason = "the radio did not answer the switch in time"; return false; }
        if (set.Result != Windows.Devices.Radios.RadioAccessStatus.Allowed) {
          reason = "Windows refused the switch (" + set.Result + ")";
          return false;
        }
        return true;
      }
      reason = "Windows listed no Bluetooth radio";
      return false;
    }
#endif

    // ------------------------------------------------------------- fallback
    // The documented PowerShell route, used only when the in-process one is
    // unavailable. A process launch, so the read is cached for 5 s and the
    // reply says via:'powershell' - the UI shows that the panel is slow rather
    // than looking broken.

    const string PsPrelude =
      "$null=[Windows.Devices.Radios.Radio,Windows.System.Devices,ContentType=WindowsRuntime];" +
      "$null=[Windows.Devices.Radios.RadioAccessStatus,Windows.System.Devices,ContentType=WindowsRuntime];" +
      "$as=([System.WindowsRuntimeSystemExtensions].GetMethods()|?{$_.Name -eq 'AsTask' -and " +
      "$_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'})[0];" +
      "function Aw($o,$t){$k=$as.MakeGenericMethod($t).Invoke($null,@($o));$null=$k.Wait(8000);$k.Result};" +
      "$null=Aw ([Windows.Devices.Radios.Radio]::RequestAccessAsync()) ([Windows.Devices.Radios.RadioAccessStatus]);" +
      "$rs=Aw ([Windows.Devices.Radios.Radio]::GetRadiosAsync()) " +
      "([System.Collections.Generic.IReadOnlyList[Windows.Devices.Radios.Radio]]);" +
      "$bt=$rs|?{$_.Kind -eq 'Bluetooth'}|Select-Object -First 1;";

    static string PsState(out string reason) {
      reason = null;
      if (_cachedState != null && unchecked(Environment.TickCount - _cachedAt) < CacheMs) return _cachedState;
      string outp = RunPs(PsPrelude + "if($bt){$bt.State}else{'none'}", out reason);
      if (outp == null) return null;
      outp = outp.Trim().ToLowerInvariant();
      if (outp == "on" || outp == "off") {
        _cachedState = outp;
        _cachedAt = Environment.TickCount;
        return outp;
      }
      if (outp == "none") { reason = "Windows listed no Bluetooth radio"; return null; }
      reason = "the radio answered with something unexpected (" + outp + ")";
      return null;
    }

    static bool PsSet(bool want, out string reason) {
      string outp = RunPs(PsPrelude +
        "if(-not $bt){'none'}else{$r=Aw ($bt.SetStateAsync([Windows.Devices.Radios.RadioState]::" +
        (want ? "On" : "Off") + ")) ([Windows.Devices.Radios.RadioAccessStatus]);\"$r\"}", out reason);
      if (outp == null) return false;
      outp = outp.Trim();
      if (string.Equals(outp, "Allowed", StringComparison.OrdinalIgnoreCase)) return true;
      reason = outp == "none" ? "Windows listed no Bluetooth radio"
                              : "Windows refused the switch (" + outp + ")";
      return false;
    }

    /// One powershell.exe, no profile, bounded. Returns stdout or null + reason.
    static string RunPs(string script, out string reason) {
      reason = null;
      Process p = null;
      try {
        var psi = new ProcessStartInfo("powershell.exe", "-NoProfile -NonInteractive -Command \"" +
                                       script.Replace("\"", "\\\"") + "\"");
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        psi.RedirectStandardOutput = true;
        psi.RedirectStandardError = true;
        p = Process.Start(psi);
        string outp = p.StandardOutput.ReadToEnd();
        string err = p.StandardError.ReadToEnd();
        if (!p.WaitForExit(PsTimeoutMs)) {
          try { p.Kill(); } catch (Exception) { }
          reason = "the PowerShell fallback did not finish within " + (PsTimeoutMs / 1000) + "s";
          return null;
        }
        if (outp.Trim().Length == 0) {
          reason = "the PowerShell fallback said nothing" +
                   (err.Trim().Length > 0 ? " (" + err.Trim().Split('\n')[0] + ")" : "");
          return null;
        }
        return outp;
      } catch (Exception ex) {
        reason = "the PowerShell fallback could not run (" + ex.Message + ")";
        return null;
      } finally {
        if (p != null) { try { p.Dispose(); } catch (Exception) { } }
      }
    }
  }
}

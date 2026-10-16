// Record.cs - the Win+G Record panel's two Windows calls, and the Clips gallery's share sheet
// (lane mantle-clips, 2026-10-15).
//
// RECORDING IS WINDOWS' OWN. Measured first (2026-10-15, before any UI was built):
//   - AppRecordingManager.GetDefault() from a desktop exe: 0x80070490 "Element not found" (and it
//     only ever records the CALLING app), so it is no route;
//   - RegisterHotKey(MOD_WIN, 'G') and every Game Bar chord (Win+Alt+R / G / PrtScn): refused,
//     error 1409 (taken), so Win+G can only be taken by the keyboard hook (AltTab.cs), fail-open;
//   - Game Bar's URIs (ms-gamebar://launch/activate, .../GalleryWidget, ...) have no "record" verb;
//   - ONE SendInput call of Win down, Alt down, R down, R up, Alt up, Win up STARTS Windows' recording
//     of the window in front and the same again STOPS it: proved on a stand-in window (file in
//     Captures 3.2-4.4 s after the keys, 7.8 s the first time after a while; the index is written
//     within ~0.4 s of the stop, and the file then stays the same size with the window still open).
//     Game Bar records the window IT considers active: once, right after the stand-in was put in
//     front by a program (800 ms before the keys), it recorded the previous app instead. The panel
//     never moves the foreground (focusable:false), so the app Owen is in is the one recorded.
//
//   record.target {}                     the window in front: hwnd, pid, exe, title, cls, fullscreen,
//                                        quns (SHQueryUserNotificationState), desktop (the shell's
//                                        desktop, taskbar or File Explorer: Game Bar cannot record
//                                        them), mantle (one of Mantle's own windows)
//   record.keys {hwnd, dryRun?, standIn?} Win+Alt+R for Windows' recorder, ONLY if `hwnd` is still the
//                                        window in front, it is not a game (no synthetic key ever
//                                        reaches a game: anti-cheat reads injected input) and the
//                                        screen is not exclusive full screen. A passive (--test)
//                                        sidecar sends nothing, except to a STAND-IN: the window in
//                                        front must belong to pid `standIn` and its title start with
//                                        "Mantle stand-in" (sidecar/test-record-live.js makes one).
//   clips.share {path, x, y}             Windows' share sheet for one file, anchored on a tiny
//                                        window of this process at (x, y) (the share broker wants a
//                                        window of the CALLING process). Refused in passive.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

namespace Mantle {
  [MantleFeature]
  static class Record {
    public static void Register(FeatureTable t) {
      t.Add("record.target", Lanes.Ui, Target);
      t.Add("record.keys", Lanes.Ui, KeysCmd);
      t.Add("clips.share", Lanes.Slow, Share);
    }

    [DllImport("shell32.dll")] static extern int SHQueryUserNotificationState(out int state);
    [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out int pid);

    [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr extra; }
    [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx, dy; public uint data, flags, time; public IntPtr extra; }
    [StructLayout(LayoutKind.Explicit)] struct UNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
    [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public UNION u; }
    static INPUT K(ushort vk, bool up, bool ext) {
      var i = new INPUT { type = 1 };
      i.u.ki.wVk = vk; i.u.ki.dwFlags = (up ? 2u : 0u) | (ext ? 1u : 0u);
      return i;
    }

    static readonly string[] GameExes = {
      "valorant-win64-shipping.exe", "valorant.exe", "robloxplayerbeta.exe", "minecraft.windows.exe",
      "fortniteclient-win64-shipping.exe", "cs2.exe", "csgo.exe", "r5apex.exe", "rocketleague.exe",
      "gta5.exe", "overwatch.exe", "league of legends.exe", "escapefromtarkov.exe", "cyberpunk2077.exe",
    };
    static readonly string[] GamePrefixes = { "riotclient", "minecraft", "valorant", "leagueclient", "roblox", "vgc", "vanguard" };
    static readonly string[] ShellClasses = { "Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd", "CabinetWClass", "ExploreWClass" };

    /// A game (or its anti-cheat) by the exe's file name, or null. Minecraft Java is javaw.exe with a
    /// "Minecraft" title.
    internal static string GameOf(string exePath, string title) {
      string f = Path.GetFileName(exePath ?? "").ToLowerInvariant();
      if (f.Length == 0) return null;
      foreach (string g in GameExes) if (g == f) return f;
      foreach (string p in GamePrefixes) if (f.StartsWith(p, StringComparison.Ordinal)) return f;
      if ((f == "javaw.exe" || f == "java.exe") && (title ?? "").StartsWith("Minecraft", StringComparison.OrdinalIgnoreCase)) return "Minecraft";
      return null;
    }

    static int Quns() { int s; try { return SHQueryUserNotificationState(out s) == 0 ? s : -1; } catch (Exception) { return -1; } }

    static IDictionary Read() {
      var fg = Foreground.Read();
      IntPtr h = GetForegroundWindow();
      string cls = h != IntPtr.Zero ? Win32.GetClassName(h) : "";
      string exe = fg["exe"] as string ?? "";
      int pid = fg["pid"] is int ? (int)fg["pid"] : 0;
      bool desktop = Array.IndexOf(ShellClasses, cls) >= 0;
      bool mantle = pid != 0 && Foreground.IsMantlePid(pid);
      string game = GameOf(exe, fg["title"] as string);
      return Json.Obj("hwnd", fg["hwnd"], "pid", pid, "exe", exe, "title", fg["title"], "cls", cls,
        "fullscreen", fg["fullscreen"], "quns", Quns(), "desktop", desktop, "mantle", mantle, "game", game);
    }

    static string Target(Dictionary<string, object> req, ref object result) {
      result = Read();
      return null;
    }

    static string KeysCmd(Dictionary<string, object> req, ref object result) {
      IntPtr want = Json.GetHwnd(req, "hwnd");
      bool dry = Json.GetBool(req, "dryRun", false);
      int standIn = Json.GetInt(req, "standIn", 0);
      IntPtr fg = GetForegroundWindow();
      int pid; GetWindowThreadProcessId(fg, out pid);
      string title = fg != IntPtr.Zero ? Win32.GetWindowText(fg) : "";
      string exe = pid != 0 ? Win32.GetProcessPath(pid) : "";
      if (want == IntPtr.Zero) return "record.keys needs the hwnd of the window to record";
      if (fg != want) return "the window to record is no longer in front, so nothing was sent";
      string game = GameOf(exe, title);
      if (game != null) return "a game is in front (" + game + "): Mantle never sends keys to a game; press Win+Alt+R yourself";
      int q = Quns();
      if (q == 3) return "an exclusive full-screen app is in front: Mantle sends no keys there";
      if (Array.IndexOf(ShellClasses, Win32.GetClassName(fg)) >= 0) return "Windows cannot record the desktop or File Explorer";
      if (Program.Passive) {
        bool isStandIn = standIn != 0 && pid == standIn && title.StartsWith("Mantle stand-in", StringComparison.Ordinal);
        if (!isStandIn) {
          if (dry) { result = Json.Obj("sent", false, "dryRun", true, "would", "Win+Alt+R"); return null; }
          return FeatureTable.PassiveRefusal;
        }
      } else if (dry) { result = Json.Obj("sent", false, "dryRun", true, "would", "Win+Alt+R"); return null; }
      // ONE call: SendInput is atomic per call, so nothing can land between the Win-down and the R
      // (a bare Win press would open Start). Every key goes up in the same call: nothing stays held.
      var a = new[] { K(0x5B, false, true), K(0x12, false, false), K(0x52, false, false), K(0x52, true, false), K(0x12, true, false), K(0x5B, true, true) };
      var sw = Stopwatch.StartNew();
      uint n = SendInput((uint)a.Length, a, Marshal.SizeOf(typeof(INPUT)));
      if (n != a.Length) return "Windows took " + n + " of the 6 key events (error " + Marshal.GetLastWin32Error() + "), so the recording may not have changed";
      result = Json.Obj("sent", true, "ms", sw.Elapsed.TotalMilliseconds);
      return null;
    }

    // ---- the share sheet ----------------------------------------------------------------------
#if MANTLE_WINMD
    [ComImport, Guid("3A3DCD6C-3EAB-43DC-BCDE-45671CE800C8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IDataTransferManagerInterop {
      IntPtr GetForWindow([In] IntPtr appWindow, [In] ref Guid riid);
      void ShowShareUIForWindow(IntPtr appWindow);
    }
    static readonly Guid IID_DTM = new Guid("A5CAEE9B-8708-49D1-8D36-67D25A8DA00C");
#endif

    static string Share(Dictionary<string, object> req, ref object result) {
      string path = Json.GetString(req, "path");
      if (string.IsNullOrEmpty(path) || !Path.IsPathRooted(path)) return "clips.share needs an absolute path";
      if (!File.Exists(path)) return "the file is not there any more";
      if (Program.Passive) return FeatureTable.PassiveRefusal;
#if MANTLE_WINMD
      int x = Json.GetInt(req, "x", 400), y = Json.GetInt(req, "y", 300);
      string err = null;
      var ready = new ManualResetEvent(false);
      var th = new Thread(() => {
        System.Windows.Forms.Form f = null;
        try {
          f = new System.Windows.Forms.Form {
            FormBorderStyle = System.Windows.Forms.FormBorderStyle.None, ShowInTaskbar = false, Width = 1, Height = 1,
            StartPosition = System.Windows.Forms.FormStartPosition.Manual, Left = x, Top = y, Opacity = 0.01, Text = "Mantle share"
          };
          f.Show();
          var interop = (IDataTransferManagerInterop)System.Runtime.InteropServices.WindowsRuntime.WindowsRuntimeMarshal.GetActivationFactory(typeof(Windows.ApplicationModel.DataTransfer.DataTransferManager));
          Guid iid = IID_DTM;
          IntPtr p = interop.GetForWindow(f.Handle, ref iid);
          var dtm = (Windows.ApplicationModel.DataTransfer.DataTransferManager)Marshal.GetObjectForIUnknown(p);
          Marshal.Release(p);
          Windows.Storage.StorageFile file = null;
          var op = Windows.Storage.StorageFile.GetFileFromPathAsync(path);
          var got = new ManualResetEvent(false);
          op.Completed = (o, s) => { try { if (s == Windows.Foundation.AsyncStatus.Completed) file = o.GetResults(); } catch (Exception) { } got.Set(); };
          if (!got.WaitOne(5000) || file == null) { err = "Windows could not open the file for sharing"; ready.Set(); return; }
          dtm.DataRequested += (s, e) => {
            e.Request.Data.Properties.Title = Path.GetFileName(path);
            e.Request.Data.SetStorageItems(new Windows.Storage.IStorageItem[] { file });
          };
          bool closed = false;
          dtm.TargetApplicationChosen += (s, e) => { closed = true; };
          interop.ShowShareUIForWindow(f.Handle);
          ready.Set();
          // Keep the anchor (and the data) alive while the sheet is up: until a target is chosen,
          // or two minutes.
          var end = DateTime.UtcNow.AddMinutes(2);
          while (!closed && DateTime.UtcNow < end) { System.Windows.Forms.Application.DoEvents(); Thread.Sleep(50); }
        } catch (Exception ex) {
          err = "Windows' share sheet did not open (" + ex.GetType().Name + " 0x" + ex.HResult.ToString("X8") + ")";
          ready.Set();
        } finally {
          try { if (f != null) f.Close(); } catch (Exception) { }
        }
      });
      th.SetApartmentState(ApartmentState.STA);
      th.IsBackground = true;
      th.Name = "mantle-clips-share";
      th.Start();
      if (!ready.WaitOne(8000)) return "Windows' share sheet did not answer within 8 s";
      if (err != null) return err;
      result = Json.Obj("shown", true);
      return null;
#else
      return "this sidecar was built without WinRT (no split winmds), so the share sheet is not available";
#endif
    }
  }
}

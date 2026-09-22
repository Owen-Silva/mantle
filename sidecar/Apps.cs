// Apps.cs - app identity: AUMIDs, Store-app icons, the taskbar pin list, and
// launching a packaged app.
//
// THE PROBLEM THIS SOLVES, in Owen's words: "i want the apps when i have them
// running to work the same as before just on mantle, and i want to be able to
// see all my pinned stuff not just some of them."
//
// Both halves of that fail if a shell thinks in EXE PATHS, and measured on this
// machine they fail badly:
//
//   * 5 of the 14 taskbar pins are Store apps with NO .lnk anywhere - Calculator,
//     Settings, Terminal, LessonPlayer, Xbox. A launcher that scans .lnk files simply
//     cannot see them.
//   * every UWP window belongs to ApplicationFrameHost.exe, not to the app, so
//     grouping windows by exe puts all of them in one bogus pile and none of
//     them under their own pin.
//   * Discord pins Update.exe but runs Discord.exe; Edge splits the same way.
//
// The shell's own answer to all of this is the APP USER MODEL ID, and the
// AppsFolder virtual namespace ("shell:AppsFolder\<aumid>") which holds every
// launchable app - packaged or not - with its real name and icon. So this file
// is the sidecar's AUMID layer: read one off a window, off a process, or out of
// a pinned PIDL, and turn it into a name + a PNG + a way to start it.
//
// EVERYTHING HERE IS READ-ONLY EXCEPT Launch, which is why only Launch is
// refused in --passive.
//
// COST: the window list is rebuilt every 250 ms, so nothing in here may be paid
// per rebuild. Icons are cached by AUMID for the life of the process (an app's
// icon does not change while the machine is up) and WindowList caches this
// whole lookup per hwnd.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

namespace Mantle {

  /// The shell's handle on "a thing in the namespace" - a file, a folder, or an
  /// app in AppsFolder. Vtable order is the contract; only the two methods we
  /// call are meaningful, the rest hold their slots.
  [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown),
   Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe")]
  interface IShellItem {
    void BindToHandler(IntPtr bc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
    void GetParent(out IShellItem parent);
    void GetDisplayName(uint sigdn, out IntPtr name);
    void GetAttributes(uint mask, out uint attribs);
    void Compare(IShellItem other, uint hint, out int order);
  }

  /// The one call that renders an app's real icon - including a Store app's,
  /// which lives in the package manifest and has no .ico anywhere.
  [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown),
   Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b")]
  interface IShellItemImageFactory {
    void GetImage(Win32.SIZE size, int flags, out IntPtr bitmap);
  }

  static class Apps {
    public const string AppsFolder = "shell:AppsFolder\\";
    /// The AppsFolder's CLSID, as it appears at the head of a parsing name for
    /// a pinned Store app.
    public const string AppsFolderClsid = "::{4234d49b-0245-4df3-b780-3893943456e1}\\";

    const int IconPx = 32;
    const int SIIGBF_RESIZETOFIT = 0x00000000;
    const int SIIGBF_ICONONLY = 0x00000004;

    static readonly Guid IidShellItem = new Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe");
    static readonly Guid IidPropertyStore = new Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99");
    static readonly Guid PkeyAppUserModelFmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3");

    /// Icons never change while the machine is up, and the window list asks for
    /// them ten times a second. Failures are cached too (as null), or a UWP app
    /// with no icon would cost a shell round trip on every rebuild forever.
    static readonly Dictionary<string, string> _iconCache =
      new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

    // --------------------------------------------------------- window identity

    /// What WindowList caches per hwnd: who REALLY owns this window, and what
    /// the shell calls it.
    public class WinApp {
      public int Pid;        // the app's pid, not the frame host's
      public string Exe;     // that process's image path, "" when denied
      public string Aumid;   // null for an ordinary Win32 app
      public string Host;    // "frame" when the window is an ApplicationFrameWindow shell
    }

    /// The resolution order that makes a UWP window group under its own pin:
    ///
    ///   frame first   an ApplicationFrameWindow is an EMPTY SHELL owned by
    ///                 ApplicationFrameHost.exe; the app itself lives in a child
    ///                 window of class Windows.UI.Core.CoreWindow, in its own
    ///                 process. Report THAT pid and exe, or every UWP app on the
    ///                 machine looks like the same program.
    ///   (a) the window's own property store   what the app stamped on itself.
    ///   (b) the child process's AUMID          for a frame whose store is empty.
    ///   (c) the window process's AUMID         packaged Win32 apps (Terminal).
    ///   (d) null                               an ordinary desktop app.
    public static WinApp ForWindow(IntPtr hwnd, string cls, int pid) {
      var a = new WinApp();
      a.Pid = pid;

      if (cls == "ApplicationFrameWindow") {
        int childPid;
        if (FindCoreWindow(hwnd, out childPid) && childPid > 0 && childPid != pid) {
          a.Pid = childPid;
          a.Host = "frame";
        }
      }

      a.Exe = Win32.GetProcessPath(a.Pid);
      a.Aumid = AumidForWindow(hwnd);
      if (a.Aumid == null && a.Host != null) a.Aumid = AumidForProcess(a.Pid);
      if (a.Aumid == null) a.Aumid = AumidForProcess(pid);
      return a;
    }

    /// The real app window inside an ApplicationFrameWindow. EnumChildWindows
    /// rather than FindWindowEx, because the CoreWindow is not always a direct
    /// child.
    static bool FindCoreWindow(IntPtr frame, out int childPid) {
      IntPtr found = IntPtr.Zero;
      Win32.EnumWindowsProc cb = delegate (IntPtr child, IntPtr lp) {
        if (Win32.GetClassName(child) == "Windows.UI.Core.CoreWindow") { found = child; return false; }
        return true;
      };
      try { Win32.EnumChildWindows(frame, cb, IntPtr.Zero); } catch (Exception) { }
      GC.KeepAlive(cb);
      childPid = 0;
      if (found == IntPtr.Zero) return false;
      Win32.GetWindowThreadProcessId(found, out childPid);
      return true;
    }

    public static string AumidForWindow(IntPtr hwnd) {
      object raw = null;
      try {
        Guid iid = IidPropertyStore;
        if (Win32.SHGetPropertyStoreForWindow(hwnd, ref iid, out raw) != Win32.S_OK || raw == null) return null;
        return ReadAumid(raw as Win32.IPropertyStore);
      } catch (Exception) {
        return null;
      } finally {
        if (raw != null) { try { Marshal.FinalReleaseComObject(raw); } catch (Exception) { } }
      }
    }

    /// Packaged processes only. An ordinary exe answers
    /// APPMODEL_ERROR_NO_APPLICATION, which is a fact about the process, not a
    /// failure, so it returns null quietly.
    public static string AumidForProcess(int pid) {
      if (pid <= 0) return null;
      IntPtr h = IntPtr.Zero;
      try {
        h = Win32.OpenProcess(Win32.PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
        if (h == IntPtr.Zero) return null;
        uint len = 260;
        var sb = new StringBuilder((int)len);
        int rc = Win32.GetApplicationUserModelId(h, ref len, sb);
        if (rc == Win32.ERROR_INSUFFICIENT_BUFFER) {
          sb = new StringBuilder((int)len);
          rc = Win32.GetApplicationUserModelId(h, ref len, sb);
        }
        if (rc != 0) return null;
        string id = sb.ToString();
        return id.Length == 0 ? null : id;
      } catch (Exception) {
        return null;
      } finally {
        if (h != IntPtr.Zero) Win32.CloseHandle(h);
      }
    }

    static string ReadAumid(Win32.IPropertyStore store) {
      if (store == null) return null;
      var key = new Win32.PROPERTYKEY();
      key.fmtid = PkeyAppUserModelFmtid;
      key.pid = 5;
      var pv = new Win32.PROPVARIANT();
      try {
        store.GetValue(ref key, out pv);
        if (pv.p == IntPtr.Zero) return null;
        string v = pv.vt == Win32.VT_LPWSTR ? Marshal.PtrToStringUni(pv.p)
                 : pv.vt == Win32.VT_BSTR ? Marshal.PtrToStringBSTR(pv.p) : null;
        return string.IsNullOrEmpty(v) ? null : v;
      } catch (Exception) {
        return null;
      } finally {
        try { Win32.PropVariantClear(ref pv); } catch (Exception) { }
      }
    }

    /// A Store app's files live under WindowsApps, and its icon must come from
    /// the package rather than from the exe (which usually has none).
    public static bool IsPackagedPath(string exe) {
      return !string.IsNullOrEmpty(exe) &&
             exe.IndexOf("\\WindowsApps\\", StringComparison.OrdinalIgnoreCase) >= 0;
    }

    // ------------------------------------------------------------- app lookup

    /// Name + icon for an AUMID. Returns null on success, or the reason with
    /// the HRESULT - an unknown AUMID is an ordinary answer here, not a crash.
    public static string Info(string aumid, out string name, out string png) {
      name = null;
      png = null;
      if (string.IsNullOrEmpty(aumid)) return "app needs an aumid";
      object raw = null;
      try {
        Guid iid = IidShellItem;
        int hr = Win32.SHCreateItemFromParsingName(AppsFolder + aumid, IntPtr.Zero, ref iid, out raw);
        if (hr != Win32.S_OK || raw == null)
          return "the shell does not know the app id '" + aumid + "' (HRESULT 0x" + hr.ToString("X8") + ")";
        var item = raw as IShellItem;
        if (item == null) return "the shell returned something that is not a shell item for '" + aumid + "'";
        name = DisplayName(item, Win32.SIGDN_NORMALDISPLAY);
        png = Image32(raw);
        if (png == null) _iconCache[aumid] = null;
        else _iconCache[aumid] = png;
        return null;
      } catch (COMException ce) {
        return "the shell refused the app id '" + aumid + "' (HRESULT 0x" + ce.ErrorCode.ToString("X8") + ")";
      } catch (Exception ex) {
        return "the app id '" + aumid + "' could not be read (" + ex.Message + ")";
      } finally {
        if (raw != null) { try { Marshal.FinalReleaseComObject(raw); } catch (Exception) { } }
      }
    }

    /// The cached icon path, for the window list. Never throws, never blocks
    /// twice on the same app.
    public static string IconFor(string aumid) {
      if (string.IsNullOrEmpty(aumid)) return null;
      string hit;
      if (_iconCache.TryGetValue(aumid, out hit)) return hit;
      string name, png;
      string why = Info(aumid, out name, out png);
      if (why != null) {
        _iconCache[aumid] = null;
        Program.EmitLog("warn", "no app icon for " + aumid + " (" + why + ")");
        return null;
      }
      return png;   // Info filled the cache
    }

    static string DisplayName(IShellItem item, uint sigdn) {
      IntPtr p = IntPtr.Zero;
      try {
        item.GetDisplayName(sigdn, out p);
        return p == IntPtr.Zero ? "" : (Marshal.PtrToStringUni(p) ?? "");
      } catch (Exception) {
        return "";
      } finally {
        if (p != IntPtr.Zero) Win32.CoTaskMemFree(p);
      }
    }

    /// 32x32 PNG data URL from a shell item, or null. ICONONLY so a document
    /// never comes back as a thumbnail of its contents.
    static string Image32(object raw) {
      var factory = raw as IShellItemImageFactory;
      if (factory == null) return null;
      IntPtr hbmp = IntPtr.Zero;
      try {
        var size = new Win32.SIZE();
        size.cx = IconPx;
        size.cy = IconPx;
        factory.GetImage(size, SIIGBF_ICONONLY | SIIGBF_RESIZETOFIT, out hbmp);
        if (hbmp == IntPtr.Zero) return null;
        return PngFromHBitmap(hbmp);
      } catch (Exception) {
        return null;
      } finally {
        if (hbmp != IntPtr.Zero) { try { Win32.DeleteObject(hbmp); } catch (Exception) { } }
      }
    }

    /// HBITMAP -> PNG, KEEPING THE ALPHA. Image.FromHbitmap would drop it and
    /// every Store icon would render on a black square, which is exactly the
    /// kind of "looks broken" detail this shell cannot afford.
    static string PngFromHBitmap(IntPtr hbmp) {
      var bm = new Win32.BITMAP();
      if (Win32.GetObjectW(hbmp, Marshal.SizeOf(typeof(Win32.BITMAP)), ref bm) == 0) return null;
      int w = bm.bmWidth, h = Math.Abs(bm.bmHeight);
      if (w <= 0 || h <= 0 || w > 1024 || h > 1024) return null;

      var bi = new Win32.BITMAPINFOHEADER();
      bi.biSize = (uint)Marshal.SizeOf(typeof(Win32.BITMAPINFOHEADER));
      bi.biWidth = w;
      bi.biHeight = -h;             // negative: top-down, so row 0 is the top
      bi.biPlanes = 1;
      bi.biBitCount = 32;
      bi.biCompression = Win32.BI_RGB;

      var buf = new byte[w * h * 4];
      IntPtr dc = Win32.GetDC(IntPtr.Zero);
      try {
        if (Win32.GetDIBits(dc, hbmp, 0, (uint)h, buf, ref bi, Win32.DIB_RGB_COLORS) == 0) return null;
      } finally {
        if (dc != IntPtr.Zero) Win32.ReleaseDC(IntPtr.Zero, dc);
      }

      // Some sources hand back 32bpp with the alpha byte left at zero, which
      // would render as a fully transparent icon. If NOTHING is opaque, the
      // channel is meaningless: make it opaque rather than show nothing.
      bool anyAlpha = false;
      for (int i = 3; i < buf.Length; i += 4) { if (buf[i] != 0) { anyAlpha = true; break; } }
      if (!anyAlpha) for (int i = 3; i < buf.Length; i += 4) buf[i] = 255;

      using (var bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb)) {
        var rect = new Rectangle(0, 0, w, h);
        BitmapData data = bmp.LockBits(rect, ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
        try {
          for (int y = 0; y < h; y++)
            Marshal.Copy(buf, y * w * 4, new IntPtr(data.Scan0.ToInt64() + (long)y * data.Stride), w * 4);
        } finally {
          bmp.UnlockBits(data);
        }
        using (var ms = new MemoryStream()) {
          bmp.Save(ms, ImageFormat.Png);
          return "data:image/png;base64," + Convert.ToBase64String(ms.ToArray());
        }
      }
    }

    // ------------------------------------------------------------------ pins

    /// The taskbar's pin list, in taskbar order, out of the Taskband\Favorites
    /// REG_BINARY.
    ///
    /// THE FORMAT, measured on this machine (2026-09-21) rather than assumed:
    /// it is NOT a bare run of PIDLs. It is a sequence of RECORDS -
    ///
    ///     [1 byte flags][UInt32 cb][cb bytes: one absolute PIDL]
    ///
    /// - and the blob ends with a single 0xFF. Owen's blob is 10,419 bytes: 13
    /// records consuming 10,418 of them, every payload ending exactly on its
    /// own 0x0000 terminator. The bare-PIDL reading desyncs on the second entry,
    /// so it is kept only as a fallback for a machine whose blob really is
    /// bare, and `format` in the reply says which reading was used.
    ///
    /// A PIDL the shell will not resolve is SKIPPED AND COUNTED, never fatal:
    /// one dead pin must not cost the other thirteen.
    public static IDictionary Parse(byte[] blob) {
      var items = new List<object>();
      int skipped = 0;
      string reason = null;
      string format = "record";

      if (blob == null || blob.Length < 8)
        return Json.Obj("ok", false, "items", items, "skipped", 0, "format", format,
                        "reason", "the blob is empty or too short to be a pin list");

      int consumed = Walk(blob, items, ref skipped, ref reason);
      if (items.Count == 0) {
        // Fall back to the bare-PIDL reading the format is often described as.
        items.Clear();
        skipped = 0;
        string bareReason = null;
        format = "bare";
        WalkBare(blob, 0, items, ref skipped, ref bareReason);
        if (items.Count == 0)
          return Json.Obj("ok", false, "items", items, "skipped", skipped, "format", format,
                          "reason", reason ?? bareReason ?? "no pinned item could be read out of this blob");
        reason = bareReason;
      } else if (reason == null && blob.Length - consumed > 8) {
        reason = "stopped after " + items.Count + " items with " + (blob.Length - consumed) +
                 " bytes left: the record walk desynced";
      }

      return Json.Obj("ok", true, "items", items, "skipped", skipped, "format", format, "reason", reason);
    }

    /// The record walk. Returns how many bytes it consumed.
    static int Walk(byte[] b, List<object> items, ref int skipped, ref string reason) {
      int i = 0;
      while (i + 5 <= b.Length) {
        uint cb = (uint)(b[i + 1] | (b[i + 2] << 8) | (b[i + 3] << 16) | (b[i + 4] << 24));
        // A trailing 0xFF (and anything else too small to be a PIDL) is the end
        // of the list, not a desync.
        if (cb < 4 || i + 5 + cb > b.Length) break;
        int start = i + 5;
        int end = start + (int)cb;
        // Every payload must end on its own 0x0000 terminator; if it does not,
        // the length field did not mean what we think and guessing further
        // would invent pins that are not there.
        if (b[end - 2] != 0 || b[end - 1] != 0) {
          reason = "record " + (items.Count + 1) + " at byte " + i + " is not a terminated item list";
          return i;
        }
        AddPidl(b, start, (int)cb, items, ref skipped);
        i = end;
      }
      return i;
    }

    /// The fallback: absolute PIDLs laid end to end, each a run of SHITEMIDs
    /// terminated by a zero cb.
    static void WalkBare(byte[] b, int from, List<object> items, ref int skipped, ref string reason) {
      int i = from;
      while (i + 2 <= b.Length) {
        int start = i;
        bool ok = true;
        while (true) {
          if (i + 2 > b.Length) { ok = false; break; }
          int cb = b[i] | (b[i + 1] << 8);
          if (cb == 0) { i += 2; break; }
          if (cb < 2 || i + cb > b.Length) { ok = false; break; }
          i += cb;
        }
        if (!ok) {
          if (b.Length - start > 8)
            reason = "stopped at byte " + start + ": the item list desynced after " + items.Count + " items";
          return;
        }
        if (i - start <= 2) return;   // an empty PIDL: the end of the list
        AddPidl(b, start, i - start, items, ref skipped);
      }
    }

    /// An AUMID is a bare token: no path separators, no drive letter, no shell
    /// CLSID. "Microsoft.WindowsTerminal_8wekyb3d8bbwe!App" and the legacy
    /// "Microsoft.Windows.Explorer" both qualify; "C:\...\Spotify.lnk" and
    /// "::{20D04FE0-...}" do not.
    static bool LooksLikeAumid(string parsing) {
      if (string.IsNullOrEmpty(parsing)) return false;
      if (parsing.StartsWith("::", StringComparison.Ordinal)) return false;
      if (parsing.StartsWith("shell:", StringComparison.OrdinalIgnoreCase)) return false;
      return parsing.IndexOf('\\') < 0 && parsing.IndexOf('/') < 0 && parsing.IndexOf(':') < 0;
    }

    static void AddPidl(byte[] b, int offset, int length, List<object> items, ref int skipped) {
      IntPtr pidl = IntPtr.Zero;
      object raw = null;
      try {
        pidl = Marshal.AllocCoTaskMem(length);
        Marshal.Copy(b, offset, pidl, length);
        Guid iid = IidShellItem;
        if (Win32.SHCreateItemFromIDList(pidl, ref iid, out raw) != Win32.S_OK || raw == null) { skipped++; return; }
        var item = raw as IShellItem;
        if (item == null) { skipped++; return; }

        string name = DisplayName(item, Win32.SIGDN_NORMALDISPLAY);
        string parsing = DisplayName(item, Win32.SIGDN_DESKTOPABSOLUTEPARSING);
        string kind = "other", aumid = null, lnk = null;

        // MEASURED, not assumed (2026-09-21, Owen's own 13 pins): an AppsFolder
        // item's DESKTOPABSOLUTEPARSING name is the BARE AUMID -
        // "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App" - with no CLSID path
        // in front of it. The prefixed forms are handled too because other
        // Windows builds do produce them.
        if (parsing.EndsWith(".lnk", StringComparison.OrdinalIgnoreCase)) {
          kind = "lnk";
          lnk = parsing;
        } else if (parsing.StartsWith(AppsFolderClsid, StringComparison.OrdinalIgnoreCase)) {
          kind = "app";
          aumid = parsing.Substring(AppsFolderClsid.Length);
        } else if (parsing.StartsWith(AppsFolder, StringComparison.OrdinalIgnoreCase)) {
          kind = "app";
          aumid = parsing.Substring(AppsFolder.Length);
        } else if (LooksLikeAumid(parsing)) {
          kind = "app";
          aumid = parsing;
        }

        items.Add(Json.Obj(
          "index", items.Count,
          "kind", kind,
          "name", name,
          "parsing", parsing,
          "aumid", aumid,
          "lnk", lnk,
          "iconPng", kind == "app" && aumid != null ? IconFor(aumid) : Image32(raw)));
      } catch (Exception) {
        skipped++;
      } finally {
        if (raw != null) { try { Marshal.FinalReleaseComObject(raw); } catch (Exception) { } }
        if (pidl != IntPtr.Zero) Marshal.FreeCoTaskMem(pidl);
      }
    }

    // ---------------------------------------------------------------- launch

    /// THE ONLY THING IN THIS FILE THAT ACTS. ShellExecuteEx on the AppsFolder
    /// item is how the real taskbar starts a pinned app: it works for a Store
    /// app, a packaged Win32 app and a plain exe alike, and the shell does the
    /// activation properly (single instance, splash, jump list).
    public static string Launch(string aumid) {
      if (string.IsNullOrEmpty(aumid)) return "launch needs an aumid";
      var info = new Win32.SHELLEXECUTEINFO();
      info.cbSize = Marshal.SizeOf(typeof(Win32.SHELLEXECUTEINFO));
      info.fMask = Win32.SEE_MASK_NOASYNC | Win32.SEE_MASK_FLAG_NO_UI;
      info.lpFile = AppsFolder + aumid;
      info.nShow = Win32.SW_SHOWNORMAL;
      try {
        if (!Win32.ShellExecuteExW(ref info)) {
          int err = Marshal.GetLastWin32Error();
          return "the shell would not start '" + aumid + "' (Win32 error " + err +
                 (err == 2 ? ": no app with that id" : "") + ")";
        }
      } catch (Exception ex) {
        return "the shell would not start '" + aumid + "' (" + ex.Message + ")";
      }
      return null;
    }
  }
}

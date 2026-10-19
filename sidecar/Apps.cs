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
//     Settings, Terminal, Xbox and one more. A launcher that scans .lnk files simply
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
// per rebuild. Icons are cached by AUMID and WindowList caches this whole lookup
// per hwnd.
//
// WHY a Store app's cached icon follows its PACKAGE (storeicons, 2026-10-08). The
// old rule here was "an app's icon does not change while the machine is up", and
// it is false the same way it was for exes (sidecar/Icons.cs, bc06549): the Store
// updates an app in place while Mantle runs, and the bar's running-app icon and
// the pinned list kept the OLD picture until Mantle restarted. A Store app has no
// one file to stat, but it has something better: its package full name carries
// the version (Microsoft.WindowsTerminal_1.21.2361.0_x64__8wekyb3d8bbwe), and an
// update installs a new one. So each cached picture remembers the app's PACKAGE
// STAMP (the family's installed full names + each one's AppxManifest.xml write
// time, which also moves for a same-version re-register) and a lookup re-checks it
// at most once per PackageCheckEveryMs: two kernel32 calls and a stat, no shell.
// A changed package reads the picture again; the old one stays meanwhile.
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

    // 64, was 32 (core-needs, 2026-09-30): the bar and the launcher draw an app icon at 24-32 CSS
    // px, which is 48-64 device px at 200 %. A 32 px picture was blown up (soft) past 100 %; the
    // shell renders 64 from the icon's own large frame, so it is sharp at every scale up to 200 %.
    public const int IconPx = 64;
    const int SIIGBF_RESIZETOFIT = 0x00000000;
    const int SIIGBF_ICONONLY = 0x00000004;

    static readonly Guid IidShellItem = new Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe");
    static readonly Guid IidPropertyStore = new Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99");
    static readonly Guid PkeyAppUserModelFmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3");

    /// The window list asks for icons ten times a second, so they are cached by AUMID. Failures
    /// are cached too (as a null Url), or a UWP app with no icon would cost a shell round trip on
    /// every rebuild forever; a failure is tried again when its package changes (an app that was
    /// not installed yet). A PACKAGE app id (family!app) is re-checked against its package stamp
    /// (see the header); any other id (a desktop app's own AUMID) has no package to follow and is
    /// kept for the run, as before.
    class AppEntry {
      public string Url;        // the picture, or null (Why says why, when the read failed)
      public string Name;       // the shell's display name, or null
      public string Why;        // the read's failure, or null; never set while Url holds a kept old picture
      public string Stamp;      // PackageStamp when it was read; null = not a package id, never re-checked
      public int CheckedAt;     // Environment.TickCount of the last stamp check
      public bool Stale;        // the package changed since: read again on the next lookup
      public int RetryAt;       // != 0: a re-read failed and the old picture was kept; try again from then
      public string LoggedWhy;  // the last failure logged for this id: each reason is logged once
    }
    static readonly Dictionary<string, AppEntry> _iconCache =
      new Dictionary<string, AppEntry>(StringComparer.OrdinalIgnoreCase);

    /// How often a cached Store app's package is checked again. The window list asks every 250 ms
    /// while things move; this keeps it to one check per app per 5 s. Store updates are rare, and
    /// the first look after one is at most this late.
    const int PackageCheckEveryMs = 5000;
    /// A re-read after a package change that FAILED (the update still being staged, say) keeps the
    /// old picture and tries again this much later, not on every lookup.
    const int RetryFailedReadMs = 60000;

    static class PkgNative {
      [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
      public static extern int GetPackagesByPackageFamily(string family, ref uint count, IntPtr[] fullNames, ref uint bufferLength, IntPtr buffer);
      [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
      public static extern int GetPackagePathByFullName(string fullName, ref uint pathLength, StringBuilder path);
    }

    /// Tests only (sidecar/test-icons.js): a file whose text is added to every package stamp, so a
    /// test can fake "this app was updated" by rewriting it. Unset in a real run.
    static readonly string _testStampFile = Environment.GetEnvironmentVariable("MANTLE_TEST_PACKAGE_STAMP");

    /// The package family of a package app id ("Family_publisherid!App" -> "Family_publisherid"),
    /// or null for an id that is not one.
    static string FamilyOf(string aumid) {
      if (string.IsNullOrEmpty(aumid)) return null;
      int bang = aumid.IndexOf('!');
      return bang > 0 ? aumid.Substring(0, bang) : null;
    }

    /// What the installed package of an app id looks like right now: its family's full names (the
    /// version is in them), each with its manifest's last-write ticks, sorted. "none" when nothing
    /// of that family is installed for this user, "err:<code>" when Windows would not say; null for
    /// an id that is not a package app id. Never throws.
    static string PackageStamp(string aumid) {
      string family = FamilyOf(aumid);
      if (family == null) return null;
      string stamp;
      try {
        uint count = 0, len = 0;
        int rc = PkgNative.GetPackagesByPackageFamily(family, ref count, null, ref len, IntPtr.Zero);
        if (rc != 0 && rc != Win32.ERROR_INSUFFICIENT_BUFFER) stamp = "err:" + rc;
        else if (count == 0 || len == 0) stamp = "none";
        else {
          var names = new IntPtr[count];
          IntPtr buf = Marshal.AllocHGlobal((int)len * 2);
          try {
            rc = PkgNative.GetPackagesByPackageFamily(family, ref count, names, ref len, buf);
            if (rc != 0) stamp = "err:" + rc;
            else {
              var parts = new List<string>();
              for (int i = 0; i < count && i < names.Length; i++) {
                string full = Marshal.PtrToStringUni(names[i]);
                if (!string.IsNullOrEmpty(full)) parts.Add(full + "@" + ManifestTicks(full));
              }
              parts.Sort(StringComparer.OrdinalIgnoreCase);
              stamp = parts.Count == 0 ? "none" : string.Join("|", parts.ToArray());
            }
          } finally { Marshal.FreeHGlobal(buf); }
        }
      } catch (Exception ex) {
        stamp = "err:" + ex.GetType().Name;
      }
      if (!string.IsNullOrEmpty(_testStampFile)) {
        try { stamp += "#" + File.ReadAllText(_testStampFile).Trim(); } catch (Exception) { stamp += "#-"; }
      }
      return stamp;
    }

    /// The package's AppxManifest.xml last-write ticks, or "-". A same-version re-register (a
    /// developer's own package) keeps the full name but rewrites the manifest.
    static string ManifestTicks(string fullName) {
      try {
        uint len = 0;
        PkgNative.GetPackagePathByFullName(fullName, ref len, null);
        if (len == 0) return "-";
        var sb = new StringBuilder((int)len + 1);
        if (PkgNative.GetPackagePathByFullName(fullName, ref len, sb) != 0) return "-";
        var fi = new FileInfo(Path.Combine(sb.ToString(), "AppxManifest.xml"));
        return fi.Exists ? fi.LastWriteTimeUtc.Ticks.ToString() : "-";
      } catch (Exception) {
        return "-";
      }
    }

    /// Caller holds _iconCache. True when e still describes the installed package (checked at most
    /// once per PackageCheckEveryMs); false marks it Stale for good, so the next lookup reads again.
    static bool Fresh(string aumid, AppEntry e) {
      if (e.Stale) return false;
      if (e.Stamp == null) return true;                  // not a package id: kept for the run
      int now = Environment.TickCount;
      if (e.RetryAt != 0) {
        if (unchecked(now - e.RetryAt) < 0) return true;
        e.Stale = true;
        return false;
      }
      if (unchecked(now - e.CheckedAt) < PackageCheckEveryMs) return true;
      e.CheckedAt = now;
      if (PackageStamp(aumid) == e.Stamp) return true;
      e.Stale = true;
      return false;
    }

    // ---- read again in the background: TryIconCached's caller is the window list on the ui lane ----
    static readonly List<string> _refreshQueue = new List<string>();
    static readonly HashSet<string> _refreshQueued = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    static System.Threading.Thread _refreshThread;
    static int _refreshed;     // 1 = a picture changed: Windows.OnTick sends the list again (TakeRefreshed)

    /// True once after a background re-read changed a Store app's picture (then false until the next).
    public static bool TakeRefreshed() {
      return System.Threading.Interlocked.Exchange(ref _refreshed, 0) == 1;
    }

    static void QueueRefresh(string aumid) {
      lock (_refreshQueue) {
        if (!_refreshQueued.Add(aumid)) return;
        _refreshQueue.Add(aumid);
        if (_refreshThread != null) return;
        try {
          var t = new System.Threading.Thread(RefreshLoop);
          t.IsBackground = true;
          t.Name = "mantle-appicon-refresh";
          t.SetApartmentState(System.Threading.ApartmentState.STA);   // the shell item + image factory are COM
          t.Start();
          _refreshThread = t;
        } catch (Exception ex) {
          // the ids stay in _refreshQueued, so this is logged once per app, not on every tick
          _refreshQueue.Clear();
          Program.EmitLog("warn", "an updated Store app's icon could not be read again in the background, so the window list keeps the old one until Mantle restarts (" + ex.Message + ")");
        }
      }
    }

    static void RefreshLoop() {
      while (true) {
        string aumid;
        lock (_refreshQueue) {
          if (_refreshQueue.Count == 0) { _refreshThread = null; return; }
          aumid = _refreshQueue[0];
          _refreshQueue.RemoveAt(0);
        }
        string before = null;
        lock (_iconCache) { AppEntry old; if (_iconCache.TryGetValue(aumid, out old)) before = old.Url; }
        string after = null;
        try { after = IconFor(aumid); } catch (Exception ex) { Program.EmitLog("warn", "an updated Store app's icon could not be read again: " + ex.Message); }
        lock (_refreshQueue) _refreshQueued.Remove(aumid);
        if (!string.Equals(before, after, StringComparison.Ordinal)) System.Threading.Interlocked.Exchange(ref _refreshed, 1);
      }
    }

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
    /// Always asks the shell (Media, Notifications and SysNotify call this for a one-off name), and
    /// what it read lands in the icon cache. `app` and the window list go through Lookup / IconFor.
    public static string Info(string aumid, out string name, out string png) {
      return Info(aumid, out name, out png, false);
    }

    static string Info(string aumid, out string name, out string png, bool logFailure) {
      name = null;
      png = null;
      if (string.IsNullOrEmpty(aumid)) return "app needs an aumid";
      // Stamped BEFORE reading (as Icons.cs does): a package swapped mid-read then looks changed
      // next time and is read again, rather than its half-updated picture being kept.
      string stamp = PackageStamp(aumid);
      string why = Read(aumid, out name, out png);
      Remember(aumid, stamp, name, png, why, logFailure);
      return why;
    }

    /// What a read means for the cache: the new answer, or, when a re-read after a package change
    /// failed and there was a picture, that old picture kept (retried in RetryFailedReadMs). Logs
    /// a failure once per id and reason, and a package change once per change.
    static void Remember(string aumid, string stamp, string name, string png, string why, bool logFailure) {
      AppEntry prev, e;
      bool keptOld = false, changed = false;
      lock (_iconCache) {
        _iconCache.TryGetValue(aumid, out prev);
        e = new AppEntry { Url = png, Name = name, Why = why, Stamp = stamp, CheckedAt = Environment.TickCount };
        if (why != null && prev != null && prev.Url != null) {
          // the OLD package's stamp: when the retry succeeds it still counts as the change it is
          e.Url = prev.Url; e.Name = prev.Name; e.Why = null; e.Stamp = prev.Stamp;
          e.RetryAt = unchecked(Environment.TickCount + RetryFailedReadMs);
          if (e.RetryAt == 0) e.RetryAt = 1;
          keptOld = true;
        }
        if (prev != null) e.LoggedWhy = prev.LoggedWhy;
        changed = why == null && prev != null && prev.Stamp != null && prev.Stamp != stamp;
        if (why == null) e.LoggedWhy = null;
        else if (logFailure && e.LoggedWhy != why) e.LoggedWhy = why;
        else logFailure = false;
        _iconCache[aumid] = e;
      }
      if (why != null && logFailure) {
        Program.EmitLog("warn", keptOld
          ? "an updated Store app's new icon could not be read yet, so it keeps its old one and is tried again in a minute: " + aumid + " (" + why + ")"
          : "no app icon for " + aumid + " (" + why + ")");
      }
      if (changed) {
        bool differs = !string.Equals(prev.Url, png, StringComparison.Ordinal) || !string.Equals(prev.Name, name, StringComparison.Ordinal);
        Program.EmitLog("info", "a Store app's package changed (an update), so its icon was read again: " + aumid +
          (differs ? " (new picture)" : " (same picture)"));
        // main.js drops its pinned-list cache and the bar's cached picture for this app on this, so
        // a pinned app shows its new icon now rather than at the next 5-minute pin read.
        if (differs) Program.Emit(Json.Obj("ev", "appchanged", "aumid", aumid));
      }
    }

    /// The `app` command's answer: from the cache while the app's package is unchanged (checked at
    /// most once per PackageCheckEveryMs), else read again. `cached` says which. An id that is not
    /// a package app id is always read, as before. -> null, or the reason it could not be read.
    public static string Lookup(string aumid, out string name, out string png, out bool cached) {
      name = null; png = null; cached = false;
      if (string.IsNullOrEmpty(aumid)) return "app needs an aumid";
      bool package = FamilyOf(aumid) != null;
      if (package) {
        lock (_iconCache) {
          AppEntry e;
          if (_iconCache.TryGetValue(aumid, out e) && e.Stamp != null && Fresh(aumid, e)) {
            name = e.Name; png = e.Url; cached = true;
            return e.Why ?? (e.Url == null && e.Name == null ? "the app id '" + aumid + "' could not be read" : null);
          }
        }
      }
      string why = Info(aumid, out name, out png, true);
      if (why != null && package) {
        // a failed re-read may have kept the old picture: answer that, not a blank
        lock (_iconCache) {
          AppEntry e;
          if (_iconCache.TryGetValue(aumid, out e) && e.Why == null && e.Url != null) { name = e.Name; png = e.Url; return null; }
        }
      }
      return why;
    }

    static string Read(string aumid, out string name, out string png) {
      name = null;
      png = null;
      object raw = null;
      try {
        Guid iid = IidShellItem;
        int hr = Win32.SHCreateItemFromParsingName(AppsFolder + aumid, IntPtr.Zero, ref iid, out raw);
        if (hr != Win32.S_OK || raw == null)
          return "the shell does not know the app id '" + aumid + "' (HRESULT 0x" + hr.ToString("X8") + ")";
        var item = raw as IShellItem;
        if (item == null) return "the shell returned something that is not a shell item for '" + aumid + "'";
        name = DisplayName(item, Win32.SIGDN_NORMALDISPLAY);
        png = ImagePng(raw, IconPx);
        // The cache is filled by Remember, locked: `app` fills it on the slow lane while the window
        // list reads it on the ui lane (Lanes.cs). The shell calls stay outside the lock.
        return null;
      } catch (COMException ce) {
        return "the shell refused the app id '" + aumid + "' (HRESULT 0x" + ce.ErrorCode.ToString("X8") + ")";
      } catch (Exception ex) {
        return "the app id '" + aumid + "' could not be read (" + ex.Message + ")";
      } finally {
        if (raw != null) { try { Marshal.FinalReleaseComObject(raw); } catch (Exception) { } }
      }
    }

    /// The icon IconFor already has for an app id, without reading the package. -> true when known
    /// (png may then be null: that app has no icon). See Icons.TryCached. The window list on the ui
    /// lane uses this: an app whose package CHANGED (a Store update) still answers its old picture
    /// here (no blank while the new one is read) and is read again on a background thread;
    /// TakeRefreshed then tells the window list to send itself again. Never throws.
    public static bool TryIconCached(string aumid, out string png) {
      png = null;
      if (string.IsNullOrEmpty(aumid)) return true;
      bool stale;
      lock (_iconCache) {
        AppEntry e;
        if (!_iconCache.TryGetValue(aumid, out e)) return false;
        png = e.Url;
        stale = !Fresh(aumid, e);
      }
      if (stale) QueueRefresh(aumid);
      return true;
    }

    /// An app id's picture: cached, and read again when its package changed (see the header).
    /// Null when it has none; a failure is logged once per id and reason.
    public static string IconFor(string aumid) {
      if (string.IsNullOrEmpty(aumid)) return null;
      lock (_iconCache) {
        AppEntry e;
        if (_iconCache.TryGetValue(aumid, out e) && Fresh(aumid, e)) return e.Url;
      }
      string name, png;
      Info(aumid, out name, out png, true);
      lock (_iconCache) {
        AppEntry e;
        return _iconCache.TryGetValue(aumid, out e) ? e.Url : png;   // a kept old picture beats a blank
      }
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

    /// A file's icon (an .exe, a .lnk, anything the shell can parse) as a px x px PNG data URL, from
    /// the same image factory as a Store app's: the icon's own large frame, not SHGetFileInfo's
    /// 32 px one scaled up. Null on any failure: Icons.cs then falls back to SHGetFileInfo.
    public static string ImageForPath(string path, int px) {
      if (string.IsNullOrEmpty(path)) return null;
      object raw = null;
      try {
        Guid iid = IidShellItem;
        int hr = Win32.SHCreateItemFromParsingName(path, IntPtr.Zero, ref iid, out raw);
        if (hr != Win32.S_OK || raw == null) return null;
        return ImagePng(raw, px);
      } catch (Exception) {
        return null;
      } finally {
        if (raw != null) { try { Marshal.FinalReleaseComObject(raw); } catch (Exception) { } }
      }
    }

    /// px x px PNG data URL from a shell item, or null. ICONONLY so a document
    /// never comes back as a thumbnail of its contents.
    static string ImagePng(object raw, int px) {
      var factory = raw as IShellItemImageFactory;
      if (factory == null) return null;
      IntPtr hbmp = IntPtr.Zero;
      try {
        var size = new Win32.SIZE();
        size.cx = px;
        size.cy = px;
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
          "iconPng", kind == "app" && aumid != null ? IconFor(aumid) : ImagePng(raw, IconPx)));
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

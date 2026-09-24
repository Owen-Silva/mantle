// Desktops.cs - Task View's sidecar half (wave 3, lane taskview, 2026-09-24).
//
// WHAT: Win+Tab opens Mantle's own Task View. It needs three things only the sidecar can give it:
//   taskview.list      the Alt+Tab list (Switcher.ListNow, the SAME filter and order), each window
//                      tagged with its virtual desktop, plus the desktops and what is on the others
//   taskview.activate  switch to one window, by the Alt+Tab switch path (Switcher.Activate's steps)
//   desktops.*         list / switch / create / remove / rename desktops, move a window to one
// Every write takes {dry:true}: it resolves everything (the desktop, the window's app view, whether
// Windows lets it move) and answers with the plan WITHOUT making the call. Tests only ever dry-run:
// they must never switch, create, remove or rename Owen's desktops or move his windows.
//
// TWO COM INTERFACES, AND WHY ONE OF THEM IS PINNED TO A BUILD:
//   IVirtualDesktopManager (documented, stable): which desktop a window is on. That is all we use it
//     for; its MoveWindowToDesktop only works on the CALLING process's own windows.
//   IVirtualDesktopManagerInternal (undocumented, explorer's own): list, switch, create, remove,
//     rename, move another app's window. Microsoft changes its IID and its method order between
//     Windows builds, and calling a method at the wrong vtable slot does not fail politely: it runs
//     whatever method is there. So it is used ONLY when all three hold, else refused with the reason:
//       1. the build is 10.0.26200 (the layout below was measured on it);
//       2. explorer answers QueryService for THIS IID (a different IID = a different layout);
//       3. the read-only self-check agrees with the registry (count, current desktop) and
//          FindDesktop (slot 12) finds the current desktop again, which proves slots 1-12 line up.
//     Otherwise the list comes from the registry, read-only, and every write says why it is off.
//
// MEASURED ON THIS MACHINE, 2026-09-24 (build 26200.9550, 25H2; scratchpad vdprobe, read-only):
//   * QueryService(VirtualDesktopManagerInternal): 53F5CA0B-... OK; A3175F2D-... (23H2) E_NOINTERFACE;
//     4970BA3D-... (22H2) ALSO OK - explorer still serves an older IID, so a matching IID alone is
//     not proof of a layout; the build pin and the self-check are.
//   * Verified slots: GetCount, CanViewMoveDesktops, GetCurrentDesktop, GetDesktops,
//     GetAdjacentDesktop (0x80028CA1 = no neighbour, with one desktop), FindDesktop;
//     IVirtualDesktop.IsViewVisible/GetId/GetName/GetWallpaperPath; ViewCollection.GetViewForHwnd
//     (TYPE_E_ELEMENTNOTFOUND for windows that are not app views).
//   * IVirtualDesktop.IsRemote (in the published 24H2 layout) is NOT in this build: calling it was an
//     AccessViolation, which .NET cannot normally catch. It is not declared here, so it cannot be called.
//   * NOT verifiable read-only (never run from a test): MoveViewToDesktop, SwitchDesktop, CreateDesktop,
//     RemoveDesktop, SetDesktopName. Their slots sit between/after verified ones in the same layout.
//   * Cost: cold (first call, STA) ~20 ms; warm on an MTA thread 0.04-1 ms per call. 6 windows'
//     GetWindowDesktopId: 1 ms warm. Hence: the objects live in the MTA and are warmed at startup.
//
// THREADING: the handlers are on the ui lane (the message loop, an STA). A cross-process COM call
// from an STA pumps messages while it waits, which could re-enter the ui lane mid-request, and a hung
// explorer would hold the whole lane. So every COM call runs on a thread-pool (MTA) thread and the
// handler waits with a deadline; a call still stuck in explorer makes the next ones fail at once,
// with the reason, instead of queueing behind it.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.ExceptionServices;
using System.Runtime.InteropServices;
using System.Security;
using System.Threading;
using Microsoft.Win32;

namespace Mantle {
  static class VdNative {
    public const int DWMWA_CLOAKED = 14;
    public const int DWM_CLOAKED_SHELL = 2;          // cloaked by the shell: another desktop (or a suspended Store app)
    public const int TYPE_E_ELEMENTNOTFOUND = unchecked((int)0x8002802B);
    public const int TYPE_E_OUTOFBOUNDS = unchecked((int)0x80028CA1);
    public const int AdjacentLeft = 3, AdjacentRight = 4;

    [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out int value, int size);
    [DllImport("user32.dll")] public static extern IntPtr GetLastActivePopup(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool IsHungAppWindow(IntPtr hwnd);

    public static readonly Guid CLSID_ImmersiveShell = new Guid("C2F03A33-21F5-47FA-B4BB-156362A2F239");
    public static readonly Guid CLSID_VirtualDesktopManagerInternal = new Guid("C5E0CDCA-7B6E-41B2-9FC4-D93975CC467B");
    public static readonly Guid CLSID_VirtualDesktopManager = new Guid("AA509086-5CA9-4C25-8F95-589D3C07B48A");

    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("6D5140C1-7436-11CE-8034-00AA006009FA")]
    internal interface IServiceProvider10 {
      [return: MarshalAs(UnmanagedType.IUnknown)] object QueryService(ref Guid service, ref Guid riid);
    }

    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("92CA9DCD-5622-4BBA-A805-5E9F541BD8C9")]
    internal interface IObjectArray {
      void GetCount(out int count);
      void GetAt(int index, ref Guid iid, [MarshalAs(UnmanagedType.Interface)] out object obj);
    }

    // Opaque: passed back to explorer, never called (its own layout is not needed or verified).
    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIInspectable), Guid("372E1D3B-38D3-42E4-A15B-8AB2B178F513")]
    internal interface IApplicationView { }

    // Build 26200. IsRemote (slot 5 in the published 24H2 layout) is deliberately absent: see the header.
    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("3F07F4BE-B107-441A-AF0F-39D82529072C")]
    internal interface IVirtualDesktop {
      bool IsViewVisible(IApplicationView view);
      Guid GetId();
      [return: MarshalAs(UnmanagedType.HString)] string GetName();
      [return: MarshalAs(UnmanagedType.HString)] string GetWallpaperPath();
    }

    // Build 26200. Every slot up to SetDesktopName is declared, in order, because the position IS the
    // method; the ones after it are never called and so not declared.
    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("53F5CA0B-158F-4124-900C-057158060B27")]
    internal interface IVirtualDesktopManagerInternal {
      int GetCount();                                                                  // 1  verified
      void MoveViewToDesktop(IApplicationView view, IVirtualDesktop desktop);          // 2  write
      bool CanViewMoveDesktops(IApplicationView view);                                 // 3  verified
      IVirtualDesktop GetCurrentDesktop();                                             // 4  verified
      void GetDesktops(out IObjectArray desktops);                                     // 5  verified
      [PreserveSig] int GetAdjacentDesktop(IVirtualDesktop from, int direction, out IVirtualDesktop desktop); // 6 verified
      void SwitchDesktop(IVirtualDesktop desktop);                                     // 7  write
      void SwitchDesktopAndMoveForegroundView(IVirtualDesktop desktop);                // 8  never called
      IVirtualDesktop CreateDesktop();                                                 // 9  write
      void MoveDesktop(IVirtualDesktop desktop, int index);                            // 10 never called
      void RemoveDesktop(IVirtualDesktop desktop, IVirtualDesktop fallback);           // 11 write
      IVirtualDesktop FindDesktop(ref Guid id);                                        // 12 verified
      void GetDesktopSwitchIncludeExcludeViews(IVirtualDesktop desktop, out IObjectArray a, out IObjectArray b); // 13 never called
      void SetDesktopName(IVirtualDesktop desktop, [MarshalAs(UnmanagedType.HString)] string name); // 14 write
    }

    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("1841C6D7-4F9D-42C0-AF41-8747538F10E5")]
    internal interface IApplicationViewCollection {
      [PreserveSig] int GetViews(out IObjectArray array);
      [PreserveSig] int GetViewsByZOrder(out IObjectArray array);
      [PreserveSig] int GetViewsByAppUserModelId([MarshalAs(UnmanagedType.LPWStr)] string id, out IObjectArray array);
      [PreserveSig] int GetViewForHwnd(IntPtr hwnd, out IApplicationView view);        // verified
    }

    // Documented (shobjidl_core.h).
    [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown), Guid("A5CD92FF-29BE-454C-8D04-D82879FB3F1B")]
    internal interface IVirtualDesktopManager {
      [PreserveSig] int IsWindowOnCurrentVirtualDesktop(IntPtr hwnd, out int onCurrent);
      [PreserveSig] int GetWindowDesktopId(IntPtr hwnd, out Guid id);
    }
  }

  /// The COM objects and the reasons they are (not) usable. Touched ONLY from MTA threads (VdCom.Run).
  static class VdCom {
    public const int PinnedBuild = 26200;
    const string RegRoot = @"Software\Microsoft\Windows\CurrentVersion\Explorer\VirtualDesktops";

    static VdNative.IVirtualDesktopManager _doc;
    static VdNative.IVirtualDesktopManagerInternal _mgr;
    static VdNative.IApplicationViewCollection _views;
    static string _docReason, _mgrReason;
    static bool _faulted;            // an AccessViolation came out of explorer's interface: off until restart
    public static int Build = -1;

    static int ReadBuild() {
      try {
        using (RegistryKey k = Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\Windows NT\CurrentVersion")) {
          object v = k == null ? null : k.GetValue("CurrentBuild");
          int b;
          if (v != null && int.TryParse(Convert.ToString(v, CultureInfo.InvariantCulture), NumberStyles.Integer, CultureInfo.InvariantCulture, out b)) return b;
        }
      } catch (Exception) { }
      return 0;
    }

    public static string IdText(Guid g) { return g.ToString("D").ToUpperInvariant(); }

    static bool Dead(Exception ex) {
      int hr = Marshal.GetHRForException(ex);
      // RPC_E_DISCONNECTED, RPC_S_SERVER_UNAVAILABLE, RPC_S_CALL_FAILED: explorer restarted under us.
      return hr == unchecked((int)0x80010108) || hr == unchecked((int)0x800706BA) || hr == unchecked((int)0x800706BE);
    }

    public static void Drop(string why) {
      _doc = null; _mgr = null; _views = null;
      _docReason = null; _mgrReason = null;
      if (why != null) Program.EmitLog("warn", "desktops: dropped explorer's desktop objects (" + why + ")");
    }

    /// The documented manager, or null with DocReason set.
    public static VdNative.IVirtualDesktopManager Doc() {
      if (_doc != null || _docReason != null) return _doc;
      try {
        _doc = (VdNative.IVirtualDesktopManager)Activator.CreateInstance(Type.GetTypeFromCLSID(VdNative.CLSID_VirtualDesktopManager));
      } catch (Exception ex) {
        _docReason = "Windows' virtual desktop manager could not be created (" + ex.GetType().Name + " 0x" +
                     Marshal.GetHRForException(ex).ToString("X8") + "), so Mantle cannot tell which desktop a window is on";
      }
      return _doc;
    }
    public static string DocReason { get { return _docReason; } }

    /// The internal manager when the build, the IID and the self-check all agree; else null with MgrReason.
    public static VdNative.IVirtualDesktopManagerInternal Mgr() {
      if (_mgr != null || _mgrReason != null) return _mgr;
      if (_faulted) { _mgrReason = "a call into Windows' internal desktop interface faulted earlier, so Mantle stopped using it until it restarts"; return null; }
      if (Build < 0) Build = ReadBuild();
      if (Build != PinnedBuild) {
        _mgrReason = "this is Windows build 10.0." + Build + ", and Mantle only has the desktop-switching layout for build 10.0." +
                     PinnedBuild + " (it changes between builds, and guessing could run the wrong command)";
        return null;
      }
      try {
        var sp = (VdNative.IServiceProvider10)Activator.CreateInstance(Type.GetTypeFromCLSID(VdNative.CLSID_ImmersiveShell));
        Guid svc = VdNative.CLSID_VirtualDesktopManagerInternal;
        Guid iid = typeof(VdNative.IVirtualDesktopManagerInternal).GUID;
        object o;
        try { o = sp.QueryService(ref svc, ref iid); }
        catch (Exception ex) {
          _mgrReason = "explorer does not offer the desktop interface Mantle knows for build " + PinnedBuild + " (QueryService 0x" +
                       Marshal.GetHRForException(ex).ToString("X8") + "): Windows has changed it, so Mantle will not guess";
          return null;
        }
        var mgr = (VdNative.IVirtualDesktopManagerInternal)o;
        Guid ciid = typeof(VdNative.IApplicationViewCollection).GUID;
        VdNative.IApplicationViewCollection views = null;
        try { views = (VdNative.IApplicationViewCollection)sp.QueryService(ref ciid, ref ciid); }
        catch (Exception) { views = null; }   // only moving windows needs it; said in MoveWindow
        string bad = SelfCheck(mgr);
        if (bad != null) { _mgrReason = bad; return null; }
        _mgr = mgr; _views = views;
      } catch (Exception ex) {
        _mgrReason = "explorer's desktop interface could not be reached (" + ex.GetType().Name + " 0x" +
                     Marshal.GetHRForException(ex).ToString("X8") + ")";
      }
      return _mgr;
    }
    public static string MgrReason { get { return _mgrReason; } }
    public static VdNative.IApplicationViewCollection Views { get { return _views; } }
    public static void Faulted(string what) { _faulted = true; Drop(what); }

    /// Read-only proof that this layout is the one explorer is running. Null = agreed.
    static string SelfCheck(VdNative.IVirtualDesktopManagerInternal mgr) {
      int n = mgr.GetCount();
      VdNative.IVirtualDesktop cur = mgr.GetCurrentDesktop();
      Guid curId = cur.GetId();
      VdNative.IObjectArray arr;
      mgr.GetDesktops(out arr);
      int an;
      arr.GetCount(out an);
      if (an != n) return "explorer's desktop interface disagrees with itself (count " + n + ", list " + an + "), so Mantle will not use it";
      Guid probe = curId;
      VdNative.IVirtualDesktop found = mgr.FindDesktop(ref probe);
      if (found == null || found.GetId() != curId)
        return "explorer's desktop interface failed Mantle's layout check (FindDesktop did not return the current desktop), so Mantle will not use it";
      RegDesktops reg = ReadRegistry();
      if (reg.Ids != null && reg.Ids.Count != n)
        return "explorer reports " + n + " desktop(s) but the registry lists " + reg.Ids.Count + ", so Mantle will not trust its desktop interface";
      if (reg.Current != Guid.Empty && reg.Current != curId)
        return "explorer and the registry disagree about which desktop is current, so Mantle will not trust its desktop interface";
      return null;
    }

    // ---- the registry: read-only fallback, and the self-check's second witness -----------------

    public sealed class RegDesktops {
      public List<Guid> Ids;           // null = unreadable
      public Guid Current = Guid.Empty;
      public Dictionary<Guid, string> Names = new Dictionary<Guid, string>();
      public string Reason;
    }

    static List<Guid> Guids(byte[] raw) {
      if (raw == null || raw.Length == 0 || raw.Length % 16 != 0) return null;
      var list = new List<Guid>(raw.Length / 16);
      for (int i = 0; i < raw.Length; i += 16) {
        byte[] one = new byte[16];
        Array.Copy(raw, i, one, 0, 16);
        list.Add(new Guid(one));
      }
      return list;
    }

    public static RegDesktops ReadRegistry() {
      var r = new RegDesktops();
      try {
        using (RegistryKey k = Registry.CurrentUser.OpenSubKey(RegRoot)) {
          if (k == null) { r.Reason = "the registry has no virtual desktop list (HKCU\\" + RegRoot + ")"; return r; }
          r.Ids = Guids(k.GetValue("VirtualDesktopIDs") as byte[]);
          if (r.Ids == null) r.Reason = "the registry's VirtualDesktopIDs value is missing or malformed";
          List<Guid> cur = Guids(k.GetValue("CurrentVirtualDesktop") as byte[]);
          if (cur == null) {
            // Some builds keep the current desktop per logon session instead.
            string sid = Process.GetCurrentProcess().SessionId.ToString(CultureInfo.InvariantCulture);
            using (RegistryKey s = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Explorer\SessionInfo\" + sid + @"\VirtualDesktops")) {
              if (s != null) cur = Guids(s.GetValue("CurrentVirtualDesktop") as byte[]);
            }
          }
          if (cur != null && cur.Count == 1) r.Current = cur[0];
          if (r.Ids != null) {
            foreach (Guid g in r.Ids) {
              using (RegistryKey d = k.OpenSubKey(@"Desktops\{" + IdText(g) + "}")) {
                string name = d == null ? null : d.GetValue("Name") as string;
                if (!string.IsNullOrEmpty(name)) r.Names[g] = name;
              }
            }
          }
        }
      } catch (Exception ex) {
        r.Ids = null;
        r.Reason = "the registry's virtual desktop list could not be read (" + ex.GetType().Name + ")";
      }
      return r;
    }

    // ---- running on the MTA, with a deadline ----------------------------------------------------

    public delegate string Job();
    static long _busySince;          // Stopwatch timestamp of the COM call in flight, 0 = idle
    static readonly object _gate = new object();

    /// Runs `job` on a thread-pool (MTA) thread and waits up to `ms`. Null = the job's own answer
    /// (its return value) came back in time; otherwise the plain-words reason it did not.
    public static string Run(Job job, int ms) {
      lock (_gate) {
        if (_busySince != 0) {
          return "explorer has not answered Mantle's previous desktop call for " + Lanes.MsSince(_busySince) +
                 " ms, so this one was not sent (Windows' desktop service looks stuck)";
        }
        _busySince = Stopwatch.GetTimestamp();
      }
      string answer = null;
      var done = new ManualResetEvent(false);
      ThreadPool.QueueUserWorkItem(delegate (object _) {
        try { answer = Guarded(job); }
        finally {
          lock (_gate) _busySince = 0;
          try { done.Set(); } catch (ObjectDisposedException) { }
        }
      });
      if (!done.WaitOne(ms)) return "explorer did not answer a desktop call within " + ms + " ms";
      done.Close();
      return answer;
    }

    /// The one place a fault inside explorer's undocumented interface is caught, so a layout this
    /// file got wrong costs desktop switching, never the sidecar (every other Mantle feature).
    [HandleProcessCorruptedStateExceptions, SecurityCritical]
    static string Guarded(Job job) {
      try { return job(); }
      catch (AccessViolationException) {
        Faulted("AccessViolation inside a desktop call");
        return "a call into Windows' internal desktop interface faulted; Mantle stopped using it until it restarts";
      } catch (COMException ex) {
        if (Dead(ex)) { Drop("explorer went away: 0x" + ex.ErrorCode.ToString("X8")); return "explorer restarted during the call; try again"; }
        return "Windows refused the desktop call (0x" + ex.ErrorCode.ToString("X8") + ")";
      } catch (InvalidCastException ex) {
        Drop("cast: " + ex.Message);
        return "explorer's desktop objects changed shape under Mantle (" + ex.Message + ")";
      } catch (Exception ex) {
        return "the desktop call threw " + ex.GetType().Name + ": " + ex.Message;
      }
    }
  }

  [MantleFeature]
  static class Desktops {
    const int ReadMs = 800;       // cold ~20 ms, warm ~1 ms (measured); 800 = explorer is in trouble
    const int WriteMs = 3000;     // a switch/remove can wait on explorer's own animation

    public static void Register(FeatureTable t) {
      t.Add("taskview.list", Lanes.Ui, List);
      t.Add("taskview.activate", Lanes.Ui, Activate);
      t.Add("desktops.list", Lanes.Ui, DesktopList);
      t.Add("desktops.switch", Lanes.Ui, Switch);
      t.Add("desktops.create", Lanes.Ui, Create);
      t.Add("desktops.remove", Lanes.Ui, Remove);
      t.Add("desktops.rename", Lanes.Ui, Rename);
      t.Add("desktops.move", Lanes.Ui, Move);
      // Warm the COM objects (and run the self-check) off every lane, so the first Win+Tab pays
      // ~1 ms instead of ~20. Read-only, so passive runs it too.
      ThreadPool.QueueUserWorkItem(delegate (object _) {
        VdCom.Run(delegate { VdCom.Doc(); VdCom.Mgr(); return null; }, 5000);
      });
    }

    // ------------------------------------------------------------------ reads

    /// {ok, source:'com'|'registry'|'none', reason, canWrite, writeReason, current, list:[{id,name,named,index}]}
    /// MTA only (inside VdCom.Run).
    static IDictionary ReadDesktopsMta() {
      var list = new List<object>();
      VdNative.IVirtualDesktopManagerInternal mgr = VdCom.Mgr();
      if (mgr != null) {
        VdNative.IObjectArray arr;
        mgr.GetDesktops(out arr);
        int n;
        arr.GetCount(out n);
        Guid iid = typeof(VdNative.IVirtualDesktop).GUID;
        for (int i = 0; i < n; i++) {
          object o;
          arr.GetAt(i, ref iid, out o);
          var d = (VdNative.IVirtualDesktop)o;
          string name = d.GetName();
          list.Add(Json.Obj("id", VdCom.IdText(d.GetId()), "index", i, "named", !string.IsNullOrEmpty(name),
                            "name", string.IsNullOrEmpty(name) ? "Desktop " + (i + 1) : name));
        }
        return Json.Obj("ok", true, "source", "com", "reason", null, "canWrite", true, "writeReason", null,
                        "current", VdCom.IdText(mgr.GetCurrentDesktop().GetId()), "list", list, "build", VdCom.Build);
      }
      string why = VdCom.MgrReason;
      VdCom.RegDesktops reg = VdCom.ReadRegistry();
      if (reg.Ids == null) {
        return Json.Obj("ok", false, "source", "none", "reason", why + "; " + reg.Reason, "canWrite", false,
                        "writeReason", why, "current", null, "list", list, "build", VdCom.Build);
      }
      for (int i = 0; i < reg.Ids.Count; i++) {
        string name;
        bool named = reg.Names.TryGetValue(reg.Ids[i], out name);
        list.Add(Json.Obj("id", VdCom.IdText(reg.Ids[i]), "index", i, "named", named, "name", named ? name : "Desktop " + (i + 1)));
      }
      return Json.Obj("ok", true, "source", "registry", "reason", "read from the registry because " + why, "canWrite", false,
                      "writeReason", why, "current", reg.Current == Guid.Empty ? null : VdCom.IdText(reg.Current), "list", list,
                      "build", VdCom.Build);
    }

    static string DesktopList(Dictionary<string, object> req, ref object result) {
      IDictionary d = null;
      string err = VdCom.Run(delegate { d = ReadDesktopsMta(); return null; }, ReadMs);
      if (err != null) return err;
      result = d;
      return null;
    }

    static string DesktopOf(VdNative.IVirtualDesktopManager doc, IntPtr hwnd) {
      Guid id;
      if (doc == null || doc.GetWindowDesktopId(hwnd, out id) != 0 || id == Guid.Empty) return null;
      return VdCom.IdText(id);
    }

    /// Windows on the OTHER desktops, for the strip's counts and hover lists. The Alt+Tab filter
    /// drops every cloaked window; these are the shell-cloaked ones Windows can place on a desktop.
    static List<object> OthersMta(VdNative.IVirtualDesktopManager doc, string current) {
      var found = new List<object>();
      if (doc == null) return found;
      int ownPid = Program.OwnPid, parentPid = Program.ParentPid;
      Win32.EnumWindowsProc cb = delegate (IntPtr hwnd, IntPtr lp) {
        try {
          if (!Win32.IsWindowVisible(hwnd)) return true;
          if (Win32.GetWindow(hwnd, Win32.GW_OWNER) != IntPtr.Zero) return true;
          if ((Win32.GetWindowLongPtr(hwnd, Win32.GWL_EXSTYLE).ToInt64() & Win32.WS_EX_TOOLWINDOW) != 0) return true;
          int cloak;
          if (VdNative.DwmGetWindowAttribute(hwnd, VdNative.DWMWA_CLOAKED, out cloak, 4) != 0) return true;
          if ((cloak & VdNative.DWM_CLOAKED_SHELL) == 0) return true;
          string title = Win32.GetWindowText(hwnd);
          if (title.Length == 0) return true;
          int pid;
          Win32.GetWindowThreadProcessId(hwnd, out pid);
          if (pid == ownPid || (parentPid > 0 && pid == parentPid)) return true;
          string id = DesktopOf(doc, hwnd);
          // No desktop (a suspended Store app) or this desktop (cloaked for another reason): not "elsewhere".
          if (id == null || id == current) return true;
          found.Add(Json.Obj("hwnd", hwnd.ToInt64().ToString(CultureInfo.InvariantCulture), "title", title, "desktop", id));
        } catch (Exception) { /* one odd window never costs the list */ }
        return true;
      };
      Win32.EnumWindows(cb, IntPtr.Zero);
      GC.KeepAlive(cb);
      return found;
    }

    /// The Alt+Tab list (same filter, same order, same monitor fields) plus desktops.
    static string List(Dictionary<string, object> req, ref object result) {
      long t0 = Stopwatch.GetTimestamp();
      IDictionary d = Switcher.ListNow();
      long winMs = Lanes.MsSince(t0);
      var items = d["list"] as IList;
      IDictionary desks = null;
      List<object> others = null;
      string docReason = null;
      long t1 = Stopwatch.GetTimestamp();
      string err = VdCom.Run(delegate {
        desks = ReadDesktopsMta();
        VdNative.IVirtualDesktopManager doc = VdCom.Doc();
        docReason = VdCom.DocReason;
        string current = desks["current"] as string;
        if (items != null && doc != null) {
          foreach (object o in items) {
            var it = o as IDictionary;
            if (it == null) continue;
            long h;
            long.TryParse(Convert.ToString(it["hwnd"], CultureInfo.InvariantCulture), NumberStyles.Integer, CultureInfo.InvariantCulture, out h);
            it["desktop"] = DesktopOf(doc, new IntPtr(h));
          }
        }
        others = OthersMta(doc, current);
        return null;
      }, ReadMs);
      if (err != null) {
        desks = Json.Obj("ok", false, "source", "none", "reason", err, "canWrite", false, "writeReason", err,
                         "current", null, "list", new List<object>());
      } else if (docReason != null && (bool)desks["ok"]) {
        desks["windowsReason"] = docReason;
      }
      d["desktops"] = desks;
      d["others"] = others ?? new List<object>();
      d["ms"] = Json.Obj("windows", winMs, "desktops", Lanes.MsSince(t1));
      result = d;
      return null;
    }

    // ------------------------------------------------------------------ writes

    static bool Dry(Dictionary<string, object> req) { return Json.GetBool(req, "dry", false); }

    /// The gate every write goes through: passive refuses a real write, the layout must be proven.
    static string WriteGate(Dictionary<string, object> req, string what) {
      if (Program.Passive && !Dry(req)) return FeatureTable.PassiveRefusal + ": it would have " + what;
      return null;
    }

    static bool ParseId(Dictionary<string, object> req, out Guid id) {
      id = Guid.Empty;
      // "desktop", never "id": the wire protocol owns "id" (the request number).
      string s = Json.GetString(req, "desktop");
      return s != null && Guid.TryParse(s.Trim(), out id);
    }

    /// Runs `body` with a proven internal manager, or returns why it cannot.
    delegate string MgrJob(VdNative.IVirtualDesktopManagerInternal mgr);
    static string WithMgr(MgrJob body, int ms) {
      string inner = null;
      string err = VdCom.Run(delegate {
        VdNative.IVirtualDesktopManagerInternal mgr = VdCom.Mgr();
        if (mgr == null) { inner = "desktop changes are off: " + VdCom.MgrReason; return null; }
        inner = body(mgr);
        return null;
      }, ms);
      return err ?? inner;
    }

    static VdNative.IVirtualDesktop Find(VdNative.IVirtualDesktopManagerInternal mgr, Guid id) {
      try { return mgr.FindDesktop(ref id); } catch (COMException) { return null; }
    }

    static string Switch(Dictionary<string, object> req, ref object result) {
      Guid id;
      if (!ParseId(req, out id)) return "desktops.switch needs the desktop's id (desktop)";
      string gate = WriteGate(req, "switched to desktop " + VdCom.IdText(id));
      if (gate != null) return gate;
      bool dry = Dry(req);
      object res = null;
      string err = WithMgr(delegate (VdNative.IVirtualDesktopManagerInternal mgr) {
        VdNative.IVirtualDesktop target = Find(mgr, id);
        if (target == null) return "that desktop no longer exists";
        Guid cur = mgr.GetCurrentDesktop().GetId();
        if (cur == id) { res = Json.Obj("ok", true, "dry", dry, "already", true); return null; }
        if (!dry) mgr.SwitchDesktop(target);
        res = Json.Obj("ok", true, "dry", dry, "would", dry ? "switch" : null, "from", VdCom.IdText(cur), "to", VdCom.IdText(id));
        return null;
      }, WriteMs);
      if (err != null) return err;
      result = res;
      return null;
    }

    static string Create(Dictionary<string, object> req, ref object result) {
      string gate = WriteGate(req, "added a desktop");
      if (gate != null) return gate;
      bool dry = Dry(req);
      object res = null;
      string err = WithMgr(delegate (VdNative.IVirtualDesktopManagerInternal mgr) {
        int n = mgr.GetCount();
        if (dry) { res = Json.Obj("ok", true, "dry", true, "would", "create", "count", n); return null; }
        VdNative.IVirtualDesktop made = mgr.CreateDesktop();
        res = Json.Obj("ok", true, "dry", false, "id", made == null ? null : VdCom.IdText(made.GetId()), "count", n + 1);
        return null;
      }, WriteMs);
      if (err != null) return err;
      result = res;
      return null;
    }

    static string Remove(Dictionary<string, object> req, ref object result) {
      Guid id;
      if (!ParseId(req, out id)) return "desktops.remove needs the desktop's id (desktop)";
      string gate = WriteGate(req, "removed desktop " + VdCom.IdText(id));
      if (gate != null) return gate;
      bool dry = Dry(req);
      object res = null;
      string err = WithMgr(delegate (VdNative.IVirtualDesktopManagerInternal mgr) {
        if (mgr.GetCount() < 2) return "Windows always keeps one desktop, so the last one cannot be removed";
        VdNative.IVirtualDesktop target = Find(mgr, id);
        if (target == null) return "that desktop no longer exists";
        // Its windows go to the neighbour on the left, like Windows' own Task View; the first
        // desktop's go to the right.
        VdNative.IVirtualDesktop fallback;
        if (mgr.GetAdjacentDesktop(target, VdNative.AdjacentLeft, out fallback) != 0 || fallback == null) {
          if (mgr.GetAdjacentDesktop(target, VdNative.AdjacentRight, out fallback) != 0 || fallback == null)
            return "Windows reported no neighbouring desktop to move this one's windows to";
        }
        if (!dry) mgr.RemoveDesktop(target, fallback);
        res = Json.Obj("ok", true, "dry", dry, "would", dry ? "remove" : null, "id", VdCom.IdText(id),
                       "windowsGoTo", VdCom.IdText(fallback.GetId()));
        return null;
      }, WriteMs);
      if (err != null) return err;
      result = res;
      return null;
    }

    static string Rename(Dictionary<string, object> req, ref object result) {
      Guid id;
      if (!ParseId(req, out id)) return "desktops.rename needs the desktop's id (desktop)";
      string name = (Json.GetString(req, "name") ?? "").Trim();
      if (name.Length > 100) return "a desktop name can be at most 100 characters";
      string gate = WriteGate(req, "renamed desktop " + VdCom.IdText(id));
      if (gate != null) return gate;
      bool dry = Dry(req);
      object res = null;
      string err = WithMgr(delegate (VdNative.IVirtualDesktopManagerInternal mgr) {
        VdNative.IVirtualDesktop target = Find(mgr, id);
        if (target == null) return "that desktop no longer exists";
        // An empty name puts Windows' own "Desktop N" back.
        if (!dry) mgr.SetDesktopName(target, name);
        res = Json.Obj("ok", true, "dry", dry, "would", dry ? "rename" : null, "id", VdCom.IdText(id), "name", name);
        return null;
      }, WriteMs);
      if (err != null) return err;
      result = res;
      return null;
    }

    static string Move(Dictionary<string, object> req, ref object result) {
      Guid id;
      if (!ParseId(req, out id)) return "desktops.move needs the desktop's id (desktop)";
      IntPtr hwnd = Json.GetHwnd(req, "hwnd");
      if (hwnd == IntPtr.Zero || !Win32.IsWindow(hwnd)) return "that window has closed";
      string gate = WriteGate(req, "moved a window to desktop " + VdCom.IdText(id));
      if (gate != null) return gate;
      bool dry = Dry(req);
      object res = null;
      string err = WithMgr(delegate (VdNative.IVirtualDesktopManagerInternal mgr) {
        VdNative.IVirtualDesktop target = Find(mgr, id);
        if (target == null) return "that desktop no longer exists";
        VdNative.IApplicationViewCollection views = VdCom.Views;
        if (views == null) return "explorer does not offer its window-view list, so Mantle cannot move windows between desktops";
        VdNative.IApplicationView view;
        int hr = views.GetViewForHwnd(hwnd, out view);
        if (hr != 0 || view == null)
          return "Windows does not manage that window as an app view (0x" + hr.ToString("X8") + "), so it cannot be moved to another desktop";
        if (!mgr.CanViewMoveDesktops(view)) return "Windows does not allow that window to move to another desktop";
        bool already = target.IsViewVisible(view);
        if (!dry && !already) mgr.MoveViewToDesktop(view, target);
        res = Json.Obj("ok", true, "dry", dry, "would", dry ? "move" : null, "already", already, "to", VdCom.IdText(id));
        return null;
      }, WriteMs);
      if (err != null) return err;
      result = res;
      return null;
    }

    /// Switch to one window: the SAME steps as Alt+Tab's Switcher.Activate (AltTab.cs), which is
    /// private to that file. The dialog a window has up is what gets focus, like Windows' own
    /// switcher; SetForegroundWindow first (the sidecar's parent - Task View - is the foreground
    /// process, so Windows allows it), then WindowList's focus ladder.
    static string Activate(Dictionary<string, object> req, ref object result) {
      IntPtr hwnd = Json.GetHwnd(req, "hwnd");
      if (hwnd == IntPtr.Zero) return "taskview.activate needs a window";
      bool dry = Dry(req);
      if (Program.Passive && !dry) return FeatureTable.PassiveRefusal + ": it would have switched to a window";
      if (!Win32.IsWindow(hwnd)) return "that window closed before Mantle could switch to it";
      bool hung = VdNative.IsHungAppWindow(hwnd);
      IntPtr popup = VdNative.GetLastActivePopup(hwnd);
      IntPtr focusTo = popup != IntPtr.Zero && popup != hwnd && Win32.IsWindowVisible(popup) &&
                       VdNative.IsWindowEnabled(popup) ? popup : hwnd;
      bool iconic = Win32.IsIconic(hwnd);
      if (dry) {
        result = Json.Obj("ok", true, "dry", true, "would", "activate",
                          "focusTo", focusTo.ToInt64().ToString(CultureInfo.InvariantCulture),
                          "dialog", focusTo != hwnd, "restore", iconic, "hung", hung);
        return null;
      }
      Win32.SetForegroundWindow(focusTo);
      if (RootOf(Win32.GetForegroundWindow()) == hwnd) {
        if (iconic) Win32.ShowWindowAsync(hwnd, Win32.SW_RESTORE);
        result = Json.Obj("ok", true, "how", "direct");
        return null;
      }
      string ferr = WindowList.Focus(hwnd);
      if (ferr == null && focusTo != hwnd) Win32.SetForegroundWindow(focusTo);
      if (ferr == null || RootOf(Win32.GetForegroundWindow()) == hwnd) {
        result = Json.Obj("ok", true, "how", "ladder");
        return null;
      }
      return "Windows kept another window in front (SetForegroundWindow was refused, then the focus ladder: " + ferr + ")" +
             (hung ? "; Windows also reports that window as not responding" : "");
    }

    static IntPtr RootOf(IntPtr hwnd) {
      if (hwnd == IntPtr.Zero) return IntPtr.Zero;
      IntPtr r = Win32.GetAncestor(hwnd, Win32.GA_ROOTOWNER);
      return r == IntPtr.Zero ? hwnd : r;
    }
  }
}

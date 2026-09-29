// FilesShell.cs - the shell's own context menu (files.verbs / files.verb), Open with
// (files.handlers / files.openwith / files.openwithdialog) and the file clipboard
// (files.clip.get / files.clip.set) for Mantle Files (lane files, 2026-09-28).
//
// WHY one long-lived STA thread with a message pump: an IContextMenu belongs to the apartment that
// built it, and many shell extensions (Send to, Open with, 7-Zip, Git, cloud providers) post
// window messages or cross-apartment calls while they fill a submenu or run a verb. Without a pump
// they hang. So every menu is built, read, kept (60 s, under `token`) and invoked on this one
// thread, and the commands answer Program.Deferred from it.
//
// PASSIVE: listing verbs and handlers and reading the clipboard are reads. Running a verb, Open
// with, the Open with dialog and writing the clipboard reach outside any folder, so a test sidecar
// refuses them ALWAYS (FilesGuard.AlwaysRefusedInPassive), sandbox or not.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Collections.Specialized;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using FN = Mantle.FilesNative;

namespace Mantle {
  [MantleFeature]
  static class FilesShell {
    public static void Register(FeatureTable t) {
      t.Add("files.verbs", Lanes.Slow, Files.Safe("files.verbs", Verbs));
      t.Add("files.verb", Lanes.Slow, Files.Safe("files.verb", Verb));
      t.Add("files.handlers", Lanes.Slow, Files.Safe("files.handlers", Handlers));
      t.Add("files.openwith", Lanes.Slow, Files.Safe("files.openwith", OpenWith));
      t.Add("files.openwithdialog", Lanes.Slow, Files.Safe("files.openwithdialog", OpenWithDialog));
      t.Add("files.clip.get", Lanes.Slow, Files.Safe("files.clip.get", ClipGet));
      t.Add("files.clip.set", Lanes.Slow, Files.Safe("files.clip.set", ClipSet));
    }

    // ------------------------------------------------------------------ the shell thread

    static readonly object _lock = new object();
    static readonly Queue<ThreadStart> _work = new Queue<ThreadStart>();
    static readonly AutoResetEvent _wake = new AutoResetEvent(false);
    static Thread _thread;

    /// Runs `work` on the shell thread; it answers the request `req` itself with the result.
    delegate string ShellWork(out object result);
    static object OnShellThread(Dictionary<string, object> req, string what, ShellWork work) {
      object id = req.ContainsKey("id") ? req["id"] : null;
      lock (_lock) {
        _work.Enqueue(delegate () {
          object res = null;
          string err;
          try { err = work(out res); }
          catch (Exception ex) { err = what + " failed: " + ex.GetType().Name; }
          Program.ReplyFromWorker(id, err == null, res, err);
        });
        if (_thread == null) {
          _thread = new Thread(Loop);
          _thread.IsBackground = true;
          _thread.Name = "mantle-files-shell";
          _thread.SetApartmentState(ApartmentState.STA);
          _thread.Start();
        }
      }
      _wake.Set();
      return Program.Deferred;
    }

    static void Loop() {
      IntPtr[] handles = { _wake.SafeWaitHandle.DangerousGetHandle() };
      while (true) {
        // QS_ALLINPUT + MWMO_INPUTAVAILABLE: wake for our queue OR any window message a shell
        // extension posts to this thread, and pump it.
        FN.MsgWaitForMultipleObjectsEx(1, handles, 1000, 0x4FF, 0x4);
        FN.MSG m;
        while (FN.PeekMessageW(out m, IntPtr.Zero, 0, 0, 1)) { FN.TranslateMessage(ref m); FN.DispatchMessageW(ref m); }
        while (true) {
          ThreadStart a = null;
          lock (_lock) { if (_work.Count > 0) a = _work.Dequeue(); }
          if (a == null) break;
          try { a(); } catch (Exception) { }
        }
        Expire(false);
      }
    }

    // ------------------------------------------------------------------ verbs

    sealed class Menu { public FN.IContextMenu Cm; public object Cm2; public IntPtr H; public long Ts; }
    static readonly Dictionary<string, Menu> _menus = new Dictionary<string, Menu>(StringComparer.Ordinal);
    static int _nextToken;
    const int MenuLifeMs = 60000, MaxMenus = 16;
    const uint CMF_NORMAL = 0, CMF_EXTENDEDVERBS = 0x100, IdFirst = 1, IdLast = 0x7FFF;
    const uint MIIM_STATE = 0x1, MIIM_ID = 0x2, MIIM_SUBMENU = 0x4, MIIM_STRING = 0x40, MIIM_FTYPE = 0x100;
    const uint MFT_SEPARATOR = 0x800, MFS_DISABLED = 0x3, WM_INITMENUPOPUP = 0x0117, GCS_VERBW = 4;

    /// Shell thread only. `all`: drop every menu (not used yet; kept for a future shutdown hook).
    static void Expire(bool all) {
      long now = Stopwatch.GetTimestamp();
      var dead = new List<string>();
      foreach (KeyValuePair<string, Menu> kv in _menus)
        if (all || (now - kv.Value.Ts) * 1000L / Stopwatch.Frequency > MenuLifeMs) dead.Add(kv.Key);
      foreach (string k in dead) Drop(k);
    }

    static void Drop(string token) {
      Menu m;
      if (!_menus.TryGetValue(token, out m)) return;
      _menus.Remove(token);
      if (m.H != IntPtr.Zero) FN.DestroyMenu(m.H);
      FN.Release(m.Cm2);
      FN.Release(m.Cm);
    }

    static string Verbs(Dictionary<string, object> req, ref object result) {
      List<string> paths = FN.StringList(req, "paths");
      if (paths.Count == 0) return "files.verbs needs paths";
      if (paths.Count > 1000) return "files.verbs: at most 1000 paths";
      foreach (string p in paths) if (!FN.IsAbsolute(p)) return "files.verbs: every path must be absolute";
      IntPtr owner = Json.GetHwnd(req, "owner");
      result = OnShellThread(req, "files.verbs", delegate (out object res) { return BuildMenu(paths, owner, out res); });
      return null;
    }

    static string BuildMenu(List<string> paths, IntPtr owner, out object res) {
      res = null;
      var pidls = new List<IntPtr>();
      object folderObj = null, cmObj = null;
      IntPtr hmenu = IntPtr.Zero;
      bool kept = false;
      try {
        string parent = null;
        var children = new IntPtr[paths.Count];
        for (int i = 0; i < paths.Count; i++) {
          IntPtr pidl; uint unused;
          int hr = FN.SHParseDisplayName(paths[i], IntPtr.Zero, out pidl, 0, out unused);
          if (hr != 0) return "files.verbs: an item could not be opened: " + FN.HrWords(hr);
          pidls.Add(pidl);
          string par = Path.GetDirectoryName(paths[i].Length > 3 ? paths[i].TrimEnd('\\') : paths[i]) ?? "";
          if (parent == null) parent = par;
          else if (!string.Equals(parent, par, StringComparison.OrdinalIgnoreCase))
            return "files.verbs: the items must all be in one folder";
          object pf; IntPtr last;
          Guid iidSf = FN.IID_IShellFolder;
          hr = FN.SHBindToParent(pidl, ref iidSf, out pf, out last);
          if (hr != 0) return "files.verbs: " + FN.HrWords(hr);
          if (folderObj == null) folderObj = pf; else FN.Release(pf);
          children[i] = last;                     // points into pidl: freed with it, never alone
        }
        Guid iidCm = FN.IID_IContextMenu;
        int ghr = ((FN.IShellFolder)folderObj).GetUIObjectOf(owner, (uint)children.Length, children, ref iidCm, IntPtr.Zero, out cmObj);
        if (ghr != 0 || cmObj == null) return "files.verbs: the shell gave no menu: " + FN.HrWords(ghr);
        var cm = (FN.IContextMenu)cmObj;
        hmenu = FN.CreatePopupMenu();
        int qhr = cm.QueryContextMenu(hmenu, 0, IdFirst, IdLast, CMF_NORMAL | CMF_EXTENDEDVERBS);
        if (qhr < 0) return "files.verbs: " + FN.HrWords(qhr);
        object cm2 = cmObj as FN.IContextMenu3;
        if (cm2 == null) cm2 = cmObj as FN.IContextMenu2;
        List<object> verbs = Walk(hmenu, cm, cm2, 0);
        while (_menus.Count >= MaxMenus) {
          string oldest = null; long ots = long.MaxValue;
          foreach (KeyValuePair<string, Menu> kv in _menus) if (kv.Value.Ts < ots) { ots = kv.Value.Ts; oldest = kv.Key; }
          Drop(oldest);
        }
        var m = new Menu();
        m.Cm = cm; m.Cm2 = null; m.H = hmenu; m.Ts = Stopwatch.GetTimestamp();
        string token = "m" + (++_nextToken);
        _menus[token] = m;
        kept = true;
        res = Json.Obj("token", token, "verbs", verbs);
        return null;
      } finally {
        foreach (IntPtr p in pidls) FN.ILFree(p);
        FN.Release(folderObj);
        if (!kept) {
          if (hmenu != IntPtr.Zero) FN.DestroyMenu(hmenu);
          FN.Release(cmObj);
        }
      }
    }

    static List<object> Walk(IntPtr hmenu, FN.IContextMenu cm, object cm2, int depth) {
      var list = new List<object>();
      int n = FN.GetMenuItemCount(hmenu);
      for (int i = 0; i < n; i++) {
        var mii = new FN.MENUITEMINFOW();
        mii.cbSize = (uint)Marshal.SizeOf(typeof(FN.MENUITEMINFOW));
        mii.fMask = MIIM_FTYPE | MIIM_ID | MIIM_SUBMENU | MIIM_STATE | MIIM_STRING;
        if (!FN.GetMenuItemInfoW(hmenu, (uint)i, true, ref mii)) continue;
        if ((mii.fType & MFT_SEPARATOR) != 0) continue;
        if ((mii.fState & MFS_DISABLED) != 0) continue;
        string label = null;
        if (mii.cch > 0) {
          uint cch = mii.cch + 1;
          IntPtr buf = Marshal.AllocHGlobal((int)cch * 2);
          try {
            mii.dwTypeData = buf; mii.cch = cch;
            if (FN.GetMenuItemInfoW(hmenu, (uint)i, true, ref mii)) label = Marshal.PtrToStringUni(buf);
          } finally { Marshal.FreeHGlobal(buf); }
        }
        List<object> sub = new List<object>();
        if (mii.hSubMenu != IntPtr.Zero && depth < 3) {
          // Lazy submenus (Send to, Open with, Share) fill themselves on WM_INITMENUPOPUP.
          try {
            var c3 = cm2 as FN.IContextMenu3;
            var c2 = cm2 as FN.IContextMenu2;
            if (c3 != null) { IntPtr r; c3.HandleMenuMsg2(WM_INITMENUPOPUP, mii.hSubMenu, (IntPtr)i, out r); }
            else if (c2 != null) c2.HandleMenuMsg(WM_INITMENUPOPUP, mii.hSubMenu, (IntPtr)i);
          } catch (Exception) { }
          sub = Walk(mii.hSubMenu, cm, cm2, depth + 1);
        }
        if (string.IsNullOrEmpty(label)) continue;   // owner-drawn with no text: nothing to show
        string verb = "";
        if (mii.hSubMenu == IntPtr.Zero && mii.wID >= IdFirst && mii.wID <= IdLast) verb = CanonicalVerb(cm, mii.wID - IdFirst);
        list.Add(Json.Obj("cmd", (long)mii.wID, "label", Clean(label), "verb", verb, "sub", sub));
      }
      return list;
    }

    /// "&Open" -> "Open", "A && B" -> "A & B", and any "\tShortcut" tail dropped.
    static string Clean(string s) {
      int tab = s.IndexOf('\t');
      if (tab >= 0) s = s.Substring(0, tab);
      var sb = new StringBuilder(s.Length);
      for (int i = 0; i < s.Length; i++) {
        if (s[i] == '&') { if (i + 1 < s.Length && s[i + 1] == '&') { sb.Append('&'); i++; } continue; }
        sb.Append(s[i]);
      }
      return sb.ToString().Trim();
    }

    static string CanonicalVerb(FN.IContextMenu cm, uint offset) {
      IntPtr buf = Marshal.AllocHGlobal(520);
      try {
        Marshal.WriteInt16(buf, 0);
        if (cm.GetCommandString(new UIntPtr(offset), GCS_VERBW, IntPtr.Zero, buf, 256) != 0) return "";
        return Marshal.PtrToStringUni(buf) ?? "";
      } catch (Exception) { return ""; }
      finally { Marshal.FreeHGlobal(buf); }
    }

    static string Verb(Dictionary<string, object> req, ref object result) {
      string refuse = FilesGuard.AlwaysRefusedInPassive("files.verb (it would run a shell command)");
      if (refuse != null) return refuse;
      string token = Json.GetString(req, "token");
      int cmd = Json.GetInt(req, "cmd", -1);
      if (string.IsNullOrEmpty(token) || cmd < (int)IdFirst || cmd > (int)IdLast) return "files.verb needs token and cmd from files.verbs";
      IntPtr owner = Json.GetHwnd(req, "owner");
      result = OnShellThread(req, "files.verb", delegate (out object res) {
        res = null;
        Menu m;
        if (!_menus.TryGetValue(token, out m)) return "files.verb: that menu has expired (menus live 60 s); ask files.verbs again";
        var ici = new FN.CMINVOKECOMMANDINFOEX();
        ici.cbSize = Marshal.SizeOf(typeof(FN.CMINVOKECOMMANDINFOEX));
        ici.fMask = 0x4000;                            // CMIC_MASK_UNICODE
        ici.hwnd = owner;
        ici.lpVerb = new IntPtr(cmd - (int)IdFirst);   // MAKEINTRESOURCE(offset)
        ici.lpVerbW = new IntPtr(cmd - (int)IdFirst);
        ici.nShow = 1;                                 // SW_SHOWNORMAL
        int hr = m.Cm.InvokeCommand(ref ici);
        if (hr < 0) return "files.verb: " + FN.HrWords(hr);
        res = Json.Obj("ok", true, "hr", hr);
        return null;
      });
      return null;
    }

    // ------------------------------------------------------------------ open with

    sealed class Handler { public string Name, Ui, Icon; public bool Rec; public FN.IAssocHandler H; }

    static List<Handler> EnumHandlers(string ext, bool icons) {
      var list = new List<Handler>();
      if (string.IsNullOrEmpty(ext)) return list;
      FN.IEnumAssocHandlers en;
      if (FN.SHAssocEnumHandlers(ext, 0, out en) != 0 || en == null) return list;
      try {
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        FN.IAssocHandler h; uint got;
        while (list.Count < 64 && en.Next(1, out h, out got) == 0 && got == 1 && h != null) {
          var x = new Handler();
          x.H = h;
          if (h.GetName(out x.Name) != 0 || string.IsNullOrEmpty(x.Name) || !seen.Add(x.Name)) { FN.Release(h); continue; }
          if (h.GetUIName(out x.Ui) != 0) x.Ui = x.Name;
          x.Rec = h.IsRecommended() == 0;
          if (icons) {
            string loc; int idx;
            if (h.GetIconLocation(out loc, out idx) == 0) x.Icon = IconAt(loc, idx);
          }
          list.Add(x);
        }
      } finally { FN.Release(en); }
      // Recommended first, each group in the shell's own order.
      var sorted = new List<Handler>();
      foreach (Handler x in list) if (x.Rec) sorted.Add(x);
      foreach (Handler x in list) if (!x.Rec) sorted.Add(x);
      return sorted;
    }

    /// An app's icon as base64 PNG: a classic "file,index" location through SHDefExtractIcon, a
    /// Store app's "@{...}" resource through SHLoadIndirectString to its PNG asset.
    static string IconAt(string loc, int idx) {
      if (string.IsNullOrEmpty(loc)) return null;
      try {
        if (loc.StartsWith("@", StringComparison.Ordinal)) {
          var sb = new StringBuilder(1024);
          if (FN.SHLoadIndirectString(loc, sb, (uint)sb.Capacity, IntPtr.Zero) != 0) return null;
          string f = sb.ToString();
          if (!File.Exists(f) || new FileInfo(f).Length > 200000) return null;
          return Convert.ToBase64String(File.ReadAllBytes(f));
        }
        IntPtr large, small;
        if (FN.SHDefExtractIconW(Environment.ExpandEnvironmentVariables(loc), idx, 0, out large, out small, (16u << 16) | 32u) != 0) return null;
        try { int w, h; return FN.IconPng(large, out w, out h); }
        finally { if (large != IntPtr.Zero) FN.DestroyIcon(large); if (small != IntPtr.Zero) FN.DestroyIcon(small); }
      } catch (Exception) { return null; }
    }

    static void ReleaseAll(List<Handler> hs) { foreach (Handler x in hs) FN.Release(x.H); }

    static string Handlers(Dictionary<string, object> req, ref object result) {
      string path = Json.GetString(req, "path");
      if (!FN.IsAbsolute(path)) return "files.handlers needs path: an absolute path";
      string ext = Path.GetExtension(path);
      result = OnShellThread(req, "files.handlers", delegate (out object res) {
        List<Handler> hs = EnumHandlers(ext, true);
        try {
          var list = new List<object>();
          foreach (Handler x in hs) list.Add(Json.Obj("handler", x.Name, "name", x.Ui, "icon", x.Icon, "recommended", x.Rec));
          res = Json.Obj("handlers", list);
          return null;
        } finally { ReleaseAll(hs); }
      });
      return null;
    }

    static string OpenWith(Dictionary<string, object> req, ref object result) {
      string refuse = FilesGuard.AlwaysRefusedInPassive("files.openwith (it would start an app)");
      if (refuse != null) return refuse;
      string path = Json.GetString(req, "path"), handler = Json.GetString(req, "handler");
      if (!FN.IsAbsolute(path) || string.IsNullOrEmpty(handler)) return "files.openwith needs path and handler";
      result = OnShellThread(req, "files.openwith", delegate (out object res) {
        res = null;
        List<Handler> hs = EnumHandlers(Path.GetExtension(path), false);
        object item = null, data = null;
        try {
          Handler pick = null;
          foreach (Handler x in hs) if (string.Equals(x.Name, handler, StringComparison.OrdinalIgnoreCase)) { pick = x; break; }
          if (pick == null) return "files.openwith: that app no longer opens this type";
          int hr;
          item = FN.ItemFromPath(path, out hr);
          if (item == null) return "files.openwith: " + FN.HrWords(hr);
          Guid bhid = FN.BHID_DataObject, iid = FN.IID_IDataObject;
          hr = ((FN.IShellItem)item).BindToHandler(IntPtr.Zero, ref bhid, ref iid, out data);
          if (hr != 0 || data == null) return "files.openwith: " + FN.HrWords(hr);
          hr = pick.H.Invoke(data);
          if (hr < 0) return "files.openwith: " + FN.HrWords(hr);
          res = Json.Obj("ok", true);
          return null;
        } finally { FN.Release(data); FN.Release(item); ReleaseAll(hs); }
      });
      return null;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct OPENASINFO {
      [MarshalAs(UnmanagedType.LPWStr)] public string pcszFile;
      [MarshalAs(UnmanagedType.LPWStr)] public string pcszClass;
      public int oaifInFlags;
    }
    [DllImport("shell32.dll")]
    static extern int SHOpenWithDialog(IntPtr hwnd, ref OPENASINFO info);

    /// The dialog is MODAL, so it gets its own STA thread and the command answers once it is up
    /// (or at once with the reason if it failed to open within 400 ms).
    static string OpenWithDialog(Dictionary<string, object> req, ref object result) {
      string refuse = FilesGuard.AlwaysRefusedInPassive("files.openwithdialog (it would open a Windows dialog)");
      if (refuse != null) return refuse;
      string path = Json.GetString(req, "path");
      if (!FN.IsAbsolute(path)) return "files.openwithdialog needs path: an absolute path";
      IntPtr owner = Json.GetHwnd(req, "owner");
      int hr = 0;
      bool done = false;
      var t = new Thread(delegate () {
        var info = new OPENASINFO();
        info.pcszFile = path;
        info.oaifInFlags = 0x1 | 0x2 | 0x4;   // OAIF_ALLOW_REGISTRATION | OAIF_REGISTER_EXT | OAIF_EXEC, as Explorer
        try { hr = SHOpenWithDialog(owner, ref info); } catch (Exception ex) { hr = Marshal.GetHRForException(ex); }
        done = true;
        if (hr < 0 && hr != unchecked((int)0x800704C7))
          Program.EmitLog("warn", "files.openwithdialog: the dialog failed (" + FN.HrWords(hr) + ")");
      });
      t.IsBackground = true;
      t.Name = "mantle-files-openwith";
      t.SetApartmentState(ApartmentState.STA);
      t.Start();
      t.Join(400);
      if (done && hr < 0 && hr != unchecked((int)0x800704C7)) return "files.openwithdialog: " + FN.HrWords(hr);
      result = Json.Obj("ok", true, "open", !done);
      return null;
    }

    // ------------------------------------------------------------------ clipboard

    static string ClipGet(Dictionary<string, object> req, ref object result) {
      result = OnShellThread(req, "files.clip.get", delegate (out object res) {
        res = null;
        for (int attempt = 0; ; attempt++) {
          try {
            var paths = new List<object>();
            bool cut = false;
            if (System.Windows.Forms.Clipboard.ContainsFileDropList()) {
              foreach (string p in System.Windows.Forms.Clipboard.GetFileDropList()) paths.Add(p);
              var ms = System.Windows.Forms.Clipboard.GetData("Preferred DropEffect") as MemoryStream;
              if (ms != null && ms.Length >= 4) {
                var b = new byte[4];
                ms.Position = 0; ms.Read(b, 0, 4);
                int effect = BitConverter.ToInt32(b, 0);
                cut = (effect & 2) != 0 && (effect & 1) == 0;   // DROPEFFECT_MOVE without COPY
              }
            }
            res = Json.Obj("paths", paths, "cut", cut);
            return null;
          } catch (ExternalException ex) {
            // Another app holds the clipboard open for a moment: retry briefly, then say so.
            if (attempt >= 4) return "files.clip.get: the clipboard is busy (" + FN.HrWords(ex.ErrorCode) + ")";
            Thread.Sleep(40);
          }
        }
      });
      return null;
    }

    static string ClipSet(Dictionary<string, object> req, ref object result) {
      string refuse = FilesGuard.AlwaysRefusedInPassive("files.clip.set (it would replace the clipboard)");
      if (refuse != null) return refuse;
      List<string> paths = FN.StringList(req, "paths");
      if (paths.Count == 0) return "files.clip.set needs paths";
      foreach (string p in paths) if (!FN.IsAbsolute(p)) return "files.clip.set: every path must be absolute";
      bool cut = Json.GetBool(req, "cut", false);
      result = OnShellThread(req, "files.clip.set", delegate (out object res) {
        res = null;
        var sc = new StringCollection();
        foreach (string p in paths) sc.Add(p);
        var d = new System.Windows.Forms.DataObject();
        d.SetFileDropList(sc);
        // 5 = DROPEFFECT_COPY|LINK (Explorer's copy), 2 = DROPEFFECT_MOVE (cut).
        d.SetData("Preferred DropEffect", new MemoryStream(BitConverter.GetBytes(cut ? 2 : 5)));
        try { System.Windows.Forms.Clipboard.SetDataObject(d, true, 5, 60); }
        catch (ExternalException ex) { return "files.clip.set: the clipboard is busy (" + FN.HrWords(ex.ErrorCode) + ")"; }
        res = Json.Obj("ok", true, "count", paths.Count, "cut", cut);
        return null;
      });
      return null;
    }
  }
}

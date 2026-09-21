// Shortcuts.cs - `lnk`: what does this .lnk actually point at?
//
// WHY THE SIDECAR AND NOT NODE: a Windows shortcut is not a text file. It is a
// serialised COM object, and the only supported reader is IShellLinkW +
// IPersistFile. Electron's shell.readShortcutLink exists but stops exactly
// where the Start menu gets interesting: it cannot tell you the App User Model
// ID, so every Store/UWP pin comes back as an empty target and Mantle's
// launcher would show a nameless, unlaunchable tile.
//
// So this reads THREE ways, because a shortcut has three ways of saying what it
// points at: the classic fields (target, arguments, working directory, icon)
// through IShellLinkW; the item list, for links that store a pidl and no path
// at all (the pinned File Explorer is one, and GetPath answers "" for it); and
// PKEY_AppUserModel_ID through the property system, for Store pins. A classic
// shortcut answers with a file target and aumid:null, a UWP pin with an aumid,
// an IDList link with a parsing name like "::{20D04FE0-...}" and a picture in
// iconPng. All three are a success.
//
// EVERY CALL HERE IS READ-ONLY. IPersistFile::Load is opened STGM_READ and
// nothing ever calls Save, because these files are the user's real Start menu.
//
// FAILURE IS PER ITEM, never per command: the launcher scans hundreds of links
// and one corrupt or denied file must not cost the caller the other 299. A bad
// entry comes back ok:false with a reason in plain words, in its original
// position in the array.
using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace Mantle {

  /// CLSID_ShellLink. `new ShellLink()` compiles to CoCreateInstance.
  [ComImport, Guid("00021401-0000-0000-C000-000000000046")]
  class ShellLink { }

  /// IShellLinkW, in vtable order - the ORDER IS THE CONTRACT. A method in the
  /// wrong place does not fail to compile, it calls the wrong function pointer
  /// and corrupts the stack, so this list matches ShObjIdl.h exactly even
  /// though we only call five of them.
  [ComImport, InterfaceType(ComInterfaceType.InterfaceIsIUnknown),
   Guid("000214F9-0000-0000-C000-000000000046")]
  interface IShellLinkW {
    void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder file, int cch, IntPtr findData, uint flags);
    void GetIDList(out IntPtr ppidl);
    void SetIDList(IntPtr pidl);
    void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder name, int cch);
    void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string name);
    void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder dir, int cch);
    void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string dir);
    void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder args, int cch);
    void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string args);
    void GetHotkey(out short hotkey);
    void SetHotkey(short hotkey);
    void GetShowCmd(out int showCmd);
    void SetShowCmd(int showCmd);
    void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder iconPath, int cch, out int iconIndex);
    void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string iconPath, int iconIndex);
    void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string pathRel, uint reserved);
    void Resolve(IntPtr hwnd, uint flags);
    void SetPath([MarshalAs(UnmanagedType.LPWStr)] string file);
  }

  static class Shortcuts {
    /// PKEY_AppUserModel_ID = {9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3}, pid 5.
    static readonly Guid PkeyAppUserModelFmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3");
    static readonly Guid IidPropertyStore = new Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99");

    const int Buf = 1040;   // MAX_PATH doubled: long targets and long arg lines

    /// One item per input path, in the same order, always the same shape.
    public static List<object> Resolve(IList paths) {
      var items = new List<object>();
      string comWhy = EnsureCom();
      foreach (object o in paths) {
        string p = o as string;
        if (p == null && o != null) p = Convert.ToString(o, System.Globalization.CultureInfo.InvariantCulture);
        items.Add(One(p, comWhy));
      }
      return items;
    }

    /// Never throws: whatever goes wrong becomes this item's `reason`.
    static IDictionary One(string path, string comWhy) {
      string reason = null;
      string target = "", args = "", workdir = "", iconPath = "";
      int iconIndex = 0;
      string aumid = null, iconPng = null;

      string full = path;
      if (string.IsNullOrEmpty(path)) {
        reason = "no path given";
      } else if (comWhy != null) {
        reason = comWhy;
      } else {
        full = Expand(path);
        if (!File.Exists(full)) {
          reason = "no such file";
        } else {
          object com = null;
          try {
            com = new ShellLink();
            var link = (IShellLinkW)com;
            // STGM_READ: this must never be able to rewrite the user's Start menu.
            ((System.Runtime.InteropServices.ComTypes.IPersistFile)com).Load(full, Win32.STGM_READ);

            var sb = new StringBuilder(Buf);
            // SLGP_RAWPATH: the path AS STORED. The alternative (SLGP_UNCPRIORITY
            // / a plain GetPath) lets the shell go hunting for a target that has
            // moved, which can block for seconds on a dead network share - with
            // hundreds of links to read, that is the whole command hanging.
            link.GetPath(sb, sb.Capacity, IntPtr.Zero, Win32.SLGP_RAWPATH);
            target = Expand(sb.ToString());

            sb.Length = 0;
            link.GetArguments(sb, sb.Capacity);
            args = sb.ToString();

            sb.Length = 0;
            link.GetWorkingDirectory(sb, sb.Capacity);
            workdir = Expand(sb.ToString());

            sb.Length = 0;
            link.GetIconLocation(sb, sb.Capacity, out iconIndex);
            iconPath = Expand(sb.ToString());

            aumid = ReadAumid(com, full);

            // THE PINNED "File Explorer" CASE, and it is not rare: a shortcut
            // does not have to point at a FILE. Owen's own taskbar pin stores
            // only an IDList, so GetPath answers "" and a launcher built on
            // GetPath alone shows a blank, unlaunchable tile. The item list is
            // the real identity of such a link, so ask the shell what it names
            // and what it looks like.
            if (target.Length == 0) target = FromIDList(link, out iconPng);
            // A file-backed link gets its picture the ordinary way: SHGetFileInfo
            // on the .lnk resolves to the target's icon, and Icons caches per
            // path, so a scan of hundreds costs one extraction each.
            if (iconPng == null && target.Length > 0) iconPng = Icons.ForPath(full);

            // A link with no target, no app id and no icon resolved to nothing a
            // caller could use. Say so rather than handing back blanks.
            if (target.Length == 0 && string.IsNullOrEmpty(aumid))
              reason = "the shortcut has no file target, no item list and no app id " +
                       "(it may point at a dead target)";
          } catch (Exception ex) {
            reason = Describe(ex);
          } finally {
            if (com != null) { try { Marshal.FinalReleaseComObject(com); } catch (Exception) { } }
          }
        }
      }

      // The shape NEVER changes, ok or not: a caller indexes fields, it should
      // not have to guard every one of them.
      return Json.Obj(
        "path", path,
        "ok", reason == null,
        "reason", reason,
        "target", target,
        "args", args,
        "workdir", workdir,
        "iconPath", iconPath,
        "iconIndex", iconIndex,
        // A ready-to-render 32x32 PNG data URL, or null. Present on EVERY item
        // so a caller can prefer it over iconPath/iconIndex without checking
        // which kind of shortcut it is holding.
        "iconPng", iconPng,
        "aumid", aumid);
    }

    /// The shell's own name for a link that stores an item list instead of a
    /// path - "::{20D04FE0-3AEA-1069-A2D8-08002B30309D}" for This PC, a
    /// "shell:" path for a virtual folder. SIGDN_DESKTOPABSOLUTEPARSING is the
    /// form that can be handed back to the shell to open the thing again.
    ///
    /// The icon comes from the SAME pidl, because there is no path to ask
    /// about: SHGetFileInfo with SHGFI_PIDL is the only way in.
    static string FromIDList(IShellLinkW link, out string iconPng) {
      iconPng = null;
      IntPtr pidl = IntPtr.Zero;
      try {
        link.GetIDList(out pidl);
        if (pidl == IntPtr.Zero) return "";

        string name = "";
        IntPtr namePtr = IntPtr.Zero;
        try {
          if (Win32.SHGetNameFromIDList(pidl, Win32.SIGDN_DESKTOPABSOLUTEPARSING, out namePtr) == Win32.S_OK &&
              namePtr != IntPtr.Zero)
            name = Marshal.PtrToStringUni(namePtr) ?? "";
        } finally {
          if (namePtr != IntPtr.Zero) Win32.CoTaskMemFree(namePtr);
        }

        var info = new Win32.SHFILEINFO();
        IntPtr res = Win32.SHGetFileInfoPidl(pidl, 0, ref info,
          (uint)Marshal.SizeOf(typeof(Win32.SHFILEINFO)),
          Win32.SHGFI_PIDL | Win32.SHGFI_ICON | Win32.SHGFI_LARGEICON);
        if (res != IntPtr.Zero && info.hIcon != IntPtr.Zero) {
          try { iconPng = Icons.FromHIcon(info.hIcon); }
          finally {
            // Icon.FromHandle does not own the handle; leaking these exhausts
            // the desktop heap after a few thousand.
            try { Win32.DestroyIcon(info.hIcon); } catch (Exception) { }
          }
        }
        return name;
      } catch (Exception) {
        return "";   // no item list either: the caller reports "nothing to launch"
      } finally {
        // GetIDList hands over ownership of a task-allocator block.
        if (pidl != IntPtr.Zero) { try { Win32.CoTaskMemFree(pidl); } catch (Exception) { } }
      }
    }

    /// The App User Model ID, or null when the link has none (every classic
    /// shortcut). Tried twice: the loaded link's own property store first
    /// (authoritative and already in memory), then the shell's store for the
    /// file, which is what answers for some Start-menu pins.
    static string ReadAumid(object com, string full) {
      string v = FromStore(com as Win32.IPropertyStore);
      if (!string.IsNullOrEmpty(v)) return v;

      Win32.IPropertyStore store = null;
      try {
        Guid iid = IidPropertyStore;
        int hr = Win32.SHGetPropertyStoreFromParsingName(full, IntPtr.Zero, Win32.GPS_DEFAULT, ref iid, out store);
        if (hr == Win32.S_OK && store != null) v = FromStore(store);
      } catch (Exception) {
        // Not being able to ask is not a failure of the shortcut; a classic
        // .lnk simply has no app id and this is the second of two tries.
      } finally {
        if (store != null) { try { Marshal.FinalReleaseComObject(store); } catch (Exception) { } }
      }
      return string.IsNullOrEmpty(v) ? null : v;
    }

    static string FromStore(Win32.IPropertyStore store) {
      if (store == null) return null;
      var key = new Win32.PROPERTYKEY();
      key.fmtid = PkeyAppUserModelFmtid;
      key.pid = 5;
      var pv = new Win32.PROPVARIANT();
      try {
        store.GetValue(ref key, out pv);
        if (pv.p == IntPtr.Zero) return null;
        if (pv.vt == Win32.VT_LPWSTR) return Marshal.PtrToStringUni(pv.p);
        if (pv.vt == Win32.VT_BSTR) return Marshal.PtrToStringBSTR(pv.p);
        return null;
      } catch (Exception) {
        return null;
      } finally {
        // The string belongs to COM; without this every scan leaks one per link.
        try { Win32.PropVariantClear(ref pv); } catch (Exception) { }
      }
    }

    static string Expand(string s) {
      if (string.IsNullOrEmpty(s)) return "";
      if (s.IndexOf('%') < 0) return s;
      try { return Environment.ExpandEnvironmentVariables(s); } catch (Exception) { return s; }
    }

    /// Whatever COM said, in words plus the HRESULT - "0x80070002" is
    /// searchable, "the operation failed" is not.
    static string Describe(Exception ex) {
      var ce = ex as COMException;
      if (ce != null)
        return "the shell could not read this shortcut: " + ce.Message.Trim() +
               " (HRESULT 0x" + ce.ErrorCode.ToString("X8") + ")";
      if (ex is UnauthorizedAccessException) return "access denied reading this shortcut";
      if (ex is FileNotFoundException) return "no such file";
      return ex.GetType().Name + ": " + ex.Message;
    }

    /// COM must be up, and it must be an STA: the shell's link objects are
    /// apartment-threaded. Program.Main is [STAThread] and every command runs
    /// on that thread, so this is nearly always a no-op - it exists so that a
    /// future caller from another thread gets a working apartment instead of a
    /// mystery E_NOINTERFACE. Returns null when COM is usable, or the reason.
    static string EnsureCom() {
      try {
        if (Thread.CurrentThread.GetApartmentState() == ApartmentState.STA) return null;
        int hr = Win32.CoInitializeEx(IntPtr.Zero, Win32.COINIT_APARTMENTTHREADED);
        if (hr == Win32.S_OK || hr == Win32.S_FALSE || hr == Win32.RPC_E_CHANGED_MODE) return null;
        return "COM could not be started on this thread (HRESULT 0x" + hr.ToString("X8") +
               "), so shortcuts cannot be read";
      } catch (Exception ex) {
        return "COM could not be started on this thread (" + ex.Message + "), so shortcuts cannot be read";
      }
    }
  }
}

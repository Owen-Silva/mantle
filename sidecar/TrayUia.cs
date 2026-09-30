// TrayUia.cs - the Windows 11 notification area, read WITHOUT the legacy toolbar.
//
// WHY THIS FILE EXISTS. Tray.cs reads the classic ToolbarWindow32 inside
// TrayNotifyWnd. On Windows 11 25H2 and 26H2 (builds 26200/26300, this machine) that toolbar is
// gone: TrayNotifyWnd is an empty HWND and the icons are XAML buttons inside
// the taskbar's DesktopWindowContentBridge. Tray.cs falls back to this file when
// it finds no legacy toolbar, and the Electron side gets the same {id, tooltip,
// icon} list it always did.
//
// THREE READ-ONLY SOURCES, because no single one is enough (all measured
// 2026-09-22 on build 26200, taskbar on auto-hide and currently slid away):
//
//   1. HKCU\Control Panel\NotifyIconSettings\<n>  - explorer's own record of
//      every tray icon it has EVER seen (41 keys here, most of them for apps
//      that are not running): ExecutablePath, UID or IconGuid, InitialTooltip,
//      IconSnapshot (a real PNG, 16-32 px, the icon as explorer last drew it)
//      and IsPromoted. This is what gives the bar real pictures. It does NOT say
//      which icons exist right now.
//
//   2. Shell_NotifyIconGetRect (documented shell32 API) - "where is the icon
//      with this identity?". It answers S_OK only for an icon that is in the
//      tray RIGHT NOW, so it is the presence test for every registry entry:
//      GUID icons are asked by GUID alone; UID icons by (owner window, UID),
//      trying the top-level and message-only windows of processes whose exe
//      matches the entry. For a HIDDEN icon (in the "Show hidden icons" flyout)
//      it answers the chevron's rectangle - measured: all five hidden icons
//      here returned 1380,1078,1420,1138, the chevron's own box. 7 of 41 entries
//      were present; an uncached pass took ~50 ms, almost all of it ~250
//      probes into explorer's 125 windows for two ABSENT explorer icons - see
//      the probe cache below, which brings a warm listing to ~12 ms.
//
//   3. UI Automation over the XAML island - the ONLY route to a click. Each
//      promoted icon is a Button (ClassName SystemTray.NormalButton,
//      AutomationId NotifyItemIcon) whose Name is the icon's LIVE tooltip and
//      which supports InvokePattern. Matching a registry icon to its button is
//      by rectangle: GetRect and UIA report the same physical coordinates (the
//      sidecar is per-monitor-v2 DPI aware), including while the taskbar is
//      slid away on auto-hide (y=1078 on a 1080-px screen, IsOffscreen=False).
//      We match on X only, so a taskbar sliding between the two reads cannot
//      break the match.
//
// WHAT IS NOT REACHABLE, AND WHY (measured, not assumed):
//   - HIDDEN icons cannot be clicked. The hidden-icons flyout is a separate
//     XAML window that does not exist until the user opens it (no
//     TopLevelWindowForOverflowXamlIsland / NotifyIconOverflowWindow here), and
//     opening it is an action on the real screen. We list those icons (from 1
//     and 2) and say, per icon, why they are not clickable and how to fix it:
//     turning the app On under Settings > Personalization > Taskbar > Other
//     system tray icons promotes it onto the taskbar, where UIA can reach it.
//   - RIGHT-CLICK menus are not reachable. The tray buttons expose Invoke and
//     ScrollItem only - no context-menu action - and the keyboard route
//     (Shift+F10 on a focused button) needs focus in the taskbar.
//   - ITrayNotify (CLSID_TrayNotify, the private COM API the old "Notification
//     Area Icons" control panel used) is INERT on this build: it creates, and
//     RegisterCallback answers S_OK, but no item callback ever arrives (tried
//     MTA and a pumping STA, 1.5 s each). So it is not used.
//
// EVERYTHING HERE IS READ-ONLY except Click, which only ever calls
// InvokePattern.Invoke on explorer's own button (what a screen reader does) -
// never a synthetic mouse event, never a focus change. Program.cs refuses
// trayClick in --passive, so a test run cannot click anything.
//
// C# 5 (see build.ps1): no string interpolation, no ?., no nameof.
// The UI Automation half compiles only with /define:MANTLE_UIA plus
// references to UIAutomationClient, UIAutomationTypes and WindowsBase (all in
// Framework64\v4.0.30319\WPF, shipped with Windows). Without them the list
// still works (sources 1 and 2) and every icon says why it cannot be clicked.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32;
#if MANTLE_UIA
using System.Windows.Automation;
#endif

namespace Mantle {
  static class TrayUia {
    /// Ids this file hands out: "n:<registry key>" for an icon explorer has a
    /// NotifyIconSettings entry for (stable for as long as the app keeps the
    /// same exe path and UID/GUID), "u:<UIA runtime id>" for a promoted button
    /// with no matching entry (stable only while explorer keeps that button).
    const string KeyPrefix = "n:";
    const string UiaPrefix = "u:";
    const string SettingsKey = @"Control Panel\NotifyIconSettings";
    const string SettingsPath = "Settings > Personalization > Taskbar > Other system tray icons";
    const string BridgeClass = "Windows.UI.Composition.DesktopWindowContentBridge";

    /// A UID icon is asked for once per window of its exe. Explorer alone owns
    /// ~55 top-level windows here; this bounds the worst case per icon.
    const int MaxProbesPerIcon = 160;

    const uint WM_NULL = 0x0000;
    const uint SMTO_ABORTIFHUNG = 0x0002;
    const uint ExplorerAnswerMs = 1000;
    static readonly IntPtr HWND_MESSAGE = new IntPtr(-3);

    [StructLayout(LayoutKind.Sequential)]
    struct NOTIFYICONIDENTIFIER {
      public uint cbSize;
      public IntPtr hWnd;
      public uint uID;
      public Guid guidItem;
    }

    [DllImport("shell32.dll")]
    static extern int Shell_NotifyIconGetRect(ref NOTIFYICONIDENTIFIER identifier, out Win32.RECT iconLocation);

    [DllImport("shell32.dll")]
    static extern int SHGetKnownFolderPath(ref Guid rfid, uint flags, IntPtr token, out IntPtr path);

    /// One NotifyIconSettings entry, parsed.
    class Entry {
      public string Key;
      public string Exe;          // resolved to a real path ({known-folder GUID}\rest expanded)
      public bool HasGuid;
      public Guid IconGuid;
      public bool HasUid;
      public uint Uid;
      public string InitialTooltip;
      public byte[] Snapshot;
    }

    /// One icon that is in the tray right now.
    class Present {
      public string Id;
      public Entry Entry;         // null for a UIA button with no registry entry
      public IntPtr Owner;        // UID icons: the window that owns it
      public Win32.RECT Rect;     // from Shell_NotifyIconGetRect (or UIA, for "u:" ids)
      public bool Promoted;
      public string LiveTooltip;  // UIA Name, promoted icons only
    }

    /// id -> what Click needs to find the icon again. Replaced by every List().
    static Dictionary<string, Present> _last = new Dictionary<string, Present>(StringComparer.Ordinal);
    static readonly object _lock = new object();

    // Caches that are safe to keep for the life of the process: a known
    // folder's path, an exe's description, and a snapshot's data URL (keyed by
    // the registry key AND a hash of the bytes, so a changed icon is re-encoded).
    static readonly Dictionary<Guid, string> _folders = new Dictionary<Guid, string>();
    static readonly Dictionary<string, string> _descriptions = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
    static readonly Dictionary<string, string> _snapshotUrls = new Dictionary<string, string>(StringComparer.Ordinal);

    public static bool Owns(string id) {
      return id != null && (id.StartsWith(KeyPrefix, StringComparison.Ordinal) || id.StartsWith(UiaPrefix, StringComparison.Ordinal));
    }

    // ------------------------------------------------------------------ list

    /// The tray as [{id, tooltip, title, icon, exe, promoted, clickable, reason}].
    /// `tooltip` and `icon` are the legacy shape; `title` is what ui/bar reads
    /// for the hover text and the letter fallback. Throws
    /// InvalidOperationException with a plain reason (no "tray unavailable:"
    /// prefix - Tray.cs adds that) only when NOTHING could be read.
    public static List<object> List() {
      IntPtr tray = CheckExplorer();

      string regWhy;
      List<Entry> entries = ReadRegistry(out regWhy);

      var present = new List<Present>();
      if (entries != null) FindPresent(entries, present);

      string uiaWhy;
      List<Button> buttons = CachedButtons(tray, present, out uiaWhy);

      if (entries == null && buttons == null)
        throw new InvalidOperationException(regWhy + "; and " + uiaWhy);

      // Match each present icon to the promoted button under it.
      var claimed = new HashSet<Button>();
      foreach (Present p in present) {
        Button b = ButtonAt(buttons, p.Rect);
        if (b == null) continue;
        p.Promoted = true;
        p.LiveTooltip = b.Name;
        claimed.Add(b);
      }
      // A promoted button no registry entry accounted for still goes on the
      // bar: it is real, it is clickable, it just has no picture.
      if (buttons != null) {
        foreach (Button b in buttons) {
          if (claimed.Contains(b)) continue;
          present.Add(new Present {
            Id = UiaPrefix + b.RuntimeId, Promoted = true, LiveTooltip = b.Name,
            Rect = new Win32.RECT { left = (int)b.Left, right = (int)b.Right }
          });
        }
      }

      // Promoted icons in taskbar order (left to right), then the hidden ones
      // alphabetically, so the bar does not reshuffle between polls.
      present.Sort(delegate (Present a, Present b) {
        if (a.Promoted != b.Promoted) return a.Promoted ? -1 : 1;
        if (a.Promoted) return a.Rect.left.CompareTo(b.Rect.left);
        int c = string.Compare(TitleOf(a), TitleOf(b), StringComparison.OrdinalIgnoreCase);
        return c != 0 ? c : string.CompareOrdinal(a.Id, b.Id);
      });

      var result = new List<object>();
      var map = new Dictionary<string, Present>(StringComparer.Ordinal);
      foreach (Present p in present) {
        if (map.ContainsKey(p.Id)) continue;
        map[p.Id] = p;
        string title = TitleOf(p);
        string why = p.Promoted ? (buttons == null ? uiaWhy : null) : HiddenReason(title, buttons == null ? uiaWhy : null);
        result.Add(Json.Obj(
          "id", p.Id,
          "tooltip", title,
          "title", title,
          "icon", IconOf(p.Entry),
          "exe", p.Entry != null ? p.Entry.Exe : null,
          // null = unknown: without UIA there is no telling a promoted icon from a hidden one
          "promoted", buttons == null ? (object)null : p.Promoted,
          "clickable", why == null,
          "reason", why));
      }
      lock (_lock) _last = map;
      return result;
    }

    /// Shell_TrayWnd, after proving explorer answers at all. Every probe below
    /// is a synchronous round trip into explorer; a hung explorer must cost us
    /// one second and a reason, not a wedged slow lane.
    static IntPtr CheckExplorer() {
      IntPtr tray = Win32.FindWindowW("Shell_TrayWnd", null);
      if (tray == IntPtr.Zero)
        throw new InvalidOperationException("no Shell_TrayWnd window (explorer is not running the shell)");
      IntPtr ignored;
      if (Win32.SendMessageTimeoutW(tray, WM_NULL, IntPtr.Zero, IntPtr.Zero, SMTO_ABORTIFHUNG, ExplorerAnswerMs, out ignored) == IntPtr.Zero)
        throw new InvalidOperationException("explorer's taskbar did not answer within " + ExplorerAnswerMs +
          " ms (explorer is busy or hung), so its tray icons cannot be asked for");
      return tray;
    }

    // The UIA read is the dearest part of a listing (measured on the loaded
    // machine, 2026-09-22: ~60 ms warm, ~420 ms for the first call in a
    // process; registry 2-3 ms, presence ~50 ms) and main polls every 5 s.
    // So the button list is reused while the tray's LAYOUT is unchanged: the
    // X spans Shell_NotifyIconGetRect gave every present icon. Promoting,
    // hiding, adding or removing an icon moves the chevron or a neighbour, so
    // it changes the fingerprint and forces a fresh read; Y is left out so the
    // taskbar sliding on auto-hide does not. The age cap bounds how stale a
    // promoted icon's LIVE tooltip can get. Click never uses this cache.
    const int ButtonsMaxAgeMs = 15000;
    static List<Button> _buttons;
    static string _buttonsWhy;
    static string _buttonsPrint;
    static int _buttonsTick;

    static List<Button> CachedButtons(IntPtr tray, List<Present> present, out string why) {
      var parts = new List<string>();
      foreach (Present p in present)
        parts.Add(p.Id + "@" + p.Rect.left.ToString(CultureInfo.InvariantCulture) + "-" + p.Rect.right.ToString(CultureInfo.InvariantCulture));
      parts.Sort(StringComparer.Ordinal);
      string print = tray.ToInt64().ToString(CultureInfo.InvariantCulture) + "|" + string.Join(",", parts.ToArray());
      lock (_lock) {
        if (_buttonsPrint == print && unchecked(Environment.TickCount - _buttonsTick) < ButtonsMaxAgeMs) {
          why = _buttonsWhy;
          return _buttons;
        }
      }
      List<Button> fresh = ReadButtons(tray, out why);
      lock (_lock) {
        _buttons = fresh;
        _buttonsWhy = why;
        _buttonsPrint = print;
        _buttonsTick = Environment.TickCount;
      }
      return fresh;
    }

    static string HiddenReason(string title, string uiaWhy) {
      if (uiaWhy != null) return uiaWhy;
      return title + " is in Windows' hidden-icons flyout, which only exists while that flyout is open, and Mantle never opens it " +
        "on your screen. Turn " + title + " On under " + SettingsPath + " and Mantle can click it (your own taskbar stays auto-hidden).";
    }

    // -------------------------------------------------------------- registry

    static List<Entry> ReadRegistry(out string why) {
      why = null;
      var list = new List<Entry>();
      try {
        using (RegistryKey root = Registry.CurrentUser.OpenSubKey(SettingsKey)) {
          if (root == null) { why = "HKCU\\" + SettingsKey + " does not exist (explorer has never recorded a tray icon for this user)"; return null; }
          foreach (string name in root.GetSubKeyNames()) {
            try {
              using (RegistryKey k = root.OpenSubKey(name)) {
                if (k == null) continue;
                var e = new Entry { Key = name };
                e.Exe = ResolvePath(k.GetValue("ExecutablePath") as string);
                string g = k.GetValue("IconGuid") as string;
                if (!string.IsNullOrEmpty(g)) {
                  try { e.IconGuid = new Guid(g); e.HasGuid = true; } catch (FormatException) { }
                }
                object uid = k.GetValue("UID");
                if (uid is int) { e.Uid = unchecked((uint)(int)uid); e.HasUid = true; }
                e.InitialTooltip = k.GetValue("InitialTooltip") as string;
                e.Snapshot = k.GetValue("IconSnapshot") as byte[];
                if (e.HasGuid || e.HasUid) list.Add(e);
              }
            } catch (Exception ex) {
              Program.EmitLog("warn", "tray: skipped NotifyIconSettings\\" + name + ": " + ex.Message);
            }
          }
        }
      } catch (Exception ex) {
        why = "could not read HKCU\\" + SettingsKey + ": " + ex.Message;
        return null;
      }
      return list;
    }

    /// Explorer stores paths under a known folder as "{FOLDERID}\rest"
    /// (measured: ProgramFilesX64, ProgramFilesX86, Windows, System). Anything
    /// else is already a plain path.
    static string ResolvePath(string raw) {
      if (string.IsNullOrEmpty(raw) || raw[0] != '{') return raw;
      int close = raw.IndexOf('}');
      if (close < 0) return raw;
      Guid id;
      try { id = new Guid(raw.Substring(0, close + 1)); } catch (FormatException) { return raw; }
      string folder;
      lock (_folders) {
        if (!_folders.TryGetValue(id, out folder)) {
          IntPtr p;
          folder = null;
          if (SHGetKnownFolderPath(ref id, 0, IntPtr.Zero, out p) == 0) folder = Marshal.PtrToStringUni(p);
          if (p != IntPtr.Zero) Marshal.FreeCoTaskMem(p);
          _folders[id] = folder;
        }
      }
      if (folder == null) return raw;
      string rest = raw.Substring(close + 1).TrimStart('\\');
      return Path.Combine(folder, rest);
    }

    // -------------------------------------------------------------- presence

    static bool Probe(Entry e, IntPtr owner, out Win32.RECT rect) {
      var id = new NOTIFYICONIDENTIFIER();
      id.cbSize = (uint)Marshal.SizeOf(typeof(NOTIFYICONIDENTIFIER));
      if (e.HasGuid) id.guidItem = e.IconGuid;
      else { id.hWnd = owner; id.uID = e.Uid; }
      return Shell_NotifyIconGetRect(ref id, out rect) == 0;
    }

    static void FindPresent(List<Entry> entries, List<Present> present) {
      // Windows are only worth listing for exes that own a UID icon.
      var wanted = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
      foreach (Entry e in entries) if (!e.HasGuid && e.HasUid && !string.IsNullOrEmpty(e.Exe)) wanted.Add(e.Exe);
      Dictionary<string, List<IntPtr>> windows = wanted.Count > 0 ? WindowsByExe(wanted) : null;

      foreach (Entry e in entries) {
        Win32.RECT rect;
        if (e.HasGuid) {
          if (Probe(e, IntPtr.Zero, out rect))
            present.Add(new Present { Id = KeyPrefix + e.Key, Entry = e, Rect = rect });
          continue;
        }
        List<IntPtr> hwnds;
        if (windows == null || string.IsNullOrEmpty(e.Exe) || !windows.TryGetValue(e.Exe, out hwnds)) continue;
        IntPtr owner = FindOwner(e, hwnds, out rect);
        if (owner != IntPtr.Zero)
          present.Add(new Present { Id = KeyPrefix + e.Key, Entry = e, Owner = owner, Rect = rect });
      }
    }

    // THE PROBE CACHE. A UID icon has to be asked for once per window of its
    // exe, and an ABSENT one costs a full sweep. Measured 2026-09-22: explorer
    // owns 125 top-level + message-only windows and has two absent UID entries
    // (StickyKeys and an old uid-0 icon), so every listing spent ~50 ms on
    // ~250 round trips into explorer to learn nothing new. So:
    //   - the window that owned an icon last time is asked first;
    //   - a window that said "not mine" is not asked again for 30 s. A NEW
    //     window (a freshly started app, an Electron tray host) is always
    //     asked at once, so a new app's icon still shows up on the next poll;
    //     only an icon added later by an OLD window can lag, by at most 30 s.
    const int SweepMaxAgeMs = 30000;
    class Sweep { public HashSet<IntPtr> Negative = new HashSet<IntPtr>(); public int Tick; }
    static readonly Dictionary<string, Sweep> _sweeps = new Dictionary<string, Sweep>(StringComparer.Ordinal);
    static readonly Dictionary<string, IntPtr> _owners = new Dictionary<string, IntPtr>(StringComparer.Ordinal);

    static IntPtr FindOwner(Entry e, List<IntPtr> hwnds, out Win32.RECT rect) {
      rect = new Win32.RECT();
      lock (_sweeps) {
        IntPtr last;
        if (_owners.TryGetValue(e.Key, out last) && hwnds.Contains(last) && Probe(e, last, out rect)) return last;
        _owners.Remove(e.Key);

        Sweep s;
        if (!_sweeps.TryGetValue(e.Key, out s) || unchecked(Environment.TickCount - s.Tick) >= SweepMaxAgeMs) {
          s = new Sweep { Tick = Environment.TickCount };
          _sweeps[e.Key] = s;
        }
        int tries = 0;
        foreach (IntPtr h in hwnds) {
          if (s.Negative.Contains(h)) continue;
          if (++tries > MaxProbesPerIcon) break;
          if (Probe(e, h, out rect)) {
            _owners[e.Key] = h;
            _sweeps.Remove(e.Key);
            return h;
          }
          s.Negative.Add(h);
        }
        return IntPtr.Zero;
      }
    }

    /// Top-level AND message-only windows, grouped by the exe of their process,
    /// for the exes in `wanted` only. Message-only windows matter: they are a
    /// common owner for a tray icon and EnumWindows never returns them.
    static Dictionary<string, List<IntPtr>> WindowsByExe(HashSet<string> wanted) {
      var byExe = new Dictionary<string, List<IntPtr>>(StringComparer.OrdinalIgnoreCase);
      var exeOfPid = new Dictionary<int, string>();
      Action<IntPtr> add = delegate (IntPtr h) {
        int pid;
        Win32.GetWindowThreadProcessId(h, out pid);
        string exe;
        if (!exeOfPid.TryGetValue(pid, out exe)) { exe = Win32.GetProcessPath(pid); exeOfPid[pid] = exe; }
        if (string.IsNullOrEmpty(exe) || !wanted.Contains(exe)) return;
        List<IntPtr> l;
        if (!byExe.TryGetValue(exe, out l)) { l = new List<IntPtr>(); byExe[exe] = l; }
        l.Add(h);
      };
      Win32.EnumWindowsProc cb = delegate (IntPtr h, IntPtr lp) { add(h); return true; };
      Win32.EnumWindows(cb, IntPtr.Zero);
      GC.KeepAlive(cb);
      IntPtr after = IntPtr.Zero;
      for (int guard = 0; guard < 8192; guard++) {
        after = Win32.FindWindowExW(HWND_MESSAGE, after, null, null);
        if (after == IntPtr.Zero) break;
        add(after);
      }
      return byExe;
    }

    // ------------------------------------------------------- names and icons

    static string TitleOf(Present p) {
      if (!string.IsNullOrEmpty(p.LiveTooltip)) return p.LiveTooltip.Trim();
      Entry e = p.Entry;
      if (e == null) return "tray icon";
      if (!string.IsNullOrEmpty(e.InitialTooltip)) return e.InitialTooltip.Trim();
      // Mantle's own tray icon is registered by a bare electron.exe with no
      // initial tooltip, so the exe would call it "Electron".
      if (p.Owner != IntPtr.Zero && Program.ParentPid > 0) {
        int pid;
        Win32.GetWindowThreadProcessId(p.Owner, out pid);
        if (pid == Program.ParentPid) return "Mantle";
      }
      // Explorer's own GUID icons (Bluetooth, Windows Update, ...) would all be
      // called "Windows Explorer" by the exe; say what we actually know.
      if (!string.IsNullOrEmpty(e.Exe) &&
          string.Equals(Path.GetFileName(e.Exe), "explorer.exe", StringComparison.OrdinalIgnoreCase))
        return "Windows system icon";
      return Describe(e.Exe);
    }

    static string Describe(string exe) {
      if (string.IsNullOrEmpty(exe)) return "tray icon";
      string d;
      lock (_descriptions) { if (_descriptions.TryGetValue(exe, out d)) return d; }
      d = null;
      try {
        if (File.Exists(exe)) {
          FileVersionInfo v = FileVersionInfo.GetVersionInfo(exe);
          d = !string.IsNullOrEmpty(v.FileDescription) ? v.FileDescription.Trim()
            : !string.IsNullOrEmpty(v.ProductName) ? v.ProductName.Trim() : null;
        }
      } catch (Exception) { }
      if (string.IsNullOrEmpty(d)) d = Path.GetFileNameWithoutExtension(exe);
      lock (_descriptions) _descriptions[exe] = d;
      return d;
    }

    /// The snapshot explorer drew (a PNG, measured 16-32 px), else the exe's
    /// own icon via Icons.ForPath, else null (the bar then shows a letter).
    static string IconOf(Entry e) {
      if (e == null) return null;
      byte[] s = e.Snapshot;
      bool png = s != null && s.Length > 8 && s[0] == 0x89 && s[1] == 0x50 && s[2] == 0x4E && s[3] == 0x47;
      if (png) {
        string tag = e.Key + ":" + s.Length.ToString(CultureInfo.InvariantCulture) + ":" + Fnv(s).ToString("x8", CultureInfo.InvariantCulture);
        string url;
        lock (_snapshotUrls) {
          if (!_snapshotUrls.TryGetValue(e.Key, out url) || !url.StartsWith(tag + "|", StringComparison.Ordinal)) {
            url = tag + "|data:image/png;base64," + Convert.ToBase64String(s);
            _snapshotUrls[e.Key] = url;
          }
        }
        return url.Substring(url.IndexOf('|') + 1);
      }
      return Icons.ForPath(e.Exe);
    }

    static uint Fnv(byte[] b) {
      uint h = 2166136261;
      for (int i = 0; i < b.Length; i++) { h ^= b[i]; h *= 16777619; }
      return h;
    }

    // ------------------------------------------------------------------ click

    /// null on success, else the reason in plain words. Left = UIA Invoke on
    /// the icon's taskbar button (explorer then delivers the click to the app
    /// exactly as it does for a screen reader). IMPLEMENTED, NOT EXERCISED in
    /// any test: invoking a real tray icon opens Owen's real apps.
    public static string Click(string id, string button) {
      if (button == "right")
        return "right-click menus of tray icons are not reachable on this Windows build: Windows 11 draws the notification area in XAML, " +
          "its tray buttons offer only a plain click (UI Automation Invoke) and no menu action, and opening the menu any other way " +
          "would need a real mouse click on your taskbar, which Mantle never does";

      Present p;
      lock (_lock) _last.TryGetValue(id, out p);
      if (p == null) {
        try { List(); } catch (Exception ex) { return "tray unavailable: " + ex.Message; }
        lock (_lock) _last.TryGetValue(id, out p);
        if (p == null) return "no tray icon with id " + id + " (it may have been removed since the last tray listing)";
      }
#if MANTLE_UIA
      try {
        IntPtr tray = CheckExplorer();
        // Re-read everything: the icon may have moved or been hidden since the
        // listing, and a UIA element from an earlier pass can be dead.
        Win32.RECT rect = p.Rect;
        if (p.Entry != null && !Probe(p.Entry, p.Owner, out rect))
          return TitleOf(p) + " is no longer in the notification area";
        string why;
        List<Button> buttons = ReadButtons(tray, out why);
        if (buttons == null) return why;
        Button b = null;
        if (p.Entry != null) b = ButtonAt(buttons, rect);
        else foreach (Button c in buttons) if (UiaPrefix + c.RuntimeId == id) { b = c; break; }
        if (b == null) return HiddenReason(TitleOf(p), null);
        object pattern;
        if (!b.Element.TryGetCurrentPattern(InvokePattern.Pattern, out pattern))
          return TitleOf(p) + "'s taskbar button offers no Invoke action, so Mantle cannot click it";
        ((InvokePattern)pattern).Invoke();
        return null;
      } catch (ElementNotAvailableException) {
        return TitleOf(p) + "'s taskbar button went away while Mantle was clicking it (explorer rebuilt the tray); try again";
      } catch (Exception ex) {
        return "clicking " + TitleOf(p) + " failed: " + ex.Message;
      }
#else
      return UiaMissing;
#endif
    }

    // ---------------------------------------------------------- UI Automation

    const string UiaMissing = "this sidecar was built without UI Automation (build.ps1 passed no /define:MANTLE_UIA and no " +
      "UIAutomationClient references), so Mantle can list tray icons but cannot click them";

    // Without MANTLE_UIA nothing ever fills a Button, and csc would warn so.
#pragma warning disable 0649
    class Button {
      public string Name;
      public double Left, Right;
      public string RuntimeId;
#if MANTLE_UIA
      public AutomationElement Element;
#endif
    }
#pragma warning restore 0649

    /// The promoted button whose horizontal span holds the centre of `r`, or
    /// null (a hidden icon's rectangle is the chevron's, which is not a
    /// NotifyItemIcon, so hidden icons never match).
    static Button ButtonAt(List<Button> buttons, Win32.RECT r) {
      if (buttons == null) return null;
      double cx = (r.left + r.right) / 2.0;
      foreach (Button b in buttons) if (cx >= b.Left && cx < b.Right) return b;
      return null;
    }

#if MANTLE_UIA
    /// Every promoted icon's button, left to right, or null with the reason.
    /// Measured on build 26200: the tray buttons are direct children of the
    /// island's InputSite pane (siblings of TaskbarFrame); if a later build
    /// nests them deeper, the fallback searches the whole island.
    static List<Button> ReadButtons(IntPtr tray, out string why) {
      why = null;
      IntPtr bridge = Win32.FindWindowExW(tray, IntPtr.Zero, BridgeClass, null);
      if (bridge == IntPtr.Zero) {
        why = "the taskbar has no XAML island (" + BridgeClass + "), so UI Automation has no tray buttons to read";
        return null;
      }
      try {
        var cr = new CacheRequest();
        cr.Add(AutomationElement.NameProperty);
        cr.Add(AutomationElement.AutomationIdProperty);
        cr.Add(AutomationElement.ClassNameProperty);
        cr.Add(AutomationElement.BoundingRectangleProperty);
        cr.Add(AutomationElement.RuntimeIdProperty);
        // Full, not None: FindFirst/FindAll/Invoke need a live element, and
        // the cost of keeping the reference is nothing next to the round trips.
        cr.AutomationElementMode = AutomationElementMode.Full;
        var tile = new OrCondition(
          new PropertyCondition(AutomationElement.AutomationIdProperty, "NotifyItemIcon"),
          new PropertyCondition(AutomationElement.AutomationIdProperty, "SystemTrayIcon"));
        AutomationElementCollection found = null;
        using (cr.Activate()) {
          AutomationElement root = AutomationElement.FromHandle(bridge);
          AutomationElement site = root.FindFirst(TreeScope.Children,
            new PropertyCondition(AutomationElement.ClassNameProperty, "Windows.UI.Input.InputSite.WindowClass"));
          if (site != null) found = site.FindAll(TreeScope.Children, tile);
          // SystemTrayIcon (the chevron, clock, volume...) is always there, so
          // none of them at this level means the layout moved, not "no icons".
          if (found == null || !HasSystemTile(found)) found = root.FindAll(TreeScope.Descendants, tile);
        }
        var list = new List<Button>();
        foreach (AutomationElement el in found) {
          if ((string)el.GetCachedPropertyValue(AutomationElement.AutomationIdProperty) != "NotifyItemIcon") continue;
          System.Windows.Rect r = (System.Windows.Rect)el.GetCachedPropertyValue(AutomationElement.BoundingRectangleProperty);
          if (r.IsEmpty || r.Width <= 0) continue;
          int[] rid = el.GetCachedPropertyValue(AutomationElement.RuntimeIdProperty) as int[];
          var b = new Button {
            Name = (string)el.GetCachedPropertyValue(AutomationElement.NameProperty),
            Left = r.Left, Right = r.Right,
            RuntimeId = rid == null ? "" : string.Join(".", Array.ConvertAll(rid, delegate (int x) { return x.ToString(CultureInfo.InvariantCulture); })),
            Element = el
          };
          list.Add(b);
        }
        list.Sort(delegate (Button a, Button c) { return a.Left.CompareTo(c.Left); });
        return list;
      } catch (Exception ex) {
        why = "UI Automation could not read the taskbar's tray buttons: " + ex.Message;
        return null;
      }
    }

    static bool HasSystemTile(AutomationElementCollection found) {
      foreach (AutomationElement el in found)
        if ((string)el.GetCachedPropertyValue(AutomationElement.AutomationIdProperty) == "SystemTrayIcon") return true;
      return false;
    }
#else
    static List<Button> ReadButtons(IntPtr tray, out string why) {
      why = UiaMissing;
      return null;
    }
#endif
  }
}

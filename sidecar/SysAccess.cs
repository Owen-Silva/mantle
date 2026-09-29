// SysAccess.cs - Settings > Accessibility for Mantle Settings (lane access, 2026-09-29): the values
// Windows' own Accessibility pages read and write, so Mantle's page can do the same natively.
//
// WHY: Owen wants Mantle Settings to replace Windows Settings outright. Almost everything on
// Windows' Accessibility pages is either a per-user registry value (HKCU, no administrator) or a
// SystemParametersInfo (SPI) value; this file reads them the way Windows does and changes them the
// same way: the SPI_SET* call with SPIF_UPDATEINIFILE | SPIF_SENDCHANGE (saved to the profile AND
// broadcast so running apps follow at once), or the registry value plus the WM_SETTINGCHANGE
// broadcast Windows sends for it. Every write is read back; a mismatch is an error in words.
//
// SAFETY: Sticky keys, Filter keys and the like can wreck a game if flipped by mistake (Shift five
// times!). A struct write therefore reads the struct first and flips ONLY the one flag asked for,
// keeping every other flag and timing exactly as Windows had them. Every write takes dryRun, which
// does all validation and every read and stops short of the change; a passive sidecar refuses the
// real write. Nothing here needs an administrator: accessibility settings are per user.
//
// READ-ONLY rows say why (No Silent Failures): the pointer style/colour (Windows builds those
// pointers itself), colour filters on/off and mono audio (applied by Windows' own services with no
// documented call), caption styles, voice typing and eye control.
//
//   access.settings                     every value: {values: {key: {value, set, why, readOnly, ...}},
//                                        tools: {magnifier|narrator|osk|voiceAccess|liveCaptions: ...}}
//   access.set {key, value, dryRun?}    ONE value (bool / number / choice string). dryRun validates,
//                                        reads and says what it would write.
//   access.start {tool, dryRun?}        SysAccessTools.cs: starts Magnifier, Narrator, ...
//
// PRIVACY: nothing here logs. Values are switches and numbers; no names or paths reach a log.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32;

namespace Mantle {
  /// One row of the Accessibility page: how to read it, validate a change, preview it and make it.
  sealed class AccessEntry {
    public string Key, Words, Kind = "bool";          // Kind: bool | number | choice
    public long Min, Max; public long[] Choices; public string[] Names;
    public Func<IDictionary> Read;                     // {value, set, why, ...}
    public Func<object, IList> Preview;                // the writes a change would make (dryRun)
    public Func<object, string> Write;                 // makes it and reads it back; null = done
    public string ReadOnly;                            // a fixed read-only reason (Write is then null)
    public Func<string> Lock;                          // a read-only reason that depends on state, or null
    public Func<object, string> Note;                  // an optional note for the answer of a real change
  }

  [MantleFeature]
  static class SysAccess {
    public static void Register(FeatureTable t) {
      t.Add("access.settings", Lanes.Slow, Settings);
      t.Add("access.set", Lanes.Slow, Set);          // SPIF_SENDCHANGE broadcasts: may wait on a slow app
    }

    internal static class Native {
      [DllImport("user32.dll", SetLastError = true)] public static extern bool SystemParametersInfoW(uint action, uint uiParam, ref int pv, uint winIni);
      [DllImport("user32.dll", SetLastError = true)] public static extern bool SystemParametersInfoW(uint action, uint uiParam, int[] pv, uint winIni);
      [DllImport("user32.dll", SetLastError = true)] public static extern bool SystemParametersInfoW(uint action, uint uiParam, IntPtr pv, uint winIni);
      [DllImport("user32.dll", SetLastError = true)] public static extern bool SystemParametersInfoW(uint action, uint uiParam, ref HIGHCONTRAST pv, uint winIni);
      [DllImport("user32.dll", SetLastError = true)] public static extern bool SystemParametersInfoW(uint action, uint uiParam, ref SOUNDSENTRY pv, uint winIni);
      [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
      public static extern IntPtr SendMessageTimeoutW(IntPtr hwnd, uint msg, IntPtr wp, string lp, uint flags, uint timeout, out IntPtr res);
    }
    [StructLayout(LayoutKind.Sequential)] internal struct HIGHCONTRAST { public int cbSize; public int dwFlags; public IntPtr lpszDefaultScheme; }
    [StructLayout(LayoutKind.Sequential)] internal struct SOUNDSENTRY {
      public int cbSize, dwFlags, iFSTextEffect, iFSTextEffectMSec, iFSTextEffectColorBits, iFSGrafEffect, iFSGrafEffectMSec, iFSGrafEffectColor, iWindowsEffect, iWindowsEffectMSec;
      public IntPtr lpszWindowsEffectDLL; public int iWindowsEffectOrdinal;
    }

    const uint SPIF = 0x01 | 0x02;                    // SPIF_UPDATEINIFILE | SPIF_SENDCHANGE
    const string Acc = @"Software\Microsoft\Accessibility";
    const string CpAcc = @"Control Panel\Accessibility";
    const string Personalize = @"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize";
    const string Themes = @"Software\Microsoft\Windows\CurrentVersion\Themes";
    const string Cursors = @"Control Panel\Cursors";
    const string ColorF = @"Software\Microsoft\ColorFiltering";

    // ------------------------------------------------------------------ small helpers

    internal static IDictionary V(object value, bool set, string why) { return Json.Obj("value", value, "set", set, "why", why); }

    internal static string Err(string what) {
      return what + " failed (Windows error " + Marshal.GetLastWin32Error().ToString(CultureInfo.InvariantCulture) + ")";
    }
    static string Hex(uint spi) { return "0x" + spi.ToString("X4", CultureInfo.InvariantCulture); }

    internal static IDictionary SpiWrite(string name, uint spi, object value, object before) {
      return Json.Obj("api", "SystemParametersInfo", "action", name, "code", Hex(spi), "value", value, "before", before, "flags", "SPIF_UPDATEINIFILE | SPIF_SENDCHANGE");
    }

    /// WM_SETTINGCHANGE to every top-level window (what Windows' Settings sends for a registry value).
    internal static void Broadcast(string area) {
      IntPtr res;
      Native.SendMessageTimeoutW(new IntPtr(0xFFFF), 0x001A, IntPtr.Zero, area, 0x0002 /* SMTO_ABORTIFHUNG */, 1000, out res);
    }

    static bool GetInt(uint spi, out int v, out string why) {
      v = 0; why = null;
      if (Native.SystemParametersInfoW(spi, 0, ref v, 0)) return true;
      why = Err("SystemParametersInfo " + Hex(spi));
      return false;
    }

    /// A SET whose pvParam is the value itself; a few documented as "points to a ULONG" take the
    /// pointer instead. Direct first (a pointer-taking SET refuses a small number as an address),
    /// then the pointer.
    static string SetInt(uint spi, int v, bool pointerToo) {
      if (Native.SystemParametersInfoW(spi, 0, new IntPtr(v), SPIF)) return null;
      string e = Err("SystemParametersInfo " + Hex(spi));
      if (!pointerToo) return e;
      int x = v;
      if (Native.SystemParametersInfoW(spi, 0, ref x, SPIF)) return null;
      return e + "; " + Err("the pointer form");
    }

    static string Check(uint get, int want) {
      int now; string why;
      if (!GetInt(get, out now, out why)) return "it was set but could not be read back (" + why + ")";
      if (now != want) return "it was set but Windows reads it back as " + now + " (another program may have put it back)";
      return null;
    }

    // ------------------------------------------------------------------ builders

    static AccessEntry E(string key, string words) { var e = new AccessEntry(); e.Key = key; e.Words = words; return e; }

    /// A DWORD switch in HKCU. `bcast` = the WM_SETTINGCHANGE area Windows sends after it (or null).
    static AccessEntry RegBool(string key, string words, string path, string name, long on, long off, bool dflt, string bcast) {
      var e = E(key, words);
      e.Read = delegate {
        string why; long? v = SysCommon.ReadNumber("HKCU", path, name, out why);
        return V(v == null ? dflt : v.Value == on, v != null, v == null ? why : null);
      };
      e.Preview = delegate(object to) {
        string w; return SysCommon.List(SysCommon.RegWrite("HKCU", path, name, (bool)to ? on : off, false, SysCommon.ReadNumber("HKCU", path, name, out w)));
      };
      e.Write = delegate(object to) {
        string err = SysCommon.WriteNumber("HKCU", path, name, (bool)to ? on : off, false);
        if (err == null && bcast != null) Broadcast(bcast);
        return err;
      };
      return e;
    }

    /// A DWORD number in HKCU, in [min, max] or one of `choices`.
    static AccessEntry RegNum(string key, string words, string path, string name, long min, long max, long[] choices, long dflt, string bcast) {
      var e = E(key, words);
      e.Kind = "number"; e.Min = min; e.Max = max; e.Choices = choices;
      e.Read = delegate {
        string why; long? v = SysCommon.ReadNumber("HKCU", path, name, out why);
        return V(v == null ? dflt : v.Value, v != null, v == null ? why : null);
      };
      e.Preview = delegate(object to) {
        string w; return SysCommon.List(SysCommon.RegWrite("HKCU", path, name, (long)to, false, SysCommon.ReadNumber("HKCU", path, name, out w)));
      };
      e.Write = delegate(object to) {
        string err = SysCommon.WriteNumber("HKCU", path, name, (long)to, false);
        if (err == null && bcast != null) Broadcast(bcast);
        return err;
      };
      return e;
    }

    internal static AccessEntry RegBoolEntry(string key, string words, string path, string name, long on, long off, bool dflt) { return RegBool(key, words, path, name, on, off, dflt, null); }
    internal static AccessEntry RegNumEntry(string key, string words, string path, string name, long min, long max, long[] choices, long dflt) { return RegNum(key, words, path, name, min, max, choices, dflt, null); }

    /// An SPI BOOL: SPI_GET* into an int, SPI_SET* with the BOOL as pvParam.
    static AccessEntry SpiBool(string key, string words, uint get, uint set, string setName) {
      var e = E(key, words);
      e.Read = delegate { int v; string why; return GetInt(get, out v, out why) ? V(v != 0, true, null) : V(null, false, why); };
      e.Preview = delegate(object to) { int v; string why; return SysCommon.List(SpiWrite(setName, set, (bool)to, GetInt(get, out v, out why) ? (object)(v != 0) : null)); };
      e.Write = delegate(object to) {
        int want = (bool)to ? 1 : 0;
        string err = SetInt(set, want, false);
        if (err != null) return err;
        int now; string why;
        if (!GetInt(get, out now, out why)) return "it was set but could not be read back (" + why + ")";
        return (now != 0) == (want != 0) ? null : "it was set but Windows reads it back as " + (now != 0 ? "on" : "off");
      };
      return e;
    }

    /// An SPI number: SPI_GET* into an int, SPI_SET* with the number as pvParam.
    static AccessEntry SpiNum(string key, string words, uint get, uint set, string setName, long min, long max, long[] choices, bool pointerToo) {
      var e = E(key, words);
      e.Kind = "number"; e.Min = min; e.Max = max; e.Choices = choices;
      e.Read = delegate { int v; string why; return GetInt(get, out v, out why) ? V((long)v, true, null) : V(null, false, why); };
      e.Preview = delegate(object to) { int v; string why; return SysCommon.List(SpiWrite(setName, set, to, GetInt(get, out v, out why) ? (object)(long)v : null)); };
      e.Write = delegate(object to) {
        int want = (int)(long)to;
        string err = SetInt(set, want, pointerToo);
        return err ?? Check(get, want);
      };
      return e;
    }

    // ------------------------------------------------------------------ the SPI structs (keyboard, mouse keys)
    // Each is {cbSize, dwFlags, ...ints}: read as an int[] and written back whole with ONE flag or
    // field changed, so nothing else Windows keeps in it moves.
    internal sealed class Spi { public string Name, SetName; public uint Get, Set; public int Ints; }
    internal static readonly Spi STICKY = MkSpi("sticky keys", "SPI_SETSTICKYKEYS", 0x003A, 0x003B, 2);
    internal static readonly Spi FILTER = MkSpi("filter keys", "SPI_SETFILTERKEYS", 0x0032, 0x0033, 6);
    internal static readonly Spi TOGGLE = MkSpi("toggle keys", "SPI_SETTOGGLEKEYS", 0x0034, 0x0035, 2);
    internal static readonly Spi MOUSE = MkSpi("mouse keys", "SPI_SETMOUSEKEYS", 0x0036, 0x0037, 7);
    static Spi MkSpi(string name, string setName, uint get, uint set, int ints) { var s = new Spi(); s.Name = name; s.SetName = setName; s.Get = get; s.Set = set; s.Ints = ints; return s; }

    internal static int[] ReadSpi(Spi s, out string why) {
      why = null;
      int[] a = new int[s.Ints];
      a[0] = s.Ints * 4;
      if (Native.SystemParametersInfoW(s.Get, (uint)(s.Ints * 4), a, 0)) return a;
      why = Err("reading " + s.Name);
      return null;
    }

    /// Reads the struct, lets `change` edit it, writes it back and reads it back through `ok`.
    static string WriteSpi(Spi s, Action<int[]> change, Func<int[], bool> ok) {
      string why;
      int[] a = ReadSpi(s, out why);
      if (a == null) return why;
      change(a);
      a[0] = s.Ints * 4;
      if (!Native.SystemParametersInfoW(s.Set, (uint)(s.Ints * 4), a, SPIF)) return Err("changing " + s.Name);
      int[] b = ReadSpi(s, out why);
      if (b == null) return "it was set but could not be read back (" + why + ")";
      return ok(b) ? null : "it was set but Windows reads it back differently (another program may have put it back)";
    }

    /// ONE flag of one struct.
    static AccessEntry Flag(string key, string words, Spi s, int flag) {
      var e = E(key, words);
      e.Read = delegate { string why; int[] a = ReadSpi(s, out why); return a == null ? V(null, false, why) : V((a[1] & flag) != 0, true, null); };
      e.Preview = delegate(object to) {
        string why; int[] a = ReadSpi(s, out why);
        return SysCommon.List(SpiWrite(s.SetName, s.Set, Json.Obj("flag", "0x" + flag.ToString("X", CultureInfo.InvariantCulture), "on", to, "otherFlagsKept", true), a == null ? null : (object)((a[1] & flag) != 0)));
      };
      e.Write = delegate(object to) {
        bool on = (bool)to;
        return WriteSpi(s, delegate(int[] a) { a[1] = on ? (a[1] | flag) : (a[1] & ~flag); }, delegate(int[] b) { return ((b[1] & flag) != 0) == on; });
      };
      return e;
    }

    /// The same flag in several structs (the "warning" and "sound" rows cover sticky, filter and
    /// toggle keys at once, as in Windows). Reads as on when the FIRST one is.
    static AccessEntry Flags(string key, string words, Spi[] list, int flag) {
      var e = Flag(key, words, list[0], flag);
      e.Preview = delegate(object to) {
        var l = new List<object>();
        foreach (Spi s in list) {
          string why; int[] a = ReadSpi(s, out why);
          l.Add(SpiWrite(s.SetName, s.Set, Json.Obj("flag", "0x" + flag.ToString("X", CultureInfo.InvariantCulture), "on", to, "otherFlagsKept", true), a == null ? null : (object)((a[1] & flag) != 0)));
        }
        return l;
      };
      e.Write = delegate(object to) {
        bool on = (bool)to;
        for (int i = 0; i < list.Length; i++) {
          string err = WriteSpi(list[i], delegate(int[] a) { a[1] = on ? (a[1] | flag) : (a[1] & ~flag); }, delegate(int[] b) { return ((b[1] & flag) != 0) == on; });
          if (err != null) return list[i].Name + ": " + err + (i > 0 ? " (after " + i + " of " + list.Length + " were changed)" : "");
        }
        return null;
      };
      return e;
    }

    /// ONE number field of a struct (mouse keys' speed and acceleration).
    static AccessEntry Field(string key, string words, Spi s, int index, long min, long max) {
      var e = E(key, words);
      e.Kind = "number"; e.Min = min; e.Max = max;
      e.Read = delegate { string why; int[] a = ReadSpi(s, out why); return a == null ? V(null, false, why) : V((long)a[index], true, null); };
      e.Preview = delegate(object to) { string why; int[] a = ReadSpi(s, out why); return SysCommon.List(SpiWrite(s.SetName, s.Set, Json.Obj("field", index, "value", to), a == null ? null : (object)(long)a[index])); };
      e.Write = delegate(object to) {
        int v = (int)(long)to;
        return WriteSpi(s, delegate(int[] a) { a[index] = v; }, delegate(int[] b) { return b[index] == v; });
      };
      return e;
    }

    // ------------------------------------------------------------------ contrast themes
    // Windows 11's four contrast themes are the four .theme files below. The files still call
    // themselves "High Contrast #1" etc. (themeui.dll strings); Windows 11's names are its Settings'
    // own, matched here by each file's colours against Microsoft's published tables (MEASURED
    // 2026-09-29: hcblack Window 32,32,32 + links 117,233,252 = Aquatic; hcwhite 255,250,239 =
    // Desert; hc1 45,50,54 = Dusk; hc2 0,0,0 + links 128,128,255 = Night sky). Listed in Windows 11's
    // order. Applying one is what Windows does with its shortcut: the theme file in
    // Themes\LastHighContrastTheme, then SPI_SETHIGHCONTRAST with HCF_HIGHCONTRASTON and the file's
    // scheme name. Off = the same call without HCF_HIGHCONTRASTON.
    internal static readonly string[] HC_IDS = { "aquatic", "desert", "dusk", "nightSky" };
    static readonly string[] HC_NAMES = { "Aquatic", "Desert", "Dusk", "Night sky" };
    static readonly string[] HC_FILES = { "hcblack", "hcwhite", "hc1", "hc2" };
    static readonly string[] HC_SCHEMES = { "High Contrast Black", "High Contrast White", "High Contrast #1", "High Contrast #2" };
    const int HCF_ON = 0x1, HCF_HOTKEYACTIVE = 0x4;
    const uint SPI_GETHIGHCONTRAST = 0x0042, SPI_SETHIGHCONTRAST = 0x0043;

    static string HcFile(int i) {
      return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), @"Resources\Ease of Access Themes\" + HC_FILES[i] + ".theme");
    }

    static bool ReadHc(out HIGHCONTRAST hc, out string scheme, out string why) {
      hc = new HIGHCONTRAST(); hc.cbSize = Marshal.SizeOf(typeof(HIGHCONTRAST)); scheme = null; why = null;
      if (!Native.SystemParametersInfoW(SPI_GETHIGHCONTRAST, (uint)hc.cbSize, ref hc, 0)) { why = Err("reading contrast themes (SPI_GETHIGHCONTRAST)"); return false; }
      scheme = hc.lpszDefaultScheme == IntPtr.Zero ? null : Marshal.PtrToStringUni(hc.lpszDefaultScheme);
      return true;
    }
    static int SchemeIndex(string scheme) {
      for (int i = 0; i < HC_SCHEMES.Length; i++) if (string.Equals(HC_SCHEMES[i], scheme, StringComparison.OrdinalIgnoreCase)) return i;
      return -1;
    }

    static IDictionary ReadContrast() {
      HIGHCONTRAST hc; string scheme, why;
      var themes = new List<object>();
      themes.Add(Json.Obj("value", "none", "label", "None", "present", true));
      for (int i = 0; i < HC_IDS.Length; i++) themes.Add(Json.Obj("value", HC_IDS[i], "label", HC_NAMES[i], "file", HC_FILES[i] + ".theme", "present", File.Exists(HcFile(i))));
      if (!ReadHc(out hc, out scheme, out why)) return Json.Obj("value", null, "set", false, "why", why, "themes", themes);
      bool on = (hc.dwFlags & HCF_ON) != 0;
      int idx = SchemeIndex(scheme);
      string v = !on ? "none" : idx >= 0 ? HC_IDS[idx] : "custom";
      return Json.Obj("value", v, "set", true, "why", null, "on", on, "scheme", scheme, "themes", themes);
    }

    static string WriteHc(bool on, int idx) {
      HIGHCONTRAST hc; string scheme, why;
      if (!ReadHc(out hc, out scheme, out why)) return why;
      if (on) {
        string file = HcFile(idx);
        if (!File.Exists(file)) return "Windows on this PC has no " + HC_FILES[idx] + ".theme (" + HC_NAMES[idx] + ") to apply";
        try {
          using (RegistryKey b = SysCommon.Hive("HKCU"))
          using (RegistryKey k = b.CreateSubKey(Themes, RegistryKeyPermissionCheck.ReadWriteSubTree)) {
            if (k == null) return "the themes key could not be opened for writing";
            k.SetValue("LastHighContrastTheme", file, RegistryValueKind.String);
          }
        } catch (Exception ex) { return "Windows refused the theme choice: " + SysCommon.Why(ex); }
      }
      IntPtr name = Marshal.StringToHGlobalUni(on ? HC_SCHEMES[idx] : (scheme ?? HC_SCHEMES[0]));
      try {
        hc.cbSize = Marshal.SizeOf(typeof(HIGHCONTRAST));
        hc.dwFlags = on ? (hc.dwFlags | HCF_ON) : (hc.dwFlags & ~HCF_ON);
        hc.lpszDefaultScheme = name;
        if (!Native.SystemParametersInfoW(SPI_SETHIGHCONTRAST, (uint)hc.cbSize, ref hc, SPIF)) return Err("changing the contrast theme (SPI_SETHIGHCONTRAST)");
      } finally { Marshal.FreeHGlobal(name); }
      HIGHCONTRAST back; string s2;
      if (!ReadHc(out back, out s2, out why)) return "it was set but could not be read back (" + why + ")";
      if (((back.dwFlags & HCF_ON) != 0) != on) return "it was set but Windows reads contrast themes back as " + ((back.dwFlags & HCF_ON) != 0 ? "on" : "off");
      return null;
    }

    static AccessEntry Contrast() {
      var e = E("contrastTheme", "the contrast theme");
      e.Kind = "choice"; e.Names = new[] { "none", "aquatic", "desert", "dusk", "nightSky" };
      e.Read = ReadContrast;
      e.Preview = delegate(object to) {
        string v = (string)to; int i = Array.IndexOf(HC_IDS, v);
        var l = new List<object>();
        if (i >= 0) l.Add(Json.Obj("api", "registry", "hive", "HKCU", "key", Themes, "name", "LastHighContrastTheme", "type", "REG_SZ", "value", HC_FILES[i] + ".theme (Windows' own contrast theme file)"));
        l.Add(SpiWrite("SPI_SETHIGHCONTRAST", SPI_SETHIGHCONTRAST, Json.Obj("on", i >= 0, "scheme", i >= 0 ? HC_SCHEMES[i] : null), ReadContrast()["value"]));
        return l;
      };
      e.Write = delegate(object to) { int i = Array.IndexOf(HC_IDS, (string)to); return WriteHc(i >= 0, i < 0 ? 0 : i); };
      e.Note = delegate(object to) { return (string)to == "none" ? "Contrast themes are off; Windows puts your own theme back" : "Windows is switching every window to the contrast theme; it can take a few seconds"; };
      return e;
    }

    static AccessEntry ContrastShortcut() {
      var e = E("contrastShortcut", "the contrast theme keyboard shortcut (left Alt + left Shift + Print Screen)");
      e.Read = delegate { HIGHCONTRAST hc; string s, why; return ReadHc(out hc, out s, out why) ? V((hc.dwFlags & HCF_HOTKEYACTIVE) != 0, true, null) : V(null, false, why); };
      e.Preview = delegate(object to) { return SysCommon.List(SpiWrite("SPI_SETHIGHCONTRAST", SPI_SETHIGHCONTRAST, Json.Obj("flag", "HCF_HOTKEYACTIVE", "on", to, "otherFlagsKept", true), e.Read()["value"])); };
      e.Write = delegate(object to) {
        bool on = (bool)to;
        HIGHCONTRAST hc; string scheme, why;
        if (!ReadHc(out hc, out scheme, out why)) return why;
        IntPtr name = Marshal.StringToHGlobalUni(scheme ?? HC_SCHEMES[0]);
        try {
          hc.cbSize = Marshal.SizeOf(typeof(HIGHCONTRAST));
          hc.dwFlags = on ? (hc.dwFlags | HCF_HOTKEYACTIVE) : (hc.dwFlags & ~HCF_HOTKEYACTIVE);
          hc.lpszDefaultScheme = name;
          if (!Native.SystemParametersInfoW(SPI_SETHIGHCONTRAST, (uint)hc.cbSize, ref hc, SPIF)) return Err("changing the contrast shortcut");
        } finally { Marshal.FreeHGlobal(name); }
        object now = e.Read()["value"];
        return now is bool && (bool)now == on ? null : "it was set but Windows reads it back differently";
      };
      return e;
    }

    // ------------------------------------------------------------------ flash the screen (SoundSentry)
    const uint SPI_GETSOUNDSENTRY = 0x0040, SPI_SETSOUNDSENTRY = 0x0041;
    static readonly string[] FLASH = { "off", "title", "window", "display" };   // SSWF_NONE, _TITLE, _WINDOW, _DISPLAY

    static bool ReadSs(out SOUNDSENTRY ss, out string why) {
      ss = new SOUNDSENTRY(); ss.cbSize = Marshal.SizeOf(typeof(SOUNDSENTRY)); why = null;
      if (Native.SystemParametersInfoW(SPI_GETSOUNDSENTRY, (uint)ss.cbSize, ref ss, 0)) return true;
      why = Err("reading visual notifications for sounds (SPI_GETSOUNDSENTRY)");
      return false;
    }
    static AccessEntry Flash() {
      var e = E("flashScreen", "flashing the screen during audio notifications");
      e.Kind = "choice"; e.Names = FLASH;
      e.Read = delegate {
        SOUNDSENTRY ss; string why;
        if (!ReadSs(out ss, out why)) return V(null, false, why);
        bool on = (ss.dwFlags & 1) != 0;
        return V(on && ss.iWindowsEffect >= 1 && ss.iWindowsEffect <= 3 ? FLASH[ss.iWindowsEffect] : "off", true, null);
      };
      e.Preview = delegate(object to) { return SysCommon.List(SpiWrite("SPI_SETSOUNDSENTRY", SPI_SETSOUNDSENTRY, Json.Obj("on", (string)to != "off", "iWindowsEffect", Array.IndexOf(FLASH, (string)to)), e.Read()["value"])); };
      e.Write = delegate(object to) {
        int n = Array.IndexOf(FLASH, (string)to);
        SOUNDSENTRY ss; string why;
        if (!ReadSs(out ss, out why)) return why;
        ss.cbSize = Marshal.SizeOf(typeof(SOUNDSENTRY));
        ss.dwFlags = n > 0 ? (ss.dwFlags | 1) : (ss.dwFlags & ~1);
        if (n > 0) { ss.iWindowsEffect = n; if (ss.iWindowsEffectMSec <= 0) ss.iWindowsEffectMSec = 500; }
        ss.lpszWindowsEffectDLL = IntPtr.Zero; ss.iWindowsEffectOrdinal = 0;   // no custom effect DLL, as Windows' own Settings
        if (!Native.SystemParametersInfoW(SPI_SETSOUNDSENTRY, (uint)ss.cbSize, ref ss, SPIF)) return Err("changing visual notifications for sounds");
        object now = e.Read()["value"];
        return (string)now == (string)to ? null : "it was set but Windows reads it back as " + now;
      };
      return e;
    }

    // ------------------------------------------------------------------ pointer size and the read-only rows

    static AccessEntry PointerSize() {
      var e = RegNum("pointerSize", "the mouse pointer size", Acc, "CursorSize", 1, 15, null, 1, null);
      e.Preview = delegate(object to) {
        long n = (long)to; string w;
        return SysCommon.List(
          SysCommon.RegWrite("HKCU", Acc, "CursorSize", n, false, SysCommon.ReadNumber("HKCU", Acc, "CursorSize", out w)),
          SysCommon.RegWrite("HKCU", Cursors, "CursorBaseSize", 32 + (n - 1) * 16, false, SysCommon.ReadNumber("HKCU", Cursors, "CursorBaseSize", out w)),
          SpiWrite("SPI_SETCURSORS", 0x0057, "reload the pointers at the new size", null));
      };
      e.Write = delegate(object to) {
        long n = (long)to;
        string err = SysCommon.WriteNumber("HKCU", Acc, "CursorSize", n, false) ?? SysCommon.WriteNumber("HKCU", Cursors, "CursorBaseSize", 32 + (n - 1) * 16, false);
        if (err != null) return err;
        if (!Native.SystemParametersInfoW(0x0057 /* SPI_SETCURSORS */, 0, IntPtr.Zero, SPIF)) return Err("reloading the pointers (SPI_SETCURSORS)") + "; the size is saved and applies at the next sign-in";
        return null;
      };
      return e;
    }

    static AccessEntry ReadOnlyReg(string key, string reason, string path, string name, long dflt) {
      var e = E(key, key);
      e.Kind = "number"; e.ReadOnly = reason;
      e.Read = delegate { string why; long? v = SysCommon.ReadNumber("HKCU", path, name, out why); return V(v == null ? dflt : v.Value, v != null, v == null ? why : null); };
      return e;
    }
    static AccessEntry Fixed(string key, string reason) {
      var e = E(key, key);
      e.Kind = "none"; e.ReadOnly = reason;
      e.Read = delegate { return V(null, false, null); };
      return e;
    }

    const string OwnSettings = "Windows applies this through its own Settings with no documented call another program may make, so Mantle shows it read-only";

    // ------------------------------------------------------------------ the table

    static readonly Spi[] KEYS3 = { STICKY, FILTER, TOGGLE };
    static List<AccessEntry> _all;
    internal static List<AccessEntry> All() {
      if (_all != null) return _all;
      var l = new List<AccessEntry>();
      // Vision: text size
      var ts = RegNum("textSize", "text size", Acc, "TextScaleFactor", 100, 225, null, 100, "WindowMetrics");
      ts.Note = delegate(object to) { return "Apps that follow Windows' text size change now; some older desktop apps only after they restart"; };
      l.Add(ts);
      // Vision: visual effects
      l.Add(RegBool("scrollbars", "always show scrollbars", CpAcc, "DynamicScrollbars", 0, 1, false, "Control Panel\\Accessibility"));
      l.Add(RegBool("transparency", "transparency effects", Personalize, "EnableTransparency", 1, 0, true, "ImmersiveColorSet"));
      l.Add(SpiBool("animations", "animation effects", 0x1042, 0x1043, "SPI_SETCLIENTAREAANIMATION"));
      l.Add(SpiNum("notifyDuration", "how long notifications stay", 0x2016, 0x2017, "SPI_SETMESSAGEDURATION", 5, 300, new long[] { 5, 7, 15, 30, 60, 300 }, false));
      // Vision: mouse pointer and touch
      l.Add(ReadOnlyReg("pointerStyle", "Windows draws the black, inverted and coloured pointers itself, from its own accessibility pointer set built inside its Settings; there is no documented call another program may use to build them, so Mantle shows the style read-only", Acc, "CursorType", 0));
      l.Add(ReadOnlyReg("pointerColor", "The custom pointer colour is built by Windows' own Settings with the style (see above), so Mantle shows it read-only", Acc, "CursorColor", 0x00FFFFFF));
      l.Add(PointerSize());
      var touch = SpiNum("touchIndicator", "the touch indicator", 0x2018, 0x2019, "SPI_SETCONTACTVISUALIZATION", 0, 2, new long[] { 0, 1, 2 }, true);
      l.Add(touch);
      // Vision: text cursor
      l.Add(SpiNum("caretWidth", "the text cursor thickness", 0x2006, 0x2007, "SPI_SETCARETWIDTH", 1, 20, null, false));
      // Vision: contrast themes
      l.Add(Contrast());
      l.Add(ContrastShortcut());
      // Vision: colour filters
      l.Add(ReadOnlyReg("colorFilters", "Windows turns colour filters on and off through its own colour-filtering service (or its shortcut, Windows logo key + Ctrl + C, when that is on below), with no documented call another program may make, so Mantle shows it read-only", ColorF, "Active", 0));
      l.Add(RegNum("colorFilter", "the colour filter", ColorF, "FilterType", 0, 5, new long[] { 0, 1, 2, 3, 4, 5 }, 0, null));
      l.Add(RegBool("colorFilterShortcut", "the colour filter keyboard shortcut (Windows logo key + Ctrl + C)", ColorF, "HotkeyEnabled", 1, 0, false, null));
      // Hearing: audio
      l.Add(ReadOnlyReg("monoAudio", "Windows' audio service applies mono audio when its own Settings tells it to; saving the value alone only takes effect after the audio service restarts, so Mantle shows it read-only", @"Software\Microsoft\Multimedia\Audio", "AccessibilityMonoMixState", 0));
      l.Add(Flash());
      // Hearing: captions
      l.Add(Fixed("captionStyle", "Windows keeps caption styles in its own Settings' style editor, with no documented setting another program may change, so Mantle shows them read-only"));
      // Interaction: speech, eye control
      l.Add(Fixed("voiceTyping", "Voice typing is Windows' own (Windows logo key + H) and keeps its choices in its own Settings, with no documented setting another program may change"));
      l.Add(Fixed("eyeControl", "Eye control needs a supported eye tracker and Windows' own Eye Control app to set it up; Mantle cannot run or change it, so it is read-only here"));
      // Interaction: keyboard
      l.Add(Flag("stickyOn", "Sticky keys", STICKY, 0x1));
      l.Add(Flag("stickyShortcut", "the Sticky keys keyboard shortcut (press Shift five times)", STICKY, 0x4));
      l.Add(Flag("stickyIndicator", "the Sticky keys icon on the taskbar", STICKY, 0x20));
      l.Add(Flag("stickyLock", "locking shortcut keys when pressed twice in a row", STICKY, 0x80));
      l.Add(Flag("stickyTwoKeysOff", "turning Sticky keys off when two keys are pressed at the same time", STICKY, 0x100));
      l.Add(Flag("stickySound", "a sound when shortcut keys are pressed and released", STICKY, 0x40));
      l.Add(Flag("filterOn", "Filter keys", FILTER, 0x1));
      l.Add(Flag("filterShortcut", "the Filter keys keyboard shortcut (hold right Shift for eight seconds)", FILTER, 0x4));
      l.Add(Flag("filterIndicator", "the Filter keys icon on the taskbar", FILTER, 0x20));
      l.Add(Flag("filterBeep", "a beep when keys are pressed or accepted", FILTER, 0x40));
      l.Add(Flag("toggleOn", "Toggle keys", TOGGLE, 0x1));
      l.Add(Flag("toggleShortcut", "the Toggle keys keyboard shortcut (hold Num Lock for five seconds)", TOGGLE, 0x4));
      l.Add(Flags("shortcutWarning", "a warning before Sticky, Filter or Toggle keys turn on from the keyboard", KEYS3, 0x8));
      l.Add(Flags("shortcutSound", "a sound when Sticky, Filter or Toggle keys turn on or off from the keyboard", KEYS3, 0x10));
      l.Add(SpiBool("accessKeys", "underlined access keys", 0x100A, 0x100B, "SPI_SETKEYBOARDCUES"));
      l.Add(RegBool("printScreen", "opening Windows' screen capture with the Print Screen key", @"Control Panel\Keyboard", "PrintScreenKeyForSnippingEnabled", 1, 0, true, null));
      // Interaction: mouse keys
      l.Add(Flag("mouseKeysOn", "Mouse keys", MOUSE, 0x1));
      l.Add(Flag("mouseKeysShortcut", "the Mouse keys keyboard shortcut (left Alt + left Shift + Num Lock)", MOUSE, 0x4));
      l.Add(Flag("mouseKeysIndicator", "the Mouse keys icon on the taskbar", MOUSE, 0x20));
      l.Add(Flag("mouseKeysNumLock", "using Mouse keys only when Num Lock is on", MOUSE, 0x80));
      l.Add(Flag("mouseKeysModifiers", "holding Ctrl to speed up and Shift to slow down", MOUSE, 0x40));
      l.Add(Field("mouseKeysSpeed", "the Mouse keys speed", MOUSE, 2, 10, 360));
      l.Add(Field("mouseKeysAccel", "the Mouse keys acceleration (time to top speed)", MOUSE, 3, 1000, 5000));
      // Magnifier, Narrator, on-screen keyboard...: SysAccessTools.cs
      SysAccessTools.Entries(l);
      _all = l;
      return l;
    }
    static AccessEntry Find(string key) { foreach (AccessEntry e in All()) if (e.Key == key) return e; return null; }

    static IDictionary ReadEntry(AccessEntry e) {
      IDictionary d;
      try { d = e.Read(); } catch (Exception ex) { d = V(null, false, "could not be read: " + SysCommon.Why(ex)); }
      string ro = e.ReadOnly;
      if (ro == null && e.Lock != null) { try { ro = e.Lock(); } catch (Exception ex) { ro = "its state could not be read: " + SysCommon.Why(ex); } }
      d["readOnly"] = ro;
      return d;
    }

    // ------------------------------------------------------------------ commands

    static string Settings(Dictionary<string, object> req, ref object result) {
      var vals = new Dictionary<string, object>(StringComparer.Ordinal);
      foreach (AccessEntry e in All()) vals[e.Key] = ReadEntry(e);
      result = Json.Obj("ok", true, "values", vals, "tools", SysAccessTools.Tools(), "reason", null);
      return null;
    }

    static string Words(object v) {
      if (v == null) return "not set";
      if (v is bool) return (bool)v ? "on" : "off";
      return Convert.ToString(v, CultureInfo.InvariantCulture);
    }

    /// The request's value as the entry's type, or the error in words.
    static string Coerce(AccessEntry e, object raw, out object to) {
      to = null;
      if (e.Kind == "bool") {
        if (!(raw is bool)) return e.Key + " must be true or false";
        to = raw; return null;
      }
      if (e.Kind == "choice") {
        string s = raw as string;
        if (s == null || Array.IndexOf(e.Names, s) < 0) return e.Key + " must be one of: " + string.Join(", ", e.Names);
        to = s; return null;
      }
      if (e.Kind == "number") {
        if (!(raw is double)) return e.Key + " must be a whole number from " + e.Min + " to " + e.Max;
        double d = (double)raw;
        if (d != Math.Floor(d) || d < e.Min || d > e.Max) return e.Key + " must be a whole number from " + e.Min + " to " + e.Max;
        long n = (long)d;
        if (e.Choices != null && Array.IndexOf(e.Choices, n) < 0) {
          var c = new List<string>(); foreach (long x in e.Choices) c.Add(x.ToString(CultureInfo.InvariantCulture));
          return e.Key + " must be one of: " + string.Join(", ", c.ToArray());
        }
        to = n; return null;
      }
      return e.Key + " cannot be changed";
    }

    static string Set(Dictionary<string, object> req, ref object result) {
      string key = Json.GetString(req, "key");
      if (string.IsNullOrEmpty(key)) return "access.set needs key (e.g. \"stickyShortcut\")";
      object raw;
      if (!Json.TryGet(req, "value", out raw)) return "access.set needs value";
      bool dry = Json.GetBool(req, "dryRun", false);
      AccessEntry e = Find(key);
      if (e == null) return "access.set: unknown key \"" + key + "\"";
      if (e.Write == null) return "Read only: " + (e.ReadOnly ?? "Mantle cannot change this");
      object to;
      string err = Coerce(e, raw, out to);
      if (err != null) return err;
      IDictionary cur = ReadEntry(e);
      if (cur["readOnly"] != null) return "Read only: " + (string)cur["readOnly"];
      object before = cur["value"];
      IList writes;
      try { writes = e.Preview(to); } catch (Exception ex) { return "access.set " + key + ": the change could not be planned (" + SysCommon.Why(ex) + ")"; }
      string would = e.Kind == "bool" ? "turn " + e.Words + " " + Words(to) : "set " + e.Words + " from " + Words(before) + " to " + Words(to);
      if (dry) {
        result = Json.Obj("ok", true, "dryRun", true, "key", key, "from", before, "to", to, "would", would, "writes", writes, "reason", null);
        return null;
      }
      if (Program.Passive) return FeatureTable.PassiveRefusal + ": access.set would " + would;
      try { err = e.Write(to); } catch (Exception ex) { err = SysCommon.Why(ex); }
      if (err != null) return "access.set " + key + ": " + err;
      IDictionary now = ReadEntry(e);
      string note = null;
      if (e.Note != null) { try { note = e.Note(to); } catch (Exception) { note = null; } }
      result = Json.Obj("ok", true, "dryRun", false, "key", key, "from", before, "to", to, "now", now["value"], "note", note);
      return null;
    }
  }
}

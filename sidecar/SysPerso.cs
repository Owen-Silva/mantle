// SysPerso.cs - Settings > Personalization for Mantle Settings (lane perso, 2026-09-29): Colors,
// Background, Lock screen, Device usage, and the read-only parts (Themes, Text input, Dynamic
// lighting). Fonts live in SysPersoFonts.cs.
//
// WHY: Mantle Settings replaces Windows Settings, so its Personalization page reads and changes the
// SAME per-user values Windows' own Settings does:
//   - Colors: HKCU Themes\Personalize (light/dark for apps and Windows, transparency, accent on Start
//     and the taskbar), DWM (accent on title bars, the accent itself), Explorer\Accent (the eight
//     shades Windows draws with) and Control Panel\Desktop AutoColorization. A change is announced
//     with WM_SETTINGCHANGE "ImmersiveColorSet", the broadcast Windows' Settings sends.
//   - Background: IDesktopWallpaper (shobjidl, documented) sets the picture, the fit, the solid
//     colour and the slideshow; the registry is read for what Windows shows and its recent pictures.
//     Mantle draws its OWN wallpaper above this one (lib/wallpaper.js); this is Windows' background,
//     seen only where Mantle shows none. Lively is only LOOKED AT (is it running), never touched.
//   - Lock screen: Windows spotlight and "fun facts" are HKCU ContentDeliveryManager values.
// READ-ONLY with the reason on the row: device usage (undocumented intent values), themes (Windows applies a whole theme only through its own
// theme service), the lock screen picture and the sign-in background (a protected store / WinRT this
// build cannot reach), touch keyboard themes (no documented value) and Dynamic Lighting (its own
// lighting service, WinRT LampArray).
//
//   perso.colors                    every colour value: {appsLight, systemLight, transparency, accent,
//                                   autoAccent, accentOnStart, accentOnTitleBars, highContrast, why}
//   perso.background                Windows' background: {kind, picture, fit, color, recent, slideshow,
//                                   monitors, lively, locked}
//   perso.more                      themes, lock screen, device usage, touch keyboard, lighting
//   perso.set {key, value, dryRun?} ONE change. dryRun validates, reads and says what it would write.
//
// Every write takes dryRun; a --passive sidecar refuses every real write. PRIVACY: nothing here logs;
// paths reach the page only in replies.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32;

namespace Mantle {
  [MantleFeature]
  static class SysPerso {
    public static void Register(FeatureTable t) {
      t.Add("perso.colors", Lanes.Slow, Colors);
      t.Add("perso.background", Lanes.Slow, Background);
      t.Add("perso.more", Lanes.Slow, More);
      t.Add("perso.set", Lanes.Slow, Set);   // WM_SETTINGCHANGE may wait on a slow app (1 s cap)
    }

    const string Pers = @"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize";
    const string Dwm = @"Software\Microsoft\Windows\DWM";
    const string AccentKey = @"Software\Microsoft\Windows\CurrentVersion\Explorer\Accent";
    const string Desk = @"Control Panel\Desktop";
    const string Wps = @"Software\Microsoft\Windows\CurrentVersion\Explorer\Wallpapers";
    const string Cdm = @"Software\Microsoft\Windows\CurrentVersion\ContentDeliveryManager";
    const string IntentKey = @"Software\Microsoft\Windows\CurrentVersion\CloudExperienceHost\Intent";
    const string ThemesKey = @"Software\Microsoft\Windows\CurrentVersion\Themes";
    const string LightKey = @"Software\Microsoft\Lighting";
    const string TipKey = @"Software\Microsoft\TabletTip\1.7";

    // ------------------------------------------------------------------ the switches
    // One on/off value set: every (Paths[i], Names[i]) gets On[i] / Off[i]; it reads On when the
    // FIRST does. Dflt = what Windows does while nothing is stored. Bc = the WM_SETTINGCHANGE text.
    sealed class Sw { public string Key, Words, Bc; public string[] Paths, Names; public long[] On, Off; public bool Dflt; }
    static Sw S(string key, string words, string path, string name, bool dflt, string bc) {
      var s = new Sw(); s.Key = key; s.Words = words; s.Paths = new[] { path }; s.Names = new[] { name };
      s.On = new long[] { 1 }; s.Off = new long[] { 0 }; s.Dflt = dflt; s.Bc = bc; return s;
    }
    public static readonly string[] Uses = { "gaming", "family", "creative", "schoolwork", "entertainment", "business", "developer" };
    static readonly Sw[] SWITCHES = BuildSwitches();
    static Sw[] BuildSwitches() {
      var l = new List<Sw>();
      l.Add(S("appsLight", "use light mode for apps", Pers, "AppsUseLightTheme", true, "ImmersiveColorSet"));
      l.Add(S("systemLight", "use light mode for Windows", Pers, "SystemUsesLightTheme", true, "ImmersiveColorSet"));
      l.Add(S("transparency", "use transparency effects", Pers, "EnableTransparency", true, "ImmersiveColorSet"));
      l.Add(S("accentOnStart", "show the accent colour on Start and the taskbar", Pers, "ColorPrevalence", false, "ImmersiveColorSet"));
      l.Add(S("accentOnTitleBars", "show the accent colour on title bars and window borders", Dwm, "ColorPrevalence", false, "ImmersiveColorSet"));
      l.Add(S("autoAccent", "pick the accent colour from the background automatically", Desk, "AutoColorization", false, "ImmersiveColorSet"));
      l.Add(S("spotlight", "show Windows spotlight pictures on the lock screen", Cdm, "RotatingLockScreenEnabled", true, null));
      var facts = S("lockFacts", "show fun facts, tips and tricks on the lock screen", Cdm, "RotatingLockScreenOverlayEnabled", true, null);
      facts.Paths = new[] { Cdm, Cdm }; facts.Names = new[] { "RotatingLockScreenOverlayEnabled", "SubscribedContent-338387Enabled" };
      facts.On = new long[] { 1, 1 }; facts.Off = new long[] { 0, 0 };
      l.Add(facts);
      foreach (string u in Uses) l.Add(S("usage." + u, "tell Windows you use this PC for " + u, IntentKey + "\\" + u, "Intent", false, null));
      return l.ToArray();
    }
    static Sw FindSw(string key) { foreach (Sw s in SWITCHES) if (s.Key == key) return s; return null; }

    static IDictionary ReadSw(Sw s) {
      string w;
      long? v = SysCommon.ReadNumber("HKCU", s.Paths[0], s.Names[0], out w);
      bool on = v == null ? s.Dflt : v.Value == s.On[0];
      return Json.Obj("on", on, "set", v != null, "why", v == null ? w : null);
    }

    // ------------------------------------------------------------------ registry helpers (HKCU only)
    /// Writes a DWORD, or a REG_SZ number when the value already is a string (Control Panel\Desktop).
    static string WriteKeep(string key, string name, long value) {
      string w;
      bool asString = SysCommon.Read("HKCU", key, name, out w) is string;
      return SysCommon.WriteNumber("HKCU", key, name, value, asString);
    }
    static string WriteBytes(string key, string name, byte[] data) {
      try {
        using (RegistryKey b = SysCommon.Hive("HKCU"))
        using (RegistryKey k = b.CreateSubKey(key, RegistryKeyPermissionCheck.ReadWriteSubTree)) {
          if (k == null) return "the settings key could not be opened for writing";
          k.SetValue(name, data, RegistryValueKind.Binary);
        }
        return null;
      } catch (Exception ex) { return "Windows refused the write: " + SysCommon.Why(ex); }
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr SendMessageTimeoutW(IntPtr hwnd, uint msg, IntPtr wp, string lp, uint flags, uint timeout, out IntPtr res);
    /// WM_SETTINGCHANGE to every top-level window, as Windows' Settings does after a colour change.
    public static void Broadcast(string what) {
      IntPtr res;
      SendMessageTimeoutW(new IntPtr(0xFFFF), 0x001A, IntPtr.Zero, what, 0x0002 /* SMTO_ABORTIFHUNG */, 1000, out res);
    }

    // ------------------------------------------------------------------ colours
    static string Hex(int r, int g, int b) { return "#" + r.ToString("X2") + g.ToString("X2") + b.ToString("X2"); }
    public static bool ParseHex(object raw, out int r, out int g, out int b) {
      r = g = b = 0;
      string s = raw as string;
      if (s == null || s.Length != 7 || s[0] != '#') return false;
      int n;
      if (!int.TryParse(s.Substring(1), NumberStyles.HexNumber, CultureInfo.InvariantCulture, out n)) return false;
      r = (n >> 16) & 255; g = (n >> 8) & 255; b = n & 255;
      return true;
    }

    static IDictionary ReadAccent() {
      string w;
      long? abgr = SysCommon.ReadNumber("HKCU", AccentKey, "AccentColorMenu", out w);
      if (abgr == null) {
        string w2;
        long? dwm = SysCommon.ReadNumber("HKCU", Dwm, "AccentColor", out w2);
        if (dwm == null) return Json.Obj("value", null, "why", "Windows has no accent colour stored yet (" + w + "): its default blue applies");
        abgr = dwm;
      }
      long v = abgr.Value;
      return Json.Obj("value", Hex((int)(v & 255), (int)((v >> 8) & 255), (int)((v >> 16) & 255)), "why", null);
    }

    static bool HighContrast() {
      string w;
      object f = SysCommon.Read("HKCU", @"Control Panel\Accessibility\HighContrast", "Flags", out w);
      long n;
      string s = f as string;
      if (s != null && long.TryParse(s, NumberStyles.Integer, CultureInfo.InvariantCulture, out n)) return (n & 1) == 1;
      if (f is int) return (((int)f) & 1) == 1;
      return false;
    }

    static string Colors(Dictionary<string, object> req, ref object result) {
      var vals = new Dictionary<string, object>(StringComparer.Ordinal);
      foreach (Sw s in SWITCHES) if (!s.Key.StartsWith("usage.") && s.Key != "spotlight" && s.Key != "lockFacts") vals[s.Key] = ReadSw(s);
      IDictionary acc = ReadAccent();
      bool hc = HighContrast();
      result = Json.Obj("ok", true, "values", vals, "accent", acc["value"], "accentWhy", acc["why"], "highContrast", hc,
                        "locked", hc ? "a contrast theme is on (Accessibility > Contrast themes), and Windows ignores these colours while it is" : null,
                        "swatches", Swatches);
      return null;
    }

    /// Windows' own 48 accent swatches (Settings > Personalization > Colors), in its order.
    static readonly string[] Swatches = {
      "#FFB900", "#FF8C00", "#F7630C", "#CA5010", "#DA3B01", "#EF6950", "#D13438", "#FF4343",
      "#E74856", "#E81123", "#EA005E", "#C30052", "#E3008C", "#BF0077", "#C239B3", "#9A0089",
      "#0078D4", "#0063B1", "#8E8CD8", "#6B69D6", "#8764B8", "#744DA9", "#B146C2", "#881798",
      "#0099BC", "#2D7D9A", "#00B7C3", "#038387", "#00B294", "#018574", "#00CC6A", "#10893E",
      "#7A7574", "#5D5A58", "#68768A", "#515C6B", "#567C73", "#486860", "#498205", "#107C10",
      "#767676", "#4C4A48", "#69797E", "#4A5459", "#647C64", "#525E54", "#847545", "#7E735F" };

    /// The eight shades Windows keeps in AccentPalette (RGBA each): three lighter, the accent, three
    /// darker, and an eighth Windows keeps for itself (left as it was). Mantle mixes with white and
    /// black; Windows' own Settings may pick slightly different shades for the same colour.
    static byte[] Palette(int r, int g, int b, byte[] old) {
      double[] mix = { 0.6, 0.4, 0.2, 0, -0.2, -0.4, -0.6 };
      var p = new byte[32];
      for (int i = 0; i < 7; i++) {
        double m = mix[i];
        Func<int, byte> f = delegate(int c) { return (byte)Math.Round(m >= 0 ? c + (255 - c) * m : c * (1 + m)); };
        p[i * 4] = f(r); p[i * 4 + 1] = f(g); p[i * 4 + 2] = f(b); p[i * 4 + 3] = 0;
      }
      if (old != null && old.Length == 32) Array.Copy(old, 28, p, 28, 4);
      else { p[28] = 0x88; p[29] = 0x17; p[30] = 0x98; p[31] = 0; }
      return p;
    }
    static long Abgr(byte r, byte g, byte b) { return 0xFF000000L | ((long)b << 16) | ((long)g << 8) | r; }

    static string SetAccent(object raw, bool dry, ref object result) {
      int r, g, b;
      if (!ParseHex(raw, out r, out g, out b)) return "accent must be a colour like \"#0078D4\"";
      if (HighContrast()) return "Read only: a contrast theme is on, and Windows ignores the accent colour while it is";
      string before = (string)ReadAccent()["value"];
      string w;
      byte[] old = SysCommon.Read("HKCU", AccentKey, "AccentPalette", out w) as byte[];
      byte[] pal = Palette(r, g, b, old);
      long argb = 0xC4000000L + ((long)r << 16) + ((long)g << 8) + b;
      var writes = SysCommon.List(
        SysCommon.RegWrite("HKCU", AccentKey, "AccentColorMenu", Abgr((byte)r, (byte)g, (byte)b), false, null),
        SysCommon.RegWrite("HKCU", AccentKey, "StartColorMenu", Abgr(pal[16], pal[17], pal[18]), false, null),
        Json.Obj("api", "registry", "hive", "HKCU", "key", AccentKey, "name", "AccentPalette", "type", "REG_BINARY", "value", BitConverter.ToString(pal).Replace("-", "")),
        SysCommon.RegWrite("HKCU", Dwm, "AccentColor", Abgr((byte)r, (byte)g, (byte)b), false, null),
        SysCommon.RegWrite("HKCU", Dwm, "ColorizationColor", argb, false, null),
        SysCommon.RegWrite("HKCU", Dwm, "ColorizationAfterglow", argb, false, null),
        SysCommon.RegWrite("HKCU", Desk, "AutoColorization", 0, false, null),
        Json.Obj("api", "WM_SETTINGCHANGE", "value", "ImmersiveColorSet"));
      string would = "set the accent colour from " + (before ?? "Windows' default") + " to " + ((string)raw).ToUpperInvariant() +
                     " (7 values in your profile, then tell open apps)";
      if (dry) { result = Json.Obj("ok", true, "dryRun", true, "key", "accent", "from", before, "to", raw, "would", would, "writes", writes, "reason", null); return null; }
      if (Program.Passive) return SysCommon.Passive(would);
      string err = SysCommon.WriteNumber("HKCU", AccentKey, "AccentColorMenu", Abgr((byte)r, (byte)g, (byte)b), false)
        ?? SysCommon.WriteNumber("HKCU", AccentKey, "StartColorMenu", Abgr(pal[16], pal[17], pal[18]), false)
        ?? WriteBytes(AccentKey, "AccentPalette", pal)
        ?? SysCommon.WriteNumber("HKCU", Dwm, "AccentColor", Abgr((byte)r, (byte)g, (byte)b), false)
        ?? SysCommon.WriteNumber("HKCU", Dwm, "ColorizationColor", argb, false)
        ?? SysCommon.WriteNumber("HKCU", Dwm, "ColorizationAfterglow", argb, false)
        ?? WriteKeep(Desk, "AutoColorization", 0);
      if (err != null) return "perso.set accent: " + err;
      Broadcast("ImmersiveColorSet");
      result = Json.Obj("ok", true, "dryRun", false, "key", "accent", "from", before, "to", raw, "now", ReadAccent()["value"]);
      return null;
    }

    // ------------------------------------------------------------------ background (IDesktopWallpaper)
    [ComImport, Guid("B92B56A9-8B55-4E14-9A89-0199BBB6F93B"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IDesktopWallpaper {
      void SetWallpaper([MarshalAs(UnmanagedType.LPWStr)] string monitorID, [MarshalAs(UnmanagedType.LPWStr)] string wallpaper);
      [return: MarshalAs(UnmanagedType.LPWStr)] string GetWallpaper([MarshalAs(UnmanagedType.LPWStr)] string monitorID);
      [return: MarshalAs(UnmanagedType.LPWStr)] string GetMonitorDevicePathAt(uint monitorIndex);
      uint GetMonitorDevicePathCount();
      void GetMonitorRECT([MarshalAs(UnmanagedType.LPWStr)] string monitorID, IntPtr rect);   // unused: kept for the vtable order
      void SetBackgroundColor(uint color);
      uint GetBackgroundColor();
      void SetPosition(int position);
      int GetPosition();
      void SetSlideshow(IntPtr items);
      IntPtr GetSlideshow();
      void SetSlideshowOptions(int options, uint slideshowTick);
      void GetSlideshowOptions(out int options, out uint slideshowTick);
      void AdvanceSlideshow([MarshalAs(UnmanagedType.LPWStr)] string monitorID, int direction);
      int GetStatus();
      void Enable([MarshalAs(UnmanagedType.Bool)] bool enable);
    }
    static readonly Guid ClsidDesktopWallpaper = new Guid("C2CF3110-460E-4fc1-B9D0-8A1C0C9CC4BD");
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = true)]
    static extern int SHCreateItemFromParsingName(string path, IntPtr bc, ref Guid riid, out IntPtr item);
    [DllImport("shell32.dll", PreserveSig = true)]
    static extern int SHCreateShellItemArrayFromShellItem(IntPtr item, ref Guid riid, out IntPtr array);

    /// Runs `f` on its own STA thread (the shell's objects want one), 8 s at most. null = done.
    static string Sta(Action<IDesktopWallpaper> f) {
      string err = null;
      var th = new Thread(delegate() {
        object o = null;
        try {
          o = Activator.CreateInstance(Type.GetTypeFromCLSID(ClsidDesktopWallpaper));
          f((IDesktopWallpaper)o);
        } catch (Exception ex) { err = SysCommon.Why(ex); }
        finally { if (o != null) try { Marshal.ReleaseComObject(o); } catch (Exception) { } }
      });
      th.IsBackground = true;
      th.SetApartmentState(ApartmentState.STA);
      th.Start();
      if (!th.Join(8000)) return "the Windows desktop wallpaper service did not answer in 8 s";
      return err;
    }

    static readonly string[] Fits = { "center", "tile", "stretch", "fit", "fill", "span" };   // DWPOS_* 0..5
    static string FitOf(long? style, long? tile) {
      if (tile == 1) return "tile";
      if (style == null) return "fill";
      switch ((int)style.Value) { case 0: return "center"; case 2: return "stretch"; case 6: return "fit"; case 10: return "fill"; case 22: return "span"; }
      return null;
    }
    static readonly string[] PictureExt = { ".jpg", ".jpeg", ".jfif", ".png", ".bmp", ".dib", ".gif", ".tif", ".tiff", ".heic", ".webp", ".avif", ".jxr", ".wdp" };

    static string WallpaperLock() {
      string w;
      if (SysCommon.ReadNumber("HKCU", @"Software\Microsoft\Windows\CurrentVersion\Policies\ActiveDesktop", "NoChangingWallPaper", out w) == 1)
        return "a policy on this PC stops the background from being changed (NoChangingWallPaper)";
      if (SysCommon.ReadNumber("HKLM", @"SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\ActiveDesktop", "NoChangingWallPaper", out w) == 1)
        return "a policy on this PC stops the background from being changed (NoChangingWallPaper)";
      if (SysCommon.Read("HKCU", @"Software\Microsoft\Windows\CurrentVersion\Policies\System", "Wallpaper", out w) != null)
        return "a policy on this PC sets the background picture (Policies\\System Wallpaper)";
      return null;
    }

    static IDictionary ReadBackground() {
      string w;
      string pic = SysCommon.Read("HKCU", Desk, "Wallpaper", out w) as string;
      long? style = SysCommon.ReadNumber("HKCU", Desk, "WallpaperStyle", out w);
      long? tile = SysCommon.ReadNumber("HKCU", Desk, "TileWallpaper", out w);
      long? type = SysCommon.ReadNumber("HKCU", Wps, "BackgroundType", out w);
      string rgb = SysCommon.Read("HKCU", @"Control Panel\Colors", "Background", out w) as string;
      string color = null;
      if (rgb != null) {
        string[] p = rgb.Trim().Split(' ');
        int r, g, b;
        if (p.Length == 3 && int.TryParse(p[0], out r) && int.TryParse(p[1], out g) && int.TryParse(p[2], out b)) color = Hex(r & 255, g & 255, b & 255);
      }
      var recent = new List<object>();
      for (int i = 0; i < 5; i++) {
        string h = SysCommon.Read("HKCU", Wps, "BackgroundHistoryPath" + i, out w) as string;
        if (!string.IsNullOrEmpty(h)) recent.Add(Json.Obj("path", h, "exists", File.Exists(h)));
      }
      string kind = type == 1 ? "solid" : type == 2 ? "slideshow" : type == 3 ? "spotlight" : type == 0 ? "picture" : string.IsNullOrEmpty(pic) ? "solid" : "picture";
      uint monitors = 0; int status = 0, opts = 0; uint tick = 0;
      string comWhy = Sta(delegate(IDesktopWallpaper d) { monitors = d.GetMonitorDevicePathCount(); status = d.GetStatus(); d.GetSlideshowOptions(out opts, out tick); });
      string folder = SysCommon.Read("HKCU", Wps, "SlideshowDirectoryPath1", out w) as string;
      int lively = 0;
      try { foreach (string n in new[] { "Lively", "Lively.UI.WinUI", "Livelywpf" }) { Process[] ps = Process.GetProcessesByName(n); lively += ps.Length; foreach (Process x in ps) x.Dispose(); } } catch (Exception) { }
      return Json.Obj("kind", kind, "picture", string.IsNullOrEmpty(pic) ? null : pic, "pictureExists", !string.IsNullOrEmpty(pic) && File.Exists(pic),
                      "fit", FitOf(style, tile), "color", color, "recent", recent,
                      "slideshow", Json.Obj("on", (status & 2) == 2 || kind == "slideshow", "folder", folder, "shuffle", (opts & 1) == 1, "intervalMs", comWhy == null ? (object)(long)tick : null),
                      "monitors", comWhy == null ? (object)(long)monitors : null, "remoteOff", (status & 4) == 4, "serviceWhy", comWhy,
                      "livelyRunning", lively > 0, "locked", WallpaperLock());
    }

    static string Background(Dictionary<string, object> req, ref object result) {
      IDictionary b = ReadBackground();
      b["ok"] = true;
      b["fits"] = Fits;
      result = b;
      return null;
    }

    static string SetBackground(string key, object raw, bool dry, ref object result) {
      string lk = WallpaperLock();
      if (lk != null) return "Read only: " + lk;
      IDictionary cur = ReadBackground();
      string would; Action<IDesktopWallpaper> act; long? type = null;
      if (key == "fit") {
        int pos = Array.IndexOf(Fits, raw as string);
        if (pos < 0) return "fit must be one of " + string.Join(", ", Fits);
        would = "fit Windows' background picture as \"" + raw + "\" (was " + (cur["fit"] ?? "unknown") + ")";
        act = delegate(IDesktopWallpaper d) { d.SetPosition(pos); };
      } else if (key == "picture") {
        string p = raw as string;
        if (string.IsNullOrEmpty(p) || !Path.IsPathRooted(p)) return "picture must be a full path to a picture file";
        if (Array.IndexOf(PictureExt, Path.GetExtension(p).ToLowerInvariant()) < 0) return "Windows can only show a picture file as the background (jpg, png, bmp, gif, tif, heic, webp)";
        if (!File.Exists(p)) return "that picture file does not exist (or Mantle may not read it)";
        would = "show that picture as Windows' background";
        act = delegate(IDesktopWallpaper d) { d.Enable(true); d.SetWallpaper(null, p); };
        type = 0;
      } else if (key == "solid") {
        int r, g, b;
        if (!ParseHex(raw, out r, out g, out b)) return "solid must be a colour like \"#1F1F1F\"";
        uint cref = (uint)(r | (g << 8) | (b << 16));
        would = "show the solid colour " + ((string)raw).ToUpperInvariant() + " as Windows' background (was " + cur["kind"] + ")";
        act = delegate(IDesktopWallpaper d) { d.SetBackgroundColor(cref); d.Enable(false); };
        type = 1;
      } else if (key == "slideshow") {
        string f = raw as string;
        if (string.IsNullOrEmpty(f) || !Path.IsPathRooted(f) || !Directory.Exists(f)) return "slideshow must be a folder that exists";
        would = "play a slideshow of that folder as Windows' background";
        act = delegate(IDesktopWallpaper d) {
          Guid iItem = new Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"), iArr = new Guid("b63ea76d-1f85-456f-a19c-48159efa858b");
          IntPtr item, arr;
          int hr = SHCreateItemFromParsingName(f, IntPtr.Zero, ref iItem, out item);
          if (hr != 0) throw new COMException("the folder could not be opened", hr);
          try {
            hr = SHCreateShellItemArrayFromShellItem(item, ref iArr, out arr);
            if (hr != 0) throw new COMException("the folder could not be listed", hr);
            try { d.Enable(true); d.SetSlideshow(arr); } finally { Marshal.Release(arr); }
          } finally { Marshal.Release(item); }
        };
        type = 2;
      } else if (key == "shuffle" || key == "interval") {
        IDictionary ss = (IDictionary)cur["slideshow"];
        bool shuffle = (bool)ss["shuffle"];
        long tick = ss["intervalMs"] == null ? 1800000L : (long)ss["intervalMs"];
        if (key == "shuffle") { if (!(raw is bool)) return "shuffle must be true or false"; shuffle = (bool)raw; }
        else {
          if (!(raw is double) || (double)raw < 60000 || (double)raw > 86400000 || (double)raw != Math.Floor((double)raw)) return "interval must be whole milliseconds from 60000 (1 minute) to 86400000 (1 day)";
          tick = (long)(double)raw;
        }
        bool sh = shuffle; uint tk = (uint)tick;
        would = key == "shuffle" ? "turn slideshow shuffle " + (shuffle ? "on" : "off") : "change the picture every " + (tick / 60000) + " min";
        act = delegate(IDesktopWallpaper d) { d.SetSlideshowOptions(sh ? 1 : 0, tk); };
      } else return "perso.set: unknown key \"" + key + "\"";
      var writes = SysCommon.List(Json.Obj("api", "IDesktopWallpaper", "key", key, "value", raw));
      if (type != null) writes.Add(SysCommon.RegWrite("HKCU", Wps, "BackgroundType", type.Value, false, null));
      if (dry) { result = Json.Obj("ok", true, "dryRun", true, "key", key, "to", raw, "would", would, "writes", writes, "reason", null); return null; }
      if (Program.Passive) return SysCommon.Passive(would);
      string err = Sta(act);
      if (err != null) return "Windows did not change the background (" + err + ")";
      if (type != null) WriteKeep(Wps, "BackgroundType", type.Value);   // Windows' Settings reads its choice from here
      IDictionary now = ReadBackground();
      object nowVal = key == "fit" ? now["fit"] : key == "solid" ? now["color"] : key == "picture" ? now["picture"] : raw;
      result = Json.Obj("ok", true, "dryRun", false, "key", key, "to", raw, "now", nowVal, "background", now);
      return null;
    }

    // ------------------------------------------------------------------ themes, lock screen, the rest
    [DllImport("shlwapi.dll", CharSet = CharSet.Unicode)]
    static extern int SHLoadIndirectString(string src, StringBuilder buf, int size, IntPtr reserved);

    static string ThemeName(string file) {
      try {
        foreach (string line in File.ReadAllLines(file)) {
          string l = line.Trim();
          if (!l.StartsWith("DisplayName=", StringComparison.OrdinalIgnoreCase)) continue;
          string v = l.Substring(12).Trim();
          if (v.StartsWith("@")) {
            var sb = new StringBuilder(260);
            if (SHLoadIndirectString(Environment.ExpandEnvironmentVariables(v), sb, sb.Capacity, IntPtr.Zero) == 0 && sb.Length > 0) return sb.ToString();
            break;
          }
          if (v.Length > 0) return v;
        }
      } catch (Exception) { }
      return Path.GetFileNameWithoutExtension(file);
    }

    static IDictionary ReadThemes() {
      string w;
      string cur = SysCommon.Read("HKCU", ThemesKey, "CurrentTheme", out w) as string;
      var list = new List<object>();
      string[][] dirs = {
        new[] { Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"Microsoft\Windows\Themes"), "user" },
        new[] { Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows), @"Resources\Themes"), "windows" } };
      string why = null;
      foreach (string[] d in dirs) {
        try {
          if (!Directory.Exists(d[0])) continue;
          foreach (string f in Directory.GetFiles(d[0], "*.theme"))
            list.Add(Json.Obj("name", ThemeName(f), "file", f, "scope", d[1], "current", cur != null && string.Equals(Path.GetFullPath(f), SafeFull(cur), StringComparison.OrdinalIgnoreCase)));
        } catch (Exception ex) { why = "a themes folder could not be read: " + SysCommon.Why(ex); }
      }
      return Json.Obj("current", cur, "list", list, "why", why,
        "applyWhy", "Windows applies a whole theme only through its own theme service (an undocumented interface in themeui.dll that opens Windows Settings), so Mantle shows the themes and sets their parts (colours, background) on those pages instead");
    }
    static string SafeFull(string p) { try { return Path.GetFullPath(Environment.ExpandEnvironmentVariables(p)); } catch (Exception) { return p; } }

    static string More(Dictionary<string, object> req, ref object result) {
      string w;
      var usage = new Dictionary<string, object>(StringComparer.Ordinal);
      foreach (string u in Uses) usage[u] = ReadSw(FindSw("usage." + u));
      long? logon = SysCommon.ReadNumber("HKLM", @"SOFTWARE\Policies\Microsoft\Windows\System", "DisableLogonBackgroundImage", out w);
      var lighting = new Dictionary<string, object>(StringComparer.Ordinal);
      bool litPresent = false;
      foreach (string n in new[] { "AmbientLightingEnabled", "ControlledByForegroundApp", "UseSystemAccentColor", "Brightness", "EffectType", "Speed" }) {
        long? v = SysCommon.ReadNumber("HKCU", LightKey, n, out w);
        lighting[n] = v;
        if (v != null) litPresent = true;
      }
      var tip = new Dictionary<string, object>(StringComparer.Ordinal);
      foreach (string n in new[] { "SelectedThemeIndex", "SelectedThemeName", "KeyboardSizeSetting", "IsKeyBackgroundEnabled" }) tip[n] = SysCommon.Read("HKCU", TipKey, n, out w);
      result = Json.Obj("ok", true,
        "themes", ReadThemes(),
        "lock", Json.Obj("spotlight", ReadSw(FindSw("spotlight")), "facts", ReadSw(FindSw("lockFacts")),
                         "signin", Json.Obj("policyOff", logon == 1, "why", logon == 1 ? "a policy on this PC hides the lock screen picture on the sign-in screen (DisableLogonBackgroundImage = 1)"
                           : "Windows keeps this switch in a protected per-user store (SystemProtectedUserData) that only its own Settings may write"),
                         "statusWhy", "Windows keeps the lock screen status app in a protected per-user store that only its own Settings may write"),
        "usage", usage, "usageWhy", UsageWhy,
        "lighting", Json.Obj("present", litPresent, "values", lighting,
                             "why", "Windows drives Dynamic Lighting through its own lighting service and WinRT LampArray devices, which this Mantle build cannot reach; changing the stored values would not reach your devices"),
        "touchKeyboard", Json.Obj("values", tip, "why", "Windows keeps the touch keyboard theme and key size in TabletTip values it does not document, and only its own touch keyboard reads them; Mantle shows them read-only"));
      return null;
    }

    // ------------------------------------------------------------------ writes
    /// Device usage: Windows stores an Intent value and a Priority per use (CloudExperienceHost), but
    /// does not document what its own Settings writes when a use is switched (MEASURED here: all seven
    /// read Intent = 1 with priorities 1..7), so Mantle shows what is stored and does not change it.
    public const string UsageWhy = "Windows keeps device usage in CloudExperienceHost values it does not document (each use stores an intent and a priority), so Mantle shows what is stored and does not guess at a change";
    static readonly string[] BgKeys ={ "fit", "picture", "solid", "slideshow", "shuffle", "interval" };

    static string Set(Dictionary<string, object> req, ref object result) {
      string key = Json.GetString(req, "key");
      if (string.IsNullOrEmpty(key)) return "perso.set needs key (e.g. \"appsLight\")";
      object raw;
      if (!Json.TryGet(req, "value", out raw)) return "perso.set needs value";
      bool dry = Json.GetBool(req, "dryRun", false);
      if (key == "accent") return SetAccent(raw, dry, ref result);
      if (Array.IndexOf(BgKeys, key) >= 0) return SetBackground(key, raw, dry, ref result);
      if (key.StartsWith("usage.")) return "Read only: " + UsageWhy;
      Sw s = FindSw(key);
      if (s == null) return "perso.set: unknown key \"" + key + "\"";
      if (!(raw is bool)) return key + " must be true or false";
      bool on = (bool)raw;
      if (s.Bc != null && HighContrast()) return "Read only: a contrast theme is on, and Windows ignores these colours while it is";
      bool before = (bool)ReadSw(s)["on"];
      var writes = new List<object>();
      for (int i = 0; i < s.Names.Length; i++) {
        string w;
        writes.Add(SysCommon.RegWrite("HKCU", s.Paths[i], s.Names[i], on ? s.On[i] : s.Off[i], false, SysCommon.ReadNumber("HKCU", s.Paths[i], s.Names[i], out w)));
      }
      if (s.Bc != null) writes.Add(Json.Obj("api", "WM_SETTINGCHANGE", "value", s.Bc));
      string would = (on ? "" : "stop: ") + s.Words + " (" + s.Names.Length + " value" + (s.Names.Length == 1 ? "" : "s") + " in your profile" + (s.Bc != null ? ", then tell open apps" : "") + ")";
      if (dry) { result = Json.Obj("ok", true, "dryRun", true, "key", key, "from", before, "to", on, "would", would, "writes", writes, "reason", null); return null; }
      if (Program.Passive) return SysCommon.Passive(would);
      for (int i = 0; i < s.Names.Length; i++) {
        string err = WriteKeep(s.Paths[i], s.Names[i], on ? s.On[i] : s.Off[i]);
        if (err != null) return "perso.set " + key + ": " + err + (i > 0 ? " (after " + i + " of " + s.Names.Length + " values were written)" : "");
      }
      if (s.Bc != null) Broadcast(s.Bc);
      result = Json.Obj("ok", true, "dryRun", false, "key", key, "from", before, "to", on, "now", ReadSw(s)["on"]);
      return null;
    }
  }
}

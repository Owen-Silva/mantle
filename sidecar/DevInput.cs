// DevInput.cs - Mouse, Keyboard, Touchpad and Pen for Mantle Settings (lane devnet, 2026-09-28).
//
// WHY: the user wants Mantle Settings to replace Windows' Settings outright ("it should do everything
// windows can do and more and not ever rely on any old windows feature"). Bluetooth & devices >
// Mouse / Keyboard / Touchpad / Pen are all per-user values that Windows keeps behind
// SystemParametersInfo, so this file reads and writes them the way Settings and main.cpl do: the
// SPI_GET* read, the SPI_SET* write with SPIF_UPDATEINIFILE | SPIF_SENDCHANGE (saved to the
// profile, and every running app told). No registry poking where an SPI exists: a registry value
// alone would not reach the running session.
//
//   devinput.get                       every value below, the touchpad and pen (present or why not)
//   devinput.set {key, value, dryRun?} ONE value. dryRun validates, reads the current value and says
//                                      what it would do; nothing is written. Passive refuses the real
//                                      write (a test must never change the user's mouse or keyboard).
//
// KEYS (value type, range):
//   mouse.primary 'left'|'right'   mouse.speed 1-20          mouse.enhancePrecision bool
//   mouse.scrollLines 1-100|'page' mouse.scrollChars 1-100   mouse.scrollInactive bool
//   mouse.doubleClickMs 200-900    mouse.trails 0|2-7        mouse.vanish bool   mouse.sonar bool
//   mouse.snapToDefault bool       mouse.clickLock bool
//   keyboard.repeatDelay 0-3 (250 ms steps from 250)  keyboard.repeatRate 0-31 (about 2.5-30 a s)
//   keyboard.caretBlinkMs 200-1200|'off'
//   touchpad.enabled / .whenMouse / .tap / .tapDrag / .twoFingerTap / .rightClickZone / .pan /
//   .zoom / .scrollReversed bool, touchpad.sensitivity 0-4 (most .. least sensitive), touchpad.speed 1-20
//
// THE TOUCHPAD: SPI_GETTOUCHPADPARAMETERS / SPI_SETTOUCHPADPARAMETERS (0x00AE / 0x00AF) with a
// TOUCHPAD_PARAMETERS v1 block (44 bytes, two BOOL bitfield words), the documented route Settings
// uses since Windows 11 24H2. A PC without a precision touchpad answers present:false and every
// touchpad.* write says so.
// THE PEN: GetSystemMetrics(SM_DIGITIZER). Present or not, with the digitizer flags in words.
//
// MEASURED on the user's desktop, 2026-09-28 (reads only): see the test sidecar/test-devinput.js.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Runtime.InteropServices;
using Microsoft.Win32;

namespace Mantle {
  [MantleFeature]
  static class DevInput {
    public static void Register(FeatureTable t) {
      t.Add("devinput.get", Lanes.Ui, Get);     // SPI reads: microseconds
      t.Add("devinput.set", Lanes.Slow, Set);   // SPIF_SENDCHANGE broadcasts WM_SETTINGCHANGE: may wait on a slow app
    }

    // ------------------------------------------------------------------ native

    static class Native {
      [DllImport("user32.dll", SetLastError = true)] public static extern bool SystemParametersInfoW(uint action, uint uiParam, ref int pv, uint winIni);
      [DllImport("user32.dll", SetLastError = true)] public static extern bool SystemParametersInfoW(uint action, uint uiParam, int[] pv, uint winIni);
      [DllImport("user32.dll", SetLastError = true)] public static extern bool SystemParametersInfoW(uint action, uint uiParam, IntPtr pv, uint winIni);
      [DllImport("user32.dll", SetLastError = true)] public static extern bool SystemParametersInfoW(uint action, uint uiParam, byte[] pv, uint winIni);
      [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
      [DllImport("user32.dll")] public static extern uint GetDoubleClickTime();
      [DllImport("user32.dll")] public static extern uint GetCaretBlinkTime();
      [DllImport("user32.dll", SetLastError = true)] public static extern bool SetCaretBlinkTime(uint ms);
      [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
      public static extern IntPtr SendMessageTimeoutW(IntPtr hwnd, uint msg, IntPtr wp, string lp, uint flags, uint timeout, out IntPtr res);
    }

    const uint SPIF = 0x01 | 0x02;               // SPIF_UPDATEINIFILE | SPIF_SENDCHANGE
    const uint SPI_GETMOUSE = 0x0003, SPI_SETMOUSE = 0x0004;
    const uint SPI_GETKEYBOARDSPEED = 0x000A, SPI_SETKEYBOARDSPEED = 0x000B;
    const uint SPI_GETKEYBOARDDELAY = 0x0016, SPI_SETKEYBOARDDELAY = 0x0017;
    const uint SPI_SETDOUBLECLICKTIME = 0x0020, SPI_SETMOUSEBUTTONSWAP = 0x0021;
    const uint SPI_GETMOUSETRAILS = 0x005E, SPI_SETMOUSETRAILS = 0x005D;
    const uint SPI_GETSNAPTODEFBUTTON = 0x005F, SPI_SETSNAPTODEFBUTTON = 0x0060;
    const uint SPI_GETWHEELSCROLLLINES = 0x0068, SPI_SETWHEELSCROLLLINES = 0x0069;
    const uint SPI_GETWHEELSCROLLCHARS = 0x006C, SPI_SETWHEELSCROLLCHARS = 0x006D;
    const uint SPI_GETMOUSESPEED = 0x0070, SPI_SETMOUSESPEED = 0x0071;
    const uint SPI_GETTOUCHPADPARAMETERS = 0x00AE, SPI_SETTOUCHPADPARAMETERS = 0x00AF;
    const uint SPI_GETMOUSESONAR = 0x101C, SPI_SETMOUSESONAR = 0x101D;
    const uint SPI_GETMOUSECLICKLOCK = 0x101E, SPI_SETMOUSECLICKLOCK = 0x101F;
    const uint SPI_GETMOUSEVANISH = 0x1020, SPI_SETMOUSEVANISH = 0x1021;
    const uint SPI_GETMOUSEWHEELROUTING = 0x201C, SPI_SETMOUSEWHEELROUTING = 0x201D;
    const int SM_SWAPBUTTON = 23, SM_MOUSEPRESENT = 19, SM_CMOUSEBUTTONS = 43, SM_MOUSEWHEELPRESENT = 75;
    const int SM_DIGITIZER = 94, SM_MAXIMUMTOUCHES = 95;
    const uint WHEEL_PAGESCROLL = 0xFFFFFFFF;
    const int TP_SIZE = 44;                      // TOUCHPAD_PARAMETERS_V1

    // ------------------------------------------------------------------ reads

    static string Err(string what) {
      return what + " failed (Windows error " + Marshal.GetLastWin32Error().ToString(CultureInfo.InvariantCulture) + ")";
    }

    static bool GetInt(uint spi, out int v, out string why) {
      v = 0; why = null;
      if (Native.SystemParametersInfoW(spi, 0, ref v, 0)) return true;
      why = Err("SystemParametersInfo 0x" + spi.ToString("X4", CultureInfo.InvariantCulture));
      return false;
    }

    /// Every mouse and keyboard value by key. A read that failed is absent from `values` and
    /// named in `problems` (never a made-up default).
    static Dictionary<string, object> ReadAll(List<object> problems) {
      var v = new Dictionary<string, object>(StringComparer.Ordinal);
      string why; int n;
      v["mouse.primary"] = Native.GetSystemMetrics(SM_SWAPBUTTON) != 0 ? "right" : "left";
      if (GetInt(SPI_GETMOUSESPEED, out n, out why)) v["mouse.speed"] = n; else problems.Add("mouse.speed: " + why);
      int[] acc = new int[3];
      if (Native.SystemParametersInfoW(SPI_GETMOUSE, 0, acc, 0)) v["mouse.enhancePrecision"] = acc[2] != 0;
      else problems.Add("mouse.enhancePrecision: " + Err("SPI_GETMOUSE"));
      if (GetInt(SPI_GETWHEELSCROLLLINES, out n, out why)) v["mouse.scrollLines"] = (uint)n == WHEEL_PAGESCROLL ? (object)"page" : n;
      else problems.Add("mouse.scrollLines: " + why);
      if (GetInt(SPI_GETWHEELSCROLLCHARS, out n, out why)) v["mouse.scrollChars"] = n; else problems.Add("mouse.scrollChars: " + why);
      if (GetInt(SPI_GETMOUSEWHEELROUTING, out n, out why)) v["mouse.scrollInactive"] = n == 2;
      else problems.Add("mouse.scrollInactive: " + why);
      v["mouse.doubleClickMs"] = (int)Native.GetDoubleClickTime();
      if (GetInt(SPI_GETMOUSETRAILS, out n, out why)) v["mouse.trails"] = n <= 1 ? 0 : n; else problems.Add("mouse.trails: " + why);
      if (GetInt(SPI_GETMOUSEVANISH, out n, out why)) v["mouse.vanish"] = n != 0; else problems.Add("mouse.vanish: " + why);
      if (GetInt(SPI_GETMOUSESONAR, out n, out why)) v["mouse.sonar"] = n != 0; else problems.Add("mouse.sonar: " + why);
      if (GetInt(SPI_GETSNAPTODEFBUTTON, out n, out why)) v["mouse.snapToDefault"] = n != 0; else problems.Add("mouse.snapToDefault: " + why);
      if (GetInt(SPI_GETMOUSECLICKLOCK, out n, out why)) v["mouse.clickLock"] = n != 0; else problems.Add("mouse.clickLock: " + why);
      if (GetInt(SPI_GETKEYBOARDDELAY, out n, out why)) v["keyboard.repeatDelay"] = n; else problems.Add("keyboard.repeatDelay: " + why);
      if (GetInt(SPI_GETKEYBOARDSPEED, out n, out why)) v["keyboard.repeatRate"] = n; else problems.Add("keyboard.repeatRate: " + why);
      uint blink = Native.GetCaretBlinkTime();
      v["keyboard.caretBlinkMs"] = blink == 0xFFFFFFFF ? (object)"off" : (int)blink;
      return v;
    }

    /// The touchpad block, or null with `why` (no precision touchpad, or Windows refused the query).
    static byte[] ReadTouchpad(out string why) {
      why = null;
      var b = new byte[TP_SIZE];
      BitConverter.GetBytes(1u).CopyTo(b, 0);       // versionNumber = TOUCHPAD_PARAMETERS_LATEST_VERSION
      if (!Native.SystemParametersInfoW(SPI_GETTOUCHPADPARAMETERS, (uint)TP_SIZE, b, 0)) {
        why = "Windows did not answer the touchpad query (" + Err("SPI_GETTOUCHPADPARAMETERS") +
              "); it exists from Windows 11 24H2";
        return null;
      }
      return b;
    }

    static int U(byte[] b, int off) { return BitConverter.ToInt32(b, off); }
    static bool Bit(byte[] b, int word, int bit) { return ((U(b, word) >> bit) & 1) != 0; }
    static void SetBit(byte[] b, int word, int bit, bool on) {
      int w = U(b, word);
      w = on ? (w | (1 << bit)) : (w & ~(1 << bit));
      BitConverter.GetBytes(w).CopyTo(b, word);
    }

    // The touchpad keys: the bitfield word (12 = the "present" word, 16 = the settings word) and bit.
    static readonly string[] TpBoolKeys = { "touchpad.enabled", "touchpad.whenMouse", "touchpad.tap", "touchpad.tapDrag",
      "touchpad.twoFingerTap", "touchpad.rightClickZone", "touchpad.pan", "touchpad.zoom", "touchpad.scrollReversed" };
    static readonly int[] TpWord = { 12, 16, 16, 16, 16, 16, 16, 16, 16 };
    static readonly int[] TpBit = { 3, 0, 2, 3, 4, 5, 7, 8, 9 };
    static readonly string[] Sensitivity = { "most sensitive", "high", "medium", "low", "least sensitive" };

    static IDictionary TouchpadJson(byte[] b, string why) {
      if (b == null) return Json.Obj("present", false, "reason", why);
      bool present = Bit(b, 12, 0);
      if (!present) {
        bool legacy = Bit(b, 12, 1);
        return Json.Obj("present", false, "legacy", legacy, "reason", legacy
          ? "this touchpad is not a precision touchpad, so Windows offers none of its settings (its maker's own app sets it)"
          : "this PC has no touchpad");
      }
      var values = new Dictionary<string, object>(StringComparer.Ordinal);
      for (int i = 0; i < TpBoolKeys.Length; i++) values[TpBoolKeys[i]] = Bit(b, TpWord[i], TpBit[i]);
      int sens = U(b, 20);
      values["touchpad.sensitivity"] = sens;
      values["touchpad.speed"] = U(b, 24);
      return Json.Obj("present", true, "active", Bit(b, 12, 4), "mousePresent", Bit(b, 12, 2),
                      "maxContacts", U(b, 4), "sensitivityWords", sens >= 0 && sens < Sensitivity.Length ? Sensitivity[sens] : null,
                      "values", values, "reason", null);
    }

    static IDictionary PenJson() {
      int d = Native.GetSystemMetrics(SM_DIGITIZER);
      bool ready = (d & 0x80) != 0;
      bool pen = (d & 0x04) != 0 || (d & 0x08) != 0;
      bool touch = (d & 0x01) != 0 || (d & 0x02) != 0;
      return Json.Obj("present", pen, "touch", touch, "ready", ready,
                      "maxTouches", Native.GetSystemMetrics(SM_MAXIMUMTOUCHES),
                      "reason", pen ? null : "no pen digitizer on this PC (GetSystemMetrics SM_DIGITIZER lists none), so there is nothing to set");
    }

    static string Get(Dictionary<string, object> req, ref object result) {
      var problems = new List<object>();
      Dictionary<string, object> values = ReadAll(problems);
      string tpWhy;
      byte[] tp = ReadTouchpad(out tpWhy);
      result = Json.Obj("ok", true, "values", values,
                        "mouse", Json.Obj("present", Native.GetSystemMetrics(SM_MOUSEPRESENT) != 0,
                                          "buttons", Native.GetSystemMetrics(SM_CMOUSEBUTTONS),
                                          "wheel", Native.GetSystemMetrics(SM_MOUSEWHEELPRESENT) != 0),
                        "touchpad", TouchpadJson(tp, tpWhy), "pen", PenJson(),
                        "problems", problems, "reason", problems.Count == 0 ? null : problems.Count + " value(s) could not be read");
      return null;
    }

    // ------------------------------------------------------------------ the write

    /// Plain-words validation of `value` for `key`; `norm` is the value as the write takes it.
    static string Check(string key, object value, out object norm) {
      norm = null;
      switch (key) {
        case "mouse.primary":
          if (value as string == "left" || value as string == "right") { norm = value; return null; }
          return "mouse.primary must be \"left\" or \"right\"";
        case "mouse.scrollLines":
          if (value as string == "page") { norm = "page"; return null; }
          return Range(key, value, 1, 100, out norm, " or \"page\" (one screen at a time)");
        case "keyboard.caretBlinkMs":
          if (value as string == "off") { norm = "off"; return null; }
          return Range(key, value, 200, 1200, out norm, " or \"off\"");
        case "mouse.speed": return Range(key, value, 1, 20, out norm, "");
        case "mouse.scrollChars": return Range(key, value, 1, 100, out norm, "");
        case "mouse.doubleClickMs": return Range(key, value, 200, 900, out norm, "");
        case "mouse.trails": {
          string e = Range(key, value, 0, 7, out norm, " (0 = off, 2-7 = trail length)");
          if (e == null && (int)norm == 1) return "mouse.trails: 1 is not a trail length; use 0 (off) or 2-7";
          return e;
        }
        case "keyboard.repeatDelay": return Range(key, value, 0, 3, out norm, " (0 = shortest, 3 = longest)");
        case "keyboard.repeatRate": return Range(key, value, 0, 31, out norm, " (0 = slowest, 31 = fastest)");
        case "touchpad.sensitivity": return Range(key, value, 0, 4, out norm, " (0 = most sensitive, 4 = least)");
        case "touchpad.speed": return Range(key, value, 1, 20, out norm, "");
        case "mouse.enhancePrecision": case "mouse.scrollInactive": case "mouse.vanish": case "mouse.sonar":
        case "mouse.snapToDefault": case "mouse.clickLock":
          if (value is bool) { norm = value; return null; }
          return key + " must be true or false";
        default:
          if (Array.IndexOf(TpBoolKeys, key) >= 0) {
            if (value is bool) { norm = value; return null; }
            return key + " must be true or false";
          }
          return "devinput.set: unknown key \"" + key + "\"";
      }
    }

    static string Range(string key, object value, int min, int max, out object norm, string more) {
      norm = null;
      if (!(value is double)) return key + " must be a whole number from " + min + " to " + max + more;
      double d = (double)value;
      if (d != Math.Floor(d) || d < min || d > max) return key + " must be a whole number from " + min + " to " + max + more;
      norm = (int)d;
      return null;
    }

    static string Words(string key) {
      switch (key) {
        case "mouse.primary": return "the primary mouse button";
        case "mouse.speed": return "the pointer speed";
        case "mouse.enhancePrecision": return "enhance pointer precision";
        case "mouse.scrollLines": return "the lines scrolled per wheel notch";
        case "mouse.scrollChars": return "the characters scrolled per sideways tilt";
        case "mouse.scrollInactive": return "scroll inactive windows when hovering over them";
        case "mouse.doubleClickMs": return "the double-click speed (ms)";
        case "mouse.trails": return "pointer trails";
        case "mouse.vanish": return "hide the pointer while typing";
        case "mouse.sonar": return "show the pointer's location when Ctrl is pressed";
        case "mouse.snapToDefault": return "snap the pointer to the default button";
        case "mouse.clickLock": return "ClickLock";
        case "keyboard.repeatDelay": return "the key repeat delay";
        case "keyboard.repeatRate": return "the key repeat rate";
        case "keyboard.caretBlinkMs": return "the cursor blink rate (ms)";
        case "touchpad.sensitivity": return "the touchpad sensitivity";
        case "touchpad.speed": return "the touchpad cursor speed";
        default: return key.Replace("touchpad.", "the touchpad setting ");
      }
    }

    static string Set(Dictionary<string, object> req, ref object result) {
      string key = Json.GetString(req, "key");
      if (string.IsNullOrEmpty(key)) return "devinput.set needs key (e.g. \"mouse.speed\")";
      object raw;
      if (!Json.TryGet(req, "value", out raw)) return "devinput.set needs value";
      object val;
      string bad = Check(key, raw, out val);
      if (bad != null) return bad;
      bool dry = Json.GetBool(req, "dryRun", false);

      object before = null;
      byte[] tp = null;
      if (key.StartsWith("touchpad.", StringComparison.Ordinal)) {
        string why;
        tp = ReadTouchpad(out why);
        if (tp == null) return "devinput.set " + key + ": " + why;
        IDictionary tj = TouchpadJson(tp, null);
        if (!Bit(tp, 12, 0)) return "devinput.set " + key + ": " + (string)tj["reason"];
        before = ((IDictionary)tj["values"])[key];
      } else {
        var problems = new List<object>();
        Dictionary<string, object> now = ReadAll(problems);
        if (!now.TryGetValue(key, out before))
          return "devinput.set " + key + ": its current value could not be read, so it is not changed (" + string.Join("; ", problems.ConvertAll(p => (string)p).ToArray()) + ")";
      }

      string would = "set " + Words(key) + " from " + Show(before) + " to " + Show(val) + ", saved to your profile and announced to running apps";
      if (dry) {
        result = Json.Obj("ok", true, "dryRun", true, "key", key, "from", before, "to", val, "would", would, "reason", null);
        return null;
      }
      if (Program.Passive) return FeatureTable.PassiveRefusal + ": devinput.set would " + would;

      string err = tp != null ? WriteTouchpad(tp, key, val) : Write(key, val);
      if (err != null) return "devinput.set " + key + ": " + err;
      var after = new List<object>();
      object now2 = null;
      if (tp != null) {
        string why2;
        byte[] tp2 = ReadTouchpad(out why2);
        if (tp2 != null) now2 = ((IDictionary)TouchpadJson(tp2, null)["values"])[key];
      } else ReadAll(after).TryGetValue(key, out now2);
      result = Json.Obj("ok", true, "dryRun", false, "key", key, "from", before, "to", val, "now", now2,
                        "reason", Equals(Show(now2), Show(val)) ? null : "Windows took the change but reads back " + Show(now2));
      return null;
    }

    static string Show(object v) {
      if (v == null) return "(unread)";
      if (v is bool) return (bool)v ? "on" : "off";
      if (v is string) return (string)v;
      return Convert.ToString(v, CultureInfo.InvariantCulture);
    }

    static string Spi(uint spi, uint ui, IntPtr pv) {
      return Native.SystemParametersInfoW(spi, ui, pv, SPIF) ? null : Err("SystemParametersInfo 0x" + spi.ToString("X4", CultureInfo.InvariantCulture));
    }

    static string Write(string key, object val) {
      switch (key) {
        case "mouse.primary": return Spi(SPI_SETMOUSEBUTTONSWAP, (string)val == "right" ? 1u : 0u, IntPtr.Zero);
        case "mouse.speed": return Spi(SPI_SETMOUSESPEED, 0, new IntPtr((int)val));
        case "mouse.enhancePrecision": {
          // What main.cpl writes: thresholds 6/10 with acceleration on, 0/0/0 with it off.
          int[] acc = (bool)val ? new int[] { 6, 10, 1 } : new int[] { 0, 0, 0 };
          return Native.SystemParametersInfoW(SPI_SETMOUSE, 0, acc, SPIF) ? null : Err("SPI_SETMOUSE");
        }
        case "mouse.scrollLines": return Spi(SPI_SETWHEELSCROLLLINES, val is string ? WHEEL_PAGESCROLL : (uint)(int)val, IntPtr.Zero);
        case "mouse.scrollChars": return Spi(SPI_SETWHEELSCROLLCHARS, (uint)(int)val, IntPtr.Zero);
        // 2 = MOUSEWHEEL_ROUTING_MOUSE_POS (Settings' "on"), 0 = MOUSEWHEEL_ROUTING_FOCUS ("off").
        case "mouse.scrollInactive": return Spi(SPI_SETMOUSEWHEELROUTING, 0, new IntPtr((bool)val ? 2 : 0));
        case "mouse.doubleClickMs": return Spi(SPI_SETDOUBLECLICKTIME, (uint)(int)val, IntPtr.Zero);
        case "mouse.trails": return Spi(SPI_SETMOUSETRAILS, (uint)(int)val, IntPtr.Zero);
        case "mouse.vanish": return Spi(SPI_SETMOUSEVANISH, 0, new IntPtr((bool)val ? 1 : 0));
        case "mouse.sonar": return Spi(SPI_SETMOUSESONAR, 0, new IntPtr((bool)val ? 1 : 0));
        case "mouse.snapToDefault": return Spi(SPI_SETSNAPTODEFBUTTON, (bool)val ? 1u : 0u, IntPtr.Zero);
        case "mouse.clickLock": return Spi(SPI_SETMOUSECLICKLOCK, 0, new IntPtr((bool)val ? 1 : 0));
        case "keyboard.repeatDelay": return Spi(SPI_SETKEYBOARDDELAY, (uint)(int)val, IntPtr.Zero);
        case "keyboard.repeatRate": return Spi(SPI_SETKEYBOARDSPEED, (uint)(int)val, IntPtr.Zero);
        case "keyboard.caretBlinkMs": {
          // SetCaretBlinkTime lasts for the session only; main.cpl also saves CursorBlinkRate
          // (a string, "-1" = no blinking) and broadcasts, so the next sign-in keeps it.
          uint ms = val is string ? 0xFFFFFFFF : (uint)(int)val;
          if (!Native.SetCaretBlinkTime(ms)) return Err("SetCaretBlinkTime");
          try {
            using (RegistryKey k = Registry.CurrentUser.CreateSubKey(@"Control Panel\Desktop"))
              k.SetValue("CursorBlinkRate", val is string ? "-1" : ms.ToString(CultureInfo.InvariantCulture), RegistryValueKind.String);
          } catch (Exception ex) {
            return "the blink rate changed for this session but could not be saved (" + ex.Message + ")";
          }
          IntPtr res;
          Native.SendMessageTimeoutW(new IntPtr(0xFFFF), 0x001A, IntPtr.Zero, "Control Panel", 0x0002, 1000, out res);
          return null;
        }
      }
      return "no writer for " + key;
    }

    static string WriteTouchpad(byte[] tp, string key, object val) {
      int i = Array.IndexOf(TpBoolKeys, key);
      if (i >= 0) SetBit(tp, TpWord[i], TpBit[i], (bool)val);
      else if (key == "touchpad.sensitivity") BitConverter.GetBytes((int)val).CopyTo(tp, 20);
      else if (key == "touchpad.speed") BitConverter.GetBytes((int)val).CopyTo(tp, 24);
      else return "no writer for " + key;
      return Native.SystemParametersInfoW(SPI_SETTOUCHPADPARAMETERS, (uint)TP_SIZE, tp, SPIF) ? null : Err("SPI_SETTOUCHPADPARAMETERS");
    }
  }
}

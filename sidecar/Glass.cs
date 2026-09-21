// Glass.cs - real blur behind Mantle's OWN windows.
//
// WHY THIS IS NOT ELECTRON'S JOB. Electron has `backgroundMaterial: 'acrylic'`,
// which asks DWM for a system backdrop. DWM paints a system backdrop only on
// the ACTIVE window. Mantle's bar must never take focus - a bar that steals
// activation from whatever you are typing in is worse than no bar - so it is
// permanently inactive, and the acrylic rendered as a flat solid.
//
// SetWindowCompositionAttribute with an ACCENT_POLICY is the older, undocumented
// path (TranslucentTB and electron-acrylic-window both live on it) and it
// renders on inactive windows. That is the whole reason it is here.
//
// SCOPE, and why passive mode allows it: this only ever touches a window handle
// the caller already owns - Mantle's own bar, launcher or desktop layer. It
// changes nothing about the shell, holds no state, and dies with the window. A
// hwnd of 0 or a window that does not exist is refused with plain words; that
// is the only refusal here.
using System;
using System.Globalization;
using System.Runtime.InteropServices;

namespace Mantle {
  static class Glass {
    /// The tint used when the caller gives none: a 60% black wash, which is
    /// what makes text on a bar readable over a bright wallpaper. Documented in
    /// the README so nobody has to read it out of here.
    const uint DefaultTint = 0x99000000;

    /// Returns null on success (with `applied` and `usedMode` filled), or a
    /// plain-words reason.
    public static string Apply(IntPtr hwnd, string mode, string tint, out bool applied, out string usedMode) {
      applied = false;
      usedMode = null;

      if (hwnd == IntPtr.Zero)
        return "glass needs hwnd as a decimal string, e.g. \"131862\" (0 is not a window)";
      if (!Win32.IsWindow(hwnd))
        return "window " + hwnd.ToInt64() + " no longer exists, so nothing can be made glass";

      if (string.IsNullOrEmpty(mode)) mode = "acrylic";
      int accentState;
      if (mode == "acrylic") accentState = Win32.ACCENT_ENABLE_ACRYLICBLURBEHIND;
      else if (mode == "blur") accentState = Win32.ACCENT_ENABLE_BLURBEHIND;
      else if (mode == "off") accentState = Win32.ACCENT_DISABLED;
      else return "glass mode must be \"acrylic\", \"blur\" or \"off\" (got \"" + mode + "\")";

      uint gradient = DefaultTint;
      if (!string.IsNullOrEmpty(tint)) {
        string terr = ParseTint(tint, out gradient);
        if (terr != null) return terr;
      }

      var policy = new Win32.ACCENT_POLICY();
      policy.AccentState = accentState;
      policy.AccentFlags = Win32.ACCENT_FLAGS_DRAW_ALL_BORDERS;
      policy.GradientColor = accentState == Win32.ACCENT_DISABLED ? 0u : gradient;
      policy.AnimationId = 0;

      int size = Marshal.SizeOf(typeof(Win32.ACCENT_POLICY));
      IntPtr buf = Marshal.AllocHGlobal(size);
      try {
        Marshal.StructureToPtr(policy, buf, false);
        var data = new Win32.WINDOWCOMPOSITIONATTRIBDATA();
        data.Attrib = Win32.WCA_ACCENT_POLICY;
        data.pvData = buf;
        data.cbData = size;

        int rc;
        try {
          rc = Win32.SetWindowCompositionAttribute(hwnd, ref data);
        } catch (EntryPointNotFoundException) {
          // Undocumented export: a Windows that drops it must produce a stated
          // absence, not a bar that is quietly opaque.
          return "this Windows has no SetWindowCompositionAttribute, so there is no blur behind Mantle's " +
                 "windows; they will render solid";
        } catch (Exception ex) {
          return "SetWindowCompositionAttribute failed: " + ex.Message;
        }

        if (rc == 0)
          return "Windows refused the blur for window " + hwnd.ToInt64() +
                 " (SetWindowCompositionAttribute returned 0, Win32 error " +
                 Marshal.GetLastWin32Error() + "); the window will render solid";

        applied = true;
        usedMode = mode;
        return null;
      } finally {
        Marshal.FreeHGlobal(buf);
      }
    }

    /// "#RRGGBBAA" (or "#RRGGBB", alpha then defaulting) to the ABGR uint the
    /// accent policy wants. CSS order in, Windows order out - the swap is the
    /// whole point of doing it here rather than in the caller.
    static string ParseTint(string tint, out uint gradient) {
      gradient = DefaultTint;
      string s = tint.Trim();
      if (s.StartsWith("#", StringComparison.Ordinal)) s = s.Substring(1);
      if (s.Length != 6 && s.Length != 8)
        return "glass tint must be \"#RRGGBB\" or \"#RRGGBBAA\" (got \"" + tint + "\")";

      uint r, g, b, a = 0xCC;
      if (!TryHex(s.Substring(0, 2), out r) ||
          !TryHex(s.Substring(2, 2), out g) ||
          !TryHex(s.Substring(4, 2), out b))
        return "glass tint is not hexadecimal: \"" + tint + "\"";
      if (s.Length == 8 && !TryHex(s.Substring(6, 2), out a))
        return "glass tint alpha is not hexadecimal: \"" + tint + "\"";

      gradient = (a << 24) | (b << 16) | (g << 8) | r;
      return null;
    }

    static bool TryHex(string s, out uint v) {
      return uint.TryParse(s, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out v);
    }
  }
}

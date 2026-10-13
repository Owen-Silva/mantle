// HOOK HEALTH (lane mn-hook, 2026-10-12; audit #15).
//
// Windows removes a WH_KEYBOARD_LL / WH_MOUSE_LL hook whose thread misses LowLevelHooksTimeout
// ("the hook is silently removed without being called", LowLevelKeyboardProc, documented). Nothing
// tells the process: the handle still looks fine, UnhookWindowsHookEx on it just fails later. From
// then on the solo-Win tap opens Windows' Start, Alt+Tab is Windows' own and every Mantle shortcut
// goes to Windows, until Mantle restarts. A resume from sleep (every thread starved for a moment)
// and a hook thread held up by slow work are the two ways in.
//
// How Mantle notices, with no polling at all while nobody types:
//   * The keyboard hook (Hotkey). The hook thread also takes RAW keyboard input (WM_INPUT, input
//     sink, on a message-only window). Windows makes raw input AFTER the low-level hooks have passed
//     a key, so a live hook is always called first, and its callback resets the count. Raw key events
//     piling up with no callback for a while = Windows dropped the hook: re-install it and say so.
//     Keys another program's hook ate never reach raw input, so a remote-desktop window or a game's
//     own hook cannot look like a dead hook.
//   * The pop-up watch (PopWatch, only while a bar pop-up is open). Its two hooks see every mouse
//     move, click and key, so GetLastInputInfo moving past their last callback = one of them is gone.
//     It runs on the watch thread's 200 ms timer, which only exists while a pop-up is open.
//   * Both: a window of an elevated (admin) program in front does not get low-level hooks from a
//     normal process at all, so that case is checked (only on suspicion) and never counted.
//   * Both are re-installed on resume and unlock as well (main asks: hotkey {op:'rearm'}), because
//     that is cheap and a resume is exactly when Windows drops them.
//
// Nothing here runs inside a hook proc: the procs only store a tick.

using System;
using System.Runtime.InteropServices;

namespace Mantle {
  static class HookHealth {
    public const uint WM_INPUT = 0x00FF;

    // The keyboard rule: this many raw key events (a press is two) with no hook callback, the last
    // callback at least QuietMs ago. Then at most one re-install per BackoffMs.
    public const int MissedKeys = 4, QuietMs = 1500, BackoffMs = 15000;
    // The pop-up rule: input this far past the hooks' last callback, looked at once it is this old.
    public const int PopAheadMs = 250, PopSettleMs = 300;

    /// PURE: 0 = alive (or too soon to say), 1 = dead, re-install now, 2 = dead but re-installed less
    /// than BackoffMs ago (wait: something else may be eating the callbacks). sinceHealMs -1 = never.
    public static int KeyVerdict(int rawSinceHook, int sinceHookMs, int sinceHealMs) {
      if (rawSinceHook < MissedKeys || sinceHookMs < QuietMs) return 0;
      return sinceHealMs >= 0 && sinceHealMs < BackoffMs ? 2 : 1;
    }

    /// PURE: input happened `aheadMs` after the hooks' last callback, `agoMs` ago. Dead when no
    /// callback followed it in PopSettleMs (a live hook is called within microseconds).
    public static bool PopVerdict(int aheadMs, int agoMs) {
      return aheadMs > PopAheadMs && agoMs >= PopSettleMs && agoMs < 10000;
    }

    public static string VerdictWord(int v) { return v == 1 ? "dead" : v == 2 ? "wait" : "alive"; }

    // ------------------------------------------------------------ raw keyboard input

    [StructLayout(LayoutKind.Sequential)]
    struct RAWINPUTDEVICE { public ushort UsagePage; public ushort Usage; public uint Flags; public IntPtr Target; }

    const uint RIDEV_REMOVE = 0x1, RIDEV_INPUTSINK = 0x100;
    static readonly IntPtr HWND_MESSAGE = new IntPtr(-3);

    [DllImport("user32.dll", SetLastError = true)]
    static extern bool RegisterRawInputDevices([In] RAWINPUTDEVICE[] devices, uint count, uint size);
    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern IntPtr CreateWindowExW(uint exStyle, string cls, string name, uint style, int x, int y, int w, int h,
                                         IntPtr parent, IntPtr menu, IntPtr inst, IntPtr param);
    [DllImport("user32.dll")] static extern bool DestroyWindow(IntPtr hwnd);

    /// On the hook thread (the window and its WM_INPUT belong to the thread that makes it). The
    /// sink window, or zero with `why` saying what is missing.
    public static IntPtr OpenSink(out string why) {
      why = null;
      IntPtr w = CreateWindowExW(0, "Message", null, 0, 0, 0, 0, 0, HWND_MESSAGE, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
      if (w == IntPtr.Zero) w = CreateWindowExW(0, "STATIC", null, 0, 0, 0, 0, 0, HWND_MESSAGE, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
      if (w == IntPtr.Zero) {
        why = "no message window (Win32 error " + Marshal.GetLastWin32Error() + ")";
        return IntPtr.Zero;
      }
      var d = new RAWINPUTDEVICE[1];
      d[0].UsagePage = 0x01; d[0].Usage = 0x06;   // generic desktop, keyboard
      d[0].Flags = RIDEV_INPUTSINK;
      d[0].Target = w;
      if (!RegisterRawInputDevices(d, 1, (uint)Marshal.SizeOf(typeof(RAWINPUTDEVICE)))) {
        why = "Windows refused raw keyboard input (Win32 error " + Marshal.GetLastWin32Error() + ")";
        DestroyWindow(w);
        return IntPtr.Zero;
      }
      return w;
    }

    public static void CloseSink(IntPtr w) {
      if (w == IntPtr.Zero) return;
      try {
        var d = new RAWINPUTDEVICE[1];
        d[0].UsagePage = 0x01; d[0].Usage = 0x06; d[0].Flags = RIDEV_REMOVE; d[0].Target = IntPtr.Zero;
        RegisterRawInputDevices(d, 1, (uint)Marshal.SizeOf(typeof(RAWINPUTDEVICE)));
      } catch (Exception) { }
      try { DestroyWindow(w); } catch (Exception) { }
    }

    // ------------------------------------------------------------ last input

    [StructLayout(LayoutKind.Sequential)]
    struct LASTINPUTINFO { public uint Size; public uint Time; }
    [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO info);

    /// GetLastInputInfo's tick (the Environment.TickCount clock), or `fallback` when it fails.
    public static int LastInputTick(int fallback) {
      var li = new LASTINPUTINFO();
      li.Size = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO));
      return GetLastInputInfo(ref li) ? unchecked((int)li.Time) : fallback;
    }

    // ------------------------------------------------------------ an elevated window in front

    [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
    [DllImport("advapi32.dll")] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll")] static extern bool GetTokenInformation(IntPtr token, int cls, out int value, int len, out int got);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();

    static int _selfElevated = -1;   // -1 not read yet

    static int Elevated(IntPtr process) {
      IntPtr tok;
      if (!OpenProcessToken(process, 0x0008 /* TOKEN_QUERY */, out tok)) return -1;
      try {
        int v, got;
        if (!GetTokenInformation(tok, 20 /* TokenElevation */, out v, 4, out got)) return -1;
        return v != 0 ? 1 : 0;
      } finally { CloseHandle(tok); }
    }

    /// True when the window in front belongs to a program running with more rights than this one
    /// (or one Mantle may not even look at). Its keys never reach a normal process's low-level hook,
    /// so they say nothing about the hook being alive. Only called on suspicion, never per key.
    public static bool ForegroundOutranksUs() {
      try {
        if (_selfElevated < 0) _selfElevated = Elevated(GetCurrentProcess()) == 1 ? 1 : 0;
        if (_selfElevated == 1) return false;
        IntPtr fg = Win32.GetForegroundWindow();
        if (fg == IntPtr.Zero) return false;
        int pid;
        Win32.GetWindowThreadProcessId(fg, out pid);
        if (pid == 0 || pid == System.Diagnostics.Process.GetCurrentProcess().Id) return false;
        IntPtr ph = OpenProcess(0x1000 /* PROCESS_QUERY_LIMITED_INFORMATION */, false, pid);
        if (ph == IntPtr.Zero) return true;
        try { return Elevated(ph) != 0; } finally { CloseHandle(ph); }
      } catch (Exception) {
        return false;
      }
    }
  }
}

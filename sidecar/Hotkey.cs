// Hotkey.cs - "a solo Win tap opens Mantle's launcher", without breaking Windows.
//
// RegisterHotKey cannot express this: there is no such thing as registering the
// Win key on its own, and grabbing it would kill Win+E, Win+L, Win+Shift+S and
// every other system chord. So we watch the keyboard with a low-level hook and
// only act on the exact gesture "Win pressed and released with nothing in
// between".
//
// THE TRICK: we never swallow anything. Instead, on the solo Win-UP we inject a
// keypress of VK 0xFF (a reserved, unmapped key) BEFORE the real Win-up is
// delivered. Windows then sees the chord Win+<0xFF>, decides it was not a solo
// tap, and does not open Start - while our own keyup passes through untouched.
//
// WHY never swallow the Win keyup: a Win keydown that is delivered with its
// keyup eaten leaves Windows believing Win is held forever. Every subsequent
// keystroke becomes a system chord and the machine is effectively unusable
// until you press and release Win again. Start opening by accident is a far
// smaller bug than that, so the hook always calls CallNextHookEx.
//
// The hook proc runs inside every keystroke of every app on the desktop. It
// must return in microseconds: no allocation, no JSON, no I/O. All it does is
// flip two booleans and PostMessage to our own message-loop window.
using System;
using System.Runtime.InteropServices;

namespace Mantle {
  static class Hotkey {
    static Win32.LowLevelKeyboardProc _proc;   // static: the GC must not collect a live hook
    static IntPtr _hook = IntPtr.Zero;
    static bool _winDown;
    static bool _otherPressed;

    public static bool Installed { get { return _hook != IntPtr.Zero; } }

    public static string Install(bool on, out bool installed) {
      installed = Installed;
      if (on == Installed) return null;      // already in the requested state
      if (on) {
        _proc = HookProc;
        _winDown = false;
        _otherPressed = false;
        // hMod must be a real module handle for WH_KEYBOARD_LL on some builds;
        // the module of this exe is fine and costs nothing.
        IntPtr hMod = Win32.GetModuleHandleW(null);
        _hook = Win32.SetWindowsHookExW(Win32.WH_KEYBOARD_LL, _proc, hMod, 0);
        if (_hook == IntPtr.Zero) {
          int err = Marshal.GetLastWin32Error();
          _proc = null;
          return "could not install the keyboard hook (Win32 error " + err +
                 "); the solo-Win gesture will not work - the launcher still opens from the bar";
        }
      } else {
        Win32.UnhookWindowsHookEx(_hook);
        _hook = IntPtr.Zero;
        _proc = null;
        _winDown = false;
        _otherPressed = false;
      }
      installed = Installed;
      return null;
    }

    public static void Uninstall() {
      try {
        if (_hook != IntPtr.Zero) Win32.UnhookWindowsHookEx(_hook);
      } catch (Exception) { }
      _hook = IntPtr.Zero;
      _proc = null;
    }

    static IntPtr HookProc(int nCode, IntPtr wParam, IntPtr lParam) {
      if (nCode == Win32.HC_ACTION) {
        try {
          var k = (Win32.KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(Win32.KBDLLHOOKSTRUCT));
          // Ignore anything we (or any other automation) injected, including the
          // 0xFF partner key below - otherwise we would answer our own input.
          if ((k.flags & Win32.LLKHF_INJECTED) == 0) {
            uint msg = (uint)wParam.ToInt64();
            bool isDown = msg == Win32.WM_KEYDOWN || msg == Win32.WM_SYSKEYDOWN;
            bool isUp = msg == Win32.WM_KEYUP || msg == Win32.WM_SYSKEYUP;
            bool isWin = k.vkCode == Win32.VK_LWIN || k.vkCode == Win32.VK_RWIN;

            if (isDown && isWin) {
              // Key repeat re-fires this; only the FIRST press arms the gesture.
              if (!_winDown) { _winDown = true; _otherPressed = false; }
            } else if (isDown) {
              if (_winDown) _otherPressed = true;   // it was a chord, not a tap
            } else if (isUp && isWin) {
              bool solo = _winDown && !_otherPressed;
              _winDown = false;
              if (solo) {
                SendDummyKey();                      // suppress the Start menu
                Win32.PostMessageW(Program.LoopHandle, MsgForm.WM_HOTKEY_TAP, IntPtr.Zero, IntPtr.Zero);
              }
            }
          }
        } catch (Exception) {
          // A throw out of a hook proc would take down every app's input.
          // Swallow here; the state machine self-corrects on the next keypress.
        }
      }
      return Win32.CallNextHookEx(_hook, nCode, wParam, lParam);
    }

    /// One down/up of VK 0xFF. Windows counts it as the Win chord's partner.
    static void SendDummyKey() {
      var inputs = new Win32.INPUT[2];
      inputs[0].type = Win32.INPUT_KEYBOARD;
      inputs[0].u.ki.wVk = Win32.VK_DUMMY;
      inputs[1].type = Win32.INPUT_KEYBOARD;
      inputs[1].u.ki.wVk = Win32.VK_DUMMY;
      inputs[1].u.ki.dwFlags = Win32.KEYEVENTF_KEYUP;
      Win32.SendInput(2, inputs, Marshal.SizeOf(typeof(Win32.INPUT)));
    }

    /// Used by WindowList.Focus, not by the gesture: a bare Alt press/release
    /// makes Windows relax the foreground lock for us.
    public static void TapAltForFocusLock() {
      const ushort VK_MENU = 0x12;
      var inputs = new Win32.INPUT[2];
      inputs[0].type = Win32.INPUT_KEYBOARD;
      inputs[0].u.ki.wVk = VK_MENU;
      inputs[1].type = Win32.INPUT_KEYBOARD;
      inputs[1].u.ki.wVk = VK_MENU;
      inputs[1].u.ki.dwFlags = Win32.KEYEVENTF_KEYUP;
      Win32.SendInput(2, inputs, Marshal.SizeOf(typeof(Win32.INPUT)));
    }
  }
}

// Keys.cs - `keys`: send one of exactly four Windows chords, and no others.
//
// WHY THIS EXISTS: Mantle's bar has a clock, a notification bell and a "show
// desktop" corner, and the only way to open the real Windows surfaces behind
// them - quick settings, the notification centre, peek at the desktop - is the
// keyboard chord the OS already owns. There is no API for "open the action
// centre"; Win+A is the API.
//
// WHY THE ALLOW-LIST IS THE WHOLE DESIGN: this is a process that can type into
// whatever the user is looking at. An open-ended `keys` command would be a
// keystroke injector one JSON line away from any bug in the UI layer - a typo
// in a renderer could send Win+L (lock), Win+R then a command line, or Alt+F4
// into someone's unsaved work. So the protocol takes a COMBO NAME, not a key
// code, and three names exist. Anything else is refused by name, not sanitised.
//
//   win+a  quick settings
//   win+n  notification centre
//   win+d  show the desktop
//   win+k  Windows' Cast panel ("Connect to a wireless display"; lane qstiles, 2026-10-15: no public
//          API lets another app start a whole-screen Miracast session, so Mantle hands this one over)
//
// THE ORDER OF THE CHECKS MATTERS. An unknown combo is answered BEFORE the
// passive check, because "win+x is not a thing this command does" is true in
// every mode - a caller that hears "refused: passive" would go on believing
// win+x works in a live run. Same reasoning as `taskbar {show:...}`.
//
// AND THE HOOK MUST NOT ANSWER US: every key below is injected, so Windows
// flags it LLKHF_INJECTED (or LLKHF_LOWER_IL_INJECTED). Hotkey.HookProc
// ignores both, which is what stops the LWIN-down half of this chord from
// looking like a solo Win tap and opening Mantle's own launcher on top of the
// panel we just asked Windows for.
using System;
using System.Runtime.InteropServices;

namespace Mantle {
  static class Keys {
    /// Parsed name -> the partner key. Returns false for anything else, and
    /// "anything else" includes Win+L, Win+R and every chord that could hurt.
    static bool Lookup(string combo, out ushort vk) {
      vk = 0;
      if (combo == null) return false;
      switch (combo.Trim().ToLowerInvariant().Replace(" ", "")) {
        case "win+a": vk = (ushort)Win32.VK_A; return true;
        case "win+n": vk = (ushort)Win32.VK_N; return true;
        case "win+d": vk = (ushort)Win32.VK_D; return true;
        case "win+k": vk = 0x4B; return true;   // Cast (lane qstiles): Windows' own panel, which Mantle hands off to
        default: return false;
      }
    }

    public static bool IsAllowed(string combo) {
      ushort vk;
      return Lookup(combo, out vk);
    }

    /// Four events in ONE SendInput call. One call, because SendInput is only
    /// atomic per call: split it up and another thread's input can land between
    /// the Win-down and the letter, which Windows reads as a bare Win press and
    /// the Start menu opens.
    ///
    /// Returns null on success, or why the OS refused. Nothing is ever held:
    /// both keys go up in the same call, so a crash mid-chord cannot leave the
    /// Win key stuck down.
    public static string Send(string combo) {
      ushort vk;
      if (!Lookup(combo, out vk)) return "combo not allowed";

      var inputs = new Win32.INPUT[4];
      inputs[0].type = Win32.INPUT_KEYBOARD;
      inputs[0].u.ki.wVk = (ushort)Win32.VK_LWIN;
      inputs[1].type = Win32.INPUT_KEYBOARD;
      inputs[1].u.ki.wVk = vk;
      inputs[2].type = Win32.INPUT_KEYBOARD;
      inputs[2].u.ki.wVk = vk;
      inputs[2].u.ki.dwFlags = Win32.KEYEVENTF_KEYUP;
      inputs[3].type = Win32.INPUT_KEYBOARD;
      inputs[3].u.ki.wVk = (ushort)Win32.VK_LWIN;
      inputs[3].u.ki.dwFlags = Win32.KEYEVENTF_KEYUP;

      uint sent = Win32.SendInput(4, inputs, Marshal.SizeOf(typeof(Win32.INPUT)));
      if (sent == 4) return null;

      int err = Marshal.GetLastWin32Error();
      // UIPI: a process cannot inject into a window running at higher integrity
      // (an elevated app, the secure desktop, UAC). Say which, not "failed".
      return "Windows accepted only " + sent + " of the 4 keystrokes for " + combo +
             " (Win32 error " + err + ")" +
             (err == 5 ? "; the foreground window runs at a higher integrity level than Mantle, " +
                         "so Windows blocks injected input into it" : "");
    }
  }
}

// Hotkey.cs - Mantle's one low-level keyboard hook, without breaking Windows.
//
// Three features ride on it, each switched on its own (`hotkey {winTap,
// altTab, winKeys}`), and the hook exists while any of them is on:
//   winTap   a solo Win tap opens Mantle's launcher (the original gesture)
//   altTab   Alt+Tab opens Mantle's switcher instead of Windows' (AltTab.cs)
//   winKeys  Win+N / Win+A open Mantle's notification centre / quick settings
//   chords   (wave 3) the feature chords lib/features/*.js take while they are on and
//            healthy (Win+S, Win+V, Win+Tab, Win+arrows, Win+Z, Win+Shift+S,
//            PrintScreen, and the bare VolumeUp / VolumeDown / VolumeMute keys, which
//            repeat while held), and `observe`: keys reported but never swallowed (volume).
//            `hotkey {chords:[names], observe:[names]}`; events {ev:'chord'} / {ev:'key'}.
// Every keyboard decision is made by KeyMachine (AltTab.cs), a pure state
// machine the test harness drives with scripted keys; this file is only the
// plumbing that feeds it real ones.
//
// RegisterHotKey cannot express any of this: there is no registering the Win
// key on its own, grabbing it would kill Win+E, Win+L, Win+Shift+S and every
// other system chord, and Alt+Tab / Win+N / Win+A belong to Windows itself.
// So we watch the keyboard with a low-level hook.
//
// THE TRICK: on a Win-up (or Alt-up) whose hold Windows must NOT read as a solo
// tap, we inject a keypress of VK 0xFF (a reserved, unmapped key) BEFORE the
// real keyup is delivered. Windows then sees the chord <modifier>+<0xFF>:
// Start stays shut after a solo Win tap or a Win+N whose N we ate, and the
// focused app does not open its menu bar after an Alt+Tab whose Tab we ate.
//
// WHY a modifier keyup is never swallowed: a Win (or Alt) keydown delivered
// with its keyup eaten leaves Windows believing it is held forever. Every
// later keystroke becomes a system chord and the machine is effectively
// unusable until you press and release it again. A stray Start menu is a far
// smaller bug than that, so modifier keyups always go through CallNextHookEx.
// The only keys ever swallowed are listed in AltTab.cs, and each one's keyup is
// swallowed with its keydown.
//
// THE HOOK HAS A THREAD OF ITS OWN (since 2026-09-23). Until then it lived on
// the sidecar's message loop, which also runs every ui-lane command - window
// lists with icon lookups, glass, placement - and a low-level hook is called
// in-line with EVERY keystroke on the desktop: while the loop is busy, the
// whole keyboard waits on Mantle. Past LowLevelHooksTimeout Windows skips the
// hook for that key, and "on Windows 7 and later, the hook is silently removed
// without being called" (LowLevelKeyboardProc, documented). For a solo-Win tap
// that meant one missed launcher; for Alt+Tab it would mean a Tab swallowed
// with its Alt-up never seen. So the hook thread does nothing but run the hook,
// the switcher's bookkeeping, and a 40 ms watchdog while a switcher is open.
//
// The hook proc runs inside every keystroke of every app on the desktop. It
// must return in microseconds: no allocation, no JSON, no I/O. It reads three
// fields, asks KeyMachine, and at most posts a thread message and injects the
// partner key.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;

namespace Mantle {
  static class Hotkey {
    // Thread messages for the hook thread (WM_APP range; hwnd NULL).
    public const uint MSG_KEYEVENT = 0x8000 + 21;   // wParam = KeyMachine event, lParam = its argument
    public const uint MSG_PICK = 0x8000 + 22;       // wParam = session seq, lParam = tile index
    public const uint MSG_CANCEL = 0x8000 + 23;     // wParam = session seq
    public const uint MSG_GRID = 0x8000 + 24;       // wParam = session seq, lParam = columns
    public const uint MSG_CONFIG = 0x8000 + 25;     // a feature was switched
    public const uint MSG_QUIT = 0x8000 + 26;
    public const uint MSG_REHOOK = 0x8000 + 27;

    /// The one machine. The hook thread is the only thread that calls Step;
    /// the ui lane only flips its three feature bools.
    public static readonly KeyMachine Machine = new KeyMachine();

    /// Stopwatch timestamp of the keystroke that opened the current switcher.
    public static long LastOpenTs;

    static Win32.LowLevelKeyboardProc _proc;   // static: the GC must not collect a live hook
    static volatile IntPtr _hook = IntPtr.Zero;
    static volatile int _tid;
    static Thread _thread;
    static readonly object _gate = new object();
    static string _lastReason;                 // why the hook is not installed, when it is not
    static int _rehooks;

    // The partner key, built once: the hook proc must not allocate.
    static readonly Win32.INPUT[] _dummy = MakeDummy();
    static readonly int _inputSize = Marshal.SizeOf(typeof(Win32.INPUT));

    public static bool Installed { get { return _hook != IntPtr.Zero; } }

    // ------------------------------------------------------------ switching

    /// Turn features on or off; null leaves one as it is. Returns null, or the
    /// reason the hook could not be installed (every feature is then off).
    public static string Configure(bool? winTap, bool? altTab, bool? winKeys) {
      return Configure(winTap, altTab, winKeys, -1, -1);
    }

    /// The same, plus the feature chords and observed keys as bitmasks (-1 = leave as it is).
    /// The hook exists while ANY of the five wants it.
    public static string Configure(bool? winTap, bool? altTab, bool? winKeys, int chords, int observe) {
      lock (_gate) {
        bool wt = winTap.HasValue ? winTap.Value : Machine.WinTap;
        bool at = altTab.HasValue ? altTab.Value : Machine.AltTab;
        bool wk = winKeys.HasValue ? winKeys.Value : Machine.WinKeys;
        int ch = chords >= 0 ? chords : Machine.Chords;
        int ob = observe >= 0 ? observe : Machine.Observe;
        bool want = wt || at || wk || ch != 0 || ob != 0;
        if (want && !Installed) {
          Machine.Reset();
          Machine.WinTap = wt; Machine.AltTab = at; Machine.WinKeys = wk;
          Machine.Chords = ch; Machine.Observe = ob;
          string err = StartThread();
          if (err != null) {
            Machine.WinTap = false; Machine.AltTab = false; Machine.WinKeys = false;
            Machine.Chords = 0; Machine.Observe = 0;
            _lastReason = err;
            Announce();
            return err;
          }
        } else if (!want) {
          if (Installed || _thread != null) StopThread();
          Machine.WinTap = false; Machine.AltTab = false; Machine.WinKeys = false;
          Machine.Chords = 0; Machine.Observe = 0;
        } else {
          Machine.WinTap = wt; Machine.AltTab = at; Machine.WinKeys = wk;
          Machine.Chords = ch; Machine.Observe = ob;
          // Turning Alt+Tab off mid-switch has to close the switcher, on the
          // thread that owns it.
          Post(MSG_CONFIG, 0, 0);
        }
        _lastReason = null;
        Announce();
        return null;
      }
    }

    /// Every exit road (Program.SafetyRestore): everything off, hook gone. Any
    /// thread. Never waits long - a restore must not queue behind a stuck lock.
    public static void Uninstall() {
      bool locked = false;
      try {
        locked = Monitor.TryEnter(_gate, 2000);
        Machine.WinTap = false; Machine.AltTab = false; Machine.WinKeys = false;
        Machine.Chords = 0; Machine.Observe = 0;
        StopThread();
        _lastReason = "Mantle is putting Windows back";
      } catch (Exception) {
      } finally {
        if (locked) Monitor.Exit(_gate);
      }
      // Belt and braces for a thread that never answered.
      IntPtr h = _hook;
      _hook = IntPtr.Zero;
      if (h != IntPtr.Zero) { try { Win32.UnhookWindowsHookEx(h); } catch (Exception) { } }
      _proc = null;
    }

    public static IDictionary Status() {
      return Json.Obj("installed", Installed, "winTap", Machine.WinTap, "altTab", Machine.AltTab,
                      "winKeys", Machine.WinKeys,
                      "chords", KeyMachine.NamesOf(Machine.Chords, KeyMachine.ChordNames),
                      "observe", KeyMachine.NamesOf(Machine.Observe, KeyMachine.KeyNames),
                      "tracking", Switcher.Tracking,
                      "session", Machine.Active, "seq", Switcher.Seq, "rehooks", _rehooks,
                      "reason", _lastReason);
    }

    /// The hook's state, pushed whenever it changes, so main's state piece is
    /// the sidecar's word and not a guess - including a restore main did not ask
    /// for (stdin EOF, a crash handler).
    static void Announce() {
      var d = Status();
      d["ev"] = "switcher";
      d["op"] = "hook";
      KeyEvents.Enqueue(d);
    }

    static void Post(uint msg, int wp, int lp) {
      int tid = _tid;
      if (tid != 0) KeysNative.PostThreadMessageW(tid, msg, new IntPtr(wp), new IntPtr(lp));
    }

    // ------------------------------------------------------------ the thread

    static string StartThread() {
      var ready = new ManualResetEvent(false);
      var err = new int[1];
      var why = new string[1];
      var t = new Thread(delegate () { ThreadMain(ready, err, why); });
      t.IsBackground = true;
      t.Name = "mantle-keys";
      // Every keystroke on the desktop waits for this thread: it has to win the
      // CPU the moment a key arrives, and it only ever runs for microseconds.
      t.Priority = ThreadPriority.Highest;
      t.Start();
      if (!ready.WaitOne(3000)) {
        // Too late is as good as never: tell the thread to stand down if it
        // ever gets there, and say so.
        Post(MSG_QUIT, 0, 0);
        return "the keyboard hook thread did not start within 3 s, so the Win key, Alt+Tab, Win+N, Win+A and every feature shortcut " +
               "are all Windows' own";
      }
      if (_hook == IntPtr.Zero) {
        return "could not install the keyboard hook (" + (why[0] ?? ("Win32 error " + err[0])) +
               "), so the Win key, Alt+Tab, Win+N, Win+A and every feature shortcut are all Windows' own; the launcher still opens from the bar";
      }
      _thread = t;
      return null;
    }

    static void StopThread() {
      Thread t = _thread;
      int tid = _tid;
      if (tid != 0) KeysNative.PostThreadMessageW(tid, MSG_QUIT, IntPtr.Zero, IntPtr.Zero);
      bool joined = t == null || t.Join(1000);
      if (!joined || _hook != IntPtr.Zero) {
        // The thread did not answer. UnhookWindowsHookEx from here instead:
        // the hook belongs to this process, and a hook left running with its
        // thread wedged is keystrokes waiting on a dead end.
        IntPtr h = _hook;
        _hook = IntPtr.Zero;
        if (h != IntPtr.Zero) { try { Win32.UnhookWindowsHookEx(h); } catch (Exception) { } }
      }
      // A switch torn down with Alt still held and a Tab already eaten: the
      // Alt-up is about to reach the app with no partner key, so give it one now.
      try {
        if ((Machine.SwallowedInAlt && KeysNative.KeyDown(KeyMachine.VK_MENU)) ||
            (Machine.SwallowedInWin && (KeysNative.KeyDown(KeyMachine.VK_LWIN) || KeysNative.KeyDown(KeyMachine.VK_RWIN))))
          SendDummyKey();
      } catch (Exception) { }
      Machine.Reset();
      _thread = null;
    }

    static void ThreadMain(ManualResetEvent ready, int[] err, string[] why) {
      KeysNative.MSG msg;
      bool ok = false;
      try {
        // Any USER call creates the thread's message queue; PostThreadMessage
        // to a thread without one fails, so this goes before anything is posted.
        KeysNative.PeekMessageW(out msg, IntPtr.Zero, 0, 0, KeysNative.PM_NOREMOVE);
        _tid = Win32.GetCurrentThreadId();
        _proc = HookProc;
        // hMod must be a real module handle for WH_KEYBOARD_LL on some builds;
        // the module of this exe is fine and costs nothing.
        IntPtr h = Win32.SetWindowsHookExW(Win32.WH_KEYBOARD_LL, _proc, Win32.GetModuleHandleW(null), 0);
        if (h == IntPtr.Zero) {
          err[0] = Marshal.GetLastWin32Error();
          _proc = null;
        } else {
          _hook = h;
          ok = true;
          Switcher.StartTracking();
        }
      } catch (Exception ex) {
        why[0] = "the hook thread threw " + ex.GetType().Name + ": " + ex.Message;
      }
      ready.Set();
      if (!ok) { _tid = 0; return; }

      try {
        while (true) {
          int got = KeysNative.GetMessageW(out msg, IntPtr.Zero, 0, 0);
          if (got == 0 || got == -1) break;
          if (msg.hwnd == IntPtr.Zero) {
            if (msg.message == MSG_QUIT) break;
            if (msg.message == MSG_REHOOK) { RehookHere("the switcher asked for it"); continue; }
            try {
              Switcher.OnThreadMessage(msg.message, msg.wParam, msg.lParam);
            } catch (Exception ex) {
              KeyEvents.Log("error", "alt+tab: the switcher threw " + ex.GetType().Name + ": " + ex.Message +
                                     " (the keyboard hook is still running)");
            }
            continue;
          }
          KeysNative.TranslateMessage(ref msg);
          KeysNative.DispatchMessageW(ref msg);
        }
      } catch (Exception ex) {
        KeyEvents.Log("error", "the keyboard hook thread stopped on " + ex.GetType().Name + ": " + ex.Message +
                               "; the hook was removed, so the Win key and Alt+Tab are Windows' own again");
      } finally {
        try { Switcher.StopTracking(); } catch (Exception) { }
        IntPtr h = _hook;
        _hook = IntPtr.Zero;
        if (h != IntPtr.Zero) { try { Win32.UnhookWindowsHookEx(h); } catch (Exception) { } }
        _proc = null;
        _tid = 0;
      }
    }

    /// Put the hook back at the head of the chain. Called by the switcher's
    /// watchdog when Alt came up without the hook seeing it and nothing else
    /// explains it - the signature of a hook Windows has quietly dropped.
    public static void Rehook(string why) {
      if (Win32.GetCurrentThreadId() == _tid) RehookHere(why);
      else Post(MSG_REHOOK, 0, 0);
    }

    static void RehookHere(string why) {
      if (_proc == null) return;
      IntPtr old = _hook;
      IntPtr h = Win32.SetWindowsHookExW(Win32.WH_KEYBOARD_LL, _proc, Win32.GetModuleHandleW(null), 0);
      if (h == IntPtr.Zero) {
        KeyEvents.Log("warn", "keyboard hook: " + why + ", and re-installing it failed (Win32 error " +
                              Marshal.GetLastWin32Error() + "); the old one stays");
        return;
      }
      // No keystroke can reach both hooks: callbacks only arrive while this
      // thread pumps messages, and it is not pumping between these two lines.
      _hook = h;
      if (old != IntPtr.Zero) { try { Win32.UnhookWindowsHookEx(old); } catch (Exception) { } }
      _rehooks++;
      KeyEvents.Log("warn", "keyboard hook: " + why + "; it was re-installed (" + _rehooks +
                            (_rehooks == 1 ? " time" : " times") + " this run)");
    }

    // ------------------------------------------------------------ the hook

    static IntPtr HookProc(int nCode, IntPtr wParam, IntPtr lParam) {
      if (nCode == Win32.HC_ACTION) {
        try {
          // The fields we need, read in place: PtrToStructure would box a copy
          // of KBDLLHOOKSTRUCT on every keystroke on the desktop.
          int vk = Marshal.ReadInt32(lParam, 0);
          uint flags = (uint)Marshal.ReadInt32(lParam, 8);
          // Ignore anything we (or any other automation) injected: the 0xFF
          // partner key, the Alt nudge in WindowList.Focus, and every chord
          // `keys` sends. Without this, the LWIN-down of `keys win+a` looks like
          // the start of a solo Win tap and Mantle's launcher opens on top of
          // the panel we just asked Windows for. BOTH injected bits are tested -
          // Windows sets LLKHF_LOWER_IL_INJECTED instead of LLKHF_INJECTED when
          // the injector runs at a lower integrity level than this process.
          if ((flags & (Win32.LLKHF_INJECTED | Win32.LLKHF_LOWER_IL_INJECTED)) == 0) {
            uint msg = (uint)wParam.ToInt64();
            bool down = msg == Win32.WM_KEYDOWN || msg == Win32.WM_SYSKEYDOWN;
            if (down || msg == Win32.WM_KEYUP || msg == Win32.WM_SYSKEYUP) {
              bool altFlag = (flags & KeysNative.LLKHF_ALTDOWN) != 0;
              bool shift = false, ctrl = false, win = false, otherAlt = false;
              if (down) {
                if (Machine.NeedsMods(vk)) {
                  shift = KeysNative.KeyDown(KeyMachine.VK_SHIFT);
                  ctrl = KeysNative.KeyDown(KeyMachine.VK_CONTROL);
                  win = KeysNative.KeyDown(KeyMachine.VK_LWIN) || KeysNative.KeyDown(KeyMachine.VK_RWIN);
                }
              } else if (vk == KeyMachine.VK_LMENU) {
                otherAlt = KeysNative.KeyDown(KeyMachine.VK_RMENU);
              } else if (vk == KeyMachine.VK_RMENU) {
                otherAlt = KeysNative.KeyDown(KeyMachine.VK_LMENU);
              }
              KeyMachine m = Machine;
              int r = m.Step(vk, down, altFlag, shift, ctrl, win, otherAlt);
              if ((r & KeyMachine.DummyFirst) != 0) SendDummyKey();
              int ev = m.Event;
              if (ev == KeyMachine.EvWinTap) {
                Win32.PostMessageW(Program.LoopHandle, MsgForm.WM_HOTKEY_TAP, IntPtr.Zero, IntPtr.Zero);
              } else if (ev != KeyMachine.EvNone) {
                if (ev == KeyMachine.EvOpen) LastOpenTs = Stopwatch.GetTimestamp();
                KeysNative.PostThreadMessageW(_tid, MSG_KEYEVENT, new IntPtr(ev), new IntPtr(m.Arg));
              }
              if ((r & KeyMachine.Swallow) != 0) return new IntPtr(1);
            }
          }
        } catch (Exception) {
          // A throw out of a hook proc would take down every app's input.
          // Swallow here; the state machine self-corrects on the next keypress.
        }
      }
      return Win32.CallNextHookEx(_hook, nCode, wParam, lParam);
    }

    static Win32.INPUT[] MakeDummy() {
      var inputs = new Win32.INPUT[2];
      inputs[0].type = Win32.INPUT_KEYBOARD;
      inputs[0].u.ki.wVk = Win32.VK_DUMMY;
      inputs[1].type = Win32.INPUT_KEYBOARD;
      inputs[1].u.ki.wVk = Win32.VK_DUMMY;
      inputs[1].u.ki.dwFlags = Win32.KEYEVENTF_KEYUP;
      return inputs;
    }

    /// One down/up of VK 0xFF. Windows counts it as the modifier chord's partner.
    static void SendDummyKey() {
      Win32.SendInput(2, _dummy, _inputSize);
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

    // ------------------------------------------------------------ the protocol

    /// Every form of `hotkey`. Program.cs hands the whole request here so the
    /// hook's protocol lives next to the hook.
    ///   {winTap?, altTab?, winKeys?}   switch features (refused in passive)
    ///   {chords?:[names], observe?:[names]}  the feature chords / watched keys, the WHOLE set
    ///                                  each time ([] = none; refused in passive; names checked first)
    ///   {op:'simulate'|'order'}        pure, for tests (passive too)
    ///   {op:'list'|'status'}           read-only (passive too)
    ///   {op:'pick'|'cancel'|'grid', seq, ...}  main acting on an open switcher
    public static string Command(Dictionary<string, object> req, bool passive, string refusal, out object result) {
      result = null;
      string op = Json.GetString(req, "op");
      if (!string.IsNullOrEmpty(op)) {
        switch (op) {
          case "simulate": return Switcher.Simulate(req, out result);
          case "order": return Switcher.OrderFake(req, out result);
          case "list": result = Switcher.ListNow(); return null;
          case "status": result = Status(); return null;
          case "pick":
          case "cancel":
          case "grid": {
            // Arguments first, as everywhere in this protocol: a pick with no
            // tile is malformed in every mode.
            int seq = Json.GetInt(req, "seq", -1);
            if (seq < 0) return "hotkey " + op + " needs seq: the number of the Alt+Tab it belongs to";
            if (op == "pick" && Json.GetInt(req, "index", -1) < 0) return "hotkey pick needs index: the tile that was clicked";
            if (op == "grid" && Json.GetInt(req, "cols", 0) <= 0) return "hotkey grid needs cols: a whole number above 0";
            if (passive) return refusal + ": " + op + " acts on a live Alt+Tab, and a passive sidecar has no keyboard hook";
            int tid = _tid;
            if (tid == 0 || !Installed) return "there is no Alt+Tab to " + op + ": the keyboard hook is not installed";
            uint m = op == "pick" ? MSG_PICK : op == "cancel" ? MSG_CANCEL : MSG_GRID;
            int arg = op == "pick" ? Json.GetInt(req, "index", -1) : op == "grid" ? Json.GetInt(req, "cols", 0) : 0;
            if (!KeysNative.PostThreadMessageW(tid, m, new IntPtr(seq), new IntPtr(arg)))
              return "the keyboard hook thread did not take the " + op + " (Win32 error " + Marshal.GetLastWin32Error() + ")";
            result = Json.Obj("posted", true, "seq", seq);
            return null;
          }
          default:
            return "hotkey: unknown op '" + op + "' (simulate, order, list, status, pick, cancel, grid)";
        }
      }

      bool? wt, at, wk;
      string perr = OptBool(req, "winTap", out wt);
      if (perr != null) return perr;
      perr = OptBool(req, "altTab", out at);
      if (perr != null) return perr;
      perr = OptBool(req, "winKeys", out wk);
      if (perr != null) return perr;
      // lib/features.js: the chords of every feature that is on and healthy, and the keys they
      // watch. Names, not codes, so the protocol reads the same as the feature files.
      int ch, ob;
      perr = ParseNames(req, "chords", KeyMachine.ChordNames, out ch);
      if (perr != null) return perr;
      perr = ParseNames(req, "observe", KeyMachine.KeyNames, out ob);
      if (perr != null) return perr;
      // (The words predate chords and a test pins them; chords/observe also count as something to do.)
      if (!wt.HasValue && !at.HasValue && !wk.HasValue && ch < 0 && ob < 0)
        return "hotkey needs winTap, altTab or winKeys: true or false";
      if (passive) return refusal;
      string err = Configure(wt, at, wk, ch, ob);
      if (err != null) return err;
      result = Status();
      return null;
    }

    static string OptBool(Dictionary<string, object> req, string key, out bool? v) {
      v = null;
      object raw;
      if (!Json.TryGet(req, key, out raw)) return null;
      if (!(raw is bool)) return "hotkey: " + key + " must be true or false, not " + Json.Write(raw);
      v = (bool)raw;
      return null;
    }

    /// `chords` / `observe`: a list of names from `table` -> a bitmask. mask = -1 when the key is
    /// absent (leave it as it is); an empty list is 0 (take nothing). An unknown name is an error
    /// that lists the known ones, so a typo in a feature's chord list says what it should be.
    public static string ParseNames(Dictionary<string, object> req, string key, string[] table, out int mask) {
      mask = -1;
      object raw;
      if (!Json.TryGet(req, key, out raw) || raw == null) return null;
      var list = raw as IList;
      if (list == null) return "hotkey: " + key + " must be a list of names, not " + Json.Write(raw);
      int m = 0;
      foreach (object o in list) {
        string name = o as string;
        int bit = name == null ? -1 : Array.IndexOf(table, name);
        if (bit < 0)
          return "hotkey: unknown " + (key == "chords" ? "chord" : "key") + " " + Json.Write(o) +
                 " (known: " + string.Join(", ", table) + ")";
        m |= 1 << bit;
      }
      mask = m;
      return null;
    }
  }
}

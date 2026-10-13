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
    public const uint MSG_LATE = 0x8000 + 28;       // wParam = vk, lParam = ms the key waited for the hook
    const uint MSG_RAWKEYS = 0x8000 + 29;           // TEST ONLY: wParam = raw key events to pretend arrived

    // HOOK HEALTH (HookHealth.cs): written on the hook thread only - the hook proc stores the tick
    // of its last callback and zeroes the count; each WM_INPUT key event adds one.
    static int _lastCallback;                  // Environment.TickCount of the last hook callback
    static int _rawSinceHook;                  // raw key events since that callback
    static int _rawSeen;                       // raw key events this run (status only)
    static int _healedAt;                      // tick of the last re-install for a dead hook
    static bool _healedOnce;
    static int _heals, _outranked;             // dead hooks re-installed; suspicions an elevated window explained
    static IntPtr _sink = IntPtr.Zero;         // the raw-input window, on the hook thread
    static string _sinkWhy;                    // why there is no raw-input check, when there is none
    static volatile string _health;            // null, or why the hook is gone and could not be put back
    static volatile string _rearmWhy;          // the words for the next MSG_REHOOK
    static bool _rawTestTrust;                 // TEST ONLY: skip the elevated-window check once
    static bool _testFailRehook;               // TEST ONLY: the next dead-hook re-install "fails" (error 5)

    // LATE KEYS (lane shotfix, 2026-09-28). Windows waits at most LowLevelHooksTimeout for this hook
    // (HKCU\Control Panel\Desktop; 1000 ms on Owen's machine, which is also the most Windows 10 1709+
    // waits), then passes the key on as if nothing had swallowed it. So a key we SWALLOW that reaches
    // the hook later than that reached Windows too: Win+Shift+S opens Windows' snip as well as
    // Mantle's, a Win+S also opens Search. Nothing else can see that happen, so the hook proc
    // measures it (KBDLLHOOKSTRUCT.time is the tick the key was made at) and this thread says it:
    // a "keyboard hook:" warning in mantle.log and a `keylate` event for the features.
    static int _limitMs = 1000;
    static string _limitWhy = "not read yet";
    static int _late;                          // swallowed keys that arrived past the limit, this run
    static volatile int _slowest;              // the longest a swallowed key waited for the hook, ms

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
      // The pop-up watch (PopWatch, below) has hooks of its own: every exit road takes them too.
      try { PopWatch.Shutdown(); } catch (Exception) { }
    }

    public static IDictionary Status() {
      if (_limitWhy == "not read yet") ReadLimit();   // no hook thread yet (passive, or off): read it here
      return Json.Obj("installed", Installed, "winTap", Machine.WinTap, "altTab", Machine.AltTab,
                      "winKeys", Machine.WinKeys,
                      "chords", KeyMachine.NamesOf(Machine.Chords, KeyMachine.ChordNames),
                      "observe", KeyMachine.NamesOf(Machine.Observe, KeyMachine.KeyNames),
                      "tracking", Switcher.Tracking,
                      "session", Machine.Active, "seq", Switcher.Seq, "rehooks", _rehooks,
                      "lateKeys", _late, "slowestMs", _slowest, "limitMs", _limitMs, "limitWhy", _limitWhy,
                      "reason", _lastReason,
                      "healthy", _health == null, "health", _health, "heals", _heals,
                      "rawCheck", _sink != IntPtr.Zero, "rawCheckWhy", _sinkWhy, "rawSeen", _rawSeen,
                      "rawSinceHook", _rawSinceHook, "outranked", _outranked,
                      "lastCallbackAgoMs", Installed ? (object)unchecked(Environment.TickCount - _lastCallback) : null);
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
        ReadLimit();   // registry I/O: here, never in the hook proc
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
          _lastCallback = Environment.TickCount;
          _rawSinceHook = 0;
          _health = null;
          Switcher.StartTracking();
          // The dead-hook check (HookHealth.cs). Without it the hook still works; status says why.
          string sw;
          _sink = HookHealth.OpenSink(out sw);
          _sinkWhy = sw == null ? null : "Mantle cannot tell when Windows drops the keyboard hook: " + sw;
          if (sw != null) KeyEvents.Log("warn", "keyboard hook: " + _sinkWhy + "; it is still re-installed on every wake and unlock");
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
            if (msg.message == MSG_REHOOK) {
              string rw = _rearmWhy;
              _rearmWhy = null;
              RehookHere(rw ?? "the switcher asked for it");
              continue;
            }
            if (msg.message == MSG_LATE) { ReportLate((int)msg.wParam.ToInt64(), (int)msg.lParam.ToInt64()); continue; }
            if (msg.message == MSG_RAWKEYS) {
              long tf = msg.lParam.ToInt64();
              _rawTestTrust = (tf & 1) != 0;
              _testFailRehook = (tf & 2) != 0;
              for (int i = (int)msg.wParam.ToInt64(); i > 0; i--) OnRawKey();
              _rawTestTrust = false;
              _testFailRehook = false;
              continue;
            }
            try {
              Switcher.OnThreadMessage(msg.message, msg.wParam, msg.lParam);
            } catch (Exception ex) {
              KeyEvents.Log("error", "alt+tab: the switcher threw " + ex.GetType().Name + ": " + ex.Message +
                                     " (the keyboard hook is still running)");
            }
            continue;
          }
          // Dispatched as well: DefWindowProc frees the raw input.
          if (msg.message == HookHealth.WM_INPUT && msg.hwnd == _sink) OnRawKey();
          KeysNative.TranslateMessage(ref msg);
          KeysNative.DispatchMessageW(ref msg);
        }
      } catch (Exception ex) {
        KeyEvents.Log("error", "the keyboard hook thread stopped on " + ex.GetType().Name + ": " + ex.Message +
                               "; the hook was removed, so the Win key and Alt+Tab are Windows' own again");
      } finally {
        try { Switcher.StopTracking(); } catch (Exception) { }
        IntPtr sink = _sink;
        _sink = IntPtr.Zero;
        HookHealth.CloseSink(sink);
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

    /// Re-install from any thread, unconditionally: main asks on every wake and unlock (hotkey
    /// {op:'rearm'}), because Windows drops low-level hooks while it resumes and never says so.
    /// False when there is no hook to re-install.
    public static bool Rearm(string why) {
      if (!Installed || _tid == 0) return false;
      _rearmWhy = why;
      Post(MSG_REHOOK, 0, 0);
      return true;
    }

    static void RehookHere(string why) { RehookHere(why, false); }

    /// `dead`: the health check saw keys with no callback, so the old hook is gone for certain - a
    /// failure here is then a broken Win key, said in the state strip until a re-install works.
    static void RehookHere(string why, bool dead) {
      if (_proc == null) return;
      IntPtr old = _hook;
      bool fake = dead && _testFailRehook;
      IntPtr h = fake ? IntPtr.Zero : Win32.SetWindowsHookExW(Win32.WH_KEYBOARD_LL, _proc, Win32.GetModuleHandleW(null), 0);
      if (h == IntPtr.Zero) {
        int code = fake ? 5 : Marshal.GetLastWin32Error();
        if (dead) {
          _health = "Windows dropped Mantle's keyboard hook and refused to put it back (Win32 error " + code +
                    "), so the Win key opens Windows' Start, and Alt+Tab and Mantle's shortcuts are Windows' own; " +
                    "Mantle tries again at the next keys it misses, the next wake or unlock";
          KeyEvents.Log("warn", "keyboard hook: " + why + ", and re-installing it failed (Win32 error " + code +
                                "); the Win key, Alt+Tab and Mantle's shortcuts are Windows' own until it works");
          Announce();
        } else {
          KeyEvents.Log("warn", "keyboard hook: " + why + ", and re-installing it failed (Win32 error " +
                                code + "); the old one stays");
        }
        return;
      }
      // No keystroke can reach both hooks: callbacks only arrive while this
      // thread pumps messages, and it is not pumping between these two lines.
      _hook = h;
      if (old != IntPtr.Zero) { try { Win32.UnhookWindowsHookEx(old); } catch (Exception) { } }
      _rehooks++;
      _lastCallback = Environment.TickCount;
      _rawSinceHook = 0;
      KeyEvents.Log(dead ? "warn" : "info", "keyboard hook: " + why + "; it was re-installed (" + _rehooks +
                            (_rehooks == 1 ? " time" : " times") + " this run)");
      if (_health != null) { _health = null; Announce(); }
    }

    /// On the hook thread, per raw key event (WM_INPUT), or per pretend one from the test op.
    /// Cheap until the count passes MissedKeys: one add and a compare.
    static void OnRawKey() {
      _rawSeen++;
      if (++_rawSinceHook < HookHealth.MissedKeys) return;
      int now = Environment.TickCount;
      int quiet = unchecked(now - _lastCallback);
      int v = HookHealth.KeyVerdict(_rawSinceHook, quiet, _healedOnce ? unchecked(now - _healedAt) : -1);
      if (v != 1) return;   // alive, or re-installed a moment ago: give it the backoff first
      if (!_rawTestTrust && HookHealth.ForegroundOutranksUs()) {
        // An admin program's window is in front: its keys never reach a normal process's hook.
        _outranked++;
        _rawSinceHook = 0;
        _lastCallback = now;
        return;
      }
      int missed = _rawSinceHook;
      _healedAt = now;
      _healedOnce = true;
      _heals++;
      RehookHere("Windows stopped calling it (" + missed + " key presses and releases reached Windows in " +
                 ((quiet / 100) / 10.0).ToString(System.Globalization.CultureInfo.InvariantCulture) + " s with no call; Windows drops a hook that answers too slowly, without saying so)", true);
    }

    // ------------------------------------------------------------ late keys

    /// PURE: how long a key made at tick `made` waited until tick `now` (wrap-safe), or
    /// uint.MaxValue for a stamp that makes no sense (a minute or more: a zero or odd stamp).
    public static uint Waited(uint now, uint made) {
      uint w = unchecked(now - made);
      return w < 60000u ? w : uint.MaxValue;
    }

    static uint TickArg(Dictionary<string, object> req, string key) {
      object v;
      return Json.TryGet(req, key, out v) && v is double ? unchecked((uint)(long)(double)v) : 0u;
    }

    /// LowLevelHooksTimeout, as Windows reads it (a DWORD or a string of digits). Unset = 1000 ms,
    /// the most Windows 10 1709+ ever waits, so "late" is never claimed for a key Windows still waited for.
    static void ReadLimit() {
      try {
        using (var k = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(@"Control Panel\Desktop")) {
          object v = k == null ? null : k.GetValue("LowLevelHooksTimeout");
          int ms;
          if (v is int) ms = (int)v;
          else if (v != null && int.TryParse(v.ToString(), out ms)) { }
          else { _limitMs = 1000; _limitWhy = "LowLevelHooksTimeout is not set; 1000 ms assumed (the most Windows waits)"; return; }
          if (ms <= 0 || ms > 1000) { _limitMs = 1000; _limitWhy = "LowLevelHooksTimeout is " + ms + " ms; Windows waits at most 1000"; return; }
          _limitMs = ms;
          _limitWhy = "LowLevelHooksTimeout is " + ms + " ms";
        }
      } catch (Exception e) {
        _limitMs = 1000;
        _limitWhy = "LowLevelHooksTimeout could not be read (" + e.Message + "); 1000 ms assumed";
      }
    }

    static string KeyName(int vk) {
      if ((vk >= 0x30 && vk <= 0x39) || (vk >= 0x41 && vk <= 0x5A)) return ((char)vk).ToString();
      switch (vk) {
        case 0x2C: return "PrintScreen";
        case 0x09: return "Tab";
        case 0x1B: return "Esc";
        case 0x25: return "Left"; case 0x26: return "Up"; case 0x27: return "Right"; case 0x28: return "Down";
        case 0xAD: return "VolumeMute"; case 0xAE: return "VolumeDown"; case 0xAF: return "VolumeUp";
      }
      return "VK 0x" + vk.ToString("X2");
    }

    public static string LateWords(int vk, int ms, int limitMs, int count) {
      return "a key Mantle takes (" + KeyName(vk) + ") reached the keyboard hook " + ms + " ms after it was pressed, " +
             "past Windows' " + limitMs + " ms limit, so Windows had already passed it on: it reached Windows TOO " +
             "(the hook thread did not run in time: the machine or the thread was busy; " + count + (count == 1 ? " key" : " keys") + " this run)";
    }

    /// On the hook thread, from MSG_LATE: allocating is fine here, the key has long gone.
    static void ReportLate(int vk, int ms) {
      _late++;
      string words = LateWords(vk, ms, _limitMs, _late);
      KeyEvents.Log("warn", "keyboard hook: " + words);
      KeyEvents.Enqueue(Json.Obj("ev", "keylate", "vk", vk, "key", KeyName(vk), "ms", ms, "limitMs", _limitMs,
                                 "count", _late, "words", words));
    }

    // ------------------------------------------------------------ the hook

    static IntPtr HookProc(int nCode, IntPtr wParam, IntPtr lParam) {
      // HOOK HEALTH: Windows is still calling us. Two stores, nothing else.
      _lastCallback = Environment.TickCount;
      _rawSinceHook = 0;
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
              if ((r & KeyMachine.Swallow) != 0) {
                // How long this key waited for us (see LATE KEYS): two reads and a subtraction.
                uint waited = Waited(unchecked((uint)Environment.TickCount), unchecked((uint)Marshal.ReadInt32(lParam, 12)));
                if (waited != uint.MaxValue) {
                  if ((int)waited > _slowest) _slowest = (int)waited;
                  if (waited >= (uint)_limitMs) KeysNative.PostThreadMessageW(_tid, MSG_LATE, new IntPtr(vk), new IntPtr((int)waited));
                }
                return new IntPtr(1);
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

    /// Used by WindowList.Focus (the ladder's "alt" rung), not by the gesture: an Alt press makes
    /// Windows undo a LockSetForegroundWindow. Alt down, VK 0xFF down/up, Alt up, in ONE call: the
    /// partner key (as for the solo-Win trick) means the app in front never sees a bare Alt tap,
    /// which in an app with a menu bar OPENS THE MENU - and "no menus are active" is one of the
    /// conditions SetForegroundWindow needs (2026-10-12; the old bare tap could defeat itself).
    /// Then a short wait: SendInput only queues, and the press must be processed before the
    /// SetForegroundWindow that follows it.
    public static void TapAltForFocusLock() {
      const ushort VK_MENU = 0x12;
      var inputs = new Win32.INPUT[4];
      ushort[] vk = { VK_MENU, Win32.VK_DUMMY, Win32.VK_DUMMY, VK_MENU };
      for (int i = 0; i < 4; i++) {
        inputs[i].type = Win32.INPUT_KEYBOARD;
        inputs[i].u.ki.wVk = vk[i];
        if (i == 2 || i == 3) inputs[i].u.ki.dwFlags = Win32.KEYEVENTF_KEYUP;
      }
      Win32.SendInput(4, inputs, Marshal.SizeOf(typeof(Win32.INPUT)));
      System.Threading.Thread.Sleep(15);
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
          case "late": {
            // PURE, for tests (passive too): the LATE KEYS verdict for made-up ticks. Emits nothing.
            uint now = TickArg(req, "now");
            uint made = TickArg(req, "made");
            int limit = Json.GetInt(req, "limitMs", _limitMs);
            uint w = Waited(now, made);
            bool leaked = w != uint.MaxValue && w >= (uint)limit;
            result = Json.Obj("waited", w == uint.MaxValue ? -1 : (long)w, "leaked", leaked,
                              "words", leaked ? LateWords(Json.GetInt(req, "vk", 0), (int)w, limit, 1) : null);
            return null;
          }
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
          case "popwatch": return PopWatch.Command(req, passive, out result);
          case "popesc": return PopWatch.EscTest(req, out result);
          case "rearm": {
            // Main, on every wake and unlock: put both kinds of hook back at the head of the chain.
            // Only ever re-installs hooks this sidecar already has, so passive is fine.
            string why = Json.GetString(req, "why");
            if (string.IsNullOrEmpty(why)) why = "main asked";
            if (why.Length > 80) why = why.Substring(0, 80);
            bool k = Rearm(why + ", and Windows can drop the hook then without saying so");
            bool p = PopWatch.Rearm(why);
            result = Json.Obj("keyboard", k, "popwatch", p, "installed", Installed);
            return null;
          }
          case "hookhealth": {
            // PURE, for tests (passive too): the two dead-hook verdicts for made-up numbers.
            object raw;
            if (Json.TryGet(req, "aheadMs", out raw)) {
              result = Json.Obj("dead", HookHealth.PopVerdict(Json.GetInt(req, "aheadMs", 0), Json.GetInt(req, "agoMs", 0)));
            } else {
              int v = HookHealth.KeyVerdict(Json.GetInt(req, "raw", 0), Json.GetInt(req, "sinceHookMs", 0), Json.GetInt(req, "sinceHealMs", -1));
              result = Json.Obj("verdict", HookHealth.VerdictWord(v));
            }
            return null;
          }
          case "popdrop": {
            if (!passive) return "hotkey popdrop is for tests: only a passive (test) sidecar takes it";
            object inp;
            return PopWatch.TestDrop(Json.TryGet(req, "input", out inp) && inp is bool && (bool)inp, out result);
          }
          case "hooktest":
          case "hookdrop":
          case "rawkeys": {
            // TEST ONLY, passive only: a pass-through keyboard hook (every feature off, nothing is
            // ever swallowed), Windows' silent removal of it (unhooked, the handle kept as if nothing
            // happened), and raw key events that pretend keys were typed. A live sidecar refuses.
            if (!passive) return "hotkey " + op + " is for tests: only a passive (test) sidecar takes it";
            return TestOp(op, req, out result);
          }
          default:
            return "hotkey: unknown op '" + op + "' (simulate, order, list, status, pick, cancel, grid, popwatch, popesc, rearm, hookhealth)";
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

    static string TestOp(string op, Dictionary<string, object> req, out object result) {
      result = null;
      lock (_gate) {
        if (op == "hooktest") {
          object raw;
          bool on = !Json.TryGet(req, "on", out raw) || !(raw is bool) || (bool)raw;
          if (on && !Installed) {
            Machine.Reset();
            Machine.WinTap = false; Machine.AltTab = false; Machine.WinKeys = false;
            Machine.Chords = 0; Machine.Observe = 0;
            string err = StartThread();
            if (err != null) return err;
          } else if (!on && (Installed || _thread != null)) {
            StopThread();
          }
          result = Status();
          return null;
        }
        if (!Installed) return "hotkey " + op + ": there is no keyboard hook (hotkey {op:'hooktest'} installs a test one)";
        if (op == "hookdrop") {
          // What Windows does: the hook stops being called, and nothing about the handle changes.
          bool ok = Win32.UnhookWindowsHookEx(_hook);
          result = Json.Obj("dropped", ok);
          return null;
        }
        int n = Json.GetInt(req, "n", 0);
        if (n < 1 || n > 1000) return "hotkey rawkeys needs n: how many raw key events to pretend (1 to 1000)";
        object t;
        bool trust = Json.TryGet(req, "trust", out t) && t is bool && (bool)t;
        bool fail = Json.TryGet(req, "failRehook", out t) && t is bool && (bool)t;
        bool posted = KeysNative.PostThreadMessageW(_tid, MSG_RAWKEYS, new IntPtr(n), new IntPtr((trust ? 1 : 0) | (fail ? 2 : 0)));
        result = Json.Obj("posted", posted);
        return null;
      }
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

  // ==================================================================== the pop-up watch
  //
  // PopWatch (lane mn-pop, 2026-10-12): while one of the bar's pop-ups is open, Mantle has to know
  // about a click ANYWHERE outside it and about Esc, the way a macOS menu-bar menu closes. A pop-up
  // window's blur cannot see either: a click on the desktop, the taskbar or a window that refuses
  // focus never takes the focus away, and Esc goes to whichever app is in front. So, ONLY while a
  // pop-up is open, this installs a low-level mouse hook and a low-level keyboard hook on a thread
  // of its own (never the mantle-keys thread, never KeyMachine), and drops both when it closes.
  //
  //   hotkey {op:'popwatch', on:true, leaseMs?, hwnd?}   arm, or renew the lease while armed
  //   hotkey {op:'popwatch', on:false}                    disarm
  //   hotkey {op:'popwatch'}                              status
  //   hotkey {op:'popesc', vk, down, mods, fgIsBar, passive, held}   the Esc verdict, pure
  // Events: {ev:'popwatch', op:'click'|'esc'|'off', ...}, queued from the watch thread.
  //
  // THE LEASE: main has to keep renewing the watch (leaseMs, default 6 s). If main hangs, crashes
  // or forgets, the hooks go by themselves when the lease runs out: a mouse and keyboard hook must
  // never outlive the pop-up they serve. It also covers what we cannot see: Windows removes a
  // low-level hook that misses LowLevelHooksTimeout without telling anyone.
  //
  // CLICKS ARE NEVER SWALLOWED. The mouse proc always calls CallNextHookEx: the click that closes
  // the pop-up also does what it would have done anyway (macOS does the same for a click on another
  // app's window).
  //
  // WHY ESC IS SWALLOWED: the Esc that closes a Mantle pop-up must not ALSO reach the app in front.
  // In Helm (Owen's Claude app) an Esc interrupts every running agent, and in most apps it cancels
  // whatever is in progress. A macOS menu consumes its Esc the same way. Outside a pop-up nothing is
  // ever swallowed, because the hooks do not exist. Never swallowed even while armed: an Esc with
  // Ctrl, Alt, Shift or Win held (Ctrl+Shift+Esc, Alt+Esc, Ctrl+Esc, the Alt+Tab switcher's Esc are
  // Windows'), and an Esc while the bar itself is in front (its page handles its own Escape). The
  // keyup of a swallowed Esc is swallowed with it, even after a disarm (held 1 s at most), so the
  // app never sees half a keypress. In passive (test) mode Esc is only observed, never swallowed.
  //
  // The hook procs run inline with every mouse move and keystroke on the desktop: they read a few
  // fields and at most post a thread message. No allocation, no JSON, no I/O, no locks.
  static class PopWatch {
    const int WH_KEYBOARD_LL = 13, WH_MOUSE_LL = 14, HC_ACTION = 0;
    const uint WM_TIMER = 0x0113;
    const uint WM_KEYDOWN = 0x100, WM_KEYUP = 0x101, WM_SYSKEYDOWN = 0x104, WM_SYSKEYUP = 0x105;
    const uint WM_LBUTTONDOWN = 0x201, WM_RBUTTONDOWN = 0x204, WM_MBUTTONDOWN = 0x207, WM_XBUTTONDOWN = 0x20B;
    const uint LLMHF_INJECTED = 0x1, LLMHF_LOWER_IL_INJECTED = 0x2, LLKHF_ALTDOWN = 0x20;
    public const int VK_ESCAPE = 0x1B;

    // Thread messages for the watch thread (WM_APP range, clear of Hotkey's 21..28).
    const uint MSG_CLICK = 0x8000 + 41;   // wParam = button (1..4) | 0x100 if injected, lParam = y<<16 | x&0xFFFF
    const uint MSG_ESC = 0x8000 + 42;     // wParam = 1 if swallowed
    const uint MSG_WAKE = 0x8000 + 43;    // look at the state again (disarm, a held Esc came up)
    const uint MSG_QUIT = 0x8000 + 44;
    const uint MSG_REHOOK = 0x8000 + 45;  // re-install both hooks (main's wake/unlock rearm)

    // HOOK HEALTH (HookHealth.cs): both procs store the tick of their last callback; the watch
    // thread's timer compares it with GetLastInputInfo while armed. One heal per arm at most.
    static volatile int _lastCb;
    static volatile string _rearmWhy;
    static volatile bool _healedThisArm;  // reset by each new arm (under _gate)
    static volatile int _testInputAt;     // TEST ONLY: a pretend GetLastInputInfo tick, 0 = none
    static int _popHeals, _popRehooks, _popOutranked;

    // The verdict's bits.
    public const int Swallow = 1, Report = 2, Held = 4;

    [DllImport("user32.dll")] static extern UIntPtr SetTimer(IntPtr hwnd, UIntPtr id, uint ms, IntPtr proc);
    [DllImport("user32.dll")] static extern bool KillTimer(IntPtr hwnd, UIntPtr id);

    static readonly object _gate = new object();
    static Thread _thread;
    static volatile int _tid;
    static volatile bool _armed;      // a pop-up is open: report clicks and Esc
    static volatile bool _exiting;    // the thread has decided to go (set under _gate)
    static volatile bool _passive;    // observe Esc only
    static volatile bool _escHeld;    // an Esc down was taken and its up not seen yet (hook proc only writes it)
    static volatile IntPtr _bar;      // the armed hwnd: Esc while it is in front is the bar's own
    static long _deadline;            // Stopwatch ticks; under _gate
    static long _drainUntil;          // Stopwatch ticks, 0 = not draining; watch thread only
    static string _pendingOff;        // why the watch ended, for the thread to announce; under _gate
    static int _leaseMs = 6000;
    static volatile int _clicks, _escs;

    static Win32.LowLevelKeyboardProc _keyProc;    // static: the GC must not collect a live hook
    static Win32.LowLevelKeyboardProc _mouseProc;  // (same signature as LowLevelMouseProc)
    static volatile IntPtr _keyHook = IntPtr.Zero;
    static volatile IntPtr _mouseHook = IntPtr.Zero;

    static long MsToTicks(int ms) { return (long)ms * Stopwatch.Frequency / 1000; }

    // ------------------------------------------------------------ the verdict

    /// PURE: what the keyboard proc does with one key while the watch is on. Returns Swallow | Report | Held
    /// bits; `held` is the state from the previous call (an Esc down taken, its up not yet seen).
    ///   not Esc                         pass, nothing reported, held as it was
    ///   Esc up                          swallowed if its down was (held, and not passive); held cleared.
    ///                                   Checked BEFORE the next two rules: an up whose down we ate is ours
    ///                                   whatever is held now, or the app would see half a keypress.
    ///   Esc down + Ctrl/Alt/Shift/Win   pass, nothing reported, held cleared (that press is Windows')
    ///   Esc down, the bar in front      pass, nothing reported, held cleared (the bar's page has it)
    ///   Esc down                        reported on the first down only (not autorepeat), swallowed unless
    ///                                   passive, held set
    public static int EscVerdict(int vk, bool down, bool anyMod, bool fgIsBar, bool passive, bool held) {
      if (vk != VK_ESCAPE) return held ? Held : 0;
      if (!down) return held && !passive ? Swallow : 0;
      if (anyMod || fgIsBar) return 0;
      int r = Held;
      if (!held) r |= Report;
      if (!passive) r |= Swallow;
      return r;
    }

    /// `hotkey {op:'popesc', ...}`: the verdict for made-up input, for tests (passive too). Emits nothing.
    public static string EscTest(Dictionary<string, object> req, out object result) {
      result = null;
      object raw;
      if (!Json.TryGet(req, "vk", out raw) || !(raw is double))
        return "hotkey popesc needs vk: the virtual-key code, as a number (Esc is 27)";
      if (!Json.TryGet(req, "down", out raw) || !(raw is bool))
        return "hotkey popesc needs down: true for a keydown, false for a keyup";
      bool anyMod = false;
      if (Json.TryGet(req, "mods", out raw)) {
        var mods = raw as Dictionary<string, object>;
        if (mods == null) return "hotkey popesc: mods must be an object like {ctrl, alt, shift, win}";
        anyMod = Json.GetBool(mods, "ctrl", false) || Json.GetBool(mods, "alt", false) ||
                 Json.GetBool(mods, "shift", false) || Json.GetBool(mods, "win", false);
      }
      int v = EscVerdict(Json.GetInt(req, "vk", 0), Json.GetBool(req, "down", false), anyMod,
                         Json.GetBool(req, "fgIsBar", false), Json.GetBool(req, "passive", false),
                         Json.GetBool(req, "held", false));
      result = Json.Obj("swallow", (v & Swallow) != 0, "report", (v & Report) != 0, "held", (v & Held) != 0);
      return null;
    }

    // ------------------------------------------------------------ the protocol

    public static string Command(Dictionary<string, object> req, bool passive, out object result) {
      result = null;
      object raw;
      if (!Json.TryGet(req, "on", out raw)) { result = Status(passive); return null; }
      if (!(raw is bool)) return "hotkey popwatch: on must be true or false, not " + Json.Write(raw);
      if (!(bool)raw) {
        bool was;
        lock (_gate) {
          was = _armed;
          if (was) { _armed = false; _pendingOff = "asked"; }
        }
        Post(MSG_WAKE);
        result = Json.Obj("armed", false, "was", was);
        return null;
      }

      int lease = 6000;
      if (Json.TryGet(req, "leaseMs", out raw)) {
        if (!(raw is double) || double.IsNaN((double)raw))
          return "hotkey popwatch: leaseMs must be a number of milliseconds (500 to 60000), not " + Json.Write(raw);
        lease = Json.GetInt(req, "leaseMs", 6000);
        if (lease < 500) lease = 500;
        if (lease > 60000) lease = 60000;
      }
      bool hasHwnd = Json.TryGet(req, "hwnd", out raw);
      if (hasHwnd && !(raw is double) && !(raw is string))
        return "hotkey popwatch: hwnd must be the pop-up's bar window handle (a number or a decimal string), not " + Json.Write(raw);
      IntPtr hwnd = hasHwnd ? Json.GetHwnd(req, "hwnd") : IntPtr.Zero;

      lock (_gate) {
        long now = Stopwatch.GetTimestamp();
        bool renewed = _armed;
        // A thread still alive and not leaving (armed, or holding a swallowed Esc's keyup) is reused.
        bool reuse = _thread != null && !_exiting && _tid != 0;
        if (!reuse) {
          if (_thread != null) { _thread.Join(1500); _thread = null; }
          _passive = passive;
          _escHeld = false;
          _clicks = 0; _escs = 0; _healedThisArm = false;
          _bar = hwnd;
          _deadline = now + MsToTicks(lease);
          _leaseMs = lease;
          _pendingOff = null;
          string err = StartThread();
          if (err != null) return err;
          _armed = true;
          renewed = false;
        } else {
          if (!_armed) { _clicks = 0; _escs = 0; _pendingOff = null; _healedThisArm = false; }
          if (hasHwnd) _bar = hwnd;
          _deadline = now + MsToTicks(lease);
          _leaseMs = lease;
          _armed = true;
        }
        result = Json.Obj("armed", true, "esc", _passive ? "observe" : "swallow", "leaseMs", lease, "renewed", renewed);
        return null;
      }
    }

    static IDictionary Status(bool passive) {
      lock (_gate) {
        long left = 0;
        if (_armed) {
          left = (_deadline - Stopwatch.GetTimestamp()) * 1000 / Stopwatch.Frequency;
          if (left < 0) left = 0;
        }
        return Json.Obj("armed", _armed, "esc", (_armed ? _passive : passive) ? "observe" : "swallow",
                        "leaseLeftMs", left, "clicks", _clicks, "escs", _escs,
                        "hooked", _mouseHook != IntPtr.Zero && _keyHook != IntPtr.Zero,
                        "rehooks", _popRehooks, "heals", _popHeals, "outranked", _popOutranked);
      }
    }

    /// Every exit road (Hotkey.Uninstall): watch off, hooks gone, at once. Any thread; never waits long.
    public static void Shutdown() {
      bool locked = false;
      Thread t = null;
      try {
        locked = Monitor.TryEnter(_gate, 1000);
        if (_armed) { _armed = false; _pendingOff = "asked"; }
        t = _thread;
      } finally {
        if (locked) Monitor.Exit(_gate);
      }
      int tid = _tid;
      if (tid != 0) KeysNative.PostThreadMessageW(tid, MSG_QUIT, IntPtr.Zero, IntPtr.Zero);
      if (t != null) { try { t.Join(500); } catch (Exception) { } }
      // Belt and braces for a thread that never answered: the hooks belong to this process.
      IntPtr k = _keyHook, m = _mouseHook;
      _keyHook = IntPtr.Zero; _mouseHook = IntPtr.Zero;
      if (k != IntPtr.Zero) { try { Win32.UnhookWindowsHookEx(k); } catch (Exception) { } }
      if (m != IntPtr.Zero) { try { Win32.UnhookWindowsHookEx(m); } catch (Exception) { } }
    }

    static void Post(uint msg) {
      int tid = _tid;
      if (tid != 0) KeysNative.PostThreadMessageW(tid, msg, IntPtr.Zero, IntPtr.Zero);
    }

    /// Main's wake/unlock rearm (hotkey {op:'rearm'}): re-install both hooks if a watch is on.
    public static bool Rearm(string why) {
      if (!_armed || _tid == 0 || _exiting) return false;
      _rearmWhy = why;
      Post(MSG_REHOOK);
      return true;
    }

    /// TEST ONLY (passive): drop the mouse hook the way Windows does (the handle kept, no more
    /// calls) and, with `input`, pretend input arrived just now so the next check sees it unseen.
    public static string TestDrop(bool input, out object result) {
      result = null;
      IntPtr m = _mouseHook;
      if (!_armed || m == IntPtr.Zero) return "hotkey popdrop: the pop-up watch is not on (arm it first)";
      bool ok = Win32.UnhookWindowsHookEx(m);
      if (input) _testInputAt = Environment.TickCount;
      result = Json.Obj("dropped", ok);
      return null;
    }

    /// On the watch thread, per timer tick while armed: why both hooks look dead, or null.
    static string DeadCheck() {
      int now = Environment.TickCount;
      int fake = _testInputAt;
      int li = fake != 0 ? fake : HookHealth.LastInputTick(now);
      int ahead = unchecked(li - _lastCb);
      int ago = unchecked(now - li);
      if (!HookHealth.PopVerdict(ahead, ago)) return null;
      _testInputAt = 0;
      _healedThisArm = true;   // one try per pop-up: touch input, for one, can move the clock with no hook call
      if (fake == 0 && HookHealth.ForegroundOutranksUs()) { _popOutranked++; return null; }
      _popHeals++;
      return "input reached Windows " + ago + " ms ago and neither of its hooks was called " +
             "(Windows drops a hook that answers too slowly, without saying so)";
    }

    /// On the watch thread: new hooks at the head of the chain, then the old ones off. False (both
    /// old ones kept) when Windows refused a new one.
    static bool RehookHere(ref IntPtr mh, ref IntPtr kh, string why, bool dead) {
      IntPtr mod = Win32.GetModuleHandleW(null);
      IntPtr nm = Win32.SetWindowsHookExW(WH_MOUSE_LL, _mouseProc, mod, 0);
      int code = nm == IntPtr.Zero ? Marshal.GetLastWin32Error() : 0;
      IntPtr nk = nm == IntPtr.Zero ? IntPtr.Zero : Win32.SetWindowsHookExW(WH_KEYBOARD_LL, _keyProc, mod, 0);
      if (nm != IntPtr.Zero && nk == IntPtr.Zero) {
        code = Marshal.GetLastWin32Error();
        try { Win32.UnhookWindowsHookEx(nm); } catch (Exception) { }
        nm = IntPtr.Zero;
      }
      if (nm == IntPtr.Zero) {
        KeyEvents.Log("warn", "pop-up watch: " + why + ", and re-installing its hooks failed (" + Plain(code) + ")" +
                              (dead ? "; the watch ends, and the bar watches again" : "; the old ones stay"));
        return false;
      }
      IntPtr om = mh, ok = kh;
      _mouseHook = nm; _keyHook = nk;
      mh = nm; kh = nk;
      if (ok != IntPtr.Zero) { try { Win32.UnhookWindowsHookEx(ok); } catch (Exception) { } }
      if (om != IntPtr.Zero) { try { Win32.UnhookWindowsHookEx(om); } catch (Exception) { } }
      _lastCb = Environment.TickCount;
      _popRehooks++;
      KeyEvents.Log(dead ? "warn" : "info", "pop-up watch: " + why + "; its hooks were re-installed (" + _popRehooks +
                                            (_popRehooks == 1 ? " time" : " times") + " this run)");
      return true;
    }

    static string Plain(int code) {
      string words;
      try { words = new System.ComponentModel.Win32Exception(code).Message; } catch (Exception) { words = null; }
      return (string.IsNullOrEmpty(words) ? "Windows gave no reason" : words.TrimEnd('.', ' ')) + ", Win32 error " + code;
    }

    // ------------------------------------------------------------ the thread

    /// Under _gate. Starts the watch thread and waits for both hooks; null, or why it could not.
    static string StartThread() {
      var ready = new ManualResetEvent(false);
      var why = new string[1];
      var abandoned = new bool[1];
      _exiting = false;
      var t = new Thread(delegate () { ThreadMain(ready, why, abandoned); });
      t.IsBackground = true;
      t.Name = "mantle-popwatch";
      // Every click and keystroke on the desktop waits for this thread while it is armed.
      t.Priority = ThreadPriority.Highest;
      t.Start();
      if (!ready.WaitOne(3000)) {
        abandoned[0] = true;
        _exiting = true;
        Post(MSG_QUIT);
        _thread = t;
        return "the pop-up watch thread did not start within 3 s, so a click outside a bar pop-up or Esc will not close it";
      }
      if (why[0] != null) {
        t.Join(1000);
        return why[0];
      }
      _thread = t;
      return null;
    }

    static void ThreadMain(ManualResetEvent ready, string[] why, bool[] abandoned) {
      KeysNative.MSG msg;
      UIntPtr timer = UIntPtr.Zero;
      IntPtr mh = IntPtr.Zero, kh = IntPtr.Zero;
      int me = 0;
      bool ok = false;
      try {
        // Any USER call creates the thread's message queue, before anything is posted to it.
        KeysNative.PeekMessageW(out msg, IntPtr.Zero, 0, 0, KeysNative.PM_NOREMOVE);
        if (abandoned[0]) return;   // StartThread gave up on us: never install anything
        me = Win32.GetCurrentThreadId();
        _tid = me;
        _keyProc = KeyProc;
        _mouseProc = MouseProc;
        IntPtr mod = Win32.GetModuleHandleW(null);
        mh = Win32.SetWindowsHookExW(WH_MOUSE_LL, _mouseProc, mod, 0);
        if (mh == IntPtr.Zero) {
          why[0] = "could not watch for clicks outside the pop-up: Windows refused the mouse hook (" +
                   Plain(Marshal.GetLastWin32Error()) + "), so only clicking its button again closes it";
        } else {
          _mouseHook = mh;
          kh = Win32.SetWindowsHookExW(WH_KEYBOARD_LL, _keyProc, mod, 0);
          if (kh == IntPtr.Zero) {
            why[0] = "could not watch for Esc while a pop-up is open: Windows refused the keyboard hook (" +
                     Plain(Marshal.GetLastWin32Error()) + "), so the pop-up watch is off";
          } else {
            _keyHook = kh;
            _lastCb = Environment.TickCount;
            timer = SetTimer(IntPtr.Zero, UIntPtr.Zero, 200, IntPtr.Zero);
            ok = true;
          }
        }
      } catch (Exception ex) {
        why[0] = "the pop-up watch thread threw " + ex.GetType().Name + ": " + ex.Message;
      }
      if (ok && abandoned[0]) { ok = false; why[0] = "too late"; }
      if (!ok) {
        Unhook(mh, kh, me);
        _exiting = true;
        ready.Set();
        return;
      }
      ready.Set();

      try {
        while (true) {
          int got = KeysNative.GetMessageW(out msg, IntPtr.Zero, 0, 0);
          if (got == 0 || got == -1) { Leave("the pop-up watch's message loop ended"); break; }
          if (msg.hwnd != IntPtr.Zero) {
            KeysNative.TranslateMessage(ref msg);
            KeysNative.DispatchMessageW(ref msg);
            continue;
          }
          if (msg.message == MSG_QUIT) { Leave(null); break; }
          if (msg.message == MSG_REHOOK) {
            string rw = _rearmWhy;
            _rearmWhy = null;
            RehookHere(ref mh, ref kh, (rw ?? "main asked") + ", and Windows can drop the hooks then without saying so", false);
          }
          if (msg.message == MSG_CLICK) {
            if (_armed) {
              int w = (int)msg.wParam.ToInt64();
              int l = (int)msg.lParam.ToInt64();
              int b = w & 0xFF;
              _clicks++;
              KeyEvents.Enqueue(Json.Obj("ev", "popwatch", "op", "click",
                                         "button", b == 1 ? "left" : b == 2 ? "right" : b == 3 ? "middle" : "x",
                                         "x", (int)(short)(l & 0xFFFF), "y", (int)(short)((l >> 16) & 0xFFFF),
                                         "injected", (w & 0x100) != 0));
            }
          } else if (msg.message == MSG_ESC) {
            if (_armed) {
              _escs++;
              KeyEvents.Enqueue(Json.Obj("ev", "popwatch", "op", "esc", "swallowed", msg.wParam != IntPtr.Zero));
            }
          }
          // WM_TIMER, MSG_WAKE and everything else: look at the lease and the drain.
          if (Tick()) break;
          if (_armed && !_healedThisArm) {
            string dead = DeadCheck();
            if (dead != null && !RehookHere(ref mh, ref kh, dead, true)) {
              Leave("Windows dropped the pop-up watch's hooks and refused to put them back");
              break;
            }
          }
        }
      } catch (Exception ex) {
        Leave("the pop-up watch thread stopped on " + ex.GetType().Name + ": " + ex.Message);
      } finally {
        if (timer != UIntPtr.Zero) { try { KillTimer(IntPtr.Zero, timer); } catch (Exception) { } }
        Unhook(mh, kh, me);
      }
    }

    /// On the watch thread, after every message. True = tear down now.
    static bool Tick() {
      string off = null;
      bool go = false;
      lock (_gate) {
        long now = Stopwatch.GetTimestamp();
        if (_armed && now >= _deadline) { _armed = false; _pendingOff = "lease"; }
        off = _pendingOff;
        _pendingOff = null;
        if (_armed) {
          _drainUntil = 0;
        } else if (_escHeld && !_passive) {
          // An Esc down was swallowed and its up is still to come: keep the keyboard hook to take it,
          // a second at most.
          if (_drainUntil == 0) _drainUntil = now + MsToTicks(1000);
          if (now >= _drainUntil) go = true;
        } else {
          go = true;
        }
        if (go) _exiting = true;
      }
      if (off != null) KeyEvents.Enqueue(Json.Obj("ev", "popwatch", "op", "off", "why", off));
      if (go) _drainUntil = 0;
      return go;
    }

    /// The thread is leaving on its own road: say so if a watch was still on.
    static void Leave(string why) {
      string off = null;
      lock (_gate) {
        // A thread StartThread already replaced has no say over the new one's watch.
        if (_thread != null && _thread != Thread.CurrentThread) return;
        if (_armed) { _armed = false; off = why ?? "asked"; }
        else if (_pendingOff != null) off = _pendingOff;
        _pendingOff = null;
        _exiting = true;
      }
      if (off != null) KeyEvents.Enqueue(Json.Obj("ev", "popwatch", "op", "off", "why", off));
    }

    /// This thread's own hooks only: a late finally must never take a newer thread's.
    static void Unhook(IntPtr mh, IntPtr kh, int me) {
      if (kh != IntPtr.Zero) {
        if (_keyHook == kh) _keyHook = IntPtr.Zero;
        try { Win32.UnhookWindowsHookEx(kh); } catch (Exception) { }
      }
      if (mh != IntPtr.Zero) {
        if (_mouseHook == mh) _mouseHook = IntPtr.Zero;
        try { Win32.UnhookWindowsHookEx(mh); } catch (Exception) { }
      }
      if (me != 0 && _tid == me) { _tid = 0; _escHeld = false; }
    }

    // ------------------------------------------------------------ the hooks

    static IntPtr MouseProc(int nCode, IntPtr wParam, IntPtr lParam) {
      _lastCb = Environment.TickCount;   // HOOK HEALTH: still called (one store)
      if (nCode == HC_ACTION && _armed) {
        try {
          uint m = (uint)wParam.ToInt64();
          int b = m == WM_LBUTTONDOWN ? 1 : m == WM_RBUTTONDOWN ? 2 : m == WM_MBUTTONDOWN ? 3 : m == WM_XBUTTONDOWN ? 4 : 0;
          if (b != 0) {
            // MSLLHOOKSTRUCT read in place: pt.x 0, pt.y 4, mouseData 8, flags 12.
            int x = Marshal.ReadInt32(lParam, 0);
            int y = Marshal.ReadInt32(lParam, 4);
            uint flags = (uint)Marshal.ReadInt32(lParam, 12);
            if ((flags & (LLMHF_INJECTED | LLMHF_LOWER_IL_INJECTED)) != 0) b |= 0x100;
            KeysNative.PostThreadMessageW(_tid, MSG_CLICK, new IntPtr(b), new IntPtr((y << 16) | (x & 0xFFFF)));
          }
        } catch (Exception) {
          // A throw out of a hook proc would take down every app's input.
        }
      }
      // Always: a click is never swallowed.
      return Win32.CallNextHookEx(_mouseHook, nCode, wParam, lParam);
    }

    static IntPtr KeyProc(int nCode, IntPtr wParam, IntPtr lParam) {
      _lastCb = Environment.TickCount;   // HOOK HEALTH: still called (one store)
      if (nCode == HC_ACTION) {
        try {
          int vk = Marshal.ReadInt32(lParam, 0);
          if (vk == VK_ESCAPE) {
            uint m = (uint)wParam.ToInt64();
            bool down = m == WM_KEYDOWN || m == WM_SYSKEYDOWN;
            if (down || m == WM_KEYUP || m == WM_SYSKEYUP) {
              bool armed = _armed;
              bool held = _escHeld;
              // Disarmed with a swallowed Esc still down (the drain): its autorepeat and its up are ours.
              if (armed || held) {
                bool anyMod = false, fg = false;
                if (down) {
                  uint flags = (uint)Marshal.ReadInt32(lParam, 8);
                  anyMod = (flags & LLKHF_ALTDOWN) != 0 ||
                           KeysNative.KeyDown(0x11) || KeysNative.KeyDown(0x12) || KeysNative.KeyDown(0x10) ||
                           KeysNative.KeyDown(0x5B) || KeysNative.KeyDown(0x5C);
                  IntPtr bar = _bar;
                  fg = bar != IntPtr.Zero && Win32.GetForegroundWindow() == bar;
                }
                bool passive = _passive;
                int v = EscVerdict(vk, down, anyMod, fg, passive, held);
                _escHeld = (v & Held) != 0;
                if ((v & Report) != 0 && armed) KeysNative.PostThreadMessageW(_tid, MSG_ESC, new IntPtr((v & Swallow) != 0 ? 1 : 0), IntPtr.Zero);
                if (!down && !armed) KeysNative.PostThreadMessageW(_tid, MSG_WAKE, IntPtr.Zero, IntPtr.Zero);
                if ((v & Swallow) != 0) return new IntPtr(1);
              }
            }
          }
        } catch (Exception) {
          // Swallow here: a throw out of a hook proc would take down every app's input.
        }
      }
      return Win32.CallNextHookEx(_keyHook, nCode, wParam, lParam);
    }
  }
}

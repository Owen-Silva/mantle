// DeskClick.cs - the right-click on the empty desktop opens MANTLE's menu (lane mantle-deskmenu,
// 2026-10-15, plan P6; the user: "Yes, Mantle's menu", Shift+right-click keeps Explorer's).
//
// THE ROUTE (picked by a probe of the live 26H2 desktop, 2026-10-15): Progman > SHELLDLL_DefView
// (layered, its icon list hidden) > Mantle's desktop layer > WorkerW. Explorer's DefView sits over
// the layer and takes every click there. Three ways were weighed:
//   (a) THIS ONE. A low-level mouse hook on a thread of its own that, on a right-button DOWN only,
//       asks Windows which window is under the cursor and whether its top-level window is the
//       desktop (GetShellWindow, looked up at every click, so an Explorer restart needs nothing).
//       The desktop: the down and its up are kept from Explorer and main is asked for the menu.
//       Anything else, and Shift held, passes untouched. Left clicks, keyboard focus on the
//       desktop (Alt+F4 there = Shut Down), Win+D, drag and drop: all still Explorer's.
//   (b) Mantle's layer above the icon layer. No hook, but every click on the desktop would land
//       on a window that never takes the keyboard: after a click on the desktop, Delete or Alt+F4
//       would go to the app that had focus. Explorer also re-orders its children on its own
//       (wallpaper or icon changes), and Shift+right-click would have to be faked back to it.
//   (c) Only re-point "Display settings" / "Personalize" (HKCU DesktopBackground). Keeps Explorer's
//       menu, which the user decided against, and needs a Windows change to undo on every exit.
//
// WHAT THE HOOK COSTS. Every mouse event in Windows waits for this thread while it is armed, so:
//   * the proc does one compare for anything but a right button and returns;
//   * the thread does nothing else (no pump of anyone else's windows), at Highest priority;
//   * main's feature (lib/features/deskmenu.js) is `rest: true`: the hook is gone while a game runs;
//   * the decision time of every right-button event is kept (status decisionUs) and tested.
//
// NEVER SILENT. Main must answer `deskmenu.ack` within ackMs (default 1000) of the request. If it
// does not (main hung, its page gone), the click is given back to Explorer (the same right-click,
// injected with a marker this hook lets through), the log says why, and after two misses in a row
// the hook stands down (passes everything) until main arms it again.
//
// HOOK HEALTH. Windows removes a low-level hook that answers too slowly, without a word. Every
// HealthMs on this thread's own timer (no other polling): input reached Windows after this hook's
// last call, and that input was not a key (Hotkey's keyboard hook saw no key then), with no
// elevated window in front and the input on Mantle's desktop = the hook is gone: re-install it and
// log it. One re-install per silent run: after that the hook must be called once before another.
//
// Every exit road unhooks on this thread (Hotkey.Uninstall -> Shutdown).
//
//   deskmenu.arm {on, testClass?, ackMs?}  on/off. Passive: only with testClass (the window class of a
//                                          stand-in desktop), so a test never takes the user's desktop.
//   deskmenu.ack {seq}                     main opened the menu for request seq
//   deskmenu.nack {seq, why}               main cannot open it: the click goes to Explorer now, with why
//   deskmenu.status                        counters, decision times, health
//   deskmenu.health                        run the dead-hook check now
//   deskmenu.testclick {x, y, shift?, under?}  TEST ONLY (passive): one right-click through the real
//                                          proc's decision, on the hook thread (no input is made); under =
//                                          the window under the cursor (decimal hwnd), for a stand-in desktop
//                                          off every monitor, where WindowFromPoint finds nothing
//   deskmenu.testdrop {input?}             TEST ONLY (passive): unhook the way Windows drops a hook;
//                                          input: pretend non-key input arrived just now
// Events: {ev:'deskmenu', op:'down'|'open'|'fallback', seq, x, y (physical px), ...}
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace Mantle {
  [MantleFeature]
  static class DeskClick {
    public static void Register(FeatureTable t) {
      t.Add("deskmenu.arm", Lanes.Ui, Arm);
      t.Add("deskmenu.ack", Lanes.Ui, AckCmd);
      t.Add("deskmenu.nack", Lanes.Ui, NackCmd);
      t.Add("deskmenu.status", Lanes.Ui, StatusCmd);
      t.Add("deskmenu.health", Lanes.Ui, HealthCmd);
      t.Add("deskmenu.testclick", Lanes.Ui, TestClickCmd);
      t.Add("deskmenu.testdrop", Lanes.Ui, TestDropCmd);
    }

    const int WH_MOUSE_LL = 14, WM_RBUTTONDOWN = 0x0204, WM_RBUTTONUP = 0x0205, WM_TIMER = 0x0113;
    const int VK_SHIFT = 0x10;
    const uint GA_ROOT = 2;
    const uint MSG_QUIT = 0x8000 + 101, MSG_TEST = 0x8000 + 102, MSG_DROP = 0x8000 + 103, MSG_HEAL = 0x8000 + 104, MSG_NACK = 0x8000 + 105;
    public const int HealthMs = 20000, QuietMs = 1500, KeySlackMs = 250, MaxMisses = 2;
    public const int AckMsDefault = 1000;
    static readonly IntPtr Marker = new IntPtr(0x4D4E544B);   // "MNTK": our own replayed click

    static readonly object _gate = new object();
    static Thread _thread;
    static volatile int _tid;
    static IntPtr _hook;
    static HookProc _proc;

    // set by arm, read by the proc
    static volatile bool _armed;
    static volatile string _testClass;
    static volatile int _ackMs = AckMsDefault;
    static volatile bool _standDown;
    static volatile string _standWhy;

    // hook thread only (the proc and the loop)
    static bool _downTaken;
    static int _seq;
    static volatile int _pendingSeq;
    static volatile string _nackWhy;
    static UIntPtr _ackTimer = UIntPtr.Zero, _healthTimer = UIntPtr.Zero;
    static int _misses;
    static readonly StringBuilder _cls = new StringBuilder(64);

    // counters (written on the hook thread, read by status)
    static volatile int _lastCb, _healedAt;
    static int _swallowed, _passShift, _passIcons, _passOther, _passOff, _fallbacks, _heals, _outranked, _awayChecks, _unclear;
    static string _lastPass, _lastHealth;
    static readonly long[] _dec = new long[64];
    static int _decN;

    // test slots (passive only)
    static readonly ManualResetEvent _done = new ManualResetEvent(false);
    static readonly object _testGate = new object();
    static int _tx, _ty; static bool _tshift; static IntPtr _tunder; static object _tresult;
    static volatile int _testInputAt;   // a pretend GetLastInputInfo tick, 0 = none

    delegate IntPtr HookProc(int code, IntPtr wp, IntPtr lp);

    [StructLayout(LayoutKind.Sequential)] struct POINT { public int x, y; }
    [StructLayout(LayoutKind.Sequential)] struct MSG { public IntPtr hwnd; public uint message; public UIntPtr wParam; public IntPtr lParam; public uint time; public POINT pt; }
    [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public MOUSEINPUT mi; }

    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SetWindowsHookExW(int id, HookProc fn, IntPtr mod, uint tid);
    [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr h);
    [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr h, int code, IntPtr wp, IntPtr lp);
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
    [DllImport("user32.dll")] static extern IntPtr GetShellWindow();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindowExW(IntPtr parent, IntPtr after, string cls, string name);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassNameW(IntPtr h, StringBuilder sb, int n);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vk);
    [DllImport("user32.dll")] static extern int GetMessageW(out MSG m, IntPtr h, uint a, uint b);
    [DllImport("user32.dll")] static extern bool PeekMessageW(out MSG m, IntPtr h, uint a, uint b, uint remove);
    [DllImport("user32.dll")] static extern bool PostThreadMessageW(int tid, uint msg, UIntPtr wp, IntPtr lp);
    [DllImport("user32.dll")] static extern UIntPtr SetTimer(IntPtr h, UIntPtr id, uint ms, IntPtr fn);
    [DllImport("user32.dll")] static extern bool KillTimer(IntPtr h, UIntPtr id);
    [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
    [DllImport("kernel32.dll")] static extern IntPtr GetModuleHandleW(IntPtr name);
    [DllImport("kernel32.dll")] static extern int GetCurrentThreadId();
    [DllImport("kernel32.dll")] static extern IntPtr OpenThread(uint access, bool inherit, int tid);
    [DllImport("kernel32.dll")] static extern bool GetThreadTimes(IntPtr h, out long created, out long exited, out long kernel, out long user);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);

    // ------------------------------------------------------------ the proc (every mouse event waits on it)

    static IntPtr Proc(int code, IntPtr wp, IntPtr lp) {
      _lastCb = Environment.TickCount;
      if (code >= 0) {
        long m = wp.ToInt64();
        if (m == WM_RBUTTONDOWN || m == WM_RBUTTONUP) {
          long t0 = Stopwatch.GetTimestamp();
          int x = Marshal.ReadInt32(lp, 0), y = Marshal.ReadInt32(lp, 4);
          IntPtr extra = Marshal.ReadIntPtr(lp, IntPtr.Size == 8 ? 24 : 20);
          bool take = OnRight(m == WM_RBUTTONDOWN, x, y, extra == Marker, false, false, IntPtr.Zero);
          Keep(Stopwatch.GetTimestamp() - t0);
          if (take) return new IntPtr(1);
        }
      }
      return CallNextHookEx(IntPtr.Zero, code, wp, lp);
    }

    /// One right-button event: true = keep it from Explorer. On the hook thread only.
    static bool OnRight(bool down, int x, int y, bool ours, bool test, bool testShift, IntPtr testUnder) {
      if (!down) {
        // The up of a down we kept is ALWAYS kept, armed or not, so no window ever sees half a click.
        if (!_downTaken) return false;
        _downTaken = false;
        _pendingSeq = _seq;
        if (_ackTimer != UIntPtr.Zero) KillTimer(IntPtr.Zero, _ackTimer);
        _ackTimer = SetTimer(IntPtr.Zero, UIntPtr.Zero, (uint)_ackMs, IntPtr.Zero);
        KeyEvents.Enqueue(Json.Obj("ev", "deskmenu", "op", "open", "seq", _seq, "x", x, "y", y, "test", test));
        return true;
      }
      _downTaken = false;
      if (ours) return false;                                     // our own replay, for Explorer
      if (!_armed) { _passOff++; return false; }
      if (_standDown) { _passOff++; return false; }
      bool shift = test ? testShift : (GetAsyncKeyState(VK_SHIFT) & 0x8000) != 0;
      string why = Classify(x, y, shift, testUnder);
      if (why != null) {
        if (why == "shift") _passShift++; else if (why == "icons") _passIcons++; else _passOther++;
        _lastPass = why;
        return false;
      }
      _downTaken = true;
      _seq++;
      _swallowed++;
      KeyEvents.Enqueue(Json.Obj("ev", "deskmenu", "op", "down", "seq", _seq, "x", x, "y", y, "test", test));
      return true;
    }

    /// Null = the empty desktop (take it); else why it passes. Cheap user32 reads, no messages sent.
    /// testUnder (a test only): the window Windows would report under the cursor, for a stand-in desktop
    /// off every monitor, where WindowFromPoint finds nothing.
    static string Classify(int x, int y, bool shift, IntPtr testUnder) {
      if (shift) return "shift";
      IntPtr w = testUnder != IntPtr.Zero ? testUnder : WindowFromPoint(new POINT { x = x, y = y });
      if (w == IntPtr.Zero) return "nothing under the cursor";
      IntPtr root = GetAncestor(w, GA_ROOT);
      if (root == IntPtr.Zero) root = w;
      string tc = _testClass;
      if (tc != null) {
        if (ClassOf(root) != tc) return "not the desktop";
      } else {
        IntPtr shell = GetShellWindow();
        bool desk = shell != IntPtr.Zero && root == shell;
        // classic Win10: the icons live in a top-level WorkerW of their own
        if (!desk && ClassOf(root) == "WorkerW" && FindWindowExW(root, IntPtr.Zero, "SHELLDLL_DefView", null) != IntPtr.Zero) desk = true;
        if (!desk) return "not the desktop";
      }
      // Desktop icons shown: the click may be ON an icon, which only Explorer can tell (a cross-process
      // list-view hit test is too slow for a hook), so it stays Explorer's.
      IntPtr dv = FindWindowExW(root, IntPtr.Zero, "SHELLDLL_DefView", null);
      if (dv != IntPtr.Zero) {
        IntPtr lv = FindWindowExW(dv, IntPtr.Zero, "SysListView32", null);
        if (lv != IntPtr.Zero && IsWindowVisible(lv)) return "icons";
      }
      return null;
    }

    /// Compiles the proc's whole path (and its P/Invoke stubs) BEFORE the hook goes in, so the first
    /// right-click never waits on the JIT inside the hook. Reads only: a point no window covers.
    static void Warm() {
      try {
        foreach (var n in new[] { "Proc", "OnRight", "Classify", "ClassOf", "Keep" }) {
          var m = typeof(DeskClick).GetMethod(n, System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static);
          if (m != null) System.Runtime.CompilerServices.RuntimeHelpers.PrepareMethod(m.MethodHandle);
        }
        Classify(int.MinValue / 2, int.MinValue / 2, false, IntPtr.Zero);
        GetAsyncKeyState(VK_SHIFT);
        Json.Obj("ev", "deskmenu", "op", "warm", "seq", 0, "x", 0, "y", 0, "test", false);
        Keep(0); _decN = 0;
      } catch (Exception) { /* a cold first click is slower, nothing worse */ }
    }

    /// CPU time of the hook thread (ms), or -1.
    static double ThreadCpuMs() {
      int tid = _tid;
      if (tid == 0) return -1;
      IntPtr h = OpenThread(0x0800 /* THREAD_QUERY_LIMITED_INFORMATION */, false, tid);
      if (h == IntPtr.Zero) return -1;
      try {
        long c, e, k, u;
        return GetThreadTimes(h, out c, out e, out k, out u) ? Math.Round((k + u) / 10000.0, 2) : -1;
      } finally { CloseHandle(h); }
    }

    static string ClassOf(IntPtr h) {
      _cls.Length = 0;
      return GetClassNameW(h, _cls, _cls.Capacity) > 0 ? _cls.ToString() : "";
    }

    static void Keep(long ticks) {
      _dec[_decN % _dec.Length] = ticks;
      _decN++;
    }

    // ------------------------------------------------------------ the thread

    static void ThreadMain(ManualResetEvent ready, string[] why) {
      MSG msg;
      PeekMessageW(out msg, IntPtr.Zero, 0, 0, 0);   // makes this thread's queue before anything is posted
      _tid = GetCurrentThreadId();
      _proc = Proc;
      Warm();
      _hook = SetWindowsHookExW(WH_MOUSE_LL, _proc, GetModuleHandleW(IntPtr.Zero), 0);
      if (_hook == IntPtr.Zero) {
        why[0] = "Windows refused the mouse hook (" + Plain(Marshal.GetLastWin32Error()) + "), so a right-click on the desktop gives Windows' menu";
        _tid = 0;
        ready.Set();
        return;
      }
      _lastCb = Environment.TickCount;
      _healedAt = _lastCb - 1;
      _healthTimer = SetTimer(IntPtr.Zero, UIntPtr.Zero, HealthMs, IntPtr.Zero);
      ready.Set();
      try {
        while (GetMessageW(out msg, IntPtr.Zero, 0, 0) > 0) {
          if (msg.message == MSG_QUIT) break;
          if (msg.message == WM_TIMER) {
            if (msg.wParam == _ackTimer && _ackTimer != UIntPtr.Zero) { KillTimer(IntPtr.Zero, _ackTimer); _ackTimer = UIntPtr.Zero; AckTimeout(null); }
            else if (msg.wParam == _healthTimer) Health(false);
          } else if (msg.message == MSG_TEST) {
            int at = Environment.TickCount;
            long t0 = Stopwatch.GetTimestamp();
            bool down = OnRight(true, _tx, _ty, false, true, _tshift, _tunder);
            Keep(Stopwatch.GetTimestamp() - t0);
            bool up = OnRight(false, _tx, _ty, false, true, _tshift, _tunder);
            _tresult = Json.Obj("taken", down && up, "down", down, "up", up, "why", down ? null : _lastPass, "seq", _seq);
            _done.Set();
          } else if (msg.message == MSG_NACK) {
            if (_ackTimer != UIntPtr.Zero) { KillTimer(IntPtr.Zero, _ackTimer); _ackTimer = UIntPtr.Zero; }
            AckTimeout(_nackWhy);
          } else if (msg.message == MSG_DROP) {
            // the way Windows drops a hook: no more calls, the handle kept as if nothing happened
            if (_hook != IntPtr.Zero) UnhookWindowsHookEx(_hook);
            _tresult = Json.Obj("dropped", true);
            _done.Set();
          } else if (msg.message == MSG_HEAL) {
            _tresult = Json.Obj("verdict", Health(true));
            _done.Set();
          }
        }
      } finally {
        if (_ackTimer != UIntPtr.Zero) { KillTimer(IntPtr.Zero, _ackTimer); _ackTimer = UIntPtr.Zero; }
        if (_healthTimer != UIntPtr.Zero) { KillTimer(IntPtr.Zero, _healthTimer); _healthTimer = UIntPtr.Zero; }
        IntPtr h = _hook;
        _hook = IntPtr.Zero;
        if (h != IntPtr.Zero) { try { UnhookWindowsHookEx(h); } catch (Exception) { } }
        _tid = 0;
        _downTaken = false;
      }
    }

    /// Main did not say the menu opened in time (or said it cannot: nackWhy): give the click back to
    /// Explorer and say so.
    static void AckTimeout(string nackWhy) {
      int seq = _pendingSeq;
      if (seq == 0) return;
      _pendingSeq = 0;
      _fallbacks++;
      _misses++;
      bool replayed = false;
      string how;
      if (Program.Passive) how = "a test sidecar never clicks, so nothing was given back";
      else {
        replayed = Replay();
        how = replayed ? "so the same right-click went to Windows, which opened its own menu"
                       : "and giving the click back to Windows failed (" + Plain(Marshal.GetLastWin32Error()) + ")";
      }
      if (_misses >= MaxMisses) {
        _standDown = true;
        _standWhy = "Mantle's menu did not open " + _misses + " times in a row, so right-clicks on the desktop go to Windows until Mantle answers again";
      }
      string why = nackWhy != null ? "Mantle's desktop menu could not open: " + nackWhy
                                   : "Mantle's desktop menu did not open within " + _ackMs + " ms of the right-click";
      KeyEvents.Enqueue(Json.Obj("ev", "deskmenu", "op", "fallback", "seq", seq, "why", why, "replayed", replayed,
                                 "standDown", _standDown, "standWhy", _standWhy));
      KeyEvents.Log("warn", "desktop right-click: " + why + ", " + how + (_standDown ? "; " + _standWhy : ""));
    }

    static bool Replay() {
      var a = new INPUT[2];
      a[0].type = 0; a[0].mi.dwFlags = 0x0008; a[0].mi.dwExtraInfo = Marker;   // MOUSEEVENTF_RIGHTDOWN
      a[1].type = 0; a[1].mi.dwFlags = 0x0010; a[1].mi.dwExtraInfo = Marker;   // MOUSEEVENTF_RIGHTUP
      return SendInput(2, a, Marshal.SizeOf(typeof(INPUT))) == 2;
    }

    /// The dead-hook check, on the hook thread. -> what it found (also kept for status).
    static string Health(bool asked) {
      int now = Environment.TickCount;
      int fake = _testInputAt;
      int li = fake != 0 ? fake : HookHealth.LastInputTick(now);
      int ahead = unchecked(li - _lastCb);
      string v;
      if (_hook == IntPtr.Zero) v = "not hooked";
      else if (ahead < QuietMs) v = "alive";
      else if (unchecked(_lastCb - _healedAt) <= 0) { v = "re-installed already; waiting for it to be called once"; _unclear++; }
      else if (fake == 0 && !Hotkey.Installed) { v = "cannot tell (no keyboard hook to tell keys from clicks)"; _unclear++; }
      else if (fake == 0 && unchecked(li - Hotkey.LastKeyCallback) <= KeySlackMs) { v = "alive as far as can be told (the last input was a key)"; }
      else if (fake == 0 && HookHealth.ForegroundOutranksUs()) { v = "cannot tell (an elevated window is in front, and its input never reaches this hook)"; _outranked++; }
      else if (fake == 0 && Away() != null) { v = "cannot tell (" + Away() + ")"; _awayChecks++; }
      else {
        _testInputAt = 0;
        v = Rehook("input reached Windows " + ahead + " ms after the desktop right-click hook last ran, and it was not a key " +
                   "(Windows drops a hook that answers too slowly, without saying so)");
      }
      _lastHealth = v;
      return v;
    }

    static string Away() {
      try { return WindowList.InputElsewhere(); } catch (Exception) { return null; }
    }

    static string Rehook(string why) {
      IntPtr nh = SetWindowsHookExW(WH_MOUSE_LL, _proc, GetModuleHandleW(IntPtr.Zero), 0);
      if (nh == IntPtr.Zero) {
        string w = "desktop right-click: " + why + ", and putting it back failed (" + Plain(Marshal.GetLastWin32Error()) + "); right-clicks on the desktop give Windows' menu";
        KeyEvents.Log("warn", w);
        return "dead; re-install failed";
      }
      IntPtr old = _hook;
      _hook = nh;
      if (old != IntPtr.Zero) { try { UnhookWindowsHookEx(old); } catch (Exception) { } }
      _heals++;
      _healedAt = Environment.TickCount;
      _lastCb = _healedAt;
      KeyEvents.Log("warn", "desktop right-click: " + why + "; the hook was put back");
      return "dead; re-installed";
    }

    static string Plain(int code) {
      string words = null;
      try { words = new System.ComponentModel.Win32Exception(code).Message; } catch (Exception) { }
      return (string.IsNullOrEmpty(words) ? "Windows gave no reason" : words.TrimEnd('.', ' ')) + ", Win32 error " + code;
    }

    // ------------------------------------------------------------ commands

    static string Arm(Dictionary<string, object> req, ref object result) {
      bool on = Json.GetBool(req, "on", true);
      object tcv;
      string tc = Json.TryGet(req, "testClass", out tcv) ? tcv as string : null;
      if (tc != null && (tc.Length == 0 || tc.Length > 64)) tc = null;
      object am;
      int ack = Json.TryGet(req, "ackMs", out am) && am is double ? (int)(double)am : AckMsDefault;
      if (ack < 200) ack = 200; if (ack > 5000) ack = 5000;
      if (on && Program.Passive && tc == null)
        return FeatureTable.PassiveRefusal + ": a test sidecar never takes the real desktop's right-click (pass testClass, the stand-in desktop's window class)";
      if (!on) {
        Stop();
        result = Status();
        return null;
      }
      lock (_gate) {
        _testClass = tc;
        _ackMs = ack;
        _standDown = false;
        _standWhy = null;
        _misses = 0;
        _armed = true;
        if (_tid == 0) {
          string why = StartThread();
          if (why != null) { _armed = false; return why; }
        }
      }
      result = Status();
      return null;
    }

    static string StartThread() {
      var ready = new ManualResetEvent(false);
      var why = new string[1];
      var t = new Thread(delegate () { ThreadMain(ready, why); });
      t.IsBackground = true;
      t.Name = "mantle-deskclick";
      // Every mouse event in Windows waits for this thread while the hook is in.
      t.Priority = ThreadPriority.Highest;
      t.Start();
      if (!ready.WaitOne(3000)) {
        int tid = _tid;
        if (tid != 0) PostThreadMessageW(tid, MSG_QUIT, UIntPtr.Zero, IntPtr.Zero);
        return "the desktop right-click thread did not start within 3 s, so a right-click on the desktop gives Windows' menu";
      }
      if (why[0] != null) { t.Join(1000); return why[0]; }
      _thread = t;
      return null;
    }

    static void Stop() {
      Thread t;
      lock (_gate) { _armed = false; t = _thread; _thread = null; }
      int tid = _tid;
      if (tid != 0) PostThreadMessageW(tid, MSG_QUIT, UIntPtr.Zero, IntPtr.Zero);
      if (t != null) { try { t.Join(1000); } catch (Exception) { } }
    }

    /// Every exit road (Hotkey.Uninstall): the hook off, on its own thread, never waiting long.
    public static void Shutdown() {
      try { Stop(); } catch (Exception) { }
    }

    static string AckCmd(Dictionary<string, object> req, ref object result) {
      object sv;
      int seq = Json.TryGet(req, "seq", out sv) && sv is double ? (int)(double)sv : -1;
      bool acked = seq > 0 && seq == _pendingSeq;
      if (acked) { _pendingSeq = 0; _misses = 0; }
      result = Json.Obj("acked", acked, "seq", seq);
      return null;
    }

    /// Main cannot show the menu for seq: give the click to Explorer now, not after ackMs.
    static string NackCmd(Dictionary<string, object> req, ref object result) {
      object sv, wv;
      int seq = Json.TryGet(req, "seq", out sv) && sv is double ? (int)(double)sv : -1;
      string why = Json.TryGet(req, "why", out wv) ? wv as string : null;
      bool taken = seq > 0 && seq == _pendingSeq && _tid != 0;
      if (taken) {
        _nackWhy = string.IsNullOrEmpty(why) ? "Mantle gave no reason" : (why.Length > 200 ? why.Substring(0, 200) : why);
        PostThreadMessageW(_tid, MSG_NACK, UIntPtr.Zero, IntPtr.Zero);
      }
      result = Json.Obj("taken", taken, "seq", seq);
      return null;
    }

    static string StatusCmd(Dictionary<string, object> req, ref object result) { result = Status(); return null; }

    public static IDictionary Status() {
      int n = Math.Min(_decN, _dec.Length);
      var us = new List<double>(n);
      for (int i = 0; i < n; i++) us.Add(_dec[i] * 1e6 / Stopwatch.Frequency);
      us.Sort();
      object dec = n == 0 ? null : (object)Json.Obj("n", _decN, "p50", Round(us[(n - 1) / 2]), "p95", Round(us[Math.Min(n - 1, (int)Math.Ceiling(n * 0.95) - 1)]), "max", Round(us[n - 1]));
      return Json.Obj("armed", _armed, "hooked", _hook != IntPtr.Zero && _tid != 0, "testClass", _testClass, "ackMs", _ackMs,
                      "standDown", _standDown, "standWhy", _standWhy, "seq", _seq, "swallowed", _swallowed,
                      "passed", Json.Obj("shift", _passShift, "icons", _passIcons, "other", _passOther, "off", _passOff),
                      "lastPass", _lastPass, "fallbacks", _fallbacks, "heals", _heals, "outranked", _outranked,
                      "health", _lastHealth, "lastCallAgoMs", _tid == 0 ? -1 : unchecked(Environment.TickCount - _lastCb),
                      "decisionUs", dec, "threadCpuMs", ThreadCpuMs());
    }

    static double Round(double v) { return Math.Round(v, 1); }

    /// Runs `msg` on the hook thread and waits for its answer (tests and the health check).
    static string OnThread(uint msg, int waitMs, ref object result) {
      lock (_testGate) {
        int tid = _tid;
        if (tid == 0) return "the desktop right-click hook is not armed";
        _done.Reset();
        _tresult = null;
        if (!PostThreadMessageW(tid, msg, UIntPtr.Zero, IntPtr.Zero)) return "the desktop right-click thread did not take the request";
        if (!_done.WaitOne(waitMs)) return "the desktop right-click thread did not answer within " + waitMs + " ms";
        result = _tresult;
        return null;
      }
    }

    static string HealthCmd(Dictionary<string, object> req, ref object result) {
      return OnThread(MSG_HEAL, 2000, ref result);
    }

    static string TestClickCmd(Dictionary<string, object> req, ref object result) {
      if (!Program.Passive) return "deskmenu.testclick is for a test sidecar only";
      object xv, yv;
      if (!Json.TryGet(req, "x", out xv) || !(xv is double) || !Json.TryGet(req, "y", out yv) || !(yv is double))
        return "deskmenu.testclick needs x and y (physical px)";
      lock (_testGate) {
        _tx = (int)(double)xv; _ty = (int)(double)yv; _tshift = Json.GetBool(req, "shift", false);
        object uv;
        long under = 0;
        if (Json.TryGet(req, "under", out uv)) {
          if (uv is double) under = (long)(double)uv;
          else if (uv is string) long.TryParse((string)uv, out under);
        }
        _tunder = new IntPtr(under);
      }
      return OnThread(MSG_TEST, 2000, ref result);
    }

    static string TestDropCmd(Dictionary<string, object> req, ref object result) {
      if (!Program.Passive) return "deskmenu.testdrop is for a test sidecar only";
      if (Json.GetBool(req, "input", false)) _testInputAt = Environment.TickCount;
      return OnThread(MSG_DROP, 2000, ref result);
    }
  }
}

// AltTabLive.cs - the Alt+Tab list follows the desktop while the switcher is up (lane mn-alttab,
// 2026-10-12). Owen took the live list out on 09-29; this puts it back, done the macOS way.
//
// WHAT: on macOS (and in Windows' own Alt+Tab) a window that opens or closes while the switcher is
// up appears or disappears in place, and the selection stays on the same window, or moves to its
// neighbour when that window is the one that closed. Here: while a session is open, four
// out-of-context WinEvent hooks (destroy/show/hide, title change, cloak/uncloak, minimise) mark the
// list dirty; the switcher's own 40 ms Alt watchdog (AltTab.cs OnWatch) rebuilds it once things
// have been quiet for 30 ms (at most 120 ms after the first change), merges it into the list on
// screen and sends `{ev:'switcher', op:'windows'}` only if something a person can see changed.
//
// COST: nothing while the switcher is down. The hooks go in after the `open` event is queued and
// come out on commit, cancel, the watchdog's end and the hook thread's exit, and there is no timer
// of their own. A callback is a handful of compares; a rebuild is Snapshot() (about a millisecond).
//
// THE MERGE (Merge, pure, tested through switcher.rehearse {op:'merge'}):
//   - windows still there keep their place (their title / minimised / hung flags are refreshed);
//   - a new window goes where the fresh most-recent-first order puts it, after the nearest window
//     that order puts before it; never in front of the window Alt+Tab was opened from;
//   - the selection stays on the same window (by handle). If THAT window went, it moves to the one
//     that slid into its place, or to the one before it if it was the last.
//
// TEST FORM: `switcher.rehearse` runs the same session machinery (Snapshot, Order, the hooks,
// Reflow, the events) on a thread of its own, with no keyboard hook, so a passive sidecar and a
// --test Mantle can be checked against real windows. It only reads (EnumWindows, WinEvents).
//
// PRIVACY: no title and no handle ever goes into a log line from here (events carry them to main,
// which never logs them).
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Threading;

namespace Mantle {
  sealed class LiveList {
    // Not every one of these is in Win32.cs, so all of them are spelled out here.
    const uint EV_MINIMIZESTART = 0x0016, EV_MINIMIZEEND = 0x0017;
    const uint EV_DESTROY = 0x8001, EV_SHOW = 0x8002, EV_HIDE = 0x8003;
    const uint EV_NAMECHANGE = 0x800C, EV_CLOAKED = 0x8017, EV_UNCLOAKED = 0x8018;
    public const int QuietMs = 30, MaxWaitMs = 120;

    static readonly uint[][] Ranges = {
      new uint[] { EV_MINIMIZESTART, EV_MINIMIZEEND },
      new uint[] { EV_DESTROY, EV_HIDE },
      new uint[] { EV_NAMECHANGE, EV_NAMECHANGE },
      new uint[] { EV_CLOAKED, EV_UNCLOAKED },
    };

    readonly IntPtr[] _hooks = new IntPtr[4];
    Win32.WinEventProc _proc;                      // a field: the GC must never collect a live hook proc
    readonly HashSet<long> _known = new HashSet<long>();
    bool _dirty;
    long _first, _last;
    public volatile int Hooks;                     // how many are installed right now (status)
    public volatile int Marks;                     // changes noticed this session (status)
    public string HookError;

    /// On the thread whose message loop will deliver the callbacks.
    public void Begin(List<Switcher.Item> items) {
      End();
      Track(items);
      _proc = OnEvent;
      int n = 0;
      for (int i = 0; i < Ranges.Length; i++) {
        _hooks[i] = Win32.SetWinEventHook(Ranges[i][0], Ranges[i][1], IntPtr.Zero, _proc, 0, 0,
                                          Win32.WINEVENT_OUTOFCONTEXT | Win32.WINEVENT_SKIPOWNPROCESS);
        if (_hooks[i] != IntPtr.Zero) n++;
      }
      Hooks = n;
      HookError = null;
      if (n < Ranges.Length) {
        HookError = "Windows refused " + (Ranges.Length - n) + " of the " + Ranges.Length +
                    " window-change hooks, so the Alt+Tab list may not follow windows that open or close while it is up";
        KeyEvents.Log("warn", "alt+tab: " + HookError);
      }
    }

    public void End() {
      for (int i = 0; i < _hooks.Length; i++) {
        if (_hooks[i] != IntPtr.Zero) { try { Win32.UnhookWinEvent(_hooks[i]); } catch (Exception) { } }
        _hooks[i] = IntPtr.Zero;
      }
      Hooks = 0;
      _proc = null;
      _known.Clear();
      _dirty = false;
      _first = _last = 0;
    }

    public bool Active { get { return _proc != null; } }

    public void Track(List<Switcher.Item> items) {
      _known.Clear();
      if (items == null) return;
      foreach (Switcher.Item it in items) _known.Add(it.Hwnd.ToInt64());
    }

    void OnEvent(IntPtr hook, uint ev, IntPtr hwnd, int idObject, int idChild, uint thread, uint time) {
      if (hwnd == IntPtr.Zero || idObject != Win32.OBJID_WINDOW || idChild != 0) return;
      bool listed = _known.Contains(hwnd.ToInt64());
      if (ev == EV_DESTROY || ev == EV_HIDE || ev == EV_CLOAKED || ev == EV_MINIMIZESTART || ev == EV_MINIMIZEEND) {
        // Only a window on the list can leave it or change its "Minimized" chip.
        if (!listed) return;
      } else if (!listed && Win32.GetAncestor(hwnd, Win32.GA_ROOT) != hwnd) {
        return;                                    // a control inside a window: never a tile
      }
      Mark();
    }

    public void Mark() {
      long now = Stopwatch.GetTimestamp();
      if (!_dirty) { _dirty = true; _first = now; }
      _last = now;
      Marks++;
    }

    /// Quiet for QuietMs, or MaxWaitMs since the first change: a window that opens sends show,
    /// title and cloak changes in a burst, and the list is rebuilt once for all of them.
    public bool Due() {
      if (!_dirty) return false;
      long now = Stopwatch.GetTimestamp();
      double f = 1000.0 / Stopwatch.Frequency;
      return (now - _last) * f >= QuietMs || (now - _first) * f >= MaxWaitMs;
    }

    public void Clear() { _dirty = false; _first = _last = 0; }

    // ------------------------------------------------------------ the merge

    /// PURE. `old` as on screen, `fresh` in Order()'s order. Returns the new list; `sel` in and
    /// out; `changed` is false when a person would see no difference (same windows, same order,
    /// same titles and flags).
    public static List<Switcher.Item> Merge(List<Switcher.Item> old, List<Switcher.Item> fresh, IntPtr pin,
                                            ref int sel, out bool changed, out int added, out int removed) {
      var freshBy = new Dictionary<long, Switcher.Item>();
      foreach (Switcher.Item f in fresh) freshBy[f.Hwnd.ToInt64()] = f;
      var result = new List<Switcher.Item>(fresh.Count);
      var oldSet = new HashSet<long>();
      removed = 0;
      foreach (Switcher.Item o in old) {
        long k = o.Hwnd.ToInt64();
        oldSet.Add(k);
        Switcher.Item f;
        if (freshBy.TryGetValue(k, out f)) result.Add(f);
        else removed++;
      }
      // New windows, each after the nearest window the fresh order puts before it.
      added = 0;
      int pos = -1;
      foreach (Switcher.Item f in fresh) {
        long k = f.Hwnd.ToInt64();
        if (oldSet.Contains(k)) { pos = IndexOf(result, k) + 1; continue; }
        int at = pos;
        if (at < 0) at = result.Count > 0 && result[0].Hwnd == pin && pin != IntPtr.Zero ? 1 : 0;
        result.Insert(at, f);
        pos = at + 1;
        added++;
      }
      // The selection, by handle.
      int was = sel;
      sel = -1;
      if (was >= 0 && was < old.Count) {
        int idx = IndexOf(result, old[was].Hwnd.ToInt64());
        if (idx < 0) {
          // It went: the window that slid into its place, else the one before it.
          for (int i = was + 1; i < old.Count && idx < 0; i++) idx = IndexOf(result, old[i].Hwnd.ToInt64());
          for (int i = was - 1; i >= 0 && idx < 0; i--) idx = IndexOf(result, old[i].Hwnd.ToInt64());
        }
        sel = idx;
      }
      if (sel < 0 && result.Count > 0) sel = Math.Min(Math.Max(was, 0), result.Count - 1);
      changed = result.Count != old.Count;
      for (int i = 0; !changed && i < result.Count; i++) {
        Switcher.Item a = result[i], b = old[i];
        changed = a.Hwnd != b.Hwnd || a.Title != b.Title || a.Minimized != b.Minimized || a.Hung != b.Hung;
      }
      if (!changed) sel = was;
      return result;
    }

    static int IndexOf(List<Switcher.Item> l, long k) {
      for (int i = 0; i < l.Count; i++) if (l[i].Hwnd.ToInt64() == k) return i;
      return -1;
    }

    /// Rebuild, merge and tell main. On the session's own thread. True if an update went out.
    public static bool Reflow(ref List<Switcher.Item> items, ref int sel, IntPtr fgRoot, int seq, LiveList live, bool rehearsal) {
      live.Clear();
      IntPtr fg;
      var fresh = Switcher.Snapshot(out fg);
      Switcher.Order(fresh, fg);
      bool changed;
      int added, removed, s = sel;
      var merged = Merge(items, fresh, fgRoot, ref s, out changed, out added, out removed);
      if (!changed) return false;
      items = merged;
      sel = s;
      live.Track(items);
      var list = new List<object>(items.Count);
      int current = -1;
      for (int i = 0; i < items.Count; i++) {
        list.Add(Switcher.ItemJson(items[i]));
        if (items[i].Hwnd == fgRoot) current = i;
      }
      var d = Json.Obj("ev", "switcher", "op", "windows", "seq", seq, "sel", sel, "current", current,
                       "list", list, "added", added, "removed", removed);
      if (rehearsal) d["rehearsal"] = true;
      KeyEvents.Enqueue(d);
      return true;
    }
  }

  /// `switcher.rehearse`: an Alt+Tab session with no keyboard, for the tests (lib/switcher.live.test.js).
  ///   {op:'open'}           a session on the live desktop's list, on its own thread: emits `open`
  ///                         (rehearsal:true), then `windows` as windows come and go
  ///   {op:'select', hwnd}   move the selection to that window (what Tab does): emits `move`
  ///   {op:'close'}          end it: hooks out, emits `cancel`
  ///   {op:'status'}         {open, seq, sel, n, hooks, marks, updates}
  ///   {op:'merge', old:[hwnd], fresh:[hwnd], sel, pin, titles:{hwnd:title}, min:[hwnd]}  Merge, pure
  [MantleFeature]
  static class SwitcherRehearsal {
    const uint MSG_SELECT = 0x8000 + 41, MSG_END = 0x8000 + 42;
    const uint TickMs = 40;
    static readonly object _lock = new object();
    static Thread _t;
    static volatile int _tid, _seq, _sel = -1, _n, _updates;
    static int _seqN;
    static LiveList _live;

    public static void Register(FeatureTable t) {
      t.Add("switcher.rehearse", Lanes.Ui, Run);
    }

    static string Run(Dictionary<string, object> req, ref object result) {
      string op = Json.GetString(req, "op") ?? "status";
      switch (op) {
        case "merge": return MergeFake(req, ref result);
        case "status": {
          LiveList l = _live;
          result = Json.Obj("open", _tid != 0, "seq", _seq, "sel", _sel, "n", _n,
                            "hooks", l == null ? 0 : l.Hooks, "marks", l == null ? 0 : l.Marks, "updates", _updates);
          return null;
        }
        case "open": {
          lock (_lock) {
            if (_tid != 0) return "a rehearsal is already open (#" + _seq + "): close it first";
            var ready = new ManualResetEvent(false);
            int seq = 800000 + (++_seqN);
            _t = new Thread(delegate () { Loop(seq, ready); });
            _t.IsBackground = true;
            _t.Name = "mantle-switch-rehearsal";
            _t.Start();
            if (!ready.WaitOne(4000)) return "the rehearsal thread did not start within 4 s";
            result = Json.Obj("seq", seq, "n", _n, "sel", _sel, "hooks", _live == null ? 0 : _live.Hooks);
            return null;
          }
        }
        case "select": {
          IntPtr h = Json.GetHwnd(req, "hwnd");
          if (h == IntPtr.Zero) return "switcher.rehearse select needs hwnd";
          int tid = _tid;
          if (tid == 0) return "there is no rehearsal open to select in";
          if (!KeysNative.PostThreadMessageW(tid, MSG_SELECT, IntPtr.Zero, h)) return "the rehearsal thread did not take the select";
          result = Json.Obj("posted", true, "seq", _seq);
          return null;
        }
        case "close": {
          Thread t;
          lock (_lock) {
            int tid = _tid;
            t = _t;
            if (tid == 0 || t == null) { result = Json.Obj("closed", false, "reason", "none was open"); return null; }
            KeysNative.PostThreadMessageW(tid, MSG_END, IntPtr.Zero, IntPtr.Zero);
          }
          bool joined = t.Join(4000);
          result = Json.Obj("closed", joined, "hooks", _live == null ? 0 : _live.Hooks);
          return null;
        }
        default:
          return "switcher.rehearse: unknown op '" + op + "' (open, select, close, status, merge)";
      }
    }

    static void Loop(int seq, ManualResetEvent ready) {
      List<Switcher.Item> items = null;
      int sel = -1;
      IntPtr fgRoot = IntPtr.Zero;
      var live = new LiveList();
      UIntPtr timer = UIntPtr.Zero;
      try {
        KeysNative.MSG msg;
        KeysNative.PeekMessageW(out msg, IntPtr.Zero, 0, 0, 0);    // make this thread's message queue
        _tid = GetCurrentThreadId();
        items = Switcher.Snapshot(out fgRoot);
        Switcher.Order(items, fgRoot);
        bool fgFirst = items.Count > 0 && items[0].Hwnd == fgRoot;
        sel = SwitchMath.Initial(items.Count, fgFirst, false);
        var list = new List<object>(items.Count);
        foreach (Switcher.Item it in items) list.Add(Switcher.ItemJson(it));
        var open = Json.Obj("ev", "switcher", "op", "open", "seq", seq, "sel", sel, "backwards", false,
                            "current", fgFirst ? 0 : -1, "list", list, "tracking", Switcher.Tracking,
                            "ms", 0.0, "keyAt", 0.0, "rehearsal", true);
        Switcher.AddMonitor(open, fgRoot);
        _seq = seq; _sel = sel; _n = items.Count; _updates = 0;
        KeyEvents.Enqueue(open);
        live.Begin(items);
        _live = live;
        timer = KeysNative.SetTimer(IntPtr.Zero, UIntPtr.Zero, TickMs, IntPtr.Zero);
        ready.Set();
        while (KeysNative.GetMessageW(out msg, IntPtr.Zero, 0, 0) > 0) {
          if (msg.hwnd != IntPtr.Zero) { KeysNative.TranslateMessage(ref msg); KeysNative.DispatchMessageW(ref msg); continue; }
          if (msg.message == MSG_END) break;
          if (msg.message == KeysNative.WM_TIMER) {
            if (live.Due() && LiveList.Reflow(ref items, ref sel, fgRoot, seq, live, true)) { _updates++; _sel = sel; _n = items.Count; }
          } else if (msg.message == MSG_SELECT) {
            long want = msg.lParam.ToInt64();
            for (int i = 0; i < items.Count; i++) {
              if (items[i].Hwnd.ToInt64() != want) continue;
              sel = i; _sel = sel;
              KeyEvents.Enqueue(Json.Obj("ev", "switcher", "op", "move", "seq", seq, "sel", sel, "key", "rehearsal"));
              break;
            }
          }
        }
      } catch (Exception ex) {
        KeyEvents.Log("error", "switcher rehearsal threw " + ex.GetType().Name + ": " + ex.Message);
      } finally {
        if (timer != UIntPtr.Zero) KeysNative.KillTimer(IntPtr.Zero, timer);
        live.End();
        KeyEvents.Enqueue(Json.Obj("ev", "switcher", "op", "cancel", "seq", seq, "why", "the rehearsal ended", "rehearsal", true));
        _tid = 0;
        ready.Set();
      }
    }

    [System.Runtime.InteropServices.DllImport("kernel32.dll")] static extern int GetCurrentThreadId();

    static Switcher.Item Fake(object h, Dictionary<string, object> titles, HashSet<string> min) {
      var it = new Switcher.Item();
      string k = Convert.ToString(h, CultureInfo.InvariantCulture);
      long v;
      long.TryParse(k, NumberStyles.Integer, CultureInfo.InvariantCulture, out v);
      it.Hwnd = new IntPtr(v);
      object t;
      it.Title = titles != null && titles.TryGetValue(k, out t) ? Convert.ToString(t, CultureInfo.InvariantCulture) : "w" + k;
      it.Minimized = min.Contains(k);
      return it;
    }

    static string MergeFake(Dictionary<string, object> req, ref object result) {
      object o, f;
      if (!Json.TryGet(req, "old", out o) || !(o is IList) || !Json.TryGet(req, "fresh", out f) || !(f is IList))
        return "switcher.rehearse merge needs old and fresh: lists of handles";
      object tr, mr;
      var titles = Json.TryGet(req, "titles", out tr) ? tr as Dictionary<string, object> : null;
      var min = new HashSet<string>();
      if (Json.TryGet(req, "min", out mr) && mr is IList) foreach (object m in (IList)mr) min.Add(Convert.ToString(m, CultureInfo.InvariantCulture));
      var old = new List<Switcher.Item>();
      foreach (object h in (IList)o) old.Add(Fake(h, null, new HashSet<string>()));
      var fresh = new List<Switcher.Item>();
      foreach (object h in (IList)f) fresh.Add(Fake(h, titles, min));
      // the old list's titles are the defaults, so a `titles` entry is a title change
      int sel = Json.GetInt(req, "sel", -1);
      bool changed;
      int added, removed;
      var merged = LiveList.Merge(old, fresh, Json.GetHwnd(req, "pin"), ref sel, out changed, out added, out removed);
      var hw = new List<object>();
      foreach (Switcher.Item it in merged) hw.Add(it.Hwnd.ToInt64().ToString(CultureInfo.InvariantCulture));
      result = Json.Obj("list", hw, "sel", sel, "changed", changed, "added", added, "removed", removed);
      return null;
    }
  }
}

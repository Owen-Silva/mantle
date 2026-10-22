// UnderDup.cs - `underwatch`: the row under the top bar, read on the SAME frame the screen changes there
// (lane mantle-topbar-instant, 2026-10-11). DXGI Desktop Duplication, no polling.
//
// The user: "can you still make it faster? ... cause there is still a delay that i can see". The poll
// (UnderRow.cs, 8-15 reads a second) read the row at fixed times: a read taken just BEFORE a window
// repainted saw the old colour, and the new one waited for the next read (66-125 ms). Desktop
// Duplication hands this thread each new desktop frame as DWM presents it, with the rectangles that
// changed; when one of them crosses the row, this copies that ONE row on the GPU into a 1-row staging
// texture, averages it into n columns exactly like UnderRow.Read (and lib/topbar-under.js columnsOf),
// and PUSHES it to main as an `underrow` event. Nothing under the row changed = nothing is read.
//
// THE RATE. Main's page costs ~4-6 ms of CPU per painted frame (Chromium), so pushes are spaced: a
// change after a quiet spell is pushed at once (the leading edge: a tab or window switch lands on the
// next frame); while the row keeps changing, at most one push per minMs, then per busyMs once it has
// kept changing for sustainMs; the LAST state is always pushed (the trailing edge). Each frame that
// crosses the row is copied on the GPU (cheap) even when its push waits, so the push is always the
// newest frame.
//
// STOPS ITSELF: main asks with on:true at least every KeepAliveMs (its 1 s safety read); when it stops
// asking (the bar hidden, a game, the light theme, Mantle gone) the duplication is released within
// KeepAliveMs even if the on:false never arrives. on:false releases it at once.
//
// FALLBACK, SAID: when duplication cannot run (a secure desktop or the lock screen: ACCESS_DENIED /
// ACCESS_LOST, a display mode change, a rotated output, another adapter, too many duplicators) it emits
// {kind:"state", mode:"poll", reason} and main reads the row by polling `underrow` as before; it retries
// every RetryMs and emits mode:"frames" when it is back.
//
// COST (measured 2026-10-11, the user's desktop with ~17-37 frames/s changing somewhere on it): with the default
// D3D11 device the driver's worker thread spun on every AcquireNextFrame / ReleaseFrame, 2-3% of a core
// for a row that never changed; the device is now SINGLETHREADED + PREVENT_INTERNAL_THREADING_OPTIMIZATIONS
// and the same desktop costs 0.15-0.3% (about 0.05 ms a frame). A still desktop wakes nothing.
//
// Read-only (nothing on screen changes), so it runs in passive mode (the --test sidecar) too.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;

namespace Mantle {
  static class UnderDup {
    // ------------------------------------------------------------------ the interop (raw vtables: csc 5, no SharpDX)
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate uint Release_(IntPtr self);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int QI_(IntPtr self, ref Guid iid, out IntPtr obj);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int EnumAt_(IntPtr self, uint i, out IntPtr obj);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int OutDesc_(IntPtr self, out OUTPUT_DESC d);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int Duplicate_(IntPtr self, IntPtr device, out IntPtr dup);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate void DupDesc_(IntPtr self, out OUTDUPL_DESC d);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int Acquire_(IntPtr self, uint timeoutMs, out FRAME_INFO info, out IntPtr resource);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int Rects_(IntPtr self, uint size, IntPtr buf, out uint required);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int ReleaseFrame_(IntPtr self);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int CreateTex_(IntPtr self, ref TEX2D_DESC d, IntPtr init, out IntPtr tex);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate void TexDesc_(IntPtr self, out TEX2D_DESC d);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int Map_(IntPtr self, IntPtr res, uint sub, uint type, uint flags, out MAPPED m);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate void Unmap_(IntPtr self, IntPtr res, uint sub);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate void CopyRegion_(IntPtr self, IntPtr dst, uint dstSub, uint x, uint y, uint z, IntPtr src, uint srcSub, ref BOX box);

    [DllImport("dxgi.dll")] static extern int CreateDXGIFactory1(ref Guid iid, out IntPtr factory);
    [DllImport("d3d11.dll")] static extern int D3D11CreateDevice(IntPtr adapter, int driverType, IntPtr software, uint flags,
      IntPtr levels, uint nLevels, uint sdk, out IntPtr device, out int level, out IntPtr context);
    [DllImport("kernel32.dll")] static extern void GetSystemTimePreciseAsFileTime(out long ft);
    [DllImport("kernel32.dll")] static extern bool QueryPerformanceCounter(out long v);
    [DllImport("kernel32.dll")] static extern bool QueryPerformanceFrequency(out long v);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct OUTPUT_DESC {
      [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string DeviceName;
      public Win32.RECT Desk; public int Attached; public int Rotation; public IntPtr Monitor;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct OUTDUPL_DESC { public uint W, H, RefN, RefD, Format, Scanline, Scaling; public int Rotation; public int InSystemMemory; }
    [StructLayout(LayoutKind.Sequential)]
    struct FRAME_INFO {
      public long LastPresentTime, LastMouseUpdateTime; public uint AccumulatedFrames; public int RectsCoalesced, ProtectedMasked;
      public int PtrX, PtrY, PtrVisible; public uint TotalMetadataBufferSize, PointerShapeBufferSize;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct TEX2D_DESC { public uint Width, Height, MipLevels, ArraySize, Format, SampleCount, SampleQuality, Usage, BindFlags, CpuAccess, Misc; }
    [StructLayout(LayoutKind.Sequential)] struct MAPPED { public IntPtr Data; public uint RowPitch, DepthPitch; }
    [StructLayout(LayoutKind.Sequential)] struct BOX { public uint Left, Top, Front, Right, Bottom, Back; }

    static Guid IID_Factory1 = new Guid("770aae78-f26f-4dba-a829-253c83d1b387");
    static Guid IID_Output1 = new Guid("00cddea8-939b-4b83-a340-a685226666cc");
    static Guid IID_Tex2D = new Guid("6f15aaf2-d208-4e89-9ab4-489535d34f9c");

    const int S_OK = 0;
    const int WAIT_TIMEOUT = unchecked((int)0x887A0027), ACCESS_LOST = unchecked((int)0x887A0026),
              NOT_FOUND = unchecked((int)0x887A0002), UNSUPPORTED = unchecked((int)0x887A0004),
              NOT_AVAILABLE = unchecked((int)0x887A0022), ACCESS_DENIED = unchecked((int)0x80070005),
              MORE_DATA = unchecked((int)0x887A0003), SESSION_GONE = unchecked((int)0x887A0028);
    const uint FMT_BGRA = 87, FMT_BGRA_SRGB = 91;

    static T Fn<T>(IntPtr obj, int slot) where T : class {
      IntPtr vt = Marshal.ReadIntPtr(obj);
      return (T)(object)Marshal.GetDelegateForFunctionPointer(Marshal.ReadIntPtr(vt, slot * IntPtr.Size), typeof(T));
    }
    static void Rel(ref IntPtr p) { if (p != IntPtr.Zero) { try { Marshal.Release(p); } catch (Exception) { } p = IntPtr.Zero; } }
    // the per-frame calls, bound once per object (a delegate per call cost ~1 ms of CPU a frame, measured)
    static Acquire_ _acq; static ReleaseFrame_ _rf; static Rects_ _moveR, _dirtyR;
    static Map_ _mapD; static Unmap_ _unmapD; static CopyRegion_ _copyD;
    static string Hr(int hr) {
      switch (hr) {
        case ACCESS_LOST: return "the desktop changed under it (a mode change, a secure desktop, a full-screen app)";
        case ACCESS_DENIED: return "Windows refused it (a secure desktop: the lock screen or a UAC prompt)";
        case UNSUPPORTED: return "this display or graphics driver does not support it";
        case NOT_AVAILABLE: return "too many apps are already duplicating this display";
        case SESSION_GONE: return "the session is disconnected (remote desktop)";
        case NOT_FOUND: return "the display was not found";
      }
      return "0x" + hr.ToString("X8");
    }

    // ------------------------------------------------------------------ the request (main's side, under _gate)
    const int KeepAliveMs = 3000;   // no on:true for this long = stop (main asks every 1 s)
    const int RetryMs = 1000;       // after a failure, try duplication again this often
    const int WaitMs = 250;         // the longest one wait for a frame (the stop and keep-alive checks)
    static readonly object _gate = new object();
    static readonly AutoResetEvent _wake = new AutoResetEvent(false);
    static Thread _thread;
    static bool _want;
    static int _x, _y, _w, _n, _minMs = 33, _busyMs = 100, _sustainMs = 500, _askTick, _gen;
    // status, read by the command (written by the thread under _gate)
    static string _mode = "off", _reason;
    static long _frames, _hits, _pushes, _copies, _starts;
    static double _lastLagMs, _lastWorkMs;
    static long _cyAcq, _cyRest, _ptrOnly;   // this thread's CPU cycles: inside AcquireNextFrame, and the rest of a frame
    [DllImport("kernel32.dll")] static extern bool QueryThreadCycleTime(IntPtr thread, out ulong cycles);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentThread();
    static long Cyc() { ulong c; QueryThreadCycleTime(GetCurrentThread(), out c); return (long)c; }

    public static string Cmd(Dictionary<string, object> req, ref object result) {
      bool on = Json.GetBool(req, "on", true);
      lock (_gate) {
        if (!on) {
          bool was = _want;
          _want = false;
          _gen++;
          _wake.Set();
          result = Json.Obj("ok", true, "on", false, "was", was, "mode", "off");
          return null;
        }
        int x = Json.GetInt(req, "x", 0), y = Json.GetInt(req, "y", 0), w = Json.GetInt(req, "w", 0), n = Json.GetInt(req, "n", 0);
        if (w <= 0 || w > 16384) return "underwatch: w must be 1..16384 physical pixels";
        if (n <= 0 || n > w) return "underwatch: n must be between 1 and w (" + w + ")";
        int minMs = Math.Max(0, Math.Min(1000, Json.GetInt(req, "minMs", 33)));
        int busyMs = Math.Max(minMs, Math.Min(2000, Json.GetInt(req, "busyMs", 100)));
        int sustainMs = Math.Max(0, Math.Min(10000, Json.GetInt(req, "sustainMs", 500)));
        bool moved = !_want || x != _x || y != _y || w != _w || n != _n;
        _x = x; _y = y; _w = w; _n = n; _minMs = minMs; _busyMs = busyMs; _sustainMs = sustainMs;
        _askTick = Environment.TickCount;
        _want = true;
        if (moved) { _gen++; _wake.Set(); }
        if (_thread == null || !_thread.IsAlive) {
          _thread = new Thread(Run);
          _thread.IsBackground = true;
          _thread.Name = "underwatch";
          _thread.Priority = ThreadPriority.AboveNormal;
          _thread.Start();
        }
        result = Json.Obj("ok", true, "on", true, "mode", _mode, "reason", _reason, "frames", _frames, "hits", _hits,
                          "copies", _copies, "pushes", _pushes, "starts", _starts, "lagMs", Math.Round(_lastLagMs, 2),
                          "workMs", Math.Round(_lastWorkMs, 3), "kcycAcquire", _cyAcq / 1000, "kcycRest", _cyRest / 1000, "pointerOnly", _ptrOnly);
        return null;
      }
    }

    static void SetMode(string mode, string reason) {
      bool emit;
      lock (_gate) { emit = mode != _mode || reason != _reason; _mode = mode; _reason = reason; }
      if (emit) Features.Event("underrow", Json.Obj("kind", "state", "mode", mode, "reason", reason));
    }

    // ------------------------------------------------------------------ the thread
    static IntPtr _dev, _ctx, _out1, _dup, _stage;
    static int _dx, _dy, _dw, _dh;       // the output's desktop rect (physical px)
    static int _sw;                       // the staging texture's width
    static uint _fmt;
    static byte[] _row = new byte[0];
    static byte[] _last;
    static long _qpf;

    static void Run() {
      QueryPerformanceFrequency(out _qpf);
      int gen = -1, x = 0, y = 0, w = 0, n = 0, minMs = 33, busyMs = 100, sustainMs = 500;
      int nextTry = 0;
      long lastPushQ = 0, motionFromQ = 0, lastHitQ = 0, pendingQ = 0;
      bool pending = false;
      try {
        for (;;) {
          bool want; int ask;
          lock (_gate) {
            want = _want; ask = _askTick;
            if (_gen != gen) { gen = _gen; x = _x; y = _y; w = _w; n = _n; _last = null; pending = false; Drop(); }
            minMs = _minMs; busyMs = _busyMs; sustainMs = _sustainMs;
          }
          if (want && unchecked(Environment.TickCount - ask) > KeepAliveMs) {
            lock (_gate) { if (_askTick == ask) _want = false; }
            want = false;
            Program.EmitLog("info", "underwatch: main stopped asking for " + KeepAliveMs + " ms, so the frame watch stopped");
          }
          if (!want) {
            Drop(); FreeDevice();
            SetMode("off", null);
            _wake.WaitOne(1000);
            lock (_gate) { if (!_want) { if (_thread == Thread.CurrentThread) _thread = null; return; } }
            continue;
          }
          if (_dup == IntPtr.Zero) {
            if (unchecked(Environment.TickCount - nextTry) < 0) { _wake.WaitOne(Math.Max(1, -unchecked(Environment.TickCount - nextTry))); continue; }
            string why = Start(x, y, w);
            if (why != null) {
              Drop(); FreeDevice();
              SetMode("poll", why);
              nextTry = unchecked(Environment.TickCount + RetryMs);
              continue;
            }
            lock (_gate) _starts++;
            _last = null; pending = false; motionFromQ = 0; lastHitQ = 0;
            SetMode("frames", null);
          }
          // the native layer just started (or its row moved) on a still row: hand it the row read last (the
          // staging texture still holds it), or it stays hidden until something changes under the bar
          if (_last != null && UnderPaint.NeedsRow) {
            string nerr = ReadRow(n);
            if (nerr != null) { Drop(); SetMode("poll", nerr); nextTry = unchecked(Environment.TickCount + RetryMs); continue; }
            UnderPaint.Row(_fresh, Q());
          }
          // wait for the next frame, or (a push waiting) until it may go
          long nowQ = Q();
          int wait = WaitMs;
          if (pending) {
            int gapMs = GapMs(nowQ, motionFromQ, minMs, busyMs, sustainMs);
            int left = gapMs - (int)Ms(nowQ - lastPushQ);
            wait = Math.Max(0, Math.Min(WaitMs, left));
          }
          FRAME_INFO fi; IntPtr res;
          long cy0 = Cyc();
          int hr = _acq(_dup, (uint)wait, out fi, out res);
          long cy1 = Cyc();
          nowQ = Q();
          if (hr == WAIT_TIMEOUT) {
            if (pending && Ms(nowQ - lastPushQ) >= GapMs(nowQ, motionFromQ, minMs, busyMs, sustainMs)) {
              Push(n, pendingQ, nowQ); lastPushQ = nowQ;   // a read back spaces the next one, pushed or not (a protected video: black every frame)
              pending = false;
            }
            if (lastHitQ != 0 && Ms(nowQ - lastHitQ) > 200) motionFromQ = 0;   // the row went still
            continue;
          }
          if (hr != S_OK) {
            Drop();
            SetMode("poll", "the frame watch stopped: " + Hr(hr));
            nextTry = unchecked(Environment.TickCount + (hr == ACCESS_LOST ? 50 : RetryMs));
            continue;
          }
          bool hit = false;
          string ferr = null;
          try {
            lock (_gate) { _frames++; if (fi.LastPresentTime == 0) _ptrOnly++; }
            if (fi.LastPresentTime != 0) {
              hit = _last == null || Crosses(fi, x - _dx, y - _dy, w);
              if (hit) {
                IntPtr tex = IntPtr.Zero;
                try {
                  int qh = Marshal.QueryInterface(res, ref IID_Tex2D, out tex);
                  if (qh != S_OK) ferr = "the desktop frame is not a texture (" + Hr(qh) + ")";
                  else { ferr = CopyRow(tex, x - _dx, y - _dy, w); _freshNow = false; }
                } finally { Rel(ref tex); }
              }
            }
          } finally {
            Rel(ref res);
            _rf(_dup);
          }
          if (ferr != null) { Drop(); SetMode("poll", ferr); nextTry = unchecked(Environment.TickCount + RetryMs); continue; }
          long cy2 = Cyc();
          lock (_gate) { _cyAcq += cy1 - cy0; _cyRest += cy2 - cy1; }
          if (!hit) continue;
          lock (_gate) { _hits++; _copies++; }
          // the change's own time: when DWM presented the frame (QPC)
          long presentQ = fi.LastPresentTime;
          // THE NATIVE LAYER (UnderPaint.cs, lane mantle-topbar-zero): while it runs, EVERY frame that crosses the
          // row is read back now and painted by the sidecar itself on this frame; only main's pushes are spaced.
          if (UnderPaint.Active) {
            string rerr = ReadRow(n);
            if (rerr != null) { Drop(); SetMode("poll", rerr); nextTry = unchecked(Environment.TickCount + RetryMs); continue; }
            UnderPaint.Row(_fresh, presentQ != 0 ? presentQ : nowQ);
          }
          if (motionFromQ == 0 || Ms(nowQ - lastHitQ) > 200) motionFromQ = nowQ;
          lastHitQ = nowQ;
          int gap = _last == null ? 0 : GapMs(nowQ, motionFromQ, minMs, busyMs, sustainMs);
          if (Ms(nowQ - lastPushQ) >= gap) {
            Push(n, presentQ, nowQ); lastPushQ = nowQ;
            pending = false;
          } else {
            pending = true;
            pendingQ = presentQ;
          }
        }
      } catch (Exception ex) {
        Drop(); FreeDevice();
        SetMode("poll", "the frame watch failed (" + ex.GetType().Name + ": " + ex.Message + ")");
        Program.EmitLog("warn", "underwatch: the thread stopped: " + ex);
        lock (_gate) { if (_thread == Thread.CurrentThread) _thread = null; }
      }
    }

    /// The push spacing: 0 for the first change after a still spell, minMs while it keeps changing, busyMs
    /// once it has kept changing for sustainMs.
    static int GapMs(long nowQ, long motionFromQ, int minMs, int busyMs, int sustainMs) {
      if (motionFromQ == 0) return 0;
      return Ms(nowQ - motionFromQ) >= sustainMs ? busyMs : minMs;
    }
    static long Q() { long v; QueryPerformanceCounter(out v); return v; }
    static double Ms(long dq) { return dq * 1000.0 / _qpf; }
    static double WallMs() { long ft; GetSystemTimePreciseAsFileTime(out ft); return (ft - 116444736000000000L) / 10000.0; }

    /// Map the staging row, average it, push it when it differs from the last push. -> pushed
    /// The staging row, mapped and averaged into _fresh. -> null | why it could not be read
    static byte[] _fresh;
    static bool _freshNow;   // _fresh is the staging row as last copied (false from each copy until it is read)
    static string ReadRow(int n) {
      MAPPED m;
      int hr = _mapD(_ctx, _stage, 0, 1 /* READ */, 0, out m);
      if (hr != S_OK) return "the row could not be read back (" + Hr(hr) + ")";
      try { Marshal.Copy(m.Data, _row, 0, _sw * 4); } finally { _unmapD(_ctx, _stage, 0); }
      _fresh = Average(_row, _sw, n);
      _freshNow = true;
      return null;
    }

    static bool Push(int n, long presentQ, long nowQ) {
      var sw = Stopwatch.StartNew();
      byte[] outb;
      // read since the last copy already (the native layer reads every crossing frame). Was "UnderPaint.Active":
      // a push still pending from a frame copied BEFORE the layer started sent the older row read before it.
      if (_freshNow && _fresh != null && _fresh.Length == n * 3) outb = _fresh;
      else {
        string rerr = ReadRow(n);
        if (rerr != null) { SetMode("poll", rerr); Drop(); return false; }
        outb = _fresh;
      }
      if (_last != null && Same(_last, outb)) return false;
      _last = outb;
      long q = Q();
      double wall = WallMs();
      double lag = presentQ != 0 ? Ms(q - presentQ) : 0;
      lock (_gate) { _pushes++; _lastLagMs = lag; _lastWorkMs = sw.Elapsed.TotalMilliseconds; }
      Features.Event("underrow", Json.Obj("kind", "cols", "cols", Convert.ToBase64String(outb), "n", n,
        "at", Math.Round(wall, 2), "presentAt", Math.Round(wall - lag, 2), "lagMs", Math.Round(lag, 2),
        "workMs", Math.Round(sw.Elapsed.TotalMilliseconds, 3)));
      return true;
    }

    /// Exactly UnderRow.Read's buckets (and lib/topbar-under.js columnsOf).
    public static byte[] Average(byte[] row, int w, int n) {
      var outb = new byte[n * 3];
      for (int c = 0; c < n; c++) {
        int x0 = (int)((long)c * w / n);
        int x1 = Math.Max(x0 + 1, (int)((long)(c + 1) * w / n));
        if (x1 > w) x1 = w;
        int r = 0, g = 0, b = 0, k = 0;
        for (int px = x0; px < x1; px++) { int i = px * 4; b += row[i]; g += row[i + 1]; r += row[i + 2]; k++; }
        if (k > 0) {
          outb[c * 3] = (byte)Math.Round((double)r / k, MidpointRounding.AwayFromZero);
          outb[c * 3 + 1] = (byte)Math.Round((double)g / k, MidpointRounding.AwayFromZero);
          outb[c * 3 + 2] = (byte)Math.Round((double)b / k, MidpointRounding.AwayFromZero);
        }
      }
      return outb;
    }
    static bool Same(byte[] a, byte[] b) {
      if (a.Length != b.Length) return false;
      for (int i = 0; i < a.Length; i++) if (a[i] != b[i]) return false;
      return true;
    }

    static IntPtr _meta = IntPtr.Zero;
    static int _metaSize;
    /// Does any moved or dirty rect of this frame cross the row (output-local coords)?
    static bool Crosses(FRAME_INFO fi, int rx, int ry, int rw) {
      if (fi.TotalMetadataBufferSize == 0) return true;   // an image with no rects: assume it does
      int need = (int)fi.TotalMetadataBufferSize;
      if (_metaSize < need) {
        if (_meta != IntPtr.Zero) Marshal.FreeHGlobal(_meta);
        _metaSize = Math.Max(need, 4096);
        _meta = Marshal.AllocHGlobal(_metaSize);
      }
      uint got;
      int hr = _moveR(_dup, (uint)_metaSize, _meta, out got);   // move rects
      if (hr != S_OK) return true;
      for (int i = 0; i + 24 <= (int)got; i += 24) {
        // DXGI_OUTDUPL_MOVE_RECT: POINT source, RECT destination; the source row moving counts too
        int sx = Marshal.ReadInt32(_meta, i), sy = Marshal.ReadInt32(_meta, i + 4);
        int l = Marshal.ReadInt32(_meta, i + 8), t = Marshal.ReadInt32(_meta, i + 12);
        int r = Marshal.ReadInt32(_meta, i + 16), b = Marshal.ReadInt32(_meta, i + 20);
        if (Hit(l, t, r, b, rx, ry, rw)) return true;
        if (Hit(sx, sy, sx + (r - l), sy + (b - t), rx, ry, rw)) return true;
      }
      hr = _dirtyR(_dup, (uint)_metaSize, _meta, out got);   // dirty rects
      if (hr != S_OK) return true;
      for (int i = 0; i + 16 <= (int)got; i += 16) {
        if (Hit(Marshal.ReadInt32(_meta, i), Marshal.ReadInt32(_meta, i + 4), Marshal.ReadInt32(_meta, i + 8),
                Marshal.ReadInt32(_meta, i + 12), rx, ry, rw)) return true;
      }
      return false;
    }
    static bool Hit(int l, int t, int r, int b, int rx, int ry, int rw) {
      return t <= ry && b > ry && l < rx + rw && r > rx;
    }

    /// One row of the frame into the staging texture (a GPU copy; read back later by Push).
    static string CopyRow(IntPtr tex, int rx, int ry, int rw) {
      if (_stage == IntPtr.Zero) {
        TEX2D_DESC d;
        Fn<TexDesc_>(tex, 10)(tex, out d);
        if (d.Format != FMT_BGRA && d.Format != FMT_BGRA_SRGB) return "the desktop frame is in a format this does not read (DXGI format " + d.Format + ")";
        var s = new TEX2D_DESC();
        s.Width = (uint)rw; s.Height = 1; s.MipLevels = 1; s.ArraySize = 1; s.Format = d.Format; s.SampleCount = 1;
        s.Usage = 3 /* STAGING */; s.CpuAccess = 0x20000 /* READ */;
        int hr = Fn<CreateTex_>(_dev, 5)(_dev, ref s, IntPtr.Zero, out _stage);
        if (hr != S_OK) { _stage = IntPtr.Zero; return "the row texture could not be made (" + Hr(hr) + ")"; }
        _sw = rw; _fmt = d.Format;
        _row = new byte[rw * 4];
      }
      var box = new BOX();
      box.Left = (uint)rx; box.Top = (uint)ry; box.Front = 0; box.Right = (uint)(rx + rw); box.Bottom = (uint)(ry + 1); box.Back = 1;
      _copyD(_ctx, _stage, 0, 0, 0, 0, tex, 0, ref box);
      _fresh = null;
      return null;
    }

    /// The device on the adapter that drives the output holding the row, and its duplication. -> null | why
    static string Start(int x, int y, int w) {
      IntPtr factory = IntPtr.Zero, adapter = IntPtr.Zero, output = IntPtr.Zero;
      Drop(); FreeDevice();
      try {
        int hr = CreateDXGIFactory1(ref IID_Factory1, out factory);
        if (hr != S_OK) return "DXGI could not start (" + Hr(hr) + ")";
        OUTPUT_DESC od = new OUTPUT_DESC();
        bool found = false;
        for (uint a = 0; !found; a++) {
          Rel(ref adapter);
          hr = Fn<EnumAt_>(factory, 7)(factory, a, out adapter);
          if (hr != S_OK) { adapter = IntPtr.Zero; break; }
          for (uint o = 0; ; o++) {
            Rel(ref output);
            hr = Fn<EnumAt_>(adapter, 7)(adapter, o, out output);
            if (hr != S_OK) { output = IntPtr.Zero; break; }
            Fn<OutDesc_>(output, 7)(output, out od);
            if (x >= od.Desk.left && x < od.Desk.right && y >= od.Desk.top && y < od.Desk.bottom) { found = true; break; }
          }
        }
        if (!found) return "no display output holds the row " + x + "," + y + " (a display on another graphics adapter?)";
        if (od.Rotation != 0 && od.Rotation != 1) return "the display is rotated (rotation " + od.Rotation + "), which the frame watch does not read";
        if (x + w > od.Desk.right) return "the row runs past its display's right edge";
        hr = D3D11CreateDevice(adapter, 0 /* UNKNOWN: the adapter given */, IntPtr.Zero, DevFlags, IntPtr.Zero, 0, 7, out _dev, out _lvl, out _ctx);
        if (hr != S_OK) { _dev = _ctx = IntPtr.Zero; return "Direct3D 11 could not start on the display's adapter (" + Hr(hr) + ")"; }
        hr = Fn<QI_>(output, 0)(output, ref IID_Output1, out _out1);
        if (hr != S_OK) { _out1 = IntPtr.Zero; return "this Windows has no desktop duplication (" + Hr(hr) + ")"; }
        hr = Fn<Duplicate_>(_out1, 22)(_out1, _dev, out _dup);
        if (hr != S_OK) { _dup = IntPtr.Zero; return "the display could not be duplicated: " + Hr(hr); }
        OUTDUPL_DESC dd;
        Fn<DupDesc_>(_dup, 7)(_dup, out dd);
        _acq = Fn<Acquire_>(_dup, 8); _dirtyR = Fn<Rects_>(_dup, 9); _moveR = Fn<Rects_>(_dup, 10); _rf = Fn<ReleaseFrame_>(_dup, 14);
        _mapD = Fn<Map_>(_ctx, 14); _unmapD = Fn<Unmap_>(_ctx, 15); _copyD = Fn<CopyRegion_>(_ctx, 46);
        if (dd.Rotation != 0 && dd.Rotation != 1) return "the display is rotated (rotation " + dd.Rotation + "), which the frame watch does not read";
        _dx = od.Desk.left; _dy = od.Desk.top; _dw = od.Desk.right - od.Desk.left; _dh = od.Desk.bottom - od.Desk.top;
        return null;
      } catch (Exception ex) {
        return "the frame watch could not start (" + ex.GetType().Name + ": " + ex.Message + ")";
      } finally {
        Rel(ref output); Rel(ref adapter); Rel(ref factory);
      }
    }
    static int _lvl;
    // SINGLETHREADED (one thread uses it) + PREVENT_INTERNAL_THREADING_OPTIMIZATIONS (no driver worker thread)
    static uint DevFlags = 0x1 | 0x8;

    /// The duplication and the row texture (kept: the device, for a quick restart).
    static void Drop() {
      Rel(ref _stage); _sw = 0;
      Rel(ref _dup);
      Rel(ref _out1);
      _last = null; _freshNow = false;
    }
    static void FreeDevice() {
      if (_ctx != IntPtr.Zero) Rel(ref _ctx);
      Rel(ref _dev);
    }
  }
}

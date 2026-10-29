// NetTrace.cs - per-process network bytes for the elevated Task Manager helper (lane tm-elevate, 2026-10-28).
//
// WHAT: one ETW real-time session ("Mantle.TaskMgr.NetTrace") with the manifest provider
// Microsoft-Windows-Kernel-Network {7DD42A49-5329-4832-8DFD-43D979153A88} enabled on it. Every
// TCP/UDP send/receive event carries the owning PID and the byte count as its first two payload
// fields (UInt32 PID, UInt32 size), so a callback totals bytes per PID and 'read' turns the delta
// between two reads into bytes per second. Event ids, from the provider's own manifest
// (wevtutil gp Microsoft-Windows-Kernel-Network /ge /gm):
//   send: 10 TCPv4, 26 TCPv6, 42 UDPv4, 58 UDPv6    recv: 11 TCPv4, 27 TCPv6, 43 UDPv4, 59 UDPv6
//   keywords: KERNEL_NETWORK_KEYWORD_IPV4 0x10, KERNEL_NETWORK_KEYWORD_IPV6 0x20; level 4.
// The header's ProcessId is NOT used: network events are often logged in another process's
// context (System, a DPC), so the payload PID is the only right one.
//
// WHY RAW P/INVOKE: no NuGet here (csc.exe only), so no TraceEvent. The structs below are laid out
// to match evntrace.h / evntcons.h; Start() refuses to run if the 64-bit sizes do not match the
// known native sizes (EVENT_TRACE_PROPERTIES 120, EVENT_TRACE_LOGFILEW 448) rather than hand
// Windows a wrong-sized buffer.
//
// SESSION SYSTEM LOGGER MODE: not used. Kernel-Network is a manifest provider enabled with
// EnableTraceEx2 on an ordinary real-time session; EVENT_TRACE_SYSTEM_LOGGER_MODE is only for the
// classic SystemTraceProvider kernel flags, which this file does not use.
//
// LIFETIME (never an orphaned session): an ETW session outlives the process that started it, so
//   - 'start' first stops any stale session of the same name (a crashed earlier helper's),
//   - 'stop', Shutdown() (Program.cs: client disconnect / idle / exit), AppDomain.ProcessExit and
//     an idle watchdog (no 'read' for 60 s) all stop the session itself FIRST, then close the
//     consumer and join the ProcessTrace thread,
//   - an unhandled exception stops the session by name (no lock, no join) before the process dies.
//
// NOT ELEVATED: StartTraceW answers ERROR_ACCESS_DENIED (5); the reply is the clean
// {ok:false, needsAdmin:true, reason} and nothing is left running.
//
// C# 5 only (build.ps1): no string interpolation, no nameof, no out var, no ?. operator.
using System;
using System.Collections;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;

namespace Mantle {
  [MantleFeature]
  static class NetTrace {
    public const string SessionName = "Mantle.TaskMgr.NetTrace";
    static readonly Guid KernelNetwork = new Guid("7DD42A49-5329-4832-8DFD-43D979153A88");
    static readonly long ProvLo, ProvHi;   // the provider GUID as two raw 8-byte halves, for the callback

    const uint ERROR_SUCCESS = 0, ERROR_ACCESS_DENIED = 5, ERROR_ALREADY_EXISTS = 183,
               ERROR_PRIVILEGE_NOT_HELD = 1314, ERROR_WMI_INSTANCE_NOT_FOUND = 4201;
    const int NameRoomChars = 1024;           // room ETW may write each of logger name / log file name into
    const int IdleStopMs = 60000;             // no 'read' for this long = the Network view is gone
    const int JoinMs = 3000;                  // how long a stop waits for ProcessTrace to return

    static readonly object _ctl = new object();   // guards _s, _idle, _lastStopReason, _zombies
    static Session _s;                            // the one live session, or null
    static Timer _idle;
    static string _lastStopReason;
    static readonly List<Session> _zombies = new List<Session>();   // threads that outlived JoinMs: keep their callback alive
    static volatile bool _sessionMayExist;        // read lock-free by the unhandled-exception hook
    static bool _hooked;

    static NetTrace() {
      byte[] g = KernelNetwork.ToByteArray();   // in-memory GUID layout, same as the native GUID
      ProvLo = BitConverter.ToInt64(g, 0);
      ProvHi = BitConverter.ToInt64(g, 8);
    }

    public static void Register(FeatureTable t) {
      t.Add("taskmgr.netsample", Lanes.Slow, Cmd);
      lock (_ctl) {
        if (_hooked) return;
        _hooked = true;
      }
      AppDomain.CurrentDomain.ProcessExit += delegate(object sender, EventArgs e) { Shutdown(); };
      AppDomain.CurrentDomain.UnhandledException += delegate(object sender, UnhandledExceptionEventArgs e) {
        // The process is going down: stop the kernel session by name, no lock (the crash may hold it), no join.
        if (_sessionMayExist) { try { StopByName(); } catch { } }
      };
    }

    // Program.cs calls this on client disconnect, idle and exit. Safe when never started.
    public static void Shutdown() {
      lock (_ctl) { StopLocked("the elevated helper shut the network session down"); }
    }

    static string Cmd(Dictionary<string, object> req, ref object result) {
      string action = Json.GetString(req, "action");
      action = action == null ? "" : action.Trim().ToLowerInvariant();
      if (action == "start") { result = Start(); return null; }
      if (action == "read") { result = Read(); return null; }
      if (action == "stop") {
        lock (_ctl) {
          bool was = _s != null;
          StopLocked("stopped: the Network view asked to stop");
          result = NotRunning(was ? _lastStopReason : "not running: nothing to stop");
        }
        return null;
      }
      return "taskmgr.netsample needs action 'start', 'read' or 'stop' (got '" + action + "')";
    }

    // ---- start -------------------------------------------------------------------------------

    static IDictionary Start() {
      lock (_ctl) {
        if (_s != null) {
          if (!_s.PumpDone) {   // already running: idempotent
            _s.LastTouchTs = Stopwatch.GetTimestamp();
            return Json.Obj("ok", true, "running", true, "rows", new List<object>(), "since", 0L);
          }
          StopLocked("restarting: the previous network session had ended (ProcessTrace returned " + _s.PumpResult + ")");
        }

        if (IntPtr.Size == 8 &&
            (Marshal.SizeOf(typeof(N.EVENT_TRACE_PROPERTIES)) != 120 || Marshal.SizeOf(typeof(N.EVENT_TRACE_LOGFILEW)) != 448))
          return Json.Obj("ok", false, "running", false, "error", "layout",
            "reason", "per-process network is unavailable: this build's ETW struct layout does not match Windows' (" +
                      Marshal.SizeOf(typeof(N.EVENT_TRACE_PROPERTIES)) + "/" + Marshal.SizeOf(typeof(N.EVENT_TRACE_LOGFILEW)) + " bytes, expected 120/448)");

        // 1. A stale session of our name (an earlier helper crashed with one running) is stopped first.
        //    Not found (4201) is the normal answer; any other answer is left for StartTraceW to explain.
        StopByName();

        Session s = new Session();
        // 2. The controller: a real-time session.
        uint rc = StartSession(s);
        if (rc == ERROR_ALREADY_EXISTS) {   // lost a race with something re-creating it: stop it once more, retry once
          StopByName();
          rc = StartSession(s);
        }
        if (rc != ERROR_SUCCESS) return Fail(rc, "StartTraceW");
        s.Started = true;
        _sessionMayExist = true;
        _s = s;   // from here on every failure path goes through StopLocked, which stops the session

        // 3. The provider.
        Guid prov = KernelNetwork;
        rc = N.EnableTraceEx2(s.Ctl, ref prov, N.EVENT_CONTROL_CODE_ENABLE_PROVIDER, N.TRACE_LEVEL_VERBOSE,
                              N.KEYWORD_IPV4 | N.KEYWORD_IPV6, 0, 0, IntPtr.Zero);
        if (rc != ERROR_SUCCESS) { StopLocked("EnableTraceEx2 failed (" + rc + ")"); return Fail(rc, "EnableTraceEx2"); }

        // 4. The consumer.
        s.NameW = Marshal.StringToHGlobalUni(SessionName);
        s.Callback = new N.EventRecordCallback(s.OnEvent);
        N.EVENT_TRACE_LOGFILEW lf = new N.EVENT_TRACE_LOGFILEW();
        lf.LoggerName = s.NameW;
        lf.ProcessTraceMode = N.PROCESS_TRACE_MODE_REAL_TIME | N.PROCESS_TRACE_MODE_EVENT_RECORD;
        lf.EventRecordCallback = Marshal.GetFunctionPointerForDelegate(s.Callback);
        int lfSize = Marshal.SizeOf(typeof(N.EVENT_TRACE_LOGFILEW));
        s.LogFile = Marshal.AllocHGlobal(lfSize);
        Zero(s.LogFile, lfSize);
        Marshal.StructureToPtr(lf, s.LogFile, false);
        ulong h = N.OpenTraceW(s.LogFile);
        if (IsInvalidProcessTraceHandle(h)) {
          uint err = (uint)Marshal.GetLastWin32Error();
          StopLocked("OpenTraceW failed (" + err + ")");
          return Fail(err, "OpenTraceW");
        }
        s.Consumer = h;
        s.HasConsumer = true;

        // 5. The pump: ProcessTrace blocks until the session stops or the consumer is closed.
        long now = Stopwatch.GetTimestamp();
        s.LastReadTs = now;
        s.LastTouchTs = now;
        s.Pump = new Thread(s.Run);
        s.Pump.IsBackground = true;
        s.Pump.Name = "mantle-netsample-etw";
        s.Pump.Start();
        if (s.Pump.Join(150)) {   // ProcessTrace returned at once: it refused, so say why
          uint prc = s.PumpResult;
          StopLocked("ProcessTrace returned at once (" + prc + ")");
          return Fail(prc == ERROR_SUCCESS ? 0xFFFFFFFFu : prc, "ProcessTrace");
        }

        _lastStopReason = null;
        if (_idle == null) _idle = new Timer(IdleTick, null, 10000, 10000);
        return Json.Obj("ok", true, "running", true, "rows", new List<object>(), "since", 0L);
      }
    }

    static uint StartSession(Session s) {
      int total;
      IntPtr p = NewProps(false, out total);
      try {
        ulong h;
        uint rc = N.StartTraceW(out h, SessionName, p);
        if (rc == ERROR_SUCCESS) s.Ctl = h;
        return rc;
      } finally { Marshal.FreeHGlobal(p); }
    }

    // ---- read --------------------------------------------------------------------------------

    static IDictionary Read() {
      lock (_ctl) {
        Session s = _s;
        if (s == null)
          return NotRunning(_lastStopReason != null ? _lastStopReason : "not started: send action 'start' first");
        if (s.PumpDone) {
          StopLocked("the network session ended on its own (ProcessTrace returned " + s.PumpResult + " " + Text(s.PumpResult) + ")");
          return NotRunning(_lastStopReason);
        }

        long now = Stopwatch.GetTimestamp();
        double elapsedMs = (now - s.LastReadTs) * 1000.0 / Stopwatch.Frequency;
        s.LastReadTs = now;
        s.LastTouchTs = now;

        List<KeyValuePair<uint, long[]>> snap = new List<KeyValuePair<uint, long[]>>();
        lock (s.Gate) {
          foreach (KeyValuePair<uint, long[]> kv in s.Totals)
            snap.Add(new KeyValuePair<uint, long[]>(kv.Key, new long[] { kv.Value[0], kv.Value[1] }));
        }

        List<object> rows = new List<object>(snap.Count);
        foreach (KeyValuePair<uint, long[]> kv in snap) {
          long[] prev;
          if (!s.Prev.TryGetValue(kv.Key, out prev)) { prev = new long[2]; s.Prev[kv.Key] = prev; }
          long dSend = kv.Value[0] - prev[0], dRecv = kv.Value[1] - prev[1];
          prev[0] = kv.Value[0];
          prev[1] = kv.Value[1];
          double sendBps = elapsedMs > 0 ? Math.Round(dSend * 1000.0 / elapsedMs, 1) : 0.0;
          double recvBps = elapsedMs > 0 ? Math.Round(dRecv * 1000.0 / elapsedMs, 1) : 0.0;
          rows.Add(Json.Obj("pid", (long)kv.Key, "sendBps", sendBps, "recvBps", recvBps,
                            "send", kv.Value[0], "recv", kv.Value[1]));
        }
        return Json.Obj("ok", true, "running", true, "rows", rows, "since", (long)Math.Round(elapsedMs));
      }
    }

    // ---- stop --------------------------------------------------------------------------------

    // Caller holds _ctl. Order matters: the SESSION is stopped first (that is what must never be
    // left behind), then the consumer is closed, then the pump thread is joined.
    static void StopLocked(string reason) {
      if (_idle != null) { try { _idle.Dispose(); } catch { } _idle = null; }
      Session s = _s;
      if (s == null) return;
      _s = null;
      _lastStopReason = reason;

      if (s.Started) { try { StopByName(); } catch { } }
      _sessionMayExist = false;
      if (s.HasConsumer) { try { N.CloseTrace(s.Consumer); } catch { } s.HasConsumer = false; }

      bool exited = s.Pump == null || s.Pump.Join(JoinMs);
      if (exited) {
        if (s.LogFile != IntPtr.Zero) { Marshal.FreeHGlobal(s.LogFile); s.LogFile = IntPtr.Zero; }
        if (s.NameW != IntPtr.Zero) { Marshal.FreeHGlobal(s.NameW); s.NameW = IntPtr.Zero; }
      } else {
        // ProcessTrace has not returned yet: its memory and callback must stay alive (a small leak, never a crash).
        _zombies.Add(s);
      }
    }

    static uint StopByName() {
      int total;
      IntPtr p = NewProps(true, out total);
      try { return N.ControlTraceW(0, SessionName, p, N.EVENT_TRACE_CONTROL_STOP); }
      finally { Marshal.FreeHGlobal(p); }
    }

    static void IdleTick(object state) {
      try {
        lock (_ctl) {
          Session s = _s;
          if (s == null) return;
          double idleMs = (Stopwatch.GetTimestamp() - s.LastTouchTs) * 1000.0 / Stopwatch.Frequency;
          if (idleMs > IdleStopMs)
            StopLocked("stopped: no read for " + (IdleStopMs / 1000) + " s, so the Network view is closed or its poller is gone");
        }
      } catch { }
    }

    // ---- replies -----------------------------------------------------------------------------

    static IDictionary NotRunning(string reason) {
      return Json.Obj("ok", true, "running", false, "rows", new List<object>(), "since", 0L, "reason", reason);
    }

    static IDictionary Fail(uint rc, string api) {
      if (rc == ERROR_ACCESS_DENIED)
        return Json.Obj("ok", false, "needsAdmin", true,
          "reason", "per-process network needs administrator (ETW NT Kernel session); Windows said access denied");
      if (rc == ERROR_PRIVILEGE_NOT_HELD)
        return Json.Obj("ok", false, "needsAdmin", true,
          "reason", "per-process network needs administrator (ETW NT Kernel session); Windows said a required privilege is not held (" + api + " 1314)");
      return Json.Obj("ok", false, "running", false, "error", api + " " + rc,
        "reason", "per-process network could not start: " + api + " failed with Windows error " + rc + " (" + Text(rc) + ")");
    }

    static string Text(uint rc) {
      try { return new Win32Exception(unchecked((int)rc)).Message; } catch { return "unknown error"; }
    }

    // ---- helpers -----------------------------------------------------------------------------

    // EVENT_TRACE_PROPERTIES + room for the two names ETW reads/writes after it. forControl: a
    // ControlTraceW buffer (both name offsets set); else a StartTraceW buffer (real-time, no file).
    static IntPtr NewProps(bool forControl, out int total) {
      int baseSize = Marshal.SizeOf(typeof(N.EVENT_TRACE_PROPERTIES));
      total = baseSize + 2 * NameRoomChars * 2;
      IntPtr p = Marshal.AllocHGlobal(total);
      Zero(p, total);
      N.EVENT_TRACE_PROPERTIES props = new N.EVENT_TRACE_PROPERTIES();
      props.Wnode.BufferSize = (uint)total;
      props.Wnode.Flags = N.WNODE_FLAG_TRACED_GUID;
      props.Wnode.ClientContext = 1;   // QPC timestamps
      props.LoggerNameOffset = (uint)baseSize;
      if (forControl) {
        props.LogFileNameOffset = (uint)(baseSize + NameRoomChars * 2);
      } else {
        props.LogFileNameOffset = 0;   // real-time only, no .etl file
        props.LogFileMode = N.EVENT_TRACE_REAL_TIME_MODE;
        props.BufferSize = 64;         // KB per buffer
        props.FlushTimer = 1;          // deliver at least once a second, so a 1 s poll sees fresh bytes
      }
      Marshal.StructureToPtr(props, p, false);
      return p;
    }

    static void Zero(IntPtr p, int n) { Marshal.Copy(new byte[n], 0, p, n); }

    static bool IsInvalidProcessTraceHandle(ulong h) {
      if (h == 0xFFFFFFFFFFFFFFFFUL) return true;
      if (IntPtr.Size == 4 && h == 0x00000000FFFFFFFFUL) return true;
      return false;
    }

    // ---- one session -------------------------------------------------------------------------

    sealed class Session {
      public ulong Ctl;                       // StartTraceW's handle
      public bool Started;
      public ulong Consumer;                  // OpenTraceW's handle
      public bool HasConsumer;
      public IntPtr LogFile, NameW;           // native memory OpenTraceW/ProcessTrace point at
      public N.EventRecordCallback Callback;  // kept alive here for as long as ProcessTrace may call it
      public Thread Pump;
      public volatile bool PumpDone;
      public uint PumpResult;
      public long LastReadTs, LastTouchTs;    // Stopwatch ticks; touched only under _ctl

      public readonly object Gate = new object();
      public readonly Dictionary<uint, long[]> Totals = new Dictionary<uint, long[]>();  // pid -> {send, recv}; under Gate
      public readonly Dictionary<uint, long[]> Prev = new Dictionary<uint, long[]>();    // last read's totals; under _ctl

      public void Run() {
        uint rc;
        try { rc = N.ProcessTrace(new ulong[] { Consumer }, 1, IntPtr.Zero, IntPtr.Zero); }
        catch { rc = 0xFFFFFFFFu; }
        PumpResult = rc;
        PumpDone = true;
      }

      // Runs on the ProcessTrace thread for every event. Must never throw (a throw out of a native
      // callback kills the process) and must stay cheap.
      public void OnEvent(IntPtr rec) {
        try {
          if (rec == IntPtr.Zero) return;
          if (Marshal.ReadInt64(rec, N.REC_PROVIDER) != ProvLo || Marshal.ReadInt64(rec, N.REC_PROVIDER + 8) != ProvHi) return;
          int id = (ushort)Marshal.ReadInt16(rec, N.REC_EVENT_ID);
          int dir;
          switch (id) {
            case 10: case 26: case 42: case 58: dir = 0; break;   // sent
            case 11: case 27: case 43: case 59: dir = 1; break;   // received
            default: return;
          }
          int len = (ushort)Marshal.ReadInt16(rec, N.REC_USERDATA_LEN);
          if (len < 8) return;
          IntPtr data = Marshal.ReadIntPtr(rec, N.REC_USERDATA_PTR);
          if (data == IntPtr.Zero) return;
          uint pid = unchecked((uint)Marshal.ReadInt32(data, 0));
          uint size = unchecked((uint)Marshal.ReadInt32(data, 4));
          lock (Gate) {
            long[] t;
            if (!Totals.TryGetValue(pid, out t)) { t = new long[2]; Totals[pid] = t; }
            t[dir] += size;
          }
        } catch { }
      }
    }

    // ---- P/Invoke ----------------------------------------------------------------------------

    static class N {
      public const uint WNODE_FLAG_TRACED_GUID = 0x00020000;
      public const uint EVENT_TRACE_REAL_TIME_MODE = 0x00000100;
      public const uint EVENT_TRACE_CONTROL_STOP = 1;
      public const uint EVENT_CONTROL_CODE_ENABLE_PROVIDER = 1;
      public const byte TRACE_LEVEL_VERBOSE = 5;
      public const ulong KEYWORD_IPV4 = 0x10, KEYWORD_IPV6 = 0x20;
      public const uint PROCESS_TRACE_MODE_REAL_TIME = 0x00000100;
      public const uint PROCESS_TRACE_MODE_EVENT_RECORD = 0x10000000;

      // EVENT_RECORD offsets (evntcons.h): EVENT_HEADER is 80 bytes; ProviderId at 24,
      // EventDescriptor.Id at 40; then BufferContext(4) ExtendedDataCount(2) UserDataLength(2)
      // ExtendedData(ptr) UserData(ptr).
      public const int REC_PROVIDER = 24, REC_EVENT_ID = 40, REC_USERDATA_LEN = 86;
      public static readonly int REC_USERDATA_PTR = 88 + IntPtr.Size;

      [UnmanagedFunctionPointer(CallingConvention.StdCall)]
      public delegate void EventRecordCallback(IntPtr eventRecord);

      [StructLayout(LayoutKind.Sequential)]
      public struct WNODE_HEADER {
        public uint BufferSize;
        public uint ProviderId;
        public ulong HistoricalContext;
        public long TimeStamp;          // union CountLost / KernelHandle / TimeStamp
        public Guid Guid;
        public uint ClientContext;
        public uint Flags;
      }

      [StructLayout(LayoutKind.Sequential)]
      public struct EVENT_TRACE_PROPERTIES {
        public WNODE_HEADER Wnode;
        public uint BufferSize, MinimumBuffers, MaximumBuffers, MaximumFileSize, LogFileMode, FlushTimer, EnableFlags;
        public int AgeLimit;
        public uint NumberOfBuffers, FreeBuffers, EventsLost, BuffersWritten, LogBuffersLost, RealTimeBuffersLost;
        public IntPtr LoggerThreadId;
        public uint LogFileNameOffset, LoggerNameOffset;
      }

      [StructLayout(LayoutKind.Sequential)]
      public struct EVENT_TRACE_HEADER {
        public ushort Size;
        public ushort FieldTypeFlags;
        public uint Version;
        public uint ThreadId;
        public uint ProcessId;
        public long TimeStamp;
        public Guid Guid;
        public ulong ProcessorTime;
      }

      [StructLayout(LayoutKind.Sequential)]
      public struct EVENT_TRACE {
        public EVENT_TRACE_HEADER Header;
        public uint InstanceId;
        public uint ParentInstanceId;
        public Guid ParentGuid;
        public IntPtr MofData;
        public uint MofLength;
        public uint ClientContext;
      }

      [StructLayout(LayoutKind.Sequential, Size = 172)]
      public struct TIME_ZONE_INFORMATION { public int Bias; }

      [StructLayout(LayoutKind.Sequential)]
      public struct TRACE_LOGFILE_HEADER {
        public uint BufferSize;
        public uint Version;
        public uint ProviderVersion;
        public uint NumberOfProcessors;
        public long EndTime;
        public uint TimerResolution;
        public uint MaximumFileSize;
        public uint LogFileMode;
        public uint BuffersWritten;
        public Guid LogInstanceGuid;
        public IntPtr LoggerName;
        public IntPtr LogFileName;
        public TIME_ZONE_INFORMATION TimeZone;
        public long BootTime;
        public long PerfFreq;
        public long StartTime;
        public uint ReservedFlags;
        public uint BuffersLost;
      }

      [StructLayout(LayoutKind.Sequential)]
      public struct EVENT_TRACE_LOGFILEW {
        public IntPtr LogFileName;
        public IntPtr LoggerName;
        public long CurrentTime;
        public uint BuffersRead;
        public uint ProcessTraceMode;
        public EVENT_TRACE CurrentEvent;
        public TRACE_LOGFILE_HEADER LogfileHeader;
        public IntPtr BufferCallback;
        public uint BufferSize;
        public uint Filled;
        public uint EventsLost;
        public IntPtr EventRecordCallback;
        public uint IsKernelTrace;
        public IntPtr Context;
      }

      [DllImport("advapi32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
      public static extern uint StartTraceW(out ulong traceHandle, string instanceName, IntPtr properties);

      [DllImport("advapi32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
      public static extern uint ControlTraceW(ulong traceHandle, string instanceName, IntPtr properties, uint controlCode);

      [DllImport("advapi32.dll", ExactSpelling = true)]
      public static extern uint EnableTraceEx2(ulong traceHandle, ref Guid providerId, uint controlCode, byte level,
                                               ulong matchAnyKeyword, ulong matchAllKeyword, uint timeout, IntPtr enableParameters);

      [DllImport("advapi32.dll", ExactSpelling = true, SetLastError = true)]
      public static extern ulong OpenTraceW(IntPtr logfile);

      [DllImport("advapi32.dll", ExactSpelling = true)]
      public static extern uint ProcessTrace([In] ulong[] handleArray, uint handleCount, IntPtr startTime, IntPtr endTime);

      [DllImport("advapi32.dll", ExactSpelling = true)]
      public static extern uint CloseTrace(ulong traceHandle);
    }
  }
}

// Recorder.cs - Mantle's screen recorder: ONE recording per child process (lane mantle-screenrec, 2026-10-15).
//
// Owen asked for Win+Shift+S to RECORD a window or an area as well (his Northwind demo videos were recorded
// from a browser window with Game Bar, which can record one app window and never an area, the desktop or
// Explorer). Game Bar stays the recorder IN games: lib/features/screenrec.js refuses while a game is in
// front, and this process never opens, reads or injects into any other process. It only asks Windows
// for a picture of a window or a screen through Windows.Graphics.Capture, like the Snipping Tool does.
//
// THE ROUTE (all of it ships with Windows; nothing is installed):
//   Windows.Graphics.Capture   a GraphicsCaptureItem for the window (IGraphicsCaptureItemInterop.
//                              CreateForWindow) or for the monitor (CreateForMonitor), and a free-threaded
//                              Direct3D11CaptureFramePool polled once per output frame: the newest frame
//                              wins, older ones are dropped, so the capture never queues up behind.
//   Direct3D 11                the frame's own texture, cropped on the GPU (CopySubresourceRegion) into
//                              a small ring of output textures (no CPU copy of the picture at all).
//   Media Foundation           the Sink Writer with the DXGI device manager and hardware transforms on:
//                              the GPU's own H.264 encoder (Intel Quick Sync on Owen's i3-1215U), RGB32 in,
//                              converted on the GPU by the video processor the Sink Writer adds. If that
//                              cannot be built or refuses the first frame, the SOFTWARE route: the crop
//                              is read back through a staging texture into memory buffers for
//                              Microsoft's software H.264 encoder. MP4 out, AAC audio.
//   WASAPI                     system sound by loopback of the default output, and the default microphone
//                              if asked, both asked for as 48 kHz 16-bit stereo (AUTOCONVERTPCM), placed on
//                              ONE timeline by each packet's own QPC time and mixed. Loopback delivers no
//                              packets while nothing plays, so the timeline is silence there by itself.
//   Constant frame rate        30 or 60. A screen that does not change sends no new frames, so the last
//                              one is written again; frames the loop falls behind on are counted ("late").
//
// WHY A CHILD PROCESS (Owen's RAM rule: zero cost when not recording). Mantle's sidecar never loads any of
// this: Mantle starts `Mantle.Sidecar.exe --record` for ONE recording and it exits when the file is done,
// so the encoder, the D3D device and the audio clients live only while recording.
//
// PROTOCOL. stdin line 1 = the spec (JSON); later lines "stop". stdin closing (Mantle gone) = stop too, so a
// recording is always finished and playable. stdout = one JSON event per line:
//   {"ev":"ready", w, h, fps, encoder:{name,hardware}, border, borderWhy, audio:{system,mic}, ...}
//   {"ev":"started", ms}          the first frame is in; the clock starts here
//   {"ev":"tick", secs, frames, late, dup, bytes, freeMb}      once a second
//   {"ev":"done", path, secs, frames, late, bytes, why}        the file is finished and renamed into place
//   {"ev":"error", error}         plain words; nothing is left behind (the part file is deleted)
// The spec: {mode:"window"|"monitor", hwnd:"<decimal>", x, y (a point on the monitor, physical px),
//   crop:{x,y,w,h} (monitor: VIRTUAL-screen physical px; window: relative to the window's visible frame),
//   fps:30|60, audio:bool, mic:bool, cursor:bool (the mouse pointer in the picture; default true, never in a
//   test), out:"<final path>.mp4", maxSecs, minFreeMb, test:bool, allowPid:N, testSecs:N}
// The file is written as "<out>.part" and renamed only when finished, to <out> or "<name> (2).mp4" and so
// on: an existing file is NEVER overwritten, and a crash never leaves a broken file under the real name.
//
// TESTS (test:true): only mode "window", and only a window owned by allowPid (the test's own stand-in), so
// a test can never record Owen's screen or windows, nor his mouse pointer. `--rec-standin` is that stand-in: a borderless,
// never-activated window painting four coloured quadrants and a moving bar. `--rec-probe=<file>` reads an
// MP4 back through Media Foundation's Source Reader: its size, frame rate, frame count, duration, audio
// track, and the colours at given points of a middle frame (which proves the crop and the orientation).
//
// C# 5 ONLY (csc.exe from .NET Framework 4, see build.ps1). Needs MANTLE_WINMD (the split winmds); without
// it --record answers with an error event and exits.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
#if MANTLE_WINMD
using Windows.Graphics;
using Windows.Graphics.Capture;
using Windows.Graphics.DirectX;
using Windows.Graphics.DirectX.Direct3D11;
using Windows.Security.Authorization.AppCapabilityAccess;
#endif

namespace Mantle {
  static class Recorder {
    static readonly object _outGate = new object();
    static StreamWriter _out;

    public static void Emit(IDictionary o) {
      lock (_outGate) {
        try { _out.WriteLine(Json.Write(o)); _out.Flush(); } catch (Exception) { }
      }
    }

    public static string Arg(string[] args, string name) {
      foreach (string a in args) {
        if (a == name) return "";
        if (a.StartsWith(name + "=", StringComparison.Ordinal)) return a.Substring(name.Length + 1).Trim('"');
      }
      return null;
    }

    public static int Run(string[] args) {
      _out = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
      _out.AutoFlush = true;
      if (Arg(args, "--rec-standin") != null) return RecStandIn.Run(args);
#if MANTLE_WINMD
      if (Arg(args, "--rec-probe") != null) return RecProbe.Run(Arg(args, "--rec-probe"), args);
      var input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
      string first;
      try { first = input.ReadLine(); } catch (Exception ex) { first = null; Emit(Json.Obj("ev", "error", "error", "the recording's settings could not be read (" + ex.Message + ")")); return 2; }
      Dictionary<string, object> spec = null;
      try { spec = Json.Parse(first ?? "") as Dictionary<string, object>; } catch (Exception) { spec = null; }
      if (spec == null) { Emit(Json.Obj("ev", "error", "error", "the recording's settings were not a JSON object")); return 2; }
      var s = new RecSession(spec);
      var reader = new Thread(delegate () {
        try {
          string line;
          while ((line = input.ReadLine()) != null) {
            if (line.Trim() == "stop") { s.RequestStop("stop"); }
          }
        } catch (Exception) { }
        s.RequestStop("Mantle closed");
      });
      reader.IsBackground = true;
      reader.Start();
      int code = 0;
      var worker = new Thread(delegate () { code = s.RunAll(); });
      worker.SetApartmentState(ApartmentState.MTA);
      worker.Priority = ThreadPriority.AboveNormal;   // frame pacing: the capture loop wakes every 16-33 ms
      worker.Start();
      worker.Join();
      return code;
#else
      Emit(Json.Obj("ev", "error", "error", "this Mantle helper was built without Windows' capture types (the WinRT metadata in System32\\WinMetadata was missing at build time), so it cannot record"));
      return 2;
#endif
    }
  }

  sealed class RecError : Exception { public RecError(string m) : base(m) { } }

  /* ---- raw COM: vtable calls, so no interface has to be declared method by method ---------------- */
  static class V {
    public static T F<T>(IntPtr o, int slot) where T : class {
      IntPtr vt = Marshal.ReadIntPtr(o);
      return Marshal.GetDelegateForFunctionPointer(Marshal.ReadIntPtr(vt, slot * IntPtr.Size), typeof(T)) as T;
    }
    public static void Hr(int hr, string what) { if (hr < 0) throw new RecError(what + " (" + Code(hr) + ")"); }
    public static string Code(int hr) {
      uint u = unchecked((uint)hr);
      string x = "0x" + u.ToString("X8", CultureInfo.InvariantCulture);
      switch (u) {
        case 0x80070005: return "Windows refused access, " + x;
        case 0x887A0005: return "the graphics device was removed or reset, " + x;
        case 0x887A0006: return "the graphics device stopped responding, " + x;
        case 0x80070070: return "the disk is full, " + x;
        case 0xC00D36B4: return "the encoder did not accept that picture format, " + x;
        case 0xC00D5212: return "no encoder for that format, " + x;
        case 0x80004005: return "an unspecified failure, " + x;
        case 0x80070057: return "a wrong argument, " + x;
        case 0x80004002: return "that interface is not there, " + x;
        case 0x88890008: return "the audio device does not take that format, " + x;
        case 0x88890004: return "the audio device was removed, " + x;
        case 0x88890006: return "the audio device is in use by another app in exclusive mode, " + x;
        case 0x80070490: return "no such device, " + x;
      }
      return x;
    }
    public static void Rel(ref IntPtr p) { if (p != IntPtr.Zero) { try { Marshal.Release(p); } catch (Exception) { } p = IntPtr.Zero; } }
    public static long Now100() {
      long t = Stopwatch.GetTimestamp(), f = Stopwatch.Frequency;
      return (t / f) * 10000000L + (t % f) * 10000000L / f;
    }
    public static string Why(Exception ex) {
      if (ex is RecError) return ex.Message;
      var c = ex as COMException;
      if (c != null) return Code(c.ErrorCode);
      return ex.GetType().Name + ": " + ex.Message;
    }
  }

  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int FnV(IntPtr s);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate void FnVoid(IntPtr s);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int FnGU32(IntPtr s, ref Guid k, uint v);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int FnGU64(IntPtr s, ref Guid k, ulong v);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int FnGG(IntPtr s, ref Guid k, ref Guid v);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int FnGP(IntPtr s, ref Guid k, IntPtr v);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int FnGoU32(IntPtr s, ref Guid k, out uint v);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int FnGoU64(IntPtr s, ref Guid k, out ulong v);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int FnGoG(IntPtr s, ref Guid k, out Guid v);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int FnGoStr(IntPtr s, ref Guid k, out IntPtr str, out uint len);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int FnPoU(IntPtr s, IntPtr p, out uint v);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int FnUPP(IntPtr s, uint i, IntPtr a, IntPtr b);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int FnUP(IntPtr s, uint i, IntPtr p);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int FnL(IntPtr s, long v);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int FnoL(IntPtr s, out long v);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int FnP(IntPtr s, IntPtr p);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int FnU(IntPtr s, uint v);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int FnoU(IntPtr s, out uint v);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int FnoP(IntPtr s, out IntPtr p);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int FnUoP(IntPtr s, uint i, out IntPtr p);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int FnUUoP(IntPtr s, uint a, uint b, out IntPtr p);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int FnUB(IntPtr s, uint i, int b);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int FnLock(IntPtr s, out IntPtr p, out uint max, out uint cur);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int FnLock2D(IntPtr s, out IntPtr p, out int pitch);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int FnPU(IntPtr s, IntPtr p, uint v);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int FnCreateTex(IntPtr s, ref RecTexDesc d, IntPtr init, out IntPtr tex);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate void FnGetCtx(IntPtr s, out IntPtr ctx);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate void FnGetDesc(IntPtr s, out RecTexDesc d);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate void FnCopyRegion(IntPtr s, IntPtr dst, uint dsub, uint x, uint y, uint z, IntPtr src, uint ssub, ref RecBox box);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int FnMap(IntPtr s, IntPtr res, uint sub, int type, uint flags, out RecMapped m);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate void FnUnmap(IntPtr s, IntPtr res, uint sub);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int FnCreateRtv(IntPtr s, IntPtr res, IntPtr desc, out IntPtr rtv);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate void FnClearRtv(IntPtr s, IntPtr rtv, [MarshalAs(UnmanagedType.LPArray, SizeConst = 4)] float[] rgba);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int FnGetXform(IntPtr s, uint stream, uint idx, out Guid cat, out IntPtr xf);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int FnRead(IntPtr s, uint stream, uint flags, out uint actual, out uint sflags, out long ts, out IntPtr sample);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int FnPresAttr(IntPtr s, uint stream, ref Guid k, IntPtr pv);

  [StructLayout(LayoutKind.Sequential)]
  struct RecTexDesc {
    public uint Width, Height, MipLevels, ArraySize, Format, SampleCount, SampleQuality, Usage, BindFlags, CPUAccessFlags, MiscFlags;
  }
  [StructLayout(LayoutKind.Sequential)] struct RecBox { public uint Left, Top, Front, Right, Bottom, Back; }
  [StructLayout(LayoutKind.Sequential)] struct RecMapped { public IntPtr Data; public uint RowPitch, DepthPitch; }
  [StructLayout(LayoutKind.Sequential)] struct RecRect { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] struct RecPoint { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] struct RecMonInfo { public int Size; public RecRect Monitor, Work; public uint Flags; }

  static class RecNative {
    [DllImport("mfplat.dll")] public static extern int MFStartup(uint version, uint flags);
    [DllImport("mfplat.dll")] public static extern int MFShutdown();
    [DllImport("mfplat.dll")] public static extern int MFCreateAttributes(out IntPtr attrs, uint size);
    [DllImport("mfplat.dll")] public static extern int MFCreateMediaType(out IntPtr type);
    [DllImport("mfplat.dll")] public static extern int MFCreateSample(out IntPtr sample);
    [DllImport("mfplat.dll")] public static extern int MFCreateMemoryBuffer(uint len, out IntPtr buffer);
    [DllImport("mfplat.dll")] public static extern int MFCreateDXGISurfaceBuffer(ref Guid riid, IntPtr surface, uint sub, [MarshalAs(UnmanagedType.Bool)] bool bottomUp, out IntPtr buffer);
    [DllImport("mfplat.dll")] public static extern int MFCreateDXGIDeviceManager(out uint token, out IntPtr manager);
    [DllImport("mfplat.dll")] public static extern int MFCopyImage(IntPtr dst, int dstStride, IntPtr src, int srcStride, uint widthBytes, uint lines);
    [DllImport("mfreadwrite.dll")] public static extern int MFCreateSinkWriterFromURL([MarshalAs(UnmanagedType.LPWStr)] string url, IntPtr stream, IntPtr attrs, out IntPtr writer);
    [DllImport("mfreadwrite.dll")] public static extern int MFCreateSourceReaderFromURL([MarshalAs(UnmanagedType.LPWStr)] string url, IntPtr attrs, out IntPtr reader);
    [DllImport("d3d11.dll")] public static extern int D3D11CreateDevice(IntPtr adapter, int driverType, IntPtr software, uint flags, IntPtr levels, uint nLevels, uint sdk, out IntPtr device, out int level, out IntPtr context);
    [DllImport("d3d11.dll")] public static extern int CreateDirect3D11DeviceFromDXGIDevice(IntPtr dxgi, out IntPtr inspectable);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RecRect r);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern IntPtr MonitorFromPoint(RecPoint pt, uint flags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool GetMonitorInfoW(IntPtr mon, ref RecMonInfo info);
    [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RecRect r, int size);
    [DllImport("winmm.dll")] public static extern uint timeBeginPeriod(uint ms);
    [DllImport("winmm.dll")] public static extern uint timeEndPeriod(uint ms);
    [DllImport("ole32.dll")] public static extern void CoTaskMemFree(IntPtr p);
    [DllImport("ole32.dll")] public static extern int PropVariantClear(IntPtr pv);
  }

  static class MFG {
    public static Guid MajorType = new Guid("48eba18e-f8c9-4687-bf11-0a74c9f96a8f");
    public static Guid Subtype = new Guid("f7e34c9a-42e8-4714-b74b-cb29d72c35e5");
    public static Guid AvgBitrate = new Guid("20332624-fb0d-4d9e-bd0d-cbf6786c102e");
    public static Guid Interlace = new Guid("e2724bb8-e676-4806-b4b2-a8d6efb44ccd");
    public static Guid FrameSize = new Guid("1652c33d-d6b2-4012-b834-72030849a37d");
    public static Guid FrameRate = new Guid("c459a2e8-3d2c-4e44-b132-fee5156c7bb0");
    public static Guid Par = new Guid("c6376a1e-8d0a-4027-be45-6d9a0ad39bb6");
    public static Guid DefaultStride = new Guid("644b4e48-1e02-4516-b0eb-c01ca9d49ac6");
    public static Guid Mpeg2Profile = new Guid("ad76a80b-2d5c-4e0b-b375-64e520137036");
    public static Guid AllIndependent = new Guid("c9173739-5e56-461c-b713-46fb995cb95f");
    public static Guid AudioChannels = new Guid("37e48bf5-645e-4c5b-89de-ada9e29b696a");
    public static Guid AudioRate = new Guid("5faeeae7-0290-4c31-9e8a-c534f68d9dba");
    public static Guid AudioBlock = new Guid("322de230-9eeb-43bd-ab7a-ff412251541d");
    public static Guid AudioAvgBytes = new Guid("1aab75c8-cfef-451c-ab95-ac034b8e1731");
    public static Guid AudioBits = new Guid("f2deb57f-40fa-4764-aa33-ed4f2d1ff669");
    public static Guid AacPayload = new Guid("bfbabe79-7434-4d1c-94f0-72a3b9e17188");
    public static Guid Video = new Guid("73646976-0000-0010-8000-00AA00389B71");
    public static Guid Audio = new Guid("73647561-0000-0010-8000-00AA00389B71");
    public static Guid H264 = new Guid("34363248-0000-0010-8000-00AA00389B71");
    public static Guid RGB32 = new Guid("00000016-0000-0010-8000-00AA00389B71");
    public static Guid AAC = new Guid("00001610-0000-0010-8000-00AA00389B71");
    public static Guid PCM = new Guid("00000001-0000-0010-8000-00AA00389B71");
    public static Guid Float = new Guid("00000003-0000-0010-8000-00AA00389B71");
    public static Guid HwTransforms = new Guid("a634a91c-822b-41b9-a494-4de4643612b0");
    public static Guid D3DManager = new Guid("ec822da2-e1e9-4b29-a0d8-563c719f5269");
    public static Guid ContainerType = new Guid("150ff23f-4abc-478b-ac4f-e1916fba1cca");
    public static Guid Mpeg4 = new Guid("dc6cd05d-b9d0-40ef-bd35-fa622c1ab28a");
    public static Guid VideoProcessing = new Guid("fb394f3d-ccf1-42ee-bbb3-f9b845d5681d");
    public static Guid PdDuration = new Guid("6c990d33-bb8e-477a-8598-0d5d96fcd88a");
    public static Guid FriendlyName = new Guid("314ffbae-5b41-4c95-9c19-4e7d586face3");
    public static Guid HardwareUrl = new Guid("2fb866ac-b078-4942-ab6c-003d05cda674");
    public static Guid CatVideoEncoder = new Guid("f79eac7d-e545-4387-bdee-d647d7bde42a");
    public static Guid RateControl = new Guid("1c0608e9-370c-4710-8a58-cb6181c42423");
    public static Guid MeanBitrate = new Guid("f7222374-2144-4815-b550-a37f8e12ee52");
    public static Guid GopSize = new Guid("95f31b26-95a4-41aa-9303-246a7fc6eef1");
    public static Guid IID_SinkWriterEx = new Guid("588d72ab-5bc1-496a-8714-b70617141b25");
    public static Guid IID_2DBuffer = new Guid("7DC9D5F9-9ED9-44ec-9BBF-0600BB589FBB");
    public static Guid IID_Tex2D = new Guid("6f15aaf2-d208-4e89-9ab4-489535d34f9c");
    public static Guid IID_DxgiDevice = new Guid("54ec77fa-1377-44e6-8c32-88fd5f44c84c");
    public static Guid IID_Multithread = new Guid("9B7E4E00-342C-4106-A19F-4F2704F689F0");

    // IMFAttributes slots (IMFMediaType and IMFSample start with the same table)
    public const int GetUINT32 = 7, GetUINT64 = 8, GetGUID = 10, GetAllocatedString = 13, SetUINT32 = 21, SetUINT64 = 22, SetGUID = 24, SetUnknown = 27;

    public static void U32(IntPtr a, Guid k, uint v, string what) { V.Hr(V.F<FnGU32>(a, SetUINT32)(a, ref k, v), what); }
    public static void U64(IntPtr a, Guid k, ulong v, string what) { V.Hr(V.F<FnGU64>(a, SetUINT64)(a, ref k, v), what); }
    public static void G(IntPtr a, Guid k, Guid v, string what) { V.Hr(V.F<FnGG>(a, SetGUID)(a, ref k, ref v), what); }
    public static void Unk(IntPtr a, Guid k, IntPtr v, string what) { V.Hr(V.F<FnGP>(a, SetUnknown)(a, ref k, v), what); }
    public static ulong Pack(uint hi, uint lo) { return ((ulong)hi << 32) | lo; }
    public static bool TryU32(IntPtr a, Guid k, out uint v) { return V.F<FnGoU32>(a, GetUINT32)(a, ref k, out v) >= 0; }
    public static bool TryU64(IntPtr a, Guid k, out ulong v) { return V.F<FnGoU64>(a, GetUINT64)(a, ref k, out v) >= 0; }
    public static bool TryGuid(IntPtr a, Guid k, out Guid v) { return V.F<FnGoG>(a, GetGUID)(a, ref k, out v) >= 0; }
    public static string Str(IntPtr a, Guid k) {
      IntPtr p; uint n;
      if (V.F<FnGoStr>(a, GetAllocatedString)(a, ref k, out p, out n) < 0 || p == IntPtr.Zero) return null;
      try { return Marshal.PtrToStringUni(p, (int)n); } finally { RecNative.CoTaskMemFree(p); }
    }
  }

  /* ---- the stand-in window the tests record (never Owen's) -------------------------------------- */
  sealed class RecStandInForm : System.Windows.Forms.Form {
    int _n;
    readonly bool _ghost;
    readonly System.Windows.Forms.Timer _t = new System.Windows.Forms.Timer();
    public RecStandInForm(int x, int y, int w, int h, bool ghost) {
      _ghost = ghost;
      if (ghost) Opacity = 1.0 / 255;
      FormBorderStyle = System.Windows.Forms.FormBorderStyle.None;
      StartPosition = System.Windows.Forms.FormStartPosition.Manual;
      ShowInTaskbar = false;
      DoubleBuffered = true;
      Text = "Mantle recorder stand-in";
      Bounds = new System.Drawing.Rectangle(x, y, w, h);
      _t.Interval = 15;
      _t.Tick += delegate (object s, EventArgs e) { _n++; Invalidate(); };
      _t.Start();
    }
    protected override bool ShowWithoutActivation { get { return true; } }
    protected override System.Windows.Forms.CreateParams CreateParams {
      get {
        var cp = base.CreateParams;
        cp.ExStyle |= 0x08000000 | 0x00000080;                    // NOACTIVATE | TOOLWINDOW
        if (_ghost) cp.ExStyle |= 0x00080000 | 0x00000020;        // LAYERED | TRANSPARENT (click-through)
        return cp;
      }
    }
    protected override void OnPaint(System.Windows.Forms.PaintEventArgs e) {
      var g = e.Graphics;
      int w = ClientSize.Width, h = ClientSize.Height;
      using (var r = new System.Drawing.SolidBrush(System.Drawing.Color.FromArgb(230, 40, 40)))
      using (var gr = new System.Drawing.SolidBrush(System.Drawing.Color.FromArgb(40, 200, 60)))
      using (var b = new System.Drawing.SolidBrush(System.Drawing.Color.FromArgb(40, 70, 230)))
      using (var wh = new System.Drawing.SolidBrush(System.Drawing.Color.FromArgb(245, 245, 245)))
      using (var bar = new System.Drawing.SolidBrush(System.Drawing.Color.FromArgb(20, 20, 20))) {
        g.FillRectangle(r, 0, 0, w / 2, h / 2);
        g.FillRectangle(gr, w / 2, 0, w - w / 2, h / 2);
        g.FillRectangle(b, 0, h / 2, w / 2, h - h / 2);
        g.FillRectangle(wh, w / 2, h / 2, w - w / 2, h - h / 2);
        int bx = (_n * 9) % Math.Max(1, w);
        g.FillRectangle(bar, bx, h * 45 / 100, Math.Max(8, w / 16), Math.Max(4, h / 10));
      }
    }
  }

  static class RecStandIn {
    static bool _ghost, _under;
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(RecPoint p);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);

    static void Bottom(IntPtr h) { SetWindowPos(h, new IntPtr(1), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010); }   // HWND_BOTTOM, NOSIZE|NOMOVE|NOACTIVATE

    /// Is any of these 9 points of the window the window itself, from the top of the z-order? (null = hidden)
    static string Seen(IntPtr h, RecRect r) {
      for (int i = 0; i < 3; i++)
        for (int j = 0; j < 3; j++) {
          var pt = new RecPoint();
          pt.X = r.Left + 2 + (r.Right - r.Left - 4) * i / 2; pt.Y = r.Top + 2 + (r.Bottom - r.Top - 4) * j / 2;
          IntPtr at = WindowFromPoint(pt);
          if (at == h || GetAncestor(at, 2) == h) return pt.X + "," + pt.Y;
        }
      return null;
    }

    public static int Run(string[] args) {
      string at = Recorder.Arg(args, "--at") ?? "";
      string[] p = at.Split(',');
      int x = 0, y = 0, w = 640, h = 360;
      if (p.Length == 4) {
        int.TryParse(p[0], out x); int.TryParse(p[1], out y); int.TryParse(p[2], out w); int.TryParse(p[3], out h);
      } else if (p.Length == 3 && p[0] == "under") {
        // "under,W,H": opaque, on the primary monitor, at the BOTTOM of the z-order (behind the desktop), so
        // Windows paints and composes it but every pixel of it is covered. Proved, not assumed: WindowFromPoint
        // at 9 points of it must name another window, else it closes at once and says hidden:false.
        int.TryParse(p[1], out w); int.TryParse(p[2], out h);
        var wa = System.Windows.Forms.Screen.PrimaryScreen.WorkingArea;
        x = wa.Right - w; y = wa.Bottom - h;
        _under = true;
      } else if (p.Length == 3 && p[0] == "ghost") {
        // "ghost,W,H": ON the primary monitor (Windows paints only windows on a screen) but 1/255 opaque and
        // click-through, so Owen sees nothing and his clicks go past it.
        int.TryParse(p[1], out w); int.TryParse(p[2], out h);
        var wa = System.Windows.Forms.Screen.PrimaryScreen.WorkingArea;
        x = wa.Right - w; y = wa.Bottom - h;
        _ghost = true;
      } else if (p.Length == 3 && p[0] == "off") {
        // "off,W,H": wholly OUTSIDE every monitor (right of the virtual screen), so a test window is never on
        // Owen's screen; Windows still composes it, so it can be recorded.
        int.TryParse(p[1], out w); int.TryParse(p[2], out h);
        var vs = System.Windows.Forms.SystemInformation.VirtualScreen;
        x = vs.Right + 200; y = vs.Top;
      }
      int secs = 120;
      int.TryParse(Recorder.Arg(args, "--secs") ?? "120", out secs);
      var form = new RecStandInForm(x, y, w, h, _ghost);
      if (_under) {
        // Behind everything BEFORE it is shown: it never comes up over Owen's windows, not even for a frame.
        form.HandleCreated += delegate (object s, EventArgs e) { Bottom(form.Handle); };
        var keep = new System.Windows.Forms.Timer();
        keep.Interval = 100;
        keep.Tick += delegate (object s, EventArgs e) {
          Bottom(form.Handle);
          RecRect rr;
          RecNative.GetWindowRect(form.Handle, out rr);
          string seenAt = Seen(form.Handle, rr);
          if (seenAt != null) {
            Recorder.Emit(Json.Obj("ev", "standin-visible", "at", seenAt));
            form.Close();
          }
        };
        keep.Start();
      }
      form.Shown += delegate (object s, EventArgs e) {
        RecRect r, f;
        if (_under) Bottom(form.Handle);
        RecNative.GetWindowRect(form.Handle, out r);
        if (RecNative.DwmGetWindowAttribute(form.Handle, 9, out f, 16) != 0) f = r;
        string seen = _under ? Seen(form.Handle, r) : null;
        if (seen != null) {
          Recorder.Emit(Json.Obj("ev", "standin", "hidden", false, "at", seen));
          form.Close();
          return;
        }
        Recorder.Emit(Json.Obj("ev", "standin", "hidden", _under, "hwnd", form.Handle.ToInt64().ToString(CultureInfo.InvariantCulture),
          "pid", (long)Process.GetCurrentProcess().Id, "x", r.Left, "y", r.Top, "w", r.Right - r.Left, "h", r.Bottom - r.Top,
          "frame", Json.Obj("x", f.Left, "y", f.Top, "w", f.Right - f.Left, "h", f.Bottom - f.Top)));
      };
      var stdin = new Thread(delegate () {
        try {
          var input = new StreamReader(Console.OpenStandardInput());
          string line;
          while ((line = input.ReadLine()) != null) {
            string[] mv = line.Trim().Split(' ');
            if (mv.Length == 5 && mv[0] == "move") {   // "move x y w h": a test resizes the stand-in mid-recording
              int a, b2, c, d;
              if (int.TryParse(mv[1], out a) && int.TryParse(mv[2], out b2) && int.TryParse(mv[3], out c) && int.TryParse(mv[4], out d))
                form.BeginInvoke((Action)delegate () { form.Bounds = new System.Drawing.Rectangle(a, b2, c, d); });
            }
            if (line.Trim() == "close") break;
          }
        } catch (Exception) { }
        try { form.BeginInvoke((Action)delegate () { form.Close(); }); } catch (Exception) { }
      });
      stdin.IsBackground = true;
      stdin.Start();
      var limit = new System.Windows.Forms.Timer();
      limit.Interval = Math.Max(1, secs) * 1000;
      limit.Tick += delegate (object s, EventArgs e) { form.Close(); };
      limit.Start();
      System.Windows.Forms.Application.Run(form);
      return 0;
    }
  }

#if MANTLE_WINMD
  [ComImport, Guid("3628E81B-3CAC-4C60-B7F4-23CE0E0C3356"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IRecCaptureItemInterop {
    IntPtr CreateForWindow([In] IntPtr window, [In] ref Guid iid);
    IntPtr CreateForMonitor([In] IntPtr monitor, [In] ref Guid iid);
  }
  [ComImport, Guid("A9B3D012-3DF2-4EE3-B8D1-8695F457D3C1"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IRecDxgiAccess { IntPtr GetInterface([In] ref Guid iid); }

  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class RecMMDeviceEnumerator { }
  [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IRecMMDeviceEnumerator {
    [PreserveSig] int EnumAudioEndpoints(int flow, int mask, out IntPtr devices);
    [PreserveSig] int GetDefaultAudioEndpoint(int flow, int role, out IRecMMDevice device);
  }
  [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IRecMMDevice {
    [PreserveSig] int Activate(ref Guid iid, int ctx, IntPtr prm, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
  }
  [ComImport, Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IRecAudioClient {
    [PreserveSig] int Initialize(int share, uint flags, long buffer, long period, IntPtr format, IntPtr session);
    [PreserveSig] int GetBufferSize(out uint frames);
    [PreserveSig] int GetStreamLatency(out long latency);
    [PreserveSig] int GetCurrentPadding(out uint padding);
    [PreserveSig] int IsFormatSupported(int share, IntPtr format, out IntPtr closest);
    [PreserveSig] int GetMixFormat(out IntPtr format);
    [PreserveSig] int GetDevicePeriod(out long def, out long min);
    [PreserveSig] int Start();
    [PreserveSig] int Stop();
    [PreserveSig] int Reset();
    [PreserveSig] int SetEventHandle(IntPtr h);
    [PreserveSig] int GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
  }
  [ComImport, Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IRecAudioCapture {
    [PreserveSig] int GetBuffer(out IntPtr data, out uint frames, out uint flags, out ulong devPos, out ulong qpcPos);
    [PreserveSig] int ReleaseBuffer(uint frames);
    [PreserveSig] int GetNextPacketSize(out uint frames);
  }

  /* ---- one timeline of 48 kHz stereo, every source added in by its packets' own clock ------------ */
  sealed class RecMix {
    public const int Rate = 48000;
    const int Cap = Rate * 4;
    readonly float[] _buf = new float[Cap * 2];
    readonly object _g = new object();
    long _emitted;

    /// data: interleaved stereo float, frames long, meant to start at `ideal` (timeline frames). A packet
    /// within 50 ms of where its source left off is laid end to end (no clicks from clock jitter); a
    /// bigger jump (a pause in the sound, a discontinuity) restarts the source at its own time.
    public void Add(RecAudioSource s, long ideal, float[] data, int frames, bool disc) {
      lock (_g) {
        if (s.Cursor < 0 || disc || Math.Abs(ideal - s.Cursor) > Rate / 20) s.Cursor = ideal;
        long at = s.Cursor;
        s.Cursor += frames;
        for (int i = 0; i < frames; i++) {
          long f = at + i;
          if (f < _emitted) { s.LateFrames++; continue; }
          if (f >= _emitted + Cap) break;
          int k = (int)(f % Cap) * 2;
          _buf[k] += data[2 * i];
          _buf[k + 1] += data[2 * i + 1];
        }
      }
    }

    /// Everything before `upTo` as 16-bit PCM (clipped), its slots emptied for reuse.
    public byte[] Take(long upTo, int maxFrames, out long from, out int frames) {
      lock (_g) {
        from = _emitted;
        long n = Math.Min(upTo - _emitted, Math.Min(Cap, maxFrames));
        if (n <= 0) { frames = 0; return null; }
        frames = (int)n;
        var outb = new byte[frames * 4];
        for (int i = 0; i < frames; i++) {
          int k = (int)((_emitted + i) % Cap) * 2;
          for (int c = 0; c < 2; c++) {
            float v = _buf[k + c];
            _buf[k + c] = 0;
            int sv = (int)Math.Round(v * 32767f);
            if (sv > 32767) sv = 32767; else if (sv < -32768) sv = -32768;
            outb[i * 4 + c * 2] = (byte)(sv & 0xFF);
            outb[i * 4 + c * 2 + 1] = (byte)((sv >> 8) & 0xFF);
          }
        }
        _emitted += frames;
        return outb;
      }
    }
  }

  sealed class RecAudioSource {
    public readonly string Name;
    public string Why;            // null = capturing
    public long Cursor = -1, Packets, Frames, SilentPackets, LateFrames;
    public string Format = "";
    IRecAudioClient _client;
    IRecAudioCapture _cap;
    int _ch, _rate, _bits; bool _float;
    Thread _t;
    volatile bool _run;
    RecSession _s;

    public RecAudioSource(string name) { Name = name; }

    /// flow 0 = render (loopback of the speakers), 1 = capture (the microphone)
    public bool Open(int flow, RecSession s) {
      _s = s;
      try {
        var en = (IRecMMDeviceEnumerator)new RecMMDeviceEnumerator();
        IRecMMDevice dev;
        int hr = en.GetDefaultAudioEndpoint(flow, 0, out dev);
        if (hr < 0 || dev == null) { Why = flow == 0 ? "there is no sound output device" : "there is no microphone"; return false; }
        object o;
        Guid iid = typeof(IRecAudioClient).GUID;
        V.Hr(dev.Activate(ref iid, 23, IntPtr.Zero, out o), "the audio device could not be opened");
        _client = (IRecAudioClient)o;
        uint loop = flow == 0 ? 0x00020000u : 0u;
        // Asked for as 48 kHz 16-bit stereo, converted by Windows (AUTOCONVERTPCM | SRC_DEFAULT_QUALITY).
        IntPtr wf = Marshal.AllocHGlobal(18);
        try {
          Marshal.WriteInt16(wf, 0, 1); Marshal.WriteInt16(wf, 2, 2); Marshal.WriteInt32(wf, 4, RecMix.Rate);
          Marshal.WriteInt32(wf, 8, RecMix.Rate * 4); Marshal.WriteInt16(wf, 12, 4); Marshal.WriteInt16(wf, 14, 16); Marshal.WriteInt16(wf, 16, 0);
          hr = _client.Initialize(0, loop | 0x80000000u | 0x08000000u, 2000000, 0, wf, IntPtr.Zero);
        } finally { Marshal.FreeHGlobal(wf); }
        if (hr >= 0) { _ch = 2; _rate = RecMix.Rate; _bits = 16; _float = false; Format = "48 kHz 16-bit stereo (converted by Windows)"; }
        else {
          // The fallback: the device's own mix format, converted here. A fresh client: a failed Initialize spoils one.
          Marshal.ReleaseComObject(_client);
          V.Hr(dev.Activate(ref iid, 23, IntPtr.Zero, out o), "the audio device could not be opened again");
          _client = (IRecAudioClient)o;
          IntPtr mix;
          V.Hr(_client.GetMixFormat(out mix), "the audio device would not give its format");
          try {
            int tag = Marshal.ReadInt16(mix, 0) & 0xFFFF;
            _ch = Marshal.ReadInt16(mix, 2); _rate = Marshal.ReadInt32(mix, 4); _bits = Marshal.ReadInt16(mix, 14);
            _float = tag == 3;
            if (tag == 0xFFFE) {
              byte[] g = new byte[16];
              Marshal.Copy(new IntPtr(mix.ToInt64() + 24), g, 0, 16);
              _float = new Guid(g) == MFG.Float;
            }
            if (!(_float && _bits == 32) && _bits != 16) { Why = "its format (" + _bits + "-bit) is not one Mantle can convert"; return false; }
            V.Hr(_client.Initialize(0, loop, 2000000, 0, mix, IntPtr.Zero), "the audio device would not start");
            Format = (_rate / 1000.0).ToString("0.#", CultureInfo.InvariantCulture) + " kHz " + _bits + "-bit " + _ch + " ch (converted by Mantle)";
          } finally { RecNative.CoTaskMemFree(mix); }
        }
        object c;
        Guid ciid = typeof(IRecAudioCapture).GUID;
        V.Hr(_client.GetService(ref ciid, out c), "the audio device gave no capture service");
        _cap = (IRecAudioCapture)c;
        return true;
      } catch (Exception ex) {
        Why = V.Why(ex);
        return false;
      }
    }

    public void Start() {
      if (_client == null) return;
      int hr = _client.Start();
      if (hr < 0) { Why = "it would not start (" + V.Code(hr) + ")"; return; }
      _run = true;
      _t = new Thread(Loop);
      _t.IsBackground = true;
      _t.Priority = ThreadPriority.AboveNormal;
      _t.Start();
    }

    public void Stop() {
      _run = false;
      if (_t != null) _t.Join(1000);
      try { if (_client != null) _client.Stop(); } catch (Exception) { }
      try { if (_cap != null) Marshal.ReleaseComObject(_cap); } catch (Exception) { }
      try { if (_client != null) Marshal.ReleaseComObject(_client); } catch (Exception) { }
      _cap = null; _client = null;
    }

    void Loop() {
      float[] buf = new float[0];
      while (_run) {
        try {
          uint n;
          if (_cap.GetNextPacketSize(out n) < 0) { Why = "the device went away mid-recording"; return; }
          while (n > 0 && _run) {
            IntPtr data; uint frames, flags; ulong dev, qpc;
            int hr = _cap.GetBuffer(out data, out frames, out flags, out dev, out qpc);
            if (hr < 0) { Why = "the device stopped giving sound (" + V.Code(hr) + ")"; return; }
            try {
              int outFrames = _rate == RecMix.Rate ? (int)frames : (int)((long)frames * RecMix.Rate / _rate);
              if (buf.Length < outFrames * 2) buf = new float[outFrames * 2];
              bool silent = (flags & 2) != 0;
              if (silent) { Array.Clear(buf, 0, outFrames * 2); SilentPackets++; }
              else Convert(data, (int)frames, buf, outFrames);
              long start = _s.Start100;
              if (start > 0) {
                long ideal = ((long)qpc - start) * RecMix.Rate / 10000000L;
                _s.Mix.Add(this, ideal, buf, outFrames, (flags & 1) != 0);
              }
              Packets++; Frames += outFrames;
            } finally { _cap.ReleaseBuffer(frames); }
            if (_cap.GetNextPacketSize(out n) < 0) n = 0;
          }
        } catch (Exception ex) { Why = "it failed mid-recording (" + V.Why(ex) + ")"; return; }
        Thread.Sleep(5);
      }
    }

    // device frames -> interleaved stereo float at 48 kHz (first two channels; mono doubled; linear resample)
    void Convert(IntPtr data, int frames, float[] outb, int outFrames) {
      int bps = _bits / 8, stride = bps * _ch;
      for (int i = 0; i < outFrames; i++) {
        double pos = _rate == RecMix.Rate ? i : (double)i * _rate / RecMix.Rate;
        int i0 = Math.Min(frames - 1, (int)pos);
        int i1 = Math.Min(frames - 1, i0 + 1);
        double t = pos - i0;
        for (int c = 0; c < 2; c++) {
          int ch = Math.Min(c, _ch - 1);
          float a = Sample(data, i0 * stride + ch * bps), b = Sample(data, i1 * stride + ch * bps);
          outb[2 * i + c] = (float)(a + (b - a) * t);
        }
      }
    }
    float Sample(IntPtr data, int off) {
      if (_float) {
        int bits = Marshal.ReadInt32(data, off);
        return BitConverter.ToSingle(BitConverter.GetBytes(bits), 0);
      }
      return Marshal.ReadInt16(data, off) / 32768f;
    }
  }

  /* ---- one recording ------------------------------------------------------------------------- */
  sealed class RecSession {
    readonly Dictionary<string, object> _spec;
    string _mode, _outPath, _part;
    IntPtr _hwnd, _hmon;
    int _fps, _maxSecs, _testSecs, _allowPid;
    long _minFreeMb;
    bool _test, _wantAudio, _wantMic, _cursor;
    // the crop, in the CAPTURED picture's pixels, and the output size (even)
    int _cropX, _cropY, _outW, _outH;
    RecRect _monRect;
    bool _winCropAuto;     // window mode: crop to the visible frame inside the window rect (the frame may include the resize borders)
    int _winOffX, _winOffY, _userX, _userY;

    volatile bool _stop;
    string _stopWhy;
    readonly object _stopGate = new object();

    public long Start100;          // when the first frame went in (100 ns, QPC); 0 = not yet
    public readonly RecMix Mix = new RecMix();
    readonly List<RecAudioSource> _sources = new List<RecAudioSource>();
    Thread _emitter;
    volatile bool _emitRun;

    IntPtr _dev, _ctx, _mgr, _writer, _staging;
    uint _mgrToken;
    uint _vStream, _aStream;
    bool _hasAudio, _hw, _hwTried;
    string _encName = "", _encWhy = null;
    bool _encHardware;
    readonly object _wgate = new object();
    IDirect3DDevice _wdev;
    GraphicsCaptureItem _item;
    Direct3D11CaptureFramePool _pool;
    GraphicsCaptureSession _session;
    int _poolW, _poolH;
    readonly List<IntPtr> _texRing = new List<IntPtr>();
    int _ringNext;
    IntPtr _curTex, _curBuf;
    long _frames, _late, _dup, _fresh, _audioSamples;
    bool _freshSinceWrite;
    string _border = "shown", _borderWhy = null, _access = null;
    long _t0;

    public RecSession(Dictionary<string, object> spec) { _spec = spec; _t0 = V.Now100(); }

    long Ms() { return (V.Now100() - _t0) / 10000; }

    public void RequestStop(string why) {
      lock (_stopGate) { if (_stopWhy == null) _stopWhy = why; _stop = true; }
    }

    public int RunAll() {
      RecNative.timeBeginPeriod(1);
      try {
        try {
          Init();
        } catch (Exception ex) {
          Recorder.Emit(Json.Obj("ev", "error", "error", V.Why(ex), "ms", Ms()));
          Teardown();
          TryDelete(_part);
          return 3;
        }
        string loopWhy = null;
        try { Loop(); } catch (Exception ex) { loopWhy = V.Why(ex); RequestStop("error"); }
        return Finish(loopWhy);
      } finally {
        RecNative.timeEndPeriod(1);
      }
    }

    static void TryDelete(string p) { try { if (p != null && File.Exists(p)) File.Delete(p); } catch (Exception) { } }

    /* ---- setting up ---- */
    void Init() {
      _mode = Json.GetString(_spec, "mode") ?? "";
      _fps = Json.GetInt(_spec, "fps", 30) >= 45 ? 60 : 30;
      _wantAudio = Json.GetBool(_spec, "audio", true);
      _wantMic = Json.GetBool(_spec, "mic", false);
      _outPath = Json.GetString(_spec, "out");
      _maxSecs = Math.Max(1, Json.GetInt(_spec, "maxSecs", 4 * 3600));
      _minFreeMb = Math.Max(256, Json.GetInt(_spec, "minFreeMb", 1024));
      _test = Json.GetBool(_spec, "test", false);
      _allowPid = Json.GetInt(_spec, "allowPid", 0);
      _testSecs = Json.GetInt(_spec, "testSecs", 0);
      // Windows draws the mouse pointer into the picture wherever it is over the window or area - but never in
      // a test: a test recording must not show Owen's pointer, and where he leaves it is not the test's to
      // choose. Over the stand-in's corner of the screen it sits in the very frames a test reads back (lane
      // recwhite 2026-10-16: the top-left quadrant read WHITE at 2.5 s while he was away from the laptop).
      _cursor = !_test && Json.GetBool(_spec, "cursor", true);
      if (string.IsNullOrEmpty(_outPath) || !Path.IsPathRooted(_outPath) || !_outPath.EndsWith(".mp4", StringComparison.OrdinalIgnoreCase))
        throw new RecError("no full .mp4 path to save the recording to");
      string dir = Path.GetDirectoryName(_outPath);
      try { Directory.CreateDirectory(dir); } catch (Exception ex) { throw new RecError("the folder " + dir + " could not be made (" + ex.Message + ")"); }
      long free = FreeMb(dir);
      if (free >= 0 && free < _minFreeMb * 2)
        throw new RecError("there is not enough free disk space to record (" + Gb(free) + " free, Mantle wants " + Gb(_minFreeMb * 2) + ")");
      _part = _outPath + ".part";
      if (File.Exists(_part)) _part = _outPath + "." + Process.GetCurrentProcess().Id.ToString(CultureInfo.InvariantCulture) + ".part";
      if (_test && _mode != "window") throw new RecError("a test run records only its own stand-in window, never the screen");
      if (!GraphicsCaptureSession.IsSupported()) throw new RecError("Windows on this PC cannot record the screen (Windows.Graphics.Capture is not supported)");

      // the GPU device, shared with the encoder (multithread-protected: MF uses it from its own threads)
      IntPtr ctx;
      int level;
      int hr = RecNative.D3D11CreateDevice(IntPtr.Zero, 1, IntPtr.Zero, 0x20 | 0x800, IntPtr.Zero, 0, 7, out _dev, out level, out ctx);
      if (hr < 0) hr = RecNative.D3D11CreateDevice(IntPtr.Zero, 1, IntPtr.Zero, 0x20, IntPtr.Zero, 0, 7, out _dev, out level, out ctx);
      V.Hr(hr, "the graphics device could not be opened");
      _ctx = ctx;
      IntPtr mt;
      if (Marshal.QueryInterface(_dev, ref MFG.IID_Multithread, out mt) >= 0) { V.F<FnU>(mt, 5)(mt, 1); Marshal.Release(mt); }   // SetMultithreadProtected(TRUE)
      IntPtr dxgi;
      V.Hr(Marshal.QueryInterface(_dev, ref MFG.IID_DxgiDevice, out dxgi), "the graphics device has no DXGI side");
      IntPtr insp;
      try { V.Hr(RecNative.CreateDirect3D11DeviceFromDXGIDevice(dxgi, out insp), "the capture device could not be made"); }
      finally { Marshal.Release(dxgi); }
      _wdev = (IDirect3DDevice)Marshal.GetObjectForIUnknown(insp);
      Marshal.Release(insp);

      MakeItem();
      int itemW = _item.Size.Width, itemH = _item.Size.Height;
      Crop(itemW, itemH, true);
      if (_outW < 64 || _outH < 64) throw new RecError("the area is too small to record (" + _outW + " x " + _outH + "; at least 64 x 64)");
      if (_outW > 4096 || _outH > 4096) throw new RecError("the area is too big to record (" + _outW + " x " + _outH + "; at most 4096 on a side)");

      if (_wantAudio) OpenAudio("system sound", 0);
      if (_wantMic) OpenAudio("microphone", 1);
      _hasAudio = false;
      foreach (var s in _sources) if (s.Why == null) _hasAudio = true;

      V.Hr(RecNative.MFStartup(0x00020070, 0), "Media Foundation would not start");
      string hwWhy = MakeWriter(true);
      if (hwWhy != null) {
        _encWhy = "the hardware encoder could not be set up (" + hwWhy + ")";
        string swWhy = MakeWriter(false);
        if (swWhy != null) throw new RecError("no H.264 encoder would take this recording (hardware: " + hwWhy + "; software: " + swWhy + ")");
      }

      // the capture
      _poolW = itemW; _poolH = itemH;
      _pool = Direct3D11CaptureFramePool.CreateFreeThreaded(_wdev, DirectXPixelFormat.B8G8R8A8UIntNormalized, 2, _item.Size);
      _session = _pool.CreateCaptureSession(_item);
      try { _session.IsCursorCaptureEnabled = _cursor; } catch (Exception) { }
      try { _cursor = _session.IsCursorCaptureEnabled; } catch (Exception) { }   // what Windows will really do
      if (_mode == "window") { try { _session.IncludeSecondaryWindows = true; } catch (Exception) { } }
      try { _session.MinUpdateInterval = TimeSpan.FromTicks(10000000L / _fps); } catch (Exception) { }
      Borderless();
      _session.StartCapture();
      long ready = Ms();

      // the first frame starts the clock (a window that does not paint for 3 s is refused, not recorded black)
      long until = V.Now100() + 30000000L;
      while (_curTex == IntPtr.Zero && _curBuf == IntPtr.Zero) {
        if (_stop) throw new RecError("stopped before the first frame");
        if (V.Now100() > until) throw new RecError("Windows sent no picture of the " + (_mode == "window" ? "window" : "screen") + " within 3 s");
        Poll();
        if (_curTex == IntPtr.Zero && _curBuf == IntPtr.Zero) Thread.Sleep(5);
      }
      Start100 = V.Now100();
      foreach (var s in _sources) if (s.Why == null) s.Start();
      if (_hasAudio) {
        _emitRun = true;
        _emitter = new Thread(EmitLoop);
        _emitter.IsBackground = true;
        _emitter.Start();
      }
      var audio = new System.Collections.Specialized.OrderedDictionary();
      audio["system"] = !_wantAudio ? "off" : SourceWords("system sound");
      audio["mic"] = !_wantMic ? "off" : SourceWords("microphone");
      Recorder.Emit(Json.Obj("ev", "ready", "w", _outW, "h", _outH, "fps", _fps, "mode", _mode,
        "item", Json.Obj("w", itemW, "h", itemH), "crop", Json.Obj("x", _cropX, "y", _cropY, "w", _outW, "h", _outH),
        "encoder", Json.Obj("name", _encName, "hardware", _encHardware, "route", _hw ? "gpu" : "software", "why", _encWhy),
        "border", _border, "borderWhy", _borderWhy, "access", _access, "cursor", _cursor, "audio", audio, "part", _part,
        "pid", (long)Process.GetCurrentProcess().Id, "ms", Json.Obj("ready", ready, "firstFrame", Ms())));
      Recorder.Emit(Json.Obj("ev", "started", "ms", Ms()));
    }

    string SourceWords(string name) {
      foreach (var s in _sources) if (s.Name == name) return s.Why == null ? "on" : s.Why;
      return "off";
    }

    void OpenAudio(string name, int flow) {
      var s = new RecAudioSource(name);
      s.Open(flow, this);
      _sources.Add(s);
    }

    static long FreeMb(string dir) {
      try { return new DriveInfo(Path.GetPathRoot(dir)).AvailableFreeSpace / (1024 * 1024); } catch (Exception) { return -1; }
    }
    static string Gb(long mb) { return (mb / 1024.0).ToString("0.0", CultureInfo.InvariantCulture) + " GB"; }

    void MakeItem() {
      var factory = System.Runtime.InteropServices.WindowsRuntime.WindowsRuntimeMarshal.GetActivationFactory(typeof(GraphicsCaptureItem));
      var interop = (IRecCaptureItemInterop)(object)factory;
      Guid iid = new Guid("79C3F95B-31F7-4EC2-A464-632EF5D30760");
      IntPtr p;
      if (_mode == "window") {
        string hs = Json.GetString(_spec, "hwnd");
        long hv;
        if (hs == null || !long.TryParse(hs, NumberStyles.Integer, CultureInfo.InvariantCulture, out hv) || hv == 0) throw new RecError("no window was named to record");
        _hwnd = new IntPtr(hv);
        if (!RecNative.IsWindow(_hwnd)) throw new RecError("that window has closed");
        if (RecNative.IsIconic(_hwnd)) throw new RecError("that window is minimized; restore it first");
        uint pid;
        RecNative.GetWindowThreadProcessId(_hwnd, out pid);
        if (pid == (uint)Process.GetCurrentProcess().Id) throw new RecError("the recorder cannot record itself");
        if (_test && (_allowPid == 0 || pid != (uint)_allowPid)) throw new RecError("a test run records only its own stand-in window (that window belongs to another process)");
        try { p = interop.CreateForWindow(_hwnd, ref iid); }
        catch (Exception ex) { throw new RecError("Windows would not record that window (" + V.Why(ex) + ")"); }
      } else if (_mode == "monitor") {
        var pt = new RecPoint();
        pt.X = Json.GetInt(_spec, "x", 0); pt.Y = Json.GetInt(_spec, "y", 0);
        _hmon = RecNative.MonitorFromPoint(pt, 0);
        if (_hmon == IntPtr.Zero) throw new RecError("there is no screen at that point");
        var mi = new RecMonInfo();
        mi.Size = Marshal.SizeOf(typeof(RecMonInfo));
        if (!RecNative.GetMonitorInfoW(_hmon, ref mi)) throw new RecError("the screen's size could not be read");
        _monRect = mi.Monitor;
        try { p = interop.CreateForMonitor(_hmon, ref iid); }
        catch (Exception ex) { throw new RecError("Windows would not record that screen (" + V.Why(ex) + ")"); }
      } else throw new RecError("the recording must be of a window or a screen");
      _item = (GraphicsCaptureItem)Marshal.GetObjectForIUnknown(p);
      Marshal.Release(p);
    }

    /// Where in the captured picture the output comes from. Monitor: the asked-for area, made monitor-relative
    /// and clamped. Window: the visible frame (Windows' window picture can include the invisible resize
    /// borders), plus an optional crop inside it. `first` fixes the output size; later calls (the window was
    /// resized) only move the origin.
    void Crop(int itemW, int itemH, bool first) {
      int x = 0, y = 0, w = itemW, h = itemH;
      object co;
      Dictionary<string, object> crop = Json.TryGet(_spec, "crop", out co) ? co as Dictionary<string, object> : null;
      if (_mode == "monitor") {
        if (crop != null) {
          x = Json.GetInt(crop, "x", _monRect.Left) - _monRect.Left; y = Json.GetInt(crop, "y", _monRect.Top) - _monRect.Top;
          w = Json.GetInt(crop, "w", itemW); h = Json.GetInt(crop, "h", itemH);
        }
      } else {
        RecRect wr, fr;
        _winOffX = 0; _winOffY = 0;
        if (RecNative.GetWindowRect(_hwnd, out wr) && RecNative.DwmGetWindowAttribute(_hwnd, 9, out fr, 16) == 0 &&
            itemW == wr.Right - wr.Left && itemH == wr.Bottom - wr.Top) {
          _winOffX = fr.Left - wr.Left; _winOffY = fr.Top - wr.Top;
          w = fr.Right - fr.Left; h = fr.Bottom - fr.Top;
          _winCropAuto = true;
        }
        x = _winOffX; y = _winOffY;
        if (crop != null) {
          _userX = Json.GetInt(crop, "x", 0); _userY = Json.GetInt(crop, "y", 0);
          x += _userX; y += _userY;
          w = Json.GetInt(crop, "w", w); h = Json.GetInt(crop, "h", h);
        }
      }
      if (x < 0) { w += x; x = 0; }
      if (y < 0) { h += y; y = 0; }
      if (x + w > itemW) w = itemW - x;
      if (y + h > itemH) h = itemH - y;
      _cropX = Math.Max(0, x); _cropY = Math.Max(0, y);
      if (first) { _outW = Math.Max(0, w) & ~1; _outH = Math.Max(0, h) & ~1; }
    }

    void Borderless() {
      // Windows 11 can drop the yellow "being recorded" border, if the app is allowed (GraphicsCaptureAccess,
      // Borderless). An unpackaged app has no manifest capability to declare, so this asks and reports.
      try {
        var op = GraphicsCaptureAccess.RequestAccessAsync(GraphicsCaptureAccessKind.Borderless);
        AppCapabilityAccessStatus st;
        string err = WinRt.Await(op, 3000, "the borderless-capture request", out st);
        _access = err ?? st.ToString();
      } catch (Exception ex) { _access = "not asked (" + V.Why(ex) + ")"; }
      try {
        _session.IsBorderRequired = false;
        _border = _session.IsBorderRequired ? "shown" : "hidden";
        if (_border == "shown") _borderWhy = "Windows kept the border after Mantle asked to hide it (access: " + _access + ")";
      } catch (Exception ex) {
        _border = "shown";
        _borderWhy = "Windows would not hide the yellow border (" + V.Why(ex) + "; access: " + _access + ")";
      }
    }

    /* ---- the writer ---- */
    IntPtr NewType() { IntPtr t; V.Hr(RecNative.MFCreateMediaType(out t), "a media type could not be made"); return t; }

    string MakeWriter(bool hw) {
      _hwTried |= hw;
      IntPtr attrs = IntPtr.Zero, vout = IntPtr.Zero, vin = IntPtr.Zero, aout = IntPtr.Zero, ain = IntPtr.Zero, prm = IntPtr.Zero;
      try {
        TryDelete(_part);
        V.Hr(RecNative.MFCreateAttributes(out attrs, 4), "the writer's settings could not be made");
        MFG.G(attrs, MFG.ContainerType, MFG.Mpeg4, "MP4");
        MFG.U32(attrs, MFG.HwTransforms, hw ? 1u : 0u, "hardware transforms");
        if (hw) {
          if (_mgr == IntPtr.Zero) {
            V.Hr(RecNative.MFCreateDXGIDeviceManager(out _mgrToken, out _mgr), "the GPU device manager could not be made");
            V.Hr(V.F<FnPU>(_mgr, 7)(_mgr, _dev, _mgrToken), "the GPU device manager would not take the device");
          }
          MFG.Unk(attrs, MFG.D3DManager, _mgr, "the GPU device for the encoder");
        }
        V.Hr(RecNative.MFCreateSinkWriterFromURL(_part, IntPtr.Zero, attrs, out _writer), "the file could not be opened for writing");
        uint br = (uint)Math.Max(1000000, Math.Min(24000000, (long)(_outW * (long)_outH * _fps * 0.12)));
        vout = NewType();
        MFG.G(vout, MFG.MajorType, MFG.Video, "video"); MFG.G(vout, MFG.Subtype, MFG.H264, "H.264");
        MFG.U32(vout, MFG.AvgBitrate, br, "bitrate"); MFG.U32(vout, MFG.Interlace, 2, "progressive");
        MFG.U64(vout, MFG.FrameSize, MFG.Pack((uint)_outW, (uint)_outH), "size"); MFG.U64(vout, MFG.FrameRate, MFG.Pack((uint)_fps, 1), "frame rate");
        MFG.U64(vout, MFG.Par, MFG.Pack(1, 1), "pixel shape"); MFG.U32(vout, MFG.Mpeg2Profile, 100, "High profile");
        V.Hr(V.F<FnPoU>(_writer, 3)(_writer, vout, out _vStream), "the encoder would not take " + _outW + " x " + _outH + " at " + _fps + " fps");
        vin = NewType();
        MFG.G(vin, MFG.MajorType, MFG.Video, "video"); MFG.G(vin, MFG.Subtype, MFG.RGB32, "RGB32");
        MFG.U32(vin, MFG.Interlace, 2, "progressive"); MFG.U64(vin, MFG.FrameSize, MFG.Pack((uint)_outW, (uint)_outH), "size");
        MFG.U64(vin, MFG.FrameRate, MFG.Pack((uint)_fps, 1), "frame rate"); MFG.U64(vin, MFG.Par, MFG.Pack(1, 1), "pixel shape");
        MFG.U32(vin, MFG.DefaultStride, (uint)(_outW * 4), "top-down rows");
        // Variable bit rate (a still screen costs little), a key frame every 2 s (seeking); if the encoder
        // refuses these, its defaults.
        V.Hr(RecNative.MFCreateAttributes(out prm, 3), "the encoder settings could not be made");
        MFG.U32(prm, MFG.RateControl, 1, "VBR"); MFG.U32(prm, MFG.MeanBitrate, br, "mean bitrate"); MFG.U32(prm, MFG.GopSize, (uint)(_fps * 2), "key frames");
        int hr = V.F<FnUPP>(_writer, 4)(_writer, _vStream, vin, prm);
        if (hr < 0) hr = V.F<FnUPP>(_writer, 4)(_writer, _vStream, vin, IntPtr.Zero);
        V.Hr(hr, "the encoder would not take the screen's pictures");
        if (_hasAudio) {
          aout = NewType();
          MFG.G(aout, MFG.MajorType, MFG.Audio, "audio"); MFG.G(aout, MFG.Subtype, MFG.AAC, "AAC");
          MFG.U32(aout, MFG.AudioBits, 16, "bits"); MFG.U32(aout, MFG.AudioRate, RecMix.Rate, "rate"); MFG.U32(aout, MFG.AudioChannels, 2, "channels");
          MFG.U32(aout, MFG.AudioAvgBytes, 24000, "192 kbps"); MFG.U32(aout, MFG.AacPayload, 0, "raw AAC");
          V.Hr(V.F<FnPoU>(_writer, 3)(_writer, aout, out _aStream), "the AAC encoder would not take the sound");
          ain = NewType();
          MFG.G(ain, MFG.MajorType, MFG.Audio, "audio"); MFG.G(ain, MFG.Subtype, MFG.PCM, "PCM");
          MFG.U32(ain, MFG.AudioBits, 16, "bits"); MFG.U32(ain, MFG.AudioRate, RecMix.Rate, "rate"); MFG.U32(ain, MFG.AudioChannels, 2, "channels");
          MFG.U32(ain, MFG.AudioBlock, 4, "block"); MFG.U32(ain, MFG.AudioAvgBytes, RecMix.Rate * 4, "bytes"); MFG.U32(ain, MFG.AllIndependent, 1, "independent");
          V.Hr(V.F<FnUPP>(_writer, 4)(_writer, _aStream, ain, IntPtr.Zero), "the AAC encoder would not take 48 kHz stereo");
        }
        V.Hr(V.F<FnV>(_writer, 5)(_writer), "the encoder would not start");
        _hw = hw;
        if (!hw) {
          var d = Desc(0, 0, 3, 0, 0x20000);
          V.Hr(V.F<FnCreateTex>(_dev, 5)(_dev, ref d, IntPtr.Zero, out _staging), "the read-back texture could not be made");
        }
        EncoderName();
        return null;
      } catch (Exception ex) {
        V.Rel(ref _writer);
        TryDelete(_part);
        return V.Why(ex);
      } finally {
        V.Rel(ref attrs); V.Rel(ref vout); V.Rel(ref vin); V.Rel(ref aout); V.Rel(ref ain); V.Rel(ref prm);
      }
    }

    void EncoderName() {
      _encName = _hw ? "GPU encoder" : "Microsoft software H.264 encoder";
      _encHardware = false;
      IntPtr ex;
      if (Marshal.QueryInterface(_writer, ref MFG.IID_SinkWriterEx, out ex) < 0) return;
      try {
        for (uint i = 0; i < 12; i++) {
          Guid cat; IntPtr xf;
          if (V.F<FnGetXform>(ex, 14)(ex, _vStream, i, out cat, out xf) < 0) break;
          try {
            if (cat != MFG.CatVideoEncoder) continue;
            IntPtr a;
            if (V.F<FnoP>(xf, 8)(xf, out a) < 0 || a == IntPtr.Zero) continue;
            try {
              string n = MFG.Str(a, MFG.FriendlyName);
              _encHardware = MFG.Str(a, MFG.HardwareUrl) != null;
              string ven = MFG.Str(a, new Guid("3aecb0cc-035b-4bcc-8185-2b8d551ef3af")) ?? "";   // MFT_ENUM_HARDWARE_VENDOR_ID_Attribute
              string who = ven.IndexOf("8086", StringComparison.OrdinalIgnoreCase) >= 0 ? "Intel Quick Sync"
                : ven.IndexOf("10DE", StringComparison.OrdinalIgnoreCase) >= 0 ? "NVIDIA NVENC"
                : ven.IndexOf("1002", StringComparison.OrdinalIgnoreCase) >= 0 ? "AMD" : null;
              if (!string.IsNullOrEmpty(n)) _encName = n;
              else if (_encHardware) _encName = (who ?? "GPU") + " H.264 encoder" + (ven.Length > 0 ? " (" + ven + ")" : "");
            } finally { Marshal.Release(a); }
          } finally { Marshal.Release(xf); }
        }
      } catch (Exception) { } finally { Marshal.Release(ex); }
      if (!_hw) _encHardware = false;
    }

    RecTexDesc Desc(int w, int h, uint usage, uint bind, uint cpu) {
      var d = new RecTexDesc();
      d.Width = (uint)(w > 0 ? w : _outW); d.Height = (uint)(h > 0 ? h : _outH); d.MipLevels = 1; d.ArraySize = 1;
      d.Format = 87; d.SampleCount = 1; d.Usage = usage; d.BindFlags = bind; d.CPUAccessFlags = cpu;
      return d;
    }

    /* ---- frames in ---- */
    void Poll() {
      Direct3D11CaptureFrame latest = null, f;
      while ((f = _pool.TryGetNextFrame()) != null) { if (latest != null) latest.Dispose(); latest = f; }
      if (latest == null) return;
      try {
        SizeInt32 cs = latest.ContentSize;
        if (cs.Width != _poolW || cs.Height != _poolH) {
          _poolW = cs.Width; _poolH = cs.Height;
          if (cs.Width > 0 && cs.Height > 0) {
            _pool.Recreate(_wdev, DirectXPixelFormat.B8G8R8A8UIntNormalized, 2, cs);
            if (_mode == "window") Crop(cs.Width, cs.Height, false);
          }
        }
        object surf = latest.Surface;
        IntPtr src = ((IRecDxgiAccess)surf).GetInterface(ref MFG.IID_Tex2D);
        try { CopyIn(src, cs.Width, cs.Height); }
        finally { Marshal.Release(src); try { Marshal.ReleaseComObject(surf); } catch (Exception) { } }
        _fresh++;
        _freshSinceWrite = true;
      } finally { latest.Dispose(); }
    }

    void CopyIn(IntPtr src, int contentW, int contentH) {
      RecTexDesc sd;
      V.F<FnGetDesc>(src, 10)(src, out sd);
      int availW = Math.Min(contentW, (int)sd.Width) - _cropX, availH = Math.Min(contentH, (int)sd.Height) - _cropY;
      int cw = Math.Max(0, Math.Min(_outW, availW)), ch = Math.Max(0, Math.Min(_outH, availH));
      var box = new RecBox();
      box.Left = (uint)_cropX; box.Top = (uint)_cropY; box.Front = 0; box.Right = (uint)(_cropX + cw); box.Bottom = (uint)(_cropY + ch); box.Back = 1;
      if (_hw) {
        IntPtr dst = NextTex();
        if (cw < _outW || ch < _outH) Clear(dst);
        if (cw > 0 && ch > 0) V.F<FnCopyRegion>(_ctx, 46)(_ctx, dst, 0, 0, 0, 0, src, 0, ref box);
        _curTex = dst;
      } else Stage(src, box, cw, ch);
    }

    /// The software route: the crop goes through the staging texture into a fresh memory buffer (the
    /// encoder may still hold the last one), black where the source does not reach.
    void Stage(IntPtr src, RecBox box, int cw, int ch) {
      {
        if (cw > 0 && ch > 0) V.F<FnCopyRegion>(_ctx, 46)(_ctx, _staging, 0, 0, 0, 0, src, 0, ref box);
        RecMapped m;
        V.Hr(V.F<FnMap>(_ctx, 14)(_ctx, _staging, 0, 1, 0, out m), "the picture could not be read back");
        IntPtr buf = IntPtr.Zero;
        try {
          uint len = (uint)(_outW * _outH * 4);
          V.Hr(RecNative.MFCreateMemoryBuffer(len, out buf), "a frame buffer could not be made");
          IntPtr p; uint max, cur;
          V.Hr(V.F<FnLock>(buf, 3)(buf, out p, out max, out cur), "a frame buffer could not be locked");
          try {
            if (cw < _outW || ch < _outH) {
              var zero = new byte[_outW * 4];
              for (int y = 0; y < _outH; y++) Marshal.Copy(zero, 0, new IntPtr(p.ToInt64() + (long)y * _outW * 4), zero.Length);
            }
            if (cw > 0 && ch > 0) RecNative.MFCopyImage(p, _outW * 4, m.Data, (int)m.RowPitch, (uint)(cw * 4), (uint)ch);
          } finally { V.F<FnV>(buf, 4)(buf); }
          V.F<FnU>(buf, 6)(buf, len);
        } catch { V.Rel(ref buf); throw; }
        finally { V.F<FnUnmap>(_ctx, 15)(_ctx, _staging, 0); }
        V.Rel(ref _curBuf);
        _curBuf = buf;
      }
    }

    /// The next output texture: one the encoder has let go of (only the ring holds it), else a new one
    /// (up to 6), else the oldest. Never the one that is the current picture.
    IntPtr NextTex() {
      for (int i = 0; i < _texRing.Count; i++) {
        int k = (_ringNext + i) % _texRing.Count;
        IntPtr t = _texRing[k];
        if (t == _curTex) continue;
        Marshal.AddRef(t);
        int n = Marshal.Release(t);
        if (n == 1) { _ringNext = (k + 1) % _texRing.Count; return t; }
      }
      if (_texRing.Count < 6) {
        var d = Desc(0, 0, 0, 0x20 | 0x8, 0);
        IntPtr t;
        V.Hr(V.F<FnCreateTex>(_dev, 5)(_dev, ref d, IntPtr.Zero, out t), "an output texture could not be made");
        _texRing.Add(t);
        return t;
      }
      for (int i = 0; i < _texRing.Count; i++) {
        int k = (_ringNext + i) % _texRing.Count;
        if (_texRing[k] != _curTex) { _ringNext = (k + 1) % _texRing.Count; return _texRing[k]; }
      }
      return _texRing[0];
    }

    void Clear(IntPtr tex) {
      IntPtr rtv;
      if (V.F<FnCreateRtv>(_dev, 9)(_dev, tex, IntPtr.Zero, out rtv) < 0) return;
      try { V.F<FnClearRtv>(_ctx, 50)(_ctx, rtv, new float[] { 0, 0, 0, 1 }); } finally { Marshal.Release(rtv); }
    }

    /* ---- frames out ---- */
    long T(long idx) { return idx * 10000000L / _fps; }

    void WriteVideo(long idx) {
      IntPtr buf = IntPtr.Zero, smp = IntPtr.Zero;
      try {
        if (_hw) {
          V.Hr(RecNative.MFCreateDXGISurfaceBuffer(ref MFG.IID_Tex2D, _curTex, 0, false, out buf), "a GPU frame could not be wrapped");
          IntPtr b2;
          if (Marshal.QueryInterface(buf, ref MFG.IID_2DBuffer, out b2) >= 0) {
            uint len;
            if (V.F<FnoU>(b2, 7)(b2, out len) >= 0) V.F<FnU>(buf, 6)(buf, len);
            Marshal.Release(b2);
          }
        } else {
          buf = _curBuf;
          Marshal.AddRef(buf);
        }
        V.Hr(RecNative.MFCreateSample(out smp), "a frame could not be made");
        V.Hr(V.F<FnP>(smp, 42)(smp, buf), "a frame could not take its picture");
        long t = T(idx);
        V.F<FnL>(smp, 36)(smp, t);
        V.F<FnL>(smp, 38)(smp, T(idx + 1) - t);
        int hr;
        long w0 = V.Now100();
        lock (_wgate) hr = V.F<FnUP>(_writer, 6)(_writer, _vStream, smp);
        _tSample += V.Now100() - w0;
        if (hr < 0 && _frames == 0 && _hw) {
          // The GPU route built but refused its first frame: the software route takes over from frame 0.
          V.Rel(ref smp); V.Rel(ref buf);
          string first = V.Code(hr);
          V.Rel(ref _writer);
          _encWhy = "the GPU encoder refused the first frame (" + first + ")";
          string sw = MakeWriter(false);
          if (sw != null) throw new RecError("the GPU encoder refused the first frame (" + first + ") and the software one could not start (" + sw + ")");
          // the picture already on the GPU becomes the software route's first frame (a still screen sends no new one)
          var all = new RecBox();
          all.Right = (uint)_outW; all.Bottom = (uint)_outH; all.Back = 1;
          Stage(_curTex, all, _outW, _outH);
          _curTex = IntPtr.Zero;
          Recorder.Emit(Json.Obj("ev", "log", "text", "software encoder: " + _encWhy));
          WriteVideo(idx);
          return;
        }
        V.Hr(hr, "a frame could not be written");
        _frames++;
        if (!_freshSinceWrite) _dup++;
        _freshSinceWrite = false;
      } finally { V.Rel(ref smp); V.Rel(ref buf); }
    }

    void EmitLoop() {
      while (_emitRun) {
        Thread.Sleep(20);
        try { WriteAudio(NowFrames() - RecMix.Rate / 10); } catch (Exception ex) { Recorder.Emit(Json.Obj("ev", "log", "text", "sound: " + V.Why(ex))); }
      }
    }
    long NowFrames() { return (V.Now100() - Start100) * RecMix.Rate / 10000000L; }

    void WriteAudio(long upTo) {
      while (true) {
        long from; int frames;
        byte[] pcm = Mix.Take(upTo, RecMix.Rate / 10, out from, out frames);
        if (pcm == null) return;
        IntPtr buf = IntPtr.Zero, smp = IntPtr.Zero;
        try {
          V.Hr(RecNative.MFCreateMemoryBuffer((uint)pcm.Length, out buf), "a sound buffer could not be made");
          IntPtr p; uint max, cur;
          V.Hr(V.F<FnLock>(buf, 3)(buf, out p, out max, out cur), "a sound buffer could not be locked");
          Marshal.Copy(pcm, 0, p, pcm.Length);
          V.F<FnV>(buf, 4)(buf);
          V.F<FnU>(buf, 6)(buf, (uint)pcm.Length);
          V.Hr(RecNative.MFCreateSample(out smp), "a sound sample could not be made");
          V.F<FnP>(smp, 42)(smp, buf);
          long t = from * 10000000L / RecMix.Rate;
          V.F<FnL>(smp, 36)(smp, t);
          V.F<FnL>(smp, 38)(smp, (from + frames) * 10000000L / RecMix.Rate - t);
          int hr;
          lock (_wgate) hr = V.F<FnUP>(_writer, 6)(_writer, _aStream, smp);
          V.Hr(hr, "sound could not be written");
          _audioSamples++;
        } finally { V.Rel(ref smp); V.Rel(ref buf); }
        if (from + frames >= upTo) return;
      }
    }

    /* ---- the loop ---- */
    void Loop() {
      long next = 0, lastTick = 0, lastCheck = 0;
      while (!_stop) {
        long el = V.Now100() - Start100;
        long idx = el * _fps / 10000000L;
        if (idx < next) {
          long wait = (T(next) - el) / 10000;
          Thread.Sleep((int)Math.Max(1, Math.Min(20, wait)));
          continue;
        }
        long a0 = V.Now100();
        Poll();
        long a1 = V.Now100();
        _tPoll += a1 - a0;
        if (_curTex != IntPtr.Zero || _curBuf != IntPtr.Zero) {
          if (idx > next) _late += idx - next;
          WriteVideo(idx);
          _tWrite += V.Now100() - a1;
        }
        next = idx + 1;
        _endIdx = next;
        if (el - lastCheck >= 2500000L) { lastCheck = el; Checks(el); }
        if (el - lastTick >= 10000000L) {
          lastTick = el;
          long bytes = 0;
          try { bytes = new FileInfo(_part).Length; } catch (Exception) { }
          Recorder.Emit(Json.Obj("ev", "tick", "secs", Math.Round(el / 1e7, 1), "frames", _frames, "late", _late, "dup", _dup, "bytes", bytes,
            "freeMb", FreeMb(Path.GetDirectoryName(_outPath))));
        }
      }
    }
    long _endIdx;
    long _tPoll, _tWrite, _tSample;
    int _texCount;
    double Per(long t100) { return _frames > 0 ? Math.Round(t100 / 10000.0 / _frames, 3) : 0; }

    void Checks(long el) {
      if (_mode == "window" && !RecNative.IsWindow(_hwnd)) { RequestStop("the window closed"); return; }
      if (_mode == "monitor") {
        var c = new RecPoint(); c.X = (_monRect.Left + _monRect.Right) / 2; c.Y = (_monRect.Top + _monRect.Bottom) / 2;
        if (RecNative.MonitorFromPoint(c, 0) != _hmon) { RequestStop("the screen was disconnected"); return; }
      }
      long free = FreeMb(Path.GetDirectoryName(_outPath));
      if (free >= 0 && free < _minFreeMb) { RequestStop("the disk is almost full (" + Gb(free) + " left)"); return; }
      if (el >= _maxSecs * 10000000L) { RequestStop("it reached the " + (_maxSecs >= 3600 ? (_maxSecs / 3600) + "-hour" : _maxSecs + "-second") + " limit"); return; }
      if (_testSecs > 0 && el >= _testSecs * 10000000L) RequestStop("the test's time was up");
    }

    /* ---- finishing ---- */
    int Finish(string loopWhy) {
      long tStop = V.Now100();
      try { if (_session != null) _session.Dispose(); } catch (Exception) { }
      try { if (_pool != null) _pool.Dispose(); } catch (Exception) { }
      _session = null; _pool = null;
      long endT = T(_endIdx);
      if (_hasAudio) {
        _emitRun = false;
        if (_emitter != null) _emitter.Join(1000);
        long endFrame = endT * RecMix.Rate / 10000000L;
        // the last packets for the final moment arrive a little late: wait for them (at most 400 ms)
        long until = tStop + 4000000L;
        while (NowFrames() < endFrame + RecMix.Rate / 6 && V.Now100() < until) Thread.Sleep(10);
        foreach (var s in _sources) s.Stop();
        try { WriteAudio(endFrame); } catch (Exception ex) { Recorder.Emit(Json.Obj("ev", "log", "text", "the last sound: " + V.Why(ex))); }
      }
      long fin0 = V.Now100();
      string finWhy = null;
      if (_writer != null) {
        int hr;
        lock (_wgate) hr = _frames > 0 ? V.F<FnV>(_writer, 11)(_writer) : -1;
        if (hr < 0) finWhy = _frames > 0 ? "the file could not be finished (" + V.Code(hr) + ")" : "no frame was recorded";
      }
      long finMs = (V.Now100() - fin0) / 10000;
      var srcs = new List<object>();
      foreach (var s in _sources)
        srcs.Add(Json.Obj("name", s.Name, "why", s.Why, "format", s.Format, "packets", s.Packets, "frames", s.Frames, "silent", s.SilentPackets, "late", s.LateFrames));
      _texCount = _texRing.Count;
      Teardown();
      string why = loopWhy != null ? "error: " + loopWhy : (_stopWhy ?? "stop");
      if (finWhy != null) {
        TryDelete(_part);
        Recorder.Emit(Json.Obj("ev", "error", "error", finWhy + (loopWhy != null ? " after " + loopWhy : ""), "why", why));
        return 4;
      }
      string final = Unique(_outPath);
      try { File.Move(_part, final); }
      catch (Exception ex) {
        Recorder.Emit(Json.Obj("ev", "error", "error", "the recording was made but could not be named " + Path.GetFileName(final) + " (" + ex.Message + "); it is at " + _part, "path", _part, "why", why));
        return 5;
      }
      long bytes = 0;
      try { bytes = new FileInfo(final).Length; } catch (Exception) { }
      Recorder.Emit(Json.Obj("ev", "done", "path", final, "name", Path.GetFileName(final), "secs", Math.Round(endT / 1e7, 2),
        "frames", _frames, "late", _late, "dup", _dup, "fresh", _fresh, "bytes", bytes, "w", _outW, "h", _outH, "fps", _fps,
        "why", why, "audio", srcs, "audioSamples", _audioSamples, "textures", _texCount, "finalizeMs", finMs,
        "perFrameMs", Json.Obj("poll", Per(_tPoll), "write", Per(_tWrite), "writeSample", Per(_tSample)),
        "encoder", Json.Obj("name", _encName, "hardware", _encHardware, "route", _hw ? "gpu" : "software", "why", _encWhy)));
      return 0;
    }

    static string Unique(string p) {
      if (!File.Exists(p)) return p;
      string dir = Path.GetDirectoryName(p), name = Path.GetFileNameWithoutExtension(p), ext = Path.GetExtension(p);
      for (int i = 2; i < 1000; i++) {
        string q = Path.Combine(dir, name + " (" + i.ToString(CultureInfo.InvariantCulture) + ")" + ext);
        if (!File.Exists(q)) return q;
      }
      return Path.Combine(dir, name + " " + Guid.NewGuid().ToString("N").Substring(0, 8) + ext);
    }

    void Teardown() {
      foreach (var s in _sources) { try { s.Stop(); } catch (Exception) { } }
      try { if (_session != null) _session.Dispose(); } catch (Exception) { }
      try { if (_pool != null) _pool.Dispose(); } catch (Exception) { }
      _session = null; _pool = null;
      V.Rel(ref _writer);
      V.Rel(ref _curBuf);
      foreach (IntPtr t in _texRing) { IntPtr x = t; V.Rel(ref x); }
      _texRing.Clear();
      _curTex = IntPtr.Zero;
      V.Rel(ref _staging);
      V.Rel(ref _mgr);
      try { if (_item != null) Marshal.ReleaseComObject(_item); } catch (Exception) { }
      try { if (_wdev != null) Marshal.ReleaseComObject(_wdev); } catch (Exception) { }
      _item = null; _wdev = null;
      V.Rel(ref _ctx);
      V.Rel(ref _dev);
      try { RecNative.MFShutdown(); } catch (Exception) { }
    }
  }

  /* ---- reading an MP4 back (the tests' check that the file plays) --------------------------------- */
  static class RecProbe {
    const uint FirstVideo = 0xFFFFFFFC, FirstAudio = 0xFFFFFFFD, MediaSource = 0xFFFFFFFF;

    public static int Run(string file, string[] args) {
      IntPtr attrs = IntPtr.Zero, reader = IntPtr.Zero, nt = IntPtr.Zero, at = IntPtr.Zero, outT = IntPtr.Zero, cur = IntPtr.Zero;
      try {
        V.Hr(RecNative.MFStartup(0x00020070, 0), "Media Foundation would not start");
        V.Hr(RecNative.MFCreateAttributes(out attrs, 1), "attributes");
        MFG.U32(attrs, MFG.VideoProcessing, 1, "video processing");
        V.Hr(RecNative.MFCreateSourceReaderFromURL(file, attrs, out reader), "the file could not be opened");
        var res = new System.Collections.Specialized.OrderedDictionary();
        res["ev"] = "probe"; res["ok"] = true;
        IntPtr pv = Marshal.AllocHGlobal(24);
        try {
          for (int i = 0; i < 24; i++) Marshal.WriteByte(pv, i, 0);
          Guid k = MFG.PdDuration;
          if (V.F<FnPresAttr>(reader, 12)(reader, MediaSource, ref k, pv) >= 0) res["durationSec"] = Math.Round(Marshal.ReadInt64(pv, 8) / 1e7, 3);
          RecNative.PropVariantClear(pv);
        } finally { Marshal.FreeHGlobal(pv); }
        V.Hr(V.F<FnUUoP>(reader, 5)(reader, FirstVideo, 0, out nt), "the file has no video");
        Guid sub; ulong fs, fr;
        if (MFG.TryGuid(nt, MFG.Subtype, out sub)) res["video"] = sub == MFG.H264 ? "H.264" : sub.ToString();
        if (MFG.TryU64(nt, MFG.FrameSize, out fs)) { res["w"] = (long)(fs >> 32); res["h"] = (long)(fs & 0xFFFFFFFF); }
        if (MFG.TryU64(nt, MFG.FrameRate, out fr) && (fr & 0xFFFFFFFF) != 0) res["fps"] = Math.Round((double)(fr >> 32) / (fr & 0xFFFFFFFF), 3);
        bool audio = V.F<FnUUoP>(reader, 5)(reader, FirstAudio, 0, out at) >= 0;
        res["audio"] = audio;
        if (audio) {
          Guid asub; uint rate, ch;
          if (MFG.TryGuid(at, MFG.Subtype, out asub)) res["audioFormat"] = asub == MFG.AAC ? "AAC" : asub.ToString();
          if (MFG.TryU32(at, MFG.AudioRate, out rate)) res["audioRate"] = (long)rate;
          if (MFG.TryU32(at, MFG.AudioChannels, out ch)) res["audioChannels"] = (long)ch;
        }
        outT = NewType();
        MFG.G(outT, MFG.MajorType, MFG.Video, "video"); MFG.G(outT, MFG.Subtype, MFG.RGB32, "RGB32");
        V.Hr(V.F<FnUPP>(reader, 7)(reader, FirstVideo, IntPtr.Zero, outT), "the video could not be decoded to RGB");
        if (V.F<FnUoP>(reader, 6)(reader, FirstVideo, out cur) >= 0) {
          ulong cs; uint stride;
          if (MFG.TryU64(cur, MFG.FrameSize, out cs)) { res["decodedW"] = (long)(cs >> 32); res["decodedH"] = (long)(cs & 0xFFFFFFFF); }
          if (MFG.TryU32(cur, MFG.DefaultStride, out stride)) res["decodedStride"] = (long)unchecked((int)stride);
        }
        V.F<FnUB>(reader, 4)(reader, FirstAudio, audio ? 1 : 0);
        double atFrac = 0.5;
        string a2 = Recorder.Arg(args, "--at");
        if (a2 != null) double.TryParse(a2, NumberStyles.Float, CultureInfo.InvariantCulture, out atFrac);
        double dur = res.Contains("durationSec") ? (double)res["durationSec"] : 0;
        long targetTs = (long)(dur * atFrac * 1e7);
        int w = res.Contains("decodedW") ? (int)(long)res["decodedW"] : (res.Contains("w") ? (int)(long)res["w"] : 0);
        int h = res.Contains("decodedH") ? (int)(long)res["decodedH"] : (res.Contains("h") ? (int)(long)res["h"] : 0);
        string pts = Recorder.Arg(args, "--points") ?? "0.25,0.25;0.75,0.25;0.25,0.75;0.75,0.75";
        long frames = 0, audioSamples = 0, lastTs = -1, firstTs = -1, gaps = 0;
        long lastAudioEnd = 0;
        bool picked = false;
        var pixels = new List<object>();
        // which stream index is the video (the reader's ANY_STREAM reads say only the index)
        int videoIdx = -1;
        for (uint si = 0; si < 8; si++) {
          IntPtr ty;
          if (V.F<FnUoP>(reader, 6)(reader, si, out ty) < 0) break;
          if (IsVideo(ty) && videoIdx < 0) videoIdx = (int)si;
          Marshal.Release(ty);
        }
        var ended = new HashSet<uint>();
        int want = audio ? 2 : 1;
        for (int guard = 0; guard < 2000000; guard++) {
          uint actual, flags; long ts; IntPtr smp;
          int hr = V.F<FnRead>(reader, 9)(reader, 0xFFFFFFFE, 0, out actual, out flags, out ts, out smp);
          if (hr < 0) { res["readError"] = V.Code(hr); break; }
          if ((flags & 2) != 0) ended.Add(actual);
          if (smp != IntPtr.Zero) {
            try {
              bool isVideo = (int)actual == videoIdx;
              if (isVideo) {
                if (firstTs < 0) firstTs = ts;
                if (lastTs >= 0 && ts - lastTs > 2 * 10000000L / Math.Max(1, (res.Contains("fps") ? (int)Math.Round((double)res["fps"]) : 30))) gaps++;
                lastTs = ts;
                frames++;
                if (!picked && ts >= targetTs) { picked = true; res["pickedTs"] = Math.Round(ts / 1e7, 3); ReadPixels(smp, w, h, res.Contains("decodedStride") ? (int)(long)res["decodedStride"] : w * 4, pts, pixels); }
              } else {
                audioSamples++;
                long d;
                if (V.F<FnoL>(smp, 37)(smp, out d) >= 0) lastAudioEnd = ts + d;
              }
            } finally { Marshal.Release(smp); }
          }
          if (ended.Count >= want) break;
          if ((flags & 1) != 0) { res["readError"] = "the reader reported a stream error"; break; }
        }
        res["frames"] = frames;
        res["firstTs"] = firstTs >= 0 ? Math.Round(firstTs / 1e7, 3) : -1;
        res["lastTs"] = lastTs >= 0 ? Math.Round(lastTs / 1e7, 3) : -1;
        res["gaps"] = gaps;
        if (audio) { res["audioSamples"] = audioSamples; res["audioEndSec"] = Math.Round(lastAudioEnd / 1e7, 3); }
        res["pixels"] = pixels;
        Recorder.Emit(res);
        return 0;
      } catch (Exception ex) {
        Recorder.Emit(Json.Obj("ev", "probe", "ok", false, "error", V.Why(ex)));
        return 1;
      } finally {
        V.Rel(ref cur); V.Rel(ref outT); V.Rel(ref at); V.Rel(ref nt); V.Rel(ref reader); V.Rel(ref attrs);
        try { RecNative.MFShutdown(); } catch (Exception) { }
      }
    }

    static bool IsVideo(IntPtr type) { Guid m; return MFG.TryGuid(type, MFG.MajorType, out m) && m == MFG.Video; }

    static IntPtr NewType() { IntPtr t; V.Hr(RecNative.MFCreateMediaType(out t), "a media type"); return t; }

    static void ReadPixels(IntPtr smp, int w, int h, int stride, string pts, List<object> outList) {
      IntPtr buf;
      if (V.F<FnUoP>(smp, 40)(smp, 0, out buf) < 0) return;
      try {
        IntPtr b2;
        IntPtr scan0 = IntPtr.Zero; int pitch = stride;
        bool twoD = Marshal.QueryInterface(buf, ref MFG.IID_2DBuffer, out b2) >= 0;
        IntPtr p = IntPtr.Zero; uint max, cur;
        if (twoD) {
          if (V.F<FnLock2D>(b2, 3)(b2, out scan0, out pitch) < 0) { Marshal.Release(b2); twoD = false; }
        }
        if (!twoD) { if (V.F<FnLock>(buf, 3)(buf, out p, out max, out cur) < 0) return; scan0 = pitch < 0 ? new IntPtr(p.ToInt64() + (long)(h - 1) * -pitch) : p; }
        try {
          foreach (string pair in pts.Split(';')) {
            string[] xy = pair.Split(',');
            double fx, fy;
            if (xy.Length != 2 || !double.TryParse(xy[0], NumberStyles.Float, CultureInfo.InvariantCulture, out fx) || !double.TryParse(xy[1], NumberStyles.Float, CultureInfo.InvariantCulture, out fy)) continue;
            int x = Math.Max(0, Math.Min(w - 1, (int)(fx * w))), y = Math.Max(0, Math.Min(h - 1, (int)(fy * h)));
            long off = (long)y * pitch + (long)x * 4;
            IntPtr q = new IntPtr(scan0.ToInt64() + off);
            int bgra = Marshal.ReadInt32(q);
            outList.Add(Json.Obj("x", x, "y", y, "r", (bgra >> 16) & 0xFF, "g", (bgra >> 8) & 0xFF, "b", bgra & 0xFF));
          }
        } finally {
          if (twoD) { V.F<FnV>(b2, 4)(b2); Marshal.Release(b2); } else V.F<FnV>(buf, 4)(buf);
        }
      } finally { Marshal.Release(buf); }
    }
  }
#endif
}

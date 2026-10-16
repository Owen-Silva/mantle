// ClipsEncode.cs - the Clips gallery's RE-ENCODE trim, for the clips the lossless cut refuses
// (lane mantle-clips2, 2026-10-15).
//
// Mantle trims a clip WITHOUT re-encoding first (lib/features/_clips-mp4.js: a keyframe cut, pure
// JS, seconds for any length). Some files it cannot cut that way: a fragmented movie (a live-stream
// layout), a track without the tables a sample-exact cut needs, an index too big to hold. For those
// the clip is re-encoded by WINDOWS' OWN media stack (Windows.Media.Editing over Media Foundation,
// the same H.264/AAC encoders Game Bar records with; no ffmpeg on this PC, nothing downloaded):
//
//   clips.reencode {src, dst, startMs, endMs, job}
//       -> {job, started: true} at once; the encode runs on its own thread and ends with ONE event
//          {ev: "clips.encoded", job, ok, why?, ms, bytes, durationMs}, with
//          {ev: "clips.encoding", job, pct} at most every 250 ms while it runs.
//       Precise trim (frame-exact, MediaTrimmingPreference.Precise), the source's own size, frame
//       rate and bitrate (MediaEncodingProfile.CreateFromFileAsync). NEVER OVERWRITES: dst must not
//       exist; the encode writes "<dst>.part" and is moved to dst only when complete; a failure
//       deletes the part file. src must be an .mp4 that exists.
//   clips.synth {dst, ms, w?, h?}
//       a REAL H.264 MP4 of one plain colour (MediaClip.CreateFromColor), for the tests: a movie
//       from Windows' own encoder, so the lossless cut and the re-encode are proved on real
//       encoder output with nothing of Owen's. dst must be under %TEMP% and must not exist.
//
// PASSIVE (--test): both work, but ONLY on paths under %TEMP% (a test never writes in Captures).
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Threading;
#if MANTLE_WINMD
using Windows.Foundation;
using Windows.Media.Editing;
using Windows.Media.MediaProperties;
using Windows.Media.Transcoding;
using Windows.Storage;
#endif

namespace Mantle {
  [MantleFeature]
  static class ClipsEncode {
    public static void Register(FeatureTable t) {
      t.Add("clips.reencode", Lanes.Slow, Reencode);
      t.Add("clips.synth", Lanes.Slow, Synth);
    }

    static readonly object Gate = new object();
    static int Running;                        // encodes at once: one (an encode is a whole CPU's work)

    static bool UnderTemp(string p) {
      try {
        string tmp = Path.GetFullPath(Path.GetTempPath()).TrimEnd('\\') + "\\";
        return Path.GetFullPath(p).StartsWith(tmp, StringComparison.OrdinalIgnoreCase);
      } catch (Exception) { return false; }
    }
    static string Why(Exception ex) {
      if (ex == null) return "no reason given";
      string m = (ex.Message ?? "").Trim();
      return (m.Length > 0 ? m : ex.GetType().Name) + " (0x" + ex.HResult.ToString("X8") + ")";
    }

    static string Reencode(Dictionary<string, object> req, ref object result) {
      string src = Json.GetString(req, "src"), dst = Json.GetString(req, "dst"), job = Json.GetString(req, "job") ?? "";
      int a = Json.GetInt(req, "startMs", 0), b = Json.GetInt(req, "endMs", 0);
      if (string.IsNullOrEmpty(src) || !Path.IsPathRooted(src)) return "clips.reencode needs the full path of the clip (src)";
      if (string.IsNullOrEmpty(dst) || !Path.IsPathRooted(dst)) return "clips.reencode needs the full path of the new file (dst)";
      if (!src.EndsWith(".mp4", StringComparison.OrdinalIgnoreCase) || !dst.EndsWith(".mp4", StringComparison.OrdinalIgnoreCase)) return "only an .mp4 clip can be re-encoded here";
      if (Program.Passive && (!UnderTemp(src) || !UnderTemp(dst))) return FeatureTable.PassiveRefusal + " (a test re-encodes only under %TEMP%)";
      if (!File.Exists(src)) return "the clip is not there any more";
      if (File.Exists(dst) || File.Exists(dst + ".part")) return "a file with the new name is already there; nothing was overwritten";
      if (a < 0 || b <= a) return "the part asked for is empty (its end is not after its start)";
#if MANTLE_WINMD
      lock (Gate) {
        if (Running > 0) return "another clip is being re-encoded; try again when it is done";
        Running++;
      }
      var th = new Thread(() => {
        var sw = Stopwatch.StartNew();
        string why = null; long bytes = 0; double durMs = 0;
        try { why = Encode(src, dst, a, b, job, out bytes, out durMs); }
        catch (Exception ex) { why = "the re-encode failed (" + Why(ex) + ")"; }
        finally { lock (Gate) { Running--; } }
        if (why != null) { try { File.Delete(dst + ".part"); } catch (Exception) { } }
        Program.Emit(Json.Obj("ev", "clips.encoded", "job", job, "ok", why == null, "why", why, "ms", (long)sw.Elapsed.TotalMilliseconds,
          "bytes", bytes, "durationMs", (long)durMs));
      });
      th.IsBackground = true;
      th.Priority = ThreadPriority.BelowNormal;
      th.Start();
      result = Json.Obj("job", job, "started", true);
      return null;
#else
      return "this sidecar was built without Windows' media metadata (MANTLE_WINMD), so it cannot re-encode";
#endif
    }

    static string Synth(Dictionary<string, object> req, ref object result) {
      string dst = Json.GetString(req, "dst");
      int ms = Json.GetInt(req, "ms", 3000), w = Json.GetInt(req, "w", 640), h = Json.GetInt(req, "h", 360);
      if (string.IsNullOrEmpty(dst) || !Path.IsPathRooted(dst) || !dst.EndsWith(".mp4", StringComparison.OrdinalIgnoreCase)) return "clips.synth needs the full path of a new .mp4 (dst)";
      if (!UnderTemp(dst)) return "clips.synth writes only under %TEMP%";
      if (File.Exists(dst)) return "a file with that name is already there; nothing was overwritten";
      if (ms < 200 || ms > 120000) return "clips.synth makes 0.2 to 120 s";
#if MANTLE_WINMD
      var sw = Stopwatch.StartNew();
      try {
        var comp = new MediaComposition();
        // two colours, so the movie has more than one picture in it
        comp.Clips.Add(MediaClip.CreateFromColor(Windows.UI.Color.FromArgb(255, 70, 110, 160), TimeSpan.FromMilliseconds(ms / 2)));
        comp.Clips.Add(MediaClip.CreateFromColor(Windows.UI.Color.FromArgb(255, 200, 150, 90), TimeSpan.FromMilliseconds(ms - ms / 2)));
        StorageFolder folder; StorageFile file;
        string err = WinRt.Await(StorageFolder.GetFolderFromPathAsync(Path.GetDirectoryName(dst)), 8000, "opening the folder", out folder);
        if (err != null) return err;
        err = WinRt.Await(folder.CreateFileAsync(Path.GetFileName(dst), CreationCollisionOption.FailIfExists), 8000, "making the file", out file);
        if (err != null) return err;
        var prof = MediaEncodingProfile.CreateMp4(VideoEncodingQuality.Vga);
        prof.Video.Width = (uint)Math.Max(64, w); prof.Video.Height = (uint)Math.Max(64, h);
        prof.Audio = null;
        TranscodeFailureReason fr;
        err = AwaitRender(comp.RenderToFileAsync(file, MediaTrimmingPreference.Precise, prof), 60000, "rendering the stand-in movie", null, out fr);
        if (err == null && fr != TranscodeFailureReason.None) err = "Windows could not render it (" + fr + ")";
        if (err != null) { try { File.Delete(dst); } catch (Exception) { } return err; }
        result = Json.Obj("path", dst, "bytes", new FileInfo(dst).Length, "ms", (long)sw.Elapsed.TotalMilliseconds);
        return null;
      } catch (Exception ex) {
        try { if (File.Exists(dst) && new FileInfo(dst).Length == 0) File.Delete(dst); } catch (Exception) { }
        return "clips.synth failed (" + Why(ex) + ")";
      }
#else
      return "this sidecar was built without Windows' media metadata (MANTLE_WINMD)";
#endif
    }

#if MANTLE_WINMD
    static string Encode(string src, string dst, int startMs, int endMs, string job, out long bytes, out double durMs) {
      bytes = 0; durMs = 0;
      StorageFile inFile;
      string err = WinRt.Await(StorageFile.GetFileFromPathAsync(src), 8000, "opening the clip", out inFile);
      if (err != null) return err;
      MediaClip clip;
      err = WinRt.Await(MediaClip.CreateFromFileAsync(inFile), 20000, "reading the clip", out clip);
      if (err != null) return err;
      TimeSpan whole = clip.OriginalDuration;
      if (whole.TotalMilliseconds <= 0) return "Windows read no length for the clip";
      double a = Math.Max(0, Math.Min(startMs, whole.TotalMilliseconds));
      double b = Math.Max(a, Math.Min(endMs, whole.TotalMilliseconds));
      if (b - a < 100) return "the part asked for is shorter than 0.1 s";
      clip.TrimTimeFromStart = TimeSpan.FromMilliseconds(a);
      clip.TrimTimeFromEnd = whole - TimeSpan.FromMilliseconds(b);
      var comp = new MediaComposition();
      comp.Clips.Add(clip);

      // the source's own size, frame rate and bitrate; Windows' default profile otherwise
      MediaEncodingProfile prof = null;
      string perr = WinRt.Await(MediaEncodingProfile.CreateFromFileAsync(inFile), 10000, "reading the clip's format", out prof);
      if (perr != null || prof == null || prof.Video == null) prof = MediaEncodingProfile.CreateMp4(VideoEncodingQuality.HD1080p);
      if (prof.Video != null && prof.Video.Subtype != "H264") prof.Video.Subtype = "H264";

      string dir = Path.GetDirectoryName(dst), part = Path.GetFileName(dst) + ".part";
      StorageFolder folder; StorageFile outFile;
      err = WinRt.Await(StorageFolder.GetFolderFromPathAsync(dir), 8000, "opening the folder", out folder);
      if (err != null) return err;
      err = WinRt.Await(folder.CreateFileAsync(part, CreationCollisionOption.FailIfExists), 8000, "making the new file", out outFile);
      if (err != null) return err;

      long last = 0;
      var tick = Stopwatch.StartNew();
      TranscodeFailureReason fr;
      // the longest an encode may take: 4x the part's length plus a minute (measured ~0.3-0.6x on this PC)
      int limit = (int)Math.Min(int.MaxValue - 1, 60000 + 4 * (b - a));
      err = AwaitRender(comp.RenderToFileAsync(outFile, MediaTrimmingPreference.Precise, prof), limit, "re-encoding the clip", (pct) => {
        long now = tick.ElapsedMilliseconds;
        if (now - last < 250) return;
        last = now;
        Program.Emit(Json.Obj("ev", "clips.encoding", "job", job, "pct", Math.Round(pct, 1)));
      }, out fr);
      if (err == null && fr != TranscodeFailureReason.None) err = "Windows could not re-encode it (" + fr + ")";
      if (err != null) return err;
      string partPath = Path.Combine(dir, part);
      if (File.Exists(dst)) return "a file with the new name appeared while encoding; nothing was overwritten";
      File.Move(partPath, dst);
      bytes = new FileInfo(dst).Length;
      durMs = b - a;
      return null;
    }

    /// RenderToFileAsync is an IAsyncOperationWithProgress, which WinRt.Await (Media.cs) does not
    /// take: the same pattern, its own Completed callback and a timeout, plus the progress callback.
    static string AwaitRender(IAsyncOperationWithProgress<TranscodeFailureReason, double> op, int timeoutMs, string what, Action<double> progress, out TranscodeFailureReason value) {
      value = TranscodeFailureReason.Unknown;
      if (op == null) return what + " did not start";
      var done = new ManualResetEvent(false);
      AsyncStatus status = AsyncStatus.Started;
      try {
        if (progress != null) op.Progress = delegate (IAsyncOperationWithProgress<TranscodeFailureReason, double> o, double p) { try { progress(p); } catch (Exception) { } };
        op.Completed = delegate (IAsyncOperationWithProgress<TranscodeFailureReason, double> o, AsyncStatus s) { status = s; done.Set(); };
      } catch (Exception ex) { return what + " could not be awaited (" + Why(ex) + ")"; }
      if (!done.WaitOne(timeoutMs)) {
        try { op.Cancel(); } catch (Exception) { }
        return what + " did not finish within " + (timeoutMs / 1000) + " s";
      }
      done.Close();
      try {
        if (status == AsyncStatus.Completed) { value = op.GetResults(); return null; }
        if (status == AsyncStatus.Canceled) return what + " was cancelled";
        Exception e = null;
        try { e = op.ErrorCode; } catch (Exception) { }
        return what + " failed" + (e != null ? " (" + Why(e) + ")" : "");
      } catch (Exception ex) { return what + " failed (" + Why(ex) + ")"; }
    }
#endif
  }
}

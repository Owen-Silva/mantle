// SysPersoLock.cs - Settings > Personalization > Lock screen: the lock screen PICTURE (lane perso,
// 2026-09-29). Spotlight and "fun facts" are plain HKCU values (SysPerso.cs perso.set).
//
// WHY WinRT: Windows keeps the lock screen picture in a protected per-user store; the only supported
// way for another program to read or set it is Windows.System.UserProfile.LockScreen
// (OriginalImageFile, SetImageFileAsync). That needs the in-process WinRT route build.ps1 turns on
// with MANTLE_WINMD (the split winmds in System32\WinMetadata); without it both commands answer
// read-only with that reason.
//
//   perso.lock                         {picture, pictureWhy, canSet}
//   perso.lockPicture {path, dryRun?}  show that picture on the lock screen (turns Windows spotlight
//                                      off, as picking a picture in Windows' Settings does)
//
// PRIVACY: nothing here logs; the picture's path reaches the page only in replies.
using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Threading;
#if MANTLE_WINMD
using Windows.Foundation;
using Windows.Storage;
using Windows.System.UserProfile;
#endif

namespace Mantle {
  [MantleFeature]
  static class SysPersoLock {
    public static void Register(FeatureTable t) {
      t.Add("perso.lock", Lanes.Slow, Lock);
      t.Add("perso.lockPicture", Lanes.Slow, SetPicture);
    }

    static readonly string[] Ext = { ".jpg", ".jpeg", ".jfif", ".png", ".bmp" };
    const string NoWinRt = "Windows sets the lock screen picture only through its WinRT LockScreen API, and this Mantle build was made without the WinRT route (build.ps1 found no WinMetadata)";

    static string Lock(Dictionary<string, object> req, ref object result) {
#if MANTLE_WINMD
      string pic = null, why = null;
      try {
        Uri u = LockScreen.OriginalImageFile;
        if (u != null) pic = u.IsFile ? u.LocalPath : u.ToString();
        else why = "Windows did not say which picture is on the lock screen";
      } catch (Exception ex) { why = "Windows did not say which picture is on the lock screen (" + SysCommon.Why(ex) + ")"; }
      result = Json.Obj("ok", true, "picture", pic, "pictureExists", pic != null && File.Exists(pic), "pictureWhy", why, "canSet", true);
#else
      result = Json.Obj("ok", true, "picture", null, "pictureExists", false, "pictureWhy", NoWinRt, "canSet", false);
#endif
      return null;
    }

    static string SetPicture(Dictionary<string, object> req, ref object result) {
      string p = Json.GetString(req, "path");
      bool dry = Json.GetBool(req, "dryRun", false);
      if (string.IsNullOrEmpty(p) || !Path.IsPathRooted(p)) return "perso.lockPicture needs path: the full path to a picture";
      if (Array.IndexOf(Ext, Path.GetExtension(p).ToLowerInvariant()) < 0) return "the lock screen can show a .jpg, .png or .bmp picture";
      if (!File.Exists(p)) return "that picture file does not exist (or Mantle may not read it)";
#if !MANTLE_WINMD
      return "Read only: " + NoWinRt;
#else
      string would = "show that picture on the lock screen (Windows spotlight turns off, as it does in Windows' Settings)";
      if (dry) {
        result = Json.Obj("ok", true, "dryRun", true, "would", would, "writes", SysCommon.List(Json.Obj("api", "LockScreen.SetImageFileAsync")), "reason", null);
        return null;
      }
      if (Program.Passive) return SysCommon.Passive(would);
      StorageFile file;
      string err = WinRt.Await(StorageFile.GetFileFromPathAsync(p), 8000, "opening the picture", out file);
      if (err != null) return err;
      err = AwaitAction(LockScreen.SetImageFileAsync(file), 15000, "setting the lock screen picture");
      if (err != null) return err;
      string now = null;
      try { Uri u = LockScreen.OriginalImageFile; if (u != null) now = u.IsFile ? u.LocalPath : u.ToString(); } catch (Exception) { }
      result = Json.Obj("ok", true, "dryRun", false, "now", now, "note", "The lock screen shows that picture the next time it appears");
      return null;
#endif
    }

#if MANTLE_WINMD
    /// WinRt.Await for an IAsyncAction (no result), through its own Completed callback.
    static string AwaitAction(IAsyncAction op, int timeoutMs, string what) {
      if (op == null) return what + " did not start";
      var done = new ManualResetEvent(false);
      AsyncStatus status = AsyncStatus.Started;
      try { op.Completed = delegate (IAsyncAction o, AsyncStatus s) { status = s; done.Set(); }; }
      catch (Exception ex) { return what + " could not be awaited (" + SysCommon.Why(ex) + ")"; }
      if (!done.WaitOne(timeoutMs)) { try { op.Cancel(); } catch (Exception) { } return what + " did not answer within " + (timeoutMs / 1000) + " s"; }
      done.Close();
      if (status == AsyncStatus.Completed) return null;
      if (status == AsyncStatus.Canceled) return what + " was cancelled";
      Exception e = null;
      try { e = op.ErrorCode; } catch (Exception) { }
      return what + " failed" + (e != null ? " (" + SysCommon.Why(e) + ")" : "");
    }
#endif
  }
}

// Win32.cs - every P/Invoke, constant and struct the sidecar needs, in one place.
//
// WHY one file: the sidecar exists ONLY to make Win32 calls on Electron's behalf,
// so the interop surface is the thing a future reader most needs to audit. Keeping
// it together means no hunting for a signature, and the feature files below read
// as plain logic.
//
// The process is compiled AnyCPU and therefore runs 64-bit on this machine. That
// matters in two places: GetWindowLongPtrW only exists in 64-bit user32, and the
// tray reader assumes the 64-bit TBBUTTON layout. Do not force /platform:x86.
using System;
using System.Runtime.InteropServices;
using System.Text;

namespace Mantle {
  static class Win32 {
    // ---------------------------------------------------------- window styles
    public const int GWL_STYLE = -16;
    public const int GWL_EXSTYLE = -20;
    public const int WS_CHILD = 0x40000000;
    public const int WS_VISIBLE = 0x10000000;
    public const int WS_EX_TOOLWINDOW = 0x00000080;
    public const int GW_OWNER = 4;

    // ---------------------------------------------------------------- ShowWindow
    public const int SW_HIDE = 0;
    public const int SW_SHOW = 5;
    public const int SW_MINIMIZE = 6;
    public const int SW_RESTORE = 9;

    // ------------------------------------------------------------- SetWindowPos
    public static readonly IntPtr HWND_BOTTOM = new IntPtr(1);
    public const uint SWP_NOSIZE = 0x0001;
    public const uint SWP_NOMOVE = 0x0002;
    public const uint SWP_NOACTIVATE = 0x0010;
    public const uint SWP_FRAMECHANGED = 0x0020;
    public const uint SWP_NOZORDER = 0x0004;

    // ----------------------------------------------------------------- messages
    public const uint WM_CLOSE = 0x0010;
    public const uint WM_LBUTTONDOWN = 0x0201;
    public const uint WM_LBUTTONUP = 0x0202;
    public const uint WM_RBUTTONDOWN = 0x0204;
    public const uint WM_RBUTTONUP = 0x0205;
    public const uint WM_USER = 0x0400;
    public const uint TB_BUTTONCOUNT = WM_USER + 24;
    public const uint TB_GETBUTTON = WM_USER + 23;
    public const uint TB_GETBUTTONTEXTW = WM_USER + 75;

    // --------------------------------------------------------- SystemParameters
    public const uint SPI_GETWORKAREA = 0x0030;
    public const uint SPI_SETWORKAREA = 0x002F;
    public const uint SPIF_SENDCHANGE = 0x0002;
    public const int SM_CXSCREEN = 0;
    public const int SM_CYSCREEN = 1;

    // ------------------------------------------------------------- app bars
    // SHAppBarMessage is the OS-SANCTIONED way to (a) put the Windows taskbar
    // into auto-hide and (b) reserve screen space for a bar of our own. Both
    // states are owned by Explorer, not by us, which is exactly the point: if
    // Mantle dies, Windows is still a working Windows. See Taskbar.cs for the
    // incident that made this non-negotiable.
    public const uint ABM_NEW = 0x00000000;
    public const uint ABM_REMOVE = 0x00000001;
    public const uint ABM_QUERYPOS = 0x00000002;
    public const uint ABM_SETPOS = 0x00000003;
    public const uint ABM_GETSTATE = 0x00000004;
    public const uint ABM_GETTASKBARPOS = 0x00000005;
    public const uint ABM_SETSTATE = 0x0000000A;

    /// State bits as ABM_GETSTATE returns them and ABM_SETSTATE takes them
    /// (in lParam, NOT in a field of its own).
    public const int ABS_AUTOHIDE = 0x0000001;
    public const int ABS_ALWAYSONTOP = 0x0000002;

    public const uint ABE_LEFT = 0;
    public const uint ABE_TOP = 1;
    public const uint ABE_RIGHT = 2;
    public const uint ABE_BOTTOM = 3;

    /// The message Explorer posts to an app bar (full-screen app appeared, the
    /// taskbar state changed, ...). WM_USER+0x2A5 is deliberately a value the
    /// Electron/Chromium window procedure does not interpret, so an unhandled
    /// notification is harmless: we register for the OS's sake, not to listen.
    public const uint WM_APPBAR_CALLBACK = WM_USER + 0x2A5;

    // ------------------------------------------------------------------- DPI
    // MEASURED 2026-09-21, and it cost a wrong app bar on the first live run:
    // SHAppBarMessage IS NOT DPI-VIRTUALISED. From a DPI-unaware process on
    // this 1920x1080 @ 125% machine, ABM_GETTASKBARPOS answered
    // 0,1020,1920,1080 (PHYSICAL) while GetWindowRect on Shell_TrayWnd answered
    // 0,816,1536,864 (virtualised). So a rect built from GetMonitorInfo in a
    // DPI-unaware process (1536x864) and handed to ABM_QUERYPOS/ABM_SETPOS is
    // read as physical: the bar landed 200 px too high and 80% wide, and
    // Explorer reserved that wrong strip.
    //
    // The cure is to stop being DPI-unaware at all: Program.InitDpi calls
    // SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2) as the very first
    // thing in Main, so GetMonitorInfo, SPI_GETWORKAREA and SHAppBarMessage all
    // speak the SAME physical pixels. Every rect this process reports is
    // physical, and `ping` says dpiAware:true so the caller knows.
    //
    // A DPI_AWARENESS_CONTEXT is a HANDLE, not an enum: the value really is -4.
    public static readonly IntPtr DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = new IntPtr(-4);
    public static readonly IntPtr DPI_AWARENESS_CONTEXT_SYSTEM_AWARE = new IntPtr(-2);

    public const uint MONITOR_DEFAULTTONULL = 0;
    public const uint MONITOR_DEFAULTTOPRIMARY = 1;
    public const uint MONITOR_DEFAULTTONEAREST = 2;

    /// GetAncestor(hwnd, GA_PARENT) answers "who owns this window's client
    /// area", and returns the DESKTOP window for a real top-level window -
    /// which is how we tell "reparented" from "still top-level". GetParent()
    /// alone cannot: it returns the OWNER for an owned top-level window.
    public const uint GA_PARENT = 1;
    public const uint GA_ROOT = 2;
    public const uint GA_ROOTOWNER = 3;

    // ---------------------------------------------------------------- DWM
    /// DWMWA_CLOAKED: non-zero for windows Windows is hiding from the user,
    /// e.g. UWP apps parked on another virtual desktop. They look perfectly
    /// visible to IsWindowVisible, which is why every shell has to ask DWM.
    public const int DWMWA_CLOAKED = 14;

    // ------------------------------------------------------------- WinEvents
    public const uint EVENT_SYSTEM_FOREGROUND = 0x0003;
    public const uint EVENT_SYSTEM_MINIMIZESTART = 0x0016;
    public const uint EVENT_SYSTEM_MINIMIZEEND = 0x0017;
    public const uint EVENT_OBJECT_CREATE = 0x8000;
    public const uint EVENT_OBJECT_DESTROY = 0x8001;
    public const uint EVENT_OBJECT_SHOW = 0x8002;
    public const uint EVENT_OBJECT_HIDE = 0x8003;
    public const uint EVENT_OBJECT_NAMECHANGE = 0x800C;
    public const uint WINEVENT_OUTOFCONTEXT = 0x0000;
    public const uint WINEVENT_SKIPOWNPROCESS = 0x0002;
    public const int OBJID_WINDOW = 0;

    // ----------------------------------------------------------- keyboard hook
    public const int WH_KEYBOARD_LL = 13;
    public const int HC_ACTION = 0;
    public const uint WM_KEYDOWN = 0x0100;
    public const uint WM_KEYUP = 0x0101;
    public const uint WM_SYSKEYDOWN = 0x0104;
    public const uint WM_SYSKEYUP = 0x0105;
    public const uint LLKHF_INJECTED = 0x00000010;
    public const int VK_LWIN = 0x5B;
    public const int VK_RWIN = 0x5C;
    /// VK 0xFF is "no key" / reserved. Sending it as the partner of a Win press
    /// makes Windows classify the chord as Win+<something>, so Start stays shut.
    public const int VK_DUMMY = 0xFF;
    public const uint INPUT_KEYBOARD = 1;
    public const uint KEYEVENTF_KEYUP = 0x0002;

    // ------------------------------------------------------------------ process
    public const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    public const uint PROCESS_VM_OPERATION = 0x0008;
    public const uint PROCESS_VM_READ = 0x0010;
    public const uint PROCESS_VM_WRITE = 0x0020;
    public const uint MEM_COMMIT = 0x1000;
    public const uint MEM_RESERVE = 0x2000;
    public const uint MEM_RELEASE = 0x8000;
    public const uint PAGE_READWRITE = 0x04;

    // -------------------------------------------------------------------- shell
    public const uint SHGFI_ICON = 0x000000100;
    public const uint SHGFI_LARGEICON = 0x000000000;
    public const uint SHGFI_SMALLICON = 0x000000001;
    public const uint SHGFI_USEFILEATTRIBUTES = 0x000000010;

    // ------------------------------------------------------------------ structs
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int left, top, right, bottom; }

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int x, y; }

    /// 48 bytes on x64: cbSize(4) + 4 padding + hWnd(8) + uCallbackMessage(4) +
    /// uEdge(4) + rc(16) + lParam(8). cbSize MUST be Marshal.SizeOf of this
    /// struct or SHAppBarMessage rejects the call without telling you why.
    [StructLayout(LayoutKind.Sequential)]
    public struct APPBARDATA {
      public uint cbSize;
      public IntPtr hWnd;
      public uint uCallbackMessage;
      public uint uEdge;
      public RECT rc;
      public IntPtr lParam;
    }

    /// cbSize is load-bearing here too: GetMonitorInfoW returns false if it is
    /// not set, and the rect comes back as zeroes.
    [StructLayout(LayoutKind.Sequential)]
    public struct MONITORINFO {
      public uint cbSize;
      public RECT rcMonitor;
      public RECT rcWork;
      public uint dwFlags;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct KBDLLHOOKSTRUCT {
      public uint vkCode, scanCode, flags, time;
      public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT {
      public int dx, dy;
      public uint mouseData, dwFlags, time;
      public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT {
      public ushort wVk, wScan;
      public uint dwFlags, time;
      public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Explicit)]
    public struct INPUTUNION {
      [FieldOffset(0)] public MOUSEINPUT mi;
      [FieldOffset(0)] public KEYBDINPUT ki;
    }

    /// 40 bytes on x64 (uint + 4 bytes of padding + a 32-byte union).
    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT {
      public uint type;
      public INPUTUNION u;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct SHFILEINFO {
      public IntPtr hIcon;
      public int iIcon;
      public uint dwAttributes;
      [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szDisplayName;
      [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 80)] public string szTypeName;
    }

    // ---------------------------------------------------------------- delegates
    public delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);
    public delegate void WinEventProc(IntPtr hWinEventHook, uint eventType, IntPtr hwnd,
                                      int idObject, int idChild, uint dwEventThread, uint dwmsEventTime);
    public delegate IntPtr LowLevelKeyboardProc(int nCode, IntPtr wParam, IntPtr lParam);
    public delegate bool ConsoleCtrlHandler(uint ctrlType);

    // ------------------------------------------------------------------ user32
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumWindowsProc cb, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hwnd, StringBuilder s, int max);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextLengthW(IntPtr hwnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr hwnd, StringBuilder s, int max);
    [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hwnd, uint cmd);
    [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr hwnd, out int pid);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int cmd);
    [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hwnd, int cmd);
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(int idAttach, int idAttachTo, bool attach);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool PostMessageW(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessageW(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessageTimeoutW(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam, uint flags, uint timeout, out IntPtr result);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindowW(string cls, string title);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindowExW(IntPtr parent, IntPtr after, string cls, string title);
    [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr SetParent(IntPtr child, IntPtr newParent);
    [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr GetParent(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
    [DllImport("user32.dll")] public static extern bool IsChild(IntPtr parent, IntPtr child);
    [DllImport("user32.dll")] public static extern IntPtr GetDesktopWindow();
    [DllImport("user32.dll")] public static extern IntPtr MonitorFromPoint(POINT pt, uint flags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool GetMonitorInfoW(IntPtr monitor, ref MONITORINFO info);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr GetWindowLongPtrW(IntPtr hwnd, int index);
    [DllImport("user32.dll", SetLastError = true)] static extern int GetWindowLongW(IntPtr hwnd, int index);
    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SetWindowLongPtrW(IntPtr hwnd, int index, IntPtr val);
    [DllImport("user32.dll", SetLastError = true)] static extern int SetWindowLongW(IntPtr hwnd, int index, int val);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool SystemParametersInfoW(uint action, uint uiParam, ref RECT pvParam, uint winIni);
    [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
    /// Windows 10 1703+. Missing on older builds, so the call site catches
    /// EntryPointNotFoundException and falls back to SetProcessDPIAware.
    [DllImport("user32.dll", SetLastError = true)] public static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    /// Vista+. System-wide awareness: right on a single-monitor box, stale if
    /// the user drags to a monitor with a different scale factor.
    [DllImport("user32.dll", SetLastError = true)] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr hmodWinEventProc, WinEventProc cb, uint pid, uint tid, uint flags);
    [DllImport("user32.dll")] public static extern bool UnhookWinEvent(IntPtr hook);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern IntPtr SetWindowsHookExW(int idHook, LowLevelKeyboardProc cb, IntPtr hMod, uint threadId);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool UnhookWindowsHookEx(IntPtr hook);
    [DllImport("user32.dll")] public static extern IntPtr CallNextHookEx(IntPtr hook, int nCode, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool DestroyIcon(IntPtr hIcon);
    [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr CopyIcon(IntPtr hIcon);

    /// 64-bit user32 has GetWindowLongPtrW; 32-bit user32 does not (the macro maps
    /// to GetWindowLongW there). We are AnyCPU, so branch on pointer size.
    public static IntPtr GetWindowLongPtr(IntPtr hwnd, int index) {
      return IntPtr.Size == 8 ? GetWindowLongPtrW(hwnd, index) : new IntPtr(GetWindowLongW(hwnd, index));
    }

    public static IntPtr SetWindowLongPtr(IntPtr hwnd, int index, IntPtr val) {
      return IntPtr.Size == 8 ? SetWindowLongPtrW(hwnd, index, val) : new IntPtr(SetWindowLongW(hwnd, index, val.ToInt32()));
    }

    // ----------------------------------------------------------------- kernel32
    [DllImport("kernel32.dll")] public static extern int GetCurrentThreadId();
    [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool QueryFullProcessImageNameW(IntPtr proc, uint flags, StringBuilder buf, ref int size);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr GetModuleHandleW(string name);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool SetConsoleCtrlHandler(ConsoleCtrlHandler handler, bool add);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr VirtualAllocEx(IntPtr proc, IntPtr addr, IntPtr size, uint type, uint protect);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool VirtualFreeEx(IntPtr proc, IntPtr addr, IntPtr size, uint type);
    [DllImport("kernel32.dll", SetLastError = true)] public static extern bool ReadProcessMemory(IntPtr proc, IntPtr addr, IntPtr buf, IntPtr size, out IntPtr read);

    // -------------------------------------------------------------------- other
    [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out int val, int size);
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SHGetFileInfoW(string path, uint fileAttrs, ref SHFILEINFO info, uint cb, uint flags);
    /// Returns a UINT_PTR whose meaning depends on dwMessage: non-zero = the
    /// call was accepted for ABM_NEW/REMOVE/SETPOS, and the STATE BITS for
    /// ABM_GETSTATE (so "0" there means a normal, always-visible taskbar, not
    /// an error - never test it for failure).
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SHAppBarMessage(uint dwMessage, ref APPBARDATA pData);

    // ------------------------------------------------------------------ helpers
    public static string GetWindowText(IntPtr hwnd) {
      int len = GetWindowTextLengthW(hwnd);
      if (len <= 0) return "";
      var sb = new StringBuilder(len + 2);
      int got = GetWindowTextW(hwnd, sb, sb.Capacity);
      return got > 0 ? sb.ToString() : "";
    }

    public static string GetClassName(IntPtr hwnd) {
      var sb = new StringBuilder(256);
      int got = GetClassNameW(hwnd, sb, sb.Capacity);
      return got > 0 ? sb.ToString() : "";
    }

    /// Full image path of the process owning hwnd, or "" when the OS says no
    /// (elevated processes deny even PROCESS_QUERY_LIMITED_INFORMATION to us).
    /// NEVER throws: a missing exe must not cost us the whole window list.
    public static string GetProcessPath(int pid) {
      if (pid <= 0) return "";
      IntPtr h = IntPtr.Zero;
      try {
        h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
        if (h == IntPtr.Zero) return "";
        int size = 1024;
        var sb = new StringBuilder(size);
        if (!QueryFullProcessImageNameW(h, 0, sb, ref size)) return "";
        return sb.ToString();
      } catch (Exception) {
        return "";
      } finally {
        if (h != IntPtr.Zero) CloseHandle(h);
      }
    }

    public static bool IsCloaked(IntPtr hwnd) {
      int cloaked;
      // A failing DwmGetWindowAttribute (older shells, odd windows) is not a
      // reason to drop the window; treat "unknown" as "not cloaked".
      if (DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, out cloaked, sizeof(int)) != 0) return false;
      return cloaked != 0;
    }
  }
}

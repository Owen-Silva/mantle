// FilesNative.cs - the Win32 and shell COM declarations Mantle Files needs, and the helpers every
// Files*.cs shares: the job table (files.cancel), deferred replies, name-free error words, FILETIME
// to ms, and 32bpp DIB -> PNG (lane files, 2026-09-28).
//
// WHY its own copies of IShellItem and friends: Apps.cs and JumpList.cs declare some of the same
// interfaces, but other lanes own those files and each declaration only holds the slots its owner
// calls. Everything here is nested in FilesNative (aliased FN in the Files files), so nothing
// clashes at namespace level and nobody's edit can shift a vtable under Mantle Files.
//
// PRIVACY (contract, binding): no file or folder name or path ever reaches Program.EmitLog or an
// error string. HrWords() is the only way an error is worded here, and it knows only HRESULTs.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace Mantle {
  static class FilesNative {
    // ------------------------------------------------------------------ files
    public const int FindExInfoBasic = 1;
    public const int FindExSearchNameMatch = 0;
    public const int FIND_FIRST_EX_LARGE_FETCH = 2;
    public static readonly IntPtr INVALID_HANDLE_VALUE = new IntPtr(-1);
    public const uint INVALID_FILE_ATTRIBUTES = 0xFFFFFFFF;
    public const uint FILE_ATTRIBUTE_READONLY = 0x1, FILE_ATTRIBUTE_DIRECTORY = 0x10,
                      FILE_ATTRIBUTE_NORMAL = 0x80, FILE_ATTRIBUTE_REPARSE_POINT = 0x400;

    /// FILETIME is two DWORDs, so flat uints keep the 592-byte layout without a nested struct.
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct WIN32_FIND_DATAW {
      public uint dwFileAttributes;
      public uint ftCreationLow, ftCreationHigh;
      public uint ftAccessLow, ftAccessHigh;
      public uint ftWriteLow, ftWriteHigh;
      public uint nFileSizeHigh, nFileSizeLow;
      public uint dwReserved0, dwReserved1;
      [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string cFileName;
      [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 14)] public string cAlternateFileName;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct WIN32_FILE_ATTRIBUTE_DATA {
      public uint dwFileAttributes;
      public uint ftCreationLow, ftCreationHigh;
      public uint ftAccessLow, ftAccessHigh;
      public uint ftWriteLow, ftWriteHigh;
      public uint nFileSizeHigh, nFileSizeLow;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct BY_HANDLE_FILE_INFORMATION {
      public uint dwFileAttributes;
      public uint ftC1, ftC2, ftA1, ftA2, ftW1, ftW2;
      public uint dwVolumeSerialNumber, nFileSizeHigh, nFileSizeLow, nNumberOfLinks, nFileIndexHigh, nFileIndexLow;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr FindFirstFileExW(string name, int infoLevel, out WIN32_FIND_DATAW data,
                                                 int searchOp, IntPtr filter, int flags);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool FindNextFileW(IntPtr h, out WIN32_FIND_DATAW data);
    [DllImport("kernel32.dll")]
    public static extern bool FindClose(IntPtr h);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool GetFileAttributesExW(string name, int level, out WIN32_FILE_ATTRIBUTE_DATA data);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern uint GetFileAttributesW(string name);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr sa, uint disposition,
                                            uint flags, IntPtr template);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern uint GetFinalPathNameByHandleW(IntPtr h, StringBuilder buf, uint cch, uint flags);
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool GetFileInformationByHandle(IntPtr h, out BY_HANDLE_FILE_INFORMATION info);
    [DllImport("kernel32.dll")]
    public static extern bool CloseHandle(IntPtr h);

    // ------------------------------------------------------------------ shell
    public const uint SHGFI_ICON = 0x100, SHGFI_TYPENAME = 0x400, SHGFI_SYSICONINDEX = 0x4000,
                      SHGFI_USEFILEATTRIBUTES = 0x10;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct SHFILEINFOW {
      public IntPtr hIcon;
      public int iIcon;
      public uint dwAttributes;
      [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szDisplayName;
      [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 80)] public string szTypeName;
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    public static extern IntPtr SHGetFileInfoW(string path, uint attrs, ref SHFILEINFOW sfi, uint cb, uint flags);
    [DllImport("shell32.dll", EntryPoint = "#727")]
    public static extern int SHGetImageList(int list, ref Guid riid, [MarshalAs(UnmanagedType.Interface)] out object ppv);
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    public static extern int SHCreateItemFromParsingName(string path, IntPtr pbc, ref Guid riid,
                                                         [MarshalAs(UnmanagedType.Interface)] out object ppv);
    [DllImport("shell32.dll")]
    public static extern int SHGetKnownFolderItem(ref Guid rfid, uint flags, IntPtr token, ref Guid riid,
                                                  [MarshalAs(UnmanagedType.Interface)] out object ppv);
    [DllImport("shell32.dll")]
    public static extern int SHGetKnownFolderPath(ref Guid rfid, uint flags, IntPtr token, out IntPtr path);
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    public static extern int SHParseDisplayName(string name, IntPtr pbc, out IntPtr pidl, uint sfgaoIn, out uint sfgaoOut);
    [DllImport("shell32.dll")]
    public static extern int SHBindToParent(IntPtr pidl, ref Guid riid, [MarshalAs(UnmanagedType.Interface)] out object ppv,
                                            out IntPtr pidlLast);
    [DllImport("shell32.dll")]
    public static extern void ILFree(IntPtr pidl);
    [DllImport("ole32.dll")]
    public static extern void CoTaskMemFree(IntPtr p);

    public static readonly Guid IID_IShellItem = new Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe");
    public static readonly Guid IID_IShellItem2 = new Guid("7e9fb0d3-919f-4307-ab2e-9b1860310c93");
    public static readonly Guid IID_IShellItemImageFactory = new Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b");
    public static readonly Guid IID_IEnumShellItems = new Guid("70629033-e363-4a28-a567-0db78006e6d7");
    public static readonly Guid IID_IImageList = new Guid("46EB5926-582E-4017-9FDF-E8998DAA0950");
    public static readonly Guid IID_IShellFolder = new Guid("000214E6-0000-0000-C000-000000000046");
    public static readonly Guid IID_IContextMenu = new Guid("000214e4-0000-0000-c000-000000000046");
    public static readonly Guid IID_IDataObject = new Guid("0000010e-0000-0000-C000-000000000046");
    public static readonly Guid BHID_EnumItems = new Guid("94f60519-2850-4924-aa5a-d15e84868039");
    public static readonly Guid BHID_SFUIObject = new Guid("3981e225-f559-11d3-8e3a-00c04f6837d5");
    public static readonly Guid BHID_DataObject = new Guid("b8c0bd9f-ed24-455c-83e6-d5390c4fe8c4");
    public static readonly Guid CLSID_FileOperation = new Guid("3ad05575-8857-4850-9277-11b85bdb8e09");
    public static readonly Guid CLSID_ShellLink = new Guid("00021401-0000-0000-C000-000000000046");
    public static readonly Guid FOLDERID_RecycleBinFolder = new Guid("B7534046-3ECB-4C18-BE4E-64CD4CB7D6AC");

    public const uint SIGDN_NORMALDISPLAY = 0, SIGDN_PARENTRELATIVEPARSING = 0x80018001,
                      SIGDN_DESKTOPABSOLUTEPARSING = 0x80028000, SIGDN_FILESYSPATH = 0x80058000;
    public const uint SFGAO_FOLDER = 0x20000000, SFGAO_FILESYSTEM = 0x40000000;

    [StructLayout(LayoutKind.Sequential)]
    public struct SIZE { public int cx, cy; }
    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int x, y; }
    [StructLayout(LayoutKind.Sequential)]
    public struct PROPERTYKEY {
      public Guid fmtid; public uint pid;
      public PROPERTYKEY(Guid g, uint p) { fmtid = g; pid = p; }
    }

    /// Only the slots Mantle Files calls are typed; the vtable ORDER is the contract.
    [ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IShellItem {
      [PreserveSig] int BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, [MarshalAs(UnmanagedType.Interface)] out object ppv);
      [PreserveSig] int GetParent(out IShellItem parent);
      [PreserveSig] int GetDisplayName(uint sigdn, out IntPtr name);
      [PreserveSig] int GetAttributes(uint mask, out uint attribs);
      [PreserveSig] int Compare(IShellItem other, uint hint, out int order);
    }

    /// IShellItem's five slots again, then IShellItem2's (C# ComImport cannot inherit a vtable).
    [ComImport, Guid("7e9fb0d3-919f-4307-ab2e-9b1860310c93"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IShellItem2 {
      [PreserveSig] int BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, [MarshalAs(UnmanagedType.Interface)] out object ppv);
      [PreserveSig] int GetParent(out IShellItem parent);
      [PreserveSig] int GetDisplayName(uint sigdn, out IntPtr name);
      [PreserveSig] int GetAttributes(uint mask, out uint attribs);
      [PreserveSig] int Compare(IShellItem other, uint hint, out int order);
      [PreserveSig] int GetPropertyStore(int flags, ref Guid riid, out IntPtr ppv);
      [PreserveSig] int GetPropertyStoreWithCreateObject(int flags, IntPtr punk, ref Guid riid, out IntPtr ppv);
      [PreserveSig] int GetPropertyStoreForKeys(IntPtr keys, uint count, int flags, ref Guid riid, out IntPtr ppv);
      [PreserveSig] int GetPropertyDescriptionList(ref PROPERTYKEY keyType, ref Guid riid, out IntPtr ppv);
      [PreserveSig] int Update(IntPtr pbc);
      [PreserveSig] int GetProperty(ref PROPERTYKEY key, IntPtr propvar);
      [PreserveSig] int GetCLSID(ref PROPERTYKEY key, out Guid clsid);
      [PreserveSig] int GetFileTime(ref PROPERTYKEY key, out long ft);
      [PreserveSig] int GetInt32(ref PROPERTYKEY key, out int v);
      [PreserveSig] int GetString(ref PROPERTYKEY key, out IntPtr psz);
      [PreserveSig] int GetUInt32(ref PROPERTYKEY key, out uint v);
      [PreserveSig] int GetUInt64(ref PROPERTYKEY key, out ulong v);
      [PreserveSig] int GetBool(ref PROPERTYKEY key, out int v);
    }

    [ComImport, Guid("70629033-e363-4a28-a567-0db78006e6d7"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IEnumShellItems {
      [PreserveSig] int Next(uint celt, out IShellItem item, out uint fetched);
      [PreserveSig] int Skip(uint celt);
      [PreserveSig] int Reset();
      [PreserveSig] int Clone(out IEnumShellItems e);
    }

    [ComImport, Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IShellItemImageFactory {
      [PreserveSig] int GetImage(SIZE size, int flags, out IntPtr hbitmap);
    }

    /// Slots before GetIcon are placeholders: never called, but they hold the vtable order.
    [ComImport, Guid("46EB5926-582E-4017-9FDF-E8998DAA0950"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IImageList {
      [PreserveSig] int Add(IntPtr hbmImage, IntPtr hbmMask, ref int pi);
      [PreserveSig] int ReplaceIcon(int i, IntPtr hicon, ref int pi);
      [PreserveSig] int SetOverlayImage(int iImage, int iOverlay);
      [PreserveSig] int Replace(int i, IntPtr hbmImage, IntPtr hbmMask);
      [PreserveSig] int AddMasked(IntPtr hbmImage, int crMask, ref int pi);
      [PreserveSig] int Draw(IntPtr pimldp);
      [PreserveSig] int Remove(int i);
      [PreserveSig] int GetIcon(int i, int flags, out IntPtr picon);
    }

    [ComImport, Guid("947aab5f-0a5c-4c13-b4d6-4bf7836fc9f8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IFileOperation {
      [PreserveSig] int Advise(IFileOperationProgressSink sink, out uint cookie);
      [PreserveSig] int Unadvise(uint cookie);
      [PreserveSig] int SetOperationFlags(uint flags);
      [PreserveSig] int SetProgressMessage([MarshalAs(UnmanagedType.LPWStr)] string message);
      [PreserveSig] int SetProgressDialog(IntPtr popd);
      [PreserveSig] int SetProperties(IntPtr pproparray);
      [PreserveSig] int SetOwnerWindow(IntPtr hwnd);
      [PreserveSig] int ApplyPropertiesToItem(IShellItem item);
      [PreserveSig] int ApplyPropertiesToItems(IntPtr punkItems);
      [PreserveSig] int RenameItem(IShellItem item, [MarshalAs(UnmanagedType.LPWStr)] string newName, IFileOperationProgressSink sink);
      [PreserveSig] int RenameItems(IntPtr punkItems, [MarshalAs(UnmanagedType.LPWStr)] string newName);
      [PreserveSig] int MoveItem(IShellItem item, IShellItem destFolder, [MarshalAs(UnmanagedType.LPWStr)] string newName, IFileOperationProgressSink sink);
      [PreserveSig] int MoveItems(IntPtr punkItems, IShellItem destFolder);
      [PreserveSig] int CopyItem(IShellItem item, IShellItem destFolder, [MarshalAs(UnmanagedType.LPWStr)] string copyName, IFileOperationProgressSink sink);
      [PreserveSig] int CopyItems(IntPtr punkItems, IShellItem destFolder);
      [PreserveSig] int DeleteItem(IShellItem item, IFileOperationProgressSink sink);
      [PreserveSig] int DeleteItems(IntPtr punkItems);
      [PreserveSig] int NewItem(IShellItem destFolder, uint attrs, [MarshalAs(UnmanagedType.LPWStr)] string name,
                                [MarshalAs(UnmanagedType.LPWStr)] string templateName, IFileOperationProgressSink sink);
      [PreserveSig] int PerformOperations();
      [PreserveSig] int GetAnyOperationsAborted([MarshalAs(UnmanagedType.Bool)] out bool aborted);
    }

    [ComImport, Guid("04b0f1a7-9490-44bc-96e1-4296a31252e2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IFileOperationProgressSink {
      [PreserveSig] int StartOperations();
      [PreserveSig] int FinishOperations(int hrResult);
      [PreserveSig] int PreRenameItem(uint flags, IShellItem item, [MarshalAs(UnmanagedType.LPWStr)] string newName);
      [PreserveSig] int PostRenameItem(uint flags, IShellItem item, [MarshalAs(UnmanagedType.LPWStr)] string newName, int hr, IShellItem created);
      [PreserveSig] int PreMoveItem(uint flags, IShellItem item, IShellItem destFolder, [MarshalAs(UnmanagedType.LPWStr)] string newName);
      [PreserveSig] int PostMoveItem(uint flags, IShellItem item, IShellItem destFolder, [MarshalAs(UnmanagedType.LPWStr)] string newName, int hr, IShellItem created);
      [PreserveSig] int PreCopyItem(uint flags, IShellItem item, IShellItem destFolder, [MarshalAs(UnmanagedType.LPWStr)] string newName);
      [PreserveSig] int PostCopyItem(uint flags, IShellItem item, IShellItem destFolder, [MarshalAs(UnmanagedType.LPWStr)] string newName, int hr, IShellItem created);
      [PreserveSig] int PreDeleteItem(uint flags, IShellItem item);
      [PreserveSig] int PostDeleteItem(uint flags, IShellItem item, int hr, IShellItem created);
      [PreserveSig] int PreNewItem(uint flags, IShellItem destFolder, [MarshalAs(UnmanagedType.LPWStr)] string newName);
      [PreserveSig] int PostNewItem(uint flags, IShellItem destFolder, [MarshalAs(UnmanagedType.LPWStr)] string newName,
                                    [MarshalAs(UnmanagedType.LPWStr)] string templateName, uint attrs, int hr, IShellItem created);
      [PreserveSig] int UpdateProgress(uint workTotal, uint workSoFar);
      [PreserveSig] int ResetTimer();
      [PreserveSig] int PauseTimer();
      [PreserveSig] int ResumeTimer();
    }

    [ComImport, Guid("000214F9-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IShellLinkW {
      [PreserveSig] int GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder file, int cch, IntPtr findData, uint flags);
      // The remaining slots are never called and are not declared: nothing after GetPath is used.
    }

    [ComImport, Guid("0000010b-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IPersistFile {
      [PreserveSig] int GetClassID(out Guid clsid);
      [PreserveSig] int IsDirty();
      [PreserveSig] int Load([MarshalAs(UnmanagedType.LPWStr)] string file, uint mode);
    }

    [ComImport, Guid("000214E6-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IShellFolder {
      [PreserveSig] int ParseDisplayName(IntPtr hwnd, IntPtr pbc, [MarshalAs(UnmanagedType.LPWStr)] string name, IntPtr eaten, out IntPtr pidl, IntPtr attrs);
      [PreserveSig] int EnumObjects(IntPtr hwnd, int flags, out IntPtr ppenum);
      [PreserveSig] int BindToObject(IntPtr pidl, IntPtr pbc, ref Guid riid, out IntPtr ppv);
      [PreserveSig] int BindToStorage(IntPtr pidl, IntPtr pbc, ref Guid riid, out IntPtr ppv);
      [PreserveSig] int CompareIDs(IntPtr lParam, IntPtr pidl1, IntPtr pidl2);
      [PreserveSig] int CreateViewObject(IntPtr hwnd, ref Guid riid, out IntPtr ppv);
      [PreserveSig] int GetAttributesOf(uint cidl, IntPtr apidl, ref uint inOut);
      [PreserveSig] int GetUIObjectOf(IntPtr hwnd, uint cidl, [MarshalAs(UnmanagedType.LPArray)] IntPtr[] apidl,
                                      ref Guid riid, IntPtr reserved, [MarshalAs(UnmanagedType.Interface)] out object ppv);
    }

    [ComImport, Guid("000214e4-0000-0000-c000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IContextMenu {
      [PreserveSig] int QueryContextMenu(IntPtr hmenu, uint index, uint idFirst, uint idLast, uint flags);
      [PreserveSig] int InvokeCommand(ref CMINVOKECOMMANDINFOEX ici);
      [PreserveSig] int GetCommandString(UIntPtr idCmd, uint type, IntPtr reserved, IntPtr name, uint cch);
    }

    [ComImport, Guid("000214f4-0000-0000-c000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IContextMenu2 {
      [PreserveSig] int QueryContextMenu(IntPtr hmenu, uint index, uint idFirst, uint idLast, uint flags);
      [PreserveSig] int InvokeCommand(ref CMINVOKECOMMANDINFOEX ici);
      [PreserveSig] int GetCommandString(UIntPtr idCmd, uint type, IntPtr reserved, IntPtr name, uint cch);
      [PreserveSig] int HandleMenuMsg(uint msg, IntPtr wParam, IntPtr lParam);
    }

    [ComImport, Guid("bcfce0a0-ec17-11d0-8d10-00a0c90f2719"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IContextMenu3 {
      [PreserveSig] int QueryContextMenu(IntPtr hmenu, uint index, uint idFirst, uint idLast, uint flags);
      [PreserveSig] int InvokeCommand(ref CMINVOKECOMMANDINFOEX ici);
      [PreserveSig] int GetCommandString(UIntPtr idCmd, uint type, IntPtr reserved, IntPtr name, uint cch);
      [PreserveSig] int HandleMenuMsg(uint msg, IntPtr wParam, IntPtr lParam);
      [PreserveSig] int HandleMenuMsg2(uint msg, IntPtr wParam, IntPtr lParam, out IntPtr result);
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct CMINVOKECOMMANDINFOEX {
      public int cbSize; public uint fMask; public IntPtr hwnd; public IntPtr lpVerb;
      public IntPtr lpParameters; public IntPtr lpDirectory; public int nShow; public uint dwHotKey; public IntPtr hIcon;
      public IntPtr lpTitle; public IntPtr lpVerbW; public IntPtr lpParametersW; public IntPtr lpDirectoryW; public IntPtr lpTitleW;
      public POINT ptInvoke;
    }

    [ComImport, Guid("F04061AC-1659-4a3f-A954-775AA57FC083"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IAssocHandler {
      [PreserveSig] int GetName([MarshalAs(UnmanagedType.LPWStr)] out string name);
      [PreserveSig] int GetUIName([MarshalAs(UnmanagedType.LPWStr)] out string name);
      [PreserveSig] int GetIconLocation([MarshalAs(UnmanagedType.LPWStr)] out string path, out int index);
      [PreserveSig] int IsRecommended();
      [PreserveSig] int MakeDefault([MarshalAs(UnmanagedType.LPWStr)] string description);
      [PreserveSig] int Invoke([MarshalAs(UnmanagedType.Interface)] object dataObject);
    }

    [ComImport, Guid("973810ae-9599-4b88-9e4d-6ee98c9552da"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IEnumAssocHandlers {
      [PreserveSig] int Next(uint count, [MarshalAs(UnmanagedType.Interface)] out IAssocHandler handler, out uint fetched);
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    public static extern int SHAssocEnumHandlers(string ext, int filter, out IEnumAssocHandlers e);

    // ------------------------------------------------------------------ GDI / icons
    [StructLayout(LayoutKind.Sequential)]
    public struct BITMAP {
      public int bmType, bmWidth, bmHeight, bmWidthBytes;
      public ushort bmPlanes, bmBitsPixel;
      public IntPtr bmBits;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct BITMAPINFOHEADER {
      public int biSize, biWidth, biHeight;
      public short biPlanes, biBitCount;
      public int biCompression, biSizeImage, biXPelsPerMeter, biYPelsPerMeter, biClrUsed, biClrImportant;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct ICONINFO {
      public int fIcon, xHotspot, yHotspot;
      public IntPtr hbmMask, hbmColor;
    }

    [DllImport("gdi32.dll")]
    public static extern int GetObjectW(IntPtr h, int cb, ref BITMAP bm);
    [DllImport("gdi32.dll")]
    public static extern int GetDIBits(IntPtr hdc, IntPtr hbmp, uint start, uint lines, [Out] byte[] bits,
                                       ref BITMAPINFOHEADER bi, uint usage);
    [DllImport("gdi32.dll")]
    public static extern bool DeleteObject(IntPtr h);
    [DllImport("gdi32.dll")]
    public static extern IntPtr CreateCompatibleDC(IntPtr hdc);
    [DllImport("gdi32.dll")]
    public static extern bool DeleteDC(IntPtr hdc);
    [DllImport("user32.dll")]
    public static extern bool GetIconInfo(IntPtr hicon, out ICONINFO info);
    [DllImport("user32.dll")]
    public static extern bool DestroyIcon(IntPtr hicon);
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    public static extern int SHDefExtractIconW(string iconFile, int index, uint flags, out IntPtr large, out IntPtr small, uint size);
    [DllImport("shlwapi.dll", CharSet = CharSet.Unicode)]
    public static extern int SHLoadIndirectString(string source, StringBuilder outBuf, uint cch, IntPtr reserved);

    // ------------------------------------------------------------------ menus / messages
    [StructLayout(LayoutKind.Sequential)]
    public struct MENUITEMINFOW {
      public uint cbSize, fMask, fType, fState, wID;
      public IntPtr hSubMenu, hbmpChecked, hbmpUnchecked, dwItemData, dwTypeData;
      public uint cch;
      public IntPtr hbmpItem;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam, lParam; public uint time; public POINT pt; }

    [DllImport("user32.dll")] public static extern IntPtr CreatePopupMenu();
    [DllImport("user32.dll")] public static extern bool DestroyMenu(IntPtr h);
    [DllImport("user32.dll")] public static extern int GetMenuItemCount(IntPtr h);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern bool GetMenuItemInfoW(IntPtr h, uint item, bool byPosition, ref MENUITEMINFOW mii);
    [DllImport("user32.dll")]
    public static extern uint MsgWaitForMultipleObjectsEx(uint count, IntPtr[] handles, uint ms, uint wakeMask, uint flags);
    [DllImport("user32.dll")]
    public static extern bool PeekMessageW(out MSG msg, IntPtr hwnd, uint min, uint max, uint remove);
    [DllImport("user32.dll")] public static extern bool TranslateMessage(ref MSG msg);
    [DllImport("user32.dll")] public static extern IntPtr DispatchMessageW(ref MSG msg);

    // ------------------------------------------------------------------ helpers

    /// FILETIME (100 ns since 1601 UTC) -> ms since 1970 UTC; 0 stays 0 ("no time").
    public static long FtMs(uint low, uint high) {
      long ft = ((long)high << 32) | low;
      if (ft <= 116444736000000000L) return 0;
      return (ft - 116444736000000000L) / 10000L;
    }
    public static long FtMs(long ft) {
      if (ft <= 116444736000000000L) return 0;
      return (ft - 116444736000000000L) / 10000L;
    }

    /// The compact streamed item {n,d,s,m,c,a}; the contract's shape, thousands per second.
    public static IDictionary Item(ref WIN32_FIND_DATAW f) {
      bool dir = (f.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
      long size = dir ? 0 : (((long)f.nFileSizeHigh << 32) | f.nFileSizeLow);
      return Json.Obj("n", f.cFileName, "d", dir ? 1 : 0, "s", size,
                      "m", FtMs(f.ftWriteLow, f.ftWriteHigh), "c", FtMs(f.ftCreationLow, f.ftCreationHigh),
                      "a", (long)f.dwFileAttributes);
    }

    /// Error words from an HRESULT or Win32 code, never from a path: this is what reaches main's
    /// call-log. "access denied (0x80070005)".
    public static string HrWords(int hr) {
      string w;
      switch ((uint)hr) {
        case 0x80070002: case 0x80070003: w = "not found"; break;
        case 0x80070005: w = "access denied"; break;
        case 0x80070020: case 0x80070021: w = "in use by another app"; break;
        case 0x80070050: case 0x800700B7: w = "already exists"; break;
        case 0x80070070: w = "the disk is full"; break;
        case 0x8007007B: w = "invalid name"; break;
        case 0x800700CE: w = "the path is too long"; break;
        case 0x8007010B: w = "not a folder"; break;
        case 0x800704C7: w = "cancelled"; break;
        case 0x80070015: w = "the drive is not ready"; break;
        case 0x80070035: case 0x80070043: w = "the network path was not found"; break;
        case 0x80004005: w = "failed"; break;
        default:
          w = ((uint)hr & 0xFFFF0000) == 0x80270000 ? "the copy engine refused" : "failed";
          break;
      }
      return w + " (0x" + ((uint)hr).ToString("X8", CultureInfo.InvariantCulture) + ")";
    }
    public static string Win32Words(int err) { return HrWords(err == 0 ? unchecked((int)0x80004005) : HResultFromWin32(err)); }
    public static int HResultFromWin32(int err) { return err <= 0 ? err : unchecked((int)(((uint)err & 0xFFFF) | 0x80070000)); }

    public static string ItemName(IShellItem si, uint sigdn) {
      if (si == null) return null;
      IntPtr p;
      if (si.GetDisplayName(sigdn, out p) != 0 || p == IntPtr.Zero) return null;
      try { return Marshal.PtrToStringUni(p); } finally { CoTaskMemFree(p); }
    }

    public static IShellItem ItemFromPath(string path, out int hr) {
      object o;
      Guid iid = IID_IShellItem;
      hr = SHCreateItemFromParsingName(path, IntPtr.Zero, ref iid, out o);
      return hr == 0 ? o as IShellItem : null;
    }

    public static void Release(object com) {
      if (com != null && Marshal.IsComObject(com)) { try { Marshal.ReleaseComObject(com); } catch (Exception) { } }
    }

    /// Absolute local ("C:\x") or UNC ("\\server\share") paths only. A relative path would be read
    /// against the sidecar's working directory, which is never what the page meant.
    public static bool IsAbsolute(string p) {
      if (string.IsNullOrEmpty(p) || p.Length < 2) return false;
      if (p.Length >= 3 && char.IsLetter(p[0]) && p[1] == ':' && (p[2] == '\\' || p[2] == '/')) return true;
      if (p.Length == 2 && char.IsLetter(p[0]) && p[1] == ':') return true;
      return p.StartsWith("\\\\", StringComparison.Ordinal);
    }

    /// Paths arrive as JSON strings or {src,...} objects; a list of plain strings is the common case.
    public static List<string> StringList(Dictionary<string, object> req, string key) {
      object v;
      var list = new List<string>();
      if (!Json.TryGet(req, key, out v)) return list;
      var items = v as IEnumerable;
      if (items == null || v is string) return list;
      foreach (object o in items) { var s = o as string; if (s != null) list.Add(s); }
      return list;
    }

    // ------------------------------------------------------------------ DIB -> PNG

    /// Reads any HBITMAP as top-down 32bpp BGRA. The DIB bits are the only route that keeps the
    /// alpha channel: Bitmap.FromHbitmap flattens it to opaque.
    public static byte[] ReadBits(IntPtr hbmp, out int w, out int h) {
      w = 0; h = 0;
      var bm = new BITMAP();
      if (GetObjectW(hbmp, Marshal.SizeOf(typeof(BITMAP)), ref bm) == 0) return null;
      w = bm.bmWidth; h = Math.Abs(bm.bmHeight);
      if (w <= 0 || h <= 0 || w > 4096 || h > 4096) return null;
      var bi = new BITMAPINFOHEADER();
      bi.biSize = Marshal.SizeOf(typeof(BITMAPINFOHEADER));
      bi.biWidth = w; bi.biHeight = -h; bi.biPlanes = 1; bi.biBitCount = 32;
      byte[] bits = new byte[w * h * 4];
      IntPtr dc = CreateCompatibleDC(IntPtr.Zero);
      try {
        if (GetDIBits(dc, hbmp, 0, (uint)h, bits, ref bi, 0) != h) return null;
      } finally { DeleteDC(dc); }
      return bits;
    }

    /// BGRA -> base64 PNG. `premultiplied`: the shell's thumbnails are; icon bitmaps are not.
    /// An all-zero alpha channel means a source written without alpha (JPEG thumbnails, old
    /// icons), so it is made opaque instead of invisible.
    public static string Png(byte[] bgra, int w, int h, bool premultiplied) {
      bool anyAlpha = false;
      for (int i = 3; i < bgra.Length; i += 4) if (bgra[i] != 0) { anyAlpha = true; break; }
      if (!anyAlpha) {
        for (int i = 3; i < bgra.Length; i += 4) bgra[i] = 255;
        premultiplied = false;
      }
      PixelFormat pf = premultiplied ? PixelFormat.Format32bppPArgb : PixelFormat.Format32bppArgb;
      using (var bmp = new Bitmap(w, h, pf)) {
        BitmapData bd = bmp.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.WriteOnly, pf);
        try {
          for (int y = 0; y < h; y++) Marshal.Copy(bgra, y * w * 4, IntPtr.Add(bd.Scan0, y * bd.Stride), w * 4);
        } finally { bmp.UnlockBits(bd); }
        using (var ms = new MemoryStream()) {
          bmp.Save(ms, ImageFormat.Png);
          return Convert.ToBase64String(ms.ToArray());
        }
      }
    }

    public static string IconPng(IntPtr hicon, out int w, out int h) {
      byte[] bits = IconBits(hicon, out w, out h);
      return bits == null ? null : Png(bits, w, h, false);
    }

    /// HICON -> straight-alpha BGRA; a 1-bit-mask icon gets its alpha from the mask. The icon
    /// itself is NOT destroyed here (the caller owns it); both ICONINFO bitmaps are.
    public static byte[] IconBits(IntPtr hicon, out int w, out int h) {
      w = 0; h = 0;
      ICONINFO ii;
      if (hicon == IntPtr.Zero || !GetIconInfo(hicon, out ii)) return null;
      try {
        if (ii.hbmColor == IntPtr.Zero) return null;
        byte[] bits = ReadBits(ii.hbmColor, out w, out h);
        if (bits == null) return null;
        bool anyAlpha = false;
        for (int i = 3; i < bits.Length; i += 4) if (bits[i] != 0) { anyAlpha = true; break; }
        if (!anyAlpha && ii.hbmMask != IntPtr.Zero) {
          int mw, mh;
          byte[] mask = ReadBits(ii.hbmMask, out mw, out mh);
          if (mask != null && mw == w && mh >= h) {
            // Mask white = transparent, black = opaque.
            for (int i = 0; i < w * h; i++) bits[i * 4 + 3] = (byte)(mask[i * 4] == 0 ? 255 : 0);
          }
        }
        return bits;
      } finally {
        if (ii.hbmColor != IntPtr.Zero) DeleteObject(ii.hbmColor);
        if (ii.hbmMask != IntPtr.Zero) DeleteObject(ii.hbmMask);
      }
    }
  }

  /// One running files job (list / search / size / op / thumbs), so files.cancel can reach it.
  sealed class FilesJob {
    public string Key;
    public object Raw;                   // the caller's own value (number or string), echoed in events
    public string Kind;
    public volatile bool Cancelled;
    public long StartTs = Stopwatch.GetTimestamp();
    public long Ms { get { return (Stopwatch.GetTimestamp() - StartTs) * 1000L / Stopwatch.Frequency; } }
  }

  static class FilesJobs {
    static readonly object _lock = new object();
    static readonly Dictionary<string, FilesJob> _jobs = new Dictionary<string, FilesJob>(StringComparer.Ordinal);

    /// Null with `err` set when `job` is missing or already running: two streams under one key
    /// would interleave their events and the page could not tell them apart.
    public static FilesJob Start(Dictionary<string, object> req, string kind, out string err) {
      err = null;
      string key = Json.GetString(req, "job");
      if (string.IsNullOrEmpty(key)) { err = "files." + kind + " needs job: a key its events will carry"; return null; }
      if (key.Length > 100) { err = "files." + kind + ": job is longer than 100 characters"; return null; }
      lock (_lock) {
        if (_jobs.ContainsKey(key)) { err = "files." + kind + ": job " + key + " is already running"; return null; }
        var j = new FilesJob();
        j.Key = key; j.Kind = kind; j.Raw = req["job"];
        _jobs[key] = j;
        return j;
      }
    }

    public static void End(FilesJob j) {
      if (j == null) return;
      lock (_lock) {
        FilesJob cur;
        if (_jobs.TryGetValue(j.Key, out cur) && ReferenceEquals(cur, j)) _jobs.Remove(j.Key);
      }
    }

    public static bool Cancel(string key) {
      if (string.IsNullOrEmpty(key)) return false;
      lock (_lock) {
        FilesJob j;
        if (!_jobs.TryGetValue(key, out j)) return false;
        j.Cancelled = true;
        return true;
      }
    }

    public static int Running { get { lock (_lock) return _jobs.Count; } }
  }

  /// Work that answers later from its own STA thread (COM shell objects are apartment-threaded,
  /// and a Slow-lane command that takes seconds would hold up icons and launches behind it).
  delegate string FilesWork(out object result);

  static class FilesDefer {
    public static object Run(Dictionary<string, object> req, string threadName, FilesWork work) {
      object id = req.ContainsKey("id") ? req["id"] : null;
      var t = new Thread(delegate () {
        object res = null;
        string err;
        try { err = work(out res); }
        catch (Exception ex) { err = threadName + " failed: " + ex.GetType().Name; }
        Program.ReplyFromWorker(id, err == null, res, err);
      });
      t.IsBackground = true;               // never holds the process open
      t.Name = threadName;
      t.SetApartmentState(ApartmentState.STA);
      t.Start();
      return Program.Deferred;
    }
  }
}

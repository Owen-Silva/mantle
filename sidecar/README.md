# Mantle sidecar

Electron cannot call Win32. This is the one process that can.

`Mantle.Sidecar.exe` is a ~46 KB .NET Framework 4 executable that owns **every**
Win32 call in Mantle: the window list, the taskbar, the work area, the desktop
reparent, the solo-Win gesture, volume, icons and the tray. Electron starts it,
talks to it over stdin/stdout in JSON lines, and kills it by closing the pipe.

One process, one protocol, one place to audit anything that touches the live
shell.

## Build

```
powershell -NoProfile -ExecutionPolicy Bypass -File sidecar/build.ps1
```

(or `npm run build:sidecar`). It shells out to the C# compiler that ships with
Windows:

```
C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe /target:winexe /optimize+ /nologo
  /out:sidecar\bin\Mantle.Sidecar.exe
  /r:System.dll /r:System.Core.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll
  sidecar\*.cs
```

There is **no .NET SDK on this machine and none is needed** — that compiler has
been part of Windows since Windows 8. Two consequences for anyone editing the
source:

- **C# 5 only.** No string interpolation, no `nameof`, no expression-bodied
  members, no `out var`. The compiler will tell you, but it is friendlier to
  know first.
- **No NuGet.** JSON is hand-rolled (`Json.cs`) and CoreAudio is declared by
  hand (`Volume.cs`). Do not reach for a package; there is nowhere to get one.

`/target:winexe` is load-bearing: a console-subsystem build would flash a black
window every time Electron starts the sidecar. Redirected stdin/stdout work
exactly the same either way.

The exe must stay **64-bit** (AnyCPU on an x64 OS is fine — do not add
`/platform:x86`). `GetWindowLongPtrW` only exists in 64-bit user32, and the tray
reader assumes 64-bit struct layouts inside a 64-bit explorer.

## Run

```
sidecar/bin/Mantle.Sidecar.exe [--passive] [--parent-pid=<pid>]
```

| flag | meaning |
| --- | --- |
| `--passive` | Test mode. Nothing on the live desktop may move. Exactly these commands are refused with `{"ok":false,"error":"refused: sidecar is passive (test mode)"}` — `focus`, `minimize`, `close`, `toggle`, `taskbar`, `workarea`, `desktop`, `hotkey`, `trayClick`. Everything read-only (`ping`, `windows`, `icon`, `volume`, `tray`, `quit`) and every event still works. |
| `--parent-pid=<pid>` | Exclude that process's windows from the list (so Mantle's own bar and launcher never show up in Mantle's own taskbar), and exit — after restoring the shell — when that process dies. |

## Protocol

UTF-8, **no BOM**, one JSON object per line, LF endings, flushed after every
line.

Request → reply:

```json
{"id":1,"cmd":"ping"}
{"id":1,"ok":true,"result":{"pid":1234,"passive":false,"version":"0.1.0"}}
{"id":2,"ok":false,"error":"plain words saying what went wrong"}
```

`id` is echoed as given. Errors are always plain words a human could read in the
UI — **nothing in this sidecar fails silently**. A line that cannot be parsed at
all still gets an answer, with `"id":null` (there was no id to echo) and a reason
that says where it went wrong. Two JSON objects on one line is an error, not a
silent drop of the second.

HWNDs travel as **decimal strings** (`"131862"`), the same convention as
`~/browser/embed.js`, because a 64-bit handle does not survive a round trip
through a JavaScript number.

### Commands

| cmd | args | result |
| --- | --- | --- |
| `ping` | — | `{pid, passive, version}` |
| `windows` | — | `[{hwnd, title, exe, pid, minimized, foreground, icon}]` |
| `focus` | `{hwnd}` | `{}` — raise it |
| `minimize` | `{hwnd}` | `{}` |
| `close` | `{hwnd}` | `{}` — WM_CLOSE, so the app can still prompt to save |
| `toggle` | `{hwnd}` | `{}` — minimize if it is already foreground, else focus |
| `taskbar` | `{show:bool}` | `{hidden:bool}` |
| `workarea` | `{bottom:px}` \| `{top:px}` \| `{reset:true}` | `{rect:[l,t,r,b]}` |
| `desktop` | `{hwnd}` | `{mode:"workerw-sibling"\|"workerw-child"\|"progman"}` |
| `desktop` | `{hwnd, detach:true}` | `{}` |
| `hotkey` | `{winTap:bool}` | `{installed:bool}` |
| `volume` | — or `{level?:0-100, muted?:bool}` | `{level, muted}` |
| `icon` | `{path}` (`.exe` or `.lnk`) | `{icon: dataUrl\|null}` |
| `tray` | — | `[{id, tooltip, icon}]`, or an error `tray unavailable: <reason>` |
| `trayClick` | `{id, button:"left"\|"right"}` | `{}` |
| `quit` | — | `{}`, then restores the shell and exits 0 |

### Events

Unsolicited lines, distinguished by having `ev` instead of `id`:

| event | when |
| --- | --- |
| `{"ev":"ready","pid":..,"passive":..,"version":".."}` | first line, always |
| `{"ev":"windows","list":[...]}` | the list changed. Coalesced to at most one per 250 ms, with a 2 s poll as a safety net, and one unconditional emit within the first 2 s so the UI never starts empty |
| `{"ev":"hotkey","name":"win"}` | a solo Win tap |
| `{"ev":"taskbar","hidden":bool,"reason":".."}` | the hidden state changed, **including** re-hides by the watcher (`reason: "re-hidden: explorer showed it"`) |
| `{"ev":"log","level":"warn"\|"error","message":".."}` | anything a human should know: a missing icon, a hook that would not install, a fallback that kicked in |

## Safety

The sidecar can hide the taskbar and shrink the work area. A sidecar that died
holding those would look, to a user who has never heard of Mantle, exactly like
a broken Windows install. So **every** exit path — `quit`, stdin EOF, parent
death, Ctrl+C, console close, unhandled exception — runs the same restore first:
show the taskbar, reset the work area, remove the keyboard hook, unhook the
window watchers, *then* exit.

An error inside a command never kills the process; it answers `ok:false`.

## How each piece works, and what it costs

- **Window list.** `EnumWindows`, keeping windows that are visible, titled,
  unowned, not `WS_EX_TOOLWINDOW`, **not DWM-cloaked** (that is how UWP apps
  parked on another virtual desktop are excluded — they look perfectly visible
  to `IsWindowVisible`), and not shell furniture by class name.
  `ApplicationFrameWindow` is deliberately **kept**: it is the real window of a
  Store app.
- **Change detection.** `SetWinEventHook` over two event ranges, out-of-context,
  filtered to `OBJID_WINDOW`. The hook proc does nothing but set a flag — it
  runs inside every app's window transitions and must return in microseconds. A
  250 ms timer rebuilds, fingerprints and emits only on a real change.
- **Icons.** `SHGetFileInfo` (which also resolves `.lnk`), falling back to
  `Icon.ExtractAssociatedIcon`, scaled to 32×32 PNG, base64. Cached per exe
  path, **including failures**, so a path that cannot yield an icon is tried
  once and logged once rather than 30 times a minute forever.
- **Taskbar.** `ShowWindow(SW_HIDE)` on `Shell_TrayWnd` and every
  `Shell_SecondaryTrayWnd`. explorer keeps running; only the bar goes away, and
  one call puts it back. A 1 s watcher re-hides it when explorer shows it again
  and **says so** in a `taskbar` event. The bars are re-found on every tick, so
  an explorer restart heals itself.
- **Desktop.** The wallpaper trick: `SendMessageTimeout(Progman, 0x052C, 0xD)`
  spawns a `WorkerW`, and our window becomes its child, so Windows itself keeps
  it at the bottom of the z-order. Where that WorkerW lives changed between
  Windows versions, so all three shapes are probed and the winning one is
  reported back (`workerw-sibling` = classic Win10, `workerw-child` = Win11
  24H2/25H2, `progman` = fallback). The window's original style is saved and
  restored on `detach`.
- **Solo-Win gesture.** A `WH_KEYBOARD_LL` hook that **never swallows
  anything**. On a Win-up with no other key in between, it injects a press of
  VK `0xFF` (a reserved, unmapped key) first, so Windows sees a chord and does
  not open Start. Win+E, Win+L, Win+Shift+S all keep working. Swallowing the Win
  keyup instead would leave Windows believing Win is held down forever, which is
  a far worse bug than Start opening by accident.
- **Volume.** CoreAudio COM, declared by hand. **Method order in those
  interfaces is the ABI** — the vtable is positional, so every method is listed
  even though three are called. Reordering one silently calls the wrong
  function.

## Known limits

- **The tray does not work on this machine, and says so.** Measured on Windows
  11 25H2 (build 26200): `Shell_TrayWnd` still has a `TrayNotifyWnd` child, but
  that window is now a **vestigial stub with no children of its own** — no
  `SysPager`, no `ToolbarWindow32`, and no `NotifyIconOverflowWindow` anywhere.
  The icons are drawn by the XAML island beside it
  (`Windows.UI.Composition.DesktopWindowContentBridge`). So `tray` answers:

  ```
  tray unavailable: TrayNotifyWnd has no ToolbarWindow32 (SysPager missing); no NotifyIconOverflowWindow either
  ```

  The full legacy reader (cross-process `TB_GETBUTTON` + `ReadProcessMemory`)
  is implemented and will work on a build that still exposes those toolbars, but
  on this one a real tray needs a different approach entirely (UI Automation
  over the XAML tree). Plan the UI so a missing tray is a stated absence, not an
  empty strip.
- `workarea` reserves space on the **primary monitor only**. Multi-monitor
  reservation needs per-monitor work areas, which `SPI_SETWORKAREA` does not
  offer directly.
- `focus` can still legitimately fail: Windows' foreground lock lets the current
  app refuse. The escalation ladder (restore → `AttachThreadInput` → Alt nudge)
  handles the normal cases, and the command answers `ok:false` with the reason
  when it does not, rather than reporting a success that did not happen.
- `trayClick` posts the classic `uCallbackMessage` convention (wParam = icon id,
  lParam = mouse message). Icons registered with `NOTIFYICON_VERSION_4` expect a
  different packing and may ignore it.

## Test

```
node sidecar/test-sidecar.js
```

Builds the exe if it is missing, then runs the whole protocol against a
`--passive` instance and prints one line:

```
SIDECAR TEST: 20 passed, 0 failed
```

It is safe to run while someone is using the machine: passive mode is what makes
that a guarantee rather than a hope, and the test asserts the refusals. It also
proves both self-exit paths (`quit` → 0, stdin EOF → gone in well under 2 s), so
a test run can never leave an orphaned sidecar behind.

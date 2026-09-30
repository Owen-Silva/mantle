# Mantle sidecar

Electron cannot call Win32. This is the one process that can.

`Mantle.Sidecar.exe` is a ~58 KB .NET Framework 4 executable that owns **every**
Win32 call in Mantle: the window list, the taskbar's auto-hide state, the app
bar that reserves screen space for Mantle's own bar, the blur behind Mantle's
own windows, the desktop reparent, the solo-Win gesture, volume, icons and the
tray. Electron starts it,
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
sidecar/bin/Mantle.Sidecar.exe [--passive] [--parent-pid=<pid>] [--state-file=<path>]
```

| flag | meaning |
| --- | --- |
| `--passive` | Test mode. Nothing on the live desktop may move. Exactly these commands are refused with `{"ok":false,"error":"refused: sidecar is passive (test mode)"}` — `focus`, `minimize`, `close`, `toggle`, `taskbar`, `appbar`, `workarea`, `desktop`, `hotkey`, `trayClick`. Everything read-only (`ping`, `windows`, `icon`, `volume`, `tray`, `quit`) and every event still works — and so does `glass`, which only ever touches a window the caller already owns. A **removed** form (`taskbar {show}`, `workarea {bottom|top}`) answers with *why it was removed* instead, in every mode: that is more useful to a caller than "refused". |
| `--parent-pid=<pid>` | Exclude that process's windows from the list (so Mantle's own bar and launcher never show up in Mantle's own taskbar), and exit — after restoring the shell — when that process dies. |
| `--state-file=<path>` | Where to leave the recovery note (see **Safety**). Written at startup with the **original** shell state before anything is touched, after every change, and again at the end of the restore path. Absent is legal and says so: `{"ev":"log","level":"warn","message":"no --state-file: a recovery script cannot know the original shell state"}`. |

### The state file

Written atomically (content goes to `<path>.tmp`, which is then copied over the
target), UTF-8, no BOM, one object:

```json
{ "writtenAt": "2026-09-21T20:37:57.804Z", "pid": 7400, "units": "physical",
  "original": { "abmState": 1, "workarea": [0,0,1920,1080] },
  "changed":  { "autohide": false, "appbars": ["131862"] },
  "restored": false }
```

`units` says what the numbers mean — `"physical"` normally, `"virtualised"` in
the unhappy case where DPI awareness could not be set (see **DPI**), because a
recovery script feeding a virtualised `workarea` back to `SPI_SETWORKAREA` would
set an area 80% of the right size.

`original.abmState` is what `ABM_GETSTATE` answered before Mantle touched
anything — bit `1` is `ABS_AUTOHIDE`, bit `2` is `ABS_ALWAYSONTOP`. `changed` is
what **we** did, and is therefore the entire list of things a recovery script
has to undo. Both originals are read with passive calls, so a `--passive` run
leaves a usable note too. (The example above is this machine: `abmState: 1` —
Owen's taskbar is *already* auto-hide, so live Mantle changes nothing about it
and holds no taskbar state at all.)

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

The edges of the pipe (hardened 2026-09-29, proven by `test-protocol.js`):

- **Strict JSON in.** Numbers follow JSON's grammar (`+1`, `01`, `.5` and `1.`
  are errors), a `\u` escape is exactly four hex digits, and nesting stops at
  128 levels. A 200,000-deep request used to overflow the stack, which .NET
  cannot catch, and killed the sidecar with no restore.
- **A 16 MB line cap.** A longer line is read to its newline and dropped unread,
  answered `bad request: the line is over the 16 MB line cap…`; the next line is
  served as usual.
- **Exact JSON out.** NaN and the infinities are written as `null` (they have no
  JSON spelling and used to make the whole line unreadable); a lone surrogate in
  a title or path is written as a `\u` escape and round-trips exactly instead of
  becoming U+FFFD. A reply whose result cannot be serialised still answers its
  caller: `ok:false`, `the answer could not be written (…)`.
- **Integer arguments clamp** to the int range (`w:1e12` is `2147483647`, not a
  huge negative number).
- **Bounded lanes.** Each lane (ui included) holds at most 1024 waiting requests.
  Past that, a request is answered at once with `ok:false`, `reason:"busy"`,
  `busy: "<cmd>" was not queued because the <lane> lane already has N requests
  waiting; try again in a moment`. Undos are never refused. `ping.lanes.refused`
  counts them.
- **Mantle's windows only.** `glass`, `corners`, `region`, `morph`, `place`,
  `raise`, `traywatch`, `appbar` and `desktop` act only on a window owned by
  this sidecar or by its `--parent-pid` (Electron's main process, which creates
  every Mantle window). Anything else is refused: `<cmd>: window N is not one of
  Mantle's own windows, so it was left alone`. Before this, any hwnd went
  through, and `place` on a window whose thread was not pumping blocked the ui
  lane for good.

### Commands

| cmd | args | result |
| --- | --- | --- |
| `ping` | — | `{pid, passive, version, dpiAware, dpiMode, selfHwnd}`, plus `dpiReason` when awareness was not set cleanly. `selfHwnd` is the sidecar's own hidden message window, so a test has a window it owns to point `glass` at — see **DPI** below. `dpiAware` is the protocol handshake: an exe that does not report it predates the auto-hide and app-bar commands |
| `windows` | — | `[{hwnd, title, exe, pid, minimized, foreground, icon}]` |
| `focus` | `{hwnd}` | `{}` — raise it |
| `minimize` | `{hwnd}` | `{}` |
| `close` | `{hwnd}` | `{}` — WM_CLOSE, so the app can still prompt to save |
| `toggle` | `{hwnd}` | `{}` — minimize if it is already foreground, else focus |
| `taskbar` | `{mode:"autohide"}` | `{autohide:true, wasAutohide:bool, verified:bool}` — `ABM_SETSTATE`, read back with `ABM_GETSTATE`. `verified:false` means Windows did not take it, and then `ok` is `false` and **nothing** was changed |
| `taskbar` | `{restore:true}` | `{restored:bool, changedByUs:bool, state:n, verified:bool}` — puts the state back **only if we changed it**; a taskbar the user already had on auto-hide is left alone |
| `taskbar` | anything else | `ok:false` — `taskbar: unknown form; SW_HIDE was removed on 2026-09-21 after it left the taskbar stuck` |
| `appbar` | `{hwnd, edge:"bottom"\|"top", size:px}` | `{rect:[l,t,r,b]}` in **physical pixels** — the rect the caller must move its window to, after dividing by the display's scale factor. `ABM_NEW` once per hwnd, then `ABM_QUERYPOS` + `ABM_SETPOS`; a second call for the same hwnd is a re-position. Moving the window is the **caller's** job |
| `appbar` | `{hwnd, remove:true}` | `{removed:bool}` — `ABM_REMOVE` |
| `workarea` | `{reset:true}` | `{rect:[l,t,r,b]}` — belt and braces: put the work area back to the one captured at startup |
| `workarea` | `{bottom}` \| `{top}` | `ok:false` — `workarea: setting the work area was removed on 2026-09-21; use appbar` |
| `glass` | `{hwnd, mode:"acrylic"\|"blur"\|"off", tint:"#RRGGBBAA"}` | `{applied:bool, mode}` — real blur behind one of **Mantle's own** windows. Allowed in passive (see below). `tint` defaults to `#000000` at 60% (`0x99000000`); a malformed one is an error, never a silent default |
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
| `{"ev":"taskbar","autohide":bool,"reason":".."}` | the taskbar's auto-hide state was set, restored, or found to be set already (`reason: "was already auto-hide"`) |
| `{"ev":"restore","done":bool,"detail":".."}` | the restore path ran, on any exit. `detail` is plain words, one clause per step (`"app bars: 1 removed; taskbar: untouched by Mantle, left alone; keyboard hook: uninstalled; state file: restored:true written"`). Best-effort: on a killed parent, stdout may already be gone — the state file is the record that survives |
| `{"ev":"log","level":"warn"\|"error","message":".."}` | anything a human should know: a missing icon, a hook that would not install, a fallback that kicked in |

## Safety

### The incident, and the rule that came out of it

On **2026-09-21**, the first live run, this sidecar hid the taskbar with
`ShowWindow(Shell_TrayWnd, SW_HIDE)`. Owen's taskbar is set to **auto-hide**.
Mantle was killed, so the `SW_SHOW` never ran — and even when it did, `SW_SHOW`
means nothing to an auto-hide taskbar: explorer's auto-hide state machine had
been left mid-flight and stayed stuck hidden. Hovering the screen edge did
nothing. He had to **reboot**, in the middle of his work.

> **Never call `ShowWindow` or `SetWindowPos` on `Shell_TrayWnd` or
> `Shell_SecondaryTrayWnd`.** Not to hide it, not to show it, not to fix it.

And the principle behind it:

> **Mantle may not hold shell state that needs a living process to undo.** A
> killed Mantle — any process, any moment, any means — must leave Windows
> exactly as usable as it found it.

So both jobs are now done through the OS's own app bar protocol, and both are
safe to die holding:

- **Taskbar** — `SHAppBarMessage(ABM_SETSTATE, ABS_AUTOHIDE)`, the same switch
  as *Settings ▸ Personalisation ▸ Taskbar ▸ Automatically hide the taskbar*. A
  dead Mantle leaves an auto-hide taskbar: an ordinary Windows that reveals its
  bar on a hover. The other state bits are preserved (the call replaces the
  whole state, so it is always an `OR`), the bit is read back to verify, and the
  restore path only unsets it **if we were the ones who set it**.
- **Screen space** — the bar window is registered as a **real app bar**
  (`ABM_NEW` / `ABM_QUERYPOS` / `ABM_SETPOS`). Explorer drops the reservation by
  itself the moment the window dies. `SPI_SETWORKAREA` is gone: it is a global
  setting that outlives the process that made it.
- **Desktop layer and keyboard hook** — a `SetParent` child and a `WH_KEYBOARD_LL`
  hook both die with the process. Nothing to undo.

### Exits

**Every** exit path — `quit`, stdin EOF, parent death, Ctrl+C, console close,
unhandled exception — runs the same restore first: stop the window watcher,
remove every app bar, restore the taskbar state, uninstall the keyboard hook,
write `restored:true` to the state file, *then* emit `{"ev":"restore",…}` and
exit. Each step is wrapped so that one failure never skips the next.

**The order of those last two is a bug fix** (live crash test, 2026-09-21).
Electron was killed; the sidecar did go away and Explorer did reclaim the app
bar, but the state file still read `"appbars":["6358484"],"restored":false`.
Cause: the shutdown used to log `sidecar shutting down` to **stdout first**.
When the parent is killed, the read end of that pipe can still be open with
nobody draining it, so a write does not fail — it **blocks** once the buffer
fills. The window watcher, which emits `windows` events carrying base64 icons,
was already wedged inside the write lock, so the shutdown blocked on that same
lock and the restore never ran. Three changes:

1. **stdout is silenced the instant a shutdown starts** — the whole restore, and
   the state-file write, happen with no stdout anywhere in the path,
   synchronously on the thread that noticed the exit.
2. The two closing lines are written with a **bounded** wait for the write lock
   (250 ms each) rather than an unbounded one.
3. A **hard-exit watchdog** (2 s, `TerminateProcess` on self) is armed first, so
   a wedged pipe, an Explorer that will not answer `SHAppBarMessage`, or a hung
   `Environment.Exit` can never leave a sidecar alive holding shell state.

Measured on the reproduction (a stdout nobody reads, flooded until it wedges):
the state file is written **554 ms before** the process exits, and the exit
still happens 579 ms after EOF.

An error inside a command never kills the process; it answers `ok:false`.

**Sign-out, restart and shut down** (added 2026-09-29). The sidecar is a
winexe, so it has no console and never hears `CTRL_LOGOFF`/`CTRL_SHUTDOWN`;
Windows tells it with `WM_ENDSESSION` to its hidden window and ends it soon
after. That message now runs the same restore as every other exit (a cancelled
sign-out, `wParam` FALSE, changes nothing). Before, the one exit that happens
every day skipped the restore and left `restored:false` in the state file.

**Two crashes at once** (fixed 2026-09-29). When a second background thread
throws while the first is already restoring, its handler now waits for that
restore instead of returning; returning let the runtime kill the process in
the middle of it (measured: exit `0xE0434352`, no `restore` event,
`restored:false`).

**The state file has one writer at a time** (fixed 2026-09-29). Two threads
used to share `<path>.tmp` (246 of 320 writes failed under 8 threads) and an
older snapshot could land after a newer one. Writes are serialised end to end,
and the file is swapped whole with `File.Replace` (copy as the fallback).

**One Sleep at a time** (`session {action:"sleep"}`, fixed 2026-09-29). A
second request while one is on its way, or within 1 s of the call, answers
`{ok:true, already:true}` and never reaches Windows, so a double-click cannot
put a machine that is just waking straight back to sleep.

### DPI — and the app bar that landed 200 px too high

The first live run of the app bar put Mantle's bar **200 px too high and 80%
wide**, and Explorer dutifully reserved that wrong strip. The measurement, from
a DPI-**unaware** probe on this 1920×1080 @ 125% machine:

| call | answer | coordinate system |
| --- | --- | --- |
| `ABM_GETTASKBARPOS` | `0,1020,1920,1080` | **physical** |
| `GetWindowRect(Shell_TrayWnd)` | `0,816,1536,864` | virtualised |

**`SHAppBarMessage` is not DPI-virtualised.** The sidecar was building the rect
from `GetMonitorInfo` (virtualised, 1536×864) and handing it to `ABM_QUERYPOS` /
`ABM_SETPOS`, which read it as physical — a rect for a screen that does not
exist.

So the sidecar is no longer DPI-unaware. `Program.InitDpi` runs as the **first
statement in `Main`** (awareness can only be set before any window exists):
`SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2)`,
falling back to `SetProcessDPIAware()` (system-wide) if that is refused or
missing — pre-1703 Windows has no such entry point. Either fallback or a total
failure is announced on the wire, because it changes what every rect *means*.

Consequences:

- `GetMonitorInfo`, `SPI_GETWORKAREA` and `SHAppBarMessage` now agree: **every
  rect in this protocol is physical pixels.** `SPI_GETWORKAREA` reads
  `[0,0,1920,1080]` here, where a DPI-unaware process saw `[0,0,1536,864]`.
- `ping` reports `dpiAware:true` and `dpiMode:"per-monitor-v2"` (plus
  `dpiReason` if anything was not ideal).
- **The caller converts.** Electron positions windows in DIPs, so it must
  divide the `appbar` rect by `screen.getPrimaryDisplay().scaleFactor` before
  `setBounds`. The sidecar never positions a window it does not own.
- The only window this process owns is invisible and never painted, so
  WinForms' shaky per-monitor support costs nothing.

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
- **Taskbar.** `SHAppBarMessage`, never a window call — see **Safety** for the
  reboot that made that non-negotiable. `ABM_GETSTATE` at startup (passive, so
  it always runs), `ABM_SETSTATE` with `original | ABS_AUTOHIDE` only if the bit
  is not already there, then `ABM_GETSTATE` again to verify. There is no watcher
  any more and nothing to re-hide: explorer owns the state, and if it changes it
  back that is explorer's business, not a fight for us to pick.
- **App bars.** `ABM_NEW` once per window, then `ABM_QUERYPOS` (explorer pushes
  the rect clear of bars already there) and `ABM_SETPOS`, on the primary monitor
  only. The callback message is `WM_USER+0x2A5`, a value Chromium does not
  interpret: we register for the OS's sake, not to listen. Rects are **physical
  pixels** — `SHAppBarMessage` is not DPI-virtualised, which is the whole story
  under **DPI**. The returned rect is the caller's to move its window to, scaled
  to DIPs — the sidecar never positions a window it does not own.
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
- **Glass.** `SetWindowCompositionAttribute` with a `WCA_ACCENT_POLICY`, the
  undocumented export TranslucentTB and electron-acrylic-window use.
  **Why not Electron's `backgroundMaterial:'acrylic'`:** that asks DWM for a
  system backdrop, and DWM paints a system backdrop only on the **active**
  window. Mantle's bar must never take focus, so it is permanently inactive and
  the acrylic rendered as a flat solid. An accent policy renders on inactive
  windows. `GradientColor` is **ABGR** (`0xAABBGGRR`), not the ARGB you would
  write in CSS — the swap happens here so no caller has to remember it. A
  Windows without the export says so and the window renders solid.
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
- `appbar` reserves space on the **primary monitor only**
  (`MonitorFromPoint(0,0)`), and only along the **top** or **bottom** edge.
- The desktop reparent (`desktop`) reports success if **any** of `GetParent`,
  `GetAncestor(GA_PARENT)` or `IsChild` puts the window under the target, and
  failure only when the window is demonstrably still top-level. `GetParent`
  alone is not enough: it returns the *owner* for an owned top-level window, and
  on 2026-09-21 it made a reparent that had worked report as a failure.
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
SIDECAR TEST: 47 passed, 0 failed
```

It is safe to run while someone is using the machine: passive mode is what makes
that a guarantee rather than a hope, and the test asserts the refusals verbatim.
It also proves both self-exit paths (`quit` → 0, stdin EOF → gone in well under
2 s), so a test run can never leave an orphaned sidecar behind.

It holds the line on the incident too: `taskbar {show:false}` and
`workarea {bottom:44}` must answer **"removed"**, the state file must exist with
the original state from the first moment of a run and say `restored:true` after
`quit`, and a run without `--state-file` must warn. It holds the line on the DPI
bug too: `ping` must say `dpiAware:true`, and the captured work area must be at
least as wide as what a DPI-unaware process sees (1920 vs 1536 here) — if that
ever regresses, the app bar is landing 200 px off again.

And it reproduces the crash-test bug directly: one instance is flooded with
`icon` replies while **nothing reads its stdout**, until the pipe wedges, and is
then sent EOF. It must still write `restored:true` and still exit. State files
go to the OS temp directory and are deleted afterwards: a test run leaves
nothing behind.

```
node sidecar/test-protocol.js --exe=<your build>
PROTOCOL TEST: 24 passed, 0 failed
```

The pipe's own edges: hostile input (deep nesting, bad escapes and numbers, a
17 MB line), exact output (lone surrogates, NaN, an unwritable result), clamped
integers, flooded lanes, the state file under 8 writers, the ownership gate
(against a hidden window it creates in a throwaway PowerShell process, never
anyone's real window), GDI/USER/handle counts over 150 rounds of the window
commands, two threads crashing at once, `WM_ENDSESSION` (posted from another
process, as Windows would) and the Sleep guard. It uses `selftest {op}`, a
passive-only probe command like `sleep`, and `session {simulate:true}`, which
runs the real Sleep path with a 200 ms wait standing in for the suspend; both
are refused outside `--passive`.

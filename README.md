# Mantle

## If the Windows taskbar disappears

Run this. It needs no Node, no Electron and no Mantle running:

```
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\user\mantle\tools\restore-windows.ps1"
```

(or `npm run restore` from the repo). It stops Mantle — and only Mantle, never
another Electron app — puts the taskbar's auto-hide flag back to whatever it was
before Mantle started, resets the work area, checks that the taskbar is really
there, and prints `verified` before exiting 0. If it is still wrong, run it again
with `-RestartExplorer`.

**It is safe to run when nothing is wrong**: every step reads the current state
first and only writes when it differs.

If even that will not run: **Ctrl+Shift+Esc → find "Windows Explorer" → Restart**.

To stop a running Mantle cleanly from a script or another terminal:
`npm run quit` (`electron . --quit`) — it asks the running instance to put
Windows back and exit, and needs no keystroke and no tray click.

`electron .` on its own does **nothing** now. Live mode has to be asked for by
name: `npm run live`, or `electron . --live`. Live mode prints the recovery
command above, and the path of the file holding your original shell state, three
seconds before it touches anything.

### Why all of this exists

2026-09-21, the first live run: Mantle hid the `Shell_TrayWnd` window with
`ShowWindow(SW_HIDE)`. Owen's taskbar is set to **auto-hide**, and hiding the
window of an auto-hiding taskbar wedges explorer's own show/hide state machine —
`SW_SHOW` on the way out did not bring it back, and he had to **reboot**, mid
task.

Everything above follows from the rule that came out of it: **a killed Mantle
must leave Windows exactly as usable as before.** No shell state may need a
living process to undo. So Mantle now flips only the OS-managed auto-hide flag
(`ABM_SETSTATE`), which Windows itself owns; its bar is a **real app bar**, which
Explorer drops by itself the moment the window dies, instead of an
`SPI_SETWORKAREA` call that would outlive the process; the original state is
written to a file *before* anything changes; and the recovery script above reads
that file from outside.

---

A shell **layer** over Windows 11. explorer.exe keeps running underneath: Mantle
puts the Windows taskbar on auto-hide and puts its own bar, launcher and desktop
layer on screen in the instrument-glass look the browser uses. One keystroke, one
tray menu item or one crash puts Windows back exactly as it was.

Electron draws every pixel. One C# sidecar makes every Win32 call. Nothing else
talks to Windows.

```
  Electron (main.js)                        C# sidecar
  ├── bar        ui/bar/        44px        JSON lines over stdin/stdout
  ├── launcher   ui/launcher/   680x460     ├── window list / focus / close
  ├── desktop    ui/desktop/    full screen ├── the taskbar's auto-hide flag
  └── preload.js -> window.mantle           ├── the bar's app-bar registration
                                            ├── reparent the desktop under the wallpaper
                                            ├── the solo-Win-tap hook
                                            ├── volume + the notification area
                                            └── the shell-state file, written first
```

## Running it

```
npm install
npm run live              # LIVE: taskbar to auto-hide, bar becomes an app bar
npm start                 # prints how to run it and exits 2, touching nothing
npm test                  # test mode: three ordinary windows, Windows untouched
npm run shots             # test mode, capture the three windows, quit
npm run quit              # ask a running Mantle to put Windows back and stop
npm run restore           # put Windows back with no Mantle running at all
npm run check             # node --check everything + which lane files exist
npm run build:sidecar     # compile the sidecar with the in-box csc.exe
```

`npm start` is deliberately the safe one. Typing `electron .` to check that the
app still boots used to reach into the live shell; that is what cost a reboot.

Flags (`electron . <flags>`):

| flag | what it does |
| --- | --- |
| `--live` | **required** to run live. Without it and without `--test`, Mantle prints one line and exits 2 having touched nothing. With it, it prints the recovery command and the state-file path and waits 3 seconds before starting |
| `--quit` | ask the running instance to run its verified restore path and exit, then exit 0. Creates no window, spawns no sidecar, changes nothing. Exits 1 with a plain message when no instance is running |
| `--test` | test mode: the sidecar runs `--passive` and refuses every shell change; the three windows are plain resizable windows; nothing is hidden, hooked or reparented |
| `--profile-name=<x>` | **required with `--test`.** userData goes to `%TEMP%\mantle-test-<x>`, which also keys the single-instance lock, so a test run can never collide with the live shell. `tools/toback.ps1` and `tools/kill-test.ps1` match this flag |
| `--screenshot=<dir>` | test mode only: 4s after the windows load, capture `bar.png`, `launcher.png`, `desktop.png` into `<dir>`, then quit |
| `--bar-edge=top\|bottom` | which edge the bar sits on (default `bottom`) |
| `--no-desktop` | skip the desktop layer entirely |
| `--no-acrylic` | no Windows 11 acrylic on the bar and launcher: the old transparent windows with lane C's CSS glass only |

### Glass

The bar and the launcher use **real Windows 11 acrylic**
(`backgroundMaterial: 'acrylic'`), so they blur what is genuinely behind them on
the desktop — something `backdrop-filter` cannot do, because CSS can only sample
pixels the page itself composites.

The trap: **the material only renders on a window with `transparent: false`.** A
transparent window has no backdrop for DWM to put a material on, so the option is
accepted and silently does nothing. The two acrylic windows are therefore opaque
windows with `backgroundColor: '#00000000'` and transparent page bodies. The
desktop layer keeps `transparent: true` and gets no material — it sits *under*
the wallpaper, so there is nothing behind it to blur.

Which path was taken is in `state.glass` — `{ material: 'acrylic' | 'css',
reason }` — and the desktop's *Needs attention* strip shows it whenever it is not
acrylic, whether that was `--no-acrylic` or Windows refusing.

## Getting Windows back

Six ways. The first five run the same verified restore path — **app bar removed,
then the taskbar's auto-hide flag back to its original, then read back to
confirm** — and print one line saying so, or the failure and the recovery
command. The sixth needs nothing of Mantle to be working at all.

1. **Ctrl+Alt+Shift+Backspace** — the kill switch. Restores, then quits.
2. The **tray menu** — *Put Windows back (keep Mantle open)*, or *Quit Mantle*.
3. `electron . --quit` / `npm run quit` from any terminal or script.
4. `mantle.call('shell.restore')` from any Mantle page (Mantle keeps running).
5. **Killing Mantle.** The sidecar watches its parent pid and its own stdin; when
   either goes away it restores everything itself before exiting, and says so
   with a `restore` event. If it exits without confirming, Mantle says *that*
   rather than assuming.
6. **`npm run restore`** — the standalone script at the top of this file. No
   Node, no Electron, no Mantle. This is the one that matters: nothing about
   getting Windows back depends on Mantle being alive or correct.

The restore path is idempotent and swallows every error. If a step fails it says
so in the state (see below) *and* prints the recovery command, rather than
throwing.

If Mantle starts and finds the state file marked `restored: false` — a previous
run died without putting Windows back — it runs the recovery script first,
synchronously, before it touches anything, and every reason in the state says
that it happened.

## Nothing fails silently

Every helper, poller and fallback carries a **reason in plain words**, and the
desktop layer prints every unhappy one in its *Needs attention* strip. A log line
does not count; if it is not on screen it did not happen.

The shape, pushed to every window on every change and readable with
`mantle.call('state.get')`:

```js
{
  mode:      'live' | 'test',
  edge:      'bottom' | 'top',                  // from --bar-edge; the bar flips its popovers on it
  sidecar:   { status: 'ok'|'starting'|'down', reason },
  taskbar:   { autohide, wasAutohide, hidden, reason },   // hidden mirrors autohide
  workarea:  { reserved, reason },                        // "the bar is a real app bar"
  desktop:   { attached, mode, reason },
  hotkey:    { winTap,   reason },
  tray:      { status: 'ok'|'unavailable', reason },
  glass:     { material: 'acrylic'|'css', reason },   // real DWM acrylic, or CSS
  shortcuts: { killSwitch, launcher, reason }   // globalShortcut registration
}
```

A missing `ui/bar/index.html` or `ui/launcher/index.html` loads a placeholder
naming the file; a missing `lib/launcher-index.js` makes `apps.index` answer with
an empty list and a source row that says which lane owns it; a missing sidecar
exe is built once from `sidecar/build.ps1` and, if it still is not there, becomes
`sidecar: down` with the path in the reason while everything else keeps running.

## The bridge

Pages run with `contextIsolation` and `sandbox` on — no `require`, no node.
`preload.js` exposes exactly one object:

```js
mantle.call(name, args) -> Promise<result>   // rejects with an Error in plain words
mantle.on(event, cb)    -> unsubscribe()
```

| call | |
| --- | --- |
| `state.get` | the object above |
| `windows.list` | `[{hwnd, title, exe, pid, minimized, foreground, icon}]` |
| `win.focus` `win.minimize` `win.close` `win.toggle` | `{hwnd}` |
| `launcher.show` `launcher.hide` | |
| `bar.popover` | `{open, height, key}`: borrow up to 320px of extra window height so a popover is not clipped by the 44px bar. Grows away from the bar's screen edge; `{open:false}` gives it back |
| `apps.index` `apps.search` `apps.launch` | the launcher's index (`lib/launcher-index.js`) |
| `volume.get` `volume.set` | `{level, muted}` |
| `open` | `{target}`: http(s) goes to Owen's browser, `scheme:` to the shell, a path to the shell |
| `sys.stats` | `{cpu, memUsed, memTotal, battery}` |
| `tray.list` `tray.click` | the Windows notification area, mirrored |
| `shell.restore` `shell.quit` | |
| `net.probe` | `{url}` → `{ok, reason}`, loopback only (the desktop uses it for Mission Control) |

Events: `windows`, `state`, `launcher:visible`, `tray`. `windows` and `state`
also fire once immediately on subscribe, so no page renders an empty first frame.

## Layout

```
main.js              flags, windows, IPC, sidecar lifetime, tray, kill switch, restore
preload.js           window.mantle, and nothing else
lib/args.js          flag parsing; refuses to boot on a flag that would be dangerous
lib/state.js         the state object above
lib/sidecar.js       spawn, JSON lines, timeouts, restarts, the build-once attempt
lib/windows.js       the three windows, live shape and test shape
lib/apps.js          lane D's index module, wrapped so a missing one is a visible state
lib/sys-stats.js     cpu from os.cpus() deltas, memory, battery via one WMI probe
lib/tray-icon.js     the tray icon, drawn in code so the accent colour has one home
lib/placeholder.js   the "this file does not exist yet" page
lib/open-target.js   http(s) -> Owen's browser, scheme: -> shell, path -> shell
lib/net-probe.js     loopback reachability with a real reason
ui/shared/tokens.css the palette. Every colour in Mantle comes from here
ui/bar/              the bar
ui/launcher/         the launcher
ui/desktop/          the desktop layer: clock, stats, Mission Control, state strip
sidecar/             the C# sidecar and its build script
tools/toback.ps1     send a test instance's windows to the back without activating them
tools/kill-test.ps1  stop ONE test instance by profile name (never `taskkill electron.exe`)
tools/restore-windows.ps1  put Windows back with no Node, no Electron, no Mantle
tools/check.js       node --check everything + a present/missing list of the lane files
```

## Testing rules

Test instances only, and always this way:

```
npx electron . --test --profile-name=mainlane [--screenshot=<dir>]
powershell -NoProfile -File tools/toback.ps1 -Match mainlane      # immediately after
powershell -NoProfile -File tools/kill-test.ps1 -Match mainlane   # to stop it
```

`--profile-name` is what both scripts match, as the whole flag. Never
`taskkill electron.exe`: Owen's browser is an Electron app too.

Status: first slice, 2026-09-21.

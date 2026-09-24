STATUS: READY

# Mantle features: the main-process API (wave 3, 2026-09-24)

A feature is `lib/features/<name>.js` (found at start-up, no main.js edit), its pages in
`ui/<name>/`, and its sidecar commands in `sidecar/<Name>.cs` (see `sidecar/Features.cs`).
Implemented by `lib/features.js`; proved by `node lib/features.test.js [--electron]`.

Loaded: every `*.js` directly in this folder except `*.test.js` and files starting with `_`
(put helpers in `_<name>-util.js` or a subfolder). Sorted by file name. A module that does not
load, breaks the contract, or throws in `install()` is that feature DOWN with its reason on the
desktop strip, in the tray and in mantle.log. Mantle and the other features carry on.

## The module

```js
'use strict';
const path = require('path');
module.exports = {
  name: 'clipboard',                  // lower-case letters/digits, MUST equal the file name
  label: 'Clipboard history (Win+V)', // tray checkbox text (and the strip's row title)
  defaultOn: true,                    // the tray switch until Owen flips it (then it is remembered)
  chords: ['Win+V'],                  // taken from Windows ONLY while on AND healthy AND live
  observe: [],                        // keys reported to you, never swallowed
  install(ctx) {                      // may be async (10 s to settle, else the feature is down)
    const { BrowserWindow } = require('electron');
    const win = new BrowserWindow({ show: false, frame: false, transparent: true, skipTaskbar: true,
      webPreferences: { preload: ctx.preload, contextIsolation: true, sandbox: true } });
    win.loadFile(ctx.page('index.html'));
    ctx.command('list', async () => (await ctx.sidecar.send('clip.list')).result);
    ctx.onChord('Win+V', () => { if (ctx.enabled()) { /* show the panel */ } });
    ctx.onEnabled((on) => { if (!on) win.hide(); });
    return { stop(why) { if (!win.isDestroyed()) win.destroy(); /* put Windows back */ } };
  },
};
```

Chord names: `Win+S` `Win+V` `Win+Tab` `Win+Left` `Win+Right` `Win+Up` `Win+Down` `Win+Z`
`Win+Shift+S` `PrintScreen`, and the bare volume keys `VolumeUp` `VolumeDown` `VolumeMute` (any
modifier held leaves them Windows'). Observed keys (seen, never taken): the same three volume keys;
one feature may not list a key both as a chord and as observed.
A chord may be claimed by ONE feature (the second claim is refused and named, in file order).
Reserved names (Mantle's own prefixes): features state sys windows bar launcher desktop switcher
notifs qs wallpaper shell tray media battery volume net apps mantle test.

**Never name a sidecar request argument `id`** (found twice on 2026-09-24, by taskview and topbar):the protocol's request id travels in the same object, so an `id` argument silently overwrites it andthe reply is lost. Use `desktop`, `item`, `window` or similar.
## ctx

| member | what it does |
|---|---|
| `ctx.name` | the feature's name |
| `ctx.flags` | `{ test, live }` (frozen) |
| `ctx.log(text)` | one line to mantle.log: `mantle: <name>: <text>` (newlines flattened) |
| `ctx.sidecar.send(cmd, args, { timeoutMs })` | `Promise<{ ok, result }>` or `{ ok:false, error }`. NEVER rejects. Default 4000 ms. `args` must not use the keys `id` / `cmd` |
| `ctx.sidecar.on(ev, fn)` | `Features.Event("clip", ...)` arrives as `fn({ ev:'clip', ... })`. Returns unsubscribe. Dropped automatically after stop() |
| `ctx.sidecar.onReady(fn)` | ADDED. `fn()` now if the sidecar is up, and again after EVERY sidecar restart: re-apply sidecar-side state here (a hidden OSD, a watch). Returns unsubscribe |
| `ctx.sidecar.ready` | ADDED. boolean getter: can a call be made right now |
| `ctx.command(verb, async (args) => result)` | registers `<name>.<verb>` in main's COMMANDS: a page calls `window.mantle.call('<name>.<verb>', args)`; call-log logging applies. Throws on a duplicate. Returns the full name. After stop() it throws "... is stopped" |
| `ctx.onChord(chord, fn)` / `ctx.onKey(key, fn)` | `fn(chord)` / `fn(key)`. Only for names your module lists (else throws). Return unsubscribe |
| `ctx.health(ok, reason)` | state piece `features.<name>`. `health(false, 'why')` = your chords go back to Windows at once and the strip + tray show `why`. `health(true)` takes them back. Call it on every change (page crashed, sidecar command missing, ...). Repeats are free |
| `ctx.enabled()` / `ctx.onEnabled(fn)` | the tray checkbox; `fn(bool)` on each flip. You are installed even while OFF: honour it (no panel, no Windows changes while off) |
| `ctx.page(file = 'index.html')` | absolute path `ui/<name>/<file>` |
| `ctx.preload` | absolute path of `preload.js`: the same `window.mantle.call/on` bridge |
| `ctx.broadcast(event, payload)` | to every Mantle page (`window.mantle.on(event, cb)`) |
| `ctx.push(win, event, payload)` | to one window; false if it is gone |
| `ctx.replay(event, () => payload)` | ADDED. `mantle.on('<name>.<x>')` in a page gets `payload` at once on subscribe (no empty first frame). Event must start with `<name>.` |
| `ctx.host.openLauncher({ mode, query })` | shows the launcher; BEFORE showing, its page gets event `launcher.open` = `{ mode, query, from: '<name>' }` (`mode:'search'` is the search lane's to handle in ui/launcher). Throws if there is no launcher window |
| `ctx.host.barRect()` | the bar's rect in DIP (its SHAPE in hover mode), or null |
| `ctx.host.display()` | the display under the cursor: `{ id, bounds, workArea, scaleFactor, primary, cursor }` (DIP) |
| `ctx.settings.get(key, dflt)` / `.set(key, value)` | JSON in `<userData>/features/<name>.json` (live `%APPDATA%\mantle`, test `%TEMP%\mantle-test-<profile>`). Values are copied (JSON round trip). `set` throws in plain words if it cannot write. `.file` = the path |
| `ctx.test.fireChord(chord)` / `.fireKey(key)` | TEST ONLY. `ctx.test` is `null` in a live run. Routes exactly like the hook would (so a chord for a feature that is off/unhealthy is NOT delivered). Returns `{ delivered, feature }` / `{ delivered, handlers }` or `{ delivered:false, reason }` |

Handler errors: a throw (or rejected promise) in an onChord / onKey / onEnabled / sidecar.on /
onReady handler is logged with its stack and sets `health(false, 'its <what> handler failed (...)')`,
so the chord goes back to Windows. Call `ctx.health(true)` when you have recovered.

## Keys: what the hook does with your chords

Main sends `hotkey {chords, observe}` (sidecar/Hotkey.cs) with the chords of every feature that is
on AND healthy, and the keys of every feature that is on. Coalesced (one call per burst of
changes), re-sent on every sidecar restart, and only while Mantle is LIVE: a `--test` instance
never hooks (the passive sidecar refuses) and `pieceWords` says so; drive it with the test hooks.
The rules (KeyMachine in sidecar/AltTab.cs, proved by `hotkey {op:'simulate'}` in
sidecar/test-sidecar.js):
- EXACT modifiers: `Win+Left` never matches Win+Shift+Left; `Win+S` and `Win+Shift+S` are
  different chords; Ctrl or Alt held is never a chord (Alt+PrintScreen, Win+PrintScreen,
  Ctrl+PrintScreen stay Windows').
- The keydown AND its keyup are swallowed; auto-repeat is swallowed with NO second event (a held
  Win+Left is one event); releasing and pressing again with Win held (Win+S, S) is a second event.
- A key already down before its modifier (Tab held, then Win) stays Windows' to its keyup.
- Win and Alt keyups are never swallowed; the Win-up after a chord gets the VK 0xFF partner key
  so Start does not open (same trick as Win+N).
- Observed keys: `{ev:'key'}` on EVERY keydown (repeats included: a held Volume Up keeps
  stepping), never swallowed: Windows still does what the key does.
- Hook down / sidecar down / Mantle "put Windows back": every key is Windows' again, and the
  strip says so if a feature expected its chord.

## State, strip and tray

`state.features.<name>` = `{ label, on, ok, reason, keys, keysReason, broken, stopped }`.
lib/state.js problems() and ui/desktop/desktop.js show a row (title = label) when the feature is
ON, not stopped, and either `ok === false` (reason) or, outside test mode, `broken` (chords that
should be Mantle's and are not). The tray has a checkbox per feature and the failing reason
under it. `window.mantle.call('features.list')` returns every feature's live record.

## stop()

Runs on Mantle's "put Windows back" road (quit, kill switch, tray "Put Windows back", and in
`--test` on `--quit` too), after the taskbar is restored and before the hook is removed. Every
feature's stop() runs AT ONCE with a 2.5 s deadline each; a throw or a hang is logged and
abandoned, never waited for. After stop() your commands answer "stopped", your handlers and
sidecar.on subscriptions are gone, and nothing restarts you until Mantle restarts (that includes
the tray's "Put Windows back (keep Mantle open)"). Anything you change in Windows must ALSO be
put back by the sidecar at its next start if a crash skipped stop() (see EdgeClip.ClearStaleAtStartup).

## Windows (your BrowserWindows)

Copy `lib/switcher.js` `createWindow()` (~line 263): pre-created at install, `show:false`,
`frame:false`, `transparent:true`, `skipTaskbar:true`, `hasShadow:false`, `focusable:false`
unless it takes typing, `backgroundThrottling:false` if it must be ready instantly, the
`webPreferences` block (preload = `ctx.preload`, contextIsolation, sandbox, no nodeIntegration),
`will-navigate` prevented, `setWindowOpenHandler` deny, `render-process-gone` / `unresponsive` /
`did-fail-load` -> `ctx.health(false, ...)`. Parked off screen and revealed, never created per
use. In `--test` (ctx.flags.test): never put a window in front of Owen. Either keep it hidden
(its page still runs; `lib/features.test.js` does exactly that) or `showInactive()` it and run
`tools/toback.ps1 -Match <profile>` like the test bar. Never `focus()` in a test.

## Testing

- Unit: `lib/features/<name>.test.js` (yours). `createFeatures` + a fake sidecar, as in
  `lib/features.test.js` (harness() / fakeSidecar()).
- Sidecar: `sidecar/test-<name>.js` on `sidecar/test-lib.js`:
  `const T = require('./test-lib'); const s = await T.startPassive(); await s.send('clip.list');
  await s.waitEvent('clip', 3000); await s.stop(); process.exit(T.checker('CLIP').summary())`
  (see its header). Passive: every write must answer `T.PASSIVE_REFUSAL`.
- End to end in ONE Electron test instance (take a slot per the rules):
  `MANTLE_SIDECAR_EXE=<your exe> npx electron . --test --profile-name=<lane>` then
  `tools/toback.ps1 -Match <lane>`. Drive your chord WITHOUT a keyboard:
  `LOWCPU=0 npx electron . --test --profile-name=<lane> --test-chord=Win+V` (or `--test-key=VolumeUp`)
  - a second instance hands its argv to the running one and exits; it logs
  `mantle: Win+V from a second instance: {"delivered":true,...}`. LOWCPU=0 is for that
  MESSENGER only: the machine-wide one-browser lock would make it wait on the instance it is
  messaging (measured deadlock, 2026-09-24). A page can also call `features.fire` `{chord}` /
  `{key}` (test only). Stop with `LOWCPU=0 npx electron . --quit --test --profile-name=<lane>`
  (runs your stop()) or `tools/kill-test.ps1 -Match <lane>` (does not).
- `MANTLE_FEATURES_DIR=<dir>` loads features from another folder, in `--test` ONLY (ignored,
  with a log line, in a live run).
- `node lib/features.test.js --electron` is the worked example of all of the above.

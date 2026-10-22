# PERF.md: how fast Mantle's surfaces must be, and how that is checked

Every new or changed surface meets these rules. A surface is anything the user opens with a key or a click:
Settings, Task Manager, Files, the launcher, clipboard, notes, and every pop-up after them.
`tools/perf-budget.js` (the gate) measures them; a broken budget fails it.

Source: `design notes: mantle-replace-windows`, section 3 (R1-R10) and P0. That plan was written when it
assumed some windows would be pre-made, so some rules below are changed. The changes are listed at the end.

## The user's rule on RAM (2026-10-15)

> "no i dont want these open in the backround i need to save ram ... there can be an option to have them
> open backround though"

- **Default: nothing is pre-made.** No hidden Settings, Task Manager or Files window waits in the background.
  These three must be fast **cold**: light first paint, last-known data from a disk cache, the rest
  loaded after the paint.
- **Opt-in:** each surface has its own config key: `keepReady.settings`, `keepReady.taskmgr` and
  `keepReady.files`. All three default to `false`. When one is on, that surface keeps a hidden window ready.
  It is destroyed while a game runs and made again afterwards.
- A new surface may reuse a window Mantle already has. For example, the launcher window can host Run
  and Win+X. That is allowed only if it adds no RAM.

## The numbers

All times run from the trigger to the renderer's **second requestAnimationFrame after the window shows**,
with real content on screen. The trigger is the hook's chord event or the click's IPC, timestamped in
main.

| What | Typical (p50) | p95 | Never more than |
|---|---|---|---|
| **Warm open: visible** (a window that already exists) | 50 ms | 100 ms | - |
| **Warm open: usable** (keyboard in, cached rows drawn) | - | 150 ms | - |
| **Cold open: visible** (a new window: the default for Settings, Task Manager, Files) | - | 400 ms | **1 s** |
| **Cold open: usable** | - | - | **1 s** |
| Fresh data replaces cached rows | - | 300 ms | never blocks input |
| Bar pop-up paint | - | 80 ms | - |
| Low-level keyboard hook decision | - | 1 ms | (Windows drops slow hooks) |

## RAM

- **Mantle's total at rest is 650 MB private or less** (Electron, all processes; the sidecar is counted
  separately). This assumes every `keepReady` flag is off.
  - The plan's pre-load option would have added about 110 MB: all three surfaces, reaching about 720 MB.
    Under the user's default, Settings, Task Manager and Files add **0 MB at rest**.
  - The live total is checked by the live shell's 30-min memory line.
  - The gate can't check it. A `--test` copy's main process runs 373-479 MB, against 202-212 MB live, so
    the gate judges every process except main against 650 - 210 = **440 MB**.
- **Each `keepReady` flag that is on may cost up to 45 MB private** (and 20 MB working set after the
  trim) for its hidden window.
  - The total budget grows by that much per flag the user turns on, and by nothing else.
  - Each keepReady window states its measured cost in its commit message and in the 30-min memory log
    line.
- A visible surface costs at most 80 MB private.
- A window kept hidden for a short while after a close counts as the same 45 MB keepReady cost while it
  lasts. Today that is Settings and Task Manager for 3 minutes. It must also use 0 CPU (below).

## CPU at rest

- **A hidden window uses 0 idle CPU:** no timers, no requestAnimationFrame, no polling.
  - The gate allows 0.1 % of one core, because that is the floor of its 10-second sample.
- A visible surface sitting idle uses at most 0.5 % of a core.
- A sidecar watcher uses at most 0.1 % of a core. Where Windows has an event for it, the watcher is
  event-driven.

## Nothing waits on the open path

None of these may happen before the first paint:
- `sendSync`;
- an awaited sidecar call;
- a PowerShell, WMI or other process spawn;
- a disk scan or network call;
- glass or wallpaper.

Show the last-known data from a cache, refresh after the paint, and redraw only the rows that changed.
Glass and wallpaper never hold a show back:
- a warm hold is 0 ms;
- a cold hold is at most 50 ms;
- otherwise, show solid and swap the glass in after.

The sidecar stays responsive:
- anything over ~5 ms runs off its ui lane;
- no request holds a lane for more than 0.5 s.

## One truthful log line per open (R7)

Every open writes exactly this line, **after** the visibility check:

```
<surface>: opened (warm|cold) via <trigger>: shown X, painted Y, interactive Z ms
```

- `warm` means the window already existed; `cold` means a new one was made. It does not mean "the 2nd
  open" (Files' old `open #2 (warm)` label means that, and must go).
- A value that does not apply (for example, a window a `--test` run keeps hidden) is written as `-`.
- The gate reads this line. A surface without it is reported **"not instrumented yet"** and is judged
  on the gate's own outside probe instead. It is never passed silently.

## Slow is never silent

A surface that cannot show within 1 s hands off to Windows' own version and says why (the No Silent
Failures rule).

## Every Windows change can be undone without Mantle

- Hooks die with the process.
- Any Windows setting Mantle changes is written to `shell-state.json` **before** the change.
- The setting is put back by any of these:
  - on quit;
  - by the next start's dirty guard (after a crash);
  - by the supervisor;
  - by `tools/restore-windows.ps1`, which needs no Node and no Mantle.
- A registry hand-off points at a stub that falls back to Windows whenever Mantle is down.

The perf gate does not check these. The restore and supervisor tests own this rule.

## The gate: `tools/perf-budget.js`

```
node tools/perf-budget.js [--n=10] [--slack=1.5] [--surfaces=settings,files] [--strict] [--no-lock]
node tools/run-suite.js --perf          # the same gate, as the opt-in suite entry perf:budget
```

**What it does.** It starts one invisible `electron . --test` copy of the checkout, then runs these steps:

1. **No pre-made windows.** No Settings, Task Manager or Files window exists at rest.
2. **At rest.** It measures total private RAM, and each hidden window's CPU over 10 s.
3. **Opens.** For each surface:
   - It opens Settings, Task Manager and Files **cold** n times (default 10), destroying the window
     before each open.
   - It opens every surface **warm** n times, closing it each time the way its X button or toggle does.
   - Opens go through the existing test hook: main's `second-instance` handler with
     `--test-chord=<chord>`. The launcher uses the bar's `launcher.show`.
4. **Timing.** It uses the R7 line when the surface writes one. Otherwise it uses the **outside probe**:
   - This same file is loaded into the test copy's main process (`NODE_OPTIONS=--require`, test only).
   - It times trigger to the second rAF after `show`.
   - For a window `--test` never shows, it times trigger to `ready-to-show`.
   - It also lists sidecar calls and process spawns that happened before the paint.
5. **What surfaces keep.** For each surface, it measures RAM while open, and the cost of whatever it
   keeps after a close.
6. **Re-run.** A broken surface is re-run once. It fails only if the re-run breaks too.
7. **Output.** It prints a table, a `FAIL` line per broken budget, and one summary line:

```
perf-budget: P passed, F failed; U not instrumented yet, D no data (slack 1.5x, n 10, machine cpu 23%) -- <what broke>
```

**Exit codes:**
- 0: every budget was kept.
- 1: a budget broke. With `--strict`, a surface that is not instrumented also gives 1.
- 2: the gate could not run.

The full numbers go to a JSON file and the test copy's log goes beside it (paths printed).

**Slack.** Every time budget is multiplied by `--slack`. The default is **1.5**:
- The plan's cloud runner was given 1.5x headroom.
- The first real run (below) bears it out. Steady opens fit slack 1: the launcher's p50 was 45 ms against
  50. Cold p95 on this i3, run at Below Normal, needed the 1.5. Settings' cold p95 was 464 ms: it fails
  400 and passes 600.
- Single spikes are not slack's job. A busy machine adds one-off opens of 1.2-6.7 s (launcher 1323 ms,
  task manager 6665 ms). With n 10, p95 is the slowest open, so one spike fails it. The one re-run
  absorbs these: every spike in the first run was gone on its re-run.
- The 1 s cold ceiling is **never** scaled: it is the user's "never".
- RAM budgets are not scaled: a busy machine does not change bytes.
- On a quiet machine, use `--slack=1` for the strict numbers.

**Machine rules** (the gate does these itself; pass `--no-lock` only when the caller already holds the
mutex, as run-suite does):
- It takes `%TEMP%\claude-heavytest.mutex` (an atomic `mkdir`, with `owner.txt` inside), then
  `%TEMP%\claude-headless-browser.lock` (an exclusive file holding `{"pid","time","label"}`; a lock whose
  pid is gone is stale).
- While waiting, it holds a ticket in the lanes' queue (`%TEMP%\claude-heavytest.queue`, one ticket per
  lane, lowest number first) and checks every 60 s.
- It waits for 2.5 GB of free RAM.
- It refuses to run while a game is running.
- It runs at Below Normal, and waits up to ~3.5 min for the machine's CPU to drop under 45 %.
- It stops only its own process tree, by pid. It never kills by image name.

**Where it runs.** On this laptop, locally: cloudtest is refused while GitHub billing is blocked. When
billing is back, the `mantle-ui` cloud recipe can run the same command on the Windows runner.

## Baseline (master e7ee86a, 2026-10-16 01:03)

This is the first real run: `node tools/perf-budget.js`, n 10, slack 1.5, Below Normal, machine CPU
19-22 %. It took 11 min. Times are ms from the trigger in main.

Its summary line:
`25 passed, 6 failed; 5 not instrumented yet, 4 no data`.

- No surface writes the R7 line yet, so every time below is the outside probe's.
- For cold opens, "painted" is `ready-to-show`, because `--test` never shows these three windows.

| Surface | Open | painted p50 | p95 (= slowest of 10) | Verdict at slack 1.5 | RAM while open | Kept after close |
|---|---|---|---|---|---|---|
| Settings | cold | 233 | 464 | pass (on the re-run; the first run's slowest was 977) | 44 MB | hidden, 41 MB private / 100 MB ws |
| Settings | warm | - | - | no data: no R7 line, and `--test` never shows it | | |
| Task Manager | cold | 174 | 898 | **fail** p95 > 600 (also on its first run: 6665) | 41 MB | hidden, **56 MB** private / 120 MB ws: over the 45 MB keepReady cost |
| Task Manager | warm | - | - | no data (as Settings) | | |
| Files | cold | 179 | 509 | pass | 38 MB | destroyed (nothing kept) |
| Files | warm | - | - | no warm path: a close destroys the window | | |
| Launcher | warm | 45 | 59 | pass (on the re-run; the first run had one 1323 ms open) | 52 MB | (pre-made) |
| Clipboard | warm | 84 | 1213 | **fail**: p50 > 75 and p95 > 150, on both runs (the first run's p95 was 257) | 32 MB | (pre-made) |
| Notes | warm | - | - | no data: no R7 line, and its open is never shown in `--test` | 29 MB | |

At rest:
- **The test copy's total was 784 MB** of Electron private memory, against the 650 MB budget.
- The live shell's own 30-min memory lines read **549-557 MB** the same night.
- The gap is all in the **main process**:
  - --test copies (measured 10-16): 373-479 MB. A plain --test copy with no probe was 479 MB, so the
    gate's probe is not the cause.
  - The live shell: 202-212 MB, at 30 s and after hours alike.
- **Every other process matched live:** 341-355 MB in --test, 353-355 MB live.
- So the gate cannot judge the total. It judges **everything except the main process**, against
  650 - 210 = **440 MB**. That rest was 341-351 MB, so it passes. The main process is reported only.
- An earlier try, judging RAM after the `--test-unload` hook, was dropped: on a fresh copy it answers
  "nothing to unload".
- **Hidden-window idle CPU:**
  - every hidden page was 0-0.05 % of a core, except task view at 0.224 % in the first sample;
  - in the second sample, task view was 0 %;
  - the gate now judges each page on the lower of its two samples.
- **Check run** (10-16 06:21; launcher and Files, n 5; 15 passed, 1 failed, the failure being the old
  total-RAM check):
  - every hidden page was 0-0.012 % of a core;
  - no sidecar call or spawn happened in the trigger's own tick;
  - Files cold was p50 160 / p95 477 ms, and the launcher warm p50 62 / p95 67 ms.

What the baseline says to the surface lanes:
- Task Manager's cold p95 and kept-window size are over budget.
- The clipboard's warm open is slow in its median, with spikes.
- None of the six surfaces writes the R7 line.
- Settings, Task Manager and Notes have no warm number at all until they write it.

## What changed from the plan, and why

- **R1 "warm by default" is now "fast cold by default".**
  - The user said no to pre-made hidden windows for Settings, Task Manager and Files.
  - Pre-loading is the opt-in `keepReady.<surface>` flag, default off.
  - So the cold budget (p95 400 ms, never more than 1 s) is now the main budget for those three. Before,
    it was the exception.
- **R5 RAM.** The 650 MB total is kept, but it now assumes no pre-load. The plan's ~720 MB "all three
  pre-made" option is gone. Each keepReady flag costs at most 45 MB, and the budget grows only by the
  flags the user turns on. In the gate, the total becomes "every process but main <= 440 MB", because a
  `--test` main process is not the live one's size.
- **Cold ceiling.** The plan's "1 s at 80 % CPU" is now plainly "never more than 1 s", for both visible
  and usable.
- **R8 runs locally**, not on the cloud runner, because cloudtest is refused while GitHub billing is
  blocked. To make that workable, the gate adds:
  - the slack factor;
  - the quiet-CPU wait;
  - the machine mutex.
- **Not built yet:** R8's source test. It should fail if an open handler awaits the sidecar or calls
  `sendSync` before `show`. The gate's "sidecar calls / spawns before paint" list is a runtime hint, not
  that test.

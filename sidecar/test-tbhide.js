'use strict';
/*
 * test-tbhide.js - the LIVE path of `tbhide` (TaskbarHide.cs), end to end, WITHOUT the real taskbar.
 *
 *   MANTLE_SIDECAR_EXE=<scratch>\Mantle.Sidecar.exe node sidecar/test-tbhide.js
 *
 * test-sidecar.js proves the decision table with made-up window states; this proves the parts only a
 * real window can: the empty region really lands cross-process, the guard process arms before it,
 * a sidecar KILLED with TerminateProcess has its region cleared by the guard, a clean quit and
 * `tbhide off` clear it themselves, and a stale region is cleared by the next sidecar at startup.
 *
 * THE REAL TASKBAR IS NEVER A CANDIDATE. The sidecars run with MANTLE_TBHIDE_TEST_CLASS set to a
 * class only this file's stand-in window registers (an invisible, never-shown window in its own
 * process), so every lookup the sidecar and its guard make sees that window and nothing else - a
 * Shell_* name is refused by the exe. Before any `tbhide on` is sent, `status` must list ONLY the
 * stand-in; if it lists anything else the run stops there. These sidecars are non-passive (the
 * live path is the point), which beside a live Mantle is safe: their only other startup action,
 * the stale cursor-clip check, stands down while another sidecar runs.
 *
 * The same class also scopes the "a live Mantle holds the region" marker, so these sidecars and
 * their guards never defer to a live Mantle's hold on the REAL taskbar (the guard/stale checks
 * below would then prove nothing), and the live Mantle never defers to theirs.
 */
const { spawn, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { exePath, spawnSidecar, checker, sleep } = require('./test-lib');

const EXE = exePath();
const FAKE_CLASS = 'Mantle_FakeTaskbarForTbhideTest';
const t = checker('TBHIDE');

const FAKE_CS = `
using System; using System.Runtime.InteropServices; using System.Threading;
static class F {
  delegate IntPtr WndProc(IntPtr h, uint m, IntPtr w, IntPtr l);
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct WNDCLASS {
    public uint style; public WndProc proc; public int ce, we; public IntPtr inst, icon, cur, bg; public string menu, cls; }
  [StructLayout(LayoutKind.Sequential)] struct MSG { public IntPtr h; public uint m; public IntPtr w, l; public uint t; public int x, y; }
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern ushort RegisterClassW(ref WNDCLASS c);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateWindowExW(uint ex, string cls, string t, uint st, int x, int y, int w, int h, IntPtr p, IntPtr m, IntPtr i, IntPtr pr);
  [DllImport("user32.dll")] static extern IntPtr DefWindowProcW(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern int GetMessageW(out MSG m, IntPtr h, uint a, uint b);
  [DllImport("user32.dll")] static extern bool TranslateMessage(ref MSG m);
  [DllImport("user32.dll")] static extern IntPtr DispatchMessageW(ref MSG m);
  [DllImport("user32.dll")] static extern bool PostThreadMessageW(uint t, uint m, IntPtr w, IntPtr l);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] static extern int GetWindowRgn(IntPtr h, IntPtr r);
  [DllImport("user32.dll")] static extern int SetWindowRgn(IntPtr h, IntPtr r, bool redraw);
  [DllImport("gdi32.dll")] static extern IntPtr CreateRectRgn(int a, int b, int c, int d);
  [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr o);
  static WndProc _p = (h, m, w, l) => DefWindowProcW(h, m, w, l);
  static IntPtr _h;
  static int Kind() { IntPtr r = CreateRectRgn(0,0,0,0); int k = GetWindowRgn(_h, r); DeleteObject(r); return k; }
  static void Main(string[] a) {
    var c = new WNDCLASS(); c.proc = _p; c.cls = a[0];
    RegisterClassW(ref c);
    // WS_POPUP, never shown, parked far off screen: nothing ever appears on the desktop.
    _h = CreateWindowExW(0x80, a[0], "", 0x80000000, -32000, -32000, 200, 40, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
    uint tid = GetCurrentThreadId();
    Console.WriteLine("{\\"hwnd\\":\\"" + _h.ToInt64() + "\\"}"); Console.Out.Flush();
    new Thread(() => {
      string line;
      while ((line = Console.ReadLine()) != null) {
        if (line == "kind") Console.WriteLine("{\\"kind\\":" + Kind() + "}");
        else if (line == "empty") { SetWindowRgn(_h, CreateRectRgn(0,0,0,0), true); Console.WriteLine("{\\"kind\\":" + Kind() + "}"); }
        Console.Out.Flush();
      }
      PostThreadMessageW(tid, 0x12, IntPtr.Zero, IntPtr.Zero);
    }) { IsBackground = true }.Start();
    MSG msg; while (GetMessageW(out msg, IntPtr.Zero, 0, 0) > 0) { TranslateMessage(ref msg); DispatchMessageW(ref msg); }
  }
}`;

async function startFake() {
  const dir = path.join(os.tmpdir(), 'mantle-tbhide-fake');
  fs.mkdirSync(dir, { recursive: true });
  const tag = crypto.createHash('sha1').update(FAKE_CS).digest('hex').slice(0, 10);
  const exe = path.join(dir, `faketaskbar-${tag}.exe`);
  if (!fs.existsSync(exe)) {
    const src = path.join(dir, `faketaskbar-${tag}.cs`);
    fs.writeFileSync(src, FAKE_CS);
    execFileSync('C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe', ['-nologo', '-out:' + exe, src], { windowsHide: true });
  }
  const proc = spawn(exe, [FAKE_CLASS], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const lines = [];
  let buf = '';
  proc.stdout.on('data', (c) => {
    buf += c.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (l) lines.push(JSON.parse(l)); }
  });
  const next = async () => { const n = lines.length; for (let k = 0; k < 100 && lines.length === n; k++) await sleep(20); return lines[n]; };
  for (let k = 0; k < 150 && !lines.length; k++) await sleep(20);
  if (!lines.length) { proc.kill(); throw new Error('the stand-in window did not start'); }
  const hwnd = lines[0].hwnd;
  // GetWindowRgn: 0 = no region (normal), 1 = empty (Mantle's shape)
  const kind = async () => { proc.stdin.write('kind\n'); const r = await next(); return r ? r.kind : null; };
  const makeEmpty = async () => { proc.stdin.write('empty\n'); const r = await next(); return r ? r.kind : null; };
  return { proc, hwnd, kind, makeEmpty, stop() { try { proc.stdin.end(); } catch (_) { /* gone */ } setTimeout(() => { try { proc.kill(); } catch (_) { /* gone */ } }, 500); } };
}

function startLive(stateFile) {
  // Non-passive on purpose; the class override is what keeps the real taskbar out of reach.
  return spawnSidecar(EXE, [`--parent-pid=${process.pid}`, `--state-file=${stateFile}`]);
}

async function waitFor(pred, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await pred()) return true; await sleep(50); }
  return false;
}

async function main() {
  if (!fs.existsSync(EXE)) { console.log(`TBHIDE TEST: no exe at ${EXE}`); return 1; }
  process.env.MANTLE_TBHIDE_TEST_CLASS = FAKE_CLASS;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mantle-tbhide-'));
  const stateFile = path.join(dir, 'shell-state.json');
  const note = path.join(dir, 'taskbar-guard.log');
  const fake = await startFake();
  const sidecars = [];
  try {
    // ---- 1. the override is in force BEFORE anything is switched on
    let s = startLive(stateFile); sidecars.push(s);
    await s.waitEvent('ready', 8000);
    const st = await s.send('tbhide', { status: true });
    const wins = st.ok && st.result ? st.result.windows : null;
    const onlyFake = Array.isArray(wins) && wins.length === 1 && wins[0].class === FAKE_CLASS && wins[0].hwnd === fake.hwnd;
    t.check('status sees ONLY the stand-in window (the real taskbar is not a candidate)', onlyFake, JSON.stringify(st).slice(0, 300));
    if (!onlyFake) { console.log('  stopping: the class override is not in force, so nothing is switched on'); return t.summary(); }

    // ---- 2. on: guard armed first, then the empty region lands cross-process
    let r = await s.send('tbhide', { on: true }, 8000);
    t.check('tbhide on answers applied, with the guard armed outside Electron\'s job',
      r.ok && r.result.applied === true && /^armed \(pid \d+/.test(r.result.guard || ''), JSON.stringify(r).slice(0, 400));
    t.check('the stand-in now has an EMPTY window region', (await fake.kind()) === 1);
    const guardPid = Number(((r.result && r.result.guard) || '').replace(/^armed \(pid (\d+).*$/, '$1')) || 0;
    const stFile = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    t.check('the state file records the taskbar region for a recovery script', stFile.changed && stFile.changed.taskbarRegion === true, JSON.stringify(stFile.changed));

    // ---- 3. KILL the sidecar (TerminateProcess): the guard must clear the region by itself
    s.proc.kill();
    const cleared = await waitFor(async () => (await fake.kind()) === 0, 4000);
    t.check('a KILLED sidecar\'s region is cleared by its guard within 4 s', cleared);
    const guardGone = await waitFor(async () => { try { process.kill(guardPid, 0); return false; } catch (_) { return true; } }, 3000);
    t.check('the guard exits once its work is done', guardPid > 0 && guardGone, `guard pid ${guardPid}`);
    let text = ''; try { text = fs.readFileSync(note, 'utf8'); } catch (_) { /* none */ }
    t.check('the guard left a note saying what it did', /so the guard cleared it/.test(text) && /1 cleared/.test(text), text.trim());

    // ---- 4. the next sidecar reports that note once, then a clean quit clears its own region
    s = startLive(stateFile); sidecars.push(s);
    await s.waitEvent('ready', 8000);
    const said = await s.waitEvent('log', 3000, (e) => /tbhide: .*taskbar guard/.test(e.message || '')).catch(() => null);
    t.check('the next sidecar reports the guard\'s note on the wire', !!said, said ? said.message.slice(0, 160) : 'no log event');
    t.check('...and the note is consumed (said once)', !fs.existsSync(note));
    r = await s.send('tbhide', { on: true }, 8000);
    t.check('on again: applied', r.ok && r.result.applied === true, JSON.stringify(r).slice(0, 200));
    s.send('quit', {}).catch(() => {});
    await s.waitExit(4000).catch(() => {});
    t.check('a clean quit clears the region itself', (await fake.kind()) === 0);
    await sleep(600);
    t.check('a clean quit leaves no guard note (the guard had nothing to do)', !fs.existsSync(note));

    // ---- 5. tbhide off clears it and keeps the sidecar running
    s = startLive(stateFile); sidecars.push(s);
    await s.waitEvent('ready', 8000);
    await s.send('tbhide', { on: true }, 8000);
    r = await s.send('tbhide', { on: false }, 4000);
    t.check('tbhide off clears the region and says so', r.ok && r.result.released === true && (await fake.kind()) === 0, JSON.stringify(r).slice(0, 200));

    // ---- 6. the guard is re-armed if someone kills it
    await s.send('tbhide', { on: true }, 8000);
    const st2 = await s.send('tbhide', { status: true });
    const g2 = Number(((st2.result && st2.result.guard) || '').replace(/^armed \(pid (\d+).*$/, '$1')) || 0;
    try { process.kill(g2); } catch (_) { /* gone */ }
    const rearmed = await waitFor(async () => {
      const x = await s.send('tbhide', { status: true });
      const p = Number(((x.result && x.result.guard) || '').replace(/^armed \(pid (\d+).*$/, '$1')) || 0;
      return p > 0 && p !== g2;
    }, 6000);
    t.check('a killed guard is replaced and the region stays', g2 > 0 && rearmed && (await fake.kind()) === 1, `old guard ${g2}`);
    const st3 = await s.send('tbhide', { status: true });
    const g3 = Number(((st3.result && st3.result.guard) || '').replace(/^armed \(pid (\d+).*$/, '$1')) || 0;
    s.send('quit', {}).catch(() => {});
    await s.waitExit(4000).catch(() => {});
    // Its guard must be gone before a stale region is staged, or IT clears the stale one (correctly).
    await waitFor(async () => { try { process.kill(g3, 0); return false; } catch (_) { return true; } }, 3000);
    try { fs.unlinkSync(note); } catch (_) { /* none */ }

    // ---- 7. a stale empty region (a Mantle that died with its guard) is cleared at startup
    t.check('stand-in given a stale empty region', (await fake.makeEmpty()) === 1);
    s = startLive(stateFile); sidecars.push(s);
    await s.waitEvent('ready', 8000);
    const staleSaid = await s.waitEvent('log', 3000, (e) => /cleared a stale empty window region/.test(e.message || '')).catch(() => null);
    const kindNow = await fake.kind();
    t.check('the next sidecar clears a stale empty region at startup and says so',
      !!staleSaid && kindNow === 0, staleSaid ? staleSaid.message.slice(0, 160)
        : `no log event; region kind ${kindNow}; logs: ${s.events.filter((e) => e.ev === 'log').map((e) => e.message).join(' | ').slice(0, 300)}`);
    s.send('quit', {}).catch(() => {});
    await s.waitExit(4000).catch(() => {});
  } catch (e) {
    t.fail('tbhide live path', e.stack || e.message);
  } finally {
    for (const x of sidecars) { try { x.proc.kill(); } catch (_) { /* gone */ } }
    fake.stop();
    await sleep(700);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* busy */ }
  }
  return t.summary();
}

main().then((code) => process.exit(code), (e) => { console.error(e); process.exit(1); });

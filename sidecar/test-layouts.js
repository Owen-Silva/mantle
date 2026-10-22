// test-layouts.js - Window layouts: the sidecar half (sidecar/Layouts.cs) and the restore engine
// (lib/features/_layouts-run.js) against it. Lane layouts, 2026-09-27.
//
//   MANTLE_SIDECAR_EXE=<your exe> node sidecar/test-layouts.js
//
// PASSIVE, like every sidecar test. Every move goes to a FIXTURE this test compiles into %TEMP%:
// four ordinary app windows (WS_EX_APPWINDOW, so the layout list takes them, + WS_EX_NOACTIVATE,
// shown without activation) parked at x = -6000, off every screen. Charlie maximises OFF screen too
// (its WM_GETMINMAXINFO puts the maximised window at -20000). The engine test runs on a FAKE monitor
// laid over that off-screen area, so a saved and restored layout never lands on the user's screen.
// The user's own windows are only READ, and only once without a pid filter: to prove a passive sidecar
// hands out NO title of a window that is not the harness's (nothing of them is printed), and that a
// move of one is refused (and a dryRun only describes it). The fixture kills itself after 150 s.
//
// Prints one summary line, "LAYOUTS TEST: n passed, m failed".
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const T = require('./test-lib');
const core = require('../lib/features/_layouts-core');
const run = require('../lib/features/_layouts-run');

const DIR = path.join(os.tmpdir(), 'mantle-layouts');
const FIX_EXE = path.join(DIR, 'mantle-layouts-fixture.exe');
const CSC = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';

const FIXTURE_CS = String.raw`
using System;
using System.Drawing;
using System.IO;
using System.Threading;
using System.Windows.Forms;

class FixForm : Form {
  public static string Log;
  protected override bool ShowWithoutActivation { get { return true; } }
  protected override CreateParams CreateParams {
    get { CreateParams cp = base.CreateParams; cp.ExStyle |= 0x08000000 | 0x00040000; return cp; }   // NOACTIVATE | APPWINDOW
  }
  public void SetMaxBounds(Rectangle r) { MaximizedBounds = r; }
  public static void Say(string s) { try { File.AppendAllText(Log, s + "\r\n"); } catch (Exception) { } }
}

static class P {
  static int _open = 0;
  static FixForm Make(string name, int y, string tag) {
    var f = new FixForm();
    f.Text = "Mantle layouts fixture " + name + " " + tag;
    f.StartPosition = FormStartPosition.Manual;
    f.Location = new Point(-6000, y);
    f.Size = new Size(300, 220);
    f.Opacity = 0;   // invisible and click-through even if Windows ever pulls it on screen (an off-screen restore rect is clamped)
    f.FormClosed += delegate { FixForm.Say("CLOSED " + name); if (--_open == 0) Application.ExitThread(); };
    f.Shown += delegate { FixForm.Say("HWND " + name + " " + f.Handle.ToInt64()); };
    _open++;
    return f;
  }
  [STAThread]
  static void Main(string[] a) {
    FixForm.Log = a.Length > 0 ? a[0] : Path.Combine(Path.GetTempPath(), "mantle-layouts", "log-default.txt");
    string tag = a.Length > 1 ? a[1] : "0";
    var t = new System.Windows.Forms.Timer(); t.Interval = 150000; t.Tick += delegate { Application.ExitThread(); }; t.Start();
    var forms = new System.Collections.Generic.Dictionary<string, FixForm>();
    forms["Alpha"] = Make("Alpha", -6000, tag);
    forms["Bravo"] = Make("Bravo", -5600, tag);
    forms["Charlie"] = Make("Charlie", -5200, tag);
    forms["Charlie"].SetMaxBounds(new Rectangle(-20000, -20000, 520, 380));   // maximised = still off screen
    forms["Delta"] = Make("Delta", -4800, tag);
    forms["Delta"].MinimumSize = new Size(360, 260);
    // Commands from the test, one line in <log>.cmd (polled): CLOSE name | MIN name | HANG ms | QUIT
    string cmdPath = FixForm.Log + ".cmd";
    var poll = new System.Windows.Forms.Timer(); poll.Interval = 60;
    poll.Tick += delegate {
      string c = null;
      try { if (File.Exists(cmdPath)) { c = File.ReadAllText(cmdPath).Trim(); File.Delete(cmdPath); } } catch (Exception) { c = null; }
      if (string.IsNullOrEmpty(c)) return;
      string[] q = c.Split(' ');
      if (q[0] == "CLOSE" && forms.ContainsKey(q[1])) forms[q[1]].Close();
      else if (q[0] == "MIN" && forms.ContainsKey(q[1])) { forms[q[1]].WindowState = FormWindowState.Minimized; FixForm.Say("MINNED " + q[1]); }
      else if (q[0] == "HANG") { FixForm.Say("HANGING"); Thread.Sleep(int.Parse(q[1])); FixForm.Say("AWAKE"); }
      else if (q[0] == "QUIT") Application.ExitThread();
    };
    poll.Start();
    foreach (var f in forms.Values) f.Show();
    Application.Run();
  }
}
`;

const NAMES = ['Alpha', 'Bravo', 'Charlie', 'Delta'];

function buildFixture() {
  fs.mkdirSync(DIR, { recursive: true });
  const src = path.join(DIR, 'fixture.cs');
  fs.writeFileSync(src, FIXTURE_CS);
  const r = spawnSync(CSC, ['/nologo', '/target:winexe', '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll',
    '/out:' + FIX_EXE, src], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('fixture did not compile: ' + (r.stdout || '') + (r.stderr || ''));
}

/** Launches the fixture (a child of THIS process, so the passive fence lets the sidecar move it). */
async function launch(args) {
  const log = args && args[0];
  if (log) { try { fs.unlinkSync(log); } catch (_) { /* first run */ } }
  const proc = spawn(FIX_EXE, args || [], { stdio: 'ignore', windowsHide: false });
  const logPath = log || path.join(DIR, 'log-default.txt');
  const lines = () => { try { return fs.readFileSync(logPath, 'utf8').split(/\r?\n/).filter(Boolean); } catch (_) { return []; } };
  const hwnd = {};
  const t0 = Date.now();
  while (Date.now() - t0 < 10000 && Object.keys(hwnd).length < 4) {
    for (const l of lines()) { const m = /^HWND (\w+) (\d+)$/.exec(l); if (m) hwnd[m[1]] = m[2]; }
    if (Object.keys(hwnd).length < 4) await T.sleep(100);
  }
  if (Object.keys(hwnd).length < 4) { try { proc.kill(); } catch (_) { /* gone */ } throw new Error('the fixture never reported its windows'); }
  return { proc, pid: proc.pid, hwnd, lines, cmd: (line) => fs.writeFileSync(logPath + '.cmd', line) };
}

async function waitLine(fx, want, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fx.lines().includes(want)) return true; await T.sleep(50); }
  return false;
}

const near = (a, b, tol) => a && b && Math.abs(a.x - b.x) <= tol && Math.abs(a.y - b.y) <= tol &&
  Math.abs(a.w - b.w) <= tol && Math.abs(a.h - b.h) <= tol;
const R = (r) => r ? `${r.x},${r.y} ${r.w}x${r.h}` : 'none';

async function main() {
  const t = T.checker('LAYOUTS');
  buildFixture();
  let s = null, fx = null;
  const extra = [];
  try {
    s = await T.startPassive();
    const send = async (cmd, args, o) => {
      try { return await s.send(cmd, args, (o && o.timeoutMs) || 8000); } catch (e) { return { ok: false, error: e.message }; }
    };

    /* ---- monitors ---- */
    const mr = await send('layouts.monitors', {});
    const mons = (mr.ok && mr.result.monitors) || [];
    t.check('monitors: at least one, each with device, work area and dpi', mons.length > 0 &&
      mons.every((m) => m.device && m.work && m.work.w > 0 && m.dpi >= 96), JSON.stringify(mr).slice(0, 200));
    const dpi = (mons.find((m) => m.primary) || mons[0] || { dpi: 96 }).dpi;

    fx = await launch([path.join(DIR, `log-main-${process.pid}.txt`), String(process.pid)]);
    const listMine = async (pids) => {
      const r = await send('layouts.windows', { pids: pids || [fx.pid] });
      return r.ok ? r.result.windows : [];
    };
    const byName = (list, n) => list.find((w) => w.hwnd === fx.hwnd[n]);

    /* ---- listing ---- */
    let mine = await listMine();
    t.check('windows: the fixture\'s four app windows are listed', NAMES.every((n) => byName(mine, n)), `${mine.length} listed`);
    const a0 = byName(mine, 'Alpha') || {};
    t.check('windows: a harness window is ours, with its title, exe, frame, normal and state',
      a0.ours === true && /fixture Alpha/.test(a0.title || '') && /mantle-layouts-fixture\.exe$/i.test(a0.exe || '') &&
      a0.frame && a0.frame.w > 0 && a0.normal && a0.state === 'normal', JSON.stringify(Object.assign({}, a0, { exe: undefined })).slice(0, 240));
    const all = await send('layouts.windows', {});
    const others = all.ok ? all.result.windows.filter((w) => !w.ours) : [];
    t.check('privacy: a passive sidecar gives NO title for a window the harness did not start',
      all.ok && others.every((w) => w.title === null), `${others.length} other windows, ${others.filter((w) => w.title !== null).length} with a title`);
    t.check('windows: skipped counts come back (tool / shell / mantle / other desktop)', all.ok && all.result.skipped &&
      typeof all.result.skipped.tool === 'number', JSON.stringify(all.ok && all.result.skipped));

    /* ---- the fence: a window that is not the harness's ---- */
    const theirs = others.find((w) => !w.refuse);
    if (theirs) {
      const dry = await send('layouts.place', { hwnd: theirs.hwnd, frame: { x: 0, y: 0, w: 800, h: 600 }, state: 'normal', dryRun: true });
      t.check('fence: dryRun on a real window only describes the move', dry.ok && dry.result.dryRun === true && typeof dry.result.would === 'string', JSON.stringify(dry).slice(0, 160));
      const real = await send('layouts.place', { hwnd: theirs.hwnd, frame: { x: 0, y: 0, w: 800, h: 600 }, state: 'normal' });
      t.check('fence: a real move of a real window is refused (passive)', !real.ok && real.error.indexOf(T.PASSIVE_REFUSAL) === 0, JSON.stringify(real).slice(0, 160));
    } else t.check('fence: (no other window to try the fence on)', true);

    /* ---- normal placement ---- */
    const spotA = { x: -7400, y: -6100, w: 420, h: 300 };
    let r = await send('layouts.place', { hwnd: fx.hwnd.Alpha, pid: fx.pid, frame: spotA, state: 'normal' });
    mine = await listMine();
    t.check('place: Alpha\'s frame lands on the spot (3 px)', r.ok && r.result.placed && near(byName(mine, 'Alpha').frame, spotA, 3),
      `${JSON.stringify(r).slice(0, 160)} got ${R(byName(mine, 'Alpha') && byName(mine, 'Alpha').frame)}`);
    r = await send('layouts.place', { hwnd: fx.hwnd.Alpha, pid: fx.pid, frame: spotA, state: 'normal' });
    t.check('place: the same spot again is "already", no move', r.ok && r.result.already === true && r.result.moves === 0, JSON.stringify(r).slice(0, 160));
    r = await send('layouts.place', { hwnd: fx.hwnd.Alpha, pid: fx.pid + 1, frame: spotA, state: 'normal' });
    t.check('place: a pid that does not match is "closed"', !r.ok && /closed/.test(r.error), JSON.stringify(r).slice(0, 160));
    r = await send('layouts.place', { hwnd: fx.hwnd.Alpha, frame: { x: 0, y: 0, w: 0, h: 10 }, state: 'normal' });
    t.check('place: a bad frame is refused in words', !r.ok && /frame/.test(r.error), JSON.stringify(r).slice(0, 160));

    /* ---- maximise, and back out ---- */
    const spotC = { x: -7000, y: -5300, w: 460, h: 320 };
    r = await send('layouts.place', { hwnd: fx.hwnd.Charlie, pid: fx.pid, frame: spotC, state: 'max' });
    mine = await listMine();
    const c1 = byName(mine, 'Charlie') || {};
    // (its restore rect is not checked here: Windows pulls an OFF-screen restore rect onto a monitor)
    t.check('max: Charlie is maximised', r.ok && r.result.placed && c1.state === 'max', `${JSON.stringify(r).slice(0, 160)} state ${c1.state}`);
    t.check('max: it stayed off screen (the fixture maximises at -20000)', c1.frame && c1.frame.x < -10000, R(c1.frame));
    r = await send('layouts.place', { hwnd: fx.hwnd.Charlie, pid: fx.pid, frame: spotC, state: 'max' });
    t.check('max: already maximised there = untouched', r.ok && r.result.already === true && r.result.moves === 0, JSON.stringify(r).slice(0, 160));
    r = await send('layouts.place', { hwnd: fx.hwnd.Charlie, pid: fx.pid, frame: spotC, state: 'normal' });
    mine = await listMine();
    const c2 = byName(mine, 'Charlie') || {};
    t.check('max -> normal: out of maximised, on the spot', r.ok && c2.state === 'normal' && near(c2.frame, spotC, 3),
      `${JSON.stringify(r).slice(0, 160)} state ${c2.state} frame ${R(c2.frame)}`);

    /* ---- minimised ---- */
    fx.cmd('MIN Bravo');
    await waitLine(fx, 'MINNED Bravo', 3000);
    await T.sleep(300);
    mine = await listMine();
    t.check('min: Bravo is listed as minimised', (byName(mine, 'Bravo') || {}).state === 'min', (byName(mine, 'Bravo') || {}).state);
    const spotB = { x: -8000, y: -5600, w: 380, h: 260 };
    r = await send('layouts.place', { hwnd: fx.hwnd.Bravo, pid: fx.pid, frame: spotB, state: 'normal' });
    mine = await listMine();
    const b1 = byName(mine, 'Bravo') || {};
    t.check('min -> normal: restored into the spot', r.ok && b1.state === 'normal' && near(b1.frame, spotB, 3),
      `${JSON.stringify(r).slice(0, 160)} state ${b1.state} frame ${R(b1.frame)}`);
    // state 'min' (lane windows-layouts, 2026-09-29): Undo puts a minimised window back minimised
    r = await send('layouts.place', { hwnd: fx.hwnd.Bravo, pid: fx.pid, frame: spotB, state: 'min', dryRun: true });
    t.check('normal -> min: a dry run only describes it', r.ok && r.result.dryRun === true && /minimise it/.test(r.result.would || ''), JSON.stringify(r).slice(0, 160));
    r = await send('layouts.place', { hwnd: fx.hwnd.Bravo, pid: fx.pid, frame: spotB, state: 'min' });
    mine = await listMine();
    t.check('normal -> min: minimised', r.ok && r.result.placed && r.result.state === 'min' && (byName(mine, 'Bravo') || {}).state === 'min',
      `${JSON.stringify(r).slice(0, 160)} state ${(byName(mine, 'Bravo') || {}).state}`);
    r = await send('layouts.place', { hwnd: fx.hwnd.Bravo, pid: fx.pid, frame: spotB, state: 'min' });
    t.check('min again: "already", no move', r.ok && r.result.already === true && r.result.moves === 0, JSON.stringify(r).slice(0, 160));
    r = await send('layouts.place', { hwnd: fx.hwnd.Bravo, pid: fx.pid, frame: spotB, state: 'normal' });
    mine = await listMine();
    t.check('min -> normal: back in its spot (the restore spot was kept)', r.ok && near((byName(mine, 'Bravo') || {}).frame, spotB, 3), R((byName(mine, 'Bravo') || {}).frame));
    r = await send('layouts.place', { hwnd: fx.hwnd.Bravo, pid: fx.pid, frame: spotB, state: 'sideways' });
    t.check('a bad state is refused in words', !r.ok && /state must be/.test(r.error), JSON.stringify(r).slice(0, 160));

    /* ---- a minimum size: placed, with the reason it is not exact ---- */
    r = await send('layouts.place', { hwnd: fx.hwnd.Delta, pid: fx.pid, frame: { x: -7600, y: -4700, w: 200, h: 150 }, state: 'normal' });
    t.check('min size: placed, not exact, and says why', r.ok && r.result.placed && r.result.exact === false && /bigger size/.test(r.result.note || ''),
      JSON.stringify(r).slice(0, 200));

    /* ---- hung: refused, fast ---- */
    fx.cmd('HANG 7500');
    await waitLine(fx, 'HANGING', 3000);
    await T.sleep(5600);   // Windows calls a window hung after ~5 s without pumping
    const h0 = Date.now();
    r = await send('layouts.place', { hwnd: fx.hwnd.Alpha, pid: fx.pid, frame: { x: -7300, y: -6000, w: 400, h: 300 }, state: 'normal' });
    const hms = Date.now() - h0;
    t.check('hung: refused in words, without waiting on it', !r.ok && /not responding|did not answer/.test(r.error) && hms < 1500, `${hms} ms: ${JSON.stringify(r).slice(0, 160)}`);
    await waitLine(fx, 'AWAKE', 5000);
    await T.sleep(300);

    /* ---- the engine, end to end, on a fake off-screen monitor ---- */
    const FAKE = { id: 'fake', device: '\\\\.\\FAKE1', bounds: { x: -9000, y: -6500, w: 2400, h: 2200 },
      work: { x: -9000, y: -6500, w: 2400, h: 2200 }, dpi, scale: dpi / 96, primary: true };
    const pids = [fx.pid];
    const fake = async (cmd, args, o) => {
      if (cmd === 'layouts.windows') {
        const x = await send(cmd, Object.assign({}, args, { pids }), o);
        if (x.ok) { x.result.monitors = [FAKE]; for (const w of x.result.windows) w.monitor = 'fake'; }
        return x;
      }
      return send(cmd, args, o);
    };
    // lay out all four at known spots, save, and mark Charlie's entry maximised (saving a maximised
    // fixture cannot work off screen: Windows pulls its restore rect onto a real monitor)
    const spots = { Alpha: { x: -8900, y: -6400, w: 500, h: 360 }, Bravo: { x: -8300, y: -6400, w: 500, h: 360 },
      Charlie: { x: -7700, y: -5900, w: 480, h: 340 }, Delta: { x: -8900, y: -5900, w: 540, h: 420 } };
    for (const n of Object.keys(spots)) await send('layouts.place', { hwnd: fx.hwnd[n], pid: fx.pid, frame: spots[n], state: 'normal' });
    const ans = (await fake('layouts.windows', {})).result;
    const snapRes = core.snapshot(ans, { test: true });
    for (const e of snapRes.entries) if (e.t.join() === core.titleTokens('Mantle layouts fixture Charlie').join()) e.state = 'max';
    t.check('engine: a snapshot of the fixture takes all four (one maximised)', snapRes.entries.length === 4 &&
      snapRes.entries.filter((e) => e.state === 'max').length === 1, JSON.stringify(snapRes.left) + ' ' + snapRes.entries.length);
    const layout = { name: 'E2E', entries: snapRes.entries };
    // scramble: Alpha and Bravo swap places (so "nearest" would pair them wrongly: titles must win),
    // Charlie comes out of maximised, Delta goes elsewhere
    await send('layouts.place', { hwnd: fx.hwnd.Alpha, pid: fx.pid, frame: spots.Bravo, state: 'normal' });
    await send('layouts.place', { hwnd: fx.hwnd.Bravo, pid: fx.pid, frame: spots.Alpha, state: 'normal' });
    await send('layouts.place', { hwnd: fx.hwnd.Charlie, pid: fx.pid, frame: { x: -8000, y: -4700, w: 400, h: 300 }, state: 'normal' });
    await send('layouts.place', { hwnd: fx.hwnd.Delta, pid: fx.pid, frame: { x: -7200, y: -4600, w: 400, h: 300 }, state: 'normal' });
    const deps = {
      send: fake, test: true, log: () => {}, waitMs: 10000, settleMs: 300, pollMs: 250,
      isFixtureExe: (p) => String(p || '').toLowerCase() === FIX_EXE.toLowerCase(),
      exists: (p) => fs.existsSync(p),
      spawn: async (exe, args) => {
        const c = spawn(exe, args, { stdio: 'ignore', windowsHide: false });
        extra.push(c);
        pids.push(c.pid);
        return { ok: true };
      },
    };
    let out = await run.restore(layout, deps);
    mine = await listMine();
    t.check('engine: every entry placed', out.ok && out.counts.placed === 4, out.text + ' | ' + out.lines.join(' / '));
    t.check('engine: titles pair the swapped windows right', near(byName(mine, 'Alpha').frame, spots.Alpha, 3) && near(byName(mine, 'Bravo').frame, spots.Bravo, 3),
      `Alpha ${R(byName(mine, 'Alpha').frame)} Bravo ${R(byName(mine, 'Bravo').frame)}`);
    t.check('engine: Charlie maximised again, Delta back', byName(mine, 'Charlie').state === 'max' && near(byName(mine, 'Delta').frame, spots.Delta, 3),
      `Charlie ${byName(mine, 'Charlie').state} Delta ${R(byName(mine, 'Delta').frame)}`);
    const firstUndo = out.undo || [];
    out = await run.restore(layout, deps);
    t.check('engine: a second restore finds all four already in place', out.ok && /already in place/.test(out.text), out.text);
    t.check('undo: a restore that moved nothing has nothing to undo', Array.isArray(out.undo) && out.undo.length === 0, JSON.stringify(out.undo));
    // UNDO (lane windows-layouts, 2026-09-29): the first restore's windows go back where they stood
    t.check('undo: the first restore remembers the four windows it moved', firstUndo.length === 4, String(firstUndo.length));
    const un = await run.undo('E2E', firstUndo, { send: fake });
    mine = await listMine();
    const backOk = firstUndo.every((u) => { const w = mine.find((x) => x.hwnd === u.hwnd); return w && w.state === 'normal' && near(w.frame, u.frame, 3); });
    t.check('undo: all four are back where they stood before the restore (Charlie un-maximised)', un.ok && un.back === 4 && backOk,
      `${un.text} | ${firstUndo.map((u) => { const w = mine.find((x) => x.hwnd === u.hwnd) || {}; return `${w.state} ${R(w.frame)} want ${R(u.frame)}`; }).join(' / ')}`);
    out = await run.restore(layout, deps);
    t.check('undo: ... and the layout can be put back again', out.ok && out.counts.placed === 4 && byName(await listMine(), 'Charlie').state === 'max', out.text);

    // Delta closed: the layout starts the fixture's exe, and places ITS Delta when it appears;
    // plus an app that is not installed and one that only a host exe runs
    fx.cmd('CLOSE Delta');
    await waitLine(fx, 'CLOSED Delta', 3000);
    const layout2 = { name: 'E2E', entries: layout.entries.concat([
      Object.assign({}, layout.entries[0], { app: 'Notion', exe: 'C:\\Nope\\Notion\\Notion.exe', aumid: null, t: [] }),
      Object.assign({}, layout.entries[0], { app: 'Some tool', exe: 'C:\\Nope\\tool\\electron.exe', aumid: null, t: [] }),
    ]) };
    const t0 = Date.now();
    out = await run.restore(layout2, deps);
    const opened = out.results.find((x) => x.kind === 'opened');
    t.check('engine: the closed window\'s app is started and its window placed ("opened")', out.ok && out.counts.opened === 1 && opened && opened.app,
      `${Date.now() - t0} ms: ${out.text} | ${out.lines.join(' / ')}`);
    t.check('engine: "not found" says why (not installed / host exe)', out.counts.notfound === 2 &&
      out.lines.some((l) => /Notion isn't installed/.test(l)) && out.lines.some((l) => /can't start it on its own/.test(l)), out.lines.join(' / '));
    t.check('engine: the summary line reads right', /^E2E: 3 placed, 1 opened, 2 not found$/.test(out.text), out.text);
    const newDelta = (await send('layouts.windows', { pids: pids.slice(1) })).result.windows.find((w) => /fixture Delta/.test(w.title || ''));
    t.check('engine: the new Delta is on Delta\'s spot', newDelta && near(newDelta.frame, spots.Delta, 3), R(newDelta && newDelta.frame));
    const newAlpha = (await send('layouts.windows', { pids: pids.slice(1) })).result.windows.find((w) => /fixture Alpha/.test(w.title || ''));
    t.check('engine: windows not in the layout are not touched (the new Alpha stays where it opened)',
      newAlpha && newAlpha.frame.x < -5000 && !near(newAlpha.frame, spots.Alpha, 3), R(newAlpha && newAlpha.frame));
  } catch (err) {
    t.fail('crashed', err && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : String(err));
  } finally {
    if (s) await s.stop();
    for (const p of [fx && fx.proc].concat(extra)) if (p) { try { p.kill(); } catch (_) { /* gone */ } }
  }
  process.exit(t.summary());
}

main();

// test-topbar.js - the top bar's sidecar half (sidecar/MenuBar.cs, sidecar/TopbarStats.cs).
//
//   MANTLE_SIDECAR_EXE=<your exe> node sidecar/test-topbar.js
//
// PASSIVE, like every sidecar test. The user's apps are only ever READ (and this prints counts, never
// a title or a menu label of his). Every write - a menu command, a window action - goes to a
// FIXTURE this test compiles into %TEMP%: a tiny WinForms exe whose windows sit at -6000,-6000,
// are WS_EX_NOACTIVATE + WS_EX_TOOLWINDOW (no taskbar button, no Alt+Tab entry) and are shown
// without activation, so nothing on the screen moves and the focus never changes. A DECOY - the
// same exe under another name - must be REFUSED, which proves the passive guard is the exe check
// and not the title. The fixture kills itself after 120 s if this test dies first.
//
// Prints one summary line, "TOPBAR TEST: n passed, m failed".
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const T = require('./test-lib');

const DIR = path.join(os.tmpdir(), 'mantle-topbar');
const FIX_EXE = path.join(DIR, 'mantle-topbar-fixture.exe');
const DECOY_EXE = path.join(DIR, 'mantle-topbar-decoy.exe');
const CSC = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';

const FIXTURE_CS = String.raw`
using System;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows.Forms;

class FixForm : Form {
  public static string Log;
  protected override bool ShowWithoutActivation { get { return true; } }
  protected override CreateParams CreateParams {
    get { CreateParams cp = base.CreateParams; cp.ExStyle |= 0x08000000 | 0x80; return cp; }   // NOACTIVATE | TOOLWINDOW
  }
  public static void Say(string s) { try { File.AppendAllText(Log, s + "\r\n"); } catch (Exception) { } }
}

static class P {
  static int _open = 2;
  [DllImport("user32.dll")] static extern void NotifyWinEvent(uint ev, IntPtr hwnd, int obj, int child);
  static MenuItem Add(MenuItem parent, string text) {
    var m = new MenuItem(text);
    m.Click += delegate { FixForm.Say("CLICK " + text); };
    parent.MenuItems.Add(m);
    return m;
  }
  static ToolStripMenuItem TI(string text) {
    var m = new ToolStripMenuItem(text);
    m.Click += delegate { FixForm.Say("CLICK " + text); };
    return m;
  }
  static FixForm Make(string title, int y) {
    var f = new FixForm();
    f.Text = title;
    f.StartPosition = FormStartPosition.Manual;
    f.Location = new Point(-6000, y);
    f.Size = new Size(320, 200);
    f.FormClosed += delegate { FixForm.Say("CLOSED " + title); if (--_open == 0) Application.ExitThread(); };
    return f;
  }
  [STAThread]
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  static void Main(string[] a) {
    // DPI-aware like the sidecar, so both speak physical pixels: a DPI-unaware fixture at
    // -6000,-5990 is -7491,-7488 to the sidecar at 125% (measured 2026-09-24), and the guard test
    // compares positions.
    SetProcessDPIAware();
    FixForm.Log = a[0];
    string tag = a.Length > 1 ? a[1] : "";
    var t = new Timer(); t.Interval = 120000; t.Tick += delegate { Application.ExitThread(); }; t.Start();

    FixForm f = Make("Mantle topbar fixture" + tag, -6000);
    var mm = new MainMenu();
    var file = new MenuItem("&File");
    Add(file, "&New\tCtrl+N");
    Add(file, "&Open...\tCtrl+O");
    file.MenuItems.Add("-");
    var recent = new MenuItem("&Recent");
    Add(recent, "a.txt");
    Add(recent, "b.txt");
    file.MenuItems.Add(recent);
    file.MenuItems.Add("-");
    Add(file, "&Disabled").Enabled = false;
    Add(file, "&Checked").Checked = true;
    MenuItem rad = Add(file, "&Radio"); rad.RadioCheck = true; rad.Checked = true;
    Add(file, "E&xit");
    var edit = new MenuItem("&Edit");
    Add(edit, "&Undo\tCtrl+Z");
    var help = new MenuItem("&Help");
    Add(help, "About && &Info");
    mm.MenuItems.Add(file); mm.MenuItems.Add(edit); mm.MenuItems.Add(help);
    f.Menu = mm;
    f.Shown += delegate { FixForm.Say("HWND main " + f.Handle.ToInt64()); };

    FixForm s = Make("Mantle topbar fixture (strip)" + tag, -5600);
    var ms = new MenuStrip();
    var tools = TI("&Tools");
    tools.DropDownItems.Add(TI("&Ping"));
    tools.DropDownItems.Add(TI("P&ong"));
    ms.Items.Add(tools);
    ms.Items.Add(TI("&Go"));
    s.MainMenuStrip = ms;
    s.Controls.Add(ms);
    s.Shown += delegate { FixForm.Say("HWND strip " + s.Handle.ToInt64()); };

    // Commands from the test, one line in <log>.cmd (polled; the fixture never reads input):
    //   MOVE x y   put the STRIP window (never minimised by this test) at x,y (off screen), then raise EVENT_SYSTEM_MOVESIZEEND
    //              for it - what Windows raises when a user's drag ends - so the sidecar's guard
    //              runs exactly as it would after a real drag, with no input injected anywhere
    //   WHERE tag  log the strip window's position
    string cmdPath = a[0] + ".cmd";
    var poll = new Timer(); poll.Interval = 60;
    poll.Tick += delegate {
      string c = null;
      try { if (File.Exists(cmdPath)) { c = File.ReadAllText(cmdPath).Trim(); File.Delete(cmdPath); } } catch (Exception) { c = null; }
      if (string.IsNullOrEmpty(c)) return;
      string[] p = c.Split(' ');
      if (p[0] == "MOVE" && p.Length == 3) {
        s.Location = new Point(int.Parse(p[1]), int.Parse(p[2]));
        NotifyWinEvent(0x000B, s.Handle, 0, 0);
        FixForm.Say("MOVED " + s.Left + " " + s.Top);
      } else if (p[0] == "WHERE" && p.Length == 2) {
        FixForm.Say("AT " + p[1] + " " + s.Left + " " + s.Top + " " + s.Width + " " + s.Height);
      }
    };
    poll.Start();

    f.Show();
    s.Show();
    Application.Run();
  }
}
`;

function buildFixture() {
  fs.mkdirSync(DIR, { recursive: true });
  const src = path.join(DIR, 'fixture.cs');
  fs.writeFileSync(src, FIXTURE_CS);
  const r = spawnSync(CSC, ['/nologo', '/target:winexe', '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll',
    '/out:' + FIX_EXE, src], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('fixture did not compile: ' + (r.stdout || '') + (r.stderr || ''));
  fs.copyFileSync(FIX_EXE, DECOY_EXE);
}

/** Launches exe, waits for both hwnds in its log. Returns {proc, log, main, strip, lines()}. */
async function launch(exe, tag) {
  const log = path.join(DIR, `log-${path.basename(exe, '.exe')}-${process.pid}.txt`);
  try { fs.unlinkSync(log); } catch (_) { /* first run */ }
  const proc = spawn(exe, [log, tag], { stdio: 'ignore', windowsHide: false });
  const lines = () => { try { return fs.readFileSync(log, 'utf8').split(/\r?\n/).filter(Boolean); } catch (_) { return []; } };
  const t0 = Date.now();
  let main = null, strip = null;
  while (Date.now() - t0 < 10000 && !(main && strip)) {
    for (const l of lines()) {
      const m = /^HWND (main|strip) (\d+)$/.exec(l);
      if (m && m[1] === 'main') main = m[2];
      if (m && m[1] === 'strip') strip = m[2];
    }
    if (!(main && strip)) await T.sleep(100);
  }
  if (!(main && strip)) { try { proc.kill(); } catch (_) { /* gone */ } throw new Error(exe + ' never reported its windows'); }
  return { proc, log, main, strip, lines };
}

async function waitLine(fx, want, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fx.lines().includes(want)) return Date.now() - t0;
    await T.sleep(50);
  }
  return -1;
}

function flat(items, out) {
  for (const it of items || []) { out.push(it); if (it.items) flat(it.items, out); }
  return out;
}

(async () => {
  const t = T.checker('TOPBAR');
  let s = null, fx = null, decoy = null;
  try {
    s = await T.startPassive();
    const describe = await s.call('ping', {}, 4000).catch(() => null);
    const cmds = (describe && describe.features && describe.features.commands) || [];
    if (cmds.length) t.check('ping lists the topbar commands', ['topbar.focus', 'topbar.watch', 'topbar.menus', 'topbar.invoke',
      'topbar.window', 'topbar.reserve', 'topbar.release', 'topbar.uia', 'topbar.uiaInvoke'].every((c) => cmds.includes(c)), cmds.join(','));

    // ---- what is in front, read-only (the user's window: counts only) --------------------------
    const cold = await s.call('topbar.focus', {}, 4000);   // JIT + the first FileVersionInfo read
    const fg0 = await s.call('topbar.focus', {}, 4000);
    t.check('topbar.focus answers with a hwnd string and flags', typeof fg0.hwnd === 'string' && typeof fg0.fullscreen === 'boolean' &&
      typeof fg0.self === 'boolean' && typeof fg0.uia === 'string', JSON.stringify(Object.keys(fg0)));
    t.check('topbar.focus has either a menu or the reason there is none', !!(fg0.menu || fg0.menuReason));
    t.check('topbar.focus is fast once warm (< 20 ms in the sidecar)', fg0.ms < 20, fg0.ms + ' ms');
    console.log(`  foreground (the user's): menu ${fg0.menu ? fg0.menu.source + ' ' + fg0.menu.count + ' items, ' + fg0.menu.readMs + ' ms' : 'none'}; uia=${fg0.uia === 'try' ? 'try' : 'skip'}; read ${cold.ms} ms cold, ${fg0.ms} ms warm`);

    // ---- passive refuses every write on a real window --------------------------------------
    for (const [cmd, extra] of [['topbar.reserve', { hwnd: fg0.hwnd, size: 35 }], ['topbar.release', { hwnd: fg0.hwnd }]]) {
      const r = await s.send(cmd, extra, 4000);
      t.check(cmd + ' refuses in passive', !r.ok && String(r.error).startsWith(T.PASSIVE_REFUSAL), r.error);
    }

    // ---- stats: one sample a second, pushed (sidecar/TopbarStats.cs) ---------------------------
    const cpuOf = () => { const r = spawnSync('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${s.proc.pid}).TotalProcessorTime.TotalMilliseconds`], { encoding: 'utf8' });
      return parseFloat(String(r.stdout).trim()); };
    const stamps = [];
    let seen = 0;
    const stamper = setInterval(() => { const ev = s.collect('topbarstats'); while (seen < ev.length) { stamps.push([Date.now(), ev[seen]]); seen++; } }, 10);
    const c0 = cpuOf();
    const son = await s.call('topbar.stats', { on: true }, 4000);
    t.check('topbar.stats on: a 1000 ms period', son.on === true && son.periodMs === 1000, JSON.stringify(son));
    console.log('  stats watch: ' + son.watch);
    await T.sleep(10300);
    const c1 = cpuOf(), tc1 = Date.now();
    await T.sleep(5000);
    const c2 = cpuOf(), tc2 = Date.now();   // steady state: PDH's providers are loaded, the JIT is done
    const got = stamps.filter(([, e]) => !e.paused);
    const gaps = got.slice(1).map(([, e], i) => e.at - got[i][1].at);   // the sidecar's clock: node's own loop is blocked by the CPU probes
    t.check('stats: one sample a second (15-17 in ~16 s)', got.length >= 15 && got.length <= 17, got.length + ' samples');
    t.check('stats: evenly spaced (every gap 1000 ms +/- 150)', gaps.length > 0 && gaps.every((g) => g > 850 && g < 1150), gaps.join(','));
    const last = got.length ? got[got.length - 1][1] : {};
    t.check('stats: CPU total and one bar per logical core', typeof last.cpu.pct === 'number' && last.cpu.pct >= 0 && last.cpu.pct <= 100 &&
      last.cpu.cores.length === os.cpus().length, JSON.stringify(last.cpu && { pct: last.cpu.pct, n: (last.cpu.cores || []).length }));
    t.check('stats: RAM in use under a total that matches the OS', last.mem.used > 0 && last.mem.used < last.mem.total &&
      Math.abs(last.mem.total - os.totalmem()) / os.totalmem() < 0.01);
    t.check('stats: GPU is a number or carries its reason', typeof last.gpu.pct === 'number' || !!last.gpu.reason, JSON.stringify(last.gpu).slice(0, 200));
    t.check('stats: network rates are numbers', typeof last.net.down === 'number' && typeof last.net.up === 'number');
    // THE GPU EVERY 2 S (lane mantle-idlefix-stats): the costly \GPU Engine(*) wildcard is its own query, read
    // every 2nd tick; the tick between repeats that reading (same gpu.at, same figure), the rest stays 1 s
    t.check('gpu: read every 2000 ms (topbar.stats says so)', son.gpuEveryMs === 2000, JSON.stringify(son));
    const reads = [];
    for (const [, e] of got) if (e.gpu && typeof e.gpu.at === 'number' && (!reads.length || reads[reads.length - 1].at !== e.gpu.at)) reads.push({ at: e.gpu.at, pct: e.gpu.pct });
    const rgaps = reads.slice(1).map((r, i) => r.at - reads[i].at);
    t.check('gpu: one engine read per 2 s, not per 1 s sample', reads.length >= Math.floor(got.length / 2) - 1 && reads.length <= Math.ceil(got.length / 2) + 1 &&
      rgaps.every((g) => g > 1700 && g < 2300), `${reads.length} reads in ${got.length} samples, gaps ${rgaps.join(',')}`);
    const repeats = got.slice(1).filter(([, e], i) => e.gpu && got[i][1].gpu && e.gpu.at === got[i][1].gpu.at);
    t.check('gpu: the sample between two reads repeats the reading (same figure, same engines)', repeats.length >= 1 && repeats.every(([, e]) => {
      const prev = got[got.findIndex(([, x]) => x === e) - 1][1].gpu;
      return e.gpu.pct === prev.pct && JSON.stringify(e.gpu.engines) === JSON.stringify(prev.engines);
    }), `${repeats.length} repeats`);
    t.check('gpu: the figure is still the busiest engine (>= every engine type shown, <= 100)', typeof last.gpu.pct !== 'number' ||
      (last.gpu.pct <= 100 && (last.gpu.engines || []).every((g) => g.pct <= last.gpu.pct + 0.051)), JSON.stringify(last.gpu).slice(0, 300));
    // PING (sidecar/TopbarPing.cs, lane topbar-ping): the closest Valorant NA stand-in, every 2 s
    const pg = last.ping || {};
    const firstPing = got.length ? (got[0][1].ping || {}) : {};
    t.check('ping: the first sample says measuring, with a reason', firstPing.state === 'measuring' && firstPing.ms == null && !!firstPing.reason, JSON.stringify(firstPing).slice(0, 200));
    t.check('ping: a round trip in ms to a named server (or a reason)', (pg.state === 'ok' && typeof pg.ms === 'number' && pg.ms >= 0 && pg.ms < 1100 && !!pg.server && /^(icmp|tcp)$/.test(pg.method))
      || (pg.state !== 'ok' && pg.ms == null && !!pg.reason), JSON.stringify(pg).slice(0, 300));
    t.check('ping: every target of the list was measured once at start', Array.isArray(pg.picked) && pg.picked.length >= 1 && pg.picked.every((p) => typeof p.ms === 'number' || !!p.why) && pg.picks === 1,
      JSON.stringify(pg.picked));
    if (pg.state === 'ok' && pg.picked) t.check('ping: the chosen server is the lowest of the pick', pg.picked.filter((p) => typeof p.ms === 'number').every((p) => p.ms >= pg.picked.find((q) => q.name === pg.server).ms));
    const echoSpan = got.filter(([, e]) => e.ping && e.ping.echoes > 0);
    const echoN = echoSpan.length > 1 ? echoSpan[echoSpan.length - 1][1].ping.echoes - echoSpan[0][1].ping.echoes : -1;
    const echoS = echoSpan.length > 1 ? (echoSpan[echoSpan.length - 1][1].at - echoSpan[0][1].at) / 1000 : 0;
    t.check('ping: one echo every ~2 s', echoN >= Math.floor(echoS / 2) - 1 && echoN <= Math.ceil(echoS / 2) + 1, `${echoN} echoes in ${echoS.toFixed(1)} s`);
    console.log(`  ping: ${pg.state} ${pg.ms} ms to ${pg.label} ${pg.server} (${pg.via}, ${pg.method}); pick: ${(pg.picked || []).map((p) => `${p.name} ${p.ms != null ? p.ms : 'x'}`).join(', ')}`);
    const costs = got.map(([, e]) => e.costMs).sort((a, b) => a - b);
    const wall = got.map(([, e]) => e.ms).sort((a, b) => a - b);
    const med = (a) => a[Math.floor(a.length / 2)];
    console.log(`  stats: ${got.length} samples; sampler CPU per tick median ${med(costs)} ms (max ${costs[costs.length - 1]}); wall per tick median ${med(wall)} ms; ` +
      `whole sidecar ${Math.round(c1 - c0)} ms CPU in the first ~10 s (PDH start-up included); GPU ${last.gpu.name || '?'} engines ${(last.gpu.engines || []).length}`);
    // costMs is thread CPU time, which Windows counts in 15.625 ms quanta: each tick reads 0, 15.6 or 31.3, so
    // the MEDIAN flips to 15.6 whenever just over half the ticks straddle a quantum (a busy machine) and says
    // nothing about the real cost. The MEAN over the ticks is the honest estimate (lane mn-suite, 2026-10-12).
    const meanCost = costs.reduce((s, x) => s + x, 0) / Math.max(1, costs.length);
    t.check('stats: cheap - the sampler costs under 10 ms of CPU per tick (mean over the ticks)', meanCost < 10, `mean ${meanCost.toFixed(2)}: ${costs.join(',')}`);
    // detail: the top processes by name, only while asked
    await s.call('topbar.stats', { detail: 'mem' }, 4000);
    await T.sleep(1300);
    const dls = s.collect('topbarstats').filter((e) => e.detail === 'mem');
    const dl = dls[dls.length - 1];
    t.check('gpu: while a detail is asked the engines are read every sample (its top processes stay 1 s)', dls.length >= 2 &&
      new Set(dls.map((e) => e.gpu && e.gpu.at)).size === dls.length, dls.map((e) => e.gpu && e.gpu.at).join(','));
    t.check('stats detail: top processes for CPU, RAM and GPU arrive while asked', !!dl && Array.isArray(dl.cpu.top) && Array.isArray(dl.mem.top) && dl.mem.top.length === 5,
      JSON.stringify(dl && { cpu: (dl.cpu.top || []).length, mem: (dl.mem.top || []).length }));
    if (dl) {
      const sum = dl.mem.top.reduce((a, p) => a + p.bytes, 0);
      t.check('stats detail: private working sets are plausible (top one > 10 MB, top five < RAM in use)', dl.mem.top[0].bytes > 10 * 2 ** 20 && sum < dl.mem.used, `${Math.round(dl.mem.top[0].bytes / 2 ** 20)} MB, sum ${Math.round(sum / 2 ** 20)} MB`);
      t.check('stats detail: process CPU shares are percentages', dl.cpu.top.every((p) => p.pct >= 0 && p.pct <= 100));
    }
    // App power fields on every top entry (lane mantle-power-sidecar, 2026-10-14): exe, n, path, access,
    // and the generic hosts (electron, node, python, ...) split by path. Two throwaway burners both named
    // python.exe, in two folders, spin one thread each: they must come back as two rows. The user's own rows
    // are only READ (and nothing of them is printed).
    {
      const B = require('./apppower-burner');
      const run = B.runDir();
      const pyA = B.build(path.join(run.dir, 'a'), 'python'), pyB = B.build(path.join(run.dir, 'b'), 'python');
      const burners = [B.start(pyA, ['spin', '1'], { life: 60 }), B.start(pyB, ['spin', '1'], { life: 60 })];
      try {
        await T.sleep(800);
        await s.call('topbar.stats', { detail: 'cpu' }, 4000);
        await T.sleep(2600);
        const de = s.collect('topbarstats').filter((e) => e.detail === 'cpu' && e.cpu && Array.isArray(e.cpu.top)).pop();
        const rows = de ? [].concat(de.cpu.top, de.mem.top || [], de.gpu.top || []) : [];
        const CODES = ['ok', 'admin', 'system', 'protected', 'game', 'unknown'];
        t.check('top entries: every row has exe, n, path and an access code', rows.length >= 5 && rows.every((r) =>
          (typeof r.exe === 'string' || r.exe === null) && Number.isInteger(r.n) && r.n >= 1 && (typeof r.path === 'string' || r.path === null) &&
          CODES.includes(r.access) && r.name === (r.exe || r.name.split(' (')[0]) + (r.n > 1 ? ` (${r.n})` : '')),
          JSON.stringify(rows.map((r) => [typeof r.exe, r.n, typeof r.path, r.access])));
        const py = de ? de.cpu.top.filter((r) => r.exe === 'python' && (r.path === pyA || r.path === pyB)) : [];
        t.check('top entries: two python.exe burners in two folders are two rows (generic host split by path)',
          py.length === 2 && py[0].path !== py[1].path && py.every((r) => r.n === 1 && r.access === 'ok' && r.pct > 3),
          JSON.stringify(py.map((r) => ({ n: r.n, pct: r.pct, access: r.access, mine: true }))));
        const el = rows.filter((r) => /^electron$/i.test(r.exe || ''));
        const cpuEl = de ? de.cpu.top.filter((r) => /^electron$/i.test(r.exe || '')) : [];
        t.check('top entries: electron rows of one list never share a path (Mantle, Helm and test copies apart)',
          new Set(cpuEl.map((r) => (r.path || '').toLowerCase())).size === cpuEl.length, `${cpuEl.length} electron rows`);
        const own = rows.filter((r) => r.exe && /^Mantle\.Sidecar$/i.test(r.exe));
        t.check('top entries: this sidecar\'s own row (if listed) is protected', own.every((r) => r.access === 'protected'), JSON.stringify(own.map((r) => r.access)));
        console.log(`  top entries: ${rows.length} rows read; electron rows ${el.length}; access ${CODES.map((c) => c + ' ' + rows.filter((r) => r.access === c).length).join(', ')}`);
      } finally { for (const b of burners) B.kill(b.pid); await B.cleanup(run.dir); }
    }
    const soff = await s.call('topbar.stats', { on: false }, 4000);
    const nOff = s.collect('topbarstats').length;
    await T.sleep(2500);
    t.check('stats off: no more samples', soff.on === false && s.collect('topbarstats').length <= nOff + 1, `${s.collect('topbarstats').length - nOff} after off`);
    const c3 = cpuOf(), tc3 = Date.now();
    await T.sleep(5000);
    const c4 = cpuOf(), tc4 = Date.now();
    const onRate = (c2 - c1) / ((tc2 - tc1) / 1000), offRate = (c4 - c3) / ((tc4 - tc3) / 1000);
    console.log(`  steady state, whole sidecar: stats ON ${onRate.toFixed(1)} ms CPU/s, OFF ${offRate.toFixed(1)} ms CPU/s -> the stats cost ~${(onRate - offRate).toFixed(1)} ms CPU per 1 s tick (${((onRate - offRate) / 10).toFixed(2)}% of one core)`);
    clearInterval(stamper);

    // ---- ping: the failure and fallback paths, on throwaway sidecars with a TEST target list --------
    // MANTLE_PING_TARGETS is honoured by a --passive sidecar only. Nothing on the user's network is
    // changed: 192.0.2.1 is TEST-NET-1 (RFC 5737, never routed), "nope.invalid" never resolves (RFC
    // 6761), and the TCP case is an AWS API endpoint that answers TCP 443 but not ICMP.
    const pingWith = async (name, targets, ms) => {
      const file = path.join(os.tmpdir(), `mantle-ping-${name}-${process.pid}.json`);
      fs.writeFileSync(file, JSON.stringify({ use: 'x', sets: { x: { label: 'Test', targets } } }));
      process.env.MANTLE_PING_TARGETS = file;
      let ps = null;
      try {
        ps = await T.startPassive({ exe: s.exe });
        await ps.call('topbar.stats', { on: true }, 4000);
        await T.sleep(ms);
        return ps.collect('topbarstats').filter((e) => !e.paused).map((e) => e.ping || {});
      } finally {
        delete process.env.MANTLE_PING_TARGETS;
        if (ps) { try { ps.proc.kill(); } catch (_) { /* gone */ } }
        try { fs.unlinkSync(file); } catch (_) { /* gone */ }
      }
    };
    const dead = await pingWith('dead', [{ name: 'Nowhere', host: '192.0.2.1', port: 443 }, { name: 'Nobody', host: 'nope.invalid', port: 443 }], 5000);
    const dl0 = dead[dead.length - 1] || {};
    t.check('ping: nothing answers -> no value, a reason in words', dl0.ms == null && /^(unreachable|offline|timeout)$/.test(dl0.state) && /none of the 2 Test servers answered|offline/.test(dl0.reason || ''),
      JSON.stringify(dl0).slice(0, 300));
    t.check('ping: each dead target says why', Array.isArray(dl0.picked) && dl0.picked.every((p) => p.ms == null && /no reply|could not/.test(p.why || '')), JSON.stringify(dl0.picked));
    t.check('ping: the test list is named in the payload', /MANTLE_PING_TARGETS/.test(dl0.test || ''));
    console.log('  ping, dead list: ' + dl0.reason + ' | ' + (dl0.picked || []).map((p) => p.why).join(' | '));
    const tcp = await pingWith('tcp', [{ name: 'TCP only', host: 'ec2.us-west-1.amazonaws.com', port: 443 }, { name: 'Nowhere', host: '192.0.2.1', port: 443 }], 7000);
    const tl = tcp[tcp.length - 1] || {};
    t.check('ping: a host without ICMP is timed by a TCP connect', tl.state === 'ok' && tl.method === 'tcp' && typeof tl.ms === 'number' && tl.server === 'TCP only', JSON.stringify(tl).slice(0, 300));
    // the PING dropdown's ping test (sidecar/PingTest.cs, lane pingtest): local runs, failures, cancel, one real run
    await require('./pingtest-checks').pingTestChecks(t, T, s.exe);

    // ---- the fixture --------------------------------------------------------------------------
    buildFixture();
    const fxHwnds = () => [fx, decoy].filter(Boolean).flatMap((f) => [f.main, f.strip]);
    const fgLog = [];
    const probe = async (when) => { const f = await s.call('topbar.focus', { menu: false }, 4000); if (fxHwnds().includes(f.hwnd)) fgLog.push(when); };
    fx = await launch(FIX_EXE, '');
    decoy = await launch(DECOY_EXE, ' (decoy)');
    await probe('after launch');

    const fm = await s.call('topbar.focus', { hwnd: fx.main }, 4000);
    t.check('fixture: Win32 menu read', fm.menu && fm.menu.source === 'win32', JSON.stringify(fm.menuReason));
    const top = (fm.menu && fm.menu.items) || [];
    t.check('fixture: three top-level menus, labels and mnemonics parsed', top.length === 3 &&
      top[0].label === 'File' && top[0].mn === 'f' && top[1].label === 'Edit' && top[2].label === 'Help',
      JSON.stringify(top.map((i) => [i.label, i.mn])));
    const all = flat(top, []);
    const by = (l) => all.find((i) => i.label === l);
    t.check('fixture: shortcut text split off the label', by('New') && by('New').key === 'Ctrl+N' && by('Open...').key === 'Ctrl+O');
    t.check('fixture: "&&" is a literal ampersand', !!by('About & Info'), JSON.stringify(all.map((i) => i.label)));
    t.check('fixture: separators kept', (top[0].items || []).filter((i) => i.t === 'sep').length === 2);
    t.check('fixture: submenu read with its items', by('Recent') && by('Recent').items && by('Recent').items.length === 2 && by('Recent').id === null);
    t.check('fixture: disabled / checked / radio states', by('Disabled') && by('Disabled').enabled === false &&
      by('Checked').checked === true && by('Radio').radio === true && by('Radio').checked === true && by('New').enabled === true);
    t.check('fixture: every leaf has a numeric command id', all.filter((i) => i.t === 'item' && !i.items).every((i) => typeof i.id === 'number'));
    t.check('fixture: the fixture is not "self" and not full-screen', fm.self === false && fm.fullscreen === false);

    const mi = await s.call('topbar.menus', { hwnd: fx.main, init: [0] }, 4000);
    t.check('fixture: WM_INITMENUPOPUP sent (fixture only) and the menu re-read', mi.inited === 1 && mi.menu && mi.menu.items.length === 3, JSON.stringify(mi.initNote));
    const md = await s.call('topbar.menus', { hwnd: decoy.main, init: [0] }, 4000);
    t.check('decoy: WM_INITMENUPOPUP NOT sent in passive, and it says so', md.inited === 0 && /passive/.test(md.initNote || ''));

    // invoke: the real round trip, WM_COMMAND -> the fixture's Click handler
    const tInv = Date.now();
    const inv = await s.send('topbar.invoke', { hwnd: fx.main, item: by('New').id }, 4000);
    t.check('fixture: invoke "New" accepted', inv.ok && inv.result.label === 'New' && inv.result.fixture === true, JSON.stringify(inv.error));
    const clickMs = await waitLine(fx, 'CLICK &New\tCtrl+N', 3000);
    t.check('fixture: the app ran "New" (its Click handler fired)', clickMs >= 0);
    await probe('after invoke');
    console.log(`  invoke -> app handler: ${clickMs >= 0 ? Date.now() - tInv : 'never'} ms`);
    const sub = by('Recent').items[1];
    const inv2 = await s.send('topbar.invoke', { hwnd: fx.main, item: sub.id }, 4000);
    t.check('fixture: invoke a submenu item', inv2.ok && (await waitLine(fx, 'CLICK b.txt', 3000)) >= 0, JSON.stringify(inv2.error));
    const dis = await s.send('topbar.invoke', { hwnd: fx.main, item: by('Disabled').id }, 4000);
    t.check('fixture: a greyed item is refused with the reason', !dis.ok && /greyed out/.test(dis.error), dis.error);
    const gone = await s.send('topbar.invoke', { hwnd: fx.main, item: 65000 }, 4000);
    t.check('fixture: an id the menu does not have is refused', !gone.ok && /no longer has a menu item/.test(gone.error), gone.error);
    const dv = await s.send('topbar.invoke', { hwnd: decoy.main, item: by('New').id }, 4000);
    t.check('decoy: invoke REFUSED in passive (same title, wrong exe)', !dv.ok && String(dv.error).startsWith(T.PASSIVE_REFUSAL), dv.error);
    t.check('decoy: and its app never ran the command', (await waitLine(decoy, 'CLICK &New\tCtrl+N', 600)) < 0);

    // window actions: the fixture only; zoom only as a dry run (a real one would put it on screen)
    const on = await s.send('topbar.window', { hwnd: fx.main, action: 'ontop', on: true }, 4000);
    t.check('fixture: always-on-top on', on.ok && on.result.topmost === true, JSON.stringify(on.error || on.result));
    const off = await s.send('topbar.window', { hwnd: fx.main, action: 'ontop', on: false }, 4000);
    t.check('fixture: always-on-top off', off.ok && off.result.topmost === false, JSON.stringify(off.error || off.result));
    const zd = await s.send('topbar.window', { hwnd: fx.main, action: 'zoom', dryRun: true }, 4000);
    t.check('fixture: zoom dry run names SC_MAXIMIZE', zd.ok && zd.result.did === 'SC_MAXIMIZE' && zd.result.dryRun === true);
    const zr = await s.send('topbar.window', { hwnd: fx.main, action: 'zoom' }, 4000);
    t.check('fixture: a real zoom is refused (it would put the fixture on screen)', !zr.ok && /never run on the test fixture/.test(zr.error), zr.error);
    const mn = await s.send('topbar.window', { hwnd: fx.main, action: 'minimize' }, 4000);   // not the strip: a minimised window's UIA tree is only its title bar
    t.check('fixture: minimise a background window WITHOUT activation', mn.ok && mn.result.did === 'SW_SHOWMINNOACTIVE', JSON.stringify(mn.error || mn.result));
    for (const action of ['close', 'quit', 'ontop', 'minimize']) {
      const r = await s.send('topbar.window', { hwnd: decoy.main, action }, 4000);
      t.check(`decoy: window ${action} REFUSED in passive`, !r.ok && String(r.error).startsWith(T.PASSIVE_REFUSAL), r.error);
    }
    await probe('after window actions');
    const qd = await s.send('topbar.window', { hwnd: fx.main, action: 'quit', dryRun: true }, 4000);
    t.check('fixture: quit dry run finds both fixture windows and no others', qd.ok && qd.result.windows === 2 && qd.result.sent === 0, JSON.stringify(qd.result));

    // UI Automation: the MenuStrip window has no Win32 menu
    const fs2 = await s.call('topbar.focus', { hwnd: fx.strip }, 4000);
    t.check('fixture (strip): no Win32 menu, so UIA is worth a try', !fs2.menu && fs2.uia === 'try', fs2.uia);
    const u = await s.call('topbar.uia', { hwnd: fx.strip }, 15000);
    const ui = (u.menu && u.menu.items) || [];
    t.check('fixture (strip): UIA menu bar read', u.menu && u.menu.source === 'uia', u.reason);
    console.log('  UIA bar candidates: ' + JSON.stringify(u.bars));
    t.check('fixture (strip): UIA items Tools (a submenu) and Go', ui.length === 2 && ui[0].label === 'Tools' && ui[0].mn === 't' &&
      !!ui[0].items && ui[1].label === 'Go' && !ui[1].items, JSON.stringify(ui.map((i) => [i.label, i.mn, !!i.items, i.lazy])));
    console.log(`  UIA read of the strip: ${u.menu ? u.menu.readMs : '-'} ms; Tools children ${ui[0] && ui[0].items ? ui[0].items.length : '-'} (lazy=${ui[0] && ui[0].lazy})`);
    // NO UIA INVOKE ON THE FIXTURE (removed 2026-09-24): invoking the MenuStrip's "Go" through UI
    // Automation ACTIVATED the fixture window - WS_EX_NOACTIVATE did not stop WinForms' menu mode -
    // and took the keyboard focus from whoever was at the machine, in 2 of ~9 runs. A UIA invoke is
    // proven only by a live run on a real app. The refusal paths below run nothing.
    await probe('after UIA invoke');
    const un = await s.send('topbar.uiaInvoke', { hwnd: fx.strip, path: [1], names: ['Nope'] }, 15000);
    t.check('fixture (strip): a stale path is refused with the reason', !un.ok && /menu changed/.test(un.error), un.error);
    const ud = await s.send('topbar.uiaInvoke', { hwnd: decoy.strip, path: [1] }, 15000);
    t.check('decoy (strip): UIA invoke REFUSED in passive', !ud.ok && String(ud.error).startsWith(T.PASSIVE_REFUSAL), ud.error);

    // ---- nothing goes past the bar: the drag-end guard ------------------------------------------
    // The bar rect is FAKE and sits where the fixture lives (-6000,-6000): the real strip is on
    // the user's screen. The fixture moves ITSELF and raises the drag-end event itself; no input is
    // injected and nothing is activated.
    const BAR = [-6400, -6000, -5000, -5972];
    const gOn = await s.send('topbar.guard', { on: true, bar: BAR }, 4000);
    t.check('guard: on, with the bar rect', gOn.ok && gOn.result.guard === true && gOn.result.bar[3] === -5972, JSON.stringify(gOn.error || gOn.result));
    const gBad = await s.send('topbar.guard', { on: true, bar: [0, 0, 5] }, 4000);
    t.check('guard: a bad rect is refused with the reason', !gBad.ok && /bar:\[left/.test(gBad.error), gBad.error);
    const cmd = (f, line) => fs.writeFileSync(f.log + '.cmd', line);
    const at = async (f, tag) => {
      cmd(f, 'WHERE ' + tag);
      const t0 = Date.now();
      while (Date.now() - t0 < 3000) {
        const l = f.lines().find((x) => x.startsWith('AT ' + tag + ' '));
        if (l) { const n = l.split(' ').slice(2).map(Number); return { x: n[0], y: n[1], w: n[2], h: n[3] }; }
        await T.sleep(40);
      }
      return null;
    };
    const guardEv = (hwnd, since) => s.waitEvent('topbar', 2500, (e) => e.kind === 'guard' && e.hwnd === hwnd && s.events.indexOf(e) >= since).catch(() => null);
    // 1. dragged up so its title bar is inside the strip -> put back below it at drag end, size kept
    let since = s.events.length;
    cmd(fx, 'MOVE -6000 -5990');
    const g1 = await guardEv(fx.strip, since);
    const p1 = await at(fx, 'g1');
    const inset = g1 ? g1.visible[1] - (-5990) : 0;   // visible frame top vs window rect top
    t.check('guard: a window dragged into the strip is put back below it at drag end', g1 && g1.ok && !g1.dryRun && g1.fixture &&
      g1.dy > 0 && p1 && p1.y + inset === -5972, JSON.stringify({ g1, p1 }));
    t.check('guard: moved, not resized (the fixture stays 320x200)', p1 && p1.w === 320 && p1.h === 200 && g1 && g1.resize === false, JSON.stringify(p1));
    console.log(`  guard: visible top ${g1 && g1.visible[1]} -> bar bottom ${BAR[3]} (${g1 && g1.how}); visible frame starts ${inset} px below the window rect`);
    await probe('after the guard moved the fixture');
    // 2. already below the strip -> untouched, no event
    since = s.events.length;
    cmd(fx, 'MOVE -6000 -5900');
    const g2 = await guardEv(fx.strip, since);
    const p2 = await at(fx, 'g2');
    t.check('guard: a window below the strip is left alone', !g2 && p2 && p2.y === -5900, JSON.stringify({ g2, p2 }));
    // 3. the decoy (same title, wrong exe): measured and reported as a dry run, NOT moved
    since = s.events.length;
    cmd(decoy, 'MOVE -6000 -5990');
    const g3 = await guardEv(decoy.strip, since);
    const p3 = await at(decoy, 'g3');
    t.check('guard: in passive another app is only measured (dryRun), never moved', g3 && g3.dryRun === true && !g3.fixture && p3 && p3.y === -5990,
      JSON.stringify({ g3, p3 }));
    // 4. guard off -> no more put-backs
    const gOff = await s.send('topbar.guard', { on: false }, 4000);
    t.check('guard: off unhooks, and counts what it saw', gOff.ok && gOff.result.guard === false && gOff.result.seen >= 2 && gOff.result.moved >= 1, JSON.stringify(gOff.result));
    since = s.events.length;
    cmd(fx, 'MOVE -6000 -5995');
    const g4 = await guardEv(fx.strip, since);
    t.check('guard: off means no put-back', !g4);

    // ---- games step aside: the verdict from given inputs (no game has to run) ------------------
    const cls = (x) => s.call('topbar.classify', x, 4000);
    const v1 = await cls({ exe: 'C:\\Riot Games\\VALORANT\\live\\ShooterGame\\Binaries\\Win64\\VALORANT-Win64-Shipping.exe', covers: true, quns: 2 });
    t.check('game: Valorant borderless (covers the monitor) steps aside, and says why', v1.stepAside === true && /known game/.test(v1.signal) && /borderless/.test(v1.signal), v1.signal);
    const v2 = await cls({ exe: 'C:\\x\\VALORANT-Win64-Shipping.exe', covers: false, quns: 5 });
    t.check('game: Valorant in a normal window keeps the bar', v2.stepAside === false);
    const v3 = await cls({ exe: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', covers: true, quns: 2 });
    t.check('game: a browser in F11 keeps the bar (not a game)', v3.stepAside === false && v3.known === null);
    const v4 = await cls({ exe: 'C:\\x\\somegame.exe', covers: false, quns: 3 });
    t.check('game: exclusive full-screen D3D steps aside whatever the exe', v4.stepAside === true && /QUNS_RUNNING_D3D_FULL_SCREEN/.test(v4.signal), v4.signal);
    const v5 = await cls({ exe: 'C:\\Java\\bin\\javaw.exe', title: 'Minecraft 1.21.1', covers: true, quns: 5 });
    const v6 = await cls({ exe: 'C:\\Java\\bin\\javaw.exe', title: 'Some Java tool', covers: true, quns: 5 });
    t.check('game: javaw is Minecraft only by its title', v5.stepAside === true && v6.stepAside === false, JSON.stringify([v5.known, v6.known]));
    const v7 = await cls({ exe: 'C:\\x\\RobloxPlayerBeta.exe', covers: true, quns: 5 });
    t.check('game: Roblox full screen steps aside', v7.stepAside === true);
    t.check('game: the Game Bar list was read (or says why not)', typeof v1.gameStore === 'boolean' && (v1.storeNote === null || typeof v1.storeNote === 'string'), v1.storeNote);
    t.check('topbar.focus carries the game verdict', fg0.game && typeof fg0.game.stepAside === 'boolean' && typeof fg0.game.quns === 'number', JSON.stringify(fg0.game));
    console.log(`  game verdict on the user's foreground now: stepAside=${fg0.game && fg0.game.stepAside}, QUNS ${fg0.game && fg0.game.quns} (${fg0.game && fg0.game.qunsName})`);

    // watch: read-only hooks; the user's own focus changes (if any) are counted, never shown
    const w = await s.call('topbar.watch', { on: true }, 4000);
    t.check('topbar.watch on answers with the current focus', w.watching === true && w.focus && typeof w.focus.hwnd === 'string');
    await T.sleep(1500);
    const focusEvents = s.collect('topbar').filter((e) => e.kind === 'focus');
    const woff = await s.call('topbar.watch', { on: false }, 4000);
    t.check('topbar.watch off unhooks', woff.watching === false);
    if (focusEvents.length) {
      const lags = focusEvents.map((e) => e.lagMs).filter((n) => typeof n === 'number');
      console.log(`  focus events seen while watching: ${focusEvents.length}; hook lag ${Math.min(...lags)}-${Math.max(...lags)} ms; read ${Math.max(...focusEvents.map((e) => e.ms))} ms`);
      t.check('focus events leave the sidecar within 100 ms of the change', lags.every((n) => n < 100), lags.join(','));
    } else {
      console.log('  focus events seen while watching: 0 (nobody changed focus; only a live run measures that path)');
    }

    // the fixture never took the foreground, at any point
    const fg1 = await s.call('topbar.focus', { menu: false }, 4000);
    if (fxHwnds().includes(fg1.hwnd)) fgLog.push('at the end');
    t.check('the foreground was never the fixture or the decoy', fgLog.length === 0 &&
      !focusEvents.some((e) => fxHwnds().includes(e.hwnd)), fgLog.join('; '));

    // quit: every fixture window gets SC_CLOSE and the process ends
    const q = await s.send('topbar.window', { hwnd: fx.main, action: 'quit' }, 4000);
    t.check('fixture: quit asked both windows to close', q.ok && q.result.sent === 2, JSON.stringify(q.error || q.result));
    const exited = await new Promise((r) => { if (fx.proc.exitCode !== null) r(true); fx.proc.once('exit', () => r(true)); setTimeout(() => r(false), 4000); });
    t.check('fixture: the app closed itself after quit', exited);
  } catch (e) {
    t.fail('the run threw', e.stack || e.message);
  } finally {
    for (const f of [fx, decoy]) if (f) { try { f.proc.kill(); } catch (_) { /* gone */ } try { fs.unlinkSync(f.log); } catch (_) { /* gone */ } }
    if (s) await s.stop();
  }
  process.exit(t.summary());
})();

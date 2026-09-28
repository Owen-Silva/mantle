// test-ontop.js - "Keep on top": the sidecar half (sidecar/WindowTop.cs) and its chord (Win+Ctrl+T in
// KeyMachine, sidecar/AltTab.cs). Lane ontop, 2026-09-27.
//
//   MANTLE_SIDECAR_EXE=<your exe> node sidecar/test-ontop.js
//
// PASSIVE, like every sidecar test. The chord is proved through `hotkey {op:'simulate'}` (the PURE
// key machine fed scripted keys: no hook, not one real keystroke). Every write goes to a FIXTURE
// this test compiles into %TEMP%: WinForms windows at -6000,-6000, WS_EX_NOACTIVATE +
// WS_EX_TOOLWINDOW, shown without activation, so nothing on Owen's screen moves, is covered or
// takes the focus. A DECOY (the same exe under another name) must be REFUSED, proving the passive
// guard is the exe check and not the title. Owen's own windows are only READ (ontop.front, the
// taskbar's facts), and nothing of them is printed. The fixture kills itself after 120 s if this
// test dies first.
//
// Prints one summary line, "ONTOP TEST: n passed, m failed".
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const T = require('./test-lib');

const DIR = path.join(os.tmpdir(), 'mantle-ontop');
const FIX_EXE = path.join(DIR, 'mantle-ontop-fixture.exe');
const DECOY_EXE = path.join(DIR, 'mantle-ontop-decoy.exe');
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
    get { CreateParams cp = base.CreateParams; cp.ExStyle |= 0x08000000 | 0x80; return cp; }   // NOACTIVATE | TOOLWINDOW
  }
  public static void Say(string s) { try { File.AppendAllText(Log, s + "\r\n"); } catch (Exception) { } }
}

static class P {
  static int _open = 2;
  static FixForm Make(string title, int y, bool top) {
    var f = new FixForm();
    f.Text = title;
    f.StartPosition = FormStartPosition.Manual;
    f.Location = new Point(-6000, y);
    f.Size = new Size(240, 160);
    f.TopMost = top;
    f.FormClosed += delegate { FixForm.Say("CLOSED " + title); if (--_open == 0) Application.ExitThread(); };
    return f;
  }
  [STAThread]
  static void Main(string[] a) {
    FixForm.Log = a[0];
    string tag = a.Length > 1 ? a[1] : "";
    var t = new System.Windows.Forms.Timer(); t.Interval = 120000; t.Tick += delegate { Application.ExitThread(); }; t.Start();
    FixForm m = Make("Mantle ontop fixture" + tag, -6000, false);
    FixForm p = Make("Mantle ontop fixture (already on top)" + tag, -5700, true);
    m.Shown += delegate { FixForm.Say("HWND main " + m.Handle.ToInt64()); };
    p.Shown += delegate { FixForm.Say("HWND pre " + p.Handle.ToInt64()); };
    // Commands from the test, one line in <log>.cmd (polled; the fixture never reads input):
    //   CLOSE   close the main window (the pinned one "closes")
    //   HANG ms stop pumping messages for ms (so Windows calls its windows hung after ~5 s)
    string cmdPath = a[0] + ".cmd";
    var poll = new System.Windows.Forms.Timer(); poll.Interval = 60;
    poll.Tick += delegate {
      string c = null;
      try { if (File.Exists(cmdPath)) { c = File.ReadAllText(cmdPath).Trim(); File.Delete(cmdPath); } } catch (Exception) { c = null; }
      if (string.IsNullOrEmpty(c)) return;
      string[] q = c.Split(' ');
      if (q[0] == "CLOSE") m.Close();
      else if (q[0] == "HANG" && q.Length == 2) { FixForm.Say("HANGING"); Thread.Sleep(int.Parse(q[1])); FixForm.Say("AWAKE"); }
    };
    poll.Start();
    m.Show();
    p.Show();
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

/** Launches exe, waits for both hwnds in its log. Returns {proc, log, main, pre, lines(), cmd(line)}. */
async function launch(exe, tag) {
  const log = path.join(DIR, `log-${path.basename(exe, '.exe')}-${process.pid}.txt`);
  try { fs.unlinkSync(log); } catch (_) { /* first run */ }
  const proc = spawn(exe, [log, tag], { stdio: 'ignore', windowsHide: false });
  const lines = () => { try { return fs.readFileSync(log, 'utf8').split(/\r?\n/).filter(Boolean); } catch (_) { return []; } };
  const t0 = Date.now();
  let main = null, pre = null;
  while (Date.now() - t0 < 10000 && !(main && pre)) {
    for (const l of lines()) {
      const m = /^HWND (main|pre) (\d+)$/.exec(l);
      if (m && m[1] === 'main') main = m[2];
      if (m && m[1] === 'pre') pre = m[2];
    }
    if (!(main && pre)) await T.sleep(100);
  }
  if (!(main && pre)) { try { proc.kill(); } catch (_) { /* gone */ } throw new Error(exe + ' never reported its windows'); }
  return { proc, log, main, pre, lines, cmd: (line) => fs.writeFileSync(log + '.cmd', line) };
}

async function waitLine(fx, want, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fx.lines().includes(want)) return Date.now() - t0;
    await T.sleep(50);
  }
  return -1;
}

/* ---- the chord, through the pure key machine -------------------------------------------------- */
const VK = { LWIN: 0x5B, LCTRL: 0xA2, RCTRL: 0xA3, LSHIFT: 0xA0, LALT: 0xA4, T: 0x54, LEFT: 0x25, C: 0x43 };
const MOD_UP = new Set([VK.LWIN, 0x5C, VK.LALT, 0xA5, 0x12, VK.LSHIFT, 0xA1, VK.LCTRL, VK.RCTRL, 0x11]);
function kv(vk, down, o) { return Object.assign({ vk, down }, o || {}); }
function stepWords(st) {
  const head = st.swallow ? 'S' : st.dummy ? 'D' : st.ignored ? 'I' : 'P';
  if (st.event === 'none') return head;
  return `${head} ${st.event}${st.chord ? `:${st.chord}` : ''}`;
}
const ALL = ['Win+S', 'Win+V', 'Win+Tab', 'Win+Left', 'Win+Right', 'Win+Up', 'Win+Down', 'Win+Z', 'Win+Shift+S', 'PrintScreen',
  'VolumeUp', 'VolumeDown', 'VolumeMute', 'Win+Alt+T', 'Win+Ctrl+T'];

async function chordChecks(s, t) {
  const sim = async (name, opts, events, want) => {
    let r;
    try { r = await s.send('hotkey', Object.assign({ op: 'simulate', events }, opts || {})); } catch (e) { t.fail(name, e.message); return; }
    if (!r.ok) { t.fail(name, r.error); return; }
    const steps = r.result.steps;
    events.forEach((e, i) => {
      if (e.down === false && MOD_UP.has(e.vk) && steps[i].swallow) t.fail(`${name}: step ${i} swallowed a modifier keyup`);
    });
    const got = steps.map(stepWords);
    t.check(`chord: ${name}`, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  };
  const winD = kv(VK.LWIN, true), winU = kv(VK.LWIN, false);
  const ctD = kv(VK.LCTRL, true), ctU = kv(VK.LCTRL, false);
  const wc = { win: true, ctrl: true };
  await sim('Win+Ctrl+T taken when on (Win first, Ctrl up first): Ctrl-up AND Win-up get the partner key', { chords: ['Win+Ctrl+T'] },
    [winD, ctD, kv(VK.T, true, wc), kv(VK.T, false, wc), ctU, winU], ['P', 'P', 'S chord:Win+Ctrl+T', 'S', 'D', 'D']);
  await sim('Win+Ctrl+T taken (Ctrl first, Win up first), with every chord on', { chords: ALL },
    [ctD, winD, kv(VK.T, true, wc), kv(VK.T, false, wc), winU, ctU], ['P', 'P', 'S chord:Win+Ctrl+T', 'S', 'D', 'D']);
  await sim('the RIGHT Ctrl works the same', { chords: ['Win+Ctrl+T'] },
    [winD, kv(VK.RCTRL, true), kv(VK.T, true, wc), kv(VK.T, false, wc), kv(VK.RCTRL, false), winU], ['P', 'P', 'S chord:Win+Ctrl+T', 'S', 'D', 'D']);
  await sim('held T: one event, repeats swallowed', { chords: ['Win+Ctrl+T'] },
    [winD, ctD, kv(VK.T, true, wc), kv(VK.T, true, wc), kv(VK.T, true, wc), kv(VK.T, false, wc), ctU, winU],
    ['P', 'P', 'S chord:Win+Ctrl+T', 'S', 'S', 'S', 'D', 'D']);
  await sim('T released and pressed again with Win+Ctrl held: a second toggle', { chords: ['Win+Ctrl+T'] },
    [winD, ctD, kv(VK.T, true, wc), kv(VK.T, false, wc), kv(VK.T, true, wc), kv(VK.T, false, wc), ctU, winU],
    ['P', 'P', 'S chord:Win+Ctrl+T', 'S', 'S chord:Win+Ctrl+T', 'S', 'D', 'D']);
  await sim("Win+Ctrl+T is Windows' own when off", { chords: ['Win+Alt+T'] },
    [winD, ctD, kv(VK.T, true, wc), kv(VK.T, false, wc), ctU, winU], ['P', 'P', 'P', 'P', 'P', 'P']);
  await sim('Ctrl+T (a browser\'s new tab) is not Win+Ctrl+T', { chords: ALL, altTab: false },
    [ctD, kv(VK.T, true, { ctrl: true }), kv(VK.T, false, { ctrl: true }), ctU], ['P', 'P', 'P', 'P']);
  await sim('Win+T (taskbar cycling) is not Win+Ctrl+T', { chords: ALL },
    [winD, kv(VK.T, true, { win: true }), kv(VK.T, false, { win: true }), winU], ['P', 'P', 'P', 'P']);
  await sim('Win+Ctrl+Shift+T and Win+Ctrl+Alt+T stay Windows\'', { chords: ALL, altTab: false },
    [winD, ctD, kv(VK.LSHIFT, true), kv(VK.T, true, Object.assign({ shift: true }, wc)), kv(VK.T, false, wc), kv(VK.LSHIFT, false), ctU, winU,
     winD, ctD, kv(VK.LALT, true), kv(VK.T, true, Object.assign({ alt: true }, wc)), kv(VK.T, false, wc), kv(VK.LALT, false), ctU, winU],
    ['P', 'P', 'P', 'P', 'P', 'P', 'P', 'P', 'P', 'P', 'P', 'P', 'P', 'P', 'P', 'P']);
  await sim('with both T chords on, Win+Alt+T and Win+Ctrl+T each go to their own', { chords: ['Win+Alt+T', 'Win+Ctrl+T'] },
    [winD, kv(VK.LALT, true), kv(VK.T, true, { win: true, alt: true }), kv(VK.T, false, { win: true, alt: true }), kv(VK.LALT, false),
     ctD, kv(VK.T, true, wc), kv(VK.T, false, wc), ctU, winU],
    ['P', 'P', 'S chord:Win+Alt+T', 'S', 'D', 'P', 'S chord:Win+Ctrl+T', 'S', 'D', 'D']);
  // The Ctrl chord must not loosen the others: Win+Ctrl+Left (next virtual desktop) stays Windows'.
  await sim("Win+Ctrl+Left (switch desktop) stays Windows' with Win+Left and Win+Ctrl+T on", { chords: ALL },
    [winD, ctD, kv(VK.LEFT, true, wc), kv(VK.LEFT, false, wc), ctU, winU], ['P', 'P', 'P', 'P', 'P', 'P']);
  await sim('a plain Ctrl tap and Ctrl+C: no partner key when no Ctrl chord ate anything', { chords: ALL },
    [ctD, ctU, ctD, kv(VK.C, true, { ctrl: true }), kv(VK.C, false, { ctrl: true }), ctU], ['P', 'P', 'P', 'P', 'P', 'P']);
  await sim('the Ctrl partner key is spent once: the next Ctrl-up is plain', { chords: ['Win+Ctrl+T'] },
    [winD, ctD, kv(VK.T, true, wc), kv(VK.T, false, wc), ctU, winU, ctD, ctU], ['P', 'P', 'S chord:Win+Ctrl+T', 'S', 'D', 'D', 'P', 'P']);
}

(async () => {
  const t = T.checker('ONTOP');
  let s = null, self = null, fx = null, decoy = null;
  try {
    s = await T.startPassive();
    const ping = await s.call('ping', {}, 4000).catch(() => null);
    const cmds = (ping && ping.features && ping.features.commands) || [];
    t.check('ping lists ontop.front / info / check / set', ['ontop.front', 'ontop.info', 'ontop.check', 'ontop.set'].every((c) => cmds.includes(c)), cmds.join(','));

    await chordChecks(s, t);

    // ---- what is in front, read-only (Owen's window: shape only, nothing printed) --------------
    const fr = await s.call('ontop.front', {}, 4000);
    t.check('ontop.front answers a hwnd and either facts or the reason there are none',
      typeof fr.hwnd === 'string' && (fr.hwnd === '0' ? typeof fr.refuse === 'string' : typeof fr.topmost === 'boolean' && typeof fr.name === 'string' && 'refuse' in fr),
      JSON.stringify(Object.keys(fr)));
    // the taskbar itself: refused as Windows' shell (read-only: FindWindow, then facts)
    const tb = spawnSync('powershell', ['-NoProfile', '-Command',
      'Add-Type -Name W -Namespace N -MemberDefinition \'[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindowW(string c, string t);\'; [N.W]::FindWindowW("Shell_TrayWnd", [NullString]::Value).ToInt64()'],
    { encoding: 'utf8' }).stdout.trim();
    if (/^[1-9]\d*$/.test(tb)) {
      const ti = await s.call('ontop.info', { hwnd: tb }, 4000);
      t.check('the taskbar is refused as Windows\' shell', ti.shell === true && /Windows' desktop, taskbar or Start/.test(ti.refuse || ''), JSON.stringify(ti.refuse));
    } else t.fail('could not find Shell_TrayWnd to test the shell refusal', tb);

    // ---- the fixture ------------------------------------------------------------------------
    buildFixture();
    fx = await launch(FIX_EXE, '');
    decoy = await launch(DECOY_EXE, ' (decoy)');

    const fi = await s.call('ontop.info', { hwnd: fx.main }, 4000);
    t.check('fixture: facts read, recognised as THE fixture, not on top, pinnable', fi.fixture === true && fi.topmost === false && fi.refuse === null &&
      fi.self === false && fi.shell === false && fi.hung === false && fi.elevated === false && fi.visible === true, JSON.stringify(fi));
    const pid = fi.pid;

    const on = await s.send('ontop.set', { hwnd: fx.main, on: true, pid }, 4000);
    t.check('fixture: kept on top (verified by the sidecar\'s own re-read)', on.ok && on.result.topmost === true && on.result.was === false &&
      on.result.changed === true, JSON.stringify(on.error || on.result));
    if (on.ok && on.result.tries > 1) console.log(`  note: the pin took ${on.result.tries} tries (SetWindowPos did not stick at once)`);
    await T.sleep(250);
    const c1 = await s.call('ontop.check', { hwnds: [{ hwnd: fx.main, pid }] }, 4000);
    t.check('fixture: still on top 250 ms later (ontop.check)', c1.windows[0].alive === true && c1.windows[0].topmost === true, JSON.stringify(c1));
    const again = await s.send('ontop.set', { hwnd: fx.main, on: true, pid }, 4000);
    t.check('fixture: pinning a pinned window changes nothing and says so', again.ok && again.result.changed === false && again.result.topmost === true);
    const wrongPid = await s.send('ontop.set', { hwnd: fx.main, on: false, pid: pid + 1 }, 4000);
    t.check('fixture: a stale pid (the handle now belongs to someone else) is refused', !wrongPid.ok && /has closed/.test(wrongPid.error), wrongPid.error);
    const off = await s.send('ontop.set', { hwnd: fx.main, on: false, pid }, 4000);
    t.check('fixture: put back (not on top), verified', off.ok && off.result.topmost === false && off.result.was === true && off.result.changed === true,
      JSON.stringify(off.error || off.result));
    const noOn = await s.send('ontop.set', { hwnd: fx.main }, 4000);
    t.check('ontop.set without on: is refused in words', !noOn.ok && /needs on/.test(noOn.error), noOn.error);

    // a window that was ALREADY on top before Mantle touched it: the sidecar reports was:true
    const pi = await s.call('ontop.info', { hwnd: fx.pre }, 4000);
    t.check('fixture (already on top): facts say topmost before anyone touched it', pi.topmost === true && pi.fixture === true, JSON.stringify(pi));
    const pon = await s.send('ontop.set', { hwnd: fx.pre, on: true, pid }, 4000);
    t.check('fixture (already on top): pin = nothing changed, was:true (Mantle never records it as its pin)',
      pon.ok && pon.result.changed === false && pon.result.was === true, JSON.stringify(pon.error || pon.result));

    // the decoy: same title, wrong exe -> refused in passive; a dry run says what would happen
    const dv = await s.send('ontop.set', { hwnd: decoy.main, on: true }, 4000);
    t.check('decoy: REFUSED in passive (same title, wrong exe)', !dv.ok && String(dv.error).startsWith(T.PASSIVE_REFUSAL), dv.error);
    const dc = await s.call('ontop.check', { hwnds: [decoy.main] }, 4000);
    t.check('decoy: and it is not on top', dc.windows[0].topmost === false);
    const dd = await s.send('ontop.set', { hwnd: decoy.main, on: true, dryRun: true }, 4000);
    t.check('decoy: a dry run answers what it WOULD do and does nothing', dd.ok && dd.result.dryRun === true && /HWND_TOPMOST/.test(dd.result.would) &&
      (await s.call('ontop.check', { hwnds: [decoy.main] }, 4000)).windows[0].topmost === false, JSON.stringify(dd.error || dd.result));

    // Mantle's own windows: a second sidecar whose "parent" is the fixture sees them as its own
    self = await T.startPassive({ args: ['--parent-pid=' + fx.proc.pid] });
    const si = await self.call('ontop.info', { hwnd: fx.main }, 4000);
    t.check("Mantle's own windows are refused (the sidecar's parent's windows)", si.self === true && /Mantle's own/.test(si.refuse || ''), JSON.stringify(si.refuse));
    const ss = await self.send('ontop.set', { hwnd: fx.main, on: true }, 4000);
    t.check("... and ontop.set refuses them in words", !ss.ok && /Mantle's own/.test(ss.error), ss.error);
    await self.stop(); self = null;

    // pinned, then the window closes: check says gone, and set says closed
    const on2 = await s.send('ontop.set', { hwnd: fx.main, on: true, pid }, 4000);
    t.check('fixture: pinned again before it closes', on2.ok && on2.result.topmost === true, JSON.stringify(on2.error || on2.result));
    fx.cmd('CLOSE');
    t.check('fixture: the main window closed', (await waitLine(fx, 'CLOSED Mantle ontop fixture', 3000)) >= 0);
    await T.sleep(150);
    const c2 = await s.call('ontop.check', { hwnds: [{ hwnd: fx.main, pid }, { hwnd: fx.pre, pid }] }, 4000);
    t.check('closed: check says the pinned window is gone, the other one is alive', c2.windows[0].alive === false && c2.windows[1].alive === true, JSON.stringify(c2));
    const gone = await s.send('ontop.set', { hwnd: fx.main, on: false, pid }, 4000);
    t.check('closed: ontop.set says the window has closed', !gone.ok && /has closed/.test(gone.error), gone.error);

    // hung: Windows calls a window hung after ~5 s without pumping; refused at once, never waited on
    fx.cmd('HANG 9000');
    t.check('fixture: hanging on purpose', (await waitLine(fx, 'HANGING', 3000)) >= 0);
    await T.sleep(6000);
    const t0 = Date.now();
    const hung = await s.send('ontop.set', { hwnd: fx.pre, on: false, pid }, 4000);
    const hungMs = Date.now() - t0;
    t.check('hung: refused in words ("not responding"), in well under a second', !hung.ok && /not responding/.test(hung.error) && hungMs < 1000,
      `${hungMs} ms: ${hung.error || JSON.stringify(hung.result)}`);
    await waitLine(fx, 'AWAKE', 6000);
    const back = await s.send('ontop.set', { hwnd: fx.pre, on: false, pid }, 4000);
    t.check('awake again: the already-on-top window CAN be put back when asked (the sidecar obeys; the rule lives in ontop.js)',
      back.ok && back.result.topmost === false, JSON.stringify(back.error || back.result));
  } catch (e) {
    t.fail('the test threw', e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e));
  } finally {
    if (self) await self.stop();
    if (s) await s.stop();
    for (const f of [fx, decoy]) if (f) { try { f.proc.kill(); } catch (_) { /* gone */ } }
  }
  process.exit(t.summary());
})();

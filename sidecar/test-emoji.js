// test-emoji.js - the sidecar half of the emoji picker (sidecar/Emoji.cs + the Win+. / Win+; chords),
// lane mantle-emoji 2026-10-15. Passive sidecar throughout: it never hooks and never types except into
// the stand-in this test makes (an invisible, opacity-0 WinForms window titled "Mantle emoji fixture",
// exe under %TEMP%), the only window emoji.type accepts in passive mode. Nothing is ever sent to any
// other window: if the stand-in cannot take the foreground by itself (no input tricks are used), the
// typing checks are SKIPPED with that reason instead.
//
//   MANTLE_SIDECAR_EXE=<scratch exe> node sidecar/test-emoji.js      -> "EMOJI SIDECAR TEST: n passed, m failed"
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const T = require('./test-lib');

const DIR = path.join(os.tmpdir(), 'mantle-emoji-fixture');
const EXE = path.join(DIR, 'mantle-emoji-fixture.exe');
const CSC = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
const FIXTURE_CS = String.raw`
using System; using System.Text; using System.Windows.Forms; using System.Runtime.InteropServices;
static class P {
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [STAThread] static void Main(string[] a) {
    var f = new Form { Text = a.Length > 0 ? a[0] : "Mantle emoji fixture", Opacity = 0, ShowInTaskbar = false,
                       StartPosition = FormStartPosition.Manual, Left = 40, Top = 40, Width = 320, Height = 120 };
    var t = new TextBox { Dock = DockStyle.Fill, Multiline = true };
    f.Controls.Add(t);
    t.TextChanged += delegate {
      var sb = new StringBuilder();
      foreach (char c in t.Text) sb.Append(((int)c).ToString("X4")).Append(' ');
      Console.WriteLine("TEXT " + sb.ToString().Trim()); Console.Out.Flush();
    };
    var quit = new Timer { Interval = 60000 }; quit.Tick += delegate { f.Close(); }; quit.Start();
    f.Shown += delegate {
      bool front = a.Length > 1 && a[1] == "front";
      if (front) { SetForegroundWindow(f.Handle); f.Activate(); }
      t.Focus();
      Application.DoEvents();
      Console.WriteLine("READY " + f.Handle.ToInt64() + " " + (GetForegroundWindow() == f.Handle ? "front" : "behind")); Console.Out.Flush();
    };
    Application.Run(f);
  }
}`;

function buildFixture() {
  fs.mkdirSync(DIR, { recursive: true });
  const src = path.join(DIR, 'fixture.cs');
  fs.writeFileSync(src, FIXTURE_CS);
  const r = spawnSync(CSC, ['/nologo', '/target:winexe', '/out:' + EXE, '/r:System.Windows.Forms.dll', src], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error('the fixture did not build: ' + (r.stdout || r.stderr));
}
function startFixture(title, mode) {
  const p = spawn(EXE, [title, mode], { stdio: ['ignore', 'pipe', 'ignore'] });
  const lines = [];
  let buf = '';
  p.stdout.on('data', (c) => { buf += c; let i; while ((i = buf.indexOf('\n')) >= 0) { lines.push(buf.slice(0, i).trim()); buf = buf.slice(i + 1); } });
  const wait = (re, ms) => new Promise((res) => {
    const t0 = Date.now();
    const tick = () => { const l = lines.find((x) => re.test(x)); if (l) return res(l); if (Date.now() - t0 > ms) return res(null); setTimeout(tick, 25); };
    tick();
  });
  return { p, lines, wait, kill: () => { try { p.kill(); } catch (_) { /* gone */ } } };
}

const VK = { LWIN: 0x5B, LSHIFT: 0xA0, PERIOD: 0xBE, SEMI: 0xBA, R: 0x52 };
const kv = (vk, down, o) => Object.assign({ vk, down }, o || {});
const words = (st) => { const h = st.swallow ? 'S' : st.dummy ? 'D' : 'P'; return st.event === 'none' ? h : `${h} ${st.event}${st.chord ? ':' + st.chord : ''}`; };

(async () => {
  const t = T.checker('EMOJI SIDECAR');
  const s = await T.startPassive();
  const kids = [];
  try {
    /* ---- the chords, through the pure key machine ---- */
    const sim = async (name, chords, events, want) => {
      const r = await s.send('hotkey', { op: 'simulate', chords, events }, 4000);
      if (!r.ok) { t.check(name, false, r.error); return; }
      const got = r.result.steps.map(words);
      t.check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    };
    const winD = kv(VK.LWIN, true), winU = kv(VK.LWIN, false), w = { win: true };
    const unknown = await s.send('hotkey', { chords: ['Win+Q'] }, 4000);
    t.check('the protocol knows Win+. and Win+;', unknown.ok === false && unknown.error.includes('Win+.') && unknown.error.includes('Win+;'), JSON.stringify(unknown).slice(0, 300));
    for (const [c, vk] of [['Win+.', VK.PERIOD], ['Win+;', VK.SEMI]]) {
      await sim(`${c} is taken when listed; the Win-up gets the partner key`, [c], [winD, kv(vk, true, w), kv(vk, false, w), winU], ['P', 'S chord:' + c, 'S', 'D']);
      await sim(`${c} is Windows' own when not listed (off, unhealthy, resting)`, ['Win+R'], [winD, kv(vk, true, w), kv(vk, false, w), winU], ['P', 'P', 'P', 'P']);
      await sim(`Win+Shift+${c.slice(4)} stays Windows'`, [c], [winD, kv(VK.LSHIFT, true, w), kv(vk, true, { win: true, shift: true }), kv(vk, false, { win: true, shift: true }), kv(VK.LSHIFT, false, w), winU], ['P', 'P', 'P', 'P', 'P', 'P']);
      await sim(`a plain ${c.slice(4)} is just a key`, [c], [kv(vk, true), kv(vk, false)], ['P', 'P']);
    }
    await sim('Win+R still works with both on beside it', ['Win+.', 'Win+;', 'Win+R'], [winD, kv(VK.R, true, w), kv(VK.R, false, w), winU], ['P', 'S chord:Win+R', 'S', 'D']);

    /* ---- the watch's decision, pure ---- */
    const v = async (args) => { const r = await s.send('emoji.verdict', args, 4000); return r.ok ? r.result : { error: r.error }; };
    const sw = (r) => `${r.swallow ? 'S' : 'P'}${r.report ? 'R' : ''}${r.lost ? 'L' : ''}${r.end ? 'E' : ''}`;
    const cases = [
      ['a letter is taken for the search', { vk: 0x41 }, 'SR'],
      ['Shift+letter is taken (capitals)', { vk: 0x41 }, 'SR'],
      ['Ctrl+letter is the app\'s (Ctrl+V, Ctrl+Z)', { vk: 0x56, ctrl: true }, 'P'],
      ['Alt+key is the app\'s / Windows\'', { vk: 0x09, alt: true }, 'P'],
      ['Win+key is Windows\' (Win+. again toggles through the chord)', { vk: 0xBE, win: true }, 'P'],
      ['F5 is never taken', { vk: 0x74 }, 'P'],
      ['a modifier is never taken', { vk: 0xA0 }, 'P'],
      ['Enter is taken (insert)', { vk: 0x0D }, 'SR'],
      ['arrows are taken', { vk: 0x28 }, 'SR'],
      ['Esc is taken and ends the watch here', { vk: 0x1B }, 'SRE'],
      ['the foreground moved: the key goes through and the watch ends', { vk: 0x41, fgOk: false }, 'PLE'],
      ['the panel has the keyboard itself: its page reads the key', { vk: 0x41, fgIsPanel: true }, 'P'],
      ['a taken key\'s keyup is taken', { vk: 0x41, down: false, held: true }, 'S'],
      ['any other keyup goes through', { vk: 0x41, down: false, held: false }, 'P'],
    ];
    for (const [name, args, want] of cases) { const r = await v(args); t.check(`verdict: ${name}`, !r.error && sw(r) === want, r.error || `${sw(r)} want ${want}`); }
    const named = await v({ vk: 0x26 });
    t.check('verdict: arrow up is named as the page names it', named.key === 'ArrowUp', JSON.stringify(named));
    const watch = await s.send('emoji.watch', { on: true, hwnd: '1', panel: '0' }, 4000);
    t.check('passive refuses to arm the watch (never hooks)', watch.ok === false && watch.error.startsWith(T.PASSIVE_REFUSAL), JSON.stringify(watch));
    const st = await s.send('emoji.watch', {}, 4000);
    t.check('watch status reads, unarmed', st.ok && st.result.armed === false && st.result.hooked === false, JSON.stringify(st));

    /* ---- typing: the plan, dry ---- */
    const dry = await s.send('emoji.type', { hwnd: '1', text: '\u{1F44D}\u{1F3FD}', dryRun: true }, 4000);
    t.check('emoji.type needs a real window', dry.ok === false && /gone/.test(dry.error), JSON.stringify(dry));
    const ctl = await s.send('emoji.type', { hwnd: '1', text: 'a\nb' }, 4000);
    t.check('a control character is refused', ctl.ok === false && /control character/.test(ctl.error), JSON.stringify(ctl));
    const long = await s.send('emoji.type', { hwnd: '1', text: 'x'.repeat(65) }, 4000);
    t.check('more than 64 units is refused', long.ok === false && /too long/.test(long.error), JSON.stringify(long));
    const hand = await s.send('emoji.windows', { dryRun: true }, 4000);
    t.check('emoji.windows dry run: Win, period, period up, Win up', hand.ok && hand.result.keys === 4 && hand.result.winHeld === false, JSON.stringify(hand));
    const handLive = await s.send('emoji.windows', {}, 4000);
    t.check('emoji.windows: passive never presses Win+.', handLive.ok === false && handLive.error.startsWith(T.PASSIVE_REFUSAL), JSON.stringify(handLive));

    /* ---- the stand-in window ---- */
    buildFixture();
    const decoy = startFixture('Mantle emoji decoy', 'behind');
    kids.push(decoy);
    const dl = await decoy.wait(/^READY/, 8000);
    t.check('the decoy window starts', !!dl, decoy.lines.join(' | '));
    if (dl) {
      const dh = dl.split(' ')[1];
      const dd = await s.send('emoji.type', { hwnd: dh, text: '\u{1F600}', dryRun: true }, 4000);
      t.check('dry run: one surrogate pair = 2 units = 4 key events', dd.ok && dd.result.units.join(' ') === 'D83D DE00' && dd.result.inputs === 4, JSON.stringify(dd));
      const dr = await s.send('emoji.type', { hwnd: dh, text: '\u{1F600}' }, 4000);
      t.check('passive types into nothing but the fixture (a look-alike title is refused)', dr.ok === false && dr.error.startsWith(T.PASSIVE_REFUSAL), JSON.stringify(dr));
    }
    decoy.kill();

    const fx = startFixture('Mantle emoji fixture', 'front');
    kids.push(fx);
    const fl = await fx.wait(/^READY/, 8000);
    t.check('the stand-in window starts', !!fl, fx.lines.join(' | '));
    if (fl && fl.endsWith('front')) {
      const hwnd = fl.split(' ')[1];
      const arm = await s.send('emoji.arm', {}, 4000);
      t.check('emoji.arm: the window in front, its app, a caret, not elevated',
        arm.ok && arm.result.hwnd === hwnd && arm.result.app === 'mantle-emoji-fixture.exe' && arm.result.caret && arm.result.caret.via === 'system caret' && arm.result.elevated === false,
        JSON.stringify(arm).slice(0, 300));
      const t0 = Date.now();
      const caret = await s.send('emoji.caret', { hwnd, pid: arm.ok ? arm.result.pid : 0 }, 4000);
      const cms = Date.now() - t0;
      t.check('emoji.caret answers within its 300 ms bound (+ the lane)', caret.ok && cms < 700 && ('caret' in caret.result), `${cms} ms ${JSON.stringify(caret).slice(0, 200)}`);
      const text = '\u{1F44D}\u{1F3FD}\u00E9\u2192\u{1F9D1}\u200D\u{1F91D}\u200D\u{1F9D1}';
      const want = Array.from(text).join('').split('').map((c) => c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')).join(' ');
      const ty0 = Date.now();
      const typed = await s.send('emoji.type', { hwnd, text }, 4000);
      const got = await fx.wait(new RegExp('^TEXT ' + want + '$'), 3000);
      t.check('Unicode SendInput: a toned emoji, an accent, an arrow and a ZWJ sequence arrive whole', typed.ok && typed.result.inputs === text.length * 2 && !!got,
        `${JSON.stringify(typed)} last ${fx.lines.filter((l) => l.startsWith('TEXT')).slice(-1)[0]}`);
      console.log(`  typed ${text.length} units into the stand-in in ${typed.ok ? typed.result.ms : '?'} ms (round trip with the echo ${Date.now() - ty0} ms)`);
    } else {
      console.log('  SKIPPED the typing checks: the stand-in could not take the foreground by itself (' + (fl || 'no READY') + '); no input tricks are used to force it');
    }
    fx.kill();
  } catch (e) {
    t.check('the run finished', false, e.stack || e.message);
  } finally {
    for (const k of kids) k.kill();
    await s.stop();
  }
  process.exit(t.summary());
})();

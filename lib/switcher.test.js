'use strict';
/*
 * switcher.test.js - Mantle's Alt+Tab, tested with no keyboard, no hook and no switch.
 *
 * Owen is at this machine, so NOTHING here presses a key, installs a hook or activates a window.
 * The sidecar runs --passive (it refuses to install a hook at all, and this file checks that it
 * does). The key machine is driven through `hotkey {op:'simulate'}`: KeyMachine and SwitchMath,
 * exactly the calls Hotkey.cs's hook proc makes, fed a script of key events instead of a keyboard.
 *
 * THE RULE CHECKED IN EVERY SCENARIO, not just the ones about it: no Alt keyup and no Win keyup is
 * ever swallowed. A swallowed modifier keyup is a key Windows believes is still held down.
 *
 * Also: the order rules (`op:'order'`), the live list against the bar's own window list (drift),
 * the layout maths the overlay and the arrow keys share, and where the window parks.
 *
 *   MANTLE_SIDECAR_EXE=<exe> node lib/switcher.test.js
 *
 * Prints one summary line; exits 1 if anything failed.
 */
const { spawn } = require('child_process');
const path = require('path');
const Layout = require('../ui/switcher/layout.js');
const { parkSpot, stateWords, noticeWords } = require('./switcher.js');
const { ShellState } = require('./state.js');

const EXE = process.env.MANTLE_SIDECAR_EXE || path.join(__dirname, '..', 'sidecar', 'bin', 'Mantle.Sidecar.exe');
const REFUSAL = 'refused: sidecar is passive (test mode)';

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { passed++; return true; }
  failures.push(detail ? `${name} (${detail})` : name);
  return false;
}

/* ---- a passive sidecar ------------------------------------------------------------------------ */
function start() {
  const proc = spawn(EXE, ['--passive', `--parent-pid=${process.pid}`], { stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let buf = '';
  let nextId = 1;
  proc.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (_) { continue; }
      if (msg.id !== undefined && pending.has(msg.id)) { const done = pending.get(msg.id); pending.delete(msg.id); done(msg); }
    }
  });
  proc.stderr.on('data', () => {});
  function send(cmd, extra, timeoutMs) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { pending.delete(id); reject(new Error(`no reply to ${cmd} in ${timeoutMs || 8000} ms`)); }, timeoutMs || 8000);
      pending.set(id, (m) => { clearTimeout(t); resolve(m); });
      proc.stdin.write(JSON.stringify(Object.assign({ id, cmd }, extra || {})) + '\n');
    });
  }
  return { proc, send };
}

/* ---- key events -------------------------------------------------------------------------------- */
const VK = { TAB: 0x09, ESC: 0x1B, LEFT: 0x25, UP: 0x26, RIGHT: 0x27, DOWN: 0x28, LALT: 0xA4, RALT: 0xA5, LWIN: 0x5B, N: 0x4E, A: 0x41, LSHIFT: 0xA0, LCTRL: 0xA2, X: 0x58 };
const MODIFIER_UPS = new Set([VK.LALT, VK.RALT, VK.LWIN, 0x5C]);
const k = (vk, down, o) => Object.assign({ vk, down }, o || {});
// The LL hook's LLKHF_ALTDOWN is set on the Alt keydown itself and on every key while Alt is held.
const altDown = k(VK.LALT, true, { alt: true });
const altUp = k(VK.LALT, false);
const tab = (o) => k(VK.TAB, true, Object.assign({ alt: true }, o));
const tabUp = (o) => k(VK.TAB, false, Object.assign({ alt: true }, o));
const winDown = k(VK.LWIN, true);
const winUp = k(VK.LWIN, false);

/** One step as a short string: P pass, S swallow, D pass after the 0xFF partner key, I ignored. */
function fmt(st) {
  let s = st.ignored ? 'I' : st.swallow ? 'S' : st.dummy ? 'D' : 'P';
  if (st.event && st.event !== 'none') {
    s += ` ${st.event}`;
    if (st.key) s += `:${st.key}`;
    else if (['open', 'next', 'prev', 'left', 'right', 'up', 'down', 'commit'].includes(st.event)) s += `:${st.sel}`;
  }
  return s;
}

let modUps = 0;
async function sim(s, name, opts, events, want, extra) {
  let r;
  try { r = await s.send('hotkey', Object.assign({ op: 'simulate', events }, opts || {})); } catch (e) { check(name, false, e.message); return null; }
  if (!r.ok) { check(name, false, r.error); return null; }
  const steps = r.result.steps;
  // The rule, in EVERY scenario.
  events.forEach((e, i) => {
    if (e.vk !== undefined && e.down === false && MODIFIER_UPS.has(e.vk)) {
      modUps++;
      check(`${name}: step ${i}, a modifier keyup, is never swallowed`, !steps[i].swallow, JSON.stringify(steps[i]));
    }
  });
  const got = steps.map(fmt);
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  if (extra) extra(r.result);
  return r.result;
}

async function machine(s) {
  await sim(s, 'a quick tap switches to the second tile', {}, [altDown, tab(), tabUp(), altUp],
    ['P', 'S open:1', 'S', 'D commit:1'], (r) => check('tap: committed tile 1, session over', r.committed === 1 && r.active === false && r.altHeld === false, JSON.stringify(r)));
  await sim(s, 'hold and cycle', {}, [altDown, tab(), tabUp(), tab(), tabUp(), tab(), tabUp(), altUp],
    ['P', 'S open:1', 'S', 'S next:2', 'S', 'S next:3', 'S', 'D commit:3']);
  await sim(s, 'cycling wraps round', { n: 3 }, [altDown, tab(), tabUp(), tab(), tabUp(), tab(), tabUp(), altUp],
    ['P', 'S open:1', 'S', 'S next:2', 'S', 'S next:0', 'S', 'D commit:0']);
  await sim(s, 'Shift+Tab first starts at the far end', {},
    [altDown, k(VK.LSHIFT, true, { alt: true }), tab({ shift: true }), tabUp(), tab({ shift: true }), tabUp(), k(VK.LSHIFT, false, { alt: true }), altUp],
    ['P', 'P', 'S open:4', 'S', 'S prev:3', 'S', 'P', 'D commit:3']);
  await sim(s, 'Tab then Shift+Tab goes back', {}, [altDown, tab(), tabUp(), tab({ shift: true }), tabUp(), altUp],
    ['P', 'S open:1', 'S', 'S prev:0', 'S', 'D commit:0']);
  await sim(s, 'Esc while held cancels, and Alt-up still gets its partner key', {},
    [altDown, tab(), tabUp(), k(VK.ESC, true, { alt: true }), k(VK.ESC, false, { alt: true }), altUp],
    ['P', 'S open:1', 'S', 'S cancel', 'S', 'D'], (r) => check('Esc: nothing committed', r.committed === null, JSON.stringify(r.committed)));
  await sim(s, "Alt+Esc with no switcher open is Windows' own", {},
    [altDown, k(VK.ESC, true, { alt: true }), k(VK.ESC, false, { alt: true }), altUp], ['P', 'P', 'P', 'P']);
  await sim(s, 'Alt released before Tab: Tab is plain', {}, [altDown, altUp, tab({ alt: false }), tabUp({ alt: false })], ['P', 'P', 'P', 'P']);
  await sim(s, 'Tab pressed before Alt stays plain to its keyup, and the next Tab opens', {},
    [tab({ alt: false }), altDown, tab(), tabUp(), tab(), tabUp(), altUp],
    ['P', 'P', 'P', 'P', 'S open:1', 'S', 'D commit:1']);
  await sim(s, 'auto-repeat of a held Tab keeps cycling', {}, [altDown, tab(), tab(), tab(), tabUp(), altUp],
    ['P', 'S open:1', 'S next:2', 'S next:3', 'S', 'D commit:3']);
  await sim(s, 'auto-repeat never reopens what Esc closed', {},
    [altDown, tab(), k(VK.ESC, true, { alt: true }), tab(), tabUp(), k(VK.ESC, false, { alt: true }), altUp],
    ['P', 'S open:1', 'S cancel', 'S', 'S', 'S', 'D']);
  await sim(s, "Alt+Tab with Win held is Windows' own, and the Win key still works", { winTap: true },
    [winDown, altDown, tab({ win: true }), tabUp({ win: true }), altUp, winUp], ['P', 'P', 'P', 'P', 'P', 'P']);
  await sim(s, "Ctrl+Alt+Tab (the sticky switcher) is Windows' own", {},
    [k(VK.LCTRL, true), altDown, tab({ ctrl: true }), tabUp(), altUp, k(VK.LCTRL, false)], ['P', 'P', 'P', 'P', 'P', 'P']);
  await sim(s, 'injected keys are ignored before the machine sees them', {},
    [altDown, tab({ injected: true }), tabUp({ injected: true }), altUp], ['P', 'I', 'I', 'P']);
  await sim(s, 'right Alt works the same', {},
    [k(VK.RALT, true, { alt: true }), tab(), tabUp(), k(VK.RALT, false)], ['P', 'S open:1', 'S', 'D commit:1']);
  await sim(s, 'both Alts: letting go of one does not end it', {},
    [altDown, k(VK.RALT, true, { alt: true }), tab(), tabUp(), k(VK.RALT, false, { alt: true, otherAlt: true }), altUp],
    ['P', 'P', 'S open:1', 'S', 'P', 'D commit:1']);
  await sim(s, 'arrows only while the switcher is open; Up/Down move by rows', { n: 14, cols: 5 }, [
    altDown, k(VK.RIGHT, true, { alt: true }), k(VK.RIGHT, false, { alt: true }), tab(),
    k(VK.RIGHT, true, { alt: true }), k(VK.RIGHT, false, { alt: true }),
    k(VK.DOWN, true, { alt: true }), k(VK.DOWN, false, { alt: true }),
    k(VK.DOWN, true, { alt: true }), k(VK.DOWN, true, { alt: true }), k(VK.DOWN, false, { alt: true }),
    k(VK.UP, true, { alt: true }), k(VK.UP, false, { alt: true }),
    k(VK.LEFT, true, { alt: true }), k(VK.LEFT, false, { alt: true }), tabUp(), altUp,
  ], ['P', 'P', 'P', 'S open:1', 'S right:2', 'S', 'S down:7', 'S', 'S down:12', 'S down:12', 'S', 'S up:7', 'S', 'S left:6', 'S', 'S', 'D commit:6']);
  await sim(s, 'Down from above a short last row lands on its last tile', { n: 14, cols: 5 }, [
    altDown, tab(), tabUp(),
    k(VK.RIGHT, true, { alt: true }), k(VK.RIGHT, false, { alt: true }), k(VK.RIGHT, true, { alt: true }), k(VK.RIGHT, false, { alt: true }),
    k(VK.RIGHT, true, { alt: true }), k(VK.RIGHT, false, { alt: true }),
    k(VK.DOWN, true, { alt: true }), k(VK.DOWN, false, { alt: true }), k(VK.DOWN, true, { alt: true }), k(VK.DOWN, false, { alt: true }), altUp,
  ], ['P', 'S open:1', 'S', 'S right:2', 'S', 'S right:3', 'S', 'S right:4', 'S', 'S down:9', 'S', 'S down:13', 'S', 'D commit:13']);
  await sim(s, 'the watchdog finishes a switch whose Alt-up the hook never saw', {},
    [altDown, tab(), tabUp(), { do: 'watchdog' }, altUp], ['P', 'S open:1', 'S', 'P commit:1', 'P']);
  await sim(s, 'a click on a tile switches to it; the Alt-up that follows still gets its partner key', {},
    [altDown, tab(), tabUp(), { do: 'pick', index: 3 }, altUp], ['P', 'S open:1', 'S', 'P commit:3', 'D']);
  await sim(s, 'a click on a tile that is not there does nothing', {},
    [altDown, tab(), tabUp(), { do: 'pick', index: 9 }, altUp], ['P', 'S open:1', 'S', 'P', 'D commit:1']);
  await sim(s, 'a keydown that says Alt is up ends a stale session, and the next Alt+Tab works', {},
    [altDown, tab(), tabUp(), k(VK.X, true, { alt: false }), k(VK.X, false), altDown, tab(), tabUp(), altUp],
    ['P', 'S open:1', 'S', 'P stale', 'P', 'P', 'S open:1', 'S', 'D commit:1']);
  await sim(s, "turned off, Alt+Tab is Windows' own", { altTab: false }, [altDown, tab(), tabUp(), altUp], ['P', 'P', 'P', 'P']);

  // Phase 2 and the launcher's Win tap: only the LETTER is ever swallowed, never Win.
  await sim(s, 'a solo Win tap opens the launcher (partner key before the Win-up)', { winTap: true }, [winDown, winUp], ['P', 'D wintap']);
  await sim(s, 'with the Win tap off, Win is untouched', {}, [winDown, winUp], ['P', 'P']);
  await sim(s, 'Win+N: the N is swallowed, Win is not, and Start does not open', { winKeys: true, winTap: true },
    [winDown, k(VK.N, true, { win: true }), k(VK.N, false, { win: true }), winUp], ['P', 'S winkey:n', 'S', 'D']);
  await sim(s, 'Win+A likewise', { winKeys: true },
    [winDown, k(VK.A, true, { win: true }), k(VK.A, false, { win: true }), winUp], ['P', 'S winkey:a', 'S', 'D']);
  await sim(s, 'Win+N held: one open, the repeats swallowed', { winKeys: true },
    [winDown, k(VK.N, true, { win: true }), k(VK.N, true, { win: true }), k(VK.N, false, { win: true }), winUp], ['P', 'S winkey:n', 'S', 'S', 'D']);
  await sim(s, "Win+Shift+A and Win+Ctrl+N stay Windows'", { winKeys: true }, [
    winDown, k(VK.LSHIFT, true), k(VK.A, true, { win: true, shift: true }), k(VK.A, false), k(VK.LSHIFT, false),
    k(VK.LCTRL, true), k(VK.N, true, { win: true, ctrl: true }), k(VK.N, false), k(VK.LCTRL, false), winUp,
  ], ['P', 'P', 'P', 'P', 'P', 'P', 'P', 'P', 'P', 'P']);
  await sim(s, "with Win+N/A off, they are Windows'", {},
    [winDown, k(VK.N, true, { win: true }), k(VK.N, false, { win: true }), winUp], ['P', 'P', 'P', 'P']);
  await sim(s, 'Alt+N is not Win+N', { winKeys: true },
    [altDown, k(VK.N, true, { alt: true }), k(VK.N, false, { alt: true }), altUp], ['P', 'P', 'P', 'P']);
  // 33 on 2026-09-23. Fewer means scenarios stopped running, not that the rule got easier.
  check(`every Alt and Win keyup in every scenario passed through (${modUps} of them)`, modUps >= 33, `only ${modUps} were exercised`);
}

async function order(s) {
  const run = async (name, fg, windows, want, sel, selBack) => {
    const r = await s.send('hotkey', { op: 'order', fg, windows });
    if (!check(`${name}: ran`, r.ok, r.error)) return;
    check(`${name}: order`, JSON.stringify(r.result.order) === JSON.stringify(want), `got ${JSON.stringify(r.result.order)}`);
    check(`${name}: selection starts at ${sel}, or ${selBack} backwards`, r.result.sel === sel && r.result.selBackwards === selBack, JSON.stringify(r.result));
  };
  const W = [
    { hwnd: '10', z: 0, stamp: 0 },
    { hwnd: '20', z: 1, stamp: 50 },
    { hwnd: '30', z: 2, stamp: 90 },
    { hwnd: '40', z: 3, stamp: 0, topmost: true },
    { hwnd: '50', z: 4, stamp: 0 },
  ];
  await run('the current window first, then most recently used, then stacking order, topmost last', '10', W, ['10', '30', '20', '50', '40'], 1, 4);
  await run('the current window first even when it is not the most recent', '20', W, ['20', '30', '10', '50', '40'], 1, 4);
  await run('with the desktop in front, the most recent window is first AND selected', '99', W, ['30', '20', '10', '50', '40'], 0, 4);
  await run('one window', '10', [W[0]], ['10'], 0, 0);
  await run('no windows', '10', [], [], -1, -1);
}

async function refusals(s) {
  const want = async (name, extra, test) => {
    const r = await s.send('hotkey', extra);
    check(name, test(r), JSON.stringify(r).slice(0, 240));
  };
  await want('passive refuses to install Alt+Tab', { altTab: true }, (r) => r.ok === false && r.error === REFUSAL);
  await want('passive refuses to install Win+N / Win+A', { winKeys: true }, (r) => r.ok === false && r.error === REFUSAL);
  await want('passive refuses a pick, and says why', { op: 'pick', seq: 1, index: 0 },
    (r) => r.ok === false && r.error.startsWith(`${REFUSAL}: pick acts on a live Alt+Tab`));
  await want('a malformed grid is malformed in every mode', { op: 'grid', seq: 1, cols: 0 }, (r) => r.ok === false && /grid needs cols/.test(r.error));
  await want('a switch must be a boolean', { altTab: 'yes' }, (r) => r.ok === false && r.error === 'hotkey: altTab must be true or false, not "yes"');
  await want('hotkey with nothing to do says what it needs', {}, (r) => r.ok === false && r.error === 'hotkey needs winTap, altTab or winKeys: true or false');
  await want('an unknown op is named', { op: 'nope' }, (r) => r.ok === false && /unknown op 'nope'/.test(r.error));
  await want('status: no hook in a passive sidecar', { op: 'status' },
    (r) => r.ok === true && r.result.installed === false && r.result.altTab === false && r.result.winKeys === false);
}

// Read from AltTab.cs's MantleTitles, the list the sidecar itself uses, so a new Mantle page can't
// make this check fail as "a window only in the bar's list" (a stale copy here did, 2026-09-24:
// the live task view and snap pages).
const MANTLE_TITLES = (() => {
  const src = require('fs').readFileSync(path.join(__dirname, '..', 'sidecar', 'AltTab.cs'), 'utf8');
  const m = /MantleTitles\s*=\s*new HashSet<string>\([^)]*\)\s*\{([\s\S]*?)\};/.exec(src);
  if (!m) throw new Error('switcher.test: MantleTitles not found in sidecar/AltTab.cs');
  const titles = (m[1].replace(/\/\/.*$/gm, '').match(/"([^"]+)"/g) || []).map((s) => s.slice(1, -1).toLowerCase());
  if (titles.length < 5) throw new Error('switcher.test: MantleTitles in AltTab.cs lists only ' + titles.length + ' titles');
  return new Set(titles);
})();
function mantleWindow(w) {
  if (w.aumid && String(w.aumid).toLowerCase() === 'com.owensilva.mantle') return true;
  return path.basename(String(w.exe || '')).toLowerCase() === 'electron.exe' && MANTLE_TITLES.has(String(w.title || '').trim().toLowerCase());
}

async function drift(s) {
  // The switcher's list must be the bar's list: the same windows, never one of Mantle's own.
  // Windows open and close under a live desktop, so a mismatch is retried before it counts.
  let last = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    const [a, b] = await Promise.all([s.send('hotkey', { op: 'list' }), s.send('windows')]);
    if (!a.ok || !b.ok) { last = `list ${a.error || 'ok'}, windows ${b.error || 'ok'}`; continue; }
    const mine = new Set(a.result.list.map((w) => w.hwnd));
    const bars = new Set(b.result.filter((w) => !mantleWindow(w)).map((w) => String(w.hwnd)));
    const onlyList = [...mine].filter((h) => !bars.has(h));
    const onlyBar = [...bars].filter((h) => !mine.has(h));
    const mantleIn = a.result.list.filter((w) => MANTLE_TITLES.has(String(w.title).trim().toLowerCase()));
    if (!onlyList.length && !onlyBar.length && !mantleIn.length) {
      check(`Alt+Tab lists exactly the bar's windows (${mine.size}, attempt ${attempt})`, true);
      const shape = a.result.list.every((w) => /^\d+$/.test(w.hwnd) && typeof w.title === 'string' && typeof w.minimized === 'boolean' && typeof w.hung === 'boolean');
      check('every listed window has hwnd, title, minimized and hung', shape, JSON.stringify(a.result.list[0]));
      check('the list says which monitor, in physical px', Array.isArray(a.result.mon) && a.result.mon.length === 4 && Array.isArray(a.result.work), JSON.stringify(a.result.mon));
      check('the selection follows Windows\' rule on the live list', a.result.sel === (a.result.current === 0 ? (mine.size >= 2 ? 1 : 0) : (mine.size ? 0 : -1)), JSON.stringify({ sel: a.result.sel, current: a.result.current }));
      return;
    }
    last = `only in Alt+Tab: ${onlyList.join(',') || '-'}; only in the bar: ${onlyBar.join(',') || '-'}; Mantle's own listed: ${mantleIn.map((w) => w.title).join(',') || '-'}`;
    await new Promise((r) => setTimeout(r, 300));
  }
  check("Alt+Tab lists exactly the bar's windows", false, last);
}

async function listTiming(s) {
  // The open path's enumerate + order, plus the pipe, as a ceiling on the sidecar's share of ~100 ms.
  const ms = [];
  for (let i = 0; i < 10; i++) {
    const t = process.hrtime.bigint();
    await s.send('hotkey', { op: 'list' });
    ms.push(Number(process.hrtime.bigint() - t) / 1e6);
  }
  ms.sort((a, b) => a - b);
  return `hotkey list round trip: median ${ms[5].toFixed(1)} ms, max ${ms[9].toFixed(1)} ms over 10`;
}

function layout() {
  const L = Layout.L;
  for (const [ww, wh] of [[1280, 720], [1920, 1080], [1536, 864], [1024, 600], [800, 600], [3840, 2160], [2560, 1080]]) {
    for (let n = 0; n <= 60; n++) {
      const t = Layout.layout(n, ww, wh);
      const tag = `${ww}x${wh} n=${n}`;
      if (n === 0) { check(`${tag}: the empty panel`, t.cols === 0 && t.panelW === L.emptyW && t.w === L.emptyW + 2 * L.margin); continue; }
      const bad = [];
      if (t.w > ww * L.maxW + 0.01) bad.push(`wider than ${L.maxW} of the screen (${t.w})`);
      if (t.h > wh * L.maxH + 0.01) bad.push(`taller than ${L.maxH} of the screen (${t.h})`);
      if (t.cols * t.rows < n) bad.push('not enough tiles');
      if ((t.rows - 1) * t.cols >= n) bad.push('an empty last row');
      if (t.rows !== Math.ceil(n / t.cols)) bad.push('rows do not match');
      if (t.tileW > L.tileMax || t.tileW < L.tileMin) bad.push(`tile ${t.tileW} out of range`);
      if (t.previewW !== t.tileW - 2 * L.inset || t.previewH !== Math.round(t.previewW * L.aspect)) bad.push('preview box off');
      if (t.tileH !== L.inset + t.previewH + L.capH) bad.push('tile height off');
      if (t.scroll !== (t.visibleRows < t.rows) || t.visibleRows < 1) bad.push('scroll flag off');
      if (t.gridW !== t.cols * t.tileW + (t.cols - 1) * L.gap) bad.push('grid width off');
      if (t.panelW !== 2 * L.pad + t.gridW || t.w !== t.panelW + 2 * L.margin) bad.push('panel width off');
      if (t.panelH !== 2 * L.pad + t.visibleRows * t.tileH + (t.visibleRows - 1) * L.gap) bad.push('panel height off');
      check(`layout ${tag}`, !bad.length, bad.join('; '));
    }
  }
  // Balanced rows: 7 windows are 4 + 3, not 6 + 1.
  const seven = Layout.layout(7, 1920, 1080);
  check('7 windows are balanced into 4 + 3', seven.cols === 4 && seven.rows === 2, JSON.stringify({ cols: seven.cols, rows: seven.rows }));
  // Scrolling keeps the selection on screen and moves as little as possible.
  const many = Layout.layout(40, 1280, 720);
  check('40 windows on 1280x720 scroll by whole rows', many.scroll && many.cols === 7 && many.visibleRows === 4, JSON.stringify({ cols: many.cols, rows: many.rows, vis: many.visibleRows }));
  check('firstRow: the selection below the window pulls it down just enough', Layout.firstRow(many, 33, 0) === 1);
  check('firstRow: the selection above pulls it up', Layout.firstRow(many, 3, 1) === 0);
  check('firstRow: a selection already visible moves nothing', Layout.firstRow(many, 20, 1) === 1);
  check('firstRow: the very last tile shows the last rows', Layout.firstRow(many, 39, 0) === 2);
  check('firstRow: a grid that fits never scrolls', Layout.firstRow(Layout.layout(14, 1920, 1080), 13, 0) === 0);
  const nt = Layout.notice();
  check('the notice has a fixed size', nt.w === L.noticeW + 2 * L.margin && nt.h === L.noticeH + 2 * L.margin);
  check('nonsense in, a sane answer out', Layout.layout('x', -5, NaN).cols === 0 && Layout.layout(3, 0, 0).cols === 3);
}

function parking() {
  const A = { x: 0, y: 0, w: 1920, h: 1080 };
  const one = parkSpot(A, 800, 243, [A]);
  check('one monitor: park just above it', one.side === 'above' && one.x === 0 && one.y === -243 - 64, JSON.stringify(one));
  const B = { x: 0, y: -1080, w: 1920, h: 1080 };
  const two = parkSpot(A, 800, 243, [A, B]);
  check('a monitor above: park below instead', two.side === 'below' && two.y === 1080 + 64, JSON.stringify(two));
  const C = { x: 0, y: 1080, w: 1920, h: 1080 };
  const D = { x: -1920, y: 0, w: 1920, h: 1080 };
  const three = parkSpot(A, 800, 243, [A, B, C, D]);
  check('monitors above, below and left: park to the right', three.side === 'right of' && three.x === 1920 + 64, JSON.stringify(three));
  const E = { x: 1920, y: 0, w: 1920, h: 1080 };
  const boxed = parkSpot(A, 800, 243, [A, B, C, D, E]);
  check('boxed in on all four sides: far away, still off every screen', boxed.side === 'far from', JSON.stringify(boxed));
  const hits = (p, w, h, d) => p.x < d.x + d.w && p.x + w > d.x && p.y < d.y + d.h && p.y + h > d.y;
  const cases = [[one, [A]], [two, [A, B]], [three, [A, B, C, D]], [boxed, [A, B, C, D, E]]];
  check('no parking spot overlaps a monitor of its own layout', cases.every(([p, ds]) => !ds.some((d) => hits(p, 800, 243, d))));
}

/* ---- the state piece's words, and which of them are a fault (lib/state.js problems()) ---------- */

function stateCases() {
  const base = {
    test: false, live: true, releasedWhy: null, hookErr: null, applying: false, pendingApply: false,
    settings: { altTab: true, winKeys: true }, page: { ready: true, reason: null }, settingsNote: null,
    hook: { installed: true, altTab: true, winKeys: true, tracking: true, reason: null },
  };
  const w = (patch) => stateWords(Object.assign({}, base, patch));
  let st = w({});
  check("working: Alt+Tab and Win+N/A are Mantle's, nothing broken", st.altTab === true && st.winKeys === true && st.broken === null);
  st = w({ hookErr: "the sidecar exe predates Mantle's Alt+Tab (it said: hotkey needs winTap): run npm run build:sidecar", hook: null });
  check('stale exe: broken, says predates and how to fix, once for both',
    !!st.broken && /predates/.test(st.broken) && /build:sidecar/.test(st.broken) &&
    st.broken.split('predates').length === 2 && /Win\+N and Win\+A too/.test(st.broken), st.broken);
  st = w({ hook: { installed: false, altTab: false, winKeys: false, reason: 'SetWindowsHookEx failed: access denied' } });
  check("refused hook: broken, with the sidecar's reason", !!st.broken && /SetWindowsHookEx failed/.test(st.broken), st.broken);
  st = w({ page: { ready: false, reason: 'the switcher page crashed (killed)', failed: true } });
  check('crashed page: Alt+Tab broken, Win+N/A still fine',
    !!st.broken && /crashed/.test(st.broken) && st.winKeys === true && !/Win\+N/.test(st.broken), st.broken);
  st = w({ page: { ready: false, reason: 'the switcher page has not loaded yet' }, hook: null });
  check('first load still under way: not broken', st.broken === null && st.altTab === false, st.broken);
  st = w({ settings: { altTab: false, winKeys: false }, hook: { installed: true, altTab: false, winKeys: false } });
  check('both switched off in the tray: not broken', st.broken === null && /turned off/.test(st.reason), st.reason);
  st = w({ settings: { altTab: false, winKeys: true }, hookErr: 'the sidecar is not running (it exited)', hook: null });
  check('Alt+Tab off, Win+N/A on, sidecar dead: broken for Win+N/A only',
    !!st.broken && /^Win\+N and Win\+A open Windows' own panels: the sidecar is not running/.test(st.broken), st.broken);
  st = w({ test: true, hook: null, hookErr: 'anything' });
  check('test mode: never broken', st.broken === null && /test mode/.test(st.reason));
  st = w({ live: false, releasedWhy: 'the tray menu', hook: null });
  check('Windows put back: not broken', st.broken === null && /put Windows back/.test(st.reason));
  st = w({ hook: null, applying: true });
  check('asked, answer not in yet: not broken', st.broken === null && /not confirmed/.test(st.reason));
  st = w({ hook: { installed: true, altTab: false, winKeys: true, reason: null } });
  check('answered without turning Alt+Tab on: broken', !!st.broken && /answered without/.test(st.broken), st.broken);
  st = w({ hook: { installed: true, altTab: false, winKeys: true, reason: null }, applying: true });
  check('...but not while a newer ask is in flight', st.broken === null);
  st = w({ hook: { installed: true, altTab: false, winKeys: false }, pendingApply: true });
  check('a change waiting for the Alt+Tab on screen: not broken',
    st.broken === null && /until the Alt\+Tab on screen ends/.test(st.reason), st.reason);
  st = w({ hook: { installed: true, altTab: true, winKeys: true, tracking: false } });
  check('stacking order instead of MRU: working, says so, not broken', st.altTab === true && /stacking order/.test(st.reason) && st.broken === null);

  // problems(): the rule the terminal log and the tray tooltip read
  const live = new ShellState('live');
  live.set('switcher', w({ hookErr: "the sidecar exe predates Mantle's Alt+Tab: run npm run build:sidecar", hook: null }));
  const rows = live.problems().filter((x) => x.piece === 'Alt+Tab');
  check('problems(): a broken switcher is one row, in plain words', rows.length === 1 && /predates/.test(rows[0].reason), JSON.stringify(rows));
  live.set('switcher', w({}));
  check('problems(): a working switcher is no row', !live.problems().some((x) => x.piece === 'Alt+Tab'));
  live.set('switcher', w({ settings: { altTab: false, winKeys: false }, hook: null }));
  check('problems(): switched off is no row', !live.problems().some((x) => x.piece === 'Alt+Tab'));
  const test = new ShellState('test');
  test.set('switcher', Object.assign(w({}), { broken: 'forced' }));
  check('problems(): never in test mode, even when the piece says broken', !test.problems().some((x) => x.piece === 'Alt+Tab'));
  check('problems(): no piece yet is no row', !new ShellState('live').problems().some((x) => x.piece === 'Alt+Tab'));
}

/* ---- the notice's words ------------------------------------------------------------------------- */

function noticeCases() {
  const detail = 'SetForegroundWindow was refused, then the focus ladder: could not raise window 1312: ...';
  let n = noticeWords('hung', 'Task Manager', detail);
  check('hung: the plain sentence first', n.title === "Task Manager isn't responding, so Windows wouldn't bring it to the front.", n.title);
  check('hung: the API detail is the small line, never the sentence', n.text === detail && !/SetForegroundWindow|ladder/.test(n.title));
  n = noticeWords('closed', 'Notepad', 'the window closed before Mantle could switch to it');
  check('closed: one sentence, no second line saying it again', n.title === 'Notepad closed before Mantle could switch to it.' && n.text === null, JSON.stringify(n));
  n = noticeWords('refused', 'Visual Studio Code', detail);
  check('refused: names what would not come forward', n.title === "Windows wouldn't bring Visual Studio Code to the front." && n.text === detail, n.title);
  n = noticeWords('refused', '', detail);
  check('no name mid-sentence: "that window"', n.title === "Windows wouldn't bring that window to the front.", n.title);
  n = noticeWords('hung', null, detail);
  check('no name at the start: "That window"', /^That window isn't responding/.test(n.title), n.title);
  n = noticeWords('error', 'Paint', 'switching threw Win32Exception: boom');
  check('error: Mantle could not, detail kept', n.title === "Mantle couldn't switch to Paint." && /Win32Exception/.test(n.text), JSON.stringify(n));
  n = noticeWords(undefined, 'Paint', null);
  check('no cause and no detail still says something', n.title === "Mantle couldn't switch to Paint." && !!n.text, JSON.stringify(n));
}

(async () => {
  layout();
  parking();
  stateCases();
  noticeCases();
  let s = null;
  let timing = '';
  try {
    s = start();
    const hello = await s.send('ping', {}, 10000).catch((e) => ({ ok: false, error: e.message }));
    if (!hello.ok) throw new Error(`the sidecar at ${EXE} did not answer ping: ${hello.error}`);
    const probe = await s.send('hotkey', { op: 'simulate', events: [] });
    if (!probe.ok) throw new Error(`${EXE} has no Alt+Tab (hotkey simulate said: ${probe.error}); build it with sidecar/build.ps1 -Out`);
    await machine(s);
    await order(s);
    await refusals(s);
    await drift(s);
    timing = await listTiming(s);
  } catch (err) {
    check('the sidecar part ran', false, err.message);
  } finally {
    if (s) { try { s.proc.stdin.end(); } catch (_) { /* gone */ } setTimeout(() => { try { s.proc.kill(); } catch (_) { /* gone */ } }, 1500).unref(); }
  }
  for (const f of failures) console.log(`FAIL ${f}`);
  if (timing) console.log(timing);
  console.log(`switcher tests: ${passed} passed, ${failures.length} failed`);
  process.exitCode = failures.length ? 1 : 0;
})();

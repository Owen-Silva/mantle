'use strict';
/* taskview.test.js - lib/features/taskview.js (Task View's main half) on a hand-made ctx, a fake
 * sidecar and a fake electron (quality pass, 2026-09-29). No window is shown, nothing is switched,
 * closed or moved: the sidecar here is a stub that records what it was asked.
 *
 * WHAT IT PROVES: Win+Tab opens a session and Win+Tab again ends it; the page may only name THIS
 * session's windows and desktops (a foreign window, a made-up desktop, a non-string or too-long name,
 * an unknown action, a stale session are all refused in plain words BEFORE the sidecar is asked);
 * --test turns every write into a dry run and refuses closes; the sidecar client's own failures reach
 * the screen as plain words (never "sidecar"); a close the app is holding up ("save changes?") is said
 * on screen; the icon map is rebuilt from each windows push (it used to grow forever).
 *   node lib/features/taskview.test.js
 */
const Module = require('module');

class FakeWin {
  constructor(o) {
    FakeWin.all.push(this);
    this.opts = o; this.destroyed = false; this.shown = false; this.bounds = [];
    this.handlers = {};
    this.webContents = { on(ev, fn) { (this.h = this.h || {})[ev] = fn; }, setWindowOpenHandler() {}, isDestroyed: () => this.destroyed, reload() {} };
  }
  on(ev, fn) { this.handlers[ev] = fn; } once(ev, fn) { this.handlers[ev] = fn; }
  loadFile() { setImmediate(() => { const f = this.webContents.h && this.webContents.h['did-finish-load']; if (f) f(); }); }
  isDestroyed() { return this.destroyed; } destroy() { this.destroyed = true; }
  setBounds(b) { this.bounds.push(b); this.cur = b; ORDER.push(b.x === 0 && b.y === 0 ? 'on screen' : 'parked'); } getContentBounds() { return this.cur || { x: 0, y: 0, width: 1536, height: 864 }; }
  show() { this.shown = true; ORDER.push('show'); } showInactive() { this.shown = true; } setAlwaysOnTop() { ORDER.push('topmost'); } moveTop() { ORDER.push('moveTop'); }
  focus() { ORDER.push('focus()'); } isFocused() { return FakeWin.kb; }
}
FakeWin.all = [];
FakeWin.kb = true;            // Electron's word on the keyboard (raise.hasKeyboard cannot read a fake window)
const ORDER = [];             // what happened to the window and the sidecar, in order
// lib/raise.js, with Windows' answers scripted: who is in front (foreground) and the on-top judge.
const realRaise = require('../raise');
const RZ = { fg: { hwnd: 777, mine: false, pid: 1, rect: { l: 0, t: 0, r: 800, b: 600 } }, judge: { onTop: true, why: 'on top' } };
const fakeRaise = Object.assign({}, realRaise, {
  foreground: () => RZ.fg,
  check: (win, o) => new Promise((r) => setTimeout(() => r(o.wanted && !o.wanted() ? { onTop: null, why: 'closed again' } : RZ.judge), 5)),
  // the REAL keyboard(), with the foreground-right hand-on recorded instead of asked of Windows (lib/fg-grant.js)
  keyboard: (win, o) => {
    RZ.kbPids.push(o && o.sidecarPid);
    return realRaise.keyboard(win, Object.assign({}, o, { grant: (pid) => { RZ.grants.push(pid); return { granted: true }; } }));
  },
});
RZ.kbPids = []; RZ.grants = [];
const DISPLAY = { id: 1, bounds: { x: 0, y: 0, width: 1536, height: 864 }, workArea: { x: 0, y: 0, width: 1536, height: 816 }, scaleFactor: 1.25 };
const fakeScreen = {
  getAllDisplays: () => [DISPLAY], getPrimaryDisplay: () => DISPLAY, getDisplayNearestPoint: () => DISPLAY,
  getCursorScreenPoint: () => ({ x: 10, y: 10 }), screenToDipPoint: (p) => p, dipToScreenPoint: (p) => p,
};
const thumbCalls = [];
const fakeThumbs = { set: () => ({ clear: (why) => thumbCalls.push({ clear: why }), sync: (h, boxes) => { thumbCalls.push({ sync: boxes.length }); return { ok: true, thumbs: boxes.map((b) => ({ hwnd: b.hwnd, ok: true })) }; } }) };
const load = Module._load;
Module._load = function (req) {
  if (req === 'electron') return { BrowserWindow: FakeWin, screen: fakeScreen };
  if (req === '../thumbs') return fakeThumbs;
  if (req === '../windows') return { hwndOf: () => 4242 };
  if (req === '../raise') return fakeRaise;
  return load.apply(this, arguments);
};
const feature = require('./taskview.js');

let passed = 0; const failures = [];
function check(name, ok, detail) { if (ok) passed++; else failures.push(`${name}${detail ? ` (${String(detail).slice(0, 300)})` : ''}`); }
const tick = (ms) => new Promise((r) => setTimeout(r, ms || 15));

const D1 = 'D1000000-0000-0000-0000-000000000000';
const D2 = 'D2000000-0000-0000-0000-000000000000';
const D3 = 'D3000000-0000-0000-0000-000000000000';

function makeCtx(flags) {
  const t = { sent: [], pushes: [], logs: [], health: [], on: {}, cmds: {}, ready: [], chords: {}, enabled: true };
  t.list = [{ hwnd: '101', title: 'Notes', desktop: D1 }, { hwnd: '102', title: 'Mail', desktop: D1 }];
  t.desks = () => ({ ok: true, source: 'com', canWrite: true, current: D1, list: [{ id: D1, name: 'Desktop 1' }, { id: D2, name: 'Desktop 2' }].concat(t.extraDesk ? [{ id: D3, name: 'Desktop 3' }] : []) });
  t.listFail = null;
  t.ctx = {
    name: 'taskview', flags: Object.assign({ test: false }, flags), preload: '',
    log: (s) => t.logs.push(s),
    sidecar: {
      get pid() { return t.sidecarPid || null; },   // lib/features.js ctx.sidecar.pid
      async send(cmd, args) {
        t.sent.push({ cmd, args });
        if (cmd === 'focus') {
          ORDER.push(`sidecar focus ${args.hwnd}`);
          if (t.focusDelay) await tick(t.focusDelay);
          if (t.ladder === 'win') { FakeWin.kb = args.hwnd === '4242';   // a give-back moves it OFF Task View
            return { ok: true, result: { how: 'attach', tried: ['direct: refused'], ms: 12 } }; }
          if (t.ladder === 'lose') return { ok: false, error: "Windows refused the foreground change; tried direct: refused; attach: refused" };
          return { ok: true, result: { how: 'direct' } };
        }
        if (cmd === 'taskview.list' && t.listDelay) await tick(t.listDelay);
        if (cmd === 'taskview.list') return t.listFail ? { ok: false, error: t.listFail } : { ok: true, result: { list: t.list.map((x) => Object.assign({}, x)), desktops: t.desks(), others: [], mon: [0, 0, 1920, 1080], ms: { windows: 1, desktops: 1 } } };
        if (cmd === 'windows') return { ok: true, result: [] };
        if (cmd === 'glass') return { ok: true, result: { applied: true } };
        if (cmd === 'close') return { ok: true, result: {} };
        if (cmd === 'taskview.activate') return { ok: true, result: { ok: true, dry: !!args.dry, how: 'direct' } };
        if (cmd === 'desktops.create') { t.extraDesk = true; return { ok: true, result: { ok: true, id: args.dry ? undefined : D3 } }; }
        if (cmd.startsWith('desktops.')) return { ok: true, result: { ok: true, dry: !!args.dry } };
        return { ok: false, error: `unknown command ${cmd}` };
      },
      on(ev, fn) { (t.on[ev] = t.on[ev] || []).push(fn); return () => {}; },
      onReady(fn) { t.ready.push(fn); return () => {}; },
    },
    command(n, fn) { t.cmds[n] = fn; }, replay() {},
    onChord(k, fn) { t.chords[k] = fn; return () => {}; },
    health(ok, reason) { t.health.push({ ok, reason }); },
    enabled: () => t.enabled,
    onEnabled() {},
    page: (f) => f || 'index.html',
    push(win, event, payload) { t.pushes.push({ event, payload }); return true; },
    broadcast() {},
  };
  t.last = (ev) => { const p = t.pushes.filter((x) => x.event === ev); return p.length ? p[p.length - 1].payload : null; };
  t.cmd = async (n, a) => { try { return { ok: true, value: await t.cmds[n](a) }; } catch (err) { return { ok: false, error: err.message }; } };
  t.writes = () => t.sent.filter((s) => s.cmd !== 'taskview.list' && s.cmd !== 'windows' && s.cmd !== 'glass');
  return t;
}

async function openSession(t) {
  t.chords['Win+Tab']();
  await tick(20);
  return t.last('taskview.open');
}

(async () => {
  // ---- a normal run ------------------------------------------------------------------------------
  {
    const t = makeCtx();
    const h = feature.install(t.ctx);
    check('claims Win+Tab only', JSON.stringify(feature.chords) === '["Win+Tab"]');
    check('rests while a game runs', feature.rest === true);
    await tick(10);
    const open = await openSession(t);
    check('Win+Tab opens a session with the list', open && open.list.length === 2 && open.seq === 1, JSON.stringify(open));
    const seq = open.seq;

    // the page may only name this session's windows
    const before = t.writes().length;
    let r = await t.cmd('activate', { seq, hwnd: '999' });
    check('activate: a window the session never listed is refused in words', !r.ok && /no longer in Task View/.test(r.error), JSON.stringify(r));
    r = await t.cmd('activate', { seq, hwnd: '101; calc' });
    check('activate: a malformed window id is refused', !r.ok, JSON.stringify(r));
    r = await t.cmd('close', { seq, hwnd: '999' });
    check('close: a foreign window is refused', !r.ok && /no longer in Task View/.test(r.error));
    r = await t.cmd('close', { seq: seq + 7, hwnd: '101' });
    check('close: a stale session is ignored (nothing closed)', r.ok && r.value && r.value.stale === true);
    r = await t.cmd('close', { hwnd: '101' });
    check('close: no session number = ignored', r.ok && r.value && r.value.stale === true);
    r = await t.cmd('desk', { seq, op: 'format', desktop: D1 });
    check('desk: an unknown action is refused in words', !r.ok && /does not know that desktop action/.test(r.error));
    r = await t.cmd('desk', { seq, op: '__proto__' });
    check('desk: a prototype key is not an action', !r.ok && /does not know/.test(r.error));
    r = await t.cmd('desk', { seq, op: 'switch', desktop: 'D9000000-0000-0000-0000-000000000000' });
    check('desk: a desktop the session never listed is refused', !r.ok && /no longer exists/.test(r.error));
    r = await t.cmd('desk', { seq, op: 'switch', desktop: 'not a guid' });
    check('desk: a malformed desktop id is refused', !r.ok && /no longer exists/.test(r.error));
    r = await t.cmd('desk', { seq, op: 'rename', desktop: D2, name: { evil: true } });
    check('desk: a non-text name is refused', !r.ok && /has to be text/.test(r.error));
    r = await t.cmd('desk', { seq, op: 'rename', desktop: D2, name: 'x'.repeat(101) });
    check('desk: a 101-character name is refused', !r.ok && /100 characters/.test(r.error));
    r = await t.cmd('desk', { seq, op: 'move', desktop: D2, hwnd: '555' });
    check('desk: moving a window the session never listed is refused', !r.ok && /no longer in Task View/.test(r.error));
    check('...and none of the refusals reached the sidecar', t.writes().length === before, JSON.stringify(t.writes().slice(before)));

    // allowed ones reach the sidecar with exactly the checked arguments
    r = await t.cmd('desk', { seq, op: 'rename', desktop: D2, name: 'Work', hwnd: '101', extra: 1 });
    const rn = t.writes().pop();
    check('rename: sent as desktops.rename with desktop + name only', r.ok && rn.cmd === 'desktops.rename' && rn.args.desktop === D2 && rn.args.name === 'Work' && !('hwnd' in rn.args) && !('extra' in rn.args), JSON.stringify(rn));
    check('rename: answers with the fresh list', r.ok && Array.isArray(r.value.list) && r.value.desktops.list.length === 2);
    r = await t.cmd('desk', { seq, op: 'move', desktop: D2, hwnd: '102' });
    const mv = t.writes().pop();
    check('move: a listed window to a listed desktop is sent', r.ok && mv.cmd === 'desktops.move' && mv.args.hwnd === '102' && mv.args.desktop === D2 && mv.args.dry === false, JSON.stringify(mv));
    // a desktop made in this session can be the target of the next move (drag onto +)
    r = await t.cmd('desk', { seq, op: 'create' });
    check('create: answers with the new desktop id', r.ok && r.value.created === D3, JSON.stringify(r));
    r = await t.cmd('desk', { seq, op: 'move', desktop: D3, hwnd: '101' });
    check('move to the desktop just created is allowed', r.ok, JSON.stringify(r));

    // close: sent, then the list is read again; a window still there after the recheck is said on screen
    r = await t.cmd('close', { seq, hwnd: '101' });
    const cl = t.writes().pop();
    check('close: a listed window is closed through the sidecar', r.ok && cl.cmd === 'close' && cl.args.hwnd === '101', JSON.stringify(cl));
    await tick(420);
    check('close: the page gets the fresh list', !!t.last('taskview.update'));
    await tick(1400);
    const n = t.last('taskview.notice');
    check('close: a window still open after the recheck is said in words', n && /"Notes" is still open/.test(n.text) && /save/.test(n.text), JSON.stringify(n));

    // activate a listed window: switches and ends the session
    r = await t.cmd('activate', { seq, hwnd: '102' });
    check('activate: a listed window is switched to and the session ends', r.ok && t.last('taskview.end') && t.last('taskview.end').seq === seq, JSON.stringify(r));
    r = await t.cmd('activate', { seq, hwnd: '102' });
    check('activate after the session ended: ignored as stale', r.ok && r.value.stale === true);

    // Win+Tab again closes; a later Win+Tab opens a fresh session
    const o2 = await openSession(t);
    check('a second Win+Tab opens session 2', o2 && o2.seq === 2);
    t.chords['Win+Tab']();
    await tick(10);
    check('Win+Tab while open ends it', t.last('taskview.end').seq === 2 && /Win\+Tab again/.test(t.last('taskview.end').why));

    // the icon map is rebuilt from each full windows push (it used to grow forever)
    for (const fn of t.on.windows) fn({ list: [{ hwnd: '101', icon: 'data:a', exe: 'C:\\x\\notes.exe' }, { hwnd: '102', icon: 'data:b', exe: 'mail.exe' }] });
    const o3 = await openSession(t);
    check('icons from the windows push ride along', o3.list[0].icon === 'data:a' && o3.list[0].app === 'notes');
    t.chords['Win+Tab'](); await tick(5);
    for (const fn of t.on.windows) fn({ list: [{ hwnd: '102', icon: 'data:b', exe: 'mail.exe' }] });
    const o4 = await openSession(t);
    check('a closed window\'s icon does not stay in the map', o4.list[0].icon === null && o4.list[1].icon === 'data:b', JSON.stringify(o4.list));
    t.chords['Win+Tab'](); await tick(5);

    // the sidecar client's own failure reaches the page as plain words
    t.listFail = 'cannot run "taskview.list": the sidecar is not running';
    const o5 = await openSession(t);
    check('a failed list says why in plain words (no "sidecar")', o5 && o5.listReason && !/sidecar/i.test(o5.listReason) && /try again/.test(o5.listReason), o5 && o5.listReason);
    check('...and the desktops strip says it too', o5 && o5.desktops.ok === false && !/sidecar/i.test(o5.desktops.reason));
    check('...the technical reason is in the log', t.logs.some((l) => /sidecar is not running/.test(l)));
    t.listFail = null;
    t.chords['Win+Tab'](); await tick(5);

    // turning Task View off ends an open session; stop() destroys the window
    h.stop('test over');
    check('stop destroys the window', FakeWin.all[0].destroyed === true);
  }

  // ---- a --test run: every write is a dry run, closes refused ------------------------------------
  {
    const t = makeCtx({ test: true });
    const firstWin = FakeWin.all.length;
    const h = feature.install(t.ctx);
    await tick(10);
    const open = await openSession(t);
    const seq = open.seq;
    let r = await t.cmd('close', { seq, hwnd: '101' });
    check('--test: close is refused, and says why', !r.ok && /never closes your windows/.test(r.error));
    check('--test: ...without asking the sidecar', !t.writes().some((w) => w.cmd === 'close'));
    for (const [op, extra] of [['switch', { desktop: D2 }], ['create', {}], ['remove', { desktop: D2 }], ['rename', { desktop: D2, name: 'x' }], ['move', { desktop: D2, hwnd: '101' }]]) {
      r = await t.cmd('desk', Object.assign({ seq, op }, extra));
      const w = t.writes().pop();
      check(`--test: ${op} goes to the sidecar as a dry run`, r.ok && w && w.args.dry === true, JSON.stringify(w));
    }
    r = await t.cmd('activate', { seq, hwnd: '101' });
    const a = t.writes().pop();
    check('--test: activate is a dry run', r.ok && a.cmd === 'taskview.activate' && a.args.dry === true);
    check('--test: the window was never shown', FakeWin.all.slice(firstWin).every((w) => !w.shown) && FakeWin.all.length > firstWin);
    h.stop('test over');
  }

  // ---- the keyboard FIRST, then the screen (lane mn-raise, 2026-10-12) ------------------------------
  // A hot corner gives Mantle no input, so Electron's focus() is refused: the parked window takes the
  // keyboard through the sidecar's ladder BEFORE it comes on screen, and "shown" is only said once checked.
  const paint = async (t, seq) => t.cmd('painted', { seq, vw: 1536, vh: 864, dpr: 1.25, boxes: [] });
  const ended = (t) => t.logs.filter((l) => /; ended: /.test(l));
  {
    const t = makeCtx();
    t.ladder = 'win';
    t.sidecarPid = 9191;
    FakeWin.kb = false;
    RZ.judge = { onTop: true, why: 'on top' };
    RZ.fg = { hwnd: 777, mine: false, pid: 1, rect: { l: 0, t: 0, r: 800, b: 600 } };
    const h = feature.install(t.ctx);
    await tick(10);
    ORDER.length = 0;
    RZ.kbPids.length = 0; RZ.grants.length = 0;
    const open = await openSession(t);
    await paint(t, open.seq);
    await tick(40);
    check('the sidecar\'s pid (ctx.sidecar.pid) reaches raise.keyboard(), so the foreground right is handed on to it',
      RZ.kbPids.length >= 1 && RZ.kbPids.every((p) => p === 9191) && RZ.grants[0] === 9191, JSON.stringify({ kb: RZ.kbPids, grants: RZ.grants }));
    t.sidecarPid = null;
    const iFocus = ORDER.indexOf('sidecar focus 4242');
    const iScreen = ORDER.indexOf('on screen');
    check('corner/Win+Tab: the sidecar ladder takes the keyboard for Task View BEFORE it comes on screen',
      iFocus >= 0 && iScreen > iFocus && ORDER.indexOf('show') > iFocus, ORDER.join(' > '));
    check('it is put at the top of the topmost band while still parked, then moved on screen',
      ORDER.lastIndexOf('moveTop', iScreen) > iFocus && ORDER.lastIndexOf('moveTop', iScreen) < iScreen, ORDER.join(' > '));
    check('with the keyboard taken, Electron\'s refused focus() is not called again', !ORDER.includes('focus()'), ORDER.join(' > '));
    await t.cmd('dismiss', { seq: open.seq, why: 'esc' });
    const e = ended(t).pop() || '';
    check('the end line says "shown" only for a checked window, with the rung that won', /shown [\d.]+, checked on top \(keyboard: attach, [\d.]+ ms before the show\)/.test(e), e);
    const back = t.sent.filter((x) => x.cmd === 'focus').pop();
    check('Esc gives the keyboard back to the window that had it before Task View', back && back.args.hwnd === '777', JSON.stringify(back));
    check('no title or app name in the line', !/Notes|Mail/.test(e), e);
    h.stop('test over');
  }
  {
    // The ladder is slow: Task View still comes up, KB_WAIT_MS after the page drew, not never.
    const t = makeCtx();
    t.ladder = 'win'; t.focusDelay = 900;
    FakeWin.kb = false;
    const h = feature.install(t.ctx);
    await tick(10);
    ORDER.length = 0;
    const open = await openSession(t);
    await paint(t, open.seq);
    await tick(150);
    check('a slow ladder: not on screen yet 150 ms after drawing (waits for the keyboard)', !ORDER.includes('on screen'), ORDER.join(' > '));
    await tick(300);
    check('a slow ladder: on screen by KB_WAIT_MS anyway', ORDER.includes('on screen'), ORDER.join(' > '));
    await tick(1500);           // both slow ladder answers are in before the next case starts
    h.stop('test over');
  }
  {
    // A window that opens by itself takes the keyboard: taken back once, then Task View stays open.
    const t = makeCtx();
    t.ladder = 'win';
    FakeWin.kb = false;
    const h = feature.install(t.ctx);
    await tick(10);
    const open = await openSession(t);
    await paint(t, open.seq);
    await tick(40);
    const win = FakeWin.all[FakeWin.all.length - 1];
    const focusAsks = () => t.sent.filter((x) => x.cmd === 'focus' && x.args.hwnd === '4242').length;
    const before = focusAsks();
    FakeWin.kb = false;
    RZ.fg = { hwnd: 888, mine: false, pid: 2, rect: { l: 100, t: 100, r: 700, b: 500 } };   // on Task View's screen
    win.handlers.blur();
    await tick(400);
    check('a window on Task View\'s own screen took the keyboard: Task View is still open', ended(t).length === 0, ended(t).join(' | '));
    check('...and took the keyboard back through the ladder, once', focusAsks() === before + 1 && FakeWin.kb === true, `${before} -> ${focusAsks()}`);
    check('...and said so in the log, without a name', t.logs.some((l) => /opened by itself took the keyboard .* took it back \(the sidecar's ladder: attach/.test(l)), t.logs.slice(-3).join(' | '));
    FakeWin.kb = false;
    win.handlers.blur();
    await tick(400);
    check('stolen again: still open, not retaken a second time', ended(t).length === 0 && focusAsks() === before + 1, `${ended(t).join(' | ')} asks ${focusAsks()}`);
    const n = t.last('taskview.notice');
    check('...and the screen says typing will not reach it, and what still works', n && /took the keyboard/.test(n.text) && /Click a window/.test(n.text), JSON.stringify(n));
    // The user clicks a window on their OTHER screen: that is them moving on, so it ends.
    RZ.fg = { hwnd: 889, mine: false, pid: 2, rect: { l: 2000, t: 0, r: 3000, b: 800 } };
    win.handlers.blur();
    await tick(400);
    check('a window on another screen took it: the session ends, saying so', /ended: a window on another screen took the keyboard$/.test(ended(t).pop() || ''), ended(t).join(' | ') + ' // ' + t.logs.slice(-2).join(' | '));
    check('...and the keyboard is NOT pulled back from where they went', !t.sent.slice(-1).some((x) => x.cmd === 'focus' && x.args.hwnd === '777'));
    h.stop('test over');
  }
  {
    // Another Mantle window (the launcher) took it: ends, as before.
    const t = makeCtx();
    t.ladder = 'win';
    FakeWin.kb = false;
    RZ.fg = { hwnd: 777, mine: false, pid: 1, rect: { l: 0, t: 0, r: 800, b: 600 } };
    const h = feature.install(t.ctx);
    await tick(10);
    const open = await openSession(t);
    await paint(t, open.seq);
    await tick(40);
    const win = FakeWin.all[FakeWin.all.length - 1];
    FakeWin.kb = false;
    RZ.fg = { hwnd: 555, mine: true, pid: process.pid, rect: { l: 0, t: 0, r: 600, b: 400 } };
    win.handlers.blur();
    await tick(400);
    check('another Mantle window took the keyboard: ends', /ended: another Mantle window took the keyboard$/.test(ended(t).pop() || ''), ended(t).join(' | '));
    h.stop('test over');
  }
  {
    // The ladder loses AND the check finds it covered: never logged as "shown".
    const t = makeCtx();
    t.ladder = 'lose';
    FakeWin.kb = false;
    RZ.fg = { hwnd: 777, mine: false, pid: 1, rect: { l: 0, t: 0, r: 800, b: 600 } };
    RZ.judge = { onTop: false, why: "another app's window (pid 9) is in front of it at its centre" };
    const h = feature.install(t.ctx);
    await tick(10);
    const open = await openSession(t);
    await paint(t, open.seq);
    await tick(450);
    check('the ladder lost: Electron\'s focus() is still tried at the show', ORDER.includes('focus()'));
    check('...the ladder is asked once more after the show, and the screen says no typing', t.sent.filter((x) => x.cmd === 'focus').length >= 2 && /typing won't reach Task View/.test((t.last('taskview.notice') || {}).text || ''), JSON.stringify(t.last('taskview.notice')));
    check('...the log line gives the ladder\'s rung-by-rung reason', t.logs.some((l) => /no keyboard focus \(Windows refused the foreground change \(tried direct: refused; attach: refused\)\)/.test(l)), t.logs.slice(-3).join(' | '));
    await t.cmd('dismiss', { seq: open.seq, why: 'click-away' });
    const e = ended(t).pop() || '';
    check('covered: the end line says "placed ... but NOT on top", never "shown"', /placed [\d.]+ but NOT on top: another app's window \(pid 9\)/.test(e) && !/ shown /.test(e), e);
    RZ.judge = { onTop: true, why: 'on top' };
    h.stop('test over');
  }
  {
    // --test never asks for the keyboard and never shows.
    const t = makeCtx({ test: true });
    const h = feature.install(t.ctx);
    await tick(10);
    const open = await openSession(t);
    await paint(t, open.seq);
    await tick(30);
    check('--test: the keyboard is never asked for', !t.sent.some((x) => x.cmd === 'focus'));
    h.stop('test over');
  }
  {
    // Win+Tab twice, fast, while the ladder is still running: it lands on the PARKED window after the
    // session ended, so the keyboard is handed back then (never left on an invisible window).
    const t = makeCtx();
    t.ladder = 'win'; t.focusDelay = 150;
    FakeWin.kb = false;
    RZ.fg = { hwnd: 777, mine: false, pid: 1, rect: { l: 0, t: 0, r: 800, b: 600 } };
    const h = feature.install(t.ctx);
    await tick(10);
    t.chords['Win+Tab']();
    await tick(5);
    t.chords['Win+Tab']();
    await tick(450);
    const asks = t.sent.filter((x) => x.cmd === 'focus').map((x) => x.args.hwnd);
    check('Win+Tab twice mid-ladder: the keyboard goes back to the window that had it once the ladder lands', asks.join() === '4242,777' && FakeWin.kb === false, asks.join());
    // A switch to a window: the keyboard belongs there, never pulled back.
    const t2 = makeCtx();
    t2.ladder = 'win';
    FakeWin.kb = false;
    const h2 = feature.install(t2.ctx);
    await tick(10);
    const open = await openSession(t2);
    await paint(t2, open.seq);
    await tick(40);
    await t2.cmd('activate', { seq: open.seq, hwnd: '101' });
    await tick(20);
    check('a switch to a window never hands the keyboard back to the old one', !t2.sent.some((x) => x.cmd === 'focus' && x.args.hwnd === '777'), JSON.stringify(t2.sent.filter((x) => x.cmd === 'focus')));
    h.stop('test over'); h2.stop('test over');
    await tick(200);
  }
  FakeWin.kb = true;

  // ---- speed debt (lane speeddebt): the list from a cache, the fresh one after the paint --------
  {
    const t = makeCtx({ test: true });
    const h = feature.install(t.ctx);
    await tick(10);
    let open = await openSession(t);
    check('first open (no cache yet) waits for the fresh list and is cold', open && open.list.length === 2 && t.logs.every((l) => !/cached/.test(l)));
    await paint(t, open.seq);
    check('R7 line: "opened (cold) via Win+Tab: shown ..., painted ..., interactive ..."',
      t.logs.some((l) => /^opened \(cold\) via Win\+Tab: shown .*, painted [\d.]+, interactive .* ms/.test(l)), JSON.stringify(t.logs.filter((l) => /opened/.test(l))));
    t.chords['Win+Tab']();                                   // ends it
    await tick(10);
    // A slow sidecar, and a window closed since: the cached list is drawn at once, then replaced.
    t.listDelay = 90;
    t.list = [{ hwnd: '102', title: 'Mail', desktop: D1 }];
    const pushesBefore = t.pushes.length;
    t.chords['Win+Tab']();
    await tick(50);
    open = t.pushes.slice(pushesBefore).filter((p) => p.event === 'taskview.open').map((p) => p.payload)[0];
    check('a slow list: the cached list is drawn within ~LIST_WAIT_MS', open && open.list.length === 2, JSON.stringify(open && open.list.map((i) => i.hwnd)));
    check('nothing was replaced yet', !t.pushes.slice(pushesBefore).some((p) => p.event === 'taskview.update'));
    await paint(t, open.seq);
    await tick(90);
    const upd = t.pushes.slice(pushesBefore).filter((p) => p.event === 'taskview.update').map((p) => p.payload)[0];
    check('the fresh list replaces it (taskview.update, same session)', upd && upd.seq === open.seq && upd.list.length === 1 && upd.list[0].hwnd === '102', JSON.stringify(upd));
    const r = await t.cmd('activate', { seq: open.seq, hwnd: '101' });
    check('the window that closed meanwhile can no longer be named', !r.ok && /no longer in Task View/.test(r.error), JSON.stringify(r));
    check('R7 line says warm and that the cached list was drawn', t.logs.some((l) => /^opened \(warm\) via Win\+Tab: .*list cached \(\d+ s old\), fresh (not back|[\d.]+ ms)/.test(l)),
      JSON.stringify(t.logs.filter((l) => /opened/.test(l))));
    t.chords['Win+Tab']();
    await tick(10);
    // Same list again, still slow: drawn from the cache, the fresh one changes nothing (no update).
    const p2 = t.pushes.length;
    t.chords['Win+Tab']();
    await tick(140);
    check('an unchanged fresh list is not pushed again', t.pushes.slice(p2).some((p) => p.event === 'taskview.open') && !t.pushes.slice(p2).some((p) => p.event === 'taskview.update'));
    t.chords['Win+Tab']();
    await tick(10);
    // review2: the fresh list FAILS after the cached one was drawn: the screen says the list is old, and why.
    t.listFail = 'cannot run "taskview.list": the sidecar is not running';
    const p3 = t.pushes.length;
    t.chords['Win+Tab']();
    await tick(140);
    const open3 = t.pushes.slice(p3).filter((p) => p.event === 'taskview.open').map((p) => p.payload)[0];
    const n3 = t.pushes.slice(p3).filter((p) => p.event === 'taskview.notice').map((p) => p.payload)[0];
    check('a failed fresh list after a cached one: drawn from the cache', open3 && open3.list.length === 1, JSON.stringify(open3 && open3.list));
    check('...and the screen says the list is old and why (no silent fallback)', n3 && open3 && n3.seq === open3.seq && /from \d+ s ago: the current list could not be read \(Mantle's window helper is restarting/.test(n3.text || ''), JSON.stringify(n3));
    t.listFail = null;
    h.stop('test over');
    await tick(100);
  }
  {
    // The start-up warm-up: read once (fills the cache), drawn once in the parked window, then emptied.
    process.env.MANTLE_TASKVIEW_WARM_MS = '20';
    const t = makeCtx({ test: true });
    const h = feature.install(t.ctx);
    await tick(60);
    const warm = t.last('taskview.warm');
    check('the warm-up pushes the real list to the parked page once', warm && warm.list.length === 2 && t.pushes.filter((p) => p.event === 'taskview.warm').length === 1);
    check('the warm-up never opens a session or asks for the keyboard', !t.last('taskview.open') && !t.sent.some((x) => x.cmd === 'focus'));
    await t.cmd('warmed', { ms: 12 });
    check('the warm-up is logged with its timings', t.logs.some((l) => /^warm-up: 2 windows read in [\d.]+ ms .*drawn in the parked window in [\d.]+ ms/.test(l)), JSON.stringify(t.logs));
    t.listDelay = 90;
    t.chords['Win+Tab']();
    await tick(50);
    const open = t.last('taskview.open');
    check('the first open after a warm-up is warm and draws the cached list at once', open && open.list.length === 2);
    if (!open) throw new Error('no open after the warm-up');
    await paint(t, open.seq);
    check('...and says warm', t.logs.some((l) => /^opened \(warm\) via Win\+Tab/.test(l)));
    h.stop('test over');
    delete process.env.MANTLE_TASKVIEW_WARM_MS;
    await tick(120);
  }

  const total = passed + failures.length;
  for (const f of failures) console.log(`  FAIL ${f}`);
  console.log(`TASKVIEW MAIN TEST: ${passed} passed, ${failures.length} failed (of ${total})`);
  process.exit(failures.length ? 1 : 0);
})().catch((err) => { console.log(`TASKVIEW MAIN TEST: crashed: ${err.stack}`); process.exit(1); });

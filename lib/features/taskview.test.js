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
  setBounds(b) { this.bounds.push(b); this.cur = b; } getContentBounds() { return this.cur || { x: 0, y: 0, width: 1536, height: 864 }; }
  show() { this.shown = true; } showInactive() { this.shown = true; } setAlwaysOnTop() {} moveTop() {} focus() {} isFocused() { return true; }
}
FakeWin.all = [];
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
      async send(cmd, args) {
        t.sent.push({ cmd, args });
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

  const total = passed + failures.length;
  for (const f of failures) console.log(`  FAIL ${f}`);
  console.log(`TASKVIEW MAIN TEST: ${passed} passed, ${failures.length} failed (of ${total})`);
  process.exit(failures.length ? 1 : 0);
})().catch((err) => { console.log(`TASKVIEW MAIN TEST: crashed: ${err.stack}`); process.exit(1); });

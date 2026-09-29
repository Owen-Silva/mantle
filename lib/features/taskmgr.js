'use strict';
/*
 * taskmgr.js - Mantle's task manager, RAM first (lane taskmgr, 2026-09-28).
 *
 * WHY: Owen opens Windows' Task Manager for one job: free RAM before and while he plays Valorant
 * (he closed Spotify by hand for ~300 MB until the Spotify card learned to). This window does that
 * job: one row per app (Chrome's 20 processes are one row), sorted by memory, with Close, Force
 * close and Trim, and a "Get ready to game" view where he ticks the apps to close once and presses
 * "Free up RAM" (or lets a game's start do it, if he turned that on).
 *
 * THE WINDOW is an app window, created on demand and DESTROYED on close (never kept hidden: a
 * hidden renderer is ~60 MB of the RAM this is here to free). It samples ONLY while it exists:
 * every 1.5 s focused, every 3 s behind other windows. rest: true, so a game start closes it; the
 * chord (Ctrl+Shift+Esc, once lib/features.js and AltTab.cs know it) goes back to Windows' Task
 * Manager for the game. It is opaque on the theme's --lg-ground: Electron cannot resize a
 * transparent window on Windows, and an app window must resize.
 *
 * THE RULES (Owen's):
 *   - By pid + creation time, never by image name (sidecar/TaskMgr.cs holds a handle while acting).
 *   - Close = WM_CLOSE to its windows, else taskkill without /F. Force = /F, only after the confirm
 *     in the window (act() refuses a force without `confirmed`).
 *   - Protected rows (Windows, Explorer, Mantle, Lively, anti-cheat) offer nothing and say why;
 *     games are listed and closable but never trimmed. The sidecar refuses them a second time.
 *   - Nothing closes by itself unless Owen turned "when a game starts" on AND ticked the app.
 *   - Every outcome is ON THE ROW (closing / closed and what it freed / still running and why /
 *     refused and why). mantle.log gets pids, counts, MB and states: never a name, path or title.
 *   - --test: every action is a dry run whatever the page asks, the window is never shown, and
 *     nothing is started (Windows' Task Manager, a reopen).
 *
 * THE GAME START: a `rest: true` feature is not told through ctx.onRest (lib/features.js tellRest
 * skips resting features), so the auto-free runs in stop(why, {rest: true}), which IS that signal
 * (restAll, same moment). Apps marked "reopen after the game" are started again in the install()
 * that wakeAll() runs when the game exits (module memory `carry`, the notes pad's pattern): a
 * restart of Mantle forgets them, so nothing ever reopens in the middle of a game.
 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const C = require('./_taskmgr-core.js');

let CHORDS = [];
try { CHORDS = require('../features.js').CHORDS || []; } catch (_) { /* a harness without lib/features.js */ }
const CHORD = 'Ctrl+Shift+Esc';
/* The chord is listed only while lib/features.js (and sidecar/AltTab.cs) know it: listing an unknown
   chord would fail the whole feature's validation. Both list it since lane integrate (2026-09-28). */
const HAS_CHORD = CHORDS.includes(CHORD);

const TITLE = 'Mantle Task Manager';   // the page's <title>: Alt+Tab / the bar list know it by this
const W = 780, H = 640, MIN_W = 560, MIN_H = 420;
const FOCUSED_MS = 1500, BEHIND_MS = 3000;
const CLOSE_WAIT_MS = 7000;           // a close that has not ended every process by then is "still running"
const ARM_MS = 30 * 60 * 1000;        // "Free up RAM" then a game within 30 min: reopen after that game
const ICONS_PER_TICK = 6;

/* Survives a rest (the same module object is installed again by wakeAll): the apps to start again
   after the game. { at, armed, apps: [{name, exe, args}], cannot: [{name, why}] } */
let carry = null;

function mbNum(bytes) { return Math.round((bytes || 0) / C.MB); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function install(ctx, deps) {
  const d = deps || {};
  const electron = () => d.electron || require('electron');
  const test = !!(ctx.flags && ctx.flags.test);
  const mantlePid = d.pid || process.pid;
  const exists = d.exists || ((p) => { try { return fs.statSync(p).isFile(); } catch (_) { return false; } });
  const spawn = d.spawn || ((exe, args, o) => cp.spawn(exe, args, o));
  const CLOSE_WAIT = d.closeWaitMs || CLOSE_WAIT_MS;
  const S = {
    win: null, view: 'apps', timer: null, snap: null, prev: null, built: null, error: null, focused: false, sampling: false,
    icons: new Map(), iconQueue: [], states: new Map(), pending: new Map(), recent: [], lastFree: null, reopenInfo: new Map(),
    stopped: false, crashed: null,
  };
  const ticks = () => ctx.settings.get('ticks', {}) || {};
  const setState = (key, st) => { S.states.set(key, Object.assign({ at: Date.now() }, st)); };

  /* ---- sampling (only while the window exists) ---------------------------------------------- */
  async function sample() {
    const r = await ctx.sidecar.send('taskmgr.snapshot', {}, { timeoutMs: 5000 });
    if (!r.ok) {
      S.error = /unknown|no such|not a command/i.test(r.error || '')
        ? `this sidecar has no task manager commands (${r.error}); run npm run build:sidecar and restart Mantle`
        : `Mantle could not read the process list: ${r.error}`;
      publish();
      return null;
    }
    S.prev = S.snap;
    S.snap = r.result;
    S.error = null;
    S.built = C.buildGroups(S.snap, S.prev, { mantlePid });
    checkPending();
    queueIcons();
    publish();
    return S.built;
  }
  function schedule() {
    clearTimeout(S.timer);
    S.timer = null;
    if (!S.win || S.stopped) return;
    S.timer = setTimeout(async () => {
      S.timer = null;
      if (!S.win || S.stopped) return;
      await sample();
      pumpIcons();
      schedule();
    }, S.focused ? FOCUSED_MS : BEHIND_MS);
  }

  /* ---- icons: once per app, a few per tick, failures kept (and said) ------------------------ */
  function queueIcons() {
    for (const g of S.built.groups) {
      if (!g.path || S.icons.has(g.identity) || S.iconQueue.includes(g)) continue;
      S.iconQueue.push(g);
    }
  }
  async function pumpIcons() {
    const batch = S.iconQueue.splice(0, ICONS_PER_TICK);
    for (const g of batch) {
      if (S.icons.has(g.identity)) continue;
      const r = await ctx.sidecar.send('icon', { path: g.path }, { timeoutMs: 3000 });
      S.icons.set(g.identity, r.ok && r.result && r.result.icon ? { icon: r.result.icon } : { icon: null, why: r.ok ? 'Windows had no icon for it' : r.error });
    }
    if (batch.length) publish();
  }

  /* ---- closes in flight: did the processes really end? --------------------------------------- */
  function checkPending() {
    if (!S.snap) return;
    const live = new Set(S.snap.procs.map(C.keyOf));
    const now = Date.now();
    for (const [key, p] of Array.from(S.pending)) {
      const left = p.procs.filter((q) => live.has(C.keyOf(q)));
      if (!left.length) {
        S.pending.delete(key);
        setState(key, { state: 'closed', freed: p.mem, why: null });
        S.recent.unshift({ name: p.name, text: `Closed · freed about ${C.mb(p.mem)}`, ok: true, at: now });
        if (p.batch && S.lastFree && S.lastFree.id === p.batch) S.lastFree.freed += p.mem;
        ctx.log(`closed: pid ${p.root} and its ${p.procs.length - 1} other processes ended (${mbNum(p.mem)} MB)`);
        continue;
      }
      if (now - p.at < CLOSE_WAIT) continue;
      S.pending.delete(key);
      const g = S.built && S.built.byKey.get(key);
      const winsNow = g ? g.windows : 0;
      let why;
      if (p.how === 'wm_close') {
        why = p.windows > 0 && winsNow === 0
          ? 'Its window closed but it kept running in the background (probably in the tray). Force close ends it.'
          : 'It did not close: it ignored the close request or is asking to save something. Check its window, or Force close.';
      } else if (p.how === 'taskkill') why = 'Still running after Windows asked it to close. Force close ends it.';
      else why = 'Still running after Force close: Windows did not end it (it may be protected or elevated).';
      if (left.length < p.procs.length) why += ` (${p.procs.length - left.length} of its ${p.procs.length} processes did end)`;
      setState(key, { state: 'still-running', why });
      S.recent.unshift({ name: p.name, text: why, ok: false, at: now });
      ctx.log(`close of pid ${p.root}: ${left.length} of ${p.procs.length} processes still running after ${CLOSE_WAIT} ms (${p.how})`);
    }
    S.recent = S.recent.slice(0, 6);
  }

  /* ---- the model the page draws ------------------------------------------------------------- */
  function rowOf(g) {
    const ic = S.icons.get(g.identity);
    return Object.assign({}, g, { icon: ic ? ic.icon : null, iconWhy: ic ? ic.why || null : null, actions: C.actionsFor(g), state: S.states.get(g.key) || null });
  }
  function model() {
    const groups = S.built ? S.built.groups : [];
    const t = ticks();
    const prep = C.prepRows(groups, t).map((r) => {
      const ic = S.icons.get(r.identity);
      const ri = S.reopenInfo.get(r.identity);
      return Object.assign(r, { icon: ic ? ic.icon : null, state: S.states.get(r.key) || null, reopenWhy: r.reopen && ri ? ri.why : null, reopenChecked: !!ri });
    });
    // ticked apps that are not running now still show (so a tick can be taken off)
    const running = new Set(prep.map((r) => r.identity));
    const absent = Object.keys(t).filter((id) => t[id] && t[id].on && !running.has(id)).map((id) => ({ identity: id, name: t[id].name || C.baseName(id), reopen: !!t[id].reopen }));
    const m = S.snap && S.snap.mem;
    return {
      at: Date.now(), test, error: S.error, view: S.view, chord: HAS_CHORD ? CHORD : null,
      mem: m || null, cpus: S.snap ? S.snap.cpus : null, method: S.snap ? S.snap.method : null, sampleMs: S.focused ? FOCUSED_MS : BEHIND_MS,
      mantle: S.built && S.built.mantle ? { mem: S.built.mantle.mem, count: S.built.mantle.count, cpu: S.built.mantle.cpu } : null,
      apps: groups.filter((g) => g.kind === 'app').map(rowOf),
      background: groups.filter((g) => g.kind === 'background').map(rowOf),
      windows: groups.filter((g) => g.kind === 'windows').map(rowOf),
      mantleRow: S.built && S.built.mantle ? rowOf(S.built.mantle) : null,
      recent: S.recent,
      prep: { rows: prep, absent, auto: !!ctx.settings.get('autoFree', false), lastFree: S.lastFree, lastAuto: ctx.settings.get('lastAuto', null),
        reopenPending: carry ? { armed: carry.armed, apps: carry.apps.map((a) => a.name), cannot: carry.cannot } : null },
      loaded: !!S.snap,
    };
  }
  let lastModel = null;
  function publish() {
    lastModel = model();
    if (S.win) ctx.push(S.win, 'taskmgr.model', lastModel);
  }
  ctx.replay('taskmgr.model', () => lastModel || model());

  /* ---- actions ------------------------------------------------------------------------------ */
  function refusedWords(list) {
    const l = Array.isArray(list) ? list : [];
    if (!l.length) return '';
    const whys = Array.from(new Set(l.map((x) => x.why)));
    return `${l.length} of its processes were left alone (${whys.join('; ')})`;
  }

  async function closeGroup(g, force, dry, batch) {
    const r = await ctx.sidecar.send('taskmgr.close', { procs: g.procs, root: g.root, force: !!force, dryRun: dry }, { timeoutMs: 12000 });
    if (!r.ok) {
      const why = r.error === 'refused: sidecar is passive (test mode)' ? 'Not closed: this is a test Mantle, its sidecar refuses to close anything' : `Not closed: ${r.error}`;
      setState(g.key, { state: 'failed', why });
      return { ok: false, key: g.key, name: g.name, mem: g.mem, why };
    }
    const x = r.result;
    if (dry) {
      setState(g.key, { state: 'dry', why: `Dry run: ${x.why || x.how}${x.refused && x.refused.length ? '; ' + refusedWords(x.refused) : ''}` });
      return { ok: true, dryRun: true, key: g.key, name: g.name, mem: g.mem, how: x.how, why: x.why, command: x.command || null };
    }
    if (!x.done) {
      const why = `Not closed: ${x.why || refusedWords(x.refused) || 'Windows gave no reason'}`;
      setState(g.key, { state: 'failed', why });
      return { ok: false, key: g.key, name: g.name, mem: g.mem, why };
    }
    S.pending.set(g.key, { name: g.name, root: g.root, procs: g.procs, mem: g.mem, how: x.how, windows: g.windows, at: Date.now(), batch: batch || null });
    const note = x.why || (x.refused && x.refused.length ? refusedWords(x.refused) : null);
    setState(g.key, { state: 'closing', how: x.how, why: note });
    return { ok: true, key: g.key, name: g.name, mem: g.mem, how: x.how, why: note };
  }

  async function act(a) {
    const o = a || {};
    const g = S.built && S.built.byKey.get(String(o.key));
    if (!g) return { ok: false, reason: 'That row is gone (it exited or the list changed); nothing was done.' };
    const can = C.actionsFor(g);
    const dry = test || !!o.dryRun;
    if (o.action === 'trim') {
      if (!can.trim) { setState(g.key, { state: 'failed', why: `Not trimmed: ${can.why}` }); publish(); return { ok: false, reason: can.why }; }
      setState(g.key, { state: 'trimming' });
      publish();
      const r = await ctx.sidecar.send('taskmgr.trim', { procs: g.procs, dryRun: dry }, { timeoutMs: 12000 });
      let out;
      if (!r.ok) {
        const why = r.error === 'refused: sidecar is passive (test mode)' ? 'Not trimmed: this is a test Mantle, its sidecar refuses to trim' : `Not trimmed: ${r.error}`;
        setState(g.key, { state: 'failed', why });
        out = { ok: false, reason: why };
      } else {
        const x = r.result;
        const rest = x.refused && x.refused.length ? refusedWords(x.refused) : null;
        const failed = (x.rows || []).filter((q) => q.why);
        setState(g.key, { state: dry ? 'dry' : 'trimmed', before: x.before, after: x.after,
          why: dry ? `Dry run: ${x.why}` : [failed.length ? `${failed.length} could not be trimmed (${failed[0].why})` : null, rest].filter(Boolean).join('; ') || null });
        out = { ok: true, dryRun: dry, before: x.before, after: x.after, trimmed: x.trimmed };
      }
      ctx.log(`trim pid ${g.root} (${g.count} processes): ${out.ok ? `${mbNum(out.before)} -> ${mbNum(out.after)} MB${dry ? ' (dry run)' : ''}` : 'failed'}`);
      publish();
      return out;
    }
    if (o.action !== 'close' && o.action !== 'force') return { ok: false, reason: `unknown action "${o.action}" (close, force or trim)` };
    if (!can.close) { setState(g.key, { state: 'failed', why: `Not closed: ${can.why}` }); publish(); return { ok: false, reason: can.why }; }
    const force = o.action === 'force';
    if (force && o.confirmed !== true) return { ok: false, needsConfirm: true, reason: 'Force close needs the confirm in the window first.' };
    setState(g.key, { state: 'closing', how: force ? 'taskkill_force' : null });
    publish();
    const res = await closeGroup(g, force, dry);
    ctx.log(`${force ? 'force close' : 'close'} pid ${g.root} (${g.count} processes, ${mbNum(g.mem)} MB): ${res.ok ? (res.dryRun ? 'dry run' : `sent (${res.how})`) : 'not closed'}`);
    publish();
    return res;
  }

  /** "Free up RAM": the ticked apps, gracefully. via: 'button' | 'game'. */
  async function freeUp(o, via) {
    const dry = test || !!(o && o.dryRun);
    const b = (await sample()) || S.built;
    if (!b) return { ok: false, reason: S.error || 'the process list could not be read' };
    const plan = C.planFree(b.groups, ticks());
    const id = Date.now();
    S.lastFree = { id, at: id, via, dryRun: dry, results: [], freed: 0, availBefore: S.snap && S.snap.mem ? S.snap.mem.avail : null, reopen: [] };
    if (!plan.length) { S.lastFree.none = 'Nothing ticked is running right now.'; publish(); return { ok: true, closed: 0, reason: S.lastFree.none }; }
    const reopen = [];
    for (const p of plan) {
      if (p.reopen) {
        const r = await ctx.sidecar.send('taskmgr.cmdline', { pid: p.root, created: p.created }, { timeoutMs: 4000 });
        const plan2 = C.reopenPlan(r.ok ? r.result : { why: `its command line could not be read (${r.error})` }, exists);
        reopen.push(Object.assign({ name: p.name, identity: p.identity }, plan2));
      }
      const g = b.byKey.get(p.key);
      S.lastFree.results.push(await closeGroup(g, false, dry, id));
    }
    S.lastFree.reopen = reopen.map((r) => ({ name: r.name, can: !!r.exe, why: r.exe ? r.note || null : r.why }));
    if (!dry && reopen.some((r) => r.exe)) {
      carry = { at: Date.now(), armed: via === 'game', apps: reopen.filter((r) => r.exe).map((r) => ({ name: r.name, exe: r.exe, args: r.args })),
        cannot: reopen.filter((r) => !r.exe).map((r) => ({ name: r.name, why: r.why })) };
    }
    const sent = S.lastFree.results.filter((r) => r.ok).length;
    ctx.log(`free up RAM (${via}): ${plan.length} ticked apps running, ${sent} close requests sent, ${plan.length - sent} not closed${dry ? ' (dry run)' : ''}; ${reopen.filter((r) => r.exe).length} to reopen after the game`);
    publish();
    return { ok: true, dryRun: dry, planned: plan.length, sent, results: S.lastFree.results, reopen: S.lastFree.reopen };
  }

  /** Is this app reopenable? Asked when Owen ticks "reopen", so the answer is on screen before the game. */
  async function checkReopen(identity) {
    const g = S.built && S.built.groups.find((x) => x.identity === identity);
    if (!g) return;
    const r = await ctx.sidecar.send('taskmgr.cmdline', { pid: g.root, created: g.created }, { timeoutMs: 4000 });
    const p = C.reopenPlan(r.ok ? r.result : { why: `its command line could not be read (${r.error})` }, exists);
    S.reopenInfo.set(identity, { can: !!p.exe, why: p.exe ? p.note || null : `Cannot reopen: ${p.why}` });
    publish();
  }

  /* ---- the window ---------------------------------------------------------------------------- */
  function destroyWindow(why) {
    clearTimeout(S.timer);
    S.timer = null;
    const w = S.win;
    S.win = null;
    S.snap = S.prev = null;           // the table is only needed while it is on screen
    if (w && !w.isDestroyed()) w.destroy();
    if (w) ctx.log(`window closed (${why})`);
  }
  function saveBounds(w) {
    try { if (!w.isDestroyed() && !w.isMaximized() && !w.isMinimized()) ctx.settings.set('bounds', w.getBounds()); } catch (_) { /* a failed save only loses the size */ }
  }
  function createWindow() {
    const BrowserWindow = d.BrowserWindow || electron().BrowserWindow;
    const screen = d.screen || electron().screen;
    let b = ctx.settings.get('bounds', null);
    const wa = screen.getPrimaryDisplay().workArea || screen.getPrimaryDisplay().bounds;
    if (!b || !(b.width >= MIN_W) || !(b.height >= MIN_H)) b = { width: W, height: H, x: Math.round(wa.x + (wa.width - W) / 2), y: Math.round(wa.y + (wa.height - H) / 2) };
    const w = new BrowserWindow({
      show: false, frame: false, transparent: false, backgroundColor: '#F4F6FA', title: TITLE,
      resizable: true, movable: true, minimizable: true, maximizable: true, fullscreenable: false, skipTaskbar: false,
      width: b.width, height: b.height, x: b.x, y: b.y, minWidth: MIN_W, minHeight: MIN_H,
      webPreferences: { preload: ctx.preload, contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
    });
    const wc = w.webContents;
    wc.on('will-navigate', (e) => e.preventDefault());
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('render-process-gone', (_e, det) => {
      if (S.win !== w) return;
      S.crashed = `the task manager's page crashed (${det && det.reason}); it opens fresh next time`;
      ctx.health(false, S.crashed);
      destroyWindow('page crashed');
    });
    wc.on('did-fail-load', (_e, code, desc, _u, isMain) => {
      if (isMain === false || S.win !== w) return;
      ctx.health(false, `the task manager's page did not load (${desc || code})`);
    });
    w.on('focus', () => { S.focused = true; schedule(); });
    w.on('blur', () => { S.focused = false; });
    let bt = null;
    const later = () => { clearTimeout(bt); bt = setTimeout(() => saveBounds(w), 600); };
    w.on('resize', later);
    w.on('move', later);
    w.on('closed', () => { if (S.win === w) { S.win = null; clearTimeout(S.timer); S.timer = null; S.snap = S.prev = null; } });
    w.loadFile(ctx.page('index.html'));
    return w;
  }

  async function open(a) {
    const view = a && a.view === 'game' ? 'game' : a && a.view === 'startup' ? 'startup' : 'apps';
    if (S.stopped) return { ok: false, reason: 'the task manager is stopped' };
    if (!ctx.enabled()) return { ok: false, reason: "Mantle's task manager is switched off in the tray menu; Windows' Task Manager still works (Ctrl+Shift+Esc)" };
    S.view = view;
    const fresh = !S.win || S.win.isDestroyed();
    if (fresh) {
      S.win = createWindow();
      if (S.crashed) { S.crashed = null; ctx.health(true); }
      if (!test) S.win.once('ready-to-show', () => { if (S.win && !S.win.isDestroyed()) { S.win.show(); S.win.focus(); } });
      ctx.log(`window opened (view ${view})${test ? ' hidden: test mode' : ''}`);
    } else if (!test) {
      if (S.win.isMinimized()) S.win.restore();
      S.win.show();
      S.win.focus();
    }
    publish();
    ctx.push(S.win, 'taskmgr.view', { view });
    await sample();
    pumpIcons();
    schedule();
    return { ok: true, view, created: fresh, shown: !test };
  }

  /* ---- commands ------------------------------------------------------------------------------ */
  ctx.command('open', open);
  ctx.command('state', async () => model());
  ctx.command('view', async (a) => { S.view = ['apps', 'game', 'startup'].includes(a && a.view) ? a.view : 'apps'; publish(); return { ok: true, view: S.view }; });
  ctx.command('act', act);
  ctx.command('free', (a) => freeUp(a, 'button'));
  ctx.command('tick', async (a) => {
    const o = a || {};
    const id = String(o.identity || '');
    const g = S.built && S.built.groups.find((x) => x.identity === id);
    const t = ticks();
    if (g && C.tickWhy(g)) return { ok: false, reason: C.tickWhy(g) };
    if (!g && !t[id]) return { ok: false, reason: 'that app is not running and was never ticked' };
    const rec = Object.assign({ on: false, reopen: false, name: g ? g.name : id }, t[id] || {});
    if (o.on !== undefined) rec.on = !!o.on;
    if (o.reopen !== undefined) rec.reopen = !!o.reopen;
    if (g) rec.name = g.name;
    if (!rec.on && !rec.reopen) delete t[id]; else t[id] = rec;
    try { ctx.settings.set('ticks', t); } catch (e) { return { ok: false, reason: `the tick was not saved: ${e.message}` }; }
    if (rec.reopen && o.reopen) checkReopen(id);
    ctx.log(`ticks: ${Object.values(t).filter((x) => x.on).length} apps ticked, ${Object.values(t).filter((x) => x.on && x.reopen).length} to reopen`);
    publish();
    return { ok: true, identity: id, on: rec.on, reopen: rec.reopen };
  });
  ctx.command('auto', async (a) => {
    const on = !!(a && a.on);
    try { ctx.settings.set('autoFree', on); } catch (e) { return { ok: false, reason: `not saved: ${e.message}` }; }
    ctx.log(`free up RAM when a game starts: ${on ? 'on' : 'off'}`);
    publish();
    return { ok: true, auto: on };
  });
  ctx.command('win', async (a) => {
    const op = a && a.op;
    const w = S.win;
    if (!w || w.isDestroyed()) return { ok: false, reason: 'the window is not open' };
    if (op === 'close') { destroyWindow('closed by its button'); return { ok: true }; }
    if (test) return { ok: true, dryRun: true, reason: `test mode: would ${op} the window` };
    if (op === 'min') w.minimize();
    else if (op === 'max') { if (w.isMaximized()) w.unmaximize(); else w.maximize(); }
    else return { ok: false, reason: `unknown window op "${op}"` };
    return { ok: true, maximized: w.isMaximized() };
  });
  // Mantle Settings > Mantle writes the same key (options below): the page's switch follows at once.
  if (typeof ctx.onOption === 'function') ctx.onOption('autoFree', () => publish());
  ctx.command('windowsTaskManager', async () => {
    const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'Taskmgr.exe');
    if (test) return { ok: true, dryRun: true, reason: `test mode: would run ${exe}` };
    try { spawn(exe, [], { detached: true, stdio: 'ignore' }).unref(); return { ok: true }; } catch (e) { return { ok: false, reason: `Windows' Task Manager did not start: ${e.message}` }; }
  });
  ctx.command('sample', async () => { const b = await sample(); return b ? { ok: true, groups: b.groups.length } : { ok: false, reason: S.error }; });

  if (HAS_CHORD) ctx.onChord(CHORD, () => { open({ view: 'apps' }); });

  /* the launcher's "Mantle Task Manager" rows (lib/launcher-index.js MANTLE_TARGETS: mantle:taskmgr) */
  const app = d.app || (d.electron ? d.electron.app : (() => { try { return electron().app; } catch (_) { return null; } })());
  const onOpen = (target) => { if (target === 'taskmgr' || target === 'taskmgr:game') open({ view: target === 'taskmgr:game' ? 'game' : 'apps' }); };
  /* 'mantle-open:taskmgr' (view) is listened to ONLY while the feature is on and awake, so a launcher
     that checks app.listenerCount('mantle-open:taskmgr') can say "off or resting" instead of doing
     nothing (the shared 'mantle-open' always has wallpaper.js listening, so its emit() is always true). */
  const onOwn = (view) => { open({ view: view === 'game' ? 'game' : 'apps' }); };
  const listen = (on) => {
    if (!app || typeof app.on !== 'function') return;
    app.removeListener('mantle-open', onOpen);
    app.removeListener('mantle-open:taskmgr', onOwn);
    if (on) { app.on('mantle-open', onOpen); app.on('mantle-open:taskmgr', onOwn); }
  };
  listen(ctx.enabled());
  ctx.onEnabled((on) => { listen(on); if (!on) destroyWindow('switched off in the tray'); });

  /* ---- after a game: start again what was closed for it ------------------------------------- */
  if (carry && !carry.armed && Date.now() - carry.at > ARM_MS) carry = null;
  if (carry && carry.armed) {
    const c = carry;
    carry = null;
    const results = c.apps.map((a) => {
      if (test) return { name: a.name, ok: true, dryRun: true, why: 'test mode: not started' };
      if (!exists(a.exe)) return { name: a.name, ok: false, why: 'its exe is gone (updated or moved)' };
      try {
        const child = spawn(a.exe, a.args || [], { detached: true, stdio: 'ignore', cwd: path.dirname(a.exe) });
        if (child && child.on) child.on('error', (e) => ctx.log(`reopen after the game: a start failed (${e.code || e.message})`));
        if (child && child.unref) child.unref();
        return { name: a.name, ok: true };
      } catch (e) { return { name: a.name, ok: false, why: e.message }; }
    }).concat(c.cannot.map((x) => ({ name: x.name, ok: false, why: x.why })));
    const last = ctx.settings.get('lastAuto', null) || {};
    try { ctx.settings.set('lastAuto', Object.assign(last, { reopened: { at: Date.now(), results } })); } catch (_) { /* shown next open anyway */ }
    ctx.log(`reopen after the game: ${results.filter((r) => r.ok).length} started, ${results.filter((r) => !r.ok).length} could not be`);
  }

  ctx.health(true);
  return {
    async stop(why, how) {
      const resting = !!(how && how.rest);
      destroyWindow(resting ? 'a game started' : why);
      listen(false);
      if (!resting) { S.stopped = true; return; }
      if (carry && !carry.armed && Date.now() - carry.at < ARM_MS) carry.armed = true;
      if (!ctx.settings.get('autoFree', false) || !ctx.enabled()) { S.stopped = true; return; }
      // The game-start free: never holds the rest longer than ~1.8 s; the closes finish after.
      const job = (async () => {
        const r = await freeUp({}, 'game');
        await sleep(CLOSE_WAIT + 500);
        await sample();                                      // settles closed / still running
        const lf = S.lastFree || {};
        const rows = (lf.results || []).map((x) => ({ name: x.name, mem: x.mem, ok: x.ok, why: (S.states.get(x.key) || {}).why || x.why || null, state: (S.states.get(x.key) || {}).state || null }));
        try {
          ctx.settings.set('lastAuto', { at: lf.at || Date.now(), game: String(why || '').replace(/^resting while /, ''), none: lf.none || null, results: rows, freed: lf.freed || 0, reopen: lf.reopen || [], dryRun: !!lf.dryRun });
        } catch (e) { ctx.log(`game-start free: its result was not saved (${e.message})`); }
        ctx.log(`game-start free: ${rows.filter((x) => x.state === 'closed').length} closed, ${rows.filter((x) => x.state !== 'closed').length} not, ${mbNum(lf.freed)} MB freed${r && r.dryRun ? ' (dry run)' : ''}`);
        S.stopped = true;
        S.snap = S.prev = null;
      })().catch((e) => ctx.log(`game-start free failed: ${e.message}`));
      await Promise.race([job, sleep(1800)]);
    },
    // taskmgr.test.js
    _S: S, _sample: sample, _model: model, _freeUp: freeUp,
  };
}

module.exports = {
  name: 'taskmgr',
  label: 'Task manager (free RAM for games)',
  defaultOn: true,
  chords: HAS_CHORD ? [CHORD] : [],
  observe: [],
  rest: true,
  // Mantle Settings > Mantle (lib/features.js OPTIONS): the same 'autoFree' key the rest stop() reads.
  options: [
    { key: 'autoFree', label: 'Free up RAM when a game starts', help: 'Closes the apps ticked in Task manager > Get ready to game, gracefully, when a known game starts.', type: 'bool', default: false },
  ],
  install: (ctx) => install(ctx),
  _install: install,             // taskmgr.test.js: the same install against a fake ctx, window and sidecar
  _carry: () => carry,
  _setCarry: (c) => { carry = c; },
  TITLE, CHORD, HAS_CHORD, FOCUSED_MS, BEHIND_MS, CLOSE_WAIT_MS,
};

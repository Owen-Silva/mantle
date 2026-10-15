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
 * THE WINDOW is an app window, created on demand. Close HIDES it for 3 minutes, then destroys it
 * (lane taskmgrfx, measured: a cold open was 0.8-1.5 s to the first list, a warm one shows its last
 * list in one frame; the hidden renderer holds ~54 MB for those minutes, the RAM this is here to
 * free, so never longer). It samples ONLY while it is on screen: every 1.5 s focused, every 3 s
 * behind other windows, never hidden or minimized. rest: true, so a game start destroys it; the
 * chord (Ctrl+Shift+Esc) goes back to Windows' Task Manager for the game. Its glass is Windows'
 * acrylic system backdrop (createWindow), not a transparent window: Electron cannot resize a
 * transparent window on Windows, and an app window must resize. Its own icon and taskbar group:
 * assets/icons/mantle-taskmgr.ico + AppUserModelID Mantle.TaskManager.
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
const WW = require('./_wall-window.js');
const OT = require('./_open-timing.js');

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
const HIST = 60;                      // the CPU and memory lines: the last 60 samples (1.5-3 min on screen)
const IDLE_MS = 3 * 60 * 1000;        // a closed (hidden) window is destroyed after this long
/* Its own picture in the taskbar, Alt+Tab and the bar (Owen: "they need to have there own icons that
   replace windows icons not just be electron"). The artwork is the icons lane's; the window opens
   without it and says so on the page when the file is not there. */
const ICON_FILE = path.join(__dirname, '..', '..', 'assets', 'icons', 'mantle-taskmgr.ico');
const APP_ID = 'Mantle.TaskManager';

/* Survives a rest (the same module object is installed again by wakeAll): the apps to start again
   after the game. { at, armed, apps: [{name, exe, args}], cannot: [{name, why}] } */
let carry = null;

function mbNum(bytes) { return Math.round((bytes || 0) / C.MB); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function install(ctx, deps) {
  const d = deps || {};
  const electron = () => d.electron || require('electron');
  const test = !!(ctx.flags && ctx.flags.test);
  const timing = OT.create(ctx);
  const canShow = !test || OT.testShows(d.env);   // a --test copy shows only to time an open (invisible: lib/test-quiet.js)
  const mantlePid = d.pid || process.pid;
  let frameSeq = 0;                   // a theme switch mid-call: only the newest frame ask may decide (lightFrame)
  if (ctx.host && ctx.host.theme && typeof ctx.host.theme.onChange === 'function') {
    ctx.host.theme.onChange(() => { if (S.win && !S.win.isDestroyed() && typeof S.reframe === 'function') S.reframe(); });
  }
  /* lane helm-wall-apps (2026-10-09): in DARK the window is opaque and the page paints the desktop wallpaper
     under its tint, as Helm does (lib/features/_wall-window.js, ui/shared/wall-bdrop.js). Light: unchanged. */
  const wall = WW.feed(ctx, { event: 'taskmgr.wall', pos: 'taskmgr.wallpos', light: { material: 'acrylic', color: '#00000000' } });
  const exists = d.exists || ((p) => { try { return fs.statSync(p).isFile(); } catch (_) { return false; } });
  const spawn = d.spawn || ((exe, args, o) => cp.spawn(exe, args, o));
  const CLOSE_WAIT = d.closeWaitMs || CLOSE_WAIT_MS;
  const IDLE = d.idleMs || IDLE_MS;
  const S = {
    win: null, view: 'apps', timer: null, snap: null, prev: null, built: null, error: null, focused: false, sampling: false,
    icons: new Map(), iconQueue: [], states: new Map(), pending: new Map(), recent: [], lastFree: null, reopenInfo: new Map(),
    stopped: false, crashed: null,
    expanded: new Set(), hidden: false, minimized: false, idle: null, quitting: false, look: null,
    cpuTotal: null, hist: { cpu: [], mem: [] }, busy: new Set(),
  };
  /* Mantle's own row wears Mantle's icon, not Electron's: the tray's rounded square (lib/tray-icon.js),
     the one Mantle picture in the repo, drawn at 32 px. Said on the row when it cannot be made. */
  const MANTLE_ICON = 'mantle:self';
  (function mantleIcon() {
    try {
      const url = d.mantleIconUrl !== undefined ? d.mantleIconUrl
        : !d.electron && !process.versions.electron ? null      // plain node: never require('electron') (it can start its installer)
        : electron().nativeImage.createFromBitmap(require('../tray-icon.js').squareBitmap(32), { width: 32, height: 32 }).toDataURL();
      S.icons.set(MANTLE_ICON, url ? { icon: url } : { icon: null, why: "Mantle's icon could not be drawn" });
    } catch (e) { S.icons.set(MANTLE_ICON, { icon: null, why: `Mantle's icon could not be drawn (${e.message})` }); }
  }());
  const ticks = () => ctx.settings.get('ticks', {}) || {};
  const setState = (key, st) => { S.states.set(key, Object.assign({ at: Date.now() }, st)); };

  /* ---- sampling (only while the window exists) ---------------------------------------------- */
  async function sample() {
    let r;
    try { r = await ctx.sidecar.send('taskmgr.snapshot', {}, { timeoutMs: 5000 }); } catch (e) { r = { ok: false, error: e && e.message || String(e) }; }
    if (!r || !r.ok) {
      const err = (r && r.error) || 'no answer';
      S.error = /unknown|no such|not a command/i.test(err)
        ? "Mantle's helper program is an older version without the task manager: restart Mantle to update it"
        : /timed? ?out|timeout/i.test(err) ? 'Mantle could not read the list of running apps: Windows took too long to answer. Trying again.'
        : `Mantle could not read the list of running apps (${err}). Trying again.`;
      publish();
      return null;
    }
    S.prev = S.stale ? null : S.snap;  // never a CPU % averaged over minutes hidden
    S.stale = false;
    S.snap = r.result;
    S.error = null;
    S.built = C.buildGroups(S.snap, S.prev, { mantlePid });
    // the machine's CPU and memory, and their last HIST samples (the two lines at the top)
    S.cpuTotal = C.machineCpu(S.prev, S.snap);
    const mm = S.snap.mem;
    if (S.cpuTotal !== null) S.hist.cpu.push(S.cpuTotal);
    if (mm && mm.total > 0) S.hist.mem.push(Math.round((1000 * mm.used) / mm.total) / 10);
    if (S.hist.cpu.length > HIST) S.hist.cpu.splice(0, S.hist.cpu.length - HIST);
    if (S.hist.mem.length > HIST) S.hist.mem.splice(0, S.hist.mem.length - HIST);
    checkPending();
    queueIcons();
    publish();
    return S.built;
  }
  function schedule() {
    clearTimeout(S.timer);
    S.timer = null;
    // no samples while nobody can see them: closed (hidden, warm) or minimized
    if (!S.win || S.stopped || S.hidden || S.minimized) return;
    S.timer = setTimeout(async () => {
      S.timer = null;
      if (!S.win || S.stopped || S.hidden || S.minimized) return;
      // a throw here must never end the sampling for good (the window would freeze on old numbers)
      try { await sample(); await pumpIcons(); } catch (e) { ctx.log(`sample failed: ${e && e.message}`); }
      schedule();
    }, S.focused ? FOCUSED_MS : BEHIND_MS);
  }

  /* ---- icons: once per app, a few per tick, failures kept (and said) ------------------------ */
  function queueIcons() {
    for (const g of S.built.groups) {
      if (!g.path || g.kind === 'mantle' || S.icons.has(g.identity) || S.iconQueue.includes(g)) continue;
      S.iconQueue.push(g);
    }
  }
  async function pumpIcons() {
    const batch = S.iconQueue.splice(0, ICONS_PER_TICK);
    const fresh = {};
    for (const g of batch) {
      if (S.icons.has(g.identity)) continue;
      let r;
      try { r = await ctx.sidecar.send('icon', { path: g.path }, { timeoutMs: 3000 }); } catch (e) { r = { ok: false, error: e && e.message }; }
      S.icons.set(g.identity, r.ok && r.result && r.result.icon ? { icon: r.result.icon } : { icon: null, why: r.ok ? 'Windows had no icon for it' : r.error });
      if (S.icons.get(g.identity).icon) fresh[g.identity] = S.icons.get(g.identity).icon;
    }
    if (Object.keys(fresh).length && S.win && !S.hidden) ctx.push(S.win, 'taskmgr.icons', fresh);
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
  /* COMPACT (lane taskmgrfx, measured): the model crosses to the page every tick, and the page paid
     ~23 ms a tick just to receive a 181-221 KB one. So a row carries what the page draws and nothing
     else: no pids/creation times (main keeps them in S.built), its processes only while the page has
     it expanded, and an icon as a REFERENCE (its identity): the pictures travel once, on
     `taskmgr.icons`, and the page keeps them. */
  function iconRef(identity) {
    const ic = S.icons.get(identity);
    return { icon: ic && ic.icon ? identity : null, iconWhy: ic ? ic.why || null : null };
  }
  function rowOf(g) {
    const mine = g.kind === 'mantle';
    return Object.assign({
      key: g.key, identity: g.identity, name: g.name, file: g.file || null, mem: g.mem, cpu: g.cpu, count: g.count, windows: g.windows, title: g.title, hung: !!g.hung, canReveal: !!g.path,
      kind: g.kind, protected: g.protected, game: g.game, handledBy: g.handledBy, elevated: g.elevated,
      members: S.expanded.has(g.key) ? g.members : null, actions: C.actionsFor(g), state: S.states.get(g.key) || null,
    }, iconRef(mine ? MANTLE_ICON : g.identity));
  }
  function model() {
    const groups = S.built ? S.built.groups : [];
    const t = ticks();
    // the "Get ready to game" rows only while that view is on screen (the page says so on a tab switch)
    const prep = S.view !== 'game' ? [] : C.prepRows(groups, t).map((r) => {
      const ri = S.reopenInfo.get(r.identity);
      return Object.assign(r, iconRef(r.identity), { state: S.states.get(r.key) || null, reopenWhy: r.reopen && ri ? ri.why : null, reopenChecked: !!ri });
    });
    // ticked apps that are not running now still show (so a tick can be taken off)
    const running = new Set(prep.map((r) => r.identity));
    const absent = Object.keys(t).filter((id) => t[id] && t[id].on && !running.has(id)).map((id) => ({ identity: id, name: t[id].name || C.baseName(id), reopen: !!t[id].reopen }));
    const m = S.snap && S.snap.mem;
    return {
      at: Date.now(), test, error: S.error, view: S.view, chord: HAS_CHORD ? CHORD : null,
      mem: m || null, cpu: S.cpuTotal, hist: { cpu: S.hist.cpu.slice(), mem: S.hist.mem.slice() }, cpus: S.snap ? S.snap.cpus : null, method: S.snap ? S.snap.method : null, sampleMs: S.focused ? FOCUSED_MS : BEHIND_MS,
      mantle: S.built && S.built.mantle ? { mem: S.built.mantle.mem, count: S.built.mantle.count, cpu: S.built.mantle.cpu } : null,
      apps: groups.filter((g) => g.kind === 'app').map(rowOf),
      background: groups.filter((g) => g.kind === 'background').map(rowOf),
      windows: groups.filter((g) => g.kind === 'windows').map(rowOf),
      mantleRow: S.built && S.built.mantle ? rowOf(S.built.mantle) : null,
      recent: S.recent,
      prep: { rows: prep, absent, auto: !!ctx.settings.get('autoFree', false), lastFree: S.lastFree, lastAuto: ctx.settings.get('lastAuto', null),
        reopenPending: carry ? { armed: carry.armed, apps: carry.apps.map((a) => a.name), cannot: carry.cannot } : null },
      loaded: !!S.snap,
      look: S.look,
    };
  }
  let lastModel = null;
  function publish() {
    lastModel = model();
    if (S.win && !S.hidden) ctx.push(S.win, 'taskmgr.model', lastModel);
  }
  ctx.replay('taskmgr.model', () => lastModel || model());
  /* the pictures, once each: { [identity]: data URL }. A page that (re)loads gets every one at once. */
  function allIcons() {
    const o = {};
    for (const [id, ic] of S.icons) if (ic.icon) o[id] = ic.icon;
    return o;
  }
  ctx.replay('taskmgr.icons', allIcons);

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
      const why = r.error === 'refused: sidecar is passive (test mode)' ? 'Not closed: this is a test Mantle, which never closes anything' : `Not closed: ${r.error}`;
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
    // A second click (or Delete held down) while the first is still on its way does nothing twice.
    if (S.busy.has(g.key) || (S.pending.has(g.key) && o.action !== 'force')) return { ok: true, already: true, reason: 'Already on it' };
    S.busy.add(g.key);
    try { return await actOn(g, can, dry, o); } finally { S.busy.delete(g.key); }
  }
  async function actOn(g, can, dry, o) {
    if (o.action === 'trim') {
      if (!can.trim) { setState(g.key, { state: 'failed', why: `Not trimmed: ${can.why}` }); publish(); return { ok: false, reason: can.why }; }
      setState(g.key, { state: 'trimming' });
      publish();
      const r = await ctx.sidecar.send('taskmgr.trim', { procs: g.procs, dryRun: dry }, { timeoutMs: 12000 });
      let out;
      if (!r.ok) {
        const why = r.error === 'refused: sidecar is passive (test mode)' ? 'Not trimmed: this is a test Mantle, which never trims anything' : `Not trimmed: ${r.error}`;
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
    // one at a time: a second press (or a game start during a press) must not ask every app twice
    if (S.freeing) return { ok: false, busy: true, reason: 'Already freeing up RAM' };
    S.freeing = true;
    try { return await freeUpNow(o, via); } finally { S.freeing = false; }
  }
  async function freeUpNow(o, via) {
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
    clearTimeout(S.idle);
    S.idle = null;
    const w = S.win;
    S.win = null;
    S.hidden = S.minimized = false;
    S.snap = S.prev = null;           // the table is only needed while it is on screen
    S.expanded.clear();
    S.hist = { cpu: [], mem: [] };
    S.cpuTotal = null;
    if (w && !w.isDestroyed()) w.destroy();
    if (w) ctx.log(`window closed (${why})`);
  }
  /* WARM WINDOW (lane taskmgrfx, measured 2026-09-28): a cold open was 0.8-1.5 s to the first full
     list (up to 4 s on a busy machine), most of it a NEW renderer loading the page. So Close HIDES
     the window: sampling stops at once (schedule() refuses while hidden), and it is destroyed after
     IDLE_MS hidden, at a game's rest, on switch-off and on stop. The hidden page costs its renderer's
     memory for those minutes (measured in the lane report); the next open is one show + one sample. */
  function hideWindow(why) {
    const w = S.win;
    if (!w || w.isDestroyed() || S.hidden) return;
    clearTimeout(S.timer);
    S.timer = null;
    S.hidden = true;
    S.focused = false;
    S.stale = true;                   // kept for the next open's first frame; its CPU column restarts
    if (canShow) w.hide();
    clearTimeout(S.idle);
    S.idle = setTimeout(() => { if (S.hidden) destroyWindow(`hidden for ${Math.round(IDLE / 1000)} s`); }, IDLE);
    if (S.idle && S.idle.unref) S.idle.unref();
    ctx.log(`window hidden (${why}); sampling stopped, destroyed in ${Math.round(IDLE / 1000)} s unless opened again`);
  }
  function saveBounds(w) {
    try { if (!w.isDestroyed() && !w.isMaximized() && !w.isMinimized()) ctx.settings.set('bounds', w.getBounds()); } catch (_) { /* a failed save only loses the size */ }
  }
  /* The saved place is used only while at least 120 x 60 px of its top strip (where it is dragged
     from) is on a monitor that is there now: a window saved on a second monitor that is gone would
     open where nobody can see or grab it. */
  function onScreen(b, screen) {
    if (!b || ![b.x, b.y, b.width, b.height].every(Number.isFinite)) return false;
    let ds = [];
    try { ds = typeof screen.getAllDisplays === 'function' ? screen.getAllDisplays() : [screen.getPrimaryDisplay()]; } catch (_) { return false; }
    return ds.some((d) => {
      const a = d.workArea || d.bounds;
      const w = Math.min(b.x + b.width, a.x + a.width) - Math.max(b.x, a.x);
      const h = Math.min(b.y + 40, a.y + a.height) - Math.max(b.y, a.y);
      return w >= 120 && h >= 20 && b.y >= a.y - 8;
    });
  }
  function createWindow() {
    const BrowserWindow = d.BrowserWindow || electron().BrowserWindow;
    const screen = d.screen || electron().screen;
    let b = ctx.settings.get('bounds', null);
    const wa = screen.getPrimaryDisplay().workArea || screen.getPrimaryDisplay().bounds;
    if (b && !onScreen(b, screen)) b = null;   // its monitor was unplugged or rearranged: centre it again
    if (!b || !(b.width >= MIN_W) || !(b.height >= MIN_H)) b = { width: W, height: H, x: Math.round(wa.x + (wa.width - W) / 2), y: Math.round(wa.y + (wa.height - H) / 2) };
    const hasIcon = exists(ICON_FILE);
    /* GLASS like the taskbar island, without CSS backdrop-filter (a large one measured 27% of a core):
       Windows' own system backdrop. `transparent` stays false, because Electron cannot resize a
       transparent window on Windows and this one must resize; the page paints nothing behind its
       panes (backgroundColor fully clear) so the acrylic shows through. DWM draws a system backdrop on
       the ACTIVE window only (why the never-active bar cannot use it, sidecar/Glass.cs), so it is
       glass while Owen works in it and Windows' calm solid fallback behind other windows, like
       Windows' own apps. The page's --lg-* panes keep every row readable on either. */
    const w = new BrowserWindow({
      show: false, frame: false, transparent: false, backgroundColor: '#00000000', backgroundMaterial: 'acrylic', title: TITLE,
      resizable: true, movable: true, minimizable: true, maximizable: true, fullscreenable: false, skipTaskbar: false,
      width: b.width, height: b.height, x: b.x, y: b.y, minWidth: MIN_W, minHeight: MIN_H,
      icon: hasIcon ? ICON_FILE : undefined,
      webPreferences: { preload: ctx.preload, contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
    });
    wall.attach(w);
    S.look = { material: 'acrylic', icon: hasIcon, iconWhy: hasIcon ? null : `its icon file is not there yet (${path.relative(path.join(__dirname, '..', '..'), ICON_FILE)}), so Windows shows Electron's`, light: null };
    // Its own taskbar group and picture (the AppUserModelID Windows groups and draws the button by).
    if (typeof w.setAppDetails === 'function') {
      try {
        w.setAppDetails(Object.assign({ appId: APP_ID, relaunchDisplayName: TITLE }, hasIcon ? { appIconPath: ICON_FILE, appIconIndex: 0 } : {}));
      } catch (e) { S.look.iconWhy = `Windows refused its app details (${e.message})`; }
    }
    if (!hasIcon) ctx.log(`window icon: ${S.look.iconWhy}`);
    // Light acrylic: Electron follows Windows' dark app mode (Owen's), which tints the backdrop dark
    // under a light page. TaskMgr.cs sets this ONE window's frame light (the sidecar refuses any hwnd
    // that is not Mantle's own); said on the page when it could not.
    const lightFrame = async () => {
      if (w.isDestroyed() || typeof w.getNativeWindowHandle !== 'function') return;
      const buf = w.getNativeWindowHandle();
      const hwnd = buf.length >= 8 ? Number(buf.readBigUInt64LE(0)) : buf.readUInt32LE(0);
      // LIGHT ACRYLIC CALL SITE: sidecar/TaskMgr.cs `taskmgr.frame` (lane taskmgrfx). Lane settingsfx2
      // adds a shared command for the Settings window; if ship time dedupes to theirs, swap this send.
      // lane dm-core (2026-10-08): the frame is MANTLE'S appearance (ctx.host.theme), light or dark, and is
      // asked again when it changes. look.light keeps its old name for the page (ui/taskmgr/taskmgr.js
      // data-frame) but now means "the frame matches the page": false = Windows' other shade, so solid.
      const want = ctx.host && ctx.host.theme ? (ctx.host.theme.get() === 'dark' ? 'dark' : 'light') : 'light';
      const mine = ++frameSeq;
      const r = await ctx.sidecar.send('taskmgr.frame', { hwnd, light: want === 'light' }, { timeoutMs: 3000 });
      if (!S.look || S.win !== w || mine !== frameSeq) return;
      S.look.light = r.ok ? true : false;
      S.look.frame = want;
      S.look.lightWhy = r.ok ? null : `the glass is Windows' ${want === 'dark' ? 'light' : 'dark'} backdrop: the ${want} frame was not set (${r.error})`;
      // dark: no acrylic at all (the page paints the wallpaper on an opaque window), so the frame's shade
      // cannot tint any glass and a refused frame is a log line, not a solid window
      if (want === 'dark') { S.look.material = 'none'; S.look.light = true; S.look.lightWhy = null; } else S.look.material = 'acrylic';
      S.look.hwnd = hwnd;
      if (r.ok && r.result) { S.look.backdrop = r.result.backdrop; S.look.dark = r.result.dark; }   // DWM's own read-back (3 = acrylic)
      if (!r.ok) ctx.log(`light frame: not set (${r.error})`);
      publish();
    };
    S.reframe = lightFrame;           // Mantle's appearance changed: ask again (install's theme.onChange)
    lightFrame();
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
    w.on('minimize', () => { S.minimized = true; clearTimeout(S.timer); S.timer = null; });
    w.on('restore', () => { if (!S.minimized) return; S.minimized = false; sample().then(schedule); });
    w.on('show', () => { lightFrame(); timing.shown(w); });
    // Alt+F4 / the taskbar's Close: hidden like the X button, unless Mantle is quitting or stopping.
    w.on('close', (e) => { if (S.win === w && !S.quitting && !S.stopped) { e.preventDefault(); hideWindow('closed'); } });
    let bt = null;
    const later = () => { clearTimeout(bt); bt = setTimeout(() => saveBounds(w), 600); };
    w.on('resize', later);
    w.on('move', later);
    w.on('closed', () => { if (S.win === w) { S.win = null; clearTimeout(S.timer); S.timer = null; clearTimeout(S.idle); S.idle = null; S.hidden = S.minimized = false; S.snap = S.prev = null; } });
    w.loadFile(ctx.page('index.html'));
    return w;
  }

  async function open(a) {
    // 'startup' (the old third tab) opens Apps: startup apps live in Mantle Settings, one click from More
    const view = a && a.view === 'game' ? 'game' : 'apps';
    if (S.stopped) return { ok: false, reason: 'the task manager is stopped' };
    if (!ctx.enabled()) return { ok: false, reason: "Mantle's task manager is switched off in the tray menu; Windows' Task Manager still works (Ctrl+Shift+Esc)" };
    S.view = view;
    const fresh = !S.win || S.win.isDestroyed();
    const warm = !fresh && S.hidden;
    const via = (a && typeof a.via === 'string' && a.via.slice(0, 60)) || 'a page';
    if (fresh) {
      timing.start('cold', via, ` (view ${view})`);
      S.win = createWindow();
      if (S.crashed) { S.crashed = null; ctx.health(true); }
      const w0 = S.win;
      w0.once('ready-to-show', () => {
        if (S.win !== w0 || w0.isDestroyed()) return;
        if (!canShow) { timing.testReady(); return; }
        wall.hold(w0, () => { if (S.win === w0 && !w0.isDestroyed()) { w0.show(); if (!test) w0.focus(); } });   // dark: the wallpaper baked first (lane helm-wall)
      });
    } else {
      clearTimeout(S.idle);
      S.idle = null;
      S.hidden = false;
      if (warm) timing.start('warm', via, ` (view ${view})`);
      if (canShow) {
        if (S.win.isMinimized()) S.win.restore();
        S.win.show();
        if (!test) S.win.focus();
      } else if (warm) timing.testReady();
      S.minimized = false;
    }
    publish();                         // a warm page shows its last list at once; the sample refreshes it
    ctx.push(S.win, 'taskmgr.view', { view });
    await sample();
    pumpIcons();
    schedule();
    return { ok: true, view, created: fresh, warm, shown: canShow, hwnd: S.look && S.look.hwnd || null };
  }

  /* ---- commands ------------------------------------------------------------------------------ */
  ctx.command('open', open);
  ctx.command('state', async () => model());
  ctx.command('view', async (a) => { S.view = a && a.view === 'game' ? 'game' : 'apps'; publish(); return { ok: true, view: S.view }; });
  // A row's processes travel only while the page has that row open (the compact model, above).
  ctx.command('expand', async (a) => {
    const key = String(a && a.key || '');
    // only a row that exists now (a page cannot grow this set with made-up keys)
    if (a && a.open && S.built && S.built.byKey.has(key)) S.expanded.add(key); else S.expanded.delete(key);
    publish();
    return { ok: true, key, open: S.expanded.has(key) };
  });
  ctx.command('act', act);
  ctx.command('free', (a) => freeUp(a, 'button'));
  ctx.command('tick', async (a) => {
    const o = a || {};
    const id = String(o.identity || '');
    const g = S.built && S.built.groups.find((x) => x.identity === id);
    const t = ticks();
    const had = Object.prototype.hasOwnProperty.call(t, id);   // own keys only: never '__proto__' and friends
    if (!id || id.length > 1024) return { ok: false, reason: 'that app is not in the list' };
    if (g && C.tickWhy(g)) return { ok: false, reason: C.tickWhy(g) };
    if (!g && !had) return { ok: false, reason: 'that app is not running and was never ticked' };
    const rec = Object.assign({ on: false, reopen: false, name: g ? g.name : id }, had ? t[id] : {});
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
    if (!w || w.isDestroyed() || S.hidden) return { ok: false, reason: 'the window is not open' };
    if (op === 'close') { hideWindow('closed by its button'); return { ok: true, hidden: true }; }
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
  /* "Open file location" (a row's menu): Explorer with its exe selected. By row key only: the path
     is main's own (from the snapshot), never one a page sends. */
  ctx.command('reveal', async (a) => {
    const g = S.built && S.built.byKey.get(String(a && a.key || ''));
    if (!g) return { ok: false, reason: 'That app is no longer running.' };
    if (!g.path) return { ok: false, reason: "Windows didn't let Mantle see where this app's file is (it runs as administrator or is part of Windows)." };
    if (test) return { ok: true, dryRun: true, reason: 'Test Mantle: File Explorer was not opened.' };
    /* Owen's file window is Mantle Files (Win+E): a FILE path opens its folder with the file selected
       (lib/features/files.js openWindow). File Explorer only when Files is off or could not open, and
       the page says so. */
    let why = null;
    if (app && typeof app.listenerCount === 'function' && app.listenerCount('mantle-open:files') > 0) {
      const reply = {};
      try { app.emit('mantle-open:files', { path: g.path, via: 'the task manager', reply }); } catch (e) { reply.reason = e.message; }
      if (reply.handled && reply.ok) { ctx.log(`open file location: pid ${g.root} in Mantle Files`); return { ok: true, in: 'files' }; }
      why = `Mantle Files did not open (${reply.reason || 'it did not answer'})`;
    } else why = 'Mantle Files is switched off';
    try {
      const shell = d.shell || electron().shell;
      shell.showItemInFolder(g.path);
      ctx.log(`open file location: pid ${g.root} in File Explorer`);
      return { ok: true, in: 'explorer', reason: `${why}, so it opened in File Explorer.` };
    } catch (e) { return { ok: false, reason: `${why}, and File Explorer did not open either (${e.message}).` }; }
  });
  ctx.command('sample', async () => { const b = await sample(); return b ? { ok: true, groups: b.groups.length } : { ok: false, reason: S.error }; });

  if (HAS_CHORD) ctx.onChord(CHORD, () => { open({ view: 'apps', via: CHORD }); });

  /* the launcher's "Mantle Task Manager" rows (lib/launcher-index.js MANTLE_TARGETS: mantle:taskmgr) */
  const app = d.app || (d.electron ? d.electron.app : (() => { try { return electron().app; } catch (_) { return null; } })());
  const onOpen = (target) => { if (target === 'taskmgr' || target === 'taskmgr:game') open({ view: target === 'taskmgr:game' ? 'game' : 'apps', via: 'the launcher' }); };
  /* 'mantle-open:taskmgr' (view) is listened to ONLY while the feature is on and awake, so a launcher
     that checks app.listenerCount('mantle-open:taskmgr') can say "off or resting" instead of doing
     nothing (the shared 'mantle-open' always has wallpaper.js listening, so its emit() is always true). */
  const onOwn = (view) => { open({ view: view === 'game' ? 'game' : 'apps', via: 'mantle-open' }); };
  // Quitting: the window's close is not turned into a hide (that would hold the quit up).
  if (app && typeof app.once === 'function') app.once('before-quit', () => { S.quitting = true; });
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
      if (!resting) wall.stop();
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

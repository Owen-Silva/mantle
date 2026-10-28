'use strict';
/*
 * taskmgr.js - Mantle's task manager, RAM first (lane taskmgr, 2026-09-28).
 *
 * WHY: the user opens Windows' Task Manager for one job: free RAM before and while he plays Valorant
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
 * THE RULES (the user's):
 *   - By pid + creation time, never by image name (sidecar/TaskMgr.cs holds a handle while acting).
 *   - Close = WM_CLOSE to its windows, else taskkill without /F. Force = /F, only after the confirm
 *     in the window (act() refuses a force without `confirmed`).
 *   - Protected rows (Windows, Explorer, Mantle, Lively, anti-cheat) offer nothing and say why;
 *     games are listed and closable but never trimmed. The sidecar refuses them a second time.
 *   - Nothing closes by itself unless the user turned "when a game starts" on AND ticked the app.
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
const M = require('./_taskmgr-model.js');
const A = require('./_taskmgr-admin.js');
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
const SHOW_BY_MS = 300;               // a cold page that has not painted by then is shown on its plain ground
const PREWARM_MS = 60 * 1000;         // keep ready: made this long after start, once the CPU is calm
const PREWARM_ON_MS = 2000;           // keep ready just turned on
const PREWARM_RETRY_MS = 30 * 1000;
const PREWARM_BUSY = 0.6;
const PREWARM_TRIES = 6;
/* Its own picture in the taskbar, Alt+Tab and the bar (the user: "they need to have there own icons that
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
  /* FAST COLD, NOTHING KEPT (lane settingsfast, 2026-10-15; the user: "i need to save ram"): close DESTROYS the
     window unless keep ready is on (lib/keep-ready.js 'taskmgr', off by default; then ONE hidden window, made
     PREWARM_MS after start once the CPU is calm, kept with no time limit until a game). A cold open shows at
     its first paint with the last list and memory Mantle saw (kept in main, no window needed), the dark
     wallpaper waits at most WW.COLD_HOLD_MS, and an unpainted page is shown anyway SHOW_BY_MS after the open. */
  const KR = d.keepReady || require('../keep-ready.js');
  const keepOn = () => { try { return KR.get('taskmgr') === true; } catch (_) { return false; } };
  let prewarmTimer = null, prewarmTries = 0;
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
  const S = {
    win: null, view: 'processes', timer: null, snap: null, prev: null, built: null, error: null, focused: false, sampling: false,
    icons: new Map(), iconQueue: [], states: new Map(), pending: new Map(), recent: [], lastFree: null, reopenInfo: new Map(),
    stopped: false, crashed: null,
    expanded: new Set(), hidden: false, minimized: false, idle: null, quitting: false, look: null,
    cpuTotal: null, hist: { cpu: [], mem: [] }, busy: new Set(),
    io: new Map(), x: {},          // lane tm-data: disk rates per process key; x = the per-view extra samples
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
    S.io = M.ioRates(S.prev, S.snap);
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
    const every = M.tickMs(tmSettings(), S.focused, BEHIND_MS);
    if (!every) return;                // Settings > Real time update speed: Paused
    S.timer = setTimeout(async () => {
      S.timer = null;
      if (!S.win || S.stopped || S.hidden || S.minimized) return;
      // a throw here must never end the sampling for good (the window would freeze on old numbers)
      try { await sample(); await sampleExtras(); publish(); await pumpIcons(); } catch (e) { ctx.log(`sample failed: ${e && e.message}`); }
      schedule();
    }, every);
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
    }, M.rowExtras(g, { snap: S.snap, io: S.io, gpu: S.x.gpu || null, extra: S.x.extra || null }), iconRef(mine ? MANTLE_ICON : g.identity));
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
      mem: m || S.memSeen || null, cpu: S.cpuTotal, hist: { cpu: S.hist.cpu.slice(), mem: S.hist.mem.slice() }, cpus: S.snap ? S.snap.cpus : null, method: S.snap ? S.snap.method : null, sampleMs: M.tickMs(tmSettings(), S.focused, BEHIND_MS),
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
      // lane tm-data (TM-SPEC.md): header totals, the pages' data (each only while its page is on screen), settings
      totals: M.totals({ cpu: S.cpuTotal, mem: m, disk: S.x.perf ? S.x.perf.diskPct : null, net: S.x.perf ? S.x.perf.netPct : null, gpu: S.x.gpu ? S.x.gpu.pct : null }),
      perf: perfModel(),
      startup: S.view === 'startup' ? S.x.startup || { biosSec: null, rows: [], error: null, loading: true } : null,
      details: S.view === 'details' ? S.x.details || { rows: [], error: null, loading: true } : null,
      services: S.view === 'services' ? S.x.services || { rows: [], error: null, loading: true } : null,
      users: S.view === 'users' ? S.x.users || { rows: [], error: null, loading: true } : null,
      apphistory: S.view === 'apphistory' ? appHistoryModel() : null,
      settings: tmSettings(),
      admin: { elevated: A.hasElevated() },
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

  /** Is this app reopenable? Asked when the user ticks "reopen", so the answer is on screen before the game. */
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
    // the next cold open's first frame: the last list (S.built stays) and the last memory reading
    if (S.snap && S.snap.mem) S.memSeen = S.snap.mem;
    S.snap = S.prev = null;           // the raw sample is only needed while it is on screen
    S.expanded.clear();
    S.hist = { cpu: [], mem: [] };
    S.cpuTotal = null;
    if (w && !w.isDestroyed()) w.destroy();
    if (w) ctx.log(`window closed (${why})`);
  }
  /* CLOSE (lane settingsfast, 2026-10-15): destroys the window, unless keep ready is on; then it HIDES
     (sampling stops at once, schedule() refuses while hidden) with no time limit, and is destroyed at a
     game's rest, on switch-off, on stop and when keep ready goes off. The old 3-minute hidden keep
     (lane taskmgrfx) held ~50 MB after every close for an open that rarely came in time: gone. */
  function hideWindow(why) {
    const w = S.win;
    if (!w || w.isDestroyed() || S.hidden) return;
    // keep ready off (the default): closing destroys it, its memory goes back at once (lane settingsfast)
    if (!keepOn()) { destroyWindow(`${why}; nothing kept in memory`); return; }
    clearTimeout(S.timer);
    S.timer = null;
    S.hidden = true;
    S.focused = false;
    S.stale = true;                   // kept for the next open's first frame; its CPU column restarts
    if (canShow) w.hide();
    clearTimeout(S.idle);
    S.idle = null;
    ctx.log(`window hidden (${why}); sampling stopped, kept for the next open (keep ready is on)`);
  }
  /* KEEP READY: the hidden window made ahead, after start and after a game (install runs again), once calm. */
  function cpuBusy(ms) {
    if (d.cpuBusy) return Promise.resolve(d.cpuBusy());
    const os = require('os');
    const t = () => os.cpus().reduce((a, c) => { const v = c.times; a.idle += v.idle; a.all += v.user + v.nice + v.sys + v.idle + v.irq; return a; }, { idle: 0, all: 0 });
    const a = t();
    return new Promise((res) => { const tm = setTimeout(() => { const b = t(); res(b.all > a.all ? 1 - (b.idle - a.idle) / (b.all - a.all) : 0); }, ms); if (tm.unref) tm.unref(); });
  }
  function prewarmSoon(ms) {
    clearTimeout(prewarmTimer);
    prewarmTimer = null;
    if (S.stopped || !keepOn() || !ctx.enabled() || S.win) return;
    prewarmTimer = setTimeout(async () => {
      prewarmTimer = null;
      if (S.stopped || !keepOn() || !ctx.enabled() || S.win) return;
      const busy = await cpuBusy(1000);
      if (S.stopped || !keepOn() || !ctx.enabled() || S.win) return;
      if (busy > PREWARM_BUSY && prewarmTries < PREWARM_TRIES) { prewarmTries++; prewarmSoon(d.prewarmRetryMs || PREWARM_RETRY_MS); return; }
      prewarmTries = 0;
      try {
        S.win = createWindow();
        S.hidden = true;
        S.stale = true;
        ctx.log(`window made ahead and kept hidden: keep ready is on (about ${KR.SURFACES ? KR.SURFACES.taskmgr.mb : 35} MB while it waits)`);
      } catch (e) { S.win = null; S.hidden = false; ctx.log(`the window could not be made ahead (${e && e.message}); it is made when asked`); }
    }, ms);
    if (prewarmTimer.unref) prewarmTimer.unref();
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
       glass while the user works in it and Windows' calm solid fallback behind other windows, like
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
    // Light acrylic: Electron follows Windows' dark app mode (the user's), which tints the backdrop dark
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
    w.on('minimize', () => {
      S.minimized = true; clearTimeout(S.timer); S.timer = null;
      // Settings > Hide when minimized: back to the bar's entry, like the X (kept warm)
      if (tmSettings().hideWhenMinimized && !S.quitting) setImmediate(() => { if (S.win === w && !w.isDestroyed()) { w.restore(); hideWindow('hidden when minimized (Settings)'); } });
    });
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
    const view = M.normView(a && a.view);
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
      let up = false;
      const showIt = () => { if (up || S.win !== w0 || w0.isDestroyed() || S.hidden) return; up = true; w0.show(); if (!test) w0.focus(); };
      w0.once('ready-to-show', () => {
        if (S.win !== w0 || w0.isDestroyed()) return;
        if (!canShow) { timing.testReady(); return; }
        wall.hold(w0, showIt, WW.COLD_HOLD_MS);   // dark: the wallpaper gets at most 50 ms, else it swaps in after
      });
      if (canShow) {
        const by = d.showByMs || SHOW_BY_MS;
        const t = setTimeout(() => {
          if (up || S.win !== w0 || w0.isDestroyed() || S.hidden) return;
          ctx.log(`its page had not drawn ${by} ms after the open, so the window shows on its plain ground and the page fills in`);
          showIt();
        }, by);
        if (t.unref) t.unref();
      }
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
    applyWindowSettings();
    await sample();
    await sampleExtras(true);
    publish();
    pumpIcons();
    schedule();
    return { ok: true, view, created: fresh, warm, shown: canShow, hwnd: S.look && S.look.hwnd || null };
  }

  /* ==== lane tm-data (TM-SPEC.md): settings, the pages' own samples, and their commands ======== */
  const optional = (m) => { try { return require(m); } catch (_) { return null; } };
  const tmSettings = () => M.settingsOf(ctx.settings.get('tm', null));
  const STARTUP_EVERY_MS = 10000, SERVICES_EVERY_MS = 3000;
  const pad60 = (a) => { const x = (a || []).slice(-HIST); while (x.length < HIST) x.unshift(null); return x; };
  const lastAt = {};
  const due = (k, ms) => { const now = Date.now(); if (lastAt[k] && now - lastAt[k] < ms) return false; lastAt[k] = now; return true; };

  /** The per-page samples: only the page on screen pays, and nothing runs while the window is hidden. */
  async function sampleExtras(force) {
    if (!S.snap || !S.win || S.hidden || S.minimized) return;
    const v = S.view;
    const jobs = [readPerf(v === 'performance')];
    if (v === 'processes' || v === 'performance' || v === 'users') jobs.push(readGpu(v === 'performance'));
    else S.x.gpu = null;
    if (v === 'processes') jobs.push(readExtra());
    if (v === 'details') jobs.push(readDetails());
    if (v === 'services' && (force || due('services', SERVICES_EVERY_MS))) jobs.push(readServices());
    if (v === 'startup' && (force || due('startup', STARTUP_EVERY_MS))) jobs.push(readStartup());
    if (v === 'users') jobs.push(readUsers());
    await Promise.all(jobs.map((j) => j.catch((e) => ctx.log(`a page sample failed: ${e && e.message}`))));
  }
  const sidecarWhy = (r, what) => (r && r.reason) || `${what} could not be read`;

  async function readPerf(full) {
    const r = await A.call(ctx, 'taskmgr.perf', { full, cores: full }, { timeoutMs: 4000, retry: false });
    if (!r.ok) { S.x.perf = { error: sidecarWhy(r, 'the performance counters'), diskPct: null, netPct: null }; return; }
    const P = optional('./_taskmgr-perf.js');
    S.x.perfRaw = r.result;
    S.x.perf = { raw: r.result, error: null, diskPct: r.result.totals ? r.result.totals.disk : null, netPct: r.result.totals ? r.result.totals.net : null, P };
  }
  async function readGpu(full) {
    const r = await A.call(ctx, 'taskmgr.gpu', { full }, { timeoutMs: 4000, retry: false });
    S.x.gpu = r.ok ? { byPid: r.result.byPid || {}, pct: r.result.totals ? r.result.totals.gpu : null, raw: r.result, why: null } : { byPid: null, pct: null, why: sidecarWhy(r, 'GPU use') };
  }
  async function readExtra() {
    const procs = (S.built ? S.built.groups : []).map((g) => ({ pid: g.root, created: g.created }));
    if (!procs.length) return;
    const r = await A.call(ctx, 'taskmgr.procextra', { procs }, { timeoutMs: 4000, retry: false });
    const m = new Map();
    if (r.ok && r.result && Array.isArray(r.result.rows)) for (const x of r.result.rows) m.set(`${x.pid}|${x.created}`, x);
    S.x.extra = m;
  }
  async function readDetails() {
    const D = optional('./_taskmgr-details.js');
    const r = await A.call(ctx, 'taskmgr.details', {}, { timeoutMs: 5000, retry: false });
    if (r.ok && D && typeof D.rowsFrom === 'function') {
      const prev = S.x.detailsRaw || null;
      S.x.detailsRaw = r.result;
      S.x.details = { rows: D.rowsFrom(r.result, prev, { fullAccountName: tmSettings().fullAccountName }), error: null };
      return;
    }
    // Before the Details reader (or when it fails): the snapshot's own columns, said so.
    const cpu = C.cpuMap(S.prev, S.snap);
    S.x.details = {
      rows: S.snap.procs.filter((p) => p.pid > 0).map((p) => ({
        pid: p.pid, created: p.created, name: p.file, status: p.hung > 0 && p.hung >= p.windows ? 'Not responding' : p.suspended ? 'Suspended' : 'Running',
        user: null, cpu: Math.round((cpu.get(C.keyOf(p)) || 0) * 10) / 10, mem: Math.max(0, p.pws || 0), arch: null, desc: p.desc || null, path: p.path || null,
        sessionId: p.session, handles: p.handles, threads: p.threads,
      })),
      error: r.ok ? null : `only the basic columns: ${sidecarWhy(r, 'the Details columns')}`,
    };
  }
  async function readServices() {
    const r = await A.call(ctx, 'taskmgr.services', {}, { timeoutMs: 8000, retry: false });
    S.x.services = r.ok ? { rows: r.result.rows || [], error: null, elevated: !!r.result.elevated } : { rows: (S.x.services && S.x.services.rows) || [], error: sidecarWhy(r, 'the services'), needsAdmin: !!r.needsAdmin };
  }
  async function readStartup() {
    const r = await A.call(ctx, 'startup.list', {}, { timeoutMs: 6000, retry: false });
    if (!r.ok) { S.x.startup = { biosSec: null, rows: [], error: sidecarWhy(r, 'the startup apps') }; return; }
    const items = Array.isArray(r.result.items) ? r.result.items : [];
    const commands = Array.from(new Set(items.map((i) => i.command).filter((c) => typeof c === 'string' && c))).slice(0, 256);
    const mr = commands.length ? await A.call(ctx, 'taskmgr.startupmeta', { commands }, { timeoutMs: 6000, retry: false }) : { ok: true, result: { rows: [] } };
    const meta = mr.ok ? mr.result : null;
    S.x.startup = {
      biosSec: meta && typeof meta.biosSec === 'number' ? meta.biosSec : null,
      rows: M.startupRows(items, meta, M.runningPaths(S.snap)),
      error: (Array.isArray(r.result.problems) && r.result.problems.length ? r.result.problems.join('; ') : null) || (mr.ok ? null : `publisher and impact unknown: ${sidecarWhy(mr, 'the startup details')}`),
      why: { impact: (meta && meta.why && meta.why.impact) || 'Windows measures startup impact itself and keeps it for administrators' },
    };
  }
  async function readUsers() {
    const r = await A.call(ctx, 'taskmgr.users', {}, { timeoutMs: 4000, retry: false });
    S.x.users = r.ok
      ? { rows: M.usersRows(r.result.rows, S.snap, C.cpuMap(S.prev, S.snap), S.io, tmSettings().fullAccountName), error: null }
      : { rows: [], error: sidecarWhy(r, 'the signed-in users') };
  }

  /** model.perf: cpu + mem always (from the snapshot, enriched by taskmgr.perf), devices on Performance only. */
  function perfModel() {
    if (!S.snap) return null;
    const m = S.snap.mem || {};
    const raw = S.x.perf && S.x.perf.raw || {};
    const rc = raw.cpu || {}, rm = raw.mem || {};
    const base = {
      cpu: Object.assign({ name: null, speedGHz: null, baseGHz: null, sockets: null, cores: null, virtualization: null, l1KB: null, l2KB: null, l3KB: null, kernelPct: null },
        rc, { pct: S.cpuTotal, hist: pad60(S.hist.cpu), logical: S.snap.cpus, procs: S.snap.procs.length, threads: S.snap.threads == null ? null : S.snap.threads,
          handles: S.snap.handles == null ? null : S.snap.handles, uptimeSec: S.snap.uptimeSec == null ? null : S.snap.uptimeSec }),
      mem: Object.assign({ cached: null, pagedPool: null, nonPagedPool: null, compressed: null, composition: null, speedMTs: null, slotsUsed: null, slotsTotal: null, formFactor: null, hardwareReserved: null },
        rm, { total: m.total || null, used: m.used || null, avail: m.avail || null, committed: m.commit || null, commitLimit: m.commitLimit || null, hist: pad60(S.hist.mem) }),
      disks: null, nets: null, gpus: null,
      error: S.x.perf ? S.x.perf.error : null,
    };
    if (S.view !== 'performance') return base;
    const P = S.x.perf && S.x.perf.P;
    if (P && typeof P.shape === 'function' && S.x.perf.raw) {
      try { Object.assign(base, P.shape(S.x.perf.raw, perfHist, { cpuPct: S.cpuTotal })); } catch (e) { base.error = `the performance page data failed (${e.message})`; }
    } else if (S.x.perf && S.x.perf.raw) { base.disks = raw.disks || null; base.nets = raw.nets || null; }
    const G = optional('./_taskmgr-gpu.js');
    if (G && typeof G.shape === 'function' && S.x.gpu && S.x.gpu.raw) {
      try { base.gpus = G.shape(S.x.gpu.raw, gpuHist); } catch (e) { base.error = `the GPU data failed (${e.message})`; }
    } else if (S.x.gpu && S.x.gpu.raw) base.gpus = S.x.gpu.raw.gpus || null;
    return base;
  }
  const perfHist = (() => { const P = optional('./_taskmgr-perf.js'); return P && typeof P.makeHistory === 'function' ? P.makeHistory() : null; })();
  const gpuHist = (() => { const G = optional('./_taskmgr-gpu.js'); return G && typeof G.makeHistory === 'function' ? G.makeHistory() : null; })();

  /* App history: Mantle's own record until an elevated path can read Windows' (SRUM). */
  const H = optional('./_taskmgr-history.js');
  const historyFile = d.historyFile || (ctx.settings && typeof ctx.settings.file === 'string' ? path.join(path.dirname(ctx.settings.file), 'taskmgr-history.json') : null);
  const history = H && typeof H.create === 'function' && historyFile
    ? (() => { try { return H.create({ file: historyFile }); } catch (e) { ctx.log(`app history could not start (${e.message})`); return null; } })()
    : null;
  function appHistoryModel() {
    if (!history) return { since: null, rows: [], source: null, error: "App history is not recording yet: Windows keeps it for administrators, and Mantle's own record is not set up" };
    try { return history.model({ allProcesses: tmSettings().historyAllProcesses }); } catch (e) { return { since: null, rows: [], source: 'mantle', error: e.message }; }
  }

  /* ---- the window behaviours from Settings --------------------------------------------------- */
  function applyWindowSettings() {
    const w = S.win;
    if (!w || w.isDestroyed()) return;
    try { w.setAlwaysOnTop(!!tmSettings().alwaysOnTop); } catch (_) { /* gone */ }
  }

  /* ---- commands (every destructive one: dryRun in --test, whatever the page asked) ----------- */
  const dryOf = (a) => test || !!(a && a.dryRun);
  /** pid (+ created) -> the process as the latest snapshot saw it; created must match when given. */
  function procOf(a) {
    const pid = Number(a && a.pid);
    if (!S.snap || !Number.isInteger(pid) || pid <= 0) return null;
    const p = S.snap.procs.find((x) => x.pid === pid);
    if (!p) return null;
    if (a.created !== undefined && String(a.created) !== String(p.created)) return null;
    return p;
  }
  const gone = { ok: false, reason: 'That process is no longer running (or its number now belongs to a different process).' };
  const pass = (verb, extra, timeoutMs) => async (a) => {
    const p = procOf(a);
    if (!p) return gone;
    const r = await A.call(ctx, verb, Object.assign({ pid: p.pid, created: p.created, dryRun: dryOf(a), confirmed: !!(a && a.confirmed) }, extra ? extra(a || {}) : {}), { timeoutMs: timeoutMs || 8000 });
    if (!r.dryRun) sample().then(() => sampleExtras()).then(publish, () => {});
    // needsConfirm + confirm (Windows' own warning text) pass through: the page shows it and resends with confirmed:true
    return Object.assign({}, r.result || {}, { ok: r.ok, reason: r.reason || (r.result && r.result.reason) || null, needsAdmin: !!r.needsAdmin, needsConfirm: !!(r.result && r.result.needsConfirm), dryRun: !!(r.dryRun || dryOf(a)) });
  };
  ctx.command('setting', async (a) => {
    const v = M.validateSetting(a && a.key, a && a.value);
    if (!v.ok) return v;
    const cur = Object.assign({}, ctx.settings.get('tm', null) || {});
    cur[a.key] = v.value;
    try { ctx.settings.set('tm', cur); } catch (e) { return { ok: false, reason: `not saved: ${e.message}` }; }
    if (a.key === 'alwaysOnTop') applyWindowSettings();
    if (a.key === 'updateSpeed') schedule();
    publish();
    return { ok: true, key: a.key, value: v.value };
  });
  ctx.command('refresh', async () => { const b = await sample(); await sampleExtras(true); publish(); return b ? { ok: true } : { ok: false, reason: S.error }; });
  ctx.command('endPid', pass('taskmgr.endpid', (a) => ({ tree: !!a.tree, force: !!a.force }), 12000));
  ctx.command('priority', pass('taskmgr.priority', (a) => ({ cls: String(a.cls || '') })));
  ctx.command('affinity', pass('taskmgr.affinity', (a) => ({ mask: String(a.mask || '') })));
  ctx.command('affinityGet', pass('taskmgr.affinityget'));
  ctx.command('waitChain', pass('taskmgr.waitchain', null, 10000));
  ctx.command('uacVirt', pass('taskmgr.uacvirt', (a) => ({ on: !!a.on })));
  ctx.command('dump', pass('taskmgr.dump', null, 120000));
  ctx.command('efficiency', async (a) => {
    // by key (a Processes row: its root process) or by pid (Details)
    const g = a && a.key && S.built ? S.built.byKey.get(String(a.key)) : null;
    const args = g ? { pid: g.root, created: g.created } : { pid: a && a.pid, created: a && a.created };
    return pass('taskmgr.efficiency', () => ({ on: !!(a && a.on) }))(Object.assign({}, a, args));
  });
  ctx.command('restartExplorer', async (a) => {
    const r = await A.call(ctx, 'taskmgr.restartexplorer', { dryRun: dryOf(a) }, { timeoutMs: 15000 });
    return Object.assign({}, r.result || {}, { ok: r.ok, reason: r.reason || null, needsAdmin: !!r.needsAdmin, dryRun: dryOf(a) });
  });
  ctx.command('runTask', async (a) => {
    const cmd = typeof (a && a.cmd) === 'string' ? a.cmd.trim() : '';
    if (!cmd) return { ok: false, reason: 'Type the name of a program, folder, document or Internet resource.' };
    if (cmd.length > 2048) return { ok: false, reason: 'That command is too long.' };
    // the page's {cmd} is the sidecar's {line} (sidecar/ProcOps.cs RunTask)
    const r = await A.call(ctx, 'taskmgr.runtask', { line: cmd, admin: !!a.admin, dryRun: dryOf(a) }, { timeoutMs: 60000, retry: false });
    return Object.assign({}, r.result || {}, { ok: r.ok, reason: r.reason || null, dryRun: dryOf(a) });
  });
  ctx.command('service', async (a) => {
    const name = typeof (a && a.name) === 'string' ? a.name : '';
    const op = a && a.op;
    if (!name || name.length > 256) return { ok: false, reason: 'say which service' };
    if (!['start', 'stop', 'restart'].includes(op)) return { ok: false, reason: 'a service can be started, stopped or restarted' };
    const r = await A.call(ctx, 'taskmgr.service', { name, op, dryRun: dryOf(a) }, { timeoutMs: 10000 });
    if (r.ok && !dryOf(a)) setTimeout(() => readServices().then(publish, () => {}), 1500);
    return Object.assign({}, r.result || {}, { ok: r.ok, reason: r.needsAdmin ? 'needs administrator: open Services' : r.reason || null, needsAdmin: !!r.needsAdmin, dryRun: dryOf(a) });
  });
  ctx.command('goToServices', async (a) => {
    const p = procOf(a);
    if (!p) return gone;
    const r = await A.call(ctx, 'taskmgr.servicesByPid', { pid: p.pid }, { timeoutMs: 6000, retry: false });
    return r.ok ? { ok: true, names: r.result.names || [] } : { ok: false, reason: r.reason };
  });
  const launch = (what, exe, args) => {
    if (test) return { ok: true, dryRun: true, reason: `test mode: would run ${exe}` };
    try { spawn(exe, args || [], { detached: true, stdio: 'ignore' }).unref(); return { ok: true }; } catch (e) { return { ok: false, reason: `${what} did not start: ${e.message}` }; }
  };
  const sys32 = (f) => path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', f);
  ctx.command('openServices', async () => launch('Services', sys32('mmc.exe'), [sys32('services.msc')]));
  ctx.command('openResmon', async () => launch('Resource Monitor', sys32('resmon.exe')));
  ctx.command('manageUsers', async () => {
    if (test) return { ok: true, dryRun: true, reason: 'test mode: would open ms-settings:otherusers' };
    try { await (d.shell || electron().shell).openExternal('ms-settings:otherusers'); return { ok: true }; } catch (e) { return { ok: false, reason: e.message }; }
  });
  ctx.command('searchOnline', async (a) => {
    const name = String(a && a.name || '').slice(0, 200).trim();
    if (!name) return { ok: false, reason: 'nothing to search for' };
    const url = `https://www.bing.com/search?q=${encodeURIComponent(name)}`;   // Windows' Task Manager searches with Bing
    if (test) return { ok: true, dryRun: true, url };
    try { await (d.shell || electron().shell).openExternal(url); return { ok: true, url }; } catch (e) { return { ok: false, reason: e.message }; }
  });
  /** A path the page may act on: only one Mantle itself read (a running process or a startup entry). */
  function knownPath(p) {
    const want = String(p || '').toLowerCase();
    if (!want) return null;
    const hit = (S.snap ? S.snap.procs : []).find((x) => x.path && x.path.toLowerCase() === want)
      || ((S.x.startup && S.x.startup.rows) || []).find((x) => x.path && x.path.toLowerCase() === want)
      || ((S.x.details && S.x.details.rows) || []).find((x) => x.path && x.path.toLowerCase() === want);
    return hit ? hit.path : null;
  }
  ctx.command('properties', async (a) => {
    const p = knownPath(a && a.path);
    if (!p) return { ok: false, reason: 'Mantle only opens Properties for a file it saw running or starting.' };
    const r = await A.call(ctx, 'taskmgr.properties', { path: p, dryRun: test }, { timeoutMs: 6000, retry: false });
    return { ok: r.ok, reason: r.reason || null, dryRun: test };
  });
  ctx.command('openLocation', async (a) => {
    const p = knownPath(a && a.path);
    if (!p) return { ok: false, reason: 'Mantle only opens the location of a file it saw running or starting.' };
    if (test) return { ok: true, dryRun: true, reason: 'Test Mantle: File Explorer was not opened.' };
    try { (d.shell || electron().shell).showItemInFolder(p); return { ok: true }; } catch (e) { return { ok: false, reason: e.message }; }
  });
  ctx.command('startupSet', async (a) => {
    const item = typeof (a && a.item) === 'string' ? a.item : '';
    if (!item) return { ok: false, reason: 'say which startup app' };
    const r = await A.call(ctx, 'startup.set', { item, on: !!a.enabled, dryRun: dryOf(a) }, { timeoutMs: 6000 });
    if (r.ok && !dryOf(a)) readStartup().then(publish, () => {});
    const x = r.result || {};
    return { ok: r.ok && !x.wouldRefuse, reason: x.wouldRefuse || r.reason || null, needsAdmin: !!(r.needsAdmin || x.wouldRefuse), dryRun: dryOf(a), item: x.item || null };
  });
  const userOp = (op) => async (a) => {
    const session = Number(a && a.session);
    if (!Number.isInteger(session) || session < 0) return { ok: false, reason: 'say which user session' };
    const r = await A.call(ctx, 'taskmgr.userop', { session, op, dryRun: dryOf(a) }, { timeoutMs: 8000 });
    return Object.assign({}, r.result || {}, { ok: r.ok, reason: r.reason || null, needsAdmin: !!r.needsAdmin, dryRun: dryOf(a) });
  };
  ctx.command('userDisconnect', userOp('disconnect'));
  ctx.command('userConnect', userOp('connect'));
  ctx.command('userSignOff', userOp('signoff'));
  ctx.command('clearHistory', async () => {
    if (!history) return { ok: false, reason: 'there is no usage history to delete' };
    try { history.clear(); publish(); return { ok: true }; } catch (e) { return { ok: false, reason: e.message }; }
  });

  /* ---- commands ------------------------------------------------------------------------------ */
  ctx.command('open', open);
  ctx.command('state', async () => model());
  ctx.command('view', async (a) => {
    const was = S.view;
    S.view = M.normView(a && a.view);
    publish();
    // a page that needs its own data (Performance, Details, Services, ...) gets it now, not a tick later
    if (was !== S.view && S.win && !S.hidden && S.snap) sampleExtras().then(publish, (e) => ctx.log(`view samples failed: ${e && e.message}`));
    return { ok: true, view: S.view };
  });
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
    /* The user's file window is Mantle Files (Win+E): a FILE path opens its folder with the file selected
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

  if (HAS_CHORD) ctx.onChord(CHORD, () => { open({ view: tmSettings().startPage, via: CHORD }); });

  /* the launcher's "Mantle Task Manager" rows (lib/launcher-index.js MANTLE_TARGETS: mantle:taskmgr) */
  const app = d.app || (d.electron ? d.electron.app : (() => { try { return electron().app; } catch (_) { return null; } })());
  const onOpen = (target) => { if (target === 'taskmgr' || target === 'taskmgr:game') open({ view: target === 'taskmgr:game' ? 'game' : tmSettings().startPage, via: 'the launcher' }); };
  /* 'mantle-open:taskmgr' (view) is listened to ONLY while the feature is on and awake, so a launcher
     that checks app.listenerCount('mantle-open:taskmgr') can say "off or resting" instead of doing
     nothing (the shared 'mantle-open' always has wallpaper.js listening, so its emit() is always true). */
  const onOwn = (view) => { open({ view: view ? M.normView(view) : tmSettings().startPage, via: 'mantle-open' }); };
  // Quitting: the window's close is not turned into a hide (that would hold the quit up).
  if (app && typeof app.once === 'function') app.once('before-quit', () => { S.quitting = true; });
  const listen = (on) => {
    if (!app || typeof app.on !== 'function') return;
    app.removeListener('mantle-open', onOpen);
    app.removeListener('mantle-open:taskmgr', onOwn);
    if (on) { app.on('mantle-open', onOpen); app.on('mantle-open:taskmgr', onOwn); }
  };
  listen(ctx.enabled());
  ctx.onEnabled((on) => { listen(on); if (!on) destroyWindow('switched off in the tray'); else prewarmSoon(d.prewarmOnMs !== undefined ? d.prewarmOnMs : PREWARM_ON_MS); });
  const offKeep = KR.onChange((s, on) => {
    if (s !== 'taskmgr' || S.stopped) return;
    if (on) { prewarmTries = 0; prewarmSoon(d.prewarmOnMs !== undefined ? d.prewarmOnMs : PREWARM_ON_MS); return; }
    clearTimeout(prewarmTimer); prewarmTimer = null;
    if (S.win && S.hidden) destroyWindow('keep ready turned off: the hidden window is let go');
  });
  prewarmSoon(d.prewarmMs !== undefined ? d.prewarmMs : PREWARM_MS);

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
      clearTimeout(prewarmTimer); prewarmTimer = null;
      try { offKeep(); } catch (_) { /* gone */ }
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

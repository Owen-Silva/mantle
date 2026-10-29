'use strict';
/*
 * welcome.js - Mantle's first start (lane mantle-firstrun, 2026-10-15; design plan P-M3).
 *
 * Three cards on a brand-new profile (ui/welcome/): what changed, the keys, and how to switch back to
 * Windows' own taskbar. Skip on every card; Esc skips too; the last card's button finishes. Settings >
 * About > "Welcome tour" shows it again whenever asked.
 *
 * THE DECISION IS MADE AT STARTUP, BEFORE ANY WRITE. judge() runs at the top of main.js, right after
 * userData is known and before the sidecar, the theme, the features or Chromium write anything this
 * run. It only READS:
 *
 *   <userData>/first-run.json   { state: 'pending' }                       shown, not finished yet
 *                               { state: 'done', how, at[, evidence] }     how: finished | skipped |
 *                                                                          existing-profile
 *
 *   No flag (or one that cannot be read) = the profile is judged by what is ALREADY in it: any of
 *   EVIDENCE means Mantle has run here before, so the profile is marked 'existing-profile' and the
 *   welcome never shows. The user's live profile (%APPDATA%\mantle) has seven of them. None = a brand-new
 *   profile: 'pending', and the welcome shows until it is finished or skipped (a crash or a quit
 *   halfway leaves it pending, so it comes back; closing the window yourself counts as Skip).
 *   mantle.log is NOT evidence: main's own --log writer creates it before judge() runs, and so does
 *   the logon task's first start. Chromium's files are not evidence either (Mantle's own say more).
 *
 *   record() writes the flag later, once this process holds the single-instance lock (whenReady), so
 *   a --quit or --open message process never writes anything.
 *
 * TEST RUNS: a --test profile never sees the welcome and never writes the flag unless it asks with
 * --first-run (lib/args.js); then it is judged exactly like the live shell. A test window is
 * invisible like every --test window (lib/test-quiet.js).
 *
 * IPC (main's COMMANDS; any Mantle page may call, as with every command):
 *   welcome.state              -> { ok, via, test, firstRun, reason }
 *   welcome.done {how}         -> { ok, recorded, flag | reason }   how: 'finished' | 'skipped'
 *   welcome.show {via}         -> { ok, opened | already }          Settings' "Show again"
 */
const fs = require('fs');
const path = require('path');

const FLAG_FILE = 'first-run.json';
/** Mantle's own files and folders: each exists only once Mantle has run in this profile. */
const EVIDENCE = ['shell-state.json', 'theme.json', 'features.json', 'features', 'wallpapers', 'topbar-appbar.txt', 'look-sync.json', 'crash.json', 'Local Storage'];
const HOWS = ['finished', 'skipped', 'existing-profile'];
const TITLE = 'Welcome to Mantle';
/** The window: the card (ui/welcome/welcome.css .card 560 x 500) plus room for its shadow. */
const WIN_W = 624;
const WIN_H = 564;
/** After the bar's page is up: the shell settles first, then the welcome comes in over it. */
const SHOW_DELAY_MS = 1200;

const words = (e) => (e && e.message ? e.message : String(e));

function readFlag(dir, fsi) {
  const file = path.join(dir, FLAG_FILE);
  let raw;
  try { raw = fsi.readFileSync(file, 'utf8'); } catch (e) {
    return e && e.code === 'ENOENT' ? { flag: null, why: null } : { flag: null, why: `the flag could not be read (${e && e.code ? e.code : words(e)})` };
  }
  let v;
  try { v = JSON.parse(raw); } catch (e) { return { flag: null, why: 'the flag is not valid JSON' }; }
  if (!v || typeof v !== 'object') return { flag: null, why: 'the flag is not an object' };
  if (v.state === 'pending') return { flag: { state: 'pending', at: v.at || null }, why: null };
  if (v.state === 'done' && HOWS.includes(v.how)) return { flag: v, why: null };
  return { flag: null, why: `the flag says "${String(v.state).slice(0, 20)}"${v.how ? ` / "${String(v.how).slice(0, 20)}"` : ''}, which is not a state Mantle writes` };
}

/** The EVIDENCE entries present in dir (READ only). */
function evidenceIn(dir, fsi) {
  const out = [];
  for (const name of EVIDENCE) {
    try { fsi.statSync(path.join(dir, name)); out.push(name); } catch (_) { /* not there */ }
  }
  return out;
}

/**
 * The startup verdict. READS only; never throws.
 *   { show, reason, write: <flag to record> | null, flag, evidence, test, optIn }
 */
function judge(o) {
  const opts = o || {};
  const fsi = opts.fs || fs;
  const dir = opts.dir;
  const test = !!opts.test, optIn = !!opts.optIn;
  const now = opts.now ? opts.now() : new Date().toISOString();
  const base = { test, optIn, flag: null, evidence: [], write: null };
  if (test && !optIn) return Object.assign(base, { show: false, reason: 'a test run without --first-run: the welcome is not shown and its flag is not written' });
  if (typeof dir !== 'string' || !dir) return Object.assign(base, { show: false, reason: 'no profile folder was given, so nothing can be judged; the welcome is not shown' });
  const f = readFlag(dir, fsi);
  if (f.flag && f.flag.state === 'done') {
    return Object.assign(base, { flag: f.flag, show: false, reason: `this profile is done with the welcome (${f.flag.how}${f.flag.at ? `, ${f.flag.at}` : ''})` });
  }
  if (f.flag && f.flag.state === 'pending') {
    return Object.assign(base, { flag: f.flag, show: true, reason: 'the welcome was shown before and not finished or skipped yet' });
  }
  const evidence = evidenceIn(dir, fsi);
  const note = f.why ? `; ${f.why}` : '';
  if (evidence.length) {
    return Object.assign(base, { evidence, show: false,
      write: { state: 'done', how: 'existing-profile', at: now, evidence },
      reason: `this profile has been used (${evidence.join(', ')}), so it is marked and the welcome never shows${note}` });
  }
  return Object.assign(base, { show: true, write: { state: 'pending', at: now }, reason: `a brand-new profile: nothing of Mantle's is in it yet${note}` });
}

/** Write a flag atomically (tmp + rename). { ok, reason } */
function writeFlag(dir, value, fsi) {
  const f = fsi || fs;
  const file = path.join(dir, FLAG_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    f.mkdirSync(dir, { recursive: true });
    f.writeFileSync(tmp, JSON.stringify(value, null, 2));
    f.renameSync(tmp, file);
    return { ok: true, reason: null };
  } catch (e) {
    try { f.unlinkSync(tmp); } catch (_) { /* never made */ }
    return { ok: false, reason: `the first-run flag could not be saved (${e && e.code ? e.code : words(e)})` };
  }
}

/**
 * The window and the commands. deps: { verdict, dir, test, preload, page, BrowserWindow, screen,
 * log(line), focusHelp(win) -> Promise<{ok, error}>, quitting() -> bool, fs, delayMs, setTimeout }
 */
function host(deps) {
  const d = deps || {};
  const fsi = d.fs || fs;
  const log = typeof d.log === 'function' ? d.log : () => {};
  const later = d.setTimeout || setTimeout;
  const verdict = d.verdict || { show: false, reason: 'no verdict was made', write: null };
  // the flag is written only where it may be: never in a plain --test run
  const mayWrite = !d.test || !!verdict.optIn;
  let win = null;
  let via = null;
  let answered = false;   // this showing ended through welcome.done (Skip, Esc, or the last card)
  let started = false;

  function record() {
    if (!verdict.write) return { ok: true, wrote: false };
    const r = writeFlag(d.dir, verdict.write, fsi);
    log(r.ok ? `flag written: ${verdict.write.state}${verdict.write.how ? ` (${verdict.write.how})` : ''}` : r.reason);
    return Object.assign({ wrote: r.ok }, r);
  }

  function done(how, why) {
    if (!mayWrite) return { ok: true, recorded: false, reason: 'a test run without --first-run: nothing is recorded' };
    const flag = { state: 'done', how, at: new Date().toISOString() };
    if (why) flag.note = why;
    const r = writeFlag(d.dir, flag, fsi);
    if (!r.ok) { log(r.reason); return { ok: false, recorded: false, reason: r.reason }; }
    return { ok: true, recorded: true, flag };
  }

  function workArea() {
    try { return d.screen.getPrimaryDisplay().workArea; } catch (_) { return { x: 0, y: 0, width: 1280, height: 720 }; }
  }

  function open(why) {
    if (win && !win.isDestroyed()) {
      try { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } catch (_) { /* gone */ }
      return { ok: true, already: true };
    }
    const BW = d.BrowserWindow;
    if (!BW) return { ok: false, reason: 'the welcome window cannot be made here (no BrowserWindow)' };
    const wa = workArea();
    const width = Math.min(WIN_W, wa.width), height = Math.min(WIN_H, wa.height);
    let w;
    try {
      w = new BW({
        show: false, frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: false,
        resizable: false, minimizable: false, maximizable: false, fullscreenable: false, skipTaskbar: false, focusable: true,
        width, height, x: Math.round(wa.x + (wa.width - width) / 2), y: Math.round(wa.y + (wa.height - height) / 2),
        title: TITLE,
        webPreferences: { preload: d.preload, contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false },
      });
    } catch (e) {
      log(`the welcome window could not be made (${words(e)})`);
      return { ok: false, reason: `the welcome window could not be made (${words(e)})` };
    }
    win = w; via = why; answered = false;
    const wc = w.webContents;
    wc.on('will-navigate', (e) => e.preventDefault());
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('render-process-gone', (_e, det) => {
      log(`the welcome page's renderer died (${det && det.reason}); the window is closed and the welcome stays pending`);
      answered = true;
      if (win === w) { win = null; try { w.destroy(); } catch (_) { /* gone */ } }
    });
    wc.on('did-fail-load', (_e, code, desc, _u, isMain) => {
      if (isMain === false || win !== w) return;
      log(`the welcome page did not load (${desc || code}); the welcome stays pending`);
      answered = true;
      win = null;
      try { w.destroy(); } catch (_) { /* gone */ }
    });
    w.on('page-title-updated', (e) => e.preventDefault());
    w.once('ready-to-show', () => {
      if (win !== w) return;
      try { w.show(); w.focus(); } catch (_) { return; }
      log(`shown (${why})`);
      // Windows' foreground lock can refuse a window that a just-started shell shows; the sidecar can
      // hand it the keyboard (the Settings window's pattern). Never in a test: nothing takes focus there.
      if (!d.test && typeof d.focusHelp === 'function') {
        const t = later(() => {
          if (win !== w || w.isDestroyed() || w.isFocused()) return;
          Promise.resolve(d.focusHelp(w)).then((r) => {
            if (r && r.ok === false) log(`the welcome could not take the keyboard (${r.error || r.reason || 'no reason came back'}); a click in it gives it the keyboard`);
          }, (e) => log(`the welcome could not take the keyboard (${words(e)}); a click in it gives it the keyboard`));
        }, 200);
        if (t && t.unref) t.unref();
      }
    });
    // Closed by hand (Alt+F4, or the bar's close) without an answer = Skip, so it does not come back at
    // every sign-in. Closed because Mantle is quitting = still pending.
    w.on('closed', () => {
      if (win === w) win = null;
      if (answered) return;
      if (typeof d.quitting === 'function' && d.quitting()) { log('closed because Mantle is quitting; the welcome stays as it was'); return; }
      const r = done('skipped', 'the window was closed');
      log(r.recorded ? 'closed without an answer: recorded as skipped' : `closed without an answer (${r.reason})`);
    });
    try { w.loadFile(d.page); } catch (e) { log(`the welcome page could not be loaded (${words(e)})`); }
    return { ok: true, opened: true };
  }

  /** At startup: the verdict's own line, then the welcome once the shell is up (if it is due). */
  function start() {
    if (started) return;
    started = true;
    log(verdict.show ? `due: ${verdict.reason}` : `not shown: ${verdict.reason}`);
    if (!verdict.show) return;
    const t = later(() => open('first start'), d.delayMs != null ? d.delayMs : SHOW_DELAY_MS);
    if (t && t.unref) t.unref();
  }

  const commands = {
    'welcome.state': async () => ({ ok: true, via: via || 'first start', test: !!d.test, packaged: !!d.packaged, firstRun: !!verdict.optIn, reason: verdict.reason }),
    'welcome.done': async (a) => {
      const how = a && a.how;
      if (how !== 'finished' && how !== 'skipped') return { ok: false, recorded: false, reason: 'welcome.done takes {how: "finished" | "skipped"}' };
      const r = done(how);
      log(`${how} (${via || 'first start'})${r.recorded ? '' : `: ${r.reason}`}`);
      // a record that failed keeps the window: the page shows the reason (never a silent failure)
      if (!r.ok) return r;
      answered = true;
      const w = win;
      // the page has already played its exit; close on the next tick so this answer gets back first
      later(() => { if (w && !w.isDestroyed()) { try { w.close(); } catch (_) { /* gone */ } } }, 0);
      return r;
    },
    'welcome.show': async (a) => {
      const from = a && typeof a.via === 'string' ? a.via.replace(/[^\w .-]/g, '').slice(0, 30) || 'a page' : 'a page';
      return open(`asked from ${from}`);
    },
  };

  return { start, open, record, commands, window: () => win, verdict };
}

module.exports = { judge, writeFlag, readFlag, evidenceIn, host, FLAG_FILE, EVIDENCE, HOWS, TITLE, WIN_W, WIN_H, SHOW_DELAY_MS };

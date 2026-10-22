'use strict';
/* _layouts-core.js - WINDOW LAYOUTS, the pure half (lane layouts, 2026-09-27). No Electron, no
 * sidecar, no clock: lib/features/layouts.test.js runs every rule here on made-up windows.
 *
 * A LAYOUT is { name, savedAt, entries: [ENTRY] }, kept in the feature's settings (layouts.json).
 * An ENTRY is one window as it stood:
 *   app      the name the user sees ("Visual Studio Code", "Quartz")
 *   exe      the program's full path (to match it, and to start it if it is not open)
 *   aumid    the app's AppUserModelID when it has one (Store apps, Terminal, Chrome), else null
 *   t        the title's WORDS as short hashes (see titleTokens): enough to tell two windows of one
 *            app apart ("mantle - Visual Studio Code" vs "northwind - ..."), never the title itself
 *   state    'normal' | 'max'   (a snapped window is 'normal' with snapped:true: Windows' snap state
 *            cannot be set from outside, so it comes back as a normal window in the same spot)
 *   mon      which monitor: { device, primary, w, h, x, y, dpi } (physical px)
 *   work     that monitor's work area when saved, in DIP { w, h }
 *   rect     the window's VISIBLE frame in DIP relative to the work area's top-left; for 'max' it
 *            is the restore rect (where it goes when un-maximised)
 *
 * MINIMISED WINDOWS ARE LEFT OUT of a saved layout (a layout is what is on screen); a window that
 * matches an entry and is minimised when the layout comes back is restored into its spot.
 */
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const QUARTZ = require('../quartz-exe');
const TM = require('../../ui/topbar/model.js');   // appName(): the name the top bar shows for an app

const NAME_MAX = 40;
const MAX_LAYOUTS = 24;
const MAX_ENTRIES = 40;
const MIN_W = 120, MIN_H = 60;   // physical px: the smallest window a layout puts back

// Programs that only HOST an app: their exe alone starts the wrong thing (bare Electron, a Java
// runtime), so an entry for one is matched only by its exact path and never started from it.
const HOSTS = new Set(['electron.exe', 'java.exe', 'javaw.exe', 'python.exe', 'pythonw.exe', 'node.exe',
  'rundll32.exe', 'dllhost.exe', 'mmc.exe', 'wscript.exe', 'cscript.exe', 'msedgewebview2.exe',
  'applicationframehost.exe', 'svchost.exe', 'conhost.exe', 'openconsole.exe']);

// The user's own browser (Quartz) is Electron's runtime with its app folder: the launcher starts it the same
// way (lib/quartz-exe.js). Its exe is Quartz.exe when that exists, else the bare electron.exe, and a
// window or saved entry of EITHER is Quartz (a layout saved before the switch still finds it).
// BROWSER_EXE is the pick at load; launchPlan picks again per start.
const BROWSER_DIR = QUARTZ.BROWSER_DIR;
const BROWSER_EXE = QUARTZ.browserExe();
const BROWSER_EXES = QUARTZ.candidates();
const isQuartz = (exe, bx) => !!exe && (QUARTZ.isBrowserExe(exe) || (!!bx && String(exe).toLowerCase() === String(bx).toLowerCase()));

const lower = (s) => String(s || '').toLowerCase();
const base = (exe) => lower(String(exe || '').split(/[\\/]/).pop());
const r2 = (v) => Math.round(v * 100) / 100;

/* ---- what a stored layout may start (secreview-win, 2026-09-27) --------------------------------
   layouts.json is a file on disk: hand-edited, copied from another PC or written by something else.
   Its exe is started with cp.spawn and its AUMID through shell:AppsFolder, so neither is trusted.
   A program is started only from an absolute path on a local drive letter, ending in .exe, with no
   ".." step: never a UNC or device path (\\host\share, //host, \\?\, \\.\) - even fs.existsSync on
   one makes Windows sign in to that host with the user's account hash - and never a file that is not a
   program (CreateProcess runs a renamed .exe whatever its extension). An AUMID is an app id, never
   a path: at most 128 characters (Windows' own limit), no slash, backslash, colon or control
   character. A mapped network drive letter still passes (it cannot be told from here). */
const EXE_MAX = 520;
function exeRefusal(p) {
  const s = typeof p === 'string' ? p : '';
  if (!s) return 'no program is named';
  if (s.length > EXE_MAX) return 'its program path is too long to be real';
  // eslint-disable-next-line no-control-regex
  if (!/^[A-Za-z]:[\\/]/.test(s) || /[\u0000-\u001f"<>|?*]/.test(s.slice(2)) || s.indexOf(':', 2) !== -1) return 'its program is not a path on this PC\'s own drives';
  if (/(^|[\\/])\.\.?([\\/]|$)/.test(s.slice(3))) return 'its program path steps out of its folder (..)';
  if (!/\.exe$/i.test(s)) return 'what it names is not a program (.exe)';
  return null;
}
// eslint-disable-next-line no-control-regex
const aumidOk = (a) => typeof a === 'string' && a.length > 0 && a.length <= 128 && !/[\\/:\u0000-\u001f]/.test(a);

/* ---- names ------------------------------------------------------------------------------------ */

function cleanName(raw) {
  // eslint-disable-next-line no-control-regex
  const s = String(raw == null ? '' : raw).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return { ok: false, reason: 'a layout needs a name (for example Work or Code)' };
  if (s.length > NAME_MAX) return { ok: false, reason: `a layout name can be at most ${NAME_MAX} characters` };
  return { ok: true, name: s };
}

function findLayout(list, name) {
  const k = lower(String(name || '').trim());
  return (list || []).find((l) => l && lower(l.name) === k) || null;
}

/* ---- the app's name ----------------------------------------------------------------------------- */

function appNameOf(w, opts) {
  if (w && isQuartz(w.exe, opts && opts.browserExe)) return 'Quartz';
  const n = TM.appName({ exe: w && w.exe, desc: w && w.desc, product: w && w.product });
  return n && n !== 'Window' ? n : ((w && w.name) || 'An app');
}

/* ---- titles: words as hashes ------------------------------------------------------------------ */

/* The title's words (letters/digits, 2+ characters, not bare numbers such as unread counts), at most
   16, each stored as the first 8 hex digits of its SHA-1. Not a security boundary (a dictionary would
   undo a single word) - it keeps titles out of plain sight in layouts.json, and matching needs no more. */
function titleTokens(title) {
  if (!title) return [];
  const words = String(title).toLowerCase().normalize('NFKC').split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 2 && !/^\d+$/.test(w));
  const out = [];
  const seen = new Set();   // a word repeated in the title is hashed once (a SHA-1 each was most of match()'s time)
  for (const w of words) {
    if (seen.has(w)) continue;
    seen.add(w);
    const h = crypto.createHash('sha1').update(w).digest('hex').slice(0, 8);
    if (!out.includes(h)) out.push(h);
    if (out.length >= 16) break;
  }
  return out;
}

/* Dice overlap of two token lists (or Sets), 0..1 (0 when either is empty). match() passes Sets it
   built once: building them per pair made 40 entries x 200 windows cost ~60 ms (2026-09-29). */
function titleScore(a, b) {
  const A = a instanceof Set ? a : new Set(a || []), B = b instanceof Set ? b : new Set(b || []);
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const t of A) if (B.has(t)) n++;
  return (2 * n) / (A.size + B.size);
}

/* ---- rects ------------------------------------------------------------------------------------ */

const scaleOf = (mon) => ((mon && mon.dpi) || 96) / 96;
const workOf = (mon) => (mon && (mon.work || mon.bounds)) || { x: 0, y: 0, w: 0, h: 0 };

/* A physical frame -> DIP relative to the monitor's work area (2 decimals: exact back at 100-200 %). */
function relRect(frame, mon) {
  const s = scaleOf(mon), wk = workOf(mon);
  return { x: r2((frame.x - wk.x) / s), y: r2((frame.y - wk.y) / s), w: r2(frame.w / s), h: r2(frame.h / s) };
}

function workDip(mon) {
  const s = scaleOf(mon), wk = workOf(mon);
  return { w: r2(wk.w / s), h: r2(wk.h / s) };
}

/* Keeps a physical rect inside a work area: never bigger than it, never hanging off an edge. */
function fitInto(r, wk) {
  const w = Math.max(Math.min(r.w, wk.w), Math.min(MIN_W, wk.w));
  const h = Math.max(Math.min(r.h, wk.h), Math.min(MIN_H, wk.h));
  const x = Math.min(Math.max(r.x, wk.x), wk.x + wk.w - w);
  const y = Math.min(Math.max(r.y, wk.y), wk.y + wk.h - h);
  return { x, y, w, h };
}

/* DIP relative rect -> physical frame on `mon`. Same work-area size (within 1 DIP): the same DIP
   offsets at this monitor's scale. Another size (another monitor, the top bar hidden): the same
   FRACTIONS of the work area, so halves stay halves and a full-height window still fills it. Edges
   are rounded, not sizes, so two windows that shared an edge still share it. */
function absRect(rel, savedWork, mon) {
  const s = scaleOf(mon), wk = workOf(mon);
  const cur = workDip(mon);
  const same = savedWork && Math.abs(savedWork.w - cur.w) <= 1 && Math.abs(savedWork.h - cur.h) <= 1;
  const fx = same || !savedWork || !savedWork.w ? 1 : cur.w / savedWork.w;
  const fy = same || !savedWork || !savedWork.h ? 1 : cur.h / savedWork.h;
  const L = wk.x + Math.round(rel.x * fx * s), T = wk.y + Math.round(rel.y * fy * s);
  const R = wk.x + Math.round((rel.x + rel.w) * fx * s), B = wk.y + Math.round((rel.y + rel.h) * fy * s);
  return fitInto({ x: L, y: T, w: Math.max(1, R - L), h: Math.max(1, B - T) }, wk);
}

function overlap(a, b) {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/* ---- monitors --------------------------------------------------------------------------------- */

function monKey(mon) {
  const b = mon.bounds || {};
  return { device: mon.device || '', primary: !!mon.primary, w: b.w, h: b.h, x: b.x, y: b.y, dpi: mon.dpi || 96 };
}

/* The monitor an entry goes back to: the same one (device name and size), else the same device
   name, else the primary if it was on the primary, else one at the same place, else the primary. */
function pickMonitor(saved, monitors) {
  const list = monitors || [];
  const primary = list.find((m) => m.primary) || list[0] || null;
  if (!saved) return { mon: primary, how: 'primary' };
  const dev = (m) => lower(m.device) === lower(saved.device) && saved.device;
  let m = list.find((x) => dev(x) && x.bounds && x.bounds.w === saved.w && x.bounds.h === saved.h);
  if (m) return { mon: m, how: 'same' };
  // re-ordered: a replug can swap the DISPLAYn names, but a monitor at the very same place and size is
  // the same screen (lane windows-layouts, 2026-09-29)
  m = list.find((x) => x.bounds && saved.w && x.bounds.x === saved.x && x.bounds.y === saved.y && x.bounds.w === saved.w && x.bounds.h === saved.h);
  if (m) return { mon: m, how: 'bounds' };
  m = list.find(dev);
  if (m) return { mon: m, how: 'device' };
  if (saved.primary && primary) return { mon: primary, how: 'primary' };
  m = list.find((x) => x.bounds && x.bounds.x === saved.x && x.bounds.y === saved.y);
  if (m) return { mon: m, how: 'place' };
  return { mon: primary, how: 'fallback' };
}

/* Where an entry's frame goes now: { mon, frame (physical), state } or null without monitors. */
function targetOf(entry, monitors) {
  const p = pickMonitor(entry.mon, monitors);
  if (!p.mon) return null;
  return { mon: p.mon, how: p.how, state: entry.state === 'max' ? 'max' : 'normal', frame: absRect(entry.rect, entry.work, p.mon) };
}

/* ---- save --------------------------------------------------------------------------------------- */

/* The sidecar's layouts.windows answer -> entries, and what was left out and why (never silent).
   opts.test: only windows of the test's own fixtures (w.ours) - the user's windows are never saved in a test. */
function snapshot(ans, opts) {
  const o = opts || {};
  const monitors = (ans && ans.monitors) || [];
  const entries = [];
  const left = { minimized: 0, offscreen: 0, elevated: [], test: 0, extra: 0 };
  for (const w of (ans && ans.windows) || []) {
    if (!w || !w.frame) continue;
    if (o.test && !w.ours) { left.test++; continue; }
    if (w.state === 'min') { left.minimized++; continue; }
    const app = appNameOf(w, o);
    if (w.elevated === true) { left.elevated.push(app); continue; }
    // its monitor: the one Windows names, if the window (or, maximised, its restore rect) is on it;
    // else the one it overlaps most
    const probes = [w.frame].concat(w.state === 'max' && w.normal ? [w.normal] : []);
    const on = (m) => probes.some((p) => overlap(p, m.bounds || workOf(m)) > 0);
    let mon = monitors.find((m) => m.id === w.monitor) || null;
    if (!mon || !on(mon)) {
      let best = 0;
      mon = null;
      for (const p of probes) {
        for (const m of monitors) { const a = overlap(p, m.bounds || workOf(m)); if (a > best) { best = a; mon = m; } }
        if (mon) break;
      }
    }
    if (!mon) { left.offscreen++; continue; }
    if (entries.length >= MAX_ENTRIES) { left.extra++; continue; }
    const max = w.state === 'max';
    const frame = max ? (w.normal || workOf(mon)) : w.frame;
    entries.push({
      app, exe: w.exe || '', aumid: w.aumid || null, t: titleTokens(w.title),
      state: max ? 'max' : 'normal', snapped: !!w.arranged,
      mon: monKey(mon), work: workDip(mon), rect: relRect(frame, mon),
    });
  }
  return { entries, left };
}

function leftWords(left) {
  const out = [];
  if (!left) return out;
  if (left.minimized) out.push(`${left.minimized} minimised window${left.minimized === 1 ? '' : 's'} left out`);
  if (left.offscreen) out.push(`${left.offscreen} window${left.offscreen === 1 ? '' : 's'} off every screen left out`);
  for (const a of left.elevated || []) out.push(`${a} left out: it runs as administrator, so Mantle cannot move it`);
  if (left.extra) out.push(`${left.extra} more window${left.extra === 1 ? '' : 's'} left out (a layout keeps ${MAX_ENTRIES})`);
  if (left.test) out.push(`${left.test} real window${left.test === 1 ? '' : 's'} left out (test run: fixtures only)`);
  return out;
}

/* ---- match ------------------------------------------------------------------------------------ */

/* How surely a window is the entry's app: 3 same AUMID, 2 same exe path, 1 same exe name (not a
   host such as electron.exe), 0 not this app. Two AUMIDs that differ (two Chrome profiles, two PWAs)
   are never the same app, whatever the exe. */
function tierOf(entry, win) {
  const ea = lower(entry.aumid), wa = lower(win.aumid);
  if (ea && wa) return ea === wa ? 3 : 0;
  const ep = lower(entry.exe), wp = lower(win.exe);
  if (ep && wp && ep === wp) return 2;
  if (isQuartz(ep) && isQuartz(wp)) return 2;   // Quartz.exe and its bare electron.exe are one app
  if (ep && wp && base(ep) === base(wp) && !HOSTS.has(base(ep))) return 1;
  return 0;
}

const centre = (r) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

/* Pairs entries with windows: each window used once, best pairs first (tier, then title words,
   then the window already nearest its spot, then order). Returns [{ window|null, tier, score }]
   aligned with entries. `targets[i]` (optional) is entry i's frame now, for the distance tie-break. */
function match(entries, windows, targets) {
  const pairs = [];
  // each window's title words once, not once per entry (40 entries x 200 titled windows: 265 -> ~10 ms)
  // (and as Sets, as are the entries' words: 40 x 200 was still ~60 ms building Sets per pair)
  const wt = new Map();
  const tokensOf = (j) => { if (!wt.has(j)) wt.set(j, new Set(titleTokens(windows[j].title))); return wt.get(j); };
  (entries || []).forEach((e, i) => {
    const et = new Set(Array.isArray(e.t) ? e.t : []);
    (windows || []).forEach((w, j) => {
      const tier = tierOf(e, w);
      if (!tier) return;
      const score = et.size ? titleScore(et, tokensOf(j)) : 0;
      let dist = 0;
      const tg = targets && targets[i] && targets[i].frame;
      if (tg && w.frame) { const a = centre(tg), b = centre(w.frame); dist = Math.hypot(a.x - b.x, a.y - b.y); }
      pairs.push({ i, j, tier, score, dist });
    });
  });
  pairs.sort((a, b) => b.tier - a.tier || b.score - a.score || a.dist - b.dist || a.i - b.i || a.j - b.j);
  const out = (entries || []).map(() => ({ window: null, tier: 0, score: 0 }));
  const usedE = new Set(), usedW = new Set();
  for (const p of pairs) {
    if (usedE.has(p.i) || usedW.has(p.j)) continue;
    usedE.add(p.i); usedW.add(p.j);
    out[p.i] = { window: windows[p.j], tier: p.tier, score: Math.round(p.score * 100) / 100 };
  }
  return out;
}

/* ---- starting an app that is not open --------------------------------------------------------- */

/* How an entry with no open window gets started: { how:'aumid'|'exe'|'none', exe, args, aumid, why }.
   `exists(path)` is injected (fs.existsSync). THE DECISION: Mantle starts it by default - one click
   is the point - but only when the start is known to be the right app. */
function launchPlan(entry, opts) {
  const o = opts || {};
  const exists = o.exists || (() => true);
  const bd = o.browserDir || BROWSER_DIR;
  const exe = typeof entry.exe === 'string' ? entry.exe : '';
  if (isQuartz(exe, o.browserExe)) {
    // start it as it is installed NOW (Quartz.exe, else electron.exe), whichever exe the entry saved
    const bx = o.browserExe || QUARTZ.browserExe({ exists });
    if (!exists(bx)) return { how: 'none', why: `${entry.app} isn't installed any more (it is not in its folder)`, kind: 'missing' };
    return { how: 'exe', exe: bx, args: [bd] };
  }
  // never exists() or start a path that fails exeRefusal: the check itself would reach a share
  const exeBad = exe ? exeRefusal(exe) : null;
  if (aumidOk(entry.aumid)) return { how: 'aumid', aumid: entry.aumid, exe, fallbackExe: exe && !exeBad && !HOSTS.has(base(exe)) && exists(exe) ? exe : null };
  if (!exe) {
    return entry.aumid ? { how: 'none', kind: 'unsafe', why: `${entry.app} isn't open, and the saved layout doesn't name a real app, so Mantle won't start it` }
      : { how: 'none', why: `${entry.app} isn't open, and the layout does not say which program it is`, kind: 'unknown' };
  }
  if (exeBad) return { how: 'none', kind: 'unsafe', why: `${entry.app} isn't open, and Mantle will not start it from this layout: ${exeBad}` };
  if (HOSTS.has(base(exe))) {
    return { how: 'none', kind: 'host',
      why: `${entry.app} isn't open, and Mantle can't start it on its own: open it, then choose the layout again` };
  }
  if (!exists(exe)) return { how: 'none', why: `${entry.app} isn't installed any more`, kind: 'missing' };
  return { how: 'exe', exe, args: [] };
}

/* ---- the summary ------------------------------------------------------------------------------ */

/* results: [{ app, kind, why?, note? }] with kind placed | already | opened | notfound | refused |
   failed | wouldPlace | wouldOpen | wouldNot. Returns { text, lines, counts }: the one line the user
   reads ("Work: 3 placed, 1 opened, 1 not found (Notion isn't installed)") and one line per entry
   that did not go where it was saved, each with its reason. */
function summarize(name, results, opts) {
  const dry = !!(opts && opts.dryRun);
  const c = { placed: 0, opened: 0, notfound: 0, refused: 0, failed: 0, wouldPlace: 0, wouldOpen: 0 };
  const by = {};
  for (const r of results || []) {
    const k = r.kind === 'already' ? 'placed' : r.kind;
    if (!(k in c)) continue;
    c[k]++;
    (by[k] = by[k] || []).push(r);
  }
  const lines = [];
  for (const r of results || []) {
    if (r.kind === 'placed' || r.kind === 'already' || r.kind === 'opened' || r.kind === 'wouldPlace' || r.kind === 'wouldOpen') {
      if (r.note) lines.push(`${r.app}: ${r.note}`);
      continue;
    }
    lines.push(r.why || `${r.app}: no reason came back`);
  }
  // THE HEADLINE IS COUNTS ONLY (lane windows-layouts, 2026-09-29): a lone reason used to go inline,
  // which made "1 not found (Notion isn't installed (its program is gone from disk))" and a clamped
  // two-line headline. Every reason is now a line of its own under it. "refused" / "failed" read as
  // Mantle's jargon: both are "couldn't be moved" (the counts keep them apart for the log).
  const parts = [];
  if (dry) {
    if (c.wouldPlace) parts.push(`would place ${c.wouldPlace}`);
    if (c.wouldOpen) parts.push(`would open ${c.wouldOpen}`);
  }
  if (c.placed) parts.push(`${c.placed} placed`);
  if (c.opened) parts.push(`${c.opened} opened`);
  if (c.notfound) parts.push(`${c.notfound} not found`);
  if (c.refused + c.failed) parts.push(`${c.refused + c.failed} couldn’t be moved`);
  const total = (results || []).length;
  let text;
  if (!total) text = `${name}: this layout has no windows`;
  else if (!dry && c.placed === total && (by.placed || []).every((r) => r.kind === 'already')) text = `${name}: all ${total} window${total === 1 ? ' is' : 's are'} already in place`;
  else text = `${name}${dry ? ' (dry run)' : ''}: ${parts.join(', ')}`;
  return { text, lines, counts: c };
}

/* ---- stored layouts: what comes back from settings is checked, never trusted ------------------- */

/* Every field is rebuilt from its expected type and size (secreview-win): a hand-edited file once
   carried 900,000 title words in one entry (match() then held the main process 6 s), a 1 MB app name
   (into the pop-up and the launcher), and strings where numbers go. `why` (optional, an object) gets
   the count of layouts and windows left out, so the feature can say so instead of dropping them. */
const fin = (v, lo, hi) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
const HEX8 = /^[0-9a-f]{8}$/;
function cleanEntry(e) {
  if (!e || typeof e !== 'object') return null;
  const r = e.rect;
  if (!r || !fin(r.x, -1e5, 1e5) || !fin(r.y, -1e5, 1e5) || !fin(r.w, 0.01, 1e5) || !fin(r.h, 0.01, 1e5)) return null;
  const exe = typeof e.exe === 'string' && e.exe.length <= EXE_MAX ? e.exe : '';
  const aumid = aumidOk(e.aumid) ? e.aumid : null;
  if (!exe && !aumid) return null;
  const t = [];
  if (Array.isArray(e.t)) for (let k = 0; k < e.t.length && k < 64 && t.length < 16; k++) if (typeof e.t[k] === 'string' && HEX8.test(e.t[k]) && !t.includes(e.t[k])) t.push(e.t[k]);
  const m = e.mon && typeof e.mon === 'object' ? e.mon : null;
  const mon = m ? { device: typeof m.device === 'string' ? m.device.slice(0, 64) : '', primary: m.primary === true,
    w: fin(m.w, 1, 1e5) ? m.w : undefined, h: fin(m.h, 1, 1e5) ? m.h : undefined,
    x: fin(m.x, -1e6, 1e6) ? m.x : undefined, y: fin(m.y, -1e6, 1e6) ? m.y : undefined, dpi: fin(m.dpi, 24, 1920) ? m.dpi : 96 } : null;
  const wk = e.work && fin(e.work.w, 1, 1e5) && fin(e.work.h, 1, 1e5) ? { w: e.work.w, h: e.work.h } : null;
  const app = (typeof e.app === 'string' ? e.app : '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 64) || 'An app';   // eslint-disable-line no-control-regex
  return { app, exe, aumid, t, state: e.state === 'max' ? 'max' : 'normal', snapped: e.snapped === true, mon, work: wk,
    rect: { x: r.x, y: r.y, w: r.w, h: r.h } };
}

function sanitize(list, why) {
  const out = [];
  const w = why && typeof why === 'object' ? why : {};
  w.layouts = 0; w.entries = 0;
  if (!Array.isArray(list)) { if (list != null) w.layouts++; return out; }
  for (const l of list) {
    if (out.length >= MAX_LAYOUTS) { w.layouts++; continue; }
    if (!l || typeof l.name !== 'string' || !Array.isArray(l.entries)) { w.layouts++; continue; }
    const n = cleanName(l.name);
    if (!n.ok || findLayout(out, n.name)) { w.layouts++; continue; }
    const entries = [];
    for (let k = 0; k < l.entries.length; k++) {
      const e = entries.length < MAX_ENTRIES ? cleanEntry(l.entries[k]) : null;
      if (e) entries.push(e); else w.entries++;
    }
    const savedAt = typeof l.savedAt === 'string' && l.savedAt.length <= 40 ? l.savedAt : null;
    out.push({ name: n.name, savedAt, entries });
  }
  return out;
}

function brief(layout) {
  const apps = [];
  for (const e of layout.entries || []) if (e.app && !apps.includes(e.app)) apps.push(e.app);
  return { name: layout.name, count: (layout.entries || []).length, apps: apps.slice(0, 6), savedAt: layout.savedAt || null };
}

module.exports = {
  NAME_MAX, MAX_LAYOUTS, MAX_ENTRIES, HOSTS, BROWSER_EXE, BROWSER_EXES, BROWSER_DIR,
  cleanName, findLayout, appNameOf, titleTokens, titleScore,
  relRect, absRect, workDip, fitInto, monKey, pickMonitor, targetOf,
  snapshot, leftWords, tierOf, match, launchPlan, summarize, sanitize, brief, exeRefusal, aumidOk, cleanEntry,
};

'use strict';
/*
 * look-host.js -- Mantle's side of LOOK SYNC with Helm and Quartz (lane looksync-mantle, 2026-10-10;
 * spec ~/look-sync/CONTRACT.md sections 2, 3 and 5, vendored module lib/look-sync.js).
 *
 * Owen: change a look setting in one app and all three follow. Shared in %APPDATA%\look-sync\look.json:
 *   theme   system | light | dark      <-> Mantle's own appearance (lib/theme.js mode, theme.json)
 *   accent  { hue: null | 0..360 }     null = Mantle's own accents (dark steel blue);
 *                                      a hue = lib/accent.js tokens for the DARK look only
 *   glass   { dark: {blurPx, dim, panel}, light: {...}, render }
 *           Mantle uses the DARK glass only (Owen: light stays untouched): blurPx -> --lg-blur,
 *           dim -> --lg-fill-bar alpha (the bars' guard may still raise it), panel -> added to the alpha
 *           of --lg-fill, --lg-fill-pop, --lg-card and --lg-field, each clamped .30..97. The light glass
 *           is kept and passed through untouched when Mantle writes the glass.
 * HOW IT REACHES THE PAGES: vars(theme) is the set of --lg-* overrides for that theme, EMPTY at the
 * seed values (blur 5, dim .50, panel 0, hue null), so the default look is the stylesheet's own, value
 * for value. preload.js stamps them inline on <html> before first paint (mantle:theme-now) and live
 * with the 'theme' event, then fires 'mantle-theme' so every surface re-bakes its glass.
 * Mantle's local copy (<userData>/look-sync.json: { lookSync, accent, glass }) is what it shows while
 * sync is OFF and before the shared file has been read. The switch lives there, beside theme.json
 * (the contract's features.json is lib/features.js's own in-memory switch map, written whole, so a
 * second writer would race it).
 *
 * makeLookHost(o):
 *   o.LS, o.accent  lib/look-sync.js, lib/accent.js
 *   o.file          the local copy's path
 *   o.dir           the shared folder (undefined: LOOK_SYNC_DIR or %APPDATA%\look-sync)
 *   o.theme         { mode(), resolved(), set(mode) }   lib/theme.js
 *   o.log(line)
 *   o.now()         optional clock (tests)
 * -> { start(), close(), sync, vars(theme), view(), onChange(fn), themeChanged(view), setSync(on),
 *      setGlass(patch), setAccent(hue), setDesktop(state), refresh(why) }
 */
const fs = require('fs');
const path = require('path');
const LG = require('./look-guard');

const DARK = Object.freeze({
  blurPx: 5, dim: 0.50, panel: 0,
  // the stylesheet's dark values (ui/shared/glass-light.css :root[data-theme="dark"]); panel adds to these
  fills: { '--lg-fill': [19, 20, 21, 0.83], '--lg-fill-pop': [19, 20, 21, 0.88], '--lg-card': [40, 41, 43, 0.62], '--lg-field': [10, 11, 12, 0.46] },
  bar: [9, 10, 11],
});
const PANEL_CLAMP = [0.30, 0.97];
const GUARD_GRACE_MS = 4000;   // a republish takes ~1 s; a soft guard failure is said only after this
const APP = { helm: 'Helm', quartz: 'Quartz', mantle: 'Mantle' };

const a2 = (n) => String(Math.round(n * 100) / 100);
const words = (e) => (e && e.message ? e.message : String(e));
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

function makeLookHost(o) {
  const LS = o.LS;
  const say = (l) => { try { o.log(l); } catch (_) { /* never worth a failure */ } };
  const now = o.now || (() => new Date());
  const listeners = new Set();

  /* ---- the local copy ------------------------------------------------------ */
  const L = { lookSync: true, accent: clone(LS.SEED.accent), glass: clone(LS.SEED.glass) };
  let localNote = null;
  (function load() {
    let v;
    try { v = JSON.parse(fs.readFileSync(o.file, 'utf8')); } catch (e) {
      if (e && e.code === 'ENOENT') return;
      localNote = `Mantle's saved look could not be read (${e && e.code ? e.code : 'not valid JSON'}), so it starts from the defaults`;
      say(`look: ${localNote}`);
      return;
    }
    if (!v || typeof v !== 'object') return;
    if (typeof v.lookSync === 'boolean') L.lookSync = v.lookSync;
    if (v.accent !== undefined && !LS.checkValue('accent', v.accent)) L.accent = v.accent;
    if (v.glass !== undefined && !LS.checkValue('glass', v.glass)) L.glass = v.glass;
  })();
  function save() {
    try {
      fs.mkdirSync(path.dirname(o.file), { recursive: true });
      fs.writeFileSync(`${o.file}.tmp`, JSON.stringify(L, null, 2));
      fs.renameSync(`${o.file}.tmp`, o.file);
      localNote = null;
      return null;
    } catch (e) {
      localNote = `Mantle's own copy of the look could not be saved (${e && e.code ? e.code : words(e)})`;
      say(`look: ${localNote}`);
      return localNote;
    }
  }

  /* ---- the vars ------------------------------------------------------------ */
  function vars(theme) {
    const out = {};
    const hue = L.accent && Number.isInteger(L.accent.hue) ? L.accent.hue : null;
    if (theme === 'dark') {
      const g = (L.glass && L.glass.dark) || DARK;
      if (g.blurPx !== DARK.blurPx) out['--lg-blur'] = `blur(${a2(g.blurPx)}px)`;
      if (g.dim !== DARK.dim) out['--lg-fill-bar'] = `rgba(${DARK.bar.join(',')},${a2(g.dim)})`;
      if (g.panel !== DARK.panel) {
        for (const [k, [r, gg, b, al]] of Object.entries(DARK.fills)) {
          const v = Math.min(PANEL_CLAMP[1], Math.max(PANEL_CLAMP[0], al + g.panel));
          out[k] = `rgba(${r},${gg},${b},${a2(v)})`;
        }
      }
      if (hue !== null) {
        const t = o.accent.tokens(hue, 'dark');
        Object.assign(out, { '--lg-acc': t.acc, '--lg-acc-strong': t.strong, '--lg-acc-on': t.on, '--lg-acc-soft': t.soft,
          '--lg-acc-line': t.line, '--lg-acc-select': t.select,
          '--lg-focus': `0 0 0 1px rgba(20,21,22,.9), 0 0 0 3px rgba(${t.rgb.join(',')},.55)` });
      }
    }
    // light: NOTHING (Owen, 2026-10-10: the light look stays exactly as it is today until he says so).
    // glass.light and a set hue are carried in the shared file but never applied to Mantle's light look.
    return out;
  }

  /* ---- the sync instance ---------------------------------------------------- */
  const sync = LS.create({
    app: 'mantle', dir: o.dir, enabled: L.lookSync,
    local: () => ({ theme: o.theme.mode(), accent: clone(L.accent), glass: clone(L.glass) }),
  });
  let status = sync.status();
  let desktop = { desktop: { ok: null, text: 'Not shared yet', reason: null, rev: null, id: null, title: null, type: null },
    windows: { ok: null, text: 'Not checked yet', reason: null },
    guard: { ok: null, working: false, text: 'Not worked out yet', reason: null, alpha: null, contrast: null } };
  let applying = false;
  let softAt = null, softTimer = null;   // topGuard's grace for a soft failure (lane guard-mantle)
  const guardGraceMs = o.guardGraceMs > 0 ? o.guardGraceMs : GUARD_GRACE_MS;
  let lastMode = o.theme.mode();
  let lastVars = JSON.stringify([vars('dark'), vars('light')]);

  function emit(why) {
    const sig = JSON.stringify([vars('dark'), vars('light')]);
    const varsChanged = sig !== lastVars;
    lastVars = sig;
    for (const fn of Array.from(listeners)) {
      try { fn({ why, varsChanged, view: view() }); } catch (e) { say(`look: a listener threw: ${words(e)}`); }
    }
  }

  function applyChanges(e) {
    const ch = e && e.changes ? e.changes : {};
    const from = APP[e && e.by] || 'the shared look';
    const did = [];
    if (ch.accent !== undefined && JSON.stringify(ch.accent) !== JSON.stringify(L.accent)) { L.accent = clone(ch.accent); did.push(`accent ${L.accent.hue === null ? "Mantle's own" : `hue ${L.accent.hue}`}`); }
    if (ch.glass !== undefined && JSON.stringify(ch.glass) !== JSON.stringify(L.glass)) { L.glass = clone(ch.glass); const d = L.glass.dark; did.push(`glass blur ${d.blurPx} dim ${d.dim} panel ${d.panel}`); }
    if (did.length) save();
    if (ch.theme !== undefined && ch.theme !== o.theme.mode()) {
      applying = true;
      try {
        const r = o.theme.set(ch.theme);
        if (r && r.ok === false) say(`look: the shared theme ${ch.theme} could not be applied: ${r.reason}`);
        else did.push(`theme ${ch.theme}`);
      } catch (err) { say(`look: applying the shared theme threw: ${words(err)}`); } finally { applying = false; }
      lastMode = o.theme.mode();
    }
    if (did.length) say(`look: following ${from} (${e.cause || 'remote'}, rev ${e.rev}): ${did.join(', ')}`);
    emit('apply');
  }
  sync.on('apply', applyChanges);
  sync.on('status', (s) => { status = s; emit('status'); });
  // the desktop record changed on disk (not by this Mantle's own write): the top bar re-decides its darkening
  sync.on('desktop', () => emit('desktop'));

  /* ---- what Mantle's own changes do ----------------------------------------- */
  /** main.js calls this from the theme core's listener: a theme Owen picked in Mantle is shared. */
  function themeChanged(v) {
    const mode = v && v.mode;
    if (applying || !mode || mode === lastMode) { emit('theme'); return; }
    lastMode = mode;
    if (sync.enabled) {
      sync.publish('theme', mode).then((r) => { if (!r.ok) say(`look: the theme could not be shared: ${r.reason}`); emit('theme'); });
    }
    emit('theme');
  }

  async function share(field, value) {
    if (!sync.enabled) return null;
    const r = await sync.publish(field, value);
    return r.ok ? null : `Saved in Mantle, but not shared: ${r.reason}`;
  }

  async function setGlass(patch) {
    if (!patch || typeof patch !== 'object') return { ok: false, reason: 'the glass change came without values' };
    if (status.state === 'newer') return { ok: false, reason: status.reason || 'The shared look is from a newer version; update Mantle' };
    const dark = Object.assign({}, L.glass.dark);
    for (const k of ['blurPx', 'dim', 'panel']) if (patch[k] !== undefined) dark[k] = typeof patch[k] === 'number' ? patch[k] : NaN;
    const next = Object.assign(clone(L.glass), { dark });
    const bad = LS.checkValue('glass', next);
    if (bad) return { ok: false, reason: bad.replace(/^glass\.dark\./, '') };
    L.glass = next;
    save();
    say(`look: dark glass set in Mantle: blur ${dark.blurPx} dim ${dark.dim} panel ${dark.panel}`);
    emit('glass');
    const note = await share('glass', L.glass);
    emit('glass');
    return Object.assign(view(), note ? { note } : {});
  }

  async function setAccent(hue) {
    if (status.state === 'newer') return { ok: false, reason: status.reason || 'The shared look is from a newer version; update Mantle' };
    const v = { hue: hue === undefined ? null : hue };
    const bad = LS.checkValue('accent', v);
    if (bad) return { ok: false, reason: bad };
    L.accent = v;
    save();
    say(`look: accent set in Mantle: ${v.hue === null ? "Mantle's own" : `hue ${v.hue}`}`);
    emit('accent');
    const note = await share('accent', L.accent);
    emit('accent');
    return Object.assign(view(), note ? { note } : {});
  }

  async function setSync(on) {
    if (typeof on !== 'boolean') return { ok: false, reason: 'the switch needs on or off' };
    L.lookSync = on;
    const err = save();
    const r = await sync.setEnabled(on);
    say(`look: sync with Helm and Quartz turned ${on ? 'on' : 'off'}${r && r.ok === false ? ` (${r.reason})` : ''}`);
    emit('sync');
    return Object.assign(view(), err ? { note: `${on ? 'On' : 'Off'} now, but ${err.charAt(0).toLowerCase()}${err.slice(1)}, so it goes back at the next start` } : {});
  }

  /* ---- the view (Mantle Settings) -------------------------------------------- */
  function syncText() {
    const s = status;
    const own = localNote ? `. ${localNote}` : '';
    if (!sync.enabled || s.state === 'off') return `Off: Mantle keeps its own look${own}`;
    const when = (() => {
      if (!s.at) return '';
      const d = new Date(s.at);
      if (Number.isNaN(d.getTime())) return '';
      return ` at ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    })();
    if (s.state === 'ok') {
      const who = s.by ? `last change from ${APP[s.by] || s.by}${when}` : 'no change yet';
      return `On · in sync (${who}, rev ${s.rev})${s.reason ? `. ${s.reason}` : ''}${own}`;
    }
    if (s.state === 'missing') return `On · not shared yet${s.reason && s.reason !== 'Not shared yet' ? `: ${s.reason.replace(/^Not shared yet:\s*/, '')}` : ''}`;
    if (s.state === 'newer') return 'On · read only: the shared look is from a newer version';
    if (s.state === 'corrupt') return 'On · the shared look file was damaged';
    return 'On · not shared';
  }
  function view() {
    const s = status;
    const st = !sync.enabled ? 'off' : s.state;
    return {
      ok: true,
      theme: o.theme.resolved(),
      sync: { on: !!sync.enabled, state: st, text: syncText(), reason: st === 'ok' || st === 'off' ? (localNote || null) : (s.reason || localNote || null),
        rev: Number.isInteger(s.rev) ? s.rev : null, by: s.by ? (APP[s.by] || s.by) : null, at: s.at || null },
      glass: clone(L.glass.dark),
      ranges: clone(LS.RANGES),
      accent: clone(L.accent),
      desktop: Object.assign({}, desktop.desktop),
      windows: Object.assign({}, desktop.windows),
      lock: Object.assign({}, desktop.lock || {}),
      guard: Object.assign({}, desktop.guard || {}),
    };
  }

  return {
    sync,
    vars,
    view,
    themeChanged,
    setGlass,
    setAccent,
    setSync,
    onChange(fn) { if (typeof fn !== 'function') throw new Error('look.onChange needs a function'); listeners.add(fn); return () => listeners.delete(fn); },
    /** lib/look-desktop.js's state, for the view. */
    setDesktop(st) { if (st && st.desktop && st.windows) { desktop = Object.assign({ guard: desktop.guard }, st); emit('desktop'); } },
    /** The dark glass the shared top-band darkening is worked out for: the SHARED one (what Helm and
     * Quartz check it against), else Mantle's own when there is no shared file yet. -> {dim, blurPx, from} */
    guardGlass() {
      const sh = sync.shared();
      const d = sh && sh.glass && sh.glass.v && sh.glass.v.dark;
      if (d && typeof d.dim === 'number' && typeof d.blurPx === 'number') return { dim: d.dim, blurPx: d.blurPx, from: 'shared' };
      const own = (L.glass && L.glass.dark) || DARK;
      return { dim: own.dim, blurPx: own.blurPx, from: 'mantle' };
    },
    /** What the TOP BAR does in `theme` (lib/look-guard.js use): dark + sync on = the shared alpha,
     * checked against the glass Mantle shows now; else its own guard, with the reason. */
    topGuard(theme) {
      let record = null;
      try { record = sync.desktop().record; } catch (_) { record = null; }
      const g = (L.glass && L.glass.dark) || DARK;
      const u = LG.use({ dark: theme === 'dark', syncOn: !!sync.enabled, record, glass: { dim: g.dim, blurPx: g.blurPx }, working: !!(desktop.guard && desktop.guard.working) });
      // a SOFT failure (no record / no guard yet, or stale before the publisher has reacted to a glass
      // change) is held as "being worked out" for GUARD_GRACE_MS; then, if it still holds, it is said
      if (!(u.failure && u.soft)) { softAt = null; return u; }
      const t = Date.now();
      if (softAt === null) softAt = t;
      const left = softAt + guardGraceMs - t;
      if (left <= 0) return u;
      if (!softTimer) {
        softTimer = setTimeout(() => { softTimer = null; emit('guard'); }, left + 20);
        if (softTimer.unref) softTimer.unref();
      }
      return { use: false, why: 'the shared darkening is being worked out', failure: false };
    },
    start() { sync.start(); say(`look: sync with Helm and Quartz is ${sync.enabled ? 'on' : 'off'}; shared folder ${sync.dir.replace(/^.*[\\/](look-sync[^\\/]*)$/, '$1')}`); return this; },
    refresh(why) { say(`look: re-reading the shared look (${why})`); sync.refresh(); },
    close() { sync.close(); listeners.clear(); clearTimeout(softTimer); softTimer = null; },
    _local: () => clone(L),
  };
}

module.exports = { makeLookHost, DARK, PANEL_CLAMP, GUARD_GRACE_MS };

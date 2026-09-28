'use strict';
/*
 * lib/features.js - the main-process half of the feature seam (wave 3, 2026-09-24).
 *
 * WHY: Owen asked for a round of Windows replacements at once (volume pop-up, power mode, Win+S
 * search, Win+V clipboard, snapping, Task View, Win+Shift+S screenshots, a top menu bar). Each
 * used to mean edits to main.js, which eight lanes cannot share. Now a feature is ONE file,
 * lib/features/<name>.js, found here at start-up, plus its own ui/<name>/ pages and its own
 * sidecar/<Name>.cs (sidecar/Features.cs is the sidecar half). The API every feature codes
 * against is lib/features/README.md; this file is what keeps its promises:
 *
 *   ISOLATION  a feature that fails to load, throws in install(), or throws in a chord handler is
 *              that feature down with its reason on the desktop strip and in the tray - never a
 *              crashed Mantle, and never another feature down.
 *   KEYS       a chord is taken from Windows only while its feature is ON (tray checkbox) AND
 *              healthy (ctx.health) AND Mantle is live. Anything else and Windows has the key
 *              (the hook never even sees it as a chord). Observed keys are never taken at all.
 *   EXIT       every stop() runs on Mantle's "put Windows back" road, all at once, each with its
 *              own deadline: a stop() that throws or hangs is logged and never holds up the quit.
 */
const fs = require('fs');
const path = require('path');

/** The protocol's names (sidecar/AltTab.cs KeyMachine.ChordNames / KeyNames, same order). */
// The bare volume keys are chords too (osd lane, 2026-09-24): Windows' own flyout host cannot be
// found on 25H2 to hide, so the only way to show Mantle's pop-up and not Windows' is to take the key.
// Unlike a Win chord, a held VolumeUp/VolumeDown is one event PER REPEAT (KeyMachine.ChordRepeats).
// Win+Alt+T (lane tbvideo, 2026-09-26): the top bar's hide / show toggle; Alt held is part of it.
// Win+Ctrl+T (lane ontop, 2026-09-27): keep the window in front on top; Ctrl held is part of it.
// Win+Alt+N (lane tbtools, 2026-09-27): the quick notes pad; Alt held is part of it, as Win+Alt+T.
const CHORDS = ['Win+S', 'Win+V', 'Win+Tab', 'Win+Left', 'Win+Right', 'Win+Up', 'Win+Down', 'Win+Z', 'Win+Shift+S', 'PrintScreen',
  'VolumeUp', 'VolumeDown', 'VolumeMute', 'Win+Alt+T', 'Win+Ctrl+T', 'Win+Alt+N'];
const KEYS = ['VolumeUp', 'VolumeDown', 'VolumeMute'];
const NAME_RE = /^[a-z][a-z0-9]*$/;
const VERB_RE = /^[a-zA-Z][a-zA-Z0-9_.-]*$/;
// Names a feature may not take: Mantle's own command prefixes and event names already mean
// something, and a feature's name is its command prefix.
const RESERVED = new Set(['features', 'state', 'sys', 'windows', 'bar', 'launcher', 'desktop', 'switcher', 'notifs',
  'qs', 'wallpaper', 'shell', 'tray', 'media', 'battery', 'volume', 'net', 'apps', 'mantle', 'test']);
const STOP_MS = 2500;          // per feature; they run at once, so this is also the whole wait
const INSTALL_MS = 10000;      // an async install() that never settles is a feature that is down
const APPLY_COALESCE_MS = 30;  // several health() calls in one tick become ONE hotkey call

function words(err) { return err && err.message ? err.message : String(err); }
function oneLine(s) { return String(s).replace(/\s*[\r\n]+\s*/g, ' ').trim(); }

/**
 * Check a module against the contract. Returns null or the plain-words reason it is not usable.
 * PURE (lib/features.test.js).
 */
function validate(mod, fileBase) {
  if (!mod || typeof mod !== 'object') return 'it does not export an object';
  if (typeof mod.name !== 'string' || !NAME_RE.test(mod.name)) return `its name ${JSON.stringify(mod.name)} is not lower-case letters and digits`;
  if (fileBase && mod.name !== fileBase) return `its name "${mod.name}" is not its file name "${fileBase}" (lib/features/<name>.js)`;
  if (RESERVED.has(mod.name)) return `its name "${mod.name}" is one of Mantle's own command prefixes`;
  if (typeof mod.label !== 'string' || !mod.label.trim()) return 'it has no label (the tray checkbox text)';
  if (typeof mod.defaultOn !== 'boolean') return 'defaultOn must be true or false';
  for (const [key, known] of [['chords', CHORDS], ['observe', KEYS]]) {
    const list = mod[key] === undefined ? [] : mod[key];
    if (!Array.isArray(list)) return `${key} must be a list`;
    for (const n of list) if (!known.includes(n)) return `${key} names "${n}", which is not one of ${known.join(', ')}`;
    if (new Set(list).size !== list.length) return `${key} lists the same name twice`;
  }
  const both = (mod.chords || []).find((n) => (mod.observe || []).includes(n));
  if (both) return `it lists ${both} as a chord AND an observed key (a taken key is already delivered to it)`;
  if (typeof mod.install !== 'function') return 'it has no install(ctx) function';
  if (mod.rest !== undefined && typeof mod.rest !== 'boolean') return 'rest must be true or false';
  return null;
}

/**
 * The plain-words state of one feature, for the state piece `features.<name>`. PURE.
 *   on: the tray switch; ok: healthy (its own word, or it failed to load/install); reason;
 *   keys: its chords are Windows' or Mantle's right now; keysReason; broken: the words for a
 *   chord that SHOULD be Mantle's and is not (a fault), else null; stopped: after stop().
 */
function pieceWords(f, x) {
  const p = { label: f.label, on: !!f.enabled, ok: f.ok !== false, reason: f.reason || '', keys: false, keysReason: '', broken: null, stopped: !!f.stopped && !f.resting };
  if (f.resting) p.resting = f.resting;
  const chords = f.chords || [];
  if (!chords.length) { p.keysReason = 'it takes no keys from Windows'; return p; }
  const list = chords.join(', ');
  if (f.resting) p.keysReason = `${list}: Windows' own while Mantle rests (${f.resting})`;
  else if (f.stopped) p.keysReason = `${list}: Windows' own (the feature was stopped)`;
  else if (!f.enabled) p.keysReason = `${list}: Windows' own (turned off in the tray menu)`;
  else if (!p.ok) p.keysReason = `${list}: Windows' own until it is healthy again`;
  else if (x.test) p.keysReason = `${list}: Windows' own (test mode never hooks the keyboard; ctx.test.fireChord drives it)`;
  else if (!x.live) p.keysReason = `${list}: Windows' own (${x.releasedWhy || 'Mantle has not taken the shell yet'})`;
  else if (x.sidecarDown) p.keysReason = `${list}: Windows' own (${x.sidecarDown})`;
  else if (x.taken && chords.every((c) => x.taken.has(c))) { p.keys = true; p.keysReason = `${list}: Mantle's`; }
  else if (x.err) { p.keysReason = `${list}: still Windows' own: ${x.err}`; p.broken = p.keysReason; }
  else if (x.applying) p.keysReason = `${list}: being taken from Windows`;
  else { p.keysReason = `${list}: still Windows' own: the sidecar has not confirmed the keyboard hook took them`; p.broken = p.keysReason; }
  return p;
}

function createFeatures(opts) {
  const o = opts;
  const flags = { test: !!o.test, live: !o.test };
  const log = o.log || ((line) => process.stdout.write(`mantle: ${line}\n`));
  const features = new Map();          // name -> record
  const claims = new Map();            // chord -> feature name
  const K = {
    live: false, releasedWhy: null, sidecarDown: null,
    taken: null,                        // Set of chords the sidecar last said it holds, or null
    err: null, applying: 0, lastSent: null, timer: null, stopping: null,
  };

  const settingsDir = path.join(o.userData, 'features');
  const switchesFile = path.join(o.userData, 'features.json');
  let switches = {};
  try { switches = JSON.parse(fs.readFileSync(switchesFile, 'utf8')) || {}; } catch (_) { switches = {}; }

  function saveSwitches() {
    try {
      fs.mkdirSync(path.dirname(switchesFile), { recursive: true });
      fs.writeFileSync(switchesFile + '.tmp', JSON.stringify(switches, null, 2));
      fs.renameSync(switchesFile + '.tmp', switchesFile);
      return null;
    } catch (err) {
      return words(err);
    }
  }

  function publish(f) {
    const piece = pieceWords(f, { test: flags.test, live: K.live, releasedWhy: K.releasedWhy, sidecarDown: K.sidecarDown,
      taken: K.taken, err: K.err, applying: K.applying > 0 });
    const cur = o.state.get().features || {};
    if (JSON.stringify(cur[f.name]) === JSON.stringify(piece)) return;
    o.state.set('features', { [f.name]: piece });
  }
  function publishAll() { for (const f of features.values()) publish(f); }

  /* ---- the keyboard: what the hook should take, and telling the sidecar ---- */

  function wanted() {
    const chords = new Set();
    const observe = new Set();
    for (const f of features.values()) {
      if (!f.running || f.stopped || !f.enabled) continue;
      for (const k of f.observe) observe.add(k);
      if (f.ok === false) continue;
      for (const c of f.chords) chords.add(c);
    }
    // Table order, so the same set is always the same request.
    return { chords: CHORDS.filter((c) => chords.has(c)), observe: KEYS.filter((k) => observe.has(k)) };
  }

  function scheduleApply(why) {
    if (K.timer) return;
    K.timer = setTimeout(() => { K.timer = null; apply(why).catch((err) => log(`features: applying the keys threw: ${words(err)}`)); }, APPLY_COALESCE_MS);
    if (K.timer.unref) K.timer.unref();
  }

  async function apply(why) {
    if (flags.test || !K.live || K.stopping) { publishAll(); return; }
    const want = wanted();
    const key = JSON.stringify(want);
    if (key === K.lastSent && !K.err) { publishAll(); return; }
    // Nothing wanted and nothing ever sent to THIS sidecar process: it holds no chords already, so
    // there is no call to make (deploying the seam with no features changes nothing at all).
    if (!want.chords.length && !want.observe.length && K.lastSent === null && !K.err) { K.lastSent = key; K.taken = new Set(); publishAll(); return; }
    const blocked = o.sidecar.blockedReason();
    if (blocked) { K.sidecarDown = `the sidecar cannot be asked: ${blocked}`; publishAll(); return; }
    K.applying++;
    publishAll();
    try {
      const r = await o.sidecar.call('hotkey', want, 4000);
      K.lastSent = key;
      K.err = null;
      onHook(r);
      log(`features: keys ${why}: taking ${want.chords.join(', ') || 'no chords'}; watching ${want.observe.join(', ') || 'no keys'}`);
    } catch (err) {
      const m = words(err);
      // An exe from before the seam answers a chords-only request with the old complaint.
      K.err = /needs winTap/.test(m) ? `the sidecar exe predates feature chords (it said: ${m}): run npm run build:sidecar` : m;
      K.lastSent = null;
      log(`features: keys ${why}: the sidecar would not take them: ${K.err}`);
    } finally {
      K.applying--;
    }
    publishAll();
  }

  /** The sidecar's word on the hook ({installed, chords, reason}), from a reply or a push. */
  function onHook(h) {
    if (!h || typeof h !== 'object') return;
    K.taken = new Set(h.installed && Array.isArray(h.chords) ? h.chords : []);
    if (!h.installed && h.reason && wanted().chords.length && K.live) K.err = h.reason;
    publishAll();
  }

  /* ---- routing: the hook (or a test) says a chord / key happened ---- */

  function runHandler(f, what, fn, arg) {
    try {
      const r = fn(arg);
      if (r && typeof r.then === 'function') {
        r.catch((err) => handlerFailed(f, what, err));
      }
    } catch (err) {
      handlerFailed(f, what, err);
    }
  }
  function handlerFailed(f, what, err) {
    log(`${f.name}: its ${what} handler threw: ${err && err.stack ? err.stack : err}`);
    // A feature that cannot answer its own key gives the key back to Windows (NO SILENT
    // FAILURES: the strip says so). The feature may call ctx.health(true) once it recovers.
    setHealth(f, false, `its ${what} handler failed (${oneLine(words(err))}), so its keys went back to Windows`);
  }

  function routeChord(chord, via) {
    const name = claims.get(chord);
    const f = name && features.get(name);
    if (!f) { log(`features: ${chord} arrived (${via}) but no feature claims it`); return { delivered: false, reason: 'no feature claims it' }; }
    const why = f.stopped ? 'it was stopped' : !f.running ? 'it is not running' : !f.enabled ? 'it is turned off'
      : f.ok === false ? `it is not healthy (${f.reason})` : null;
    if (why) {
      log(`${f.name}: ${chord} arrived (${via}) but ${why}; Windows keeps it from now on`);
      if (!flags.test) scheduleApply(`${chord} arrived for a feature that cannot take it`);
      return { delivered: false, reason: why };
    }
    const hs = f.chordHandlers.get(chord);
    if (!hs || !hs.size) {
      log(`${f.name}: ${chord} arrived (${via}) and it has no onChord handler for it`);
      return { delivered: false, reason: 'the feature has no handler for it' };
    }
    for (const fn of Array.from(hs)) runHandler(f, chord, fn, chord);
    // A taken volume key never reaches the hook's observe check (the chord swallowed it), so the
    // features that only OBSERVE that key hear it from here: observing stays "every keydown".
    if (KEYS.includes(chord)) routeKey(chord, 'chord', f.name);
    return { delivered: true, feature: f.name };
  }

  function routeKey(key, via, skip) {
    let n = 0;
    for (const f of features.values()) {
      if (f.name === skip) continue;
      if (!f.running || f.stopped || !f.enabled || !f.observe.includes(key)) continue;
      const hs = f.keyHandlers.get(key);
      if (!hs) continue;
      for (const fn of Array.from(hs)) { runHandler(f, key, fn, key); n++; }
    }
    if (!n && via !== 'hook' && via !== 'chord') log(`features: ${key} (${via}) reached no handler`);
    return { delivered: n > 0, handlers: n };
  }

  /* ---- one feature ---- */

  function setHealth(f, ok, reason) {
    const nextOk = ok !== false;
    const nextReason = reason ? oneLine(reason) : (nextOk ? 'working' : 'not working, and the feature did not say why');
    if (f.ok === nextOk && f.reason === nextReason) return;
    const flipped = f.ok !== nextOk;
    f.ok = nextOk;
    f.reason = nextReason;
    if (flipped) log(`${f.name}: ${nextOk ? 'healthy' : 'NOT healthy'}: ${nextReason}`);
    publish(f);
    if (flipped && f.chords.length) scheduleApply(`${f.name} is ${nextOk ? 'healthy' : 'not healthy'}`);
  }

  function setEnabled(name, on, who) {
    const f = features.get(name);
    if (!f || f.enabled === !!on) return;
    f.enabled = !!on;
    switches[name] = f.enabled;
    const err = saveSwitches();
    log(`${name}: turned ${f.enabled ? 'on' : 'off'} by ${who}${err ? ` (NOT saved for next time: ${err})` : ''}`);
    for (const fn of Array.from(f.enabledHandlers)) runHandler(f, 'onEnabled', fn, f.enabled);
    publish(f);
    scheduleApply(`${name} turned ${f.enabled ? 'on' : 'off'}`);
  }

  function settingsFor(f) {
    const file = path.join(settingsDir, `${f.name}.json`);
    let cache = null;
    const load = () => {
      if (cache) return cache;
      try { cache = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch (_) { cache = {}; }
      return cache;
    };
    return {
      get(key, dflt) {
        const v = load()[key];
        return v === undefined ? dflt : JSON.parse(JSON.stringify(v));
      },
      set(key, value) {
        const all = load();
        if (value === undefined) delete all[key];
        else all[key] = JSON.parse(JSON.stringify(value));   // JSON-only, and never shared by reference
        try {
          fs.mkdirSync(settingsDir, { recursive: true });
          fs.writeFileSync(file + '.tmp', JSON.stringify(all, null, 2));
          fs.renameSync(file + '.tmp', file);
        } catch (err) {
          throw new Error(`${f.name}: the setting "${key}" could not be saved (${words(err)})`);
        }
        return value;
      },
      file,
    };
  }

  function makeCtx(f) {
    const own = (list, what, n) => {
      if (!list.includes(n)) throw new Error(`${f.name}: ${what}("${n}") but its module does not list "${n}" in ${what === 'onChord' ? 'chords' : 'observe'}`);
    };
    const subscribe = (map, n, fn) => {
      if (typeof fn !== 'function') throw new Error(`${f.name}: a handler must be a function`);
      let s = map.get(n);
      if (!s) { s = new Set(); map.set(n, s); }
      s.add(fn);
      return () => s.delete(fn);
    };
    const ctx = {
      name: f.name,
      flags: Object.freeze(Object.assign({}, flags)),
      log: (text) => log(`${f.name}: ${oneLine(text)}`),
      sidecar: {
        send(cmd, args, sopts) {
          const ms = sopts && sopts.timeoutMs ? sopts.timeoutMs : 4000;
          return o.sidecar.call(cmd, args || {}, ms).then(
            (result) => ({ ok: true, result }),
            (err) => ({ ok: false, error: words(err) }));
        },
        on(ev, fn) {
          if (typeof fn !== 'function') throw new Error(`${f.name}: sidecar.on needs a function`);
          const wrapped = (msg) => { if (!f.stopped) runHandler(f, `sidecar "${ev}"`, fn, msg); };
          o.sidecar.on(ev, wrapped);
          const off = () => { o.sidecar.removeListener(ev, wrapped); f.offs.delete(off); };
          f.offs.add(off);
          return off;
        },
        /** fn() now if the sidecar is up, and after every (re)start: re-apply sidecar-side state here. */
        onReady(fn) {
          const off = ctx.sidecar.on('ready', () => fn());
          if (!o.sidecar.blockedReason()) runHandler(f, 'sidecar.onReady', fn);
          return off;
        },
        get ready() { return !o.sidecar.blockedReason(); },
      },
      command(verb, fn) {
        if (typeof verb !== 'string' || !VERB_RE.test(verb)) throw new Error(`${f.name}: command verb ${JSON.stringify(verb)} is not a plain word`);
        if (typeof fn !== 'function') throw new Error(`${f.name}: command "${verb}" needs a function`);
        const full = `${f.name}.${verb}`;
        if (o.commands[full]) throw new Error(`${f.name}: the command "${full}" already exists`);
        o.commands[full] = async (args) => {
          if (f.stopped) throw new Error(`${f.label} is stopped (Mantle put Windows back)`);
          return fn(args || {});
        };
        f.commands.add(full);
        return full;
      },
      onChord(chord, fn) { own(f.chords, 'onChord', chord); return subscribe(f.chordHandlers, chord, fn); },
      onKey(key, fn) { own(f.observe, 'onKey', key); return subscribe(f.keyHandlers, key, fn); },
      /** Run the feature that owns `chord` as if it was pressed (lane corners: the top-left hot corner
       * opens Task view through Win+Tab's own handler). o2.dryRun only says whether it could. Never
       * throws: -> {delivered:true, feature} or {delivered:false, reason}. No key is taken or sent. */
      runChord(chord, via, o2) {
        if (!CHORDS.includes(chord)) return { delivered: false, reason: `"${chord}" is not a chord` };
        const g = features.get(claims.get(chord));
        const why = !g ? `no feature takes ${chord}` : g.stopped ? `${g.label} is stopped${g.resting ? ` (${restWords(g.resting)})` : ''}`
          : !g.running ? `${g.label} is not running` : !g.enabled ? `${g.label} is switched off in the tray`
          : g.ok === false ? `${g.label} is not healthy (${g.reason})` : null;
        if (why) return { delivered: false, reason: why };
        const hs = g.chordHandlers.get(chord);
        if (!hs || !hs.size) return { delivered: false, reason: `${g.label} has no handler for ${chord}` };
        if (o2 && o2.dryRun) return { delivered: false, dryRun: true, feature: g.name };
        log(`${g.name}: ${chord} run by ${f.name} (${via || 'no reason given'})`);
        for (const fn of Array.from(hs)) runHandler(g, chord, fn, chord);
        return { delivered: true, feature: g.name };
      },
      health(ok, reason) { setHealth(f, ok, reason); },
      enabled() { return f.enabled; },
      onEnabled(fn) {
        if (typeof fn !== 'function') throw new Error(`${f.name}: onEnabled needs a function`);
        f.enabledHandlers.add(fn);
        return () => f.enabledHandlers.delete(fn);
      },
      page(file) { return path.join(o.root, 'ui', f.name, file || 'index.html'); },
      preload: path.join(o.root, 'preload.js'),
      broadcast(event, payload) { o.broadcast(event, payload); },
      push(win, event, payload) {
        if (!win || win.isDestroyed() || !win.webContents || win.webContents.isDestroyed()) return false;
        try { win.webContents.send('mantle:event', { name: event, payload }); return true; } catch (_) { return false; }
      },
      /** mantle.on('<name>.<x>') in a page replays fn()'s value on subscribe (no empty first frame). */
      replay(event, fn) {
        if (typeof event !== 'string' || !event.startsWith(`${f.name}.`)) throw new Error(`${f.name}: replay events must start with "${f.name}."`);
        if (typeof fn !== 'function') throw new Error(`${f.name}: replay needs a function`);
        f.replays.set(event, fn);
        return () => f.replays.delete(event);
      },
      host: {
        openLauncher(a) { return o.host.openLauncher(Object.assign({ mode: 'apps', query: '' }, a || {}), f.name); },
        barRect() { return o.host.barRect(); },
        display() { return o.host.display(); },
        /** Mantle rests while a game runs (game mode's watch drives it): closes the hidden windows
         * and gives their keys back to Windows; rest(false) brings everything back. */
        rest(on, why) { return o.host.rest ? o.host.rest(!!on, why, f.name) : Promise.resolve({ ok: false, reason: 'this Mantle has no rest' }); },
        /** main.js's last NOW PLAYING read ({ok, reason, sessions:[{aumid, status, playing, ...}]}) or null. */
        media() { return o.host.media ? o.host.media() : null; },
        /** fn(payload) after every NOW PLAYING read; returns the unsubscribe (call it in stop()). */
        onMedia(fn) { return o.host.onMedia ? o.host.onMedia((p) => runHandler(f, 'host.onMedia', () => fn(p))) : () => {}; },
      },
      settings: settingsFor(f),
      test: flags.test ? {
        fireChord(chord) { return fireChord(chord, `${f.name} (test)`); },
        fireKey(key) { return fireKey(key, `${f.name} (test)`); },
      } : null,
    };
    return ctx;
  }

  function record(name, label) {
    return {
      name, label: label || name, file: null, mod: null, chords: [], observe: [], enabled: true, ok: true, reason: 'starting',
      running: false, stopped: false, rest: false, resting: null, restP: null, handle: null, chordHandlers: new Map(), keyHandlers: new Map(),
      enabledHandlers: new Set(), offs: new Set(), commands: new Set(), replays: new Map(),
    };
  }

  function fail(f, reason) {
    f.ok = false;
    f.reason = oneLine(reason);
    f.running = false;
    log(`${f.name}: NOT started: ${f.reason}`);
    publish(f);
  }

  function installOne(f) {
    let ret;
    try {
      ret = f.mod.install(makeCtx(f));
    } catch (err) {
      fail(f, `it could not start: install() threw ${oneLine(words(err))}`);
      if (err && err.stack) log(`${f.name}: ${err.stack}`);
      return;
    }
    f.running = true;
    if (f.reason === 'starting') f.reason = 'working';
    const took = (h) => {
      if (f.stopped) return;
      if (h && typeof h.stop !== 'function') log(`${f.name}: install() returned no stop(); nothing will be put back for it on exit`);
      f.handle = h || null;
    };
    if (ret && typeof ret.then === 'function') {
      const t = setTimeout(() => { if (!f.handle && f.running) setHealth(f, false, `install() did not finish within ${INSTALL_MS / 1000} s`); }, INSTALL_MS);
      if (t.unref) t.unref();
      ret.then((h) => { clearTimeout(t); took(h); }, (err) => {
        clearTimeout(t);
        f.running = false;
        fail(f, `it could not start: install() failed: ${words(err)}`);
        scheduleApply(`${f.name} failed to start`);
      });
    } else {
      took(ret);
    }
    publish(f);
  }

  /* ---- the whole set ---- */

  function load() {
    let files = [];
    try {
      files = fs.readdirSync(o.dir).filter((n) => n.endsWith('.js') && !n.endsWith('.test.js') && !n.startsWith('_') && !n.startsWith('.')).sort();
    } catch (err) {
      log(`features: could not read ${o.dir} (${words(err)}); no features were loaded`);
      o.state.set('features', {});
      return [];
    }
    for (const file of files) {
      const base = file.slice(0, -3);
      let mod;
      const f0 = record(base, base);
      try {
        mod = require(path.join(o.dir, file));
      } catch (err) {
        features.set(base, f0);
        fail(f0, `lib/features/${file} would not load: ${oneLine(words(err))}`);
        continue;
      }
      const bad = validate(mod, base);
      if (bad) { features.set(base, f0); fail(f0, `lib/features/${file} breaks the feature contract: ${bad}`); continue; }
      const f = record(mod.name, mod.label);
      f.file = file;
      f.mod = mod;
      f.chords = (mod.chords || []).slice();
      f.observe = (mod.observe || []).slice();
      f.rest = mod.rest === true;
      f.enabled = typeof switches[f.name] === 'boolean' ? switches[f.name] : mod.defaultOn;
      features.set(f.name, f);
      const clash = Object.keys(o.commands).find((k) => k.startsWith(`${f.name}.`));
      if (clash) { fail(f, `its name clashes with Mantle's own command "${clash}"`); continue; }
      const taken = f.chords.find((c) => claims.has(c));
      if (taken) { fail(f, `${taken} is already taken by ${claims.get(taken)}`); continue; }
      for (const c of f.chords) claims.set(c, f.name);
    }
    for (const f of features.values()) if (f.mod && f.ok) installOne(f);
    publishAll();
    const up = Array.from(features.values()).filter((f) => f.running).map((f) => f.name);
    const down = Array.from(features.values()).filter((f) => !f.running).map((f) => f.name);
    log(`features: ${up.length ? `started ${up.join(', ')}` : 'none started'}${down.length ? `; NOT started: ${down.join(', ')}` : ''} (from ${o.dir})`);
    scheduleApply('the features started');
    return up;
  }

  function fireChord(chord, via) {
    if (!flags.test) throw new Error('fireChord is test-only (--test)');
    if (!CHORDS.includes(chord)) throw new Error(`"${chord}" is not a chord (${CHORDS.join(', ')})`);
    log(`features: ${chord} fired by ${via || 'a test'} (test mode: the hook never took it)`);
    return routeChord(chord, via || 'test');
  }
  function fireKey(key, via) {
    if (!flags.test) throw new Error('fireKey is test-only (--test)');
    if (!KEYS.includes(key)) throw new Error(`"${key}" is not an observed key (${KEYS.join(', ')})`);
    log(`features: ${key} fired by ${via || 'a test'} (test mode)`);
    return routeKey(key, via || 'test');
  }

  /**
   * Every stop(), at once, each with its own deadline. Never throws, never waits longer than
   * STOP_MS (plus a tick), and a second call returns the first one's promise.
   */
  function stopAll(why) {
    if (K.stopping) return K.stopping;
    if (K.timer) { clearTimeout(K.timer); K.timer = null; }
    // A resting feature was stopped already; it now stays down with Mantle.
    for (const f of features.values()) if (f.resting) { f.resting = null; f.stopped = true; publish(f); }
    const list = Array.from(features.values()).filter((f) => f.running && !f.stopped);
    K.stopping = Promise.all(list.map((f) => stopOne(f, why)));
    return K.stopping;
  }

  /* ---- resting while a game runs (lane memfix, 2026-09-26) ----
   * Owen closed Mantle to play Valorant: "it was taking up too much ram and it made my game stutter".
   * A feature whose module says `rest: true` is STOPPED while a game runs (stop(why, {rest:true})
   * destroys its windows, so each renderer process goes), its chords go back to Windows, and it
   * reads HEALTHY with the words "resting while <game> runs". wakeAll() installs it again: the same
   * install() as at start-up, so it comes back exactly as Mantle starts it. */
  const restWords = (why) => `resting while ${why}`;

  async function restAll(why) {
    if (K.stopping) return [];
    const list = Array.from(features.values()).filter((f) => f.rest && f.running && !f.stopped && !f.resting);
    await Promise.all(list.map(async (f) => {
      f.resting = why;
      f.restP = stopOne(f, restWords(why), { rest: true });
      await f.restP;
      f.restP = null;
      f.handle = null;
      f.replays.clear();
      // A page that still calls one of its commands hears why, in plain words.
      for (const full of f.commands) {
        o.commands[full] = async () => { throw new Error(`${f.label} is ${restWords(f.resting || why)}; it is back when the game exits`); };
      }
      f.ok = true;
      f.reason = restWords(f.resting || why);
      publish(f);
    }));
    scheduleApply(restWords(why));
    return list.map((f) => f.name);
  }

  async function wakeAll(why) {
    if (K.stopping) return [];
    const out = [];
    for (const f of Array.from(features.values()).filter((x) => x.resting)) {
      if (f.restP) await f.restP;
      if (K.stopping) break;
      f.resting = null;
      f.stopped = false;
      for (const full of f.commands) delete o.commands[full];
      f.commands.clear();
      f.reason = 'starting';
      log(`${f.name}: back (${why})`);
      installOne(f);
      out.push(f.name);
    }
    scheduleApply(`back (${why})`);
    return out;
  }

  /** One feature's stop(why, how) under the deadline; resolves {name, line}. how.rest: it is only
   * resting and is installed again after the game, so keep what must outlive a window. */
  function stopOne(f, why, how) {
    return new Promise((resolve) => {
      f.stopped = true;
      const t0 = Date.now();
      let settled = false;
      const done = (line) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        for (const off of Array.from(f.offs)) { try { off(); } catch (_) { /* already gone */ } }
        f.chordHandlers.clear(); f.keyHandlers.clear(); f.enabledHandlers.clear();
        f.running = false;
        log(`${f.name}: ${line}`);
        publish(f);
        resolve({ name: f.name, line });
      };
      const timer = setTimeout(() => done(`stop() did not finish within ${STOP_MS} ms; Mantle did not wait for it (${why})`), STOP_MS);
      if (!f.handle || typeof f.handle.stop !== 'function') { done(`stopped (it had no stop() to run) (${why})`); return; }
      try {
        Promise.resolve(f.handle.stop(why, how || {})).then(
          () => done(`stopped in ${Date.now() - t0} ms (${why})`),
          (err) => done(`stop() failed after ${Date.now() - t0} ms: ${oneLine(words(err))} (${why})`));
      } catch (err) {
        done(`stop() threw: ${oneLine(words(err))} (${why})`);
      }
    });
  }

  /* ---- main.js hooks ---- */

  o.sidecar.on('chord', (m) => { if (m && typeof m.chord === 'string') routeChord(m.chord, 'hook'); });
  o.sidecar.on('key', (m) => { if (m && typeof m.key === 'string') routeKey(m.key, 'hook'); });
  o.sidecar.on('switcher', (m) => { if (m && m.op === 'hook') onHook(m); });
  o.sidecar.on('status', ({ status, reason }) => {
    if (status === 'ok') { K.sidecarDown = null; publishAll(); return; }
    // The hook died with the sidecar's process: every chord is Windows' own again.
    K.sidecarDown = `the sidecar is not running (${reason})`;
    K.taken = null;
    K.lastSent = null;
    publishAll();
  });

  /** main.js applyLive: the sidecar is up and Mantle owns the shell (every sidecar start). */
  async function applyLive(why) {
    if (flags.test) { publishAll(); return; }
    K.live = true;
    K.releasedWhy = null;
    K.sidecarDown = null;
    K.lastSent = null;             // a new sidecar process has no chords, whatever we sent the last one
    await apply(why || 'Mantle took over the shell');
  }

  /** main.js markRestored: the restore path already cleared every chord with the hook. */
  function released(why) {
    K.live = false;
    K.releasedWhy = `Mantle put Windows back: ${why}`;
    K.taken = null;
    K.err = null;
    K.lastSent = null;
    publishAll();
  }

  function trayItems() {
    const out = [];
    for (const f of features.values()) {
      out.push({ label: f.label, type: 'checkbox', checked: !!f.enabled, enabled: !!f.mod && !f.stopped,
        click: (item) => setEnabled(f.name, !!item.checked, 'the tray menu') });
      const p = (o.state.get().features || {})[f.name];
      const line = p && p.on && !p.stopped ? (!p.ok ? p.reason : p.broken) : null;
      if (line) out.push({ label: `      ${line.length > 110 ? `${line.slice(0, 107)}...` : line}`, enabled: false });
    }
    return out;
  }

  function replay(name) {
    for (const f of features.values()) {
      const fn = f.replays.get(name);
      if (!fn) continue;
      try { return { has: true, payload: fn() }; } catch (err) { log(`${f.name}: replay("${name}") threw: ${words(err)}`); return { has: false }; }
    }
    return null;
  }

  function list() {
    return Array.from(features.values()).map((f) => ({ name: f.name, label: f.label, chords: f.chords, observe: f.observe,
      enabled: f.enabled, ok: f.ok, reason: f.reason, running: f.running, stopped: f.stopped, resting: f.resting, commands: Array.from(f.commands) }));
  }

  return { load, applyLive, released, stopAll, restAll, wakeAll, resting: () => Array.from(features.values()).filter((f) => f.resting).map((f) => f.name), trayItems, replay, list, fireChord, fireKey, setEnabled, wanted,
    get size() { return features.size; } };
}

module.exports = { createFeatures, validate, pieceWords, CHORDS, KEYS };

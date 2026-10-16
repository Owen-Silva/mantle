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
const plainError = require('./plain-error');

/** The protocol's names (sidecar/AltTab.cs KeyMachine.ChordNames / KeyNames, same order). */
// The bare volume keys are chords too (osd lane, 2026-09-24): Windows' own flyout host cannot be
// found on 25H2 to hide, so the only way to show Mantle's pop-up and not Windows' is to take the key.
// Unlike a Win chord, a held VolumeUp/VolumeDown is one event PER REPEAT (KeyMachine.ChordRepeats).
// Win+Alt+T (lane tbvideo, 2026-09-26): the top bar's hide / show toggle; Alt held is part of it.
// Win+Ctrl+T (lane ontop, 2026-09-27): keep the window in front on top; Ctrl held is part of it.
// Win+Alt+N (lane tbtools, 2026-09-27): the quick notes pad; Alt held is part of it, as Win+Alt+T.
// Win+I (lane settings, 2026-09-28): Mantle Settings. Exactly Win+I: Win+Shift+I, Win+Ctrl+I, Win+Alt+I stay Windows'.
// Ctrl+Shift+Esc (lane taskmgr, 2026-09-28): Mantle's task manager. Exactly Ctrl+Shift: Esc, Ctrl+Esc, Alt+Esc stay Windows'.
// Win+E (lane files, 2026-09-28): Mantle Files. Exactly Win+E: Win+Shift+E, Win+Ctrl+E, Win+Alt+E stay Windows'.
// Win+R / Win+X (lane keysrun, 2026-10-15): the launcher's Run and Quick links modes. Exact, as Win+E.
// Win+G (lane mantle-clips, 2026-10-15): Mantle's Record panel. Exact: Win+Alt+G stays Game Bar's.
// Win+P (lane qstiles, 2026-10-15): Mantle's Project pop-up (lib/features/project.js). Exact, as Win+E.
// Order (wave 4): the table only grows at the end, in the order branches landed; sidecar/AltTab.cs matches it.
const CHORDS = ['Win+S', 'Win+V', 'Win+Tab', 'Win+Left', 'Win+Right', 'Win+Up', 'Win+Down', 'Win+Z', 'Win+Shift+S', 'PrintScreen',
  'VolumeUp', 'VolumeDown', 'VolumeMute', 'Win+Alt+T', 'Win+Ctrl+T', 'Win+Alt+N', 'Win+I', 'Ctrl+Shift+Esc', 'Win+E', 'Win+R', 'Win+X', 'Win+G',
  'Win+P'];
const KEYS = ['VolumeUp', 'VolumeDown', 'VolumeMute'];
const NAME_RE = /^[a-z][a-z0-9]*$/;
const VERB_RE = /^[a-zA-Z][a-zA-Z0-9_.-]*$/;
// Names a feature may not take: Mantle's own command prefixes and event names already mean
// something, and a feature's name is its command prefix.
const RESERVED = new Set(['features', 'state', 'sys', 'windows', 'bar', 'launcher', 'desktop', 'switcher', 'notifs',
  'qs', 'wallpaper', 'shell', 'tray', 'media', 'battery', 'volume', 'net', 'apps', 'mantle', 'test', 'theme']);
const STOP_MS = 2500;          // per feature; they run at once, so this is also the whole wait
const INSTALL_MS = 10000;      // an async install() that never settles is a feature that is down (opts.installMs: tests)
const APPLY_COALESCE_MS = 30;  // several health() calls in one tick become ONE hotkey call
const SETTINGS_MAX = 4 * 1024 * 1024;   // a feature's settings file over this is refused, not read
const OPTION_TYPES = ['bool', 'choice', 'number', 'text', 'folder'];
const OPTION_KEY_RE = /^[a-zA-Z][a-zA-Z0-9_]*$/;
const OPTION_TEXT_MAX = 500;

function fmtS(ms) { return ms >= 1000 ? `${Math.round(ms / 1000)} s` : `${ms} ms`; }
function words(err) { return err && err.message ? err.message : String(err); }
function oneLine(s) { return String(s).replace(/\s*[\r\n]+\s*/g, ' ').trim(); }

/*
 * OPTIONS (lane settings, 2026-09-28). Mantle's own settings used to live wherever each feature drew
 * them (the Spotify card, quick settings, the top bar's menu, the tray), and Owen asked for one
 * Mantle section in a Settings window. A module may now declare what it keeps in its settings file:
 *
 *   options: [{ key: 'auto', label: 'Start game mode by itself', help: '...', type: 'bool', default: true }]
 *
 * type bool | choice (choices: [{value, label}] or plain values) | number (min, max, step, unit) |
 * text | folder (an absolute path; null = the default, said by defaultLabel). Mantle Settings reads
 * and writes them through ctx.host.features, which goes through THAT feature's own settings store
 * (one per feature for the life of the process, the same object as its ctx.settings), so the
 * feature's cache never goes stale and nothing is written behind its back; a running feature hears
 * the change through ctx.onOption(key, fn). A feature that reads its setting each time it acts needs
 * no handler. Existing cards keep their own commands: both roads write the same store.
 */
function normChoices(list) {
  return (Array.isArray(list) ? list : []).map((c) => (c && typeof c === 'object' && !Array.isArray(c)
    ? { value: c.value, label: typeof c.label === 'string' && c.label.trim() ? c.label : String(c.value) }
    : { value: c, label: String(c) }));
}
function checkOption(opt, v) {
  if (v === null) return { reset: true };
  switch (opt.type) {
    case 'bool': return typeof v === 'boolean' ? { value: v } : { reason: `${opt.label}: must be on or off` };
    case 'choice': {
      const c = normChoices(opt.choices).find((x) => x.value === v);
      return c ? { value: c.value } : { reason: `${opt.label}: must be one of ${normChoices(opt.choices).map((x) => x.label).join(', ')}` };
    }
    case 'number': {
      const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() ? Number(v) : NaN);
      if (!Number.isFinite(n)) return { reason: `${opt.label}: must be a number` };
      if (typeof opt.min === 'number' && n < opt.min) return { reason: `${opt.label}: must be at least ${opt.min}${opt.unit ? ` ${opt.unit}` : ''}` };
      if (typeof opt.max === 'number' && n > opt.max) return { reason: `${opt.label}: must be at most ${opt.max}${opt.unit ? ` ${opt.unit}` : ''}` };
      return { value: n };
    }
    case 'text':
      if (typeof v !== 'string') return { reason: `${opt.label}: must be text` };
      if (v.length > OPTION_TEXT_MAX) return { reason: `${opt.label}: is longer than ${OPTION_TEXT_MAX} characters` };
      return { value: v };
    case 'folder':
      if (typeof v !== 'string' || !v.trim()) return { reason: `${opt.label}: must be a folder` };
      if (!path.win32.isAbsolute(v) || !/^([a-zA-Z]:\\|\\\\)/.test(v)) return { reason: `${opt.label}: must be a full folder path (like C:\\Users\\...)` };
      return { value: v };
    default: return { reason: `${opt.label}: has an unknown type` };
  }
}
/** null or the plain-words reason a module's options list breaks the contract. PURE. */
function validateOptions(list) {
  if (!Array.isArray(list)) return 'options must be a list';
  const seen = new Set();
  for (const opt of list) {
    if (!opt || typeof opt !== 'object') return 'every option must be an object';
    if (typeof opt.key !== 'string' || !OPTION_KEY_RE.test(opt.key)) return `option key ${JSON.stringify(opt.key)} is not a plain word`;
    if (seen.has(opt.key)) return `option "${opt.key}" is listed twice`;
    seen.add(opt.key);
    if (typeof opt.label !== 'string' || !opt.label.trim()) return `option "${opt.key}" has no label`;
    if (opt.help !== undefined && typeof opt.help !== 'string') return `option "${opt.key}": help must be text`;
    if (!OPTION_TYPES.includes(opt.type)) return `option "${opt.key}": type must be one of ${OPTION_TYPES.join(', ')}`;
    if (opt.type === 'choice') {
      const cs = normChoices(opt.choices);
      if (!cs.length) return `option "${opt.key}": a choice needs choices`;
      if (cs.some((c) => !['string', 'number', 'boolean'].includes(typeof c.value))) return `option "${opt.key}": every choice value must be text, a number or true/false`;
    }
    if (opt.type === 'number' && [opt.min, opt.max, opt.step].some((n) => n !== undefined && !Number.isFinite(n))) return `option "${opt.key}": min, max and step must be numbers`;
    const nullable = opt.type === 'text' || opt.type === 'folder';
    if (opt.default === undefined || (opt.default === null && !nullable)) return `option "${opt.key}" has no default`;
    if (opt.default !== null) { const c = checkOption(opt, opt.default); if (c.reason) return `option "${opt.key}": its default is not valid (${c.reason})`; }
  }
  return null;
}

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
  if (mod.options !== undefined) { const bad = validateOptions(mod.options); if (bad) return bad; }
  return null;
}

/**
 * The plain-words state of one feature, for the state piece `features.<name>`. PURE.
 *   on: the tray switch; ok: healthy (its own word, or it failed to load/install); reason;
 *   keys: its chords are Windows' or Mantle's right now; keysReason; broken: the words for a
 *   chord that SHOULD be Mantle's and is not (a fault), else null; stopped: after stop().
 */
// A settings file that could not be used (settingsFor) is said on the feature's line: `broken` is what
// the desktop strip and the tray show for a feature that is otherwise healthy.
function pieceWords(f, x) {
  const p = keysPiece(f, x);
  if (f.settingsNote) { p.note = f.settingsNote; if (!p.broken) p.broken = f.settingsNote; }
  return p;
}
function keysPiece(f, x) {
  const p = { label: f.label, on: !!f.enabled, ok: f.ok !== false, reason: f.reason || '', keys: false, keysReason: '', broken: null, stopped: !!f.stopped && !f.resting };
  if (f.resting) p.resting = f.resting;
  const chords = f.chords || [];
  if (!chords.length) { p.keysReason = 'it takes no keys from Windows'; return p; }
  const list = chords.join(', ');
  if (f.resting) p.keysReason = `${list}: Windows' own while Mantle rests (${f.resting})`;
  else if (f.stopped) p.keysReason = `${list}: Windows' own (the feature was stopped)`;
  else if (!f.enabled) p.keysReason = `${list}: Windows' own (turned off in the tray menu)`;
  else if (!p.ok) p.keysReason = `${list}: Windows' own until it is healthy again`;
  else if (f.keysAway) p.keysReason = `${list}: Windows' own for now (${f.keysAway})`;
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
  const plainSaid = plainError.onceLogger(log);   // a push's raw codes: words to the page, the codes to the log
  const installMs = Number.isFinite(o.installMs) && o.installMs > 0 ? o.installMs : INSTALL_MS;
  const features = new Map();          // name -> record
  const claims = new Map();            // chord -> feature name
  const K = {
    live: false, releasedWhy: null, sidecarDown: null,
    taken: null,                        // Set of chords the sidecar last said it holds, or null
    err: null, applying: 0, lastSent: null, timer: null, stopping: null,
  };

  const settingsDir = path.join(o.userData, 'features');
  const switchesFile = path.join(o.userData, 'features.json');
  // core-lib (2026-09-29): a features.json that is not a JSON object (a torn write, a hand edit) used
  // to be dropped in silence and then saved over at the next tray click, so every switch Owen had
  // set was lost without a word. Now it is moved aside as features.json.unreadable and said.
  let switches = {};
  try {
    const v = JSON.parse(fs.readFileSync(switchesFile, 'utf8'));
    if (v && typeof v === 'object' && !Array.isArray(v)) switches = v;
    else throw Object.assign(new Error('it does not hold switches (not a JSON object)'), { code: 'NOTOBJECT' });
  } catch (err) {
    if (!err || err.code !== 'ENOENT') {
      const why = err && err.code === 'NOTOBJECT' ? err.message : err instanceof SyntaxError ? 'it is not valid JSON' : `it could not be read (${err && err.code ? err.code : words(err)})`;
      let kept = null;
      try { fs.renameSync(switchesFile, `${switchesFile}.unreadable`); kept = 'features.json.unreadable'; } catch (_) { /* said below */ }
      log(`features: the saved on/off switches were not used: ${why}; ${kept ? `kept as ${kept}, ` : ''}every feature starts at its default`);
    }
    switches = {};
  }

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
    changed('state', f.name);
  }
  /* ctx.host.features.onChange: Mantle Settings redraws when a switch, an option or a feature's
     health moves, whoever moved it (the tray, a card, a game starting). Never throws into publish. */
  const changeFns = new Set();
  function changed(what, name) {
    for (const fn of Array.from(changeFns)) { try { fn({ what, feature: name }); } catch (err) { log(`features: a change listener threw: ${words(err)}`); } }
  }
  function publishAll() { for (const f of features.values()) publish(f); }

  /* ---- the keyboard: what the hook should take, and telling the sidecar ---- */

  function wanted() {
    const chords = new Set();
    const observe = new Set();
    for (const f of features.values()) {
      if (!f.running || f.stopped || !f.enabled) continue;
      for (const k of f.observe) observe.add(k);
      if (f.ok === false || f.keysAway) continue;   // keysAway: ctx.keysAway(why), healthy but handing its chords back for now
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

  /** Mantle Settings' switch (ctx.host.features.setEnabled): the tray's setEnabled, with the reasons
   * the tray shows as a greyed-out checkbox said in words. -> {ok, reason, feature: list record}. */
  function trySetEnabled(name, on, who) {
    const f = features.get(name);
    if (!f) return { ok: false, reason: `Mantle has no feature called "${name}"` };
    const rec = () => list().find((x) => x.name === name);
    if (typeof on !== 'boolean') return { ok: false, reason: 'on must be true or false', feature: rec() };
    if (!f.mod) return { ok: false, reason: `${f.label} did not load, so it cannot be switched (${f.reason})`, feature: rec() };
    if (f.stopped && !f.resting) return { ok: false, reason: `${f.label} was stopped when Mantle put Windows back; it comes back when Mantle restarts`, feature: rec() };
    setEnabled(name, on, who);
    const err = f.enabled === on && switches[name] === on ? null : 'the switch did not move';
    return { ok: !err, reason: err, feature: rec() };
  }

  function setEnabled(name, on, who) {
    const f = features.get(name);
    if (!f || f.enabled === !!on) return null;
    f.enabled = !!on;
    switches[name] = f.enabled;
    const err = saveSwitches();
    log(`${name}: turned ${f.enabled ? 'on' : 'off'} by ${who}${err ? ` (NOT saved for next time: ${err})` : ''}`);
    for (const fn of Array.from(f.enabledHandlers)) runHandler(f, 'onEnabled', fn, f.enabled);
    publish(f);
    scheduleApply(`${name} turned ${f.enabled ? 'on' : 'off'}`);
    return err;
  }

  /* ---- options (see OPTIONS at the top) ---- */

  /** The feature's ONE settings store, shared by every ctx it gets (a wake after a game is a new
   * ctx) and by Mantle Settings: one cache per file, so a value set on either road is what the
   * other reads next. */
  function store(f) { return f.store || (f.store = settingsFor(f)); }

  function optionView(f, opt) {
    let saved;
    let note = null;
    try { saved = store(f).get(opt.key, undefined); } catch (err) { note = `the saved value could not be read (${words(err)})`; }
    let value = opt.default;
    let isDefault = true;
    if (saved !== undefined && saved !== null) {
      const c = checkOption(opt, saved);
      if (c.reason) note = `the saved value is not valid, so the default is used (${c.reason})`;
      else { value = c.value; isDefault = JSON.stringify(value) === JSON.stringify(opt.default); }
    }
    if (opt.type === 'folder' && typeof value === 'string') {
      try { if (!fs.statSync(value).isDirectory()) note = 'that path is not a folder'; } catch (err) { note = err && err.code === 'ENOENT' ? 'that folder does not exist any more' : `that folder cannot be read (${err && err.code ? err.code : words(err)})`; }
    }
    const v = { key: opt.key, label: opt.label, help: opt.help || '', type: opt.type, default: opt.default, value, isDefault, note };
    if (opt.type === 'choice') v.choices = normChoices(opt.choices);
    for (const k of ['min', 'max', 'step', 'unit', 'placeholder', 'defaultLabel']) if (opt[k] !== undefined) v[k] = opt[k];
    return v;
  }
  function optionsOf(f) { return f.mod && Array.isArray(f.mod.options) ? f.mod.options : []; }
  function optionsView(f) { return optionsOf(f).map((opt) => optionView(f, opt)); }

  /** Mantle Settings' write (ctx.host.features.setOption). value null = back to the default. Values
   * of text and folder options are never logged (a folder path can name anything). */
  function setOption(name, key, value, who) {
    const f = features.get(name);
    if (!f || !f.mod) return { ok: false, reason: f ? `${f.label} did not load (${f.reason})` : `Mantle has no feature called "${name}"` };
    const opt = optionsOf(f).find((x) => x.key === key);
    if (!opt) return { ok: false, reason: `${f.label} has no option called "${key}"` };
    if (K.stopping) return { ok: false, reason: 'Mantle is putting Windows back; nothing is changed now', option: optionView(f, opt) };
    const c = checkOption(opt, value);
    if (c.reason) return { ok: false, reason: c.reason, option: optionView(f, opt) };
    if (opt.type === 'folder' && !c.reset) {
      let why = null;
      try { if (!fs.statSync(c.value).isDirectory()) why = 'that path is not a folder'; } catch (err) { why = err && err.code === 'ENOENT' ? 'that folder does not exist' : `that folder cannot be read (${err && err.code ? err.code : words(err)})`; }
      if (why) return { ok: false, reason: `${opt.label}: ${why}`, option: optionView(f, opt) };
    }
    try { store(f).set(key, c.reset ? undefined : c.value); } catch (err) { return { ok: false, reason: words(err), option: optionView(f, opt) }; }
    const shown = c.reset ? 'reset to its default' : (opt.type === 'text' || opt.type === 'folder' ? 'changed' : `set to ${JSON.stringify(c.value)}`);
    log(`${f.name}: option ${key} ${shown} by ${who}`);
    const view = optionView(f, opt);
    // A running feature hears it now; a resting or stopped one reads it when it next starts.
    let told = 0;
    if (f.running && !f.stopped) {
      for (const k of [key, '*']) {
        const hs = f.optionHandlers.get(k);
        if (!hs) continue;
        for (const fn of Array.from(hs)) { runHandler(f, `option "${key}"`, (v) => fn(v, key), view.value); told++; }
      }
    }
    changed('option', f.name);
    return { ok: true, reason: null, option: view, told };
  }

  /*
   * A feature's settings file (security review #4 + 2, 2026-09-27). It used to be read with no size
   * check (sync, on main: a 100 MB file blocked the whole shell) and a file that was not JSON (or not
   * an object) silently became {}, so the next set() wrote over everything else in it. Now: stat
   * first and refuse over SETTINGS_MAX in words; a bad file is moved aside to <name>.json.unreadable
   * and SAID (log + the feature's line on the desktop strip and tray, through `settingsNote`); if it
   * cannot be moved aside, set() refuses rather than write over it. Reasons never quote the file's
   * text (JSON.parse's message does: settings can hold window names).
   */
  function settingsFor(f) {
    const file = path.join(settingsDir, `${f.name}.json`);
    let cache = null;
    let noWrite = null;          // a bad file still in place: set() must not write over it
    const load = () => {
      if (cache) return cache;
      cache = {};
      let why = null;
      try {
        const st = fs.statSync(file);
        if (!st.isFile()) why = 'is not a file';
        else if (st.size > SETTINGS_MAX) why = `is ${(st.size / 1048576).toFixed(1)} MB, over the ${SETTINGS_MAX / 1048576} MB a settings file may be`;
        else {
          let v;
          try { v = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e instanceof SyntaxError) v = SyntaxError; else throw e; }
          if (v === SyntaxError) why = 'is not valid JSON';
          else if (!v || typeof v !== 'object' || Array.isArray(v)) why = 'does not hold settings (not a JSON object)';
          else cache = v;
        }
      } catch (e) {
        if (e && e.code === 'ENOENT') return cache;
        why = `could not be read (${e && e.code ? e.code : words(e)})`;
      }
      if (!why) return cache;
      let kept = null, moveErr = null;
      const aside = fs.existsSync(`${file}.unreadable`) ? `${file}.unreadable-${Date.now()}` : `${file}.unreadable`;
      try { fs.renameSync(file, aside); kept = path.basename(aside); } catch (e) { moveErr = e && e.code ? e.code : words(e); }
      if (!kept) noWrite = `${file} ${why} and could not be moved aside (${moveErr}), so nothing is saved over it`;
      f.settingsNote = `its saved settings were not used: ${path.basename(file)} ${why}; ${kept ? `kept as ${kept}, starting from defaults` : `it could not be moved aside (${moveErr}), so nothing is saved over it this run`}`;
      log(`${f.name}: ${f.settingsNote}`);   // the file name is in the note; never the full path (privacy)
      publish(f);
      return cache;
    };
    return {
      get(key, dflt) {
        const v = load()[key];
        return v === undefined ? dflt : JSON.parse(JSON.stringify(v));
      },
      set(key, value) {
        const all = load();
        if (noWrite) throw new Error(`${f.name}: the setting "${key}" was not saved: ${noWrite}`);
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
    const gen = f.gen || 0;
    // A ctx from before a restart (or a failed install) adds nothing: its feature let go of it.
    const alive = (what) => { if ((f.gen || 0) !== gen) throw new Error(`${f.name}: ${what} after the feature was restarted or failed; this ctx is no longer in use`); };
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
          alive('sidecar.on');
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
        /** The running sidecar's pid (its ready line), or null while it is down. Read-only: lib/raise.js
         *  keyboard() hands this process's foreground right to it (lib/fg-grant.js) before the ladder. */
        get pid() {
          const info = o.sidecar.info;
          const pid = info && Number(info.pid);
          return Number.isInteger(pid) && pid > 0 ? pid : null;
        },
      },
      command(verb, fn) {
        if (typeof verb !== 'string' || !VERB_RE.test(verb)) throw new Error(`${f.name}: command verb ${JSON.stringify(verb)} is not a plain word`);
        if (typeof fn !== 'function') throw new Error(`${f.name}: command "${verb}" needs a function`);
        alive(`command("${verb}")`);
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
      /** lane mantle-clips: hand this feature's chords back to Windows for now, still healthy (why), or
       *  take them again (null). Clips gives Win+G back while an exclusive full-screen app is in front. */
      keysAway(why) {
        const next = why ? String(why) : null;
        if (next === (f.keysAway || null)) return;
        f.keysAway = next;
        publish(f);
        scheduleApply(next ? `${f.name} hands its keys back (${next})` : `${f.name} takes its keys again`);
      },
      /** lane mantle-clips: is a command by this full name ('screenrec.start') there right now? */
      hasCommand(name) { return typeof o.commands[String(name)] === 'function'; },
      enabled() { return f.enabled; },
      onEnabled(fn) {
        if (typeof fn !== 'function') throw new Error(`${f.name}: onEnabled needs a function`);
        f.enabledHandlers.add(fn);
        return () => f.enabledHandlers.delete(fn);
      },
      /** spotgame lane (2026-09-28): fn({on, why}) when Mantle starts resting for a game (on: true,
       * why: "VALORANT runs"; called again if the why changes) and when it wakes (on: false). For a
       * feature that stays up during a game but acts on one (the Spotify card closes an idle Spotify).
       * The same signal as `rest: true` (game mode's watch -> main.js restMantle -> restAll), not a
       * second game detector. Called before the resting features stop. */
      onRest(fn) {
        if (typeof fn !== 'function') throw new Error(`${f.name}: onRest needs a function`);
        f.restHandlers.add(fn);
        return () => f.restHandlers.delete(fn);
      },
      page(file) { return path.join(o.root, 'ui', f.name, file || 'index.html'); },
      preload: path.join(o.root, 'preload.js'),
      broadcast(event, payload) { o.broadcast(event, payload); },
      push(win, event, payload) {
        if (!win || win.isDestroyed() || !win.webContents || win.webContents.isDestroyed()) return false;
        const words = plainError.plainReply(payload, (codes) => plainSaid(`push ${event}`, codes));
        try { win.webContents.send('mantle:event', { name: event, payload: words }); return true; } catch (_) { return false; }
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
        /** lane mantle-toasts: the notification centre's list for Mantle's banners, or null. onList(fn) is
         * tracked like onMedia (dropped at stop); last(), targetFor(aumid), focus(hwnd), open(id), openList(). */
        toasts: o.host.toasts ? Object.assign({}, o.host.toasts, {
          onList(fn) {
            const un = o.host.toasts.onList((p) => runHandler(f, 'host.toasts.onList', () => fn(p)));
            const off = () => { f.offs.delete(off); if (typeof un === 'function') un(); };
            f.offs.add(off);
            return off;
          },
        }) : null,
        /** main.js's last NOW PLAYING read ({ok, reason, sessions:[{aumid, status, playing, ...}]}) or null. */
        media() { return o.host.media ? o.host.media() : null; },
        /** fn(payload) after every NOW PLAYING read; returns the unsubscribe (call it in stop()). */
        onMedia(fn) {
          if (!o.host.onMedia) return () => {};
          const un = o.host.onMedia((p) => runHandler(f, 'host.onMedia', () => fn(p)));
          // Tracked like sidecar.on, so a stop (or a failed install) that forgets it cannot leak it.
          const off = () => { f.offs.delete(off); if (typeof un === 'function') un(); };
          f.offs.add(off);
          return off;
        },
        /** lane settings: Mantle Settings' view of every feature. list() = features.list with each
         * one's options (current values) and keys; setEnabled = the tray's switch; setOption goes
         * through THAT feature's own settings store and tells it (ctx.onOption); onChange(fn) after
         * any of those or a health change (dropped at stop). Every write is logged "by <label>". */
        features: {
          list: () => list(),
          setEnabled: (name, on) => trySetEnabled(name, on, f.label),
          setOption: (name, key, value) => setOption(name, key, value, f.label),
          /** core-lib: bring a feature that is down back (restart() above). -> Promise<{ok, reason, feature}> */
          restart: (name) => restart(name, f.label),
          onChange(fn) {
            if (typeof fn !== 'function') throw new Error(`${f.name}: onChange needs a function`);
            const wrapped = (e) => { if (!f.stopped) fn(e); };
            changeFns.add(wrapped);
            const off = () => { changeFns.delete(wrapped); f.offs.delete(off); };
            f.offs.add(off);
            return off;
          },
        },
        /** lane settings: main's Alt+Tab and Win+N / Win+A switches (lib/switcher.js), or null. */
        switcher: o.host.switcher ? { get: () => o.host.switcher.get(), set: (patch) => o.host.switcher.set(patch, f.label) } : null,
        /** lane dm-core (2026-10-08): Mantle's appearance, for colours MAIN draws (a window's ground,
         * its DWM frame). Pages never need this: preload.js themes them. get() -> 'dark' | 'light';
         * onChange(fn) -> off, fn('dark'|'light') after every change, dropped at stop like onMedia. */
        theme: {
          get() { return o.host.theme ? o.host.theme.get() : 'light'; },
          onChange(fn) {
            if (typeof fn !== 'function') throw new Error(`${f.name}: theme.onChange needs a function`);
            if (!o.host.theme) return () => {};
            const un = o.host.theme.onChange((t) => runHandler(f, 'host.theme', () => fn(t)));
            const off = () => { f.offs.delete(off); if (typeof un === 'function') un(); };
            f.offs.add(off);
            return off;
          },
        },
        /** lane see-topbar (2026-10-09): the desktop layer's top strip as Mantle draws it (main.js,
         * lib/topbar-strip.js), for the top bar's frosted backdrop. -> Promise<{ok, png, under, ...} |
         * {ok:false, transient?, reason}>; never rejects. */
        desktopStrip(a) {
          if (!o.host.desktopStrip) return Promise.resolve({ ok: false, reason: 'this Mantle cannot read the desktop layer\'s strip (no ctx.host.desktopStrip)' });
          return Promise.resolve().then(() => o.host.desktopStrip(a || {}))
            .catch((e) => ({ ok: false, reason: `reading the desktop layer's strip threw: ${e && e.message ? e.message : e}` }));
        },
        /** lane helm-wall-apps (2026-10-09): the desktop wallpaper still (main.js wallHost, lib/wall-still.js), dark only,
         * for the app windows' Helm look (lib/features/_wall-window.js). null where this Mantle has none.
         * full() -> Promise<{ok, png, w, h, display, source, key, ms} | {ok:false, reason}>, never rejects;
         * onChange(fn) -> off(), dropped at stop like theme.onChange. */
        wall: o.host.wall && typeof o.host.wall.full === 'function' ? {
          full() {
            return Promise.resolve().then(() => o.host.wall.full())
              .catch((e) => ({ ok: false, reason: `the wallpaper still threw: ${e && e.message ? e.message : e}` }));
          },
          // lane helm-wall: a PHYSICAL-pixel rectangle's cut ({ok, png, w, h, rect, source} | {ok:false, reason, capture?})
          rect(phys, ropts) {
            if (typeof o.host.wall.rect !== 'function') return Promise.resolve({ ok: false, reason: 'this Mantle cannot cut the wallpaper still' });
            return Promise.resolve().then(() => o.host.wall.rect(phys, ropts))
              .catch((e) => ({ ok: false, reason: `the wallpaper still threw: ${e && e.message ? e.message : e}` }));
          },
          onChange(fn) {
            if (typeof fn !== 'function') throw new Error(`${f.name}: wall.onChange needs a function`);
            if (typeof o.host.wall.onChange !== 'function') return () => {};
            const un = o.host.wall.onChange((why) => runHandler(f, 'host.wall', () => fn(why)));
            const off = () => { f.offs.delete(off); if (typeof un === 'function') un(); };
            f.offs.add(off);
            return off;
          },
        } : null,
        /** lane guard-mantle (2026-10-10): the SHARED top-band darkening for the top bar (main.js, lib/look-guard.js
         * use). get() -> {use, alpha, contrast, rev} | {use:false, why, failure}, never throws; onChange(fn) -> off(),
         * fn after a look or theme change, dropped at stop like theme.onChange. null where this Mantle has none. */
        lookGuard: o.host.lookGuard && typeof o.host.lookGuard.get === 'function' ? {
          get() {
            try { return o.host.lookGuard.get(); } catch (e) {
              return { use: false, why: `the shared darkening threw (${e && e.message ? e.message : e}), so the top bar works out its own`, failure: true };
            }
          },
          onChange(fn) {
            if (typeof fn !== 'function') throw new Error(`${f.name}: lookGuard.onChange needs a function`);
            if (typeof o.host.lookGuard.onChange !== 'function') return () => {};
            const un = o.host.lookGuard.onChange((why) => runHandler(f, 'host.lookGuard', () => fn(why)));
            const off = () => { f.offs.delete(off); if (typeof un === 'function') un(); };
            f.offs.add(off);
            return off;
          },
        } : null,
      },
      settings: store(f),
      /** lane settings: fn(value, key) when Mantle Settings changes one of this module's `options`
       * (key '*' = any of them). Only for keys the module declares. Returns unsubscribe. */
      onOption(key, fn) {
        if (key !== '*' && !optionsOf(f).some((x) => x.key === key)) throw new Error(`${f.name}: onOption("${key}") but its module declares no option "${key}"`);
        return subscribe(f.optionHandlers, key, fn);
      },
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
      enabledHandlers: new Set(), restHandlers: new Set(), offs: new Set(), commands: new Set(), replays: new Map(),
      optionHandlers: new Map(), store: null,
    };
  }

  function fail(f, reason) {
    f.ok = false;
    f.reason = oneLine(reason);
    f.running = false;
    log(`${f.name}: NOT started: ${f.reason}`);
    publish(f);
  }

  /* core-lib quality pass (2026-09-29): everything a feature hooked up through its ctx, let go.
     Before, an install() that threw half way kept its sidecar listeners (which still ran, since the
     feature was never "stopped"), its commands and its replays for the life of Mantle. */
  function unhook(f) {
    for (const off of Array.from(f.offs)) { try { off(); } catch (_) { /* already gone */ } }
    f.chordHandlers.clear(); f.keyHandlers.clear(); f.enabledHandlers.clear(); f.restHandlers.clear(); f.optionHandlers.clear();
  }
  function dropAll(f) {
    unhook(f);
    for (const full of f.commands) delete o.commands[full];
    f.commands.clear();
    f.replays.clear();
    f.gen = (f.gen || 0) + 1;   // an old ctx that is still holding on can no longer add anything
  }

  /** A handle that arrived after its feature was stopped (a slow async install racing the quit or
   * a game): stop it now, or its windows outlive Mantle's "put Windows back". */
  function stopLate(f, h) {
    if (!h || typeof h.stop !== 'function') return;
    log(`${f.name}: install() finished after the feature was stopped; stopping what it started`);
    try { Promise.resolve(h.stop('it finished starting after Mantle stopped it', {})).catch((err) => log(`${f.name}: that stop() failed: ${oneLine(words(err))}`)); } catch (err) { log(`${f.name}: that stop() threw: ${oneLine(words(err))}`); }
  }

  /** Resolves when this install settles (or its deadline passes); f.installP. Never rejects. */
  function installOne(f) {
    let ret;
    const gen = f.gen || 0;
    try {
      ret = f.mod.install(makeCtx(f));
    } catch (err) {
      dropAll(f);
      fail(f, `it could not start: install() threw ${oneLine(words(err))}`);
      if (err && err.stack) log(`${f.name}: ${err.stack}`);
      f.installP = Promise.resolve();
      return f.installP;
    }
    f.running = true;
    if (f.reason === 'starting') f.reason = 'working';
    const took = (h) => {
      if (f.stopped || (f.gen || 0) !== gen) { stopLate(f, h); return; }
      if (h && typeof h.stop !== 'function') log(`${f.name}: install() returned no stop(); nothing will be put back for it on exit`);
      f.handle = h || null;
      // It missed its deadline and was marked down for it; it made it after all.
      if (f.lateInstall) { f.lateInstall = false; if (f.ok === false) setHealth(f, true, 'working'); }
    };
    if (ret && typeof ret.then === 'function') {
      const ms = installMs;
      f.installP = new Promise((settle) => {
        const t = setTimeout(() => {
          if (!f.handle && f.running) { f.lateInstall = true; setHealth(f, false, `install() did not finish within ${fmtS(ms)}`); }
          settle();
        }, ms);
        if (t.unref) t.unref();
        ret.then((h) => { clearTimeout(t); took(h); settle(); }, (err) => {
          clearTimeout(t);
          if ((f.gen || 0) === gen && !f.stopped) {
            dropAll(f);
            f.running = false;
            fail(f, `it could not start: install() failed: ${words(err)}`);
            scheduleApply(`${f.name} failed to start`);
          }
          settle();
        });
      });
    } else {
      took(ret);
      f.installP = Promise.resolve();
    }
    publish(f);
    return f.installP;
  }

  /**
   * core-lib quality pass (2026-09-29): the way back for a feature that is down. Before, a feature
   * whose install() failed, or whose handler threw (its keys went back to Windows), stayed down until
   * Mantle restarted. restart() stops it (if it runs), lets go of everything it hooked up, and runs
   * the same install() as start-up. Refused, in words, for what a restart cannot fix: a file that
   * did not load, a chord or name clash, a quit, a game rest. -> {ok, reason, feature}. Never throws.
   */
  function restart(name, who) {
    const f = features.get(name);
    if (!f) return Promise.resolve({ ok: false, reason: `Mantle has no feature called "${name}"` });
    const rec = () => list().find((x) => x.name === name);
    const no = (reason) => Promise.resolve({ ok: false, reason, feature: rec() });
    if (K.stopping) return no(`${f.label} was stopped when Mantle put Windows back; it comes back when Mantle restarts`);
    if (!f.mod) return no(`${f.label} did not load, so it cannot be restarted (${f.reason})`);
    if (f.blocked) return no(`${f.label} cannot start: ${f.blocked}`);
    if (f.resting) return no(`${f.label} is ${restWords(f.resting)}; it comes back by itself when the game exits`);
    if (f.stopped && !f.restarting) return no(`${f.label} was stopped when Mantle put Windows back; it comes back when Mantle restarts`);
    if (f.restarting) return f.restarting;
    f.restarting = (async () => {
      log(`${f.name}: restarting (asked by ${who || 'no one said'})`);
      if (f.running) await stopOne(f, `restarting, asked by ${who || 'no one said'}`, { restart: true });
      if (K.stopping) return { ok: false, reason: `${f.label} was stopped when Mantle put Windows back; it comes back when Mantle restarts`, feature: rec() };
      dropAll(f);
      f.stopped = false;
      f.handle = null;
      f.lateInstall = false;
      f.ok = true;
      f.reason = 'starting';
      await installOne(f);
      scheduleApply(`${f.name} restarted`);
      const ok = f.running && f.ok !== false;
      return { ok, reason: ok ? null : f.reason, feature: rec() };
    })().finally(() => { f.restarting = null; });
    return f.restarting;
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
      if (clash) { f.blocked = `its name clashes with Mantle's own command "${clash}"`; fail(f, f.blocked); continue; }
      const taken = f.chords.find((c) => claims.has(c));
      if (taken) { f.blocked = `${taken} is already taken by ${claims.get(taken)}`; fail(f, f.blocked); continue; }
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

  /* spotgame lane: the features that stay up hear it (ctx.onRest). Never awaited: a handler that is
     slow or throws cannot hold up the rest (a throw is logged and marks that feature, runHandler). */
  function tellRest(on, why) {
    for (const f of Array.from(features.values())) {
      if (f.rest || !f.running || f.stopped || f.resting || !f.restHandlers.size) continue;
      for (const fn of Array.from(f.restHandlers)) runHandler(f, 'onRest', fn, { on, why });
    }
  }

  async function restAll(why) {
    if (K.stopping) return [];
    tellRest(true, why);
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
    tellRest(false, why);
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
        unhook(f);
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
    // ONE copy of State per menu build (lane mn-speed, 2026-10-12): state.get() is a deep copy of the
    // whole State, and this ran on every State change, once per feature: 316 of the 470 ms that
    // state.get() cost the main process in a measured ~80 s run, the largest single JavaScript cost.
    const all = o.state.get().features || {};
    for (const f of features.values()) {
      out.push({ label: f.label, type: 'checkbox', checked: !!f.enabled, enabled: !!f.mod && !f.stopped,
        click: (item) => setEnabled(f.name, !!item.checked, 'the tray menu') });
      const p = all[f.name];
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
    const pieces = o.state.get().features || {};
    return Array.from(features.values()).map((f) => {
      const p = pieces[f.name] || {};
      return { name: f.name, label: f.label, chords: f.chords, observe: f.observe,
        enabled: f.enabled, ok: f.ok, reason: f.reason, running: f.running, stopped: f.stopped, resting: f.resting, commands: Array.from(f.commands),
        // lane settings: what Mantle Settings shows beside the switch
        loaded: !!f.mod, keys: !!p.keys, keysReason: p.keysReason || '', broken: p.broken || null, options: optionsView(f) };
    });
  }

  return { load, applyLive, released, stopAll, restAll, wakeAll, restart, resting: () => Array.from(features.values()).filter((f) => f.resting).map((f) => f.name), trayItems, replay, list, fireChord, fireKey, setEnabled, setOption, wanted,
    get size() { return features.size; } };
}

module.exports = { createFeatures, validate, validateOptions, checkOption, pieceWords, CHORDS, KEYS };

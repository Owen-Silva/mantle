// test-sysaccess.js - SysAccess.cs (the Accessibility values) and SysAccessTools.cs (Magnifier,
// Narrator, on-screen keyboard, voice access, live captions) against a PASSIVE sidecar (lane access,
// 2026-09-29).
//
//   node sidecar/test-sysaccess.js [--exe=<path>]      (or MANTLE_SIDECAR_EXE)
//
// NEVER changes the user's accessibility settings (Sticky keys flipped by a test could wreck a game):
// every write is proven by its dryRun WITH THE CURRENT VALUE (a no-op even if it were real, and
// answered by a passive sidecar because it changes nothing) and by the passive refusal of the real
// write; no tool is started (dryRun + passive refusal only). Prints counts and states, no names.
'use strict';
const T = require('./test-lib');

const KEYS = ['textSize', 'scrollbars', 'transparency', 'animations', 'notifyDuration', 'pointerStyle', 'pointerColor', 'pointerSize', 'touchIndicator',
  'caretWidth', 'contrastTheme', 'contrastShortcut', 'colorFilters', 'colorFilter', 'colorFilterShortcut', 'monoAudio', 'flashScreen', 'captionStyle',
  'voiceTyping', 'eyeControl', 'stickyOn', 'stickyShortcut', 'stickyIndicator', 'stickyLock', 'stickyTwoKeysOff', 'stickySound', 'filterOn',
  'filterShortcut', 'filterIndicator', 'filterBeep', 'toggleOn', 'toggleShortcut', 'shortcutWarning', 'shortcutSound', 'accessKeys', 'printScreen',
  'mouseKeysOn', 'mouseKeysShortcut', 'mouseKeysIndicator', 'mouseKeysNumLock', 'mouseKeysModifiers', 'mouseKeysSpeed', 'mouseKeysAccel',
  'magZoom', 'magIncrement', 'magInvert', 'magSmooth', 'magSignIn', 'narratorShortcut', 'narratorSignIn', 'oskSignIn', 'cursorIndicator'];
const READ_ONLY = ['pointerStyle', 'pointerColor', 'colorFilters', 'monoAudio', 'captionStyle', 'voiceTyping', 'eyeControl', 'cursorIndicator'];
const FIXED = ['captionStyle', 'voiceTyping', 'eyeControl'];   // no value at all, only the reason
const TOOLS = ['magnifier', 'narrator', 'osk', 'voiceAccess', 'liveCaptions'];

(async () => {
  const t = T.checker('SYSACCESS');
  let s;
  try { s = await T.startPassive(); } catch (e) { t.fail('sidecar starts', e.message); process.exit(t.summary()); }
  const send = (cmd, extra, ms) => s.send(cmd, extra || {}, ms || 15000);
  const refused = (r) => r && r.ok === false && String(r.error || '').startsWith(T.PASSIVE_REFUSAL);
  const short = (x) => JSON.stringify(x).slice(0, 260);

  try {
    // --- registration
    const ping = await send('ping');
    const cmds = (ping.ok && ping.result && ping.result.features && ping.result.features.commands) || [];
    for (const c of ['access.settings', 'access.set', 'access.start']) t.check(`${c} is registered`, cmds.includes(c), `commands: ${cmds.length}`);
    const probs = ((ping.result && ping.result.features && ping.result.features.problems) || []).filter((p) => /Access/.test(p));
    t.check('no SysAccess registration problems', probs.length === 0, probs.join('; '));
    const el = await send('elevate.list');
    const acts = (el.ok && el.result && el.result.actions) || [];
    t.check('no administrator actions (accessibility is per user)', !acts.some((a) => /^access\./.test(a.action)), short(acts.map((a) => a.action)));

    // --- access.settings
    const st = await send('access.settings');
    const v = st.ok && st.result && st.result.values;
    t.check('access.settings answers values', !!v, short(st));
    if (!v) throw new Error('no values: ' + short(st));
    t.check(`all ${KEYS.length} keys are there`, KEYS.every((k) => v[k]), short(KEYS.filter((k) => !v[k])));
    t.check('no unknown keys', Object.keys(v).every((k) => KEYS.includes(k)), short(Object.keys(v).filter((k) => !KEYS.includes(k))));
    t.check('every value has value and readOnly fields', KEYS.every((k) => 'value' in v[k] && 'readOnly' in v[k]));
    t.check('every null value says why (or is a fixed read-only row)', KEYS.every((k) => v[k].value !== null || v[k].why || FIXED.includes(k)),
      short(KEYS.filter((k) => v[k].value === null && !v[k].why && !FIXED.includes(k))));
    t.check('the read-only rows carry their reason', READ_ONLY.every((k) => typeof v[k].readOnly === 'string' && v[k].readOnly.length > 30), short(READ_ONLY.filter((k) => !v[k].readOnly)));
    const writable = KEYS.filter((k) => !READ_ONLY.includes(k) && !v[k].readOnly);
    t.check('the switches are true/false', ['scrollbars', 'transparency', 'animations', 'stickyOn', 'stickyShortcut', 'filterOn', 'toggleOn', 'accessKeys', 'printScreen', 'mouseKeysOn']
      .every((k) => typeof v[k].value === 'boolean'), short(['stickyOn', 'stickyShortcut'].map((k) => v[k])));
    t.check('text size 100..225', v.textSize.value >= 100 && v.textSize.value <= 225, short(v.textSize));
    t.check('caret width 1..20, pointer size 1..15', v.caretWidth.value >= 1 && v.caretWidth.value <= 20 && v.pointerSize.value >= 1 && v.pointerSize.value <= 15);
    t.check('touch indicator 0..2', [0, 1, 2].includes(v.touchIndicator.value), short(v.touchIndicator));
    t.check('flash screen is a known choice', ['off', 'title', 'window', 'display'].includes(v.flashScreen.value), short(v.flashScreen));
    const ct = v.contrastTheme;
    t.check('contrast theme is a known choice', ['none', 'aquatic', 'desert', 'dusk', 'nightSky', 'custom'].includes(ct.value), short(ct));
    t.check('contrast themes: None + four, each with a label', Array.isArray(ct.themes) && ct.themes.length === 5 && ct.themes.every((x) => x.label && typeof x.present === 'boolean'), short(ct.themes));
    t.check('Windows 11 names and order: Aquatic, Desert, Dusk, Night sky', ct.themes.slice(1).map((x) => x.label).join() === 'Aquatic,Desert,Dusk,Night sky' && ct.themes.slice(1).map((x) => x.file).join() === 'hcblack.theme,hcwhite.theme,hc1.theme,hc2.theme', short(ct.themes));
    const tools = st.result.tools || {};
    t.check('five tools with present/running', TOOLS.every((k) => tools[k] && typeof tools[k].present === 'boolean' && typeof tools[k].running === 'boolean'), short(tools));
    t.check('a missing tool says why', TOOLS.every((k) => tools[k].present || /does not have/.test(tools[k].why)));
    console.log(`  (${writable.length} writable, ${KEYS.length - writable.length} read-only; sticky ${v.stickyOn.value}/${v.stickyShortcut.value}, filter ${v.filterOn.value}, toggle ${v.toggleOn.value}, mouse keys ${v.mouseKeysOn.value}, text ${v.textSize.value}%, contrast ${ct.value}; themes: ${ct.themes.map((x) => x.label).join(', ')})`);
    console.log(`  (tools present: ${TOOLS.filter((k) => tools[k].present).join(' ')}; running: ${TOOLS.filter((k) => tools[k].running).join(' ') || 'none'})`);

    // --- every writable key: dryRun with the CURRENT value (a no-op even if it were real)
    for (const k of writable) {
      if (v[k].value === null) { t.check(`${k}: unreadable, so no dryRun (${v[k].why})`, !!v[k].why); continue; }
      const val = k === 'contrastTheme' && v[k].value === 'custom' ? 'none' : v[k].value;
      const d = await send('access.set', { key: k, value: val, dryRun: true });
      t.check(`${k} dryRun says what it would write`, d.ok && d.result.dryRun === true && /^(turn|set) /.test(d.result.would) && Array.isArray(d.result.writes) && d.result.writes.length >= 1, short(d));
    }
    const sk = await send('access.set', { key: 'stickyShortcut', value: v.stickyShortcut.value, dryRun: true });
    t.check('sticky shortcut: ONE flag of SPI_SETSTICKYKEYS, every other flag kept', sk.ok && sk.result.writes.length === 1 && sk.result.writes[0].action === 'SPI_SETSTICKYKEYS' && sk.result.writes[0].value.otherFlagsKept === true && sk.result.writes[0].value.flag === '0x4', short(sk));
    const sw = await send('access.set', { key: 'shortcutWarning', value: v.shortcutWarning.value, dryRun: true });
    t.check('the shortcut warning covers sticky, filter and toggle keys', sw.ok && sw.result.writes.map((w) => w.action).join() === 'SPI_SETSTICKYKEYS,SPI_SETFILTERKEYS,SPI_SETTOGGLEKEYS', short(sw));
    const ps = await send('access.set', { key: 'pointerSize', value: v.pointerSize.value, dryRun: true });
    t.check('pointer size: two values and the pointer reload', ps.ok && ps.result.writes.length === 3 && ps.result.writes[2].action === 'SPI_SETCURSORS' && ps.result.writes[1].value === 32 + (v.pointerSize.value - 1) * 16, short(ps));
    const ts = await send('access.set', { key: 'textSize', value: v.textSize.value, dryRun: true });
    t.check('text size: TextScaleFactor in HKCU', ts.ok && ts.result.writes[0].name === 'TextScaleFactor' && ts.result.writes[0].hive === 'HKCU', short(ts));
    const cv = ct.value === 'custom' ? 'none' : ct.value;
    const cd = await send('access.set', { key: 'contrastTheme', value: cv, dryRun: true });
    t.check('contrast theme: SPI_SETHIGHCONTRAST', cd.ok && cd.result.writes.some((w) => w.action === 'SPI_SETHIGHCONTRAST'), short(cd));
    const cd2 = await send('access.set', { key: 'contrastTheme', value: 'aquatic', dryRun: true });
    t.check('Aquatic names its file (hcblack.theme) for Windows', cd2.ok && cd2.result.writes[0].name === 'LastHighContrastTheme' && /hcblack\.theme/.test(cd2.result.writes[0].value), short(cd2));
    if (!v.magSignIn.readOnly) {
      const si = await send('access.set', { key: 'magSignIn', value: v.magSignIn.value, dryRun: true });
      t.check('after sign-in edits one token of Configuration', si.ok && si.result.writes[0].name === 'Configuration' && /every other tool/.test(si.result.writes[0].value), short(si));
    }

    // --- real writes are refused in passive (the current value, so even a leak would be a no-op)
    for (const k of ['stickyShortcut', 'filterOn', 'textSize', 'animations', 'transparency', 'caretWidth', 'mouseKeysSpeed', 'flashScreen']) {
      if (v[k].value === null) continue;
      const r = await send('access.set', { key: k, value: v[k].value });
      t.check(`a real ${k} change is refused in passive`, refused(r), short(r));
    }
    const rc = await send('access.set', { key: 'contrastTheme', value: cv });
    t.check('a real contrast theme change is refused in passive', refused(rc), short(rc));

    // --- access.start: dryRun for every tool there and not running; the real start refused
    for (const k of TOOLS) {
      const d = await send('access.start', { tool: k, dryRun: true });
      if (!tools[k].present) t.check(`start ${k}: not there says why`, d.ok === false && /does not have/.test(d.error), short(d));
      else if (tools[k].running) t.check(`start ${k}: already running says so`, d.ok === false && /already running/.test(d.error), short(d));
      else t.check(`start ${k} dryRun says what it would do`, d.ok && d.result.dryRun && /^start .*System32/.test(d.result.would), short(d));
    }
    const m = tools.magnifier;
    if (m.present && !m.running) {
      const r = await send('access.start', { tool: 'magnifier' });
      t.check('a real Magnifier start is refused in passive', refused(r), short(r));
    }

    // --- bad args
    const bads = [
      [{ value: true }, /needs key/], [{ key: 'stickyOn' }, /needs value/], [{ key: 'nope', value: true, dryRun: true }, /unknown key/],
      [{ key: 'stickyOn', value: 1, dryRun: true }, /true or false/], [{ key: 'textSize', value: 99, dryRun: true }, /100 to 225/],
      [{ key: 'textSize', value: 226, dryRun: true }, /100 to 225/], [{ key: 'textSize', value: 150.5, dryRun: true }, /whole number/],
      [{ key: 'textSize', value: '150', dryRun: true }, /whole number/], [{ key: 'notifyDuration', value: 6, dryRun: true }, /one of: 5, 7, 15, 30, 60, 300/],
      [{ key: 'flashScreen', value: 'strobe', dryRun: true }, /one of: off, title/], [{ key: 'contrastTheme', value: '..\\..\\evil', dryRun: true }, /one of: none/],
      [{ key: 'contrastTheme', value: 'custom', dryRun: true }, /one of: none/], [{ key: 'mouseKeysSpeed', value: 9999, dryRun: true }, /10 to 360/],
      [{ key: 'pointerStyle', value: 1, dryRun: true }, /^Read only/], [{ key: 'monoAudio', value: true, dryRun: true }, /^Read only/],
      [{ key: 'eyeControl', value: true, dryRun: true }, /^Read only/], [{ key: 'cursorIndicator', value: true, dryRun: true }, /^Read only/],
    ];
    for (const [a, re] of bads) {
      const r = await send('access.set', a);
      t.check(`set refuses ${short(a).slice(0, 70)}`, r.ok === false && re.test(r.error), short(r));
    }
    for (const [a, re] of [[{}, /needs tool/], [{ tool: 'cmd', dryRun: true }, /tool must be/], [{ tool: '..\\cmd', dryRun: true }, /tool must be/]]) {
      const r = await send('access.start', a);
      t.check(`start refuses ${short(a)}`, r.ok === false && re.test(r.error), short(r));
    }

    // --- nothing changed
    const again = await send('access.settings');
    const w = again.ok && again.result.values;
    const same = w && KEYS.filter((k) => JSON.stringify(w[k].value) !== JSON.stringify(v[k].value));
    t.check('nothing changed', w && same.length === 0, short(same));
  } catch (e) {
    t.fail('the run threw', e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e));
  } finally {
    await s.stop();
  }
  process.exit(t.summary());
})();

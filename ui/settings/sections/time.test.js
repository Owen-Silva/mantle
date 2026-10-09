require('C:/Users/user/dev-tools/tools/lowcpu.js');
/* time.test.js — Mantle Settings > Time & language (lane timelang, 2026-09-28).
 *
 * PART 1 (node, always): the main half (lib/features/_settings-sections/time.js) against
 * sidecar/SysTime*.cs: every command it names is a real sidecar command, every administrator row is
 * a real [Elevated] action, a test run sends EVERY write as a dryRun (the administrator rows too:
 * never a prompt), arguments pass a whitelist (never `id`), and a live administrator row turns the
 * sidecar's needsAdmin into ONE env.elevate of exactly that action. Plus the page file's shape
 * (model.js checkSection), that every search row is drawn by the page, that it claims its Windows
 * Settings pages and never hands off to Windows Settings.
 *
 * PART 2 (headless chromium over file://, never Electron, never a real setting): the REAL page file
 * on the settings lane's mock (mock-mantle.js), with settings.time.* played by FAKE() below over
 * MADE-UP fixtures. Screenshots go to MANTLE_SHOOT_OUT (default scratchpad/lanes/timelang-shots).
 * Line 1 is the machine-wide CPU cap and browser lock.
 *
 *   node ui/settings/sections/time.test.js      (ONLY=time-02,time-05 for some shots)
 * Prints "TIME PAGE TEST: n passed, m failed". A game running = part 2 is skipped (and said).
 */
'use strict';
const path = require('path');
const fs = require('fs');
const vm = require('vm');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const CHROME = 'C:/Users/user/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const PAGE = 'file:///' + path.resolve(__dirname, '..', 'index.html').replace(/\\/g, '/');
const OUT = process.env.MANTLE_SHOOT_OUT ||
  'C:/Users/user/AppData/Local/Temp/claude/C--Users-owens/fe6c395c-2ffc-4958-a961-d5833371924e/scratchpad/lanes/timelang-shots';
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null;

let passed = 0;
const failures = [];
const check = (name, ok, detail) => { if (ok) passed++; else failures.push(detail ? `${name} (${String(detail).slice(0, 300)})` : name); return ok; };

function gaming() {
  try {
    const n = execSync('powershell -NoProfile -Command "@(Get-Process javaw,Minecraft*,RobloxPlayerBeta,VALORANT* -ErrorAction SilentlyContinue).Count"', { encoding: 'utf8' });
    return parseInt(n.trim(), 10) || 0;
  } catch (_) { return -1; }
}

/* ================================================================ PART 1: node */
async function nodeTests() {
  const cs = ['SysTime.cs', 'SysTimeRegion.cs', 'SysTimeLang.cs'].map((f) => fs.readFileSync(path.join(ROOT, 'sidecar', f), 'utf8')).join('\n');
  const cmds = new Set([...cs.matchAll(/t\.Add\("((?:systime|sysregion|syslang)\.[A-Za-z]+)"/g)].map((m) => m[1]));
  const elevated = new Set([...cs.matchAll(/\[Elevated\("([^"]+)"/g)].map((m) => m[1]));
  check('the sidecar files list their commands', cmds.size === 19, [...cmds].join(' '));
  check('the sidecar has the four administrator actions', ['time.setAutoSync', 'time.setAutoZone', 'time.setClock', 'time.syncNow'].every((a) => elevated.has(a)), [...elevated].join(' '));
  const main = require(path.join(ROOT, 'lib', 'features', '_settings-sections', 'time.js'));
  check('main: id is time', main.id === 'time');
  const reads = Object.values(main.READS).map((x) => x[0]);
  const writes = Object.values(main.WRITES).map((x) => x[0]);
  check('main: every reading is a real sidecar command', reads.every((c) => cmds.has(c)), reads.filter((c) => !cmds.has(c)).join(' '));
  check('main: every change is a real sidecar command', writes.every((c) => cmds.has(c)), writes.filter((c) => !cmds.has(c)).join(' '));
  const unreached = [...cmds].filter((c) => !reads.includes(c) && !writes.includes(c));
  check('main: every sidecar command can be reached', !unreached.length, unreached.join(' '));
  check('main: every administrator row is a real [Elevated] action', Object.values(main.ADMIN).every((a) => elevated.has(a)) && Object.keys(main.ADMIN).length === 4);
  check('main: every command is a function', Object.keys(main.READS).concat(Object.keys(main.WRITES)).every((n) => typeof main.commands[n] === 'function'));

  // a mock env: the sidecar answers dry runs with a plan, real admin writes with needsAdmin
  const sent = [];
  const elevations = [];
  const mk = (test, elevateAnswer) => ({ id: 'time', test, log() {}, push() {}, onRest: () => () => {},
    elevate: async (action, args) => { elevations.push([action, args]); return elevateAnswer || { ok: false, kind: 'cancelled' }; },
    sidecar: { on: () => () => {}, send: async (c, a) => {
      sent.push([c, a]);
      const adminCmd = { 'systime.setAutoSync': 'time.setAutoSync', 'systime.setAutoZone': 'time.setAutoZone', 'systime.setClock': 'time.setClock', 'systime.syncNow': 'time.syncNow' }[c];
      if (a.dryRun) return { ok: true, result: { ok: true, dryRun: true, would: adminCmd ? 'ask for administrator permission to do ' + c : 'change ' + c, writes: [], needsAdmin: !!adminCmd } };
      if (adminCmd) return { ok: true, result: { ok: false, needsAdmin: true, elevate: { action: adminCmd, args: Object.assign({}, a) }, reason: 'Windows will ask for administrator permission to x' } };
      return { ok: true, result: { ok: true, dryRun: false, now: 'read-back' } };
    } } });
  const W = {
    setZone: { zone: 'Made Up Standard Time' }, setDst: { on: false }, setExtraClock: { slot: 1, on: true, zone: 'Made Up Standard Time', name: 'Home' },
    setTray: { key: 'showSeconds', value: true }, setFormat: { key: 'shortDate', value: 'd/M/yyyy' }, setLocale: { locale: 'en-GB' }, setGeo: { geo: 'GB' },
    setTyping: { key: 'autocorrect', value: false }, setPerAppInput: { on: true },
    setAutoSync: { on: false }, setAutoZone: { on: true }, setClock: { year: 2026, month: 9, day: 28, hour: 12, minute: 0, second: 0 }, syncNow: {},
  };
  check('the test covers every change', Object.keys(W).sort().join() === Object.keys(main.WRITES).sort().join(), Object.keys(main.WRITES).join(' '));
  const T = mk(true);
  for (const [name, args] of Object.entries(W)) {
    sent.length = 0; elevations.length = 0;
    const r = await main.commands[name](Object.assign({ id: 'evil', extra: 1 }, args), T);
    check(`test run: ${name} is one dry run`, r.ok === true && r.dryRun === true && sent.length === 1 && sent[0][1].dryRun === true && /^Test run, nothing changed: Mantle would /.test(r.reason), JSON.stringify([r, sent]));
    check(`test run: ${name} sends only its own arguments (never id)`, sent.length === 1 && !('id' in sent[0][1]) && !('extra' in sent[0][1]), JSON.stringify(sent));
    check(`test run: ${name} never asks for an administrator`, elevations.length === 0);
  }
  // live: a normal write returns the read-back as value; an administrator row becomes one prompt
  const L = mk(false);
  sent.length = 0;
  const z = await main.commands.setZone({ zone: 'Made Up Standard Time' }, L);
  check('live: setZone sends no dryRun and returns the read-back', z.ok && z.value === 'read-back' && sent[0][1].dryRun === false, JSON.stringify([z, sent]));
  for (const name of Object.keys(main.ADMIN)) {
    elevations.length = 0;
    const r = await main.commands[name](W[name], L);
    check(`live: ${name} becomes ONE prompt for ${main.ADMIN[name]}`, elevations.length === 1 && elevations[0][0] === main.ADMIN[name], JSON.stringify(elevations));
    check(`live: a declined ${name} prompt comes back cancelled`, r.ok === false && r.cancelled === true, JSON.stringify(r));
  }
  elevations.length = 0;
  const ok = await main.commands.setClock(W.setClock, mk(false, { ok: true, kind: 'ok', result: { now: '2026-09-28T12:00:00' } }));
  check('live: an approved clock change passes its arguments and says changed', ok.ok && ok.changed === true && elevations[0][1].year === 2026 && elevations[0][1].second === 0, JSON.stringify([ok, elevations]));

  // the page file: shape, search rows drawn, claims, no hand-off
  const M = require(path.join(ROOT, 'ui', 'settings', 'model.js'));
  let def = null;
  const src = fs.readFileSync(path.join(ROOT, 'ui', 'settings', 'sections', 'time.js'), 'utf8');
  vm.runInNewContext(src, { MantleSettings: { section(d) { def = d; } }, window: {}, document: { currentScript: { dataset: { section: 'time' } } }, console });
  check('page: checkSection is happy', def && M.checkSection(def, 'time') === null, def && M.checkSection(def, 'time'));
  check('page: four pages, all drawn natively', def && def.pages.map((p) => p.id).join() === 'datetime,region,typing,speech' && def.pages.every((p) => typeof p.render === 'function'));
  const typingKeys = [...fs.readFileSync(path.join(ROOT, 'sidecar', 'SysTimeLang.cs'), 'utf8').matchAll(/\{ "([a-zA-Z]+)", (?:TipKey|InputKey), "/g)].map((m) => m[1]);
  const drawn = (row) => src.includes(`'${row}'`) ||
    (/^time\.datetime\.clock[12]$/.test(row) && src.includes("'time.datetime.clock' + slot")) ||
    (/^time\.typing\./.test(row) && typingKeys.includes(row.split('.').pop()) && src.includes("'time.typing.' + x.key")) ||
    (/^time\.region\.preview\./.test(row) && src.includes("'time.region.preview.' + k"));
  const all = def ? def.pages.flatMap((p) => p.search || []) : [];
  const notDrawn = all.filter((s) => !drawn(s.row));
  check('page: every search row is drawn by the page', all.length >= 40 && !notDrawn.length, notDrawn.map((s) => s.row).join(' ') + ` (${all.length} rows)`);
  check('page: the typing search rows match the sidecar\'s typing keys', typingKeys.length === 9 && typingKeys.every((k) => all.some((s) => s.row === 'time.typing.' + k)), typingKeys.join(' '));
  const claims = all.filter((s) => s.uri).map((s) => s.uri);
  check('page: claims the Windows Settings pages it replaces', ['ms-settings:dateandtime', 'ms-settings:regionlanguage', 'ms-settings:regionformatting', 'ms-settings:typing', 'ms-settings:keyboard', 'ms-settings:speech'].every((u) => claims.includes(u)), claims.join(' '));
  check('page: never hands off to Windows Settings', !/openWindows|ms-settings:[a-z-]+'\)/.test(src.replace(/row\([^\n]*\n/g, '')));
  const idx = M.buildIndex ? M.buildIndex : null;
  check('page: model knows buildIndex (search metadata)', typeof idx === 'function');
}

/* ================================================================ PART 2: the page on the mock */
/* Runs IN THE PAGE (addInitScript): wraps mock-mantle.js's window.mantle. Everything is made up. */
function FAKE() {
  const q = new URLSearchParams(location.search);
  const TEST = q.get('test') === '1', SCN = q.get('tl') || 'normal';
  const later = (ms, v) => new Promise((res) => setTimeout(() => res(v), ms));
  const J = (x) => JSON.parse(JSON.stringify(x));
  const no = (why) => ({ ok: false, reason: why });
  const ZONES = [
    { zone: 'Hawaiian Standard Time', name: '(UTC-10:00) Hawaii', offsetMinutes: -600, dst: false },
    { zone: 'Pacific Standard Time', name: '(UTC-08:00) Pacific Time (US & Canada)', offsetMinutes: -480, dst: true },
    { zone: 'Eastern Standard Time', name: '(UTC-05:00) Eastern Time (US & Canada)', offsetMinutes: -300, dst: true },
    { zone: 'GMT Standard Time', name: '(UTC+00:00) Dublin, Edinburgh, Lisbon, London', offsetMinutes: 0, dst: true },
    { zone: 'Tokyo Standard Time', name: '(UTC+09:00) Osaka, Sapporo, Tokyo', offsetMinutes: 540, dst: false },
  ];
  const autoOn = SCN !== 'manual';
  const G = {
    ok: true, now: { local: '2026-09-28T21:14:05', utc: '2026-09-29T04:14:05Z', epochMs: 1790655245000, date: 'Monday, September 28, 2026', time: '9:14:05 PM', timeShort: '9:14 PM' },
    zone: { key: 'Pacific Standard Time', name: '(UTC-08:00) Pacific Time (US & Canada)', standardName: 'Pacific Standard Time', daylightName: 'Pacific Daylight Time',
      offsetMinutes: -420, daylightNow: true, supportsDst: true, dstAuto: true, dstReason: null, writable: SCN !== 'blocked', reason: SCN === 'blocked' ? 'Set time zone automatically is on, so Windows picks the zone from your location; turn that off to choose one' : null,
      privilege: { name: 'SeTimeZonePrivilege', held: true, enabled: false, reason: null } },
    autoTime: { on: autoOn, type: autoOn ? 'NTP' : 'NoSync', servers: ['time.example.net'], service: { state: 'stopped', startType: 'manual', reason: null }, lastGood: '2026-09-28T03:28:05', lastGoodReason: null, admin: 'time.setAutoSync', reason: null },
    autoZone: { on: SCN === 'blocked', service: { state: 'stopped', startType: SCN === 'blocked' ? 'manual' : 'disabled' }, works: SCN !== 'blocked',
      blocked: SCN === 'blocked' ? 'location services are off for this PC (Privacy & security > Location), and Windows needs your location to set the time zone automatically' : null, admin: 'time.setAutoZone', reason: null },
    clock: { admin: 'time.setClock', reason: autoOn ? 'Set time automatically is on, so Windows would put the time right back at the next sync; turn it off to set the time yourself' : null },
    sync: { admin: 'time.syncNow', server: 'time.example.net', reason: autoOn ? null : 'Set time automatically is off, so there is no time server to sync with' },
    tray: { showSeconds: { on: false, set: false, info: 'not set: Windows\' default (off) applies' }, clockHidden: { on: false, reason: null } },
    extraClocks: [{ slot: 1, on: true, name: 'Tokyo office', zone: 'Tokyo Standard Time', zoneName: '(UTC+09:00) Osaka, Sapporo, Tokyo', info: null },
      { slot: 2, on: false, name: null, zone: null, zoneName: null, info: 'not set up' }],
    elevated: false, problems: [],
  };
  const fmt = (value, def, opts, extra) => Object.assign({ value, default: def, override: value !== def, sample: null, options: opts, registry: 'HKCU\\Control Panel\\International\\x', reason: null }, extra || {});
  const R = {
    ok: true, locale: { name: 'en-US', display: 'English (United States)', reason: null }, geo: { code: 'US', name: 'United States', reason: null },
    formats: {
      shortDate: fmt('yyyy-MM-dd', 'M/d/yyyy', [{ value: 'yyyy-MM-dd', label: '2026-09-28' }, { value: 'M/d/yyyy', label: '9/28/2026' }, { value: 'M/d/yy', label: '9/28/26' }, { value: 'MM/dd/yy', label: '09/28/26' }]),
      longDate: fmt('dddd, MMMM d, yyyy', 'dddd, MMMM d, yyyy', [{ value: 'dddd, MMMM d, yyyy', label: 'Monday, September 28, 2026' }, { value: 'MMMM d, yyyy', label: 'September 28, 2026' }]),
      shortTime: fmt('h:mm tt', 'h:mm tt', [{ value: 'h:mm tt', label: '9:14 PM' }, { value: 'hh:mm tt', label: '09:14 PM' }, { value: 'H:mm', label: '21:14' }, { value: 'HH:mm', label: '21:14' }]),
      longTime: fmt('h:mm:ss tt', 'h:mm:ss tt', [{ value: 'h:mm:ss tt', label: '9:14:05 PM' }, { value: 'HH:mm:ss', label: '21:14:05' }]),
      firstDayOfWeek: fmt('6', '6', ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].map((d, i) => ({ value: String(i), label: d }))),
      measure: fmt('1', '1', [{ value: '0', label: 'Metric' }, { value: '1', label: 'U.S.' }]),
    },
    overrides: ['shortDate'],
    preview: { shortDate: '2026-09-28', longDate: 'Monday, September 28, 2026', shortTime: '9:14 PM', longTime: '9:14:05 PM', number: '1,234,567.89', negative: '-42.50', currency: '$1,234,567.89', firstDay: 'Sunday', measure: 'U.S.', calendar: 'Gregorian Calendar' },
    symbols: { decimal: '.', thousand: ',', currency: '$' },
    systemLocale: { name: 'en-US', display: 'English (United States)', reason: 'the language for non-Unicode programs is set for the whole PC and needs a restart; Windows only changes it from its administrative language settings (administrator)' },
  };
  const GB = { shortDate: '28/09/2026', longDate: '28 September 2026', shortTime: '21:14', longTime: '21:14:05', number: '1,234,567.89', negative: '-42.50', currency: '£1,234,567.89', firstDay: 'Monday', measure: 'Metric', calendar: 'Gregorian Calendar' };
  const LISTS = { ok: true, reason: null,
    locales: [['de-DE', 'German (Germany)'], ['en-GB', 'English (United Kingdom)'], ['en-US', 'English (United States)'], ['fr-FR', 'French (France)'], ['ja-JP', 'Japanese (Japan)']].map(([locale, name]) => ({ locale, name })),
    geos: [['FR', 'France'], ['DE', 'Germany'], ['JP', 'Japan'], ['GB', 'United Kingdom'], ['US', 'United States']].map(([geo, name]) => ({ geo, name })) };
  const tip = (key, label, on, set) => ({ key, label, on, set, registry: 'HKCU\\Software\\Microsoft\\TabletTip\\1.7\\Enable' + key, info: set ? null : 'Not set on this PC, so Windows\' default (' + (on ? 'on' : 'off') + ') applies' });
  const LANG = { ok: true,
    display: { now: 'en-US', name: 'English (United States)', override: null, pending: null, installed: [{ tag: 'en-US', name: 'English (United States)' }],
      reason: 'Windows switches the display language only at the next sign-in, through its own language profile API; Mantle shows it but does not change it yet' },
    languages: [{ tag: 'en-US', name: 'English (United States)', keyboards: [{ entry: '0409:00000409', name: 'US' }] },
      { tag: 'fr-FR', name: 'French (France)', keyboards: [{ entry: '040C:0000040C', name: 'French' }, { entry: '040C:{made-up}', name: 'Input method (text service)' }] }],
    languagesReason: null,
    addReason: 'adding a language downloads its language pack from Microsoft (Windows\' Language features, administrator), so Mantle does not add or remove languages',
    orderReason: 'Windows keeps this list through its language profile API (winlangdb SetUserLanguages), which Mantle has not wired yet, so the order is shown but not changed',
    typing: [tip('touchSuggestions', 'Show text suggestions when typing on the touch keyboard', true, false), tip('hwSuggestions', 'Show text suggestions when typing on the physical keyboard', true, true),
      tip('multilingual', 'Multilingual text suggestions', false, false), tip('autocorrect', 'Autocorrect misspelled words', true, false), tip('highlight', 'Highlight misspelled words', true, false),
      tip('hwAutocorrect', 'Autocorrect misspelled words I type on the physical keyboard', false, false), tip('spaceAfter', 'Add a space after I choose a text suggestion', true, false),
      tip('doubleTapPeriod', 'Add a period after I double-tap the Spacebar', true, false), tip('insights', 'Typing insights', true, false)],
    keyboard: { defaultInput: { value: null, text: 'Use language list (recommended)', reason: 'Windows sets this through its language profile API (bcp47langs SetInputMethodOverride), which Mantle has not wired yet, so it is shown here but not changed' },
      perAppInput: { on: false, reason: null }, languageBar: { value: null, text: 'not set (Windows\' default: the input indicator, no floating bar)', reason: 'the language bar belongs to Windows\' text input framework (CTF), which applies it itself; Mantle shows it but does not change it' } },
    speech: { voices: [{ token: 'V1', name: 'Made-up Voice One - English (United States)', language: 'en-US', languageName: 'English (United States)', gender: 'Male', source: 'Windows (OneCore)', isDefault: true },
      { token: 'V2', name: 'Made-up Voice Two - English (United States)', language: 'en-US', languageName: 'English (United States)', gender: 'Female', source: 'Windows (OneCore)', isDefault: false },
      { token: 'V3', name: 'Made-up Desktop Voice', language: 'en-US', languageName: 'English (United States)', gender: 'Male', source: 'Desktop apps (SAPI 5)', isDefault: false }],
    recognizers: [{ token: 'R1', name: 'Made-up Recognizer (English - US)', language: 'en-US', languageName: 'English (United States)', gender: null, source: 'Desktop apps (SAPI 5)', isDefault: false }],
    defaultVoice: 'V1', reason: 'voices and speech recognizers are installed with Windows\' speech language features (a download from Microsoft), so Mantle lists them but does not add or remove them' } };

  const ADMIN = { setAutoSync: 'turn setting the time automatically on or off', setAutoZone: 'turn setting the time zone automatically on or off', setClock: 'set this PC\'s date and time', syncNow: 'sync the clock with the time server now' };
  function answer(name, a) {
    if (SCN === 'fail') return later(30, no('settings.time.' + name + ' failed: the sidecar is not running (made up)'));
    switch (name) {
      case 'get': return later(30, J(G));
      case 'zones': return later(30, { ok: true, zones: J(ZONES), reason: null });
      case 'region': return later(30, J(R));
      case 'lists': return later(40, J(LISTS));
      case 'preview': return later(30, a.locale === 'en-GB' ? { ok: true, locale: 'en-GB', display: 'English (United Kingdom)', preview: J(GB) } : no('fake: no preview for ' + a.locale));
      case 'lang': return later(30, J(LANG));
    }
    if (TEST) {
      const would = ADMIN[name] ? 'ask for administrator permission to ' + ADMIN[name] : name + ' ' + JSON.stringify(a);
      return later(30, Object.assign({ ok: true, dryRun: true, reason: 'Test run, nothing changed: Mantle would ' + would }, name === 'setLocale' ? { preview: J(GB) } : {}));
    }
    if (name === 'setAutoSync' || name === 'setAutoZone' || name === 'syncNow') return later(60, { ok: false, cancelled: true, kind: 'cancelled', reason: 'You said no to the administrator prompt; nothing changed.' });
    if (name === 'setClock') return later(60, { ok: true, kind: 'ok', changed: true, now: '2026-09-28T12:00:00', note: 'The clock now reads 2026-09-28 12:00:00' });
    if (name === 'setDst') { G.zone.dstAuto = a.on; return later(40, { ok: true, value: a.on }); }
    if (name === 'setZone') { const z = ZONES.find((x) => x.zone === a.zone); if (z) { G.zone.key = z.zone; G.zone.name = z.name; } return later(40, { ok: true, value: a.zone }); }
    if (name === 'setFormat') { R.formats[a.key].value = a.value; R.overrides = Object.keys(R.formats).filter((k) => R.formats[k].value !== R.formats[k].default); return later(40, { ok: true, value: a.value }); }
    if (name === 'setExtraClock') {
      const c = G.extraClocks[a.slot - 1], z = ZONES.find((x) => x.zone === a.zone);
      Object.assign(c, { on: a.on, zone: a.zone || null, name: a.name || null, zoneName: z ? z.name : null, info: null });
      return later(40, { ok: true, dryRun: false, reason: null });
    }
    if (name === 'setTyping') return later(30, no('Windows refused the write: access denied (5) (made up)'));
    return later(30, { ok: true, value: a.value !== undefined ? a.value : a.on });
  }
  let real;
  Object.defineProperty(window, 'mantle', {
    configurable: true,
    get() { return real; },
    set(m) {
      real = { on: m.on.bind(m), call(name, args) {
        const copy = args && typeof args === 'object' ? JSON.parse(JSON.stringify(args)) : {};
        if (name === 'settings.sections') return Promise.resolve({ ok: true, reason: null, sections: [{ id: 'time', file: 'sections/time.js', down: null, main: null }] });
        const mm = /^settings\.time\.(\w+)$/.exec(name);
        if (!mm) return m.call(name, args);
        (window.__mockCalls = window.__mockCalls || []).push({ name, args: copy });
        return answer(mm[1], copy);
      } };
    },
  });
}

const sel = (row) => `[data-row="${row}"]`;
const rowText = (p, row) => p.evaluate((s) => { const e = document.querySelector(s); return e ? e.textContent : null; }, sel(row));
const whyText = (p, row) => p.evaluate((s) => { const e = document.querySelector(s + ' .row-w'); return e ? e.textContent : null; }, sel(row));
const helpText = (p, row) => p.evaluate((s) => { const e = document.querySelector(s + ' .row-h'); return e ? e.textContent : null; }, sel(row));
const valText = (p, row) => p.evaluate((s) => { const e = document.querySelector(s + ' .val'); return e ? e.textContent : null; }, sel(row));
const selVal = (p, row) => p.evaluate((s) => { const e = document.querySelector(s + ' select'); return e ? e.value : null; }, sel(row));
const swOn = (p, row) => p.evaluate((s) => { const e = document.querySelector(s + ' button[role="switch"]'); return e ? e.getAttribute('aria-checked') : null; }, sel(row));
const disabled = (p, row, what) => p.evaluate(([s, w]) => { const e = document.querySelector(s + ' ' + w); return e ? e.disabled : null; }, [sel(row), what]);
const shown = (p, row) => p.evaluate((s) => { const e = document.querySelector(s); return !!e && !!e.offsetParent; }, sel(row));
const scrollTo = (p, row) => p.evaluate((s) => { const e = document.querySelector(s); if (e) e.scrollIntoView({ block: 'start' }); }, sel(row));
const calls = (p, name) => p.evaluate((n) => (window.__mockCalls || []).filter((c) => c.name === n), name);
const DT = '?section=time&page=datetime', RG = '?section=time&page=region';

const SHOTS = [
  ['time-01-datetime', DT, async (p) => {
    check('01: the clock reads', /9:14 PM, Monday, September 28, 2026/.test(await valText(p, 'time.datetime.now') || ''), await valText(p, 'time.datetime.now'));
    check('01: set time automatically is on, with its server and the shield sentence', await swOn(p, 'time.datetime.autoTime') === 'true' && /time\.example\.net/.test(await helpText(p, 'time.datetime.autoTime') || '') &&
      /Windows will ask for administrator permission to turn setting the time automatically on or off/.test(await whyText(p, 'time.datetime.autoTime') || ''));
    check('01: the time zone dropdown holds the current zone', await selVal(p, 'time.datetime.zone') === 'Pacific Standard Time' && /UTC−07:00 \(Pacific Daylight Time\)/.test(await helpText(p, 'time.datetime.zone') || ''), await helpText(p, 'time.datetime.zone'));
    check('01: DST switch on and changeable', await swOn(p, 'time.datetime.dst') === 'true' && await disabled(p, 'time.datetime.dst', 'button[role="switch"]') === false);
    check('01: Change is off WITH its reason while automatic time is on', await disabled(p, 'time.datetime.manual', 'button') === true && /Set time automatically is on/.test(await whyText(p, 'time.datetime.manual') || ''));
    check('01: Sync now shows the last good time and server', /Last known good time 2026-09-28 03:28 · Time server: time\.example\.net/.test(await helpText(p, 'time.datetime.sync') || ''), await helpText(p, 'time.datetime.sync'));
    check('01: seconds switch says Windows\' default applies', /default \(off\) applies/.test(await whyText(p, 'time.datetime.traySeconds') || ''));
    check('01: tray clock and calendar are read-only WITH reasons', /Read only here/.test(await whyText(p, 'time.datetime.trayClock') || '') && /Read only here/.test(await whyText(p, 'time.datetime.calendar') || ''));
  }],
  ['time-02-clocks', DT, async (p) => {
    await scrollTo(p, 'time.datetime.clocks');
    check('02: additional clock 1 on with its zone and name', await swOn(p, 'time.datetime.clock1') === 'true' && await selVal(p, 'time.datetime.clock1.zone') === 'Tokyo Standard Time' &&
      await p.$eval(sel('time.datetime.clock1.name') + ' input', (i) => i.value) === 'Tokyo office');
    check('02: clock 2 not set up, says so', await swOn(p, 'time.datetime.clock2') === 'false' && /not set up/i.test(await whyText(p, 'time.datetime.clock2') || '') && /No zone chosen yet/.test(await whyText(p, 'time.datetime.clock2.zone') || ''));
    await p.click(sel('time.datetime.autoTime') + ' button[role="switch"]');
    await p.waitForTimeout(400);
    check('02: a declined administrator prompt springs back and says so', await swOn(p, 'time.datetime.autoTime') === 'true' && /You said no to the administrator prompt; nothing changed/.test(await whyText(p, 'time.datetime.autoTime') || ''));
    const c = await calls(p, 'settings.time.setAutoSync');
    check('02: the switch asked for exactly that change', c.length === 1 && c[0].args.on === false, JSON.stringify(c));
    await p.selectOption(sel('time.datetime.clock2.zone') + ' select', 'GMT Standard Time');
    await p.waitForTimeout(300);
    const e = await calls(p, 'settings.time.setExtraClock');
    check('02: choosing clock 2\'s zone saves slot 2 with that zone', e.length === 1 && e[0].args.slot === 2 && e[0].args.zone === 'GMT Standard Time' && e[0].args.on === false, JSON.stringify(e));
    await p.waitForTimeout(600);
    check('02: the re-read keeps clock 2\'s new zone (no bogus read-back)', await selVal(p, 'time.datetime.clock2.zone') === 'GMT Standard Time', await selVal(p, 'time.datetime.clock2.zone'));
    await scrollTo(p, 'time.datetime.clocks');
  }],
  ['time-03-manual', DT + '&tl=manual', async (p) => {
    check('03: automatic time off: Change is enabled, Sync now says why not', await disabled(p, 'time.datetime.manual', 'button') === false && /no time server to sync with/.test(await whyText(p, 'time.datetime.sync') || ''));
    await p.click(sel('time.datetime.manual') + ' button');
    await p.waitForTimeout(200);
    check('03: the editor opens with date, time and the shield', await shown(p, 'time.datetime.manual.date') && await shown(p, 'time.datetime.manual.time') && /administrator permission to set this PC's date and time/.test(await whyText(p, 'time.datetime.manual.set') || ''));
    await p.fill(sel('time.datetime.manual.date') + ' input', '28-09-2026');
    await p.press(sel('time.datetime.manual.date') + ' input', 'Enter');
    await p.click(sel('time.datetime.manual.set') + ' button');
    await p.waitForTimeout(250);
    check('03: a badly written date is refused on the row', /The date must look like 2026-09-28/.test(await whyText(p, 'time.datetime.manual.set') || ''));
    check('03: nothing was sent for it', (await calls(p, 'settings.time.setClock')).length === 0);
    await p.fill(sel('time.datetime.manual.date') + ' input', '2026-09-28');
    await p.press(sel('time.datetime.manual.date') + ' input', 'Enter');
    await p.fill(sel('time.datetime.manual.time') + ' input', '12:00');
    await p.press(sel('time.datetime.manual.time') + ' input', 'Enter');
    await scrollTo(p, 'time.datetime.manual');
    await p.screenshot({ path: path.join(OUT, 'time-03a-editor.png') });
    await p.click(sel('time.datetime.manual.set') + ' button');
    await p.waitForTimeout(300);
    const c = await calls(p, 'settings.time.setClock');
    check('03: Set sends the parsed date and time', c.length === 1 && c[0].args.year === 2026 && c[0].args.month === 9 && c[0].args.day === 28 && c[0].args.hour === 12 && c[0].args.minute === 0 && c[0].args.second === 0, JSON.stringify(c));
    check('03: an approved change closes the editor', !(await shown(p, 'time.datetime.manual.date')));
  }],
  ['time-04-testrun', DT + '&test=1', async (p) => {
    await p.click(sel('time.datetime.dst') + ' button[role="switch"]');
    await p.selectOption(sel('time.datetime.zone') + ' select', 'Tokyo Standard Time');
    await p.click(sel('time.datetime.traySeconds') + ' button[role="switch"]');
    await p.waitForTimeout(400);
    check('04: DST in a test run: a dry run that springs back', await swOn(p, 'time.datetime.dst') === 'true' && /Test run, nothing changed/.test(await whyText(p, 'time.datetime.dst') || ''));
    check('04: zone in a test run: springs back to Pacific', await selVal(p, 'time.datetime.zone') === 'Pacific Standard Time' && /Test run, nothing changed/.test(await whyText(p, 'time.datetime.zone') || ''));
    check('04: seconds in a test run: springs back', await swOn(p, 'time.datetime.traySeconds') === 'false' && /Test run/.test(await whyText(p, 'time.datetime.traySeconds') || ''));
  }],
  ['time-05-blocked', DT + '&tl=blocked', async (p) => {
    check('05: automatic zone on but blocked: the reason is on the row', await swOn(p, 'time.datetime.autoZone') === 'true' && /location services are off for this PC/i.test(await whyText(p, 'time.datetime.autoZone') || ''));
    check('05: the zone picker is read-only WITH the reason', await disabled(p, 'time.datetime.zone', 'select') === true && /Read only here: Set time zone automatically is on/.test(await whyText(p, 'time.datetime.zone') || ''));
    check('05: DST read-only with the same reason', await disabled(p, 'time.datetime.dst', 'button[role="switch"]') === true && /Read only here/.test(await whyText(p, 'time.datetime.dst') || ''));
  }],
  ['time-06-region', RG, async (p) => {
    check('06: display language read-only WITH its reason', /English \(United States\)/.test(await valText(p, 'time.region.display') || '') && /Read only here: Windows switches the display language only at the next sign-in/.test(await whyText(p, 'time.region.display') || ''));
    check('06: two preferred languages with keyboards', await p.locator('[data-row^="time.region.languages."]').count() === 2 && /Keyboards: French, Input method/.test(await p.evaluate(() => document.querySelectorAll('[data-row^="time.region.languages."]')[1].textContent)));
    check('06: Add a language is off WITH its reason', await disabled(p, 'time.region.addLanguage', 'button') === true && /language pack from Microsoft/.test(await whyText(p, 'time.region.addLanguage') || ''));
    check('06: country and format read', await selVal(p, 'time.region.country') === 'US' && await selVal(p, 'time.region.format') === 'en-US');
    check('06: the preview shows the current formats', /2026-09-28/.test(await valText(p, 'time.region.preview.shortDate') || '') && /\$1,234,567\.89/.test(await valText(p, 'time.region.preview.currency') || ''));
    const opts = await p.$$eval(sel('time.region.shortTime') + ' option', (o) => o.map((x) => x.textContent));
    check('06: look-alike time choices carry their pattern', opts.includes('21:14  (H:mm)') && opts.includes('21:14  (HH:mm)') && opts.includes('9:14 PM'), opts.join(' | '));
    check('06: a custom short date says so', /Custom: the regional format's own is 9\/28\/2026/.test(await whyText(p, 'time.region.shortDate') || ''), await whyText(p, 'time.region.shortDate'));
    check('06: Reset is enabled with its count', await disabled(p, 'time.region.reset', 'button') === false && /1 custom format/.test(await whyText(p, 'time.region.reset') || ''));
    check('06: non-Unicode language is read-only WITH its reason', /Read only here: the language for non-Unicode programs/.test(await whyText(p, 'time.region.systemLocale') || ''));
    await p.selectOption(sel('time.region.previewAs') + ' select', 'en-GB');
    await p.waitForTimeout(300);
    check('06: previewing en-GB shows its formats without changing anything', /English \(United Kingdom\)/.test(await valText(p, 'time.region.preview') || '') && /28\/09\/2026/.test(await valText(p, 'time.region.preview.shortDate') || '') &&
      /£/.test(await valText(p, 'time.region.preview.currency') || '') && (await calls(p, 'settings.time.setLocale')).length === 0);
    await p.selectOption(sel('time.region.firstDay') + ' select', '0');
    await p.waitForTimeout(700);
    const f = await calls(p, 'settings.time.setFormat');
    check('06: first day of week sends its key and value, and reads back', f.length === 1 && f[0].args.key === 'firstDayOfWeek' && f[0].args.value === '0' && await selVal(p, 'time.region.firstDay') === '0', JSON.stringify(f));
    await scrollTo(p, 'time.region.previewGroup');
  }],
  ['time-07-region-testrun', RG + '&test=1', async (p) => {
    await p.selectOption(sel('time.region.format') + ' select', 'en-GB');
    await p.waitForTimeout(400);
    check('07: a test-run format switch springs back WITH its note', await selVal(p, 'time.region.format') === 'en-US' && /Test run, nothing changed/.test(await whyText(p, 'time.region.format') || ''));
    check('07: and previews what it would have been', /a test run: shown, not applied/.test(await valText(p, 'time.region.preview') || '') && /28\/09\/2026/.test(await valText(p, 'time.region.preview.shortDate') || ''));
    await p.selectOption(sel('time.region.country') + ' select', 'GB');
    await p.waitForTimeout(300);
    check('07: a test-run region change springs back', await selVal(p, 'time.region.country') === 'US' && /Test run/.test(await whyText(p, 'time.region.country') || ''));
    await scrollTo(p, 'time.region.country');
  }],
  ['time-08-typing', '?section=time&page=typing', async (p) => {
    check('08: nine typing switches and the per-app input switch',await p.locator('[data-row^="time.typing."] button[role="switch"]').count() === 10);
    check('08: an unset switch says Windows\' default applies', /Windows' default \(on\) applies/.test(await whyText(p, 'time.typing.autocorrect') || ''));
    check('08: each shows its registry place', /HKCU\\Software\\Microsoft\\TabletTip/.test(await helpText(p, 'time.typing.autocorrect') || ''));
    await p.click(sel('time.typing.autocorrect') + ' button[role="switch"]');
    await p.waitForTimeout(300);
    check('08: a refused write springs back WITH Windows\' words', await swOn(p, 'time.typing.autocorrect') === 'true' && /access denied/.test(await whyText(p, 'time.typing.autocorrect') || ''));
    check('08: default input method and language bar read-only WITH reasons', /Read only here: Windows sets this through its language profile API/.test(await whyText(p, 'time.typing.defaultInput') || '') && /Read only here: the language bar/.test(await whyText(p, 'time.typing.languageBar') || ''));
    check('08: per-app input switch can move', await disabled(p, 'time.typing.perApp', 'button[role="switch"]') === false);
    await scrollTo(p, 'time.typing.hwAutocorrect');
  }],
  ['time-09-speech', '?section=time&page=speech', async (p) => {
    check('09: three voices, the default marked', await p.locator('[data-row^="time.speech.voices."]').count() === 3 && /Default/.test(await p.evaluate(() => document.querySelector('[data-row^="time.speech.voices."]').textContent)));
    check('09: default voice named, read-only WITH its reason', /Made-up Voice One/.test(await valText(p, 'time.speech.defaultVoice') || '') && /Read only here/.test(await whyText(p, 'time.speech.defaultVoice') || ''));
    check('09: recognizer languages listed', /English \(United States\)/.test(await valText(p, 'time.speech.language') || ''));
  }],
  ['time-10-failing', DT + '&tl=fail', async (p) => {
    check('10: the clock says why it could not be read', /Date and time could not be read: (Mantle's connection to Windows is restarting|Windows took too long to answer|something went wrong inside Mantle|this needs a newer version of Mantle|Windows did not allow it)/.test(await whyText(p, 'time.datetime.now') || ''));
    check('10: every switch says why too', /could not be read/.test(await whyText(p, 'time.datetime.autoTime') || '') && /could not be read/.test(await whyText(p, 'time.datetime.zone') || ''));
    check('10: nothing threw while drawing', !/could not be drawn/.test(await p.textContent('#page')));
  }],
  ['time-11-region-failing', RG + '&tl=fail', async (p) => {
    check('11: the format rows say why', /could not be read/.test(await whyText(p, 'time.region.shortDate') || '') && /could not be read/.test(await whyText(p, 'time.region.display') || ''));
    check('11: nothing threw while drawing', !/could not be drawn/.test(await p.textContent('#page')));
  }],
];

async function browserTests() {
  const g = gaming();
  if (g !== 0) { console.log(g > 0 ? 'PART 2 SKIPPED: a game is running' : 'PART 2 SKIPPED: could not check for a running game'); failures.push('part 2 (the page on the mock) was not run'); return; }
  const { chromium } = require('C:/Users/user/other-app/node_modules/playwright-core');
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await require('../test-browser.js').launch(chromium);
  try {
    for (const width of [1040, 720]) {
      const ctx = await browser.newContext({ viewport: { width, height: 760 }, deviceScaleFactor: 1.25, colorScheme: 'light' });
      await ctx.addInitScript(FAKE);
      for (const [name, query, prep] of SHOTS) {
        if (ONLY && !ONLY.some((x) => name.startsWith(x))) continue;
        if (width !== 1040 && !/time-0[16]-/.test(name)) continue;   // the narrow window: the two busiest pages
        const shot = width === 1040 ? name : name + '-narrow';
        const page = await ctx.newPage();
        const problems = [];
        page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
        page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') problems.push('console ' + m.type() + ': ' + m.text()); });
        await page.goto(PAGE + query, { waitUntil: 'load' });
        try { await page.waitForSelector('html[data-ready="1"]', { timeout: 6000 }); } catch (_) { problems.push('never reached data-ready'); }
        await page.waitForTimeout(500);
        const before = passed + failures.length;
        if (width === 1040) { try { await prep(page); } catch (e) { problems.push('prep threw: ' + e.message.split('\n')[0]); } }
        await page.waitForTimeout(200);
        const probe = await page.evaluate(() => {
          const out = [];
          document.querySelectorAll('.row-t, .row-h, .btn, h1, .why span, select, .val').forEach((el) => {
            const r = el.getBoundingClientRect();
            if (!r.width || getComputedStyle(el).webkitLineClamp !== 'none') return;
            if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflow !== 'visible' && el.tagName !== 'SELECT') out.push('clipped: ' + el.className + ' "' + el.textContent.slice(0, 40) + '"');
            if (r.right > window.innerWidth + 1) out.push('off-screen right: ' + (el.className || el.tagName) + ' "' + el.textContent.slice(0, 40) + '"');
          });
          const pg = document.getElementById('page');
          return { out, rows: pg ? pg.querySelectorAll('.row').length : 0, ready: document.documentElement.dataset.ready, text: pg ? pg.textContent : '',
            hscroll: document.documentElement.scrollWidth > window.innerWidth + 1 };
        });
        await page.screenshot({ path: path.join(OUT, shot + '.png') });
        check(`${shot}: drawn`, probe.rows >= 4 && probe.ready === '1', `rows ${probe.rows}, ready ${probe.ready}`);
        check(`${shot}: not DOWN, no hand-off`, !/could not be drawn|did not load|Opens Windows Settings/.test(probe.text), probe.text.slice(0, 200));
        check(`${shot}: no page errors, nothing clipped, no sideways scroll`, problems.length + probe.out.length === 0 && !probe.hscroll, problems.concat(probe.out).join(' | '));
        console.log(`${shot}: ${probe.rows} rows, ${passed + failures.length - before} checks`);
        await page.close();
      }
      await ctx.close();
    }
  } finally { await browser.close(); }
  console.log(`shots in ${OUT}`);
}

(async () => {
  try { await nodeTests(); } catch (e) { failures.push('part 1 threw: ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' ') : e)); }
  try { await browserTests(); } catch (e) { failures.push('part 2 threw: ' + (e && e.message ? e.message.split('\n')[0] : e)); }
  for (const f of failures) console.log('FAIL ' + f);
  console.log(`TIME PAGE TEST: ${passed} passed, ${failures.length} failed`);
  process.exitCode = failures.length ? 1 : 0;
})();

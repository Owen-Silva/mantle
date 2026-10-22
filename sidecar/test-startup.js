// test-startup.js - "Startup apps" for Mantle Settings: the sidecar half (sidecar/Startup.cs).
// Lane settings-startup, 2026-09-28.
//
//   MANTLE_SIDECAR_EXE=<your exe> node sidecar/test-startup.js
//
// PASSIVE, like every sidecar test, and it NEVER changes the user's startup entries: it READS the real
// registry and Startup folders (startup.list), asks for dry runs (startup.set {dryRun:true}, which
// touches nothing), and proves a real startup.set is refused and the list is identical afterwards.
// It also reads Startup.cs itself to prove the HARD RULE holds in the source: one write site, no
// delete, no file call, and no argument named `id` (it would collide with the protocol's request id).
//
// Privacy: nothing the user has in their startup list is printed. Failures name an index and a source,
// never an entry's name or command.
//
// Prints one summary line, "STARTUP TEST: n passed, m failed".
'use strict';

const fs = require('fs');
const path = require('path');
const T = require('./test-lib');

const SOURCES = {
  'hkcu-run':      { scope: 'user',    key: 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run' },
  'hklm-run':      { scope: 'machine', key: 'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run' },
  'hklm-run32':    { scope: 'machine', key: 'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run32' },
  'user-folder':   { scope: 'user',    key: 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\StartupFolder' },
  'common-folder': { scope: 'machine', key: 'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\StartupFolder' },
};
const STATES = ['enabled', 'disabled', 'default'];
const NEEDS_ADMIN = 'Needs administrator';
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/;

/** FILETIME (100 ns ticks since 1601-01-01 UTC) from 8 little-endian bytes, as epoch ms. */
function filetimeMs(bytes) {
  let ft = 0n;
  for (let i = 7; i >= 0; i--) ft = (ft << 8n) | BigInt(bytes[i]);
  return Number(ft / 10000n) - 11644473600000;
}

(async () => {
  const t = T.checker('STARTUP');

  // ---- the source itself: the HARD RULE and the `id` rule, read from Startup.cs ----
  const src = fs.readFileSync(path.join(__dirname, 'Startup.cs'), 'utf8');
  const code = src.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');   // comments may say the words
  const count = (re) => (code.match(re) || []).length;
  t.check('Startup.cs: no DeleteValue / DeleteSubKey / DeleteSubKeyTree anywhere',
    count(/\.Delete(Value|SubKey|SubKeyTree)\s*\(/g) === 0);
  t.check('Startup.cs: no file or folder write (File.* / Directory.Delete|Move)',
    count(/\bFile\.(Delete|Move|Copy|Write\w*|Create\w*|Replace|Append\w*|Open\w*)\s*\(/g) === 0 &&
    count(/\bDirectory\.(Delete|Move|Create\w*)\s*\(/g) === 0);
  t.check('Startup.cs: exactly one SetValue (the StartupApproved write)', count(/\.SetValue\s*\(/g) === 1,
    'found ' + count(/\.SetValue\s*\(/g));
  t.check('Startup.cs: exactly one writable open (HKLM StartupApproved) and one CreateSubKey (HKCU StartupApproved)',
    count(/OpenSubKey\s*\([^)]*,\s*true\s*\)/g) === 1 && count(/CreateSubKey\s*\(/g) === 1);
  t.check('Startup.cs: no argument named "id" is read', !/Get\w+\s*\(\s*req\s*,\s*"id"/.test(code) && !/"id"/.test(code));

  // Every request goes through here, so this test can never send an argument named `id`.
  let s;
  const ask = (cmd, args, ms) => {
    if (args && Object.prototype.hasOwnProperty.call(args, 'id')) throw new Error('a test sent an argument named id');
    return s.send(cmd, args, ms);
  };

  try {
    s = await T.startPassive();
  } catch (e) {
    t.fail('passive sidecar starts', e.message);
    process.exit(t.summary());
  }

  let list1 = null;
  try {
    // ---- startup.list ----
    const r = await ask('startup.list', {}, 15000);
    t.check('startup.list answers ok', r.ok === true && r.result && r.result.ok === true, JSON.stringify(r).slice(0, 200));
    const res = r.result || {};
    list1 = res;
    const items = Array.isArray(res.items) ? res.items : null;
    t.check('startup.list: items is an array', !!items);
    t.check('startup.list: problems is an array of strings',
      Array.isArray(res.problems) && res.problems.every((p) => typeof p === 'string'));
    t.check('startup.list: elevated is a boolean', typeof res.elevated === 'boolean');

    const perSource = {};
    const bad = [];
    (items || []).forEach((it, i) => {
      const where = '#' + i + ' ' + (it && it.source);
      const fail = (why) => bad.push(where + ': ' + why);
      if (!it || typeof it !== 'object') return fail('not an object');
      perSource[it.source] = (perSource[it.source] || 0) + 1;
      const known = SOURCES[it.source];
      if (!known) return fail('unknown source');
      if (typeof it.item !== 'string' || it.item !== it.source + '|' + it.name) fail('item is not "<source>|<name>"');
      if (typeof it.name !== 'string' || !it.name) fail('name is not a non-empty string');
      if (typeof it.sourceLabel !== 'string' || !it.sourceLabel) fail('sourceLabel missing');
      if (it.scope !== known.scope) fail('scope is ' + it.scope + ', expected ' + known.scope);
      if (!(typeof it.command === 'string' || it.command === null)) fail('command is not a string or null');
      if (typeof it.enabled !== 'boolean') fail('enabled is not a boolean');
      if (STATES.indexOf(it.state) < 0) fail('state is not one of ' + STATES.join('/'));
      if ((it.state === 'disabled') === it.enabled) fail('state and enabled disagree');
      if (!(it.disabledAt === null || (typeof it.disabledAt === 'string' && ISO.test(it.disabledAt)))) fail('disabledAt is not ISO-8601 UTC or null');
      if (it.state !== 'disabled' && it.disabledAt !== null) fail('disabledAt set on an entry that is not disabled');
      if (typeof it.canToggle !== 'boolean') fail('canToggle is not a boolean');
      if (!(it.reason === null || typeof it.reason === 'string')) fail('reason is not a string or null');
      if (known.scope === 'machine' && res.elevated === false) {
        if (it.canToggle !== false) fail('machine entry toggleable while not elevated');
        if (typeof it.reason !== 'string' || it.reason.indexOf(NEEDS_ADMIN) !== 0) fail('machine entry reason lacks the Needs administrator words');
      }
      if (known.scope === 'user' && it.canToggle !== true) fail('user entry not toggleable');
      // Privacy: a reason carries states and codes, never the entry's own command or path.
      if (typeof it.reason === 'string' && typeof it.command === 'string' && it.command.length >= 6 &&
          it.reason.indexOf(it.command) >= 0) fail('reason quotes the command');
    });
    t.check('startup.list: every item has the documented fields and types', bad.length === 0, bad.slice(0, 6).join('; '));
    t.check('startup.list: item strings are unique', items && new Set(items.map((x) => x.item)).size === items.length);
    const problemsLeak = (items || []).some((it) => typeof it.command === 'string' && it.command.length >= 6 &&
      (res.problems || []).some((p) => p.indexOf(it.command) >= 0));
    t.check('startup.list: problems never quote a command or path', !problemsLeak);
    console.log('  startup.list: ' + (items ? items.length : 0) + ' entries (' +
      Object.keys(perSource).map((k) => k + ' ' + perSource[k]).join(', ') + '), elevated ' + res.elevated +
      ', ' + (res.problems || []).length + ' problem(s)' + ((res.problems || []).length ? ': ' + res.problems.join(' | ') : ''));

    // ---- startup.set dryRun: one real item per source present ----
    const firstPer = {};
    for (const it of items || []) if (SOURCES[it.source] && !firstPer[it.source]) firstPer[it.source] = it;
    const picks = Object.keys(firstPer).map((k) => firstPer[k]);
    if (!picks.length) {
      console.log('  NOTE: the startup list is empty on this machine, so the dry-run checks were skipped');
    }
    for (const it of picks) {
      for (const on of [true, false]) {
        const label = 'dryRun ' + it.source + ' on:' + on;
        const before = Date.now();
        const d = await ask('startup.set', { item: it.item, on, dryRun: true }, 15000);
        const dr = d.result || {};
        if (!t.check(label + ': answers ok', d.ok === true && dr.ok === true && dr.dryRun === true,
          d.ok ? '' : String(d.error).slice(0, 160))) continue;
        t.check(label + ': key is the StartupApproved key for its source (never a Run key)',
          typeof dr.key === 'string' && dr.key.indexOf('StartupApproved') >= 0 &&
          dr.key.toLowerCase() === SOURCES[it.source].key.toLowerCase(), 'got a different key');
        t.check(label + ': valueName is the entry name', dr.valueName === it.name);
        t.check(label + ': wouldBe', dr.wouldBe === (on ? 'enabled' : 'disabled'));
        t.check(label + ': item is the current item', dr.item && dr.item.item === it.item && dr.item.state === it.state);
        const hex = typeof dr.bytes === 'string' ? dr.bytes.trim().split(/\s+/) : [];
        const bytes = hex.map((h) => parseInt(h, 16));
        t.check(label + ': 12 hex bytes', hex.length === 12 && hex.every((h) => /^[0-9a-fA-F]{2}$/.test(h)), 'got ' + hex.length);
        t.check(label + ': first byte ' + (on ? '02' : '03'), bytes[0] === (on ? 2 : 3));
        if (on) {
          t.check(label + ': the rest are zero', bytes.slice(1).every((b) => b === 0));
        } else {
          t.check(label + ': bytes 1..3 are zero', bytes.slice(1, 4).every((b) => b === 0));
          const ms = filetimeMs(bytes.slice(4, 12));
          const after = Date.now();
          t.check(label + ': bytes 4..11 are a FILETIME of now (within 3 minutes)',
            ms >= before - 180000 && ms <= after + 180000, 'off by ' + Math.round((ms - before) / 1000) + ' s');
        }
        const machine = SOURCES[it.source].scope === 'machine';
        if (machine && res.elevated === false) {
          t.check(label + ': says a real write would need administrator',
            typeof dr.wouldRefuse === 'string' && dr.wouldRefuse.indexOf(NEEDS_ADMIN) === 0);
        } else {
          t.check(label + ': a real write would not be refused for rights', dr.wouldRefuse === null);
        }
      }
    }

    // ---- a real startup.set is refused in passive, and nothing changed ----
    if (picks.length) {
      const it = picks[0];
      for (const on of [true, false]) {
        const w = await ask('startup.set', { item: it.item, on }, 15000);
        t.check('startup.set without dryRun (on:' + on + ') answers the passive refusal',
          w.ok === false && typeof w.error === 'string' && w.error.indexOf(T.PASSIVE_REFUSAL) === 0,
          w.ok ? 'it answered ok' : String(w.error).slice(0, 120));
        t.check('the passive refusal (on:' + on + ') does not quote the entry',
          typeof w.error === 'string' && w.error.indexOf(it.item) < 0 && (it.name.length < 6 || w.error.indexOf(it.name) < 0));
      }
    }
    const r2 = await ask('startup.list', {}, 15000);
    t.check('startup.list afterwards is identical (same items, same states)',
      r2.ok === true && JSON.stringify(r2.result.items) === JSON.stringify(items), 'the list changed');

    // ---- refusals in plain words that never echo what was sent ----
    const tag = 'mantle-test-' + process.pid + '-' + Date.now().toString(36);
    const refusals = [
      { label: 'an item that is not there (dryRun)', args: { item: 'hkcu-run|' + tag, on: true, dryRun: true }, want: /no longer there/ },
      { label: 'an item that is not there (real)', args: { item: 'hkcu-run|' + tag, on: false }, want: /no longer there|refused/ },
      { label: 'a bad source', args: { item: 'bogus-' + tag + '|x', on: true, dryRun: true }, want: /unknown source/ },
      { label: 'no source|name bar', args: { item: tag, on: true, dryRun: true }, want: /not a startup item/ },
      { label: 'no item at all', args: { on: true, dryRun: true }, want: /needs item/ },
      { label: 'no on', args: { item: 'hkcu-run|' + tag, dryRun: true }, want: /needs on/ },
    ];
    for (const c of refusals) {
      const x = await ask('startup.set', c.args, 15000);
      const err = typeof x.error === 'string' ? x.error : '';
      t.check('refused: ' + c.label, x.ok === false && c.want.test(err), x.ok ? 'it answered ok' : err.slice(0, 160));
      t.check('refusal does not echo what was sent: ' + c.label, err.indexOf(tag) < 0 && (!c.args.item || err.indexOf(c.args.item) < 0));
    }

    // ---- nothing the sidecar logged quotes an entry ----
    const leaks = (items || []).filter((it) =>
      (typeof it.command === 'string' && it.command.length >= 6 && s.stderr.indexOf(it.command) >= 0) ||
      (it.name.length >= 8 && s.stderr.indexOf(it.name) >= 0));
    t.check('the sidecar\'s stderr never quotes an entry name or command', leaks.length === 0, leaks.length + ' leak(s)');
  } catch (e) {
    t.fail('the run finished', e.message);
  } finally {
    await s.stop();
  }
  process.exit(t.summary());
})();

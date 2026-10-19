'use strict';
/*
 * lib/media-guard.test.js - the protected media apps rule (lib/media-guard.js), on its own and
 * together with lib/media-pick.js the way main.js uses them.
 *
 *   node lib/media-guard.test.js
 *
 * Plain node, no deps (a temp folder for the read() cases). One summary line:
 * "media-guard tests: n passed, m failed".
 *
 * The rule used to be hard-wired to ONE app name (a regex in main.js, the flags --<app>-guard and
 * --<app>-media-controls, the switcher word after the app's name). OLD below is that code, kept
 * verbatim except for the fictional app name, so this file can prove the config that names the app
 * gives exactly the old behaviour, and that no config makes the rule inert.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const G = require('./media-guard');
const { choose } = require('./media-pick');

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { passed++; return true; }
  failures.push(detail ? `${name} (${detail})` : name);
  return false;
}
const J = JSON.stringify;

/* ---- the old hard-wired rule, with a fictional app in place of the real one ---------------- */
const OLD = {
  RE: /contoso player/i,
  REASON: "Contoso Player recording · controls off so a stray click can't pause it",
  WORD: 'recording',          // the switcher's word after the app's name
  FLAG_GUARD: '--contoso-guard',
  FLAG_CONTROLS: '--contoso-media-controls',
  is(s) {
    if (!s) return false;
    return OLD.RE.test(String(s.aumid || '')) || OLD.RE.test(String((s.app && s.app.name) || '')) || OLD.RE.test(String(s.title || ''));
  },
  // flags.lessonplayerMediaControls = ARGV.includes('--lessonplayer-media-controls') || !ARGV.includes('--lessonplayer-guard');
  guardOn(argv) { const controls = argv.includes(OLD.FLAG_CONTROLS) || !argv.includes(OLD.FLAG_GUARD); return !controls; },
  rowText(x) { return (x.app && x.app.name) + (x.gone ? ' · session gone, waiting for it' : OLD.is(x) ? ' · ' + OLD.WORD : (x.title ? ' · ' + x.title : '')); },
};
// the old flags, said the new way
const NEW_ARGV = (argv) => argv.map((a) => (a === OLD.FLAG_GUARD ? G.FLAG_ON : a === OLD.FLAG_CONTROLS ? G.FLAG_OFF : a));

/* ---- the new rule, the way main.js and bar.js use it --------------------------------------- */
const NEW = (cfg) => ({
  prot(s) { return G.match(cfg, s); },
  guardOn(argv) { return G.state(cfg, argv).on; },
  label(s) { return (G.match(cfg, s) && cfg.label) || null; },
  rowText(x) { const label = (G.match(cfg, x) && cfg.label) || null; return (x.app && x.app.name) + (x.gone ? ' · session gone, waiting for it' : label ? ' · ' + label : (x.title ? ' · ' + x.title : '')); },
  reason(s) { return G.reasonFor(cfg, G.match(cfg, s)); },
});

const SPOTIFY = { aumid: 'Spotify.exe', app: { name: 'Spotify' }, title: 'Midnight City', playing: true };
const STORE = { aumid: 'ContosoLtd.ContosoPlayer_abc123xyz!App', app: { name: 'Contoso Player' }, title: 'Contoso Player', playing: true };
const WEB = { aumid: 'Chrome', app: { name: 'Google Chrome' }, title: 'Contoso Player - week 3', playing: false };
const BYAUMID = { aumid: 'contoso player!app' };   // main's fallback: a session known by its AUMID alone
const RADIO = { aumid: 'Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic', app: { name: 'Media Player' }, title: 'News', playing: true };
const ALL = [SPOTIFY, STORE, WEB, BYAUMID, RADIO];
const ARGVS = [[], ['--live'], [OLD.FLAG_GUARD], [OLD.FLAG_CONTROLS], [OLD.FLAG_GUARD, OLD.FLAG_CONTROLS]];

// The seed: the app the old code named, the old default (rule off without the flag), the old word.
const SEED = { apps: ['Contoso Player'], guard: false, label: 'recording' };

/* 1. normalize: defaults, junk, the guard default ----------------------------------------- */
{
  const d = G.normalize(null);
  check('normalize(null): nothing protected, rule off, no label', J(d) === J({ apps: [], guard: false, label: null }), J(d));
  const n = G.normalize({ apps: ['  Contoso Player ', '', 7, null, 'contoso player', 'Fabrikam'], label: '  ', guard: 'yes' });
  check('normalize: trims, drops junk and case-duplicates', J(n.apps) === J(['Contoso Player', 'Fabrikam']), J(n));
  check('normalize: apps listed and no boolean guard = rule on', n.guard === true, J(n));
  check('normalize: a blank label is no label', n.label === null, J(n));
  check('normalize: an explicit guard:false is kept', G.normalize(SEED).guard === false);
  check('normalize: an array is not a config', J(G.normalize(['Contoso Player'])) === J(d));
}

/* 2. read: missing, corrupt, BOM, not an object, good ------------------------------------- */
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-guard-test-'));
  try {
    let r = G.read(dir);
    check('read: no file = default, found false, says so', r.apps.length === 0 && r.found === false && /^no media-guard\.json/.test(r.reason), J(r));
    const f = path.join(dir, G.FILE_NAME);
    fs.writeFileSync(f, '{ "apps": ["Contoso Player"', 'utf8');
    r = G.read(dir);
    check('read: corrupt JSON = default, found, says why', r.apps.length === 0 && r.found === true && /not valid JSON/.test(r.reason), J(r));
    fs.writeFileSync(f, '[1,2]', 'utf8');
    r = G.read(dir);
    check('read: not an object = default, says why', r.apps.length === 0 && /not a JSON object/.test(r.reason), J(r));
    fs.writeFileSync(f, '﻿' + J(SEED), 'utf8');
    r = G.read(dir);
    check('read: the seed (with a BOM, as Notepad writes it) reads cleanly', r.reason === null && J(r.apps) === J(SEED.apps) && r.guard === false && r.label === 'recording', J(r));
    const unreadable = G.read(dir, { readFileSync() { const e = new Error('EPERM: operation not permitted'); e.code = 'EPERM'; throw e; } });
    check('read: an unreadable file = default, says why', unreadable.apps.length === 0 && /could not be read \(EPERM/.test(unreadable.reason), J(unreadable));
    check('read: never throws on a bad dir', G.read(null).apps.length === 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/* 3. NO CONFIG = THE RULE IS INERT, whatever the flags --------------------------------------- */
{
  const none = G.normalize(null);
  const N = NEW(none);
  for (const argv of [[], [G.FLAG_ON], [G.FLAG_OFF], [G.FLAG_ON, G.FLAG_OFF]]) {
    check(`no config, argv ${J(argv)}: rule off`, N.guardOn(argv) === false && G.state(none, argv).by === 'none');
  }
  check('no config: no session is protected', ALL.every((s) => N.prot(s) === null));
  check('no config: no switcher label; rows show their titles', N.label(STORE) === null && N.rowText(STORE) === 'Contoso Player · Contoso Player');
  const sum = G.summary(none, [G.FLAG_ON]);
  check('no config: the payload guard is off and names no app', sum.on === false && sum.apps.length === 0 && sum.how === null && /no media app is protected/.test(sum.reason), J(sum));
  // media-pick with every session unprotected and the rule off: plain "Windows' current"
  const sessions = [STORE, SPOTIFY].map((s) => Object.assign({}, s, { protectedApp: !!N.prot(s) }));
  const cur = Object.assign({}, STORE, { protectedApp: false });
  const r = choose({ pick: null, sessions, current: cur, guardOn: N.guardOn([G.FLAG_ON]), now: 0 });
  check('no config, even with --media-guard: the chip shows Windows\' current', r.by === 'current' && !r.protectedOnly, J(r));
  const alone = choose({ pick: null, sessions: sessions.slice(0, 1), current: cur, guardOn: N.guardOn([G.FLAG_ON]), now: 0 });
  check('no config: an app alone still gets its chip', alone.by === 'current' && !alone.protectedOnly, J(alone));
}

/* 4. THE SEED = THE OLD BEHAVIOUR, for every session and every flag combination -------------- */
{
  const N = NEW(G.normalize(SEED));
  for (const s of ALL) {
    check(`seed: ${s.aumid} protected exactly when the old regex said so`, !!N.prot(s) === OLD.is(s), J(s));
    const row = Object.assign({ gone: false }, s, { app: s.app || { name: s.aumid } });
    check(`seed: ${s.aumid} switcher row text is the old one`, N.rowText(row) === OLD.rowText(row), `${N.rowText(row)} vs ${OLD.rowText(row)}`);
    if (OLD.is(s)) check(`seed: ${s.aumid} controls-off line is the old one`, N.reason(s) === OLD.REASON, N.reason(s));
  }
  for (const argv of ARGVS) {
    check(`seed, argv ${J(argv)}: rule on/off as the old flags made it`, N.guardOn(NEW_ARGV(argv)) === OLD.guardOn(argv), `${N.guardOn(NEW_ARGV(argv))} vs ${OLD.guardOn(argv)}`);
  }
  check('seed, no flags (the live logon task): rule OFF, as before', N.guardOn(['--live', '--log=x']) === false && OLD.guardOn(['--live', '--log=x']) === false);

  // media-pick fed the old way and the new way gives the same answer, step by step
  const SETS = [[STORE], [STORE, SPOTIFY], [SPOTIFY, STORE, RADIO], [WEB, RADIO], [SPOTIFY], []];
  let same = 0, total = 0, firstDiff = null;
  for (const argv of ARGVS) {
    for (const set of SETS) {
      for (const curI of [-1, 0, 1]) {
        for (const pickI of [-1, 0, 1]) {
          const oldS = set.map((s) => Object.assign({}, s, { protectedApp: OLD.is(s) }));
          const newS = set.map((s) => Object.assign({}, s, { protectedApp: !!N.prot(s) }));
          const oldCur = curI >= 0 && oldS[curI] ? oldS[curI] : null;
          const newCur = curI >= 0 && newS[curI] ? newS[curI] : null;
          const pk = pickI >= 0 && set[pickI] ? { aumid: set[pickI].aumid, name: null, protectedApp: OLD.is(set[pickI]), at: 0, goneSince: null } : null;
          const a = choose({ pick: pk, sessions: oldS, current: oldCur, guardOn: OLD.guardOn(argv), now: 1000 });
          const b = choose({ pick: pk, sessions: newS, current: newCur, guardOn: N.guardOn(NEW_ARGV(argv)), now: 1000 });
          total++;
          if (J(a) === J(b)) same++; else if (!firstDiff) firstDiff = `${J(argv)} ${J(set.map((s) => s.aumid))}: ${J(a)} vs ${J(b)}`;
        }
      }
    }
  }
  check(`seed: media-pick answers the same as the old rule in all ${total} cases`, same === total, firstDiff);
}

/* 5. The rule ON (a config that lists an app; --media-guard; --media-controls wins) ----------- */
{
  const on = G.normalize({ apps: ['Contoso Player'] });
  check('apps listed, no flags: rule on, by config', J(G.state(on, [])) === J({ on: true, by: 'config' }));
  check('--media-controls wins over the config', J(G.state(on, [G.FLAG_OFF])) === J({ on: false, by: 'controls-flag' }));
  const seed = G.normalize(SEED);
  check('seed + --media-guard: rule on, by flag', J(G.state(seed, [G.FLAG_ON])) === J({ on: true, by: 'flag' }));
  check('--media-controls wins over --media-guard', G.state(seed, [G.FLAG_ON, G.FLAG_OFF]).on === false);
  const s1 = G.summary(seed, [G.FLAG_ON]);
  check('summary, on by flag: names the apps and the flag to drop', s1.on && J(s1.apps) === J(['Contoso Player']) && /--media-guard; start it without/.test(s1.how), J(s1));
  const s2 = G.summary(on, []);
  check('summary, on by config: says where it is set and the way out', s2.on && /media-guard\.json/.test(s2.how) && /--media-controls/.test(s2.how), J(s2));
  const s3 = G.summary(seed, []);
  check('summary, seed off: controls on, says how to turn the rule on', !s3.on && /--media-guard/.test(s3.reason) && s3.how === null, J(s3));
  check('reasonFor with no label', G.reasonFor(on, 'Contoso Player') === "Contoso Player · controls off so a stray click can't pause it");
  check('match returns the entry as the config spells it', G.match(G.normalize({ apps: ['CONTOSO'] }), STORE) === 'CONTOSO');
  // and media-pick under it: alone = no chip; with a player the player wins
  const ses = [STORE, SPOTIFY].map((s) => Object.assign({}, s, { protectedApp: !!G.match(on, s) }));
  const r1 = choose({ pick: null, sessions: ses.slice(0, 1), current: ses[0], guardOn: true, now: 0 });
  check('rule on: the protected app alone = no chip', r1.protectedOnly === true && r1.by === 'protected-only', J(r1));
  const r2 = choose({ pick: null, sessions: ses, current: ses[0], guardOn: true, now: 0 });
  check('rule on: a player wins over the protected app', r2.by === 'protected-rule' && r2.want === 'Spotify.exe', J(r2));
}

for (const f of failures) console.log(`FAIL ${f}`);
console.log(`media-guard tests: ${passed} passed, ${failures.length} failed`);
process.exitCode = failures.length ? 1 : 0;

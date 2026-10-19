'use strict';
/*
 * lib/media-pick.test.js - the media card's sticky source pick (lib/media-pick.js).
 *
 *   node lib/media-pick.test.js
 *
 * Plain node, no deps. One summary line: "media-pick tests: n passed, m failed".
 */
const { PICK_GRACE_MS, makePick, choose } = require('./media-pick');

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { passed++; return true; }
  failures.push(detail ? `${name} (${detail})` : name);
  return false;
}

const SPOTIFY = { aumid: 'Spotify.exe', app: { name: 'Spotify' }, playing: true, protectedApp: false };
const CONTOSO = { aumid: 'Contoso.Player_abc123xyz!App', app: { name: 'Contoso Player' }, playing: true, protectedApp: true };   // a protected media app (lib/media-guard.js)
const RADIO = { aumid: 'Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic', app: { name: 'Media Player' }, playing: true, protectedApp: false };

/* A little driver shaped like main.js's mediaRead: it holds the pick between reads. */
function driver(guardOn) {
  let pick = null;
  return {
    select(session, now) { pick = makePick(session ? session.aumid : null, session, now); },
    read(sessions, current, now) {
      const r = choose({ pick, sessions, current, guardOn, now });
      pick = r.pick;
      return r;
    },
    get pick() { return pick; },
  };
}

// 1. guard OFF (the default): the protected app is Windows' current, Spotify is picked.
{
  const d = driver(false);
  let r = d.read([CONTOSO, SPOTIFY], CONTOSO, 0);
  check('automatic, guard off: shows current (Contoso)', r.by === 'current' && r.want === null, JSON.stringify(r));
  d.select(SPOTIFY, 1000);
  r = d.read([CONTOSO, SPOTIFY], CONTOSO, 1100);
  check('picked Spotify: shows Spotify, by you', r.by === 'you' && r.want === 'Spotify.exe', JSON.stringify(r));

  // Spotify's session blinks out of ONE snapshot
  r = d.read([CONTOSO], CONTOSO, 5000);
  check('flicker: pick is HELD (by waiting), not dropped', r.by === 'waiting' && d.pick && d.pick.aumid === 'Spotify.exe' && !r.dropped, JSON.stringify(r));
  check('flicker: automatic shows meanwhile (current)', r.auto === 'current' && r.want === null, JSON.stringify(r));
  check('flicker: waiting says why and how long', r.waiting && /Spotify's media session is missing/.test(r.waiting.reason) && r.waiting.leftMs === PICK_GRACE_MS, JSON.stringify(r.waiting));

  // ...and is back on the next snapshot
  r = d.read([SPOTIFY, CONTOSO], CONTOSO, 6000);
  check('flicker over: the pick applies again', r.by === 'you' && r.want === 'Spotify.exe' && d.pick.goneSince === null, JSON.stringify(r));

  // many short blinks never add up: the grace is CONTINUOUS absence
  for (let t = 10000; t < 200000; t += 20000) {
    d.read([CONTOSO], CONTOSO, t);
    r = d.read([CONTOSO, SPOTIFY], CONTOSO, t + 10000);
  }
  check('repeated short blinks over 190 s: still picked', r.by === 'you' && d.pick && d.pick.aumid === 'Spotify.exe', JSON.stringify(r));

  // gone for 59.9 s: still held; at 60 s: dropped, said out loud
  r = d.read([CONTOSO], CONTOSO, 300000);
  r = d.read([CONTOSO], CONTOSO, 300000 + PICK_GRACE_MS - 100);
  check('gone 59.9 s: still held', r.by === 'waiting' && !!d.pick && r.waiting.leftMs === 100, JSON.stringify(r));
  r = d.read([CONTOSO], CONTOSO, 300000 + PICK_GRACE_MS);
  check('gone 60 s: dropped to automatic', r.by === 'current' && d.pick === null && r.waiting === null, JSON.stringify(r));
  check('gone 60 s: the drop says why', r.dropped && r.dropped.aumid === 'Spotify.exe' && /gone for 60 s/.test(r.dropped.reason), JSON.stringify(r.dropped));
  r = d.read([CONTOSO, SPOTIFY], CONTOSO, 400000);
  check('after the drop, Spotify coming back does NOT re-pick it', r.by === 'current', JSON.stringify(r));
}

// 2. A new media.select resets the grace timer.
{
  const d = driver(false);
  d.select(SPOTIFY, 0);
  d.read([CONTOSO], CONTOSO, 1000);                    // gone since 1 s
  d.select(SPOTIFY, 50000);                            // Owen clicks it again at 50 s
  let r = d.read([CONTOSO], CONTOSO, 70000);            // 69 s after the first absence, 20 s after the click
  check('re-select resets the grace', r.by === 'waiting' && r.waiting.leftMs === PICK_GRACE_MS, JSON.stringify(r));
  r = d.read([CONTOSO], CONTOSO, 70000 + PICK_GRACE_MS);
  check('...and drops a full grace after the re-select read', d.pick === null && !!r.dropped, JSON.stringify(r));
  d.select(null, 200000);
  r = d.read([CONTOSO, SPOTIFY], CONTOSO, 200001);
  check('select(null) = automatic', r.by === 'current' && d.pick === null, JSON.stringify(r));
}

// 3. Guard ON (--media-guard): protected apps alone = no chip. A PLAYER pick survives that flicker;
//    a pick of the PROTECTED app does not outlive the player.
{
  const d = driver(true);
  d.select(SPOTIFY, 0);
  let r = d.read([CONTOSO, SPOTIFY], CONTOSO, 100);
  check('guard on, picked Spotify: by you', r.by === 'you', JSON.stringify(r));
  r = d.read([CONTOSO], CONTOSO, 2000);
  check('guard on, Spotify blinks out, Contoso alone: no chip', r.protectedOnly === true && r.by === 'protected-only', JSON.stringify(r));
  check('...but the Spotify pick is HELD', !!d.pick && d.pick.aumid === 'Spotify.exe' && !r.dropped && !!r.waiting, JSON.stringify(r));
  r = d.read([CONTOSO, SPOTIFY], CONTOSO, 3000);
  check('...and applies again when Spotify is back', r.by === 'you' && r.want === 'Spotify.exe', JSON.stringify(r));

  // the protected-app pick
  d.select(CONTOSO, 10000);
  r = d.read([CONTOSO, SPOTIFY], SPOTIFY, 10100);
  check('guard on, picked the protected app: shows it, by you', r.by === 'you' && r.want === CONTOSO.aumid, JSON.stringify(r));
  r = d.read([CONTOSO], CONTOSO, 11000);
  check('protected pick: Contoso alone again drops it at once', r.protectedOnly && d.pick === null && r.dropped && /does not outlive/.test(r.dropped.reason), JSON.stringify(r));
  r = d.read([CONTOSO, SPOTIFY], CONTOSO, 12000);
  check('protected pick gone: the player shows by the rule', r.by === 'protected-rule' && r.want === 'Spotify.exe', JSON.stringify(r));

  // a protected-app pick made from an AUMID alone (main's fallback when its last read did not list it)
  d.select({ aumid: CONTOSO.aumid, protectedApp: true }, 20000);
  r = d.read([CONTOSO], CONTOSO, 20100);
  check('protected pick by AUMID only: still dropped when alone', d.pick === null && r.protectedOnly, JSON.stringify(r));
}

// 4. Guard on, the picked player is gone, a different player remains: waiting, shown by the rule.
{
  const d = driver(true);
  d.select(SPOTIFY, 0);
  const r = d.read([CONTOSO, RADIO], CONTOSO, 1000);
  check('guard on, Spotify gone, Radio + Contoso: waiting, Radio shown by the rule',
    r.by === 'waiting' && r.auto === 'protected-rule' && r.want === RADIO.aumid, JSON.stringify(r));
}

// 5. AUMIDs compare case-insensitively; the pick's name follows the session's.
{
  const d = driver(false);
  d.select({ aumid: 'spotify.EXE' }, 0);
  const r = d.read([CONTOSO, SPOTIFY], CONTOSO, 10);
  check('case-insensitive AUMID match', r.by === 'you' && d.pick.name === 'Spotify', JSON.stringify(r));
}

// 6. No sessions, no pick: nothing to show, nothing thrown.
{
  const r = choose({ pick: null, sessions: [], current: null, guardOn: true, now: 0 });
  check('empty: by null, want null', r.by === null && r.want === null && !r.protectedOnly, JSON.stringify(r));
}

for (const f of failures) console.log(`FAIL ${f}`);
console.log(`media-pick tests: ${passed} passed, ${failures.length} failed`);
process.exitCode = failures.length ? 1 : 0;

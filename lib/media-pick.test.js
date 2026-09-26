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

const SPOTIFY = { aumid: 'Spotify.exe', app: { name: 'Spotify' }, playing: true, lessonplayer: false };
const LESSONPLAYER = { aumid: 'Contoso.LessonPlayer_8wekyb3d8bbwe!App', app: { name: 'LessonPlayer' }, playing: true, lessonplayer: true };
const RADIO = { aumid: 'Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic', app: { name: 'Media Player' }, playing: true, lessonplayer: false };

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

// 1. Owen's case, guard OFF (the default): LessonPlayer is Windows' current, Spotify is picked.
{
  const d = driver(false);
  let r = d.read([LESSONPLAYER, SPOTIFY], LESSONPLAYER, 0);
  check('automatic, guard off: shows current (LessonPlayer)', r.by === 'current' && r.want === null, JSON.stringify(r));
  d.select(SPOTIFY, 1000);
  r = d.read([LESSONPLAYER, SPOTIFY], LESSONPLAYER, 1100);
  check('picked Spotify: shows Spotify, by you', r.by === 'you' && r.want === 'Spotify.exe', JSON.stringify(r));

  // Spotify's session blinks out of ONE snapshot
  r = d.read([LESSONPLAYER], LESSONPLAYER, 5000);
  check('flicker: pick is HELD (by waiting), not dropped', r.by === 'waiting' && d.pick && d.pick.aumid === 'Spotify.exe' && !r.dropped, JSON.stringify(r));
  check('flicker: automatic shows meanwhile (current)', r.auto === 'current' && r.want === null, JSON.stringify(r));
  check('flicker: waiting says why and how long', r.waiting && /Spotify's media session is missing/.test(r.waiting.reason) && r.waiting.leftMs === PICK_GRACE_MS, JSON.stringify(r.waiting));

  // ...and is back on the next snapshot
  r = d.read([SPOTIFY, LESSONPLAYER], LESSONPLAYER, 6000);
  check('flicker over: the pick applies again', r.by === 'you' && r.want === 'Spotify.exe' && d.pick.goneSince === null, JSON.stringify(r));

  // many short blinks never add up: the grace is CONTINUOUS absence
  for (let t = 10000; t < 200000; t += 20000) {
    d.read([LESSONPLAYER], LESSONPLAYER, t);
    r = d.read([LESSONPLAYER, SPOTIFY], LESSONPLAYER, t + 10000);
  }
  check('repeated short blinks over 190 s: still picked', r.by === 'you' && d.pick && d.pick.aumid === 'Spotify.exe', JSON.stringify(r));

  // gone for 59.9 s: still held; at 60 s: dropped, said out loud
  r = d.read([LESSONPLAYER], LESSONPLAYER, 300000);
  r = d.read([LESSONPLAYER], LESSONPLAYER, 300000 + PICK_GRACE_MS - 100);
  check('gone 59.9 s: still held', r.by === 'waiting' && !!d.pick && r.waiting.leftMs === 100, JSON.stringify(r));
  r = d.read([LESSONPLAYER], LESSONPLAYER, 300000 + PICK_GRACE_MS);
  check('gone 60 s: dropped to automatic', r.by === 'current' && d.pick === null && r.waiting === null, JSON.stringify(r));
  check('gone 60 s: the drop says why', r.dropped && r.dropped.aumid === 'Spotify.exe' && /gone for 60 s/.test(r.dropped.reason), JSON.stringify(r.dropped));
  r = d.read([LESSONPLAYER, SPOTIFY], LESSONPLAYER, 400000);
  check('after the drop, Spotify coming back does NOT re-pick it', r.by === 'current', JSON.stringify(r));
}

// 2. A new media.select resets the grace timer.
{
  const d = driver(false);
  d.select(SPOTIFY, 0);
  d.read([LESSONPLAYER], LESSONPLAYER, 1000);                    // gone since 1 s
  d.select(SPOTIFY, 50000);                            // Owen clicks it again at 50 s
  let r = d.read([LESSONPLAYER], LESSONPLAYER, 70000);            // 69 s after the first absence, 20 s after the click
  check('re-select resets the grace', r.by === 'waiting' && r.waiting.leftMs === PICK_GRACE_MS, JSON.stringify(r));
  r = d.read([LESSONPLAYER], LESSONPLAYER, 70000 + PICK_GRACE_MS);
  check('...and drops a full grace after the re-select read', d.pick === null && !!r.dropped, JSON.stringify(r));
  d.select(null, 200000);
  r = d.read([LESSONPLAYER, SPOTIFY], LESSONPLAYER, 200001);
  check('select(null) = automatic', r.by === 'current' && d.pick === null, JSON.stringify(r));
}

// 3. Guard ON (--lessonplayer-guard): LessonPlayer alone = no chip. A PLAYER pick survives that flicker;
//    a LESSON pick does not outlive the player.
{
  const d = driver(true);
  d.select(SPOTIFY, 0);
  let r = d.read([LESSONPLAYER, SPOTIFY], LESSONPLAYER, 100);
  check('guard on, picked Spotify: by you', r.by === 'you', JSON.stringify(r));
  r = d.read([LESSONPLAYER], LESSONPLAYER, 2000);
  check('guard on, Spotify blinks out, LessonPlayer alone: no chip', r.lessonplayerOnly === true && r.by === 'lessonplayer-only', JSON.stringify(r));
  check('...but the Spotify pick is HELD', !!d.pick && d.pick.aumid === 'Spotify.exe' && !r.dropped && !!r.waiting, JSON.stringify(r));
  r = d.read([LESSONPLAYER, SPOTIFY], LESSONPLAYER, 3000);
  check('...and applies again when Spotify is back', r.by === 'you' && r.want === 'Spotify.exe', JSON.stringify(r));

  // the lesson pick
  d.select(LESSONPLAYER, 10000);
  r = d.read([LESSONPLAYER, SPOTIFY], SPOTIFY, 10100);
  check('guard on, picked the lesson: shows it, by you', r.by === 'you' && r.want === LESSONPLAYER.aumid, JSON.stringify(r));
  r = d.read([LESSONPLAYER], LESSONPLAYER, 11000);
  check('lesson pick: LessonPlayer alone again drops it at once', r.lessonplayerOnly && d.pick === null && r.dropped && /does not outlive/.test(r.dropped.reason), JSON.stringify(r));
  r = d.read([LESSONPLAYER, SPOTIFY], LESSONPLAYER, 12000);
  check('lesson pick gone: the player shows by the LessonPlayer rule', r.by === 'lessonplayer-rule' && r.want === 'Spotify.exe', JSON.stringify(r));

  // a lesson pick made from an AUMID alone (main's fallback when its last read did not list it)
  d.select({ aumid: LESSONPLAYER.aumid, lessonplayer: true }, 20000);
  r = d.read([LESSONPLAYER], LESSONPLAYER, 20100);
  check('lesson pick by AUMID only: still dropped when alone', d.pick === null && r.lessonplayerOnly, JSON.stringify(r));
}

// 4. Guard on, the picked player is gone, a different player remains: waiting, shown by the rule.
{
  const d = driver(true);
  d.select(SPOTIFY, 0);
  const r = d.read([LESSONPLAYER, RADIO], LESSONPLAYER, 1000);
  check('guard on, Spotify gone, Radio + LessonPlayer: waiting, Radio shown by the LessonPlayer rule',
    r.by === 'waiting' && r.auto === 'lessonplayer-rule' && r.want === RADIO.aumid, JSON.stringify(r));
}

// 5. AUMIDs compare case-insensitively; the pick's name follows the session's.
{
  const d = driver(false);
  d.select({ aumid: 'spotify.EXE' }, 0);
  const r = d.read([LESSONPLAYER, SPOTIFY], LESSONPLAYER, 10);
  check('case-insensitive AUMID match', r.by === 'you' && d.pick.name === 'Spotify', JSON.stringify(r));
}

// 6. No sessions, no pick: nothing to show, nothing thrown.
{
  const r = choose({ pick: null, sessions: [], current: null, guardOn: true, now: 0 });
  check('empty: by null, want null', r.by === null && r.want === null && !r.lessonplayerOnly, JSON.stringify(r));
}

for (const f of failures) console.log(`FAIL ${f}`);
console.log(`media-pick tests: ${passed} passed, ${failures.length} failed`);
process.exitCode = failures.length ? 1 : 0;

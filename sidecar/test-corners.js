// test-corners.js - the hot corners' sidecar half (sidecar/HotCorners.cs) and the check they make at
// the moment of firing (gamemode.scan {procs:true}, read through lib/features/_corners.js fireBlocker).
//
//   MANTLE_SIDECAR_EXE=<your exe> node sidecar/test-corners.js
//
// PASSIVE, like every sidecar test: Show desktop is only ever a DRY RUN here, and the real call must
// be REFUSED with the passive words - nothing on Owen's screen is minimised. The scan is a read.
// Prints one summary line, "CORNERS SIDECAR TEST: n passed, m failed".
'use strict';

const T = require('./test-lib');
const C = require('../lib/features/_corners');
const P = require('../lib/features/_gamemode-plan');

(async () => {
  const t = T.checker('CORNERS SIDECAR');
  const s = await T.startPassive();
  try {
    const dry = await s.send('hotcorners.desktop', { dryRun: true }, 4000);
    t.check('hotcorners.desktop dry run: Shell.Application is created and the call is named, nothing is called',
      dry.ok === true && dry.result && dry.result.dryRun === true && /ToggleDesktop/.test(dry.result.wouldCall || '') && !dry.result.called, JSON.stringify(dry).slice(0, 300));
    const real = await s.send('hotcorners.desktop', {}, 4000);
    t.check('hotcorners.desktop for real is REFUSED by a passive sidecar (no window of Owen\'s is minimised)',
      real.ok === false && String(real.error || '').indexOf(T.PASSIVE_REFUSAL) === 0 && /Show desktop/.test(real.error), JSON.stringify(real).slice(0, 300));
    const t0 = Date.now();
    const scan = await s.send('gamemode.scan', { procs: true }, 3000);
    const ms = Date.now() - t0;
    const r = scan.ok ? Object.assign({ ok: true }, scan.result) : { ok: false, reason: scan.error };
    t.check('gamemode.scan {procs:true} answers the window in front with a fullscreen flag, and a process list',
      r.ok && r.fg && typeof r.fg.fullscreen === 'boolean' && Array.isArray(r.procs) && r.procs.length > 10, JSON.stringify({ ok: r.ok, reason: r.reason, fg: !!r.fg, procs: r.procs && r.procs.length }));
    const why = C.fireBlocker(r, P, { seen: new Map() });
    t.check('the fire check reads it (null or plain words) in under 1.5 s (the timeout corners.js gives it)', (why === null || typeof why === 'string') && ms < 1500, `${ms} ms, ${why}`);
    // counts and the verdict only: no title of Owen's windows is printed
    console.log(`  (the scan: ${ms} ms, ${r.procs ? r.procs.length : 0} processes, the window in front ${r.fg && r.fg.fullscreen ? 'IS' : 'is not'} full screen; a corner would ${why ? 'NOT fire: ' + why.replace(/^[^ ]+ is/, 'a window is') : 'fire'})`);
    const stand = C.fireBlocker(r, P, { seen: new Map(), extra: ['Mantle.Sidecar.exe'] });
    t.check('a TEST stand-in game (the sidecar\'s own exe, running in this session) refuses a corner', /running \(a known game\)/.test(String(stand)), String(stand));
  } finally {
    await s.stop();
  }
  process.exit(t.summary());
})().catch((e) => { console.log('CORNERS SIDECAR TEST: 0 passed, 1 failed'); console.log('  FAIL the test threw: ' + (e.stack || e.message)); process.exit(1); });

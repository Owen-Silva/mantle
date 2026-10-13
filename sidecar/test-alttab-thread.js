// test-alttab-thread.js - an Alt+Tab commit never holds the keyboard hook's thread, however slow the
// switch is (sidecar/AltTab.cs Commit + SwitchRunner, measured by switcher.lab in AltTabLive.cs).
// Lane mn-althread, 2026-10-12.
//
//   MANTLE_SIDECAR_EXE=<your exe> node sidecar/test-alttab-thread.js [--hook] [--onscreen]
//
// WHY: every keystroke on the desktop waits for the hook thread to pump. The switch (SetForegroundWindow,
// the focus ladder with its 800 ms bounded waits and 150 ms landing wait, the Alt nudge) can take a
// second; on the hook thread that is past LowLevelHooksTimeout, keys typed meanwhile leak to Windows
// and Windows may drop the hook. switcher.lab commits a one-tile session through the SAME Commit an
// Alt-up runs, with a test-only delay before the switch (a ladder that slow), and pings the hook
// thread every 5 ms while the switch runs.
//
//   PASSIVE (always): a passive sidecar has no hook, so a stand-in thread pumps as the hook thread
//     does and hands every message to the same Switcher.OnThreadMessage. Commits onto a CLOSED
//     window (nothing is switched; the answer is the "closed" refusal, in words).
//   --hook: a LIVE sidecar with a pass-through hook (hotkey {observe:['VolumeUp']}: swallows
//     nothing) - the REAL hook thread, same commits. Seconds long; nothing is pressed.
//   --onscreen (or MANTLE_TEST_VISIBLE=1; the visible slot only: idle >= 3 min and
//     mantle-notes\visible.lock): the focus lab's own windows under a real foreground lock
//     (sidecar/focus-lab.js), the real switch onto the lab's window B from the switch thread,
//     with the real hook thread pinged meanwhile. Without the slot it is reported NOT RUN.
//
// Prints one summary line, "ALTTAB THREAD TEST: n passed, m failed".
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const T = require('./test-lib');

const wantHook = process.argv.includes('--hook');
const onscreen = process.argv.includes('--onscreen') || process.env.MANTLE_TEST_VISIBLE === '1';
const LOCK = 'C:\\Users\\user\\mantle-notes\\visible.lock';

// A switch slower than LowLevelHooksTimeout's ~1 s would be if it ran on the hook thread.
const SLOW = 900;
// What the hook thread may be held for: Commit's own bookkeeping, nothing that waits.
const HOOK_MAX_MS = 20;
const PING_MAX_MS = 50;

const brief = (r) => JSON.stringify(Object.assign({}, r, { activated: r && r.activated ? { ok: r.activated.ok, how: r.activated.how, cause: r.activated.cause, ms: r.activated.ms } : null }));

/** The commit checks, the same for the stand-in and the real hook thread. */
async function commits(t, s, label, wantThread) {
  const lab = (o, ms) => s.send('switcher.lab', o, ms || 9000);

  const base = await lab({ op: 'ping', count: 50 });
  t.check(`${label}: the ${wantThread} thread answers pings`, base.ok && base.result.thread === wantThread &&
    base.result.unanswered === 0 && base.result.pings === 50, JSON.stringify(base));
  const baseMax = base.ok ? base.result.pingMaxMs : null;

  // A fast switch first: the same answers as before the move.
  let r = await lab({ op: 'commit', hwnd: 'closed', delayMs: 0 });
  let x = r.result || {};
  t.check(`${label}: a commit onto a closed window answers "closed" in words`, r.ok && x.finished && x.activated &&
    x.activated.ok === false && x.activated.cause === 'closed' && /closed before Mantle could switch/.test(x.activated.reason || ''),
    brief(x) + (r.error || ''));

  // The slow one: the switch takes SLOW ms; the hook thread must answer all the way through.
  r = await lab({ op: 'commit', hwnd: 'closed', delayMs: SLOW });
  x = r.result || {};
  t.check(`${label}: the slow switch ran (${SLOW} ms) and answered`, r.ok && x.finished && x.activated &&
    x.activated.cause === 'closed' && x.activated.ms >= SLOW, brief(x) + (r.error || ''));
  t.check(`${label}: Commit kept the hook thread under ${HOOK_MAX_MS} ms while the switch took ${SLOW} ms`,
    r.ok && typeof x.commitMs === 'number' && x.commitMs < HOOK_MAX_MS, `commitMs=${x.commitMs}`);
  t.check(`${label}: the hook thread answered every ping during the slow switch, slowest under ${PING_MAX_MS} ms`,
    r.ok && x.unanswered === 0 && x.pings >= 40 && x.pingMaxMs < PING_MAX_MS,
    `pings=${x.pings} unanswered=${x.unanswered} max=${x.pingMaxMs} median=${x.pingMedianMs} (idle max ${baseMax})`);

  // A second Alt+Tab 50 ms into the first one's slow switch: it is not stuck behind it (its own
  // switch answers in well under the first's SLOW ms), and the hook thread stays free throughout.
  r = await lab({ op: 'commit', hwnd: 'closed', delayMs: SLOW, thenDelayMs: 0 });
  const y = r.result || {};
  t.check(`${label}: both of two overlapping commits answered`, r.ok && y.finished && y.commits === 2 && y.activated && y.then &&
    y.activated.cause === 'closed' && y.then.cause === 'closed', brief(y) + (r.error || ''));
  t.check(`${label}: the second switch did not wait for the first one's ${SLOW} ms`,
    r.ok && y.then && y.then.ms < SLOW / 2, `second ms=${y.then && y.then.ms}`);
  t.check(`${label}: overlapping commits held the hook thread under ${HOOK_MAX_MS} ms each, every ping answered`,
    r.ok && y.commitMs < HOOK_MAX_MS && y.unanswered === 0 && y.pingMaxMs < PING_MAX_MS,
    `commitMs=${y.commitMs} pings=${y.pings} max=${y.pingMaxMs}`);

  return { base: base.result, slow: x, overlap: y };
}

/** The events a commit sends main are the same shape as before: commit, then activated. */
function events(t, s, label) {
  const sw = s.events.filter((e) => e.ev === 'switcher' && e.via === 'lab');
  const commitsSeen = sw.filter((e) => e.op === 'commit');
  const acts = sw.filter((e) => e.op === 'activated');
  t.check(`${label}: every lab commit sent "commit" then "activated" (seq matched)`, commitsSeen.length >= 4 &&
    acts.length === commitsSeen.length && commitsSeen.every((c) => acts.some((a) => a.seq === c.seq)),
    `commit=${commitsSeen.length} activated=${acts.length}`);
  t.check(`${label}: a refused switch carries ok:false, cause and reason; the rest of the event is unchanged`,
    acts.every((a) => a.ok === false && typeof a.reason === 'string' && a.cause === 'closed' &&
      typeof a.ms === 'number' && 'how' in a && 'hwnd' in a && 'title' in a), JSON.stringify(acts.map((a) => Object.keys(a).sort().join(','))[0]));
}

async function idleMs() {
  try { return await require('./focus-lab').idleNow(); } catch (_) { return 0; }
}

async function startLive() {
  const stateFile = path.join(os.tmpdir(), `mantle-althread-${process.pid}-${Date.now()}.state.json`);
  const s = T.spawnSidecar(T.exePath(), ['--parent-pid=' + process.pid, '--state-file=' + stateFile]);
  await s.waitEvent('ready', 8000);
  s.stop = async () => {
    try { await s.send('hotkey', { observe: [] }, 4000); } catch (_) { /* quitting removes it anyway */ }
    try { s.proc.stdin.write(JSON.stringify({ id: 999999, cmd: 'quit' }) + '\n'); } catch (_) { /* gone */ }
    try { await s.waitExit(3000); } catch (_) { try { s.proc.kill(); } catch (__) { /* gone */ } }
    try { fs.unlinkSync(stateFile); } catch (_) { /* never written */ }
  };
  return s;
}

(async () => {
  const t = T.checker('ALTTAB THREAD');
  const report = {};
  let s = null;
  try {
    /* ---- passive: the stand-in thread ------------------------------------------------------- */
    s = await T.startPassive();
    const ping = await s.call('ping', {}, 4000);
    const cmds = (ping.features && ping.features.commands) || [];
    t.check('ping lists switcher.lab', cmds.includes('switcher.lab'), String(cmds.length));

    // Somebody's real window (the first on the Alt+Tab list; its title is never read here).
    const list = await s.call('hotkey', { op: 'list' }, 4000);
    const someone = (list.list || [])[0];
    let r;
    if (someone) {
      r = await s.send('switcher.lab', { op: 'commit', hwnd: someone.hwnd, onScreen: true });
      t.check('a real window that is not the focus lab\'s is refused in words, even with onScreen', !r.ok &&
        /only switches to a focus-lab window/.test(r.error || ''), r.error);
    } else {
      console.log('  (no window on the Alt+Tab list to refuse: that check skipped)');
    }
    r = await s.send('switcher.lab', { op: 'commit', hwnd: 'closed', delayMs: 99999 });
    t.check('a delay past 5 s is refused', !r.ok && /0\.\.5000/.test(r.error || ''), r.error);
    r = await s.send('switcher.lab', { op: 'nope' });
    t.check('an unknown op is refused in words', !r.ok && /unknown op/.test(r.error || ''), r.error);

    report.standIn = await commits(t, s, 'stand-in', 'stand-in');
    events(t, s, 'stand-in');
    await s.stop();
    s = null;

    /* ---- --hook: the real hook thread ------------------------------------------------------- */
    if (wantHook) {
      s = await startLive();
      r = await s.send('switcher.lab', { op: 'ping', count: 3 });
      t.check('live, no hook yet: the lab says to install it, in words', !r.ok && /install it first/.test(r.error || ''), r.error);
      r = await s.send('hotkey', { observe: ['VolumeUp'] }, 6000);
      t.check('live: a pass-through hook installs (observe VolumeUp, swallows nothing)', r.ok, r.error);
      report.hook = await commits(t, s, 'hook', 'hook');
      events(t, s, 'hook');
      await s.stop();
      s = null;
    } else {
      console.log('  real hook thread part: NOT RUN (pass --hook: a live sidecar with a pass-through hook, seconds long)');
    }

    /* ---- --onscreen: the real switch from the switch thread --------------------------------- */
    if (onscreen) {
      const idle = await idleMs();
      let locked = false;
      if (!(idle >= 180000)) {
        console.log(`  on-screen part: NOT RUN (idle ${Math.round(idle / 1000)} s, needs 180 s)`);
      } else {
        try { fs.mkdirSync(LOCK); locked = true; fs.writeFileSync(path.join(LOCK, 'owner.txt'), 'mn-althread ' + new Date().toISOString()); }
        catch (_) { console.log('  on-screen part: NOT RUN (the visible slot is taken)'); }
      }
      if (locked) {
        const Lab = require('./focus-lab');
        let lab = null;
        try {
          lab = await Lab.start();
          await T.sleep(300);
          s = await startLive();
          await s.send('hotkey', { observe: ['VolumeUp'] }, 6000);
          report.onscreen = [];
          for (const delayMs of [0, SLOW, 0]) {
            const real = lab.real();
            if (real) throw Object.assign(new Error('real input arrived: ' + real), { real: true });
            const scene = await lab.setScene(0);      // A in front, a real foreground lock, no hand-over
            if (scene) { report.onscreen.push({ scene }); continue; }
            r = await s.send('switcher.lab', { op: 'commit', hwnd: lab.info.B.hwnd, delayMs, onScreen: true }, 12000);
            await T.sleep(250);
            const x = r.result || {};
            x.fgAfter = (await lab.fg()) === lab.info.B.hwnd;
            report.onscreen.push(brief(x));
            console.log(`  on screen, delay ${delayMs}: ok=${x.activated && x.activated.ok} how=${x.activated && x.activated.how} ` +
              `switch=${x.activated && x.activated.ms} ms, hook thread held ${x.commitMs} ms, pings ${x.pings} (max ${x.pingMaxMs} ms), B in front=${x.fgAfter}`);
            t.check(`on screen (delay ${delayMs}): the lab's window B came forward from the switch thread`,
              r.ok && x.finished && x.activated && x.activated.ok === true && x.fgAfter, brief(x) + (r.error || ''));
            t.check(`on screen (delay ${delayMs}): "how" names the rung that won`,
              r.ok && x.activated && ['direct', 'ladder'].includes(x.activated.how), x.activated && x.activated.how);
            t.check(`on screen (delay ${delayMs}): the hook thread was held under ${HOOK_MAX_MS} ms and answered every ping`,
              r.ok && x.commitMs < HOOK_MAX_MS && x.unanswered === 0 && x.pingMaxMs < PING_MAX_MS,
              `commitMs=${x.commitMs} pings=${x.pings} max=${x.pingMaxMs}`);
          }
          const real = lab.real();
          if (real) throw Object.assign(new Error('real input arrived: ' + real), { real: true });
        } catch (e) {
          console.log(`  on-screen part: ${e.real ? 'NOT RUN (' + e.message + ')' : 'FAILED to run: ' + e.message}`);
          if (!e.real) t.check('on-screen part ran', false, e.message);
        } finally {
          if (s) { try { await s.stop(); } catch (_) { /* gone */ } s = null; }
          if (lab) lab.stop();
          try { fs.rmSync(LOCK, { recursive: true, force: true }); } catch (_) { /* left */ }
        }
      }
    } else {
      console.log('  on-screen part: NOT RUN (needs --onscreen or MANTLE_TEST_VISIBLE=1, inside the visible slot)');
    }
  } catch (e) {
    t.check('the test ran to the end', false, e.stack || e.message);
  } finally {
    if (s) { try { await s.stop(); } catch (_) { /* gone */ } }
  }
  if (process.argv.includes('--report')) console.log(JSON.stringify(report, null, 1));
  process.exit(t.summary());
})();

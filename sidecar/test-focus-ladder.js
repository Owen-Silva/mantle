// test-focus-ladder.js - the focus ladder (WindowList.Focus / FocusLadder, sidecar/Windows.cs) and
// main's hand-over of the click's foreground right (lib/fg-grant.js). Lane mn-focus, 2026-10-12.
//
//   MANTLE_SIDECAR_EXE=<your exe> node sidecar/test-focus-ladder.js [--onscreen]
//
// THE BUG: 24 bar clicks in two days answered "Windows refused the foreground change". The bar is
// focusable:false, so the click left the app Owen was in as the foreground process and was
// delivered to Electron; the sidecar, which called SetForegroundWindow, had no right to.
//
// AFTER THAT SHIPPED (lane wk-mantle-focus, 2026-10-14): bar clicks all won on rung 1; the only
// refusals left came while the sign-in screen's PIN box had the input. Rung 0 (InputElsewhere) now
// says so and touches nothing; focus.inputdesk runs the real check, also on a scratch desktop.
//
// PASSIVE PART (always): focus.simulate drives every branch of the ladder on a script (which rung
// wins, the order, that a late attach stops the ladder, the words, no rung after a win); `focus`
// and focus.fixture refuse what they must; lib/fg-grant.js answers in words and never throws.
// ON-SCREEN PART (--onscreen, or MANTLE_TEST_VISIBLE=1; the visible slot only, see focus-lab-run.js):
// a real foreground lock built from the lab's own windows, and the real ladder through
// focus.fixture, without and with the bar's hand-over. Without the slot it is reported NOT RUN.
//
// Prints one summary line, "FOCUS LADDER TEST: n passed, m failed".
'use strict';

const path = require('path');
const T = require('./test-lib');
const fgGrant = require('../lib/fg-grant');

const onscreen = process.argv.includes('--onscreen') || process.env.MANTLE_TEST_VISIBLE === '1';

(async () => {
  const t = T.checker('FOCUS LADDER');
  const notes = [];
  let s = null;
  try {
    s = await T.startPassive();
    const ping = await s.call('ping', {}, 4000);
    const cmds = (ping.features && ping.features.commands) || [];
    t.check('ping lists focus.simulate, focus.fixture and focus.inputdesk', cmds.includes('focus.simulate') && cmds.includes('focus.fixture') &&
      cmds.includes('focus.inputdesk'), JSON.stringify(cmds.filter((c) => /^focus/.test(c))));

    const sim = (script) => s.call('focus.simulate', { script }, 4000);

    // 1. Already in front: nothing is called.
    let r = await sim({ already: true });
    t.check('already in front: how=already, no rung tried', r.how === 'already' && r.error === null && r.tried.length === 0 &&
      !r.calls.some((c) => /direct|attach|alt|switch/.test(c)), JSON.stringify(r));

    // 2. The hand-over worked: rung 1 wins and nothing after it runs.
    r = await sim({ direct: true });
    t.check('granted: direct wins, attach/alt/switch never run', r.how === 'direct' && r.error === null && r.tried.length === 0 &&
      r.calls.join(',') === 'inputdesk,restore,foreground,direct,wait 150', JSON.stringify(r.calls));

    // 3. Accepted but the app showed another of its windows first: not a win, the next rung runs,
    //    and the report says what happened (the old ladder called this a refusal and stopped there).
    r = await sim({ direct: true, directLands: false, attach: 'ok' });
    t.check('direct accepted but not landed: attach runs and wins', r.how === 'attach' &&
      r.tried[0] === 'direct: accepted, but another window stayed in front', JSON.stringify(r));

    // 4. Refused, attach wins.
    r = await sim({ attach: 'ok' });
    t.check('direct refused: attach wins; tried names direct only', r.how === 'attach' && r.tried.join('|') === 'direct: refused' &&
      r.calls.indexOf('attach') > r.calls.indexOf('direct') && !r.calls.includes('alt-nudge'), JSON.stringify(r));

    // 5. A late attach stops the ladder (an Alt tap would race the helper still attached).
    r = await sim({ attach: 'late', alt: true, switchLands: true });
    t.check('late attach: stops, no alt, no switch, says it stopped waiting', r.how === null && /did not answer within \d+ ms/.test(r.error || '') &&
      !r.calls.includes('alt-nudge') && !r.calls.includes('switch'), JSON.stringify(r));

    // 6. Alt wins: the nudge comes BEFORE the second SetForegroundWindow.
    r = await sim({ alt: true });
    t.check('alt wins, nudge before its SetForegroundWindow', r.how === 'alt' && r.calls.indexOf('alt-nudge') >= 0 &&
      r.calls.indexOf('alt-nudge') < r.calls.indexOf('alt-set') && !r.calls.includes('switch'), JSON.stringify(r.calls));

    // 7. Only SwitchToThisWindow lands.
    r = await sim({ attach: 'failed', switchLands: true });
    t.check('switch is the last rung and can win', r.how === 'switch' && r.tried.length === 3 &&
      /administrator/.test(r.tried[1]), JSON.stringify(r));

    // 8. Everything loses: the old sentence (main and the switcher match it), then every rung.
    r = await sim({});
    t.check('all lose: the refusal sentence, then each rung in order', r.how === null &&
      /^could not raise window 4242: Windows refused the foreground change \(another app holds the foreground lock\); tried direct: refused; attach: attached, refused; alt: refused; switch: another window stayed in front$/.test(r.error || ''),
      String(r.error));
    const split = fgGrant.splitTried(r.error);
    t.check('main shows the sentence and logs the rungs', /lock\)$/.test(split.shown) && /^tried direct: refused; .*switch:/.test(split.tried),
      JSON.stringify(split));

    // 9. A switch that does not return is bounded and says so.
    r = await sim({ switchLate: true });
    t.check('a hung SwitchToThisWindow is bounded and said', r.how === null && /SwitchToThisWindow did not return within \d+ ms/.test(r.error || ''), String(r.error));

    // 10. A minimised window is restored first, before anything else.
    r = await sim({ minimised: true, direct: true });
    t.check('minimised: restore is the first call after the input-desktop check, and is reported', r.restored === true &&
      r.calls[0] === 'inputdesk' && r.calls[1] === 'restore', JSON.stringify(r));

    // 10b. Rung 0 (lane wk-mantle-focus, 2026-10-14). The live log after the hand-over shipped: the only
    //      refusals left were Task View fired by the top-left hot corner right after "the lock screen
    //      closed", while the PIN box (Windows' secure desktop) had the input. There the ladder must
    //      say THAT, not "another app holds the foreground lock", and touch nothing: no restore, no
    //      SetForegroundWindow, no Alt typed into the desktop switch, no SwitchToThisWindow.
    r = await sim({ elsewhere: true, minimised: true, direct: true, alt: true, switchLands: true });
    t.check('secure desktop has the input: says so, in words', r.how === null &&
      /^could not raise window 4242: the sign-in or lock screen has the keyboard \(Windows' secure desktop.*\), so no window can come forward until it closes$/.test(String(r.error)) &&
      !/foreground lock/.test(String(r.error)), String(r.error));
    t.check('secure desktop has the input: no rung, no restore, no Alt (only the check ran)', r.calls.join(',') === 'inputdesk' &&
      r.tried.length === 0 && r.restored === false && typeof r.inputDesktop === 'string', JSON.stringify(r));
    t.check('secure desktop: the bar shows the whole sentence (no "; tried" list to split off)',
      fgGrant.splitTried(r.error).shown === r.error && fgGrant.splitTried(r.error).tried === '', JSON.stringify(fgGrant.splitTried(r.error)));
    r = await sim({ elsewhere: false, direct: true });
    t.check('input desktop is ours: the ladder runs as before (direct wins)', r.how === 'direct' && r.calls[0] === 'inputdesk' &&
      r.calls.includes('direct'), JSON.stringify(r.calls));

    // 10c. The REAL check (WindowList.InputElsewhere, the Win32 calls themselves), read-only. On the
    //      sidecar's own thread the session is unlocked while tests run, so the input desktop is ours.
    //      offDesktop moves a thread onto a scratch desktop that is never switched to (nothing shown),
    //      which is what Mantle's threads are while the secure desktop has the input.
    const own = await s.call('focus.inputdesk', {}, 4000);
    t.check('real check, own thread: the input desktop is ours ("Default")', own.ours === true && own.words === null &&
      own.thread === 'Default', JSON.stringify(own));
    const off = await s.call('focus.inputdesk', { offDesktop: true }, 4000);
    t.check('real check, a thread on another desktop: not ours, in words that name both desktops', off.ours === false &&
      /^another desktop has the keyboard \("Default", not Mantle's "mantle-focus-test-\d+-\d+"\)$/.test(String(off.words)) &&
      /^mantle-focus-test-/.test(String(off.thread)), JSON.stringify(off));
    const again = await s.call('focus.inputdesk', {}, 4000);
    t.check('real check: the scratch desktop left the sidecar\'s own thread alone', again.ours === true && again.thread === 'Default', JSON.stringify(again));

    // 11. Refusals the real commands must give.
    let e = '';
    try { await s.call('focus', { hwnd: String(ping.selfHwnd || 1) }, 4000); } catch (x) { e = x.message; }
    t.check('passive: focus is refused', e === T.PASSIVE_REFUSAL, e);
    e = '';
    try { await s.call('focus.fixture', { hwnd: String(ping.selfHwnd), onScreen: true }, 4000); } catch (x) { e = x.message; }
    t.check('focus.fixture refuses a window that is not the lab\'s', /only runs on the test fixture/.test(e), e);
    e = '';
    try { await s.call('focus.simulate', {}, 4000); } catch (x) { e = x.message; }
    t.check('focus.simulate without a script says what it wants', /needs a script/.test(e), e);

    // 12. lib/fg-grant.js: words, never throws.
    t.check('grant: no pid -> not granted, in words', fgGrant.grant(null).granted === false && /not running/.test(fgGrant.grant(0).reason));
    let asked = null;
    t.check('grant: hands the pid to AllowSetForegroundWindow', fgGrant.grant(1234, { allow: (p) => { asked = p; return 1; } }).granted === true && asked === 1234);
    t.check('grant: FALSE from Windows -> not granted, why in words', /no longer the last input/.test(fgGrant.grant(9, { allow: () => 0 }).reason));
    t.check('grant: a throw becomes words', /threw/.test(fgGrant.grant(9, { allow: () => { throw new Error('x'); } }).reason));
    const real = fgGrant.grant(process.pid);
    t.check('grant: the real binding answers (granted or a reason)', real.granted === true || typeof real.reason === 'string', JSON.stringify(real));
    t.check('howWords: rung, then what lost before it, no names', fgGrant.howWords({ how: 'attach', tried: ['direct: refused'], ms: 12 }) === 'attach after direct: refused, 12 ms');
    t.check('words: granted / not granted: why', fgGrant.words({ granted: true }) === 'granted' && fgGrant.words({ granted: false, reason: 'r' }) === 'not granted: r');
  } catch (err) {
    t.fail('the test threw', err && err.stack ? err.stack.split('\n').slice(0, 3).join(' | ') : String(err));
  } finally {
    if (s) await s.stop();
  }

  if (!onscreen) {
    console.log('  on-screen part: NOT RUN (needs --onscreen or MANTLE_TEST_VISIBLE=1, inside the visible slot)');
  } else {
    const run = require('./focus-lab-run');
    const out = await run.run({ exe: T.exePath(), trials: 3, techniques: process.argv.includes('--techniques') });
    if (!out.ran) {
      console.log(`  on-screen part: NOT RUN (${out.why})`);
    } else {
      for (const [how, list] of Object.entries(out.techniques)) notes.push(`technique ${how}: ${list.join(' | ')}`);
      const un = out.ladder.ungranted, gr = out.ladder.granted;
      const fmt = (x) => x.scene ? `scene: ${x.scene}` : `${x.how || 'LOST'}${x.tried && x.tried.length ? ` after [${x.tried.join('; ')}]` : ''} ${x.ms} ms${x.fgAfter ? '' : ' (B NOT in front after)'}${x.grant !== undefined ? ` grant ${x.grant}` : ''}`;
      notes.push('ladder, no hand-over: ' + un.map(fmt).join(' | '));
      notes.push('ladder, bar hands over: ' + gr.map(fmt).join(' | '));
      t.check('on screen, bar hands over: every click brings the window forward', gr.length > 0 && gr.every((x) => !x.scene && !x.error && x.fgAfter), gr.map(fmt).join(' | '));
      t.check('on screen, bar hands over: rung 1 (direct) wins', gr.length > 0 && gr.every((x) => x.how === 'direct'), gr.map(fmt).join(' | '));
      t.check('on screen, no hand-over: the ladder still lands, and says which rung', un.length > 0 && un.every((x) => !x.scene && !x.error && x.fgAfter && x.how), un.map(fmt).join(' | '));
    }
  }
  for (const n of notes) console.log('  ' + n);
  process.exit(t.summary());
})();

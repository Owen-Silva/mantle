#!/usr/bin/env node
/* test-unfold.js - the unfold feature's sidecar half: display / lid / suspend / resume pushes and the
 * "any input happened" watch (lane unfold-unlock, 2026-10-23).
 *
 * WHAT IT CHANGES ON THE USER'S MACHINE: NOTHING. The sidecar runs --passive; every unfold command is
 * read-only (a power-setting registration and GetLastInputInfo), and the screen, lid and power events
 * this drives are unfold.simulate pushes, which only a passive sidecar takes.
 *
 * Real input may happen while it runs (the user may touch the mouse): every input-watch check accepts
 * either a real `input` or an `inputEnd` timeout, and says which happened.
 *
 *   node sidecar/test-unfold.js --exe=<your build>      (or MANTLE_SIDECAR_EXE)
 * Prints "UNFOLD TEST: n passed, m failed"; exits 1 on a failure. Output: states and counts only.
 */
'use strict';
const T = require('./test-lib');

const J = (o) => JSON.stringify(o).slice(0, 220);

(async () => {
  const t = T.checker('UNFOLD');
  const s = await T.startPassive();
  const uf = () => s.collect('unfold');
  const forToken = (tok) => uf().filter((e) => (e.what === 'input' || e.what === 'inputEnd') && e.token === tok);
  try {
    // ---- the watch
    const st0 = await s.call('unfold.state', {}, 4000);
    t.check('state before any watch: not watching, no display, no input watch',
      st0.watching === false && st0.display === null && st0.lid === null && st0.input && st0.input.on === false, J(st0));
    const noOn = await s.send('unfold.watch', {}, 4000);
    t.check('unfold.watch without on is a plain-words error', noOn.ok === false && /on: true or false/.test(noOn.error || ''), J(noOn));

    const w1 = await s.call('unfold.watch', { on: true }, 4000);
    t.check('watch on -> watching true', w1.watching === true, J(w1));
    t.check('watch on registers display and power', Array.isArray(w1.registered) && w1.registered.includes('display') && w1.registered.includes('power'), J(w1));

    let disp = null;
    try { disp = await s.waitEvent('unfold', 3000, (e) => e.what === 'display'); } catch (e) { /* checked below */ }
    t.check('an initial display event arrives within 3 s', !!disp && disp.initial === true && ['on', 'off', 'dim'].includes(disp.state), J(disp));
    t.check('the initial display event is not marked simulated', !!disp && !disp.simulated, J(disp));

    const st1 = await s.call('unfold.state', {}, 4000);
    t.check('state reports the display', !!disp && st1.display === disp.state && st1.watching === true, J(st1));

    let lid = null;
    try { lid = await s.waitEvent('unfold', 2000, (e) => e.what === 'lid'); } catch (e) { /* maybe no lid */ }
    const st1b = await s.call('unfold.state', {}, 4000);
    const lidReason = typeof st1b.reason === 'string' && /lid/.test(st1b.reason);
    t.check('a lid initial event arrives, or the reason names the lid',
      (!!lid && lid.initial === true && typeof lid.open === 'boolean') || lidReason, J({ lid, reason: st1b.reason }));
    if (lid) {
      console.log('  note: lid initial event arrived: open=' + lid.open);
      t.check('state reports the lid', st1b.lid === (lid.open ? 'open' : 'closed'), J(st1b));
    } else {
      console.log('  note: no lid event; reason: ' + st1b.reason);
    }

    const w2 = await s.call('unfold.watch', { on: true }, 4000);
    await T.sleep(500);
    t.check('watch on again is idempotent (still watching, ONE initial display event)',
      w2.watching === true && uf().filter((e) => e.what === 'display' && e.initial).length === 1, J({ w2, n: uf().filter((e) => e.what === 'display').length }));

    // ---- the input watch
    const i1 = await s.call('unfold.input', { on: true, token: 1, maxMs: 300 }, 4000);
    t.check('input on answers watching, token, defaults pollMs 16, maxMs as given',
      i1.watching === true && i1.token === 1 && i1.pollMs === 16 && i1.maxMs === 300, J(i1));
    const sti = await s.call('unfold.state', {}, 4000);
    t.check('state shows the running input watch', sti.input.on === true && sti.input.token === 1 && typeof sti.input.sinceMs === 'number', J(sti.input));
    await T.sleep(1200);
    const e1 = forToken(1);
    t.check('maxMs 300: exactly one input or inputEnd for token 1', e1.length === 1 &&
      ((e1[0].what === 'input' && typeof e1[0].afterMs === 'number') || (e1[0].what === 'inputEnd' && e1[0].why === 'timeout')), J(e1));
    if (e1.length) console.log('  note: token 1 ended with ' + e1[0].what + (e1[0].what === 'input' ? ' (real input, afterMs ' + e1[0].afterMs + ')' : ' (timeout)'));
    const sti2 = await s.call('unfold.state', {}, 4000);
    t.check('state: the input watch is off after it ended', sti2.input.on === false, J(sti2.input));

    // replacement: token 2 is replaced at once by token 3; only 3 may end.
    await s.call('unfold.input', { on: true, token: 2, maxMs: 1500 }, 4000);
    const i3 = await s.call('unfold.input', { on: true, token: 3, maxMs: 300 }, 4000);
    t.check('a second input on answers the new token', i3.watching === true && i3.token === 3, J(i3));
    await T.sleep(2000);
    t.check('the replaced watch (token 2) ends silently', forToken(2).length === 0, J(forToken(2)));
    t.check('the new watch (token 3) ends exactly once', forToken(3).length === 1, J(forToken(3)));
    if (forToken(3).length) console.log('  note: token 3 ended with ' + forToken(3)[0].what);

    // clamps
    const ic = await s.call('unfold.input', { on: true, token: 4, pollMs: 1, maxMs: 0 }, 4000);
    t.check('pollMs 1 and maxMs 0 are clamped (8, 50), not errors', ic.watching === true && ic.pollMs === 8 && ic.maxMs === 50, J(ic));
    await T.sleep(600);
    t.check('the clamped watch (token 4) ends exactly once', forToken(4).length === 1, J(forToken(4)));
    const ib = await s.call('unfold.input', { on: true, token: 5, pollMs: 99999, maxMs: 1e12 }, 4000);
    t.check('huge pollMs and maxMs are clamped (250, 1800000)', ib.pollMs === 250 && ib.maxMs === 1800000, J(ib));
    const io = await s.call('unfold.input', { on: false }, 4000);
    t.check('input off -> watching false', io.watching === false, J(io));
    await T.sleep(600);
    const real5 = forToken(5);
    // Real input inside the ~4 ms before `off` landed is the only way token 5 could speak.
    t.check('input off stops with no event (token 5)', real5.length === 0 || (real5.length === 1 && real5[0].what === 'input'), J(real5));
    const noOnI = await s.send('unfold.input', { token: 9 }, 4000);
    t.check('unfold.input without on is a plain-words error', noOnI.ok === false && /on: true or false/.test(noOnI.error || ''), J(noOnI));

    // ---- simulate
    const sd = await s.call('unfold.simulate', { what: 'display', state: 'dim' }, 4000);
    const ed = await s.waitEvent('unfold', 2000, (e) => e.what === 'display' && e.simulated === true);
    t.check('simulate display -> the display event with simulated:true', !!sd && ed.state === 'dim' && ed.initial === false, J(ed));
    const sl = await s.call('unfold.simulate', { what: 'lid', open: false }, 4000);
    const el = await s.waitEvent('unfold', 2000, (e) => e.what === 'lid' && e.simulated === true);
    t.check('simulate lid -> the lid event with simulated:true', !!sl && el.open === false && el.initial === false, J(el));
    const sts = await s.call('unfold.state', {}, 4000);
    t.check('state follows the simulated display and lid', sts.display === 'dim' && sts.lid === 'closed', J(sts));
    await s.call('unfold.simulate', { what: 'suspend' }, 4000);
    const es = await s.waitEvent('unfold', 2000, (e) => e.what === 'suspend' && e.simulated === true);
    t.check('simulate suspend -> {what:suspend, simulated:true}', !!es, J(es));
    await s.call('unfold.simulate', { what: 'resume' }, 4000);
    const er = await s.waitEvent('unfold', 2000, (e) => e.what === 'resume' && e.simulated === true);
    t.check('simulate resume -> {what:resume, simulated:true}', !!er, J(er));

    // simulate input ends a running watch for that token
    await s.call('unfold.input', { on: true, token: 6, maxMs: 60000 }, 4000);
    await T.sleep(50);
    const realBefore = forToken(6).filter((e) => !e.simulated).length;
    const si = await s.call('unfold.simulate', { what: 'input', token: 6 }, 4000);
    const ei = await s.waitEvent('unfold', 2000, (e) => e.what === 'input' && e.simulated === true && e.token === 6);
    t.check('simulate input -> {what:input, token, afterMs, simulated:true}', !!ei && typeof ei.afterMs === 'number', J(ei));
    t.check('simulate input ends the running watch for that token (or real input already had)',
      si.endedInputWatch === true || realBefore === 1, J({ si, realBefore }));
    if (realBefore) console.log('  note: real input ended token 6 before the simulated one');
    const sti3 = await s.call('unfold.state', {}, 4000);
    t.check('state: no input watch after the simulated input', sti3.input.on === false, J(sti3.input));
    await s.call('unfold.input', { on: true, token: 7, maxMs: 60000 }, 4000);
    const so = await s.call('unfold.simulate', { what: 'input', token: 8 }, 4000);
    const sti4 = await s.call('unfold.state', {}, 4000);
    t.check('simulate input for ANOTHER token leaves the running watch alone',
      so.endedInputWatch === false && (sti4.input.on === true && sti4.input.token === 7 || forToken(7).length === 1), J({ so, input: sti4.input }));
    await s.call('unfold.input', { on: false }, 4000);

    const bad1 = await s.send('unfold.simulate', { what: 'nope' }, 4000);
    t.check('simulate with an unknown what is a plain-words error', bad1.ok === false && /display, lid, input, suspend or resume/.test(bad1.error || ''), J(bad1));
    const bad2 = await s.send('unfold.simulate', { what: 'display', state: 'bright' }, 4000);
    t.check('simulate display with a bad state is a plain-words error', bad2.ok === false && /on, off or dim/.test(bad2.error || ''), J(bad2));
    const bad3 = await s.send('unfold.simulate', { what: 'input' }, 4000);
    t.check('simulate input with no token and no watch is a plain-words error', bad3.ok === false && /token/.test(bad3.error || ''), J(bad3));

    // ---- watch off
    const wo = await s.call('unfold.watch', { on: false }, 4000);
    t.check('watch off -> watching false, nothing registered, no display/lid', wo.watching === false &&
      Array.isArray(wo.registered) && wo.registered.length === 0 && wo.display === null && wo.lid === null, J(wo));
    const nBefore = uf().length;
    await T.sleep(800);
    t.check('no unfold events after watch off', uf().length === nBefore, J(uf().slice(nBefore)));
    const wo2 = await s.call('unfold.watch', { on: false }, 4000);
    t.check('watch off again is idempotent', wo2.watching === false, J(wo2));

    // re-arm after off: a fresh initial display event
    const n0 = uf().filter((e) => e.what === 'display' && e.initial).length;
    await s.call('unfold.watch', { on: true }, 4000);
    let again = null;
    try { again = await s.waitEvent('unfold', 3000, (e) => e.what === 'display' && e.initial && uf().indexOf(e) >= nBefore); } catch (e) { /* below */ }
    t.check('watch re-armed after off sends a fresh initial display event', !!again && uf().filter((e) => e.what === 'display' && e.initial).length === n0 + 1, J(again));
    await s.call('unfold.watch', { on: false }, 4000);

    const ping = await s.call('ping', {}, 4000);
    const cmds = (ping.features && ping.features.commands) || [];
    const probs = (ping.features && ping.features.problems) || [];
    t.check('ping lists the four unfold commands and no feature problem from Unfold',
      ['unfold.watch', 'unfold.input', 'unfold.state', 'unfold.simulate'].every((c) => cmds.includes(c)) &&
      !probs.some((p) => /Unfold/.test(p)), J({ probs, n: cmds.length }));
    t.check('nothing unparseable on stdout', s.events.filter((e) => e.ev === '__unparseable').length === 0);
  } catch (e) {
    t.fail('no exception', e.stack);
  } finally {
    await s.stop();
  }
  process.exit(t.summary());
})();

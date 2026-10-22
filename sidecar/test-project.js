'use strict';
/*
 * test-project.js - lane qstiles (2026-10-15): the sidecar half of Win+P and the new quick-settings tiles,
 * on a PASSIVE sidecar (it never hooks, never writes; every real change must answer the passive refusal).
 *   - sysdisplay.project: the preset, what Windows would take (SDC_VALIDATE only), displays connected
 *   - sysdisplay.topology dryRun: validated, nothing applied (the layout reads the same after)
 *   - sysdisplay.topology for real: refused (passive) - a test NEVER changes the user's display
 *   - sysnotify.dndGet, netair.get: read only; keys win+k allowed by name, refused by passive
 *   - the Win+P chord in the hook's KeyMachine (simulate): taken only when listed; Win+Shift/Ctrl/Alt+P
 *     and a plain P stay Windows'; Win+P, P with Win held is two events (Windows' cycling)
 *   node sidecar/test-project.js [--exe=<path>]
 */
const T = require('./test-lib');

const VK = { LWIN: 0x5B, LALT: 0xA4, LSHIFT: 0xA0, LCTRL: 0xA2, P: 0x50 };
const kv = (vk, down, o) => Object.assign({ vk, down }, o || {});
const words = (st) => {
  const head = st.swallow ? 'S' : st.dummy ? 'D' : st.ignored ? 'I' : 'P';
  if (st.event === 'none') return head;
  return `${head} ${st.event}${st.chord ? ':' + st.chord : ''}`;
};

(async () => {
  const t = T.checker('PROJECT SIDECAR');
  const s = await T.startPassive();
  try {
    const t0 = Date.now();
    const pj = await s.send('sysdisplay.project', {}, 6000);
    const ms = Date.now() - t0;
    const x = pj.ok ? pj.result : {};
    t.check('sysdisplay.project answers', pj.ok && x.ok === true, JSON.stringify(pj).slice(0, 300));
    t.check('it names the current layout', ['internal', 'clone', 'extend', 'external', 'custom'].includes(x.current), x.current);
    t.check('it lists what Windows would take (a subset of the four)', Array.isArray(x.available) && x.available.every((m) => ['internal', 'clone', 'extend', 'external'].includes(m)), x.available);
    t.check('it counts the connected displays', typeof x.connected === 'number' && x.connected >= 1, x.connected);
    t.check('no change is waiting', x.pending === null || x.pending === undefined, x.pending);
    t.check(`it is quick enough to sit behind a key (${ms} ms round trip, budget 300)`, ms <= 300, ms);
    console.log(`  read: current=${x.current} available=${JSON.stringify(x.available)} connected=${x.connected} in ${ms} ms`);

    const other = x.current === 'extend' ? 'clone' : 'extend';
    const dry = await s.send('sysdisplay.topology', { mode: other, dryRun: true, keepWithinMs: 15000 }, 6000);
    t.check('a dry run validates and says how it would come back', dry.ok && dry.result.dryRun === true && dry.result.validatedBy === 'SetDisplayConfig SDC_VALIDATE' && dry.result.keepWithinMs === 15000 && Array.isArray(dry.result.revert), JSON.stringify(dry).slice(0, 300));
    const again = await s.send('sysdisplay.project', {}, 6000);
    t.check('after the dry run the layout is unchanged', again.ok && again.result.current === x.current && again.result.pending == null, again.ok && again.result.current);
    const real = await s.send('sysdisplay.topology', { mode: other, keepWithinMs: 15000 }, 6000);
    t.check('a REAL change is refused by the passive sidecar (tests never switch the display)', real.ok === false && /passive/i.test(real.error), JSON.stringify(real).slice(0, 200));
    const bad = await s.send('sysdisplay.topology', { mode: 'sideways', dryRun: true }, 4000);
    t.check('an unknown mode is refused in words', bad.ok === false && /extend, clone, internal or external/.test(bad.error), bad.error);

    const dnd = await s.send('sysnotify.dndGet', {}, 6000);
    t.check('sysnotify.dndGet reads Do not disturb', dnd.ok && (dnd.result.on === true || dnd.result.on === false || (dnd.result.ok === false && !!dnd.result.reason)), JSON.stringify(dnd).slice(0, 200));
    const dw = await s.send('sysnotify.dnd', { on: !(dnd.ok && dnd.result.on), dryRun: true }, 6000);
    t.check('the Do not disturb switch dry-runs', dw.ok && dw.result.dryRun === true, JSON.stringify(dw).slice(0, 200));
    const air = await s.send('netair.get', {}, 8000);
    t.check('netair.get reads airplane mode', air.ok && 'airplane' in air.result && 'canSet' in air.result, JSON.stringify(air).slice(0, 200));
    const aw = await s.send('netair.set', { on: !(air.ok && air.result.airplane), dryRun: true }, 8000);
    t.check('the airplane switch dry-runs', aw.ok && aw.result.dryRun === true, JSON.stringify(aw).slice(0, 200));
    const k = await s.send('keys', { combo: 'win+k' }, 4000);
    t.check('keys win+k is allowed by name, then refused by passive (no key pressed)', k.ok === false && /passive/i.test(k.error), k.error);
    const kx = await s.send('keys', { combo: 'win+l' }, 4000);
    t.check('keys win+l is still not allowed', kx.ok === false && /not allowed/.test(kx.error), kx.error);

    // ---- the chord ----
    const sim = async (name, opts, events, want) => {
      const r = await s.send('hotkey', Object.assign({ op: 'simulate', events }, opts), 4000);
      if (!r.ok) { t.check(name, false, r.error); return; }
      const got = r.result.steps.map(words);
      t.check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    };
    const winD = kv(VK.LWIN, true), winU = kv(VK.LWIN, false), w = { win: true };
    const ALL = ['Win+S', 'Win+V', 'Win+Tab', 'Win+I', 'Win+E', 'Win+R', 'Win+X', 'Win+G', 'Win+P', 'Win+.', 'Win+;'];
    const unknown = await s.send('hotkey', { chords: ['Win+Q'] }, 4000);
    t.check('the protocol knows Win+P', unknown.ok === false && /Win\+P\b/.test(unknown.error), unknown.error);
    const refused = await s.send('hotkey', { chords: ['Win+P'] }, 4000);
    t.check('passive refuses to take it (never hooks)', refused.ok === false && /passive/.test(refused.error), refused.error);
    await sim('Win+P is taken when on; the Win-up gets the partner key', { chords: ['Win+P'] }, [winD, kv(VK.P, true, w), kv(VK.P, false, w), winU], ['P', 'S chord:Win+P', 'S', 'D']);
    await sim('Win+P, P with Win held = two events (Windows\' cycling)', { chords: ALL },
      [winD, kv(VK.P, true, w), kv(VK.P, false, w), kv(VK.P, true, w), kv(VK.P, false, w), winU], ['P', 'S chord:Win+P', 'S', 'S chord:Win+P', 'S', 'D']);
    await sim('a held Win+P is one event', { chords: ['Win+P'] }, [winD, kv(VK.P, true, w), kv(VK.P, true, w), kv(VK.P, false, w), winU], ['P', 'S chord:Win+P', 'S', 'S', 'D']);
    await sim('Win+P is Windows\' own when not listed (off, unhealthy, resting)', { chords: ['Win+S'] }, [winD, kv(VK.P, true, w), kv(VK.P, false, w), winU], ['P', 'P', 'P', 'P']);
    await sim('Win+Shift+P stays Windows\'', { chords: ALL },
      [winD, kv(VK.LSHIFT, true, w), kv(VK.P, true, { win: true, shift: true }), kv(VK.P, false, { win: true, shift: true }), kv(VK.LSHIFT, false, w), winU], ['P', 'P', 'P', 'P', 'P', 'P']);
    await sim('Win+Ctrl+P stays Windows\'', { chords: ALL },
      [kv(VK.LCTRL, true), winD, kv(VK.P, true, { win: true, ctrl: true }), kv(VK.P, false, { win: true, ctrl: true }), winU, kv(VK.LCTRL, false)], ['P', 'P', 'P', 'P', 'P', 'P']);
    await sim('a plain P is just a letter', { chords: ALL }, [kv(VK.P, true), kv(VK.P, false)], ['P', 'P']);
  } catch (e) {
    t.check('no crash', false, e && e.stack || String(e));
  } finally {
    await s.stop();
  }
  process.exit(t.summary());
})();

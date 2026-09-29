// test-settings-chord.js - Win+I, Mantle Settings' chord (lane settings, 2026-09-28), through the
// PURE key machine (`hotkey {op:'simulate'}`): no real keystroke, no hook (passive sidecar). A plain
// Win chord like Win+V: the Win-up gets the partner key (0xFF) so Start stays shut, and EXACTLY
// Win+I: Win+Shift+I, Win+Ctrl+I and Win+Alt+I stay Windows'.
//
//   MANTLE_SIDECAR_EXE=<scratch exe> node sidecar/test-settings-chord.js
//
// Step words (as sidecar/test-sidecar.js): S = swallowed, D = partner key before it, P = passed.
'use strict';
const T = require('./test-lib');

const VK = { LWIN: 0x5B, LALT: 0xA4, LSHIFT: 0xA0, LCTRL: 0xA2, I: 0x49, V: 0x56 };
const kv = (vk, down, o) => Object.assign({ vk, down }, o || {});
const words = (st) => {
  const head = st.swallow ? 'S' : st.dummy ? 'D' : st.ignored ? 'I' : 'P';
  if (st.event === 'none') return head;
  return `${head} ${st.event}${st.chord ? ':' + st.chord : ''}`;
};

(async () => {
  const t = T.checker('SETTINGS CHORD');
  const s = await T.startPassive();
  try {
    const sim = async (name, opts, events, want) => {
      const r = await s.send('hotkey', Object.assign({ op: 'simulate', events }, opts), 4000);
      if (!r.ok) { t.check(name, false, r.error); return; }
      const got = r.result.steps.map(words);
      t.check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    };
    const winD = kv(VK.LWIN, true), winU = kv(VK.LWIN, false);
    const w = { win: true };
    const ALL = ['Win+S', 'Win+V', 'Win+Tab', 'Win+Alt+T', 'Win+Ctrl+T', 'Win+Alt+N', 'Win+I'];

    const unknown = await s.send('hotkey', { chords: ['Win+Q'] }, 4000);
    t.check('the protocol knows Win+I (an unknown chord error lists it)', unknown.ok === false && /Win\+I\b/.test(unknown.error), JSON.stringify(unknown));
    const refused = await s.send('hotkey', { chords: ['Win+I'] }, 4000);
    t.check('passive refuses to take Win+I (never hooks)', refused.ok === false && /passive/.test(refused.error), JSON.stringify(refused));

    await sim('Win+I is taken when on; the Win-up gets the partner key (Start stays shut)', { chords: ['Win+I'] },
      [winD, kv(VK.I, true, w), kv(VK.I, false, w), winU], ['P', 'S chord:Win+I', 'S', 'D']);
    await sim('Win+I is taken with every other chord on beside it', { chords: ALL },
      [winD, kv(VK.I, true, w), kv(VK.I, false, w), winU], ['P', 'S chord:Win+I', 'S', 'D']);
    await sim('a held Win+I is one event (auto-repeat swallowed silently)', { chords: ['Win+I'] },
      [winD, kv(VK.I, true, w), kv(VK.I, true, w), kv(VK.I, true, w), kv(VK.I, false, w), winU], ['P', 'S chord:Win+I', 'S', 'S', 'S', 'D']);
    await sim('Win+I, I (released and pressed again with Win held) is a second event', { chords: ['Win+I'] },
      [winD, kv(VK.I, true, w), kv(VK.I, false, w), kv(VK.I, true, w), kv(VK.I, false, w), winU], ['P', 'S chord:Win+I', 'S', 'S chord:Win+I', 'S', 'D']);
    await sim("Win+I is Windows' own when off", { chords: ['Win+S', 'Win+V'] },
      [winD, kv(VK.I, true, w), kv(VK.I, false, w), winU], ['P', 'P', 'P', 'P']);
    await sim("Win+Shift+I stays Windows'", { chords: ALL },
      [winD, kv(VK.LSHIFT, true, w), kv(VK.I, true, { win: true, shift: true }), kv(VK.I, false, { win: true, shift: true }), kv(VK.LSHIFT, false, w), winU],
      ['P', 'P', 'P', 'P', 'P', 'P']);
    await sim("Win+Ctrl+I stays Windows'", { chords: ALL },
      [kv(VK.LCTRL, true), winD, kv(VK.I, true, { win: true, ctrl: true }), kv(VK.I, false, { win: true, ctrl: true }), winU, kv(VK.LCTRL, false)],
      ['P', 'P', 'P', 'P', 'P', 'P']);
    await sim("Win+Alt+I stays Windows'", { chords: ALL, altTab: false },
      [winD, kv(VK.LALT, true, w), kv(VK.I, true, { win: true, alt: true }), kv(VK.I, false, { win: true, alt: true }), kv(VK.LALT, false, w), winU],
      ['P', 'P', 'P', 'P', 'P', 'P']);
    await sim('a plain I while Win+I is on is just an I', { chords: ALL }, [kv(VK.I, true), kv(VK.I, false)], ['P', 'P']);
    await sim('an I held BEFORE Win stays Windows\' to its keyup', { chords: ['Win+I'] },
      [kv(VK.I, true), winD, kv(VK.I, false, w), winU], ['P', 'P', 'P', 'P']);
    await sim('Win+V still is the clipboard\'s with Win+I on beside it', { chords: ALL },
      [winD, kv(VK.V, true, w), kv(VK.V, false, w), winU], ['P', 'S chord:Win+V', 'S', 'D']);
  } catch (e) {
    t.check('the run finished', false, e.stack || e.message);
  } finally {
    await s.stop();
  }
  process.exit(t.summary());
})();

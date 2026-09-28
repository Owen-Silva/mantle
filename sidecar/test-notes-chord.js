// test-notes-chord.js - Win+Alt+N, the quick notes pad's chord (lane tbtools, 2026-09-27), through
// the PURE key machine (`hotkey {op:'simulate'}`): no real keystroke, no hook (passive sidecar).
// It is taken exactly like Win+Alt+T: Win and Alt both get the partner key (0xFF) before their keyup.
//
//   MANTLE_SIDECAR_EXE=<scratch exe> node sidecar/test-notes-chord.js
//
// Step words (as sidecar/test-sidecar.js): S = swallowed, D = partner key before it, P = passed.
'use strict';
const T = require('./test-lib');

const VK = { LWIN: 0x5B, LALT: 0xA4, LSHIFT: 0xA0, LCTRL: 0xA2, N: 0x4E, T: 0x54 };
const kv = (vk, down, o) => Object.assign({ vk, down }, o || {});
const words = (st) => {
  const head = st.swallow ? 'S' : st.dummy ? 'D' : st.ignored ? 'I' : 'P';
  if (st.event === 'none') return head;
  return `${head} ${st.event}${st.chord ? ':' + st.chord : ''}`;
};

(async () => {
  const t = T.checker('NOTES CHORD');
  const s = await T.startPassive();
  try {
    const sim = async (name, opts, events, want) => {
      const r = await s.send('hotkey', Object.assign({ op: 'simulate', events }, opts), 4000);
      if (!r.ok) { t.check(name, false, r.error); return; }
      const got = r.result.steps.map(words);
      t.check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    };
    const winD = kv(VK.LWIN, true), winU = kv(VK.LWIN, false), altD = kv(VK.LALT, true), altU = kv(VK.LALT, false);
    const wa = { win: true, alt: true };
    const ALL = ['Win+S', 'Win+V', 'Win+Tab', 'Win+Alt+T', 'Win+Ctrl+T', 'Win+Alt+N'];

    const unknown = await s.send('hotkey', { chords: ['Win+Alt+Q'] }, 4000);
    t.check('the protocol knows Win+Alt+N (an unknown chord error lists it)', unknown.ok === false && /Win\+Alt\+N/.test(unknown.error), JSON.stringify(unknown));
    const refused = await s.send('hotkey', { chords: ['Win+Alt+N'] }, 4000);
    t.check('passive refuses to take Win+Alt+N (never hooks)', refused.ok === false && /passive/.test(refused.error), JSON.stringify(refused));

    await sim('Win+Alt+N is taken when on (Win first); Alt-up and Win-up both get the partner key', { chords: ['Win+Alt+N'] },
      [winD, altD, kv(VK.N, true, wa), kv(VK.N, false, wa), altU, winU], ['P', 'P', 'S chord:Win+Alt+N', 'S', 'D', 'D']);
    await sim('Win+Alt+N is taken when on (Alt first), with other chords on', { chords: ALL },
      [altD, winD, kv(VK.N, true, wa), kv(VK.N, false, wa), winU, altU], ['P', 'P', 'S chord:Win+Alt+N', 'S', 'D', 'D']);
    await sim('a held Win+Alt+N is one event (auto-repeat swallowed silently)', { chords: ['Win+Alt+N'] },
      [winD, altD, kv(VK.N, true, wa), kv(VK.N, true, wa), kv(VK.N, true, wa), kv(VK.N, false, wa), altU, winU], ['P', 'P', 'S chord:Win+Alt+N', 'S', 'S', 'S', 'D', 'D']);
    await sim("Win+Alt+N is Windows' own when off", { chords: ['Win+S'] },
      [winD, altD, kv(VK.N, true, wa), kv(VK.N, false, wa), altU, winU], ['P', 'P', 'P', 'P', 'P', 'P']);
    await sim("Win+N (notifications) is not Win+Alt+N", { chords: ALL },
      [winD, kv(VK.N, true, { win: true }), kv(VK.N, false, { win: true }), winU], ['P', 'P', 'P', 'P']);
    await sim('Alt+N (an app menu key) is not Win+Alt+N', { chords: ALL, altTab: false },
      [altD, kv(VK.N, true, { alt: true }), kv(VK.N, false, { alt: true }), altU], ['P', 'P', 'P', 'P']);
    await sim('Ctrl+Win+Alt+N and Win+Alt+Shift+N are not Win+Alt+N', { chords: ALL, altTab: false },
      [kv(VK.LCTRL, true), winD, altD, kv(VK.N, true, Object.assign({ ctrl: true }, wa)), kv(VK.N, false, wa), altU, winU, kv(VK.LCTRL, false),
       winD, altD, kv(VK.LSHIFT, true), kv(VK.N, true, Object.assign({ shift: true }, wa)), kv(VK.N, false, wa), kv(VK.LSHIFT, false), altU, winU],
      ['P', 'P', 'P', 'P', 'P', 'P', 'P', 'P', 'P', 'P', 'P', 'P', 'P', 'P', 'P', 'P']);
    await sim('Win+Alt+T still is the top bar\'s with Win+Alt+N on beside it', { chords: ALL },
      [winD, altD, kv(VK.T, true, wa), kv(VK.T, false, wa), altU, winU], ['P', 'P', 'S chord:Win+Alt+T', 'S', 'D', 'D']);
    await sim('a plain N while Win+Alt+N is on is just an N', { chords: ALL }, [kv(VK.N, true), kv(VK.N, false)], ['P', 'P']);
  } catch (e) {
    t.check('the run finished', false, e.stack || e.message);
  } finally {
    await s.stop();
  }
  process.exit(t.summary());
})();

// test-taskmgr-chord.js - Ctrl+Shift+Esc, Mantle's task manager's chord (lane integrate, 2026-09-28),
// through the PURE key machine (`hotkey {op:'simulate'}`): no real keystroke, no hook (passive
// sidecar). The one chord with no Win: EXACTLY Ctrl+Shift held, so plain Esc, Ctrl+Esc (Start),
// Alt+Esc and Win+Ctrl+Shift+Esc stay Windows', and the Alt+Tab switcher's Esc still cancels it.
// Taken, the Ctrl-up gets the partner key (0xFF) like Win+Ctrl+T's.
//
//   MANTLE_SIDECAR_EXE=<scratch exe> node sidecar/test-taskmgr-chord.js
//
// Step words (as sidecar/test-sidecar.js): S = swallowed, D = partner key before it, P = passed.
'use strict';
const T = require('./test-lib');

const VK = { LWIN: 0x5B, LALT: 0xA4, LSHIFT: 0xA0, LCTRL: 0xA2, ESC: 0x1B, TAB: 0x09, T: 0x54 };
const kv = (vk, down, o) => Object.assign({ vk, down }, o || {});
const words = (st) => {
  const head = st.swallow ? 'S' : st.dummy ? 'D' : st.ignored ? 'I' : 'P';
  if (st.event === 'none') return head;
  return `${head} ${st.event}${st.chord ? ':' + st.chord : ''}`;
};

(async () => {
  const t = T.checker('TASKMGR CHORD');
  const s = await T.startPassive();
  try {
    const sim = async (name, opts, events, want) => {
      const r = await s.send('hotkey', Object.assign({ op: 'simulate', events }, opts), 4000);
      if (!r.ok) { t.check(name, false, r.error); return; }
      const got = r.result.steps.map(words);
      t.check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    };
    const cs = { ctrl: true, shift: true };
    const ctrlD = kv(VK.LCTRL, true), ctrlU = kv(VK.LCTRL, false);
    const shD = kv(VK.LSHIFT, true, { ctrl: true }), shU = kv(VK.LSHIFT, false, { ctrl: true });
    const ALL = ['Win+S', 'Win+V', 'Win+Tab', 'Win+Alt+T', 'Win+Ctrl+T', 'Win+Alt+N', 'Win+I', 'Ctrl+Shift+Esc'];

    const unknown = await s.send('hotkey', { chords: ['Ctrl+Esc'] }, 4000);
    t.check('the protocol knows Ctrl+Shift+Esc (an unknown chord error lists it)', unknown.ok === false && /Ctrl\+Shift\+Esc/.test(unknown.error), JSON.stringify(unknown));
    const refused = await s.send('hotkey', { chords: ['Ctrl+Shift+Esc'] }, 4000);
    t.check('passive refuses to take Ctrl+Shift+Esc (never hooks)', refused.ok === false && /passive/.test(refused.error), JSON.stringify(refused));

    await sim('Ctrl+Shift+Esc is taken when on; the Ctrl-up gets the partner key', { chords: ['Ctrl+Shift+Esc'] },
      [ctrlD, shD, kv(VK.ESC, true, cs), kv(VK.ESC, false, cs), shU, ctrlU], ['P', 'P', 'S chord:Ctrl+Shift+Esc', 'S', 'P', 'D']);
    await sim('Ctrl+Shift+Esc is taken with every other chord on beside it', { chords: ALL },
      [ctrlD, shD, kv(VK.ESC, true, cs), kv(VK.ESC, false, cs), shU, ctrlU], ['P', 'P', 'S chord:Ctrl+Shift+Esc', 'S', 'P', 'D']);
    await sim('a held Ctrl+Shift+Esc is one event (auto-repeat swallowed silently)', { chords: ['Ctrl+Shift+Esc'] },
      [ctrlD, shD, kv(VK.ESC, true, cs), kv(VK.ESC, true, cs), kv(VK.ESC, true, cs), kv(VK.ESC, false, cs), shU, ctrlU],
      ['P', 'P', 'S chord:Ctrl+Shift+Esc', 'S', 'S', 'S', 'P', 'D']);
    await sim("Ctrl+Shift+Esc is Windows' own when off", { chords: ['Win+S', 'Win+I'] },
      [ctrlD, shD, kv(VK.ESC, true, cs), kv(VK.ESC, false, cs), shU, ctrlU], ['P', 'P', 'P', 'P', 'P', 'P']);
    await sim("a plain Esc stays Windows'", { chords: ALL }, [kv(VK.ESC, true), kv(VK.ESC, false)], ['P', 'P']);
    await sim("Ctrl+Esc (Start) stays Windows'", { chords: ALL },
      [ctrlD, kv(VK.ESC, true, { ctrl: true }), kv(VK.ESC, false, { ctrl: true }), ctrlU], ['P', 'P', 'P', 'P']);
    await sim("Shift+Esc stays Windows'", { chords: ALL },
      [kv(VK.LSHIFT, true), kv(VK.ESC, true, { shift: true }), kv(VK.ESC, false, { shift: true }), kv(VK.LSHIFT, false)], ['P', 'P', 'P', 'P']);
    await sim("Alt+Esc (window cycling) stays Windows' (switcher off)", { chords: ALL, altTab: false },
      [kv(VK.LALT, true), kv(VK.ESC, true, { alt: true }), kv(VK.ESC, false, { alt: true }), kv(VK.LALT, false)], ['P', 'P', 'P', 'P']);
    await sim("Ctrl+Alt+Esc stays Windows'", { chords: ALL, altTab: false },
      [ctrlD, kv(VK.LALT, true, { ctrl: true }), kv(VK.ESC, true, { ctrl: true, alt: true }), kv(VK.ESC, false, { ctrl: true, alt: true }), kv(VK.LALT, false, { ctrl: true }), ctrlU],
      ['P', 'P', 'P', 'P', 'P', 'P']);
    await sim("Win+Ctrl+Shift+Esc stays Windows'", { chords: ALL },
      [kv(VK.LWIN, true), ctrlD, shD, kv(VK.ESC, true, { win: true, ctrl: true, shift: true }), kv(VK.ESC, false, { win: true, ctrl: true, shift: true }), shU, ctrlU, kv(VK.LWIN, false)],
      ['P', 'P', 'P', 'P', 'P', 'P', 'P', 'P']);
    // Alt+Tab open, then Esc: the switcher's cancel, exactly as without the chord (Esc swallowed, Alt-up gets the partner key).
    const alt = { alt: true };
    const wantCancel = ['P', 'S open', 'S', 'S cancel', 'S', 'D'];
    await sim('the Alt+Tab switcher: Esc still cancels it with Ctrl+Shift+Esc on', { chords: ALL },
      [kv(VK.LALT, true), kv(VK.TAB, true, alt), kv(VK.TAB, false, alt), kv(VK.ESC, true, alt), kv(VK.ESC, false, alt), kv(VK.LALT, false)], wantCancel);
    await sim('the Alt+Tab switcher: the same steps with the chord off (the control)', { chords: [] },
      [kv(VK.LALT, true), kv(VK.TAB, true, alt), kv(VK.TAB, false, alt), kv(VK.ESC, true, alt), kv(VK.ESC, false, alt), kv(VK.LALT, false)], wantCancel);
    await sim('an Esc held BEFORE Ctrl+Shift stays Windows\' to its keyup', { chords: ['Ctrl+Shift+Esc'] },
      [kv(VK.ESC, true), ctrlD, shD, kv(VK.ESC, true, cs), kv(VK.ESC, false, cs), shU, ctrlU], ['P', 'P', 'P', 'P', 'P', 'P', 'P']);
    await sim('Win+Ctrl+T still is keep-on-top\'s with Ctrl+Shift+Esc on beside it', { chords: ALL },
      [kv(VK.LWIN, true), kv(VK.LCTRL, true, { win: true }), kv(VK.T, true, { win: true, ctrl: true }), kv(VK.T, false, { win: true, ctrl: true }), kv(VK.LCTRL, false, { win: true }), kv(VK.LWIN, false)],
      ['P', 'P', 'S chord:Win+Ctrl+T', 'S', 'D', 'D']);
  } catch (e) {
    t.check('the run finished', false, e.stack || e.message);
  } finally {
    await s.stop();
  }
  process.exit(t.summary());
})();

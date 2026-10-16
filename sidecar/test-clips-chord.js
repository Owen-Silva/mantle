// test-clips-chord.js - Win+G (Mantle's Record panel, lane mantle-clips 2026-10-15) through the PURE key
// machine (`hotkey {op:'simulate'}`): no real keystroke, no hook (passive sidecar). A plain Win chord like
// Win+R: taken only when main lists it, the Win-up gets the partner key (0xFF) so Start stays shut, and
// EXACTLY Win+G: Win+Alt+G (Game Bar's "record what happened"), Win+Shift+G and Win+Ctrl+G stay Windows'.
// Also sidecar/Record.cs in passive mode: record.target answers, record.keys sends NOTHING to anything
// but a stand-in (and refuses a window that is not in front), clips.share refuses.
//
//   MANTLE_SIDECAR_EXE=<scratch exe> node sidecar/test-clips-chord.js
'use strict';
const T = require('./test-lib');

const VK = { LWIN: 0x5B, LALT: 0xA4, LSHIFT: 0xA0, LCTRL: 0xA2, G: 0x47, R: 0x52 };
const kv = (vk, down, o) => Object.assign({ vk, down }, o || {});
const words = (st) => {
  const head = st.swallow ? 'S' : st.dummy ? 'D' : st.ignored ? 'I' : 'P';
  if (st.event === 'none') return head;
  return `${head} ${st.event}${st.chord ? ':' + st.chord : ''}`;
};

(async () => {
  const t = T.checker('CLIPS CHORD');
  const s = await T.startPassive();
  try {
    const sim = async (name, opts, events, want) => {
      const r = await s.send('hotkey', Object.assign({ op: 'simulate', events }, opts), 4000);
      if (!r.ok) { t.check(name, false, r.error); return; }
      const got = r.result.steps.map(words);
      t.check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    };
    const winD = kv(VK.LWIN, true), winU = kv(VK.LWIN, false), w = { win: true };
    const ALL = ['Win+S', 'Win+V', 'Win+Tab', 'Win+Alt+T', 'Win+Ctrl+T', 'Win+Alt+N', 'Win+I', 'Win+E', 'Win+R', 'Win+X', 'Win+G', 'Win+P', 'Win+.', 'Win+;'];
    const unknown = await s.send('hotkey', { chords: ['Win+Q'] }, 4000);
    t.check('the protocol knows Win+G (an unknown chord error lists it)', unknown.ok === false && /Win\+G\b/.test(unknown.error), JSON.stringify(unknown));
    await sim('Win+G is taken when on; the Win-up gets the partner key (Start stays shut)', { chords: ['Win+G'] },
      [winD, kv(VK.G, true, w), kv(VK.G, false, w), winU], ['P', 'S chord:Win+G', 'S', 'D']);
    await sim('Win+G is taken with every other chord beside it', { chords: ALL },
      [winD, kv(VK.G, true, w), kv(VK.G, false, w), winU], ['P', 'S chord:Win+G', 'S', 'D']);
    await sim('a held Win+G is one event', { chords: ['Win+G'] },
      [winD, kv(VK.G, true, w), kv(VK.G, true, w), kv(VK.G, false, w), winU], ['P', 'S chord:Win+G', 'S', 'S', 'D']);
    await sim('Win+G is Windows\' own when main does not list it (off, keys handed back, main gone)', { chords: ['Win+R', 'Win+E'] },
      [winD, kv(VK.G, true, w), kv(VK.G, false, w), winU], ['P', 'P', 'P', 'P']);
    await sim('Win+Alt+G (Game Bar\'s record-what-happened) stays Windows\'', { chords: ALL, altTab: false },
      [winD, kv(VK.LALT, true, w), kv(VK.G, true, { win: true, alt: true }), kv(VK.G, false, { win: true, alt: true }), kv(VK.LALT, false, w), winU],
      ['P', 'P', 'P', 'P', 'P', 'P']);
    await sim('Win+Shift+G stays Windows\'', { chords: ALL },
      [winD, kv(VK.LSHIFT, true, w), kv(VK.G, true, { win: true, shift: true }), kv(VK.G, false, { win: true, shift: true }), kv(VK.LSHIFT, false, w), winU],
      ['P', 'P', 'P', 'P', 'P', 'P']);
    await sim('Win+Ctrl+G stays Windows\'', { chords: ALL },
      [kv(VK.LCTRL, true), winD, kv(VK.G, true, { win: true, ctrl: true }), kv(VK.G, false, { win: true, ctrl: true }), winU, kv(VK.LCTRL, false)],
      ['P', 'P', 'P', 'P', 'P', 'P']);
    await sim('Win+R still works beside Win+G (the table grew at its end)', { chords: ALL },
      [winD, kv(VK.R, true, w), kv(VK.R, false, w), winU], ['P', 'S chord:Win+R', 'S', 'D']);

    const tg = await s.send('record.target', {}, 4000);
    t.check('record.target answers the window in front with its full-screen state', tg.ok && 'hwnd' in tg.result && typeof tg.result.quns === 'number' && typeof tg.result.desktop === 'boolean', JSON.stringify(tg).slice(0, 300));
    const fgH = tg.ok ? tg.result.hwnd : '0';
    const k1 = await s.send('record.keys', { hwnd: fgH, dryRun: true }, 4000);
    t.check('record.keys dryRun says what it would press and presses nothing (or refuses with the reason)',
      (k1.ok && k1.result.sent === false && k1.result.would === 'Win+Alt+R') || (!k1.ok && /game|desktop|exclusive|no longer in front/.test(k1.error)), JSON.stringify(k1));
    const k2 = await s.send('record.keys', { hwnd: fgH }, 4000);
    t.check('a passive sidecar never presses Win+Alt+R for a real window', !k2.ok && /passive|game|desktop|exclusive|no longer in front/.test(k2.error), JSON.stringify(k2));
    const k3 = await s.send('record.keys', { hwnd: '123456' }, 4000);
    t.check('a window that is not in front gets no keys', !k3.ok && /no longer in front/.test(k3.error), JSON.stringify(k3));
    const k4 = await s.send('record.keys', { hwnd: fgH, standIn: 4 }, 4000);
    t.check('a stand-in pid that is not the window in front does not unlock it', !k4.ok, JSON.stringify(k4));
    const sh = await s.send('clips.share', { path: 'C:\\Windows\\win.ini' }, 4000);
    t.check('clips.share refuses in passive', !sh.ok && /passive/.test(sh.error), JSON.stringify(sh));
    const sh2 = await s.send('clips.share', { path: 'relative.mp4' }, 4000);
    t.check('clips.share needs an absolute path', !sh2.ok && /absolute/.test(sh2.error), JSON.stringify(sh2));
  } finally {
    await s.stop();
  }
  process.exit(t.summary());
})();

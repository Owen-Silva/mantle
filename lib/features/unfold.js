'use strict';
/*
 * unfold.js - the unfold on unlock, lid open and wake, and the full-screen cover other features ask for
 * (lane unfold-unlock, 2026-10-23). The user saw Apple's foldable open: the content holds still while
 * the screen opens around it from the hinge and comes into focus as it lands. Here, exactly that, in
 * ~0.7 s over a picture of the desktop, then the real desktop: the right half in place and lit up out
 * of black, the left half swinging open from the centre hinge, the content still in space, blurred per
 * pixel (sharp at the hinge, one smooth cubic gradient toward the moving edge, up to 72 px) and lightly
 * darkened after the blur, nearly neutral with a faint trace of Mantle indigo at the moving edge
 * (outlines stay readable). One version, no light/dark (it is the content itself). ui/unfold/unfold-page.js
 * says how (WebGL, with the simpler layer technique as a stated fallback).
 *
 * The decisions are in _unfold-core.js (read its header), the windows in _unfold-windows.js, the page in
 * ui/unfold/, the display/lid/sleep signals and the input watch in sidecar/Unfold.cs. The motion values
 * are the shared tokens in ui/shared/unfold.css (this lane owns them).
 *
 * The tray switch gates ONLY the unlock/wake effect. The screen cover (_unfold-bus.js) is provided for
 * as long as the feature is installed, switch on or off, and let go in stop() and on a game rest.
 *
 * MEASURED 2026-10-23 on this laptop (Iris Xe, 1536x864 DIP at 125 %, vsync 16.67 ms):
 *   ui/unfold/pace.js (hidden window, 6 plays each, a park after every play as main does):
 *     gl     first play (after 3 s parked)  43 frames, p95 17.1 ms, max 17.1 ms, 0 dropped, prep 123 ms
 *            warm plays (5)                 p95 median 17.1 ms, max 17.7 ms, 0 dropped, prep median 58 ms
 *            load-time warm-up 88 ms (programs built and run once at full size)
 *     layers first play 0 dropped, prep 229 ms; warm 0 dropped, max 19.7 ms, prep median 10 ms
 *   in situ (unfold.e2e.test.js, real sidecar picture, real overlay window, free RAM down to 2.9 GB):
 *     first unlock (gl): 42 frames, p95 16.8 ms, 0 dropped, picture 222 ms, prep 177 ms
 *     gl x5 dropped [5, 18, 0, 0, 8]; layers x5 dropped [12, 0, 1, 0, 0] in the same run
 *   Earlier (same bench): an animated full-screen filter: blur dropped 12 frames, max 132.8 ms.
 *
 * Commands: unfold.page (the overlay pages answer through it), unfold.status (Settings / the strip),
 * and in --test only unfold.test {op: 'fire'|'state'|'realInput'|'tech'|'strips'|'cover'|'reveal'|'option'}.
 */
const { createUnfold } = require('./_unfold-core.js');

module.exports = {
  name: 'unfold',
  label: 'Unfold on unlock and wake',
  defaultOn: true,
  chords: [],
  observe: [],
  rest: true,
  options: [
    { key: 'when', label: 'Play it', help: 'The screen opens from the centre and comes into focus; any key or mouse movement ends it at once', type: 'choice',
      choices: [{ value: 'unlock', label: 'Every unlock and wake' }, { value: 'wake', label: 'Only when I open the lid or wake it' }], default: 'unlock' },
  ],
  install(ctx, opts) {
    const o = opts || {};                     // tests: { electron, bus, pool, now, setTimeout, clearTimeout, reducedMotion, realInput }
    const electron = o.electron || require('electron');
    const raise = o.raise !== undefined ? o.raise : (ctx.flags && ctx.flags.test ? null : require('../raise'));
    const core = createUnfold(ctx, Object.assign({}, o, { electron, raise }));
    ctx.command('page', async (a) => core.page(a || {}));
    ctx.command('status', async () => core.status());
    if (ctx.flags && ctx.flags.test) {
      ctx.command('test', async (a) => {
        const x = a || {};
        switch (x.op) {
          case 'fire': return core.testApi.fire(x.what, x);
          case 'state': return core.testApi.state();
          case 'realInput': return { realInput: core.testApi.realInput(x.on) };
          case 'tech': return { tech: core.testApi.tech(x.tech) };
          case 'strips': return { strips: core.testApi.strips(x.n) };
          case 'cover': return core.cover({ from: x.from || 'test' });
          case 'reveal': return core.reveal({ from: x.from || 'test' });
          case 'option': return { ok: true, when: (ctx.settings.set('when', x.when), ctx.settings.get('when')) };
          default: return { ok: false, reason: `unknown test op ${x.op}` };
        }
      });
    }
    ctx.onEnabled((on) => core.onEnabled(on));
    core.start();
    return { stop(why) { core.stop(why); }, _core: core };
  },
};

'use strict';
/*
 * unfold.js - the unfold on unlock, lid open and wake, and the full-screen cover other features ask for
 * (lane unfold-unlock, 2026-10-23). The user saw Apple's foldable open: the content holds still while
 * the screen opens around it from the hinge, blurred and stretched a little, and comes into focus as it
 * lands. Here: after an unlock or a wake, Mantle's glass parts at a centre seam and the desktop comes
 * into focus in ~0.7 s, then the real desktop. Subtle, neutral, Mantle's own glass and curves.
 *
 * The decisions are in _unfold-core.js (read its header), the windows in _unfold-windows.js, the page in
 * ui/unfold/, the display/lid/sleep signals and the input watch in sidecar/Unfold.cs. The motion values
 * are the shared tokens in ui/shared/unfold.css (this lane owns them).
 *
 * The tray switch gates ONLY the unlock/wake effect. The screen cover (_unfold-bus.js) is provided for
 * as long as the feature is installed, switch on or off, and let go in stop() and on a game rest.
 *
 * MEASURED (ui/unfold/pace.js, a hidden window the size of this laptop's screen, 1536x864 DIP at 125 %,
 * on its Iris Xe iGPU; see the lane report for the full lines): the contract's first technique (clip-path
 * plus an animated filter: blur over one full-screen picture) against the one used here (transform and
 * opacity only over pre-blurred copies). Numbers are in the commit that tuned them.
 *
 * Commands: unfold.page (the overlay pages answer through it), unfold.status (Settings / the strip),
 * and in --test only unfold.test {op: 'fire'|'state'|'realInput'|'tech'|'cover'|'reveal'}.
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

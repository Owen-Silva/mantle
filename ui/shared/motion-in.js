/* motion-in.js - the shared pop-in trigger for a window that main shows and hides (lane mantle-motion,
 * 2026-10-16; the spec is design notes: motion-unison, the curves are glass-light.css --m-*).
 *
 * Puts html.m-shown on the frame AFTER the window comes on screen, and takes it off when the window
 * hides, so each surface's CSS can rest its pane in the "from" pose (a few px down, see-through) and
 * let html.m-shown play the bar's spring in. The launcher has done exactly this since 2026-09 (its
 * body.up); this is the same signal for the rest.
 *   - Electron fires visibilitychange on show and hide; that is the only signal needed, so main's
 *     show timing is untouched and nothing here waits on anything.
 *   - On the NEXT frame: the first paint has to be in the from pose or the transition has nothing to
 *     run from. A window never shown yet runs no frames, so its rAF fires on its first show.
 *   - A hidden window runs no frames: taking the class off while hidden snaps back with no cost, and
 *     nothing ticks at rest.
 * window.MantleMotionIn.replay() re-runs the entrance for a window that stays on screen. */
(function () {
  'use strict';
  var root = document.documentElement;
  var asked = false;
  function up() {
    if (asked) return;
    asked = true;
    requestAnimationFrame(function () {
      asked = false;
      if (document.visibilityState !== 'hidden') root.classList.add('m-shown');
    });
  }
  function down() { root.classList.remove('m-shown'); }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') down();
    else up();
  });
  if (document.visibilityState !== 'hidden') up();
  window.MantleMotionIn = {
    replay: function () { down(); void root.offsetWidth; up(); }
  };
})();

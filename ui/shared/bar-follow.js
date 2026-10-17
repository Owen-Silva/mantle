/* ui/shared/bar-follow.js - the PAGE half of "glides with the bar" (lane mantle-corner-follow, 2026-10-17;
 * lane mantle-corner's glide for the banners, moved here whole so every surface shares it: the banners, the
 * screenshot card, the volume pop-up, the Clips record panel). Main's half: lib/bar-follow.js.
 *
 * Owen: "this ... needs to go in the corner not up like this ... just have them smoothly move up if the
 * taskbar comes up". The window is placed as if the bar were not there; main sends <event> { px, kind, ms }
 * on the tick the bar's own page is told: px = how far above its low spot the surface rests now, kind 'up' =
 * the bar's spring (bar-follow.css .bar-follow.glide-up), 'down' = its exit. A CSS transition, as the bar's: a
 * reversal half-way goes back from where it is, the same way the bar's does, so the two stay together
 * through rapid toggles. ms 0, nothing on screen, or reduced motion: no travel, it is simply there (reduced
 * motion: a 120 ms fade-up of what is on screen).
 * Reduced motion (lane mantle-corner3): the bar's pill does not move then, it only fades where it rests
 * (ui/bar/bar.css), so a surface jumping DOWN at once would sit on the fading pill. It waits out the bar's
 * fade (the ms main sends for a down is longer than it) and then jumps; up jumps at once (out of the way).
 *
 *   <link rel="stylesheet" href="../shared/bar-follow.css">
 *   <script src="../shared/bar-follow.js"></script>
 *   var follow = MantleBarFollow.attach(el, { event: 'osd.lift', shown: function () { return true; },
 *                                              backdrop: 'the pop-up glided with the bar' });   // HUDs: see reshoot
 *   follow.glide(p) / follow.lift()
 * `el` must carry no transform of its own (put it on a wrapper): the follow owns el's transform.
 */
(function () {
  'use strict';
  function attach(el, o) {
    o = o || {};
    var reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    var lift = 0, waitT = null;
    el.classList.add('bar-follow');
    function shown() { return o.shown ? !!o.shown() : true; }
    function glide(p) {
      clearTimeout(waitT); waitT = null;
      var px = Math.max(0, Math.round(Number(p && p.px) || 0));
      var ms = Math.max(0, Math.round(Number(p && p.ms) || 0));
      var on = shown();
      if (reduced && on && ms && px < lift) { waitT = setTimeout(function () { waitT = null; glide({ px: px, kind: p.kind, ms: 0 }); }, ms); return; }
      var still = !ms || reduced || !on;
      el.classList.toggle('glide-up', !!(p && p.kind === 'up'));
      if (still) el.classList.add('still');
      else el.style.setProperty('--glide-ms', ms + 'ms');
      el.style.setProperty('--lift', px + 'px');
      if (still) {
        void el.offsetWidth;   // commit the jump before transitions come back on
        el.classList.remove('still');
        if (reduced && on && px !== lift && el.animate) el.animate([{ opacity: 0.5 }, { opacity: 1 }], { duration: 120, easing: 'linear' });
      }
      var moved = px !== lift;
      lift = px;
      if (moved && o.backdrop) reshoot(ms);
      if (o.onGlide) { try { o.onGlide(px, ms); } catch (_) { /* the page's own hook never stops the glide */ } }
    }
    /* DARK: a HUD's baked backdrop (ui/shared/hud-backdrop.js) is drawn for where the pane was when it was baked,
       and a shot taken with the bar up has the pill in it. So once a glide that MOVED the pane has landed, ask for
       ONE fresh picture (no hold: the old one stays up until the new one is baked). A stand where it already is
       keeps a picture already asked for. Light: nothing to bake. During the glide itself (<= 336 ms) the old
       picture rides with the pane. o.backdrop = the reason main logs. */
    var reshootT = 0;
    function reshoot(ms) {
      clearTimeout(reshootT); reshootT = 0;
      var H = window.MantleHudBackdrop;
      if (!H || !shown() || document.documentElement.getAttribute('data-theme') !== 'dark') return;
      reshootT = setTimeout(function () { reshootT = 0; if (shown()) H.request(o.backdrop); }, ms + 60);
    }
    if (o.event && window.mantle && typeof window.mantle.on === 'function') window.mantle.on(o.event, glide);
    return { glide: glide, lift: function () { return lift; } };
  }
  window.MantleBarFollow = { attach: attach };
}());

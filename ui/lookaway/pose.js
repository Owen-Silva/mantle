'use strict';
/*
 * pose.js - which way a head points, from what MediaPipe hands back (lane lookaway, 2026-10-23).
 * Pure: no DOM, no camera. Loaded by the hidden detector page AND required by node tests.
 *
 *   fromKeypoints(kp)    the face detector's six keypoints (normalised x/y: right eye, left eye,
 *                        nose tip, mouth, right ear, left ear) -> { yaw, pitch } in rough degrees
 *
 * The signs and zero points do not matter to Mantle: the decision (lib/features/_lookaway-core.js)
 * only compares a pose with the user's OWN usual pose (calibrated), with a wrap-safe difference.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LookawayPose = api;
}(typeof self !== 'undefined' ? self : this, () => {
  const DEG = 180 / Math.PI;

  /*
   * Six points are not a head model, so this is a proxy that is monotonic in the real angles over
   * the range that matters (0 to ~60 degrees), scaled so that it reads roughly like degrees:
   *   yaw   = how far the nose sits from the middle of the eyes, against the eye distance
   *           (a frontal face has the nose in the middle; turned 45 degrees it is ~half an eye
   *           distance off). Ear points are used when both are there: the nearer ear's distance
   *           shrinks as the head turns.
   *   pitch = where the nose sits between the eye line and the mouth (tilting down moves it).
   */
  function fromKeypoints(kp) {
    if (!Array.isArray(kp) || kp.length < 4) return null;
    const [re, le, nose, mouth] = kp;
    const mx = (re.x + le.x) / 2, my = (re.y + le.y) / 2;
    const eyeDist = Math.hypot(le.x - re.x, le.y - re.y);
    if (!(eyeDist > 1e-4)) return null;
    let off = (nose.x - mx) / eyeDist;
    if (kp.length >= 6) {
      const dr = Math.abs(nose.x - kp[4].x), dl = Math.abs(kp[5].x - nose.x);
      if (dr + dl > 1e-4) off = (off + (dl - dr) / (dl + dr)) / 2;
    }
    const yaw = Math.asin(Math.max(-1, Math.min(1, off * 1.4))) * DEG;
    const span = mouth.y - my;
    const pitch = span > 1e-4 ? ((nose.y - my) / span - 0.55) * 120 : 0;
    if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) return null;
    return { yaw, pitch };
  }

  return { fromKeypoints };
}));

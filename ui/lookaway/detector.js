'use strict';
/*
 * detector.js - the hidden look-away page (lane lookaway, 2026-10-23).
 *
 * Main (lib/features/lookaway.js) drives it with ONE event, 'lookaway.ctl':
 *   { op: 'start', width, height, fps, hz }   open the camera (fps: what to ask it for, 10 by default) and start looking
 *   { op: 'rate', hz }                   how many frames a second to look at
 *   { op: 'stop', why }                  stop every camera track (light off)
 *   { op: 'stats' }                      how many frames came and were looked at, and how long each took
 * and hears back through two commands:
 *   lookaway.seen  { t, face, score, yaw, pitch, size, ms }   one per frame looked at
 *   lookaway.page  { state: loaded|loading|ready|watching|stopped|failed|stats, reason, ... }
 *
 * The model is MediaPipe's BlazeFace short range (face detector, CPU delegate), chosen by measurement on
 * the i3-1215U: 7 ms a frame, about 4% of one core at 4 looks a second. With several faces in the
 * frame the LARGEST is his (someone behind him is smaller). A detection only counts as a face when its
 * six keypoints sit like a face's (see plausible()): Chromium's fake camera pattern and other round
 * shapes otherwise read as one.
 *
 * PRIVACY: a frame lives only inside this function for the few milliseconds the model needs, then
 * it is closed. Nothing is drawn, copied to a canvas, saved, logged or sent: main only ever gets the
 * numbers above. The page's Content-Security-Policy allows no network at all, and main gives this
 * window its own in-memory session that cancels any web request and grants the camera to it alone.
 */
(() => {
  const M = window.mantle;
  const V = window.Vision;
  const P = window.LookawayPose;
  const S = {
    task: null, loading: null,
    stream: null, track: null, reader: null, running: false, gen: 0,
    hz: 4, nextDue: 0, lastFrameAt: 0, frameGap: 0, lastTs: 0,
    stats: { frames: 0, looked: 0, rejected: 0, ms: [] },
  };

  const page = (state, reason, extra) => M.call('lookaway.page', Object.assign({ state, reason: reason || '' }, extra || {})).catch(() => {});

  function wasmBase() { return new URL('../../node_modules/@mediapipe/tasks-vision/wasm/', location.href).href; }

  async function load() {
    if (S.task) return S.task;
    if (!V) throw new Error('the face model runtime did not load (MediaPipe is missing from node_modules: run npm install)');
    const base = wasmBase();
    const fileset = { wasmLoaderPath: base + 'vision_wasm_internal.js', wasmBinaryPath: base + 'vision_wasm_internal.wasm' };
    page('loading');
    S.task = await V.FaceDetector.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: new URL('models/blaze_face_short_range.tflite', location.href).href, delegate: 'CPU' },
      runningMode: 'VIDEO', minDetectionConfidence: 0.5,
    });
    return S.task;
  }

  function plainCameraError(e) {
    const n = e && e.name;
    if (n === 'NotAllowedError' || n === 'SecurityError') return 'Windows or Mantle did not allow the camera (Settings > Privacy & security > Camera)';
    if (n === 'NotFoundError' || n === 'OverconstrainedError') return 'no camera was found';
    if (n === 'NotReadableError' || n === 'AbortError') return 'the camera would not start (another app may hold it, or its driver failed)';
    return 'the camera failed: ' + ((e && e.message) || String(e));
  }

  /** Every track of the stream stopped: Windows turns the camera light off. */
  function release() {
    S.running = false;
    S.gen++;
    try { if (S.reader) S.reader.cancel().catch(() => {}); } catch (_) { /* done */ }
    S.reader = null;
    if (S.stream) for (const t of S.stream.getTracks()) { try { t.stop(); } catch (_) { /* stopped */ } }
    const ended = !S.stream || S.stream.getTracks().every((t) => t.readyState === 'ended');
    S.stream = null; S.track = null;
    return ended;
  }

  /*
   * Does a detection sit like a real face? BlazeFace's keypoints (normalised x/y): right eye, left eye,
   * nose tip, mouth, right ear (tragion), left ear. Measured 2026-10-23 (lane lookaway, raw detections
   * on the fake camera; numbers are shares of the face box):
   *                         eyes apart   eye line tilt   nose below eyes   mouth below eyes   score
   *   real faces (3 people)  0.38-0.42     0-7 deg         0.21-0.31         0.43-0.47        0.85-0.96
   *   full profile           0.05          61 deg          0.24              0.47             0.85
   *   Chromium's pattern     0.21-0.39     6-35 deg        -0.08-0.13        0.18-0.37        0.5-0.76
   * The nose is what gives the pattern away: on a face the nose tip sits about a quarter of the box
   * below the eyes. The limits lean towards keeping real faces (a face thrown away blurs the screen
   * while he is looking at it): nose 0.15 still keeps a head tipped up about 20 degrees, which counts as
   * away by its tilt anyway. A full profile fails too (its eyes collapse), which is right: it is away.
   * With these limits the pattern went from a face in 61 of 97 frames to 0, and no real face was lost.
   */
  const LIMITS = { eyesApartMin: 0.15, tiltMax: 35, noseMin: 0.15, noseMax: 0.5, mouthMin: 0.3, mouthMax: 0.75 };
  function plausible(d, w, h) {
    const b = d.boundingBox, k = d.keypoints;
    if (!b || !k || k.length < 4 || !(b.width > 0 && b.height > 0)) return false;
    const px = (p) => ({ x: p.x * w, y: p.y * h });
    const re = px(k[0]), le = px(k[1]), no = px(k[2]), mo = px(k[3]);
    const eyeY = (re.y + le.y) / 2;
    const apart = Math.hypot(le.x - re.x, le.y - re.y) / b.width;
    const a = Math.abs(Math.atan2(le.y - re.y, le.x - re.x) * 180 / Math.PI);
    const tilt = Math.min(a, 180 - a);
    const nose = (no.y - eyeY) / b.height, mouth = (mo.y - eyeY) / b.height;
    return apart >= LIMITS.eyesApartMin && tilt <= LIMITS.tiltMax && nose >= LIMITS.noseMin && nose <= LIMITS.noseMax && mouth >= LIMITS.mouthMin && mouth <= LIMITS.mouthMax;
  }

  function observe(frame, ts) {
    const t0 = performance.now();
    const r = S.task.detectForVideo(frame, ts);
    const ms = performance.now() - t0;
    const w = frame.displayWidth, h = frame.displayHeight;
    const o = { t: Date.now(), face: false, score: 0, yaw: null, pitch: null, size: 0, ms: Math.round(ms * 10) / 10 };
    let best = null, area = 0;
    for (const d of (r && r.detections) || []) {
      if (!plausible(d, w, h)) { S.stats.rejected++; continue; }
      const a = d.boundingBox.width * d.boundingBox.height;
      if (a > area) { best = d; area = a; }
    }
    if (best) {
      o.face = true;
      o.score = best.categories && best.categories[0] ? best.categories[0].score : 0;
      o.size = h ? best.boundingBox.height / h : 0;
      const p = P.fromKeypoints(best.keypoints);
      if (p) { o.yaw = p.yaw; o.pitch = p.pitch; }
    }
    for (const k of ['yaw', 'pitch', 'size', 'score']) if (typeof o[k] === 'number') o[k] = Math.round(o[k] * 100) / 100;
    S.stats.looked++;
    S.stats.ms.push(ms);
    if (S.stats.ms.length > 200) S.stats.ms.shift();
    return o;
  }

  /*
   * A true `hz` schedule on a camera that sends frames at its own rate. A frame is looked at when it
   * is due within half a camera frame interval, and the due time then moves on by exactly one period,
   * so 4 a second on a 10 fps camera is 4 a second (the old "at least 1/hz since the last one" rule
   * gave 3.33: 0, 300, 600 ms). More than a period late (a stall) starts the schedule again from now
   * rather than catching up in a burst.
   */
  function due(now) {
    if (S.lastFrameAt) {
      const gap = Math.min(1000, Math.max(5, now - S.lastFrameAt));
      S.frameGap = S.frameGap ? S.frameGap * 0.8 + gap * 0.2 : gap;
    }
    S.lastFrameAt = now;
    const period = 1000 / Math.max(0.2, S.hz);
    const slack = Math.min(S.frameGap / 2, period / 2);
    if (now < S.nextDue - slack) return false;
    S.nextDue = now - S.nextDue > period ? now + period : S.nextDue + period;
    return true;
  }

  async function pump(gen) {
    while (S.running && gen === S.gen && S.reader) {
      let res;
      try { res = await S.reader.read(); } catch (e) { if (gen === S.gen) fail('the camera stream broke: ' + ((e && e.message) || e)); return; }
      if (gen !== S.gen) { if (res && res.value) res.value.close(); return; }
      if (res.done) { if (S.running) fail('the camera stopped sending frames'); return; }
      const frame = res.value;
      S.stats.frames++;
      const now = performance.now();
      if (!due(now)) { frame.close(); continue; }
      let ts = Math.round(now);
      if (ts <= S.lastTs) ts = S.lastTs + 1;
      S.lastTs = ts;
      let o = null;
      try { o = observe(frame, ts); } catch (e) { frame.close(); fail('the face model failed on a frame: ' + ((e && e.message) || e)); return; }
      frame.close();
      M.call('lookaway.seen', o).catch(() => {});
    }
  }

  function fail(reason, extra) {
    const ended = release();
    page('failed', reason, Object.assign({ released: ended }, extra || {}));
  }

  async function start(c) {
    if (S.running) return;
    const gen = ++S.gen;
    S.hz = Number(c.hz) > 0 ? Number(c.hz) : 4;
    try { await load(); } catch (e) {
      page('failed', 'the face model could not load: ' + ((e && e.message) || e));
      return;
    }
    if (gen !== S.gen) return;   // stopped while the model loaded
    page('ready');
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: {
        width: { ideal: c.width || 320, max: 640 }, height: { ideal: c.height || 240, max: 480 }, frameRate: { ideal: Number(c.fps) > 0 ? Number(c.fps) : 10, max: 15 },
      } });
    } catch (e) { page('failed', plainCameraError(e), { released: true }); return; }
    if (gen !== S.gen) { for (const t of stream.getTracks()) t.stop(); return; }   // stopped while the camera opened
    S.stream = stream;
    S.track = stream.getVideoTracks()[0];
    if (!S.track) { fail('the camera gave no video'); return; }
    S.track.addEventListener('ended', () => { if (S.running && S.track) fail('the camera was taken away (unplugged, or Windows stopped it)'); });
    if (typeof window.MediaStreamTrackProcessor !== 'function') { fail('this Electron cannot read camera frames (no MediaStreamTrackProcessor)'); return; }
    const proc = new window.MediaStreamTrackProcessor({ track: S.track, maxBufferSize: 1 });
    S.reader = proc.readable.getReader();
    S.running = true;
    S.nextDue = 0; S.lastFrameAt = 0; S.frameGap = 0;
    const st = S.track.getSettings ? S.track.getSettings() : {};
    page('watching', '', { width: st.width || 0, height: st.height || 0, fps: st.frameRate || 0 });
    pump(gen);
  }

  function stats() {
    const a = S.stats.ms.slice().sort((x, y) => x - y);
    const mean = a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
    return { frames: S.stats.frames, looked: S.stats.looked, rejected: S.stats.rejected, msMean: Math.round(mean * 10) / 10, msP95: a.length ? Math.round(a[Math.floor(a.length * 0.95)] * 10) / 10 : 0 };
  }

  M.on('lookaway.ctl', (c) => {
    if (!c || typeof c.op !== 'string') return;
    if (c.op === 'start') start(c);
    else if (c.op === 'rate') { if (Number(c.hz) > 0) S.hz = Number(c.hz); }
    else if (c.op === 'stop') { const ended = release(); page('stopped', c.why || '', { released: ended, stats: stats() }); }
    else if (c.op === 'stats') page('stats', '', { running: S.running, stats: stats() });   // its own state: 'watching' would restart main's clock
  });
  window.addEventListener('pagehide', release);
  page('loaded');
})();

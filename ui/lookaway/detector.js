'use strict';
/*
 * detector.js - the hidden look-away page (lane lookaway, 2026-10-23).
 *
 * Main (lib/features/lookaway.js) drives it with ONE event, 'lookaway.ctl':
 *   { op: 'start', model, delegate, width, height, hz }   open the camera and start looking
 *   { op: 'rate', hz }                                     how many frames a second to look at
 *   { op: 'stop', why }                                    stop every camera track (light off)
 * and hears back through two commands:
 *   lookaway.seen  { t, face, score, yaw, pitch, roll, size, ms }   one per frame looked at
 *   lookaway.page  { state: loading|ready|watching|stopped|failed, reason, stats }
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
    task: null, kind: '', delegate: '', loading: null,
    stream: null, track: null, reader: null, running: false, gen: 0,
    hz: 4, lastInfer: 0, lastTs: 0,
    stats: { frames: 0, looked: 0, ms: [] },
  };

  const page = (state, reason, extra) => M.call('lookaway.page', Object.assign({ state, reason: reason || '' }, extra || {})).catch(() => {});

  function wasmBase() { return new URL('../../node_modules/@mediapipe/tasks-vision/wasm/', location.href).href; }

  async function load(kind, delegate) {
    if (S.task && S.kind === kind && S.delegate === delegate) return S.task;
    if (S.task) { try { S.task.close(); } catch (_) { /* gone */ } S.task = null; }
    if (!V) throw new Error('the face model runtime did not load (MediaPipe is missing from node_modules: run npm install)');
    const base = wasmBase();
    const fileset = { wasmLoaderPath: base + 'vision_wasm_internal.js', wasmBinaryPath: base + 'vision_wasm_internal.wasm' };
    const model = new URL(kind === 'detector' ? 'models/blaze_face_short_range.tflite' : 'models/face_landmarker.task', location.href).href;
    const baseOptions = { modelAssetPath: model, delegate: delegate === 'GPU' ? 'GPU' : 'CPU' };
    page('loading');
    if (kind === 'detector') {
      S.task = await V.FaceDetector.createFromOptions(fileset, { baseOptions, runningMode: 'VIDEO', minDetectionConfidence: 0.5 });
    } else {
      S.task = await V.FaceLandmarker.createFromOptions(fileset, {
        baseOptions, runningMode: 'VIDEO', numFaces: 1,
        minFaceDetectionConfidence: 0.5, minFacePresenceConfidence: 0.5, minTrackingConfidence: 0.5,
        outputFaceBlendshapes: false, outputFacialTransformationMatrixes: true,
      });
    }
    S.kind = kind; S.delegate = delegate;
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

  function observe(frame, ts) {
    const t0 = performance.now();
    const r = S.task.detectForVideo(frame, ts);
    const ms = performance.now() - t0;
    const o = { t: Date.now(), face: false, score: 0, yaw: null, pitch: null, roll: null, size: 0, ms: Math.round(ms * 10) / 10 };
    if (S.kind === 'detector') {
      const d = r && r.detections && r.detections[0];
      if (d) {
        o.face = true;
        o.score = d.categories && d.categories[0] ? d.categories[0].score : 0;
        const box = d.boundingBox;
        o.size = box && frame.displayHeight ? box.height / frame.displayHeight : 0;
        const p = P.fromKeypoints(d.keypoints);
        if (p) { o.yaw = p.yaw; o.pitch = p.pitch; }
      }
    } else {
      const lm = r && r.faceLandmarks && r.faceLandmarks[0];
      if (lm && lm.length) {
        o.face = true;
        o.score = 1;
        let lo = 1, hi = 0;
        for (const pt of lm) { if (pt.y < lo) lo = pt.y; if (pt.y > hi) hi = pt.y; }
        o.size = Math.max(0, hi - lo);
        const m = r.facialTransformationMatrixes && r.facialTransformationMatrixes[0];
        const p = m && P.fromMatrix(m.data);
        if (p) { o.yaw = p.yaw; o.pitch = p.pitch; o.roll = p.roll; }
      }
    }
    for (const k of ['yaw', 'pitch', 'roll', 'size', 'score']) if (typeof o[k] === 'number') o[k] = Math.round(o[k] * 100) / 100;
    S.stats.looked++;
    S.stats.ms.push(ms);
    if (S.stats.ms.length > 200) S.stats.ms.shift();
    return o;
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
      if (now - S.lastInfer < 1000 / Math.max(0.2, S.hz) - 8) { frame.close(); continue; }
      S.lastInfer = now;
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
    try { await load(c.model === 'detector' ? 'detector' : 'landmarker', c.delegate === 'GPU' ? 'GPU' : 'CPU'); } catch (e) {
      page('failed', 'the face model could not load: ' + ((e && e.message) || e));
      return;
    }
    if (gen !== S.gen) return;   // stopped while the model loaded
    page('ready');
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: {
        width: { ideal: c.width || 320, max: 640 }, height: { ideal: c.height || 240, max: 480 }, frameRate: { ideal: 10, max: 15 },
      } });
    } catch (e) { page('failed', plainCameraError(e), { released: true }); return; }
    if (gen !== S.gen) { for (const t of stream.getTracks()) t.stop(); return; }   // stopped while the camera opened
    S.stream = stream;
    S.track = stream.getVideoTracks()[0];
    if (!S.track) { fail('the camera gave no video'); return; }
    S.track.addEventListener('ended', () => { if (S.running && S.track) fail('the camera was taken away (unplugged, or Windows stopped it)', { frames: S.stats.frames, looked: S.stats.looked }); });
    S.track.addEventListener('mute', () => page('debug', 'muted', { frames: S.stats.frames }));
    if (typeof window.MediaStreamTrackProcessor !== 'function') { fail('this Electron cannot read camera frames (no MediaStreamTrackProcessor)'); return; }
    const proc = new window.MediaStreamTrackProcessor({ track: S.track, maxBufferSize: 1 });
    S.reader = proc.readable.getReader();
    S.running = true;
    S.lastInfer = 0;
    const st = S.track.getSettings ? S.track.getSettings() : {};
    page('watching', '', { width: st.width || 0, height: st.height || 0, fps: st.frameRate || 0 });
    pump(gen);
  }

  function stats() {
    const a = S.stats.ms.slice().sort((x, y) => x - y);
    const mean = a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
    return { frames: S.stats.frames, looked: S.stats.looked, msMean: Math.round(mean * 10) / 10, msP95: a.length ? Math.round(a[Math.floor(a.length * 0.95)] * 10) / 10 : 0, model: S.kind, delegate: S.delegate };
  }

  M.on('lookaway.ctl', (c) => {
    if (!c || typeof c.op !== 'string') return;
    if (c.op === 'start') start(c);
    else if (c.op === 'rate') { if (Number(c.hz) > 0) S.hz = Number(c.hz); }
    else if (c.op === 'stop') { const ended = release(); page('stopped', c.why || '', { released: ended, stats: stats() }); }
    else if (c.op === 'stats') page(S.running ? 'watching' : 'stopped', '', { stats: stats() });
  });
  window.addEventListener('pagehide', release);
  page('loaded');
})();

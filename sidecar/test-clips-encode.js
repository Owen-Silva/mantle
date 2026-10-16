// test-clips-encode.js - Clips' trims on REAL encoder output (lane mantle-clips2, 2026-10-15).
// A passive sidecar (sidecar/ClipsEncode.cs) renders a stand-in movie with Windows' own H.264 encoder
// (clips.synth: two plain colours, nothing of Owen's), then:
//   - the LOSSLESS cut (lib/features/_clips-mp4.js) cuts it: keyframe start, same frames, a valid index;
//   - the RE-ENCODE trim (clips.reencode) makes a frame-exact part of it, never overwriting, with
//     clips.encoding progress and ONE clips.encoded at the end;
//   - the refusals: a path outside %TEMP% (passive), an existing name, an empty part, a file Windows
//     cannot read (said, and no .part left behind).
//   MANTLE_SIDECAR_EXE=<scratch exe> node sidecar/test-clips-encode.js   -> "CLIPS ENCODE: n passed, m failed"
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const T = require('./test-lib');
const M = require('../lib/features/_clips-mp4');

(async () => {
  const t = T.checker('CLIPS ENCODE');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clips-encode-'));
  const s = await T.startPassive();
  try {
    const src = path.join(dir, 'Mantle stand-in 2026-10-15 23-00-00.mp4');
    const syn = await s.send('clips.synth', { dst: src, ms: 6000, w: 640, h: 360 }, 90000);
    if (!t.check('clips.synth renders a stand-in movie with Windows\' encoder', syn.ok && fs.existsSync(src) && fs.statSync(src).size > 1000, JSON.stringify(syn))) return;
    console.log(`info: stand-in movie ${Math.round(fs.statSync(src).size / 1024)} KB in ${syn.result && syn.result.ms} ms`);
    const qi = await M.quickInfo(src);
    t.check('the stand-in is about 6 s at 640x360 (read from its index)', Math.abs(qi.durationMs - 6000) < 400 && qi.width === 640 && qi.height === 360, JSON.stringify(qi));

    // the lossless cut, on real H.264 from Windows' encoder
    const ll = path.join(dir, 'lossless.mp4');
    let r = null, err = null;
    try { r = await M.cut(src, ll, 1500, 4500); } catch (e) { err = e.message; }
    t.check('the lossless cut takes a real encoder\'s movie', !!r && fs.existsSync(ll), err || JSON.stringify(r));
    if (r) {
      const mv = await M.readMovie(ll);
      const v = mv.tracks.find((x) => x.handler === 'vide');
      t.check('... it starts on a keyframe at or before 1.5 s and ends at 4.5 s', r.startMs <= 1500 && r.endMs === 4500 && v && v.s.sync[0] === 1, JSON.stringify({ startMs: r.startMs, endMs: r.endMs }));
      t.check('... and its index says its own length', Math.abs(mv.mvhd.duration * 1000 / mv.mvhd.timescale - (r.endMs - r.startMs)) < 120, JSON.stringify(mv.mvhd));
    }

    // the re-encode, frame exact
    const re = path.join(dir, 'reencoded.mp4');
    const job = 'enc-' + Date.now();
    const st = await s.send('clips.reencode', { src, dst: re, startMs: 1200, endMs: 3700, job }, 8000);
    t.check('clips.reencode starts and answers at once', st.ok && st.result && st.result.started === true, JSON.stringify(st));
    const done = await s.waitEvent('clips.encoded', 120000, (e) => e.job === job);
    t.check('ONE clips.encoded ends it, ok', !!done && done.ok === true, JSON.stringify(done));
    if (done && done.ok) {
      console.log(`info: re-encoded 2.5 s in ${done.ms} ms (${Math.round(done.bytes / 1024)} KB)`);
      const q2 = await M.quickInfo(re);
      t.check('the re-encoded part is 2.5 s (frame exact, +-0.1 s)', Math.abs(q2.durationMs - 2500) <= 100, JSON.stringify(q2));
      t.check('... at the source\'s size', q2.width === 640 && q2.height === 360, JSON.stringify(q2));
      t.check('... and no .part file is left', !fs.existsSync(re + '.part'));
      const prog = s.events.filter((e) => e.ev === 'clips.encoding' && e.job === job);
      console.log(`info: ${prog.length} progress events`);
    }
    t.check('the source is untouched', (await M.quickInfo(src)).durationMs === qi.durationMs);

    // refusals
    const ex = await s.send('clips.reencode', { src, dst: re, startMs: 0, endMs: 1000, job: 'x1' }, 8000);
    t.check('never overwrites: an existing name is refused', !ex.ok && /already there/.test(ex.error), JSON.stringify(ex));
    const out = await s.send('clips.reencode', { src: 'C:\\Windows\\x.mp4', dst: 'C:\\Windows\\y.mp4', startMs: 0, endMs: 1000, job: 'x2' }, 8000);
    t.check('passive: a path outside %TEMP% is refused', !out.ok && /passive/.test(out.error), JSON.stringify(out));
    const emp = await s.send('clips.reencode', { src, dst: path.join(dir, 'e.mp4'), startMs: 2000, endMs: 2000, job: 'x3' }, 8000);
    t.check('an empty part is refused', !emp.ok && /empty/.test(emp.error), JSON.stringify(emp));
    const junk = path.join(dir, 'junk.mp4');
    fs.writeFileSync(junk, Buffer.alloc(4096, 7));
    const jd = path.join(dir, 'junk-cut.mp4');
    const j = await s.send('clips.reencode', { src: junk, dst: jd, startMs: 0, endMs: 1000, job: 'x4' }, 8000);
    const jdone = j.ok ? await s.waitEvent('clips.encoded', 60000, (e) => e.job === 'x4') : null;
    t.check('a file Windows cannot read fails with a reason, nothing left behind', (!j.ok || (jdone && jdone.ok === false && jdone.why)) && !fs.existsSync(jd) && !fs.existsSync(jd + '.part'),
      JSON.stringify({ j, jdone }));
    const sy = await s.send('clips.synth', { dst: 'C:\\Windows\\z.mp4', ms: 1000 }, 8000);
    t.check('clips.synth writes only under %TEMP%', !sy.ok && /TEMP/.test(sy.error), JSON.stringify(sy));
  } finally {
    await s.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  process.exit(t.summary());
})();

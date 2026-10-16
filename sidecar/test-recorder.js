'use strict';
/*
 * test-recorder.js - the screen recorder (sidecar/Recorder.cs, lane screenrec 2026-10-15) end to end, on a
 * STAND-IN window this test makes (Mantle.Sidecar.exe --rec-standin): placed wholly outside every monitor,
 * never activated, so nothing appears on Owen's screen and nothing of his is ever recorded. Every recording
 * runs with test:true, which the recorder itself enforces: window mode only, and only a window owned by the
 * stand-in's pid. Every file made is deleted at the end.
 *
 *   node sidecar/test-recorder.js            -> "RECORDER TEST: n passed, m failed"
 *   MANTLE_SIDECAR_EXE=<exe> to test another build; MANTLE_FFPROBE=<ffprobe.exe> for the independent check
 *   (else the Remotion copy in media-tools is used if present). --quick runs the 5 s window test only.
 */
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const EXE = process.env.MANTLE_SIDECAR_EXE ? path.resolve(process.env.MANTLE_SIDECAR_EXE) : path.join(__dirname, 'bin', 'Mantle.Sidecar.exe');
const FFPROBE = [process.env.MANTLE_FFPROBE, 'C:/Users/user/media-tools/video/node_modules/@remotion/compositor-win32-x64-msvc/ffprobe.exe'].find((p) => p && fs.existsSync(p)) || null;
const FFMPEG = FFPROBE ? path.join(path.dirname(FFPROBE), 'ffmpeg.exe') : null;
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mantle-rec-test-'));
const QUICK = process.argv.includes('--quick');

let passed = 0;
const failures = [];
const check = (name, ok, detail) => { if (ok) passed++; else failures.push(detail !== undefined ? `${name} (${String(detail).slice(0, 400)})` : name); return ok; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function lines(proc, onEvent) {
  let buf = '';
  proc.stdout.on('data', (d) => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!l) continue;
      try { onEvent(JSON.parse(l)); } catch (e) { onEvent({ ev: 'garbage', text: l }); }
    }
  });
}

async function standIn(w, h) {
  const p = spawn(EXE, ['--rec-standin', `--at=under,${w},${h}`, '--secs=90'], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  const info = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('the stand-in did not say its window within 10 s')), 10000);
    lines(p, (e) => { if (e.ev === 'standin') { clearTimeout(t); if (e.hidden === true) resolve(e); else reject(new Error('the stand-in would have been VISIBLE (at ' + e.at + '), so it closed itself and nothing was recorded')); } if (e.ev === 'standin-visible') console.log('  the stand-in came into view at ' + e.at + ' and closed itself'); });
    p.on('exit', (c) => { clearTimeout(t); reject(new Error(`the stand-in exited (${c})`)); });
  });
  info.proc = p;
  info.close = () => { try { p.stdin.write('close\n'); p.stdin.end(); } catch (e) { /* gone */ } };
  return info;
}

/** One recording: spec -> { events, ready, started, done, error, startMs, exitCode } */
function record(spec, o) {
  const opts = o || {};
  return new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn(EXE, ['--record'], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    const r = { events: [], startMs: null, pid: p.pid };
    lines(p, (e) => {
      r.events.push(e);
      if (e.ev === 'ready') r.ready = e;
      if (e.ev === 'started') { r.started = e; r.startMs = Date.now() - t0; if (opts.onStarted) opts.onStarted(p, r); }
      if (e.ev === 'done') r.done = e;
      if (e.ev === 'error') r.error = e;
    });
    p.on('exit', (code) => { r.exitCode = code; r.wallMs = Date.now() - t0; resolve(r); });
    p.stdin.write(JSON.stringify(spec) + '\n');
    if (opts.stopAfterMs) setTimeout(() => { try { p.stdin.write('stop\n'); } catch (e) { /* gone */ } }, opts.stopAfterMs);
    setTimeout(() => { try { p.kill(); } catch (e) { /* gone */ } }, opts.killAfterMs || 60000);
  });
}

function probe(file, points) {
  try {
    const out = execFileSync(EXE, [`--rec-probe=${file}`].concat(points ? [`--points=${points}`] : []), { encoding: 'utf8', timeout: 60000, windowsHide: true });
    return JSON.parse(out.trim().split('\n').pop());
  } catch (e) { return { ok: false, error: e.message }; }
}

function ffprobe(file) {
  if (!FFPROBE) return null;
  try {
    const out = execFileSync(FFPROBE, ['-v', 'error', '-count_frames', '-show_entries', 'stream=codec_type,codec_name,width,height,r_frame_rate,avg_frame_rate,nb_read_frames,sample_rate,channels:format=duration,format_name', '-of', 'json', file], { encoding: 'utf8', timeout: 60000, windowsHide: true });
    return JSON.parse(out);
  } catch (e) { return { error: e.message }; }
}

/** An independent picture of one frame (ffmpeg decodes it to raw RGB): the colours at fractional points. */
function ffPixels(file, atSec, w, h, pts) {
  if (!FFMPEG || !fs.existsSync(FFMPEG)) return null;
  try {
    const raw = execFileSync(FFMPEG, ['-v', 'error', '-ss', String(atSec), '-i', file, '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { timeout: 60000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    return pts.map(([fx, fy]) => { const x = Math.floor(fx * w), y = Math.floor(fy * h), k = (y * w + x) * 3; return { r: raw[k], g: raw[k + 1], b: raw[k + 2] }; });
  } catch (e) { return { error: e.message }; }
}

const near = (c, r, g, b, tol) => c && Math.abs(c.r - r) <= tol && Math.abs(c.g - g) <= tol && Math.abs(c.b - b) <= tol;
const QUAD = [[230, 40, 40], [40, 200, 60], [40, 70, 230], [245, 245, 245]];   // the stand-in's TL, TR, BL, BR
const colours = (px) => (Array.isArray(px) ? px.map((c) => `${c.r},${c.g},${c.b}`).join(' ') : JSON.stringify(px));

async function main() {
  if (!fs.existsSync(EXE)) { console.log(`RECORDER TEST: 0 passed, 1 failed (no exe at ${EXE}: npm run build:sidecar)`); process.exit(1); }
  console.log(`exe ${EXE}\nffprobe ${FFPROBE || 'none (MF read-back only)'}\nfolder ${DIR}`);
  const si = await standIn(642, 362);
  try {
    check('the stand-in is up and wholly covered (behind the desktop, never activated)', si.hidden === true && si.w > 0, JSON.stringify(si));
    const fw = si.frame.w & ~1, fh = si.frame.h & ~1;

    /* 1. the 5 s window recording at 30 fps, no sound */
    const out1 = path.join(DIR, 'Recording test 1.mp4');
    const r1 = await record({ mode: 'window', hwnd: si.hwnd, fps: 30, audio: false, out: out1, test: true, allowPid: si.pid, testSecs: 5 });
    check('window 30 fps: ready', !!r1.ready, JSON.stringify(r1.error || r1.events.slice(-3)));
    check('window 30 fps: done, stopped by the test clock', r1.done && /test's time/.test(r1.done.why), JSON.stringify(r1.done || r1.error));
    if (r1.ready) console.log(`  ready: ${r1.ready.w}x${r1.ready.h} @${r1.ready.fps} encoder=${JSON.stringify(r1.ready.encoder)} border=${r1.ready.border} (${r1.ready.borderWhy || ''}; access ${r1.ready.access}) item=${JSON.stringify(r1.ready.item)} start=${r1.startMs} ms`);
    if (r1.done) console.log(`  done: ${r1.done.secs} s, ${r1.done.frames} frames (late ${r1.done.late}, dup ${r1.done.dup}, fresh ${r1.done.fresh}), ${Math.round(r1.done.bytes / 1024)} KB, finalize ${r1.done.finalizeMs} ms, textures ${r1.done.textures}, per frame ${JSON.stringify(r1.done.perFrameMs)}`);
    check('window 30 fps: the output is the window\'s visible frame (even size)', r1.ready && r1.ready.w === fw && r1.ready.h === fh, r1.ready && `${r1.ready.w}x${r1.ready.h} vs ${fw}x${fh}`);
    check('window 30 fps: saved under the asked name, no part file left', r1.done && r1.done.path === out1 && fs.existsSync(out1) && !fs.existsSync(out1 + '.part'));
    const p1 = r1.done ? probe(out1) : { ok: false };
    console.log(`  probe: ${JSON.stringify(Object.assign({}, p1, { pixels: undefined }))} pixels ${colours(p1.pixels)}`);
    check('window 30 fps: plays back (Media Foundation reads it)', p1.ok && p1.video === 'H.264', JSON.stringify(p1));
    check('window 30 fps: size', p1.w === fw && p1.h === fh, `${p1.w}x${p1.h}`);
    check('window 30 fps: frame rate', p1.fps === 30, p1.fps);
    check('window 30 fps: ~5 s long', p1.durationSec >= 4.6 && p1.durationSec <= 5.6, p1.durationSec);
    check('window 30 fps: ~150 frames', p1.frames >= 135 && p1.frames <= 170, p1.frames);
    check('window 30 fps: no sound track (sound off)', p1.audio === false);
    check('window 30 fps: the picture is the stand-in, the right way up (TL red, TR green, BL blue, BR white)',
      Array.isArray(p1.pixels) && p1.pixels.length === 4 && p1.pixels.every((c, i) => near(c, QUAD[i][0], QUAD[i][1], QUAD[i][2], 40)), colours(p1.pixels));
    const f1 = ffprobe(out1);
    if (f1) {
      const v = (f1.streams || []).find((s) => s.codec_type === 'video');
      console.log(`  ffprobe: ${JSON.stringify(f1)}`);
      check('ffprobe: h264 in mp4', v && v.codec_name === 'h264' && /mp4/.test(f1.format && f1.format.format_name), JSON.stringify(f1));
      check('ffprobe: size and 30 fps', v && v.width === fw && v.height === fh && v.r_frame_rate === '30/1', JSON.stringify(v));
      check('ffprobe: decodes every frame', v && Number(v.nb_read_frames) >= 135, v && v.nb_read_frames);
      const fp = ffPixels(out1, 2.5, fw, fh, [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]);
      check('ffmpeg: the same colours, the right way up', Array.isArray(fp) && fp.every((c, i) => near(c, QUAD[i][0], QUAD[i][1], QUAD[i][2], 40)), colours(fp));
    }
    if (QUICK) return;

    /* 2. a crop inside the window (the right half), 60 fps, with system sound (silence: nothing plays) */
    const out2 = path.join(DIR, 'Recording test 2.mp4');
    const cw = Math.floor(fw / 2) & ~1;
    const r2 = await record({ mode: 'window', hwnd: si.hwnd, crop: { x: fw - cw, y: 0, w: cw, h: fh }, fps: 60, audio: true, out: out2, test: true, allowPid: si.pid, testSecs: 4 });
    if (r2.ready) console.log(`  crop ready: ${r2.ready.w}x${r2.ready.h} @${r2.ready.fps} audio=${JSON.stringify(r2.ready.audio)} start=${r2.startMs} ms`);
    if (r2.done) console.log(`  crop done: ${r2.done.frames} frames (late ${r2.done.late}), audio ${JSON.stringify(r2.done.audio)} samples ${r2.done.audioSamples}`);
    check('crop 60 fps: done', !!(r2.done), JSON.stringify(r2.error || r2.events.slice(-3)));
    const p2 = r2.done ? probe(out2) : { ok: false };
    console.log(`  crop probe: ${JSON.stringify(Object.assign({}, p2, { pixels: undefined }))} pixels ${colours(p2.pixels)}`);
    check('crop 60 fps: the crop\'s size', p2.w === cw && p2.h === fh, `${p2.w}x${p2.h}`);
    check('crop 60 fps: 60 fps', p2.fps === 60, p2.fps);
    check('crop 60 fps: ~240 frames', p2.frames >= 215 && p2.frames <= 260, p2.frames);
    check('crop 60 fps: only the right half (green over white)',
      Array.isArray(p2.pixels) && near(p2.pixels[0], 40, 200, 60, 40) && near(p2.pixels[1], 40, 200, 60, 40) && near(p2.pixels[2], 245, 245, 245, 40) && near(p2.pixels[3], 245, 245, 245, 40), colours(p2.pixels));
    const sysOn = r2.ready && r2.ready.audio && r2.ready.audio.system === 'on';
    if (sysOn) {
      check('crop 60 fps: a 48 kHz stereo AAC track', p2.audio === true && p2.audioFormat === 'AAC' && p2.audioRate === 48000 && p2.audioChannels === 2, JSON.stringify(p2));
      check('crop 60 fps: the sound runs the whole recording (silence included)', p2.audioEndSec >= p2.durationSec - 0.3, `${p2.audioEndSec} vs ${p2.durationSec}`);
    } else {
      check('crop 60 fps: system sound off says why', r2.ready && typeof r2.ready.audio.system === 'string' && r2.ready.audio.system.length > 3, JSON.stringify(r2.ready && r2.ready.audio));
    }

    /* 3. never overwrite: the name is taken, the recording becomes "(2)" and the old file is untouched */
    const taken = path.join(DIR, 'Recording test 3.mp4');
    fs.writeFileSync(taken, 'not a video');
    const r3 = await record({ mode: 'window', hwnd: si.hwnd, fps: 30, audio: false, out: taken, test: true, allowPid: si.pid }, { onStarted: (p) => setTimeout(() => p.stdin.write('stop\n'), 2500) });
    check('never overwrites: saved as "(2)"', r3.done && path.basename(r3.done.path) === 'Recording test 3 (2).mp4', JSON.stringify(r3.done || r3.error));
    check('never overwrites: the old file is untouched', fs.readFileSync(taken, 'utf8') === 'not a video');
    check('stop: "stop" on stdin finishes the file', r3.done && r3.done.why === 'stop', r3.done && r3.done.why);
    const p3 = r3.done ? probe(r3.done.path) : {};
    check('stop: the stopped file plays', p3.frames > 30, JSON.stringify(Object.assign({}, p3, { pixels: undefined })) + ' start ' + r3.startMs + ' ms');

    /* 4. refusals, in plain words, with nothing left behind */
    const r4 = await record({ mode: 'monitor', x: 10, y: 10, fps: 30, audio: false, out: path.join(DIR, 'r4.mp4'), test: true, allowPid: si.pid });
    check('refused: a test never records the screen', r4.error && /never the screen/.test(r4.error.error) && !r4.ready, JSON.stringify(r4.error));
    const r5 = await record({ mode: 'window', hwnd: si.hwnd, fps: 30, audio: false, out: path.join(DIR, 'r5.mp4'), test: true, allowPid: si.pid + 1 });
    check('refused: a test never records another process\'s window', r5.error && /own stand-in/.test(r5.error.error), JSON.stringify(r5.error));
    const r6 = await record({ mode: 'window', hwnd: si.hwnd, fps: 30, audio: false, out: path.join(DIR, 'r6.mp4'), test: true, allowPid: si.pid, minFreeMb: 50000000 });
    check('refused: not enough disk space, said with the numbers', r6.error && /not enough free disk space .*GB free/.test(r6.error.error), JSON.stringify(r6.error));
    const r7 = await record({ mode: 'window', hwnd: '12345678', fps: 30, audio: false, out: path.join(DIR, 'r7.mp4'), test: true, allowPid: si.pid });
    check('refused: a window that is not there', r7.error && /closed/.test(r7.error.error), JSON.stringify(r7.error));
    check('refusals leave no files', !['r4', 'r5', 'r6', 'r7'].some((n) => fs.existsSync(path.join(DIR, n + '.mp4')) || fs.existsSync(path.join(DIR, n + '.mp4.part'))));

    /* 5. the window closes mid-recording: stopped cleanly, the file plays */
    const si2 = await standIn(400, 300);
    const out8 = path.join(DIR, 'Recording test 8.mp4');
    const r8 = await record({ mode: 'window', hwnd: si2.hwnd, fps: 30, audio: false, out: out8, test: true, allowPid: si2.pid, testSecs: 20 },
      { onStarted: () => setTimeout(() => si2.close(), 2000) });
    check('window closed: stopped cleanly, saying so', r8.done && r8.done.why === 'the window closed', JSON.stringify(r8.done || r8.error));
    const p8 = r8.done ? probe(out8) : {};
    check('window closed: the file plays (~2 s)', p8.frames >= 40 && p8.durationSec >= 1.5 && p8.durationSec <= 4, JSON.stringify(Object.assign({}, p8, { pixels: undefined })));

    /* 6. the window is resized mid-recording: the output keeps its size, black where the window no longer reaches */
    const out9 = path.join(DIR, 'Recording test 9.mp4');
    const r9 = await record({ mode: 'window', hwnd: si.hwnd, fps: 30, audio: false, out: out9, test: true, allowPid: si.pid, testSecs: 4 },
      { onStarted: () => setTimeout(() => si.proc.stdin.write(`move ${si.x} ${si.y} ${Math.round(si.w / 2)} ${si.h}\n`), 1000) });
    const p9 = r9.done ? probe(out9, '0.1,0.25;0.9,0.25') : {};
    check('resized: the size stays', p9.w === fw && p9.h === fh, `${p9.w}x${p9.h}`);
    check('resized: still plays to the end', p9.durationSec >= 3.5, p9.durationSec);
    check('resized: the left side is the window, the right side black', Array.isArray(p9.pixels) && p9.pixels[0] && p9.pixels[0].r > 150 && near(p9.pixels[1], 0, 0, 0, 30), colours(p9.pixels));
  } catch (e) {
    check('ran to the end', false, e && e.stack ? e.stack.split('\n').slice(0, 3).join(' / ') : e);
  } finally {
    si.close();
    await sleep(300);
    try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (e) { console.log(`could not delete ${DIR}: ${e.message}`); }
    check('every test file is deleted', !fs.existsSync(DIR));
  }
}

main().then(() => {
  for (const f of failures) console.log('FAIL ' + f);
  console.log(`RECORDER TEST: ${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
});

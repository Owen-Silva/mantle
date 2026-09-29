// test-screenshot.js - the `shot.*` sidecar commands (Screenshot.cs), end to end. Plain node.
//
//   MANTLE_SIDECAR_EXE=<exe> node sidecar/test-screenshot.js
//
// Runs the sidecar in --passive, like test-sidecar.js. PRIVACY, the lane's hard rule: every pixel
// this test LOOKS AT comes from `synthetic:true` grabs (a generated pattern, never the screen).
// The one real grab is there to measure the timings on this machine: it prints dimensions and
// milliseconds only, and its frames and its PNG are deleted before the test ends. Everything is
// written under a fresh %TEMP% folder that is removed at the end; nothing touches the clipboard
// or the Pictures folder (the passive refusal of a non-temp save is itself asserted).
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const EXE = process.env.MANTLE_SIDECAR_EXE || path.join(__dirname, 'bin', 'Mantle.Sidecar.exe');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mantle-shot-test-'));
const FRAMES = path.join(TMP, 'frames');
const OUT = path.join(TMP, 'out');
let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { passed++; return true; }
  failures.push(detail ? `${name} (${detail})` : name);
  console.log('  FAIL ' + name + (detail ? ' - ' + detail : ''));
  return false;
}

function start() {
  const proc = spawn(EXE, ['--passive', '--parent-pid=' + process.pid, '--state-file=' + path.join(TMP, 'state.json')],
    { stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let buf = '';
  let id = 1;
  proc.stdout.on('data', (c) => {
    buf += c.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let m;
      try { m = JSON.parse(line); } catch (_) { continue; }
      if (m.ev === undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    }
  });
  proc.stderr.on('data', () => {});
  function send(cmd, args, timeoutMs) {
    const n = id++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { pending.delete(n); reject(new Error(`no reply to ${cmd}`)); }, timeoutMs || 15000);
      pending.set(n, (m) => { clearTimeout(t); resolve(m); });
      proc.stdin.write(JSON.stringify(Object.assign({ id: n, cmd, ttl: timeoutMs || 15000 }, args || {})) + '\n');
    });
  }
  return { proc, send };
}

/** The synthetic pattern (Screenshot.cs FillSynthetic), at a VIRTUAL-screen position: [r,g,b]. */
function expected(vx, vy) {
  return [((((vx >> 8) & 15) << 4) | ((vy >> 8) & 15)) & 255, vy & 255, vx & 255];
}

/** Reads a BMP the sidecar wrote: header facts plus a pixel getter (b,g,r in the file). */
function readBmp(file) {
  const b = fs.readFileSync(file);
  const off = b.readUInt32LE(10);
  const w = b.readInt32LE(18);
  const h = b.readInt32LE(22);
  return {
    magic: b.toString('latin1', 0, 2), size: b.readUInt32LE(2), off, hdr: b.readUInt32LE(14), w, h,
    bpp: b.readUInt16LE(28), compression: b.readUInt32LE(30),
    masks: [b.readUInt32LE(54), b.readUInt32LE(58), b.readUInt32LE(62)], length: b.length,
    px(x, y) { const o = off + (y * w + x) * 4; return [b[o + 2], b[o + 1], b[o]]; },
  };
}

/** A minimal PNG decoder (8-bit RGB / RGBA, non-interlaced): enough to check the saved file. */
function readPng(file) {
  const b = fs.readFileSync(file);
  if (b.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let p = 8;
  let w = 0, h = 0, depth = 0, ctype = 0, interlace = 0;
  const idat = [];
  while (p < b.length) {
    const len = b.readUInt32BE(p);
    const type = b.toString('latin1', p + 4, p + 8);
    const data = b.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; ctype = data[9]; interlace = data[12]; }
    if (type === 'IDAT') idat.push(data);
    p += 12 + len;
  }
  const bpp = ctype === 6 ? 4 : ctype === 2 ? 3 : 0;
  if (depth !== 8 || !bpp || interlace) return { w, h, depth, ctype, interlace, px: null };
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const img = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? img[y * stride + x - bpp] : 0;
      const up = y > 0 ? img[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y > 0 ? img[(y - 1) * stride + x - bpp] : 0;
      let v = src[x];
      if (f === 1) v += a;
      else if (f === 2) v += up;
      else if (f === 3) v += (a + up) >> 1;
      else if (f === 4) { const pp = a + up - c; const pa = Math.abs(pp - a), pb = Math.abs(pp - up), pc = Math.abs(pp - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? up : c; }
      img[y * stride + x] = v & 255;
    }
  }
  return { w, h, depth, ctype, px(x, y) { const o = y * stride + x * bpp; return [img[o], img[o + 1], img[o + 2], bpp === 4 ? img[o + 3] : 255]; } };
}

const same = (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

async function main() {
  if (!fs.existsSync(EXE)) { console.log('no sidecar exe at ' + EXE); process.exit(2); }
  const s = start();
  try {
    // --- the command table -------------------------------------------------------------------
    const ping = await s.send('ping');
    const cmds = (ping.result && ping.result.features && ping.result.features.commands) || [];
    const probs = (ping.result && ping.result.features && ping.result.features.problems) || [];
    check('ping lists the five shot.* commands', ['shot.grab', 'shot.save', 'shot.copy', 'shot.release', 'shot.folder'].every((c) => cmds.includes(c)),
      JSON.stringify(cmds).slice(0, 200));
    check('no feature registration problem names Screenshot', !probs.some((p) => /Screenshot/.test(p)), JSON.stringify(probs));

    // --- refusals ------------------------------------------------------------------------------
    const noDir = await s.send('shot.grab', {});
    check('grab without a dir is refused with the reason', noDir.ok === false && /dir/.test(noDir.error), noDir.error);
    const notTemp = await s.send('shot.grab', { dir: 'C:\\Users\\Public\\mantle-shot-nope' });
    check('grab refuses a frame folder outside %TEMP%', notTemp.ok === false && /may only go under/.test(notTemp.error), notTemp.error);
    check('...and did not create it', !fs.existsSync('C:\\Users\\Public\\mantle-shot-nope'));
    const gone = await s.send('shot.save', { grab: 999, x: 0, y: 0, w: 10, h: 10, dir: OUT, name: 'x' });
    check('save of an unknown capture says it is gone', gone.ok === false && /is gone/.test(gone.error), gone.error);

    // --- a synthetic grab: the layout and the frame files ---------------------------------------
    fs.mkdirSync(FRAMES, { recursive: true });
    fs.writeFileSync(path.join(FRAMES, 'mantle-shot-77-0.bmp'), 'stale');       // a crash's leftover
    fs.writeFileSync(path.join(FRAMES, 'keep-me.txt'), 'not ours');
    const g = await s.send('shot.grab', { dir: FRAMES, synthetic: true });
    check('synthetic grab answers ok', g.ok === true, g.error);
    const r = g.result || {};
    check('grab deleted the stale frame and nothing else', r.staleDeleted === 1 && !fs.existsSync(path.join(FRAMES, 'mantle-shot-77-0.bmp')) &&
      fs.existsSync(path.join(FRAMES, 'keep-me.txt')), String(r.staleDeleted));
    check('grab reports the virtual screen', r.virt && r.virt.w > 0 && r.virt.h > 0, JSON.stringify(r.virt));
    check('grab reports at least one monitor, exactly one primary', Array.isArray(r.monitors) && r.monitors.length >= 1 &&
      r.monitors.filter((m) => m.primary).length === 1, String(r.monitors && r.monitors.length));
    const mons = r.monitors || [];
    for (const m of mons) {
      check(`monitor ${m.index}: dpi and scale agree`, m.dpi >= 96 && Math.abs(m.scale - m.dpi / 96) < 1e-3, `${m.dpi} ${m.scale}`);
      check(`monitor ${m.index}: dpi read from Windows (${m.dpiSource})`, m.dpiSource === 'GetDpiForMonitor');
      check(`monitor ${m.index}: work area inside the monitor`, m.work.x >= m.x && m.work.y >= m.y &&
        m.work.x + m.work.w <= m.x + m.w && m.work.y + m.work.h <= m.y + m.h);
      check(`monitor ${m.index}: a frame file under the temp dir`, m.file && m.file.startsWith(FRAMES) && fs.existsSync(m.file), m.file);
      if (!m.file || !fs.existsSync(m.file)) continue;
      const bmp = readBmp(m.file);
      check(`monitor ${m.index}: BMP header is 32-bit BI_BITFIELDS top-down at the monitor size`,
        bmp.magic === 'BM' && bmp.hdr === 40 && bmp.bpp === 32 && bmp.compression === 3 && bmp.w === m.frame.w && bmp.h === -m.frame.h &&
        bmp.off === 66 && bmp.size === bmp.length && bmp.length === m.bytes, JSON.stringify({ w: bmp.w, h: bmp.h, c: bmp.compression, off: bmp.off }));
      check(`monitor ${m.index}: RGB masks, and no alpha mask`, bmp.masks[0] === 0xff0000 && bmp.masks[1] === 0xff00 && bmp.masks[2] === 0xff);
      const H = -bmp.h;
      const pts = [[0, 0], [bmp.w - 1, 0], [0, H - 1], [bmp.w - 1, H - 1], [Math.floor(bmp.w / 2), Math.floor(H / 3)], [257, 511]];
      let bad = 0;
      for (const [x, y] of pts) if (x < bmp.w && y < H && !same(bmp.px(x, y), expected(m.frame.x + x, m.frame.y + y))) bad++;
      check(`monitor ${m.index}: frame pixels are the pattern at their virtual positions`, bad === 0, `${bad} of ${pts.length} wrong`);
    }
    check('windows is a list of physical rects', Array.isArray(r.windows) && r.windows.every((w) => typeof w.hwnd === 'string' && w.w > 0 && w.h > 0),
      String(r.windows && r.windows.length));
    check('the desktop (Progman/WorkerW) is marked as kind desktop', r.windows.some((w) => w.kind === 'desktop'));
    // exclude: pass the first listed window's hwnd back and it must disappear
    if (r.windows.length) {
      const first = r.windows[0].hwnd;
      const g2 = await s.send('shot.grab', { dir: FRAMES, synthetic: true, exclude: [first] });
      check('exclude drops that hwnd from the list', g2.ok && !g2.result.windows.some((w) => w.hwnd === first));
      check('a new grab replaces the old one: its frames are deleted', mons.every((m) => !fs.existsSync(m.file)));
      Object.assign(r, g2.result);
    }
    const monsNow = r.monitors;

    // --- save: crop, encode, name ----------------------------------------------------------------
    const m0 = monsNow.find((m) => m.primary) || monsNow[0];
    const crop = { x: m0.x + 13, y: m0.y + 250, w: 301, h: 17 };
    const sv = await s.send('shot.save', Object.assign({ grab: r.grab, dir: OUT, name: 'Screenshot 2026-09-24 101500' }, crop));
    check('save answers ok', sv.ok === true, sv.error);
    const sr = sv.result || {};
    check('save wrote "<name>.png" in the asked folder', sr.name === 'Screenshot 2026-09-24 101500.png' && sr.path === path.join(OUT, sr.name) && fs.existsSync(sr.path), sr.name);
    check('save reports the crop size', sr.w === crop.w && sr.h === crop.h && sr.bytes === fs.statSync(sr.path).size);
    const png = readPng(sr.path);
    check('the PNG is 8-bit RGB (opaque), at the crop size', png.w === crop.w && png.h === crop.h && png.depth === 8 && (png.ctype === 2 || png.ctype === 6),
      JSON.stringify({ w: png.w, h: png.h, depth: png.depth, ctype: png.ctype }));
    if (png.px) {
      let bad = 0, alpha = 0, n = 0;
      for (let y = 0; y < png.h; y += 4) for (let x = 0; x < png.w; x += 7) {
        n++;
        const p = png.px(x, y);
        if (!same(p, expected(crop.x + x, crop.y + y))) bad++;
        if (p[3] !== 255) alpha++;
      }
      check(`every sampled PNG pixel is the pattern at its virtual position (${n} sampled)`, bad === 0, `${bad} wrong`);
      check('no PNG pixel is transparent (the junk fourth byte was ignored)', alpha === 0, `${alpha} not opaque`);
    }
    const sv2 = await s.send('shot.save', Object.assign({ grab: r.grab, dir: OUT, name: 'Screenshot 2026-09-24 101500' }, crop));
    const sv3 = await s.send('shot.save', Object.assign({ grab: r.grab, dir: OUT, name: 'Screenshot 2026-09-24 101500' }, crop));
    check('the same name again becomes " (2)" then " (3)", never an overwrite',
      sv2.ok && sv2.result.name === 'Screenshot 2026-09-24 101500 (2).png' && sv3.ok && sv3.result.name === 'Screenshot 2026-09-24 101500 (3).png',
      JSON.stringify([sv2.result && sv2.result.name, sv3.result && sv3.result.name]));
    const clipped = await s.send('shot.save', { grab: r.grab, dir: OUT, name: 'clipped', x: r.virt.x - 50, y: r.virt.y - 50, w: 100, h: 80 });
    check('a rect hanging off the screen is clipped to it', clipped.ok && clipped.result.w === 50 && clipped.result.h === 30 &&
      clipped.result.x === r.virt.x && clipped.result.y === r.virt.y, JSON.stringify(clipped.result || clipped.error));
    const outside = await s.send('shot.save', { grab: r.grab, dir: OUT, name: 'no', x: r.virt.x - 500, y: r.virt.y, w: 100, h: 100 });
    check('a rect entirely off the screen is refused with the reason', outside.ok === false && /outside the capture/.test(outside.error), outside.error);
    const badName = await s.send('shot.save', { grab: r.grab, dir: OUT, name: '..\\escape', x: m0.x, y: m0.y, w: 10, h: 10 });
    check('a name with a folder in it is refused', badName.ok === false && /plain file name/.test(badName.error), badName.error);
    const pics = path.join(os.homedir(), 'Pictures', 'Screenshots');
    const refused = await s.send('shot.save', { grab: r.grab, dir: pics, name: 'mantle-test-must-not-exist', x: m0.x, y: m0.y, w: 10, h: 10 });
    check('PASSIVE: a save outside %TEMP% (the real Pictures folder) is refused', refused.ok === false && /passive/.test(refused.error), refused.error);
    check('...and wrote nothing there', !fs.existsSync(path.join(pics, 'mantle-test-must-not-exist.png')));

    // --- copy: the clipboard's CF_DIB, straight from the frame (lane shotspeed) ---------------------
    // dryRun only: the block a live copy hands Windows is built, dumped as a BMP here, and freed.
    const DUMP = path.join(OUT, 'dump');
    const cpy = await s.send('shot.copy', Object.assign({ grab: r.grab, dryRun: true, dump: DUMP }, crop));
    const cr = cpy.result || {};
    check('copy (dryRun) answers ok with CF_DIB at the crop size', cpy.ok === true && cr.format === 'CF_DIB' && cr.dryRun === true && cr.w === crop.w && cr.h === crop.h &&
      cr.bytes === 40 + crop.w * 4 * crop.h, cpy.error || JSON.stringify(cr));
    check('copy reports its timings', cr.ms && typeof cr.ms.crop === 'number' && cr.ms.clipboard === 0, JSON.stringify(cr.ms));
    if (cr.dumped && fs.existsSync(cr.dumped)) {
      const b = fs.readFileSync(cr.dumped);
      const off = b.readUInt32LE(10), hw = b.readInt32LE(18), hh = b.readInt32LE(22);
      check('the DIB is BITMAPINFOHEADER, 32 bpp BI_RGB, BOTTOM-UP (positive height), at the crop size',
        b.readUInt32LE(14) === 40 && off === 54 && hw === crop.w && hh === crop.h && b.readUInt16LE(28) === 32 && b.readUInt32LE(30) === 0 &&
        b.readUInt32LE(34) === crop.w * 4 * crop.h && b.length === 14 + cr.bytes, JSON.stringify({ off, hw, hh }));
      let bad = 0, alpha = 0, n = 0;
      for (let y = 0; y < crop.h; y++) for (let x = 0; x < crop.w; x += 5) {
        n++;
        const o = off + (crop.h - 1 - y) * crop.w * 4 + x * 4;       // bottom-up rows
        if (!same([b[o + 2], b[o + 1], b[o]], expected(crop.x + x, crop.y + y))) bad++;
        if (b[o + 3] !== 255) alpha++;
      }
      check(`every sampled DIB pixel is the pattern at its virtual position (${n} sampled)`, bad === 0, `${bad} wrong`);
      check('every DIB pixel\'s fourth byte is 255 (opaque in apps that read it as alpha; the frame\'s is junk)', alpha === 0, `${alpha} not 255`);
    } else check('copy dryRun + dump wrote the BMP under the test folder', false, cr.dumped);
    const cpyLive = await s.send('shot.copy', Object.assign({ grab: r.grab }, crop));
    check('PASSIVE: a real copy (not dryRun) is refused, so a test never touches the clipboard', cpyLive.ok === false && /passive/.test(cpyLive.error), cpyLive.error);
    const cpyOff = await s.send('shot.copy', { grab: r.grab, dryRun: true, x: r.virt.x - 50, y: r.virt.y - 50, w: 100, h: 80 });
    check('copy clips a rect hanging off the screen, like save', cpyOff.ok && cpyOff.result.w === 50 && cpyOff.result.h === 30, cpyOff.error);
    const cpyOut = await s.send('shot.copy', { grab: r.grab, dryRun: true, x: r.virt.x - 500, y: r.virt.y, w: 100, h: 100 });
    check('copy of a rect entirely off the screen is refused with the reason', cpyOut.ok === false && /outside the capture/.test(cpyOut.error), cpyOut.error);
    const cpyDump = await s.send('shot.copy', Object.assign({ grab: r.grab, dryRun: true, dump: 'C:\\Users\\Public\\mantle-shot-nope' }, crop));
    check('copy refuses a dump folder outside %TEMP%', cpyDump.ok === false && /may only go under/.test(cpyDump.error), cpyDump.error);

    // --- the test-only grab options: size (a 4K frame) and fill (a picture from %TEMP%) --------------
    const fillPng = path.join(OUT, 'fill.bmp');
    { const w = 3, h = 2, buf = Buffer.alloc(54 + w * h * 4); buf.write('BM', 0, 'latin1'); buf.writeUInt32LE(buf.length, 2); buf.writeUInt32LE(54, 10);
      buf.writeUInt32LE(40, 14); buf.writeInt32LE(w, 18); buf.writeInt32LE(-h, 22); buf.writeUInt16LE(1, 26); buf.writeUInt16LE(32, 28);
      for (let i = 0; i < w * h; i++) { buf[54 + i * 4] = 10 + i; buf[55 + i * 4] = 20; buf[56 + i * 4] = 30; buf[57 + i * 4] = 255; }
      fs.writeFileSync(fillPng, buf); }
    const gs = await s.send('shot.grab', { dir: FRAMES, synthetic: true, size: { w: 3840, h: 2160 }, fill: fillPng });
    check('a synthetic grab takes a size (3840x2160 on any desktop)', gs.ok && gs.result.virt.w === 3840 && gs.result.virt.h === 2160, gs.error);
    if (gs.ok) {
      const c4 = await s.send('shot.copy', { grab: gs.result.grab, dryRun: true, dump: DUMP, x: gs.result.virt.x + 3, y: gs.result.virt.y, w: 3, h: 2 });
      const d4 = c4.ok && fs.readFileSync(c4.result.dumped);
      // bottom-up: the dump's first row is the frame's row 1 (tile pixels 3..5), its second row 0..2
      check('...and a fill picture is tiled over it (the copy reads it back)', !!d4 && d4[54] === 13 && d4[58] === 14 && d4[66] === 10 && d4[55] === 20 && d4[56] === 30 && d4[57] === 255,
        c4.error || (d4 && [d4[54], d4[58], d4[66], d4[55], d4[56]].join(',')));
    }
    const gf = await s.send('shot.grab', { dir: FRAMES, synthetic: true, fill: 'C:\\Users\\Public\\x.png' });
    check('a fill outside %TEMP% is refused', gf.ok === false && /may only go under/.test(gf.error), gf.error);
    // back to a normal synthetic grab for the release checks below
    const gb = await s.send('shot.grab', { dir: FRAMES, synthetic: true });
    if (gb.ok) { r.grab = gb.result.grab; monsNow.splice(0, monsNow.length, ...gb.result.monitors.filter((m) => m.file)); }

    // --- release ------------------------------------------------------------------------------------
    const rel = await s.send('shot.release', { grab: r.grab + 1000 });
    check('release of a stale id keeps the current capture', rel.ok && rel.result.released === false && monsNow.every((m) => fs.existsSync(m.file)));
    const rel2 = await s.send('shot.release', { grab: r.grab });
    check('release frees the capture and deletes its frames', rel2.ok && rel2.result.released === true &&
      rel2.result.filesDeleted === monsNow.length && monsNow.every((m) => !fs.existsSync(m.file)), JSON.stringify(rel2.result));
    const after = await s.send('shot.save', Object.assign({ grab: r.grab, dir: OUT, name: 'late' }, crop));
    check('save after release says the capture is gone', after.ok === false && /is gone/.test(after.error), after.error);

    // --- folder -------------------------------------------------------------------------------------
    const fo = await s.send('shot.folder', {});
    check('shot.folder names a Screenshots folder', fo.ok && /Screenshots$/i.test(fo.result.path), fo.error || fo.result.source);
    console.log(`  screenshots folder source: ${fo.result && fo.result.source}`);

    // --- shot.owner (lane shotfix): the process behind a window in front of the overlay --------------
    // Read-only, and only ever on the shell's own desktop window here (explorer.exe's Progman).
    let shellWin = 0;
    try { shellWin = Number(require('koffi').load('user32.dll').func('intptr_t __stdcall GetShellWindow()')()); } catch (_) { /* below */ }
    if (shellWin) {
      const ow = await s.send('shot.owner', { windows: [String(shellWin)] });
      const row = ow.ok && ow.result.owners[0];
      check('shot.owner names the process behind a window: file name and class', !!row && row.exists === true && /^explorer\.exe$/i.test(row.exe) && row.cls === 'Progman' && row.pid > 0,
        JSON.stringify(ow.result || ow.error));
      check('shot.owner never returns a title or a path', !!row && !('title' in row) && !/[\\/]/.test(row.exe));
    } else check('koffi found the shell window for the shot.owner test', false);
    const noWin = await s.send('shot.owner', { windows: ['0', 1] });
    check('shot.owner: no such window -> exists false, not an error', noWin.ok && noWin.result.owners.length === 2 && noWin.result.owners.every((o) => o.exists === false), JSON.stringify(noWin.result || noWin.error));
    const bad = await s.send('shot.owner', {});
    check('shot.owner: no list -> an error in words', bad.ok === false && /windows must be a list/.test(bad.error), bad.error);
    const many = await s.send('shot.owner', { windows: Array.from({ length: 17 }, (_, i) => String(i + 1)) });
    check('shot.owner: more than 16 -> refused in words', many.ok === false && /at most 16/.test(many.error), many.error);

    // --- hotkey LATE KEYS (Hotkey.cs, lane shotfix): made-up ticks, no real input ---------------------
    const late = await s.send('hotkey', { op: 'late', now: 5000, made: 3800, limitMs: 1000, vk: 0x53 });
    check('late key: 1200 ms past a 1000 ms limit -> it reached Windows too, said in words',
      late.ok && late.result.waited === 1200 && late.result.leaked === true &&
      /a key Mantle takes \(S\) reached the keyboard hook 1200 ms after it was pressed, past Windows' 1000 ms limit, so Windows had already passed it on: it reached Windows TOO/.test(late.result.words),
      JSON.stringify(late.result || late.error));
    const inTime = await s.send('hotkey', { op: 'late', now: 5000, made: 4500, limitMs: 1000, vk: 0x2C });
    check('late key: 500 ms is in time (not leaked, no words)', inTime.ok && inTime.result.waited === 500 && inTime.result.leaked === false && inTime.result.words === null, JSON.stringify(inTime.result));
    const wrap = await s.send('hotkey', { op: 'late', now: 100, made: 4294967000, limitMs: 300, vk: 0x2C });
    check('late key: the tick counter wrapping is handled (396 ms, past a 300 ms limit)', wrap.ok && wrap.result.waited === 396 && wrap.result.leaked === true && /\(PrintScreen\)/.test(wrap.result.words), JSON.stringify(wrap.result));
    const odd = await s.send('hotkey', { op: 'late', now: 100000, made: 0, vk: 0x53 });
    check('late key: a nonsense stamp (a minute or more) is never called late', odd.ok && odd.result.waited === -1 && odd.result.leaked === false, JSON.stringify(odd.result));
    const hs = await s.send('hotkey', { op: 'status' });
    check('hotkey status: says Windows\' hook limit and counts late keys', hs.ok && hs.result.limitMs > 0 && hs.result.limitMs <= 1000 && hs.result.lateKeys === 0 &&
      /LowLevelHooksTimeout/.test(hs.result.limitWhy), JSON.stringify(hs.result && { limitMs: hs.result.limitMs, limitWhy: hs.result.limitWhy, lateKeys: hs.result.lateKeys }));

    // --- the REAL grab: timings and dimensions only; frames deleted at once --------------------------
    const times = [];
    let real = null;
    for (let i = 0; i < 5; i++) {
      const t0 = process.hrtime.bigint();
      const gr = await s.send('shot.grab', { dir: FRAMES });
      const rt = Number(process.hrtime.bigint() - t0) / 1e6;
      if (!gr.ok) { check('real grab ok', false, gr.error); break; }
      real = gr.result;
      times.push({ rt, ...gr.result.ms });
    }
    if (real) {
      const pm = real.monitors.find((m) => m.primary) || real.monitors[0];
      const t0 = process.hrtime.bigint();
      const full = await s.send('shot.save', { grab: real.grab, dir: OUT, name: 'real-full', x: pm.x, y: pm.y, w: pm.w, h: pm.h });
      const saveRt = Number(process.hrtime.bigint() - t0) / 1e6;
      check('a real full-monitor save works (then deleted)', full.ok === true, full.error);
      if (full.ok) fs.unlinkSync(full.result.path);
      await s.send('shot.release', {});
      check('the real frames are deleted', real.monitors.every((m) => !m.file || !fs.existsSync(m.file)));
      const med = (k) => { const v = times.map((t) => t[k]).sort((a, b) => a - b); return v[Math.floor(v.length / 2)].toFixed(1); };
      console.log(`  real grab (${real.monitors.length} monitor${real.monitors.length > 1 ? 's' : ''}, virtual ${real.virt.w}x${real.virt.h}, ` +
        `scales ${real.monitors.map((m) => m.scale).join('/')}; ${real.windows.length} windows), median of ${times.length}: ` +
        `BitBlt ${med('blt')} ms, BMP write ${med('write')} ms, window list ${med('windows')} ms, sidecar total ${med('total')} ms, round trip ${med('rt')} ms`);
      if (full.ok) console.log(`  real full-monitor save ${full.result.w}x${full.result.h}: crop ${full.result.ms.crop} ms, PNG encode ${full.result.ms.encode} ms, write ${full.result.ms.write} ms, round trip ${saveRt.toFixed(1)} ms, ${Math.round(full.result.bytes / 1024)} KB`);
    }
  } finally {
    try { s.proc.stdin.write(JSON.stringify({ id: 0, cmd: 'quit' }) + '\n'); } catch (_) { /* gone */ }
    setTimeout(() => { try { s.proc.kill(); } catch (_) { /* gone */ } }, 1500).unref();
  }
  await new Promise((res) => setTimeout(res, 300));
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* best effort */ }
  check('the test temp folder is gone', !fs.existsSync(TMP));
  console.log(`screenshot sidecar: ${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
  console.log('screenshot sidecar: crashed: ' + e.message);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* best effort: frames and captures must not outlive a crash */ }
  process.exit(1);
});

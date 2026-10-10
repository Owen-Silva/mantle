'use strict';
/*
 * wall-still.test.js -- lib/wall-still.js, the wallpaper picture behind dark glass, under plain node
 * (lane helm-wall, 2026-10-09). No Electron: a fake desktop page answers pageStill's questions and a
 * fake nativeImage hands bitmaps back and forth. pageStill itself runs in the real desktop page and is
 * checked in a --test instance (tools/wall-still-probe.js), not here.
 *
 *   node lib/wall-still.test.js
 *
 * Prints "WALL STILL TEST: n passed, m failed"; exits 1 on any failure.
 */
const WS = require('./wall-still');

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) passed++;
  else failures.push(name + (detail !== undefined ? ' -- ' + String(detail).slice(0, 300) : ''));
}

/* a w x h RGBA bitmap whose pixel (x, y) is (x*10, y*10, 7, 255) */
function ramp(w, h) {
  const b = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = (y * w + x) * 4; b[o] = x * 10; b[o + 1] = y * 10; b[o + 2] = 7; b[o + 3] = 255; }
  return b;
}

/* fake nativeImage: a data URL is a key into BITMAPS; createFromBitmap remembers what it was given */
const BITMAPS = new Map();
const MADE = [];
const nativeImage = {
  createFromDataURL(url) {
    const bm = BITMAPS.get(url);
    if (!bm) return { isEmpty: () => true, getSize: () => ({ width: 0, height: 0 }), toBitmap: () => Buffer.alloc(0) };
    return { isEmpty: () => false, getSize: () => ({ width: bm.w, height: bm.h }), toBitmap: () => Buffer.from(bm.buf) };
  },
  createFromBitmap(buf, sz) {
    const url = `data:image/png;base64,made${MADE.length}`;
    MADE.push({ url, buf: Buffer.from(buf), w: sz.width, h: sz.height });
    return { toDataURL: () => url };
  },
};

/* a fake desktop layer: answer() is what pageStill returns; calls counts executeJavaScript */
function fakeWin(answer) {
  const w = {
    calls: 0, gone: false,
    isDestroyed: () => w.gone,
    webContents: {
      isDestroyed: () => w.gone,
      executeJavaScript: async (code) => { w.calls++; w.lastCode = code; return answer(code); },
    },
  };
  return w;
}

const DISPLAY = { dip: { x: 0, y: 0, width: 1536, height: 864 }, phys: { x: 0, y: 0, w: 1920, h: 1080 } };

function rig(over) {
  const logs = [];
  const st = Object.assign({ dark: true, wp: { id: 'w1', ok: true, reason: '"snow" is playing' }, win: null, windowsStill: null }, over || {});
  const ws = WS.makeWallStill({
    desktopWin: () => st.win,
    windowsStill: () => st.windowsStill,
    wallpaper: () => st.wp,
    display: () => DISPLAY,
    nativeImage,
    // the cut's encoder, faked like nativeImage so a check can read the pixels back (MADE)
    encode: (buf, w, h) => nativeImage.createFromBitmap(buf, { width: w, height: h }).toDataURL(),
    dark: () => st.dark,
    log: (l) => logs.push(l),
  });
  return { ws, st, logs };
}

(async () => {
  // ---- pure parts -------------------------------------------------------
  {
    // encodePng: a real PNG (signature, IHDR, CRCs) whose pixels decode back exactly, BGRA in -> RGBA out
    const zlib = require('zlib');
    const w = 7, h = 5, bgra = Buffer.alloc(w * h * 4);
    for (let i = 0; i < w * h; i++) { bgra[i * 4] = (i * 37) & 255; bgra[i * 4 + 1] = (i * 91 + 3) & 255; bgra[i * 4 + 2] = (255 - i * 11) & 255; bgra[i * 4 + 3] = i % 3 ? 255 : 128; }
    const url = WS.encodePng(bgra, w, h);
    const png = Buffer.from(url.split(',')[1], 'base64');
    let ok = url.startsWith('data:image/png;base64,') && png.slice(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    let p = 8, idat = [], ihdr = null, crcOk = true;
    const CRC = new Int32Array(256).map((_, n) => { let k = n; for (let j = 0; j < 8; j++) k = k & 1 ? 0xEDB88320 ^ (k >>> 1) : k >>> 1; return k; });
    const crc = (b) => { let k = -1; for (let i = 0; i < b.length; i++) k = CRC[(k ^ b[i]) & 255] ^ (k >>> 8); return (k ^ -1) >>> 0; };
    while (p < png.length) {
      const len = png.readUInt32BE(p), type = png.toString('ascii', p + 4, p + 8), d = png.subarray(p + 8, p + 8 + len);
      if (crc(png.subarray(p + 4, p + 8 + len)) !== png.readUInt32BE(p + 8 + len)) crcOk = false;
      if (type === 'IHDR') ihdr = d; else if (type === 'IDAT') idat.push(d);
      p += 12 + len;
    }
    ok = ok && crcOk && ihdr && ihdr.readUInt32BE(0) === w && ihdr.readUInt32BE(4) === h && ihdr[8] === 8 && ihdr[9] === 6;
    const raw = zlib.inflateSync(Buffer.concat(idat)), stride = w * 4;
    let same = true;
    for (let y = 0; y < h; y++) {
      const f = raw[y * (stride + 1)], row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
      for (let x = 0; x < stride; x++) {
        const v = f === 1 && x >= 4 ? (row[x] + (row[x - 4] = row[x - 4])) & 255 : row[x];
        row[x] = v;
        const i = y * stride + x, px = i >> 2, ch = i & 3;
        const want = bgra[px * 4 + [2, 1, 0, 3][ch]];
        if (v !== want) same = false;
      }
    }
    check('encodePng: a valid RGBA PNG (signature, IHDR, every CRC)', ok, url.slice(0, 40));
    check('encodePng: the pixels decode back exactly (BGRA in, RGBA out)', same);
  }
  {
    const src = ramp(8, 6);
    const same = WS.resample(src, 8, 6, 0, 0, 8, 6, 8, 6);
    check('resample: the whole picture at its own size is the picture', Buffer.compare(same, src) === 0);
    const half = WS.resample(src, 8, 6, 0.5, 0, 4, 1, 4, 1);
    // output pixel 0 covers source [0.5, 1.5]: its centre 1.0 is halfway between pixel centres 0.5 and 1.5
    check('resample: a half-pixel shift lands between pixels', half[0] === 5 && half[4] === 15, `${half[0]},${half[4]}`);
    const mid = WS.resample(src, 8, 6, 0.25, 0, 8, 6, 8, 6);
    check('resample: a quarter-pixel shift blends neighbours', mid[4] === Math.round(10 + 2.5), mid[4]);
    const clamp = WS.resample(src, 8, 6, -4, -4, 2, 2, 2, 2);
    check('resample: outside the picture clamps to its edge', clamp[0] === 0 && clamp[1] === 0 && clamp[3] === 255);
  }
  check('clip: inside', JSON.stringify(WS.clip({ x: 10, y: 10, w: 5, h: 5 }, { x: 0, y: 0, w: 100, h: 100 })) === JSON.stringify({ x: 10, y: 10, w: 5, h: 5 }));
  check('clip: trimmed', JSON.stringify(WS.clip({ x: -5, y: 90, w: 20, h: 20 }, { x: 0, y: 0, w: 100, h: 100 })) === JSON.stringify({ x: 0, y: 90, w: 15, h: 10 }));
  check('clip: apart', WS.clip({ x: 200, y: 0, w: 5, h: 5 }, { x: 0, y: 0, w: 100, h: 100 }) === null);
  check('wallSig: id, ok and reason', WS.wallSig({ id: 'a', ok: true, reason: 'r' }) === 'a|1|r' && WS.wallSig(null) === 'none');
  check('pageStill is self-contained (stringifiable)', /^function pageStill\(scale, lastKey, dispW, dispH\)/.test(WS.pageStill.toString()));

  // ---- Mantle's wallpaper -------------------------------------------------
  const STILL = 'data:image/png;base64,STILL768';
  BITMAPS.set(STILL, { w: 768, h: 432, buf: (() => { const b = Buffer.alloc(768 * 432 * 4); for (let i = 0; i < b.length; i += 4) { b[i] = 100; b[i + 1] = 150; b[i + 2] = 200; b[i + 3] = 255; } return b; })() });
  {
    let key = 'K1';
    const win = fakeWin((code) => (code.includes(JSON.stringify(key)) ? { same: true, key } : { ok: true, key, png: STILL, w: 768, h: 432, vw: 1536, vh: 864, kind: 'picture', covers: true }));
    const { ws, st, logs } = rig({ win });
    const heard = [];
    ws.onChange((why) => heard.push(why));
    const f = await ws.full();
    check('full: Mantle\'s wallpaper', f.ok && f.source === 'mantle' && f.png === STILL && f.w === 768 && f.display.width === 1536, JSON.stringify(f).slice(0, 200));
    check('full: the page was asked with SCALE, no key and the DISPLAY\'s size', win.calls === 1 && win.lastCode.includes(`(${WS.SCALE}, "", 1536, 864)`), win.lastCode && win.lastCode.slice(-30));
    check('first still: followers hear', heard.length === 1, heard.join(' / '));
    check('first still: one log line', logs.some((l) => /Mantle's wallpaper \(768x432 still, picture\)/.test(l)), logs.join(' / '));
    await ws.full();
    check('cached: the page is not asked again within RECHECK_MS', win.calls === 1, win.calls);

    // a cut: the pill of a 1400x78 phys bar at 260,1002
    const r = await ws.rect({ x: 260, y: 1002, w: 1400, h: 78 });
    const made = MADE[MADE.length - 1];
    check('rect: exact coverage', r.ok && r.rect.x === 260 && r.rect.y === 1002 && r.rect.w === 1400 && r.rect.h === 78, JSON.stringify(r.rect));
    check('rect: output at the still\'s pitch (2.5 phys px)', r.w === 560 && r.h === 31 && made.w === 560 && made.h === 31, `${r.w}x${r.h}`);
    check('rect: the pixels are the wallpaper\'s', made.buf[0] === 100 && made.buf[1] === 150 && made.buf[2] === 200 && made.buf[3] === 255);
    const r4 = await ws.rect({ x: 0, y: 0, w: 400, h: 200 }, { scale: 4 });
    check('rect: opts.scale sets the output pitch', r4.ok && r4.w === 100 && r4.h === 50, `${r4.w}x${r4.h}`);
    const off = await ws.rect({ x: 2000, y: 0, w: 100, h: 100 });
    check('rect: off the display says so', !off.ok && !off.capture && /not on the display/.test(off.reason), off.reason);
    const trimmed = await ws.rect({ x: 1800, y: 1000, w: 300, h: 300 });
    check('rect: past the edge is trimmed and says what it covers', trimmed.ok && trimmed.rect.w === 120 && trimmed.rect.h === 80, JSON.stringify(trimmed.rect));
    const nMade = MADE.length;
    const whole = await ws.rect({ x: 0, y: 0, w: 1920, h: 1080 });
    check('rect: the whole display at the still pitch IS the still (no resample, no encode)', whole.ok && whole.png === STILL && whole.w === 768 && whole.h === 432 && MADE.length === nMade, `${whole.w}x${whole.h} made ${MADE.length - nMade}`);
    const most = await ws.rect({ x: 0, y: 0, w: 1920, h: 1000 });
    check('rect: anything less is cut and encoded', most.ok && most.png !== STILL && MADE.length === nMade + 1 && most.h === 400, `${most.w}x${most.h}`);
    const s = await ws.strip(28);
    check('strip: the top 28 DIP, full width, opaque, no under', s.ok && s.rect.height === 28 && s.rect.width === 1536 && s.under === null && s.opaque === true && s.h === 14 && s.w === 768, JSON.stringify(Object.assign({}, s, { png: undefined })));

    // the same wallpaper after RECHECK_MS: one question, answered "same", nothing rebuilt or heard
    st.wp = Object.assign({}, st.wp);
    await new Promise((res) => setTimeout(res, WS.RECHECK_MS + 20));
    const before = heard.length;
    await ws.full();
    check('recheck: the page is asked with the cached key and answers same', win.calls === 2 && win.lastCode.includes('"K1"'), win.calls);
    check('recheck: same -> nobody hears', heard.length === before);

    // another wallpaper: watch() on the State change re-reads, followers hear
    key = 'K2';
    st.wp = { id: 'w2', ok: true, reason: '"lake" is playing' };
    ws.watch();
    await new Promise((res) => setTimeout(res, 10));
    check('watch: a different wallpaper is read again and followers hear', win.calls === 3 && heard.length === before + 1, `${win.calls} / ${heard.length}`);

    // light: nothing
    st.dark = false;
    const lf = await ws.full();
    check('light: no picture, with the reason', !lf.ok && /light/.test(lf.reason), lf.reason);
    const lr = await ws.rect({ x: 0, y: 0, w: 10, h: 10 });
    check('light: rect too', !lr.ok && /light/.test(lr.reason));
    check('light: the page is never asked', win.calls === 3, win.calls);
  }

  // ---- a web wallpaper: no still, callers may capture -----------------------
  {
    const win = fakeWin(() => ({ web: true, why: 'the wallpaper is a web page, and Mantle cannot read a still picture of one' }));
    const { ws } = rig({ win });
    const r = await ws.rect({ x: 0, y: 0, w: 100, h: 100 });
    check('web: {ok:false, capture:true} with the reason', !r.ok && r.capture === true && /web page/.test(r.reason), JSON.stringify(r));
    const f = await ws.full();
    check('web: full() too', !f.ok && f.capture === true);
    check('web: the failure is remembered for RECHECK_MS (one question)', win.calls === 1, win.calls);
  }

  // ---- a video frame that cannot be read back ------------------------------
  {
    const win = fakeWin(() => ({ err: true, why: 'the wallpaper\'s frame cannot be read back: tainted' }));
    const { ws } = rig({ win });
    const r = await ws.rect({ x: 0, y: 0, w: 100, h: 100 });
    check('tainted video: capture fallback allowed, reason kept', !r.ok && r.capture === true && /read back/.test(r.reason));
  }

  // ---- no Mantle wallpaper: Windows' wallpaper (desktop.backdrop) -----------
  {
    const WIN = 'data:image/png;base64,WINDOWS240';
    BITMAPS.set(WIN, { w: 240, h: 135, buf: ramp(240, 135) });
    const win = fakeWin(() => ({ none: true, why: 'the desktop draws no Mantle wallpaper' }));
    const { ws } = rig({ win, wp: { id: null, ok: true, reason: 'no wallpaper is chosen' }, windowsStill: { png: WIN, w: 240, h: 135 } });
    const f = await ws.full();
    check('none: Windows\' wallpaper', f.ok && f.source === 'windows' && f.w === 240, JSON.stringify(Object.assign({}, f, { png: undefined })));
    const r = await ws.rect({ x: 0, y: 0, w: 80, h: 80 });
    check('none: a cut of it at its pitch (8 phys px)', r.ok && r.w === 10 && r.h === 10 && r.source === 'windows', `${r.w}x${r.h}`);
  }
  {
    const win = fakeWin(() => ({ none: true, why: 'the desktop draws no Mantle wallpaper' }));
    const { ws } = rig({ win, wp: { id: null, ok: true, reason: 'no wallpaper is chosen' } });
    const r = await ws.rect({ x: 0, y: 0, w: 80, h: 80 });
    check('none and no Windows picture: fallback with the reason, no capture', !r.ok && !r.capture && /no picture of Windows' wallpaper/.test(r.reason), r.reason);
  }
  {
    const { ws } = rig({ win: null, wp: null });
    const r = await ws.full();
    check('no desktop layer: says so', !r.ok && /no desktop layer/.test(r.reason), r.reason);
  }

  // ---- a Mantle wallpaper that is unloaded (a game): its last still stays ----
  {
    let mode = 'ok';
    const win = fakeWin(() => (mode === 'ok' ? { ok: true, key: 'KV', png: STILL, w: 768, h: 432, kind: 'video', covers: true } : { none: true, why: 'the desktop draws no Mantle wallpaper' }));
    const { ws, st } = rig({ win, wp: { id: 'v1', ok: true, reason: '"clip" is playing' } });
    await ws.full();
    mode = 'none';
    st.wp = { id: 'v1', ok: true, reason: '"clip" is paused: a game is running' };
    const f = await ws.full();
    check('unloaded for a game: the same wallpaper\'s still is kept', f.ok && f.source === 'mantle' && f.key === 'KV', JSON.stringify(Object.assign({}, f, { png: undefined })));
  }

  // ---- a loading wallpaper ---------------------------------------------------
  {
    const win = fakeWin(() => ({ wait: true, why: 'the wallpaper has not drawn its first frame yet' }));
    const { ws } = rig({ win });
    const r = await ws.rect({ x: 0, y: 0, w: 10, h: 10 });
    check('loading: transient, not a capture', !r.ok && !r.capture && /first frame/.test(r.reason));
    await ws.rect({ x: 0, y: 0, w: 10, h: 10 });
    check('loading: asked again next time (transient is not remembered)', win.calls === 2, win.calls);
  }

  // ---- concurrency: two callers at once share one page question --------------
  {
    let resolve;
    const win = fakeWin(() => new Promise((res) => { resolve = () => res({ ok: true, key: 'KC', png: STILL, w: 768, h: 432, kind: 'picture', covers: true }); }));
    const { ws } = rig({ win });
    const a = ws.full(), b = ws.rect({ x: 0, y: 0, w: 10, h: 10 });
    await new Promise((res) => setTimeout(res, 5));
    resolve();
    const [ra, rb] = await Promise.all([a, b]);
    check('concurrent callers: one page question', win.calls === 1 && ra.ok && rb.ok, win.calls);
  }
})().catch((err) => {
  failures.push('crashed: ' + (err && err.stack ? err.stack.split('\n').slice(0, 3).join(' / ') : err));
}).finally(() => {
  for (const f of failures) console.log('  FAIL ' + f);
  console.log(`WALL STILL TEST: ${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
});

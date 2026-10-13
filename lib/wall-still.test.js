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
const FILES = new Map();
const RESIZED = [];
const nativeImage = {
  createFromDataURL(url) {
    const bm = BITMAPS.get(url);
    if (!bm) return { isEmpty: () => true, getSize: () => ({ width: 0, height: 0 }), toBitmap: () => Buffer.alloc(0) };
    return { isEmpty: () => false, getSize: () => ({ width: bm.w, height: bm.h }), toBitmap: () => Buffer.from(bm.buf) };
  },
  // the look-sync still (source 2): a file path is a key into FILES; resize is nearest-neighbour, and noted
  createFromPath(file) {
    const bm = FILES.get(file);
    if (!bm) return { isEmpty: () => true, getSize: () => ({ width: 0, height: 0 }), toBitmap: () => Buffer.alloc(0) };
    const im = (b) => ({ isEmpty: () => false, getSize: () => ({ width: b.w, height: b.h }), toBitmap: () => Buffer.from(b.buf),
      resize: (o) => { RESIZED.push(o); const out = Buffer.alloc(o.width * o.height * 4);
        for (let y = 0; y < o.height; y++) for (let x = 0; x < o.width; x++) { const sx = Math.min(b.w - 1, Math.floor((x + 0.5) * b.w / o.width)), sy = Math.min(b.h - 1, Math.floor((y + 0.5) * b.h / o.height)); b.buf.copy(out, (y * o.width + x) * 4, (sy * b.w + sx) * 4, (sy * b.w + sx) * 4 + 4); }
        return im({ w: o.width, h: o.height, buf: out }); } });
    return im(bm);
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
    lookStill: () => st.look || null,
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
    // the same cut again is the last one (lane mn-speed): no second resample + encode, the same bytes
    const r4b = await ws.rect({ x: 0, y: 0, w: 400, h: 200 }, { scale: 4 });
    check('rect: the same cut again is served from the last cuts (same buffer)', r4b.ok && r4b.png === r4.png && r4b.w === 100, `${r4b.w}x${r4b.h}`);
    const r4c = await ws.rect({ x: 0, y: 0, w: 400, h: 200 }, { scale: 2 });
    check('rect: another pitch is its own cut', r4c.ok && r4c.png !== r4.png && r4c.w === 200, `${r4c.w}x${r4c.h}`);
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
    const r4d = await ws.rect({ x: 0, y: 0, w: 400, h: 200 }, { scale: 4 });
    check('rect: a new still cuts afresh (no cut of the old one is reused)', r4d.ok && r4d.png !== r4.png, r4d.reason);

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
  // ---- the bar's overscanned cut (lane mantle-seethru-bar-desktop) -----------------------------------
  {
    // Owen's display: 1536x864 DIP at 1.25 = 1920x1080; the pill 1120x48 DIP at (208, 802) DIP
    const pill = { x: 260, y: 1003, w: 1400, h: 60 };
    const g = WS.growRect(pill, 16, 1.25);
    check('growRect: 16 DIP at 1.25 is 20 physical px on every side', JSON.stringify(g) === JSON.stringify({ x: 240, y: 983, w: 1440, h: 100 }), JSON.stringify(g));
    check('growRect: at 1.0 and 1.5 too (whole physical px)', WS.growRect(pill, 16, 1).x === 244 && WS.growRect(pill, 16, 1.5).w === 1400 + 48);
    // the window: the pill's top down to the screen edge (62 DIP asked, 77 physical px)
    const winPhys = { x: 260, y: 1003, w: 1400, h: 77 }, winDip = { width: 1120, height: 61.6 };
    const p = WS.placeAt(g, winPhys, winDip);
    // the page multiplies `at` by `win` (DIP): the picture lies 16 DIP left of and above the window's corner
    const ax = p.at.x * p.win.w, ay = p.at.y * p.win.h, aw = p.at.w * p.win.w, ah = p.at.h * p.win.h;
    check('placeAt: DIP/physical: the picture is 16 DIP out on the left and right, 1440 px = 1152 DIP wide', Math.abs(ax + 16) < 1e-9 && Math.abs(aw - 1152) < 1e-9, JSON.stringify(p));
    check('placeAt: ...and 16 DIP above the pill, 80 DIP tall (100 px at 1.25)', Math.abs(ay + 16) < 0.01 && Math.abs(ah - 80) < 0.01, `${ay} ${ah}`);
    // a monitor whose origin is not 0,0: the same rectangles moved together place the same
    const off = (r) => ({ x: r.x - 1920, y: r.y + 120, w: r.w, h: r.h });
    const q = WS.placeAt(off(g), off(winPhys), winDip);
    check('placeAt: the monitor\'s origin cancels out (only the window-relative offset counts)', JSON.stringify(q) === JSON.stringify(p), JSON.stringify(q));
    check('placeAt: a window with no size places nothing', WS.placeAt(g, { x: 0, y: 0, w: 0, h: 10 }, winDip) === null && WS.placeAt(g, null, winDip) === null);
  }

  // ---- rect {pad}: past the display's edge the edge pixels repeat --------------------------------------
  {
    const ED = 'data:image/png;base64,EDGE';
    // a 768x432 still whose row y is (0, y/2, 0): the bottom rows are distinct, so a clip or a pad shows
    BITMAPS.set(ED, { w: 768, h: 432, buf: (() => { const b = Buffer.alloc(768 * 432 * 4); for (let y = 0; y < 432; y++) for (let x = 0; x < 768; x++) { const o = (y * 768 + x) * 4; b[o + 1] = y >> 1; b[o + 3] = 255; } return b; })() });
    const win = fakeWin(() => ({ ok: true, key: 'KE', png: ED, w: 768, h: 432, kind: 'picture', covers: true }));
    const { ws } = rig({ win });
    const grown = { x: 240, y: 983, w: 1440, h: 100 };   // 3 px past the bottom of a 1080-px display
    const cut = await ws.rect(grown);
    check('rect: without pad the cut is clipped to the display', cut.ok && cut.rect.y + cut.rect.h === 1080 && cut.rect.h === 97, JSON.stringify(cut.rect));
    const n0 = MADE.length;
    const pad = await ws.rect(grown, { pad: true });
    const m = MADE[n0];
    check('rect {pad}: the whole asked rectangle, at the still\'s pitch (2.5 px)', pad.ok && JSON.stringify(pad.rect) === JSON.stringify(grown) && pad.w === 576 && pad.h === 40, JSON.stringify({ r: pad.rect, w: pad.w, h: pad.h }));
    check('rect {pad}: the rows past the edge repeat the display\'s last row', m && m.buf[(39 * 576) * 4 + 1] === (431 >> 1) && m.buf[(38 * 576) * 4 + 1] === (431 >> 1), m && m.buf[(39 * 576) * 4 + 1]);
    check('rect {pad}: a rectangle wholly off the display still says no', !(await ws.rect({ x: 0, y: 2000, w: 10, h: 10 }, { pad: true })).ok);
  }

  // ---- source 2: the look-sync record's still, cover-fit, when the desktop draws no wallpaper ----------
  {
    // 960x636 (the record's still, cover-sized for a smaller screen): pixel (x, y) is (x/4, y/3, 0)
    const LF = 'C:/look-sync/stills/wall-7.jpg';
    FILES.set(LF, { w: 960, h: 636, buf: (() => { const b = Buffer.alloc(960 * 636 * 4); for (let y = 0; y < 636; y++) for (let x = 0; x < 960; x++) { const o = (y * 960 + x) * 4; b[o] = Math.round(x / 4); b[o + 1] = Math.round(y / 3); b[o + 3] = 255; } return b; })() });
    const none = () => ({ none: true, why: 'the desktop draws no Mantle wallpaper' });
    const { ws, st, logs } = rig({ win: fakeWin(none), look: { file: LF, id: 'w1' } });
    const n0 = MADE.length;
    const f = await ws.full();
    const m = MADE[n0];
    check('look: the desktop draws none, so the glass is the record\'s still of THIS wallpaper', f.ok && f.source === 'look' && f.w === 768 && f.h === 432, JSON.stringify(f).slice(0, 160));
    // cover: k = max(768/960, 432/636) = 0.8, so 960x540 of it, centred: rows 48..588
    const px = (x, y) => [m.buf[(y * 768 + x) * 4], m.buf[(y * 768 + x) * 4 + 1]];
    const want = (x, y) => [((x + 0.5) / 0.8 - 0.5) / 4, (48 + (y + 0.5) / 0.8 - 0.5) / 3];
    const probes = [[0, 0], [383, 215], [767, 431], [100, 300]];
    const bad = probes.filter(([x, y]) => Math.abs(px(x, y)[0] - want(x, y)[0]) > 1 || Math.abs(px(x, y)[1] - want(x, y)[1]) > 1);
    check('look: cover-fit and centred like Helm (the top and bottom 48 rows of the still cut off), to a level', m && bad.length === 0, JSON.stringify(probes.map(([x, y]) => [px(x, y), want(x, y)])));
    check('look: no resize for a still already near the cover size', RESIZED.length === 0, JSON.stringify(RESIZED));
    check('look: said so in the log', logs.some((l) => /shared desktop still/.test(l)), logs.join(' | '));
    const c = await ws.rect({ x: 260, y: 1003, w: 1400, h: 60 });
    check('look: a cut of it is lined up like any other (source look)', c.ok && c.source === 'look' && c.w === 560 && c.h === 24, JSON.stringify({ s: c.source, w: c.w, h: c.h }));
    // another wallpaper's record is never used for this one
    st.wp = { id: 'w2', ok: true, reason: 'other' };
    st.windowsStill = null;
    const o = await ws.full();
    check('look: a record of ANOTHER wallpaper is not used (no Windows picture either: a reason)', !o.ok && /no picture of Windows/.test(o.reason || ''), JSON.stringify(o).slice(0, 160));
  }
  {
    // a big still (1920x1272) is shrunk area-averaged first ('good'), then cut exactly
    const BF = 'C:/look-sync/stills/wall-8.jpg';
    FILES.set(BF, { w: 1920, h: 1272, buf: Buffer.alloc(1920 * 1272 * 4, 90) });
    const r0 = RESIZED.length;
    const { ws } = rig({ win: fakeWin(() => ({ none: true, why: 'none' })), look: { file: BF, id: 'w1' } });
    const f = await ws.full();
    const rz = RESIZED[r0];
    check('look: a big still is shrunk with quality good to about the cover size first', f.ok && f.source === 'look' && rz && rz.quality === 'good' && rz.width === 768 && rz.height === 509, JSON.stringify(rz));
  }
  {
    // while the page loads its first frame (wait), the look still stands in; once it draws, Mantle's own wins
    const LF = 'C:/look-sync/stills/wall-7.jpg';
    let ans = { wait: true, why: 'the wallpaper has not drawn its first frame yet' };
    const { ws, st } = rig({ win: fakeWin(() => ans), look: { file: LF, id: 'w1' } });
    const heard = [];
    ws.onChange((why) => heard.push(why));
    const a = await ws.full();
    check('look: stands in while the wallpaper loads (not a transient failure)', a.ok && a.source === 'look', JSON.stringify(a).slice(0, 120));
    ans = { ok: true, key: 'KM', png: STILL, w: 768, h: 432, kind: 'picture', covers: true };
    st.wp = { id: 'w1', ok: true, reason: 'now playing' };
    const b = await ws.full();
    check('look: Mantle\'s own drawing wins once it is there (and followers hear of it)', b.ok && b.source === 'mantle' && heard.length >= 2, JSON.stringify({ s: b.source, heard }));
  }
  {
    // a record whose still will not open: falls through to Windows' picture (here: none, so a reason)
    const { ws } = rig({ win: fakeWin(() => ({ none: true, why: 'none' })), look: { file: 'C:/missing.jpg', id: 'w1' }, windowsStill: null });
    const r = await ws.full();
    check('look: a record whose still will not open falls through (here to the no-picture reason)', !r.ok && /no picture of Windows/.test(r.reason || ''), JSON.stringify(r).slice(0, 160));
  }
  // ---- the desktop's panes: dark falls back to the still, light keeps its capture (deskPick) -----------
  {
    const wall = { ok: true, png: 'data:image/png;base64,WALL', w: 768, h: 432, rect: { x: 0, y: 0, w: 1920, h: 1080 }, ms: 3, source: 'look' };
    const cap = { png: 'data:image/png;base64,CAP8', w: 240, h: 135, rect: { x: 0, y: 0, w: 1920, h: 1080 }, ms: 40, source: 'screen' };
    const a = WS.deskPick({ dark: true, wall, fresh: cap, last: null, shown: null });
    check('deskPick: dark with a still: the panes get the still (not the 1/8 capture)', a.send && a.send.png === wall.png && a.shown === 'wall' && a.source === 'look' && a.send.w === 768, JSON.stringify(a));
    const b = WS.deskPick({ dark: true, wall: { ok: false, reason: 'a web wallpaper' }, fresh: cap, last: null, shown: null });
    check('deskPick: dark without a still: the fresh capture, as before', b.send === cap && b.shown === 'capture', JSON.stringify(b));
    const c = WS.deskPick({ dark: true, wall: { ok: false, reason: 'gone' }, fresh: null, last: cap, shown: 'wall' });
    check('deskPick: dark, the still lost while the page holds it: the kept capture goes back', c.send === cap && c.shown === 'capture', JSON.stringify(c));
    const d = WS.deskPick({ dark: false, wall: null, fresh: cap, last: null, shown: null });
    check('deskPick: light: the fresh capture, exactly as light always sent it', d.send === cap && d.shown === 'capture', JSON.stringify(d));
    const e = WS.deskPick({ dark: false, wall: null, fresh: null, last: cap, shown: 'wall' });
    check('deskPick: a flip to light puts the kept capture back', e.send === cap && e.shown === 'capture', JSON.stringify(e));
    const f = WS.deskPick({ dark: false, wall: null, fresh: null, last: cap, shown: 'capture' });
    check('deskPick: light with the capture already on the page: nothing is re-sent', f.send === null && f.shown === 'capture', JSON.stringify(f));
    const g = WS.deskPick({ dark: false, wall, fresh: cap, last: null, shown: null });
    check('deskPick: light never uses a still, even when one is handed in', g.send === cap, JSON.stringify(g));
  }
})().catch((err) => {
  failures.push('crashed: ' + (err && err.stack ? err.stack.split('\n').slice(0, 3).join(' / ') : err));
}).finally(() => {
  for (const f of failures) console.log('  FAIL ' + f);
  console.log(`WALL STILL TEST: ${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
});

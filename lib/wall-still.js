'use strict';
/*
 * wall-still.js -- the WALLPAPER under any rectangle of the screen, for dark glass (lane helm-wall,
 * 2026-10-09).
 *
 * Owen, about dark Mantle: "you need to get the see through to look just like helm". Helm's window is
 * opaque and paints its OWN copy of the photo, blurred 5px, under its wash and its panels (helm
 * ui/shell/shell.css .bg-photo / .bg-wash), so a Helm panel never shows the windows behind it, only
 * the blurred photo. v1's dark pop-ups, HUDs and bars blurred a SCREEN CAPTURE of whatever was behind
 * them (other windows, text). This is the one source every dark glass surface uses instead: the
 * wallpaper as Mantle's desktop shows it, cut to that surface's rectangle. No screen capture, no
 * content protection, nothing of Owen's other windows.
 *
 * WHERE THE PICTURE COMES FROM, in order:
 *  1. Mantle's own wallpaper. The desktop layer's page draws its wallpaper element (#wall > .wall-media:
 *     a picture, a GIF's frame or a video's current frame) ONCE onto a canvas at 1/SCALE of its CSS
 *     size, with the same object-fit / object-position / filter the desktop uses, and hands back a PNG
 *     (pageStill below, run with executeJavaScript). Not capturePage(): the desktop's panes and widgets
 *     live on that page and Helm shows only the photo. The page keeps nothing; main keeps the still and
 *     re-asks only when the page's key (element, url, fit, filter, size) changes.
 *  2. No Mantle wallpaper (none chosen, or it failed to load): Windows' own wallpaper, which is exactly
 *     what the desktop layer's one-shot 'desktop.backdrop' picture is (main.js desktopBackdrop: taken
 *     with the layer hidden). Coarser (1/8 scale), and said so in `source`.
 *  3. A web wallpaper (a sandboxed iframe) or a video whose frame cannot be read back: there is no
 *     still. The answer says so ({ok:false, capture:true, reason}); a caller that had v1's screen
 *     capture may fall back to it and say so, the rest keep their fallback face with the reason.
 *
 * THE CUT. rect(phys) resamples the still bilinearly at the rectangle's exact (fractional) position,
 * so the PNG covers precisely the asked rectangle (clipped to the display): a page that stretches it
 * over its pane is registered to the pixel, and `rect` in the answer is what it covers.
 *
 * COST. The page is asked at most once a RECHECK_MS (it answers "same" in a millisecond or two); a cut
 * is a JS resample plus one PNG encode. Nothing here runs on a timer.
 *
 * Primary display only, like the desktop layer itself (lib/windows.js createDesktop) and clampToDisplay
 * in main.js: a rectangle on another display answers {ok:false, reason}.
 *
 * makeWallStill(o):
 *   o.desktopWin()     the desktop layer's BrowserWindow or null
 *   o.windowsStill()   the last 'desktop.backdrop' shot {png, w, h, rect} (Windows' wallpaper) or null
 *   o.wallpaper()      State.wallpaper ({id, ok, reason, ...}) or null
 *   o.display()        {dip:{x,y,width,height}, phys:{x,y,w,h}} of the primary display
 *   o.nativeImage      electron's nativeImage
 *   o.dark()           true in dark (the only theme this answers in)
 *   o.log(line)
 *   o.encode(bgra,w,h) OPTIONAL, tests only: the cut's PNG encoder (default encodePng below)
 * -> { full(), rect(phys, opts), strip(h), onChange(fn), invalidate(why), watch(), sig(), peek() }
 * Never throws.
 */

const SCALE = 2;            // the still: the desktop's CSS px / 2 (768x432 on a 1536x864 DIP display)
const RECHECK_MS = 1000;    // the page is asked again at most this often

/*
 * Runs INSIDE the desktop layer's page (executeJavaScript, stringified: it may use nothing outside
 * itself). Returns {ok, key, png, w, h, vw, vh, kind, covers} | {same, key} | {none|web|wait|err, why}.
 */
/* eslint-disable no-var */
function pageStill(scale, lastKey, dispW, dispH) {
  try {
    var body = document.body;
    var el = document.querySelector('#wall > .wall-media');
    if (!body || !body.classList.contains('has-wall') || !el) return { none: true, why: 'the desktop draws no Mantle wallpaper' };
    if (el.tagName === 'IFRAME') return { web: true, why: 'the wallpaper is a web page, and Mantle cannot read a still picture of one' };
    var video = el.tagName === 'VIDEO';
    var nw = video ? el.videoWidth : el.naturalWidth, nh = video ? el.videoHeight : el.naturalHeight;
    if (!nw || !nh || !el.classList.contains('on')) return { wait: true, why: 'the wallpaper has not drawn its first frame yet' };
    var cs = getComputedStyle(el);
    var fit = cs.objectFit || 'fill';
    var pos = String(cs.objectPosition || '50% 50%').split(/\s+/);
    var filt = cs.filter && cs.filter !== 'none' ? cs.filter : 'none';
    // laid out on the DISPLAY's size (live, the desktop layer IS the display; a --test desktop is an
    // ordinary window of another size, and its viewport would stretch the still over the display)
    var vw = dispW > 0 ? dispW : innerWidth, vh = dispH > 0 ? dispH : innerHeight;
    var key = [el.tagName, el.currentSrc || el.src, fit, pos.join(' '), filt, vw, vh, nw, nh, scale].join('|');
    if (key === lastKey) return { same: true, key: key };
    var dw = vw, dh = vh;
    if (fit !== 'fill') {
      var cover = Math.max(vw / nw, vh / nh), contain = Math.min(vw / nw, vh / nh);
      var s = fit === 'contain' ? contain : fit === 'none' ? 1 : fit === 'scale-down' ? Math.min(1, contain) : cover;
      dw = nw * s; dh = nh * s;
    }
    var frac = function (t) { var n = parseFloat(t); return /%$/.test(t) && isFinite(n) ? n / 100 : 0.5; };
    var dx = (vw - dw) * frac(pos[0] || '50%'), dy = (vh - dh) * frac(pos[1] || pos[0] || '50%');
    var W = Math.max(1, Math.round(vw / scale)), H = Math.max(1, Math.round(vh / scale));
    var c = document.createElement('canvas');
    c.width = W; c.height = H;
    var g = c.getContext('2d');
    g.fillStyle = '#000';
    g.fillRect(0, 0, W, H);
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.filter = filt;
    g.drawImage(el, dx / scale, dy / scale, dw / scale, dh / scale);
    g.filter = 'none';
    var png = c.toDataURL('image/png');
    return { ok: true, key: key, png: png, w: W, h: H, vw: vw, vh: vh, kind: video ? 'video' : 'picture', covers: dw >= vw - 0.5 && dh >= vh - 0.5 };
  } catch (e) {
    return { err: true, why: (e && e.name === 'SecurityError' ? 'the wallpaper\'s frame cannot be read back: ' : 'the desktop could not draw a still of its wallpaper: ') + (e && e.message ? e.message : String(e)) };
  }
}
/* eslint-enable no-var */

/**
 * Pure: bilinear resample of a 4-byte-per-pixel bitmap `src` (sw x sh) over the source rectangle
 * (sx, sy, sWidth, sHeight) in SOURCE pixels (fractional), into ow x oh. Edges clamp.
 */
function resample(src, sw, sh, sx, sy, sWidth, sHeight, ow, oh) {
  const out = Buffer.alloc(ow * oh * 4);
  const kx = sWidth / ow, ky = sHeight / oh;
  for (let j = 0; j < oh; j++) {
    let fy = sy + (j + 0.5) * ky - 0.5;
    if (fy < 0) fy = 0; else if (fy > sh - 1) fy = sh - 1;
    const y0 = Math.floor(fy), y1 = Math.min(sh - 1, y0 + 1), ty = fy - y0;
    const r0 = y0 * sw * 4, r1 = y1 * sw * 4;
    for (let i = 0; i < ow; i++) {
      let fx = sx + (i + 0.5) * kx - 0.5;
      if (fx < 0) fx = 0; else if (fx > sw - 1) fx = sw - 1;
      const x0 = Math.floor(fx), x1 = Math.min(sw - 1, x0 + 1), tx = fx - x0;
      const a = r0 + x0 * 4, b = r0 + x1 * 4, c = r1 + x0 * 4, d = r1 + x1 * 4;
      const o = (j * ow + i) * 4;
      for (let k = 0; k < 4; k++) {
        const top = src[a + k] + (src[b + k] - src[a + k]) * tx;
        const bot = src[c + k] + (src[d + k] - src[c + k]) * tx;
        out[o + k] = Math.round(top + (bot - top) * ty);
      }
    }
  }
  return out;
}

/*
 * Pure: a PNG data URL of a BGRA bitmap (nativeImage.toBitmap()'s order on Windows), filter Sub,
 * deflate level 1. WHY not nativeImage.createFromBitmap().toDataURL(): measured in a dark test instance
 * (lane helm-wall-proof, 2026-10-09) Electron's encoder took ~165 ms for a 768x432 cut (the top bar's
 * menu picture: 177 ms median, slower than v1's capture at 81 + 25 ms); this one takes ~20 ms for the
 * same picture (~480 KB data URL). The picture is blurred by every page that shows it, so speed wins
 * over the last 30% of size.
 */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}
function encodePng(bgra, w, h) {
  const stride = w * 4, raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    const o = y * (stride + 1), s = y * stride;
    raw[o] = 1;                                   // Sub: each byte minus the one 4 to its left
    for (let x = 0; x < w; x++) {
      const i = s + x * 4, d = o + 1 + x * 4;
      const r = bgra[i + 2], g = bgra[i + 1], b = bgra[i], a = bgra[i + 3];
      if (x) { const p = i - 4; raw[d] = (r - bgra[p + 2]) & 255; raw[d + 1] = (g - bgra[p + 1]) & 255; raw[d + 2] = (b - bgra[p]) & 255; raw[d + 3] = (a - bgra[p + 3]) & 255; }
      else { raw[d] = r; raw[d + 1] = g; raw[d + 2] = b; raw[d + 3] = a; }
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;   // 8-bit RGBA
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', ihdr),
    pngChunk('IDAT', require('zlib').deflateSync(raw, { level: 1 })), pngChunk('IEND', Buffer.alloc(0))]);
  return 'data:image/png;base64,' + png.toString('base64');
}

/** Pure: a rectangle clipped to another, or null when they do not meet. Both {x,y,w,h}. */
function clip(r, to) {
  const x0 = Math.max(r.x, to.x), y0 = Math.max(r.y, to.y);
  const x1 = Math.min(r.x + r.w, to.x + to.w), y1 = Math.min(r.y + r.h, to.y + to.h);
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

/** Pure: what about State.wallpaper means "look again". */
function wallSig(wp) {
  if (!wp) return 'none';
  return `${wp.id || ''}|${wp.ok ? 1 : 0}|${wp.reason || ''}`;
}

function makeWallStill(o) {
  let cache = null;            // {key, src, png, bmp, w, h, dip, phys, sig, ms, kind, covers}
  let lastFail = null;         // {reason, capture}
  let checkedAt = 0;
  let loading = null;
  let seenSig = null;
  const followers = new Set();
  const say = (l) => { try { o.log(l); } catch (_) { /* a log line is never worth a failure */ } };
  const encode = typeof o.encode === 'function' ? o.encode : encodePng;   // o.encode: the tests' fake

  function notify(why) {
    for (const fn of followers) { try { fn(why); } catch (e) { say(`a follower threw: ${e && e.message}`); } }
  }

  function build(png, src, key, extra) {
    let img;
    try { img = o.nativeImage.createFromDataURL(png); } catch (e) { return { ok: false, reason: `the wallpaper still would not decode: ${e.message}` }; }
    if (!img || img.isEmpty()) return { ok: false, reason: 'the wallpaper still decoded empty' };
    const sz = img.getSize();
    let disp;
    try { disp = o.display(); } catch (e) { return { ok: false, reason: `the display's size could not be read: ${e.message}` }; }
    const was = cache && cache.key;
    cache = Object.assign({ key, src, png, bmp: img.toBitmap(), w: sz.width, h: sz.height, dip: disp.dip, phys: disp.phys, at: Date.now() }, extra || {});
    lastFail = null;
    if (was !== key) {
      say(`the glass now shows ${src === 'mantle' ? 'Mantle\'s wallpaper' : 'Windows\' wallpaper'} (${sz.width}x${sz.height} still${extra && extra.kind ? `, ${extra.kind}` : ''})`);
      notify(`the wallpaper picture changed (${src})`);
    }
    return { ok: true };
  }

  async function load() {
    const t0 = Date.now();
    const wp = (() => { try { return o.wallpaper(); } catch (_) { return null; } })();
    const sig = wallSig(wp);
    let page;
    const win = (() => { try { return o.desktopWin(); } catch (_) { return null; } })();
    if (win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
      const last = cache && cache.src === 'mantle' ? cache.key : '';
      let dw = 0, dh = 0;
      try { const d = o.display(); dw = Math.round(d.dip.width); dh = Math.round(d.dip.height); } catch (_) { /* the page's own size */ }
      try {
        page = await win.webContents.executeJavaScript(`(${pageStill.toString()})(${SCALE}, ${JSON.stringify(last)}, ${dw}, ${dh})`);
      } catch (e) {
        page = { err: true, why: `the desktop layer would not draw its wallpaper: ${e && e.message ? e.message : e}` };
      }
    } else {
      page = { none: true, gone: true, why: 'there is no desktop layer to read the wallpaper from' };
    }
    checkedAt = Date.now();
    if (!page || typeof page !== 'object') page = { err: true, why: 'the desktop layer answered with nothing' };
    if (page.same && cache) { cache.sig = sig; return { ok: true }; }
    if (page.ok && typeof page.png === 'string') {
      const r = build(page.png, 'mantle', page.key, { sig, ms: Date.now() - t0, kind: page.kind, covers: page.covers });
      return r;
    }
    if (page.web || page.err) {
      // a still cannot be had: nothing stale is kept (it would be the previous wallpaper)
      if (cache) { cache = null; notify(`no wallpaper still: ${page.why}`); }
      lastFail = { reason: page.why, capture: true };
      return { ok: false, reason: page.why, capture: true };
    }
    if (page.wait) {
      // a wallpaper that is loading: the last still of the SAME wallpaper is still right
      if (cache && cache.src === 'mantle' && cache.sig && cache.sig.split('|')[0] === sig.split('|')[0]) return { ok: true };
      lastFail = { reason: page.why, transient: true };
      return { ok: false, reason: page.why, transient: true };
    }
    // none: the desktop draws no Mantle wallpaper. If one is chosen and merely unloaded (a game is
    // running), its last still is still the truth; otherwise Windows' own wallpaper.
    if (cache && cache.src === 'mantle' && wp && wp.id && cache.sig && cache.sig.split('|')[0] === String(wp.id) && wp.ok) return { ok: true };
    const ws = (() => { try { return o.windowsStill(); } catch (_) { return null; } })();
    if (ws && typeof ws.png === 'string' && ws.png.slice(0, 5) === 'data:') {
      const key = `windows|${ws.png.length}|${ws.png.slice(-48)}`;
      if (cache && cache.key === key) { cache.sig = sig; return { ok: true }; }
      return build(ws.png, 'windows', key, { sig, ms: Date.now() - t0, kind: 'Windows\' wallpaper, 1/8 scale', covers: true });
    }
    const reason = `there is no wallpaper picture: ${page.why}, and no picture of Windows' wallpaper has been taken`;
    if (cache) { cache = null; notify(reason); }
    lastFail = { reason };
    return { ok: false, reason };
  }

  /** The still is current (asking the page at most once a RECHECK_MS). -> {ok} | {ok:false, reason, capture?} */
  async function ensure() {
    if (!o.dark()) return { ok: false, reason: 'light: the glass keeps its own face, no wallpaper picture is used' };
    const wp = (() => { try { return o.wallpaper(); } catch (_) { return null; } })();
    if (cache && cache.sig === wallSig(wp) && Date.now() - checkedAt < RECHECK_MS) return { ok: true };
    if (!cache && lastFail && !lastFail.transient && Date.now() - checkedAt < RECHECK_MS && seenSig === wallSig(wp)) {
      return Object.assign({ ok: false }, lastFail);
    }
    seenSig = wallSig(wp);
    if (!loading) loading = load().catch((e) => ({ ok: false, reason: `the wallpaper still failed: ${e && e.message ? e.message : e}` })).finally(() => { loading = null; });
    return loading;
  }

  async function full() {
    const t0 = Date.now();
    const r = await ensure();
    if (!r.ok || !cache) return { ok: false, reason: r.reason || 'there is no wallpaper picture', capture: !!r.capture };
    return { ok: true, png: cache.png, w: cache.w, h: cache.h, display: Object.assign({}, cache.dip), source: cache.src, key: cache.key, ms: Date.now() - t0 };
  }

  /**
   * The wallpaper under a PHYSICAL-pixel rectangle, resampled so the PNG covers exactly `rect` in the
   * answer (the asked one, clipped to the display). opts.scale: physical px per output px (default:
   * the still's own pitch, so nothing is thrown away and nothing is invented).
   */
  async function rect(phys, opts) {
    const t0 = Date.now();
    if (!phys || !(phys.w > 0) || !(phys.h > 0)) return { ok: false, reason: 'there is no rectangle to cut the wallpaper to' };
    const r = await ensure();
    if (!r.ok || !cache) return { ok: false, reason: r.reason || 'there is no wallpaper picture', capture: !!r.capture };
    const c = cache;
    const got = clip(phys, c.phys);
    if (!got) return { ok: false, reason: `the rectangle ${phys.x},${phys.y} ${phys.w}x${phys.h} is not on the display the wallpaper covers (${c.phys.x},${c.phys.y} ${c.phys.w}x${c.phys.h})` };
    const fx = c.w / c.phys.w, fy = c.h / c.phys.h;
    const pitch = opts && opts.scale > 0 ? opts.scale : 1 / fx;
    const ow = Math.max(1, Math.round(got.w / pitch)), oh = Math.max(1, Math.round(got.h / pitch));
    let png;
    try {
      if (ow === c.w && oh === c.h && got.x === c.phys.x && got.y === c.phys.y && got.w === c.phys.w && got.h === c.phys.h) {
        png = c.png;                              // the whole still at its own pitch: it IS the cut (the top bar's menu, full height)
      } else {
        const buf = resample(c.bmp, c.w, c.h, (got.x - c.phys.x) * fx, (got.y - c.phys.y) * fy, got.w * fx, got.h * fy, ow, oh);
        png = encode(buf, ow, oh);
      }
    } catch (e) {
      return { ok: false, reason: `the wallpaper could not be cut to ${got.w}x${got.h}: ${e.message}` };
    }
    return { ok: true, png, w: ow, h: oh, rect: got, source: c.src, key: c.key, ms: Date.now() - t0 };
  }

  return {
    full,
    rect,
    /** The top `h` DIP of the display: the top bar's strip (lib/features/_topbar-glass.js shape). */
    async strip(h) {
      let disp;
      try { disp = o.display(); } catch (e) { return { ok: false, reason: `the display's size could not be read: ${e.message}` }; }
      const hh = Math.max(1, Math.round(Number(h) || 28));
      const ph = Math.max(1, Math.round(disp.phys.h * hh / disp.dip.height));
      const r = await rect({ x: disp.phys.x, y: disp.phys.y, w: disp.phys.w, h: ph });
      if (!r.ok) return r;
      return { ok: true, png: r.png, under: null, opaque: true, w: r.w, h: r.h, ms: r.ms, source: r.source,
        rect: { x: 0, y: 0, width: disp.dip.width, height: hh } };
    },
    onChange(fn) {
      if (typeof fn !== 'function') throw new Error('wall.onChange needs a function');
      followers.add(fn);
      return () => followers.delete(fn);
    },
    /** Forget the still (Windows' wallpaper re-shot, a display change); followers hear on the next load. */
    invalidate(why) {
      checkedAt = 0;
      if (cache) { cache.sig = null; say(`re-reading the wallpaper still: ${why}`); }
      if (followers.size && o.dark()) ensure().then((r) => { if (r && r.ok) notify(why); }, () => {});
    },
    /** Call on every State change: a different wallpaper (or one that just drew) is looked at again. */
    watch() {
      let wp = null;
      try { wp = o.wallpaper(); } catch (_) { wp = null; }
      const s = wallSig(wp);
      if (s === seenSig || !o.dark() || !followers.size) return;
      ensure().then(() => {}, () => {});
    },
    /**
     * LOOK SYNC (lane looksync-mantle, 2026-10-10): the wallpaper's CURRENT frame at FULL scale (the
     * display's physical pixels), for the still Mantle publishes to Helm and Quartz (lib/look-desktop.js).
     * The same page drawing as full() (pageStill: the wall element with the desktop's own fit, position
     * and filter, no panes or widgets), asked once per call at 1/scaleFactor instead of 1/SCALE, in
     * EITHER theme, and kept nowhere. -> {ok, png (data URL), w, h, kind} | {ok:false, reason, web?, wait?}
     */
    async frame() {
      const win = (() => { try { return o.desktopWin(); } catch (_) { return null; } })();
      if (!win || win.isDestroyed() || !win.webContents || win.webContents.isDestroyed()) return { ok: false, reason: 'the desktop layer is not there' };
      let disp;
      try { disp = o.display(); } catch (e) { return { ok: false, reason: `the display's size could not be read: ${e.message}` }; }
      const dw = Math.round(disp.dip.width), dh = Math.round(disp.dip.height);
      const sf = dw > 0 && disp.phys && disp.phys.w > 0 ? disp.phys.w / dw : 1;
      let page;
      try {
        page = await win.webContents.executeJavaScript(`(${pageStill.toString()})(${1 / sf}, null, ${dw}, ${dh})`);
      } catch (e) {
        return { ok: false, reason: `the desktop layer would not draw its wallpaper: ${e && e.message ? e.message : e}` };
      }
      if (page && page.ok && typeof page.png === 'string') return { ok: true, png: page.png, w: page.w, h: page.h, kind: page.kind };
      return { ok: false, reason: (page && page.why) || 'the desktop layer drew no frame and did not say why', web: !!(page && page.web), wait: !!(page && page.wait) };
    },
    sig: () => (cache ? cache.key : null),
    peek: () => (cache ? { key: cache.key, src: cache.src, w: cache.w, h: cache.h, dip: cache.dip, phys: cache.phys, kind: cache.kind, covers: cache.covers, ms: cache.ms }
      : { key: null, fail: lastFail }),
  };
}

module.exports = { makeWallStill, pageStill, resample, clip, wallSig, encodePng, SCALE, RECHECK_MS };

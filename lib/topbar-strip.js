'use strict';
/*
 * topbar-strip.js -- the picture under the top bar, read from the desktop layer's own page
 * (lane see-topbar, 2026-10-09). The user, on dark Mantle over his mountain wallpaper: "mantle needs to
 * be more see through everything"; his top bar read as a near-solid black strip, because it had no
 * blurred backdrop at all (one flat --lg-fill-fb) and a thinner flat tint would only have shown the
 * wallpaper SHARP through it, not frosted.
 *
 * WHAT IS BEHIND THE TOP BAR. Live, the bar is a registered top app bar on the primary display: the
 * work area starts below it, so no maximised or snapped window is ever under it. What is under it is
 * the desktop layer (lib/windows.js createDesktop: the primary display's bounds, under the icons), and
 * that page draws Mantle's own wallpaper at the bottom of its stack (lib/wallpaper.js: a picture, a
 * gif, a video or a web page). Where the page draws nothing (no Mantle wallpaper, or one that failed),
 * Windows' own wallpaper shows through it, and the desktop layer's one-shot 'desktop.backdrop' picture
 * (main.js desktopBackdrop, 1/8 scale, taken with the layer hidden) is exactly that.
 *
 * SO NO SCREEN CAPTURE. webContents.capturePage() hands back the desktop PAGE's own last frame for a
 * rectangle: the wallpaper as Mantle draws it, video frame included, with no sidecar call, no content
 * protection (the bottom bar has to hide itself from its own capture; nothing here can photograph
 * the top bar, which is a different window) and nothing taken from the user's other windows. main.js has
 * CalculateNativeWinOcclusion off, so the layer keeps rendering while windows cover it.
 *
 * read({h}) -> {ok, png, under, opaque, w, h, ms, rect} | {ok:false, transient?, reason}
 *   png     the strip, 1/4 scale, as a PNG data URL (the page blurs it 12 px: small is free)
 *   under   the top rows of Windows' wallpaper picture, ONLY when the page left part of the strip
 *           transparent (Windows' wallpaper shows through there); the page layers png over it
 *   transient  a miss worth no fallback (the layer hidden for a moment, an empty frame)
 * Never throws.
 */

const SCALE = 4;            // downscale of the strip; the page blurs it 12 px anyway
const OPAQUE_MIN = 250;     // every pixel's alpha at least this: the page draws the whole strip

/** Pure: the smallest alpha in a BGRA (or RGBA) buffer; 255 for an empty one. */
function minAlpha(buf) {
  let m = 255;
  if (!buf) return m;
  for (let i = 3; i < buf.length; i += 4) if (buf[i] < m) { m = buf[i]; if (m === 0) break; }
  return m;
}

/** Pure: how many rows of a still picture of the whole layer are its top `stripH` DIP. */
function stillRows(stillH, stripH, layerH) {
  if (!(stillH > 0) || !(layerH > 0)) return 0;
  return Math.max(1, Math.min(stillH, Math.round(stillH * Math.max(0, stripH) / layerH)));
}

/**
 * o.win()        the desktop layer's BrowserWindow, looked up late (it is remade after an Explorer restart)
 * o.still()      the desktop layer's last 'desktop.backdrop' payload {png} or null
 * o.nativeImage  electron's nativeImage (for the still's crop)
 */
function makeStripReader(o) {
  async function read(a) {
    const t0 = Date.now();
    const win = o.win();
    if (!win || win.isDestroyed()) return { ok: false, reason: 'there is no desktop layer under the top bar to read the wallpaper from' };
    let visible = true;
    try { visible = win.isVisible(); } catch (_) { visible = false; }
    // main hides the layer for ~60 ms to re-shoot Windows' wallpaper: keep the last picture
    if (!visible) return { ok: false, transient: true, reason: 'the desktop layer is hidden for a moment' };
    let b;
    try { b = win.getContentBounds(); } catch (e) { return { ok: false, reason: `the desktop layer's size could not be read: ${e.message}` }; }
    const hDip = Math.max(1, Math.min(b.height, Math.round(Number(a && a.h) || 28)));
    const rect = { x: 0, y: 0, width: b.width, height: hDip };
    let img;
    try { img = await win.webContents.capturePage(rect); } catch (e) {
      return { ok: false, reason: `the desktop layer would not hand over its top strip: ${e.message}` };
    }
    if (!img || img.isEmpty()) return { ok: false, transient: true, reason: 'the desktop layer handed back an empty picture of its top strip' };
    const sz = img.getSize();
    const small = img.resize({ width: Math.max(1, Math.round(sz.width / SCALE)), height: Math.max(1, Math.round(sz.height / SCALE)), quality: 'good' });
    const ss = small.getSize();
    const bmp = small.toBitmap();
    const minA = minAlpha(bmp);
    let under = null;
    if (minA < OPAQUE_MIN) {
      // the page leaves (part of) the strip transparent, so Windows' own wallpaper is what shows there
      const st = o.still();
      if (!st || typeof st.png !== 'string' || st.png.slice(0, 5) !== 'data:') {
        if (allClear(bmp)) {
          return { ok: false, reason: 'the desktop layer draws no wallpaper under the top bar and there is no picture of Windows\' wallpaper to use instead' +
            (st && st.reason ? ` (${st.reason})` : '') };
        }
      } else {
        try {
          const still = o.nativeImage.createFromDataURL(st.png);
          const s2 = still.getSize();
          const rows = stillRows(s2.height, hDip, b.height);
          if (rows > 0 && s2.width > 0) under = still.crop({ x: 0, y: 0, width: s2.width, height: rows }).toDataURL();
        } catch (e) {
          return { ok: false, reason: `the picture of Windows' wallpaper could not be cut to the top bar's strip: ${e.message}` };
        }
      }
    }
    return { ok: true, png: small.toDataURL(), under, opaque: minA >= OPAQUE_MIN, w: ss.width, h: ss.height, ms: Date.now() - t0, rect };
  }
  return { read };
}

/** Pure: every pixel fully transparent. */
function allClear(buf) {
  if (!buf) return true;
  for (let i = 3; i < buf.length; i += 4) if (buf[i] !== 0) return false;
  return true;
}

module.exports = { makeStripReader, minAlpha, stillRows, allClear, SCALE, OPAQUE_MIN };

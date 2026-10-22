'use strict';
/* topbar-under.test.js -- the top bar takes the colour of the window under it (lane mantle-topbar-under,
 * 2026-10-11): main's sampler (lib/topbar-under.js: stop conditions, the strip, column maths, the window
 * cover, the protected-black fallback, the PNG reader, the loop with a fake clock) and the page's pure plan
 * (ui/topbar/under.js: the pull, the ink per item with hysteresis, 4.5:1, the bottom row). Plain node.
 *   node lib/topbar-under.test.js   -> "TOPBAR UNDER TEST: n passed, m failed" */
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const U = require('./topbar-under');
const GL = require('./features/_topbar-glass');
const P = require(path.join(__dirname, '..', 'ui', 'topbar', 'under.js'));
const GA = require(path.join(__dirname, '..', 'ui', 'shared', 'glass-adapt.js'));

let passed = 0;
const failures = [];
const check = (name, ok, detail) => { if (ok) passed++; else failures.push(detail !== undefined ? `${name} (${typeof detail === 'string' ? detail : JSON.stringify(detail)})` : name); };

/* a PNG writer for the reader's tests: 8-bit RGB or RGBA, every row with its own filter */
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(px, w, h, bpp, filters) {
  const stride = w * bpp, raw = Buffer.alloc(h * (stride + 1));
  for (let y = 0; y < h; y++) {
    const f = filters ? filters[y % filters.length] : 0;
    raw[y * (stride + 1)] = f;
    for (let x = 0; x < stride; x++) {
      const v = px[y * stride + x];
      const a = x >= bpp ? px[y * stride + x - bpp] : 0, b = y > 0 ? px[(y - 1) * stride + x] : 0, c = x >= bpp && y > 0 ? px[(y - 1) * stride + x - bpp] : 0;
      let pred = 0;
      if (f === 1) pred = a; else if (f === 2) pred = b; else if (f === 3) pred = (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      raw[y * (stride + 1) + 1 + x] = (v - pred) & 255;
    }
  }
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = bpp === 4 ? 6 : 2;
  return 'data:image/png;base64,' + Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]).toString('base64');
}
/* a row of n columns of colour, `per` px each, as RGB */
function rowPx(colours, per) {
  const out = [];
  for (const c of colours) for (let i = 0; i < per; i++) out.push(c[0], c[1], c[2]);
  return out;
}

/* the token values, read from the stylesheet the page uses (dark block) */
const css = fs.readFileSync(path.join(__dirname, '..', 'ui', 'shared', 'glass-light.css'), 'utf8');
const darkBlock = css.slice(css.indexOf(':root[data-theme="dark"]'));
const lightBlock = css.slice(css.indexOf(':root {'), css.indexOf(':root[data-theme="dark"]'));
const tok = (block, name) => { const m = new RegExp(`${name}:\\s*([^;]+);`).exec(block); const c = m && GA.parseColor(m[1].trim()); return c ? [c.r, c.g, c.b] : null; };
const T = {
  light: [tok(darkBlock, '--lg-ink'), tok(darkBlock, '--lg-ink-2')],
  dark: [tok(darkBlock, '--lg-ink-on-light'), tok(darkBlock, '--lg-ink-2-on-light')],
  warnL: tok(darkBlock, '--lg-warn'), warnD: tok(darkBlock, '--lg-warn-on-light'),
  scrimL: tok(darkBlock, '--lg-fill-bar'), scrimD: tok(darkBlock, '--lg-lift'),
};

(async () => {
  /* ---- the tokens: the dark block's on-light inks ARE the light block's ---- */
  check('tokens: every one the page reads is in the dark block', [...T.light, ...T.dark, T.warnL, T.warnD, T.scrimL, T.scrimD].every(Boolean), T);
  for (const [a, b] of [['--lg-ink-on-light', '--lg-ink'], ['--lg-ink-2-on-light', '--lg-ink-2'], ['--lg-ink-3-on-light', '--lg-ink-3'], ['--lg-warn-on-light', '--lg-warn'], ['--lg-acc-on-light', '--lg-acc'], ['--lg-hover-on-light', '--lg-hover'], ['--lg-press-on-light', '--lg-press']]) {
    const da = /:\s*([^;]+);/.exec(darkBlock.slice(darkBlock.indexOf(a + ':')))[1].trim().toLowerCase();
    const lb = /:\s*([^;]+);/.exec(lightBlock.slice(lightBlock.indexOf(b + ':')))[1].trim().toLowerCase();
    check(`tokens: ${a} is the light block's ${b}`, da === lb, `${da} vs ${lb}`);
  }
  check('tokens: the light block has none of the new names (it stays as it was)', !/on-light|--lg-lift/.test(lightBlock));

  /* ---- want: the stop conditions ---- */
  const base = { dark: true, visible: true, pageOk: true, peek: false, cover: false, lock: false, quiet: null, menuOpen: false, stopped: false };
  const w = (p) => U.want(Object.assign({}, base, p));
  check('want: dark, shown, nothing in the way -> on', w({}).on === true);
  check('want: light -> off, nothing read', !w({ dark: false }).on && /light/.test(w({ dark: false }).why));
  check('want: hidden (a game, a video, by hand) -> off', !w({ visible: false }).on);
  check('want: a peek -> off', !w({ peek: true }).on);
  check('want: a full-screen window under the bar -> off', !w({ cover: true }).on && /full-screen/.test(w({ cover: true }).why));
  check('want: the lock screen in front -> off', !w({ lock: true }).on);
  check('want: screen off / locked (stats pause) -> off, the paint kept', !w({ quiet: 'the screen is off' }).on && w({ quiet: 'the screen is off' }).keep === true && /screen is off/.test(w({ quiet: 'the screen is off' }).why));
  check('want: a menu open -> off, the paint kept', !w({ menuOpen: true }).on && w({ menuOpen: true }).keep === true);
  check('want: stopping / page not loaded -> off', !w({ stopped: true }).on && !w({ pageOk: false }).on);
  check('want: null -> off', U.want(null).on === false);

  /* ---- the glass rests under a full cover, kept ---- */
  const gb = { dark: true, visible: true, pageOk: true, live: true, reserved: true, peek: false, cover: false, stopped: false };
  const gu = GL.want(Object.assign({}, gb, { under: true }));
  check('glass want: a window over the whole row -> off, picture kept', gu.on === false && gu.keep === true, gu);
  check('glass want: no under -> on as before', GL.want(gb).on === true);

  /* ---- the strip ---- */
  check('colCount: 1920 px -> 240 columns of 8', U.colCount(1920) === 240);
  check('colCount: capped and at least 1', U.colCount(100000) === U.MAX_COLS && U.colCount(0) === 1);
  const sr = U.stripRect({ x: 0, y: 0, width: 1920, height: 35 }, { x: 0, y: 0, width: 1920, height: 1080 });
  check('stripRect: the ONE row right under a 35 px bar', sr && sr.x === 0 && sr.y === 35 && sr.w === 1920 && sr.h === 1, sr);
  check('stripRect: clipped to its display', (() => { const r = U.stripRect({ x: -10, y: 0, width: 1940, height: 35 }, { x: 0, y: 0, width: 1920, height: 1080 }); return r.x === 0 && r.w === 1920; })());
  check('stripRect: a bar at the bottom of its screen has no row under it', U.stripRect({ x: 0, y: 1045, width: 1920, height: 35 }, { x: 0, y: 0, width: 1920, height: 1080 }) === null);
  check('stripRect: a second display at negative x', (() => { const r = U.stripRect({ x: -1920, y: 0, width: 1920, height: 30 }, { x: -1920, y: 0, width: 1920, height: 1080 }); return r && r.x === -1920 && r.y === 30; })());

  /* ---- columns ---- */
  const rgba = Buffer.from([10, 20, 30, 255, 30, 40, 50, 255, 200, 100, 0, 255, 100, 50, 0, 255]);
  const c2 = U.columnsOf(rgba, 4, 1, 2, 'rgba');
  check('columnsOf: rgba, 2 px per column averaged', c2[0] === 20 && c2[1] === 30 && c2[2] === 40 && c2[3] === 150 && c2[4] === 75 && c2[5] === 0, Array.from(c2));
  const bgra = Buffer.from([30, 20, 10, 255, 50, 40, 30, 255]);
  const cb = U.columnsOf(bgra, 2, 1, 1, 'bgra');
  check('columnsOf: bgra puts red first', cb[0] === 20 && cb[1] === 30 && cb[2] === 40, Array.from(cb));
  const two = Buffer.from([0, 0, 0, 100, 100, 100]);
  check('columnsOf: rows are averaged too (rgb, 2 rows)', U.columnsOf(two, 1, 2, 1, 'rgb')[0] === 50);
  const uneven = U.columnsOf(Buffer.from(rowPx([[10, 10, 10], [20, 20, 20], [30, 30, 30]], 1)), 3, 1, 2, 'rgb');
  check('columnsOf: uneven buckets still cover every pixel', uneven[0] === 10 && uneven[3] === 25, Array.from(uneven));
  check('sameCols: within one level is the same, two is not', U.sameCols([10, 10, 10], [11, 9, 10]) && !U.sameCols([10, 10, 10], [12, 10, 10]) && !U.sameCols(null, [1]));

  /* ---- the cover ---- */
  const strip = { x: 0, y: 35, w: 1920, h: 1 };
  const wins = [
    { cls: 'Chrome_WidgetWin_1', title: 'Quartz', rect: [0, 35, 960, 1040], ignored: null },
    { cls: 'Progman', ignored: 'the desktop' },
    { cls: 'Shell_TrayWnd', title: '', rect: [0, 1040, 1920, 1080], ignored: 'Windows shell furniture (Shell_TrayWnd)' },
    { cls: 'Chrome_WidgetWin_1', title: 'Mantle top bar', rect: [0, 0, 1920, 35], ignored: 'Mantle\'s own bar or pop-up' },
    { cls: 'Notepad', title: 'below', rect: [1000, 300, 1800, 900], ignored: null },
    { cls: 'X', title: 'overlap', rect: [900, 20, 1200, 600], ignored: null },
  ];
  const sp = U.spansOf(wins, strip);
  check('spansOf: windows across the row, merged; ignored ones (desktop, taskbar, Mantle) and ones below the row are not', sp.length === 1 && sp[0].l === 0 && sp[0].r === 1200, sp);
  check('spansOf: a window that ends AT the row does not cover it', U.spansOf([{ rect: [0, 0, 500, 35], ignored: null }], strip).length === 0);
  check('spansOf: clipped to the strip', (() => { const s = U.spansOf([{ rect: [-50, 0, 3000, 900], ignored: null }], strip); return s.length === 1 && s[0].l === 0 && s[0].r === 1920; })());
  check('spansOf: nothing listed -> nothing covered (the desktop)', U.spansOf([], strip).length === 0 && U.spansOf(null, strip).length === 0);
  const cov = U.coverOf([{ l: 0, r: 964 }], 0, 1920, 240);
  check('coverOf: whole columns 1, the edge column partial, the rest 0', cov[0] === 1 && cov[119] === 1 && Math.abs(cov[120] - 0.5) < 1e-6 && cov[121] === 0 && cov[239] === 0, [cov[119], cov[120], cov[121]]);
  check('coverOf: offset strips (a second monitor) use their own x', U.coverOf([{ l: -1920, r: -960 }], -1920, 1920, 240)[0] === 1 && U.coverOf([{ l: -1920, r: -960 }], -1920, 1920, 240)[200] === 0);

  /* ---- protected windows read black ---- */
  {
    const n = 10, cols = new Uint8Array(n * 3), cover = new Float32Array(n);
    for (let i = 0; i < 5; i++) cover[i] = 1;                     // window A: solid black
    for (let i = 5; i < 10; i++) { cover[i] = 1; cols[i * 3] = 240; cols[i * 3 + 1] = 240; cols[i * 3 + 2] = 240; }
    cover[5] = 0;                                                // a gap splits the runs
    const r = U.protectedBlack(cols, cover, n);
    check('protectedBlack: a covered run that is all black is taken out of the cover', r.blocked === 5 && cover[0] === 0 && cover[4] === 0, Array.from(cover));
    check('protectedBlack: a white run next to it is kept', cover[6] === 1 && cover[9] === 1);
    const c3 = new Uint8Array(30), cv3 = new Float32Array(10).fill(1);
    c3[0] = 30; c3[1] = 30; c3[2] = 30;                          // one non-black column of 10 (90% black)
    check('protectedBlack: a mostly-black run with real content is a dark window, kept', U.protectedBlack(c3, cv3, 10).blocked === 0);
    const c4 = new Uint8Array(30).fill(1), cv4 = new Float32Array(10).fill(1);
    check('protectedBlack: near-black (1 level) counts as black', U.protectedBlack(c4, cv4, 10).blocked === 10);
  }

  /* ---- the PNG reader ---- */
  {
    const px = rowPx([[12, 34, 56], [200, 210, 220], [0, 255, 128]], 4);
    const d = U.decodePng(png(px, 12, 1, 3));
    check('decodePng: RGB, filter none', d.ok && d.w === 12 && d.h === 1 && d.order === 'rgb' && d.buf[0] === 12 && d.buf[4 * 3 + 1] === 210 && d.buf[11 * 3 + 2] === 128, d.reason);
    const px2 = [];
    for (let y = 0; y < 3; y++) for (let x = 0; x < 5; x++) px2.push((x * 37 + y * 11) & 255, (x * 5 + y * 90) & 255, (200 - x * 30) & 255, 255);
    let allOk = true;
    for (const f of [1, 2, 3, 4]) {
      const r = U.decodePng(png(px2, 5, 3, 4, [f, 0, f]));
      if (!r.ok || r.order !== 'rgba' || !r.buf.equals(Buffer.from(px2))) allOk = false;
    }
    check('decodePng: RGBA with Sub / Up / Average / Paeth rows comes back exact', allOk);
    check('decodePng: not a PNG -> a reason, no throw', U.decodePng('data:image/png;base64,AAAA').ok === false && U.decodePng('nope').ok === false);
  }

  /* ---- the loop, with a fake clock and a fake sidecar ---- */
  function rig(opts) {
    const o = opts || {};
    let t = 0;
    const timers = [];
    const pushed = [], logs = [], fulls = [];
    const st = { cond: Object.assign({}, base), caps: 0, lists: 0, row: o.row || rowPx(new Array(240).fill([25, 38, 41]), 8), windows: o.windows || [{ rect: [0, 35, 1920, 1080], ignored: null, title: 'Quartz' }], capFail: null, listFail: null };
    const u = U.makeUnder({
      strip: () => (o.noStrip ? null : { x: 0, y: 35, w: 1920, h: 1 }),
      capture: async (rect, n) => {
        st.caps++;
        if (st.beforeCap) { const f = st.beforeCap; st.beforeCap = null; await Promise.resolve(); f(); }
        if (st.capFail) return { ok: false, reason: st.capFail };
        // o.cols: the sidecar's underrow (the columns averaged there, base64 r,g,b)
        if (o.cols) { st.colsReads = (st.colsReads || 0) + 1; return { ok: true, cols: Buffer.from(U.columnsOf(st.row, 1920, 1, n, 'rgb')).toString('base64') }; }
        return { ok: true, png: png(st.row, 1920, 1, 3) };
      },
      windows: async () => { st.lists++; return st.listFail ? { ok: false, reason: st.listFail } : { ok: true, windows: st.windows }; },
      watch: o.watch, paint: o.paint, layer: o.layer,
      cond: () => st.cond,
      push: (p) => pushed.push(p),
      onFull: (f) => fulls.push(f),
      log: (l) => logs.push(l),
      later: (ms, fn) => { const h = { at: t + ms, fn }; timers.push(h); return h; },
      cancel: (h) => { const i = timers.indexOf(h); if (i >= 0) timers.splice(i, 1); },
      now: () => t,
    });
    async function run(ms) {
      const end = t + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const h = timers[0];
        if (!h || h.at > end) break;
        timers.shift();
        t = h.at;
        h.fn();
        for (let i = 0; i < 5; i++) await Promise.resolve();
        await new Promise((r) => setImmediate(r));
      }
      t = end;
    }
    return { u, st, pushed, logs, fulls, run, timers };
  }
  {
    const R = rig();
    R.u.kick('shown');
    await R.run(10);
    const first = R.pushed[0];
    check('loop: the first read pushes the columns (240) and the cover', first && first.n === 240 && first.cols.length === 720 && first.cols[0] === 25 && first.cols[1] === 38 && first.cover.every((v) => v === 1), first && { n: first.n, c: first.cols.slice(0, 3) });
    check('loop: a full cover tells the glass to rest', R.fulls[0] === true && R.u.full() === true);
    // fast until the row has been still for IDLE_READS reads
    const fastMs = U.IDLE_READS * U.FAST_MS;
    await R.run(fastMs);
    const fastN = 1 + U.IDLE_READS;   // the first read + one per FAST_MS
    check(`loop: ${Math.round(1000 / U.FAST_MS)} Hz while on (${fastN} reads in ${fastMs} ms)`, R.st.caps >= fastN - 1 && R.st.caps <= fastN + 1, R.st.caps);
    check('loop: a still row is never pushed again', R.pushed.length === 1, R.pushed.length);
    check('loop: a still row lists the windows only on the safety net, not every tick', R.st.lists === 1, R.st.lists);
    const capsA = R.st.caps;
    await R.run(2000);
    const slowN = Math.floor(2000 / U.SLOW_MS);
    check(`loop: a row still for IDLE_READS reads slows to ${1000 / U.SLOW_MS} Hz`, R.st.caps - capsA >= slowN - 1 && R.st.caps - capsA <= slowN + 1 && U.SLOW_MS > U.FAST_MS, R.st.caps - capsA);
    await R.run(U.CHECK_IDLE_MS - 2000);
    check('loop: the safety net re-lists the windows', R.st.lists === 2, R.st.lists);
    // a tab switch: the colours move -> pushed, and the window list re-read (rate-limited)
    R.st.row = rowPx(new Array(240).fill([250, 250, 250]), 8);
    const lists0 = R.st.lists;
    await R.run(U.SLOW_MS + 50);
    const last = R.pushed[R.pushed.length - 1];
    check('loop: a page that changed colour is pushed within one (slow) tick', last && last.cols[0] === 250, last && last.cols && last.cols.slice(0, 3));
    check('loop: ...a page changing colour under a window that fills the row is not a window moving: no re-list', R.st.lists === lists0, R.st.lists - lists0);
    // a kick (the foreground changed) re-lists at once
    const l1 = R.st.lists;
    R.u.kick('the foreground changed');
    await R.run(U.MIN_GAP_MS + 5);
    check('loop: a kick re-lists the windows at once', R.st.lists === l1 + 1);
    // the window goes away: only the desktop under the bar -> today's look, the glass resumes
    R.st.windows = [];
    R.u.kick('the foreground changed');
    await R.run(U.MIN_GAP_MS + 5);
    const off = R.pushed[R.pushed.length - 1];
    check('loop: only the desktop under -> off (today\'s look), not a failure', off && off.off === true && off.failure === false && /desktop/.test(off.why), off);
    check('loop: ...and the glass is told to come back', R.fulls[R.fulls.length - 1] === false && R.u.full() === false);
    const n0 = R.pushed.length;
    await R.run(1000);
    check('loop: the desktop state is said once, not every tick', R.pushed.length === n0, R.pushed.length - n0);
    // half the row: a snapped window
    R.st.windows = [{ rect: [0, 35, 960, 1040], ignored: null, title: 'left' }];
    R.u.kick('the foreground changed');
    await R.run(U.MIN_GAP_MS + 5);
    const half = R.pushed[R.pushed.length - 1];
    check('loop: a snapped window covers its half of the row only', half && half.cover[0] === 1 && half.cover[119] === 1 && half.cover[120] === 0, half && [half.cover[119], half.cover[120]]);
    check('loop: a half cover lets the glass run', R.u.full() === false);
    // a menu opens: off, kept, no reads
    R.st.cond = Object.assign({}, base, { menuOpen: true });
    R.u.kick('a menu opened');
    const capsM = R.st.caps;
    await R.run(1000);
    const km = R.pushed[R.pushed.length - 1];
    check('loop: a menu open stops the reads and keeps the paint', km.off === true && km.keep === true && R.st.caps === capsM, km);
    R.st.cond = Object.assign({}, base);
    R.u.kick('a menu closed');
    await R.run(U.MIN_GAP_MS + 5);
    check('loop: the menu closed -> read again and pushed', R.st.caps === capsM + 1 && !R.pushed[R.pushed.length - 1].off);
    // light: off, nothing read
    R.st.cond = Object.assign({}, base, { dark: false });
    R.u.kick('the theme changed');
    const capsL = R.st.caps;
    await R.run(2000);
    check('loop: light -> off, and nothing is ever read', R.pushed[R.pushed.length - 1].off === true && R.st.caps === capsL && R.timers.length === 0);
    // the bar hidden for a game: off, no timer left
    R.st.cond = Object.assign({}, base, { visible: false });
    R.u.kick('hidden');
    await R.run(2000);
    check('loop: hidden -> no reads, no timers', R.st.caps === capsL && R.timers.length === 0);
    R.st.cond = Object.assign({}, base, { cover: true });
    R.u.kick('cover');
    await R.run(2000);
    check('loop: over a full-screen window -> no reads, no timers', R.st.caps === capsL && R.timers.length === 0);
    R.u.stop();
    R.st.cond = Object.assign({}, base);
    R.u.kick('after stop');
    await R.run(2000);
    check('loop: stopped stays stopped', R.st.caps === capsL);
  }
  {
    // THE FAST PATH (2026-10-11, the user: "changes colors faster like imediatly? so theres no delay?"): the
    // sidecar's underrow columns; a title kick reads at once with no window list; kicks at most one read
    // per MIN_GAP_MS; any kick puts the poll back at the fast rate
    const R = rig({ cols: true });
    R.u.kick('shown');
    await R.run(U.MIN_GAP_MS + 5);
    const p0 = R.pushed[0];
    check('fast: underrow columns are used as they come (no PNG)', !!p0 && p0.n === 240 && p0.cols[0] === 25 && p0.cols[2] === 41 && R.st.colsReads === 1, p0 && p0.cols && p0.cols.slice(0, 3));
    check('fast: colsOf takes base64 of n*3 bytes and refuses a wrong length', U.colsOf(Buffer.from([1, 2, 3]).toString('base64'), 1)[2] === 3 && U.colsOf('AAAA', 2) === null);
    check('fast: each push carries the wall-clock start of its read (the page measures read -> painted)', !!p0 && typeof p0.t === 'number' && Math.abs(Date.now() - p0.t) < 60000, p0 && p0.t);
    await R.run(U.IDLE_READS * U.FAST_MS + 3 * U.SLOW_MS);
    check('fast: a still row drops to the slow rate', R.u.view().fps === 1000 / U.SLOW_MS, R.u.view().fps);
    const l0 = R.st.lists, c0 = R.st.caps;
    R.st.row = rowPx(new Array(240).fill([250, 250, 250]), 8);
    R.u.kick('a title changed (a tab switch)', true);
    await R.run(U.MIN_GAP_MS + 2);
    const last = R.pushed[R.pushed.length - 1];
    check('fast: a title kick reads at once (within MIN_GAP_MS) and pushes the new colour', R.st.caps === c0 + 1 && last.cols[0] === 250, R.st.caps - c0);
    check('fast: ...with no window list', R.st.lists === l0, R.st.lists - l0);
    check('fast: ...and the poll follows the event up every FOLLOW_MS (the window may repaint after its event)', R.u.view().fps === 1000 / U.FOLLOW_MS && R.u.view().kicks >= 2, R.u.view());
    const cF = R.st.caps;
    await R.run(U.FOLLOW_FOR_MS);
    check('fast: ...reading about FOLLOW_FOR_MS / FOLLOW_MS more times', R.st.caps - cF >= Math.floor(U.FOLLOW_FOR_MS / U.FOLLOW_MS) - 1, R.st.caps - cF);
    await R.run(U.FAST_MS);
    check('fast: ...then back at the fast rate', R.u.view().fps === 1000 / U.FAST_MS, R.u.view().fps);
    const c1 = R.st.caps;
    for (let i = 0; i < 10; i++) R.u.kick('the foreground changed', true);
    await R.run(U.MIN_GAP_MS * 2 + 2);
    check('fast: 10 kicks at once -> one read, not ten', R.st.caps - c1 >= 1 && R.st.caps - c1 <= 2, R.st.caps - c1);
    // a page scrolling under a window that fills the row: every read moves, none lists the windows
    const l1 = R.st.lists;
    for (let i = 0; i < 20; i++) { R.st.row = rowPx(new Array(240).fill([i * 10, 40, 60]), 8); await R.run(U.FAST_MS); }
    check('fast: a page scrolling under a full window never re-lists the windows (until the 5 s net)', R.st.lists - l1 <= 1, R.st.lists - l1);
    check('fast: ...and once it has kept changing for SUSTAIN_READS reads the poll drops to BUSY_MS (the paint cap)', R.u.view().fps === 1000 / U.BUSY_MS, R.u.view().fps);
    R.u.kick('a title changed (a tab switch)', true);
    await R.run(U.MIN_GAP_MS + 2);
    check('fast: ...and an event puts it straight back at the fast rate (its follow-ups first)', R.u.view().fps === 1000 / U.FOLLOW_MS, R.u.view().fps);
    R.u.stop();
  }
  {
    // THE FRAME WATCH (lane mantle-topbar-instant): the sidecar pushes the row on the frame it changes
    const calls = [];
    const SC = { mode: 'frames', reason: null };   // what the sidecar's watch answers (its mode now)
    const R = rig({ cols: true, watch: (a) => { calls.push(a); return Promise.resolve({ ok: true, mode: SC.mode, reason: SC.reason }); } });
    const b64 = (rgb) => Buffer.from(U.columnsOf(rowPx(new Array(240).fill(rgb), 8), 1920, 1, 240, 'rgb')).toString('base64');
    R.u.kick('shown');
    await R.run(U.MIN_GAP_MS + 5);
    const on = calls.find((c) => c.on === true);
    check('watch: the first read asks the sidecar to watch the same row (x, y, w, n) with the push spacing', !!on && on.x === 0 && on.y === 35 && on.w === 1920 && on.n === 240 && on.minMs === U.PUSH_MIN_MS && on.busyMs === U.PUSH_BUSY_MS && on.sustainMs === U.PUSH_SUSTAIN_MS, on);
    check('watch: the sidecar says frames -> the poll drops to the SAFE_MS safety read', R.u.view().src === 'frames' && R.u.view().fps === 1000 / U.SAFE_MS, R.u.view());
    const n0 = R.pushed.length, c0 = R.st.caps;
    R.u.frame({ ev: 'underrow', kind: 'cols', cols: b64([240, 240, 240]), n: 240, at: Date.now(), presentAt: Date.now() - 3 });
    const fp = R.pushed[R.pushed.length - 1];
    check('watch: a pushed frame reaches the page at once, with no read of its own', R.pushed.length === n0 + 1 && fp.cols[0] === 240 && R.st.caps === c0, { pushed: R.pushed.length - n0, caps: R.st.caps - c0 });
    check('watch: ...stamped with when Windows presented it', Math.abs(fp.t - (Date.now() - 3)) < 1000, fp.t);
    R.u.frame({ ev: 'underrow', kind: 'cols', cols: b64([240, 240, 240]), n: 240, at: Date.now() });
    check('watch: the same frame again sends nothing', R.pushed.length === n0 + 1);
    R.u.frame({ ev: 'underrow', kind: 'cols', cols: b64([9, 9, 9]), n: 120, at: Date.now() });
    check('watch: a push for another row size (an older watch) is dropped', R.pushed.length === n0 + 1);
    R.u.frame({ ev: 'underrow', kind: 'cols', cols: 'AAAA', n: 240, at: Date.now() });
    check('watch: a malformed push is dropped', R.pushed.length === n0 + 1);
    const a0 = calls.length;
    await R.run(3 * U.SAFE_MS + 5);
    check('watch: the safety read is also the keep-alive (asked again about every second)', calls.length - a0 >= 2 && calls.length - a0 <= 4, calls.length - a0);
    // the sidecar falls back: the poll takes over at once, and says why once it lasts
    SC.mode = 'poll'; SC.reason = 'Windows refused it (a secure desktop: the lock screen or a UAC prompt)';
    R.u.frame({ ev: 'underrow', kind: 'state', mode: SC.mode, reason: SC.reason });
    check('watch: a fallback puts the poll back at a fast rate', R.u.view().src === 'poll' && R.u.view().fps >= 1000 / U.FAST_MS, R.u.view());
    check('watch: ...and logs the secure desktop as a state, once, not as a refusal',
      R.logs.filter((l) => /^under: locked: the lock screen or a UAC prompt has the screen/.test(l)).length === 1 &&
      !R.logs.some((l) => /polling the row: Windows refused it/.test(l)), R.logs.slice(-3));
    R.st.row = rowPx(new Array(240).fill([100, 120, 140]), 8);
    await R.run(U.SAY_POLL_AFTER_MS + U.FAST_MS * 2);
    R.st.row = rowPx(new Array(240).fill([101, 121, 141]), 8);
    await R.run(U.FAST_MS * 2);
    const np = R.pushed[R.pushed.length - 1];
    check('watch: ...and once it has lasted SAY_POLL_AFTER_MS the page is told why (no silent fallback)', !!np && /instead of on every frame, because Windows refused it/.test(np.why || '') && /instead of on every frame/.test(R.u.view().why || ''), np && np.why);
    SC.mode = 'frames'; SC.reason = null;
    R.u.frame({ ev: 'underrow', kind: 'state', mode: 'frames', reason: null });
    check('watch: frames again -> the safety rate, the note gone', R.u.view().src === 'frames' && R.u.view().fps === 1000 / U.SAFE_MS && !R.u.view().why, R.u.view());
    // a menu opens: the watch idles (pushes ignored), no off sent
    const offs0 = calls.filter((c) => c.on === false).length, colsSent = R.pushed.filter((p) => p.cols).length;
    R.st.cond = Object.assign({}, base, { menuOpen: true });
    R.u.kick('a menu opened');
    R.u.frame({ ev: 'underrow', kind: 'cols', cols: b64([1, 2, 3]), n: 240, at: Date.now() });
    check('watch: a menu open -> its pushes are ignored (the dropdown is in the row), the watch not stopped', R.pushed.filter((p) => p.cols).length === colsSent && calls.filter((c) => c.on === false).length === offs0);
    R.st.cond = Object.assign({}, base);
    R.u.kick('a menu closed');
    await R.run(U.MIN_GAP_MS + 5);
    // hidden (a game): the watch is stopped at once
    R.st.cond = Object.assign({}, base, { visible: false });
    R.u.kick('hidden');
    check('watch: the bar hidden (a game) -> on:false sent at once', calls[calls.length - 1].on === false && R.u.view().src === 'off', calls[calls.length - 1]);
    const nh = R.pushed.length;
    R.u.frame({ ev: 'underrow', kind: 'cols', cols: b64([7, 7, 7]), n: 240, at: Date.now() });
    check('watch: ...and a late push changes nothing', R.pushed.length === nh);
    // light: never asks
    const aL = calls.length;
    R.st.cond = Object.assign({}, base, { dark: false });
    R.u.kick('the theme changed');
    await R.run(3000);
    check('watch: light -> the watch is never asked for', calls.slice(aL).every((c) => c.on === false), calls.slice(aL));
    R.st.cond = Object.assign({}, base);
    R.u.kick('dark again');
    await R.run(U.MIN_GAP_MS + 5);
    check('watch: dark again -> asked again', calls[calls.length - 1].on === true);
    R.st.cond = Object.assign({}, base, { cover: true });
    R.u.kick('cover');
    check('watch: a full-screen window under the bar -> on:false at once', calls[calls.length - 1].on === false);
    R.st.cond = Object.assign({}, base, { lock: true });
    R.u.kick('lock');
    check('watch: the lock screen -> not running', calls[calls.length - 1].on === false && R.u.view().src === 'off');
    R.st.cond = Object.assign({}, base);
    R.u.kick('back');
    await R.run(U.MIN_GAP_MS + 5);
    const aR = calls.length;
    R.u.sidecarRestarted();
    await R.run(5);
    check('watch: a sidecar restart -> asked again at once', calls.length > aR && calls[calls.length - 1].on === true, calls.length - aR);
    R.u.stop();
    check('watch: stop -> on:false', calls[calls.length - 1].on === false);
  }
  {
    // THE NATIVE LAYER (lane mantle-topbar-zero): asked with the watch's keep-alive while it pushes frames; the
    // page's payload says native:true ONLY while the sidecar says it paints, and false the moment it does not
    const paints = [];
    const PM = { mode: 'native', reason: null };
    const R = rig({ cols: true,
      watch: () => Promise.resolve({ ok: true, mode: 'frames', reason: null }),
      paint: (a) => { paints.push(a); return Promise.resolve(a.on ? { ok: true, mode: PM.mode, reason: PM.reason, confirmed: 0, corrected: 0 } : { ok: true, on: false }); },
      layer: (r) => ({ bar: '4242', x: r.x, y: 0, w: r.w, h: 35, hz: 60, visible: false, wash: null }) });
    const last = () => R.pushed.filter((p) => p.cols).slice(-1)[0];
    R.u.kick('shown');
    await R.run(U.MIN_GAP_MS + 5);
    await R.run(U.SAFE_MS + 5);
    const on = paints.find((p) => p.on);
    check('native: the layer is asked for once the watch pushes frames (bar, layer rect, the row, n)', !!on && on.bar === '4242' && on.h === 35 && on.rowX === 0 && on.rowY === 35 && on.rowW === 1920 && on.n === 240 && on.visible === false, on);
    check('native: the sidecar says native -> view().native, and the page\'s colours are pushed again with native:true', R.u.view().native === true && last().native === true, { v: R.u.view().native, p: last() && last().native });
    R.u.frame({ ev: 'underrow', kind: 'paint', mode: 'failed', reason: 'the layer stopped (boom)' });
    check('native: the sidecar says its layer failed -> native:false pushed at once, with the reason in view()', R.u.view().native === false && last().native === false && /boom/.test(R.u.view().nativeWhy || ''), R.u.view().nativeWhy);
    R.u.frame({ ev: 'underrow', kind: 'paint', mode: 'native', reason: null });
    check('native: ...and native again when it says so', R.u.view().native === true && last().native === true);
    const offs = paints.filter((p) => p.on === false).length;
    R.u.frame({ ev: 'underrow', kind: 'state', mode: 'poll', reason: 'Windows refused it' });
    check('native: the watch falls back to polling -> native:false and the layer told on:false (it would get no rows)', R.u.view().native === false && last().native === false && paints.filter((p) => p.on === false).length === offs + 1);
    R.u.frame({ ev: 'underrow', kind: 'state', mode: 'frames', reason: null });
    await R.run(U.SAFE_MS + 5);
    check('native: frames again -> the next keep-alive asks again and it is native', R.u.view().native === true && last().native === true, R.u.view().native);
    R.u.sidecarRestarted();
    check('native: a sidecar restart -> native:false pushed at once ("the sidecar restarted")', R.u.view().native === false && last().native === false && /restarted/.test(R.u.view().nativeWhy || ''), R.u.view().nativeWhy);
    await R.run(U.SAFE_MS * 2 + 5);
    check('native: ...then asked again and native once the new sidecar says so', R.u.view().native === true, R.u.view().native);
    const offs2 = paints.filter((p) => p.on === false).length;
    R.u.stop();
    check('native: stop -> the layer told on:false', paints.filter((p) => p.on === false).length === offs2 + 1);
  }
  {
    // an older sidecar (no underpaint): native never claimed, said once, never asked again
    const paints = [];
    const R = rig({ cols: true,
      watch: () => Promise.resolve({ ok: true, mode: 'frames', reason: null }),
      paint: (a) => { paints.push(a); return Promise.resolve({ ok: false, reason: 'unknown command: underpaint' }); },
      layer: (r) => ({ bar: '4242', x: r.x, y: 0, w: r.w, h: 35, hz: 60, visible: false }) });
    R.u.kick('shown');
    await R.run(U.MIN_GAP_MS + 5);
    await R.run(U.SAFE_MS * 3 + 5);
    const cp = R.pushed.filter((p) => p.cols);
    check('native: an old sidecar -> asked once, never native, every payload native:false', paints.filter((p) => p.on).length === 1 && R.u.view().native === false && cp.length > 0 && cp.every((p) => p.native === false), { asks: paints.length, v: R.u.view().native });
    check('native: ...with the reason in view()', /older than Mantle/.test(R.u.view().nativeWhy || ''), R.u.view().nativeWhy);
    R.u.stop();
  }
  {
    // an older sidecar (no underwatch): said once, the poll as before, never asked again
    const calls = [];
    const R = rig({ cols: true, watch: (a) => { calls.push(a); return Promise.resolve({ ok: false, reason: 'unknown command: underwatch' }); } });
    R.u.kick('shown');
    await R.run(U.MIN_GAP_MS + 5);
    await R.run(3000);
    check('watch: an old sidecar -> asked once, then the poll at its own rates', calls.length === 1 && R.u.view().src === 'poll' && R.u.view().fps !== 1000 / U.SAFE_MS, { calls: calls.length, v: R.u.view() });
    check('watch: ...with the reason logged', R.logs.some((l) => /this sidecar has no frame watch/.test(l)));
    R.u.stop();
  }
  {
    // the watch refused (a throw or an error): polling, said
    const R = rig({ cols: true, watch: () => Promise.resolve({ ok: false, reason: 'no reply within 2000ms' }) });
    R.u.kick('shown');
    await R.run(U.MIN_GAP_MS + 5);
    check('watch: a failed start -> polling with the reason', R.u.view().src === 'poll' && /could not start: no reply/.test(R.u.view().srcWhy || ''), R.u.view());
    R.u.stop();
  }
  {
    // a read in flight when a frame lands: the frame (newer) wins
    let hold = null;
    const R = rig({ cols: true, watch: () => Promise.resolve({ ok: true, mode: 'frames' }) });
    R.u.kick('shown');
    await R.run(U.MIN_GAP_MS + 5);
    const b64 = (rgb) => Buffer.from(U.columnsOf(rowPx(new Array(240).fill(rgb), 8), 1920, 1, 240, 'rgb')).toString('base64');
    R.st.row = rowPx(new Array(240).fill([10, 10, 10]), 8);   // what the read will see (older)
    R.st.beforeCap = () => R.u.frame({ ev: 'underrow', kind: 'cols', cols: b64([200, 100, 50]), n: 240, at: Date.now() });
    R.u.kick('the foreground changed');
    await R.run(U.MIN_GAP_MS + 5);
    R.st.beforeCap = null;
    const last = R.pushed.filter((p) => p.cols).pop();
    check('watch: a frame pushed during a read is not overwritten by that older read', last && last.cols[0] === 200, last && last.cols.slice(0, 3));
    R.u.stop();
    void hold;
  }
  {
    // failures: a capture that keeps failing -> today's look WITH the reason, slow retries, then recovery
    const R = rig();
    R.st.capFail = 'backdrop: BitBlt failed (Win32 error 6)';
    R.u.kick('shown');
    await R.run(1000);
    const f = R.pushed.find((p) => p.failure);
    check('fail: three failed reads -> off with the reason, as a failure', f && f.off === true && /BitBlt failed/.test(f.why), R.pushed);
    check('fail: said once in the log', R.logs.filter((l) => /today's look/.test(l)).length === 1, R.logs);
    check('fail: status says it', R.u.view().failure === true && /BitBlt/.test(R.u.view().why));
    const c0 = R.st.caps;
    // the last failed read was (MAX_FAILS - 1) fast ticks in, and it is now 1000: run to just before its retry
    const t3 = (U.MAX_FAILS - 1) * U.FAST_MS;
    await R.run(t3 + U.RETRY_MS - 1000 - 50);
    check('fail: retries slow (every RETRY_MS)', R.st.caps === c0, R.st.caps - c0);
    R.st.capFail = null;
    await R.run(100);
    check('fail: recovers and pushes the columns again', !R.pushed[R.pushed.length - 1].off && R.u.view().failure === false && R.logs.some((l) => /reads again/.test(l)));
    // the window list failing is a failure too (what is under cannot be known)
    const R2 = rig();
    R2.st.listFail = 'widgethide.check: timed out';
    R2.u.kick('shown');
    await R2.run(1000);
    check('fail: the window list failing -> today\'s look with the reason', R2.pushed.some((p) => p.failure && /could not be listed/.test(p.why)));
    const R3 = rig({ noStrip: true });
    R3.u.kick('shown');
    await R3.run(1000);
    check('fail: no row under the bar -> said, not silent', R3.pushed.some((p) => p.failure && /no room under/.test(p.why)));
  }
  {
    // the secure desktop (lane truthlog, 2026-10-15): the lock screen's BitBlt refusal (error 5) is a state,
    // said once as "locked", not "today's look: ... could not be read" + "reads again after a failure"
    const R = rig();
    R.st.capFail = 'underrow: BitBlt failed (Win32 error 5)';
    R.u.kick('shown');
    await R.run(1000);
    const f = R.pushed.find((p) => p.off);
    check('locked: off with the locked words, not as a failure', f && f.failure === false && /^locked: /.test(f.why), R.pushed);
    check('locked: one "locked" line and no failure lines', R.logs.filter((l) => /^under: locked: /.test(l)).length === 1 &&
      !R.logs.some((l) => /today's look:|BitBlt|after a failure|off after/.test(l)), R.logs);
    const v = R.u.view();
    check('locked: status says locked, not a failure', v.locked === true && v.failure === false && /^locked: /.test(v.why), v);
    await R.run(U.RETRY_MS * 2 + 100);
    check('locked: the slow retries add no lines', R.logs.filter((l) => /locked/.test(l)).length === 1, R.logs);
    R.st.capFail = null;
    await R.run(U.RETRY_MS + 100);
    check('locked: back -> one "unlocked" line, the columns again',
      R.logs.filter((l) => /^under: unlocked: /.test(l)).length === 1 && !R.pushed[R.pushed.length - 1].off &&
      R.u.view().locked === false && R.u.view().failure === false, R.logs.slice(-3));
    R.u.stop();
  }
  {
    // a protected window: black row under a window -> today's look with the reason, NOT a black bar
    const R = rig({ row: rowPx(new Array(240).fill([0, 0, 0]), 8) });
    R.u.kick('shown');
    await R.run(10);
    const p = R.pushed[R.pushed.length - 1];
    check('protected: an all-black window row -> off (today\'s look), the reason given, not a failure', p && p.off === true && p.failure === false && p.blocked === 240 && /blocks screen capture/.test(p.why), p);
    check('protected: status says it', /blocks screen capture/.test(R.u.view().why || '') && R.u.view().blocked === 240);
    check('protected: the glass keeps running under it', R.u.full() === false);
  }

  /* ---- the page's plan ---- */
  const lum = (c) => GA.lum(c[0], c[1], c[2]);
  const ratio = (a, b) => GA.contrast(lum(a), lum(b));
  const n = 240, W = 1536;
  const flat = (c, cover) => ({ cols: [].concat(...new Array(n).fill(c)), cover: new Array(n).fill(cover == null ? 1 : cover) });
  const item = (key, x0, x1, hi) => ({ key, x0, x1, light: hi ? T.light.concat([T.warnL]) : T.light, dark: hi ? T.dark.concat([T.warnD]) : T.dark });
  const ITEMS = [item('glyph', 8, 38), item('app', 38, 120), item('m1', 120, 170), item('m2', 170, 220), item('cpu', 1100, 1170), item('mem', 1170, 1300), item('ping', 1380, 1450, true), item('timer', 1460, 1528)];
  const plan = (f, prev, items) => P.plan(Object.assign({ n, width: W, items: items || ITEMS, gap: { light: T.light, dark: T.dark }, scrim: { light: T.scrimL, dark: T.scrimD }, prev }, f));
  {
    const q = plan(flat([25, 38, 41]));
    check('plan: the user\'s Quartz top (25,38,41): light ink everywhere, no pull, the band IS the colour', q.items.every((i) => i.ink === 'light') && q.pull.every((a) => a === 0) && q.top[100].every((v, k) => Math.abs(v - [25, 38, 41][k]) < 0.5));
    const wht = plan(flat([255, 255, 255]));
    check('plan: a white page: every item flips to dark ink, no pull', wht.items.every((i) => i.ink === 'dark') && wht.pull.every((a) => a === 0));
    check('plan: a white page: every item reads >= 4.5:1', wht.items.every((i) => i.ratio >= 4.5), wht.items.map((i) => i.ratio));
    const px = P.paint(wht);
    const bot = (P.ROWS - 1) * n * 4;
    check('paint: the bottom row is exactly the colour under it, opaque', px[bot] === 255 && px[bot + 1] === 255 && px[bot + 2] === 255 && px[bot + 3] === 255);
    const desk = plan(flat([120, 130, 140], 0));
    check('plan: nothing under (cover 0): clear paint, every item keeps light ink (today\'s look)', desk.alpha.every((a) => a === 0) && desk.items.every((i) => i.ink === 'light') && P.paint(desk).every((v, i) => i % 4 !== 3 || v === 0));
  }
  {
    // split: a white page on the left half, a dark editor on the right
    const cols = [], cover = [];
    for (let c = 0; c < n; c++) { cols.push(...(c < 120 ? [255, 255, 255] : [30, 30, 30])); cover.push(1); }
    const s = plan({ cols, cover });
    const by = Object.fromEntries(s.items.map((i) => [i.key, i.ink]));
    check('plan: PER ITEM: left items over the white page are dark ink, right items over the editor light', by.glyph === 'dark' && by.app === 'dark' && by.m2 === 'dark' && by.cpu === 'light' && by.ping === 'light' && by.timer === 'light', by);
    check('plan: split: every item reads >= 4.5:1 on its own fill', s.items.every((i) => i.ratio >= 4.5), s.items.map((i) => [i.key, i.ratio]));
    const px = P.paint(s);
    let exact = true;
    for (let c = 0; c < n; c++) { const i = ((P.ROWS - 1) * n + c) * 4; const e = c < 120 ? 255 : 30; if (px[i] !== e || px[i + 1] !== e || px[i + 2] !== e) exact = false; }
    check('paint: split: the bottom row equals the columns, every column', exact);
  }
  {
    // the sweep: every grey and a set of colours, every item >= 4.5:1, the bottom row exact
    let worst = Infinity, at = null, bottomOk = true, dark = 0, light = 0;
    const colours = [];
    for (let v = 0; v <= 255; v += 5) colours.push([v, v, v]);
    colours.push([30, 60, 140], [200, 40, 40], [40, 160, 80], [250, 220, 120], [90, 20, 120], [0, 120, 215], [255, 200, 0]);
    for (const c of colours) {
      const pl = plan(flat(c));
      for (const i of pl.items) { if (i.ratio < worst) { worst = i.ratio; at = [c, i.key, i.ink]; } if (i.ink === 'dark') dark++; else light++; }
      const px = P.paint(pl), b = ((P.ROWS - 1) * n + 50) * 4;
      if (px[b] !== c[0] || px[b + 1] !== c[1] || px[b + 2] !== c[2]) bottomOk = false;
    }
    check('plan: over 59 colours every item reads >= 4.5:1 (worst ' + worst.toFixed(2) + ')', worst >= 4.5, at);
    check('paint: over 59 colours the bottom row is the colour exactly', bottomOk);
    check('plan: the sweep used both inks', dark > 0 && light > 0);
    const mid = plan(flat([128, 128, 128]));
    check('plan: a mid grey gets a pull (Helm\'s darker top), the bottom row stays exact', mid.pull.some((a) => a > 0) && P.paint(mid)[((P.ROWS - 1) * n) * 4] === 128);
  }
  {
    // hysteresis: a colour wobbling across the middle never flips the ink back and forth
    let prev = undefined, flips = 0, lastInk = null;
    const seq = [];
    for (let k = 0; k < 40; k++) seq.push(k % 2 ? 94 : 100);    // +-3 levels around a grey near the crossover
    let crossover = null;
    for (let v = 60; v <= 160; v++) { const p1 = plan(flat([v, v, v]), undefined, [ITEMS[1]]); if (p1.items[0].ink === 'dark') { crossover = v; break; } }
    check('hysteresis: there is a crossover grey', crossover != null, crossover);
    for (let k = 0; k < 40; k++) {
      const v = crossover + (k % 2 ? 3 : -3);
      const pl = plan(flat([v, v, v]), prev, [ITEMS[1]]);
      prev = pl.prev;
      if (lastInk && pl.items[0].ink !== lastInk) flips++;
      lastInk = pl.items[0].ink;
    }
    check('hysteresis: +-3 levels around the crossover: no flicker (at most one change)', flips <= 1, flips);
    // but a real change does flip it, both ways
    let p2 = plan(flat([20, 20, 20]), undefined, [ITEMS[1]]);
    const a = p2.items[0].ink;
    p2 = plan(flat([240, 240, 240]), p2.prev, [ITEMS[1]]);
    const b = p2.items[0].ink;
    p2 = plan(flat([20, 20, 20]), p2.prev, [ITEMS[1]]);
    check('hysteresis: dark -> bright -> dark still flips light -> dark -> light', a === 'light' && b === 'dark' && p2.items[0].ink === 'light', [a, b, p2.items[0].ink]);
    check('side: the rule itself', P.side('light', 0.5, 0.45) === 'light' && P.side('light', 0.5, 0.35) === 'dark' && P.side('dark', 0.35, 0.4) === 'dark' && P.side('dark', 0.2, 0.4) === 'light' && P.side(undefined, 0.3, 0.2) === 'dark');
  }
  {
    // needAlpha
    check('needAlpha: light ink on black needs nothing', P.needAlpha([0, 0, 0], T.light, T.scrimL) === 0);
    const a = P.needAlpha([128, 128, 128], T.light, T.scrimL);
    const m = P.mix([128, 128, 128], T.scrimL, a);
    check('needAlpha: the pull it finds reads >= 4.5 and one step less does not', a > 0 && T.light.every((ink) => ratio(ink, m) >= 4.5) && !T.light.every((ink) => ratio(ink, P.mix([128, 128, 128], T.scrimL, a - 0.01)) >= 4.5), a);
    // the memo (lane mantle-topbar-instant): the same answer as the bisection, every time, for every ink list
    let bad = 0, k = 0;
    for (let r = 0; r < 256; r += 15) for (let g = 0; g < 256; g += 17) for (let b = 0; b < 256; b += 51) {
      const c = [r, g, b];
      for (const [inks, sc] of [[T.light, T.scrimL], [T.dark, T.scrimD]]) {
        k++;
        const want = P.needAlphaRaw(c, inks, sc);
        if (P.needAlpha(c, inks, sc) !== want || P.needAlpha(c, inks, sc) !== want) bad++;
      }
    }
    check('needAlpha memo: equals the bisection for ' + k + ' colour x ink questions (asked twice)', bad === 0, bad);
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < 2000; i++) P.needAlpha([i % 7 + 120, 128, 128], T.light, T.scrimL);
    const memoUs = Number(process.hrtime.bigint() - t0) / 2000 / 1000;
    check('needAlpha memo: a repeat question costs under 5 us (' + memoUs.toFixed(2) + ')', memoUs < 5, memoUs);
  }
  {
    // paint into the page's reused buffer: byte for byte the fresh paint, the bottom row the exact colour
    const n = 240, cols = [], cover = [];
    for (let c = 0; c < n; c++) { cols.push((c * 7) % 256, (c * 3 + 40) % 256, 255 - c % 256); cover.push(c % 50 === 0 ? 0 : 1); }
    const pl = P.plan({ cols, cover, n, width: 1536, items: [{ key: 'a', x0: 10, x1: 200, light: T.light, dark: T.dark }],
      gap: { light: T.light, dark: T.dark }, scrim: { light: T.scrimL, dark: T.scrimD } });
    const fresh = P.paint(pl), out = new Uint8ClampedArray(n * P.ROWS * 4).fill(7);
    const into = P.paint(pl, P.ROWS, out);
    let diff = 0; for (let i = 0; i < fresh.length; i++) if (fresh[i] !== into[i]) diff++;
    check('paint: into a reused buffer = a fresh paint, byte for byte, and it IS that buffer', diff === 0 && into === out, diff);
    let seam = 0; for (let c = 0; c < n; c++) { const i = ((P.ROWS - 1) * n + c) * 4; if (cover[c] && (into[i] !== cols[c * 3] || into[i + 1] !== cols[c * 3 + 1] || into[i + 2] !== cols[c * 3 + 2])) seam++; }
    check('paint: the bottom row is each covered column\'s exact colour', seam === 0, seam);
    const wrong = P.paint(pl, P.ROWS, new Uint8ClampedArray(5));
    check('paint: a buffer of the wrong size is not written (a fresh one comes back)', wrong.length === n * P.ROWS * 4, wrong.length);
  }
  {
    // the payload check and the menu row
    check('check: a good payload', P.check({ n: 2, cols: [1, 2, 3, 4, 5, 6], cover: [1, 0] }).ok === true);
    check('check: wrong lengths / values are refused with a reason', !P.check({ n: 2, cols: [1, 2, 3], cover: [1, 0] }).ok && !P.check({ n: 1, cols: [1, 2, 300], cover: [1] }).ok && !P.check({ n: 1, cols: [1, 2, 3], cover: [2] }).ok && !P.check(null).ok);
    const menu = [{ t: 'item', text: 'Settings' }];
    P.underMenu(menu, 'the screen under the top bar could not be read', true);
    check('underMenu: a failure puts a bad row first', menu[0].under === true && menu[0].bad === true && /Top bar colour: the screen/.test(menu[0].text));
    P.underMenu(menu, null);
    check('underMenu: cleared when it is fine again', menu.length === 1 && !menu[0].under);
  }

  for (const f of failures) console.log('  FAIL ' + f);
  console.log(`TOPBAR UNDER TEST: ${passed} passed, ${failures.length} failed`);
  process.exitCode = failures.length ? 1 : 0;
})().catch((e) => { console.log('TOPBAR UNDER TEST: crashed: ' + (e && e.stack || e)); process.exit(1); });

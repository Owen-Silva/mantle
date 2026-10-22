require('../../tools/dev-env.js').lowcpu();
/* empty-state.test.js - every full-surface empty state is ONE recipe (lane premium-empty, 2026-10-16).
 *
 * Mantle's empty states were a bold title and a grey sentence floating in an empty pane. Helm's premium
 * pass gave every empty state one recipe so it reads as a designed state: an 18 px line icon in a quiet
 * 40 px raised tile (ui/shared/empty-state.css, .es-tile), 12 px above the title, then the body. This
 * test holds that recipe on the five surfaces that use it, and holds their words exactly as they were.
 *
 * WHAT: headless Chromium over the REAL pages (file://, never Electron, never a window of the user's), each
 * page put into its empty state by its own mock (the query strings tools/overlap-surfaces.js uses), then
 * read in light and in dark (<html data-theme>, flipped live with the mantle-theme event, the way the app's
 * theme plumbing does it), transitions and animations off (a test-only style, CSP bypassed for it):
 *   - the tile is on the page, shown, 40 x 40, and holds one svg drawn at 18 x 18;
 *   - it sits ABOVE the title (its bottom 8-16 px over the title's top) and is centred on it;
 *   - its fill is not transparent, and is exactly the --lg-card token; its shadow is exactly --elev-raised;
 *     light and dark fills differ (the theme reached it);
 *   - the title and body say exactly what they said before the tile (and the tile adds no words);
 *   - a surface that is NOT empty has no stray tile showing.
 *
 *   node ui/shared/empty-state.test.js     -> "EMPTY STATE TEST: n passed, m failed"
 */
'use strict';
const H = require('../bar/page-harness.js');
const t = H.suite('EMPTY STATE TEST');
const UI = 'file:///' + require('path').resolve(__dirname, '..').replace(/\\/g, '/') + '/';

const NTF_SUB = 'What apps tell you lands here, newest first.';
const CLIP_SUB = 'Copy text, a picture or files and it shows up here. Mantle keeps this history in memory only; pinned items are saved, encrypted.';
const CLIPS_SUB = 'Press WinG, then Record. Windows saves clips and screenshots in your Captures folder.';

/* name, page + query, viewport, steps after load, a JS condition the empty state is drawn by,
   tile selector, title selector ('#id::text' = the element's own text node, for a one-line state whose
   words sit directly in the element), the title's words (string = exact, RegExp = match), body selector
   (null: a one-line state), the body's words */
const SURFACES = [
  {
    name: 'bar notifications pop-up (none)', page: 'bar/index.html?mode=pill&notifs=none', w: 1280, h: 720,
    click: '#notifs',
    ready: "(() => { const e = document.querySelector('.pop .ntf-empty .es-tile'); return !!e && getComputedStyle(e).visibility === 'visible' && e.getClientRects().length > 0; })()",
    tile: '.pop .ntf-empty .es-tile', title: '.pop .ntf-empty .big', titleText: 'No notifications',
    body: '.pop .ntf-empty .sub', bodyText: NTF_SUB,
  },
  {
    name: 'Win+V clipboard (nothing copied)', page: 'clipboard/index.html?n=0', w: 1280, h: 720,
    ready: "document.body.classList.contains('is-empty') && !!document.getElementById('emptyTitle').textContent",
    tile: '#empty .es-tile', title: '#emptyTitle', titleText: 'Nothing copied yet',
    body: '#emptyText', bodyText: CLIP_SUB,
  },
  {
    name: 'Task view (no windows)', page: 'taskview/index.html?n=0', w: 1536, h: 864,
    ready: "!!document.getElementById('empty').textContent && !document.body.classList.contains('is-idle')",
    tile: '.tv-es', title: '#empty', titleText: /^No windows open on this desktop(\. Pick another desktop above\.)?$/,
    body: null,
  },
  {
    name: 'Alt+Tab switcher (no windows)', page: 'switcher/index.html?n=0', w: 1280, h: 720,
    ready: "document.body.classList.contains('is-empty')",
    tile: '#empty .es-tile', title: '#empty::text', titleText: 'No open windows', body: null,
    panel: '.panel',
  },
  {
    name: 'Clips gallery (no clips)', page: 'clips/index.html?mock=empty', w: 1280, h: 800,
    ready: "!document.getElementById('empty').hidden",
    tile: '#empty .es-tile', title: '#empty .em-title', titleText: 'No clips yet',
    body: '#empty .em-sub', bodyText: CLIPS_SUB,
  },
];

/* the same pages NOT empty: no tile may show */
const FULL = [
  ['Task view with windows', 'taskview/index.html?n=7&d=3', 1536, 864, "!!document.querySelector('.tile')", '.tv-es'],
  ['Alt+Tab switcher with windows', 'switcher/index.html?n=6', 1280, 720, "!!document.querySelector('.tile')", '#empty .es-tile'],
  ['Clips gallery with clips', 'clips/index.html?mock=gallery', 1280, 800, "document.getElementById('empty').hidden && !!document.querySelector('#grid > *')", '#empty .es-tile'],
];

async function until(p, cond, ms) {
  const end = Date.now() + (ms || 4000);
  for (;;) {
    let ok = false;
    try { ok = await p.evaluate(cond); } catch (e) { ok = false; }
    if (ok || Date.now() > end) return !!ok;
    await p.waitForTimeout(100);
  }
}

async function newPage(browser, w, h) {
  const ctx = await browser.newContext({ deviceScaleFactor: 1.25, viewport: { width: w, height: h }, bypassCSP: true });
  const p = await ctx.newPage();
  p.on('pageerror', () => { /* a page without its whole bridge may complain; the layout is what is read */ });
  return { ctx, p };
}

const OFF = '*, *::before, *::after { transition: none !important; animation: none !important; }';

/* everything one theme needs, read in the page */
function readIn(p, theme, s) {
  return p.evaluate(([th, S]) => {
    if (th) document.documentElement.dataset.theme = th; else delete document.documentElement.dataset.theme;
    window.dispatchEvent(new CustomEvent('mantle-theme', { detail: { theme: th || 'light' } }));
    const box = (r) => r && { top: r.top, bottom: r.bottom, left: r.left, right: r.right, w: r.width, h: r.height };
    const words = (x) => String(x == null ? '' : x).replace(/\s+/g, ' ').trim();
    const tile = document.querySelector(S.tile);
    if (!tile) return { missing: S.tile };
    const cs = getComputedStyle(tile);
    const svgs = tile.querySelectorAll('svg');
    let titleBox = null, titleText = null, titleOk = true;
    if (/::text$/.test(S.title)) {
      const host = document.querySelector(S.title.replace(/::text$/, ''));
      const node = host && Array.from(host.childNodes).filter((n) => n.nodeType === 3 && n.textContent.trim())[0];
      if (node) { const rg = document.createRange(); rg.selectNodeContents(node); titleBox = box(rg.getBoundingClientRect()); titleText = words(node.textContent); }
      if (host) { titleText = { node: titleText, all: words(host.textContent), inner: host.innerText }; }
    } else {
      const el = document.querySelector(S.title);
      titleOk = !!el;
      if (el) { titleBox = box(el.getBoundingClientRect()); titleText = words(el.textContent); }
    }
    const bodyEl = S.body ? document.querySelector(S.body) : null;
    const panel = S.panel ? document.querySelector(S.panel) : null;
    const out = {
      shown: cs.display !== 'none' && cs.visibility === 'visible' && tile.getClientRects().length > 0,
      tile: box(tile.getBoundingClientRect()),
      svgN: svgs.length,
      svg: svgs[0] ? box(svgs[0].getBoundingClientRect()) : null,
      tileWords: words(tile.textContent),
      bg: cs.backgroundColor, shadow: cs.boxShadow, radius: cs.borderTopLeftRadius, blur: cs.backdropFilter || 'none',
      titleOk, titleBox, titleText,
      bodyText: bodyEl ? words(bodyEl.textContent) : null,
      panel: panel ? box(panel.getBoundingClientRect()) : null,
    };
    /* what the tokens resolve to right where the tile is (a probe beside it, read after every box above) */
    const probe = (prop, name) => {
      const d = document.createElement('div');
      d.style.position = 'absolute';
      d.style[prop] = 'var(' + name + ')';
      tile.parentElement.appendChild(d);
      const v = getComputedStyle(d)[prop];
      d.remove();
      return v;
    };
    out.wantBg = probe('backgroundColor', '--lg-card');
    out.wantShadow = probe('boxShadow', '--elev-raised');
    return out;
  }, [theme, { tile: s.tile, title: s.title, body: s.body, panel: s.panel || null }]);   // selectors only (no RegExp across)
}

const near = (a, b, tol) => Math.abs(a - b) <= (tol === undefined ? 0.5 : tol);
const alphaOf = (c) => { const m = /rgba?\(([^)]*)\)/.exec(c || ''); if (!m) return c === 'transparent' ? 0 : 1; const p = m[1].split(',').map(Number); return p.length > 3 ? p[3] : 1; };
const wordsMatch = (got, want) => (want instanceof RegExp ? want.test(got || '') : got === want);

async function run() {
  if (H.gaming()) { console.log('a game is running: skipped'); t.check('not skipped (a game was running)', false); return; }
  await H.withBrowser(async (open) => {
    const pg0 = await open('?mode=pill', { w: 300, h: 100, settle: 20 });
    const browser = pg0.page.context().browser();

    for (const s of SURFACES) {
      const { ctx, p } = await newPage(browser, s.w, s.h);
      try {
        await p.goto(UI + s.page, { waitUntil: 'load' });
        await p.addStyleTag({ content: OFF });
        await p.waitForTimeout(400);
        if (s.click) {
          try { await p.click(s.click, { timeout: 2500 }); } catch (e) { await p.evaluate((sel) => { const b = document.querySelector(sel); if (b) b.click(); }, s.click); }
        }
        const drawn = await until(p, s.ready, 5000);
        if (!t.check(`${s.name}: the empty state is drawn (${s.page})`, drawn, s.ready)) continue;
        await p.waitForTimeout(150);

        const res = {};
        for (const theme of ['light', 'dark']) {
          const r = await readIn(p, theme === 'dark' ? 'dark' : null, s);
          res[theme] = r;
          const tag = `${s.name} [${theme}]`;
          if (!t.check(`${tag}: the icon tile is on the page (${s.tile})`, r && !r.missing, r && r.missing)) continue;
          t.check(`${tag}: the tile is shown`, r.shown, r);
          t.check(`${tag}: the tile is 40 x 40`, r.tile && near(r.tile.w, 40) && near(r.tile.h, 40), r.tile);
          t.check(`${tag}: the tile's corners are 12 px`, r.radius === '12px', r.radius);
          t.check(`${tag}: the tile holds one svg, drawn at 18 x 18`, r.svgN === 1 && r.svg && near(r.svg.w, 18) && near(r.svg.h, 18), { n: r.svgN, svg: r.svg });
          t.check(`${tag}: the icon is centred in the tile`, r.svg && r.tile && near(r.svg.left - r.tile.left, r.tile.right - r.svg.right, 1) && near(r.svg.top - r.tile.top, r.tile.bottom - r.svg.bottom, 1), { svg: r.svg, tile: r.tile });
          t.check(`${tag}: the tile's fill is not transparent`, alphaOf(r.bg) > 0, r.bg);
          t.check(`${tag}: the tile's fill is the --lg-card token`, r.bg === r.wantBg, { got: r.bg, want: r.wantBg });
          t.check(`${tag}: the tile's shadow is the --elev-raised token`, r.shadow === r.wantShadow && r.shadow !== 'none', { got: r.shadow, want: r.wantShadow });
          t.check(`${tag}: no backdrop-filter on the tile`, r.blur === 'none', r.blur);
          t.check(`${tag}: the tile adds no words`, r.tileWords === '', r.tileWords);
          if (!t.check(`${tag}: the title is on the page (${s.title})`, r.titleOk && r.titleBox, s.title)) continue;
          const gap = r.titleBox.top - r.tile.bottom;
          t.check(`${tag}: the tile sits above the title, ~12 px over it`, gap >= 8 && gap <= 16, { gap, tile: r.tile, title: r.titleBox });
          const cx = (b) => (b.left + b.right) / 2;
          t.check(`${tag}: the tile is centred on the title`, near(cx(r.tile), cx(r.titleBox), 2), { tile: cx(r.tile), title: cx(r.titleBox) });
          if (typeof r.titleText === 'object' && r.titleText) {
            t.check(`${tag}: the words are unchanged ("${s.titleText}")`, r.titleText.node === s.titleText && r.titleText.all === s.titleText, r.titleText);
            t.check(`${tag}: innerText is still exactly the words (what the page test reads)`, r.titleText.inner === s.titleText, r.titleText.inner);
          } else {
            t.check(`${tag}: the title's words are unchanged`, wordsMatch(r.titleText, s.titleText), r.titleText);
          }
          if (s.body) t.check(`${tag}: the body's words are unchanged`, r.bodyText === s.bodyText, r.bodyText);
          if (s.panel) {
            t.check(`${tag}: tile and words fit inside the panel`, r.panel && r.tile.top >= r.panel.top + 4 && r.titleBox.bottom <= r.panel.bottom - 4, { panel: r.panel, tile: r.tile, words: r.titleBox });
            t.check(`${tag}: tile and words sit centred in the panel`, r.panel && near(r.tile.top - r.panel.top, r.panel.bottom - r.titleBox.bottom, 4), { panel: r.panel, tile: r.tile, words: r.titleBox });
          }
        }
        if (res.light && res.dark && !res.light.missing && !res.dark.missing) {
          t.check(`${s.name}: light and dark fill the tile differently (the theme reaches it)`, res.light.bg !== res.dark.bg, { light: res.light.bg, dark: res.dark.bg });
          /* relative to the title, not the page: a surface may lay out a few px differently per theme on its
             own (the notifications pop-up's dark rows are ~4 px shorter), which is not this recipe's doing */
          const off = (r) => ({ dy: r.tile.top - r.titleBox.top, dx: (r.tile.left + r.tile.right) / 2 - (r.titleBox.left + r.titleBox.right) / 2 });
          const lo = off(res.light), dk = off(res.dark);
          t.check(`${s.name}: the tile sits the same way over its title in both themes`, near(lo.dy, dk.dy, 1) && near(lo.dx, dk.dx, 1), { light: lo, dark: dk });
        }
      } finally {
        await ctx.close();
      }
    }

    for (const [name, page, w, h, ready, sel] of FULL) {
      const { ctx, p } = await newPage(browser, w, h);
      try {
        await p.goto(UI + page, { waitUntil: 'load' });
        await p.addStyleTag({ content: OFF });
        const drawn = await until(p, ready, 5000);
        if (!t.check(`${name}: the page has content (${page})`, drawn, ready)) continue;
        for (const theme of ['light', 'dark']) {
          const stray = await p.evaluate(([th, s]) => {
            if (th) document.documentElement.dataset.theme = th; else delete document.documentElement.dataset.theme;
            const e = document.querySelector(s);
            if (!e) return 'no tile element';
            const cs = getComputedStyle(e);
            return cs.display !== 'none' && cs.visibility === 'visible' && e.getClientRects().length > 0 ? 'shown' : '';
          }, [theme === 'dark' ? 'dark' : null, sel]);
          t.check(`${name} [${theme}]: no stray empty-state tile`, stray === '', stray);
        }
      } finally {
        await ctx.close();
      }
    }
  });
}

run().catch((e) => { t.check('the run finished', false, e && e.stack || String(e)); }).then(() => t.done());

require('C:/Users/user/dev-tools/tools/lowcpu.js');
/* clipped-shadow.test.js - no CUT-OFF drop shadows in dark (lane clipped-shadow, 2026-10-10).
 *
 * Owen: "i wanted you to fix this black sharp stuff around the outside of a lot of it." Mantle's dark
 * drop shadows (--lg-shadow .34 + .42 black, the bar's --lg-drop-up .30 + .32) need 40-90 DIP of room;
 * the windows below keep 0-18 DIP round their surface, so the shadow was cut at the window's edge or
 * shape into a near-black band with a hard edge and square corners. The fix: in DARK these surfaces end
 * on their hairline and lip, no outer shadow. LIGHT is held exactly as it was (its outer shadow stays),
 * and surfaces with room for the whole shadow inside their own window keep it in dark too.
 *
 * WHAT: headless Chromium over the REAL pages (file://, never Electron, never a window of Owen's), each
 * read in light and in dark (<html data-theme>, flipped live), transitions off (a test-only style, CSP
 * bypassed for it) so the value read is the settled one:
 *   - CUT surfaces: dark has no outer layer (every layer inset, or a 0-blur 0-offset hairline ring, or
 *     zero alpha); light still has its outer drop, the same layers as the light token it uses;
 *   - the bar's reveal: dark --pane-drop down and up are the same shape (layer count + inset-ness), so
 *     the 560 ms box-shadow transition interpolates instead of snapping;
 *   - KEEPERS (full-screen or in-app, room to spare): dark still has its outer shadow.
 *
 *   node ui/shared/clipped-shadow.test.js     -> "CLIPPED SHADOW TEST: n passed, m failed"
 */
'use strict';
const H = require('../bar/page-harness.js');
const t = H.suite('CLIPPED SHADOW TEST');
const UI = 'file:///' + require('path').resolve(__dirname, '..').replace(/\\/g, '/') + '/';

/* id, page, setup (run after the theme is set), selector, the light token its outer drop must equal */
const CUT = [
  ['bottom bar pill', 'bar/index.html?mode=pill', "document.body.classList.add('up')", '.bar', '--lg-drop-up'],
  ['bar pop-up', 'bar/index.html?mode=pill', "document.body.classList.add('up'); document.getElementById('pop').hidden = false", '#pop', '--lg-shadow'],
  ['bar tooltip', 'bar/index.html?mode=pill', "if (!document.querySelector('.mtip')) { var e = document.createElement('div'); e.className = 'mtip'; e.textContent = 'x'; document.body.appendChild(e); }", '.mtip', '--lg-shadow'],
  ['top bar dropdown', 'topbar/index.html', "if (!document.querySelector('#menus > .dd')) { var d = document.createElement('div'); d.className = 'dd'; (document.getElementById('menus') || document.body).appendChild(d); }", '.dd', '--lg-shadow'],
  ['launcher', 'launcher/index.html', '', '.panel', '--lg-shadow'],
  ['switcher', 'switcher/index.html', '', '.panel', '--lg-shadow'],
  ['clipboard (Win+V)', 'clipboard/index.html', '', '.panel', '--lg-shadow'],
  ['volume/brightness OSD', 'osd/index.html', '', '.osd', '--lg-shadow'],
  ['layouts toast', 'layouts/index.html', '', '.toast', '--lg-shadow'],
  ['on-top toast', 'ontop/index.html', '', '.toast', '--lg-shadow'],
  ['timer card', 'timer/index.html', '', '.card', '--lg-shadow'],
  ['notes pad', 'notes/index.html', '', '.pad', '--lg-shadow'],
  ['snap picker', 'snap/index.html', "document.body.classList.add('mode-picker')", '.panel', '--lg-shadow'],
  ['screenshot card', 'screenshot/card.html', '', '#card', '--lg-shadow'],
];
const KEEP = [
  ['desktop widget pane (full-screen desktop)', 'desktop/index.html', '', '.pane'],
  ['task view drag chip (full screen)', 'taskview/index.html', "var e = document.createElement('div'); e.className = 'chip-drag'; document.body.appendChild(e)", '.chip-drag'],
  ['screenshot overlay problem card (full screen)', 'screenshot/index.html', '', '#problem'],
  ['Files menu (in its app window)', 'files/index.html', "if (!document.querySelector('.menu')) { var e = document.createElement('div'); e.className = 'menu'; document.body.appendChild(e); }", '.menu'],
];

/* "rgba(0, 0, 0, 0.34) 0px 4px 12px 0px, ..." -> [{alpha, x, y, blur, spread, inset}] */
function layers(s) {
  if (!s || s === 'none') return [];
  const out = [];
  let depth = 0, cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.map((l) => {
    const col = /rgba?\(([^)]*)\)/.exec(l);
    const parts = col ? col[1].split(',').map(Number) : [0, 0, 0, 0];
    const nums = l.replace(/rgba?\([^)]*\)/, '').match(/-?[\d.]+px/g) || [];
    const [x, y, blur, spread] = nums.map(parseFloat).concat([0, 0, 0, 0]);
    return { alpha: parts.length > 3 ? parts[3] : 1, x, y, blur, spread, inset: /\binset\b/.test(l) };
  });
}
/* an outer drop: outside the box, blurred or offset, and visible */
const outerDrops = (s) => layers(s).filter((l) => !l.inset && l.alpha > 0 && (l.blur > 0 || l.x !== 0 || l.y !== 0));
const shape = (s) => layers(s).map((l) => (l.inset ? 'i' : 'o')).join('');

async function read(browser, page, setup, sel) {
  const ctx = await browser.newContext({ deviceScaleFactor: 1.25, viewport: { width: 1280, height: 800 }, bypassCSP: true });
  const p = await ctx.newPage();
  p.on('pageerror', () => { /* a page without its bridge may complain; the CSS is what is read */ });
  await p.goto(UI + page, { waitUntil: 'load' });
  await p.addStyleTag({ content: '*, *::before, *::after { transition: none !important; animation: none !important; }' });
  await p.waitForTimeout(250);
  const one = (theme) => p.evaluate(([th, setupSrc, s]) => {
    if (th) document.documentElement.dataset.theme = th; else delete document.documentElement.dataset.theme;
    window.dispatchEvent(new CustomEvent('mantle-theme', { detail: { theme: th || 'light' } }));
    try { if (setupSrc) (0, eval)(setupSrc); } catch (e) { /* page without its bridge */ }
    const e = document.querySelector(s);
    if (!e) return null;
    const root = getComputedStyle(document.documentElement);
    const probe = (name) => { const d = document.createElement('div'); d.style.boxShadow = root.getPropertyValue(name).trim(); document.body.appendChild(d); const v = getComputedStyle(d).boxShadow; d.remove(); return v; };
    return { shadow: getComputedStyle(e).boxShadow, tok: { '--lg-shadow': probe('--lg-shadow'), '--lg-drop-up': probe('--lg-drop-up') } };
  }, [theme, setup, sel]);
  const light = await one(null);
  const dark = await one('dark');
  await ctx.close();
  return { light, dark };
}

async function run() {
  if (H.gaming()) { console.log('a game is running: skipped'); t.check('not skipped (a game was running)', false); return; }
  await H.withBrowser(async (open) => {
    const pg0 = await open('?mode=pill', { w: 300, h: 100, settle: 20 });
    const browser = pg0.page.context().browser();

    for (const [name, page, setup, sel, tokName] of CUT) {
      const r = await read(browser, page, setup, sel);
      if (!t.check(`${name}: the surface is on the page (${sel})`, r.light && r.dark, page)) continue;
      t.check(`${name}: DARK has no outer drop shadow (the window would cut it)`, outerDrops(r.dark.shadow).length === 0, r.dark.shadow);
      const want = outerDrops(r.light.tok[tokName]);
      const got = outerDrops(r.light.shadow);
      t.check(`${name}: LIGHT keeps its outer drop, layer for layer the light ${tokName}`,
        want.length > 0 && JSON.stringify(got) === JSON.stringify(want), { got: r.light.shadow, want: r.light.tok[tokName] });
    }

    /* the bar's reveal interpolates: down (flush) and up (detached) are the same shape in both themes */
    {
      const ctx = await browser.newContext({ deviceScaleFactor: 1.25, viewport: { width: 1280, height: 480 }, bypassCSP: true });
      const p = await ctx.newPage();
      await p.goto(UI + 'bar/index.html?mode=pill', { waitUntil: 'load' });
      await p.addStyleTag({ content: '*, *::before, *::after { transition: none !important; }' });
      await p.waitForTimeout(250);
      const drop = (theme, up, edge) => p.evaluate(([th, u, ed]) => {
        if (th) document.documentElement.dataset.theme = th; else delete document.documentElement.dataset.theme;
        document.body.classList.toggle('up', u);
        if (ed) document.body.dataset.edge = ed; else delete document.body.dataset.edge;
        return getComputedStyle(document.querySelector('.bar')).boxShadow;
      }, [theme, up, edge]);
      for (const edge of [null, 'top']) {
        const where = edge ? 'docked top' : 'bottom';
        const dDown = await drop('dark', false, edge), dUp = await drop('dark', true, edge);
        const lDown = await drop(null, false, edge), lUp = await drop(null, true, edge);
        t.check(`bar reveal (${where}, dark): flush and detached drops are the same shape, so the transition does not snap`,
          shape(dDown) === shape(dUp) && shape(dUp).length > 0, { dDown, dUp });
        t.check(`bar reveal (${where}, dark): detached has no visible outer drop`, outerDrops(dUp).length === 0, dUp);
        t.check(`bar reveal (${where}, light): detached keeps its drop, same shape as flush`,
          outerDrops(lUp).length === 3 && shape(lDown) === shape(lUp), { lDown, lUp });
      }
      await ctx.close();
    }

    for (const [name, page, setup, sel] of KEEP) {
      const r = await read(browser, page, setup, sel);
      if (!t.check(`${name}: the surface is on the page (${sel})`, r.light && r.dark, page)) continue;
      t.check(`${name}: has room, so DARK keeps its outer shadow`, outerDrops(r.dark.shadow).length > 0, r.dark.shadow);
      t.check(`${name}: LIGHT keeps its outer shadow`, outerDrops(r.light.shadow).length > 0, r.light.shadow);
    }
  });
}

run().catch((e) => { t.check('the run finished', false, e && e.stack || String(e)); }).then(() => t.done());

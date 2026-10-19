require('../../tools/dev-env.js').lowcpu();
/* hud-backdrop.test.js - the blurred picture under a floating HUD (ui/shared/hud-backdrop.js), lanes
 * see-huds 2026-10-09. Static: every HUD page links it with an event and a pane that exists. In a
 * headless page (the volume pop-up over its mock): light never moves; dark keeps ONE --lg-fill-pop face
 * until a picture lands, then ONE --lg-fill layer over the baked picture; a bad payload, {clear:true},
 * a hidden page and a switch to light all drop it, each with a reason.
 *   node ui/shared/hud-backdrop.test.js */
'use strict';
const fs = require('fs');
const path = require('path');
const { chromium } = require('../../tools/dev-env.js').playwright();

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('FAIL ' + m); } };

const UI = path.join(__dirname, '..');
const PAGES = [
  ['osd/index.html', 'osd.backdrop'], ['clipboard/index.html', 'clipboard.backdrop'], ['notes/index.html', 'notes.backdrop'],
  ['timer/index.html', 'timer.backdrop'], ['ontop/index.html', 'ontop.backdrop'], ['layouts/index.html', 'layouts.backdrop'],
  ['snap/index.html', 'snap.backdrop'], ['screenshot/card.html', 'screenshot.card.backdrop'],
];
for (const [p, ev] of PAGES) {
  const html = fs.readFileSync(path.join(UI, p), 'utf8');
  const m = /<script src="\.\.\/shared\/hud-backdrop\.js" data-event="([^"]+)" data-pane="#([\w-]+)"><\/script>/.exec(html);
  ok(!!m && m[1] === ev, `${p}: loads hud-backdrop.js for "${ev}"`);
  ok(!!m && new RegExp(`id="${m[2]}"`).test(html), `${p}: its pane #${m && m[2]} is in the page`);
  ok(html.indexOf('../shared/glass-adapt.js') > -1 && html.indexOf('../shared/glass-adapt.js') < html.indexOf('hud-backdrop.js"'), `${p}: glass-adapt.js loads before it`);
  ok(/<link rel="stylesheet" href="\.\.\/shared\/hud-backdrop\.css">/.test(html), `${p}: links hud-backdrop.css`);
}
const css = fs.readFileSync(path.join(__dirname, 'hud-backdrop.css'), 'utf8');
ok(css.replace(/\/\*[\s\S]*?\*\//g, '').split('{').slice(0, -1).every((sel) => /:root\[data-theme="dark"\]/.test(sel)), 'hud-backdrop.css: every rule is scoped to dark');

const PAGE = 'file:///' + path.join(UI, 'osd', 'index.html').replace(/\\/g, '/') + '?level=62';
// a picture: a bright busy half and a white half, the size of the window
const PIC = (w, h) => `(() => { const c = document.createElement('canvas'); c.width = ${w}; c.height = ${h}; const g = c.getContext('2d');
  for (let x = 0; x < ${w}; x += 8) { g.fillStyle = x % 16 ? '#fafafa' : '#203040'; g.fillRect(x, 0, 8, ${h}); } return c.toDataURL('image/png'); })()`;

(async () => {
  const browser = await chromium.launch({ headless: true, timeout: 0 });
  try {
    for (const theme of ['light', 'dark']) {
      const ctx = await browser.newContext({ viewport: { width: 440, height: 140 }, deviceScaleFactor: 1 });
      // <html data-theme> before first paint, as the app's theme plumbing does (documentElement may not exist yet)
      await ctx.addInitScript((t) => {
        const set = () => { if (document.documentElement) document.documentElement.dataset.theme = t; };
        set(); if (!document.documentElement) new MutationObserver((m, o) => { if (document.documentElement) { set(); o.disconnect(); } }).observe(document, { childList: true });
        document.addEventListener('DOMContentLoaded', set);
      }, theme);
      await ctx.addInitScript(() => { let m; window.__on = {}; Object.defineProperty(window, 'mantle', { configurable: true, get() { return m; },
        set(v) { m = v; if (v && typeof v.on === 'function') { const o = v.on.bind(v); v.on = (n, f) => { (window.__on[n] = window.__on[n] || []).push(f); return o(n, f); }; } } }); });
      const page = await ctx.newPage();
      const errs = []; page.on('pageerror', (e) => errs.push(e.message));
      await page.goto(PAGE, { waitUntil: 'load' });
      await page.waitForTimeout(300);
      const face = () => page.evaluate(() => { const c = getComputedStyle(document.getElementById('osd')); return { color: c.backgroundColor, img: c.backgroundImage, cls: document.getElementById('osd').classList.contains('hud-bd'), api: Object.assign({}, window.__hudBackdrop) }; });
      const send = (p) => page.evaluate((p) => { (window.__on['osd.backdrop'] || []).forEach((f) => f(p)); }, p);
      const before = await face();
      ok((await page.evaluate(() => (window.__on['osd.backdrop'] || []).length)) === 1, `${theme}: listens to osd.backdrop once`);
      const png = await page.evaluate(PIC(440, 140));
      await send({ png, w: 440, h: 140, rect: { x: 0, y: 0, w: 440, h: 140 }, ms: 9 });
      await page.waitForTimeout(300);
      const after = await face();
      if (theme === 'light') {
        ok(!after.cls && after.color === before.color && after.img === before.img, `light: a picture changes nothing (${after.color} / ${after.img.slice(0, 40)})`);
        ok(/light/.test(after.api.reason), `light: says why it stayed off ("${after.api.reason}")`);
      } else {
        // the contract, read from the tokens (their values move with Helm; the layering must not)
        const tok = await page.evaluate(() => {
          const norm = (v) => { const d = document.createElement('i'); d.style.color = v; document.body.appendChild(d); const c = getComputedStyle(d).color; d.remove(); return c; };
          const cs = getComputedStyle(document.documentElement);
          return { fill: norm(cs.getPropertyValue('--lg-fill').trim()), pop: norm(cs.getPropertyValue('--lg-fill-pop').trim()), blur: cs.getPropertyValue('--lg-blur').trim() };
        });
        ok(before.color === tok.pop && before.img === 'none', `dark, no picture yet: ONE --lg-fill-pop layer (${before.color} = ${tok.pop}, image ${before.img})`);
        ok(after.cls && after.api.state === 'on' && after.api.bakes === 1, `dark: the picture is baked once and the pane is .hud-bd (${JSON.stringify(Object.assign({}, after.api, { request: undefined }))})`);
        const layers = after.img.split(/,\s*(?=linear-gradient|url)/);
        ok(layers.length === 2 && layers[0] === `linear-gradient(${tok.fill}, ${tok.fill})` && /^url\("data:image\/png/.test(layers[1]) && after.color === 'rgba(0, 0, 0, 0)',
          `dark: ONE --lg-fill layer (${tok.fill}) over the baked picture, nothing stacked (${after.img.slice(0, 70)}... over ${after.color})`);
        ok(after.api.guard && after.api.guard.engaged === false, `dark: the shared guard did not thicken the tint (${JSON.stringify(after.api.guard)})`);
        ok(after.api.ms === 9, `dark: main's capture time is kept for the checks (ms ${after.api.ms})`);
        // request(): asks main once per show with its key, holds the pane unseen until the picture,
        // and maps main's `at` (where the shot sits in the window) onto the pane
        await page.evaluate(() => {
          window.__asked = [];
          const m = window.mantle, orig = m.call.bind(m);
          m.call = (n, a) => (n === 'hud.backdrop' ? (window.__asked.push(a), Promise.resolve({ ok: true, ms: 7 })) : orig(n, a));
        });
        const held = await page.evaluate(() => { const p = window.MantleHudBackdrop.request('shown', { hold: true }); window.MantleHudBackdrop.request('again', { hold: true }); window.__req = p; return document.getElementById('osd').classList.contains('hud-hold'); });
        const asked = await page.evaluate(() => window.__asked.slice());
        ok(held && asked.length === 1 && asked[0].key === 'osd', `dark: request() asks hud.backdrop {key:'osd'} once for two calls in a row and holds the pane (${JSON.stringify(asked)}, held ${held})`);
        await send({ png, w: 220, h: 140, at: { x: 0.5, y: 0, w: 0.5, h: 1 }, win: { w: 440, h: 140 }, ms: 7 });
        const got = await page.evaluate(() => window.__req);
        const s2 = await face();
        ok(got && got.ok === true && s2.cls && !(await page.evaluate(() => document.getElementById('osd').classList.contains('hud-hold'))),
          `dark: the picture settles the request and lets the pane be seen (${JSON.stringify(got)})`);
        const late = await page.evaluate(() => { window.__asked.length = 0; window.mantle.call = () => new Promise(() => {}); window.MantleHudBackdrop.request('slow', { hold: 60 }); return document.getElementById('osd').classList.contains('hud-hold'); });
        await page.waitForTimeout(150);
        ok(late && !(await page.evaluate(() => document.getElementById('osd').classList.contains('hud-hold'))), 'dark: a picture that does not come in time never keeps the pane hidden past the hold');
        await send({ png: 'nope' }); await page.waitForTimeout(100);
        let s = await face();
        ok(!s.cls && /no png data URL/.test(s.api.reason), `dark: a payload without a png drops it and says so ("${s.api.reason}")`);
        ok(s.color === tok.pop, `dark: ...and the pane is back on its own face (${s.color})`);
        await send({ png, w: 440, h: 140 }); await page.waitForTimeout(300);
        await send({ clear: true, reason: 'parked' }); await page.waitForTimeout(100);
        s = await face();
        ok(!s.cls && s.api.reason === 'parked', `dark: {clear:true} drops it with main's reason ("${s.api.reason}")`);
        await send({ png, w: 440, h: 140 }); await page.waitForTimeout(300);
        await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; window.dispatchEvent(new CustomEvent('mantle-theme', { detail: { theme: 'light' } })); });
        await page.waitForTimeout(100);
        s = await face();
        ok(!s.cls && /light/.test(s.api.reason), `dark -> light: dropped ("${s.api.reason}")`);
      }
      ok(errs.length === 0, `${theme}: no page errors ${errs.join(' | ')}`);
      await ctx.close();
    }
  } finally { await browser.close(); }
  console.log(`hud-backdrop: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('hud-backdrop: FAILED', e); process.exit(1); });

require('C:/Users/user/dev-tools/tools/lowcpu.js');
/* kit-choice.test.js — a category page's dropdown (kit.choice() with style 'dropdown') wears the chevron,
 * in the light AND the dark theme (lane mn-suite, 2026-10-12).
 *
 * WHY: kit.choice() built a bare <select>. Settings' <select> has appearance:none and leaves 28px on the
 * right for a chevron that only .selwrap::after draws, so every category-page dropdown (Power, Time,
 * Gaming...) looked like a plain text box. Now it sits in .selwrap like the Mantle page's dropdowns.
 *
 * Drives the real page code: ui/settings/index.html on the mock, the System > Power page, its data played
 * by system-pages.test.js's own FAKE() bridge (made-up values; nothing real is read or written).
 * Headless chromium over file://, never Electron, never on screen.
 *
 *   node ui/settings/kit-choice.test.js      Prints "KIT CHOICE TEST: n passed, m failed".
 */
'use strict';
const path = require('path');
const fs = require('fs');

const PAGE = 'file:///' + path.join(__dirname, 'index.html').replace(/\\/g, '/');
let passed = 0;
const failures = [];
const check = (name, ok, detail) => { if (ok) passed++; else failures.push(name + (detail !== undefined ? ' (' + JSON.stringify(detail).slice(0, 300) + ')' : '')); return ok; };

(async () => {
  const src = fs.readFileSync(path.join(__dirname, 'sections', 'system-pages.test.js'), 'utf8').replace(/\r/g, '');
  const a = src.indexOf('function FAKE() {');
  const b = a < 0 ? -1 : src.indexOf('\n}\n', a);
  if (!check('system-pages.test.js still has its FAKE() bridge to play the Power page', a >= 0 && b > a)) return;
  const fake = '(' + src.slice(a, b + 2) + ')();';

  const { chromium } = require('C:/Users/user/other-app/node_modules/playwright-core');
  const browser = await require('./test-browser.js').launch(chromium);
  try {
    for (const theme of ['light', 'dark']) {
      const ctx = await browser.newContext({ viewport: { width: 1040, height: 760 }, deviceScaleFactor: 1.25, colorScheme: theme });
      await ctx.addInitScript({ content: fake });
      await ctx.addInitScript((t) => {
        const put = () => { if (document.documentElement) { document.documentElement.dataset.theme = t; return true; } return false; };
        if (!put()) new MutationObserver((_, mo) => { if (put()) mo.disconnect(); }).observe(document, { childList: true });
        document.addEventListener('DOMContentLoaded', () => { put(); window.dispatchEvent(new CustomEvent('mantle-theme', { detail: { theme: t } })); });
      }, theme);
      const page = await ctx.newPage();
      const errs = [];
      page.on('pageerror', (e) => errs.push(e.message));
      await page.goto(PAGE + '?section=system&page=power', { waitUntil: 'load' });
      await page.waitForSelector('html[data-ready="1"]', { timeout: 8000 }).catch(() => {});
      await page.waitForSelector('.row.k-choice select', { timeout: 8000 }).catch(() => {});
      const r = await page.evaluate(() => {
        const ink = getComputedStyle(document.documentElement).getPropertyValue('--lg-ink-2').trim();
        const probe = document.createElement('i'); probe.style.color = ink; document.body.appendChild(probe);
        const inkRgb = getComputedStyle(probe).color; probe.remove();
        return {
          theme: document.documentElement.dataset.theme,
          inkRgb,
          rows: [...document.querySelectorAll('.row.k-choice select')].map((s) => {
            const w = s.parentElement, after = getComputedStyle(w, '::after'), sr = s.getBoundingClientRect(), wr = w.getBoundingClientRect();
            return {
              wrapped: w.classList.contains('selwrap'), content: after.content, bw: parseFloat(after.borderRightWidth) || 0,
              color: after.borderRightColor, padR: parseFloat(getComputedStyle(s).paddingRight) || 0,
              // the chevron is drawn inside the select's own box: the wrap hugs it
              hugs: Math.abs(sr.width - wr.width) < 1.5 && Math.abs(sr.height - wr.height) < 4,
            };
          }),
          segs: document.querySelectorAll('.row.k-choice .seg').length,
          segWrapped: document.querySelectorAll('.row.k-choice .selwrap > .seg').length,
        };
      });
      check(`${theme}: the page took the theme`, r.theme === theme, r.theme);
      check(`${theme}: the Power page draws kit dropdowns`, r.rows.length >= 3, r.rows.length);
      const bad = r.rows.filter((x) => !x.wrapped);
      check(`${theme}: every kit dropdown is inside .selwrap`, bad.length === 0, `${bad.length} of ${r.rows.length} bare`);
      const noChev = r.rows.filter((x) => x.content === 'none' || x.bw <= 0);
      check(`${theme}: every kit dropdown draws the chevron`, noChev.length === 0, noChev[0]);
      const offInk = r.rows.filter((x) => x.color !== r.inkRgb);
      check(`${theme}: the chevron is the theme's --lg-ink-2`, offInk.length === 0, { want: r.inkRgb, got: offInk[0] && offInk[0].color });
      check(`${theme}: the select leaves room for it and the wrap hugs the select`, r.rows.every((x) => x.padR >= 20 && x.hugs), r.rows.find((x) => !(x.padR >= 20 && x.hugs)));
      check(`${theme}: segmented choices are NOT wrapped (no chevron on a button row)`, r.segWrapped === 0, { segs: r.segs, wrapped: r.segWrapped });
      // a dropdown still works through the wrap: picking a value reaches the bridge and the row keeps it
      const sel = await page.$('.row.k-choice .selwrap select:not([disabled])');
      if (check(`${theme}: an enabled dropdown to pick from`, !!sel)) {
        const opts = await sel.evaluate((s) => [...s.options].map((o) => o.value));
        const was = await sel.evaluate((s) => s.value);
        const next = opts.find((v) => v !== was);
        await sel.selectOption(next);
        await page.waitForTimeout(600);
        // the change reaches the row's onChange: the value sticks, or (the mock's answer) it springs back WITH words
        const after = await sel.evaluate((s) => ({ v: s.value, note: (s.closest('.row').querySelector('.row-w') || {}).textContent || '' }));
        check(`${theme}: picking a value through the wrapped dropdown reaches the page (sticks, or springs back with a reason)`, after.v === next || (after.v === was && after.note.trim().length > 0), { was, next, after });
      }
      check(`${theme}: no page error`, errs.length === 0, errs);
      await ctx.close();
    }
  } finally { await browser.close(); }
})().catch((e) => failures.push('the test threw: ' + (e && e.stack || e))).then(() => {
  console.log(`KIT CHOICE TEST: ${passed} passed, ${failures.length} failed`);
  for (const f of failures) console.log('  FAIL ' + f);
  process.exitCode = failures.length ? 1 : 0;
});

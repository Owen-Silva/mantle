// The CPU cap and the one-browser lock on Owen's PC; a CI runner (cloudtest) has neither file nor need.
require('../../tools/dev-env.js').lowcpu();
/* welcome.page.test.js - the first-start cards (index.html + welcome.js + welcome.css on mock-mantle.js),
 * clicked and typed through in headless Chromium over file:// (lane mantle-firstrun, 2026-10-15).
 *
 * Every check drives the page the way a person would (keys, clicks) and reads what it asked Mantle for
 * (window.__mockCalls) and what it shows. Light and dark. Shots of every card in both themes go to
 * MANTLE_SHOTS_DIR (default %TEMP%\mantle-welcome-shots), over a made-up desktop (desk=1).
 *
 *   node ui/welcome/welcome.page.test.js   -> "WELCOME PAGE TEST: n passed, m failed"
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

let chromium = null;
for (const c of require('../../tools/dev-env.js').playwrightCandidates()) { try { chromium = require(c).chromium; break; } catch (_) { /* next */ } }
const PAGE = 'file:///' + path.join(__dirname, 'index.html').replace(/\\/g, '/');
const SHOTS = path.resolve(process.env.MANTLE_SHOTS_DIR || path.join(os.tmpdir(), 'mantle-welcome-shots'));
const W = 624, H = 564;   // lib/welcome.js WIN_W x WIN_H
let passed = 0;
const failures = [];
const check = (name, ok, detail) => { if (ok) passed++; else failures.push(detail !== undefined ? `${name} (${String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 300)})` : name); return ok; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function rgb(s) {
  const m = /rgba?\(([^)]+)\)/.exec(s) || [];
  if (m[1]) { const p = m[1].split(',').map((x) => parseFloat(x)); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; }
  const hx = /#([0-9a-f]{6})/i.exec(s);
  if (hx) { const v = parseInt(hx[1], 16); return { r: v >> 16, g: (v >> 8) & 255, b: v & 255, a: 1 }; }
  return null;
}
const over = (top, under) => ({ r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a), a: 1 });
function lum(c) { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); }
const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

async function main() {
  if (!chromium) { console.log('WELCOME PAGE TEST: 0 passed, 1 failed (playwright-core not found)'); process.exit(1); }
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await require('../settings/test-browser.js').launch(chromium, { headless: true });
  const errors = [];
  async function open(q, opts) {
    const page = await browser.newPage({ viewport: { width: W, height: H }, reducedMotion: opts && opts.reduced ? 'reduce' : 'no-preference' });
    page.on('pageerror', (e) => errors.push(`${q}: ${e.message}`));
    await page.goto(`${PAGE}?${q}`, { waitUntil: 'load' });
    await page.waitForFunction(() => document.documentElement.getAttribute('data-ready') === '1', null, { timeout: 5000 });
    await sleep(60);
    return page;
  }
  const step = (p) => p.evaluate(() => document.documentElement.getAttribute('data-step'));
  const calls = (p, name) => p.evaluate((n) => window.__mockCalls.filter((c) => c.name === n), name);
  const focused = (p) => p.evaluate(() => document.activeElement && (document.activeElement.id || document.activeElement.getAttribute('data-act')));

  try {
    for (const theme of ['light', 'dark']) {
      const p = await open(`theme=${theme}&desk=1`);
      check(`${theme}: page carries the theme`, await p.evaluate(() => document.documentElement.getAttribute('data-theme')) === theme);
      check(`${theme}: card 1 first`, await step(p) === 'changed');
      check(`${theme}: Next has the keyboard at the start`, await focused(p) === 'next', await focused(p));
      const ring = await p.evaluate(() => { const cs = getComputedStyle(document.getElementById('next')); return { kb: document.body.classList.contains('kb'), outline: cs.outlineStyle, shadow: cs.boxShadow }; });
      check(`${theme}: no focus ring before a key is pressed`, !ring.kb && ring.outline === 'none' && ring.shadow === 'none', ring);
      const c1 = await p.evaluate(() => ({ title: document.getElementById('title').textContent, items: [...document.querySelectorAll('.item')].map((i) => i.querySelector('.iname').textContent),
        backHidden: getComputedStyle(document.getElementById('back')).visibility === 'hidden', next: document.getElementById('next').textContent, skip: !!document.getElementById('skip') }));
      check(`${theme}: card 1 says what changed (bar, top bar, launcher)`, c1.title === 'A new shell, with Windows underneath' && c1.items.join('|') === 'The bar|The top bar|The launcher', c1);
      check(`${theme}: card 1 has no Back, has Next and Skip`, c1.backHidden && c1.next === 'Next' && c1.skip, c1);

      // the colours the words actually sit on (the card's face is --lg-fill-pop over --lg-ground)
      const tok = await p.evaluate(() => { const s = getComputedStyle(document.documentElement); return ['--lg-fill-pop', '--lg-ground', '--lg-ink', '--lg-ink-2', '--lg-ink-3', '--lg-acc', '--lg-acc-on'].reduce((o, k) => { o[k] = s.getPropertyValue(k).trim(); return o; }, {}); });
      const face = over(rgb(tok['--lg-fill-pop']) || { r: 0, g: 0, b: 0, a: 0 }, rgb(tok['--lg-ground']));
      const cr = { ink: contrast(rgb(tok['--lg-ink']), face), ink2: contrast(rgb(tok['--lg-ink-2']), face), ink3: contrast(rgb(tok['--lg-ink-3']), face), acc: contrast(rgb(tok['--lg-acc-on']), rgb(tok['--lg-acc'])) };
      check(`${theme}: body text >= 4.5:1 on the card (ink ${cr.ink.toFixed(1)}, ink-2 ${cr.ink2.toFixed(1)})`, cr.ink >= 4.5 && cr.ink2 >= 4.5, cr);
      // quiet words: the colour the page really gives them (dark maps them to ink-2: its ink-3 is 4.1:1 here)
      const quiet = rgb(await p.evaluate(() => getComputedStyle(document.getElementById('count')).color));
      const qc = contrast(quiet, face);
      check(`${theme}: quiet text >= 4.5:1 (${qc.toFixed(1)}; ink-3 token ${cr.ink3.toFixed(1)})`, qc >= 4.5, cr);
      check(`${theme}: the primary button's words >= 4.5:1 (${cr.acc.toFixed(1)})`, cr.acc >= 4.5, cr);

      // every card fits its card: nothing scrolls or spills, at the real window size
      for (let i = 0; i < 3; i++) {
        if (i > 0) { await p.keyboard.press('ArrowRight'); await sleep(320); }
        const id = await step(p);
        const fit = await p.evaluate(() => {
          const st = document.getElementById('stage'), pn = st.querySelector('.panel'), card = document.getElementById('card');
          const r = card.getBoundingClientRect();
          const spill = [...card.querySelectorAll('*')].filter((e) => { const b = e.getBoundingClientRect(); return b.width && (b.right > r.right + 0.5 || b.bottom > r.bottom + 0.5 || b.left < r.left - 0.5); }).map((e) => e.className || e.tagName);
          return { panelH: pn.scrollHeight, stageH: st.clientHeight, cardW: card.scrollWidth, cardCW: card.clientWidth, spill };
        });
        check(`${theme}: card "${id}" fits (panel ${fit.panelH} <= stage ${fit.stageH}, nothing spills)`, fit.panelH <= fit.stageH && fit.cardW <= fit.cardCW && !fit.spill.length, fit);
        await sleep(250);   // the step's 200 ms animation has ended
        await p.screenshot({ path: path.join(SHOTS, `welcome-${i + 1}-${id}-${theme}.png`) });
      }
      await p.close();
    }

    // ---- keyboard: Enter, arrows, Tab, Esc
    {
      const p = await open('theme=light');
      await p.keyboard.press('Enter');
      check('Enter on Next goes to card 2', await step(p) === 'keys');
      check('after a step Next keeps the keyboard', await focused(p) === 'next');
      await p.keyboard.press('ArrowLeft');
      check('Left arrow goes back', await step(p) === 'changed');
      await p.keyboard.press('ArrowLeft');
      check('Left arrow on card 1 stays', await step(p) === 'changed');
      await p.keyboard.press('ArrowRight'); await p.keyboard.press('ArrowRight');
      check('Right arrow twice reaches card 3', await step(p) === 'back');
      check('card 3\'s button finishes', await p.evaluate(() => document.getElementById('next').textContent) === 'Start using Mantle');
      await p.keyboard.press('ArrowRight');
      check('Right arrow on the last card does not finish', await step(p) === 'back' && (await calls(p, 'welcome.done')).length === 0);
      // Tab walks every control in reading order: the three steps, Skip, the restore button, Back, Next
      await p.evaluate(() => document.querySelector('[data-act="step"]').focus());
      const order = [];
      for (let i = 0; i < 7; i++) { order.push(await focused(p)); await p.keyboard.press('Tab'); }
      check('Tab reaches the steps, Skip, Restore, Back and Next in order', order.join(',') === 'step,step,step,skip,restore,back,next', order.join(','));
      await p.evaluate(() => document.querySelector('[data-act="step"][data-i="0"]').focus());
      await p.keyboard.press('Enter');
      check('a step marker works from the keyboard', await step(p) === 'changed' && await p.evaluate(() => document.querySelector('[data-i="0"]').getAttribute('aria-current')) === 'step');
      await p.keyboard.press('Escape');
      await sleep(250);
      const d = await calls(p, 'welcome.done');
      check('Esc skips (welcome.done skipped, once)', d.length === 1 && d[0].args.how === 'skipped', d);
      check('Esc: the card plays its exit', await p.evaluate(() => document.getElementById('card').classList.contains('out')));
      await p.close();
    }
    // ---- Skip on every card; finish
    for (let i = 0; i < 3; i++) {
      const p = await open('theme=dark');
      for (let k = 0; k < i; k++) await p.click('#next');
      await p.click('#skip');
      await p.click('#skip').catch(() => {});   // a second click while leaving does nothing
      await sleep(250);
      const d = await calls(p, 'welcome.done');
      check(`Skip on card ${i + 1} records skipped, once`, d.length === 1 && d[0].args.how === 'skipped' && await p.evaluate(() => window.__mockClosed), d);
      await p.close();
    }
    {
      const p = await open('theme=light');
      await p.click('#next'); await p.click('#next'); await p.keyboard.press('Enter');
      await sleep(250);
      const d = await calls(p, 'welcome.done');
      check('Enter on "Start using Mantle" records finished', d.length === 1 && d[0].args.how === 'finished', d);
      await p.close();
    }
    // ---- a record that fails stays and says why
    {
      const p = await open('theme=light&mock=donefail');
      await p.click('#skip');
      await sleep(300);
      const s = await p.evaluate(() => ({ text: (document.querySelector('.saveerr') || {}).textContent || '', out: document.getElementById('card').classList.contains('out'), f: document.activeElement.id }));
      check('a failed record: the card stays and says why in plain words', !s.out && /^That could not be saved: the first-run flag could not be saved \(EACCES\)\. The welcome may show again next time\.$/.test(s.text) && s.f === 'next', s);
      await p.close();
    }
    // ---- Restore Windows taskbar now
    {
      const p = await open('theme=light');
      await p.click('[data-act="step"][data-i="2"]');
      const b = await p.$('[data-act="restore"]');
      await b.click(); await b.click().catch(() => {});
      await sleep(200);
      const r = await calls(p, 'shell.restore');
      const st = await p.evaluate(() => (document.querySelector('.status.ok') || {}).textContent || '');
      check('Restore runs shell.restore once and says what to do next', r.length === 1 && /^Windows’ taskbar is back\. To get Mantle’s bar back, choose Restart Mantle to resume from Mantle’s tray icon\.$/.test(st), { r, st });
      await p.close();
      const q = await open('theme=dark&mock=restorefail');
      await q.click('[data-act="step"][data-i="2"]');
      await q.click('[data-act="restore"]');
      await sleep(200);
      const t = await q.evaluate(() => ({ warn: (document.querySelector('.status.warn') || {}).textContent || '', btn: !!document.querySelector('[data-act="restore"]:not([disabled])') }));
      check('a failed restore says why and can be tried again', /^Could not restore: the sidecar did not answer in 4 s/.test(t.warn) && t.btn, t);
      await q.close();
    }
    // ---- the live corners
    {
      const p = await open('theme=light');
      await p.click('#next');
      const v = await p.evaluate(() => ({ live: document.querySelector('.corners').getAttribute('data-live'), lines: [...document.querySelectorAll('.cline')].map((l) => l.textContent), keys: [...document.querySelectorAll('.krow')].map((r) => r.getAttribute('data-k')) }));
      check('keys card: the five keys', v.keys.join(',') === 'Win,Alt+Tab,Win+Shift+S,Win+Tab,Win+I', v.keys);
      check('keys card: the live default corners', v.live === '1' && v.lines.join('|') === 'Top-left:Task view|Bottom-right:Show desktop', v);
      // what is PAINTED, not just the text: the name's text plus any ::before/::after content carries exactly one
      // colon (the live welcome once read "Top-left::" = a text colon AND a CSS ::after colon)
      const painted = await p.evaluate(() => [...document.querySelectorAll('.cline .cname, .cline .cact')].map((el) => {
        const pseudo = (w) => { const c = getComputedStyle(el, w).content; return c && c !== 'none' && c !== 'normal' ? c.replace(/^["']|["']$/g, '') : ''; };
        return pseudo('::before') + el.textContent + pseudo('::after');
      }));
      const colons = (s) => (s.match(/[:：]/g) || []).length;
      check('corner names paint exactly one colon (no "Top-left::")', painted.length === 4 && painted.every((s, i) => colons(s) === (i % 2 === 0 ? 1 : 0)) && !painted.some((s) => /::/.test(s)), painted);
      // and no rule anywhere can bring the CSS colon back
      const trimmed = await p.evaluate(() => {
        const name = document.querySelector('.cline .cname');
        return { css: [...document.styleSheets].some((sh) => { try { return [...sh.cssRules].some((r) => /\.cname::?(after|before)/.test(r.selectorText || '') && /content/.test(r.cssText)); } catch (e) { return false; } }), first: name.textContent };
      });
      check('no stylesheet adds content to a corner name', trimmed.css === false && trimmed.first === 'Top-left:', trimmed);
      await p.close();
      const q = await open('theme=light&mock=cornerschanged');
      await q.click('#next');
      const c = await q.evaluate(() => [...document.querySelectorAll('.cline')].map((l) => l.textContent));
      check('changed corners show as they are', c.join('|') === 'Top-left:Launcher|Top-right:Lock screen|Bottom-right:Show desktop', c);
      await q.close();
      const o = await open('theme=dark&mock=cornersoff');
      await o.click('#next');
      const off = await o.evaluate(() => [...document.querySelectorAll('.cline')].map((l) => l.textContent));
      check('switched-off corners say so and where to turn them on', off.length === 1 && /^Hot corners are off\. Turn them on in Mantle Settings, under Mantle\.$/.test(off[0]), off);
      await o.close();
      const s = await open('theme=light&mock=cornersslow');
      await s.click('#next');
      const before = await s.evaluate(() => document.querySelector('.corners').getAttribute('data-live'));
      await sleep(1700);
      const after = await s.evaluate(() => ({ live: document.querySelector('.corners').getAttribute('data-live'), lines: [...document.querySelectorAll('.cline')].length, step: document.documentElement.getAttribute('data-step') }));
      check('a late corners answer swaps in place, on the same card', before === '0' && after.live === '1' && after.lines === 3 && after.step === 'keys', { before, after });
      await s.close();
    }
    // ---- motion: short, and it ends
    {
      const p = await open('theme=light');
      const m = await p.evaluate(() => {
        const card = getComputedStyle(document.getElementById('card'));
        document.getElementById('next').click();
        const pn = getComputedStyle(document.querySelector('.panel'));
        const secs = (s) => s.split(',').map((x) => parseFloat(x) * (x.includes('ms') ? 0.001 : 1));
        return { card: Math.max(...secs(card.transitionDuration)), panel: Math.max(...secs(pn.animationDuration)), iter: pn.animationIterationCount, name: pn.animationName };
      });
      check('motion: the card comes in within 220 ms', m.card > 0 && m.card <= 0.22, m);
      check('motion: a step animates once, within 200 ms', m.name === 'in-fwd' && m.panel <= 0.2 && m.iter === '1', m);
      await p.close();
      const r = await open('theme=light', { reduced: true });
      await r.click('#next');
      const rm = await r.evaluate(() => ({ cls: document.querySelector('.panel').className, tr: getComputedStyle(document.getElementById('card')).transform }));
      check('reduced motion: no slide, no scale', rm.cls === 'panel' && (rm.tr === 'none' || rm.tr === 'matrix(1, 0, 0, 1, 0, 0)'), rm);
      await r.close();
    }
    // ---- with no bridge the page still draws (and says nothing false)
    {
      const p = await open('theme=light&mock=nobridge');
      check('no bridge: the cards still draw', await step(p) === 'changed');
      await p.close();
    }
    check('no page errors', errors.length === 0, errors.join(' | '));
  } finally {
    await browser.close();
  }
  console.log(`welcome: shots in ${SHOTS}`);
  console.log(`WELCOME PAGE TEST: ${passed} passed, ${failures.length} failed`);
  for (const f of failures) console.log('  FAIL ' + f);
  process.exit(failures.length ? 1 : 0);
}
main().catch((e) => { console.log('WELCOME PAGE TEST: crashed: ' + (e && e.stack || e)); console.log(`WELCOME PAGE TEST: ${passed} passed, ${failures.length + 1} failed`); process.exit(1); });

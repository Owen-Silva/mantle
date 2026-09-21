require('C:/Users/user/dev-tools/tools/lowcpu.js');
/* shoot.js — four headless screenshots of the launcher, for eyes only.
 *
 * Line 1 is the machine-wide CPU cap and browser lock: it pins this process to
 * a few cores at below-normal priority and lets exactly one headless browser
 * run at a time. It is required, not optional; a browser script without it is
 * a rule break.
 *
 * Nothing here runs Electron and nothing here opens an app: the page is loaded
 * over file:// with mock-mantle.js standing in for the bridge.
 *
 *   node ui/launcher/shoot.js
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { chromium } = require('C:/Users/user/other-app/node_modules/playwright-core');

const CHROME = 'C:/Users/user/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const PAGE = 'file:///C:/Users/user/mantle/ui/launcher/index.html';
const OUT = 'C:/Users/user/AppData/Local/Temp/claude/C--Users-owens/edd3247c-6214-4642-9069-bbf7e50b1555/scratchpad/lanes/launcher';

/* The launcher's own body is transparent, because the Electron window is.
   A screenshot of that would be a PNG with a hole in it, so the harness paints
   a desktop-ish backdrop behind the page through CSSOM (which the page's CSP
   allows, unlike an injected <style> tag) — this changes nothing inside the
   panel, it only gives the drop shadow and the hairline something to sit on. */
const BACKDROP = 'linear-gradient(140deg, #2b3138 0%, #1d2126 45%, #262b31 100%)';

(async () => {
  if (!fs.existsSync(CHROME)) throw new Error('no chromium at ' + CHROME);
  fs.mkdirSync(OUT, { recursive: true });

  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 680, height: 460 },
    deviceScaleFactor: 1.25,
    colorScheme: 'dark',
  });
  const shots = [];

  async function shoot(name, url, prep) {
    const page = await ctx.newPage();
    const problems = [];
    page.on('pageerror', e => problems.push('pageerror: ' + e.message));
    page.on('console', m => { if (m.type() === 'error') problems.push('console: ' + m.text()); });
    await page.goto(url, { waitUntil: 'load' });
    await page.evaluate(bg => { document.documentElement.style.background = bg; }, BACKDROP);
    await page.waitForTimeout(150);          // the mock resolves on a microtask
    if (prep) await prep(page);
    const file = path.join(OUT, name + '.png');
    await page.screenshot({ path: file });
    /* Read the state back out of the DOM as well as photographing it: a
       stylesheet blocked by CSP, an unfocused input or a missing notice are
       all things a small PNG can hide. */
    const probe = await page.evaluate(() => {
      const cs = el => (el ? getComputedStyle(el) : null);
      const slotAfter = cs(document.querySelector('.slot'));
      return {
        border: cs(document.querySelector('.panel')).borderTopWidth,
        focused: document.activeElement === document.getElementById('q'),
        underline: getComputedStyle(document.querySelector('.slot'), '::after').opacity,
        rows: document.querySelectorAll('.row').length,
        sel: document.querySelectorAll('.row.is-sel').length,
        why: (document.querySelector('.why') || {}).textContent || '',
        notice: document.getElementById('notice').hidden ? '' : document.getElementById('notice').textContent,
        slotBg: slotAfter.backgroundColor,
      };
    });
    shots.push({ file, probe, problems });
    await page.close();
    return file;
  }

  await shoot('01-empty', PAGE);
  await shoot('02-typed-ch', PAGE, async page => {
    await page.click('#q');
    await page.type('#q', 'ch', { delay: 30 });
    await page.waitForTimeout(220);          // 40ms debounce + render
  });
  await shoot('03-sidecar-down', PAGE + '?state=down');
  await shoot('04-launch-failed', PAGE + '?fail=1', async page => {
    await page.keyboard.press('Enter');
    await page.waitForTimeout(220);
  });

  await browser.close();

  for (const s of shots) {
    console.log(s.file);
    console.log('    ' + JSON.stringify(s.probe) +
      (s.problems.length ? '\n    PROBLEMS: ' + s.problems.join(' | ') : ''));
  }
})().catch(err => {
  console.error('shoot.js failed: ' + (err && err.stack || err));
  process.exit(1);
});

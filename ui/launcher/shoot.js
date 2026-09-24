require('C:/Users/user/dev-tools/tools/lowcpu.js');
/* shoot.js — headless screenshots of the launcher, plus a real contrast check.
 *
 * Line 1 is the machine-wide CPU cap and browser lock: it pins this process to
 * a few cores at below-normal priority and lets exactly one headless browser
 * run at a time. It is required, not optional.
 *
 * Nothing here runs Electron and nothing here opens an app: the page loads over
 * file:// with mock-mantle.js standing in for the bridge.
 *
 * The contrast pass is the point of the harness, not a bonus. The panel is
 * translucent now, so how legible the text is depends on the desktop behind it.
 * So: screenshot, then read the PNG back pixel by pixel, take the DARKEST pixel
 * inside each text run (that is the glass showing between the glyphs) and
 * measure the token colour against it. Guessing from the design tokens alone
 * would miss the wallpaper entirely.
 *
 *   node ui/launcher/shoot.js
 */
'use strict';
const path = require('path');
const fs = require('fs');
const { chromium } = require('C:/Users/user/other-app/node_modules/playwright-core');

const CHROME = 'C:/Users/user/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const PAGE = 'file:///C:/Users/user/mantle/ui/launcher/index.html';
const OUT = process.env.MANTLE_SHOOT_OUT ||
  'C:/Users/user/AppData/Local/Temp/claude/C--Users-owens/edd3247c-6214-4642-9069-bbf7e50b1555/scratchpad/lanes/launcher';
/* ONLY=06,07 shoots just the scenarios whose names start with those numbers */
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null;
const DPR = 1.25;

/* The three text colours that sit on the glass, straight out of tokens.css. */
const TEXT = {
  'name (--fg)': [238, 241, 248],
  'subtitle (--fg-3)': [166, 171, 181],
  'source error (--amber)': [224, 160, 89],
};
const SAMPLE = {
  'name (--fg)': '.row.is-sel .name',
  'subtitle (--fg-3)': '.row:not(.is-sel) .sub',
  'source error (--amber)': '.src-error',
};

(async () => {
  if (!fs.existsSync(CHROME)) throw new Error('no chromium at ' + CHROME);
  fs.mkdirSync(OUT, { recursive: true });

  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 680, height: 460 },
    deviceScaleFactor: DPR,
    colorScheme: 'dark',
  });
  /* A plain page to decode the PNGs in: about:blank has no CSP, so a canvas
     can take the screenshot back apart. */
  const lab = await ctx.newPage();
  await lab.goto('about:blank');

  const shots = [];

  async function shoot(name, url, prep) {
    if (ONLY && !ONLY.some(p => name.startsWith(p))) return;
    const page = await ctx.newPage();
    const problems = [];
    page.on('pageerror', e => problems.push('pageerror: ' + e.message));
    page.on('console', m => { if (m.type() === 'error') problems.push('console: ' + m.text()); });
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForTimeout(150);              // the mock resolves on a microtask
    if (prep) await prep(page);

    const file = path.join(OUT, name + '.png');
    const buf = await page.screenshot({ path: file });

    /* Read the state out of the DOM as well as photographing it: a blocked
       stylesheet, a lost focus or a missing notice can all hide in a small PNG. */
    const probe = await page.evaluate(sel => {
      const cs = el => (el ? getComputedStyle(el) : null);
      const rect = q => {
        const el = document.querySelector(q);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      };
      const out = { rects: {} };
      for (const k of Object.keys(sel)) out.rects[k] = rect(sel[k]);
      const panel = document.querySelector('.panel');
      out.border = cs(panel).borderTopWidth;
      out.fillLayers = cs(panel).backgroundImage.split(/,(?![^(]*\))/).length;
      out.bodyBg = cs(document.body).backgroundColor;
      out.htmlBg = cs(document.documentElement).backgroundImage === 'none' ? 'none' : 'wallpaper';
      out.focused = document.activeElement === document.getElementById('q');
      out.underline = getComputedStyle(document.querySelector('.slot'), '::after').opacity;
      out.rows = document.querySelectorAll('.row').length;
      out.why = (document.querySelector('.why') || {}).textContent || '';
      out.notice = document.getElementById('notice').hidden ? '' : document.getElementById('notice').textContent;
      out.names = Array.from(document.querySelectorAll('.row .name')).map(n => n.textContent).slice(0, 10);
      out.armed = (document.querySelector('.row.is-armed .name') || {}).textContent || '';
      out.hint = (document.getElementById('hint') || {}).textContent || '';
      out.counts = document.getElementById('counts').textContent;
      out.srcErrors = document.getElementById('srcErrors').textContent;
      out.hidden = document.documentElement.dataset.mockHidden === '1';
      return out;
    }, SAMPLE);

    const contrast = await lab.evaluate(async ({ png, rects, text, dpr }) => {
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = png; });
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      c.getContext('2d').drawImage(img, 0, 0);
      const lin = v => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
      const lum = (r, g, b) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
      const out = {};
      for (const key of Object.keys(rects)) {
        const r = rects[key];
        if (!r || r.w < 2 || r.h < 2) { out[key] = null; continue; }
        const d = c.getContext('2d').getImageData(
          Math.round(r.x * dpr), Math.round(r.y * dpr),
          Math.max(1, Math.round(r.w * dpr)), Math.max(1, Math.round(r.h * dpr))).data;
        // darkest pixel inside the text run = the glass between the glyphs
        let best = 2, rgb = null;
        for (let i = 0; i < d.length; i += 4) {
          const L = lum(d[i], d[i + 1], d[i + 2]);
          if (L < best) { best = L; rgb = [d[i], d[i + 1], d[i + 2]]; }
        }
        const t = text[key];
        const tl = lum(t[0], t[1], t[2]);
        out[key] = {
          ratio: Math.round(((Math.max(tl, best) + 0.05) / (Math.min(tl, best) + 0.05)) * 100) / 100,
          behind: 'rgb(' + rgb.join(',') + ')',
        };
      }
      return out;
    }, { png: 'data:image/png;base64,' + buf.toString('base64'), rects: probe.rects, text: TEXT, dpr: DPR });

    delete probe.rects;
    shots.push({ file, probe, contrast, problems });
    await page.close();
  }

  await shoot('01-glass-plain', PAGE);                       // no wallpaper: the white worst case
  await shoot('02-glass-busy', PAGE + '?bg=1');
  await shoot('03-typed-ch', PAGE + '?bg=1', async page => {
    await page.click('#q');
    await page.type('#q', 'ch', { delay: 30 });
    await page.waitForTimeout(220);                          // 40ms debounce + render
  });
  await shoot('04-launch-failed', PAGE + '?bg=1&fail=1', async page => {
    await page.keyboard.press('Enter');
    await page.waitForTimeout(220);
  });
  await shoot('05-sidecar-down', PAGE + '?bg=1&state=down');

  /* ---- power rows and file search (the mock bridge is ALWAYS a power dry run) ---- */
  const typeQ = (q, wait) => async page => {
    await page.click('#q');
    await page.type('#q', q, { delay: 30 });
    await page.waitForTimeout(wait || 420);                  // 40ms apps + 150ms files + 90ms mock index
  };
  await shoot('06-power-shut', PAGE + '?bg=1', typeQ('shut'));
  await shoot('07-power-armed', PAGE + '?bg=1', async page => {
    await typeQ('shut down')(page);
    await page.keyboard.press('Enter');                      // arms: "Press Enter again to shut down"
    await page.waitForTimeout(1200);                         // part-way through the countdown
  });
  await shoot('08-power-confirmed-dryrun', PAGE + '?bg=1', async page => {
    await typeQ('shut down')(page);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(400);
    await page.keyboard.press('Enter');                      // confirms -> the mock's dry-run answer
    await page.waitForTimeout(250);
  });
  await shoot('09-power-armed-then-esc', PAGE + '?bg=1', async page => {
    await typeQ('reboot')(page);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);
    await page.keyboard.press('Escape');                     // takes the arm back, stays open
    await page.waitForTimeout(200);
  });
  await shoot('10-sleep-dryrun', PAGE + '?bg=1', async page => {
    await typeQ('sleep')(page);
    await page.keyboard.press('Enter');                      // no confirm step for Sleep
    await page.waitForTimeout(250);
  });
  await shoot('11-one-letter-s', PAGE + '?bg=1', typeQ('s'));
  await shoot('12-files-merged', PAGE + '?bg=1', typeQ('rep'));
  await shoot('13-file-selected', PAGE + '?bg=1', async page => {
    await typeQ('report')(page);
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(150);
  });
  await shoot('14-files-down', PAGE + '?bg=1&files=down', typeQ('rep'));

  /* Win+S (2026-09-24): grouped results, the calculator, the web row, the search mode */
  const wait = (ms) => async page => { await page.waitForTimeout(ms); };
  await shoot('15-search-mode', PAGE + '?bg=1&mode=search', wait(300));
  await shoot('16-calc', PAGE + '?bg=1', typeQ('2*(3+4)^2'));
  await shoot('17-calc-copy-dry', PAGE + '?bg=1', async page => {
    await typeQ('6*7')(page);
    await page.keyboard.press('Enter');                      // the mock's copy is a dry run
    await page.waitForTimeout(150);
  });
  await shoot('18-calc-no-answer', PAGE + '?bg=1', typeQ('1/0'));
  await shoot('19-groups-b', PAGE + '?bg=1', typeQ('b'));
  await shoot('20-settings-night', PAGE + '?bg=1', typeQ('night'));
  await shoot('21-files-pending', PAGE + '?bg=1&files=slow', typeQ('rep'));
  await shoot('22-tab-to-files', PAGE + '?bg=1', async page => {
    await typeQ('rep')(page);
    await page.keyboard.press('Tab');
    await page.waitForTimeout(150);
  });
  await shoot('23-web-enter-dry', PAGE + '?bg=1', async page => {
    await typeQ('weather boston')(page);
    await page.keyboard.press('End');                        // the last row: Search the web
    await page.keyboard.press('Enter');
    await page.waitForTimeout(150);
  });
  await shoot('24-search-mode-query', PAGE + '?bg=1&mode=search&q=blue', wait(400));

  await browser.close();

  for (const s of shots) {
    console.log(s.file);
    console.log('    ' + JSON.stringify(s.probe));
    for (const k of Object.keys(s.contrast)) {
      const c = s.contrast[k];
      console.log('    ' + (c ? (c.ratio >= 4.5 ? 'OK  ' : 'LOW ') + c.ratio + ':1  ' + k + '  on ' + c.behind
        : 'n/a  ' + k));
    }
    if (s.problems.length) console.log('    PROBLEMS: ' + s.problems.join(' | '));
  }
})().catch(err => {
  console.error('shoot.js failed: ' + (err && err.stack || err));
  process.exit(1);
});

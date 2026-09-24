/* shoot.js — headless screenshots of the bar, for eyeballing it without running Electron.
 *
 * LINE 1 below is not optional: lowcpu.js pins this process (and every browser it spawns) to a
 * few cores at below-normal priority and takes a machine-wide lock so only one headless browser
 * runs at a time. Owen's machine has been pegged by unguarded Chromium before; a run that skips
 * this file is a rule break, not a shortcut.
 *
 *   node ui/bar/shoot.js              every shot below
 *   node ui/bar/shoot.js media tray   only the shots whose name contains one of the words
 *
 * BAR_TRAY_JSON=<file> hands the mock a REAL tray listing (a JSON array in the sidecar's `tray`
 * shape, or a probe dump whose [1].result is one) through window.__MOCK_TRAY__, so real icons can
 * be eyeballed without committing anybody's tray to the repo. BAR_EXTRA_CSS=<css> adds a style to
 * every shot, for an A/B of a treatment that is not in bar.css (BAR_SUFFIX=-b names the files).
 */
require('C:/Users/user/dev-tools/tools/lowcpu.js');

const fs = require('fs');
const path = require('path');
const os = require('os');

/* playwright-core is not a dependency of this repo (the bar ships no node code), so we borrow the
   one already installed on the machine, and say plainly which candidates were tried if none is
   there — a "cannot find module" stack would not tell anyone what to install. */
const PW_CANDIDATES = [
  'C:/Users/user/other-app/node_modules/playwright-core',
  'C:/Users/user/Downloads/other-app/node_modules/playwright-core',
  'playwright-core'
];
let chromium = null, pwFrom = '';
for (const c of PW_CANDIDATES) {
  try { chromium = require(c).chromium; pwFrom = c; break; } catch (e) { /* try the next one */ }
}
if (!chromium) {
  console.error('FAILED: playwright-core not found. Tried:\n  ' + PW_CANDIDATES.join('\n  '));
  process.exit(1);
}

/* The browser binary: the newest ms-playwright chromium already downloaded on this machine.
   Never a download, never the system Chrome. */
function findChrome() {
  const base = 'C:/Users/user/AppData/Local/ms-playwright';
  for (const d of fs.readdirSync(base).filter(n => n.startsWith('chromium-')).sort().reverse())
    for (const sub of ['chrome-win/chrome.exe', 'chrome-win64/chrome.exe']) {
      const p = path.join(base, d, sub);
      if (fs.existsSync(p)) return p;
    }
  return null;
}

const OUT = process.env.BAR_SHOTS ||
  'C:/Users/user/AppData/Local/Temp/claude/C--Users-owens/edd3247c-6214-4642-9069-bbf7e50b1555/scratchpad/lanes/bar';
const PAGE = 'file:///C:/Users/user/mantle/ui/bar/index.html';

/* Step sequences for the quick-settings sub-views (qs-more.js): open the panel from the Wi-Fi
   readout, take the tile's '>' and let the mock's scan finish; or take the volume row's '>'. */
const WIFI = ['#network', '.qsx-chev', { wait: 1300 }];
const net = (ssid) => '.qsx-net[data-ssid="' + ssid + '"] .qsx-nethead';
const PASSWORD = WIFI.concat([net('Cafe WiFi'), '.qsx-net.open .qsx-btn.acc', { fill: '#qsxpw', text: 'not-a-real-key' }]);
const SOUND = ['#volume', '.qsx-more', { wait: 600 }];
/* The battery (2026-09-23): every state the readout and the panel's footer can be in, from the
   readings the sidecar sends (?battery=<name>, mock-mantle.js). `plugged` is on AC and NOT
   charging (a charge limit): a plug, never a bolt. `none` has no readout, so its panel is opened
   from the Wi-Fi glyph. The 900 ms lets the pill's entrance finish before anything is clicked. */
const BATT = ['charging', 'plugged', 'full', 'battery', 'unplugged', 'saver', 'unknown', 'error', 'none'];

/* Each shot is one state worth looking at, not one size for its own sake. */
const SHOTS = [
  { name: 'bar-1920', w: 1920, h: 44, q: '' },
  { name: 'bar-1920-bg', w: 1920, h: 44, q: '?bg=1' },   // loud wallpaper: is the glass actually letting it through?
  { name: 'bar-1280', w: 1280, h: 44, q: '' },
  { name: 'bar-1280-20win', w: 1280, h: 44, q: '?windows=20' },
  { name: 'bar-1920-down', w: 1920, h: 44, q: '?state=down' },
  /* now playing (2026-09-22): the chip, then the card open over a taller page (the popover floats
     above the bar, so a 44px viewport would crop it), in each state the card has to get right */
  { name: 'media-chip', w: 1280, h: 60, q: '?mode=pill&media=playing' },
  { name: 'media-compact', w: 1000, h: 60, q: '?mode=pill&media=playing' },   // too narrow: the title gives way
  { name: 'media-card', w: 1280, h: 330, q: '?mode=pill&media=playing', click: '#mchip' },
  { name: 'media-noctl', w: 1280, h: 330, q: '?mode=pill&media=noctl', click: '#mchip' },
  /* LessonPlayer alone: NO chip (Owen's call, 2026-09-22), so nothing is clicked: the shot proves absence */
  { name: 'media-lessonplayer', w: 1280, h: 60, q: '?mode=pill&media=lessonplayer' },
  { name: 'media-both', w: 1280, h: 400, q: '?mode=pill&media=both', click: '#mchip' },
  /* LessonPlayer picked in the switcher while a player also plays: the controls-off card */
  { name: 'media-lessonplayer-picked', w: 1280, h: 480, q: '?mode=pill&media=both&pick=lessonplayer', click: '#mchip' },
  { name: 'media-off', w: 1280, h: 330, q: '?mode=pill&media=off', click: '#more' },   // the chip's reason, in words
  /* the tray: the white-icon plate on the strip, and the hidden icons in the overflow */
  { name: 'tray', w: 1280, h: 60, q: '?mode=pill&tray=1&media=playing' },
  { name: 'tray-more', w: 1280, h: 330, q: '?mode=pill&tray=1', click: '#more' },
  /* The notification centre (ui/bar/notifications.js): the bell's count, then the panel */
  { name: 'notifs-bell', w: 1280, h: 60, q: '?mode=pill&notifs=some' },
  { name: 'notifs-panel', w: 1280, h: 540, q: '?mode=pill&notifs=some', click: '#notifs' },
  { name: 'notifs-many', w: 1280, h: 540, q: '?mode=pill&notifs=many', click: '#notifs' },
  { name: 'notifs-plain', w: 1280, h: 540, q: '?mode=pill&notifs=plain', click: '#notifs' },
  { name: 'notifs-none', w: 1280, h: 330, q: '?mode=pill&notifs=none', click: '#notifs' },
  { name: 'notifs-off', w: 1280, h: 330, q: '?mode=pill&notifs=off', click: '#notifs' },
  { name: 'notifs-edge', w: 1280, h: 540, q: '?notifs=some', click: '#notifs' },
  /* Quick settings one level down (ui/bar/qs-more.js, 2026-09-23): the Wi-Fi list, the password
     field, the output picker and the mixer, in every state they have to get right. `steps` runs in
     order: a string clicks that selector, {wait: ms} pauses, {fill, text} types into a field,
     {scroll} scrolls that element to its bottom. The mock scans in 900 ms, hence the waits. */
  { name: 'qsx-main', w: 1280, h: 400, q: '?mode=pill', click: '#network' },
  { name: 'qsx-wifi', w: 1280, h: 560, q: '?mode=pill', steps: WIFI },
  { name: 'qsx-wifi-more', w: 1280, h: 560, q: '?mode=pill', steps: WIFI.concat([{ scroll: '.qsx-view .qsx-scroll' }]) },
  { name: 'qsx-wifi-connected', w: 1280, h: 560, q: '?mode=pill', steps: WIFI.concat([net('Maple-5G')]) },
  { name: 'qsx-wifi-known', w: 1280, h: 560, q: '?mode=pill', steps: WIFI.concat([net('Maple-Guest')]) },
  { name: 'qsx-wifi-open', w: 1280, h: 560, q: '?mode=pill', steps: WIFI.concat([net('CoffeeHouse Free WiFi')]) },
  { name: 'qsx-wifi-enterprise', w: 1280, h: 560, q: '?mode=pill', steps: WIFI.concat([{ scroll: '.qsx-view .qsx-scroll' }, '.qsx-net[data-ssid^="Lakeview"] .qsx-nethead']) },
  { name: 'qsx-wifi-password', w: 1280, h: 560, q: '?mode=pill', steps: PASSWORD },
  { name: 'qsx-wifi-connecting', w: 1280, h: 560, q: '?mode=pill&wifi=connecting', steps: WIFI },
  { name: 'qsx-wifi-failed', w: 1280, h: 560, q: '?mode=pill', steps: PASSWORD.concat(['.qsx-pw .qsx-btn.acc', { wait: 1800 }]) },
  { name: 'qsx-wifi-lastfail', w: 1280, h: 560, q: '?mode=pill&wifi=failed', steps: WIFI },
  { name: 'qsx-wifi-kbd', w: 1280, h: 560, q: '?mode=pill&kbd=refused', steps: WIFI.concat([net('Cafe WiFi'), '.qsx-net.open .qsx-btn.acc']) },
  { name: 'qsx-wifi-scanning', w: 1280, h: 560, q: '?mode=pill&scan=hold', steps: ['#network', '.qsx-chev', { wait: 300 }] },
  { name: 'qsx-wifi-off', w: 1280, h: 560, q: '?mode=pill&wifi=off', steps: WIFI },
  { name: 'qsx-wifi-none', w: 1280, h: 560, q: '?mode=pill&wifi=none', steps: WIFI },
  { name: 'qsx-wifi-empty', w: 1280, h: 560, q: '?mode=pill&wifi=empty', steps: WIFI },
  { name: 'qsx-wifi-error', w: 1280, h: 560, q: '?mode=pill&wifi=error', steps: WIFI },
  { name: 'qsx-sound-1', w: 1280, h: 560, q: '?mode=pill&audio=1', steps: SOUND },
  { name: 'qsx-sound-4', w: 1280, h: 560, q: '?mode=pill&audio=4', steps: SOUND },
  { name: 'qsx-mixer-0', w: 1280, h: 560, q: '?mode=pill&audio=1&mixer=0', steps: SOUND },
  { name: 'qsx-mixer-8', w: 1280, h: 560, q: '?mode=pill&audio=1&mixer=8', steps: SOUND.concat([{ scroll: '.qsx-view .qsx-scroll' }]) },
  { name: 'qsx-mixer-error', w: 1280, h: 560, q: '?mode=pill&mixer=error', steps: SOUND },
  ...BATT.map((b) => ({ name: 'battery-' + b, w: 1280, h: 60, q: '?mode=pill&battery=' + b, steps: [{ wait: 900 }] })),
  ...BATT.map((b) => ({ name: 'battery-' + b + '-qs', w: 1280, h: 400, q: '?mode=pill&battery=' + b,
    steps: [{ wait: 900 }, b === 'none' ? '#network' : '#battery'] })),
  // Plugged in while the panel is open: main's push must redraw the readout AND the footer.
  { name: 'battery-push-qs', w: 1280, h: 400, q: '?mode=pill&battery=battery',
    steps: [{ wait: 900 }, '#battery', { js: "__mockMain.battery('charging')" }, { wait: 300 }] }
];
const ONLY = process.argv.slice(2);
const RUN = ONLY.length ? SHOTS.filter(s => ONLY.some(w => s.name.includes(w))) : SHOTS;
let REAL_TRAY = null;
if (process.env.BAR_TRAY_JSON) {
  const raw = JSON.parse(fs.readFileSync(process.env.BAR_TRAY_JSON, 'utf8'));
  REAL_TRAY = Array.isArray(raw) ? raw : (raw && raw[1] && raw[1].result) || null;
  if (!Array.isArray(REAL_TRAY)) { console.error('FAILED: BAR_TRAY_JSON holds no tray array'); process.exit(1); }
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const exe = findChrome();
  if (!exe) { console.error('FAILED: no ms-playwright chromium found under AppData/Local/ms-playwright'); process.exit(1); }

  const browser = await chromium.launch({ headless: true, executablePath: exe });
  const ctx = await browser.newContext({ colorScheme: 'dark', deviceScaleFactor: 1.25, viewport: { width: 1920, height: 44 } });
  const problems = [];
  try {
    for (const s of RUN) {
      const page = await ctx.newPage();
      if (REAL_TRAY && /tray/.test(s.q)) await page.addInitScript((t) => { window.__MOCK_TRAY__ = t; }, REAL_TRAY);
      await page.setViewportSize({ width: s.w, height: s.h });
      page.on('pageerror', e => problems.push(s.name + ' pageerror: ' + e.message));
      page.on('console', m => { if (m.type() === 'error') problems.push(s.name + ' console: ' + m.text()); });
      await page.goto(PAGE + s.q, { waitUntil: 'load' });
      /* The page is deliberately transparent (the Electron window is), so a screenshot over
         nothing would composite onto white and misrepresent every contrast judgement. Paint a
         plausible dark desktop behind it — on <html>, never on the bar. The ?bg=1 shot brings
         its own (much louder) wallpaper from the mock, so leave that one alone. */
      if (!s.q.includes('bg=1'))
        await page.addStyleTag({ content: 'html{background:#141619 !important;}' });
      if (process.env.BAR_EXTRA_CSS) await page.addStyleTag({ content: process.env.BAR_EXTRA_CSS });
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(350);           // the mock bridge answers at 30ms; this is slack, not a race
      for (const st of s.steps || (s.click ? [s.click] : [])) {
        if (typeof st === 'string') { await page.click(st); await page.waitForTimeout(400); }
        else if (st.wait) await page.waitForTimeout(st.wait);
        else if (st.fill) await page.fill(st.fill, st.text);
        else if (st.scroll) { await page.$eval(st.scroll, el => { el.scrollTop = el.scrollHeight; }); await page.waitForTimeout(100); }
        else if (st.js) await page.evaluate(st.js);   // a mock-main push (window.__mockMain), mid-shot
      }
      await page.mouse.move(0, 0);              // no hover state left on whatever was clicked
      /* ...and let its fade finish: hovers fade out over 150 ms steps(2), so a shot taken at once
         kept the full hover fill on whatever row the last click left the pointer over (seen on
         qsx-wifi, 2026-09-23, where it read as a selected network). */
      await page.waitForTimeout(200);
      const file = path.join(OUT, s.name + (process.env.BAR_SUFFIX || '') + '.png');
      await page.screenshot({ path: file });
      console.log(file);
      await page.close();
    }
  } finally {
    await browser.close();
  }
  console.log('playwright-core from ' + pwFrom + ' · chromium ' + exe);
  console.log(problems.length ? 'PAGE PROBLEMS:\n  ' + problems.join('\n  ') : 'no page errors, no console errors');
})().catch(e => { console.error('FAILED', e && e.stack || e); process.exit(1); });

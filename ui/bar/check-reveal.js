/* check-reveal.js — the "apps hidden" false alarm on a reveal from parked, reproduced in the mock.
 *
 * LIVE on 09344ef (2026-09-23, %APPDATA%\mantle\mantle.log): right after "bar revealed", 3 reveals
 * in ~30 raised "5 apps hidden — 13 app icons need 540px and the free span ... is only 348px in a
 * 694px bar" (once "6 apps hidden — 14 app icons need 589px"). 694 dip is 62 % of the 1120 dip
 * pill window: the pill's DOWN width, read after main had already put the window at its final
 * rect but before the page's entrance had moved it. The fit is judged by a settle 50 ms after the
 * last resize the page saw, and when the frames after a reveal come late, no resize arrives in
 * those 50 ms and the entrance's first value was taken for the bar.
 *
 * HOW IT IS REPRODUCED: the animation clock is frozen (CDP Animation.setPlaybackRate 0) across the
 * reveal. From inside the page that is exactly what late frames look like: the width transition
 * exists but has not moved, and timers still fire. The reveal is sent from the page's own resize
 * event, so the window reaching its pill rect and 'bar.reveal' arrive together, as they do live
 * (main sets the rect, then sends the event). Then the clock runs again and the pill lands.
 *
 *   node ui/bar/check-reveal.js     one line per check, then "REVEAL FIT CHECK: N passed, M failed"
 *
 * The EDGE cases at the end (2026-09-23) check the docked shape: the icons stop short of the chip
 * strip, and "apps hidden" is raised there at all.
 *
 * LINE 1 below is not optional, for the same reason as in shoot.js: one pinned, low-priority
 * headless browser at a time on Owen's machine.
 */
require('C:/Users/user/dev-tools/tools/lowcpu.js');

const fs = require('fs');
const path = require('path');

const PW_CANDIDATES = [
  'C:/Users/user/other-app/node_modules/playwright-core',
  'C:/Users/user/Downloads/other-app/node_modules/playwright-core',
  'playwright-core'
];
let chromium = null;
for (const c of PW_CANDIDATES) {
  try { chromium = require(c).chromium; break; } catch (e) { /* try the next one */ }
}
if (!chromium) {
  console.error('REVEAL FIT CHECK: could not run: playwright-core not found. Tried:\n  ' + PW_CANDIDATES.join('\n  '));
  process.exit(1);
}
function findChrome() {
  const base = 'C:/Users/user/AppData/Local/ms-playwright';
  for (const d of fs.readdirSync(base).filter(n => n.startsWith('chromium-')).sort().reverse())
    for (const sub of ['chrome-win/chrome.exe', 'chrome-win64/chrome.exe']) {
      const p = path.join(base, d, sub);
      if (fs.existsSync(p)) return p;
    }
  return null;
}

/* BAR_PAGE=<file url> runs the same checks against another copy of the page, which is how the
   failure is shown on a copy of bar.js without the fix (the repo's own files are never edited). */
const PAGE = process.env.BAR_PAGE || 'file:///C:/Users/user/mantle/ui/bar/index.html';
const DOWN = 0.62;             // bar.css --pane-w at rest: the pill's width before its entrance
const H_PILL = 62, H_PARKED = 48;   // live: pill 1400x77 and parked 868x60 physical px at 125 %

/* Every case is a reveal FROM PARKED, the live sequence: up, down, the window parked at the pill's
   down width, then the window back at its pill rect and 'bar.reveal' in the same frame. ?apps=N is
   N pins; the mock adds its 2 running apps, so 11 -> the 13 icons and 12 -> the 14 of the log. */
const CASES = [
  { name: '13 icons, 1120 pill', q: '?mode=pill&apps=11', w: 1120, icons: 13, fits: true },
  { name: '14 icons, 1120 pill', q: '?mode=pill&apps=12', w: 1120, icons: 14, fits: true },
  /* the control: genuinely too many for the pill, so the chip MUST still come, naming the width
     the pill landed at and not the width its entrance started from */
  { name: '15 icons, 760 pill', q: '?mode=pill&apps=13', w: 760, icons: 15, fits: false }
];

let passed = 0;
const failed = [];
function check(ok, name, detail) {
  if (ok) { passed++; console.log('  ok    ' + name); }
  else { failed.push(name); console.log('  FAIL  ' + name + (detail ? '  (' + detail + ')' : '')); }
}

async function runCase(browser, c) {
  console.log(c.name + ':');
  const ctx = await browser.newContext({ colorScheme: 'dark', deviceScaleFactor: 1.25, viewport: { width: c.w, height: H_PILL } });
  const page = await ctx.newPage();
  const warns = [];            // every "apps hidden" the bar raised, with the phase it came in
  const problems = [];
  let phase = 'boot';
  page.on('console', m => {
    const t = m.text();
    if (/apps? hidden/.test(t)) warns.push({ phase, text: t });
    if (m.type() === 'error') problems.push('console: ' + t);
  });
  page.on('pageerror', e => problems.push('pageerror: ' + e.message));
  const read = () => page.evaluate(() => {
    const bar = document.getElementById('bar'), dock = document.getElementById('dock');
    return {
      w: bar.getBoundingClientRect().width,
      lw: bar.offsetWidth,                       // the LAYOUT width: what the dock is fitted in (no transform)
      up: document.body.classList.contains('up'),
      cap: dock.style.getPropertyValue('--dock-max').trim(),
      cells: dock.querySelectorAll('.cell').length,
      more: document.getElementById('more').title
    };
  });
  const hidden = (list) => list.map(x => x.text.replace(/^\[bar\]\s*/, '').slice(0, 150));
  try {
    await page.goto(PAGE + c.q, { waitUntil: 'load' });
    await page.waitForTimeout(1500);                 // the mock reveals at 300 ms; 560 ms entrance; settle
    let s = await read();
    phase = 'up';
    const first = warns.filter(x => x.phase === 'boot');
    if (c.fits) {
      check(s.up && Math.abs(s.w - c.w) < 1 && s.cap === 'none' && !first.length,
        'first reveal lands at ' + c.w + ' with every icon shown and no chip',
        JSON.stringify(s) + ' ' + JSON.stringify(hidden(first)));
    } else {
      check(s.up && first.length > 0 && first.every(x => x.text.includes('in a ' + c.w + 'px bar')),
        'first reveal: too many for ' + c.w + ', so the chip comes, naming the landed ' + c.w + 'px bar',
        JSON.stringify(hidden(first)));
    }

    /* down, then parked: the window shrinks to the pill's down width, as main parks it */
    await page.evaluate(() => window.__mockMain.hide());
    await page.waitForTimeout(500);
    await page.setViewportSize({ width: Math.round(c.w * DOWN), height: H_PARKED });
    await page.waitForTimeout(400);
    phase = 'parked';

    /* the late frames: freeze the animation clock, then the pill rect and the reveal together */
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Animation.enable');
    await cdp.send('Animation.setPlaybackRate', { playbackRate: 0 });
    await page.evaluate(() => window.addEventListener('resize', () => window.__mockMain.reveal('harness: reveal from parked'), { once: true }));
    phase = 'frozen';
    await page.setViewportSize({ width: c.w, height: H_PILL });
    await page.waitForTimeout(450);                  // bar.pinned answers at 30 ms, the settle runs 50 ms later
    s = await read();
    const frozen = warns.filter(x => x.phase === 'frozen');
    /* lane mantle-barpolish: the island no longer grows from 62 %, so the old precondition (the pill
       caught at its down width) cannot happen; what is checked instead is the reason it cannot: the
       entrance's first frame is already laid out at the full width, only its transform is moving. */
    check(s.up && Math.abs(s.lw - c.w) < 1,
      'revealed: the island is laid out at its full width (' + c.w + ') from the entrance\'s first frame, not grown into it',
      JSON.stringify(s));
    check(!frozen.length, 'no "apps hidden" judged from the entrance\'s first frame', JSON.stringify(hidden(frozen)));

    /* the frames come: the pill lands */
    phase = 'landing';
    await cdp.send('Animation.setPlaybackRate', { playbackRate: 1 });
    await page.waitForTimeout(1300);
    s = await read();
    const landed = warns.filter(x => x.phase === 'landing');
    if (c.fits) {
      check(Math.abs(s.w - c.w) < 1 && s.cap === 'none' && s.cells >= c.icons && !landed.length && !/apps? hidden/.test(s.more),
        'landed at ' + c.w + ': all ' + c.icons + ' icons shown, no chip',
        JSON.stringify(s) + ' ' + JSON.stringify(hidden(landed)));
    } else {
      check(Math.abs(s.w - c.w) < 1 && landed.length > 0 && landed.every(x => x.text.includes('in a ' + c.w + 'px bar')) && /apps? hidden/.test(s.more),
        'landed at ' + c.w + ': the real overflow is still reported, against the landed width',
        JSON.stringify(s) + ' ' + JSON.stringify(hidden(landed)));
    }

    /* The cursor back before the bar finished sliding away (the log has one of these too): the
       reveal reverses the width transition from wherever the exit had got to. Here the pause is
       done inside the page, in the same task as the reveal, because live this race is lost within
       one frame of the exit's last resize and a CDP round trip is slower than that. */
    phase = 'midexit';
    await page.evaluate(() => window.__mockMain.hide());
    await page.waitForTimeout(150);                  // about half of the 300 ms exit
    const caught = await page.evaluate(() => {
      window.__mockMain.reveal('harness: back before the exit finished');
      const bar = document.getElementById('bar');
      const ws = bar.getAnimations().filter(a => a.transitionProperty === 'transform');
      ws.forEach(a => a.pause());
      return { w: bar.getBoundingClientRect().width, lw: bar.offsetWidth, transitions: ws.length };
    });
    await page.waitForTimeout(450);
    const mid = warns.filter(x => x.phase === 'midexit');
    // barpolish: caught mid-pose (the scale is between .94 and 1), its layout width untouched
    check(caught.transitions === 1 && caught.w > c.w * 0.9 && caught.w < c.w - 1 && Math.abs(caught.lw - c.w) < 1,
      'reproduced: revealed mid-exit, the pill caught on its way down', JSON.stringify(caught));
    check(!mid.length, 'no "apps hidden" judged from a reveal mid-exit', JSON.stringify(hidden(mid)));
    phase = 'midexit-landing';
    await page.evaluate(() => document.getElementById('bar').getAnimations().forEach(a => a.play()));
    await page.waitForTimeout(1300);
    s = await read();
    const back = warns.filter(x => x.phase === 'midexit-landing');
    const chipAtLanded = new RegExp('apps? hidden: [^\\n]* in a ' + c.w + 'px bar').test(s.more);
    if (c.fits) {
      check(Math.abs(s.w - c.w) < 1 && s.cap === 'none' && !back.length && !/apps? hidden/.test(s.more),
        'landed again at ' + c.w + ', no chip', JSON.stringify(s) + ' ' + JSON.stringify(hidden(back)));
    } else {
      check(Math.abs(s.w - c.w) < 1 && chipAtLanded && back.every(x => x.text.includes('in a ' + c.w + 'px bar')),
        'landed again at ' + c.w + ': still reported, against the landed width', JSON.stringify(s) + ' ' + JSON.stringify(hidden(back)));
    }
    check(!problems.length, 'no page or console errors', problems.join(' | '));
  } finally {
    await ctx.close();
  }
}

/* EDGE MODE (2026-09-23). The docked bar draws its chip strip, so the icons must stop short of it
   (they were painted over "hotkey off" in bar-1280.png), and "apps hidden" must actually be raised
   there: its judgement was made silently while the bar was down and, a reveal changing nothing
   in edge mode, never made again. The mock's own chips are real ones: "hotkey off" always (test
   mode has no hook), "sidecar down" with ?state=down. */
const EDGE = [
  { name: 'edge, 14 icons, 1280', q: '?apps=12', w: 1280, fits: true },
  { name: 'edge, 15 icons, 1000, two chips', q: '?apps=13&state=down', w: 1000, fits: false }
];

async function runEdge(browser, c) {
  console.log(c.name + ':');
  const ctx = await browser.newContext({ colorScheme: 'dark', deviceScaleFactor: 1.25, viewport: { width: c.w, height: 44 } });
  const page = await ctx.newPage();
  const warns = [], problems = [];
  const t0 = Date.now();
  page.on('console', m => {
    const t = m.text();
    if (/apps? hidden/.test(t)) warns.push({ ms: Date.now() - t0, text: t });
    if (m.type() === 'error') problems.push('console: ' + t);
  });
  page.on('pageerror', e => problems.push('pageerror: ' + e.message));
  try {
    await page.goto(PAGE + c.q, { waitUntil: 'load' });
    await page.waitForTimeout(3500);                 // reveal at 300 ms, then the chip and its settles
    const s = await page.evaluate(() => {
      const d = document.getElementById('dock'), ch = document.getElementById('chips');
      const cells = [...d.querySelectorAll('.cell')].map(x => x.getBoundingClientRect());
      const box = d.getBoundingClientRect(), cap = parseFloat(d.style.getPropertyValue('--dock-max'));
      const shownR = cells.length ? Math.min(cells[cells.length - 1].right, isNaN(cap) ? Infinity : box.left + cap) : 0;
      return { up: document.body.classList.contains('up'), edge: document.body.classList.contains('edge'),
        shownR: Math.round(shownR), chipsL: Math.round(ch.getBoundingClientRect().left),
        chips: [...ch.querySelectorAll('.chip .lbl')].map(x => x.textContent) };
    });
    check(s.up && s.edge && s.shownR <= s.chipsL, 'the icons stop short of the chip strip', JSON.stringify(s));
    const hid = s.chips.filter(t => /apps? hidden/.test(t));
    if (c.fits) check(!hid.length && !warns.length, 'everything fits: no "apps hidden"', JSON.stringify(s.chips));
    else {
      check(hid.length === 1, 'too many: the "apps hidden" chip is raised in edge mode too', JSON.stringify(s.chips));
      check(warns.length > 0 && warns.every(w => w.ms < 2500), 'and it settles (no report after 2.5 s)',
        JSON.stringify(warns.map(w => w.ms + 'ms ' + w.text.slice(6, 26))));
    }
    check(!problems.length, 'no page or console errors', problems.join(' | '));
  } finally {
    await ctx.close();
  }
}

(async () => {
  const exe = findChrome();
  if (!exe) { console.error('REVEAL FIT CHECK: could not run: no ms-playwright chromium under AppData/Local/ms-playwright'); process.exit(1); }
  const browser = await chromium.launch({ headless: true, executablePath: exe });
  try {
    for (const c of CASES) await runCase(browser, c);
    for (const c of EDGE) await runEdge(browser, c);
  } finally {
    await browser.close();
  }
  console.log('REVEAL FIT CHECK: ' + passed + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('REVEAL FIT CHECK: crashed: ' + (e && e.stack || e)); process.exit(1); });

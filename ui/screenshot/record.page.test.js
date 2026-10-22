/* record.page.test.js - Win+Shift+S's Record mode (lanes screenrec + screenrec2, 2026-10-15), on the REAL
 * overlay (index.html + overlay.js + overlay.css) with its own mock-mantle.js: headless Chromium, never
 * Electron, never a window of the user's, nothing captured or recorded. Light and dark:
 *   - the Record button is there, off; V turns it on (aria-pressed, body.record, main told
 *     screenshot.record {on}), its dot springs to full size in the record red, the hint says "to record";
 *   - Record on: the selection's edge is the record red (not the accent), the size readout leads with a
 *     red dot; a dragged area commits with record:true (no hwnd); Window mode commits the window's hwnd;
 *   - Copy text is refused while Record is on (it says why, the mode stays);
 *   - main can turn it on (the Win+G panel: screenshot.record {on:true}) or mark it unavailable with a
 *     reason: then it reads unavailable and a press says the reason, in the hint.
 *   node ui/screenshot/record.page.test.js   -> "RECORD MODE PAGE TEST: n passed, m failed"
 * LINE 1 is not optional: lowcpu.js pins this process and its browser.
 */
require('../../tools/dev-env.js').lowcpu();
const path = require('path');
let chromium;
({ chromium } = require('../../tools/dev-env.js').playwright());

const PAGE = 'file:///' + path.join(__dirname, 'index.html').replace(/\\/g, '/');
let passed = 0; const failures = [];
function check(name, ok, detail) { if (ok) passed++; else failures.push(`${name}${detail !== undefined ? ` (${JSON.stringify(detail).slice(0, 400)})` : ''}`); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RED = { light: 'rgb(196, 43, 28)', dark: 'rgb(224, 135, 124)' };   // dark: --lg-danger #e0877c

const LOOK = () => {
  const b = document.getElementById('rec'), dot = b && b.querySelector('.rec-dot');
  const m = dot ? getComputedStyle(dot).transform : '';
  return {
    has: !!b, pressed: b && b.getAttribute('aria-pressed'), disabled: b && b.getAttribute('aria-disabled'), title: b && b.title,
    record: document.body.classList.contains('record'), hint: document.getElementById('hint').textContent,
    hintWarn: document.getElementById('hint').classList.contains('warn'),
    dotFill: dot ? getComputedStyle(dot).fill : null, dotScale: m && m !== 'none' ? Number(m.match(/matrix\(([^,]+)/)[1]) : 1,
    hole: getComputedStyle(document.getElementById('hole')).boxShadow,
    sizeDot: getComputedStyle(document.getElementById('size'), '::before').backgroundColor,
    sizeDotContent: getComputedStyle(document.getElementById('size'), '::before').content,
    danger: getComputedStyle(document.documentElement).getPropertyValue('--lg-danger').trim(),
    mode: (document.querySelector('#bar button.mode[aria-pressed="true"]') || {}).dataset ? document.querySelector('#bar button.mode[aria-pressed="true"]').dataset.mode : null,
    calls: window.__mock.calls.filter((c) => /screenshot\.(record|commit)$/.test(c.name)).map((c) => ({ name: c.name, args: c.args })),
  };
};

async function open(browser, theme, mode) {
  const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(PAGE + '?mode=' + (mode || 'rect') + (theme === 'dark' ? '&theme=dark' : ''), { waitUntil: 'load' });
  if (theme === 'dark') await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  await page.waitForFunction(() => window.__mock.ready && window.__mock.ready.seq === 1, null, { timeout: 5000 }).catch(() => {});
  await sleep(150);
  return { page, errors };
}

async function main() {
  const browser = await require('../settings/test-browser.js').launch(chromium, { headless: true });
  try {
    for (const theme of ['light', 'dark']) {
      const T = (s) => `${theme}: ${s}`;
      {
        const { page, errors } = await open(browser, theme);
        const a = await page.evaluate(LOOK);
        check(T('the Record button is there, off'), a.has && a.pressed === 'false' && !a.record, a);
        check(T('off: its dot is small, in the button\'s ink'), a.dotScale < 0.7 && a.dotFill !== RED[theme], a);
        await page.keyboard.press('v');
        await sleep(600);   // the dot's spring
        const b = await page.evaluate(LOOK);
        const red = RED[theme];
        check(T('V turns Record on (pressed, body.record)'), b.pressed === 'true' && b.record, b);
        check(T('main is told: screenshot.record {on:true}'), b.calls.some((c) => c.name === 'screenshot.record' && c.args.on === true), b.calls);
        check(T('on: the dot springs to full size, in the record red'), b.dotScale > 0.97 && b.dotFill === red, b);
        check(T('on: the hint says it records'), /Drag an area to record/.test(b.hint), b.hint);
        check(T('on: the size readout leads with a red dot'), b.sizeDotContent !== 'none' && b.sizeDotContent !== 'normal', b.sizeDotContent);
        // drag an area
        await page.mouse.move(200, 150); await page.mouse.down(); await page.mouse.move(420, 330, { steps: 6 });
        const d = await page.evaluate(LOOK);
        check(T('on: the selection edge is the record red, not the accent'), d.hole.includes(RED[theme]), d.hole);
        await page.mouse.up();
        await sleep(100);
        const c = (await page.evaluate(LOOK)).calls.find((x) => x.name === 'screenshot.commit');
        check(T('a dragged area commits with record:true and no hwnd'), c && c.args.record === true && c.args.hwnd === undefined && c.args.mode === 'rect' && c.args.rect.w >= 200, c);
        check(T('no page errors (area)'), errors.length === 0, errors);
        await page.close();
      }
      {
        const { page } = await open(browser, theme, 'window');
        await page.keyboard.press('v');
        await page.mouse.move(700, 200);
        await sleep(80);
        await page.mouse.click(700, 200);
        await sleep(100);
        const c = (await page.evaluate(LOOK)).calls.find((x) => x.name === 'screenshot.commit');
        check(T('Window mode commits the window\'s hwnd with record:true'), c && c.args.record === true && c.args.hwnd === '1000' && c.args.kind === 'window', c);
        await page.close();
      }
      {
        const { page } = await open(browser, theme);
        await page.keyboard.press('v');
        await page.keyboard.press('t');
        await sleep(60);
        const t = await page.evaluate(LOOK);
        check(T('Copy text while recording: refused with why, the mode stays'), t.mode === 'rect' && t.hintWarn && /turn Record off/.test(t.hint), t);
        await page.close();
      }
      {
        const { page } = await open(browser, theme);
        await page.evaluate(() => window.__mockEmit('screenshot.record', { on: true, available: true, why: null }));
        await sleep(60);
        const on = await page.evaluate(LOOK);
        check(T('main turns it on (the Win+G panel)'), on.pressed === 'true' && on.record, on);
        await page.evaluate(() => window.__mockEmit('screenshot.record', { on: false, available: false, why: 'screen recording is switched off in the tray (Mantle Settings > Mantle)' }));
        await sleep(60);
        const off = await page.evaluate(LOOK);
        check(T('unavailable: off, aria-disabled, the reason in its tooltip'), off.pressed === 'false' && !off.record && off.disabled === 'true' && /switched off in the tray/.test(off.title), off);
        await page.keyboard.press('v');
        await sleep(60);
        const v = await page.evaluate(LOOK);
        check(T('unavailable: V says why in the hint and stays off'), !v.record && v.hintWarn && /switched off in the tray/.test(v.hint), v);
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
  console.log(`RECORD MODE PAGE TEST: ${passed} passed, ${failures.length} failed`);
  for (const f of failures) console.log('  FAIL ' + f);
  process.exit(failures.length ? 1 : 0);
}
main().catch((e) => { console.log(`RECORD MODE PAGE TEST: ${passed} passed, ${failures.length + 1} failed`); console.log(e.stack); process.exit(1); });

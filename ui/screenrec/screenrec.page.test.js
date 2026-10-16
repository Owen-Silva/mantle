/* screenrec.page.test.js - the recording pill and the card it becomes (lane screenrec2, 2026-10-15).
 *
 * Headless Chromium over the REAL ui/screenrec/index.html with its own mock-screenrec.js (never Electron,
 * never a window of Owen's, nothing recorded), at the window's own size (lib/features/screenrec.js WIN,
 * 480 x 248), in light and in dark:
 *   - starting: the hollow dot and "Starting…"; recording: the breathing dot and a LIVING timer that
 *     turns on its own (from startedAt), Stop; the window is see-through outside the shape;
 *   - Stop -> screenrec.pillStop, "Saving…", then the pill GROWS into the card (the size springs, it
 *     does not jump): "Recording saved", the details, the name, Open / Copy / Show in folder;
 *   - Copy -> "Copied: paste it into Discord or a chat"; a Copy that fails says why and the card stays;
 *     Open -> screenrec.cardOpen and the card goes (screenrec.cardClose after its exit fade);
 *   - a failure or a refusal: the reason in plain words, wrapping inside the card, no buttons;
 *   - only the shape takes the pointer (screenrec.pointer over true / false), and hovering holds the card;
 *   - everything fits: no word cut, the card and its light shadow inside the window; dark has no outer
 *     shadow (it ends on its hairline: ui/shared/clipped-shadow.test.js has it too);
 *   - reduced motion: no breathing.
 *   node ui/screenrec/screenrec.page.test.js   -> "SCREENREC PAGE TEST: n passed, m failed"
 * LINE 1 is not optional: lowcpu.js pins this process and its browser.
 */
try { require('C:/Users/user/dev-tools/tools/lowcpu.js'); } catch (e) { if (process.env.CI !== 'true') throw e; }
const path = require('path');
let chromium;
try { ({ chromium } = require('playwright-core')); } catch (_) { ({ chromium } = require('C:/Users/user/other-app/node_modules/playwright-core')); }

const PAGE = 'file:///' + path.join(__dirname, 'index.html').replace(/\\/g, '/');
const WIN = { width: 480, height: 248 };
const JARGON = /undefined|null|\[object|NaN|Error:|0x[0-9a-f]{4,}|HRESULT|exit code/i;
let passed = 0; const failures = [];
function check(name, ok, detail) { if (ok) passed++; else failures.push(`${name}${detail !== undefined ? ` (${JSON.stringify(detail).slice(0, 400)})` : ''}`); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** the outer layers of a computed box-shadow that cast a drop (blur or offset), not a 0-blur hairline ring */
const outerDrops = (s) => String(s).split(/,(?![^(]*\))/).filter((l) => !/inset/.test(l))
  .map((l) => (l.match(/-?[\d.]+px/g) || []).map(parseFloat)).filter((n) => n.length >= 3 && (n[2] > 0 || n[1] !== 0 || n[0] !== 0));

const LOOK = () => {
  const $ = (id) => document.getElementById(id);
  const sh = $('shape'), r = sh.getBoundingClientRect();
  const vis = (e) => !!e && !e.hidden && getComputedStyle(e).display !== 'none' && e.offsetWidth > 0;
  const cut = [];
  for (const e of document.querySelectorAll('.title, .detail, .clock, .act, .stop, .note, .status')) if (vis(e) && e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).textOverflow !== 'ellipsis') cut.push(e.className + ':' + e.textContent);
  return {
    shown: vis(sh), x: r.left, y: r.top, w: r.width, h: r.height, right: r.right, bottom: r.bottom,
    pill: vis($('pill')), card: vis($('card')), isCard: sh.classList.contains('is-card'),
    clock: $('clock').textContent, starting: $('pill').classList.contains('starting'), stopping: $('pill').classList.contains('stopping'),
    dotAnim: getComputedStyle(document.querySelector('.dot')).animationName,
    stop: vis($('stop')), stopDisabled: $('stop').disabled,
    title: $('title').textContent, detail: $('detail').textContent, name: $('name').textContent,
    actions: vis($('actions')), acts: Array.from(document.querySelectorAll('.act')).filter(vis).map((b) => b.textContent),
    warn: $('card').classList.contains('warn'), status: $('status').textContent, statusWarn: $('status').classList.contains('warn'),
    shadow: getComputedStyle(sh).boxShadow, bodyBg: getComputedStyle(document.body).backgroundColor, htmlBg: getComputedStyle(document.documentElement).backgroundColor,
    cut, calls: window.__mock.calls.map((c) => c.name + (c.args && c.args.over !== undefined ? ':' + c.args.over : '')),
  };
};

async function open(browser, q, theme, motion) {
  const page = await browser.newPage({ viewport: WIN, reducedMotion: motion || 'no-preference' });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(PAGE + '?' + q + (theme === 'dark' ? '&theme=dark' : ''), { waitUntil: 'load' });
  await sleep(700);   // the entrance spring settles
  return { page, errors };
}

async function main() {
  const browser = await require('../settings/test-browser.js').launch(chromium, { headless: true });
  try {
    for (const theme of ['light', 'dark']) {
      const T = (s) => `${theme}: ${s}`;
      /* ---- starting ---- */
      {
        const { page, errors } = await open(browser, 'state=starting', theme);
        const a = await page.evaluate(LOOK);
        check(T('starting: the pill shows "Starting…" with a hollow, still dot'), a.shown && a.pill && !a.card && a.clock === 'Starting…' && a.starting && a.dotAnim === 'none', a);
        check(T('starting: the page told main it loaded'), a.calls[0] === 'screenrec.loaded', a.calls);
        check(T('no page errors (starting)'), errors.length === 0, errors);
        await page.close();
      }
      /* ---- recording -> stop -> card ---- */
      {
        const { page, errors } = await open(browser, 'state=recording&secs=65&savems=500', theme);
        const a = await page.evaluate(LOOK);
        check(T('recording: the pill with the timer from startedAt'), a.pill && !a.starting && /^1:0[56]$/.test(a.clock), a);
        check(T('recording: the dot breathes'), a.dotAnim === 'breathe', a.dotAnim);
        check(T('recording: Stop is there and enabled'), a.stop && !a.stopDisabled);
        check(T('recording: a pill (40 tall, round ends), top centre'), Math.round(a.h) === 40 && Math.abs((a.x + a.w / 2) - WIN.width / 2) <= 1 && a.y >= 8 && a.y <= 12 && a.w >= 120 && a.w <= 220, a);
        check(T('the window is see-through outside the shape'), /rgba\(0, 0, 0, 0\)|transparent/.test(a.bodyBg) && /rgba\(0, 0, 0, 0\)|transparent/.test(a.htmlBg), [a.bodyBg, a.htmlBg]);
        check(T('recording: nothing is cut'), a.cut.length === 0, a.cut);
        const c0 = a.clock;
        await sleep(1150);
        const c1 = await page.evaluate(() => document.getElementById('clock').textContent);
        check(T('the timer lives on its own (no message from main)'), c1 !== c0 && /^1:0[6-8]$/.test(c1), [c0, c1]);
        // the pointer: only the shape takes it
        await page.mouse.move(a.x + a.w / 2, a.y + a.h / 2);
        await sleep(60);
        await page.mouse.move(10, 200);
        await sleep(60);
        const ptr = (await page.evaluate(LOOK)).calls.filter((n) => n.startsWith('screenrec.pointer'));
        check(T('over the shape -> pointer true; off it -> false'), ptr[0] === 'screenrec.pointer:true' && ptr[1] === 'screenrec.pointer:false', ptr);
        const pillW = a.w;
        await page.click('#stop');
        await sleep(60);
        const s = await page.evaluate(LOOK);
        check(T('Stop -> screenrec.pillStop and "Saving…"'), s.calls.includes('screenrec.pillStop') && s.clock === 'Saving…' && s.stopping && s.stopDisabled, s);
        // the card arrives (mock: 500 ms after Stop); sample the size while it springs
        await page.waitForFunction(() => document.getElementById('shape').classList.contains('is-card'), null, { timeout: 3000 });
        const widths = [];
        for (let i = 0; i < 12; i++) { widths.push(await page.evaluate(() => document.getElementById('shape').getBoundingClientRect().width)); await sleep(40); }
        await sleep(500);
        const d = await page.evaluate(LOOK);
        const mid = widths.filter((w) => w > pillW + 4 && w < d.w - 4);
        check(T('the pill GROWS into the card (in-between sizes seen, not a jump)'), mid.length >= 1, { pillW, widths: widths.map(Math.round), final: d.w });
        check(T('card: "Recording saved", the details and the name'), d.card && !d.pill && d.title === 'Recording saved' && d.detail === '0:47 · 1920 × 1080 · 14.2 MB' && d.name === 'Recording 2026-10-15 213000.mp4', d);
        check(T('card: Open, Copy, Show in folder'), JSON.stringify(d.acts) === JSON.stringify(['Open', 'Copy', 'Show in folder']), d.acts);
        check(T('card: stays top centre, grown from the same spot'), Math.abs((d.x + d.w / 2) - WIN.width / 2) <= 1 && Math.abs(d.y - a.y) <= 1, d);
        check(T('card: inside the window with room for its shadow'), d.x >= 24 && d.right <= WIN.width - 24 && d.bottom <= WIN.height - 50, d);
        check(T('card: nothing is cut'), d.cut.length === 0, d.cut);
        check(T(theme === 'dark' ? 'dark: no outer shadow (ends on its hairline)' : 'light: the --lg-shadow drop'), theme === 'dark' ? outerDrops(d.shadow).length === 0 : outerDrops(d.shadow).length >= 2 && /56px/.test(d.shadow), d.shadow);
        // Copy, then Open
        await page.click('#copy');
        await sleep(60);
        const cp = await page.evaluate(LOOK);
        check(T('Copy -> screenrec.cardCopy and the words for Discord'), cp.calls.includes('screenrec.cardCopy') && cp.status === 'Copied: paste it into Discord or a chat' && !cp.statusWarn && cp.card, cp);
        check(T('Copy -> still nothing cut'), cp.cut.length === 0, cp.cut);
        await page.click('#open');
        await sleep(400);
        const op = await page.evaluate(LOOK);
        check(T('Open -> screenrec.cardOpen, then the card goes (cardClose)'), op.calls.includes('screenrec.cardOpen') && op.calls.includes('screenrec.cardClose') && !op.shown, op.calls);
        check(T('no page errors (recording)'), errors.length === 0, errors);
        await page.close();
      }
      /* ---- failures ---- */
      for (const st of ['failed', 'refused']) {
        const { page, errors } = await open(browser, 'state=' + st, theme);
        const f = await page.evaluate(LOOK);
        check(T(`${st}: a warn card, the reason in plain words, no buttons`), f.card && f.warn && !f.actions && f.detail.length > 20 && !JARGON.test(f.detail) && f.title === (st === 'failed' ? 'Recording not saved' : 'Not recording'), f);
        check(T(`${st}: the reason wraps inside the card, nothing cut`), f.w <= 420 && f.cut.length === 0 && f.h > 60, f);
        check(T(`${st}: no page errors`), errors.length === 0, errors);
        await page.close();
      }
      /* ---- a Copy that fails; the card's life held by hover ---- */
      {
        const { page } = await open(browser, 'state=done&copyfail=1', theme);
        const b = await page.evaluate(LOOK);
        await page.mouse.move(b.x + 20, b.y + 20);
        await sleep(60);
        const held = await page.evaluate(() => window.__screenrec.state.life === null);
        check(T('hovering the card holds it (no close timer)'), held);
        await page.click('#copy');
        await sleep(60);
        const e = await page.evaluate(LOOK);
        check(T('Copy fails -> the reason in warn words, the card stays'), e.statusWarn && /clipboard/.test(e.status) && e.card && e.shown, e);
        await page.mouse.move(5, 240);
        await sleep(60);
        const armed = await page.evaluate(() => window.__screenrec.state.life !== null);
        check(T('leaving the card arms its close again'), armed);
        await page.close();
      }
    }
    /* ---- reduced motion ---- */
    {
      const { page } = await open(browser, 'state=recording', 'light', 'reduce');
      const r = await page.evaluate(LOOK);
      check('reduced motion: the dot does not breathe', r.dotAnim === 'none', r.dotAnim);
      await page.close();
    }
  } finally {
    await browser.close();
  }
  console.log(`SCREENREC PAGE TEST: ${passed} passed, ${failures.length} failed`);
  for (const f of failures) console.log('  FAIL ' + f);
  process.exit(failures.length ? 1 : 0);
}
main().catch((e) => { console.log(`SCREENREC PAGE TEST: ${passed} passed, ${failures.length + 1} failed`); console.log(e.stack); process.exit(1); });

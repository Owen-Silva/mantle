/* record-follow.page.test.js - the Win+G Record panel's page GLIDES WITH THE BAR (lane corner-follow,
 * 2026-10-17). Headless Chromium over ui/clips/record.html in a window as main makes it with Owen's numbers
 * (the card's 260 + the reach 56 = 316 tall, 376 wide), a fake window.mantle pushing clips.lift:
 *   the card at the window's BOTTOM (18 DIP margin) with no lift; up on the bar's spring (linear()) over
 *   the ms main sends, really travelling, landing 56 up; down on the bar's exit (cubic-bezier(.3,0,.8,.15));
 *   a reversal half-way goes back from where it is; ms 0 = simply there; clips.size never changes with the
 *   lift (offsetHeight); dark: one fresh backdrop once a glide lands (bar-follow reshoot);
 *   reduced motion: up jumps at once, down waits out the bar's fade then jumps.
 * HEAVY (Chromium): run only in the parent's queue hold, never in a lane.
 *   node ui/clips/record-follow.page.test.js   -> "RECORD FOLLOW PAGE TEST: n passed, m failed"
 */
try { require('C:/Users/user/dev-tools/tools/lowcpu.js'); } catch (e) { if (process.env.CI !== 'true') throw e; }
let chromium;
try { ({ chromium } = require('playwright-core')); } catch (_) { ({ chromium } = require('C:/Users/user/other-app/node_modules/playwright-core')); }
const UI = 'file:///' + __dirname.replace(/\\/g, '/') + '/';
let passed = 0; const failures = [];
function check(name, ok, detail) { if (ok) passed++; else failures.push(`${name}${detail !== undefined ? ` (${String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 300)})` : ''}`); return ok; }

const FAKE = ([theme]) => {
  const on = {}; const calls = [];
  const set = () => { document.documentElement.dataset.theme = theme; };
  if (document.documentElement) set(); else new MutationObserver((_m, o) => { if (document.documentElement) { set(); o.disconnect(); } }).observe(document, { childList: true });
  window.__fake = { calls, emit(ch, p) { (on[ch] || []).forEach((f) => f(p)); } };
  window.mantle = {
    on(ch, fn) { (on[ch] = on[ch] || []).push(fn); return () => {}; },
    call(ch, args) { calls.push({ ch, args: args === undefined ? null : JSON.parse(JSON.stringify(args)) }); return Promise.resolve(ch === 'hud.backdrop' ? { ok: false, reason: 'the test takes no picture' } : { ok: true }); },
  };
};
const ST = (o) => Object.assign({ rec: { on: false, since: null, pending: false, by: null, why: null }, app: 'Mantle stand-in', plan: { can: true, how: 'keys', why: 'records this window' }, mic: false, screenrec: false, now: Date.now() }, o || {});
const W = 376, H = 316, REACH = 56;

async function open(browser, theme, reduced) {
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1, reducedMotion: reduced ? 'reduce' : 'no-preference' });
  const page = await ctx.newPage();
  await page.addInitScript(FAKE, [theme]);
  await page.goto(UI + 'record.html');
  const emit = (ch, p) => page.evaluate(([c, x]) => window.__fake.emit(c, x), [ch, p]);
  const calls = (ch) => page.evaluate((c) => window.__fake.calls.filter((x) => x.ch === c).map((x) => x.args), ch);
  const g = () => page.evaluate(() => {
    const l = document.getElementById('lift'), c = document.getElementById('card'), cs = getComputedStyle(l);
    const m = /matrix\(([^)]+)\)/.exec(cs.transform);
    const r = c.getBoundingClientRect();
    return { y: m ? Number(m[1].split(',')[5]) : 0, tf: cs.transitionTimingFunction, dur: cs.transitionDuration, bottom: r.bottom, right: r.right, offH: c.offsetHeight, inner: window.innerHeight, innerW: window.innerWidth, lift: window.__clipsPanel.lift() };
  });
  await emit('clips.state', ST({ open: true, seq: 1 }));
  await page.waitForTimeout(500);   // the open's pop settles
  return { ctx, page, emit, calls, g };
}

(async () => {
  const browser = await require('../settings/test-browser.js').launch(chromium, { headless: true });
  try {
    for (const theme of ['light', 'dark']) {
      const T = theme + ': ';
      const P = await open(browser, theme, false);
      const { page, emit, calls, g } = P;
      let rebakes = 0;
      await page.exposeFunction('__rebaked', () => { rebakes++; });
      await page.evaluate(() => { const H = window.MantleHudBackdrop; if (H) { const req = H.request; H.request = function (why) { if (why === 'the record panel glided with the bar') window.__rebaked(); return req.apply(this, arguments); }; } });
      const g0 = await g();
      check(T + 'the card sits at the window\'s bottom-right (18 DIP margin), no lift', g0.y === 0 && Math.abs(g0.bottom - (H - 18)) < 0.6 && Math.abs(g0.right - (W - 18)) < 0.6, g0);
      const sizes0 = (await calls('clips.size')).length;
      await emit('clips.lift', { px: REACH, kind: 'up', ms: 336 });
      const g1 = await g();
      check(T + 'up: on the bar\'s spring (linear()) over 336 ms', /^linear\(/.test(g1.tf) && g1.dur === '0.336s', g1);
      await page.waitForTimeout(70);
      const gm = await g();
      check(T + 'up: really travels (mid-way, not a jump)', gm.y < -3 && gm.y > -REACH, gm);
      await page.waitForTimeout(480);
      const g2 = await g();
      check(T + 'up: lands 56 above the corner', Math.abs(g2.y + REACH) < 0.5 && Math.abs(g2.bottom - (H - 18 - REACH)) < 0.6 && g2.lift === REACH, g2);
      check(T + 'the lift never changes what clips.size asks (offsetHeight)', g2.offH === g0.offH && (await calls('clips.size')).length === sizes0, { g0, g2 });
      if (theme === 'dark') check(T + 'dark: one fresh backdrop is asked for once the glide lands (ui/shared/bar-follow.js reshoot)', rebakes >= 1, rebakes);
      await emit('clips.lift', { px: 0, kind: 'down', ms: 300 });
      const g3 = await g();
      check(T + 'down: on the bar\'s exit (cubic-bezier(.3,0,.8,.15)) over 300 ms', /cubic-bezier\(0\.3, 0, 0\.8, 0\.15\)/.test(g3.tf) && g3.dur === '0.3s', g3);
      await page.waitForTimeout(400);
      check(T + 'down: back in the corner', Math.abs((await g()).y) < 0.5);
      await emit('clips.lift', { px: REACH, kind: 'up', ms: 336 });
      await page.waitForTimeout(60);
      const g5 = await g();
      await emit('clips.lift', { px: 0, kind: 'down', ms: 300 });
      const g6 = await g();
      check(T + 'rapid toggle: the way back starts from where it was (no jump)', g5.y < -3 && Math.abs(g6.y - g5.y) < 8, { g5, g6 });
      await page.waitForTimeout(400);
      check(T + 'rapid toggle: ends in the corner', Math.abs((await g()).y) < 0.5);
      await emit('clips.lift', { px: REACH, kind: 'up', ms: 0 });
      check(T + 'ms 0: simply there, no travel', Math.abs((await g()).y + REACH) < 0.5);
      await emit('clips.lift', { px: 0, kind: 'down', ms: 0 });
      check(T + 'ms 0 down: simply back', Math.abs((await g()).y) < 0.5);
      // hidden: the page still takes where it stands, without travel (nothing on screen to glide)
      await emit('clips.hide', { why: 'test' });
      await emit('clips.lift', { px: REACH, kind: 'up', ms: 336 });
      const gh = await g();
      check(T + 'hidden: it stands at the new place at once (no glide)', Math.abs(gh.y + REACH) < 0.5, gh);
      await P.ctx.close();
    }
    {
      const P = await open(browser, 'light', true);
      const { page, emit, g } = P;
      await emit('clips.lift', { px: REACH, kind: 'up', ms: 336 });
      const r = await g();
      check('reduced motion: up is 56 at once (no travel)', Math.abs(r.y + REACH) < 0.5 && r.dur === '0s', r);
      await emit('clips.lift', { px: 0, kind: 'down', ms: 300 });
      const yHeld = (await g()).y;
      await page.waitForTimeout(150);
      const yMid = (await g()).y;
      await page.waitForTimeout(260);
      const yDown = (await g()).y;
      check('reduced motion, the bar going: holds above the fading pill for the 300 ms, then is in the corner', Math.abs(yHeld + REACH) < 0.5 && Math.abs(yMid + REACH) < 0.5 && Math.abs(yDown) < 0.5, { yHeld, yMid, yDown });
      await P.ctx.close();
    }
  } catch (err) {
    failures.push(`threw: ${err.stack}`);
  } finally {
    await browser.close();
  }
  console.log(`RECORD FOLLOW PAGE TEST: ${passed} passed, ${failures.length} failed`);
  for (const f of failures) console.log(`  FAIL ${f}`);
  process.exitCode = failures.length ? 1 : 0;
})();

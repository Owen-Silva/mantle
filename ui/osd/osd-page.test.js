/* osd-page.test.js - the volume/brightness pop-up PAGE, driven for real (capture-osd, 2026-09-29).
 *
 * Headless Chromium over ui/osd/index.html with a fake window.mantle (installed before the page's
 * scripts, so ui/osd/mock-mantle.js stands down). Every check CLICKS, WHEELS or pushes main's events
 * through the page's own code and reads what it asked main for; nothing reaches Windows.
 *   bash <lanes>/bin/uislot.sh <lane> node ui/osd/osd-page.test.js
 * LINE 1 is not optional: lowcpu.js pins this process and its browser.
 */
require('C:/Users/user/dev-tools/tools/lowcpu.js');
const { chromium } = require('C:/Users/user/other-app/node_modules/playwright-core');

const CHROME = 'C:/Users/user/AppData/Local/ms-playwright/chromium-1234/chrome-win64/chrome.exe';
const PAGE = 'file:///C:/Users/user/mantle/ui/osd/index.html';

let passed = 0; const failures = [];
function check(name, ok, detail) { if (ok) passed++; else failures.push(`${name}${detail !== undefined ? ` (${String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 300)})` : ''}`); }

/* The fake main: records every call, answers qs.* like main does, and lets the test push events. */
const FAKE = () => {
  const on = {};
  const calls = [];
  const cfg = { refuse: false, sessions: 'ok' };
  let vol = { ok: true, level: 40, muted: false, reason: null };
  window.__fake = { calls, cfg, emit(ch, p) { (on[ch] || []).forEach((f) => f(p)); }, vol: () => vol };
  window.mantle = {
    on(ch, fn) { (on[ch] = on[ch] || []).push(fn); return () => {}; },
    call(ch, args) {
      calls.push({ ch, args: args === undefined ? null : JSON.parse(JSON.stringify(args)), at: performance.now() });
      if (ch === 'qs.set') {
        if (cfg.refuse) return Promise.resolve({ ok: false, reason: 'Windows refused it (HRESULT 0x80070005)', state: Object.assign({}, vol) });
        if (args.part === 'mute') vol = Object.assign({}, vol, { muted: !!args.value });
        else vol = Object.assign({}, vol, { level: args.value, muted: args.part === 'volume' ? false : vol.muted });
        return Promise.resolve({ ok: true, state: Object.assign({}, vol) });
      }
      if (ch === 'qs.audio.sessions') {
        if (cfg.sessions === 'error') return Promise.resolve({ ok: false, reason: 'there is no default playback device (HRESULT 0x80070490), so no app can play sound', sessions: [] });
        return Promise.resolve({ ok: true, device: { name: 'Speakers' }, sessions: [
          { key: 'pid:1', name: 'Spotify', level: 70, muted: false, active: true },
          { key: 'pid:2', name: 'A browser with a very very long name that must ellipsize', level: 50, muted: false, active: true },
        ] });
      }
      if (ch === 'qs.audio.session') return Promise.resolve({ ok: true, session: { key: args.key, level: args.level !== undefined ? args.level : 50, muted: !!args.muted, active: true } });
      return Promise.resolve({ ok: true });
    },
  };
};

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const fresh = async (opts) => {
    const ctx = await browser.newContext(Object.assign({ viewport: { width: 440, height: 560 } }, opts || {}));
    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    await page.addInitScript(FAKE);
    await page.goto(PAGE, { waitUntil: 'load' });
    await page.mouse.move(2, 2);
    return { ctx, page, errs };
  };
  const calls = (page, ch) => page.evaluate((c) => window.__fake.calls.filter((x) => !c || x.ch === c), ch);
  const emit = (page, ch, p) => page.evaluate(([c, x]) => window.__fake.emit(c, x), [ch, p]);
  try {
    // ---- 1. show, the level, the fade, and the sequence number echoed in osd.faded
    {
      const { ctx, page, errs } = await fresh();
      await emit(page, 'osd.show', { kind: 'volume', state: { ok: true, level: 40, muted: false }, seq: 7 });
      const s = await page.evaluate(() => ({ shown: window.__osd.state().shown, num: document.getElementById('num').textContent, val: document.getElementById('level').value }));
      check('osd.show draws the level: number and bar', s.shown && s.num === '40' && s.val === '40', s);
      const sizes = await calls(page, 'osd.size');
      check('the page reports its size to main (the window is fitted to it)', sizes.length >= 1 && sizes[0].args.w > 200 && sizes[0].args.h > 60, sizes);
      await emit(page, 'osd.level', { kind: 'volume', state: { ok: true, level: 42, muted: false } });
      check('osd.level moves the number while it is up', (await page.textContent('#num')) === '42');
      const t0 = Date.now();
      await page.waitForFunction(() => window.__fake.calls.some((c) => c.ch === 'osd.faded'), null, { timeout: 4000 });
      const ms = Date.now() - t0;
      const f = (await calls(page, 'osd.faded'))[0];
      check('it fades by itself ~1.5 s after the last change, plus the 260 ms fade', ms >= 1450 && ms < 2400, ms);
      check('osd.faded echoes the sequence number of the show it faded', f.args && f.args.seq === 7, f);
      await emit(page, 'osd.level', { kind: 'volume', state: { ok: true, level: 50, muted: false } });
      check('a level change while hidden does not bring it back (only main\'s show does)', (await page.evaluate(() => window.__osd.state().shown)) === false);
      check('no page errors', errs.length === 0, errs);
      await ctx.close();
    }
    // ---- 2. reduced motion: no fade, the window goes at once
    {
      const { ctx, page } = await fresh({ reducedMotion: 'reduce' });
      await emit(page, 'osd.show', { kind: 'volume', state: { ok: true, level: 40, muted: false }, seq: 1 });
      const t0 = Date.now();
      await page.waitForFunction(() => window.__fake.calls.some((c) => c.ch === 'osd.faded'), null, { timeout: 4000 });
      const ms = Date.now() - t0;
      const tr = await page.evaluate(() => getComputedStyle(document.getElementById('osd')).transitionDuration);
      check('reduced motion: no fade transition on the pop-up', /^0s/.test(tr), tr);
      check('reduced motion: the window is released right at the 1.5 s mark, no fade wait', ms >= 1450 && ms < 1700, ms);
      await ctx.close();
    }
    // ---- 3. the wheel: a notch is one step; a touchpad swipe is not a jump to 100
    {
      const { ctx, page } = await fresh();
      await emit(page, 'osd.show', { kind: 'volume', state: { ok: true, level: 40, muted: false }, seq: 1 });
      await page.hover('#num');
      await page.mouse.wheel(0, -100);
      await page.waitForTimeout(120);
      let sets = (await calls(page, 'qs.set')).filter((c) => c.args.part === 'volume');
      check('one mouse notch up over the pop-up: volume 40 -> 42', sets.length >= 1 && sets[sets.length - 1].args.value === 42, sets.map((c) => c.args.value));
      for (let i = 0; i < 20; i++) await page.mouse.wheel(0, -4);   // a touchpad: many tiny deltas
      await page.waitForTimeout(150);
      sets = (await calls(page, 'qs.set')).filter((c) => c.args.part === 'volume');
      const last = sets[sets.length - 1].args.value;
      check('a touchpad swipe of 20 x 4 px moves it at most one step (was: +40)', last <= 44, sets.map((c) => c.args.value));
      await page.mouse.wheel(0, 100);
      await page.waitForTimeout(120);
      sets = (await calls(page, 'qs.set')).filter((c) => c.args.part === 'volume');
      check('one notch down steps it back down by 2', sets[sets.length - 1].args.value === last - 2, sets.map((c) => c.args.value));
      await emit(page, 'osd.show', { kind: 'volume', state: { ok: true, level: 33, muted: false }, seq: 2 });
      await page.mouse.wheel(0, -100);
      await page.waitForTimeout(120);
      sets = (await calls(page, 'qs.set')).filter((c) => c.args.part === 'volume');
      check('the wheel snaps like the keys: 33 -> 34 (not 35)', sets[sets.length - 1].args.value === 34, sets.map((c) => c.args.value));
      const up = await page.evaluate(() => window.__osd.state().fade);
      check('the pointer over it keeps it up while wheeling', up.up && up.hovered, up);
      await ctx.close();
    }
    // ---- 4. mute: a click on the speaker, the read-back decides; a refusal springs back in plain words
    {
      const { ctx, page } = await fresh();
      await emit(page, 'osd.show', { kind: 'volume', state: { ok: true, level: 40, muted: false }, seq: 1 });
      const title = await page.getAttribute('#glyph', 'title');
      check('the speaker says what a click does, and the key for it', /^Mute/.test(title) && /mute key/i.test(title), title);
      await page.click('#glyph');
      await page.waitForTimeout(80);
      const m = await page.evaluate(() => ({ muted: window.__osd.state().st.volume.muted, pressed: document.getElementById('glyph').getAttribute('aria-pressed'), cls: document.getElementById('osd').className, title: document.getElementById('glyph').title }));
      check('a click mutes: state, aria-pressed and the muted look', m.muted === true && m.pressed === 'true' && /muted/.test(m.cls) && /^Unmute/.test(m.title), m);
      await page.click('#glyph');
      await page.waitForTimeout(80);
      check('a second click unmutes', (await page.evaluate(() => window.__osd.state().st.volume.muted)) === false);
      await page.evaluate(() => { window.__fake.cfg.refuse = true; });
      await page.click('#glyph');
      await page.waitForTimeout(80);
      const r = await page.evaluate(() => ({ muted: window.__osd.state().st.volume.muted, why: document.getElementById('why').textContent, hidden: document.getElementById('why').hidden }));
      check('a refused mute springs back and says so, with no error code on screen', r.muted === false && !r.hidden && /did not take/.test(r.why) && !/0x|HRESULT/.test(r.why), r);
      await ctx.close();
    }
    // ---- 5. unavailable: no playback device says what to do, never a code; muted at 0 still reads
    {
      const { ctx, page } = await fresh();
      await emit(page, 'osd.show', { kind: 'volume', state: { ok: false, level: null, muted: false, reason: 'the volume key did nothing: no default playback device (HRESULT 0x80070490) - nothing is plugged in, or audio is disabled' }, seq: 1 });
      const d = await page.evaluate(() => ({ num: document.getElementById('num').textContent, why: document.getElementById('why').textContent, dis: document.getElementById('level').disabled, g: document.getElementById('glyph').disabled }));
      check('no playback device: a dash, the controls disabled', d.num === '—' && d.dis && d.g, d);
      check('no playback device: the line says what to do in plain words', /No speakers or headphones are connected/.test(d.why) && /Plug some in/.test(d.why) && !/0x|HRESULT|default playback/.test(d.why), d.why);
      await emit(page, 'osd.show', { kind: 'volume', state: { ok: true, level: 0, muted: true }, seq: 2 });
      const z = await page.evaluate(() => ({ num: document.getElementById('num').textContent, muted: document.getElementById('osd').classList.contains('muted'), why: document.getElementById('why').hidden, svg: document.getElementById('glyph').innerHTML }));
      check('muted at 0: reads 0, muted look, no warning, the crossed speaker', z.num === '0' && z.muted && z.why && /M10\.2 5\.6/.test(z.svg), z);
      await ctx.close();
    }
    // ---- 6. brightness: the sun, no mute, no apps chevron; a volume panel open is closed for it
    {
      const { ctx, page } = await fresh();
      await emit(page, 'osd.show', { kind: 'volume', state: { ok: true, level: 40, muted: false }, expand: true, seq: 1 });
      await page.waitForTimeout(100);
      check('expand opens the per-app panel', (await page.evaluate(() => window.__osd.state().open)) === true);
      await emit(page, 'osd.show', { kind: 'brightness', state: { ok: true, level: 70 }, seq: 2 });
      const b = await page.evaluate(() => ({ kind: window.__osd.state().kind, open: window.__osd.state().open, num: document.getElementById('num').textContent, g: document.getElementById('glyph').disabled, more: getComputedStyle(document.getElementById('more')).display, label: document.getElementById('level').getAttribute('aria-label') }));
      check('brightness: the level, the sun (not a button), no chevron, the panel closed', b.kind === 'brightness' && !b.open && b.num === '70' && b.g && b.more === 'none' && b.label === 'Brightness', b);
      await page.hover('#num');
      await page.mouse.wheel(0, -100);
      await page.waitForTimeout(100);
      const bs = (await calls(page, 'qs.set')).filter((c) => c.args.part === 'brightness');
      check('the wheel over the brightness pop-up sets brightness (not volume)', bs.length >= 1 && bs[bs.length - 1].args.value === 72, bs.map((c) => c.args));
      await ctx.close();
    }
    // ---- 7. the per-app panel: rows, a row's mute, the error state and Try again, Esc
    {
      const { ctx, page } = await fresh();
      await emit(page, 'osd.show', { kind: 'volume', state: { ok: true, level: 40, muted: false }, seq: 1 });
      await page.hover('#pill');
      await page.click('#more');
      await page.waitForTimeout(150);
      const rows = await page.evaluate(() => Array.from(document.querySelectorAll('.app .aname')).map((e) => ({ t: e.textContent, cut: e.scrollWidth > e.clientWidth, title: e.title })));
      check('the chevron opens the panel with one row per app', rows.length === 2 && rows[0].t === 'Spotify', rows);
      check('a long app name ellipsizes and has its full name on hover', rows[1].cut && /very long name/.test(rows[1].title), rows[1]);
      check('the panel names the device', (await page.textContent('#dev')) === 'Speakers');
      await page.click('.app:nth-child(1) .amute');
      await page.waitForTimeout(80);
      const sm = (await calls(page, 'qs.audio.session')).slice(-1)[0];
      check('a row\'s speaker mutes that app only', sm && sm.args.key === 'pid:1' && sm.args.muted === true, sm);
      await page.click('#more');
      await page.evaluate(() => { window.__fake.cfg.sessions = 'error'; });
      await page.click('#more');
      await page.waitForTimeout(150);
      const e = await page.evaluate(() => ({ t: document.querySelector('.state.bad') && document.querySelector('.state.bad').textContent, btn: !!document.querySelector('.retry') }));
      check('apps unreadable: a plain reason and a Try again button, no code', e.t && /can’t be read/.test(e.t) && /No speakers or headphones/.test(e.t) && !/0x/.test(e.t) && e.btn, e);
      const n = (await calls(page, 'qs.audio.sessions')).length;
      await page.evaluate(() => { window.__fake.cfg.sessions = 'ok'; });
      await page.click('.retry');
      await page.waitForTimeout(150);
      check('Try again asks again and the rows come back', (await calls(page, 'qs.audio.sessions')).length > n && (await page.$$('.app')).length === 2);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(400);
      check('Esc closes it (if the window ever has the keyboard)', (await page.evaluate(() => window.__osd.state().shown)) === false);
      await page.waitForTimeout(3000);
      const polls = (await calls(page, 'qs.audio.sessions')).length;
      await page.waitForTimeout(1700);
      check('closed: the apps poll stops (no timer left running)', (await calls(page, 'qs.audio.sessions')).length === polls);
      await ctx.close();
    }
  } finally {
    await browser.close();
  }
  console.log(`osd page: ${passed} passed, ${failures.length} failed`);
  failures.forEach((f) => console.log(`  FAIL ${f}`));
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.log(`osd page: CRASHED ${e && e.stack || e}`); process.exit(1); });

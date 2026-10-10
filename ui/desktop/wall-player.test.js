require('C:/Users/user/dev-tools/tools/lowcpu.js');
/* wall-player.test.js -- the desktop page's wallpaper player, driven through its real events (lane
 * launch-desk, 2026-09-29).
 *
 * Headless chromium over file:// (never Electron, never Owen's desktop): ui/desktop/index.html with a
 * fake window.mantle installed first (so mock-mantle.js stands aside) that records every call and lets
 * the test send main's events. The video is a 2-second VP8 clip the test records itself from a canvas
 * into a temp file; the pictures are data: URLs. Checks: a picture and a video mount and report
 * "playing"; pause / resume; a game's unload and the wake after it; a video that errors AFTER it had
 * played is mounted again once (the graphics side restarting after sleep), and a second error is
 * reported in plain words; 300 wallpaper switches leave one element, no pile of timers and a flat heap.
 *
 *   node ui/desktop/wall-player.test.js               the dev tree (must pass)
 *   node ui/desktop/wall-player.test.js --base=<dir>  serve <dir>/ui/desktop/desktop.js instead (expected to FAIL)
 * Run it through the lane's uislot.sh. Prints "WALL PLAYER TEST: n passed, m failed".
 */
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.resolve(__dirname, '..', '..');
// the newest installed Playwright Chromium (the pinned chromium-1234 build was removed 2026-10-05;
// lane same-shell, 2026-10-09)
const CHROME = (() => {
  const base = 'C:/Users/user/AppData/Local/ms-playwright';
  try {
    for (const d of fs.readdirSync(base).filter((n) => /^chromium-[0-9]+$/.test(n)).sort((x, y) => +y.slice(9) - +x.slice(9))) {
      const p = base + '/' + d + '/chrome-win64/chrome.exe';
      if (fs.existsSync(p)) return p;
    }
  } catch (_) { /* reported below as "no chromium at" */ }
  return base + '/chromium-*/chrome-win64/chrome.exe';
})();
const PAGE = 'file:///' + path.join(ROOT, 'ui', 'desktop', 'index.html').replace(/\\/g, '/') + '?ok=1';
const BASE = (process.argv.find((a) => a.startsWith('--base=')) || '').slice(7);

let passed = 0;
const failures = [];
const check = (name, ok, detail) => { if (ok) passed++; else failures.push(detail !== undefined ? `${name} (${String(detail).slice(0, 300)})` : name); return ok; };

const FAKE = String.raw`(() => {
  window.__calls = [];
  const subs = {};
  window.__emit = (name, payload) => { (subs[name] || []).forEach((fn) => fn(payload)); };
  // Pending timers, to prove switching wallpapers does not pile them up.
  const pend = new Set();
  const st = window.setTimeout, ct = window.clearTimeout;
  window.setTimeout = function (fn, ms, ...a) { const id = st(function () { pend.delete(id); if (typeof fn === 'function') fn.apply(this, a); }, ms); pend.add(id); return id; };
  window.clearTimeout = function (id) { pend.delete(id); return ct(id); };
  window.__pending = () => pend.size;
  window.mantle = {
    call: async (cmd, a) => { window.__calls.push([cmd, a || {}]); if (cmd === 'sys.stats') return { cpu: 1, mem: { used: 1, total: 2 } }; if (cmd === 'net.probe') return { ok: false, reason: 'closed' }; return { ok: true }; },
    on(name, fn) { (subs[name] = subs[name] || []).push(fn); return () => {}; },
  };
})();`;

const PNG_A = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkaPhfDwAEhQHwZ6hNWgAAAABJRU5ErkJggg==';
const PNG_B = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const pic = (id, url) => ({ ok: true, reason: '', paused: false, unload: false, item: { id, title: id, type: 'picture', url, look: { fit: 'cover', filter: '', rate: 1 }, props: [] } });

async function run() {
  if (!fs.existsSync(CHROME)) { failures.push('no chromium at ' + CHROME); return; }
  const { chromium } = require('C:/Users/user/other-app/node_modules/playwright-core');
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--autoplay-policy=no-user-gesture-required', '--allow-file-access-from-files'] });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mantle-wallplayer-'));
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    /* ---- a 2 s VP8 clip, recorded from a canvas ---- */
    const rec = await ctx.newPage();
    const b64 = await rec.evaluate(async () => {
      const c = document.createElement('canvas'); c.width = 320; c.height = 180;
      const g = c.getContext('2d');
      const r = new MediaRecorder(c.captureStream(30), { mimeType: 'video/webm;codecs=vp8' });
      const parts = [];
      r.ondataavailable = (e) => parts.push(e.data);
      let f = 0;
      const t = setInterval(() => { g.fillStyle = 'hsl(' + (f++ * 7) + ',70%,50%)'; g.fillRect(0, 0, 320, 180); }, 33);
      r.start();
      await new Promise((ok) => setTimeout(ok, 2000));
      await new Promise((ok) => { r.onstop = ok; r.stop(); });
      clearInterval(t);
      const buf = await new Blob(parts, { type: 'video/webm' }).arrayBuffer();
      let s = ''; const u = new Uint8Array(buf); for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
      return btoa(s);
    });
    await rec.close();
    const clip = path.join(tmp, 'clip.webm');
    fs.writeFileSync(clip, Buffer.from(b64, 'base64'));
    const clipUrl = 'file:///' + clip.replace(/\\/g, '/');
    const vid = (id) => ({ ok: true, reason: '', paused: false, unload: false, item: { id, title: id, type: 'video', url: clipUrl, look: { fit: 'cover', filter: '', rate: 1 }, props: [] } });

    await ctx.addInitScript(FAKE);
    if (BASE) await ctx.route(/\/ui\/desktop\/desktop\.js(\?.*)?$/, (route) => route.fulfill({ path: path.join(BASE, 'ui', 'desktop', 'desktop.js') }));
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(PAGE, { waitUntil: 'load' });
    const emit = (n, p) => page.evaluate(([a, b]) => window.__emit(a, b), [n, p]);
    const statuses = (id) => page.evaluate((x) => window.__calls.filter((c) => c[0] === 'wallpaper.status' && c[1].id === x).map((c) => c[1]), id);
    const wallKids = () => page.evaluate(() => document.getElementById('wall').children.length);

    /* ---- a picture ---- */
    await emit('wallpaper', pic('p1', PNG_A));
    await page.waitForTimeout(150);
    const sp = (await statuses('p1')).map((x) => x.state).join();
    check('picture: mounts and reports loading then playing', sp === 'loading,playing', sp);

    /* ---- a video, pause, resume ---- */
    await emit('wallpaper', vid('v1'));
    await page.waitForFunction(() => window.__calls.some((c) => c[0] === 'wallpaper.status' && c[1].id === 'v1' && c[1].state === 'playing'), null, { timeout: 8000 }).catch(() => {});
    const v = await page.evaluate(() => { const e = document.querySelector('#wall video'); return e ? { muted: e.muted, loop: e.loop, paused: e.paused } : null; });
    check('video: mounts muted and looping, and plays', v && v.muted && v.loop && !v.paused, JSON.stringify(v));
    await emit('wallpaper.pause', { paused: true, unload: false, reason: 'x' });
    check('pause: the video stops', await page.evaluate(() => document.querySelector('#wall video').paused));
    await emit('wallpaper.pause', { paused: false, unload: false, reason: 'x' });
    await page.waitForTimeout(200);
    check('resume: it plays again', await page.evaluate(() => !document.querySelector('#wall video').paused));

    /* ---- a game: unload, then wake ---- */
    await emit('wallpaper.pause', { paused: true, unload: true, reason: 'resting' });
    check('game rest: the wallpaper is taken off the page', (await wallKids()) === 0);
    await emit('wallpaper.pause', { paused: false, unload: false, reason: 'playing' });
    await page.waitForTimeout(300);
    check('wake: the same wallpaper is mounted again', await page.evaluate(() => !!document.querySelector('#wall video')));

    /* ---- the graphics side restarts under a playing video ---- */
    await page.waitForFunction(() => { const e = document.querySelector('#wall video'); return e && e.readyState >= 2; }, null, { timeout: 8000 }).catch(() => {});
    const before = (await statuses('v1')).length;
    await page.evaluate(() => document.querySelector('#wall video').dispatchEvent(new Event('error')));
    await page.waitForTimeout(1900);
    const after = (await statuses('v1')).slice(before).map((x) => x.state);
    check('decoder lost after playing: mounted again once, not reported as broken', after[0] === 'loading' && !after.includes('error') && await page.evaluate(() => !!document.querySelector('#wall video')), after.join());
    await page.waitForFunction(() => { const e = document.querySelector('#wall video'); return e && e.readyState >= 2; }, null, { timeout: 8000 }).catch(() => {});
    await page.evaluate(() => document.querySelector('#wall video').dispatchEvent(new Event('error')));
    await page.waitForTimeout(300);
    const err = (await statuses('v1')).filter((x) => x.state === 'error').pop();
    check('a second error is reported, in plain words', !!err && !/Chromium|codec|undefined|null/.test(err.reason), err && err.reason);

    /* ---- 300 switches: no pile-up ---- */
    const cdp = await ctx.newCDPSession(page);
    const heap = async () => { await cdp.send('HeapProfiler.collectGarbage'); await page.waitForTimeout(100); return (await cdp.send('Runtime.getHeapUsage')).usedSize; };
    const flip = async (n, from) => { for (let i = 0; i < n; i++) { const k = from + i; await emit('wallpaper', k % 3 === 0 ? vid('sv' + k) : pic('sp' + k, k % 2 ? PNG_A : PNG_B)); } };
    await flip(60, 0);
    await page.waitForTimeout(400);
    const h1 = await heap();
    const t1 = await page.evaluate(() => window.__pending());
    await flip(240, 60);
    await page.waitForTimeout(400);
    const h2 = await heap();
    const t2 = await page.evaluate(() => window.__pending());
    check('switching 300 times leaves one wallpaper element', (await wallKids()) === 1, await wallKids());
    check('switching 300 times does not pile up timers', t2 <= t1 + 3, `${t1} -> ${t2}`);
    check('switching 300 times keeps the heap flat (< 1.5 MB growth)', h2 - h1 < 1.5 * 1048576, `${(h1 / 1048576).toFixed(2)} -> ${(h2 / 1048576).toFixed(2)} MB`);
    console.log(`  measured: heap ${(h1 / 1048576).toFixed(2)} -> ${(h2 / 1048576).toFixed(2)} MB over 240 more switches; pending timers ${t1} -> ${t2}`);
    check('page: no script errors', !errors.length, errors.join(' | '));
  } finally {
    await browser.close();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* the temp cleaner gets it */ }
  }
}

run().catch((err) => failures.push('crashed: ' + (err && err.message ? err.message.split('\n')[0] : err))).finally(() => {
  for (const f of failures) console.log('  FAIL ' + f);
  console.log(`WALL PLAYER TEST${BASE ? ' (against base)' : ''}: ${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
});

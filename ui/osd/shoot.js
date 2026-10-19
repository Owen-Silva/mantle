/* shoot.js - headless screenshots of the volume/brightness pop-up and its per-app panel, over the
 * mock bridge (ui/osd/mock-mantle.js), plus the checks a picture cannot make: the fade timing,
 * hover holding it up, a refused change springing back with its reason, and text contrast over a
 * black AND a white desktop (the pop-up has no backdrop blur to lean on).
 *
 * LINE 1 is not optional (see ui/bar/shoot.js): lowcpu.js pins this process and its browser.
 *
 *   node ui/osd/shoot.js                 every shot   (ONLY=vol,exp to pick by name prefix)
 *   MANTLE_SHOOT_OUT=<dir>               where the PNGs go (default %TEMP%\mantle-osd\shots)
 */
require('../../tools/dev-env.js').lowcpu();

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const { chromium } = require('../../tools/dev-env.js').playwright();

const PAGE = 'file:///' + path.join(__dirname, 'index.html').replace(/\\/g, '/');   // this checkout's page
const OUT = process.env.MANTLE_SHOOT_OUT || path.join(os.tmpdir(), 'mantle-osd', 'shots');
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null;

const W = 440, H = 560;
const SHOTS = [
  { name: 'vol-62', q: 'level=62' },
  { name: 'vol-62-dark', q: 'level=62&bg=dark' },
  { name: 'vol-62-light', q: 'level=62&bg=light' },
  { name: 'vol-100', q: 'level=100' },
  { name: 'vol-muted', q: 'level=38&muted=1' },
  { name: 'vol-0', q: 'level=0' },
  { name: 'vol-dead', q: 'dead=1' },
  { name: 'bright-70', q: 'kind=brightness&level=70' },
  { name: 'bright-20-dark', q: 'kind=brightness&level=20&bg=dark' },
  { name: 'bright-dead', q: 'kind=brightness&dead=1' },
  { name: 'exp-3', q: 'expand=1&apps=3', wait: 250 },
  { name: 'exp-6', q: 'expand=1&apps=6', wait: 250 },
  { name: 'exp-9-scroll', q: 'expand=1&apps=9', wait: 250 },
  { name: 'exp-6-dark', q: 'expand=1&apps=6&bg=dark', wait: 250 },
  { name: 'exp-0', q: 'expand=1&apps=0', wait: 250 },
  { name: 'exp-error', q: 'expand=1&apps=error', wait: 250 },
  { name: 'exp-muted-master', q: 'expand=1&apps=3&muted=1', wait: 250 },
  { name: 'exp-refused', q: 'expand=1&apps=3&refuse=1', wait: 250, steps: [{ click: '.app:nth-child(1) .amute' }, { wait: 150 }] },
  { name: 'exp-below', q: 'expand=1&apps=3&below=1', wait: 250 },
  { name: 'chevron-open', q: 'apps=3', wait: 100, steps: [{ click: '#more' }, { wait: 200 }] },
];

const CONTRAST = async (b64) => {
  const img = new Image();
  img.src = 'data:image/png;base64,' + b64;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0);
  const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const out = [];
  const els = Array.from(document.querySelectorAll('.num, .aname, .aval, .dev, .ptitle, .why, .aerr, .state b'))
    .filter((e) => e.textContent.trim() && e.getClientRects().length);
  for (const e of els) {
    const r = e.getBoundingClientRect();
    const x0 = Math.max(0, Math.floor(r.left)), y0 = Math.max(0, Math.floor(r.top));
    const x1 = Math.min(c.width, Math.ceil(r.right)), y1 = Math.min(c.height, Math.ceil(r.bottom));
    if (x1 - x0 < 4 || y1 - y0 < 4) continue;
    const hit = document.elementFromPoint((x0 + x1) / 2, (y0 + y1) / 2);
    if (!hit || !(hit === e || e.contains(hit) || hit.contains(e) && hit.closest('.app') === e.closest('.app'))) continue;  // scrolled out of view
    const d = g.getImageData(x0, y0, x1 - x0, y1 - y0).data;
    const L = [];
    for (let i = 0; i < d.length; i += 4) L.push(0.2126 * lin(d[i]) + 0.7152 * lin(d[i + 1]) + 0.0722 * lin(d[i + 2]));
    L.sort((a, b) => a - b);
    const ground = L[Math.floor(L.length * 0.5)];
    const cr = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    const ratio = Math.round(Math.max(cr(L[Math.floor(L.length * 0.01)], ground), cr(L[Math.floor(L.length * 0.99)], ground)) * 10) / 10;
    out.push({ what: `${e.className.split(' ')[0] || e.tagName} "${e.textContent.trim().slice(0, 22)}"`, ratio });
  }
  out.sort((a, b) => a.ratio - b.ratio);
  return { n: out.length, worst: out[0] || null };
};

function gamesRunning() {
  const out = execFileSync('powershell', ['-NoProfile', '-Command',
    // the lanes' own list (scratchpad BRIEF): the Riot CLIENT idling is not a game, VALORANT is
    '@(Get-Process VALORANT*,javaw,Minecraft*,RobloxPlayerBeta -ErrorAction SilentlyContinue).Count'], { encoding: 'utf8' }).trim();
  return out === '0' ? 0 : (Number(out) || 1);
}

(async () => {
  const games = gamesRunning();
  if (games) { console.log(`NOT RUN: ${games} game process(es) are running; screenshots wait.`); process.exit(2); }
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await require('../settings/test-browser.js').launch(chromium, { headless: true });
  let failures = 0;
  const lines = [];
  try {
    for (const s of SHOTS) {
      if (ONLY && !ONLY.some((p) => s.name.startsWith(p))) continue;
      const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
      const page = await ctx.newPage();
      const problems = [];
      page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
      page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') problems.push(`console ${m.type()}: ${m.text()}`); });
      await page.goto(`${PAGE}?${s.q}`, { waitUntil: 'load' });
      await page.hover('body', { position: { x: 2, y: 2 } });  // pointer parked away from the pop-up
      await page.waitForTimeout(120 + (s.wait || 0));
      for (const st of s.steps || []) {
        if (st.click) await page.click(st.click);
        if (st.wait) await page.waitForTimeout(st.wait);
      }
      await page.hover('body', { position: { x: 2, y: 2 } });
      const file = path.join(OUT, s.name + '.png');
      const png = await page.screenshot({ path: file });
      const contrast = await page.evaluate(CONTRAST, png.toString('base64'));
      const probe = await page.evaluate(() => {
        const o = window.__osd.state();
        const box = document.getElementById('osd').getBoundingClientRect();
        return {
          shown: o.shown, open: o.open, kind: o.kind, rows: o.rows.length,
          box: `${Math.round(box.width)}x${Math.round(box.height)}`,
          size: (window.__mock.sizes.slice(-1)[0] || null),
          why: document.getElementById('why').hidden ? null : document.getElementById('why').textContent,
          errs: Array.from(document.querySelectorAll('.aerr')).filter((e) => !e.hidden).map((e) => e.textContent),
          cut: Array.from(document.querySelectorAll('.num')).filter((e) => e.scrollWidth > e.clientWidth + 1).length,
        };
      });
      if (!probe.shown) problems.push('the pop-up is not showing');
      if (contrast.worst && contrast.worst.ratio < 4.5) problems.push(`text under 4.5:1: ${contrast.worst.what} at ${contrast.worst.ratio}:1`);
      if (probe.cut) problems.push('the number is cut off');
      if (s.name === 'exp-refused' && !probe.errs.length) problems.push('a refused mute showed no reason');
      if (problems.length) failures++;
      lines.push(`${problems.length ? 'FAIL' : 'ok  '} ${s.name.padEnd(18)} ${probe.box.padEnd(8)} rows=${probe.rows} contrast>=${contrast.worst ? contrast.worst.ratio : '-'}${probe.why ? ' why="' + probe.why.slice(0, 60) + '"' : ''}${probe.errs.length ? ' err="' + probe.errs[0].slice(0, 60) + '"' : ''}${problems.length ? '\n       ' + problems.join('\n       ') : ''}`);
      await ctx.close();
    }

    // ---- behaviour: the fade, hover holding it, a refused set springing back
    if (!ONLY || ONLY.includes('behave')) {
      const ctx = await browser.newContext({ viewport: { width: W, height: H } });
      const page = await ctx.newPage();
      const t0 = Date.now();
      await page.goto(`${PAGE}?level=50`, { waitUntil: 'load' });
      await page.hover('body', { position: { x: 2, y: 2 } });
      await page.waitForFunction(() => window.__osd && window.__osd.state().shown, null, { timeout: 2000 });
      await page.waitForFunction(() => window.__mock.faded > 0, null, { timeout: 4000 });
      const fadeMs = Date.now() - t0;
      const b1 = fadeMs >= 1500 && fadeMs < 2600;
      lines.push(`${b1 ? 'ok  ' : 'FAIL'} fades by itself ~1.5 s after the key (+ 280 ms fade): ${fadeMs} ms from load`);
      if (!b1) failures++;

      await page.goto(`${PAGE}?level=50`, { waitUntil: 'load' });
      await page.waitForFunction(() => window.__osd.state().shown, null, { timeout: 2000 });
      await page.hover('#pill');
      await page.waitForTimeout(2600);
      const held = await page.evaluate(() => window.__osd.state().shown && window.__mock.faded === 0);
      lines.push(`${held ? 'ok  ' : 'FAIL'} hovering keeps it up (2.6 s under the pointer)`);
      if (!held) failures++;
      await page.hover('body', { position: { x: 2, y: 2 } });
      const t1 = Date.now();
      await page.waitForFunction(() => window.__mock.faded > 0, null, { timeout: 4000 });
      const leaveMs = Date.now() - t1;
      const b2 = leaveMs >= 1400 && leaveMs < 2500;
      lines.push(`${b2 ? 'ok  ' : 'FAIL'} fades ~1.5 s after the pointer leaves: ${leaveMs} ms`);
      if (!b2) failures++;

      await page.goto(`${PAGE}?level=50&refuse=1`, { waitUntil: 'load' });
      await page.waitForFunction(() => window.__osd.state().shown, null, { timeout: 2000 });
      await page.hover('#pill');
      await page.click('#glyph');
      await page.waitForTimeout(150);
      const sprang = await page.evaluate(() => ({ muted: window.__osd.state().st.volume.muted, why: document.getElementById('why').textContent }));
      const b3 = sprang.muted === false && /did not take/.test(sprang.why);
      lines.push(`${b3 ? 'ok  ' : 'FAIL'} a refused mute springs back and says why: muted=${sprang.muted} "${sprang.why.slice(0, 70)}"`);
      if (!b3) failures++;

      await page.goto(`${PAGE}?expand=1&apps=3&churn=1`, { waitUntil: 'load' });
      await page.waitForTimeout(150);
      // over the pill (bottom-anchored, so it stays put as rows are added above it); a row under
      // the pointer is kept on purpose, so the pointer must not end up over one
      await page.hover('#num');
      await page.waitForTimeout(300);
      const before = await page.evaluate(() => window.__osd.state().rows.join());
      await page.waitForTimeout(1900);
      const after = await page.evaluate(() => window.__osd.state().rows.join());
      const b4 = before !== after && after.includes('pid:8801');
      lines.push(`${b4 ? 'ok  ' : 'FAIL'} an app that starts playing appears while the panel is open: ${before} -> ${after}`);
      if (!b4) failures++;
      await page.waitForTimeout(4200);
      const later = await page.evaluate(() => window.__osd.state().rows.join());
      const b5 = !later.includes('pid:4120');
      lines.push(`${b5 ? 'ok  ' : 'FAIL'} ...and one that stopped leaves after the grace period: ${later}`);
      if (!b5) failures++;
      await ctx.close();
    }
  } finally {
    await browser.close();
  }
  lines.forEach((l) => console.log(l));
  console.log(`osd shots: ${lines.length - failures} ok, ${failures} failed -> ${OUT}`);
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('FAILED:', e && e.stack || e); process.exit(1); });

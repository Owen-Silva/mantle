require('C:/Users/user/dev-tools/tools/lowcpu.js');
'use strict';
/*
 * overlap-audit.js - finds the "my hover box covers the next button" class of bug on every Mantle surface
 * (lane overlap, 2026-10-15; Owen: "some stuff like this ... is like overlapping with things make sure you fix
 * this and make sure there isnt any more of this type of thing anywere else").
 *
 *   node tools/overlap-audit.js [--only=bar,launcher] [--theme=light|dark] [--out=<dir>] [--sheets=<dir>]
 *                               [--no-pixels] [--suite] [--list]
 *
 * Every state in tools/overlap-surfaces.js is opened over file:// in headless Chromium with the page's own
 * mock-mantle.js, at its real window size, in light AND dark (<html data-theme> held for the whole run).
 * Then, per state:
 *   1. tools/overlap-probe.js reads the page: controls, their real hit boxes (elementFromPoint), ink (text
 *      runs, icons) and the static checks (ink-overlap, box-overlap, text-clipped, text-spill, sticks-out,
 *      outside-window, hitbox-overlap, covered, target-size). See that file for what each one means.
 *   2. The paint check: every control gets :hover, then :focus + :focus-visible, forced over CDP
 *      (CSS.forcePseudoState; its ancestors get :hover / :focus-within the way a real pointer or keyboard
 *      gives them). The region is captured before, with, and after (the after shot masks anything that
 *      moves on its own, a clock or a meter). Changed pixels outside the control's own box that land on
 *      another control or on ink are a hover-overlap / focus-overlap; a hover highlight that reaches more
 *      than 3 px past the control's real hit box is a hover-bleed (it looks clickable where it is not).
 *   3. Findings not covered by tools/overlap-allow.json (each entry needs a reason) fail the run.
 *
 * Output: <out>/report.json (every finding, every state), <out>/report.txt, <out>/shots/*.png, and with
 * --sheets=<dir> one contact sheet per surface and theme (the states with their findings boxed, then a crop
 * of every finding). The verdict is the line "OVERLAP AUDIT: N passed, M failed" (N/M = states x themes).
 * It runs one headless browser (lowcpu.js on line 1 holds the machine-wide browser lock).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { overlapProbe } = require('./overlap-probe.js');
const SURFACES = require('./overlap-surfaces.js');

const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const opt = (name, dflt) => { const a = argv.find((x) => x === '--' + name || x.startsWith('--' + name + '=')); if (!a) return dflt; return a.includes('=') ? a.slice(a.indexOf('=') + 1) : true; };
const list = (v) => (typeof v === 'string' && v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);
const ONLY = list(opt('only', ''));
const THEMES = list(opt('theme', '')).length ? list(opt('theme', '')) : ['light', 'dark'];
const PIXELS = !opt('no-pixels', false);
const SUITE = !!opt('suite', false);
const STAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const OUT = path.resolve(String(opt('out', path.join(os.tmpdir(), 'mantle-overlap', STAMP))));
const SHEETS = opt('sheets', '') ? path.resolve(String(opt('sheets'))) : '';
const ALLOW_FILE = path.join(__dirname, 'overlap-allow.json');
const PAD = 14;                 // px of context captured round each control group
const THR = 14;                 // a channel difference that counts as paint (0-255)
const MAX_STATES_PER_SURFACE = 48;

// ------------------------------------------------------------------ browser (the page harness's lookup)
const PW_CANDIDATES = ['C:/Users/user/other-app/node_modules/playwright-core', 'C:/Users/user/Downloads/other-app/node_modules/playwright-core', 'playwright-core'];
function chromium() { for (const c of PW_CANDIDATES) { try { return require(c).chromium; } catch (e) { /* next */ } } throw new Error('playwright-core not found. Tried: ' + PW_CANDIDATES.join(', ')); }
function findChrome() {
  const base = 'C:/Users/user/AppData/Local/ms-playwright';
  for (const d of fs.readdirSync(base).filter((n) => n.startsWith('chromium-')).sort().reverse())
    for (const sub of ['chrome-win/chrome.exe', 'chrome-win64/chrome.exe']) { const p = path.join(base, d, sub); if (fs.existsSync(p)) return p; }
  return null;
}

// ------------------------------------------------------------------ PNG decode (8-bit RGB/RGBA, what Chromium writes)
function decodePng(buf) {
  let p = 8, w = 0, h = 0, ct = 0, bd = 0;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), type = buf.toString('latin1', p + 4, p + 8), data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); bd = data[8]; ct = data[9]; if (data[12]) throw new Error('png: interlaced'); }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (bd !== 8 || (ct !== 2 && ct !== 6)) throw new Error('png: unsupported depth/colour ' + bd + '/' + ct);
  const bpp = ct === 6 ? 4 : 3, stride = w * bpp;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const out = Buffer.alloc(w * h * 4);
  let prev = Buffer.alloc(stride), cur = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const base = y * (stride + 1), f = raw[base];
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0, b = prev[x], c = x >= bpp ? prev[x - bpp] : 0;
      let v = raw[base + 1 + x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      cur[x] = v & 255;
    }
    for (let x = 0; x < w; x++) { const o = (y * w + x) * 4; out[o] = cur[x * bpp]; out[o + 1] = cur[x * bpp + 1]; out[o + 2] = cur[x * bpp + 2]; out[o + 3] = bpp === 4 ? cur[x * bpp + 3] : 255; }
    const t = prev; prev = cur; cur = t;
  }
  return { w, h, data: out };
}
const pxDiff = (A, B, i) => Math.max(Math.abs(A.data[i] - B.data[i]), Math.abs(A.data[i + 1] - B.data[i + 1]), Math.abs(A.data[i + 2] - B.data[i + 2]));
function hashRegion(img, x0, y0, x1, y1) {
  let h = 2166136261;
  for (let y = Math.max(0, y0); y < Math.min(img.h, y1); y++) for (let x = Math.max(0, x0); x < Math.min(img.w, x1); x++) {
    const i = (y * img.w + x) * 4;
    h = Math.imul(h ^ (img.data[i] >> 3), 16777619); h = Math.imul(h ^ (img.data[i + 1] >> 3), 16777619); h = Math.imul(h ^ (img.data[i + 2] >> 3), 16777619);
  }
  return (h >>> 0).toString(36);
}

// ------------------------------------------------------------------ allow list
let ALLOW = [];
try { ALLOW = JSON.parse(fs.readFileSync(ALLOW_FILE, 'utf8')); } catch (e) { if (fs.existsSync(ALLOW_FILE)) { console.log('  FAIL tools/overlap-allow.json does not parse: ' + e.message); process.exitCode = 1; } }
for (const a of ALLOW) if (!a.reason || a.reason.length < 12) { console.log('  FAIL allow entry without a real reason: ' + JSON.stringify(a)); process.exitCode = 1; }
const keyOf = (f) => f.kind + ' | ' + f.el + (f.other ? ' | ' + f.other : '');
function allowed(surface, state, f) {
  const k = keyOf(f);
  return ALLOW.find((a) => (!a.surface || a.surface === surface) && (!a.state || a.state === state) && (!a.kind || a.kind === f.kind) &&
    (!a.el || f.el.includes(a.el)) && (!a.other || (f.other || '').includes(a.other)) && (!a.match || k.includes(a.match)));
}
const INFO = new Set(['target-small', 'focus-invisible']);   // reported, listed, not gating

// ------------------------------------------------------------------ the theme, held before first paint
function themeInit(theme) {
  /* <html data-theme> set the moment the parser makes it, re-set if the page's own theme plumbing changes it,
     and the 'mantle-theme' event fired the way the preload fires it */
  const put = () => { const el = document.documentElement; if (!el) return false; if (el.dataset.theme !== theme) el.dataset.theme = theme; return true; };
  const hold = () => new MutationObserver(() => put()).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  if (put()) hold(); else { const mo = new MutationObserver(() => { if (put()) { mo.disconnect(); hold(); } }); mo.observe(document, { childList: true }); }
  const fire = () => window.dispatchEvent(new CustomEvent('mantle-theme', { detail: { theme } }));
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fire, { once: true }); else fire();
  window.__MOCK_CALLS__ = window.__MOCK_CALLS__ || [];
}
const FREEZE = '*, *::before, *::after { transition-duration: 0s !important; transition-delay: 0s !important; animation-duration: 0s !important; animation-delay: 0s !important; animation-iteration-count: 1 !important; caret-color: transparent !important; }';

// ------------------------------------------------------------------ helpers
const fileUrl = (rel) => 'file:///' + path.join(ROOT, rel).replace(/\\/g, '/');
const safe = (s) => String(s).replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
const inter = (a, b) => { const l = Math.max(a.l, b.l), t = Math.max(a.t, b.t), r = Math.min(a.r, b.r), bb = Math.min(a.b, b.b); return r > l && bb > t ? { l, t, r, b: bb } : null; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runSteps(page, steps) {
  for (const s of steps || []) {
    if (typeof s === 'string') { await page.click(s, { timeout: 4000 }); await page.waitForTimeout(250); }
    else if (s.wait) await page.waitForTimeout(s.wait);
    else if (s.js) { await page.evaluate(s.js); await page.waitForTimeout(100); }
    else if (s.fill) { await page.fill(s.fill, s.text, { timeout: 4000 }); await page.waitForTimeout(200); }
    else if (s.type) { await page.keyboard.type(s.type, { delay: 20 }); await page.waitForTimeout(200); }
    else if (s.key) { await page.keyboard.press(s.key); await page.waitForTimeout(150); }
    else if (s.scroll) { await page.$eval(s.scroll, (e) => { e.scrollTop = e.scrollHeight; }); await page.waitForTimeout(150); }
  }
}

// ------------------------------------------------------------------ the paint check (hover / focus) over CDP
const shotCache = new Map();    // key -> findings (the same control, same pixels, same theme: checked once)
async function paintCheck(page, cdp, probe, ctx) {
  const findings = [];
  const { root } = await cdp.send('DOM.getDocument', { depth: 0 });
  const { nodeIds } = await cdp.send('DOM.querySelectorAll', { nodeId: root.nodeId, selector: '[data-ovn]' });
  if (nodeIds.length !== probe.nodes) return { findings, note: 'the page changed between the probe and the paint check (' + nodeIds.length + ' vs ' + probe.nodes + ' nodes): paint check skipped' };
  const VW = probe.vw, VH = probe.vh;
  const byOvn = new Map(probe.items.map((r) => [r.ovn, r]));
  const force = async (ovn, classes) => { try { await cdp.send('CSS.forcePseudoState', { nodeId: nodeIds[ovn], forcedPseudoClasses: classes }); return true; } catch (e) { return false; } };
  const capture = async (clip) => {
    const r = await cdp.send('Page.captureScreenshot', { format: 'png', clip: { x: clip.l, y: clip.t, width: clip.r - clip.l, height: clip.b - clip.t, scale: 1 }, captureBeyondViewport: false });
    const buf = Buffer.from(r.data, 'base64');
    return { buf, img: decodePng(buf) };
  };
  let shots = 0, reused = 0;
  for (const mode of ['hover', 'focus']) {
    const cand = probe.items.filter((r) => (mode === 'hover' ? r.hittable && !r.disabled : r.focusable && !r.disabled));
    const groups = new Map();
    for (const r of cand) { if (!groups.has(r.parent)) groups.set(r.parent, []); groups.get(r.parent).push(r); }
    for (const [, kids] of groups) {
      const anc = kids[0].anc;
      const ancClass = mode === 'hover' ? ['hover'] : ['focus-within'];
      const own = mode === 'hover' ? ['hover'] : ['focus', 'focus-visible'];
      let clip = null;
      for (const k of kids) { const v = { l: k.v.l - PAD, t: k.v.t - PAD, r: k.v.r + PAD, b: k.v.b + PAD }; clip = clip ? { l: Math.min(clip.l, v.l), t: Math.min(clip.t, v.t), r: Math.max(clip.r, v.r), b: Math.max(clip.b, v.b) } : v; }
      clip = { l: Math.max(0, Math.floor(clip.l)), t: Math.max(0, Math.floor(clip.t)), r: Math.min(VW, Math.ceil(clip.r)), b: Math.min(VH, Math.ceil(clip.b)) };
      if (clip.r - clip.l < 2 || clip.b - clip.t < 2) continue;
      for (const a of anc) await force(a, ancClass);
      const b1 = await capture(clip); shots++;
      const sc = b1.img.w / (clip.r - clip.l);
      const tests = [];
      for (const k of kids) {
        const x0 = Math.floor((k.v.l - clip.l - 6) * sc), y0 = Math.floor((k.v.t - clip.t - 6) * sc), x1 = Math.ceil((k.v.r - clip.l + 6) * sc), y1 = Math.ceil((k.v.b - clip.t + 6) * sc);
        const ck = [ctx.page, ctx.theme, mode, k.desc, k.label, Math.round(k.v.r - k.v.l), Math.round(k.v.b - k.v.t), hashRegion(b1.img, x0, y0, x1, y1)].join('|');
        if (shotCache.has(ck)) { reused++; for (const f of shotCache.get(ck)) findings.push(Object.assign({}, f, { reused: true })); continue; }
        if (!(await force(k.ovn, own))) continue;
        const t = await capture(clip); shots++;
        await force(k.ovn, []);
        tests.push({ k, t, ck });
      }
      const b2 = tests.length ? await capture(clip) : null; if (b2) shots++;
      for (const { k, t, ck } of tests) {
        let got = analyse(mode, k, t, b1.img, b2.img, clip, sc, probe, byOvn);
        const gated = got.filter((f) => f.kind !== 'focus-invisible');
        if (gated.length) {
          /* confirm it: the state on and off again, back to back. Only paint that shows up BOTH times is the
             control's own (a ticking clock or a meter can change between two shots once, not twice alike) */
          await force(k.ovn, own); const t2 = await capture(clip); await force(k.ovn, []); const b3 = await capture(clip); shots += 2;
          const again = new Set(analyse(mode, k, t2, b3.img, null, clip, sc, probe, byOvn).map((f) => f.kind + '|' + (f.other || '')));
          got = got.filter((f) => f.kind === 'focus-invisible' || again.has(f.kind + '|' + (f.other || '')));
        }
        for (const f of got) {
          f.crop = { file: path.join(ctx.cropDir, safe(ctx.id + '-' + mode + '-' + k.ovn) + '.png'), clip };
          fs.writeFileSync(f.crop.file, t.buf);
        }
        shotCache.set(ck, got);
        findings.push(...got);
      }
      for (const a of anc) await force(a, []);
    }
  }
  return { findings, note: shots + ' captures, ' + reused + ' controls reused from an identical earlier state' };
}

function analyse(mode, k, t, B, N, clip, sc, probe, byOvn) {
  const T = t.img;
  if (T.w !== B.w || T.h !== B.h) return [];
  const own = { l: k.r.l - 1, t: k.r.t - 1, r: k.r.r + 1, b: k.r.b + 1 };
  const ancSet = new Set(k.anc);
  // neighbours: other controls (not this one's ancestors or descendants) and ink not inside this control
  const nb = [];
  for (const o of probe.items) {
    if (o.ovn === k.ovn || ancSet.has(o.ovn) || o.anc.includes(k.ovn)) continue;
    const vb = inter(o.v, clip); if (vb) nb.push({ box: vb, desc: o.desc, label: o.label, n: 0, ctl: true });
  }
  for (const i of probe.ink) {
    if (i.owner === k.ovn || i.inside.includes(k.ovn)) continue;
    const vb = inter(i.box, clip); if (vb) nb.push({ box: vb, desc: i.ownerDesc, label: i.text, n: 0, ctl: false });
  }
  let hl = null, changed = 0;
  for (let y = 0; y < T.h; y++) for (let x = 0; x < T.w; x++) {
    const i = (y * T.w + x) * 4;
    if (pxDiff(T, B, i) <= THR) continue;
    if (N && pxDiff(N, B, i) > THR / 2) continue;          // it moved on its own between the two baselines
    changed++;
    const cx = clip.l + (x + 0.5) / sc, cy = clip.t + (y + 0.5) / sc;
    hl = hl ? { l: Math.min(hl.l, cx), t: Math.min(hl.t, cy), r: Math.max(hl.r, cx), b: Math.max(hl.b, cy) } : { l: cx, t: cy, r: cx, b: cy };
    if (cx >= own.l && cx <= own.r && cy >= own.t && cy <= own.b) continue;
    for (const o of nb) if (cx >= o.box.l && cx <= o.box.r && cy >= o.box.t && cy <= o.box.b) o.n++;
  }
  const out = [];
  const seen = new Set();
  for (const o of nb) {
    const a = o.n / (sc * sc);
    if (a < 8 || seen.has(o.desc)) continue;
    seen.add(o.desc);
    out.push({ kind: mode + '-overlap', el: k.desc, label: k.label, other: o.desc, otherLabel: o.label, box: k.r, obox: o.box, hl,
      detail: (mode === 'hover' ? 'the hover paint' : 'the focus ring') + ' covers ' + Math.round(a) + ' px\u00b2 of ' + (o.ctl ? 'the control ' : '') + '"' + (o.label || o.desc) + '"' });
  }
  if (mode === 'focus' && changed === 0) out.push({ kind: 'focus-invisible', el: k.desc, label: k.label, box: k.r, detail: 'keyboard focus changes nothing on screen (no ring, no fill)' });
  if (mode === 'hover' && hl && k.hit) {
    const past = Math.max(k.hit.l - hl.l, k.hit.t - hl.t, hl.r - k.hit.r, hl.b - k.hit.b);
    if (past > 3.5) out.push({ kind: 'hover-bleed', el: k.desc, label: k.label, box: k.hit, obox: hl, hl,
      detail: 'the hover paint reaches ' + Math.round(past) + ' px past the real hit box (' + Math.round(k.hit.r - k.hit.l) + ' x ' + Math.round(k.hit.b - k.hit.t) + ')' });
  }
  return out;
}

// ------------------------------------------------------------------ one state
async function auditState(browser, ctxs, S, st, theme, dirs) {
  const w = st.w, h = st.h, dsf = st.dsf || S.dsf || 1;
  const ck = w + 'x' + h + '@' + dsf + ':' + theme;
  if (!ctxs[ck]) {
    ctxs[ck] = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dsf, colorScheme: theme, bypassCSP: true, reducedMotion: 'reduce' });
    await ctxs[ck].addInitScript(themeInit, theme);
  }
  const page = await ctxs[ck].newPage();
  const id = S.surface + '-' + st.name + '-' + theme;
  const res = { surface: S.surface, state: st.name, theme, w, h, dsf, q: st.q || '', findings: [], errors: [], notes: [] };
  page.on('pageerror', (e) => res.errors.push('pageerror: ' + String(e && e.message || e).slice(0, 200)));
  try {
    await page.goto(fileUrl(S.page) + (st.q || ''), { waitUntil: 'load', timeout: 15000 });
    await page.waitForTimeout(st.settle || S.settle || 600);
    try { await runSteps(page, st.steps); } catch (e) { res.unreachable = 'a step failed: ' + String(e.message || e).split('\n')[0].slice(0, 200); }
    await page.addStyleTag({ content: FREEZE });
    await page.waitForTimeout(120);
    res.shot = path.join(dirs.shots, safe(id) + '.png');
    await page.screenshot({ path: res.shot });
    const probe = await page.evaluate('(' + overlapProbe.toString() + ')({})');
    res.controls = probe.items.length; res.ink = probe.ink.length;
    res.findings.push(...probe.findings);
    if (PIXELS && !res.unreachable) {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
      const pc = await paintCheck(page, cdp, probe, { page: S.page, theme, id, cropDir: dirs.crops });
      res.findings.push(...pc.findings); res.notes.push(pc.note);
      await cdp.detach().catch(() => {});
    }
    if (S.discover && st.first) res.discovered = await page.evaluate(S.discover).catch(() => []);
    if (S.discoverPages) res.discoveredPages = await page.evaluate(S.discoverPages).catch(() => []);
  } catch (e) {
    res.unreachable = res.unreachable || ('the page did not load: ' + String(e.message || e).split('\n')[0].slice(0, 200));
  } finally {
    await page.close().catch(() => {});
  }
  for (const f of res.findings) {
    const a = allowed(S.surface, st.name, f);
    f.key = keyOf(f);
    if (a) f.allowed = a.reason;
    else if (INFO.has(f.kind)) f.info = true;
  }
  return res;
}

/* :focus-visible forcing is what the focus half rests on: prove this Chromium honours it, once, out loud */
async function selfCheck(browser) {
  const ctx = await browser.newContext({ bypassCSP: true });
  const page = await ctx.newPage();
  await page.setContent('<style>#b:focus-visible{outline:5px solid red}#b:hover{background:rgb(1,2,3)}</style><button id="b">x</button>');
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
  const { root } = await cdp.send('DOM.getDocument', { depth: 0 });
  const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#b' });
  await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['hover', 'focus', 'focus-visible'] });
  const got = await page.evaluate(() => { const s = getComputedStyle(document.getElementById('b')); return { ring: s.outlineWidth, bg: s.backgroundColor }; });
  await ctx.close();
  return got.ring === '5px' && got.bg === 'rgb(1, 2, 3)' ? null : 'forced pseudo state not honoured by this Chromium: ' + JSON.stringify(got);
}

// ------------------------------------------------------------------ contact sheets
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
async function writeSheets(browser, results) {
  fs.mkdirSync(SHEETS, { recursive: true });
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 900 }, deviceScaleFactor: 1 });
  const groups = new Map();
  for (const r of results) { const k = r.surface + '-' + r.theme; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
  const written = [];
  for (const [k, rs] of groups) {
    const thumbs = rs.map((r) => {
      const W = Math.min(460, r.w), s = W / r.w, H = Math.round(r.h * s);
      const live = r.findings.filter((f) => !f.allowed && !f.info);
      const boxes = live.map((f) => f.box ? `<div class="bx" style="left:${f.box.l * s}px;top:${f.box.t * s}px;width:${Math.max(2, (f.box.r - f.box.l) * s)}px;height:${Math.max(2, (f.box.b - f.box.t) * s)}px"></div>` : '').join('');
      return `<figure><div class="im" style="width:${W}px;height:${H}px"><img src="${esc(path.relative(SHEETS, r.shot || '').replace(/\\/g, '/'))}" style="width:${W}px;height:${H}px">${boxes}</div>` +
        `<figcaption><b>${esc(r.state)}</b> ${r.w}x${r.h} &middot; ${live.length ? '<span class="bad">' + live.length + ' finding' + (live.length > 1 ? 's' : '') + '</span>' : '<span class="ok">clean</span>'}${r.unreachable ? ' <span class="bad">' + esc(r.unreachable) + '</span>' : ''}</figcaption></figure>`;
    }).join('');
    const seen = new Set();
    const crops = [];
    for (const r of rs) for (const f of r.findings) {
      if (f.allowed || f.info || seen.has(f.key) || crops.length >= 80) continue;
      seen.add(f.key);
      let img = '', c = null, S = 2;
      if (f.crop) { c = f.crop.clip; img = path.relative(SHEETS, f.crop.file).replace(/\\/g, '/'); }
      else if (r.shot && f.box) { const ob = f.obox || f.box; c = { l: Math.max(0, Math.min(f.box.l, ob.l) - 24), t: Math.max(0, Math.min(f.box.t, ob.t) - 24), r: Math.min(r.w, Math.max(f.box.r, ob.r) + 24), b: Math.min(r.h, Math.max(f.box.b, ob.b) + 24) }; img = path.relative(SHEETS, r.shot).replace(/\\/g, '/'); }
      if (!c) continue;
      if ((c.r - c.l) * S > 700) S = 700 / (c.r - c.l);
      const cw = (c.r - c.l) * S, chh = Math.min(420, (c.b - c.t) * S);
      const bx = (b, cls) => b ? `<div class="${cls}" style="left:${(b.l - c.l) * S}px;top:${(b.t - c.t) * S}px;width:${(b.r - b.l) * S}px;height:${(b.b - b.t) * S}px"></div>` : '';
      const full = f.crop ? `width:${cw}px` : `width:${r.w * S}px;left:${-c.l * S}px;top:${-c.t * S}px;position:absolute`;
      crops.push(`<figure class="crop"><div class="im" style="width:${cw}px;height:${chh}px;overflow:hidden"><img src="${esc(img)}" style="${full}">${bx(f.box, 'own')}${bx(f.obox, 'oth')}</div>` +
        `<figcaption><b>${esc(f.kind)}</b> ${esc(r.state)}<br>${esc(f.el)}${f.label ? ' "' + esc(f.label) + '"' : ''}<br><i>${esc(f.detail || '')}</i></figcaption></figure>`);
    }
    const html = `<!doctype html><meta charset="utf-8"><style>
      body{margin:16px;font:12px/1.35 "Segoe UI",system-ui,sans-serif;background:#ececee;color:#1d1d1f}
      h1{font-size:18px;margin:0 0 4px} h2{font-size:14px;margin:18px 0 8px}
      .grid{display:flex;flex-wrap:wrap;gap:12px} figure{margin:0;background:#fff;border-radius:8px;padding:8px;box-shadow:0 1px 3px rgba(0,0,0,.12)}
      .im{position:relative;background:repeating-conic-gradient(#ddd 0 25%,#f6f6f6 0 50%) 0 0/16px 16px} .im img{display:block}
      .bx{position:absolute;border:2px solid #d70022;box-sizing:border-box} .own{position:absolute;border:1.5px solid #0a7cff;box-sizing:border-box}
      .oth{position:absolute;border:1.5px dashed #d70022;box-sizing:border-box} figcaption{margin-top:6px;max-width:700px;word-break:break-word}
      .bad{color:#c4001a;font-weight:600} .ok{color:#127a2e} .crop figcaption{max-width:460px}
    </style><h1>${esc(k)}</h1><div>${rs.length} states &middot; red box = finding; in crops blue = the control, dashed red = what it hits</div>
    <div class="grid">${thumbs}</div><h2>Findings (${crops.length}${seen.size > crops.length ? ' shown' : ''})</h2><div class="grid">${crops.join('') || 'none'}</div>`;
    const hf = path.join(SHEETS, safe(k) + '.html');
    fs.writeFileSync(hf, html);
    const page = await ctx.newPage();
    await page.goto('file:///' + hf.replace(/\\/g, '/'), { waitUntil: 'load' });
    await page.waitForTimeout(150);
    const png = path.join(SHEETS, safe(k) + '.png');
    await page.screenshot({ path: png, fullPage: true });
    await page.close();
    written.push(png);
  }
  await ctx.close();
  return written;
}

// ------------------------------------------------------------------ main
(async () => {
  const surfaces = SURFACES.filter((s) => !ONLY.length || ONLY.some((o) => s.surface === o || s.surface.startsWith(o)));
  if (opt('list', false)) { for (const s of surfaces) console.log(s.surface + ': ' + s.states.map((x) => x.name).join(', ')); return; }
  const dirs = { shots: path.join(OUT, 'shots'), crops: path.join(OUT, 'crops') };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  const exe = findChrome();
  if (!exe) { console.log('  FAIL no ms-playwright chromium on this machine'); console.log('OVERLAP AUDIT: 0 passed, 1 failed'); process.exitCode = 1; return; }
  const browser = await chromium().launch({ headless: true, executablePath: exe });
  const t0 = Date.now();
  const results = [];
  try {
    const bad = await selfCheck(browser);
    if (bad) { console.log('  FAIL ' + bad); results.push({ surface: 'harness', state: 'forcePseudoState', theme: '-', findings: [], unreachable: bad }); }
    for (const S of surfaces) {
      const tS = Date.now();
      const states = S.states.map((x, i) => Object.assign({ first: i === 0 }, x));
      const seenQ = new Set(states.map((x) => x.q));
      for (const theme of THEMES) {
        const ctxs = {};
        for (let i = 0; i < states.length && i < MAX_STATES_PER_SURFACE; i++) {
          const st = states[i];
          const r = await auditState(browser, ctxs, S, st, theme, dirs);
          results.push(r);
          for (const q of [].concat(r.discovered || [], r.discoveredPages || [])) {
            if (seenQ.has(q)) continue;
            seenQ.add(q);
            const base = states[0];
            states.push({ name: q.replace(/^\?/, '').replace(/section=/, '').replace(/&page=/, '.').replace(/[^a-z0-9.]+/gi, '-'), q, w: base.w, h: base.h });
          }
        }
        for (const c of Object.values(ctxs)) await c.close().catch(() => {});
      }
      const rs = results.filter((r) => r.surface === S.surface);
      const live = rs.reduce((n, r) => n + r.findings.filter((f) => !f.allowed && !f.info && !f.reused).length, 0);
      console.log(`  ${S.surface}: ${rs.length} renders, ${live} findings, ${Math.round((Date.now() - tS) / 1000)}s`);
    }
    if (SHEETS) { const w = await writeSheets(browser, results); console.log('  sheets: ' + w.length + ' in ' + SHEETS); }
  } finally {
    await browser.close().catch(() => {});
  }

  // ---------------------------------------------------------------- report
  const uniq = new Map();
  let passed = 0, failed = 0;
  const lines = [];
  for (const r of results) {
    const live = r.findings.filter((f) => !f.allowed && !f.info);
    if (r.unreachable || live.length) failed++; else passed++;
    if (r.unreachable) lines.push('  FAIL ' + r.surface + '/' + r.state + ' (' + r.theme + '): could not reach the state: ' + r.unreachable);
    for (const f of live) {
      const k = r.surface + ' ' + f.key;
      if (!uniq.has(k)) uniq.set(k, { surface: r.surface, f, states: new Set() });
      uniq.get(k).states.add(r.state + '/' + r.theme);
    }
  }
  for (const [, u] of uniq) lines.push('  FAIL ' + u.surface + ': ' + u.f.kind + ' ' + u.f.el + (u.f.label ? ' "' + u.f.label + '"' : '') + ' - ' + (u.f.detail || '') + ' [' + [...u.states].slice(0, 4).join(', ') + (u.states.size > 4 ? ' +' + (u.states.size - 4) : '') + ']');
  const byKind = {};
  for (const [, u] of uniq) byKind[u.f.kind] = (byKind[u.f.kind] || 0) + 1;
  const info = results.reduce((n, r) => n + r.findings.filter((f) => f.info).length, 0);
  const text = lines.join('\n') + '\n  unique findings by kind: ' + JSON.stringify(byKind) + ', info (small but spaced targets): ' + info +
    '\n  ' + results.length + ' renders in ' + Math.round((Date.now() - t0) / 1000) + 's, out ' + OUT + '\nOVERLAP AUDIT: ' + passed + ' passed, ' + failed + ' failed';
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ when: new Date().toISOString(), root: ROOT, themes: THEMES, results, unique: [...uniq.values()].map((u) => Object.assign({ surface: u.surface, states: [...u.states] }, u.f)) }, null, 1));
  fs.writeFileSync(path.join(OUT, 'report.txt'), text + '\n');
  console.log(text);
  process.exitCode = failed ? 1 : (process.exitCode || 0);
})().catch((e) => { console.log('  FAIL the audit crashed: ' + (e && e.stack || e)); console.log('OVERLAP AUDIT: 0 passed, 1 failed'); process.exitCode = 1; });

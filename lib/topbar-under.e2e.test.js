'use strict';
/*
 * topbar-under.e2e.test.js -- the top bar takes the colour of the window under it, in a REAL --test
 * instance (lane mantle-topbar-under, 2026-10-11; lib/topbar-under.js, ui/topbar/under.js).
 *
 * One invisible --test instance (lib/test-quiet.js), profile 'tbunder', LOOK_SYNC_DIR = a fresh temp folder,
 * MANTLE_TOPBAR_UNDER_HOLD=1: main's sampler RUNS (it reads the real row under the bar through the sidecar,
 * read-only) but sends the page nothing, so the page tests below drive the page with their own colours
 * (window.__topbarUnder.apply, the same entry main's 'topbar.under' uses). Through CDP into its own pages:
 *   1. the sampler ran: topbar.status .under has reads, 240 columns at 1920 px, no failure;
 *   2. SPLIT (a white page on the left half, Owen's Quartz top (25,38,41) on the right): the painted canvas's
 *      bottom row IS the columns, the COMPOSITED page (Page.captureScreenshot) matches them within 3 levels
 *      at its bottom row, left items take the dark ink and right ones keep the light ink (computed colour),
 *      every covered item reads >= 4.5:1, no fade: a push is painted (and the inks flipped) in the same task;
 *   3. the desktop under it (off): #under is gone and #bar / #bdrop / the items' computed styles are exactly
 *      the baseline taken before any colour came (today's look);
 *   4. a failure and a capture-blocking window are said (Mantle menu row, strip note);
 *   5. LIGHT: an under payload changes no computed style of any element, nothing is mounted, and the
 *      sampler does not read (its count stands still, its reason says light).
 *   node lib/topbar-under.e2e.test.js   -> "TOPBAR UNDER E2E: n passed, m failed"
 * Needs a sidecar with widgethide.check (e6bfcbb+): when sidecar/bin is older, point MANTLE_SIDECAR_EXE at a
 * fresh build (sidecar/build.ps1 -Out <temp>). Refuses while a game runs. Stopped with tools/kill-test.ps1 -Match tbunder whatever happens.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PROFILE = 'tbunder';
const USER_DATA = path.join(os.tmpdir(), `mantle-test-${PROFILE}`);
const PORT_FILE = path.join(USER_DATA, 'DevToolsActivePort');
const LS_DIR = path.join(os.tmpdir(), 'claude', 'tbunder-e2e', 'ls');

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) passed++;
  else failures.push(name + (detail !== undefined ? ' -- ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 600) : ''));
  return ok;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function gaming() {
  const r = spawnSync('powershell', ['-NoProfile', '-Command', '@(Get-Process javaw,Minecraft*,RobloxPlayerBeta,VALORANT* -ErrorAction SilentlyContinue).Count'], { encoding: 'utf8', timeout: 15000 });
  return (parseInt((r.stdout || '0').trim(), 10) || 0) > 0;
}
async function until(fn, ms, every) {
  const end = Date.now() + ms;
  for (;;) {
    let v; try { v = await fn(); } catch (_) { v = null; }
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(every || 150);
  }
}
const cli = require.resolve('electron/cli.js', { paths: [ROOT] });
const env = Object.assign({}, process.env, { LOOK_SYNC_DIR: LS_DIR, MANTLE_TOPBAR_UNDER_HOLD: '1' });
delete env.MANTLE_TEST_VISIBLE;
delete env.ELECTRON_RUN_AS_NODE;
delete env.MANTLE_TOPBAR_UNDER;

function launch() {
  try { fs.unlinkSync(PORT_FILE); } catch (_) { /* none yet */ }
  const run = { out: '', exited: null };
  run.proc = spawn(process.execPath, [cli, '.', '--test', `--profile-name=${PROFILE}`, '--remote-debugging-port=0'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  run.proc.stdout.on('data', (c) => { run.out += c.toString('utf8'); });
  run.proc.stderr.on('data', (c) => { run.out += c.toString('utf8'); });
  run.proc.on('exit', (code) => { run.exited = { code }; });
  return run;
}
async function targets(port) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  return list.filter((t) => t.type === 'page' && t.url.startsWith('file:') && /\/ui\//.test(t.url));
}
async function attach(t) {
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  let id = 0;
  const pend = new Map();
  ws.addEventListener('message', (m) => {
    const j = JSON.parse(m.data);
    if (j.id && pend.has(j.id)) { const p = pend.get(j.id); pend.delete(j.id); if (j.error) p.rej(new Error(j.error.message)); else p.res(j.result); }
  });
  const send = (method, params) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('page threw: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
    return r.result.value;
  };
  return { ev, send, close: () => { try { ws.close(); } catch (_) { /* gone */ } } };
}
const call = (cmd, arg) => `window.mantle.call(${JSON.stringify(cmd)}, ${JSON.stringify(arg === undefined ? {} : arg)}).then((r) => r, (e) => ({ ok: false, threw: e && e.message ? e.message : String(e) }))`;

const N = 240;
const QUARTZ = [25, 38, 41];
function payload(fn, coverFn) {
  const cols = [], cover = [];
  for (let c = 0; c < N; c++) { cols.push(...fn(c)); cover.push(coverFn ? coverFn(c) : 1); }
  return { cols, cover, n: N, blocked: 0, why: null };
}
const apply = (p) => `(() => { window.__topbarUnder.apply(${JSON.stringify(p)}); return true; })()`;
// the bar's own computed styles, and every item's, keyed (today's look must come back exactly)
const PROPS = ['color', 'background-color', 'background-image', 'box-shadow', 'backdrop-filter', 'isolation', 'opacity', 'display', 'z-index'];
const SNAP = `(() => {
  const P = ${JSON.stringify(PROPS)};
  const one = (el) => { const cs = getComputedStyle(el); return P.map((p) => p + '=' + cs.getPropertyValue(p)).join('|'); };
  const out = { bar: one(document.getElementById('bar')), bdrop: one(document.getElementById('bdrop')), left: one(document.getElementById('left')), right: one(document.getElementById('right')),
    body: document.body.className, under: !!document.getElementById('under'), inkDk: document.querySelectorAll('.ink-dk').length, items: {}, cls: {} };
  for (const el of [...document.getElementById('left').children, ...document.getElementById('right').children]) {
    const k = el.dataset.k ? 'k:' + el.dataset.k : el.dataset.tool ? 't:' + el.dataset.tool : el.dataset.i != null ? 'i:' + el.dataset.i : 'c:' + el.className.split(' ')[0];
    out.items[k] = one(el) + [...el.querySelectorAll('*')].map(one).join('#');
    out.cls[k] = el.className;   // its state (a stat's na/hi/open): the look is compared state for state
  }
  return out;
})()`;
// EVERY element's full computed style (the light proof)
const SNAPALL = `(() => {
  const out = [];
  for (const el of document.querySelectorAll('*')) {
    const cs = getComputedStyle(el); let s = el.tagName + '#' + el.id + '.' + el.className + '{';
    for (let i = 0; i < cs.length; i++) s += cs[i] + ':' + cs.getPropertyValue(cs[i]) + ';';
    out.push(s + '}');
  }
  return out.join('\\n');
})()`;
// the canvases' pixels: bottom row and top row at columns
const CANVAS = (cols) => `(() => {
  const cv = document.querySelectorAll('#under canvas');
  if (cv.length !== 1) return null;
  const pick = (c) => { const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data, w = c.width, h = c.height;
    return ${JSON.stringify(cols)}.map((x) => ({ x, bottom: Array.from(d.slice(((h - 1) * w + x) * 4, ((h - 1) * w + x) * 4 + 4)), top: Array.from(d.slice(x * 4, x * 4 + 4)) })); };
  return { bot: pick(cv[0]), on: [cv[0].classList.contains('on')], trans: getComputedStyle(cv[0]).transitionDuration, op: getComputedStyle(cv[0]).opacity };
})()`;

async function main() {
  if (gaming()) { check('not run: a game is running', false); return; }
  fs.rmSync(LS_DIR, { recursive: true, force: true });
  fs.mkdirSync(LS_DIR, { recursive: true });
  for (const f of ['theme.json', 'look-sync.json']) { try { fs.unlinkSync(path.join(USER_DATA, f)); } catch (_) { /* none */ } }
  const run = launch();
  const open = [];
  try {
    const port = await until(() => { if (run.exited) return null; const s = fs.readFileSync(PORT_FILE, 'utf8').split(/\r?\n/)[0]; return /^\d+$/.test(s) ? s : null; }, 90000, 300);
    if (!check('the --test instance started with a DevTools port', !!port, run.out.slice(-800))) return;
    const tt = await until(async () => (await targets(port)).find((t) => /\/ui\/topbar\/index\.html/.test(t.url)), 90000, 400);
    if (!check('the topbar page is there', !!tt)) return;
    await sleep(2500);
    const top = await attach(tt); open.push(top);
    const theme = await top.ev('document.documentElement.getAttribute(\'data-theme\')');
    if (theme !== 'dark') { await top.ev(call('theme.set', { mode: 'dark' })); await until(() => top.ev('document.documentElement.getAttribute(\'data-theme\') === \'dark\''), 8000); }
    check('the instance is dark', await top.ev('document.documentElement.getAttribute(\'data-theme\')') === 'dark');

    /* 1. the sampler ran on the real row under the bar (read-only, HOLD: nothing sent to the page) */
    const st = await until(async () => { const s = await top.ev(call('topbar.status')); return s && s.under && (s.under.frames >= 3 || s.under.failure) ? s : null; }, 20000, 300);
    const un = st && st.under;
    check('sampler: it read the row under the bar at least 3 times, no failure', !!un && un.frames >= 3 && !un.failure, un);
    check('sampler: 240 columns over the 1920 px bar', !!un && un.n === 240, un && un.n);
    console.log(`info: the real row under the bar: ${un ? Math.round(un.covered * 100) : '?'}% under a window, full=${un && un.full}, blocked=${un && un.blocked}, read in ${un && un.ms} ms, why=${un && un.why}; glass: ${st && st.glass && st.glass.why}`);
    check('page: nothing was pushed to it (HOLD)', await top.ev('!document.getElementById(\'under\')'));

    // the baseline once the stats are live: a stat with no reading yet is "t st na", whose value is in
    // --lg-ink-2, and taking the baseline then compared that against a live value (--lg-ink) later
    // (cpu is enough: mem/gpu/net come in the same stats message; ping has no reading in a test instance)
    await until(() => top.ev('!!document.querySelector(\'#right .st[data-k="cpu"]:not(.na)\')'), 20000, 300);
    const base = await top.ev(SNAP);
    check('baseline: no #under, no .ink-dk', base.under === false && base.inkDk === 0, base);
    console.log('info: baseline stat states: ' + Object.keys(base.cls).filter((k) => /^k:/.test(k)).map((k) => k + '="' + base.cls[k] + '"').join(' '));

    /* 2. SPLIT: white on the left half, Quartz's top on the right */
    const split = payload((c) => (c < 120 ? [255, 255, 255] : QUARTZ));
    await top.ev(apply(split));
    await sleep(450);
    const cv = await top.ev(CANVAS([5, 60, 119, 121, 200, 235]));
    check('paint: #under mounted with one canvas, on and opaque', !!cv && cv.on[0] === true && cv.op === '1', cv && { on: cv.on, op: cv.op });
    const exp = (x) => (x < 120 ? [255, 255, 255] : QUARTZ);
    const bottomExact = !!cv && cv.bot.every((p) => p.bottom[0] === exp(p.x)[0] && p.bottom[1] === exp(p.x)[1] && p.bottom[2] === exp(p.x)[2] && p.bottom[3] === 255);
    check('paint: the canvas\'s bottom row IS the columns (white left, (25,38,41) right), opaque', bottomExact, cv && cv.bot);
    check('paint: no fade: the canvas has no transition', !!cv && /^0s$/.test(cv.trans), cv && cv.trans);
    // IMMEDIATE (Owen: "changes colors faster like imediatly? so theres no delay?"): a push is painted, the
    // canvas opaque and the inks flipped, in the SAME task as the push, before any frame
    const now1 = await top.ev(`(() => { window.__topbarUnder.apply(${JSON.stringify(payload(() => [250, 250, 250]))});
      const c = document.querySelector('#under canvas'), d = c.getContext('2d').getImageData(10, c.height - 1, 1, 1).data;
      const it = [...document.getElementById('left').children, ...document.getElementById('right').children].find((e) => e.offsetWidth > 0);
      return { px: Array.from(d).slice(0, 3), op: getComputedStyle(c).opacity, dk: it.classList.contains('ink-dk'), td: getComputedStyle(it).transitionDuration }; })()`);
    check('paint: immediate: the new colour is in the canvas, opaque, and the ink flipped in the same task (no transition on the ink)', now1.px.join() === '250,250,250' && now1.op === '1' && now1.dk === true && /^0s(, 0s)*$/.test(now1.td), now1);
    await top.ev(apply(split));
    const ink = await top.ev(`(() => { const bar = document.getElementById('bar').getBoundingClientRect(), mid = bar.left + bar.width / 2;
      const els = [...document.getElementById('left').children, ...document.getElementById('right').children].filter((e) => e.offsetWidth > 0);
      const one = (e) => { const r = e.getBoundingClientRect(); return { cls: e.className, side: r.right <= mid ? 'white' : r.left >= mid ? 'dark' : 'both', dk: e.classList.contains('ink-dk'), color: getComputedStyle(e).color }; };
      return { all: els.map(one), items: window.__topbarUnder.plan.items.map((i) => ({ k: i.key, ink: i.ink, r: i.ratio, c: i.covered })) }; })()`);
    const overWhite = ink.all.filter((i) => i.side === 'white'), overDark = ink.all.filter((i) => i.side === 'dark');
    const plain = (i) => !/more|dim|hi|bad|pz|paused|na/.test(i.cls);
    check('ink: every item wholly over the white half has the dark ink', overWhite.length > 0 && overWhite.every((i) => i.dk), overWhite);
    check('ink: every item wholly over the dark half keeps the light ink', overDark.length > 0 && overDark.every((i) => !i.dk), overDark);
    check('ink: computed colour flips per item (white side = the light theme\'s ink #0B0E1A, dark side = the dark theme\'s #ececea)',
      overWhite.filter(plain).every((i) => i.color === 'rgb(11, 14, 26)') && overDark.filter(plain).every((i) => i.color === 'rgb(236, 236, 234)'), ink.all);
    console.log(`info: items: ${ink.all.length} (${overWhite.length} over white, ${overDark.length} over the dark window, ${ink.all.length - overWhite.length - overDark.length} across the seam)`);
    check('ink: every covered item reads >= 4.5:1 on its own fill', ink.items.filter((i) => i.c).every((i) => i.r >= 4.5), ink.items);
    // wait for the colour transitions to end, then photograph the composited page
    await sleep(300);
    const shot = await top.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: await top.ev('document.getElementById(\'bar\').getBoundingClientRect().width'), height: 28, scale: 1 } });
    const comp = await top.ev(`(async () => { const im = new Image(); im.src = 'data:image/png;base64,${'${'}SHOT}'; await im.decode();
      const c = document.createElement('canvas'); c.width = im.naturalWidth; c.height = im.naturalHeight; const g = c.getContext('2d'); g.drawImage(im, 0, 0);
      const w = c.width, h = c.height, row = (y, fx) => Array.from(g.getImageData(Math.round(fx * (w - 1)), y, 1, 1).data);
      return { w, h, pts: [0.10, 0.25, 0.40, 0.60, 0.85, 0.95].map((fx) => ({ fx, bottom: row(h - 1, fx) })) }; })()`.replace('${SHOT}', shot.data));
    const within = (a, b, d) => Math.abs(a[0] - b[0]) <= d && Math.abs(a[1] - b[1]) <= d && Math.abs(a[2] - b[2]) <= d;
    const compOk = comp.pts.every((p) => within(p.bottom, p.fx < 0.5 ? [255, 255, 255] : QUARTZ, 3));
    check('composited: the page\'s bottom row matches the columns within 3 levels at 6 x positions', compOk, comp);
    console.log('info: composited bottom row ' + comp.w + 'x' + comp.h + ': ' + comp.pts.map((p) => `${Math.round(p.fx * 100)}%=(${p.bottom.slice(0, 3).join(',')})`).join(' '));

    /* 2b. flat white, then a mid grey (the pull), then flat Quartz */
    await top.ev(apply(payload(() => [255, 255, 255])));
    await sleep(450);
    const allDk = await top.ev('[...document.getElementById(\'left\').children, ...document.getElementById(\'right\').children].filter((e) => e.offsetWidth > 0).every((e) => e.classList.contains(\'ink-dk\'))');
    check('ink: a white window under the whole bar: every item dark ink', allDk);
    await top.ev(apply(payload(() => [128, 128, 128])));
    await sleep(450);
    const mid = await top.ev(CANVAS([60, 200]));
    const midPlan = await top.ev('window.__topbarUnder.plan.items.filter((i) => i.covered).map((i) => i.ratio)');
    check('mid grey: bottom row exact (128), the text band pulled, every item >= 4.5:1', mid.bot.every((p) => p.bottom[0] === 128 && p.top[0] !== 128) && midPlan.every((r) => r >= 4.5), { mid: mid.bot, midPlan });
    await top.ev(apply(payload(() => QUARTZ)));
    await sleep(450);
    const q = await top.ev(CANVAS([60, 200]));
    const noDk = await top.ev('document.querySelectorAll(\'.ink-dk\').length === 0');
    check('Quartz\'s top under the whole bar: the whole bar is (25,38,41) top to bottom, light ink', q.bot.every((p) => p.bottom.slice(0, 3).join() === '25,38,41' && p.top.slice(0, 3).join() === '25,38,41') && noDk, q.bot);

    /* 3. the desktop under it: today's look, exactly */
    await top.ev(apply({ off: true, why: 'only the desktop is under the top bar', failure: false, blocked: 0, keep: false }));
    await sleep(500);
    const after = await top.ev(SNAP);
    check('desktop: #under unmounted, body.under gone, no .ink-dk', after.under === false && !/\bunder\b/.test(after.body) && after.inkDk === 0, after);
    check('desktop: #bar, #bdrop, #left, #right computed styles are the baseline\'s', after.bar === base.bar && after.bdrop === base.bdrop && after.left === base.left && after.right === base.right, { base: base.bar, after: after.bar });
    // state for state: an item whose own state changed meanwhile (a stat going warn, a reading lost) is
    // said, not compared; at most one may change, the rest must be the baseline's exactly
    const both = Object.keys(base.items).filter((k) => k in after.items);
    const moved = both.filter((k) => base.cls[k] !== after.cls[k]);
    const same = both.filter((k) => base.cls[k] === after.cls[k]);
    if (moved.length) console.log('info: items whose state changed meanwhile (not compared): ' + moved.map((k) => `${k} "${base.cls[k]}" -> "${after.cls[k]}"`).join(', '));
    const sameItems = same.every((k) => base.items[k] === after.items[k]);
    const diff = same.filter((k) => base.items[k] !== after.items[k]).map((k) => {
      const a = base.items[k].split(/[|#]/), b = after.items[k].split(/[|#]/), i = a.findIndex((x, j) => x !== b[j]);
      return `${k} (${after.cls[k]}): ${a[i]} -> ${b[i]}`;
    });
    check('desktop: every item\'s computed styles (and its children\'s) are the baseline\'s', sameItems && same.length > 0 && moved.length <= 1, { diff, moved });

    /* 4. a failure and a capture-blocking window are said */
    await top.ev(apply({ off: true, why: 'the screen under the top bar could not be read: made up', failure: true, blocked: 0, keep: false }));
    await sleep(200);
    const fl = await top.ev('({ row: (window.TopbarModel.MANTLE_MENU.find((r) => r.under) || null), note: (document.querySelector(\'#right .warn\') || {}).title || null })');
    check('failure: the Mantle menu says it (a bad row) and the strip shows a note', !!fl.row && fl.row.bad === true && /made up/.test(fl.row.text) && /Top bar colour: .*made up/.test(fl.note || ''), fl);
    await top.ev(apply({ off: true, why: 'a window under the top bar reads as solid black, which is how a window that blocks screen capture looks, so the bar keeps its own look there', failure: false, blocked: 240, keep: false }));
    await sleep(200);
    const pr = await top.ev('(window.TopbarModel.MANTLE_MENU.find((r) => r.under) || null)');
    check('protected: the Mantle menu says why (not as a fault)', !!pr && pr.bad === false && /blocks screen capture/.test(pr.text), pr);
    await top.ev(apply(payload(() => QUARTZ)));
    await sleep(300);
    check('protected: cleared when a readable window is back', await top.ev('!window.TopbarModel.MANTLE_MENU.some((r) => r.under)'));

    /* 5. LIGHT: nothing changes, nothing runs */
    await top.ev(apply({ off: true, why: 'only the desktop is under the top bar', failure: false, blocked: 0, keep: false }));
    await top.ev(call('theme.set', { mode: 'light' }));
    const lit = await until(() => top.ev('document.documentElement.getAttribute(\'data-theme\') !== \'dark\''), 8000);
    check('light: the instance switched to light', !!lit);
    await sleep(1200);
    // the failure note from step 4 lives 8 s: let it go first, so the element set is the same in both snapshots
    await until(() => top.ev('!document.querySelector("#right .warn")'), 12000, 250);
    const s1 = await top.ev(call('topbar.status'));
    const l0 = await top.ev(SNAPALL);
    await top.ev(apply(split));
    await sleep(500);
    const l1 = await top.ev(SNAPALL);
    check('light: an under payload changes no computed style of any element, and mounts nothing', l0 === l1 && await top.ev('!document.getElementById(\'under\') && !document.body.classList.contains(\'under\')'), l0.length + ' vs ' + l1.length);
    await sleep(2000);
    const s2 = await top.ev(call('topbar.status'));
    check('light: the sampler does not read (its count stands still) and says why', s1.under.frames === s2.under.frames && s2.under.on === false && /light/.test(s2.under.why || ''), { a: s1.under, b: s2.under });
    await top.ev(call('theme.set', { mode: 'dark' }));
  } finally {
    for (const p of open) p.close();
    spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'tools', 'kill-test.ps1'), '-Match', PROFILE], { encoding: 'utf8', timeout: 30000 });
    await until(() => run.exited, 15000, 200);
  }
}
main().catch((e) => check('the run itself', false, e && e.stack ? e.stack : String(e))).then(() => {
  for (const f of failures) console.log('FAIL ' + f);
  console.log(`TOPBAR UNDER E2E: ${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
});

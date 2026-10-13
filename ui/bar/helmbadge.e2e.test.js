'use strict';
/*
 * ui/bar/helmbadge.e2e.test.js - Helm's count on its bar icon, in a real --test bar (lane mn-helmbadge,
 * 2026-10-12).
 *
 * WHAT. One quiet Electron --test instance per theme (light, then dark; invisible: lib/test-quiet.js)
 * with MANTLE_HELM_BADGE_FILE pointing at a TEMP badge.json (never Helm's real file), and a DevTools
 * port into its BAR page only. The file is rewritten the way Helm writes it (badge.json.tmp, then a
 * rename over badge.json) and every check reads the real bar's DOM, through the real feature
 * (lib/helm-badge.js) and the real painter (ui/bar/helmbadge.js, called from bar.js updateCell):
 *   a count appears on Helm's icon, follows each rewrite (with the time it took), turns the warn colour
 *   for an error, caps at "9+", hides at 0, hides when the file's pid is dead, hides with the reason in
 *   the tooltip when the file is unreadable, and comes back after. With --test-dock-extra fillers the
 *   bar also has its "+N" button, so the count is proved beside the overflow. A shot of the badge per
 *   theme goes to %TEMP%\claude\mn-helmbadge (or --shots=<dir>).
 * The Helm item is Owen's real Helm (running or pinned) as the test bar reads it, read-only: the test
 * never clicks it, never touches Helm, never writes Helm's file. Prints no app names.
 *
 *   node ui/bar/helmbadge.e2e.test.js [--shots=<dir>] [--theme=light|dark]
 *
 * One summary line: "helm badge e2e: n passed, m failed".
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const PROFILE = 'mn-helmbadge';
const USER_DATA = path.join(os.tmpdir(), `mantle-test-${PROFILE}`);
const PORT_FILE = path.join(USER_DATA, 'DevToolsActivePort');
const argOf = (k) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : null; };
const SHOTS = argOf('shots') || path.join(os.tmpdir(), 'claude', 'mn-helmbadge');
const THEMES = argOf('theme') ? [argOf('theme')] : ['light', 'dark'];
const BADGE_DIR = path.join(os.tmpdir(), 'claude', 'mn-helmbadge', `badge-${process.pid}`);
const BADGE = path.join(BADGE_DIR, 'badge.json');

let passed = 0;
const failures = [];
const notes = [];
function check(name, ok, detail) {
  if (ok) { passed++; return true; }
  failures.push(detail !== undefined ? `${name} (${typeof detail === 'string' ? detail : JSON.stringify(detail)})` : name);
  return false;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function gaming() {
  const r = spawnSync('powershell', ['-NoProfile', '-Command',
    '@(Get-Process javaw,Minecraft*,RobloxPlayerBeta,VALORANT* -ErrorAction SilentlyContinue).Count'], { encoding: 'utf8', timeout: 15000 });
  return (parseInt((r.stdout || '0').trim(), 10) || 0) > 0;
}

/* Helm's own way (main/atomic.js): a temp file next to it, then a rename over it. */
function writeBadge(body) {
  const tmp = `${BADGE}.tmp`;
  fs.writeFileSync(tmp, typeof body === 'string' ? body : JSON.stringify(Object.assign({ v: 1, updatedAt: Date.now() }, body)));
  fs.renameSync(tmp, BADGE);
}
/* a pid that is certainly dead: a child that has exited */
function deadPid() {
  const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  return parseInt(r.stdout, 10);
}

const cli = require.resolve('electron/cli.js', { paths: [ROOT] });
const env = Object.assign({}, process.env, { MANTLE_HELM_BADGE_FILE: BADGE });
delete env.MANTLE_TEST_VISIBLE;   // a test copy never shows (lib/test-quiet.js)

function launch(theme, extra) {
  try { fs.unlinkSync(PORT_FILE); } catch (_) { /* none yet */ }
  const run = { out: '', exited: null };
  run.proc = spawn(process.execPath, [cli, '.', '--test', `--profile-name=${PROFILE}`, '--remote-debugging-port=0', `--theme=${theme}`].concat(extra ? [`--test-dock-extra=${extra}`] : []),
    { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  run.proc.stdout.on('data', (c) => { run.out += c.toString('utf8'); });
  run.proc.stderr.on('data', (c) => { run.out += c.toString('utf8'); });
  run.proc.on('exit', (code) => { run.exited = { code }; });
  return run;
}
const second = (args) => spawnSync(process.execPath, [cli, '.', '--test', `--profile-name=${PROFILE}`].concat(args), { cwd: ROOT, env: Object.assign({}, env, { LOWCPU: '0' }), encoding: 'utf8', timeout: 30000 });
async function until(fn, ms, every) {
  const end = Date.now() + ms;
  for (;;) {
    let v;
    try { v = await fn(); } catch (_) { v = null; }
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(every || 150);
  }
}

async function attach(run) {
  const port = await until(() => { if (run.exited) return null; const s = fs.readFileSync(PORT_FILE, 'utf8').split(/\r?\n/)[0]; return /^\d+$/.test(s) ? s : null; }, 90000, 300);
  if (!port) throw new Error('the test instance never wrote its DevTools port');
  const tgt = await until(async () => {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    return list.find((t) => t.type === 'page' && /\/ui\/bar\/index\.html/.test(t.url) && t.url.startsWith('file:'));
  }, 90000, 500);
  if (!tgt) throw new Error('the bar page never showed up in the test instance');
  const ws = new WebSocket(tgt.webSocketDebuggerUrl);
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
  return { send, ev, close: () => { try { ws.close(); } catch (_) { /* gone */ } } };
}

const HELM = `[...document.querySelectorAll('#dock .cell')].find((c) => c._item && /(^|\\\\)helm\\.exe$/i.test(String(c._item.exe || '')))`;
/* What the real bar shows for Helm right now (no names: the tooltip lines after the first only). */
const readHelm = (c) => c.ev(`(() => {
  const b = ${HELM}; if (!b) return null;
  const d = b.querySelector(':scope > .hb-badge');
  const more = document.getElementById('dock-more');
  const md = more && more.querySelector(':scope > .hb-badge');
  const tipLines = String(b._tip || '').split('\\n').slice(1);
  const r = b.getBoundingClientRect(), dr = d && d.getBoundingClientRect(), ind = b.querySelector('.ind'), ir = ind && ind.getBoundingClientRect();
  const cs = d && getComputedStyle(d);
  return { on: b.classList.contains('hb-on'), text: d ? d.textContent : null, warn: !!(d && d.classList.contains('warn')),
    ovf: b.classList.contains('ovf'), fly: !!b._fly, titleHasTip: b._fly || b.title === b._tip || b.title.indexOf(b._tip) === 0,
    count: tipLines.filter((l) => /need/.test(l) || /^Count hidden/.test(l)),
    aria: String(b.getAttribute('aria-label') || '').replace(/^[^,]*/, ''),
    more: more ? { hidden: more.hidden, text: md ? md.textContent : null } : null,
    geo: d && !b.classList.contains('ovf') ? { inCell: dr.left >= r.left - 1 && dr.right <= r.right + 1 && dr.top >= r.top - 1, clearOfLine: !ir || dr.bottom <= ir.top, inView: dr.top >= 0 && dr.bottom <= innerHeight,
      w: Math.round(dr.width), h: Math.round(dr.height), font: cs.fontSize, bg: cs.backgroundColor, fg: cs.color } : null };
})()`);
const holdUp = (c, on) => c.ev(`(() => { clearInterval(window.__hbHold); window.__hbHold = 0;
  ${on ? "window.__hbHold = setInterval(() => window.mantle.call('bar.hover', { inside: true }), 90); window.mantle.call('bar.hover', { inside: true });" : ''}
  return true; })()`);

/* contrast of the disc's text on its fill (both opaque tokens) */
function rgb(s) { const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/.exec(s || ''); return m ? [+m[1], +m[2], +m[3]] : null; }
function lum(c) { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); }
function contrast(a, b) { const x = rgb(a), y = rgb(b); if (!x || !y) return 0; const l1 = lum(x), l2 = lum(y); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); }

async function shot(c, theme, tag) {
  const r = await c.ev(`(() => { const b = ${HELM}; if (!b || b.classList.contains('ovf')) return null; const r = b.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
  if (!r) { notes.push(`${theme}: no shot (Helm's icon is behind "+N")`); return; }
  const pad = 30;
  const clip = { x: Math.max(0, r.x - pad), y: Math.max(0, r.y - 8), width: r.w + pad * 2, height: r.h + 16, scale: 4 };
  try {
    const s = await c.send('Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: false });
    fs.mkdirSync(SHOTS, { recursive: true });
    const f = path.join(SHOTS, `helmbadge-${theme}-${tag}.png`);
    fs.writeFileSync(f, Buffer.from(s.data, 'base64'));
    notes.push(`shot: ${f}`);
  } catch (e) { notes.push(`${theme}: shot failed (${e.message})`); }
}

/* The bar with "+N" (fillers past the room): Helm's count on "+N" when its icon waits behind it, and
   on its tile in the "+N" panel, live. */
async function overflowPass(c, T, alive) {
  const readMore = () => c.ev(`(() => { const m = document.getElementById('dock-more'); if (!m) return null; const d = m.querySelector(':scope > .hb-badge');
    const b = ${HELM}; return { hidden: m.hidden, text: d ? d.textContent : null, warn: !!(d && d.classList.contains('warn')), line: /\\nNeeds you: /.test(m.title), helmOvf: !!(b && b.classList.contains('ovf')) }; })()`);
  let m = await readMore();
  if (!check(T('the "+N" button is on the bar'), m && !m.hidden, m)) return;
  writeBadge({ count: 2, waiting: 1, errors: 1, pid: alive });
  if (m.helmOvf) {
    m = await until(async () => { const x = await readMore(); return x && x.text === '2' ? x : null; }, 5000, 20);
    check(T('Helm behind "+N": the button carries its "2", warn colour, and a "Needs you" line'), !!m && m.warn && m.line, m || await readMore());
  } else {
    const s = await until(async () => { const x = await readHelm(c); return x && x.text === '2' ? x : null; }, 5000, 20);
    m = await readMore();
    check(T('Helm on the strip beside "+N": its disc shows, "+N" carries none'), !!s && m.text === null && !m.line, [s, m]);
    notes.push('+N: Helm stayed on the strip, so the panel tile was not checked live (the vm test covers it)');
    return;
  }
  await c.ev(`document.getElementById('dock-more').click(), true`);
  const TILE = `[...document.querySelectorAll('.ovf-app')].find((t) => t._hbCell === ${HELM})`;
  const tileText = () => c.ev(`(() => { const t = ${TILE}; if (!t) return null; const d = t.querySelector('.hb-wrap > .hb-badge'); return d ? d.textContent : ''; })()`);
  let t = await until(async () => { const x = await tileText(); return x === '2' ? x : null; }, 8000, 100);
  check(T('the "+N" panel opens with Helm\'s tile carrying "2"'), t === '2', await tileText());
  writeBadge({ count: 4, waiting: 4, errors: 0, pid: alive });
  t = await until(async () => { const x = await tileText(); return x === '4' ? x : null; }, 5000, 20);
  m = await readMore();
  check(T('a rewrite while the panel is open updates the tile and the button live'), t === '4' && m.text === '4' && !m.warn, [await tileText(), m]);
  try {
    const r = await c.ev(`(() => { const t = ${TILE}; if (!t) return null; const r = t.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
    if (r && r.w) {
      const s = await c.send('Page.captureScreenshot', { format: 'png', clip: { x: Math.max(0, r.x - 6), y: Math.max(0, r.y - 6), width: r.w + 12, height: r.h + 12, scale: 3 } });
      fs.mkdirSync(SHOTS, { recursive: true });
      const f = path.join(SHOTS, 'helmbadge-overflow-tile.png');
      fs.writeFileSync(f, Buffer.from(s.data, 'base64'));
      notes.push(`shot: ${f}`);
    }
  } catch (e) { notes.push(`+N tile shot failed (${e.message})`); }
  writeBadge({ count: 0, waiting: 0, errors: 0, pid: alive });
  m = await until(async () => { const x = await readMore(); return x && x.text === null && !x.line ? x : null; }, 5000, 20);
  check(T('0 clears the "+N" button\'s disc and line'), !!m, await readMore());
}

async function oneTheme(theme, full, extra) {
  const T = (s) => `${theme}${extra ? ' +N' : ''}: ${s}`;
  const alive = process.pid;
  writeBadge({ count: 0, waiting: 0, errors: 0, pid: alive });
  let r = null, c = null;
  try {
    r = launch(theme, extra);
    c = await attach(r);
    const first = await until(() => readHelm(c), 120000, 500);
    if (!check(T('the test bar shows a Helm item (running or pinned)'), !!first, 'is Helm running or pinned on this PC?')) return;
    await holdUp(c, true);
    await sleep(900);   // the reveal has landed: "+N" is judged on the landed bar
    let s = await readHelm(c);
    if (extra) { await overflowPass(c, T, alive); return; }
    check(T('count 0: no disc on Helm\'s icon, no count line'), !s.on && s.text === null && !s.count.length, s);
    if (s.ovf) notes.push(`${theme}: Helm's icon is behind "+N" on this bar; the "+N" button's disc was checked instead`);
    const shown = (st) => (st.ovf ? st.more && st.more.text : st.text);

    // a waiting chat: the number, in the accent, within moments of the rename
    let t0 = Date.now();
    writeBadge({ count: 2, waiting: 2, errors: 0, pid: alive });
    s = await until(async () => { const x = await readHelm(c); return x && shown(x) === '2' ? x : null; }, 5000, 20);
    const ms = Date.now() - t0;
    if (check(T('a rewrite to 2 puts "2" on Helm\'s icon'), !!s, await readHelm(c))) {
      notes.push(`${theme}: file rename -> disc on the bar in ${ms} ms`);
      check(T('it appears quickly (under 1 s; feature settles 120 ms)'), ms < 1000, `${ms} ms`);
      check(T('accent (not warn) with only waiting chats'), s.ovf || !s.warn, s);
      check(T('tooltip says it: "2 need you: 2 waiting"'), s.count.length === 1 && s.count[0] === '2 need you: 2 waiting' && s.titleHasTip, s);
      check(T('aria-label says it'), s.aria === ', 2 need you: 2 waiting', s.aria);
      if (s.geo) {
        check(T('the disc sits inside the cell, above the running line, inside the bar'), s.geo.inCell && s.geo.clearOfLine && s.geo.inView, s.geo);
        check(T('the disc is small and readable (15 px, 10 px digits)'), s.geo.h === 15 && s.geo.w >= 15 && s.geo.w <= 22 && s.geo.font === '10px', s.geo);
        const k = contrast(s.geo.fg, s.geo.bg);
        check(T('digits on the accent disc >= 4.5:1'), k >= 4.5, `${k.toFixed(2)}:1 ${s.geo.fg} on ${s.geo.bg}`);
        notes.push(`${theme}: accent disc ${s.geo.fg} on ${s.geo.bg} = ${k.toFixed(1)}:1`);
      }
      if (s.more && !s.more.hidden && !s.ovf) check(T('"+N" (shown) carries no disc while Helm is on the strip'), s.more.text === null, s.more);
      await shot(c, theme, 'waiting');
    }

    // an error: warn colour, the count includes it
    writeBadge({ count: 3, waiting: 2, errors: 1, pid: alive });
    s = await until(async () => { const x = await readHelm(c); return x && shown(x) === '3' ? x : null; }, 5000, 20);
    if (check(T('a rewrite to 3 (one error) shows "3"'), !!s, await readHelm(c))) {
      check(T('warn colour with an error, tooltip names it'), (s.ovf || s.warn) && s.count[0] === '3 need you: 2 waiting, 1 stopped on an error', s);
      if (s.geo) {
        const k = contrast(s.geo.fg, s.geo.bg);
        check(T('digits on the warn disc >= 4.5:1'), k >= 4.5, `${k.toFixed(2)}:1 ${s.geo.fg} on ${s.geo.bg}`);
        notes.push(`${theme}: warn disc ${s.geo.fg} on ${s.geo.bg} = ${k.toFixed(1)}:1`);
      }
      await shot(c, theme, 'error');
    }
    if (!full) return;

    writeBadge({ count: 12, waiting: 12, errors: 0, pid: alive });
    s = await until(async () => { const x = await readHelm(c); return x && shown(x) === '9+' ? x : null; }, 5000, 20);
    check(T('12 shows "9+" (the tooltip has the real number)'), !!s && s.count[0] === '12 need you: 12 waiting', s || await readHelm(c));
    if (s && s.geo) check(T('"9+" still fits the cell'), s.geo.inCell && s.geo.w <= 22, s.geo);

    writeBadge({ count: 0, waiting: 0, errors: 0, pid: alive });
    s = await until(async () => { const x = await readHelm(c); return x && !x.on && x.text === null && (!x.more || x.more.text === null) ? x : null; }, 5000, 20);
    check(T('a rewrite to 0 hides the disc and the count line'), !!s && !s.count.length && s.aria === '', s || await readHelm(c));

    writeBadge({ count: 2, waiting: 2, errors: 0, pid: alive });
    await until(async () => { const x = await readHelm(c); return x && shown(x) === '2'; }, 5000, 20);
    writeBadge({ count: 2, waiting: 2, errors: 0, pid: deadPid() });
    s = await until(async () => { const x = await readHelm(c); return x && !x.on && shown(x) === null ? x : null; }, 5000, 20);
    check(T('a file whose pid is dead (Helm crashed) hides the count'), !!s && !s.count.length, s || await readHelm(c));

    writeBadge('{"v":1,"count":2,');
    s = await until(async () => { const x = await readHelm(c); return x && !x.on && x.count.length ? x : null; }, 5000, 20);
    check(T('an unreadable file hides the count and says why in the tooltip'), !!s && shown(s) === null && s.count[0] === 'Count hidden: its badge file could not be read' && s.titleHasTip, s || await readHelm(c));

    writeBadge({ count: 1, waiting: 1, errors: 0, pid: alive });
    s = await until(async () => { const x = await readHelm(c); return x && shown(x) === '1' ? x : null; }, 5000, 20);
    check(T('a good file after that brings the count back, reason gone'), !!s && s.count.length === 1 && s.count[0] === '1 needs you: 1 waiting', s || await readHelm(c));

    fs.unlinkSync(BADGE);
    s = await until(async () => { const x = await readHelm(c); return x && !x.on && shown(x) === null ? x : null; }, 5000, 20);
    check(T('the file removed (Helm never ran) = no count, no line'), !!s && !s.count.length, s || await readHelm(c));
  } finally {
    if (c) { try { await holdUp(c, false); } catch (_) { /* gone */ } c.close(); }
    if (r && !r.exited) {
      second(['--quit']);
      await until(() => r.exited, 30000);
    }
    if (r && !r.exited) spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'tools', 'kill-test.ps1'), '-Match', PROFILE], { encoding: 'utf8' });
    if (r) {
      check(T('no uncaught exception or handler failure'), !/uncaught exception|handler threw|unhandled promise rejection/i.test(r.out),
        (r.out.match(/.*(uncaught exception|handler threw|unhandled promise rejection).*/i) || [''])[0]);
      check(T('the feature logged counts without the app\'s name'), !/Helm: \d/.test(r.out));
      check(T('the helmbadge feature came up healthy (no DOWN line)'), !/helmbadge[^\n]*(DOWN|down:|failed)/i.test(r.out), (r.out.match(/.*helmbadge.*/gi) || []).slice(0, 3).join(' | '));
      try { fs.writeFileSync(path.join(os.tmpdir(), 'claude', 'mn-helmbadge', `e2e-${theme}.log`), r.out); } catch (_) { /* best effort */ }
    }
  }
}

async function run() {
  if (gaming()) { check('no game running (not launching an instance)', false); return; }
  fs.mkdirSync(BADGE_DIR, { recursive: true });
  let slot = null;
  for (let wait = 0; wait < 480 && !slot; wait++) {
    for (const n of [1, 2]) {
      const d = path.join(os.tmpdir(), `mantle-slot-${n}`);
      try { fs.mkdirSync(d); slot = d; break; } catch (_) { /* taken */ }
    }
    if (!slot) await sleep(1000);
  }
  if (!check('a test slot was free (mantle-slot-1/2, waited up to 8 min)', !!slot)) return;
  try {
    for (let i = 0; i < THEMES.length; i++) await oneTheme(THEMES[i], i === 0, 0);
    await oneTheme(THEMES[0], false, 20);   // the bar with "+N": fillers past the room
  } finally {
    try { fs.rmdirSync(slot); } catch (_) { /* someone removed it */ }
    try { fs.rmSync(BADGE_DIR, { recursive: true, force: true }); } catch (_) { /* best effort */ }
  }
}

(async () => {
  try { await run(); } catch (e) { check('ran to the end', false, e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e)); }
  for (const n of notes) console.log(`note: ${n}`);
  for (const f of failures) console.log(`FAIL ${f}`);
  console.log(`helm badge e2e: ${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})();

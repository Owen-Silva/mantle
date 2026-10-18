'use strict';
/*
 * barhover.e2e.test.js -- THE BAR'S HOVER BAND through the real main.js hoverTick (lane mantle-barhover,
 * 2026-10-17). Owen: "i can hold my mouse a lot of pixels above it without it going away like a lot".
 *
 * One invisible --test --test-live-bar instance (the hover-mode bar: the tall window and its shaped
 * region, lib/test-quiet.js keeps it off the screen) started with MANTLE_BAR_TEST_CURSOR=1, so its hover
 * poll reads a STAND-IN cursor that this test moves with bar.testCursor {x, y} (DIP); Owen's real
 * cursor is never read, moved or clicked. For each state the cursor reveals the bar at the screen
 * edge, settles in the pill, then rests at a point and the test times when the hide starts:
 *   hidden          a cursor above or on the hidden pill's place never reveals it (only the edge does)
 *   revealed        the pill + 8 DIP keeps it; 9..28 DIP above goes after ~500 ms; further after ~180 ms
 *   pop-up open     a CLICKED pop-up (the calendar) holds the bar until it closes (the macOS-menu rule:
 *                   click away / Esc / app switch close it); once closed, the band is the pill's again
 *   banner showing  a corner banner (toasts.testShow, no Windows toast) does not widen the band
 *   corner card     the screenshot card's stand-in in the corner (toasts.corner) does not either
 *
 *   node ui/bar/barhover.e2e.test.js          one summary line: "BAR HOVER E2E TEST: n passed, m failed"
 */
try { require('C:/Users/user/dev-tools/tools/lowcpu.js'); } catch (e) { if (process.env.CI !== 'true') throw e; }
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const PROFILE = 'barhovere2e';
const USER_DATA = path.join(os.tmpdir(), `mantle-test-${PROFILE}`);
const PORT_FILE = path.join(USER_DATA, 'DevToolsActivePort');
const KEEP = 8, OVER = 28, OVER_MS = 500, GRACE = 180;
const HOLD_MS = 1600;            // a rest this long with no hide = the bar keeps there

let passed = 0; const failures = []; const notes = [];
function check(name, ok, detail) { if (ok) passed++; else failures.push(`${name}${detail !== undefined ? ` (${String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 400)})` : ''}`); return ok; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, step) { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(step || 250); } }
function gaming() {
  try {
    // the games notes/scratch/slot2/game-guard.ps1 counts (the Riot launcher alone is not a game), and its flag
    if (fs.existsSync(path.join(os.tmpdir(), 'claude-heavytest.gaming'))) return 1;
    const n = spawnSync('powershell', ['-NoProfile', '-Command', "@(Get-Process VALORANT*,'League of Legends',FortniteClient*,RocketLeague,cs2,javaw,Minecraft*,RobloxPlayerBeta -ErrorAction SilentlyContinue).Count"], { encoding: 'utf8', windowsHide: true });
    return parseInt((n.stdout || '').trim(), 10) || 0;
  } catch (_) { return -1; }
}

const cli = require.resolve('electron/cli.js', { paths: [ROOT] });
const env = Object.assign({}, process.env, { MANTLE_BAR_TEST_CURSOR: '1' });
delete env.MANTLE_TEST_VISIBLE;   // a test copy never shows (lib/test-quiet.js)
function launch() {
  try { fs.unlinkSync(PORT_FILE); } catch (_) { /* none yet */ }
  const run = { out: '', exited: null };
  run.proc = spawn(process.execPath, [cli, '.', '--test', '--test-live-bar', `--profile-name=${PROFILE}`, '--remote-debugging-port=0'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
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
  let n = 0;
  const pend = new Map();
  ws.addEventListener('message', (m) => {
    const j = JSON.parse(m.data);
    if (j.id && pend.has(j.id)) { const p = pend.get(j.id); pend.delete(j.id); if (j.error) p.rej(new Error(j.error.message)); else p.res(j.result); }
  });
  ws.addEventListener('close', () => { for (const p of pend.values()) p.rej(new Error('the page closed')); pend.clear(); });
  const send = (method, params) => new Promise((res, rej) => { const i = ++n; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params: params || {} })); });
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('page threw: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails.text));
    return r.result.value;
  };
  return { ev, close: () => { try { ws.close(); } catch (_) { /* gone */ } } };
}
const call = (cmd, arg) => `window.mantle.call(${JSON.stringify(cmd)}, ${JSON.stringify(arg === undefined ? {} : arg)}).then((r) => r, (e) => ({ ok: false, threw: e && e.message ? e.message : String(e) }))`;

let skipped = null;
async function main() {
  if (process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true') { skipped = 'on CI: no desktop session for a hover-mode bar'; return; }
  if (process.platform !== 'win32') { skipped = 'Windows only'; return; }
  const g = gaming();
  if (g !== 0) { skipped = g > 0 ? 'a game is running' : 'could not check for a running game'; return; }

  const run = launch();
  let bar = null;
  try {
    const port = await until(() => { try { return parseInt(fs.readFileSync(PORT_FILE, 'utf8').split('\n')[0], 10) || null; } catch (_) { return null; } }, 45000, 250);
    if (!check('the --test instance opens its DevTools port', !!port, run.out.slice(-600))) return;
    const barT = await until(async () => { try { return (await targets(port)).find((t) => /\/ui\/bar\//.test(t.url)) || null; } catch (_) { return null; } }, 30000, 300);
    if (!check('the bar page is up', !!barT, run.out.slice(-600))) return;
    bar = await attach(barT);
    await until(() => bar.ev('!!(window.mantle && window.mantle.call)'), 10000, 200);
    const cur = (x, y) => bar.ev(call('bar.testCursor', x === undefined ? {} : { x, y }));

    const st0 = await until(async () => { const s = await cur(); return s && s.ok && s.rest && s.polling ? s : null; }, 20000, 300);
    if (!check('bar.testCursor answers with the bar\'s rest rect and a running hover poll (MANTLE_BAR_TEST_CURSOR=1)', !!st0, await cur())) return;
    check('the bar is the hover-mode bar: tall window, shaped region (--test-live-bar)', st0.tall === true, st0);
    const S = st0.screen, R = st0.rest;
    const cx = Math.round(R.x + R.width / 2), pillY = R.y + 24, edgeY = S.y + S.height - 1;
    notes.push(`screen ${S.width}x${S.height} DIP, pill rest ${JSON.stringify(R)}`);

    // ---- hidden: nothing but the edge reveals it (the stand-in starts off the screen, so a bar up at start goes)
    const hid = await until(async () => { const v = await cur(); return !v.revealed ? v : null; }, 4000, 100);
    check('hidden: with the stand-in cursor off the screen the bar is (or goes) hidden', !!hid, await cur());
    for (const [what, y] of [['4 DIP above the hidden pill\'s place', R.y - 4], ['on the hidden pill\'s place', pillY]]) {
      await cur(cx, y);
      await sleep(900);
      const s = await cur();
      check(`hidden: a cursor resting ${what} does not reveal the bar`, !s.revealed, s);
    }

    async function reveal() {
      await cur(cx, edgeY);
      let s = await until(async () => { const v = await cur(); return v.up ? v : null; }, 3000, 60);
      if (!s) {   // the sidecar's full-screen check can hold the edge back (Owen's foreground); the page's own report reveals too
        notes.push('one reveal came from bar.hover, not the edge (the edge was held back)');
        await bar.ev(call('bar.hover', { inside: true }));
        s = await until(async () => { const v = await cur(); return v.up ? v : null; }, 3000, 60);
      }
      await cur(cx, pillY);
      await sleep(700);    // the 560 ms entrance
      return !!s && (await cur()).up;
    }
    /** Rest at (x, y) after a reveal: ms until the hide started, or null if the bar stayed HOLD_MS. */
    async function restAt(x, y) {
      if (!(await reveal())) return 'no-reveal';
      await cur(x, y);
      const t0 = Date.now();
      for (;;) {
        const s = await cur();
        if (!s.up) return Date.now() - t0;
        if (Date.now() - t0 >= HOLD_MS) return null;
        await sleep(30);
      }
    }
    const holds = (v) => v === null;
    const overshoot = (v) => typeof v === 'number' && v >= OVER_MS - 40 && v <= OVER_MS + 320;
    const grace = (v) => typeof v === 'number' && v >= GRACE - 40 && v <= GRACE + 320;

    async function sweep(label) {
      const up = {};
      for (const off of [0, 4, KEEP, KEEP + 1, 20, OVER, OVER + 1, 60, 200]) up[off] = await restAt(cx, R.y - off);
      const side = { [KEEP]: await restAt(R.x - KEEP, pillY), [KEEP + 1]: await restAt(R.x - KEEP - 1, pillY) };
      const band = Math.max(...Object.keys(up).map(Number).filter((o) => holds(up[o])));
      notes.push(`${label}: hover band ${band} DIP above the pill; hide starts (ms) by DIP above: ${Object.keys(up).map((o) => `${o}:${up[o] === null ? 'kept' : up[o]}`).join(' ')}; side ${KEEP}:${side[KEEP] === null ? 'kept' : side[KEEP]} ${KEEP + 1}:${side[KEEP + 1] === null ? 'kept' : side[KEEP + 1]}`);
      check(`${label}: the pill and the ${KEEP} DIP above it keep the bar (0, 4, ${KEEP} DIP)`, holds(up[0]) && holds(up[4]) && holds(up[KEEP]), up);
      check(`${label}: the hover band is ${KEEP} DIP above the pill, no more`, band === KEEP, { band, up });
      check(`${label}: resting ${KEEP + 1}..${OVER} DIP above, the hide starts after ~${OVER_MS} ms`, overshoot(up[KEEP + 1]) && overshoot(up[20]) && overshoot(up[OVER]), up);
      check(`${label}: resting ${OVER + 1}+ DIP above, the hide starts after the ~${GRACE} ms grace`, grace(up[OVER + 1]) && grace(up[60]) && grace(up[200]), up);
      check(`${label}: ${KEEP} DIP past the pill's end keeps it, ${KEEP + 1} goes after ~${OVER_MS} ms`, holds(side[KEEP]) && overshoot(side[KEEP + 1]), side);
      return band;
    }

    // ---- revealed, nothing else up
    await sweep('revealed');
    const m = /bar revealed \([^)]*\) -- window .*kept while the cursor is below y (\d+)/.exec(run.out);
    check('the reveal log names the window, the pill and the band (no more "pill" = the window rect)', !!m && Number(m[1]) === R.y - KEEP, m ? m[0].slice(0, 300) : run.out.slice(-300));

    // ---- a clicked pop-up: held while open, the pill's band again once closed
    if (await reveal()) {
      await bar.ev("(function(){ var b = document.getElementById('clock'); if (b) b.click(); return !!b; })()");
      const sp = await until(async () => { const v = await cur(); return v.popover ? v : null; }, 3000, 60);
      if (check('pop-up open: clicking the clock opens its pop-up (barPopover set)', !!sp, await cur())) {
        await cur(cx, R.y - 200);
        await sleep(HOLD_MS);
        const s = await cur();
        check('pop-up open: a CLICKED pop-up holds the bar with the cursor 200 DIP above (closes on click away / Esc, like a macOS menu)', s.up && !!s.popover, s);
        check('pop-up open: the shaped rect is the pill plus the pop-up\'s room', s.rect && s.rect.height === R.height + s.popover.height && s.rect.y === R.y - s.popover.height, { rect: s.rect, popover: s.popover });
        await cur(cx, pillY);
        await bar.ev("(function(){ var b = document.getElementById('clock'); if (b) b.click(); return !!b; })()");
        const sc = await until(async () => { const v = await cur(); return !v.popover ? v : null; }, 3000, 60);
        check('pop-up closed: the room is given back (shaped rect = the pill\'s rest rect)', !!sc && sc.rect && sc.rect.height === R.height && sc.rect.y === R.y, sc);
        const after = await restAt(cx, R.y - 60);
        check('pop-up closed: 60 DIP above hides after the grace again (the room no longer counts)', grace(after), after);
      }
    } else check('pop-up open: the bar reveals', false);

    // ---- a tooltip's room (what ui/shared/tips.js asks main for): kept while the cursor is in the room, and
    //      once the cursor has left it the bar goes after the grace and the room goes with it
    if (await reveal()) {
      const tip = await bar.ev(call('bar.popover', { open: true, height: 58, key: 'tip' }));
      const st = await until(async () => { const v = await cur(); return v.popover && v.popover.kind === 'tip' ? v : null; }, 2000, 60);
      if (check('tooltip: its room is shaped in (bar.popover key tip)', !!st, { tip, now: await cur() })) {
        await cur(cx, R.y - 40);
        await sleep(HOLD_MS);
        const inRoom = await cur();
        check('tooltip: the cursor in the tooltip\'s room (40 DIP above the pill) keeps the bar', inRoom.up, inRoom);
        await cur(cx, R.y - 200);
        const t0 = Date.now();
        const gone = await until(async () => { const v = await cur(); return !v.up ? v : null; }, 3000, 30);
        const ms = Date.now() - t0;
        notes.push(`tooltip: the cursor 200 DIP above, out of the room: the hide started after ${gone ? ms : 'never (3 s)'} ms`);
        check('tooltip: 200 DIP above, out of its room, the bar goes after the grace (a tooltip no longer holds it)', !!gone && grace(ms), { ms, gone });
        const freed = await until(async () => { const v = await cur(); return !v.popover ? v : null; }, 3000, 100);
        check('tooltip: the room goes with the bar (the page, or main\'s 1 s fallback)', !!freed, await cur());
        await sleep(600);
        const after = await cur();
        check('tooltip: the hidden bar stays hidden (a tooltip room never re-reveals it)', !after.revealed, after);
      }
    } else check('tooltip: the bar reveals', false);

    // ---- a corner banner showing
    const tb = await bar.ev(call('toasts.testShow', { n: 1, title: 'Bar hover e2e' }));
    if (tb && tb.ok) {
      await bar.ev(call('toasts.testReveal'));
      await sleep(400);
      await sweep('banner showing');
    } else notes.push(`banner showing: NOT RUN, toasts.testShow said ${JSON.stringify(tb).slice(0, 200)}`);

    // ---- the corner-follow card (the screenshot card's stand-in)
    const card = { x: S.x + S.width - 8 - 300, y: R.y - 18 - 160, width: 300, height: 160 };
    const tc = await bar.ev(call('toasts.corner', { rect: card }));
    if (tc && tc.ok) {
      await sweep('corner card showing');
      await bar.ev(call('toasts.corner', { rect: null }));
    } else notes.push(`corner card: NOT RUN, toasts.corner said ${JSON.stringify(tc).slice(0, 200)}`);
    check('banner and corner-card states ran (toasts.testShow / toasts.corner in --test)', !!(tb && tb.ok) && !!(tc && tc.ok), { tb, tc });
  } finally {
    if (bar) bar.close();
    if (!run.exited) {
      spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'tools', 'kill-test.ps1'), '-Match', PROFILE], { encoding: 'utf8', timeout: 30000 });
      await until(() => run.exited, 15000, 200);
    }
  }
}

main().catch((e) => check('the run itself', false, e && e.stack ? e.stack : String(e))).then(() => {
  for (const n of notes) console.log('  ' + n);
  if (skipped) console.log(`BAR HOVER E2E: skipped: ${skipped}`);
  for (const f of failures) console.log('FAIL ' + f);
  console.log(`BAR HOVER E2E TEST: ${passed} passed, ${failures.length} failed${skipped ? ' (skipped: ' + skipped + ')' : ''}`);
  process.exit(failures.length ? 1 : 0);
});

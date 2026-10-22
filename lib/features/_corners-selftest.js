'use strict';
/*
 * _corners-selftest.js - hot corners proving themselves inside an Electron --test instance
 * (MANTLE_CORNERS_SELFTEST=1; loaded only by lib/features/corners.js, and only in --test).
 *
 * WHAT IT DRIVES: the feature's own poll, fed a FAKE cursor and FAKE mouse buttons from the first
 * moment (the user's real cursor never drives this instance), the real passive sidecar for the check at
 * the moment of firing (gamemode.scan: reads only) and for Show desktop's DRY RUN, and every action
 * through runAction in its --test dry run. Nothing is moved, focused, minimised or locked: the
 * foreground window's handle is read before and after, and the run fails if it changed.
 *
 * Results: one line in mantle.log ("corners: SELFTEST ...") and %TEMP%\mantle-corners\selftest.json.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const OUT = path.join(os.tmpdir(), 'mantle-corners', 'selftest.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let halt = false;

function start(k) {
  const { ctx, S, C, screen } = k;
  const fake = { pt: null, btn: { ok: true, held: false, pressed: false }, reads: 0, btnReads: 0 };
  const mid = () => { const b = screen.getPrimaryDisplay().bounds; return { x: b.x + Math.round(b.width / 2), y: b.y + Math.round(b.height / 2) }; };
  S.src = {
    cursor: () => { fake.reads++; return fake.pt || mid(); },
    buttons: () => { fake.btnReads++; return fake.btn; },
    fake: true,
  };
  run(k, fake).catch((e) => ctx.log(`SELFTEST threw: ${e.stack || e.message}`));
}

async function run(k, fake) {
  const { ctx, S, C, screen } = k;
  const checks = [];
  const check = (name, ok, detail) => { checks.push({ name, ok: !!ok, detail: ok ? undefined : detail }); };
  const b = screen.getPrimaryDisplay().bounds;
  const sd = screen.getPrimaryDisplay().scaleFactor || 1;
  const mid = () => ({ x: b.x + Math.round(b.width / 2), y: b.y + Math.round(b.height / 2) });
  // the lowest row the 2 px edge clip lets the cursor reach (ClipCursor ...,H-2 -> H-3 px), in DIP
  const clipRow = b.y + Math.floor((Math.round(b.height * sd) - 3) / sd);
  const at = {
    tl: { x: b.x, y: b.y }, tr: { x: b.x + b.width - 1, y: b.y },
    bl: { x: b.x, y: clipRow }, br: { x: b.x + b.width - 1, y: clipRow },
  };
  const fg = async () => { const r = await ctx.sidecar.send('foreground', {}, { timeoutMs: 1500 }); return r.ok ? String(r.result.hwnd) : `unread (${r.error})`; };
  const saved = Object.assign({}, S.actions);
  const settle = C.CORNER_DWELL_MS + 3 * C.CORNER_POLL_MS + 400;   // dwell + polls + the scan and dry run
  // park the cursor, wait, then let any fire in flight finish (its scan + dry run) before judging it
  const go = async (pt, ms) => { fake.pt = pt; await sleep(ms); for (let i = 0; i < 100 && S.busy; i++) await sleep(50); };
  try {
    for (let i = 0; i < 50 && !S.watching && !halt; i++) await sleep(100);
    // the fire check and Show desktop's dry run are sidecar calls: start once it is up
    for (let i = 0; i < 300 && !ctx.sidecar.ready && !halt; i++) await sleep(100);
    check('the sidecar came up (the check at the moment of firing needs it)', ctx.sidecar.ready, 'not ready after 30 s');
    const fg0 = await fg();
    check('the watch runs on the FAKE cursor (default corners: top-left Task view, bottom-right Show desktop)',
      S.watching && S.src.fake && S.actions.tl === 'taskview' && S.actions.br === 'desktop', JSON.stringify({ watching: S.watching, actions: S.actions }));
    await go(mid(), 300);
    check('the claim table gives the ACTIVE bottom-right square (the edge-clip row) to the corner, the middle of the edge and an Off corner to the edge',
      C.claims(at.br, b) === 'br' && C.claims({ x: b.x + 700, y: clipRow }, b) === null && C.claims(at.tr, b) === null,
      JSON.stringify({ br: C.claims(at.br, b), mid: C.claims({ x: b.x + 700, y: clipRow }, b), tr: C.claims(at.tr, b), clipRow }));

    // bottom-right at the edge-clip row: fires once, a dry run through the passive sidecar
    const n0 = S.fires;
    await go(at.br, settle);
    const l1 = S.last || {};
    check('bottom-right (at the edge-clip row) fires Show desktop once, as a DRY RUN the passive sidecar answered',
      S.fires === n0 + 1 && l1.corner === 'br' && l1.action === 'desktop' && l1.ok && l1.dryRun && /ToggleDesktop/.test(l1.said), JSON.stringify({ fires: S.fires - n0, last: l1 }));
    await go(at.br, 700);
    check('resting on in the corner does not fire again', S.fires === n0 + 1, `fires ${S.fires - n0}`);
    await go(mid(), 300);
    await go(at.br, settle);
    check('leaving and coming back fires again (re-armed)', S.fires === n0 + 2 && S.last && S.last.corner === 'br', `fires ${S.fires - n0}`);

    // a held button: disarmed until the cursor leaves
    await go(mid(), 300);
    fake.btn = { ok: true, held: true, pressed: true };
    await go(at.br, settle);
    const heldFires = S.fires;
    check('a mouse button held in the corner: nothing fires, and it says why', heldFires === n0 + 2 && S.blocked && /mouse button/.test(S.blocked.why), JSON.stringify({ fires: S.fires - n0, blocked: S.blocked }));
    fake.btn = { ok: true, held: false, pressed: false };
    await go(at.br, settle);
    check('the button let go with the cursor still in the corner: still nothing (it has to leave first)', S.fires === heldFires, `fires ${S.fires - heldFires}`);
    await go(mid(), 300);

    // a unreadable button reader refuses, and it is the feature's health
    fake.btn = { ok: false, reason: 'selftest: a reader that cannot read' };
    await go(at.br, settle);
    check('a button reader that cannot read: nothing fires, the watch reports it', S.fires === heldFires && S.watch.ok === false && /cannot be read/.test(S.watch.reason || ''), JSON.stringify({ fires: S.fires - heldFires, watch: S.watch }));
    fake.btn = { ok: true, held: false, pressed: false };
    await go(mid(), 300);
    await go(at.br, 150);   // one read in the corner, well inside the dwell
    await go(mid(), 300);
    check('the reader reading again clears it', S.watch.ok === true, JSON.stringify(S.watch));

    // a known game running (the test instance's own exe stands in): refused at the moment of firing
    S.extraGames = [path.basename(process.execPath)];
    const g0 = S.fires;
    await go(at.br, settle + 600);
    const lg = S.last || {};
    check(`a known game running (${S.extraGames[0]} stands in): the corner does nothing and says so`,
      S.fires === g0 + 1 && lg.blocked && !lg.ok && /known game/.test(lg.said || ''), JSON.stringify({ fires: S.fires - g0, last: lg }));
    S.extraGames = [];
    await go(mid(), 300);

    // top-left: Task view, through Win+Tab's own feature (asked, in --test, whether it could take it)
    await go(at.tl, settle);
    const lt = S.last || {};
    check('top-left fires Task view: a dry run through Win+Tab\'s own feature, or its reason', lt.corner === 'tl' && lt.action === 'taskview' && !!lt.said && (lt.ok ? lt.dryRun : /Task view could not open/.test(lt.said)), JSON.stringify(lt));
    await go(mid(), 300);

    // the other actions, each as a dry run on a corner switched to it (in memory only)
    for (const [corner, action, re] of [['tr', 'lock', /LockWorkStation/], ['bl', 'qs', /quick settings/], ['bl', 'launcher', /launcher/], ['tr', 'off', null]]) {
      S.actions = Object.assign({}, saved, { [corner]: action });
      C.setClaims(S.actions);
      const f0 = S.fires;
      await go(at[corner], settle);
      const l = S.last || {};
      if (!re) check(`${corner} switched Off: nothing fires there`, S.fires === f0, `fires ${S.fires - f0}`);
      else check(`${corner} as ${action} fires its dry run`, S.fires === f0 + 1 && l.corner === corner && l.action === action && l.ok && l.dryRun && re.test(l.said || ''), JSON.stringify({ fires: S.fires - f0, last: l }));
      await go(mid(), 300);
    }
    S.actions = saved;
    C.setClaims(S.actions);

    const fg1 = await fg();
    check('the foreground window never changed (nothing was focused, minimised or locked)', fg0 === fg1, `${fg0} -> ${fg1}`);
    check('the fake cursor was read and the buttons only while in a corner', fake.reads > 20 && fake.btnReads > 3 && fake.btnReads < fake.reads, JSON.stringify({ reads: fake.reads, btnReads: fake.btnReads }));
  } catch (e) {
    check('the run finished', false, e.stack || e.message);
  }
  const passed = checks.filter((c) => c.ok).length;
  const failed = checks.length - passed;
  ctx.log(`SELFTEST ${failed ? 'FAILED' : 'passed'}: ${passed} passed, ${failed} failed` + (failed ? ` - ${checks.filter((c) => !c.ok).map((c) => `${c.name} (${c.detail})`).join('; ')}` : ''));
  try { fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), passed, failed, checks }, null, 1)); } catch (_) { /* the log line has it */ }
}

function stop() { halt = true; }

module.exports = { start, stop };

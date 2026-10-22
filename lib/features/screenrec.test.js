'use strict';
/*
 * screenrec.test.js - lib/features/screenrec.js's engine in plain node (lane screenrec2, 2026-10-15): the
 * refusals before anything starts, the recorder's protocol (spec on line 1, "stop", the events), the pill
 * and the card it asks for, stopping for a game, and every way a recorder can fail. A FAKE recorder (an
 * EventEmitter with stdin/stdout) stands in for Mantle.Sidecar.exe --record: nothing is spawned, nothing
 * is captured, no file is written.
 *   node lib/features/screenrec.test.js   -> "SCREENREC TEST: n passed, m failed"
 */
const path = require('path');
const os = require('os');
const { EventEmitter } = require('events');
const M = require('./screenrec.js');
const F = require('../features.js');
const { createEngine, parseStandin, testTarget, outDirFor, lineReader, WDA_EXCLUDEFROMCAPTURE } = M._test;

let passed = 0;
const failures = [];
const check = (name, ok, detail) => { if (ok) passed++; else failures.push(detail !== undefined ? `${name} (${String(detail).slice(0, 300)})` : name); return ok; };
const J = (x) => JSON.stringify(x);
const tick = () => new Promise((r) => setImmediate(r));

const scanApp = { ok: true, fg: { pid: 7, exe: 'C:\\Program Files\\Opera\\opera.exe', title: 'Notes' }, procs: [] };
const scanGame = { ok: true, fg: { pid: 9, exe: 'C:\\Riot Games\\VALORANT\\live\\ShooterGame\\Binaries\\Win64\\VALORANT-Win64-Shipping.exe', title: 'VALORANT' }, procs: [] };
const STANDIN = { hwnd: '4458', pid: 3210, w: 1920, h: 1080 };

function fakeChild() {
  const c = new EventEmitter();
  c.pid = 4242;
  c.written = [];
  c.ended = false;
  c.killed = false;
  c.stdin = { write: (s) => { c.written.push(s); return true; }, end: () => { c.ended = true; } };
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  c.kill = () => { c.killed = true; setImmediate(() => c.emit('exit', 1)); };
  c.say = (o) => c.stdout.emit('data', Buffer.from(JSON.stringify(o) + '\n'));
  c.spec = () => JSON.parse(c.written[0]);
  return c;
}

function fakeTimers() {
  const T = { list: [], now: 1000000 };
  T.setTimeout = (fn, ms) => { const t = { fn, at: T.now + ms, done: false }; T.list.push(t); return t; };
  T.clearTimeout = (t) => { if (t) t.done = true; };
  T.advance = (ms) => { T.now += ms; for (const t of T.list.slice()) if (!t.done && t.at <= T.now) { t.done = true; t.fn(); } };
  return T;
}

function rig(o) {
  const x = o || {};
  const R = { logs: [], ui: [], spawned: [], sc: [], picks: [], mk: [], views: [] };
  const T = fakeTimers();
  R.T = T;
  R.engine = createEngine({
    test: x.test !== false, standin: x.standin === undefined ? STANDIN : x.standin,
    log: (t) => R.logs.push(String(t)),
    sc: async (cmd, args, ms) => {
      R.sc.push({ cmd, args, ms });
      if (cmd === 'gamemode.scan') return x.scan === undefined ? scanApp : x.scan;
      if (cmd === 'shot.owner') return x.owner || { ok: true, owners: [{ window: args.windows[0], exe: 'Mantle.Sidecar.exe', exists: true }] };
      return { ok: false, reason: 'unknown command' };
    },
    resting: () => x.resting || null,
    outDir: () => x.outDir || { dir: path.join(os.tmpdir(), 'mantle-rec-unit'), why: 'test mode' },
    options: () => Object.assign({ fps: 30, audio: true, mic: false }, x.options || {}),
    mkdir: (d) => { R.mk.push(d); if (x.mkdirThrow) throw new Error('EPERM: operation not permitted'); },
    spawn: () => { if (x.spawnThrow) throw new Error('spawn ENOENT'); const c = fakeChild(); R.spawned.push(c); return c; },
    now: () => T.now,
    timers: T,
    ui: {
      open: (v, anchor) => R.ui.push({ what: 'open', v, anchor }),
      update: (v) => R.ui.push({ what: 'update', v }),
      card: (v) => R.ui.push({ what: 'card', v }),
      close: () => R.ui.push({ what: 'close' }),
    },
    pick: (via) => { R.picks.push(via); return x.pick || { ok: true, picking: true }; },
    publish: (v) => R.views.push(v),
  });
  R.last = (what) => R.ui.filter((u) => u.what === what).slice(-1)[0];
  return R;
}

/** start, then play the recorder through ready + started; -> { R, c, res } */
async function running(o, args) {
  const R = rig(o);
  const p = R.engine.start(args || { kind: 'region', rect: { x: 100, y: 100, w: 800, h: 600 } }, 'unit');
  for (let i = 0; i < 6 && !R.spawned.length; i++) await tick();
  const c = R.spawned[0];
  if (!c) return { R, c: null, res: await p };
  c.say({ ev: 'ready', w: 800, h: 600, fps: 30, encoder: { name: 'Intel Quick Sync H.264', hardware: true }, border: false, audio: { system: true, mic: false } });
  R.T.now += 640;
  c.say({ ev: 'started', ms: 640 });
  const res = await p;
  return { R, c, res };
}

async function main() {
  /* ---- the module contract -------------------------------------------------------------------- */
  check('the module passes lib/features.js validate()', F.validate(M, 'screenrec') === null, F.validate(M, 'screenrec'));
  check('rest: true (stopped while a game runs)', M.rest === true);
  check('options: fps 30 default, sound on, mic off, a folder', J(M.options.map((x) => [x.key, x.default])) === J([['fps', 30], ['audio', true], ['mic', false], ['saveDir', null]]));
  check('WDA_EXCLUDEFROMCAPTURE is 0x11', WDA_EXCLUDEFROMCAPTURE === 0x11);

  /* ---- pure helpers ----------------------------------------------------------------------------- */
  check('standin: hwnd:pid', J(parseStandin('4458:3210')) === J({ hwnd: '4458', pid: 3210, w: null, h: null }));
  check('standin: hwnd:pid:w:h', J(parseStandin('4458:3210:1920:1080')) === J(STANDIN));
  check('standin: junk is none', parseStandin('') === null && parseStandin('abc:1') === null && parseStandin('0:5') === null && parseStandin('12') === null);
  check('test target: a window is the whole stand-in', J(testTarget({ mode: 'window', hwnd: '99' }, STANDIN)) === J({ mode: 'window', hwnd: '4458' }));
  const tt = testTarget({ mode: 'monitor', x: 1, y: 1, crop: { x: 3000, y: 50, w: 801, h: 601 } }, STANDIN);
  check('test target: an area is a crop of its size INSIDE the stand-in, centred, even sides', tt.mode === 'window' && tt.hwnd === '4458' && J(tt.crop) === J({ x: 560, y: 240, w: 800, h: 600 }), J(tt));
  const big = testTarget({ mode: 'monitor', x: 1, y: 1, crop: { x: 0, y: 0, w: 3840, h: 2160 } }, STANDIN);
  check('test target: an area bigger than the stand-in is the whole stand-in', J(big) === J({ mode: 'window', hwnd: '4458' }), J(big));
  check('test target: never the asked window', testTarget({ mode: 'window', hwnd: '123456' }, STANDIN).hwnd === '4458');
  const tmp = os.tmpdir();
  check('out dir: test under %TEMP%', outDirFor(true, path.join(tmp, 'x'), null, 'C:\\Users\\o\\Videos', tmp).dir === path.resolve(tmp, 'x'));
  check('out dir: test refuses outside %TEMP%', outDirFor(true, 'C:\\Users\\o\\Videos', null, null, tmp).dir === null);
  check('out dir: test ignores the setting', outDirFor(true, null, 'D:\\Clips', null, tmp).dir.startsWith(path.resolve(tmp)));
  check('out dir: the setting wins live', outDirFor(false, null, 'D:\\Clips', 'C:\\Users\\o\\Videos', tmp).dir === 'D:\\Clips');
  check('out dir: Videos\\Captures by default', outDirFor(false, null, null, 'C:\\Users\\o\\Videos', tmp).dir === 'C:\\Users\\o\\Videos\\Captures');
  check('out dir: no Videos folder says so', /Videos folder/.test(outDirFor(false, null, null, null, tmp).why));
  const evs = [];
  const rd = lineReader((e) => evs.push(e));
  rd(Buffer.from('{"ev":"ti')); rd(Buffer.from('ck","secs":1}\n\nnot json\n{"ev":"done"}\n'));
  check('lines: split across chunks, blank skipped, garbage is an event', J(evs.map((e) => e.ev)) === J(['tick', 'garbage', 'done']), J(evs));

  /* ---- a recording, start to card ------------------------------------------------------------- */
  {
    const { R, c, res } = await running();
    check('start: resolves ok once the first frame is in', res && res.ok === true && res.startMs === 640, J(res));
    check('start: one scan with the game check, then shot.owner for the stand-in', R.sc[0].cmd === 'gamemode.scan' && R.sc[0].ms <= 1500 && R.sc[1] && R.sc[1].cmd === 'shot.owner' && R.sc[1].args.windows[0] === '4458', J(R.sc));
    const spec = c.spec();
    check('spec: line 1 is JSON ending in a newline', c.written[0].endsWith('\n'));
    check('spec: test -> the stand-in window, an area as a crop inside it', spec.mode === 'window' && spec.hwnd === '4458' && J(spec.crop) === J({ x: 560, y: 240, w: 800, h: 600 }), J(spec));
    check('spec: test:true + allowPid = the stand-in pid', spec.test === true && spec.allowPid === 3210);
    check('spec: fps 30, sound, no mic, 4 h cap', spec.fps === 30 && spec.audio === true && spec.mic === false && spec.maxSecs === 4 * 3600);
    check('spec: out is "Recording <date> <time>.mp4" in the folder', /[\\/]mantle-rec-unit[\\/]Recording \d{4}-\d\d-\d\d \d{6}\.mp4$/.test(spec.out), spec.out);
    check('the folder is made', R.mk.length === 1);
    check('the pill opens AT ONCE ("Starting…", before the checks), anchored on the area', R.ui[0].what === 'open' && R.ui[0].v.phase === 'checking' && R.ui[0].anchor && R.ui[0].anchor.w === 800 && R.sc.length >= 1, J(R.ui[0]));
    check('ready -> the pill hears it (still starting)', R.ui[1] && R.ui[1].what === 'update' && R.ui[1].v.phase === 'starting', J(R.ui[1]));
    check('started -> the pill shows recording with startedAt', R.last('update').v.phase === 'recording' && R.last('update').v.startedAt === R.T.now);
    check('active while recording', R.engine.active() === true);
    c.say({ ev: 'tick', secs: 3, frames: 90, late: 0, dup: 40, bytes: 300000, freeMb: 90000 });
    check('tick -> the pill updates with secs', R.last('update').v.secs === 3 && R.last('update').v.clock === '0:03');
    check('a second start while recording is refused', /already running/.test((await R.engine.start({ kind: 'window', hwnd: '77' })).reason));
    check('stop -> "stop" on stdin', R.engine.stop('unit') === true && c.written[1] === 'stop\n', J(c.written));
    check('stop -> the pill says saving', R.last('update').v.phase === 'stopping');
    check('stop twice is still one "stop"', R.engine.stop('unit') === true && c.written.length === 2);
    const out = c.spec().out;
    c.say({ ev: 'done', path: out, secs: 12, frames: 360, late: 0, bytes: 4404019, why: 'stop' });
    const card = R.last('card');
    check('done -> the card: saved, clock, size, MB', card && card.v.words.title === 'Recording saved' && card.v.words.detail === '0:12 · 800 × 600 · 4.2 MB', card && J(card.v.words));
    check('done -> the name for the card', card.v.name === path.basename(out));
    check('done -> no note when stopped by hand', card.v.note === null);
    check('test: the state carries the path (so the test can delete it)', card.v.path === out);
    check('done -> idle again', R.engine.active() === false);
    check('done -> stdin closed', c.ended === true);
    c.emit('exit', 0);
    check('exit after done changes nothing', R.ui.filter((u) => u.what === 'card').length === 1);
    check('the log names the encoder and the start time', R.logs.some((l) => /Quick Sync.*\(hardware\)/.test(l)) && R.logs.some((l) => /started 640 ms after unit/.test(l)), J(R.logs));
  }

  /* ---- live (not test): never the stand-in, the real target ---------------------------------- */
  {
    const { c, res } = await running({ test: false, standin: null, owner: { ok: true, owners: [{ window: '777', exe: 'opera.exe', exists: true }] } }, { mode: 'window', kind: 'window', hwnd: '777' });
    check('live: a window records that window', res.ok && c.spec().mode === 'window' && c.spec().hwnd === '777' && c.spec().test === false && c.spec().allowPid === 0, J(c && c.spec()));
  }
  {
    const { c, res } = await running({ test: false, standin: null }, { mode: 'rect', rect: { x: -1920, y: 0, w: 1280, h: 720 } });
    check('live: an area records the screen under it, cropped', res.ok && c.spec().mode === 'monitor' && J(c.spec().crop) === J({ x: -1920, y: 0, w: 1280, h: 720 }), J(c && c.spec()));
  }

  /* ---- refusals: nothing spawns, the card says why --------------------------------------------- */
  const refused = async (name, o, args, re) => {
    const R = rig(o);
    const r = await R.engine.start(args || { kind: 'region', rect: { x: 0, y: 0, w: 640, h: 480 } }, 'unit');
    const card = R.last('card');
    check(`refused: ${name}`, r.ok === false && re.test(r.reason) && R.spawned.length === 0, J(r));
    check(`refused: ${name} -> a "Not recording" card with the reason`, card && card.v.words.title === 'Not recording' && card.v.words.detail === r.reason && card.v.words.warn === true, card && J(card.v.words));
    check(`refused: ${name} -> not active after`, R.engine.active() === false);
    return R;
  };
  await refused('a game in front', { scan: scanGame }, null, /VALORANT-Win64-Shipping\.exe is in front.*never records games.*Win\+Alt\+R/);
  await refused('the scan failed', { scan: { ok: false, reason: 'the sidecar is restarting' } }, null, /could not check for a game in front \(the sidecar is restarting\)/);
  await refused('the scan never answered', { scan: null }, null, /could not check for a game/);
  await refused('a game\'s window (live)', { test: false, standin: null, owner: { ok: true, owners: [{ window: '55', exe: 'RobloxPlayerBeta.exe', exists: true }] } }, { kind: 'window', hwnd: '55' }, /RobloxPlayerBeta\.exe, a game/);
  await refused('the window closed', { owner: { ok: true, owners: [{ window: '4458', exists: false }] } }, { kind: 'window', hwnd: '4458' }, /window closed/);
  await refused('resting for a game', { resting: 'VALORANT runs' }, null, /resting while VALORANT runs/);
  await refused('a test with no stand-in', { standin: null }, null, /stand-in/);
  await refused('too small', {}, { kind: 'region', rect: { x: 0, y: 0, w: 40, h: 40 } }, /too small/);
  await refused('nothing picked as a window', {}, { kind: 'window' }, /no window was picked/);
  await refused('no folder', { outDir: { dir: null, why: 'test mode only saves under C:\\T' } }, null, /only saves under/);
  await refused('the folder cannot be made', { mkdirThrow: true }, null, /could not be made \(EPERM/);
  await refused('the recorder cannot start', { spawnThrow: true }, null, /recorder did not start \(spawn ENOENT\)/);
  {
    const R = rig();
    R.engine.setResting('Roblox runs');
    const r = await R.engine.start({ kind: 'region', rect: { x: 0, y: 0, w: 640, h: 480 } });
    check('resting (set by the feature) refuses before any check', !r.ok && /resting while Roblox runs/.test(r.reason) && R.sc.length === 0, J(r));
  }

  /* ---- nothing picked: the overlay picks ------------------------------------------------------- */
  {
    const R = rig();
    const r = await R.engine.start({}, 'the Win+G panel');
    check('no target -> Win+Shift+S opens with Record on (picking)', r.ok && r.picking && R.picks[0] === 'the Win+G panel' && R.spawned.length === 0, J(r));
    const R2 = rig({ pick: { ok: false, reason: 'Screenshots is off in the tray' } });
    const r2 = await R2.engine.start(undefined, 'the Win+G panel');
    check('no target, no overlay -> the reason on a card', !r2.ok && /Screenshots is off/.test(r2.reason) && R2.last('card'), J(r2));
  }

  /* ---- stop while the checks run: it never starts ---------------------------------------------- */
  {
    const R = rig();
    const p = R.engine.start({ kind: 'region', rect: { x: 0, y: 0, w: 640, h: 480 } });
    check('checking counts as active (the chord again stops it)', R.engine.active() === true);
    check('stop while checking -> true', R.engine.stop('unit') === true);
    const r = await p;
    check('stop while checking -> nothing spawns', !r.ok && R.spawned.length === 0 && /stopped before it started/.test(r.reason), J(r));
    check('stop while checking -> the pill just goes (no warning card for a Stop)', R.last('close') && !R.ui.some((u) => u.what === 'card'), J(R.ui.map((u) => u.what)));
  }

  /* ---- failures of the recorder ---------------------------------------------------------------- */
  {
    const { R, c } = await running();
    c.say({ ev: 'tick', secs: 5 });
    c.emit('exit', 3221225477);
    const card = R.last('card');
    check('crash -> "Recording not saved" with the exit code', card && card.v.words.title === 'Recording not saved' && /stopped unexpectedly \(exit 3221225477\)/.test(card.v.words.detail), card && J(card.v.words));
    check('crash -> idle', !R.engine.active());
  }
  {
    const R = rig();
    const p = R.engine.start({ kind: 'region', rect: { x: 0, y: 0, w: 640, h: 480 } });
    for (let i = 0; i < 6 && !R.spawned.length; i++) await tick();
    R.spawned[0].say({ ev: 'error', error: 'Windows refused to capture that window (it may be protected)' });
    const r = await p;
    check('an error event -> start resolves with it', !r.ok && /refused to capture/.test(r.reason), J(r));
    check('an error event -> the card says it', /refused to capture/.test(R.last('card').v.words.detail));
  }
  {
    const R = rig();
    const p = R.engine.start({ kind: 'region', rect: { x: 0, y: 0, w: 640, h: 480 } });
    for (let i = 0; i < 6 && !R.spawned.length; i++) await tick();
    const c = R.spawned[0];
    c.say({ ev: 'ready', w: 640, h: 480, fps: 30, encoder: { name: 'x', hardware: false } });
    R.T.advance(12001);
    check('no first frame in 12 s -> the recorder is ended', c.killed === true);
    const r = await p;
    check('no first frame -> plain words', !r.ok && /never got a first frame/.test(r.reason), J(r));
  }
  {
    const { R, c } = await running();
    R.engine.stop('unit');
    R.T.advance(15001);
    check('no "done" 15 s after stop -> the recorder is ended', c.killed === true);
    await tick(); await tick();
    check('...and the card says it did not finish', R.last('card') && R.last('card').v.phase === 'failed', R.last('card') && J(R.last('card').v));
  }
  {
    const { R, c } = await running();
    c.say({ ev: 'done', path: c.spec().out, secs: 4 * 3600, frames: 1, bytes: 9e9, why: 'the 4 hour limit was reached' });
    check('the recorder\'s own stop reason is the card\'s note', R.last('card').v.note === 'Stopped because the 4 hour limit was reached', R.last('card').v.note);
  }

  /* ---- a game starts while recording: finish the file, quietly --------------------------------- */
  {
    const { R, c } = await running();
    const p = R.engine.stopAndWait('a game started', 8000, true);
    check('rest -> "stop" sent', c.written[1] === 'stop\n');
    c.say({ ev: 'done', path: c.spec().out, secs: 9, frames: 270, bytes: 1e6, why: 'stop' });
    const st = await p;
    check('rest -> the file is saved, the reason is the game', st && st.phase === 'done' && st.stopWords === 'Stopped because a game started', J(st));
    check('rest -> no card over the game, the window goes', R.last('close') && !R.ui.some((u) => u.what === 'card'), J(R.ui.map((u) => u.what)));
    check('rest with nothing running -> null at once', (await R.engine.stopAndWait('x', 10, true)) === null);
  }

  console.log(`SCREENREC TEST: ${passed} passed, ${failures.length} failed`);
  for (const f of failures) console.log('  FAIL ' + f);
  process.exit(failures.length ? 1 : 0);
}
main().catch((e) => { console.log(`SCREENREC TEST: ${passed} passed, ${failures.length + 1} failed`); console.log(e.stack); process.exit(1); });

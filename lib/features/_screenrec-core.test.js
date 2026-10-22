'use strict';
/*
 * _screenrec-core.test.js - what a recording is of, when Mantle refuses, the recorder spec, the name and the
 * words (lib/features/_screenrec-core.js). Pure node.
 *   node lib/features/_screenrec-core.test.js   -> "SCREENREC CORE TEST: n passed, m failed"
 */
const C = require('./_screenrec-core');

let passed = 0;
const failures = [];
function check(name, ok, detail) { if (ok) passed++; else failures.push(detail !== undefined ? `${name} (${JSON.stringify(detail)})` : name); }

/* naming and folder */
check('name: like the screenshot\'s, with .mp4', C.recordingName(new Date(2026, 9, 5, 9, 3, 7)) === 'Recording 2026-10-05 090307.mp4', C.recordingName(new Date(2026, 9, 5, 9, 3, 7)));
check('folder: Videos\\Captures', C.capturesDir('C:\\Users\\user\\Videos') === 'C:\\Users\\user\\Videos\\Captures');

/* the target */
const area = C.targetFrom({ mode: 'rect', rect: { x: 100, y: 50, w: 640, h: 360 } });
check('area: a monitor crop, centred point', area.ok && area.target.mode === 'monitor' && area.target.x === 420 && area.target.y === 230 && area.target.crop.w === 640, area);
check('area: from the command too', C.targetFrom({ kind: 'region', rect: { x: -1920, y: 0, w: 800, h: 600 } }).target.x === -1520);
const win = C.targetFrom({ mode: 'window', kind: 'window', hwnd: '1311402', rect: { x: 0, y: 0, w: 10, h: 10 } });
check('window: by its handle', win.ok && win.target.mode === 'window' && win.target.hwnd === '1311402' && !win.target.crop, win);
check('window: the desktop under the pointer records its screen', C.targetFrom({ mode: 'window', kind: 'desktop', hwnd: '65552', rect: { x: 0, y: 0, w: 1920, h: 1080 } }).target.mode === 'monitor');
check('full screen: the screen', C.targetFrom({ mode: 'full', kind: 'monitor', rect: { x: 0, y: 0, w: 1920, h: 1080 } }).target.crop.w === 1920);
check('window: no handle is refused in words', /no window was picked/.test(C.targetFrom({ kind: 'window' }).reason));
check('window: a handle that is not a number is refused', !C.targetFrom({ kind: 'window', hwnd: '12;rm' }).ok);
check('area: too small, with the numbers', /too small to record \(40 × 300; pick at least 64 × 64\)/.test(C.targetFrom({ kind: 'region', rect: { x: 0, y: 0, w: 40, h: 300 } }).reason));
check('area: too big', /too big/.test(C.targetFrom({ kind: 'region', rect: { x: 0, y: 0, w: 5000, h: 300 } }).reason));
check('nothing named: refused', !C.targetFrom({}).ok && /an area, a window or a screen/.test(C.targetFrom({}).reason));

/* refusals */
const scanGame = { fg: { pid: 9, exe: 'C:\\Riot Games\\VALORANT\\live\\ShooterGame\\Binaries\\Win64\\VALORANT-Win64-Shipping.exe', title: 'VALORANT' }, procs: [] };
const scanApp = { fg: { pid: 7, exe: 'C:\\Program Files\\Opera\\opera.exe', title: 'Notes' }, procs: [] };
check('refused: a game in front, naming Game Bar', /VALORANT-Win64-Shipping\.exe is in front, and Mantle never records games\. Game Bar records games: press Win\+Alt\+R/.test(C.refusal({ scan: scanGame, target: area.target }) || ''), C.refusal({ scan: scanGame, target: area.target }));
check('refused: resting for a game', /resting while VALORANT runs/.test(C.refusal({ resting: 'VALORANT runs', target: area.target }) || ''));
check('refused: a game\'s window, even when not in front', /a game/.test(C.refusal({ scan: scanApp, target: win.target, targetFile: 'RobloxPlayerBeta.exe' }) || ''));
check('allowed: a browser in front, an area', C.refusal({ scan: scanApp, target: area.target }) === null);
check('allowed: a browser window', C.refusal({ scan: scanApp, target: win.target, targetFile: 'opera.exe' }) === null);
check('allowed: no scan (sidecar slow) does not block', C.refusal({ scan: null, target: area.target }) === null);
check('test: never the screen', /own stand-in/.test(C.refusal({ test: true, testPid: 5, target: area.target }) || ''));
check('test: never another process\'s window', /own stand-in/.test(C.refusal({ test: true, testPid: 5, targetPid: 6, target: win.target }) || ''));
check('test: the stand-in is allowed', C.refusal({ test: true, testPid: 5, targetPid: 5, target: win.target }) === null);

/* the spec */
const sp = C.specFor(area.target, { fps: 60, out: 'C:\\x\\a.mp4' });
check('spec: target, fps, sound on, mic off, 4 h cap, 1 GB floor', sp.mode === 'monitor' && sp.fps === 60 && sp.audio === true && sp.mic === false && sp.maxSecs === 14400 && sp.minFreeMb === 1024 && sp.test === false && sp.crop.w === 640, sp);
check('spec: an odd fps becomes 30', C.specFor(win.target, { fps: 45 }).fps === 30);
check('spec: allowPid only in a test', C.specFor(win.target, { allowPid: 9 }).allowPid === 0 && C.specFor(win.target, { test: true, allowPid: 9 }).allowPid === 9);

/* words and state */
check('clock', C.clock(5) === '0:05' && C.clock(65) === '1:05' && C.clock(3725) === '1:02:05' && C.clock(-3) === '0:00');
check('size', C.size(27 * 1024) === '27 KB' && C.size(12.4 * 1024 * 1024) === '12.4 MB');
check('stop words: the user\'s own stop says nothing', C.stopWords('stop') === null);
check('stop words: the window closed', C.stopWords('the window closed') === 'Stopped because the window closed');
check('stop words: an error', C.stopWords('error: the disk is full') === 'Stopped early: the disk is full');
let st = C.reduce(null, { ev: 'ready', w: 1920, h: 1080, fps: 60, border: 'hidden', audio: { system: 'on', mic: 'off' } });
check('state: ready -> starting', st.phase === 'starting' && st.w === 1920);
st = C.reduce(st, { ev: 'started' });
check('state: started -> recording', st.phase === 'recording' && st.secs === 0);
st = C.reduce(st, { ev: 'tick', secs: 3, frames: 180, bytes: 1000 });
check('state: tick', st.secs === 3 && st.frames === 180);
const done = C.reduce(st, { ev: 'done', path: 'C:\\v\\Recording.mp4', name: 'Recording.mp4', secs: 83.2, bytes: 13 * 1024 * 1024, why: 'the window closed' });
check('state: done', done.phase === 'done' && done.stopWords === 'Stopped because the window closed');
check('state: an exit after done changes nothing', C.reduce(done, { ev: 'exit', code: 0 }).phase === 'done');
check('state: an exit while recording is a failure, in words', /stopped unexpectedly \(exit 3\)/.test(C.reduce(st, { ev: 'exit', code: 3 }).error));
const cw = C.cardWords(done);
check('card: saved, length · size · bytes', cw.title === 'Recording saved' && cw.detail === '1:23 · 1920 × 1080 · 13.0 MB' && cw.note === 'Stopped because the window closed', cw);
const cf = C.cardWords(C.reduce(st, { ev: 'error', error: 'the disk is full' }));
check('card: failed says why', cf.title === 'Recording not saved' && cf.detail === 'the disk is full' && cf.warn === true);
check('state: never mutates', st.phase === 'recording');

for (const f of failures) console.log('FAIL ' + f);
console.log(`SCREENREC CORE TEST: ${passed} passed, ${failures.length} failed`);
process.exit(failures.length ? 1 : 0);

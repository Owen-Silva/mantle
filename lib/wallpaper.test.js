'use strict';
/*
 * wallpaper.test.js -- lib/wallpaper.js and lib/wallpaper-lively.js under plain node (lane
 * launch-desk, 2026-09-29). No Electron, no window, nothing of the user's is written: `electron` is a
 * stub, userData and LOCALAPPDATA point into a fresh temp folder holding a MADE-UP Lively library,
 * so the import, the library, the commands the Wallpapers window sends and the pause rules all run
 * against fixtures. The user's real wallpaper, Lively install and library are never touched.
 *
 *   node lib/wallpaper.test.js                  the dev tree (must pass)
 *   node lib/wallpaper.test.js --base=<dir>     the same checks against a pristine copy of lib/
 *                                               (<dir>/lib/wallpaper.js): the holes fixed here FAIL
 *
 * One check spawns PowerShell (Expand-Archive) twice to prove a zip's name can no longer run code.
 * Prints "WALLPAPER LIB TEST: n passed, m failed"; exits 1 on any failure.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { execFileSync } = require('child_process');

const BASE = (process.argv.find((a) => a.startsWith('--base=')) || '').slice(7);
const LIBDIR = BASE ? path.join(BASE, 'lib') : __dirname;

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) passed++;
  else failures.push(name + (detail !== undefined ? ' -- ' + String(detail).slice(0, 300) : ''));
}

/* ---- a temp world ------------------------------------------------------------------------ */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mantle-wp-test-'));
const LOCAL = path.join(TMP, 'local');
const USERDATA = path.join(TMP, 'userData');
const CWD = path.join(TMP, 'cwd');
fs.mkdirSync(CWD, { recursive: true });
process.env.LOCALAPPDATA = LOCAL;
process.env.MANTLE_WP_UNDO_MS = '400';

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000' +
  '1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');

function w(file, data) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); }
const LV = path.join(LOCAL, 'Lively Wallpaper');
const TMPL = path.join(LV, 'Library', 'SaveData', 'wptmp');
const WEBL = path.join(LV, 'Library', 'wallpapers');
function lively(dir, info, files) {
  w(path.join(dir, 'LivelyInfo.json'), typeof info === 'string' ? info : JSON.stringify(info));
  for (const f of Object.keys(files || {})) w(path.join(dir, f), files[f]);
}
// A made-up Lively library: a video (the current one), a picture, a web page, a broken JSON, a
// folder with no LivelyInfo.json, a missing file, an app (unsupported), a unicode folder name,
// and a file name that climbs out of its folder.
lively(path.join(TMPL, 'vid00001.aaa'), { Title: 'SecretTitleVideo', Type: 7, FileName: 'clip.mp4', Thumbnail: 'thumb.png' }, { 'clip.mp4': 'not really a video', 'thumb.png': PNG });
lively(path.join(TMPL, 'pic00001.bbb'), { Title: 'SecretTitlePicture', Type: 11, FileName: 'pic.png' }, { 'pic.png': PNG });
lively(path.join(WEBL, 'web00001.ccc'), { Title: 'SecretTitleWeb', Type: 1, FileName: 'index.html' }, { 'index.html': '<!doctype html><html><head></head><body>hi</body></html>' });
lively(path.join(TMPL, 'bad00001.ddd'), '{ "Title": "Broken", "Type": ', {});
w(path.join(TMPL, 'none0001.eee', 'clip.mp4'), 'x');
lively(path.join(TMPL, 'miss0001.fff'), { Title: 'Missing', Type: 7, FileName: 'gone.mp4' }, {});
lively(path.join(TMPL, 'app00001.ggg'), { Title: 'An app', Type: 0, FileName: 'x.exe' }, { 'x.exe': 'x' });
lively(path.join(TMPL, '壁纸 Ünï'), { Title: '壁纸 Ünïcode', Type: 11, FileName: 'p.png' }, { 'p.png': PNG });
lively(path.join(TMPL, 'climb001.hhh'), { Title: 'Climber', Type: 11, FileName: '..\\..\\..\\..\\outside.png', Thumbnail: '..\\..\\..\\..\\outside.png' }, {});
w(path.join(LV, 'Library', 'outside.png'), PNG);
w(path.join(TMPL, '..', '..', '..', 'outside.png'), PNG);
w(path.join(LV, 'WallpaperLayout.json'), JSON.stringify([{ LivelyInfoPath: path.join(TMPL, 'vid00001.aaa') }]));
w(path.join(LV, 'Settings.json'), JSON.stringify({ ProcessMonitorAlgorithm: 0, AppFullscreenPause: 0, AppFocusPause: 1, BatteryPause: 1, RemoteDesktopPause: 0, PowerSaveModePause: 1 }));

/* ---- the electron stub ------------------------------------------------------------------- */
const pm = {};
let protoHandler = null;
const electronStub = {
  protocol: { registerSchemesAsPrivileged() {}, handle(_s, fn) { protoHandler = fn; } },
  app: {
    getPath: () => USERDATA,
    getGPUFeatureStatus: () => ({ video_decode: 'enabled' }),
    getGPUInfo: async () => ({}),
    on() {},
  },
  BrowserWindow: function () { throw new Error('no windows in this test'); },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  powerMonitor: { on(ev, fn) { pm[ev] = fn; }, isOnBatteryPower: () => false },
  screen: {
    getPrimaryDisplay: () => ({ scaleFactor: 1, workArea: { x: 0, y: 0, width: 1920, height: 1040 } }),
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
  },
};
const origLoad = Module._load;
Module._load = function (req, ...rest) { return req === 'electron' ? electronStub : origLoad.call(this, req, ...rest); };

function fakeWin() {
  const sent = [];
  return {
    sent,
    isDestroyed: () => false,
    getContentBounds: () => ({ x: 0, y: 0, width: 1920, height: 1080 }),
    webContents: { isDestroyed: () => false, send(_ch, m) { sent.push(m); }, on() {} },
    last(name) { for (let i = sent.length - 1; i >= 0; i--) if (sent[i].name === name) return sent[i].payload; return null; },
  };
}

/* ---- stdout, captured: the log lines are part of what is tested ---------------------------- */
let logged = '';
const realWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...rest) => {
  const t = String(chunk);
  if (t.startsWith('mantle: ')) { logged += t; return true; }
  return realWrite(chunk, ...rest);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms) { const t0 = Date.now(); while (Date.now() - t0 < (ms || 3000)) { if (fn()) return true; await sleep(20); } return !!fn(); }
async function throws(p) { try { await p; return null; } catch (e) { return e.message || String(e); } }

async function main() {
  process.chdir(CWD);
  const WP = require(path.join(LIBDIR, 'wallpaper.js'));
  const WL = require(path.join(LIBDIR, 'wallpaper-lively.js'));
  const safe = WL.safeId || ((x) => typeof x === 'string' && /^[A-Za-z0-9._-]+$/.test(x) && !/^\.+$/.test(x));
  const idFor = WL.livelyIdFor || ((n) => String(n).toLowerCase());
  const P = WP._probe;
  const S = P.S;
  const C = P.COMMANDS;
  const stateStore = {};
  const state = { set(k, v) { stateStore[k] = v; }, get() { return stateStore; } };
  let fgReply = { hwnd: '0', fullscreen: false };
  let fgThrow = null;
  const fgBudgets = [];
  const sidecar = { call: async (cmd, args, ms) => { if (cmd === 'foreground') fgBudgets.push(ms); if (fgThrow) throw new Error(fgThrow); return fgReply; }, on() {}, blockedReason: () => null };
  const desk = fakeWin();
  const commands = {};
  WP.start({ root: path.resolve(LIBDIR, '..'), test: true, state, sidecar, commands, desktopWin: desk });

  /* ---- import from the made-up Lively library -------------------------------------------- */
  await waitFor(() => S.lib && S.lib.data.lively && S.lib.data.lively.importedAt, 8000);
  const rep = S.lib.data.lively && S.lib.data.lively.report;
  const ids = S.lib.data.items.map((i) => i.id);
  check('import: video, picture and web wallpapers came over', ['vid00001.aaa', 'pic00001.bbb', 'web00001.ccc'].every((i) => ids.includes(i)), ids.join(' '));
  check('import: the current Lively wallpaper is selected', S.lib.data.selected === 'vid00001.aaa', S.lib.data.selected);
  const lines = rep ? rep.lines : [];
  const lineFor = (t) => lines.find((l) => l.title === t || l.livelyId === t) || {};
  check('import: a broken LivelyInfo.json is reported, not thrown', lineFor('bad00001.ddd').ok === false && /could not be read/.test(lineFor('bad00001.ddd').reason || ''), JSON.stringify(lineFor('bad00001.ddd')));
  check('import: a folder with no LivelyInfo.json is reported', lineFor('none0001.eee').ok === false, JSON.stringify(lineFor('none0001.eee')));
  check('import: a missing file is reported', lineFor('Missing').ok === false, JSON.stringify(lineFor('Missing')));
  check('import: an app wallpaper is reported as unsupported', lineFor('An app').ok === false && /only Lively can run/.test(lineFor('An app').reason || ''));
  const uni = S.lib.data.items.find((i) => i.title === '壁纸 Ünïcode');
  check('import: a unicode folder name gets a safe, stable id', !!uni && safe(uni.id) && uni.id === idFor('壁纸 Ünï'), uni && uni.id);
  const climber = S.lib.data.items.find((i) => i.title === 'Climber');
  check('library: a file outside its own folder is never healthy', !climber || !S.lib.health(climber).ok, climber && JSON.stringify(S.lib.health(climber)));
  const listing0 = P.listing();
  const cl = listing0.items.find((i) => i.title === 'Climber');
  check('listing: a thumbnail outside its own folder is not shown', !cl || cl.thumbUrl === null, cl && cl.thumbUrl);
  const reasons = listing0.items.map((i) => i.health.reason).join(' | ');
  check('listing: health reasons carry no paths', !/[A-Za-z]:\\|\\\\/.test(reasons) && !reasons.includes(TMP), reasons);

  /* ---- reload keeps the unicode one; a hostile id in library.json is dropped ---------------- */
  const libFile = path.join(USERDATA, 'wallpapers', 'library.json');
  const saved = JSON.parse(fs.readFileSync(libFile, 'utf8'));
  const L2 = new WL.Library(path.join(TMP, 'lib2'));
  w(L2.file, JSON.stringify(Object.assign({}, saved, { items: saved.items.concat([{ id: '..', title: 'evil', type: 'picture', entry: 'x.png' }, { id: 'a\\..\\..\\b', title: 'evil2', type: 'picture', entry: 'x' }]) })));
  L2.load();
  check('library: ids that are not plain folder names are dropped on load', L2.data.items.every((i) => safe(i.id)) && L2.data.items.length === saved.items.length, L2.data.items.map((i) => i.id).join(' '));
  check('library: dropping them is said, not silent', /damaged/.test(L2.loadError || ''), L2.loadError);
  check('library: the unicode wallpaper survives a reload', !!uni && L2.data.items.some((i) => i.id === uni.id));

  /* ---- mantle-wp:// ------------------------------------------------------------------------ */
  const mk = (u) => ({ url: u, headers: new Headers() });
  const webItem = S.lib.get('web00001.ccc');
  const r1 = await protoHandler(mk('mantle-wp://web00001.ccc/index.html'));
  const body = await r1.text();
  check('protocol: serves a web wallpaper with the shim first in its head', r1.status === 200 && body.includes('__mantle__/lively-shim.js'), r1.status);
  const r2 = await protoHandler(mk('mantle-wp://web00001.ccc/..%2f..%2flibrary.json'));
  const r3 = await protoHandler(mk('mantle-wp://web00001.ccc/..%5c..%5clibrary.json'));
  check('protocol: an escape from the wallpaper folder is refused (403)', r2.status === 403 && r3.status === 403, `${r2.status} ${r3.status}`);
  // A standard scheme's host arrives lower-cased: an id with capitals must still resolve.
  webItem.id = 'Web00001.CCC';
  fs.renameSync(path.join(USERDATA, 'wallpapers', 'web00001.ccc'), path.join(USERDATA, 'wallpapers', 'Web00001.CCC'));
  const r4 = await protoHandler(mk('mantle-wp://web00001.ccc/index.html'));
  check('protocol: an id with capitals is found from its lower-cased host', r4.status === 200, r4.status);
  const r5 = await protoHandler(mk('mantle-wp://nope/index.html'));
  const t5 = await r5.text();
  check('protocol: a 404 names no path', r5.status === 404 && !t5.includes(TMP), t5);

  /* ---- the Wallpapers window's commands: arguments are checked ----------------------------- */
  const sizeBefore = S.runtime.size;
  const e1 = await throws(C['wallpaper.status']({ id: 'made-up-' + Date.now(), state: 'playing' }));
  const e2 = await throws(C['wallpaper.status']({ id: 'pic00001.bbb', state: 'bogus' }));
  check('status: an id that is not in the library is refused', !!e1 && S.runtime.size === sizeBefore, e1);
  check('status: an unknown state is refused', !!e2, e2);
  const e3 = await throws(C['wallpaper.thumb']({ id: 'pic00001.bbb', dataUrl: 'data:image/jpeg;base64,' + 'A'.repeat(5 * 1024 * 1024) }));
  check('thumb: a 5 MB "thumbnail" is refused', !!e3 && /too big/.test(e3), e3);

  const outsideLib = path.join(TMP, 'drop');
  w(path.join(outsideLib, 'PrivateName.png'), PNG);
  const addR = await C['wallpaper.add']({ paths: [
    '\\\\no-such-host.invalid\\share\\x.mp4',
    'relative\\x.mp4',
    path.join(USERDATA, 'wallpapers', 'pic00001.bbb', 'pic.png'),
    TMP,
    42,
    path.join(outsideLib, 'PrivateName.png'),
  ] });
  const res = addR.results || [];
  check('add: a network share path is refused before it is opened', res[0] && !res[0].ok && /network share/.test(res[0].reason), res[0] && res[0].reason);
  check('add: a relative path is refused', res[1] && !res[1].ok && /full path/.test(res[1].reason), res[1] && res[1].reason);
  check('add: a file already inside the library is refused', res[2] && !res[2].ok && /already inside/.test(res[2].reason), res[2] && res[2].reason);
  check('add: a folder holding the library is refused', res[3] && !res[3].ok && /holds Mantle/.test(res[3].reason), res[3] && res[3].reason);
  check('add: a non-string is refused, not thrown', res[4] && !res[4].ok, res[4] && res[4].reason);
  check('add: a real picture is added', res[5] && res[5].ok === true, res[5] && res[5].reason);
  const many = await C['wallpaper.add']({ paths: Array.from({ length: 150 }, (_, i) => path.join(outsideLib, `none${i}.png`)) });
  check('add: more than 100 at once is capped and said', (many.results || []).length === 101 && /only 100/.test(many.results[0].reason), (many.results || []).length);

  /* ---- a zip's name can never run code ------------------------------------------------------ */
  if (process.platform === 'win32') {
    const zsrc = path.join(TMP, 'zsrc');
    w(path.join(zsrc, 'index.html'), '<!doctype html><html><head></head><body>z</body></html>');
    const zdir = path.join(TMP, 'z');
    fs.mkdirSync(zdir, { recursive: true });
    const plain = path.join(zdir, 'x.zip');
    execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', 'Compress-Archive -LiteralPath $env:ZS -DestinationPath $env:ZD'],
      { env: Object.assign({}, process.env, { ZS: path.join(zsrc, 'index.html'), ZD: plain }), stdio: 'ignore' });
    // x.zip<U+2019>;ni pwned;#.zip  -- straight-quote escaping missed the curly quote PowerShell also ends a string at.
    const evil = path.join(zdir, 'x.zip\u2019;ni pwned;#.zip');
    fs.copyFileSync(plain, evil);
    const zr = await C['wallpaper.add']({ paths: [evil] });
    const pwned = fs.existsSync(path.join(CWD, 'pwned'));
    check('zip: a curly quote in its name does not run code', !pwned, 'a file named "pwned" was created by the zip\'s name');
    check('zip: that zip is still added as a web wallpaper', zr.results && zr.results[0] && zr.results[0].ok === true, zr.results && zr.results[0] && zr.results[0].reason);
  }

  /* ---- remove, with undo ------------------------------------------------------------------ */
  const beforeIds = S.lib.data.items.map((i) => i.id);
  const picDir = path.join(USERDATA, 'wallpapers', 'pic00001.bbb');
  const rm = await C['wallpaper.remove']({ id: 'pic00001.bbb' });
  check('remove: it leaves the library and its folder moves aside', !S.lib.get('pic00001.bbb') && !fs.existsSync(picDir) && rm.undoMs > 0, JSON.stringify(rm));
  const un = C['wallpaper.undoRemove'] ? await C['wallpaper.undoRemove']({ id: 'pic00001.bbb' }).catch((e) => ({ err: e.message })) : { err: 'no undo command' };
  check('undo: it comes back where it was, with its files', un.ok === true && fs.existsSync(path.join(picDir, 'pic.png')) && S.lib.data.items.map((i) => i.id).join() === beforeIds.join(), JSON.stringify(un));
  // The selected one: the desktop moves off it first, and undo puts it back on the desktop.
  const selBefore = S.lib.data.selected;
  await C['wallpaper.remove']({ id: selBefore });
  const moved = S.lib.data.selected !== selBefore;
  const u2 = C['wallpaper.undoRemove'] ? await C['wallpaper.undoRemove']({ id: selBefore }).catch((e) => ({ err: e.message })) : { err: 'none' };
  check('undo: removing the wallpaper on screen moves the desktop off it, undo moves it back', moved && u2.ok === true && S.lib.data.selected === selBefore, JSON.stringify(u2));
  await C['wallpaper.remove']({ id: 'pic00001.bbb' });
  await sleep(900);
  const late = C['wallpaper.undoRemove'] ? await throws(C['wallpaper.undoRemove']({ id: 'pic00001.bbb' })) : 'none';
  const removedLeft = fs.existsSync(path.join(USERDATA, 'wallpapers', '.removed')) ? fs.readdirSync(path.join(USERDATA, 'wallpapers', '.removed')).length : 0;
  check('undo: after the undo window the folder is deleted and undo says it is too late', /too late/.test(late || '') && removedLeft === 0, `${late} left=${removedLeft}`);
  check('remove: a Lively one is remembered as removed (not re-imported)', S.lib.data.removed.includes('pic00001.bbb'));

  /* ---- the pause rules ---------------------------------------------------------------------- */
  const sel = S.lib.data.selected;
  check('pause: something is selected for the rule checks', !!sel, sel);
  fgReply = { hwnd: '42', exe: 'C:\\Games\\secretapp.exe', title: 'Secret Window Title', pid: 1, fullscreen: true, rect: [0, 0, 1920, 1080] };
  await P.checkNow();
  check('pause: a full-screen app in front pauses it', S.pause.paused === true && /full screen/.test(S.pause.reason), S.pause.reason);
  fgReply = { hwnd: '42', exe: 'C:\\x\\explorer.exe', title: 'Program Manager', pid: 1, fullscreen: true, rect: [0, 0, 1920, 1080] };
  await P.checkNow();
  check('pause: the desktop itself in front does not pause it', S.pause.paused === false, S.pause.reason);
  WP.rest('VALORANT runs');
  check('rest: a game unloads the wallpaper', desk.last('wallpaper.pause') && desk.last('wallpaper.pause').unload === true);
  WP.rest(null);
  await sleep(30);
  check('wake: after the game it is mounted again', desk.last('wallpaper.pause') && desk.last('wallpaper.pause').unload === false, JSON.stringify(desk.last('wallpaper.pause')));
  WP.gameHold('a game is running');
  await sleep(30);
  check('game hold: paused, not unloaded', S.pause.paused && !S.pause.unload, JSON.stringify(S.pause));
  WP.gameHold(null);
  await sleep(30);
  check('game hold: lets go', !S.pause.paused, S.pause.reason);

  // Sleep, then resume with NO wallpaper chosen: the sleep reason must still clear.
  const keepSel = S.lib.data.selected;
  S.lib.data.selected = null;
  pm.suspend && pm.suspend();
  check('sleep: pauses', S.pause.paused === true && /sleep/.test(S.pause.reason), S.pause.reason);
  pm.resume && pm.resume();
  await sleep(30);
  check('resume: with no wallpaper chosen the sleep pause still clears', S.pause.paused === false, S.pause.reason);
  S.lib.data.selected = keepSel;

  // The helper failing: plain words on screen, the error text only in the log.
  fgThrow = 'pipe closed at C:\\Users\\someone\\x';
  await P.checkNow();
  const pb = stateStore.wallpaper || {};
  check('rules: a failed front-window check says so without jargon', pb.rulesOk === false && !/sidecar|hwnd|ENOENT|undefined/i.test(pb.rulesReason || ''), pb.rulesReason);
  fgThrow = null;
  fgReply = { hwnd: '0', fullscreen: false };
  await P.checkNow();

  // ONE late answer is asked again on the next tick before it is said (lane r7-fg, 2026-10-01): at start
  // the helper's first window list held this check's queue for 1.4-1.6 s, and a check sent in the first
  // ~0.5 s missed its 1.5 s budget once. Two in a row are said as before; other failures at once.
  fgReply = { hwnd: '42', exe: 'C:\\Games\\secretapp.exe', title: 'Secret Window Title', pid: 1, fullscreen: true, rect: [0, 0, 1920, 1080] };
  await P.checkNow();
  const fullBefore = S.pause.paused === true && /full screen/.test(S.pause.reason);
  const lateMsg = 'the sidecar did not answer "foreground" within 2s';
  let mark = logged.length;
  fgThrow = lateMsg;
  await P.checkNow();
  const pbLate = stateStore.wallpaper || {};
  check('late answer: ONE is not said (no log line, the rules still read as checked)',
    fullBefore && !/could not check which window/.test(logged.slice(mark)) && pbLate.rulesOk !== false, logged.slice(mark) || pbLate.rulesReason);
  check('late answer: ONE keeps the wallpaper as it was (still paused behind the full-screen app)',
    S.pause.paused === true && /full screen/.test(S.pause.reason), S.pause.reason);
  await P.checkNow();
  const pbTwo = stateStore.wallpaper || {};
  check('late answer: TWO in a row are said, in plain words, once',
    (logged.slice(mark).match(/could not check which window is in front/g) || []).length === 1 && pbTwo.rulesOk === false
    && !/sidecar|hwnd|undefined/i.test(pbTwo.rulesReason || ''), logged.slice(mark));
  await P.checkNow();
  check('late answer: a third in a row is not said again', (logged.slice(mark).match(/could not check which window is in front/g) || []).length === 1, logged.slice(mark));
  fgThrow = null;
  await P.checkNow();
  check('late answer: the next answer clears it', (stateStore.wallpaper || {}).rulesOk === true && S.fgMissed === 0, (stateStore.wallpaper || {}).rulesReason);
  mark = logged.length;
  fgThrow = lateMsg;
  await P.checkNow();
  fgThrow = null;
  await P.checkNow();
  fgThrow = lateMsg;
  await P.checkNow();
  check('late answer: misses that are NOT in a row are never said', !/could not check which window/.test(logged.slice(mark)) && (stateStore.wallpaper || {}).rulesOk !== false, logged.slice(mark));
  fgThrow = null;
  await P.checkNow();
  mark = logged.length;
  fgThrow = 'pipe closed';
  await P.checkNow();
  check('other failures: said at once (not held for a second try)', /could not check which window is in front/.test(logged.slice(mark)), logged.slice(mark));
  fgThrow = null;
  fgReply = { hwnd: '0', fullscreen: false };
  await P.checkNow();

  // The budget: 1.5 s, but 4 s while the helper starts and for 5 s after its ready line (start or restart),
  // when the check waits behind everything Mantle asks for at start.
  const budgetAt = async (readyAt) => {
    if (readyAt === undefined) delete sidecar.readyAt; else sidecar.readyAt = readyAt;
    fgBudgets.length = 0;
    await P.checkNow();
    return fgBudgets[0];
  };
  const bNone = await budgetAt(undefined);
  const bStarting = await budgetAt(0);
  const bJust = await budgetAt(Date.now() - 300);
  const bLater = await budgetAt(Date.now() - 10000);
  delete sidecar.readyAt;
  check('budget: 4 s while the helper starts and just after; 1.5 s once it has settled or when it does not say',
    bStarting === 4000 && bJust === 4000 && bLater === 1500 && bNone === 1500, JSON.stringify({ bNone, bStarting, bJust, bLater }));

  // The Pause button.
  if (C['wallpaper.setPaused']) {
    await C['wallpaper.setPaused']({ paused: true });
    const held = S.pause.paused && /you paused it/.test(S.pause.reason);
    const onDisk = JSON.parse(fs.readFileSync(libFile, 'utf8')).userPaused === true;
    await C['wallpaper.setPaused']({ paused: false });
    await sleep(30);
    check('pause button: pauses, is saved, and plays again', held && onDisk && !S.pause.paused && P.listing().userPaused === false, S.pause.reason);
  } else check('pause button: pauses, is saved, and plays again', false, 'no wallpaper.setPaused command');

  // A new desktop window (explorer restart) gets the wallpaper at once.
  if (typeof WP.setDesktopWin === 'function') {
    const d2 = fakeWin();
    WP.setDesktopWin(d2);
    check('new desktop window: it is sent the wallpaper at once', !!d2.last('wallpaper') && d2.last('wallpaper').item && d2.last('wallpaper').item.id === S.lib.data.selected);
    WP.setDesktopWin(desk);
  } else check('new desktop window: it is sent the wallpaper at once', false, 'no setDesktopWin');

  /* ---- a huge library stays fast ------------------------------------------------------------ */
  const bulk = [];
  for (let i = 0; i < 400; i++) {
    const id = `bulk${i}`;
    w(path.join(USERDATA, 'wallpapers', id, 'p.png'), PNG);
    bulk.push({ id, title: `Bulk ${i}`, type: 'picture', entry: 'p.png', thumb: 'p.png', values: {}, origin: { from: 'added', path: '' }, addedAt: new Date().toISOString() });
  }
  S.lib.data.items.push(...bulk);
  const t0 = process.hrtime.bigint();
  const big = P.listing();
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  // A guard against a per-card cost blowing up, not a benchmark: 273-409 ms was measured on this
  // machine under a ~35-agent load (2026-09-29), so the line is set at 1 s.
  check('listing: 400+ wallpapers list in under 1 s', big.items.length > 400 && ms < 1000, `${ms.toFixed(0)} ms`);
  S.lib.data.items = S.lib.data.items.filter((i) => !/^bulk/.test(i.id));

  /* ---- the built-in wallpapers (lane mantle-bg-presets) ------------------------------------- */
  // Helm's 23 photos in assets/backgrounds/, read from the REAL folder (never written). Picked through
  // the same wallpaper.set and saved in library.json's `selected`; never copied into the library.
  if (!C['wallpaper.shuffle']) check('built-in: the presets are wired in', false, 'no wallpaper.shuffle command');
  else {
    const PR = require(path.join(LIBDIR, 'wallpaper-presets.js'));
    const REALDIR = PR.dirFor(path.resolve(LIBDIR, '..'));
    const libIds = S.lib.data.items.map((i) => i.id);
    const L0 = P.listing();
    check('built-in: listed apart from the library, 23 photos in 10 categories', L0.presets && L0.presets.ok && L0.presets.items.length === 23 && L0.presets.categories.length === 10,
      L0.presets && JSON.stringify({ ok: L0.presets.ok, n: L0.presets.items.length, reason: L0.presets.reason }));
    check('built-in: never mixed into their library list', L0.items.every((i) => !PR.isPresetId(i.id)) && L0.items.length === libIds.length);
    check('built-in: each card has a thumb, a category and a credit', L0.presets.items.every((x) => /^file:\/\/.+\/thumbs\//.test(x.thumbUrl) && x.category && x.credit && x.health.ok && x.typeLabel === 'Picture'));
    const fileOf = (name) => require('url').pathToFileURL(path.join(REALDIR, name)).href;

    await C['wallpaper.set']({ id: 'builtin:stone' });
    const libJson = () => JSON.parse(fs.readFileSync(path.join(USERDATA, 'wallpapers', 'library.json'), 'utf8'));
    let dp = desk.last('wallpaper');
    check('built-in: picking one makes it the wallpaper (selected, saved)', S.lib.data.selected === 'builtin:stone' && libJson().selected === 'builtin:stone');
    check('built-in: the desktop is sent that photo, filling the screen', dp && dp.ok && dp.item && dp.item.id === 'builtin:stone' && dp.item.type === 'picture' && dp.item.url === fileOf('stone.jpg') && dp.item.look.fit === 'cover' && !dp.item.look.filter,
      JSON.stringify(dp && dp.item));
    let Ls = P.listing();
    check('built-in: the listing marks it, and only it', Ls.presets.items.filter((x) => x.selected).map((x) => x.id).join() === 'builtin:stone' && !Ls.items.some((x) => x.selected));
    check('built-in: `current` describes it with its credit', Ls.current && Ls.current.preset && Ls.current.title === 'Stone summit' && Ls.current.credit === 'Fabrizio Conti' && /^https:\/\/unsplash\.com\//.test(Ls.current.creditUrl) && Ls.current.category === 'Mountains',
      JSON.stringify(Ls.current));
    check('built-in: nothing was copied into the library folder', !fs.readdirSync(path.join(USERDATA, 'wallpapers')).some((f) => /builtin|stone/i.test(f)) && S.lib.data.items.length === libIds.length);
    await C['wallpaper.status']({ id: 'builtin:stone', state: 'playing' });
    check('built-in: the desktop\'s "playing" is accepted for it and shown', stateStore.wallpaper && stateStore.wallpaper.ok && stateStore.wallpaper.id === 'builtin:stone' && /"Stone summit" is playing/.test(stateStore.wallpaper.reason), JSON.stringify(stateStore.wallpaper));

    await C['wallpaper.set']({ id: 'builtin:night-fjord' });
    dp = desk.last('wallpaper');
    check('built-in: a second pick replaces the first', S.lib.data.selected === 'builtin:night-fjord' && libJson().selected === 'builtin:night-fjord' && dp.item.url === fileOf('night-fjord.jpg'));
    const reload = new (require(path.join(LIBDIR, 'wallpaper-lively.js')).Library)(path.join(USERDATA, 'wallpapers'), { keepSelected: PR.isPresetId });
    reload.load();
    check('built-in: the pick survives a reload of library.json (a restart)', reload.data.selected === 'builtin:night-fjord' && !reload.loadError);

    check('built-in: Remove refuses it, in words', /built-in wallpapers: it cannot be removed or changed/.test(await throws(C['wallpaper.remove']({ id: 'builtin:night-fjord' })) || ''));
    check('built-in: customising refuses it, in words', /built-in/.test(await throws(C['wallpaper.props']({ id: 'builtin:night-fjord' })) || '') && /built-in/.test(await throws(C['wallpaper.prop']({ id: 'builtin:night-fjord', name: 'x', value: 1 })) || ''));
    check('built-in: an unknown built-in id is refused with the reason', /no longer one of Mantle's built-in wallpapers/.test(await throws(C['wallpaper.set']({ id: 'builtin:not-a-photo' })) || '') && S.lib.data.selected === 'builtin:night-fjord');
    check('built-in: a malformed one is not mistaken for a preset', /there is no wallpaper/.test(await throws(C['wallpaper.set']({ id: 'builtin:../x' })) || ''));

    const before = S.lib.data.selected;
    const sh = await C['wallpaper.shuffle']({ category: 'Snow' });
    check('shuffle: sets a different photo from that category', sh.ok && /^builtin:snow-/.test(sh.id) && sh.id !== before && S.lib.data.selected === sh.id && desk.last('wallpaper').item.id === sh.id, JSON.stringify(sh));
    const sh2 = await C['wallpaper.shuffle']({});
    check('shuffle: with no category, any photo but the current one', sh2.ok && PR.isPresetId(sh2.id) && sh2.id !== sh.id);
    check('shuffle: an unknown category is refused, in words', /no built-in category "Nope"/.test(await throws(C['wallpaper.shuffle']({ category: 'Nope' })) || ''));

    const co = await C['wallpaper.creditOpen']({ id: 'builtin:stone' });
    check('credit: a test run opens nothing and says what it would open', co.ok && co.dryRun && /^https:\/\/unsplash\.com\//.test(co.url) && /Test run, nothing opened/.test(co.reason), JSON.stringify(co));
    check('credit: only a built-in one has a photo page', /only a built-in wallpaper has a photo page/.test(await throws(C['wallpaper.creditOpen']({ id: libIds[0] })) || ''));

    // A photo that goes missing: point the catalog at a damaged copy, the way a broken install would be.
    const DMG = path.join(TMP, 'presets-damaged');
    fs.mkdirSync(path.join(DMG, 'thumbs'), { recursive: true });
    for (const f of fs.readdirSync(REALDIR)) if (/\.(jpg|json)$/.test(f)) fs.copyFileSync(path.join(REALDIR, f), path.join(DMG, f));
    for (const f of fs.readdirSync(path.join(REALDIR, 'thumbs'))) fs.copyFileSync(path.join(REALDIR, 'thumbs', f), path.join(DMG, 'thumbs', f));
    const realCat = S.presets;
    S.presets = PR.load(DMG);
    await C['wallpaper.set']({ id: 'builtin:lake' });
    fs.unlinkSync(path.join(DMG, 'lake.jpg'));
    fs.unlinkSync(path.join(DMG, 'forest.jpg'));
    const Lm = P.listing();
    const lakeCard = Lm.presets.items.find((x) => x.id === 'builtin:lake');
    check('missing photo: its card says why', lakeCard && !lakeCard.health.ok && /"lake\.jpg" is missing/.test(lakeCard.health.reason), JSON.stringify(lakeCard && lakeCard.health));
    const dpm = (() => { P.desktopPayload(); return P.desktopPayload(); })();
    check('missing photo on the desktop: not ok, with the reason (never just black)', !dpm.ok && /"Quiet lake" can't play: its photo "lake\.jpg" is missing/.test(dpm.reason), dpm.reason);
    check('missing photo: `current` still describes it, with the reason', Lm.current && Lm.current.id === 'builtin:lake' && !Lm.current.health.ok);
    check('missing photo: picking another missing one is refused, in words', /"Misty forest" cannot play: its photo "forest\.jpg" is missing/.test(await throws(C['wallpaper.set']({ id: 'builtin:forest' })) || ''));
    S.presets = PR.load(path.join(TMP, 'no-such-folder'));
    const Ln = P.listing();
    check('no catalog: the Built-in list is not ok, with the reason', !Ln.presets.ok && /catalog\.json\) is missing/.test(Ln.presets.reason) && Ln.presets.items.length === 0);
    check('no catalog: the saved pick says the catalog is why', Ln.current && !Ln.current.health.ok && /cannot be read/.test(Ln.current.health.reason));
    check('no catalog: Shuffle is refused, in words', /built-in wallpapers cannot be read/.test(await throws(C['wallpaper.shuffle']({})) || ''));
    S.presets = realCat;

    // Back to one of their own: the library item plays again, nothing of theirs was changed.
    await C['wallpaper.set']({ id: sel });
    dp = desk.last('wallpaper');
    const Lb = P.listing();
    check('switch back: one of their own is the wallpaper again', S.lib.data.selected === sel && libJson().selected === sel && dp.item && dp.item.id === sel && !dp.item.preset && Lb.current && !Lb.current.preset);
    check('switch back: no built-in card is marked', !Lb.presets.items.some((x) => x.selected));
    check('switch back: their library is exactly as it was', JSON.stringify(S.lib.data.items.map((i) => i.id)) === JSON.stringify(libIds));
  }

  /* ---- the log: ids, counts and kinds only --------------------------------------------------- */
  await C['wallpaper.status']({ id: sel, state: 'error', reason: 'failed at C:\\Users\\someone\\PrivateName.mp4' }).catch(() => {});
  await C['wallpaper.set']({ id: sel }).catch(() => {});
  const leaks = ['SecretTitle', 'PrivateName', 'Secret Window', 'secretapp', TMP, 'someone', '壁纸'].filter((x) => logged.includes(x));
  check('log: no titles, file names, window titles or paths', !leaks.length, leaks.join(', '));
  check('log: something was logged (the capture works)', /mantle: wallpaper: /.test(logged));
}

main().catch((err) => failures.push('crashed: ' + (err && err.stack ? err.stack.split('\n').slice(0, 3).join(' / ') : err))).finally(() => {
  process.stdout.write = realWrite;
  process.chdir(os.tmpdir());
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* a video handle still open: the temp cleaner gets it */ }
  for (const f of failures) console.log('  FAIL ' + f);
  console.log(`WALLPAPER LIB TEST${BASE ? ' (against ' + BASE + ')' : ''}: ${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
});

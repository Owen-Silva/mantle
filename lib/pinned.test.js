'use strict';
/* pinned.test.js — plain node, no Electron, no sidecar, nothing launched.
 *
 * WHY fixtures here and not the real folder (the opposite of
 * launcher-index.test.js): the failures that matter in pinned.js are FORMAT
 * failures — a LinkInfo with the Unicode path pair, a shortcut with only an
 * IDList, a file full of junk, a Favorites blob that names some pins and not
 * others. Owen's real taskbar happens to contain none of those today, so a
 * real-folder-only test would pass while every interesting branch rotted.
 *
 * So: the unit tests build .lnk bytes BY HAND (the writer below shares no code
 * with the reader in pinned.js, which is the whole point — if both drifted the
 * same way the test would still pass), point a fake %APPDATA% at them, and
 * inject the registry blob through _readFavorites so the tests never touch
 * HKCU. Then ONE smoke pass runs against the real pins folder, which is the
 * only part allowed to read the real registry, read-only, via reg.exe.
 *
 *   node lib/pinned.test.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { listPinned, watchPins } = require('./pinned');

let passed = 0, failed = 0;
const failures = [];
function ok(cond, label) {
  if (cond) passed++;
  else { failed++; failures.push(label); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---- a .lnk writer, deliberately independent of the reader --------------- */

const CLSID = Buffer.from([
  0x01, 0x14, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00,
  0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46,
]);

function u16(s) {                         // a StringData entry, IsUnicode set
  const body = Buffer.from(s, 'utf16le');
  const head = Buffer.alloc(2);
  head.writeUInt16LE(s.length, 0);        // CountCharacters, not bytes
  return Buffer.concat([head, body]);
}

function idListBlock() {                  // one dummy ItemID + the terminator
  const body = Buffer.from([0x06, 0x00, 0xAA, 0xBB, 0xCC, 0xDD, 0x00, 0x00]);
  const size = Buffer.alloc(2);
  size.writeUInt16LE(body.length, 0);
  return Buffer.concat([size, body]);
}

function linkInfoAnsi(target) {           // LinkInfoHeaderSize 0x1C: ANSI only
  const p = Buffer.from(target + '\0', 'latin1');
  const localOff = 0x1C;
  const suffixOff = localOff + p.length;
  const size = suffixOff + 1;
  const b = Buffer.alloc(size);
  b.writeUInt32LE(size, 0x00);
  b.writeUInt32LE(0x1C, 0x04);            // LinkInfoHeaderSize
  b.writeUInt32LE(0x01, 0x08);            // VolumeIDAndLocalBasePath
  b.writeUInt32LE(0x00, 0x0C);            // VolumeIDOffset (omitted on purpose)
  b.writeUInt32LE(localOff, 0x10);
  b.writeUInt32LE(0x00, 0x14);
  b.writeUInt32LE(suffixOff, 0x18);
  p.copy(b, localOff);
  return b;
}

function linkInfoUnicode(ansiTarget, unicodeTarget) {   // header 0x24: both pairs
  const a = Buffer.from(ansiTarget + '\0', 'latin1');
  const u = Buffer.from(unicodeTarget + '\0', 'utf16le');
  const aOff = 0x24;
  const aSufOff = aOff + a.length;
  let uOff = aSufOff + 1;
  if (uOff % 2) uOff++;                   // keep the UTF-16 run 2-byte aligned
  const uSufOff = uOff + u.length;
  const size = uSufOff + 2;
  const b = Buffer.alloc(size);
  b.writeUInt32LE(size, 0x00);
  b.writeUInt32LE(0x24, 0x04);
  b.writeUInt32LE(0x01, 0x08);
  b.writeUInt32LE(0x00, 0x0C);
  b.writeUInt32LE(aOff, 0x10);
  b.writeUInt32LE(0x00, 0x14);
  b.writeUInt32LE(aSufOff, 0x18);
  b.writeUInt32LE(uOff, 0x1C);            // LocalBasePathOffsetUnicode
  b.writeUInt32LE(uSufOff, 0x20);
  a.copy(b, aOff);
  u.copy(b, uOff);
  return b;
}

function makeLnk(o) {
  const header = Buffer.alloc(0x4C);
  header.writeUInt32LE(0x4C, 0);
  CLSID.copy(header, 4);
  let flags = 0x00000080;                                 // IsUnicode
  const parts = [];
  if (o.idList) { flags |= 0x00000001; parts.push(idListBlock()); }
  if (o.linkInfo) { flags |= 0x00000002; parts.push(o.linkInfo); }
  const strings = [];
  if (o.name != null) { flags |= 0x00000004; strings.push(u16(o.name)); }
  if (o.relative != null) { flags |= 0x00000008; strings.push(u16(o.relative)); }
  if (o.workdir != null) { flags |= 0x00000010; strings.push(u16(o.workdir)); }
  if (o.args != null) { flags |= 0x00000020; strings.push(u16(o.args)); }
  if (o.icon != null) { flags |= 0x00000040; strings.push(u16(o.icon)); }
  header.writeUInt32LE(flags, 0x14);
  return Buffer.concat([header, ...parts, ...strings]);
}

/* ---- the fixture folder -------------------------------------------------- */

const NOTEPAD = 'C:\\Windows\\System32\\notepad.exe';
const CMD = 'C:\\Windows\\System32\\cmd.exe';
const EXPLORER = 'C:\\Windows\\explorer.exe';
const GHOST = 'C:\\Nope\\Uninstalled App\\ghost.exe';

const fakeAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'mantle-pins-'));
const fixtureDir = path.join(fakeAppData, 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'TaskBar');
fs.mkdirSync(fixtureDir, { recursive: true });

fs.writeFileSync(path.join(fixtureDir, 'notepad.lnk'), makeLnk({
  linkInfo: linkInfoAnsi(NOTEPAD), args: '/A note.txt', workdir: 'C:\\Windows',
}));
// the ANSI copy is deliberately WRONG, so only a reader that honours the
// Unicode pair at header size 0x24 gets cmd.exe back
fs.writeFileSync(path.join(fixtureDir, 'cmd.lnk'), makeLnk({
  idList: true, linkInfo: linkInfoUnicode('C:\\Windows\\System32\\WRONG.exe', CMD),
}));
fs.writeFileSync(path.join(fixtureDir, 'shell.lnk'), makeLnk({
  linkInfo: linkInfoAnsi(EXPLORER), icon: '%SystemRoot%\\System32\\shell32.dll,15',
}));
// a Store pin as Windows writes it: an IDList and nothing else
fs.writeFileSync(path.join(fixtureDir, 'calc-store.lnk'), makeLnk({ idList: true }));
// a pin left behind by an uninstall — resolves perfectly, points at nothing
fs.writeFileSync(path.join(fixtureDir, 'ghost.lnk'), makeLnk({ linkInfo: linkInfoAnsi(GHOST) }));
fs.writeFileSync(path.join(fixtureDir, 'broken.lnk'), Buffer.from('this is not a shortcut, it is junk'));
fs.writeFileSync(path.join(fixtureDir, 'desktop.ini'), '[.ShellClassInfo]\r\n');

/* A Favorites blob that names four of the five, in a deliberate order: three
   as UTF-16LE (what Explorer usually writes) and one as ANSI, to exercise the
   second try. broken.lnk is absent, so it must land last, alphabetically. */
function fakeFavorites(spec) {
  const chunks = [Buffer.alloc(24, 0x11)];
  for (const [name, enc] of spec) {
    chunks.push(Buffer.from(name, enc === 'ansi' ? 'latin1' : 'utf16le'));
    chunks.push(Buffer.alloc(12, 0x22));
  }
  return Buffer.concat(chunks);
}
const BLOB = fakeFavorites([
  ['cmd.lnk', 'utf16'], ['shell.lnk', 'utf16'], ['notepad.lnk', 'utf16'], ['calc-store.lnk', 'ansi'],
]);
const readBlob = async () => BLOB;
const readBlobFails = async () => { throw new Error('reg.exe could not read the Taskband key (the value is not there)'); };

/* The sidecar as lane D will answer it — including an AUMID for the Store pin
   and a per-item failure for the junk file. */
async function fakeSidecar(cmd, a) {
  if (cmd !== 'lnk') throw new Error('unknown command');
  return {
    items: a.paths.map(p => {
      const base = path.basename(p).toLowerCase();
      if (base === 'broken.lnk') return { path: p, ok: false, reason: 'IShellLink refused this file' };
      if (base === 'calc-store.lnk') {
        return { path: p, ok: true, target: null, args: '', workdir: '', iconPath: null, iconIndex: 0, aumid: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App' };
      }
      if (base === 'notepad.lnk') {
        return { path: p, ok: true, target: NOTEPAD, args: '--from-sidecar', workdir: 'C:\\Windows', iconPath: '%SystemRoot%\\System32\\imageres.dll', iconIndex: 2, aumid: null };
      }
      if (base === 'ghost.lnk') return { path: p, ok: true, target: GHOST, args: '', workdir: '', iconPath: null, iconIndex: 0, aumid: null };
      return { path: p, ok: true, target: base === 'cmd.lnk' ? CMD : EXPLORER, args: '', workdir: '', iconPath: null, iconIndex: 0, aumid: null };
    }),
  };
}
const sidecarGone = async () => { throw new Error('unknown command'); };

/* ---- the second fixture: Owen's REAL taskbar --------------------------- */

/* Captured once from the real Favorites blob on this machine (10,419 bytes,
   scanned for the UTF-16 runs Explorer writes) and frozen here, because the
   whole point of lane D's `pins` command is the five pins that have no .lnk
   file at all: Calculator, Settings, Terminal, a Store app and Xbox are absolute
   PIDLs into the Applications folder, so the folder scan can NEVER see them
   and a fixture built from .lnk files alone would prove nothing.
   NOTE: captured with a scratch blob scanner, not the sidecar — `pins` and
   `app` did not exist in sidecar/Program.cs when this was written. The kinds,
   names, AUMIDs and index order are real; re-capture from the sidecar once
   lane D lands to confirm its name strings match. */
const PINS_FIXTURE = [
  { index: 0, kind: 'lnk', name: 'Microsoft Edge', parsing: 'lnk', aumid: null, lnk: 'Microsoft Edge.lnk', iconPng: null },
  { index: 1, kind: 'app', name: 'Calculator', parsing: 'appsfolder', aumid: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App', lnk: null, iconPng: 'data:image/png;base64,CALC' },
  { index: 2, kind: 'lnk', name: 'File Explorer', parsing: 'lnk', aumid: null, lnk: 'File Explorer.lnk', iconPng: null },
  { index: 3, kind: 'app', name: 'Settings', parsing: 'appsfolder', aumid: 'windows.immersivecontrolpanel_cw5n1h2txyewy!microsoft.windows.immersivecontrolpanel', lnk: null, iconPng: null },
  { index: 4, kind: 'lnk', name: 'Spotify', parsing: 'lnk', aumid: null, lnk: 'Spotify.lnk', iconPng: null },
  { index: 5, kind: 'app', name: 'Terminal', parsing: 'appsfolder', aumid: 'Microsoft.WindowsTerminal_8wekyb3d8bbwe!App', lnk: null, iconPng: null },
  { index: 6, kind: 'lnk', name: 'Browser', parsing: 'lnk', aumid: null, lnk: 'Browser.lnk', iconPng: null },
  { index: 7, kind: 'app', name: 'Contoso Player', parsing: 'appsfolder', aumid: 'Contoso.Player_abc123xyz!App', lnk: null, iconPng: null },
  { index: 8, kind: 'lnk', name: 'Modrinth App', parsing: 'lnk', aumid: null, lnk: 'Modrinth App.lnk', iconPng: null },
  { index: 9, kind: 'lnk', name: 'Discord', parsing: 'lnk', aumid: null, lnk: 'Discord.lnk', iconPng: null },
  { index: 10, kind: 'lnk', name: 'Obsidian', parsing: 'lnk', aumid: null, lnk: 'Obsidian.lnk', iconPng: null },
  { index: 11, kind: 'app', name: 'Xbox', parsing: 'appsfolder', aumid: 'Microsoft.GamingApp_8wekyb3d8bbwe!Microsoft.Xbox.App', lnk: null, iconPng: null },
  { index: 12, kind: 'lnk', name: 'Riot Client', parsing: 'lnk', aumid: null, lnk: 'Riot Client.lnk', iconPng: null },
  // a pin the shell could not turn into an app: skipped, never shown
  { index: 13, kind: 'other', name: 'Downloads', parsing: 'folder', aumid: null, lnk: null, iconPng: null },
];
/* Comet.lnk is deliberately NOT in the fixture: it is in Owen's pins folder
   but appears nowhere in the real blob (verified: no UTF-16 and no ANSI hit),
   which is exactly the "shown last with a note" case. */
const REAL_LNKS = PINS_FIXTURE.filter(p => p.kind === 'lnk').map(p => p.lnk).concat(['Comet.lnk']);

const realAppData = fs.mkdtempSync(path.join(os.tmpdir(), 'mantle-real-'));
const realDir = path.join(realAppData, 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'TaskBar');
fs.mkdirSync(realDir, { recursive: true });
for (const n of REAL_LNKS) fs.writeFileSync(path.join(realDir, n), makeLnk({ linkInfo: linkInfoAnsi(NOTEPAD) }));

let appCalls = [];
function realSidecar({ pinsOk = true, appIcons = true } = {}) {
  return async (cmd, a) => {
    if (cmd === 'pins') {
      if (!pinsOk) throw new Error('unknown command');
      ok(typeof a.blob === 'string' && a.blob.length > 0, 'the pins command is given the blob as base64');
      return { ok: true, items: PINS_FIXTURE, skipped: 1, reason: 'Downloads is a folder, not an app' };
    }
    if (cmd === 'app') {
      appCalls.push(a.aumid);
      if (!appIcons) return { ok: false, aumid: a.aumid, name: null, iconPng: null, reason: 'the app is not installed for this user' };
      if (/Contoso\.Player/.test(a.aumid)) return { ok: false, aumid: a.aumid, name: null, iconPng: null, reason: 'the app is not installed for this user' };
      return { ok: true, aumid: a.aumid, name: null, iconPng: 'data:image/png;base64,' + a.aumid.slice(0, 4) };
    }
    return fakeSidecar(cmd, a);
  };
}

const by = (items, id) => items.find(i => i.id === id);

(async () => {
  /* --- 1. the folder cannot be read at all: the ONE ok:false --- */
  const missing = await listPinned({ appData: path.join(fakeAppData, 'nope'), sidecarCall: fakeSidecar, _readFavorites: readBlob });
  ok(missing.ok === false, 'a missing pins folder gives ok:false');
  // names WHICH folder in words, never its path (the reason reaches the log; the path names the profile)
  ok(typeof missing.reason === 'string' && /pinned-apps folder is missing/.test(missing.reason) && missing.reason.indexOf(fakeAppData) < 0,
    'the missing-folder reason says which folder, in words and without its path (' + missing.reason + ')');
  ok(Array.isArray(missing.items) && missing.items.length === 0, 'a missing pins folder gives no items');

  /* --- 2. ordering from the blob --- */
  const sc = await listPinned({ appData: fakeAppData, sidecarCall: fakeSidecar, _readFavorites: readBlob });
  ok(sc.ok === true, 'a readable pins folder gives ok:true');
  ok(sc.reason === 'the Store-app pins are not shown: unknown command',
    'a sidecar without `pins` says so instead of silently showing only the .lnk pins (' + sc.reason + ')');
  ok(sc.items.length === 6, 'desktop.ini is ignored, all six .lnk files are kept (got ' + sc.items.length + ')');
  ok(sc.items.map(i => i.id).join(',') === 'cmd.lnk,shell.lnk,notepad.lnk,calc-store.lnk,broken.lnk,ghost.lnk',
    'blob order wins, unknown pins go last alphabetically (' + sc.items.map(i => i.id).join(',') + ')');
  ok(sc.items.every((i, n) => i.order === n), 'order is 0..n-1 in listed order');
  ok(new Set(sc.items.map(i => i.id)).size === 6, 'ids are unique');
  ok(sc.items.every(i => i.name && !/\.lnk$/i.test(i.name)), 'name drops the .lnk extension');

  /* --- 3. ordering falls back when the registry cannot be read --- */
  const noReg = await listPinned({ appData: fakeAppData, sidecarCall: fakeSidecar, _readFavorites: readBlobFails });
  ok(noReg.ok === true, 'an unreadable Taskband key does NOT fail the call');
  ok(/taskbar order unavailable: reg\.exe could not read/.test(noReg.reason || ''),
    'the order failure is reported in plain words (' + noReg.reason + ')');
  ok(noReg.items.map(i => i.id).join(',') === 'broken.lnk,calc-store.lnk,cmd.lnk,ghost.lnk,notepad.lnk,shell.lnk',
    'without the blob the order is alphabetical (' + noReg.items.map(i => i.id).join(',') + ')');

  /* --- 4. the sidecar path --- */
  const np = by(sc.items, 'notepad.lnk');
  ok(np.args === '--from-sidecar', 'the sidecar record wins over the file bytes');
  ok(np.exe === NOTEPAD.toLowerCase(), 'exe is the lowercased real path (' + np.exe + ')');
  ok(np.iconPath === path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'imageres.dll') && np.iconIndex === 2,
    '%VARS% are expanded in the icon path (' + np.iconPath + ',' + np.iconIndex + ')');
  const calc = by(sc.items, 'calc-store.lnk');
  ok(calc.aumid === 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App' && calc.target === null && calc.reason === null,
    'a Store pin resolves to an AUMID with no target and no complaint');
  const brokenA = by(sc.items, 'broken.lnk');
  ok(brokenA.target === null && brokenA.reason === 'IShellLink refused this file',
    'a per-item sidecar failure keeps the item and its reason (' + JSON.stringify(brokenA.reason) + ')');
  const ghostA = by(sc.items, 'ghost.lnk');
  ok(ghostA.target === GHOST && ghostA.exe === null && /the app this pin points at is gone/.test(ghostA.reason || '') && (ghostA.reason || '').indexOf(GHOST) < 0,
    'a pin left by an uninstall keeps its target but says the app is gone (' + JSON.stringify(ghostA.reason) + ')');

  /* --- 5. the fallback path: an old sidecar that rejects --- */
  const fb = await listPinned({ appData: fakeAppData, sidecarCall: sidecarGone, _readFavorites: readBlob });
  ok(fb.ok === true, 'a rejecting sidecar does NOT fail the call');
  ok(/shortcuts read without the sidecar \(unknown command\)/.test(fb.reason || ''),
    'the sidecar fallback is reported (' + fb.reason + ')');
  ok(fb.items.map(i => i.id).join(',') === sc.items.map(i => i.id).join(','), 'the fallback keeps the same order');
  const fnp = by(fb.items, 'notepad.lnk');
  ok(fnp.target === NOTEPAD && fnp.args === '/A note.txt', 'ANSI LocalBasePath + arguments parsed (' + fnp.target + ')');
  ok(fnp.exe === NOTEPAD.toLowerCase(), 'exe comes back lowercased from the fallback too');
  ok(fnp.iconPath === NOTEPAD && fnp.iconIndex === 0, 'with no ICON_LOCATION the icon is the target at index 0');
  const fcmd = by(fb.items, 'cmd.lnk');
  ok(fcmd.target === CMD, 'the Unicode LocalBasePath (header 0x24) beats the ANSI copy (' + fcmd.target + ')');
  const fsh = by(fb.items, 'shell.lnk');
  ok(fsh.iconPath === path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'shell32.dll') && fsh.iconIndex === 15,
    'ICON_LOCATION is split and expanded (' + fsh.iconPath + ',' + fsh.iconIndex + ')');
  ok(fsh.target === EXPLORER, 'a shortcut with an icon location still resolves its target');
  const fcalc = by(fb.items, 'calc-store.lnk');
  ok(fcalc.target === null && fcalc.aumid === null && fcalc.reason === 'no file target (Store app?) and sidecar lnk unavailable',
    'an IDList-only pin is kept with the documented reason (' + JSON.stringify(fcalc.reason) + ')');
  ok(fcalc.exe === null, 'no target means no exe');
  const fghost = by(fb.items, 'ghost.lnk');
  ok(fghost.target === GHOST && fghost.exe === null && /the app this pin points at is gone/.test(fghost.reason || ''),
    'the fallback reports a gone app too (' + JSON.stringify(fghost.reason) + ')');
  const fbroken = by(fb.items, 'broken.lnk');
  ok(fbroken.target === null && typeof fbroken.reason === 'string' && /not a shortcut|too small/.test(fbroken.reason),
    'junk bytes keep the item with a parser reason (' + JSON.stringify(fbroken.reason) + ')');

  /* --- 6. no sidecar passed at all --- */
  const none = await listPinned({ appData: fakeAppData, _readFavorites: readBlob });
  ok(/no sidecar connection was passed/.test(none.reason || ''), 'a missing sidecar argument is reported, not assumed');
  ok(by(none.items, 'cmd.lnk').target === CMD, 'without a sidecar the parser still resolves targets');

  /* --- 7. watchPins on a missing folder: no throw, and it SAYS so --- */
  let threw = null;
  let unwatchMissing = null;
  try { unwatchMissing = watchPins(() => { ok(false, 'onChange must never fire for a missing folder'); }, { appData: path.join(fakeAppData, 'nope') }); }
  catch (err) { threw = err; }
  ok(threw === null, 'watchPins on a missing folder does not throw');
  ok(typeof unwatchMissing === 'function', 'watchPins still returns an unwatch function');
  unwatchMissing();                        // the no-op must also be safe to call
  const afterWatch = await listPinned({ appData: fakeAppData, sidecarCall: fakeSidecar, _readFavorites: readBlob });
  ok(/not being watched/.test(afterWatch.reason || ''),
    'the watch failure surfaces on the next listPinned (' + afterWatch.reason + ')');

  /* --- 8. watchPins on a real folder: debounced, and stoppable --- */
  let fired = 0;
  const unwatch = watchPins(() => { fired++; }, { appData: fakeAppData });
  fs.writeFileSync(path.join(fixtureDir, 'extra.lnk'), makeLnk({ linkInfo: linkInfoAnsi(NOTEPAD) }));
  fs.writeFileSync(path.join(fixtureDir, 'extra.lnk'), makeLnk({ linkInfo: linkInfoAnsi(CMD) }));
  await sleep(900);
  ok(fired === 1, 'two quick writes are debounced into one onChange (fired ' + fired + ')');
  unwatch();
  fs.unlinkSync(path.join(fixtureDir, 'extra.lnk'));
  await sleep(700);
  ok(fired === 1, 'unwatch really stops it (fired ' + fired + ')');
  const clean = await listPinned({ appData: fakeAppData, sidecarCall: fakeSidecar, _readFavorites: readBlob });
  ok(!/not being watched/.test(clean.reason || ''), 'a successful watch clears the earlier watch reason (' + clean.reason + ')');

  /* --- 8a. RE-ARM (quality pass 2026-09-29): a watch on a folder that is missing at start tries
     again, and when the folder appears it watches it AND fires once. FAILED before: the watch stayed
     dead for the whole run, so pins made after it were never seen until Mantle restarted. --- */
  const lateApp = path.join(fakeAppData, 'late');
  const lateDir = require('./pinned')._internals.pinsDir(lateApp);
  let lateFired = 0;
  const unLate = watchPins(() => { lateFired++; }, { appData: lateApp, retryMs: 150 });
  ok(/not being watched: is missing; trying again/.test(unLate.reason || '') && unLate.reason.indexOf(lateApp) < 0,
    'a missing folder is said in plain words, with no path (' + unLate.reason + ')');
  fs.mkdirSync(lateDir, { recursive: true });
  await sleep(900);                          // one retry (150 ms) + the debounce (500 ms)
  ok(lateFired === 1, 'the retry found the folder and fired once, so pins made meanwhile are read (fired ' + lateFired + ')');
  fs.writeFileSync(path.join(lateDir, 'late.lnk'), makeLnk({ linkInfo: linkInfoAnsi(CMD) }));
  await sleep(800);
  ok(lateFired === 2, 'the re-armed watch sees a new pin (fired ' + lateFired + ')');
  unLate();
  fs.unlinkSync(path.join(lateDir, 'late.lnk'));
  await sleep(700);
  ok(lateFired === 2, 'unwatch stops a re-armed watch too (fired ' + lateFired + ')');

  /* --- 8b. the whole taskbar: .lnk pins AND Store pins, in blob order --- */
  const allOpts = { appData: realAppData, _readFavorites: readBlob };
  appCalls = [];
  const all = await listPinned({ ...allOpts, sidecarCall: realSidecar() });
  ok(all.ok === true && all.items.length === 14, 'all 14 pins come back, not 9 (got ' + all.items.length + ')');
  ok(all.items.map(i => i.name).join(',') ===
    'Microsoft Edge,Calculator,File Explorer,Settings,Spotify,Terminal,Browser,Contoso Player,Modrinth App,Discord,Obsidian,Xbox,Riot Client,Comet',
    'blob order, apps interleaved with shortcuts (' + all.items.map(i => i.name).join(',') + ')');
  ok(all.items.every((p, n) => p.order === n), 'order is the position on the bar, 0..13');
  const appPins = all.items.filter(p => p.kind === 'app');
  ok(appPins.length === 5, 'the five Store pins are there (got ' + appPins.length + ')');
  ok(appPins.every(p => p.id === 'app:' + p.aumid && p.lnkPath === null && p.target === null && p.exe === null && p.iconPath === null),
    'app pins carry id app:<aumid> and no file fields');
  ok(by(all.items, 'app:Microsoft.WindowsCalculator_8wekyb3d8bbwe!App').name === 'Calculator', 'the app pin keeps the reply name');
  const lnkPins = all.items.filter(p => p.kind === 'lnk');
  ok(lnkPins.length === 9 && by(all.items, 'microsoft edge.lnk') && by(all.items, 'comet.lnk'),
    'the nine .lnk pins keep their old ids and gain kind:lnk');
  ok(all.items[13].id === 'comet.lnk' && /not in the saved taskbar list, shown last: Comet/.test(all.reason || ''),
    'a folder .lnk the blob never mentions lands last, with a note (' + all.reason + ')');
  ok(/1 taskbar entry is not apps: Downloads is a folder/.test(all.reason || ''),
    "the skipped 'other' entry is named, not silently dropped (" + all.reason + ')');

  // one `app` call per app pin that arrived without icon bytes, and no more
  ok(appCalls.length === 4 && new Set(appCalls).size === 4 && !appCalls.some(a => /Calculator/.test(a)),
    'the app command is called exactly once per iconless app pin (' + appCalls.length + ': ' + appCalls.join(' ') + ')');
  ok(by(all.items, 'app:Microsoft.WindowsCalculator_8wekyb3d8bbwe!App').iconPng === 'data:image/png;base64,CALC',
    'an icon already in the pins reply is used as is');
  ok(by(all.items, 'app:Microsoft.WindowsTerminal_8wekyb3d8bbwe!App').iconPng === 'data:image/png;base64,Micr',
    'a missing icon is filled from the app command');
  const player = by(all.items, 'app:Contoso.Player_abc123xyz!App');
  ok(player.iconPng === null && /^no icon for Contoso Player: .*not installed/.test(player.reason || '') && !/_abc123xyz|!App/.test(player.reason || ''),
    'an app with no icon anywhere keeps the pin and says why, by its NAME, not its app id (' + JSON.stringify(player.reason) + ')');

  /* --- 8c. an old sidecar: nine pins, and the miss named out loud --- */
  appCalls = [];
  const old = await listPinned({ ...allOpts, sidecarCall: realSidecar({ pinsOk: false }) });
  ok(old.ok === true && old.items.length === 9, 'without `pins` the .lnk pins still list (got ' + old.items.length + ')');
  ok(old.items.every(p => p.kind === 'lnk'), 'the fallback list is all .lnk pins');
  ok(/the Store-app pins are not shown: unknown command/.test(old.reason || ''),
    'never a silent 9-of-14 (' + old.reason + ')');
  ok(appCalls.length === 0, 'no app calls are made when there are no app pins');

  /* --- 9. smoke: the REAL taskbar, real reg.exe, read-only, no sidecar --- */
  const real = await listPinned({});
  // PRIVACY (quality pass, 2026-09-29): counts and shapes only, never a pin's name, path or the
  // profile folder (this used to print every pin's program path, the user name inside each).
  const nExe = real.items.filter(i => i.exe).length;
  const nApp = real.items.filter(i => !i.exe && i.aumid).length;
  console.log('  real pins: ok=' + real.ok + ', ' + real.items.length + ' pins (' + nExe + ' programs, ' + nApp +
    ' app ids, ' + (real.items.length - nExe - nApp) + ' unresolved)' + (real.reason ? ', with a note of ' + real.reason.length + ' chars' : ''));
  ok(real.ok === true, 'the real pins folder reads (' + real.reason + ')');
  ok(real.items.length > 0, 'the real taskbar has pins (got ' + real.items.length + ')');
  ok(real.items.every(i => typeof i.id === 'string' && typeof i.name === 'string' && typeof i.lnkPath === 'string' &&
    Number.isInteger(i.order) && 'target' in i && 'exe' in i && 'aumid' in i && 'iconPath' in i && 'iconIndex' in i),
    'every real item has the full shape lane A codes against');
  ok(real.items.some(i => i.exe), 'at least one real pin resolved to an executable');
  ok(real.items.every((i, n) => i.order === n), 'real items come back sorted by order');

  for (const d of [fakeAppData, realAppData]) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* temp dir, Windows may hold it */ }
  }

  /* --- Owen's own apps say their own names (mn-focus, 10-12): his "Browser.lnk" pin is Quartz --- */
  const { pinName } = require('./pinned')._internals;
  ok(pinName('Browser.lnk', 'C:\\Users\\x\\AppData\\Local\\Programs\\Quartz\\Quartz.exe') === 'Quartz', 'a pin whose target is Quartz.exe is called Quartz, whatever the shortcut is named');
  ok(pinName('helm thing.lnk', 'C:\\apps\\Helm.exe') === 'Helm', 'a pin whose target is Helm.exe is called Helm');
  ok(pinName('Google Chrome.lnk', 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe') === 'Google Chrome', 'any other pin keeps its shortcut name');
  ok(pinName('Terminal.lnk', null) === 'Terminal', 'a pin with no file target keeps its shortcut name');

  if (failures.length) for (const f of failures) console.log('  FAIL: ' + f);
  console.log('PINNED TEST: ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch(err => {
  console.log('  FAIL: the test itself threw — ' + ((err && err.stack) || err));
  console.log('PINNED TEST: ' + passed + ' passed, ' + (failed + 1) + ' failed');
  process.exit(1);
});

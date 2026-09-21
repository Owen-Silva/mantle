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

const by = (items, id) => items.find(i => i.id === id);

(async () => {
  /* --- 1. the folder cannot be read at all: the ONE ok:false --- */
  const missing = await listPinned({ appData: path.join(fakeAppData, 'nope'), sidecarCall: fakeSidecar, _readFavorites: readBlob });
  ok(missing.ok === false, 'a missing pins folder gives ok:false');
  ok(typeof missing.reason === 'string' && missing.reason.includes('User Pinned'),
    'the missing-folder reason names the folder (' + missing.reason + ')');
  ok(Array.isArray(missing.items) && missing.items.length === 0, 'a missing pins folder gives no items');

  /* --- 2. ordering from the blob --- */
  const sc = await listPinned({ appData: fakeAppData, sidecarCall: fakeSidecar, _readFavorites: readBlob });
  ok(sc.ok === true, 'a readable pins folder gives ok:true');
  ok(sc.reason === null, 'a fully successful list has no reason (' + sc.reason + ')');
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
  ok(ghostA.target === GHOST && ghostA.exe === null && /the app this pin points at is gone/.test(ghostA.reason || ''),
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
  ok(clean.reason === null, 'a successful watch clears the earlier watch reason (' + clean.reason + ')');

  /* --- 9. smoke: the REAL taskbar, real reg.exe, read-only, no sidecar --- */
  const real = await listPinned({});
  console.log('  real pins folder: ' + require('./pinned')._internals.pinsDir());
  console.log('  ok=' + real.ok + (real.reason ? '  reason: ' + real.reason : ''));
  for (const it of real.items) {
    console.log('  ' + String(it.order).padStart(2) + '  ' + it.name.padEnd(18) +
      (it.exe || it.aumid || ('— ' + (it.reason || 'unresolved'))));
  }
  ok(real.ok === true, 'the real pins folder reads (' + real.reason + ')');
  ok(real.items.length > 0, 'the real taskbar has pins (got ' + real.items.length + ')');
  ok(real.items.every(i => typeof i.id === 'string' && typeof i.name === 'string' && typeof i.lnkPath === 'string' &&
    Number.isInteger(i.order) && 'target' in i && 'exe' in i && 'aumid' in i && 'iconPath' in i && 'iconIndex' in i),
    'every real item has the full shape lane A codes against');
  ok(real.items.some(i => i.exe), 'at least one real pin resolved to an executable');
  ok(real.items.every((i, n) => i.order === n), 'real items come back sorted by order');

  try { fs.rmSync(fakeAppData, { recursive: true, force: true }); } catch (_) { /* temp dir, Windows may hold it */ }

  if (failures.length) for (const f of failures) console.log('  FAIL: ' + f);
  console.log('PINNED TEST: ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch(err => {
  console.log('  FAIL: the test itself threw — ' + ((err && err.stack) || err));
  console.log('PINNED TEST: ' + passed + ' passed, ' + (failed + 1) + ' failed');
  process.exit(1);
});

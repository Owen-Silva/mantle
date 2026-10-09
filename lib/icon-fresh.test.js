'use strict';
/*
 * icon-fresh.test.js - a rebuilt app's icon is asked for again, on the bar and in the launcher
 * (mantle-icon, 2026-10-08). Owen's bar kept Helm's old picture after helm.exe was rebuilt at the
 * same path, because every icon cache kept its first answer until Mantle restarted.
 *
 *   node lib/icon-fresh.test.js
 *
 * 1. lib/icon-fresh.js on its own: stamps, the 2 s stat throttle, the re-ask age, stale is sticky.
 * 2. lib/launcher-index.js fillIcons (the REAL function) with a fake sidecar: a changed .lnk is asked
 *    again in the background while its old picture keeps showing; a failed re-ask keeps the picture.
 * 3. main.js iconFor (the REAL source, cut out of main.js and run with a fake sidecar): a rewritten exe
 *    is asked again; a sidecar that cannot be asked never takes a picture off the bar.
 * No Electron, no sidecar, no real app paths: temp files only.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const F = require('./icon-fresh');

let passed = 0, failed = 0;
const failures = [];
function ok(cond, name) { if (cond) passed++; else { failed++; failures.push(name); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mantle-iconfresh-'));
const file = path.join(dir, 'App.exe');
/** Rewrite the file with new bytes and a write time `secs` later (what a rebuild does). */
function rebuild(p, text, secs) {
  fs.writeFileSync(p, text);
  const t = new Date(Date.now() + secs * 1000);
  fs.utimesSync(p, t, t);
}

(async () => {
  // ---- 1. icon-fresh on its own ------------------------------------------------------------------
  rebuild(file, 'one', 0);
  const s1 = F.fileStamp(file);
  rebuild(file, 'two!', 5);
  const s2 = F.fileStamp(file);
  ok(typeof s1 === 'string' && s1 !== s2, 'a rewritten file has a new stamp (' + s1 + ' -> ' + s2 + ')');
  ok(F.fileStamp(path.join(dir, 'nope.exe')) === 'missing', 'a missing file stamps as missing');
  ok(F.fileStamp(dir) === 'not-a-file', 'a folder stamps as not-a-file');
  ok(F.fileStamp('shell:AppsFolder\\Microsoft.WindowsCalculator_8wekyb3d8bbwe!App') === null, 'a Store app id has no stamp (not a file path)');
  ok(F.fileStamp(null) === null && F.fileStamp('') === null, 'no path has no stamp');

  let stats = 0;
  const statSync = (p) => { stats++; return fs.statSync(p); };
  const e = F.stamp({ icon: 'A' }, file, { now: 1000, statSync });
  ok(e.icon === 'A' && e.stamp === s2 && e.askedAt === 1000 && e.stale === false, 'stamp() keeps the fields and records the stamp and time');
  stats = 0;
  ok(F.isFresh(e, file, { now: 2000, statSync }) && stats === 0, 'within 2 s an entry is fresh without a stat');
  ok(F.isFresh(e, file, { now: 3100, statSync }) && stats === 1, 'after 2 s it stats once, and an unchanged file stays fresh');
  ok(F.isFresh(e, file, { now: 4000, statSync }) && stats === 1, '...and the next 2 s need no stat again');
  ok(!F.isFresh(e, file, { now: 3100 + 60000, recheckMs: 60000, statSync }), 'an entry older than recheckMs is due again');
  rebuild(file, 'three', 10);
  ok(F.isFresh(e, file, { now: 5000, statSync }), 'a change inside the 2 s window is not seen yet (one stat per 2 s at most)');
  ok(!F.isFresh(e, file, { now: 5200, statSync }) && e.stale === true, 'after it, the changed file makes the entry stale');
  rebuild(file, 'two!', 5);
  ok(!F.isFresh(e, file, { now: 9000, statSync }), 'stale is sticky: it is asked again even if the stamp looks the same later');
  ok(!F.isFresh(null, file) && !F.isFresh(undefined, file), 'no entry is never fresh');
  const store = F.stamp({ icon: 'S' }, 'shell:AppsFolder\\x_y!App', { now: 0 });
  ok(F.isFresh(store, 'shell:AppsFolder\\x_y!App', { now: 5000, recheckMs: 60000 }) &&
     !F.isFresh(store, 'shell:AppsFolder\\x_y!App', { now: 61000, recheckMs: 60000 }), 'a Store id is fresh by age only');

  // ---- 2. the launcher's fillIcons -----------------------------------------------------------------
  const LI = require('./launcher-index');
  const fill = LI._internals.fillIcons;
  const G = LI._internals.state;
  ok(typeof fill === 'function', 'launcher-index exports fillIcons for tests');
  G.icons.clear();
  const lnk = path.join(dir, 'App.lnk');
  rebuild(lnk, 'shortcut v1', 0);
  let pic = 'PIC-1', asks = 0, slow = 0, fail = false;
  const icon = async (p) => { asks++; if (slow) await sleep(slow); if (fail) throw new Error('sidecar timed out'); return p === lnk ? pic : null; };
  const it1 = { path: lnk, icon: undefined };
  await fill([it1], icon, 1000);
  ok(it1.icon === 'PIC-1' && asks === 1, 'first build: the shortcut gets its picture');
  const it2 = { path: lnk };
  await fill([it2], icon, 1000);
  ok(it2.icon === 'PIC-1' && asks === 1, 'next build, nothing changed: the cached picture, no ask');

  // the shortcut is rewritten (an app update rewrote it) -> the old picture shows, the re-ask runs behind it
  pic = 'PIC-2'; slow = 300;
  rebuild(lnk, 'shortcut v2', 20);
  G.icons.get(lnk).checkedAt = 0;          // as if the last stat was more than 2 s ago
  const it3 = { path: lnk };
  const t0 = Date.now();
  await fill([it3], icon, 1000);
  ok(Date.now() - t0 < 250, 'the build does not wait for a re-ask (' + (Date.now() - t0) + ' ms)');
  ok(it3.icon === 'PIC-1', 'while the re-ask runs, the old picture keeps showing (no blank)');
  await sleep(450);
  ok(asks === 2 && it3.icon === 'PIC-2', 'when it lands, the new picture replaces it in place (asks ' + asks + ', icon ' + it3.icon + ')');
  ok(G.icons.get(lnk).url === 'PIC-2', '...and is what the cache serves next');

  // ten minutes on (a shortcut whose target exe was rebuilt: its own stamp did not move) -> asked again
  slow = 0; pic = 'PIC-3';
  G.icons.get(lnk).askedAt -= 11 * 60 * 1000;
  const it4 = { path: lnk };
  await fill([it4], icon, 1000);
  await sleep(50);
  ok(asks === 3 && it4.icon === 'PIC-3', 'a picture 10 min old is asked again on the rebuild (target rebuilt, .lnk unchanged)');

  // a failed re-ask keeps the picture it had
  fail = true;
  G.icons.get(lnk).askedAt -= 11 * 60 * 1000;
  const it5 = { path: lnk };
  await fill([it5], icon, 1000);
  await sleep(50);
  ok(asks === 4 && it5.icon === 'PIC-3' && G.icons.get(lnk).url === 'PIC-3', 'a re-ask that fails keeps the old picture (not a blank)');
  ok(/timed out/.test(G.iconFail), 'and the failure is recorded for the footer (' + G.iconFail + ')');
  fail = false; G.iconFail = '';

  // a miss is asked again when the file changes, not only after 10 min
  const gone = path.join(dir, 'Gone.lnk');
  const it6 = { path: gone };
  await fill([it6], async () => null, 1000);
  ok(it6.icon === null, 'a shortcut with no picture is a miss');
  rebuild(gone, 'now it exists', 30);
  G.icons.get(gone).checkedAt = 0;
  const it7 = { path: gone };
  await fill([it7], async () => 'PIC-G', 1000);
  ok(it7.icon === 'PIC-G', 'a miss whose file changed is asked again at once (it waited 10 min before)');
  G.icons.clear();

  // ---- 3. main.js iconFor, the real source ------------------------------------------------------------
  const SRC = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8').replace(/\r\n/g, '\n');
  const a = SRC.indexOf('async function iconFor(');
  const b = SRC.indexOf('\n}\n', a);
  ok(a > 0 && b > a, 'main.js has iconFor');
  ok(/const ICON_RECHECK_MS = 60 \* 1000;/.test(SRC) && /require\('\.\/lib\/icon-fresh'\)/.test(SRC), 'main.js loads icon-fresh and sets a 60 s re-ask');
  const exe = path.join(dir, 'Helm.exe');
  rebuild(exe, 'wheel build', 0);
  let reply = 'WHEEL', calls = 0, blocked = null, throws = false;
  const ctx = {
    path, iconFresh: F, ICON_RECHECK_MS: 60000, APPS_FOLDER: 'shell:appsfolder\\', iconCache: new Map(),
    storeAumidOf: () => null, appReplyPng: () => null,
    sidecar: {
      blockedReason: () => blocked,
      call: async (cmd, args) => { calls++; if (throws) throw new Error('timed out'); return { icon: args.path === exe ? reply : null }; },
    },
  };
  vm.createContext(ctx);
  vm.runInContext(SRC.slice(a, b + 2) + '\nthis.iconFor = iconFor;', ctx);
  const r1 = await ctx.iconFor([exe]);
  ok(r1.icon === 'WHEEL' && calls === 1, 'bar: first ask reads the picture');
  const r2 = await ctx.iconFor([exe]);
  ok(r2.icon === 'WHEEL' && calls === 1, 'bar: asked again at once, it comes from the cache');
  reply = 'H';
  rebuild(exe, 'H build, bigger', 40);
  ctx.iconCache.get(exe.toLowerCase()).checkedAt = 0;
  const r3 = await ctx.iconFor([exe]);
  ok(r3.icon === 'H' && calls === 2, 'bar: the exe was rebuilt, so it is asked again and the NEW picture shows (got ' + r3.icon + ')');
  blocked = 'it is restarting';
  ctx.iconCache.get(exe.toLowerCase()).askedAt -= 61000;
  const r4 = await ctx.iconFor([exe]);
  ok(r4.icon === 'H' && calls === 2, 'bar: a re-ask due while the sidecar cannot be asked keeps the picture');
  blocked = null; throws = true;
  const r5 = await ctx.iconFor([exe]);
  ok(r5.icon === 'H' && calls === 3, 'bar: a re-ask that throws keeps the picture');
  throws = false;
  const nope = path.join(dir, 'missing.exe');
  const r6 = await ctx.iconFor([nope]);
  ok(r6.icon === null && /no icon/.test(r6.reason), 'bar: a path with no picture still says why (' + r6.reason + ')');

  // ---- 4. a Store app updated while Mantle runs (storeicons, 2026-10-08): main.js 'appchanged' -------
  // The sidecar re-checks a Store app's package and sends 'appchanged' when an update brought a new
  // picture. The REAL handler (cut out of main.js) must drop the bar's cached picture for that app
  // and the pinned-list cache, and push the bar again; the REAL iconFor then asks `app` again.
  const cut = (startText, endText) => {
    const s = SRC.indexOf(startText);
    const e = s < 0 ? -1 : SRC.indexOf(endText, s);
    return s < 0 || e < 0 ? null : SRC.slice(s, e + endText.length);
  };
  const handlerSrc = cut("sidecar.on('appchanged', (msg) => {", '\n});\n');
  const storeSrc = [cut('const APPS_FOLDER = ', '\n'), cut('const STORE_AUMID_RE = ', '\n'), cut('const PNG_URL = ', '\n'),
    cut('function storeAumidOf(p) {', '\n}\n'), cut('function appReplyPng(r) {', '\n}\n')];
  ok(!!handlerSrc && storeSrc.every(Boolean), 'main.js has the appchanged handler and the Store id helpers');
  if (handlerSrc && storeSrc.every(Boolean)) {
    const handlers = {};
    let appCalls = 0, appPic = 'OLDPIC';
    const pushes = [];
    const sctx = {
      path, iconFresh: F, ICON_RECHECK_MS: 60000, iconCache: new Map(), pinsCache: { items: ['old pins'] },
      schedulePinnedPush: (why) => pushes.push(why),
      sidecar: {
        on: (name, fn) => { handlers[name] = fn; },
        blockedReason: () => null,
        call: async (cmd, args) => { if (cmd !== 'app') throw new Error('unexpected ' + cmd); appCalls++; return { ok: true, aumid: args.aumid, iconPng: 'data:image/png;base64,' + appPic }; },
      },
    };
    vm.createContext(sctx);
    vm.runInContext(storeSrc.join('\n') + '\n' + SRC.slice(a, b + 2) + '\n' + handlerSrc + '\nthis.iconFor = iconFor;', sctx);
    const id = 'Microsoft.WindowsTerminal_8wekyb3d8bbwe!App';
    const p = 'shell:AppsFolder\\' + id;
    const s1 = await sctx.iconFor([p]);
    const s2 = await sctx.iconFor([p]);
    ok(/OLDPIC$/.test(s1.icon || '') && s2.icon === s1.icon && appCalls === 1, 'store: the bar asks `app` once and then serves its cache (' + appCalls + ' asks)');
    ok(typeof handlers.appchanged === 'function', 'store: main.js listens for appchanged');
    appPic = 'NEWPIC';
    handlers.appchanged({ ev: 'appchanged', aumid: id });
    ok(sctx.pinsCache === null, 'store: an update drops the pinned-list cache (Store pins carry the sidecar picture)');
    ok(pushes.length === 1 && /Store app was updated/.test(pushes[0]), 'store: an update pushes the bar again, saying why (' + pushes.join('; ') + ')');
    const s3 = await sctx.iconFor([p]);
    ok(/NEWPIC$/.test(s3.icon || '') && appCalls === 2, 'store: the bar asks again at once and shows the NEW picture (got ' + String(s3.icon).slice(-6) + ')');
    sctx.pinsCache = { items: [] };
    let threw = null;
    try { handlers.appchanged({ ev: 'appchanged' }); handlers.appchanged(null); } catch (err) { threw = err.message; }
    ok(threw === null && sctx.pinsCache === null, 'store: an appchanged with no app id still refreshes the pins and never throws (' + threw + ')');
  }

  fs.rmSync(dir, { recursive: true, force: true });
  if (failures.length) for (const f of failures) console.log('  FAIL: ' + f);
  console.log('ICON FRESH TEST: ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.log('  FAIL: the test itself threw: ' + (err && err.stack || err));
  console.log('ICON FRESH TEST: ' + passed + ' passed, ' + (failed + 1) + ' failed');
  process.exit(1);
});

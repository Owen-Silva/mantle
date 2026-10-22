// test-icons.js - the sidecar's app pictures: `icon` (an exe or shortcut) and `app` (a Store app
// id), read-only, on a passive sidecar (core-needs, 2026-09-30).
//
// WHAT it proves:
//   - both answer 64x64 PNGs with an alpha channel (was 32x32: soft at 150-200 %);
//   - `app` answers a Store app's picture (Calculator, Notepad, Terminal...), which is where main.js
//     now sends the launcher's 'shell:AppsFolder\<id>' rows; `icon` has none for that path (it
//     reads files), which is why those rows wore letter tiles before;
//   - an unknown id, a missing file and a missing argument are plain answers, never a crash;
//   - a second ask for the same picture comes from the cache.
// Privacy: prints counts, sizes and timings only -- no app names, ids or paths.
//
//   node sidecar/test-icons.js --exe=<your build> [--verbose] [--save=<dir>]   (--save writes the PNGs to look at)
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const T = require('./test-lib');

const AUMID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,200}_[A-Za-z0-9]{8,20}![A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PREFIX = 'data:image/png;base64,';
const saveArg = (process.argv.find((a) => a.startsWith('--save=')) || '').slice(7);

/** {w, h, colorType} out of a PNG data URL's IHDR, or null. */
function pngInfo(url) {
  if (typeof url !== 'string' || !url.startsWith(PREFIX)) return null;
  const b = Buffer.from(url.slice(PREFIX.length), 'base64');
  if (b.length < 33 || b.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), colorType: b[25], bytes: b.length };
}
/** How many pixels of an RGBA PNG data URL are fully see-through and fully solid, or null. */
function alphaSpread(url) {
  if (typeof url !== 'string' || !url.startsWith(PREFIX)) return null;
  const b = Buffer.from(url.slice(PREFIX.length), 'base64');
  let p = 8, w = 0, h = 0, ctype = 0, depth = 0, interlace = 0;
  const idat = [];
  while (p + 8 <= b.length) {
    const len = b.readUInt32BE(p), type = b.toString('latin1', p + 4, p + 8), data = b.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; ctype = data[9]; interlace = data[12]; }
    if (type === 'IDAT') idat.push(data);
    p += 12 + len;
  }
  if (ctype !== 6 || depth !== 8 || interlace) return null;
  const raw = require('zlib').inflateSync(Buffer.concat(idat));
  const stride = w * 4, img = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? img[y * stride + x - 4] : 0, up = y > 0 ? img[(y - 1) * stride + x] : 0, c = x >= 4 && y > 0 ? img[(y - 1) * stride + x - 4] : 0;
      let v = src[x];
      if (f === 1) v += a; else if (f === 2) v += up; else if (f === 3) v += (a + up) >> 1;
      else if (f === 4) { const pp = a + up - c, pa = Math.abs(pp - a), pb = Math.abs(pp - up), pc = Math.abs(pp - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? up : c; }
      img[y * stride + x] = v & 255;
    }
  }
  let clear = 0, solid = 0;
  for (let i = 3; i < img.length; i += 4) { if (img[i] === 0) clear++; else if (img[i] === 255) solid++; }
  return { clear, solid };
}

function save(name, url) {
  if (!saveArg || !url) return;
  fs.mkdirSync(saveArg, { recursive: true });
  fs.writeFileSync(path.join(saveArg, name + '.png'), Buffer.from(url.slice(PREFIX.length), 'base64'));
}

(async () => {
  const t = T.checker('ICONS');
  const check = t.check;
  t.check = (name, ok, detail) => { if (process.argv.includes('--verbose')) console.log('  ' + (ok ? 'ok  ' : 'FAIL') + ' ' + name + (detail ? ' -- ' + detail : '')); return check(name, ok, detail); };
  // Installed Store apps, read the way the launcher reads them (Get-StartApps): ids only.
  let ids = [];
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command', 'Get-StartApps | ForEach-Object { $_.AppID }'],
      { encoding: 'utf8', timeout: 30000, windowsHide: true });
    ids = out.split(/\r?\n/).map((s) => s.trim()).filter((s) => AUMID_RE.test(s));
  } catch (_) { ids = []; }
  const want = ['Microsoft.WindowsCalculator_8wekyb3d8bbwe!App', 'Microsoft.WindowsNotepad_8wekyb3d8bbwe!App', 'Microsoft.WindowsTerminal_8wekyb3d8bbwe!App'];
  const pick = want.filter((w) => ids.includes(w)).concat(ids.filter((i) => !want.includes(i)).slice(0, 5));
  t.check('setup: Store apps found to ask about', pick.length >= 3, `${ids.length} Store app ids, asking ${pick.length}`);

  const s = await T.startPassive();
  try {
    // ---- `app`: a Store app's picture, 64 px, with alpha -------------------------------------------
    let good = 0, bytes = 0;
    const t0 = Date.now();
    for (let i = 0; i < pick.length; i++) {
      const r = await s.call('app', { aumid: pick[i] }, 8000);
      const info = pngInfo(r && r.iconPng);
      if (r && r.ok && info && info.w === 64 && info.h === 64 && info.colorType === 6) { good++; bytes += info.bytes; }
      save('app-' + i, r && r.iconPng);
    }
    t.check('app: every Store app asked has a 64x64 RGBA picture', good === pick.length, `${good}/${pick.length}, ${pick.length ? Math.round(bytes / Math.max(good, 1)) : 0} bytes each on average, ${Date.now() - t0} ms for all`);
    const known = want.filter((w) => ids.includes(w));
    if (known.length) {
      const r = await s.call('app', { aumid: known[0] }, 8000);
      t.check('app: a well-known Store app answers ok with a name and a picture', r.ok === true && typeof r.name === 'string' && r.name.length > 0 && !!pngInfo(r.iconPng), `ok=${r.ok} name=${typeof r.name} png=${!!pngInfo(r.iconPng)}`);
      const t1 = Date.now();
      await s.call('app', { aumid: known[0] }, 8000);
      t.check('app: the same app again is quick', Date.now() - t1 < 1500, `${Date.now() - t1} ms`);
      // the gap main.js closes: `icon` reads files, so a Store path is no picture there
      const via = await s.call('icon', { path: 'shell:AppsFolder\\' + known[0] }, 8000);
      t.check('icon: a shell:AppsFolder path is NOT a file (why main routes it to app)', via.icon === null, `icon=${via.icon === null ? 'null' : 'a picture'}`);
    }

    // ---- plain answers, never a crash ----------------------------------------------------------------
    const dead = await s.call('app', { aumid: 'No.Such.App_0000000000000!App' }, 8000);
    t.check('app: an unknown id is ok:false with a reason, no picture', dead.ok === false && dead.iconPng === null && /does not know|refused|could not be read/.test(dead.reason || ''), (dead.reason || '').replace(/'[^']*'/g, "'<id>'").slice(0, 120));
    const none = await s.call('app', {}, 8000);
    t.check('app: no id is ok:false "app needs an aumid"', none.ok === false && /needs an aumid/.test(none.reason || ''), none.reason);
    let threw = null;
    try { await s.call('icon', {}, 8000); } catch (e) { threw = e.message; }
    t.check('icon: no path is a plain error', !!threw && /needs a path/.test(threw), threw);
    const gone = await s.call('icon', { path: 'C:\\no\\such\\file-' + process.pid + '.exe' }, 8000);
    t.check('icon: a missing file is no picture', gone.icon === null, String(gone.icon));

    // ---- `icon`: exes and a shortcut, 64 px, with alpha ------------------------------------------------
    const sys = process.env.SystemRoot || 'C:\\Windows';
    const exes = [path.join(sys, 'explorer.exe'), path.join(sys, 'System32', 'notepad.exe'), path.join(sys, 'System32', 'cmd.exe'), path.join(sys, 'System32', 'Taskmgr.exe')].filter((p) => fs.existsSync(p));
    let lnk = null;
    const menu = path.join(process.env.ProgramData || 'C:\\ProgramData', 'Microsoft', 'Windows', 'Start Menu', 'Programs');
    try {
      const stack = [menu];
      while (stack.length && !lnk) {
        const d = stack.shift();
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          if (e.isFile() && /\.lnk$/i.test(e.name)) { lnk = path.join(d, e.name); break; }
          if (e.isDirectory()) stack.push(path.join(d, e.name));
        }
      }
    } catch (_) { /* no Start menu folder: the exes still count */ }
    const files = exes.concat(lnk ? [lnk] : []);
    let fgood = 0, fbytes = 0;
    const t2 = Date.now();
    for (let i = 0; i < files.length; i++) {
      const r = await s.call('icon', { path: files[i] }, 8000);
      const info = pngInfo(r && r.icon);
      if (info && info.w === 64 && info.h === 64 && info.colorType === 6) { fgood++; fbytes += info.bytes; }
      save('icon-' + i, r && r.icon);
    }
    t.check('icon: exes and a Start menu shortcut are 64x64 RGBA', files.length >= 3 && fgood === files.length, `${fgood}/${files.length} (shortcut ${lnk ? 'included' : 'not found'}), ${Math.round(fbytes / Math.max(fgood, 1))} bytes each, ${Date.now() - t2} ms cold`);
    const t3 = Date.now();
    for (const f of files) await s.call('icon', { path: f }, 8000);
    t.check('icon: asked again, every one comes from the cache', Date.now() - t3 < 200 * files.length, `${Date.now() - t3} ms for ${files.length}`);

    // ---- an exe's picture is read from the file and keeps its alpha (mantle-icon, 2026-10-08) -----
    const exeAlpha = alphaSpread(exes[0] ? (await s.call('icon', { path: exes[0] }, 8000)).icon : null);
    t.check('icon: an exe read from the file keeps its see-through edge (alpha 0 and 255 both present)',
      !!exeAlpha && exeAlpha.clear > 0 && exeAlpha.solid > 0, exeAlpha ? `${exeAlpha.clear} clear, ${exeAlpha.solid} solid px` : 'no picture');

    // ---- a REBUILT app shows its new picture without a restart -----------------------------------------
    // The user's bar kept Helm's old icon after helm.exe was rebuilt at the same path. Windows' own icon
    // cache still answers the OLD picture for a rewritten file (measured), and the sidecar kept it for
    // good. Here: a copy of one exe, a shortcut to it, then the copy is rewritten with a different exe.
    const A = exes.find((p) => /notepad\.exe$/i.test(p)), B = exes.find((p) => /cmd\.exe$/i.test(p));
    if (!A || !B) {
      t.check('setup: notepad.exe and cmd.exe to rebuild with', false, 'one of them is missing');
    } else {
      const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'mantle-icons-'));
      try {
        const app = path.join(dir, 'App.exe');
        const lnkPath = path.join(dir, 'App.lnk');
        const later = path.join(dir, 'Later.exe');
        const ask = async (p) => (await s.call('icon', { path: p }, 8000)).icon;
        const refA = await ask(A), refB = await ask(B);
        const which = (u) => (u === refA ? 'the first exe\'s picture' : u === refB ? 'the second exe\'s picture' : u === null ? 'no picture' : 'another picture');
        t.check('setup: the two exes have different pictures', !!refA && !!refB && refA !== refB, `${refA ? refA.length : 0} / ${refB ? refB.length : 0} chars`);
        fs.writeFileSync(app, fs.readFileSync(A));
        execFileSync('powershell', ['-NoProfile', '-Command',
          `$l = (New-Object -ComObject WScript.Shell).CreateShortcut('${lnkPath.replace(/'/g, "''")}'); $l.TargetPath = '${app.replace(/'/g, "''")}'; $l.Save()`],
          { timeout: 30000, windowsHide: true });
        const before = await ask(app), lnkBefore = await ask(lnkPath);
        const missing = await ask(later);
        t.check('rebuild: the copy shows the first exe\'s picture', before === refA, which(before));
        t.check('rebuild: its shortcut shows the same picture', lnkBefore === refA, which(lnkBefore));
        t.check('rebuild: a file that is not there yet has no picture', missing === null, String(missing).slice(0, 30));

        // "rebuild" it: new bytes at the same path, new write time, a different icon
        fs.writeFileSync(app, fs.readFileSync(B));
        fs.writeFileSync(later, fs.readFileSync(A));
        const quick = await ask(app);
        t.check('rebuild: within 2 s the cached picture is still served (one stat per 2 s at most)', quick === refA, which(quick));
        await T.sleep(2300);
        const after = await ask(app), lnkAfter = await ask(lnkPath), appeared = await ask(later);
        t.check('rebuild: after the rewrite the exe shows its NEW picture', after === refB, which(after));
        t.check('rebuild: the shortcut to it shows the new picture too', lnkAfter === refB, which(lnkAfter));
        t.check('rebuild: a file that appeared later gets its picture (a miss is not kept forever)', appeared === refA, which(appeared));
        const t4 = Date.now();
        for (let i = 0; i < 5; i++) await ask(app);
        t.check('rebuild: the new picture is cached again', Date.now() - t4 < 500, `${Date.now() - t4} ms for 5`);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  } finally {
    await s.stop();
  }

  // ---- a Store app UPDATED while Mantle runs shows its new picture (storeicons, 2026-10-08) ----------
  // Its cached picture remembers the app's package stamp (full names + manifest times) and `app`
  // re-checks it at most every 5 s. A real update cannot be made on demand, so the test sidecar is
  // started with MANTLE_TEST_PACKAGE_STAMP: a file whose text is added to every package stamp, and
  // rewriting it is "this app was updated". `cached` in the reply says whether the shell was asked.
  const storeIds = want.filter((w) => ids.includes(w));
  if (!storeIds.length) {
    t.check('package: a known Store app to ask about', false, 'none of Calculator / Notepad / Terminal is installed');
  } else {
    const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'mantle-pkgstamp-'));
    const stampFile = path.join(dir, 'stamp.txt');
    fs.writeFileSync(stampFile, 'v1');
    process.env.MANTLE_TEST_PACKAGE_STAMP = stampFile;
    let p = null;
    try {
      p = await T.startPassive();
      delete process.env.MANTLE_TEST_PACKAGE_STAMP;
      const id = storeIds[0];
      const ask = (aumid) => p.call('app', { aumid }, 8000);
      const changedLogs = () => p.collect('log').filter((e) => /package changed/.test(e.msg || e.message || e.text || JSON.stringify(e)));
      const a = await ask(id);
      t.check('package: the first ask reads the app (cached:false) and has a picture', a.ok === true && a.cached === false && !!pngInfo(a.iconPng), `ok=${a.ok} cached=${a.cached}`);
      const t0 = Date.now();
      const b = await ask(id);
      t.check('package: asked again, it comes from the cache (cached:true, same picture)', b.cached === true && b.iconPng === a.iconPng && b.name === a.name, `cached=${b.cached} ${Date.now() - t0} ms`);
      await T.sleep(5300);
      const t1 = Date.now();
      const c = await ask(id);
      const checkMs = Date.now() - t1;
      t.check('package: same version after 5 s: the package is re-checked and the cache kept', c.cached === true && c.iconPng === a.iconPng && changedLogs().length === 0, `cached=${c.cached}, ${checkMs} ms with the check, ${changedLogs().length} change logs`);
      t.check('package: the re-check is cheap (no shell read)', checkMs < 150, `${checkMs} ms`);
      fs.writeFileSync(stampFile, 'v2');            // "the Store updated it"
      const d = await ask(id);
      t.check('package: within 5 s of the last check the cached picture is still served (one check per 5 s at most)', d.cached === true && d.iconPng === a.iconPng, `cached=${d.cached}`);
      await T.sleep(5300);
      const e = await ask(id);
      t.check('package: after an update the app is read again (cached:false) and has a picture', e.ok === true && e.cached === false && !!pngInfo(e.iconPng), `ok=${e.ok} cached=${e.cached}`);
      await T.sleep(100);
      const logs = changedLogs();
      t.check('package: the update is logged once, saying the picture was read again', logs.length === 1 && /same picture/.test(JSON.stringify(logs[0])), `${logs.length} logs`);
      t.check('package: a same picture sends no appchanged event (main.js keeps its caches)', p.collect('appchanged').length === 0, `${p.collect('appchanged').length} events`);
      const f = await ask(id);
      t.check('package: the re-read picture is cached again', f.cached === true && f.iconPng === e.iconPng, `cached=${f.cached}`);

      // failures: cached and logged once, tried again only when the package changes
      const dead = 'No.Such.App_0000000000000!App';
      const noIcon = () => p.collect('log').filter((x) => JSON.stringify(x).includes('No.Such.App_0000000000000')).length;
      const g1 = await ask(dead);
      const g2 = await ask(dead);
      t.check('package: an app that is not installed is ok:false, the second time from the cache', g1.ok === false && g2.ok === false && g2.cached === true && !!g2.reason, `ok=${g1.ok}/${g2.ok} cached=${g2.cached}`);
      await T.sleep(100);
      t.check('package: its failure is logged once, not per ask', noIcon() === 1, `${noIcon()} log lines`);
      fs.writeFileSync(stampFile, 'v3');
      await T.sleep(5300);
      const g3 = await ask(dead);
      await T.sleep(100);
      t.check('package: a missing app is tried again when its package changes, and the same reason is not logged again', g3.ok === false && g3.cached === false && noIcon() === 1, `cached=${g3.cached}, ${noIcon()} log lines`);

      // an id that is not a package app id has no package to follow: `app` reads it every time, as before
      const plain = 'Microsoft.Windows.Explorer';
      const h1 = await ask(plain);
      const h2 = await ask(plain);
      t.check('package: a non-package app id is read every time (cached:false), as before', h1.cached === false && h2.cached === false, `cached=${h1.cached}/${h2.cached} ok=${h1.ok}`);
    } finally {
      delete process.env.MANTLE_TEST_PACKAGE_STAMP;
      if (p) await p.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  process.exit(t.summary());
})().catch((err) => { console.log('ICONS TEST: crashed: ' + err.message); process.exit(1); });

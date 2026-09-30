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
  } finally {
    await s.stop();
  }
  process.exit(t.summary());
})().catch((err) => { console.log('ICONS TEST: crashed: ' + err.message); process.exit(1); });

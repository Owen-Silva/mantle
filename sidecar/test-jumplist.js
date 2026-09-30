// test-jumplist.js - sidecar/JumpList.cs against the real jump list files on this machine
// (wave 3, 2026-09-24). Passive and READ-ONLY: opens and removes are dry runs, and a real one must
// be refused. PRIVACY: prints counts, kinds and timings, never an item's title or path.
//   MANTLE_SIDECAR_EXE=<exe> node sidecar/test-jumplist.js
'use strict';
const fs = require('fs');
const path = require('path');
const T = require('./test-lib');

const RECENT = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Recent');

/** The same CRC-64 as JumpList.HashOf, so the file-name rule is proved twice, independently. */
function hashOf(appid) {
  let c = 0xFFFFFFFFFFFFFFFFn;
  for (const b of Buffer.from(String(appid).toUpperCase(), 'utf16le')) {
    c ^= BigInt(b);
    for (let i = 0; i < 8; i++) c = (c & 1n) ? (c >> 1n) ^ 0x92C64265D32139A4n : (c >> 1n);
  }
  return c.toString(16);
}

function stamps() {
  const out = new Map();
  for (const sub of ['AutomaticDestinations', 'CustomDestinations']) {
    let names = [];
    try { names = fs.readdirSync(path.join(RECENT, sub)); } catch (_) { /* reported below */ }
    for (const n of names) {
      try { const st = fs.statSync(path.join(RECENT, sub, n)); out.set(sub + '/' + n, st.mtimeMs + ':' + st.size); } catch (_) { /* went away */ }
    }
  }
  return out;
}

function shape(r) {
  const s = (r.sections || []).map((x) => `${x.kind}:${(x.items || []).filter((i) => !i.sep).length}`).join(' ');
  return s || '(none: ' + (r.none || r.error || '?') + ')';
}

(async () => {
  const t = T.checker('JUMPLIST');
  const files = new Set();
  for (const sub of ['AutomaticDestinations', 'CustomDestinations']) {
    try { for (const n of fs.readdirSync(path.join(RECENT, sub))) files.add(n.split('.')[0]); } catch (_) { /* none */ }
  }
  t.check('this machine has jump list files to test against', files.size > 0, `${files.size} hashes in ${RECENT}`);

  // 1. The hash rule, in JS, against names Windows wrote (no leading zeros: Notepad's is 15 digits).
  const KNOWN = { 'Microsoft.Windows.Explorer': 'f01b4d95cf55d32a', 'MSEdge': 'ccba5a5986c77e43',
    'Microsoft.WindowsNotepad_8wekyb3d8bbwe!App': 'a61657a5e5dfbdc' };
  for (const [id, want] of Object.entries(KNOWN)) t.check(`crc64("${id}") = ${want}`, hashOf(id) === want, hashOf(id));
  const before = stamps();

  const s = await T.startPassive();
  try {
    // 2. The sidecar's hash agrees, and an app with no files says so in words.
    let r = await s.send('jumplist.get', { app: 'Microsoft.Windows.Explorer' }, 8000);
    t.check('get by app answers', r.ok === true, JSON.stringify(r).slice(0, 200));
    const ex = r.result || {};
    t.check('sidecar hash = JS hash', ex.hash === 'f01b4d95cf55d32a', ex.hash);
    console.log(`  Explorer: ${shape(ex)}  dest=${ex.dest}  ms=${JSON.stringify(ex.ms)}`);
    r = await s.send('jumplist.get', { app: 'Mantle.Test.NoSuchApp' }, 8000);
    t.check('an app with no files: ok, no sections, a reason in words',
      r.ok && r.result.sections.length === 0 && /doesn't publish one/.test(r.result.none || ''), JSON.stringify(r.result || r).slice(0, 200));
    r = await s.send('jumplist.get', {}, 8000);
    t.check('no app named: a plain error', r.ok === false && /needs app, hwnd, lnk or exe/.test(r.error || ''), r.error);
    r = await s.send('jumplist.get', { hwnd: '1' }, 8000);
    t.check('a window that does not exist: a plain error', r.ok === false && /which app window/.test(r.error || ''), r.error);

    // 3. Every running app, through the taskbar's resolver, cold then warm.
    const wins = await s.send('windows', {}, 8000);
    const list = (wins.ok && Array.isArray(wins.result)) ? wins.result : [];
    t.check('windows lists something to resolve', list.length > 0, `${list.length} windows`);
    const seen = new Map();
    let resolved = 0, withFiles = 0, sectionsSeen = 0, readErrors = 0;
    const cold = [], warm = [];
    const tasks = [], recents = [];
    for (const w of list) {
      const a = await s.send('jumplist.get', { hwnd: String(w.hwnd), exe: w.exe || undefined }, 8000);
      if (!a.ok) { console.log(`  ${path.basename(w.exe || '?')}: ${a.error}`); continue; }
      resolved++;
      const res = a.result;
      if (seen.has(res.appid)) continue;
      seen.set(res.appid, res);
      t.check(`hash of ${res.appid.slice(0, 40)} matches JS`, res.hash === hashOf(res.appid), res.hash);
      const has = res.files.custom || res.files.automatic;
      if (has) {
        withFiles++;
        t.check(`files flagged for ${res.hash} exist in the folder`, files.has(res.hash), res.hash);
        cold.push(res.ms.total);
      }
      if (res.error) readErrors++;
      sectionsSeen += res.sections.length;
      console.log(`  ${path.basename(w.exe || '?')} [${res.how}] ${res.hash}: ${shape(res)}${res.error ? '  ERROR ' + res.error : ''}  ${res.ms.total} ms${res.dest ? '  dest ' + res.dest : ''}`);
      for (const sec of res.sections) {
        for (const it of sec.items) {
          if (it.sep) continue;
          t.check(`every item has a title, token and icon (${sec.kind})`, !!it.title && /^[ac]:/.test(it.item || '') && (it.icon === null || /^data:image\/png;base64,/.test(it.icon)),
            `${it.item} icon=${it.icon ? 'png' : 'none'}`);
          if ((sec.kind === 'tasks' || sec.kind === 'custom') && tasks.length < 6) tasks.push({ hwnd: String(w.hwnd), item: it.item, title: it.title, exe: w.exe });
          if ((sec.kind === 'recent' || sec.kind === 'frequent') && recents.length < 6) recents.push({ hwnd: String(w.hwnd), item: it.item, title: it.title, exe: w.exe });
        }
      }
      const again = await s.send('jumplist.get', { hwnd: String(w.hwnd) }, 8000);
      t.check(`second read of ${res.hash} is served from the cache`, again.ok && again.result.cached === true, JSON.stringify(again.result && again.result.ms));
      if (again.ok && has) warm.push(again.result.ms.total);
    }
    t.check('some running app resolved', resolved > 0, `${resolved}/${list.length}`);
    t.check('no read errors on this machine', readErrors === 0, `${readErrors}`);
    const med = (a) => a.length ? a.slice().sort((x, y) => x - y)[a.length >> 1] : null;
    console.log(`  apps ${seen.size}, with jump list files ${withFiles}, sections ${sectionsSeen}; cold ms median ${med(cold)} max ${Math.max(0, ...cold)}; warm ms median ${med(warm)} max ${Math.max(0, ...warm)}`);

    // 4. Well-known AppIDs, including the ones only a path or the resolver knows.
    for (const extra of [{ app: 'MSEdge' }, { exe: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' }]) {
      const a = await s.send('jumplist.get', extra, 8000);
      t.check(`get ${JSON.stringify(extra).slice(0, 60)} answers`, a.ok === true, a.error || '');
      if (a.ok) console.log(`  ${a.result.appid.slice(0, 50)} ${a.result.hash}: ${shape(a.result)}  ${a.result.ms.total} ms`);
      if (a.ok) for (const sec of a.result.sections) for (const it of sec.items) {
        if (!it.sep && sec.kind === 'tasks' && tasks.length < 8) tasks.push(Object.assign({ item: it.item, title: it.title }, extra));
        if (!it.sep && (sec.kind === 'recent' || sec.kind === 'frequent') && recents.length < 8) recents.push(Object.assign({ item: it.item, title: it.title }, extra));
      }
    }

    // 5. Opening: a dry run resolves the route; a real one is refused by a passive sidecar.
    for (const k of tasks) {
      const a = await s.send('jumplist.open', Object.assign({}, k, { dry: true }), 8000);
      t.check(`dry open of a task resolves the link's default command`, a.ok && a.result.dryRun === true && a.result.route === 'link default command', a.error || JSON.stringify(a.result).slice(0, 120));
    }
    for (const k of recents) {
      const a = await s.send('jumplist.open', Object.assign({}, k, { dry: true }), 8000);
      t.check(`dry open of a recent item names its route`, a.ok && a.result.dryRun === true && /handler/.test(a.result.route || ''), a.error || JSON.stringify(a.result).slice(0, 120));
      if (a.ok) console.log(`    recent item route: ${a.result.route}`);
      const d = await s.send('jumplist.remove', Object.assign({}, k, { dry: true }), 8000);
      t.check(`dry remove of a recent item names IApplicationDestinations`, d.ok && d.result.route === 'IApplicationDestinations.RemoveDestination', d.error || '');
    }
    if (!tasks.length) console.log('  (no task items on this machine to dry-open)');
    if (!recents.length) console.log('  (no recent items on this machine to dry-open)');
    const any = tasks[0] || recents[0];
    if (any) {
      let a = await s.send('jumplist.open', Object.assign({}, any), 8000);
      t.check('a REAL open is refused by the passive sidecar', a.ok === false && a.error.indexOf(T.PASSIVE_REFUSAL) === 0, a.error);
      a = await s.send('jumplist.remove', Object.assign({}, any), 8000);
      t.check('a REAL remove is refused by the passive sidecar', a.ok === false && a.error.indexOf(T.PASSIVE_REFUSAL) === 0, a.error);
      a = await s.send('jumplist.open', Object.assign({}, any, { dry: true, item: 'c:99:99' }), 8000);
      t.check('a token that is not in the list: a plain error', a.ok === false && /no longer in/.test(a.error || ''), a.error);
      a = await s.send('jumplist.open', Object.assign({}, any, { dry: true, title: 'a title it never had' }), 8000);
      t.check('a list that changed since the menu opened: a plain error', a.ok === false && /changed since the menu opened/.test(a.error || ''), a.error);
    }
    if (tasks[0]) {
      const a = await s.send('jumplist.remove', Object.assign({}, tasks[0], { dry: true }), 8000);
      t.check('a task cannot be removed, and says why', a.ok === false && /only the app can remove it/.test(a.error || ''), a.error);
    }

    // 5b. "A new window": the app's own best shortcut (dry), for every running app resolved above.
    let launches = 0;
    for (const w of list.slice(0, 12)) {
      const a = await s.send('jumplist.open', { hwnd: String(w.hwnd), exe: w.exe || undefined, item: 'app', dry: true }, 8000);
      if (!a.ok) { console.log(`  new window of ${path.basename(w.exe || '?')}: ${a.error}`); continue; }
      launches++;
      t.check('a dry "new window" names its route', a.result.dryRun === true && /^its (shortcut|program file|Store app entry)$/.test(a.result.route), JSON.stringify(a.result));
      console.log(`  new window of ${path.basename(w.exe || '?')}: ${a.result.route} (${a.result.target})`);
    }
    t.check('some app resolves a "new window" route', launches > 0, `${launches}`);
    const sc = await s.send('jumplist.shortcut', { exe: process.env.USERPROFILE + '\\browser\\node_modules\\electron\\dist\\electron.exe' }, 8000);
    // privacy: whether a shortcut was found, never its file name (a shortcut is named by Owen)
    console.log(`  shortcut for the browser exe: ${sc.ok ? (sc.result.shortcut ? 'found (.lnk)' : 'none') : 'error'}`);
    const real = await s.send('jumplist.open', { app: 'MSEdge', item: 'app' }, 8000);
    t.check('a REAL "new window" is refused by the passive sidecar', real.ok === false && real.error.indexOf(T.PASSIVE_REFUSAL) === 0, real.error);

    // 6. The ui lane stays free while the jump-list thread works: ping during a burst of reads.
    const burst = [];
    for (const res of seen.values()) burst.push(s.send('jumplist.get', { app: res.appid, fresh: true }, 8000));
    const t0 = Date.now();
    const p = await s.send('ping', {}, 4000);
    const pingMs = Date.now() - t0;
    await Promise.all(burst);
    t.check('ping answers promptly during a burst of fresh reads (ui lane free)', p.ok === true && pingMs < 250, `${pingMs} ms for ${burst.length} fresh reads in flight`);
  } finally {
    await s.stop();
  }

  // 7. Read-only: nothing this test read was written (a change here is Owen using an app, and is named).
  const after = stamps();
  const changed = [...before.keys()].filter((k) => after.get(k) !== before.get(k));
  console.log(`  destination files changed during the run: ${changed.length}${changed.length ? ' (' + changed.join(', ') + '; the test only reads: that is an app writing its own list)' : ''}`);
  process.exit(t.summary());
})().catch((e) => { console.error('JUMPLIST TEST crashed:', e && e.stack || e); process.exit(1); });

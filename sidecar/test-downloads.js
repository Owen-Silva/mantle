// test-downloads.js - the Downloads shelf's sidecar half (sidecar/Downloads.cs).
//
//   MANTLE_SIDECAR_EXE=<your exe> node sidecar/test-downloads.js
//
// PASSIVE, like every sidecar test; downloads.list is a read, so a passive sidecar answers it. The
// listing is proved on a TEMP folder made here (with real Windows hidden and system attributes, set
// by attrib.exe on those temp files only). The known-folder case asks for max:0, so NOT ONE of Owen's
// file names crosses the pipe: only the folder's path, which is compared with the registry's and
// never printed. Prints one summary line, "DOWNLOADS SIDECAR TEST: n passed, m failed".
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const T = require('./test-lib');
const L = require('../lib/features/_downloads-list');

const H = 3600000;
(async () => {
  const t = T.checker('DOWNLOADS SIDECAR');
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mantle-dl-sc-'));
  const put = (name, bytes, off) => {
    const p = path.join(TMP, name);
    fs.writeFileSync(p, Buffer.alloc(bytes));
    const d = new Date(Date.now() + off); fs.utimesSync(p, d, d);
    return p;
  };
  put('worksheet.pdf', 1500, 2 * H);
  put('lab-template.docx', 300, 3 * H);
  put('Unconfirmed 1.crdownload', 7, 4 * H);
  const hid = put('secret-hidden.txt', 1, 5 * H);
  const sys = put('system-file.dat', 1, 5 * H);
  fs.mkdirSync(path.join(TMP, 'unzipped'));
  execFileSync('attrib', ['+h', hid], { windowsHide: true });
  execFileSync('attrib', ['+s', sys], { windowsHide: true });

  const s = await T.startPassive();
  try {
    const r = await s.send('downloads.list', { folder: TMP, max: 60 }, 6000);
    const v = r.ok ? r.result : { ok: false, reason: r.error };
    t.check('downloads.list {folder} answers ok with the folder, via "argument"', v.ok === true && v.folder === TMP && v.via === 'argument', JSON.stringify({ ok: v.ok, via: v.via, reason: v.reason }));
    const names = (v.items || []).map((i) => i.name);
    t.check('hidden and system files are skipped by their Windows attributes, and counted', !names.includes('secret-hidden.txt') && !names.includes('system-file.dat') && v.hidden === 2, JSON.stringify({ names, hidden: v.hidden }));
    t.check('the partial is listed (the JS policy drops it) and total counts every visible entry', names.includes('Unconfirmed 1.crdownload') && v.total === 4, JSON.stringify({ total: v.total }));
    t.check('newest arrival first (the later of creation and last write)', JSON.stringify(names) === JSON.stringify(['Unconfirmed 1.crdownload', 'lab-template.docx', 'worksheet.pdf', 'unzipped']), JSON.stringify(names));
    const pdf = (v.items || []).find((i) => i.name === 'worksheet.pdf') || {};
    t.check('an entry carries size, dir, birthMs and mtimeMs (unix ms)', pdf.size === 1500 && pdf.dir === false && Math.abs(pdf.mtimeMs - (Date.now() + 2 * H)) < 60000 && Math.abs(pdf.birthMs - Date.now()) < 60000, JSON.stringify(pdf));
    const dir = (v.items || []).find((i) => i.name === 'unzipped') || {};
    t.check('a folder is dir:true, size 0', dir.dir === true && dir.size === 0, JSON.stringify(dir));
    const sh = L.shelf(v.items, { max: 12, seenAt: 0 });
    t.check('the sidecar answer goes straight into the shelf: 3 rows, 1 downloading', sh.items.length === 3 && sh.partial === 1, JSON.stringify({ n: sh.items.length, partial: sh.partial }));
    const one = await s.send('downloads.list', { folder: TMP, max: 1 }, 6000);
    t.check('max cuts the items, total does not', one.ok && one.result.items.length === 1 && one.result.total === 4, JSON.stringify(one.result && { n: one.result.items.length, total: one.result.total }));

    /* A name kept with a lone UTF-16 surrogate (PowerShell writes it as is; node cannot): the wire's
       UTF-8 turns it into U+FFFD, so the row would open its U+FFFD TWIN, a different file. It is left
       out and counted (lane secreview-dl, 2026-09-27). */
    const SUR = fs.mkdtempSync(path.join(os.tmpdir(), 'mantle-dl-sur-'));
    try {
      execFileSync('powershell', ['-NoProfile', '-Command', "$d='" + SUR + "'; [IO.File]::WriteAllText(($d + '\\lone' + [char]0xD800 + 'x.exe'), 'LONE'); [IO.File]::WriteAllText(($d + '\\lone' + [char]0xFFFD + 'x.exe'), 'TWIN')"], { windowsHide: true });
      const su = await s.send('downloads.list', { folder: SUR, max: 60 }, 6000);
      const sv = su.ok ? su.result : { ok: false, reason: su.error };
      const sn = (sv.items || []).map((i) => i.name);
      t.check('a lone-surrogate name is left out and counted (unspellable), its U+FFFD twin listed once', sv.ok === true && sn.length === 1 && sn[0] === 'lone�x.exe' && sv.unspellable === 1 && sv.total === 1, JSON.stringify({ n: sn.length, unspellable: sv.unspellable, total: sv.total }));
    } finally {
      try { execFileSync('powershell', ['-NoProfile', '-Command', "Remove-Item -LiteralPath '" + SUR + "' -Recurse -Force"], { windowsHide: true }); } catch (_) { /* best effort */ }
    }

    const miss = await s.send('downloads.list', { folder: path.join(TMP, 'gone-away') }, 6000);
    t.check('a missing folder is ok:false, state missing, a reason without the path', miss.ok && miss.result.ok === false && miss.result.state === 'missing' && !String(miss.result.reason).includes('gone-away'), JSON.stringify(miss.result && { state: miss.result.state, reason: miss.result.reason }));

    /* The known folder: max 0, so no name of Owen's is sent. Compared with the registry's value. */
    const k = await s.send('downloads.list', { max: 0 }, 6000);
    const kv = k.ok ? k.result : { ok: false, reason: k.error };
    let reg = null;
    try {
      const out = execFileSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders', '/v', '{374DE290-123F-4565-9164-39C4925E467B}'], { encoding: 'utf8', windowsHide: true });
      const m = /REG_(?:EXPAND_)?SZ\s+(.+)\s*$/m.exec(out);
      if (m) reg = m[1].trim().replace(/%([^%]+)%/g, (_, n) => process.env[n] || '');
    } catch (_) { reg = null; }
    t.check('no folder argument: the Downloads KNOWN FOLDER (via "known folder"), sent with no items', kv.ok === true && kv.via === 'known folder' && Array.isArray(kv.items) && kv.items.length === 0 && typeof kv.total === 'number', JSON.stringify({ ok: kv.ok, via: kv.via, reason: kv.reason }));
    t.check('... it is the folder the registry names for FOLDERID_Downloads (the path is not printed)', !!reg && !!kv.folder && path.resolve(kv.folder).toLowerCase() === path.resolve(reg).toLowerCase(), `registry value ${reg ? 'read' : 'NOT read'}, ${reg && kv.folder && path.resolve(kv.folder).toLowerCase() === path.resolve(reg).toLowerCase() ? 'matches' : 'differs'}`);
    console.log(`  (the known folder: ${kv.total} visible entries, ${kv.hidden} hidden/system; names not requested)`);

    const t0 = Date.now();
    for (let i = 0; i < 5; i++) await s.send('downloads.list', { max: 0 }, 6000);   // the whole walk, no names sent
    const ms = (Date.now() - t0) / 5;
    t.check('a re-read of the real Downloads folder is cheap (under 150 ms each, 5 reads)', ms < 150, `${ms.toFixed(1)} ms each`);
    console.log(`  (a re-read: ${ms.toFixed(1)} ms each, a full walk of ${kv.total} entries; max 0, so no names were sent)`);
  } finally {
    await s.stop();
    try { execFileSync('attrib', ['-h', '-s', hid], { windowsHide: true }); execFileSync('attrib', ['-s', sys], { windowsHide: true }); } catch (_) { /* best effort */ }
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* best effort */ }
  }
  process.exit(t.summary());
})();

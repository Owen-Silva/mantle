// test-sysstorage.js - the Storage backend (SysStorage.cs + SysStorageFiles.cs, lane storage, 2026-09-29).
//
//   node sidecar/test-sysstorage.js --exe=<your built Mantle.Sidecar.exe>   [--verbose] [--no-scan]
//
// NEVER deletes or changes anything of Owen's: every Storage Sense change and every cleanup is sent with
// dryRun (and a re-read proves nothing moved), every real write goes to a PASSIVE sidecar and must answer
// the passive refusal. The real guard + delete run ONLY inside the test sandbox
// (MANTLE_STORAGE_SANDBOX, default %TEMP%\mantle-test\storage\sandbox), on files this test
// made there, and the test proves a file outside it, a ".." path, a path through a junction and a
// Windows file are all REFUSED and still there afterwards. Reads are real (drives, Storage Sense, disks,
// the cleanup kinds' sizes, one full category scan). Output: counts and shapes only - never a file,
// folder or drive label (privacy rule).
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const T = require('./test-lib');

const VERBOSE = process.argv.includes('--verbose');
const NO_SCAN = process.argv.includes('--no-scan');
const REFUSAL = T.PASSIVE_REFUSAL || 'refused: sidecar is passive (test mode)';
const SANDBOX = process.env.MANTLE_STORAGE_SANDBOX ||
  path.join(os.tmpdir(), 'mantle-test', 'storage', 'sandbox');
const OUTSIDE = path.join(path.dirname(SANDBOX), 'outside');
const KINDS = ['temp', 'thumbnails', 'systemTemp', 'deliveryOptimization', 'windowsUpdate', 'recycleBin', 'downloads'];
const CATS = ['apps', 'documents', 'pictures', 'videos', 'music', 'temp', 'system', 'otherUsers', 'other'];

(async () => {
  const t = T.checker('SYSSTORAGE');
  const s = await T.startPassive({ readyMs: 30000 });
  const send = (cmd, extra, ms) => s.send(cmd, extra || {}, ms || 20000);
  const refused = (r) => r && r.ok === false && typeof r.error === 'string' && r.error.startsWith(REFUSAL);
  const said = (r, re) => r && r.ok === false && re.test(String(r.error || ''));
  const noPath = (txt) => !/[A-Za-z]:\\/.test(String(txt || ''));
  const log = (...a) => { if (VERBOSE) console.log(...a); };
  try {
    // ------------------------------------------------------------ registration
    const ping = await send('elevate.list', {});
    const acts = ping.ok && ping.result && Array.isArray(ping.result.actions) ? ping.result.actions.map((a) => a.action) : [];
    t.check('elevate.list carries sysstorage.cleanSystem', acts.includes('sysstorage.cleanSystem'), acts.join(' '));
    const probs = ping.ok && ping.result && Array.isArray(ping.result.problems) ? ping.result.problems.filter((p) => /storage/i.test(JSON.stringify(p))) : [];
    t.check('elevate.list names no problem with a storage action', probs.length === 0, JSON.stringify(probs));

    // ------------------------------------------------------------ get: drives + Storage Sense
    const g = await send('sysstorage.get', {});
    t.check('get answers', g.ok === true && g.result && Array.isArray(g.result.drives), JSON.stringify(g).slice(0, 300));
    const G = g.result || {};
    const drives = G.drives || [];
    const sys = drives.find((d) => d.system);
    t.check('get: the Windows drive is listed, ready, with a size', sys && sys.ready && sys.total > 0 && sys.drive === G.systemDrive, JSON.stringify(sys && { d: sys.drive, t: sys.total }));
    t.check('get: used + free = total on every ready drive', drives.filter((d) => d.ready).every((d) => d.used + d.free === d.total && d.free >= 0));
    t.check('get: every drive has a letter and a type', drives.every((d) => /^[A-Z]:$/.test(d.drive) && /^(fixed|removable|cdrom|ram|other)$/.test(d.type)));
    t.check('get: a drive that is not ready says why', drives.every((d) => d.ready || typeof d.reason === 'string'));
    const S = G.sense || {};
    const sides = ['on', 'temp', 'cadence', 'recycleDays', 'downloadsDays'];
    t.check('get: every Storage Sense setting has value + writable (+ why when read-only)', sides.every((k) => S[k] && 'value' in S[k] && typeof S[k].writable === 'boolean' && (S[k].writable || typeof S[k].why === 'string')), JSON.stringify(S).slice(0, 300));
    t.check('get: switches are booleans, cadence and ages are numbers from Windows\' lists',
      typeof S.on.value === 'boolean' && typeof S.temp.value === 'boolean' && [0, 1, 7, 30].includes(S.cadence.value) || !S.cadence.writable,
      JSON.stringify([S.on && S.on.value, S.cadence && S.cadence.value]));
    t.check('get: recycle / downloads ages are numbers', Number.isInteger(S.recycleDays.value) && Number.isInteger(S.downloadsDays.value));
    t.check('get: cloud content is a list (or says why it is empty)', Array.isArray(S.cloud) && (S.cloud.length > 0 || typeof S.cloudWhy === 'string'));
    t.check('get: each cloud account has an account key, a label and days', S.cloud.every((c) => /^OneDrive!/.test(c.account) && /^OneDrive/.test(c.label) && Number.isInteger(c.value)));
    t.check('get: the scan state is reported', G.scan && typeof G.scan.state === 'string');
    t.check('get: whether Mantle runs as administrator is known', typeof G.admin === 'boolean');
    console.log(`measured: ${drives.length} drives (${drives.filter((d) => d.ready).length} ready), system ${sys ? Math.round(sys.used / 1e9) + '/' + Math.round(sys.total / 1e9) + ' GB used' : 'none'}; ` +
      `sense on=${S.on && S.on.value} temp=${S.temp && S.temp.value} cadence=${S.cadence && S.cadence.value} recycle=${S.recycleDays && S.recycleDays.value} downloads=${S.downloadsDays && S.downloadsDays.value} cloud accounts=${(S.cloud || []).length}; admin=${G.admin}`);

    // ------------------------------------------------------------ advanced
    const t0 = Date.now();
    const adv = await send('sysstorage.advanced', {}, 30000);
    const A = adv.result || {};
    t.check('advanced answers', adv.ok === true && Array.isArray(A.disks), JSON.stringify(adv).slice(0, 300));
    t.check('advanced: at least one disk with a size, bus and partitions', A.disks.length >= 1 && A.disks.every((d) => d.bytes > 0 && typeof d.bus === 'string' && Array.isArray(d.partitions)), A.disksReason);
    const allParts = A.disks.flatMap((d) => d.partitions);
    t.check('advanced: the Windows drive is one of the partitions, with its file system', allParts.some((p) => p.letter === G.systemDrive && typeof p.fs === 'string'));
    t.check('advanced: every partition has a kind and a size', allParts.every((p) => typeof p.kind === 'string' && p.bytes > 0));
    t.check('advanced: disks and pools are read-only WITH their reasons', /^Read only here: /.test(A.disksWhy) && /^Read only here: /.test(A.poolsWhy));
    t.check('advanced: pools is a list', Array.isArray(A.pools));
    t.check('advanced: 5 save locations, each read-only with a reason', Array.isArray(A.saveLocations) && A.saveLocations.length === 5 && A.saveLocations.every((x) => x.writable === false && typeof x.why === 'string' && (x.drive === null || /^[A-Z]:$/.test(x.drive))));
    t.check('advanced: backup is read with its reason', A.backup && typeof A.backup.fileHistory === 'boolean' && /^Read only here: /.test(A.backup.why));
    t.check('advanced: no reason carries a path', noPath(JSON.stringify([A.disksReason, A.poolsReason, A.disksWhy, A.saveLocations.map((x) => x.why), A.backup.why])));
    console.log(`measured: advanced in ${Date.now() - t0} ms; ${A.disks.length} disk(s) [${A.disks.map((d) => `${d.bus}/${d.media}/${d.style}/${d.partitions.length} parts`).join(', ')}]; ${A.pools.length} pools; file history ${A.backup.fileHistory}`);

    // ------------------------------------------------------------ temp: the cleanup kinds' sizes
    const t1 = Date.now();
    const tp = await send('sysstorage.temp', {}, 120000);
    const TK = (tp.result && tp.result.kinds) || [];
    t.check('temp answers with all 7 kinds', tp.ok === true && KINDS.every((k) => TK.some((x) => x.kind === k)), JSON.stringify(tp).slice(0, 300));
    t.check('temp: every kind is measured, or says why not', TK.every((x) => (x.measured && Number.isFinite(x.bytes) && (Number.isFinite(x.files) || (x.via === 'service' && x.files === null))) || (!x.measured && typeof x.reason === 'string' && x.bytes === null)));
    {
      // Delivery Optimization: its folder is administrators-only, so the size comes from the DO service (a real read)
      const d = TK.find((x) => x.kind === 'deliveryOptimization') || {};
      let wmi = null;
      try { wmi = Number(require('child_process').execSync('powershell -NoProfile -Command "(Get-CimInstance -Namespace root/Microsoft/Windows/DeliveryOptimization -ClassName MSFT_DOCurrentStatus -ErrorAction Stop | Select-Object -First 1).CacheSizeBytes"', { encoding: 'utf8', timeout: 30000 }).trim()); } catch (_) { wmi = null; }
      if (d.via === 'service') t.check('temp: Delivery Optimization is sized by the DO service, with no made-up file count, and matches it', d.measured === true && d.files === null && Number.isFinite(d.bytes) && (wmi === null || Number.isNaN(wmi) || Math.abs(d.bytes - wmi) <= Math.max(1, wmi * 0.05)), JSON.stringify([d, wmi]));
      else t.check('temp: Delivery Optimization is measured from its folder, or says why not', d.measured ? Number.isFinite(d.files) : typeof d.reason === 'string', JSON.stringify(d));
      t.check('temp: Windows temporary files stay unmeasured without an administrator, saying why', TK.some((x) => x.kind === 'systemTemp' && (x.measured || /only lets an administrator look inside/.test(x.reason || ''))));
    }
    t.check('temp: Downloads and the Recycle Bin are marked as Owen\'s own', TK.filter((x) => x.yours).map((x) => x.kind).sort().join() === 'downloads,recycleBin');
    t.check('temp: the administrator kinds are marked', TK.filter((x) => x.admin).map((x) => x.kind).sort().join() === 'deliveryOptimization,systemTemp,windowsUpdate');
    t.check('temp: Downloads goes to the Recycle Bin, the bin is emptied, the rest deleted', TK.every((x) => x.action === (x.kind === 'downloads' ? 'recycle' : x.kind === 'recycleBin' ? 'empty' : 'delete')));
    t.check('temp: what a cleanup would remove never exceeds what is there', TK.every((x) => !x.measured || x.bytes <= x.allBytes));
    t.check('temp: every kind has a label and its rule in words', TK.every((x) => x.label && x.rule && noPath(x.rule) && noPath(x.reason)));
    console.log(`measured: temp kinds in ${Date.now() - t1} ms: ${TK.map((x) => `${x.kind}=${x.measured ? Math.round(x.bytes / 1e6) + 'MB/' + x.files : 'unmeasured'}`).join(' ')}`);

    // ------------------------------------------------------------ plan
    t.check('plan without kinds is refused', said(await send('sysstorage.plan', {}), /needs kinds/));
    t.check('plan with an unknown kind is refused', said(await send('sysstorage.plan', { kinds: ['temp', 'everything'] }), /may only name/));
    t.check('plan naming a kind twice is refused', said(await send('sysstorage.plan', { kinds: ['temp', 'temp'] }), /twice/));
    t.check('plan with kinds that is not a list is refused', said(await send('sysstorage.plan', { kinds: 'temp' }), /needs kinds/));
    const p1 = await send('sysstorage.plan', { kinds: ['temp', 'thumbnails'] }, 120000);
    const P1 = p1.result || {};
    t.check('plan answers with a token and the two kinds', p1.ok && /^plan-\d+-[0-9a-f]{8}$/.test(P1.plan) && P1.items.length === 2, JSON.stringify(p1).slice(0, 300));
    t.check('plan: Downloads and the Recycle Bin are NOT in a plan that does not name them', !P1.items.some((x) => x.kind === 'downloads' || x.kind === 'recycleBin'));
    t.check('plan: ... and it says it leaves them alone', JSON.stringify(P1.leftAlone) === '["downloads","recycleBin"]');
    t.check('plan: totals add up', P1.totalBytes === P1.items.reduce((a, x) => a + (x.bytes || 0), 0) && P1.totalFiles === P1.items.reduce((a, x) => a + (x.files || 0), 0));
    t.check('plan: says nothing is deleted until it is confirmed', /Nothing is deleted until/.test(P1.note));

    // ------------------------------------------------------------ cleanup (dryRun / refusals only)
    t.check('cleanup without a plan is refused', said(await send('sysstorage.cleanup', { confirm: true, dryRun: true }), /needs plan/));
    t.check('cleanup with an unknown plan is refused', said(await send('sysstorage.cleanup', { plan: 'plan-999-deadbeef', confirm: true, dryRun: true }), /unknown/));
    t.check('cleanup without confirm:true is refused', said(await send('sysstorage.cleanup', { plan: P1.plan, dryRun: true }), /needs confirm: true/));
    t.check('cleanup with confirm:"yes" (not true) is refused', said(await send('sysstorage.cleanup', { plan: P1.plan, confirm: 'yes', dryRun: true }), /needs confirm: true/));
    const c1 = await send('sysstorage.cleanup', { plan: P1.plan, confirm: true, dryRun: true });
    const C1 = c1.result || {};
    t.check('cleanup dryRun answers what it would remove', c1.ok && C1.dryRun === true && Array.isArray(C1.writes) && C1.writes.length === 2 && C1.writes.every((w) => w.api === 'files' && typeof w.words === 'string'), JSON.stringify(c1).slice(0, 300));
    t.check('cleanup dryRun: the plan\'s kinds, no more', JSON.stringify(C1.kinds) === '["temp","thumbnails"]' && !C1.needsAdmin);
    t.check('cleanup dryRun: the words carry counts, never a path', C1.writes.every((w) => /^delete [\d,]+ files? \(/.test(w.words) && noPath(w.words)), C1.writes.map((w) => w.words).join(' | '));
    const c2 = await send('sysstorage.cleanup', { plan: P1.plan, confirm: true });
    t.check('cleanup for real in a passive sidecar is refused with the passive words', refused(c2), JSON.stringify(c2).slice(0, 200));
    t.check('a refused cleanup leaves the plan usable (dryRun still answers)', (await send('sysstorage.cleanup', { plan: P1.plan, confirm: true, dryRun: true })).ok === true);
    const p2 = await send('sysstorage.plan', { kinds: ['downloads', 'recycleBin', 'windowsUpdate'] }, 120000);
    const P2 = p2.result || {};
    t.check('plan: Downloads and the Recycle Bin are there when named', p2.ok && ['downloads', 'recycleBin'].every((k) => P2.items.some((x) => x.kind === k && x.yours === true)), JSON.stringify(p2).slice(0, 200));
    t.check('plan: ... and nothing is left alone', p2.ok && P2.leftAlone.length === 0);
    const c3 = await send('sysstorage.cleanup', { plan: P2.plan, confirm: true, dryRun: true });
    const C3 = c3.result || {};
    t.check('cleanup dryRun: Downloads is a move to the Recycle Bin, the bin an empty', c3.ok && C3.writes.find((w) => w.kind === 'downloads').action === 'recycle' && C3.writes.find((w) => w.kind === 'recycleBin').action === 'empty');
    t.check('cleanup dryRun: Windows Update cleanup needs the administrator step (this sidecar is not elevated)', G.admin || (C3.needsAdmin === true && JSON.stringify(C3.adminKinds) === '["windowsUpdate"]'), JSON.stringify(C3.adminKinds));
    let old = p1;
    for (let i = 0; i < 4; i++) old = await send('sysstorage.plan', { kinds: ['thumbnails'] }, 60000);
    t.check('only the last 4 plans are kept (an older token is unknown)', said(await send('sysstorage.cleanup', { plan: P1.plan, confirm: true, dryRun: true }), /unknown or was replaced/));

    // ------------------------------------------------------------ Storage Sense changes (dryRun only)
    const before = JSON.stringify((await send('sysstorage.get', {})).result.sense);
    const dry = async (key, value, extra) => send('sysstorage.senseSet', Object.assign({ key, value, dryRun: true }, extra || {}));
    const names = (r) => ((r.result && r.result.writes) || []).map((w) => `${w.name}=${w.value}`).join(',');
    const dOn = await dry('on', !S.on.value);
    t.check('senseSet on (dryRun) writes "01" in HKCU StoragePolicy', dOn.ok && dOn.result.dryRun && names(dOn) === `01=${S.on.value ? 0 : 1}` && dOn.result.writes[0].hive === 'HKCU' && /StorageSense\\Parameters\\StoragePolicy$/.test(dOn.result.writes[0].key), JSON.stringify(dOn).slice(0, 300));
    t.check('senseSet temp (dryRun) writes "04"', names(await dry('temp', false)) === '04=0');
    t.check('senseSet cadence 7 (dryRun) writes "2048"', names(await dry('cadence', 7)) === '2048=7');
    t.check('senseSet recycleDays 14 (dryRun) writes "08" on and "256" = 14', names(await dry('recycleDays', 14)) === '08=1,256=14');
    t.check('senseSet recycleDays 0 = Never (dryRun) writes "08" off only', names(await dry('recycleDays', 0)) === '08=0');
    t.check('senseSet downloadsDays 60 (dryRun) writes "32" on and "512" = 60', names(await dry('downloadsDays', 60)) === '32=1,512=60');
    t.check('senseSet dryRun carries the value before', (await dry('cadence', 30)).result.before === S.cadence.value);
    t.check('senseSet cadence 5 is refused (not one of Windows\' choices)', said(await dry('cadence', 5), /cadence needs value 1/));
    t.check('senseSet recycleDays 7 is refused', said(await dry('recycleDays', 7), /needs value 0 \(never\), 1, 14, 30 or 60/));
    t.check('senseSet on "yes" is refused', said(await dry('on', 'yes'), /true or false/));
    t.check('senseSet an unknown key is refused', said(await dry('everything', 1), /needs key/));
    t.check('senseSet cloudDays for an account that does not exist is refused', said(await dry('cloudDays', 14, { account: 'OneDrive!made-up!Personal|0' }), /needs account/));
    t.check('senseSet cloudDays with a path-like account is refused', said(await dry('cloudDays', 14, { account: '..\\..\\Run' }), /needs account/));
    if (S.cloud.length) {
      const dc = await dry('cloudDays', 14, { account: S.cloud[0].account });
      t.check('senseSet cloudDays (dryRun) writes "02" and "128" in the account\'s own key', names(dc) === '02=1,128=14' && dc.result.writes[0].key.endsWith(S.cloud[0].account), JSON.stringify(dc).slice(0, 300));
    }
    t.check('senseSet for real in a passive sidecar is refused', refused(await send('sysstorage.senseSet', { key: 'cadence', value: 7 })));
    const after = JSON.stringify((await send('sysstorage.get', {})).result.sense);
    t.check('Storage Sense reads back exactly as before (nothing was written)', after === before);

    // ------------------------------------------------------------ the sandbox: the REAL delete + guard
    fs.mkdirSync(path.join(SANDBOX, 'sub', 'deep'), { recursive: true });
    fs.mkdirSync(OUTSIDE, { recursive: true });
    for (const f of fs.readdirSync(SANDBOX)) fs.rmSync(path.join(SANDBOX, f), { recursive: true, force: true });
    fs.mkdirSync(path.join(SANDBOX, 'sub', 'deep'), { recursive: true });
    fs.writeFileSync(path.join(SANDBOX, 'a.txt'), 'made by test-sysstorage');
    fs.writeFileSync(path.join(SANDBOX, 'sub', 'b.txt'), 'made by test-sysstorage, b');
    fs.writeFileSync(path.join(SANDBOX, 'sub', 'deep', 'c.bin'), Buffer.alloc(4096, 7));
    const keep = path.join(OUTSIDE, 'keep.txt');
    fs.writeFileSync(keep, 'must survive');
    const link = path.join(SANDBOX, 'link');
    let junction = false;
    try { fs.symlinkSync(OUTSIDE, link, 'junction'); junction = true; } catch (e) { log('no junction: ' + e.code); }
    const win = path.join(process.env.windir || 'C:\\Windows', 'win.ini');
    const extra = [keep, SANDBOX + '\\..\\outside\\keep.txt', link + '\\keep.txt', win, path.join(SANDBOX, 'a.txt') + ':x', 'relative\\a.txt'];
    t.check('sandboxTest outside the sandbox is refused', said(await send('sysstorage.sandboxTest', { sandbox: OUTSIDE }), /lanes\\storage\\sandbox/));
    t.check('sandboxTest with no sandbox is refused', said(await send('sysstorage.sandboxTest', {}), /lanes\\storage\\sandbox/));
    const sd = await send('sysstorage.sandboxTest', { sandbox: SANDBOX, extra, dryRun: true });
    const SD = sd.result || {};
    t.check('sandbox dryRun: the 3 sandbox files would go, the 6 others are refused', sd.ok && SD.dryRun && SD.inSandbox === 3 && SD.would.files === 3 && SD.would.refused === 6, JSON.stringify(sd).slice(0, 400));
    t.check('sandbox: the walker did not enter the junction', !junction || SD.links === 1);
    const vw = (SD.verdicts || []).map((v) => `${v.index}:${v.allowed ? 'ALLOWED' : v.why}`);
    log(vw);
    t.check('guard: a file outside the sandbox is refused', SD.verdicts && /outside the folders/.test(SD.verdicts[0].why), vw[0]);
    t.check('guard: a ".." path is refused', SD.verdicts && /climbs/.test(SD.verdicts[1].why), vw[1]);
    t.check('guard: a path through a junction is refused', !junction || (SD.verdicts && /link or junction/.test(SD.verdicts[2].why)), vw[2]);
    t.check('guard: a Windows file is refused', SD.verdicts && /outside the folders/.test(SD.verdicts[3].why), vw[3]);
    t.check('guard: a stream name is refused', SD.verdicts && /character Windows does not allow/.test(SD.verdicts[4].why), vw[4]);
    t.check('guard: a relative path is refused', SD.verdicts && /not a full local path/.test(SD.verdicts[5].why), vw[5]);
    t.check('sandbox dryRun deleted nothing', fs.existsSync(path.join(SANDBOX, 'a.txt')) && fs.existsSync(path.join(SANDBOX, 'sub', 'deep', 'c.bin')));
    const sr = await send('sysstorage.sandboxTest', { sandbox: SANDBOX, extra, stale: true });
    const SR = sr.result || {};
    const left = ['a.txt', 'sub\\b.txt', 'sub\\deep\\c.bin'].filter((f) => fs.existsSync(path.join(SANDBOX, f)));
    t.check('sandbox delete: 2 removed, the stale one "changed", the 6 others refused', sr.ok && SR.deleted.removed === 2 && SR.deleted.changed === 1 && SR.deleted.refused === 6, JSON.stringify(sr).slice(0, 400));
    t.check('sandbox delete: exactly the stale file is still there', left.length === 1 && path.basename(left[0]) === SR.stale, left.join(' '));
    t.check('sandbox delete: the file outside survived', fs.existsSync(keep) && fs.readFileSync(keep, 'utf8') === 'must survive');
    t.check('sandbox delete: the junction and its target survived', !junction || (fs.existsSync(link) && fs.existsSync(path.join(link, 'keep.txt'))));
    t.check('sandbox delete: the Windows file survived', fs.existsSync(win));
    try { if (junction) fs.unlinkSync(link); } catch (_) { /* gone */ }
    for (const f of fs.readdirSync(SANDBOX)) fs.rmSync(path.join(SANDBOX, f), { recursive: true, force: true });

    // ------------------------------------------------------------ the category scan (a READ)
    const rc0 = await send('sysstorage.recommend', {});
    t.check('recommend before any scan says to scan first', rc0.ok && rc0.result.files.length === 0 && /Scan a drive first/.test(rc0.result.reason));
    t.check('scan of a drive that is not there is refused', said(await send('sysstorage.scan', { drive: 'Q:' }), /not a ready local drive/));
    t.check('scan with a path for a drive is refused', said(await send('sysstorage.scan', { drive: 'C:\\Windows' }), /needs drive/));
    if (!NO_SCAN) {
      const st1 = await send('sysstorage.scan', {});
      t.check('scan starts at once and answers its token', st1.ok && st1.result.started && /^scan-\d+$/.test(st1.result.scan) && st1.result.total >= 8, JSON.stringify(st1).slice(0, 200));
      t.check('a second scan while one runs is refused', said(await send('sysstorage.scan', {}), /already running/));
      await s.waitEvent('sysstorage', 10000, (e) => e.what === 'progress' && e.scan === st1.result.scan);
      const stop = await send('sysstorage.scanStop', {});
      t.check('scanStop stops a running scan', stop.ok && stop.result.stopping === true);
      const canc = await s.waitEvent('sysstorage', 30000, (e) => e.what === 'cancelled' && e.scan === st1.result.scan).catch(() => null);
      t.check('a stopped scan ends with a cancelled event', !!canc);
      const t2 = Date.now();
      const st2 = await send('sysstorage.scan', { drive: G.systemDrive });
      t.check('a new scan starts after the cancelled one', st2.ok && st2.result.started);
      const done = await s.waitEvent('sysstorage', 600000, (e) => (e.what === 'done' || e.what === 'failed') && e.scan === st2.result.scan).catch(() => null);
      const ms = Date.now() - t2;
      t.check('the scan ends with a done event', done && done.what === 'done', JSON.stringify(done).slice(0, 300));
      const cats = (done && done.categories) || [];
      t.check('done: the 9 categories in order', cats.map((c) => c.key).join() === CATS.join(), cats.map((c) => c.key).join());
      t.check('done: every category has bytes >= 0 and a label', cats.every((c) => Number.isFinite(c.bytes) && c.bytes >= 0 && c.label));
      const sum = cats.reduce((a, c) => a + c.bytes, 0);
      t.check('done: the categories add up to the used space (within 1%)', done && Math.abs(sum - done.used) <= done.used * 0.01 + 1e6, `${sum} vs ${done && done.used}`);
      t.check('done: a category that could not be read fully says why', cats.every((c) => !c.denied || typeof c.reason === 'string'));
      const prog = s.collect('sysstorage').filter((e) => e.scan === st2.result.scan && e.what === 'progress');
      t.check('progress events arrive, counting up', prog.length >= 2 && prog.every((e, i) => i === 0 || e.bytes >= prog[i - 1].bytes), `n=${prog.length}`);
      t.check('progress events carry counts only (done, total, bytes, files, category)', prog.every((e) => Object.keys(e).every((k) => ['ev', 'what', 'scan', 'drive', 'done', 'total', 'bytes', 'files', 'category'].includes(k))));
      const allEv = JSON.stringify(s.collect('sysstorage'));
      t.check('no storage event carries a path or file name', noPath(allEv) && !/\.(txt|db|sys|exe|dll|bin)\b/i.test(allEv));
      const g2 = await send('sysstorage.get', {});
      t.check('get: the scan is done and its result is kept', g2.ok && g2.result.scan.state === 'done' && g2.result.scan.result && g2.result.scan.result.categories.length === 9);
      const rc = await send('sysstorage.recommend', {});
      const RC = rc.result || {};
      t.check('recommend lists large or unused files (or says there are none)', rc.ok && Array.isArray(RC.files) && (RC.files.length > 0 || typeof RC.reason === 'string') && RC.files.length <= 25);
      t.check('recommend: each has a name, folder, size, date and why', RC.files.every((f) => f.name && f.folder && f.bytes >= 20 * 1048576 && /^\d{4}-/.test(f.modified) && (f.why === 'large' ? f.bytes >= 100 * 1048576 : f.why === 'unused')));
      t.check('recommend: largest first', RC.files.every((f, i) => i === 0 || f.bytes <= RC.files[i - 1].bytes));
      console.log(`measured: full scan of the Windows drive in ${Math.round(ms / 1000)} s, ${prog.length} progress events; ` +
        cats.map((c) => `${c.key}=${(c.bytes / 1e9).toFixed(1)}G${c.denied ? `(${c.denied} denied)` : ''}`).join(' ') + `; ${RC.files.length} recommendations`);
    } else console.log('scan skipped (--no-scan)');
    t.check('nothing on stderr names a folder or file', noPath(s.stderr) || !/Users\\|Temp\\/i.test(s.stderr), s.stderr.slice(0, 200));
  } catch (e) {
    t.fail('the test threw', e && e.stack ? e.stack.split('\n').slice(0, 3).join(' ') : String(e));
  } finally {
    await s.stop();
  }
  process.exit(t.summary());
})();

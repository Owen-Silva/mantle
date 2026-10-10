'use strict';
/* pingtest-history.test.js -- the PING dropdown's list of past ping tests (lane pingtest-hist,
 * 2026-10-09): lib/features/_pingtest-history.js against a real temp folder, plus a fake fs for a
 * write that fails. Plain node, no Electron.
 *   node lib/features/pingtest-history.test.js   -> "PINGTEST HISTORY TEST: n passed, m failed" */
const fs = require('fs');
const os = require('os');
const path = require('path');
const PH = require('./_pingtest-history');

let passed = 0;
const failures = [];
const check = (name, ok, detail) => { if (ok) passed++; else failures.push(detail ? `${name} (${detail})` : name); };

const WIFI = 'HomeNetSecret';
const TNAME = 'Ranked night test';
const logs = [];
const allLogs = [];
const logger = (l) => { logs.push(String(l)); allLogs.push(String(l)); };

function mkRun(n, at, extra) {
  return Object.assign({
    run: n, phase: 'done', running: false, startedAt: at, endedAt: at + 30000, label: 'Valorant', host: 'speed.cloudflare.com',
    routerWhy: null, listWhy: null, wifi: { kind: 'wifi', name: WIFI, why: null }, wifiChanged: null,
    rows: [
      { kind: 'router', name: 'Your router', host: '10.0.0.1', iface: 'Wi-Fi', wifi: true, method: 'icmp', sent: 20, got: 20, avg: 2.4, min: 1.6, max: 4.1, jitter: 0.6, loss: 0, best: false, secret: 'x' },
      { kind: 'server', name: 'US West (N. California)', host: 'dynamodb.us-west-1.amazonaws.com', via: 'AWS us-west-1', method: 'icmp', sent: 20, got: 20, avg: 15.8, min: 14, max: 19, jitter: 1.2, loss: 0, best: true },
    ],
    down: { state: 'ok', mbps: 62, bytes: 60000000, ms: 7908, why: null, live: null },
    up: { state: 'ok', mbps: 30.8, bytes: 25000000, ms: 6004, why: null, live: null },
    caps: { a: 1 }, progress: 1,
  }, extra || {});
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mantle-pinghist-'));
let caseN = 0;
const caseDir = () => { const d = path.join(tmpRoot, 'c' + (++caseN)); fs.mkdirSync(d, { recursive: true }); return d; };
const parses = (f) => { try { const d = JSON.parse(fs.readFileSync(f, 'utf8')); return d.version === 1 && Array.isArray(d.tests); } catch (_) { return false; } };
const noTmp = (d) => !fs.readdirSync(d).some((n) => n.endsWith('.tmp'));

try {
  /* ---- checkName ---- */
  check('checkName: trims', PH.checkName('  Home  ').ok && PH.checkName('  Home  ').name === 'Home');
  check('checkName: empty refused', PH.checkName('   ').reason === 'a name needs 1 to 60 characters');
  check('checkName: 61 chars refused, 60 ok', PH.checkName('a'.repeat(61)).reason === 'a name needs 1 to 60 characters' && PH.checkName('a'.repeat(60)).ok);
  check('checkName: control char refused', PH.checkName('a\x01b').reason === 'a name cannot hold control characters' && PH.checkName('a\x7fb').ok === false);
  check('checkName: not a string refused', PH.checkName(null).ok === false && PH.checkName(5).ok === false);
  check('MAX_UNSAVED is 50', PH.MAX_UNSAVED === 50);

  /* ---- entryOf ---- */
  check('entryOf: null run / not done / no startedAt -> null', PH.entryOf(null) === null && PH.entryOf(mkRun(1, 5, { phase: 'running' })) === null && PH.entryOf(mkRun(1, 0)) === null);
  const e = PH.entryOf(mkRun(7, 1791590521956));
  check('entryOf: id + times', e.id === '1791590521956-7' && e.at === 1791590521956 && e.endedAt === 1791590551956 && e.name === null && e.saved === false);
  check('entryOf: wifi as given', e.wifi && e.wifi.kind === 'wifi' && e.wifi.name === WIFI && e.wifi.why === null && e.wifiChanged === null);
  check('entryOf: label/host', e.label === 'Valorant' && e.host === 'speed.cloudflare.com');
  check('entryOf: best picked', JSON.stringify(e.best) === JSON.stringify({ name: 'US West (N. California)', avg: 15.8, jitter: 1.2, loss: 0 }));
  check('entryOf: router picked', JSON.stringify(e.router) === JSON.stringify({ host: '10.0.0.1', avg: 2.4, jitter: 0.6, loss: 0, iface: 'Wi-Fi' }));
  check('entryOf: speeds copied without ms/live', JSON.stringify(e.down) === JSON.stringify({ mbps: 62, bytes: 60000000, why: null, state: 'ok', server: null, note: null }) && e.up.mbps === 30.8 && !('ms' in e.up));
  const el = PH.entryOf(mkRun(4, 9, { wifi: { kind: 'wifi', name: 'Mesh', why: null, link: { kind: 'wifi', bssid: 'AA:BB:CC:00:00:01', signal: 70, rssi: -58, band: '5 GHz', channel: 157, phy: 'Wi-Fi 6 (802.11ax)', rxMbps: 1201, txMbps: 576, why: null, missing: { rssi: 'x' } } }, linkEnd: { kind: 'wifi', bssid: 'AA:BB:CC:00:00:02', band: '2.4 GHz' }, linkChanged: 'the Wi-Fi moved' }));
  check('entryOf: the link (signal, band, channel, PHY, rates, access point, what was not given), the end link and a roam note are kept', el.wifi.link.signal === 70 && el.wifi.link.band === '5 GHz' && el.wifi.link.rxMbps === 1201 && el.wifi.link.missing.rssi === 'x' && el.linkEnd.bssid === 'AA:BB:CC:00:00:02' && el.linkChanged === 'the Wi-Fi moved', JSON.stringify(el.wifi));
  { const e0 = PH.entryOf(mkRun(5, 9, {})); check('entryOf: no link recorded -> null, never undefined', e0.linkEnd === null && e0.linkChanged === null); }
  const ef = PH.entryOf(mkRun(3, 9, { down: { state: 'ok', mbps: 71, bytes: 35e6, server: 'Linode Fremont', note: 'Cloudflare was busy: too many requests', live: 3, tried: [{}] } }));
  check('entryOf: the server that measured and why a fallback was used are kept (not its tried list)', ef.down.server === 'Linode Fremont' && ef.down.note === 'Cloudflare was busy: too many requests' && !('tried' in ef.down), JSON.stringify(ef.down));
  check('entryOf: rows copied, no extra fields', e.rows.length === 2 && !('secret' in e.rows[0]) && e.rows[1].via === 'AWS us-west-1' && Object.keys(e.rows[0]).length === 17);
  const want = ['id', 'at', 'endedAt', 'name', 'saved', 'wifi', 'wifiChanged', 'linkEnd', 'linkChanged', 'label', 'host', 'best', 'router', 'routerWhy', 'listWhy', 'down', 'up', 'rows'];
  check('entryOf: only the listed fields (no caps/progress)', JSON.stringify(Object.keys(e).sort()) === JSON.stringify(want.slice().sort()));
  const e2 = PH.entryOf(mkRun(2, 9, { rows: [{ kind: 'server', name: 's', best: false }], down: undefined, wifi: undefined }));
  check('entryOf: no best / no router / no wifi -> null', e2.best === null && e2.router === null && e2.wifi === null && e2.down.mbps === null);

  /* ---- add, order, duplicates, persistence ---- */
  let d = caseDir();
  let file = path.join(d, 'sub', 'ping-tests.json');
  let h = PH.makeHistory({ file, log: logger });
  check('fresh: empty, no problem, missing dir ok', h.view().tests.length === 0 && h.view().problem === null && h.view().max === 50);
  const a1 = h.add(mkRun(1, 1000));
  const a2 = h.add(mkRun(2, 3000));
  const a3 = h.add(mkRun(3, 2000));
  check('add: returns entries', a1 && a1.id === '1000-1' && a2 && a3);
  check('add: newest first', h.view().tests.map((t) => t.id).join(',') === '3000-2,2000-3,1000-1');
  check('add: same run twice ignored', h.add(mkRun(2, 3000)) === null && h.view().tests.length === 3);
  check('add: not-done run ignored', h.add(mkRun(4, 4000, { phase: 'running' })) === null);
  check('file written, parses, no .tmp', parses(file) && noTmp(path.dirname(file)));
  check('view: a copy (mutating it does not change history)', (() => { const v = h.view(); v.tests[0].name = 'x'; return h.view().tests[0].name === null; })());

  /* ---- save / rename / remove ---- */
  check('rename unsaved refused', h.rename('2000-3', 'X').reason === 'only a saved test can be renamed');
  const s1 = h.save('2000-3', '  ' + TNAME + ' ');
  check('save: ok, trimmed, saved', s1.ok && s1.entry.name === TNAME && s1.entry.saved === true);
  check('save: file parses after', parses(file) && noTmp(path.dirname(file)));
  check('save: bad names', h.save('1000-1', '').reason === 'a name needs 1 to 60 characters' && h.save('1000-1', 'b'.repeat(61)).reason === 'a name needs 1 to 60 characters' && h.save('1000-1', 'a\nb').reason === 'a name cannot hold control characters');
  check('save: bad name leaves it unsaved', h.view().tests.find((t) => t.id === '1000-1').saved === false);
  check('save: unknown id', h.save('nope', 'x').reason === 'that test is no longer in the history');
  const r1 = h.rename('2000-3', 'Second name');
  check('rename: ok', r1.ok && r1.entry.name === 'Second name' && parses(file));
  check('rename: unknown id / bad name', h.rename('nope', 'x').reason === 'that test is no longer in the history' && h.rename('2000-3', '').reason === 'a name needs 1 to 60 characters');
  check('remove: ok', h.remove('1000-1').ok === true && h.view().tests.length === 2 && parses(file));
  check('remove: unknown id', h.remove('1000-1').reason === 'that test is no longer in the history');
  check('remove: a saved one too', (() => { h.save('3000-2', 'Keep'); return h.remove('3000-2').ok && h.view().tests.length === 1; })());

  const h2 = PH.makeHistory({ file, log: logger });
  const v2 = h2.view();
  check('persistence: a second history reads the same tests', v2.tests.length === 1 && v2.tests[0].id === '2000-3' && v2.tests[0].name === 'Second name' && v2.tests[0].saved === true && v2.tests[0].wifi.name === WIFI && v2.problem === null);

  /* ---- prune ---- */
  d = caseDir();
  file = path.join(d, 'ping-tests.json');
  h = PH.makeHistory({ file, log: logger });
  const savedIds = [];
  let okEvery = true;
  for (let i = 1; i <= 63; i++) {
    const ent = h.add(mkRun(i, 100000 + i * 10));
    if (i === 2 || i === 30 || i === 61) { h.save(ent.id, 'Saved ' + i); savedIds.push(ent.id); }
    if (!parses(file)) okEvery = false;
  }
  const pv = h.view().tests;
  check('prune: 53 kept', pv.length === 53, String(pv.length));
  check('prune: all 3 saved kept', savedIds.every((id) => pv.some((t) => t.id === id && t.saved)));
  const unsavedKept = pv.filter((t) => !t.saved).map((t) => t.at);
  const allUnsaved = []; for (let i = 1; i <= 63; i++) if (![2, 30, 61].includes(i)) allUnsaved.push(100000 + i * 10);
  const newest50 = allUnsaved.sort((x, y) => y - x).slice(0, 50);
  check('prune: the 50 newest unsaved kept', JSON.stringify(unsavedKept) === JSON.stringify(newest50));
  check('prune: file parsed after every op, no .tmp', okEvery && noTmp(d));
  check('prune: file holds 53', JSON.parse(fs.readFileSync(file, 'utf8')).tests.length === 53);

  /* ---- corrupt file ---- */
  d = caseDir();
  file = path.join(d, 'ping-tests.json');
  const badBytes = '{"tests": 5, "x": "' + WIFI + '"}';
  fs.writeFileSync(file, badBytes);
  fs.writeFileSync(path.join(d, 'ping-tests.bad.json'), 'older bad');
  logs.length = 0;
  h = PH.makeHistory({ file, log: logger });
  const want1 = 'history could not be read: the file does not hold a list of tests; starting fresh, old file kept as ping-tests.bad.json';
  check('corrupt shape: problem text exact', h.view().problem === want1, h.view().problem);
  check('corrupt shape: .bad.json holds the original bytes (older one replaced)', fs.readFileSync(path.join(d, 'ping-tests.bad.json'), 'utf8') === badBytes);
  check('corrupt shape: history works after', h.add(mkRun(1, 5000)) && parses(file) && h.view().tests.length === 1);
  check('corrupt shape: problem stays after a good write', h.view().problem === want1);
  check('corrupt shape: one log line', logs.length === 1, String(logs.length));

  d = caseDir();
  file = path.join(d, 'ping-tests.json');
  const junk = '{ "tests": [ ' + WIFI + ' ';
  fs.writeFileSync(file, junk);
  h = PH.makeHistory({ file, log: logger });
  const pj = h.view().problem || '';
  check('corrupt JSON: problem text', /^history could not be read: the file is damaged( near character \d+)?; starting fresh, old file kept as ping-tests\.bad\.json$/.test(pj), pj);
  check('corrupt JSON: no file text in the problem', !pj.includes(WIFI));
  check('corrupt JSON: .bad.json holds the original bytes', fs.readFileSync(path.join(d, 'ping-tests.bad.json'), 'utf8') === junk);
  check('corrupt JSON: history works after', h.add(mkRun(1, 5000)) && parses(file));

  d = caseDir();
  file = path.join(d, 'ping-tests.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, tests: [PH.entryOf(mkRun(1, 10)), 5, { id: 3 }, null, PH.entryOf(mkRun(2, 20))] }));
  logs.length = 0;
  h = PH.makeHistory({ file, log: logger });
  check('bad entries dropped, not fatal', h.view().tests.length === 2 && h.view().problem === null && logs.length === 1 && /dropped 3/.test(logs[0]), logs.join('|'));

  /* ---- unreadable: file is a directory ---- */
  d = caseDir();
  file = path.join(d, 'ping-tests.json');
  fs.mkdirSync(file);
  fs.writeFileSync(path.join(file, 'inside.txt'), 'keep me');
  h = PH.makeHistory({ file, log: logger });
  const pu = h.view().problem || '';
  check('unreadable (moved aside): problem says read + kept', /^history could not be read: .+; starting fresh, old file kept as ping-tests\.bad\.json$/.test(pu) && !/EISDIR/.test(pu), pu);
  check('unreadable (moved aside): old one kept intact', fs.readFileSync(path.join(d, 'ping-tests.bad.json', 'inside.txt'), 'utf8') === 'keep me');
  check('unreadable (moved aside): new history writes', h.add(mkRun(1, 5000)) && parses(file));

  d = caseDir();
  file = path.join(d, 'ping-tests.json');
  fs.mkdirSync(file);
  fs.writeFileSync(path.join(file, 'inside.txt'), 'keep me');
  fs.mkdirSync(path.join(d, 'ping-tests.bad.json'));
  fs.writeFileSync(path.join(d, 'ping-tests.bad.json', 'blocker.txt'), 'x'); // the move aside cannot land here
  h = PH.makeHistory({ file, log: logger });
  const pm = h.view().problem || '';
  check('unreadable (cannot move): problem says memory only', /^history could not be read: .+; the old file could not be moved aside \(.+\), so new tests are kept only until Mantle restarts$/.test(pm) && !/E[A-Z]{3,}/.test(pm), pm);
  const am = h.add(mkRun(1, 5000));
  check('unreadable (cannot move): tests kept in memory', am && h.view().tests.length === 1 && h.save(am.id, 'x').ok);
  check('unreadable (cannot move): nothing written over it', fs.statSync(file).isDirectory() && fs.readFileSync(path.join(file, 'inside.txt'), 'utf8') === 'keep me' && fs.readdirSync(file).length === 1 && noTmp(d));

  /* ---- write failure via a fake fs ---- */
  d = caseDir();
  file = path.join(d, 'ping-tests.json');
  let failWrites = true;
  const fakeFs = Object.assign({}, fs, {
    writeFileSync(f, data) {
      if (failWrites) { const er = new Error(`EACCES: permission denied, open '${f}'`); er.code = 'EACCES'; throw er; }
      return fs.writeFileSync(f, data);
    },
  });
  logs.length = 0;
  h = PH.makeHistory({ file, fs: fakeFs, log: logger });
  const w1 = h.add(mkRun(1, 1000));
  check('write fail: add still returns the entry', w1 && w1.id === '1000-1');
  check('write fail: problem text', h.view().problem === 'history could not be saved: permission denied', h.view().problem);
  check('write fail: in memory', h.view().tests.length === 1 && !fs.existsSync(file));
  h.add(mkRun(2, 2000));
  check('write fail: logged once for the same failure', logs.filter((l) => /could not save/.test(l)).length === 1, logs.join('|'));
  failWrites = false;
  h.add(mkRun(3, 3000));
  check('write fail: cleared by the next good write', h.view().problem === null && parses(file) && JSON.parse(fs.readFileSync(file, 'utf8')).tests.length === 3);

  d = caseDir();
  file = path.join(d, 'ping-tests.json');
  fs.writeFileSync(file, 'not json');
  failWrites = true;
  h = PH.makeHistory({ file, fs: fakeFs, log: logger });
  h.add(mkRun(1, 1000));
  const both = h.view().problem || '';
  check('both problems joined with " · "', both.startsWith('history could not be read: ') && both.endsWith(' · history could not be saved: permission denied'), both);
  failWrites = false;
  h.add(mkRun(2, 2000));
  check('good write clears only the save problem', /^history could not be read: /.test(h.view().problem) && !/could not be saved/.test(h.view().problem));

  /* ---- privacy ---- */
  check('logs: some lines were written', allLogs.length >= 5, String(allLogs.length));
  check('logs: no Wi-Fi name or test name', allLogs.every((l) => !l.includes(WIFI) && !l.includes(TNAME) && !/Saved \d|Second name|Keep/.test(l)), allLogs.find((l) => l.includes(WIFI) || l.includes(TNAME)));
} catch (err) {
  failures.push('crashed: ' + (err && err.stack || err));
} finally {
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) { /* best effort */ }
}

console.log(`PINGTEST HISTORY TEST: ${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log('  FAIL ' + f);
process.exit(failures.length || !passed ? 1 : 0);

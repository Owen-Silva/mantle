// test-clipboard.js - the clipboard-history feature's sidecar half (ClipHistory.cs), against a
// PASSIVE sidecar. Plain node, no deps.
//
//   MANTLE_SIDECAR_EXE=<exe> node sidecar/test-clipboard.js
//
// THE USER'S CLIPBOARD IS NEVER WRITTEN AND NEVER READ FOR CONTENT: every item here is seeded
// (clip.seed, a passive-only command), every paste is a DRY RUN (the formats are built and decoded
// back, nothing is set, focused or typed), and the one live-listener check runs in the passive
// "observe" mode, which keeps counts and format names only. Nothing the user copied can reach this
// output: the only strings printed are this file's own fixtures.
//
// THE COPY PATH ITSELF (privacy flags, kinds, sizes, dedupe) is proved with clip.capture: a
// passive-only command that runs the SAME Capture a real copy takes, over this file's own fixture
// formats instead of the clipboard. So "a password manager's copy is never kept" is tested for
// each of the four flags without the user's clipboard being opened, read or written.
//
// Temp files (the pins stores) go under MANTLE_CLIP_TEST_DIR when it is set, else %TEMP%.
//
// Prints exactly one summary line and exits non-zero if anything failed.
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

// default: this checkout's built sidecar like every other harness (it was a lane's long-gone %TEMP% build)
const EXE = process.env.MANTLE_SIDECAR_EXE || path.join(__dirname, 'bin', 'Mantle.Sidecar.exe');
const PASSIVE = 'refused: sidecar is passive (test mode)';

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) pass++;
  else { fail++; console.log('FAIL ' + name + (detail !== undefined ? ' :: ' + detail : '')); }
}

function start(args) {
  const proc = spawn(EXE, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  const events = [];
  let nextId = 1, buf = '';
  proc.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch (e) { events.push({ ev: '__unparseable' }); continue; }
      if (msg.ev !== undefined) events.push(msg);
      else if (pending.has(msg.id)) { const d = pending.get(msg.id); pending.delete(msg.id); d(msg); }
    }
  });
  proc.stderr.on('data', () => {});
  function send(cmd, extra, timeoutMs) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { pending.delete(id); reject(new Error('no reply to ' + cmd)); }, timeoutMs || 10000);
      pending.set(id, (m) => { clearTimeout(t); resolve(m); });
      proc.stdin.write(JSON.stringify(Object.assign({ id, cmd }, extra || {})) + '\n');
    });
  }
  function quit() {
    return new Promise((resolve) => {
      proc.on('exit', () => resolve());
      try { proc.stdin.write(JSON.stringify({ id: 999999, cmd: 'quit' }) + '\n'); } catch (e) { resolve(); }
      setTimeout(() => { try { proc.kill(); } catch (e) { } resolve(); }, 3000);
    });
  }
  return { proc, send, events, quit };
}

const R = (m) => (m && m.result) || {};

async function main() {
  if (!fs.existsSync(EXE)) { console.log('clipboard sidecar: 0 passed, 1 failed (no exe at ' + EXE + ')'); process.exit(1); }
  const base = process.env.MANTLE_CLIP_TEST_DIR || os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(base, 'mantle-clip-test-'));
  const pins = path.join(tmp, 'pins.dat');
  const s = start(['--passive', '--parent-pid=' + process.pid]);
  try {
    const ping = await s.send('ping');
    const cmds = (((ping.result || {}).features) || {}).commands || [];
    for (const c of ['clip.start', 'clip.stop', 'clip.status', 'clip.list', 'clip.arm', 'clip.pin',
                     'clip.delete', 'clip.clear', 'clip.restore', 'clip.forget', 'clip.seed', 'clip.capture',
                     'clip.limits', 'clip.paste']) {
      check('ping lists ' + c, cmds.includes(c), JSON.stringify(cmds));
    }
    const probs = (((ping.result || {}).features) || {}).problems || [];
    check('no feature failed to register', !probs.some((p) => /Clip/.test(p)), JSON.stringify(probs));

    // ---- status before anything
    let st = R(await s.send('clip.status'));
    check('status: mode off before start', st.mode === 'off', st.mode);
    check('status: source is mantle', st.source === 'mantle');
    check('status: passive reported', st.passive === true);
    check('status: Windows history switch is reported as a boolean',
      st.windowsHistory && typeof st.windowsHistory.enabled === 'boolean', JSON.stringify(st.windowsHistory));

    // ---- start without a listener, with a pins file
    st = R(await s.send('clip.start', { listen: false, pinsFile: pins }));
    check('start listen:false = mode off, no error', st.mode === 'off' && !st.error, JSON.stringify({ m: st.mode, e: st.error }));

    // ---- seed a fixture (items[0] = newest)
    const SECRET = 'fixture-marker-7f3a9c';   // must never appear in the pins file in the clear
    const seed = await s.send('clip.seed', {
      reset: true,
      items: [
        { kind: 'text', text: 'hello ' + SECRET + '\nsecond line\nthird line\nfourth line' },
        { kind: 'text', text: 'bold words', html: '<b>bold words</b>', agoMs: 60000 },
        { kind: 'image', w: 97, h: 41, color: '#2A9D8F', agoMs: 120000 },
        { kind: 'files', paths: ['C:\\fixture\\report.pdf', 'C:\\fixture\\photos'], agoMs: 3600000 },
      ],
    });
    check('seed ok', seed.ok === true, seed.error);
    let list = R(await s.send('clip.list'));
    const items = list.items || [];
    check('list has 4 items', items.length === 4, items.length);
    check('order: newest first', items.map((i) => i.kind).join() === 'text,text,image,files', items.map((i) => i.kind).join());
    check('text item: chars and lines', items[0] && items[0].lines === 4 && items[0].chars === items[0].text.length);
    check('html item is rich', items[1] && items[1].rich === true);
    check('image item: size and a JPEG thumbnail',
      items[2] && items[2].w === 97 && items[2].h === 41 && /^data:image\/jpeg;base64,/.test(items[2].thumb || ''));
    check('files item: names and count',
      items[3] && items[3].fileCount === 2 && items[3].files[0].name === 'report.pdf' && items[3].files[1].name === 'photos');
    check('timestamps descend', items.every((it, i) => i === 0 || it.ts <= items[i - 1].ts));
    check('ids are unique', new Set(items.map((i) => i.id)).size === items.length);

    // ---- dry-run paste of every kind: formats built and decoded back, nothing set or typed
    const arm = R(await s.send('clip.arm'));
    check('arm: ok with a hwnd string and a cursor', arm.ok === true && typeof arm.hwnd === 'string' && arm.cursor && typeof arm.cursor.x === 'number');
    const want = { text: ['CF_UNICODETEXT'], image: ['PNG', 'CF_DIB'], files: ['CF_HDROP', 'Preferred DropEffect'] };
    for (const it of items) {
      const t0 = Date.now();
      const d = await s.send('clip.paste', { item: it.id, hwnd: arm.hwnd, dryRun: true });
      const r = R(d);
      const names = (r.formats || []).map((f) => f.name);
      check('dry paste ' + it.kind + ': ok', d.ok === true && r.dryRun === true, d.error);
      check('dry paste ' + it.kind + ': round trip', r.roundTrip === true, r.roundTripError);
      check('dry paste ' + it.kind + ': formats ' + want[it.kind].join('+'),
        want[it.kind].every((n) => names.includes(n)), names.join());
      check('dry paste ' + it.kind + ': under 1.5 s', Date.now() - t0 < 1500, Date.now() - t0);
    }
    const rich = R(await s.send('clip.paste', { item: items[1].id, hwnd: '0', dryRun: true }));
    check('dry paste html: carries HTML Format too', (rich.formats || []).some((f) => f.name === 'HTML Format'));
    check('dry paste with no window: would not type, says why',
      rich.wouldSend === null && rich.wouldFocus === false && /no window/.test(rich.wouldSay || ''), JSON.stringify({ s: rich.wouldSend, w: rich.wouldSay }));
    const real = await s.send('clip.paste', { item: items[0].id, hwnd: arm.hwnd });
    check('a REAL paste is refused by the passive sidecar', real.ok === false && String(real.error).startsWith(PASSIVE), real.error);
    const gone = await s.send('clip.paste', { item: 'c999999', dryRun: true });
    check('paste of an unknown id says so', gone.ok === false && /no longer/.test(gone.error), gone.error);

    // ---- pins: encrypted on disk, survive a restart, survive clear
    const pinned = await s.send('clip.pin', { item: items[0].id, pinned: true });
    check('pin ok', pinned.ok === true && R(pinned).pinned === 1, pinned.error);
    check('pins file written', fs.existsSync(pins));
    const raw = fs.existsSync(pins) ? fs.readFileSync(pins) : Buffer.alloc(0);
    check('pins file is not plaintext (UTF-8)', !raw.includes(Buffer.from(SECRET, 'utf8')));
    check('pins file is not plaintext (UTF-16)', !raw.includes(Buffer.from(SECRET, 'utf16le')));
    check('pins file is not plaintext (base64)', !raw.toString('latin1').includes(Buffer.from(SECRET).toString('base64').slice(0, 16)));
    check('pins file is a DPAPI blob (version 1 header)', raw.length > 16 && raw.readUInt32LE(0) === 1, raw.length ? raw.readUInt32LE(0) : 'empty');

    const cleared = R(await s.send('clip.clear'));
    check('clear removes the 3 unpinned, keeps the pin', cleared.removed === 3 && cleared.count === 1 && cleared.pinned === 1,
      JSON.stringify({ r: cleared.removed, c: cleared.count, p: cleared.pinned }));

    // a second sidecar with the same pins file reads the pin back
    const s2 = start(['--passive', '--parent-pid=' + process.pid]);
    try {
      await s2.send('clip.start', { listen: false, pinsFile: pins });
      const l2 = R(await s2.send('clip.list'));
      check('pin survives a restart', (l2.items || []).length === 1 && l2.items[0].pinned === true &&
        l2.items[0].text === 'hello ' + SECRET + '\nsecond line\nthird line\nfourth line', (l2.items || []).length);
      check('no pins error after a reload', !l2.pinsError, l2.pinsError);
    } finally { await s2.quit(); }

    // unpin, then delete
    const unp = R(await s.send('clip.pin', { item: items[0].id, pinned: false }));
    check('unpin ok', unp.pinned === 0);
    const del = R(await s.send('clip.delete', { item: items[0].id }));
    check('delete ok', del.count === 0);
    const del2 = await s.send('clip.delete', { item: items[0].id });
    check('delete of a gone item says so', del2.ok === false && /no longer/.test(del2.error));

    // ---- caps: 30 seeded -> 25 unpinned kept, oldest dropped
    const many = [];
    for (let i = 0; i < 30; i++) many.push({ kind: 'text', text: 'item ' + i, agoMs: i * 1000 });
    await s.send('clip.seed', { reset: true, items: many });
    list = R(await s.send('clip.list'));
    check('history keeps 25 items', (list.items || []).length === 25, (list.items || []).length);
    check('the NEWEST 25 are kept', list.items && list.items[0].text === 'item 0' && list.items[24].text === 'item 24');

    // ---- a too-large item cannot be pinned, and says why
    await s.send('clip.seed', { reset: true, items: [{ kind: 'text', text: 'x'.repeat(2200000) }] });
    list = R(await s.send('clip.list', {}, 20000));
    check('a 2.2M-char item lists with its text trimmed for the page',
      list.items && list.items[0].chars === 2200000 && list.items[0].text.length === 2000);
    const big = await s.send('clip.pin', { item: list.items[0].id, pinned: true });
    check('a 4.4 MB item cannot be pinned, with the reason', big.ok === false && /too large to pin/.test(big.error), big.error);

    // ---- pin cap
    const pinsMany = [];
    for (let i = 0; i < 25; i++) pinsMany.push({ kind: 'text', text: 'p' + i });
    await s.send('clip.seed', { reset: true, items: pinsMany });
    list = R(await s.send('clip.list'));
    let lastErr = null;
    for (const it of list.items) {
      const p = await s.send('clip.pin', { item: it.id, pinned: true });
      if (!p.ok) lastErr = p.error;
    }
    check('25 pins accepted', lastErr === null, lastErr);
    // pins do not count against the 25-item history, so a 26th item can arrive and be refused a pin
    await s.send('clip.seed', { items: [{ kind: 'text', text: 'p25' }] });
    list = R(await s.send('clip.list'));
    check('26 items with 25 pinned', list.count === 26, list.count);
    const p26 = await s.send('clip.pin', { item: list.items[0].id, pinned: true });
    lastErr = p26.ok ? null : p26.error;
    list = R(await s.send('clip.list'));
    check('at most 25 pins, the 26th refused with a reason', list.pinned === 25 && /25 items are pinned/.test(lastErr || ''), list.pinned + ' ' + lastErr);

    // ---- the listener in a passive sidecar is forced to observe (counts and formats only)
    const lst = R(await s.send('clip.start', { listen: true, pinsFile: pins }));
    check('passive listen is forced to observe mode', lst.mode === 'observe' && !lst.error, JSON.stringify({ m: lst.mode, e: lst.error }));
    const stopped = R(await s.send('clip.stop'));
    check('stop: mode off, unpinned dropped, pins kept', stopped.mode === 'off' && stopped.count === stopped.pinned, JSON.stringify({ c: stopped.count, p: stopped.pinned }));
    const evs = s.events.filter((e) => e.ev === 'clip');
    check('no clip event carries text', evs.every((e) => e.text === undefined && e.items === undefined));
  } catch (e) {
    check('harness', false, e.message);
  } finally {
    await s.quit();
  }
  try { await copyPath(tmp); } catch (e) { check('copy-path harness', false, e.message); }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { }
  console.log('clipboard sidecar: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}

// ---- the copy path (clip.capture), undo, plain paste and the pins file's recovery ------------
const T = (text) => ({ name: 'CF_UNICODETEXT', text });
const IMG = (name, w, h, color, extra) => ({ name, image: Object.assign({ w, h, color }, extra || {}) });
const FLAG = {
  exclude: { name: 'ExcludeClipboardContentFromMonitorProcessing' },
  viewer: { name: 'Clipboard Viewer Ignore' },
  include: (v) => ({ name: 'CanIncludeInClipboardHistory', dword: v }),
  upload: (v) => ({ name: 'CanUploadToCloudClipboard', dword: v }),
};

async function copyPath(tmp) {
  const pins = path.join(tmp, 'pins-copy.dat');
  const s = start(['--passive', '--parent-pid=' + process.pid]);
  const cap = async (formats, extra) => R(await s.send('clip.capture', Object.assign({ formats }, extra || {})));
  const items = async () => R(await s.send('clip.list')).items || [];
  try {
    await s.send('clip.start', { listen: false, pinsFile: pins });

    // ---- 1. THE PRIVACY RULE: a flagged copy never enters the history, whatever it holds
    const MARK = 'secret-fixture-4c1e';
    const privateCases = [
      ['ExcludeClipboardContentFromMonitorProcessing present', [T(MARK), FLAG.exclude], 'exclude'],
      ['Clipboard Viewer Ignore present', [T(MARK), FLAG.viewer], 'viewerIgnore'],
      ['CanIncludeInClipboardHistory = 0', [T(MARK), FLAG.include(0)], 'canInclude'],
      ['CanUploadToCloudClipboard = 0 (no CanInclude)', [T(MARK), FLAG.upload(0)], 'canUpload'],
      ['CanUploadToCloudClipboard = 0 even with CanInclude = 1', [T(MARK), FLAG.include(1), FLAG.upload(0)], 'canUpload'],
      ['CanInclude present but unreadable: fails closed', [T(MARK), { name: 'CanIncludeInClipboardHistory', nodata: true }], 'canInclude'],
      ['CanInclude shorter than a DWORD: fails closed', [T(MARK), { name: 'CanIncludeInClipboardHistory', b64: Buffer.from([1, 0]).toString('base64') }], 'canInclude'],
      ['CanUpload present but unreadable: fails closed', [T(MARK), { name: 'CanUploadToCloudClipboard', nodata: true }], 'canUpload'],
      ['a flagged PICTURE', [IMG('PNG', 40, 30, '#223344'), FLAG.exclude], 'exclude'],
      ['flagged FILES', [{ name: 'CF_HDROP', files: ['C:\\fixture\\secret.txt'] }, FLAG.include(0)], 'canInclude'],
    ];
    let before = R(await s.send('clip.status'));
    for (const [name, formats, rule] of privateCases) {
      const r = await cap(formats);
      check('private: ' + name + ' -> not kept (' + rule + ')', r.outcome === 'skipped:private:' + rule && r.count === before.count, r.outcome + ' count ' + r.count);
    }
    // in the passive test mode that only counts copies, too
    const ob = await cap([T(MARK), FLAG.exclude], { observe: true });
    check('private in observe mode: skipped, not even counted as observed', ob.outcome === 'skipped:private:exclude', ob.outcome);
    let st = R(await s.send('clip.status'));
    check('private skips counted', (st.stats.skipped.private || 0) === privateCases.length + 1, JSON.stringify(st.stats.skipped));
    check('a private skip records no format names', st.stats.recent[0].reason === 'private' && !st.stats.recent[0].formats, JSON.stringify(st.stats.recent[0]));
    check('no private text anywhere in the list', !JSON.stringify(R(await s.send('clip.list'))).includes(MARK));
    // controls: the flags saying YES keep the copy
    let r = await cap([T('kept-with-include-1'), FLAG.include(1)]);
    check('CanInclude = 1 alone: kept', r.outcome === 'added', r.outcome);
    r = await cap([T('kept-with-both-1'), FLAG.include(1), FLAG.upload(1)]);
    check('CanInclude = 1 and CanUpload = 1: kept', r.outcome === 'added', r.outcome);

    // ---- 2. every kind is recorded
    await s.send('clip.seed', { reset: true, items: [] }).catch(() => {});
    await s.send('clip.clear'); await s.send('clip.forget');
    r = await cap([T('plain words')]);
    let l = await items();
    check('text: recorded, not rich', r.outcome === 'added' && l[0].kind === 'text' && l[0].text === 'plain words' && l[0].rich === false, r.outcome);
    r = await cap([T('formatted words'), { name: 'HTML Format', html: '<b>formatted</b> words' }, { name: 'Rich Text Format', rtf: '{\\rtf1 formatted words}' }]);
    l = await items();
    check('rich text: recorded as rich', r.outcome === 'added' && l[0].rich === true, r.outcome);
    let d = R(await s.send('clip.paste', { item: l[0].id, hwnd: '0', dryRun: true }));
    let names = (d.formats || []).map((f) => f.name);
    check('rich text: a paste sets text + HTML + RTF, round trip', d.roundTrip === true && ['CF_UNICODETEXT', 'HTML Format', 'Rich Text Format'].every((n) => names.includes(n)), names.join());
    // (the new feature) plain text: the same item pasted as bare words
    d = R(await s.send('clip.paste', { item: l[0].id, hwnd: '0', dryRun: true, plain: true }));
    check('plain paste of rich text: only CF_UNICODETEXT, round trip', d.plain === true && d.roundTrip === true && (d.formats || []).map((f) => f.name).join() === 'CF_UNICODETEXT', JSON.stringify(d.formats));
    r = await cap([IMG('PNG', 90, 60, '#2A9D8F')]);
    l = await items();
    check('PNG picture: recorded with size + thumbnail', r.outcome === 'added' && l[0].kind === 'image' && l[0].w === 90 && l[0].h === 60 && /^data:image\/jpeg/.test(l[0].thumb || ''), r.outcome);
    d = R(await s.send('clip.paste', { item: l[0].id, hwnd: '0', dryRun: true, plain: true }));
    check('plain paste of a picture: pastes the picture (PNG + CF_DIB)', d.plain === false && d.roundTrip === true && (d.formats || []).map((f) => f.name).join() === 'PNG,CF_DIB', JSON.stringify(d.formats));
    r = await cap([IMG('CF_DIBV5', 33, 21, '#AA3355')]);
    l = await items();
    check('CF_DIBV5 picture: recorded', r.outcome === 'added' && l[0].kind === 'image' && l[0].w === 33 && l[0].h === 21, r.outcome);
    r = await cap([IMG('CF_DIB', 17, 45, '#335577')]);
    l = await items();
    check('CF_DIB picture: recorded', r.outcome === 'added' && l[0].kind === 'image' && l[0].w === 17 && l[0].h === 45, r.outcome);
    d = R(await s.send('clip.paste', { item: l[0].id, hwnd: '0', dryRun: true }));
    check('CF_DIB picture: pastes back pixel-exact', d.roundTrip === true, d.roundTripError);
    r = await cap([{ name: 'CF_HDROP', files: ['C:\\fixture\\a.txt', 'C:\\fixture\\folder'] }]);
    l = await items();
    check('files: recorded with names', r.outcome === 'added' && l[0].kind === 'files' && l[0].fileCount === 2 && l[0].files[0].name === 'a.txt', r.outcome);
    d = R(await s.send('clip.paste', { item: l[0].id, hwnd: '0', dryRun: true, plain: true }));
    check('plain paste of files: the paths as text', d.plain === true && d.roundTrip === true && (d.formats || []).map((f) => f.name).join() === 'CF_UNICODETEXT', JSON.stringify(d.formats));
    r = await cap([IMG('PNG', 50, 40, '#101010'), { name: 'CF_HDROP', files: ['C:\\fixture\\shot.png'] }]);
    l = await items();
    check('picture + its file (screenshot tool): one picture item carrying the file', r.outcome === 'added' && l[0].kind === 'image' && l[0].fileCount === 1, r.outcome);
    r = await cap([T('   \r\n  ')]);
    check('only whitespace: skipped as empty', r.outcome === 'skipped:empty', r.outcome);
    r = await cap([{ name: 'Some App Private Format' }]);
    check('a format Mantle cannot keep: skipped as unsupported', r.outcome === 'skipped:unsupported', r.outcome);
    r = await cap([T('held')], { busy: true });
    check('clipboard held by another app: skipped as busy', r.outcome === 'skipped:busy', r.outcome);
    r = await cap([T('observed only')], { observe: true });
    const cnt = (await items()).length;
    check('observe mode: counted, not kept', r.outcome === 'observed' && !(await items()).some((i) => i.text === 'observed only'), r.outcome + ' ' + cnt);

    // ---- 3. dedupe: the same copy again is ONE item, on top, with the newest formats
    const n0 = (await items()).length;
    const id0 = (await items()).find((i) => i.text === 'plain words').id;
    r = await cap([T('plain words')]);
    l = await items();
    check('same text again: moved to the top, not doubled', r.outcome === 'moved' && l.length === n0 && l[0].id === id0, r.outcome + ' ' + l.length);
    r = await cap([T('plain words'), { name: 'HTML Format', html: '<i>plain words</i>' }]);
    l = await items();
    check('same words from a web page (text + HTML): still one item, now rich', r.outcome === 'moved' && l.length === n0 && l[0].id === id0 && l[0].rich === true, r.outcome + ' rich ' + l[0].rich);
    r = await cap([IMG('PNG', 90, 60, '#2A9D8F')]);
    l = await items();
    check('same picture again: moved, not doubled', r.outcome === 'moved' && l.length === n0 && l[0].kind === 'image' && l[0].w === 90, r.outcome);
    r = await cap([IMG('PNG', 90, 60, '#2A9D8F'), { name: 'CF_HDROP', files: ['C:\\fixture\\saved.png'] }]);
    l = await items();
    check('same picture plus its saved file: the item gains the file', r.outcome === 'moved' && l.length === n0 && l[0].fileCount === 1, r.outcome);
    r = await cap([{ name: 'CF_HDROP', files: ['C:\\FIXTURE\\A.TXT', 'C:\\fixture\\folder'] }]);
    l = await items();
    check('same files again (any letter case): moved', r.outcome === 'moved' && l.length === n0 && l[0].kind === 'files', r.outcome);

    // ---- 4. sizes and caps
    r = await cap([{ name: 'CF_UNICODETEXT', text: 'abcd', repeat: 530000 }]);   // 2.12M chars = 4.24 MB > 4 MB
    st = R(await s.send('clip.status'));
    check('huge text (> 4 MB): skipped as too large, with the reason', r.outcome === 'skipped:tooLarge' && st.stats.recent[0].reason === 'tooLarge', r.outcome);
    r = await cap([{ name: 'CF_UNICODETEXT', text: 'abcd', repeat: 500000 }]);   // 4.0 MB: under the cap
    check('large text under 4 MB: kept', r.outcome === 'added', r.outcome);
    const lim = R(await s.send('clip.limits', { maxImageSourceBytes: 4000 }));
    check('limits take (test only)', lim.maxImageSourceBytes === 4000, JSON.stringify(lim));
    r = await cap([IMG('PNG', 80, 80, '#000000', { noise: true })]);
    check('huge picture (source over the limit): skipped as too large', r.outcome === 'skipped:tooLarge', r.outcome);
    await s.send('clip.limits', { maxItemBytes: 3000 });
    r = await cap([IMG('CF_DIB', 80, 80, '#000000', { noise: true, seed: 3 })]);
    check('picture whose PNG passes 2x the item limit: skipped as too large', r.outcome === 'skipped:tooLarge', r.outcome);
    await s.send('clip.limits', {});
    await s.send('clip.clear'); await s.send('clip.forget');
    await s.send('clip.limits', { maxItems: 5 });
    for (let i = 0; i < 8; i++) await cap([T('cap item ' + i)]);
    l = await items();
    check('item cap: only the newest 5 unpinned kept', l.filter((i) => !i.pinned).length === 5 && l[0].text === 'cap item 7' && !l.some((i) => i.text === 'cap item 2'), l.map((i) => i.text).join('|'));
    await s.send('clip.limits', {});
    await s.send('clip.clear'); await s.send('clip.forget');
    await s.send('clip.limits', { memoryBudget: 1000 });
    for (let i = 0; i < 5; i++) await cap([T(String(i).repeat(200))]);   // 400 bytes each
    l = (await items()).filter((i) => !i.pinned);
    check('memory budget: the oldest go once 1000 bytes would be passed', l.length === 2 && l[0].text[0] === '4' && l[1].text[0] === '3', l.map((i) => i.text[0]).join());
    await s.send('clip.limits', {});

    // ---- 5. undo: Delete and Clear all come back exactly
    await s.send('clip.clear'); await s.send('clip.forget');
    for (const t of ['u-old', 'u-mid', 'u-new']) await cap([T(t)]);
    l = await items();
    const order = l.map((i) => i.id).join();
    const mid = l.find((i) => i.text === 'u-mid');
    let del = R(await s.send('clip.delete', { item: mid.id, undo: true }));
    check('delete: one gone, one to undo', del.undo === 1 && !(await items()).some((i) => i.id === mid.id), JSON.stringify({ u: del.undo }));
    let res = await s.send('clip.restore');
    check('undo delete: back in the same place', res.ok && R(res).restored === 1 && (await items()).map((i) => i.id).join() === order, res.error || (await items()).map((i) => i.id).join());
    res = await s.send('clip.restore');
    check('undo twice: says there is nothing to undo', res.ok === false && /nothing to undo/.test(res.error), res.error);
    await s.send('clip.pin', { item: mid.id, pinned: true });
    const cl = R(await s.send('clip.clear', { undo: true }));
    check('clear all: pinned kept, the rest undoable', cl.removed === 2 && cl.count === 1 && cl.undo === 2, JSON.stringify({ r: cl.removed, c: cl.count, u: cl.undo }));
    res = await s.send('clip.restore');
    check('undo clear all: every item back in order', res.ok && R(res).restored === 2 && (await items()).map((i) => i.id).join() === order, (await items()).map((i) => i.id).join());
    await s.send('clip.delete', { item: mid.id, undo: true });   // a PINNED item deleted...
    const s2 = start(['--passive', '--parent-pid=' + process.pid]);
    try {
      await s2.send('clip.start', { listen: false, pinsFile: pins });
      check('deleting a pinned item removes it from the pins file', R(await s2.send('clip.list')).pinned === 0);
    } finally { await s2.quit(); }
    res = await s.send('clip.restore');                                 // ...and undone
    const s3 = start(['--passive', '--parent-pid=' + process.pid]);
    try {
      await s3.send('clip.start', { listen: false, pinsFile: pins });
      const l3 = R(await s3.send('clip.list'));
      check('undoing it saves the pin again', res.ok && l3.pinned === 1 && l3.items[0].text === 'u-mid', res.error || l3.pinned);
    } finally { await s3.quit(); }
    await s.send('clip.delete', { item: (await items()).find((i) => i.text === 'u-new').id, undo: true });
    await cap([T('u-new')]);                                             // copied again meanwhile
    res = await s.send('clip.restore');
    check('undo does not double an item copied again meanwhile', res.ok && R(res).restored === 0 && (await items()).filter((i) => i.text === 'u-new').length === 1, res.error || R(res).restored);
    await s.send('clip.delete', { item: (await items())[0].id, undo: true });
    const fg = R(await s.send('clip.forget'));
    res = await s.send('clip.restore');
    check('forget (the panel closed): nothing left to undo', fg.forgot === 1 && res.ok === false, JSON.stringify(fg));

    const plainDel = R(await s.send('clip.delete', { item: (await items()).find((i) => !i.pinned).id }));
    check('a delete without undo keeps nothing in memory', plainDel.undo === 0, plainDel.undo);

    // ---- 6. the pins file: a save that died half-way, and a file that cannot be opened
    fs.renameSync(pins, pins + '.tmp');                                  // as if the rename never happened
    const s4 = start(['--passive', '--parent-pid=' + process.pid]);
    try {
      await s4.send('clip.start', { listen: false, pinsFile: pins });
      const l4 = R(await s4.send('clip.list'));
      check('a pins save cut off before its rename is recovered', l4.pinned === 1 && fs.existsSync(pins), l4.pinned);
    } finally { await s4.quit(); }
    const junk = Buffer.from('not a DPAPI blob at all, a damaged file');
    fs.writeFileSync(pins, junk);
    const s5 = start(['--passive', '--parent-pid=' + process.pid]);
    try {
      const st5 = R(await s5.send('clip.start', { listen: false, pinsFile: pins }));
      check('an unreadable pins file: said in plain words', /could not be opened/.test(st5.pinsError || '') && !/Exception|error \d/.test(st5.pinsError), st5.pinsError);
      await s5.send('clip.seed', { items: [{ kind: 'text', text: 'new pin' }] });
      const it5 = R(await s5.send('clip.list')).items[0];
      await s5.send('clip.pin', { item: it5.id, pinned: true });
      check('pinning after that sets the damaged file aside, never overwrites it',
        fs.existsSync(pins + '.unreadable') && fs.readFileSync(pins + '.unreadable').equals(junk), fs.existsSync(pins + '.unreadable'));
      check('...and the new pins file is good', R(await s5.send('clip.status')).pinsError === null);
    } finally { await s5.quit(); }

    // ---- 7. test-only commands say what they are in any sidecar; nothing leaks in events
    const evs = s.events.filter((e) => e.ev === 'clip');
    check('no clip event carries content', evs.length > 0 && evs.every((e) => e.text === undefined && e.items === undefined && !JSON.stringify(e).includes(MARK)), evs.length);
  } finally {
    await s.quit();
  }
}

main();

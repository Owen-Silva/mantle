// test-clipboard.js - the clipboard-history feature's sidecar half (ClipHistory.cs), against a
// PASSIVE sidecar. Plain node, no deps.
//
//   MANTLE_SIDECAR_EXE=<exe> node sidecar/test-clipboard.js
//
// OWEN'S CLIPBOARD IS NEVER WRITTEN AND NEVER READ FOR CONTENT: every item here is seeded
// (clip.seed, a passive-only command), every paste is a DRY RUN (the formats are built and decoded
// back, nothing is set, focused or typed), and the one live-listener check runs in the passive
// "observe" mode, which keeps counts and format names only. Nothing Owen copied can reach this
// output: the only strings printed are this file's own fixtures.
//
// Prints exactly one summary line and exits non-zero if anything failed.
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const EXE = process.env.MANTLE_SIDECAR_EXE ||
  path.join(os.tmpdir(), 'mantle-clipboard', 'Mantle.Sidecar.exe');
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mantle-clip-test-'));
  const pins = path.join(tmp, 'pins.dat');
  const s = start(['--passive', '--parent-pid=' + process.pid]);
  try {
    const ping = await s.send('ping');
    const cmds = (((ping.result || {}).features) || {}).commands || [];
    for (const c of ['clip.start', 'clip.stop', 'clip.status', 'clip.list', 'clip.arm', 'clip.pin',
                     'clip.delete', 'clip.clear', 'clip.seed', 'clip.paste']) {
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
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { }
  }
  console.log('clipboard sidecar: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
}

main();

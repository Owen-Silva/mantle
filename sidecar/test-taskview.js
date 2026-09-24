// test-taskview.js - Task View's sidecar half (Desktops.cs), against Owen's real desktop, READ-ONLY.
//
//   MANTLE_SIDECAR_EXE=<exe> node sidecar/test-taskview.js
//
// What it may do (lane brief, 2026-09-24): enumerate windows and virtual desktops. What it must never
// do: switch, create, remove or rename a desktop, move a window between desktops, or activate a
// window. So every write is sent twice: once for real, which the passive sidecar must REFUSE, and
// once with {dry:true}, which resolves everything and answers with the plan without the call. The
// desktops are read before and after, and must be byte-for-byte the same.
//
// Privacy: window titles never reach the output (counts, ids and timings only).
'use strict';
const { execFileSync } = require('child_process');
const T = require('./test-lib');

const KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\VirtualDesktops';

function regGuids(name) {
  try {
    const out = execFileSync('reg', ['query', KEY, '/v', name], { encoding: 'utf8' });
    const m = out.match(new RegExp(name + '\\s+REG_BINARY\\s+([0-9A-Fa-f]+)'));
    if (!m) return null;
    const hex = m[1];
    const ids = [];
    for (let i = 0; i + 32 <= hex.length; i += 32) {
      const b = Buffer.from(hex.slice(i, i + 32), 'hex');
      const d1 = b.readUInt32LE(0).toString(16).padStart(8, '0');
      const d2 = b.readUInt16LE(4).toString(16).padStart(4, '0');
      const d3 = b.readUInt16LE(6).toString(16).padStart(4, '0');
      const rest = b.slice(8).toString('hex');
      ids.push(`${d1}-${d2}-${d3}-${rest.slice(0, 4)}-${rest.slice(4)}`.toUpperCase());
    }
    return ids;
  } catch (_) { return null; }
}

function build() {
  try {
    const out = execFileSync('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion', '/v', 'CurrentBuild'], { encoding: 'utf8' });
    const m = out.match(/CurrentBuild\s+REG_SZ\s+(\d+)/);
    return m ? Number(m[1]) : 0;
  } catch (_) { return 0; }
}

(async () => {
  const t = T.checker('TASKVIEW');
  const s = await T.startPassive();
  const notes = [];
  try {
    const ping = await s.send('ping', {}, 8000);
    const cmds = ['taskview.list', 'taskview.activate', 'desktops.list', 'desktops.switch', 'desktops.create',
                  'desktops.remove', 'desktops.rename', 'desktops.move'];
    const pj = JSON.stringify(ping);
    t.check('ping lists every taskview/desktops command', cmds.every((c) => pj.includes(`"${c}"`)),
      cmds.filter((c) => !pj.includes(`"${c}"`)).join(', '));
    t.check('no feature registration problems mention Desktops', !/Desktops[^"]*did not register/.test(pj));

    // ---- the list: cold, then warm -----------------------------------------------------------
    let at = Date.now();
    const cold = await s.send('taskview.list', {}, 4000);
    const coldMs = Date.now() - at;
    t.check('taskview.list answers', cold.ok === true, JSON.stringify(cold).slice(0, 300));
    at = Date.now();
    const r = await s.send('taskview.list', {}, 4000);
    const warmMs = Date.now() - at;
    t.check('taskview.list answers warm', r.ok === true, r.error);
    const res = r.result || {};
    const list = Array.isArray(res.list) ? res.list : [];
    const desks = res.desktops || {};
    notes.push(`list: ${list.length} window(s), ${(res.others || []).length} on other desktops; round trip cold ${coldMs} ms, warm ${warmMs} ms; sidecar windows ${res.ms && res.ms.windows} ms, desktops ${res.ms && res.ms.desktops} ms`);
    t.check('warm round trip under 60 ms (the 150 ms open budget)', warmMs < 60, `${warmMs} ms`);
    t.check('every item has hwnd, title, desktop keys',
      list.every((it) => typeof it.hwnd === 'string' && typeof it.title === 'string' && 'desktop' in it));
    t.check('monitor fields ride along (for placing the overlay)', Array.isArray(res.mon) && res.mon.length === 4);

    // Same list and order as Alt+Tab. Two reads back to back; a window may appear between them,
    // so one retry.
    let same = false;
    for (let i = 0; i < 2 && !same; i++) {
      const a = await s.send('hotkey', { op: 'list' }, 4000);
      const b = await s.send('taskview.list', {}, 4000);
      const ha = ((a.result && a.result.list) || []).map((x) => x.hwnd).join(',');
      const hb = ((b.result && b.result.list) || []).map((x) => x.hwnd).join(',');
      same = a.ok && b.ok && ha === hb;
    }
    t.check('the window list is exactly Alt+Tab\'s (hotkey op:list), same order', same);

    // ---- desktops against the registry --------------------------------------------------------
    const b = build();
    const regIds = regGuids('VirtualDesktopIDs');
    const regCur = (regGuids('CurrentVirtualDesktop') || [])[0] || null;
    notes.push(`build ${b}; registry: ${regIds ? regIds.length : 'unreadable'} desktop(s); sidecar source ${desks.source}, canWrite ${desks.canWrite}`);
    t.check('desktops.ok', desks.ok === true, desks.reason);
    if (b === 26200) {
      t.check('on the pinned build the internal interface passed its self-check (source com)', desks.source === 'com', desks.reason);
      t.check('...and writes are available', desks.canWrite === true, desks.writeReason);
    } else {
      t.check('off the pinned build: registry fallback, writes off WITH a reason',
        desks.source !== 'com' && desks.canWrite === false && /build/.test(String(desks.writeReason)), desks.writeReason);
    }
    const ids = (desks.list || []).map((d) => d.id);
    if (regIds) t.check('desktop ids match the registry, in order', ids.join(',') === regIds.join(','), `${ids.length} vs ${regIds.length}`);
    if (regCur) t.check('current desktop matches the registry', desks.current === regCur);
    t.check('every desktop has a name ("Desktop N" when unnamed)', (desks.list || []).every((d) => typeof d.name === 'string' && d.name.length > 0));
    const tagged = list.filter((it) => it.desktop);
    t.check('the Alt+Tab windows Windows can place are all on the current desktop',
      tagged.every((it) => it.desktop === desks.current), `${tagged.length} tagged`);
    notes.push(`${tagged.length}/${list.length} list windows have a desktop id (the rest are not app views)`);
    t.check('"others" are only on other, known desktops',
      (res.others || []).every((o) => o.desktop !== desks.current && ids.includes(o.desktop)));

    const dl = await s.send('desktops.list', {}, 4000);
    t.check('desktops.list agrees with taskview.list', dl.ok && JSON.stringify(dl.result.list) === JSON.stringify(desks.list));

    // ---- every write REFUSES in passive -------------------------------------------------------
    const first = list[0];
    const cur = desks.current;
    const writes = [
      ['desktops.switch', { desktop: cur }],
      ['desktops.create', {}],
      ['desktops.remove', { desktop: cur }],
      ['desktops.rename', { desktop: cur, name: 'x' }],
      ['desktops.move', { desktop: cur, hwnd: first ? first.hwnd : '1' }],
      ['taskview.activate', { hwnd: first ? first.hwnd : '1' }],
    ];
    for (const [cmd, args] of writes) {
      const w = await s.send(cmd, args, 4000);
      t.check(`${cmd} (real) refuses in passive`, w.ok === false && String(w.error).startsWith(T.PASSIVE_REFUSAL), w.error);
    }

    // ---- dry runs: the plan, never the call -----------------------------------------------------
    const sw = await s.send('desktops.switch', { desktop: cur, dry: true }, 4000);
    t.check('dry switch to the current desktop: already there', sw.ok && sw.result.already === true, JSON.stringify(sw));
    const cr = await s.send('desktops.create', { dry: true }, 4000);
    t.check('dry create: the plan', cr.ok && cr.result.would === 'create' && cr.result.count === ids.length, JSON.stringify(cr));
    const rm = await s.send('desktops.remove', { desktop: cur, dry: true }, 4000);
    if (ids.length < 2) t.check('dry remove of the only desktop: refused with the reason', !rm.ok && /keeps one desktop/.test(rm.error), rm.error);
    else t.check('dry remove: the plan names where its windows go', rm.ok && rm.result.would === 'remove' && ids.includes(rm.result.windowsGoTo), JSON.stringify(rm));
    const rn = await s.send('desktops.rename', { desktop: cur, name: 'Mantle dry run', dry: true }, 4000);
    t.check('dry rename: the plan', rn.ok && rn.result.would === 'rename', JSON.stringify(rn));
    const movable = tagged[0];
    if (movable) {
      const mv = await s.send('desktops.move', { desktop: cur, hwnd: movable.hwnd, dry: true }, 4000);
      t.check('dry move of an app window to its own desktop: resolved, already there', mv.ok && mv.result.already === true, JSON.stringify(mv));
    } else notes.push('no app-view window open: dry move not exercised');
    if (first) {
      const ac = await s.send('taskview.activate', { hwnd: first.hwnd, dry: true }, 4000);
      t.check('dry activate: the plan (focus target, restore, hung)', ac.ok && ac.result.would === 'activate' && typeof ac.result.focusTo === 'string', JSON.stringify(ac));
    }

    // ---- bad input answers in words ------------------------------------------------------------
    const noId = await s.send('desktops.switch', { dry: true }, 4000);
    t.check('switch without an id: plain words', !noId.ok && /needs the desktop's id/.test(noId.error), noId.error);
    const ghost = await s.send('desktops.switch', { desktop: '00000000-0000-0000-0000-00000000BEEF', dry: true }, 4000);
    t.check('switch to a desktop that does not exist: plain words', !ghost.ok && /no longer exists/.test(ghost.error), ghost.error);
    const gone = await s.send('desktops.move', { desktop: cur, hwnd: '0', dry: true }, 4000);
    t.check('move with no window: plain words', !gone.ok && /closed/.test(gone.error), gone.error);
    const badName = await s.send('desktops.rename', { desktop: cur, name: 'x'.repeat(101), dry: true }, 4000);
    t.check('a 101-character name is refused', !badName.ok && /100 characters/.test(badName.error), badName.error);

    // ---- nothing changed ------------------------------------------------------------------------
    const after = await s.send('desktops.list', {}, 4000);
    t.check('desktops are exactly as before (dry runs wrote nothing)',
      after.ok && JSON.stringify(after.result.list) === JSON.stringify(desks.list) && after.result.current === cur);
    if (regIds) t.check('the registry\'s desktop list is unchanged', (regGuids('VirtualDesktopIDs') || []).join(',') === regIds.join(','));
  } catch (err) {
    t.check('no exception', false, err.stack);
  } finally {
    await s.stop();
  }
  for (const n of notes) console.log('  note: ' + n);
  process.exit(t.summary());
})();

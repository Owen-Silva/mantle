// test-media.js - sidecar/Media.cs (`media` get / control / watch) against a PASSIVE sidecar
// (lane media-sc, 2026-09-29).
//   node sidecar/test-media.js --exe=<exe>        (or MANTLE_SIDECAR_EXE=<exe>)
// What it proves: every argument is type-checked; control is REFUSED in passive and dryRun sends
// nothing; real reads of the user's current media sessions have the right shape (only counts and types
// are printed, never titles or app names); the art encoder (JPEG for opaque, PNG for alpha, 192 px
// default, size clamps, damaged/huge images refused in plain words); the watch debounce, emit and
// silence after off; a request behind a busy media thread answers in time and work its caller gave
// up on is dropped, not run late; idle CPU with the watch on; no session names in any log line.
// NEVER sends play/pause/next/seek to a real player: the only control requests here are dryRun or
// refused by passive before they reach Windows.
'use strict';
const { spawnSync } = require('child_process');
const T = require('./test-lib');

const DATA_URL = /^data:image\/(jpeg|png);base64,[A-Za-z0-9+/=]+$/;
const TYPE_WORDS = /HRESULT|0x[0-9A-F]{8}|Out of memory|Parameter is not valid|undefined|NaN|\[object/;

function cpuMs(pid) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', `[int](Get-Process -Id ${pid}).TotalProcessorTime.TotalMilliseconds`],
    { encoding: 'utf8', windowsHide: true });
  return Number((r.stdout || '').trim());
}

(async () => {
  const t = T.checker('MEDIA');
  const s = await T.startPassive();
  const bad = async (label, extra, re) => {
    const r = await s.send('media', extra, 6000);
    t.check(`reject: ${label}`, r.ok === false && re.test(r.error || ''), JSON.stringify(r).slice(0, 200));
  };
  try {
    // ---- 1. argument validation (nothing reaches Windows)
    await bad('unknown op', { op: 'dance' }, /unknown op 'dance'/);
    await bad('op not a string', { op: 5 }, /op must be a string/);
    await bad('control without action', { op: 'control' }, /control needs action/);
    await bad('control with unknown action', { op: 'control', action: 'explode' }, /control needs action.*got 'explode'/);
    await bad('action not a string', { op: 'control', action: ['play'] }, /action must be a string/);
    await bad('seek without positionMs', { op: 'control', action: 'seek', dryRun: true }, /seek needs positionMs/);
    await bad('seek negative', { op: 'control', action: 'seek', positionMs: -1, dryRun: true }, /seek needs positionMs/);
    await bad('seek as a string', { op: 'control', action: 'seek', positionMs: '5000', dryRun: true }, /seek needs positionMs/);
    await bad('seek over 7 days', { op: 'control', action: 'seek', positionMs: 86400000 * 8, dryRun: true }, /seek needs positionMs/);
    await bad('art not a boolean', { op: 'get', art: 'yes' }, /art must be true or false/);
    await bad('artSize not a number', { op: 'get', artSize: 'big' }, /artSize must be a number/);
    await bad('aumid a number', { op: 'get', aumid: 123 }, /aumid must be a string/);
    await bad('aumid an object', { op: 'control', action: 'play', aumid: { a: 1 }, dryRun: true }, /aumid must be a string/);
    await bad('dryRun not a boolean', { op: 'control', action: 'play', dryRun: 'yes' }, /dryRun must be true or false/);
    await bad('watch without on', { op: 'watch' }, /watch needs on:true or on:false/);
    await bad('watch on:"false" (a string used to mean ON)', { op: 'watch', on: 'false' }, /a boolean/);
    const long = await s.send('media', { op: 'x'.repeat(5000) }, 6000);
    t.check('reject: a huge op is echoed cut short', long.ok === false && long.error.length < 200, String((long.error || '').length));

    // ---- 2. control is a WRITE: refused in passive unless dryRun
    for (const action of ['play', 'pause', 'toggle', 'next', 'previous', 'stop']) {
      const r = await s.send('media', { op: 'control', action }, 6000);
      t.check(`passive refuses a real ${action}`, r.ok === false && (r.error || '').startsWith(T.PASSIVE_REFUSAL), JSON.stringify(r).slice(0, 160));
    }
    const rs = await s.send('media', { op: 'control', action: 'seek', positionMs: 1000 }, 6000);
    t.check('passive refuses a real seek', rs.ok === false && (rs.error || '').startsWith(T.PASSIVE_REFUSAL), JSON.stringify(rs).slice(0, 160));

    // ---- 3. REAL reads of the user's sessions (shapes and counts only)
    let t0 = Date.now();
    const g = await s.call('media', { op: 'get' }, 8000);
    const getMs = Date.now() - t0;
    const sessions = g.sessions || [];
    t.check('get: ok, count matches the list', g.ok === true && typeof g.count === 'number' && sessions.length === g.count, `ok ${g.ok} count ${g.count} list ${sessions.length}`);
    t.check('get: answers inside the 3.5 s request budget', getMs < 3600, `${getMs} ms`);
    t.check('get: events are live', g.events === true, String(g.eventsReason));
    t.check('get: every session has the fields the card reads', sessions.every((x) => typeof x.aumid === 'string' && x.app && typeof x.app.name === 'string' &&
      typeof x.status === 'string' && typeof x.playing === 'boolean' && typeof x.current === 'boolean' && x.timeline && typeof x.timeline.available === 'boolean'),
      JSON.stringify(sessions.map((x) => Object.keys(x).length)));
    t.check('get: no session has an artwork (only the current one does)', sessions.every((x) => !('artwork' in x)), '');
    const cur = g.current;
    const art1 = cur ? cur.artwork : undefined;
    if (cur) {
      t.check('get: current has buttons and a status', cur.can && typeof cur.can.play === 'boolean' && typeof cur.status === 'string', JSON.stringify(cur.can));
      t.check('get: current art is a jpeg/png data URL, or a plain reason', (typeof art1 === 'string' && DATA_URL.test(art1)) ||
        (art1 === null && typeof cur.artworkReason === 'string' && !TYPE_WORDS.test(cur.artworkReason)), art1 ? art1.slice(0, 30) : 'reason given');
      if (typeof art1 === 'string') {
        const g2 = await s.call('media', { op: 'get' }, 8000);
        const same = g2.current && g2.current.artKey === cur.artKey;
        t.check('get: the art is cached per track (same track -> the same data URL)', !same || g2.current.artwork === art1, same ? 'same track' : 'track changed between reads');
      }
      const ga = await s.call('media', { op: 'get', art: false }, 8000);
      t.check('get art:false: no artwork read', !ga.current || !('artwork' in ga.current), '');
    }
    console.log(`  (real read: ${g.count} session(s), current ${cur ? 'yes' : 'no'}, art ${typeof art1 === 'string' ? art1.slice(5, 15) + ' ' + art1.length + ' B' : 'none'}, ${getMs} ms)`);
    const gn = await s.call('media', { op: 'get', aumid: 'Mantle.Test.NoSuchApp!App' }, 8000);
    t.check('get: an aumid that is not open -> session null + plain reason', gn.session === null && /no media session from/.test(gn.sessionReason || ''), String(gn.sessionReason).slice(0, 80));

    // ---- 4. dryRun control: resolves the target, sends nothing
    const before = cur ? cur.status : null;
    for (const action of ['toggle', 'play', 'pause', 'next', 'previous', 'stop']) {
      const r = await s.call('media', { op: 'control', action, dryRun: true }, 8000);
      if (g.count === 0 || !cur) {
        t.check(`dryRun ${action} with nothing open: plain reason`, r.ok === false && /nothing to control/.test(r.reason || ''), String(r.reason).slice(0, 80));
      } else {
        t.check(`dryRun ${action}: says what it would send, sends nothing`, (r.ok === true && r.dryRun === true && r.sent === false && typeof r.via === 'string') ||
          (r.ok === false && r.dryRun === true && /does not accept/.test(r.reason || '')), JSON.stringify({ ok: r.ok, dryRun: r.dryRun, sent: r.sent, via: r.via }));
      }
    }
    if (cur) {
      const r = await s.call('media', { op: 'control', action: 'seek', positionMs: 1234.4, dryRun: true }, 8000);
      t.check('dryRun seek echoes the rounded position', (r.ok === true && r.positionMs === 1234) || (r.ok === false && /does not accept/.test(r.reason || '')), JSON.stringify({ ok: r.ok, positionMs: r.positionMs }));
      await T.sleep(400);
      const after = await s.call('media', { op: 'get', art: false }, 8000);
      t.check('dryRun changed nothing: the player status is the same', !after.current || after.current.status === before || before === 'changing', `${before} -> ${after.current && after.current.status}`);
    }
    const dn = await s.call('media', { op: 'control', action: 'pause', aumid: 'Mantle.Test.NoSuchApp!App', dryRun: true }, 8000);
    t.check('dryRun to an app that is not open: refused, never swapped for the current one', dn.ok === false && /nothing to control: no media session from/.test(dn.reason || ''), String(dn.reason).slice(0, 80));

    // ---- 5. art encoder (images made inside the sidecar; no real art)
    const art = (extra) => s.call('media', Object.assign({ op: 'arttest' }, extra), 15000);
    const ph = await art({ kind: 'photo', w: 600, h: 600 });
    t.check('art: an opaque photo -> JPEG data URL at the 192 px default', ph.ok && ph.type === 'jpeg' && ph.w === 192 && ph.h === 192 && ph.prefix.startsWith('data:image/jpeg;base64,'), JSON.stringify(ph));
    const phOld = await art({ kind: 'photo', w: 600, h: 600, artSize: 96, force: 'png' });
    t.check('art: the JPEG at 192 px is smaller than the old PNG at 96 px', ph.urlBytes < phOld.urlBytes, `${ph.urlBytes} vs ${phOld.urlBytes}`);
    const op = await art({ kind: 'png', w: 600, h: 600 });
    t.check('art: an opaque PNG source is also sent as JPEG', op.ok && op.type === 'jpeg', op.type);
    const al = await art({ kind: 'alpha', w: 600, h: 600 });
    t.check('art: transparent art stays PNG', al.ok && al.type === 'png' && al.prefix.startsWith('data:image/png;base64,'), al.type);
    const wide = await art({ kind: 'photo', w: 1000, h: 200 });
    t.check('art: aspect kept (1000x200 -> 192x38)', wide.w === 192 && wide.h === 38, `${wide.w}x${wide.h}`);
    const small = await art({ kind: 'photo', w: 100, h: 100 });
    t.check('art: never upscaled (100 px source stays 100 px)', small.w === 100 && small.h === 100, `${small.w}x${small.h}`);
    for (const [label, size, want] of [['artSize 5 -> 16', 5, 16], ['artSize 9999 -> 256', 9999, 256], ['artSize 1e20 -> 256 (was 16)', 1e20, 256], ['artSize 100.4 -> 100', 100.4, 100], ['artSize -50 -> 16', -50, 16]]) {
      const r = await art({ kind: 'photo', w: 600, h: 600, artSize: size });
      t.check(`art: ${label}`, r.w === want, String(r.w));
    }
    // GDI+ draws a truncated JPEG with the missing rows grey, so that one may pass as art.
    const tr = await art({ kind: 'truncated', w: 600, h: 600 });
    t.check('art: truncated image -> partial art or a plain refusal, never an error', (tr.ok === true && tr.type === 'jpeg') || (tr.ok === false && !TYPE_WORDS.test(tr.reason || '')), String(tr.reason || tr.type));
    for (const kind of ['corrupt', 'empty']) {
      const r = await art({ kind, w: 600, h: 600 });
      t.check(`art: ${kind} image -> refused in plain words`, r.ok === false && r.type === null && r.urlBytes === 0 && typeof r.reason === 'string' && !TYPE_WORDS.test(r.reason), String(r.reason));
    }
    t0 = Date.now();
    const huge = await art({ kind: 'huge' });
    const hugeMs = Date.now() - t0;
    t.check('art: a 30000x30000 header is refused before decoding (fast, no GBs)', huge.ok === false && /too large to decode|not an image Mantle can read/.test(huge.reason || '') && hugeMs < 1000, `${hugeMs} ms: ${huge.reason}`);
    const big = await art({ kind: 'photo', w: 3000, h: 3000 });
    t.check('art: a 3000x3000 photo decodes well inside one call budget (2 s)', big.ok && big.ms < 2000, `${big.ms} ms`);
    await bad('arttest unknown kind', { op: 'arttest', kind: 'gif' }, /kind must be/);

    // ---- 6. watch: on, debounce, emit, off, silence
    const w = await s.call('media', { op: 'watch', on: true }, 8000);
    t.check('watch on: ok with live events', w.ok === true && w.watching === true && w.events === true, JSON.stringify(w).slice(0, 160));
    await T.sleep(1500);   // let any real change settle
    const n0 = s.collect('media').length;
    const c1 = await s.call('media', { op: 'changetest', reason: 'playback', n: 20 }, 4000);
    // the playback one: a real player's own timeline event can land in between (r6-art: seen with Spotify playing)
    const ev = await s.waitEvent('media', 3000, (e) => s.collect('media').indexOf(e) >= n0 && (e.reasons || []).includes('playback'));
    t.check('watch: a burst of 20 changes arrives as a media event', c1.ok && ev && typeof ev.rev === 'number' && Array.isArray(ev.reasons) && ev.reasons.includes('playback'), JSON.stringify({ reasons: ev && ev.reasons }));
    t.check('watch: the event carries count/present but no artwork', typeof ev.count === 'number' && typeof ev.present === 'boolean' && !(ev.current && 'artwork' in ev.current), '');
    await T.sleep(600);
    const burst = s.collect('media').slice(n0).filter((e) => (e.reasons || []).includes('playback')).length;
    t.check('watch: debounced to ONE event for the burst', burst === 1, String(burst));
    const off = await s.call('media', { op: 'watch', on: false }, 8000);
    t.check('watch off: ok', off.ok === true && off.watching === false, JSON.stringify(off).slice(0, 120));
    const n1 = s.collect('media').length;
    await s.call('media', { op: 'changetest', reason: 'media', n: 5 }, 4000);
    await T.sleep(1500);
    t.check('watch off: no events after it', s.collect('media').length === n1, String(s.collect('media').length - n1));

    // ---- 6b. lane r6-art (2026-09-30): a missed picture is looked for again, and a reply's rev is
    // as of the START of its read. The user's card kept a note glyph over a paused Spotify song: Spotify
    // publishes no thumbnail for some songs (or late), and a paused player sends no more events.
    const offMiss = await s.call('media', { op: 'changetest', reason: 'artmiss', track: 'off-' + Date.now() }, 4000);
    t.check('art retry: nothing is scheduled while no one watches', offMiss.ok && offMiss.dueMs === -1, JSON.stringify(offMiss));
    await s.call('media', { op: 'watch', on: true }, 8000);
    await T.sleep(1500);   // any real change settles
    const trk = 'trk-' + Date.now();
    const n2 = s.collect('media').length;
    const tM1 = Date.now();
    const m1 = await s.call('media', { op: 'changetest', reason: 'artmiss', track: trk }, 4000);
    t.check('art retry: the first miss asks again in ~1 s', m1.ok && m1.dueMs >= 900 && m1.dueMs <= 1000, JSON.stringify(m1));
    const m1b = await s.call('media', { op: 'changetest', reason: 'artmiss', track: trk }, 4000);
    t.check('art retry: a second miss before then keeps the same time (no extra event)', m1b.dueMs > 0 && m1b.dueMs <= m1.dueMs, `${m1b.dueMs} vs ${m1.dueMs}`);
    const tA = Date.now();
    const evA = await s.waitEvent('media', 2500, (e) => s.collect('media').indexOf(e) >= n2 && (e.reasons || []).includes('art'));
    const lagA = Date.now() - tA;
    t.check('art retry: an "art" event arrives at about 1 s', !!evA && lagA >= 600 && lagA <= 1600, `${lagA} ms`);
    t.check('art retry: its rev is new (main skips an event whose rev it already has)', !!evA && evA.rev >= m1b.rev, JSON.stringify({ ev: evA && evA.rev, m1: m1.rev, m1b: m1b.rev }));
    const m2 = await s.call('media', { op: 'changetest', reason: 'artmiss', track: trk }, 4000);
    const elM = Date.now() - tM1, markM = elM < 4000 ? 4000 : 15000;   // the call itself can be slow on a loaded machine
    t.check('art retry: the next miss waits for the next mark (4 s, not 1 s again)', m2.dueMs > 0 && Math.abs(m2.dueMs - (markM - elM)) <= 400, `${m2.dueMs} ms, ${elM} ms after the first miss`);
    const other = await s.call('media', { op: 'changetest', reason: 'artmiss', track: trk + '-next' }, 4000);
    t.check('art retry: a new track starts its own schedule (~1 s)', other.dueMs >= 900 && other.dueMs <= 1000, String(other.dueMs));
    // the rev a get answers is the rev BEFORE its read: a change during the read gets an event with a newer rev
    await T.sleep(3500);   // the retries above have fired
    const armed = await s.call('media', { op: 'changetest', reason: 'midread' }, 4000);
    const n3 = s.collect('media').length;
    const gm = await s.call('media', { op: 'get', art: false }, 8000);
    const evB = await s.waitEvent('media', 2000, (e) => s.collect('media').indexOf(e) >= n3 && (e.reasons || []).includes('media'));
    t.check('rev: a change during a read gets an event whose rev the reply does NOT have', armed.ok && gm.ok && !!evB && evB.rev > gm.rev && gm.rev >= armed.rev, JSON.stringify({ armed: armed.rev, get: gm.rev, ev: evB && evB.rev }));
    await s.call('media', { op: 'watch', on: false }, 8000);

    // ---- 7. idle CPU with the watch on (the user's real sessions keep running)
    await s.call('media', { op: 'watch', on: true }, 8000);
    await T.sleep(1000);
    const c0 = cpuMs(s.proc.pid);
    const e0 = s.collect('media').length;
    await T.sleep(15000);
    const used = cpuMs(s.proc.pid) - c0;
    const evs = s.collect('media').length - e0;
    t.check('watch: idle CPU under 2% of one core over 15 s', used < 300, `${used} ms CPU, ${evs} event(s)`);
    await s.call('media', { op: 'watch', on: false }, 8000);

    // ---- 8. a busy media thread (stands in for an app whose call never answers)
    const st = await s.call('media', { op: 'stalltest', ms: 0 }, 4000);
    const dropped0 = st.dropped;
    await s.call('media', { op: 'stalltest', ms: 9000 }, 4000);   // longer than two 3.5 s waits
    t0 = Date.now();
    const late = await s.call('media', { op: 'get', art: false }, 8000);
    const lateMs = Date.now() - t0;
    t.check('busy: get behind a hung call answers by the 3.5 s budget with the reason', late.ok === false && /did not finish within 3\.5 s/.test(late.reason || '') && lateMs < 4000, `${lateMs} ms: ${late.reason}`);
    const lateCtl = await s.call('media', { op: 'control', action: 'toggle', dryRun: true }, 8000);
    t.check('busy: a press behind it gives up in time too', lateCtl.ok === false && /did not finish/.test(lateCtl.reason || ''), String(lateCtl.reason).slice(0, 80));
    await T.sleep(2500);   // the stall ends
    const st2 = await s.call('media', { op: 'stalltest', ms: 0 }, 4000);
    t.check('busy: the given-up read and press were DROPPED, not run late', st2.dropped - dropped0 === 2, `${st2.dropped - dropped0} dropped`);
    t0 = Date.now();
    const again = await s.call('media', { op: 'get', art: false }, 8000);
    t.check('busy: the next read is fast and normal again', again.ok === true && Date.now() - t0 < 1500, `${Date.now() - t0} ms`);
    // A job that STARTS after its budget is spent skips every WinRT call instead of running over.
    await s.call('media', { op: 'stalltest', ms: 3300 }, 4000);
    t0 = Date.now();
    const edge = await s.call('media', { op: 'get', art: false }, 8000);
    const edgeMs = Date.now() - t0;
    const skippedOk = edge.ok === true && (edge.sessions || []).every((x) => x.title === null && /ran out of time/.test(x.detailsReason || ''));
    t.check('busy: a read that starts with no budget left skips its calls and still answers', skippedOk && edgeMs < 3600, `${edgeMs} ms, ${edge.count} session(s)`);

    // ---- 9. privacy: no session names in any log line
    const secrets = [];
    for (const x of sessions) { secrets.push(x.aumid, x.title, x.artist, x.album, x.app && x.app.name); }
    const logs = s.events.filter((e) => e.ev === 'log').map((e) => JSON.stringify(e)).join('\n') + '\n' + s.stderr;
    const leaks = secrets.filter((x) => typeof x === 'string' && x.length > 2 && logs.includes(x)).length;
    t.check('privacy: no app id, title, artist, album or app name in any log line or stderr', leaks === 0, `${leaks} leak(s)`);
  } catch (e) {
    t.check('no exception', false, e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e));
  }
  await s.stop();
  process.exit(t.summary());
})();

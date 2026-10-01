/* autopause.test.js - Spotify auto-pause (r5-autopause lane, 2026-09-30), all against FAKES: a fake
 * clock, a fake Spotify, synthetic peak streams replayed from the bridge's measured cases
 * (~/.claude memory project_spotify-autopause: blips 153-5688 ms vs lessons >= 12.9 s, a lesson with
 * the position frozen at 10.38 for 70 s and live audio, LessonPlayer saying Playing while idle and Paused
 * mid-lesson), fake process trees, a fake helper task and a fake bridge on a free port.
 * Nothing pauses, plays or changes the volume of the real Spotify or any real app.
 *   node lib/features/autopause.test.js
 */
'use strict';
const http = require('http');
const { createEngine, DEFAULTS } = require('./_autopause-core.js');
const attrib = require('./_autopause-attrib.js');
const coexist = require('./_autopause-coexist.js');
const feature = require('./autopause.js');

let pass = 0, fail = 0;
const failures = [];
function ok(c, what) { if (c) pass++; else { fail++; failures.push(what); } }
const J = (x) => JSON.stringify(x);

/* ---------------------------------------------------------------- the rules, on a fake clock */

function fakeSpotify(initial) {
  const s = { state: initial || 'playing', cmds: [], failPause: false };
  s.adapter = {
    state: () => s.state,
    pause: async () => { s.cmds.push(['pause', s.t]); if (s.failPause) return { ok: false, reason: 'Spotify did not answer' }; s.state = 'paused'; return { ok: true }; },
    play: async () => { s.cmds.push(['play', s.t]); s.state = 'playing'; return { ok: true }; },
  };
  return s;
}

/** Run `stream(t)` -> sources every pollMs for `ms`. `events(t, sp, eng)` may act (Owen presses play). */
async function run(stream, ms, opts) {
  const o = opts || {};
  const sp = fakeSpotify(o.initial);
  let t = 0;
  const logs = [];
  const eng = createEngine({ spotify: sp.adapter, now: () => t, log: (x) => logs.push(x), config: o.config });
  for (t = 0; t <= ms; t += DEFAULTS.pollMs) {
    sp.t = t;
    if (o.events) await o.events(t, sp, eng);
    await eng.tick(t, stream(t));
  }
  await eng.idle();
  return { sp, eng, logs, pauses: sp.cmds.filter((c) => c[0] === 'pause'), plays: sp.cmds.filter((c) => c[0] === 'play') };
}
const lessonplayer = (status, peak, pos) => [{ key: 'smtc:Contoso.LessonPlayer_8wekyb3d8bbwe!App', kind: 'media', label: 'LessonPlayer', status, positionMs: pos == null ? null : pos, peak }];
const inBurst = (t, bursts) => bursts.some(([a, b]) => t >= a && t < b);

(async () => {
  // 1. A real lesson: continuous audio 20 s -> instant pause, resume ~7 s after the audio ends.
  {
    const r = await run((t) => lessonplayer('playing', t < 20000 ? 0.12 : 0, 1000), 40000);
    ok(r.pauses.length === 1 && r.pauses[0][1] <= 250, `lesson: paused once within one tick (${J(r.pauses)})`);
    ok(r.plays.length === 1 && r.plays[0][1] >= 26000 && r.plays[0][1] <= 28000, `lesson: resumed once ~7 s after the audio (${J(r.plays)})`);
  }
  // 2. One stray click (300 ms blip): ONE clean gap, between minHold 6 s and ~8 s; never a stutter.
  {
    const r = await run((t) => lessonplayer('paused', inBurst(t, [[5000, 5300]]) ? 0.2 : 0, 0), 30000);
    const gap = r.plays.length === 1 && r.pauses.length === 1 ? r.plays[0][1] - r.pauses[0][1] : -1;
    ok(gap >= 6000 && gap <= 8000, `one blip: one gap of 6-8 s (${gap} ms)`);
  }
  // 3. The measured blip lengths 153 and 5688 ms, 3 s apart, chain into ONE gap (no on-off-on-off).
  {
    const r = await run((t) => lessonplayer('paused', inBurst(t, [[2000, 2153], [5153, 10841]]) ? 0.05 : 0, 0), 30000);
    ok(r.pauses.length === 1 && r.plays.length === 1, `two blips 3 s apart: one pause, one resume (${r.pauses.length}/${r.plays.length})`);
  }
  // 3b. Blips separated by the smallest measured gap (6708 ms) stay separate episodes, each one gap.
  {
    const r = await run((t) => lessonplayer('paused', inBurst(t, [[1000, 1153], [7861, 8014]]) ? 0.05 : 0, 0), 30000);
    ok(r.pauses.length <= 2 && r.plays.length === r.pauses.length, `blips 6.7 s apart: at most two clean gaps (${r.pauses.length}/${r.plays.length})`);
  }
  // 4. LessonPlayer lies: "Playing" while idle, no audio, position still -> never pauses (60 s).
  {
    const r = await run(() => lessonplayer('playing', 0, 10380), 60000);
    ok(r.pauses.length === 0, `lying Playing while idle: never paused (${r.pauses.length})`);
  }
  // 5. LessonPlayer lies the other way: "Paused" mid-lesson with audio (status=Paused peak=0.179) -> held.
  {
    const r = await run((t) => lessonplayer(t % 2000 < 1000 ? 'paused' : 'playing', 0.179, 10380), 30000);
    ok(r.pauses.length === 1 && r.plays.length === 0, `lying Paused with audio: held the whole time (${r.pauses.length}/${r.plays.length})`);
  }
  // 6. Frozen position (10.38 for 70 s) with live audio 0.01-0.25 -> held, never resumed mid-lesson.
  {
    const r = await run((t) => lessonplayer('playing', 0.01 + ((t / 250) % 25) / 100, 10380), 70000);
    ok(r.pauses.length === 1 && r.plays.length === 0, `frozen position, live audio: held 70 s (${r.pauses.length}/${r.plays.length})`);
  }
  // 6b. The quietest measured lesson beat (0.000846) still counts; 0.0005 does not.
  {
    const a = await run(() => lessonplayer('paused', 0.000846, 0), 3000);
    const b = await run(() => lessonplayer('paused', 0.0005, 0), 3000);
    ok(a.pauses.length === 1 && b.pauses.length === 0, `peak threshold 0.0008: 0.000846 pauses, 0.0005 does not (${a.pauses.length}/${b.pauses.length})`);
  }
  // 7. Position-only (no meter): the measured silent navigation flips (realPlaying true for 3.2-3.6 s,
  //    i.e. position moving for ~0.25-0.6 s) do NOT pause; a sustained run pauses at ~8 s.
  {
    const burst = await run((t) => lessonplayer('playing', -1, t >= 1000 && t < 1600 ? t : 1600), 20000);
    ok(burst.pauses.length === 0, `position-only flip ~3.6 s: no pause (${burst.pauses.length})`);
    const long = await run((t) => lessonplayer('playing', -1, t), 20000);
    ok(long.pauses.length === 1 && long.pauses[0][1] >= 8000 && long.pauses[0][1] <= 9000, `position-only sustained: paused at 8-9 s (${J(long.pauses)})`);
  }
  // 8. One catch-up position jump is not playback.
  {
    const r = await run((t) => lessonplayer('playing', -1, t < 5000 ? 0 : 90000), 15000);
    ok(r.pauses.length === 0, `one position jump: no pause (${r.pauses.length})`);
  }
  // 9. Only resume what we paused: Spotify already paused by Owen stays paused.
  {
    const r = await run((t) => lessonplayer('playing', t < 5000 ? 0.1 : 0, 0), 20000, { initial: 'paused' });
    ok(r.pauses.length === 0 && r.plays.length === 0, `already paused by Owen: never touched (${r.pauses.length}/${r.plays.length})`);
  }
  // 10. Owen presses play during a hold: re-paused twice, then left alone 5 min.
  {
    const presses = [3000, 6000, 9000, 12000];
    const r = await run(() => lessonplayer('playing', 0.1, 0), 20000, {
      events: (t, sp) => { if (presses.includes(t)) sp.state = 'playing'; },
    });
    const snap = r.eng.snapshot(20000);
    ok(r.pauses.length === 3 && snap.suppressed, `play pressed 4x during a hold: first pause + 2 re-pauses, then backs off (${r.pauses.length}, suppressed ${snap.suppressed})`);
    ok(r.logs.some((l) => /leaving Spotify alone for 5 min/.test(l)), 'back-off is logged in plain words');
  }
  // 11. The source closes mid-hold: hold released, Spotify resumed.
  {
    const r = await run((t) => (t < 10000 ? lessonplayer('playing', 0.1, 0) : []), 20000);
    ok(r.pauses.length === 1 && r.plays.length === 1 && r.plays[0][1] >= 10000 && r.plays[0][1] <= 10500, `source closed: resumed at once (${J(r.plays)})`);
  }
  // 12. A browser hold over HTTP with no refresh expires after 180 s (no stranded hold).
  {
    const sp = fakeSpotify('playing');
    let t = 0;
    const eng = createEngine({ spotify: sp.adapter, now: () => t });
    await eng.addHold('http:browser', { native: false }, 0);
    for (t = 0; t <= 185000; t += 1000) { sp.t = t; await eng.tick(t, []); }
    await eng.idle();
    ok(sp.cmds.length === 2 && sp.cmds[1][0] === 'play' && sp.cmds[1][1] >= 180000 && sp.cmds[1][1] <= 181000, `http hold expired at 180 s (${J(sp.cmds)})`);
  }
  // 13. Browser video: muted (Playing, peak 0 measured) hands the music back; audible holds; unmeasured trusts Playing.
  {
    const br = (status, peak) => [{ key: 'smtc:Chrome', kind: 'browser', label: 'Chrome', status, positionMs: 0, peak }];
    const muted = await run(() => br('playing', 0), 10000);
    const loud = await run(() => br('playing', 0.3), 10000);
    const unknown = await run(() => br('playing', -1), 10000);
    const pausedNoise = await run(() => br('paused', 0.3), 10000);
    ok(muted.pauses.length === 0, `browser muted video: no pause (${muted.pauses.length})`);
    ok(loud.pauses.length === 1 && loud.pauses[0][1] <= 250, `browser video with sound: instant pause (${J(loud.pauses)})`);
    ok(unknown.pauses.length === 1, `browser not measurable: trusts its Playing (${unknown.pauses.length})`);
    ok(pausedNoise.pauses.length === 0, `browser paused + a ping from another tab: no pause (${pausedNoise.pauses.length})`);
  }
  // 14. "Any sound": a 500 ms ping is not a pause; 3 s of sound is.
  {
    const app = (peak) => [{ key: 'app:discord.exe', kind: 'app', label: 'Discord', status: 'unknown', positionMs: null, peak }];
    const ping = await run((t) => app(inBurst(t, [[2000, 2500]]) ? 0.3 : 0), 15000);
    const talk = await run((t) => app(inBurst(t, [[2000, 5000]]) ? 0.3 : 0), 15000);
    ok(ping.pauses.length === 0, `any-sound: a 500 ms ping does not pause (${ping.pauses.length})`);
    ok(talk.pauses.length === 1 && talk.pauses[0][1] >= 4000 && talk.pauses[0][1] <= 4500, `any-sound: 3 s of sound pauses after 2 s (${J(talk.pauses)})`);
  }
  // 15. releaseAll hands Spotify back; a failed pause is said, not swallowed.
  {
    const sp = fakeSpotify('playing');
    let t = 0;
    const eng = createEngine({ spotify: sp.adapter, now: () => t });
    await eng.tick(0, lessonplayer('playing', 0.2, 0));
    const r = await eng.releaseAll('test');
    ok(r.action === 'resumed' && sp.state === 'playing', `releaseAll resumes what we paused (${r.action})`);
    const sp2 = fakeSpotify('playing'); sp2.failPause = true;
    const eng2 = createEngine({ spotify: sp2.adapter, now: () => 0 });
    await eng2.tick(0, lessonplayer('playing', 0.2, 0));
    const st = feature._statusOf({ enabled: true, mode: 'media', snap: eng2.snapshot(0) });
    ok(st.state === 'error' && /Spotify could not be paused: Spotify did not answer/.test(st.words), `failed pause is said (${st.words})`);
  }

  /* ---------------------------------------------------------------- attribution: fake process trees */
  {
    const ACE = 'Contoso.LessonPlayer_8wekyb3d8bbwe!App';
    const media = { ok: true, sessions: [
      { aumid: ACE, app: { name: 'LessonPlayer' }, status: 'playing', timeline: { available: true, positionMs: 10380 } },
      { aumid: 'Spotify.exe', app: { name: 'Spotify' }, status: 'playing' },
      { aumid: 'Chrome', app: { name: 'Google Chrome' }, status: 'paused' },
      { aumid: 'Chrome', app: { name: 'Google Chrome' }, status: 'playing' },
      { aumid: 'MSEdge', app: { name: 'Microsoft Edge' }, status: 'playing' },
      { aumid: 'Opera GX Stable', app: { name: 'Opera GX' }, status: 'playing' },
      { aumid: '308046B0AF4A39CB', app: { name: 'Firefox' }, status: 'playing' },
    ] };
    const ch = (...xs) => xs.map(([pid, exe, pkg]) => ({ pid, exe, pkg: pkg || null }));
    const peaks = { ok: true, sessions: [
      { pid: 30, peak: 0.2, chain: ch([30, 'msedgewebview2.exe'], [20, 'msedgewebview2.exe'], [10, 'lessonplayerapp.exe', 'Contoso.LessonPlayer_8wekyb3d8bbwe'], [4000, 'explorer.exe']) },
      { pid: 50, peak: 0.9, chain: ch([50, 'spotify.exe'], [49, 'spotify.exe']) },
      { pid: 60, peak: 0.4, chain: ch([60, 'chrome.exe'], [59, 'chrome.exe']) },
      { pid: 70, peak: 0.5, chain: ch([70, 'opera.exe']) },
      { pid: 80, peak: 0.6, chain: ch([80, 'firefox.exe']) },
      { pid: 90, peak: 0.7, chain: ch([90, 'electron.exe'], [88, 'electron.exe']) },
      { pid: 95, peak: 0.3, chain: ch([95, 'discord.exe']) },
      { pid: 0, sys: true, peak: 0.8, chain: [] },
    ] };
    const r = attrib.sources({ media, peaks, mode: 'media', mantlePids: new Set([88]) });
    const by = (k) => r.sources.find((s) => s.key === k) || {};
    ok(by(`smtc:${ACE}`).peak === 0.2 && by(`smtc:${ACE}`).kind === 'media', `LessonPlayer: grandchild web view's sound found through the package (${J(by(`smtc:${ACE}`))})`);
    ok(r.spotify.found && r.spotify.state === 'playing' && !r.sources.some((s) => /spotify/i.test(s.key)), 'Spotify is the target, never a source');
    ok(by('smtc:Chrome').status === 'playing' && by('smtc:Chrome').peak === 0.4 && by('smtc:Chrome').kind === 'browser', `two Chrome tabs: one browser source, playing (${J(by('smtc:Chrome'))})`);
    ok(by('smtc:Opera GX Stable').peak === 0.5 && by('smtc:308046B0AF4A39CB').peak === 0.6, 'Opera GX and Firefox matched by name / table');
    ok(by('smtc:MSEdge').peak === -1, `Edge never takes LessonPlayer' web view sound by name (${by('smtc:MSEdge').peak})`);
    ok(!r.sources.some((s) => s.kind === 'app'), 'media mode: apps without a media session do not count');
    const any = attrib.sources({ media, peaks, mode: 'any', mantlePids: new Set([88]) });
    const apps = any.sources.filter((s) => s.kind === 'app').map((s) => s.key).sort();
    ok(J(apps) === J(['app:discord.exe']), `any mode: Discord counts; Mantle, Spotify and system sounds never (${J(apps)})`);
    const nometer = attrib.sources({ media, peaks: { ok: false, reason: 'x' }, mode: 'media' });
    ok(nometer.sources.every((s) => s.peak === -1), 'meter unreadable: every peak unknown (-1), never a fake 0');
  }

  /* ---------------------------------------------------------------- coexistence */
  {
    const xml = (en) => `<?xml version="1.0"?><Task version="1.2"><Settings>${en == null ? '' : `<Enabled>${en}</Enabled>`}<Hidden>false</Hidden></Settings></Task>`;
    ok(coexist.taskStateFromXml(xml('false')) === 'disabled' && coexist.taskStateFromXml(xml('true')) === 'enabled' &&
       coexist.taskStateFromXml(xml(null)) === 'enabled' && coexist.taskStateFromXml('junk') === 'unknown', 'task XML: disabled / enabled / default enabled / unknown');
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml('false'), 'utf16le')]);
    const s1 = await coexist.readTask({ readFile: (f, cb) => cb(null, utf16) });
    const s2 = await coexist.readTask({ readFile: (f, cb) => { const e = new Error('no'); e.code = 'ENOENT'; cb(e); } });
    ok(s1 === 'disabled' && s2 === 'absent', `task file: UTF-16 read (${s1}), missing = absent (${s2})`);
    const serve = (body) => new Promise((res) => { const s = http.createServer((q, a) => { a.end(JSON.stringify(body)); }); s.listen(0, '127.0.0.1', () => res(s)); });
    const real = await serve({ ok: true, app: 'spotify-autopause', version: '1.5.3' });
    const ours = await serve({ ok: true, app: 'spotify-autopause', server: 'mantle' });
    const pr = real.address().port, po = ours.address().port;
    const absent = (f, cb) => { const e = new Error('no'); e.code = 'ENOENT'; cb(e); };
    const c1 = await coexist.check({ readFile: absent, ports: [pr] });
    const c2 = await coexist.check({ readFile: absent, ports: [po] });
    const c3 = await coexist.check({ readFile: (f, cb) => cb(null, Buffer.from(xml('true'))), ports: [] });
    const c4 = await coexist.check({ readFile: absent, ports: [1], timeoutMs: 300 });
    ok(c1.inCharge && c1.bridge && c1.bridge.version === '1.5.3', 'a bridge answering /ping is in charge');
    ok(!c2.inCharge, "Mantle's own compatible server is never mistaken for the helper");
    ok(c3.inCharge && c3.task === 'enabled', 'an enabled task is in charge even while its bridge is down (the 1-minute gap)');
    ok(!c4.inCharge && c4.words === '', 'nothing installed, nothing answering: Mantle is in charge');
    ok(/separate Spotify auto-pause helper/.test(c1.words) && !/bridge|task|8787|PowerShell/i.test(c1.words), `standby words are plain (${c1.words})`);
    real.close(); ours.close();
  }

  /* ---------------------------------------------------------------- the feature, on a fake ctx */
  {
    const ACE = 'Contoso.LessonPlayer_8wekyb3d8bbwe!App';
    function fakeCtx(opts) {
      const o = opts || {};
      const x = { logs: [], pushes: [], sent: [], enabled: true, media: null, mediaFns: [], settings: { apps: 'media' }, onEn: [], cmds: {}, replays: {} };
      x.ctx = {
        flags: { test: o.test !== false, live: false },
        log: (t) => x.logs.push(t),
        enabled: () => x.enabled,
        onEnabled: (fn) => x.onEn.push(fn),
        broadcast: (ev, p) => x.pushes.push([ev, p]),
        replay: (ev, fn) => { x.replays[ev] = fn; },
        command: (v, fn) => { x.cmds[v] = fn; },
        health: () => {},
        onOption: () => {},
        settings: { get: (k, d) => (k in x.settings ? x.settings[k] : d), set: (k, v) => { x.settings[k] = v; } },
        host: { media: () => x.media, onMedia: (fn) => { x.mediaFns.push(fn); return () => {}; } },
        sidecar: { send: async (cmd, args) => {
          x.sent.push([cmd, args]);
          if (cmd === 'autopause.peaks') return { ok: true, result: o.peaks || { ok: true, sessions: [] } };
          if (cmd === 'media') return { ok: true, result: { ok: true, dryRun: !!args.dryRun, sent: !args.dryRun, action: args.action } };
          return { ok: false, error: 'unknown' };
        } },
      };
      x.push = (m) => { x.media = m; for (const fn of x.mediaFns) fn(m); };
      x.last = () => { const p = x.pushes.filter((q) => q[0] === 'autopause.status'); return p.length ? p[p.length - 1][1] : null; };
      return x;
    }
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const lesson = { ok: true, sessions: [{ aumid: ACE, app: { name: 'LessonPlayer' }, status: 'playing' }, { aumid: 'Spotify.exe', app: { name: 'Spotify' }, status: 'playing' }] };
    const acePeaks = { ok: true, sessions: [{ pid: 30, peak: 0.2, chain: [{ pid: 30, exe: 'msedgewebview2.exe' }, { pid: 10, exe: 'lessonplayerapp.exe', pkg: 'Contoso.LessonPlayer_8wekyb3d8bbwe' }] }] };

    // a) The helper is in charge: stays off, says so, never reads a peak or sends a control.
    const a = fakeCtx({ peaks: acePeaks });
    const ha = feature._install(a.ctx, { coexist: async () => ({ inCharge: true, task: 'enabled', words: 'The separate Spotify auto-pause helper on this PC is in charge, so Mantle’s stays off' }) });
    await wait(20); a.push(lesson); await wait(400);
    ok(a.last().state === 'standby' && /helper/.test(a.last().words), `helper in charge: standby, said (${a.last().state})`);
    ok(!a.sent.some((s) => s[0] === 'media'), 'helper in charge: Spotify never touched');
    await ha.stop();

    // b) In charge: LessonPlayer plays -> a dry-run pause (test), "Paused while LessonPlayer plays"; turning it off hands back.
    const b = fakeCtx({ peaks: acePeaks });
    const hb = feature._install(b.ctx, { coexist: async () => ({ inCharge: false, words: '' }) });
    await wait(20); b.push(lesson); await wait(600);
    const pause = b.sent.find((s) => s[0] === 'media' && s[1].action === 'pause');
    ok(!!pause && pause[1].dryRun === true && pause[1].aumid === 'Spotify.exe', `in charge: pause sent as a dry run to Spotify (${J(pause && pause[1])})`);
    ok(b.last().state === 'holding' && b.last().words === 'Paused while LessonPlayer plays' && b.last().card === 'Paused while LessonPlayer plays', `card words (${J(b.last())})`);
    ok(b.logs.every((l) => !/LessonPlayer|Contoso|Spotify\.exe|msedge/i.test(l) || /Spotify (paused|resumed)/.test(l)), 'the log names no app');
    b.enabled = false; for (const fn of b.onEn) fn(false); await wait(50);
    const play = b.sent.find((s) => s[0] === 'media' && s[1].action === 'play');
    ok(!!play && play[1].dryRun === true && b.last().state === 'off', `turned off mid-hold: Spotify handed back (dry run) and Off (${b.last().state})`);
    await hb.stop();

    // c) The helper comes back mid-hold: Mantle hands Spotify back first, then stands by.
    let inCharge = false;
    const c = fakeCtx({ peaks: acePeaks });
    const hc = feature._install(c.ctx, { coexist: async () => ({ inCharge, words: inCharge ? 'helper' : '' }) });
    await wait(20); c.push(lesson); await wait(500);
    const held = c.last().state === 'holding';
    inCharge = true; await hc._coexist(); await wait(50);
    ok(held && c.sent.some((s) => s[0] === 'media' && s[1].action === 'play') && c.last().state === 'standby', `helper came back: handed back, standby (${held}, ${c.last().state})`);
    await hc.stop();

    // d) Idle cost: Spotify not playing, nothing held -> no peaks read at all.
    const d = fakeCtx({ peaks: acePeaks });
    const hd = feature._install(d.ctx, { coexist: async () => ({ inCharge: false, words: '' }) });
    await wait(20); d.push({ ok: true, sessions: [{ aumid: ACE, app: { name: 'LessonPlayer' }, status: 'playing' }, { aumid: 'Spotify.exe', status: 'paused' }] }); await wait(600);
    ok(!d.sent.some((s) => s[0] === 'autopause.peaks'), `Spotify paused, nothing held: no reads (${d.sent.length} sent)`);
    await hd.stop();

    // e) Old sidecar (no autopause.peaks): said in words, and the media-status path still works.
    const e = fakeCtx({ peaks: { ok: false, reason: 'unknown command' } });
    const he = feature._install(e.ctx, { coexist: async () => ({ inCharge: false, words: '' }) });
    await wait(20); e.push({ ok: true, sessions: [{ aumid: 'Spotify.exe', status: 'playing' }] }); await wait(400);
    ok(he._state().meterWhy === 'unknown command' && /can’t be read/.test(e.last().words), `meter unreadable is said (${e.last().words})`);
    await he.stop();

    // f) Words: never jargon anywhere a page shows them.
    const all = [];
    for (const snap of [{ holds: [] }, { holds: [{ native: true, label: 'LessonPlayer', kind: 'media' }], wePaused: true },
      { holds: [{ native: true, label: 'Opera GX', kind: 'browser' }], wePaused: true }, { holds: [{ native: false }], wePaused: true },
      { holds: [{ native: true, label: 'A' }, { native: true, label: 'B' }], wePaused: true }, { holds: [{ native: true }], wePaused: true, suppressed: true, suppressedForMs: 290000 }]) {
      all.push(feature._statusOf({ enabled: true, mode: 'media', snap }));
    }
    all.push(feature._statusOf({ enabled: false }), feature._statusOf({ enabled: true, standby: true, standbyWords: 'x' }));
    const text = all.map((s) => `${s.words} | ${s.card}`).join('\n');
    ok(!/undefined|null|NaN|sidecar|aumid|dryRun|\[object/i.test(text), 'no jargon in any state words');
    ok(/Paused while Opera GX plays a video/.test(text) && /Paused while a video plays in your browser/.test(text) && /Paused while 2 apps play/.test(text) && /leaves it alone for 5 min/.test(text),
      'browser, HTTP, two-app and back-off words');
  }

  /* ---------------------------------------------------------------- the compatible API, wired (inc-2) */
  {
    const freePort = () => new Promise((r) => { const sv = http.createServer(); sv.listen(0, '127.0.0.1', () => { const p = sv.address().port; sv.close(() => r(p)); }); });
    const get = (port, p) => new Promise((res) => { http.get({ host: '127.0.0.1', port, path: p }, (r) => { let b = ''; r.on('data', (c) => { b += c; }); r.on('end', () => { try { res(JSON.parse(b)); } catch (e) { res(null); } }); }).on('error', () => res(null)); });
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const port = await freePort();
    const x = { sent: [], pushes: [], mediaFns: [], onEn: [], enabled: true };
    let inCharge = false;
    const ctx = {
      flags: { test: true, live: false }, log: () => {}, enabled: () => x.enabled, onEnabled: (fn) => x.onEn.push(fn),
      broadcast: (ev, p) => x.pushes.push([ev, p]), replay: () => {}, command: () => {}, health: () => {}, onOption: () => {},
      settings: { get: (k, d) => d, set: () => {} },
      host: { media: () => ({ ok: true, sessions: [{ aumid: 'Spotify.exe', status: 'playing' }] }), onMedia: (fn) => { x.mediaFns.push(fn); return () => {}; } },
      sidecar: { send: async (cmd, args) => { x.sent.push([cmd, args]); return cmd === 'media' ? { ok: true, result: { ok: true, dryRun: true } } : { ok: true, result: { ok: true, sessions: [] } }; } },
    };
    const h = feature._install(ctx, { coexist: async () => ({ inCharge, words: inCharge ? 'helper' : '' }), compatPorts: [port] });
    await wait(50);
    const ping = await get(port, '/ping');
    ok(ping && ping.server === 'mantle' && h._compat.running(), 'in charge: the compatible API is up');
    const p = await get(port, '/pause?src=owen-browser');
    await wait(50);
    const last = x.pushes.filter((q) => q[0] === 'autopause.status').pop()[1];
    ok(p && p.action === 'paused' && x.sent.some((q) => q[0] === 'media' && q[1].action === 'pause' && q[1].dryRun === true), `Quartz's hold pauses Spotify (dry run) (${p && p.action})`);
    ok(last.state === 'holding' && last.card === 'Paused while a video plays in your browser', `card words for an HTTP hold (${last.card})`);
    inCharge = true; await h._coexist(); await wait(50);
    const gone = await get(port, '/ping');
    ok(!gone && !h._compat.running() && x.sent.some((q) => q[0] === 'media' && q[1].action === 'play'), 'helper back: API closed, Spotify handed back first');
    inCharge = false; await h._coexist(); await wait(50);
    ok(h._compat.running(), 'helper gone again: the API comes back');
    x.enabled = false; for (const fn of x.onEn) fn(false); await wait(30);
    ok(!h._compat.running(), 'turned off: the API closes');
    await h.stop();
    x.enabled = true;
    const h2 = feature._install(Object.assign({}, ctx, { flags: { test: true, live: false } }), { coexist: async () => ({ inCharge: false, words: '' }) });
    await wait(50);
    ok(!h2._compat.running(), '--test without a named port never binds 8787-8790');
    await h2.stop();
  }

  for (const f of failures) console.log('FAIL ' + f);
  console.log(`AUTOPAUSE ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', (e && e.stack) || e); console.log(`AUTOPAUSE ${pass} passed, ${fail + 1} failed`); process.exit(1); });

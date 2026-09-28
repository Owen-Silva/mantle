'use strict';
/* topbar.test.js — the top bar's pure logic (ui/topbar/model.js), and once it exists the feature
 * module's shape (lib/features/topbar.js). Plain node, no deps, no Electron, no sidecar.
 *   node lib/features/topbar.test.js      -> "TOPBAR MODEL TEST: n passed, m failed" */
const path = require('path');
const fs = require('fs');
const M = require(path.join(__dirname, '..', '..', 'ui', 'topbar', 'model.js'));

let passed = 0;
const failures = [];
const check = (name, ok, detail) => { if (ok) passed++; else failures.push(detail ? `${name} (${detail})` : name); };

/* app names */
check('FileDescription wins', M.appName({ exe: 'C:\\x\\notepad++.exe', desc: 'Notepad++' }) === 'Notepad++');
check('"Electron" falls back to the product name', M.appName({ exe: 'C:\\x\\Discord.exe', desc: 'Electron', product: 'Discord' }) === 'Discord');
check('"Electron" twice falls back to the exe name', M.appName({ exe: 'C:\\x\\browser.exe', desc: 'Electron', product: 'Electron' }) === 'Browser');
check('explorer is File Explorer', M.appName({ exe: 'C:\\Windows\\explorer.exe', desc: 'Windows Explorer' }) === 'File Explorer');
check('the desktop is Desktop', M.appName({ shell: true, exe: 'C:\\Windows\\explorer.exe' }) === 'Desktop');
check('no exe at all (elevated app) still has a name', M.appName({ exe: '', desc: '' }) === 'Window');

/* separators */
const cleaned = M.cleanItems([{ t: 'sep' }, { t: 'item', label: 'a' }, { t: 'sep' }, { t: 'sep' }, { t: 'item', label: 'b', items: [{ t: 'sep' }, { t: 'item', label: 'c' }, { t: 'sep' }] }, { t: 'sep' }]);
check('leading, doubled and trailing separators go, recursively',
  JSON.stringify(cleaned.map((i) => i.t)) === '["item","sep","item"]' && cleaned[2].items.length === 1, JSON.stringify(cleaned));

/* new window */
check('Chrome opens a new window with --new-window', JSON.stringify(M.newWindowArgs('C:\\p\\chrome.exe')) === '["--new-window"]');
check('Firefox uses -new-window', JSON.stringify(M.newWindowArgs('C:\\p\\firefox.exe')) === '["-new-window"]');
check('an unknown app gets no New window item at all', M.newWindowArgs('C:\\p\\whatever.exe') === null);
check('the table is not mutated through a returned array', (M.newWindowArgs('C:\\p\\chrome.exe').push('x'), M.newWindowArgs('C:\\p\\chrome.exe').length === 1));

/* titles: never an empty bar */
const chrome = { hwnd: '1', exe: 'C:\\p\\chrome.exe', desc: 'Google Chrome', zoomed: true, topmost: true, menu: null };
const t1 = M.titles(chrome, null);
check('a menu-less app: Mantle, the bold app menu and a Window menu', t1.map((t) => t.key).join(',') === 'mantle,app,window' && t1[1].bold === true && t1[1].label === 'Google Chrome');
const am = t1[1].items.filter((i) => i.t === 'item');
check('app menu: New window, Minimize, Restore size (zoomed), Always on top (checked), Close window, Quit',
  am.map((i) => i.act).join(',') === 'newWindow,minimize,zoom,ontop,close,quit' && am[2].label === 'Restore size' && am[3].checked === true && am[5].label === 'Quit Google Chrome');
const npp = { hwnd: '2', exe: 'C:\\p\\notepad++.exe', desc: 'Notepad++' };
const menu = { source: 'win32', hwnd: '2', items: [{ t: 'item', pos: 0, label: 'File', items: [{ t: 'item', pos: 0, label: 'New', id: 41 }] }, { t: 'sep', pos: 1 }, { t: 'item', pos: 2, label: 'Edit', items: [] , lazy: true }] };
const t2 = M.titles(npp, menu);
check('an app with menus: its menus follow the bold name, separators dropped, positions kept',
  t2.map((t) => t.label).join('|') === 'Mantle|Notepad++|File|Edit' && t2[3].pos === 2 && t2[3].lazy === true && t2[2].source === 'win32');
check('the Mantle menu has the power items, and the dangerous ones confirm',
  M.MANTLE_MENU.filter((i) => i.act === 'power').map((i) => i.power + (i.confirm ? '!' : '')).join(',') === 'lock,sleep,restart!,shutdown!');
check('the Mantle menu has the "keep the bar over full-screen games" switch (unchecked until hello says)',
  M.MANTLE_MENU.some((i) => i.act === 'overGames' && i.checked === false && /full-screen games/.test(i.label)));
check('the desktop gets a File Explorer window item', M.titles({ shell: true }, null)[1].items[0].act === 'newWindow');

/* the tiny-numbers rule */
check('pct rounds and clamps', M.pct(23.4) === '23%' && M.pct(140) === '100%' && M.pct(-1) === '0%' && M.pct(null) === '--');
check('gb has one fixed decimal', M.gb(10 * 2 ** 30) === '10.0' && M.gb(undefined) === '--');
check('rate picks units with fixed decimals', M.rate(0) === '0 KB/s' && M.rate(512 * 1024) === '512 KB/s' && M.rate(2.5 * 2 ** 20) === '2.5 MB/s' && M.rate(300 * 2 ** 20) === '300 MB/s' && M.rate(-5) === '--');
const cells = M.statCells({ cpu: { pct: 12 }, mem: { used: null, reason: 'x' }, gpu: { pct: null, reason: 'no GPU counters' }, net: { down: 1, up: 2 } });
check('an unavailable stat shows -- and carries its reason', cells[2].value === '--' && cells[2].why === 'no GPU counters' && cells[1].why === 'x' && cells[0].why === null);
check('no sample yet: every cell says --, with a reason', M.statCells(null).every((c) => c.value === '--' && c.why));

/* the feature module, once it exists */
const feat = path.join(__dirname, 'topbar.js');
if (fs.existsSync(feat)) {
  const f = require(feat);
  check('feature: name/label/defaultOn/install', f.name === 'topbar' && typeof f.label === 'string' && typeof f.install === 'function');
  // lane tbvideo, 2026-09-26: Win+Alt+T hides / shows the bar; it is a chord the seam knows
  const { CHORDS } = require(path.join(__dirname, '..', 'features.js'));
  check('feature: takes exactly one chord from Windows, Win+Alt+T, and the seam knows it',
    Array.isArray(f.chords) && f.chords.join() === 'Win+Alt+T' && CHORDS.includes('Win+Alt+T') && (f.observe || []).length === 0, JSON.stringify(f.chords));
  check('feature: the Mantle menu has "Hide top bar" with its shortcut shown',
    M.MANTLE_MENU.some((i) => i.act === 'hide' && i.label === 'Hide top bar' && i.key === 'Win+Alt+T'));
  if (typeof f._test === 'object') {
    const T = f._test;
    if (T.reserveSize) check('feature: app bar size is 28 DIP scaled to physical px', T.reserveSize(1.25, true) === 35 && T.reserveSize(1, true) === 28 && T.reserveSize(1.5, false) === 28);

    /* DRIFT (lane tbdrift, 2026-09-27). Owen's log: widths 1477 / 1443 / 1359 / 673 with the left edge
     * at 0, then 140 / 191 / 519 with the right edge at 1536 = a mouse drag on the window's own resize
     * bands, which Electron gives ANY resizable frameless window (thickFrame:false or not). Pinned: the
     * bar's window is not resizable, in the options AND in the source that creates it. */
    const src = fs.readFileSync(feat, 'utf8');
    const cw = (src.match(/function createWindow\(\) \{[\s\S]*?\r?\n {4}\}\r?\n/) || [''])[0];   // CRLF too: git archive / checkout give CRLF
    const opts = typeof T.barWindowOptions === 'function' ? T.barWindowOptions({ x: 0, y: 0, width: 1536, height: 28 }, { live: true, title: 't', preload: 'p' }) : null;
    check('drift: the bar window is NOT resizable (a resizable frameless window has drag handles at its ends and top edge)',
      !!opts && opts.resizable === false && opts.frame === false && opts.movable === false && opts.width === 1536 && opts.height === 28 && opts.alwaysOnTop === true,
      JSON.stringify(opts && { resizable: opts.resizable, frame: opts.frame, movable: opts.movable }));
    check('drift: createWindow builds the window from those options, and says resizable:true nowhere',
      /new BrowserWindow\(barWindowOptions\(/.test(cw) && !/resizable:\s*true/.test(cw), cw ? 'createWindow does not use barWindowOptions' : 'createWindow not found');

    // the put-back: never gives up while something keeps moving the window
    const D = T.driftStep;
    check('drift: driftStep / driftReason exist', typeof D === 'function' && typeof T.driftReason === 'function');
    if (typeof D === 'function') {
      const to = '0,0 1536 wide';
      const burst = ['0,0 1477x38', '0,0 1443x38', '0,0 1359x38', '0,0 673x38', '0,0 1538x38', '0,0 948x38', '140,0 1396x38', '191,0 1345x38', '519,0 1017x38'];
      let d = null; const steps = [];
      burst.forEach((off, i) => { const s = D(d, { off, to, now: 1000 + i * 700 }); steps.push(s); d = s.d; });
      check('drift: the first 3 in 10 s are put back at once, each logged with where it went',
        steps.slice(0, 3).every((s) => s.fix && !s.retryMs && /drifted to 0,0 1\d{3}x38; put back to 0,0 1536 wide/.test(s.log)), JSON.stringify(steps.slice(0, 3)));
      check('drift: the 4th does NOT give up: it is put back too, logged once, and a re-check is queued in 1 s',
        steps[3].fix && steps[3].retryMs === 1000 && steps[3].d.stuck && /keeps leaving its place \(0,0 673x38\).*put back to 0,0 1536 wide again/.test(steps[3].log), JSON.stringify(steps[3]));
      check('drift: while the re-check is queued, more moves wait for it (the backoff), with no log line each',
        steps.slice(4).every((s) => !s.fix && !s.log && s.d.stuck) && d.last === '519,0 1017x38', JSON.stringify(steps.slice(4).map((s) => s.fix)));
      check('drift: a fight is a health reason naming the last place, but not while the bar is hidden (by hand, a game, video)',
        /keeps moving or resizing the top bar's window \(last seen at 519,0 1017x38\).*put it back 4 times.*every 1 s/.test(T.driftReason(d, true) || '') &&
        T.driftReason(d, false) === null && T.driftReason(null, true) === null, T.driftReason(d, true));
      // re-checks still out of place: put back each time, spaced 2, 4, 8, 16, then every 30 s
      const waits = []; let t = 20000;
      for (let i = 0; i < 7; i++) { const s = D(d, { off: '0,0 900x38', to, now: t, retry: true }); waits.push(s.fix ? s.retryMs : -1); d = s.d; t += s.retryMs; }
      check('drift: re-checks keep putting it back on a backoff that tops out at 30 s (never stops)',
        JSON.stringify(waits) === JSON.stringify([2000, 4000, 8000, 16000, 30000, 30000, 30000]) && d.fixes === 11, JSON.stringify({ waits, fixes: d.fixes }));
      const settled = D(d, { off: null, to, now: t, retry: true });
      check('drift: a re-check finding it in place ends the fight (health clears) with one line',
        settled.settled && settled.d === null && !settled.fix && /back in place and stayed there, after 11 put-backs/.test(settled.log) && T.driftReason(settled.d, true) === null, JSON.stringify(settled));
      // the startup case: one move by Chromium into the new work area (0,28) is one put-back, no fight
      const one = D(null, { off: '0,28 1536x38', to, now: 5000 });
      const calm = D(one.d, { off: null, to, now: 5300 });
      const later11 = D(one.d, { off: '0,28 1536x38', to, now: 16000 });
      check('drift: a single move (the work area changing at start) is one put-back; the count resets after 10 s',
        one.fix && !one.d.stuck && !calm.fix && !calm.log && later11.fix && later11.d.n === 1 && !later11.d.stuck, JSON.stringify({ one, later11 }));
    }
    if (T.stepAsideFor) {
      check('feature: a game verdict steps the bar aside', T.stepAsideFor({ stepAside: true, signal: 'x' }, false) === true);
      check('feature: "keep the bar over full-screen games" overrides it', T.stepAsideFor({ stepAside: true }, true) === false);
      check('feature: no verdict (an old sidecar) never steps aside', T.stepAsideFor(undefined, false) === false && T.stepAsideFor({ stepAside: false }, false) === false);
      check('feature: the lock screen always steps the bar aside, even with "keep over games" on',
        T.stepAsideFor({ stepAside: false }, false, 'LockApp.exe') === true && T.stepAsideFor(undefined, true, 'LogonUI.exe') === true);
      // valofix, 2026-09-26: Valorant came up WINDOWED (maximised under the strip), so no verdict ever said "step aside"
      const run = { pid: 900, file: 'VALORANT-Win64-Shipping.exe', all: [{ pid: 900, file: 'VALORANT-Win64-Shipping.exe' }] };
      check('feature: a known game RUNNING steps the bar aside with no full-screen verdict at all (windowed, behind, loading)',
        T.stepAsideFor({ stepAside: false }, false, null, run) === true && T.stepAsideFor(undefined, false, null, run) === true);
      check('feature: "keep the bar over full-screen games" does not apply to a known game running',
        T.stepAsideFor({ stepAside: true }, true, null, run) === true && T.stepAsideFor({ stepAside: false }, true, null, run) === true);
      check('feature: no game running = exactly the old rules', T.stepAsideFor({ stepAside: true }, true, null, null) === false && T.stepAsideFor({ stepAside: true }, false, null, null) === true);
    }
    if (T.videoFor && T.asideKind) {
      const V = T.videoFor;
      const chromeFs = { hwnd: '700', exe: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', desc: 'Google Chrome', fullscreen: true, game: { stepAside: false } };
      const yt = { aumid: 'Chrome', status: 'playing', playing: true, title: 'A lesson' };
      const spotify = { aumid: 'Spotify.exe', status: 'playing', playing: true };
      const v1 = V(chromeFs, [spotify, yt], null);
      check('video: a full-screen browser whose own session is Playing -> aside (browser id)', !!v1 && v1.hwnd === '700' && v1.how === 'browser' && v1.aumid === 'Chrome', JSON.stringify(v1));
      check('video: the bar steps aside for it (asideKind "video")', T.asideKind({ video: v1 }) === 'video' && T.stepAsideFor({ stepAside: false }, false, null, null, v1) === true);
      check('video: PAUSED, the same window still full screen -> stays aside (the latch, no flicker)',
        V(chromeFs, [Object.assign({}, yt, { status: 'paused', playing: false })], v1) === v1 && V(chromeFs, [], v1) === v1);
      check('video: leaving full screen -> back', V(Object.assign({}, chromeFs, { fullscreen: false }), [yt], v1) === null);
      check('video: another window in front -> the latch does not carry over', V(Object.assign({}, chromeFs, { hwnd: '701', exe: 'C:\\x\\notepad.exe' }), [yt], v1) === null);
      check('video: a paused session with no latch is not watching', V(chromeFs, [Object.assign({}, yt, { status: 'paused', playing: false })], null) === null);
      check('video: ANOTHER app playing (Spotify) does not make a full-screen browser a video', V(chromeFs, [spotify], null) === null);
      const explorerFs = { hwnd: '702', exe: 'C:\\Windows\\explorer.exe', desc: 'Windows Explorer', fullscreen: true };
      check('video: a full-screen non-video window (File Explorer F11) stays over: no video, no aside',
        V(explorerFs, [spotify, yt], null) === null && T.asideKind({ game: { stepAside: false } }) === null);
      const vlc = V({ hwnd: '703', exe: 'C:\\Program Files\\VideoLAN\\VLC\\vlc.exe', desc: 'VLC media player', fullscreen: true }, [], null);
      check('video: a known player full screen -> aside with no session at all (vlc.exe)', !!vlc && vlc.how === 'player', JSON.stringify(vlc));
      const mtv = { hwnd: '704', exe: 'C:\\Program Files\\WindowsApps\\Microsoft.ZuneVideo_10.22091.10041.0_x64__8wekyb3d8bbwe\\Video.UI.exe', fullscreen: true };
      check('video: Movies & TV, mpv, PotPlayer, MPC-HC and the Netflix package are players',
        T.knownPlayer(mtv) === 'Movies & TV' && !!T.knownPlayer({ exe: 'C:\\x\\mpv.exe' }) && !!T.knownPlayer({ exe: 'C:\\x\\PotPlayerMini64.exe' }) &&
        !!T.knownPlayer({ exe: 'C:\\x\\mpc-hc64.exe' }) && T.knownPlayer({ exe: 'C:\\x\\WWAHost.exe', appid: '4DF9E0F8.Netflix_mcm4njqhnhss8!Netflix.App' }) === 'Netflix' &&
        T.knownPlayer({ exe: 'C:\\x\\notepad.exe' }) === null);
      check('video: not the lock screen, not Mantle itself, not the desktop, no snapshot',
        V({ hwnd: '9', exe: 'C:\\Windows\\SystemApps\\x\\LockApp.exe', fullscreen: true }, [yt], null) === null &&
        V(Object.assign({}, chromeFs, { self: true }), [yt], null) === null && V(Object.assign({}, chromeFs, { shell: true }), [yt], null) === null && V(null, [yt], null) === null);
      const M2 = T.sessionMatch;
      const quartz = { hwnd: '705', exe: 'C:\\Users\\user\\browser\\node_modules\\electron\\dist\\electron.exe', desc: 'Electron', appid: 'com.owensilva.quartz', fullscreen: true };
      check('video: match by the taskbar resolver app id (the Quartz browser: a bare electron.exe)', M2(quartz, { aumid: 'com.owensilva.quartz' }) === 'app id' && M2(Object.assign({}, quartz, { appid: null }), { aumid: 'com.owensilva.quartz' }) === null);
      check('video: match by exe name, by package, by the Firefox install hash, by a word of the id',
        M2({ exe: 'C:\\x\\vlc.exe' }, { aumid: 'vlc.exe' }) === 'exe' && M2({ exe: 'C:\\x\\vlc.exe' }, { aumid: 'mpv.exe' }) === null &&
        M2(mtv, { aumid: 'Microsoft.ZuneVideo_8wekyb3d8bbwe!Microsoft.ZuneVideo' }) === 'package' &&
        M2({ exe: 'C:\\p\\firefox.exe' }, { aumid: '308046B0AF4A39CB' }) === 'browser' && M2({ exe: 'C:\\p\\msedge.exe' }, { aumid: 'MSEdge' }) === 'browser' &&
        M2({ exe: 'C:\\p\\Quartz.exe' }, { aumid: 'com.owensilva.quartz' }) === 'name' && M2({ exe: 'C:\\p\\electron.exe' }, { aumid: 'electron.app.Other' }) === null);
      // manual hide wins over everything; the rest keep their order
      const run = { pid: 1, file: 'VALORANT.exe', all: [{ pid: 1, file: 'VALORANT.exe' }] };
      check('hide: hidden by hand wins over the lock screen, a game running, a video and a game verdict',
        T.asideKind({ hidden: true, lock: 'LockApp.exe', run, video: v1, game: { stepAside: true } }) === 'hidden' && T.asideKind({ hidden: true }) === 'hidden' &&
        T.stepAsideFor(undefined, true, null, null, null, true) === true);
      check('hide: without it the order is lock, game running, video, game verdict',
        T.asideKind({ lock: 'LockApp.exe', run, video: v1 }) === 'lock' && T.asideKind({ run, video: v1 }) === 'run' &&
        T.asideKind({ video: v1, game: { stepAside: true } }) === 'video' && T.asideKind({ game: { stepAside: true }, overGames: true }) === null);
      check('hide: the chord is Win+Alt+T', T.HIDE_CHORD === 'Win+Alt+T');
    }
    if (T.runNames) {
      check('feature: the running games are named once each',
        T.runNames([{ pid: 1, file: 'VALORANT.exe' }, { pid: 2, file: 'VALORANT-Win64-Shipping.exe' }, { pid: 3, file: 'VALORANT.exe' }]) === 'VALORANT.exe, VALORANT-Win64-Shipping.exe' &&
        T.runNames([]) === 'the game' && T.runNames(null) === 'the game');
    }
    if (T.lockScreen) {
      const L = T.lockScreen;
      check('feature: LockApp.exe (the live log\'s full-screen window) is the lock screen, by path, any case',
        L({ exe: 'C:\\Windows\\SystemApps\\Microsoft.LockApp_cw5n1h2txyewy\\LockApp.exe' }) === 'LockApp.exe' && L({ exe: 'c:\\windows\\systemapps\\x\\LOCKAPP.EXE' }) === 'LockApp.exe');
      check('feature: LogonUI.exe is the sign-in screen', L({ exe: 'C:\\Windows\\System32\\LogonUI.exe' }) === 'LogonUI.exe');
      check('feature: an unreadable exe path still matches on the file description', L({ exe: '', desc: 'LockApp.exe' }) === 'LockApp.exe');
      check('feature: ordinary apps, Mantle itself and no snapshot are not the lock screen',
        L({ exe: 'C:\\x\\notepad.exe', desc: 'Notepad' }) === null && L({ exe: 'C:\\x\\LockApp.exe', self: true }) === null && L(null) === null && L({ exe: 'C:\\x\\NotLockApp.exe' }) === null);
    }
    if (T.workAreaCheck) {
      const d = (by, wy) => ({ bounds: { x: 0, y: by, width: 1536, height: 864 }, workArea: { x: 0, y: wy, width: 1536, height: 800 } });
      check('feature: work area starting at the bar bottom passes', T.workAreaCheck(d(0, 28)).ok && T.workAreaCheck(d(0, 28.8)).ok);
      check('feature: work area still at the screen top fails, with both numbers', !T.workAreaCheck(d(0, 0)).ok && T.workAreaCheck(d(0, 0)).want === 28 && T.workAreaCheck(d(0, 0)).got === 0);
    }
    /* A RESERVE ON ITS WAY IS NOT A FAILURE (lane corners): the live log's false "NOT healthy ... let go:
     * hidden by hand" in the ~0.3 s between "shown by hand" and the strip landing. */
    check('feature: stripGap and its graces are exported', typeof T.stripGap === 'function' && T.RESERVE_GRACE_MS > 4300 && T.RESERVE_START_GRACE_MS >= T.RESERVE_GRACE_MS);
    if (T.stripGap) {
      const G = T.stripGap, t0 = 1000000, g = T.RESERVE_GRACE_MS;
      const letGo = { reserved: false, reason: 'let go: hidden by hand; Win+Alt+T takes it back' };
      const pend = (since, grace) => Object.assign({}, letGo, { pending: { since, why: 'shown by hand', grace } });
      check('strip: the live log\'s moment (shown by hand, strip let go, reserve asked) is NOT a failure',
        G({ live: true, reserve: pend(t0), run: null, hidden: false, now: t0 + 1 }) === null &&
        G({ live: true, reserve: pend(t0), run: null, hidden: false, now: t0 + g - 1 }) === null);
      check('strip: a reserve that never lands still reports once its grace is over, with the age and the reason',
        /asked for 6 s ago \(shown by hand\) and has not landed: let go: hidden by hand/.test(String(G({ live: true, reserve: pend(t0), run: null, hidden: false, now: t0 + g }))),
        String(G({ live: true, reserve: pend(t0), run: null, hidden: false, now: t0 + g })));
      check('strip: the start-up grace is its own (a pending mark carries it)',
        G({ live: true, reserve: Object.assign({ reserved: false, reason: 'not reserved yet' }, { pending: { since: t0, why: 'starting', grace: 20000 } }), now: t0 + 19999 }) === null &&
        /not reserved yet/.test(String(G({ live: true, reserve: { reserved: false, reason: 'not reserved yet', pending: { since: t0, why: 'starting', grace: 20000 } }, now: t0 + 20000 }))));
      check('strip: a reserve that ANSWERED with a failure (no pending mark) reports at once',
        /could not be reserved \(boom\)/.test(String(G({ live: true, reserve: { reserved: false, reason: 'the strip could not be reserved (boom), so maximised windows go under the bar' }, now: t0 }))));
      check('strip: a work area that did not move (no pending mark) reports at once',
        /work area starts at 0 DIP/.test(String(G({ live: true, reserve: { reserved: false, reason: 'reserved 35px, but the work area starts at 0 DIP instead of the bar\'s bottom 28 DIP' }, now: t0 }))));
      check('strip: hidden by hand, a known game running, --test, or a reserved strip are never a gap',
        G({ live: true, reserve: letGo, hidden: true, now: t0 }) === null && G({ live: true, reserve: letGo, run: { all: [] }, now: t0 }) === null &&
        G({ live: false, reserve: letGo, now: t0 }) === null && G({ live: true, reserve: { reserved: true, reason: 'ok' }, now: t0 }) === null && G(null) === null);
      check('strip: a let-go strip with nothing asked for is still a failure (no reason given: words anyway)',
        /let go/.test(String(G({ live: true, reserve: letGo, now: t0 }))) && /not reserved/.test(String(G({ live: true, reserve: { reserved: false }, now: t0 }))));
    }
  }
}

/* THE TWO SMALL TOOLS (lane tbtools, 2026-09-27): what the bar shows for the timer and the notes */
{
  const C = require('./_timer-core');
  const t0 = 1790000000000;
  const run = C.startTimer(t0, 25 * 60000, '25 min');
  check('tools: nothing running = no cell (the plain icon)', M.timerCell({ kind: 'idle' }, t0, C) === null && M.timerCell(null, t0, C) === null);
  const c1 = M.timerCell(run, t0 + 6 * 60000 + 18000, C);
  check('tools: a running timer 6:18 in shows 18:42, ending at its time of day', c1 && c1.text === '18:42' && !c1.paused && !c1.up && /25 min timer · ends /.test(c1.title), JSON.stringify(c1));
  const pz = C.pause(run, t0 + 60000);
  const c2 = M.timerCell(pz, t0 + 9 * 60000, C);
  check('tools: paused, the time holds (24:00 left however long it waits)', c2 && c2.text === '24:00' && c2.paused && /paused with 24:00 left/.test(c2.title), JSON.stringify(c2));
  const sw = C.startStopwatch(t0);
  const c3 = M.timerCell(sw, t0 + 65400, C);
  check('tools: a stopwatch counts up (1:05 after 65.4 s)', c3 && c3.text === '1:05' && c3.up, JSON.stringify(c3));
  const idleRows = M.timerMenu({ kind: 'idle' }, t0, C);
  check('tools: the idle menu: 5 / 15 / 25 / 50 minutes, Custom… (typed), Stopwatch',
    JSON.stringify(idleRows.filter((r) => r.t === 'item').map((r) => r.label)) === '["5 minutes","15 minutes","25 minutes","50 minutes","Custom…","Stopwatch"]' &&
    idleRows.filter((r) => r.act === 'timerStart').map((r) => r.ms / 60000).join() === '5,15,25,50' && idleRows.some((r) => r.act === 'timerCustom' && r.placeholder),
    JSON.stringify(idleRows));
  const runRows = M.timerMenu(run, t0 + 1000, C);
  check('tools: a running timer\'s menu: its words (never selectable), Pause, Add 5 minutes, a Cancel that asks, Start another',
    runRows[0].t === 'info' && runRows[0].enabled === false && runRows.some((r) => r.act === 'timerPause') && runRows.some((r) => r.act === 'timerAdd' && r.ms === 300000) &&
    runRows.some((r) => r.act === 'timerCancel' && r.confirm) && runRows.some((r) => r.label === 'Start another' && r.items && r.items.length === 6), JSON.stringify(runRows));
  check('tools: a paused timer offers Resume instead of Pause', M.timerMenu(pz, t0, C).some((r) => r.act === 'timerResume') && !M.timerMenu(pz, t0, C).some((r) => r.act === 'timerPause'));
  const swRows = M.timerMenu(sw, t0 + 5000, C);
  check('tools: the stopwatch\'s words hold still while it runs (the open menu is not redrawn each second)',
    JSON.stringify(swRows) === JSON.stringify(M.timerMenu(sw, t0 + 9000, C)) && swRows.some((r) => r.act === 'timerStopwatch' && /Reset/.test(r.label)), JSON.stringify(swRows[0]));
  const bad = M.timerMenu({ kind: 'idle', persist: { ok: false, reason: 'EPERM x' } }, t0, C);
  check('tools: a timer that cannot be kept across a restart says so, with the reason', bad.some((r) => r.t === 'info' && r.bad && /Not kept across a restart: EPERM x/.test(r.text)));
  check('tools: no timer state yet says so (not a silent empty menu)', M.timerMenu(null, t0, C).some((r) => r.t === 'info' && r.bad));
  const failedPop = M.timerMenu({ kind: 'idle', done: { label: '5 min', popup: 'failed', reason: 'page crashed' } }, t0, C);
  check('tools: a done pop-up that failed to show is said in the menu', failedPop.some((r) => r.t === 'info' && /Timer done: 5 min.*page crashed/.test(r.text)));
  const nb = M.notesButton({ open: true, count: 3, saved: { ok: true } });
  const nbBad = M.notesButton({ open: false, count: 1, saved: { ok: false, reason: 'EACCES' } });
  check('tools: the notes button: pressed while open, amber with the reason when a save failed',
    nb.open && !nb.bad && /3 notes/.test(nb.title) && !nbBad.open && nbBad.bad && /NOT saved: EACCES/.test(nbBad.title) && !M.notesButton(null).open, JSON.stringify([nb, nbBad]));
}

console.log(`TOPBAR MODEL TEST: ${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log('  FAIL ' + f);
process.exit(failures.length || !passed ? 1 : 0);

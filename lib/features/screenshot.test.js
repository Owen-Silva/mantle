// screenshot.test.js - the screenshot feature's pure parts: selection math, DPI, naming, display
// matching (ui/screenshot/geometry.js) and main's own helpers (lib/features/screenshot.js).
//
//   node lib/features/screenshot.test.js
//
// No Electron, no sidecar, no screen: numbers in, numbers out.
'use strict';
const path = require('path');
const G = require(path.join(__dirname, '..', '..', 'ui', 'screenshot', 'geometry.js'));

let passed = 0;
const failures = [];
const skipped = [];   // on-screen checks a quiet run cannot make (MANTLE_TEST_VISIBLE=1 makes them; r8-quiet)
function check(name, ok, detail) {
  if (ok) { passed++; return; }
  failures.push(name);
  console.log('  FAIL ' + name + (detail !== undefined ? ' - ' + JSON.stringify(detail) : ''));
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* ---- normRect / intersect ---------------------------------------------------------------------- */
check('normRect: any drag direction gives the same rect', eq(G.normRect(10, 20, 5, 2), { x: 5, y: 2, w: 5, h: 18 }) &&
  eq(G.normRect(5, 2, 10, 20), { x: 5, y: 2, w: 5, h: 18 }));
check('intersect: overlap', eq(G.intersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 }), { x: 5, y: 5, w: 5, h: 5 }));
check('intersect: touching edges is no overlap', G.intersect({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 5, h: 5 }) === null);

/* ---- cssToPhys at every scale Windows offers ------------------------------------------------- */
const scales = [1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 3];
for (const s of scales) {
  const mon = { x: 0, y: 0, w: Math.round(1920 * s), h: Math.round(1080 * s) };
  const view = { w: 1920, h: 1080 };
  const r = G.cssToPhys({ x: 100, y: 50, w: 400, h: 300 }, mon, view);
  check(`scale ${s}: an integer CSS rect maps to round(edge x scale)`, eq(r, { x: Math.round(100 * s), y: Math.round(50 * s),
    w: Math.round(500 * s) - Math.round(100 * s), h: Math.round(350 * s) - Math.round(50 * s) }), r);
  const full = G.cssToPhys({ x: 0, y: 0, w: 1920, h: 1080 }, mon, view);
  check(`scale ${s}: the whole page is the whole monitor, exactly`, eq(full, mon), full);
  const back = G.physToCss(r, mon, view);
  const again = G.cssToPhys(back, mon, view);
  check(`scale ${s}: phys -> css -> phys is the identity`, eq(again, r), { r, again });
}

// Owen's panel, measured 2026-09-24: 1920x1080 physical at 125% = a 1536x864 CSS page.
{
  const mon = { x: 0, y: 0, w: 1920, h: 1080 };
  const view = { w: 1536, h: 864 };
  const r = G.cssToPhys({ x: 100.4, y: 80.6, w: 639.9, h: 340.3 }, mon, view);
  check('125%: fractional pointer coordinates round per EDGE', eq(r, { x: 126, y: 101, w: 925 - 126, h: 526 - 101 }), r);
  // Two selections sharing an edge on screen share it in the file (no 1 px gap or overlap).
  const a = G.cssToPhys({ x: 10.3, y: 0, w: 100.3, h: 10 }, mon, view);
  const b = G.cssToPhys({ x: 110.6, y: 0, w: 50, h: 10 }, mon, view);
  check('125%: adjacent selections share their edge exactly', a.x + a.w === b.x, { a, b });
  check('125%: a drag past the page edge is clamped to the monitor', eq(G.cssToPhys({ x: 1500, y: 800, w: 100, h: 100 }, mon, view),
    { x: 1875, y: 1000, w: 45, h: 80 }));
  check('125%: a drag starting off the page (negative) is clamped', eq(G.cssToPhys({ x: -20, y: -5, w: 60, h: 25 }, mon, view),
    { x: 0, y: 0, w: 50, h: 25 }));
  check('125%: pointToPhys floors to the pixel under the pointer', eq(G.pointToPhys(0.9, 863.99, mon, view), { x: 1, y: 1079 }));
}

/* ---- mixed DPI: two monitors, two pages, one virtual screen -------------------------------------- */
{
  // A 4K at 150% on the left (origin -3840) and a 1080p at 100% as primary.
  const left = { x: -3840, y: -200, w: 3840, h: 2160 };
  const leftView = { w: 2560, h: 1440 };
  const prim = { x: 0, y: 0, w: 1920, h: 1080 };
  const primView = { w: 1920, h: 1080 };
  const a = G.cssToPhys({ x: 2460, y: 1340, w: 100, h: 100 }, left, leftView);
  check('mixed DPI: the left 150% monitor gives negative physical x inside it', eq(a, { x: -150, y: 1810, w: 150, h: 150 }), a);
  const b = G.cssToPhys({ x: 0, y: 0, w: 100, h: 100 }, prim, primView);
  check('mixed DPI: the primary at 100% is 1:1 from 0,0', eq(b, { x: 0, y: 0, w: 100, h: 100 }), b);
  check('mixed DPI: the two pages meet at x = 0 with no gap', a.x + a.w === b.x);
  const win = { x: -500, y: 100, w: 1000, h: 600 };           // a window straddling both
  const onLeft = G.physToCss(win, left, leftView);
  const onPrim = G.physToCss(win, prim, primView);
  check('mixed DPI: a straddling window is drawn at each page\'s own scale', eq(onLeft, { x: 2226.6666666666665, y: 200, w: 666.6666666666666, h: 400 }) &&
    eq(onPrim, { x: -500, y: 100, w: 1000, h: 600 }), { onLeft, onPrim });
}

/* ---- windowAt ------------------------------------------------------------------------------------ */
{
  const mon = { x: 0, y: 0, w: 1920, h: 1080 };
  const wins = [
    { hwnd: '3', kind: 'window', x: 100, y: 100, w: 200, h: 200 },
    { hwnd: '2', kind: 'window', x: 150, y: 150, w: 400, h: 400 },
    { hwnd: '1', kind: 'desktop', x: 0, y: 0, w: 1920, h: 1080 },
  ];
  check('windowAt: the topmost window under the point wins', G.windowAt(wins, { x: 160, y: 160 }, mon).hwnd === '3');
  check('windowAt: the one beneath where the top one ends', G.windowAt(wins, { x: 320, y: 320 }, mon).hwnd === '2');
  check('windowAt: right/bottom edges are exclusive', G.windowAt(wins, { x: 300, y: 160 }, mon).hwnd === '2' && G.windowAt(wins, { x: 299, y: 160 }, mon).hwnd === '3');
  const d = G.windowAt(wins, { x: 1800, y: 1000 }, mon);
  check('windowAt: the desktop answers as the whole monitor', d.kind === 'desktop' && d.w === 1920 && d.h === 1080);
  const d2 = G.windowAt([], { x: 5, y: 5 }, { x: -1920, y: 0, w: 1920, h: 1080 });
  check('windowAt: no windows at all still answers the monitor', d2.kind === 'desktop' && d2.x === -1920);
}

/* ---- matchDisplays --------------------------------------------------------------------------------- */
{
  const mons = [{ index: 0, x: 0, y: 0, w: 1920, h: 1080 }, { index: 1, x: -3840, y: -200, w: 3840, h: 2160 }];
  const disp = [{ id: 'B', x: -3840, y: -200, w: 3840, h: 2160 }, { id: 'A', x: 0, y: 0, w: 1920, h: 1080 }];
  const m = G.matchDisplays(mons, disp);
  check('matchDisplays: pairs by overlap, not by order', m[0].display.id === 'A' && m[1].display.id === 'B');
  const off = G.matchDisplays([{ index: 0, x: 5000, y: 0, w: 100, h: 100 }], disp);
  check('matchDisplays: a monitor with no display gets null (main says so)', off[0].display === null);
  const dup = G.matchDisplays([{ x: 0, y: 0, w: 1920, h: 1080 }, { x: 0, y: 0, w: 1920, h: 1080 }], [{ id: 'A', x: 0, y: 0, w: 1920, h: 1080 }]);
  check('matchDisplays: a display is never used twice (mirrored monitors)', dup[0].display.id === 'A' && dup[1].display === null);
}

/* ---- naming ------------------------------------------------------------------------------------------ */
check('screenshotName: Windows\' own pattern, zero-padded, local time',
  G.screenshotName(new Date(2026, 8, 4, 7, 5, 9)) === 'Screenshot 2026-09-04 070509');
check('screenshotName: end of year, 24-hour clock', G.screenshotName(new Date(2026, 11, 31, 23, 59, 58)) === 'Screenshot 2026-12-31 235958');
check('sizeText: physical px with a real multiplication sign', G.sizeText(1920, 1080) === '1920 × 1080');

/* ---- labelSpot ------------------------------------------------------------------------------------------- */
{
  const view = { w: 1536, h: 864 };
  const below = G.labelSpot({ x: 100, y: 100, w: 300, h: 200 }, view, 90, 24, 8);
  check('labelSpot: below the bottom-right corner by default', eq(below, { x: 310, y: 308 }), below);
  const above = G.labelSpot({ x: 100, y: 600, w: 300, h: 250 }, view, 90, 24, 8);
  check('labelSpot: above when there is no room below', above.y === 600 - 24 - 8, above);
  const inside = G.labelSpot({ x: 0, y: 0, w: 1536, h: 864 }, view, 90, 24, 8);
  check('labelSpot: inside a full-page selection, never off the page', inside.y >= 0 && inside.y + 24 <= 864 && inside.x + 90 <= 1536, inside);
  const left = G.labelSpot({ x: 0, y: 100, w: 20, h: 20 }, view, 90, 24, 8);
  check('labelSpot: a tiny selection at the left edge keeps the label on the page', left.x >= 4, left);
}
check('isCapture: a click (under 2 physical px) is not a capture', !G.isCapture({ w: 1, h: 300 }) && G.isCapture({ w: 2, h: 2 }) && !G.isCapture(null));

/* ---- main's helpers (lib/features/screenshot.js), once it exists ------------------------------------------ */
let feature = null;
try { feature = require('./screenshot.js'); } catch (err) { if (!/Cannot find module/.test(err.message)) throw err; }
if (feature && feature._test) mainHelpers(feature._test);
else console.log('  (lib/features/screenshot.js helpers: not present yet, skipped)');

function mainHelpers(T) {
  const os = require('os');
  check('module: name is the file name, both chords, on by default', feature.name === 'screenshot' && feature.defaultOn === true &&
    eq(feature.chords, ['Win+Shift+S', 'PrintScreen']) && typeof feature.install === 'function');
  check('fileUrl: spaces, # and % are escaped; the drive stays', T.fileUrl('C:\\Users\\a b\\Temp\\x#1%.bmp') === 'file:///C:/Users/a%20b/Temp/x%231%25.bmp',
    T.fileUrl('C:\\Users\\a b\\Temp\\x#1%.bmp'));
  const disp = [{ x: 0, y: 0, w: 1920, h: 1080 }, { x: 0, y: -1080, w: 1920, h: 1080 }];
  const p1 = T.parkSpot(disp[0], 1920, 1080, [disp[0]]);
  check('parkSpot: above its monitor when nothing is there', eq(p1, { x: 0, y: -1080 - 64 }), p1);
  const p2 = T.parkSpot(disp[0], 1920, 1080, disp);
  check('parkSpot: below when a monitor sits above', eq(p2, { x: 0, y: 1080 + 64 }), p2);
  const work = { x: 0, y: 0, width: 1536, height: 864 };
  const c1 = T.cardSpot({ w: 372, h: 98 }, work, null);
  check('cardSpot: bottom-right of the work area, card + its 12 px margins', eq(c1, { x: 1536 - 396, y: 864 - 122, width: 396, height: 122 }), c1);
  const c2 = T.cardSpot({ w: 372, h: 98 }, work, { x: 400, y: 812, width: 736, height: 44 });
  check('cardSpot: a bar under the corner does not push it (it does not overlap the card\'s columns)', eq(c2, c1), c2);
  const c3 = T.cardSpot({ w: 372, h: 98 }, work, { x: 0, y: 812, width: 1536, height: 52 });
  check('cardSpot: above a full-width bar', c3.y === 812 - 122, c3);
  const tmp = os.tmpdir();
  check('saveDirFor: --test saves under %TEMP% only', T.saveDirFor(true, null, null, null, tmp).dir.toLowerCase().startsWith(tmp.toLowerCase()) &&
    T.saveDirFor(true, 'C:\\Users\\Public\\x', null, null, tmp).dir === null);
  check('saveDirFor: --test ignores the saveDir setting and the real folder', T.saveDirFor(true, null, 'D:\\shots', { path: 'C:\\P\\Screenshots' }, tmp).why === 'test mode');
  check('saveDirFor: live prefers the setting, then Windows\' folder', T.saveDirFor(false, null, 'D:\\shots', { path: 'C:\\P' }, tmp).dir === 'D:\\shots' &&
    T.saveDirFor(false, null, null, { path: 'C:\\P\\Screenshots', source: 'known folder' }, tmp).dir === 'C:\\P\\Screenshots');
  check('saveDirFor: no folder known says so (never a silent null)', /not known/.test(T.saveDirFor(false, null, null, null, tmp).why));
  check('missingCommand: an old sidecar vs a real failure', T.missingCommand('unknown command "shot.grab"') && !T.missingCommand('shot.grab: BitBlt failed'));
  const line = T.summary({ seq: 3, chord: 'PrintScreen', monitors: [{ w: 1920, h: 1080, scale: 1.25 }], windows: 6, grabMs: 32, bltMs: 26, writeMs: 6, decodeMs: 40, shownMs: 95, how: 'painted' });
  check('summary: sizes and timings in one line', /#3 PrintScreen: froze 1920x1080@1.25 \(6 windows\) - grab 32 ms/.test(line) && /on screen 95 ms/.test(line), line);
  check('FRAME_DIR is under %TEMP%', T.FRAME_DIR.toLowerCase().startsWith(tmp.toLowerCase()));
  check('summary: says "moved on screen" (what was asked), never "on screen" (what only a measurement can say)', /moved on screen 95 ms/.test(line) && !/, on screen/.test(line), line);

  /* -- judgeShown: the verdict from MEASURED window facts (the 2026-09-24 live failure) -- */
  const mon = { x: 0, y: 0, w: 1920, h: 1080 };
  const good = { exists: true, visible: true, cloaked: 0, rect: { x: 0, y: 0, w: 1920, h: 1080 }, hit: '42', fg: '42' };
  const J = (over, want) => T.judgeShown(Object.assign({}, good, over), Object.assign({ hwnd: '42', rect: mon, keyboard: true }, want));
  check('judgeShown: visible, uncloaked, on its monitor, hit at its centre, foreground = ok', J({}).ok && J({}).front && J({}).keyboard && J({}).why === '');
  check('judgeShown: the live failure - every flag set but a UWP app has the keyboard = NOT ok, named',
    !J({ fg: '2492188', fgCls: 'ApplicationFrameWindow' }).ok && J({ fg: '2492188', fgCls: 'ApplicationFrameWindow' }).front &&
    /did not give it the keyboard.*ApplicationFrameWindow/.test(J({ fg: '2492188', fgCls: 'ApplicationFrameWindow' }).why));
  check('judgeShown: another window over its centre = not front, class named',
    !J({ hit: '7', hitCls: 'LockScreenBackstopFrame' }).front && /in front of it.*LockScreenBackstopFrame/.test(J({ hit: '7', hitCls: 'LockScreenBackstopFrame' }).why));
  check('judgeShown: nothing under its centre (off every monitor) = not front', !J({ hit: '0' }).front && /nothing answers a click/.test(J({ hit: '0' }).why));
  check('judgeShown: still parked off screen = not front, both rects in the reason',
    !J({ rect: { x: 0, y: -1144, w: 1920, h: 1080 } }).front && /0,-1144 1920x1080, not on its monitor \(0,0 1920x1080\)/.test(J({ rect: { x: 0, y: -1144, w: 1920, h: 1080 } }).why));
  check('judgeShown: a 1 px rounding difference is still on its monitor', J({ rect: { x: 1, y: 0, w: 1919, h: 1080 } }).front);
  check('judgeShown: not visible = not front', !J({ visible: false }).front && /not visible/.test(J({ visible: false }).why));
  check('judgeShown: DWM-cloaked (another virtual desktop, a shell cloak) = not front', !J({ cloaked: 2 }).front && /cloaked.*2/.test(J({ cloaked: 2 }).why));
  check('judgeShown: a window that no longer exists', !T.judgeShown({ exists: false }, { hwnd: '42', rect: mon }).ok && !T.judgeShown(null, { hwnd: '42', rect: mon }).ok);
  check('judgeShown: a second monitor\'s overlay need not hold the keyboard', J({ fg: '9', fgCls: 'x' }, { keyboard: false }).ok);
  check('judgeShown: hwnds compare as strings (koffi numbers vs Electron buffers)', T.judgeShown(Object.assign({}, good, { hit: 42, fg: 42 }), { hwnd: '42', rect: mon, keyboard: true }).ok);

  /* -- secondChord: a press while a capture is open is NEVER ignored -- */
  const t0 = Date.now();
  const sc1 = T.secondChord({ seq: 1, shown: false, t0 }, null);
  check('secondChord: not on screen yet -> restart', sc1.act === 'restart' && /had not come on screen/.test(sc1.why));
  const sc2 = T.secondChord({ seq: 1, shown: true, verified: false, t0 }, { ok: false, why: 'Windows did not give any overlay the keyboard' });
  check('secondChord: the live case (shown, never verified) -> restart, with the measured reason', sc2.act === 'restart' && /not in front.*keyboard/.test(sc2.why), sc2);
  const sc3 = T.secondChord({ seq: 1, shown: true, verified: true, t0 }, { ok: true, why: '' });
  check('secondChord: verified and still in front -> bring it forward again', sc3.act === 'raise');
  const sc4 = T.secondChord({ seq: 1, shown: true, verified: true, t0 }, { ok: false, why: 'another window is in front of it' });
  check('secondChord: verified earlier but covered now -> restart, saying both', sc4.act === 'restart' && /verified earlier, now: another window/.test(sc4.why), sc4);
  check('secondChord: no measurement possible -> restart', T.secondChord({ seq: 1, shown: true, verified: true, t0 }, null).act === 'restart');
  check('blurVerdict: the keyboard taken away right after it came up -> Windows snip; later -> just ends',
    T.blurVerdict(200) === 'fallback' && T.blurVerdict(T.EARLY_BLUR_MS - 1) === 'fallback' && T.blurVerdict(T.EARLY_BLUR_MS) === 'end' && T.blurVerdict(30000) === 'end');
  check('limits: verify within 800 ms, hard timeout 60 s, fallback is Windows\' own snip', T.VERIFY_MS === 800 && T.HARD_TIMEOUT_MS === 60000 && T.FALLBACK_URI === 'ms-screenclip:');
  // Copy text (ocr lane): a mode the page may pick, never one that is remembered for the next capture.
  check('modes: Copy text is a mode', T.ALL_MODES.includes('text'));
  check('modes: Copy text is never the remembered mode (Win+Shift+S always opens as a screenshot)', !T.MODES.includes('text') && T.MODES.join() === 'rect,window,full');

  /* -- lane shotfix (2026-09-28): self-healing, and Windows' own shell UI is not a failure -- */
  // The live case: two "could not come forward" at 18:00-18:01 under 100% CPU took the keys away for good.
  check('retakeDelay: 30 s, then 2 min, then 10 min, and 10 min from then on',
    T.retakeDelay(0) === 30000 && T.retakeDelay(1) === 120000 && T.retakeDelay(2) === 600000 && T.retakeDelay(3) === 600000 && T.retakeDelay(50) === 600000);
  check('retakeDelay: a nonsense count is the first delay, never undefined', T.retakeDelay(-1) === 30000 && T.retakeDelay(undefined) === 30000);
  const at = new Date(2026, 8, 28, 18, 1, 34).getTime();
  const dw = T.downWords('Mantle\'s screenshot overlay could not come forward 2 times in a row (last: x)', 0, at, 30000);
  check('downWords: says the keys went back to Windows, why, and WHEN Mantle takes them back (clock and delay)',
    /could not come forward 2 times in a row/.test(dw) && /Win\+Shift\+S and PrintScreen are Windows' own for now/.test(dw) &&
    /takes them back by itself at 18:01:34 \(in 30 s, try 1\)/.test(dw) && /next press then proves the overlay can come forward/.test(dw), dw);
  check('downWords: the later tries say minutes', /in 2 min, try 2/.test(T.downWords('b', 1, at, 120000)) && /in 10 min, try 3/.test(T.downWords('b', 2, at, 600000)));
  check('clockAt: local 24-hour clock with seconds', T.clockAt(new Date(2026, 0, 2, 3, 4, 5).getTime()) === '03:04:05');
  // shellHost: the process behind the CoreWindow in front (sidecar shot.owner).
  const snip = T.shellHost('ScreenClippingHost.exe', 'Windows.UI.Core.CoreWindow');
  check('shellHost: Windows\' own snip is named, and flagged as the snip', !!snip && snip.snip === true && /Snipping overlay/.test(snip.what), snip);
  for (const [exe, re] of [['StartMenuExperienceHost.exe', /^Start$/], ['SearchHost.exe', /Search/], ['SearchApp.exe', /Search/],
    ['ShellExperienceHost.exe', /notification centre/], ['ShellHost.exe', /Quick settings/], ['TextInputHost.exe', /keyboard/]]) {
    const h = T.shellHost(exe, 'Windows.UI.Core.CoreWindow');
    check(`shellHost: ${exe} is Windows' own shell UI, not the snip`, !!h && !h.snip && re.test(h.what), h);
  }
  check('shellHost: case does not matter', !!T.shellHost('startmenuexperiencehost.EXE', ''));
  check('shellHost: Task view / Alt+Tab is explorer.exe\'s by class only', !!T.shellHost('explorer.exe', 'XamlExplorerHostIslandWindow') && T.shellHost('explorer.exe', 'CabinetWClass') === null);
  check('shellHost: a real app in front is NOT shell UI (it counts)', T.shellHost('chrome.exe', 'Chrome_WidgetWin_1') === null && T.shellHost('electron.exe', 'Chrome_WidgetWin_1') === null);
  const anon = T.shellHost('', 'Windows.UI.Core.CoreWindow');
  check('shellHost: a top-level CoreWindow whose process could not be named is still the shell\'s, and says so', !!anon && !anon.snip && /could not be named/.test(anon.what), anon);
  check('shellHost: an unnamed window of any other class counts', T.shellHost('', 'Chrome_WidgetWin_1') === null && T.shellHost(null, '') === null);
  // snipWords: WHY Windows' snip is in front of Mantle's overlay.
  const own = T.snipWords({ seq: 4, ago: 3400 }, null);
  check('snipWords: the live 18:01 case - Mantle\'s own fallback snip came up late over the next capture',
    /the one Mantle opened 3\.4 s earlier, when capture #4's overlay could not come forward, came up late/.test(own), own);
  const late = T.snipWords({ seq: 4, ago: 3400 }, { words: 'a key Mantle takes (S) reached the keyboard hook 1200 ms after it was pressed', ago: 200 });
  check('snipWords: a key the hook got late wins: the press reached Windows too, with the hook\'s words', /press reached Windows too \(a key Mantle takes \(S\) reached the keyboard hook 1200 ms/.test(late), late);
  const leak = T.snipWords(null, null);
  check('snipWords: nothing of Mantle\'s explains it -> a key leaked to Windows', /press reached Windows too \(a key leaked past Mantle's keyboard hook\)/.test(leak), leak);
  check('snipWords: an old fallback or an old late key does not explain it',
    /leaked/.test(T.snipWords({ seq: 1, ago: T.OWN_SNIP_MS + 1 }, { words: 'w', ago: T.LATE_KEY_MS + 1 })));
  check('limits: Windows\' shell UI gets 1 s to go; the keys come back after 30 s at first', T.SHELL_WAIT_MS === 1000 && T.RETAKE_MS[0] === 30000);

  // The wiring (source pins: the paths need a live overlay and real shell UI, which no test may open).
  const src = require('fs').readFileSync(path.join(__dirname, 'screenshot.js'), 'utf8');
  check('wiring: going down arms the self-healing timer', /function goDown\(base\) \{[\s\S]{0,400}retakeTimer = setTimeout\(\(\) => retake\(base, delay\), delay\)/.test(src));
  check('wiring: the retake takes the keys back on trial and says so in words', /function retake\(base, after\) \{[\s\S]{0,300}trial = \{ base \};[\s\S]{0,120}downWhy = null;[\s\S]{0,400}took Win\+Shift\+S and PrintScreen back from Windows by itself/.test(src));
  check('wiring: one failure on trial sends the keys back at once', /if \(trial\) goDown\(`Mantle's screenshot overlay still could not come forward after the keys were taken back/.test(src));
  check('wiring: a verified capture ends the trial and resets the backoff', /s\.verified = true;[\s\S]{0,120}if \(trial \|\| retakes\) clearDown\(/.test(src));
  check('wiring: Windows\' shell UI in front is not counted', /if \(!host\) fallbacksInARow\+\+;/.test(src) && /if \(host \|\| downWhy\) return;/.test(src));
  check('wiring: Windows\' snip in front -> not opened a second time', /if \(test \|\| snipUp\) \{\r?\n\s*showCard\(card\);/.test(src));
  check('wiring: the shell gets SHELL_WAIT_MS to go, then the overlay is raised again', /limit = Math\.max\(limit, elapsed \+ SHELL_WAIT_MS\)/.test(src) && /went away \$\{elapsed - shellSeen\.at\} ms later; brought the overlay forward again/.test(src));
  check('wiring: the retake timer dies with the feature', /stop\(why\) \{[\s\S]{0,200}clearTimeout\(retakeTimer\);/.test(src));
  check('wiring: the switch off and on still takes the keys back at once', /if \(on\) \{[\s\S]{0,200}clearDown\('switched back on: the overlay gets another try/.test(src));

  /* ---- plain words on screen, no paths in the log (lane capture-shot, 2026-09-29) -------------- */
  // Every reason the sidecar and Electron really give (Screenshot.cs, Ocr.cs, lib/sidecar.js), as
  // the card would have shown it: codes, exception types, command names and paths.
  const RAW = [
    'shot.save: the folder C:\\Users\\user\\Pictures\\My Shots could not be made (Access to the path \'C:\\Users\\user\\Pictures\\My Shots\' is denied.)',
    'shot.save: the screenshot could not be saved (UnauthorizedAccessException: Access to the path \'C:\\x\\Screenshot 2026-09-29 101500.png\' is denied.)',
    'shot.save: the screenshot could not be saved (IOException: There is not enough space on the disk.)',
    'shot.save: 999 screenshots with this name already exist in that folder',
    'shot.save: capture 12 is gone (it was released, or a newer one replaced it)',
    'shot.copy: the clipboard could not be reached: another app is holding the clipboard',
    'shot.copy: no memory for a 30000x20000 picture (2288 MB)',
    'the sidecar has no shot.copy command (an older build): rebuild it with npm run build:sidecar',
    'the screen could not be captured: shot.grab: BitBlt failed (Win32 error 5)',
    'Windows\' OCR could not read the selection (HRESULT 0x80004005: Unspecified error)',
    'no OCR language is installed (Windows Settings > Time & language > Language & region: add a language with its optical character recognition feature)',
    'Windows’ OCR has not been checked yet (the sidecar is still starting)',
    'sidecar "shot.save" timed out after 10000 ms',
    'the sidecar is not running',
    'shot.save: the screenshot could not be saved (ExternalException: A generic error occurred in GDI+.)',
  ];
  const JARGON = /sidecar|\bshot\.\w|Exception|HRESULT|0x[0-9A-F]{4}|Win32|BitBlt|npm|build:|[A-Za-z]:\\|\\\\|undefined|null|NaN|\[object/;
  const plain = RAW.map((r) => T.plainError(r));
  const bad = plain.filter((p) => JARGON.test(p) || !p || p.length > 120);
  check('plainError: every real failure reads in plain words on the card (no code, type, command or path; one short line)', bad.length === 0, bad);
  check('plainError: says what to do next where there is something to do', /pick another folder in Mantle Settings/.test(plain[0]) && /disk is full: free some space/.test(plain[2]) &&
    /restart Mantle/.test(plain[7]) && /add a language in Windows Settings/.test(plain[10]) && /try again in a few seconds/.test(plain[11]) && /take it again/.test(plain[5]), plain);
  check('plainError: an unknown reason keeps its words, minus the type and the path', plain[14] === 'the screenshot could not be saved (A generic error occurred in GDI+.)', plain[14]);
  check('plainError: never empty', T.plainError('') === 'no reason was given' && T.plainError(null) === 'no reason was given');
  const logged = RAW.map((r) => T.noPaths(r));
  const leaks = logged.filter((l) => /[A-Za-z]:\\|owens|My Shots|D:\\Shots|Screenshot 2026/.test(l));
  check('noPaths: no folder or file name survives into a log line (quoted, unquoted with spaces, UNC)', leaks.length === 0 &&
    T.noPaths('\\\\server\\share\\x.png failed') === 'a path failed', leaks);
  check('noPaths: the words around a path stay', T.noPaths('the folder C:\\A B\\c could not be made (denied)') === 'the folder a path could not be made (denied)', T.noPaths('the folder C:\\A B\\c could not be made (denied)'));
  // The fallback card: one short line, no window class, no process file name, no timings.
  const fb = [T.fallbackCard(null, false), T.fallbackCard(T.shellHost('StartMenuExperienceHost.exe', ''), false),
    T.fallbackCard(T.shellHost('', 'Windows.UI.Core.CoreWindow'), false), T.fallbackCard(T.shellHost('ScreenClippingHost.exe', ''), true)];
  check('fallbackCard: plain one-liners (who stayed in front), never a class, exe or ms', fb.every((c) => c.title && c.note && c.note.length < 70 && !/\.exe|class|Chrome_|CoreWindow|\d+ ms|DWM|foreground/.test(c.note)) &&
    fb[0].note === 'Another window stayed in front of Mantle\'s capture' && fb[1].note === 'Start stayed in front of Mantle\'s capture' &&
    fb[2].note === 'A Windows panel stayed in front of Mantle\'s capture' && fb[3].title === 'Windows\' Snipping Tool is open', fb);
  // Copy text unavailable is asked again (it stayed off until Mantle restarted before).
  check('ocrRecheck: unavailable -> asked again after OCR_RECHECK_MS, not sooner; never while available', T.ocrRecheck({ available: false, why: 'timed out' }, 1000, 1000 + T.OCR_RECHECK_MS) &&
    !T.ocrRecheck({ available: false, why: 'timed out' }, 1000, 1000 + T.OCR_RECHECK_MS - 1) && !T.ocrRecheck({ available: true }, 0, 1e12) &&
    T.ocrRecheck({ available: false, why: 'no OCR language is installed' }, 0, T.OCR_RECHECK_MS));
  check('wiring: a capture while Copy text is unavailable asks Windows\' OCR again, and the overlay hears it', /if \(ocrRecheck\(ocr, ocrAskedAt, Date\.now\(\)\)\) checkOcr\(\);/.test(src) &&
    /ctx\.push\(w\.win, 'screenshot\.ocr', ocrForPage\(\)\)/.test(src));
  check('wiring: the card gets plain words; the log gets them without paths', /copyError: copyError && plainError\(copyError\), saveError: saveError && plainError\(saveError\)/.test(src) &&
    /NOT saved \(\$\{noPaths\(saveError\)\}\)/.test(src) && /textError: textError && plainError\(textError\)/.test(src));
  check('wiring: the start-up folder read waits 15 s in --test only; live keeps 4 s (r9-flake)',
    /ctx\.sidecar\.send\('shot\.folder', \{\}, \{ timeoutMs: test \? 15000 : 4000 \}\)/.test(src) && (src.match(/'shot\.folder'/g) || []).length === 1);
  check('wiring: a test step can rest the pointer first (move: a pointermove with no button), --test playback only',
    /if \(st\.move\) document\.dispatchEvent\(new PointerEvent\('pointermove', \{ clientX: st\.move\[0\], clientY: st\.move\[1\], button: -1, buttons: 0/.test(src) &&
    /function playStep\(s\) \{[\s\S]{0,1200}st\.move/.test(src));
  check('wiring: card actions act only for the card on screen (its seq)', /function cardPath\(a\) \{[\s\S]{0,160}a\.seq !== card\.info\.seq\) return null;/.test(src) &&
    (src.match(/const p = cardPath\(x\);/g) || []).length === 3);
  // lane mn-raise (2026-10-12, audit #13): the keyboard first, then the screen; the canary reads again.
  const rv = (src.match(/function reveal\(s, how\) \{[\s\S]*?\n    \}\r?\n/) || [''])[0];
  check('reveal: the parked overlay takes the keyboard (raise.keyboard, the sidecar ladder) BEFORE any overlay moves on screen',
    /raiseWin\.keyboard\(focusOn\.win, \{ sidecar: ctx\.sidecar, hwnd: focusOn\.hwnd/.test(rv) &&
    rv.indexOf('raiseWin.keyboard(') < rv.indexOf('s.kbTimer = setTimeout(placeAll') + 200 &&
    /const placeAll = \(\) => \{[\s\S]{0,200}for \(const o of ready\) \{ place\(o, o\.monitor, true\); o\.onScreen = true; \}/.test(rv) &&
    !/for \(const o of ready\) \{\s*place\(o, o\.monitor, true\);\s*o\.onScreen = true;\s*if \(cur/.test(rv));
  check('reveal: on screen by KB_FIRST_MS even when the ladder is slow, and the old fallback focus only when it lost',
    /s\.kbTimer = setTimeout\(placeAll, KB_FIRST_MS\)/.test(rv) && /if \(!\(s\.kb && s\.kb\.ok\)\) takeKeyboard\(s, focusOn\);/.test(rv) && /clearTimeout\(s\.kbTimer\);/.test(src));
  check('canary: the pixel is read again every PIXEL_STEP_MS for PIXEL_SETTLE_MS, not once at the page\'s answer',
    /s\.canaryPoll = setTimeout\(poll, PIXEL_STEP_MS\)/.test(src) && /if \(ms >= PIXEL_SETTLE_MS\)/.test(src) && /clearTimeout\(s\.canaryPoll\)/.test(src));
  // lane mn-topbar: ctx.sidecar.pid (lib/features.js) reaches every raise.keyboard() call, so the foreground right
  // this process holds is handed on to the sidecar (lib/fg-grant.js) before its ladder runs
  const kbCalls = src.match(/raiseWin\.keyboard\([^)]*\)/g) || [];
  check('keyboard: every raise.keyboard() call passes the sidecar\'s pid (sidecarPid: ctx.sidecar.pid)',
    kbCalls.length === 2 && kbCalls.every((c) => /sidecarPid: ctx\.sidecar\.pid \}/.test(c)), JSON.stringify(kbCalls));
  check('blur: an early loss takes the keyboard back ONCE before falling back to Windows\' snip (never for Windows\' own shell UI)',
    /if \(!test && !s\.retook && !shellOf\(s, fgWin\)\) \{\s*s\.retook = true;\s*const k = await raiseWin\.keyboard\(o\.win/.test(src));

  /* ---- lane shot-save (2026-10-14): copied by default, saved only on the card's Save ---------------- */
  const auto = (feature.options || []).find((o) => o.key === 'autoSave');
  check('option: "Also save every screenshot automatically" is a switch, OFF by default', !!auto && auto.type === 'bool' && auto.default === false &&
    auto.label === 'Also save every screenshot automatically', JSON.stringify(auto));
  const urlOf = (f) => 'u:' + f;
  const mons = [{ file: 'A', frame: { x: 0, y: 0, w: 1920, h: 1080 } }, { file: 'B', frame: { x: 1920, y: 0, w: 1280, h: 1024 } }, { file: null, frame: { x: -800, y: 0, w: 800, h: 600 } }];
  check('thumbPieces: a cut inside one monitor is one piece of that monitor\'s BMP, at its offset',
    eq(T.thumbPieces({ x: 100, y: 50, w: 300, h: 200 }, mons, urlOf), [{ url: 'u:A', sx: 100, sy: 50, sw: 300, sh: 200, dx: 0, dy: 0 }]));
  check('thumbPieces: a cut across two monitors is two pieces that meet without a gap',
    eq(T.thumbPieces({ x: 1800, y: 10, w: 300, h: 100 }, mons, urlOf), [{ url: 'u:A', sx: 1800, sy: 10, sw: 120, sh: 100, dx: 0, dy: 0 }, { url: 'u:B', sx: 0, sy: 10, sw: 180, sh: 100, dx: 120, dy: 0 }]));
  check('thumbPieces: a monitor with no picture, an empty cut or no monitors give nothing (never a broken image)',
    T.thumbPieces({ x: -500, y: 0, w: 100, h: 100 }, mons, urlOf).length === 0 && T.thumbPieces({ x: 0, y: 0, w: 0, h: 5 }, mons, urlOf).length === 0 && T.thumbPieces({ x: 0, y: 0, w: 5, h: 5 }, null, urlOf).length === 0);
  {
    // RAW PIXELS (lane speeddebt): the BMP's bytes after its header ARE the ImageData; no copy, exact size.
    const file = Buffer.alloc(66 + 3 * 2 * 4, 7);
    const p = T.rawPixels(file, { offset: 66, format: 'rgba', w: 3, h: 2 });
    check('rawPixels: a view of exactly w*h*4 bytes after the header (no copy)', p.w === 3 && p.h === 2 && p.data.length === 24 && p.data.buffer === file.buffer && p.data.byteOffset === file.byteOffset + 66, JSON.stringify(p));
    const short = T.rawPixels(file.subarray(0, 80), { offset: 66, format: 'rgba', w: 3, h: 2 });
    check('rawPixels: a file of the wrong size is an error in words (the page decodes the BMP instead)', !short.data && /is 80 bytes, not 90/.test(short.error), JSON.stringify(short));
    check('rawPixels: no size from the sidecar is an error too', !!T.rawPixels(file, {}).error && !!T.rawPixels(file, null).error);
    check('wiring: the frame goes to its page with its raw pixels, and the read happens before the push',
      /pixels: px && !px\.error \? px : null,/.test(src) && src.indexOf('fs.promises.readFile(m.file)') > 0 && src.indexOf('fs.promises.readFile(m.file)') < src.indexOf("ctx.push(o.win, 'screenshot.frame'"));
  }
  check('cardLife: ~7 s with a Save button, 5 s without; a test may shorten it', T.cardLife({ canSave: true }, 0) === 7000 && T.cardLife({}, 0) === 5000 && T.cardLife({ canSave: true }, 1500) === 1500 &&
    T.CARD_HOLD_MS >= 5 * 60000);
  const cm = (src.match(/async function commit\(a\) \{[\s\S]*?\n    \}\r?\n/) || [''])[0];
  check('wiring: a capture is saved ONLY when autoSave is on (else only shot.copy runs)', /const autoSave = ctx\.settings\.get\('autoSave', false\) === true;/.test(cm) &&
    /const target = autoSave \? saveTarget\(s\.step\) : null;/.test(cm) && /const saveP = target && target\.dir \? ctx\.sidecar\.send\('shot\.save'/.test(cm) && (cm.match(/'shot\.save'/g) || []).length === 1);
  check('wiring: commit keeps the frame for the card (held) instead of releasing it, and offers Save when nothing was saved',
    !/release\(s\)/.test(cm) && /held = \{ seq: s\.seq, grab: s\.grab, box, name/.test(cm) && /canSave: !saved/.test(cm));
  check('wiring: the card going lets the frame go (parkCard -> dropHeld -> shot.release of THAT grab), and so does a new card',
    /function parkCard\(why\) \{\s*dropHeld\(why\);/.test(src) && /function dropHeld\(why\) \{[\s\S]{0,200}ctx\.sidecar\.send\('shot\.release', \{ grab: h\.grab \}/.test(src) &&
    /if \(held && held\.seq !== info\.seq\) dropHeld\(/.test(src) && /held = null;\s*\/\/ the card's frame/.test(src));
  check('wiring: Save saves the held box of the held frame, only for the card on screen, once at a time',
    /ctx\.command\('cardSave'[\s\S]{0,200}a\.seq !== card\.info\.seq\) return \{ ok: false/.test(src) &&
    /function saveHeld\(h, via\) \{\s*if \(h\.saving\) return h\.saving;/.test(src) && /ctx\.sidecar\.send\('shot\.save', Object\.assign\(\{\}, h\.box, \{ dir: target\.dir, name: h\.name \}\)/.test(src));
  check('wiring: a failed Save answers in plain words (plainError), and Save can be pressed again',
    /return \{ ok: false, reason: plainError\(sv\.error\) \};/.test(src) && /if \(!r\.ok && held === h\) h\.saving = null;/.test(src));
  check('wiring: a held card (pointer, keyboard, saving) moves the backstop out; let go it is the time left + the grace',
    /armBackstop\(a\.held \? CARD_HOLD_MS : Math\.max\(0, Number\(a\.left\) \|\| 0\) \+ CARD_BACKSTOP_GRACE_MS\)/.test(src));
  const cardJs = require('fs').readFileSync(path.join(__dirname, '..', '..', 'ui', 'screenshot', 'card.js'), 'utf8');
  check('card.js: the deadline is a setTimeout (it runs in a hidden window too), paused while hovered, focused or saving',
    /function paused\(\) \{ return S\.hover \|\| S\.focus \|\| S\.saving; \}/.test(cardJs) && /S\.to = setTimeout\(sync, Math\.max\(16, S\.left\)\)/.test(cardJs) &&
    /send\('cardHold', \{ held: held/.test(cardJs));
}

if (process.argv.includes('--electron-text')) {
  const unitPassed = passed;
  const unitFailed = failures.length;
  electronTextCheck().catch((e) => check('electron: the run did not crash', false, e.stack)).then(() => {
    console.log(`screenshot unit: ${unitPassed} passed, ${unitFailed} failed`);
    console.log(`screenshot copy-text electron: ${passed - unitPassed} passed, ${failures.length - unitFailed} failed`);
    process.exit(failures.length ? 1 : 0);
  });
} else if (!process.argv.includes('--electron')) {
  console.log(`screenshot unit: ${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
} else {
  const unitPassed = passed;
  const unitFailed = failures.length;
  electronCheck().catch((e) => check('electron: the run did not crash', false, e.stack)).then(() => {
    console.log(`screenshot unit: ${unitPassed} passed, ${unitFailed} failed`);
    for (const x of skipped) console.log(`  SKIPPED ${x}`);
    console.log(`screenshot electron: ${passed - unitPassed} passed, ${failures.length - unitFailed} failed${skipped.length ? `, ${skipped.length} SKIPPED (needs MANTLE_TEST_VISIBLE=1)` : ''}`);
    process.exit(failures.length ? 1 : 0);
  });
}

/* ---- END TO END: one Electron --test instance (node lib/features/screenshot.test.js --electron) --------
 * Takes a test slot, launches `electron . --test --profile-name=screenshot` with this lane's sidecar,
 * fires the chords from a second instance (--test-chord), and lets the feature play MANTLE_SHOT_TEST
 * steps INSIDE the overlay page. Every step that looks at pixels uses a SYNTHETIC frame (Screenshot.cs
 * FillSynthetic); the one real grab is timed and cancelled (nothing saved, frames deleted). Saves go to
 * a fresh %TEMP% folder that is deleted at the end; the clipboard is the feature's test sink. */
async function electronCheck() {
  const fs = require('fs');
  const os = require('os');
  const zlib = require('zlib');
  const { spawn, spawnSync } = require('child_process');
  const ROOT = path.join(__dirname, '..', '..');
  const PROFILE = 'screenshot';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const exe = process.env.MANTLE_SIDECAR_EXE;
  if (!exe || !fs.existsSync(exe)) { check('electron: MANTLE_SIDECAR_EXE names a built exe', false, exe); return; }
  const games = Number(spawnSync('powershell', ['-NoProfile', '-Command',
    '@(Get-Process javaw,Minecraft*,RobloxPlayerBeta,*Riot*,VALORANT* -ErrorAction SilentlyContinue).Count'], { encoding: 'utf8' }).stdout.trim()) || 0;
  if (games) { check('electron: no game running (not launching an instance)', false, games); return; }
  let slot = null;
  for (let tries = 0; tries < 20 && !slot; tries++) {
    for (const n of [1, 2]) {
      const d = path.join(os.tmpdir(), `mantle-slot-${n}`);
      try { fs.mkdirSync(d); slot = d; break; } catch (_) { /* taken */ }
    }
    if (!slot) { console.log('  (both test slots taken; waiting 30 s)'); await sleep(30000); }
  }
  if (!slot) { check('electron: a test slot was free within 10 minutes', false); return; }

  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mantle-shot-e2e-'));
  // #5's Save goes to a folder that cannot be made (its parent is a FILE): the real failure route, through the sidecar.
  fs.writeFileSync(path.join(outDir, 'blocker.txt'), 'not a folder');
  const blockedDir = path.join(outDir, 'blocker.txt', 'Screenshots');
  const pngs = () => fs.readdirSync(outDir).filter((f) => /\.png$/i.test(f));
  const K = (k, shift) => ({ key: k, shift });
  const steps = [
    { synthetic: true, mode: 'rect', drag: [100.4, 80.6, 740.3, 420.9], dumpClip: true,     // 1 Win+Shift+S: a drag (its copy dumped as a BMP): copied only;
      card: ['state', 'hover', 'wait:3500', 'state', 'save', 'state', 'leave'] },            //   the card held past its life by the pointer, then Save, then it times out
    { synthetic: true, mode: 'window', click: [5, 5], autoSave: true },                  // 2 PrintScreen: Window mode, saving every screenshot (the old way)
    { synthetic: true, mode: 'full', key: 'Enter', autoSave: false },                    // 3 Full screen by keyboard, the switch back off: copied only
    { synthetic: false, mode: 'rect', key: 'Escape' },                                   // 4 the REAL grab: timed, cancelled
    // 5 keyboard only. The selection starts where the pointer is, and that was Owen's REAL cursor: near the
    // right or bottom edge the 250 x 120 clamped (r9-flake: anchor 1380 of 1536 CSS px -> 155 wide). So the
    // pointer rests at 400,300 first (a move, no press); 250 x 120 from there fits any monitor.
    { synthetic: true, mode: 'rect', move: [400, 300], keys: ['r', 'Enter'].concat(Array(25).fill(K('ArrowRight', true)), Array(12).fill(K('ArrowDown', true)), ['Enter']),
      saveDir: blockedDir, card: ['saveKey', 'state', 'esc'] },          //   and its Save (Ctrl+S) fails: the card says why, Esc closes it
    { synthetic: true, hold: true },       // 6 left open: the STUCK capture of 2026-09-24
    { synthetic: true, probe: 'corner' },  // 7 the second chord replaces #6; the REAL reveal, 1 px on screen, measured -> fallback
    { synthetic: true, blur: true },       // 8 the overlay loses the keyboard -> the capture ends
    { synthetic: true, hold: true },       // 9 nobody does anything -> the hard timeout ends it
    { synthetic: true, probe: 'corner' },  // 10 a second fallback in a row -> the chords go back to Windows
    { synthetic: true, probe: 'corner' },  // 11 (seq) after the self-healing retake: on trial, one fallback -> Windows' again at once
  ];
  const cli = require.resolve('electron/cli.js', { paths: [ROOT] });
  const env = Object.assign({}, process.env, { MANTLE_SIDECAR_EXE: exe, MANTLE_SHOT_TEST: JSON.stringify(steps), MANTLE_SHOT_TEST_DIR: outDir, MANTLE_SHOT_TEST_TIMEOUT_MS: '6000', MANTLE_SHOT_TEST_RETAKE_MS: '8000,3000', MANTLE_SHOT_TEST_CARD_MS: '2500' });
  let out = '';
  const proc = spawn(process.execPath, [cli, '.', '--test', `--profile-name=${PROFILE}`], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout.on('data', (c) => { out += c.toString('utf8'); });
  proc.stderr.on('data', (c) => { out += c.toString('utf8'); });
  let exited = null;
  proc.on('exit', (code) => { exited = { code, at: Date.now() }; });
  const toback = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'tools', 'toback.ps1'), '-Match', PROFILE, '-WaitSec', '60'], { stdio: 'ignore' });
  const waitFor = async (re, ms) => { const t = Date.now() + ms; while (Date.now() < t) { const m = out.match(re); if (m) return m; if (exited) return null; await sleep(150); } return null; };
  const envMsg = Object.assign({}, env, { LOWCPU: '0' });
  const second = (args) => spawnSync(process.execPath, [cli, '.', '--test', `--profile-name=${PROFILE}`].concat(args), { cwd: ROOT, env: envMsg, encoding: 'utf8', timeout: 30000 });
  const json = (m) => { try { return JSON.parse(m[1]); } catch (_) { return null; } };
  const pixel = (vx, vy) => [((((vx >> 8) & 15) << 4) | ((vy >> 8) & 15)) & 255, vy & 255, vx & 255];

  try {
    // Either answer ends the wait; a folder that could not be read fails with its reason, not a 60 s tail.
    const inst = await waitFor(/screenshot: saves go to a %TEMP% test folder|screenshot: the Screenshots folder could not be read.*/, 60000);
    check('electron: the screenshot feature installs and finds its folder', !!inst && /saves go to/.test(inst[0]),
      inst ? inst[0] : (out.split('\n').filter((l) => /screenshot|sidecar|features: started/i.test(l)).slice(-10).join('\n') || out.slice(-800)));
    check('electron: its overlay windows are built', !!await waitFor(/screenshot: \d+ overlay windows? ready \(install\)/, 20000));
    // lane tbdrift: a resizable frameless overlay answered the hit test with resize codes 5 DIP inside
    // every edge and corner, so a selection dragged from a screen corner or edge resized the WINDOW
    const handles = await waitFor(/screenshot: overlay drag handles at the edges and corners: (.*)/, 5000);
    check('electron: the overlay has no drag handles: CLIENT at all four edges and corners, so a drag from a screen corner reaches the page',
      !!handles && handles[1].split(' | ').every((x) => x.trim() === 'none'), handles ? handles[0] : 'no "overlay drag handles" line');
    const down = out.match(/screenshot.*NOT started.*|features\.screenshot.*ok":false.*/);
    check('electron: the feature is not down', !down, down && down[0]);

    // 1: Win+Shift+S, a drag.
    second(['--test-chord=Win+Shift+S']);
    const r1 = json(await waitFor(/TESTSHOT #1 ready (\{.*\})/, 15000) || []);
    check('#1 Win+Shift+S reached the feature and every overlay said ready', r1 && r1.monitors >= 1, out.slice(-600));
    const s1 = json(await waitFor(/TESTSHOT #1 saved (\{.*\})/, 15000) || []);
    const p1 = json(await waitFor(/TESTSHOT #1 played (\{.*\})/, 5000) || []);
    // lane shot-save: a capture is COPIED, not saved, unless Save is pressed (or autoSave is on).
    check('#1 (default): copied, and NO file was written', s1 && s1.copied && !s1.path && s1.autoSave === false && !s1.saveError && pngs().length === 0, JSON.stringify({ s1: s1 && { path: s1.path, autoSave: s1.autoSave, saveError: s1.saveError }, pngs: pngs() }));
    check('#1: the card came up with Save offered, living the test\'s 2.5 s', !!await waitFor(/TESTSHOT card shown \{"w":\d+,"h":\d+,"saved":false,"copied":true,"canSave":true,"lifeMs":2500\}/, 5000));
    const st1a = json(await waitFor(/TESTSHOT card state #1 (\{.*\})/, 5000) || []);
    check('#1: the card says "Screenshot copied" with its Save button, and nothing to open yet', st1a && st1a.title === 'Screenshot copied' && st1a.save && st1a.save.label === 'Save' && !st1a.folder && !st1a.open && st1a.held, JSON.stringify(st1a));
    const st1b = json(await waitFor(/TESTSHOT card state #1 (\{(?:(?!TESTSHOT).)*"paused":true.*\})/, 8000) || []);
    check('#1: the pointer on the card held it past its 2.5 s life (3.5 s), the frame with it', st1b && st1b.shown && !st1b.gone && st1b.paused && st1b.held && st1b.left > 1500, JSON.stringify(st1b));
    const sv1 = json(await waitFor(/TESTSHOT card saved (\{.*\})/, 10000) || []);
    check('#1: Save wrote ONE PNG, in the save folder, named Windows\' way', sv1 && sv1.seq === 1 && sv1.path && sv1.path.startsWith(outDir) && fs.existsSync(sv1.path) && pngs().length === 1 &&
      /^Screenshot \d{4}-\d{2}-\d{2} \d{6}( \(\d+\))?\.png$/.test(sv1.name), JSON.stringify({ sv1, pngs: pngs() }));
    check('#1: Save wrote exactly the copied cut (same box, same size as the clipboard\'s)', sv1 && s1 && s1.clip && sv1.w === s1.clip.w && sv1.h === s1.clip.h && sv1.box &&
      sv1.box.x === s1.rect.x && sv1.box.y === s1.rect.y && sv1.box.w === s1.rect.w && sv1.box.h === s1.rect.h, JSON.stringify({ sv1, clip: s1 && s1.clip, rect: s1 && s1.rect }));
    const st1c = json(await waitFor(/TESTSHOT card state #1 (\{(?:(?!TESTSHOT).)*"title":"Saved to .*\})/, 5000) || []);
    check('#1: the card then says where it went, in plain words, with Show in folder, and the picture opens the file', st1c && /^Saved to \S/.test(st1c.title) && st1c.folder === 'Show in folder' && st1c.copyPath && st1c.open && !st1c.save && !st1c.warn, JSON.stringify(st1c));
    const rel1 = json(await waitFor(/TESTSHOT card released (\{"seq":1,.*\})/, 12000) || []);
    check('#1: let go, the card timed out by itself, and its frozen frame was released (the sidecar freed it and deleted its BMP)',
      rel1 && rel1.why === 'timeout' && rel1.released === true && rel1.filesDeleted >= 1 && rel1.saved === true, JSON.stringify(rel1));
    if (s1 && !s1.path && sv1) { s1.path = sv1.path; s1.name = sv1.name; s1.x = sv1.x; s1.y = sv1.y; }   // the pixel checks below read the file Save wrote
    check('#1: the overlay page said ready before the timeout', r1 && r1.ready.length >= 1 && /painted/.test(r1.how), JSON.stringify(r1 && { how: r1.how, n: r1.ready.length }));
    if (r1 && s1 && p1 && r1.ready[0]) {
      const rd = r1.ready[0];
      check('#1: the page is the monitor exact size in CSS px (physical / scale, no stray rows)', Math.abs(rd.view.w * rd.dpr - rd.natural.w) < 0.5 && Math.abs(rd.view.h * rd.dpr - rd.natural.h) < 0.5, JSON.stringify(rd));
      const want = G.cssToPhys(G.normRect(100.4, 80.6, 740.3, 420.9), { x: 0, y: 0, w: rd.natural.w, h: rd.natural.h }, rd.view);
      check('#1: the frame is decoded at the monitor\'s PHYSICAL size in a page of its CSS size', rd.natural.w > 0 && Math.abs(rd.natural.w / rd.view.w - rd.dpr) < 0.01, JSON.stringify(rd));
      check('#1: the saved rect is geometry.cssToPhys of the drag (DPI-correct)', s1.w === want.w && s1.h === want.h, JSON.stringify({ got: [s1.w, s1.h], want }));
      check('#1: the name is Windows\' pattern', /^Screenshot \d{4}-\d{2}-\d{2} \d{6}( \(\d+\))?\.png$/.test(s1.name), s1.name);
      check('#1: the clipboard (test sink) got the same size, and Owen\'s clipboard nothing', s1.copied && s1.clip && s1.clip.w === s1.w && s1.clip.h === s1.h, JSON.stringify(s1.clip));
      // The live bug the sink hid (2026-09-24): Electron 44 has no clipboard.writeImage. The copy is
      // now the sidecar's (shot.copy, lane shotspeed): a CF_DIB from the frame, no PNG decode/encode here.
      check('#1: the copy went through the sidecar (shot.copy) as a CF_DIB (dryRun in a test)', !!(s1.clip && s1.clip.via === 'shot.copy' && s1.clip.format === 'CF_DIB' &&
        s1.clip.bytes === 40 + s1.w * 4 * s1.h), JSON.stringify(s1.clip));
      check('#1: the clipboard was ready before the save (copied ms <= card ms)', !!(s1.T && s1.T.copied <= s1.T.card), JSON.stringify(s1.T));
      if (s1.clip && s1.clip.dumped && fs.existsSync(s1.clip.dumped)) {
        const b = fs.readFileSync(s1.clip.dumped);
        const off = b.readUInt32LE(10);
        let badD = 0, nD = 0, alphaD = 0;
        for (let y = 0; y < s1.h; y += 13) for (let x = 0; x < s1.w; x += 19) {
          nD++;
          const o = off + (s1.h - 1 - y) * s1.w * 4 + x * 4;          // bottom-up rows
          const e = pixel(s1.x + x, s1.y + y);
          if (b[o + 2] !== e[0] || b[o + 1] !== e[1] || b[o] !== e[2]) badD++;
          if (b[o + 3] !== 255) alphaD++;
        }
        check(`#1: every sampled pixel of the clipboard's DIB is the saved rect's (${nD} sampled, fourth byte 255)`, badD === 0 && alphaD === 0 &&
          b.readInt32LE(18) === s1.w && b.readInt32LE(22) === s1.h, `${badD} wrong, ${alphaD} not opaque`);
      } else check('#1: the test copy dumped its DIB', false, JSON.stringify(s1.clip));
      // pixels: the synthetic pattern at the saved rect's VIRTUAL position
      const png = decodePng(fs.readFileSync(s1.path), zlib);
      let bad = 0, n = 0;
      for (let y = 0; y < png.h; y += 17) for (let x = 0; x < png.w; x += 23) { n++; const px = png.px(x, y); const e = pixel(s1.x + x, s1.y + y); if (px[0] !== e[0] || px[1] !== e[1] || px[2] !== e[2] || px[3] !== 255) bad++; }
      check(`#1: every sampled pixel of the saved PNG is the frozen frame's at that position (${n} sampled)`, bad === 0, `${bad} wrong`);
    }
    check('#1: the copy and the file are the same pixels (both match the frozen frame at the box Save cut)', !!(sv1 && s1.clip && s1.clip.dumped) && !failures.some((f) => /^#1: every sampled pixel/.test(f)));

    // 2: PrintScreen, Window mode, a click at the top-left.
    second(['--test-chord=PrintScreen']);
    const s2 = json(await waitFor(/TESTSHOT #2 saved (\{.*\})/, 15000) || []);
    check('#2 autoSave on (the old behaviour): the capture was saved by itself, and copied', s2 && s2.autoSave === true && s2.copied && s2.path && s2.path.startsWith(outDir) && fs.existsSync(s2.path), JSON.stringify(s2 && { path: s2.path, autoSave: s2.autoSave, saveError: s2.saveError }));
    check('#2: its card says it was saved (no Save offered)', !!await waitFor(/TESTSHOT card shown \{"w":\d+,"h":\d+,"saved":true,"copied":true,"canSave":false/, 5000));
    check('#2 PrintScreen: Window mode saved the window (or desktop) under the click', s2 && (s2.kind === 'window' || s2.kind === 'desktop') && s2.mode === 'window' && s2.w > 0 && s2.h > 0, JSON.stringify(s2 && { kind: s2.kind, w: s2.w, h: s2.h }));

    // 3: Full screen by keyboard.
    second(['--test-chord=Win+Shift+S']);
    const s3 = json(await waitFor(/TESTSHOT #3 saved (\{.*\})/, 15000) || []);
    const n3 = pngs().length;
    check('#3 autoSave off again: copied only, no new file', s3 && s3.autoSave === false && s3.copied && !s3.path && n3 === 2, JSON.stringify({ s3: s3 && { path: s3.path, autoSave: s3.autoSave }, pngs: n3 }));
    check('#3: Full screen + Enter cut the whole monitor', s3 && s3.kind === 'monitor' && r1 && r1.ready[0] && s3.w === r1.ready[0].natural.w && s3.h === r1.ready[0].natural.h && s3.via === 'keyboard', JSON.stringify(s3 && { w: s3.w, h: s3.h, via: s3.via }));

    // 4: the real grab, timed, then Esc.
    second(['--test-chord=Win+Shift+S']);
    const r4 = json(await waitFor(/TESTSHOT #4 ready (\{.*\})/, 15000) || []);
    const c4 = json(await waitFor(/TESTSHOT #4 cancelled (\{.*\})/, 10000) || []);
    check('#4: a real grab reached the overlay and Esc cancelled it (nothing saved)', r4 && c4 && c4.why === 'Esc' && !/TESTSHOT #4 saved/.test(out), JSON.stringify(c4));
    if (r4) console.log(`  REAL chord -> overlay ready: grab ${r4.grabMs} ms, frame decode ${r4.ready.map((x) => x.decodeMs).join('/')} ms, ready ${r4.shownMs} ms after the chord (hidden test windows wait on a 250 ms timer, not a paint: ${r4.ready.map((x) => x.how).join(', ')})`);

    // 5: keyboard only.
    second(['--test-chord=Win+Shift+S']);
    const s5 = json(await waitFor(/TESTSHOT #5 saved (\{.*\})/, 15000) || []);
    if (s5 && r1 && r1.ready[0]) {
      const sc = r1.ready[0].natural.w / r1.ready[0].view.w;
      check('#5: keyboard only (R, Enter, Shift+arrows, Enter) saved 250 x 120 CSS px at the monitor scale', s5.via === 'keyboard' &&
        Math.abs(s5.w - 250 * sc) <= 1 && Math.abs(s5.h - 120 * sc) <= 1, JSON.stringify({ w: s5.w, h: s5.h, sc }));
    } else check('#5: keyboard-only capture saved', false, out.slice(-500));
    // ...and its Save (Ctrl+S on the card) goes to a folder that cannot be made: NO SILENT FAILURE.
    const sf5 = json(await waitFor(/TESTSHOT card not saved (\{.*\})/, 10000) || []);
    check('#5: a Save that fails answers in plain words (no path, code or command)', sf5 && sf5.seq === 5 && /^the screenshots folder could not be reached/.test(sf5.reason) &&
      !/[A-Z]:\\|shot\.|Exception|0x[0-9A-F]/.test(sf5.reason), JSON.stringify(sf5));
    const st5 = json(await waitFor(/TESTSHOT card state #5 (\{.*\})/, 5000) || []);
    check('#5: the card stays, says "Not saved: <why>", and offers Try again', st5 && st5.shown && !st5.gone && /^Not saved: the screenshots folder could not be reached/.test(st5.warn) &&
      st5.save && st5.save.label === 'Try again' && !st5.save.disabled && st5.title === 'Screenshot copied', JSON.stringify(st5));
    const rel5 = json(await waitFor(/TESTSHOT card released (\{"seq":5,.*\})/, 5000) || []);
    check('#5: Esc put the card away and released its frame; nothing was written', rel5 && rel5.why === 'Esc' && rel5.released === true && rel5.saved === false && pngs().length === 2, JSON.stringify({ rel5, pngs: pngs() }));

    // 6 + 7: a capture left open, then a second Win+Shift+S. It must NOT be "ignored" (the live bug).
    second(['--test-chord=Win+Shift+S']);
    check('#6: a capture came up and was left open', !!await waitFor(/TESTSHOT #6 ready/, 15000));
    second(['--test-chord=Win+Shift+S']);
    const rp6 = json(await waitFor(/TESTSHOT #6 replaced (\{.*\})/, 5000) || []);
    check('#7: a second chord on a stuck capture replaces it (never "ignored")', !!rp6 && /not in front/.test(rp6.why) && !/ignored: capture/.test(out), JSON.stringify(rp6));
    // 7: the REAL reveal (SetWindowPos TOPMOST|SHOWWINDOW|NOACTIVATE, full size, 1 px on screen), measured.
    const fb7 = json(await waitFor(/TESTSHOT #7 fallback (\{.*\})/, 8000) || []);
    const f7 = fb7 && fb7.facts && fb7.facts[0];
    check('#7 measured: the overlay window is visible and not cloaked', !!f7 && f7.visible === true && f7.cloaked === 0, JSON.stringify(fb7));
    check('#7 measured: its rect is exactly where it was put (full monitor size)', !!f7 && !!f7.rect && !!r1 && Math.abs(f7.rect.w - r1.ready[0].natural.w) <= 1 && Math.abs(f7.rect.h - r1.ready[0].natural.h) <= 1, JSON.stringify(f7 && f7.rect));
    if (process.env.MANTLE_TEST_VISIBLE === '1') {
      check('#7 measured: a click on its on-screen pixel lands on it (top of the z-order there)', !!f7 && f7.hitUs === true, JSON.stringify(f7));
      check('#7 measured: its PIXELS are on the screen (the canary was read back off the glass)', !!fb7 && !!fb7.pixels && fb7.pixels.pixelsSeen === true, JSON.stringify(fb7 && fb7.pixels));
    } else {
      // A quiet run (lib/test-quiet.js, r8-quiet 2026-10-01): the overlay is up but at alpha 0 and click-through,
      // so Owen never sees it or loses a click to it. Mantle's own measurement must say exactly that.
      check('#7 measured (quiet run): a click on its pixel goes THROUGH it (Owen keeps his clicks)', !!f7 && f7.hitUs === false, JSON.stringify(f7));
      check('#7 measured (quiet run): none of its pixels reach the screen (the canary is NOT read back)', !!fb7 && !!fb7.pixels && fb7.pixels.pixelsSeen === false, JSON.stringify(fb7 && fb7.pixels));
      skipped.push('#7 measured ON THE GLASS (a click lands on it, its pixels are seen): run with MANTLE_TEST_VISIBLE=1 while Owen is away');
    }
    check('#7 safety: the test overlay never became the foreground', !!f7 && f7.fgUs === false);
    if (fb7) console.log(`  #7 MEASURED reveal (1 px on screen, no focus asked): ${JSON.stringify({ facts: fb7.facts, pixels: fb7.pixels, why: fb7.why })}`);
    check('#7: no keyboard (a test never takes it) -> not verified -> the fallback, with the reason', !!fb7 && /keyboard/.test(fb7.why) && fb7.inARow === 1 && !/TESTSHOT #7 verified/.test(out), fb7 && fb7.why);
    check('#7: the fallback card was shown (Windows\' snip is NOT opened in a test)', !!await waitFor(/TESTSHOT card shown \{"w":\d+,"h":\d+,"saved":false,"copied":false,"canSave":false,/, 5000) && /could not come forward within 800 ms.*would open Windows' Snipping Tool/.test(out));
    // 8: the overlay loses the keyboard.
    second(['--test-chord=Win+Shift+S']);
    const lk8 = json(await waitFor(/TESTSHOT #8 lost keyboard (\{.*\})/, 10000) || []);
    check('#8: losing the keyboard ends the capture, with the reason logged', !!lk8 && /lost the keyboard/.test(lk8.why) && /#8: ended: the overlay lost the keyboard/.test(out), JSON.stringify(lk8));
    // 9: nothing happens -> the hard timeout (6 s in this test, 60 s live).
    second(['--test-chord=Win+Shift+S']);
    const to9 = json(await waitFor(/TESTSHOT #9 timed out (\{.*\})/, 15000) || []);
    check('#9: a capture nobody finishes is ended by the hard timeout', !!to9 && /nothing was selected within 6 s/.test(to9.why), JSON.stringify(to9));
    // 10: a second fallback in a row -> the feature goes down, so the chords are Windows' again.
    second(['--test-chord=Win+Shift+S']);
    const fb10 = json(await waitFor(/TESTSHOT #10 fallback (\{.*\})/, 10000) || []);
    check('#10: a second fallback in a row counts 2', !!fb10 && fb10.inARow === 2, JSON.stringify(fb10 && fb10.inARow));
    check('#10: after 2 in a row the feature says why its chords went back to Windows, and when it takes them back',
      !!await waitFor(/could not come forward 2 times in a row.*Windows' own for now\. Mantle takes them back by itself at \d\d:\d\d:\d\d \(in 8 s, try 1\)/, 5000));
    // waitFor, not out.test(): a line logged right AFTER the one waited for can still be in the pipe
    // (r9-flake: a reader saw the first of two same-tick lines alone 3-9 times in 3000).
    check('#10: the self-healing timer was armed', !!await waitFor(/TESTSHOT down \{"tries":0,"retakeMs":8000\}/, 5000));
    const r11 = second(['--test-chord=Win+Shift+S']);
    await sleep(800);
    check('#11: a chord while down is not delivered to the feature (Windows keeps it)', !/TESTSHOT #11/.test(out) && /Win\+Shift\+S from a second instance: \{"delivered":false/.test(out + (r11.stdout || '')), (out.match(/.*second instance: \{"delivered".*/g) || []).slice(-1)[0]);
    // Self-healing (lane shotfix): the keys come back by themselves, on trial.
    check('retake: the keys come back by themselves when the timer fires (no press needed)', !!await waitFor(/TESTSHOT retake \{"tries":1\}/, 15000));
    check('retake: it says so in words, with the next delay', /took Win\+Shift\+S and PrintScreen back from Windows by itself, 8 s after they went back \(try 1\).*tries again in 3 s/.test(out));
    check('retake: the feature is healthy again, on trial, and says so', !!await waitFor(/screenshot: healthy: Win\+Shift\+S and PrintScreen were taken back from Windows by themselves \(try 1\)/, 5000));
    second(['--test-chord=Win+Shift+S']);
    const fb12 = json(await waitFor(/TESTSHOT #11 fallback (\{.*\})/, 10000) || []);
    check('retake: a press after it is delivered again, and on trial one fallback counts', !!fb12 && fb12.trial === true && fb12.counted === true, JSON.stringify(fb12 && { trial: fb12.trial, counted: fb12.counted }));
    check('retake: one failure on trial sends the keys back at once, with the next delay', !!await waitFor(/TESTSHOT down \{"tries":1,"retakeMs":3000\}/, 5000) &&
      /still could not come forward after the keys were taken back \(try 1; last: .*\), so Win\+Shift\+S and PrintScreen are Windows' own for now.*\(in 3 s, try 2\)/.test(out));
    check('retake: and the backoff keeps trying', !!await waitFor(/TESTSHOT retake \{"tries":2\}/, 10000));

    check('electron: no keyboard hook was asked for', !/features: keys .*taking/.test(out));
    const frameDir = path.join(os.tmpdir(), 'mantle-shot');
    second(['--quit']);
    const t = Date.now() + 30000;
    while (Date.now() < t && !exited) await sleep(150);
    check('electron: --quit ends the instance', !!exited, out.slice(-500));
    const left = fs.existsSync(frameDir) ? fs.readdirSync(frameDir).filter((f) => /^mantle-shot-.*\.bmp$|^clip-/.test(f)) : [];
    check('electron: no frozen frame outlives the instance', left.length === 0, left.join(','));
    check('electron: no uncaught exception', !/uncaught exception|RESTORE INCOMPLETE/.test(out));
    const err = out.match(/.*screenshot.*(failed|threw|crash).*/i);
    check('electron: no screenshot handler failed', !err, err && err[0]);
  } finally {
    if (!exited) spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'tools', 'kill-test.ps1'), '-Match', PROFILE], { encoding: 'utf8' });
    try { toback.kill(); } catch (_) { /* done */ }
    try { fs.rmdirSync(slot); } catch (_) { /* someone removed it */ }
    try { fs.rmSync(outDir, { recursive: true, force: true }); } catch (_) { /* temp */ }
    check('electron: the test captures were deleted', !fs.existsSync(outDir));
    fs.writeFileSync(path.join(os.tmpdir(), 'mantle-shot-e2e.log'), out.split('\n').filter((l) => /screenshot|features|error|sidecar/i.test(l)).join('\n'));
  }
}

/* ---- COPY TEXT END TO END (node lib/features/screenshot.test.js --electron-text; ocr lane) ---------
 * One Electron --test instance (profile screenshot-text) with this lane's sidecar. The frames are
 * SYNTHETIC with known text drawn in (Screenshot.cs DrawSyntheticText): never Owen's screen. The
 * clipboard is the feature's DRY RUN sink; the test names the text it drew (MANTLE_SHOT_TEST_EXPECT)
 * and the feature reports only how close it came. The log is then searched for the drawn words:
 * none may be there. Nothing is written to disk by this test. */
async function electronTextCheck() {
  const fs = require('fs');
  const os = require('os');
  const { spawn, spawnSync } = require('child_process');
  const ROOT = path.join(__dirname, '..', '..');
  const PROFILE = 'screenshot-text';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const exe = process.env.MANTLE_SIDECAR_EXE;
  if (!exe || !fs.existsSync(exe)) { check('electron: MANTLE_SIDECAR_EXE names a built exe', false, exe); return; }
  const games = Number(spawnSync('powershell', ['-NoProfile', '-Command',
    '@(Get-Process javaw,Minecraft*,RobloxPlayerBeta,*Riot*,VALORANT* -ErrorAction SilentlyContinue).Count'], { encoding: 'utf8' }).stdout.trim()) || 0;
  if (games) { check('electron: no game running (not launching an instance)', false, games); return; }
  let slot = null;
  for (let tries = 0; tries < 20 && !slot; tries++) {
    for (const n of [1, 2]) {
      const d = path.join(os.tmpdir(), `mantle-slot-${n}`);
      try { fs.mkdirSync(d); slot = d; break; } catch (_) { /* taken */ }
    }
    if (!slot) { console.log('  (both test slots taken; waiting 30 s)'); await sleep(30000); }
  }
  if (!slot) { check('electron: a test slot was free within 10 minutes', false); return; }

  const LINES = ['Question 7: A train leaves the station at 3:45 PM', 'traveling 62 miles per hour. How far has it gone', 'by 6:15 PM? Show your work (round to 0.1 mi).'];
  const WORDS = /train leaves|miles per hour|Show your work|Question 7/;
  const drawn = { synthetic: true, text: LINES, textAt: { x: 60, y: 60 }, textPx: 16, textPad: 400 };
  const steps = [
    Object.assign({ mode: 'text', drag: [10, 10, 560, 200] }, drawn),     // 1 a drag over the text
    Object.assign({ mode: 'text', drag: [20, 140, 300, 240] }, drawn),    // 2 a drag over white below it: nothing
    { synthetic: true, mode: 'rect', keys: ['t'], key: 'Escape' },        // 3 T picks Copy text; Esc
    { synthetic: true, key: 'Escape' },                                   // 4 the next capture: NOT Copy text
  ];
  const cli = require.resolve('electron/cli.js', { paths: [ROOT] });
  const env = Object.assign({}, process.env, { MANTLE_SIDECAR_EXE: exe, MANTLE_SHOT_TEST: JSON.stringify(steps), MANTLE_SHOT_TEST_EXPECT: LINES.join('\n') });
  let out = '';
  const proc = spawn(process.execPath, [cli, '.', '--test', `--profile-name=${PROFILE}`], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout.on('data', (c) => { out += c.toString('utf8'); });
  proc.stderr.on('data', (c) => { out += c.toString('utf8'); });
  let exited = null;
  proc.on('exit', (code) => { exited = { code, at: Date.now() }; });
  const toback = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'tools', 'toback.ps1'), '-Match', PROFILE, '-WaitSec', '60'], { stdio: 'ignore' });
  const waitFor = async (re, ms) => { const t = Date.now() + ms; while (Date.now() < t) { const m = out.match(re); if (m) return m; if (exited) return null; await sleep(150); } return null; };
  const envMsg = Object.assign({}, env, { LOWCPU: '0' });
  const second = (args) => spawnSync(process.execPath, [cli, '.', '--test', `--profile-name=${PROFILE}`].concat(args), { cwd: ROOT, env: envMsg, encoding: 'utf8', timeout: 30000 });
  const json = (m) => { try { return JSON.parse(m[1]); } catch (_) { return null; } };
  try {
    check('electron: the screenshot feature installs', !!await waitFor(/screenshot: saves go to a %TEMP% test folder/, 60000), out.slice(-800));
    const ready = await waitFor(/screenshot: Copy text: Windows' OCR is ready \(([^;]+); installed: ([^)]*)\)/, 20000);
    check('electron: Copy text finds Windows\' OCR at start-up and says its language', !!ready, (out.match(/.*Copy text.*/) || [])[0]);
    if (ready) console.log(`  OCR at start-up: engine ${ready[1]}, installed ${ready[2]}`);

    second(['--test-chord=Win+Shift+S']);
    const t1 = json(await waitFor(/TESTSHOT #1 text (\{.*\})/, 20000) || []);
    check('#1: a drag over the text read 3 lines and copied them (dry run: the sink, not the clipboard)', !!t1 && t1.lines === 3 && t1.copied === true && !t1.textError, JSON.stringify(t1));
    check('#1: a live copy has a clipboard call that exists in this Electron (writeText)', !!t1 && !!t1.clip && t1.clip.via === 'writeText', JSON.stringify(t1 && t1.clip));
    check('#1: recognised vs drawn: at least 97% of characters right', !!t1 && !!t1.clip && t1.clip.similarity >= 0.97, JSON.stringify(t1 && t1.clip));
    if (t1) console.log(`  #1 Copy text: ${t1.lines} lines, ${t1.chars} chars, similarity ${t1.clip && t1.clip.similarity}, exact ${t1.clip && t1.clip.exact}; ${t1.ms} ms from the selection (OCR ${t1.ocrMs} ms at ${t1.scale}x, ${t1.lang}), rect ${t1.rect.w}x${t1.rect.h}`);
    check('#1: the log line is counts and timings', /#1: ocr: 3 lines, \d+ chars, \d+ ms \(ocr \d+ ms at 2x, [a-z]{2}-[A-Z]{2}; \d+x\d+, pointer\); copied/.test(out), (out.match(/.*#1: ocr.*/) || [])[0]);
    check('#1: the card came up, copied, nothing saved, and no Save (Copy text never makes a file)', !!await waitFor(/TESTSHOT card shown \{"w":\d+,"h":\d+,"saved":false,"copied":true,"canSave":false,/, 5000));

    second(['--test-chord=Win+Shift+S']);
    const t2 = json(await waitFor(/TESTSHOT #2 text (\{.*\})/, 20000) || []);
    check('#2: a drag over no text: 0 lines, nothing copied, no error', !!t2 && t2.lines === 0 && t2.copied === false && !t2.textError && !t2.copyError && t2.clip === null, JSON.stringify(t2));
    check('#2: its log line says nothing was copied', /#2: ocr: 0 lines, 0 chars, \d+ ms .*; nothing copied/.test(out), (out.match(/.*#2: ocr.*/) || [])[0]);

    second(['--test-chord=Win+Shift+S']);
    const p3 = json(await waitFor(/TESTSHOT #3 played (\{.*\})/, 15000) || []);
    const c3 = json(await waitFor(/TESTSHOT #3 cancelled (\{.*\})/, 10000) || []);
    check('#3: T picks Copy text in the overlay, Esc cancels', !!p3 && p3.mode === 'text' && !!c3 && c3.why === 'Esc', JSON.stringify({ p3: p3 && p3.mode, c3 }));

    second(['--test-chord=Win+Shift+S']);
    const p4 = json(await waitFor(/TESTSHOT #4 played (\{.*\})/, 15000) || []);
    check('#4: the next capture opens as a screenshot again (Copy text is never remembered)', !!p4 && p4.mode === 'rect', JSON.stringify(p4 && p4.mode));
    await waitFor(/TESTSHOT #4 cancelled/, 10000);

    check('PRIVACY: none of the drawn text is anywhere in the log', !WORDS.test(out), '(a drawn word is in the log)');
    const frameDir = path.join(os.tmpdir(), 'mantle-shot');
    second(['--quit']);
    const t = Date.now() + 30000;
    while (Date.now() < t && !exited) await sleep(150);
    check('electron: --quit ends the instance', !!exited, out.slice(-500));
    const left = fs.existsSync(frameDir) ? fs.readdirSync(frameDir).filter((f) => /^mantle-shot-.*\.bmp$|^clip-/.test(f)) : [];
    check('electron: no frozen frame outlives the instance', left.length === 0, left.join(','));
    check('electron: no uncaught exception', !/uncaught exception|RESTORE INCOMPLETE/.test(out));
    const err = out.match(/.*screenshot.*(failed|threw|crash).*/i);
    check('electron: no screenshot handler failed', !err, err && err[0]);
  } finally {
    if (!exited) spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'tools', 'kill-test.ps1'), '-Match', PROFILE], { encoding: 'utf8' });
    try { toback.kill(); } catch (_) { /* done */ }
    try { fs.rmdirSync(slot); } catch (_) { /* someone removed it */ }
  }
}

/** A minimal PNG decoder (8-bit RGB/RGBA): [r,g,b,a] per pixel. */
function decodePng(b, zlib) {
  let p = 8, w = 0, h = 0, ctype = 0;
  const idat = [];
  while (p < b.length) {
    const len = b.readUInt32BE(p), type = b.toString('latin1', p + 4, p + 8), data = b.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); ctype = data[9]; }
    if (type === 'IDAT') idat.push(data);
    p += 12 + len;
  }
  const bpp = ctype === 6 ? 4 : 3, stride = w * bpp, raw = zlib.inflateSync(Buffer.concat(idat)), img = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x], a = x >= bpp ? img[y * stride + x - bpp] : 0, up = y ? img[(y - 1) * stride + x] : 0, c = x >= bpp && y ? img[(y - 1) * stride + x - bpp] : 0;
      let o = v;
      if (f === 1) o += a; else if (f === 2) o += up; else if (f === 3) o += (a + up) >> 1;
      else if (f === 4) { const pp = a + up - c, pa = Math.abs(pp - a), pb = Math.abs(pp - up), pc = Math.abs(pp - c); o += pa <= pb && pa <= pc ? a : pb <= pc ? up : c; }
      img[y * stride + x] = o & 255;
    }
  }
  return { w, h, px(x, y) { const o = y * stride + x * bpp; return [img[o], img[o + 1], img[o + 2], bpp === 4 ? img[o + 3] : 255]; } };
}

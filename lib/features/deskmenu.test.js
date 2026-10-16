'use strict';
// lib/features/deskmenu.js, the pure parts (lane mantle-deskmenu): where the menu goes, which window the
// desktop page may open, the window's options, the percentile, and the source rules that keep the open
// path fast and honest. node lib/features/deskmenu.test.js -> "DESKMENU UNIT TEST: n passed, m failed"
const fs = require('fs');
const path = require('path');
const Module = require('module');

let passed = 0;
const failures = [];
const check = (name, ok, detail) => { if (ok) passed++; else failures.push(`  FAIL ${name}${detail !== undefined ? ` (${JSON.stringify(detail).slice(0, 300)})` : ''}`); return ok; };

// the module needs electron only inside install(); a stub is enough for the pure parts
const realLoad = Module._load;
Module._load = function (req, parent, isMain) {
  if (req === 'electron') return { screen: {}, BrowserWindow: { getAllWindows: () => [] } };
  return realLoad.call(this, req, parent, isMain);
};
const D = require('./deskmenu');
Module._load = realLoad;

const area = { x: 0, y: 0, width: 1920, height: 1032 };
const sz = { w: 264, h: 250 };
let b = D.place({ x: 500, y: 400 }, sz, 10, area);
check('middle of the screen: the panel corner on the cursor (window offset by the inset)', b.x === 490 && b.y === 390 && b.width === 264 && b.height === 250, b);
b = D.place({ x: 1900, y: 400 }, sz, 10, area);
check('near the right edge: flipped left of the cursor', b.x === 1900 - 264 + 10 && b.x + b.width <= 1920, b);
b = D.place({ x: 500, y: 1020 }, sz, 10, area);
check('near the bottom: flipped above the cursor, inside the work area', b.y === 1020 - 250 + 10 && b.y + b.height <= 1032, b);
b = D.place({ x: 1915, y: 1030 }, sz, 10, area);
check('bottom-right corner: both flips, never outside', b.x + b.width <= 1920 && b.y + b.height <= 1032 && b.x >= 0 && b.y >= 0, b);
b = D.place({ x: 2, y: 2 }, sz, 10, area);
check('top-left: clamped into the area (not at -8)', b.x === 0 && b.y === 0, b);
b = D.place({ x: 2500, y: 300 }, sz, 10, { x: 1920, y: 0, width: 1280, height: 1024 });
check('a second display: stays on it', b.x >= 1920 && b.x + b.width <= 3200, b);
b = D.place({ x: -30000, y: -30000 }, sz, 10, null);
check('a point on no display (a test stand-in): placed as asked, off screen', b.x === -30010 && b.y === -30010, b);
b = D.place({ x: 10.6, y: 20.2 }, { w: 263.2, h: 249.1 }, 10, area);
check('whole pixels', Number.isInteger(b.x) && Number.isInteger(b.y) && b.width === 264 && b.height === 250, b);

check('the menu window may be opened', D.openVerdict({ url: 'about:blank', frameName: D.NAME }).ok === true);
check('...with an empty address too', D.openVerdict({ url: '', frameName: D.NAME }).ok === true);
const deny = [
  { url: 'https://example.com', frameName: D.NAME },
  { url: 'about:blank', frameName: 'other' },
  { url: 'file:///C:/x.html', frameName: D.NAME },
  { url: 'about:blank' },
  null,
];
for (const d of deny) check(`refused: ${JSON.stringify(d)}`, D.openVerdict(d).ok === false && /Mantle pages open none/.test(D.openVerdict(d).why));
check('refusal names the scheme, never the address', /\(https:\)/.test(D.openVerdict(deny[0]).why) && !/example/.test(D.openVerdict(deny[0]).why));

const o = D.popupOptions();
check('menu window: hidden until placed, no frame, no taskbar, never takes the keyboard, on top', o.show === false && o.frame === false && o.skipTaskbar === true && o.focusable === false && o.alwaysOnTop === true && o.transparent === true);

check('pct', D.pct([5, 1, 3, 2, 4], 0.5) === 3 && D.pct([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.95) === 10 && D.pct([], 0.95) === null && D.pct([NaN, 7], 0.5) === 7);
check('rest: true (the hook is out while a game runs); on by default', D.rest === true && D.defaultOn === true);
check('kept at most a minute after its last use', D.KEEP_MS === 60000);

// the open path: no awaited sidecar call or sendSync before the menu is shown (plan R3)
const src = fs.readFileSync(path.join(__dirname, 'deskmenu.js'), 'utf8');
const onOpen = src.slice(src.indexOf('function onOpen('), src.indexOf('function onFallback('));
check('onOpen awaits nothing (no sidecar wait on the open path)', onOpen.length > 100 && !/await\b/.test(onOpen) && !/sendSync/.test(onOpen));
const placeCmd = src.slice(src.indexOf("ctx.command('place'"), src.indexOf("ctx.command('painted'"));
check('place shows the window before it acks the helper, and the ack is not awaited', /showInactive\(\)/.test(placeCmd) && placeCmd.indexOf('showInactive') < placeCmd.indexOf('ack(seq)') && !/await ctx\.sidecar/.test(placeCmd));
check('one truthful log line per open (warm|cold, shown, painted, interactive)', /opened \(\$\{showing\.warm \? 'warm' : 'cold'\}\) via right-click: shown .*painted .*interactive/.test(src));
const page = fs.readFileSync(path.join(__dirname, '..', '..', 'ui', 'desktop', 'deskmenu.js'), 'utf8');
check('the page opens only the named about:blank window', /window\.open\('about:blank', NAME, 'popup'\)/.test(page) && /const NAME = 'mantle-deskmenu'/.test(page));
check('the page runs the Wallpapers and Settings commands with their pages', /M\.call\('wallpaper\.open'\)/.test(page) && /section: 'display'/.test(page) && /section: 'personalization'/.test(page));

console.log(`DESKMENU UNIT TEST: ${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log(f);
process.exitCode = failures.length || !passed ? 1 : 0;

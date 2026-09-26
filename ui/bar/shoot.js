/* shoot.js — headless screenshots of the bar, for eyeballing it without running Electron.
 *
 * LINE 1 below is not optional: lowcpu.js pins this process (and every browser it spawns) to a
 * few cores at below-normal priority and takes a machine-wide lock so only one headless browser
 * runs at a time. Owen's machine has been pegged by unguarded Chromium before; a run that skips
 * this file is a rule break, not a shortcut.
 *
 *   node ui/bar/shoot.js              every shot below
 *   node ui/bar/shoot.js media tray   only the shots whose name contains one of the words
 *
 * BAR_TRAY_JSON=<file> hands the mock a REAL tray listing (a JSON array in the sidecar's `tray`
 * shape, or a probe dump whose [1].result is one) through window.__MOCK_TRAY__, so real icons can
 * be eyeballed without committing anybody's tray to the repo. BAR_EXTRA_CSS=<css> adds a style to
 * every shot, for an A/B of a treatment that is not in bar.css (BAR_SUFFIX=-b names the files).
 */
require('C:/Users/user/dev-tools/tools/lowcpu.js');

const fs = require('fs');
const path = require('path');
const os = require('os');

/* playwright-core is not a dependency of this repo (the bar ships no node code), so we borrow the
   one already installed on the machine, and say plainly which candidates were tried if none is
   there — a "cannot find module" stack would not tell anyone what to install. */
const PW_CANDIDATES = [
  'C:/Users/user/other-app/node_modules/playwright-core',
  'C:/Users/user/Downloads/other-app/node_modules/playwright-core',
  'playwright-core'
];
let chromium = null, pwFrom = '';
for (const c of PW_CANDIDATES) {
  try { chromium = require(c).chromium; pwFrom = c; break; } catch (e) { /* try the next one */ }
}
if (!chromium) {
  console.error('FAILED: playwright-core not found. Tried:\n  ' + PW_CANDIDATES.join('\n  '));
  process.exit(1);
}

/* The browser binary: the newest ms-playwright chromium already downloaded on this machine.
   Never a download, never the system Chrome. */
function findChrome() {
  const base = 'C:/Users/user/AppData/Local/ms-playwright';
  for (const d of fs.readdirSync(base).filter(n => n.startsWith('chromium-')).sort().reverse())
    for (const sub of ['chrome-win/chrome.exe', 'chrome-win64/chrome.exe']) {
      const p = path.join(base, d, sub);
      if (fs.existsSync(p)) return p;
    }
  return null;
}

const OUT = process.env.BAR_SHOTS ||
  'C:/Users/user/AppData/Local/Temp/claude/C--Users-owens/edd3247c-6214-4642-9069-bbf7e50b1555/scratchpad/lanes/bar';
const PAGE = 'file:///C:/Users/user/mantle/ui/bar/index.html';

/* Step sequences for the quick-settings sub-views (qs-more.js): open the panel from the Wi-Fi
   readout, take the tile's '>' and let the mock's scan finish; or take the volume row's '>'. */
const WIFI = ['#network', '.qsx-chev', { wait: 1300 }];
const net = (ssid) => '.qsx-net[data-ssid="' + ssid + '"] .qsx-nethead';
const PASSWORD = WIFI.concat([net('Cafe WiFi'), '.qsx-net.open .qsx-btn.acc', { fill: '#qsxpw', text: 'not-a-real-key' }]);
const SOUND = ['#volume', '.qsx-more', { wait: 600 }];
/* Bluetooth (2026-09-23): the Bluetooth tile's '>' (the grid's SECOND chevron, so it is named by
   its title), with ?bt=<preset> from mock-mantle.js. A row opens by its name; .acc is Connect. */
const BTV = ['#network', '.qsx-chev[title="Show Bluetooth devices"]', { wait: 500 }];
const btRow = (name) => '.qsx-bt[data-bt="' + name + '"] .qsx-nethead';
const BT_CONNECT = BTV.concat([btRow('JBL Flip 6'), '.qsx-net.open .qsx-btn.acc']);
/* The battery (2026-09-23): every state the readout and the panel's footer can be in, from the
   readings the sidecar sends (?battery=<name>, mock-mantle.js). `plugged` is on AC and NOT
   charging (a charge limit): a plug, never a bolt. `none` has no readout, so its panel is opened
   from the Wi-Fi glyph. The 900 ms lets the pill's entrance finish before anything is clicked. */
const BATT = ['charging', 'plugged', 'full', 'battery', 'unplugged', 'saver', 'unknown', 'error', 'none'];

/* Each shot is one state worth looking at, not one size for its own sake. */
/* The Spotify queue's fit probe (spq-* shots): the room the open media card needs (bar.js asks
   main for pop.offsetHeight + 16), whether it is within main's 480 px cap, and how many queue rows
   are FULLY visible inside the list's own scroll box. A miss is logged as a console error. */
const SPQ_FIT = `(() => {
  const p = document.querySelector('.pop.mcard');
  if (!p || p.hidden) return { error: 'no media card open' };
  const need = p.offsetHeight + 16, r = p.getBoundingClientRect();
  const q = document.querySelector('.spq'), sc = document.querySelector('.spq-scroll');
  const out = { need, room: 480, fits: need <= 480, cardTop: Math.round(r.top), queue: !!(q && !q.hidden), open: !!(q && q.classList.contains('open')) };
  if (out.open && sc) {
    const sr = sc.getBoundingClientRect(), rows = Array.from(sc.querySelectorAll('.spq-row'));
    out.rows = rows.length;
    out.rowsFullyVisible = rows.filter((x) => { const b = x.getBoundingClientRect(); return b.top >= sr.top - 0.5 && b.bottom <= sr.bottom + 0.5; }).length;
    out.listPx = Math.round(sr.height); out.scrolls = sc.scrollHeight > sc.clientHeight + 1;
  }
  if (!out.fits || out.cardTop < 0) console.error('SPQ CLIPPED: ' + JSON.stringify(out));
  return out;
})()`;

const SHOTS = [
  { name: 'bar-1920', w: 1920, h: 44, q: '' },
  { name: 'bar-1920-bg', w: 1920, h: 44, q: '?bg=1' },   // loud wallpaper: is the glass actually letting it through?
  { name: 'bar-1280', w: 1280, h: 44, q: '' },
  { name: 'bar-1280-20win', w: 1280, h: 44, q: '?windows=20' },
  { name: 'bar-1920-down', w: 1920, h: 44, q: '?state=down' },
  /* now playing (2026-09-22): the chip, then the card open over a taller page (the popover floats
     above the bar, so a 44px viewport would crop it), in each state the card has to get right */
  { name: 'media-chip', w: 1280, h: 60, q: '?mode=pill&media=playing' },
  { name: 'media-compact', w: 1000, h: 60, q: '?mode=pill&media=playing' },   // too narrow: the title gives way
  { name: 'media-card', w: 1280, h: 330, q: '?mode=pill&media=playing', click: '#mchip' },
  { name: 'media-noctl', w: 1280, h: 330, q: '?mode=pill&media=noctl', click: '#mchip' },
  /* LessonPlayer alone: NO chip (Owen's call, 2026-09-22), so nothing is clicked: the shot proves absence */
  { name: 'media-lessonplayer', w: 1280, h: 60, q: '?mode=pill&media=lessonplayer' },
  { name: 'media-both', w: 1280, h: 480, q: '?mode=pill&media=both', click: '#mchip' },   // 480: + the collapsed Up next row (spotq), 400 cut the card's top off in the SHOT
  /* LessonPlayer picked in the switcher while a player also plays: the controls-off card */
  { name: 'media-lessonplayer-picked', w: 1280, h: 480, q: '?mode=pill&media=both&pick=lessonplayer', click: '#mchip' },
  { name: 'media-off', w: 1280, h: 330, q: '?mode=pill&media=off', click: '#more' },   // the chip's reason, in words
  /* Spotify's "Up next" queue (spotq lane, 2026-09-25; ui/bar/spotify.js, ?spq= in the mock). Each
     opens the card, opens the dropdown and PROBES the fit: main gives a popover at most 480 px
     (POPOVER_MAX), so `need` must be <= 480 or the window would cut the card off (the top bar's
     dropdown shipped clipped that way on 2026-09-24). A miss is a console error = a PAGE PROBLEM. */
  ...['queue', 'long', 'noport', 'notrunning', 'checking', 'starting', 'loading', 'empty', 'noplayer', 'error', 'internals', 'portbusy', 'noinstall', 'off'].map((st) => (
    { name: 'spq-' + st, w: 1280, h: 560, q: '?mode=pill&media=playing&spq=' + st, steps: ['#mchip', '.spq-head', { wait: 300 }, { probe: SPQ_FIT }] })),
  { name: 'spq-queue-1x', dsf: 1, w: 1280, h: 560, q: '?mode=pill&media=playing&spq=queue', steps: ['#mchip', '.spq-head', { wait: 300 }, { probe: SPQ_FIT }] },
  { name: 'spq-long-1x', dsf: 1, w: 1280, h: 560, q: '?mode=pill&media=playing&spq=long', steps: ['#mchip', '.spq-head', { wait: 300 }, { probe: SPQ_FIT }] },
  { name: 'spq-long-both', w: 1280, h: 560, q: '?mode=pill&media=both&spq=long', steps: ['#mchip', '.spq-head', { wait: 300 }, { probe: SPQ_FIT }] },   // + the source list: the tallest card
  { name: 'spq-noport-both', w: 1280, h: 560, q: '?mode=pill&media=both&spq=noport', steps: ['#mchip', '.spq-head', { wait: 300 }, { probe: SPQ_FIT }] },   // the Restart state + the source list
  { name: 'spq-lessonplayer', w: 1280, h: 560, q: '?mode=pill&media=both&pick=lessonplayer&spq=queue', steps: ['#mchip', { probe: SPQ_FIT }] },   // LessonPlayer shown: NO Up next row (probe queue:false)
  { name: 'spq-collapsed', w: 1280, h: 420, q: '?mode=pill&media=playing&spq=queue', steps: ['#mchip', { probe: SPQ_FIT }] },
  { name: 'spq-search', w: 1280, h: 560, q: '?mode=pill&media=playing&spq=queue', steps: ['#mchip', '.spq-head', { wait: 300 }, { fill: '.spq-search', text: 'macklemore' }, { wait: 700 }, { probe: SPQ_FIT }] },
  { name: 'spq-played', w: 1280, h: 560, q: '?mode=pill&media=playing&spq=queue', steps: ['#mchip', '.spq-head', { wait: 300 }, '.spq-list > :nth-child(5) .spq-row', { wait: 300 }, { probe: SPQ_FIT }] },   // a Next-up row: the queued ones before it are used up
  /* spotapp lane: the per-row tools (hover), a move up, a remove, an add, the armed Restart, and search unavailable */
  { name: 'spq-tools', keepHover: true, w: 1280, h: 560, q: '?mode=pill&media=playing&spq=queue', steps: ['#mchip', '.spq-head', { wait: 300 }, { hover: '.spq-list > :nth-child(3)' }, { probe: SPQ_FIT }] },
  { name: 'spq-moved', keepHover: true, w: 1280, h: 560, q: '?mode=pill&media=playing&spq=queue', steps: ['#mchip', '.spq-head', { wait: 300 }, { hover: '.spq-list > :nth-child(3)' }, '.spq-list > :nth-child(3) .spq-tool[aria-label="Move up"]', { wait: 300 }, { hover: '.spq-list > :nth-child(2)' }, { probe: SPQ_FIT }] },
  { name: 'spq-removed', w: 1280, h: 560, q: '?mode=pill&media=playing&spq=queue', steps: ['#mchip', '.spq-head', { wait: 300 }, { hover: '.spq-list > :nth-child(5)' }, '.spq-list > :nth-child(5) .spq-tool[aria-label="Remove from the queue"]', { wait: 300 }, { probe: SPQ_FIT }] },
  { name: 'spq-add', w: 1280, h: 560, q: '?mode=pill&media=playing&spq=queue', steps: ['#mchip', '.spq-head', { wait: 300 }, { fill: '.spq-search', text: 'levitating' }, { wait: 700 }, '.spq-row', { wait: 300 }, { probe: SPQ_FIT }] },
  { name: 'spq-restart-armed', w: 1280, h: 560, q: '?mode=pill&media=playing&spq=noport', steps: ['#mchip', '.spq-head', { wait: 300 }, '.spq-state .spq-btn', { wait: 200 }, { probe: SPQ_FIT }] },
  { name: 'spq-searchbroken', w: 1280, h: 560, q: '?mode=pill&media=playing&spq=searchbroken', steps: ['#mchip', '.spq-head', { wait: 300 }, { fill: '.spq-search', text: 'levitating' }, { wait: 700 }, { probe: SPQ_FIT }] },
  /* the tray: the white-icon plate on the strip, and the hidden icons in the overflow */
  { name: 'tray', w: 1280, h: 60, q: '?mode=pill&tray=1&media=playing' },
  { name: 'tray-more', w: 1280, h: 330, q: '?mode=pill&tray=1', click: '#more' },
  /* The notification centre (ui/bar/notifications.js): the bell's count, then the panel */
  { name: 'notifs-bell', w: 1280, h: 60, q: '?mode=pill&notifs=some' },
  { name: 'notifs-panel', w: 1280, h: 540, q: '?mode=pill&notifs=some', click: '#notifs' },
  { name: 'notifs-many', w: 1280, h: 540, q: '?mode=pill&notifs=many', click: '#notifs' },
  { name: 'notifs-plain', w: 1280, h: 540, q: '?mode=pill&notifs=plain', click: '#notifs' },
  { name: 'notifs-none', w: 1280, h: 330, q: '?mode=pill&notifs=none', click: '#notifs' },
  { name: 'notifs-off', w: 1280, h: 330, q: '?mode=pill&notifs=off', click: '#notifs' },
  { name: 'notifs-edge', w: 1280, h: 540, q: '?notifs=some', click: '#notifs' },
  /* Quick settings one level down (ui/bar/qs-more.js, 2026-09-23): the Wi-Fi list, the password
     field, the output picker and the mixer, in every state they have to get right. `steps` runs in
     order: a string clicks that selector, {wait: ms} pauses, {fill, text} types into a field,
     {scroll} scrolls that element to its bottom. The mock scans in 900 ms, hence the waits. */
  { name: 'qsx-main', w: 1280, h: 400, q: '?mode=pill', click: '#network' },
  { name: 'qsx-wifi', w: 1280, h: 560, q: '?mode=pill', steps: WIFI },
  { name: 'qsx-wifi-more', w: 1280, h: 560, q: '?mode=pill', steps: WIFI.concat([{ scroll: '.qsx-view .qsx-scroll' }]) },
  { name: 'qsx-wifi-connected', w: 1280, h: 560, q: '?mode=pill', steps: WIFI.concat([net('Maple-5G')]) },
  { name: 'qsx-wifi-known', w: 1280, h: 560, q: '?mode=pill', steps: WIFI.concat([net('Maple-Guest')]) },
  { name: 'qsx-wifi-open', w: 1280, h: 560, q: '?mode=pill', steps: WIFI.concat([net('CoffeeHouse Free WiFi')]) },
  { name: 'qsx-wifi-enterprise', w: 1280, h: 560, q: '?mode=pill', steps: WIFI.concat([{ scroll: '.qsx-view .qsx-scroll' }, '.qsx-net[data-ssid^="Lakeview"] .qsx-nethead']) },
  { name: 'qsx-wifi-password', w: 1280, h: 560, q: '?mode=pill', steps: PASSWORD },
  { name: 'qsx-wifi-connecting', w: 1280, h: 560, q: '?mode=pill&wifi=connecting', steps: WIFI },
  { name: 'qsx-wifi-failed', w: 1280, h: 560, q: '?mode=pill', steps: PASSWORD.concat(['.qsx-pw .qsx-btn.acc', { wait: 1800 }]) },
  { name: 'qsx-wifi-lastfail', w: 1280, h: 560, q: '?mode=pill&wifi=failed', steps: WIFI },
  { name: 'qsx-wifi-kbd', w: 1280, h: 560, q: '?mode=pill&kbd=refused', steps: WIFI.concat([net('Cafe WiFi'), '.qsx-net.open .qsx-btn.acc']) },
  { name: 'qsx-wifi-scanning', w: 1280, h: 560, q: '?mode=pill&scan=hold', steps: ['#network', '.qsx-chev', { wait: 300 }] },
  { name: 'qsx-wifi-off', w: 1280, h: 560, q: '?mode=pill&wifi=off', steps: WIFI },
  { name: 'qsx-wifi-none', w: 1280, h: 560, q: '?mode=pill&wifi=none', steps: WIFI },
  { name: 'qsx-wifi-empty', w: 1280, h: 560, q: '?mode=pill&wifi=empty', steps: WIFI },
  { name: 'qsx-wifi-error', w: 1280, h: 560, q: '?mode=pill&wifi=error', steps: WIFI },
  { name: 'qsx-sound-1', w: 1280, h: 560, q: '?mode=pill&audio=1', steps: SOUND },
  { name: 'qsx-sound-4', w: 1280, h: 560, q: '?mode=pill&audio=4', steps: SOUND },
  { name: 'qsx-mixer-0', w: 1280, h: 560, q: '?mode=pill&audio=1&mixer=0', steps: SOUND },
  { name: 'qsx-mixer-8', w: 1280, h: 560, q: '?mode=pill&audio=1&mixer=8', steps: SOUND.concat([{ scroll: '.qsx-view .qsx-scroll' }]) },
  { name: 'qsx-mixer-error', w: 1280, h: 560, q: '?mode=pill&mixer=error', steps: SOUND },
  { name: 'qsx-bt-panel', w: 1280, h: 400, q: '?mode=pill', steps: ['#network', { wait: 400 }] },
  { name: 'qsx-bt-6', w: 1280, h: 560, q: '?mode=pill', steps: BTV },
  { name: 'qsx-bt-1', w: 1280, h: 560, q: '?mode=pill&bt=1', steps: BTV },
  { name: 'qsx-bt-0', w: 1280, h: 560, q: '?mode=pill&bt=0', steps: BTV },
  { name: 'qsx-bt-long', w: 1280, h: 560, q: '?mode=pill&bt=long', steps: BTV },
  { name: 'qsx-bt-row-connect', w: 1280, h: 560, q: '?mode=pill', steps: BTV.concat([btRow('JBL Flip 6')]) },
  { name: 'qsx-bt-row-disconnect', w: 1280, h: 560, q: '?mode=pill', steps: BTV.concat([btRow('WH-CH520')]) },
  { name: 'qsx-bt-row-noroute', w: 1280, h: 560, q: '?mode=pill', steps: BTV.concat([btRow('Xbox Wireless Controller')]) },
  { name: 'qsx-bt-row-nobattery', w: 1280, h: 560, q: '?mode=pill', steps: BTV.concat([btRow('Keys-To-Go 2')]) },
  { name: 'qsx-bt-connecting', w: 1280, h: 560, q: '?mode=pill', steps: BT_CONNECT },
  { name: 'qsx-bt-connected', w: 1280, h: 560, q: '?mode=pill', steps: BT_CONNECT.concat([{ wait: 1600 }]) },
  { name: 'qsx-bt-failed', w: 1280, h: 560, q: '?mode=pill&bt=failed', steps: BT_CONNECT.concat([{ wait: 1600 }]) },
  { name: 'qsx-bt-inflight', w: 1280, h: 560, q: '?mode=pill&bt=connecting', steps: BTV },
  { name: 'qsx-bt-off', w: 1280, h: 560, q: '?mode=pill&bt=off', steps: BTV },
  { name: 'qsx-bt-turnon', w: 1280, h: 560, q: '?mode=pill&bt=off', steps: BTV.concat(['.qsx-state .qsx-btn.acc', { wait: 1400 }]) },
  { name: 'qsx-bt-none', w: 1280, h: 560, q: '?mode=pill&bt=none', steps: BTV },
  { name: 'qsx-bt-error', w: 1280, h: 560, q: '?mode=pill&bt=error', steps: BTV },
  { name: 'qsx-bt-watchfail', w: 1280, h: 560, q: '?mode=pill&btwatch=fail', steps: BTV },
  { name: 'qsx-bt-push', w: 1280, h: 560, q: '?mode=pill&bt=1', steps: BTV.concat([{ js: "__mockMain.bt('6')" }, { wait: 200 }]) },
  ...BATT.map((b) => ({ name: 'battery-' + b, w: 1280, h: 60, q: '?mode=pill&battery=' + b, steps: [{ wait: 900 }] })),
  ...BATT.map((b) => ({ name: 'battery-' + b + '-qs', w: 1280, h: 400, q: '?mode=pill&battery=' + b,
    steps: [{ wait: 900 }, b === 'none' ? '#network' : '#battery'] })),
  // Plugged in while the panel is open: main's push must redraw the readout AND the footer.
  { name: 'battery-push-qs', w: 1280, h: 400, q: '?mode=pill&battery=battery',
    steps: [{ wait: 900 }, '#battery', { js: "__mockMain.battery('charging')" }, { wait: 300 }] },
  /* POWER MODE (osd lane, 2026-09-24, ui/bar/powermode.js): the switch in every state it has - live,
     on battery, muted off the Balanced plan (Owen's machine today), unreadable, a click pending, a
     click taken, a click refused (springs back, says why), and a change made in Windows Settings
     while the panel is open (the 'powermode' push). */
  { name: 'pm-balanced', w: 1280, h: 480, q: '?mode=pill', steps: [{ wait: 900 }, '#network', { wait: 300 }] },
  { name: 'pm-battery', w: 1280, h: 480, q: '?mode=pill&pm=battery', steps: [{ wait: 900 }, '#network', { wait: 300 }] },
  { name: 'pm-saver', w: 1280, h: 520, q: '?mode=pill&pm=saver', steps: [{ wait: 900 }, '#network', { wait: 300 }] },
  { name: 'pm-hone', w: 1280, h: 480, q: '?mode=pill&pm=hone', steps: [{ wait: 900 }, '#network', { wait: 300 }] },
  { name: 'pm-error', w: 1280, h: 480, q: '?mode=pill&pm=error', steps: [{ wait: 900 }, '#network', { wait: 300 }] },
  { name: 'pm-pending', w: 1280, h: 480, q: '?mode=pill&pm=slow', steps: [{ wait: 900 }, '#network', { wait: 300 }, '.pmbtn[data-mode="performance"]', { wait: 200 }] },
  { name: 'pm-taken', w: 1280, h: 480, q: '?mode=pill', steps: [{ wait: 900 }, '#network', { wait: 300 }, '.pmbtn[data-mode="efficiency"]', { wait: 300 }] },
  { name: 'pm-refused', w: 1280, h: 480, q: '?mode=pill&pm=refuse', steps: [{ wait: 900 }, '#network', { wait: 300 }, '.pmbtn[data-mode="performance"]', { wait: 300 }] },
  { name: 'pm-settings-push', w: 1280, h: 480, q: '?mode=pill', steps: [{ wait: 900 }, '#network', { wait: 300 }, { js: "__mockPower('performance')" }, { wait: 200 }] },
  // The power PLANS (2026-09-24): off Balanced the plans are the control; Balanced chosen -> the modes,
  // with the plans one click away behind "Plan: Balanced"; a refused plan switch springs back.
  { name: 'pm-plans-hone', w: 1280, h: 520, q: '?mode=pill&pm=hone', steps: [{ wait: 900 }, '#network', { wait: 300 }] },
  { name: 'pm-plans-chose-balanced', w: 1280, h: 520, q: '?mode=pill&pm=hone', steps: [{ wait: 900 }, '#network', { wait: 300 }, '.pmplan[data-plan="381b4222-f694-41f0-9685-ff5bb260df2e"]', { wait: 300 }] },
  { name: 'pm-plans-open', w: 1280, h: 520, q: '?mode=pill', steps: [{ wait: 900 }, '#network', { wait: 300 }, '.pmplantoggle', { wait: 200 }] },
  { name: 'pm-plans-refused', w: 1280, h: 520, q: '?mode=pill&pm=refuse', steps: [{ wait: 900 }, '#network', { wait: 300 }, '.pmplantoggle', { wait: 150 }, '.pmplan[data-plan="44444444-4444-4444-4444-444444444452"]', { wait: 300 }] },
  /* GAME MODE (lane gamemode, 2026-09-25, ui/bar/gamemode.js): off and watching, each on state with its
     action rows open (battery + Energy saver, plugged in, by hand, a --test dry run), put back after a
     restart, not watching, switched off in the tray, and a click turning it on. */
  { name: 'gm-off', w: 1280, h: 560, q: '?mode=pill', steps: [{ wait: 900 }, '#network', { wait: 300 }] },
  { name: 'gm-off-details', w: 1280, h: 820, q: '?mode=pill', steps: [{ wait: 900 }, '#network', { wait: 300 }, '.gmmore', { wait: 200 }] },
  { name: 'gm-on-battery', w: 1280, h: 900, q: '?mode=pill&gm=on&pm=saver', steps: [{ wait: 900 }, '#network', { wait: 300 }, '.gmmore', { wait: 200 }] },
  { name: 'gm-on-ac', w: 1280, h: 900, q: '?mode=pill&gm=onac', steps: [{ wait: 900 }, '#network', { wait: 300 }, '.gmmore', { wait: 200 }] },
  { name: 'gm-manual', w: 1280, h: 560, q: '?mode=pill&gm=manual', steps: [{ wait: 900 }, '#network', { wait: 300 }] },
  { name: 'gm-dry', w: 1280, h: 900, q: '?mode=pill&gm=dry', steps: [{ wait: 900 }, '#network', { wait: 300 }, '.gmmore', { wait: 200 }] },
  { name: 'gm-crash', w: 1280, h: 600, q: '?mode=pill&gm=crash', steps: [{ wait: 900 }, '#network', { wait: 300 }] },
  { name: 'gm-nowatch', w: 1280, h: 600, q: '?mode=pill&gm=nowatch', steps: [{ wait: 900 }, '#network', { wait: 300 }] },
  { name: 'gm-tray', w: 1280, h: 560, q: '?mode=pill&gm=tray', steps: [{ wait: 900 }, '#network', { wait: 300 }] },
  { name: 'gm-click-on', w: 1280, h: 560, q: '?mode=pill', steps: [{ wait: 900 }, '#network', { wait: 300 }, '.gmswitch', { wait: 300 }] },
  // The right-click menu (lane jumplist, 2026-09-24): Windows 11's jump list + app, pin, close. rclick = a
  // right-click; dsf = the device scale (1 or 1.25); desk = the desktop behind the transparent page.
  { name: 'jl-edge', w: 1280, h: 600, q: '?mode=pill', steps: [{ rclick: '.cell[data-id="edge"]' }, { wait: 300 }] },
  { name: 'jl-edge-1x', w: 1280, h: 600, q: '?mode=pill', dsf: 1, steps: [{ rclick: '.cell[data-id="edge"]' }, { wait: 300 }] },
  { name: 'jl-edge-light', w: 1280, h: 600, q: '?mode=pill', desk: 'light', steps: [{ rclick: '.cell[data-id="edge"]' }, { wait: 300 }] },
  { name: 'jl-edge-light-1x', w: 1280, h: 600, q: '?mode=pill', desk: 'light', dsf: 1, steps: [{ rclick: '.cell[data-id="edge"]' }, { wait: 300 }] },
  { name: 'jl-long', w: 1280, h: 600, q: '?mode=pill&jl=long', steps: [{ rclick: '.cell[data-id="edge"]' }, { wait: 300 }] },
  { name: 'jl-long-scrolled', w: 1280, h: 600, q: '?mode=pill&jl=long', steps: [{ rclick: '.cell[data-id="edge"]' }, { wait: 300 }, { scroll: '.pop.jl .jl-list' }] },
  { name: 'jl-none', w: 1280, h: 320, q: '?mode=pill&jl=none', steps: [{ rclick: '.cell[data-id="code"]' }, { wait: 300 }] },
  { name: 'jl-error', w: 1280, h: 320, q: '?mode=pill&jl=error', steps: [{ rclick: '.cell[data-id="edge"]' }, { wait: 300 }] },
  { name: 'jl-part', w: 1280, h: 400, q: '?mode=pill&jl=part', steps: [{ rclick: '.cell[data-id="edge"]' }, { wait: 300 }] },
  { name: 'jl-off', w: 1280, h: 320, q: '?mode=pill&jl=off', steps: [{ rclick: '.cell[data-id="edge"]' }, { wait: 300 }] },
  { name: 'jl-loading', w: 1280, h: 320, q: '?mode=pill&jlms=60000', steps: [{ rclick: '.cell[data-id="edge"]' }, { wait: 200 }] },
  { name: 'jl-notrunning', w: 1280, h: 480, q: '?mode=pill', steps: [{ rclick: '.cell[data-id="spotify"]' }, { wait: 300 }] },
  { name: 'jl-item-actions', w: 1280, h: 600, q: '?mode=pill', steps: [{ rclick: '.cell[data-id="edge"]' }, { wait: 300 }, { rclick: '.pop.jl .jl-list .jl-i:nth-of-type(4)' }, { wait: 200 }] },
  { name: 'jl-task-actions', w: 1280, h: 600, q: '?mode=pill', steps: [{ rclick: '.cell[data-id="edge"]' }, { wait: 300 }, { rclick: '.pop.jl .jl-list .jl-i:last-of-type' }, { wait: 200 }] },
  { name: 'jl-edge-top', w: 1280, h: 600, q: '?mode=pill&edge=top', steps: [{ rclick: '.cell[data-id="edge"]' }, { wait: 300 }] },
];
const ONLY = process.argv.slice(2);
const RUN = ONLY.length ? SHOTS.filter(s => ONLY.some(w => s.name.includes(w))) : SHOTS;
let REAL_TRAY = null;
if (process.env.BAR_TRAY_JSON) {
  const raw = JSON.parse(fs.readFileSync(process.env.BAR_TRAY_JSON, 'utf8'));
  REAL_TRAY = Array.isArray(raw) ? raw : (raw && raw[1] && raw[1].result) || null;
  if (!Array.isArray(REAL_TRAY)) { console.error('FAILED: BAR_TRAY_JSON holds no tray array'); process.exit(1); }
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const exe = findChrome();
  if (!exe) { console.error('FAILED: no ms-playwright chromium found under AppData/Local/ms-playwright'); process.exit(1); }

  const browser = await chromium.launch({ headless: true, executablePath: exe });
  const ctx = await browser.newContext({ colorScheme: 'dark', deviceScaleFactor: 1.25, viewport: { width: 1920, height: 44 } });
  const problems = [];
  const ctxs = {};
  const ctxAt = async (dsf) => ctxs[dsf] || (ctxs[dsf] = await browser.newContext({ colorScheme: 'dark', deviceScaleFactor: dsf, viewport: { width: 1920, height: 44 } }));
  try {
    for (const s of RUN) {
      // per-shot device scale (the jump list shots take 1x and 1.25x); one context per scale
      const page = await (s.dsf && s.dsf !== 1.25 ? ctxAt(s.dsf) : Promise.resolve(ctx)).then((c) => c.newPage());
      if (REAL_TRAY && /tray/.test(s.q)) await page.addInitScript((t) => { window.__MOCK_TRAY__ = t; }, REAL_TRAY);
      await page.setViewportSize({ width: s.w, height: s.h });
      page.on('pageerror', e => problems.push(s.name + ' pageerror: ' + e.message));
      page.on('console', m => { if (m.type() === 'error') problems.push(s.name + ' console: ' + m.text()); });
      await page.goto(PAGE + s.q, { waitUntil: 'load' });
      /* The page is deliberately transparent (the Electron window is), so a screenshot over
         nothing would composite onto white and misrepresent every contrast judgement. Paint a
         plausible dark desktop behind it — on <html>, never on the bar. The ?bg=1 shot brings
         its own (much louder) wallpaper from the mock, so leave that one alone. */
      if (!s.q.includes('bg=1'))
        await page.addStyleTag({ content: 'html{background:' + (s.desk === 'light' ? '#dfe4ec' : '#141619') + ' !important;}' });
      if (process.env.BAR_EXTRA_CSS) await page.addStyleTag({ content: process.env.BAR_EXTRA_CSS });
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(350);           // the mock bridge answers at 30ms; this is slack, not a race
      for (const st of s.steps || (s.click ? [s.click] : [])) {
        if (typeof st === 'string') { await page.click(st); await page.waitForTimeout(400); }
        else if (st.wait) await page.waitForTimeout(st.wait);
        else if (st.rclick) { await page.click(st.rclick, { button: 'right' }); await page.waitForTimeout(150); }
        else if (st.fill) await page.fill(st.fill, st.text);
        else if (st.hover) { await page.hover(st.hover); await page.waitForTimeout(200); }   // spq-tools: the row tools show on hover
        else if (st.scroll) { await page.$eval(st.scroll, el => { el.scrollTop = el.scrollHeight; }); await page.waitForTimeout(100); }
        else if (st.js) await page.evaluate(st.js);   // a mock-main push (window.__mockMain), mid-shot
        else if (st.probe) console.log('  ' + s.name + ' probe: ' + JSON.stringify(await page.evaluate(st.probe)));   // a measurement, printed
      }
      if (!s.keepHover) await page.mouse.move(0, 0);   // no hover state left on whatever was clicked (keepHover: a shot OF a hover, spq-tools)
      /* ...and let its fade finish: hovers fade out over 150 ms steps(2), so a shot taken at once
         kept the full hover fill on whatever row the last click left the pointer over (seen on
         qsx-wifi, 2026-09-23, where it read as a selected network). */
      await page.waitForTimeout(200);
      const file = path.join(OUT, s.name + (process.env.BAR_SUFFIX || '') + '.png');
      await page.screenshot({ path: file });
      console.log(file);
      await page.close();
    }
  } finally {
    await browser.close();
  }
  console.log('playwright-core from ' + pwFrom + ' · chromium ' + exe);
  console.log(problems.length ? 'PAGE PROBLEMS:\n  ' + problems.join('\n  ') : 'no page errors, no console errors');
})().catch(e => { console.error('FAILED', e && e.stack || e); process.exit(1); });

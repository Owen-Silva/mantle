'use strict';
/* overlap-surfaces.js - every Mantle surface tools/overlap-audit.js renders, in the states worth checking, at
 * the size its real window has (lane overlap, 2026-10-15). The sizes come from the feature that opens the
 * window (lib/features/*.js, lib/welcome.js) or, for the bar's pop-ups, from ui/bar/shoot.js (the bar asks
 * main for a window as tall as the open pop-up).
 *
 * A state: { name, q, w, h, dsf, steps, settle }
 *   q      the query string the page's mock-mantle.js reads (presets, which pop-up is open)
 *   steps  run in order after load: 'selector' clicks it; { wait: ms }; { js: 'source' }; { fill, text };
 *          { key: 'Enter' }; { scroll: 'selector' } (scrolls it to its end)
 * A surface may also have discover: an expression run on its first state's page that returns more query
 * strings (Settings: every section in the nav, and every page each section lists).
 * owner: the night lane that owns the surface's files tonight (findings in those files are handed over,
 * not fixed here); null = this lane fixes them.
 */
const WIFI = ['#network', '.qsx-chev', { wait: 1300 }];
const net = (ssid) => '.qsx-net[data-ssid="' + ssid + '"] .qsx-nethead';
const SOUND = ['#volume', '.qsx-more', { wait: 600 }];
const BTV = ['#network', '.qsx-chev[title="Show Bluetooth devices"]', { wait: 500 }];

module.exports = [
  /* the pop-up states get a 720 px window: main caps a pop-up at its POPOVER_MAX and the bar then scrolls it
     (bar.js popNeed); the mock does not answer with that cap, so a short window here would cut it off */
  { surface: 'bar', page: 'ui/bar/index.html', dsf: 1.25, settle: 900, owner: 'barpolish (reveal/paint) / qstiles (QS in bar.js, qs-more.js)', states: [
    { name: 'edge-1920', w: 1920, h: 44, q: '' },
    { name: 'pill-full', w: 1280, h: 60, q: '?mode=pill&media=playing&tray=1&notifs=some&dl=new' },
    { name: 'pill-compact', w: 1000, h: 60, q: '?mode=pill&media=playing&notifs=some' },
    { name: 'qs-main', w: 1280, h: 720, q: '?mode=pill', steps: ['#network', { wait: 400 }] },
    { name: 'qs-wifi', w: 1280, h: 720, q: '?mode=pill', steps: WIFI },
    { name: 'qs-wifi-password', w: 1280, h: 720, q: '?mode=pill', steps: WIFI.concat([net('Cafe WiFi'), '.qsx-net.open .qsx-btn.acc']) },
    { name: 'qs-wifi-row', w: 1280, h: 720, q: '?mode=pill', steps: WIFI.concat([net('Maple-5G')]) },
    { name: 'qs-sound', w: 1280, h: 720, q: '?mode=pill&audio=4', steps: SOUND },
    { name: 'qs-mixer', w: 1280, h: 720, q: '?mode=pill&audio=1&mixer=8', steps: SOUND },
    { name: 'qs-bt', w: 1280, h: 720, q: '?mode=pill', steps: BTV },
    { name: 'qs-bt-row', w: 1280, h: 720, q: '?mode=pill', steps: BTV.concat(['.qsx-bt[data-bt="JBL Flip 6"] .qsx-nethead']) },
    { name: 'qs-battery', w: 1280, h: 720, q: '?mode=pill&battery=battery', steps: [{ wait: 400 }, '#network', { wait: 300 }] },
    { name: 'notifs', w: 1280, h: 720, q: '?mode=pill&notifs=some', steps: ['#notifs', { wait: 300 }] },
    { name: 'notifs-many', w: 1280, h: 720, q: '?mode=pill&notifs=many', steps: ['#notifs', { wait: 300 }] },
    { name: 'notifs-none', w: 1280, h: 720, q: '?mode=pill&notifs=none', steps: ['#notifs', { wait: 300 }] },
    { name: 'downloads', w: 1280, h: 720, q: '?mode=pill&dl=some', steps: ['#downloads', { wait: 300 }] },
    { name: 'media-card', w: 1280, h: 720, q: '?mode=pill&media=both', steps: ['#mchip', { wait: 300 }] },
    { name: 'spotify-queue', w: 1280, h: 720, q: '?mode=pill&media=playing&spq=queue', steps: ['#mchip', '.spq-head', { wait: 400 }] },
    { name: 'calendar', w: 1280, h: 720, q: '?mode=pill', steps: ['#clock', { wait: 300 }] },
    { name: 'overflow', w: 760, h: 720, q: '?mode=pill', steps: ['#dock-more', { wait: 300 }] },
    { name: 'tray-more', w: 1280, h: 720, q: '?mode=pill&tray=1', steps: ['#more', { wait: 300 }] },
    { name: 'jumplist', w: 1280, h: 720, q: '?mode=pill', steps: ['.cell[data-id="edge"]', { wait: 300 }] },
  ] },
  { surface: 'osd', page: 'ui/osd/index.html', dsf: 1.25, owner: null, states: [
    { name: 'volume', w: 440, h: 560, q: '?level=62' },
    { name: 'muted', w: 440, h: 560, q: '?level=38&muted=1' },
    { name: 'brightness', w: 440, h: 560, q: '?kind=brightness&level=70' },
    { name: 'expanded', w: 440, h: 560, q: '?expand=1&apps=6', settle: 900 },
    { name: 'dead', w: 440, h: 560, q: '?dead=1' },
  ] },
  { surface: 'launcher', page: 'ui/launcher/index.html', dsf: 1.25, owner: null, states: [
    { name: 'search', w: 680, h: 460, q: '?bg=1&mode=search' },
    { name: 'search-files', w: 680, h: 460, q: '?bg=1&mode=search&q=rep', settle: 900 },
    { name: 'search-settings', w: 680, h: 460, q: '?bg=1&mode=search&q=night', settle: 900 },
    { name: 'calc', w: 680, h: 460, q: '?bg=1&mode=search&q=2*(3%2B4)', settle: 900 },
    { name: 'power', w: 680, h: 460, q: '?bg=1&mode=search&q=shut', settle: 900 },
    { name: 'run', w: 680, h: 460, q: '?bg=1&mode=run' },
    { name: 'run-typed', w: 680, h: 460, q: '?bg=1&mode=run&q=notepad', settle: 900 },
    { name: 'quick-links', w: 680, h: 460, q: '?bg=1&mode=quick' },
    { name: 'down', w: 680, h: 460, q: '?bg=1&state=down' },
  ] },
  { surface: 'settings', page: 'ui/settings/index.html', dsf: 1.25, settle: 900, owner: 'settingsfast (settings.js only)', states: [
    { name: 'home', w: 1040, h: 700, q: '?section=home' },
    { name: 'search', w: 1040, h: 700, q: '?section=home', steps: ['#find', { type: 'night' }, { wait: 300 }] },
    { name: 'failing', w: 1040, h: 700, q: '?section=home&mock=failing' },
    { name: 'admin', w: 1040, h: 700, q: '?section=apps&mock=admin' },
    { name: 'narrow', w: 760, h: 520, q: '?section=home' },
  ],
  discover: `(() => {
    const out = new Set();
    for (const b of document.querySelectorAll('#nav [data-section]')) out.add('?section=' + b.dataset.section);
    return [...out];
  })()`,
  discoverPages: `(() => {
    const out = new Set();
    for (const b of document.querySelectorAll('[data-act="nav"][data-section][data-page]')) out.add('?section=' + b.dataset.section + '&page=' + b.dataset.page);
    return [...out];
  })()` },
  { surface: 'taskmgr', page: 'ui/taskmgr/index.html', dsf: 1.25, owner: 'settingsfast (ui/taskmgr)', states: [
    { name: 'apps', w: 780, h: 640, q: '?mock=apps' },
    { name: 'expanded', w: 780, h: 640, q: '?mock=expanded' },
    { name: 'game', w: 780, h: 640, q: '?mock=game' },
    { name: 'protected', w: 780, h: 640, q: '?mock=protected' },
    { name: 'failed', w: 780, h: 640, q: '?mock=failed' },
    { name: 'confirm', w: 780, h: 640, q: '?mock=confirm' },
    { name: 'menu', w: 780, h: 640, q: '?mock=menu' },
    { name: 'search', w: 780, h: 480, q: '?mock=search' },
    { name: 'small', w: 560, h: 420, q: '?mock=apps' },
  ] },
  { surface: 'files', page: 'ui/files/index.html', dsf: 1.25, settle: 1200, owner: 'files (ui/files/*)', states: [
    { name: 'home', w: 1280, h: 760, q: '?path=mantle:home' },
    { name: 'thispc', w: 1280, h: 760, q: '?path=mantle:thispc' },
    { name: 'folder', w: 1280, h: 760, q: '' },
    { name: 'narrow', w: 760, h: 520, q: '' },
  ] },
  { surface: 'taskview', page: 'ui/taskview/index.html', dsf: 1, owner: 'speeddebt (ui/taskview/*)', states: [
    { name: 'n7-d3', w: 1536, h: 864, q: '?n=7&d=3' },
    { name: 'rename', w: 1536, h: 864, q: '?n=7&d=3&rename=1' },
    { name: 'empty', w: 1536, h: 864, q: '?n=0' },
    { name: 'filter', w: 1536, h: 864, q: '?n=9&q=code' },
    { name: 'n40', w: 1280, h: 720, q: '?n=40&sel=30' },
  ] },
  { surface: 'switcher', page: 'ui/switcher/index.html', dsf: 1, owner: null, states: [
    { name: 'n6', w: 1280, h: 720, q: '?n=6' },
    { name: 'n40', w: 1280, h: 720, q: '?n=40&sel=33' },
    { name: 'empty', w: 1280, h: 720, q: '?n=0' },
    { name: 'notice', w: 1920, h: 1080, q: '?notice=1' },
  ] },
  { surface: 'clipboard', page: 'ui/clipboard/index.html', dsf: 1.25, owner: null, states: [
    { name: 'n6', w: 1280, h: 720, q: '?n=6' },
    { name: 'empty', w: 1280, h: 720, q: '?n=0' },
    { name: 'filter', w: 1280, h: 720, q: '?n=6&q=meeting' },
    { name: 'admin', w: 1280, h: 720, q: '?n=6&banner=admin' },
    { name: 'notice', w: 1280, h: 720, q: '?n=6&notice=1' },
  ] },
  { surface: 'snap', page: 'ui/snap/index.html', dsf: 1.25, owner: null, states: [
    { name: 'picker', w: 400, h: 268, q: '?mode=picker' },
    { name: 'notice', w: 440, h: 132, q: '?mode=notice' },
    { name: 'assist', w: 768, h: 864, q: '?mode=assist&n=4' },
    { name: 'assist-many', w: 768, h: 864, q: '?mode=assist&n=14' },
  ] },
  { surface: 'screenshot', page: 'ui/screenshot/index.html', dsf: 1.25, owner: 'speeddebt (overlay)', states: [
    { name: 'rect', w: 1280, h: 720, q: '?mode=rect&cursor=500,300' },
    { name: 'window', w: 1280, h: 720, q: '?mode=window' },
    { name: 'full', w: 1280, h: 720, q: '?mode=full' },
  ] },
  { surface: 'shotcard', page: 'ui/screenshot/card.html', dsf: 1.25, owner: 'toasts3 (ui/screenshot/card.*)', states: [
    { name: 'card', w: 400, h: 150, q: '' },
    { name: 'savefail', w: 400, h: 150, q: '?savefail=1' },
  ] },
  { surface: 'toasts', page: 'ui/toasts/index.html', dsf: 1.25, settle: 900, owner: 'toasts3 (ui/toasts/*)', states: [
    { name: 'three', w: 392, h: 520, q: '' },
  ] },
  { surface: 'welcome', page: 'ui/welcome/index.html', dsf: 1.25, owner: null, states: [
    { name: 'welcome', w: 624, h: 564, q: '' },
  ] },
  { surface: 'desktop', page: 'ui/desktop/index.html', dsf: 1.25, owner: 'deskmenu (ui/desktop/deskmenu.*)', states: [
    { name: 'desktop', w: 1536, h: 864, q: '' },
  ] },
  { surface: 'wallpapers', page: 'ui/wallpapers/index.html', dsf: 1.25, owner: null, states: [
    { name: 'wallpapers', w: 1040, h: 700, q: '' },
  ] },
  { surface: 'notes', page: 'ui/notes/index.html', dsf: 1.25, owner: null, states: [
    { name: 'notes', w: 412, h: 364, q: '' },
  ] },
  { surface: 'timer', page: 'ui/timer/index.html', dsf: 1.25, owner: null, states: [
    { name: 'timer', w: 344, h: 132, q: '' },
    { name: 'label', w: 344, h: 132, q: '?label=Laundry%20is%20done%20and%20needs%20moving%20to%20the%20dryer' },
  ] },
  { surface: 'topbar', page: 'ui/topbar/index.html', dsf: 1.25, owner: null, states: [
    { name: 'strip', w: 1536, h: 38, q: '?app=word' },
    { name: 'strip-npp', w: 1536, h: 420, q: '?app=npp&stat=cpu' },
    { name: 'menu-open', w: 1536, h: 420, q: '?app=npp&open=2' },
  ] },
  { surface: 'ontop', page: 'ui/ontop/index.html', dsf: 1.25, owner: null, states: [
    { name: 'ontop', w: 396, h: 80, q: '' },
  ] },
  { surface: 'layouts', page: 'ui/layouts/index.html', dsf: 1.25, owner: null, states: [
    { name: 'layouts', w: 496, h: 96, q: '' },
  ] },
];

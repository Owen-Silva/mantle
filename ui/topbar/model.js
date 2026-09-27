/* model.js — the top bar's pure logic: what the bar SAYS for a focused window. No DOM, no IPC,
 * so the page (browser global TopbarModel) and lib/features/topbar.js + its tests (require) share
 * one definition of the app name, the menus, the window actions and the stat formats.
 *
 * The sidecar's focus snapshot (sidecar/MenuBar.cs Snapshot) is the input:
 *   { hwnd, title, cls, exe, desc, product, self, shell, zoomed, topmost, enabled, menu, menuReason,
 *     blocked, uia }
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TopbarModel = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function base(exe) {
    var s = String(exe || '').split(/[\\/]/).pop() || '';
    return s.replace(/\.exe$/i, '');
  }

  /* FileDescription names most apps well ("Google Chrome", "Notepad++"), and a few badly: every
     Electron app that was not renamed says "Electron", UWP hosts say what hosts them. For those
     the product name, then the exe name, reads better. */
  var GENERIC = /^(electron|application frame host|windows explorer|host process for windows services|java\(tm\) platform se binary|node\.js)$/i;
  var RENAME = { explorer: 'File Explorer', applicationframehost: 'App' };

  function appName(f) {
    if (!f) return '';
    if (f.shell) return 'Desktop';
    var b = base(f.exe);
    if (RENAME[b.toLowerCase()]) return RENAME[b.toLowerCase()];
    var d = String(f.desc || '').trim();
    if (d && !GENERIC.test(d)) return d;
    var p = String(f.product || '').trim();
    if (p && !GENERIC.test(p)) return p;
    if (!b) return 'Window';
    return b.charAt(0).toUpperCase() + b.slice(1);
  }

  /* Windows menus often start, end or double up on separators once the app hides items. */
  function cleanItems(items) {
    var out = [];
    (items || []).forEach(function (it) {
      if (!it) return;
      if (it.t === 'sep') {
        if (out.length && out[out.length - 1].t !== 'sep') out.push(it);
        return;
      }
      var c = {};
      for (var k in it) c[k] = it[k];
      if (it.items) c.items = cleanItems(it.items);
      out.push(c);
    });
    while (out.length && out[out.length - 1].t === 'sep') out.pop();
    return out;
  }

  /* "New window" for apps that can open one from the command line. Everything else gets no such
     item rather than one that does nothing (NO SILENT FAILURES). Ctrl+N would be a synthetic key,
     which Mantle never sends into another app. */
  var NEW_WINDOW = {
    chrome: ['--new-window'], msedge: ['--new-window'], brave: ['--new-window'], vivaldi: ['--new-window'],
    opera: ['--new-window'], firefox: ['-new-window'], code: ['--new-window'], explorer: [],
    windowsterminal: null, notepad: [],
  };
  function newWindowArgs(exe) {
    var k = base(exe).toLowerCase();
    return Object.prototype.hasOwnProperty.call(NEW_WINDOW, k) && NEW_WINDOW[k] ? NEW_WINDOW[k].slice() : null;
  }

  /* The bold app menu: what every window can do, menu bar or not. */
  function appMenu(f) {
    var name = appName(f);
    var items = [];
    if (!f || f.shell) {
      items.push({ t: 'item', label: 'New File Explorer window', act: 'newWindow', exe: 'C:\\Windows\\explorer.exe', args: [], enabled: true });
      return items;
    }
    if (newWindowArgs(f.exe)) items.push({ t: 'item', label: 'New window', act: 'newWindow', exe: f.exe, args: newWindowArgs(f.exe), enabled: true });
    if (items.length) items.push({ t: 'sep' });
    items.push({ t: 'item', label: 'Minimize', act: 'minimize', enabled: true });
    items.push({ t: 'item', label: f.zoomed ? 'Restore size' : 'Zoom', act: 'zoom', enabled: true });
    items.push({ t: 'item', label: 'Always on top', act: 'ontop', checked: !!f.topmost, enabled: true });
    items.push({ t: 'sep' });
    items.push({ t: 'item', label: 'Close window', act: 'close', enabled: true });
    items.push({ t: 'item', label: 'Quit ' + name, act: 'quit', enabled: true });
    return items;
  }

  var MANTLE_MENU = [
    { t: 'item', label: 'About Mantle', act: 'about', enabled: true },
    { t: 'item', label: 'Settings…', act: 'settings', enabled: true },
    // Owen's override for the game rule. Here because the tray has no per-feature items yet
    // (lib/features.js offers one checkbox per feature); `checked` is set from topbar.hello.
    { t: 'item', label: 'Keep the top bar over full-screen games', act: 'overGames', checked: false, enabled: true },
    // Owen's "a way that i can manually hide it" (lane tbvideo, 2026-09-26). The same key shows it
    // again, and so does the Top bar row in the bottom bar's quick settings (lib/features/topbar.js).
    { t: 'item', label: 'Hide top bar', act: 'hide', key: 'Win+Alt+T', enabled: true },
    { t: 'sep' },
    { t: 'item', label: 'Lock', act: 'power', power: 'lock', enabled: true },
    { t: 'item', label: 'Sleep', act: 'power', power: 'sleep', enabled: true },
    { t: 'item', label: 'Restart…', act: 'power', power: 'restart', confirm: 'Click again to restart', enabled: true },
    { t: 'item', label: 'Shut down…', act: 'power', power: 'shutdown', confirm: 'Click again to shut down', enabled: true },
  ];

  /* Every top-level title on the bar, left to right. `menu` is the app's own (win32 or uia).
     Never an empty bar: an app without menus still has its bold menu and a Window menu. */
  function titles(f, menu) {
    var out = [{ key: 'mantle', label: 'Mantle', glyph: true, items: MANTLE_MENU }];
    if (!f) return out;
    out.push({ key: 'app', label: appName(f), bold: true, items: appMenu(f) });
    var src = menu && menu.items && menu.items.length ? menu : null;
    if (src) {
      cleanItems(src.items).forEach(function (it, i) {
        if (it.t !== 'item') return;
        out.push({ key: 'm' + i, label: it.label || '(untitled)', pos: it.pos, id: it.id, lazy: !!it.lazy,
                   enabled: it.enabled !== false, items: it.items || null, source: src.source, path: [it.pos] });
      });
    } else if (f && !f.shell) {
      out.push({ key: 'window', label: 'Window', items: appMenu(f).filter(function (i) { return /minimize|zoom|ontop/.test(i.act || ''); }) });
    }
    return out;
  }

  /* ---- fit: which titles the left side shows (pure; the page measures, this decides) ----
     w[0] the Mantle glyph, w[1] the app's bold name, w[2..] its menus (natural widths, px); moreW the
     » button; avail the left side's room. Owen's order (2026-09-25): the app name gives way first
     (ellipsis, down to appMin), then the menus that still do not fit go into », from the right, and
     whatever room is left over goes back to the app name. Returns { n, shown, appW }: titles
     [0, shown) are on the bar, the rest are in »; appW is the app name's max width, or null for its
     natural width. A 1 px margin absorbs sub-pixel rounding at 125% / 150%. */
  function fitTitles(w, moreW, avail, appMin) {
    var n = w.length, i, sum = 0, room = avail - 1;
    for (i = 0; i < n; i++) sum += w[i];
    if (n < 2 || sum <= room) return { n: n, shown: n, appW: null };
    var menus = sum - w[0] - w[1], minApp = Math.min(w[1], appMin);
    if (w[0] + minApp + menus <= room) return { n: n, shown: n, appW: Math.floor(room - w[0] - menus) };
    var used = w[0] + minApp + moreW, shown = 2;
    while (shown < n && used + w[shown] <= room) { used += w[shown]; shown++; }
    var appW = Math.floor(Math.max(24, Math.min(w[1], minApp + (room - used))));
    return { n: n, shown: shown, appW: appW < w[1] ? appW : null };
  }

  /* ---- stats: the tiny-numbers rule. Fixed decimals so a figure never changes width. ---- */
  function pct(n) {
    if (typeof n !== 'number' || !isFinite(n)) return '--';
    return Math.round(Math.max(0, Math.min(100, n))) + '%';
  }
  function gb(bytes) {
    if (typeof bytes !== 'number' || !isFinite(bytes)) return '--';
    return (bytes / 1073741824).toFixed(1);
  }
  function rate(bps) {
    if (typeof bps !== 'number' || !isFinite(bps) || bps < 0) return '--';
    if (bps < 1000 * 1024) return (bps / 1024).toFixed(0) + ' KB/s';
    if (bps < 100 * 1048576) return (bps / 1048576).toFixed(1) + ' MB/s';
    return (bps / 1048576).toFixed(0) + ' MB/s';
  }
  function statCells(s) {
    s = s || {};
    var cpu = s.cpu || {}, mem = s.mem || {}, gpu = s.gpu || {}, net = s.net || {};
    return [
      { key: 'cpu', label: 'CPU', value: pct(cpu.pct), why: cpu.pct == null ? (cpu.reason || 'no CPU reading yet') : null },
      { key: 'mem', label: 'RAM', value: mem.used == null ? '--' : gb(mem.used) + '/' + gb(mem.total) + ' GB',
        why: mem.used == null ? (mem.reason || 'no memory reading yet') : null },
      { key: 'gpu', label: 'GPU', value: pct(gpu.pct), why: gpu.pct == null ? (gpu.reason || 'no GPU reading yet') : null },
      { key: 'net', label: 'NET', value: net.down == null ? '--' : '↓' + rate(net.down) + ' ↑' + rate(net.up),
        why: net.down == null ? (net.reason || 'no network reading yet') : null },
    ];
  }

  return { appName: appName, cleanItems: cleanItems, newWindowArgs: newWindowArgs, appMenu: appMenu,
           titles: titles, fitTitles: fitTitles, MANTLE_MENU: MANTLE_MENU, pct: pct, gb: gb, rate: rate, statCells: statCells, base: base };
}));

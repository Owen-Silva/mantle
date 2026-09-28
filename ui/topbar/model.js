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
    // Window layouts (lane layouts, 2026-09-27): filled from lib/features/layouts.js's layouts.state
    // by layoutMenus() below; until that arrives they say why they are empty.
    { t: 'item', label: 'Layouts', act: 'layouts', mn: 'y', items: [{ t: 'item', label: 'Window layouts are not running', enabled: false }], enabled: true },
    { t: 'item', label: 'Save layout…', act: 'layoutsSave', mn: 'v', items: [{ t: 'item', label: 'Window layouts are not running', enabled: false }], enabled: true },
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

  /* PEEK (lane tbpeek, 2026-09-27): hidden by hand, the bar can come out while the cursor rests on the
     top edge. Its "Hide top bar" would be a no-op then, so the item becomes "Show top bar" (for good:
     the strip back, no more peeking) until the peek ends. Mutates the item in place: titles() hands
     the page this very array. Returns the item. */
  function peekMenu(menu, on) {
    var it = null;
    for (var i = 0; i < (menu || []).length; i++) if (menu[i].act === 'hide' || menu[i].act === 'show') { it = menu[i]; break; }
    if (!it) return null;
    it.act = on ? 'show' : 'hide';
    it.label = on ? 'Show top bar' : 'Hide top bar';
    return it;
  }

  /* WINDOW LAYOUTS (lane layouts): the two submenus from layouts.state {layouts:[{name,count,apps}],
     enabled, busy}. Layouts > <name> puts it back (one click); Rename / Delete are under it. Save
     layout… > New layout… asks for a name in the menu itself; Replace <name> overwrites (confirmed).
     layoutMenus mutates the items in place, like peekMenu. */
  function layoutItems(st) {
    var ls = (st && st.layouts) || [];
    var busy = st && st.busy;
    if (st && st.enabled === false) {
      return { restore: [{ t: 'item', label: 'Window layouts are switched off in the tray', enabled: false }],
               save: [{ t: 'item', label: 'Window layouts are switched off in the tray', enabled: false }] };
    }
    var restore = ls.map(function (l) {
      return { t: 'item', label: l.name, act: 'layoutRestore', layout: l.name, enabled: !busy,
               key: l.count + (l.count === 1 ? ' window' : ' windows') };
    });
    if (busy) restore.unshift({ t: 'item', label: 'Putting ' + busy + ' back…', enabled: false });
    if (!ls.length) restore.push({ t: 'item', label: 'No layouts yet: Save layout… names what is on screen', enabled: false });
    else {
      restore.push({ t: 'sep' });
      restore.push({ t: 'item', label: 'Rename', enabled: true, items: ls.map(function (l) {
        return { t: 'item', label: l.name + '…', act: 'layoutRename', layout: l.name, enabled: true };
      }) });
      restore.push({ t: 'item', label: 'Delete', enabled: true, items: ls.map(function (l) {
        return { t: 'item', label: l.name, act: 'layoutDelete', layout: l.name, confirm: 'Click again to delete ' + l.name, enabled: true };
      }) });
    }
    var save = [{ t: 'item', label: 'New layout…', act: 'layoutNew', enabled: true }];
    if (ls.length) {
      save.push({ t: 'sep' });
      ls.forEach(function (l) {
        save.push({ t: 'item', label: 'Replace ' + l.name, act: 'layoutSave', layout: l.name, confirm: 'Click again to replace ' + l.name, enabled: true });
      });
    }
    return { restore: restore, save: save };
  }
  function layoutMenus(menu, st) {
    var x = layoutItems(st);
    for (var i = 0; i < (menu || []).length; i++) {
      if (menu[i].act === 'layouts') menu[i].items = x.restore;
      else if (menu[i].act === 'layoutsSave') menu[i].items = x.save;
    }
    return x;
  }

  /* THE TOP BAR'S TWO SMALL TOOLS (lane tbtools, 2026-09-27): a timer / stopwatch and quick notes,
     two buttons at the right end of the bar. The engine is lib/features/timer.js (it never rests, so a
     timer still ends during a game) and its pure math is lib/features/_timer-core.js, which the page
     loads too (window.TimerCore) and hands in here as `core`: one definition of "18:42" everywhere.
     `st` is timer.state: {kind:'idle'|'timer'|'stopwatch', paused, endAt, leftMs, label, startAt,
     elapsedMs, persist, ...}. */
  var TIMER_PRESETS = [5, 15, 25, 50];
  var ADD_MS = 5 * 60000;
  function clockAt(ms) {
    try { return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); } catch (_) { return ''; }
  }
  function presetItems(prefix) {
    return TIMER_PRESETS.map(function (m) {
      return { t: 'item', label: (prefix || '') + m + ' minutes', act: 'timerStart', ms: m * 60000, mn: '', enabled: true };
    });
  }
  /* What the bar shows for the timer: null = the plain icon (nothing runs). */
  function timerCell(st, now, core) {
    if (!st || !core || (st.kind !== 'timer' && st.kind !== 'stopwatch')) return null;
    if (st.kind === 'timer') {
      var left = st.paused ? st.leftMs : core.leftMs(st, now);
      var t = core.formatClock(left);
      return { text: t, up: false, paused: !!st.paused,
        title: (st.label || 'Timer') + ' timer · ' + (st.paused ? 'paused with ' + t + ' left' : 'ends ' + clockAt(st.endAt)) };
    }
    var e = core.formatClock(st.paused ? st.elapsedMs : core.elapsedMs(st, now), true);
    return { text: e, up: true, paused: !!st.paused, title: 'Stopwatch · ' + e + (st.paused ? ' (paused)' : '') };
  }
  /* The timer's dropdown. Rows of t:'info' are plain words (never selectable). */
  function timerMenu(st, now, core) {
    var items = [];
    var kind = st && st.kind;
    var cell = timerCell(st, now, core);
    if (kind === 'timer') {
      items.push({ t: 'info', enabled: false, text: cell.title });
      items.push(st.paused ? { t: 'item', label: 'Resume', act: 'timerResume', enabled: true } : { t: 'item', label: 'Pause', act: 'timerPause', enabled: true });
      items.push({ t: 'item', label: 'Add 5 minutes', act: 'timerAdd', ms: ADD_MS, enabled: true });
      items.push({ t: 'item', label: 'Cancel timer', act: 'timerCancel', confirm: 'Click again to cancel the timer', enabled: true });
      items.push({ t: 'sep' });
      items.push({ t: 'item', label: 'Start another', mn: 's', enabled: true,
        items: presetItems().concat([{ t: 'sep' }, { t: 'item', label: 'Stopwatch', act: 'timerStopwatch', enabled: true }]) });
    } else if (kind === 'stopwatch') {
      // words that hold still while it runs (the bar itself counts): the open menu is not redrawn every second
      items.push({ t: 'info', enabled: false, text: st.paused ? 'Stopwatch · paused at ' + cell.text : 'Stopwatch · running' });
      items.push(st.paused ? { t: 'item', label: 'Resume', act: 'timerResume', enabled: true } : { t: 'item', label: 'Pause', act: 'timerPause', enabled: true });
      items.push({ t: 'item', label: 'Reset to 0:00', act: 'timerStopwatch', enabled: true });
      items.push({ t: 'item', label: 'Stop stopwatch', act: 'timerCancel', confirm: 'Click again to stop the stopwatch', enabled: true });
      items.push({ t: 'sep' });
      items.push({ t: 'item', label: 'Start a timer', mn: 's', enabled: true, items: presetItems() });
    } else {
      items = presetItems();
      items.push({ t: 'sep' });
      items.push({ t: 'item', label: 'Custom…', act: 'timerCustom', key: '12 or 1:30', mn: 'c', enabled: true,
        placeholder: 'Minutes (12) or h:mm (1:30)', aria: 'Timer length', maxlength: 12 });
      items.push({ t: 'sep' });
      items.push({ t: 'item', label: 'Stopwatch', act: 'timerStopwatch', enabled: true });
    }
    if (!st) items.push({ t: 'info', bad: true, enabled: false, text: 'The timer has not answered yet: it may be switched off in the tray or not running' });
    if (st && st.persist && st.persist.ok === false) items.push({ t: 'info', bad: true, enabled: false, text: 'Not kept across a restart: ' + (st.persist.reason || 'the settings file cannot be written') });
    if (st && st.done && st.done.popup === 'failed') items.push({ t: 'info', bad: true, enabled: false, text: 'Timer done: ' + (st.done.label || '') + '. Its pop-up did not show: ' + (st.done.reason || 'no reason came back') });
    return items;
  }
  /* The notes button's look from notes.state {open, count, saved:{ok, reason}, file}. */
  function notesButton(st) {
    var bad = !!(st && st.saved && st.saved.ok === false);
    return {
      open: !!(st && st.open), bad: bad,
      title: bad ? 'Quick notes: NOT saved: ' + (st.saved.reason || 'no reason came back') : 'Quick notes (Win+Alt+N)' + (st && st.count ? ' · ' + st.count + (st.count === 1 ? ' note' : ' notes') : ''),
    };
  }

  return { layoutItems: layoutItems, layoutMenus: layoutMenus, appName: appName, cleanItems: cleanItems, newWindowArgs: newWindowArgs, appMenu: appMenu,
           titles: titles, fitTitles: fitTitles, MANTLE_MENU: MANTLE_MENU, pct: pct, gb: gb, rate: rate, statCells: statCells, base: base, peekMenu: peekMenu,
           timerCell: timerCell, timerMenu: timerMenu, notesButton: notesButton, clockAt: clockAt, TIMER_PRESETS: TIMER_PRESETS };
}));

/* model.js — Mantle Settings' pure logic (lane settings-ui, 2026-09-28; page: ui/settings/settings.js).
 *
 * WHY A SEPARATE FILE: the search ranking is the part of this page most likely to be wrong in a way
 * nobody sees ("night" finding Background before Night light), and it is only testable without a
 * DOM. So everything here is pure: the section and row registry (the row ids settings.nav and search
 * both use), the "More in Windows Settings" deep links, the search index and its scoring, and the
 * words the page prints for a value. No DOM, no IPC, no timers, no logging.
 *
 * UMD: the page reads it as the browser global SettingsModel; node requires it
 * (node ui/settings/model.test.js).
 *
 * SCORING, highest first (the order model.test.js pins):
 *   1000 the label IS the query        900 the label starts with it
 *    700 every query word starts a label word, in order     650 ... in any order
 *    600 the query is inside the label                      560 the query is a whole phrase of the keywords
 *    500 every query word starts a keyword                  100-300 the query's letters in order in the label
 * Ties: Mantle's own entries before Windows' pages, then section < row < feature < option <
 * shortcut < catalog, then the shorter label, then registry order.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SettingsModel = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---- the sections (the sidebar, in order) ---- */
  var SECTIONS = [
    { id: 'home', label: 'Home', group: null, keywords: 'overview at a glance start' },
    { id: 'display', label: 'Display', group: 'windows', keywords: 'screen monitor brightness night light resolution scale' },
    { id: 'sound', label: 'Sound', group: 'windows', keywords: 'audio volume speakers headphones output mixer' },
    { id: 'bluetooth', label: 'Bluetooth & devices', group: 'windows', keywords: 'bt devices paired headphones mouse keyboard' },
    { id: 'network', label: 'Network & Wi-Fi', group: 'windows', keywords: 'wifi wireless internet networks connection' },
    { id: 'power', label: 'Power & battery', group: 'windows', keywords: 'battery power mode energy saver charging' },
    { id: 'notifications', label: 'Notifications', group: 'windows', keywords: 'alerts do not disturb focus banners' },
    { id: 'apps', label: 'Apps', group: 'windows', keywords: 'startup installed apps default apps task manager programs' },
    { id: 'mantle', label: 'Mantle', group: 'mantle', keywords: 'features options mantle shell' },
    { id: 'shortcuts', label: 'Keyboard shortcuts', group: 'mantle', keywords: 'keys hotkeys chords shortcuts' },
    { id: 'about', label: 'About', group: 'mantle', keywords: 'version commit uptime logs' },
  ];

  /* ---- every static row (id, section, label, keywords). Dynamic rows (features, options,
     shortcuts) come from settings.mantle and are added by buildIndex. ---- */
  var ROWS = [
    ['display.brightness', 'Brightness', 'screen brightness dim bright backlight'],
    ['display.nightlight', 'Night light', 'blue light warm evening night mode color temperature'],
    ['display.monitors', 'Displays', 'monitor resolution scale scaling refresh rate hz orientation screen size'],
    ['sound.output', 'Output device', 'speakers headphones playback default device audio output'],
    ['sound.volume', 'Volume', 'sound level loudness mute speaker'],
    ['sound.input', 'Input device', 'microphone mic recording input'],
    ['sound.mixer', 'Volume mixer', 'app volume per app mixer apps sound'],
    ['bluetooth.radio', 'Bluetooth', 'bt radio wireless on off'],
    ['bluetooth.devices', 'Paired devices', 'bt headphones earbuds mouse keyboard controller connect disconnect battery pair'],
    ['network.wifi', 'Wi-Fi', 'wifi wireless wlan radio on off'],
    ['network.status', 'Connection', 'internet network status connected ethernet'],
    ['network.networks', 'Available networks', 'wifi networks ssid join connect disconnect scan'],
    ['power.mode', 'Power mode', 'performance efficiency balanced power plan'],
    ['power.saver', 'Energy saver', 'battery saver low power'],
    ['power.battery', 'Battery', 'battery percentage charge charging time left plugged in'],
    ['power.gamemode', 'Game mode', 'gaming games performance rest'],
    ['notifications.dnd', 'Do not disturb', 'dnd focus quiet hours silence notifications'],
    ['notifications.panels', 'Notification and quick settings panels', 'win n win a notification center action center quick settings'],
    ['apps.startup', 'Startup apps', 'startup autostart launch at login run at startup boot sign in'],
    ['apps.taskmgr', 'Task manager', 'task manager processes end task running apps cpu memory'],
    ['apps.installed', 'Installed apps', 'uninstall remove programs apps and features'],
    ['apps.defaults', 'Default apps', 'default browser file associations open with'],
    ['mantle.switcher', 'Window switcher (Alt+Tab)', 'alt tab switcher win n win a notification quick settings panels'],
    ['mantle.features', 'Mantle features', 'features tray switches on off'],
    ['mantle.corners', 'Hot corners', 'hot corners screen corners mouse corner actions task view show desktop'],
    ['shortcuts.list', 'Keyboard shortcuts', 'hotkeys keys chords shortcuts rebinding'],
    ['about.version', 'Version', 'about version build commit mantle'],
    ['about.uptime', 'Running since', 'uptime started running since restart'],
    ['about.runtime', 'Electron, Chromium, Node and Windows', 'electron chrome chromium node windows versions'],
    ['about.logs', 'Log folder', 'logs log file diagnostics troubleshooting'],
    ['about.windows', 'All Windows settings', 'windows settings control panel'],
  ].map(function (r) { return { id: r[0], section: r[0].split('.')[0], label: r[1], keywords: r[2] }; });

  /* "More in Windows Settings" at the foot of each section: pages it does not cover, from the
     launcher's catalog (lib/launcher-index.js SETTINGS) so every uri is a real page. */
  var MORE = {
    home: [['Windows Update', 'ms-settings:windowsupdate'], ['Personalization', 'ms-settings:personalization'],
      ['Privacy & security', 'ms-settings:privacy'], ['Accounts', 'ms-settings:yourinfo']],
    display: [['Scale & layout', 'ms-settings:display'], ['HDR', 'ms-settings:display-hdr'],
      ['Graphics', 'ms-settings:display-advancedgraphics'], ['Night light schedule', 'ms-settings:nightlight']],
    sound: [['Sound devices', 'ms-settings:sound-devices'], ['Volume mixer', 'ms-settings:apps-volume'],
      ['All sound settings', 'ms-settings:sound']],
    bluetooth: [['Add a device', 'ms-settings:bluetooth'], ['Devices', 'ms-settings:connecteddevices'],
      ['Mouse', 'ms-settings:mousetouchpad'], ['Printers & scanners', 'ms-settings:printers']],
    network: [['Known Wi-Fi networks', 'ms-settings:network-wifisettings'], ['Advanced network settings', 'ms-settings:network-advancedsettings'],
      ['VPN', 'ms-settings:network-vpn'], ['Airplane mode', 'ms-settings:network-airplanemode']],
    power: [['Screen and sleep', 'ms-settings:powersleep'], ['Energy saver', 'ms-settings:batterysaver-settings'],
      ['Power & battery', 'ms-settings:batterysaver']],
    notifications: [['Notifications', 'ms-settings:notifications'], ['Focus', 'ms-settings:quiethours']],
    apps: [['Startup apps', 'ms-settings:startupapps'], ['Advanced app settings', 'ms-settings:advanced-apps'],
      ['Apps for websites', 'ms-settings:appsforwebsites']],
    mantle: [['Multitasking', 'ms-settings:multitasking'], ['Clipboard', 'ms-settings:clipboard'], ['Taskbar', 'ms-settings:taskbar']],
    shortcuts: [['Keyboard', 'ms-settings:keyboard'], ['Accessibility keyboard', 'ms-settings:easeofaccess-keyboard']],
    about: [['About this PC', 'ms-settings:about'], ['Windows Update', 'ms-settings:windowsupdate']],
  };
  function more(section) { return (MORE[section] || []).map(function (m) { return { label: m[0], uri: m[1] }; }); }

  /* ---- row ids ---- */
  function featureRow(name) { return 'mantle.feature.' + name; }
  function optionRow(name, key) { return 'mantle.option.' + name + '.' + key; }
  function shortcutRow(keys) { return 'shortcuts.' + keys; }
  function sectionIds() { return SECTIONS.map(function (s) { return s.id; }); }
  function isSection(id) { return SECTIONS.some(function (s) { return s.id === id; }); }
  /** Which section a row id lives in ('mantle.option.gamemode.auto' -> 'mantle'), or null. */
  function sectionOf(rowId) {
    var s = String(rowId || '').split('.')[0];
    return isSection(s) ? s : null;
  }
  function rowById(id) { for (var i = 0; i < ROWS.length; i++) if (ROWS[i].id === id) return ROWS[i]; return null; }

  /* ---- search ---- */
  function norm(s) {
    return String(s == null ? '' : s).toLowerCase()
      .replace(/[&+,/()\[\]\-–—.:;'"!?_|]/g, ' ')
      .replace(/\s+/g, ' ').trim();
  }
  var KIND_RANK = { section: 0, row: 1, feature: 2, option: 3, shortcut: 4, catalog: 5 };

  /**
   * One index over the static rows, Mantle's features/options/shortcuts (settings.mantle) and the
   * ms-settings catalog (settings.catalog). A catalog page Mantle Settings covers WITH a row that is
   * already indexed does not get a second entry: its name and keywords join that row's instead.
   */
  function buildIndex(o) {
    o = o || {};
    var out = [], byId = Object.create(null), seq = 0;
    function add(e) {
      e.order = seq++;
      e.kw = e.kw || '';
      byId[e.id] = e;
      out.push(e);
    }
    SECTIONS.forEach(function (s) {
      add({ id: s.id, kind: 'section', group: 'mantle', label: s.label, sub: s.group === 'windows' ? 'Windows' : s.group === 'mantle' ? 'Mantle' : '', kw: s.keywords, section: s.id, row: null });
    });
    ROWS.forEach(function (r) {
      var sec = SECTIONS.filter(function (s) { return s.id === r.section; })[0];
      add({ id: r.id, kind: 'row', group: 'mantle', label: r.label, sub: sec ? sec.label : '', kw: r.keywords, section: r.section, row: r.id });
    });
    var m = o.mantle && typeof o.mantle === 'object' ? o.mantle : null;
    var feats = m && Array.isArray(m.features) ? m.features : [];
    feats.forEach(function (f) {
      if (!f || !f.name) return;
      var chords = Array.isArray(f.chords) ? f.chords.join(' ') : '';
      add({ id: featureRow(f.name), kind: 'feature', group: 'mantle', label: f.label || f.name, sub: 'Mantle feature', kw: f.name + ' ' + chords, section: 'mantle', row: featureRow(f.name) });
      (Array.isArray(f.options) ? f.options : []).forEach(function (op) {
        if (!op || !op.key) return;
        add({ id: optionRow(f.name, op.key), kind: 'option', group: 'mantle', label: op.label || op.key, sub: f.label || f.name, kw: (op.help || '') + ' ' + op.key + ' ' + f.name, section: 'mantle', row: optionRow(f.name, op.key) });
      });
    });
    (m && Array.isArray(m.shortcuts) ? m.shortcuts : []).forEach(function (s) {
      if (!s || !s.keys) return;
      add({ id: shortcutRow(s.keys), kind: 'shortcut', group: 'mantle', label: s.what || s.keys, sub: s.keys, kw: s.keys + ' ' + (s.ownerLabel || '') + ' shortcut', section: 'shortcuts', row: shortcutRow(s.keys) });
    });
    var cat = o.catalog && Array.isArray(o.catalog.items) ? o.catalog.items : Array.isArray(o.catalog) ? o.catalog : [];
    cat.forEach(function (it, i) {
      if (!it || !it.name) return;
      var mine = it.row && byId[it.row];
      if (mine) { mine.kw += ' ' + it.name + ' ' + (it.keywords || ''); return; }
      add({ id: 'catalog.' + (it.uri || i), kind: 'catalog', group: 'windows', label: it.name, sub: it.section ? 'Covered here' : 'Windows Settings',
        kw: it.keywords || '', uri: it.uri || 'ms-settings:', section: isSection(it.section) ? it.section : null, row: it.row || null });
    });
    out.forEach(function (e) { e.nl = norm(e.label); e.nk = norm(e.kw + ' ' + (e.kind === 'shortcut' ? e.sub : '')); });
    return out;
  }

  function wordsPrefix(qw, words, ordered) {
    var from = 0, used = [];
    for (var i = 0; i < qw.length; i++) {
      var hit = -1;
      for (var j = ordered ? from : 0; j < words.length; j++) {
        if (!ordered && used.indexOf(j) >= 0) continue;
        if (words[j].indexOf(qw[i]) === 0) { hit = j; break; }
      }
      if (hit < 0) return false;
      used.push(hit);
      from = hit + 1;
    }
    return true;
  }

  /** The query's letters in order inside s, starting at a word start and with few skipped letters
      ("nghtlt" -> "night light"): 150..300, more for tight runs and an early start; 0 if not. A
      loose subsequence ("night" in "sNap rIGHT") is noise, so the gaps are capped. */
  function fuzzy(q, s) {
    q = q.replace(/ /g, '');
    if (q.length < 2) return 0;
    var best = 0;
    for (var st = 0; st < s.length; st++) {
      if (s[st] !== q[0] || (st > 0 && s[st - 1] !== ' ')) continue;
      var at = st, gaps = 0, runs = 0, ok = true;
      for (var i = 1; i < q.length; i++) {
        var k = s.indexOf(q[i], at + 1);
        if (k < 0) { ok = false; break; }
        if (k !== at + 1) { gaps += k - at - 1; runs++; }
        at = k;
      }
      if (!ok || gaps > Math.max(3, q.length)) continue;
      best = Math.max(best, Math.max(150, 300 - gaps * 6 - runs * 10 - st * 4));
    }
    return best;
  }

  function score(e, qn) {
    if (!qn) return 0;
    var l = e.nl, qw = qn.split(' ');
    if (l === qn) return 1000;
    if (l.indexOf(qn) === 0) return 900;
    var words = l.split(' ');
    if (wordsPrefix(qw, words, true)) return 700;
    if (wordsPrefix(qw, words, false)) return 650;
    if (l.indexOf(qn) > 0) return 600;
    var k = ' ' + e.nk + ' ';
    if (k.indexOf(' ' + qn + ' ') >= 0) return 560;
    if (e.nk && wordsPrefix(qw, e.nk.split(' '), false)) return 500;
    return fuzzy(qn, l);
  }

  /** Ranked matches: [{entry, score}] best first. `limit` per group (default 12). */
  function search(index, query, limit) {
    var qn = norm(query), cap = limit || 12;
    if (!qn || !Array.isArray(index)) return [];
    var hits = [];
    index.forEach(function (e) { var s = score(e, qn); if (s > 0) hits.push({ entry: e, score: s }); });
    hits.sort(function (a, b) {
      return b.score - a.score
        || (a.entry.group === b.entry.group ? 0 : a.entry.group === 'mantle' ? -1 : 1)
        || KIND_RANK[a.entry.kind] - KIND_RANK[b.entry.kind]
        || a.entry.nl.length - b.entry.nl.length
        || a.entry.order - b.entry.order;
    });
    var n = { mantle: 0, windows: 0 };
    return hits.filter(function (h) { return ++n[h.entry.group] <= cap; });
  }

  /** The results as the page draws them: two groups, each in rank order, and one flat list (the
      arrow keys walk it: the groups top to bottom). */
  function grouped(hits) {
    var mantle = hits.filter(function (h) { return h.entry.group === 'mantle'; });
    var windows = hits.filter(function (h) { return h.entry.group === 'windows'; });
    return { mantle: mantle, windows: windows, flat: mantle.concat(windows) };
  }

  /* ---- words for values ---- */
  function plural(n, w, ws) { return n + ' ' + (n === 1 ? w : (ws || w + 's')); }
  function pct(n) { return typeof n === 'number' && isFinite(n) ? Math.round(n) + '%' : '—'; }

  /** "2 d 3 hr", "3 hr 4 min", "4 min", "12 s" */
  function dur(ms) {
    if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) return '—';
    var s = Math.floor(ms / 1000), d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
    if (d) return d + ' d ' + h + ' hr';
    if (h) return h + ' hr ' + m + ' min';
    if (m) return m + ' min';
    return (s % 60) + ' s';
  }

  /** The battery reading (sidecar/Battery.cs shape) in words, and whether it is a problem. */
  function batteryWords(b) {
    if (!b || typeof b !== 'object') return { text: 'Not read yet', warn: false, percent: null };
    if (b.ok === false) return { text: b.reason || 'The battery could not be read, and no reason came back', warn: true, percent: null };
    if (b.present === false || b.hasBattery === false) return { text: 'This PC has no battery: it always runs on mains power', warn: false, percent: null, none: true };
    var p = typeof b.percent === 'number' ? Math.round(b.percent) + '%' : null;
    var parts = [];
    if (b.charging) parts.push('charging');
    else if (b.ac) parts.push(b.percent >= 100 ? 'plugged in, full' : 'plugged in, not charging');
    else {
      parts.push('on battery');
      if (typeof b.secondsLeft === 'number') parts.push(dur(b.secondsLeft * 1000) + ' left');
    }
    if (b.saver) parts.push('energy saver on');
    var text = (p ? p + ' · ' : '') + parts.join(' · ');
    if (!p) text = 'Windows does not know the percentage yet' + (parts.length ? ' · ' + parts.join(' · ') : '');
    return { text: text, warn: false, percent: typeof b.percent === 'number' ? b.percent : null, reason: b.reason || null };
  }

  /** The network readout (net.get, sidecar/NetState.cs shape) in words. */
  function netWords(n) {
    if (!n || typeof n !== 'object') return { text: 'Not read yet', warn: false };
    if (n.ok === false) return { text: n.reason || 'The network could not be read, and no reason came back', warn: true };
    var w = n.wifi || {};
    if (n.kind === 'wifi' && w.connected) {
      return { text: 'Connected to ' + (w.ssid || 'Wi-Fi') + (w.band ? ' · ' + w.band : '') + (n.internet ? '' : ' · no internet'), warn: !n.internet };
    }
    if (n.kind === 'ethernet') return { text: 'Ethernet' + (n.internet ? '' : ' · no internet'), warn: !n.internet };
    if (n.state === 'wifi-off' || w.on === false) return { text: 'Wi-Fi is off, and nothing else is connected', warn: false };
    if (n.state === 'no-internet') return { text: 'Connected, but there is no internet', warn: true };
    return { text: 'Not connected', warn: false };
  }

  var PM_LABEL = { efficiency: 'Best power efficiency', balanced: 'Balanced', performance: 'Best performance' };

  /** A startup entry's command, short: the exe's file name and its arguments, cut to `max`. */
  function shortCommand(cmd, max) {
    var s = String(cmd || '').trim(), cap = max || 48;
    if (!s) return '';
    var exe, rest;
    if (s[0] === '"') {
      var end = s.indexOf('"', 1);
      exe = end > 0 ? s.slice(1, end) : s.slice(1);
      rest = end > 0 ? s.slice(end + 1).trim() : '';
    } else {
      var m = /^(.*?\.(?:exe|cmd|bat|com|lnk|ps1|vbs|js))(\s+.*)?$/i.exec(s);
      if (m) { exe = m[1]; rest = (m[2] || '').trim(); } else { var sp = s.indexOf(' '); exe = sp < 0 ? s : s.slice(0, sp); rest = sp < 0 ? '' : s.slice(sp + 1).trim(); }
    }
    var out = exe.split(/[\\/]/).pop() + (rest ? ' ' + rest : '');
    return out.length > cap ? out.slice(0, cap - 1).trimEnd() + '…' : out;
  }

  /** 'Win+Shift+S' -> ['Win', 'Shift', 'S'] (a literal '+' key stays a key). */
  function keyCaps(keys) {
    var s = String(keys || '');
    if (!s) return [];
    var parts = s.split('+');
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      if (parts[i] === '' && i + 1 < parts.length && parts[i + 1] === '') { out.push('+'); i++; continue; }
      if (parts[i] !== '') out.push(parts[i]);
    }
    return out;
  }

  function letter(name) {
    var m = /[A-Za-z0-9]/.exec(String(name || ''));
    return m ? m[0].toUpperCase() : '?';
  }

  /** A feature's one state line: tone ok | warn | off | rest, and the words. */
  function featureState(f) {
    if (!f) return { tone: 'warn', text: 'Mantle did not report this feature' };
    if (!f.enabled) return { tone: 'off', text: 'Off' };
    if (f.ok === false) return { tone: 'warn', text: f.reason || 'Not healthy, and it gave no reason' };
    if (f.resting) return { tone: 'rest', text: 'Resting while ' + String(f.resting).replace(/^while\s+/i, '') };
    if (f.stopped) return { tone: 'warn', text: 'Stopped' + (f.reason ? ': ' + f.reason : '') };
    if (f.keys === false) return { tone: 'warn', text: 'On, but its keys are Windows\' right now: ' + (f.keysReason || 'no reason came back') };
    var chords = Array.isArray(f.chords) && f.chords.length ? ' · ' + f.chords.join(', ') : '';
    return { tone: 'ok', text: (f.running === false ? 'On, starting' : 'On') + chords };
  }

  /** Home's Mantle tile: how many on, which are not healthy (with why), which rest. */
  function health(features) {
    var fs = Array.isArray(features) ? features : [];
    var on = fs.filter(function (f) { return f && f.enabled; });
    var bad = on.filter(function (f) { return f.ok === false || f.stopped || f.keys === false; }).map(function (f) {
      var keys = f.ok !== false && !f.stopped;
      return { name: f.name, label: f.label || f.name, reason: keys ? 'its keys are Windows\' right now: ' + (f.keysReason || 'no reason came back') : f.reason || 'no reason came back' };
    });
    var resting = on.filter(function (f) { return f.resting && f.ok !== false; }).map(function (f) { return { name: f.name, label: f.label || f.name, reason: f.resting }; });
    return { total: fs.length, on: on.length, off: fs.length - on.length, bad: bad, resting: resting };
  }

  /** The Apps section's Task manager row, from features.list: can it open, and if not, why. */
  function taskmgr(list) {
    var fs = Array.isArray(list) ? list : [];
    var f = fs.filter(function (x) { return x && x.name === 'taskmgr'; })[0];
    if (!f || !(Array.isArray(f.commands) && f.commands.indexOf('taskmgr.open') >= 0)) return { can: false, why: 'Mantle\'s task manager is not installed' };
    if (!f.enabled) return { can: false, why: 'Mantle\'s task manager is switched off (turn it on under Mantle)' };
    if (f.resting) return { can: false, why: 'Mantle\'s task manager is resting while ' + String(f.resting).replace(/^while\s+/i, '') };
    if (f.ok === false) return { can: false, why: 'Mantle\'s task manager is not healthy: ' + (f.reason || 'no reason came back') };
    if (f.running === false || f.stopped) return { can: false, why: 'Mantle\'s task manager is not running' + (f.reason ? ': ' + f.reason : '') };
    return { can: true, why: null };
  }

  /** How an option's current value reads (the folder's path, or its default's words). */
  function optionValue(o) {
    if (!o) return '';
    if (o.type === 'bool') return o.value ? 'On' : 'Off';
    if (o.type === 'choice') {
      var c = (o.choices || []).filter(function (x) { return x.value === o.value; })[0];
      return c ? c.label : String(o.value);
    }
    if (o.value === null || o.value === undefined || o.value === '') return o.defaultLabel || (o.default != null ? String(o.default) : 'Not set');
    return String(o.value) + (o.type === 'number' && o.unit ? ' ' + o.unit : '');
  }

  /** "Display 1 · 2560 x 1600 · 150% · 120 Hz" pieces for one display (settings.displays). */
  function displayFacts(d) {
    if (!d) return [];
    var rot = { 0: 'Landscape', 90: 'Portrait', 180: 'Landscape (flipped)', 270: 'Portrait (flipped)' };
    return [
      ['Resolution', d.width && d.height ? d.width + ' × ' + d.height : 'Not reported'],
      ['Scale', typeof d.scalePercent === 'number' ? d.scalePercent + '%' : 'Not reported'],
      ['Refresh rate', typeof d.hz === 'number' ? d.hz + ' Hz' : 'Not reported'],
      ['Orientation', rot[d.rotation] || (typeof d.rotation === 'number' ? d.rotation + '°' : 'Not reported')],
    ];
  }

  return {
    SECTIONS: SECTIONS, ROWS: ROWS, MORE: MORE, PM_LABEL: PM_LABEL,
    more: more, featureRow: featureRow, optionRow: optionRow, shortcutRow: shortcutRow, sectionIds: sectionIds, isSection: isSection,
    sectionOf: sectionOf, rowById: rowById,
    norm: norm, buildIndex: buildIndex, score: score, search: search, grouped: grouped, fuzzy: fuzzy,
    plural: plural, pct: pct, dur: dur, batteryWords: batteryWords, netWords: netWords, shortCommand: shortCommand,
    keyCaps: keyCaps, letter: letter, featureState: featureState, health: health, taskmgr: taskmgr, optionValue: optionValue,
    displayFacts: displayFacts,
  };
}));

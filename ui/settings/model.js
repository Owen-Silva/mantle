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
    { id: 'about', label: 'About Mantle', group: 'mantle', keywords: 'about version commit uptime logs' },
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
    ['mantle.keepready', 'Keep ready in the background', 'keep ready background preload prewarm memory ram instant open fast settings task manager files'],
    ['mantle.features', 'Mantle features', 'features tray switches on off'],
    ['mantle.corners', 'Hot corners', 'hot corners screen corners mouse corner actions task view show desktop'],
    ['shortcuts.list', 'Keyboard shortcuts', 'hotkeys keys chords shortcuts rebinding'],
    ['about.version', 'Mantle version', 'about version build commit mantle'],
    ['about.uptime', 'Running since', 'uptime started running since restart'],
    ['about.welcome', 'Welcome tour', 'welcome tour first run first start onboarding intro getting started show again keys switch back windows taskbar'],
    ['about.runtime', 'Electron, Chromium, Node and Windows', 'electron chrome chromium node windows versions'],
    ['about.logs', 'Log folder', 'logs log file diagnostics troubleshooting'],
    ['about.windows', 'All Windows settings', 'windows settings control panel'],
  ].map(function (r) { return { id: r[0], section: r[0].split('.')[0], label: r[1], keywords: r[2] }; });

  /* "More in Windows Settings" at the foot of each built-in section: related pages it does not
     cover, from the launcher's catalog (lib/launcher-index.js SETTINGS) so every uri is a real page.
     One a section module claims is drawn as a link to Mantle's page instead (more(section, model)). */
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
  /* With the section model: a page a section module now claims says where Mantle's own page is
     (`to` = { section, page, row }), and the page draws it as a link INTO Mantle Settings instead of
     out to Windows (lane wire, 2026-09-29: Owen, "nothing links out to ms-settings"). */
  function more(section, model) {
    return (MORE[section] || []).map(function (m) {
      var to = claimOf(model, m[1]);
      return to ? { label: m[0], uri: m[1], to: to } : { label: m[0], uri: m[1] };
    });
  }
  /** Which module page draws an ms-settings page now: { section, page, row }, or null (Windows' own
   *  is the only one: no module claims it, or the one that does is DOWN). */
  function claimOf(model, uri) {
    var c = model && model.claims ? model.claims[String(uri || '').toLowerCase()] : null;
    if (!c || !model.mods || !model.mods[c.section] || model.mods[c.section].down) return null;
    return { section: c.section, page: c.page, row: c.row };
  }

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

  /* ---- section modules (ui/settings/SECTIONS.md): ui/settings/sections/<id>.js each register one
     section; the category lanes build Windows' categories that way. Everything below is the PURE
     half: whether a definition is usable, and what the sidebar, deep links and search become once
     the modules are in. The page (settings.js / kit.js) loads, renders and disposes them. ---- */
  var REPLACEABLE = ['display', 'sound', 'bluetooth', 'network', 'power', 'notifications', 'apps'];
  /* The sidebar order. Built-ins sit where Windows 11 has them (Display, Sound, Notifications and
     Power are System's pages there), so a category module's `order` from the SECTIONS.md table lands
     next to the built-in it will absorb. */
  var ORDER = { home: 0, display: 10, sound: 11, notifications: 12, power: 13, bluetooth: 20, network: 30, apps: 50, mantle: 1000, shortcuts: 1010, about: 1020 };
  var SECTION_ID_RE = /^[a-z][a-z0-9-]{0,39}$/;
  var ROW_ID_RE = /^[A-Za-z0-9_.+-]{1,80}$/;          // = lib/features/settings.js ROW_RE (settings.open validates rows with it)
  var URI_RE = /^ms-settings:[a-z0-9-]*$/i;
  function builtinLabel(id) { var s = SECTIONS.filter(function (x) { return x.id === id; })[0]; return s ? s.label : id; }
  function checkSearch(list, where, seen) {
    if (list === undefined) return null;
    if (!Array.isArray(list)) return where + ' search must be a list of { row, label, keywords }';
    for (var i = 0; i < list.length; i++) {
      var e = list[i];
      if (!e || typeof e !== 'object') return where + ' search entry ' + i + ' is not an object';
      if (typeof e.row !== 'string' || !ROW_ID_RE.test(e.row)) return where + ' search entry ' + i + ' has no usable row id (letters, digits and _ . + - only, up to 80)';
      if (typeof e.label !== 'string' || !e.label.trim()) return where + ' search entry "' + e.row + '" has no label';
      if (e.keywords !== undefined && typeof e.keywords !== 'string') return where + ' search entry "' + e.row + '": keywords must be one string';
      if (e.uri !== undefined && !(typeof e.uri === 'string' && URI_RE.test(e.uri))) return where + ' search entry "' + e.row + '": uri must be an ms-settings: page';
      if (seen[e.row]) return 'the row id "' + e.row + '" is used twice';
      seen[e.row] = 1;
    }
    return null;
  }
  /* A section or a page may claim Windows Settings pages WITHOUT naming a row (`uri`: one
     ms-settings: page or a list of them): a category's own root (ms-settings:privacy is the Privacy &
     security overview, not any one row). Lane wire, 2026-09-29. */
  function checkUri(u, where) {
    if (u === undefined) return null;
    var l = [].concat(u);
    if (!l.length) return where + ' uri must be an ms-settings: page or a list of them';
    for (var i = 0; i < l.length; i++) if (!(typeof l[i] === 'string' && URI_RE.test(l[i]))) return where + ' uri must be an ms-settings: page or a list of them';
    return null;
  }
  /**
   * Why a registered section definition cannot be used, or null. `file` is the id its file name
   * gives (sections/<file>.js). Checks the SHAPE only; render() is not called here.
   */
  function checkSection(def, file) {
    if (!def || typeof def !== 'object') return 'it registered nothing usable (MantleSettings.section needs an object)';
    if (def.id !== file) return 'its id ' + JSON.stringify(def.id) + ' is not its file name "' + file + '"';
    if (!SECTION_ID_RE.test(def.id)) return 'its id must be lower-case letters, digits and -, starting with a letter';
    if (isSection(def.id)) return '"' + def.id + '" is a built-in section\'s id; take it over with replaces: \'' + def.id + '\' under a new id';
    if (typeof def.title !== 'string' || !def.title.trim()) return 'it has no title';
    if (def.group !== 'windows' && def.group !== 'mantle') return 'group must be "windows" or "mantle"';
    if (def.order !== undefined && !(typeof def.order === 'number' && isFinite(def.order))) return 'order must be a number';
    if (def.icon !== undefined && typeof def.icon !== 'string') return 'icon must be a built-in icon name or 16x16 SVG markup';
    var reps = def.replaces === undefined ? [] : [].concat(def.replaces);
    for (var i = 0; i < reps.length; i++) {
      if (REPLACEABLE.indexOf(reps[i]) < 0) return 'replaces ' + JSON.stringify(reps[i]) + ', which is not one of ' + REPLACEABLE.join(', ');
      if (reps.indexOf(reps[i]) !== i) return 'it replaces "' + reps[i] + '" twice';
    }
    var seen = Object.create(null), why = checkUri(def.uri, 'its') || checkSearch(def.search, 'its', seen);
    if (why) return why;
    if (def.pages === undefined) return typeof def.render === 'function' ? null : 'it has no pages and no render(el, kit)';
    if (!Array.isArray(def.pages) || !def.pages.length) return 'pages must be a non-empty list (or left out for a one-page section)';
    var ids = Object.create(null);
    for (var j = 0; j < def.pages.length; j++) {
      var p = def.pages[j];
      if (!p || typeof p !== 'object' || typeof p.id !== 'string' || !SECTION_ID_RE.test(p.id)) return 'page ' + j + ' has no usable id (lower-case letters, digits and -)';
      if (ids[p.id]) return 'the page id "' + p.id + '" is used twice';
      ids[p.id] = 1;
      var placeholder = reps.indexOf(p.id) >= 0 && p.render === undefined;
      if (!placeholder && typeof p.render !== 'function') return 'page "' + p.id + '" has no render(el, kit)' + (isSection(p.id) ? ' (to show the built-in ' + builtinLabel(p.id) + ' page here, replace it and leave render out)' : '');
      if (!placeholder && (typeof p.title !== 'string' || !p.title.trim())) return 'page "' + p.id + '" has no title';
      if (p.icon !== undefined && typeof p.icon !== 'string') return 'page "' + p.id + '": icon must be a built-in icon name or 16x16 SVG markup';
      why = checkUri(p.uri, 'page "' + p.id + '"') || checkSearch(p.search, 'page "' + p.id + '"', seen);
      if (why) return why;
    }
    return null;
  }

  /**
   * The sidebar, deep links and search with the modules in. `mods` = the registered definitions in
   * file-name order, or { id, title?, group?, down: 'why' } for one that is DOWN. Rules (SECTIONS.md):
   *  - a DOWN module is listed with its reason and replaces nothing;
   *  - replaces: the built-in leaves the sidebar and its slot, deep links and search go to the
   *    module. With pages, each replaced built-in becomes a page drawn by the built-in (a placeholder
   *    page { id: '<built-in>' } puts it where the module wants it, else the replaced built-ins come
   *    first); a module page with the built-in's id replaces its content too. Without pages, the
   *    module's render() supersedes the built-in whole;
   *  - two modules replacing one built-in: the first by file name wins, the second is DOWN.
   * -> { nav: [...], owner: { builtIn: { section, page, drawn } }, pages: { id: [...] | null },
   *      rows: { rowId: { section, page } }, mods: { id: entry } }
   */
  function sectionModel(mods) {
    var M = { nav: [], owner: Object.create(null), pages: Object.create(null), rows: Object.create(null), mods: Object.create(null), claims: Object.create(null) };
    var taken = Object.create(null);
    var list = [];
    // claims: ms-settings page (lower-case) -> { section, page, row } of the first module (by file
    // name) that claims it, on the section, a page or a row (lib/launcher-index.js sectionClaims()
    // reads the same files the same way, so the launcher and this page agree)
    function claim(uri, to) {
      [].concat(uri === undefined ? [] : uri).forEach(function (u) {
        if (typeof u !== 'string' || !URI_RE.test(u)) return;
        var k = u.toLowerCase();
        if (!M.claims[k]) M.claims[k] = to;
      });
    }
    (Array.isArray(mods) ? mods : []).forEach(function (m) {
      if (!m || typeof m.id !== 'string' || M.mods[m.id]) return;
      var down = m.down || null, reps = [];
      if (!down) {
        reps = m.replaces === undefined ? [] : [].concat(m.replaces);
        for (var i = 0; i < reps.length && !down; i++) if (taken[reps[i]]) down = 'it replaces ' + builtinLabel(reps[i]) + ', which the ' + taken[reps[i]] + ' section already replaces (the first file by name wins)';
        if (down) reps = [];
      }
      var e = { id: m.id, label: typeof m.title === 'string' && m.title.trim() ? m.title : m.id, group: m.group === 'mantle' ? 'mantle' : 'windows',
        icon: typeof m.icon === 'string' ? m.icon : null, help: typeof m.help === 'string' ? m.help : '', keywords: typeof m.keywords === 'string' ? m.keywords : '',
        order: typeof m.order === 'number' && isFinite(m.order) ? m.order : null, module: true, down: down, replaces: reps,
        search: !down && Array.isArray(m.search) ? m.search : [] };
      if (e.order === null) e.order = reps.length ? Math.min.apply(null, reps.map(function (r) { return ORDER[r]; })) : 500;
      M.mods[m.id] = e;
      list.push(e);
      if (down) { M.pages[m.id] = null; return; }
      reps.forEach(function (r) { taken[r] = e.label; });
      claim(m.uri, { section: m.id, page: null, row: null });
      (m.search || []).forEach(function (s) { M.rows[s.row] = { section: m.id, page: null }; claim(s.uri, { section: m.id, page: null, row: s.row }); });
      if (!Array.isArray(m.pages)) {
        M.pages[m.id] = null;
        reps.forEach(function (r) { M.owner[r] = { section: m.id, page: null, drawn: false }; });
        return;
      }
      var pages = [];
      var listed = Object.create(null);
      m.pages.forEach(function (p) { listed[p.id] = 1; });
      reps.forEach(function (r) { if (!listed[r]) pages.push({ id: r, title: builtinLabel(r), icon: r, help: '', builtin: true, search: [] }); });
      m.pages.forEach(function (p) {
        var builtin = reps.indexOf(p.id) >= 0 && typeof p.render !== 'function';
        pages.push({ id: p.id, title: typeof p.title === 'string' && p.title.trim() ? p.title : builtinLabel(p.id), icon: typeof p.icon === 'string' ? p.icon : builtin ? p.id : null,
          help: typeof p.help === 'string' ? p.help : '', builtin: builtin, search: Array.isArray(p.search) ? p.search : [] });
        claim(p.uri, { section: m.id, page: p.id, row: null });
        (p.search || []).forEach(function (s) { M.rows[s.row] = { section: m.id, page: p.id }; claim(s.uri, { section: m.id, page: p.id, row: s.row }); });
      });
      pages.forEach(function (p) { if (reps.indexOf(p.id) >= 0) M.owner[p.id] = { section: m.id, page: p.id, drawn: p.builtin }; });
      M.pages[m.id] = pages;
    });
    var all = SECTIONS.filter(function (s) { return !M.owner[s.id]; }).map(function (s) {
      return { id: s.id, label: s.label, group: s.group, icon: s.id, help: '', order: ORDER[s.id], module: false, down: null };
    }).concat(list);
    all.forEach(function (e, i) { e.seq = i; });
    all.sort(function (a, b) {
      var ga = a.group === 'mantle' ? 2 : a.group ? 1 : 0, gb = b.group === 'mantle' ? 2 : b.group ? 1 : 0;
      return ga - gb || a.order - b.order || (a.module === b.module ? 0 : a.module ? 1 : -1) || a.seq - b.seq;
    });
    M.nav = all;
    return M;
  }

  /**
   * Where a deep link lands: settings.open / settings.nav { section, page, row } -> { section (the
   * sidebar item), page (null = the section itself or its overview), view (the BUILT-IN view that
   * draws it, or null when a module draws it), row, down }. A row's own place wins over the
   * section named with it; a built-in id goes to the module that replaced it.
   */
  function resolve(model, n) {
    var Mo = model || sectionModel([]);
    n = n || {};
    var row = typeof n.row === 'string' && n.row ? n.row : null, sec = n.section || null, page = n.page || null;
    if (row && Mo.rows[row]) { sec = Mo.rows[row].section; page = Mo.rows[row].page; }
    else if (row) {
      var pre = row.split('.')[0];
      if (isSection(pre) || Mo.mods[pre]) { if (pre !== sec) page = null; sec = pre; }
    }
    if (sec && Mo.owner[sec]) { page = Mo.owner[sec].page; sec = Mo.owner[sec].section; }
    var m = sec ? Mo.mods[sec] : null;
    if (m) {
      if (m.down) return { section: sec, page: null, view: null, row: null, down: m.down };
      var pages = Mo.pages[sec];
      if (!pages) return { section: sec, page: null, view: null, row: row, down: null };
      var p = pages.filter(function (x) { return x.id === page; })[0];
      if (!p) return { section: sec, page: null, view: null, row: null, down: null };
      return { section: sec, page: p.id, view: p.builtin ? p.id : null, row: row, down: null };
    }
    if (sec && isSection(sec)) return { section: sec, page: null, view: sec, row: row, down: null };
    return { section: 'home', page: null, view: 'home', row: null, down: null };
  }

  /* ---- search ---- */
  function norm(s) {
    return String(s == null ? '' : s).toLowerCase()
      .replace(/[&+,/()\[\]\-–—.:;'"!?_|]/g, ' ')
      .replace(/\s+/g, ' ').trim();
  }
  var KIND_RANK = { section: 0, page: 1, row: 2, feature: 3, option: 4, shortcut: 5, catalog: 6 };

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
    // Section modules (o.model = sectionModel(...)): a built-in a module took over is a page of it
    // (still drawn by the built-in, so its rows stay), or gone when the module draws that content.
    var mo = o.model && o.model.mods ? o.model : null;
    var own = mo ? mo.owner : Object.create(null), claimed = Object.create(null);
    SECTIONS.forEach(function (s) {
      var ow = own[s.id];
      if (ow && !ow.drawn) return;
      if (ow) add({ id: s.id, kind: 'page', group: 'mantle', label: s.label, sub: mo.mods[ow.section].label, kw: s.keywords, section: s.id, row: null });
      else add({ id: s.id, kind: 'section', group: 'mantle', label: s.label, sub: s.group === 'windows' ? 'Windows' : s.group === 'mantle' ? 'Mantle' : '', kw: s.keywords, section: s.id, row: null });
    });
    ROWS.forEach(function (r) {
      if (own[r.section] && !own[r.section].drawn) return;
      var sec = SECTIONS.filter(function (s) { return s.id === r.section; })[0];
      add({ id: r.id, kind: 'row', group: 'mantle', label: r.label, sub: sec ? sec.label : '', kw: r.keywords, section: r.section, row: r.id });
    });
    if (mo) mo.nav.forEach(function (e) {
      if (!e.module) return;
      add({ id: 'section.' + e.id, kind: 'section', group: 'mantle', label: e.label, sub: e.down ? 'Down: ' + e.down : e.group === 'mantle' ? 'Mantle' : 'Windows', kw: e.keywords, section: e.id, row: null });
      if (e.down) return;
      function rows(list, page, sub) {
        list.forEach(function (s) {
          if (byId[s.row]) return;                          // a built-in row id reused on purpose: one entry
          add({ id: s.row, kind: 'row', group: 'mantle', label: s.label, sub: sub, kw: s.keywords || '', section: e.id, page: page, row: s.row });
        });
      }
      rows(e.search, null, e.label);
      (mo.pages[e.id] || []).forEach(function (p) {
        if (p.builtin) return;
        add({ id: 'page.' + e.id + '.' + p.id, kind: 'page', group: 'mantle', label: p.title, sub: e.label, kw: p.help || '', section: e.id, page: p.id, row: null });
        rows(p.search, p.id, e.label + ' › ' + p.title);
      });
    });
    // a claimed ms-settings page joins the entry that claims it: its row, else its page, else the
    // section itself (a category's root, e.g. ms-settings:privacy)
    if (mo && mo.claims) Object.keys(mo.claims).forEach(function (u) {
      var c = mo.claims[u];
      var hit = (c.row && byId[c.row]) || (c.page && (byId['page.' + c.section + '.' + c.page] || (own[c.page] && byId[c.page]))) || byId['section.' + c.section];
      if (hit) claimed[u] = hit;
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
      var mine = (it.row && byId[it.row]) || (it.uri && claimed[String(it.uri).toLowerCase()]);
      if (mine) { mine.kw += ' ' + it.name + ' ' + (it.keywords || ''); return; }
      var dead = it.section && own[it.section] && !own[it.section].drawn;   // its built-in is gone: land on the module
      // (a module's claim whose module is DOWN or missing lands here too: Windows' page is what opens)
      add({ id: 'catalog.' + (it.uri || i), kind: 'catalog', group: 'windows', label: it.name, sub: isSection(it.section) ? 'Covered here' : 'Windows Settings',
        kw: it.keywords || '', uri: it.uri || 'ms-settings:', section: isSection(it.section) ? it.section : null, row: dead ? null : it.row || null });
    });
    // A page whose own row has the page's name ("Game Mode" page, "Game Mode" switch on it) is ONE
    // result: the row, which lands on that page AND highlights the switch. Two identical lines in the
    // results read as a bug (quality pass 2026-09-29). The page's words (and Windows' name for it)
    // move to the row, so nothing that found the page stops finding it.
    var rowNamed = Object.create(null);
    out.forEach(function (e) { if (e.kind === 'row' && e.page) rowNamed[e.section + '/' + e.page + '/' + norm(e.label)] = e; });
    out = out.filter(function (e) {
      var r = e.kind === 'page' && e.page ? rowNamed[e.section + '/' + e.page + '/' + norm(e.label)] : null;
      if (r) { r.kw += ' ' + e.kw; r.asPage = true; }          // and ranks as the page did
      return !r;
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
        || KIND_RANK[a.entry.asPage ? 'page' : a.entry.kind] - KIND_RANK[b.entry.asPage ? 'page' : b.entry.kind]
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

  /* A feature that owns no chords at all (an explicitly empty list) has no keys to lose: lib/features.js
     reports it keys:false 'it takes no keys from Windows', which is not a fault (the lane wire sweep,
     2026-09-29, found 8 such features on Home's "needs a look" and the Mantle page). */
  function chordless(f) { return Array.isArray(f.chords) && f.chords.length === 0; }
  /** A feature's one state line: tone ok | warn | off | rest, and the words. */
  function featureState(f) {
    if (!f) return { tone: 'warn', text: 'Mantle did not report this feature' };
    if (!f.enabled) return { tone: 'off', text: 'Off' };
    if (f.ok === false) return { tone: 'warn', text: f.reason || 'Not healthy, and it gave no reason' };
    if (f.resting) return { tone: 'rest', text: 'Resting while ' + String(f.resting).replace(/^while\s+/i, '') };
    if (f.stopped) return { tone: 'warn', text: 'Stopped' + (f.reason ? ': ' + f.reason : '') };
    if (f.keys === false && !chordless(f)) return { tone: 'warn', text: 'On, but its keys are Windows\' right now: ' + (f.keysReason || 'no reason came back') };
    var chords = Array.isArray(f.chords) && f.chords.length ? ' · ' + f.chords.join(', ') : '';
    return { tone: 'ok', text: (f.running === false ? 'On, starting' : 'On') + chords };
  }

  /** Home's Mantle tile: how many on, which are not healthy (with why), which rest. */
  function health(features) {
    var fs = Array.isArray(features) ? features : [];
    var on = fs.filter(function (f) { return f && f.enabled; });
    /* a RESTING feature hands its keys back on purpose (lib/features.js: "Windows' own while Mantle
       rests"): that is a rest, not a fault, so it is only in resting (it was in both, which put every
       resting feature on Home's "needs a look" twice and lit the sidebar dot during a game) */
    var bad = on.filter(function (f) { return f.ok === false || (!f.resting && (f.stopped || (f.keys === false && !chordless(f)))); }).map(function (f) {
      var keys = f.ok !== false && !f.stopped;
      /* cause: a keys fault's reason WITHOUT its own chord list. lib/features.js writes every keysReason
         as "<chords>: <cause>", so one cause (Mantle has not taken the shell, the sidecar is down, a test
         run) reads different on every feature; Home groups the features by the cause and says it once
         (lane setlook). null when the reason is not in that shape. */
      var list = keys && Array.isArray(f.chords) ? f.chords.join(', ') : '';
      var kr = String(f.keysReason || '');
      var cause = list && kr.indexOf(list + ': ') === 0 && kr.length > list.length + 2 ? kr.slice(list.length + 2) : null;
      return { name: f.name, label: f.label || f.name, reason: keys ? 'its keys are Windows\' right now: ' + (f.keysReason || 'no reason came back') : f.reason || 'no reason came back',
        cause: cause, keys: keys ? list || null : null };
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

  /**
   * A reason in plain words (the polish bar: "no jargon on screen", and No Silent Failures: every
   * failure still says why and what to do next). Mantle's transport answers name its internals
   * ('could not send "sysdisplay.get" to the sidecar: it is not running (stopped, or restarting)',
   * 'the sidecar did not answer "x.y" within 10s', 'system.get failed (TypeError: ...)'). The plain
   * lead-in a section wrote before it ("The startup apps could not be read: ") is kept; the jargon
   * tail is replaced by what it means for a person. Text with no jargon comes back unchanged.
   */
  var JARGON_RE = /sidecar|"[a-z][a-z0-9-]*\.[A-Za-z][\w.]*"|\b[a-z][a-z0-9-]*\.[A-Za-z]\w* (?:failed|threw)\b|\bdryRun\b|\bE(?:NOENT|ACCES|PERM|PIPE|CONNRESET)\b|\b0x[0-9a-f]{6,8}\b|\bHRESULT\b|\[object Object\]|\bundefined\b|\bnull\b|\bNaN\b|window\.mantle/i;
  /* case-sensitive on purpose: a Win32 API name that failed ("GetSystemPowerStatus failed"), "Win32 error 5",
     and main's feature internals (r3 quality pass: these reached Home's tiles as they were) */
  var API_RE = /\b[A-Z][a-z]+[A-Z]\w* failed\b|\bWin32 error \d+|\bfeature seam\b|\bfeature is not running\b/;
  function jargon(t) { return JARGON_RE.test(t) || API_RE.test(t); }
  function plain(s) {
    if (s == null) return s;
    // a command name in front of a reason ("settings.mantle: ...", at the start or after a lead-in) says nothing to a person
    var t = String(s).replace(/(^|: )[a-z][a-z0-9-]{2,}\.[a-z]\w*: /g, '$1');
    // a technical aside in brackets goes when the words around it stand on their own
    // (only then: "x.get failed (the sidecar is not running)" keeps its brackets, whose words say what happened)
    var u = t.replace(/\s*\(([^()]*)\)/g, function (m, inner) { return jargon(inner) ? '' : m; });
    if (!jargon(u)) return u;
    var parts = t.split(/: /), keep = [];
    for (var i = 0; i < parts.length && !jargon(parts[i]); i++) keep.push(parts[i]);
    var rest = parts.slice(keep.length).join(': ');
    keep = keep.filter(function (k) { return !/^\s*refused\s*$/i.test(k); });
    var say;
    if (/passive/i.test(rest)) say = 'this is a test run, so nothing was changed';
    else if (/feature is not running|failed to start/i.test(rest)) say = 'this part of Mantle did not start. Restart Mantle to try again';
    else if (/did not answer|timed? ?out|within \d/i.test(rest)) say = 'Windows took too long to answer. Try again in a moment';
    else if (/not running|restarting|sidecar down|not finished starting|ready line|never said ready|exited|is not connected|window\.mantle/i.test(rest)) say = 'Mantle\'s connection to Windows is restarting. Try again in a moment';
    else if (/no \S+ command|unknown command|not a command/i.test(rest)) say = 'this needs a newer version of Mantle. Restart Mantle to finish updating it';
    else if (/\d+(\.\d+)? ?MB/.test(rest)) say = 'Windows sent back more than Mantle can show at once';
    else if (/E(?:ACCES|PERM)\b|0x80070005|access (is )?denied/i.test(rest)) say = 'Windows did not allow it: it needs administrator rights';
    else if (/ENOENT/.test(rest)) say = 'Windows could not find it any more. Refresh and try again';
    else if (/(?:failed|threw)\b|TypeError|ReferenceError|RangeError|\bundefined\b|\bnull\b|\bNaN\b|\[object/i.test(rest)) say = 'something went wrong inside Mantle. Try again; if it keeps happening, restart Mantle';
    else say = rest.replace(/the sidecar('s)?/gi, 'Mantle\'s connection to Windows$1').replace(/\s*"[a-z][a-z0-9-]*\.[A-Za-z][\w.]*"\s*/g, ' ')
      .replace(/\b0x[0-9a-f]{6,8}\b/gi, '').replace(/\bHRESULT\b/gi, 'error').replace(/\s{2,}/g, ' ').trim();
    return keep.length ? keep.join(': ') + ': ' + say : say.charAt(0).toUpperCase() + say.slice(1);
  }

  return {
    plain: plain,
    SECTIONS: SECTIONS, ROWS: ROWS, MORE: MORE, PM_LABEL: PM_LABEL,
    more: more, claimOf: claimOf, featureRow: featureRow, optionRow: optionRow, shortcutRow: shortcutRow, sectionIds: sectionIds, isSection: isSection,
    sectionOf: sectionOf, rowById: rowById,
    REPLACEABLE: REPLACEABLE, ORDER: ORDER, checkSection: checkSection, sectionModel: sectionModel, resolve: resolve,
    norm: norm, buildIndex: buildIndex, score: score, search: search, grouped: grouped, fuzzy: fuzzy,
    plural: plural, pct: pct, dur: dur, batteryWords: batteryWords, netWords: netWords, shortCommand: shortCommand,
    keyCaps: keyCaps, letter: letter, featureState: featureState, health: health, taskmgr: taskmgr, optionValue: optionValue,
    displayFacts: displayFacts,
  };
}));

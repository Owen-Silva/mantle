/* groups.js — how the launcher lays its rows out: in labelled GROUPS, keyboard-first.
 *
 * Win+S (the user, 2026-09-24) turned the launcher into the search for everything, so one flat list
 * of twelve stopped being readable: "blue" is an app, a Settings page and three files, and those
 * are three different kinds of Enter. Each kind gets a header; the arrow keys still walk ONE list
 * (the groups in order, their rows in order), so nothing about moving changed.
 *
 * ORDER, and why:
 *   Calculator   first, when the query IS arithmetic (calc.js decides): typing "2*17" means the answer
 *   ...          the rest by their BEST score, on apps.search's scale (a typed URL 1100, an exact name
 *                1000, a name prefix 820-900, a Settings keyword 700-880, files 500-700), so the group
 *                with the strongest match leads and Enter on the first row does what the typing meant.
 *                Ties keep the fixed order below (an app beats a file on a tie, as before).
 *   Files        while the index is still answering its best score is unknown, so it waits last
 *                (above Web) with a "Searching your files…" line, and moves up if its rows fit better
 *   Web          ALWAYS the last row: "Search the web for …" is the way out when nothing else fits.
 *
 * NO SILENT FAILURES: the Files group carries a status line — searching, the index's reason when it
 * cannot answer (the WSearch service stopped, the profile not indexed), or "no files match" once
 * it has looked — so an empty Files group never reads as "you have no such file".
 *
 * UMD: window.MantleGroups in the sandboxed page, require() in node tests.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MantleGroups = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var GROUPS = [
    // key, header, which item kinds, most rows shown
    { key: 'open', label: 'Website', kinds: ['url'], cap: 1 },
    { key: 'apps', label: 'Apps', kinds: ['app'], cap: 6 },
    { key: 'commands', label: 'Commands', kinds: ['command'], cap: 4 },
    { key: 'settings', label: 'Settings', kinds: ['setting'], cap: 4 },
    { key: 'power', label: 'Power', kinds: ['power'], cap: 6 },   // "power" shows every action
    { key: 'files', label: 'Files', kinds: ['file'], cap: 6 },
  ];
  var FIXED = {};
  GROUPS.forEach(function (g, i) { FIXED[g.key] = i; });

  var FILE_MIN = 2;
  // the label only: the URL itself is built in main (lib/launcher-index.js webSearchUrl), never here
  var ENGINE = { name: 'Google' };

  function webRow(q) {
    var text = String(q).trim();
    return {
      id: 'web:' + text.toLowerCase(),
      kind: 'web',
      name: 'Search the web for “' + text + '”',
      subtitle: ENGINE.name + ' · in your browser',
      path: text,
      icon: null,
    };
  }

  function calcRow(res) {
    if (!res) return null;
    return {
      id: 'calc:' + res.expr,
      kind: 'calc',
      name: res.ok ? '= ' + res.display : res.reason,
      subtitle: res.ok ? res.expr + (res.radians ? '  (angles in radians)' : '') : res.expr + ' · no answer',
      path: res.ok ? res.copy : '',
      copy: res.ok ? res.copy : null,
      expr: res.expr,                      // what Enter sends: main works the answer out again
      bad: !res.ok,
      icon: null,
    };
  }

  function scoreOf(it) { return typeof it.score === 'number' ? it.score : 0; }

  /* args:
   *   q            what is typed
   *   appRows      the apps.search answer (apps, commands, settings, power, a typed URL)
   *   fileRows     the file rows that still match what is typed
   *   fileState    { status: 'idle'|'ok'|'error', reason, n, ms }
   *   filePending  a file query for what is typed now is due or on its way
   *   calc         calc.js evaluate(q)'s answer, or null
   * returns { groups: [{ key, label, rows, status }], flat: [rows in on-screen order] }
   * status: null | { kind: 'pending'|'error'|'note'|'empty', text } */
  function build(args) {
    var q = String((args && args.q) || '').trim();
    var appRows = (args && args.appRows) || [];
    var fileRows = (args && args.fileRows) || [];
    var fileState = (args && args.fileState) || { status: 'idle' };
    var pending = !!(args && args.filePending);

    var out = [];
    var byKey = {};
    GROUPS.forEach(function (g) { byKey[g.key] = { key: g.key, label: g.label, rows: [], status: null, best: -Infinity }; });

    function place(it) {
      for (var i = 0; i < GROUPS.length; i++) {
        var g = GROUPS[i];
        if (g.kinds.indexOf(it.kind) < 0) continue;
        var slot = byKey[g.key];
        if (slot.rows.length >= g.cap && q) return;    // the empty launcher keeps its twelve
        slot.rows.push(it);
        slot.best = Math.max(slot.best, scoreOf(it));
        return;
      }
    }
    appRows.forEach(place);
    if (q.length >= FILE_MIN) fileRows.forEach(place);

    // the Files group's own line: what the index is doing, or why it is not
    var files = byKey.files;
    if (q.length >= FILE_MIN) {
      if (fileState.status === 'error') files.status = { kind: 'error', text: fileState.reason || 'the file search failed and gave no reason' };
      else if (pending && !files.rows.length) files.status = { kind: 'pending', text: 'Searching your files' };
      else if (fileState.status === 'ok' && !files.rows.length && !pending) files.status = { kind: 'empty', text: 'No files match' };
      else if (fileState.reason) files.status = { kind: 'note', text: fileState.reason };
      if (pending && files.rows.length) files.status = { kind: 'pending', text: 'Still searching' };
    }

    var ranked = GROUPS.map(function (g) { return byKey[g.key]; })
      .filter(function (g) { return g.rows.length || g.status; });
    ranked.sort(function (a, b) {
      // a group with rows ranks by its best row; one with only a status line goes to the end
      var sa = a.rows.length ? a.best : -Infinity, sb = b.rows.length ? b.best : -Infinity;
      if (sa !== sb) return sb - sa;
      return FIXED[a.key] - FIXED[b.key];
    });
    // the empty launcher is the user's commands then the apps, in that order, exactly as before
    if (!q) ranked.sort(function (a, b) { return (a.key === 'commands' ? 0 : 1) - (b.key === 'commands' ? 0 : 1); });

    var calc = calcRow(args && args.calc);
    if (calc) out.push({ key: 'calc', label: 'Calculator', rows: [calc], status: null });
    ranked.forEach(function (g) { out.push({ key: g.key, label: g.label, rows: g.rows, status: g.status }); });
    if (q) out.push({ key: 'web', label: 'Web', rows: [webRow(q)], status: null });

    var flat = [];
    out.forEach(function (g) { g.rows.forEach(function (r) { flat.push(r); }); });
    return { groups: out, flat: flat };
  }

  /* The first row of the group after (dir 1) or before (dir -1) the one row `sel` is in: Tab and
     Shift+Tab jump a whole group, so the Files group is one key away from the top. */
  function jumpGroup(groups, sel, dir) {
    var starts = [], at = 0, cur = 0;
    groups.forEach(function (g) {
      if (!g.rows.length) return;
      if (sel >= at && sel < at + g.rows.length) cur = starts.length;
      starts.push(at);
      at += g.rows.length;
    });
    if (!starts.length) return 0;
    var next = (cur + dir + starts.length) % starts.length;
    return starts[next];
  }

  return { build: build, jumpGroup: jumpGroup, ENGINE: ENGINE, GROUPS: GROUPS, FILE_MIN: FILE_MIN };
});

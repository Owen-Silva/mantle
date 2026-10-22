/* stats-view.js - the top bar's live stat cells, drawn cheaply (lane mantle-idlefix-stats, 2026-10-17).
 *
 * WHY: the 1 s sample (sidecar/TopbarStats.cs) rebuilt #right's innerHTML (every stat button and the tool
 * buttons), forced a layout with getBoundingClientRect and re-planned the colour under, once a second,
 * at rest. The rate is the user's ("i want it to update every 1 sec"); the cost per tick is not. So:
 *   PAGE (ui/topbar/topbar.js tickStats): a sample whose cells keep their set, order, labels, classes and
 *         width SHAPE only rewrites the text nodes (and tooltips) that changed: no innerHTML, no layout read,
 *         no under re-plan. Anything else is the full render, exactly as before.
 *   MAIN (lib/features/topbar.js onStats): a sample whose SHOWN cells (model.js statCells: the same
 *         formatting the page draws with) equal the last pushed one is not pushed, while no dropdown is
 *         open and no detail was asked; a heartbeat still pushes every HEARTBEAT_MS, and a pause, a resume
 *         or a dropdown opening always goes through.
 * WIDTH SHAPE: the cells are tabular figures (topbar.css .st: font-variant-numeric: tabular-nums), so two
 * values with the same characters once every digit is read as 0 ("7%" / "9%", "8.1/15.7 GB" / "8.2/15.7 GB")
 * are the same width; "9%" -> "10%", "999 KB/s" -> "1.0 MB/s" or "--" -> "4%" is a new shape: full render.
 * UMD: window.TopbarStatsView in the page (index.html), require()d by main and the node tests. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TopbarStatsView = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var HEARTBEAT_MS = 5000;

  /** One model.js stat cell as drawn: its class string, label, value and tooltip. */
  function view(c, openKey) {
    return {
      key: String(c.key),
      cls: 't st' + (c.why ? ' na' : '') + (c.warn ? ' hi' : '') + (openKey != null && openKey === c.key ? ' open' : ''),
      label: String(c.label),
      value: String(c.value == null ? '' : c.value),
      title: String(c.title || c.why || ''),
    };
  }
  function views(cells, openKey) { return (cells || []).map(function (c) { return view(c, openKey); }); }

  /** The button, byte for byte what renderStats drew before (the label is a constant, not escaped). */
  function cellHtml(v, esc) {
    return '<button class="' + v.cls + '" data-k="' + v.key + '" title="' + esc(v.title) + '"><span class="k">' + v.label +
      '</span><span class="v">' + esc(v.value) + '</span></button>';
  }

  /** The width shape of a value: every digit read as 0 (tabular figures: every digit is one width). */
  function shape(s) { return String(s).replace(/[0-9]/g, '0'); }

  /** prev -> next: null when the strip must be rebuilt (a cell added, gone or moved, a new label or class,
   *  a new width shape), else the cells whose text or tooltip changed: [{ i, value?, title? }]. */
  function diff(prev, next) {
    if (!prev || !next || prev.length !== next.length) return null;
    var out = [];
    for (var i = 0; i < next.length; i++) {
      var a = prev[i], b = next[i];
      if (a.key !== b.key || a.cls !== b.cls || a.label !== b.label || shape(a.value) !== shape(b.value)) return null;
      if (a.value !== b.value || a.title !== b.title) {
        var p = { i: i };
        if (a.value !== b.value) p.value = b.value;
        if (a.title !== b.title) p.title = b.title;
        out.push(p);
      }
    }
    return out;
  }

  /** The value's text node of a drawn cell (its .v span's only child), or null. */
  function valueNode(el) {
    var v = el && el.lastChild;
    if (!v || !v.classList || !v.classList.contains('v')) return null;
    var t = v.firstChild;
    return t && t.nodeType === 3 && !t.nextSibling ? t : null;
  }

  /** One sample into the cells drawn at the last render. st = { views, els } (renderStats keeps it).
   *  'same': nothing touched. 'patched': only the changed text nodes and tooltips were written.
   *  'rebuild': nothing touched; the caller renders the strip (and measures it) as before. */
  function tick(st, next) {
    if (!st || !st.views || !st.els || st.els.length !== st.views.length) return 'rebuild';
    var d = diff(st.views, next);
    if (!d) return 'rebuild';
    if (!d.length) return 'same';
    var i, el;
    for (i = 0; i < d.length; i++) {   // every target checked before anything is written: all or nothing
      el = st.els[d[i].i];
      if (!el || el.isConnected === false || !el.dataset || el.dataset.k !== next[d[i].i].key) return 'rebuild';
      if (d[i].value !== undefined && !valueNode(el)) return 'rebuild';
    }
    for (i = 0; i < d.length; i++) {
      el = st.els[d[i].i];
      if (d[i].value !== undefined) valueNode(el).nodeValue = d[i].value;
      if (d[i].title !== undefined) el.setAttribute('title', d[i].title);
    }
    st.views = next;
    return 'patched';
  }

  /** What the bar shows from one sample: model.js statCells' value, reason, tooltip and warn per cell. */
  function shownKey(cells) {
    return (cells || []).map(function (c) {
      return [c.key, c.label, c.value, c.why || '', c.title || '', c.warn ? 1 : 0].join('\u0001');
    }).join('\u0002');
  }

  /** Main's push gate. pass(key, now): key null = always push (a pause, a detail sample, a dropdown open)
   *  and forget the last; an equal key inside the heartbeat is held back. reset() after any push that did
   *  not go through it (statsOn's "paused"), so the next sample always reaches the page. */
  function pushGate(o) {
    var hb = (o && o.heartbeatMs) || HEARTBEAT_MS;
    var g = { last: null, lastAt: 0, sent: 0, held: 0, heldSince: 0 };
    g.pass = function (key, now) {
      if (key != null && key === g.last && now - g.lastAt < hb) { g.held++; g.heldSince++; return false; }
      g.last = key == null ? null : key; g.lastAt = now; g.sent++; g.heldSince = 0;
      return true;
    };
    g.reset = function () { g.last = null; g.lastAt = 0; g.heldSince = 0; };
    g.view = function () { return { heartbeatMs: hb, sent: g.sent, held: g.held, heldSince: g.heldSince, lastAt: g.lastAt || null }; };
    return g;
  }

  return { HEARTBEAT_MS: HEARTBEAT_MS, view: view, views: views, cellHtml: cellHtml, shape: shape, diff: diff, valueNode: valueNode,
           tick: tick, shownKey: shownKey, pushGate: pushGate };
}));

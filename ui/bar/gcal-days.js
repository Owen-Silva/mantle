/* gcal-days.js - the pure half of the calendar's Google events in the bar (lane mantle-gcal, 2026-10-16).
 *
 * Main pushes 'gcal.events' { ver, spans, calendars: [{ id, color, name }], events: [{ k, cal, title,
 * allDay, s, e }] } (lib/features/_gcal-sync.js eventsPayload). This file turns that into a day index ONCE,
 * when the push arrives, so opening the flyout is a Map lookup per day and never a walk over the events.
 * All-day s/e are 'YYYY-MM-DD' (e exclusive); timed s/e are epoch ms, placed on THIS PC's local days.
 * Loaded by the bar page before gcal.js, and by lib/features/gcal.test.js under node (module.exports).
 */
(function (root) {
  'use strict';
  var MAX_DAYS = 400;                      // one event is never walked over more days than this

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function keyOf(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function dateOf(key) { var p = key.split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function addDays(d, n) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); }

  /* The local days an event covers, as keys. A timed event ending exactly at midnight does not cover
     the next day; a zero-length one covers the day it starts. */
  function daysOf(ev) {
    var first, last;
    if (ev.allDay) {
      first = dateOf(ev.s);
      last = addDays(dateOf(ev.e), -1);
      if (last < first) last = first;
    } else {
      var s = new Date(ev.s), e = new Date(Math.max(ev.s, ev.e - 1));
      first = new Date(s.getFullYear(), s.getMonth(), s.getDate());
      last = new Date(e.getFullYear(), e.getMonth(), e.getDate());
    }
    var out = [];
    for (var d = first, i = 0; d <= last && i < MAX_DAYS; d = addDays(d, 1), i++) out.push(keyOf(d));
    return out;
  }

  function cmp(a, b) {
    if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
    if (a.allDay) return a.s < b.s ? -1 : a.s > b.s ? 1 : (a.title < b.title ? -1 : 1);
    return a.s - b.s || (a.title < b.title ? -1 : a.title > b.title ? 1 : 0);
  }

  /* -> { ver, days: Map key -> [ev], colors: { calId: '#rrggbb' | null }, names, spans } */
  function index(payload) {
    var p = payload || {};
    var colors = {}, names = {};
    (p.calendars || []).forEach(function (c) { colors[c.id] = c.color || null; names[c.id] = c.name || ''; });
    var days = new Map();
    (p.events || []).forEach(function (ev) {
      if (!ev || !(ev.cal in colors)) return;            // a calendar that was unticked
      daysOf(ev).forEach(function (k) {
        var l = days.get(k);
        if (!l) { l = []; days.set(k, l); }
        l.push(ev);
      });
    });
    days.forEach(function (l) { l.sort(cmp); });
    return { ver: p.ver || 0, days: days, colors: colors, names: names, spans: Array.isArray(p.spans) ? p.spans : [] };
  }

  /* The dot under a day: the calendar's colour when every event that day is from one calendar, the
     neutral ink when they come from several (or the colour is unknown). null = no dot. */
  function dotOf(idx, key) {
    var l = idx && idx.days.get(key);
    if (!l || !l.length) return null;
    var cal = l[0].cal;
    for (var i = 1; i < l.length; i++) if (l[i].cal !== cal) return { color: null, many: true, n: l.length };
    return { color: idx.colors[cal] || null, many: false, n: l.length };
  }

  /* 12-hour, the way the bar's clock reads (Owen asked for the Windows en-US style). */
  function hm(ms) {
    var d = new Date(ms), h = d.getHours(), mer = h < 12 ? 'AM' : 'PM';
    h = h % 12; if (h === 0) h = 12;
    return h + ':' + pad(d.getMinutes()) + ' ' + mer;
  }

  /* What the agenda row says for `ev` on day `key`: 'All day', a start time, or for a timed event that
     runs over several days 'Until 10:00 AM' on its last day and 'All day' on the days between. */
  function timeOf(ev, key) {
    if (ev.allDay) return 'All day';
    var startKey = keyOf(new Date(ev.s)), endKey = keyOf(new Date(Math.max(ev.s, ev.e - 1)));
    if (key === startKey) return hm(ev.s);
    if (key === endKey) return 'Until ' + hm(ev.e);
    return 'All day';
  }

  /* The tooltip: the full range in plain words. */
  function rangeOf(ev) {
    if (ev.allDay) {
      var last = addDays(dateOf(ev.e), -1);
      var s = dateOf(ev.s);
      var f = function (d) { return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }); };
      return keyOf(last) === ev.s ? 'All day' : 'All day, ' + f(s) + ' to ' + f(last);
    }
    var a = new Date(ev.s), b = new Date(ev.e);
    if (keyOf(a) === keyOf(new Date(Math.max(ev.s, ev.e - 1)))) return hm(ev.s) + ' to ' + hm(ev.e);
    var g = function (d) { return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) + ' ' + hm(d.getTime()); };
    return g(a) + ' to ' + g(b);
  }

  /* Does the cache cover the whole of this month? */
  function covers(idx, year, month) {
    var from = new Date(year, month, 1).getTime(), to = new Date(year, month + 1, 1).getTime();
    return !!idx && idx.spans.some(function (s) { return s.from <= from && s.to >= to; });
  }

  function ago(ms, now) {
    var s = Math.max(0, Math.round(((now || Date.now()) - ms) / 1000));
    if (s < 60) return 'just now';
    var m = Math.round(s / 60);
    if (m < 60) return m + ' min ago';
    var h = Math.round(m / 60);
    if (h < 48) return h + ' h ago';
    return Math.round(h / 24) + ' days ago';
  }

  var api = { index: index, dotOf: dotOf, daysOf: daysOf, timeOf: timeOf, rangeOf: rangeOf, covers: covers, ago: ago, keyOf: keyOf, dateOf: dateOf, addDays: addDays, hm: hm };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MantleGcalDays = api;
})(this);

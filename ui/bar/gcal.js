/* gcal.js - Google Calendar inside the clock's calendar flyout (lane mantle-gcal, 2026-10-16).
 *
 * The user, 10-16: the clock's calendar should sync with their Google Calendar (Sign in with Google, read-only).
 * Added INSIDE the existing flyout (bar.js buildCalPop), nothing else moved:
 *   - a small dot under each day that has events, in the calendar's colour (neutral when several
 *     calendars meet on one day);
 *   - the selected day's agenda below the month grid, above "Notifications": click a day to select it
 *     (today on every open); each row is the time (or "All day") and the title in the calendar's colour;
 *     a row opens the event in the default browser (gcal.open, main looks the link up); "No events";
 *   - not connected: one quiet row, "Connect Google Calendar", that opens Settings at the Google group;
 *   - offline / an error: the cached rows stay, with "Last synced 12 min ago · <reason>" under them.
 * Keyboard: arrow keys move the selected day (across months), Home / End the week's ends, PageUp /
 * PageDown the month; Enter on a day goes into its agenda, Up / Down walk it, Enter opens a row.
 *
 * COST: the open path does NO network and NO IPC. The day index is built when 'gcal.events' arrives
 * (gcal-days.js); opening is one Map lookup per day cell plus the selected day's rows. gcal.opened (a
 * refresh when the cache is over 2 minutes old) is sent only after the first frame.
 */
(function () {
  'use strict';
  var D = window.MantleGcalDays;
  var B = null;
  var status = null;             // main's last 'gcal.status'
  var idx = null;                // the day index of the last 'gcal.events'
  var payload = null, idxZone = '';  // ...the push it came from, and the time zone it was bucketed in
  var view = null;              // the open flyout's parts, null when closed
  var openNote = '';             // the last answer to a row click / a month ask, said in the status line
  var kbd = false, kbdGen = 0;

  function init(bridge) {
    B = bridge;
    if (!D) { B.fail('gcal', 'Google Calendar missing', 'the calendar shows no Google events', 'warn', 'gcal-days.js did not load'); return; }
    B.on('gcal.status', function (s) { status = s || null; if (view) paintAgenda(); });
    B.on('gcal.events', function (p) {
      payload = p; idx = D.index(p); idxZone = zone();
      if (view) { view.api.repaint(); paintAgenda(); }
    });
  }

  /* Timed events are bucketed into LOCAL days. If Windows' time zone changed since the last push, the
     next open re-buckets the same push (no network); otherwise the open path never rebuilds. */
  function zone() {
    var z = '';
    try { z = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) { z = ''; }
    return z + '|' + new Date().getTimezoneOffset();
  }
  function rezone() {
    if (!payload) return;
    var z = zone();
    if (z !== idxZone) { idx = D.index(payload); idxZone = z; }
  }

  function active() { return !!(status && status.enabled !== false); }
  function linked() { return active() && !!status.signedIn; }

  /* ------------------------------------------------------------------ mount (called by buildCalPop) */

  /* api: { pop, grid, step(n), shown(), repaint() } from bar.js. Returns the agenda node to put above
     the footer, or null when Google Calendar is off / unknown (nothing is added then). */
  function mount(api) {
    if (!B || !D || !active()) { view = null; return null; }
    rezone();
    var box = document.createElement('div'); box.className = 'gcal';
    view = { api: api, box: box, sel: D.keyOf(new Date()), asked: {} };
    api.pop.classList.add('gcal-on');
    api.grid.setAttribute('role', 'grid');
    api.grid.setAttribute('aria-label', 'Days: arrow keys move, Enter shows the day\'s events');
    api.grid.addEventListener('click', onDayClick);
    api.grid.addEventListener('keydown', onGridKey);
    box.addEventListener('keydown', onListKey);
    paintAgenda();
    /* After the first frame, never before it: the refresh-if-stale ask and the keyboard. */
    var v = view;
    requestAnimationFrame(function () {
      setTimeout(function () {
        if (view !== v) return;
        if (linked()) B.call('gcal.opened', {}).catch(function () {});
        keyboard(true);
      }, 0);
    });
    return box;
  }

  function closed() {
    if (view && view.focusWait) { view.focusWait.disconnect(); view.focusWait = null; }
    view = null; openNote = '';
    keyboard(false);
  }

  /* Each day cell, as bar.js paints the grid: its key, the roving tab stop, the selection and the dot. */
  function day(cell, date) {
    if (!view) return;
    var k = D.keyOf(date);
    cell.setAttribute('data-day', k);
    cell.setAttribute('role', 'gridcell');
    var sel = k === view.sel;
    cell.classList.toggle('sel', sel);
    cell.setAttribute('aria-selected', sel ? 'true' : 'false');
    cell.tabIndex = sel ? 0 : -1;
    var dot = idx && linked() ? D.dotOf(idx, k) : null;
    if (dot) {
      var s = document.createElement('span');
      s.className = 'gcal-dot' + (dot.color ? '' : ' many');
      if (dot.color) s.style.setProperty('--gc', dot.color);
      s.setAttribute('aria-hidden', 'true');
      cell.appendChild(s);
      cell.setAttribute('aria-label', cell.title + ', ' + dot.n + (dot.n === 1 ? ' event' : ' events'));
    }
  }

  /* After a grid paint (a month step): a month the cache does not hold is asked for, AFTER this frame. */
  function painted(shown) {
    if (!view) return;
    // the selected day is in another month: the grid still gets one tab stop (its 1st)
    if (!view.api.grid.querySelector('.calday[tabindex="0"]')) {
      var f = view.api.grid.querySelector('.calday:not(.other)');
      if (f) f.tabIndex = 0;
    }
    if (!linked() || !idx) return;
    var y = shown.getFullYear(), m = shown.getMonth(), key = y + '-' + m;
    if (D.covers(idx, y, m) || view.asked[key]) return;
    view.asked[key] = 'asking';
    var v = view;
    setTimeout(function () {
      if (view !== v) return;
      B.call('gcal.want', { year: y, month: m }).then(function (r) {
        if (view !== v) return;
        view.asked[key] = r && r.loading ? 'loading' : (r && r.reason ? 'no:' + r.reason : 'done');
        paintAgenda();
      }, function (e) { if (view === v) { view.asked[key] = 'no:' + B.msg(e); paintAgenda(); } });
    }, 0);
  }

  /* ------------------------------------------------------------------ selecting a day */

  function select(k, focus) {
    if (!view) return;
    var d = D.dateOf(k), shown = view.api.shown();
    view.sel = k;
    openNote = '';
    var diff = (d.getFullYear() - shown.getFullYear()) * 12 + d.getMonth() - shown.getMonth();
    if (diff) view.api.step(diff);                       // repaints the grid, which re-marks the selection
    else {
      var cells = view.api.grid.querySelectorAll('.calday[data-day]');
      for (var i = 0; i < cells.length; i++) {
        var on = cells[i].getAttribute('data-day') === k;
        cells[i].classList.toggle('sel', on);
        cells[i].setAttribute('aria-selected', on ? 'true' : 'false');
        cells[i].tabIndex = on ? 0 : -1;
      }
    }
    paintAgenda();
    if (focus) { var c = view.api.grid.querySelector('.calday[data-day="' + k + '"]'); if (c) c.focus(); }
  }

  function onDayClick(ev) {
    var c = ev.target.closest && ev.target.closest('.calday[data-day]');
    if (c) select(c.getAttribute('data-day'), false);
  }

  function onGridKey(ev) {
    if (!view) return;
    var c = ev.target.closest && ev.target.closest('.calday[data-day]');
    if (!c) return;
    var d = D.dateOf(c.getAttribute('data-day')), n = null;
    switch (ev.key) {
      case 'ArrowLeft': n = D.addDays(d, -1); break;
      case 'ArrowRight': n = D.addDays(d, 1); break;
      case 'ArrowUp': n = D.addDays(d, -7); break;
      case 'ArrowDown': n = D.addDays(d, 7); break;
      case 'Home': n = D.addDays(d, -d.getDay()); break;
      case 'End': n = D.addDays(d, 6 - d.getDay()); break;
      case 'PageUp': n = new Date(d.getFullYear(), d.getMonth() - 1, Math.min(d.getDate(), 28)); break;
      case 'PageDown': n = new Date(d.getFullYear(), d.getMonth() + 1, Math.min(d.getDate(), 28)); break;
      case 'Enter': case ' ': {
        ev.preventDefault();
        select(c.getAttribute('data-day'), false);
        var first = view.box.querySelector('.gcal-row, .gcal-connect');
        if (first) first.focus(); else c.focus();
        return;
      }
      default: return;
    }
    ev.preventDefault();
    select(D.keyOf(n), true);
  }

  function onListKey(ev) {
    if (!view || (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp')) return;
    var rows = Array.prototype.slice.call(view.box.querySelectorAll('.gcal-row'));
    var i = rows.indexOf(document.activeElement);
    if (i < 0) return;
    ev.preventDefault();
    if (ev.key === 'ArrowUp' && i === 0) {               // up out of the list: back to the day
      var c = view.api.grid.querySelector('.calday[data-day="' + view.sel + '"]');
      if (c) c.focus();
      return;
    }
    var j = Math.max(0, Math.min(rows.length - 1, i + (ev.key === 'ArrowDown' ? 1 : -1)));
    rows[j].focus();
  }

  /* ------------------------------------------------------------------ the agenda */

  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }

  function dayTitle(k) {
    var d = D.dateOf(k), t = new Date();
    if (k === D.keyOf(t)) return 'Today';
    if (k === D.keyOf(D.addDays(t, 1))) return 'Tomorrow';
    if (k === D.keyOf(D.addDays(t, -1))) return 'Yesterday';
    return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  }

  function paintAgenda() {
    if (!view) return;
    var box = view.box;
    var focusK = document.activeElement && box.contains(document.activeElement) ? document.activeElement.getAttribute('data-k') || 'connect' : null;
    box.textContent = '';
    if (!active()) { box.hidden = true; return; }
    box.hidden = false;

    if (!status.signedIn) {
      /* Not connected: ONE quiet row. Settings says the rest (the client file, the sign-in). */
      var c = el('button', 'qslink gcal-connect', 'Connect Google Calendar');
      c.type = 'button';
      c.title = 'Open Mantle Settings to sign in with Google (read-only)';
      c.addEventListener('click', function () {
        B.call('settings.open', { section: 'time', page: 'datetime', row: 'time.datetime.gcal', via: 'the calendar' }).then(function (r) {
          if (r && r.ok === false) { openNote = 'Settings did not open: ' + (r.reason || 'no reason came back'); paintAgenda(); }
          else B.closePop();
        }, function (e) { openNote = 'Settings did not open: ' + B.msg(e); paintAgenda(); });
      });
      box.appendChild(c);
      if (openNote) box.appendChild(el('div', 'gcal-note', openNote));
      if (focusK) c.focus();
      return;
    }

    box.appendChild(el('div', 'gcal-head', dayTitle(view.sel)));
    var list = el('div', 'gcal-list');
    list.setAttribute('role', 'list');
    var evs = (idx && idx.days.get(view.sel)) || [];
    var shown = view.api.shown();
    var monthKey = shown.getFullYear() + '-' + shown.getMonth();
    var selD = D.dateOf(view.sel);
    var selCovered = !!idx && idx.spans.some(function (s) { return s.from <= selD.getTime() && s.to > selD.getTime(); });
    if (!evs.length) {
      list.appendChild(el('div', 'gcal-empty', selCovered || !idx ? 'No events' : 'Not loaded yet'));
    }
    evs.forEach(function (ev) {
      var r = el('button', 'gcal-row');
      r.type = 'button';
      r.setAttribute('role', 'listitem');
      r.setAttribute('data-k', ev.k);
      var col = idx.colors[ev.cal];
      if (col) r.style.setProperty('--gc', col);
      r.appendChild(el('span', 'gcal-bar'));
      r.appendChild(el('span', 'gcal-time', D.timeOf(ev, view.sel)));
      r.appendChild(el('span', 'gcal-title', ev.title));
      r.title = ev.title + '\n' + D.rangeOf(ev) + (idx.names[ev.cal] ? '\n' + idx.names[ev.cal] : '') + '\nClick: open in your browser';
      r.addEventListener('click', function () { openEvent(ev); });
      list.appendChild(r);
    });
    box.appendChild(list);

    var line = statusLine(monthKey, D.covers(idx, shown.getFullYear(), shown.getMonth()), shown);
    if (line) {
      var n = el('div', 'gcal-note', line);
      n.setAttribute('role', 'status');
      n.title = line;
      box.appendChild(n);
    }
    if (focusK) {
      var back = box.querySelector('.gcal-row[data-k="' + (window.CSS && CSS.escape ? CSS.escape(focusK) : focusK) + '"]') || box.querySelector('.gcal-row');
      if (back) back.focus();
    }
  }

  /* The quiet line under the list: only when something is not as it should be, and always with why. */
  function statusLine(monthKey, monthCovered, shown) {
    var s = status, parts = [];
    if (openNote) return openNote;
    var asked = view.asked[monthKey];
    if (s.needsSignIn) parts.push(s.error && s.error.reason ? s.error.reason : 'Google ended Mantle\'s sign-in; sign in again in Settings');
    else if (s.error && s.error.reason) parts.push(s.error.reason);
    else if (s.syncing && !s.syncedAt) return 'Syncing with Google…';
    var mname = shown.toLocaleDateString(undefined, { month: 'long' });
    if (!parts.length && !monthCovered && (asked === 'loading' || asked === 'asking')) return 'Loading ' + mname + ' from Google…';
    if (!monthCovered && asked && asked.indexOf('no:') === 0) parts.push(mname + ' is not on this PC yet (' + asked.slice(3) + ')');
    if (!parts.length) return '';
    return (s.syncedAt ? 'Last synced ' + D.ago(s.syncedAt) : 'Not synced yet') + ' · ' + parts.join('; ');
  }

  function openEvent(ev) {
    B.call('gcal.open', { event: ev.k }).then(function (r) {
      if (r && r.ok === false) { openNote = 'The event did not open: ' + (r.reason || 'no reason came back'); paintAgenda(); return; }
      if (r && r.dryRun) { openNote = r.reason || 'test run: the browser is not opened'; paintAgenda(); return; }
      B.closePop();
    }, function (e) { openNote = 'The event did not open: ' + B.msg(e); paintAgenda(); });
  }

  /* ------------------------------------------------------------------ the keyboard (as downloads.js) */

  function keyboard(on) {
    var gen = ++kbdGen;
    if (!on) {
      if (kbd) { kbd = false; B.call('qs.keyboard', { on: false }).catch(function () {}); }
      return;
    }
    B.call('qs.keyboard', { on: true }).then(function (r) {
      var got = !!(r && r.ok);
      if (gen !== kbdGen || !view) { if (got) B.call('qs.keyboard', { on: false }).catch(function () {}); return; }
      kbd = got;
      view.api.grid.title = got ? '' : 'Arrow keys do not reach this calendar: ' + String((r && r.reason) || 'Windows kept the keyboard on another window').split(', so ')[0];
      if (got) focusSel(view, false);
    }, function (e) { if (gen === kbdGen && view) view.api.grid.title = 'Arrow keys do not reach this calendar: ' + B.msg(e); });
  }

  /* The selected day takes the keyboard focus. In the dark theme bar.js holds the flyout unpainted
     (.bdwait = visibility: hidden) until its backdrop picture lands, at most POP_BD_WAIT_MS (250 ms), and
     a hidden element cannot take focus. So when the focus does not take, it is given ONCE more when the
     hold ends; the wait is dropped on close and after 1.5 s whatever happens. */
  function focusSel(v, last) {
    if (view !== v || !kbd) return;
    var c = v.api.grid.querySelector('.calday[data-day="' + v.sel + '"]');
    if (!c || v.box.contains(document.activeElement)) return;
    c.focus({ preventScroll: true });
    if (document.activeElement === c || last || v.focusWait || typeof MutationObserver !== 'function') return;
    var mo = new MutationObserver(function () {
      if (view !== v) { drop(); return; }
      if (!v.api.pop.classList.contains('bdwait')) { drop(); focusSel(v, true); }
    });
    var stopT = setTimeout(drop, 1500);
    function drop() { mo.disconnect(); clearTimeout(stopT); if (v.focusWait === mo) v.focusWait = null; }
    v.focusWait = mo;
    mo.observe(v.api.pop, { attributes: true, attributeFilter: ['class'] });
  }

  window.MantleGcal = { init: init, mount: mount, day: day, painted: painted, closed: closed,
    _state: function () { return { status: status, idx: idx, view: view, kbd: kbd }; } };
})();

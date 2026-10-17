/*
 * ui/bar/notifications.js — Mantle's notification centre: the bell's panel (Owen, 2026-09-22).
 *
 * Windows 11 keeps its bell right of the clock and opens a list of what apps have said, grouped
 * by app, newest first. This is that list on Mantle's glass. Main pushes 'notifications' (see
 * lib/notifications.js; the sidecar's Notifications.cs has the measurements) only when the set
 * changes, and replays it on subscribe, so the bell is right from the first frame.
 *
 * WHAT IT DOES
 *   - the bell carries a count of what arrived since the panel was last opened (Windows' rule);
 *     opening the panel marks everything in it seen
 *   - grouped by app, newest group first; each toast: the app's picture (or the sender's, when
 *     the toast brought one), title, body, attribution, age, and a hero picture when it has one
 *   - an × per toast, an × per app (dismiss all of that app), and Clear all
 *   - a click opens it the way Windows would, as far as Windows lets another app: a link toast
 *     opens its link; anything else starts the app (the reply's note says the app will not be
 *     told which notification it was); a toast Mantle cannot open says why in its tooltip and
 *     does not pretend to be clickable
 *   - "No notifications" when there are none; the reason, in words, when they cannot be read
 *   - Windows' own centre stays one click away at the bottom (Win+N), because "Mantle does most
 *     of it" is only honest if the rest is reachable
 *
 * NO SILENT FAILURES: a list that cannot be read turns the bell muted with the reason in its
 * tooltip, puts a chip in the bar's strip (the ⋯ menu in pill mode), and says it in the panel. A
 * dismissal or an open that fails says why inside the panel. A slower or plainer source (no
 * database: text only, a 5 s poll) is named at the bottom of the panel — not a failure, but not
 * hidden either.
 *
 * bar.js hands this file its popover and bridge helpers (MantleNotifs.init), so the panel opens,
 * sizes, closes and reports exactly like every other popover.
 */
(function () {
  'use strict';

  var KEY = 'notifs';
  var B = null;                 // the bar's helpers, from init()
  var data = null;              // main's last 'notifications' payload
  var btn = null, badge = null;
  var paint = null;             // repaints the open panel in place; null while it is closed
  var room = 0;                 // the popover height last asked of main
  var busy = Object.create(null);   // 'id:<n>' | 'app:<aumid>' | 'all' -> true while in flight
  var note = '';                // the last action's failure, shown until the next action
  var wasUnread = Object.create(null);  // ids that were unread when the panel opened (their dot stays)
  var ticker = 0;               // re-renders the ages while the panel is open

  function init(helpers) {
    B = helpers;
    btn = document.getElementById('notifs');
    if (!btn) return;
    badge = btn.querySelector('.nbadge');
    btn.addEventListener('click', open);
    btn.addEventListener('contextmenu', function (ev) { ev.preventDefault(); open(); });
    renderBell();
    B.on('notifications', update, function (reason) {
      data = { ok: false, available: false, reason: 'the bar cannot hear about notifications: ' + reason, toasts: [], unread: 0, count: 0 };
      renderBell(); health();
    });
  }

  function update(p) {
    data = p || null;
    renderBell();
    health();
    if (paint && B.popKey() === KEY) {
      seeAll();          // it arrived while Owen is looking at the list: it is seen
      paint();
    }
  }

  function toasts() { return (data && Array.isArray(data.toasts)) ? data.toasts : []; }

  /* ------------------------------------------------------------------ the bell */

  function renderBell() {
    if (!btn) return;
    var list = toasts();
    var unread = data && typeof data.unread === 'number' ? data.unread : 0;
    var bad = data && data.ok === false;
    btn.classList.toggle('off', !!bad);
    btn.classList.toggle('some', list.length > 0);
    btn.classList.toggle('new', !bad && unread > 0);
    if (badge) {
      badge.hidden = bad || unread < 1;
      badge.textContent = unread > 9 ? '9+' : String(unread);
    }
    btn.title = !data ? 'Notifications — reading…'
      : bad ? 'Notifications unavailable — ' + (data.reason || 'no reason was given')
      : list.length === 0 ? 'Notifications — none'
      : 'Notifications — ' + list.length + (unread ? ' (' + unread + ' new)' : '');
    btn.setAttribute('aria-label', btn.title);
  }

  /* A list that cannot be read is a chip in the strip, not only a muted bell. */
  function health() {
    if (data && data.ok === false) B.fail('notifs', 'notifications off', data.reason || 'the notification list could not be read and no reason was given', 'warn');
    else B.clearFail('notifs');
  }

  /* ------------------------------------------------------------------ the panel */

  function open() {
    B.openPop(KEY, btn, build);
    if (B.popKey() !== KEY) { stopTicker(); return; }   // it was open, and that click closed it
    wasUnread = Object.create(null);
    toasts().forEach(function (t) { if (t.unread) wasUnread[t.id] = true; });
    seeAll();
    if (!data) B.call('notifs.get').then(update, function (e) { note = 'could not read the notifications: ' + B.msg(e); if (paint) paint(); });
    startTicker();
  }

  function seeAll() {
    var ids = toasts().filter(function (t) { return t.unread; }).map(function (t) { return t.id; });
    if (!ids.length) return;
    B.call('notifs.seen', { ids: ids }).catch(function (e) {
      note = 'could not mark these as seen, so the bell may keep counting them: ' + B.msg(e);
      if (paint) paint();
    });
  }

  function startTicker() {
    stopTicker();
    ticker = setInterval(function () {
      if (!paint || B.popKey() !== KEY) { stopTicker(); paint = null; return; }
      paint();
    }, 30000);
  }
  function stopTicker() { if (ticker) { clearInterval(ticker); ticker = 0; } }

  function mk(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }

  /* The empty state's icon tile (ui/shared/empty-state.css, the one recipe every Mantle empty state
     uses): a 16-unit line glyph drawn at 18 px in a quiet 40 px raised tile, above the title. */
  var SVG_NS = 'http://www.w3.org/2000/svg';
  var BELL = ['M8 2.2a3.9 3.9 0 0 0-3.9 3.9v2.6L2.9 11h10.2l-1.2-2.3V6.1A3.9 3.9 0 0 0 8 2.2Z', 'M6.4 12.9a1.7 1.7 0 0 0 3.2 0'];
  function esTile(paths) {
    var tile = mk('div', 'es-tile');
    tile.setAttribute('aria-hidden', 'true');
    var s = document.createElementNS(SVG_NS, 'svg');
    [['viewBox', '0 0 16 16'], ['width', '18'], ['height', '18'], ['fill', 'none'], ['stroke', 'currentColor'],
      ['stroke-width', '1.3'], ['stroke-linecap', 'round'], ['stroke-linejoin', 'round'], ['focusable', 'false']]
      .forEach(function (a) { s.setAttribute(a[0], a[1]); });
    paths.forEach(function (d) { var p = document.createElementNS(SVG_NS, 'path'); p.setAttribute('d', d); s.appendChild(p); });
    tile.appendChild(s);
    return tile;
  }

  function xButton(tip, onClick) {
    var x = mk('button', 'x ntf-x', '×');
    x.type = 'button';
    x.title = tip;
    x.setAttribute('aria-label', tip);
    x.addEventListener('click', function (ev) { ev.stopPropagation(); onClick(); });
    return x;
  }

  /* "now", "4 min", "2 h", then the day. The age is Windows' creation time, or the time the app
     itself stamped on the toast. */
  function ago(ms) {
    if (!ms) return '';
    var d = Date.now() - ms;
    if (d < 60000) return 'now';
    if (d < 3600000) return Math.floor(d / 60000) + ' min ago';
    if (d < 6 * 3600000) return Math.floor(d / 3600000) + ' h ago';
    var t = new Date(ms), n = new Date();
    var time = t.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    if (t.toDateString() === n.toDateString()) return time;
    var y = new Date(n.getFullYear(), n.getMonth(), n.getDate() - 1);
    if (t.toDateString() === y.toDateString()) return 'Yesterday ' + time;
    return t.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ', ' + time;
  }

  function appIcon(t, cls) {
    if (t.icon) {
      var img = mk('img', cls);
      img.alt = '';
      img.src = t.icon;
      return img;
    }
    var l = mk('span', cls + ' ntf-letter', (t.app || '?').trim().charAt(0).toUpperCase() || '?');
    l.setAttribute('aria-hidden', 'true');
    return l;
  }

  /* Groups by app, in the order of each app's newest toast (the list arrives newest first). */
  function groups(list) {
    var out = [], at = Object.create(null);
    list.forEach(function (t) {
      var k = String(t.aumid || t.app || '?').toLowerCase();
      if (!(k in at)) { at[k] = out.length; out.push({ aumid: t.aumid, app: t.app, first: t, items: [] }); }
      out[at[k]].items.push(t);
    });
    return out;
  }

  function act(key, channel, payload, what) {
    busy[key] = true;
    note = '';
    if (paint) paint();
    return B.callR(channel, payload).then(function (r) {
      delete busy[key];
      if (r && r.failed && r.failed.length) note = what + ': ' + (r.reason || 'Windows kept some of them');
      if (paint) paint();
      return r;
    }, function (e) {
      delete busy[key];
      note = what + ' failed: ' + B.msg(e);
      if (paint) paint();
      throw e;
    });
  }

  function openToast(t) {
    if (t.opens === 'none') return;
    act('id:' + t.id, 'notifs.open', { id: t.id }, 'Could not open ' + (t.app || 'it')).then(function (r) {
      /* Windows closes its centre when a notification is clicked; so does Mantle. A note (the
         app was started but not told which notification) is not a failure worth keeping it open. */
      if (r && r.ok !== false) B.closePop();
    }, function () { /* already on screen as the note */ });
  }

  function card(t) {
    var c = mk('div', 'ntf-card' + (wasUnread[t.id] ? ' unread' : '') + (t.opens === 'none' ? ' dead' : '') + (busy['id:' + t.id] ? ' busy' : ''));
    c.setAttribute('role', 'listitem');
    if (t.opens !== 'none') {
      c.tabIndex = 0;
      c.title = t.opens === 'protocol'
        ? 'Open — goes where ' + (t.app || 'the app') + ' pointed this notification'
        : 'Open ' + (t.app || 'the app') + ' (Windows would also tell it which notification this was; Mantle cannot pass that on yet)';
      c.addEventListener('click', function () { openToast(t); });
      c.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') openToast(t); });
    } else {
      c.title = 'Mantle cannot open this one: ' + (t.opensWhy || 'no reason was given');
    }

    var row = mk('div', 'ntf-row');
    if (t.logo) {
      var logo = mk('img', 'ntf-logo' + (t.logoCircle ? ' circle' : ''));
      logo.alt = '';
      logo.src = t.logo;
      row.appendChild(logo);
    }
    var text = mk('div', 'ntf-text');
    text.appendChild(mk('div', 'ntf-title', t.title || t.app || 'Notification'));
    if (t.body) text.appendChild(mk('div', 'ntf-body', t.body));
    var meta = [t.attribution, ago(t.timeMs)].filter(Boolean).join(' · ');
    if (meta) text.appendChild(mk('div', 'ntf-meta', meta));
    row.appendChild(text);
    row.appendChild(xButton('Dismiss', function () {
      act('id:' + t.id, 'notifs.remove', { ids: [t.id] }, 'Could not dismiss it').catch(function () {});
    }));
    c.appendChild(row);

    var pic = t.hero || t.image;
    if (pic) {
      var hero = mk('img', 'ntf-hero');
      hero.alt = '';
      hero.src = pic;
      c.appendChild(hero);
    }
    /* A picture the toast brought but Mantle could not show is named, quietly, on the card. */
    if (Array.isArray(t.imageNotes) && t.imageNotes.length) c.title += '\nPicture not shown — ' + t.imageNotes.join('; ');
    return c;
  }

  function build(pop) {
    pop.classList.add('ntf');
    room = 0;

    var head = mk('div', 'ntf-head');
    var h = mk('h3', null, 'Notifications');
    var clear = mk('button', 'qslink ntf-clear', 'Clear all');
    clear.type = 'button';
    clear.title = 'Dismiss every notification in this list (here and in Windows\' own centre)';
    clear.addEventListener('click', function () {
      act('all', 'notifs.clear', {}, 'Could not clear them all').catch(function () {});
    });
    head.appendChild(h);
    head.appendChild(clear);
    pop.appendChild(head);

    var list = mk('div', 'ntf-list');
    list.setAttribute('role', 'list');
    pop.appendChild(list);

    var noteEl = mk('div', 'note');
    pop.appendChild(noteEl);

    var foot = mk('div', 'ntf-foot');
    var detail = mk('div', 'ntf-detail');
    var win = mk('button', 'qslink', 'Windows notification centre');
    win.type = 'button';
    win.title = 'Open Windows\' own notification centre (Win+N): focus settings, and anything Mantle cannot do here';
    win.addEventListener('click', function () { B.closePop(); B.keys('win+n', 'Windows notification centre'); });
    foot.appendChild(detail);
    foot.appendChild(win);
    pop.appendChild(foot);

    paint = function () {
      if (B.popKey() !== KEY) { paint = null; return; }
      var ts = toasts();
      var bad = data && data.ok === false;
      h.textContent = ts.length ? 'Notifications · ' + ts.length : 'Notifications';
      clear.hidden = ts.length === 0;
      clear.disabled = !!busy.all;
      list.textContent = '';

      if (!data) {
        list.appendChild(mk('div', 'ntf-empty', 'Reading your notifications…'));
      } else if (bad && !ts.length) {
        var u = mk('div', 'ntf-empty ntf-bad');
        u.appendChild(mk('div', 'big', 'Notifications unavailable'));
        u.appendChild(mk('div', 'sub', data.reason || 'the list could not be read and no reason was given'));
        list.appendChild(u);
      } else if (!ts.length) {
        var e = mk('div', 'ntf-empty');
        e.appendChild(esTile(BELL));
        e.appendChild(mk('div', 'big', 'No notifications'));
        e.appendChild(mk('div', 'sub', 'What apps tell you lands here, newest first.'));
        list.appendChild(e);
      } else {
        groups(ts).forEach(function (g) {
          var box = mk('div', 'ntf-group' + (busy['app:' + g.aumid] ? ' busy' : ''));
          var gh = mk('div', 'ntf-ghead');
          gh.appendChild(appIcon(g.first, 'ntf-gicon'));
          gh.appendChild(mk('span', 'ntf-gname', g.app || g.aumid || 'Unknown app'));
          if (g.items.length > 1) gh.appendChild(mk('span', 'ntf-gcount', String(g.items.length)));
          gh.appendChild(xButton('Dismiss all from ' + (g.app || 'this app'), function () {
            act('app:' + g.aumid, 'notifs.clear', { aumid: g.aumid }, 'Could not dismiss ' + (g.app || 'that app') + '\'s notifications').catch(function () {});
          }));
          box.appendChild(gh);
          g.items.forEach(function (t) { box.appendChild(card(t)); });
          list.appendChild(box);
        });
      }

      /* The panel's own failure first; then a list that is stale (shown, but the last read failed). */
      var say = note || (bad && ts.length ? data.reason : '') || (data && data.seenNote) || '';
      noteEl.textContent = say;
      noteEl.hidden = !say;
      detail.textContent = (data && data.detail) ? 'Plainer than it could be: ' + data.detail : '';
      detail.hidden = !detail.textContent;
      /* Sized for 480 px, under main's 640 cap (POPOVER_MAX). Measured in the mock: the plain-source detail
         alone brings the panel to 466, so any extra line takes its room from the list. */
      list.style.maxHeight = (say || detail.textContent) ? '240px' : '';

      /* The panel changes height as toasts come and go: ask main for the room again so nothing is
         cut off by the window's edge. */
      var hgt = pop.offsetHeight + 16;
      if (room && hgt !== room) {
        B.callR('bar.popover', { open: true, height: hgt, key: KEY }).catch(function (err) {
          noteEl.textContent = 'this panel may be clipped: bar.popover — ' + B.msg(err);
          noteEl.hidden = false;
        });
      }
      room = hgt;
    };
    paint();
  }

  window.MantleNotifs = { init: init, open: function () { if (B.popKey() !== KEY) open(); } };
})();

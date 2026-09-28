/* jumplist.js - the right-click menu of an app on the bar (lane jumplist, 2026-09-24).
 *
 * Owen: "i need to be able to right click the apps on the taskbar and have the same options regular
 * windows shows". Windows 11's menu, top to bottom: the app's JUMP LIST (Pinned, Recent or Frequent,
 * the app's own categories, Tasks), then the app itself (a new window), Pin/Unpin from taskbar, and
 * Close window / Close all windows. Hover keeps the window previews (bar.js); right-click is this.
 *
 * Drawn INSIDE the bar's one popover (bar.js openPop -> el.pop), so it is the same glass, rises from
 * the same place, and is never behind the taskbar or off the screen: the popover is clamped into the
 * bar window, and this menu caps its own height (jumplist.css) so a long list scrolls instead.
 * The jump list itself is read by sidecar/JumpList.cs through lib/features/jumplist.js; the three
 * rows at the bottom need no read and are drawn at once, so the menu is never an empty wait.
 *
 * NO SILENT FAILURES: an app without a jump list gets a quiet line saying so ("this app doesn't
 * publish one"), a read error says what failed, and an action that is refused keeps the menu open
 * with the reason under it.
 *
 * KEYBOARD: arrows move, Enter runs, Right (or the menu key) opens an item's own actions, Left closes
 * them, Esc closes the menu (bar.js). The bar takes the keyboard for it through qs.keyboard, as
 * Windows' jump list takes focus; a test instance refuses, and the menu says so in its tooltip.
 */
(function () {
  'use strict';

  var api = null;          // from bar.js: { callR, call, msg, resize, close, refreshPinned, openFresh }
  var cur = null;          // { item, root, list, note, token }
  var seq = 0;

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }

  function svg(inner) {
    return '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">' + inner + '</svg>';
  }
  var GLYPH = {
    pin: svg('<path d="M9.6 2.2l4.2 4.2-1.5.4-2.4 2.4.2 2.7-1.1 1.1-2.5-2.5-3 3-.6-.6 3-3-2.5-2.5 1.1-1.1 2.7.2 2.4-2.4z" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/>'),
    unpin: svg('<path d="M9.6 2.2l4.2 4.2-1.5.4-2.4 2.4.2 2.7-1.1 1.1-2.5-2.5-3 3-.6-.6 3-3-2.5-2.5 1.1-1.1 2.7.2 2.4-2.4z" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"/><path d="M2.5 2.5l11 11" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"/>'),
    close: svg('<path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>'),
    task: svg('<path d="M3 8h8M8.5 5l3 3-3 3" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>'),
  };

  /* The bar item, as the main-process module wants it (never the icon: it is a data URL). */
  function appOf(it) {
    var wins = Array.isArray(it && it.windows) ? it.windows : [];
    return {
      id: it.id, name: it.name, kind: it.kind, exe: it.exe || null, aumid: it.aumid || null,
      hwnds: wins.map(function (w) { return String(w.hwnd); }),
    };
  }

  function iconBox(src, glyph, letter) {
    var box = el('span', 'jl-ico');
    if (src) {
      var img = document.createElement('img');
      img.alt = '';
      img.onerror = function () { box.textContent = ''; box.innerHTML = GLYPH.task; };
      img.src = src;
      box.appendChild(img);
    } else if (glyph) {
      box.innerHTML = glyph;
    } else {
      box.textContent = letter || '';
      box.classList.add('letter');
    }
    return box;
  }

  function row(text, icon, onRun, extraCls) {
    var b = el('button', 'jl-i' + (extraCls ? ' ' + extraCls : ''));
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    b.tabIndex = -1;
    b.appendChild(icon);
    b.appendChild(el('span', 'jl-t', text));
    b.addEventListener('click', function (ev) { ev.stopPropagation(); onRun(b); });
    return b;
  }

  function say(text, tone) {
    if (!cur) return;
    cur.note.textContent = text || '';
    cur.note.className = 'jl-note' + (tone ? ' ' + tone : '');
    cur.note.hidden = !text;
    api.resize();
  }

  /* An action's reply: a failure keeps the menu open and says why; a success closes it, as Windows. */
  function run(what, p, after) {
    say(what + '…', 'quiet');
    return p.then(function (r) {
      if (after) after(r);
      api.close();
    }, function (e) {
      say(what + ' failed: ' + api.msg(e), 'warn');
    });
  }

  /* ---- one jump list item, and its own actions (right-click / Right arrow) */
  function itemRow(it, sec) {
    var b = row(it.title, iconBox(it.icon, GLYPH.task), function () {
      run('Opening ' + it.title, api.callR('jumplist.open', { app: cur.app, item: it.item, title: it.title }));
    });
    b.title = it.tip || it.title;
    b.dataset.jlItem = it.item;
    if (sec.kind === 'pinned') b.classList.add('pinned');
    b.addEventListener('contextmenu', function (ev) { ev.preventDefault(); ev.stopPropagation(); toggleSub(b, it, sec); });
    return b;
  }

  function toggleSub(b, it, sec) {
    var open = b.nextSibling && b.nextSibling.classList && b.nextSibling.classList.contains('jl-sub');
    var old = cur.list.querySelector('.jl-sub');
    if (old) old.parentNode.removeChild(old);
    if (open) { b.focus(); api.resize(); return; }
    var sub = el('div', 'jl-sub');
    sub.setAttribute('role', 'group');
    sub.appendChild(row('Open', iconBox(null, GLYPH.task), function () { b.click(); }));
    if (it.canRemove) {
      sub.appendChild(row('Remove from this list', iconBox(null, GLYPH.close), function () {
        run('Removing ' + it.title, api.callR('jumplist.remove', { app: cur.app, item: it.item, title: it.title }));
      }));
    }
    // Windows offers these; no documented call lets another program do them (see the report).
    var why = sec.kind === 'tasks' ? 'tasks belong to the app and cannot be pinned or removed'
      : sec.kind === 'custom' ? 'this list belongs to the app: only the app can change it'
      : 'Windows has no public way for another program to ' + (it.pinned ? 'unpin' : 'pin') + ' a jump list item';
    sub.appendChild(el('div', 'jl-why', (it.pinned ? 'Unpin from this list' : 'Pin to this list') + ': ' + why));
    b.parentNode.insertBefore(sub, b.nextSibling);
    api.resize();
    var first = sub.querySelector('.jl-i');
    if (first && document.activeElement === b) first.focus();
  }

  /* ---- the list, when the sidecar answers */
  function fill(r) {
    var list = cur.list;
    list.textContent = '';
    var any = false;
    (r.sections || []).forEach(function (sec) {
      var items = (sec.items || []).filter(function (x) { return x && (x.sep || x.title); });
      if (!items.length) return;
      any = true;
      list.appendChild(el('div', 'jl-h', sec.name));
      items.forEach(function (x) {
        if (x.sep) { list.appendChild(el('div', 'jl-sep')); return; }
        list.appendChild(itemRow(x, sec));
      });
    });
    var quiet = [];
    if (!any) quiet.push('No jump list: ' + (r.none || r.error || 'Windows gave no reason'));
    if (any && r.error) quiet.push('Part of the jump list could not be read: ' + r.error);
    if (r.note) quiet.push(r.note);
    quiet.forEach(function (q) { list.appendChild(el('div', 'jl-quiet' + (r.error ? ' warn' : ''), q)); });
    list.hidden = false;
    api.resize();
  }

  function open(pop, item, bridge) {
    api = bridge;
    var token = ++seq;
    pop.classList.add('jl');
    pop.setAttribute('role', 'menu');
    pop.setAttribute('aria-label', (item.name || 'App') + ' menu');
    var wins = Array.isArray(item.windows) ? item.windows : [];
    cur = { item: item, app: appOf(item), token: token };

    var list = el('div', 'jl-list');
    list.appendChild(el('div', 'jl-quiet', 'Reading the jump list…'));
    var note = el('div', 'jl-note');
    note.hidden = true;
    var foot = el('div', 'jl-foot');
    cur.list = list; cur.note = note;

    // 2. the app itself: a new window (middle-click does the same)
    foot.appendChild(row(item.name || 'App', iconBox(item.icon, null, (item.name || '?').charAt(0).toUpperCase()), function () {
      run('Starting ' + item.name, api.openFresh(item, cur.app));
    }, 'app'));
    // 3. Mantle's own pinned list
    var pinned = item.kind === 'pinned';
    foot.appendChild(row(pinned ? 'Unpin from taskbar' : 'Pin to taskbar', iconBox(null, pinned ? GLYPH.unpin : GLYPH.pin), function () {
      run(pinned ? 'Unpinning' : 'Pinning', api.callR('jumplist.pin', { app: cur.app, pin: !pinned }), function () { api.refreshPinned(); });
    }));
    // 3b. keep on top (lane ontop, 2026-09-27; lib/features/ontop.js): one of this app's windows
    // Mantle keeps on top -> "Stop keeping on top"; else the window in use (the active one, then
    // the first) -> "Keep on top". A refusal (admin window, not responding, already on top by its
    // own setting) keeps the menu open with the reason, like every action here.
    if (wins.length) {
      var OT = window.MantleOnTop || null;
      var onH = OT ? OT.pinnedOf(wins) : null;
      var target = onH;
      if (!target) {
        var pick = wins[0];
        for (var wi = 0; wi < wins.length; wi++) if (wins[wi] && (wins[wi].active || wins[wi].foreground) && !wins[wi].minimized) { pick = wins[wi]; break; }
        target = String(pick.hwnd);
      }
      var otRow = row(onH ? 'Stop keeping on top' : 'Keep on top', iconBox(null, onH ? GLYPH.unpin : GLYPH.pin), function () {
        // a refusal is {ok:false, reason}: callR throws it, run() keeps the menu open and says why
        run(onH ? 'Stopping' : 'Keeping on top', api.callR('ontop.set', { hwnd: target, on: !onH, name: item.name || '' }));
      }, onH ? 'ontop-on' : '');
      otRow.title = !OT ? 'Keep on top: the bar did not load ui/bar/ontop.js'
        : OT.error() ? 'Keep on top: ' + OT.error()
          : (onH ? 'Mantle keeps this window above the others' : 'Keep this window above all the others') + ' (Win+Ctrl+T does the same for the window in front)';
      foot.appendChild(otRow);
    }
    // 4. close, politely (WM_CLOSE: the app still asks to save)
    if (wins.length) {
      foot.appendChild(row(wins.length === 1 ? 'Close window' : 'Close all windows', iconBox(null, GLYPH.close), function () {
        run('Closing', api.callR('jumplist.close', { hwnds: cur.app.hwnds }));
      }, 'close'));
    }
    pop.appendChild(list);
    pop.appendChild(note);
    pop.appendChild(foot);

    var t0 = Date.now();
    api.call('jumplist.get', { app: cur.app }).then(function (r) {
      if (!cur || cur.token !== token) return;
      cur.shownMs = Date.now() - t0;
      pop.dataset.jlMs = String(cur.shownMs);
      if (r && r.off) { list.textContent = ''; list.appendChild(el('div', 'jl-quiet', 'No jump list: ' + r.reason)); api.resize(); return; }
      if (!r || r.ok === false) {
        list.textContent = '';
        list.appendChild(el('div', 'jl-quiet warn', 'The jump list could not be read: ' + ((r && r.reason) || 'no reason given')));
        api.resize();
        return;
      }
      fill(r);
    }, function (e) {
      if (!cur || cur.token !== token) return;
      list.textContent = '';
      list.appendChild(el('div', 'jl-quiet warn', 'The jump list could not be read: ' + api.msg(e)));
      api.resize();
    });

    // The keyboard, as Windows' jump list takes focus. Refused (a test instance, another window
    // kept focus): the mouse still works, and the menu's tooltip says why the keys do not.
    api.call('qs.keyboard', { on: true }).then(function (r) {
      if (!cur || cur.token !== token) { if (r && r.ok) api.call('qs.keyboard', { on: false }).catch(function () {}); return; }
      cur.kbd = !!(r && r.ok);
      if (!cur.kbd) pop.title = 'Arrow keys do not reach this menu: ' + String((r && r.reason) || 'the bar was not given the keyboard').split(', so ')[0];
    }, function (e) { if (cur && cur.token === token) pop.title = 'Arrow keys do not reach this menu: ' + api.msg(e); });
  }

  function closed() {
    if (cur && cur.kbd) api.call('qs.keyboard', { on: false }).catch(function () {});
    cur = null;
  }

  /* Arrows / Home / End over every visible row, Right = the item's own actions, Left = back. */
  function key(ev) {
    if (!cur) return false;
    var rows = Array.prototype.slice.call(document.querySelectorAll('.pop.jl .jl-i'));
    if (!rows.length) return false;
    var at = rows.indexOf(document.activeElement);
    var k = ev.key;
    if (k === 'ArrowDown' || k === 'ArrowUp' || k === 'Home' || k === 'End') {
      var n = k === 'Home' ? 0 : k === 'End' ? rows.length - 1
        : at < 0 ? (k === 'ArrowDown' ? 0 : rows.length - 1)
        : (at + (k === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
      rows[n].focus();
      rows[n].scrollIntoView({ block: 'nearest' });
      return true;
    }
    var b = document.activeElement;
    if ((k === 'ArrowRight' || k === 'ContextMenu' || (k === 'F10' && ev.shiftKey)) && b && b.dataset && b.dataset.jlItem) {
      b.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      return true;
    }
    if (k === 'ArrowLeft' && b && b.closest && b.closest('.jl-sub')) {
      var owner = b.closest('.jl-sub').previousSibling;
      if (owner) owner.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      return true;
    }
    return false;
  }

  window.MantleJumpList = { open: open, closed: closed, key: key, _appOf: appOf };
})();

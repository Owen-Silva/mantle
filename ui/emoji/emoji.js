/* emoji.js - the emoji picker page (lane mantle-emoji, 2026-10-15). Main: lib/features/emoji.js.
 *
 * The keyboard stays with the app Owen is typing in: keys arrive as `emoji.key` {key, text, shift}
 * from the sidecar's watch (or from this page's own keydown when it has the keyboard itself: the
 * fallback, and the page test). A pick goes to main as emoji.insert {ch, close}; main types it.
 * The whole grid is built once per window (the window lives for a while after a close), so an open
 * re-renders only the recents row; search draws at most 160 cells.
 */
(function () {
  'use strict';
  var M = window.EmojiModel;
  var mantle = window.mantle;
  var CAT = M.catalogue(window.MantleEmojiData);
  var $ = function (id) { return document.getElementById(id); };
  var panel = $('panel'), grid = $('grid'), sectionsEl = $('sections'), resultsEl = $('results'), emptyEl = $('empty');
  var ring = $('ring'), qEl = $('q'), phEl = $('ph'), searchEl = $('search');
  var S = { tab: 'emoji', q: '', sel: 0, items: [], rows: [], tone: 0, recents: [], appPicks: [], app: null,
            closeAfter: false, open: false, kbSelf: false, noticeTimer: 0, toneOpen: false };
  var PLACEHOLDER = { emoji: 'Search emoji', symbols: 'Search symbols', kaomoji: 'Search kaomoji' };

  function call(name, args) {
    try { return mantle && mantle.call ? Promise.resolve(mantle.call(name, args || {})).catch(function () { return null; }) : Promise.resolve(null); }
    catch (_) { return Promise.resolve(null); }
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  /* ---- what the grid shows ---------------------------------------------------------------- */
  function sections() {
    if (S.tab === 'symbols') return CAT.symbols;
    if (S.tab === 'kaomoji') return CAT.kaomoji;
    var out = [];
    if (S.app && S.appPicks.length >= 3) out.push({ id: 'app', name: 'Used in ' + S.app, glyph: '', items: M.recentItems(S.appPicks, CAT).slice(0, 16) });
    var rec = M.recentItems(S.recents, CAT);
    out.push({ id: 'recent', name: M.GROUP_LABEL.recent, glyph: M.GROUP_GLYPH.recent, items: rec, empty: 'The emoji you pick show up here.' });
    return out.concat(CAT.emoji);
  }
  function cellHtml(it, i) {
    var ch = it.fixed ? it.ch : M.display(it, S.tone);
    return '<span class="c" data-i="' + i + '" title="' + esc(it.name) + '">' + esc(ch) + '</span>';
  }
  function render() {
    var secs = sections();
    var q = M.norm(S.q);
    S.items = [];
    var counts = [];
    var cls = S.tab === 'kaomoji' ? 'kao' : S.tab === 'symbols' ? 'sym' : '';
    if (q) {
      var hits = M.search(S.tab === 'emoji' ? CAT.emoji : secs, q, 160);
      S.items = hits;
      counts = [hits.length];
      resultsEl.className = cls;
      resultsEl.innerHTML = hits.length ? '<div class="cells">' + hits.map(cellHtml).join('') + '</div>' : '';
      resultsEl.hidden = false; sectionsEl.hidden = true;
      emptyEl.hidden = hits.length > 0;
      emptyEl.textContent = 'Nothing called “' + S.q.trim() + '”. Try another word.';
      Array.prototype.forEach.call(resultsEl.querySelectorAll('.c'), function (c, i) { if (i < 32) c.style.animationDelay = (i * 9) + 'ms'; else c.style.animation = 'none'; });
    } else {
      var html = '';
      for (var s = 0; s < secs.length; s++) {
        var sec = secs[s];
        if (!sec.items.length && !sec.empty) continue;
        html += '<div class="sec ' + cls + '" data-sec="' + sec.id + '"><h2>' + esc(sec.name) + '</h2>';
        if (sec.items.length) {
          html += '<div class="cells">';
          for (var k = 0; k < sec.items.length; k++) { html += cellHtml(sec.items[k], S.items.length); S.items.push(sec.items[k]); }
          html += '</div>';
          counts.push(sec.items.length);
        } else html += '<div class="empty" style="padding:8px 2px;text-align:left">' + esc(sec.empty) + '</div>';
        html += '</div>';
      }
      sectionsEl.innerHTML = html;
      resultsEl.hidden = true; sectionsEl.hidden = false; emptyEl.hidden = true;
    }
    S.rows = M.layout(counts, S.tab === 'kaomoji' ? 2 : M.COLS);
    renderCats();
  }
  function renderCats() {
    var cats = $('cats');
    if (S.tab !== 'emoji' || M.norm(S.q)) { cats.hidden = true; return; }
    cats.hidden = false;
    if (!cats.firstChild) {
      cats.innerHTML = ['recent'].concat(CAT.emoji.map(function (g) { return g.id; })).map(function (id) {
        return '<button type="button" data-cat="' + id + '" title="' + esc(M.GROUP_LABEL[id] || id) + '">' + M.GROUP_GLYPH[id] + '</button>';
      }).join('');
    }
    markCat();
  }
  function markCat() {
    var top = grid.scrollTop + 8, cur = 'recent';
    Array.prototype.forEach.call(sectionsEl.querySelectorAll('.sec'), function (el) { if (el.offsetTop <= top) cur = el.getAttribute('data-sec') === 'app' ? 'recent' : el.getAttribute('data-sec'); });
    Array.prototype.forEach.call($('cats').children, function (b) { b.classList.toggle('on', b.getAttribute('data-cat') === cur); });
  }

  /* ---- selection: a ring that glides from cell to cell -------------------------------------- */
  function cellEl(i) { return (M.norm(S.q) ? resultsEl : sectionsEl).querySelector('.c[data-i="' + i + '"]'); }
  function select(i, opts) {
    S.sel = i;
    var el = i >= 0 ? cellEl(i) : null;
    if (!el) { ring.classList.add('off'); preview(null); return; }
    var g = grid.getBoundingClientRect(), r = el.getBoundingClientRect();
    var x = r.left - g.left + grid.scrollLeft, y = r.top - g.top + grid.scrollTop;
    ring.classList.toggle('jump', !!(opts && opts.jump));
    ring.style.width = r.width + 'px'; ring.style.height = r.height + 'px';
    ring.style.transform = 'translate(' + x + 'px,' + y + 'px)';
    ring.classList.remove('off');
    if (opts && opts.scroll) {
      if (y < grid.scrollTop + 4) grid.scrollTop = y - 30;
      else if (y + r.height > grid.scrollTop + grid.clientHeight - 4) grid.scrollTop = y + r.height - grid.clientHeight + 8;
    }
    preview(S.items[i]);
  }
  function preview(it) {
    var big = $('big'), name = $('name'), hint = $('hint');
    big.className = 'big' + (S.tab === 'kaomoji' ? ' kao' : S.tab === 'symbols' ? ' sym' : '');
    big.textContent = it ? (it.fixed ? it.ch : M.display(it, S.tone)) : '';
    name.textContent = it ? it.name : '';
    if (!hint.classList.contains('say')) hint.textContent = it ? (S.closeAfter || S.kbSelf ? 'Enter types it and closes' + (S.kbSelf ? '' : ' · Shift+Enter keeps it open') : 'Enter types it · Shift+Enter types and closes') : '';
  }
  function say(text, ms) {
    var hint = $('hint');
    hint.textContent = text; hint.classList.add('say');
    clearTimeout(S.noticeTimer);
    S.noticeTimer = setTimeout(function () { hint.classList.remove('say'); preview(S.items[S.sel]); }, ms || 3500);
  }

  /* ---- search ------------------------------------------------------------------------------- */
  function setQuery(q) {
    S.q = q;
    qEl.textContent = q;
    phEl.textContent = q ? '' : PLACEHOLDER[S.tab];
    searchEl.classList.toggle('typing', !!q);
    render();
    grid.scrollTop = 0;
    select(S.items.length ? 0 : -1, { jump: true });
  }

  /* ---- keys ----------------------------------------------------------------------------------- */
  function onKey(k) {
    if (!S.open) return;
    call('emoji.touched');
    var a = M.keyAction(k, S.closeAfter);
    switch (a.do) {
      case 'close': call('emoji.close', { why: 'esc' }); break;
      case 'insert': insert(S.sel, a.close, 'key'); break;
      case 'back': if (S.q) setQuery(S.q.slice(0, -1)); break;
      case 'clear': if (S.q) setQuery(''); break;
      case 'tab': setTab(nextTab(a.back)); break;
      case 'move': select(M.move(S.rows, S.sel, a.key, 5), { scroll: true }); break;
      case 'type': if (S.q || a.text !== ' ') setQuery((S.q + a.text).slice(0, 40)); break;
    }
  }
  function nextTab(back) { var t = ['emoji', 'symbols', 'kaomoji']; return t[(t.indexOf(S.tab) + (back ? 2 : 1)) % 3]; }
  function insert(i, close, via) {
    var it = S.items[i];
    if (!it) return;
    var ch = it.fixed ? it.ch : M.display(it, S.tone);
    var cell = cellEl(i);
    if (cell) { cell.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.28)' }, { transform: 'scale(1)' }], { duration: 320, easing: 'cubic-bezier(.2,.9,.3,1.2)' }); }
    call('emoji.insert', { ch: ch, close: !!close, via: via }).then(function (r) {
      if (!r) return;
      if (r.recents) S.recents = r.recents;
      if (!r.typed && !r.dryRun && r.reason) say(r.reason, 5000);
    });
  }
  function setTab(tab) {
    if (tab === S.tab) return;
    S.tab = tab;
    Array.prototype.forEach.call($('tabs').querySelectorAll('button'), function (b) { b.classList.toggle('on', b.getAttribute('data-tab') === tab); });
    placePill();
    setQuery(S.q);
  }
  function placePill() {
    var on = $('tabs').querySelector('button.on'), pill = $('pill');
    if (!on) return;
    pill.style.width = on.offsetWidth + 'px';
    pill.style.transform = 'translateX(' + (on.offsetLeft - 3) + 'px)';
  }

  /* ---- tones ---------------------------------------------------------------------------------- */
  var HAND = '✋';
  function setTone(t, save) {
    S.tone = M.clampTone(t);
    $('toneGlyph').textContent = S.tone ? HAND + String.fromCodePoint(M.TONES[S.tone - 1]) : HAND;
    Array.prototype.forEach.call(document.querySelectorAll('.c'), function (c) {
      var it = S.items[+c.getAttribute('data-i')];
      if (it && it.plan && !it.fixed) c.textContent = M.display(it, S.tone);
    });
    preview(S.items[S.sel]);
    if (save) call('emoji.tone', { tone: S.tone });
  }
  function toggleTones() {
    var box = $('tones');
    S.toneOpen = box.hidden;
    if (!S.toneOpen) { box.hidden = true; return; }
    box.innerHTML = M.TONE_NAMES.map(function (n, i) {
      return '<button type="button" data-tone="' + i + '" title="' + n + '" class="' + (i === S.tone ? 'on' : '') + '" style="animation-delay:' + (i * 22) + 'ms">' +
        (i ? HAND + String.fromCodePoint(M.TONES[i - 1]) : HAND) + '</button>';
    }).join('');
    box.hidden = false;
  }

  /* ---- mouse ---------------------------------------------------------------------------------- */
  document.addEventListener('mousedown', function (e) { e.preventDefault(); call('emoji.touched'); });
  grid.addEventListener('mousemove', function (e) {
    var c = e.target.closest && e.target.closest('.c');
    if (c && +c.getAttribute('data-i') !== S.sel) select(+c.getAttribute('data-i'));
  });
  grid.addEventListener('click', function (e) {
    var c = e.target.closest && e.target.closest('.c');
    if (c) insert(+c.getAttribute('data-i'), S.closeAfter !== e.shiftKey, 'click');
  });
  grid.addEventListener('scroll', function () { if (!M.norm(S.q)) markCat(); }, { passive: true });
  $('cats').addEventListener('click', function (e) {
    var b = e.target.closest('button');
    if (!b) return;
    var sec = sectionsEl.querySelector('.sec[data-sec="' + b.getAttribute('data-cat') + '"]');
    if (sec) grid.scrollTo({ top: sec.offsetTop - 2, behavior: 'smooth' });
  });
  $('tabs').addEventListener('click', function (e) { var b = e.target.closest('button[data-tab]'); if (b) setTab(b.getAttribute('data-tab')); });
  $('toneBtn').addEventListener('click', toggleTones);
  $('tones').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-tone]');
    if (!b) return;
    setTone(+b.getAttribute('data-tone'), true);
    $('tones').hidden = true;
  });
  // the page's own keyboard: the fallback when the sidecar's watch cannot be had (and the page test)
  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    e.preventDefault();
    onKey({ key: e.key, text: e.key.length === 1 ? e.key : null, shift: e.shiftKey });
  });

  /* ---- main's events --------------------------------------------------------------------------- */
  function show(p) {
    p = p || {};
    S.open = true;
    S.recents = Array.isArray(p.recents) ? p.recents : S.recents;
    S.appPicks = Array.isArray(p.appPicks) ? p.appPicks : [];
    S.app = p.app || null;
    S.closeAfter = !!p.closeAfter;
    S.kbSelf = !!p.kbSelf;
    panel.classList.remove('note-only');
    $('notice').hidden = true;
    $('tones').hidden = true;
    $('hint').classList.remove('say');
    if (M.clampTone(p.tone) !== S.tone) setTone(p.tone, false);
    S.tab = 'emoji';
    Array.prototype.forEach.call($('tabs').querySelectorAll('button'), function (b) { b.classList.toggle('on', b.getAttribute('data-tab') === 'emoji'); });
    setQuery('');
    placePill();
    panel.classList.toggle('above', !!p.above);
    if (p.notice) say(p.notice, 8000);
    void panel.offsetWidth;            // the closed state is laid out, so the spring runs from it
    panel.classList.add('on');
    var bd = window.MantleHudBackdrop;
    if (bd && document.documentElement.getAttribute('data-theme') === 'dark') bd.request('opened', { hold: 40 });
    requestAnimationFrame(function () { requestAnimationFrame(function () { call('emoji.painted', { readyAt: Date.now() }); }); });
  }
  function hide() {
    S.open = false;
    panel.classList.remove('on');
    setTimeout(function () { if (!S.open) call('emoji.hidden'); }, 130);
  }
  function notice(p) {
    S.open = false;
    panel.classList.add('note-only', 'on');
    var n = $('notice');
    n.textContent = (p && p.text) || '';
    n.hidden = false;
  }
  if (mantle && mantle.on) {
    mantle.on('emoji.show', show);
    mantle.on('emoji.hide', hide);
    mantle.on('emoji.key', onKey);
    mantle.on('emoji.notice', notice);
    mantle.on('emoji.moved', function (p) { panel.classList.toggle('above', !!(p && p.above)); });
    mantle.on('emoji.keyboard', function (p) { S.kbSelf = !!(p && p.self); preview(S.items[S.sel]); });
  }
  render();
  window.__emoji = { S: S, onKey: onKey, show: show, hide: hide, select: select, setTone: setTone, setTab: setTab };
})();

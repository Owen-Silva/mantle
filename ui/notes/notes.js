/* notes.js — the quick notes pad's page (lane tbnotes, 2026-09-27; main: lib/features/notes.js).
 *
 * THE TEXT STAYS HERE until main asks for it. Typing bumps `rev`; 400 ms after typing stops (and at
 * most 3 s into a long burst, and on blur) the page calls notes.dirty {rev} — no text — and main
 * PULLS the set through window.__notesTake() (executeJavaScript) and writes it. So no note text ever
 * travels as a mantle.call argument, which main's call log could write to mantle.log. Text only
 * arrives here in notes.load's result and in the notes.open push (a reload after an outside change).
 *
 * Tabs (each note's first line; hover shows it whole), "+" / Ctrl+N a new note, Ctrl+Tab /
 * Ctrl+Shift+Tab switch, arrows move between tabs when a tab has the keyboard, Ctrl+F finds across
 * every note (the match it steps to is marked even while the keyboard stays in the find box), Esc closes the find row first and then the pad (an empty extra note is dropped on
 * close, never the last one). Delete is ONE click and offers Undo for 8 s (quality pass 2026-09-29:
 * forgiving beats "are you sure"); the text also goes to deleted.md before it leaves notes.md.
 * The footer is quiet while all is well ("3 notes · Saved 9:14 PM"), says "Saving…" only when a
 * save takes longer than 0.7 s, and NOT saved with the reason (and the path as its tooltip) when a
 * save fails: nothing fails silently. Timers: the debounce, the slow-save hint, the undo window;
 * main runs the 5 s retry while unsaved.
 */
(function () {
  'use strict';
  const mantle = window.mantle;
  const $ = (id) => document.getElementById(id);
  const pad = $('pad'), tabsEl = $('tabs'), topEl = pad.querySelector('.top'), ta = $('text');
  const foot = $('foot'), statusEl = $('status'), noticeEl = $('notice'), delBtn = $('del'), addBtn = $('add'), undoBtn = $('undo');
  const findEl = $('find'), qEl = $('q'), countEl = $('count'), prevBtn = $('prev'), nextBtn = $('next'), fcloseBtn = $('fclose'), findBtn = $('findbtn');
  const hlEl = $('hl'), mirrorEl = $('mirror');

  const DEBOUNCE_MS = 400, MAX_WAIT_MS = 3000, SLOW_MS = 700, UNDO_MS = 8000, CLICK_GAP_MS = 400, TAB_CHARS = 18;
  // find's mark copies the match's paragraph (up to MARK_PARA characters before the match, MARK_TAIL after)
  const MAX_HITS = 999, TITLE_CHARS = 120, MARK_PARA = 50000, MARK_TAIL = 400;
  const S = {
    loaded: false, notes: [], active: null, rev: 0,
    saved: { ok: true, at: null, reason: null, rev: 0 },
    file: '', folder: '', outside: null, loadError: null, rescued: [],
    lastDel: 0, deleting: false, delError: null, undo: null,
    carets: Object.create(null), wantFocus: false, error: null,
    firstDirty: 0, inflight: 0, inflightAt: 0,
    find: { open: false, q: '', hits: [], cur: -1, per: Object.create(null), mark: null },
  };
  let debounce = null, slowTimer = null, undoTimer = null, findTimer = null, seq = 0;

  const cur = () => S.notes.find((n) => n.id === S.active) || null;
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  // the clock the way the top bar and the timer's pop-up write it ("9:14 PM" here), not a 24-hour one
  const hhmm = (t) => { const d = new Date(t); try { return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); } catch (_) { return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; } };
  const base = (p) => String(p || '').split(/[\\/]/).pop();
  const newId = () => `p${Date.now().toString(36)}${++seq}`;

  /** A tab's words: the note's first line with text, trimmed to ~18 characters. */
  function label(text) {
    // Never split the whole note: this runs per keystroke, and a note can be 8 MB (it split every
    // line of it, secreview2). The first line with text is the one holding the first non-space
    // character (\s is exactly what trim() drops), so only that one line is read.
    const s = String(text || '');
    const i = s.search(/\S/);
    if (i < 0) return '';
    const nl = s.indexOf('\n', i);
    const line = s.slice(i, Math.min(nl < 0 ? s.length : nl, i + 4096)).trimEnd();   // 4096 >> TAB_CHARS: cut below anyway
    return line.length > TAB_CHARS ? line.slice(0, TAB_CHARS - 1).trimEnd() + '…' : line;
  }

  /* ---- render ---- */
  /** The whole first line (up to TITLE_CHARS) for the tab's tooltip; '' when the label already shows it all. */
  function fullTitle(text, words) {
    if (!words.endsWith('…')) return '';
    const s = String(text || '');
    const i = s.search(/\S/);
    const nl = s.indexOf('\n', i);
    const line = s.slice(i, Math.min(nl < 0 ? s.length : nl, i + TITLE_CHARS + 1)).trimEnd();
    return line.length > TITLE_CHARS ? line.slice(0, TITLE_CHARS - 1) + '…' : line;
  }
  function paintTab(b, n) {
    const words = label(n.text);
    b.classList.toggle('empty', !words);
    b.firstChild.textContent = words || 'New note';
    const t = fullTitle(n.text, words);
    if (t) b.title = t; else b.removeAttribute('title');
    const f = S.find;
    b.classList.toggle('nohit', f.open && f.q !== '' && !f.per[n.id]);
  }
  function renderTabs() {
    const frag = document.createDocumentFragment();
    for (const n of S.notes) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'tab' + (n.id === S.active ? ' on' : '');
      b.dataset.id = n.id;
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', n.id === S.active ? 'true' : 'false');
      b.tabIndex = n.id === S.active ? 0 : -1;        // roving: Tab reaches the open note's tab, arrows move
      const s = document.createElement('span');
      s.className = 'lb';
      b.appendChild(s);
      paintTab(b, n);
      frag.appendChild(b);
    }
    tabsEl.replaceChildren(frag);
    const on = tabsEl.querySelector('.tab.on');
    if (on) {
      const l = on.offsetLeft, r = l + on.offsetWidth;
      if (l < tabsEl.scrollLeft) tabsEl.scrollLeft = l;
      else if (r > tabsEl.scrollLeft + tabsEl.clientWidth) tabsEl.scrollLeft = r - tabsEl.clientWidth;
    }
    edges();
  }
  function edges() {
    const max = tabsEl.scrollWidth - tabsEl.clientWidth;
    topEl.classList.toggle('more-l', tabsEl.scrollLeft > 1);
    topEl.classList.toggle('more-r', max - tabsEl.scrollLeft > 1);
  }
  function renderTabLabel() {
    const n = cur();
    const b = n && tabsEl.querySelector(`.tab[data-id="${CSS.escape(n.id)}"]`);
    if (!b) return renderTabs();
    paintTab(b, n);
  }

  function renderFoot() {
    let words = '', warn = false;
    const n = S.notes.length;
    const slow = S.inflight > 0 && Date.now() - S.inflightAt >= SLOW_MS;
    if (S.error) { words = S.error; warn = true; }
    else if (S.delError) { words = `Not deleted: ${S.delError}`; warn = true; }
    else if (!S.saved.ok) { words = `Not saved: ${S.saved.reason || 'Mantle did not say why'} · your text is kept here and saved again as you type`; warn = true; }
    else if (S.loadError) { words = `Could not read your notes: ${S.loadError}`; warn = true; }
    else if (!S.loaded) words = 'Opening…';
    else if (S.deleting) words = 'Deleting…';
    else if (S.undo) words = 'Note deleted';
    else if (slow) words = 'Saving…';
    else if (S.saved.at) words = `${plural(n, 'note')} · Saved ${hhmm(S.saved.at)}`;
    else words = plural(n, 'note');
    statusEl.textContent = words;
    statusEl.classList.toggle('warn', warn);
    foot.title = S.file ? `${S.file}${S.saved.ok ? '' : '\n' + (S.saved.reason || '')}` : '';
    const notes = [];
    if (S.outside && S.outside.name) notes.push(`notes.md was changed outside Mantle: that version was kept as “${S.outside.name}”`);
    if (S.rescued && S.rescued.length) notes.push(`Notes an earlier run could not save were kept in “${base(S.rescued[S.rescued.length - 1])}”`);
    noticeEl.textContent = notes.join(' · ');
    noticeEl.hidden = !notes.length;
    renderDel();
  }
  function renderDel() {
    const n = cur();
    const nothing = S.notes.length === 1 && (!n || n.text.trim() === '');   // one blank note: nothing to delete
    delBtn.disabled = !S.loaded || S.deleting || !!S.error || nothing;
    undoBtn.hidden = !S.undo;
  }
  function render() { renderTabs(); renderFoot(); }

  /* ---- notes ---- */
  function keepCaret() {
    if (S.active) S.carets[S.active] = [ta.selectionStart, ta.selectionEnd, ta.scrollTop];
  }
  function activate(id, focus) {
    if (!S.notes.some((n) => n.id === id)) id = S.notes.length ? S.notes[0].id : null;
    if (id !== S.active) keepCaret();
    S.active = id;
    const n = cur();
    ta.value = n ? n.text : '';
    const c = S.carets[id];
    if (c) { ta.setSelectionRange(Math.min(c[0], ta.value.length), Math.min(c[1], ta.value.length)); ta.scrollTop = c[2]; }
    else { ta.setSelectionRange(ta.value.length, ta.value.length); ta.scrollTop = ta.scrollHeight; }
    S.delError = null;
    render();
    if (focus) ta.focus();
    paintMark();                                          // back on the match's note: its mark again
  }
  function changed() {
    S.rev++;
    const now = Date.now();
    if (!S.firstDirty) S.firstDirty = now;
    renderFoot();
    clearTimeout(debounce);
    // 400 ms after the last key, but never later than 3 s after the first unsaved one (a long burst
    // of typing is still on disk every few seconds if the machine dies mid-sentence).
    debounce = setTimeout(sendDirty, Math.max(0, Math.min(DEBOUNCE_MS, S.firstDirty + MAX_WAIT_MS - now)));
    if (S.find.open) findSoon();
  }
  function newNote() {
    if (!S.loaded || S.error) return;
    const n = { id: newId(), text: '' };
    const i = S.notes.findIndex((x) => x.id === S.active);
    S.notes.splice(i < 0 ? S.notes.length : i + 1, 0, n);
    activate(n.id, true);
    changed();
  }
  function step(d, focusTab) {
    if (S.notes.length < 2) return;
    const i = S.notes.findIndex((x) => x.id === S.active);
    activate(S.notes[(i + d + S.notes.length) % S.notes.length].id, !focusTab);
    if (focusTab) { const b = tabsEl.querySelector('.tab.on'); if (b) b.focus(); }
  }
  /** Drop empty extra notes (never the last one). -> true if any went. */
  function prune() {
    const keep = S.notes.filter((n) => n.text.trim() !== '');
    if (keep.length === S.notes.length) return false;
    if (!keep.length) {
      if (S.notes.length === 1) return false;
      keep.push(S.notes.find((n) => n.id === S.active) || S.notes[0]);
    }
    const wasActive = S.active;
    S.notes = keep;
    if (!keep.some((n) => n.id === wasActive)) activate(keep[keep.length - 1].id, false);
    else renderTabs();
    S.rev++;
    return true;
  }

  /* ---- saving: tell main, it pulls ---- */
  function sendDirty() {
    clearTimeout(debounce); debounce = null;
    S.firstDirty = 0;
    if (!mantle || !S.loaded) return;
    if (S.rev <= S.saved.rev && S.saved.ok) return;
    if (!S.inflight) S.inflightAt = Date.now();
    S.inflight++;
    clearTimeout(slowTimer);
    slowTimer = setTimeout(renderFoot, SLOW_MS + 20);     // "Saving…" only for a save that is slow
    const settle = () => { S.inflight = Math.max(0, S.inflight - 1); if (!S.inflight) clearTimeout(slowTimer); };
    mantle.call('notes.dirty', { rev: S.rev }).then((r) => {
      settle();
      if (r && r.saved) applySaved(r.saved, r.outside); else renderFoot();
    }, (e) => {
      settle();
      // preload.js's own sentence for a call that never reached Mantle is whole: not "did not answer (did not answer...)"
      const m = String(e && e.message ? e.message : e);
      S.saved = Object.assign({}, S.saved, { ok: false, reason: /^(Mantle did not answer\.|This page asked Mantle)/.test(m) ? m : `Mantle did not answer (${m})` });
      renderFoot();
    });
  }
  function applySaved(saved, outside) {
    if (saved) S.saved = { ok: !!saved.ok, at: saved.at || null, reason: saved.reason || null, rev: Number(saved.rev) || 0 };
    if (outside !== undefined) S.outside = outside || null;
    renderFoot();
  }

  /* ---- delete: one click, then Undo for 8 s ---- */
  function dropUndo() { clearTimeout(undoTimer); undoTimer = null; S.undo = null; }
  function onDelete() {
    const now = Date.now();
    if (now - S.lastDel < CLICK_GAP_MS) return;         // a double click deletes ONE note, not two
    S.lastDel = now;
    if (S.deleting || !S.loaded || delBtn.disabled) return;
    doDelete();
  }
  function doDelete() {
    const id = S.active;
    S.deleting = true; S.delError = null;
    ta.readOnly = true;                                  // no keystroke lands in a note on its way out
    renderFoot();
    const done = (r) => {
      S.deleting = false;
      ta.readOnly = !!S.error;
      if (r && r.ok) {
        const i = S.notes.findIndex((n) => n.id === id);
        const gone = i >= 0 ? S.notes.splice(i, 1)[0] : null;
        delete S.carets[id];
        let filler = null;
        if (!S.notes.length) { filler = { id: newId(), text: '' }; S.notes.push(filler); }
        dropUndo();
        if (gone && gone.text.trim() !== '') {
          S.undo = { note: { id: gone.id, text: gone.text }, index: i, filler: filler && filler.id };
          undoTimer = setTimeout(() => { dropUndo(); renderFoot(); }, UNDO_MS);
        }
        S.active = null;
        activate(S.notes[Math.max(0, i - 1)].id, true);
        if (r.saved) applySaved(r.saved);
        S.rev++;
        sendDirty();
        if (S.find.open) runFind(false);
      } else {
        // main already says "not deleted: <why>"; the footer adds its own "Not deleted:" (said once)
        S.delError = String((r && r.reason) || 'Mantle did not say why').replace(/^not deleted:\s*/i, '');
        renderFoot();
      }
    };
    mantle.call('notes.delete', { id }).then(done, (e) => done({ ok: false, reason: e && e.message ? e.message : String(e) }));
  }
  function undoDelete() {
    const u = S.undo;
    if (!u || !S.loaded || S.error) return;
    dropUndo();
    // the blank note that stood in for the last one goes again, unless something was typed into it
    if (u.filler) {
      const k = S.notes.findIndex((n) => n.id === u.filler);
      if (k >= 0 && S.notes[k].text.trim() === '' && S.notes.length === 1) S.notes.splice(k, 1);
    }
    const note = S.notes.some((n) => n.id === u.note.id) ? { id: newId(), text: u.note.text } : u.note;
    S.notes.splice(Math.min(Math.max(0, u.index), S.notes.length), 0, note);
    activate(note.id, true);
    changed();
  }

  /* ---- find across every note (Ctrl+F): the text never leaves this page ---- */
  function findSoon() { clearTimeout(findTimer); findTimer = setTimeout(() => runFind(false), 120); }
  /** Every hit of the query in every note (case-insensitive), in tab order; capped at MAX_HITS. */
  function runFind(resetCur) {
    clearTimeout(findTimer); findTimer = null;
    const f = S.find;
    const q = qEl.value;
    const same = q === f.q;
    f.q = q;
    f.hits = []; f.per = Object.create(null);
    const needle = q.toLocaleLowerCase();
    if (needle) {
      for (const n of S.notes) {
        const hay = n.text.toLocaleLowerCase();
        if (hay.length !== n.text.length) {             // a case fold changed lengths (rare scripts): search as typed
          let at = n.text.indexOf(q);
          while (at >= 0 && f.hits.length < MAX_HITS) { f.hits.push({ id: n.id, at, len: q.length }); f.per[n.id] = (f.per[n.id] || 0) + 1; at = n.text.indexOf(q, at + Math.max(1, q.length)); }
        } else {
          let at = hay.indexOf(needle);
          while (at >= 0 && f.hits.length < MAX_HITS) { f.hits.push({ id: n.id, at, len: needle.length }); f.per[n.id] = (f.per[n.id] || 0) + 1; at = hay.indexOf(needle, at + Math.max(1, needle.length)); }
        }
        if (f.hits.length >= MAX_HITS) break;
      }
    }
    if (resetCur || !same || f.cur >= f.hits.length) f.cur = -1;
    if (f.cur < 0) f.mark = null;                         // a new query: no match is "this one" yet
    renderFind();
    renderTabs();
    paintMark();
  }
  function renderFind() {
    const f = S.find;
    const n = f.hits.length, notes = Object.keys(f.per).length;
    let words = '';
    if (f.q && !n) words = 'No matches';
    else if (n && f.cur >= 0) words = `${f.cur + 1} of ${n >= MAX_HITS ? MAX_HITS + '+' : n}`;
    else if (n) words = `${n >= MAX_HITS ? MAX_HITS + '+' : n} in ${plural(notes, 'note')}`;
    countEl.textContent = words;
    findEl.classList.toggle('none', !!f.q && !n);
    prevBtn.disabled = nextBtn.disabled = !n;
  }
  function openFind() {
    if (!S.loaded || S.error) return;
    const f = S.find;
    if (!f.open) {
      f.open = true;
      findEl.hidden = false;
      pad.classList.add('finding');
      findBtn.classList.add('on'); findBtn.setAttribute('aria-expanded', 'true');
      // a short one-line selection in the text is what you want to find
      const sel = ta.value.slice(ta.selectionStart, ta.selectionEnd);
      if (sel && sel.length <= 100 && !/\n/.test(sel)) qEl.value = sel;
      runFind(true);
    }
    qEl.focus();
    qEl.select();
  }
  function closeFind(focusText) {
    const f = S.find;
    if (!f.open) return;
    f.open = false; f.q = ''; f.hits = []; f.per = Object.create(null); f.cur = -1; f.mark = null;
    clearTimeout(findTimer); findTimer = null;
    paintMark();
    findEl.hidden = true;
    pad.classList.remove('finding');
    findBtn.classList.remove('on'); findBtn.setAttribute('aria-expanded', 'false');
    renderTabs();
    if (focusText) ta.focus();
  }
  /** Go to the next (d=1) or previous (d=-1) hit: its tab opens, the hit is selected and scrolled to. */
  function jump(d) {
    const f = S.find;
    if (findTimer || qEl.value !== f.q) runFind(false);
    if (!f.hits.length) return;
    if (f.cur < 0) {
      // the first Enter: the first hit at or after the caret in the open note, else the first one after it
      const order = S.notes.map((n) => n.id);
      const ai = order.indexOf(S.active);
      const caret = ta.selectionStart;
      let k = f.hits.findIndex((h) => { const hi = order.indexOf(h.id); return hi > ai || (hi === ai && h.at >= caret); });
      if (d < 0) { k = (k < 0 ? f.hits.length : k) - 1; if (k < 0) k = f.hits.length - 1; }
      f.cur = k < 0 ? 0 : k;
    } else f.cur = (f.cur + d + f.hits.length) % f.hits.length;
    const h = f.hits[f.cur];
    if (h.id !== S.active) activate(h.id, false);
    show(h.at, h.at + h.len);
    renderFind();
  }
  /** Select [a, b) in the text, mark it, and scroll it to about a third of the way down. */
  function show(a, b) {
    ta.setSelectionRange(a, b);
    const m = S.find.mark = { id: S.active, a, b, text: ta.value.slice(a, b), w: 0, len: -1, rows: 0, y: -1 };
    layoutMark(m);
    // the hit's row: from the mark's layout, or (a paragraph too long to copy) the twin's row count
    const y = m.y >= 0 ? m.y : twinHeight(ta.value.slice(0, a));
    ta.scrollTop = Math.max(0, y - ta.clientHeight / 3);
    S.carets[S.active] = [a, b, ta.scrollTop];
    paintMark();
  }
  /** The height a textarea of the text's width and type needs for `s`: a hidden twin counts wrapped rows. */
  function twinHeight(s) {
    const twin = twinHeight.el || (twinHeight.el = Object.assign(document.createElement('textarea'), { tabIndex: -1 }));
    if (!twin.isConnected) {
      twin.className = 'twin'; twin.setAttribute('aria-hidden', 'true');
      ta.parentNode.appendChild(twin);
    }
    twin.style.width = ta.clientWidth + 'px';
    twin.value = s;
    twin.style.height = '0px';
    const h = twin.scrollHeight;
    twin.value = '';
    return h;
  }
  /**
   * Find's mark. Chromium paints no selection in a textarea that does not have the keyboard, and while
   * you step through matches the keyboard stays in the find box, so the match is drawn BEHIND the text:
   * the match's paragraph is copied into #mirror (the textarea's padding, type and wrapping; its words
   * invisible) with the match in a <mark>, shifted down by the wrapped rows above that paragraph. Only
   * the paragraph is copied (up to MARK_PARA characters before the match, MARK_TAIL after it: what
   * follows only matters for the match's own row), so a 3.8 MB note costs the one twin count show()
   * always paid. m.rows = the paragraph's top offset; m.y = the bottom of the match's first row, both
   * in the text's own (unscrolled) pixels; m.y = -1 when the paragraph is too long to copy (no mark).
   */
  function layoutMark(m) {
    const v = ta.value;
    m.w = ta.clientWidth; m.len = v.length; m.y = -1; m.rows = 0;
    const ls = m.a > 0 ? v.lastIndexOf('\n', m.a - 1) + 1 : 0;
    if (m.a - ls > MARK_PARA) { mirrorEl.textContent = ''; return; }
    let le = v.indexOf('\n', m.b);
    le = Math.min(le < 0 ? v.length : le, m.b + MARK_TAIL);
    // the rows above the paragraph: a twin of everything before it (it ends in a newline, so it has one
    // empty row more) less a twin of nothing (its padding and that one row). scrollHeight is a whole
    // number and a row is 19.5 px, so snap to whole rows (unsnapped, the mark sat 1.3 px high).
    const lh = parseFloat(getComputedStyle(ta).lineHeight) || 19.5;
    m.rows = ls ? Math.round((twinHeight(v.slice(0, ls)) - twinHeight('')) / lh) * lh : 0;
    const mk = document.createElement('mark');
    mk.textContent = v.slice(m.a, m.b);
    // the rows above as a spacer IN the flow, and #hl scrolled like the text: the paragraph lands on the
    // same fractional rows as the text's own (a moved or transformed box snapped its glyphs ~1 px off)
    const gap = document.createElement('div');
    gap.style.height = m.rows + 'px';
    mirrorEl.replaceChildren(gap, document.createTextNode(v.slice(ls, m.a)), mk, document.createTextNode(v.slice(m.b, le)));
    mirrorEl.style.width = m.w + 'px';
    mirrorEl.style.minHeight = ta.scrollHeight + 'px';     // so #hl can scroll as far as the text does
    const r = mk.getClientRects()[0];
    if (r) m.y = r.bottom - mirrorEl.getBoundingClientRect().top;
  }
  /** Show the mark only while it is true: find open, the match's note open, the match still selected
   *  and the text NOT focused (then Chromium paints the selection itself). A new width lays it out again. */
  function paintMark() {
    const m = S.find.mark;
    const on = !!m && S.find.open && m.id === S.active && document.activeElement !== ta
      && ta.selectionStart === m.a && ta.selectionEnd === m.b && ta.value.slice(m.a, m.b) === m.text;
    if (on && (m.w !== ta.clientWidth || m.len !== ta.value.length)) layoutMark(m);
    const vis = on && m.y >= 0;
    if (vis) placeMark();
    hlEl.classList.toggle('on', vis);
    if (!m && mirrorEl.firstChild) mirrorEl.textContent = '';   // no copy of the text kept once find is done
  }
  function placeMark() {
    const m = S.find.mark;
    if (m) hlEl.scrollTop = ta.scrollTop;
  }

  /* ---- close ---- */
  function close() {
    dropUndo();
    closeFind(false);
    renderFoot();
    clearTimeout(debounce); debounce = null;
    if (mantle) mantle.call('notes.close', { refocus: true }).catch(() => {});
  }

  /* ---- events ---- */
  ta.addEventListener('input', () => {
    const n = cur();
    if (!n) return;
    n.text = ta.value;
    S.delError = null;
    if (S.find.mark) { S.find.mark = null; paintMark(); }   // the text moved under the match: no stale mark
    renderTabLabel();
    changed();
  });
  // the mark follows the text as it scrolls; the text's own selection takes over while it has the keyboard
  ta.addEventListener('scroll', () => { if (hlEl.classList.contains('on')) placeMark(); }, { passive: true });
  ta.addEventListener('focus', paintMark);
  ta.addEventListener('blur', paintMark);
  window.addEventListener('resize', paintMark);
  tabsEl.addEventListener('mousedown', (e) => {
    const b = e.target.closest('.tab');
    if (!b || e.button !== 0) return;
    e.preventDefault();                                   // keep the caret in the text
    if (b.dataset.id !== S.active) activate(b.dataset.id, true); else ta.focus();
  });
  tabsEl.addEventListener('keydown', (e) => {
    if (!e.target.closest('.tab') || e.ctrlKey || e.altKey || e.metaKey) return;
    if (e.key === 'ArrowRight') { e.preventDefault(); step(1, true); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1, true); }
    else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      if (S.notes.length) { activate(S.notes[e.key === 'Home' ? 0 : S.notes.length - 1].id, false); const b = tabsEl.querySelector('.tab.on'); if (b) b.focus(); }
    } else if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') { e.preventDefault(); ta.focus(); }
  });
  tabsEl.addEventListener('wheel', (e) => {
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { tabsEl.scrollLeft += e.deltaY; e.preventDefault(); }
  }, { passive: false });
  tabsEl.addEventListener('scroll', edges, { passive: true });
  for (const b of [addBtn, findBtn, delBtn, undoBtn, prevBtn, nextBtn, fcloseBtn]) b.addEventListener('mousedown', (e) => e.preventDefault());
  addBtn.addEventListener('click', newNote);
  delBtn.addEventListener('click', onDelete);
  undoBtn.addEventListener('click', undoDelete);
  prevBtn.addEventListener('click', () => jump(-1));
  nextBtn.addEventListener('click', () => jump(1));
  fcloseBtn.addEventListener('click', () => closeFind(true));
  findBtn.addEventListener('click', () => { if (S.find.open) closeFind(true); else openFind(); });
  qEl.addEventListener('input', () => { S.find.cur = -1; findSoon(); });
  qEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); jump(e.shiftKey ? -1 : 1); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeFind(true); }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); if (S.find.open) closeFind(true); else close(); return; }
    if (e.key === 'F3' && S.find.open) { e.preventDefault(); jump(e.shiftKey ? -1 : 1); return; }
    if (e.ctrlKey && !e.altKey && !e.metaKey) {
      if (e.key === 'Tab') { e.preventDefault(); step(e.shiftKey ? -1 : 1); return; }
      if ((e.key === 'n' || e.key === 'N') && !e.shiftKey) { e.preventDefault(); newNote(); return; }
      if ((e.key === 'f' || e.key === 'F') && !e.shiftKey) { e.preventDefault(); openFind(); }
    }
  });
  window.addEventListener('blur', () => { if (S.rev > S.saved.rev) sendDirty(); });

  function focusText() {
    if (!S.loaded) { S.wantFocus = true; return; }
    S.wantFocus = false;
    ta.focus();
  }

  /* ---- main's side ---- */
  window.__notesTake = function (opts) {
    if (!S.loaded || S.error) return null;
    const n = cur();
    if (n && n.text !== ta.value) { n.text = ta.value; S.rev++; }
    if (opts && opts.prune) prune();
    return { rev: S.rev, notes: S.notes.map((x) => ({ id: x.id, text: x.text })), active: S.active };
  };
  Object.defineProperty(window, '__notes', {
    get() {
      return {
        loaded: S.loaded, rev: S.rev, active: S.active, deleting: S.deleting, undo: !!S.undo,
        notes: S.notes.map((x) => ({ id: x.id, text: x.text })), saved: Object.assign({}, S.saved),
        footer: statusEl.textContent, warn: statusEl.classList.contains('warn'), notice: noticeEl.hidden ? '' : noticeEl.textContent,
        delDisabled: delBtn.disabled, readOnly: ta.readOnly, tabs: [...tabsEl.querySelectorAll('.tab')].map((b) => b.textContent),
        find: { open: S.find.open, q: S.find.q, hits: S.find.hits.length, cur: S.find.cur, count: countEl.textContent, marked: hlEl.classList.contains('on') },
        sel: [ta.selectionStart, ta.selectionEnd], scrollTop: ta.scrollTop,
      };
    },
  });

  if (!mantle || typeof mantle.call !== 'function') {
    S.error = 'this pad has no bridge to Mantle (window.mantle is missing), so nothing typed here can be saved';
    ta.readOnly = true;
    render();
    return;
  }

  mantle.on('notes.state', (p) => {
    if (!p) return;
    if (p.file) S.file = p.file;
    if (p.folder) S.folder = p.folder;
    if (Array.isArray(p.rescued)) S.rescued = p.rescued;
    S.loadError = p.loadError || null;
    applySaved(p.saved, p.outside);
  });
  mantle.on('notes.open', (p) => {
    pad.classList.remove('anim');
    void pad.offsetWidth;                                 // restart the entrance
    pad.classList.add('anim');
    S.delError = null;
    if (p && p.reload && Array.isArray(p.reload.notes) && p.reload.notes.length) {
      dropUndo();
      S.notes = p.reload.notes.map((n) => ({ id: String(n.id), text: String(n.text) }));
      S.carets = Object.create(null);
      S.rev = Number(p.reload.rev) || 0;
      S.saved = Object.assign({}, S.saved, { rev: S.rev });
      S.active = null;
      activate(p.reload.active, false);
    } else renderFoot();
    if (p && p.focus) focusText();
    // dark: one picture of what is behind the pad for this opening (ui/shared/hud-backdrop.js)
    if (window.MantleHudBackdrop) window.MantleHudBackdrop.request('opened', { hold: true });
  });
  mantle.on('notes.new', () => newNote());

  mantle.call('notes.load', {}).then((r) => {
    S.notes = (r && Array.isArray(r.notes) && r.notes.length ? r.notes : [{ id: 'n0', text: '' }]).map((n) => ({ id: String(n.id), text: String(n.text) }));
    S.file = (r && r.file) || ''; S.folder = (r && r.folder) || '';
    S.outside = (r && r.outside) || null;
    S.loadError = (r && r.loadError) || null;
    S.rescued = (r && r.rescued) || [];
    if (r && r.saved) S.saved = { ok: !!r.saved.ok, at: r.saved.at || null, reason: r.saved.reason || null, rev: Number(r.saved.rev) || 0 };
    S.rev = S.saved.rev + (r && r.dirty ? 1 : 0);
    S.loaded = true;
    activate(r && r.active, false);
    if (S.wantFocus) focusText();
    document.documentElement.dataset.loaded = '1';
  }, (e) => {
    S.error = `Could not load your notes: ${e && e.message ? e.message : e}. Typing is off so nothing is overwritten`;
    ta.readOnly = true;
    render();
  });
  render();
})();

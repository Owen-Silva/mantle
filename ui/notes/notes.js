/* notes.js — the quick notes pad's page (lane tbnotes, 2026-09-27; main: lib/features/notes.js).
 *
 * THE TEXT STAYS HERE until main asks for it. Typing bumps `rev`; 400 ms after typing stops (and
 * on blur) the page calls notes.dirty {rev} — no text — and main PULLS the set through
 * window.__notesTake() (executeJavaScript) and writes it. So no note text ever travels as a
 * mantle.call argument, which main's call log could write to mantle.log. Text only arrives here in
 * notes.load's result and in the notes.open push (a reload after an outside change).
 *
 * Tabs (each note's first line), "+" / Ctrl+N a new note, Ctrl+Tab / Ctrl+Shift+Tab switch, Esc
 * closes (an empty extra note is dropped on close, never the last one). Delete asks TWICE, each ask
 * times out after 4 s and clicks under 300 ms apart do not count. The footer says, in plain words,
 * saved / saving / NOT saved with the reason (and the path as its tooltip): nothing fails silently.
 * Timers: only the 400 ms debounce and the 4 s delete arm; main runs the 5 s retry while unsaved.
 */
(function () {
  'use strict';
  const mantle = window.mantle;
  const $ = (id) => document.getElementById(id);
  const pad = $('pad'), tabsEl = $('tabs'), topEl = pad.querySelector('.top'), ta = $('text');
  const foot = $('foot'), statusEl = $('status'), noticeEl = $('notice'), delBtn = $('del'), addBtn = $('add');

  const DEBOUNCE_MS = 400, ARM_MS = 4000, CLICK_GAP_MS = 300, TAB_CHARS = 18;
  const S = {
    loaded: false, notes: [], active: null, rev: 0,
    saved: { ok: true, at: null, reason: null, rev: 0 },
    file: '', folder: '', outside: null, loadError: null, rescued: [],
    arm: 0, lastClick: 0, deleting: false, delError: null,
    carets: Object.create(null), wantFocus: false, error: null,
  };
  let debounce = null, armTimer = null, seq = 0;

  const cur = () => S.notes.find((n) => n.id === S.active) || null;
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  // the clock the way the top bar and the timer's pop-up write it ("9:14 PM" here), not a 24-hour one
  const hhmm = (t) => { const d = new Date(t); try { return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); } catch (_) { return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; } };
  const base = (p) => String(p || '').split(/[\\/]/).pop();

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
  function renderTabs() {
    const frag = document.createDocumentFragment();
    for (const n of S.notes) {
      const b = document.createElement('button');
      const words = label(n.text);
      b.type = 'button';
      b.className = 'tab' + (n.id === S.active ? ' on' : '') + (words ? '' : ' empty');
      b.dataset.id = n.id;
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', n.id === S.active ? 'true' : 'false');
      b.tabIndex = -1;
      const s = document.createElement('span');
      s.className = 'lb';
      s.textContent = words || 'New note';
      b.appendChild(s);
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
    const words = label(n.text);
    b.classList.toggle('empty', !words);
    b.firstChild.textContent = words || 'New note';
  }

  function renderFoot() {
    let words = '', warn = false;
    const n = S.notes.length;
    if (S.error) { words = S.error; warn = true; }
    else if (S.delError) { words = `Not deleted: ${S.delError}`; warn = true; }
    else if (!S.saved.ok) { words = `Not saved: ${S.saved.reason || 'Mantle did not say why'} · your text is kept here and saved again as you type`; warn = true; }
    else if (S.loadError) { words = `Could not read your notes: ${S.loadError}`; warn = true; }
    else if (!S.loaded) words = 'Opening…';
    else if (S.rev > S.saved.rev) words = 'Saving…';
    else if (S.saved.at) words = `Saved ${hhmm(S.saved.at)} · ${plural(n, 'note')}`;
    else words = `All saved · ${plural(n, 'note')}`;
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
    delBtn.disabled = !S.loaded || S.deleting || !!S.error;
    delBtn.classList.toggle('armed', S.arm > 0);
    delBtn.textContent = S.deleting ? 'Deleting…' : S.arm === 1 ? 'Delete this note?' : S.arm === 2 ? 'Sure? It goes to deleted.md' : 'Delete';
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
    disarm();
    S.delError = null;
    render();
    if (focus) ta.focus();
  }
  function changed() {
    S.rev++;
    renderFoot();
    clearTimeout(debounce);
    debounce = setTimeout(sendDirty, DEBOUNCE_MS);
  }
  function newNote() {
    if (!S.loaded || S.error) return;
    const n = { id: `p${Date.now().toString(36)}${++seq}`, text: '' };
    const i = S.notes.findIndex((x) => x.id === S.active);
    S.notes.splice(i < 0 ? S.notes.length : i + 1, 0, n);
    activate(n.id, true);
    changed();
  }
  function step(d) {
    if (S.notes.length < 2) return;
    const i = S.notes.findIndex((x) => x.id === S.active);
    activate(S.notes[(i + d + S.notes.length) % S.notes.length].id, true);
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
    if (!mantle || !S.loaded) return;
    if (S.rev <= S.saved.rev && S.saved.ok) return;
    mantle.call('notes.dirty', { rev: S.rev }).then((r) => {
      if (r && r.saved) applySaved(r.saved, r.outside);
    }, (e) => {
      S.saved = Object.assign({}, S.saved, { ok: false, reason: `Mantle did not answer (${e && e.message ? e.message : e})` });
      renderFoot();
    });
  }
  function applySaved(saved, outside) {
    if (saved) S.saved = { ok: !!saved.ok, at: saved.at || null, reason: saved.reason || null, rev: Number(saved.rev) || 0 };
    if (outside !== undefined) S.outside = outside || null;
    renderFoot();
  }

  /* ---- delete: asks twice ---- */
  function disarm() { clearTimeout(armTimer); armTimer = null; S.arm = 0; }
  function onDelete() {
    const now = Date.now();
    const quick = now - S.lastClick < CLICK_GAP_MS;
    S.lastClick = now;
    if (quick || S.deleting || !S.loaded) return;       // a double click is not two answers
    if (S.arm < 2) {
      S.arm++;
      clearTimeout(armTimer);
      armTimer = setTimeout(() => { disarm(); renderDel(); }, ARM_MS);
      renderDel();
      return;
    }
    disarm();
    doDelete();
  }
  function doDelete() {
    const id = S.active;
    S.deleting = true; S.delError = null;
    renderFoot();
    const done = (r) => {
      S.deleting = false;
      if (r && r.ok) {
        const i = S.notes.findIndex((n) => n.id === id);
        if (i >= 0) S.notes.splice(i, 1);
        delete S.carets[id];
        if (!S.notes.length) S.notes.push({ id: `p${Date.now().toString(36)}${++seq}`, text: '' });
        S.active = null;
        activate(S.notes[Math.max(0, i - 1)].id, true);
        if (r.saved) applySaved(r.saved);
        S.rev++;
        sendDirty();
      } else {
        S.delError = (r && r.reason) || 'Mantle did not say why';
        renderFoot();
      }
    };
    mantle.call('notes.delete', { id }).then(done, (e) => done({ ok: false, reason: e && e.message ? e.message : String(e) }));
  }

  /* ---- close ---- */
  function close() {
    disarm();
    renderDel();
    clearTimeout(debounce); debounce = null;
    if (mantle) mantle.call('notes.close', { refocus: true }).catch(() => {});
  }

  /* ---- events ---- */
  ta.addEventListener('input', () => {
    const n = cur();
    if (!n) return;
    n.text = ta.value;
    S.delError = null;
    if (S.arm) disarm();
    renderTabLabel();
    changed();
  });
  tabsEl.addEventListener('mousedown', (e) => {
    const b = e.target.closest('.tab');
    if (!b) return;
    e.preventDefault();                                   // keep the caret in the text
    if (b.dataset.id !== S.active) activate(b.dataset.id, true); else ta.focus();
  });
  tabsEl.addEventListener('wheel', (e) => {
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { tabsEl.scrollLeft += e.deltaY; e.preventDefault(); }
  }, { passive: false });
  tabsEl.addEventListener('scroll', edges, { passive: true });
  addBtn.addEventListener('mousedown', (e) => e.preventDefault());
  addBtn.addEventListener('click', newNote);
  delBtn.addEventListener('mousedown', (e) => e.preventDefault());
  delBtn.addEventListener('click', onDelete);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.ctrlKey && !e.altKey && !e.metaKey) {
      if (e.key === 'Tab') { e.preventDefault(); step(e.shiftKey ? -1 : 1); return; }
      if ((e.key === 'n' || e.key === 'N') && !e.shiftKey) { e.preventDefault(); newNote(); }
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
        loaded: S.loaded, rev: S.rev, active: S.active, arm: S.arm, deleting: S.deleting,
        notes: S.notes.map((x) => ({ id: x.id, text: x.text })), saved: Object.assign({}, S.saved),
        footer: statusEl.textContent, warn: statusEl.classList.contains('warn'), notice: noticeEl.hidden ? '' : noticeEl.textContent,
        del: delBtn.textContent, tabs: [...tabsEl.querySelectorAll('.tab')].map((b) => b.textContent),
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
    disarm();
    S.delError = null;
    if (p && p.reload && Array.isArray(p.reload.notes) && p.reload.notes.length) {
      S.notes = p.reload.notes.map((n) => ({ id: String(n.id), text: String(n.text) }));
      S.carets = Object.create(null);
      S.rev = Number(p.reload.rev) || 0;
      S.saved = Object.assign({}, S.saved, { rev: S.rev });
      S.active = null;
      activate(p.reload.active, false);
    } else renderFoot();
    if (p && p.focus) focusText();
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

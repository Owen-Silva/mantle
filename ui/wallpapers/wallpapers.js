'use strict';
/*
 * The Wallpapers window: Owen's wallpaper library, which replaced Lively's (2026-09-22).
 *
 * A plain browser script (contextIsolation + sandbox); window.mantle is the only way out. It asks
 * lib/wallpaper.js for everything and keeps nothing of its own but what is on screen:
 *   'wallpaper.library'  the whole listing, pushed on every change (replayed on subscribe)
 *   wallpaper.set / remove / add / props / prop / propsReset / reimport / thumb / window
 *
 * WHY IT IS ITS OWN WINDOW: the desktop layer that shows the wallpaper sits UNDER the icons and
 * never receives a click, so the place to choose a wallpaper has to be a normal window. It opens
 * from the launcher ("Wallpapers") and from the tray menu.
 *
 * THUMBNAILS: a video with none (anything Owen adds; all nine of his Lively ones brought their own)
 * gets one here, by playing it muted in a detached <video>, seeking a second in, and drawing that
 * frame. It doubles as the codec check: a video Chromium cannot decode fails right here, and the
 * card says so the moment it is added instead of the desktop going black later.
 *
 * Every failure is a sentence on screen: a card's own state line, the notice under the header for
 * adds and imports, and the Playback section for the pause rules.
 *
 * KEYBOARD (2026-09-29, lane launch-desk): the grid is one tab stop; arrows / Home / End move
 * between cards, Enter puts the card on the desktop, Delete removes it (with Undo in the notice),
 * Esc dismisses the notice, then closes the window. Remove has Undo instead of "are you sure".
 */
(function () {
  const $ = (id) => document.getElementById(id);
  // Reasons arrive as clauses ("its file … is missing"); standing alone on a card they start a sentence.
  const cap = (s) => (s ? String(s).charAt(0).toUpperCase() + String(s).slice(1) : '');
  const M = window.mantle;

  const els = {
    groundImg: $('ground-img'), headSub: $('head-sub'), grid: $('grid'), empty: $('empty'),
    detail: $('detail'), playLine: $('play-line'), rules: $('rules'), livelyLine: $('lively-line'),
    report: $('report'), livelyActions: $('lively-actions'), libDir: $('lib-dir'),
    notice: $('notice'), noticeText: $('notice-text'), drop: $('drop'),
  };

  if (!M || typeof M.call !== 'function') {
    els.headSub.textContent = 'The Mantle bridge is missing: preload.js did not load, so this window cannot read the library.';
    return;
  }

  let L = null;               // the last listing
  let focusId = null;         // the card whose details are on the right
  let undoTimer = 0;         // hides the Undo notice when the undo window closes
  let propsFor = null;        // the id the property editor was built for
  const cards = new Map();    // id -> card element

  function h(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }

  function byId(id) { return L ? L.items.find((i) => i.id === id) || null : null; }

  // ---- the notice under the header -------------------------------------
  function notice(html, bad) {
    clearTimeout(undoTimer);
    els.noticeText.replaceChildren();
    for (const n of html) els.noticeText.appendChild(n);
    els.notice.classList.toggle('bad', !!bad);
    els.notice.hidden = false;
  }
  function hideNotice() { clearTimeout(undoTimer); els.notice.hidden = true; }
  $('notice-x').addEventListener('click', hideNotice);

  function sayError(what, err) {
    notice([h('b', null, what + ': '), document.createTextNode(err && err.message ? err.message : String(err))], true);
  }

  // ---- state line for one item -----------------------------------------
  function stateOf(it) {
    if (!it.health.ok) return { bad: true, text: cap(it.health.reason) };
    const rt = it.runtime;
    if (rt && rt.state === 'error') return { bad: true, text: 'Did not play: ' + rt.reason };
    if (it.needsThumb) return { bad: false, text: 'Making a thumbnail…' };
    if (it.selected) {
      const pb = L.playback;
      if (pb && pb.paused) return { bad: false, text: 'On your desktop, paused' };
      if (rt && (rt.state === 'playing' || rt.state === 'ready')) return { bad: false, text: 'On your desktop, playing' };
      return { bad: false, text: 'On your desktop, loading' };
    }
    return { bad: false, text: it.origin };
  }

  // ---- the grid ----------------------------------------------------------
  function renderCard(it) {
    let c = cards.get(it.id);
    if (!c) {
      c = h('button', 'card');
      c.type = 'button';
      c.setAttribute('role', 'option');
      c.dataset.id = it.id;
      c.addEventListener('click', () => focus(it.id));
      c.addEventListener('dblclick', () => setWallpaper(it.id));
      cards.set(it.id, c);
    }
    const st = stateOf(it);
    c.className = 'card' + (it.id === focusId ? ' is-focus' : '') + (it.selected ? ' is-selected' : '') + (st.bad ? ' is-bad' : '');
    c.tabIndex = it.id === (focusId || (L.items[0] && L.items[0].id)) ? 0 : -1;
    c.setAttribute('aria-selected', it.id === focusId ? 'true' : 'false');
    c.setAttribute('aria-label', it.title + (it.selected ? ', on your desktop' : ''));
    // The full name on hover (long ones are cut with an ellipsis), and how to use the card.
    c.title = it.title + (it.selected ? '\nOn your desktop' : (it.health.ok ? '\nDouble-click or press Enter to set as wallpaper' : ''));
    const thumb = h('div', 'thumb');
    if (it.thumbUrl) {
      const img = h('img');
      img.alt = '';
      img.loading = 'lazy';
      img.src = it.thumbUrl;
      thumb.appendChild(img);
    } else {
      thumb.appendChild(h('div', 'no-thumb', it.type === 'video' ? (it.needsThumb ? 'Making a thumbnail…' : 'No thumbnail') : 'No thumbnail picture'));
    }
    if (it.selected) {
      // The one accent mark in the grid: a tick on what is on the desktop now.
      const tick = h('span', 'tick');
      tick.setAttribute('aria-hidden', 'true');
      tick.innerHTML = '<svg viewBox="0 0 12 12"><path d="M2.6 6.3l2.2 2.2 4.6-4.9"/></svg>';
      thumb.appendChild(tick);
    }
    const title = h('div', 'card-title', it.title);
    const meta = h('div', 'card-meta');
    meta.appendChild(h('span', 'chip', it.typeLabel));
    const parts = [thumb, title, meta];
    if (st.bad) {
      const bad = h('div', 'card-bad');
      bad.appendChild(h('span', 'pip'));
      bad.appendChild(h('span', null, st.text));
      parts.push(bad);
    } else {
      meta.appendChild(h('span', 'card-state', st.text));
    }
    c.replaceChildren.apply(c, parts);
    return c;
  }

  function renderGrid() {
    const seen = new Set();
    const order = L.items.map((it) => { seen.add(it.id); return renderCard(it); });
    for (const [id, c] of cards) if (!seen.has(id)) { c.remove(); cards.delete(id); }
    // Re-append only when the order changed, so keyboard focus survives a push.
    const now = Array.from(els.grid.children);
    if (now.length !== order.length || now.some((c, i) => c !== order[i])) els.grid.replaceChildren.apply(els.grid, order);
    els.grid.classList.remove('is-loading');
    els.empty.hidden = L.items.length > 0;
    if (!L.items.length) {
      const kids = [];
      if (L.importing) {
        kids.push(h('b', null, 'Copying your Lively wallpapers…'), h('span', null, L.importing.done + ' of ' + L.importing.total + ' so far. They appear here as they arrive.'));
      } else {
        kids.push(h('b', null, 'No wallpapers yet'), h('span', null, 'Add a video, GIF or picture, or drop files on this window.'));
        const b = h('button', 'btn primary', 'Add wallpapers…');
        b.type = 'button';
        b.addEventListener('click', () => add({ pick: 'files' }));
        kids.push(b);
      }
      els.empty.replaceChildren.apply(els.empty, kids);
    }
  }

  // Before the first listing: grey placeholder cards, so nothing jumps when the library arrives.
  function renderLoading() {
    const kids = [];
    for (let i = 0; i < 6; i++) { const c = h('div', 'card skel'); c.appendChild(h('div', 'thumb')); c.appendChild(h('div', 'skel-line')); kids.push(c); }
    els.grid.classList.add('is-loading');
    els.grid.replaceChildren.apply(els.grid, kids);
  }

  function renderLoadFailed(msg) {
    els.grid.classList.remove('is-loading');
    els.grid.replaceChildren();
    els.empty.hidden = false;
    els.empty.replaceChildren(h('b', null, 'The library could not be read'), h('span', null, msg + '. Close this window and open it again; if that does not help, restart Mantle.'));
    els.headSub.textContent = '';
  }

  // ---- the details ---------------------------------------------------------
  function renderDetail() {
    const it = byId(focusId);
    const box = els.detail;
    if (!it) {
      propsFor = null;
      box.replaceChildren(h('p', 'detail-empty', L.items.length ? 'Pick a wallpaper to see it here. Double-click one to put it on the desktop.' : ''));
      return;
    }
    let head = box.querySelector('.d-head');
    let props = box.querySelector('.props');
    if (!head || head.dataset.id !== it.id) {
      head = h('div', 'd-head');
      head.dataset.id = it.id;
      props = h('div', 'props');
      props.hidden = true;
      box.replaceChildren(head, props);
      propsFor = null;
    }
    const big = h('div', 'big');
    if (it.thumbUrl) { const img = h('img'); img.alt = ''; img.src = it.thumbUrl; big.appendChild(img); } else big.appendChild(h('div', 'no-thumb', 'No thumbnail'));
    const kids = [big, h('h2', 'd-title', it.title)];
    const meta = [it.typeLabel, it.origin];
    if (it.author) meta.push('by ' + it.author);
    kids.push(h('p', 'd-meta', meta.join(' · ')));
    if (it.desc) kids.push(h('p', 'd-note', it.desc));
    const st = stateOf(it);
    kids.push(h('p', 'd-state' + (st.bad ? ' bad' : ''), st.text));
    if (it.runtime && it.runtime.state === 'ready' && it.runtime.reason) kids.push(h('p', 'd-state bad', cap(it.runtime.reason)));
    if (it.sysinfo) kids.push(h('p', 'd-note', 'Its GPU and network charts read 0: Mantle feeds it CPU and memory only (the same numbers as the System pane).'));
    if (it.runtime && it.runtime.notes && it.runtime.notes.length) {
      kids.push(h('p', 'd-note', 'The wallpaper\'s own page reported:'));
      const ul = h('ul', 'd-notes');
      for (const n of it.runtime.notes) ul.appendChild(h('li', null, n));
      kids.push(ul);
    }
    const acts = h('div', 'd-actions');
    const setBtn = h('button', 'btn primary', it.selected ? 'On your desktop' : 'Set as wallpaper');
    setBtn.id = 'd-set';
    setBtn.title = it.selected ? '' : 'Enter';
    setBtn.disabled = it.selected || !it.health.ok;
    setBtn.addEventListener('click', () => setWallpaper(it.id));
    acts.appendChild(setBtn);
    if (it.selected) {
      // The wallpaper's own Pause: held until pressed again, even across restarts.
      const paused = !!L.userPaused;
      const pz = h('button', 'btn', paused ? 'Play' : 'Pause');
      pz.id = 'd-pause';
      pz.setAttribute('aria-pressed', paused ? 'true' : 'false');
      pz.title = paused ? 'Play the wallpaper again' : 'Stop the wallpaper moving until you press Play';
      pz.addEventListener('click', () => setPaused(!paused, pz));
      acts.appendChild(pz);
    }
    const rmBtn = h('button', 'btn quiet', 'Remove');
    rmBtn.id = 'd-remove';
    rmBtn.title = 'Delete (you can undo it)';
    rmBtn.addEventListener('click', () => doRemove(it.id));
    acts.appendChild(rmBtn);
    kids.push(acts);
    head.replaceChildren.apply(head, kids);
    if (propsFor !== it.id) buildProps(it, props);
  }

  // ---- the property editor -------------------------------------------------
  // Built once per focused wallpaper, never on a library push: a push mid-drag
  // would otherwise tear the slider out from under the pointer.
  async function buildProps(it, box) {
    propsFor = it.id;
    box.hidden = true;
    box.replaceChildren();
    if (!it.hasProps) return;
    let P;
    try { P = await M.call('wallpaper.props', { id: it.id }); } catch (err) {
      box.hidden = false;
      box.replaceChildren(h('p', 'prop-err', 'Its settings could not be read: ' + err.message));
      return;
    }
    if (propsFor !== it.id) return;
    const head = h('div', 'props-head');
    head.appendChild(h('h2', null, 'Customise'));
    const reset = h('button', 'link', 'Reset');
    reset.title = 'Back to the wallpaper\'s own defaults';
    reset.addEventListener('click', async () => {
      try { await M.call('wallpaper.propsReset', { id: it.id }); propsFor = null; renderDetail(); } catch (err) { sayError('Reset failed', err); }
    });
    head.appendChild(reset);
    const kids = [head];
    if (P.reason) kids.push(h('p', 'prop-err', P.reason));
    for (const name of Object.keys(P.defs)) {
      const row = propControl(it.id, name, P.defs[name], P.values[name], P.options[name]);
      if (row) kids.push(row);
    }
    box.replaceChildren.apply(box, kids);
    box.hidden = false;
  }

  function sender(id, name, errEl) {
    let timer = 0;
    let pending = null;
    function send(value, persist) {
      return M.call('wallpaper.prop', { id, name, value, persist }).then(() => { errEl.textContent = ''; }).catch((err) => { errEl.textContent = err.message; });
    }
    return {
      // while dragging: at most ten a second, not saved
      live(value) {
        pending = value;
        if (timer) return;
        timer = setTimeout(() => { timer = 0; send(pending, false); }, 100);
      },
      // on release / change: saved
      commit(value) { clearTimeout(timer); timer = 0; send(value, true); },
    };
  }

  function propControl(id, name, def, value, options) {
    const type = def.type;
    if (type === 'label') return h('div', 'prop-label', value || def.text || name);
    const row = h('div', 'prop');
    const top = h('div', 'prop-row');
    const err = h('p', 'prop-err');
    const s = sender(id, name, err);
    const label = h('label', null, def.text || name);
    const cid = 'p-' + name.replace(/[^a-z0-9_-]/gi, '_');
    label.htmlFor = cid;
    top.appendChild(label);
    if (type === 'slider') {
      const min = Number(def.min);
      const max = Number(def.max);
      const step = def.step !== undefined ? Number(def.step) : 1;
      const out = h('span', 'prop-val');
      const fmt = (v) => String(Math.round(Number(v) * 100) / 100);
      out.textContent = fmt(value);
      top.appendChild(out);
      const r = h('input');
      r.type = 'range';
      r.id = cid;
      r.min = String(min);
      r.max = String(max);
      r.step = String(step > 0 ? step : 1);
      r.value = String(value);
      r.addEventListener('input', () => { out.textContent = fmt(r.value); s.live(Number(r.value)); });
      r.addEventListener('change', () => s.commit(Number(r.value)));
      row.appendChild(top);
      row.appendChild(r);
    } else if (type === 'checkbox') {
      const c = h('input');
      c.type = 'checkbox';
      c.id = cid;
      c.checked = !!value;
      c.addEventListener('change', () => s.commit(c.checked));
      top.appendChild(c);
      row.appendChild(top);
    } else if (type === 'color') {
      const c = h('input');
      c.type = 'color';
      c.id = cid;
      c.value = /^#[0-9a-f]{6}$/i.test(String(value)) ? String(value).toLowerCase() : '#000000';
      c.addEventListener('input', () => s.live(c.value));
      c.addEventListener('change', () => s.commit(c.value));
      top.appendChild(c);
      row.appendChild(top);
    } else if (type === 'dropdown' || type === 'scalerDropdown' || type === 'folderDropdown') {
      const sel = h('select');
      sel.id = cid;
      const items = type === 'folderDropdown' ? (options || []) : (def.items || []);
      items.forEach((txt, i) => {
        const o = h('option', null, String(txt));
        o.value = type === 'folderDropdown' ? String(txt) : String(i);
        sel.appendChild(o);
      });
      sel.value = String(value);
      if (type === 'folderDropdown' && !items.length) {
        const o = h('option', null, 'No files in ' + (def.folder || 'its folder'));
        sel.appendChild(o);
        sel.disabled = true;
      }
      sel.addEventListener('change', () => s.commit(type === 'folderDropdown' ? sel.value : Number(sel.value)));
      top.appendChild(sel);
      row.appendChild(top);
    } else if (type === 'textbox') {
      const t = h('input');
      t.type = 'text';
      t.id = cid;
      t.value = value === undefined || value === null ? '' : String(value);
      t.addEventListener('change', () => s.commit(t.value));
      top.appendChild(t);
      row.appendChild(top);
    } else if (type === 'button') {
      top.replaceChildren(h('span', 'prop-name', def.text || name));
      const b = h('button', 'btn', def.value || 'Run');
      b.addEventListener('click', () => s.commit(true));
      top.appendChild(b);
      row.appendChild(top);
    } else {
      top.appendChild(h('span', 'prop-val', 'not supported'));
      row.appendChild(top);
      row.appendChild(h('p', 'prop-help', 'Mantle does not know the "' + type + '" kind of setting, so this one cannot be changed here.'));
      return row;
    }
    if (def.help) row.appendChild(h('p', 'prop-help', def.help));
    row.appendChild(err);
    return row;
  }

  // ---- playback + Lively sections -------------------------------------------
  function renderSide() {
    const pb = L.playback;
    let line;
    let bad = false;
    if (!pb) line = 'Nothing reported yet.';
    else { line = pb.reason; bad = pb.ok === false; }
    els.playLine.textContent = line.charAt(0).toUpperCase() + line.slice(1);
    els.playLine.classList.toggle('bad', bad);
    const rows = [];
    if (pb && pb.rulesOk === false) {
      const r = h('div', 'rule not');
      r.appendChild(h('p', 'rule-note', pb.rulesReason));
      rows.push(r);
    }
    for (const ln of L.rules.lines) {
      const r = h('div', 'rule' + (ln.honoured ? '' : ' not'));
      const top = h('div', 'rule-row');
      top.appendChild(h('dt', null, ln.label));
      top.appendChild(h('dd', null, ln.value));
      r.appendChild(top);
      if (ln.note) r.appendChild(h('p', 'rule-note', ln.note));
      rows.push(r);
    }
    if (L.rules.from !== 'lively') {
      const r = h('div', 'rule');
      r.appendChild(h('p', 'rule-note', 'Lively\'s settings could not be read (' + (L.rules.reason || 'no reason given') + '), so these are Lively\'s defaults.'));
      rows.push(r);
    }
    els.rules.replaceChildren.apply(els.rules, rows);

    const lv = L.lively;
    const rep = lv && lv.report;
    if (L.importing) els.livelyLine.textContent = 'Copying from Lively: ' + L.importing.done + ' of ' + L.importing.total + '…';
    else if (rep) els.livelyLine.textContent = 'Last import ' + String(lv.importedAt || rep.at || '').replace('T', ' ').slice(0, 16) + ': ' + rep.reason + '.' + (L.livelyInstalled ? '' : ' Lively is no longer installed; every wallpaper above is Mantle\'s own copy.');
    else els.livelyLine.textContent = L.livelyInstalled ? 'Nothing imported yet.' : 'Lively is not installed, so there is nothing to import.';
    const lis = [];
    for (const l of (rep && rep.lines) || []) {
      const li = h('li');
      li.appendChild(h('span', 'r-title', l.title));
      if (l.ok) li.appendChild(h('span', 'r-ok', l.skipped ? 'removed, not copied' : 'ok'));
      else { li.appendChild(h('span', 'r-bad', 'not imported: ' + l.reason)); }
      lis.push(li);
    }
    els.report.replaceChildren.apply(els.report, lis);
    els.livelyActions.hidden = !L.livelyInstalled;
    $('reimport').disabled = !!L.importing;
    $('reimport-all').disabled = !!L.importing;
    els.libDir.textContent = 'Mantle\'s library: ' + L.dir;
  }

  function renderHead() {
    const n = L.items.length;
    const sel = L.items.find((i) => i.selected);
    const bits = [n + ' in your library'];
    if (L.importing) bits.push('copying from Lively ' + L.importing.done + '/' + L.importing.total);
    if (sel) bits.push((L.playback && L.playback.paused ? 'paused: ' : 'on your desktop: ') + sel.title);
    if (L.test) bits.push('test mode');
    els.headSub.textContent = bits.join(' · ');
    if (L.loadError) notice([h('b', null, 'The library file was damaged: '), document.createTextNode(L.loadError)], true);
    // The glass is frosted over the wallpaper this window is about.
    const url = sel && sel.thumbUrl;
    if (url && els.groundImg.getAttribute('src') !== url) els.groundImg.src = url;
    els.groundImg.classList.toggle('on', !!url);
  }

  function render(listing) {
    L = listing;
    if (focusId && !byId(focusId)) focusId = null;
    if (!focusId) { const sel = L.items.find((i) => i.selected); if (sel) focusId = sel.id; }
    renderHead();
    renderGrid();
    renderDetail();
    renderSide();
    queueThumbs();
  }

  function focus(id, moveKeyboard) {
    focusId = id;
    for (const [cid, c] of cards) {
      c.classList.toggle('is-focus', cid === id);
      c.setAttribute('aria-selected', cid === id ? 'true' : 'false');
      c.tabIndex = cid === id ? 0 : -1;
    }
    const c = cards.get(id);
    if (c && moveKeyboard) { c.focus(); c.scrollIntoView({ block: 'nearest' }); }
    renderDetail();
  }

  // ---- the keyboard ---------------------------------------------------------------------------
  // Arrows move by card (Up/Down by a row, however many columns the window is wide), Home/End to
  // the ends, Enter sets, Delete removes. One tab stop for the whole grid.
  function columns() {
    const list = Array.from(els.grid.children);
    if (list.length < 2) return 1;
    const top = list[0].offsetTop;
    const n = list.findIndex((c) => c.offsetTop !== top);
    return n < 0 ? list.length : n;
  }
  els.grid.addEventListener('keydown', (e) => {
    if (!L || !L.items.length || !e.target.classList || !e.target.classList.contains('card')) return;
    const ids = Array.from(els.grid.children).map((c) => c.dataset.id);
    const at = Math.max(0, ids.indexOf(e.target.dataset.id));
    const cols = columns();
    const to = { ArrowRight: at + 1, ArrowLeft: at - 1, ArrowDown: at + cols, ArrowUp: at - cols, Home: 0, End: ids.length - 1 }[e.key];
    if (to !== undefined) {
      e.preventDefault();
      focus(ids[Math.min(ids.length - 1, Math.max(0, to))], true);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      setWallpaper(e.target.dataset.id);
    } else if (e.key === 'Delete') {
      e.preventDefault();
      doRemove(e.target.dataset.id);
    }
  });

  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    if (document.activeElement && /^(SELECT|INPUT)$/.test(document.activeElement.tagName) && document.activeElement.type !== 'range' && document.activeElement.type !== 'checkbox') return;
    e.preventDefault();
    if (!els.notice.hidden) { hideNotice(); return; }
    M.call('wallpaper.window', { action: 'close' }).catch(() => window.close());
  });

  // ---- actions ------------------------------------------------------------------
  async function setWallpaper(id) {
    const it = byId(id);
    if (!it || it.selected) return;
    // Enter or a double-click on a broken card: say why here (its Set button is off for the same reason).
    if (!it.health.ok) { notice([h('b', null, 'Can\'t use "' + it.title + '": '), document.createTextNode(it.health.reason || 'its file is missing')], true); return; }
    try { await M.call('wallpaper.set', { id }); } catch (err) { sayError('Could not set "' + (it ? it.title : id) + '"', err); }
  }

  async function setPaused(on, btn) {
    if (btn) btn.disabled = true;   // feedback now; the listing push redraws it
    try { await M.call('wallpaper.setPaused', { paused: on }); } catch (err) { sayError(on ? 'Could not pause it' : 'Could not play it', err); if (btn) btn.disabled = false; }
  }

  // Remove at once, with Undo in the notice while the removed folder is kept (lib/wallpaper.js).
  async function doRemove(id) {
    const it = byId(id);
    if (!it) return;
    const ids = L.items.map((x) => x.id);
    const next = ids[ids.indexOf(id) + 1] || ids[ids.indexOf(id) - 1] || null;
    let r;
    try { r = await M.call('wallpaper.remove', { id }); } catch (err) { sayError('Could not remove "' + it.title + '"', err); return; }
    if (next && byId(next)) focus(next, els.grid.contains(document.activeElement));
    const undo = h('button', 'link', 'Undo');
    undo.id = 'undo';
    undo.addEventListener('click', async () => {
      undo.disabled = true;
      try { await M.call('wallpaper.undoRemove', { id }); hideNotice(); focus(id, true); } catch (err) { sayError('Could not undo', err); }
    });
    notice([h('span', null, 'Removed "' + it.title + '". '), undo], false);
    const ms = (r && r.undoMs) || 20000;
    undoTimer = setTimeout(() => { if (els.notice.contains(undo)) els.notice.hidden = true; }, ms);
  }

  function showAddResults(r) {
    if (!r || r.canceled || !r.results || !r.results.length) return;
    const ok = r.results.filter((x) => x.ok);
    const bad = r.results.filter((x) => !x.ok);
    const kids = [];
    if (ok.length) kids.push(h('b', null, 'Added ' + ok.length + ': '), document.createTextNode(ok.map((x) => x.title).join(', ') + '.'));
    if (bad.length) {
      if (ok.length) kids.push(document.createTextNode(' '));
      kids.push(h('b', null, bad.length + ' could not be added:'));
      const ul = h('ul');
      for (const x of bad) ul.appendChild(h('li', null, String(x.path).split(/[\\/]/).pop() + ' — ' + x.reason));
      kids.push(ul);
    }
    notice(kids, bad.length > 0);
    if (ok.length) focus(ok[ok.length - 1].id);
  }

  async function add(args) {
    try { showAddResults(await M.call('wallpaper.add', args)); } catch (err) { sayError('Adding failed', err); }
  }

  $('add-files').addEventListener('click', () => add({ pick: 'files' }));
  $('add-folder').title = 'A folder holding an HTML wallpaper (a Lively web wallpaper, or any index.html)';
  $('add-folder').addEventListener('click', () => add({ pick: 'folder' }));
  $('win-close').addEventListener('click', () => M.call('wallpaper.window', { action: 'close' }).catch(() => window.close()));
  $('win-min').addEventListener('click', () => M.call('wallpaper.window', { action: 'minimize' }).catch(() => {}));
  $('reimport').addEventListener('click', async () => {
    try { const r = await M.call('wallpaper.reimport', { force: false }); notice([h('b', null, 'From Lively: '), document.createTextNode(r.reason + '.')], !r.ok); } catch (err) { sayError('The import failed', err); }
  });
  $('reimport-all').addEventListener('click', async () => {
    try { const r = await M.call('wallpaper.reimport', { force: true }); notice([h('b', null, 'From Lively: '), document.createTextNode(r.reason + ', including any you had removed.')], !r.ok); } catch (err) { sayError('The import failed', err); }
  });

  // ---- drag and drop ------------------------------------------------------------------
  let dragDepth = 0;
  function hasFiles(e) { return e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files'); }
  window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; els.drop.hidden = false; });
  window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) els.drop.hidden = true; });
  window.addEventListener('dragover', (e) => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    els.drop.hidden = true;
    const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
    const paths = files.map((f) => (typeof M.pathForFile === 'function' ? M.pathForFile(f) : '')).filter(Boolean);
    if (!paths.length) {
      notice([h('b', null, 'Nothing was added: '), document.createTextNode(files.length ? 'Mantle could not read where the dropped files are on disk (drop files or folders from File Explorer).' : 'only files and folders can be dropped here.')], true);
      return;
    }
    add({ paths });
  });

  // ---- thumbnails from a video's own frames -------------------------------------------
  const thumbTried = new Set();
  let thumbBusy = false;

  function queueThumbs() {
    if (thumbBusy || !L) return;
    const next = L.items.find((i) => i.needsThumb && i.probeUrl && !thumbTried.has(i.id));
    if (!next) return;
    thumbBusy = true;
    thumbTried.add(next.id);
    makeThumb(next).finally(() => { thumbBusy = false; queueThumbs(); });
  }

  function makeThumb(it) {
    return new Promise((resolve) => {
      const v = document.createElement('video');
      v.muted = true;
      v.preload = 'auto';
      v.crossOrigin = 'anonymous';   // mantle-wp:// answers with CORS, so the canvas stays readable
      let done = false;
      const finish = (result) => {
        if (done) return;
        done = true;
        clearTimeout(t);
        try { v.removeAttribute('src'); v.load(); } catch (_) {}
        M.call('wallpaper.thumb', Object.assign({ id: it.id }, result)).catch((err) => console.warn('thumb not saved:', err.message)).finally(resolve);
      };
      const t = setTimeout(() => finish({ error: 'it did not produce a frame within 15 seconds' }), 15000);
      v.addEventListener('error', () => {
        const code = v.error ? v.error.code : 0;
        finish({ error: ({ 3: 'the video is damaged or uses a codec Chromium cannot decode', 4: 'its format or codec is not one Chromium supports' }[code] || 'the video could not be read') + (v.error && v.error.message ? ' (' + v.error.message + ')' : '') });
      });
      v.addEventListener('loadedmetadata', () => {
        const d = isFinite(v.duration) ? v.duration : 0;
        v.currentTime = Math.min(1, d * 0.1);
      });
      v.addEventListener('seeked', () => {
        try {
          const W0 = 480;
          const H0 = 270;
          const c = document.createElement('canvas');
          c.width = W0;
          c.height = H0;
          const g = c.getContext('2d');
          const s = Math.max(W0 / v.videoWidth, H0 / v.videoHeight);
          const w = v.videoWidth * s;
          const hh = v.videoHeight * s;
          g.drawImage(v, (W0 - w) / 2, (H0 - hh) / 2, w, hh);
          finish({ dataUrl: c.toDataURL('image/jpeg', 0.84) });
        } catch (err) {
          finish({ error: 'a frame could not be drawn: ' + err.message });
        }
      }, { once: true });
      v.src = it.probeUrl;
    });
  }

  // ---- go -------------------------------------------------------------------------
  renderLoading();
  if (typeof M.on === 'function') M.on('wallpaper.library', render);
  else M.call('wallpaper.list').then(render).catch((err) => renderLoadFailed(err && err.message ? err.message : String(err)));
})();

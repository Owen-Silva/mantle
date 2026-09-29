/* panes.js — everything that floats or sits beside the list: Mantle's own context menu (inside the
 * window, keyboard navigable), toasts, the progress cards, the confirm and conflict dialogs, and the
 * side pane (preview / properties). Nothing here calls main by itself except through the host the
 * page hands to MF.side.init, so every failure still lands in one place: a toast with its reason.
 */
(function () {
  'use strict';
  const MF = window.MF = window.MF || {};
  const M = MF.model;
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  MF.el = el;
  const X_SVG = '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" stroke-width="1.2"/></svg>';
  const ARROW = '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M3.5 1.5L7 5l-3.5 3.5" stroke="currentColor" fill="none" stroke-width="1.2"/></svg>';
  const CHECK = '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M2 6.5l2.5 2.5L10 3.5" stroke="currentColor" fill="none" stroke-width="1.4"/></svg>';

  /* ---- menus ------------------------------------------------------------------------------------ */
  /* item = { label, icon (svg markup) | img (url), key (shortcut shown), act(), disabled, check, warn,
     sub: [items] | () => Promise<[items]> (lazy: "More" loads the shell's verbs only when opened),
     sep: true, note: 'plain text' } */
  const menu = { stack: [], onClose: null };
  MF.menu = menu;
  menu.open = function (items, x, y, opts) {
    menu.close();
    menu.onClose = (opts && opts.onClose) || null;
    menu.push(items, x, y, null);
    document.addEventListener('mousedown', menu.outside, true);
    window.addEventListener('blur', menu.close);
    window.addEventListener('resize', menu.close);
  };
  menu.isOpen = () => menu.stack.length > 0;
  menu.outside = (e) => { if (!e.target.closest || !e.target.closest('.menu')) menu.close(); };
  menu.close = function () {
    while (menu.stack.length) menu.stack.pop().box.remove();
    document.removeEventListener('mousedown', menu.outside, true);
    window.removeEventListener('blur', menu.close);
    window.removeEventListener('resize', menu.close);
    const f = menu.onClose;
    menu.onClose = null;
    if (f) f();
  };
  menu.pop = function () { const m = menu.stack.pop(); if (m) m.box.remove(); const top = menu.stack[menu.stack.length - 1]; if (top) top.box.focus(); };
  menu.push = function (items, x, y, parentBtn) {
    const box = el('div', 'menu');
    box.tabIndex = -1;
    box.setAttribute('role', 'menu');
    const level = { box, btns: [], on: -1, items, timer: null };
    const fill = (list) => {
      box.textContent = '';
      level.btns = [];
      for (const it of list) {
        if (it.sep) { box.appendChild(el('div', 'msep')); continue; }
        if (it.note) { box.appendChild(el('div', 'mnote', it.note)); continue; }
        const b = el('button', 'mi' + (it.warn ? ' warn' : ''));
        b.type = 'button';
        b.setAttribute('role', 'menuitem');
        b.disabled = !!it.disabled;
        const g = el('span', 'mg');
        if (it.check) g.innerHTML = CHECK;
        else if (it.img) { const im = el('img'); im.src = it.img; im.alt = ''; g.appendChild(im); } else if (it.icon) g.innerHTML = it.icon;
        b.appendChild(g);
        b.appendChild(el('span', 'ml', it.label));
        if (it.key) b.appendChild(el('span', 'mk', it.key));
        if (it.sub) { const a = el('span', 'ma'); a.innerHTML = ARROW; b.appendChild(a); }
        if (it.title) b.title = it.title;
        const idx = level.btns.length;
        level.btns.push({ b, it });
        b.addEventListener('mouseenter', () => {
          setOn(idx);
          clearTimeout(level.timer);
          level.timer = setTimeout(() => { closeAbove(); if (it.sub && !it.disabled) openSub(idx, false); }, 160);
        });
        b.addEventListener('click', (e) => { e.stopPropagation(); activate(idx); });
        box.appendChild(b);
      }
    };
    const setOn = (i) => {
      if (level.on >= 0 && level.btns[level.on]) level.btns[level.on].b.classList.remove('on');
      level.on = i;
      if (i >= 0 && level.btns[i]) level.btns[i].b.classList.add('on');
    };
    const closeAbove = () => { while (menu.stack.length && menu.stack[menu.stack.length - 1] !== level) menu.pop(); };
    const openSub = (i, focus) => {
      const { b, it } = level.btns[i];
      const r = b.getBoundingClientRect();
      const sub = typeof it.sub === 'function' ? [{ note: 'Loading…' }] : it.sub;
      const child = menu.push(sub.length ? sub : [{ note: 'Nothing here' }], r.right - 2, r.top - 5, b);
      if (typeof it.sub === 'function') {
        Promise.resolve().then(it.sub).then((list) => {
          if (!menu.stack.includes(child)) return;
          child.fill(list && list.length ? list : [{ note: 'Nothing here' }]);
          child.place();
          if (focus) child.setOn(child.btns.findIndex((x) => !x.it.disabled));
        }, (err) => { if (menu.stack.includes(child)) { child.fill([{ note: `Could not load: ${err && err.message ? err.message : err}` }]); child.place(); } });
      }
      if (focus) { child.box.focus(); child.setOn(child.btns.findIndex((x) => !x.it.disabled)); }
    };
    const activate = (i) => {
      const { it } = level.btns[i];
      if (it.disabled) return;
      if (it.sub) { closeAbove(); openSub(i, true); return; }
      menu.close();
      if (it.act) it.act();
    };
    const move = (d) => {
      const n = level.btns.length;
      if (!n) return;
      let i = level.on;
      for (let k = 0; k < n; k++) { i = (i + d + n) % n; if (!level.btns[i].it.disabled) break; }
      setOn(i);
    };
    box.addEventListener('keydown', (e) => {
      e.stopPropagation();
      e.preventDefault();
      if (e.key === 'ArrowDown') move(1);
      else if (e.key === 'ArrowUp') move(-1);
      else if (e.key === 'Home') { level.on = -1; move(1); }
      else if (e.key === 'End') { level.on = 0; move(-1); }
      else if (e.key === 'ArrowRight') { if (level.on >= 0 && level.btns[level.on].it.sub) activate(level.on); }
      else if (e.key === 'ArrowLeft') { if (menu.stack.length > 1) menu.pop(); }
      else if (e.key === 'Escape') { if (menu.stack.length > 1) menu.pop(); else menu.close(); }
      else if (e.key === 'Enter' || e.key === ' ') { if (level.on >= 0) activate(level.on); }
      else if (e.key === 'Tab') move(e.shiftKey ? -1 : 1);
      else if (e.key.length === 1) {
        const ch = e.key.toLowerCase();
        const i = level.btns.findIndex((x, k) => k > level.on && !x.it.disabled && x.it.label.toLowerCase().startsWith(ch));
        const j = i >= 0 ? i : level.btns.findIndex((x) => !x.it.disabled && x.it.label.toLowerCase().startsWith(ch));
        if (j >= 0) setOn(j);
      }
    });
    const place = () => {
      const w = box.offsetWidth;
      const h = box.offsetHeight;
      let lx = x;
      let ly = y;
      if (lx + w > innerWidth - 4) lx = parentBtn ? Math.max(4, parentBtn.getBoundingClientRect().left - w + 2) : Math.max(4, innerWidth - w - 4);
      if (ly + h > innerHeight - 4) ly = Math.max(4, innerHeight - h - 4);
      box.style.left = lx + 'px';
      box.style.top = ly + 'px';
    };
    fill(items);
    $('menus').appendChild(box);
    place();
    Object.assign(level, { fill, place, setOn });
    menu.stack.push(level);
    box.focus({ preventScroll: true });
    return level;
  };

  /* ---- toasts ---------------------------------------------------------------------------------- */
  /* kind: 'quiet' (grey, goes in 4 s), 'info' (6 s), 'err' (warn colour, stays until closed: a failure
     is never allowed to scroll away unseen). lines: [{name, why}] = one line per failed item. */
  MF.toast = function (text, o) {
    const opt = o || {};
    const kind = opt.kind || 'info';
    const box = $('toasts');
    const t = el('div', 'toast ' + kind);
    t.setAttribute('role', kind === 'err' ? 'alert' : 'status');
    const tv = el('div', 'tv');
    tv.appendChild(el('div', 'tt', text));
    if (opt.lines && opt.lines.length) {
      const ul = el('ul', 'tl');
      for (const ln of opt.lines.slice(0, 50)) {
        const li = el('li');
        li.appendChild(el('b', null, ln.name));
        li.appendChild(document.createTextNode(': ' + ln.why));
        ul.appendChild(li);
      }
      if (opt.lines.length > 50) ul.appendChild(el('li', null, `and ${opt.lines.length - 50} more`));
      tv.appendChild(ul);
    }
    t.appendChild(tv);
    const close = () => { clearTimeout(t._timer); t.remove(); };
    if (opt.action) {
      const a = el('button', 'ta', opt.action.label);
      a.type = 'button';
      a.addEventListener('click', () => { close(); opt.action.fn(); });
      t.appendChild(a);
    }
    const x = el('button', 'tx');
    x.type = 'button';
    x.setAttribute('aria-label', 'Dismiss');
    x.innerHTML = X_SVG;
    x.addEventListener('click', close);
    t.appendChild(x);
    const ms = opt.ms || (kind === 'quiet' ? 4000 : kind === 'info' ? 6000 : 0);
    if (ms) {
      const arm = () => { clearTimeout(t._timer); t._timer = setTimeout(close, ms); };
      t.addEventListener('mouseenter', () => clearTimeout(t._timer));
      t.addEventListener('mouseleave', arm);
      arm();
    }
    box.insertBefore(t, box.firstChild);
    // at most five: the oldest calm one goes first, a failure only when five failures are up
    const all = [...box.children];
    if (all.length > 5) { const calm = all.reverse().find((c) => !c.classList.contains('err')); (calm || all[0]).remove(); }
    return close;
  };

  /* ---- progress cards ---------------------------------------------------------------------------- */
  /* A card appears only when an operation is still running after 400 ms: quick ones never flash. */
  const prog = { jobs: new Map(), onCancel: null };
  MF.progress = prog;
  prog.start = function (job, info) {
    const j = { job, info, card: null, last: null, timer: setTimeout(() => prog.show(job), 400) };
    prog.jobs.set(job, j);
  };
  prog.show = function (job) {
    const j = prog.jobs.get(job);
    if (!j || j.card) return;
    const c = el('div', 'pcard');
    const ph = el('div', 'ph');
    j.pt = el('div', 'pt', j.info.label);
    const x = el('button', 'tx ib sm');
    x.type = 'button';
    x.title = 'Cancel';
    x.setAttribute('aria-label', 'Cancel');
    x.innerHTML = X_SVG;
    x.addEventListener('click', () => { x.disabled = true; j.pt.textContent = 'Cancelling…'; if (prog.onCancel) prog.onCancel(job); });
    ph.append(j.pt, x);
    j.pi = el('div', 'pi', '');
    const pb = el('div', 'pb');
    j.bar = el('i');
    pb.appendChild(j.bar);
    j.pn = el('div', 'pn', 'Starting…');
    c.append(ph, j.pi, pb, j.pn);
    j.card = c;
    $('progress').appendChild(c);
    if (j.last) prog.update(j.last);
  };
  prog.update = function (ev) {
    const j = prog.jobs.get(ev.job);
    if (!j) return;
    j.last = ev;
    if (!j.card) return;
    const frac = ev.total > 0 ? ev.done / ev.total : ev.itemsTotal > 0 ? ev.items / ev.itemsTotal : 0;
    j.bar.style.transform = `scaleX(${Math.max(0, Math.min(1, frac))})`;
    j.pi.textContent = ev.item ? ev.item : '';
    const parts = [];
    if (ev.itemsTotal > 0) parts.push(`${M.fmtCount(Math.min(ev.items || 0, ev.itemsTotal))} of ${M.plural(ev.itemsTotal, 'item')}`);
    if (ev.total > 0) parts.push(`${M.fmtSize(ev.done || 0)} of ${M.fmtSize(ev.total)}`);
    parts.push(`${Math.round(frac * 100)}%`);
    j.pn.textContent = parts.join(' · ');
  };
  prog.end = function (job) {
    const j = prog.jobs.get(job);
    if (!j) return null;
    clearTimeout(j.timer);
    if (j.card) j.card.remove();
    prog.jobs.delete(job);
    return j.info;
  };

  /* ---- dialogs --------------------------------------------------------------------------------- */
  const dialog = {};
  MF.dialog = dialog;
  dialog.isOpen = () => !$('modal').hidden;
  /** buttons: [{label, value, kind:'acc'|'danger', focus}] ; Esc answers null. */
  dialog.show = function (build, buttons) {
    return new Promise((resolve) => {
      const modal = $('modal');
      modal.textContent = '';
      const d = el('div', 'dlg');
      d.setAttribute('role', 'dialog');
      d.setAttribute('aria-modal', 'true');
      d.tabIndex = -1;
      build(d);
      const bar = el('div', 'btns');
      let focusBtn = null;
      const done = (v) => {
        modal.hidden = true;
        modal.textContent = '';
        document.removeEventListener('keydown', key, true);
        resolve(v);
      };
      for (const b of buttons) {
        const btn = el('button', 'btn' + (b.kind ? ' ' + b.kind : ''), b.label);
        btn.type = 'button';
        if (b.title) btn.title = b.title;
        btn.addEventListener('click', () => done(b.value));
        bar.appendChild(btn);
        if (b.focus) focusBtn = btn;
      }
      d.appendChild(bar);
      modal.appendChild(d);
      modal.hidden = false;
      const key = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(null); return; }
        if (e.key === 'Tab') {
          const bs = [...bar.querySelectorAll('button')];
          const i = bs.indexOf(document.activeElement);
          e.preventDefault();
          bs[(i + (e.shiftKey ? -1 : 1) + bs.length) % bs.length].focus();
        }
        e.stopPropagation();
      };
      document.addEventListener('keydown', key, true);
      (focusBtn || bar.lastChild).focus();
    });
  };
  /** A plain yes/no. danger: the OK button is warn-coloured and Cancel has the focus. */
  dialog.confirm = function (o) {
    return dialog.show((d) => {
      d.appendChild(el('h2', null, o.title));
      for (const p of [].concat(o.body || [])) d.appendChild(el('p', null, p));
    }, [
      { label: o.ok || 'OK', value: true, kind: o.danger ? 'danger' : 'acc', focus: !o.danger },
      { label: o.cancel || 'Cancel', value: false, focus: !!o.danger },
    ]).then((v) => v === true);
  };
  /** Mantle's conflict dialog: what is there, what is coming, and four ways out. */
  dialog.conflict = function (o) {
    const list = o.conflicts || [];
    const n = list.length;
    return dialog.show((d) => {
      d.appendChild(el('h2', null, n === 1 ? 'An item with this name is already there' : `${M.plural(n, 'item')} with these names are already there`));
      d.appendChild(el('p', null, `${o.op === 'move' ? 'Moving' : 'Copying'} ${M.plural(o.count || n, 'item')} to ${o.destLabel || 'this folder'}.`));
      const ul = el('ul', 'clist');
      for (const c of list.slice(0, 6)) {
        const li = el('li');
        li.appendChild(el('div', 'cn', M.baseName(c.dst || c.src)));
        const row = (label, dir, s, m) => {
          const r = el('div', 'cd');
          r.appendChild(el('b', null, label + ' '));
          r.appendChild(document.createTextNode(dir ? `folder · ${M.fmtDate(m)}` : `${M.fmtSize(s || 0)} · ${M.fmtDate(m)}`));
          return r;
        };
        li.appendChild(row('Coming:', c.d, c.s, c.m));
        li.appendChild(row('There now:', c.dstD, c.dstS, c.dstM));
        ul.appendChild(li);
      }
      d.appendChild(ul);
      if (n > 6) d.appendChild(el('div', 'cmore', `and ${n - 6} more`));
    }, [
      { label: 'Let Windows ask', value: 'ask', title: "Windows' own dialog, one item at a time" },
      { label: 'Skip', value: 'skip', title: 'Leave the ones already there alone' },
      { label: 'Keep both', value: 'keepboth', title: 'Add " (2)" to the new ones' },
      { label: 'Replace', value: 'replace', kind: 'danger', title: 'Overwrite the ones already there' },
      { label: 'Cancel', value: null, focus: true },
    ]);
  };

  /* ---- side pane: preview / properties ------------------------------------------------------------ */
  const side = { mode: null, host: null, token: 0, sizeJob: null };
  MF.side = side;
  side.init = (host) => { side.host = host; };
  side.toggle = function (mode) {
    side.mode = side.mode === mode ? null : mode;
    $('side').hidden = !side.mode;
    side.update();
    return side.mode;
  };
  side.close = () => { if (side.mode) side.toggle(side.mode); };
  side.frame = function (title) {
    const box = $('side');
    box.textContent = '';
    const head = el('div', 'sidehead');
    head.appendChild(el('span', 'grow', title));
    const x = el('button', 'ib sm');
    x.type = 'button';
    x.setAttribute('aria-label', 'Close the pane');
    x.innerHTML = X_SVG;
    x.addEventListener('click', side.close);
    head.appendChild(x);
    const body = el('div', 'sidebody');
    box.append(head, body);
    return body;
  };
  side.cancelSize = function () {
    if (side.sizeJob) { side.host.api('files.cancel', { job: side.sizeJob }); side.sizeJob = null; }
  };
  side.update = function () {
    if (!side.mode || !side.host) { side.cancelSize(); return; }
    const token = ++side.token;
    side.cancelSize();
    const h = side.host;
    const items = h.selected();
    if (side.mode === 'preview') side.preview(items, token);
    else side.props(items, token);
  };
  side.nothing = function (body, text) { const n = el('div', 'pvnone'); n.appendChild(el('div', null, text)); body.appendChild(n); };
  side.preview = function (items, token) {
    const h = side.host;
    const body = side.frame('Preview');
    if (items.length !== 1) { side.nothing(body, items.length ? `${M.plural(items.length, 'item')} selected` : 'Select a file to preview it'); return; }
    const it = items[0];
    const p = h.pathOf(it);
    body.appendChild(el('div', 'pname', h.nameOf(it)));
    if (!p || it.binKey) { side.none(body, it, 'Items in the Recycle Bin have no preview; restore it first'); return; }
    const wait = el('div', 'pvnote', 'Loading the preview…');
    body.appendChild(wait);
    h.api('files.preview', { path: p }).then((r) => {
      if (token !== side.token) return;          // the selection moved on: a late answer is dropped
      wait.remove();
      if (!r || r.ok === false) { side.none(body, it, r && r.reason ? r.reason : 'no answer from Mantle'); return; }
      if (r.kind === 'image') { const im = el('img', 'pvimg'); im.alt = ''; im.src = r.url; im.addEventListener('error', () => { im.remove(); side.none(body, it, 'the image could not be decoded'); }); body.appendChild(im); }
      else if (r.kind === 'video' || r.kind === 'audio') {
        const m = el(r.kind, 'pvmedia');
        m.controls = true;
        m.preload = 'metadata';
        m.src = r.url;
        m.addEventListener('error', () => { m.remove(); side.none(body, it, `this ${r.kind} format does not play here`); });
        body.appendChild(m);
      } else if (r.kind === 'pdf') {
        const f = el('iframe', 'pvframe');
        f.src = r.url;
        f.title = 'PDF preview';
        body.classList.add('pdf');
        body.appendChild(f);
      } else if (r.kind === 'text') {
        body.appendChild(el('pre', 'pvtext', r.text || ''));
        if (r.truncated) body.appendChild(el('div', 'pvnote', `Showing the first ${M.fmtSize((r.text || '').length)}; the file is ${M.fmtSize(r.size || 0)}.`));
      } else side.none(body, it, r.why || 'no preview for this kind of file');
    }, (e) => { if (token === side.token) { wait.remove(); side.none(body, it, e.message); } });
  };
  side.none = function (body, it, why) {
    const n = el('div', 'pvnone');
    const url = side.host.iconOf(it, 256);
    if (url) { const im = el('img'); im.alt = ''; im.src = url; n.appendChild(im); }
    n.appendChild(el('div', null, why));
    body.appendChild(n);
  };
  const ATTRS = [[1, 'Read-only'], [2, 'Hidden'], [4, 'System'], [32, 'Archive'], [0x400, 'Link or junction'], [0x800, 'Compressed'], [0x4000, 'Encrypted'], [0x1000, 'Offline']];
  side.dl = function (body, rows) {
    const dl = el('dl', 'props');
    const byLabel = {};
    for (const [k, v, muted] of rows) {
      if (v == null || v === '') continue;
      dl.appendChild(el('dt', null, k));
      const dd = el('dd', muted ? 'muted' : null, v);
      dl.appendChild(dd);
      byLabel[k] = dd;
    }
    body.appendChild(dl);
    return byLabel;
  };
  side.props = function (items, token) {
    const h = side.host;
    const body = side.frame('Properties');
    if (!items.length) {
      const t = h.tab();
      side.nothing(body, t && t.shown ? `${M.plural(t.shown.length, 'item')} here. Select one to see its properties.` : 'Select an item');
      return;
    }
    const icon = side.host.iconOf(items[0], 256);
    if (icon) { const im = el('img', 'pbig'); im.alt = ''; im.src = icon; body.appendChild(im); }
    if (items.length > 1) {
      const s = M.summarize(items);
      body.appendChild(el('div', 'pname', `${M.plural(items.length, 'item')} selected`));
      body.appendChild(el('div', 'ptype', s.dirs && s.files ? 'Files and folders' : s.dirs ? 'Folders' : 'Files'));
      side.dl(body, [['Files', M.fmtCount(s.files)], ['Folders', M.fmtCount(s.dirs)], ['Size', `${M.fmtSize(s.bytes)}${s.dirs ? ' (files only; folders are not counted)' : ''}`]]);
      return;
    }
    const it = items[0];
    body.appendChild(el('div', 'pname', h.nameOf(it)));
    body.appendChild(el('div', 'ptype', h.typeOf(it)));
    if (it.binKey) {                              // a Recycle Bin item: what the bin knows
      side.dl(body, [['Original location', it.loc], ['Date deleted', M.fmtDate(it.del)], ['Size', it.d ? '' : `${M.fmtSize(it.s)} (${M.fmtBytes(it.s || 0)})`]]);
      return;
    }
    const p = h.pathOf(it);
    const drive = h.driveOf ? h.driveOf(p) : null;
    if (drive) {                               // a drive root: what the drive says, never a count of the whole disk
      const ok = drive.ready !== false && drive.total > 0;
      side.dl(body, [['Path', drive.path], ['File system', drive.fs], ['Used', ok ? `${M.fmtSize(drive.total - drive.free)} (${M.fmtBytes(drive.total - drive.free)})` : null],
        ['Free', ok ? `${M.fmtSize(drive.free)} (${M.fmtBytes(drive.free)})` : null], ['Capacity', ok ? M.fmtSize(drive.total) : null], ['Problem', drive.ready === false ? drive.why || 'not ready' : null]]);
      return;
    }
    const wait = el('div', 'pvnote', 'Reading…');
    body.appendChild(wait);
    h.api('files.stat', { path: p }).then((r) => {
      if (token !== side.token) return;
      wait.remove();
      if (!r || r.ok === false || r.exists === false) { side.dl(body, [['Location', M.parentOf(p)], ['Problem', r && r.reason ? r.reason : 'it is not there any more']]); return; }
      const attrs = ATTRS.filter(([bit]) => (r.a & bit) !== 0).map(([, n]) => n).join(', ');
      const rows = [
        ['Type', r.type || h.typeOf(it)],
        ['Location', r.location || M.parentOf(p)],
        ['Size', r.d ? 'Counting…' : `${M.fmtSize(r.s)} (${M.fmtBytes(r.s || 0)})`],
        ['Contains', r.d ? 'Counting…' : null],
        ['Created', M.fmtDate(r.c)], ['Modified', M.fmtDate(r.m)], ['Accessed', M.fmtDate(r.acc)],
        ['Attributes', attrs || 'None', !attrs],
        ['Target', r.target || null],
      ];
      const dds = side.dl(body, rows);
      if (!r.d) return;
      const sizeDd = dds.Size;
      const containsDd = dds.Contains;
      h.api('files.size', { w: h.w, path: p }).then((s) => {
        if (token !== side.token) { if (s && s.job) h.api('files.cancel', { job: s.job }); return; }
        if (!s || s.ok === false || !s.job) { sizeDd.textContent = `not counted: ${s && s.reason ? s.reason : 'no answer'}`; containsDd.textContent = '—'; return; }
        side.sizeJob = s.job;
        side.sizeOut = { job: s.job, sizeDd, containsDd, token };
      });
    }, (e) => { if (token === side.token) { wait.remove(); side.dl(body, [['Problem', e.message]]); } });
  };
  /** 'files.size' events (every ~250 ms while a folder is counted). */
  side.onSize = function (ev) {
    const o = side.sizeOut;
    if (!o || o.job !== ev.job || o.token !== side.token) return;
    const word = ev.done ? '' : ' so far';
    o.sizeDd.textContent = `${M.fmtSize(ev.bytes || 0)} (${M.fmtBytes(ev.bytes || 0)})${word}`;
    let c = `${M.plural(ev.files || 0, 'file')}, ${M.plural(ev.dirs || 0, 'folder')}`;
    if (ev.denied) c += ` · ${M.plural(ev.denied, 'folder')} could not be read`;
    if (ev.error) c += ` · stopped: ${ev.error}`;
    o.containsDd.textContent = c;
    if (ev.done) { side.sizeJob = null; side.sizeOut = null; }
  };
}());

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
  // Settings' warn glyph: a failure or a reason is this glyph + its words in --lg-warn, never a filled pill
  const WARN = (s) => `<svg width="${s}" height="${s}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2.2l6.2 10.9H1.8z"/><path d="M8 6.4v3M8 11.2v.01"/></svg>`;

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
        }, (err) => { if (menu.stack.includes(child)) { child.fill([{ note: `Could not load. ${M.plainReason(err && err.message ? err.message : err)}` }]); child.place(); } });
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
    if (kind === 'err') t.insertAdjacentHTML('beforeend', WARN(14).replace('<svg ', '<svg class="tg" '));
    const tv = el('div', 'tv');
    tv.appendChild(el('div', 'tt', text));
    if (opt.sub) tv.appendChild(el('div', 'ts', opt.sub));
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
    x.title = 'Dismiss';
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
    const j = { job, info, card: null, last: null, t0: performance.now(), timer: setTimeout(() => prog.show(job), 400) };
    prog.jobs.set(job, j);
  };
  prog.show = function (job) {
    const j = prog.jobs.get(job);
    if (!j || j.card) return;
    const c = el('div', 'pcard');
    const ph = el('div', 'ph');
    j.pt = el('div', 'pt', j.info.label);
    const x = el('button', 'btn sm pcancel', 'Cancel');
    x.type = 'button';
    x.title = 'Stop it; what is already done stays done (Ctrl+Z puts it back)';
    x.addEventListener('click', () => { x.disabled = true; x.textContent = 'Cancelling…'; if (prog.onCancel) prog.onCancel(job); });
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
    const left = ev.total > 0 ? M.timeLeft(ev.done || 0, ev.total, performance.now() - j.t0) : M.timeLeft(ev.items || 0, ev.itemsTotal, performance.now() - j.t0);
    parts.push(left || `${Math.round(frac * 100)}%`);
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
  /** build(d, ctl) may return a function run once the buttons exist; ctl.btn(value) is that button.
   *  opts.enter: the value Enter answers while typing in one of the dialog's inputs (when enabled). */
  dialog.show = function (build, buttons, opts) {
    const op = opts || {};
    return new Promise((resolve) => {
      const modal = $('modal');
      modal.textContent = '';
      const d = el('div', 'dlg');
      d.setAttribute('role', 'dialog');
      d.setAttribute('aria-modal', 'true');
      d.tabIndex = -1;
      const btns = new Map();
      const ctl = { btn: (v) => btns.get(v) || null };
      const after = build(d, ctl);
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
        btns.set(b.value, btn);
        bar.appendChild(btn);
        if (b.focus) focusBtn = btn;
      }
      d.appendChild(bar);
      if (typeof after === 'function') after();
      modal.appendChild(d);
      modal.hidden = false;
      const key = (e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(null); return; }
        const inField = e.target && e.target.closest && e.target.closest('.dlg') && /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName);
        if (e.key === 'Enter' && inField && op.enter !== undefined) {
          const b = btns.get(op.enter);
          e.preventDefault(); e.stopPropagation();
          if (b && !b.disabled) done(op.enter);
          return;
        }
        if (e.key === 'Tab') {
          const bs = [...d.querySelectorAll('button:not(:disabled), input, select')];
          const i = bs.indexOf(document.activeElement);
          e.preventDefault();
          bs[(i + (e.shiftKey ? -1 : 1) + bs.length) % bs.length].focus();
        }
        e.stopPropagation();
      };
      document.addEventListener('keydown', key, true);
      const first = op.focus ? d.querySelector(op.focus) : null;
      if (first) { first.focus(); if (first.select) first.select(); } else (focusBtn || bar.lastChild).focus();
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
  /** Mantle's conflict dialog: ONE clash at a time (what is coming, what is there now, which is newer),
   *  three ways out (Replace / Keep both / Skip) and "Do this for all N" to answer the rest at once.
   *  -> null (Cancel / Esc) | { all: choice } | { each: { <src>: choice } }. Keep both has the focus:
   *  Enter never overwrites anything. */
  dialog.conflict = async function (o) {
    const list = o.conflicts || [];
    const n = list.length;
    const each = {};
    for (let i = 0; i < n; i++) {
      const c = list[i];
      const left = n - i;
      let all = false;
      const v = await dialog.show((d) => {
        d.classList.add('conf');
        const name = M.baseName(c.dst || c.src);
        d.appendChild(el('h2', 'ctitle', `"${name}" is already in ${o.destLabel || 'this folder'}`));
        d.lastChild.title = name;
        d.appendChild(el('p', null, n === 1 ? `${o.op === 'move' ? 'Moving' : 'Copying'} ${M.plural(o.count || 1, 'item')}. Replace it, keep both, or skip this one?`
          : `${M.plural(n, 'item')} have the same name as one already there. This is ${i + 1} of ${n}.`));
        const ul = el('ul', 'clist');
        const li = el('li');
        const newer = (c.m || 0) > (c.dstM || 0) ? 'coming' : (c.dstM || 0) > (c.m || 0) ? 'there' : null;
        const row = (label, dir, s, m, isNewer) => {
          const r = el('div', 'cd');
          r.appendChild(el('b', null, label + ' '));
          r.appendChild(document.createTextNode(dir ? `Folder · ${M.fmtDate(m)}` : `${M.fmtSize(s || 0)} · ${M.fmtDate(m)}`));
          if (isNewer) r.appendChild(el('span', 'cnew', 'newer'));
          return r;
        };
        li.appendChild(row('Coming:', c.d, c.s, c.m, newer === 'coming'));
        li.appendChild(row('There now:', c.dstD, c.dstS, c.dstM, newer === 'there'));
        ul.appendChild(li);
        d.appendChild(ul);
        if (left > 1) {
          const w = el('label', 'fck call');
          const cb = el('input');
          cb.type = 'checkbox';
          cb.addEventListener('change', () => { all = cb.checked; });
          w.append(cb, el('span', null, i === 0 ? (n === 2 ? 'Do this for both' : `Do this for all ${n}`) : `Do this for the last ${left}`));
          d.appendChild(w);
        }
      }, [
        { label: 'Replace', value: 'replace', kind: 'danger', title: 'Overwrite the one already there' },
        { label: 'Skip', value: 'skip', title: 'Leave the one already there alone; do not copy this one' },
        { label: 'Keep both', value: 'keepboth', kind: 'acc', focus: true, title: 'The new one gets " (2)" added to its name' },
        { label: 'Cancel', value: null, title: 'Stop: nothing is copied or moved (Esc)' },
      ]);
      if (!v) return null;
      if (n === 1 || (all && i === 0)) return { all: v };
      if (all) { for (let k = i; k < n; k++) each[list[k].src] = v; break; }
      each[c.src] = v;
    }
    return { each };
  };

  /**
   * Rename many: number them ("Trip (1)", "Trip (2)"...) or find and replace (plain or a regular
   * expression), extensions kept / lower / upper, a live preview of every new name with the reason
   * beside any that cannot be used. o = { items:[{n, d}], taken:[names in the folder], showExt }.
   * -> [{ index, name }] (only the ones that change) or null.
   */
  dialog.renameMany = function (o) {
    const items = o.items || [];
    const first = items[0] || { n: '', d: 0 };
    const spec = { mode: 'number', base: first.n.slice(0, M.stemLength(first.n, first.d)), start: 1, find: '', replace: '', regex: false, matchCase: false, ext: 'keep' };
    let plan = null;
    return dialog.show((d, ctl) => {
      d.classList.add('wide');
      d.appendChild(el('h2', null, `Rename ${M.plural(items.length, 'item')}`));
      const seg = el('div', 'seg');
      const modes = [['number', 'Number them'], ['replace', 'Find and replace']];
      const segBtns = modes.map(([m, label]) => { const b = el('button', 'segb', label); b.type = 'button'; b.dataset.mode = m; seg.appendChild(b); return b; });
      d.appendChild(seg);
      const field = (label, input) => { const f = el('label', 'fld'); f.appendChild(el('span', 'fl', label)); f.appendChild(input); return f; };
      const inp = (cls, v, type) => { const i = el('input', cls); i.type = type || 'text'; i.spellcheck = false; i.value = v; return i; };
      const base = inp('fi rn-base', spec.base);
      const start = inp('fi rn-start', '1', 'number'); start.min = '0';
      const find = inp('fi rn-find', '');
      const repl = inp('fi rn-repl', '');
      const chk = (label) => { const w = el('label', 'fck'); const c = el('input'); c.type = 'checkbox'; w.appendChild(c); w.appendChild(el('span', null, label)); return { w, c }; };
      const mc = chk('Match case');
      const rx = chk('Regular expression (the whole name)');
      const ext = el('select', 'fi rn-ext');
      for (const [v, label] of [['keep', 'Keep extensions as they are'], ['lower', 'Extensions in lower case'], ['upper', 'Extensions in UPPER CASE']]) { const op = el('option', null, label); op.value = v; ext.appendChild(op); }
      const numBox = el('div', 'frow');
      numBox.append(field('Base name', base), field('Start at', start));
      const repBox = el('div', 'frow');
      repBox.append(field('Find', find), field('Replace with', repl));
      const opts = el('div', 'frow opts');
      opts.append(mc.w, rx.w);
      d.append(numBox, repBox, opts, field('Extensions', ext));
      const sum = el('div', 'rn-sum');
      const ul = el('ul', 'clist rn-list');
      d.append(sum, ul);
      const draw = () => {
        spec.base = base.value; spec.start = start.value; spec.find = find.value; spec.replace = repl.value;
        spec.matchCase = mc.c.checked; spec.regex = rx.c.checked; spec.ext = ext.value;
        for (const b of segBtns) b.classList.toggle('on', b.dataset.mode === spec.mode);
        numBox.hidden = spec.mode !== 'number';
        repBox.hidden = opts.hidden = spec.mode !== 'replace';
        plan = M.renamePlan(items, spec, o.taken || []);
        ul.textContent = '';
        for (const r of plan.rows.slice(0, 300)) {
          const li = el('li', 'rn-row' + (r.why ? ' bad' : r.to === r.from ? ' same' : ''));
          li.appendChild(el('span', 'rn-from', r.from));
          li.appendChild(el('span', 'rn-arrow', '→'));
          li.appendChild(el('span', 'rn-to', r.to));
          if (r.why) { const w = el('span', 'rn-why'); w.innerHTML = WARN(12); w.appendChild(el('span', null, r.why)); li.appendChild(w); }
          ul.appendChild(li);
        }
        if (plan.rows.length > 300) ul.appendChild(el('li', 'cmore', `and ${plan.rows.length - 300} more`));
        sum.textContent = plan.ok ? `${M.plural(plan.changed, 'item')} will be renamed. Ctrl+Z puts every one back.` : cap1(plan.why || 'nothing would change');
        sum.classList.toggle('bad', !plan.ok);
        if (!plan.ok) sum.insertAdjacentHTML('afterbegin', WARN(12));
        const b = ctl.btn('go');
        if (b) b.disabled = !plan.ok;
      };
      for (const b of segBtns) b.addEventListener('click', () => { spec.mode = b.dataset.mode; draw(); (spec.mode === 'number' ? base : find).focus(); });
      for (const i of [base, start, find, repl, ext, mc.c, rx.c]) i.addEventListener(i.tagName === 'SELECT' || i.type === 'checkbox' ? 'change' : 'input', draw);
      return draw;
    }, [
      { label: 'Rename', value: 'go', kind: 'acc' },
      { label: 'Cancel', value: null, focus: true },
    ], { enter: 'go', focus: '.rn-base' }).then((v) => {
      if (v !== 'go' || !plan || !plan.ok) return null;
      const out = [];
      plan.rows.forEach((r, i) => { if (r.to !== r.from) out.push({ index: i, name: r.to }); });
      return out;
    });
  };
  const cap1 = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1);

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
    x.title = 'Close the pane';
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
      if (!r || r.ok === false) { side.none(body, it, M.plainReason(r && r.reason)); return; }
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
      } else side.none(body, it, r.why ? M.plainReason(r.why) : 'No preview for this kind of file.');
    }, (e) => { if (token === side.token) { wait.remove(); side.none(body, it, M.plainReason(e && e.message)); } });
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
        ['Free', ok ? `${M.fmtSize(drive.free)} (${M.fmtBytes(drive.free)})` : null], ['Capacity', ok ? M.fmtSize(drive.total) : null], ['Problem', drive.ready === false ? M.plainReason(drive.why || 'not ready') : null]]);
      return;
    }
    const wait = el('div', 'pvnote', 'Reading…');
    body.appendChild(wait);
    h.api('files.stat', { path: p }).then((r) => {
      if (token !== side.token) return;
      wait.remove();
      if (!r || r.ok === false || r.exists === false) { side.dl(body, [['Location', M.parentOf(p)], ['Problem', M.plainReason(r && r.reason ? r.reason : 'not there any more')]]); return; }
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
      if (!r.d) { side.checksum(body, p, token); return; }
      const sizeDd = dds.Size;
      const containsDd = dds.Contains;
      h.api('files.size', { w: h.w, path: p }).then((s) => {
        if (token !== side.token) { if (s && s.job) h.api('files.cancel', { job: s.job }); return; }
        if (!s || s.ok === false || !s.job) { sizeDd.textContent = `Not counted. ${M.plainReason(s && s.reason)}`; containsDd.textContent = '—'; return; }
        side.sizeJob = s.job;
        side.sizeOut = { job: s.job, sizeDd, containsDd, token };
      });
    }, (e) => { if (token === side.token) { wait.remove(); side.dl(body, [['Problem', M.plainReason(e && e.message)]]); } });
  };
  /** Properties > Checksum: pick the algorithm, press Compute (a big file takes a moment; nothing is
   *  read until asked). The answer can be copied like any text in the pane. */
  side.checksum = function (body, p, token) {
    const h = side.host;
    const box = el('div', 'hash');
    const head = el('div', 'hash-h');
    head.appendChild(el('span', 'hash-t', 'Checksum'));
    const pick = el('select', 'fi hash-algo');
    for (const [v, label] of [['sha256', 'SHA-256'], ['sha1', 'SHA-1'], ['sha512', 'SHA-512'], ['md5', 'MD5']]) { const o = el('option', null, label); o.value = v; pick.appendChild(o); }
    const go = el('button', 'btn sm hash-go', 'Compute');
    go.type = 'button';
    head.append(pick, go);
    const out = el('div', 'hash-out muted', 'Not computed yet');
    box.append(head, out);
    body.appendChild(box);
    go.addEventListener('click', () => {
      const algo = pick.value;
      go.disabled = true;
      out.className = 'hash-out muted';
      out.textContent = 'Reading the file…';
      h.api('files.hash', { w: h.w, path: p, algo }).then((r) => {
        if (token !== side.token) return;
        go.disabled = false;
        if (!r || r.ok === false) { if (r && r.cancelled) return; out.className = 'hash-out bad'; out.textContent = `Not computed. ${M.plainReason(r && r.reason)}`; return; }
        out.className = 'hash-out';
        out.textContent = r.hex;
        out.title = `${pick.options[pick.selectedIndex].text} of ${M.fmtBytes(r.bytes || 0)} in ${r.ms} ms`;
      }, (e) => { if (token === side.token) { go.disabled = false; out.className = 'hash-out bad'; out.textContent = `Not computed. ${M.plainReason(e && e.message)}`; } });
    });
  };
  /** 'files.size' events (every ~250 ms while a folder is counted). */
  side.onSize = function (ev) {
    const o = side.sizeOut;
    if (!o || o.job !== ev.job || o.token !== side.token) return;
    const word = ev.done ? '' : ' so far';
    o.sizeDd.textContent = `${M.fmtSize(ev.bytes || 0)} (${M.fmtBytes(ev.bytes || 0)})${word}`;
    let c = `${M.plural(ev.files || 0, 'file')}, ${M.plural(ev.dirs || 0, 'folder')}`;
    if (ev.denied) c += ` · ${M.plural(ev.denied, 'folder')} could not be read`;
    if (ev.error) c += ` · stopped. ${M.plainReason(ev.error)}`;
    o.containsDd.textContent = c;
    if (ev.done) { side.sizeJob = null; side.sizeOut = null; }
  };
}());

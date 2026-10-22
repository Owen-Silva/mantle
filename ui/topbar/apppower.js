/* apppower.js — App power in the CPU / RAM / GPU dropdowns (lane mantle-power-ui, 2026-10-14).
 *
 * The user, looking at the CPU dropdown's TOP PROCESSES: "a way to limit cpu use or select what things that
 * are open can use whatever amount of cpu usage", "and gpu and ram too", "i want to be able to do the cpu
 * limits and gpu and ram and stuff from here". So each top row opens an inline panel under itself:
 *   CPU  Efficiency mode, Priority, CPU limit ("of your whole CPU")
 *   RAM  Lower memory priority, Free up memory, Memory limit (behind its warning)
 *   GPU  Lower graphics priority (or why not), Graphics preference (2+ GPUs only), the honest line
 * and every panel ends with "Remember for this app" (on by default) and "Back to normal".
 *
 * Main decorates every top entry (lib/apppower-core.js live.decorate, contract section 4): key, label, n,
 * ctl, why, deny, set, remembered, shared, test; the payload carries apppower { gpus, gpuLow, gpuLowWhy,
 * gpuPref }. This page calls apppower.set / remember / trim / reset (lib/features/apppower.js).
 *
 * THE 1 S SAMPLE. topbar.js renderStatMenu rebuilds the dropdown every second. The rows here are ONE
 * element (render() keeps it in the dropdown and patches it), keyed by the app, so an open panel, the
 * control with focus and the row under the pointer survive every sample. The rows re-sort by use every
 * second; while a panel is open, the pointer is over the list or the arrow keys hold a row, the order
 * holds still (only the numbers change) and the held row stays even if it drops out of the top five.
 *
 * GROWING. A panel opening makes the dropdown taller than the bar's window. topbar.js hides a dropdown
 * the window cannot show whole until the window has grown (no clipped slice), which would blink the whole
 * menu; so the room is asked for FIRST (dd._growTo, read by notifyMain) and the panel slides open once the
 * window has it (or after 160 ms, whatever happened).
 *
 * Words on screen are the contract's; never a process id, a key, a dry run or Windows' own jargon.
 */
(function () {
  'use strict';
  const MB = 1048576, GB = 1073741824;
  const PRIOS = [['low', 'Low'], ['belownormal', 'Below normal'], ['normal', 'Normal'], ['abovenormal', 'Above normal']];
  const CPU_CAPS = [[0, 'No limit'], [75, '75%'], [50, '50%'], [25, '25%'], [10, '10%']];
  const MEM_CAPS = [[0, 'Off'], [512 * MB, '512 MB'], [GB, '1 GB'], [2 * GB, '2 GB'], [4 * GB, '4 GB']];
  const GPU_PREFS = [['default', 'Let Windows decide'], ['saving', 'Power saving'], ['performance', 'High performance']];
  const DEF = { eco: false, priority: null, cpuCap: 0, memLow: false, memCap: 0, gpuLow: false, gpuPref: 'default' };
  const FIELDS = Object.keys(DEF);
  const NO_ANSWER = 'Mantle didn’t answer, so nothing changed';
  const GROW_WAIT_MS = 160, OPEN_MS = 200, NOTE_MS = 20000, OVER_MS = 3000;
  // The rows change height on their own while the dropdown is open: a protected app entering the list brings
  // its "why" line, a reply its note. A dropdown taller than the window waits hidden until main has grown it
  // (topbar.js reveal), which blinked the whole menu for a frame (lane mantle-power2, 2026-10-14: +20 px, one
  // protected row in place of a plain one). The window keeps two lines spare under it instead; that strip is
  // see-through and a click there is a click-away, as anywhere else beside the menu.
  const ROOM_PX = 44;

  const SVG = (d, w) => `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="${w || 1.4}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const LEAF = SVG('<path d="M13.25 2.75C7.5 2.75 3.25 5.1 3.25 9.6c0 2.15 1.5 3.65 3.6 3.65 4.6 0 6.4-4.6 6.4-10.5z"/><path d="M2.75 13.75c1.6-3.2 4-5.6 7.25-7.25"/>');
  const CHEV = SVG('<path d="M6 3.75L10.25 8 6 12.25"/>', 1.5);
  const LOCK = SVG('<rect x="3.5" y="7.25" width="9" height="6.25" rx="1.5"/><path d="M5.5 7.25V5.5a2.5 2.5 0 015 0v1.75"/>');

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const bytes = (n) => (n >= GB ? (Math.round(n / GB * 10) / 10).toString().replace(/\.0$/, '') + ' GB' : Math.round(n / MB) + ' MB');
  const reduced = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  let api = { call: () => Promise.resolve({ ok: false, reason: 'App power has not started' }), rerender: () => {} };
  const P = {
    kind: null,          // 'cpu' | 'mem' | 'gpu': the dropdown the rows are in
    els: null,           // { dd, head, list, tail, rows: Map id -> row }
    open: null,          // the id whose panel is open (one at a time)
    hot: null,           // the highlighted row (pointer or arrow keys)
    kbd: false,          // the hot row came from the keyboard
    inside: false,       // the pointer is over the rows
    order: [],           // ids in their shown order
    last: new Map(),     // id -> { e, at } the last entry seen (a held row that left the top keeps it)
    view: new Map(),     // id -> the view a row was last drawn from
    over: new Map(),     // id -> { row, at } a reply's state, shown until a sample agrees (or OVER_MS)
    pend: new Map(),     // id -> { field: { v, seq } } changes in flight
    note: new Map(),     // id -> { text, bad, at } the last answer's words, on the row
    freed: new Map(),    // id -> "Freed 412 MB"
    rem: new Map(),      // id -> the Remember box while no rule exists yet / a change is in flight
    busy: new Map(),     // id -> 'trim' | 'reset' | 'remember'
    seq: 0,
    caps: {},
  };

  const idOf = (e) => (e && e.key ? 'k:' + e.key : 'x:' + ((e && (e.label || e.name)) || '?'));
  const owns = (kind, d) => (kind === 'cpu' || kind === 'mem' || kind === 'gpu') && !!d && Array.isArray(d.top) && d.top.some((e) => e && typeof e.ctl === 'boolean');
  const sameSet = (a, b) => FIELDS.every((f) => ((a && a[f]) != null ? a[f] : DEF[f]) === ((b && b[f]) != null ? b[f] : DEF[f]));
  const isDefault = (s) => sameSet(s, DEF);
  const nameOf = (e) => (e.label ? e.label + (e.n > 1 ? ` (${e.n})` : '') : (e.name || ''));

  /* ---- the state a row shows: the sample, then a reply not yet in a sample, then what is in flight ---- */
  function viewOf(id, e, stale) {
    const ov = P.over.get(id);
    if (ov && (Date.now() - ov.at > OVER_MS || (sameSet(e.set, ov.row.set) && !!e.remembered === !!ov.row.remembered))) P.over.delete(id);
    const o = P.over.get(id);
    const base = o ? Object.assign({}, e, o.row) : e;
    const set = Object.assign({}, DEF, base.set || {});
    const pd = P.pend.get(id);
    if (pd) Object.keys(pd).forEach((f) => { set[f] = pd[f].v; });
    const hasRule = !isDefault(Object.assign({}, DEF, base.set || {}));
    const rem = P.rem.has(id) ? P.rem.get(id) : hasRule ? !!base.remembered : true;
    const n = P.note.get(id);
    if (n && Date.now() - n.at > NOTE_MS && P.open !== id) P.note.delete(id);
    return { id, e, key: e.key || null, name: nameOf(base), label: base.label || e.name || 'This app', ctl: !!(e.key && base.ctl), why: base.why || null,
      deny: base.deny || null, set, hasRule, rem, shared: base.shared, test: !!base.test, stale: !!stale, note: P.note.get(id) || null };
  }

  /* ---- the row: name, its state marks, the reading, the chevron (or the lock) ---------------------- */
  // The marks of THIS dropdown's kind (the leaf in all three: it is the app's whole state); every
  // setting, whichever dropdown made it, is in the marks' tooltip.
  function marks(v) {
    const s = v.set, m = [], k = P.kind;
    if (s.eco) m.push(`<span class="ap-mk eco">${LEAF}</span>`);
    if (k === 'cpu' && (s.priority === 'low' || s.priority === 'belownormal')) m.push('<span class="ap-mk">CPU ↓</span>');
    if (k === 'cpu' && s.priority === 'abovenormal') m.push('<span class="ap-mk">CPU ↑</span>');
    if (k === 'cpu' && s.cpuCap) m.push(`<span class="ap-mk cap">CPU ${s.cpuCap}%</span>`);
    if (k === 'mem' && s.memLow) m.push('<span class="ap-mk">RAM ↓</span>');
    if (k === 'mem' && s.memCap) m.push(`<span class="ap-mk cap">RAM ${bytes(s.memCap)}</span>`);
    if (k === 'gpu' && s.gpuLow) m.push('<span class="ap-mk">GPU ↓</span>');
    if (k === 'gpu' && s.gpuPref === 'saving') m.push('<span class="ap-mk">GPU saver</span>');
    if (k === 'gpu' && s.gpuPref === 'performance') m.push('<span class="ap-mk">GPU max</span>');
    return m.join('');
  }
  function summary(s) {
    const out = [];
    if (s.eco) out.push('Efficiency mode');
    if (s.priority && s.priority !== 'normal') out.push('Priority: ' + PRIOS.find((p) => p[0] === s.priority)[1]);
    if (s.cpuCap) out.push(`CPU limit ${s.cpuCap}%`);
    if (s.memLow) out.push('Lower memory priority');
    if (s.memCap) out.push('Memory limit ' + bytes(s.memCap));
    if (s.gpuLow) out.push('Lower graphics priority');
    if (s.gpuPref && s.gpuPref !== 'default') out.push(s.gpuPref === 'saving' ? 'Graphics: Power saving' : 'Graphics: High performance');
    return out.join(' · ');
  }
  function subLines(v) {
    if (!v.ctl) return `<div class="ap-s q">${esc(v.why || 'Mantle leaves this one alone')}</div>`;
    let h = '';
    if (v.note) h += `<div class="ap-s${v.note.bad ? ' bad' : ' q'}" role="${v.note.bad ? 'alert' : 'status'}">${esc(v.note.text)}</div>`;
    if (v.deny && !(v.note && v.note.text === v.deny)) h += `<div class="ap-s bad">${esc(v.deny)}</div>`;
    return h;
  }
  // One row parsed once and cloned (the open's cost: html + svg parsing per row was most of it); the
  // chevron and the lock are both in it, CSS shows the one the row's .ctl calls for.
  let proto = null;
  function newRow(id) {
    if (!proto) {
      proto = document.createElement('div');
      proto.className = 'ap-item';
      proto.innerHTML = '<div class="ap-row" role="menuitem" tabindex="-1"><span class="ap-nm"><span class="ap-n"></span><span class="ap-m"></span></span>' +
        `<span class="ap-x"></span><span class="ap-c">${CHEV}${LOCK}</span></div><div class="ap-sub"></div><div class="ap-p"><div class="ap-pi"></div></div>`;
    }
    const item = proto.cloneNode(true);
    item._id = id;
    return { item, row: item.firstChild, n: item.querySelector('.ap-n'), m: item.querySelector('.ap-m'), x: item.querySelector('.ap-x'), c: item.querySelector('.ap-c'),
      sub: item.querySelector('.ap-sub'), p: item.querySelector('.ap-p'), pi: item.querySelector('.ap-pi'), tpl: null };
  }
  const setText = (el, t) => { if (el.textContent !== t) el.textContent = t; };
  const setHtml = (el, h) => { if (el._h !== h) { el._h = h; el.innerHTML = h; } };
  function paintRow(r, v, value) {
    setText(r.n, v.name);
    setHtml(r.m, marks(v));
    const sum = summary(v.set);
    if (r.m.title !== sum) r.m.title = sum;
    setText(r.x, value);
    setHtml(r.sub, subLines(v));
    const open = P.open === v.id;
    r.item.classList.toggle('ctl', v.ctl);
    r.item.classList.toggle('stale', v.stale);
    r.item.classList.toggle('hot', P.hot === v.id);
    r.item.classList.toggle('is-open', open);
    r.row.setAttribute('aria-label', v.name + (v.ctl ? '' : ': ' + (v.why || '')));
    if (v.ctl) r.row.setAttribute('aria-expanded', open ? 'true' : 'false'); else r.row.removeAttribute('aria-expanded');
    r.row.title = v.ctl ? '' : (v.why || '');
    if (open) paintPanel(r, v);
  }

  /* ---- the panel ------------------------------------------------------------------------------------ */
  const sw = (f, label, help, icon) => `<div class="ap-ln"><span class="ap-lt">${icon ? `<span class="ap-ic">${icon}</span>` : ''}${esc(label)}</span>` +
    `<button type="button" class="ap-sw" role="switch" data-f="${f}" aria-checked="false" aria-label="${esc(label)}"><i></i></button></div>` +
    (help ? `<div class="ap-h">${esc(help)}</div>` : '');
  const seg = (f, label, opts, aside) => `<div class="ap-lb" id="ap-${f}-l">${esc(label)}${aside ? ` <span class="ap-q">${esc(aside)}</span>` : ''}</div>` +
    `<div class="ap-seg" role="radiogroup" data-f="${f}" aria-labelledby="ap-${f}-l">` +
    opts.map(([v, t]) => `<button type="button" role="radio" data-v="${esc(v)}" aria-checked="false" tabindex="-1">${esc(t)}</button>`).join('') + '</div>';
  function template(kind, v) {
    const caps = P.caps || {};
    let h = '';
    if (kind === 'cpu') {
      h += sw('eco', 'Efficiency mode', 'Runs it on less power, so the apps you’re using come first', LEAF);
      h += seg('priority', 'Priority', PRIOS);
      h += seg('cpuCap', 'CPU limit', CPU_CAPS, 'of your whole CPU');
      h += '<div class="ap-h ap-shared" hidden></div>';
    } else if (kind === 'mem') {
      h += sw('memLow', 'Lower memory priority', 'When memory runs short, Windows takes it from this app first');
      h += '<div class="ap-ln ap-act"><button type="button" class="ap-btn" data-f="trim">Free up memory</button><span class="ap-res" role="status"></span></div>';
      h += `<div class="ap-lb" id="ap-memCap-l">Memory limit</div><div class="ap-warn">If ${esc(v.label)} needs more, it may close or crash</div>`;
      h += '<div class="ap-seg" role="radiogroup" data-f="memCap" aria-labelledby="ap-memCap-l">' +
        MEM_CAPS.map(([b, t]) => `<button type="button" role="radio" data-v="${b}" aria-checked="false" tabindex="-1">${esc(t)}</button>`).join('') + '</div>';
      h += '<div class="ap-h ap-shared" hidden></div>';
    } else {
      if (caps.gpuLow) h += sw('gpuLow', 'Lower graphics priority', 'Other apps get the graphics chip first');
      else h += `<div class="ap-lb">Lower graphics priority</div><div class="ap-h">${esc(gpuLowWhy(caps))}</div>`;
      if (caps.gpuPref) h += seg('gpuPref', 'Graphics preference', GPU_PREFS);
      h += '<div class="ap-h ap-honest">Windows can’t put a hard limit on graphics use.</div>';
    }
    h += '<div class="ap-ft"><button type="button" class="ap-ck" role="checkbox" data-f="remember" aria-checked="true"><i></i>Remember for this app</button>' +
      '<button type="button" class="ap-lnk" data-f="reset" hidden>Back to normal</button></div>';
    if (v.test) h += '<div class="ap-h ap-test">This is a test copy of Mantle: it shows each change but leaves the app as it is.</div>';
    return `<div class="ap-pc">${h}</div>`;
  }
  function gpuLowWhy(caps) {
    if (caps.gpuLowWhy) return 'Not available here: ' + String(caps.gpuLowWhy).replace(/^./, (c) => c.toLowerCase());
    if (caps.gpus == null) return 'Not available yet: Mantle is still checking what this PC’s graphics allow';
    return 'Not available here: Windows doesn’t let Mantle change it on this PC';
  }
  function paintPanel(r, v) {
    const tpl = P.kind + '|' + (P.caps.gpuLow ? 1 : 0) + (P.caps.gpuPref ? 1 : 0) + (v.test ? 1 : 0) + '|' + v.label;
    if (r.tpl !== tpl) {   // first open, or the PC's graphics answer changed: drawn again, the focus kept
      const a = document.activeElement, fa = a && r.pi.contains(a) ? [a.dataset.f || (a.parentNode && a.parentNode.dataset.f), a.dataset.v] : null;
      r.pi.innerHTML = template(P.kind, v);
      r.tpl = tpl;
      if (fa) { const el = r.pi.querySelector(fa[1] != null ? `[data-f="${fa[0]}"] [data-v="${fa[1]}"]` : `[data-f="${fa[0]}"]`); if (el) el.focus({ preventScroll: true }); }
    }
    const s = v.set;
    r.pi.querySelectorAll('.ap-sw').forEach((b) => { b.setAttribute('aria-checked', s[b.dataset.f] ? 'true' : 'false'); });
    const want = { priority: s.priority || (s.eco ? 'low' : 'normal'), cpuCap: String(s.cpuCap || 0), memCap: String(s.memCap || 0), gpuPref: s.gpuPref || 'default' };
    r.pi.querySelectorAll('.ap-seg').forEach((g) => {
      const cur = want[g.dataset.f];
      g.querySelectorAll('[data-v]').forEach((b) => {
        const on = b.dataset.v === cur;
        b.setAttribute('aria-checked', on ? 'true' : 'false');
        if (!g.contains(document.activeElement)) b.tabIndex = on ? 0 : -1;
      });
    });
    const sh = r.pi.querySelector('.ap-shared');
    if (sh) {
      const capped = P.kind === 'cpu' ? s.cpuCap : s.memCap;
      sh.hidden = !(capped && v.shared === false);
      setText(sh, `Applies fully after ${v.label} restarts`);
    }
    const ck = r.pi.querySelector('.ap-ck');
    ck.setAttribute('aria-checked', v.rem ? 'true' : 'false');
    ck.disabled = P.busy.get(v.id) === 'remember';
    const lnk = r.pi.querySelector('.ap-lnk');
    lnk.hidden = !v.hasRule;
    lnk.disabled = P.busy.get(v.id) === 'reset';
    const tb = r.pi.querySelector('.ap-btn[data-f="trim"]');
    if (tb) {
      const busy = P.busy.get(v.id) === 'trim';
      tb.disabled = busy;
      setText(tb, busy ? 'Freeing up…' : 'Free up memory');
      setText(r.pi.querySelector('.ap-res'), P.freed.get(v.id) || '');
    }
  }

  /* ---- the rows' element, kept across samples ------------------------------------------------------- */
  function build(dd, kind) {
    const head = document.createElement('div'), list = document.createElement('div'), tail = document.createElement('div');
    head.className = 'ap-head'; tail.className = 'ap-tail';
    list.className = 'ap-list';
    list.setAttribute('role', 'group');
    list.setAttribute('aria-label', 'Top apps');
    list.addEventListener('mouseenter', () => { P.inside = true; });
    list.addEventListener('mouseleave', () => { P.inside = false; if (!P.kbd) hot(null); });
    list.addEventListener('mousemove', (e) => {
      const it = e.target.closest('.ap-item');
      if (!it || e.target.closest('.ap-p')) return;
      P.kbd = false;
      if (P.hot !== it._id) hot(it._id);
    });
    list.addEventListener('click', onClick);
    dd.replaceChildren(head, list, tail);
    // a dropdown opens sorted by use, every panel closed; replies, notes and in-flight changes are per
    // app and stay (a change made a moment ago in the CPU one shows in the RAM one)
    P.kind = kind;
    P.open = null; P.hot = null; P.kbd = false; P.inside = false;
    P.order = []; P.last.clear();
    P.els = { dd, head, list, tail, rows: new Map(), headH: null, tailH: null };
  }

  /** renderStatMenu's hand-off: the head and tail html as before, the rows kept and patched. */
  function render(dd, kind, headHtml, tailHtml, top, caps, value) {
    if (!P.els || P.els.dd !== dd || P.els.list.parentNode !== dd || P.kind !== kind) build(dd, kind);
    const E = P.els;
    dd.classList.add('ap-on');   // one width while rows come and go and panels open (topbar.css)
    dd._room = ROOM_PX;          // and two lines of spare height under it (topbar.js notifyMain)
    P.caps = caps || {};
    if (E.headH !== headHtml) { E.headH = headHtml; E.head.innerHTML = headHtml; }
    if (E.tailH !== tailHtml) { E.tailH = tailHtml; E.tail.innerHTML = tailHtml; }
    const now = Date.now(), seen = [];
    top.forEach((e) => { const id = idOf(e); if (!seen.includes(id)) { seen.push(id); P.last.set(id, { e, at: now }); } });
    const frozen = !!(P.open || P.inside || (P.kbd && P.hot));
    let order = seen;
    if (frozen && P.order.length) {
      const keep = new Set([P.open, P.hot].filter(Boolean));
      order = P.order.filter((id) => seen.includes(id) || (keep.has(id) && P.last.has(id)));
      seen.forEach((id) => { if (!order.includes(id)) order.push(id); });
    }
    P.order = order;
    for (const [id, l] of P.last) if (!order.includes(id) && now - l.at > 60000) P.last.delete(id);
    const a = document.activeElement, hadFocus = a && E.list.contains(a) ? a : null;
    const next = new Map();
    let cur = E.list.firstChild;
    order.forEach((id) => {
      const l = P.last.get(id);
      const v = viewOf(id, l.e, !seen.includes(id));
      P.view.set(id, v);
      let r = E.rows.get(id);
      if (!r) r = newRow(id);
      next.set(id, r);
      paintRow(r, v, value(l.e));
      if (r.item === cur) cur = cur.nextSibling;
      else E.list.insertBefore(r.item, cur);
    });
    E.rows.forEach((r, id) => { if (!next.has(id)) r.item.remove(); });
    E.rows = next;
    if (P.open && !next.has(P.open)) P.open = null;
    if (P.open && !(P.view.get(P.open) || {}).ctl) closePanel(next.get(P.open), true);   // Windows or Mantle took it out of reach: the row says why
    if (P.hot && !next.has(P.hot)) { P.hot = null; P.kbd = false; }
    if (hadFocus && document.activeElement !== hadFocus && hadFocus.isConnected) hadFocus.focus({ preventScroll: true });
  }

  /* ---- hover, keys and clicks ------------------------------------------------------------------------ */
  function hot(id) {
    P.hot = id;
    if (!P.els) return;
    P.els.rows.forEach((r, k) => r.item.classList.toggle('hot', k === id));
  }
  function repaint(id) {
    if (!P.els) return;
    const r = P.els.rows.get(id), l = P.last.get(id);
    if (!r || !l) return;
    const v = viewOf(id, l.e, r.item.classList.contains('stale'));
    P.view.set(id, v);
    paintRow(r, v, r.x.textContent);
  }
  function keepVisible(el) {
    const dd = P.els && P.els.dd;
    if (!dd || !el || dd.scrollHeight <= dd.clientHeight) return;
    const top = el.offsetTop, bottom = top + el.offsetHeight;
    if (top < dd.scrollTop) dd.scrollTop = top - 5;
    else if (bottom > dd.scrollTop + dd.clientHeight) dd.scrollTop = bottom - dd.clientHeight + 5;
  }

  function openPanel(id, kbd) {
    const E = P.els, r = E && E.rows.get(id), v = P.view.get(id);
    if (!r || !v || !v.ctl) return;
    const prev = P.open && P.open !== id ? E.rows.get(P.open) : null;
    const prevH = prev ? prev.p.offsetHeight : 0;
    P.open = id;
    hot(id);
    paintRow(r, v, r.x.textContent);           // draws the panel's content, still folded
    if (prev) closePanel(prev, false);
    const dd = E.dd;
    dd._growTo = dd.offsetHeight + r.pi.scrollHeight - prevH;
    api.rerender();                              // main grows the window first (topbar.js notifyMain reads _growTo)
    const unfold = () => {
      if (P.open !== id || !r.item.isConnected) return;
      r.item.classList.add('open');
      if (kbd) focusFirst(r);
      setTimeout(() => { dd._growTo = 0; api.rerender(); keepVisible(r.item); }, reduced() ? 0 : OPEN_MS + 20);
    };
    const need = () => dd.getBoundingClientRect().top + dd._growTo;
    if (window.innerHeight >= need()) requestAnimationFrame(unfold);
    else {
      let done = false;
      const go = () => { if (done) return; done = true; window.removeEventListener('resize', onR); unfold(); };
      const onR = () => { if (window.innerHeight >= need()) go(); };
      window.addEventListener('resize', onR);
      setTimeout(go, GROW_WAIT_MS);
    }
  }
  function closePanel(r, rerender) {
    if (!r) return;
    const a = document.activeElement;
    if (a && r.p.contains(a)) r.row.focus({ preventScroll: true });
    r.item.classList.remove('open');
    if (P.open === r.item._id) P.open = null;
    r.item.classList.remove('is-open');
    r.row.setAttribute('aria-expanded', 'false');
    setTimeout(() => {
      if (r.item.classList.contains('open')) return;
      r.pi.innerHTML = ''; r.tpl = null;
      if (rerender) api.rerender();             // the window shrinks back once the panel has folded
    }, reduced() ? 0 : OPEN_MS + 20);
  }
  function toggle(id, kbd) {
    if (P.open === id) closePanel(P.els.rows.get(id), true);
    else openPanel(id, kbd);
  }

  // The panel's stops, in order: each switch and button, and each choice group once (its picked option).
  function stops(r) {
    const out = [];
    r.pi.querySelectorAll('.ap-sw, .ap-btn, .ap-seg, .ap-ck, .ap-lnk').forEach((el) => {
      if (el.hidden || el.disabled) return;
      if (el.classList.contains('ap-seg')) out.push(el.querySelector('[aria-checked="true"]') || el.querySelector('[data-v]'));
      else out.push(el);
    });
    return out.filter(Boolean);
  }
  function focusFirst(r) { const s = stops(r); if (s[0]) s[0].focus({ preventScroll: true }); }
  function stepStop(r, dir, wrap) {
    const s = stops(r), a = document.activeElement;
    const g = a && a.closest('.ap-seg');
    let i = s.findIndex((el) => el === a || (g && g.contains(el)));
    if (i < 0) { if (s[0]) s[0].focus({ preventScroll: true }); return; }
    i += dir;
    if (i < 0) { if (wrap) i = s.length - 1; else { r.row.focus({ preventScroll: true }); return; } }
    if (i >= s.length) i = wrap ? 0 : s.length - 1;
    s[i].focus({ preventScroll: true });
    keepVisible(s[i]);
  }
  function stepRow(dir) {
    const ids = P.order.filter((id) => P.els.rows.has(id));
    if (!ids.length) return;
    const i = ids.indexOf(P.hot);
    const id = ids[i < 0 ? (dir > 0 ? 0 : ids.length - 1) : (i + dir + ids.length) % ids.length];
    P.kbd = true;
    hot(id);
    const r = P.els.rows.get(id);
    r.row.focus({ preventScroll: true });
    keepVisible(r.row);
  }

  /** topbar.js's keydown hands every key here first while a CPU / RAM / GPU dropdown with rows is open;
   *  true = handled (the menu does nothing more with it). */
  function key(e) {
    const E = P.els;
    if (!E || !E.list.isConnected) return false;
    const a = document.activeElement;
    const inP = a && a.closest && a.closest('.ap-p');
    const r = inP ? E.rows.get(inP.closest('.ap-item')._id) : null;
    const k = e.key;
    const handled = () => { e.preventDefault(); return true; };
    if (r) {
      const g = a.closest('.ap-seg');
      if (k === 'Enter' || k === ' ') return true;   // the focused control's own click: the menu must not eat it
      if (k === 'Tab') { stepStop(r, e.shiftKey ? -1 : 1, true); return handled(); }
      if (k === 'ArrowDown' || k === 'ArrowUp') { stepStop(r, k === 'ArrowDown' ? 1 : -1, false); return handled(); }
      if (g && (k === 'ArrowRight' || k === 'ArrowLeft')) {
        const bs = [...g.querySelectorAll('[data-v]')], i = bs.indexOf(a), j = i + (k === 'ArrowRight' ? 1 : -1);
        if (j >= 0 && j < bs.length) { bs[j].focus({ preventScroll: true }); return handled(); }
        if (k === 'ArrowRight') return handled();
      }
      if (k === 'Escape' || k === 'ArrowLeft') { closePanel(r, true); P.kbd = true; hot(r.item._id); return handled(); }
      return k === 'ArrowRight' ? handled() : false;
    }
    if (k === 'ArrowDown' || k === 'ArrowUp') { stepRow(k === 'ArrowDown' ? 1 : -1); return handled(); }
    if (k === 'Tab') {   // into the open panel, if there is one
      const o = P.open && E.rows.get(P.open);
      if (o) focusFirst(o);
      return handled();
    }
    const hv = P.hot && P.view.get(P.hot);
    if ((k === 'Enter' || k === ' ' || k === 'ArrowRight') && hv) {
      if (!hv.ctl) return handled();
      if (P.open === P.hot) { if (k === 'ArrowRight') focusFirst(E.rows.get(P.hot)); else closePanel(E.rows.get(P.hot), true); }
      else openPanel(P.hot, true);
      return handled();
    }
    if ((k === 'Escape' || k === 'ArrowLeft') && P.open) {
      const id = P.open;
      closePanel(E.rows.get(id), true);
      P.kbd = true; hot(id);
      E.rows.get(id).row.focus({ preventScroll: true });
      return handled();
    }
    return false;
  }

  function onClick(e) {
    const item = e.target.closest('.ap-item');
    if (!item) return;
    const id = item._id;
    const ctl = e.target.closest('[data-f]');
    if (ctl && e.target.closest('.ap-p')) { act(id, ctl, e.target.closest('[data-v]')); return; }
    if (e.target.closest('.ap-row')) {
      const v = P.view.get(id);
      if (v && v.ctl) { P.kbd = false; toggle(id, e.detail === 0); }
    }
  }

  /* ---- the commands ---------------------------------------------------------------------------------- */
  const words = (r, dflt) => (r && (r.reason || r.error)) || dflt;
  function noteOf(id, text, bad) { if (text) P.note.set(id, { text, bad: !!bad, at: Date.now() }); else P.note.delete(id); }
  function takeRow(id, row) { if (row && typeof row === 'object' && row.set) P.over.set(id, { row, at: Date.now() }); }

  function act(id, ctl, btn) {
    const v = P.view.get(id);
    if (!v || !v.ctl || ctl.disabled) return;
    const f = ctl.dataset.f;
    if (f === 'remember') return remember(id, v, ctl.getAttribute('aria-checked') !== 'true');
    if (f === 'trim') return trim(id, v);
    if (f === 'reset') return reset(id, v);
    let val;
    if (ctl.getAttribute('role') === 'switch') val = ctl.getAttribute('aria-checked') !== 'true';
    else {
      if (!btn || btn.getAttribute('aria-checked') === 'true') return;
      val = f === 'cpuCap' || f === 'memCap' ? Number(btn.dataset.v) : btn.dataset.v;
    }
    change(id, v, f, val);
  }

  function change(id, v, f, val) {
    const seq = ++P.seq;
    const pd = P.pend.get(id) || {};
    pd[f] = { v: val, seq };
    P.pend.set(id, pd);
    const rem = v.rem;
    if (!v.hasRule) P.rem.set(id, rem);      // the box keeps what it shows while the first change is in flight
    noteOf(id, null);
    repaint(id);
    api.call('apppower.set', { key: v.key, change: { [f]: val }, remember: rem }).then((r) => {
      const p = P.pend.get(id);
      if (p && p[f] && p[f].seq === seq) { delete p[f]; if (!Object.keys(p).length) P.pend.delete(id); }
      if (!r || r.ok === false) noteOf(id, words(r, NO_ANSWER), true);
      else noteOf(id, r.reason || null, false);   // applied, but (say) not saved for next time: said quietly
      takeRow(id, r && r.row);
      if (r && r.ok !== false && r.row) P.rem.delete(id);
      repaint(id);
    });
  }

  function remember(id, v, on) {
    if (!v.hasRule) { P.rem.set(id, on); repaint(id); return; }   // nothing set yet: the next change carries it
    P.rem.set(id, on);
    P.busy.set(id, 'remember');
    noteOf(id, null);
    repaint(id);
    api.call('apppower.remember', { key: v.key, on }).then((r) => {
      P.busy.delete(id);
      P.rem.delete(id);
      if (!r || r.ok === false) noteOf(id, words(r, NO_ANSWER), true);
      takeRow(id, r && r.row);
      repaint(id);
    });
  }

  function trim(id, v) {
    P.busy.set(id, 'trim');
    P.freed.delete(id);
    noteOf(id, null);
    repaint(id);
    api.call('apppower.trim', { key: v.key }).then((r) => {
      P.busy.delete(id);
      if (!r || r.ok === false) noteOf(id, words(r, 'Mantle didn’t answer, so nothing was freed'), true);
      else {
        P.freed.set(id, r.text || (r.freed >= MB ? 'Freed ' + bytes(r.freed) : 'Nothing more to free right now'));
        if (r.reason) noteOf(id, r.reason, true);
      }
      repaint(id);
    });
  }

  function reset(id, v) {
    P.busy.set(id, 'reset');
    noteOf(id, null);
    repaint(id);
    api.call('apppower.reset', { key: v.key }).then((r) => {
      P.busy.delete(id);
      if (!r || r.ok === false) noteOf(id, words(r, NO_ANSWER), true);
      else { takeRow(id, r.row || Object.assign({}, v.e, { set: Object.assign({}, DEF), remembered: false })); P.rem.delete(id); P.freed.delete(id); }
      repaint(id);
    });
  }

  function init(o) { api = Object.assign(api, o || {}); }

  window.AppPower = { init, owns, render, key, state: () => P, _esc: esc };
}());

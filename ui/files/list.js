/* list.js — the file list: Details, List and Grid, virtualised. A folder of 10,000 items must feel
 * instant, so the list never builds a row per item. It keeps a flat layout (one "line" per row of
 * rows/tiles or group header, with its top in a Float64Array), a single spacer that gives the scroll
 * height, and a pool of recycled cell elements placed with transforms. Each scroll frame asks "which
 * lines are on screen (plus 240 px either side)" by binary search and only fills cells whose item
 * changed. Fixed heights per view make all of that arithmetic, not layout.
 *
 * The list owns nothing about files: the page (files.js) is its host and answers names, icons,
 * thumbnails and column text, and hears about selection, opening, renames and context menus.
 * Selection lives on the tab as KEYS (name, or full path for search hits, or the bin key), so a
 * re-sort or a live refresh keeps it.
 */
(function () {
  'use strict';
  const MF = window.MF = window.MF || {};
  const M = MF.model;
  const $ = (id) => document.getElementById(id);

  const GRID = { small: { cw: 96, ch: 104, ic: 48, px: 48 }, medium: { cw: 132, ch: 150, ic: 96, px: 96 }, large: { cw: 200, ch: 222, ic: 172, px: 256 } };
  const ROW_H = 28;
  const ROW_H_COMPACT = 22;
  const LI_W = 250;
  const HEAD_H = 36;
  const PAD = 8;
  const TOP = 4;
  const OVERSCAN = 240;

  MF.keyOf = (it) => it.key || it.p || it.n;
  MF.GRID = GRID;

  class List {
    constructor(host) {
      this.host = host;
      this.sc = $('scroller');
      this.spacer = $('spacer');
      this.layer = $('layer');
      this.bandEl = $('band');
      this.head = $('colhead');
      this.cells = new Map();          // 'i<index>' | 'h<line>' -> element
      this.pool = { row: [], li: [], tile: [], gh: [] };
      this.tab = null;
      this.ver = 0;                    // bump = every visible cell refills (icons arrived, names changed)
      this.geo = null;
      this.band = null;
      this.renaming = null;
      this.pendingOnly = -1;
      this.typed = '';
      this.typedAt = 0;
      this.colKey = '';
      this.frameCb = null;
      this.sc.addEventListener('scroll', () => this.onScroll(), { passive: true });
      this.sc.addEventListener('mousedown', (e) => this.onDown(e));
      this.sc.addEventListener('mouseup', (e) => this.onUp(e));
      this.sc.addEventListener('dblclick', (e) => this.onDbl(e));
      // Ctrl+wheel: bigger / smaller view (details, list, small, medium, large icons), like Explorer
      this.sc.addEventListener('wheel', (e) => { if (!e.ctrlKey || !this.host.zoom) return; e.preventDefault(); this.host.zoom(e.deltaY < 0 ? 1 : -1); }, { passive: false });
      this.sc.addEventListener('auxclick', (e) => { if (e.button === 1) e.preventDefault(); });
      this.sc.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        if (this.renaming) return;
        const i = this.indexAt(e.target);
        this.host.contextMenu(e.clientX, e.clientY, i >= 0);
      });
      this.sc.addEventListener('dragstart', (e) => {
        const i = this.indexAt(e.target);
        // an HTML drag cannot carry files OUT of Chromium; main's startDrag gives the real OS drag
        e.preventDefault();
        if (i < 0 || this.renaming) return;
        if (!this.tab.sel.has(MF.keyOf(this.tab.shown[i]))) this.selectOnly(i);
        this.pendingOnly = -1;
        this.host.dragOut();
      });
      new ResizeObserver(() => { if (this.tab) this.relayout(true); }).observe(this.sc);
    }

    /* ---- data in ---------------------------------------------------------------------------------- */
    /** Show a tab (its shown list, view, selection). keepScroll: the same folder, refreshed. */
    setTab(tab, keepScroll) {
      if (this.renaming && this.tab !== tab) this.renaming.finish(false);
      const same = this.tab === tab;
      this.tab = tab;
      this.relayout(false);
      if (!same || !keepScroll) this.sc.scrollTop = tab.scroll || 0;
      this.render();
    }
    /** The shown list changed (a batch landed, a sort, a refresh): same tab, keep the scroll. */
    refresh() { if (this.tab) { this.relayout(false); this.render(); } }
    repaint() { this.ver++; this.render(); }
    mode() { return this.tab ? this.tab.view.view : 'details'; }

    /* ---- geometry ---------------------------------------------------------------------------------- */
    relayout(fromResize) {
      const t = this.tab;
      if (!t) return;
      const mode = t.view.view;
      const W = Math.max(120, this.sc.clientWidth);
      const anchor = fromResize && this.geo ? this.firstVisible() : -1;
      const cols = mode === 'details' ? this.detailCols() : null;
      let cw;
      let ch;
      let per;
      let rowW = W - 2 * PAD;
      if (mode === 'details') {
        const sum = cols.reduce((a, c) => a + c.w, 0);
        rowW = Math.max(sum, W - 2 * PAD);
        cw = rowW; ch = this.rowH(); per = 1;
        const grid = cols.map((c) => c.w + 'px').join(' ') + ' 1fr';
        this.layer.style.setProperty('--grid', grid);
        this.head.style.setProperty('--grid', grid);
        const key = t.view.view + '|' + cols.map((c) => c.id).join(',') + '|' + t.kind;
        if (key !== this.colKey) { this.clearCells(); this.colKey = key; }
        this.renderHead(cols);
      } else {
        const g = GRID[t.view.size] || GRID.medium;
        if (mode === 'list') { per = Math.max(1, Math.floor((W - 2 * PAD) / LI_W)); cw = Math.floor((W - 2 * PAD) / per); ch = this.rowH(); }
        else { per = Math.max(1, Math.floor((W - 2 * PAD) / g.cw)); cw = g.cw; ch = g.ch; }
        this.layer.style.setProperty('--ic', g.ic + 'px');
        const key = mode + '|' + (mode === 'grid' ? t.view.size : '');
        if (key !== this.colKey) { this.clearCells(); this.colKey = key; }
      }
      this.head.hidden = mode !== 'details' || t.kind === 'place';
      this.layer.classList.toggle('checks', !!(this.host.opt && this.host.opt('checkboxes')));
      this.layer.classList.toggle('compact', !!(this.host.opt && this.host.opt('compact')));
      this.layer.style.setProperty('--cw', cw + 'px');
      this.layer.style.setProperty('--ch', ch + 'px');
      this.layer.style.setProperty('--roww', rowW + 'px');
      const n = t.shown.length;
      const segs = t.groups && t.groups.length ? t.groups : [{ label: null, start: 0, count: n }];
      let L = 0;
      for (const g of segs) L += (g.label != null ? 1 : 0) + Math.ceil(g.count / per);
      const top = new Float64Array(L + 1);
      const start = new Int32Array(L);
      const count = new Int32Array(L);
      const lineOf = new Int32Array(n);
      let y = TOP;
      let l = 0;
      segs.forEach((g, gi) => {
        if (g.label != null) { top[l] = y; start[l] = gi; count[l] = -1; y += HEAD_H; l++; }
        const end = g.start + g.count;
        for (let s = g.start; s < end; s += per) {
          const c = Math.min(per, end - s);
          top[l] = y; start[l] = s; count[l] = c;
          for (let k = 0; k < c; k++) lineOf[s + k] = l;
          y += ch; l++;
        }
      });
      top[L] = y;
      this.geo = { mode, W, cw, ch, per, rowW, L, top, start, count, lineOf, total: y + PAD, cols };
      this.spacer.style.height = this.geo.total + 'px';
      this.spacer.style.width = mode === 'details' ? rowW + 2 * PAD + 'px' : '1px';
      if (anchor >= 0 && anchor < n) this.sc.scrollTop = Math.max(0, top[lineOf[anchor]] - TOP);
      if (fromResize) this.render();
    }
    detailCols() { return this.tab.view.colsParsed || (this.tab.view.colsParsed = M.parseCols(this.tab.view.cols, this.tab.colset)); }
    firstVisible() {
      const g = this.geo;
      const l = this.lineAtY(this.sc.scrollTop + 1);
      for (let k = l; k < g.L; k++) if (g.count[k] > 0) return g.start[k];
      return -1;
    }
    lineAtY(y) {
      const g = this.geo;
      let lo = 0;
      let hi = g.L - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (g.top[mid] <= y) lo = mid; else hi = mid - 1;
      }
      return Math.max(0, lo);
    }
    xyOf(i) {
      const g = this.geo;
      const l = g.lineOf[i];
      return { x: PAD + (i - g.start[l]) * (g.mode === 'details' ? 0 : g.cw), y: g.top[l], l };
    }

    /* ---- the column header (Details) --------------------------------------------------------------- */
    renderHead(cols) {
      const t = this.tab;
      const sig = cols.map((c) => c.id + ':' + c.w).join(',') + '|' + t.view.sort + t.view.dir + '|' + t.kind;
      if (this.head._sig === sig) return;
      this.head._sig = sig;
      this.head.textContent = '';
      const hin = document.createElement('div');
      hin.className = 'hin';
      for (const c of cols) {
        const def = M.COLS[c.id];
        const hc = document.createElement('div');
        hc.className = 'hc' + (def.right ? ' right' : '') + (t.view.sort === def.sort ? ' sorted' : '');
        const hl = document.createElement('span');
        hl.className = 'hl';
        hl.textContent = M.colLabel(c.id, t.colset);
        hc.appendChild(hl);
        if (t.view.sort === def.sort) {
          const ar = document.createElement('span');
          ar.innerHTML = t.view.dir === 'desc'
            ? '<svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true"><path d="M1 2.5l3 3 3-3" stroke="currentColor" fill="none" stroke-width="1.1"/></svg>'
            : '<svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true"><path d="M1 5.5l3-3 3 3" stroke="currentColor" fill="none" stroke-width="1.1"/></svg>';
          hc.appendChild(ar);
        }
        hc.addEventListener('click', (e) => { if (!e.target.classList.contains('rz')) this.host.sortBy(def.sort); });
        const rz = document.createElement('span');
        rz.className = 'rz';
        rz.addEventListener('mousedown', (e) => this.startResize(e, c));
        rz.addEventListener('click', (e) => e.stopPropagation());
        hc.appendChild(rz);
        hin.appendChild(hc);
      }
      hin.addEventListener('contextmenu', (e) => { e.preventDefault(); this.host.columnMenu(e.clientX, e.clientY); });
      this.head.appendChild(hin);
      this.syncHead();
    }
    syncHead() { const h = this.head.firstChild; if (h) h.style.transform = `translateX(${-this.sc.scrollLeft}px)`; }
    startResize(e, col) {
      e.preventDefault();
      e.stopPropagation();
      const x0 = e.clientX;
      const w0 = col.w;
      const min = M.COLS[col.id].min;
      const move = (ev) => {
        col.w = Math.max(min, Math.min(1200, Math.round(w0 + ev.clientX - x0)));
        this.head._sig = '';
        this.relayout(false);
        this.render();
      };
      const up = () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        this.host.colsChanged(this.detailCols());
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    }

    /* ---- painting ------------------------------------------------------------------------------------ */
    clearCells() {
      for (const el of this.cells.values()) el.remove();
      this.cells.clear();
      for (const k of Object.keys(this.pool)) { for (const el of this.pool[k]) el.remove(); this.pool[k] = []; }
    }
    onScroll() {
      if (this.tab) this.tab.scroll = this.sc.scrollTop;
      this.syncHead();
      // scroll events already arrive once per frame: paint now, not a frame later (a blank strip)
      this.render();
    }
    render() {
      const t = this.tab;
      const g = this.geo;
      if (!t || !g) return;
      const st = this.sc.scrollTop;
      const y0 = st - OVERSCAN;
      const y1 = st + this.sc.clientHeight + OVERSCAN;
      const old = this.cells;
      const next = new Map();
      const missing = [];
      for (let l = g.L ? this.lineAtY(y0) : 0; l < g.L && g.top[l] < y1; l++) {
        if (g.count[l] < 0) {
          const k = 'h' + l;
          const el = old.get(k);
          if (el) { old.delete(k); next.set(k, el); this.fillHead(el, l); } else missing.push([k, -1, l]);
          continue;
        }
        for (let c = 0; c < g.count[l]; c++) {
          const i = g.start[l] + c;
          const k = 'i' + i;
          const el = old.get(k);
          if (el && el._it === t.shown[i]) { old.delete(k); next.set(k, el); this.fillItem(el, i); } else missing.push([k, i, l]);
        }
      }
      const kindOf = () => (g.mode === 'details' ? 'row' : g.mode === 'list' ? 'li' : 'tile');
      const spare = { row: [], li: [], tile: [], gh: [] };
      for (const el of old.values()) spare[el._kind].push(el);
      for (const [k, i, l] of missing) {
        const kind = i < 0 ? 'gh' : kindOf();
        const el = spare[kind].pop() || this.pool[kind].pop() || this.make(kind);
        el.hidden = false;
        next.set(k, el);
        if (i < 0) this.fillHead(el, l); else this.fillItem(el, i);
      }
      for (const kind of Object.keys(spare)) for (const el of spare[kind]) { el.hidden = true; el._it = null; this.pool[kind].push(el); }
      this.cells = next;
      if (this.frameCb) this.frameCb();
      this.host.painted();
    }
    make(kind) {
      const el = document.createElement('div');
      el._kind = kind;
      el._x = el._y = -1;
      if (kind === 'gh') {
        el.className = 'cell gh';
        el._lb = document.createElement('span');
        el._ct = document.createElement('span');
        el._ct.className = 'gc';
        el.append(el._lb, el._ct);
      } else if (kind === 'row') {
        el.className = 'cell row';
        el.draggable = true;
        const name = document.createElement('span');
        name.className = 'c-name';
        name.appendChild(this.makeCk());
        el._ic = document.createElement('img');
        el._ic.className = 'ic';
        el._ic.alt = '';
        el._nm = document.createElement('span');
        el._nm.className = 'nm';
        name.append(el._ic, el._nm);
        el.appendChild(name);
        el._cs = [];
        for (const c of this.geo.cols.slice(1)) {
          const s = document.createElement('span');
          if (M.COLS[c.id].right) s.className = 'right';
          s._id = c.id;
          el._cs.push(s);
          el.appendChild(s);
        }
      } else if (kind === 'li') {
        el.className = 'cell li';
        el.draggable = true;
        el.appendChild(this.makeCk());
        el._ic = document.createElement('img');
        el._ic.className = 'ic';
        el._ic.alt = '';
        el._nm = document.createElement('span');
        el._nm.className = 'nm';
        el.append(el._ic, el._nm);
      } else {
        el.className = 'cell tile';
        el.draggable = true;
        const tb = document.createElement('div');
        tb.className = 'tb';
        el._ic = document.createElement('img');
        el._ic.alt = '';
        tb.appendChild(el._ic);
        tb.appendChild(this.makeCk());
        el._nm = document.createElement('div');
        el._nm.className = 'nm';
        el.append(tb, el._nm);
      }
      this.layer.appendChild(el);
      return el;
    }
    /** The select check box (shown when the 'Item check boxes' option is on): a click toggles that one item. */
    makeCk() {
      const ck = document.createElement('span');
      ck.className = 'ck';
      ck.setAttribute('aria-hidden', 'true');
      return ck;
    }
    /** Row height: 28, or 22 in compact mode (details and list). */
    rowH() { return this.host.opt && this.host.opt('compact') ? ROW_H_COMPACT : ROW_H; }
    place(el, x, y) {
      if (el._x === x && el._y === y) return;
      el._x = x; el._y = y;
      el.style.transform = `translate(${x}px,${y}px)`;
    }
    fillHead(el, l) {
      const g = this.geo;
      const grp = this.tab.groups[g.start[l]];
      el._i = -1;
      el._grp = g.start[l];
      if (el._lbv !== grp.label) { el._lb.textContent = grp.label; el._lbv = grp.label; }
      const ct = `(${M.fmtCount(grp.count)})`;
      if (el._ctv !== ct) { el._ct.textContent = ct; el._ctv = ct; }
      this.place(el, PAD, g.top[l]);
    }
    fillItem(el, i) {
      const t = this.tab;
      const g = this.geo;
      const it = t.shown[i];
      el._i = i;
      if (el._it !== it || el._v !== this.ver) {
        el._it = it;
        el._v = this.ver;
        const h = this.host;
        const name = h.nameOf(it);
        el._nm.textContent = name;
        if (el._kind === 'tile') {
          const th = it.d ? null : h.thumbOf(it);
          const src = th || h.iconOf(it, (GRID[t.view.size] || GRID.medium).px);
          this.setImg(el._ic, src);
          el._ic.classList.toggle('th', !!th && th.kind === 'thumb');
          el.title = name;
        } else {
          this.setImg(el._ic, h.iconOf(it, 16));
          if (el._kind === 'row') {
            for (const s of el._cs) s.textContent = h.colText(it, s._id);
            el._nm.title = name;                         // a long name ellipsizes; the full one shows on hover
          } else el.title = name;
        }
      }
      const key = MF.keyOf(it);
      el.classList.toggle('sel', t.sel.has(key));
      el.classList.toggle('focus', t.focusKey === key);
      el.classList.toggle('cut', this.host.isCut(it));
      el.classList.toggle('hid', (it.a & 2) !== 0);
      const l = g.lineOf[i];
      this.place(el, PAD + (i - g.start[l]) * (g.mode === 'details' ? 0 : g.cw), g.top[l]);
    }
    setImg(img, src) {
      const url = src && typeof src === 'object' ? src.url : src;
      if (img._src === url) return;
      img._src = url;
      if (url) { img.src = url; img.style.visibility = ''; } else { img.removeAttribute('src'); img.style.visibility = 'hidden'; }
    }
    /** The items on screen now (thumbnails and icons are asked for these only). */
    visible() {
      const out = [];
      const t = this.tab;
      const st = this.sc.scrollTop;
      const y1 = st + this.sc.clientHeight;
      for (const el of this.cells.values()) if (el._i >= 0 && el._it && el._y + this.geo.ch > st && el._y < y1) out.push(t.shown[el._i]);
      return out;
    }
    /** Refill the visible cells that show these items (a thumbnail landed). */
    refill(pred) {
      for (const el of this.cells.values()) if (el._it && pred(el._it)) { el._v = -1; this.fillItem(el, el._i); }
    }

    /* ---- hit testing ---------------------------------------------------------------------------------- */
    indexAt(target) {
      const cell = target && target.closest ? target.closest('.cell') : null;
      return cell && cell._it && cell._i >= 0 ? cell._i : -1;
    }
    cellAt(target) { return target && target.closest ? target.closest('.cell') : null; }
    hitRect(x0, y0, x1, y1) {
      const g = this.geo;
      const out = [];
      if (!g || !g.L) return out;
      for (let l = this.lineAtY(y0); l < g.L && g.top[l] < y1; l++) {
        if (g.count[l] < 0) continue;
        const h = g.mode === 'details' ? this.rowH() : g.ch;
        if (g.top[l] + h <= y0) continue;
        if (g.mode === 'details') {
          if (x1 >= PAD && x0 <= PAD + g.rowW) out.push(g.start[l]);
          continue;
        }
        const c0 = Math.max(0, Math.floor((x0 - PAD) / g.cw));
        const c1 = Math.min(g.count[l] - 1, Math.floor((x1 - PAD) / g.cw));
        for (let c = c0; c <= c1; c++) out.push(g.start[l] + c);
      }
      return out;
    }

    /* ---- selection ---------------------------------------------------------------------------------- */
    focusIndex() {
      const t = this.tab;
      if (t.focusKey == null) return -1;
      const i = t.index.get(t.focusKey);
      return i === undefined ? -1 : i;
    }
    anchorIndex() {
      const t = this.tab;
      const i = t.anchorKey != null ? t.index.get(t.anchorKey) : undefined;
      return i === undefined ? Math.max(0, this.focusIndex()) : i;
    }
    changed() { this.render(); this.host.selChanged(); }
    setFocus(i, reveal) {
      const t = this.tab;
      if (i < 0 || i >= t.shown.length) return;
      t.focusKey = MF.keyOf(t.shown[i]);
      if (reveal) this.reveal(i);
    }
    selectOnly(i) {
      const t = this.tab;
      t.sel = new Set();
      if (i >= 0 && i < t.shown.length) { const k = MF.keyOf(t.shown[i]); t.sel.add(k); t.anchorKey = k; t.focusKey = k; }
      this.changed();
    }
    /** Invert: every shown item not selected becomes selected, and the other way round. */
    invert() {
      const t = this.tab;
      const next = new Set();
      for (const it of t.shown) { const k = MF.keyOf(it); if (!t.sel.has(k)) next.add(k); }
      t.sel = next;
      this.changed();
    }
    toggle(i) {
      const t = this.tab;
      const k = MF.keyOf(t.shown[i]);
      if (t.sel.has(k)) t.sel.delete(k); else t.sel.add(k);
      t.anchorKey = k;
      t.focusKey = k;
      this.changed();
    }
    range(a, b, add) {
      const t = this.tab;
      if (!add) t.sel = new Set();
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      for (let i = lo; i <= hi; i++) t.sel.add(MF.keyOf(t.shown[i]));
      t.focusKey = MF.keyOf(t.shown[b]);
      this.changed();
    }
    selectAll() {
      const t = this.tab;
      t.sel = new Set(t.shown.map(MF.keyOf));
      this.changed();
    }
    clear() {
      const t = this.tab;
      if (!t.sel.size) return;
      t.sel = new Set();
      this.changed();
    }
    selectKeys(keys, focusFirst) {
      const t = this.tab;
      t.sel = new Set();
      let first = -1;
      for (const k of keys) {
        const i = t.index.get(k);
        if (i === undefined) continue;
        t.sel.add(k);
        if (first < 0 || i < first) first = i;
      }
      if (first >= 0 && focusFirst !== false) { t.focusKey = MF.keyOf(t.shown[first]); t.anchorKey = t.focusKey; this.reveal(first); }
      this.changed();
      return first;
    }
    reveal(i) {
      const g = this.geo;
      if (!g || i < 0 || i >= this.tab.shown.length) return;
      const y = g.top[g.lineOf[i]];
      const h = this.sc.clientHeight;
      const hdr = g.lineOf[i] > 0 && g.count[g.lineOf[i] - 1] < 0 ? HEAD_H : 0;
      if (y - hdr < this.sc.scrollTop) this.sc.scrollTop = Math.max(0, y - hdr - TOP);
      else if (y + g.ch > this.sc.scrollTop + h) this.sc.scrollTop = y + g.ch - h + PAD;
    }

    /* ---- mouse ------------------------------------------------------------------------------------ */
    onDown(e) {
      const t = this.tab;
      if (!t) return;
      if (this.renaming && e.target === this.renaming.input) return;
      if (e.target === this.sc && (e.offsetX >= this.sc.clientWidth || e.offsetY >= this.sc.clientHeight)) return;   // the scrollbar
      if (e.button === 1) e.preventDefault();
      this.sc.focus({ preventScroll: true });
      const cell = this.cellAt(e.target);
      if (cell && cell._kind === 'gh' && e.button === 0) {
        const grp = t.groups[cell._grp];
        t.sel = e.ctrlKey ? t.sel : new Set();
        for (let i = grp.start; i < grp.start + grp.count; i++) t.sel.add(MF.keyOf(t.shown[i]));
        this.setFocus(grp.start);
        this.changed();
        return;
      }
      const i = this.indexAt(e.target);
      if (i >= 0) {
        const k = MF.keyOf(t.shown[i]);
        this.pendingOnly = -1;
        if (e.button === 0 && e.target.classList && e.target.classList.contains('ck')) { this.toggle(i); return; }   // the check box
        if (e.button === 0) {
          if (e.shiftKey) this.range(this.anchorIndex(), i, e.ctrlKey);
          else if (e.ctrlKey) this.toggle(i);
          else if (!t.sel.has(k)) this.selectOnly(i);
          else { this.pendingOnly = i; t.focusKey = k; t.anchorKey = k; this.render(); }
        } else if (e.button === 2) {
          if (!t.sel.has(k)) this.selectOnly(i); else { t.focusKey = k; this.render(); }
        } else if (e.button === 1) {
          this.host.middle(i);
        }
        return;
      }
      if (e.button === 0) this.startBand(e);
      else if (e.button === 2 && !e.ctrlKey) this.clear();
    }
    onUp(e) {
      if (this.pendingOnly >= 0 && e.button === 0 && !e.ctrlKey && !e.shiftKey) {
        const i = this.pendingOnly;
        this.pendingOnly = -1;
        if (this.tab.sel.size > 1) this.selectOnly(i);
      }
    }
    onDbl(e) {
      const i = this.indexAt(e.target);
      if (i >= 0 && e.button === 0 && !this.renaming && !(e.target.classList && e.target.classList.contains('ck'))) this.host.open(i);
    }

    /* ---- rubber band: pure geometry against the layout, no DOM queries ------------------------------ */
    startBand(e) {
      const t = this.tab;
      const r = this.sc.getBoundingClientRect();
      const base = e.ctrlKey || e.shiftKey ? new Set(t.sel) : new Set();
      if (!e.ctrlKey && !e.shiftKey && t.sel.size) { t.sel = new Set(); this.changed(); }
      const b = {
        x0: e.clientX - r.left + this.sc.scrollLeft, y0: e.clientY - r.top + this.sc.scrollTop, cx: e.clientX, cy: e.clientY, base, toggle: e.ctrlKey,
        moved: false, timer: null, last: '',
      };
      this.band = b;
      const move = (ev) => { b.cx = ev.clientX; b.cy = ev.clientY; this.bandMove(); };
      const up = () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        clearInterval(b.timer);
        this.bandEl.hidden = true;
        this.band = null;
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
      // held past the edge: keep scrolling and keep selecting, like Explorer
      b.timer = setInterval(() => {
        const rr = this.sc.getBoundingClientRect();
        let d = 0;
        if (b.cy < rr.top + 4) d = -Math.min(40, (rr.top + 4 - b.cy) / 2 + 4);
        else if (b.cy > rr.bottom - 4) d = Math.min(40, (b.cy - rr.bottom + 4) / 2 + 4);
        if (d && b.moved) { this.sc.scrollTop += d; this.bandMove(); }
      }, 16);
    }
    bandMove() {
      const b = this.band;
      if (!b) return;
      const r = this.sc.getBoundingClientRect();
      const x1 = Math.max(0, Math.min(this.sc.scrollWidth, b.cx - r.left + this.sc.scrollLeft));
      const y1 = Math.max(0, Math.min(this.geo.total, b.cy - r.top + this.sc.scrollTop));
      if (!b.moved && Math.abs(x1 - b.x0) + Math.abs(y1 - b.y0) < 5) return;
      b.moved = true;
      const lx = Math.min(b.x0, x1);
      const ly = Math.min(b.y0, y1);
      const w = Math.abs(x1 - b.x0);
      const h = Math.abs(y1 - b.y0);
      this.bandEl.hidden = false;
      this.bandEl.style.transform = `translate(${lx}px,${ly}px)`;
      this.bandEl.style.width = w + 'px';
      this.bandEl.style.height = h + 'px';
      const hits = this.hitRect(lx, ly, lx + w, ly + h);
      const sig = hits.length + ':' + (hits[0] || 0) + ':' + (hits[hits.length - 1] || 0);
      if (sig === b.last) return;
      b.last = sig;
      const t = this.tab;
      const sel = new Set(b.base);
      for (const i of hits) { const k = MF.keyOf(t.shown[i]); if (b.toggle && b.base.has(k)) sel.delete(k); else sel.add(k); }
      t.sel = sel;
      if (hits.length) t.focusKey = MF.keyOf(t.shown[hits[hits.length - 1]]);
      this.changed();
    }

    /* ---- keyboard ---------------------------------------------------------------------------------- */
    stepLine(i, d) {
      const g = this.geo;
      if (i < 0) return 0;
      const l = g.lineOf[i];
      const col = i - g.start[l];
      let m = l + d;
      while (m >= 0 && m < g.L && g.count[m] < 0) m += d;
      if (m < 0 || m >= g.L) return i;
      return g.start[m] + Math.min(col, g.count[m] - 1);
    }
    key(e) {
      const t = this.tab;
      if (!t || this.renaming) return false;
      const n = t.shown.length;
      const g = this.geo;
      const k = e.key;
      const i = this.focusIndex();
      let to = null;
      if (k === 'ArrowDown') to = this.stepLine(i, 1);
      else if (k === 'ArrowUp') to = this.stepLine(i, -1);
      else if (k === 'ArrowRight' && g.mode !== 'details') to = Math.min(n - 1, i + 1);
      else if (k === 'ArrowLeft' && g.mode !== 'details') to = Math.max(0, i - 1);
      else if (k === 'Home') to = 0;
      else if (k === 'End') to = n - 1;
      else if (k === 'PageDown' || k === 'PageUp') {
        const rows = Math.max(1, Math.floor(this.sc.clientHeight / g.ch) - 1);
        to = i < 0 ? 0 : i;
        for (let r = 0; r < rows; r++) to = this.stepLine(to, k === 'PageDown' ? 1 : -1);
      } else if (k === ' ' && !e.altKey) {
        if (i < 0) return false;
        if (e.ctrlKey) this.toggle(i); else if (!t.sel.has(t.focusKey)) this.selectOnly(i);
        return true;
      } else return false;
      if (!n) return true;
      if (i < 0 && (k === 'ArrowDown' || k === 'ArrowRight')) to = 0;
      to = Math.max(0, Math.min(n - 1, to));
      if (e.shiftKey) { this.range(this.anchorIndex(), to, e.ctrlKey); this.reveal(to); }
      else if (e.ctrlKey) { this.setFocus(to, true); this.render(); }
      else { this.selectOnly(to); this.reveal(to); }
      return true;
    }
    /** Type-ahead: letters typed within 0.9 s jump to the next name that starts with them. */
    typeAhead(ch) {
      const t = this.tab;
      const now = performance.now();
      this.typed = now - this.typedAt > 900 ? ch : this.typed + ch;
      this.typedAt = now;
      const i = this.focusIndex();
      const from = this.typed.length === 1 ? i + 1 : Math.max(0, i);
      const hit = M.findTypeAhead(t.shown, this.typed, from, this.host.nameOf);
      if (hit >= 0) { this.selectOnly(hit); this.reveal(hit); }
    }

    /* ---- inline rename (F2, and right after New folder) --------------------------------------------- */
    beginRename(i, onDone) {
      const t = this.tab;
      if (i < 0 || i >= t.shown.length) return;
      if (this.renaming) this.renaming.finish(true);
      this.reveal(i);
      this.render();
      const it = t.shown[i];
      const g = this.geo;
      const p = this.xyOf(i);
      const input = document.createElement('input');
      input.className = 'rename';
      input.spellcheck = false;
      const hideExt = !this.host.showExt() && !it.d && M.stemLength(it.n, false) < it.n.length;
      const ext = hideExt ? it.n.slice(M.stemLength(it.n, false)) : '';
      input.value = hideExt ? it.n.slice(0, it.n.length - ext.length) : it.n;
      let x = p.x + 8 + 16 + 3;
      let y = p.y + 2;
      let w = (g.mode === 'details' ? g.cols[0].w : g.cw) - 16 - 14;
      if (g.mode === 'grid') {
        const gs = GRID[t.view.size] || GRID.medium;
        x = p.x + 1; y = p.y + 6 + gs.ic + 3; w = g.cw - 2;
        input.classList.add('multi');
      }
      input.style.transform = `translate(${x}px,${y}px)`;
      input.style.width = Math.max(80, w) + 'px';
      this.layer.appendChild(input);
      input.focus();
      input.setSelectionRange(0, hideExt ? input.value.length : M.stemLength(it.n, it.d));
      let done = false;
      const finish = (commit) => {
        if (done) return;
        done = true;
        const v = input.value.trim() + ext;
        input.remove();
        this.renaming = null;
        this.sc.focus({ preventScroll: true });
        if (commit && v !== it.n && input.value.trim()) onDone(it, v);
      };
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') { e.preventDefault(); finish(true); } else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      });
      input.addEventListener('mousedown', (e) => e.stopPropagation());
      input.addEventListener('dblclick', (e) => e.stopPropagation());
      input.addEventListener('contextmenu', (e) => e.stopPropagation());
      input.addEventListener('blur', () => finish(true));
      this.renaming = { input, key: MF.keyOf(it), finish };
    }
  }

  MF.List = List;
}());

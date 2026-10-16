'use strict';
/* overlap-probe.js - the IN-PAGE half of tools/overlap-audit.js (lane overlap, 2026-10-15).
 *
 * overlapProbe() is serialised with Function.prototype.toString and run by page.evaluate, so it may use
 * nothing from this file's scope. It reads the page as it stands and returns plain JSON:
 *
 *   items     every visible interactive element (button, link, input, [role], [tabindex], cursor:pointer
 *             roots), tagged data-ovn=<n> so the node side can find it over CDP, with its box, the boxes of
 *             its ancestors (ovn ids, nearest first), its REAL hit box (scanned with elementFromPoint, so
 *             padding, pseudo-element hit areas and anything covering it all count) and its neighbours.
 *   ink       everything a person reads or recognises: text runs (one box per line fragment) and graphics
 *             (svg, img, canvas, video, small background/mask icons), each with the surface it is painted on.
 *   findings  the checks that need no state change:
 *             ink-overlap   two ink boxes on the same surface intersect (an icon over a label, two labels)
 *             box-overlap   two in-flow visible boxes (cards, buttons with a fill) intersect
 *             text-clipped  text cut by a non-scrolling overflow box with no ellipsis, fade or line clamp
 *             text-spill    text running out of its own block box (nothing clips it, it just spills)
 *             sticks-out    a visible box or ink item crossing out of the visible container it sits in
 *             outside-window  ink or a visible box partly past the window edge
 *             hitbox-overlap  another control's hit area covers part of this one
 *             covered       a control under an invisible element that takes its clicks
 *             target-size   a hit box under 24 x 24 CSS px that also fails WCAG 2.5.8's spacing exception
 *             target-small  (info) under 24 px but clear of other targets by the spacing exception
 */
function overlapProbe(opt) {
  opt = opt || {};
  const VW = innerWidth, VH = innerHeight;
  const MIN_TARGET = opt.minTarget || 24;
  const SEL = 'button, a[href], input:not([type=hidden]), select, textarea, summary, [role=button], [role=tab], [role=menuitem], ' +
    '[role=menuitemradio], [role=menuitemcheckbox], [role=option], [role=switch], [role=checkbox], [role=radio], [role=slider], ' +
    '[role=link], [role=treeitem], [tabindex]:not([tabindex="-1"]), [contenteditable=""], [contenteditable="true"]';
  const cache = new Map();
  const cs = (el) => { let s = cache.get(el); if (!s) { s = getComputedStyle(el); cache.set(el, s); } return s; };
  const R = (r) => ({ l: r.left, t: r.top, r: r.right, b: r.bottom });
  const inter = (a, b) => { const l = Math.max(a.l, b.l), t = Math.max(a.t, b.t), r = Math.min(a.r, b.r), bb = Math.min(a.b, b.b); return r > l && bb > t ? { l, t, r, b: bb } : null; };
  const area = (a) => (a ? (a.r - a.l) * (a.b - a.t) : 0);
  const rnd = (a) => (a ? { l: Math.round(a.l * 10) / 10, t: Math.round(a.t * 10) / 10, r: Math.round(a.r * 10) / 10, b: Math.round(a.b * 10) / 10 } : null);
  const alpha = (c) => { if (!c || c === 'transparent') return 0; const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return 1; const p = m[1].split(/[ ,/]+/).filter(Boolean); return p.length > 3 ? parseFloat(p[3]) : 1; };
  const contains = (a, b) => a === b || (a.nodeType === 1 && a.contains(b));

  const SKIP_CLASS = /^(is-|has-)|^(on|off|open|shut|sel|selected|active|hover|focus|focused|armed|hot|lit|cur|current|pressed|show|shown|hidden|visible|in|out|enter|leave|busy|done)$/;
  function short(el) {
    let s = el.tagName.toLowerCase();
    if (el.id && !/^\d/.test(el.id)) return s + '#' + el.id;
    const c = [...el.classList].filter((x) => !SKIP_CLASS.test(x)).slice(0, 2);
    if (c.length) s += '.' + c.join('.');
    for (const a of ['data-id', 'data-k', 'data-act', 'data-mode', 'data-section', 'data-page', 'data-tab', 'data-view', 'name', 'type']) {
      const v = el.getAttribute(a);
      if (v && !(a === 'type' && el.tagName !== 'INPUT')) { s += '[' + a + '="' + v.slice(0, 32) + '"]'; break; }
    }
    return s;
  }
  function desc(el) {
    if (!el || el.nodeType !== 1) return '?';
    const parts = [short(el)];
    if (!el.id) for (let a = el.parentElement, n = 0; a && a !== document.body && a !== document.documentElement && n < 2; a = a.parentElement, n++) {
      parts.unshift(short(a));
      if (a.id) break;
    }
    return parts.join(' > ');
  }
  function label(el) {
    const t = el.getAttribute('aria-label') || el.getAttribute('title') || (el.textContent || '').replace(/\s+/g, ' ').trim();
    return t.slice(0, 40);
  }

  /* ---- what clips an element: walk up with the containing-block rules (absolute escapes static
     ancestors, fixed escapes all but transformed ones). Returns the visible region and the clippers. */
  function posMode(s) { return s.position === 'fixed' ? 'fixed' : s.position === 'absolute' ? 'absolute' : 'flow'; }
  function clipInfo(el) {
    let c = { l: 0, t: 0, r: VW, b: VH };
    const clippers = [];
    let mode = posMode(cs(el));
    for (let a = el.parentElement; a; a = a.parentElement) {
      const s = cs(a);
      const transformed = s.transform !== 'none' || s.filter !== 'none' || /paint|layout|strict|content/.test(s.contain || '');
      let applies = true;
      if (mode === 'fixed') applies = transformed;
      else if (mode === 'absolute') applies = s.position !== 'static' || transformed;
      if (applies && a !== document.documentElement && (s.overflowX !== 'visible' || s.overflowY !== 'visible')) {
        const b = a.getBoundingClientRect();
        const pb = { l: b.left + a.clientLeft, t: b.top + a.clientTop, r: b.left + a.clientLeft + a.clientWidth, b: b.top + a.clientTop + a.clientHeight };
        const scroll = /auto|scroll/.test(s.overflowX + ' ' + s.overflowY) && (a.scrollHeight > a.clientHeight + 1 || a.scrollWidth > a.clientWidth + 1 || /scroll|auto/.test(s.overflowY));
        const box = { l: s.overflowX !== 'visible' ? pb.l : -1e6, r: s.overflowX !== 'visible' ? pb.r : 1e6, t: s.overflowY !== 'visible' ? pb.t : -1e6, b: s.overflowY !== 'visible' ? pb.b : 1e6 };
        clippers.push({ el: a, box, scroll, x: s.overflowX !== 'visible', y: s.overflowY !== 'visible' });
        c = { l: Math.max(c.l, box.l), t: Math.max(c.t, box.t), r: Math.min(c.r, box.r), b: Math.min(c.b, box.b) };
      }
      if (applies) { const m = posMode(s); mode = m === 'flow' ? (mode === 'fixed' && !transformed ? 'fixed' : 'flow') : m; }
    }
    return { clip: c, clippers };
  }
  function shown(el) {
    if (!el.getClientRects().length) return null;
    // inside a closed <details> (content-visibility: hidden) or display:none: laid out, never painted
    if (el.checkVisibility && !el.checkVisibility()) return null;
    const s = cs(el);
    if ((s.clip && s.clip !== 'auto') || /inset\(50%/.test(s.clipPath)) return null;   // the sr-only pattern
    if (s.visibility !== 'visible' || s.display === 'contents') return null;
    let op = 1;
    for (let a = el; a; a = a.parentElement) op *= parseFloat(cs(a).opacity);
    if (op < 0.05) return null;
    const r = R(el.getBoundingClientRect());
    if (r.r - r.l < 0.5 || r.b - r.t < 0.5) return null;
    const ci = clipInfo(el);
    const v = inter(r, ci.clip);
    if (!v || area(v) < 1) return null;
    return { r, v, op, clip: ci.clip, clippers: ci.clippers };
  }
  /* a box a person sees as a box: a fill, a border, a shadow or live glass */
  function boxy(el) {
    const s = cs(el);
    return alpha(s.backgroundColor) > 0.04 || s.backgroundImage !== 'none' || s.boxShadow !== 'none' ||
      (parseFloat(s.borderTopWidth) > 0 && alpha(s.borderTopColor) > 0.04) || (parseFloat(s.borderLeftWidth) > 0 && alpha(s.borderLeftColor) > 0.04) ||
      (s.backdropFilter && s.backdropFilter !== 'none');
  }
  /* the surface something is painted on: the nearest ancestor-or-self with a solid-enough fill or live glass */
  function surfaceOf(el) {
    for (let a = el; a && a !== document.documentElement; a = a.parentElement) {
      const s = cs(a);
      if (alpha(s.backgroundColor) >= 0.35 || (s.backdropFilter && s.backdropFilter !== 'none')) return a;
    }
    return document.documentElement;
  }
  function container(el) {
    for (let a = el.parentElement; a && a !== document.body && a !== document.documentElement; a = a.parentElement) if (boxy(a)) return a;
    return null;
  }

  /* ---------------------------------------------------------------- interactive elements */
  const all = [...document.querySelectorAll('*')];
  const interactive = new Set(document.querySelectorAll(SEL));
  for (const el of all) {
    if (interactive.has(el)) continue;
    const s = cs(el);
    if (s.cursor === 'pointer' && el.parentElement && cs(el.parentElement).cursor !== 'pointer' && el.tagName !== 'LABEL') interactive.add(el);
  }
  for (const el of document.querySelectorAll('[data-ovn]')) el.removeAttribute('data-ovn');
  const items = [];
  const itemOf = new Map();
  const tagged = new Map();   // element -> ovn
  const tag = (el) => { if (!tagged.has(el)) tagged.set(el, -1); };
  for (const el of all) {
    if (!interactive.has(el)) continue;
    if (el.closest('svg') && el.tagName.toLowerCase() !== 'svg') continue;
    if (el.disabled && el.tagName === 'INPUT' && el.type !== 'range') { /* still a target, still measured */ }
    const sh = shown(el);
    if (!sh) continue;
    // an interactive element inside another interactive element that is the same box is the same control
    items.push({ el, sh });
    tag(el);
    for (let a = el.parentElement; a; a = a.parentElement) tag(a);
  }
  // ovn numbers in document order, so CDP's querySelectorAll('[data-ovn]') returns them in the same order
  let n = 0;
  for (const el of all) if (tagged.has(el)) { tagged.set(el, n); el.setAttribute('data-ovn', String(n)); n++; }

  /* the real hit box: scan out from the centre along both axes with elementFromPoint */
  const hitsEl = (el, x, y) => { if (x < 0 || y < 0 || x >= VW || y >= VH) return false; const t = document.elementFromPoint(x, y); return !!t && contains(el, t); };
  function hitBox(el, v) {
    let cx = (v.l + v.r) / 2, cy = (v.t + v.b) / 2;
    if (!hitsEl(el, cx, cy)) {
      let found = false;
      for (const [fx, fy] of [[0.25, 0.5], [0.75, 0.5], [0.5, 0.25], [0.5, 0.75], [0.2, 0.2], [0.8, 0.8]]) {
        const x = v.l + (v.r - v.l) * fx, y = v.t + (v.b - v.t) * fy;
        if (hitsEl(el, x, y)) { cx = x; cy = y; found = true; break; }
      }
      if (!found) return null;
    }
    /* each side: from the box edge, outward while it still hits (a pseudo-element hit area), or inward
       until it starts to (something covers the edge); never a pixel-by-pixel walk across the whole box */
    const REACH = 24;
    const side = (edge, dir, far, probeAt) => {
      let p = edge + (dir < 0 ? 0.5 : -0.5);
      if (probeAt(p)) { while (Math.abs(p - edge) < REACH && probeAt(p + dir)) p += dir; return p + (dir < 0 ? -0.5 : 0.5); }
      while ((dir < 0 ? p < far : p > far) && !probeAt(p)) p -= dir;
      return p + (dir < 0 ? -0.5 : 0.5);
    };
    const l = side(v.l, -1, cx, (x) => hitsEl(el, x, cy)), r = side(v.r, 1, cx, (x) => hitsEl(el, x, cy));
    const t = side(v.t, -1, cy, (y) => hitsEl(el, cx, y)), b = side(v.b, 1, cy, (y) => hitsEl(el, cx, y));
    return { l, t, r, b, cx, cy };
  }

  const findings = [];
  const add = (f) => findings.push(f);
  const out = [];
  const elOf = new Map();
  for (const it of items) {
    const el = it.el;
    const s = cs(el);
    const anc = [];
    for (let a = el.parentElement; a; a = a.parentElement) anc.push(tagged.get(a));
    const hb = hitBox(el, it.sh.v);
    const focusable = el.tabIndex >= 0 && !el.disabled && s.pointerEvents !== 'none' || el.matches('input:not([disabled]), select, textarea, a[href], button:not([disabled])');
    const rec = {
      ovn: tagged.get(el), desc: desc(el), label: label(el), tag: el.tagName.toLowerCase(),
      r: rnd(it.sh.r), v: rnd(it.sh.v), anc, parent: el.parentElement ? tagged.get(el.parentElement) : -1,
      hit: hb ? rnd(hb) : null, focusable: !!focusable, disabled: !!(el.disabled || el.getAttribute('aria-disabled') === 'true'),
    };
    out.push(rec);
    itemOf.set(el, rec);
    elOf.set(rec, el);
  }

  /* covered / hitbox-overlap: sample a grid inside each control */
  const recEls = items.map((x) => x.el);
  const interactiveAncestor = (t) => { for (let a = t; a; a = a.parentElement) if (itemOf.has(a)) return a; return null; };
  for (const it of items) {
    const el = it.el, rec = itemOf.get(el), v = it.sh.v;
    if (cs(el).pointerEvents === 'none') continue;
    let mine = 0, other = null, otherN = 0, blank = null, blankN = 0, total = 0;
    for (const fy of [0.2, 0.5, 0.8]) for (const fx of [0.12, 0.31, 0.5, 0.69, 0.88]) {
      const x = v.l + (v.r - v.l) * fx, y = v.t + (v.b - v.t) * fy;
      if (x < 0 || y < 0 || x >= VW || y >= VH) continue;
      total++;
      const t = document.elementFromPoint(x, y);
      if (!t) continue;
      if (contains(el, t)) { mine++; continue; }
      if (contains(t, el)) continue;            // an ancestor: this spot of el is pointer-events:none
      const ia = interactiveAncestor(t);
      if (ia && !contains(ia, el)) { other = ia; otherN++; continue; }
      // something unrelated on top: visible (a scrim, a popover) or invisible (a click thief)?
      let seen = false;
      for (let a = t; a && !contains(a, el); a = a.parentElement) if (boxy(a) || a.tagName === 'IMG' || a.tagName === 'svg' || a.tagName === 'CANVAS' || (a.childNodes.length && [...a.childNodes].some((c) => c.nodeType === 3 && c.textContent.trim()))) { seen = true; break; }
      if (!seen) { blank = t; blankN++; }
    }
    rec.hittable = mine > 0;
    if (other && otherN >= 1 && mine > 0) add({ kind: 'hitbox-overlap', el: rec.desc, label: rec.label, other: desc(other), otherLabel: label(other), box: rec.r, obox: rnd(R(other.getBoundingClientRect())), detail: otherN + ' of ' + total + ' sample points go to the other control' });
    if (blank && blankN >= 2) add({ kind: 'covered', el: rec.desc, label: rec.label, other: desc(blank), box: rec.r, obox: rnd(R(blank.getBoundingClientRect())), detail: blankN + ' of ' + total + ' points land on an invisible element' });
  }

  /* target size, with WCAG 2.5.8's spacing exception (a 24 px circle on each undersized target's centre
     may not touch another target or another undersized target's circle) */
  const targets = out.filter((r) => r.hit && r.hittable !== false);
  for (const r of targets) {
    const w = r.hit.r - r.hit.l, h = r.hit.b - r.hit.t;
    if (w >= MIN_TARGET - 0.5 && h >= MIN_TARGET - 0.5) continue;
    if ((r.v.r - r.v.l) < (r.r.r - r.r.l) - 1 || (r.v.b - r.v.t) < (r.r.b - r.r.t) - 1) continue;   // partly scrolled out of view
    const el = elOf.get(r);
    if (el.tagName === 'A' && cs(el).display === 'inline' && el.parentElement && /\S/.test((el.parentElement.textContent || '').replace(el.textContent, ''))) continue;   // a link inside a sentence: exempt
    if (el.tagName === 'INPUT' && /checkbox|radio/.test(el.type) && (el.closest('label') || (el.id && document.querySelector('label[for="' + el.id + '"]')))) continue;   // its label is the target
    const cx = (r.hit.l + r.hit.r) / 2, cy = (r.hit.t + r.hit.b) / 2;
    let clear = true, near = null;
    for (const o of targets) {
      if (o === r) continue;
      const oel = elOf.get(o);
      if (contains(oel, el) || contains(el, oel)) continue;
      const ow = o.hit.r - o.hit.l, oh = o.hit.b - o.hit.t;
      // the distance from this centre to the other target's box, or to its circle when it is undersized too
      const dx = Math.max(o.hit.l - cx, 0, cx - o.hit.r), dy = Math.max(o.hit.t - cy, 0, cy - o.hit.b);
      const toBox = Math.hypot(dx, dy);
      let hitIt = toBox < 12;
      if (!hitIt && (ow < MIN_TARGET || oh < MIN_TARGET)) { const ox = (o.hit.l + o.hit.r) / 2, oy = (o.hit.t + o.hit.b) / 2; hitIt = Math.hypot(ox - cx, oy - cy) < 24; }
      if (hitIt) { clear = false; near = o; break; }
    }
    add({ kind: clear ? 'target-small' : 'target-size', info: clear, el: r.desc, label: r.label, box: r.hit, detail: 'hit box ' + Math.round(w) + ' x ' + Math.round(h) + ' px' + (near ? ', ' + Math.round(Math.hypot(((near.hit.l + near.hit.r) / 2) - cx, ((near.hit.t + near.hit.b) / 2) - cy)) + ' px from ' + near.desc : '') });
  }

  /* ---------------------------------------------------------------- ink */
  const ink = [];
  const NO_TEXT = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'OPTION', 'SELECT', 'TEXTAREA', 'TITLE']);
  const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
  const blockOf = (el) => { for (let a = el; a; a = a.parentElement) { const d = cs(a).display; if (d !== 'inline' && d !== 'contents') return a; } return document.body; };
  const sheet = (el) => { for (let a = el; a && a !== document.documentElement; a = a.parentElement) { const s = cs(a); if (s.textOverflow === 'ellipsis' || (s.webkitLineClamp && s.webkitLineClamp !== 'none') || (s.webkitMaskImage && s.webkitMaskImage !== 'none') || (s.maskImage && s.maskImage !== 'none')) return a; if (a.tagName === 'BODY') break; } return null; };
  for (let tn = walker.nextNode(); tn; tn = walker.nextNode()) {
    if (!tn.textContent.trim()) continue;
    const p = tn.parentElement;
    if (!p || NO_TEXT.has(p.tagName) || p.closest('svg')) continue;
    const sh = shown(p);
    if (!sh) continue;
    const range = document.createRange();
    range.selectNodeContents(tn);
    const rects = [...range.getClientRects()].map(R).filter((x) => x.r - x.l > 0.5 && x.b - x.t > 0.5);
    if (!rects.length) continue;
    const U = rects.reduce((a, b) => ({ l: Math.min(a.l, b.l), t: Math.min(a.t, b.t), r: Math.max(a.r, b.r), b: Math.max(a.b, b.b) }));
    const text = tn.textContent.replace(/\s+/g, ' ').trim().slice(0, 40);
    // the text's own element clips it too (an ellipsis label): what shows is inside that box
    const ps = cs(p);
    let tclip = sh.clip;
    const clippers = sh.clippers.slice();
    if (ps.overflowX !== 'visible' || ps.overflowY !== 'visible') {
      const b = p.getBoundingClientRect();
      const pb = { l: b.left + p.clientLeft, t: b.top + p.clientTop, r: b.left + p.clientLeft + p.clientWidth, b: b.top + p.clientTop + p.clientHeight };
      tclip = inter(tclip, pb) || tclip;
      clippers.unshift({ el: p, box: pb, scroll: /auto|scroll/.test(ps.overflowX + ' ' + ps.overflowY), x: true, y: true });
    }
    const surf = surfaceOf(p);
    const fs = parseFloat(cs(p).fontSize) || 12;
    for (const x0 of rects.slice(0, 12)) {
      // the glyphs, not the font's content area: cap height to descender is about 0.2em in from the top
      // and 0.12em up from the bottom, so two lines set tight do not count as touching
      const x = { l: x0.l, r: x0.r, t: x0.t + 0.2 * fs, b: Math.max(x0.t + 0.2 * fs + 1, x0.b - 0.12 * fs) };
      const vis = inter(x, tclip);
      if (vis && area(vis) >= 1) ink.push({ kind: 'text', node: tn, owner: p, box: vis, raw: x, surf, text });
    }
    // text clipped by a box that does not scroll, with no ellipsis / clamp / fade to say so
    for (const c of clippers) {
      if (c.scroll) continue;
      const cb = c.box;
      const cw = Math.min(cb.r, 1e5) - Math.max(cb.l, -1e5), ch = Math.min(cb.b, 1e5) - Math.max(cb.t, -1e5);
      if (cw <= 2 || ch <= 2) break;                       // a visually-hidden (sr-only) box
      const iu = inter(U, cb);
      if (!iu) break;                                      // wholly outside: hidden on purpose (a collapsed panel)
      const cut = Math.max(cb.l - U.l, U.r - cb.r, (cb.t - U.t) - 2, (U.b - cb.b) - 2);
      if (cut > 1.5) {
        if (sheet(p)) break;
        add({ kind: 'text-clipped', el: desc(p), label: text, box: rnd(U), obox: rnd(cb), other: desc(c.el), detail: Math.round(cut) + ' px of "' + text + '" cut off by ' + desc(c.el) });
      }
      break;
    }
    // text running out of its own block box
    const blk = blockOf(p);
    if (blk && blk !== document.body) {
      const bb = R(blk.getBoundingClientRect());
      const over = Math.max(bb.l - U.l, U.r - bb.r);
      const overY = Math.max(bb.t - U.t, U.b - bb.b);
      const fsz = parseFloat(cs(p).fontSize) || 12;
      if ((over > 2 || overY > Math.max(4, 0.35 * fsz)) && !sheet(p) && cs(blk).overflowX === 'visible') add({ kind: 'text-spill', el: desc(blk), label: text, box: rnd(U), obox: rnd(bb), detail: '"' + text + '" runs ' + Math.round(Math.max(over, overY)) + ' px out of its box' });
    }
  }
  const GRAPHIC = 'svg, img, canvas, video, picture';
  for (const el of all) {
    let g = el.matches(GRAPHIC) && !(el.tagName.toLowerCase() === 'svg' && el.parentElement && el.parentElement.closest('svg'));
    if (!g) {
      const s = cs(el);
      const icon = (s.backgroundImage.includes('url(') || (s.webkitMaskImage && s.webkitMaskImage.includes('url(')) || (s.maskImage && s.maskImage.includes('url(')));
      if (icon && !el.children.length && !el.textContent.trim()) { const b = el.getBoundingClientRect(); g = b.width <= 64 && b.height <= 64; }
    }
    if (!g) continue;
    const sh = shown(el);
    if (!sh) continue;
    if (area(sh.v) > 0.3 * VW * VH || /backdrop|bdrop|wall|^frame$/i.test(el.id + ' ' + el.className.baseVal + ' ' + (typeof el.className === 'string' ? el.className : ''))) continue;
    ink.push({ kind: 'graphic', node: el, owner: el, box: sh.v, raw: sh.r, surf: surfaceOf(el.parentElement || el), text: '<' + el.tagName.toLowerCase() + '>' });
  }

  /* ink-overlap: on the same surface, two ink boxes intersect (2 px both ways and 15% of the smaller) */
  const reported = new Set();
  for (let i = 0; i < ink.length; i++) for (let j = i + 1; j < ink.length; j++) {
    const a = ink[i], b = ink[j];
    if (a.node === b.node || a.surf !== b.surf) continue;
    if (a.kind === 'graphic' && b.kind === 'graphic' && (contains(a.node, b.node) || contains(b.node, a.node))) continue;
    const x = inter(a.box, b.box);
    if (!x || x.r - x.l < 2 || x.b - x.t < 2) continue;
    if (area(x) < 0.15 * Math.min(area(a.box), area(b.box))) continue;
    // stacked text in one sentence (inline fragments of siblings) never overlaps by this much
    const ka = desc(a.owner) + '|' + a.text, kb = desc(b.owner) + '|' + b.text;
    const key = ka < kb ? ka + '#' + kb : kb + '#' + ka;
    if (reported.has(key)) continue;
    reported.add(key);
    add({ kind: 'ink-overlap', el: desc(a.owner), label: a.text, other: desc(b.owner), otherLabel: b.text, box: rnd(a.box), obox: rnd(b.box), detail: a.kind + ' "' + a.text + '" overlaps ' + b.kind + ' "' + b.text + '" by ' + Math.round(x.r - x.l) + ' x ' + Math.round(x.b - x.t) + ' px' });
  }

  /* box-overlap / sticks-out / outside-window over the visible boxes */
  const boxes = [];
  for (const el of all) {
    if (el === document.documentElement || el === document.body) continue;
    if (!boxy(el) && !itemOf.has(el)) continue;
    const sh = shown(el);
    if (!sh) continue;
    boxes.push({ el, sh, s: cs(el) });
  }
  const BIG = (r) => (r.r - r.l) >= VW * 0.9 && (r.b - r.t) >= VH * 0.9;
  for (const bx of boxes) {
    const { el, sh, s } = bx;
    if (BIG(sh.r)) continue;
    const inScroller = sh.clippers.some((c) => c.scroll);
    // past the window edge (and not inside something that scrolls, which would move it into view)
    if (!inScroller && s.position !== 'fixed') {
      const past = Math.max(-sh.r.l, -sh.r.t, sh.r.r - VW, sh.r.b - VH);
      if (past > 1.5 && area(inter(sh.r, { l: 0, t: 0, r: VW, b: VH })) > 0) add({ kind: 'outside-window', el: desc(el), label: label(el), box: rnd(sh.r), detail: Math.round(past) + ' px past the window edge' });
    }
    // crossing out of its visible container (and not clipped by it)
    const ct = container(el);
    if (ct) {
      const cr = R(ct.getBoundingClientRect());
      const clippedByCt = sh.clippers.some((c) => c.el === ct || ct.contains(c.el));   // cut by the container or by a box inside it (a scroller)
      const past = Math.max(cr.l - sh.r.l, cr.t - sh.r.t, sh.r.r - cr.r, sh.r.b - cr.b);
      if (past > 2 && !clippedByCt && !BIG(cr) && area(inter(sh.r, cr)) > 0) add({ kind: 'sticks-out', el: desc(el), label: label(el), other: desc(ct), box: rnd(sh.r), obox: rnd(cr), detail: Math.round(past) + ' px outside ' + desc(ct) + (s.position === 'absolute' ? ' (positioned)' : '') });
    }
  }
  // in-flow boxes overlapping each other inside the same parent surface
  const flow = boxes.filter((b) => b.s.position !== 'absolute' && b.s.position !== 'fixed' && !BIG(b.sh.r));
  for (const b of flow) b.surf = surfaceOf(b.el.parentElement || b.el);
  for (let i = 0; i < flow.length; i++) for (let j = i + 1; j < flow.length; j++) {
    const a = flow[i], b = flow[j];
    if (contains(a.el, b.el) || contains(b.el, a.el)) continue;
    const x = inter(a.sh.v, b.sh.v);
    if (!x || x.r - x.l < 2 || x.b - x.t < 2) continue;
    if (a.surf !== b.surf) continue;
    add({ kind: 'box-overlap', el: desc(a.el), label: label(a.el), other: desc(b.el), otherLabel: label(b.el), box: rnd(a.sh.r), obox: rnd(b.sh.r), detail: 'boxes overlap by ' + Math.round(x.r - x.l) + ' x ' + Math.round(x.b - x.t) + ' px' });
  }

  /* neighbours for the node-side hover/focus diff: every control and ink box near each control */
  const ctlChain = (el) => { const o = []; for (let a = el; a; a = a.parentElement) if (itemOf.has(a)) o.push(itemOf.get(a).ovn); return o; };
  const inkOut = ink.map((k) => ({ box: rnd(k.box), owner: tagged.has(k.owner) ? tagged.get(k.owner) : -1, ownerDesc: desc(k.owner), text: k.text, kind: k.kind,
    // ancestors of the ink's owner that are controls: hovering those may restyle this ink, that is not an overlap
    inside: ctlChain(k.owner) }));
  for (const f of findings) { f.desc = f.el; }
  return { vw: VW, vh: VH, dpr: devicePixelRatio, items: out, ink: inkOut, findings, nodes: n };
}
module.exports = { overlapProbe };

/* model.js — Mantle Files' pure logic: no DOM, no window.mantle, so node can test every rule here
 * (ui/files/model.test.js). Sorting, grouping, hiding, type labels, sizes and dates in words, the
 * address bar's crumbs and what a typed path means. The page (files.js, list.js, panes.js) and the
 * mock (mock-mantle.js) both use it, so the mock cannot drift from the page's idea of a path.
 *
 * Items are the sidecar's compact shape { n, d, s, m, c, a } (+ p for a search hit, + key/orig/del
 * for a Recycle Bin item). The page adds two private fields lazily: _k (the natural sort key) and
 * loc (the folder an item lives in, for the Location column).
 */
(function (root) {
  'use strict';
  const M = {};

  /* ---- paths ------------------------------------------------------------------------------------ */
  M.isVirtual = (p) => typeof p === 'string' && p.startsWith('mantle:');

  /** One spelling per folder, the same rules as main's lib/features/_files-core.js normPath. */
  M.normPath = function (p) {
    if (p == null) return null;
    let s = String(p).trim();
    if (s.length > 1 && s[0] === '"' && s[s.length - 1] === '"') s = s.slice(1, -1).trim();
    if (!s) return null;
    if (M.isVirtual(s)) return s;
    s = s.replace(/\//g, '\\');
    if (/^[a-zA-Z]:$/.test(s)) s += '\\';
    const unc = s.startsWith('\\\\');
    if (!unc && !/^[a-zA-Z]:\\/.test(s)) return null;
    if (unc && !/^\\\\[^\\]+\\[^\\]+/.test(s)) return null;
    const head = unc ? s.match(/^\\\\[^\\]+\\[^\\]+/)[0] : s.slice(0, 2).toUpperCase();
    const rest = s.slice(head.length).split('\\');
    const out = [];
    for (const seg of rest) {
      if (!seg || seg === '.') continue;
      if (seg === '..') { out.pop(); continue; }
      out.push(seg);
    }
    if (!out.length) return unc ? head : head + '\\';
    return head + '\\' + out.join('\\');
  };

  M.isRoot = (p) => /^[a-zA-Z]:\\?$/.test(String(p || '')) || /^\\\\[^\\]+\\[^\\]+\\?$/.test(String(p || ''));
  M.joinPath = (dir, name) => (String(dir).endsWith('\\') ? dir + name : dir + '\\' + name);
  M.baseName = function (p) {
    const s = String(p || '').replace(/\\+$/, '');
    const i = s.lastIndexOf('\\');
    return i >= 0 ? s.slice(i + 1) : s;
  };
  M.parentOf = function (p) {
    const n = M.normPath(p);
    if (!n || M.isVirtual(n) || M.isRoot(n)) return null;
    const i = n.lastIndexOf('\\');
    const up = n.slice(0, i);
    return M.normPath(/^[a-zA-Z]:$/.test(up) ? up + '\\' : up);
  };
  M.samePath = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();

  /** The address bar's crumbs, the same shape main's files.list answers ({label, path}). */
  M.crumbs = function (p, names) {
    const n = M.normPath(p);
    const nm = names || {};
    if (!n) return [];
    const V = { 'mantle:home': 'Home', 'mantle:thispc': 'This PC', 'mantle:recycle': 'Recycle Bin', 'mantle:network': 'Network' };
    if (V[n]) return [{ label: V[n], path: n }];
    const out = [];
    let rootP;
    let rest;
    if (n.startsWith('\\\\')) {
      const m = /^(\\\\[^\\]+\\[^\\]+)\\?(.*)$/.exec(n);
      rootP = m[1]; rest = m[2];
      out.push({ label: 'Network', path: 'mantle:network' });
      out.push({ label: nm[rootP.toLowerCase()] || rootP.slice(2), path: rootP });
    } else {
      rootP = n.slice(0, 3); rest = n.slice(3);
      out.push({ label: 'This PC', path: 'mantle:thispc' });
      out.push({ label: nm[rootP.toLowerCase()] || rootP.slice(0, 2), path: rootP });
    }
    let cur = rootP.endsWith('\\') ? rootP.slice(0, -1) : rootP;
    for (const seg of rest.split('\\').filter(Boolean)) {
      cur = cur + '\\' + seg;
      out.push({ label: nm[cur.toLowerCase()] || seg, path: cur });
    }
    return out;
  };

  /* What a typed address means. ctx = { cwd, home, known: {desktop: path, ...}, env: {NAME: value} }.
     Answers { ok:true, path } or { ok:false, reason } in plain words. %VAR% expands from ctx.env
     first, then from the home path (the page never reads the real environment). */
  const ALIAS = {
    home: 'mantle:home', 'quick access': 'mantle:home', 'this pc': 'mantle:thispc', computer: 'mantle:thispc', 'my computer': 'mantle:thispc',
    'recycle bin': 'mantle:recycle', 'shell:recyclebinfolder': 'mantle:recycle', network: 'mantle:network', 'shell:mycomputerfolder': 'mantle:thispc',
  };
  const KNOWN_WORDS = ['desktop', 'downloads', 'documents', 'pictures', 'music', 'videos', 'onedrive'];
  M.expandVars = function (s, ctx) {
    const home = ctx && ctx.home ? String(ctx.home).replace(/\\+$/, '') : null;
    const env = (ctx && ctx.env) || {};
    const known = (ctx && ctx.known) || {};
    let bad = null;
    const out = s.replace(/%([^%\\/]+)%/g, (all, name) => {
      const k = name.toUpperCase();
      for (const e of Object.keys(env)) if (e.toUpperCase() === k) return env[e];
      const fromHome = home ? {
        USERPROFILE: home, HOMEDRIVE: home.slice(0, 2), HOMEPATH: home.slice(2) || '\\', APPDATA: home + '\\AppData\\Roaming',
        LOCALAPPDATA: home + '\\AppData\\Local', TEMP: home + '\\AppData\\Local\\Temp', TMP: home + '\\AppData\\Local\\Temp',
      } : {};
      if (fromHome[k] !== undefined) return fromHome[k];
      const drive = home ? home.slice(0, 2) : 'C:';
      const fixed = {
        SYSTEMDRIVE: drive, SYSTEMROOT: drive + '\\Windows', WINDIR: drive + '\\Windows', PROGRAMFILES: drive + '\\Program Files',
        'PROGRAMFILES(X86)': drive + '\\Program Files (x86)', PROGRAMDATA: drive + '\\ProgramData', ALLUSERSPROFILE: drive + '\\ProgramData',
        PUBLIC: drive + '\\Users\\Public',
      };
      if (fixed[k] !== undefined) return fixed[k];
      if (k === 'ONEDRIVE' && known.onedrive) return known.onedrive;
      if (!bad) bad = name;
      return all;
    });
    return bad ? { ok: false, reason: `%${bad}% is not a variable Mantle Files knows` } : { ok: true, text: out };
  };

  M.resolveTyped = function (text, ctx) {
    const c = ctx || {};
    let s = String(text == null ? '' : text).trim();
    if (s.length > 1 && s[0] === '"' && s[s.length - 1] === '"') s = s.slice(1, -1).trim();
    if (!s) return { ok: false, reason: 'type a folder path, like C:\\Users' };
    const low = s.toLowerCase();
    if (ALIAS[low]) return { ok: true, path: ALIAS[low] };
    if (M.isVirtual(low)) return ['mantle:home', 'mantle:thispc', 'mantle:recycle', 'mantle:network'].includes(low) ? { ok: true, path: low } : { ok: false, reason: 'that is not a place Mantle Files knows' };
    const word = low.startsWith('shell:') ? low.slice(6) : low;
    if (KNOWN_WORDS.includes(word) || (low.startsWith('shell:') && word === 'profile')) {
      const k = word === 'profile' ? 'home' : word;
      const p = k === 'home' ? c.home : c.known && c.known[k];
      if (p) return { ok: true, path: M.normPath(p) };
      if (low.startsWith('shell:')) return { ok: false, reason: `this PC has no ${word} folder` };
    }
    if (low.startsWith('shell:')) return { ok: false, reason: 'that shell: location is not one Mantle Files opens' };
    const ex = M.expandVars(s, c);
    if (!ex.ok) return ex;
    s = ex.text.replace(/\//g, '\\');
    if (s === '~' || s.startsWith('~\\')) {
      if (!c.home) return { ok: false, reason: 'the home folder is not known yet' };
      s = String(c.home).replace(/\\+$/, '') + s.slice(1);
    }
    if (/^[a-zA-Z]:$/.test(s)) s += '\\';
    else if (/^[a-zA-Z]:[^\\]/.test(s)) s = s.slice(0, 2) + '\\' + s.slice(2);
    if (s.startsWith('\\\\')) {
      if (!/^\\\\[^\\]+\\[^\\]+/.test(s)) return { ok: false, reason: 'type a share too, like \\\\server\\share' };
    } else if (!/^[a-zA-Z]:\\/.test(s)) {
      if (!c.cwd || M.isVirtual(c.cwd)) return { ok: false, reason: 'type a full path, like C:\\Users' };
      s = M.joinPath(c.cwd, s);
    }
    const n = M.normPath(s);
    return n ? { ok: true, path: n } : { ok: false, reason: 'that is not a folder path (try C:\\ or \\\\server\\share)' };
  };

  /* ---- names -------------------------------------------------------------------------------------- */
  /** '.png' (lower case) for a file, '' for a folder or a name with no extension. '.gitignore' is its own extension, as in Windows. */
  M.extOf = function (name, isDir) {
    if (isDir) return '';
    const i = String(name).lastIndexOf('.');
    return i >= 0 && i < name.length - 1 ? name.slice(i).toLowerCase() : '';
  };
  /** How long the part before the extension is (F2 selects only that, like Explorer). */
  M.stemLength = function (name, isDir) {
    if (isDir) return name.length;
    const i = name.lastIndexOf('.');
    return i > 0 ? i : name.length;
  };
  M.displayName = (name, isDir, showExt) => (showExt || isDir ? name : name.slice(0, M.stemLength(name, false)));

  const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
  /** null when Windows would take the name, else why not (checked before asking main). */
  M.validName = function (name) {
    const s = String(name == null ? '' : name);
    if (!s.trim()) return 'a name cannot be empty';
    if (/[\\/:*?"<>|]/.test(s)) return 'a name cannot contain \\ / : * ? " < > |';
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x1f]/.test(s)) return 'a name cannot contain control characters';
    if (/[. ]$/.test(s)) return 'a name cannot end with a dot or a space';
    if (RESERVED.test(s.split('.')[0].trim())) return 'Windows keeps that name for itself';
    if (s.length > 255) return 'that name is longer than Windows allows (255)';
    return null;
  };

  /* ---- type labels -------------------------------------------------------------------------------- */
  M.typeOf = function (item, types) {
    const t = types || {};
    if (item.d) return t.folder || 'File folder';
    const e = M.extOf(item.n, false);
    if (!e) return 'File';
    return t[e] || e.slice(1).toUpperCase() + ' File';
  };

  /* ---- natural order -------------------------------------------------------------------------------- */
  /* A sort KEY instead of a comparator: Explorer's order (case-insensitive, digit runs by value,
     punctuation before digits before letters) turned into a string plain < can compare. Building
     10,000 keys once is cheaper than 130,000 Intl.Collator calls on every sort (measured in shoot.js). */
  const MAP = new Array(128);
  (function () {
    let rank = 1;
    for (let c = 0; c < 128; c++) {
      if ((c >= 48 && c <= 57) || (c >= 97 && c <= 122)) MAP[c] = String.fromCharCode(c);
      else if (c >= 65 && c <= 90) MAP[c] = String.fromCharCode(c + 32);
      else if (c >= 32) MAP[c] = String.fromCharCode(Math.min(47, rank++));
      else MAP[c] = '\u0001';
    }
  }());
  M.natKey = function (name) {
    const s = String(name);
    let out = '';
    let i = 0;
    while (i < s.length) {
      const c = s.charCodeAt(i);
      if (c >= 48 && c <= 57) {
        let j = i;
        while (j < s.length && s.charCodeAt(j) >= 48 && s.charCodeAt(j) <= 57) j++;
        let run = s.slice(i, j).replace(/^0+(?=\d)/, '');
        // '0' then the run's length as one char (longer number = bigger), then the digits
        out += '0' + String.fromCharCode(49 + Math.min(run.length, 40)) + run;
        i = j;
        continue;
      }
      out += c < 128 ? MAP[c] : s[i].toLowerCase();
      i++;
    }
    return out;
  };
  const keyOfName = (it) => (it._k !== undefined ? it._k : (it._k = M.natKey(it.n)));
  M.cmpName = function (a, b) {
    const x = keyOfName(a);
    const y = keyOfName(b);
    if (x !== y) return x < y ? -1 : 1;
    return a.n < b.n ? -1 : a.n > b.n ? 1 : 0;
  };

  /* ---- sorting ------------------------------------------------------------------------------------ */
  M.SORTS = ['name', 'date', 'type', 'size', 'created', 'deleted', 'location', 'status', 'match'];
  /** A new array, folders first in either direction, ties by name. spec = { sort, dir, types }. */
  M.sortItems = function (items, spec) {
    const sp = spec || {};
    const key = M.SORTS.includes(sp.sort) ? sp.sort : 'name';
    const sign = sp.dir === 'desc' ? -1 : 1;
    const arr = items.slice();
    for (let i = 0; i < arr.length; i++) keyOfName(arr[i]);
    let prim = null;
    if (key === 'date') prim = (it) => it.m || 0;
    else if (key === 'created') prim = (it) => it.c || 0;
    else if (key === 'deleted') prim = (it) => it.del || 0;
    else if (key === 'size') prim = (it) => it.s || 0;
    else if (key === 'type') {
      const memo = new Map();
      prim = (it) => {
        const e = it.d ? '/' : M.extOf(it.n, false);
        let v = memo.get(e);
        if (v === undefined) { v = M.typeOf(it, sp.types).toLowerCase(); memo.set(e, v); }
        return v;
      };
    } else if (key === 'location') prim = (it) => String(it.loc || '').toLowerCase();
    else if (key === 'status') prim = (it) => (M.syncState(it) || { rank: 9 }).rank;
    else if (key === 'match') prim = (it) => (it.hit === 'content' ? 1 : 0);
    if (prim) {
      // decorate once: a comparator that calls prim() 260,000 times costs more than the sort itself
      const dec = new Array(arr.length);
      for (let i = 0; i < arr.length; i++) dec[i] = { it: arr[i], v: prim(arr[i]), k: arr[i]._k, d: arr[i].d ? 1 : 0 };
      dec.sort((a, b) => {
        if (a.d !== b.d) return b.d - a.d;
        if (a.v !== b.v) return (a.v < b.v ? -1 : 1) * sign;
        if (a.k !== b.k) return a.k < b.k ? -1 : 1;
        return a.it.n < b.it.n ? -1 : a.it.n > b.it.n ? 1 : 0;
      });
      for (let i = 0; i < arr.length; i++) arr[i] = dec[i].it;
      return arr;
    }
    arr.sort((a, b) => {
      const ad = a.d ? 1 : 0;
      const bd = b.d ? 1 : 0;
      if (ad !== bd) return bd - ad;
      return M.cmpName(a, b) * sign;
    });
    return arr;
  };

  /* ---- hidden items ------------------------------------------------------------------------------ */
  M.isHidden = (it) => !!(it.a & 2);
  M.filterHidden = (items, show) => (show ? items : items.filter((it) => !(it.a & 2)));

  /* ---- grouping ------------------------------------------------------------------------------------ */
  M.GROUPS = ['none', 'type', 'date', 'size', 'letter'];
  const DAY = 86400000;
  /** Local-time boundaries for the date groups, newest first, the way Explorer names them. */
  M.dateBands = function (now) {
    const d = new Date(now);
    const today = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const tomorrow = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
    const week = new Date(d.getFullYear(), d.getMonth(), d.getDate() - d.getDay()).getTime();
    const month = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
    const lastMonth = new Date(d.getFullYear(), d.getMonth() - 1, 1).getTime();
    const year = new Date(d.getFullYear(), 0, 1).getTime();
    return [
      ['In the future', tomorrow], ['Today', today], ['Yesterday', today - DAY], ['Earlier this week', week], ['Last week', week - 7 * DAY],
      ['Earlier this month', month], ['Last month', lastMonth], ['Earlier this year', year], ['A long time ago', -Infinity],
    ];
  };
  M.dateGroup = function (t, bands) {
    for (let i = 0; i < bands.length; i++) if ((t || 0) >= bands[i][1]) return i;
    return bands.length - 1;
  };
  const SIZE_BANDS = [['Empty', 0], ['Tiny (under 16 KB)', 16 * 1024], ['Small (16 KB to 1 MB)', 1048576], ['Medium (1 to 128 MB)', 128 * 1048576],
    ['Large (128 MB to 1 GB)', 1073741824], ['Huge (1 to 4 GB)', 4 * 1073741824], ['Gigantic (over 4 GB)', Infinity]];
  M.sizeGroup = function (it) {
    if (it.d) return { rank: -1, label: 'Folders' };
    const s = it.s || 0;
    if (s === 0) return { rank: 0, label: SIZE_BANDS[0][0] };
    for (let i = 1; i < SIZE_BANDS.length; i++) if (s < SIZE_BANDS[i][1]) return { rank: i, label: SIZE_BANDS[i][0] };
    return { rank: SIZE_BANDS.length - 1, label: SIZE_BANDS[SIZE_BANDS.length - 1][0] };
  };
  M.letterGroup = function (it) {
    const ch = String(it.n).charAt(0);
    if (/[0-9]/.test(ch)) return { rank: '\u0001', label: '0–9' };
    const up = ch.toUpperCase();
    if (up !== ch.toLowerCase()) return { rank: up, label: up };
    return { rank: '\u0000', label: '#' };
  };

  /**
   * The whole "what does the list show" step: hide, sort, group.
   * spec = { sort, dir, group, showHidden, types, now, dateField }
   * -> { shown: [...items in display order], groups: [{label, start, count}] | null }
   * Items with _grp (Home's Pinned / Recent) always group by it, in _grank order.
   */
  M.arrange = function (items, spec) {
    const sp = spec || {};
    const visible = M.filterItems(M.filterHidden(items, !!sp.showHidden), sp.filter, sp.now);
    const sorted = M.sortItems(visible, sp);
    const sectioned = sorted.length && sorted[0]._grp !== undefined;
    const by = sectioned ? 'section' : M.GROUPS.includes(sp.group) ? sp.group : 'none';
    if (by === 'none') return { shown: sorted, groups: null };
    const bands = by === 'date' ? M.dateBands(sp.now || Date.now()) : null;
    const field = sp.dateField || 'm';
    const buckets = new Map();
    for (let i = 0; i < sorted.length; i++) {
      const it = sorted[i];
      let g;
      if (by === 'section') g = { rank: it._grank || 0, label: it._grp };
      else if (by === 'date') { const r = M.dateGroup(it[field], bands); g = { rank: r, label: bands[r][0] }; }
      else if (by === 'size') g = M.sizeGroup(it);
      else if (by === 'letter') g = M.letterGroup(it);
      else { const t = M.typeOf(it, sp.types); g = { rank: (it.d ? '\u0000' : '\u0001') + t.toLowerCase(), label: t }; }
      let b = buckets.get(g.label);
      if (!b) { b = { rank: g.rank, label: g.label, items: [] }; buckets.set(g.label, b); }
      b.items.push(it);
    }
    const list = [...buckets.values()].sort((a, b) => (a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0));
    const shown = [];
    const groups = [];
    for (const b of list) {
      groups.push({ label: b.label, start: shown.length, count: b.items.length });
      for (const it of b.items) shown.push(it);
    }
    return { shown, groups };
  };

  /* ---- words for numbers ---------------------------------------------------------------------------- */
  M.fmtCount = (n) => String(Math.round(n || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  M.fmtSize = function (b) {
    if (b == null || !isFinite(b)) return '';
    if (b < 1024) return b === 1 ? '1 byte' : `${M.fmtCount(b)} bytes`;
    const u = ['KB', 'MB', 'GB', 'TB', 'PB'];
    let v = b / 1024;
    let i = 0;
    while (v >= 1000 && i < u.length - 1) { v /= 1024; i++; }
    const s = v < 10 ? v.toFixed(1) : v < 100 ? v.toFixed(1) : String(Math.round(v));
    return `${s.replace(/\.0$/, '')} ${u[i]}`;
  };
  M.fmtBytes = (b) => `${M.fmtCount(b)} bytes`;
  M.fmtDate = function (ms) {
    if (!ms || !isFinite(ms) || ms <= 0) return '';
    const d = new Date(ms);
    let h = d.getHours();
    const ap = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()} ${h}:${mm} ${ap}`;
  };
  M.plural = (n, one, many) => `${M.fmtCount(n)} ${n === 1 ? one : many || one + 's'}`;

  /* ---- columns -------------------------------------------------------------------------------------- */
  M.COLS = {
    name: { label: 'Name', sort: 'name', w: 300, min: 120 },
    date: { label: 'Date modified', sort: 'date', w: 160, min: 70 },
    type: { label: 'Type', sort: 'type', w: 150, min: 60 },
    size: { label: 'Size', sort: 'size', w: 96, min: 50, right: true },
    created: { label: 'Date created', sort: 'created', w: 160, min: 70 },
    location: { label: 'Location', sort: 'location', w: 280, min: 80 },
    deleted: { label: 'Date deleted', sort: 'deleted', w: 160, min: 70 },
    status: { label: 'Status', sort: 'status', w: 150, min: 60 },
    match: { label: 'Match', sort: 'match', w: 340, min: 90 },
  };
  /** Which columns each kind of place offers, and its defaults. */
  M.COLSETS = {
    folder: { all: ['name', 'date', 'type', 'size', 'created', 'status'], def: ['name', 'date', 'type', 'size'] },
    cloud: { all: ['name', 'status', 'date', 'type', 'size', 'created'], def: ['name', 'status', 'date', 'type', 'size'] },
    search: { all: ['name', 'location', 'date', 'type', 'size', 'created'], def: ['name', 'location', 'date', 'size'] },
    searchc: { all: ['name', 'match', 'location', 'date', 'type', 'size'], def: ['name', 'match', 'location', 'date'] },
    recycle: { all: ['name', 'location', 'deleted', 'size', 'type', 'date'], def: ['name', 'location', 'deleted', 'size', 'type'] },
    home: { all: ['name', 'location', 'date'], def: ['name', 'location', 'date'] },
  };
  M.colLabel = (id, kind) => (id === 'location' && kind === 'recycle' ? 'Original location' : (M.COLS[id] || { label: id }).label);
  /** ['name:280', 'date', ...] -> [{id, w}]; unknown ids dropped, Name always first. */
  M.parseCols = function (cols, kind) {
    const set = M.COLSETS[kind] || M.COLSETS.folder;
    const out = [];
    for (const c of Array.isArray(cols) ? cols : []) {
      const [id, w] = String(c).split(':');
      if (!set.all.includes(id) || out.some((x) => x.id === id)) continue;
      const def = M.COLS[id];
      out.push({ id, w: Math.max(def.min, Math.min(1200, Number(w) || def.w)) });
    }
    if (!out.length) for (const id of set.def) out.push({ id, w: M.COLS[id].w });
    const ni = out.findIndex((x) => x.id === 'name');
    if (ni < 0) out.unshift({ id: 'name', w: M.COLS.name.w });
    else if (ni > 0) out.unshift(out.splice(ni, 1)[0]);
    return out;
  };
  M.encodeCols = (cols) => cols.map((c) => `${c.id}:${Math.round(c.w)}`);

  /* ---- filters: kind, date modified, size (search options, and any folder) ------------------------- */
  const KIND_EXTS = {
    document: '.txt .md .rtf .doc .docx .docm .odt .pdf .xls .xlsx .xlsm .ods .csv .tsv .ppt .pptx .odp .pages .numbers .key .epub .one .xps .log .tex',
    picture: '.png .jpg .jpeg .gif .bmp .webp .heic .heif .tif .tiff .ico .svg .psd .raw .cr2 .nef .dng .avif .jfif',
    video: '.mp4 .mkv .mov .avi .wmv .webm .m4v .mpg .mpeg .flv .3gp .ts',
    music: '.mp3 .wav .flac .aac .m4a .ogg .opus .wma .aiff .mid .midi',
    archive: '.zip .7z .rar .gz .tgz .bz2 .xz .zst .tar .cab .iso',
    program: '.exe .msi .bat .cmd .ps1 .lnk .appx .msix .com .scr .vbs',
    code: '.js .mjs .cjs .ts .tsx .jsx .json .py .cs .c .h .cpp .hpp .java .go .rs .rb .php .html .htm .css .scss .xml .yml .yaml .toml .ini .sh .sql .lua .kt .swift',
  };
  const EXT_KIND = new Map();
  for (const k of Object.keys(KIND_EXTS)) for (const e of KIND_EXTS[k].split(' ')) EXT_KIND.set(e, k);
  M.KINDS = [['folder', 'Folders'], ['document', 'Documents'], ['picture', 'Pictures'], ['video', 'Videos'], ['music', 'Music'],
    ['archive', 'Archives'], ['program', 'Programs'], ['code', 'Code'], ['other', 'Everything else']];
  M.kindOf = (it) => (it.d ? 'folder' : EXT_KIND.get(M.extOf(it.n, false)) || 'other');
  M.DATE_FILTERS = [['today', 'Today'], ['week', 'Last 7 days'], ['month', 'Last 30 days'], ['year', 'Last 12 months'], ['older', 'Older than a year']];
  M.SIZE_FILTERS = [['empty', 'Empty (0 KB)'], ['tiny', 'Tiny (under 16 KB)'], ['small', 'Small (16 KB to 1 MB)'], ['medium', 'Medium (1 to 128 MB)'],
    ['large', 'Large (128 MB to 1 GB)'], ['huge', 'Huge (over 1 GB)']];
  const SIZE_RANGE = { empty: [0, 0], tiny: [1, 16 * 1024 - 1], small: [16 * 1024, 1048576 - 1], medium: [1048576, 128 * 1048576 - 1],
    large: [128 * 1048576, 1073741824 - 1], huge: [1073741824, Infinity] };
  M.filterActive = (f) => !!(f && ((f.kind && f.kind.length) || f.date || f.size));
  /** Keep what passes every set filter. f = { kind:[keys]|null, date:key|null, size:key|null }. A size
   *  filter drops folders (a folder has no size here), as Explorer's does. */
  M.filterItems = function (items, f, now) {
    if (!M.filterActive(f)) return items;
    const kinds = f.kind && f.kind.length ? new Set(f.kind) : null;
    const t = now || Date.now();
    const day0 = new Date(t); day0.setHours(0, 0, 0, 0);
    const since = { today: day0.getTime(), week: t - 7 * 864e5, month: t - 30 * 864e5, year: t - 365 * 864e5 }[f.date];
    const range = f.size ? SIZE_RANGE[f.size] : null;
    return items.filter((it) => {
      if (kinds && !kinds.has(M.kindOf(it))) return false;
      if (f.date === 'older') { if ((it.m || 0) >= t - 365 * 864e5) return false; } else if (since !== undefined && (it.m || 0) < since) return false;
      if (range) { if (it.d) return false; const s = it.s || 0; if (s < range[0] || s > range[1]) return false; }
      return true;
    });
  };
  /** 'Pictures, Videos · Last 7 days · Large' for the filter bar; '' when nothing is set. */
  M.filterWords = function (f) {
    if (!M.filterActive(f)) return '';
    const lab = (list, k) => (list.find((x) => x[0] === k) || [k, k])[1];
    const out = [];
    if (f.kind && f.kind.length) out.push(f.kind.map((k) => lab(M.KINDS, k)).join(', '));
    if (f.date) out.push(lab(M.DATE_FILTERS, f.date));
    if (f.size) out.push(lab(M.SIZE_FILTERS, f.size).replace(/ \(.*\)$/, ''));
    return out.join(' · ');
  };

  /* ---- OneDrive (any cloud files provider) status, from the item's attributes --------------------- */
  const A_OFFLINE = 0x1000, A_PINNED = 0x80000, A_UNPINNED = 0x100000, A_RECALL_OPEN = 0x40000, A_RECALL_ACCESS = 0x400000;
  /** null outside a cloud folder's placeholder world; else { key, label, rank }. */
  M.syncState = function (it) {
    const a = it.a || 0;
    if (a & A_PINNED) return { key: 'pinned', label: 'Always on this device', rank: 0 };
    if (a & (A_RECALL_ACCESS | A_RECALL_OPEN | A_OFFLINE)) return { key: 'cloud', label: 'Online only', rank: 2 };
    if (a & A_UNPINNED) return { key: 'cloud', label: 'Online only', rank: 2 };
    return it.cloud ? { key: 'local', label: 'On this device', rank: 1 } : null;
  };

  /* ---- rename many ---------------------------------------------------------------------------------- */
  /**
   * items: [{n, d}] in display order; spec: { mode:'number'|'replace', base, start, find, replace,
   * regex, matchCase, ext:'keep'|'lower'|'upper' }; taken: every name in the folder (to catch clashes).
   * -> { rows: [{ from, to, why }], ok: bool, changed: n, why } . Numbering is Explorer's "Base (1)",
   * "Base (2)"...; replace changes the stem only unless the find text spans the dot.
   */
  M.renamePlan = function (items, spec, taken) {
    const sp = spec || {};
    const rows = [];
    let re = null;
    if (sp.mode === 'replace') {
      if (!sp.find) return { rows: items.map((it) => ({ from: it.n, to: it.n, why: null })), ok: false, changed: 0, why: 'type what to find' };
      try {
        re = new RegExp(sp.regex ? sp.find : sp.find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), sp.matchCase ? 'g' : 'gi');
      } catch (e) { return { rows: [], ok: false, changed: 0, why: `that pattern is not valid (${e.message})` }; }
    }
    const start = Number.isFinite(Number(sp.start)) ? Math.max(0, Math.floor(Number(sp.start))) : 1;
    items.forEach((it, i) => {
      const ext = it.d ? '' : M.extOf(it.n, false) ? it.n.slice(M.stemLength(it.n, false)) : '';
      const stem = it.n.slice(0, it.n.length - ext.length);
      let to;
      if (sp.mode === 'number') to = `${String(sp.base || '').trim() || stem} (${start + i})${ext}`;
      else to = sp.regex ? it.n.replace(re, sp.replace || '') : stem.replace(re, sp.replace || '') + ext;
      if (sp.ext === 'lower' && !it.d) to = to.slice(0, to.length - ext.length) + ext.toLowerCase();
      else if (sp.ext === 'upper' && !it.d) to = to.slice(0, to.length - ext.length) + ext.toUpperCase();
      rows.push({ from: it.n, to, why: null });
    });
    const mine = new Set(items.map((it) => it.n.toLowerCase()));
    const others = new Set([...(taken || [])].map((n) => String(n).toLowerCase()).filter((n) => !mine.has(n)));
    const seen = new Map();
    for (const r of rows) {
      const k = r.to.toLowerCase();
      if (r.to === r.from) continue;
      r.why = M.validName(r.to);
      if (!r.why && others.has(k)) r.why = 'another item already has this name';
      if (!r.why && mine.has(k) && k !== r.from.toLowerCase()) r.why = 'another selected item has this name now';
      if (!r.why && seen.has(k)) r.why = 'two items would get this name';
      seen.set(k, true);
    }
    const changed = rows.filter((r) => r.to !== r.from).length;
    const bad = rows.filter((r) => r.why).length;
    return { rows, ok: changed > 0 && bad === 0, changed, why: bad ? `${M.plural(bad, 'name')} cannot be used` : changed ? null : 'nothing would change' };
  };

  /* ---- odds and ends ------------------------------------------------------------------------------- */
  /** Type-ahead: the next item (from `from`, wrapping) whose shown name starts with text. */
  M.findTypeAhead = function (shown, text, from, nameOf) {
    const t = String(text || '').toLowerCase();
    if (!t || !shown.length) return -1;
    const n = shown.length;
    const start = Math.max(0, from || 0);
    for (let k = 0; k < n; k++) {
      const i = (start + k) % n;
      const nm = (nameOf ? nameOf(shown[i]) : shown[i].n).toLowerCase();
      if (nm.startsWith(t)) return i;
    }
    return -1;
  };
  M.summarize = function (items) {
    let files = 0;
    let dirs = 0;
    let bytes = 0;
    for (const it of items) { if (it.d) dirs++; else { files++; bytes += it.s || 0; } }
    return { count: items.length, files, dirs, bytes };
  };
  M.thumbKey = (p, m, s, px) => `${String(p).toLowerCase()}|${m || 0}|${s || 0}|${px}`;
  const OP_WORDS = {
    copy: 'Copying', move: 'Moving', recycle: 'Moving to the Recycle Bin', delete: 'Deleting', rename: 'Renaming', newfolder: 'Creating a folder',
    newfile: 'Creating a file', restore: 'Restoring', purge: 'Deleting for good', empty: 'Emptying the Recycle Bin', zip: 'Compressing', unzip: 'Extracting',
  };
  M.opWords = (op) => OP_WORDS[op] || 'Working';
  /* ---- errors in plain words (contract 3: the ONE place a reason becomes screen text) -------------- */
  /* The sidecar says "<words> (0xHHHHHHHH)" (the hex is for the call log) and node can say ENOENT.
     Nothing on screen may show a code or jargon, and every message says what to do next. Known codes
     and phrasings map to a written sentence; anything else keeps its words with the codes stripped. */
  const PLAIN = [
    [/0x80070005|\bEACCES\b|\bEPERM\b|access (is )?denied|permission denied/i, 'Windows did not allow this. It may need administrator rights, or the item is protected.'],
    [/0x8007002[01]|\bEBUSY\b|sharing violation|being used by another process|\bin use\b|open in another (app|program)|locked by/i, 'It is open in another app. Close it there, then try again.'],
    [/0x8007016a|0x8007017c|0x8007018[0-9a-f]|cloud file provider|cloud operation/i, 'This file is online-only and OneDrive is not running, so it cannot be downloaded. Start OneDrive, then try again.'],
    [/0x80070015|device is not ready|drive is not ready|\bnot ready\b/i, 'The drive is not ready. Insert the disk or reconnect the drive, then try again.'],
    [/0x80070070|0x80070027|\bENOSPC\b|not enough (disk )?space|disk is full/i, 'There is not enough free space. Free some space, then try again.'],
    [/0x80070035|0x80070043|0x800704cf|0x80070040|network (path|name) (was )?not found|network location cannot be reached|\bunreachable\b/i, 'The network location cannot be reached. Check the connection, then try again.'],
    [/0x800700ce|0x8007006f|\bENAMETOOLONG\b|(name|path) (is )?too long/i, 'The name or path is too long for Windows. Use a shorter name, or move it to a shorter folder.'],
    [/0x80070013|write[- ]protected/i, 'The drive is write-protected. Remove the protection, then try again.'],
    [/0x800700b7|0x80070050|\bEEXIST\b|already exists/i, 'An item with that name is already there. Pick another name.'],
    [/0x80070002|0x80070003|\bENOENT\b|cannot find the (file|path)|no such file|not there any more|does not exist|was not found/i, 'It is not there any more: it may have been moved or deleted. Press F5 to refresh.'],
    [/0x8007007b|0x800700a1|\bEINVAL\b|syntax is incorrect|invalid (file )?name/i, 'Windows does not allow that name. Try a different one.'],
    [/0x80070091|\bENOTEMPTY\b|directory is not empty/i, 'The folder is not empty, so it was left alone.'],
    [/0x80070570|corrupt(ed)? and unreadable/i, 'The disk reported damage here. Run a disk check on that drive, then try again.'],
    [/0x800704c7|operation was cancel+ed|^cancel+ed$/i, 'Cancelled.'],
    [/no (bridge|answer) (to|from) Mantle|\bsidecar\b|\bIPC\b|timed? ?out waiting/i, 'Mantle did not answer. Try again; if it keeps happening, restart Mantle.'],
  ];
  const cap1 = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
  /** Any reason (sidecar, main, node) -> one plain sentence with the next step. Empty -> "no answer". */
  M.plainReason = function (reason) {
    const raw = String(reason == null ? '' : reason).trim();
    if (!raw) return PLAIN[PLAIN.length - 1][1];
    for (const [re, words] of PLAIN) if (re.test(raw)) return words;
    let s = raw
      .replace(/\s*\(?\b0x[0-9a-f]{6,8}\b\)?/gi, '')              // (0x80004005)
      .replace(/\s*\(?(HRESULT|hr|code|errno)[ :=]*-?\d+\)?/gi, '')
      .replace(/\bWindows error\b[:\s]*/gi, '')
      .replace(/\b(E[A-Z]{3,12})\b:?\s*/g, (m, c) => (/^E(NO|ACC|PERM|BUSY|EXIST|INVAL|IO|AGAIN|ISDIR|NOTDIR|MFILE)/.test(c) ? '' : m))
      .replace(/\b(dry ?run|sidecar|job \w+|undefined|null|NaN|\[object Object\])\b/gi, '')
      .replace(/\s{2,}/g, ' ').replace(/\s+([.,:;])/g, '$1').trim().replace(/^[:,.;\s]+|[:,;\s]+$/g, '');
    if (!s) return 'Windows could not finish this and gave no reason. Try again.';
    s = cap1(s);
    return /[.!?]$/.test(s) ? s : s + '.';
  };
  /** Every failed item of an opdone, by name, with its reason in plain words: never "something failed". */
  M.failLines = function (results) {
    const out = [];
    for (const r of Array.isArray(results) ? results : []) {
      if (!r || r.ok !== false) continue;
      const name = M.baseName(r.src || r.dst || '') || 'an item';
      const why = r.why ? M.plainReason(r.why) : r.hr ? M.plainReason(`0x${(r.hr >>> 0).toString(16)}`) : 'It failed and Windows gave no reason. Try again.';
      out.push({ name, why });
    }
    return out;
  };
  /**
   * The conflict dialog's answer -> the files.op calls to make. items: the transfer's sources (paths or
   * {src}); conflicts: [{src}]; choice: { all } | { each: {src: 'replace'|'keepboth'|'skip'} }.
   * -> [{ conflict, items }] with no empty group: a skipped clash is left out, the items that clash with
   * nothing ride along with the first group (they are copied whatever the rule), and when every clash
   * is skipped they go alone under 'skip'.
   */
  M.conflictGroups = function (items, conflicts, choice) {
    const list = Array.isArray(items) ? items : [];
    if (!choice) return [];
    const src = (x) => String(typeof x === 'string' ? x : x && x.src).toLowerCase();
    // "Skip" for all: only what clashes with nothing goes; when that is nothing, there is nothing to do
    // (so the page can say "every item was skipped" instead of starting an empty copy)
    if (choice.all === 'skip') {
      const clash = new Set((conflicts || []).map(src));
      const rest = list.filter((x) => !clash.has(src(x)));
      return rest.length ? [{ conflict: 'skip', items: rest }] : [];
    }
    if (choice.all) return list.length ? [{ conflict: choice.all, items: list.slice() }] : [];
    const pick = {};
    for (const c of conflicts || []) pick[src(c)] = (choice.each || {})[c.src] || 'skip';
    const by = { keepboth: [], replace: [] };
    const free = [];
    for (const x of list) {
      const k = pick[src(x)];
      if (k === undefined) free.push(x);
      else if (by[k]) by[k].push(x);
    }
    const out = [];
    for (const k of ['keepboth', 'replace']) if (by[k].length) out.push({ conflict: k, items: by[k] });
    if (free.length) { if (out.length) out[0].items = free.concat(out[0].items); else out.push({ conflict: 'skip', items: free }); }
    return out;
  };
  /** Time left in words from what is done so far ('About 2 minutes left'); '' until it can be known. */
  M.timeLeft = function (done, total, ms) {
    if (!(total > 0) || !(done > 0) || !(ms > 1500) || done >= total) return '';
    const left = ((total - done) * ms) / done / 1000;
    if (left < 5) return 'A few seconds left';
    if (left < 60) return `About ${Math.max(5, Math.round(left / 5) * 5)} seconds left`;
    if (left < 3600) { const m = Math.round(left / 60); return `About ${m} minute${m === 1 ? '' : 's'} left`; }
    const h = Math.floor(left / 3600);
    const m = Math.round((left - h * 3600) / 60);
    return `About ${h} hour${h === 1 ? '' : 's'}${m ? ` ${m} minute${m === 1 ? '' : 's'}` : ''} left`;
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = M;
  else { root.MF = root.MF || {}; root.MF.model = M; }
}(typeof window !== 'undefined' ? window : this));

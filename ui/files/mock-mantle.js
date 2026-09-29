/* mock-mantle.js — plays main for the Mantle Files page when it is opened over file:// without
 * Electron (headless shots and perf, ui/files/shoot.js). The real preload.js defines window.mantle
 * first, so under Electron this file does nothing. EVERY name, folder, size and date here is MADE UP;
 * nothing reads a real disk.
 *
 * It behaves like main + the sidecar where the page can tell: listings STREAM (a first batch of 100
 * after a few ms, then ~1000-item batches every ~50 ms), search streams hits with `p`, thumbnails are
 * generated SVG data URLs answered after a short delay, operations send files.progress then
 * files.opdone and files.changed, and an item called "Locked report.docx" always fails with a reason.
 *
 * Query: path=<start folder>  glass=active|inactive  mock=nobridge
 * window.__mockCalls lists every call; window.__mockSlow = true makes operations take a minute.
 */
(function () {
  'use strict';
  if (window.mantle) return;
  const q = new URLSearchParams(location.search);
  const M = window.MF.model;
  /* The window's glass is Windows' acrylic, which no page can draw. The mock stands in for it: a soft
     blurred-wallpaper wash while active, Windows' flat inactive colour once the window blurs. */
  const GLASS = { active: 'linear-gradient(125deg, #c9d6ea 0%, #e6dcef 38%, #f1e3d6 62%, #cfe3dc 100%)', inactive: '#E9E9E9' };
  const root = document.documentElement;
  root.style.background = GLASS[q.get('glass') || 'active'] || GLASS.active;
  window.addEventListener('blur', () => { root.style.background = GLASS.inactive; });
  window.addEventListener('focus', () => { root.style.background = GLASS.active; });
  if (q.get('mock') === 'nobridge') return;

  const HOME = 'C:\\Users\\Robin';
  const NOW = Date.now();
  const DAY = 86400000;
  const KB = 1024;
  const MB = 1048576;
  const GB = 1073741824;
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const hash = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };
  const f = (n, s, daysAgo, a) => ({ n, d: 0, s: Math.round(s), m: NOW - daysAgo * DAY, c: NOW - (daysAgo + 20) * DAY, a: a == null ? 32 : a });
  const dir = (n, daysAgo, a) => ({ n, d: 1, s: 0, m: NOW - daysAgo * DAY, c: NOW - (daysAgo + 40) * DAY, a: a == null ? 16 : a });

  /* ---- the made-up disk ----------------------------------------------------------------------- */
  const FS = new Map();
  const put = (p, items) => FS.set(p.toLowerCase(), items);
  put(HOME, [dir('Desktop', 1), dir('Documents', 0.2), dir('Downloads', 0.1), dir('Music', 30), dir('Pictures', 2), dir('Videos', 12), dir('OneDrive', 5),
    dir('Big folder', 3), dir('AppData', 1, 16 | 2), f('NTUSER.DAT', 3 * MB, 0.1, 2 | 4 | 32), f('.gitconfig', 120, 90)]);
  put(HOME + '\\Documents', [
    dir('Budget 2026', 3), dir('Recipes', 44), dir('Taxes', 1), dir('Trip plans', 16), dir('Old projects', 400),
    f('Reading list.txt', 2.1 * KB, 0.05), f('Notes 2.txt', 900, 6), f('Notes 10.txt', 1.4 * KB, 6), f('Plan.docx', 48 * KB, 1), f('Invoice 0042.pdf', 210 * KB, 3),
    f('Garden layout.png', 1.2 * MB, 5), f('Quarterly numbers.xlsx', 88 * KB, 9), f('Slides draft.pptx', 3.4 * MB, 12), f('Old letters.zip', 14 * MB, 40),
    f('Locked report.docx', 64 * KB, 2), f('Tax scan.jpg', 2.2 * MB, 70), f('Bike manual.pdf', 5.8 * MB, 120), f('Packing list.md', 3 * KB, 0.4),
    f('Budget.csv', 18 * KB, 4), f('Song idea.mp3', 4.1 * MB, 20), f('Clip of the lake.mp4', 88 * MB, 25), f('config.json', 2 * KB, 8),
    f('desktop.ini', 282, 300, 2 | 4 | 32), f('.notes-cache', 12 * KB, 1, 2 | 32),
  ]);
  const PLACES = ['Harbor', 'Meadow', 'Ridge', 'Canyon', 'Lakeside', 'Old town', 'Pier', 'Forest', 'Dunes', 'Glacier', 'Orchard', 'Market'];
  const WHEN = ['at dusk', 'in fog', 'at noon', 'in spring', 'after rain', 'at dawn', 'in snow', 'at night'];
  const pics = [dir('Screenshots', 2), dir('Camera roll', 7)];
  for (let i = 0; i < 46; i++) pics.push(f(`${PLACES[i % PLACES.length]} ${WHEN[(i * 5) % WHEN.length]}${i > 11 ? ' ' + (i + 1) : ''}.${i % 7 === 3 ? 'png' : 'jpg'}`, (1 + rnd() * 5) * MB, i * 1.7));
  pics.push(f('Holiday clip.mp4', 240 * MB, 9), f('Scan of a map.pdf', 900 * KB, 60));
  put(HOME + '\\Pictures', pics);
  put(HOME + '\\Downloads', [f('setup-helper.exe', 42 * MB, 0.1), f('Plan.docx', 51 * KB, 0.3), f('Reading list.txt', 2.4 * KB, 0.3), f('Manual v3.pdf', 2.2 * MB, 2),
    f('fonts-pack.zip', 7.5 * MB, 3), f('Podcast episode 12.mp3', 61 * MB, 5), f('Demo video.mp4', 130 * MB, 8), f('photo-export.png', 3.1 * MB, 1), f('data dump.json', 640 * KB, 11), f('readme.md', 4 * KB, 11)]);
  put(HOME + '\\Desktop', [f('Notes.lnk', 1.2 * KB, 3), f('Shopping.txt', 300, 0.2), dir('Sort later', 4)]);
  put(HOME + '\\Desktop\\Sort later', []);                     // an empty folder, for the empty state
  const ADJ = ['Amber', 'Brisk', 'Calm', 'Dusty', 'Early', 'Faint', 'Gentle', 'Hollow', 'Ivory', 'Jolly', 'Keen', 'Lucky', 'Mellow', 'Noble', 'Olive', 'Plain', 'Quiet', 'Rapid', 'Silver', 'Tidy'];
  const NOUN = ['river', 'lantern', 'compass', 'harbor', 'meadow', 'pebble', 'canyon', 'orchard', 'ladder', 'kettle', 'island', 'garden', 'saddle', 'window', 'violin'];
  const EXTS = ['txt', 'jpg', 'png', 'pdf', 'docx', 'xlsx', 'zip', 'mp3', 'mp4', 'json', 'csv', 'md'];
  const big = [];
  for (let i = 0; i < 10000; i++) {
    if (i % 25 === 0) { big.push(dir(`${NOUN[i % NOUN.length]} batch ${i / 25 + 1}`, (i * 7) % 900)); continue; }
    big.push(f(`${ADJ[i % ADJ.length]} ${NOUN[(i * 7) % NOUN.length]} ${i}.${EXTS[(i * 3) % EXTS.length]}`, rnd() * 20 * MB, ((i * 37) % 1000) + rnd()));
  }
  put(HOME + '\\Big folder', big);
  function generated(p) {
    const h = hash(p.toLowerCase());
    const n = 6 + (h % 14);
    const out = [];
    for (let i = 0; i < n; i++) {
      const k = (h >>> (i % 16)) + i * 31;
      if (i < 2 + (h % 3)) out.push(dir(`${ADJ[k % ADJ.length]} ${NOUN[(k >> 3) % NOUN.length]}`, (k % 300) / 3));
      else out.push(f(`${NOUN[k % NOUN.length]} notes ${i}.${EXTS[k % EXTS.length]}`, (k % 5000) * KB, (k % 800) / 7));
    }
    return out;
  }
  function folder(p) {
    const k = p.toLowerCase();
    if (!FS.has(k)) FS.set(k, generated(p));
    return FS.get(k);
  }
  const itemAt = (p) => { const par = M.parentOf(p); if (!par) return null; const n = M.baseName(p).toLowerCase(); return folder(par).find((x) => x.n.toLowerCase() === n) || null; };

  const DRIVES = [
    { path: 'C:\\', label: 'Local Disk', fs: 'NTFS', type: 'fixed', total: 476 * GB, free: 118 * GB, ready: true, why: null },
    { path: 'D:\\', label: 'Data', fs: 'NTFS', type: 'fixed', total: 1863 * GB, free: 1104 * GB, ready: true, why: null },
    { path: 'E:\\', label: 'USB stick', fs: 'exFAT', type: 'removable', total: 29 * GB, free: 1.9 * GB, ready: true, why: null },
    { path: 'Z:\\', label: 'Team share', fs: '', type: 'network', total: 0, free: 0, ready: false, why: 'did not answer in 1.5 s' },
  ];
  const KNOWN = ['desktop', 'downloads', 'documents', 'pictures', 'music', 'videos', 'onedrive'].map((key) => ({ key, path: HOME + '\\' + key[0].toUpperCase() + key.slice(1).replace('drive', 'Drive') }));
  KNOWN.push({ key: 'home', path: HOME });
  const NETWORK = [{ label: 'Team share (nas)', path: '\\\\nas\\team' }, { label: 'Printer scans', path: '\\\\nas\\scans' }];
  const NAMES = { 'c:\\': 'Local Disk (C:)', 'd:\\': 'Data (D:)', 'e:\\': 'USB stick (E:)', 'z:\\': 'Team share (Z:)', [HOME.toLowerCase()]: 'Robin' };
  let pins = [HOME + '\\Documents\\Taxes', HOME + '\\Documents\\Budget 2026', 'D:\\Photo archive'];
  const pinRows = () => pins.map((p) => ({ path: p, label: M.baseName(p), d: 1, missing: false }));
  let bin = [
    { key: '$RA1B2C3.txt', n: 'Old shopping list.txt', orig: HOME + '\\Desktop', del: NOW - 0.2 * DAY, s: 1.1 * KB, d: 0 },
    { key: '$RD4E5F6', n: 'Temp exports', orig: HOME + '\\Documents', del: NOW - 1.2 * DAY, s: 0, d: 1 },
    { key: '$RG7H8I9.png', n: 'Blurry photo.png', orig: HOME + '\\Pictures', del: NOW - 3 * DAY, s: 2.6 * MB, d: 0 },
    { key: '$RJ1K2L3.docx', n: 'Draft 1.docx', orig: HOME + '\\Documents\\Taxes', del: NOW - 9 * DAY, s: 41 * KB, d: 0 },
    { key: '$RM4N5O6.zip', n: 'backup-old.zip', orig: 'D:\\Backups', del: NOW - 33 * DAY, s: 780 * MB, d: 0 },
    { key: '$RP7Q8R9.mp4', n: 'Screen recording.mp4', orig: HOME + '\\Videos', del: NOW - 60 * DAY, s: 312 * MB, d: 0 },
  ];
  const views = new Map();
  const options = { showHidden: false, showExtensions: true, defaultView: 'details', startIn: 'last', replaceExplorer: false };
  let clip = { paths: [], cut: false };
  const undo = [];

  /* ---- generated pictures: icons, thumbnails, previews --------------------------------------------- */
  const svgUrl = (s) => 'data:image/svg+xml,' + encodeURIComponent(s);
  const FAM = { doc: '#3B67B0', docx: '#3B67B0', xls: '#2E7A4E', xlsx: '#2E7A4E', csv: '#2E7A4E', ppt: '#B8552D', pptx: '#B8552D', pdf: '#B03A3A', zip: '#8A6A3A',
    mp3: '#9C4474', wav: '#9C4474', mp4: '#555C99', mkv: '#555C99', exe: '#475264', lnk: '#475264', json: '#2E6B78', md: '#5E6472', txt: '#5E6472', ini: '#5E6472', dat: '#5E6472' };
  function iconSvg(ext) {
    if (ext === 'folder') return svgUrl('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path d="M3 8a2 2 0 0 1 2-2h7l3 3h12a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" fill="#DDA93F"/><path d="M3 12.5a2 2 0 0 1 2-2h22a2 2 0 0 1 2 2V25a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" fill="#F2C75C"/></svg>');
    const e = ext.replace('.', '');
    if (['jpg', 'jpeg', 'png', 'gif'].includes(e)) return svgUrl('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect x="4" y="6" width="24" height="20" rx="2" fill="#fff" stroke="#8C95A8"/><circle cx="11" cy="12.5" r="2.2" fill="#E0A83C"/><path d="M6 23l6-6 4 4 4-5 6 7z" fill="#5E8FC7"/></svg>');
    const col = FAM[e] || '#6E7686';
    const label = (e || 'file').slice(0, 4).toUpperCase();
    return svgUrl(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path d="M8 3h11l6 6v19a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" fill="#fff" stroke="#8C95A8"/><path d="M19 3v6h6" fill="#EEF0F4" stroke="#8C95A8"/><rect x="3.5" y="16" width="19" height="8.5" rx="1.5" fill="${col}"/><text x="13" y="22.4" font-family="Segoe UI,Arial" font-size="5.6" font-weight="700" fill="#fff" text-anchor="middle">${label}</text></svg>`);
  }
  function photoSvg(name) {
    const h = hash(name);
    const hue = h % 360;
    const sky = `hsl(${hue},45%,72%)`;
    const sky2 = `hsl(${(hue + 40) % 360},50%,86%)`;
    const hill = `hsl(${(hue + 150) % 360},30%,42%)`;
    const hill2 = `hsl(${(hue + 170) % 360},28%,30%)`;
    const sx = 30 + (h % 100);
    const tall = h % 5 === 0;
    const W = tall ? 120 : 160;
    const H = tall ? 160 : 120;
    return svgUrl(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W * 4}" height="${H * 4}"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${sky}"/><stop offset="1" stop-color="${sky2}"/></linearGradient></defs><rect width="${W}" height="${H}" fill="url(#g)"/><circle cx="${sx % W}" cy="${H * 0.3}" r="${9 + (h % 8)}" fill="#FFF3D6" opacity=".9"/><path d="M0 ${H * 0.7} Q${W * 0.3} ${H * 0.45} ${W * 0.55} ${H * 0.68} T${W} ${H * 0.6} V${H} H0z" fill="${hill}"/><path d="M0 ${H * 0.85} Q${W * 0.4} ${H * 0.7} ${W} ${H * 0.82} V${H} H0z" fill="${hill2}"/></svg>`);
  }
  function videoSvg(name) {
    const h = hash(name);
    return svgUrl(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 90" width="640" height="360"><rect width="160" height="90" fill="hsl(${h % 360},25%,28%)"/><rect y="60" width="160" height="30" fill="hsl(${h % 360},20%,20%)"/><circle cx="80" cy="45" r="15" fill="rgba(255,255,255,.85)"/><path d="M75 37v16l13-8z" fill="#333"/></svg>`);
  }
  const IMG = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp']);
  const VID = new Set(['.mp4', '.mkv', '.mov', '.webm']);
  const TEXT = new Set(['.txt', '.md', '.json', '.csv', '.ini', '.log']);
  const TYPES = { '.txt': 'Text Document', '.md': 'Markdown File', '.json': 'JSON File', '.csv': 'Microsoft Excel Comma Separated Values File', '.docx': 'Microsoft Word Document',
    '.xlsx': 'Microsoft Excel Worksheet', '.pptx': 'Microsoft PowerPoint Presentation', '.pdf': 'PDF Document', '.png': 'PNG File', '.jpg': 'JPG File', '.zip': 'Compressed (zipped) Folder',
    '.mp3': 'MP3 File', '.mp4': 'MP4 File', '.exe': 'Application', '.lnk': 'Shortcut', '.ini': 'Configuration settings', '.dat': 'DAT File', folder: 'File folder' };

  /* ---- events ---------------------------------------------------------------------------------- */
  const handlers = {};
  const emit = (ev, p) => { for (const fn of handlers[ev] || []) fn(p); };
  let jobN = 0;
  const cancelled = new Set();
  function stream(ev, job, tab, items, extra) {
    const t0 = performance.now();
    let at = 0;
    const next = (first) => {
      if (cancelled.has(job)) return;
      const n = first ? 100 : 1000;
      const chunk = items.slice(at, at + n);
      at += chunk.length;
      const done = at >= items.length;
      emit(ev, Object.assign({ tab, job, items: chunk, done, count: done ? items.length : undefined, ms: done ? Math.round(performance.now() - t0) : undefined, error: null }, done ? extra || {} : {}));
      if (!done) setTimeout(next, 50);
    };
    if (window.__mockEarly) next(true); else setTimeout(() => next(true), 6);
  }
  const base = (p) => ({ ok: true, path: p, parent: M.parentOf(p), crumbs: M.crumbs(p, NAMES), view: views.get(p.toLowerCase()) || null });

  /* ---- operations: progress, then the outcome, then what changed ---------------------------------- */
  function runOp(op, spec) {
    const job = 'fo' + (++jobN);
    const items = spec.items || spec.keys || [];
    const steps = window.__mockSlow ? 600 : 4;
    const total = items.reduce((a, p) => { const it = typeof p === 'string' && !spec.keys ? itemAt(p) : null; return a + (it ? it.s || 4096 : 4096); }, 0) || 4096;
    let k = 0;
    const tick = () => {
      if (cancelled.has(job)) { emit('files.opdone', { job, op, ok: false, aborted: true, hr: 0, reason: 'cancelled', results: [], undoable: false, undoLabel: null, wasUndo: !!spec.undo }); return; }
      k++;
      const at = Math.min(items.length - 1, Math.floor((items.length * k) / steps));
      emit('files.progress', { job, op, done: Math.round((total * k) / steps), total, items: Math.min(items.length, Math.ceil((items.length * k) / steps)), itemsTotal: items.length, item: spec.keys ? null : M.baseName(String(items[Math.max(0, at)] || '')) });
      if (k < steps) { if (window.__mockEarly) tick(); else setTimeout(tick, window.__mockSlow ? 100 : 60); }
      else finish(job, op, spec);
    };
    // __mockEarly: every event lands BEFORE the call's reply, as real ones can (main relays sidecar
    // events synchronously while the reply waits on a promise). The page must not lose them.
    if (window.__mockEarly) tick(); else setTimeout(tick, 30);
    return job;
  }
  const uniqueIn = (dest, name) => {
    const list = folder(dest);
    if (!list.some((x) => x.n.toLowerCase() === name.toLowerCase())) return name;
    const i = name.lastIndexOf('.');
    const stem = i > 0 ? name.slice(0, i) : name;
    const ext = i > 0 ? name.slice(i) : '';
    for (let n = 2; ; n++) { const c = `${stem} (${n})${ext}`; if (!list.some((x) => x.n.toLowerCase() === c.toLowerCase())) return c; }
  };
  function finish(job, op, spec) {
    const results = [];
    const dirs = new Set();
    const removeFrom = (p) => { const par = M.parentOf(p); const list = folder(par); const i = list.findIndex((x) => x.n.toLowerCase() === M.baseName(p).toLowerCase()); if (i >= 0) return list.splice(i, 1)[0]; return null; };
    if (op === 'newfolder' || op === 'newfile') {
      const n = uniqueIn(spec.dest, spec.name);
      folder(spec.dest).push(op === 'newfolder' ? dir(n, 0) : f(n, 0, 0));
      results.push({ src: null, dst: M.joinPath(spec.dest, n), ok: true });
      dirs.add(spec.dest);
    } else if (op === 'restore' || op === 'purge') {
      for (const key of spec.keys) {
        const i = bin.findIndex((b) => b.key === key);
        if (i < 0) { results.push({ ok: false, why: 'it is no longer in the Recycle Bin', src: key }); continue; }
        const b = bin.splice(i, 1)[0];
        if (op === 'restore') { folder(b.orig).push(b.d ? dir(b.n, 0) : f(b.n, b.s, 0)); dirs.add(b.orig); }
        results.push({ src: M.joinPath(b.orig, b.n), dst: op === 'restore' ? M.joinPath(b.orig, b.n) : null, ok: true });
      }
    } else if (op === 'empty') {
      bin = [];
    } else {
      for (const src of spec.items) {
        const name = M.baseName(src);
        if (/locked/i.test(name)) { results.push({ src, ok: false, hr: -2147024864, why: 'The file is open in another program (Made-up Writer), so Windows cannot touch it. Close it and try again.' }); continue; }
        if (op === 'rename') {
          const it = itemAt(src);
          if (!it) { results.push({ src, ok: false, why: 'it is not there any more' }); continue; }
          it.n = spec.name;
          delete it._k;
          results.push({ src, dst: M.joinPath(M.parentOf(src), spec.name), ok: true });
          dirs.add(M.parentOf(src));
        } else if (op === 'recycle' || op === 'delete') {
          const it = removeFrom(src);
          const key = '$R' + (++jobN) + M.extOf(name, it && it.d);
          if (it && op === 'recycle') bin.unshift({ key, n: it.n, orig: M.parentOf(src), del: Date.now(), s: it.s, d: it.d });
          results.push({ src, ok: true, key: op === 'recycle' ? key : undefined });
          dirs.add(M.parentOf(src));
        } else if (op === 'copy' || op === 'move' || op === 'zip' || op === 'unzip') {
          const it = itemAt(src) || f(name, 1000, 0);
          const destDir = op === 'zip' || op === 'unzip' ? M.parentOf(spec.dest) : spec.dest;
          let n = op === 'zip' || op === 'unzip' ? M.baseName(spec.dest) : name;
          const clash = folder(destDir).some((x) => x.n.toLowerCase() === n.toLowerCase());
          if (clash && spec.conflict === 'skip') { results.push({ src, ok: true, skipped: true }); continue; }
          if (clash && spec.conflict === 'replace') removeFrom(M.joinPath(destDir, n));
          else if (clash) n = uniqueIn(destDir, n);
          if (op === 'move') removeFrom(src);
          folder(destDir).push(op === 'zip' ? f(n, 1.3 * MB, 0) : op === 'unzip' ? dir(n, 0) : Object.assign({}, it, { n, m: Date.now() }));
          results.push({ src, dst: M.joinPath(destDir, n), ok: true });
          dirs.add(destDir);
          if (op === 'move') dirs.add(M.parentOf(src));
          if (op === 'zip' || op === 'unzip') break;
        }
      }
    }
    const failN = results.filter((r) => r.ok === false).length;
    let undoLabel = null;
    if (!spec.undo && ['recycle', 'move', 'rename', 'copy', 'newfolder', 'newfile'].includes(op) && results.some((r) => r.ok)) {
      undoLabel = `${M.opWords(op).replace(/ing\b/, '').toLowerCase()} of ${M.plural(results.filter((r) => r.ok).length, 'item')}`.replace(/^mov /, 'move ').replace(/^cop /, 'copy ').replace(/^renam /, 'rename ').replace(/^creat /, 'create ');
      undo.push({ label: cap(undoLabel), op, results });
    }
    if (['recycle', 'restore', 'purge', 'delete', 'empty'].includes(op)) dirs.add('mantle:recycle');
    emit('files.opdone', { job, op, ok: failN === 0, hr: failN ? -2147024864 : 0, reason: failN ? `${failN} of ${results.length} items failed` : null, aborted: false, results,
      undoable: !!undoLabel, undoLabel: undoLabel ? cap(undoLabel) : null, wasUndo: !!spec.undo });
    emit('files.undo', { label: undo.length ? undo[undo.length - 1].label : null });
    emit('files.changed', { dirs: [...dirs] });
  }
  const cap = (s) => s[0].toUpperCase() + s.slice(1);
  function conflictsFor(items, dest) {
    const out = [];
    for (const src of items) {
      const it = itemAt(src) || f(M.baseName(src), 1000, 0);
      const there = folder(dest).find((x) => x.n.toLowerCase() === M.baseName(src).toLowerCase());
      if (there && !M.samePath(M.parentOf(src), dest)) out.push({ src, dst: M.joinPath(dest, there.n), d: it.d, s: it.s, m: it.m, dstS: there.s, dstM: there.m, dstD: there.d });
    }
    return out;
  }
  function transfer(paths, dest, op, conflict) {
    if (paths.every((p) => M.samePath(M.parentOf(p), dest)) && op === 'move') return { ok: true, started: false, reason: 'they are already in this folder' };
    const c = conflictsFor(paths, dest);
    if (c.length && !conflict) return { ok: true, started: false, needConflict: true, conflicts: c, op, items: paths, dest };
    return { ok: true, job: runOp(op, { items: paths, dest, conflict: conflict || 'keepboth' }), op, count: paths.length };
  }

  /* ---- the commands ------------------------------------------------------------------------------ */
  const later = (v, ms) => new Promise((res) => setTimeout(() => res(v), ms || 0));
  const dry = (what) => ({ ok: true, dryRun: true, reason: `test mode: ${what}` });
  const C = {
    boot: () => ({ ok: true, w: 1, path: M.normPath(q.get('path') || HOME + '\\Documents'), select: q.get('select') || null, options, test: false, sandbox: null, home: HOME,
      pins: pinRows(), undo: null, sep: '\\', notice: q.get('notice') || null, names: NAMES }),
    roots: () => ({ ok: true, known: KNOWN, drives: DRIVES, network: NETWORK, pins: pinRows() }),
    home: () => ({ ok: true, pins: pinRows(), recent: [
      { path: HOME + '\\Documents\\Plan.docx', n: 'Plan.docx', d: 0, m: NOW - 0.1 * DAY }, { path: HOME + '\\Downloads\\Manual v3.pdf', n: 'Manual v3.pdf', d: 0, m: NOW - 0.3 * DAY },
      { path: HOME + '\\Pictures\\Harbor at dusk.jpg', n: 'Harbor at dusk.jpg', d: 0, m: NOW - 1.1 * DAY }, { path: HOME + '\\Documents\\Trip plans', n: 'Trip plans', d: 1, m: NOW - 2 * DAY },
      { path: HOME + '\\Documents\\Quarterly numbers.xlsx', n: 'Quarterly numbers.xlsx', d: 0, m: NOW - 4 * DAY }, { path: 'D:\\Photo archive\\2019\\Beach.jpg', n: 'Beach.jpg', d: 0, m: NOW - 9 * DAY },
    ], recentWhy: null }),
    list: (a) => {
      const p = M.normPath(a.path);
      if (!p) return { ok: false, reason: 'that is not a folder path (try C:\\ or \\\\server\\share)' };
      if (p === 'mantle:thispc' || p === 'mantle:network') return Object.assign(base(p), { drives: DRIVES, known: KNOWN, network: NETWORK });
      if (p === 'mantle:recycle') return Object.assign(base(p), { recycle: bin.map((b) => Object.assign({}, b)), count: bin.length, bytes: bin.reduce((s, b) => s + (b.s || 0), 0) });
      if (p === 'mantle:home') return base(p);
      const job = 'fl' + (++jobN);
      if (/\\Private$/i.test(p)) { setTimeout(() => emit('files.items', { tab: a.tab, job, items: [], done: true, count: 0, ms: 2, error: 'access denied (0x80070005)' }), 5); return Object.assign(base(p), { job, watch: false }); }
      stream('files.items', job, a.tab, folder(p).slice(), {});
      return Object.assign(base(p), { job, watch: !p.startsWith('\\\\'), watchWhy: p.startsWith('\\\\') ? 'this network folder does not refresh by itself (no change notifications); press F5' : null });
    },
    search: (a) => {
      const p = M.normPath(a.path);
      const needle = String(a.query).toLowerCase();
      const job = 'fs' + (++jobN);
      const hits = [];
      const walk = (d, depth) => {
        for (const it of folder(d)) {
          if (it.n.toLowerCase().includes(needle)) hits.push(Object.assign({}, it, { p: M.joinPath(d, it.n) }));
          if (it.d && depth < 2 && !(it.a & 2)) walk(M.joinPath(d, it.n), depth + 1);
        }
      };
      walk(p, 0);
      stream('files.found', job, a.tab, hits, { capped: false, denied: 1 });
      return { ok: true, job };
    },
    cancel: (a) => { cancelled.add(a.job); return { ok: true, cancelled: true }; },
    icons: (a) => { const icons = {}; for (const e of a.exts || []) icons[e] = iconSvg(e); return later({ ok: true, icons }, 15); },
    types: (a) => { const types = {}; for (const e of a.exts || []) if (TYPES[e]) types[e] = TYPES[e]; return { ok: true, types }; },
    thumbs: (a) => later({ results: (a.items || []).map((it) => {
      const e = M.extOf(M.baseName(it.path), false);
      if (IMG.has(e)) return { path: it.path, url: photoSvg(M.baseName(it.path)), kind: 'thumb' };
      if (VID.has(e)) return { path: it.path, url: videoSvg(M.baseName(it.path)), kind: 'thumb' };
      return { path: it.path, url: iconSvg(e), kind: 'icon' };
    }) }, 40 + Math.round(rnd() * 60)),
    preview: (a) => {
      const it = itemAt(a.path);
      if (!it) return { kind: 'none', why: 'it cannot be read (ENOENT)' };
      if (it.d) return { kind: 'none', why: 'Folders have no preview; Properties (Alt+Enter) shows what is inside', folder: true };
      const e = M.extOf(it.n, false);
      if (IMG.has(e)) return { kind: 'image', url: photoSvg(it.n), size: it.s };
      if (TEXT.has(e)) {
        const lines = [`${it.n.replace(/\.[^.]+$/, '')}`, '', 'A made-up text file for the mock. Nothing here came from a real disk.', ''];
        for (let i = 1; i <= 60; i++) lines.push(`${String(i).padStart(2, ' ')}. line ${i} of the made-up notes: ${NOUN[i % NOUN.length]}, ${ADJ[i % ADJ.length].toLowerCase()} and ${WHEN[i % WHEN.length]}.`);
        return { kind: 'text', text: lines.join('\n'), encoding: 'utf8', truncated: it.s > 256 * KB, size: it.s };
      }
      return { kind: 'none', why: e === '.pdf' ? 'the mock has no PDF to show (the real app previews PDFs)' : 'no preview for this kind of file' };
    },
    stat: (a) => {
      const it = itemAt(a.path);
      if (!it) return M.isRoot(a.path) ? { ok: true, exists: true, n: a.path, d: 1, s: 0, m: NOW, c: NOW, acc: NOW, a: 16, type: 'Local Disk', target: null, location: null } : { ok: true, exists: false };
      return { ok: true, exists: true, n: it.n, d: it.d, s: it.s, m: it.m, c: it.c, acc: NOW - 0.01 * DAY, a: it.a, type: it.d ? 'File folder' : TYPES[M.extOf(it.n)] || 'File', target: M.extOf(it.n) === '.lnk' ? HOME + '\\Documents\\Plan.docx' : null, location: M.parentOf(a.path) };
    },
    size: (a) => {
      const job = 'fz' + (++jobN);
      const total = (hash(a.path) % 900) * MB;
      [0.3, 0.7, 1].forEach((frac, i) => setTimeout(() => emit('files.size', { job, bytes: Math.round(total * frac), files: Math.round(1200 * frac), dirs: Math.round(80 * frac), denied: frac === 1 ? 2 : 0, done: frac === 1, ms: 250 * (i + 1) }), 250 * (i + 1)));
      return { ok: true, job };
    },
    op: (a) => {
      if (a.op === 'delete' && !a.confirmed) return { ok: false, reason: 'a permanent delete needs the confirm first', refused: true };
      if (!['copy', 'move', 'recycle', 'delete', 'rename', 'newfolder', 'newfile'].includes(a.op)) return { ok: false, reason: 'unknown operation' };
      return { ok: true, job: runOp(a.op, { items: a.items || [], dest: a.dest, name: a.name, conflict: a.conflict }), op: a.op };
    },
    conflicts: (a) => ({ ok: true, conflicts: conflictsFor(a.items || [], a.dest) }),
    undo: () => {
      const top = undo.pop();
      if (!top) return { ok: false, reason: 'nothing to undo' };
      emit('files.undo', { label: undo.length ? undo[undo.length - 1].label : null });
      const job = 'fu' + (++jobN);
      setTimeout(() => {
        if (top.op === 'recycle') for (const r of top.results) { if (!r.key) continue; const i = bin.findIndex((b) => b.key === r.key); if (i >= 0) { const b = bin.splice(i, 1)[0]; folder(b.orig).push(b.d ? dir(b.n, 0) : f(b.n, b.s, 0)); } }
        emit('files.opdone', { job, op: 'restore', ok: true, hr: 0, reason: null, aborted: false, results: top.results.map((r) => ({ src: r.src, ok: true })), undoable: false, undoLabel: null, wasUndo: true });
        emit('files.changed', { dirs: [...new Set(top.results.filter((r) => r.src).map((r) => M.parentOf(r.src))), 'mantle:recycle'] });
      }, 200);
      return { ok: true, job, label: top.label };
    },
    clip: (a) => { clip = { paths: a.paths || [], cut: a.op === 'cut' }; emit('files.clip', { count: clip.paths.length, cut: clip.cut, paths: clip.paths }); return { ok: true, count: clip.paths.length, cut: clip.cut, internal: true }; },
    clipinfo: () => ({ ok: true, count: clip.paths.length, cut: clip.cut }),
    paste: (a) => {
      if (!clip.paths.length) return { ok: false, reason: 'the clipboard has no files' };
      const r = transfer(clip.paths, M.normPath(a.dest), clip.cut ? 'move' : 'copy', a.conflict);
      if (r.job && clip.cut) { clip = { paths: [], cut: false }; emit('files.clip', { count: 0, cut: false, paths: [] }); }
      return r;
    },
    drop: (a) => transfer(a.paths || [], M.normPath(a.dest), a.effect === 'move' ? 'move' : a.effect === 'copy' ? 'copy' : (String(a.paths[0])[0] || '').toUpperCase() === String(a.dest)[0].toUpperCase() ? 'move' : 'copy', a.conflict),
    drag: () => dry('an OS drag would start here'),
    open: () => dry('would open it in its app'),
    newwindow: () => dry('would open a new Mantle Files window'),
    win: (a) => dry(`would ${a.op} the window`),
    handlers: () => later({ ok: true, handlers: [{ handler: 'h1', name: 'Made-up Writer', icon: null }, { handler: 'h2', name: 'Notepad', icon: null }, { handler: 'h3', name: 'Made-up Viewer', icon: null }] }, 120),
    openwith: () => dry('would open it with that app'),
    openwithdialog: () => dry("would show Windows' Open with"),
    verbs: () => later({ ok: true, token: 't1', verbs: [
      { cmd: 1, label: 'Open', verb: 'open' }, { cmd: 2, label: 'Edit', verb: 'edit' }, { cmd: 3, label: 'Print', verb: 'print' }, { cmd: 4, label: 'Share', verb: 'Windows.ModernShare' },
      { cmd: 5, label: 'Scan with Made-up Antivirus', verb: '' },
      { cmd: 6, label: 'Send to', verb: '', sub: [{ cmd: 7, label: 'Compressed (zipped) folder', verb: '' }, { cmd: 8, label: 'Desktop (create shortcut)', verb: '' }, { cmd: 9, label: 'Mail recipient', verb: '' }] },
      { cmd: 10, label: 'Cut', verb: 'cut' }, { cmd: 11, label: 'Copy', verb: 'copy' }, { cmd: 12, label: 'Create shortcut', verb: 'link' }, { cmd: 13, label: 'Delete', verb: 'delete' },
      { cmd: 14, label: 'Rename', verb: 'rename' }, { cmd: 15, label: 'Copy as path', verb: 'copyaspath' }, { cmd: 16, label: 'Properties', verb: 'properties' }, { cmd: 17, label: 'Pin to Quick access', verb: 'pintohome' },
      { cmd: 18, label: 'Restore previous versions', verb: '' },
    ] }, 150),
    verb: () => dry('would run that Windows command'),
    copypath: (a) => ({ ok: true, text: (a.paths || []).map((p) => `"${p}"`).join('\n'), dryRun: true }),
    zip: (a) => {
      const items = a.items || [];
      if (!items.length) return { ok: false, reason: 'nothing selected to compress' };
      const dirp = M.parentOf(items[0]);
      const dest = M.joinPath(dirp, uniqueIn(dirp, (items.length === 1 ? M.baseName(items[0]).replace(/\.[^.]+$/, '') : 'Archive') + '.zip'));
      return { ok: true, job: runOp('zip', { items, dest }), dest };
    },
    unzip: (a) => {
      const dirp = M.parentOf(a.path);
      const dest = M.joinPath(dirp, uniqueIn(dirp, M.baseName(a.path).replace(/\.zip$/i, '')));
      return { ok: true, job: runOp('unzip', { items: [a.path], dest }), dest };
    },
    recycle: (a) => {
      if (a.op === 'empty') return a.confirmed ? { ok: true, job: runOp('empty', { keys: bin.map((b) => b.key) }) } : { ok: false, reason: 'emptying the Recycle Bin needs the confirm first' };
      if (a.op === 'purge' && !a.confirmed) return { ok: false, reason: 'a permanent delete needs the confirm first' };
      return { ok: true, job: runOp(a.op, { keys: a.keys || [] }) };
    },
    pin: (a) => {
      pins = pins.filter((p) => !M.samePath(p, a.path));
      if (a.on !== false) pins.push(M.normPath(a.path));
      emit('files.pins', { pins: pinRows() });
      return { ok: true, pins: pinRows() };
    },
    setview: (a) => { views.set(String(a.path).toLowerCase(), { view: a.view, sort: a.sort, dir: a.dir, group: a.group, cols: a.cols, size: a.size }); return { ok: true }; },
    setopt: (a) => { options[a.key] = a.value; emit('files.opts', { options: Object.assign({}, options) }); return { ok: true, options: Object.assign({}, options) }; },
    tabs: () => ({ ok: true }),
  };

  window.__mockCalls = [];
  window.mantle = {
    on(ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn); return () => { handlers[ev] = (handlers[ev] || []).filter((x) => x !== fn); }; },
    emit,
    call(name, args) {
      window.__mockCalls.push({ name, n: Object.keys(args || {}).length });
      const verb = String(name).replace(/^files\./, '');
      const fn = C[verb];
      if (!fn) return Promise.reject(new Error(`no command "${name}" (mock)`));
      try { return Promise.resolve(fn(args || {})); } catch (e) { return Promise.reject(e); }
    },
    pathForFile(file) { return file && file.name ? HOME + '\\Downloads\\' + file.name : ''; },
  };
}());

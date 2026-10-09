'use strict';
/*
 * wallpaper.js -- Mantle plays the desktop wallpaper itself (2026-09-22).
 *
 * WHY. The desktop layer is parented to Progman directly under the icons (progman-front, see
 * sidecar/Desktop.cs), in FRONT of the wallpaper, so its glass panes cover whatever plays behind.
 * Lively's mpv player is a separate window under that layer, and Windows cannot show another
 * process's window through a transparent Electron child window -- the panes hid Owen's video.
 * His decision: "make it so this fully replaces lively so i can add new videos and still have my
 * library of videos i have on lively rn." So the wallpaper now renders INSIDE ui/desktop, at the
 * bottom of its stack, and the panes above it can use a real CSS backdrop-filter over the moving
 * picture (see ui/desktop/desktop.css for why that is now worth its GPU time and was not before).
 *
 * WHAT LIVES HERE (main process only):
 *   the library        <userData>/wallpapers/, imported from Lively once (lib/wallpaper-lively.js)
 *   mantle-wp://<id>/  a protocol that serves a web wallpaper's folder to the desktop page's
 *                      sandboxed iframe, with ui/wallpapers/lively-shim.js put first in its <head>
 *   the pause rules    Owen's Lively rules, carried over: pause while an app fills the screen,
 *                      and so on -- decided here once a second from the sidecar's `foreground`
 *   the feeds          livelySystemInformation and the cursor, for web wallpapers that want them
 *   the Wallpapers     a normal Mantle window (ui/wallpapers/) to browse, set, add, remove and
 *   window             customise. The desktop page cannot be that UI: it sits under the icons
 *                      layer and never receives a click.
 *
 * main.js only calls start() after the desktop window exists, merges this file's commands into its
 * command table, and asks replay() for this file's events. Everything else is in here, so the
 * desktop-layer work and the bar work going on in main.js at the same time do not collide.
 *
 * NO SILENT FAILURES. Every way a wallpaper can fail to play -- a missing file, a type Mantle
 * cannot play, a codec Chromium will not decode, a web page that never loads -- ends in a
 * sentence on the wallpaper's card in the Wallpapers window AND, for the one on screen, the
 * desktop's "Needs attention" strip (the `wallpaper` piece of State). A log line is never the
 * only place a reason goes.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { pathToFileURL } = require('url');
const { Readable } = require('stream');
const { spawn } = require('child_process');
const { app, BrowserWindow, protocol, dialog, powerMonitor, screen } = require('electron');
const W = require('./wallpaper-lively');
// Mantle's built-in wallpapers (Helm's 23 photos in assets/backgrounds/, 2026-10-09): listed apart
// from Owen's library in `presets`, picked through the same wallpaper.set and saved in the same
// library.json `selected` as "builtin:<name>". Never copied into the library folder.
const PR = require('./wallpaper-presets');

const SCHEME = 'mantle-wp';

// Has to happen before app 'ready', i.e. at require time, which is why main.js requires this file
// at the top. standard: a real origin per wallpaper (mantle-wp://<id>), so relative URLs, fetch()
// and localStorage behave as they did in Lively's browser. corsEnabled + the ACAO header below:
// three.js loads textures with crossOrigin="anonymous", and the Wallpapers window draws a frame
// of a video onto a canvas to make a thumbnail, which needs a CORS-clean response to read back.
protocol.registerSchemesAsPrivileged([{
  scheme: SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
}]);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.js': 'text/javascript',
  '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.map': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.bmp': 'image/bmp', '.avif': 'image/avif',
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.ogv': 'video/ogg', '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.wasm': 'application/wasm',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8', '.frag': 'text/plain; charset=utf-8', '.vert': 'text/plain; charset=utf-8',
  '.glsl': 'text/plain; charset=utf-8', '.xml': 'application/xml',
};

const S = {
  ctx: null,                 // {root, test, state, sidecar}
  lib: null,                 // W.Library
  presets: null,             // PR.load(): the built-in wallpapers' catalog, read once at start
  desktopWin: null,
  libraryWin: null,
  settings: null,            // readLivelySettings()
  rules: null,               // playbackRules()
  importing: null,           // {done, total} while an import runs
  runtime: new Map(),        // id -> {state, reason, notes[]}  what the desktop page last said
  pause: { paused: false, unload: false, reason: 'not checked yet', why: [] },
  fgNote: '',                // why the full-screen check is not being made, if it is not
  fgMissed: 0,               // front-window checks in a row that got no answer in time (see checkNow)
  locked: false,
  asleep: false,
  remote: /^RDP-/i.test(process.env.SESSIONNAME || ''),
  override: null,            // the test probe only: 'play' | 'pause' | null
  timers: {},
  lastCursor: '',
  cpuPrev: null,
  gpuName: null,
  started: false,
  undo: new Map(),           // id -> {item, index, wasSelected, wasRemoved, aside, timer}  a remove that can still be undone
};

/* ---- small helpers ------------------------------------------------------ */

function alive(win) { return !!(win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()); }

function sendTo(win, name, payload) {
  if (!alive(win)) return;
  try { win.webContents.send('mantle:event', { name, payload }); } catch (_) { /* went away mid-send */ }
}

/*
 * Logs carry ids, counts and rule kinds, never a title, file name, path or window title (the
 * lane privacy rule). scrub() is the backstop for error text from fs and Chromium, which quotes
 * the path it failed on.
 */
function scrub(text) {
  return String(text)
    .replace(/(?:[A-Za-z]:|\\\\[^\\/\s]+)[\\/][^'"\n)]*/g, '<path>')
    .replace(/file:\/\/\/?[^\s'")]*/gi, '<file url>');
}

function log(line) { process.stdout.write(`mantle: wallpaper: ${scrub(line)}\n`); }

/** The wallpaper on the desktop: one of Owen's (a library item) or a built-in one (item.preset). */
function selectedItem() {
  if (!S.lib || !S.lib.data.selected) return null;
  const id = S.lib.data.selected;
  return PR.isPresetId(id) ? PR.find(S.presets, id) : S.lib.get(id);
}

/** {ok, reason} for either kind. */
function healthOf(item) { return item && item.preset ? PR.health(item) : S.lib.health(item); }

function fileUrl(abs) { return pathToFileURL(abs).href; }

function wpUrl(id, rel) {
  return `${SCHEME}://${id}/${String(rel).split('/').map(encodeURIComponent).join('/')}`;
}

const TYPE_LABEL = { video: 'Video', gif: 'GIF', picture: 'Picture', web: 'Web' };

/* ---- how an item is drawn ------------------------------------------------ */

/*
 * A video's customisation, as the desktop page applies it. Lively's colour sliders run -100..100
 * with 0 meaning "as filmed"; mpv's brightness is additive where CSS brightness() multiplies, so
 * the look is close to Lively's rather than identical. Only non-zero sliders produce a filter:
 * an identity filter is still a filter pass over every frame of a full-screen video.
 */
function lookFor(item, values) {
  const fit = ['none', 'fill', 'contain', 'cover'][Number(values.scaler)] || 'cover';
  if (item.type !== 'video') return { fit, filter: '', rate: 1 };
  const f = [];
  const n = (k) => (Number.isFinite(Number(values[k])) ? Number(values[k]) : 0);
  if (n('saturation')) f.push(`saturate(${Math.max(0, 1 + n('saturation') / 100).toFixed(2)})`);
  if (n('hue')) f.push(`hue-rotate(${Math.round(n('hue') * 1.8)}deg)`);
  if (n('brightness')) f.push(`brightness(${Math.max(0, 1 + n('brightness') / 100).toFixed(2)})`);
  if (n('contrast')) f.push(`contrast(${Math.max(0, 1 + n('contrast') / 100).toFixed(2)})`);
  const rate = Math.min(5, Math.max(0.25, Number(values.speed) || 1));
  return { fit, filter: f.join(' '), rate };
}

/** What the desktop page is told to draw. */
function desktopPayload() {
  const base = { paused: S.pause.paused, unload: S.pause.unload, pauseReason: S.pause.reason };
  if (!S.lib) return Object.assign(base, { ok: false, reason: 'the wallpaper library has not loaded yet', item: null });
  const item = selectedItem();
  if (!item) {
    if (S.importing) {
      return Object.assign(base, { ok: true, none: true, item: null,
        reason: `copying your Lively library into Mantle (${S.importing.done} of ${S.importing.total})` });
    }
    return Object.assign(base, { ok: true, none: true, item: null,
      reason: S.lib.data.items.length
        ? 'no wallpaper is chosen, so the desktop shows Windows\' own wallpaper: pick one in the Wallpapers window'
        : 'the wallpaper library is empty, so the desktop shows Windows\' own wallpaper: add one in the Wallpapers window' });
  }
  const h = healthOf(item);
  const head = { id: item.id, title: item.title, type: item.type };
  if (!h.ok) return Object.assign(base, { ok: false, reason: `"${item.title}" can't play: ${h.reason}`, item: head });
  if (item.preset) {
    // A still photo, filling the screen the way Helm and Quartz show it: no sliders, no feeds.
    return Object.assign(base, { ok: true, reason: '', item: Object.assign(head, {
      url: fileUrl(item.abs), look: { fit: 'cover', filter: '', rate: 1 }, props: [], sysinfo: false, input: false, preset: true }) });
  }
  const dir = S.lib.itemDir(item.id);
  const p = W.propsFor(item, dir);
  return Object.assign(base, {
    ok: true,
    reason: '',
    item: Object.assign(head, {
      url: item.type === 'web' ? wpUrl(item.id, item.entry) : fileUrl(path.join(dir, item.entry)),
      look: lookFor(item, p.values),
      props: item.type === 'web' ? W.sendableProps(p.defs, p.values) : [],
      sysinfo: /--system-information/i.test(item.args || ''),
      input: item.type === 'web' && S.rules && S.rules.inputForward >= 1,
    }),
  });
}

function pushDesktop() {
  sendTo(S.desktopWin, 'wallpaper', desktopPayload());
  syncState();
  syncFeeds();
}

/* ---- the State piece (the desktop strip reads it) ----------------------- */

function syncState() {
  if (!S.ctx || !S.ctx.state) return;
  const item = selectedItem();
  const d = desktopPayload();
  const rt = item ? S.runtime.get(item.id) : null;
  let ok = d.ok;
  let reason;
  if (!d.ok) reason = d.reason;
  else if (!item) reason = d.reason;
  else if (rt && rt.state === 'error') { ok = false; reason = `"${item.title}" did not play: ${rt.reason}`; }
  else if (S.pause.paused) reason = `"${item.title}" is paused: ${S.pause.reason}`;
  else reason = `"${item.title}" is ${rt && (rt.state === 'playing' || rt.state === 'ready') ? 'playing' : 'loading'}`;
  S.ctx.state.set('wallpaper', {
    ok,
    id: item ? item.id : null,
    title: item ? item.title : null,
    paused: S.pause.paused,
    reason,
    // The pause rules can fail on their own (no sidecar): the wallpaper still plays, but a game
    // in front would no longer pause it, and that has to be said somewhere Owen looks.
    rulesOk: !S.fgNote,
    rulesReason: S.fgNote || 'the pause rules are being checked once a second',
  });
  pushLibrary();
}

/* ---- the library listing (the Wallpapers window) ------------------------- */

let libraryPushTimer = null;
function pushLibrary() {
  if (!alive(S.libraryWin) || libraryPushTimer) return;
  // Coalesced: an import pushes per wallpaper and a slider pushes per tick.
  libraryPushTimer = setTimeout(() => {
    libraryPushTimer = null;
    sendTo(S.libraryWin, 'wallpaper.library', listing());
  }, 60);
}

function rulesForDisplay() {
  const R = S.rules || W.playbackRules(null);
  const raw = (S.settings && S.settings.raw) || {};
  const word = (r) => ({ pause: 'pause', ignore: 'keep playing', kill: 'unload the wallpaper' }[r] || r);
  let decode = 'unknown';
  try { decode = app.getGPUFeatureStatus().video_decode || 'unknown'; } catch (_) { /* before ready */ }
  const lines = [
    { label: 'An app is full screen or maximised', value: word(R.fullscreen), honoured: true,
      note: 'Mantle asks which window is in front once a second (and at once when a full-screen app takes the screen).' },
    { label: 'Another app has focus', value: word(R.focus), honoured: true, note: '' },
    { label: 'Which windows count', value: 'the window in front', honoured: R.algorithm === 'foreground',
      note: R.algorithm === 'foreground' ? '' : `Lively was set to "${R.algorithm}", which also counts windows BEHIND the one in front. Mantle only looks at the front window, so a small window over a maximised one keeps the wallpaper playing.` },
    { label: 'On battery', value: word(R.battery), honoured: true, note: '' },
    { label: 'Remote desktop', value: word(R.remote), honoured: true,
      note: 'Checked when Mantle starts; a session that becomes remote later is not noticed.' },
    { label: 'Battery saver', value: word(R.powerSave), honoured: R.powerSave === 'ignore',
      note: R.powerSave === 'ignore' ? '' : 'Mantle cannot read battery saver, so this rule is not applied.' },
    { label: 'Per-app rules', value: R.appRules.length ? R.appRules.map((r) => `${r.app}: ${word(r.rule)}`).join(', ') : 'none', honoured: true, note: '' },
    { label: 'Mouse to web wallpapers', value: R.inputForward >= 1 ? 'cursor position' : 'off', honoured: true,
      note: R.inputForward >= 1 ? 'Movement only: the desktop layer sits under the icons, so clicks go to the icons.' : '' },
    { label: 'Video decoding', value: /enabled/i.test(decode) ? 'on the graphics card' : 'on the processor', honoured: true,
      note: /enabled/i.test(decode) ? '' : 'The graphics card cannot decode video right now, so playing a video wallpaper costs more processor time.' },
    { label: 'Sound', value: 'muted', honoured: true,
      note: raw.AudioVolumeGlobal !== undefined ? `Lively played sound at ${raw.AudioVolumeGlobal}%${raw.AudioOnlyOnDesktop ? ' (only while the desktop was in view)' : ''}; Mantle plays every wallpaper muted.` : '' },
  ];
  return { from: R.from, reason: S.settings ? S.settings.reason : '', lines };
}

/** "2026-09-22" in Owen's own day. addedAt is UTC; slicing it said "tomorrow" every evening. */
function localDay(iso) {
  const d = new Date(iso || '');
  if (Number.isNaN(d.getTime())) return 'on an unknown day';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * The built-in wallpapers for the pickers (the Wallpapers window's Built-in view, Settings >
 * Personalization > Background): their own list beside `items`, never mixed into it.
 */
function presetListing(sel) {
  const P = S.presets;
  if (!P) return { ok: false, reason: 'the built-in wallpapers have not been read yet', note: '', categories: [], items: [] };
  return {
    ok: P.ok,
    reason: P.reason,
    note: P.note,
    categories: P.categories.slice(),
    items: P.items.map((it) => {
      const t = PR.thumbOf(it);
      return {
        id: it.id,
        title: it.title,
        type: 'picture',
        typeLabel: 'Picture',
        preset: true,
        category: it.category,
        credit: it.credit,
        creditUrl: it.creditUrl,
        thumbUrl: t.url,
        thumbNote: t.note,
        origin: 'Built in',
        health: PR.health(it),
        runtime: S.runtime.get(it.id) || null,
        selected: !!(sel && sel.id === it.id),
      };
    }),
  };
}

/**
 * What is on the desktop, whichever kind it is, for anything that describes the pick in one line
 * (Settings' "Mantle's wallpaper" row, the Wallpapers window's header). A built-in pick carries its
 * photo credit. A pick whose built-in photo left the catalog is still described, with the reason.
 */
function currentFor(sel, items, presets) {
  if (!sel) return null;
  const listed = sel.preset ? presets.items.find((x) => x.id === sel.id) : items.find((x) => x.id === sel.id);
  if (listed) {
    return { id: listed.id, title: listed.title, type: listed.type, typeLabel: listed.typeLabel, preset: !!sel.preset,
      category: listed.category || '', credit: listed.credit || '', creditUrl: listed.creditUrl || '', thumbUrl: listed.thumbUrl, health: listed.health };
  }
  return { id: sel.id, title: sel.title, type: sel.type, typeLabel: TYPE_LABEL[sel.type] || 'Unknown', preset: !!sel.preset,
    category: sel.category || '', credit: sel.credit || '', creditUrl: sel.creditUrl || '', thumbUrl: null, health: healthOf(sel) };
}

function listing() {
  const lib = S.lib;
  const sel = selectedItem();
  const items = lib ? lib.data.items.map((it) => {
    const dir = lib.itemDir(it.id);
    const h = lib.health(it);
    const rt = S.runtime.get(it.id) || null;
    const thumbAbs = it.thumb && W.isInside(dir, path.resolve(dir, String(it.thumb))) ? path.resolve(dir, String(it.thumb)) : null;
    const hasThumb = !!(thumbAbs && fs.existsSync(thumbAbs));
    // A video, gif or picture always has its fit (and a video its colour sliders); only a web
    // wallpaper has to be asked, so a big library does not read a file per card on every push.
    let props = it.type !== 'web';
    if (!props) { try { props = Object.keys(W.propsFor(it, dir).defs).length > 0; } catch (_) { props = false; } }
    return {
      id: it.id,
      title: it.title,
      type: it.type,
      typeLabel: TYPE_LABEL[it.type] || 'Unknown',
      thumbUrl: hasThumb ? fileUrl(thumbAbs) : null,
      needsThumb: it.type === 'video' && !hasThumb && h.ok,
      probeUrl: it.type === 'video' && h.ok ? wpUrl(it.id, it.entry) : null,
      origin: it.origin && it.origin.from === 'lively' ? 'Imported from Lively' : `Added ${localDay(it.addedAt)}`,
      originPath: it.origin ? it.origin.path : '',
      desc: it.desc || '',
      author: it.author || '',
      health: h,
      runtime: rt,
      hasProps: props,
      sysinfo: /--system-information/i.test(it.args || ''),
      selected: !!(sel && sel.id === it.id),
    };
  }) : [];
  const L = lib && lib.data.lively;
  const presets = presetListing(sel);
  return {
    dir: lib ? lib.dir : '',
    loadError: lib ? lib.loadError : '',
    items,
    presets,
    current: currentFor(sel, items, presets),
    playback: S.ctx && S.ctx.state ? S.ctx.state.get().wallpaper || null : null,
    importing: S.importing,
    lively: L ? { importedAt: L.importedAt, root: L.root, report: L.report } : null,
    livelyInstalled: !!W.livelyRoot(),
    rules: rulesForDisplay(),
    userPaused: !!(lib && lib.data.userPaused),
    test: !!(S.ctx && S.ctx.test),
  };
}

/* ---- mantle-wp:// -------------------------------------------------------- */

function mimeOf(file) { return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream'; }

function textResponse(status, text) {
  return new Response(text, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Access-Control-Allow-Origin': '*' } });
}

async function fileResponse(abs, req, type) {
  let st;
  try { st = await fsp.stat(abs); } catch (_) { return textResponse(404, `not found: ${path.basename(abs)}`); }
  if (!st.isFile()) return textResponse(404, `not a file: ${path.basename(abs)}`);
  const headers = { 'Content-Type': type || mimeOf(abs), 'Access-Control-Allow-Origin': '*', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' };
  // Ranges, because <video> asks for them and seeks with them; a 200 for a range request makes
  // Chromium read the whole file before it can loop.
  const range = req.headers.get('range');
  const m = range && /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (m && (m[1] || m[2])) {
    let start;
    let end;
    if (m[1] === '') { start = Math.max(0, st.size - Number(m[2])); end = st.size - 1; } else { start = Number(m[1]); end = m[2] ? Math.min(Number(m[2]), st.size - 1) : st.size - 1; }
    if (start > end || start >= st.size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${st.size}`, 'Access-Control-Allow-Origin': '*' } });
    headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
    headers['Content-Length'] = String(end - start + 1);
    return new Response(Readable.toWeb(fs.createReadStream(abs, { start, end })), { status: 206, headers });
  }
  headers['Content-Length'] = String(st.size);
  return new Response(Readable.toWeb(fs.createReadStream(abs)), { status: 200, headers });
}

const SHIM_TAG = '<script src="/__mantle__/lively-shim.js"></script>';

/** The wallpaper's entry page with the shim put first in its <head>. */
async function htmlWithShim(abs) {
  let html;
  try { html = await fsp.readFile(abs, 'utf8'); } catch (err) { return textResponse(404, `the wallpaper page could not be read: ${err.message}`); }
  if (html.charCodeAt(0) === 0xFEFF) html = html.slice(1);   // a byte-order mark
  // After <head>, never before the doctype: a script ahead of <!DOCTYPE> would drop the page into
  // quirks mode and change its layout.
  let out;
  if (/<head(\s[^>]*)?>/i.test(html)) out = html.replace(/<head(\s[^>]*)?>/i, (t) => t + SHIM_TAG);
  else if (/<html(\s[^>]*)?>/i.test(html)) out = html.replace(/<html(\s[^>]*)?>/i, (t) => t + SHIM_TAG);
  else if (/^\s*<!doctype[^>]*>/i.test(html)) out = html.replace(/^\s*<!doctype[^>]*>/i, (t) => t + SHIM_TAG);
  else out = SHIM_TAG + html;
  return new Response(out, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' } });
}

function registerProtocol() {
  protocol.handle(SCHEME, async (req) => {
    try {
      const u = new URL(req.url);
      const id = u.hostname;
      // A standard scheme's host is lower-cased by the URL parser, so the lookup ignores case.
      const item = S.lib && (S.lib.get(id) || S.lib.data.items.find((i) => String(i.id).toLowerCase() === id));
      if (!item) return textResponse(404, 'that wallpaper is not in Mantle\'s library');
      const dir = S.lib.itemDir(item.id);
      const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
      if (rel === '__mantle__/lively-shim.js') return fileResponse(path.join(S.ctx.root, 'ui', 'wallpapers', 'lively-shim.js'), req, 'text/javascript');
      const abs = path.resolve(dir, rel || item.entry);
      if (!W.isInside(dir, abs)) return textResponse(403, 'that path is outside the wallpaper\'s folder');
      if (item.type === 'web' && path.resolve(dir, item.entry).toLowerCase() === abs.toLowerCase()) return htmlWithShim(abs);
      return fileResponse(abs, req);
    } catch (err) {
      return textResponse(500, `Mantle could not serve that: ${err.message}`);
    }
  });
}

/* ---- the pause rules ----------------------------------------------------- */

/** Does a physical-pixel rect [l,t,r,b] cover the primary display's work area? */
function coversWorkArea(rect) {
  if (!Array.isArray(rect) || rect.length < 4) return false;
  const d = screen.getPrimaryDisplay();
  const sf = d.scaleFactor || 1;
  const wa = { x: Math.round(d.workArea.x * sf), y: Math.round(d.workArea.y * sf), w: Math.round(d.workArea.width * sf), h: Math.round(d.workArea.height * sf) };
  const T = 4;   // an auto-hide taskbar leaves a maximised window a pixel or two short of the edge
  return rect[0] <= wa.x + T && rect[1] <= wa.y + T && rect[2] >= wa.x + wa.w - T && rect[3] >= wa.y + wa.h - T;
}

function decide(fg) {
  const R = S.rules || W.playbackRules(null);
  const why = [];
  if (S.override === 'pause') why.push({ rule: 'pause', kind: 'test', text: 'the test probe asked for a pause' });
  if (S.lib && S.lib.data.userPaused) why.push({ rule: 'pause', kind: 'you', text: 'you paused it' });
  // Game mode (lib/features/gamemode.js, 2026-09-25): paused while a game runs, even a WINDOWED one
  // that leaves the desktop showing (the full-screen rule alone would keep the video decoding).
  if (S.gameHold) why.push({ rule: 'pause', kind: 'game', text: S.gameHold });
  // Mantle resting while a game runs (lane memfix, 2026-09-26): UNLOADED, not paused, so a video's
  // decoder and frames (or a web wallpaper's page) give their memory back; mounted again after.
  if (S.rest) why.push({ rule: 'kill', kind: 'rest', text: `Mantle is resting while ${S.rest}` });
  if (S.locked) why.push({ rule: 'pause', kind: 'locked', text: 'the screen is locked' });
  if (S.asleep) why.push({ rule: 'pause', kind: 'sleep', text: 'the PC is going to sleep' });
  if (R.battery !== 'ignore') {
    let onBattery = false;
    try { onBattery = powerMonitor.isOnBatteryPower(); } catch (_) { /* no answer is not on battery */ }
    if (onBattery) why.push({ rule: R.battery, kind: 'battery', text: 'the PC is on battery (your Lively rule)' });
  }
  if (R.remote !== 'ignore' && S.remote) why.push({ rule: R.remote, kind: 'remote', text: 'this is a remote desktop session (your Lively rule)' });
  let front = '';
  if (fg && fg.hwnd && fg.hwnd !== '0') {
    const exe = path.basename(String(fg.exe || ''));
    const who = exe || fg.title || 'an unnamed window';
    const own = fg.pid === process.pid;
    // The desktop itself (Progman/WorkerW, both explorer.exe with no title or "Program Manager")
    // covers the whole screen and is never a reason to pause: it IS where the wallpaper shows.
    const shell = /^explorer\.exe$/i.test(exe) && (!fg.title || fg.title === 'Program Manager');
    if (!own && !shell) {
      front = who;
      const appRule = R.appRules.find((r) => r.app.toLowerCase() === exe.replace(/\.exe$/i, '').toLowerCase());
      if (appRule) {
        if (appRule.rule !== 'ignore') why.push({ rule: appRule.rule, kind: 'app rule', text: `${who} is in front (your Lively rule for ${appRule.app})` });
      } else {
        const fills = fg.fullscreen === true || coversWorkArea(fg.rect);
        if (fills && R.fullscreen !== 'ignore') why.push({ rule: R.fullscreen, kind: 'full screen', text: `${who} ${fg.fullscreen ? 'is full screen' : 'fills the screen'} in front` });
        else if (!fills && R.focus !== 'ignore') why.push({ rule: R.focus, kind: 'focus', text: `${who} has focus (your Lively rule)` });
      }
    }
  }
  if (S.override === 'play') why.length = 0;
  const paused = why.length > 0;
  const unload = why.some((w) => w.rule === 'kill');
  const reason = paused
    ? why.map((w) => w.text).join('; ')
    : (S.override === 'play' ? 'the test probe is holding it playing whatever is in front' : (front ? `playing (${front} is in front, which does not pause it)` : 'playing'));
  const changed = paused !== S.pause.paused || unload !== S.pause.unload || reason !== S.pause.reason;
  S.pause = { paused, unload, reason, why };
  if (changed) {
    if (paused !== (S.lastLoggedPause || false)) log(paused ? `paused (${why.map((w) => w.kind || 'rule').join(', ')})` : 'playing again');
    S.lastLoggedPause = paused;
    sendTo(S.desktopWin, 'wallpaper.pause', { paused, unload, reason });
    syncState();
    syncFeeds();
  }
}

let fgInflight = false;
/*
 * How long one front-window check may wait for its answer. 1.5 s, except while the helper is starting
 * or in its first seconds after (a start or a restart): that is its busiest moment, and the check waits
 * in the same queue as everything Mantle asks for at start. MEASURED (lane r7-fg, 2026-10-01, 4 --test
 * starts): the helper's first window list held that queue for 1.4-1.6 s, so a check sent in the first
 * ~0.5 s after start missed a 1.5 s budget (A1: expired at 1519 ms) and the helper logged it as shed.
 */
const FG_MS = 1500;
const FG_START_MS = 4000;           // the budget while the helper is starting, and for FG_START_FOR after
const FG_START_FOR = 5000;
function fgBudget(sc) {
  const at = sc && sc.readyAt;
  if (typeof at !== 'number') return FG_MS;          // a helper that does not say when it started
  return at === 0 || Date.now() - at < FG_START_FOR ? FG_START_MS : FG_MS;
}

async function checkNow() {
  if (fgInflight || !S.ctx) return;
  if (S.rest) return;   // unloaded while a game runs: no once-a-second foreground call until it exits
  const item = selectedItem();
  // Nothing to pause, so no foreground call -- but a lock/sleep/rest reason that has let go must
  // still clear, or the Wallpapers window says "paused: the PC is going to sleep" all day.
  if (!item) { decide(null); return; }
  fgInflight = true;
  let fg = null;
  let note = '';
  let timedOut = false;
  try {
    const sc = S.ctx.sidecar;
    const blocked = sc && typeof sc.blockedReason === 'function' ? sc.blockedReason() : null;
    if (!sc) note = 'Mantle\'s helper is not running, so a full-screen app does not pause the wallpaper';
    else if (blocked) note = 'Mantle\'s helper is not answering, so a full-screen app does not pause the wallpaper';
    else {
      fg = await sc.call('foreground', {}, fgBudget(sc));
      if (!fg || typeof fg.fullscreen !== 'boolean') note = 'Mantle\'s helper is out of date, so a full-screen app does not pause the wallpaper. Updating Mantle fixes this';
    }
  } catch (err) {
    // ONE answer that came too late (a busy moment in the helper's queue, see fgBudget) is asked again
    // on the next tick, a second from now, before it is said; the wallpaper stays as it was meanwhile,
    // never un-paused behind a full-screen app because of an unknown. Two in a row, or any other
    // failure, is said at once as before.
    timedOut = /did not answer/.test(String(err && err.message));
    if (timedOut && ++S.fgMissed < 2) return;
    note = 'Mantle could not check which window is in front, so a full-screen app does not pause the wallpaper';
    S.fgErr = err.message;
    fg = null;
  } finally {
    fgInflight = false;
  }
  if (!timedOut) S.fgMissed = 0;   // answered, or a failure that is said at once
  if (note !== S.fgNote) {
    S.fgNote = note;
    if (note) log(`${note}${S.fgErr ? ` (${S.fgErr})` : ''}`);
    S.fgErr = '';
    syncState();
  }
  decide(fg);
}

function startRules() {
  S.timers.fg = setInterval(() => { checkNow(); }, 1000);
  if (S.timers.fg.unref) S.timers.fg.unref();
  const sc = S.ctx.sidecar;
  // The edge clip already reacts the instant a full-screen app takes the foreground (a WinEvent
  // hook in the sidecar); when it says so, check now instead of up to a second later.
  if (sc && typeof sc.on === 'function') sc.on('edgeclip', () => { checkNow(); });
  try {
    powerMonitor.on('lock-screen', () => { S.locked = true; decide(null); });
    powerMonitor.on('unlock-screen', () => { S.locked = false; checkNow(); });
    powerMonitor.on('suspend', () => { S.asleep = true; decide(null); });
    powerMonitor.on('resume', () => { S.asleep = false; checkNow(); });
    powerMonitor.on('on-battery', () => { checkNow(); });
    powerMonitor.on('on-ac', () => { checkNow(); });
  } catch (err) {
    log(`power events are not available (${err.message}); lock and sleep do not pause the wallpaper`);
  }
}

/* ---- the feeds a web wallpaper gets ------------------------------------- */

function cpuPercent() {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) { for (const k of Object.keys(c.times)) total += c.times[k]; idle += c.times.idle; }
  const prev = S.cpuPrev;
  S.cpuPrev = { idle, total };
  if (!prev || total <= prev.total) return 0;
  return Math.max(0, Math.min(100, 100 * (1 - (idle - prev.idle) / (total - prev.total))));
}

function netCardName() {
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    if ((ifs[name] || []).some((a) => !a.internal && a.family === 'IPv4')) return name;
  }
  return 'no network';
}

/*
 * Lively's HardwareUsageEventArgs, field for field. GPU load and network throughput are sent as 0:
 * Mantle measures CPU and memory (the same numbers as its own System pane) and nothing else, and
 * the wallpaper's card in the Wallpapers window says so rather than letting two flat charts look
 * like an idle GPU and a dead network.
 */
function sysinfoJson() {
  const cpus = os.cpus();
  return JSON.stringify({
    NameCpu: cpus[0] ? cpus[0].model.trim() : 'CPU',
    NameGpu: S.gpuName || 'GPU',
    NameNetCard: netCardName(),
    CurrentCpu: Math.round(cpuPercent() * 10) / 10,
    CurrentGpu3D: 0,
    CurrentRamAvail: Math.round(os.freemem() / 1048576),
    CurrentNetUp: 0,
    CurrentNetDown: 0,
    TotalRam: Math.round(os.totalmem() / 1048576),
  });
}

function stopFeed(name) { if (S.timers[name]) { clearInterval(S.timers[name]); S.timers[name] = null; } }

/** Start or stop the sysinfo and cursor feeds to match what is on screen now. */
function syncFeeds() {
  const d = S.lib ? desktopPayload() : null;
  const it = d && d.ok && d.item && d.item.url ? d.item : null;
  const running = !!(it && !S.pause.paused && alive(S.desktopWin));
  if (running && it.sysinfo) {
    if (!S.timers.sys) {
      if (!S.gpuName) {
        app.getGPUInfo('basic').then((g) => {
          const dev = g && Array.isArray(g.gpuDevice) ? (g.gpuDevice.find((x) => x.active) || g.gpuDevice[0]) : null;
          S.gpuName = (dev && (dev.deviceString || dev.description)) || 'GPU';
        }).catch(() => { S.gpuName = 'GPU'; });
      }
      cpuPercent();
      S.timers.sys = setInterval(() => sendTo(S.desktopWin, 'wallpaper.sysinfo', sysinfoJson()), 1000);
      if (S.timers.sys.unref) S.timers.sys.unref();
    }
  } else stopFeed('sys');
  if (running && it.input) {
    if (!S.timers.cursor) {
      S.lastCursor = '';
      // 15 a second, and only a CHANGED position is sent: a still mouse costs one read per tick.
      S.timers.cursor = setInterval(() => {
        if (!alive(S.desktopWin)) return;
        const pt = screen.getCursorScreenPoint();
        const b = S.desktopWin.getContentBounds();
        if (pt.x < b.x || pt.y < b.y || pt.x >= b.x + b.width || pt.y >= b.y + b.height) return;
        const key = `${pt.x},${pt.y}`;
        if (key === S.lastCursor) return;
        S.lastCursor = key;
        sendTo(S.desktopWin, 'wallpaper.cursor', { x: pt.x - b.x, y: pt.y - b.y });
      }, 66);
      if (S.timers.cursor.unref) S.timers.cursor.unref();
    }
  } else stopFeed('cursor');
}

/* ---- import --------------------------------------------------------------- */

async function runImport(force, why) {
  if (S.importing) throw new Error('an import is already running');
  S.importing = { done: 0, total: 0 };
  log(`importing from Lively (${why})`);
  pushDesktop();
  const hadSelection = !!S.lib.data.selected;
  let report;
  try {
    report = await W.importLively(S.lib, {
      force,
      onProgress: (done, total, line) => {
        S.importing = { done, total };
        log(`  ${done}/${total} ${line.ok ? (line.skipped ? 'skipped (removed before)' : 'ok') : 'failed'}`);
        // The current Lively wallpaper is copied first; the moment it lands, it plays.
        if (!hadSelection && S.lib.data.selected && done === 1) pushDesktop();
        else { syncState(); pushLibrary(); }
      },
    });
  } finally {
    S.importing = null;
  }
  log(`import done: ${report.reason}`);
  pushDesktop();
  return report;
}

/* ---- adding wallpapers -------------------------------------------------- */

function titleFrom(file) { return path.basename(file, path.extname(file)); }

async function addFile(src, type) {
  const id = W.newId();
  const dir = S.lib.itemDir(id);
  const name = path.basename(src);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.copyFile(src, path.join(dir, name));
  const item = {
    id, title: titleFrom(src), type, entry: name,
    // A picture or a gif is its own thumbnail. A video gets one from its own frames, drawn by the
    // Wallpapers window (see needsThumb) -- which is also the proof that Chromium can decode it.
    thumb: type === 'video' ? null : name,
    preview: null, desc: '', author: '', args: '', values: {},
    origin: { from: 'added', path: src }, addedAt: new Date().toISOString(),
  };
  S.lib.data.items.push(item);
  return { path: src, ok: true, id, title: item.title, reason: `added as a ${TYPE_LABEL[type].toLowerCase()} wallpaper` };
}

/** Find the page of an HTML wallpaper folder: its LivelyInfo.json, or an index.html, or its one .html. */
function findWebEntry(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch (err) { return { error: `the folder could not be read: ${err.message}` }; }
  const lower = names.map((n) => n.toLowerCase());
  if (lower.includes('livelyinfo.json')) return { dir, lively: true };
  const idx = lower.indexOf('index.html');
  if (idx >= 0) return { dir, entry: names[idx] };
  const htmls = names.filter((n) => /\.html?$/i.test(n));
  if (htmls.length === 1) return { dir, entry: htmls[0] };
  // A zip usually wraps everything in one top-level folder: look one level down, once.
  const subs = names.filter((n) => { try { return fs.statSync(path.join(dir, n)).isDirectory(); } catch (_) { return false; } });
  if (!htmls.length && subs.length === 1) return findWebEntry(path.join(dir, subs[0]));
  return { error: htmls.length ? `it has ${htmls.length} .html files and no index.html or LivelyInfo.json, so there is no telling which one is the wallpaper` : 'it has no LivelyInfo.json, no index.html and no .html page, so it is not an HTML wallpaper' };
}

async function addFolder(src, label) {
  const found = findWebEntry(src);
  if (found.error) return { path: label || src, ok: false, reason: found.error };
  const id = W.newId();
  if (found.lively) {
    let info;
    try { info = W.readJsonc(path.join(found.dir, 'LivelyInfo.json')); } catch (err) {
      return { path: label || src, ok: false, reason: `its LivelyInfo.json could not be read: ${err.message}` };
    }
    const line = await W.importOne(S.lib, null, { livelyId: id, dir: found.dir, info }, { from: 'added', path: label || src });
    if (!line.ok) return { path: label || src, ok: false, reason: line.reason };
    S.lib.data.items.push(line.item);
    return { path: label || src, ok: true, id, title: line.item.title, reason: `added as a ${TYPE_LABEL[line.item.type].toLowerCase()} wallpaper` };
  }
  const dir = S.lib.itemDir(id);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.cp(found.dir, dir, { recursive: true, force: true, errorOnExist: false });
  const names = fs.readdirSync(dir);
  const thumb = names.find((n) => /^(thumbnail|lively_t|preview|thumb)\.(jpe?g|png|webp|gif)$/i.test(n)) || null;
  const item = {
    id, title: path.basename(label ? label.replace(/\.zip$/i, '') : src), type: 'web', entry: found.entry.split(path.sep).join('/'),
    thumb, preview: null, desc: '', author: '', args: '', values: {},
    origin: { from: 'added', path: label || src }, addedAt: new Date().toISOString(),
  };
  S.lib.data.items.push(item);
  return { path: label || src, ok: true, id, title: item.title, reason: 'added as a web wallpaper' + (thumb ? '' : ' (it has no thumbnail picture)') };
}

function expandZip(zip, dest) {
  return new Promise((resolve) => {
    // Expand-Archive: in the box on every Windows 10/11, so no unzip library for one feature.
    // The paths go in through the environment, never pasted into the command: PowerShell also ends
    // a '...' string at a curly quote (U+2018/2019), so a zip named  a’;ni x;’.zip  ran code
    // when it was quoted with straight quotes only (lib/wallpaper.test.js proves both).
    const cmd = "$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath $env:MANTLE_WP_ZIP -DestinationPath $env:MANTLE_WP_DEST -Force";
    let err = '';
    let p;
    const env = Object.assign({}, process.env, { MANTLE_WP_ZIP: String(zip), MANTLE_WP_DEST: String(dest) });
    try { p = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', cmd], { windowsHide: true, env, stdio: ['ignore', 'ignore', 'pipe'] }); } catch (e) {
      resolve(`PowerShell could not be started to unzip it: ${e.message}`);
      return;
    }
    const timer = setTimeout(() => { try { p.kill(); } catch (_) {} }, 120000);
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => { clearTimeout(timer); resolve(`PowerShell could not be started to unzip it: ${e.message}`); });
    p.on('exit', (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? null : `unzipping failed (${code === null ? 'it took over two minutes' : `exit ${code}`}): ${err.trim().split('\n')[0] || 'no error text'}`);
    });
  });
}

async function addZip(src) {
  const tmp = path.join(os.tmpdir(), `mantle-wallpaper-${W.newId()}`);
  try {
    const bad = await expandZip(src, tmp);
    if (bad) return { path: src, ok: false, reason: bad };
    return await addFolder(tmp, src);
  } finally {
    fsp.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

/*
 * A path the Wallpapers window hands in (a drop from File Explorer) is only ever READ and copied into
 * the library, but it still comes from a page, so it is held to what a drop can be: an absolute path
 * on a local drive (no \\server share: opening one sends this PC's credentials to that server), not
 * inside Mantle's own library, and not a folder the library lives in (copying that would copy the
 * library into itself). Returns null when fine, else the reason in plain words.
 */
const MAX_ADD = 100;
function refusePath(p) {
  if (typeof p !== 'string' || !p || p.length > 1024 || p.includes('\0')) return 'that is not a file path';
  if (!/^[A-Za-z]:[\\/]/.test(p)) return /^[\\/]{2}/.test(p) ? 'files on a network share cannot be added; copy them to this PC first' : 'that is not a full path to a file on this PC';
  const abs = path.resolve(p);
  if (S.lib && W.isInside(S.lib.dir, abs)) return 'it is already inside Mantle\'s wallpaper folder';
  if (S.lib && W.isInside(abs, S.lib.dir)) return 'that folder holds Mantle\'s own wallpaper folder, so it cannot be added';
  return null;
}

async function addPaths(paths) {
  if (!Array.isArray(paths) || !paths.length) return { added: [], results: [] };
  const results = [];
  if (paths.length > MAX_ADD) {
    results.push({ path: '', ok: false, reason: `only ${MAX_ADD} can be added at once; the first ${MAX_ADD} were added` });
    paths = paths.slice(0, MAX_ADD);
  }
  for (const p of paths) {
    const refused = refusePath(p);
    if (refused) { results.push({ path: typeof p === 'string' ? p.slice(0, 260) : '', ok: false, reason: refused }); continue; }
    let st;
    try { st = fs.statSync(p); } catch (_) { results.push({ path: p, ok: false, reason: 'it does not exist (moved or deleted?)' }); continue; }
    try {
      if (st.isDirectory()) results.push(await addFolder(p));
      else if (/\.zip$/i.test(p)) results.push(await addZip(p));
      else {
        const type = W.typeFromExt(p);
        if (!type) {
          results.push({ path: p, ok: false, reason: `"${path.extname(p) || 'no extension'}" is not a wallpaper Mantle can play: add a video (mp4, webm), a gif, a picture (jpg, png, webp), or a folder or .zip holding an HTML wallpaper` });
        } else results.push(await addFile(p, type));
      }
    } catch (err) {
      results.push({ path: p, ok: false, reason: `copying it failed: ${err.message}` });
    }
    S.lib.save();
    pushLibrary();
  }
  const bad = results.filter((r) => !r.ok).length;
  log(`add: ${results.length - bad} added, ${bad} not added`);
  return { results };
}

/* ---- removing, with undo ------------------------------------------------- */

// MANTLE_WP_UNDO_MS: the test only, so it need not wait 20 s for a folder to be deleted.
const UNDO_MS = Number(process.env.MANTLE_WP_UNDO_MS) || 20000;
function removedDir() { return path.join(S.lib.dir, '.removed'); }

/** fs.rename, retried for a few seconds: Windows refuses to move a file that is still open, and
 * the desktop page lets go of the video it was playing a moment after it is told to. */
async function renameRetry(from, to) {
  let last;
  for (let i = 0; i < 12; i++) {
    try { await fsp.rename(from, to); return; } catch (err) {
      last = err;
      if (!/^(EBUSY|EPERM|EACCES)$/.test(err.code || '')) break;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw new Error(`Windows kept its files open, so they could not be moved (${(last && last.code) || 'unknown'}). Close anything using it and try again`);
}

async function moveAside(id) {
  const dir = S.lib.itemDir(id);
  if (!fs.existsSync(dir)) return null;   // its files were already gone: nothing to keep
  await fsp.mkdir(removedDir(), { recursive: true });
  const aside = path.join(removedDir(), `${id}-${Date.now()}`);
  await renameRetry(dir, aside);
  return aside;
}

async function purgeRemoved(id) {
  const u = S.undo.get(id);
  if (!u) return;
  S.undo.delete(id);
  if (u.aside) await fsp.rm(u.aside, { recursive: true, force: true });
}

/* ---- the Wallpapers window ---------------------------------------------- */

function openLibrary() {
  if (alive(S.libraryWin)) {
    if (S.ctx.test) S.libraryWin.showInactive();
    else { if (S.libraryWin.isMinimized()) S.libraryWin.restore(); S.libraryWin.show(); S.libraryWin.focus(); }
    return { opened: false, visible: true };
  }
  const d = screen.getPrimaryDisplay().workArea;
  const w = Math.min(1100, d.width - 80);
  const h = Math.min(720, d.height - 80);
  const win = new BrowserWindow({
    width: w,
    height: h,
    x: Math.round(d.x + (d.width - w) / 2),
    y: Math.round(d.y + (d.height - h) / 2),
    minWidth: 760,
    minHeight: 480,
    frame: false,                 // the header is the page's, in the taskbar's glass; see ui/wallpapers
    backgroundColor: groundNow(),  // --lg-ground in Mantle's appearance: the frame before the first paint
    show: false,
    title: 'Mantle wallpapers',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(S.ctx.root, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  S.libraryWin = win;
  // A file dropped anywhere the page did not catch would otherwise NAVIGATE the window to it.
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('console-message', (...a) => {
    const d0 = a[1] && typeof a[1] === 'object' && 'message' in a[1] ? a[1] : null;
    const level = d0 ? d0.level : a[1];
    const bad = typeof level === 'string' ? (level === 'error' || level === 'warning') : level >= 2;
    if (bad) process.stderr.write(`mantle: [wallpapers window] ${d0 ? d0.message : a[2]}\n`);
  });
  win.once('ready-to-show', () => { if (S.ctx.test) win.showInactive(); else win.show(); });
  win.on('closed', () => { if (S.libraryWin === win) S.libraryWin = null; });
  const file = path.join(S.ctx.root, 'ui', 'wallpapers', 'index.html');
  if (fs.existsSync(file)) win.loadFile(file);
  else win.loadURL(`data:text/plain,${encodeURIComponent(`${file} is missing, so the Wallpapers window has nothing to show`)}`);
  return { opened: true, visible: true };
}

/* ---- commands -------------------------------------------------------------- */

function need(a, k) {
  const v = a && a[k];
  if (v === undefined || v === null || v === '') throw new Error(`that needs a "${k}"`);
  return v;
}

/** One of Owen's own wallpapers. The library-only commands (remove, props, thumb) use this. */
function needItem(a) {
  const id = String(need(a, 'id'));
  if (PR.isPresetId(id)) {
    const p = PR.find(S.presets, id);
    throw new Error(`"${p.title}" is one of Mantle's built-in wallpapers: it cannot be removed or changed, only picked`);
  }
  const it = S.lib && S.lib.get(id);
  if (!it) throw new Error(`there is no wallpaper "${id}" in the library (it may have just been removed)`);
  return it;
}

/** Either kind: one of Owen's or a built-in one (set, status). */
function needAny(a) {
  const id = String(need(a, 'id'));
  if (!PR.isPresetId(id)) return needItem(a);
  const p = PR.find(S.presets, id);
  if (p.gone) throw new Error(`"${p.title}" cannot be used: ${p.gone}`);
  return p;
}

function coerce(def, value, itemDir) {
  switch (def.type) {
    case 'slider': {
      const n = Number(value);
      if (!Number.isFinite(n)) throw new Error(`"${def.text || 'that slider'}" needs a number`);
      return Math.min(Number(def.max), Math.max(Number(def.min), n));
    }
    case 'checkbox': return !!value;
    case 'dropdown':
    case 'scalerDropdown': {
      const i = Math.round(Number(value));
      const n = Array.isArray(def.items) ? def.items.length : 0;
      if (!(i >= 0 && i < n)) throw new Error(`"${def.text || 'that list'}" has no choice number ${value}`);
      return i;
    }
    case 'color': {
      const s = String(value);
      if (!/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(s)) throw new Error(`"${s}" is not a colour like #1a2b3c`);
      return s;
    }
    case 'folderDropdown': {
      const s = String(value);
      if (!W.folderOptions(itemDir, def).includes(s)) throw new Error(`"${s}" is not in the wallpaper's ${def.folder || ''} folder`);
      return s;
    }
    case 'textbox': return String(value).slice(0, 2000);
    case 'button': return true;
    default: throw new Error(`Mantle does not know how to set a "${def.type}" property`);
  }
}

function applyProp(item, name, value) {
  if (selectedItem() !== item) return;
  if (item.type === 'web') {
    const dir = S.lib.itemDir(item.id);
    const p = W.propsFor(item, dir);
    const list = W.sendableProps({ [name]: p.defs[name] }, { [name]: value });
    const v = list.length ? list[0][1] : value;
    sendTo(S.desktopWin, 'wallpaper.prop', { id: item.id, name, value: v });
  } else {
    pushDesktop();   // same url: the page re-reads the look without reloading the video
  }
}

const STATUS = new Set(['loading', 'playing', 'ready', 'error', 'note']);
const MAX_THUMB = 4 * 1024 * 1024;   // a 480x270 JPEG is ~40 KB; this is room, not a target

const COMMANDS = {
  'wallpaper.open': async () => openLibrary(),
  'wallpaper.list': async () => listing(),

  // One of Owen's wallpapers or a built-in one: both are saved in library.json's `selected`.
  'wallpaper.set': async (a) => {
    const it = needAny(a);
    const h = healthOf(it);
    if (!h.ok) throw new Error(`"${it.title}" cannot play: ${h.reason}`);
    S.lib.data.selected = it.id;
    S.lib.save();
    S.runtime.delete(it.id);   // a fresh attempt gets a fresh verdict
    log(`set to ${it.id} (${it.preset ? 'built-in picture' : it.type})`);
    pushDesktop();
    checkNow();
    return { ok: true, id: it.id };
  },

  // The Built-in view's Shuffle: a random usable built-in photo in `category` ('All' or none for
  // any), never the one on the desktop now unless it is the only one. Set like a click on it.
  'wallpaper.shuffle': async (a) => {
    const P = S.presets;
    if (!P || !P.ok) throw new Error(`the built-in wallpapers cannot be read: ${P ? P.reason : 'they have not been read yet'}`);
    const category = a && a.category ? String(a.category) : 'All';
    if (category !== 'All' && !P.categories.includes(category)) throw new Error(`there is no built-in category "${category.slice(0, 40)}"`);
    const pick = PR.shuffle(P, category, S.lib.data.selected);
    if (!pick) throw new Error(category === 'All' ? 'none of the built-in photos can be used right now' : `none of the ${category} photos can be used right now`);
    await COMMANDS['wallpaper.set']({ id: pick.id });
    return { ok: true, id: pick.id, title: pick.title };
  },

  // A built-in photo's credit: its Unsplash page, in the default browser. Only the catalog's own
  // https URL for that id is ever opened, never a URL from the page. A test run opens nothing.
  'wallpaper.creditOpen': async (a) => {
    const id = String(need(a, 'id'));
    const p = PR.isPresetId(id) ? PR.find(S.presets, id) : null;
    if (!p || p.gone) throw new Error('only a built-in wallpaper has a photo page');
    if (!p.creditUrl) throw new Error(`"${p.title}" has no photo page in Mantle's list`);
    if (S.ctx && S.ctx.test) return { ok: true, dryRun: true, url: p.creditUrl, reason: `Test run, nothing opened: Mantle would open ${p.creditUrl}` };
    const { shell } = require('electron');
    await shell.openExternal(p.creditUrl);
    return { ok: true, url: p.creditUrl };
  },

  // Undo over "are you sure" (the brief): the folder is moved aside, and only deleted once the
  // Undo in the Wallpapers window has had UNDO_MS to be clicked (or at the next start).
  'wallpaper.remove': async (a) => {
    const it = needItem(a);
    const index = S.lib.data.items.indexOf(it);
    const wasSelected = S.lib.data.selected === it.id;
    const wasRemoved = S.lib.data.removed.includes(it.id);
    S.lib.data.items = S.lib.data.items.filter((x) => x !== it);
    if (it.origin && it.origin.from === 'lively' && !wasRemoved) S.lib.data.removed.push(it.id);
    if (wasSelected) {
      const next = S.lib.data.items.find((x) => S.lib.health(x).ok);
      S.lib.data.selected = next ? next.id : null;
      pushDesktop();   // first, so the desktop lets go of the file before its folder moves
    }
    const aside = await moveAside(it.id);
    S.runtime.delete(it.id);
    S.lib.save();
    const undo = { item: it, index, wasSelected, wasRemoved, aside };
    undo.timer = setTimeout(() => { purgeRemoved(it.id).catch(() => {}); }, UNDO_MS);
    if (undo.timer.unref) undo.timer.unref();
    const old = S.undo.get(it.id);
    if (old) clearTimeout(old.timer);
    S.undo.set(it.id, undo);
    log(`removed ${it.id}; undo open for ${UNDO_MS / 1000} s; Lively's own files were not touched`);
    pushDesktop();
    return { ok: true, selected: S.lib.data.selected, undoMs: UNDO_MS };
  },

  'wallpaper.undoRemove': async (a) => {
    const id = String(need(a, 'id'));
    const u = S.undo.get(id);
    if (!u) throw new Error('it is too late to undo that: the wallpaper has already been deleted');
    clearTimeout(u.timer);
    S.undo.delete(id);
    const dir = S.lib.itemDir(id);
    if (u.aside) await renameRetry(u.aside, dir);
    S.lib.data.items.splice(Math.min(u.index, S.lib.data.items.length), 0, u.item);
    if (!u.wasRemoved) S.lib.data.removed = S.lib.data.removed.filter((r) => r !== id);
    if (u.wasSelected) S.lib.data.selected = id;
    S.lib.save();
    log(`restored ${id}`);
    pushDesktop();
    if (u.wasSelected) checkNow();
    return { ok: true, id };
  },

  // The Pause button: held until pressed again, across restarts (library.json).
  'wallpaper.setPaused': async (a) => {
    const on = !!(a && a.paused);
    S.lib.data.userPaused = on;
    S.lib.save();
    log(on ? 'paused by hand' : 'resumed by hand');
    decide(null);
    checkNow();
    return { ok: true, paused: on };
  },

  'wallpaper.add': async (a) => {
    let paths = Array.isArray(a && a.paths) ? a.paths.slice(0, MAX_ADD + 1) : [];
    if (!paths.length) {
      const folder = a && a.pick === 'folder';
      const opts = folder
        ? { title: 'Add an HTML wallpaper folder', properties: ['openDirectory', 'multiSelections'] }
        : {
          title: 'Add wallpapers',
          properties: ['openFile', 'multiSelections'],
          filters: [
            { name: 'Wallpapers', extensions: ['mp4', 'm4v', 'webm', 'ogv', 'mov', 'gif', 'jpg', 'jpeg', 'png', 'webp', 'bmp', 'avif', 'zip'] },
            { name: 'All files', extensions: ['*'] },
          ],
        };
      const r = alive(S.libraryWin) ? await dialog.showOpenDialog(S.libraryWin, opts) : await dialog.showOpenDialog(opts);
      if (r.canceled) return { canceled: true, results: [] };
      paths = r.filePaths;
    }
    return addPaths(paths);
  },

  'wallpaper.props': async (a) => {
    const it = needItem(a);
    const dir = S.lib.itemDir(it.id);
    const p = W.propsFor(it, dir);
    const options = {};
    for (const k of Object.keys(p.defs)) if (p.defs[k].type === 'folderDropdown') options[k] = W.folderOptions(dir, p.defs[k]);
    return { id: it.id, title: it.title, type: it.type, defs: p.defs, values: p.values, options, reason: p.reason };
  },

  'wallpaper.prop': async (a) => {
    const it = needItem(a);
    const name = String(need(a, 'name'));
    const dir = S.lib.itemDir(it.id);
    const p = W.propsFor(it, dir);
    const def = p.defs[name];
    if (!def) throw new Error(`"${it.title}" has no property called "${name}"`);
    const v = coerce(def, a.value, dir);
    if (def.type !== 'button') {
      it.values = Object.assign({}, it.values, { [name]: v });
      if (a.persist !== false) S.lib.save();
    }
    applyProp(it, name, v);
    return { ok: true, name, value: v };
  },

  'wallpaper.propsReset': async (a) => {
    const it = needItem(a);
    it.values = {};
    S.lib.save();
    if (selectedItem() === it) pushDesktop();
    return { ok: true };
  },

  'wallpaper.reimport': async (a) => {
    const report = await runImport(!!(a && a.force), a && a.force ? 'the Wallpapers window asked, including removed ones' : 'the Wallpapers window asked');
    return report;
  },

  // A thumbnail the Wallpapers window drew from a video's own frames -- or the reason it could not,
  // which for a file Owen just added means Chromium cannot decode it, and says so on the card.
  'wallpaper.thumb': async (a) => {
    const it = needItem(a);
    if (a.error) {
      if (!it.thumb) {
        it.error = `Mantle can't play this video: ${String(a.error).slice(0, 300)}`;
        S.lib.save();
        log(`${it.id}: its video could not be decoded`);
        if (selectedItem() === it) pushDesktop(); else pushLibrary();
      }
      return { ok: true };
    }
    const raw = String(a.dataUrl || '');
    if (raw.length > MAX_THUMB) throw new Error('that thumbnail is too big');
    const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(raw);
    if (!m) throw new Error('the thumbnail did not arrive as a JPEG data URL');
    const name = 'mantle-thumb.jpg';
    await fsp.writeFile(path.join(S.lib.itemDir(it.id), name), Buffer.from(m[1], 'base64'));
    it.thumb = name;
    delete it.error;
    S.lib.save();
    pushLibrary();
    return { ok: true, thumb: name };
  },

  // The desktop page's word on what it is drawing: loading, playing, ready (a web page loaded),
  // error (with the reason), or a note (a web wallpaper's own script error, kept for its card).
  'wallpaper.status': async (a) => {
    // Only for a wallpaper in the library or the built-in catalog, and only the five words the
    // desktop page says: anything else would grow S.runtime without bound (one entry per made-up
    // id) or put junk on a card.
    const id = needAny(a).id;
    const st = String(need(a, 'state'));
    if (!STATUS.has(st)) throw new Error(`"${st.slice(0, 40)}" is not a wallpaper state`);
    a.reason = String(a.reason || '').slice(0, 500);
    const prev = S.runtime.get(id) || { notes: [] };
    if (st === 'note') {
      const notes = prev.notes.concat(String(a.reason || '')).slice(-5);
      S.runtime.set(id, Object.assign({}, prev, { notes }));
      pushLibrary();
      return { ok: true };
    }
    S.runtime.set(id, { state: st, reason: String(a.reason || ''), notes: st === 'loading' ? [] : prev.notes, at: Date.now() });
    if (st === 'error') log(`the desktop could not play ${id}`);
    syncState();
    return { ok: true };
  },

  // The window's own controls: it is frameless, so its close and minimise are page buttons.
  'wallpaper.window': async (a) => {
    const win = S.libraryWin;
    if (!alive(win)) return { ok: false, reason: 'the Wallpapers window is not open' };
    const act = a && a.action;
    if (act === 'close') win.close();
    else if (act === 'minimize') win.minimize();
    else if (act === 'maximize') { if (win.isMaximized()) win.unmaximize(); else win.maximize(); }
    else throw new Error(`the Wallpapers window has no "${act}" control`);
    return { ok: true };
  },
};

/* ---- start ---------------------------------------------------------------- */

/**
 * Called by main.js once, after app 'ready' and after the desktop window exists (or not, with
 * --no-desktop: the library and its window still work, there is just nothing to draw on).
 *   ctx: { root, test, state, sidecar, commands, desktopWin }
 */
/* --lg-ground in each theme (ui/shared/glass-light.css), for the window's colour before its page paints. */
function groundNow() {
  const t = S.ctx && S.ctx.theme ? S.ctx.theme.get() : 'light';
  return t === 'dark' ? '#1B1C1F' : '#F4F6FA';
}

function start(ctx) {
  if (S.started) return;
  S.started = true;
  S.ctx = ctx;
  S.desktopWin = ctx.desktopWin || null;
  // lane dm-core: the Wallpapers window's ground follows Mantle's appearance live (the page follows by itself)
  if (ctx.theme && typeof ctx.theme.onChange === 'function') {
    ctx.theme.onChange(() => { const w = S.libraryWin; if (w && !w.isDestroyed()) { try { w.setBackgroundColor(groundNow()); } catch (_) { /* closing */ } } });
  }
  Object.assign(ctx.commands, COMMANDS);
  registerProtocol();

  S.settings = W.readLivelySettings(W.livelyRoot());
  S.rules = W.playbackRules(S.settings);
  // The built-in catalog first: library.json may hold a built-in pick, which load() must keep.
  S.presets = PR.load(ctx.presetsDir || PR.dirFor(ctx.root || path.resolve(__dirname, '..')));
  log(S.presets.ok
    ? `built-in wallpapers: ${S.presets.items.length} (${S.presets.items.filter((x) => !PR.health(x).ok).length} unusable)${S.presets.note ? `; ${S.presets.note}` : ''}`
    : `built-in wallpapers unavailable: ${S.presets.reason}`);
  S.lib = new W.Library(path.join(app.getPath('userData'), 'wallpapers'), { keepSelected: PR.isPresetId });
  S.lib.load();
  if (S.lib.loadError) log(S.lib.loadError);
  // Removed last time and never undone (Mantle quit inside the undo window): deleted now.
  fsp.rm(removedDir(), { recursive: true, force: true }).catch(() => {});
  log(`library: ${S.lib.data.items.length} wallpapers; rules from ${S.rules.from} (full screen: ${S.rules.fullscreen}, focus: ${S.rules.focus}, detection: ${S.rules.algorithm})`);

  // The launcher's "Wallpapers" entry (lib/launcher-index.js) and anything else that wants the
  // window raise this on app, which survives the launcher index being re-required.
  app.on('mantle-open', (target) => { if (target === 'wallpapers') openLibrary(); });

  watchDesktop(S.desktopWin);

  syncState();
  startRules();
  checkNow();

  // First run (or a library.json that never finished an import): bring Lively's library over.
  if (!S.lib.data.lively || !S.lib.data.lively.importedAt) {
    runImport(false, S.lib.data.items.length ? 'the last import never finished' : 'first run').catch((err) => {
      log(`the import from Lively failed: ${err.message}`);
      S.lib.data.lively = { importedAt: null, report: { ok: false, reason: `the import failed: ${err.message}`, lines: [] } };
      syncState();
    });
  } else {
    pushDesktop();
  }

  if (ctx.test && process.env.MANTLE_WALL_PROBE) {
    // Test-only: screenshots and CPU numbers for the report. Never loaded otherwise.
    try { require('../tools/wallpaper-probe').run(module.exports, process.env.MANTLE_WALL_PROBE); } catch (err) { log(`probe failed to start: ${err.message}`); }
  }
}

function watchDesktop(win) {
  if (!alive(win)) return;
  // A reload rebuilds the page, which asks again through replay(); a crash is a state change.
  win.webContents.on('render-process-gone', (_e, d) => {
    if (S.desktopWin !== win) return;
    const it = selectedItem();
    if (it) S.runtime.set(it.id, { state: 'error', reason: `the desktop page stopped while drawing it (${d.reason}); choosing it again restarts it`, notes: [] });
    syncState();
  });
}

/**
 * main.js hands over a NEW desktop window here when it has to make one again (an explorer restart
 * that destroyed the old one, a --no-desktop start that later gets one). Without this the wallpaper
 * kept sending to the dead window and the new desktop stayed on Windows' own picture.
 */
function setDesktopWin(win) {
  S.desktopWin = win || null;
  if (!S.ctx) return { ok: false };
  watchDesktop(S.desktopWin);
  pushDesktop();
  return { ok: true };
}

/** mantle.on(...) replay for this file's events: the page's first frame is never empty. */
function replay(name) {
  if (name === 'wallpaper') return S.lib ? { has: true, payload: desktopPayload() } : { has: false };
  if (name === 'wallpaper.library') return S.lib ? { has: true, payload: listing() } : { has: false };
  if (name === 'wallpaper.pause') return { has: true, payload: { paused: S.pause.paused, unload: S.pause.unload, reason: S.pause.reason } };
  return { has: false };
}

/** Game mode holds the wallpaper paused (text = the reason shown), or lets go (null). */
function gameHold(text) {
  S.gameHold = text || null;
  checkNow().catch(() => {});
  return { held: !!S.gameHold, pause: S.pause };
}

/** Mantle rests while a game runs (main.js restMantle): text = "VALORANT runs" unloads the
 * wallpaper and stops the foreground poll; null mounts it again and checks the rules at once.
 * Returns what it did, for the rest's log line: {unloaded, had} (had = a wallpaper was showing). */
function rest(text) {
  const was = !!S.rest;
  S.rest = text || null;
  if (!S.ctx) return { unloaded: false, had: false };
  const had = !!(S.lib && selectedItem());
  decide(null);
  if (!S.rest && was) checkNow().catch(() => {});
  return { unloaded: !!S.rest, had };
}

module.exports = {
  start, replay, openLibrary, gameHold, rest, setDesktopWin,
  // for tools/wallpaper-probe.js only
  _probe: {
    S, COMMANDS, listing, desktopPayload, UNDO_MS, expandZip, refusePath, scrub,
    setOverride(mode) { S.override = mode; checkNow(); decide(null); },
    decide,
    checkNow,
    desktopWin: () => S.desktopWin,
    libraryWin: () => S.libraryWin,
  },
};

'use strict';
/*
 * _clips-core.js - the PURE half of Clips + the Win+G Record panel (lane mantle-clips, 2026-10-15).
 * No Electron, no fs, no sidecar: lib/features/clips.js feeds it and clips.test.js proves it.
 *
 *   parseName(name)            Game Bar's own file names -> {title, at}
 *   gallery(entries, o)        the Captures folder listing -> items newest first, grouped by day
 *   thumbKey(item)             the on-disk thumbnail cache name for one file version
 *   trimName(name, a, b, has)  the NEW file a trim writes ("never overwrite")
 *   route(s)                   what Win+G does right now: Mantle's panel, or Windows' Game Bar
 *   recordPlan(s)              whether the panel's Record button may press Win+Alt+R for Owen
 *   clock(ms)                  0:07, 1:02:03
 */

const VIDEO = new Set(['.mp4', '.webm', '.mkv', '.mov']);
const IMAGE = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function extOf(name) {
  const m = /\.[^.\\/]+$/.exec(String(name || ''));
  return m ? m[0].toLowerCase() : '';
}
function kindOf(name) {
  const e = extOf(name);
  return VIDEO.has(e) ? 'video' : IMAGE.has(e) ? 'image' : null;
}

/*
 * Game Bar's names, measured on Owen's folder (2026-10-15):
 *   videos       "<window title> 2026-09-26 16-52-26.mp4"
 *   screenshots  "<window title> 11_22_2025 4_29_39 PM.png"
 * Anything else (Mantle's own recordings, a renamed file) keeps its stem as the title and the
 * file's own time.
 */
function parseName(name) {
  const stem = String(name || '').replace(/\.[^.]+$/, '');
  let m = /^(.*?)\s+(\d{4})-(\d{2})-(\d{2}) (\d{2})-(\d{2})-(\d{2})$/.exec(stem);
  if (m) return { title: tidyTitle(m[1]), at: new Date(+m[2], +m[3] - 1, +m[4], +m[5], +m[6], +m[7]).getTime() };
  m = /^(.*?)\s+(\d{1,2})_(\d{1,2})_(\d{4}) (\d{1,2})_(\d{2})_(\d{2}) ([AP]M)$/.exec(stem);
  if (m) {
    let h = +m[5] % 12;
    if (m[8] === 'PM') h += 12;
    return { title: tidyTitle(m[1]), at: new Date(+m[4], +m[2] - 1, +m[3], h, +m[6], +m[7]).getTime() };
  }
  return { title: tidyTitle(stem), at: null };
}
/* "Northwind — 6 active tasks - Opera" stays as it is; Game Bar pads some titles ("VALORANT  "). */
function tidyTitle(t) { return String(t || '').replace(/\s+/g, ' ').trim() || 'Untitled'; }

function dayKey(ms) { const d = new Date(ms); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; }
function dayLabel(ms, now) {
  const d = new Date(ms);
  if (dayKey(ms) === dayKey(now)) return 'Today';
  if (dayKey(ms) === dayKey(now - 864e5)) return 'Yesterday';
  const same = d.getFullYear() === new Date(now).getFullYear();
  return `${MONTHS[d.getMonth()]} ${d.getDate()}${same ? '' : `, ${d.getFullYear()}`}`;
}

function sizeWords(n) {
  if (!(n >= 0)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1048576).toFixed(n < 10 * 1048576 ? 1 : 0)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
}

function clock(ms) {
  const s = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}

/*
 * entries: [{name, size, mtimeMs, birthtimeMs}] straight from the folder; meta: {name: {durationMs,
 * width, height}} from the cache. o: {now, filter: 'all'|'video'|'image'}. -> {items, groups, counts}.
 * The newest first by the time in the NAME (when it was taken), else the file's own birth time:
 * a copy or a trim made today of an old clip sorts by its own name's time, which is what Owen sees.
 */
function gallery(entries, meta, o) {
  const opts = o || {};
  const now = opts.now || Date.now();
  const items = [];
  for (const e of entries || []) {
    if (!e || !e.name) continue;
    const kind = kindOf(e.name);
    if (!kind) continue;
    const p = parseName(e.name);
    const at = p.at || Math.min(e.birthtimeMs || Infinity, e.mtimeMs || Infinity);
    const m = (meta && meta[e.name]) || {};
    items.push({
      name: e.name, kind, title: p.title, at: Number.isFinite(at) ? at : 0, size: e.size || 0, sizeWords: sizeWords(e.size),
      mtimeMs: e.mtimeMs || 0, durationMs: m.durationMs || null, width: m.width || null, height: m.height || null,
      growing: !!e.growing,
    });
  }
  items.sort((a, b) => (b.at - a.at) || (a.name < b.name ? -1 : 1));
  const counts = { all: items.length, video: items.filter((i) => i.kind === 'video').length, image: items.filter((i) => i.kind === 'image').length };
  const shown = opts.filter === 'video' || opts.filter === 'image' ? items.filter((i) => i.kind === opts.filter) : items;
  const groups = [];
  for (const it of shown) {
    const label = dayLabel(it.at, now);
    if (!groups.length || groups[groups.length - 1].label !== label) groups.push({ label, items: [] });
    groups[groups.length - 1].items.push(it);
  }
  return { items: shown, groups, counts };
}

/* FNV-1a over the name, size and write time: a new version of a file is a new thumbnail. */
function thumbKey(it) {
  const s = `${String(it.name).toLowerCase()}|${it.size}|${Math.round(it.mtimeMs || 0)}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return `${h.toString(16).padStart(8, '0')}-${(s.length).toString(16)}.png`;
}

/* "Clip 2026-09-26 16-52-26.mp4", 11.2 s .. 40 s -> "Clip 2026-09-26 16-52-26 (0m11s-0m40s).mp4",
   and " 2", " 3" until the name is free. `has(name)` says whether a name is taken. */
function trimName(name, startMs, endMs, has) {
  const ext = extOf(name) || '.mp4';
  const stem = String(name).slice(0, String(name).length - ext.length).replace(/ \(\d+m\d+s-\d+m\d+s\)( \d+)?$/, '');
  const t = (ms) => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`; };
  const base = `${stem} (${t(startMs)}-${t(endMs)})`;
  for (let i = 1; i < 1000; i++) {
    const n = `${base}${i === 1 ? '' : ` ${i}`}${ext}`;
    if (!has || !has(n)) return n;
  }
  return `${base} ${Date.now()}${ext}`;
}

/*
 * What Win+G does now. s: {
 *   on        the feature is on and healthy (else the chord is not even taken: Windows has it),
 *   panel     the Win+G option ("Win+G opens Mantle's Record panel"),
 *   quns      SHQueryUserNotificationState of the moment (3 = exclusive D3D full screen),
 *   target    the window in front {exe, title, cls, fullscreen, desktop, mantle},
 *   game      a game is in front or Mantle rests for one (route words only),
 * } -> {to: 'panel'|'gamebar', why}.
 * EXCLUSIVE FULL SCREEN is the one case a window cannot show over a game: Windows' Game Bar has its
 * own way there, so Win+G is handed to it, with one plain log line.
 */
function route(s) {
  if (!s || !s.on) return { to: 'gamebar', why: 'Mantle Clips is off or not healthy, so Win+G is Windows\' Game Bar' };
  if (s.panel === false) return { to: 'gamebar', why: 'the Win+G setting is off, so Win+G opens Windows\' Game Bar' };
  if (s.quns === 3) return { to: 'gamebar', why: 'an exclusive full-screen game is in front, where no window can show over it, so Win+G opened Windows\' Game Bar' };
  return { to: 'panel', why: s.game ? 'a game in a window or borderless: the panel shows over it as a normal window' : 'the panel' };
}

const GAME_EXES = ['valorant-win64-shipping.exe', 'valorant.exe', 'robloxplayerbeta.exe', 'minecraft.windows.exe', 'fortniteclient-win64-shipping.exe',
  'cs2.exe', 'csgo.exe', 'r5apex.exe', 'rocketleague.exe', 'gta5.exe', 'overwatch.exe', 'league of legends.exe', 'escapefromtarkov.exe', 'cyberpunk2077.exe'];
const GAME_PREFIXES = ['riotclient', 'minecraft', 'valorant', 'leagueclient', 'roblox'];
function baseName(p) { return String(p || '').split(/[\\/]/).pop().toLowerCase(); }
/* The same list the top bar's game check uses (sidecar/MenuBar.cs KnownGame), plus Minecraft Java. */
function knownGame(target) {
  if (!target) return null;
  const f = baseName(target.exe);
  if (!f) return null;
  if (GAME_EXES.includes(f)) return f;
  if (GAME_PREFIXES.some((p) => f.startsWith(p))) return f;
  if ((f === 'javaw.exe' || f === 'java.exe') && /^minecraft/i.test(target.title || '')) return 'Minecraft';
  return null;
}

/*
 * May the Record button press Win+Alt+R (Windows' own recording shortcut) for Owen? s: {target,
 * resting, quns, recording}. -> {can, how: 'keys'|'hint'|'none', why}.
 *   'keys'  the app in front is an ordinary window: the sidecar sends Win+Alt+R in ONE SendInput call
 *           (measured 2026-10-15: Windows records a stand-in window that way).
 *   'hint'  a GAME is in front (or Mantle rests for one): NO synthetic key ever reaches a game
 *           (anti-cheat reads injected input), so the panel shows "Win+Alt+R" for Owen to press.
 *   'none'  nothing Windows can record: the desktop, File Explorer, the lock screen, Mantle itself.
 */
function recordPlan(s) {
  const t = s && s.target;
  const game = knownGame(t) || (s && s.resting ? 'game' : null) || (s && s.quns === 3 ? 'exclusive' : null);
  if (game) return { can: false, how: 'hint', game, why: 'Mantle never sends keys to a game: press Win+Alt+R to record it with Windows\' own recorder' };
  if (!t || !t.hwnd || t.hwnd === '0') return { can: false, how: 'none', why: 'no app is in front to record' };
  if (t.desktop) return { can: false, how: 'none', why: 'Windows cannot record the desktop or File Explorer' };
  if (t.mantle) return { can: false, how: 'none', why: 'Mantle\'s own window is in front: click the app to record first' };
  return { can: true, how: 'keys', why: s && s.recording ? 'stops Windows\' recording' : 'records this window with Windows\' own recorder (Win+Alt+R)' };
}

/* A short label for the app in front: the exe's own name, else the title's last " - " part. */
function appLabel(t) {
  if (!t) return '';
  const f = baseName(t.exe).replace(/\.exe$/, '');
  const known = { opera: 'Opera', msedge: 'Edge', chrome: 'Chrome', firefox: 'Firefox', quartz: 'Quartz', helm: 'Helm', code: 'VS Code', discord: 'Discord', javaw: 'Minecraft' };
  if (known[f]) return known[f];
  const parts = String(t.title || '').split(' - ');
  const last = parts[parts.length - 1].trim();
  return last && last.length <= 28 ? last : (f ? f.charAt(0).toUpperCase() + f.slice(1) : 'this app');
}

module.exports = { parseName, gallery, thumbKey, trimName, route, recordPlan, knownGame, appLabel, clock, sizeWords, kindOf, extOf, dayLabel };

/*
 * WHERE THE RECORD PANEL GOES (lane corner-follow, 2026-10-17). Owen: no overlapping UI anywhere, and of
 * the corner: "just have them smoothly move up if the taskbar comes up". The window sits in the work area's
 * bottom-right corner (EDGE DIP in) as if the bar were not there (`low`); when the bar is up the page lifts
 * the card `reach` DIP inside a window that is `reach` taller (lib/bar-follow.js, the banners' mechanism).
 * Measured before (Owen's 1536x864 work area, the pill's resting shape {208,802,1120,62}): the window at
 * {1154, 864-h-6, 376, h} sat 174 x 56 DIP over the revealed pill (the card itself 156 x 38).
 *   o = { work, bar (ctx.host.barRect(): the RESTING shape, even while hidden), w, h (card + margins) }
 *   -> { low, reach, rest, h, w, full: h + reach }   (o.pill: ctx.host.bar.pill(), for rest)
 */
const EDGE = 6;
function panelSpot(o) {
  const BF = require('../bar-follow');
  const wa = (o && o.work) || { x: 0, y: 0, width: 1280, height: 720 };
  const w = Math.round(o.w), h = Math.round(Math.max(120, Math.min(Number(o.h) || 0, wa.height)));
  const low = { x: Math.round(wa.x + wa.width - w - EDGE), y: Math.round(wa.y + wa.height - h - EDGE), width: w, height: h };
  // never lifted past the work area's top (a tall panel on a short screen stays where it is). rest (lane
  // mantle-corner-follow2): with the bar HIDDEN the window's bottom on the hidden pill's top (o.pill, the bar's
  // pill at rest; lib/bar-follow.js liftsOver), never more than the reach: r1's card bottom 841 sat on that top.
  const { reach, rest } = BF.liftsOver(low, o.bar, wa, o.pill, low.y - wa.y);
  return { low, reach, rest, h, w, full: h + reach };
}
/** The card's screen rect inside the panel window `b` (its bounds now): the card is `h` minus the margins,
    at the window's bottom, `lift` DIP up (0 when the window is placed straight at the target). */
function panelCard(b, h, lift, margin) {
  if (!b) return null;
  const m = Math.max(0, margin || 0);
  return { x: b.x + m, y: b.y + b.height - Math.max(0, lift || 0) - h + m, width: b.width - 2 * m, height: h - 2 * m };
}
module.exports.panelSpot = panelSpot;
module.exports.panelCard = panelCard;
module.exports.PANEL_EDGE = EDGE;

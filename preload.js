'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

/*
 * The one and only bridge between Mantle's pages and the main process.
 *
 * Every renderer runs with contextIsolation on and sandbox on: no require(), no
 * node globals, no fs. The bar, the launcher and the desktop are plain browser
 * scripts, and `window.mantle` below is the entire surface they get. Anything a
 * page needs that is not here is a change to THIS file plus a handler in main.js,
 * on purpose -- it keeps the list of things a page can do short enough to read.
 *
 * Two shapes:
 *   mantle.call(name, args) -> Promise<result>, rejecting with an Error whose
 *       message is plain words fit to put straight on screen.
 *   mantle.on(event, cb)    -> unsubscribe function. 'windows' and 'state' also
 *       fire once, immediately, with whatever main already knows, so a page never
 *       has to render an empty frame while it waits for the first push.
 */

const CALL = 'mantle:call';
const EVENT = 'mantle:event';
const REPLAY = 'mantle:replay';
const THEME_NOW = 'mantle:theme-now';

/*
 * MANTLE'S APPEARANCE (lane dm-core, 2026-10-08; lib/theme.js decides it). Every Mantle page gets
 * <html data-theme="dark|light"> BEFORE ITS FIRST PAINT, and the attribute follows every change LIVE,
 * without a reload; after a live change `mantle-theme` {detail:{theme}} fires on window, so a page that
 * draws colours in JS (canvas, SVG built in JS) repaints from the CSS variables.
 *
 * Before first paint: this file runs before the page's HTML is parsed, so it asks main ONCE,
 * synchronously (one tiny IPC, answered from memory), and stamps the attribute the moment <html>
 * exists. A reload runs this file again and asks again, so a page reloaded after a change, a window
 * made later and a window kept hidden all start right. A page that could not ask (main gone) starts
 * light, Mantle's original look, and says so in its console.
 */
let themeNow = 'light';
/*
 * LOOK SYNC (lane looksync-mantle, 2026-10-10; lib/look-host.js): the shared accent hue and dark glass
 * from Helm and Quartz arrive as --lg-* overrides, { '--lg-blur': 'blur(9px)', ... }, stamped INLINE on
 * <html> next to data-theme (before first paint, and live with the 'theme' event). Empty at the default
 * look, so a page then shows the stylesheet's own values exactly. Only the names stamped here are ever
 * removed again; a page's own inline properties are left alone.
 */
let lookNow = {};
let lookStamped = new Set();
const isLook = (v) => !!v && typeof v === 'object' && !Array.isArray(v) &&
  Object.keys(v).every((k) => /^--lg-[a-z0-9-]+$/.test(k) && typeof v[k] === 'string' && v[k].length < 200);
try {
  const t = ipcRenderer.sendSync(THEME_NOW, 'look');
  const theme = t && typeof t === 'object' ? t.theme : t;
  if (theme === 'dark' || theme === 'light') themeNow = theme;
  else console.error(`Mantle did not say which theme to show (it answered ${JSON.stringify(t)}), so this page starts light`);
  if (t && typeof t === 'object' && t.look !== undefined) {
    if (isLook(t.look)) lookNow = t.look;
    else console.error('Mantle sent look overrides this page cannot use, so it shows the default look:', t.look);
  }
} catch (err) {
  console.error('Mantle could not be asked which theme to show, so this page starts light:', err);
}
function stampTheme() {
  const el = document.documentElement;
  if (!el) return false;
  if (el.getAttribute('data-theme') !== themeNow) el.setAttribute('data-theme', themeNow);
  const next = new Set(Object.keys(lookNow));
  for (const k of lookStamped) if (!next.has(k)) el.style.removeProperty(k);
  for (const k of next) if (el.style.getPropertyValue(k) !== lookNow[k]) el.style.setProperty(k, lookNow[k]);
  lookStamped = next;
  return true;
}
if (!stampTheme()) {
  // MutationObserver callbacks run as microtasks inside the parser's task, so this lands before any
  // frame is painted, the moment the parser inserts <html>.
  const mo = new MutationObserver(() => { if (stampTheme()) mo.disconnect(); });
  mo.observe(document, { childList: true });
}
function applyTheme(payload) {
  const t = payload && (payload.theme === 'dark' || payload.theme === 'light') ? payload.theme : null;
  if (!t) return;
  let changed = t !== themeNow;
  themeNow = t;
  // a payload without 'look' (an older sender) leaves the overrides as they are
  if (payload.look !== undefined) {
    const look = isLook(payload.look) ? payload.look : {};
    if (!isLook(payload.look)) console.error('Mantle sent look overrides this page cannot use, so it shows the default look:', payload.look);
    if (JSON.stringify(look) !== JSON.stringify(lookNow)) { lookNow = look; changed = true; }
  }
  stampTheme();
  // 'mantle-theme' also after a look-only change: every surface re-reads its tokens and re-bakes its glass
  if (!changed) return;
  try {
    window.dispatchEvent(new CustomEvent('mantle-theme', { detail: { theme: t } }));
  } catch (err) {
    console.error('mantle-theme could not be fired:', err);
  }
}

/** event name -> Set of callbacks */
const listeners = new Map();

ipcRenderer.on(EVENT, (_e, msg) => {
  if (!msg || typeof msg.name !== 'string') return;
  if (msg.name === 'theme') applyTheme(msg.payload);   // the page's own listeners run after it is painted
  deliver(msg.name, msg.payload);
});

function deliver(name, payload) {
  const set = listeners.get(name);
  if (!set) return;
  for (const cb of Array.from(set)) {
    try {
      cb(payload);
    } catch (err) {
      // One page's broken handler must not stop the other handlers, and it must
      // not vanish either: it lands in that page's own console with its name.
      console.error(`mantle.on("${name}") handler threw:`, err);
    }
  }
}

async function call(name, args) {
  if (typeof name !== 'string' || !name) throw new Error('mantle.call needs a command name');
  let res;
  try {
    res = await ipcRenderer.invoke(CALL, name, args === undefined ? {} : args);
  } catch (err) {
    // An invoke that throws means main's handler threw outside our own try/catch,
    // or the channel is gone. Either way the page gets a sentence, not [object].
    throw new Error(`"${name}" could not reach Mantle: ${err && err.message ? err.message : String(err)}`);
  }
  if (res && res.ok) return res.result;
  throw new Error(res && res.error ? res.error : `"${name}" failed and did not say why`);
}

function on(event, cb) {
  if (typeof event !== 'string' || typeof cb !== 'function') {
    throw new Error('mantle.on(event, callback) needs an event name and a function');
  }
  let set = listeners.get(event);
  if (!set) {
    set = new Set();
    listeners.set(event, set);
  }
  set.add(cb);

  // Replay the current value for the events that describe a standing situation
  // rather than a moment. Main answers {has:false} for the rest.
  ipcRenderer.invoke(REPLAY, event).then((res) => {
    if (!set.has(cb)) return;        // unsubscribed before the reply came back
    if (res && res.has) {
      try { cb(res.payload); } catch (err) { console.error(`mantle.on("${event}") handler threw:`, err); }
    }
  }).catch((err) => {
    console.error(`mantle.on("${event}") could not read the current value:`, err);
  });

  return function unsubscribe() {
    const s = listeners.get(event);
    if (s) s.delete(cb);
  };
}

/*
 * The disk path of a File the user dropped onto a page (the Wallpapers window takes videos,
 * pictures and wallpaper folders by drag and drop). File.path is gone from Electron's renderers;
 * webUtils is the supported way, and it only ever answers for a File the user handed the page,
 * so it gives a page no way to name a path it was not given. '' when there is none.
 */
function pathForFile(file) {
  try { return webUtils.getPathForFile(file) || ''; } catch (_) { return ''; }
}

contextBridge.exposeInMainWorld('mantle', { call, on, pathForFile });

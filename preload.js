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

/** event name -> Set of callbacks */
const listeners = new Map();

ipcRenderer.on(EVENT, (_e, msg) => {
  if (!msg || typeof msg.name !== 'string') return;
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

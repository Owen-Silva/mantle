'use strict';
const fs = require('fs');
const path = require('path');

/*
 * The launcher's app index, wrapped so a missing or broken index module is a
 * visible state and never a crash.
 *
 * lib/launcher-index.js is another lane's file. It exports:
 *   build({ icon }) -> Promise<{ items, sources }>
 *   search(q, items) -> items
 *   launch(item) -> Promise<{ ok, reason? }>
 * where `icon(path)` is OUR function: it asks the sidecar for a file's icon as a
 * data URL, or resolves null. We require it lazily (not at the top of main.js)
 * so that Mantle still boots while that file does not exist yet, and so that a
 * syntax error in it shows up as one bad tile in the launcher rather than a
 * window that never opens.
 *
 * `sources` is whatever the index module reports it read (Start Menu, PATH,
 * UWP, ...). We add our own source row when the module itself is the problem,
 * using the same shape, so the launcher can render one list either way.
 */

const REBUILD_MS = 10 * 60 * 1000;   // a fresh sweep every ten minutes
const SEARCH_LIMIT = 12;

class Apps {
  /**
   * @param {string} modulePath  absolute path to lib/launcher-index.js
   * @param {(p:string)=>Promise<string|null>} icon  resolves a file's icon data URL
   */
  constructor({ modulePath, icon }) {
    this.modulePath = modulePath;
    this.icon = icon;
    this.cache = null;         // {items, sources}
    this.building = null;      // in-flight build promise, so two callers share one sweep
    this.builtAt = 0;
    // search() can mint rows that were never in the built index -- a typed URL
    // becomes {kind:'url', id:'url:...'} on the spot. launch() is given only an
    // id, so the last set of hits has to be remembered or those rows could never
    // be launched.
    this.lastHits = [];
  }

  /** A {items, sources} value that explains itself, used whenever the module is unusable. */
  _broken(reason) {
    return {
      items: [],
      sources: [{ name: 'launcher-index', count: 0, status: 'error', reason }],
    };
  }

  /**
   * Load the index module. Returns {mod} or {reason}. Never throws: a lane that
   * has not finished, or has shipped a typo, must not take the launcher down.
   */
  _load() {
    if (!fs.existsSync(this.modulePath)) {
      return { reason: 'lib/launcher-index.js missing (lane D)' };
    }
    let mod;
    try {
      // Cleared from the require cache so a rebuild picks up an edited module
      // without restarting Mantle -- handy while the launcher lane is still moving.
      delete require.cache[require.resolve(this.modulePath)];
      mod = require(this.modulePath);
    } catch (err) {
      return { reason: `lib/launcher-index.js would not load: ${err.message}` };
    }
    for (const fn of ['build', 'search', 'launch']) {
      if (typeof mod[fn] !== 'function') {
        return { reason: `lib/launcher-index.js does not export ${fn}() (lane D)` };
      }
    }
    return { mod };
  }

  /** Build (or return the cached) index. Resolves {items, sources}; never rejects. */
  async index({ refresh = false } = {}) {
    if (this.cache && !refresh && Date.now() - this.builtAt < REBUILD_MS) return this.cache;
    if (this.building) return this.building;

    this.building = (async () => {
      const loaded = this._load();
      if (loaded.reason) return this._broken(loaded.reason);
      try {
        const res = await loaded.mod.build({ icon: this.icon });
        const items = Array.isArray(res && res.items) ? res.items : [];
        const sources = Array.isArray(res && res.sources) ? res.sources : [];
        if (!Array.isArray(res && res.items)) {
          sources.push({ name: 'launcher-index', count: 0, status: 'error', reason: 'build() did not return an items array' });
        }
        return { items, sources };
      } catch (err) {
        return this._broken(`lib/launcher-index.js build() failed: ${err.message}`);
      }
    })();

    try {
      this.cache = await this.building;
      this.builtAt = Date.now();
      return this.cache;
    } finally {
      this.building = null;
    }
  }

  /** Top matches for a query. Empty array when the index module is unusable. */
  async search(q) {
    const idx = await this.index();
    const loaded = this._load();
    if (loaded.reason) return [];
    try {
      // NOT skipped when the index is empty: search() invents rows of its own
      // (a typed URL, a command) that do not depend on the index at all.
      const hits = loaded.mod.search(String(q == null ? '' : q), idx.items);
      const out = Array.isArray(hits) ? hits.slice(0, SEARCH_LIMIT) : [];
      this.lastHits = out;
      return out;
    } catch (err) {
      // The launcher shows "no results"; the reason belongs somewhere visible,
      // so we fold it into the index sources for the next apps.index call.
      this.cache = this._broken(`lib/launcher-index.js search() failed: ${err.message}`);
      return [];
    }
  }

  /** Launch by item id. Always resolves {ok, reason?} -- the launcher shows the reason. */
  async launch(id) {
    const idx = await this.index();
    // The index first, then the last search's hits: a synthetic row (a URL the
    // user typed) exists only in the hits.
    const item = idx.items.find((it) => it && it.id === id)
      || this.lastHits.find((it) => it && it.id === id);
    if (!item) {
      const why = idx.sources.find((s) => s && s.status === 'error');
      return { ok: false, reason: why ? why.reason : `nothing in the index has the id "${id}"` };
    }
    const loaded = this._load();
    if (loaded.reason) return { ok: false, reason: loaded.reason };
    try {
      const res = await loaded.mod.launch(item);
      if (res && typeof res.ok === 'boolean') return res;
      return { ok: false, reason: 'lib/launcher-index.js launch() did not say whether it worked' };
    } catch (err) {
      return { ok: false, reason: `could not launch ${item.name || id}: ${err.message}` };
    }
  }

  /** Start the ten-minute refresh. The timer is unref'd: it never holds the app open. */
  startRefresh() {
    this.stopRefresh();
    this._timer = setInterval(() => { this.index({ refresh: true }).catch(() => {}); }, REBUILD_MS);
    if (this._timer.unref) this._timer.unref();
  }

  stopRefresh() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }
}

module.exports = { Apps, REBUILD_MS, SEARCH_LIMIT, modulePathFor: (root) => path.join(root, 'lib', 'launcher-index.js') };

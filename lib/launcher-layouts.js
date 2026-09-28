'use strict';
/* launcher-layouts.js - the launcher's "Layout: Work" rows (lane layouts, 2026-09-27).
 *
 * lib/features/layouts.js owns the layouts; lib/launcher-index.js asks HERE for rows on every search
 * and hands a chosen row back through run(). This module is the bridge because lib/apps.js clears
 * launcher-index.js from the require cache on every rebuild, so a list kept THERE would be wiped;
 * this file is never cleared, so the feature's set() survives rebuilds.
 *
 * A row is an ordinary Settings-group row (ui/launcher/groups.js knows no "layout" kind):
 *   { id, kind:'setting', name:'Layout: Work', subtitle:'Window layout: 4 windows (Quartz, Code…)',
 *     path:'mantle:layout:Work' }
 * launcher-index.js launch() sends a 'mantle:layout:' path to run() before its generic 'mantle:' branch.
 */
const crypto = require('crypto');

let layouts = [];            // [{ name, count, apps }]
let runner = null;           // async (name, { dryRun, via }) => { ok, reason?, text? }
let why = 'window layouts are not running (the feature is off, resting, or did not start)';

const PREFIX = 'mantle:layout:';

function set(list, run) {
  layouts = Array.isArray(list) ? list.filter((l) => l && typeof l.name === 'string') : [];
  if (typeof run === 'function') runner = run;
}

function clear(reason) {
  layouts = [];
  runner = null;
  if (reason) why = reason;
}

function rowFor(l) {
  const apps = (l.apps || []).slice(0, 3).join(', ') + ((l.apps || []).length > 3 ? '…' : '');
  return {
    id: 'layout:' + crypto.createHash('sha1').update(String(l.name).toLowerCase()).digest('hex').slice(0, 12),
    kind: 'setting',
    name: 'Layout: ' + l.name,
    subtitle: `Window layout: ${l.count} window${l.count === 1 ? '' : 's'}${apps ? ` (${apps})` : ''}`,
    path: PREFIX + l.name,
    icon: null,
  };
}

function rows() { return layouts.map(rowFor); }

function isLayoutPath(p) { return typeof p === 'string' && p.indexOf(PREFIX) === 0; }

async function run(pathOrName, opts) {
  const name = isLayoutPath(pathOrName) ? pathOrName.slice(PREFIX.length) : String(pathOrName || '');
  if (!runner) return { ok: false, reason: why };
  try {
    const r = await runner(name, Object.assign({ via: 'the launcher' }, opts || {}));
    return r && typeof r.ok === 'boolean' ? r : { ok: false, reason: 'the layout did not say whether it ran' };
  } catch (err) {
    return { ok: false, reason: 'the layout could not run: ' + String((err && err.message) || err) };
  }
}

module.exports = { set, clear, rows, run, isLayoutPath, PREFIX };

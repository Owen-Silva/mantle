'use strict';
/*
 * lib/features/run.js - Win+R: the launcher's Run mode, in place of Windows' Run box (lane keysrun,
 * 2026-10-15; plan design notes: mantle-replace-windows P5).
 *
 * The user: "everything should be taken over". He uses Win+R for %appdata% and his .minecraft folders,
 * perfmon /report, SystemPropertiesPerformance.exe, git and a curl install line (his RunMRU).
 *
 * NO NEW WINDOW: Win+R opens the launcher Mantle already has (ctx.host.openLauncher mode 'run'), so
 * it adds no RAM and paints as fast as the launcher does. Nothing on the open path waits: the page
 * draws the history it has, and run.history answers from memory (RunMRU is read once per sidecar
 * start, off the open path).
 *
 * WHAT A LINE DOES (lib/run-line.js plans it; nothing ever reaches a shell unparsed):
 *   a folder (C:\..., %appdata%\.minecraft, shell:startup, Documents)  -> Mantle Files, or File
 *     Explorer with the reason while Files is off or resting (lib/launcher-index.js launch)
 *   http(s):// or www.                                                  -> the launcher's URL road
 *   ms-settings:...                                                     -> Mantle Settings where it claims the page
 *   anything else                                                       -> ShellExecuteEx, file + verbatim params
 *   Ctrl+Shift+Enter                                                    -> the same with "runas" (Windows' UAC)
 * Unknown programs get Windows' answer in plain words ("Windows can't find ..."), under the row.
 *
 * HISTORY: Mantle's own (settings key `history`, newest first, 50) and then Windows' RunMRU, read
 * only. A line is remembered when it ran. Completion: the history, and the folder you are typing in.
 *
 * KEYS: Win+R only while this is on, healthy and Mantle is not resting (lib/features.js); an old
 * sidecar exe without run.exec hands the chord back to Windows with the reason (probe).
 */
const fs = require('fs');
const runLine = require('../run-line');
const { makeExec, probe } = require('./_run-exec');

const CHORD = 'Win+R';
const READY = 'Win+R opens the launcher in Run mode';
const LIST_MS = 800;     // a folder listing slower than this (a sleeping network share) completes nothing

function knownFolders() {
  try {
    const { app } = require('electron');
    const out = {};
    for (const k of ['downloads', 'documents', 'desktop', 'pictures', 'music', 'videos']) {
      try { out[k] = app.getPath(k); } catch (_) { /* not on this machine */ }
    }
    return out;
  } catch (_) { return {}; }
}

async function statKind(p) {
  try {
    const s = await fs.promises.stat(p);
    return s.isDirectory() ? 'dir' : s.isFile() ? 'file' : null;
  } catch (_) { return null; }
}

/** A stat that gives up after `ms` (a UNC path to a sleeping machine): unknown, so Windows decides. */
function statWithin(ms) {
  return (p) => Promise.race([statKind(p), new Promise((r) => { const t = setTimeout(() => r(null), ms); if (t.unref) t.unref(); })]);
}

async function listDir(dir) {
  const list = await Promise.race([
    fs.promises.readdir(dir, { withFileTypes: true }),
    new Promise((_, rej) => { const t = setTimeout(() => rej(new Error('slow')), LIST_MS); if (t.unref) t.unref(); }),
  ]);
  return list.map((e) => ({ name: e.name, dir: e.isDirectory() }));
}

module.exports = {
  name: 'run',
  label: 'Run (Win+R)',
  defaultOn: true,
  rest: true,                 // the launcher closes while a game runs: Win+R is Windows' then
  chords: [CHORD],
  observe: [],
  install(ctx) {
    const dryRun = !!ctx.flags.test;
    let mru = [];
    let own = [];
    try { own = runLine.mergeHistory(ctx.settings.get('history', []), []); } catch (err) { ctx.log(`history could not be read: ${err.message}`); }
    const fgGrant = require('../fg-grant');
    const ex = makeExec(ctx, { dryRun, grant: () => fgGrant.grant(ctx.sidecar.pid) });
    const deps = () => ({ env: process.env, profile: process.env.USERPROFILE, stat: statWithin(1500), known: knownFolders() });

    ctx.command('history', async () => ({ items: runLine.mergeHistory(own, mru) }));
    ctx.command('complete', async (a) => {
      const typed = a && typeof a.typed === 'string' ? a.typed : '';
      return { typed, items: await runLine.completePath(typed, { env: process.env, list: listDir }) };
    });
    ctx.command('exec', async (a) => {
      const line = a && typeof a.line === 'string' ? a.line : '';
      const admin = !!(a && a.admin);
      const p = await runLine.plan(line, deps());
      let res;
      switch (p.kind) {
        case 'empty': return { ok: false, reason: 'Type a program, folder, document or website.' };
        case 'bad': return { ok: false, reason: p.reason };
        case 'folder':
          res = await ex.open({ kind: 'setting', mantleApp: true, name: 'Mantle Files', path: 'mantle:files:' + p.path });
          if (res.ok && admin) res.reason = res.reason || 'A folder opens the same way as administrator or not.';
          break;
        case 'url': res = await ex.open({ kind: 'url', name: p.url, path: p.url }); break;
        case 'settings': res = await ex.open({ kind: 'setting', name: p.uri, path: p.uri }); break;
        default: res = await ex.exec({ file: p.file, params: p.params, admin });
      }
      res = Object.assign({ how: p.kind }, res);
      if (res.ok) {
        own = runLine.remember(own, line);
        try { ctx.settings.set('history', own); } catch (err) { ctx.log(`history could not be saved: ${err.message}`); }
      }
      ctx.log(`${admin ? 'admin ' : ''}${p.kind}: ${res.ok ? (res.dryRun ? 'dry run' : 'started') : 'refused'}`);   // never the line itself
      return res;
    });

    ctx.sidecar.onReady(async () => {
      if (!await probe(ctx, READY)) return;
      const r = await ctx.sidecar.send('run.mru', {}, { timeoutMs: 4000 });
      if (r.ok && r.result && Array.isArray(r.result.items)) mru = r.result.items;
      else ctx.log(`Windows' Run history could not be read: ${String(r.error || 'no reason').slice(0, 160)}`);
    });

    ctx.onChord(CHORD, () => {
      try {
        ctx.host.openLauncher({ mode: 'run' });
      } catch (err) {
        ctx.health(false, 'Win+R cannot open the launcher: ' + ((err && err.message) || err));
      }
    });
    ctx.health(true, READY);
    return { stop() { /* nothing in Windows was changed: the chord goes back via the seam; nothing polls */ } };
  },
  _internals: { statWithin, listDir },
};

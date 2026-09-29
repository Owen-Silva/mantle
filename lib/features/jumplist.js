'use strict';
/* jumplist.js - the main-process side of the bar's right-click menu (lane jumplist, 2026-09-24).
 *
 * Owen: "i need to be able to right click the apps on the taskbar and have the same options regular
 * windows shows". The menu is ui/bar/jumplist.js (in the bar page); the reading is
 * sidecar/JumpList.cs. This module is the bridge plus the parts that are Mantle's own:
 *   jumplist.get    {app}              the app's jump list (sections, or `none` / `error` in words)
 *   jumplist.open   {app, item, title, tip} run a task / open a recent item; `item:'app'` = a new window
 *                   (Mantle Files' list: a folder `tip` opens in Mantle Files, see openInFiles)
 *   jumplist.remove {app, item, title} "Remove from this list" (Recent / Frequent only)
 *   jumplist.close  {hwnds}            WM_CLOSE to each window, never a kill
 *   jumplist.pin    {app, pin}         Mantle's OWN pin list (_jumplist-pins.js), never Windows'
 *   jumplist.order  {group, ids, from, to} the bar's drag to reorder (pinned: saved; running: session)
 * `app` is the bar item: { id, name, kind, exe, aumid, hwnds }.
 *
 * --test: EVERY open / remove / close / pin is a dry run with a log line (the sidecar still
 * resolves what it WOULD do, which is read-only), because Owen is at this machine.
 */
const fs = require('fs');
const path = require('path');
const own = require('./_jumplist-pins');

const PINS_DIR = path.join(process.env.APPDATA || '', 'Microsoft', 'Internet Explorer', 'Quick Launch', 'User Pinned', 'TaskBar');
const READ_MS = 6000;   // a cold read of a long list measured 40-140 ms; a dead network path is what this bounds

/* Mantle Files (lane barfiles, 2026-09-29): its menu is File Explorer's jump list (Quick access pins,
   recent folders), whichever of its items was right-clicked (its own pin, the File Explorer pin it
   stands in for, or a running Files window, which Windows would otherwise resolve to no list at all),
   and a FOLDER from that list opens in Mantle Files, the way Win+E does, instead of in explorer.exe. */
const FILES_AUMID = 'mantle.files';
const EXPLORER_APPID = 'Microsoft.Windows.Explorer';
const isFiles = (app) => !!(app && app.aumid && String(app.aumid).toLowerCase() === FILES_AUMID);
const STAT_MS = 1500;   // a dead network folder must not hang the menu

/** A jump list item's own path (the sidecar's `tip`) when it is an existing FOLDER, else null. */
async function folderOf(tip) {
  const p = typeof tip === 'string' ? tip.trim() : '';
  if (!p || !(/^[a-z]:\\/i.test(p) || /^\\\\[^\\]/.test(p))) return null;     // shell items (::{...}) and files stay with Windows
  let timer = null;
  const late = new Promise((res) => { timer = setTimeout(() => res(null), STAT_MS); });
  const st = await Promise.race([fs.promises.stat(p).catch(() => null), late]);
  clearTimeout(timer);
  return st && st.isDirectory() ? p : null;
}

/** The sidecar's way to name the app: its window first (the taskbar's own resolver), then its pin. */
function targetOf(app) {
  if (!app || typeof app !== 'object') throw new Error('jumplist: no app was given');
  if (isFiles(app)) return { app: EXPLORER_APPID };
  const a = {};
  const hwnds = Array.isArray(app.hwnds) ? app.hwnds.filter(Boolean).map(String) : [];
  if (hwnds.length) a.hwnd = hwnds[0];
  const id = String(app.id || '');
  if (/\.lnk$/i.test(id) && !/[\\/]/.test(id)) {
    const p = path.join(PINS_DIR, id);
    if (fs.existsSync(p)) a.lnk = p;
  }
  if (!a.hwnd && !a.lnk && app.aumid) a.app = String(app.aumid);
  if (app.exe) a.exe = String(app.exe);
  if (!a.hwnd && !a.lnk && !a.app && !a.exe) throw new Error(`Mantle does not know which program ${app.name || 'this'} is`);
  return a;
}

function said(r, what) {
  if (r && r.ok) return null;
  return `${what}: ${(r && (r.error || r.reason)) || 'the sidecar did not say why'}`;
}

module.exports = {
  name: 'jumplist',
  label: 'Jump lists (right-click an app on the bar)',
  defaultOn: true,
  chords: [],
  observe: [],
  install(ctx) {
    const test = !!ctx.flags.test;
    ctx.health(true);

    ctx.command('get', async (args) => {
      if (!ctx.enabled()) return { ok: false, off: true, reason: 'jump lists are switched off in the tray' };
      const t0 = Date.now();
      let target;
      try { target = targetOf(args && args.app); } catch (err) { return { ok: false, reason: err.message }; }
      const r = await ctx.sidecar.send('jumplist.get', target, { timeoutMs: READ_MS });
      if (!r.ok) {
        const why = String(r.error || 'no answer');
        const old = /unknown command|not a command/i.test(why);
        return { ok: false, reason: old ? 'the sidecar exe is older than jump lists (npm run build:sidecar)' : why, mainMs: Date.now() - t0 };
      }
      const out = Object.assign({}, r.result, { ok: true, mainMs: Date.now() - t0, test });
      // counts and timings only: item titles are Owen's file names and never reach the log
      if (test) ctx.log(`get ${(args.app && args.app.name) || '?'} [${out.how}]: ${(out.sections || []).map((s) => `${s.kind}:${(s.items || []).length}`).join(' ') || `none (${out.none || out.error})`} in ${out.mainMs} ms (sidecar ${out.ms && out.ms.total} ms${out.cached ? ', cached' : ''})`);
      return out;
    });

    async function run(verb, args, what) {
      let target;
      try { target = targetOf(args && args.app); } catch (err) { return { ok: false, reason: err.message }; }
      const item = String((args && args.item) || '');
      if (!item) return { ok: false, reason: `jumplist.${verb} needs the item from jumplist.get` };
      const req = Object.assign({}, target, { item });
      if (args && args.title) req.title = String(args.title);
      if (test) {
        const r = await ctx.sidecar.send(`jumplist.${verb}`, Object.assign(req, { dry: true }), { timeoutMs: READ_MS });
        if (!r.ok) return { ok: false, reason: String(r.error) };
        ctx.log(`dry run (--test): would ${what} ${item} of ${args.app.name || '?'} via ${r.result.route}`);
        return { ok: true, dryRun: true, route: r.result.route, reason: `dry run: would ${what} it via ${r.result.route}` };
      }
      const r = await ctx.sidecar.send(`jumplist.${verb}`, req, { timeoutMs: READ_MS });
      if (!r.ok) return { ok: false, reason: String(r.error) };
      ctx.log(`${what} ${item} of ${args.app.name || '?'} via ${r.result.route}`);
      return { ok: true, route: r.result.route };
    }
    /* A folder from Mantle Files' (File Explorer's) list -> a Mantle Files window at that folder, through
       the same openWindow as Win+E ('mantle-open:files', listened to only while Files is on). Files off,
       a file, a shell item, or a folder that is gone: the sidecar opens it as before (Windows' way). */
    const electronApp = () => ctx.electronApp || (() => { try { return require('electron').app || null; } catch (_) { return null; } })();
    async function openInFiles(args) {
      if (!isFiles(args && args.app) || !args.item || args.item === 'app') return null;
      const eapp = electronApp();
      if (!eapp || typeof eapp.listenerCount !== 'function' || eapp.listenerCount('mantle-open:files') === 0) return null;
      const folder = await folderOf(args.tip);
      if (!folder) return null;
      if (test) {
        ctx.log(`dry run (--test): would open a folder from File Explorer's list in Mantle Files`);
        return { ok: true, dryRun: true, route: 'Mantle Files', reason: 'dry run: would open that folder in Mantle Files' };
      }
      const reply = { handled: false, ok: false, reason: null };
      try { eapp.emit('mantle-open:files', { path: folder, via: 'the jump list', reply }); } catch (err) { return { ok: false, reason: `Mantle Files did not open that folder: ${err.message}` }; }
      if (reply.handled && !reply.ok) return { ok: false, reason: `Mantle Files did not open that folder: ${reply.reason || 'it did not say why'}` };
      ctx.log('opened a folder from File Explorer\'s list in Mantle Files');
      return { ok: true, route: 'Mantle Files' };
    }
    ctx.command('open', async (args) => (await openInFiles(args)) || run('open', args, args && args.item === 'app' ? 'start a new window of' : 'open'));
    ctx.command('remove', (args) => run('remove', args, 'remove from the list'));

    ctx.command('close', async (args) => {
      const hwnds = Array.isArray(args && args.hwnds) ? args.hwnds.filter(Boolean).map(String) : [];
      if (!hwnds.length) return { ok: false, reason: 'there is no window to close' };
      if (test) {
        ctx.log(`dry run (--test): would send WM_CLOSE to ${hwnds.length} window(s): ${hwnds.join(', ')}`);
        return { ok: true, dryRun: true, reason: `dry run: would close ${hwnds.length} window(s)` };
      }
      const failed = [];
      for (const hwnd of hwnds) {
        const r = await ctx.sidecar.send('close', { hwnd }, { timeoutMs: 4000 });
        const why = said(r, `window ${hwnd}`);
        if (why) failed.push(why);
      }
      ctx.log(`WM_CLOSE to ${hwnds.length} window(s)${failed.length ? `; ${failed.length} refused` : ''}`);
      return failed.length ? { ok: false, reason: failed.join('; ') } : { ok: true, closed: hwnds.length };
    });

    ctx.command('pin', async (args) => {
      const app = args && args.app;
      if (!app || !app.id) return { ok: false, reason: 'jumplist.pin needs the bar item' };
      const want = !!(args && args.pin);
      if (test) {
        ctx.log(`dry run (--test): would ${want ? 'pin' : 'unpin'} ${app.name || app.id} in Mantle's own list`);
        return { ok: true, dryRun: true, reason: `dry run: would ${want ? 'pin' : 'unpin'} ${app.name || 'it'}` };
      }
      try {
        let shortcut = null;
        if (want && !isFiles(app)) {     // Mantle Files has no shortcut of its own (Explorer's is not it)
          // the shortcut Windows itself would start it from (Owen's browser is a bare electron.exe)
          const r = await ctx.sidecar.send('jumplist.shortcut', targetOf(app), { timeoutMs: READ_MS });
          if (r.ok && r.result && r.result.shortcut) shortcut = r.result.shortcut;
        }
        const cur = ctx.settings.get('pins', own.empty());
        const next = want ? own.pin(cur, Object.assign({}, app, { shortcut })) : own.unpin(cur, app);
        ctx.settings.set('pins', next.overlay);
        ctx.log(`${want ? 'pin' : 'unpin'} ${app.name || app.id}: ${next.did}`);
        return { ok: true, did: next.did };
      } catch (err) {
        return { ok: false, reason: err.message };
      }
    });

    /* DRAG TO REORDER (lane bardrag, 2026-09-29): the bar sends one group's ids in their new order.
       pinned  -> saved in Mantle's own pin list ("order", _jumplist-pins.js), applied by buildPinned;
       running -> this session only (an app that is merely running has no pin to remember it by).
       This IS Mantle's own state in this profile's userData (a --test profile's is its own temp
       folder), so a test run saves it for real: that is how a restart is proven to keep it.
       The log gets counts and positions only, never an app's name or id. */
    ctx.command('order', async (args) => {
      const group = args && args.group === 'running' ? 'running' : 'pinned';
      const ids = own.cleanIds(args && args.ids);
      if (!ids.length) return { ok: false, reason: 'the bar sent no order to save' };
      const at = (v) => (Number.isInteger(v) && v >= 0 ? v + 1 : '?');
      const where = `${at(args.from)} -> ${at(args.to)} of ${ids.length}`;
      if (group === 'running') {
        own.setRunning(ids);
        ctx.log(`order: a running app moved ${where} (kept for this session)`);
        return { ok: true, saved: 'session' };
      }
      try {
        ctx.settings.set('pins', own.setOrder(ctx.settings.get('pins', own.empty()), ids));
      } catch (err) {
        ctx.log(`order: a pinned app moved ${where} and the order was NOT saved`);
        return { ok: false, reason: `the new order was not saved: ${err.message}` };
      }
      ctx.log(`order: a pinned app moved ${where}, saved${test ? ' (in this test profile)' : ''}`);
      return { ok: true, saved: 'pins' };
    });

    return { stop() { /* nothing of Windows' is changed by this feature */ } };
  },
  _internals: { targetOf, folderOf, isFiles },
};

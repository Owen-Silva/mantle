'use strict';
/*
 * applist.js - the main half of Settings > Apps (ui/settings/sections/applist.js), lane appsacct,
 * 2026-09-29. The id is "applist" because a module may not take a built-in's id ("apps"); the page
 * replaces the built-in Apps page. Every command is settings.applist.<name> and asks
 * sidecar/SysApps.cs + SysAppsMore.cs:
 *   installed {sizes?}   Win32 (Uninstall keys) + Store apps (PackageManager, this user)
 *   plan {key, action}   what Uninstall / Modify WOULD run (a dryRun: a read, shown before the confirm)
 *   uninstall {key, confirm:true}  Store: RemovePackageAsync for this user; desktop: the app's OWN
 *   modify {key, confirm:true}     UninstallString / ModifyPath. ONLY with confirm:true (the page's
 *                        second click), always a dryRun in a test run. The request carries only the
 *                        key; the sidecar reads the command from the registry entry it names.
 *   defaults / features / websites   reads (read-only rows, each with its reason)
 *   video, videoSet {name, on}       HKCU VideoSettings
 *   advanced, advancedSet {name:'share', value 0-2}   HKCU CDP (the rest is read-only)
 * Startup apps are NOT here: the page calls the built-in settings.startup / settings.startupSet
 * (sidecar/Startup.cs, StartupApproved only), unchanged.
 * PRIVACY: nothing here logs names, paths or commands.
 */
const { pick, send, write } = require('./_devices-bridge');

/** settings.applist.<name> -> the sidecar command it asks (the page test pins these). */
const SIDECAR = {
  installed: 'apps.installed',
  plan: 'apps.uninstall',
  uninstall: 'apps.uninstall',
  modify: 'apps.modify',
  defaults: 'apps.defaults',
  features: 'apps.features',
  websites: 'apps.websites',
  video: 'apps.video',
  videoSet: 'apps.videoSet',
  advanced: 'apps.advanced',
  advancedSet: 'apps.advancedSet',
};

const KEY = /^[ws][0-9a-z]{1,13}$/;
const badKey = (a) => (typeof a.key === 'string' && KEY.test(a.key) ? null : { ok: false, reason: 'say which app (key, from the installed list)' });

async function launch(args, env, cmd) {
  const bad = badKey(args);
  if (bad) return bad;
  // Owen's explicit confirm: the page sends confirm:true only from its second ("Uninstall" / "Modify")
  // click. A test run is a dry run either way.
  if (!env.test && args.confirm !== true) return { ok: false, reason: 'Nothing was run: this needs your confirmation first' };
  const r = await write(env, cmd, { key: args.key }, { ms: 20000, value: () => undefined });
  if (r.ok && !r.dryRun && r.started) env.log(`${cmd} started (${r.kind || 'app'})`);
  return r;
}

const commands = {
  installed: (args, env) => send(env, SIDECAR.installed, args.sizes === true ? { sizes: true } : {}, 60000),
  plan(args, env) {
    const bad = badKey(args);
    if (bad) return bad;
    if (args.action !== 'uninstall' && args.action !== 'modify') return { ok: false, reason: 'action must be uninstall or modify' };
    return send(env, args.action === 'modify' ? SIDECAR.modify : SIDECAR.plan, { key: args.key, dryRun: true }, 20000);
  },
  uninstall: (args, env) => launch(args, env, SIDECAR.uninstall),
  modify: (args, env) => launch(args, env, SIDECAR.modify),
  defaults: (args, env) => send(env, SIDECAR.defaults, {}, 30000),
  features: (args, env) => send(env, SIDECAR.features, {}, 60000),
  websites: (args, env) => send(env, SIDECAR.websites, {}, 30000),
  video: (args, env) => send(env, SIDECAR.video, {}, 8000),
  videoSet(args, env) {
    if (!['hdr', 'enhance', 'quality', 'lowres'].includes(args.name)) return { ok: false, reason: 'name must be hdr, enhance, quality or lowres' };
    if (typeof args.on !== 'boolean') return { ok: false, reason: 'on must be true or false' };
    return write(env, SIDECAR.videoSet, pick(args, ['name', 'on']), { ms: 8000, value: (r) => r.now });
  },
  advanced: (args, env) => send(env, SIDECAR.advanced, {}, 15000),
  advancedSet(args, env) {
    if (args.name !== 'share') return { ok: false, reason: 'only Share across devices can be changed here' };
    if (![0, 1, 2].includes(args.value)) return { ok: false, reason: 'value must be 0 (off), 1 (my devices) or 2 (everyone nearby)' };
    return write(env, SIDECAR.advancedSet, pick(args, ['name', 'value']), { ms: 8000, value: (r) => String(r.now) });
  },
};

module.exports = { id: 'applist', commands, SIDECAR };

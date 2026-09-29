// test-sysapps.js - SysApps.cs + SysAppsMore.cs (Settings > Apps) against a PASSIVE sidecar (lane
// appsacct, 2026-09-29).
//
//   node sidecar/test-sysapps.js [--exe=<path>]      (or MANTLE_SIDECAR_EXE)
//
// NEVER uninstalls, modifies or starts anything: apps.uninstall / apps.modify are proven by their
// dryRun (what WOULD run) and by the source order (the passive refusal comes before anything is
// started); a real uninstall is never sent, not even to a passive sidecar. The HKCU writes (video,
// share across devices) are sent for real only with the value they ALREADY have, so even a broken
// passive guard could change nothing, and they must be refused. The reads are real. Prints counts and
// shapes only, never an app's name, a path or a command.
'use strict';
const fs = require('fs');
const path = require('path');
const T = require('./test-lib');

(async () => {
  const t = T.checker('SYSAPPS');
  // --- static: nothing is ever started before the passive refusal, and requests never reach a command line
  const src = fs.readFileSync(path.join(__dirname, 'SysApps.cs'), 'utf8');
  const fn = (name) => { const i = src.indexOf('static string ' + name + '('); if (i < 0) return ''; const j = src.indexOf('\n    static ', i + 10); return src.slice(i, j < 0 ? undefined : j); };
  const un = fn('Uninstall'), mo = fn('Modify');
  t.check('uninstall: the passive refusal comes before RemoveStore and Launch', un && un.indexOf('Program.Passive') > 0 && un.indexOf('Program.Passive') < un.indexOf('RemoveStore(') &&
    un.lastIndexOf('Program.Passive') < un.indexOf('Launch('));
  t.check('modify: the passive refusal comes before Launch', mo && mo.indexOf('Program.Passive') > 0 && mo.indexOf('Program.Passive') < mo.indexOf('Launch('));
  t.check('the command line comes from the registry entry only (the request gives just key)',
    (src.match(/Json\.Get(String|Bool)\(req, "([a-zA-Z]+)"/g) || []).every((m) => /"(key|dryRun|sizes)"/.test(m)) && !/cmd\.exe|powershell/i.test(src.replace(/^\s*\/\/.*$/gm, '')));

  let s;
  try { s = await T.startPassive(); } catch (e) { t.fail('sidecar starts', e.message); process.exit(t.summary()); }
  const send = (cmd, extra, ms) => s.send(cmd, extra || {}, ms || 30000);
  const refused = (r) => r && r.ok === false && String(r.error || '').startsWith(T.PASSIVE_REFUSAL);
  const short = (x) => JSON.stringify(x).slice(0, 240);
  const msOrNull = (v) => v === null || (typeof v === 'number' && v > 3.0e11 && v < 2.2e12);

  try {
    const ping = await send('ping');
    const cmds = (ping.ok && ping.result && ping.result.features && ping.result.features.commands) || [];
    for (const c of ['apps.installed', 'apps.uninstall', 'apps.modify', 'apps.defaults', 'apps.features', 'apps.websites', 'apps.video', 'apps.videoSet', 'apps.advanced', 'apps.advancedSet'])
      t.check(`${c} is registered`, cmds.includes(c), `commands: ${cmds.length}`);
    const probs = ((ping.result && ping.result.features && ping.result.features.problems) || []).filter((p) => /SysApps/.test(p));
    t.check('no SysApps registration problems', probs.length === 0, probs.join('; '));

    // --- installed apps (reads)
    let t0 = Date.now();
    const ins = await send('apps.installed', {}, 60000);
    const ms = Date.now() - t0;
    const x = ins.ok && ins.result;
    t.check('apps.installed answers', !!x && Array.isArray(x.items), short(ins));
    let w = null, st = null, mod = null;
    if (x) {
      const it = x.items;
      t.check('both kinds: desktop and Store apps', x.win32 > 0 && x.store > 0 && it.length === x.win32 + x.store, `${x.win32} + ${x.store} vs ${it.length}`);
      t.check('every app: a short key, a kind, a name', it.every((a) => /^[ws][0-9a-z]{1,13}$/.test(a.key) && ['win32', 'store'].includes(a.kind) && typeof a.name === 'string' && a.name.length > 0));
      t.check('keys are unique', new Set(it.map((a) => a.key)).size === it.length);
      t.check('sizes are bytes or null, dates ms or null, drives X: or null', it.every((a) => (a.size === null || a.size > 0) && msOrNull(a.installed) && (a.drive === null || /^[A-Z]:$/.test(a.drive))));
      t.check('an app that cannot be uninstalled says why', it.every((a) => a.canUninstall || (typeof a.uninstallWhy === 'string' && a.uninstallWhy.length > 10)));
      t.check('an app with no Modify says why', it.every((a) => a.canModify || (typeof a.modifyWhy === 'string' && a.modifyWhy.length > 10)));
      t.check('drives listed', Array.isArray(x.drives) && x.drives.every((d) => /^[A-Z]:$/.test(d)), short(x.drives));
      t.check('frameworks and system parts are not listed', !it.some((a) => a.kind === 'store' && /^Microsoft\.(VCLibs|NET\.Native|UI\.Xaml)/.test(a.name)));
      t.check('the list reads in under 5 s', ms < 5000, ms + ' ms');
      w = it.find((a) => a.kind === 'win32' && a.canUninstall); st = it.find((a) => a.kind === 'store' && a.canUninstall); mod = it.find((a) => a.canModify);
      console.log(`  (${x.win32} desktop + ${x.store} Store apps in ${ms} ms, ${x.drives.length} drive(s), ${it.filter((a) => a.size).length} sized, ${it.filter((a) => !a.canUninstall).length} not removable, ${x.problems.length} problem(s))`);
    }
    const sz = await send('apps.installed', { sizes: true }, 60000);
    t.check('sizes:true starts (or has finished) the Store size walk', sz.ok && (sz.result.sizing === true || msOrNull(sz.result.sized)), short({ sizing: sz.result && sz.result.sizing, sized: sz.result && sz.result.sized }));

    // --- uninstall / modify: dryRun only
    if (st) {
      const d = await send('apps.uninstall', { key: st.key, dryRun: true });
      t.check('Store uninstall dryRun: RemovePackageAsync for this account, nothing run', d.ok && d.result.dryRun && d.result.kind === 'store' && /RemovePackageAsync/.test(d.result.would) && /your account only/.test(d.result.would), short(d.ok ? { kind: d.result.kind } : d));
    } else t.fail('a removable Store app to dry-run', 'none found');
    if (w) {
      const d = await send('apps.uninstall', { key: w.key, dryRun: true, command: 'calc.exe', program: 'calc.exe', args: '/x' });
      t.check('desktop uninstall dryRun names its own uninstaller, and ignores command text in the request', d.ok && d.result.dryRun && d.result.kind === 'win32' && /own uninstaller/.test(d.result.would) &&
        !/calc\.exe/i.test(d.result.would) && (typeof d.result.program === 'string' || typeof d.result.wouldRefuse === 'string'), short(d.ok ? { kind: d.result.kind, refuse: !!d.result.wouldRefuse } : d));
    } else t.fail('a removable desktop app to dry-run', 'none found');
    if (mod) {
      const d = await send('apps.modify', { key: mod.key, dryRun: true });
      t.check('modify dryRun names the app\'s own setup', d.ok && d.result.dryRun && /own setup/.test(d.result.would), short(d.ok ? { refuse: d.result.wouldRefuse } : d));
    }
    for (const [a, re] of [[{ dryRun: true }, /needs key/], [{ key: 'C:\\x.exe', dryRun: true }, /needs key/], [{ key: 'wzzzzzzz', dryRun: true }, /no longer installed/], [{ key: 5, dryRun: true }, /needs key/]]) {
      const r = await send('apps.uninstall', a);
      t.check(`uninstall refuses ${short(a)}`, r.ok === false && re.test(r.error), short(r));
    }
    const mr = await send('apps.modify', { key: 'sqqqqqqq', dryRun: true });
    t.check('modify refuses an unknown key', mr.ok === false && /no longer installed/.test(mr.error), short(mr));

    // --- default apps (read-only)
    t0 = Date.now();
    const df = await send('apps.defaults', {}, 30000);
    const dx = df.ok && df.result;
    t.check('apps.defaults answers files and links', !!dx && Array.isArray(dx.files) && Array.isArray(dx.links), short(df));
    if (dx) {
      t.check('the common file types are there, each with an app or null', ['.pdf', '.html', '.txt', '.jpg', '.mp4'].every((e) => dx.files.some((f) => f.name === e)) && dx.files.every((f) => f.app === null || typeof f.app === 'string'));
      t.check('http has a default app (the browser)', typeof dx.browser === 'string' && dx.links.some((l) => l.name === 'http'), short(dx.browser ? 'set' : dx.browser));
      t.check('read-only with the UCPD reason', typeof dx.ucpd.readOnly === 'string' && /Read only/.test(dx.ucpd.readOnly) && (!dx.ucpd.running || /User Choice Protection Driver \(UCPD\.sys\)/.test(dx.ucpd.readOnly)), short(dx.ucpd));
      console.log(`  (defaults: ${dx.files.length} file types, ${dx.links.length} link types, ${dx.files.filter((f) => f.chosen).length} chosen by you, UCPD ${dx.ucpd.state}, ${Date.now() - t0} ms)`);
    }

    // --- optional features (read-only)
    t0 = Date.now();
    const fe = await send('apps.features', {}, 60000);
    const fx = fe.ok && fe.result;
    t.check('apps.features answers capabilities and Windows features', !!fx && Array.isArray(fx.capabilities) && Array.isArray(fx.features), short(fe));
    if (fx) {
      t.check('capabilities: a name, a label, installed bool; some installed', fx.capabilities.every((c) => c.name && c.label && typeof c.installed === 'boolean') && fx.capabilities.some((c) => c.installed), short(fx.capabilitiesWhy));
      t.check('Windows features: name, label, enabled/disabled/absent; some enabled', fx.features.every((f) => f.name && ['enabled', 'disabled', 'absent'].includes(f.state)) && fx.features.some((f) => f.state === 'enabled'), short(fx.featuresWhy));
      t.check('read-only with the admin + Windows Update reason', /administrator and Windows Update/.test(fx.readOnly));
      console.log(`  (features: ${fx.capabilities.filter((c) => c.installed).length}/${fx.capabilities.length} capabilities installed, ${fx.features.filter((f) => f.state === 'enabled').length}/${fx.features.length} Windows features on, ${Date.now() - t0} ms)`);
    }

    // --- apps for websites (read-only)
    const wb = await send('apps.websites', {}, 30000);
    t.check('apps.websites: items with hosts, read-only with the reason', wb.ok && Array.isArray(wb.result.items) && wb.result.items.every((i) => /^u[0-9a-z]+$/.test(i.key) && i.name && Array.isArray(i.hosts) && i.hosts.length) && /Read only/.test(wb.result.readOnly), short(wb.ok ? wb.result.readOnly : wb));
    if (wb.ok) console.log(`  (websites: ${wb.result.items.length} apps, ${wb.result.items.reduce((n, i) => n + i.hosts.length, 0)} sites)`);

    // --- video playback (HKCU)
    const v1 = await send('apps.video');
    const vv = v1.ok && v1.result.values;
    t.check('apps.video: four switches with on/set', !!vv && ['hdr', 'enhance', 'quality', 'lowres'].every((k) => typeof vv[k].on === 'boolean' && typeof vv[k].set === 'boolean'), short(v1));
    if (vv) {
      const d = await send('apps.videoSet', { name: 'enhance', on: !vv.enhance.on, dryRun: true });
      t.check('videoSet dryRun names the HKCU value it would write', d.ok && d.result.dryRun && /HKCU VideoSettings EnableAutoEnhanceDuringPlayback = [01]/.test(d.result.would) && d.result.writes.length === 1, short(d));
      const r = await send('apps.videoSet', { name: 'hdr', on: vv.hdr.on });
      t.check('a real videoSet is refused in passive (sent with the value it already has)', refused(r), short(r));
    }
    for (const [a, re] of [[{ name: 'EnableHDRForPlayback', on: true, dryRun: true }, /needs name/], [{ name: 'hdr', on: 1, dryRun: true }, /true or false/], [{ on: true, dryRun: true }, /needs name/]]) {
      const r = await send('apps.videoSet', a);
      t.check(`videoSet refuses ${short(a)}`, r.ok === false && re.test(r.error), short(r));
    }

    // --- advanced app settings
    const a1 = await send('apps.advanced');
    const ax = a1.ok && a1.result;
    t.check('apps.advanced: source, archive, share, aliases', !!ax && typeof ax.source.words === 'string' && /Read only/.test(ax.source.readOnly) && typeof ax.archive.on === 'boolean' && /Read only/.test(ax.archive.readOnly) &&
      [0, 1, 2].includes(ax.share.value) && Array.isArray(ax.aliases) && /Read only/.test(ax.aliasReadOnly), short(a1));
    if (ax) {
      console.log(`  (advanced: source ${ax.source.value}, archive ${ax.archive.on}, share ${ax.share.value}${ax.share.set ? '' : ' (default)'}, ${ax.aliases.length} aliases)`);
      if (!ax.share.locked) {
        const d = await send('apps.advancedSet', { name: 'share', value: (ax.share.value + 1) % 3, dryRun: true });
        t.check('advancedSet dryRun names both HKCU CDP values', d.ok && d.result.dryRun && d.result.writes.length === 2 && /RomeSdkChannelUserAuthzPolicy and CdpSessionUserAuthzPolicy/.test(d.result.would), short(d));
        const r = await send('apps.advancedSet', { name: 'share', value: ax.share.value });
        t.check('a real advancedSet is refused in passive (sent with the value it already has)', refused(r), short(r));
      }
    }
    for (const [a, re] of [[{ name: 'source', value: 1, dryRun: true }, /read only/], [{ name: 'share', value: 3, dryRun: true }, /0 to 2/], [{ name: 'share', value: 1.5, dryRun: true }, /whole number/]]) {
      const r = await send('apps.advancedSet', a);
      t.check(`advancedSet refuses ${short(a)}`, r.ok === false && re.test(r.error), short(r));
    }

    // --- nothing changed
    const v2 = await send('apps.video');
    const a2 = await send('apps.advanced');
    t.check('nothing changed (video, share across devices)', v2.ok && vv && JSON.stringify(v2.result.values) === JSON.stringify(vv) && a2.ok && ax && a2.result.share.value === ax.share.value && a2.result.share.set === ax.share.set);
    const ins2 = await send('apps.installed', {}, 60000);
    t.check('nothing was uninstalled (same apps)', ins2.ok && x && ins2.result.items.length === x.items.length && ins2.result.removal === null, short({ n: ins2.result && ins2.result.items.length, removal: ins2.result && ins2.result.removal }));
  } catch (e) {
    t.fail('the run threw', e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e));
  } finally {
    await s.stop();
  }
  process.exit(t.summary());
})();

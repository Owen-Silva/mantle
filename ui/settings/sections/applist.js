/* applist.js — Settings > Apps, done natively (lane appsacct, 2026-09-29).
 *
 * The id is "applist" (a module may not take the built-in id "apps"); it replaces the built-in Apps
 * page. Everything goes through settings.applist.* (lib/features/_settings-sections/applist.js ->
 * sidecar/SysApps.cs + SysAppsMore.cs), except Startup, which calls the built-in settings.startup /
 * settings.startupSet unchanged (sidecar/Startup.cs: StartupApproved only, a Run value is never deleted).
 *   Installed apps       desktop + Store apps: search, sort, filter by drive; Uninstall (Store: removed
 *                        for this account; desktop: the app's OWN uninstaller) and Modify, each only
 *                        after a second, confirming click that shows exactly what will run
 *   Advanced app settings  where to get apps + archive apps (read-only, why), Share across devices,
 *                        app execution aliases (read-only, why)
 *   Default apps         what opens each file and link type (read-only: Microsoft's UCPD lock)
 *   Optional features    installed features (read-only: administrator + Windows Update)
 *   Apps for websites    which apps open which sites (read-only, why)
 *   Video playback       four HKCU switches
 *   Startup              the built-in Startup apps rows + Task manager (row ids kept: apps.startup...)
 * Kit only (SECTIONS.md); nothing opens Windows Settings.
 */
(function () {
  'use strict';
  const C = (kit, name, args) => kit.call('settings.applist.' + name, args || {});
  const bad = (r, what) => (r && r.ok === false ? what + ': ' + (r.reason || 'no reason came back') : null);
  const size = (b) => (b == null ? null : b >= 1e9 ? (b / 1e9).toFixed(1) + ' GB' : b >= 1e6 ? Math.round(b / 1e6) + ' MB' : Math.max(1, Math.round(b / 1e3)) + ' KB');
  const day = (ms) => { try { return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }); } catch (_) { return String(ms); } };
  const cut = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s);
  const rowKey = (s) => String(s).toLowerCase().replace(/[^a-z0-9_+-]/g, '_').slice(0, 60) || '_';
  const hash = (s) => { let x = 5381; for (const ch of String(s)) x = ((x * 33) ^ ch.codePointAt(0)) >>> 0; return 'k' + x.toString(36); };
  const live = (handle, fn) => { const i = handle.el.querySelector('input'); if (i) i.addEventListener('input', () => fn(i.value)); };
  const SVG = {
    gear: '<circle cx="8" cy="8" r="2.2"/><path d="M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2M3.6 3.6l1.4 1.4M11 11l1.4 1.4M3.6 12.4 5 11M11 5l1.4-1.4"/>',
    check: '<rect x="2.3" y="2.3" width="11.4" height="11.4" rx="2"/><path d="m5.2 8.2 2 2 3.8-4"/>',
    puzzle: '<path d="M3 5.5h2.5a1.5 1.5 0 1 1 3 0H11v2.5a1.5 1.5 0 1 1 0 3V13H3z"/>',
    globe: '<circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2c1.8 1.7 2.6 3.7 2.6 6S9.8 12.3 8 14M8 2C6.2 3.7 5.4 5.7 5.4 8s.8 4.3 2.6 6"/>',
    video: '<rect x="1.8" y="4" width="9" height="8" rx="1.5"/><path d="m10.8 7 3.4-2v6l-3.4-2"/>',
    rocket: '<path d="M8 1.8c2.6 1.6 3.6 4.4 3 7.6L9.6 11H6.4L5 9.4C4.4 6.2 5.4 3.4 8 1.8zM6.4 11l-1.6 2.6M9.6 11l1.6 2.6"/><circle cx="8" cy="6" r="1.2"/>',
  };

  // ============================================================== Installed apps
  function renderInstalled(el, kit) {
    const S = { r: null, q: '', sort: 'name', drive: 'all', confirm: null, last: null, watch: 0 };
    const count = kit.status({ row: 'apps.installed.count', label: 'Installed apps', value: 'Reading…' });
    const search = kit.text({ row: 'apps.installed.search', label: 'Search apps', placeholder: 'Name or publisher', value: '', onChange: (s) => { S.q = s; draw(); } });
    live(search, (s) => { S.q = s; draw(); });
    const sort = kit.choice({ row: 'apps.installed.sort', label: 'Sort by', style: 'dropdown', value: 'name',
      options: [{ value: 'name', label: 'Name (A to Z)' }, { value: 'size', label: 'Size (largest first)' }, { value: 'date', label: 'Install date (newest first)' }, { value: 'publisher', label: 'Publisher' }],
      onChange: (v) => { S.sort = v; draw(); return { ok: true, value: v }; } });
    const drive = kit.choice({ row: 'apps.installed.drive', label: 'Filter by drive', style: 'dropdown', value: 'all', options: [{ value: 'all', label: 'All drives' }],
      onChange: (v) => { S.drive = v; draw(); return { ok: true, value: v }; } });
    const list = kit.list({ row: 'apps.installed', items: [], empty: 'Reading the installed apps…', onAction });
    el.append(kit.card(count, search, sort, drive), kit.group('Apps'), kit.card(list));

    function sorted(items) {
      const by = { name: (a, b) => a.name.localeCompare(b.name), size: (a, b) => (b.size || -1) - (a.size || -1), date: (a, b) => (b.installed || 0) - (a.installed || 0),
        publisher: (a, b) => (a.publisher || '￿').localeCompare(b.publisher || '￿') || a.name.localeCompare(b.name) }[S.sort];
      return items.slice().sort(by);
    }
    function item(a) {
      const rm = S.r.removal && S.r.removal.key === a.key ? S.r.removal : null;
      const cf = S.confirm && S.confirm.key === a.key ? S.confirm : null;
      const last = S.last && S.last.key === a.key ? S.last.r : null;
      let help = [a.publisher, a.version ? 'Version ' + a.version : null, a.installed ? 'Installed ' + day(a.installed) : null, a.kind === 'store' ? 'Store app' : a.scope === 'user' ? 'For you only' : null, a.drive ? a.drive + ' drive' : null].filter(Boolean).join(' · ');
      let reason = null;
      let actions = [
        { id: 'modify', text: 'Modify', disabled: !a.canModify, reason: a.canModify ? null : a.modifyWhy },
        { id: 'uninstall', text: 'Uninstall', disabled: !a.canUninstall || !!(rm && rm.running), reason: a.canUninstall ? null : a.uninstallWhy },
      ];
      if (!a.canModify) actions = actions.slice(1);
      if (!a.canUninstall) reason = a.uninstallWhy;
      if (last) { if (last.ok === false) reason = last.reason; else help = last.reason || last.note || help; }
      if (rm && rm.running) help = 'Removing it…';
      else if (rm && rm.error) reason = 'It was not removed: ' + rm.error;
      if (cf) {
        const verb = cf.action === 'modify' ? 'Modify' : 'Uninstall';
        reason = cf.refuse ? verb + ' cannot run: ' + cf.refuse : (cf.action === 'modify' ? 'Modify ' + a.name + '? Mantle will ' : (a.kind === 'store' ? 'Remove ' + a.name + ' and its data from your account? Mantle will ' : 'Uninstall ' + a.name + '? Mantle will ')) + cf.would + '.';
        actions = cf.refuse ? [{ id: 'no', text: 'OK' }] : [{ id: 'yes', text: verb, tone: 'acc' }, { id: 'no', text: 'Keep' }];
      }
      return { key: a.key, label: a.name, help, value: size(a.size) || '—', reason, actions };
    }
    function draw() {
      const r = S.r;
      if (!r) return;
      const q = S.q.trim().toLowerCase();
      const shown = sorted(r.items.filter((a) => (S.drive === 'all' || a.drive === S.drive) && (!q || (a.name + ' ' + (a.publisher || '')).toLowerCase().includes(q))));
      const total = shown.reduce((n, a) => n + (a.size || 0), 0);
      count.set({ value: shown.length === r.items.length ? r.items.length + ' apps' : shown.length + ' of ' + r.items.length + ' apps',
        help: r.win32 + ' desktop and ' + r.store + ' Store apps' + (total ? ' · ' + size(total) + ' shown' : ''),
        info: r.sizing ? 'Adding up the Store apps\' folders (Windows keeps no size for them)…' : null,
        reason: r.problems && r.problems.length ? r.problems.join('; ') : null, tone: null });
      list.set({ items: shown.map(item), empty: q ? 'No app matches "' + S.q.trim() + '"' : 'No apps on this drive' });
    }
    async function read() {
      const r = await C(kit, 'installed', { sizes: true });
      if (kit.disposed) return;
      if (!r || r.ok === false) {
        count.set({ value: '—', reason: bad(r, 'The installed apps could not be read') });
        list.set({ items: [], empty: 'The installed apps could not be read' });
        return;
      }
      if (S.r && S.r.removal && S.r.removal.running && r.removal && !r.removal.running && !r.removal.error) S.last = null;
      S.r = r;
      drive.set({ options: [{ value: 'all', label: 'All drives' }].concat((r.drives || []).map((d) => ({ value: d, label: d + ' drive' }))) });
      draw();
    }
    async function onAction(key, act) {
      const a = S.r && S.r.items.find((x) => x.key === key);
      if (!a) return { ok: false, reason: 'That app is no longer in the list' };
      if (act === 'no') { S.confirm = null; draw(); return { ok: true }; }
      if (act === 'uninstall' || act === 'modify') {
        const p = await C(kit, 'plan', { key, action: act });
        if (!p || p.ok === false) return p;
        S.last = null;
        S.confirm = { key, action: act, would: p.would || 'run it', refuse: p.wouldRefuse || null };
        draw();
        return { ok: true };
      }
      if (act === 'yes' && S.confirm && S.confirm.key === key) {
        const r = await C(kit, S.confirm.action, { key, confirm: true });
        S.confirm = null; S.last = { key, r };
        if (r && r.ok && !r.dryRun) S.watch = Date.now() + 120000;
        draw();
        if (r && r.ok && !r.dryRun) setTimeout(read, 1500);
        return { ok: true };
      }
      return { ok: false, reason: 'Nothing to confirm: press Uninstall or Modify first' };
    }
    kit.every(3000, () => { if (S.r && (S.r.sizing || (S.r.removal && S.r.removal.running) || S.watch > Date.now())) read(); });
    return read().then(() => ({ update: read, dispose() {} }));
  }

  // ============================================================== Advanced app settings
  function renderAdvanced(el, kit) {
    const source = kit.status({ row: 'apps.advanced.source', label: 'Choose where to get apps', value: 'Reading…' });
    const share = kit.choice({ row: 'apps.advanced.share', label: 'Share across devices', help: 'Continue app experiences on your other devices signed in with your account', style: 'dropdown', value: '1',
      options: [{ value: '0', label: 'Off' }, { value: '1', label: 'My devices only' }, { value: '2', label: 'Everyone nearby' }],
      onChange: (v) => C(kit, 'advancedSet', { name: 'share', value: Number(v) }) });
    const archive = kit.status({ row: 'apps.advanced.archive', label: 'Archive apps', help: 'Windows archives apps you rarely use to save space and internet; their files and data stay', value: '' });
    const aliases = kit.list({ row: 'apps.advanced.aliases', items: [], empty: 'Reading…' });
    const aliasWhy = kit.h('div', {});
    el.append(kit.card(source, share, archive), kit.group('App execution aliases'), kit.card(aliasWhy, aliases));
    async function read() {
      const r = await C(kit, 'advanced');
      if (!r || r.ok === false) {
        const why = bad(r, 'The advanced app settings could not be read');
        [source, archive].forEach((x) => x.set({ value: '—', reason: why }));
        share.set({ disabled: true, reason: why });
        aliases.set({ items: [], empty: why });
        return;
      }
      source.set({ value: r.source.words, info: r.source.readOnly, reason: null });
      share.set({ value: String(r.share.value), disabled: !!r.share.locked, reason: r.share.locked || null, info: r.share.set ? null : 'Not set yet: Windows\' default (My devices only) applies' });
      archive.set({ value: r.archive.on ? 'On' : 'Off', tone: r.archive.on ? 'ok' : null, info: r.archive.readOnly, reason: null });
      aliasWhy.replaceChildren(kit.reason(r.aliasWhy || r.aliasReadOnly, { info: !r.aliasWhy }));
      aliases.set({ items: (r.aliases || []).map((n) => ({ key: rowKey(n), label: n, value: 'On' })), empty: 'No app execution aliases are on' });
    }
    return read().then(() => ({ update: read, dispose() {} }));
  }

  // ============================================================== Default apps
  function renderDefaults(el, kit) {
    const lock = kit.status({ row: 'apps.defaults', label: 'Default apps', value: 'Reading…' });
    const browser = kit.status({ row: 'apps.defaults.browser', label: 'Web browser', value: '' });
    const mail = kit.status({ row: 'apps.defaults.mail', label: 'Email', value: '' });
    const pdf = kit.status({ row: 'apps.defaults.pdf', label: 'PDF files', value: '' });
    const search = kit.text({ row: 'apps.defaults.search', label: 'Search file and link types', placeholder: '.pdf, http, Photos…', value: '', onChange: (s) => { S.q = s; draw(); } });
    live(search, (s) => { S.q = s; draw(); });
    const files = kit.list({ row: 'apps.defaults.files', items: [], empty: 'Reading…' });
    const links = kit.list({ row: 'apps.defaults.links', items: [], empty: 'Reading…' });
    const why1 = kit.h('div', {}), why2 = kit.h('div', {});
    el.append(kit.card(lock, browser, mail, pdf), kit.card(search), kit.group('File types'), kit.card(why1, files), kit.group('Link types'), kit.card(why2, links));
    const S = { r: null, q: '' };
    const it = (x) => ({ key: rowKey(x.name), label: x.name, help: [x.type, x.chosen ? 'Chosen by you' : 'Windows\' default'].filter(Boolean).join(' · '), value: x.app || 'No default app' });
    function draw() {
      if (!S.r) return;
      const q = S.q.trim().toLowerCase();
      const hit = (x) => !q || (x.name + ' ' + (x.app || '') + ' ' + (x.type || '')).toLowerCase().includes(q);
      files.set({ items: S.r.files.filter(hit).map(it), empty: 'No file type matches' });
      links.set({ items: S.r.links.filter(hit).map(it), empty: 'No link type matches' });
    }
    async function read() {
      const r = await C(kit, 'defaults');
      if (!r || r.ok === false) {
        const why = bad(r, 'The default apps could not be read');
        [lock, browser, mail, pdf].forEach((x) => x.set({ value: '—', reason: why }));
        files.set({ items: [], empty: why }); links.set({ items: [], empty: why });
        return;
      }
      S.r = r;
      const ro = r.ucpd && r.ucpd.readOnly;
      lock.set({ value: 'Read only', tone: 'info', info: ro, reason: null });
      browser.set({ value: r.browser || 'Not set', info: ro ? 'Read only: see Default apps above' : null });
      mail.set({ value: r.mail || 'Not set', info: ro ? 'Read only: see Default apps above' : null });
      pdf.set({ value: r.pdf || 'Not set', info: ro ? 'Read only: see Default apps above' : null });
      why1.replaceChildren(kit.reason(ro, { info: true }));
      why2.replaceChildren(kit.reason(ro, { info: true }));
      draw();
    }
    return read().then(() => ({ update: read, dispose() {} }));
  }

  // ============================================================== Optional features
  function renderFeatures(el, kit) {
    const head = kit.status({ row: 'apps.features', label: 'Optional features', value: 'Reading…' });
    const more = kit.status({ row: 'apps.features.available', label: 'Not installed', value: '' });
    const caps = kit.list({ row: 'apps.features.installed', items: [], empty: 'Reading…' });
    const winCount = kit.status({ row: 'apps.features.windows-count', label: 'More Windows features', value: '' });
    const wins = kit.list({ row: 'apps.features.windows', items: [], empty: 'Reading…' });
    const why1 = kit.h('div', {}), why2 = kit.h('div', {});
    el.append(kit.card(head, more), kit.group('Installed features'), kit.card(why1, caps), kit.group('More Windows features'), kit.card(winCount, why2, wins));
    async function read() {
      const r = await C(kit, 'features');
      if (!r || r.ok === false) {
        const why = bad(r, 'The optional features could not be read');
        [head, more, winCount].forEach((x) => x.set({ value: '—', reason: why }));
        caps.set({ items: [], empty: why }); wins.set({ items: [], empty: why });
        return;
      }
      const inst = r.capabilities.filter((c) => c.installed), pend = r.capabilities.filter((c) => c.pending), on = r.features.filter((f) => f.state === 'enabled');
      head.set({ value: inst.length + ' installed', info: r.readOnly, reason: r.capabilitiesWhy || null });
      more.set({ value: String(r.capabilities.length - inst.length), help: pend.length ? pend.length + ' waiting to finish installing' : 'In Windows\' own feature index', info: r.readOnly });
      caps.set({ items: inst.concat(pend).sort((a, b) => a.label.localeCompare(b.label)).map((c) => ({ key: rowKey(c.name), label: c.label, help: c.name, mono: true, value: c.installed ? 'Installed' : 'Installing…' })),
        empty: r.capabilitiesWhy || 'No optional features are installed' });
      winCount.set({ value: on.length + ' of ' + r.features.length + ' on', reason: r.featuresWhy || null, info: r.readOnly });
      wins.set({ items: on.map((f) => ({ key: rowKey(f.name), label: f.label, help: f.name, mono: true, value: 'On' })), empty: r.featuresWhy || 'No Windows features are on' });
      why1.replaceChildren(kit.reason(r.readOnly, { info: true }));
      why2.replaceChildren();
    }
    return read().then(() => ({ update: read, dispose() {} }));
  }

  // ============================================================== Apps for websites
  function renderWebsites(el, kit) {
    const head = kit.status({ row: 'apps.websites', label: 'Apps for websites', help: 'Links to these sites open in the app instead of the browser', value: 'Reading…' });
    const list = kit.list({ row: 'apps.websites.list', items: [], empty: 'Reading…' });
    el.append(kit.card(head), kit.group('Apps'), kit.card(list));
    async function read() {
      const r = await C(kit, 'websites');
      if (!r || r.ok === false) { const why = bad(r, 'The apps for websites could not be read'); head.set({ value: '—', reason: why }); list.set({ items: [], empty: why }); return; }
      head.set({ value: r.items.length + (r.items.length === 1 ? ' app' : ' apps'), info: r.readOnly, reason: null });
      list.set({ items: r.items.map((a) => ({ key: a.key, label: a.name, help: a.hosts.map((h) => h.host).join(', '),
        value: a.validated ? a.validated + ' of ' + a.hosts.length + ' verified' : 'Not verified', reason: null })), empty: 'No app opens links for websites' });
    }
    return read().then(() => ({ update: read, dispose() {} }));
  }

  // ============================================================== Video playback
  function renderVideo(el, kit) {
    const T = (row, name, label, help) => kit.toggle({ row, label, help, value: false, onChange: (on) => C(kit, 'videoSet', { name, on }) });
    const hdr = T('apps.video.hdr', 'hdr', 'Stream HDR video', 'Plays HDR video in HDR when the display supports it');
    const enhance = T('apps.video.enhance', 'enhance', 'Automatically process video to enhance it', 'Depends on your graphics hardware');
    const quality = kit.choice({ row: 'apps.video.battery', label: 'Battery options', help: 'When watching video on battery power', value: 'battery',
      options: [{ value: 'battery', label: 'Optimize for battery life' }, { value: 'quality', label: 'Optimize for video quality' }],
      onChange: (v) => C(kit, 'videoSet', { name: 'quality', on: v === 'quality' }).then((r) => (r && r.ok && !r.dryRun && typeof r.value === 'boolean' ? Object.assign({}, r, { value: r.value ? 'quality' : 'battery' }) : r)) });
    const lowres = T('apps.video.lowres', 'lowres', 'Play video at a lower resolution when on battery', null);
    const note = kit.h('div', {});
    el.append(kit.card(hdr, enhance), kit.group('Battery options'), kit.card(quality, lowres), note);
    async function read() {
      const r = await C(kit, 'video');
      if (!r || r.ok === false) { const why = bad(r, 'Video playback could not be read'); [hdr, enhance, quality, lowres].forEach((x) => x.set({ disabled: true, reason: why })); return; }
      const v = r.values, dflt = (x) => (x.set ? null : 'Not set yet: Windows\' default applies');
      hdr.set({ value: v.hdr.on, info: dflt(v.hdr), reason: null, disabled: false });
      enhance.set({ value: v.enhance.on, info: dflt(v.enhance), reason: null, disabled: false });
      quality.set({ value: v.quality.on ? 'quality' : 'battery', info: dflt(v.quality), reason: null, disabled: false });
      lowres.set({ value: v.lowres.on, info: dflt(v.lowres), reason: null, disabled: false });
      note.replaceChildren(kit.reason(r.note, { info: true }));
    }
    return read().then(() => ({ update: read, dispose() {} }));
  }

  // ============================================================== Startup (the built-in rows, same commands)
  function renderStartup(el, kit) {
    const head = kit.status({ row: 'apps.startup.count', label: 'Startup apps', help: 'Apps that start when you sign in', value: 'Reading…' });
    const box = kit.h('div', {});
    const tm = kit.button({ row: 'apps.taskmgr', label: 'Task manager', help: 'Mantle\'s own view of what is running', text: 'Open',
      onClick: () => (kit.test ? { ok: true, dryRun: true, reason: 'Test run, nothing opened: Mantle would open its task manager' } : kit.call('taskmgr.open', { view: 'apps' })) });
    el.append(kit.group('Startup apps', { row: 'apps.startup' }), kit.card(head), box,
      kit.reason('Store apps that start themselves use their own startup tasks, which Windows keeps per app; Mantle does not list or switch those yet.', { info: true }),
      kit.group('More'), kit.card(tm));
    let sig = '';
    const toggles = new Map();
    async function read() {
      const r = await kit.call('settings.startup', {});
      if (kit.disposed) return;
      const items = r && Array.isArray(r.items) ? r.items : [];
      if (!r || r.ok === false) { head.set({ value: '—', reason: bad(r, 'Startup apps could not be read') }); box.replaceChildren(); sig = ''; return; }
      const on = items.filter((i) => i.enabled).length;
      head.set({ value: on + ' of ' + items.length + ' on', reason: (r.problems || []).join('; ') || null,
        info: 'Mantle turns an entry off the way Windows does (StartupApproved); it never deletes one' });
      const now = items.map((i) => i.item).join('\n');
      if (now !== sig) {
        sig = now; toggles.clear();
        const rows = items.map((it) => {
          const t = kit.toggle({ row: 'apps.startup.' + hash(it.item), label: it.name || it.item, value: !!it.enabled,
            help: [it.sourceLabel || it.source, cut(it.command, 60)].filter(Boolean).join(' · '),
            disabled: it.canToggle === false, reason: it.canToggle === false ? (it.reason || 'Mantle cannot switch this entry, and gave no reason') : null,
            onChange: (v) => kit.call('settings.startupSet', { item: it.item, on: v }).then((r) => { if (r && r.ok && !r.dryRun) setTimeout(read, 250); return r; }) });
          toggles.set(it.item, t);
          return t;
        });
        box.replaceChildren(items.length ? kit.card(...rows) : kit.card(kit.reason('Nothing is set to start when you sign in', { info: true })));
      } else items.forEach((it) => { const t = toggles.get(it.item); if (t) t.set({ value: !!it.enabled }); });
    }
    return read().then(() => ({ update: read, dispose() {} }));
  }

  // ============================================================== the section
  const R = (row, label, keywords, uri) => (uri ? { row, label, keywords, uri } : { row, label, keywords });
  MantleSettings.section({
    id: 'applist',
    title: 'Apps',
    group: 'windows',
    icon: 'apps',
    order: 50,
    help: 'Installed apps, default apps, optional features, startup',
    keywords: 'apps programs software applications uninstall remove install',
    replaces: ['apps'],
    pages: [
      { id: 'installed', title: 'Installed apps', icon: 'apps', help: 'Uninstall and modify apps, sizes and drives',
        search: [R('apps.installed', 'Installed apps', 'uninstall remove programs apps and features add or remove software', 'ms-settings:appsfeatures'),
          R('apps.installed.count', 'How many apps are installed', 'count total size'), R('apps.installed.search', 'Search installed apps', 'find app'),
          R('apps.installed.sort', 'Sort apps', 'sort name size install date publisher'), R('apps.installed.drive', 'Filter apps by drive', 'drive disk c: d: filter')],
        render: renderInstalled },
      { id: 'advanced', title: 'Advanced app settings', icon: SVG.gear, help: 'Where to get apps, share across devices, archive apps, aliases',
        search: [R('apps.advanced.source', 'Choose where to get apps', 'microsoft store only anywhere install from', 'ms-settings:advanced-apps'),
          R('apps.advanced.share', 'Share across devices', 'continue apps other devices cdp'), R('apps.advanced.archive', 'Archive apps', 'offload unused apps save space'),
          R('apps.advanced.aliases', 'App execution aliases', 'alias python winget command line exe', 'ms-settings:appexecutionalias')],
        render: renderAdvanced },
      { id: 'defaults', title: 'Default apps', icon: SVG.check, help: 'Which app opens each file and link type',
        search: [R('apps.defaults', 'Default apps', 'default browser file associations open with file type', 'ms-settings:defaultapps'),
          R('apps.defaults.browser', 'Default web browser', 'browser http https chrome edge firefox'), R('apps.defaults.mail', 'Default email app', 'mail mailto outlook'),
          R('apps.defaults.pdf', 'Default PDF reader', 'pdf reader acrobat'), R('apps.defaults.search', 'Search file and link types', 'extension protocol'),
          R('apps.defaults.files', 'Default apps by file type', 'extension .jpg .mp4 .txt'), R('apps.defaults.links', 'Default apps by link type', 'protocol mailto tel http')],
        render: renderDefaults },
      { id: 'features', title: 'Optional features', icon: SVG.puzzle, help: 'Installed features and Windows features',
        search: [R('apps.features', 'Optional features', 'features on demand fod capabilities add feature', 'ms-settings:optionalfeatures'),
          R('apps.features.available', 'Optional features not installed', 'available more features'), R('apps.features.installed', 'Installed optional features', 'installed features openssh notepad wmic'),
          R('apps.features.windows-count', 'More Windows features', 'turn windows features on or off hyper-v wsl sandbox .net'), R('apps.features.windows', 'Windows features that are on', 'hyper-v wsl virtual machine platform')],
        render: renderFeatures },
      { id: 'websites', title: 'Apps for websites', icon: SVG.globe, help: 'Apps that open links for websites',
        search: [R('apps.websites', 'Apps for websites', 'open links in app instead of browser', 'ms-settings:appsforwebsites'), R('apps.websites.list', 'Websites each app opens', 'sites links app handlers')],
        render: renderWebsites },
      { id: 'video', title: 'Video playback', icon: SVG.video, help: 'HDR streaming, video processing, battery',
        search: [R('apps.video.hdr', 'Stream HDR video', 'hdr video streaming', 'ms-settings:videoplayback'), R('apps.video.enhance', 'Automatically process video to enhance it', 'enhance video processing'),
          R('apps.video.battery', 'Video battery options', 'battery life video quality'), R('apps.video.lowres', 'Play video at a lower resolution on battery', 'low resolution battery')],
        render: renderVideo },
      { id: 'apps', title: 'Startup', icon: SVG.rocket, help: 'Apps that start when you sign in, Task manager',
        search: [R('apps.startup', 'Startup apps', 'startup autostart launch at login run at startup boot', 'ms-settings:startupapps'),
          R('apps.startup.count', 'How many startup apps are on', 'startup count'), R('apps.taskmgr', 'Task manager', 'task manager processes running apps end task')],
        render: renderStartup },
    ],
  });
})();

/* update.js — Settings > Windows Update, done natively (lane gameupd, 2026-09-29).
 *
 * Windows Update's pages through settings.update.* (lib/features/_settings-sections/update.js ->
 * sidecar/SysUpdate.cs, the Windows Update Agent COM API + the values Windows' own Settings keeps):
 *   Windows Update   status (restart needed, updates waiting, last checked / installed, the build),
 *                    Check for updates (a real online check; a dry run in a test run), the updates this
 *                    PC needs, Pause updates 1-5 weeks (administrator prompt)
 *   Update history   every install and removal, newest first, failures with their code
 *                    (a running pause is EXTENDED from the day it began, as Windows counts its limit);
 *                    "Windows Update is busy" with Try again when the update agent refuses a check
 *   Advanced options active hours, Automatically or Manually (administrator prompt), the Advanced switches, optional updates and
 *                    Delivery Optimization (read-only, each with its reason)
 *   Windows Insider Program  read-only with its reason
 * Mantle never installs, removes or restarts for updates: those rows say so. Kit only (SECTIONS.md).
 */
(function () {
  'use strict';
  const C = (kit, name, args) => kit.call('settings.update.' + name, args || {});
  // a reason that already starts with the same words is not said twice ("...could not be read: ...could not be read: ...")
  const bad = (r, what) => (r && r.ok === false ? (r.reason && r.reason.toLowerCase().startsWith(what.toLowerCase()) ? r.reason : what + ': ' + (r.reason || 'no reason came back')) : null);
  const PAUSE_DOES = 'pause or resume Windows Update for this PC';
  const HOURS_DOES = 'change the active hours Windows Update keeps for this PC';
  const SMART_DOES = 'change how Windows Update sets the active hours for this PC';
  const WEEK = 7 * 864e5;
  const INSTALL_WHY = 'Read only here: Windows Update downloads and installs these by itself outside your active hours; Mantle lists them and never installs or removes an update';
  const when = (ms) => { try { return new Date(ms).toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch (_) { return String(ms); } };
  const day = (ms) => { try { return new Date(ms).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'long' }); } catch (_) { return String(ms); } };
  const ago = (ms) => { const m = Math.round((Date.now() - ms) / 60000); return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : m < 1440 ? Math.round(m / 60) + ' h ago' : when(ms); };
  const hour = (h) => String(h).padStart(2, '0') + ':00';
  const size = (b) => (b == null ? null : b >= 1e9 ? (b / 1e9).toFixed(1) + ' GB' : b >= 1e6 ? Math.round(b / 1e6) + ' MB' : Math.max(1, Math.round(b / 1e3)) + ' KB');
  const KIND = { update: 'Update', driver: 'Driver', definition: 'Definitions', security: 'Security', feature: 'Feature update' };
  const keyOf = (s) => { let x = 5381; for (const ch of String(s)) x = ((x * 33) ^ ch.codePointAt(0)) >>> 0; return 'k' + x.toString(36); };
  const SVG = {
    clock: '<circle cx="8" cy="8" r="6.2"/><path d="M8 4.6V8l2.3 1.5"/>',
    gear: '<circle cx="8" cy="8" r="2.2"/><path d="M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2M3.6 3.6l1.4 1.4M11 11l1.4 1.4M3.6 12.4 5 11M11 5l1.4-1.4"/>',
    flask: '<path d="M6 1.8h4M6.6 1.8v4.4L2.8 13a1 1 0 0 0 .9 1.4h8.6a1 1 0 0 0 .9-1.4L9.4 6.2V1.8"/><path d="M4.6 10h6.8"/>',
  };
  // A title that is only a KB number still gets a name a person can read.
  const named = (t) => (!t ? 'Windows update' : /^\s*KB\d+\s*$/i.test(t) ? 'Windows update ' + t.trim().toUpperCase() : t);
  const items = (list) => (list || []).map((u) => ({ key: keyOf(u.uid || u.title), label: named(u.title),
    help: [u.kb && u.kb.length ? u.kb.join(', ') : null, size(u.size), u.downloaded ? 'Downloaded' : null].filter(Boolean).join(' · ') || null, value: KIND[u.kind] || 'Update' }));

  // ============================================================== Windows Update
  function renderMain(el, kit) {
    const head = kit.status({ row: 'update.main.status', label: 'Windows Update', value: 'Reading…' });
    const build = kit.status({ row: 'update.main.build', label: 'Windows version', value: 'Reading…' });
    const checked = kit.status({ row: 'update.main.checked', label: 'Last checked', value: '' });
    const installed = kit.status({ row: 'update.main.installed', label: 'Last installed', value: '' });
    const restart = kit.status({ row: 'update.main.restart', label: 'Restart', value: '',
      info: 'Read only here: Mantle never restarts your PC for updates; restart from Start when it suits you and Windows finishes installing then' });
    const check = kit.button({ row: 'update.main.check', label: 'Check for updates', help: 'Asks Microsoft for new updates now; nothing is downloaded or installed by this', text: 'Check for updates', tone: 'acc',
      onClick: () => C(kit, 'check').then((r) => { if (r.ok && !r.dryRun) { S.checking = true; readStatus(); } return r; }) });
    const note = kit.h('div', {});
    const pending = kit.list({ row: 'update.main.pending', items: [], empty: 'Reading the updates this PC needs…' });
    const pause = kit.choice({ row: 'update.main.pause', label: 'Pause updates', admin: PAUSE_DOES, style: 'dropdown', options: [], value: '0',
      onChange: (v) => {
        if (v === 'paused') return { ok: true, value: 'paused' };   // the current state: nothing to do
        const ext = /^x[1-5]$/.test(v);   // "x<w>": extend the running pause to <w> weeks after it began
        return C(kit, 'pause', ext ? { weeks: Number(v.slice(1)), extend: true } : { weeks: Number(v) })
          .then((r) => { if (r.ok && !r.dryRun) setTimeout(readStatus, 300); return r; });
      } });
    el.append(kit.card(head, check), kit.card(build, checked, installed, restart), kit.group('Updates this PC needs'), note, kit.card(pending), kit.group('More options'), kit.card(pause));

    const S = { st: null, list: null, checking: false };
    function drawHead() {
      const r = S.st, l = S.list;
      if (!r) return;
      const c = r.check || {};
      const n = l && l.ok !== false ? l.pending.length : null;
      const busy = !!(c.busy && !c.running), installing = r.installing === true && !c.running && !busy;
      const v = c.running ? 'Checking for updates…' : busy ? 'Windows Update is busy' : installing ? 'Installing updates…' : r.rebootRequired ? 'Restart required'
        : n ? n + (n === 1 ? ' update' : ' updates') + ' waiting' : n === 0 ? 'You\'re up to date' : 'Reading…';
      head.set({ value: v, tone: c.running || installing ? 'info' : busy || r.rebootRequired || n ? 'warn' : n === 0 ? 'ok' : null,
        help: installing ? 'Windows Update is installing updates by itself; Mantle never installs or restarts' : r.pause && r.pause.paused ? 'Updates are paused until ' + day(r.pause.until)
          : r.noAutoUpdate ? null : 'Windows Update checks and installs by itself outside your active hours',
        // words only: main turned the check's code into these (lib/features/_settings-sections/update.js BUSY / WHY)
        reason: r.noAutoUpdate || (busy ? c.error : c.error && !c.running ? 'The last check did not finish: ' + c.error : null),
        info: c.finished && !c.running && !c.error ? 'Checked ' + ago(c.finished) + ': ' + (c.found || 0) + ' found' + (c.optional ? ', ' + c.optional + ' optional' : '') : null });
      check.set({ disabled: !!c.running, text: c.running ? 'Checking…' : busy ? 'Try again' : 'Check for updates',
        help: busy ? 'Asks Windows Update again; it said it was busy last time' : 'Asks Microsoft for new updates now; nothing is downloaded or installed by this' });
    }
    function drawStatus(r, why) {
      S.st = r;
      if (!r) {
        [head, build, checked, installed, restart].forEach((x) => x.set({ value: '—', reason: why }));
        pause.set({ disabled: true, reason: why });
        return;
      }
      const b = r.build || {};
      build.set({ value: [b.name, b.version].filter(Boolean).join(' ') || 'Windows', help: 'Build ' + (b.build || 'unknown') });
      checked.set({ value: r.lastCheck ? when(r.lastCheck) : r.wuaWhy ? '—' : 'Never', reason: r.wuaWhy || null });
      installed.set({ value: r.lastInstall ? when(r.lastInstall) : r.wuaWhy ? '—' : 'Never', reason: r.wuaWhy || null });
      restart.set({ value: r.rebootRequired === true ? 'Needed to finish installing' : r.rebootRequired === false ? 'Not needed' : 'Not reported', tone: r.rebootRequired ? 'warn' : 'ok' });
      const p = r.pause || {};
      const max = p.maxDays || 35, weeks = [1, 2, 3, 4, 5].filter((w) => w * 7 <= max);
      let opts, help, info = null, reason = p.locked ? 'Read only here: ' + p.locked : null;
      if (p.paused) {
        // Windows counts its limit from the day the pause BEGAN: an extension moves the end, never the start
        const ext = p.since ? weeks.filter((w) => p.since + w * WEEK > p.until).map((w) => ({ value: 'x' + w, label: 'Extend to ' + day(p.since + w * WEEK) })) : [];
        opts = [{ value: 'paused', label: 'Paused until ' + day(p.until) }, { value: '0', label: 'Resume updates' }].concat(ext);
        help = p.since ? 'Paused since ' + day(p.since) + '. Windows allows ' + Math.floor(max / 7) + ' weeks in all, counted from that day' : 'Paused';
        if (!reason && !p.since) reason = 'Windows did not record when this pause began, so Mantle cannot extend it; resume updates, then pause again';
        else if (!reason && !ext.length) info = 'This pause is already as long as Windows allows. Windows asks for updates to be installed before they can be paused again';
      } else {
        opts = [{ value: '0', label: 'Not paused' }].concat(weeks.map((w) => ({ value: String(w), label: 'Pause for ' + w + (w === 1 ? ' week' : ' weeks') })));
        help = 'Stops updates for up to ' + Math.floor(max / 7) + ' weeks';
      }
      pause.set({ options: opts, value: p.paused ? 'paused' : '0', disabled: !!p.locked, reason, info, help,
        admin: p.locked ? null : p.admin === false ? true : PAUSE_DOES });
      drawHead();
    }
    async function readStatus() {
      const r = await C(kit, 'status');
      const was = S.checking;
      S.checking = !!(r && r.check && r.check.running);
      drawStatus(r && r.ok !== false ? r : null, bad(r, 'Windows Update could not be read'));
      if (was && !S.checking) readList();
    }
    async function readList() {
      const l = await C(kit, 'list');
      S.list = l;
      note.replaceChildren(kit.reason(INSTALL_WHY, { info: true }));
      pending.set(l && l.ok !== false ? { items: items(l.pending), empty: 'None: Windows Update knows of nothing this PC still needs' } : { items: [], empty: bad(l, 'The updates could not be read') });
      drawHead();
    }
    kit.every(2000, () => { if (S.checking) readStatus(); });
    kit.every(60000, readStatus);
    const all = () => Promise.all([readStatus(), readList()]);
    return readStatus().then(() => { readList(); return { update: all, dispose() {} }; });
  }

  // ============================================================== Update history
  function renderHistory(el, kit) {
    const count = kit.status({ row: 'update.history.count', label: 'Updates in the history', value: 'Reading…',
      info: 'Mantle shows the history; removing an installed update is not something Mantle does' });
    const list = kit.list({ row: 'update.history.list', items: [], empty: 'Reading the update history…' });
    el.append(kit.card(count), kit.group('Newest first'), kit.card(list));
    async function read() {
      const r = await C(kit, 'history', { count: 60 });
      if (!r || r.ok === false) { const why = bad(r, 'The update history could not be read'); count.set({ value: '—', reason: why }); return list.set({ items: [], empty: why }); }
      const failed = r.items.filter((h) => !h.ok).length;
      count.set({ value: String(r.total), help: 'The newest ' + r.items.length + ' are listed' + (failed ? ', ' + failed + ' did not succeed' : ''), reason: null });
      // Words only: main turns the failure's code into words (lib/features/_settings-sections/update.js WHY); the code never shows.
      list.set({ empty: 'Windows has no update history yet', items: r.items.map((h, i) => ({ key: 'h' + i + keyOf(h.title + h.date), label: named(h.title),
        help: (h.date ? when(h.date) : 'No date') + (h.op === 'uninstall' ? ' · removed' : ''), value: h.result,
        reason: h.ok ? null : h.why || 'Windows Update did not give a reason' })) });
    }
    return read().then(() => ({ update: read, dispose() {} }));
  }

  // ============================================================== Advanced options
  const FLAGS = [['latest', 'update.advanced.latest', 'Get the latest updates as soon as they\'re available', 'Non-security updates and features as soon as they roll out'],
    ['otherProducts', 'update.advanced.other-products', 'Receive updates for other Microsoft products', 'Office and other Microsoft apps update with Windows'],
    ['expedite', 'update.advanced.expedite', 'Get me up to date', 'Restarts as soon as possible, even inside active hours, to finish updating'],
    ['metered', 'update.advanced.metered', 'Download updates over metered connections', 'Data charges may apply'],
    ['restartNotify', 'update.advanced.restart-notify', 'Notify me when a restart is required to finish updating', 'A notice before Windows restarts']];
  function renderAdvanced(el, kit) {
    const H = Array.from({ length: 24 }, (_, h) => ({ value: h, label: hour(h) }));
    const S = { h: null };
    const hrs = kit.status({ row: 'update.advanced.active-hours', label: 'Active hours', help: 'Windows Update does not restart this PC during these hours', value: 'Reading…' });
    const auto = kit.choice({ row: 'update.advanced.active-auto', label: 'Adjust active hours', admin: SMART_DOES, value: 'manual',
      options: [{ value: 'auto', label: 'Automatically' }, { value: 'manual', label: 'Manually' }],
      onChange: (v) => C(kit, 'smartHours', { on: v === 'auto' }).then((r) => { if (r.ok && !r.dryRun) setTimeout(read, 300); return r; }) });
    const setHours = (start, end) => C(kit, 'activeHours', { start, end }).then((r) => { if (r.ok && !r.dryRun) setTimeout(read, 300); return r; });
    const start = kit.choice({ row: 'update.advanced.active-start', label: 'Start time', admin: HOURS_DOES, style: 'dropdown', options: H, value: 8, onChange: (v) => setHours(v, S.h ? S.h.end : 17) });
    const end = kit.choice({ row: 'update.advanced.active-end', label: 'End time', admin: HOURS_DOES, style: 'dropdown', options: H, value: 17, onChange: (v) => setHours(S.h ? S.h.start : 8, v) });
    const flags = {};
    for (const [k, row, label, help] of FLAGS) flags[k] = kit.status({ row, label, help, value: '' });
    const flagWhy = kit.h('div', {});
    const opt = kit.list({ row: 'update.advanced.optional', items: [], empty: 'Reading the optional updates…' });
    const dlv = kit.status({ row: 'update.advanced.delivery', label: 'Allow downloads from other PCs', help: 'Delivery Optimization shares update downloads between PCs', value: 'Reading…' });
    el.append(kit.group('Active hours'), kit.card(hrs, auto, start, end), kit.group('Options'), kit.card(...FLAGS.map(([k]) => flags[k]), flagWhy),
      kit.group('Optional updates'), kit.card(kit.reason(INSTALL_WHY, { info: true }), opt), kit.group('Delivery Optimization'), kit.card(dlv));
    async function read() {
      const r = await C(kit, 'status');
      if (!r || r.ok === false) {
        const why = bad(r, 'Windows Update could not be read');
        [hrs, dlv].concat(Object.values(flags)).forEach((x) => x.set({ value: '—', reason: why }));
        return [auto, start, end].forEach((x) => x.set({ disabled: true, reason: why }));
      }
      const h = S.h = r.hours || {};
      const lock = h.locked ? 'Read only here: ' + h.locked : null;
      hrs.set({ value: h.auto ? 'Set by Windows' : hour(h.start) + ' – ' + hour(h.end), reason: null,
        info: h.auto ? 'Windows last stored ' + hour(h.start) + ' – ' + hour(h.end) : !h.set ? 'Not set yet: Windows\' default applies' : null });
      auto.set({ value: h.auto ? 'auto' : 'manual', disabled: !!lock, reason: lock, admin: lock ? null : h.admin === false ? true : SMART_DOES,
        help: h.auto ? 'Windows sets them from when you use this PC' : 'You choose when they start and end' });
      for (const x of [[start, h.start], [end, h.end]]) x[0].set({ value: x[1], disabled: !!lock || !!h.auto, reason: lock, admin: lock ? null : h.admin === false ? true : HOURS_DOES,
        info: h.auto && !lock ? 'Windows sets this while Adjust active hours is Automatically' : null });
      const f = r.flags || {};
      for (const [k] of FLAGS) {
        const v = f[k] || {};
        flags[k].set({ value: v.on ? 'On' : 'Off', tone: v.on ? 'ok' : null, info: v.set ? null : 'Not set: Windows\' default applies' });
      }
      flagWhy.replaceChildren(kit.reason('Read only here: ' + (f.why || 'Windows keeps these'), { info: true }));
      const d = r.delivery || {};
      dlv.set({ value: d.words || 'Not readable', tone: d.words ? 'info' : null, reason: d.words ? null : d.why || 'Windows did not say', info: 'Read only here: ' + (d.readOnly || 'Windows keeps this') });
    }
    async function readOpt() {
      const l = await C(kit, 'list');
      opt.set(l && l.ok !== false ? { items: items(l.optional), empty: 'No optional updates right now' } : { items: [], empty: bad(l, 'The optional updates could not be read') });
    }
    const all = () => Promise.all([read(), readOpt()]);
    return read().then(() => { readOpt(); return { update: all, dispose() {} }; });
  }

  // ============================================================== Windows Insider Program
  function renderInsider(el, kit) {
    const st = kit.status({ row: 'update.insider.state', label: 'Windows Insider Program', help: 'Preview builds of Windows before they are released', value: 'Reading…' });
    el.append(kit.card(st));
    async function read() {
      const r = await C(kit, 'status');
      if (!r || r.ok === false) return st.set({ value: '—', reason: bad(r, 'Windows Update could not be read') });
      const i = r.insider || {};
      st.set({ value: i.joined ? 'Joined' + (i.channel ? ': ' + i.channel : '') : 'Not joined', tone: i.joined ? 'info' : null, info: 'Read only here: ' + (i.why || 'only Windows\' own Settings joins or leaves it'), reason: null });
    }
    return read().then(() => ({ update: read, dispose() {} }));
  }

  // ============================================================== the section
  MantleSettings.section({
    id: 'update',
    title: 'Windows Update',
    group: 'windows',
    icon: 'refresh',
    order: 110,
    help: 'Updates, pause, history, active hours',
    keywords: 'windows update updates patch upgrade',
    pages: [
      { id: 'windows-update', title: 'Check for updates', icon: 'refresh', help: 'Check for updates, what this PC needs, pause',
        search: [
          { row: 'update.main.check', label: 'Check for updates', keywords: 'check updates now scan patch upgrade', uri: 'ms-settings:windowsupdate' },
          { row: 'update.main.status', label: 'Windows Update status', keywords: 'up to date updates available status' },
          { row: 'update.main.build', label: 'Windows version', keywords: 'build version os 24h2 25h2' },
          { row: 'update.main.checked', label: 'Last checked for updates', keywords: 'last checked' },
          { row: 'update.main.installed', label: 'Last installed update', keywords: 'last installed' },
          { row: 'update.main.restart', label: 'Restart required', keywords: 'restart reboot pending finish installing' },
          { row: 'update.main.pending', label: 'Updates this PC needs', keywords: 'pending updates waiting download install' },
          { row: 'update.main.pause', label: 'Pause updates', keywords: 'pause resume stop delay updates weeks' },
        ], render: renderMain },
      { id: 'history', title: 'Update history', icon: SVG.clock, help: 'Every update installed or removed',
        search: [
          { row: 'update.history.list', label: 'Update history', keywords: 'installed updates history failed', uri: 'ms-settings:windowsupdate-history' },
          { row: 'update.history.count', label: 'Updates in the history', keywords: 'how many updates installed' },
        ], render: renderHistory },
      { id: 'advanced', title: 'Advanced options', icon: SVG.gear, help: 'Active hours, optional updates, Delivery Optimization',
        search: [
          { row: 'update.advanced.active-hours', label: 'Active hours', keywords: 'active hours restart schedule working hours', uri: 'ms-settings:windowsupdate-options' },
          { row: 'update.advanced.active-auto', label: 'Adjust active hours automatically', keywords: 'active hours automatic automatically smart intelligent manual manually' },
          { row: 'update.advanced.active-start', label: 'Active hours start time', keywords: 'active hours start' },
          { row: 'update.advanced.active-end', label: 'Active hours end time', keywords: 'active hours end' },
          { row: 'update.advanced.optional', label: 'Optional updates', keywords: 'optional updates drivers' },
          { row: 'update.advanced.delivery', label: 'Delivery Optimization', keywords: 'download other pcs peer bandwidth delivery optimization', uri: 'ms-settings:delivery-optimization' },
        ].concat(FLAGS.map(([, row, label]) => ({ row, label, keywords: 'advanced update option' }))), render: renderAdvanced },
      { id: 'insider', title: 'Windows Insider Program', icon: SVG.flask, help: 'Preview builds',
        search: [{ row: 'update.insider.state', label: 'Windows Insider Program', keywords: 'insider preview builds dev beta canary release preview', uri: 'ms-settings:windowsinsider' }], render: renderInsider },
    ],
  });
})();

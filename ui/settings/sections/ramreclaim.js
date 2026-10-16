/* ramreclaim.js — Mantle Settings > Windows pieces (lane mantle-ramreclaim, 2026-10-15).
 *
 * The Windows parts Mantle has replaced, each with what it uses right now and a switch: On = Mantle keeps
 * that Windows piece off (your own settings only, recorded first, put back on every road out). Pieces
 * that need administrator rights, a policy or removing an app are shown OFF and locked, with why: Owen
 * decides those. Pieces with no safe switch say so. Main: lib/features/ramreclaim.js (ramreclaim.list /
 * ramreclaim.set); no main half of its own. Never silent: every row says its state and why.
 */
(() => {
const SEARCH = [
  { row: 'ramreclaim.status', label: 'Windows pieces turned off by Mantle', keywords: 'ram memory save free' },
  { row: 'ramreclaim.widgets-prelaunch', label: 'Don’t load Windows’ Widgets board at sign-in', keywords: 'widgets board preload memory' },
  { row: 'ramreclaim.search-highlights', label: 'Turn off Windows’ search highlights', keywords: 'search highlights pictures trending bing' },
  { row: 'ramreclaim.lockscreen-widgets', label: 'Turn off widgets on the lock screen', keywords: 'lock screen weather widgets' },
  { row: 'ramreclaim.search-window', label: 'Turn off Windows’ search window', keywords: 'searchhost search ui policy administrator' },
  { row: 'ramreclaim.widgets-all', label: 'Turn off Windows’ Widgets completely', keywords: 'widgets policy administrator news and interests' },
  { row: 'ramreclaim.widgets-package', label: 'Remove Windows’ Widgets app', keywords: 'web experience pack uninstall widgets' },
  { row: 'ramreclaim.start-menu', label: 'Windows’ Start menu', keywords: 'start menu memory' },
];

MantleSettings.section({
  id: 'ramreclaim',
  title: 'Windows pieces',
  group: 'mantle',
  // two stacked pieces with one lifted off
  icon: '<path d="M2.5 9.5h7v4h-7z"/><path d="M6.5 2.5h7v4h-7z"/><path d="M4 7.5l2-2"/>',
  order: 1006,
  help: 'Windows parts Mantle replaces, turned off to save memory',
  keywords: 'memory ram save free windows widgets search highlights start menu searchhost background preload',
  search: SEARCH,
  render(el, kit) {
    const SWITCHES = ['widgets-prelaunch', 'search-highlights', 'lockscreen-widgets'];
    const LISTED = ['search-window', 'widgets-all', 'widgets-package'];
    const KEPT = ['start-menu'];
    const LABELS = {};
    SEARCH.forEach((s) => { LABELS[s.row.slice('ramreclaim.'.length)] = s.label; });
    const notes = kit.h('div', { class: 'rr-notes' });
    const status = kit.status({
      row: 'ramreclaim.status', label: 'Turned off by Mantle',
      help: 'They take effect from your next sign-in. Everything is put back when you quit Mantle, switch a piece back on here, restore the Windows taskbar, or remove Mantle.',
      value: '…',
    });
    const controls = {};
    for (const id of SWITCHES) {
      controls[id] = kit.toggle({
        row: 'ramreclaim.' + id, label: LABELS[id], help: '', value: false, disabled: true,
        onChange: async (on) => {
          const r = await kit.call('ramreclaim.set', { id, on });
          setTimeout(update, 0);
          return r;
        },
      });
    }
    for (const id of LISTED) controls[id] = kit.toggle({ row: 'ramreclaim.' + id, label: LABELS[id], help: '', value: false, disabled: true });
    for (const id of KEPT) controls[id] = kit.status({ row: 'ramreclaim.' + id, label: LABELS[id], help: '', value: '' });
    el.append(
      notes, kit.card(status),
      kit.group('Mantle turns these off'), kit.card(...SWITCHES.map((id) => controls[id])),
      kit.group('Your call', { aside: 'administrator rights, a policy or removing an app' }), kit.card(...LISTED.map((id) => controls[id])),
      kit.group('Stays on'), kit.card(...KEPT.map((id) => controls[id])),
    );

    const mem = (p) => {
      if (!p.ram) return 'Memory not shown right now';
      const now = p.ram.running ? `uses ${p.ram.mb} MB now` : 'not running now';
      return p.ramNote ? `${p.ramNote} (Windows’ search ${now})` : (p.ram.running ? `Uses ${p.ram.mb} MB now` : 'Not running now');
    };
    const time = (iso) => { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); };
    const stateLine = (p) => {
      switch (p.state) {
        case 'applied': return p.keptForSignOut ? 'Kept off through your last sign-out, so Windows skipped it at sign-in'
          : (p.reason || `Off since ${time(p.since)}. Saves memory from your ${p.effect || 'next sign-in'}`);
        case 'already': return 'Windows already has this off: nothing to change';
        case 'paused': return 'Saved as on, but turning off Windows pieces is switched off in Mantle’s features, so Windows runs it';
        case 'off': return p.reason || 'Windows runs it';
        default: return null;
      }
    };

    async function update() {
      const r = await kit.call('ramreclaim.list', {});
      if (kit.disposed) return;
      notes.replaceChildren();
      if (!r || !r.ok) {
        notes.append(kit.reason('The Windows pieces could not be read: ' + ((r && r.reason) || 'no answer came back')));
        status.set({ value: '—' });
        for (const id of SWITCHES.concat(LISTED)) controls[id].set({ disabled: true, reason: null, info: null });
        return;
      }
      if (r.test) notes.append(kit.reason('This is a test copy of Mantle: nothing is changed in Windows.', { info: true }));
      if (r.on === false) notes.append(kit.reason('Turning off Windows pieces is switched off in Mantle’s features, so Windows runs all of them.', { info: true }));
      if (r.journalError) notes.append(kit.reason('Mantle could not read its undo record: ' + r.journalError));
      if (r.measureReason) notes.append(kit.reason(r.measureReason, { info: true }));
      const by = {};
      (r.pieces || []).forEach((p) => { by[p.id] = p; });
      let off = 0, freedMb = 0;
      for (const id of SWITCHES) {
        const p = by[id];
        if (!p) { controls[id].set({ disabled: true, reason: 'Mantle did not list this piece', info: null }); continue; }
        if (p.state === 'applied') off++;
        if (p.state === 'applied' && p.ram && p.ram.running && !p.ramNote) freedMb += p.ram.mb;
        const bad = p.state === 'error' || p.state === 'drift';
        controls[id].set({
          value: !!p.wanted, disabled: false,
          help: `${p.help} Turning it off: ${p.breaks}`,
          reason: bad ? p.reason : null,
          info: [mem(p), bad ? null : stateLine(p)].filter(Boolean).join('. '),
        });
      }
      for (const id of LISTED) {
        const p = by[id];
        if (!p) { controls[id].set({ reason: 'Mantle did not list this piece', info: null }); continue; }
        controls[id].set({
          value: false, disabled: true, admin: !!p.admin,
          help: `${p.help} If it is done: ${p.breaks}`,
          reason: null,
          info: `${mem(p)}. Off and locked: ${p.why} How: ${p.how}`,
        });
      }
      for (const id of KEPT) {
        const p = by[id];
        controls[id].set({ value: p ? mem(p) : '', help: p ? p.help : 'Mantle did not list this piece' });
      }
      status.set({ value: off === 1 ? '1 piece' : `${off} pieces`, info: freedMb ? `Still loaded from before: ${freedMb} MB. It goes at your next sign-in.` : null });
    }
    update();
    kit.every(10000, update);
    return { update, dispose() {} };
  },
});
})();

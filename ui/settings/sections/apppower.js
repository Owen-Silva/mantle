/* apppower.js — Mantle Settings > App power (lane mantle-power-ui, 2026-10-14).
 *
 * The limits the user sets from the top bar's CPU / RAM / GPU meters (ui/topbar/apppower.js), listed in one
 * place: each app with what is set for it ("Efficiency mode, CPU limit 25%"), a Remove per app and Reset
 * all. Both are undone with Undo (apppower.restoreRules puts back exactly what was removed): undo over
 * confirm. Main: lib/features/apppower.js (apppower.rules / forget / resetAll / restoreRules); no main half
 * of its own. A failed read says why in place of the list; App power switched off and a test copy say so.
 */
MantleSettings.section({
  id: 'apppower',
  title: 'App power',
  group: 'mantle',
  // a gauge (the built-in 'power' icon is Power & battery's battery, two rows above)
  icon: '<path d="M2.25 11.75a5.75 5.75 0 1 1 11.5 0"/><path d="M8 11.75l2.75-3.5"/><path d="M4.4 7.6l.7.6M8 5.25v.9M11.6 7.6l-.7.6"/>',
  order: 1005,
  help: 'CPU, memory and graphics limits for apps',
  keywords: 'cpu limit efficiency mode priority memory ram limit gpu graphics slow down throttle',
  search: [
    { row: 'apppower.rules', label: 'App limits', keywords: 'cpu limit efficiency mode memory limit priority graphics remove' },
    { row: 'apppower.reset', label: 'Reset all app limits', keywords: 'clear remove every limit back to normal' },
  ],
  render(el, kit) {
    const EMPTY = 'No app limits yet. Open the CPU, memory or graphics meter in the top bar to set one.';
    let rules = new Map();
    const notes = kit.h('div', { class: 'ap-notes' });
    const undoBox = kit.h('div', { class: 'ap-undo' });
    const list = kit.list({
      row: 'apppower.rules', items: [], empty: EMPTY,
      onAction: async (key, id) => {
        if (id !== 'forget') return { ok: false, reason: 'That button does nothing here' };
        const rule = rules.get(key);
        const r = await kit.call('apppower.forget', { key });
        if (r.ok) {
          offerUndo(`Removed the limits for ${(rule && rule.label) || 'this app'}`, 'It runs normally again', rule ? [rule] : []);
          show(r.rules);
        }
        return r;
      },
    });
    const reset = kit.button({
      row: 'apppower.reset', label: 'Reset all', help: 'Removes every app limit and runs every app normally again', text: 'Reset all',
      onClick: async () => {
        const r = await kit.call('apppower.resetAll', {});
        if (r.ok) {
          const n = (r.removed || []).length;
          offerUndo(n === 1 ? 'Removed 1 app limit' : `Removed ${n} app limits`, 'Every app runs normally again', r.removed || []);
          show(r.rules || []);
        }
        return r;
      },
    });
    el.append(kit.group('Apps with limits'), notes, kit.card(list), undoBox, kit.card(reset));

    // UNDO: what was just removed, put back exactly as it was
    function offerUndo(label, help, removed) {
      if (!removed.length) { undoBox.replaceChildren(); return; }
      const u = kit.button({
        row: 'apppower.undo', label, help, text: 'Undo',
        onClick: async () => {
          const r = await kit.call('apppower.restoreRules', { rules: removed });
          if (r.ok) { undoBox.replaceChildren(); show(r.rules || []); }
          return r;
        },
      });
      undoBox.replaceChildren(kit.card(u));
    }
    function show(list0) {
      const arr = Array.isArray(list0) ? list0 : [];
      rules = new Map(arr.map((x) => [x.key, x]));
      list.set({
        empty: EMPTY,
        items: arr.map((x) => ({ key: x.key, label: x.label || 'An app',
          help: (x.summary || 'Normal') + (x.remembered === false ? ' · Only until Mantle restarts' : ''),
          actions: [{ id: 'forget', text: 'Remove' }] })),
      });
      reset.set({ disabled: !arr.length, reason: null, info: arr.length ? null : 'Nothing to reset' });
    }
    async function update() {
      const r = await kit.call('apppower.rules', {});
      const lines = [];
      if (!r.ok) {
        rules = new Map();
        list.set({ items: [], empty: 'The app limits could not be read: ' + (r.reason || 'Mantle gave no reason') });
        reset.set({ disabled: true, info: null, reason: 'Reset all needs the list first' });
        lines.push(kit.reason('The app limits could not be read: ' + (r.reason || 'Mantle gave no reason')));
      } else {
        if (r.on === false) lines.push(kit.reason('App power is turned off in Mantle’s features, so these limits are not being applied'));
        if (r.test) lines.push(kit.reason('This is a test copy of Mantle: changes are shown, but apps are left as they are', { info: true }));
        show(r.rules);
      }
      notes.replaceChildren(...lines);
    }
    update();
    kit.every(4000, update);
    return { update, dispose() {} };
  },
});

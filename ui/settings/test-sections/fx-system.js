/* fx-system.js — a FIXTURE for the section contract (mock only: index.html?sections=fx-system,...).
 * A category with pages that replaces the built-in Display and Sound: Sound is placed by a
 * placeholder page, Display (not listed) comes first, and Storage is its own page drawn with every
 * kit control. Everything in it is made up. */
MantleSettings.section({
  id: 'fx-system', title: 'System', group: 'windows', order: 10, icon: 'display',
  help: 'Display, sound, storage and more',
  replaces: ['display', 'sound'],
  search: [{ row: 'fx-system.name', label: 'Device name', keywords: 'pc name rename computer' }],
  pages: [
    { id: 'sound' },
    {
      id: 'storage', title: 'Storage', icon: 'apps', help: 'Drives, cleanup and Storage Sense',
      search: [
        { row: 'fx-system.storage.sense', label: 'Storage Sense', keywords: 'cleanup free space automatic', uri: 'ms-settings:storagesense' },
        { row: 'fx-system.storage.temp', label: 'Temporary files', keywords: 'temp cache delete' },
      ],
      render(el, kit) {
        const sense = kit.toggle({ row: 'fx-system.storage.sense', label: 'Storage Sense', help: 'Frees space by itself', value: true,
          onChange: (on) => kit.call('settings.fx-system.set', { value: on }) });
        const stuck = kit.toggle({ row: 'fx-system.storage.stuck', label: 'A switch that cannot move', value: false,
          onChange: () => kit.call('settings.fx-system.fail') });
        const cadence = kit.choice({ row: 'fx-system.storage.cadence', label: 'Run Storage Sense', value: 'week',
          options: [{ value: 'day', label: 'Every day' }, { value: 'week', label: 'Every week' }, { value: 'month', label: 'Every month' }],
          onChange: (v) => kit.call('settings.fx-system.set', { value: v }) });
        const when = kit.choice({ row: 'fx-system.storage.when', label: 'Delete files in Downloads', style: 'dropdown', value: 30,
          options: [{ value: 0, label: 'Never' }, { value: 14, label: 'After 14 days' }, { value: 30, label: 'After 30 days' }, { value: 60, label: 'After 60 days' }],
          onChange: (v) => kit.call('settings.fx-system.set', { value: v }) });
        const level = kit.slider({ row: 'fx-system.storage.level', label: 'Warn when the drive is this full', value: 90, unit: '%', min: 50, max: 99,
          onChange: (v) => kit.call('settings.fx-system.set', { value: v }) });
        const days = kit.number({ row: 'fx-system.storage.days', label: 'Keep the recycle bin for', value: 30, unit: 'days', min: 1, max: 365,
          onChange: (v) => kit.call('settings.fx-system.set', { value: v }) });
        const label = kit.text({ row: 'fx-system.storage.label', label: 'Drive label', value: 'Made-up drive', onChange: (v) => kit.call('settings.fx-system.set', { value: v }) });
        const where = kit.folder({ row: 'fx-system.storage.where', label: 'Save new content to', value: 'D:\\Made-up folder', onChange: (p) => kit.call('settings.fx-system.set', { value: p }) });
        const clean = kit.button({ row: 'fx-system.storage.temp', label: 'Temporary files', help: '1.2 GB (made up)', text: 'Clean up', tone: 'acc',
          onClick: () => kit.call('settings.fx-system.set', {}) });
        const pagefile = kit.button({ row: 'fx-system.storage.pagefile', label: 'Paging file size', admin: 'change the paging file size', text: 'Change',
          onClick: () => kit.call('settings.fx-system.admin') });
        const health = kit.status({ row: 'fx-system.storage.health', label: 'Drive health', value: 'Good', tone: 'ok' });
        const drives = kit.list({ row: 'fx-system.storage.drives', empty: 'No drives',
          items: [
            { key: 'c', label: 'Local disk (C:)', help: '212 GB free of 476 GB', icon: 'apps', actions: [{ id: 'open', text: 'Open' }, { id: 'optimize', text: 'Optimize', admin: true }] },
            { key: 'd', label: 'Made-up drive (D:)', help: '1.1 TB free of 1.8 TB', icon: 'apps', reason: 'This drive is not reporting its health', actions: [{ id: 'open', text: 'Open' }] },
          ],
          onAction: (key, act) => kit.call(act === 'optimize' ? 'settings.fx-system.admin' : 'settings.fx-system.set', { key }) });
        el.append(kit.group('Storage Sense'), kit.card(sense, cadence, when, stuck),
          kit.group('Drives', { aside: '2 drives' }), kit.card(drives),
          kit.group('More'), kit.card(level, days, label, where, clean, pagefile, health),
          kit.reason('A note for the whole page, as info', { info: true }));
        return { update() {}, dispose() {} };
      },
    },
  ],
});

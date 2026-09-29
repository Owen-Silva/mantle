/* fx-lonely.js — a FIXTURE (mock only): a one-page section (no pages) that replaces nothing, drawn
 * directly, plus a render() that throws on its second draw (the "Try again" card). */
let draws = 0;
MantleSettings.section({
  id: 'fx-lonely', title: 'Gaming', group: 'windows', order: 80, icon: 'game',
  search: [{ row: 'fx-lonely.bar', label: 'Game Bar', keywords: 'xbox overlay record' }],
  render(el, kit) {
    draws++;
    if (new URLSearchParams(location.search).get('lonely') === 'throw') throw new Error('made-up render failure');
    const bar = kit.toggle({ row: 'fx-lonely.bar', label: 'Game Bar', help: 'Made-up switch', value: false, onChange: (on) => kit.call('settings.fx-lonely.set', { value: on }) });
    el.append(kit.group('Game Bar'), kit.card(bar));
    return { update() {}, dispose() {} };
  },
});

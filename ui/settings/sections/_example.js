/* _example.js — the worked example from ui/settings/SECTIONS.md. Files starting with _ are NOT loaded:
 * copy it to sections/<your-id>.js (and rename every "example") to start a real section.
 *
 * A one-page section: no `pages`, so render() draws the section itself. Its main half is
 * lib/features/_settings-sections/_example.js (the command settings.example.get / .setGlow).
 */
MantleSettings.section({
  id: 'example',                        // = the file name
  title: 'Example',
  group: 'windows',
  icon: 'display',                      // an icon name settings.js knows, or '<path d="..."/>' (16x16)
  order: 45,                            // SECTIONS.md has the Windows 11 order table
  search: [                             // static: search finds these without drawing the section
    { row: 'example.glow', label: 'Glow', keywords: 'shine light bright' },
  ],
  render(el, kit) {
    const glow = kit.toggle({
      row: 'example.glow', label: 'Glow', help: 'Makes the example glow',
      // the answer has the last word: { ok:false, reason } springs the switch back and shows why
      onChange: (on) => kit.call('settings.example.setGlow', { on }),
    });
    el.append(kit.group('Look'), kit.card(glow));
    async function update() {
      const r = await kit.call('settings.example.get');
      glow.set(r.ok ? { value: r.glow, reason: null } : { reason: 'The glow could not be read: ' + r.reason, disabled: true });
    }
    update();
    kit.every(5000, update);            // stopped for you on dispose, skipped while the window is hidden
    return { update, dispose() { /* nothing of its own: the kit stops its watches and loops */ } };
  },
});

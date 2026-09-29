/* personalization.js — Settings > Personalization, done natively (lane perso, 2026-09-29).
 *
 * Owen: Mantle Settings "should do everything windows can do and more and not ever rely on any old
 * windows feature". So Windows' Personalization pages are here, reading and changing the same values
 * Windows' own Settings does, through settings.personalization.* (lib/features/_settings-sections/
 * personalization.js -> sidecar/SysPerso*.cs). Nothing links out to ms-settings.
 *
 * THE TRUTH ABOUT WHAT OWEN SEES: Mantle draws its OWN wallpaper (lib/wallpaper.js, the Wallpapers
 * window; his Lively library was imported once) above Windows' background, and it REPLACES Start and
 * the taskbar. So Background leads with Mantle's wallpaper and says when Windows' own shows through;
 * Start and Taskbar show Mantle's own options (settings.mantle) and open them inside Mantle Settings.
 * Colors are Windows' and your apps': Mantle's own surfaces keep the One Theme whatever is picked.
 * Lively is only looked at (is it running), never closed or restarted.
 *
 * READ-ONLY with the reason on the row: themes (applying one), the sign-in background and lock screen
 * status, device usage, touch keyboard themes, Dynamic Lighting, and fonts for everyone.
 * Kit only (ui/settings/SECTIONS.md); the swatch grid, the previews and the font samples are plain
 * kit.h nodes styled through CSSOM (the page's CSP has no inline styles).
 */
(function () {
  'use strict';
  const C = (kit, name, args) => kit.call('settings.personalization.' + name, args || {});
  const bad = (r, what) => (r && r.ok === false ? what + ': ' + (r.reason || 'no reason came back') : null);
  const keyOf = (s) => { let x = 5381; for (const ch of String(s)) x = ((x * 33) ^ ch.codePointAt(0)) >>> 0; return 'k' + x.toString(36); };
  const fileUrl = (p) => 'file:///' + String(p).replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/').replace(/^([A-Za-z])%3A/, '$1:');
  const base = (p) => String(p || '').split(/[\\/]/).pop();
  const ONE_THEME = 'Mantle\'s own bar, panels and windows keep Mantle\'s one theme whatever you pick here: these colours are for Windows and your apps';
  const later = (kit, fn) => (r) => { if (r && r.ok && !r.dryRun) setTimeout(() => { if (!kit.disposed) fn(); }, 300); return r; };
  const SET = (kit, key, value, after) => C(kit, 'set', { key, value }).then(later(kit, after));

  const SVG = {
    picture: '<rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><circle cx="5.5" cy="6" r="1.3"/><path d="M1.5 11.5l4-3.5 3 2.5 2.5-2 3.5 3"/>',
    palette: '<path d="M8 1.5a6.5 6.5 0 0 0 0 13c1 0 1.4-.7 1.1-1.5-.4-1 .2-2 1.3-2h1.6a3 3 0 0 0 3-3C15 4.4 11.9 1.5 8 1.5z"/><circle cx="4.8" cy="7" r=".9"/><circle cx="7" cy="4.5" r=".9"/><circle cx="10.2" cy="5" r=".9"/>',
    brush: '<path d="M13.5 2.5l-6 6M9 10.5c0 2-1.5 3-4 3 0-2.5 1-4 3-4z"/>',
    lock: 'lock',
    font: '<path d="M2.5 13.5l4-11 4 11M4 9.5h5M11 13.5V8.5c0-1 .7-1.5 1.6-1.5s1.4.6 1.4 1.4v5.1"/>',
    start: '<rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9" y="2" width="5" height="5" rx="1"/><rect x="2" y="9" width="5" height="5" rx="1"/><rect x="9" y="9" width="5" height="5" rx="1"/>',
    bar: '<rect x="1.5" y="10.5" width="13" height="3.5" rx="1.2"/><path d="M5 12.2h1M8 12.2h1M11 12.2h1"/>',
    keyboard: '<rect x="1.5" y="4" width="13" height="8" rx="1.5"/><path d="M4 6.5h1M7 6.5h1M10 6.5h2M4 9.5h8"/>',
    light: '<path d="M8 1.5v2M3.4 3.4l1.4 1.4M1.5 8h2M12.6 3.4l-1.4 1.4M14.5 8h-2"/><circle cx="8" cy="9" r="3"/><path d="M6.5 13.5h3"/>',
    usage: '<rect x="1.5" y="3" width="13" height="8.5" rx="1.2"/><path d="M5.5 14h5M8 11.5V14"/>',
  };
  function preview(kit, src, alt) {
    const img = kit.h('img', { alt: alt || '' });
    Object.assign(img.style, { display: 'block', maxWidth: '100%', width: '320px', aspectRatio: '16 / 9', objectFit: 'cover', borderRadius: '8px', margin: '10px 14px' });
    img.hidden = !src;
    if (src) img.src = src;
    img.addEventListener('error', () => { img.hidden = true; });
    return img;
  }

  // ============================================================== Background
  const FITS = [['fill', 'Fill'], ['fit', 'Fit'], ['stretch', 'Stretch'], ['tile', 'Tile'], ['center', 'Centre'], ['span', 'Span']];
  const INTERVALS = [[60000, '1 minute'], [600000, '10 minutes'], [1800000, '30 minutes'], [3600000, '1 hour'], [21600000, '6 hours'], [86400000, '1 day']];
  function renderBackground(el, kit) {
    const R = (x) => 'personalization.background.' + x;
    const mwp = kit.status({ row: R('mantle'), label: 'Mantle\'s wallpaper', icon: SVG.picture, value: 'Reading…',
      help: 'What your desktop shows: Mantle plays it above Windows\' background' });
    const open = kit.button({ row: R('wallpapers'), label: 'Wallpapers', help: 'Browse, set, add and customise Mantle\'s wallpapers (videos, pictures, web wallpapers)', text: 'Open Wallpapers',
      onClick: () => (kit.test ? { ok: true, dryRun: true, reason: 'Test run, nothing changed: Mantle would open its Wallpapers window' }
        : kit.call('wallpaper.open').then((r) => (r && r.ok === false ? r : { ok: true }))) });
    const lively = kit.status({ row: R('lively'), label: 'Lively', value: 'Reading…', info: 'Mantle never closes or restarts Lively' });
    const kind = kit.choice({ row: R('kind'), label: 'Personalize your background', options: [{ value: 'picture', label: 'Picture' }, { value: 'solid', label: 'Solid colour' }, { value: 'slideshow', label: 'Slideshow' }],
      style: 'segmented', onChange: changeKind });
    const pic = kit.status({ row: R('picture'), label: 'Picture', value: '', mono: true });
    const img = preview(kit, null, 'Windows\' background picture');
    const recent = kit.list({ row: R('recent'), items: [], empty: 'Reading your recent pictures…', onAction: (k, a, it) => SET(kit, 'picture', it.path, read) });
    const path = kit.text({ row: R('path'), label: 'Use a picture from its path', help: 'The full path to a .jpg, .png, .bmp, .gif, .tif, .heic or .webp file', placeholder: 'C:\\Users\\you\\Pictures\\picture.jpg',
      onChange: (s) => (s ? SET(kit, 'picture', s.trim(), read) : { ok: true }) });
    const fit = kit.choice({ row: R('fit'), label: 'Choose a fit for your desktop image', style: 'dropdown', options: FITS.map(([value, label]) => ({ value, label })), onChange: (v) => SET(kit, 'fit', v, read) });
    const color = kit.text({ row: R('color'), label: 'Solid colour', help: 'A colour like #1F1F1F: Windows shows it instead of a picture', placeholder: '#1F1F1F',
      onChange: (s) => (s ? SET(kit, 'solid', s.trim().toUpperCase(), read) : { ok: true }) });
    const show = kit.folder({ row: R('slideshow'), label: 'Picture album for a slideshow', onChange: (p) => SET(kit, 'slideshow', p, read) });
    const every = kit.choice({ row: R('interval'), label: 'Change picture every', style: 'dropdown', options: INTERVALS.map(([value, label]) => ({ value, label })), onChange: (v) => SET(kit, 'interval', v, read) });
    const shuffle = kit.toggle({ row: R('shuffle'), label: 'Shuffle the picture order', onChange: (on) => SET(kit, 'shuffle', on, read) });
    const note = kit.h('div', {});
    el.append(kit.group('What you see'), kit.card(mwp, open, lively),
      kit.group('Windows\' background'), note, kit.card(kind, pic, img, fit),
      kit.group('Recent pictures', { row: R('recent') }), kit.card(recent, path),
      kit.group('Solid colour and slideshow'), kit.card(color, show, every, shuffle));
    const S = { b: null };
    function changeKind(v) {
      const b = S.b || {};
      if (v === 'solid') return SET(kit, 'solid', b.color || '#000000', read);
      if (v === 'picture') {
        const p = b.pictureExists ? b.picture : ((b.recent || []).find((x) => x.exists) || {}).path;
        return p ? SET(kit, 'picture', p, read) : { ok: false, reason: 'Pick a picture first: use one of your recent pictures or type a path below' };
      }
      const f = b.slideshow && b.slideshow.folder;
      return f ? SET(kit, 'slideshow', f, read) : { ok: false, reason: 'Pick a picture album first (below), then the slideshow starts' };
    }
    async function readMantle() {
      const w = await kit.call('wallpaper.list');
      if (!w || w.ok === false) return mwp.set({ value: '—', tone: 'warn', reason: 'Mantle\'s wallpaper could not be read: ' + ((w && w.reason) || 'no reason came back') });
      const sel = (w.items || []).find((x) => x.selected);
      const pb = w.playback || {};
      mwp.set({ value: sel ? sel.title + ' (' + (sel.typeLabel || sel.type) + ')' : 'None chosen', tone: sel && !(sel.health && sel.health.ok === false) ? 'ok' : 'warn',
        help: sel ? 'Mantle plays it above Windows\' background; ' + (w.items || []).length + ' in its library' : 'No Mantle wallpaper is chosen, so the desktop shows Windows\' background below',
        reason: sel && sel.health && sel.health.ok === false ? 'It cannot play: ' + sel.health.reason : null,
        info: pb.paused ? 'Paused now: ' + (pb.reason || 'no reason came back') : sel ? 'Windows\' background below shows only while Mantle is not running' : null });
      return null;
    }
    async function read() {
      readMantle();
      const b = await C(kit, 'background');
      if (!b || b.ok === false) {
        const why = bad(b, 'Windows\' background could not be read');
        [kind, pic, fit, color, show, every, shuffle, path].forEach((x) => x.set({ disabled: true, reason: why }));
        recent.set({ items: [], empty: why });
        return;
      }
      S.b = b;
      const lock = b.locked ? 'Read only here: ' + b.locked : null;
      const svc = b.serviceWhy ? 'Windows\' desktop wallpaper service did not answer (' + b.serviceWhy + '), so this cannot be changed now' : null;
      const off = lock || svc;
      note.replaceChildren(kit.reason('Mantle\'s wallpaper covers this whenever one is chosen and Mantle is running. Windows\' background shows when no Mantle wallpaper is chosen and whenever Mantle is not running; Windows also picks its automatic accent colour from it.', { info: true }));
      kind.set({ value: b.kind, disabled: !!lock, reason: lock || (b.kind === 'spotlight' ? 'Windows spotlight is on for the background: pick another kind here to replace it' : null) });
      pic.set({ value: b.picture ? base(b.picture) : 'None', help: b.picture || null, reason: b.picture && !b.pictureExists ? 'That picture file is gone, so Windows shows its last copy of it' : null });
      pic.el.hidden = b.kind !== 'picture';
      img.hidden = !(b.kind === 'picture' && b.pictureExists);
      if (b.kind === 'picture' && b.pictureExists) img.src = fileUrl(b.picture);
      fit.set({ value: b.fit || 'fill', disabled: !!off, reason: off || (b.fit ? null : 'Windows stores a fit Mantle does not know, so Fill is shown') });
      recent.set({ empty: 'Windows remembers no recent pictures', items: (b.recent || []).map((x) => ({ key: keyOf(x.path), path: x.path, label: base(x.path), help: x.path, mono: true, icon: SVG.picture,
        reason: x.exists ? null : 'This picture file is gone', value: b.picture && x.path.toLowerCase() === b.picture.toLowerCase() ? 'In use' : null,
        actions: [{ id: 'use', text: 'Use', disabled: !x.exists || !!off, reason: off || (x.exists ? null : 'the file is gone') }] })) });
      path.set({ disabled: !!off, reason: off });
      color.set({ value: b.color || '', disabled: !!off, reason: off, info: b.kind === 'solid' ? 'Windows shows this colour now' : null });
      const ss = b.slideshow || {};
      show.set({ value: ss.folder || '', disabled: !!off, reason: off, info: b.remoteOff ? 'Windows pauses slideshows in a remote session' : null });
      every.set({ value: ss.intervalMs || 1800000, disabled: !!off, reason: off, options: INTERVALS.some(([v]) => v === ss.intervalMs) || !ss.intervalMs ? INTERVALS.map(([value, label]) => ({ value, label }))
        : INTERVALS.map(([value, label]) => ({ value, label })).concat({ value: ss.intervalMs, label: Math.round(ss.intervalMs / 60000) + ' minutes' }) });
      shuffle.set({ value: !!ss.shuffle, disabled: !!off, reason: off });
      lively.set({ value: b.livelyRunning ? 'Running' : 'Not running', tone: b.livelyRunning ? 'warn' : null,
        help: b.livelyRunning ? 'Lively draws its own wallpaper window too; Mantle leaves it alone' : 'Mantle imported your Lively library and plays it itself' });
    }
    return read().then(() => ({ update: read, dispose() {} }));
  }

  // ============================================================== Colors
  function renderColors(el, kit) {
    const R = (x) => 'personalization.colors.' + x;
    const LD = [{ value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }];
    const mode = kit.choice({ row: R('mode'), label: 'Choose your mode', help: 'Light or dark for Windows and your apps together', style: 'segmented',
      options: LD.concat({ value: 'custom', label: 'Custom' }), onChange: setMode });
    const win = kit.choice({ row: R('windows-mode'), label: 'Choose your default Windows mode', style: 'segmented', options: LD, onChange: (v) => SET(kit, 'systemLight', v === 'light', read) });
    const apps = kit.choice({ row: R('apps-mode'), label: 'Choose your default app mode', style: 'segmented', options: LD, onChange: (v) => SET(kit, 'appsLight', v === 'light', read) });
    const tr = kit.toggle({ row: R('transparency'), label: 'Transparency effects', help: 'Windows and surfaces appear translucent', onChange: (on) => SET(kit, 'transparency', on, read) });
    const auto = kit.toggle({ row: R('auto-accent'), label: 'Accent colour: automatic', help: 'Windows picks the accent from its background picture',
      info: 'Windows looks at its OWN background, not Mantle\'s wallpaper', onChange: (on) => SET(kit, 'autoAccent', on, read) });
    const acc = kit.status({ row: R('accent'), label: 'Accent colour', value: 'Reading…' });
    const grid = kit.h('div', { role: 'group', 'aria-label': 'Windows accent colours' });
    Object.assign(grid.style, { display: 'grid', gridTemplateColumns: 'repeat(8, 28px)', gap: '8px', padding: '4px 14px 14px' });
    const custom = kit.text({ row: R('custom'), label: 'Custom colour', help: 'Any colour like #0078D4', placeholder: '#0078D4',
      onChange: (s) => (s ? pickAccent(s.trim().toUpperCase()) : { ok: true }) });
    const onStart = kit.toggle({ row: R('accent-start'), label: 'Show accent colour on Start and taskbar', info: 'Mantle replaces Start and the taskbar, so this colours only Windows\' own, hidden ones',
      onChange: (on) => SET(kit, 'accentOnStart', on, read) });
    const onTitle = kit.toggle({ row: R('accent-titlebars'), label: 'Show accent colour on title bars and window borders', onChange: (on) => SET(kit, 'accentOnTitleBars', on, read) });
    el.append(kit.reason(ONE_THEME, { info: true }), kit.group('Mode'), kit.card(mode, win, apps, tr),
      kit.group('Accent colour'), kit.card(auto, acc, grid, custom, onStart, onTitle));
    const S = { r: null, lock: null };
    function pickAccent(hex) {
      return C(kit, 'set', { key: 'accent', value: hex }).then((r) => {
        if (r.ok && !r.dryRun) setTimeout(read, 300);
        acc.set({ reason: r.ok === false ? r.reason : null, info: r.dryRun ? r.reason : null });
        return r;
      });
    }
    async function setMode(v) {
      if (v === 'custom') return { ok: true, value: v };
      const on = v === 'light';
      const a = await C(kit, 'set', { key: 'systemLight', value: on });
      if (a.ok === false || a.dryRun) return a;
      const b = await C(kit, 'set', { key: 'appsLight', value: on });
      setTimeout(read, 300);
      return b.ok === false ? b : { ok: true, value: v };
    }
    function drawGrid(list, cur, off) {
      grid.replaceChildren(...list.map((hex) => {
        const b = kit.h('button', { type: 'button', title: hex, 'aria-label': 'Accent ' + hex, 'aria-pressed': hex === cur ? 'true' : 'false', 'data-hex': hex });
        Object.assign(b.style, { width: '28px', height: '28px', borderRadius: '6px', border: '0', padding: '0', cursor: off ? 'default' : 'pointer', background: hex,
          outline: hex === cur ? '2px solid var(--lg-text, currentColor)' : 'none', outlineOffset: '2px', opacity: off ? '.45' : '1' });
        b.disabled = !!off;
        b.addEventListener('click', () => pickAccent(hex));
        return b;
      }));
    }
    async function read() {
      const r = await C(kit, 'colors');
      if (!r || r.ok === false) {
        const why = bad(r, 'Windows\' colours could not be read');
        [mode, win, apps, tr, auto, acc, custom, onStart, onTitle].forEach((x) => x.set({ disabled: true, reason: why }));
        return drawGrid([], null, true);
      }
      S.r = r;
      const v = r.values || {};
      const lock = r.locked ? 'Read only here: ' + r.locked : null;
      const L = (k) => (v[k] ? v[k].on : null);
      const sys = L('systemLight'), app = L('appsLight');
      mode.set({ value: sys === app ? (sys ? 'light' : 'dark') : 'custom', disabled: !!lock, reason: lock });
      win.set({ value: sys ? 'light' : 'dark', disabled: !!lock, reason: lock });
      apps.set({ value: app ? 'light' : 'dark', disabled: !!lock, reason: lock });
      tr.set({ value: !!L('transparency'), disabled: !!lock, reason: lock });
      auto.set({ value: !!L('autoAccent'), disabled: !!lock, reason: lock });
      const autoOn = !!L('autoAccent');
      acc.set({ value: r.accent || 'Windows\' default', reason: lock || (r.accent ? null : r.accentWhy),
        help: autoOn ? 'Automatic: Windows picked it from its background; choosing one below turns automatic off' : 'Pick one of Windows\' colours or type your own' });
      drawGrid(r.swatches || [], r.accent, lock);
      custom.set({ disabled: !!lock, reason: lock });
      onStart.set({ value: !!L('accentOnStart'), disabled: !!lock, reason: lock });
      onTitle.set({ value: !!L('accentOnTitleBars'), disabled: !!lock, reason: lock });
    }
    return read().then(() => ({ update: read, dispose() {} }));
  }

  // ============================================================== Themes, Lock screen, Text input, Lighting, Device usage
  function moreReader(kit, fn) {
    const read = async () => {
      const r = await C(kit, 'more');
      if (!r || r.ok === false) return fn(null, bad(r, 'These settings could not be read'));
      return fn(r, null);
    };
    return { read };
  }
  function renderThemes(el, kit) {
    const cur = kit.status({ row: 'personalization.themes.current', label: 'Current theme', value: 'Reading…' });
    const list = kit.list({ row: 'personalization.themes.list', items: [], empty: 'Reading your themes…' });
    const note = kit.h('div', {});
    el.append(kit.group('Themes'), kit.card(cur), kit.group('Installed themes', { row: 'personalization.themes.list' }), note, kit.card(list));
    const M = moreReader(kit, (r, why) => {
      if (!r) { cur.set({ value: '—', reason: why }); return list.set({ items: [], empty: why }); }
      const th = r.themes || {};
      const now = (th.list || []).find((x) => x.current);
      cur.set({ value: now ? now.name : th.current ? base(th.current) : 'Not reported', help: th.current || null, mono: !!th.current, reason: th.why || null });
      note.replaceChildren(kit.reason('Read only here: ' + th.applyWhy, { info: true }));
      list.set({ empty: 'No theme files were found', items: (th.list || []).map((x) => ({ key: keyOf(x.file), label: x.name, help: (x.scope === 'user' ? 'Yours · ' : 'Windows · ') + base(x.file),
        icon: SVG.brush, value: x.current ? 'In use' : null })) });
    });
    return M.read().then(() => ({ update: M.read, dispose() {} }));
  }
  function renderLock(el, kit) {
    const R = (x) => 'personalization.lock.' + x;
    const pic = kit.status({ row: R('picture'), label: 'Lock screen picture', value: 'Reading…', mono: true });
    const img = preview(kit, null, 'Lock screen picture');
    const path = kit.text({ row: R('path'), label: 'Use a picture from its path', help: 'The full path to a .jpg, .png or .bmp file', placeholder: 'C:\\Users\\you\\Pictures\\lock.jpg',
      onChange: (s) => (s ? C(kit, 'lockPicture', { path: s.trim() }).then(later(kit, read)) : { ok: true }) });
    const spot = kit.toggle({ row: R('spotlight'), label: 'Windows spotlight', help: 'A new picture from Bing on the lock screen every day', onChange: (on) => SET(kit, 'spotlight', on, read) });
    const facts = kit.toggle({ row: R('facts'), label: 'Get fun facts, tips, tricks and more on your lock screen', onChange: (on) => SET(kit, 'lockFacts', on, read) });
    const status = kit.status({ row: R('status'), label: 'Lock screen status', value: 'Windows\' choice' });
    const signin = kit.status({ row: R('signin'), label: 'Show the lock screen background picture on the sign-in screen', value: '—' });
    el.append(kit.group('Lock screen'), kit.card(pic, img, path, spot, facts), kit.group('Status and sign-in'), kit.card(status, signin));
    async function read() {
      const [l, m] = await Promise.all([C(kit, 'lock'), C(kit, 'more')]);
      if (!l || l.ok === false) { pic.set({ value: '—', reason: bad(l, 'The lock screen picture could not be read') }); path.set({ disabled: true, reason: bad(l, 'The lock screen picture could not be read') }); }
      else {
        pic.set({ value: l.picture ? base(l.picture) : 'Not reported', help: l.picture || null, reason: l.pictureWhy || null });
        img.hidden = !(l.picture && l.pictureExists);
        if (l.picture && l.pictureExists) img.src = fileUrl(l.picture);
        path.set({ disabled: !l.canSet, reason: l.canSet ? null : 'Read only here: ' + l.pictureWhy, info: l.canSet ? 'Picking a picture turns Windows spotlight off, as it does in Windows\' Settings' : null });
      }
      if (!m || m.ok === false) { const why = bad(m, 'These settings could not be read'); [spot, facts, status, signin].forEach((x) => x.set({ disabled: true, reason: why })); return; }
      const k = m.lock || {};
      spot.set({ value: !!(k.spotlight && k.spotlight.on), info: k.spotlight && !k.spotlight.set ? 'Not set yet: Windows\' default applies' : null });
      facts.set({ value: !!(k.facts && k.facts.on) });
      status.set({ info: 'Read only here: ' + k.statusWhy });
      signin.set({ value: k.signin && k.signin.policyOff ? 'Off (policy)' : 'Windows\' choice', info: 'Read only here: ' + ((k.signin && k.signin.why) || 'no reason came back') });
    }
    return read().then(() => ({ update: read, dispose() {} }));
  }
  function renderTextInput(el, kit) {
    const theme = kit.status({ row: 'personalization.text-input.theme', label: 'Touch keyboard theme', value: 'Reading…' });
    const size = kit.status({ row: 'personalization.text-input.size', label: 'Keyboard size', value: 'Reading…' });
    const keyBg = kit.status({ row: 'personalization.text-input.key-background', label: 'Key background', value: 'Reading…' });
    el.append(kit.group('Touch keyboard'), kit.card(theme, size, keyBg));
    const M = moreReader(kit, (r, why) => {
      if (!r) return [theme, size, keyBg].forEach((x) => x.set({ value: '—', reason: why }));
      const t = r.touchKeyboard || {}, v = t.values || {};
      const w = (x) => (x == null ? 'Windows\' default' : String(x));
      theme.set({ value: v.SelectedThemeName || (v.SelectedThemeIndex != null ? 'Theme ' + v.SelectedThemeIndex : 'Windows\' default'), info: 'Read only here: ' + t.why });
      size.set({ value: w(v.KeyboardSizeSetting), info: 'Read only here: ' + t.why });
      keyBg.set({ value: v.IsKeyBackgroundEnabled == null ? 'Windows\' default' : v.IsKeyBackgroundEnabled ? 'On' : 'Off', info: 'Read only here: ' + t.why });
    });
    return M.read().then(() => ({ update: M.read, dispose() {} }));
  }
  function renderLighting(el, kit) {
    const R = (x) => 'personalization.lighting.' + x;
    const on = kit.status({ row: R('state'), label: 'Use Dynamic Lighting on my devices', value: 'Reading…' });
    const fg = kit.status({ row: R('apps'), label: 'Compatible apps in the foreground always control lighting', value: '—' });
    const br = kit.status({ row: R('brightness'), label: 'Brightness', value: '—' });
    const ac = kit.status({ row: R('accent'), label: 'Match my Windows accent colour', value: '—' });
    el.append(kit.group('Dynamic Lighting'), kit.card(on, fg, br, ac));
    const M = moreReader(kit, (r, why) => {
      if (!r) return [on, fg, br, ac].forEach((x) => x.set({ value: '—', reason: why }));
      const L = r.lighting || {}, v = L.values || {};
      const yn = (x) => (x == null ? 'Not set' : x ? 'On' : 'Off');
      on.set({ value: L.present ? yn(v.AmbientLightingEnabled) : 'Never set up', info: 'Read only here: ' + L.why });
      fg.set({ value: yn(v.ControlledByForegroundApp) });
      br.set({ value: v.Brightness == null ? 'Not set' : v.Brightness + '%' });
      ac.set({ value: yn(v.UseSystemAccentColor) });
    });
    return M.read().then(() => ({ update: M.read, dispose() {} }));
  }
  const USES = [['gaming', 'Gaming'], ['family', 'Family'], ['creative', 'Creativity'], ['schoolwork', 'School'], ['entertainment', 'Entertainment'], ['business', 'Business'], ['developer', 'Development']];
  function renderUsage(el, kit) {
    const note = kit.h('div', {});
    const list = kit.list({ row: 'personalization.usage.list', items: [], empty: 'Reading…' });
    el.append(kit.group('Device usage', { row: 'personalization.usage.list' }), note, kit.card(list));
    const M = moreReader(kit, (r, why) => {
      if (!r) return list.set({ items: [], empty: why });
      note.replaceChildren(kit.reason('Read only here: ' + r.usageWhy, { info: true }));
      const u = r.usage || {};
      list.set({ items: USES.map(([k, label]) => ({ key: k, label, icon: SVG.usage, value: u[k] ? (u[k].on ? 'On' : 'Off') : 'Not reported', help: u[k] && !u[k].set ? 'Not set' : null })) });
    });
    return M.read().then(() => ({ update: M.read, dispose() {} }));
  }

  // ============================================================== Start and Taskbar: Mantle's own
  const MANTLE_PARTS = {
    start: { what: 'Start', feats: ['search', 'jumplist', 'layouts', 'notes'],
      says: 'Mantle replaces Start: the Windows key opens Mantle\'s launcher and Win+S its search. Windows\' Start options (layout, recommended, pinned folders) do nothing while Mantle runs, so its own are listed here.' },
    taskbar: { what: 'Taskbar', feats: ['topbar', 'jumplist', 'downloads', 'timer', 'taskview', 'corners', 'osd'],
      says: 'Mantle replaces the taskbar: its bar and top bar are what you see, and Windows\' taskbar is hidden. Windows\' taskbar options (alignment, widgets, search box) do nothing while Mantle runs, so Mantle\'s own are listed here.' },
  };
  function mantlePage(which) {
    return function (el, kit) {
      const P = MANTLE_PARTS[which];
      const R = (x) => 'personalization.' + which + '.' + x;
      const head = kit.status({ row: R('mantle'), label: 'Mantle\'s ' + P.what.toLowerCase(), icon: 'mantle', value: 'Reading…', help: P.says });
      const list = kit.list({ row: R('features'), items: [], empty: 'Reading Mantle\'s features…', onAction: (key, act, it) => { kit.open({ section: 'mantle', row: it.row }); return { ok: true }; } });
      const all = kit.button({ row: R('open'), label: 'Every Mantle option', help: 'Switches, shortcuts and each feature\'s options', text: 'Open Mantle settings', onClick: () => { kit.open({ section: 'mantle' }); return { ok: true }; } });
      el.append(kit.group(P.what), kit.card(head), kit.group('Mantle features that make up the ' + P.what.toLowerCase(), { row: R('features') }), kit.card(list, all));
      async function read() {
        const m = await kit.call('settings.mantle');
        if (!m || m.ok === false || !Array.isArray(m.features)) {
          const why = 'Mantle\'s features could not be read: ' + ((m && m.reason) || 'no reason came back');
          head.set({ value: '—', reason: why });
          return list.set({ items: [], empty: why });
        }
        const fs = P.feats.map((n) => m.features.find((f) => f.name === n)).filter(Boolean);
        const on = fs.filter((f) => f.enabled).length;
        head.set({ value: 'In use · ' + on + ' of ' + fs.length + ' on', tone: 'ok', reason: null });
        list.set({ empty: 'None of these features is in this Mantle build', items: fs.map((f) => ({ key: f.name, row: 'mantle.feature.' + f.name, label: f.label || f.name, icon: 'mantle',
          value: f.enabled ? (f.running === false ? 'On, not running' : 'On') : 'Off', reason: f.enabled && f.running === false && f.reason ? f.reason : null,
          help: (Array.isArray(f.options) && f.options.length ? f.options.length + ' option' + (f.options.length === 1 ? '' : 's') + ' in Mantle settings' : 'Switch it in Mantle settings'),
          actions: [{ id: 'open', text: 'Open in Mantle' }] })) });
      }
      return read().then(() => ({ update: read, dispose() {} }));
    };
  }

  // ============================================================== Fonts
  function renderFonts(el, kit) {
    const R = (x) => 'personalization.fonts.' + x;
    const S = { r: null, q: '', sample: 'The quick brown fox jumps over the lazy dog', busy: false };
    const count = kit.status({ row: R('count'), label: 'Available fonts', value: 'Reading…' });
    const find = kit.text({ row: R('filter'), label: 'Search fonts', placeholder: 'Type a font name', onChange: (s) => { S.q = (s || '').trim().toLowerCase(); draw(); return { ok: true }; } });
    const sample = kit.text({ row: R('sample'), label: 'Preview text', value: S.sample, onChange: (s) => { S.sample = s || S.sample; draw(); return { ok: true }; } });
    const install = kit.text({ row: R('install'), label: 'Install a font for you', help: 'The full path to a .ttf, .otf or .ttc file: it is added for you only, no administrator needed',
      placeholder: 'C:\\Users\\you\\Downloads\\font.ttf', onChange: (s) => (s ? C(kit, 'fontInstall', { path: s.trim() }).then(later(kit, read)) : { ok: true }) });
    const note = kit.h('div', {});
    const list = kit.list({ row: R('list'), items: [], empty: 'Reading the installed fonts…', onAction: remove });
    el.append(kit.group('Add fonts'), kit.card(install), kit.group('Available fonts', { row: R('list') }), note, kit.card(count, find, sample, list));
    const LIMIT = 60;
    async function remove(key, act, it) {
      let last = { ok: true };
      for (const f of it.userFaces) {
        last = await C(kit, 'fontRemove', { face: f });
        if (last.ok === false || last.dryRun) return last;
      }
      setTimeout(read, 300);
      return last;
    }
    function draw() {
      const r = S.r;
      if (!r) return;
      const all = r.families || [];
      const hit = S.q ? all.filter((f) => f.name.toLowerCase().includes(S.q)) : all;
      const shown = hit.slice(0, LIMIT);
      count.set({ value: all.length + ' families · ' + r.faces + ' faces', help: r.userFaces ? r.userFaces + ' installed by you' : 'All installed for everyone', reason: r.why || null });
      note.replaceChildren(kit.reason('Read only here: ' + r.systemWhy + '. Fonts you installed yourself can be removed.', { info: true }),
        hit.length > LIMIT ? kit.reason('Showing ' + LIMIT + ' of ' + hit.length + ': type in Search fonts to find the rest', { info: true }) : '');
      list.set({ empty: S.q ? 'No font matches "' + S.q + '"' : 'No fonts were found',
        items: shown.map((f) => {
          const mine = f.faces.filter((x) => x.scope === 'user').map((x) => x.face);
          return { key: keyOf(f.name), family: f.name, label: f.name, help: S.sample, userFaces: mine, icon: SVG.font,
            value: f.faces.length + ' face' + (f.faces.length === 1 ? '' : 's') + (f.scope === 'system' ? '' : f.scope === 'user' ? ' · yours' : ' · some yours'),
            actions: mine.length ? [{ id: 'remove', text: 'Remove' }] : [] };
        }) });
      // each family's sample in its own face (a system font by name: the CSP's font-src does not apply)
      list.el.querySelectorAll('[data-row^="' + R('list') + '."]').forEach((row) => {
        const it = shown.find((f) => R('list') + '.' + keyOf(f.name) === row.getAttribute('data-row'));
        const h = row.querySelector('.row-h');
        if (it && h) { h.style.fontFamily = '"' + it.name.replace(/"/g, '') + '", var(--lg-font, sans-serif)'; h.style.fontSize = '15px'; }
      });
    }
    async function read() {
      const r = await C(kit, 'fonts');
      if (!r || r.ok === false) {
        const why = bad(r, 'The installed fonts could not be read');
        count.set({ value: '—', reason: why });
        return list.set({ items: [], empty: why });
      }
      S.r = r;
      draw();
    }
    return read().then(() => ({ update: read, dispose() {} }));
  }

  // ============================================================== the section
  const pages = [
    { id: 'background', title: 'Background', icon: SVG.picture, help: 'Mantle\'s wallpaper, and Windows\' picture, colour or slideshow below it',
      search: [
        { row: 'personalization.background.mantle', label: 'Mantle\'s wallpaper', keywords: 'wallpaper desktop video live lively background', uri: 'ms-settings:personalization' },
        { row: 'personalization.background.wallpapers', label: 'Wallpapers', keywords: 'wallpaper library video add change lively' },
        { row: 'personalization.background.lively', label: 'Lively', keywords: 'lively wallpaper running' },
        { row: 'personalization.background.kind', label: 'Personalize your background', keywords: 'background picture solid colour color slideshow wallpaper', uri: 'ms-settings:personalization-background' },
        { row: 'personalization.background.fit', label: 'Choose a fit for your desktop image', keywords: 'fill fit stretch tile center centre span' },
        { row: 'personalization.background.recent', label: 'Recent pictures', keywords: 'recent images history background picture' },
        { row: 'personalization.background.path', label: 'Use a picture from its path', keywords: 'browse picture file background' },
        { row: 'personalization.background.color', label: 'Solid colour', keywords: 'solid color colour background plain' },
        { row: 'personalization.background.slideshow', label: 'Picture album for a slideshow', keywords: 'slideshow album folder rotate' },
        { row: 'personalization.background.interval', label: 'Change picture every', keywords: 'slideshow interval minutes' },
        { row: 'personalization.background.shuffle', label: 'Shuffle the picture order', keywords: 'slideshow shuffle random' },
      ], render: renderBackground },
    { id: 'colors', title: 'Colors', icon: SVG.palette, help: 'Light and dark mode, accent colour, transparency',
      search: [
        { row: 'personalization.colors.mode', label: 'Choose your mode', keywords: 'dark mode light mode theme night', uri: 'ms-settings:colors' },
        { row: 'personalization.colors.windows-mode', label: 'Choose your default Windows mode', keywords: 'dark light windows mode' },
        { row: 'personalization.colors.apps-mode', label: 'Choose your default app mode', keywords: 'dark light app mode' },
        { row: 'personalization.colors.transparency', label: 'Transparency effects', keywords: 'transparent translucent acrylic mica' },
        { row: 'personalization.colors.auto-accent', label: 'Accent colour: automatic', keywords: 'automatic accent color colour' },
        { row: 'personalization.colors.accent', label: 'Accent colour', keywords: 'accent color colour highlight' },
        { row: 'personalization.colors.custom', label: 'Custom colour', keywords: 'custom accent color colour hex' },
        { row: 'personalization.colors.accent-start', label: 'Show accent colour on Start and taskbar', keywords: 'accent start taskbar' },
        { row: 'personalization.colors.accent-titlebars', label: 'Show accent colour on title bars and window borders', keywords: 'accent title bar window border' },
      ], render: renderColors },
    { id: 'themes', title: 'Themes', icon: SVG.brush, help: 'Your themes and Windows\' own',
      search: [{ row: 'personalization.themes.current', label: 'Current theme', keywords: 'theme current', uri: 'ms-settings:themes' },
        { row: 'personalization.themes.list', label: 'Installed themes', keywords: 'themes installed apply' }], render: renderThemes },
    { id: 'lock-screen', title: 'Lock screen', icon: 'lock', help: 'Lock screen picture, spotlight, status, sign-in',
      search: [
        { row: 'personalization.lock.picture', label: 'Lock screen picture', keywords: 'lock screen picture image', uri: 'ms-settings:lockscreen' },
        { row: 'personalization.lock.path', label: 'Lock screen picture from its path', keywords: 'lock screen browse picture' },
        { row: 'personalization.lock.spotlight', label: 'Windows spotlight', keywords: 'spotlight bing lock screen daily picture' },
        { row: 'personalization.lock.facts', label: 'Fun facts, tips and tricks on the lock screen', keywords: 'fun facts tips lock screen' },
        { row: 'personalization.lock.status', label: 'Lock screen status', keywords: 'lock screen status app weather' },
        { row: 'personalization.lock.signin', label: 'Lock screen picture on the sign-in screen', keywords: 'sign in login background' },
      ], render: renderLock },
    { id: 'text-input', title: 'Text input', icon: SVG.keyboard, help: 'Touch keyboard theme and size',
      search: [{ row: 'personalization.text-input.theme', label: 'Touch keyboard theme', keywords: 'touch keyboard theme text input', uri: 'ms-settings:personalization-textinput' },
        { row: 'personalization.text-input.size', label: 'Keyboard size', keywords: 'touch keyboard size' },
        { row: 'personalization.text-input.key-background', label: 'Key background', keywords: 'touch keyboard key background' }], render: renderTextInput },
    { id: 'dynamic-lighting', title: 'Dynamic Lighting', icon: SVG.light, help: 'RGB lighting on your devices',
      search: [{ row: 'personalization.lighting.state', label: 'Use Dynamic Lighting on my devices', keywords: 'rgb lighting leds dynamic lighting', uri: 'ms-settings:personalization-lighting' },
        { row: 'personalization.lighting.apps', label: 'Apps control lighting', keywords: 'lighting foreground apps' },
        { row: 'personalization.lighting.brightness', label: 'Lighting brightness', keywords: 'lighting brightness rgb' },
        { row: 'personalization.lighting.accent', label: 'Match my Windows accent colour', keywords: 'lighting accent colour' }], render: renderLighting },
    { id: 'start', title: 'Start', icon: SVG.start, help: 'Mantle replaces Start: its launcher and search',
      search: [{ row: 'personalization.start.mantle', label: 'Start (Mantle\'s launcher)', keywords: 'start menu launcher recommended layout pins', uri: 'ms-settings:personalization-start' },
        { row: 'personalization.start.features', label: 'Start: Mantle features', keywords: 'start launcher search jump lists' },
        { row: 'personalization.start.open', label: 'Every Mantle option', keywords: 'mantle settings options' }], render: mantlePage('start') },
    { id: 'taskbar', title: 'Taskbar', icon: SVG.bar, help: 'Mantle replaces the taskbar: its bar and top bar',
      search: [{ row: 'personalization.taskbar.mantle', label: 'Taskbar (Mantle\'s bar)', keywords: 'taskbar alignment system tray icons bar', uri: 'ms-settings:taskbar' },
        { row: 'personalization.taskbar.features', label: 'Taskbar: Mantle features', keywords: 'taskbar top bar jump lists downloads timer hot corners' },
        { row: 'personalization.taskbar.open', label: 'Every Mantle option', keywords: 'mantle settings options' }], render: mantlePage('taskbar') },
    { id: 'fonts', title: 'Fonts', icon: SVG.font, help: 'Installed fonts with a preview; add and remove yours',
      search: [{ row: 'personalization.fonts.list', label: 'Available fonts', keywords: 'font typeface installed', uri: 'ms-settings:fonts' },
        { row: 'personalization.fonts.install', label: 'Install a font', keywords: 'add install font ttf otf' },
        { row: 'personalization.fonts.filter', label: 'Search fonts', keywords: 'find font' },
        { row: 'personalization.fonts.sample', label: 'Font preview text', keywords: 'preview sample font' },
        { row: 'personalization.fonts.count', label: 'Font count', keywords: 'how many fonts' }], render: renderFonts },
    { id: 'device-usage', title: 'Device usage', icon: SVG.usage, help: 'What you use this PC for',
      search: [{ row: 'personalization.usage.list', label: 'Device usage', keywords: 'device usage gaming family school business development', uri: 'ms-settings:deviceusage' }], render: renderUsage },
  ];

  MantleSettings.section({
    id: 'personalization',
    title: 'Personalization',
    group: 'windows',
    icon: SVG.palette,
    order: 40,
    help: 'Background, colours, lock screen, fonts',
    keywords: 'personalize personalization appearance look wallpaper theme dark mode',
    pages,
  });
})();

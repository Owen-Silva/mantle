/* gaming.js — Settings > Gaming, done natively (lane gameupd, 2026-09-29).
 *
 * Windows' three Gaming pages, reading and changing the same per-user values Windows' own Settings
 * does, through settings.gaming.* (lib/features/_settings-sections/gaming.js -> sidecar/SysGaming.cs):
 *   Xbox Game Bar   the controller's Xbox button, and whether the Game Bar app is on this PC
 *   Captures        where captures go (read-only, with why), background recording (it COSTS FRAMES on
 *                   the user's integrated graphics: the row says so), audio and video options
 *   Game Mode       Windows' own Game Mode, and next to it MANTLE's game mode (lib/features/gamemode.js),
 *                   each explained in one line, read with the Mantle section's own commands
 *                   (gamemode.state, settings.mantle) and changed with them (settings.enable,
 *                   settings.option): this page never edits the game mode files.
 * A capture policy (AllowGameDVR = 0) makes every capture row read-only with the policy named.
 * Kit only (ui/settings/SECTIONS.md): no CSS of its own. Nothing links out to ms-settings.
 */
(function () {
  'use strict';
  const C = (kit, name, args) => kit.call('settings.gaming.' + name, args || {});
  const bad = (r, what) => (r && r.ok === false ? what + ': ' + (r.reason || 'no reason came back') : null);
  const FPS = 'background recording keeps the graphics chip encoding the last seconds of every game, which costs frames on this PC\'s integrated graphics';
  const WINDOWS_LINE = 'Windows\' own: the game gets first call on the processor and graphics, and Windows Update holds driver installs and restart notices while you play';
  const MANTLE_LINE = 'Mantle\'s own, on top of Windows\': best power mode, your other apps slowed, Spotify closed if it is not playing, and Mantle rests with the bar out of the way while a known game runs';
  const FOLDER_WHY = 'Read only here: Windows keeps captures in the Captures folder inside your Videos folder, and it moves only when the Videos folder moves';

  const SVG = {
    pad: '<path d="M4.5 5h7a3 3 0 0 1 2.9 3.8l-.8 2.9a1.6 1.6 0 0 1-2.8.5L9.6 10H6.4l-1.2 2.2a1.6 1.6 0 0 1-2.8-.5l-.8-2.9A3 3 0 0 1 4.5 5z"/><path d="M5 7v2M4 8h2"/>',
    rec: '<circle cx="8" cy="8" r="6"/><circle cx="8" cy="8" r="2.4"/>',
  };

  // One page's rows: [key, row, kind ('toggle' | 'choice'), label, help, style?]. The values come from
  // settings.gaming.get {values: {key: {on | value, options, set, locked, why}}}.
  function reader(kit) {
    const S = { r: null, why: null, subs: [] };
    async function read() {
      const r = await C(kit, 'get');
      S.r = r && r.ok !== false ? r : null;
      S.why = bad(r, 'Game settings could not be read');
      S.subs.forEach((f) => f(S.r, S.why));
    }
    return { read, on: (f) => S.subs.push(f), get r() { return S.r; } };
  }
  function rowsOf(kit, list, R, gate) {
    const ctl = {};
    for (const [key, row, kind, label, help, style] of list) {
      const change = (v) => C(kit, 'set', { key, value: v }).then((r) => { if (r.ok && !r.dryRun) setTimeout(R.read, 300); return r; });
      ctl[key] = kind === 'toggle' ? kit.toggle({ row, label, help, onChange: change })
        : kit.choice({ row, label, help, style: style || 'dropdown', options: [], value: null, onChange: change });
    }
    R.on((r, why) => {
      for (const [key, , kind] of list) {
        const t = ctl[key];
        if (!r) { t.set({ disabled: true, reason: why }); continue; }
        const v = (r.values || {})[key];
        if (!v) { t.set({ disabled: true, reason: 'Windows did not report this setting' }); continue; }
        const lock = v.locked ? 'Read only here: ' + v.locked : null;
        const g = !lock && gate ? gate(key, r.values) : null;
        const patch = { disabled: !!(lock || g), reason: lock || null, info: g || null };
        if (kind === 'toggle') {
          patch.value = v.on === true;
          if (!lock && !g && !v.set) patch.info = 'Not set yet: Windows treats it as ' + (v.on ? 'on' : 'off');
        } else {
          patch.value = v.value;
          patch.options = v.value === 'custom' ? v.options.concat([{ value: 'custom', label: 'Custom (set by another program)' }]) : v.options;
          if (!lock && v.value === 'custom') patch.info = 'Custom: ' + (v.why || 'not one of Windows\' choices');
        }
        if (extraFor[key]) Object.assign(patch, extraFor[key](v, r, patch));
        t.set(patch);
      }
    });
    return ctl;
  }
  // Background recording says what it costs, on or off.
  const extraFor = {
    background: (v, r, p) => (p.reason ? {} : v.on ? { reason: 'On: ' + (r.fpsCost || FPS) + '. Turn it off unless you want to save clips after they happen' }
      : { info: 'Off, which is best for your frame rate: ' + (r.fpsCost || FPS) }),
  };

  // ============================================================== Xbox Game Bar
  function renderGameBar(el, kit) {
    const R = reader(kit);
    const rows = rowsOf(kit, [['controller', 'gaming.game-bar.controller', 'toggle', 'Open Xbox Game Bar using this button on a controller',
      'The Xbox button on a controller opens Game Bar over your game']], R);
    const app = kit.status({ row: 'gaming.game-bar.app', label: 'Xbox Game Bar app', help: 'Windows\' own overlay for captures, audio and performance widgets (Win+G)', value: 'Reading…' });
    el.append(kit.group('Xbox Game Bar'), kit.card(rows.controller, app));
    R.on((r, why) => {
      if (!r) return app.set({ value: '—', reason: why });
      app.set({ value: r.gameBar ? 'Installed' : 'Not installed', tone: r.gameBar ? 'ok' : 'warn',
        reason: r.gameBar ? null : 'The Xbox Game Bar app is not on this PC, so Win+G and the controller button do nothing until it is installed from the Microsoft Store' });
    });
    return R.read().then(() => ({ update: R.read, dispose() {} }));
  }

  // ============================================================== Captures
  const BG_OFF = 'Read only while "Record what happened" is off, as in Windows';
  const AUDIO_OFF = 'Read only while "Capture audio when recording a game" is off, as in Windows';
  function renderCaptures(el, kit) {
    const R = reader(kit);
    const top = kit.h('div', {});
    const folder = kit.status({ row: 'gaming.captures.folder', label: 'Captures location', help: 'Reading…', mono: true, value: '', info: FOLDER_WHY });
    const gate = (key, v) => (['battery', 'wireless', 'buffer'].includes(key) && v.background && !v.background.on ? BG_OFF
      : ['mic', 'audioQuality'].includes(key) && v.audio && !v.audio.on ? AUDIO_OFF : null);
    const rec = rowsOf(kit, [
      ['background', 'gaming.captures.background', 'toggle', 'Record what happened', 'Keeps the last seconds of a game so you can save them after they happen (Win+Alt+G)'],
      ['battery', 'gaming.captures.battery', 'toggle', 'Record while on battery power', 'Background recording also runs when the laptop is unplugged'],
      ['wireless', 'gaming.captures.wireless', 'toggle', 'Record while wirelessly projecting my screen', 'Background recording also runs while this screen is cast to another display'],
      ['buffer', 'gaming.captures.buffer', 'choice', 'Record the last', 'How much background recording keeps'],
      ['maxLength', 'gaming.captures.max-length', 'choice', 'Max recording length', 'A recording you start stops by itself after this long'],
    ], R, gate);
    const au = rowsOf(kit, [
      ['audio', 'gaming.captures.audio', 'toggle', 'Capture audio when recording a game', 'The game\'s sound goes into the recording'],
      ['mic', 'gaming.captures.mic', 'toggle', 'Turn on my microphone by default when I record', 'Your voice goes into the recording too'],
      ['audioQuality', 'gaming.captures.audio-quality', 'choice', 'Audio quality', 'Higher quality makes bigger files', 'segmented'],
    ], R, gate);
    const vi = rowsOf(kit, [
      ['frameRate', 'gaming.captures.frame-rate', 'choice', 'Video frame rate', '60 fps looks smoother and costs more while recording', 'segmented'],
      ['quality', 'gaming.captures.quality', 'choice', 'Video quality', 'High makes bigger files and costs more while recording', 'segmented'],
      ['cursor', 'gaming.captures.cursor', 'toggle', 'Capture mouse cursor when recording a game', 'The pointer shows in the recording'],
    ], R);
    const V = (o) => Object.keys(o).map((k) => o[k]);
    // lane mantle-clips2: Mantle's own gallery of this folder (Win+G opens its Record panel)
    const clips = kit.button({ row: 'gaming.captures.clips', label: 'Clips', help: 'Mantle\'s gallery of your recordings and screenshots: play, trim, copy, share', text: 'Open Clips',
      onClick: () => (kit.test ? { ok: true, dryRun: true, reason: 'Test run, nothing opened: Mantle would open Clips' } : kit.call('clips.open', {})) });
    el.append(top, kit.card(folder, clips), kit.group('Recording'), kit.card(...V(rec)),
      kit.group('Recorded audio'), kit.card(...V(au)), kit.group('Recorded video'), kit.card(...V(vi)));
    R.on((r, why) => {
      if (!r) { top.replaceChildren(); return folder.set({ help: '—', reason: why }); }
      const notes = [r.policy ? 'Every capture setting is read only here: ' + r.policy : null, r.capturesOff].filter(Boolean);
      top.replaceChildren(...notes.map((t) => kit.reason(t)));
      const f = r.folder || {};
      folder.set({ help: f.path || 'Unknown', value: f.exists ? (f.files === 1 ? '1 file' : (f.files || 0) + ' files') : 'Not made yet',
        reason: f.path ? null : f.why || 'Windows did not say where it is', info: FOLDER_WHY + (f.path && !f.exists && f.why ? ' (' + f.why + ')' : '') });
    });
    return R.read().then(() => ({ update: R.read, dispose() {} }));
  }

  // ============================================================== Game Mode (Windows' and Mantle's)
  function renderGameMode(el, kit) {
    const R = reader(kit);
    const win = rowsOf(kit, [['gameMode', 'gaming.game-mode.windows', 'toggle', 'Game Mode', WINDOWS_LINE]], R);
    const st = kit.status({ row: 'gaming.game-mode.mantle-status', label: 'Mantle game mode now', help: MANTLE_LINE, value: 'Reading…' });
    const feat = kit.toggle({ row: 'gaming.game-mode.mantle', label: 'Mantle game mode', help: 'Mantle\'s game mode feature, the same switch as in the Mantle section',
      onChange: (on) => kit.call('settings.enable', { feature: 'gamemode', on }).then((r) => (r.ok === false ? r : { ok: true, value: r.feature ? !!r.feature.enabled : on })).then((r) => { readMantle(); return r; }) });
    const LABEL = { auto: 'Turn on by itself for games', liftSaver: 'Lift Energy saver while gaming on battery', boost: 'Boost: free memory and power for the game' };
    const opt = (key, row) => kit.toggle({ row, label: LABEL[key],
      onChange: (on) => kit.call('settings.option', { feature: 'gamemode', key, value: on }).then((r) => (r.ok === false ? r : { ok: true, value: r.option ? r.option.value === true : on })) });
    const auto = opt('auto', 'gaming.game-mode.mantle-auto');
    const saver = opt('liftSaver', 'gaming.game-mode.mantle-saver');
    const boost = opt('boost', 'gaming.game-mode.mantle-boost');
    const acts = kit.list({ row: 'gaming.game-mode.mantle-actions', items: [], empty: 'Reading…' });
    const more = kit.button({ row: 'gaming.game-mode.mantle-more', label: 'All of Mantle\'s options', help: 'Mantle\'s other features and switches', text: 'Open', tone: 'quiet',
      onClick: () => { kit.open({ section: 'mantle', row: 'mantle.feature.gamemode' }); return { ok: true }; } });
    el.append(kit.group('Windows Game Mode'), kit.card(win.gameMode),
      kit.group('Mantle game mode'), kit.card(st, feat, auto, saver, boost),
      kit.group('What Mantle game mode is doing'), kit.card(acts), kit.card(more));

    let state = null, stWhy = null, fm = null, fmWhy = null;
    function drawMantle() {
      const off = fm && fm.enabled === false;
      const g = state;
      if (!g) st.set({ value: '—', tone: null, reason: stWhy || (off ? null : 'Mantle game mode did not report its state') });
      else {
        const game = g.game && (g.game.title || g.game.file);
        st.set({ tone: g.on ? 'ok' : null, reason: g.watching === false && g.reason && !off ? 'Games are not being watched: ' + g.reason : null,
          value: off || g.enabled === false ? 'Switched off' : g.on ? 'On' + (game ? ' · ' + game : '') + (g.how === 'manual' ? ' · by hand' : '')
            : g.rest && g.rest.on ? 'Resting for a game' : 'Off · ' + (g.auto ? 'waiting for a game' : 'turns on only by hand') });
      }
      if (!fm) {
        [feat, auto, saver, boost].forEach((t) => t.set({ disabled: true, reason: fmWhy || 'Mantle did not list its game mode feature' }));
      } else {
        feat.set({ value: !!fm.enabled, disabled: fm.ok === false && !fm.enabled, reason: fm.ok === false ? 'Mantle game mode did not load: ' + (fm.reason || 'no reason came back') : null });
        for (const [t, key] of [[auto, 'auto'], [saver, 'liftSaver'], [boost, 'boost']]) {
          const o = (fm.options || []).find((x) => x.key === key);
          if (!o) { t.set({ disabled: true, reason: 'Mantle game mode has no "' + key + '" option in this build' }); continue; }
          t.set({ label: o.label || LABEL[key], help: o.help || '', value: o.value === true, disabled: false,
            reason: o.note ? o.note : null, info: off ? 'Kept for when Mantle game mode is switched on again' : null });
        }
      }
      const list = g && Array.isArray(g.actions) ? g.actions : [];
      const W = { ok: 'Done', dry: 'Test run', blocked: 'Not possible', failed: 'Failed', skipped: 'Skipped' };
      acts.set({ empty: !g ? (stWhy || 'Not reported') : g.on ? 'Nothing to show yet' : 'Nothing right now: Mantle game mode is off',
        items: g && g.on ? list.map((a, i) => ({ key: String(a.key || i).replace(/[^A-Za-z0-9_.+-]/g, '-'), label: a.label || a.key, help: a.status === 'failed' || a.status === 'blocked' ? '' : a.text || '',
          value: W[a.status] || a.status || '', reason: a.status === 'failed' || a.status === 'blocked' ? a.text || 'no reason came back' : null })) : [] });
    }
    async function readMantle() {
      const [g, m] = await Promise.all([kit.call('gamemode.state', {}), kit.call('settings.mantle', {})]);
      state = g && g.ok !== false ? g : null;
      stWhy = bad(g, 'Mantle game mode could not be read');
      fm = m && m.ok !== false && Array.isArray(m.features) ? m.features.find((f) => f.name === 'gamemode') || null : null;
      fmWhy = bad(m, 'Mantle\'s features could not be read');
      drawMantle();
    }
    kit.watch('gamemode.state', (g) => { if (g && typeof g === 'object') { state = g; stWhy = null; drawMantle(); } });
    const all = () => Promise.all([R.read(), readMantle()]);
    return all().then(() => ({ update: all, dispose() {} }));
  }

  // ============================================================== the section
  MantleSettings.section({
    id: 'gaming',
    title: 'Gaming',
    group: 'windows',
    icon: 'game',
    order: 80,
    help: 'Game Bar, captures, Game Mode',
    keywords: 'gaming games xbox game bar captures game mode recording',
    pages: [
      { id: 'game-bar', title: 'Xbox Game Bar', icon: SVG.pad, help: 'Controller button, the Game Bar app',
        search: [
          { row: 'gaming.game-bar.controller', label: 'Open Xbox Game Bar using this button on a controller', keywords: 'xbox button controller gamepad nexus game bar', uri: 'ms-settings:gaming-gamebar' },
          { row: 'gaming.game-bar.app', label: 'Xbox Game Bar app', keywords: 'win+g overlay widgets installed' },
        ], render: renderGameBar },
      { id: 'captures', title: 'Captures', icon: SVG.rec, help: 'Background recording, audio and video quality',
        search: [
          { row: 'gaming.captures.folder', label: 'Captures location', keywords: 'folder clips videos where saved captures', uri: 'ms-settings:gaming-gamedvr' },
          { row: 'gaming.captures.background', label: 'Record what happened', keywords: 'background recording game dvr clip last seconds fps performance' },
          { row: 'gaming.captures.battery', label: 'Record while on battery power', keywords: 'background recording battery' },
          { row: 'gaming.captures.wireless', label: 'Record while wirelessly projecting my screen', keywords: 'background recording cast miracast' },
          { row: 'gaming.captures.buffer', label: 'Record the last', keywords: 'background recording length seconds minutes' },
          { row: 'gaming.captures.max-length', label: 'Max recording length', keywords: 'recording length hours minutes' },
          { row: 'gaming.captures.audio', label: 'Capture audio when recording a game', keywords: 'sound audio recording' },
          { row: 'gaming.captures.mic', label: 'Turn on my microphone by default when I record', keywords: 'microphone mic voice recording' },
          { row: 'gaming.captures.audio-quality', label: 'Audio quality', keywords: 'kbps bitrate audio recording' },
          { row: 'gaming.captures.frame-rate', label: 'Video frame rate', keywords: 'fps 30 60 frame rate recording' },
          { row: 'gaming.captures.quality', label: 'Video quality', keywords: 'standard high quality bitrate recording' },
          { row: 'gaming.captures.cursor', label: 'Capture mouse cursor when recording a game', keywords: 'mouse pointer cursor recording' },
        ], render: renderCaptures },
      { id: 'game-mode', title: 'Game Mode', icon: 'game', help: 'Windows\' Game Mode and Mantle\'s',
        search: [
          { row: 'gaming.game-mode.windows', label: 'Game Mode', keywords: 'windows game mode performance optimize', uri: 'ms-settings:gaming-gamemode' },
          { row: 'gaming.game-mode.mantle-status', label: 'Mantle game mode now', keywords: 'mantle game mode status resting' },
          { row: 'gaming.game-mode.mantle', label: 'Mantle game mode', keywords: 'mantle game mode feature performance' },
          { row: 'gaming.game-mode.mantle-auto', label: 'Turn on by itself for games', keywords: 'mantle game mode automatic auto' },
          { row: 'gaming.game-mode.mantle-saver', label: 'Lift Energy saver while gaming on battery', keywords: 'mantle game mode energy saver battery' },
          { row: 'gaming.game-mode.mantle-boost', label: 'Boost: free memory and power for the game', keywords: 'mantle game mode boost memory ram free trim efficiency background apps' },
          { row: 'gaming.game-mode.mantle-actions', label: 'What Mantle game mode is doing', keywords: 'mantle game mode actions power background apps' },
          { row: 'gaming.game-mode.mantle-more', label: 'All of Mantle\'s options', keywords: 'mantle options features' },
        ], render: renderGameMode },
    ],
  });
})();

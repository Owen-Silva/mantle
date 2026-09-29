/* system.js - Mantle Settings > System, the page half (lane sysset, 2026-09-28; contract SECTIONS.md).
 *
 * Owen: "it should show all windows settings cause remember the point of this is to fully replace
 * windows basically so it should do everything windows can do and more". So this is Windows 11's
 * whole System category, drawn ONLY with the kit, every value read from Windows through the sidecar
 * (settings.system.read / .write / .admin, lib/features/_settings-sections/system.js), every control
 * showing its reason inline, every administrator action behind the shield with Windows' words.
 *
 * It replaces the built-in Display, Sound, Notifications and Power sections: their row ids
 * (display.brightness, sound.output, power.mode, notifications.dnd, ...) are drawn here so old deep
 * links still land. Display is drawn natively since lane sysdisp2 (renderDisplay, over SysDisplay.cs), Sound
 * since lane syssnd (renderSound, over SysSound.cs).
 */
(function () {
  'use strict';

  /* ---------------------------------------------------------------- helpers */
  const R = (kit, what, args) => kit.call('settings.system.read', Object.assign({ what }, args || {}));
  const W = (kit, what, args, pick) => kit.call('settings.system.write', Object.assign({ what }, args || {})).then((r) => {
    if (r && r.ok && !r.dryRun && pick) { try { return { ok: true, value: pick(r) }; } catch (e) { return r; } }
    return r;
  });
  const A = (kit, action, args) => kit.call('settings.system.admin', { action, args: args || {} });
  const fail = (what, r) => `${what} could not be read: ${(r && r.reason) || 'no answer'}`;
  const pct = (v) => `${Math.round(v)}%`;
  const bytes = (n) => {
    if (n == null) return '—';
    const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; let v = n;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
  };
  /** Windows' timeout choices (seconds); anything else on the PC is shown as its own "custom" choice. */
  const TIMEOUTS = [60, 120, 180, 300, 600, 900, 1200, 1500, 1800, 2700, 3600, 7200, 10800, 14400, 18000, 0];
  const dur = (s) => {
    if (s === 0) return 'Never';
    if (s % 3600 === 0) return `${s / 3600} hour${s === 3600 ? '' : 's'}`;
    if (s % 60 === 0) return `${s / 60} minute${s === 60 ? '' : 's'}`;
    return `${s} seconds`;
  };
  const timeoutOptions = (cur) => {
    const list = TIMEOUTS.slice();
    if (cur != null && !list.includes(cur)) list.unshift(cur);
    return list.map((v) => ({ value: v, label: TIMEOUTS.includes(v) ? dur(v) : `Custom: ${v > 86400 ? 'set outside Windows\' list' : dur(v)}` }));
  };
  /** A row's patch from a sidecar side {value, writable, why}. */
  const side = (s) => s ? { value: s.value, disabled: !s.writable, reason: s.writable ? null : s.why } : { reason: 'not reported by Windows', disabled: true };
  const onoff = (b) => (b ? 'On' : 'Off');

  /* ---------------------------------------------------------------- Power & battery */
  function renderPower(el, kit) {
    const mode = kit.choice({ row: 'power.mode', label: 'Power mode', help: 'How Windows trades battery life for speed', style: 'segmented',
      options: [{ value: 'efficiency', label: 'Best power efficiency' }, { value: 'balanced', label: 'Balanced' }, { value: 'performance', label: 'Best performance' }],
      onChange: (m) => kit.call('powermode.set', { mode: m }).then((r) => r && r.ok !== false ? { ok: true, value: (r.state && (r.state.inForce || r.state.mode)) || m } : r) });
    const saver = kit.status({ row: 'power.saver', label: 'Energy saver', value: 'Reading…' });
    const saverAt = kit.choice({ row: 'system.power.saverAt', label: 'Turn energy saver on automatically at', style: 'dropdown',
      help: 'On battery. "Always" keeps it on whenever the PC is unplugged',
      options: [0, 10, 20, 30, 40, 50, 100].map((v) => ({ value: v, label: v === 0 ? 'Never' : v === 100 ? 'Always' : `${v}%` })),
      onChange: (v) => W(kit, 'powerSet', { setting: 'saverAt', source: 'dc', value: v }, (r) => r.dc) });
    const saverAlways = kit.toggle({ row: 'system.power.saverAlways', label: 'Always use energy saver', help: 'Plugged in too: energy saver never turns off',
      onChange: (on) => W(kit, 'powerSet', { setting: 'saverAt', source: 'both', value: on ? 100 : 0 }, (r) => r.ac === 100) });
    const saverDim = kit.slider({ row: 'system.power.saverBrightness', label: 'Screen brightness while energy saver is on', min: 0, max: 100, step: 5, unit: '%',
      help: '100% leaves the screen as it is',
      onChange: (v) => W(kit, 'powerSet', { setting: 'saverBrightness', source: 'both', value: v }, (r) => r.dc) });
    const battery = kit.status({ row: 'power.battery', label: 'Battery', value: 'Reading…' });
    const gm = kit.button({ row: 'power.gamemode', label: 'Game mode', help: 'Mantle\'s game mode lives in the Mantle section', text: 'Game mode options',
      onClick: () => kit.open({ section: 'mantle', row: 'mantle.feature.gamemode' }) });

    const T = {};
    const tRow = (key, src, label) => kit.choice({ row: `system.power.${key}.${src}`, label, style: 'dropdown', options: timeoutOptions(null),
      onChange: (v) => W(kit, 'powerSet', { setting: key, source: src, value: v }, (r) => r[src]) });
    const tGroups = [['screenOff', 'Turn my screen off after'], ['sleep', 'Make my device sleep after'], ['hibernate', 'Make my device hibernate after']];
    for (const [k, label] of tGroups) { T[`${k}.dc`] = tRow(k, 'dc', `${label} (on battery)`); T[`${k}.ac`] = tRow(k, 'ac', `${label} (plugged in)`); }
    const B = {};
    const bRows = [['lid', 'Closing the lid will make my PC'], ['powerButton', 'Pressing the power button will make my PC'], ['sleepButton', 'Pressing the sleep button will make my PC']];
    for (const [k, label] of bRows) for (const src of ['dc', 'ac']) {
      B[`${k}.${src}`] = kit.choice({ row: `system.power.${k}.${src}`, label: `${label} (${src === 'dc' ? 'on battery' : 'plugged in'})`, style: 'dropdown', options: [],
        onChange: (v) => W(kit, 'powerSet', { setting: k, source: src, value: v }, (r) => r[src]) });
    }
    const hib = kit.toggle({ row: 'system.power.hibernation', label: 'Hibernation', admin: 'turn hibernation on or off',
      help: 'Saves your session to disk so the PC uses no power; needs a hibernation file',
      onChange: (on) => A(kit, 'system.hibernate', { on }).then((r) => r && r.ok && !r.dryRun ? { ok: true, value: r.on, note: r.note } : r) });
    const fast = kit.toggle({ row: 'system.power.fastStartup', label: 'Fast start-up', admin: 'turn fast start-up on or off',
      help: 'Shut down saves the system (not your apps) so the next start is quicker',
      onChange: (on) => A(kit, 'system.fastStartup', { on }).then((r) => r && r.ok && !r.dryRun ? { ok: true, value: r.on, note: r.note } : r) });

    el.append(
      kit.group('Power'), kit.card(mode, saver, saverAt, saverAlways, saverDim),
      kit.group('Battery'), kit.card(battery),
      kit.group('Screen, sleep and hibernate timeouts'), kit.card(...tGroups.flatMap(([k]) => [T[`${k}.dc`], T[`${k}.ac`]])),
      kit.group('Lid and power button controls'), kit.card(...bRows.flatMap(([k]) => [B[`${k}.dc`], B[`${k}.ac`]])),
      kit.group('Hibernation and start-up'), kit.card(hib, fast),
      kit.group('Game mode'), kit.card(gm));

    async function update() {
      const [p, pm, bat] = await Promise.all([R(kit, 'power'), kit.call('powermode.get'), kit.call('battery.get')]);
      if (pm && pm.ok !== false) {
        const canSet = pm.available !== false && pm.settable !== false;
        mode.set({ value: pm.inForce || pm.mode, disabled: !canSet, reason: canSet ? null : (pm.reason || 'Windows will not let the power mode be set right now') });
        saver.set({ value: pm.saver ? 'On: Windows is saving power' : 'Off', tone: pm.saver ? 'warn' : 'ok' });
      } else mode.set({ reason: fail('The power mode', pm), disabled: true });
      if (bat && bat.ok !== false) {
        const txt = bat.present === false || bat.none ? 'No battery in this PC' : `${bat.percent != null ? pct(bat.percent) : '?'}${bat.charging ? ', charging' : bat.plugged || bat.ac ? ', plugged in' : ', on battery'}`;
        battery.set({ value: txt, tone: 'info' });
      } else battery.set({ value: fail('The battery', bat), tone: 'warn' });
      if (!p || !p.ok) {
        for (const c of [saverAt, saverAlways, saverDim, hib, fast, ...Object.values(T), ...Object.values(B)]) c.set({ reason: fail('This setting', p), disabled: true });
        return;
      }
      const S = p.settings || {};
      const hasBat = !!(p.caps && p.caps.battery);
      saverAt.set(Object.assign(side(S.saverAt && S.saverAt.dc), { info: hasBat ? null : 'This PC has no battery, so energy saver never turns on by itself' }));
      saverAlways.set({ value: !!(S.saverAt && S.saverAt.ac && S.saverAt.ac.value === 100 && S.saverAt.dc.value === 100), disabled: !(S.saverAt && S.saverAt.ac.writable), reason: S.saverAt && !S.saverAt.ac.writable ? S.saverAt.ac.why : null });
      saverDim.set(side(S.saverBrightness && S.saverBrightness.dc));
      for (const [k] of tGroups) for (const src of ['dc', 'ac']) {
        const s = S[k] && S[k][src];
        const patch = side(s);
        patch.options = timeoutOptions(s ? s.value : null);
        if (S[k] && !S[k].applies) Object.assign(patch, { disabled: true, reason: S[k].why });
        if (src === 'dc' && !hasBat) Object.assign(patch, { disabled: true, info: 'No battery: only the plugged-in value applies', reason: null });
        T[`${k}.${src}`].set(patch);
      }
      for (const [k] of bRows) for (const src of ['dc', 'ac']) {
        const row = S[k];
        const patch = side(row && row[src]);
        patch.options = (row && row.choices || []).map((c) => ({ value: c.value, label: c.label }));
        if (row && !row.applies) Object.assign(patch, { disabled: true, reason: row.why });
        if (src === 'dc' && !hasBat) Object.assign(patch, { disabled: true, info: 'No battery: only the plugged-in value applies', reason: null });
        B[`${k}.${src}`].set(patch);
      }
      hib.set({ value: !!(p.hibernation && p.hibernation.on), reason: null });
      fast.set({ value: !!(p.fastStartup && p.fastStartup.on), disabled: p.fastStartup && p.fastStartup.available === false, reason: p.fastStartup && p.fastStartup.available === false ? p.fastStartup.why : null });
    }
    update();
    kit.every(10000, update);
    return { update, dispose() {} };
  }

  /* ---------------------------------------------------------------- Notifications */
  function renderNotifications(el, kit) {
    const G = {};
    const gRow = (key, row, label, help) => (G[key] = kit.toggle({ row, label, help,
      onChange: (on) => W(kit, 'notifySet', { key, on }, (r) => r.on) }));
    gRow('toasts', 'system.notifications.toasts', 'Notifications', 'Get notifications from apps and other senders');
    const dnd = kit.toggle({ row: 'notifications.dnd', label: 'Do not disturb', help: 'Banners are silenced; priority notifications still come through',
      onChange: (on) => W(kit, 'dnd', { on }, (r) => r.on) });
    const rules = kit.status({ row: 'system.notifications.rules', label: 'Turn on Do not disturb automatically', value: 'Reading…' });
    let focusMin = 30;
    const focusLen = kit.choice({ row: 'system.notifications.focusLength', label: 'Focus session length', style: 'dropdown', value: 30,
      options: [15, 20, 25, 30, 45, 60, 90, 120, 180, 240].map((m) => ({ value: m, label: m < 60 ? `${m} minutes` : `${m / 60} hour${m === 60 ? '' : 's'}` })),
      onChange: (m) => { focusMin = m; return { ok: true, value: m }; } });
    const focus = kit.toggle({ row: 'system.notifications.focus', label: 'Focus session', help: 'Turns on Do not disturb and hides badges for the length above',
      onChange: (on) => W(kit, 'focus', on ? { on, minutes: focusMin } : { on }, (r) => r.active) });
    gRow('sound', 'system.notifications.sound', 'Allow notifications to play sounds');
    gRow('lockScreen', 'system.notifications.lockScreen', 'Show notifications on the lock screen');
    gRow('criticalLock', 'system.notifications.criticalLock', 'Show reminders and incoming calls on the lock screen');
    const panels = kit.toggle({ row: 'notifications.panels', label: 'Mantle\'s notification and quick settings panels',
      help: 'Win+N opens the notification center and Win+A quick settings, both drawn by Mantle',
      onChange: (on) => kit.call('settings.switcher', { winKeys: on }).then((r) => r && r.ok ? { ok: true, value: !!(r.switcher && r.switcher.winKeys) } : r) });
    const apps = kit.list({ row: 'system.notifications.apps', items: [], empty: 'Reading…',
      onAction: (key, act, item) => {
        const a = byApp[key];
        if (!a) return { ok: false, reason: 'refresh the page: that app is not listed any more' };
        const next = act === 'priority' ? (a.priority === 0 ? 1 : a.priority === 1 ? 99 : 0) : !a[act];
        return W(kit, 'notifyApp', { app: a.app, key: act, value: next }).then((r) => { if (r && r.ok && !r.dryRun) update(); return r; });
      } });
    el.append(
      kit.group('Notifications'), kit.card(G.toasts, dnd, rules),
      kit.group('Focus'), kit.card(focusLen, focus),
      kit.group('Sounds and lock screen'), kit.card(G.sound, G.lockScreen, G.criticalLock),
      kit.group('Mantle'), kit.card(panels),
      kit.group('Notifications from apps and other senders', { aside: 'Sound and lock screen per app are Windows-only; see each app\'s note' }), kit.card(apps));
    let byApp = {};
    const PRI = { 0: 'Normal', 1: 'High', 99: 'Top' };
    async function update() {
      const [n, m] = await Promise.all([R(kit, 'notify'), kit.call('settings.mantle')]);
      const sw = m && m.switcher;
      panels.set(sw ? { value: !!sw.winKeys, reason: sw.winKeysReason || null } : { reason: fail('Mantle\'s switches', m), disabled: true });
      if (!n || !n.ok) { for (const c of [G.toasts, dnd, focus, G.sound, G.lockScreen, G.criticalLock]) c.set({ reason: fail('This setting', n), disabled: true }); return; }
      for (const k of Object.keys(G)) G[k].set({ value: !!(n.globals[k] && n.globals[k].on), reason: null, disabled: false });
      dnd.set({ value: !!n.dnd.on, disabled: !n.dnd.writable, reason: n.dnd.writable ? null : n.dnd.why });
      rules.set({ value: n.rules.why, tone: 'info' });
      focus.set({ value: !!n.focus.active, disabled: !n.focus.writable, reason: n.focus.writable ? null : n.focus.why });
      byApp = {};
      const items = (n.apps || []).map((a, i) => {
        const key = `a${i}`;
        byApp[key] = a;
        const bits = [a.enabled ? 'On' : 'Off', a.banner ? 'banners' : 'no banners', a.center ? 'in notification center' : 'not in notification center',
          `priority ${PRI[a.priority] || a.priority}`, a.sound == null ? null : `sound ${a.sound ? 'on' : 'off'} (Windows-only)`];
        return { key, label: a.name || a.app, help: bits.filter(Boolean).join(' · '), icon: a.icon || undefined, mono: !a.name,
          actions: [{ id: 'enabled', text: a.enabled ? 'Turn off' : 'Turn on' },
            { id: 'banner', text: a.banner ? 'Hide banners' : 'Show banners', disabled: !a.enabled },
            { id: 'center', text: a.center ? 'Hide in center' : 'Show in center', disabled: !a.enabled },
            { id: 'priority', text: `Priority: ${PRI[a.priority] || a.priority}`, disabled: !a.enabled }] };
      }).sort((x, y) => String(x.label).localeCompare(String(y.label)));
      apps.set({ items, empty: n.appsWhy || 'No app has sent a notification yet' });
    }
    update();
    kit.every(10000, update);
    return { update, dispose() {} };
  }

  /* ---------------------------------------------------------------- Multitasking, Clipboard, Nearby, Projecting, Remote */
  function multiRows(kit, defs) {
    const out = {};
    for (const d of defs) {
      const base = { row: d.row, label: d.label, help: d.help,
        onChange: (v) => W(kit, 'multiSet', { key: d.key, value: v }, (r) => r.value) };
      out[d.key] = d.options ? kit.choice(Object.assign(base, { options: d.options, style: d.style || 'dropdown' })) : kit.toggle(base);
    }
    return out;
  }
  function fillMulti(rowsDef, ctl, m) {
    for (const d of rowsDef) {
      const r = m && m.ok && m.rows && m.rows[d.key];
      ctl[d.key].set(r ? { value: r.value, disabled: !r.writable, reason: r.writable ? null : r.why } : { reason: fail('This setting', m), disabled: true });
    }
  }

  const MULTI = [
    { key: 'snap', row: 'system.multitasking.snap', label: 'Snap windows (Windows)', help: 'Windows\' own snapping, used wherever Mantle\'s is off' },
    { key: 'snapFlyout', row: 'system.multitasking.snapFlyout', label: 'Show snap layouts when I hover over a window\'s maximise button' },
    { key: 'snapBar', row: 'system.multitasking.snapBar', label: 'Show snap layouts when I drag a window to the top of my screen' },
    { key: 'snapAssist', row: 'system.multitasking.snapAssist', label: 'Show what I can snap next to it' },
    { key: 'snapGroups', row: 'system.multitasking.snapGroups', label: 'Show my snapped windows when I hover over taskbar apps' },
    { key: 'snapFill', row: 'system.multitasking.snapFill', label: 'When I snap a window, size it to fill the available space' },
    { key: 'jointResize', row: 'system.multitasking.jointResize', label: 'When I resize a snapped window, resize the one next to it too' },
    { key: 'shake', row: 'system.multitasking.shake', label: 'Title bar window shake', help: 'Shake a window\'s title bar to minimise all the others' },
    { key: 'desktopsTaskbar', row: 'system.multitasking.desktopsTaskbar', label: 'On the taskbar, show windows open on', options: [{ value: 1, label: 'Only the desktop I\'m using' }, { value: 0, label: 'All desktops' }] },
    { key: 'desktopsAltTab', row: 'system.multitasking.desktopsAltTab', label: 'Pressing Alt+Tab (Windows) shows windows open on', options: [{ value: 1, label: 'Only the desktop I\'m using' }, { value: 0, label: 'All desktops' }] },
    { key: 'altTabTabs', row: 'system.multitasking.altTabTabs', label: 'Show tabs from apps when snapping or pressing Alt+Tab (Windows)',
      options: [{ value: 3, label: 'Don\'t show tabs' }, { value: 2, label: '3 most recent tabs' }, { value: 1, label: '5 most recent tabs' }, { value: 0, label: '20 most recent tabs' }] },
  ];

  function featureToggle(kit, name, row, label, help) {
    return kit.toggle({ row, label, help, onChange: (on) => kit.call('settings.enable', { feature: name, on }).then((r) => r && r.ok ? { ok: true, value: !!(r.feature && r.feature.enabled) } : r) });
  }
  async function fillFeatures(kit, pairs) {
    const m = await kit.call('settings.mantle');
    for (const [name, ctl] of pairs) {
      const f = m && m.ok && (m.features || []).find((x) => x.name === name);
      ctl.set(f ? { value: f.enabled, reason: f.enabled && !f.ok ? f.reason : null, disabled: false } : { reason: m && m.ok ? `Mantle's ${name} feature is not installed` : fail('Mantle\'s features', m), disabled: true });
    }
    return m;
  }

  function renderMultitasking(el, kit) {
    const mSnap = featureToggle(kit, 'snap', 'system.multitasking.mantleSnap', 'Mantle\'s snapping', 'Win+Left / Right / Up / Down and Win+Z snap layouts, drawn by Mantle');
    const mAlt = kit.toggle({ row: 'system.multitasking.mantleAltTab', label: 'Mantle\'s Alt+Tab', help: 'Mantle\'s window switcher replaces Windows\' Alt+Tab',
      onChange: (on) => kit.call('settings.switcher', { altTab: on }).then((r) => r && r.ok ? { ok: true, value: !!(r.switcher && r.switcher.altTab) } : r) });
    const mTask = featureToggle(kit, 'taskview', 'system.multitasking.mantleTaskView', 'Mantle\'s Task view (Win+Tab)', 'Desktops and open windows, drawn by Mantle');
    const ctl = multiRows(kit, MULTI);
    el.append(
      kit.group('Mantle'), kit.card(mSnap, mAlt, mTask),
      kit.group('Snap windows'), kit.card(ctl.snap, ctl.snapFlyout, ctl.snapBar, ctl.snapAssist, ctl.snapGroups, ctl.snapFill, ctl.jointResize),
      kit.group('Title bar window shake'), kit.card(ctl.shake),
      kit.group('Desktops'), kit.card(ctl.desktopsTaskbar, ctl.desktopsAltTab),
      kit.group('Alt+Tab'), kit.card(ctl.altTabTabs));
    async function update() {
      const [m, mm] = await Promise.all([R(kit, 'multi'), fillFeatures(kit, [['snap', mSnap], ['taskview', mTask]])]);
      const sw = mm && mm.switcher;
      mAlt.set(sw ? { value: !!sw.altTab, reason: sw.altTabReason || null } : { reason: fail('Mantle\'s switcher', mm), disabled: true });
      fillMulti(MULTI, ctl, m);
    }
    update();
    return { update, dispose() {} };
  }

  const CLIP = [
    { key: 'clipboardHistory', row: 'system.clipboard.history', label: 'Windows clipboard history', help: 'Windows\' own history (Mantle\'s Win+V keeps its own)' },
    { key: 'clipboardSync', row: 'system.clipboard.sync', label: 'Share across your devices', help: 'Needs a Microsoft account; the sync itself is Microsoft\'s service' },
    { key: 'clipboardAutoSync', row: 'system.clipboard.autoSync', label: 'Automatically sync text that I copy' },
  ];
  function renderClipboard(el, kit) {
    const mine = featureToggle(kit, 'clipboard', 'system.clipboard.mantle', 'Mantle\'s clipboard history (Win+V)', 'Mantle keeps what you copy and Win+V shows it');
    const ctl = multiRows(kit, CLIP);
    const clear = kit.button({ row: 'system.clipboard.clear', label: 'Clear Windows\' clipboard data', help: 'Everything except pinned items', text: 'Clear',
      onClick: () => W(kit, 'clearClipboard', {}) });
    el.append(kit.group('Mantle'), kit.card(mine), kit.group('Windows'), kit.card(ctl.clipboardHistory, ctl.clipboardSync, ctl.clipboardAutoSync, clear));
    async function update() { const [m] = await Promise.all([R(kit, 'multi'), fillFeatures(kit, [['clipboard', mine]])]); fillMulti(CLIP, ctl, m); }
    update();
    return { update, dispose() {} };
  }

  const NEAR = [{ key: 'nearbySharing', row: 'system.nearby.sharing', label: 'Nearby sharing', help: 'Share files and links with nearby PCs over Bluetooth and Wi-Fi',
    options: [{ value: 0, label: 'Off' }, { value: 1, label: 'My devices only' }, { value: 2, label: 'Everyone nearby' }], style: 'segmented' }];
  function renderNearby(el, kit) {
    const ctl = multiRows(kit, NEAR);
    el.append(kit.group('Nearby sharing'), kit.card(ctl.nearbySharing));
    async function update() { fillMulti(NEAR, ctl, await R(kit, 'multi')); }
    update();
    return { update, dispose() {} };
  }

  function renderProjecting(el, kit) {
    const st = kit.status({ row: 'system.projecting.available', label: 'Projecting to this PC', value: 'Reading…' });
    el.append(kit.group('Projecting to this PC'), kit.card(st));
    async function update() {
      const m = await R(kit, 'multi');
      const p = m && m.ok && m.projecting;
      st.set(p ? { value: p.available ? 'Available' : 'Not available', tone: p.available ? 'ok' : 'warn', reason: p.why } : { value: fail('Projecting', m), tone: 'warn' });
    }
    update();
    return { update, dispose() {} };
  }

  function renderRemote(el, kit) {
    const rd = kit.toggle({ row: 'system.remote.desktop', label: 'Remote Desktop', admin: 'turn Remote Desktop on or off',
      help: 'Connect to and use this PC from another device',
      onChange: (on) => A(kit, 'system.remoteDesktop', { on }).then((r) => r && r.ok && !r.dryRun ? { ok: true, value: r.on, note: r.note } : r) });
    el.append(kit.group('Remote Desktop'), kit.card(rd));
    async function update() {
      const m = await R(kit, 'multi');
      const r = m && m.ok && m.remoteDesktop;
      rd.set(r ? { value: !!r.on, disabled: !r.writable, reason: r.writable ? null : r.why, admin: r.writable ? 'turn Remote Desktop on or off' : undefined } : { reason: fail('Remote Desktop', m), disabled: true });
    }
    update();
    return { update, dispose() {} };
  }

  /* ---------------------------------------------------------------- About, Activation, Troubleshoot, Recovery */
  function renderAbout(el, kit) {
    const name = kit.text({ row: 'system.about.name', label: 'Device name', admin: 'rename this PC',
      help: 'Letters, numbers and hyphens, 1 to 15 characters. Takes effect after a restart',
      onChange: (s) => A(kit, 'system.renamePc', { name: String(s || '').trim() }).then((r) => r && r.ok && !r.dryRun ? { ok: true, value: r.name, note: r.note } : r) });
    const D = {};
    const dRows = [['processor', 'Processor'], ['ram', 'Installed RAM'], ['storage', 'Storage'], ['model', 'Device'], ['deviceId', 'Device ID'], ['productId', 'Product ID'], ['systemType', 'System type'], ['penTouch', 'Pen and touch']];
    for (const [k, label] of dRows) D[k] = kit.status({ row: `system.about.${k}`, label, value: 'Reading…', tone: 'info' });
    const Wn = {};
    const wRows = [['edition', 'Edition'], ['version', 'Version'], ['installed', 'Installed on'], ['build', 'OS build'], ['experience', 'Experience']];
    for (const [k, label] of wRows) Wn[k] = kit.status({ row: `system.about.win.${k}`, label, value: 'Reading…', tone: 'info' });
    el.append(kit.group('Device specifications'), kit.card(name, ...dRows.map(([k]) => D[k])), kit.group('Windows specifications'), kit.card(...wRows.map(([k]) => Wn[k])));
    async function update() {
      const a = await R(kit, 'about');
      if (!a || !a.ok) { name.set({ reason: fail('The device', a), disabled: true }); return; }
      const d = a.device, w = a.windows;
      name.set({ value: d.name });
      const v = { processor: `${d.processor} (${d.cores} logical processors)`, ram: d.ramInstalledBytes ? `${bytes(d.ramInstalledBytes)} (${bytes(d.ramUsableBytes)} usable)` : '—',
        storage: bytes(d.storageBytes), model: [d.manufacturer, d.model].filter(Boolean).join(' ') || '—', deviceId: d.deviceId || '—', productId: d.productId || '—',
        systemType: d.systemType, penTouch: d.penTouch };
      for (const [k] of dRows) D[k].set({ value: v[k] || '—' });
      for (const [k] of wRows) Wn[k].set({ value: w[k] || '—' });
    }
    update();
    return { update, dispose() {} };
  }

  function renderActivation(el, kit) {
    const st = kit.status({ row: 'system.activation.state', label: 'Activation state', value: 'Reading… (Windows\' licensing service takes a moment)' });
    const ch = kit.status({ row: 'system.activation.channel', label: 'Licence', value: '—', tone: 'info' });
    const key = kit.text({ row: 'system.activation.key', label: 'Change product key', admin: 'change the Windows product key', placeholder: 'XXXXX-XXXXX-XXXXX-XXXXX-XXXXX',
      onChange: (s) => A(kit, 'system.productKey', { key: String(s || '').trim() }).then((r) => { if (r && r.ok && !r.dryRun) update(); return r && r.ok && !r.dryRun ? { ok: true, value: '', note: r.note } : r; }) });
    const acct = kit.status({ row: 'system.activation.account', label: 'Microsoft account and digital licence', value: '—', tone: 'info' });
    el.append(kit.group('Activation'), kit.card(st, ch, key, acct));
    async function update() {
      const a = await R(kit, 'activation');
      if (!a || !a.ok) { st.set({ value: fail('Activation', a), tone: 'warn' }); return; }
      st.set({ value: a.state, tone: a.activated ? 'ok' : 'warn' });
      ch.set({ value: [a.channel, a.description].filter(Boolean).join(' · ') || '—' });
      acct.set({ value: 'Windows only', reason: a.digitalLicenceWhy || null });
    }
    update();
    return { update, dispose() {} };
  }

  function renderTroubleshoot(el, kit) {
    const t = kit.status({ row: 'system.troubleshoot.others', label: 'Troubleshooters', value: 'Reading…' });
    const net = kit.button({ row: 'system.troubleshoot.networkReset', label: 'Network reset', admin: 'reset every network adapter',
      help: 'Removes and reinstalls every network adapter and sets networking back to Windows\' defaults. VPN adapters are removed too. The PC must restart after',
      text: 'Reset now', tone: 'quiet', onClick: () => {
        if (!kit.test && !window.confirm('Reset every network adapter? VPN and virtual adapters are removed, and the PC must restart after.')) return { ok: false, reason: 'Cancelled; nothing changed.' };
        return A(kit, 'system.networkReset', {});
      } });
    el.append(kit.group('Troubleshoot'), kit.card(t, net));
    async function update() {
      const r = await R(kit, 'recovery');
      t.set(r && r.ok ? { value: 'Windows only', tone: 'info', reason: r.troubleshooters.why } : { value: fail('Troubleshooters', r), tone: 'warn' });
    }
    update();
    return { update, dispose() {} };
  }

  function renderRecovery(el, kit) {
    const re = kit.status({ row: 'system.recovery.re', label: 'Windows Recovery Environment', value: 'Reading…' });
    const adv = kit.button({ row: 'system.recovery.advanced', label: 'Advanced start-up', help: 'Restart now into the boot options menu (start from a USB drive, change firmware settings, start-up settings, System Restore)',
      text: 'Restart now', tone: 'quiet', onClick: () => {
        if (!kit.test && !window.confirm('Restart the PC now into the boot options menu? Save your work first: open apps are closed.')) return { ok: false, reason: 'Cancelled; nothing changed.' };
        return W(kit, 'advancedStartup', {});
      } });
    const reset = kit.status({ row: 'system.recovery.reset', label: 'Reset this PC', value: 'Windows only' });
    const back = kit.status({ row: 'system.recovery.goBack', label: 'Go back', value: 'Reading…' });
    const fix = kit.status({ row: 'system.recovery.fix', label: 'Fix problems using Windows Update', value: 'Windows only' });
    el.append(kit.group('Recovery options'), kit.card(re, adv, reset, back, fix));
    async function update() {
      const r = await R(kit, 'recovery');
      if (!r || !r.ok) { re.set({ value: fail('Recovery', r), tone: 'warn' }); return; }
      re.set({ value: r.windowsRE ? onoff(r.windowsRE === 'on') : 'Unknown', tone: r.windowsRE === 'on' ? 'ok' : 'warn', reason: r.windowsREWhy });
      adv.set({ disabled: !r.advancedStartup.writable, reason: r.advancedStartup.why });
      reset.set({ reason: r.reset.why, tone: 'info' });
      back.set({ value: r.goBack.available ? 'Available (Windows only)' : 'Not available', reason: r.goBack.why, tone: 'info' });
      fix.set({ reason: r.fixWithUpdate.why, tone: 'info' });
    }
    update();
    return { update, dispose() {} };
  }

  /* ---------------------------------------------------------------- Display
     Brightness and night light on/off are the bar's own (qs.get / qs.set, Display.cs); everything else
     is SysDisplay.cs through settings.system.*. A resolution, refresh, orientation, layout, main-display
     or arrangement change is KEPT OR PUT BACK BY THE SIDECAR's own timer (the screen may be black, the
     page hidden): this page only shows the countdown and the two buttons, from the change's answer, the
     `settings.system.display` events and sysdisplay.get's `pending`. */
  const ORIENT = [{ value: 'landscape', label: 'Landscape' }, { value: 'portrait', label: 'Portrait' },
    { value: 'landscape-flipped', label: 'Landscape (flipped)' }, { value: 'portrait-flipped', label: 'Portrait (flipped)' }];
  const TOPO = { extend: 'Extend these displays', clone: 'Duplicate these displays', internal: 'Show only on the built-in display', external: 'Show only on the external display', custom: 'A custom layout' };
  const PREF = ['Let Windows decide', 'Power saving', 'High performance'];
  const GLOBAL = [
    ['SwapEffectUpgradeEnable', 'windowed', 'Optimizations for windowed games', 'Lower latency, and VRR and Auto HDR in windowed DirectX 10 and 11 games'],
    ['VRROptimizeEnable', 'vrr', 'Variable refresh rate', 'Games that do not support VRR use it anyway, on displays that have it'],
    ['AutoHDREnable', 'autoHdr', 'Auto HDR', 'DirectX 11 and 12 games are shown in HDR on an HDR display'],
  ];
  const POS = [{ value: 'right', label: 'Right of the main display' }, { value: 'left', label: 'Left of the main display' },
    { value: 'above', label: 'Above the main display' }, { value: 'below', label: 'Below the main display' }];
  const KIND = { mode: 'resolution, refresh rate and orientation', topology: 'display layout', primary: 'main display', arrange: 'display arrangement' };
  const ENDED = { timeout: 'It was not kept in time, so the previous settings are back', asked: 'You chose Revert', exit:'Mantle closed before it was kept, so the previous settings are back' };
  const hzText = (hz) => `${Math.round(hz * 100) / 100} Hz`;
  const sfx = (i) => (i === 0 ? '' : `.${i + 1}`);
  const hh = (h) => `${String(h).padStart(2, '0')}:00`;
  /* 01:00-23:00 only: minutes and midnight are a layout of the night light settings not measured on
     this PC (SysDisplay.cs PlanNight refuses them), so they are not offered. */
  const hourOpts = (cur) => {
    const l = Array.from({ length: 23 }, (_, i) => ({ value: hh(i + 1), label: hh(i + 1) }));
    if (cur && !l.some((x) => x.value === cur)) l.unshift({ value: cur, label: `${cur} (set outside Mantle)` });
    return l;
  };
  const appLabel = (app) => { const s = String(app || ''); const b = s.split(/[\\/]/).pop(); return s.includes('!') && !/[\\/]/.test(s) ? s.split('_')[0].split('.').pop() || s : b || s; };
  /** Where display `d` sits next to the main display `p` (bounds are physical pixels). */
  function relPos(d, p) {
    const a = d.bounds, b = p.bounds;
    if (!a || !b) return null;
    if (a.x === b.x + b.width && a.y === b.y) return 'right';
    if (a.x + a.width === b.x && a.y === b.y) return 'left';
    if (a.y + a.height === b.y && a.x === b.x) return 'above';
    if (a.y === b.y + b.height && a.x === b.x) return 'below';
    return 'custom';
  }
  function place(where, a, b) {
    if (where === 'right') return { x: b.x + b.width, y: b.y };
    if (where === 'left') return { x: b.x - a.width, y: b.y };
    if (where === 'above') return { x: b.x, y: b.y - a.height };
    return { x: b.x, y: b.y + b.height };
  }

  function renderDisplay(el, kit) {
    const S = { pending: null, list: [], cards: [], shownLeft: null };
    const h = kit.h;

    /* -- keep or revert (hidden until a change waits) */
    const cd = kit.status({ row: 'system.display.keep', label: 'Keep these display settings?', value: '', tone: 'warn', icon: 'display' });
    const keepB = kit.button({ row: 'system.display.keep.yes', label: 'Keep the new settings', text: 'Keep changes', tone: 'acc', onClick: () => keepOrRevert(true) });
    const revB = kit.button({ row: 'system.display.keep.no', label: 'Go back to the previous settings now', text: 'Revert', onClick: () => keepOrRevert(false) });
    const keepWrap = h('div', {}, kit.group('Display change'), kit.card(cd, keepB, revB));
    keepWrap.style.display = 'none';

    /* -- brightness and colour */
    const bright = kit.slider({ row: 'display.brightness', label: 'Brightness', icon: 'brightness', min: 0, max: 100, step: 1, unit: '%',
      help: 'The built-in screen\'s backlight', onInput: (v) => { if (!kit.test) live(v); }, onChange: (v) => setQs('brightness', v, (s) => s.level) });
    const night = kit.toggle({ row: 'display.nightlight', label: 'Night light', icon: 'moon', help: 'Warmer colours to help you sleep',
      onChange: (on) => setQs('nightlight', on, (s) => !!s.on) });
    const nSched = kit.choice({ row: 'system.display.nightlight.schedule', label: 'Schedule night light', style: 'segmented',
      options: [{ value: 'off', label: 'Off' }, { value: 'sunset', label: 'Sunset to sunrise' }, { value: 'hours', label: 'Set hours' }],
      onChange: (v) => W(kit, 'nightlightSet', { schedule: v }, (r) => (r.after && r.after.schedule ? r.after.schedule.value : v)) });
    const nFrom = kit.choice({ row: 'system.display.nightlight.from', label: 'Turn on', style: 'dropdown', options: hourOpts(null), help: 'Whole hours, 01:00 to 23:00',
      onChange: (v) => W(kit, 'nightlightSet', { from: v }, (r) => (r.after && r.after.from ? r.after.from.text : v)) });
    const nTo = kit.choice({ row: 'system.display.nightlight.to', label: 'Turn off', style: 'dropdown', options: hourOpts(null), help: 'Whole hours, 01:00 to 23:00',
      onChange: (v) => W(kit, 'nightlightSet', { to: v }, (r) => (r.after && r.after.to ? r.after.to.text : v)) });
    const nStr = kit.slider({ row: 'system.display.nightlight.strength', label: 'Strength', min: 0, max: 100, step: 1, unit: '%',
      onChange: (v) => W(kit, 'nightlightSet', { strength: v }, (r) => (r.after && r.after.strength ? r.after.strength.percent : v)) });

    /* -- the displays */
    const topo = kit.choice({ row: 'system.display.topology', label: 'Multiple displays', help: 'What Win+P switches between', style: 'dropdown', options: [],
      onChange: (m) => pend(W(kit, 'topology', { mode: m }), 'topology') });
    const monGroup = kit.group('Displays', { row: 'display.monitors' });
    const monBox = h('div', {});
    const mapRow = h('div', { class: 'row' });
    const arrGroup = kit.group('Arrangement', { row: 'system.display.arrange', aside: 'The main display sits at the top left' });
    const arrCard = kit.card(mapRow);
    const custom = kit.status({ row: 'system.display.customScale', label: 'Custom scaling', value: 'Reading…', tone: 'info' });

    /* -- graphics */
    const G = {};
    for (const [key, id, label, help] of GLOBAL) {
      G[key] = kit.toggle({ row: `system.display.gpu.${id}`, label, help,
        onChange: (on) => W(kit, 'gpuGlobalSet', { key, on }, (r) => ('on' in r ? r.on : on)) });
    }
    const hags = kit.toggle({ row: 'system.display.gpu.scheduling', label: 'Hardware-accelerated GPU scheduling', help: 'The graphics card schedules its own work; takes effect after a restart',
      onChange: async (on) => {
        const r = await W(kit, 'gpuSchedulingSet', { on });
        if (r && r.ok === false && r.needsAdmin && r.elevate === 'sysdisplay.gpuScheduling') {
          const a = await A(kit, 'sysdisplay.gpuScheduling', { on });
          return a && a.ok && !a.dryRun ? { ok: true, value: 'on' in a ? a.on : on, note: a.note } : a;
        }
        return r && r.ok && !r.dryRun ? { ok: true, value: 'on' in r ? r.on : on, note: r.note } : r;
      } });
    const apps = kit.list({ row: 'system.display.gpu.apps', items: [], empty: 'Reading the apps with their own graphics setting…',
      onAction: (key, act, it) => W(kit, 'gpuPrefSet', { app: it.app, pref: Number(act) }).then((r) => { if (r && r.ok && !r.dryRun) readGpu(); return r; }) });
    const addApp = kit.text({ row: 'system.display.gpu.add', label: 'Add an app', help: 'The full path of its .exe; it starts on "Let Windows decide"', placeholder: 'C:\\Games\\game.exe',
      onChange: (s) => {
        const app = String(s || '').trim();
        if (!app) return { ok: true, value: '' };
        return W(kit, 'gpuPrefSet', { app, pref: 0 }).then((r) => { if (r && r.ok && !r.dryRun) { readGpu(); return { ok: true, value: '' }; } return r; });
      } });
    const gpus = kit.list({ row: 'system.display.gpu.adapters', items: [], empty: 'Reading the graphics adapters…' });

    const errBox = h('div', {});
    el.append(
      errBox, keepWrap,
      kit.group('Brightness & colour'), kit.card(bright, night),
      kit.group('Night light schedule', { row: 'system.display.nightlight' }), kit.card(nSched, nFrom, nTo, nStr),
      monGroup, kit.card(topo, custom), monBox,
      arrGroup, arrCard,
      kit.group('Graphics', { row: 'system.display.gpu' }), kit.card(hags, ...GLOBAL.map(([k]) => G[k])),
      kit.group('Custom options for apps'), kit.card(apps, addApp),
      kit.group('Graphics adapters'), kit.card(gpus));

    /* ---- brightness / night light through the bar's own backend */
    function setQs(part, value, pick) {
      if (kit.test) return { ok: true, dryRun: true, reason: `test run: ${part === 'brightness' ? `the brightness was not changed (would set ${value}%)` : `night light was not turned ${value ? 'on' : 'off'}`}` };
      return kit.call('qs.set', { part, value }).then((r) => (r.ok === false ? r : { ok: true, value: r.state && typeof r.state === 'object' ? pick(r.state) : value }));
    }
    const L = { want: null, busy: false };
    function live(v) {       // a dragged slider: one set at a time, the newest value waits for the reply
      L.want = v;
      if (L.busy) return;
      const go = () => { const w = L.want; L.want = null; L.busy = true; kit.call('qs.set', { part: 'brightness', value: w }).then(() => { L.busy = false; if (L.want !== null && !kit.disposed) go(); }); };
      go();
    }
    function fillQs(q) {
      if (!q || typeof q !== 'object') return;
      const b = q.brightness, n = q.nightlight;
      if (q.ok === false && !b) { bright.set({ disabled: true, reason: fail('The brightness', q) }); night.set({ disabled: true, reason: fail('Night light', q) }); return; }
      if (b) {
        if (b.ok === false) bright.set({ disabled: true, reason: b.reason || 'The brightness could not be read' });
        else if (b.present === false) bright.set({ value: null, disabled: true, reason: b.reason || 'This display does not expose its brightness to Windows' });
        else bright.set({ value: b.level, disabled: false, reason: null });
      }
      if (n) {
        if (n.ok === false) night.set({ disabled: true, reason: n.reason || 'Night light could not be read' });
        else if (n.present === false) night.set({ value: false, disabled: true, reason: n.reason || 'Night light is not set up on this PC' });
        else night.set({ value: !!n.on, disabled: false, reason: null });
      }
    }

    /* ---- night light schedule and strength (SysDisplay.cs, the settings blob) */
    function fillNight(n) {
      const rows = [nSched, nFrom, nTo, nStr];
      if (!n || !n.ok) { rows.forEach((c) => c.set({ disabled: true, reason: fail('The night light schedule', n) })); return; }
      if (n.present === false) { rows.forEach((c) => c.set({ disabled: true, reason: n.reason || 'Windows has no night light settings yet' })); return; }
      const w = n.writable || {};
      const ro = (ok, own) => (ok ? null : `Read only here: ${own || w.why || n.reason || 'Mantle cannot write this safely'}`);
      const sch = n.schedule && n.schedule.value;
      const sun = n.sunset && n.sunset.text && n.sunrise && n.sunrise.text ? `Sunset ${n.sunset.text}, sunrise ${n.sunrise.text}` : null;
      // the layout measured on this PC (w.hours): say per row what is missing, not the whole rule twice
      const measured = !!w.hours;
      nSched.set({ value: sch || 'off', disabled: !w.schedule,
        reason: ro(w.schedule, measured ? 'switching the schedule adds or removes a field this PC\'s night light settings have never held, and Mantle only writes the layout it measured' : null),
        info: sch === 'sunset' ? (sun || 'Windows works the times out from your location') : null });
      const hoursInfo = sch === 'hours' ? null : 'Used when the schedule is "Set hours"';
      const from = n.from && n.from.text, to = n.to && n.to.text;
      nFrom.set({ value: from, options: hourOpts(from), disabled: !w.hours, reason: ro(w.hours), info: from ? hoursInfo : 'Not set in Windows\' night light settings' });
      nTo.set({ value: to, options: hourOpts(to), disabled: !w.hours, reason: ro(w.hours), info: to ? hoursInfo : 'Not set in Windows\' night light settings' });
      const st = n.strength || {};
      const noStr = measured && st.percent == null;
      nStr.set({ value: st.percent == null ? null : st.percent, disabled: !w.strength,
        reason: ro(w.strength, noStr ? 'Windows has not stored a strength on this PC yet (it uses its default), and adding one is a layout Mantle has not measured' : null),
        info: noStr ? null : st.reason || null });
    }

    /* ---- the displays */
    function mkCard(i) {
      const s = sfx(i);
      const C = { i };
      C.head = kit.status({ row: `display.monitor.${i}`, label: `Display ${i + 1}`, value: 'Reading…', icon: 'display' });
      C.res = kit.choice({ row: `system.display.resolution${s}`, label: 'Display resolution', style: 'dropdown', options: [],
        onChange: (v) => { const [w, hgt] = String(v).split('x').map(Number); return pend(W(kit, 'displayMode', { display: C.d.display, width: w, height: hgt }), 'mode'); } });
      C.hz = kit.choice({ row: `system.display.refresh${s}`, label: 'Refresh rate', help: 'A higher rate is smoother but uses more power', style: 'dropdown', options: [],
        onChange: (v) => pend(W(kit, 'displayMode', { display: C.d.display, width: C.d.resolution.width, height: C.d.resolution.height, hz: v }), 'mode') });
      C.orient = kit.choice({ row: `system.display.orientation${s}`, label: 'Display orientation', style: 'dropdown', options: ORIENT,
        onChange: (v) => { const a = { display: C.d.display, width: C.d.resolution.width, height: C.d.resolution.height, orientation: v }; if (C.curHz) a.hz = C.curHz; return pend(W(kit, 'displayMode', a), 'mode'); } });
      C.scale = kit.choice({ row: `system.display.scale${s}`, label: 'Scale', help: 'The size of text, apps and other items', style: 'dropdown', options: [],
        onChange: (v) => W(kit, 'scale', { display: C.d.display, percent: v }, (r) => ('percent' in r ? r.percent : v)) });
      C.hdr = kit.toggle({ row: `system.display.hdr${s}`, label: 'Use HDR', help: 'Brighter, more vivid picture in HDR games and videos',
        onChange: (on) => W(kit, 'hdr', { display: C.d.display, on }, (r) => ('on' in r ? r.on : on)) });
      C.primary = kit.button({ row: `system.display.primary${s}`, label: 'Make this my main display', text: 'Make main',
        onClick: () => pend(W(kit, 'primary', { display: C.d.display }), 'primary') });
      C.pos = kit.choice({ row: `system.display.position${s}`, label: 'Position', style: 'dropdown', options: POS,
        onChange: (v) => { const p = C.main; if (!p || !p.bounds) return { ok: false, reason: 'The main display\'s position is not known yet' }; const at = place(v, C.d.bounds, p.bounds); return pend(W(kit, 'arrange', { positions: [{ display: C.d.display, x: at.x, y: at.y }] }), 'arrange'); } });
      C.card = kit.card(C.head, C.res, C.hz, C.orient, C.scale, C.hdr, C.primary, C.pos);
      return C;
    }
    function ensureCards(n) {
      while (S.cards.length < Math.max(1, n)) { const C = mkCard(S.cards.length); S.cards.push(C); monBox.append(C.card); }
      while (S.cards.length > Math.max(1, n)) S.cards.pop().card.remove();
    }
    ensureCards(1);

    function fillCard(C, d, main, count) {
      C.d = d; C.main = main;
      const on = !!(d.active && d.resolution);
      const off = on ? null : (d.reason || 'This display is connected but not in use');
      C.head.set({ label: d.name || `Display ${C.i + 1}`,
        help: [d.primary ? 'Main display' : null, d.kind === 'internal' ? 'Built-in' : 'External', d.kind === 'internal' ? null : d.connector].filter(Boolean).join(' · '),
        value: on ? `${d.resolution.width} × ${d.resolution.height}${d.refreshHz ? ` · ${hzText(d.refreshHz)}` : ''}` : 'Not in use', tone: on ? 'ok' : 'info',
        info: d.nameReason || null, reason: on ? null : off });
      const modes = Array.isArray(d.modes) ? d.modes : [];
      const nat = d.native || null;
      const isNat = (m) => m.native || (nat && m.width === nat.width && m.height === nat.height);
      // resolutions: one entry per size, largest first; the native one is Windows' "Recommended"
      const sizes = [];
      for (const m of modes) if (!sizes.some((x) => x.width === m.width && x.height === m.height)) sizes.push(m);
      sizes.sort((a, b) => b.width * b.height - a.width * a.height || b.width - a.width);
      const curKey = on ? `${d.resolution.width}x${d.resolution.height}` : null;
      const resOpts = sizes.map((m) => ({ value: `${m.width}x${m.height}`, label: `${m.width} × ${m.height}${isNat(m) ? ' (Recommended)' : ''}` }));
      if (curKey && !resOpts.some((x) => x.value === curKey)) resOpts.unshift({ value: curKey, label: `${d.resolution.width} × ${d.resolution.height} (not in Windows' list)` });
      const noModes = on && !modes.length ? (d.modesReason || 'Windows listed no modes for this display') : null;
      C.res.set({ options: resOpts, value: curKey, disabled: !on || !!noModes, reason: off || noModes, info: nat || !on ? null : (d.nativeReason || null) });
      // refresh rates at the current size, highest first
      const rates = on ? [...new Set(modes.filter((m) => m.width === d.resolution.width && m.height === d.resolution.height).map((m) => m.hz))].sort((a, b) => b - a) : [];
      const cur = on && d.refreshHz ? rates.reduce((best, r) => (best == null || Math.abs(r - d.refreshHz) < Math.abs(best - d.refreshHz) ? r : best), null) : null;
      C.curHz = cur != null && Math.abs(cur - d.refreshHz) < 1 ? cur : null;
      const hzOpts = rates.map((r) => ({ value: r, label: hzText(r) }));
      if (on && d.refreshHz && C.curHz == null) hzOpts.unshift({ value: d.refreshHz, label: `${hzText(d.refreshHz)} (not in Windows' list)` });
      C.hz.set({ options: hzOpts, value: C.curHz != null ? C.curHz : on ? d.refreshHz : null, disabled: !on || rates.length < 1 || !!noModes,
        reason: off || noModes, info: on && rates.length === 1 ? 'This is the only rate Windows offers at this resolution' : null });
      C.orient.set({ value: d.orientation || 'landscape', disabled: !on, reason: off });
      const sc = d.scale || {};
      const allowed = Array.isArray(sc.allowed) ? sc.allowed : [];
      const scOpts = allowed.map((p) => ({ value: p, label: `${p}%${p === sc.recommended ? ' (Recommended)' : ''}` }));
      if (sc.percent != null && !allowed.includes(sc.percent)) scOpts.unshift({ value: sc.percent, label: `${sc.percent}%` });
      C.scale.set({ options: scOpts, value: sc.percent, disabled: !on || sc.percent == null || !allowed.length, reason: off || sc.reason || (sc.percent == null ? 'Windows did not report this display\'s scale' : null) });
      const hd = d.hdr || {};
      const hdrWhy = hd.reason || (hd.supported === false ? 'this display does not report HDR support to Windows' : hd.supported == null ? 'Windows did not say whether this display supports HDR' : null);
      C.hdr.set({ value: !!hd.enabled, disabled: !on || !hd.writable, reason: off || (hd.writable ? (hd.limitedByPolicy ? hdrWhy : null) : `Read only here: ${hdrWhy || 'Windows will not switch HDR on this display'}`),
        info: on && hd.writable && hd.enabled && hd.sdrWhiteNits ? `SDR content brightness: ${hd.sdrWhiteNits} nits` : null });
      C.primary.set({ disabled: !on || !!d.primary, text: d.primary ? 'Main display' : 'Make main', reason: off,
        info: d.primary ? (count > 1 ? 'This is your main display: the taskbar and new windows open here' : 'The only display in use is always the main one') : null });
      const showPos = on && !d.primary && main && main.bounds;
      C.pos.el.style.display = showPos ? '' : 'none';
      if (showPos) {
        const where = relPos(d, main);
        const opts = POS.slice();
        if (where === 'custom') opts.unshift({ value: 'custom', label: `Where it is now (${d.bounds.x}, ${d.bounds.y})` });
        C.pos.set({ options: opts, value: where, disabled: false, reason: null });
      }
    }

    function drawMap(list) {
      const act = list.filter((d) => d.active && d.bounds);
      if (act.length < 2) {
        mapRow.replaceChildren(kit.reason(act.length ? 'Only one display is in use, so there is nothing to arrange' : 'Windows did not report where the displays are', { info: !!act.length }));
        return;
      }
      const minX = Math.min(...act.map((d) => d.bounds.x)), minY = Math.min(...act.map((d) => d.bounds.y));
      const maxX = Math.max(...act.map((d) => d.bounds.x + d.bounds.width)), maxY = Math.max(...act.map((d) => d.bounds.y + d.bounds.height));
      const W0 = 360, H0 = 120, k = Math.min(W0 / (maxX - minX), H0 / (maxY - minY));
      const box = h('div', {});
      Object.assign(box.style, { position: 'relative', width: `${Math.round((maxX - minX) * k)}px`, height: `${Math.round((maxY - minY) * k)}px`, margin: '6px auto' });
      list.forEach((d, i) => {
        if (!d.active || !d.bounds) return;
        const b = h('div', { title: d.name || `Display ${i + 1}` }, String(i + 1));
        Object.assign(b.style, { position: 'absolute', boxSizing: 'border-box', left: `${Math.round((d.bounds.x - minX) * k) + 2}px`, top: `${Math.round((d.bounds.y - minY) * k) + 2}px`,
          width: `${Math.round(d.bounds.width * k) - 4}px`, height: `${Math.round(d.bounds.height * k) - 4}px`, display: 'flex', alignItems: 'center', justifyContent: 'center',
          borderRadius: 'var(--lg-r-ctl)', border: '1px solid var(--lg-edge-out)', background: d.primary ? 'var(--lg-acc-soft)' : 'var(--lg-fill-strong)',
          color: 'var(--lg-ink)', font: '600 15px/1 inherit' });
        box.append(b);
      });
      mapRow.replaceChildren(box);
    }

    function fillDisplays(r, t0) {
      if (!r || !r.ok) {
        const why = fail('The displays', r);
        ensureCards(1);
        S.cards[0].head.set({ value: 'Not read', tone: 'warn', reason: why });
        for (const k of ['res', 'hz', 'orient', 'scale', 'hdr', 'primary', 'pos']) S.cards[0][k].set({ disabled: true, reason: why });
        topo.set({ disabled: true, reason: why });
        custom.set({ value: 'Not read', tone: 'warn', reason: why });
        mapRow.replaceChildren(kit.reason(why));
        return;
      }
      const list = (Array.isArray(r.displays) ? r.displays : []).slice().sort((a, b) => (+!!b.primary - +!!a.primary) || (+!!b.active - +!!a.active));
      S.list = list;
      const main = list.find((d) => d.primary && d.active) || null;
      ensureCards(list.length);
      list.forEach((d, i) => fillCard(S.cards[i], d, main, list.filter((x) => x.active).length));
      if (!list.length) S.cards[0].head.set({ value: 'None', tone: 'warn', reason: 'Windows reported no displays' });
      monGroup.replaceChildren('Displays', h('span', { class: 'aside' }, `${list.length} display${list.length === 1 ? '' : 's'}`));
      // extend / duplicate / only one: the layouts Windows validated just now (SDC_VALIDATE changes nothing)
      const t = r.topology || {};
      const avail = Array.isArray(t.available) ? t.available : [];
      const opts = avail.map((m) => ({ value: m, label: TOPO[m] || m }));
      if (t.current && !avail.includes(t.current)) opts.unshift({ value: t.current, label: TOPO[t.current] || t.current });
      const no = Object.entries(t.unavailable || {}).map(([m, why]) => `${TOPO[m] || m}: ${why}`);
      const single = list.filter((d) => d.active || d.available !== false).length < 2;
      topo.set({ options: opts, value: t.current, disabled: opts.length < 2 || !t.current,
        reason: t.reason || (opts.length < 2 ? `Read only here: ${single ? 'only one display is connected, so there is no other layout' : 'Windows validated no other layout'}${no.length ? ` (${no.join('; ')})` : ''}` : null),
        info: r.inactiveReason || null });
      const cs = r.customScale || {};
      custom.set(cs.on == null && cs.reason ? { value: 'Not read', tone: 'warn', reason: cs.reason }
        : { value: cs.on ? `On: ${cs.percent}%` : 'Off', tone: cs.on ? 'warn' : 'info', reason: null, info: cs.writable === false ? `Read only here: ${cs.why || 'Mantle does not set it'}` : null });
      drawMap(list);
      // a change waiting to be kept, as the sidecar holds it (the page may have been closed meanwhile)
      if (r.pending && r.pending.token) { if (!S.pending || S.pending.token !== r.pending.token) setPending(r.pending.token, r.pending.kind, r.pending.revertsInMs); }
      else if (S.pending && S.pending.at < t0) finish('ended', { why: 'gone' });
    }

    /* ---- keep or revert */
    /** A layout/mode change's answer: a real one starts the countdown (the kit keeps the new value). */
    function pend(p, kind) {
      return Promise.resolve(p).then((r) => {
        if (r && r.ok && !r.dryRun) {
          if (r.pending && r.token) setPending(r.token, kind, r.keepWithinMs);
          setTimeout(update, 50);
          return { ok: true };
        }
        return r;
      });
    }
    function setPending(token, kind, ms) {
      S.pending = { token, kind, until: Date.now() + (typeof ms === 'number' ? ms : 15000), at: Date.now() };
      S.shownLeft = null;
      keepWrap.style.display = '';
      keepB.el.style.display = ''; revB.el.style.display = '';
      keepB.set({ disabled: false }); revB.set({ disabled: false });
      cd.set({ label: 'Keep these display settings?', tone: 'warn', reason: null, info: null });
      tick();
    }
    function tick() {
      const p = S.pending;
      if (!p) return;
      const left = Math.max(0, Math.ceil((p.until - Date.now()) / 1000));
      if (left === S.shownLeft) return;
      S.shownLeft = left;
      cd.set({ value: left > 0 ? `Going back in ${left} s` : 'Going back…', help: `The new ${KIND[p.kind] || 'display settings'} go back by themselves unless you keep them` });
    }
    function finish(what, ev) {
      S.pending = null;
      keepB.el.style.display = 'none'; revB.el.style.display = 'none';
      keepWrap.style.display = '';
      const failed = ev && ev.ok === false;
      const kind = KIND[ev && ev.kind] || 'display settings';
      if (what === 'kept') cd.set({ label: 'Display change', value: failed ? 'Not saved' : 'Kept', tone: failed ? 'warn' : 'ok', help: `The new ${kind} stay`, reason: failed ? (ev.reason || 'saving it failed, and no reason came back') : null, info: null });
      else if (what === 'reverted') cd.set({ label: 'Display change', value: failed ? 'Not put back' : 'Put back', tone: failed ? 'warn' : 'info', help: `The previous ${kind}`,
        reason: failed ? (ev.reason || 'putting it back failed, and no reason came back') : null, info: failed ? null : (ENDED[ev && ev.why] || `Put back (${(ev && ev.why) || 'no reason came back'})`) });
      else cd.set({ label: 'Display change', value: 'No longer waiting', tone: 'info', help: null, reason: null, info: 'Windows reports no change waiting any more: it was kept or put back while this page was not listening. The values below are what Windows has now' });
      setTimeout(update, 50);
    }
    function keepOrRevert(keep) {
      const p = S.pending;
      if (!p) return { ok: false, reason: 'No display change is waiting any more' };
      return W(kit, keep ? 'displayKeep' : 'displayRevert', { token: p.token }).then((r) => {
        if (r && r.ok && !r.dryRun && S.pending && S.pending.token === p.token) finish(keep ? 'kept' : 'reverted', { why: 'asked', ok: true, kind: p.kind });
        return r;
      });
    }
    kit.watch('settings.system.display', (ev) => {
      if (!ev || typeof ev !== 'object') return;
      if (ev.what === 'pending' && ev.token) { if (!S.pending || S.pending.token !== ev.token) setPending(ev.token, ev.kind, ev.keepWithinMs); return; }
      if ((ev.what === 'kept' || ev.what === 'reverted') && (!S.pending || S.pending.token === ev.token)) finish(ev.what, ev);
    });
    kit.every(250, tick);

    /* ---- graphics */
    function fillGpu(g) {
      if (!g || !g.ok) {
        const why = fail('The graphics settings', g);
        [hags, ...Object.values(G)].forEach((c) => c.set({ disabled: true, reason: why }));
        apps.set({ items: [], empty: why }); gpus.set({ items: [], empty: why }); addApp.set({ disabled: true, reason: why });
        return;
      }
      const gl = g.global || {};
      for (const [key] of GLOBAL) {
        const x = gl[key] || {};
        G[key].set({ value: !!x.on, disabled: false, reason: x.on == null && x.reason && !/^not set/.test(x.reason) ? x.reason : null, info: x.on == null ? 'Not set: Windows\' default applies' : null });
      }
      const s = g.gpuScheduling || {};
      const canTurnOff = s.on === true;         // turning it off is always allowed (SysDisplay.cs HagsSetCmd)
      hags.set({ value: !!s.on, disabled: !s.writable && !canTurnOff, admin: s.writable || canTurnOff ? 'turn hardware-accelerated GPU scheduling on or off' : undefined,
        reason: s.writable ? null : `${canTurnOff ? 'It is on in the registry, but ' : 'Read only here: '}${s.reason || 'Windows did not say whether the graphics driver supports it'}`,
        info: s.restartPending ? 'Changed, but it takes effect after a restart' : s.registryReason || null });
      apps.set({ empty: g.appsReason || 'No app has its own graphics setting', items: (Array.isArray(g.apps) ? g.apps : []).map((a, i) => ({
        key: `a${i}`, app: a.app, label: appLabel(a.app), help: a.app, mono: true, value: a.pref != null ? PREF[a.pref] : 'Unknown', reason: a.reason || null,
        actions: [0, 1, 2].filter((p) => p !== a.pref).map((p) => ({ id: String(p), text: PREF[p] })) })) });
      addApp.set({ disabled: false, reason: null });
      gpus.set({ empty: g.gpusReason || 'Windows reported no graphics adapters', items: (Array.isArray(g.gpus) ? g.gpus : []).map((x, i) => {
        const hs = x.gpuScheduling || {};
        return { key: `g${i}`, label: x.name || 'Graphics adapter', icon: 'display',
          help: [x.software ? 'Software (no hardware)' : x.hybrid === 'discrete' ? 'Discrete: high performance' : x.hybrid === 'integrated' ? 'Integrated: power saving' : null, x.displaySupported === false ? 'Renders only' : null].filter(Boolean).join(' · ') || null,
          value: hs.supported == null ? 'GPU scheduling: unknown' : hs.supported ? `GPU scheduling ${hs.enabled ? 'on' : 'off'}` : 'No GPU scheduling', reason: hs.supported == null ? (hs.reason || null) : null };
      }) });
    }
    async function readGpu() { const g = await R(kit, 'gpu'); if (!kit.disposed) fillGpu(g); }

    let seq = 0;
    async function update() {
      const my = ++seq, t0 = Date.now();
      const [d, n, g, q] = await Promise.all([R(kit, 'display'), R(kit, 'nightlight'), R(kit, 'gpu'), kit.call('qs.get')]);
      if (kit.disposed || my !== seq) return;
      // one part that cannot be drawn must not take the rest of the page with it, and says so
      const bad = [];
      for (const [name, fn] of [['brightness', () => fillQs(q)], ['night light', () => fillNight(n)], ['displays', () => fillDisplays(d, t0)], ['graphics', () => fillGpu(g)]]) {
        try { fn(); } catch (e) { bad.push(`${name} (${(e && e.message) || e})`); }
      }
      errBox.replaceChildren(...(bad.length ? [kit.card(kit.reason(`Part of this page could not be drawn: ${bad.join('; ')}`))] : []));
    }
    kit.watch('qs', (q) => { try { fillQs(q); } catch (_) { /* the next full read reports it */ } });
    kit.every(15000, update);
    return update().then(() => ({ update, dispose() {} }));
  }

  /* ---------------------------------------------------------------- Sound (SysSound.cs, lane syssnd) */
  const SSTATE = { active: 'Ready', disabled: 'Disabled', unplugged: 'Not plugged in', notpresent: 'Not connected', unknown: 'Unknown' };
  const rowKey = (k) => String(k).replace(/[^A-Za-z0-9_.+-]/g, '-');
  const roText = (why) => `Read only here: ${why}`;

  function renderSound(el, kit) {
    const S = { d: null, out: null, in: null, sel: null, mic: false, bal: '', apps: new Map() };
    const h = kit.h;
    const noDev = (what) => ({ ok: false, reason: `No ${what} device is working, so there is nothing to change` });
    const later = (r) => { if (r && r.ok && !r.dryRun) setTimeout(update, 50); return r; };

    /* -- output and input (the defaults) */
    const out = kit.choice({ row: 'sound.output', label: 'Choose where to play sound', icon: 'sound', style: 'dropdown', options: [], help: 'The default for every app',
      onChange: (v) => W(kit, 'soundDefault', { device: v, role: 'default' }, (r) => r.device).then(later) });
    const vol = kit.slider({ row: 'sound.volume', label: 'Volume', icon: 'sound', min: 0, max: 100, step: 1, unit: '%',
      onChange: (v) => (S.out ? W(kit, 'soundLevel', { device: S.out.device, level: v }, (r) => r.level) : noDev('output')) });
    const mute = kit.toggle({ row: 'system.sound.mute', label: 'Mute', icon: 'mute', help: 'Silences the output device',
      onChange: (on) => (S.out ? W(kit, 'soundLevel', { device: S.out.device, muted: on }, (r) => r.muted) : noDev('output')) });
    const outComm = kit.choice({ row: 'system.sound.output.comms', label: 'Communications device', help: 'Where calls play', style: 'dropdown', options: [],
      onChange: (v) => W(kit, 'soundDefault', { device: v, role: 'communications' }, (r) => r.device).then(later) });
    const inp = kit.choice({ row: 'sound.input', label: 'Choose a device for speaking or recording', icon: 'mic', style: 'dropdown', options: [],
      onChange: (v) => W(kit, 'soundDefault', { device: v, role: 'default' }, (r) => r.device).then(later) });
    const inVol = kit.slider({ row: 'system.sound.input.volume', label: 'Input volume', icon: 'mic', min: 0, max: 100, step: 1, unit: '%',
      onChange: (v) => (S.in ? W(kit, 'soundLevel', { device: S.in.device, level: v }, (r) => r.level) : noDev('input')) });
    const inComm = kit.choice({ row: 'system.sound.input.comms', label: 'Communications microphone', help: 'What calls listen to', style: 'dropdown', options: [],
      onChange: (v) => W(kit, 'soundDefault', { device: v, role: 'communications' }, (r) => r.device).then(later) });
    const micBtn = kit.button({ row: 'system.sound.input.test', label: 'Test your microphone', help: 'Listens for 6 seconds and shows the level; nothing is recorded or kept', text: 'Start test', onClick: micTest });
    const micLvl = kit.status({ row: 'system.sound.input.level', label: 'Input level', value: 'Not listening', tone: 'info' });

    /* -- one device's properties */
    const pick = kit.choice({ row: 'system.sound.props', label: 'Device properties for', style: 'dropdown', options: [],
      onChange: (v) => { S.sel = v; fillProps(); return { ok: true, value: v }; } });
    const pName = kit.text({ row: 'system.sound.props.name', label: 'Name', placeholder: 'Speakers', onChange: (s) => prop('name', String(s || '').trim(), (r) => r.value) });
    const pState = kit.button({ row: 'system.sound.props.enable', label: 'Status', text: 'Disable', onClick: () => {
      const x = cur(); if (!x) return noDev('sound');
      return W(kit, 'soundEnable', { device: x.device, on: x.state === 'disabled' }).then(later);
    } });
    const pFmt = kit.choice({ row: 'system.sound.props.format', label: 'Format', help: 'Sample rate and bit depth Windows mixes to', style: 'dropdown', options: [],
      onChange: (v) => prop('format', v, (r) => (r.format ? r.format.value : v)) });
    const pEnh = kit.toggle({ row: 'system.sound.props.enhancements', label: 'Audio enhancements', help: 'The driver\'s own effects (Device Default Effects)', onChange: (on) => prop('enhancements', on, (r) => r.value) });
    const pSpat = kit.choice({ row: 'system.sound.props.spatial', label: 'Spatial sound', help: 'Sound that seems to come from around you', style: 'dropdown', options: [],
      onChange: (v) => prop('spatial', v, (r) => (r.current != null ? r.current : v)) });
    const pExcl = kit.toggle({ row: 'system.sound.props.exclusive', label: 'Let apps take exclusive control of this device', onChange: (on) => prop('exclusive', on, (r) => r.value) });
    const pExclP = kit.toggle({ row: 'system.sound.props.exclusivePriority', label: 'Give exclusive mode apps priority', onChange: (on) => prop('exclusivePriority', on, (r) => r.value) });
    const pTest = kit.button({ row: 'system.sound.props.test', label: 'Test sound', help: 'Plays a short tone on this device', text: 'Test', onClick: () => {
      const x = cur(); if (!x) return noDev('output');
      return W(kit, 'tone', { device: x.device }).then((r) => (r && r.ok && !r.dryRun ? { ok: true, info: 'Playing a short tone…' } : r));
    } });
    const pListen = kit.status({ row: 'system.sound.props.listen', label: 'Listen to this device', value: 'Read only', tone: 'info' });
    const balGroup = kit.group('Balance', { row: 'system.sound.props.balance', aside: 'Each channel\'s own level' });
    const balBox = h('div', {});
    const devs = kit.list({ row: 'system.sound.devices', items: [], empty: 'Reading the sound devices…', onAction: devAction });

    /* -- more sound settings */
    const mono = kit.toggle({ row: 'system.sound.mono', label: 'Mono audio', help: 'Combine the left and right channels into one', onChange: (on) => W(kit, 'soundSetting', { key: 'mono', value: on }, (r) => r.value) });
    const duck = kit.choice({ row: 'system.sound.ducking', label: 'When Windows detects communications activity', style: 'dropdown', options: [],
      onChange: (v) => W(kit, 'soundSetting', { key: 'ducking', value: Number(v) }, (r) => r.value) });

    /* -- volume mixer */
    const mixBox = h('div', {});
    const reset = kit.button({ row: 'system.sound.mixer.reset', label: 'Reset sound devices and volumes for all apps', help: 'Every app back to the default devices, at full volume', text: 'Reset',
      onClick: () => W(kit, 'resetApps', {}).then(later) });

    const errBox = h('div', {});
    el.append(errBox,
      kit.group('Output'), kit.card(out, vol, mute, outComm),
      kit.group('Input'), kit.card(inp, inVol, inComm, micBtn, micLvl),
      kit.group('Volume mixer', { row: 'sound.mixer' }), mixBox, kit.card(reset),
      kit.group('Sound devices', { row: 'system.sound.devices.all', aside: 'Every output and input Windows knows' }), kit.card(devs),
      kit.group('Properties'), kit.card(pick, pName, pState, pFmt, pEnh, pSpat, pExcl, pExclP, pTest, pListen),
      balGroup, balBox,
      kit.group('More sound settings'), kit.card(mono, duck));

    function cur() { return S.d ? S.d.all.find((x) => x.device === S.sel) || null : null; }
    async function prop(name, value, pick2) {
      const x = cur(); if (!x) return noDev('sound');
      const r = await W(kit, 'soundProps', { device: x.device, prop: name, value }, pick2);
      if (r && r.ok === false && r.needsAdmin && r.elevate === 'syssound.deviceProp') {
        const a = await A(kit, 'syssound.deviceProp', r.args || { device: x.device, prop: name, value });
        return later(a && a.ok && !a.dryRun ? { ok: true, value: pick2(a), note: a.note } : a);
      }
      return later(r);
    }
    const optsFor = (list) => list.filter((x) => x.state === 'active').map((x) => ({ value: x.device, label: x.name }));
    function fillFlow(list, defDev, commDev, ch, level, muteCtl, comm, what) {
      const act = list.filter((x) => x.state === 'active');
      const d = list.find((x) => x.device === defDev) || null;
      const none = act.length ? null : `No ${what} device is working: connect one, or enable one under Sound devices`;
      ch.set({ options: optsFor(list), value: d ? d.device : null, disabled: !act.length, reason: none });
      comm.set({ options: optsFor(list), value: commDev, disabled: !act.length, reason: none });
      const v = d && d.volume;
      if (!d || !v || v.level == null) level.set({ value: null, disabled: true, reason: none || (v && v.reason) || `The ${what} device has no volume Windows can change` });
      else level.set({ value: v.level, disabled: false, reason: null, info: v.muted && !muteCtl ? 'Muted' : null });
      if (muteCtl) muteCtl.set({ value: !!(v && v.muted), disabled: !v || v.level == null, reason: null });
      return d;
    }
    function fillDevices(d) {
      if (!d || !d.ok) {
        const why = fail('The sound devices', d);
        [out, vol, mute, outComm, inp, inVol, inComm, micBtn, pick, pName, pState, pFmt, pEnh, pSpat, pExcl, pExclP, pTest, mono, duck].forEach((c) => c.set({ disabled: true, reason: why }));
        devs.set({ items: [], empty: why }); balBox.replaceChildren();
        return;
      }
      const outs = (d.output && d.output.devices) || [], ins = (d.input && d.input.devices) || [];
      S.d = { raw: d, all: outs.concat(ins) };
      S.out = fillFlow(outs, d.output.defaultDevice, d.output.defaultComms, out, vol, mute, outComm, 'output');
      S.in = fillFlow(ins, d.input.defaultDevice, d.input.defaultComms, inp, inVol, null, inComm, 'input');
      if (!S.mic) micBtn.set({ disabled: !S.in, reason: S.in ? null : 'No microphone is working, so there is nothing to test' });
      devs.set({ empty: d.output.reason || d.input.reason || 'Windows reported no sound devices', items: S.d.all.map((x, i) => ({
        key: `d${i}`, device: x.device, label: x.name, icon: x.flow === 'output' ? 'sound' : 'mic', value: SSTATE[x.state] || x.state,
        help: [x.flow === 'output' ? 'Output' : 'Input', x.isDefault ? 'Default' : null, x.isDefaultComms ? 'Default for calls' : null].filter(Boolean).join(' · '),
        actions: [
          ...(x.state === 'active' && !x.isDefault ? [{ id: 'default', text: 'Make default' }] : []),
          ...(x.state === 'active' && !x.isDefaultComms ? [{ id: 'comms', text: 'Use for calls' }] : []),
          { id: x.state === 'disabled' ? 'enable' : 'disable', text: x.state === 'disabled' ? 'Enable' : 'Disable', disabled: x.state === 'notpresent', reason: x.state === 'notpresent' ? 'The device is not connected' : undefined },
          { id: 'props', text: 'Properties' }] })) });
      if (!S.d.all.some((x) => x.device === S.sel)) S.sel = S.out ? S.out.device : S.d.all.length ? S.d.all[0].device : null;
      pick.set({ options: S.d.all.map((x) => ({ value: x.device, label: `${x.flow === 'output' ? 'Output' : 'Input'}: ${x.name}` })), value: S.sel, disabled: !S.d.all.length, reason: S.d.all.length ? null : 'Windows reported no sound devices' });
      const adminWords = d.propsWritable === false ? 'change a sound device\'s properties' : undefined;
      [pName, pEnh, pExcl, pExclP].forEach((c) => c.set({ admin: adminWords }));
      mono.set({ value: !!(d.mono && d.mono.on), disabled: false, reason: null, info: d.mono && d.mono.note });
      const dk = d.ducking || {};
      duck.set({ options: (dk.options || []).map((o) => ({ value: o.value, label: o.label })), value: dk.value, disabled: !dk.options, reason: dk.options ? null : 'Windows did not report this setting', info: dk.set ? null : 'Not set: Windows\' default applies' });
      fillProps();
    }
    function fillProps() {
      const x = cur();
      const all = [pName, pState, pFmt, pEnh, pSpat, pExcl, pExclP, pTest, pListen];
      if (!x) { all.forEach((c) => c.set({ disabled: true, reason: 'Pick a device above' })); balBox.replaceChildren(); return; }
      const outDev = x.flow === 'output', active = x.state === 'active';
      pSpat.el.style.display = outDev ? '' : 'none'; pTest.el.style.display = outDev ? '' : 'none'; pListen.el.style.display = outDev ? 'none' : '';
      pName.set({ value: x.label || x.name, help: x.adapter ? `On ${x.adapter}` : null, disabled: false, reason: null });
      pState.set({ text: x.state === 'disabled' ? 'Enable' : 'Disable', help: SSTATE[x.state] || x.state, disabled: x.state === 'notpresent',
        reason: x.state === 'notpresent' ? 'The device is not connected' : null, info: x.isDefault && x.state === 'active' ? 'This is the default device: disabling it makes Windows pick another' : null });
      const fl = (x.formats || []).map((f) => ({ value: f.value, label: f.text }));
      if (x.format && !fl.some((f) => f.value === x.format.value)) fl.unshift({ value: x.format.value, label: x.format.text });
      pFmt.set({ options: fl, value: x.format ? x.format.value : null, disabled: !(x.formats || []).length,
        reason: (x.formats || []).length ? null : roText(x.formatsReason || x.formatReason || 'Windows did not list this device\'s formats'), info: x.format && x.format.float ? 'Floating point' : null });
      const en = x.enhancements || {};
      pEnh.set({ value: en.on !== false, disabled: false, reason: null, info: en.note || null });
      const sp = x.spatial || {};
      if (outDev) {
        const so = [{ value: '', label: 'Off' }].concat((sp.formats || []).map((f) => ({ value: f.subtype, label: f.name })));
        pSpat.set({ options: so, value: sp.current || '', disabled: !sp.writable, reason: sp.writable ? null : roText(sp.why || (active ? 'Windows did not report spatial sound for this device' : 'the device is not working right now')) });
        pTest.set({ disabled: !active, reason: active ? null : `The device is ${(SSTATE[x.state] || x.state).toLowerCase()}, so it cannot play` });
      }
      const ex = x.exclusive || {};
      pExcl.set({ value: ex.allow !== false, disabled: false, reason: null }); pExclP.set({ value: ex.priority !== false, disabled: !(ex.allow !== false), reason: ex.allow !== false ? null : 'Only matters while apps may take exclusive control' });
      const ls = (S.d.raw && S.d.raw.listen) || {};
      pListen.set({ value: 'Read only', reason: roText(ls.why || 'Windows keeps this where Mantle cannot write it') });
      const chs = (x.volume && x.volume.channels) || [];
      const sig = `${x.device}|${chs.length}`;
      if (sig !== S.bal) {
        S.bal = sig;
        S.balCtl = chs.map((c, i) => kit.slider({ row: `system.sound.props.balance.${i}`, label: c.name, min: 0, max: 100, step: 1, unit: '%',
          onChange: (v) => W(kit, 'soundLevel', { device: x.device, channel: i, level: v }, (r) => (Array.isArray(r.channels) ? r.channels[i] : v)) }));
        balBox.replaceChildren(kit.card(...(S.balCtl.length ? S.balCtl : [kit.reason(active ? 'Windows reported no channels for this device' : `The device is ${(SSTATE[x.state] || x.state).toLowerCase()}, so it has no levels right now`)])));
      }
      (S.balCtl || []).forEach((c, i) => c.set({ value: chs[i] ? chs[i].level : null, disabled: !active }));
    }
    function devAction(k, act, it) {
      const key = it && it.device;
      if (!key) return { ok: false, reason: 'That device is not in the list any more' };
      if (act === 'props') { S.sel = key; pick.set({ value: key }); fillProps(); kit.highlight('system.sound.props'); return { ok: true }; }
      if (act === 'default' || act === 'comms') return W(kit, 'soundDefault', { device: key, role: act === 'comms' ? 'communications' : 'default' }).then(later);
      return W(kit, 'soundEnable', { device: key, on: act === 'enable' }).then(later);
    }
    function micTest() {
      if (S.mic) return R(kit, 'micStop').then((r) => (r && r.ok ? { ok: true } : r));
      if (!S.in) return noDev('input');
      return W(kit, 'micTest', { device: S.in.device, ms: 6000 }).then((r) => {
        if (r && r.ok && !r.dryRun) { S.mic = true; micBtn.set({ text: 'Stop' }); micLvl.set({ value: 'Listening…', tone: 'info', reason: null, info: r.note || null }); }
        return r;
      });
    }
    kit.watch('settings.system.sound', (ev) => {
      if (!ev || typeof ev !== 'object') return;
      if (ev.what === 'mic') micLvl.set({ value: `${ev.peak}%`, tone: ev.peak > 4 ? 'ok' : 'info' });
      else if (ev.what === 'micDone') {
        S.mic = false; micBtn.set({ text: 'Start test' });
        micLvl.set({ value: ev.ok ? `Loudest ${ev.peakMax}%` : 'Test failed', tone: ev.ok && ev.peakMax > 4 ? 'ok' : 'warn', reason: ev.ok ? null : (ev.reason || 'the test ended without a reason'),
          info: ev.ok ? (ev.peakMax > 4 ? 'The microphone is picking up sound' : 'Nothing was heard: check the microphone is the right one and not muted') : null });
      } else if (ev.what === 'tone') pTest.set({ reason: ev.ok ? null : (ev.reason || 'the tone did not play, and no reason came back'), info: ev.ok ? 'Played' : null });
    });

    /* ---- the mixer */
    function mkApp(a) {
      const k = rowKey(a.app), C = {};
      C.level = kit.slider({ row: `sound.mixer.${k}`, label: a.name, min: 0, max: 100, step: 1, unit: '%', icon: 'sound',
        onChange: (v) => W(kit, 'appSet', { app: C.a.app, level: v }, (r) => r.level) });
      C.mute = kit.toggle({ row: `sound.mixer.${k}.mute`, label: 'Mute', onChange: (on) => W(kit, 'appSet', { app: C.a.app, muted: on }, (r) => r.muted) });
      C.out = kit.choice({ row: `sound.mixer.${k}.out`, label: 'Output device', style: 'dropdown', options: [],
        onChange: (v) => W(kit, 'appDevice', { app: C.a.app, flow: 'output', device: v }, (r) => r.device) });
      C.in = kit.choice({ row: `sound.mixer.${k}.in`, label: 'Input device', style: 'dropdown', options: [],
        onChange: (v) => W(kit, 'appDevice', { app: C.a.app, flow: 'input', device: v }, (r) => r.device) });
      C.card = kit.card(C.level, C.mute, C.out, C.in);
      return C;
    }
    function fillApps(a) {
      if (!a || !a.ok) { mixBox.replaceChildren(kit.card(kit.reason(fail('The volume mixer', a)))); S.apps.clear(); return; }
      const list = Array.isArray(a.apps) ? a.apps : [];
      if (!list.length) { mixBox.replaceChildren(kit.card(kit.reason('No app is playing sound right now: apps show up here while they have sound open', { info: true }))); S.apps.clear(); return; }
      const outs = S.d ? S.d.all.filter((x) => x.flow === 'output') : [], ins = S.d ? S.d.all.filter((x) => x.flow === 'input') : [];
      const devOpts = (l, def) => [{ value: '', label: `Default${def ? ` (${def.name})` : ''}` }].concat(optsFor(l));
      const seen = new Set();
      for (const x of list) {
        let C = S.apps.get(x.app);
        if (!C) { C = mkApp(x); S.apps.set(x.app, C); }
        C.a = x; seen.add(x.app);
        C.level.set({ label: x.name, value: x.level, help: [x.active ? 'Playing' : 'Not playing right now', x.muted ? 'Muted' : null].filter(Boolean).join(' · '), disabled: false, reason: null });
        C.mute.set({ value: !!x.muted });
        const ro = x.deviceWritable ? null : roText(x.deviceWhy || 'Windows did not say which device this app uses');
        C.out.set({ options: devOpts(outs, S.out), value: x.output == null ? '' : x.output, disabled: !x.deviceWritable, reason: ro });
        C.in.set({ options: devOpts(ins, S.in), value: x.input == null ? '' : x.input, disabled: !x.deviceWritable, reason: x.system ? null : ro });
        C.in.el.style.display = x.system ? 'none' : '';
      }
      for (const key of [...S.apps.keys()]) if (!seen.has(key)) S.apps.delete(key);
      mixBox.replaceChildren(...list.map((x) => S.apps.get(x.app).card));
    }

    let seq = 0;
    async function update() {
      const my = ++seq;
      const [d, a] = await Promise.all([R(kit, 'sound'), R(kit, 'apps')]);
      if (kit.disposed || my !== seq) return;
      const bad = [];
      for (const [name, fn] of [['devices', () => fillDevices(d)], ['mixer', () => fillApps(a)]]) {
        try { fn(); } catch (e) { bad.push(`${name} (${(e && e.message) || e})`); }
      }
      errBox.replaceChildren(...(bad.length ? [kit.card(kit.reason(`Part of this page could not be drawn: ${bad.join('; ')}`))] : []));
    }
    kit.every(5000, update);
    return update().then(() => ({ update, dispose() { if (S.mic) R(kit, 'micStop'); } }));
  }

  /* ---------------------------------------------------------------- Storage (backend pending) */
  function renderPending(what) {
    return function (el, kit) {
      el.append(kit.card(kit.reason(`${what} is being built: its backend has not landed in this Mantle yet.`)));
      return { dispose() {} };
    };
  }

  /* ---------------------------------------------------------------- the section */
  MantleSettings.section({
    id: 'system',
    title: 'System',
    group: 'windows',
    icon: 'display',
    order: 10,
    help: 'Display, sound, notifications, power, storage, multitasking, about',
    keywords: 'pc computer system settings',
    replaces: ['display', 'sound', 'notifications', 'power'],
    pages: [
      { id: 'display', title: 'Display', icon: 'display', help: 'Monitors, brightness, night light, scale, graphics',
        search: [
          { row: 'display.brightness', label: 'Brightness', keywords: 'screen brightness dim bright backlight' },
          { row: 'display.nightlight', label: 'Night light', keywords: 'blue light warm evening night mode colour color temperature', uri: 'ms-settings:nightlight' },
          { row: 'system.display.nightlight.schedule', label: 'Schedule night light', keywords: 'night light schedule sunset sunrise set hours turn on off' },
          { row: 'system.display.nightlight.strength', label: 'Night light strength', keywords: 'warmth warm colour temperature kelvin' },
          { row: 'display.monitors', label: 'Displays', keywords: 'monitor screen second display external', uri: 'ms-settings:display' },
          { row: 'system.display.topology', label: 'Multiple displays', keywords: 'extend duplicate mirror clone second screen projector win+p' },
          { row: 'system.display.resolution', label: 'Display resolution', keywords: 'resolution screen size pixels 1080p 1440p 4k' },
          { row: 'system.display.refresh', label: 'Refresh rate', keywords: 'hz refresh rate 60 120 144 165 fps smooth' },
          { row: 'system.display.orientation', label: 'Display orientation', keywords: 'rotate rotation portrait landscape flipped' },
          { row: 'system.display.scale', label: 'Scale', keywords: 'scaling dpi text size zoom 100 125 150' },
          { row: 'system.display.customScale', label: 'Custom scaling', keywords: 'custom scale dpi logpixels' },
          { row: 'system.display.hdr', label: 'Use HDR', keywords: 'hdr high dynamic range', uri: 'ms-settings:display-hdr' },
          { row: 'system.display.primary', label: 'Make this my main display', keywords: 'primary main display' },
          { row: 'system.display.arrange', label: 'Arrange displays', keywords: 'arrange position left right above below layout' },
          { row: 'system.display.gpu', label: 'Graphics', keywords: 'gpu graphics card video card', uri: 'ms-settings:display-advancedgraphics' },
          { row: 'system.display.gpu.apps', label: 'Graphics performance preference', keywords: 'gpu per app high performance power saving discrete integrated' },
          { row: 'system.display.gpu.scheduling', label: 'Hardware-accelerated GPU scheduling', keywords: 'hags gpu scheduling latency' },
          { row: 'system.display.gpu.windowed', label: 'Optimizations for windowed games', keywords: 'windowed games flip model latency' },
          { row: 'system.display.gpu.vrr', label: 'Variable refresh rate', keywords: 'vrr freesync g-sync adaptive sync' },
          { row: 'system.display.gpu.autoHdr', label: 'Auto HDR', keywords: 'auto hdr games' },
        ],
        render: renderDisplay },
      { id: 'sound', title: 'Sound', icon: 'sound', help: 'Volume, output and input devices, mixer, spatial sound',
        search: [
          { row: 'sound.output', label: 'Output device', keywords: 'speakers headphones playback default device audio output choose where to play sound', uri: 'ms-settings:sound' },
          { row: 'sound.volume', label: 'Volume', keywords: 'sound level loudness speaker master volume' },
          { row: 'system.sound.mute', label: 'Mute', keywords: 'mute silence sound off' },
          { row: 'system.sound.output.comms', label: 'Communications device', keywords: 'calls teams discord headset default communication device' },
          { row: 'sound.input', label: 'Input device', keywords: 'microphone mic recording input speaking', uri: 'ms-settings:sound-defaultinputproperties' },
          { row: 'system.sound.input.volume', label: 'Input volume', keywords: 'microphone volume mic level gain' },
          { row: 'system.sound.input.comms', label: 'Communications microphone', keywords: 'calls microphone default communication' },
          { row: 'system.sound.input.test', label: 'Test your microphone', keywords: 'mic test check microphone level listen' },
          { row: 'sound.mixer', label: 'Volume mixer', keywords: 'app volume per app mixer apps sound output device per app', uri: 'ms-settings:apps-volume' },
          { row: 'system.sound.mixer.reset', label: 'Reset sound devices and volumes for all apps', keywords: 'reset mixer app volume default' },
          { row: 'system.sound.devices', label: 'All sound devices', keywords: 'sound devices enable disable audio devices list', uri: 'ms-settings:sound-devices' },
          { row: 'system.sound.props', label: 'Sound device properties', keywords: 'properties speaker properties device settings', uri: 'ms-settings:sound-defaultoutputproperties' },
          { row: 'system.sound.props.name', label: 'Rename a sound device', keywords: 'rename name device' },
          { row: 'system.sound.props.enable', label: 'Enable or disable a sound device', keywords: 'disable enable device allow' },
          { row: 'system.sound.props.format', label: 'Audio format', keywords: 'sample rate bit depth 44100 48000 96000 24 bit hz quality' },
          { row: 'system.sound.props.enhancements', label: 'Audio enhancements', keywords: 'enhancements effects sysfx loudness equalizer apo' },
          { row: 'system.sound.props.spatial', label: 'Spatial sound', keywords: 'spatial windows sonic dolby atmos dts headphone 3d surround' },
          { row: 'system.sound.props.balance', label: 'Balance', keywords: 'left right channel balance' },
          { row: 'system.sound.props.exclusive', label: 'Exclusive mode', keywords: 'exclusive control mode apps' },
          { row: 'system.sound.props.exclusivePriority', label: 'Give exclusive mode apps priority', keywords: 'exclusive priority' },
          { row: 'system.sound.props.test', label: 'Test sound', keywords: 'test tone play speaker check' },
          { row: 'system.sound.props.listen', label: 'Listen to this device', keywords: 'listen monitor playback microphone through speakers' },
          { row: 'system.sound.mono', label: 'Mono audio', keywords: 'mono combine channels one ear accessibility' },
          { row: 'system.sound.ducking', label: 'Communications activity', keywords: 'ducking reduce volume other sounds calls communications' },
        ],
        render: renderSound },
      { id: 'notifications', title: 'Notifications', icon: 'notifications', help: 'Alerts from apps and system, Do not disturb, Focus',
        search: [
          { row: 'notifications.dnd', label: 'Do not disturb', keywords: 'quiet hours focus assist silence', uri: 'ms-settings:quiethours' },
          { row: 'system.notifications.toasts', label: 'Notifications', keywords: 'toasts banners alerts', uri: 'ms-settings:notifications' },
          { row: 'system.notifications.focus', label: 'Focus session', keywords: 'focus timer concentrate', uri: 'ms-settings:focus' },
          { row: 'system.notifications.apps', label: 'Notifications from apps', keywords: 'per app banners priority senders' },
          { row: 'system.notifications.sound', label: 'Allow notifications to play sounds', keywords: 'sound chime' },
          { row: 'system.notifications.lockScreen', label: 'Show notifications on the lock screen', keywords: 'lock screen' },
          { row: 'notifications.panels', label: 'Mantle\'s notification panel', keywords: 'win+n win+a quick settings' },
        ],
        render: renderNotifications },
      { id: 'power', title: 'Power & battery', icon: 'power', help: 'Sleep, battery usage, energy saver',
        search: [
          { row: 'power.mode', label: 'Power mode', keywords: 'performance efficiency balanced', uri: 'ms-settings:powersleep' },
          { row: 'power.saver', label: 'Energy saver', keywords: 'battery saver', uri: 'ms-settings:batterysaver' },
          { row: 'system.power.saverAt', label: 'Turn energy saver on automatically', keywords: 'battery saver threshold percent' },
          { row: 'system.power.screenOff.dc', label: 'Turn my screen off after', keywords: 'screen timeout display off monitor' },
          { row: 'system.power.sleep.dc', label: 'Make my device sleep after', keywords: 'sleep timeout standby' },
          { row: 'system.power.hibernate.dc', label: 'Make my device hibernate after', keywords: 'hibernate timeout' },
          { row: 'system.power.lid.dc', label: 'Closing the lid', keywords: 'lid close laptop' },
          { row: 'system.power.powerButton.dc', label: 'Pressing the power button', keywords: 'power button' },
          { row: 'system.power.hibernation', label: 'Hibernation', keywords: 'hiberfil hibernate' },
          { row: 'system.power.fastStartup', label: 'Fast start-up', keywords: 'fast boot hiberboot' },
          { row: 'power.battery', label: 'Battery', keywords: 'charge percent' },
        ],
        render: renderPower },
      { id: 'storage', title: 'Storage', icon: 'apps', help: 'Storage space, drives, configuration rules',
        search: [{ row: 'system.storage.sense', label: 'Storage Sense', keywords: 'cleanup free space temp files', uri: 'ms-settings:storagesense' }],
        render: renderPending('Storage') },
      { id: 'multitasking', title: 'Multitasking', icon: '<rect x="2" y="3" width="5" height="10" rx="1"/><rect x="9" y="3" width="5" height="10" rx="1"/>', help: 'Snap windows, desktops, task switching',
        search: [
          { row: 'system.multitasking.snap', label: 'Snap windows', keywords: 'snap layouts assist', uri: 'ms-settings:multitasking' },
          { row: 'system.multitasking.shake', label: 'Title bar window shake', keywords: 'aero shake minimise' },
          { row: 'system.multitasking.desktopsTaskbar', label: 'Desktops', keywords: 'virtual desktops taskbar' },
          { row: 'system.multitasking.altTabTabs', label: 'Alt+Tab tabs', keywords: 'alt tab edge tabs' },
          { row: 'system.multitasking.mantleSnap', label: 'Mantle\'s snapping', keywords: 'win+left win+z snap' },
        ],
        render: renderMultitasking },
      { id: 'nearby', title: 'Nearby sharing', icon: 'bluetooth', help: 'Discoverability, received files location',
        search: [{ row: 'system.nearby.sharing', label: 'Nearby sharing', keywords: 'share files near share', uri: 'ms-settings:crossdevice' }],
        render: renderNearby },
      { id: 'projecting', title: 'Projecting to this PC', icon: 'display', help: 'Permissions, pairing PIN, discoverability',
        search: [{ row: 'system.projecting.available', label: 'Projecting to this PC', keywords: 'miracast wireless display cast', uri: 'ms-settings:project' }],
        render: renderProjecting },
      { id: 'remote', title: 'Remote Desktop', icon: 'network', help: 'Remote Desktop users, connection permissions',
        search: [{ row: 'system.remote.desktop', label: 'Remote Desktop', keywords: 'rdp remote access', uri: 'ms-settings:remotedesktop' }],
        render: renderRemote },
      { id: 'clipboard', title: 'Clipboard', icon: '<rect x="4" y="3" width="8" height="11" rx="1"/><path d="M6 3V2h4v1"/>', help: 'Cut and copy history, sync, clear',
        search: [
          { row: 'system.clipboard.history', label: 'Clipboard history', keywords: 'win+v copy paste', uri: 'ms-settings:clipboard' },
          { row: 'system.clipboard.clear', label: 'Clear clipboard data', keywords: 'clear copy' },
          { row: 'system.clipboard.mantle', label: 'Mantle\'s clipboard history', keywords: 'win+v' },
        ],
        render: renderClipboard },
      { id: 'aboutpc', title: 'About', icon: 'about', help: 'Device specifications, rename PC, Windows specifications',
        search: [
          { row: 'system.about.name', label: 'Rename this PC', keywords: 'device name computer name hostname', uri: 'ms-settings:about' },
          { row: 'system.about.processor', label: 'Device specifications', keywords: 'processor cpu ram memory specs' },
          { row: 'system.about.win.version', label: 'Windows specifications', keywords: 'version build edition winver' },
        ],
        render: renderAbout },
      { id: 'activation', title: 'Activation', icon: 'shield', help: 'Activation state, subscriptions, product key',
        search: [{ row: 'system.activation.state', label: 'Activation', keywords: 'activate licence license product key genuine', uri: 'ms-settings:activation' },
          { row: 'system.activation.key', label: 'Change product key', keywords: 'product key licence' }],
        render: renderActivation },
      { id: 'troubleshoot', title: 'Troubleshoot', icon: 'warn', help: 'Troubleshooters, network reset',
        search: [{ row: 'system.troubleshoot.others', label: 'Troubleshooters', keywords: 'fix problems', uri: 'ms-settings:troubleshoot' },
          { row: 'system.troubleshoot.networkReset', label: 'Network reset', keywords: 'reset network adapters'}],
        render: renderTroubleshoot },
      { id: 'recovery', title: 'Recovery', icon: 'refresh', help: 'Reset, advanced start-up, go back',
        search: [{ row: 'system.recovery.advanced', label: 'Advanced start-up', keywords: 'boot options uefi bios safe mode restart', uri: 'ms-settings:recovery' },
          { row: 'system.recovery.reset', label: 'Reset this PC', keywords: 'factory reset reinstall' },
          { row: 'system.recovery.goBack', label: 'Go back', keywords: 'previous version rollback' }],
        render: renderRecovery },
    ],
  });
})();

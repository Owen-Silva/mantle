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
 * links still land.
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
      { id: 'display' },
      { id: 'sound' },
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

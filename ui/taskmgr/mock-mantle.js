/* mock-mantle.js — plays main for the task manager page when it is opened over file:// without
 * Electron (headless shots, ui/taskmgr/shoot.js). The real preload.js defines window.mantle first,
 * so under Electron this file does nothing. EVERY app, number and state here is MADE UP.
 *
 * Query: mock=apps (default) | expanded | game | protected | failed | confirm | startup | nobridge
 * When the page has settled, <html data-ready="1">. window.__mockCalls lists every call made.
 */
(function () {
  'use strict';
  if (window.mantle) return;
  const q = new URLSearchParams(location.search);
  const mode = q.get('mock') || 'apps';
  if (mode === 'nobridge') return;
  const MB = 1048576;
  let n = 0;
  const grp = (name, file, mem, cpu, o) => {
    n++;
    const count = (o && o.count) || 1;
    const members = Array.from({ length: count }, (_, i) => ({ pid: 1000 + n * 40 + i, file, mem: i === 0 ? Math.round(mem * 0.4) : Math.round((mem * 0.6) / Math.max(1, count - 1)), cpu: i === 1 ? cpu : 0, windows: i === 0 ? 1 : 0 }));
    return Object.assign({ key: `${1000 + n * 40}|1`, identity: `c:\\apps\\${file}`, name, file, mem, cpu, count, windows: 1, kind: 'app', protected: null, game: false, handledBy: null, elevated: false,
      icon: null, iconWhy: 'mock: no icon', actions: { close: true, force: true, trim: true, why: null }, state: null, members }, o || {});
  };
  const LOCKED = { close: false, force: false, trim: false };
  const apps = [
    grp('Google Chrome', 'chrome.exe', 1843 * MB, 6.2, { count: 21, title: 'Made-up tab - Google Chrome' }),
    grp('Discord', 'Discord.exe', 412 * MB, 0.8, { count: 6 }),
    grp('Visual Studio Code', 'Code.exe', 655 * MB, 1.3, { count: 11 }),
    grp('Steam', 'steam.exe', 238 * MB, 0.2, { count: 4 }),
    grp('Notepad', 'Notepad.exe', 38 * MB, 0, {}),
  ];
  const background = [
    grp('Spotify', 'Spotify.exe', 312 * MB, 0.4, { count: 5, windows: 0, kind: 'background', handledBy: 'spotify' }),
    grp('Lively Wallpaper', 'Lively.exe', 146 * MB, 0.9, { count: 3, windows: 0, kind: 'background', protected: 'Lively, your wallpaper app: Mantle never closes it', actions: LOCKED }),
    grp('OneDrive', 'OneDrive.exe', 96 * MB, 0.1, { windows: 0, kind: 'background' }),
    grp('Logitech G HUB', 'lghub.exe', 88 * MB, 0.3, { count: 3, windows: 0, kind: 'background', elevated: true }),
    grp('Vanguard tray notification', 'vgtray.exe', 7 * MB, 0, { windows: 0, kind: 'background', protected: "A game's anti-cheat: closing it stops the game from starting", actions: LOCKED }),
  ];
  const windows = [
    grp('Desktop Window Manager', 'dwm.exe', 120 * MB, 1.1, { windows: 0, kind: 'windows', protected: 'Part of Windows: Windows needs it running', actions: LOCKED }),
    grp('Windows Explorer', 'explorer.exe', 164 * MB, 0.4, { windows: 1, kind: 'windows', protected: "Windows' shell (Explorer): closing it takes the desktop and file windows with it", actions: LOCKED }),
    grp('Service Host: Diagnostic Policy', 'svchost.exe', 24 * MB, 0, { windows: 0, kind: 'windows', protected: 'A Windows service: Windows needs it running', actions: LOCKED }),
  ];
  const mantleRow = grp('Mantle', 'electron.exe', 273 * MB, 0.6, { count: 9, windows: 0, kind: 'mantle', protected: 'Mantle itself: close Mantle from its tray menu', actions: LOCKED });
  if (mode === 'failed') {
    apps[1].state = { state: 'still-running', why: 'Its window closed but it kept running in the background (probably in the tray). Force close ends it.' };
    apps[3].state = { state: 'failed', why: 'Not closed: access denied: it runs as administrator or is protected' };
    apps[2].state = { state: 'trimmed', before: 655 * MB, after: 214 * MB };
  }
  const ticks = new Set(mode === 'game' ? ['c:\\apps\\chrome.exe', 'c:\\apps\\Discord.exe', 'c:\\apps\\Code.exe'] : []);
  const reopen = new Set(mode === 'game' ? ['c:\\apps\\Discord.exe', 'c:\\apps\\Code.exe'] : []);
  let auto = false;
  const view = mode === 'game' ? 'game' : mode === 'startup' ? 'startup' : 'apps';
  function model() {
    const all = apps.concat(background);
    const prep = all.map((g) => {
      const why = g.handledBy === 'spotify' ? 'Handled by the Spotify card: it closes an idle Spotify when a game starts' : g.protected || null;
      return { key: g.key, identity: g.identity, name: g.name, mem: g.mem, kind: g.kind, tickable: !why, why, ticked: !why && ticks.has(g.identity), reopen: !why && reopen.has(g.identity),
        elevated: g.elevated, icon: null, reopenWhy: g.name === 'Visual Studio Code' && reopen.has(g.identity) ? 'Cannot reopen: A Store app: Mantle cannot start it from its exe (open it from Start after the game)' : null };
    });
    return {
      at: Date.now(), test: false, error: null, view, mem: { total: 16 * 1024 * MB, avail: 5.4 * 1024 * MB, used: 10.6 * 1024 * MB }, cpus: 16, mantle: { mem: mantleRow.mem, count: 9, cpu: 0.6 },
      apps, background, windows, mantleRow, recent: mode === 'failed' ? [{ name: 'Notepad', text: 'Closed · freed about 38 MB', ok: true }] : [],
      prep: { rows: prep, absent: mode === 'game' ? [{ identity: 'c:\\apps\\obs64.exe', name: 'OBS Studio', reopen: false }] : [], auto,
        lastFree: null, lastAuto: mode === 'game' ? { at: new Date(2026, 8, 27, 20, 5).getTime(), game: 'VALORANT', freed: 1260 * MB, results: [{ name: 'Google Chrome', state: 'closed' }, { name: 'Discord', state: 'still-running', why: 'Its window closed but it kept running in the background (probably in the tray). Force close ends it.' }], reopened: { results: [{ name: 'Discord', ok: true }] } } : null },
      loaded: true,
    };
  }
  const handlers = {};
  window.__mockCalls = [];
  window.mantle = {
    on(ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn); return () => {}; },
    emit(ev, p) { (handlers[ev] || []).forEach((fn) => fn(p)); },
    call(name, args) {
      window.__mockCalls.push({ name, args });
      switch (name) {
        case 'taskmgr.state': return Promise.resolve(model());
        case 'taskmgr.tick':
          if (args.on !== undefined) { if (args.on) ticks.add(args.identity); else ticks.delete(args.identity); }
          if (args.reopen !== undefined) { if (args.reopen) reopen.add(args.identity); else reopen.delete(args.identity); }
          setTimeout(() => window.mantle.emit('taskmgr.model', model()), 10);
          return Promise.resolve({ ok: true });
        case 'taskmgr.auto': auto = !!args.on; setTimeout(() => window.mantle.emit('taskmgr.model', model()), 10); return Promise.resolve({ ok: true, auto });
        case 'taskmgr.act': return Promise.resolve({ ok: true, dryRun: true });
        case 'settings.open': return Promise.reject(new Error('no command "settings.open" (mock)'));
        default: return Promise.resolve({ ok: true });
      }
    },
  };
  window.addEventListener('load', () => {
    setTimeout(() => {
      const click = (sel) => { const el = document.querySelector(sel); if (el) el.dispatchEvent(new MouseEvent('click', { bubbles: true })); };
      if (mode === 'expanded') click(`[data-key="${apps[0].key}"] [data-act="expand"]`);
      if (mode === 'confirm') click(`[data-key="${apps[1].key}"] [data-act="force"]`);
      if (mode === 'protected') { click('.sect[data-s="windows"] [data-act="section"]'); setTimeout(() => { const b = document.querySelector('.sect[data-s="background"]'); if (b) b.scrollIntoView(); }, 50); }
      if (mode === 'startup') click('#opensettings');
      setTimeout(() => { document.documentElement.dataset.ready = '1'; document.documentElement.dataset.shot = '1'; }, 250);
    }, 80);
  });
}());

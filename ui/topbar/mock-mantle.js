/* mock-mantle.js — plays main for the top bar page when it is opened over file:// without
 * Electron (headless shots: ui/topbar/shoot.js). The real preload.js defines window.mantle first,
 * so under Electron this file does nothing. Nothing here is from Owen's machine: every app, menu
 * and number is made up.
 *
 * Query: app=npp|chrome|uwp|dialog|desktop|word|explorer|term  open=<title index>  sub=<row index>
 *        stat=cpu|mem|gpu|net  stats=ok|nogpu|paused  dark=1  armed=1 (Restart armed)
 *        fail=1 (every command fails)  note=1 (a long plain-words warning on the bar)
 */
(function () {
  'use strict';
  if (window.mantle) return;
  const q = new URLSearchParams(location.search);
  // The real bar's window sits at its display's left edge (screenX 0); headless Chromium puts its
  // window at 10,10, which would make topbar.js's visibleWidth() 10 px short. screenX is replaceable.
  try { window.screenX = 0; } catch (_) { /* read-only here: the fit is then 10 px conservative */ }
  document.documentElement.classList.add('mock');
  document.addEventListener('DOMContentLoaded', () => {
    document.body.classList.add('mock');
    if (q.get('dark') === '1') document.body.classList.add('dark');
  });
  let pos = 0;
  const it = (label, key, extra) => Object.assign({ t: 'item', pos: pos++, label, key: key || '', mn: label[0].toLowerCase(), id: 100 + pos, enabled: true, checked: false, radio: false, items: null, lazy: false }, extra || {});
  const sep = () => ({ t: 'sep', pos: pos++ });
  const sub = (label, items, extra) => { const x = it(label, '', Object.assign({ id: null, items }, extra || {})); pos = 0; return x; };
  const W32 = () => {
    pos = 0;
    const file = sub('File', [it('New', 'Ctrl+N'), it('Open…', 'Ctrl+O'), sub('Recent Files', [it('notes.txt'), it('todo.md'), it('build.log')]),
      sep(), it('Save', 'Ctrl+S'), it('Save As…', 'Ctrl+Alt+S'), it('Save a Copy As…', '', { enabled: false }), sep(), it('Print…', 'Ctrl+P'), sep(), it('Exit', 'Alt+F4')]);
    const edit = sub('Edit', [it('Undo', 'Ctrl+Z'), it('Redo', 'Ctrl+Y', { enabled: false }), sep(), it('Cut', 'Ctrl+X'), it('Copy', 'Ctrl+C'), it('Paste', 'Ctrl+V'),
      sep(), it('Select All', 'Ctrl+A')]);
    const view = sub('View', [it('Always on Top', '', { checked: true }), it('Word Wrap', '', { checked: true }), sep(),
      it('Tab size 2', '', { radio: true, checked: true }), it('Tab size 4', '', { radio: true }), sep(), sub('Zoom', [it('Zoom In', 'Ctrl+Num +'), it('Zoom Out', 'Ctrl+Num -'), it('Restore Default Zoom', 'Ctrl+Num /')])]);
    const items = [file, edit, sub('Search', [it('Find…', 'Ctrl+F'), it('Replace…', 'Ctrl+H')]), view,
      sub('Encoding', [it('UTF-8', '', { radio: true, checked: true }), it('UTF-16 LE', '', { radio: true })]), sub('Language', [], { lazy: true }),
      sub('Settings', [it('Preferences…')]), sub('Tools', [it('MD5')]), sub('Macro', [it('Start Recording')]), sub('Run', [it('Run…', 'F5')]),
      sub('Plugins', [it('Plugins Admin…')]), sub('Window', [it('Windows…')]), sub('?', [it('About Notepad++', 'F1')])];
    items.forEach((x, i) => { x.pos = i; });
    return { source: 'win32', hwnd: '4242', owner: false, items, count: 80, truncated: false, readMs: 0.4 };
  };
  const base = { hwnd: '4242', cls: 'Notepad++', title: 'todo.md - Notepad++', exe: 'C:\\Program Files\\Notepad++\\notepad++.exe', pid: 7, appPid: 7,
    desc: 'Notepad++', product: 'Notepad++', self: false, shell: false, fullscreen: false, zoomed: true, topmost: false, enabled: true, uia: 'not needed', ms: 0.4 };
  const APPS = {
    npp: () => Object.assign({}, base, { menu: W32() }),
    chrome: () => Object.assign({}, base, { hwnd: '5151', cls: 'Chrome_WidgetWin_1', title: 'Inbox - Chrome', exe: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      desc: 'Google Chrome', product: 'Google Chrome', menu: null, menuReason: 'no Win32 menu bar', uia: 'Chromium and Electron windows draw their own menus' }),
    uwp: () => Object.assign({}, base, { hwnd: '6161', cls: 'ApplicationFrameWindow', title: 'Calculator', exe: 'C:\\Program Files\\WindowsApps\\Calc\\CalculatorApp.exe',
      desc: 'Calculator', product: 'Calculator', menu: null, menuReason: 'no Win32 menu bar', uia: 'try' }),
    dialog: () => Object.assign({}, base, { title: 'Save As', menu: Object.assign(W32(), { owner: true }), blocked: 'a dialog of this app is open, so it is not taking menu commands until it closes' }),
    desktop: () => Object.assign({}, base, { hwnd: '1', cls: 'Progman', title: 'Program Manager', exe: 'C:\\Windows\\explorer.exe', desc: 'Windows Explorer', shell: true, menu: null, uia: 'the desktop' }),
    // the fit cases (shoot.js): an Office-style app with a long name and 17 Win32 menus, File Explorer, Windows Terminal
    word: () => Object.assign({}, base, { hwnd: '7777', cls: 'OpusApp', title: 'Quarterly planning notes (final, reviewed) - Word',
      exe: 'C:\\Program Files\\Microsoft Office\\root\\Office16\\WINWORD.EXE', desc: 'Microsoft Word for Microsoft 365 Apps for enterprise', product: 'Microsoft Office',
      menu: { source: 'win32', hwnd: '7777', owner: false, count: 17, truncated: false, readMs: 0.5, items: ['File', 'Home', 'Insert', 'Draw', 'Design', 'Layout',
        'References', 'Mailings', 'Review', 'View', 'Developer', 'Help', 'Acrobat', 'Table Design', 'Table Layout', 'Picture Format', 'Shape Format'].map((label, i) => {
        pos = 0;
        return Object.assign(it(label, '', { id: null, items: [it(label + ' options…', 'Ctrl+' + (i % 9 + 1)), it('Customize ' + label + '…')] }), { pos: i });
      }) } }),
    explorer: () => Object.assign({}, base, { hwnd: '8888', cls: 'CabinetWClass', title: 'Downloads', exe: 'C:\\Windows\\explorer.exe', desc: 'Windows Explorer',
      menu: null, menuReason: 'no Win32 menu bar', uia: 'not tried' }),
    term: () => Object.assign({}, base, { hwnd: '9999', cls: 'CASCADIA_HOSTING_WINDOW_CLASS', title: 'user@laptop: ~/mantle',
      exe: 'C:\\Program Files\\WindowsApps\\Microsoft.WindowsTerminal\\WindowsTerminal.exe', desc: 'Windows Terminal', product: 'Windows Terminal',
      menu: null, menuReason: 'no Win32 menu bar', uia: 'not tried' }),
  };
  const focus = (APPS[q.get('app')] || APPS.npp)();
  const cores = [22, 61, 9, 14, 37, 5, 71, 18];
  const STATS = {
    ok: { t: 1, cpu: { pct: 23.4, cores, top: [{ name: 'Code', pct: 11.2 }, { name: 'chrome', pct: 6.1 }, { name: 'Mantle', pct: 1.3 }, { name: 'MsMpEng', pct: 0.9 }, { name: 'explorer', pct: 0.4 }] },
      mem: { used: 9.7 * 1073741824, total: 15.7 * 1073741824, commit: 13.1 * 1073741824, commitLimit: 23.4 * 1073741824,
        top: [{ name: 'chrome', bytes: 2.1 * 1073741824 }, { name: 'Code', bytes: 1.4 * 1073741824 }, { name: 'Mantle', bytes: 0.31 * 1073741824 }] },
      gpu: { pct: 7.8, name: 'Intel(R) UHD Graphics', engines: [{ type: '3D', pct: 7.8 }, { type: 'VideoDecode', pct: 2.2 }, { type: 'Copy', pct: 0 }],
        dedicated: 0.13 * 1073741824, shared: 1.2 * 1073741824, top: [{ name: 'dwm', pct: 4.1 }, { name: 'chrome', pct: 2.9 }] },
      net: { down: 2.4 * 1048576, up: 88 * 1024, adapters: [{ name: 'Wi-Fi', down: 2.4 * 1048576, up: 88 * 1024 }] },
      ping: { state: 'ok', ms: 23, label: 'Valorant', server: 'US West (N. California)', host: 'dynamodb.us-west-1.amazonaws.com', via: 'AWS us-west-1', method: 'icmp', everyMs: 2000, pickEveryMs: 600000,
        picked: [{ name: 'US West (N. California)', ms: 17 }, { name: 'US West (Oregon)', ms: 38 }, { name: 'US Central (Texas)', ms: 56 }] }, costMs: 1.8 },
  };
  STATS.nogpu = JSON.parse(JSON.stringify(STATS.ok));
  STATS.nogpu.gpu = { pct: null, reason: 'Windows has no GPU performance counters here (\\GPU Engine is missing), so the GPU cannot be measured' };
  const stats = q.get('stats') === 'paused' ? null : (STATS[q.get('stats')] || STATS.ok);
  // THE TWO SMALL TOOLS (lane tbtools): timer=run|pause|sw|swpause|idle|persistbad  tool=timer (its menu
  // open)  custom=<text> (typed into its Custom… box)  notes=open|bad  notes=click (the icon pressed)
  const T0 = Date.now();
  const TIMERS = {
    // a started one ends exactly ms on, as timer.js does (the +400 is only for the fixed 18:42 shot)
    run: (ms, label) => ({ kind: 'timer', endAt: ms ? Date.now() + ms : T0 + 18 * 60000 + 42000 + 400, totalMs: ms || 25 * 60000, label: label || '25 min', startedAt: T0 - 60000, now: Date.now() }),
    pause: () => ({ kind: 'timer', paused: true, leftMs: 7 * 60000 + 5000, totalMs: 15 * 60000, label: '15 min', now: Date.now() }),
    sw: () => ({ kind: 'stopwatch', startAt: T0 - (12 * 60000 + 5000) - 300, now: Date.now() }),
    swpause: () => ({ kind: 'stopwatch', paused: true, elapsedMs: 41 * 60000 + 17000, now: Date.now() }),
    idle: () => ({ kind: 'idle', now: Date.now() }),
    persistbad: () => ({ kind: 'idle', persist: { ok: false, reason: "EPERM: operation not permitted, open 'C:\\Users\\user\\AppData\\Roaming\\mantle\\features\\timer.json'" }, now: Date.now() }),
  };
  const NOTES = {
    open: { open: true, count: 3, saved: { ok: true, at: T0 }, file: 'C:\\Users\\user\\Documents\\Mantle Notes\\notes.md' },
    bad: { open: false, count: 3, saved: { ok: false, reason: "EACCES: permission denied, open 'C:\\Users\\user\\Documents\\Mantle Notes\\notes.md.tmp-7'" } },
  };
  const handlers = {};
  const fail = q.get('fail') === '1';
  window.__mockCalls = [];
  window.mantle = {
    on(ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn); return () => {}; },
    emit(ev, payload) { (handlers[ev] || []).forEach((fn) => fn(payload)); },
    call(name, args) {
      window.__mockCalls.push({ name, args });
      if (fail && !/hello|menuState|menus|statsDetail|uia$/.test(name)) return Promise.resolve({ ok: false, reason: 'the app did not accept the command (PostMessage failed: it runs as administrator above Mantle)' });
      switch (name) {
        case 'topbar.hello': return Promise.resolve({ focus, stats });
        case 'glass.topbarMenu': return menuPicture();
        case 'topbar.menus': return Promise.resolve({ menu: focus.menu, inited: 1 });
        case 'topbar.uia': return Promise.resolve({ menu: { source: 'uia', hwnd: focus.hwnd, items: [
          { t: 'item', pos: 0, label: 'View', mn: 'v', items: [], lazy: true, enabled: true }, { t: 'item', pos: 1, label: 'History', mn: 'h', items: null, enabled: true }] } });
        case 'topbar.power': return Promise.resolve(args.confirmed || /lock|sleep/.test(args.action) ? { ok: true, dryRun: true, reason: 'dry run: would run shutdown.exe' } : { ok: false, reason: 'asks first' });
        case 'timer.start': {   // the two small tools (lane tbtools): a started timer comes back as timer.state
          const C = window.TimerCore, v = args.ms ? { ok: true, ms: args.ms, label: C.labelFor(args.ms) } : C.parseDuration(args.text);
          if (!v.ok) return Promise.resolve({ ok: false, reason: v.reason });
          setTimeout(() => window.mantle.emit('timer.state', TIMERS.run(v.ms, v.label)), 10);
          return Promise.resolve({ ok: true });
        }
        default: return Promise.resolve({ ok: true });
      }
    },
  };
  /* THE SCENE (lane same-bars, 2026-10-09): what is "behind" the bar in a shot, for the dark glass.
     ?scene=<file URL> (cover-fit to the SCREEN, as the desktop draws a wallpaper) or ?flat=<#hex>
     (a known flat backdrop, to measure the tint's composite alpha); ?maxwin=1 adds a dark maximized
     window from the bar's bottom down. The page's own background shows the same scene, and main's two
     pictures are made from it as main makes them: the strip's ('topbar.backdrop', the desktop's top
     strip, wallpaper only) and the menus' (glass.topbarMenu: everything under the window's width down
     to the work area's bottom), both 4x downscaled PHYSICAL pixels. ?bdms=<ms> delays the menus'
     picture (a slow capture), ?bdfail=1 fails it. File pictures need --allow-file-access-from-files. */
  const SCENE = q.get('scene'), FLAT = q.get('flat'), MAXWIN = q.get('maxwin') === '1', MAXWIN_RGB = '#202020';
  const sceneReady = (SCENE || FLAT) ? new Promise((res) => {
    if (!SCENE) { res(null); return; }
    const im = new Image();
    im.onload = () => res(im); im.onerror = () => res(null);
    im.src = SCENE;
  }) : null;
  const scr = () => ({ w: (window.screen && window.screen.width) || window.innerWidth, h: (window.screen && window.screen.height) || window.innerHeight });
  // the screen's rectangle (x, y, w, h in CSS px) drawn into a canvas of cw x ch
  function drawScene(im, x, y, w, h, cw, ch, withWin) {
    const c = document.createElement('canvas'); c.width = cw; c.height = ch;
    const g = c.getContext('2d');
    const s = scr(), k = cw / w;
    g.save(); g.scale(k, ch / h); g.translate(-x, -y);
    if (im) {
      const f = Math.max(s.w / im.naturalWidth, s.h / im.naturalHeight), dw = im.naturalWidth * f, dh = im.naturalHeight * f;
      g.drawImage(im, (s.w - dw) / 2, (s.h - dh) / 2, dw, dh);
    } else { g.fillStyle = FLAT || '#000'; g.fillRect(0, 0, s.w, s.h); }
    if (withWin && MAXWIN) { g.fillStyle = MAXWIN_RGB; g.fillRect(0, 28, s.w, s.h - 28); }
    g.restore();
    return c;
  }
  const phys4 = (n) => Math.max(1, Math.round(n * (window.devicePixelRatio || 1) / 4));
  async function menuPicture() {
    const t0 = performance.now();
    const ms = +(q.get('bdms') || 0);
    if (ms) await new Promise((r) => setTimeout(r, ms));
    if (q.get('bdfail') === '1') return { ok: false, reason: 'mock: the capture failed (bdfail=1)' };
    if (!sceneReady) return { ok: false, reason: 'mock: no scene to take a picture of (no ?scene= or ?flat=)' };
    const im = await sceneReady;
    const s = window.screen || {};
    const at = { x: 0, y: 0, w: window.innerWidth, h: (s.availHeight || s.height || window.innerHeight) - (window.screenY || 0) };
    const c = drawScene(im, 0, 0, at.w, at.h, phys4(at.w), phys4(at.h), true);
    return { ok: true, png: c.toDataURL('image/png'), w: c.width, h: c.height, at, ms: Math.round(performance.now() - t0) };
  }
  if (sceneReady) {
    window.addEventListener('load', async () => {
      const im = await sceneReady;
      const s = scr();
      // the page's own background: the screen as it is under the window (the window sits at 0,0)
      if (im) {
        const f = Math.max(s.w / im.naturalWidth, s.h / im.naturalHeight), dw = im.naturalWidth * f, dh = im.naturalHeight * f;
        document.body.style.setProperty('background', `url("${SCENE}") ${(s.w - dw) / 2}px ${(s.h - dh) / 2}px / ${dw}px ${dh}px no-repeat`);
      } else document.body.style.setProperty('background', FLAT || '#000');
      if (MAXWIN) {
        const win = document.createElement('div');
        win.id = 'mock-maxwin';
        for (const [k, v] of [['position', 'fixed'], ['left', '0'], ['right', '0'], ['top', '28px'], ['bottom', '0'], ['background', MAXWIN_RGB]]) win.style.setProperty(k, v);
        document.body.insertBefore(win, document.body.firstChild);
      }
      if (document.documentElement.getAttribute('data-theme') === 'dark' && q.get('strip') !== '0') {   // strip=0: the strip on its fallback
        const strip = drawScene(im, 0, 0, s.w, 28, phys4(s.w), phys4(28), false);
        window.mantle.emit('topbar.backdrop', { png: strip.toDataURL('image/png'), ms: 0 });
      }
      document.documentElement.dataset.scene = '1';
    });
  }
  window.addEventListener('load', () => {
    if (q.get('stats') === 'paused') window.mantle.emit('topbar.stats', { paused: true, reason: 'the screen is locked' });
    if (q.get('note') === '1') window.mantle.emit('topbar.note', { text: 'the top bar cannot follow the focused app: the sidecar did not answer within 4 s' });
    if (TIMERS[q.get('timer')]) window.mantle.emit('timer.state', TIMERS[q.get('timer')]());
    if (NOTES[q.get('notes')]) window.mantle.emit('notes.state', NOTES[q.get('notes')]);
    setTimeout(() => {
      const open = q.get('open'), stat = q.get('stat');
      const S = window.__topbar;
      const down = (el) => el && el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      if (stat) down(document.querySelector(`.st[data-k="${stat}"]`));
      if (q.get('tool')) down(document.querySelector(`.tool[data-tool="${q.get('tool')}"]`));
      if (q.get('custom') != null && S && S.open && S.open.tool === 'timer') {
        const row = document.querySelector('.r[data-l="0"][data-r="5"]');   // Custom…
        if (row) row.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        const inp = document.querySelector('input.lbi');
        if (inp) { inp.value = q.get('custom'); inp.dispatchEvent(new Event('input', { bubbles: true })); }
        if (q.get('enter') === '1' && inp) inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      }
      if (open != null) {
        down(document.querySelector(`.t[data-i="${open}"]`));
        const r = q.get('sub');
        if (r != null && S && S.open) {
          setTimeout(() => {
            const row = document.querySelector(`.r[data-l="0"][data-r="${r}"]`);
            if (row) row.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }));
            if (q.get('armed') === '1' && row) row.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
          }, 30);
        }
      }
      document.documentElement.dataset.ready = '1';
    }, 60);
  });
}());

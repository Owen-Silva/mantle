/* mock-mantle.js — plays main for Mantle Settings when the page is opened over file:// without
 * Electron (headless shots, ui/settings/shoot.js). The real preload.js defines window.mantle first,
 * so under Electron this file does nothing.
 *
 * EVERYTHING HERE IS MADE UP: the device names, networks, startup entries, paths and versions are
 * invented ("Desk Speakers", "Home-5G", "Cloud Drive"). Nothing is read or copied from Owen's
 * machine. The shapes are the real ones: the settings.* contract (lib/features/settings.js) and the
 * bar's backends (main.js qs.*, net.get, battery.get, powermode.*, gamemode.state, corners.*).
 *
 * Query: section=<id>  row=<row id>  q=<search text>  test=1 (a test run: sets are dry runs)
 *        mock=default | failing | admin | btoff | nobridge
 *          failing   every backend throws or answers ok:false with its reason
 *          admin     a machine-wide startup entry needs administrator, plus an HKLM problem line
 *          btoff     the Bluetooth radio is off
 *          nobridge  no window.mantle at all: the page must say it cannot reach Mantle
 *        taskmgr=on | off | rest   Mantle's task manager feature (absent by default)
 *        real=1   load the REAL category files (sections/<id>.js, the eleven Windows categories) instead of
 *                 fixtures: the whole app as a person sees it. Their settings.<id>.* reads are NOT played
 *                 (each answers ok:false with a made-up reason), so every page shows its error state;
 *                 each category's own page test plays its data (sections/*.test.js)
 *        glass=acrylic   what main puts in the URL when it asked DWM for acrylic (lib/features/settings.js)
 *        glassok=1 | 0 | wait   DWM's read-back: acrylic + light frame / refused with a made-up reason / not yet
 *        theme=dark | light   the look Mantle opens in, as the real preload paints it: <html data-theme> is
 *                 set on load, and theme.set / a Windows change re-sets it and fires the window
 *                 'mantle-theme' event the way the preload does. Windows' app mode is played as the same
 *                 value, so Match Windows (the default) agrees. Absent: no data-theme (the light look) and
 *                 Windows is played as dark. mock=failing makes theme.get / theme.set answer ok:false.
 *        desk=1   paints a MADE-UP desktop behind the clear page, blurred and tinted the way DWM's light
 *                 acrylic draws it, so a headless shot shows the glass look. It stands in for DWM only
 *                 here: the page itself never uses a CSS blur.
 * The page sets <html data-ready="1"> itself once the requested section's first paint settled.
 * window.__mockCalls lists every call; window.__mockEmit(event, payload) pushes an event;
 * window.__mockWindowsMode('dark'|'light'|null) plays Windows' app mode changing (emits 'theme').
 * window.__mockLook(patch) plays a look change made in Helm or Quartz (emits 'look');
 * window.__mockLookRefuse(reason|null) makes the next look.* writes answer ok:false.
 */
(function () {
  'use strict';
  if (window.mantle) return;
  const q = new URLSearchParams(location.search);
  const mode = q.get('mock') || 'default';
  if (mode === 'nobridge') return;
  const FAIL = mode === 'failing', ADMIN = mode === 'admin', TEST = q.get('test') === '1';
  const TM = q.get('taskmgr');
  const GLASS = q.get('glass') !== 'acrylic' ? null : q.get('glassok') === '0'
    ? { material: 'acrylic', ok: false, why: 'Windows did not take the acrylic backdrop (it reads back 1), so the window is solid', backdrop: 1, dark: 0 }
    : q.get('glassok') === 'wait' ? { material: 'acrylic', ok: null, why: null, backdrop: null, dark: null }
      : { material: 'acrylic', ok: true, why: null, backdrop: 3, dark: 0 };
  if (q.get('desk') === '1') {
    // the made-up desktop: colour fields a wallpaper might have, then DWM's blur and light tint over it
    const desk = document.createElement('div'), tint = document.createElement('div');
    Object.assign(desk.style, { position: 'fixed', inset: '-60px', zIndex: '-2', filter: 'blur(38px) saturate(1.25)',
      background: 'radial-gradient(40% 50% at 18% 30%, #ff8a5c, transparent 70%), radial-gradient(45% 55% at 78% 22%, #5b7cff, transparent 70%),'
        + ' radial-gradient(50% 60% at 60% 85%, #2fb58f, transparent 70%), radial-gradient(35% 40% at 30% 88%, #ffd166, transparent 70%), linear-gradient(135deg, #3a2f6b, #1d4e6b)' });
    Object.assign(tint.style, { position: 'fixed', inset: '0', zIndex: '-1', background: 'rgba(243,244,248,.70)' });
    const put = () => { document.body.prepend(tint); document.body.prepend(desk); };
    if (document.body) put(); else document.addEventListener('DOMContentLoaded', put);
  }
  const REAL = q.get('real') === '1' ? ['system', 'devices', 'internet', 'personalization', 'applist', 'accounts', 'time', 'gaming', 'accessibility', 'privacy', 'update'] : [];
  const SECS = (q.get('sections') || '').split(',').filter(Boolean);
  const now = Date.now();
  const SIDECAR = 'the sidecar is restarting (it exited with code 1 a moment ago)';

  /* ---- quick settings (levels 0-100, as qs.get reports them) ---- */
  const qs = {
    volume: { ok: true, level: 64, muted: false, reason: null },
    wifi: { ok: true, present: true, on: true, connected: true, ssid: 'Home-5G', signal: 82, band: '5 GHz', reason: null },
    bluetooth: { ok: true, present: true, on: mode !== 'btoff', via: 'radio', reason: null },
    brightness: { ok: true, present: true, level: 66, reason: null },
    nightlight: { ok: true, present: true, on: false, reason: null },
    power: { ok: true, present: true, percent: 72, ac: false, charging: false, secondsLeft: 184 * 60, saver: false, reason: null },
  };
  if (FAIL) Object.keys(qs).forEach((k) => { qs[k] = { ok: false, reason: (k === 'brightness' ? 'the screen brightness' : k) + ' cannot be read: ' + SIDECAR }; });
  const snap = () => Object.assign({ ok: !FAIL, reason: FAIL ? SIDECAR : null }, JSON.parse(JSON.stringify(qs)));

  const net = FAIL ? { ok: false, state: 'unknown', kind: 'none', internet: null, reason: 'the network is not being read: ' + SIDECAR }
    : { ok: true, state: 'connected', kind: 'wifi', internet: true, local: false, adapter: 'Wi-Fi', adapterType: 'wifi',
      wifi: { present: true, on: true, connected: true, ssid: 'Home-5G', signal: 82, band: '5 GHz', reason: null }, reason: null };
  const battery = FAIL ? { ok: false, reason: 'Windows would not report the power status (GetSystemPowerStatus failed, Win32 error 5)' }
    : { ok: true, present: true, percent: 72, ac: false, charging: false, secondsLeft: 184 * 60, saver: false, low: false, onBattery: true, hasBattery: true, reason: null };
  let pm = FAIL ? { ok: false, mode: null, available: false, reason: 'Windows would not say which power plan is active (error 5)' }
    : { ok: true, mode: 'balanced', available: true, settable: true, plan: { guid: '381b4222-f694-41f0-9685-ff5bb260df2e', name: 'Balanced', balanced: true }, source: 'battery', saver: false, reason: null };
  const gm = { on: false, how: null, game: null, busy: null, auto: true, liftSaver: false, dry: false, enabled: true, watching: true, reason: 'no game is running', actions: [], last: null };

  /* ---- sound ---- */
  const devices = [
    { id: '{mock}.{desk-speakers}', name: 'Desk Speakers (USB Audio)' },
    { id: '{mock}.{studio-phones}', name: 'Studio Headphones (Bluetooth)' },
  ];
  let defDev = devices[0].id;
  const tileIcon = (c) => 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect x="1" y="1" width="14" height="14" rx="3.5" fill="' + c + '"/><path d="M5 11V5l6 3z" fill="#fff"/></svg>');
  const sessions = [
    { key: 'system', pid: 0, system: true, name: 'System Sounds', active: false, level: 100, muted: false, sessions: 1, icon: null },
    { key: 'pid:4100', pid: 4100, name: 'Music Player', active: true, level: 58, muted: false, sessions: 1, icon: tileIcon('#3F7D58') },
    { key: 'pid:5200', pid: 5200, name: 'Web Browser', active: false, level: 100, muted: false, sessions: 3, icon: tileIcon('#3B63B8') },
    { key: 'pid:6300', pid: 6300, name: 'Video Call', active: true, level: 80, muted: true, sessions: 1, icon: null, iconReason: 'no icon (made up)' },
  ];

  /* ---- Bluetooth ---- */
  const btDevs = [
    { id: 'BT#mock-01', name: 'Studio Headphones', kind: 'headphones', connected: true, battery: 80, batteryWhy: null, audio: true, canConnect: true, connectWhy: null },
    { id: 'BT#mock-02', name: 'Keyboard K3', kind: 'keyboard', connected: true, battery: null, batteryWhy: 'this device does not report its battery to Windows', audio: false, canConnect: false,
      connectWhy: 'Mantle can connect and disconnect audio devices only; Windows connects this one itself when it is used' },
    { id: 'BT#mock-03', name: 'Desk Speakers Mini', kind: 'speaker', connected: false, battery: null, batteryWhy: null, audio: true, canConnect: true, connectWhy: null },
    { id: 'BT#mock-04', name: 'Travel Mouse M2', kind: 'mouse', connected: false, battery: null, batteryWhy: null, audio: false, canConnect: false,
      connectWhy: 'Mantle can connect and disconnect audio devices only; Windows connects this one itself when it is used' },
  ];
  const btList = () => {
    if (FAIL) return { ok: false, present: true, on: null, devices: [], reason: 'Windows\' paired-device list did not answer within 3 s' };
    const on = qs.bluetooth.on !== false;
    const devs = btDevs.map((d) => Object.assign({}, d, on ? {} : { connected: false, battery: null }));
    devs.sort((a, b) => (a.connected === b.connected ? 0 : a.connected ? -1 : 1));
    return { ok: true, present: true, on, radioReason: null, devices: devs, busy: null, last: null, watching: true, reason: null };
  };

  /* ---- Wi-Fi ---- */
  const hex = (s) => Array.from(new TextEncoder().encode(s)).map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join('');
  const nets = [
    { ssid: 'Home-5G', security: 'WPA3-Personal', signal: 82, known: true, connected: true, action: 'disconnect' },
    { ssid: 'Home-Guest', security: 'WPA2-Personal', signal: 70, known: true, connected: false, action: 'connect' },
    { ssid: 'Neighbor-2G', security: 'WPA2-Personal', signal: 48, known: false, connected: false, action: 'password' },
    { ssid: 'Cafe Free WiFi', security: 'Open', signal: 36, known: false, connected: false, action: 'open', open: true },
    { ssid: 'Office-Secure', security: 'WPA2-Enterprise', signal: 30, known: false, connected: false, action: 'settings',
      why: 'it uses enterprise (802.1X) sign-in - a user name and password or a certificate - which Windows\' own Wi-Fi list asks for' },
  ];
  const wifiList = () => {
    if (FAIL) return { ok: false, present: true, on: false, networks: [], reason: 'the Wi-Fi networks could not be read (WlanGetAvailableNetworkList: the service is not running)' };
    if (!qs.wifi.on) return { ok: true, present: true, on: false, networks: [], reason: 'the Wi-Fi radio is switched off' };
    return { ok: true, present: true, on: true, reason: null, connecting: null, last: null, scannedAgoMs: 2500,
      networks: nets.map((n) => ({ ssid: n.ssid, hex: hex(n.ssid), hidden: false, signal: n.signal, secure: !n.open, security: n.security, known: n.known,
        connected: n.connected, connecting: false, action: n.connected ? 'disconnect' : n.action, why: n.why || null })) };
  };

  /* ---- Mantle's features ---- */
  const opt = (o) => Object.assign({ help: null, choices: [], default: null, value: null, isDefault: true, min: null, max: null, step: null, unit: null, placeholder: null, defaultLabel: null }, o);
  const F = (name, label, chords, options, extra) => Object.assign({ name, label, enabled: true, ok: true, reason: null, resting: null, running: true, stopped: false, chords: chords || [], keys: true, keysReason: null, options: options || [] }, extra || {});
  const features = [
    F('search', 'Search (Win+S)', ['Win+S'], [
      opt({ key: 'web', label: 'Show web results', help: 'Adds a web search row under the apps and files', type: 'bool', default: false, value: false }),
      opt({ key: 'max', label: 'Results to show', type: 'number', default: 8, value: 10, isDefault: false, min: 3, max: 20, step: 1, unit: 'results' }),
    ]),
    F('clipboard', 'Clipboard history (Win+V)', ['Win+V'], [
      opt({ key: 'keep', label: 'Items to keep', type: 'number', default: 50, value: 50, min: 10, max: 200, step: 10, unit: 'items' }),
    ], { enabled: false, running: false }),
    F('screenshot', 'Screenshots (Win+Shift+S, PrintScreen)', ['Win+Shift+S', 'PrintScreen'], [
      opt({ key: 'folder', label: 'Save screenshots to', type: 'folder', default: null, value: null, defaultLabel: 'Windows\' Screenshots folder' }),
      opt({ key: 'copy', label: 'Copy to the clipboard too', type: 'bool', default: true, value: true }),
    ]),
    F('snap', 'Window snapping (Win+arrows, Win+Z)', ['Win+Left', 'Win+Right', 'Win+Up', 'Win+Down', 'Win+Z']),
    F('osd', 'Volume and brightness pop-up', ['VolumeUp', 'VolumeDown', 'VolumeMute'], [
      opt({ key: 'place', label: 'Where the pop-up shows', type: 'choice', choices: [{ value: 'bottom', label: 'Bottom' }, { value: 'top', label: 'Top' }], default: 'bottom', value: 'bottom' }),
    ]),
    F('notes', 'Quick notes (Win+Alt+N)', ['Win+Alt+N'], [
      opt({ key: 'folder', label: 'Notes folder', type: 'folder', default: null, value: 'C:\\Users\\you\\Documents\\Mantle Notes', isDefault: false, defaultLabel: 'Documents\\Mantle Notes' }),
    ]),
    F('ontop', 'Keep a window on top (Win+Ctrl+T)', ['Win+Ctrl+T'], [], { keys: false, keysReason: 'another app registered Win+Ctrl+T first, so Windows gave it to that app' }),
    F('corners', 'Hot corners', []),
    F('gamemode', 'Game mode (quick settings)', [], [
      opt({ key: 'auto', label: 'Turn on by itself when a game starts', type: 'bool', default: true, value: true }),
      opt({ key: 'liftSaver', label: 'Lift Energy saver while a game runs', type: 'bool', default: false, value: false }),
    ]),
    F('timer', 'Timer and stopwatch (top bar)', [], [
      opt({ key: 'sound', label: 'When a timer ends', type: 'choice', choices: [{ value: 'chime', label: 'Chime' }, { value: 'bell', label: 'Bell' }, { value: 'none', label: 'Silent' }], default: 'chime', value: 'bell', isDefault: false }),
    ]),
    F('topbar', 'Top bar', [], [
      opt({ key: 'clock', label: 'Clock', type: 'choice', choices: [{ value: '12', label: '12-hour' }, { value: '24', label: '24-hour' }, { value: '12s', label: '12-hour with seconds' }, { value: '24s', label: '24-hour with seconds' }], default: '12', value: '12' }),
      opt({ key: 'title', label: 'Menu title', help: 'The words at the left of the top bar', type: 'text', default: null, value: null, placeholder: 'The focused app\'s name', defaultLabel: 'The focused app\'s name' }),
    ]),
    F('downloads', 'Downloads shelf (bar)', []),
    F('settings', 'Mantle Settings (Win+I)', ['Win+I']),
  ];
  if (TM) features.push(F('taskmgr', 'Task manager', [], [], TM === 'off' ? { enabled: false, running: false } : TM === 'rest' ? { resting: 'VALORANT runs' } : {}));
  let switcher = { ok: true, reason: null, altTab: true, winKeys: true, altTabReason: null, winKeysReason: null };
  const SC = [
    ['Win+S', 'Search', 'search'], ['Win+V', 'Clipboard history', 'clipboard'], ['Win+Shift+S', 'Screenshot a region', 'screenshot'],
    ['PrintScreen', 'Screenshot the screen', 'screenshot'], ['Alt+Tab', 'Window switcher', 'switcher:altTab'], ['Win+N', 'Notification center', 'switcher:winKeys'],
    ['Win+A', 'Quick settings', 'switcher:winKeys'], ['Win+Left', 'Snap left', 'snap'], ['Win+Right', 'Snap right', 'snap'], ['Win+Z', 'Snap layouts', 'snap'],
    ['VolumeUp', 'Volume up, with the pop-up', 'osd'], ['Win+Alt+N', 'Quick notes', 'notes'], ['Win+Ctrl+T', 'Keep the window on top', 'ontop'], ['Win+I', 'Mantle Settings', 'settings'],
  ];
  function shortcuts() {
    return SC.map(([keys, what, own]) => {
      if (own.indexOf('switcher:') === 0) {
        const k = own.slice(9), on = !!switcher[k];
        return { keys, what, owner: 'switcher', ownerLabel: 'Window switcher', on, live: on, why: on ? null : 'switched off, so Windows handles it', toggle: { kind: 'switcher', key: k } };
      }
      const f = features.find((x) => x.name === own);
      const on = !!f.enabled, live = on && f.ok && f.keys !== false && !f.resting;
      return { keys, what, owner: own, ownerLabel: f.label.replace(/\s*\(.*\)$/, ''), on, live,
        why: live ? null : !on ? 'switched off, so Windows handles it' : f.keys === false ? f.keysReason : f.reason || 'resting', toggle: { kind: 'feature', feature: own } };
    });
  }
  const mantleView = () => ({ ok: true, features: JSON.parse(JSON.stringify(features)), switcher: Object.assign({}, switcher), shortcuts: shortcuts() });

  const corners = { enabled: true, test: TEST, actions: { tl: 'taskview', tr: 'off', bl: 'off', br: 'desktop' }, corners: ['tl', 'tr', 'bl', 'br'],
    names: { tl: 'top-left', tr: 'top-right', bl: 'bottom-left', br: 'bottom-right' },
    choices: [['off', 'Off'], ['taskview', 'Task view'], ['desktop', 'Show desktop'], ['launcher', 'Launcher'], ['qs', 'Quick settings'], ['lock', 'Lock screen']].map(([id, label]) => ({ id, label })),
    watching: true, watch: { ok: true, reason: null }, last: null, fails: {}, zone: 3, dwell: 250 };

  /* ---- startup apps ---- */
  const startup = [
    { item: 'run-user:CloudDrive', name: 'Cloud Drive', source: 'run-user', sourceLabel: 'Registry, your account', scope: 'user', command: '"C:\\Program Files\\Cloud Drive\\clouddrive.exe" /background', enabled: true, state: 'enabled', disabledAt: null, canToggle: true, reason: null },
    { item: 'folder-user:Chat App.lnk', name: 'Chat App', source: 'folder-user', sourceLabel: 'Startup folder, your account', scope: 'user', command: 'C:\\Users\\you\\AppData\\Local\\ChatApp\\chat.exe --minimized', enabled: true, state: 'default', disabledAt: null, canToggle: true, reason: null },
    { item: 'run-user:GameLauncher', name: 'Game Launcher', source: 'run-user', sourceLabel: 'Registry, your account', scope: 'user', command: '"C:\\Games\\Launcher\\launcher.exe" -silent -tray', enabled: false, state: 'disabled', disabledAt: now - 86400000 * 3, canToggle: true, reason: null },
    { item: 'run-machine:AudioHelper', name: 'Audio Helper (all users)', source: 'run-machine', sourceLabel: 'Registry, all users', scope: 'machine', command: 'C:\\Program Files\\Audio Helper\\helper.exe -s', enabled: true, state: 'enabled', disabledAt: null,
      canToggle: !ADMIN, reason: ADMIN ? 'Needs administrator: this entry is machine-wide' : null },
    { item: 'folder-machine:Keyboard K3 Utility.lnk', name: 'Keyboard K3 Utility', source: 'folder-machine', sourceLabel: 'Startup folder, all users', scope: 'machine', command: '"C:\\Program Files\\K3\\k3util.exe"', enabled: true, state: 'default', disabledAt: null,
      canToggle: !ADMIN, reason: ADMIN ? 'Needs administrator: this entry is machine-wide' : null },
  ];

  /* ---- the ms-settings catalog: the launcher's pages, with the ones this page covers marked ---- */
  const CAT = [
    ['Display', 'ms-settings:display', 'screen monitor resolution scale scaling brightness orientation refresh rate', 'display', 'display.monitors'],
    ['Sound', 'ms-settings:sound', 'audio volume speakers headphones microphone mic output input', 'sound', null],
    ['Bluetooth & devices', 'ms-settings:bluetooth', 'bt pair pairing wireless headphones earbuds controller', 'bluetooth', 'bluetooth.radio'],
    ['Wi-Fi', 'ms-settings:network-wifi', 'wifi wireless wlan ssid internet', 'network', 'network.wifi'],
    ['Network & internet', 'ms-settings:network', 'internet connection network status connectivity', 'network', 'network.status'],
    ['Installed apps', 'ms-settings:appsfeatures', 'uninstall remove programs apps and features add or remove', 'apps', 'apps.installed'],
    ['Personalization', 'ms-settings:personalization', 'customize look appearance'],
    ['Windows Update', 'ms-settings:windowsupdate', 'updates update check for updates patch upgrade pause updates'],
    ['Storage', 'ms-settings:storagesense', 'disk space drive storage sense free up space'],
    ['Power & battery', 'ms-settings:batterysaver', 'battery energy saver power mode battery saver', 'power', 'power.battery'],
    ['Privacy & security', 'ms-settings:privacy', 'permissions privacy app permissions'],
    ['Accounts', 'ms-settings:yourinfo', 'your info account profile picture microsoft account'],
    ['Date & time', 'ms-settings:dateandtime', 'clock time zone timezone date sync time'],
    ['Notifications', 'ms-settings:notifications', 'alerts banners toasts notification', 'notifications', null],
    ['Focus', 'ms-settings:quiethours', 'do not disturb dnd focus assist quiet hours', 'notifications', 'notifications.dnd'],
    ['Mouse', 'ms-settings:mousetouchpad', 'pointer speed scroll wheel buttons primary button'],
    ['Keyboard', 'ms-settings:keyboard', 'input method keyboard layout'],
    ['Default apps', 'ms-settings:defaultapps', 'default browser file associations open with file type', 'apps', 'apps.defaults'],
    ['Startup apps', 'ms-settings:startupapps', 'startup autostart launch at login run at startup boot', 'apps', 'apps.startup'],
    ['About this PC', 'ms-settings:about', 'system info specs rename pc pc name device name ram cpu processor windows version'],
    ['Multitasking', 'ms-settings:multitasking', 'snap windows snap layouts alt tab virtual desktops'],
    ['Night light', 'ms-settings:nightlight', 'blue light warm color evening night mode', 'display', 'display.nightlight'],
    ['HDR', 'ms-settings:display-hdr', 'hdr high dynamic range'],
    ['Graphics', 'ms-settings:display-advancedgraphics', 'gpu graphics performance preference'],
    ['Volume mixer', 'ms-settings:apps-volume', 'app volume per app volume mixer', 'sound', 'sound.mixer'],
    ['Sound devices', 'ms-settings:sound-devices', 'audio devices output devices input devices', 'sound', 'sound.output'],
    ['Screen and sleep', 'ms-settings:powersleep', 'sleep timeout screen timeout turn off display power plan'],
    ['Clipboard', 'ms-settings:clipboard', 'clipboard history copy paste'],
    ['Devices', 'ms-settings:connecteddevices', 'connected devices add device'],
    ['Game controllers', 'ms-settings:devices-gamecontroller', 'gamepad controller joystick'],
    ['VPN', 'ms-settings:network-vpn', 'virtual private network'],
    ['Airplane mode', 'ms-settings:network-airplanemode', 'flight mode offline'],
    ['Known Wi-Fi networks', 'ms-settings:network-wifisettings', 'saved networks forget network'],
    ['Background', 'ms-settings:personalization-background', 'wallpaper desktop background picture slideshow'],
    ['Colors', 'ms-settings:colors', 'dark mode light mode accent color theme transparency'],
    ['Themes', 'ms-settings:themes', 'theme desktop icons cursor'],
    ['Lock screen', 'ms-settings:lockscreen', 'lock screen picture spotlight'],
    ['Taskbar', 'ms-settings:taskbar', 'taskbar alignment system tray icons'],
    ['Fonts', 'ms-settings:fonts', 'font typeface install fonts'],
    ['Sign-in options', 'ms-settings:signinoptions', 'password pin windows hello fingerprint face login sign in'],
    ['Language & region', 'ms-settings:regionlanguage', 'language region locale format display language'],
    ['Game Mode', 'ms-settings:gaming-gamemode', 'gaming performance'],
    ['Text size', 'ms-settings:easeofaccess-display', 'bigger text font size make text bigger'],
    ['Color filters', 'ms-settings:easeofaccess-colorfilter', 'colorblind color blind grayscale'],
  ].map(([name, uri, keywords, section, row]) => ({ name, uri, keywords, section: section || null, row: row || null }));

  /* ---- the bridge ---- */
  const handlers = {};
  window.__mockCalls = [];
  const emit = (ev, p) => (handlers[ev] || []).forEach((fn) => fn(p));
  window.__mockEmit = emit;
  const later = (ms, v) => new Promise((res) => setTimeout(() => res(v), ms));
  const boom = (why) => Promise.reject(new Error(why));
  const featureOf = (name) => features.find((f) => f.name === name);

  /* ---- Mantle's own light/dark (main.js theme.get / theme.set, the 'theme' event, the preload's paint) ---- */
  const LOOK = q.get('theme') === 'dark' || q.get('theme') === 'light' ? q.get('theme') : null;
  const look = { mode: 'system', windows: LOOK || 'dark' };
  const themeNow = () => {
    const theme = look.mode === 'system' ? (look.windows || 'light') : look.mode;
    return { ok: true, mode: look.mode, theme, windows: look.windows,
      windowsWhy: look.windows ? null : 'made up: Windows\' app mode could not be read (the Personalize key is missing)', pinned: null, note: null, reason: null };
  };
  const paintLook = (theme) => {
    document.documentElement.dataset.theme = theme;
    window.dispatchEvent(new CustomEvent('mantle-theme', { detail: { theme } }));
  };
  if (LOOK) document.documentElement.dataset.theme = LOOK;
  const lookChanged = () => { const t = themeNow(); paintLook(t.theme); setTimeout(() => { emit('theme', t); emitShared(); }, 5); return t; };
  window.__mockWindowsMode = (w) => { look.windows = w === 'dark' || w === 'light' ? w : null; return lookChanged(); };

  /* ---- look sync with Helm and Quartz (main's look.get / look.sync / look.glass / look.accent, the 'look'
     event, always the whole VIEW). Validates like main: blurPx 0..64, dim 0.2..0.9, panel -0.3..0.15, hue
     null or an integer 0..360. mock=failing: every look.* answers ok:false.
     window.__mockLook(patch) plays a change made in Helm or Quartz: it merges patch (theme, sync, glass,
     accent, desktop, windows, guard; objects merge one level) into the VIEW and emits 'look'.
     window.__mockLookRefuse(reason | null): the next look.* writes answer ok:false with that reason. */
  const shared = {
    sync: { on: true, state: 'ok', text: null, reason: null, rev: 40, by: 'Quartz', at: '2026-10-10T09:00:00Z' },
    glass: { blurPx: 5, dim: 0.5, panel: 0 }, glassLight: { blurPx: 12, dim: 0.45, panel: 0 }, accent: { hue: null },
    desktop: { ok: true, text: 'Shared with Helm and Quartz: "Snow peak" (rev 41)', reason: null, rev: 41, id: 'builtin:snow-peak', title: 'Snow peak', type: 'picture' },
    windows: { ok: true, text: 'Windows\' wallpaper matches', reason: null },
    guard: { ok: true, working: false, text: 'Top band darkened to 54% for Helm, Quartz and Mantle', reason: null, alpha: 0.54, contrast: 4.32 },
    theme: null, refuse: null,
  };
  const syncText = (s) => (s.text != null ? s.text : !s.on ? 'Off: Mantle keeps its own look' : 'On · in sync (last change from ' + (s.by || 'Mantle') + ', just now)');
  /* the sliders edit the glass of the look Mantle shows now (shared.glass = dark, shared.glassLight = light), like main */
  const lookNow = () => ((shared.theme || themeNow().theme) === 'light' ? 'light' : 'dark');
  const lookView = () => ({ ok: true, theme: shared.theme || themeNow().theme,
    sync: Object.assign({}, shared.sync, { state: shared.sync.on ? shared.sync.state : 'off', text: syncText(shared.sync) }),
    glass: Object.assign({}, lookNow() === 'light' ? shared.glassLight : shared.glass), glassLook: lookNow(),
    glassBoth: { dark: Object.assign({}, shared.glass), light: Object.assign({}, shared.glassLight) }, ranges: { blurPx: [0, 64], dim: [0.2, 0.9], panel: [-0.3, 0.15] }, accent: Object.assign({}, shared.accent),
    desktop: Object.assign({}, shared.desktop), windows: Object.assign({}, shared.windows), guard: Object.assign({}, shared.guard) });
  const emitShared = () => emit('look', lookView());
  const mine = () => { shared.sync = Object.assign({}, shared.sync, { rev: (shared.sync.rev || 0) + 1, by: 'Mantle', at: new Date().toISOString(), text: null }); };
  window.__mockLook = (patch) => {
    for (const k of Object.keys(patch || {})) {
      shared[k] = patch[k] && typeof patch[k] === 'object' && shared[k] && typeof shared[k] === 'object' ? Object.assign({}, shared[k], patch[k]) : patch[k];
    }
    emitShared();
    return lookView();
  };
  window.__mockLookRefuse = (reason) => { shared.refuse = reason || null; };
  const sent = (x) => JSON.stringify(x === undefined ? null : x);
  function lookCmd(name, a) {
    if (FAIL) return { ok: false, reason: 'made up: the shared look file could not be read (look.json is locked by another program)' };
    if (name === 'look.get') return lookView();
    if (shared.refuse) return { ok: false, reason: shared.refuse };
    if (name === 'look.sync') {
      if (typeof a.on !== 'boolean') return { ok: false, reason: 'Pick on or off (Mantle was sent ' + sent(a.on) + ')' };
      shared.sync = Object.assign({}, shared.sync, { on: a.on, state: 'ok', reason: null, text: null });
      if (a.on) mine();
    } else {
      if (shared.sync.on && shared.sync.state === 'newer') return { ok: false, reason: shared.sync.reason || 'a newer Helm or Quartz wrote the shared look' };
      if (name === 'look.glass') {
        const R = { blurPx: [0, 64, 'Blur must be 0 to 64 px'], dim: [0.2, 0.9, 'Bar tint must be 20% to 90%'], panel: [-0.3, 0.15, 'Panel opacity must be 53% to 98%'] };
        if (a.look !== undefined && a.look !== 'light' && a.look !== 'dark') return { ok: false, reason: 'the glass change named no look (light or dark)' };
        const look = a.look || lookNow();
        const keys = Object.keys(a).filter((k) => k in R);
        if (!keys.length) return { ok: false, reason: 'Nothing to change (Mantle was sent ' + sent(a) + ')' };
        for (const k of keys) if (typeof a[k] !== 'number' || !isFinite(a[k]) || a[k] < R[k][0] || a[k] > R[k][1]) return { ok: false, reason: R[k][2] + ' (Mantle was sent ' + sent(a[k]) + ')' };
        const g = Object.assign({}, look === 'light' ? shared.glassLight : shared.glass);
        keys.forEach((k) => { g[k] = a[k]; });
        if (look === 'light') shared.glassLight = g; else shared.glass = g;
      } else if (name === 'look.accent') {
        if (!(a.hue === null || (Number.isInteger(a.hue) && a.hue >= 0 && a.hue <= 360))) return { ok: false, reason: 'A hue must be a whole number from 0 to 360, or none (Mantle was sent ' + sent(a.hue) + ')' };
        shared.accent = { hue: a.hue };
      } else return { ok: false, reason: 'the mock does not play ' + name };
      if (shared.sync.on) mine();
    }
    setTimeout(emitShared, 5);
    return lookView();
  }

  function answer(name, a) {
    a = a || {};
    switch (name) {
      case 'settings.hello': return { ok: true, section: q.get('section') || 'home', page: q.get('page') || null, row: q.get('row') || null, query: q.get('q') || null, test: TEST, glass: GLASS };
      // section modules: ?sections=a,b loads the FIXTURES in test-sections/ (never sections/, which
      // belongs to the category lanes); an id ending in "!" is DOWN on the main side
      case 'settings.sections': if (REAL.length) return { ok: true, reason: null, sections: REAL.map((id) => ({ id, file: 'sections/' + id + '.js', down: null, main: null })) };
        return { ok: true, reason: null, sections: SECS.map((id) => (id.endsWith('!')
        ? { id: id.slice(0, -1), file: null, down: 'lib/features/_settings-sections/' + id.slice(0, -1) + '.js did not load (mock: main-side boom)', main: { ok: false, reason: 'mock: main-side boom', commands: [] } }
        : { id, file: 'test-sections/' + id + '.js', down: null, main: null })) };
      case 'settings.pickPath': return TEST ? { ok: false, reason: 'a test run never opens a folder dialog', path: null, cancelled: false } : later(200, { ok: true, cancelled: false, reason: null, path: 'D:\\Made-up folder' });
      case 'settings.mantle': return FAIL ? boom('settings.mantle: the settings feature is not running (it failed to start: the feature seam threw)') : mantleView();
      case 'settings.enable': {
        const f = featureOf(a.feature);
        if (!f) return { ok: false, reason: 'there is no feature named "' + a.feature + '"' };
        f.enabled = !!a.on; f.running = !!a.on;
        setTimeout(() => emit('settings.changed', { what: 'features' }), 20);
        return later(120, { ok: true, reason: null, feature: JSON.parse(JSON.stringify(f)) });
      }
      case 'settings.option': {
        const f = featureOf(a.feature), o = f && f.options.find((x) => x.key === a.key);
        if (!o) return { ok: false, reason: 'that option does not exist' };
        if (o.type === 'number' && a.value !== null && (a.value < o.min || a.value > o.max)) return { ok: false, reason: o.label + ' must be between ' + o.min + ' and ' + o.max, option: Object.assign({}, o) };
        o.value = a.value === null ? o.default : a.value;
        o.isDefault = o.value === o.default;
        return later(80, { ok: true, reason: null, option: Object.assign({}, o) });
      }
      case 'settings.pickFolder': {
        const f = featureOf(a.feature), o = f && f.options.find((x) => x.key === a.key);
        if (TEST) return { ok: false, reason: 'refused in a test run: a folder dialog would wait for a person', cancelled: false, option: o ? Object.assign({}, o) : null };
        return later(300, { ok: true, reason: null, cancelled: true, option: o ? Object.assign({}, o) : null });
      }
      case 'settings.switcher':
        if ('altTab' in a) switcher.altTab = !!a.altTab;
        if ('winKeys' in a) switcher.winKeys = !!a.winKeys;
        return later(80, { ok: true, reason: null, switcher: Object.assign({}, switcher) });
      case 'settings.about': return FAIL ? boom('settings.about: the settings feature is not running') : {
        ok: true, version: '0.9.14', commit: 'a1b2c3d4e5f60718', commitReason: null, startedAt: now - (3 * 3600 + 4 * 60) * 1000, uptimeMs: (3 * 3600 + 4 * 60) * 1000,
        mode: TEST ? 'test' : 'live', logFile: 'C:\\Users\\you\\AppData\\Roaming\\Mantle\\logs\\mantle.log', logDir: 'C:\\Users\\you\\AppData\\Roaming\\Mantle\\logs',
        electron: '44.0.0', chrome: '146.0.7300.0', node: '24.4.0', windows: '10.0.26200', glass: GLASS };
      case 'settings.openLogs': return { ok: true, reason: null, dryRun: TEST };
      case 'settings.openWindows': return { ok: true, reason: null, dryRun: TEST };
      case 'settings.catalog': return FAIL ? { ok: false, reason: 'the launcher\'s settings catalog is not loaded yet' } : { ok: true, items: CAT.map((x) => Object.assign({}, x)) };
      case 'settings.displays': return FAIL ? { ok: false, reason: 'the displays could not be read: ' + SIDECAR, displays: [] } : { ok: true, reason: null, displays: [
        { label: 'Built-in display', primary: true, internal: true, width: 2560, height: 1600, scalePercent: 150, hz: 120, rotation: 0 },
        { label: 'External monitor', primary: false, internal: false, width: 1920, height: 1080, scalePercent: 100, hz: 60, rotation: 0 }] };
      case 'settings.startup':
        if (FAIL) return { ok: false, reason: 'the startup list cannot be read: ' + SIDECAR, items: [] };
        return { ok: true, reason: null, elevated: !ADMIN, items: startup.map((x) => Object.assign({}, x)),
          problems: ADMIN ? ['The all-users entries (HKLM and the all-users Startup folder) can only be switched by an administrator: Mantle is not running elevated'] : [] };
      case 'settings.startupSet': {
        const it = startup.find((x) => x.item === a.item);
        if (!it) return { ok: false, reason: 'that startup entry is gone (it may have been removed)' };
        if (!it.canToggle) return { ok: false, reason: it.reason, item: Object.assign({}, it) };
        if (TEST) return later(100, { ok: true, reason: null, dryRun: true, item: Object.assign({}, it) });
        it.enabled = !!a.on; it.state = a.on ? 'enabled' : 'disabled'; it.disabledAt = a.on ? null : Date.now();
        return later(100, { ok: true, reason: null, dryRun: false, item: Object.assign({}, it) });
      }
      case 'settings.window': return { ok: true, maximized: a.op === 'maximize' ? !window.__mockMax && (window.__mockMax = true) : false };
      case 'taskmgr.open': return { ok: true };
      case 'features.list': return FAIL ? boom('features.list: the feature seam is not running') : features.map((f) => ({ name: f.name, label: f.label, chords: f.chords, enabled: f.enabled, ok: f.ok, reason: f.reason, running: f.running, stopped: false, resting: f.resting, commands: f.name === 'taskmgr' ? ['taskmgr.open', 'taskmgr.state'] : [f.name + '.state'] }));
      case 'corners.state': return FAIL ? boom('corners.state: the hot corners feature is not running') : JSON.parse(JSON.stringify(corners));
      case 'corners.set': corners.actions[a.corner] = a.action; return Object.assign({ ok: true }, JSON.parse(JSON.stringify(corners)));
      case 'qs.get': return snap();
      case 'qs.watch': return { ok: true, watching: !!a.on, via: 'mock', leaseMs: 60000, reason: null };
      case 'qs.set': {
        const key = a.part === 'mute' ? 'volume' : a.part, p = qs[key];
        if (!p) return { ok: false, part: a.part, value: null, state: null, reason: 'qs.set does not know the part "' + a.part + '"' };
        if (FAIL || p.ok === false) return later(60, { ok: false, part: a.part, value: null, state: Object.assign({}, p), reason: (key === 'brightness' ? 'the screen brightness' : key) + ' could not be changed: ' + SIDECAR });
        if (a.part === 'volume' || a.part === 'brightness') p.level = Math.round(a.value);
        else if (a.part === 'mute') p.muted = !!a.value;
        else p.on = !!a.value;
        if (a.part === 'wifi' && !a.value) { p.connected = false; p.ssid = null; }
        return later(a.part === 'wifi' || a.part === 'bluetooth' ? 300 : 30, { ok: true, part: a.part, value: a.part === 'mute' ? p.muted : 'level' in p && (a.part === 'volume' || a.part === 'brightness') ? p.level : p.on, state: Object.assign({}, p), reason: null });
      }
      case 'theme.get': return FAIL ? later(30, { ok: false, reason: 'made up: Mantle\'s settings file could not be read (it is locked by another program)' }) : later(20, themeNow());
      case 'theme.set':
        if (FAIL) return later(30, { ok: false, reason: 'made up: Mantle\'s settings file could not be written (it is locked by another program)' });
        if (!['light', 'dark', 'system'].includes(a.mode)) return { ok: false, reason: 'Pick Light, Dark or Match Windows (Mantle was sent ' + JSON.stringify(a.mode === undefined ? null : a.mode) + ')' };
        look.mode = a.mode;
        return later(40, Object.assign({}, lookChanged(), { value: a.mode }));
      case 'look.get': case 'look.sync': case 'look.glass': case 'look.accent': return later(30, lookCmd(name, a));
      case 'volume.get': return Object.assign({}, qs.volume);
      case 'net.get': return JSON.parse(JSON.stringify(net));
      case 'battery.get': return Object.assign({}, battery);
      case 'powermode.get': return Object.assign({}, pm);
      case 'powermode.set':
        if (!pm.ok) return { ok: false, mode: a.mode, state: Object.assign({}, pm), reason: pm.reason };
        pm = Object.assign({}, pm, { mode: a.mode });
        setTimeout(() => emit('powermode', Object.assign({ via: 'set' }, pm)), 5);
        return later(60, { ok: true, mode: a.mode, state: Object.assign({}, pm), reason: null });
      case 'gamemode.state': return FAIL ? boom('gamemode.state: the game mode feature is not running') : Object.assign({}, gm);
      case 'qs.audio.devices': return FAIL ? { ok: false, devices: [], reason: 'the playback devices cannot be read: ' + SIDECAR }
        : { ok: true, reason: null, defaultId: defDev, devices: devices.map((d) => ({ id: d.id, name: d.name, isDefault: d.id === defDev })) };
      case 'qs.audio.default': defDev = a.device; return later(120, { ok: true, reason: null });
      case 'qs.audio.sessions': return FAIL ? { ok: false, sessions: [], reason: 'the apps playing sound cannot be read: the output device refused the session manager (HRESULT 0x88890004)' }
        : { ok: true, reason: null, device: { id: defDev, name: devices.find((d) => d.id === defDev).name }, sessions: sessions.map((s) => Object.assign({}, s)) };
      case 'qs.audio.session': {
        const s = sessions.find((x) => x.key === a.key);
        if (!s) return { ok: false, reason: 'that app has no audio session on the current output any more' };
        if (typeof a.level === 'number') s.level = Math.round(a.level);
        if (typeof a.muted === 'boolean') s.muted = a.muted;
        return { ok: true, key: s.key, session: { key: s.key, level: s.level, muted: s.muted }, reason: null };
      }
      case 'qs.bt.list': return btList();
      case 'qs.bt.watch': return { ok: true, watching: !!a.on, reason: null };
      case 'qs.bt.connect': case 'qs.bt.disconnect': {
        const d = btDevs.find((x) => x.id === a.device), c = name === 'qs.bt.connect';
        if (!d) return { ok: false, reason: 'Windows does not know that Bluetooth device' };
        return later(1200, null).then(() => { d.connected = c; if (c && d.kind === 'speaker') d.battery = 55; setTimeout(() => emit('btdevices', btList()), 30); return { ok: true, op: c ? 'connect' : 'disconnect', device: d.id, connected: c, reason: null }; });
      }
      case 'qs.wifi.list': return wifiList();
      case 'qs.wifi.scan': return later(900, { ok: true, reason: null });
      case 'qs.wifi.connect': {
        const hadPw = typeof a.password === 'string' && a.password.length > 0;
        delete a.password;                           // never kept, never logged
        const n = nets.find((x) => (a.hex ? hex(x.ssid) === a.hex : x.ssid === a.ssid));
        if (!n) return { ok: false, reason: 'that network is not in range any more; refresh and try again' };
        if (n.action === 'password' && !hadPw) return { ok: false, reason: '"' + n.ssid + '" needs its password' };
        return later(1400, null).then(() => {
          nets.forEach((x) => { x.connected = x === n; });
          n.known = true; qs.wifi.connected = true; qs.wifi.ssid = n.ssid;
          return { ok: true, ssid: n.ssid, connected: true, reason: null };
        });
      }
      case 'qs.wifi.disconnect': nets.forEach((x) => { x.connected = false; }); qs.wifi.connected = false; return later(400, { ok: true, reason: null });
      default:
        // a fixture section's main-side command: settings.<id>.<name> answers with what it was sent
        if (/^settings\.[a-z][a-z0-9-]*\.[A-Za-z]\w*$/.test(name)) {
          if (REAL.length) return later(60, { ok: false, reason: 'made up: this category\'s data is not played on the overview mock' });
          if (/\.fail$/.test(name)) return later(120, { ok: false, reason: 'mock: this switch cannot move (the service is stopped)' });
          if (/\.admin$/.test(name)) return later(120, { ok: false, reason: 'Mantle cannot ask for administrator rights yet' });
          return later(120, Object.assign({ ok: true, reason: null, dryRun: TEST || undefined }, a && 'value' in a ? { value: a.value } : {}, TEST ? { reason: 'test run: nothing was changed' } : {}));
        }
        return { ok: false, reason: 'the mock does not play ' + name };
    }
  }

  window.mantle = {
    on(ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn); return () => {}; },
    call(name, args) {
      // the bridge copies arguments (structured clone); a password never reaches the call log
      const copy = args && typeof args === 'object' ? JSON.parse(JSON.stringify(args)) : args;
      const logged = copy && typeof copy === 'object' ? Object.assign({}, copy) : copy;
      if (logged && logged.password) logged.password = '(redacted)';
      window.__mockCalls.push({ name, args: logged });
      try { return Promise.resolve(answer(name, copy)); } catch (e) { return Promise.reject(e); }
    },
  };
}());

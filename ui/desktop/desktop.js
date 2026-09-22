'use strict';
/*
  The desktop layer's script.

  A plain browser script: contextIsolation and sandbox are on, so there is no
  require() and no node here. window.mantle, put up by preload.js, is the only
  way to reach the main process.

  THEME. This layer wears the taskbar's glass (Owen, 2026-09-21: "everything that
  we build for this wrapper, their UI needs to be this exact same theme as the
  taskbar"), so the only thing this file does about looks is hand desktop.css the
  wallpaper to put behind the panes -- see THE BACKDROP below. Colour is entirely
  desktop.css's business, and it takes all of it from ../shared/glass-light.css.

  Timers, and that is all this page ever does:
    the clock        once a second, aligned to the second boundary, paused while
                     the document is hidden
    the stats        every 5 seconds
    Mission Control  every 30 seconds

  THE BACKDROP. Main sends 'desktop.backdrop' {png, w, h, rect, ms} ONCE at start
  and again after a display change: one capture of the whole screen, wallpaper
  only, downscaled 8x. Because it is a single picture of the whole screen, this
  file does not hand a picture to each pane -- it parks the PNG on <html> as the
  --desktop-backdrop custom property and desktop.css paints that one image in
  every .bdrop at 100vw x 100vh with background-attachment: fixed, so each pane
  shows exactly the wallpaper that is under it. body.no-backdrop is the honest
  fallback state (on at boot, off from the first good picture): the panes thicken
  their tint so they are still panes. Main's own view of it arrives as the
  'backdrop.desktop' {ok, ms, reason} piece of state, and when that says ok:false
  the reason goes in the "Needs attention" strip with everything else.

  Nothing animates. Every failure ends up as a sentence on screen -- "unavailable"
  with no reason is exactly what this page is not allowed to show.
*/
(function () {
  const $ = (id) => document.getElementById(id);

  const els = {
    clockHm: $('clock-hm'),
    clockSs: $('clock-ss'),
    clockMer: $('clock-mer'),
    date: $('date'),
    cpu: $('cpu'),
    mem: $('mem'),
    batteryRow: $('battery-row'),
    battery: $('battery'),
    statsNote: $('stats-note'),
    mcFrame: $('mc-frame'),
    mcNote: $('mc-note'),
    mcHeadNote: $('mc-head-note'),
    strip: $('strip'),
    stripList: $('strip-list'),
    stripMode: $('strip-mode'),
  };

  // ---------------------------------------------------------------------
  // Clock. 12-hour with seconds and a meridiem suffix, Windows style:
  // "4:15:32 PM" (Owen, 2026-09-21: "i dont want it in military time and i want
  // the time to the second").
  //
  // It is on screen every waking hour, so the tick is as small as a tick gets:
  // a chained setTimeout aimed at the next SECOND boundary (never setInterval,
  // which drifts and fires in bursts after a suspend), and a write only to the
  // text that actually changed -- the seconds every tick, the hour/minute once a
  // minute, the meridiem twice a day, the date once a day. The layout cannot
  // move while it runs: tabular-nums and the min-widths in desktop.css.
  //
  // AM/PM is computed here rather than taken from toLocaleTimeString, because a
  // machine on a 24-hour locale would silently put this clock back into the
  // military time Owen just asked to be rid of.
  // ---------------------------------------------------------------------
  const shown = { hm: '', ss: '', mer: '', day: -1 };
  let clockTimer = 0;

  function pad2(n) { return n < 10 ? '0' + n : String(n); }

  function paintClock() {
    const now = new Date();
    const h24 = now.getHours();
    const mer = h24 < 12 ? 'AM' : 'PM';
    const h = (h24 % 12) === 0 ? 12 : (h24 % 12);   // 0 -> 12, and no leading zero
    const hm = h + ':' + pad2(now.getMinutes());
    const ss = pad2(now.getSeconds());
    if (ss !== shown.ss) { shown.ss = ss; els.clockSs.textContent = ss; }
    if (hm !== shown.hm) { shown.hm = hm; els.clockHm.textContent = hm; }
    if (mer !== shown.mer) { shown.mer = mer; els.clockMer.textContent = mer; }
    const day = now.getDate();
    if (day !== shown.day) {
      shown.day = day;
      els.date.textContent = now.toLocaleDateString(undefined, {
        weekday: 'long', day: 'numeric', month: 'long',
      });
    }
    return now;
  }

  function startClock() {
    clearTimeout(clockTimer);
    const now = paintClock();
    // re-aimed at the boundary after every tick, so it never drifts. The floor
    // is there so a clock that is woken a hair early cannot spin.
    clockTimer = setTimeout(startClock, Math.max(60, 1000 - now.getMilliseconds()));
  }
  startClock();

  // Occluded by a maximised window (or minimised): stop ticking entirely, and on
  // the way back paint before re-aiming, so a resumed clock is never a second
  // late. Deliberately NOT keyed off visibilityState at load: if the event never
  // fires here, the clock keeps running, which is the safe way round.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { clearTimeout(clockTimer); clockTimer = 0; }
    else startClock();
  });

  // ---------------------------------------------------------------------
  // No bridge at all. Nothing else on this page can work, so say exactly that
  // rather than leaving three tiles showing em-dashes forever. (The clock above
  // needs nobody, so it is already running.)
  // ---------------------------------------------------------------------
  if (!window.mantle || typeof window.mantle.call !== 'function') {
    els.strip.hidden = false;
    els.strip.classList.add('fatal');
    els.stripList.replaceChildren(row(
      'The Mantle bridge is missing',
      'window.mantle was not injected, so this page cannot read anything from Mantle. preload.js failed to load — check the terminal Mantle was started from.'
    ));
    els.mcNote.textContent = 'Cannot check Mission Control without the Mantle bridge.';
    els.statsNote.hidden = false;
    els.statsNote.textContent = 'Cannot read system stats without the Mantle bridge.';
    return;   // body.no-backdrop stays on: the panes carry themselves on the fallback tint
  }

  // ---------------------------------------------------------------------
  // System stats.
  // ---------------------------------------------------------------------
  function gib(bytes) {
    return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
  }

  async function tickStats() {
    try {
      const s = await window.mantle.call('sys.stats');
      els.cpu.textContent = s.cpu + '%';
      els.mem.textContent = gib(s.memUsed) + ' / ' + gib(s.memTotal);

      if (s.battery) {
        els.batteryRow.hidden = false;
        els.battery.textContent = s.battery.percent + '%' + (s.battery.charging ? ' · charging' : '');
        els.statsNote.hidden = true;
      } else {
        els.batteryRow.hidden = true;
        // "No battery line" has two very different causes and the tile has to
        // distinguish them: a desktop PC, or a reading that failed.
        const why = s.batteryReason;
        if (why && why !== 'this machine reports no battery' && why !== 'ok') {
          els.statsNote.hidden = false;
          els.statsNote.textContent = 'Battery: ' + why;
        } else {
          els.statsNote.hidden = true;
        }
      }
    } catch (err) {
      els.cpu.textContent = '—';
      els.mem.textContent = '—';
      els.batteryRow.hidden = true;
      els.statsNote.hidden = false;
      els.statsNote.textContent = 'System numbers unavailable: ' + err.message;
    }
  }
  tickStats();
  setInterval(tickStats, 5000);

  // ---------------------------------------------------------------------
  // Mission Control (the local dashboard on 127.0.0.1:7373).
  //
  // The iframe is mounted only while the dashboard actually answers, and taken
  // down again the moment it stops -- an <iframe> pointed at a dead port shows a
  // Chromium error page, which is the blank tile this is meant to avoid. The
  // probe runs in the main process because a fetch() from here can only ever
  // report "Failed to fetch"; main gets the real ECONNREFUSED.
  // ---------------------------------------------------------------------
  const MC_ORIGIN = 'http://127.0.0.1:7373';
  let mcMounted = false;

  function mountMissionControl() {
    if (mcMounted) return;
    mcMounted = true;
    const frame = document.createElement('iframe');
    frame.src = MC_ORIGIN + '/';
    frame.setAttribute('title', 'Mission Control');
    frame.setAttribute('scrolling', 'no');
    els.mcFrame.replaceChildren(frame);
    els.mcFrame.hidden = false;
    els.mcNote.hidden = true;
    els.mcHeadNote.textContent = '· live';
    els.mcHeadNote.classList.add('live');   // the one --lg-acc mark on this layer
  }

  function unmountMissionControl(reason) {
    mcMounted = false;
    els.mcFrame.replaceChildren();
    els.mcFrame.hidden = true;
    els.mcHeadNote.textContent = '';
    els.mcHeadNote.classList.remove('live');
    els.mcNote.hidden = false;
    els.mcNote.textContent = 'Mission Control offline: ' + reason + '. Retrying every 30s.';
  }

  async function probeMissionControl() {
    try {
      const r = await window.mantle.call('net.probe', { url: MC_ORIGIN + '/' });
      if (r && r.ok) mountMissionControl();
      else unmountMissionControl((r && r.reason) || 'it did not answer and did not say why');
    } catch (err) {
      unmountMissionControl(err.message);
    }
  }
  probeMissionControl();
  setInterval(probeMissionControl, 30000);

  // ---------------------------------------------------------------------
  // The state strip: every piece of Mantle that is not doing its job, with the
  // reason. Hidden entirely when everything is fine.
  // ---------------------------------------------------------------------
  const PIECES = [
    ['sidecar', 'Sidecar', (p) => p.status === 'ok'],
    // 'taskbar' is healthy when Windows' own taskbar is on AUTO-HIDE -- Mantle
    // never hides that window any more; hiding it is what cost Owen a reboot on
    // 2026-09-21. 'workarea' is healthy when Mantle's bar is registered as a real
    // app bar, which is a reservation Explorer drops by itself if Mantle dies.
    ['taskbar', 'Windows taskbar', (p) => p.autohide === true],
    ['workarea', 'Screen space for the bar', (p) => p.reserved === true],
    ['desktop', 'Desktop layer', (p) => p.attached === true],
    ['hotkey', 'Win key', (p) => p.winTap === true],
    ['tray', 'Notification area', (p) => p.status === 'ok'],
    // 'acrylic-blur-behind' is a real Windows backdrop blurring what is actually
    // behind the bar and launcher. 'none' means only whatever the pages paint in
    // CSS -- because --no-acrylic asked for it, or because the sidecar could not
    // apply it -- and the reason says which.
    ['glass', 'Window glass', (p) => p.material === 'acrylic-blur-behind'],
    ['shortcuts', 'Shortcuts', (p) => p.killSwitch === true && p.launcher === true],
    // main's own view of the wallpaper capture these panes are frosted with. Not
    // ok means the panes are on the thicker fallback tint, and this row is the
    // only place that says why.
    ['backdrop.desktop', 'Pane backdrop', (p) => p.ok === true],
  ];

  function row(title, reason) {
    const li = document.createElement('li');
    const pip = document.createElement('span');
    pip.className = 'pip';
    const text = document.createElement('span');
    const b = document.createElement('b');
    b.textContent = title;
    text.appendChild(b);
    text.appendChild(document.createTextNode(' — ' + reason));
    li.appendChild(pip);
    li.appendChild(text);
    return li;
  }

  // A piece may be keyed flat ('backdrop.desktop') or nested (backdrop.desktop),
  // and which one main sends is not worth guessing at: try the flat key, then
  // walk the dots.
  function pieceOf(st, key) {
    if (st[key] && typeof st[key] === 'object') return st[key];
    let cur = st;
    for (const part of key.split('.')) {
      if (!cur || typeof cur !== 'object') return null;
      cur = cur[part];
    }
    return cur && typeof cur === 'object' ? cur : null;
  }

  let lastState = null;

  function renderState(st) {
    if (st) lastState = st;
    const s = lastState || {};
    const rows = [];
    let saidBackdrop = false;
    for (const [key, label, ok] of PIECES) {
      const piece = pieceOf(s, key);
      if (!piece || typeof piece !== 'object') continue;
      // main says there is no picture: the panes fall back whatever this page
      // thinks it is holding, because what it holds is now wrong or nothing.
      if (key === 'backdrop.desktop' && piece.ok !== true) document.body.classList.add('no-backdrop');
      if (ok(piece)) continue;
      if (key === 'backdrop.desktop') saidBackdrop = true;
      rows.push(row(label, piece.reason || 'no reason given, which is itself a bug'));
    }
    // ...and the failure this page had with a picture that DID arrive, which no
    // state piece can know about. Only when main is not already saying it, so
    // one broken backdrop is one row.
    if (backdropIssue && !saidBackdrop) rows.push(row('Pane backdrop', backdropIssue));
    if (!rows.length) {
      els.strip.hidden = true;
      els.stripList.replaceChildren();
      return;
    }
    // The count lives in the heading because the list itself scrolls in a short
    // window: "3 things" with two rows visible is honest, a list that just ends
    // is not.
    const mode = s.mode === 'test' ? 'test mode · ' : '';
    els.stripMode.textContent = '· ' + mode + rows.length + (rows.length === 1 ? ' thing' : ' things');
    els.stripList.replaceChildren.apply(els.stripList, rows);
    els.strip.hidden = false;
  }

  // ---------------------------------------------------------------------
  // The backdrop: one picture of the whole screen, parked on <html> for the CSS
  // to paint under every pane. See the header.
  // ---------------------------------------------------------------------
  const PNG_URL = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;
  let backdropIssue = '';

  function failBackdrop(reason) {
    backdropIssue = reason;
    document.body.classList.add('no-backdrop');
    console.warn('[desktop] backdrop:', reason);
    renderState(null);
  }

  function setBackdrop(p) {
    if (!p || typeof p.png !== 'string' || !PNG_URL.test(p.png)) {
      failBackdrop('desktop.backdrop arrived without a usable png data URL' +
        (p && p.reason ? ' (' + p.reason + ')' : '') +
        ', so the panes are showing the thicker fallback tint instead of the wallpaper');
      return;
    }
    const root = document.documentElement;
    root.style.setProperty('--desktop-backdrop', 'url("' + p.png + '")');
    // The CSSOM is not policed by this page's CSP, but a property that silently
    // failed to stick would look exactly like a picture that never arrived, so
    // it is read back once per capture rather than assumed.
    if (!getComputedStyle(root).getPropertyValue('--desktop-backdrop').trim()) {
      failBackdrop('the wallpaper picture could not be attached to this page: the ' +
        '--desktop-backdrop property did not stick, so the panes are on the fallback tint');
      return;
    }
    backdropIssue = '';
    document.body.classList.remove('no-backdrop');
    console.log('[desktop] backdrop', (p.w || '?') + 'x' + (p.h || '?'),
      'captured in', (p.ms != null ? p.ms + 'ms' : 'an unreported time'));
    renderState(null);
  }

  // Fires immediately with the current state, then on every change.
  if (typeof window.mantle.on === 'function') {
    window.mantle.on('state', renderState);
    window.mantle.on('desktop.backdrop', setBackdrop);
  } else {
    failBackdrop('window.mantle.on is not available, so this page never receives the wallpaper ' +
      'picture or any of Mantle\'s state — the panes are on the fallback tint and the list ' +
      'below cannot update');
  }
})();

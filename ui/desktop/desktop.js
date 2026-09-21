'use strict';
/*
  The desktop layer's script.

  A plain browser script: contextIsolation and sandbox are on, so there is no
  require() and no node here. window.mantle, put up by preload.js, is the only
  way to reach the main process.

  Three timers, and that is all this page ever does:
    the clock   once a minute, aligned to the minute boundary
    the stats   every 5 seconds
    Mission Control  every 30 seconds

  Nothing animates. Every failure ends up as a sentence on screen -- "unavailable"
  with no reason is exactly what this page is not allowed to show.
*/
(function () {
  const $ = (id) => document.getElementById(id);

  const els = {
    clock: $('clock'),
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
  // No bridge at all. Nothing else on this page can work, so say exactly that
  // rather than leaving three tiles showing em-dashes forever.
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
    startClock();   // the one thing that needs nothing from anybody
    return;
  }

  // ---------------------------------------------------------------------
  // Clock. Re-aimed at the next minute boundary after every tick, so it never
  // drifts and never runs more than once a minute.
  // ---------------------------------------------------------------------
  function pad(n) { return n < 10 ? '0' + n : String(n); }

  function startClock() {
    const now = new Date();
    els.clock.textContent = pad(now.getHours()) + ':' + pad(now.getMinutes());
    els.date.textContent = now.toLocaleDateString(undefined, {
      weekday: 'long', day: 'numeric', month: 'long',
    });
    const msToNextMinute = (60 - now.getSeconds()) * 1000 - now.getMilliseconds();
    setTimeout(startClock, Math.max(250, msToNextMinute));
  }
  startClock();

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
  }

  function unmountMissionControl(reason) {
    mcMounted = false;
    els.mcFrame.replaceChildren();
    els.mcFrame.hidden = true;
    els.mcHeadNote.textContent = '';
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
    ['taskbar', 'Windows taskbar', (p) => p.hidden === true],
    ['workarea', 'Work area', (p) => p.reserved === true],
    ['desktop', 'Desktop layer', (p) => p.attached === true],
    ['hotkey', 'Win key', (p) => p.winTap === true],
    ['tray', 'Notification area', (p) => p.status === 'ok'],
    ['shortcuts', 'Shortcuts', (p) => p.killSwitch === true && p.launcher === true],
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

  function renderState(st) {
    if (!st) return;
    const rows = [];
    for (const [key, label, ok] of PIECES) {
      const piece = st[key];
      if (!piece || typeof piece !== 'object') continue;
      if (ok(piece)) continue;
      rows.push(row(label, piece.reason || 'no reason given, which is itself a bug'));
    }
    if (!rows.length) {
      els.strip.hidden = true;
      els.stripList.replaceChildren();
      return;
    }
    // The count lives in the heading because the list itself scrolls in a short
    // window: "3 things" with two rows visible is honest, a list that just ends
    // is not.
    const mode = st.mode === 'test' ? 'test mode · ' : '';
    els.stripMode.textContent = '· ' + mode + rows.length + (rows.length === 1 ? ' thing' : ' things');
    els.stripList.replaceChildren.apply(els.stripList, rows);
    els.strip.hidden = false;
  }

  // Fires immediately with the current state, then on every change.
  window.mantle.on('state', renderState);
})();

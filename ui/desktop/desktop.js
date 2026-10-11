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
    Mission Control  every 30 seconds while it answers; while it is down the
                     wait doubles (30 s, 1, 2, 4, 8 min) up to one check every
                     10 min, and the tile says when the next check is
  ...plus the wallpaper at the bottom of the page (THE WALLPAPER, below), which
  is the one thing here that moves, and which main pauses by Owen's Lively rules.

  THE BACKDROP. Main sends 'desktop.backdrop' {png, w, h, rect, ms} ONCE at start
  and again after a display change: one capture of the whole screen, wallpaper
  only, downscaled 8x. In DARK it is the wallpaper still for the whole display
  instead (main.js presentDesktop, lib/wall-still.js: sharp, lined up, sent again
  whenever the still changes; lane mantle-seethru-bar-desktop, 2026-10-10), which
  is what the panes show whenever the wallpaper itself is not drawing here (paused
  off, unloaded). Because it is a single picture of the whole screen, this
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
  let restingNow = false;   // Mantle resting while a game runs: the clock stays stopped (mantle.rest below)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { clearTimeout(clockTimer); clockTimer = 0; }
    else if (!restingNow) startClock();
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
  let statsTimer = setInterval(tickStats, 5000);

  // ---------------------------------------------------------------------
  // Mission Control (the local dashboard on 127.0.0.1:7373).
  //
  // The iframe is mounted only while the dashboard actually answers, and taken
  // down again the moment it stops -- an <iframe> pointed at a dead port shows a
  // Chromium error page, which is the blank tile this is meant to avoid. The
  // probe runs in the main process because a fetch() from here can only ever
  // report "Failed to fetch"; main gets the real ECONNREFUSED.
  //
  // The dashboard is usually NOT running, and a flat 30 s probe of a closed
  // port is ~120 refused connections an hour for nothing (lane mainrel-mc,
  // 2026-09-27). So the probe is a chained setTimeout that backs off while the
  // port stays shut -- the first retry after 30 s, then 1, 2, 4, 8 min, capped
  // at 10 min -- and drops straight back to 30 s the moment a probe answers.
  // One chain only: every (re)start clears the pending timer, and a probe still
  // in flight from an older chain (or from before a rest) is ignored when it
  // lands, so it can neither remount the frame nor schedule a second chain.
  // ui/desktop/mc-probe.test.js runs this file in node against a fake clock.
  // ---------------------------------------------------------------------
  const MC_ORIGIN = 'http://127.0.0.1:7373';
  let mcMounted = false;
  let mcTimer = 0;   // the one pending probe of the chain (a setTimeout id), 0 when none
  let mcFails = 0;   // probes in a row that did not answer
  let mcChain = 0;   // bumped by every start/stop; a probe from an older chain is ignored

  // mc-backoff:begin (pure; mc-probe.test.js lifts this region out and checks it directly)
  const MC_EVERY_MS = 30 * 1000;        // the cadence while the dashboard answers
  const MC_MAX_MS = 10 * 60 * 1000;     // the slowest it ever gets while it does not
  // The wait before the next probe, given how many probes in a row have failed
  // (0 = the last one answered): 30 s, 30 s, 1 min, 2, 4, 8, then 10 min forever.
  function mcNextDelay(fails) {
    if (!(fails > 1)) return MC_EVERY_MS;
    return Math.min(MC_EVERY_MS * Math.pow(2, Math.min(fails, 20) - 1), MC_MAX_MS);
  }
  // mc-backoff:end

  // "30 s" / "4 min", plus the clock time for anything a minute or more away
  // (12-hour, the same way the clock above is written).
  function mcWhen(ms) {
    const s = Math.round(ms / 1000);
    if (s < 60) return 'in ' + s + ' s';
    const at = new Date(Date.now() + ms);
    const h24 = at.getHours();
    const h = (h24 % 12) === 0 ? 12 : (h24 % 12);
    return 'in ' + Math.round(s / 60) + ' min, at ' + h + ':' + pad2(at.getMinutes()) + ' ' + (h24 < 12 ? 'AM' : 'PM');
  }

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

  // nextMs: when the next probe is due, for the sentence (omitted when there is none).
  function unmountMissionControl(reason, nextMs) {
    mcMounted = false;
    els.mcFrame.replaceChildren();
    els.mcFrame.hidden = true;
    els.mcHeadNote.textContent = '';
    els.mcHeadNote.classList.remove('live');
    els.mcNote.hidden = false;
    els.mcNote.textContent = 'Mission Control offline: ' + reason + '.' +
      (nextMs > 0 ? ' Next check ' + mcWhen(nextMs) + '.' : '') +
      (nextMs > MC_EVERY_MS ? ' Checks slow down while it stays down, to one every 10 min at most.' : '');
  }

  async function probeMissionControl() {
    mcTimer = 0;
    const chain = mcChain;
    let ok = false;
    let reason = '';
    try {
      const r = await window.mantle.call('net.probe', { url: MC_ORIGIN + '/' });
      ok = !!(r && r.ok);
      if (!ok) reason = (r && r.reason) || 'it did not answer and did not say why';
    } catch (err) {
      reason = (err && err.message) || String(err);
    }
    if (chain !== mcChain) return;   // stopped or restarted while this probe was out: stale
    mcFails = ok ? 0 : mcFails + 1;
    const next = mcNextDelay(mcFails);
    if (ok) mountMissionControl();
    else unmountMissionControl(reason, next);
    clearTimeout(mcTimer);
    mcTimer = setTimeout(probeMissionControl, next);
  }

  // Probe now and carry the chain on from there. Safe to call at any time: the
  // pending probe is cancelled first, so there is never more than one chain.
  function startMissionControl() {
    stopMissionControl();
    mcFails = 0;
    probeMissionControl();
  }
  function stopMissionControl() {
    mcChain++;
    clearTimeout(mcTimer);
    mcTimer = 0;
  }
  startMissionControl();

  // ---------------------------------------------------------------------
  // The state strip: every piece of Mantle that is not doing its job, with the
  // reason. Hidden entirely when everything is fine.
  // ---------------------------------------------------------------------
  // Each rule gets (piece, whole state). Where lib/state.js problems() has a rule
  // for the same piece (the terminal's and the tray tooltip's copy of this strip),
  // this one must say the same thing -- two copies of a health rule drift, and by
  // 2026-09-22 they had: this list flagged the hover bar's unreserved strip,
  // which problems() had already been taught was the design.
  const PIECES = [
    ['sidecar', 'Sidecar', (p) => p.status === 'ok'],
    // 'taskbar' is healthy when Windows' own taskbar is on AUTO-HIDE -- Mantle
    // never hides that window any more; hiding it is what cost Owen a reboot on
    // 2026-09-21.
    ['taskbar', 'Windows taskbar', (p) => p.autohide === true],
    // 'workarea': only --dock owes a reservation. In hover mode (the default)
    // the bar reserving NO screen space is the whole design -- it is hidden until
    // the cursor asks for it -- so reserved:false there is not a fault.
    ['workarea', 'Screen space for the bar', (p, s) => p.reserved === true || !(s.bar && s.bar.mode === 'dock')],
    ['desktop', 'Desktop layer', (p) => p.attached === true],
    ['hotkey', 'Win key', (p) => p.winTap === true],
    // 'unavailable' is a permanent platform limit on this Windows build (the XAML
    // notification area has no ToolbarWindow32 to read), not something Owen can
    // act on, and the bar already says so as a quiet note in its overflow menu.
    // Only a tray status that is neither ok nor that limit is a fault here.
    ['tray', 'Notification area', (p) => p.status === 'ok' || p.status === 'unavailable'],
    // Mantle's own wallpaper: not ok means the one on screen could not play (a
    // missing file, a codec, a page that never loaded), and the reason says which.
    ['wallpaper', 'Wallpaper', (p) => p.ok === true],
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
    // Alt+Tab or Win+N / Win+A switched ON in the tray and still Windows' own --
    // the same rule as problems(). lib/switcher.js stateWords decides `broken`,
    // which is also the reason; a test run never hooks, so it says nothing there.
    ['switcher', 'Alt+Tab', (p, s) => s.mode === 'test' || !p.broken],
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
      // ...but while the wallpaper plays IN this page the panes frost it live,
      // and the still picture is not under the glass at all, so its failure is
      // not one Owen can see.
      if (key === 'backdrop.desktop' && document.body.classList.contains('has-wall')) continue;
      // The pause rules can fail on their own (no sidecar to ask what is in
      // front): the wallpaper still plays, but a game would no longer pause it.
      if (key === 'wallpaper' && piece.rulesOk === false) rows.push(row('Wallpaper pause rules', piece.rulesReason || 'not being checked, and no reason given'));
      if (ok(piece, s)) continue;
      if (key === 'backdrop.desktop') saidBackdrop = true;
      rows.push(row(label, (key === 'switcher' ? piece.broken : piece.reason) || 'no reason given, which is itself a bug'));
    }
    // One row per feature (lib/features/*.js) that is switched on and not working -- the same
    // rule as lib/state.js problems(): its own health (test mode too), or chords that should be
    // Mantle's and are not (never in a test run, which never hooks). Off and stopped say nothing.
    const feats = s.features && typeof s.features === 'object' ? s.features : {};
    for (const name of Object.keys(feats)) {
      const p = feats[name];
      if (!p || typeof p !== 'object' || !p.on || p.stopped) continue;
      if (p.ok === false) rows.push(row(p.label || name, p.reason || 'not working, and no reason given'));
      else if (p.broken && s.mode !== 'test') rows.push(row(p.label || name, p.broken));
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
    queueAdapt();
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
    adaptBackdropPicture(p.png);      // dark: solve the panes' brightness from this capture
    console.log('[desktop] backdrop', (p.w || '?') + 'x' + (p.h || '?'),
      'captured in', (p.ms != null ? p.ms + 'ms' : 'an unreported time'));
    renderState(null);
  }

  // ---------------------------------------------------------------------
  // THE WALLPAPER (2026-09-22). Mantle plays it here, at the bottom of this
  // page, because Lively's player was a separate window under this one and the
  // panes covered it. lib/wallpaper.js decides WHAT plays and WHEN it pauses;
  // this page only draws it and says, every time, whether that worked:
  //   'wallpaper'         {ok, reason, item:{id, type, url, look, props, ...}, paused, unload}
  //   'wallpaper.pause'   {paused, unload, reason}   Owen's Lively rules, applied
  //   'wallpaper.prop'    {id, name, value}          a web wallpaper's setting changed
  //   'wallpaper.sysinfo' JSON string                for livelySystemInformation
  //   'wallpaper.cursor'  {x, y}                     the mouse, for web wallpapers
  // and it answers with 'wallpaper.status' {id, state, reason}: loading, playing,
  // ready, error (with the reason, which lands on the card and in the strip) or
  // note (a web wallpaper's own script error, kept on its card).
  //
  // A web wallpaper is a sandboxed iframe on its own origin (mantle-wp://<id>),
  // so the only way in is postMessage to ui/wallpapers/lively-shim.js, which main
  // put first in its <head>, and the only way out is a message from that frame.
  // ---------------------------------------------------------------------
  const wallEl = $('wall');
  const WALL_LOAD_MS = 20000;
  let wall = null;          // {id, url, type, item, el, ready, drawn, timer}
  let wallLast = null;      // the last 'wallpaper' payload, to remount after an unload
  let wallPause = { paused: false, unload: false };
  let wallRetry = { id: null, at: 0 };   // the last time a video was mounted again after a decoder loss
  const WALL_RETRY_GAP_MS = 60000;

  function wallStatus(id, st, reason) {
    window.mantle.call('wallpaper.status', { id, state: st, reason: reason || '' }).catch((err) => {
      console.warn('[desktop] wallpaper.status could not be sent:', err.message);
    });
  }

  function clearWall() {
    if (!wall) return;
    clearTimeout(wall.timer);
    const el = wall.el;
    if (el && el.tagName === 'VIDEO') {
      try { el.pause(); el.removeAttribute('src'); el.load(); } catch (_) { /* releasing the decoder */ }
    }
    wall = null;
    wallEl.replaceChildren();
    document.body.classList.remove('has-wall');
    queueAdapt();
    renderState(null);
  }

  function failWall(reason) {
    if (!wall) return;
    const id = wall.id;
    clearTimeout(wall.timer);
    // The reason goes on the card and the strip; the console (which main copies to its log) gets the
    // id only, because a media error can quote the file's path.
    console.warn('[desktop] wallpaper', id, 'failed');
    // Take it off the screen: the panes go back to the still picture of
    // whatever Windows is showing, rather than frosting a black rectangle.
    clearWall();
    wallStatus(id, 'error', reason);
  }

  function drawn() {
    if (!wall || wall.drawn) return;
    wall.drawn = true;
    wall.el.classList.add('on');
    document.body.classList.add('has-wall');
    queueAdapt();                     // dark: the panes now frost THIS picture
    renderState(null);
  }

  function mediaError(v) {
    const e = v.error;
    const code = e ? e.code : 0;
    const what = {
      1: 'loading was aborted',
      2: 'the file could not be read from disk',
      3: 'the video is damaged, or it is in a format Mantle cannot play',
      4: 'Mantle cannot play this file: its format is not supported, or the file is missing',
    }[code] || 'the video stopped with an error that gave no reason';
    return what;
  }

  function playVideo() {
    if (!wall || wall.type !== 'video') return;
    const v = wall.el;
    const pr = v.play();
    if (pr && pr.catch) {
      pr.catch((err) => {
        // AbortError is a pause() or a new src landing mid-start: not a failure.
        if (err && err.name === 'AbortError') return;
        failWall('it would not start playing (' + (err && err.name ? err.name : 'no reason given') + ')');
      });
    }
  }

  function applyLook(it) {
    if (!wall || !wall.el || !it.look) return;
    const el = wall.el;
    if (wall.type === 'web') return;
    el.style.objectFit = it.look.fit || 'cover';
    // An identity filter is still a pass over every frame, so none at all unless asked.
    el.style.filter = it.look.filter || '';
    if (wall.type === 'video' && el.playbackRate !== it.look.rate) el.playbackRate = it.look.rate || 1;
  }

  function toFrame(msg) {
    if (!wall || wall.type !== 'web' || !wall.el || !wall.el.contentWindow) return;
    msg.mantle = 'wp';
    try { wall.el.contentWindow.postMessage(msg, '*'); } catch (_) { /* the frame is navigating */ }
  }

  function mountVideo(it) {
    const v = document.createElement('video');
    v.className = 'wall-media';
    // Muted and looped, always: a wallpaper is not a speaker. playsInline and no
    // picture-in-picture keep Chromium from offering to pop it out anywhere.
    v.muted = true;
    v.defaultMuted = true;
    v.loop = true;
    v.playsInline = true;
    v.disablePictureInPicture = true;
    v.preload = 'auto';
    v.addEventListener('loadeddata', drawn);
    v.addEventListener('playing', () => {
      if (!wall || wall.el !== v || wall.said === 'playing') return;
      wall.said = 'playing';
      clearTimeout(wall.timer);
      wallStatus(wall.id, 'playing');
    });
    v.addEventListener('error', () => {
      if (!wall || wall.el !== v) return;
      // A video that HAD been playing and then errors is almost always the graphics side restarting
      // (after sleep, a driver update, a display change), not a bad file: mount it again, once.
      // Once per minute per wallpaper: a second loss soon after the retry is a real fault and is
      // reported; one hours later (the next sleep) gets its own retry.
      const now = Date.now();
      if (wall.drawn && !(wallRetry.id === wall.id && now - wallRetry.at < WALL_RETRY_GAP_MS)) {
        const again = wall.item;
        wallRetry = { id: again.id, at: now };
        console.warn('[desktop] wallpaper', wall.id, 'stopped after playing; mounting it again once');
        clearWall();
        setTimeout(() => { if (!wall && wallLast && wallLast.item && wallLast.item.id === again.id) setWallpaper(Object.assign({}, wallLast, wallPause)); }, 1500);
        return;
      }
      failWall(mediaError(v));
    });
    wall.el = v;
    wallEl.replaceChildren(v);
    applyLook(it);
    v.src = it.url;
    // A video that never produces a frame and never errors (a stalled file) is
    // still a failure, and gets a sentence rather than a black desktop forever.
    wall.timer = setTimeout(() => {
      if (wall && wall.el === v && !wall.drawn) failWall('it did not show a single frame within ' + (WALL_LOAD_MS / 1000) + ' seconds');
    }, WALL_LOAD_MS);
    if (!wallPause.paused) playVideo();
  }

  function mountImage(it) {
    const img = document.createElement('img');
    img.className = 'wall-media';
    img.alt = '';
    img.decoding = 'async';
    img.addEventListener('load', () => {
      if (!wall || wall.el !== img) return;
      drawn();
      wallStatus(wall.id, 'playing');
    });
    img.addEventListener('error', () => {
      if (wall && wall.el === img) failWall('the picture could not be loaded: the file is missing or is not a picture Mantle can show');
    });
    wall.el = img;
    wallEl.replaceChildren(img);
    applyLook(it);
    img.src = it.url;
  }

  function mountWeb(it) {
    const f = document.createElement('iframe');
    f.className = 'wall-media';
    // allow-same-origin gives the page ITS OWN origin (mantle-wp://<id>), never
    // this one: localStorage and relative fetch() work as they did in Lively,
    // and it still cannot reach window.mantle or this document.
    f.setAttribute('sandbox', 'allow-scripts allow-same-origin');
    f.setAttribute('allow', 'autoplay');
    f.setAttribute('scrolling', 'no');
    f.setAttribute('tabindex', '-1');
    f.title = it.title || 'Wallpaper';
    f.addEventListener('load', () => {
      // The shim says 'ready' from the page's own load event, which lands just
      // before this one. No word shortly after means the bridge never ran: the
      // page was not found, or it is not an HTML page.
      if (!wall || wall.el !== f) return;
      const w = wall;
      setTimeout(() => {
        if (wall === w && !w.readyOnce) failWall('the page loaded but Mantle\'s Lively bridge never started in it, so it is not a page Mantle can drive (was it found?)');
      }, 4000);
    });
    // src BEFORE insertion: an iframe inserted without one loads about:blank
    // first and fires 'load' for it, which would start the 4 s check above
    // against a page that has not even been asked for yet.
    f.src = it.url;
    wall.el = f;
    wallEl.replaceChildren(f);
    wall.timer = setTimeout(() => {
      if (wall && wall.el === f && !wall.readyOnce) failWall('the page did not finish loading within ' + (WALL_LOAD_MS / 1000) + ' seconds');
    }, WALL_LOAD_MS);
  }

  window.addEventListener('message', (e) => {
    if (!wall || wall.type !== 'web' || !wall.el || e.source !== wall.el.contentWindow) return;
    const m = e.data;
    if (!m || m.mantle !== 'wp') return;
    if (m.kind === 'ready') {
      // Every load, including a wallpaper that reloads itself on resize: its
      // saved values go in again each time, as Lively does.
      clearTimeout(wall.timer);
      const first = !wall.readyOnce;
      wall.readyOnce = true;
      drawn();
      toFrame({ kind: 'props', list: wall.item.props || [] });
      if (wallPause.paused) toFrame({ kind: 'pause' });
      if (first) {
        const miss = [];
        if ((wall.item.props || []).length && !m.listener) miss.push('it has settings but no livelyPropertyListener, so they cannot reach it');
        if (wall.item.sysinfo && !m.sysinfo) miss.push('it asks for system information but has no livelySystemInformation to receive it');
        wallStatus(wall.id, 'ready', miss.join('; '));
      }
    } else if (m.kind === 'error') {
      wallStatus(wall.id, 'note', String(m.reason || 'an error without a message'));
    }
  });

  function setWallpaper(p) {
    wallLast = p;
    if (p) wallPause = { paused: !!p.paused, unload: !!p.unload };
    const it = p && p.ok && p.item && p.item.url ? p.item : null;
    if (!it || wallPause.unload) { clearWall(); return; }
    if (wall && wall.id === it.id && wall.url === it.url) {
      // The same wallpaper with new settings: no reload, just the new look, or
      // the new values posted in again.
      wall.item = it;
      applyLook(it);
      if (it.type === 'web' && wall.readyOnce) toFrame({ kind: 'props', list: it.props || [] });
      applyPause();
      return;
    }
    clearWall();
    wall = { id: it.id, url: it.url, type: it.type, item: it, el: null, drawn: false, readyOnce: false, timer: 0, said: '' };
    wallStatus(it.id, 'loading');
    if (it.type === 'video') mountVideo(it);
    else if (it.type === 'web') mountWeb(it);
    else mountImage(it);
    applyPause();
  }

  function applyPause() {
    if (!wall || !wall.el) return;
    const paused = wallPause.paused;
    if (wall.type === 'video') { if (paused) wall.el.pause(); else playVideo(); }
    else if (wall.type === 'web') { if (wall.readyOnce) toFrame({ kind: paused ? 'pause' : 'resume' }); }
    else if (wall.type === 'gif') wall.el.classList.toggle('held', paused);
  }

  function onWallPause(p) {
    const was = wallPause;
    wallPause = { paused: !!(p && p.paused), unload: !!(p && p.unload) };
    // 'kill' in Lively's words: take it off entirely while the rule holds, and
    // put it back from the last payload when it lets go.
    if (wallPause.unload && !was.unload) { clearWall(); return; }
    if (!wallPause.unload && was.unload && wallLast) { setWallpaper(Object.assign({}, wallLast, wallPause)); return; }
    applyPause();
  }

  // ---------------------------------------------------------------------
  // DARK ONLY: THE ONE READABILITY GUARD (ui/shared/glass-adapt.js guard(),
  // the top bar's rule, same code and thresholds; lane same-shell, 2026-10-09,
  // replacing see-glass-b's picture dimming, which the recipe no longer
  // allows). A pane is one layer of --lg-fill over the blurred picture; the
  // tint thickens (never the picture dimming) only as far as --lg-ink-2 needs
  // for 4.5:1 over the brightest blurred pixel under the pane, capped at
  // --lg-fill-pop, and the answer goes into --pane-tint on that .pane (the
  // dark ::after in desktop.css reads it). With --lg-fill-pop = --lg-fill (the
  // FINAL tokens) there is nothing to thicken, so nothing is read at all.
  // The picture is Mantle's own wallpaper when it is a picture on screen
  // (#wall), else main's still capture, drawn ONCE per picture at an eighth of
  // the screen; it reruns on a new picture, a layout change (ResizeObserver) or
  // a theme change, never on a timer. A video or web wallpaper cannot be read
  // back: the token tint, and the console says why once. Light: nothing runs.
  // ---------------------------------------------------------------------
  const GA = window.MantleGlassAdapt || null;
  const ADAPT_SCALE = 8;
  const adapt = { key: '', canvas: null, bdImg: null, bdUrl: '', queued: false, said: '' };

  function adaptSay(why) {
    if (adapt.said === why) return;
    adapt.said = why;
    if (why) console.warn('[desktop] dark panes at the token brightness: ' + why);
  }

  function clearAdapt() {
    document.querySelectorAll('.pane').forEach((p) => p.style.removeProperty('--pane-tint'));
    window.__desktopGlass = null;
  }

  // what is under the panes right now: { key, draw(g, W, H) } or { why } when it cannot be read
  function adaptSource() {
    const body = document.body;
    if (body.classList.contains('has-wall')) {
      if (!wall || !wall.el || wall.el.tagName !== 'IMG' || !wall.el.naturalWidth) {
        return { why: 'the wallpaper is a ' + ((wall && wall.type) || 'moving') + ' wallpaper, which cannot be read back' };
      }
      const img = wall.el;
      const fit = img.style.objectFit || 'cover';
      const look = (wall.item && wall.item.look && wall.item.look.filter) || '';
      return {
        key: 'wall|' + wall.url + '|' + fit + '|' + look + '|' + innerWidth + 'x' + innerHeight,
        draw(g, W, H) {
          // the picture where object-fit put it (centred), on the page's black
          const nw = img.naturalWidth, nh = img.naturalHeight;
          let dw = W, dh = H;
          if (fit !== 'fill') {
            const cover = Math.max(W / nw, H / nh), contain = Math.min(W / nw, H / nh), own = 1 / ADAPT_SCALE;
            const s = fit === 'contain' ? contain : fit === 'none' ? own : fit === 'scale-down' ? Math.min(own, contain) : cover;
            dw = nw * s; dh = nh * s;
          }
          g.fillStyle = '#000';
          g.fillRect(0, 0, W, H);
          g.filter = look || 'none';
          g.drawImage(img, (W - dw) / 2, (H - dh) / 2, dw, dh);
          g.filter = 'none';
        },
      };
    }
    if (body.classList.contains('no-backdrop') || !adapt.bdImg || !adapt.bdImg.naturalWidth) return { why: '' };
    const img = adapt.bdImg;
    return { key: 'bd|' + adapt.bdUrl.length + '|' + adapt.bdUrl.slice(-48) + '|' + innerWidth + 'x' + innerHeight,
      draw(g, W, H) { g.drawImage(img, 0, 0, W, H); } };   // background-size: 100vw 100vh
  }

  function adaptPanes() {
    if (document.documentElement.getAttribute('data-theme') !== 'dark' || !GA) {
      clearAdapt();
      if (!GA && document.documentElement.getAttribute('data-theme') === 'dark') adaptSay('ui/shared/glass-adapt.js did not load');
      return;
    }
    const src = adaptSource();
    if (!src.key) { clearAdapt(); adaptSay(src.why); return; }
    const W = Math.max(1, Math.round(innerWidth / ADAPT_SCALE)), H = Math.max(1, Math.round(innerHeight / ADAPT_SCALE));
    if (!adapt.canvas) adapt.canvas = document.createElement('canvas');
    const c = adapt.canvas;
    const g = c.getContext('2d', { willReadFrequently: true });
    if (adapt.key !== src.key) {
      c.width = W; c.height = H;
      src.draw(g, W, H);
      adapt.key = src.key;
    }
    const T = GA.guardTokens(getComputedStyle(document.documentElement));
    // the ceiling at or under the fill leaves the guard nothing to thicken: the same answer, unread
    if (!(T.ceil > T.fill.a + 1e-9)) { clearAdapt(); window.__desktopGlass = { alpha: T.fill.a, engaged: false, why: 'ceiling = fill' }; adaptSay(''); return; }
    let failed = '', pic = null;
    try { pic = GA.glassPicture(g.getImageData(0, 0, W, H), T, 1 / ADAPT_SCALE); } catch (_) { failed = 'the wallpaper picture could not be read back (the page may not read that file)'; }
    const seen = [];
    document.querySelectorAll('.pane').forEach((p) => {
      const r = p.getBoundingClientRect();
      const res = pic ? GA.guardRect(pic, T, { x: r.left / ADAPT_SCALE, y: r.top / ADAPT_SCALE, w: r.width / ADAPT_SCALE, h: r.height / ADAPT_SCALE }) : null;
      if (res && res.engaged) p.style.setProperty('--pane-tint', res.tint); else p.style.removeProperty('--pane-tint');
      seen.push(res ? { alpha: res.alpha, ratio: res.ratio, engaged: res.engaged } : null);
    });
    window.__desktopGlass = { panes: seen };
    adaptSay(failed);
  }

  function queueAdapt() {
    if (adapt.queued) return;
    adapt.queued = true;
    requestAnimationFrame(() => { adapt.queued = false; adaptPanes(); });
  }

  // main's still capture, as a decoded picture the canvas can read (a data: URL, so never tainted)
  function adaptBackdropPicture(url) {
    if (adapt.bdUrl === url) return;
    adapt.bdUrl = url;
    const img = new Image();
    img.onload = () => { if (adapt.bdUrl === url) { adapt.bdImg = img; queueAdapt(); } };
    img.src = url;
  }

  // ---------------------------------------------------------------------
  // STEP ASIDE UNDER WINDOWS (lane widgethide, 2026-10-10). Each widget fades out while an app
  // window sits over it and comes back when that window is minimised, moved away, or on Win+D.
  // lib/features/widgethide.js decides (via sidecar/WidgetCover.cs); this page only says where
  // its panes are and wears the answer:
  //   widgethide.rects {panes:[{key, x, y, w, h}], why}   CSS px in this window, on load and on
  //                                                       every resize (only when they moved)
  //   'widgethide.cover' {on, covered:{key:bool}, by, reason}
  // .covered is opacity + visibility only, so nothing moves (no layout shift) and a hidden pane
  // takes no clicks. Unknown answers arrive as nothing covered: every widget shows (fail open),
  // and why is the feature's own row in this page's strip.
  // ---------------------------------------------------------------------
  const coverPanes = () => Array.from(document.querySelectorAll('.pane[data-cover]'));
  let coverSent = '';
  let coverTimer = 0;
  function reportCover(why) {
    if (typeof window.mantle.call !== 'function') return;
    clearTimeout(coverTimer);
    coverTimer = setTimeout(() => {
      const panes = coverPanes().map((el) => {
        const r = el.getBoundingClientRect();
        return { key: el.dataset.cover, x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
      });
      const sig = JSON.stringify(panes);
      if (sig === coverSent) return;
      coverSent = sig;
      window.mantle.call('widgethide.rects', { panes, why: why || 'the widgets moved' }).catch((err) => {
        coverSent = '';   // try again on the next change
        console.warn('[desktop] the widgets could not say where they are, so they stay up under windows: ' + (err && err.message ? err.message : err));
      });
    }, 120);
  }
  function applyCover(p) {
    const covered = (p && p.on && p.covered) || {};
    coverPanes().forEach((el) => el.classList.toggle('covered', covered[el.dataset.cover] === true));
    window.__desktopCover = p || null;
  }

  window.addEventListener('mantle-theme', queueAdapt);
  window.addEventListener('resize', queueAdapt);
  window.addEventListener('resize', () => reportCover('the desktop was resized'));
  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(queueAdapt);
    document.querySelectorAll('.cluster, .pane').forEach((el) => ro.observe(el));
    const rc = new ResizeObserver(() => reportCover('a widget changed size'));
    document.querySelectorAll('.cluster, .pane[data-cover]').forEach((el) => rc.observe(el));
  }
  reportCover('the desktop page loaded');

  // Fires immediately with the current state, then on every change.
  if (typeof window.mantle.on === 'function') {
    window.mantle.on('wallpaper', setWallpaper);
    window.mantle.on('wallpaper.pause', onWallPause);
    window.mantle.on('wallpaper.prop', (m) => { if (wall && m && m.id === wall.id) toFrame({ kind: 'prop', name: m.name, value: m.value }); });
    window.mantle.on('wallpaper.sysinfo', (json) => { if (!wallPause.paused) toFrame({ kind: 'sysinfo', json }); });
    window.mantle.on('wallpaper.cursor', (pt) => { if (pt) toFrame({ kind: 'cursor', x: pt.x, y: pt.y }); });
    window.mantle.on('state', renderState);
    // Mantle resting while a game runs (lane memfix, 2026-09-26; main.js restMantle): this layer is
    // behind the game, so the clock, the 5 s numbers and Mission Control's frame (a whole live page)
    // stop until it exits, and the panel says why. Everything restarts the way the page starts it.
    window.mantle.on('mantle.rest', (r) => {
      restingNow = !!(r && r.on);
      if (r && r.on) {
        clearTimeout(clockTimer); clockTimer = 0;
        clearInterval(statsTimer); statsTimer = 0;
        stopMissionControl();
        unmountMissionControl('closed while Mantle rests (' + r.why + ')');
        els.mcNote.textContent = 'Mission Control closed while Mantle rests (' + r.why + '); back when the game exits.';
      } else if (r && !statsTimer) {
        startClock();
        tickStats(); statsTimer = setInterval(tickStats, 5000);
        startMissionControl();   // clears any pending probe first: never two chains
      }
    });
    window.mantle.on('desktop.backdrop', setBackdrop);
    window.mantle.on('widgethide.cover', applyCover);
  } else {
    failBackdrop('window.mantle.on is not available, so this page never receives the wallpaper ' +
      'picture or any of Mantle\'s state — the panes are on the fallback tint and the list ' +
      'below cannot update');
  }
})();

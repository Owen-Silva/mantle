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
  ...plus the wallpaper at the bottom of the page (THE WALLPAPER, below), which
  is the one thing here that moves, and which main pauses by Owen's Lively rules.

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
    renderState(null);
  }

  function failWall(reason) {
    if (!wall) return;
    const id = wall.id;
    clearTimeout(wall.timer);
    console.warn('[desktop] wallpaper', id, 'failed:', reason);
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
    renderState(null);
  }

  function mediaError(v) {
    const e = v.error;
    const code = e ? e.code : 0;
    const what = {
      1: 'loading was aborted',
      2: 'the file could not be read from disk',
      3: 'the video is damaged, or it uses a codec Chromium cannot decode',
      4: 'Chromium cannot play this file: its format or codec is not supported, or the file is missing',
    }[code] || 'the video element reported an error without a code';
    return what + (e && e.message ? ' (' + e.message + ')' : '');
  }

  function playVideo() {
    if (!wall || wall.type !== 'video') return;
    const v = wall.el;
    const pr = v.play();
    if (pr && pr.catch) {
      pr.catch((err) => {
        // AbortError is a pause() or a new src landing mid-start: not a failure.
        if (err && err.name === 'AbortError') return;
        failWall('Chromium would not start it: ' + (err && err.message ? err.message : String(err)));
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
    v.addEventListener('error', () => { if (wall && wall.el === v) failWall(mediaError(v)); });
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
      if (wall && wall.el === img) failWall('the picture could not be loaded: the file is missing or is not a picture Chromium can read');
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

  // Fires immediately with the current state, then on every change.
  if (typeof window.mantle.on === 'function') {
    window.mantle.on('wallpaper', setWallpaper);
    window.mantle.on('wallpaper.pause', onWallPause);
    window.mantle.on('wallpaper.prop', (m) => { if (wall && m && m.id === wall.id) toFrame({ kind: 'prop', name: m.name, value: m.value }); });
    window.mantle.on('wallpaper.sysinfo', (json) => { if (!wallPause.paused) toFrame({ kind: 'sysinfo', json }); });
    window.mantle.on('wallpaper.cursor', (pt) => { if (pt) toFrame({ kind: 'cursor', x: pt.x, y: pt.y }); });
    window.mantle.on('state', renderState);
    window.mantle.on('desktop.backdrop', setBackdrop);
  } else {
    failBackdrop('window.mantle.on is not available, so this page never receives the wallpaper ' +
      'picture or any of Mantle\'s state — the panes are on the fallback tint and the list ' +
      'below cannot update');
  }
})();

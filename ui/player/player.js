'use strict';
/* Mantle Player's page (lane mantle-player, 2026-10-17). Everything that reads the disk is a player.<verb> call
   to lib/features/player.js; the format rules are window.MantlePlayerProbe (lib/features/_player-probe.js).
   IDLE IS FREE: no requestAnimationFrame anywhere; the time readout moves on the <video>'s own timeupdate
   (about 4 a second while playing, none while paused); timers exist only while a toast or the full-screen
   auto-hide is pending. Motion is CSS transform/opacity. */
(() => {
  const M = window.mantle;
  const PR = window.MantlePlayerProbe;
  const $ = (id) => document.getElementById(id);
  const root = document.documentElement;
  const v = $('v');
  const words = (r, fb) => (r && (r.reason || r.threw)) || fb;
  const call = (cmd, a) => Promise.resolve().then(() => M.call(cmd, a || {})).then((x) => x || { ok: false, reason: 'no answer came back' }, (e) => ({ ok: false, reason: (e && e.message) || String(e) }));

  /* ---- icons: one stroke family, 16 px grid ---------------------------------------------------- */
  const P = {
    play: '<path d="M5 3.5v9l7.5-4.5z" fill="currentColor" stroke="none"/>', pause: '<path d="M5 3.5v9M11 3.5v9" stroke-width="2.2"/>',
    prev: '<path d="M4 3.5v9" stroke-width="1.8"/><path d="M12.5 3.5v9L5.5 8z" fill="currentColor" stroke="none"/>', next: '<path d="M12 3.5v9" stroke-width="1.8"/><path d="M3.5 3.5v9l7-4.5z" fill="currentColor" stroke="none"/>',
    shuffle: '<path d="M2 4.5h2.5c3 0 4 7 7 7H14M2 11.5h2.5c1.2 0 2-1 2.6-2.2M9 6.6c.6-1.1 1.4-2.1 2.5-2.1H14M12 2.5l2 2-2 2M12 9.5l2 2-2 2"/>',
    repeat: '<path d="M3 7V6a2 2 0 0 1 2-2h8M11 2l2 2-2 2M13 9v1a2 2 0 0 1-2 2H3M5 14l-2-2 2-2"/>', repeat1: '<path d="M3 7V6a2 2 0 0 1 2-2h8M11 2l2 2-2 2M13 9v1a2 2 0 0 1-2 2H3M5 14l-2-2 2-2"/><path d="M7.5 6.8 8.6 6v4" stroke-width="1.3"/>',
    vol: '<path d="M2.5 6h2.5l3.5-3v10L5 10H2.5z" fill="currentColor" stroke="none"/><path d="M11 5.5a3.5 3.5 0 0 1 0 5M12.8 3.6a6 6 0 0 1 0 8.8"/>', vol1: '<path d="M2.5 6h2.5l3.5-3v10L5 10H2.5z" fill="currentColor" stroke="none"/><path d="M11 5.5a3.5 3.5 0 0 1 0 5"/>',
    mute: '<path d="M2.5 6h2.5l3.5-3v10L5 10H2.5z" fill="currentColor" stroke="none"/><path d="M11 6l3.5 4M14.5 6 11 10"/>',
    full: '<path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10"/>', unfull: '<path d="M6 2.5V6H2.5M13.5 6H10V2.5M10 13.5V10h3.5M2.5 10H6v3.5"/>',
    cc: '<rect x="1.5" y="3" width="13" height="10" rx="2"/><path d="M7 6.6a1.9 1.9 0 1 0 0 2.8M12 6.6a1.9 1.9 0 1 0 0 2.8"/>', audio: '<path d="M6 12V3.5l7-1.5V10"/><circle cx="4.3" cy="12" r="1.8"/><circle cx="11.3" cy="10" r="1.8"/>',
    mini: '<rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><rect x="8" y="8" width="5" height="4" rx=".8" fill="currentColor" stroke="none"/>', expand: '<path d="M9.5 2.5h4v4M13.5 2.5 8.5 7.5M6.5 13.5h-4v-4M2.5 13.5l5-5"/>',
    min: '<path d="M3.5 8h9" stroke-width="1"/>', max: '<rect x="3.5" y="3.5" width="9" height="9" rx="1" stroke-width="1"/>', restore: '<rect x="3.5" y="5.5" width="7" height="7" rx="1" stroke-width="1"/><path d="M5.5 5.5v-2h7v7h-2" stroke-width="1"/>', close: '<path d="M4 4l8 8M12 4l-8 8" stroke-width="1"/>',
    x: '<path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/>', music: '<path d="M6 12V3.5l7-1.5V10"/><circle cx="4.3" cy="12" r="1.8"/><circle cx="11.3" cy="10" r="1.8"/>', video: '<rect x="1.5" y="3.5" width="9" height="9" rx="1.5"/><path d="M10.5 7l4-2.5v7l-4-2.5"/>',
    list: '<path d="M2.5 4h11M2.5 8h7M2.5 12h5M12 9.5v4.5M9.8 11.8h4.4"/>', queue: '<path d="M2.5 4h11M2.5 8h11M2.5 12h6"/><path d="M11 10.5v3.5l3-1.75z" fill="currentColor" stroke="none"/>', open: '<path d="M2 12.5V4a1 1 0 0 1 1-1h3.2l1.5 1.5H13a1 1 0 0 1 1 1V7"/><path d="M2 12.5 4 7.5h11l-2 5z"/>',
    now: '<circle cx="8" cy="8" r="6"/><path d="M6.6 5.5v5l4-2.5z" fill="currentColor" stroke="none"/>', alert: '<path d="M8 2 14.5 13.5h-13z"/><path d="M8 6.5v3.2M8 11.6v.1" stroke-width="1.8"/>', search: '<circle cx="7" cy="7" r="4.2"/><path d="M10.2 10.2 14 14"/>',
    check: '<path d="M3 8.5 6.5 12 13 4.5" stroke-width="1.8"/>', dots: '<circle cx="3.5" cy="8" r="1.2" fill="currentColor" stroke="none"/><circle cx="8" cy="8" r="1.2" fill="currentColor" stroke="none"/><circle cx="12.5" cy="8" r="1.2" fill="currentColor" stroke="none"/>',
  };
  const ic = (n) => '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (P[n] || '') + '</svg>';
  const setIc = (el, n) => { if (el && el.dataset.ic !== n) { el.dataset.ic = n; el.innerHTML = ic(n); } };
  document.querySelectorAll('[data-icon]').forEach((el) => { el.innerHTML = ic(el.dataset.icon); });
  setIc($('sico'), 'search');
  for (const [id, n] of [['wmini', 'mini'], ['wmin', 'min'], ['wmax', 'max'], ['wclose', 'close'], ['prev', 'prev'], ['next', 'next'], ['play', 'play'], ['shuf', 'shuffle'], ['rep', 'repeat'], ['cc', 'cc'], ['atrack', 'audio'], ['mute', 'vol'], ['full', 'full'], ['unmini', 'expand'], ['noticex', 'x'], ['bigplay', 'play']]) setIc($(id), n);
  const h = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined && text !== null) e.textContent = text; return e; };

  /* ---- state ------------------------------------------------------------------------------------ */
  const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
  const S = {
    test: false, items: [], index: -1, order: null, cur: null, verdict: null, gen: 0,
    state: { volume: 1, muted: false, speed: 1, shuffle: false, repeat: 'off', subs: true, view: 'songs' },
    view: 'now', sub: 'songs', lib: null, q: '', pl: null, win: { full: false, mini: false },
    trackEls: [], blobs: [], subChoice: null, lastSave: 0, idleT: null, toastT: null, toastFn: null, seekDrag: null, menuFor: null, libT: null, thumbQ: new Set(), thumbT: null, thumbs: {},
  };
  const MS = {};                                                     // media-session handlers (the test reads them)
  const cur = () => (S.index >= 0 ? S.items[S.index] : null);
  const base = (p) => String(p || '').split(/[\\/]/).pop();
  const stem = (p) => base(p).replace(/\.[^.]+$/, '');

  /* ---- toast (undo over confirm) ---------------------------------------------------------------- */
  function toast(text, action, fn, tone) {
    const t = $('toast'); clearTimeout(S.toastT);
    $('toastt').textContent = text; t.classList.toggle('warn', tone === 'warn');
    const a = $('toasta'); a.hidden = !action; a.textContent = action || ''; S.toastFn = fn || null;
    t.hidden = false; S.toastT = setTimeout(() => { t.hidden = true; S.toastFn = null; }, action ? 7000 : 4500);
  }
  $('toasta').addEventListener('click', () => { const f = S.toastFn; $('toast').hidden = true; clearTimeout(S.toastT); S.toastFn = null; if (f) f(); });
  function notice(text) { $('notice').hidden = !text; $('noticet').textContent = text || ''; }
  $('noticex').addEventListener('click', () => notice(null));

  /* ---- can Chromium decode it? ------------------------------------------------------------------ */
  const canCache = {};
  function can(codec) {
    const c = PR.CODECS[codec]; if (!c || !c.mime) return false;
    if (!(codec in canCache)) canCache[codec] = v.canPlayType(c.mime) !== '';
    return canCache[codec];
  }

  /* ---- playing ---------------------------------------------------------------------------------- */
  function clearTracks() {
    for (const t of S.trackEls) t.remove();
    for (const u of S.blobs) URL.revokeObjectURL(u);
    S.trackEls = []; S.blobs = [];
  }
  function showNope(head, reason, way) {
    $('nope').hidden = false; $('nopeh').textContent = head; $('nopep').textContent = reason + (way ? '. ' + way + '.' : '');
    $('nothing').hidden = true; $('bigplay').hidden = true;
    $('nopewith').hidden = !cur(); $('nopefiles').hidden = !cur(); $('nopeskip').hidden = S.items.length < 2;
  }
  function setKind(kind) { root.classList.toggle('video', kind === 'video'); root.classList.toggle('audio', kind !== 'video'); }
  async function playAt(i, o) {
    const opts = o || {};
    if (i < 0 || i >= S.items.length) return;
    const gen = ++S.gen;
    S.index = i; saveQueue(); paintQueue();
    const p = S.items[i];
    v.pause(); clearTracks(); notice(null); $('nope').hidden = true;
    const r = await call('player.prepare', { path: p });
    if (gen !== S.gen) return;                                      // a newer pick won
    S.cur = r.ok ? r : null;
    $('nothing').hidden = true;
    if (!r.ok) { setKind('video'); v.removeAttribute('src'); v.load(); paintNow(null, p); showNope('Can\'t play ' + base(p), words(r, 'it could not be read')); return; }
    setKind(r.kind);
    paintNow(r, p);
    const vd = PR.verdict(r.probe, can);
    S.verdict = vd;
    if (vd.state === 'no') { v.removeAttribute('src'); v.load(); showNope('Can\'t play ' + r.name, vd.reason, vd.way); paintPlay(); return; }
    if (vd.reason) notice(vd.reason);
    v.src = r.url;
    v.playbackRate = S.state.speed || 1;
    v.defaultPlaybackRate = S.state.speed || 1;
    addSubs(r);
    const resumeAt = r.resume && r.kind === 'video' ? r.resume.t : 0;
    if (resumeAt) {
      v.addEventListener('loadedmetadata', () => { if (gen === S.gen && v.duration > resumeAt) { v.currentTime = resumeAt; toast('Resumed at ' + PR.clock(resumeAt), 'Start over', () => { v.currentTime = 0; call('player.resume', { path: p, t: 0, d: v.duration || 1, now: true }); }); } }, { once: true });
    }
    meta(r);
    if (opts.autoplay === false) { $('bigplay').hidden = r.kind !== 'video'; paintPlay(); return; }
    v.play().catch((e) => { if (gen === S.gen && e && e.name !== 'AbortError' && !v.error) showNope('Can\'t play ' + r.name, PR.errorWords(4, e.message, r.probe), 'Open it with another app, or skip to the next item'); });
  }
  function paintNow(r, p) {
    const tg = r && r.tags;
    const title = (tg && tg.title) || (r ? stem(r.name) : stem(p));
    const sub = tg ? [tg.artist, tg.album].filter(Boolean).join(' · ') || 'Unknown artist' : r ? r.folder : '';
    $('npt').textContent = title; $('nps').textContent = sub; $('ttl').textContent = title;
    const art = tg && tg.cover ? 'url("' + tg.cover.replace(/"/g, '%22') + '")' : '';
    $('npart').style.backgroundImage = art; $('npart').innerHTML = art ? '' : ic(r && r.kind === 'video' ? 'video' : 'music');
    const cv = $('cover'); cv.hidden = !r || r.kind === 'video';
    if (r && r.kind !== 'video') {
      $('art').style.backgroundImage = art; $('art').innerHTML = art ? '' : ic('music');
      $('ct1').textContent = title; $('ct2').textContent = (tg && tg.artist) || 'Unknown artist'; $('ct3').textContent = [(tg && tg.album) || null, tg && tg.year].filter(Boolean).join(' · ');
    }
  }
  function addSubs(r) {
    const list = (r.subs || []).filter((s) => s.vtt);
    const want = S.state.subs !== false;
    list.forEach((s, k) => {
      const u = URL.createObjectURL(new Blob([s.vtt], { type: 'text/vtt' })); S.blobs.push(u);
      const t = document.createElement('track'); t.kind = 'subtitles'; t.label = s.label; if (s.lang) t.srclang = s.lang.slice(0, 2); t.src = u;
      if (want && k === 0) t.default = true;
      v.appendChild(t); S.trackEls.push(t);
    });
    S.subChoice = want && list.length ? 0 : null;
    const bad = (r.subs || []).filter((s) => !s.vtt);
    if (bad.length) toast('A subtitle file could not be used: ' + bad[0].reason, null, null, 'warn');
    paintCc();
  }
  function textTracks() { return Array.from(v.textTracks || []).filter((t) => t.kind === 'subtitles' || t.kind === 'captions'); }
  function pickSub(k) {
    const ts = textTracks();
    ts.forEach((t, i) => { t.mode = i === k ? 'showing' : 'disabled'; });
    S.subChoice = k === null || k === undefined || k < 0 ? null : k;
    saveState({ subs: S.subChoice !== null });
    paintCc();
  }
  function paintCc() {
    const n = textTracks().length; const b = $('cc');
    b.disabled = !n && !(S.cur && S.cur.probe && S.cur.probe.tracks.some((t) => t.type === 'text'));
    b.setAttribute('aria-pressed', String(S.subChoice !== null && n > 0));
    b.title = n ? 'Subtitles (C)' : 'No subtitles for this file: put a .srt or .vtt with the same name next to it';
  }
  function meta(r) {
    if (!('mediaSession' in navigator)) return;
    const tg = r.tags || {};
    const art = tg.cover ? [{ src: tg.cover, sizes: '512x512', type: /\.png$/i.test(tg.cover) ? 'image/png' : 'image/jpeg' }] : [];
    try { navigator.mediaSession.metadata = new MediaMetadata({ title: tg.title || stem(r.name), artist: tg.artist || (r.kind === 'video' ? 'Mantle Player' : 'Unknown artist'), album: tg.album || (r.kind === 'video' ? r.folder : ''), artwork: art }); } catch (_) { /* no metadata: the flyout says Mantle */ }
  }
  function position() { try { if ('mediaSession' in navigator && isFinite(v.duration) && v.duration > 0) navigator.mediaSession.setPositionState({ duration: v.duration, playbackRate: v.playbackRate || 1, position: Math.min(v.currentTime, v.duration) }); } catch (_) { /* a live stream */ } }
  function ms(action, fn) { MS[action] = fn; try { navigator.mediaSession.setActionHandler(action, fn); } catch (_) { /* that action is not offered */ } }
  ms('play', () => playPause(true)); ms('pause', () => playPause(false)); ms('stop', () => { v.pause(); saveResume(true); });
  ms('previoustrack', () => prev()); ms('nexttrack', () => next(false));
  ms('seekbackward', (d) => seekBy(-((d && d.seekOffset) || 10))); ms('seekforward', (d) => seekBy((d && d.seekOffset) || 10));
  ms('seekto', (d) => { if (d && typeof d.seekTime === 'number') v.currentTime = d.seekTime; });

  function playPause(want) {
    if (!S.cur) { if (S.items.length) playAt(Math.max(0, S.index)); return; }
    if (!v.src || $('nope').hidden === false) return;
    const go = want === undefined ? v.paused : want;
    if (go) v.play().catch(() => {}); else v.pause();
  }
  function seekBy(d) { if (isFinite(v.duration)) v.currentTime = Math.max(0, Math.min(v.duration - 0.05, v.currentTime + d)); }
  function order() {
    if (!S.state.shuffle) return null;
    if (!S.order || S.order.length !== S.items.length) {
      const rest = S.items.map((_, i) => i).filter((i) => i !== S.index);
      for (let i = rest.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [rest[i], rest[j]] = [rest[j], rest[i]]; }
      S.order = S.index >= 0 ? [S.index].concat(rest) : rest;
    }
    return S.order;
  }
  function step(dir) {
    const n = S.items.length; if (!n) return -1;
    const o = order();
    if (o) { const k = o.indexOf(S.index); const j = k + dir; if (j >= 0 && j < n) return o[j]; return S.state.repeat === 'all' ? o[(j + n) % n] : -1; }
    const j = S.index + dir; if (j >= 0 && j < n) return j;
    return S.state.repeat === 'all' ? (j + n) % n : -1;
  }
  function next(auto) {
    if (auto && S.state.repeat === 'one') { v.currentTime = 0; v.play().catch(() => {}); return; }
    const j = step(1);
    if (j < 0) { if (auto) { paintPlay(); } else toast('That was the last item in the play queue'); return; }
    playAt(j);
  }
  function prev() {
    if (v.currentTime > 3) { v.currentTime = 0; return; }
    const j = step(-1);
    if (j < 0) { v.currentTime = 0; return; }
    playAt(j);
  }

  /* ---- video events -> the controls --------------------------------------------------------------- */
  function paintPlay() {
    const playing = !v.paused && !v.ended;
    setIc($('play'), playing ? 'pause' : 'play');
    $('play').title = playing ? 'Pause (Space)' : 'Play (Space)'; $('play').setAttribute('aria-label', playing ? 'Pause' : 'Play');
    $('bigplay').hidden = playing || !root.classList.contains('video') || !S.cur || !$('nope').hidden;
    try { navigator.mediaSession.playbackState = playing ? 'playing' : (S.cur ? 'paused' : 'none'); } catch (_) { /* old */ }
    $('prev').disabled = !S.items.length; $('next').disabled = S.items.length < 2 && S.state.repeat === 'off';
    idleArm();
  }
  function paintTime() {
    const d = v.duration, t = v.currentTime;
    const f = isFinite(d) && d > 0 ? Math.min(1, t / d) : 0;
    if (!S.seekDrag) { $('fill').style.transform = 'scaleX(' + f + ')'; $('knob').style.left = (f * 100) + '%'; $('tcur').textContent = PR.clock(t); }
    $('bar').setAttribute('aria-valuenow', String(Math.round(t))); $('bar').setAttribute('aria-valuetext', PR.clock(t) + ' of ' + PR.clock(d));
  }
  v.addEventListener('play', paintPlay);
  v.addEventListener('pause', () => { paintPlay(); saveResume(true); });
  v.addEventListener('playing', paintPlay);
  v.addEventListener('timeupdate', () => { paintTime(); if (Date.now() - S.lastSave > 5000) saveResume(false); });
  v.addEventListener('durationchange', () => { $('tdur').textContent = PR.clock(v.duration); $('bar').setAttribute('aria-valuemax', String(Math.round(v.duration || 0))); paintTime(); position(); });
  v.addEventListener('loadedmetadata', () => { paintAudio(); paintCc(); if (S.subChoice !== null) pickSub(S.subChoice); position(); });
  v.addEventListener('seeked', () => { paintTime(); position(); });
  v.addEventListener('ratechange', () => { $('speed').textContent = (Math.round(v.playbackRate * 100) / 100) + '×'; position(); });
  v.addEventListener('progress', () => { const b = v.buffered; const d = v.duration; if (b.length && d > 0) $('buf').style.transform = 'scaleX(' + Math.min(1, b.end(b.length - 1) / d) + ')'; });
  v.addEventListener('ended', () => { saveResume(true, true); paintPlay(); next(true); });
  v.addEventListener('volumechange', paintVol);
  v.addEventListener('error', () => {
    if (!S.cur || !v.getAttribute('src')) return;
    const e = v.error;
    showNope('Can\'t play ' + S.cur.name, PR.errorWords(e && e.code, e && e.message, S.cur.probe), 'Open it with another app, or skip to the next item');
    paintPlay();
  });
  function saveResume(now, ended) {
    const c = cur(); if (!c || !S.cur || !isFinite(v.duration) || v.duration <= 0) return;
    S.lastSave = Date.now();
    call('player.resume', { path: c, t: ended ? v.duration : v.currentTime, d: v.duration, now: !!now });
  }

  /* ---- seek + volume bars (pointer + keys) ------------------------------------------------------- */
  function frac(el, ev) { const r = el.getBoundingClientRect(); return Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)); }
  const bar = $('bar');
  bar.addEventListener('pointerdown', (ev) => {
    if (!isFinite(v.duration)) return;
    bar.setPointerCapture(ev.pointerId); bar.classList.add('drag'); S.seekDrag = { f: frac(bar, ev) }; seekPreview(ev);
  });
  bar.addEventListener('pointermove', (ev) => { if (isFinite(v.duration)) seekPreview(ev); });
  bar.addEventListener('pointerleave', () => { if (!S.seekDrag) $('hovert').hidden = true; });
  const seekEnd = (ev) => { if (!S.seekDrag) return; const f = frac(bar, ev); S.seekDrag = null; bar.classList.remove('drag'); $('hovert').hidden = true; v.currentTime = f * v.duration; paintTime(); };
  bar.addEventListener('pointerup', seekEnd); bar.addEventListener('pointercancel', seekEnd);
  function seekPreview(ev) {
    const f = frac(bar, ev), ht = $('hovert');
    ht.hidden = false; ht.style.left = (f * 100) + '%'; ht.textContent = PR.clock(f * v.duration);
    if (S.seekDrag) { S.seekDrag.f = f; $('fill').style.transform = 'scaleX(' + f + ')'; $('knob').style.left = (f * 100) + '%'; $('tcur').textContent = PR.clock(f * v.duration); }
  }
  bar.addEventListener('keydown', (ev) => {
    const k = ev.key;
    if (k === 'ArrowLeft' || k === 'ArrowRight') { seekBy(k === 'ArrowLeft' ? -5 : 5); ev.preventDefault(); ev.stopPropagation(); }
    else if (k === 'Home') { v.currentTime = 0; ev.preventDefault(); } else if (k === 'End' && isFinite(v.duration)) { v.currentTime = Math.max(0, v.duration - 0.1); ev.preventDefault(); }
  });
  const vol = $('vol');
  function setVol(x) { v.volume = Math.max(0, Math.min(1, Math.round(x * 100) / 100)); if (v.volume > 0 && v.muted) v.muted = false; saveState({ volume: v.volume, muted: v.muted }); }
  vol.addEventListener('pointerdown', (ev) => { vol.setPointerCapture(ev.pointerId); vol.dataset.drag = '1'; setVol(frac(vol, ev)); });
  vol.addEventListener('pointermove', (ev) => { if (vol.dataset.drag) setVol(frac(vol, ev)); });
  vol.addEventListener('pointerup', () => { delete vol.dataset.drag; });
  vol.addEventListener('wheel', (ev) => { setVol(v.volume + (ev.deltaY < 0 ? 0.05 : -0.05)); ev.preventDefault(); }, { passive: false });
  vol.addEventListener('keydown', (ev) => { if (ev.key === 'ArrowLeft' || ev.key === 'ArrowDown') { setVol(v.volume - 0.05); ev.preventDefault(); ev.stopPropagation(); } else if (ev.key === 'ArrowRight' || ev.key === 'ArrowUp') { setVol(v.volume + 0.05); ev.preventDefault(); ev.stopPropagation(); } });
  function paintVol() {
    const x = v.muted ? 0 : v.volume;
    $('volfill').style.transform = 'scaleX(' + x + ')'; $('volknob').style.left = (x * 100) + '%';
    vol.setAttribute('aria-valuenow', String(Math.round(x * 100)));
    setIc($('mute'), v.muted || v.volume === 0 ? 'mute' : v.volume < 0.5 ? 'vol1' : 'vol');
    $('mute').title = v.muted ? 'Unmute (M)' : 'Mute (M)'; $('mute').setAttribute('aria-pressed', String(v.muted));
  }
  function toggleMute() { v.muted = !v.muted; if (!v.muted && v.volume === 0) v.volume = 0.5; saveState({ muted: v.muted, volume: v.volume }); }

  /* ---- menus (speed, subtitles, sound track) ------------------------------------------------------ */
  function menu(anchor, items) {
    const m = $('menu');
    if (S.menuFor === anchor && !m.hidden) { closeMenu(); return; }
    m.replaceChildren();
    for (const it of items) {
      if (it.head) { m.appendChild(h('div', 'mh', it.head)); continue; }
      if (it.note) { m.appendChild(h('div', 'mnote', it.note)); continue; }
      const b = h('button', 'mi'); b.type = 'button'; b.setAttribute('role', 'menuitemradio'); b.setAttribute('aria-checked', String(!!it.on));
      const ck = h('span', 'ck'); if (it.on) ck.innerHTML = ic('check'); b.append(ck, h('span', null, it.label));
      b.disabled = !!it.disabled;
      b.addEventListener('click', () => { closeMenu(); it.act(); });
      m.appendChild(b);
    }
    m.hidden = false; S.menuFor = anchor;
    const r = anchor.getBoundingClientRect(), mr = m.getBoundingClientRect();
    m.style.left = Math.max(8, Math.min(innerWidth - mr.width - 8, r.left + r.width / 2 - mr.width / 2)) + 'px';
    m.style.top = Math.max(8, r.top - mr.height - 8) + 'px';
    const first = m.querySelector('.mi:not(:disabled)'); if (first) first.focus();
  }
  function closeMenu() { $('menu').hidden = true; S.menuFor = null; idleArm(); }
  document.addEventListener('pointerdown', (ev) => { if (!$('menu').hidden && !$('menu').contains(ev.target) && ev.target !== S.menuFor && !(S.menuFor && S.menuFor.contains(ev.target))) closeMenu(); }, true);
  function setSpeed(x) { v.playbackRate = x; v.defaultPlaybackRate = x; saveState({ speed: x }); }
  $('speed').addEventListener('click', () => menu($('speed'), [{ head: 'Speed' }].concat(SPEEDS.map((x) => ({ label: x === 1 ? 'Normal' : x + '×', on: Math.abs(v.playbackRate - x) < 0.01, act: () => setSpeed(x) })))));
  function stepSpeed(d) { const i = SPEEDS.findIndex((x) => Math.abs(x - v.playbackRate) < 0.01); const j = Math.max(0, Math.min(SPEEDS.length - 1, (i < 0 ? 3 : i) + d)); setSpeed(SPEEDS[j]); toast('Speed ' + (SPEEDS[j] === 1 ? 'normal' : SPEEDS[j] + '×')); }
  $('cc').addEventListener('click', () => {
    const ts = textTracks();
    const items = [{ head: 'Subtitles' }, { label: 'Off', on: S.subChoice === null, act: () => pickSub(null) }].concat(ts.map((t, i) => ({ label: t.label || ('Track ' + (i + 1)), on: S.subChoice === i, act: () => pickSub(i) })));
    const inside = S.cur && S.cur.probe ? S.cur.probe.tracks.filter((t) => t.type === 'text' && t.codec !== 'webvtt') : [];
    if (inside.length) items.push({ note: 'This file has ' + inside.length + ' built-in subtitle track' + (inside.length === 1 ? '' : 's') + ' (' + inside[0].label + ') Mantle Player can\'t show yet' });
    if (!ts.length) items.push({ note: 'Put a .srt or .vtt file with the same name next to the video' });
    menu($('cc'), items);
  });
  function audioTracks() { const a = v.audioTracks; return a && typeof a.length === 'number' ? Array.from({ length: a.length }, (_, i) => a[i]) : null; }
  function paintAudio() {
    const a = audioTracks(), b = $('atrack');
    b.disabled = !(a && a.length > 1);
    b.title = a ? (a.length > 1 ? 'Sound track (' + a.length + ')' : 'This file has one sound track') : 'Sound track choice is not available here';
  }
  $('atrack').addEventListener('click', () => {
    const a = audioTracks() || [];
    menu($('atrack'), [{ head: 'Sound track' }].concat(a.map((t, i) => ({ label: t.label || (t.language ? t.language.toUpperCase() : 'Track ' + (i + 1)), on: t.enabled, act: () => { a.forEach((x, j) => { x.enabled = j === i; }); } }))));
  });

  /* ---- buttons ------------------------------------------------------------------------------------ */
  $('play').addEventListener('click', () => playPause());
  $('bigplay').addEventListener('click', () => playPause(true));
  $('prev').addEventListener('click', prev);
  $('next').addEventListener('click', () => next(false));
  $('mute').addEventListener('click', toggleMute);
  function setShuffle(on) { S.state.shuffle = on; S.order = null; $('shuf').setAttribute('aria-pressed', String(on)); $('shuf').title = on ? 'Shuffle: on (S)' : 'Shuffle: off (S)'; saveState({ shuffle: on }); }
  $('shuf').addEventListener('click', () => setShuffle(!S.state.shuffle));
  function setRepeat(r) {
    S.state.repeat = r; const b = $('rep');
    setIc(b, r === 'one' ? 'repeat1' : 'repeat'); b.setAttribute('aria-pressed', String(r !== 'off'));
    b.title = 'Repeat: ' + (r === 'off' ? 'off' : r === 'all' ? 'all' : 'this one') + ' (R)'; b.setAttribute('aria-label', b.title.replace(/ \(R\)$/, ''));
    saveState({ repeat: r }); paintPlay();
  }
  $('rep').addEventListener('click', () => setRepeat(S.state.repeat === 'off' ? 'all' : S.state.repeat === 'all' ? 'one' : 'off'));
  function win(op) { return call('player.window', { op, kind: root.classList.contains('video') ? 'video' : 'audio' }).then((r) => { if (r && r.ok === false) toast(words(r, 'The window did not change'), null, null, 'warn'); else if (r && 'full' in r) applyWin(r); return r; }); }
  $('full').addEventListener('click', () => win(S.win.full ? 'unfull' : 'full'));
  $('wmini').addEventListener('click', () => win('mini'));
  $('unmini').addEventListener('click', () => win('unmini'));
  $('wmin').addEventListener('click', () => win('min'));
  $('wmax').addEventListener('click', () => win('max'));
  $('wclose').addEventListener('click', () => { saveResume(true); win('close'); });
  v.addEventListener('dblclick', () => win(S.win.full ? 'unfull' : 'full'));
  v.addEventListener('click', () => { if (root.classList.contains('video')) playPause(); });
  function applyWin(st) {
    S.win = Object.assign({}, S.win, st);
    root.classList.toggle('full', !!S.win.full); root.classList.toggle('mini', !!S.win.mini);
    setIc($('full'), S.win.full ? 'unfull' : 'full'); $('full').title = S.win.full ? 'Exit full screen (F or Esc)' : 'Full screen (F)';
    setIc($('wmax'), S.win.max ? 'restore' : 'max'); $('wmax').title = S.win.max ? 'Restore' : 'Maximise';
    if (S.win.full || S.win.mini) setView('now', true);
    idleArm();
  }
  /* full screen: the controls hide after the mouse rests 2.5 s while playing (one timer, armed by movement) */
  function idleArm() {
    clearTimeout(S.idleT); root.classList.remove('idle');
    if (S.win.full && !v.paused && $('menu').hidden) S.idleT = setTimeout(() => { if (S.win.full && !v.paused && $('menu').hidden) root.classList.add('idle'); }, 2500);
  }
  document.addEventListener('pointermove', () => { if (S.win.full) idleArm(); }, { passive: true });
  $('nopeskip').addEventListener('click', () => next(false));
  $('nopewith').addEventListener('click', () => call('player.openwith', { path: cur() }).then((r) => toast(r.ok ? (r.dryRun ? r.reason : 'Pick an app in the Windows window') : words(r, 'Open with did not open'), null, null, r.ok ? null : 'warn')));
  $('nopefiles').addEventListener('click', () => call('player.reveal', { path: cur() }).then((r) => { if (!r.ok || r.dryRun || r.reason) toast(words(r, 'It could not be shown'), null, null, r.ok ? null : 'warn'); }));

  /* ---- keys ---------------------------------------------------------------------------------------- */
  document.addEventListener('keydown', (ev) => {
    const t = ev.target, typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA');
    if (!$('dlg').hidden) { if (ev.key === 'Escape') closeDlg(); else if (ev.key === 'Enter') $('dlgok').click(); return; }
    if (ev.key === 'Escape') { if (!$('menu').hidden) closeMenu(); else if (S.win.full) win('unfull'); else if (S.win.mini) win('unmini'); else if (typing) t.blur(); ev.preventDefault(); return; }
    if (ev.ctrlKey && !ev.altKey) {
      const k = ev.key.toLowerCase();
      if (k === 'o') { $('picker').click(); ev.preventDefault(); } else if (k === 'f') { $('q').focus(); $('q').select(); ev.preventDefault(); } else if (k === 'm') { win(S.win.mini ? 'unmini' : 'mini'); ev.preventDefault(); }
      return;
    }
    if (typing || ev.altKey || ev.metaKey || /^Media/.test(ev.key)) return;     // media keys arrive through the media session
    if (t && t.closest && t.closest('.menu')) return;
    const onButton = t && t.tagName === 'BUTTON';
    const k = ev.key;
    let done = true;
    if (k === ' ' && !onButton || k === 'k' || k === 'K' && !ev.shiftKey) playPause();
    else if (k === 'ArrowLeft') seekBy(-5); else if (k === 'ArrowRight') seekBy(5);
    else if (k === 'j' || k === 'J') seekBy(-10); else if (k === 'l' || k === 'L') seekBy(10);
    else if (k === 'ArrowUp' && !(t && t.closest && t.closest('.vbody'))) setVol(v.volume + 0.05);
    else if (k === 'ArrowDown' && !(t && t.closest && t.closest('.vbody'))) setVol(v.volume - 0.05);
    else if (k === 'm' || k === 'M') toggleMute();
    else if (k === 'f' || k === 'F') { if (root.classList.contains('video')) win(S.win.full ? 'unfull' : 'full'); }
    else if (k === 'N' && ev.shiftKey) next(false); else if (k === 'P' && ev.shiftKey) prev();
    else if (k === '>' || k === '.' && ev.shiftKey) stepSpeed(1); else if (k === '<' || k === ',' && ev.shiftKey) stepSpeed(-1);
    else if (k === 'c' || k === 'C') { const ts = textTracks(); if (ts.length) { pickSub(S.subChoice === null ? 0 : null); toast(S.subChoice === null ? 'Subtitles off' : 'Subtitles: ' + (ts[0].label || 'on')); } else toast('No subtitles for this file'); }
    else if (k === 's' || k === 'S') { setShuffle(!S.state.shuffle); toast(S.state.shuffle ? 'Shuffle on' : 'Shuffle off'); }
    else if (k === 'r' || k === 'R') { $('rep').click(); toast($('rep').getAttribute('aria-label')); }
    else if (/^[0-9]$/.test(k) && isFinite(v.duration)) v.currentTime = v.duration * Number(k) / 10;
    else if (k === 'Home' && !onButton) v.currentTime = 0;
    else if (k === 'End' && !onButton && isFinite(v.duration)) v.currentTime = Math.max(0, v.duration - 0.1);
    else done = false;
    if (done && !(k === ' ' && onButton)) ev.preventDefault();
  });

  /* ---- opening: picker, drag and drop ----------------------------------------------------------- */
  function openPaths(paths, add, via) {
    const ps = paths.filter(Boolean);
    if (!ps.length) { toast('Those can\'t be opened: drop files from a folder on this PC', null, null, 'warn'); return; }
    call('player.open', { paths: ps, add: !!add, via }).then((r) => { if (!r.ok) toast(words(r, 'They did not open'), null, null, 'warn'); else if (add) toast('Added ' + r.count + ' to the play queue'); });
  }
  $('openfiles').addEventListener('click', () => $('picker').click());
  $('openfiles2').addEventListener('click', () => $('picker').click());
  $('picker').addEventListener('change', () => { const fs = Array.from($('picker').files || []); openPaths(fs.map((f) => M.pathForFile(f)), false, 'Open files'); $('picker').value = ''; });
  let dragN = 0;
  const hasFiles = (ev) => ev.dataTransfer && Array.from(ev.dataTransfer.types || []).includes('Files');
  window.addEventListener('dragenter', (ev) => { if (!hasFiles(ev)) return; dragN++; $('drop').hidden = false; $('drop').firstChild.textContent = ev.shiftKey ? 'Drop to add to the play queue' : 'Drop to play'; if (S.view !== 'now') setView('now'); });
  window.addEventListener('dragover', (ev) => { if (hasFiles(ev)) { ev.preventDefault(); ev.dataTransfer.dropEffect = 'copy'; } });
  window.addEventListener('dragleave', () => { dragN = Math.max(0, dragN - 1); if (!dragN) $('drop').hidden = true; });
  window.addEventListener('drop', (ev) => { ev.preventDefault(); dragN = 0; $('drop').hidden = true; const fs = Array.from((ev.dataTransfer && ev.dataTransfer.files) || []); openPaths(fs.map((f) => M.pathForFile(f)), ev.shiftKey, 'drag and drop'); });

  /* ---- queue + state persistence ----------------------------------------------------------------- */
  let qT = null;
  function saveQueue() { clearTimeout(qT); qT = setTimeout(() => call('player.queue', { items: S.items, index: S.index }), 400); $('qcount').textContent = S.items.length ? String(S.items.length) : ''; }
  function saveState(p) { Object.assign(S.state, p); call('player.state', p); }
  function load(l) {
    if (!l || !Array.isArray(l.items) || !l.items.length) return;
    if (l.add && S.items.length) { S.items = S.items.concat(l.items); S.order = null; saveQueue(); paintQueue(); if (!S.cur) playAt(S.items.length - l.items.length); return; }
    S.items = l.items.slice(); S.order = null;
    setView('now');
    playAt(Math.max(0, Math.min(S.items.length - 1, l.index || 0)));
  }

  /* ---- views ---------------------------------------------------------------------------------------- */
  function setView(view, quiet) {
    S.view = view;
    document.querySelectorAll('.view').forEach((s) => { s.hidden = s.dataset.view !== (view === 'albums' || view === 'artists' ? 'songs' : view); });
    document.querySelectorAll('.ni[data-view]').forEach((b) => b.classList.toggle('on', b.dataset.view === view));
    if (view !== 'now' && !quiet) saveState({ view });
    if (view === 'songs' || view === 'videos') { if (!S.lib) refreshLib(); else renderLib(); }
    else if (view === 'playlists') renderPlaylists();
    else if (view === 'queue') paintQueue();
  }
  document.querySelectorAll('.ni[data-view]').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
  document.querySelectorAll('.tab[data-sub]').forEach((b) => b.addEventListener('click', () => { S.sub = b.dataset.sub; renderLib(); }));
  $('q').addEventListener('input', () => { clearTimeout(S.libT); S.libT = setTimeout(() => { S.q = $('q').value.trim(); if (S.view !== 'songs' && S.view !== 'videos') setView(S.q && S.lib && !S.lib.songs.length && S.lib.videos.length ? 'videos' : 'songs'); refreshLib(); }, 150); });
  $('rescan1').addEventListener('click', () => rescan()); $('rescan2').addEventListener('click', () => rescan());
  function rescan() { call('player.rescan', {}).then((r) => { if (r.ok) { S.lib = r; renderLib(); } else toast(words(r, 'The rescan did not start'), null, null, 'warn'); }); }
  function refreshLib() {
    return call('player.library', { q: S.q }).then((r) => { if (!r.ok) { S.lib = { songs: [], videos: [], albums: [], artists: [], reason: words(r, 'the library could not be read'), scanning: false, roots: [] }; } else S.lib = r; renderLib(); });
  }
  function scanWords(L, what) {
    if (L.scanning) return 'Reading your ' + (L.roots || []).join(' and ') + ' folders…';
    if (L.reason) return L.reason;
    return L.at ? '' : '';
  }
  function emptyLib(el, title, text, withOpen) {
    const e = h('div', 'empty'); const ico = h('div', 'eico'); ico.innerHTML = ic(title === 'music' ? 'music' : 'video');
    e.append(ico, h('div', 'eh', text[0]), h('div', 'ep', text[1]));
    if (withOpen) { const a = h('div', 'acts'); const b = h('button', 'btn acc', 'Open files'); b.type = 'button'; b.addEventListener('click', () => $('picker').click()); a.append(b); e.append(a); }
    el.replaceChildren(e);
  }
  function playList(paths, i, shuffle) { if (!paths.length) return; if (shuffle !== undefined) setShuffle(!!shuffle); load({ items: paths, index: shuffle ? Math.floor(Math.random() * paths.length) : i || 0 }); }
  function renderLib() {
    const L = S.lib; if (!L) return;
    const sw = scanWords(L);
    $('scan1').textContent = sw; $('scan2').textContent = sw;
    $('rescan1').disabled = !!L.scanning; $('rescan2').disabled = !!L.scanning;
    document.querySelectorAll('.tab[data-sub]').forEach((b) => b.classList.toggle('on', b.dataset.sub === S.sub));
    const mb = $('musicbody'), vb = $('videobody');
    $('playall').disabled = !L.songs.length; $('shuffleall').disabled = !L.songs.length;
    if (!L.songs.length) emptyLib(mb, 'music', S.q ? ['No music matches “' + S.q + '”', 'Try fewer words'] : L.scanning ? ['Reading your music…', 'Songs appear here as they are found'] : ['No music yet', 'Mantle Player shows the songs in your ' + ((L.roots || []).includes('Music') ? 'Music folder' : 'library folders') + '. Add some there, or open files to play them now.'], !S.q && !L.scanning);
    else if (S.sub === 'albums') mb.replaceChildren(grid(L.albums.map((a) => card(a.album || 'Unknown album', a.artist || 'Unknown artist', a.cover, 'music', () => playList(a.songs, 0)))));
    else if (S.sub === 'artists') mb.replaceChildren(grid(L.artists.map((a) => { const c = card(a.artist || 'Unknown artist', a.songs.length + (a.songs.length === 1 ? ' song' : ' songs'), null, null, () => playList(a.songs, 0)); c.classList.add('artist'); c.querySelector('.pic').textContent = (a.artist || '?').trim().charAt(0).toUpperCase(); return c; })));
    else mb.replaceChildren(songRows(L.songs, (i) => playList(L.songs.map((s) => s.path), i)));
    if (!L.videos.length) emptyLib(vb, 'video', S.q ? ['No videos match “' + S.q + '”', 'Try fewer words'] : L.scanning ? ['Reading your videos…', 'They appear here as they are found'] : ['No videos yet', 'Mantle Player shows the videos in your Videos folder, Game Bar and Mantle clips included. Open files to play others.'], !S.q && !L.scanning);
    else { const g = grid(L.videos.map((x, i) => { const c = card(x.title, x.folder, S.thumbs[x.path] || null, 'video', () => playList(L.videos.map((y) => y.path), i)); c.classList.add('vid'); c.dataset.path = x.path; return c; }), true); vb.replaceChildren(g); watchThumbs(g); }
  }
  function grid(cards, wide) { const g = h('div', 'grid' + (wide ? ' wide' : '')); g.append(...cards); return g; }
  function card(t1, t2, img, ph, fn) {
    const c = h('button', 'card'); c.type = 'button'; c.title = 'Play ' + t1;
    const pic = h('div', 'pic');
    if (img) { const i = h('img'); i.src = img; i.alt = ''; i.loading = 'lazy'; i.decoding = 'async'; pic.append(i); } else if (ph) { const s = h('div', 'ph'); s.innerHTML = ic(ph); pic.append(s); }
    c.append(pic, h('div', 'c1', t1), h('div', 'c2', t2 || ''));
    c.addEventListener('click', fn);
    return c;
  }
  function songRows(songs, play) {
    const box = h('div', 'rows');
    const hd = h('div', 'row rowhead'); hd.append(h('div', 'rn', '#'), h('div', null, 'Title'), h('div', null, 'Artist'), h('div', null, 'Album'), h('div', 'rd', ''), h('div'));
    box.append(hd);
    const c = cur();
    songs.forEach((s, i) => {
      const r = h('div', 'row' + (c && c.toLowerCase() === s.path.toLowerCase() ? ' cur' : '')); r.tabIndex = 0; r.dataset.path = s.path;
      r.append(h('div', 'rn', s.track ? String(s.track) : ''), h('div', 'rt', s.title), h('div', 'rs', s.artist || 'Unknown artist'), h('div', 'rs', s.album || 'Unknown album'), h('div', 'rd', s.year || ''), h('div'));
      r.addEventListener('dblclick', () => play(i)); r.addEventListener('click', (ev) => { if (ev.detail === 1) play(i); });
      r.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') play(i); });
      box.append(r);
    });
    return box;
  }
  /* video thumbnails: asked for only when a card scrolls into view, 24 at a time */
  let io = null;
  function watchThumbs(g) {
    if (io) io.disconnect();
    io = new IntersectionObserver((ents) => { for (const e of ents) if (e.isIntersecting) { const p = e.target.dataset.path; if (p && !(p in S.thumbs)) S.thumbQ.add(p); io.unobserve(e.target); } if (S.thumbQ.size && !S.thumbT) S.thumbT = setTimeout(pumpThumbs, 60); }, { root: $('videobody'), rootMargin: '200px' });
    g.querySelectorAll('.card.vid').forEach((c) => { if (!S.thumbs[c.dataset.path]) io.observe(c); });
  }
  function pumpThumbs() {
    S.thumbT = null;
    const batch = Array.from(S.thumbQ).slice(0, 24); batch.forEach((p) => S.thumbQ.delete(p));
    if (!batch.length) return;
    call('player.thumbs', { paths: batch }).then((r) => {
      const got = (r && r.thumbs) || {};
      for (const p of batch) {
        S.thumbs[p] = got[p] || null;
        const c = Array.from(document.querySelectorAll('.card.vid')).find((x) => x.dataset.path === p);
        if (c && got[p]) { const pic = c.querySelector('.pic'); const i = h('img'); i.src = got[p]; i.alt = ''; pic.replaceChildren(i); }
      }
      if (r && r.reason && !S.thumbWarned) { S.thumbWarned = true; $('scan2').textContent = r.reason; }
      if (S.thumbQ.size) S.thumbT = setTimeout(pumpThumbs, 60);
    });
  }
  $('playall').addEventListener('click', () => S.lib && playList(S.lib.songs.map((s) => s.path), 0, false));
  $('shuffleall').addEventListener('click', () => S.lib && playList(S.lib.songs.map((s) => s.path), 0, true));

  /* queue view */
  function paintQueue() {
    $('qcount').textContent = S.items.length ? String(S.items.length) : '';
    if (S.view !== 'queue') return;
    const qb = $('qbody');
    $('qclear').disabled = !S.items.length; $('qsave').disabled = !S.items.length;
    if (!S.items.length) { const e = h('div', 'empty'); const i = h('div', 'eico'); i.innerHTML = ic('queue'); e.append(i, h('div', 'eh', 'The play queue is empty'), h('div', 'ep', 'Play something from Music or Videos, or drop files here')); qb.replaceChildren(e); return; }
    const box = h('div', 'rows');
    S.items.forEach((p, i) => {
      const r = h('div', 'row' + (i === S.index ? ' cur' : '')); r.tabIndex = 0; r.dataset.i = String(i);
      const x = h('button', 'rx'); x.type = 'button'; x.title = 'Remove from the queue'; x.setAttribute('aria-label', 'Remove ' + stem(p)); x.innerHTML = ic('x');
      x.addEventListener('click', (ev) => { ev.stopPropagation(); removeAt(i); });
      r.append(h('div', 'rn', String(i + 1)), h('div', 'rt', stem(p)), h('div', 'rs', PR.kindOf(p) === 'video' ? 'Video' : 'Music'), h('div', 'rs', ''), h('div', 'rd', ''), x);
      r.addEventListener('click', () => playAt(i)); r.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') playAt(i); else if (ev.key === 'Delete') removeAt(i); });
      box.append(r);
    });
    qb.replaceChildren(box);
  }
  function removeAt(i) {
    const p = S.items[i]; const wasCur = i === S.index;
    S.items.splice(i, 1); S.order = null;
    if (i < S.index) S.index--;
    if (wasCur) { if (S.items.length) playAt(Math.min(i, S.items.length - 1)); else stopAll(); }
    saveQueue(); paintQueue();
    toast('Removed ' + stem(p), 'Undo', () => { S.items.splice(i, 0, p); if (i <= S.index && !wasCur) S.index++; S.order = null; saveQueue(); paintQueue(); });
  }
  function stopAll() { S.gen++; v.pause(); v.removeAttribute('src'); v.load(); clearTracks(); S.cur = null; S.index = -1; $('nope').hidden = true; $('nothing').hidden = false; notice(null); paintNow(null, ''); $('npt').textContent = 'Nothing playing'; $('ttl').textContent = 'Mantle Player'; setKind('audio'); $('cover').hidden = true; paintPlay(); try { navigator.mediaSession.metadata = null; } catch (_) { /* old */ } }
  $('qclear').addEventListener('click', () => { const was = { items: S.items.slice(), index: S.index }; S.items = []; stopAll(); saveQueue(); paintQueue(); toast('Cleared the play queue', 'Undo', () => { S.items = was.items; saveQueue(); if (was.index >= 0) playAt(was.index, { autoplay: false }); paintQueue(); }); });
  $('qsave').addEventListener('click', () => openDlg('Save as playlist', '', (name) => call('player.plsave', { name, items: S.items }).then((r) => { if (r.ok) toast('Saved “' + r.playlist.name + '” (' + r.playlist.count + ')'); else toast(words(r, 'It was not saved'), null, null, 'warn'); return r; })));

  /* playlists */
  function renderPlaylists() {
    const pb = $('plbody');
    $('plback').hidden = !S.pl; $('plplay').hidden = !S.pl; $('pldel').hidden = !S.pl; $('plh').textContent = S.pl ? S.pl.name : 'Playlists';
    if (S.pl) {
      const box = h('div', 'rows');
      S.pl.items.forEach((p, i) => { const r = h('div', 'row'); r.tabIndex = 0; r.append(h('div', 'rn', String(i + 1)), h('div', 'rt', stem(p)), h('div', 'rs', PR.kindOf(p) === 'video' ? 'Video' : 'Music'), h('div'), h('div'), h('div')); r.addEventListener('click', () => playList(S.pl.items, i)); box.append(r); });
      if (!S.pl.items.length) box.append(h('div', 'ep', 'This playlist is empty'));
      pb.replaceChildren(box); return;
    }
    call('player.playlists').then((r) => {
      const list = (r && r.playlists) || [];
      if (!list.length) { const e = h('div', 'empty'); const i = h('div', 'eico'); i.innerHTML = ic('list'); e.append(i, h('div', 'eh', 'No playlists yet'), h('div', 'ep', 'Play some songs or videos, then save the play queue as a playlist')); pb.replaceChildren(e); return; }
      pb.replaceChildren(grid(list.map((x) => { const c = card(x.name, x.count + (x.count === 1 ? ' item' : ' items'), null, 'list', () => openPl(x.id)); c.title = 'Open ' + x.name; return c; })));
    });
  }
  function openPl(id) { call('player.playlist', { id }).then((r) => { if (!r.ok) { toast(words(r, 'That playlist is gone'), null, null, 'warn'); return; } S.pl = r.playlist; renderPlaylists(); }); }
  $('plback').addEventListener('click', () => { S.pl = null; renderPlaylists(); });
  $('plplay').addEventListener('click', () => S.pl && playList(S.pl.items, 0));
  $('pldel').addEventListener('click', () => { const pl = S.pl; if (!pl) return; call('player.pldelete', { id: pl.id }).then((r) => { if (!r.ok) { toast(words(r, 'It was not deleted'), null, null, 'warn'); return; } S.pl = null; renderPlaylists(); toast('Deleted “' + pl.name + '”', 'Undo', () => call('player.plrestore', { playlist: r.undo }).then(() => renderPlaylists())); }); });

  /* the one dialog */
  let dlgFn = null;
  function openDlg(title, value, fn) { $('dlgh').textContent = title; $('dlgin').value = value; dlgFn = fn; $('dlg').hidden = false; $('dlgin').focus(); }
  function closeDlg() { $('dlg').hidden = true; dlgFn = null; }
  $('dlgno').addEventListener('click', closeDlg);
  $('dlgok').addEventListener('click', () => { const name = $('dlgin').value.trim(); if (!name) { $('dlgin').focus(); return; } const f = dlgFn; closeDlg(); if (f) f(name); });

  /* ---- from main --------------------------------------------------------------------------------- */
  M.on('player.load', (l) => load(l));
  M.on('player.window', (st) => applyWin(st));
  M.on('player.focus', (f) => root.classList.toggle('inactive', !(f && f.on)));
  M.on('player.library', () => { if (S.view === 'songs' || S.view === 'videos' || S.lib) refreshLib(); });

  call('player.boot').then((b) => {
    if (!b.ok) { showNope('Mantle Player did not start', words(b, 'Mantle did not answer')); return; }
    S.test = !!b.test; $('testchip').hidden = !S.test;
    const st = b.state || {};
    Object.assign(S.state, st);
    v.volume = typeof st.volume === 'number' ? st.volume : 1; v.muted = !!st.muted;
    setShuffle(!!st.shuffle); setRepeat(st.repeat || 'off');
    $('speed').textContent = (st.speed || 1) + '×';
    applyWin(b.window || {}); paintVol(); paintPlay(); paintCc(); paintAudio();
    if (b.pending && b.pending.length) { b.pending.forEach(load); }
    else {
      if (b.queue && Array.isArray(b.queue.items) && b.queue.items.length) { S.items = b.queue.items; playAt(Math.max(0, Math.min(S.items.length - 1, b.queue.index || 0)), { autoplay: false }); }
      setView(S.items.length ? 'now' : (st.view && st.view !== 'now' ? st.view : 'songs'), true);
    }
    if (S.test) window.__player = { S, v, MS, can, textTracks, audioTracks, pickSub, refreshLib };
  });
})();

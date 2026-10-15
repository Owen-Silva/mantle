/* launcher.js — the renderer half of the launcher.
 *
 * Runs with contextIsolation on and sandbox on: there is no require, no
 * import, no Node here. `window.mantle` (lane B's preload) is the ONLY way out
 * of this page, and mock-mantle.js supplies a stand-in when this file is
 * opened straight from disk for a visual check.
 *
 * THE THEME IS THE TASKBAR'S (Owen, 2026-09-21): "everything that we build for this wrapper,
 * their UI needs to be this exact same theme as the taskbar". Two of the things that makes true
 * live in this file, because the bar's equivalents live in bar.js:
 *
 *  - THE BACKDROP. The glass is a live picture of the screen behind this window, blurred in CSS.
 *    Main sends 'launcher.backdrop' {png, w, h, rect, ms} once just before the window is shown and
 *    then about four times a second while it is up; the ONLY per-frame work here is swapping the
 *    <img> src — no layout, no reflow, one composited layer repainted. body.no-backdrop is the
 *    honest fallback (a thicker tint) and is on at boot, off from the first frame, and back on the
 *    moment the window is hidden: the picture is of a screen that is about to be wrong, and
 *    showing it again on the next open would flash a stale photograph of the desktop. A payload
 *    with no data: URL, or a State piece backdrop.launcher.ok === false, says so in the footer —
 *    "no blur: <reason>" — rather than quietly falling back to a flat pane.
 *
 *  - THE ENTER. Main shows this window and hides it instantly, so there is exactly one animation:
 *    on visibilitychange → visible, body.up lets launcher.css run the panel in over 320ms. The
 *    class comes off on hidden so the next open animates again. Nothing runs at rest.
 *
 * The standing rule behind most of the code below: nothing fails silently.
 * If the bridge is missing, if a source did not index, if a launch did not
 * happen, if the sidecar is down, if there is no blur — the launcher SAYS so,
 * in the launcher, in plain words. A console.error is not a report; nobody has
 * the console open when they tap Win.
 */
(function () {
  'use strict';

  var els = {
    panel: document.getElementById('panel'),
    bdrop: document.querySelector('.bdrop'),
    backdrop: document.getElementById('backdrop'),
    q: document.getElementById('q'),
    results: document.getElementById('results'),
    counts: document.getElementById('counts'),
    srcErrors: document.getElementById('srcErrors'),
    notice: document.getElementById('notice'),
    kbd: document.getElementById('kbdNote'),
    hint: document.getElementById('hint'),
  };

  var mantle = window.mantle;

  var rows = [];        // the items currently on screen: appRows and fileRows, merged by score
  var sel = 0;          // index of the selected row
  var appRows = [];     // the last apps.search answer (apps, commands, settings, power, a URL)
  var userMoved = false; // the selection was moved by hand since the last query, so keep it

  /* FILE ROWS. They come from the Windows Search index through the sidecar (launcher.files), on
     their own debounce, after the app rows: an index query is 50-300 ms on this machine where
     apps.search is a few, so the app rows never wait for them. They slot in by score - the same
     scale apps.search uses, with files capped below any app whose name starts with the query -
     and ties go to the app. */
  var fileRows = [];    // the last answered file rows
  var fileQ = '';       // the query they answered, lowercased
  var fileSeq = 0;      // drops an answer that arrived after a newer query
  var fileState = { status: 'idle', reason: '', ms: 0, n: 0 };
  var fileTimer = null;
  var filePending = false; // a file query is due or on its way for what is typed now
  var FILE_DEBOUNCE_MS = 150;
  var FILE_MIN = 2;     // one letter matches half the disk (1.3 s for "a", measured)

  /* ASK FIRST. Restart, Shut down and Sign out carry item.confirm ("Press Enter again to …").
     The first Enter arms the row; a second Enter on the SAME row within ARM_MS sends it. Moving
     off the row, typing, Esc, hiding the launcher or the timeout all disarm it. A held Enter
     cannot confirm (auto-repeat is ignored, and nothing confirms within ARM_MIN_MS of arming). */
  var armed = null;     // { id, at, timer }
  var ARM_MS = 5000;
  var ARM_MIN_MS = 250;
  var sources = [];     // last { name, count, status, reason }[] from apps.index
  var searchSeq = 0;    // drops a slow response that arrived after a newer one
  var note = null;      // { id, text, ok } — the line printed under one row
  var hideTimer = null;
  var indexError = '';    // why apps.index itself failed, if it did
  var backdropNote = '';  // "no blur: …" — why there is nothing blurred under the tint (the footer line's tooltip, and mantle.log)
  var backdropWords = ''; // the footer line itself for that reason, when the default one would not be true
  var backdropLogged = {}; // each distinct reason goes to mantle.log once
  /* WIN+S (2026-09-24). The rows are laid out in labelled groups by groups.js (Calculator, Apps,
     Commands, Settings, Power, Files, then "Search the web" last); rows is still the ONE flat list
     the arrow keys walk, in on-screen order. calc.js answers arithmetic on every keystroke with no
     round trip. Both are plain scripts loaded before this one; a page without them says so. */
  var Calc = window.MantleCalc;
  var Groups = window.MantleGroups;
  var view = { groups: [], flat: [] };
  var mode = 'apps';          // 'search' when Win+S opened the launcher (placeholder, empty state)
  var pendingOpen = null;     // a launcher.open {mode, query} waiting for the window to be shown
  /* What you typed survives a close and reopen for KEEP_MS, like Raycast (its "pop to root" default
     is 90 s) and Spotlight: the Win tap that closes the launcher must not wipe it (audit #5). It is
     cleared after an action ran (you are done with it) and by Win+S, which brings its own query. */
  var KEEP_MS = 90 * 1000;
  var shownNow = false;       // main said launcher:visible true, and no false since
  var closedAt = 0;           // when it last went hidden (0: never shown and closed yet)
  var clearNext = false;      // the close was an action's: the next open starts clean
  var PLACEHOLDER = {
    apps: 'Apps, files, settings, commands, or a URL',
    search: 'Search apps, files, settings and the web',
    run: 'Type a program, folder, document or website',
    quick: 'Quick links: press a letter',
  };

  /* ONE ACTION PER DECISION (lane launch-ui, 2026-09-29). A held Enter auto-repeats and a
     double-click is two clicks: both used to start an app two or three times. A row's action is
     now ignored while its request is on its way, and again for FIRE_GAP_MS after it was sent, so
     a double-click (~200 ms apart) is one launch however fast main answers. */
  var inFlight = null;        // 'row id|action' whose request has not answered yet
  var lastFire = { key: '', at: 0 };
  var FIRE_GAP_MS = 500;

  /* FRESH APPS. main keeps the index for ten minutes, so an app installed a minute ago was not
     there when you went to open it. Each open (at most every REFRESH_MS) asks for a rebuild in the
     background, after the first rows are on screen, and searches again only if the index changed. */
  var REFRESH_MS = 30000;
  var lastRefresh = 0;
  var indexSig = '';
  var answered = false;       // the first apps.search has answered (until then: the loading line)
  var lastSearched = null;    // the text the last apps.search answer was for

  /* ---- shown / hidden, and the one animation ----------------------------
     Electron fires visibilitychange on window show and hide, which is the only signal this page
     needs: main never animates the window itself. Defined above the bridge check on purpose —
     the panel boots at opacity 0, so a page that cannot reach the bridge must still be able to
     put itself on screen to say so. */
  function panelUp() {
    /* on the NEXT frame: the first paint has to happen in the down state or there is nothing for
       the transition to run from (a class added in the same frame as the first paint just snaps). */
    requestAnimationFrame(function () { document.body.classList.add('up'); });
  }
  function panelDown() {
    document.body.classList.remove('up');
    clearBackdrop();
    disarm();       // an armed Shut down must not still be armed the next time the launcher opens
  }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') panelDown();
    else panelUp();
  });
  // opened in a window that is already on screen (a browser, --test): animate it in now
  if (document.visibilityState !== 'hidden') panelUp();

  /* ---- the backdrop ------------------------------------------------------ */

  var haveBackdrop = false;

  /* The two nodes are in index.html, so this can only be false if someone edits the markup out —
     in which case say it, rather than throw on every show and leave a mystery behind. */
  function bdropNodes() {
    if (els.bdrop && els.backdrop) return true;
    noBlur('this page has no .bdrop wrapper with an <img id="backdrop"> in it, so there is nowhere to put the picture');
    return false;
  }

  function setBackdrop(p) {
    if (!bdropNodes()) return;
    if (!p || typeof p.png !== 'string' || p.png.slice(0, 5) !== 'data:') {
      noBlur('launcher.backdrop arrived without a png data URL' + (p && p.reason ? ': ' + p.reason : ''));
      return;
    }
    if (backdropNote) { backdropNote = ''; renderFooter(); }
    lastRect = { rect: p.rect || null, at: p.at || null, win: p.win || null };   // dark: where main cut it (paintDark below)
    els.backdrop.src = p.png;                    // the ONLY per-frame work: a src swap
    if (!haveBackdrop) {
      haveBackdrop = true;
      document.body.classList.remove('no-backdrop');
      els.bdrop.classList.add('on');             // 150ms fade, once, on the first frame
    }
  }

  /* DARK ONLY: THE ONE READABILITY GUARD (ui/shared/glass-adapt.js guard(), the top bar's rule, same
     code and thresholds; lane same-shell, 2026-10-09, replacing see-glass-b's picture dimming). The pane
     is one layer of --lg-fill over the blurred picture; the tint thickens (never the picture dimming)
     only as far as --lg-ink-2 needs for 4.5:1 over the brightest blurred pixel, capped at --lg-fill-pop,
     into --pane-tint on .panel (the dark ::after reads it). With --lg-fill-pop = --lg-fill (the FINAL
     tokens) there is nothing to thicken and nothing is read. Once per picture that arrives (its load
     event), never on a timer; in light nothing runs. window.__launcherGlass is a read-only view. */
  var GA = window.MantleGlassAdapt || null;
  var panelEl = document.querySelector('.panel');
  var adaptSaid = '';
  function adaptBackdrop() {
    if (!panelEl) return;
    var img = els.backdrop;
    var dark = document.documentElement.getAttribute('data-theme') === 'dark';
    panelEl.style.removeProperty('--pane-tint');
    window.__launcherGlass = null;
    if (!dark || !haveBackdrop || !img || !img.naturalWidth) return;
    var T = GA ? GA.guardTokens(getComputedStyle(document.documentElement)) : null;
    if (T && !(T.ceil > T.fill.a + 1e-9)) { window.__launcherGlass = { alpha: T.fill.a, engaged: false, why: 'ceiling = fill' }; adaptSaid = ''; return; }
    var px = T ? GA.pixelsOf(img) : null;
    var r = px ? GA.guard(px, { tokens: T, picPerCss: img.naturalWidth / windowCut(lastRect).w }) : null;   // dark hides the <img>: the picture's CSS size is the cut's
    if (r) {
      window.__launcherGlass = { alpha: r.alpha, ratio: r.ratio, engaged: r.engaged };
      if (r.engaged) panelEl.style.setProperty('--pane-tint', r.tint);
      adaptSaid = '';
      return;
    }
    var why = GA ? 'the picture behind the launcher could not be read back' : 'ui/shared/glass-adapt.js did not load';
    if (adaptSaid !== why) { adaptSaid = why; console.warn('[launcher] dark glass at the token tint: ' + why); }
  }
  if (els.backdrop) els.backdrop.addEventListener('load', adaptBackdrop);
  window.addEventListener('mantle-theme', adaptBackdrop);

  /* DARK ONLY: THE PICTURE LINED UP AND BAKED (lane mantle-seethru-popups, 2026-10-10; Owen: "this needs
     to be see through the same as everything else"). Main cuts the wallpaper to the WINDOW's rectangle
     (main.js launcherBackdrop, wall: true), but the <img> stretched it over the panel plus 14px a side
     while the panel sits 10px inside the window: 1.2% too big, up to 3.8 DIP off at the edges (max 10.6
     levels from the still at .83, the HUDs and the switcher 1.5-2.7), and blurred by a CSS filter at paint
     time. In dark the picture is drawn ONCE onto a canvas with the --lg-blur token (scaled to canvas px,
     the edges clamped out first so the blur never pulls transparency in) exactly where main cut it: the
     window's rectangle, in the panel's coordinates. The switcher's and wall-bdrop.js's method. Light keeps
     the <img> and never builds the canvas. window.__launcherWall is a read-only view. */
  var bcan = null, lastRect = null;
  /* the picture's rectangle in window CSS px: main's `at` (fractions of `win`, the bar's convention) when it
     sends one; else its physical `rect`, which is the whole window unless the display's edge clipped it */
  function windowCut(s) {
    var W = window.innerWidth, H = window.innerHeight, d = window.devicePixelRatio || 1;
    if (s && s.at && s.at.w > 0 && s.at.h > 0) {
      var ww = s.win && s.win.w > 0 ? s.win.w : W, wh = s.win && s.win.h > 0 ? s.win.h : H;
      return { x: s.at.x * ww, y: s.at.y * wh, w: s.at.w * ww, h: s.at.h * wh };
    }
    var rect = s && s.rect;
    if (!rect || !(rect.w > 0) || !(rect.h > 0)) return { x: 0, y: 0, w: W, h: H };
    if (Math.abs(rect.w - W * d) <= 2 && Math.abs(rect.h - H * d) <= 2) return { x: 0, y: 0, w: W, h: H };
    return { x: rect.x / d - window.screenX, y: rect.y / d - window.screenY, w: rect.w / d, h: rect.h / d };
  }
  function paintDark() {
    var img = els.backdrop;
    if (document.documentElement.getAttribute('data-theme') !== 'dark') { dropDark(); return; }
    if (!haveBackdrop || !img || !img.naturalWidth || !els.bdrop) return;
    try {
      var at = windowCut(lastRect);
      var iw = img.naturalWidth, ih = img.naturalHeight, k = iw / at.w, px = 0;
      var tok = getComputedStyle(document.documentElement).getPropertyValue('--lg-blur').trim();
      var f = tok && tok !== 'none' ? tok.replace(/blur\(\s*([\d.]+)px\s*\)/, function (_m, n) { px = parseFloat(n) * k; return 'blur(' + px.toFixed(2) + 'px)'; }) : 'none';
      var m = Math.ceil(px * 3);
      var src = document.createElement('canvas');
      src.width = iw + 2 * m; src.height = ih + 2 * m;
      var g = src.getContext('2d');
      g.drawImage(img, m, m);
      if (m) {                                   // the edge pixels stretched out into the margin
        g.drawImage(img, 0, 0, iw, 1, m, 0, iw, m);
        g.drawImage(img, 0, ih - 1, iw, 1, m, m + ih, iw, m);
        g.drawImage(img, 0, 0, 1, ih, 0, m, m, ih);
        g.drawImage(img, iw - 1, 0, 1, ih, m + iw, m, m, ih);
        g.drawImage(img, 0, 0, 1, 1, 0, 0, m, m);
        g.drawImage(img, iw - 1, 0, 1, 1, m + iw, 0, m, m);
        g.drawImage(img, 0, ih - 1, 1, 1, 0, m + ih, m, m);
        g.drawImage(img, iw - 1, ih - 1, 1, 1, m + iw, m + ih, m, m);
      }
      if (!bcan) { bcan = document.createElement('canvas'); bcan.className = 'bdrop-pic'; els.bdrop.appendChild(bcan); }
      bcan.width = iw; bcan.height = ih;
      var o = bcan.getContext('2d');
      o.filter = f; o.drawImage(src, -m, -m); o.filter = 'none';
      src.width = 0; src.height = 0;
      // the .bdrop's place in the window, untransformed (the panel scales a little while it opens)
      var x = 0, y = 0;
      for (var e = els.bdrop; e; e = e.offsetParent) { x += e.offsetLeft + (e !== els.bdrop ? e.clientLeft : 0); y += e.offsetTop + (e !== els.bdrop ? e.clientTop : 0); }
      bcan.style.left = (at.x - x) + 'px'; bcan.style.top = (at.y - y) + 'px';
      bcan.style.width = at.w + 'px'; bcan.style.height = at.h + 'px';
      window.__launcherWall = { at: at, offset: { x: at.x - x, y: at.y - y }, blur: f, bakes: (window.__launcherWall ? window.__launcherWall.bakes : 0) + 1 };
    } catch (err) {
      clearBackdrop();
      // The picture DID arrive, so the default "could not picture the screen" would be untrue here.
      noBlur('the picture behind the launcher could not be blurred: ' + (window.MantlePlain ? window.MantlePlain.forLog(err) : String((err && err.message) || err)),
        'The see-through effect is off: the picture behind this window could not be blurred.');
    }
  }
  function dropDark() {
    if (bcan) { bcan.width = 0; bcan.height = 0; }
    window.__launcherWall = null;
  }
  if (els.backdrop) els.backdrop.addEventListener('load', paintDark);
  window.addEventListener('mantle-theme', paintDark);

  function clearBackdrop() {
    if (!els.bdrop || !els.backdrop) return;     // already reported by bdropNodes()
    haveBackdrop = false;
    dropDark();
    els.bdrop.classList.remove('on');
    /* removeAttribute, never src='': an empty src re-requests the PAGE in some engines. With no
       src at all the <img> draws nothing, which is what a hidden launcher should hold. */
    els.backdrop.removeAttribute('src');
    document.body.classList.add('no-backdrop');
  }

  function noBlur(reason, words) {
    var text = 'no blur: ' + (reason || 'no reason given');
    if (backdropNote === text) return;
    backdropNote = text;
    backdropWords = words || '';
    if (!backdropLogged[text]) { backdropLogged[text] = 1; console.warn('launcher: ' + text); }
    renderFooter();
  }

  /* ---- the bridge must exist -------------------------------------------- */
  if (!mantle || typeof mantle.call !== 'function') {
    els.results.textContent = '';
    var dead = document.createElement('div');
    dead.className = 'empty is-bad';
    dead.textContent = 'The launcher could not connect to Mantle, so nothing can be searched or opened. Restarting Mantle usually fixes this.';
    // the plumbing, for whoever debugs it: window.mantle was never injected (no preload script)
    dead.title = 'window.mantle is missing: the launcher window was created without its preload script';
    els.results.appendChild(dead);
    els.counts.textContent = 'Not connected';
    return;
  }

  /* ---- glyphs for the rows with no bitmap -------------------------------
     Drawn inline rather than pulled from Segoe Fluent Icons: the icon font is
     not guaranteed on every build, and a missing glyph box in the icon column
     is exactly the kind of quiet breakage this project does not allow. */
  var GLYPH = {
    command: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" ' +
      'stroke-linecap="round" stroke-linejoin="round"><path d="M3 4l3.2 3.2L3 10.4"/><path d="M8.4 11.4H13"/></svg>',
    setting: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" ' +
      'stroke-linecap="round"><path d="M2 4.5h12M2 11.5h12"/><circle cx="6" cy="4.5" r="1.9" fill="currentColor" stroke="none"/>' +
      '<circle cx="10.5" cy="11.5" r="1.9" fill="currentColor" stroke="none"/></svg>',
    url: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" ' +
      'stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6"/><path d="M2 8h12"/>' +
      '<path d="M8 2c1.9 2 2.9 4 2.9 6S9.9 12 8 14C6.1 12 5.1 10 5.1 8S6.1 4 8 2z"/></svg>',
    // power and session rows carry item.glyph, one per action, so Lock never looks like Shut down
    lock: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" ' +
      'stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="7" width="9" height="6.5" rx="1.5"/>' +
      '<path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/></svg>',
    sleep: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" ' +
      'stroke-linecap="round" stroke-linejoin="round"><path d="M13 9.6A5.5 5.5 0 1 1 6.4 3a4.4 4.4 0 0 0 6.6 6.6z"/></svg>',
    hibernate: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" ' +
      'stroke-linecap="round" stroke-linejoin="round"><path d="M12.5 9.8A5 5 0 1 1 6.2 3.5a4 4 0 0 0 6.3 6.3z"/>' +
      '<path d="M3 14.5h10"/></svg>',
    restart: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" ' +
      'stroke-linecap="round" stroke-linejoin="round"><path d="M13 8a5 5 0 1 1-1.6-3.7"/><path d="M11.8 1.8v2.8H9"/></svg>',
    power: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" ' +
      'stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v5.5"/><path d="M4.6 4.2a5 5 0 1 0 6.8 0"/></svg>',
    signout: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" ' +
      'stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 2.5H4a1.5 1.5 0 0 0-1.5 1.5v8A1.5 1.5 0 0 0 4 13.5h2.5"/>' +
      '<path d="M10 5l3 3-3 3"/><path d="M13 8H6.5"/></svg>',
    calc: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" ' +
      'stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="1.8" width="10" height="12.4" rx="1.6"/>' +
      '<path d="M5.5 4.8h5"/><path d="M5.6 8.2h.01M8 8.2h.01M10.4 8.2h.01M5.6 11h.01M8 11h.01M10.4 11h.01"/></svg>',
    web: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" ' +
      'stroke-linecap="round" stroke-linejoin="round"><circle cx="7" cy="7" r="4.6"/><path d="M10.4 10.4L14 14"/></svg>',
    file: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" ' +
      'stroke-linecap="round" stroke-linejoin="round"><path d="M9 1.8H4.5A1.5 1.5 0 0 0 3 3.3v9.4a1.5 1.5 0 0 0 1.5 1.5h7a1.5 1.5 0 0 0 1.5-1.5V5.8z"/>' +
      '<path d="M9 1.8v4h4"/></svg>',
    folder: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" ' +
      'stroke-linecap="round" stroke-linejoin="round"><path d="M1.8 4.3A1.3 1.3 0 0 1 3.1 3h3l1.5 1.7h5.3a1.3 1.3 0 0 1 1.3 1.3v5.7A1.3 1.3 0 0 1 12.9 13H3.1a1.3 1.3 0 0 1-1.3-1.3z"/></svg>',
  };

  function iconCell(item) {
    var cell = document.createElement('div');
    cell.className = 'ico';
    if (item.icon) {
      var img = document.createElement('img');
      img.src = item.icon;
      img.alt = '';
      // a data URL that does not decode must not leave an empty square
      img.addEventListener('error', function () {
        cell.textContent = (item.name || '?').trim().charAt(0) || '?';
        cell.classList.add('is-letter');
      });
      cell.appendChild(img);
      return cell;
    }
    var glyph = GLYPH[item.glyph] || GLYPH[item.kind];
    if (glyph) {
      cell.innerHTML = glyph;                     // a constant string, never user text
      return cell;
    }
    cell.classList.add('is-letter');
    cell.textContent = (item.name || '?').trim().charAt(0) || '?';
    return cell;
  }

  /* ---- rendering --------------------------------------------------------- */

  function render() {
    els.results.textContent = '';

    renderHint();
    var n = rows.length;
    var count = !answered ? 'Loading' : n ? n + (n === 1 ? ' result' : ' results') : 'No results';
    if (els.counts.textContent !== count) els.counts.textContent = count;

    var typed = els.q.value.trim();
    if (!rows.length) {
      var blank = document.createElement('div');
      blank.className = 'empty' + (answered ? '' : ' is-loading');
      blank.setAttribute('role', 'status');
      blank.textContent = mode === 'run' ? 'Type the name of a program, folder, document or website, and Windows opens it.'
        : !answered ? 'Getting your apps ready…'
        : !typed ? (mode === 'search' ? 'Type to search apps, files, settings and the web.' : 'No apps to show yet. Type to search files, settings and the web.')
        : filePending ? 'Nothing matches ‘' + typed + '’ yet. Searching your files…'
        : 'Nothing matches ‘' + typed + '’';
      els.results.appendChild(blank);
      return;
    }
    /* NO MATCH IS NOT A DEAD END: when the web row is all there is, say so above it, so Enter's
       "Search the web" reads as the way on rather than as a strange first result. */
    if (typed && rows.every(function (r) { return r.kind === 'web'; })) {
      var none = document.createElement('div');
      none.className = 'empty is-none';
      none.setAttribute('role', 'status');
      none.textContent = 'No apps, settings or commands match ‘' + typed + '’.';
      els.results.appendChild(none);
    }

    var at = 0;
    for (var g = 0; g < view.groups.length; g++) {
      var grp = view.groups[g];
      var head = document.createElement('div');
      head.className = 'grp';
      head.setAttribute('role', 'presentation');
      head.textContent = grp.label;
      els.results.appendChild(head);
      for (var r = 0; r < grp.rows.length; r++, at++) els.results.appendChild(rowEl(grp.rows[r], at));
      if (grp.status) {
        // what the Files group is doing, or why it has nothing: never a selectable row
        var st = document.createElement('div');
        st.className = 'grp-status is-' + grp.status.kind;
        st.setAttribute('role', 'status');
        st.textContent = plain(grp.status.text);
        if (st.textContent !== grp.status.text) st.title = grp.status.text;
        els.results.appendChild(st);
      }
    }

    /* A name or subtitle cut short by the ellipsis gets its whole text one hover away (one layout
       read for the dozen rows; a file row already carries its full path). */
    var cells = els.results.querySelectorAll('.row:not([title]) .name, .row:not([title]) .sub');
    for (var c = 0; c < cells.length; c++) {
      if (cells[c].scrollWidth > cells[c].clientWidth + 1) {
        var rowOf = cells[c].closest('.row');
        var it = rows[Number(rowOf.dataset.i)];
        if (it) rowOf.title = (it.name || '') + (it.subtitle ? ' · ' + it.subtitle : '');
      }
    }

    var selEl = els.results.querySelector('.row.is-sel');
    if (selEl && selEl.scrollIntoView) {
      // the first row of a group brings its header into view with it
      var prev = selEl.previousElementSibling;
      if (prev && prev.classList.contains('grp') && prev.scrollIntoView) prev.scrollIntoView({ block: 'nearest' });
      selEl.scrollIntoView({ block: 'nearest' });
    }
  }

  function rowEl(item, i) {
    {
      var isArmed = !!(armed && armed.id === item.id);
      var row = document.createElement('div');
      row.className = 'row' + (i === sel ? ' is-sel' : '') + (isArmed ? ' is-armed' : '') +
        (item.kind === 'calc' ? ' is-calc' : '') + (item.bad ? ' is-bad' : '');
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', i === sel ? 'true' : 'false');
      row.dataset.i = String(i);
      row.dataset.kind = item.kind || '';      // for the --test self-check (lib/features/_search-selftest.js)
      // a file row's subtitle is its folder, cut short; the whole path is one hover away
      if (item.kind === 'file') row.title = item.path || '';

      var main = document.createElement('div');
      main.className = 'row-main';
      main.appendChild(iconCell(item));

      var name = document.createElement('div');
      name.className = 'name';
      // armed: the row itself says what the next Enter does, in the place the eye already is
      name.textContent = isArmed ? item.confirm : (item.name || '(unnamed)');
      if (!isArmed && item.parts && item.parts.letter) {
        // Quick links: Windows' underlined access letter
        name.textContent = item.parts.before;
        var u = document.createElement('u');
        u.className = 'ak';
        u.textContent = item.parts.letter;
        name.appendChild(u);
        name.appendChild(document.createTextNode(item.parts.after));
      }
      main.appendChild(name);

      var sub = document.createElement('div');
      sub.className = 'sub';
      sub.textContent = isArmed ? 'Esc cancels' : (item.subtitle || '');
      main.appendChild(sub);

      if (isArmed) {
        /* the time left, as a hairline that runs out: a CSS animation over ARM_MS, started when
           this node is created, so nothing ticks in script while the row waits */
        var bar = document.createElement('div');
        bar.className = 'arm-bar';
        bar.style.animationDuration = ARM_MS + 'ms';
        bar.style.animationDelay = -(Date.now() - armed.at) + 'ms';
        main.appendChild(bar);
      }

      row.appendChild(main);

      // the reason a launch did not happen sits under the row it belongs to
      if (note && note.id === item.id) {
        var why = document.createElement('div');
        why.className = 'why' + (note.ok ? ' is-ok' : '');
        why.textContent = plain(note.text);
        if (why.textContent !== note.text) why.title = note.text;
        row.appendChild(why);
      }
      return row;
    }
  }

  /* One place builds this strip, because three things write to it: the per-source reasons, the
     index call's own failure, and the backdrop. Anything that appends to #srcErrors by hand gets
     wiped by the next render, which is how a reason quietly disappears. */
  /* PLAIN WORDS (lane launch-ui, 2026-09-29). Reasons come from main, the index and Windows, and
     some carry the plumbing: "sidecar", "spawn ENOENT", "(EPERM)", "0x80070005". Everything this
     page prints goes through here first; the untouched text stays one hover away (title) for
     whoever is debugging. */
  function plain(text) {
    var t = String(text == null ? '' : text);
    t = t.replace(/\bthe running sidecar\b/gi, 'Mantle\'s helper').replace(/\bthe sidecar\b/gi, 'Mantle\'s helper')
      .replace(/\bsidecar\b/gi, 'Mantle\'s helper');
    t = t.replace(/\s*\((?:E[A-Z]{3,}|0x[0-9a-fA-F]{8}|code -?\d+)\)/g, '')
      .replace(/\b(?:spawn\s+)?E(?:NOENT|ACCES|PERM|BUSY|EXIST|NOTDIR|ISDIR)\b:?\s*/g, '')
      .replace(/\s*\b0x[0-9a-fA-F]{8}\b/g, '')
      .replace(/\s{2,}/g, ' ').trim();
    // a sentence starts with a capital; a file name does not get one ("wt.exe not found", not "Wt.exe")
    return t && !/^\S*[.\\/:]\S/.test(t) ? t.charAt(0).toUpperCase() + t.slice(1) : t;
  }

  /* What a broken source means to someone searching, not which module said it. */
  var SOURCE_WORDS = {
    apps: 'Your apps could not be listed, so only settings, files and the web can be searched.',
    commands: 'Your PowerShell commands could not be read.',
    settings: 'Settings pages could not be listed.',
    power: 'Lock, Sleep and the other power options could not be listed.',
  };

  /* One place builds this strip, because three things write to it: the per-source problems, the
     index call's own failure, and the backdrop. The FOOTER ITSELF says only what is wrong and what
     keys do (renderHint); the old "apps 87 · commands 22 · settings 154 · power 6" counts were
     status nobody acts on, so they are now a screen-reader line (#counts, "12 results"). */
  function renderFooter() {
    var lines = [];
    for (var i = 0; i < sources.length; i++) {
      var s = sources[i] || {};
      if (s.status && s.status !== 'ok') {
        lines.push({ text: SOURCE_WORDS[s.name] || 'Part of the search is unavailable right now.', detail: (s.name || '?') + ': ' + (s.reason || 'no reason given') });
      }
    }
    if (indexError) lines.unshift({ text: 'Your apps and settings could not be loaded. Files and the web can still be searched; close and reopen the launcher to try again.', detail: indexError });
    if (backdropNote) lines.push({ text: backdropWords || 'The see-through effect is off: Mantle could not picture the screen behind this window.', detail: backdropNote });
    if (mode === 'run' && runFooter) lines.push({ text: runFooter, detail: runFooter });

    els.srcErrors.textContent = '';
    for (var j = 0; j < lines.length; j++) {
      var div = document.createElement('div');
      div.className = 'src-error';
      div.textContent = lines[j].text;
      div.title = lines[j].detail || '';
      els.srcErrors.appendChild(div);
    }
  }

  /* WHAT THE KEYS DO, as keycaps in the footer: Enter's verb for the selected row, the second
     action where there is one, Tab when there are groups to jump, Esc. The row decides the words,
     so the key that does it is never a secret. */
  var ENTER_VERB = { app: 'Open', command: 'Run', setting: 'Open', url: 'Open', file: 'Open', web: 'Search the web' };
  var hintKey = '';
  function renderHint() {
    if (!els.hint) return;
    var item = rows[sel];
    var keys = [];
    if (armed && item && armed.id === item.id) keys = [['Enter', 'Confirm'], ['Esc', 'Cancel']];
    else if (mode === 'run') {
      if (item) keys = [['Enter', item.kind === 'path' ? 'Open' : 'Run'], ['Ctrl+Shift+Enter', 'As administrator']];
      if (item && item.kind !== 'runline') keys.push(['Tab', 'Complete']);
      keys.push(['Esc', 'Close']);
    } else if (mode === 'quick') {
      keys = [['Letter', 'Open'], ['Enter', 'Open'], ['Esc', quickSub ? 'Back' : 'Close']];
    } else {
      if (item) {
        if (item.kind === 'calc') { if (!item.bad) keys.push(['Enter', 'Copy answer']); }
        else if (item.kind === 'power') keys.push(['Enter', item.name]);
        else keys.push(['Enter', ENTER_VERB[item.kind] || 'Open']);
        if (item.kind === 'file') keys.push(['Ctrl+Enter', 'Show in folder']);
      }
      if (view.groups.length > 1) keys.push(['Tab', 'Next group']);
      keys.push(['Esc', 'Close']);
    }
    var key = JSON.stringify(keys);
    if (key === hintKey) return;
    hintKey = key;
    els.hint.textContent = '';
    for (var i = 0; i < keys.length; i++) {
      var span = document.createElement('span');
      span.className = 'k' + (keys[i][0] === 'Esc' && i === keys.length - 1 && keys.length > 1 ? ' k-end' : '');
      var kbd = document.createElement('kbd');
      kbd.textContent = keys[i][0];
      span.appendChild(kbd);
      span.appendChild(document.createTextNode(' ' + keys[i][1]));
      els.hint.appendChild(span);
    }
  }

  /* The shell's own health report, as far as the launcher is concerned.
     The sidecar does the Win32 work, including shortcut icons. When it is not
     ok the rows still work — they just have letter tiles — so this is a notice
     and not an error: one line, the reason included, always visible.
     backdrop.launcher {on, ok, ms, reason} is main's report about the picture behind this window.
     ONLY ok === false is worth a line: `on:false` with ok:true is main saying it is not capturing
     right now (the window is hidden), which is normal and not a fault. */
  function applyState(state) {
    var sc = state && state.sidecar;
    if (sc && sc.status && sc.status !== 'ok') {
      els.notice.hidden = false;
      /* the rows still work without it - they just wear letter tiles - so this is a notice, not an error */
      els.notice.textContent = sc.status === 'starting' ? 'Mantle is still starting: app icons appear in a moment.'
        : 'App icons are unavailable because Mantle\'s helper stopped; it restarts by itself. Apps still open.';
      els.notice.title = sc.reason || sc.status;
    } else {
      els.notice.hidden = true;
      els.notice.textContent = '';
    }

    var bd = state && state.backdrop && state.backdrop.launcher;
    if (bd && bd.ok === false) {
      noBlur(bd.reason || 'main reported the launcher backdrop is not ok and gave no reason');
    } else if (bd && bd.ok === true && backdropNote) {
      backdropNote = '';
      renderFooter();
    }
  }

  /* ---- talking to main --------------------------------------------------- */

  function showProblem(text) {
    rows = [];
    note = null;
    els.results.textContent = '';
    var bad = document.createElement('div');
    bad.className = 'empty is-bad';
    bad.textContent = plain(text);
    els.results.appendChild(bad);
  }

  /* Resolves true when the index is not the one the last call described (an app came or went). */
  function refreshIndex(force) {
    return mantle.call('apps.index', { refresh: !!force }).then(function (res) {
      sources = (res && res.sources) || [];
      indexError = '';
      renderFooter();
      var sig = sources.map(function (s) { return (s && s.name) + ':' + (s && s.count); }).join(',');
      var changed = !!indexSig && sig !== indexSig;
      indexSig = sig;
      return changed;
    }, function (err) {
      sources = [];
      indexError = reasonOf(err);
      renderFooter();
      return false;
    });
  }

  /* The background rebuild on open (see REFRESH_MS). After the first rows are up, so it never
     delays them; the search runs again only when the answer differs and the launcher is still up. */
  function freshenSoon() {
    if (Date.now() - lastRefresh < REFRESH_MS) return;
    lastRefresh = Date.now();
    setTimeout(function () {
      refreshIndex(true).then(function (changed) {
        if (changed && document.visibilityState !== 'hidden') runSearch();
      });
    }, 250);
  }

  function reasonOf(err) {
    if (!err) return 'no reason given';
    if (typeof err === 'string') return err;
    return String(err.message || err);
  }

  var searchTimer = null;
  function queueSearch() {
    // 12ms (was 40): Win+S asked for apps/settings/calc on screen in ~50 ms, and MEASURED in a
    // --test Mantle on 2026-09-24 the 40ms debounce put input -> row at 48-77 ms, while the
    // search itself is ~0.3 ms (lib/launcher-search.test.js) plus one IPC hop. 12ms still folds
    // a burst of keys (auto-repeat, a paste) into one call.
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(runSearch, 12);
  }

  function runSearch() {
    var mine = ++searchSeq;
    var q = els.q.value;
    mantle.call('apps.search', { q: q }).then(function (res) {
      if (mine !== searchSeq) return;              // a newer query already answered
      answered = true;
      appRows = Array.isArray(res) ? res : (res && res.items) || [];
      /* a re-search of the SAME text (the background refresh) keeps a hand-moved selection */
      if (q !== lastSearched) { userMoved = false; note = null; }
      lastSearched = q;
      mergeRows();
    }, function (err) {
      if (mine !== searchSeq) return;
      answered = true;
      // preload.js's own sentence for a call that never reached Mantle is whole: said after a colon, not in brackets
      var why = reasonOf(err);
      showProblem(/^Mantle did not answer\./.test(why)
        ? 'The search did not run: Mantle did not answer. Type again to retry; if it keeps happening, restart Mantle.'
        : 'The search did not answer (' + why + '). Type again to retry; files and the web may still work.');
    });
  }

  /* ---- file rows ----------------------------------------------------------- */

  /* A file query only for something that could be a file name: two letters or more, and NOT
     arithmetic - "2*(3+4)" wants its answer, and a "No files match" under it is noise (and a
     query with % in it is the one LIKE cannot run, see sidecar/SearchIndex.cs). */
  function wantsFiles(q) {
    if (q.length < FILE_MIN) return false;
    try { if (Calc && Calc.evaluate(q)) return false; } catch (e) { /* the calc row reports its own failure */ }
    return true;
  }

  function queueFiles() {
    if (fileTimer) clearTimeout(fileTimer);
    filePending = wantsFiles(els.q.value.trim());
    fileTimer = setTimeout(runFiles, FILE_DEBOUNCE_MS);
  }

  function runFiles() {
    fileTimer = null;
    var q = els.q.value.trim();
    var mine = ++fileSeq;
    if (!wantsFiles(q)) {
      filePending = false;
      fileRows = []; fileQ = '';
      fileState = { status: 'idle', reason: '', ms: 0, n: 0 };
      renderFooter();
      mergeRows();
      return;
    }
    // fileState keeps the LAST answer's line in the footer until this one lands: a count that
    // blinks out on every keystroke would be noise, not news
    callPreferring('search.files', 'launcher.files', { q: q }).then(function (res) {
      if (mine !== fileSeq) return;                // a newer query is on its way
      filePending = false;
      if (res && res.superseded) { mergeRows(); return; }   // nothing newer is coming from us: no rows
      if (res && res.ok) {
        fileRows = Array.isArray(res.items) ? res.items : [];
        fileQ = q.toLowerCase();
        fileState = { status: 'ok', reason: res.reason || '', ms: res.ms || 0, n: fileRows.length };
      } else {
        fileRows = []; fileQ = '';
        fileState = { status: 'error', reason: (res && res.reason) || 'the file search failed and gave no reason', ms: 0, n: 0 };
      }
      renderFooter();
      mergeRows();
    }, function (err) {
      if (mine !== fileSeq) return;
      filePending = false;
      fileRows = []; fileQ = '';
      fileState = { status: 'error', reason: 'the file search request failed: ' + reasonOf(err), ms: 0, n: 0 };
      renderFooter();
      mergeRows();
    });
  }

  /* While the next answer is on its way, the last one's rows stay if their names still match
     what is typed now: typing "repo" after "rep" narrows the list instead of blanking it for
     the 150 ms debounce plus the query. */
  function stillMatches(name, q) {
    var n = String(name || '').toLowerCase();
    if (n.indexOf(q) === 0) return true;
    var words = n.split(/[^a-z0-9]+/);
    var terms = q.split(/[^a-z0-9]+/).filter(Boolean);
    if (!terms.length) return false;
    return terms.every(function (t) { return words.some(function (w) { return w.indexOf(t) === 0; }); });
  }

  /* appRows + fileRows + the calculator -> view (groups.js) -> rows, the flat on-screen order.
     A file row from the last answer stays while its name still matches what is typed (typing
     "repo" after "rep" narrows the list instead of blanking it). The selection follows its ROW
     when the person has moved it by hand; otherwise it stays on the first row. */
  function mergeRows() {
    if (special()) return;                    // a late apps/files answer never replaces Run or Quick links rows
    var typed = els.q.value;
    var q = typed.trim().toLowerCase();
    var keepId = userMoved && rows[sel] ? rows[sel].id : null;
    var files = q.length >= FILE_MIN
      ? fileRows.filter(function (f) { return fileQ === q || stillMatches(f.name, q); })
      : [];
    var calc = null;
    try { calc = Calc ? Calc.evaluate(typed) : null; } catch (e) { calc = { ok: false, expr: typed.trim(), reason: 'the calculator failed: ' + reasonOf(e) }; }
    if (!Groups) {
      showProblem('The launcher is missing part of itself (groups.js), so results cannot be shown. Reinstalling Mantle fixes this.');
      return;
    }
    view = Groups.build({ q: typed, appRows: appRows, fileRows: files, fileState: fileState, filePending: filePending, calc: calc });
    rows = view.flat;
    sel = 0;
    if (keepId) {
      for (var i = 0; i < rows.length; i++) if (rows[i].id === keepId) { sel = i; break; }
    }
    if (armed && !rows.some(function (r) { return r.id === armed.id; })) disarm();
    render();
  }

  /* A Win+S feature command when this Mantle has it (lib/features/search.js), otherwise main's
     original one. ONLY "there is no such command" falls back: any other failure is the answer. */
  function callPreferring(name, fallback, args) {
    return mantle.call(name, args).then(null, function (err) {
      if (/no command called|no "/.test(reasonOf(err))) return mantle.call(fallback, args);
      throw err;
    });
  }

  /* ---- ask first ------------------------------------------------------------ */

  function arm(item) {
    disarm();
    armed = { id: item.id, at: Date.now(), timer: setTimeout(function () { disarm(); render(); }, ARM_MS) };
    render();
  }

  function disarm() {
    if (!armed) return false;
    clearTimeout(armed.timer);
    armed = null;
    return true;
  }

  function move(delta) {
    if (!rows.length) return;
    sel = (sel + delta + rows.length) % rows.length;   // wraps: 12 rows, one hand
    userMoved = true;
    if (armed && rows[sel].id !== armed.id) disarm();
    render();
  }

  function select(i) {
    if (i === sel || i < 0 || i >= rows.length) return;
    sel = i;
    userMoved = true;
    if (armed && rows[sel].id !== armed.id) disarm();
    render();
  }

  /* Sends one row action at most once per decision (see inFlight): not while the same row's same
     action is still on its way, and not again within FIRE_GAP_MS of sending it. */
  function once(item, action, send) {
    var key = item.id + '|' + action;
    var now = Date.now();
    if (inFlight === key) return;
    if (lastFire.key === key && now - lastFire.at < FIRE_GAP_MS) return;
    inFlight = key;
    lastFire = { key: key, at: now };
    var done = function () { if (inFlight === key) inFlight = null; };
    var p;
    try { p = send(); } catch (e) { done(); throw e; }
    Promise.resolve(p).then(done, done);
  }

  /* Power rows: the first Enter on one that asks first arms it; the second sends it. Lock and
     Sleep go straight through. A dry run (a --test Mantle, or MANTLE_POWER_DRYRUN=1) comes back
     ok with the command it WOULD have run, printed under the row, and the launcher stays up. */
  function activatePower(item) {
    if (item.confirm) {
      if (!armed || armed.id !== item.id) { arm(item); return; }
      if (Date.now() - armed.at < ARM_MIN_MS) return;   // a double-click is not two decisions
    }
    var confirmed = !!(item.confirm && armed && armed.id === item.id);
    disarm();
    once(item, 'power', function () { return mantle.call('launcher.power', { action: item.path, confirmed: confirmed }).then(function (res) {
      if (res && res.ok) {
        if (res.dryRun || res.reason) { note = { id: item.id, text: res.reason, ok: true }; render(); }
        if (!res.dryRun) clearNext = true;        // done with it: the next open starts clean
        return;                                   // for real: main has already hidden the launcher
      }
      note = { id: item.id, text: (res && res.reason) || item.name + ' did not happen, and no reason came back', ok: false };
      render();
    }, function (err) {
      note = { id: item.id, text: 'the ' + item.name + ' request failed: ' + reasonOf(err), ok: false };
      render();
    }); });
  }

  /* File rows: Enter opens it with its default app, Ctrl+Enter (or Ctrl+click) shows it selected
     in its folder. */
  function activateFile(item, reveal) {
    once(item, reveal ? 'reveal' : 'open', function () { return callPreferring('search.openFile', 'launcher.openFile', { path: item.path, reveal: !!reveal }).then(function (res) {
      if (res && res.ok) {
        if (res.dryRun) { note = { id: item.id, text: res.reason, ok: true }; render(); return; }
        // launcher.openFile hides the window itself; search.openFile (a feature) cannot, so ask.
        // A second hide of a hidden launcher is a no-op in main.
        hideAfterAction();
        return;
      }
      note = { id: item.id, text: (res && res.reason) || 'it did not open, and no reason came back', ok: false };
      render();
    }, function (err) {
      note = { id: item.id, text: 'the open request failed: ' + reasonOf(err), ok: false };
      render();
    }); });
  }

  /* The calculator row: Enter copies the answer. Main works it out again from the expression and
     copies only that number (lib/launcher-index.js copyCalc); a --test Mantle only says what it
     would copy. A row with no answer says so and copies nothing. */
  function activateCalc(item) {
    if (item.bad) { note = { id: item.id, text: 'there is no answer to copy: ' + item.name, ok: false }; render(); return; }
    once(item, 'copy', function () { return mantle.call('search.copy', { expr: item.expr }).then(function (res) {
      if (res && res.ok) {
        note = { id: item.id, text: res.dryRun ? res.reason : 'Copied ' + (res.copied || item.copy), ok: true };
        render();
        if (!res.dryRun) hideTimer = setTimeout(function () { hideAfterAction(); }, 700);
        return;
      }
      note = { id: item.id, text: (res && res.reason) || 'nothing was copied, and no reason came back', ok: false };
      render();
    }, function (err) {
      note = { id: item.id, text: 'the copy request failed: ' + reasonOf(err), ok: false };
      render();
    }); });
  }

  /* "Search the web for …": main builds the URL from the text and opens it the way a typed URL
     opens (lib/launcher-index.js openWeb). A dry run stays open and says what it would have done. */
  function activateWeb(item) {
    // what is typed NOW, not the row's copy of it: the row is rebuilt only when apps.search answers,
    // so an End+Enter inside that gap would search the previous text (caught by the selftest)
    var typed = els.q.value.trim() || item.path;
    once(item, 'web', function () { return mantle.call('search.web', { q: typed }).then(function (res) {
      if (res && res.ok) {
        if (res.dryRun || res.reason) { note = { id: item.id, text: res.reason, ok: true }; render(); }
        if (!res.dryRun) hideTimer = setTimeout(function () { hideAfterAction(); }, res.reason ? 1400 : 0);
        return;
      }
      note = { id: item.id, text: (res && res.reason) || 'the search did not open, and no reason came back', ok: false };
      render();
    }, function (err) {
      note = { id: item.id, text: 'the web search request failed: ' + reasonOf(err), ok: false };
      render();
    }); });
  }

  function activate(alt) {
    var item = rows[sel];
    if (!item) return;
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    if (item.kind === 'runline' || item.kind === 'hist' || item.kind === 'path') { activateRun(item, false); return; }
    if (item.kind === 'quick') { activateQuick(item); return; }
    if (item.kind === 'power') { activatePower(item); return; }
    if (item.kind === 'file') { activateFile(item, alt); return; }
    if (item.kind === 'calc') { activateCalc(item); return; }
    if (item.kind === 'web') { activateWeb(item); return; }

    once(item, 'open', function () { return mantle.call('apps.launch', { id: item.id }).then(function (res) {
      if (res && res.ok) {
        if (res.reason) {
          /* It opened, but not the way you asked (a plain PowerShell window
             because wt.exe is missing, say). Show the difference for a beat
             before the window goes, so the surprise is explained. */
          note = { id: item.id, text: res.reason, ok: true };
          render();
          hideTimer = setTimeout(function () { hideAfterAction(); }, 1400);
        } else {
          hideAfterAction();
        }
        return;
      }
      // it did not open: stay open and say why, under the row
      note = { id: item.id, text: (res && res.reason) || 'it did not open, and no reason came back', ok: false };
      render();
    }, function (err) {
      note = { id: item.id, text: 'the launch request failed: ' + reasonOf(err), ok: false };
      render();
    }); });
  }

  /* ---- input ------------------------------------------------------------- */

  els.q.addEventListener('input', function () {
    clearNext = false;
    disarm();                                     // typing is changing your mind
    if (special()) { if (mode === 'run') { note = null; userMoved = false; queueRun(); } return; }
    queueSearch();
    queueFiles();
  });
  // the focused underline is CSS (.slot:focus-within), not a class toggled here

  document.addEventListener('keydown', function (e) {
    if (special() && specialKey(e)) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      // the first Esc takes back an armed Shut down; only the next one closes the launcher
      if (disarm()) { render(); return; }
      mantle.call('launcher.hide');
      return;
    }
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); return; }
    if (e.key === 'Enter') {
      e.preventDefault();
      // a HELD Enter repeats: it would start the app again and again (and arm + confirm a power row)
      if (e.repeat) return;
      activate(e.ctrlKey);
      return;
    }
    if (e.key === 'Tab' && rows.length && Groups) {
      e.preventDefault();
      select(Groups.jumpGroup(view.groups, sel, e.shiftKey ? -1 : 1));
      return;
    }
    if ((e.key === 'PageDown' || e.key === 'PageUp') && rows.length) {
      // a page of rows (44 px each, less one so the row you were on stays in sight); never wraps
      e.preventDefault();
      var per = Math.max(1, Math.floor(els.results.clientHeight / 45) - 1);
      select(Math.max(0, Math.min(rows.length - 1, sel + (e.key === 'PageDown' ? per : -per))));
      return;
    }
    if (e.key === 'Home' && rows.length) { e.preventDefault(); select(0); return; }
    if (e.key === 'End' && rows.length) { e.preventDefault(); select(rows.length - 1); return; }
    // any other key belongs to the input, wherever focus drifted to
    if (document.activeElement !== els.q && e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
      els.q.focus();
    }
  });

  function rowIndexFrom(target) {
    var el = target && target.closest ? target.closest('.row') : null;
    return el ? Number(el.dataset.i) : -1;
  }
  /* the typing box keeps the focus whatever is clicked: a click on the list used to take it, and
     then Backspace and the arrow keys stopped reaching the box */
  els.results.addEventListener('mousedown', function (e) { e.preventDefault(); });
  els.results.addEventListener('mousemove', function (e) {
    var i = rowIndexFrom(e.target);
    if (i >= 0) select(i);
  });
  els.results.addEventListener('click', function (e) {
    var i = rowIndexFrom(e.target);
    if (i < 0) return;
    select(i);
    activate(e.ctrlKey);
  });

  /* ---- events from main --------------------------------------------------- */

  if (typeof mantle.on === 'function') {
    mantle.on('launcher:visible', function (visible) {
      if (!visible) { if (shownNow) closedAt = Date.now(); shownNow = false; disarm(); panelDown(); keyboardNote(null); return; }
      shownNow = true;
      // shown: a clean slate, except what you typed if you closed it without acting a moment ago
      if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
      if (pendingOpen && Date.now() - pendingOpen.at > 2000) pendingOpen = null;
      // a Win tap after Run or Quick links opens the plain launcher: only a search's text is kept
      var kept = !pendingOpen && !clearNext && !special() && closedAt && Date.now() - closedAt < KEEP_MS ? els.q.value : '';
      clearNext = false;
      els.q.value = kept;
      applyMode(pendingOpen ? pendingOpen.mode : (kept ? mode : 'apps'));
      if (pendingOpen && pendingOpen.query) els.q.value = pendingOpen.query;
      pendingOpen = null;
      note = null;
      disarm();
      userMoved = false;
      lastSearched = null;
      inFlight = null;
      if (fileTimer) { clearTimeout(fileTimer); fileTimer = null; }
      fileSeq++;                  // an answer still on its way is for the last session's query
      filePending = false;
      fileRows = []; fileQ = '';
      fileState = { status: 'idle', reason: '', ms: 0, n: 0 };
      if (special()) {            // Win+R / Win+X: no index, search or file query on the way up
        renderFooter();
        openSpecial();
        els.q.focus();
        els.results.scrollTop = 0;
        panelUp();
        return;
      }
      /* AFTER the reset above (it used to run before it, and the reset cancelled it: Win+S with a
         query already typed never searched files for it) */
      if (els.q.value.trim().length >= FILE_MIN) queueFiles();
      renderFooter();
      refreshIndex(false);      // picks up icons that finished after the last open
      runSearch();
      freshenSoon();            // an app installed since the last rebuild shows up now
      els.q.focus();
      if (kept) els.q.select();     // typing replaces it; an arrow key keeps it
      els.results.scrollTop = 0;
      /* belt to visibilitychange's braces: this event is main saying the window IS on screen, and
         a panel that boots at opacity 0 may not depend on a single signal to become visible. */
      panelUp();
    });
    /* Win+S: main sends 'launcher.open' {mode, query} just BEFORE showLauncher(). From a closed
       launcher, the launcher:visible true that follows applies it (the reset above). Over an open
       one, main sends no new launcher:visible (only a hidden -> shown change does, so a repeat
       never wipes what you typed), and it is applied right here. A stale one (the show never
       came) is dropped after 2 s so it cannot leak into the next plain Win tap. */
    mantle.on('launcher.open', function (p) {
      pendingOpen = { mode: (p && p.mode) || 'apps', query: (p && p.query) || '', at: Date.now() };
      if (!shownNow) return;
      // Win+X over Quick links closes it, as Windows' Win+X menu does
      if (pendingOpen.mode === 'quick' && mode === 'quick') { pendingOpen = null; mantle.call('launcher.hide'); return; }
      // already up: main shows it again without a new launcher:visible, so the mode lands here
      applyMode(pendingOpen.mode);
      if (special()) {
        els.q.value = pendingOpen.query || '';
        pendingOpen = null;
        renderFooter();
        openSpecial();
        els.q.focus();
        return;
      }
      if (pendingOpen.query) { els.q.value = pendingOpen.query; queueFiles(); }
      pendingOpen = null;
      disarm();
      runSearch();
      els.q.focus();
    });
    /* main could not give this window the keyboard (lib/surface-gate.js): say so, in its words,
       until it has it (a click in it) or it closes. Never silent (audit #7). */
    mantle.on('launcher.keyboard', function (p) { keyboardNote(p && !p.ok ? (p.text || 'No keyboard: click here to type.') : null); });
    mantle.on('state', applyState);
    /* the picture behind this window: ~4 a second while it is up, one frame just before it is
       shown. setBackdrop swaps the <img> src and nothing else. */
    mantle.on('launcher.backdrop', setBackdrop);
  } else {
    // the bridge exists but cannot deliver events: say it rather than sit there
    els.notice.hidden = false;
    els.notice.textContent = 'live updates unavailable: this build of the bridge has no mantle.on(), ' +
      'so the launcher cannot tell when it is shown or when the sidecar changes.';
  }

  /** An action ran, so the launcher closes and the next open starts clean (Esc keeps the query). */
  function hideAfterAction() { clearNext = true; mantle.call('launcher.hide'); }

  function keyboardNote(text) {
    if (!els.kbd) return;
    els.kbd.hidden = !text;
    els.kbd.textContent = text || '';
  }

  function applyMode(m) {
    mode = m === 'search' || m === 'run' || m === 'quick' ? m : 'apps';
    document.body.dataset.mode = mode;
    els.q.placeholder = PLACEHOLDER[mode];
    els.q.readOnly = mode === 'quick';          // Quick links takes letters as keys, not text
    if (mode !== 'quick') quickSub = null;
  }

  /* ---- Run (Win+R) and Quick links (Win+X) (lane keysrun, 2026-10-15) ----------------------
     Two more modes of this same window, so neither adds a window or RAM, and nothing on the open
     path waits: the rows are drawn from what the page already has, then refreshed.
     RUN: the box takes what Windows' Run box takes. Main (lib/features/run.js + lib/run-line.js)
     parses and runs the line; the page only sends it. Row 0 is what you typed, then your history
     (Mantle's, then Windows' RunMRU) and the folder you are typing in. Enter runs the selected row,
     Ctrl+Shift+Enter as administrator (Windows' UAC prompt), Tab copies the row into the box.
     A failure the launcher was not up to see (the UAC prompt took the screen) brings it back with why.
     QUICK: Windows' Win+X rows and underlined letters (lib/quick-links.js); a letter runs its row,
     Shut down or sign out opens its submenu (Esc or Left goes back, the ask-first rows arm on the
     first press), and Win+X again closes it, as Windows' does. The page sends a row's id only. */
  var QL = window.MantleQuickLinks;
  var runHist = [];          // the last run.history answer, drawn at once on the next open
  var runPaths = [];         // folder completion for what is typed now
  var runSeq = 0;
  var runTimer = null;
  var runFooter = '';        // why the history could not be read, if it could not
  var reopen = null;         // { line, note }: a run failed after the launcher closed
  var quickSub = null;       // 'power' while the Shut down submenu is up
  var QUICK_GROUPS = { 1: 'Tools', 2: 'Open', 3: 'Power and desktop' };
  var POWER_GLYPH = { signout: 'signout', sleep: 'sleep', hibernate: 'hibernate', shutdown: 'power', restart: 'restart' };

  function special() { return mode === 'run' || mode === 'quick'; }

  function setView(groups) {
    var flat = [];
    for (var g = 0; g < groups.length; g++) flat = flat.concat(groups[g].rows);
    var keepId = userMoved && rows[sel] ? rows[sel].id : null;
    view = { groups: groups, flat: flat };
    rows = flat;
    sel = 0;
    if (keepId) for (var i = 0; i < rows.length; i++) if (rows[i].id === keepId) { sel = i; break; }
    if (armed && !rows.some(function (r) { return r.id === armed.id; })) disarm();
    answered = true;
    render();
  }

  function openSpecial() {
    disarm(); note = null; userMoved = false; runFooter = '';
    if (mode === 'quick') { quickSub = null; els.q.value = ''; quickRows(); return; }
    if (reopen) { els.q.value = reopen.line; runRows(); note = reopen.note; reopen = null; render(); return; }
    if (!els.q.value && runHist.length) els.q.value = runHist[0];   // the last line, selected, as Windows' Run box
    runPaths = [];
    runRows();
    els.q.select();
    mantle.call('run.history').then(function (res) {
      var first = !runHist.length;
      runHist = res && Array.isArray(res.items) ? res.items : [];
      if (mode !== 'run') return;
      if (first && !els.q.value && runHist.length) { els.q.value = runHist[0]; els.q.select(); }
      runRows();
    }, function (err) {
      runFooter = 'Your Run history could not be read, so only what you type can run. (' + reasonOf(err) + ')';
      renderFooter();
    });
  }

  function matchHist(t) {
    var q = t.toLowerCase();
    if (!q) return runHist.slice(0, 8);
    var starts = runHist.filter(function (h) { return h.toLowerCase().indexOf(q) === 0; });
    var has = runHist.filter(function (h) { return h.toLowerCase().indexOf(q) > 0; });
    return starts.concat(has).slice(0, 8);
  }

  function runRows() {
    var typed = els.q.value;
    var t = typed.trim();
    var seen = {};
    seen[t.toLowerCase()] = true;
    var groups = [];
    if (t) groups.push({ label: 'Run', rows: [{ kind: 'runline', id: 'run:line', name: t, line: t, subtitle: '' }] });
    var hist = matchHist(t).filter(function (h) { var k = h.toLowerCase(); if (seen[k]) return false; seen[k] = true; return true; })
      .map(function (h) { return { kind: 'hist', id: 'run:h:' + h.toLowerCase(), name: h, line: h, subtitle: '' }; });
    if (hist.length) groups.push({ label: 'Recent', rows: hist });
    var lowTyped = typed.toLowerCase();
    var paths = runPaths.filter(function (p) { var k = p.text.toLowerCase(); if (seen[k] || k.indexOf(lowTyped) !== 0) return false; seen[k] = true; return true; })
      .map(function (p) { return { kind: 'path', id: 'run:p:' + p.text.toLowerCase(), name: p.text, line: p.text, subtitle: p.dir ? 'Folder' : 'File' }; });
    if (paths.length) groups.push({ label: 'In this folder', rows: paths });
    setView(groups);
  }

  function queueRun() {
    if (runTimer) clearTimeout(runTimer);
    runSeq++;
    var typed = els.q.value;
    if (typed.indexOf('\\') < 0) runPaths = [];
    runRows();                                  // the history filters at once, with no round trip
    if (typed.indexOf('\\') < 0) return;
    var mine = runSeq;
    runTimer = setTimeout(function () {
      mantle.call('run.complete', { typed: typed }).then(function (res) {
        if (mine !== runSeq || mode !== 'run') return;
        runPaths = res && Array.isArray(res.items) ? res.items : [];
        runRows();
      }, function () { if (mine === runSeq) { runPaths = []; runRows(); } });
    }, 60);
  }

  function activateRun(item, admin) {
    var line = item.line;
    if (!line) return;
    if (item.kind !== 'runline') els.q.value = line;
    once(item, admin ? 'runas' : 'run', function () { return mantle.call('run.exec', { line: line, admin: !!admin }).then(function (res) {
      if (res && res.ok) {
        runHist = [line].concat(runHist.filter(function (h) { return h.toLowerCase() !== line.toLowerCase(); }));
        if (res.dryRun || res.reason) {
          note = { id: item.id, text: res.reason, ok: true };
          render();
          if (!res.dryRun) hideTimer = setTimeout(function () { hideAfterAction(); }, 1400);
          return;
        }
        hideAfterAction();
        return;
      }
      runFailed(item, line, (res && res.reason) || 'It didn\'t run, and no reason came back.');
    }, function (err) { runFailed(item, line, 'The run request failed: ' + reasonOf(err)); }); });
  }

  function runFailed(item, line, text) {
    var n = { id: item.kind === 'runline' ? item.id : 'run:line', text: text, ok: false };
    if (!shownNow) {                            // the UAC prompt took the screen and the launcher closed
      reopen = { line: line, note: n };
      pendingOpen = { mode: 'run', query: '', at: Date.now() };
      mantle.call('launcher.show');
      return;
    }
    els.q.value = line;
    runRows();
    note = n;
    render();
  }

  function quickRows() {
    if (!QL) { showProblem('The launcher is missing part of itself (quick-links.js), so Quick links cannot be shown. Reinstalling Mantle fixes this.'); return; }
    var list = quickSub === 'power' ? QL.POWER : QL.LINKS;
    var groups = [];
    for (var i = 0; i < list.length; i++) {
      var l = list[i];
      var p = QL.parse(l.label);
      var row = quickSub === 'power'
        ? { kind: 'power', id: 'qp:' + l.id, name: p.text, parts: p, path: l.action, glyph: POWER_GLYPH[l.action],
          confirm: l.confirm ? 'Press ' + p.letter.toUpperCase() + ' again to ' + p.text.toLowerCase() : undefined, subtitle: '' }
        : { kind: 'quick', id: 'q:' + l.id, name: p.text, parts: p, link: l, subtitle: l.sub || '' };
      var label = quickSub === 'power' ? 'Shut down or sign out' : QUICK_GROUPS[l.group];
      var g = groups[groups.length - 1];
      if (!g || g.label !== label) { g = { label: label, rows: [] }; groups.push(g); }
      g.rows.push(row);
    }
    setView(groups);
  }

  function quickBack() { quickSub = null; disarm(); userMoved = false; note = null; quickRows(); }

  function quickKey(k) {
    if (!QL) return;
    var l = QL.byKey(quickSub === 'power' ? QL.POWER : QL.LINKS, k);
    if (!l) return;
    var id = (quickSub === 'power' ? 'qp:' : 'q:') + l.id;
    for (var i = 0; i < rows.length; i++) if (rows[i].id === id) { select(i); break; }
    activate(false);
  }

  function activateQuick(item) {
    var l = item.link;
    if (l.page === 'power') { quickSub = 'power'; userMoved = false; note = null; quickRows(); return; }
    if (l.page === 'search' || l.page === 'run') {
      applyMode(l.page);
      els.q.value = '';
      note = null; userMoved = false;
      if (l.page === 'run') openSpecial(); else runSearch();
      els.q.focus();
      return;
    }
    once(item, 'open', function () { return mantle.call('quicklinks.open', { link: l.id }).then(function (res) {
      if (res && res.ok) {
        if (res.dryRun || res.reason) {
          note = { id: item.id, text: res.reason, ok: true };
          render();
          if (!res.dryRun) hideTimer = setTimeout(function () { hideAfterAction(); }, 1400);
          return;
        }
        hideAfterAction();
        return;
      }
      note = { id: item.id, text: (res && res.reason) || item.name + ' didn\'t open, and no reason came back.', ok: false };
      render();
    }, function (err) {
      note = { id: item.id, text: 'The quick link request failed: ' + reasonOf(err), ok: false };
      render();
    }); });
  }

  /* Keys of the two modes, asked first by the page's keydown. true = handled. */
  function specialKey(e) {
    if (mode === 'quick') {
      if (e.key === 'Escape' && !armed && quickSub) { e.preventDefault(); quickBack(); return true; }
      if (e.key === 'ArrowLeft' && quickSub) { e.preventDefault(); quickBack(); return true; }
      if (e.key === 'ArrowRight' && !quickSub && rows[sel] && rows[sel].id === 'q:shutdown') { e.preventDefault(); activate(false); return true; }
      if (e.key && e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
        e.preventDefault();
        if (!e.repeat) quickKey(e.key);
        return true;
      }
      return false;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (!e.repeat && rows[sel]) activateRun(rows[sel], e.ctrlKey && e.shiftKey);
      return true;
    }
    if (e.key === 'Tab' && !e.shiftKey) {
      e.preventDefault();
      var it = rows[sel];
      if (it && it.kind !== 'runline') { els.q.value = it.line; userMoved = false; queueRun(); }
      return true;
    }
    return false;
  }

  /* ---- boot ---------------------------------------------------------------- */
  refreshIndex(false);
  runSearch();
  lastRefresh = Date.now();   // the boot's own index call is fresh: the first open need not rebuild
  // the loading line only if the first answer is slow (a cold index waits on icons): no flash otherwise
  setTimeout(function () { if (!answered) render(); }, 150);
  els.q.focus();
})();

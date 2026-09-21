'use strict';
const fs = require('fs');
const path = require('path');
const { BrowserWindow, screen } = require('electron');
const { placeholderUrl } = require('./placeholder');

/*
 * The three windows Mantle puts on screen, and the two very different shapes
 * they take.
 *
 * LIVE: frameless, transparent, click-through-ish chrome that belongs to the
 * shell -- the bar pinned to a screen edge above everything, the launcher a
 * floating panel, the desktop reparented under the wallpaper by the sidecar.
 *
 * TEST (--test): three ordinary resizable windows with frames and a dark
 * backdrop, so they can be moved, screenshotted and closed like any app, and so
 * nothing about the real shell is touched. This is the ONLY shape that ever runs
 * while someone is at the machine, which is also why every show here is
 * showInactive(): a test run must never take focus from whoever is working.
 *
 * BAR_H is the single source of truth for the bar's height: the window, the work
 * area Mantle reserves in live mode, and lane C's CSS all have to agree, and the
 * work area is the one that leaves a visible gap if it drifts.
 */

const BAR_H = 44;

/** A window's page, or a placeholder that names the file and lane if it is missing. */
function loadPage(win, { file, title, owner, compact }) {
  if (fs.existsSync(file)) {
    win.loadFile(file);
    return { loaded: true };
  }
  win.loadURL(placeholderUrl({
    title,
    file: path.relative(path.dirname(path.dirname(file)), file).split(path.sep).join('/'),
    owner,
    compact,
  }));
  return { loaded: false, reason: `${file} does not exist (${owner})` };
}

/*
 * In test mode the windows have a frame, and Electron's width/height include it.
 * A 44px-tall framed window therefore has about 10px of PAGE in it, which is
 * exactly what the first screenshot run produced. useContentSize moves the
 * measurement to the web contents, so "44px tall" means 44px of bar -- the same
 * number the live window and lane C's CSS use.
 */
const TEST_SIZE = { useContentSize: true };

function baseWebPreferences(root) {
  return {
    preload: path.join(root, 'preload.js'),
    contextIsolation: true,      // renderers are plain browser scripts
    sandbox: true,               // ... with no require(), ever
    nodeIntegration: false,
    spellcheck: false,
    // Chromium throttles timers in windows it thinks are hidden. The desktop
    // lives UNDER the wallpaper and the bar can be fully occluded by a maximised
    // window, and both still have to keep a clock honest. These pages are idle
    // between ticks, so turning throttling off costs nothing measurable.
    backgroundThrottling: false,
  };
}

function createBar({ root, test, barEdge }) {
  const display = screen.getPrimaryDisplay();
  const b = display.bounds;
  const common = {
    width: test ? 1280 : b.width,
    height: BAR_H,
    webPreferences: baseWebPreferences(root),
    show: false,
    title: 'Mantle bar',
  };
  const win = new BrowserWindow(test ? Object.assign(common, TEST_SIZE, {
    resizable: true,
    backgroundColor: '#1a1c20',   // --ink-0, so lane C's glass has something to sit on
  }) : Object.assign(common, {
    x: b.x,
    y: barEdge === 'top' ? b.y : b.y + b.height - BAR_H,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    focusable: false,             // clicking the bar must not take focus off the app
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    fullscreenable: false,
    minimizable: false,
    maximizable: false,
  }));

  if (!test) {
    // 'floating' (the default) sits above ordinary windows but still yields to a
    // fullscreen game, which is what Owen wants: the bar must not paint over
    // something he is playing.
    win.setAlwaysOnTop(true, 'floating');
  }

  const load = loadPage(win, {
    file: path.join(root, 'ui', 'bar', 'index.html'),
    title: 'The bar',
    owner: 'ui/bar/ is lane C',
    compact: true,
  });
  return { win, load };
}

function createLauncher({ root, test }) {
  const display = screen.getPrimaryDisplay();
  const b = display.bounds;
  const W = 680;
  const H = 460;
  const common = {
    width: W,
    height: H,
    webPreferences: baseWebPreferences(root),
    show: false,
    title: 'Mantle launcher',
  };
  const win = new BrowserWindow(test ? Object.assign(common, TEST_SIZE, {
    resizable: true,
    backgroundColor: '#1a1c20',
  }) : Object.assign(common, {
    x: Math.round(b.x + (b.width - W) / 2),
    y: Math.round(b.y + (b.height - H) / 2),
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    fullscreenable: false,
    minimizable: false,
    maximizable: false,
  }));

  if (!test) win.setAlwaysOnTop(true, 'floating');

  const load = loadPage(win, {
    file: path.join(root, 'ui', 'launcher', 'index.html'),
    title: 'The launcher',
    owner: 'ui/launcher/ is lane D',
    compact: false,
  });
  return { win, load };
}

function createDesktop({ root, test }) {
  const display = screen.getPrimaryDisplay();
  const b = display.bounds;
  const common = {
    webPreferences: baseWebPreferences(root),
    show: false,
    title: 'Mantle desktop',
  };
  const win = new BrowserWindow(test ? Object.assign(common, TEST_SIZE, {
    width: 960,
    height: 540,
    resizable: true,
    backgroundColor: '#1a1c20',   // stands in for the wallpaper
  }) : Object.assign(common, {
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
    frame: false,
    transparent: true,            // the wallpaper shows through everywhere the page does not paint
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    fullscreenable: false,
    minimizable: false,
    maximizable: false,
  }));

  const load = loadPage(win, {
    file: path.join(root, 'ui', 'desktop', 'index.html'),
    title: 'The desktop layer',
    owner: 'ui/desktop/ is this lane -- if you are seeing this, the file was deleted',
    compact: false,
  });
  return { win, load };
}

/**
 * The hwnd the sidecar needs, as the decimal string the protocol asks for.
 * getNativeWindowHandle gives a 4- or 8-byte little-endian buffer depending on
 * the build; reading the wrong width would hand Win32 a garbage handle.
 */
function hwndOf(win) {
  const buf = win.getNativeWindowHandle();
  if (buf.length >= 8) return buf.readBigUInt64LE(0).toString();
  return String(buf.readUInt32LE(0));
}

module.exports = { createBar, createLauncher, createDesktop, hwndOf, BAR_H };

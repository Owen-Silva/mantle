'use strict';
/*
 * toprow-probe-window.js -- an Electron entry for the top-row hint tests (lane mantle-topbar-zero): ONE window
 * whose hwnd it prints, so a hint can name a window of a known process (lib/toprow-hints.js checks the sender:
 * Quartz = an electron.exe under ~\browser\, so run it with that electron.exe to stand in for Quartz; with
 * Mantle's own electron.exe it is a window that is NOT Quartz's). It never touches the app it borrows the
 * electron.exe from: it only runs this file.
 *
 *   <electron.exe> tools/toprow-probe-window.js
 *       hidden (lib/test-quiet.js: never drawn, never focused, in no app list)
 *   <electron.exe> tools/toprow-probe-window.js --show X,Y,W,H --color RRGGBB
 *       a real window at that PHYSICAL rect, one colour, never focused, not in the taskbar (the on-screen
 *       latency measurement; only while the user allows test windows on screen)
 *
 * stdout: "hwnd <decimal>" once it is up, then "port <P>": a loopback TCP socket on 127.0.0.1:P takes lines
 * "color RRGGBB" (repaints; replies "painted <wall ms>" once the page has drawn it), "title TEXT" ("titled"),
 * "quit" ("bye"). Piped stdin is NOT used (it never reaches Electron's main process). Exits when its parent
 * does, or after 10 minutes.
 */
const path = require('path');
const net = require('net');
const argv = process.argv.slice(1);
const at = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
const showRect = at('--show');
if (!showRect) require(path.join(__dirname, '..', 'lib', 'test-quiet')).install(['--test'], process.env, { log: () => {} });
const { app, BrowserWindow, screen } = require('electron');

const hex = (s) => (/^[0-9a-f]{6}$/i.test(String(s || '')) ? '#' + s : '#202020');
app.disableHardwareAcceleration();
app.on('window-all-closed', () => app.quit());
app.whenReady().then(async () => {
  let rect = { x: 0, y: 0, width: 200, height: 120 };
  if (showRect) {
    const [x, y, w, h] = showRect.split(',').map(Number);
    rect = screen.screenToDipRect(null, { x, y, width: w, height: h });
  }
  const color = hex(at('--color'));
  const win = new BrowserWindow({
    x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height),
    show: false, frame: false, resizable: false, skipTaskbar: true, focusable: false, hasShadow: false,
    backgroundColor: color, title: at('--title') || 'toprow probe', webPreferences: { contextIsolation: true },
  });
  await win.loadURL('data:text/html,' + encodeURIComponent(`<html><body style="margin:0;background:${color}"></body></html>`));
  if (showRect) win.showInactive();
  const b = win.getNativeWindowHandle();
  process.stdout.write(`hwnd ${b.length >= 8 ? b.readBigUInt64LE(0).toString() : String(b.readUInt32LE(0))}\n`);
  // commands come over a loopback socket: piped stdin never reaches Electron's main process (zero-measure,
  // 2026-10-11: "color" lines did nothing). Each line in -> a reply line out on the same socket (and stdout).
  const srv = net.createServer((sock) => {
    let buf = '';
    sock.on('error', () => {});
    const say = (l) => { process.stdout.write(l + '\n'); try { sock.write(l + '\n'); } catch (_) { /* gone */ } };
    sock.on('data', (c) => {
      buf += c.toString('utf8');
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        let m;
        if (l === 'quit') { say('bye'); app.quit(); }
        else if ((m = /^color\s+([0-9a-f]{6})$/i.exec(l))) {
          const c2 = hex(m[1]);
          win.setBackgroundColor(c2);
          win.webContents.executeJavaScript(`document.body.style.background='${c2}';new Promise((r)=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(performance.timeOrigin+performance.now()))))`)
            .then((t) => say(`painted ${Number(t).toFixed(1)}`), (e) => say(`error ${e && e.message}`));
        } else if ((m = /^title\s+(.+)$/.exec(l))) { win.setTitle(m[1]); say('titled'); }
        else say(`unknown ${l}`);
      }
    });
  });
  srv.listen(0, '127.0.0.1', () => process.stdout.write(`port ${srv.address().port}\n`));
  // (not on stdin's end: Electron's main process can see EOF at once on a pipe) the parent gone = quit
  const parent = process.ppid;
  setInterval(() => { try { process.kill(parent, 0); } catch (_) { app.quit(); } }, 1000);
  setTimeout(() => app.quit(), 10 * 60 * 1000);
});

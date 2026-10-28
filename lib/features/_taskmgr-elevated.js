'use strict';

// _taskmgr-elevated.js - the non-elevated client for Mantle's Task Manager admin helper.
//
// Windows' Task Manager silently runs as administrator. Owen chose "Always admin, no prompt": a
// ONE-time UAC setup installs mantle.elevated.exe (sidecar/elevated) as a scheduled task with
// RunLevel Highest, and after that this client reaches admin-only Task Manager work over a named
// pipe WITHOUT another prompt - until the helper version changes. He was told and accepted that any
// program running as him could also start that helper; Program.cs lists exactly what that caps.
//
// createElevated(ctx) -> { status, setup, uninstall, run }. tm-data's seam calls run(op, args)
// whenever a command answers needsAdmin. This file NEVER raises a UAC prompt on its own: only
// setup() does, and only when the UI's "Set up administrator access" button is clicked. run() and
// status() are silent.
//
// The helper is started lazily (the scheduled task is run on demand), a one-shot handshake token is
// written to a user-only file so the helper knows this client is the one that started it, the client
// connects to the pipe, says hello, and forwards the SAME command it would have sent un-elevated.
// The helper exits on disconnect or after 2 minutes idle, so nothing lingers.

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');

const DEFAULTS = {
  installDir: path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'Mantle', 'Elevated'),
  exeName: 'mantle.elevated.exe',
  versionName: 'version.txt',
  taskName: 'Mantle Elevated Helper',
  pipeName: '\\\\.\\pipe\\Mantle.Elevated',
  handshakeFile: path.join(process.env['LOCALAPPDATA'] || path.join(os.homedir(), 'AppData', 'Local'),
                           'Mantle', 'elevated', 'handshake.json'),
  // The version this build of Mantle expects. Source of truth: sidecar/elevated/VERSION.
  expectedVersion: readExpectedVersion(),
  setupScript: path.join(__dirname, '..', '..', 'tools', 'mantle-elevated-setup.ps1'),
};

function readExpectedVersion() {
  try {
    return fs.readFileSync(path.join(__dirname, '..', '..', 'sidecar', 'elevated', 'VERSION'), 'utf8').trim();
  } catch (_) { return null; }
}

// createElevated(ctx[, overrides]). `overrides` is an undocumented test seam (startHelper, paths,
// clock) so the channel + auth + version logic can be exercised un-elevated; production passes none.
function createElevated(ctx, overrides) {
  const cfg = Object.assign({}, DEFAULTS, overrides || {});
  const log = (ctx && typeof ctx.log === 'function') ? ctx.log : function () {};
  const exePath = path.join(cfg.installDir, cfg.exeName);
  const versionPath = path.join(cfg.installDir, cfg.versionName);

  let conn = null;     // { socket, authed, pending: Map<id,{resolve,timer}>, buf, nextId }

  // ---- state ------------------------------------------------------------
  function installedVersion() {
    try { return fs.readFileSync(versionPath, 'utf8').trim(); } catch (_) { return null; }
  }
  function exeExists() { try { return fs.statSync(exePath).isFile(); } catch (_) { return false; } }

  function status() {
    const inst = installedVersion();
    const haveExe = exeExists();
    const installed = !!(inst && haveExe);
    const stale = installed && cfg.expectedVersion != null && inst !== cfg.expectedVersion;
    const running = !!(conn && conn.authed);
    let reason;
    if (!haveExe && !inst) reason = 'The administrator helper is not set up yet.';
    else if (!haveExe) reason = 'The helper is registered but its program is missing; set it up again.';
    else if (!inst) reason = 'The helper program is present but not registered; set it up again.';
    else if (stale) reason = 'A newer administrator helper is available (installed ' + inst + ', need ' + cfg.expectedVersion + '); set it up again.';
    else reason = 'Administrator access is set up.';
    return { installed, version: inst, stale, running, reason };
  }

  // ---- setup / uninstall (the ONE UAC prompt) ---------------------------
  // Runs tools/mantle-elevated-setup.ps1 elevated (ShellExecute runas -> UAC). This is the only
  // path that raises a prompt, and only from the UI's explicit "Set up administrator access".
  function runSetupScript(mode) {
    return new Promise(function (resolve) {
      if (cfg.startHelper && cfg.setupImpl) { resolve(cfg.setupImpl(mode)); return; } // test seam
      const psArgs = [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
        "Start-Process -FilePath powershell -Verb RunAs -Wait -ArgumentList " +
          "'-NoProfile','-ExecutionPolicy','Bypass','-File','" + cfg.setupScript + "','-Mode','" + mode + "'",
      ];
      let done = false;
      const p = spawn('powershell.exe', psArgs, { windowsHide: true });
      p.on('error', function (e) { if (!done) { done = true; resolve({ ok: false, reason: 'Could not start the setup prompt: ' + e.message, kind: 'error' }); } });
      p.on('exit', function (code) {
        if (done) return; done = true;
        if (code === 0) resolve({ ok: true });
        else resolve({ ok: false, reason: 'Setup did not finish (the administrator prompt may have been declined).', kind: code === 1223 ? 'cancelled' : 'failed' });
      });
    });
  }
  function setup() { return runSetupScript('install'); }
  function uninstall() { return runSetupScript('uninstall'); }

  // ---- run --------------------------------------------------------------
  function run(op, args, opts) {
    const timeoutMs = (opts && opts.timeoutMs) || 10000;
    return ensureConnected(timeoutMs).then(function () {
      return send(op, args || {}, timeoutMs);
    }, function (err) {
      return { ok: false, reason: err.message || String(err), kind: 'start' };
    });
  }

  function ensureConnected(timeoutMs) {
    if (conn && conn.authed) return Promise.resolve();
    if (conn && conn.connecting) return conn.connecting;
    const st = status();
    if (!st.installed) return Promise.reject(new Error(st.reason));
    if (st.stale) return Promise.reject(new Error(st.reason));

    const token = cryptoToken();
    const c = { socket: null, authed: false, pending: new Map(), buf: '', nextId: 1, connecting: null };
    conn = c;
    c.connecting = (async function () {
      try { writeHandshake(cfg.handshakeFile, token); }
      catch (e) { teardown(c, 'handshake'); throw new Error('Could not write the handshake file: ' + e.message); }
      try { await startHelper(); }
      catch (e) { teardown(c, 'start'); throw new Error('Could not start the administrator helper: ' + e.message); }
      await connectPipe(c, timeoutMs);
      // say hello; the helper validates it during its own auth and does not ack.
      c.socket.write(JSON.stringify({ hello: token }) + '\n');
      c.authed = true;
      c.connecting = null;
      log('elevated helper connected');
    })();
    return c.connecting;
  }

  function startHelper() {
    if (cfg.startHelper) return Promise.resolve(cfg.startHelper()); // test seam spawns the exe directly
    return new Promise(function (resolve, reject) {
      const p = spawn('schtasks.exe', ['/Run', '/TN', cfg.taskName], { windowsHide: true });
      p.on('error', reject);
      p.on('exit', function (code) { code === 0 ? resolve() : reject(new Error('schtasks /Run exited ' + code)); });
    });
  }

  function connectPipe(c, timeoutMs) {
    const deadline = Date.now() + Math.min(timeoutMs, 8000);
    return new Promise(function (resolve, reject) {
      const attempt = function () {
        const s = net.connect(cfg.pipeName);
        let settled = false;
        s.on('connect', function () {
          settled = true;
          c.socket = s;
          s.setEncoding('utf8');
          s.on('data', function (d) { onData(c, d); });
          s.on('close', function () { onClose(c); });
          s.on('error', function () {});
          resolve();
        });
        s.on('error', function () {
          if (settled) return;
          s.destroy();
          if (Date.now() >= deadline) { teardown(c, 'connect'); reject(new Error('The administrator helper did not open its channel in time.')); }
          else setTimeout(attempt, 120);
        });
      };
      attempt();
    });
  }

  function send(op, args, timeoutMs) {
    const c = conn;
    if (!c || !c.authed || !c.socket) return Promise.resolve({ ok: false, reason: 'The administrator helper is not connected.', kind: 'start' });
    const id = c.nextId++;
    return new Promise(function (resolve) {
      const timer = setTimeout(function () {
        if (c.pending.has(id)) { c.pending.delete(id); resolve({ ok: false, reason: 'The administrator helper did not answer "' + op + '" in time.', kind: 'timeout' }); }
      }, timeoutMs);
      c.pending.set(id, { resolve: resolve, timer: timer });
      const payload = Object.assign({ id: id, cmd: op }, args);
      try { c.socket.write(JSON.stringify(payload) + '\n'); }
      catch (e) { clearTimeout(timer); c.pending.delete(id); resolve({ ok: false, reason: 'Could not send to the administrator helper: ' + e.message, kind: 'error' }); }
    });
  }

  function onData(c, chunk) {
    c.buf += chunk;
    let nl;
    while ((nl = c.buf.indexOf('\n')) >= 0) {
      const line = c.buf.slice(0, nl); c.buf = c.buf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg; try { msg = JSON.parse(line); } catch (_) { continue; }
      if (msg && (msg.id === null || msg.id === undefined) && msg.ok === false) {
        // an auth refusal arrives before any request id; fail everything pending with its reason.
        failAll(c, msg.reason || 'The administrator helper refused the connection.', 'refused');
        continue;
      }
      const slot = c.pending.get(msg.id);
      if (!slot) continue;
      clearTimeout(slot.timer); c.pending.delete(msg.id);
      const out = Object.assign({}, msg); delete out.id;
      if (typeof out.ok === 'undefined') out.ok = false;
      slot.resolve(out);
    }
  }

  function onClose(c) {
    if (conn === c) conn = null;
    failAll(c, 'The administrator helper closed the connection.', 'closed');
  }
  function failAll(c, reason, kind) {
    c.authed = false;
    c.pending.forEach(function (slot) { clearTimeout(slot.timer); slot.resolve({ ok: false, reason: reason, kind: kind }); });
    c.pending.clear();
  }
  function teardown(c, why) {
    if (conn === c) conn = null;
    if (c.socket) { try { c.socket.destroy(); } catch (_) {} }
  }

  // Drop the live connection (the helper then sees EOF and exits). The next run() reconnects.
  function disconnect() { const c = conn; if (c && c.socket) { try { c.socket.destroy(); } catch (_) {} } conn = null; }

  return { status: status, setup: setup, uninstall: uninstall, run: run, disconnect: disconnect,
           _exePath: exePath, _versionPath: versionPath };
}

function cryptoToken() {
  try { return require('crypto').randomBytes(32).toString('hex'); }
  catch (_) { return String(Date.now()) + Math.random().toString(16).slice(2); }
}

function writeHandshake(file, token) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try { fs.unlinkSync(file); } catch (_) {}
  // CreateNew-ish: 'wx' fails if it exists (so a planted file is not reused), user-only by folder ACL.
  const fd = fs.openSync(file, 'wx');
  try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token: token })); }
  finally { fs.closeSync(fd); }
}

module.exports = { createElevated: createElevated, _readExpectedVersion: readExpectedVersion };

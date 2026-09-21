'use strict';
const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

/*
 * The one channel to the C# sidecar, which does every Win32 call for us.
 *
 * WHY a sidecar at all: Electron cannot hide the shell taskbar, reparent a window
 * under the wallpaper, reserve a work area or read the notification area. Rather
 * than sprinkle native modules through the app, ONE process owns all of that and
 * speaks JSON lines over stdin/stdout. It also means the dangerous half of Mantle
 * has one lifetime and one owner: the sidecar restores everything it changed the
 * moment its stdin hits EOF or its parent dies, so a crashed Electron cannot
 * leave Owen without a taskbar.
 *
 * Protocol: one JSON object per line, UTF-8.
 *   out  {"id":n,"cmd":"windows", ...args}
 *   in   {"id":n,"ok":true,"result":...} | {"id":n,"ok":false,"error":"plain words"}
 *   in   {"ev":"ready"|"windows"|"hotkey"|"taskbar"|"restore"|"log", ...}
 *
 * Everything that can go wrong here is reported as a plain-words reason through
 * the 'status' event, which main.js writes straight into State. Nothing in this
 * file is allowed to fail quietly.
 *
 * --state-file=<path> (2026-09-21, after the taskbar incident): the sidecar
 * writes the ORIGINAL shell state to that file before it changes anything, and
 * updates it after every change and at the end of its own restore path. It is
 * passed in BOTH modes on purpose -- a passive sidecar changes nothing, so the
 * file it writes is a harmless record, and there is then exactly one code path
 * instead of two. tools/restore-windows.ps1 reads that file with no Node, no
 * Electron and no Mantle running, which is the whole point: Windows can be put
 * back by a process that knows nothing about this one.
 */

const CALL_TIMEOUT_MS = 8000;
const MAX_RESTARTS = 3;
const RESTART_DELAY_MS = 3000;

class Sidecar extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.exePath      absolute path to Mantle.Sidecar.exe
   * @param {string} o.buildScript  absolute path to sidecar/build.ps1
   * @param {boolean} o.passive     pass --passive (test mode: refuses shell changes)
   * @param {string} o.cwd          repo root, so build.ps1 resolves
   * @param {string} o.stateFile    where the sidecar records the ORIGINAL shell state
   */
  constructor({ exePath, buildScript, passive, cwd, stateFile }) {
    super();
    this.exePath = exePath;
    this.buildScript = buildScript;
    this.passive = !!passive;
    this.cwd = cwd;
    this.stateFile = stateFile || null;

    this.proc = null;
    this.nextId = 1;
    this.pending = new Map();   // id -> {resolve, reject, timer, cmd}
    this.unawaited = new Set(); // ids sent without waiting for a reply (the quit)
    this.stdoutBuf = '';
    this.status = 'starting';
    this.reason = 'sidecar has not been started yet';
    this.info = null;           // {pid, passive, version} from the ready event
    this.restarts = 0;
    this.stopping = false;
    this.triedBuild = false;
    this.lastLog = null;        // the most recent {"ev":"log"} line, for reasons
  }

  _setStatus(status, reason) {
    // Always emit, even when unchanged: main.js de-duplicates through State.set,
    // and a repeated reason is cheaper than a missed one.
    this.status = status;
    this.reason = reason;
    this.emit('status', { status, reason, info: this.info });
  }

  /**
   * Start (or restart) the sidecar. Never throws: a failure to start is a state,
   * not an exception -- the rest of Mantle has to keep running and say why the
   * window list is empty.
   */
  async start() {
    this.stopping = false;

    if (!fs.existsSync(this.exePath)) {
      const built = await this._tryBuild();
      if (!built.ok) {
        this._setStatus('down', built.reason);
        return false;
      }
    }

    let proc;
    try {
      // An exe older than the state-file protocol simply ignores a flag it does
      // not know (its arg loop has no else branch), so passing this is safe on
      // both. What is NOT safe is assuming the old exe understands the new
      // COMMANDS -- see protocolAge() below.
      proc = spawn(this.exePath, [
        '--parent-pid=' + process.pid,
        ...(this.stateFile ? ['--state-file=' + this.stateFile] : []),
        ...(this.passive ? ['--passive'] : []),
      ], {
        cwd: this.cwd,
        windowsHide: true,               // never flash a console over Owen's screen
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      this._setStatus('down', `sidecar would not start: ${err.message}`);
      return false;
    }

    this.proc = proc;
    this.stdoutBuf = '';
    this._setStatus('starting', 'sidecar started, waiting for its ready line');

    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => this._onStdout(chunk));

    // stderr is not part of the protocol, but anything on it is a real complaint
    // and belongs in the reason string rather than in a log nobody reads.
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk) => {
      const text = String(chunk).trim();
      if (text) {
        this.lastLog = text.split('\n').pop();
        this.emit('log', { level: 'error', message: this.lastLog });
      }
    });

    proc.on('error', (err) => {
      this._setStatus('down', `sidecar process error: ${err.message}`);
    });

    proc.on('exit', (code, signal) => {
      const how = signal ? `killed by ${signal}` : `exited with code ${code}`;
      this._failAllPending(`sidecar ${how} before answering`);
      this.proc = null;
      this.info = null;
      if (this.stopping) {
        this._setStatus('down', 'sidecar stopped because Mantle is shutting down');
        return;
      }
      this.emit('died', { code, signal });
      if (this.restarts < MAX_RESTARTS) {
        this.restarts += 1;
        const tail = this.lastLog ? ` last it said: "${this.lastLog}"` : '';
        this._setStatus('down', `sidecar ${how}; restarting in 3s (attempt ${this.restarts} of ${MAX_RESTARTS}).${tail}`);
        this._restartTimer = setTimeout(() => { this.start(); }, RESTART_DELAY_MS);
        if (this._restartTimer.unref) this._restartTimer.unref();
      } else {
        const tail = this.lastLog ? ` last it said: "${this.lastLog}"` : '';
        this._setStatus('down', `sidecar ${how} and gave up after ${MAX_RESTARTS} restarts; run npm run build:sidecar and restart Mantle.${tail}`);
      }
    });

    return true;
  }

  /**
   * The exe is missing. Try building it exactly once per process, then say
   * precisely what is missing and who owns it. Building is worth trying because
   * the sidecar compiles with the in-box csc.exe -- no toolchain to install.
   */
  async _tryBuild() {
    const where = this.exePath;
    if (this.triedBuild) {
      return { ok: false, reason: `sidecar down: still no exe at ${rel(this.cwd, where)} after running the build once; build with npm run build:sidecar` };
    }
    this.triedBuild = true;

    if (!fs.existsSync(this.buildScript)) {
      return {
        ok: false,
        reason: `sidecar down: exe missing at ${rel(this.cwd, where)} and ${rel(this.cwd, this.buildScript)} does not exist yet, so there is nothing to build with`,
      };
    }

    this._setStatus('starting', `sidecar exe missing at ${rel(this.cwd, where)}; building it now with ${rel(this.cwd, this.buildScript)}`);
    const out = await runPowerShell(this.buildScript, this.cwd);
    if (fs.existsSync(where)) return { ok: true, reason: 'built' };

    const tail = (out.text || '').trim().split('\n').slice(-2).join(' / ').slice(0, 300);
    return {
      ok: false,
      reason: `sidecar down: build.ps1 finished with code ${out.code} but there is still no exe at ${rel(this.cwd, where)}${tail ? ` -- it said: "${tail}"` : ''}`,
    };
  }

  _onStdout(chunk) {
    this.stdoutBuf += chunk;
    let nl;
    while ((nl = this.stdoutBuf.indexOf('\n')) !== -1) {
      const line = this.stdoutBuf.slice(0, nl).trim();
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch (err) {
        // A non-JSON line means the sidecar printed something it should not
        // have. Surface it rather than dropping it on the floor.
        this.emit('log', { level: 'warn', message: `sidecar printed a line that is not JSON: ${line.slice(0, 200)}` });
        continue;
      }
      // The sidecar answers a line it could not parse with {"id":null,...} --
      // there is no pending request to reject, so it is a complaint about us and
      // it goes straight to the log instead of into the reply matcher.
      if (msg && msg.id === null) {
        this.lastLog = `the sidecar could not read something we sent: ${msg.error || 'no reason given'}`;
        this.emit('log', { level: 'warn', message: this.lastLog });
        continue;
      }
      if (msg && typeof msg.id === 'number') this._onReply(msg);
      else if (msg && typeof msg.ev === 'string') this._onEvent(msg);
      else this.emit('log', { level: 'warn', message: `sidecar sent an object with neither id nor ev: ${line.slice(0, 200)}` });
    }
    // A runaway sidecar printing without newlines must not eat all the memory.
    if (this.stdoutBuf.length > 4 * 1024 * 1024) {
      this.stdoutBuf = '';
      this.emit('log', { level: 'warn', message: 'sidecar sent 4MB with no newline; dropped the buffer' });
    }
  }

  _onReply(msg) {
    const p = this.pending.get(msg.id);
    if (!p) {
      // The quit we send on the way out is the one command nobody waits for --
      // its reply arriving is normal, not a protocol bug, and warning about it
      // would cry wolf on every clean shutdown.
      if (this.unawaited.has(msg.id)) {
        this.unawaited.delete(msg.id);
        return;
      }
      this.emit('log', { level: 'warn', message: `sidecar answered id ${msg.id}, which nobody asked for` });
      return;
    }
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(typeof msg.error === 'string' && msg.error ? msg.error : `sidecar refused "${p.cmd}" without saying why`));
  }

  _onEvent(msg) {
    if (msg.ev === 'ready') {
      this.restarts = 0;
      this.info = { pid: msg.pid, passive: !!msg.passive, version: msg.version };
      this._setStatus('ok', `sidecar ${msg.version || '(no version)'} running as pid ${msg.pid}${msg.passive ? ', passive: it will refuse to change the shell' : ''}`);
    } else if (msg.ev === 'log') {
      this.lastLog = String(msg.message || '');
    }
    this.emit('event', msg);
    this.emit(msg.ev, msg);
  }

  /**
   * Is the exe on disk new enough to understand the commands that keep Windows
   * recoverable?
   *
   * WHY this is a PING and not a try-it-and-see: the pre-2026-09-21 exe answers
   * `taskbar` by looking for a `show` key, and its idea of what to do without one
   * is not something to find out on Owen's live shell. The new protocol added
   * `dpiAware` to the ping result precisely so its age can be read without asking
   * it to touch anything. No ping, no shell changes -- the shell is left alone and
   * the reason says to rebuild.
   *
   * `dpiAware` is passed through because it decides how to read every rectangle
   * the sidecar sends: a DPI-aware sidecar answers in PHYSICAL pixels, an unaware
   * one is handed virtualised numbers that are already DIP on the primary
   * display. Converting the wrong one is how the bar ends up 200px tall at 80%
   * width. `null` means the sidecar is too old to say.
   *
   * @returns {Promise<{current: boolean, reason: string, dpiAware: boolean|null}>} never throws
   */
  async protocolAge() {
    let info;
    try {
      info = await this.call('ping', {}, 4000);
    } catch (err) {
      return { current: false, dpiAware: null, reason: `the sidecar would not answer ping, so Mantle cannot tell how old it is: ${err.message}` };
    }
    if (info && Object.prototype.hasOwnProperty.call(info, 'dpiAware')) {
      return {
        current: true,
        dpiAware: info.dpiAware === true,
        reason: `sidecar ${info.version || '(no version)'} speaks the current protocol and is ${info.dpiAware === true ? 'DPI-aware, so its rectangles are physical pixels' : 'DPI-unaware, so its rectangles are already DIP on the primary display'}`,
      };
    }
    return {
      current: false,
      dpiAware: null,
      reason: 'sidecar exe is older than the protocol: run npm run build:sidecar (its ping does not report dpiAware, so it does not know the auto-hide or app-bar commands, and Mantle will not guess at what it would do instead)',
    };
  }

  /**
   * Does this error mean "the exe on disk predates this command"? Belt to
   * protocolAge()'s braces: a build that is new in some places and old in others
   * still ends up saying "rebuild it" rather than half-applying the shell.
   */
  static isOldExeError(err) {
    const m = (err && err.message ? err.message : String(err)).toLowerCase();
    return m.includes('unknown command')
      || m.includes('unknown cmd')
      || m.includes('needs show:true')     // the old taskbar handler's complaint
      || m.includes('no such command');
  }

  /** Is a call even possible right now? Returns a plain-words reason if not. */
  blockedReason() {
    if (!this.proc) return this.reason || 'the sidecar is not running';
    if (this.status !== 'ok') return this.reason || 'the sidecar has not finished starting';
    return null;
  }

  /**
   * Send one command. Rejects with an Error whose message is plain words, always:
   * the bar and the launcher put that message straight on screen.
   */
  call(cmd, args = {}, timeoutMs = CALL_TIMEOUT_MS) {
    const blocked = this.blockedReason();
    if (blocked) return Promise.reject(new Error(`cannot run "${cmd}": ${blocked}`));

    const id = this.nextId++;
    const payload = Object.assign({ id, cmd }, args);
    let line;
    try {
      line = JSON.stringify(payload) + '\n';
    } catch (err) {
      return Promise.reject(new Error(`cannot run "${cmd}": its arguments are not JSON (${err.message})`));
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`the sidecar did not answer "${cmd}" within ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      if (timer.unref) timer.unref();
      this.pending.set(id, { resolve, reject, timer, cmd });
      try {
        this.proc.stdin.write(line, 'utf8');
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new Error(`could not send "${cmd}" to the sidecar: ${err.message}`));
      }
    });
  }

  _failAllPending(reason) {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`${reason} (command "${p.cmd}")`));
    }
    this.pending.clear();
  }

  /**
   * Shut down. Closing stdin is the documented kill switch: the sidecar sees EOF
   * and undoes everything it changed before it exits. We ask politely first and
   * only then kill, because a killed sidecar still restores (it watches the
   * parent pid) but the polite path is the one we can reason about.
   */
  stop() {
    this.stopping = true;
    clearTimeout(this._restartTimer);
    const proc = this.proc;
    if (!proc) return;
    const quitId = this.nextId++;
    this.unawaited.add(quitId);
    try { proc.stdin.write(JSON.stringify({ id: quitId, cmd: 'quit' }) + '\n'); } catch (_) { /* already gone */ }
    try { proc.stdin.end(); } catch (_) { /* already gone */ }
    const killer = setTimeout(() => { try { proc.kill(); } catch (_) {} }, 1500);
    if (killer.unref) killer.unref();
  }
}

/** A path relative to the repo root, for reasons a human reads. */
function rel(root, p) {
  const r = path.relative(root, p);
  return r && !r.startsWith('..') ? r.split(path.sep).join('/') : p;
}

/** Run a .ps1 and resolve with {code, text}. Never rejects. */
function runPowerShell(script, cwd) {
  return new Promise((resolve) => {
    let text = '';
    let proc;
    try {
      proc = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], {
        cwd,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({ code: -1, text: `could not run powershell: ${err.message}` });
      return;
    }
    proc.stdout.on('data', (d) => { text += d; });
    proc.stderr.on('data', (d) => { text += d; });
    proc.on('error', (err) => resolve({ code: -1, text: `could not run powershell: ${err.message}` }));
    proc.on('exit', (code) => resolve({ code, text }));
  });
}

module.exports = { Sidecar, runPowerShell };

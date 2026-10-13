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
 *   out  {"id":n,"cmd":"windows","ttl":ms, ...args}
 *   in   {"id":n,"ok":true,"result":...} | {"id":n,"ok":false,"error":"plain words"}
 *   in   {"id":n,"ok":false,"error":"expired: ...","reason":"expired"}
 *   in   {"ev":"ready"|"windows"|"hotkey"|"taskbar"|"restore"|"log", ...}
 *
 * `ttl` (2026-09-22) is this call's own timeout. The sidecar stamps when the
 * line arrived and, if a lane only reaches it after the ttl has passed, answers
 * "expired" instead of doing work for a caller that has already given up.
 * Before that, a timed-out request still ran later, and under load the sidecar
 * fell permanently behind: 32 timeouts and 49 late answers in 150 log lines,
 * and the bar's buttons did nothing. An older exe ignores the key.
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
 *
 * Calls made while the sidecar is STARTING (2026-09-27): the process exists but
 * has not printed its ready line yet. Those used to be refused at once ("cannot
 * run X: sidecar started, waiting for its ready line"), and 57 of 57 reviewed
 * starts lost something to it -- the pinned list came up short until the next
 * reveal, the wallpaper could not pause for full screen, the first battery read
 * failed. Now such a call WAITS for the ready line, for at most READY_WAIT_MS or
 * the caller's own timeout, whichever is shorter, then is sent with the time it
 * has LEFT as its ttl (see _callWhenReady). If the sidecar dies or fails while
 * calls wait, they are refused at once with that reason. With no process at all
 * (never started, building, down, restarting) a call is still refused at once.
 */

const CALL_TIMEOUT_MS = 8000;
// The longest a call made while the sidecar is starting waits for its ready
// line. A healthy start prints it well inside a second; 8 s is the same budget a
// call already has, so a sidecar that never gets there fails loudly instead of
// holding callers forever.
const READY_WAIT_MS = 8000;
// 'ready' has a FIXED set of subscribers, one per consumer that re-applies state
// after every (re)start: 12 features through features.js's sidecar.onReady, 4 in
// main.js and 1 in notifications.js (counted 2026-09-27), and 'status' a handful.
// Node's default of 10 warned in 35 reviewed runs although nothing leaked. 40
// fits them with room, and still warns if something starts subscribing per call
// or per reveal -- call() itself never adds a listener (it uses readyWaiters).
const MAX_LISTENERS = 40;
// The longest line (answer or event) the client buffers. A longer one is dropped
// up to its newline; its caller is refused with the size, an event is reported by
// name, and none of its content is logged (see _onOversized).
const MAX_LINE_CHARS = 4 * 1024 * 1024;

/** ", event \"windows\"" / ", answer id 12" from a protocol line's first characters, or "". */
function describeHead(head) {
  const ev = /^\s*\{"ev":"([A-Za-z0-9_.:-]{1,40})"/.exec(head);
  if (ev) return `, event "${ev[1]}"`;
  const id = /^\s*\{"id":(\d{1,12})[,}]/.exec(head);
  return id ? `, answer id ${id[1]}` : '';
}
const MAX_RESTARTS = 3;
const RESTART_DELAY_MS = 3000;   // doubled per attempt in a row: 3 s, 6 s, 12 s
// core-lib quality pass (2026-09-29). The restart budget used to reset on every ready line, so a
// sidecar that got to "ready" and then crashed (a bad hook, a bad driver answer) restarted every
// 3 s forever. Now it resets only once a process has stayed up this long after its ready line.
const STABLE_MS = 60000;
// The liveness check (audit #11, 2026-10-12): a sidecar that is alive but frozen (its stdin reader
// stuck, the process suspended) never exits, so the restart path never ran and the bar went dead
// while the status still said ok. Every HEALTH_MS one ping (it runs on the ui lane, which only
// carries fast commands); no answer within HEALTH_TIMEOUT_MS is a miss, and HEALTH_MISSES in a row
// ends the process so the exit / backoff / gave-up path below runs exactly as for a crash.
const HEALTH_MS = 15000;
const HEALTH_TIMEOUT_MS = 3000;
const HEALTH_MISSES = 3;
// setTimeout's ceiling (about 24.8 days); a longer timer fires at once with a warning.
const MAX_TIMEOUT_MS = 2147483647;
// stderr is the sidecar's own complaints, and a crash can print thousands of lines: at most this
// many log lines per window, each cut to STDERR_LINE_MAX characters; the rest are counted and the
// count is said once (never silently dropped).
const STDERR_LINES_PER_WINDOW = 20;
const STDERR_WINDOW_MS = 10000;
const STDERR_LINE_MAX = 300;

/** At most n characters, with an ellipsis said as "..." when cut. */
function clip(text, n) {
  const t = String(text);
  return t.length > n ? t.slice(0, n - 3) + '...' : t;
}
// Ids whose caller timed out, remembered so their late answer (or the
// sidecar's "expired") is recognised rather than reported as a mystery id.
const ABANDONED_MAX = 500;
// How often, at most, to say "the sidecar skipped N requests" in the log.
const SHED_REPORT_MS = 30000;

class Sidecar extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.exePath      absolute path to Mantle.Sidecar.exe
   * @param {string|null} o.buildScript  absolute path to sidecar/build.ps1; null = never build (an override exe)
   * @param {boolean} o.passive     pass --passive (test mode: refuses shell changes)
   * @param {string} o.cwd          repo root, so build.ps1 resolves
   * @param {string} o.stateFile    where the sidecar records the ORIGINAL shell state
   * @param {number} [o.readyWaitMs] how long a call made while starting waits for the ready line (default READY_WAIT_MS)
   * @param {Function} [o.spawnImpl] TEST SEAM ONLY: stands in for child_process.spawn so
   *   lib/sidecar.test.js can run a fake node child instead of the exe. main.js never passes it.
   * @param {number} [o.restartDelayMs] TEST SEAM: the first restart's delay (default RESTART_DELAY_MS)
   * @param {number} [o.stableMs] TEST SEAM: up this long after ready = the restart budget resets
   */
  constructor({ exePath, buildScript, passive, cwd, stateFile, readyWaitMs, spawnImpl, restartDelayMs, stableMs }) {
    super();
    this.setMaxListeners(MAX_LISTENERS);
    this.exePath = exePath;
    this.buildScript = buildScript;
    this.passive = !!passive;
    this.cwd = cwd;
    this.stateFile = stateFile || null;
    this.readyWaitMs = Number.isFinite(readyWaitMs) && readyWaitMs >= 0 ? readyWaitMs : READY_WAIT_MS;
    this._spawn = typeof spawnImpl === 'function' ? spawnImpl : spawn;
    this.restartDelayMs = Number.isFinite(restartDelayMs) && restartDelayMs >= 0 ? restartDelayMs : RESTART_DELAY_MS;
    this.stableMs = Number.isFinite(stableMs) && stableMs >= 0 ? stableMs : STABLE_MS;
    this._spawnCount = 0;       // processes spawned, for the tests (a second start() must not add one)
    this._startP = null;        // a start() in flight (it may be building): a second start() joins it
    this.readyAt = 0;           // when the current process printed its ready line (0 = not yet)
    this.gaveUp = false;        // restarts used up; retry() is the way back
    this.stderrBudget = { windowAt: 0, used: 0, held: 0 };

    this.proc = null;
    this.startedAt = 0;         // when the current process was spawned, for the not-ready reason
    this.nextId = 1;
    this.pending = new Map();   // id -> {resolve, reject, timer, cmd}
    // Calls made while starting, waiting for the ready line: {cmd, timer, go, fail}.
    // ONE list released by _setStatus, not an EventEmitter listener per call, so
    // twenty calls at start-up add no listeners at all.
    this.readyWaiters = new Set();
    this.unawaited = new Set(); // ids sent without waiting for a reply (the quit)
    this.abandoned = new Map(); // id -> {cmd, gaveUpAt, timeoutMs}: callers that timed out
    this.shed = { expired: 0, late: 0, sinceReport: 0, lastCmd: null, reportedAt: 0 };
    this.stdoutBuf = '';
    this.stdoutScanFrom = 0;    // where the next newline search starts (the rest was searched)
    this.stdoutDropping = null; // {head, bytes}: an over-cap line being skipped up to its newline
    this.status = 'starting';
    this.reason = 'sidecar has not been started yet';
    this.info = null;           // {pid, passive, version} from the ready event
    this.restarts = 0;
    this.stopping = false;
    this.triedBuild = false;
    this.lastLog = null;        // the most recent {"ev":"log"} line, for reasons
    this._healthInit(arguments[0] || {});   // the liveness check's options (see _healthInit)
  }

  _setStatus(status, reason) {
    // Always emit, even when unchanged: main.js de-duplicates through State.set,
    // and a repeated reason is cheaper than a missed one.
    this.status = status;
    this.reason = reason;
    // Waiting calls go first -- they were asked before anything a 'status' or
    // 'ready' listener is about to send -- and before the emit, so a throwing
    // listener cannot strand them.
    if (status === 'ok') this._releaseWaiters(null);
    else if (status !== 'starting') this._releaseWaiters(reason);
    this.emit('status', { status, reason, info: this.info });
  }

  /**
   * Settle every call waiting for the ready line: send them all (failReason null,
   * the sidecar is ready) or refuse them all with that reason (it died or failed).
   */
  _releaseWaiters(failReason) {
    if (!this.readyWaiters.size) return;
    const waiters = [...this.readyWaiters];
    this.readyWaiters.clear();
    for (const w of waiters) {
      clearTimeout(w.timer);
      if (failReason === null) w.go();
      else w.fail(failReason);
    }
  }

  /**
   * Start (or restart) the sidecar. Never throws: a failure to start is a state,
   * not an exception -- the rest of Mantle has to keep running and say why the
   * window list is empty.
   */
  start() {
    // One sidecar at a time: a start() while one runs (or is being built) must not spawn a second
    // process -- it would hold its own keyboard hook and outlive this client (it watches our pid).
    if (this.proc) return Promise.resolve(true);
    if (this._startP) return this._startP;
    this._startP = this._start().finally(() => { this._startP = null; });
    return this._startP;
  }

  /**
   * The way back after the sidecar gave up restarting (or would not start): a fresh restart budget
   * and one more build attempt, then start(). Never during a quit. Resolves true once a process is
   * spawned (its ready line is still to come, as with start()), false with the reason in 'status'.
   */
  retry() {
    if (this.stopping && !this.proc) {
      this._setStatus('down', 'the sidecar was stopped because Mantle is shutting down; it starts with Mantle');
      return Promise.resolve(false);
    }
    if (this.proc) return Promise.resolve(true);
    clearTimeout(this._restartTimer);
    this.restarts = 0;
    this.gaveUp = false;
    this.triedBuild = false;
    return this.start();
  }

  async _start() {
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
      proc = this._spawn(this.exePath, [
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

    this._spawnCount += 1;
    this.proc = proc;
    this.startedAt = Date.now();
    this.readyAt = 0;
    this.stderrBudget = { windowAt: 0, used: 0, held: 0 };
    this.stdoutBuf = '';
    this.stdoutScanFrom = 0;
    this.stdoutDropping = null;
    this._setStatus('starting', 'sidecar started, waiting for its ready line' + (this._hungProc ? ' (restarted because the helper was not answering)' : ''));

    proc.stdout.setEncoding('utf8');
    // Every handler below is for THIS process only: a late line or exit from an older one must not
    // reach the next one's buffer, pending map or status.
    proc.stdout.on('data', (chunk) => { if (this.proc === proc) this._onStdout(chunk); });

    // A write to a sidecar that has just died (EPIPE) or whose stdin was ended
    // on the way out (ERR_STREAM_WRITE_AFTER_END) is reported as an 'error'
    // EVENT on the stream, not thrown -- and with no listener it becomes an
    // uncaught exception, which main answers by shutting all of Mantle down.
    // Seen 2026-09-22: the wallpaper's 1 s foreground check wrote after the
    // sidecar's stdin was ended during a quit. The request itself is rejected
    // by call()'s write callback; this listener only keeps the stream error
    // from escaping.
    proc.stdin.on('error', (err) => {
      this.lastLog = `sidecar stdin: ${err.message}`;
    });

    // stderr is not part of the protocol, but anything on it is a real complaint
    // and belongs in the reason string rather than in a log nobody reads.
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk) => { if (this.proc === proc) this._onStderr(chunk); });

    proc.on('error', (err) => {
      if (this.proc !== proc) return;
      this._setStatus('down', `sidecar process error: ${err.message}`);
    });

    proc.on('exit', (code, signal) => {
      if (this.proc !== proc) return;
      this._flushStderrHeld();
      this._healthStop();
      const how = this._hungProc === proc
        ? `was stopped because the helper is not answering (no reply to ${this.healthMisses} pings in a row)`
        : signal ? `killed by ${signal}` : `exited with code ${code}`;
      // Up long enough after its ready line: this crash is not part of a loop, full budget again.
      if (this.readyAt && Date.now() - this.readyAt >= this.stableMs) this.restarts = 0;
      this._failAllPending(`sidecar ${how} before answering`);
      this.proc = null;
      this.info = null;
      if (this.stopping) {
        this._setStatus('down', 'sidecar stopped because Mantle is shutting down');
        return;
      }
      this.emit('died', { code, signal });
      const tail = this.lastLog ? ` last it said: "${clip(this.lastLog, STDERR_LINE_MAX)}"` : '';
      if (this.restarts < MAX_RESTARTS) {
        this.restarts += 1;
        const delay = this.restartDelayMs * Math.pow(2, this.restarts - 1);
        this._setStatus('down', `sidecar ${how}; restarting in ${fmtMs(delay)} (attempt ${this.restarts} of ${MAX_RESTARTS}).${tail}`);
        this._restartTimer = setTimeout(() => { this.start(); }, delay);
        if (this._restartTimer.unref) this._restartTimer.unref();
      } else {
        this.gaveUp = true;
        this._setStatus('down', `sidecar ${how} and gave up after ${MAX_RESTARTS} restarts in a row; try again (retry) or restart Mantle, and if it keeps stopping run npm run build:sidecar.${tail}`);
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

    // No build script = an exe path someone chose on purpose (main.js's test-only
    // MANTLE_SIDECAR_EXE). Building would write into build.ps1's own output, not
    // there, so it is refused with the reason instead.
    if (!this.buildScript) {
      return { ok: false, reason: `sidecar down: no exe at ${rel(this.cwd, where)} (the MANTLE_SIDECAR_EXE override names it; Mantle never builds into an override path)` };
    }
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

  /** stderr: each line said (cut to STDERR_LINE_MAX), at most STDERR_LINES_PER_WINDOW per window. */
  _onStderr(chunk) {
    const now = Date.now();
    const b = this.stderrBudget;
    for (const raw of String(chunk).split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      this.lastLog = clip(line, STDERR_LINE_MAX);
      if (now - b.windowAt >= STDERR_WINDOW_MS) { this._flushStderrHeld(); b.windowAt = now; b.used = 0; }
      if (b.used >= STDERR_LINES_PER_WINDOW) { b.held += 1; continue; }
      b.used += 1;
      this.emit('log', { level: 'error', message: this.lastLog });
    }
  }

  /** Say how many stderr lines were held back, once (at the next window, or when it exits). */
  _flushStderrHeld() {
    const b = this.stderrBudget;
    if (!b || !b.held) return;
    const n = b.held;
    b.held = 0;
    this.emit('log', { level: 'error', message: `the sidecar printed ${n} more error line(s) in ${STDERR_WINDOW_MS / 1000} s; not logged one by one (the last: "${this.lastLog}")` });
  }

  _onStdout(chunk) {
    chunk = String(chunk);
    // The rest of an over-cap line (see the cap below): skip it up to its newline, then say
    // what was dropped. Its content is never parsed or logged (secreview 2026-09-27: before,
    // the tail parsed as "a line that is not JSON" and its first 200 characters - window
    // titles, file names - went to mantle.log, and the caller waited out its whole timeout).
    if (this.stdoutDropping) {
      const end = chunk.indexOf('\n');
      if (end === -1) { this.stdoutDropping.bytes += chunk.length; return; }
      this.stdoutDropping.bytes += end;
      const d = this.stdoutDropping;
      this.stdoutDropping = null;
      this._onOversized(d.head, d.bytes);
      chunk = chunk.slice(end + 1);
    }
    this.stdoutBuf += chunk;
    let nl;
    let from = this.stdoutScanFrom;
    while ((nl = this.stdoutBuf.indexOf('\n', from)) !== -1) {
      from = 0;
      const line = this.stdoutBuf.slice(0, nl).trim();
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch (err) {
        // A non-JSON line means the sidecar printed something it should not
        // have. Surface it rather than dropping it on the floor. A PROTOCOL line
        // that failed to parse (it starts with "{") can carry window titles or
        // file names, so only its shape is logged; a stray plain-text print is
        // the sidecar's own words and is shown.
        const what = line[0] === '{'
          ? `a broken protocol line (${line.length} chars${describeHead(line)}; its content is not logged)`
          : line.slice(0, 200);
        this.emit('log', { level: 'warn', message: `sidecar printed a line that is not JSON: ${what}` });
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
      // The traywatch spec spells it "event"; route it rather than lose it (main.js used to fish it
      // back out of the warning below).
      else if (msg && typeof msg.event === 'string' && /^[A-Za-z0-9_.:-]{1,40}$/.test(msg.event)) this._onEvent(Object.assign({}, msg, { ev: msg.event }));
      // Only its SHAPE is logged: its values can be window titles or file names (core-lib 2026-09-29).
      else this.emit('log', { level: 'warn', message: `sidecar sent an object with neither id nor ev (${line.length} chars, keys: ${describeKeys(msg)}; its content is not logged)` });
    }
    this.stdoutScanFrom = this.stdoutBuf.length;   // all of it was searched: no newline
    // A runaway sidecar printing without newlines must not eat all the memory.
    // The line is dropped up to its newline (stdoutDropping, above) and its
    // caller, if it was an answer, is told why at that point.
    if (this.stdoutBuf.length > MAX_LINE_CHARS) {
      this.stdoutDropping = { head: this.stdoutBuf.slice(0, 64), bytes: this.stdoutBuf.length };
      this.stdoutBuf = '';
      this.stdoutScanFrom = 0;
    }
  }

  /**
   * A line over MAX_LINE_CHARS was dropped. `head` is its first 64 characters,
   * enough for the protocol's leading key ({"id":N or {"ev":"name"), and nothing
   * past it is logged: the body is window titles, file names, OCR text.
   */
  _onOversized(head, chars) {
    const mb = (chars / (1024 * 1024)).toFixed(1);
    const cap = `over the ${MAX_LINE_CHARS / (1024 * 1024)} MB line cap`;
    const idm = /^\s*\{"id":(\d+)[,}]/.exec(head);
    if (idm) {
      const id = Number(idm[1]);
      const p = this.pending.get(id);
      if (p) {
        this.pending.delete(id);
        clearTimeout(p.timer);
        p.reject(new Error(`the sidecar's answer to "${p.cmd}" was ${mb} MB, ${cap}, so Mantle dropped it`));
        return;
      }
      const gone = this.abandoned.get(id);
      if (gone) this.abandoned.delete(id);
      this.emit('log', { level: 'warn', message: `sidecar sent an answer of ${mb} MB (id ${id}${gone ? `, "${gone.cmd}", whose caller had already timed out` : ''}), ${cap}; dropped it (its content is not logged)` });
      return;
    }
    this.emit('log', { level: 'warn', message: `sidecar sent a line of ${mb} MB${describeHead(head)}, ${cap}; dropped it (its content is not logged)` });
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
      const gone = this.abandoned.get(msg.id);
      if (gone) {
        this.abandoned.delete(msg.id);
        if (msg.ok === false && msg.reason === 'expired') {
          // The load shedding working as designed: the caller already got its
          // timeout error (and said so), and the sidecar did not do the work.
          // Counted, and summarised now and then rather than once per id.
          this.shed.expired += 1;
          this.shed.sinceReport += 1;
          this.shed.lastCmd = gone.cmd;
          const now = Date.now();
          if (now - this.shed.reportedAt >= SHED_REPORT_MS) {
            this.emit('log', {
              level: 'warn',
              message: `the sidecar skipped ${this.shed.sinceReport} request(s) whose caller had already timed out (latest: "${gone.cmd}"); it is shedding load rather than falling behind`,
            });
            this.shed.reportedAt = now;
            this.shed.sinceReport = 0;
          }
          return;
        }
        // Real work that finished after its caller gave up: worth a line,
        // with how late, because it means a lane is slower than its callers.
        this.shed.late += 1;
        this.emit('log', {
          level: 'warn',
          message: `the sidecar answered "${gone.cmd}" (id ${msg.id}) ${Date.now() - gone.gaveUpAt} ms after its ${gone.timeoutMs} ms timeout; the answer was dropped`,
        });
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
      // The restart budget resets once this process has stayed up STABLE_MS (see the exit handler),
      // not here: a sidecar that crashes right after every ready line must still give up.
      this.readyAt = Date.now();
      this.gaveUp = false;
      this.info = { pid: msg.pid, passive: !!msg.passive, version: msg.version };
      this._setStatus('ok', `sidecar ${msg.version || '(no version)'} running as pid ${msg.pid}${msg.passive ? ', passive: it will refuse to change the shell' : ''}`);
      this._healthStart(this.proc);
    } else if (msg.ev === 'log') {
      this.lastLog = clip(String(msg.message || ''), STDERR_LINE_MAX);
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
   * the bar and the launcher put that message straight on screen. While the
   * sidecar is starting it waits for the ready line first (_callWhenReady).
   */
  call(cmd, args = {}, timeoutMs = CALL_TIMEOUT_MS) {
    // A timeout that is not a usable number (NaN, 0, negative) fired at once, and one past
    // setTimeout's ceiling fired at once with a warning: the default, and the ceiling, instead.
    if (!(typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0)) timeoutMs = CALL_TIMEOUT_MS;
    else if (timeoutMs > MAX_TIMEOUT_MS) timeoutMs = MAX_TIMEOUT_MS;
    // A process that has not printed its ready line yet is worth waiting for;
    // no process, or a failed/down one, is not.
    const starting = !!this.proc && this.status === 'starting';
    if (!starting) {
      const blocked = this.blockedReason();
      if (blocked) return Promise.reject(new Error(`cannot run "${cmd}": ${blocked}`));
    }

    // `id` and `cmd` are the PROTOCOL's own keys. An argument with either name
    // silently overwrote them: tray.click sent {id: <tray icon id>}, its reply
    // came back under the icon's id, was dropped as unknown, and the bar showed
    // a timeout for a click that had worked (2026-09-22). Refuse, loudly.
    if (args && (Object.prototype.hasOwnProperty.call(args, 'id') || Object.prototype.hasOwnProperty.call(args, 'cmd'))) {
      return Promise.reject(new Error(`cannot run "${cmd}": its arguments use the reserved key "${Object.prototype.hasOwnProperty.call(args, 'id') ? 'id' : 'cmd'}", which would overwrite the request's own; rename it (trayClick takes icon)`));
    }
    if (starting) {
      // Refuse arguments that can never be sent NOW, not after the wait.
      try { JSON.stringify(args); } catch (err) {
        return Promise.reject(new Error(`cannot run "${cmd}": its arguments are not JSON (${err.message})`));
      }
      return this._callWhenReady(cmd, args, timeoutMs);
    }
    return this._send(cmd, args, timeoutMs, timeoutMs);
  }

  /**
   * call() while the sidecar is starting: wait for the ready line, bounded by
   * readyWaitMs AND the caller's own timeout, whichever is shorter.
   *
   * ttl: once ready, the request is sent with the time the caller has LEFT
   * (timeoutMs minus the wait) as both its ttl and its answer timer. The caller
   * never waits longer in total than the timeout it asked for, and the sidecar's
   * "expired" check measures against the moment that caller really gives up.
   */
  _callWhenReady(cmd, args, timeoutMs) {
    const total = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : CALL_TIMEOUT_MS;
    const callerIsShorter = total <= this.readyWaitMs;
    const since = Date.now();
    return new Promise((resolve, reject) => {
      const w = { cmd, timer: null };
      w.go = () => {
        const left = total - (Date.now() - since);
        if (left <= 0) {
          reject(new Error(`the sidecar did not answer "${cmd}" within ${fmtMs(total)}: it only finished starting as the time ran out`));
          return;
        }
        resolve(this._send(cmd, args, total, left));
      };
      w.fail = (reason) => reject(new Error(`cannot run "${cmd}": ${reason}`));
      w.timer = setTimeout(() => {
        if (!this.readyWaiters.delete(w)) return;   // already released
        if (callerIsShorter) {
          reject(new Error(`the sidecar did not answer "${cmd}" within ${fmtMs(total)}: it had not finished starting (no ready line yet)`));
          return;
        }
        const tail = this.lastLog ? ` last it said: "${this.lastLog}"` : '';
        reject(new Error(`cannot run "${cmd}": the sidecar was started ${fmtMs(Date.now() - this.startedAt)} ago and has still not printed its ready line, so it may be hung starting up.${tail}`));
      }, callerIsShorter ? total : this.readyWaitMs);
      if (w.timer.unref) w.timer.unref();
      this.readyWaiters.add(w);
    });
  }

  /**
   * Put one request on the wire. `timeoutMs` is the caller's whole budget (for
   * the words); `leftMs` is what remains of it now (the ttl and the timer).
   */
  _send(cmd, args, timeoutMs, leftMs) {
    const id = this.takeId();
    // ttl goes FIRST so an explicit args.ttl (a test forcing a deadline) wins.
    const payload = Object.assign({ id, cmd, ttl: leftMs }, args);
    let line;
    try {
      line = JSON.stringify(payload) + '\n';
    } catch (err) {
      return Promise.reject(new Error(`cannot run "${cmd}": its arguments are not JSON (${err.message})`));
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.abandoned.set(id, { cmd, gaveUpAt: Date.now(), timeoutMs });
        if (this.abandoned.size > ABANDONED_MAX) {
          // Maps iterate in insertion order: drop the oldest.
          this.abandoned.delete(this.abandoned.keys().next().value);
        }
        reject(new Error(`the sidecar did not answer "${cmd}" within ${Math.round(timeoutMs / 1000)}s`));
      }, leftMs);
      if (timer.unref) timer.unref();
      const stdin = this.proc && this.proc.stdin;
      if (!stdin || stdin.destroyed || stdin.writableEnded) {
        clearTimeout(timer);
        reject(new Error(`could not send "${cmd}" to the sidecar: it is not running (stopped, or restarting)`));
        return;
      }
      this.pending.set(id, { resolve, reject, timer, cmd });
      const failed = (err) => {
        if (!this.pending.has(id)) return;   // answered or timed out already
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new Error(`could not send "${cmd}" to the sidecar: ${err.message}`));
      };
      try {
        stdin.write(line, 'utf8', (err) => { if (err) failed(err); });
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new Error(`could not send "${cmd}" to the sidecar: ${err.message}`));
      }
    });
  }

  /** The next request id. Past MAX_SAFE_INTEGER (never in practice, but ids must stay exact
   * integers on both sides) they start again at 1, skipping any still waiting. */
  takeId() {
    if (!(this.nextId >= 1 && this.nextId < Number.MAX_SAFE_INTEGER)) this.nextId = 1;
    let id = this.nextId++;
    while (this.pending.has(id) || this.unawaited.has(id)) id = this.nextId++;
    if (this.nextId > Number.MAX_SAFE_INTEGER) this.nextId = 1;
    return id;
  }

  _failAllPending(reason) {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`${reason} (command "${p.cmd}")`));
    }
    this.pending.clear();
    // A new process never answers the old one's ids.
    this.abandoned.clear();
  }

  /**
   * Shut down. Closing stdin is the documented kill switch: the sidecar sees EOF
   * and undoes everything it changed before it exits. We ask politely first and
   * only then kill, because a killed sidecar still restores (it watches the
   * parent pid) but the polite path is the one we can reason about.
   */
  stop() {
    this.stopping = true;
    this._healthStop();
    clearTimeout(this._restartTimer);
    const proc = this.proc;
    if (!proc) return;
    const quitId = this.takeId();
    this.unawaited.add(quitId);
    try { proc.stdin.write(JSON.stringify({ id: quitId, cmd: 'quit' }) + '\n'); } catch (_) { /* already gone */ }
    try { proc.stdin.end(); } catch (_) { /* already gone */ }
    const killer = setTimeout(() => { try { proc.kill(); } catch (_) {} }, 1500);
    if (killer.unref) killer.unref();
  }

  // ------------------------------------------------------------------ the liveness check
  //
  // Audit #11 (2026-10-12). Kept in its own methods: the only hooks elsewhere are one line in the
  // constructor, one after the ready line, one in stop() and the exit handler's reason.
  //
  // Why `ping` cannot false-positive on a busy helper: the sidecar runs ping on its ui lane
  // (sidecar/Lanes.cs: anything unlisted runs on ui), and slow work is kept OFF that lane by design
  // (Wi-Fi/Bluetooth switches on qs, wlan scans and connects on their own pool threads, icons and
  // launches on slow, window verbs on focus, captures on capture). A full ui queue answers "busy",
  // which counts as an answer here. Only total silence for ~healthMisses intervals ends it.

  /**
   * Options, all TEST SEAMS with production defaults (main.js passes none outside --test):
   *   healthMs        (15000) ping interval; 0 = the check is off
   *   healthTimeoutMs  (3000) no answer within this = one miss
   *   healthMisses        (3) misses in a row that end the process
   */
  _healthInit(o) {
    const num = (v, d, min) => (Number.isFinite(v) && v >= min ? v : d);
    this.healthMs = num(o.healthMs, HEALTH_MS, 0);
    this.healthTimeoutMs = num(o.healthTimeoutMs, HEALTH_TIMEOUT_MS, 1);
    this.healthMisses = Math.floor(num(o.healthMisses, HEALTH_MISSES, 1));
    this._health = null;        // the running check: {proc, timer, missTimer, misses, inFlight, ...}
    this._hungProc = null;      // the process the check ended, so its exit reason says why
    this.healthKills = 0;       // processes ended for not answering, for the tests
  }

  /** After a ready line: one interval timer for THIS process (unref'd: it never keeps Mantle up). */
  _healthStart(proc) {
    this._healthStop();
    this._hungProc = null;
    if (!(this.healthMs > 0) || !proc) return;
    const h = { proc, timer: null, missTimer: null, misses: 0, inFlight: false, counted: false, seq: 0, lastTickAt: Date.now(), gaps: 0 };
    h.timer = setInterval(() => this._healthTick(h), this.healthMs);
    if (h.timer.unref) h.timer.unref();
    this._health = h;
  }

  _healthStop() {
    const h = this._health;
    if (!h) return;
    this._health = null;
    clearInterval(h.timer);
    clearTimeout(h.missTimer);
  }

  _healthTick(h) {
    if (this._health !== h) return;
    if (this.stopping || this.proc !== h.proc) { this._healthStop(); return; }
    const now = Date.now();
    const gap = now - h.lastTickAt;
    h.lastTickAt = now;
    // Timers jump after sleep/resume (or a stalled event loop): a gap far past the interval says
    // nothing about the helper, so the count starts again and this tick is not counted.
    if (gap > this.healthMs * 3) {
      h.misses = 0;
      h.counted = true;           // a ping in flight across the gap is not held against it
      h.gaps += 1;
      return;
    }
    if (this.status !== 'ok') return;
    if (h.inFlight) {             // never two in flight: still silent a whole interval later = a miss
      h.counted = true;
      this._healthMiss(h);
      return;
    }
    this._healthPing(h);
  }

  _healthPing(h) {
    const seq = ++h.seq;
    const sentAt = Date.now();
    // The call's own limit is long on purpose: a reply after healthTimeoutMs still arrives and
    // resets the count (a late answer is an answer); the process is ended long before this.
    const limit = this.healthMs * (this.healthMisses + 1) + this.healthTimeoutMs;
    h.inFlight = true;
    h.counted = false;
    clearTimeout(h.missTimer);
    h.missTimer = setTimeout(() => {
      if (this._health !== h || h.seq !== seq || !h.inFlight || h.counted) return;
      h.counted = true;
      // Fired far past its time: the machine slept (or Mantle stalled) with it set, not the helper.
      if (Date.now() - sentAt > this.healthTimeoutMs * 3) return;
      this._healthMiss(h);
    }, this.healthTimeoutMs);
    if (h.missTimer.unref) h.missTimer.unref();
    const done = (answered) => {
      if (h.seq !== seq) return;
      h.inFlight = false;
      clearTimeout(h.missTimer);
      if (answered) h.misses = 0;
    };
    let p;
    try { p = this.call('ping', {}, limit); } catch (err) { p = Promise.reject(err); }
    p.then(() => done(true), (err) => {
      // An error REPLY ("busy": the ui queue is full) is still the helper reading and answering.
      // A timeout, a failed send or the process ending is not.
      const proc = h.proc;
      done(Date.now() - sentAt < limit - 50 && this.proc === proc && this._hungProc !== proc &&
        proc.exitCode === null && proc.signalCode === null && !/could not send/.test(String(err && err.message)));
    });
  }

  _healthMiss(h) {
    h.misses += 1;
    if (h.misses >= this.healthMisses) this._healthKill(h);
  }

  /** End a helper that stopped answering; its 'exit' then runs the normal restart / give-up path. */
  _healthKill(h) {
    const proc = h.proc;
    this._healthStop();
    if (this.proc !== proc || this.stopping) return;
    this._hungProc = proc;
    this.healthKills += 1;
    const n = h.misses;
    this.emit('log', {
      level: 'warn',
      message: `the sidecar (pid ${proc.pid}) did not answer ${n} pings in a row (${fmtMs(this.healthMs)} apart, ${fmtMs(this.healthTimeoutMs)} limit each): it is running but not answering, so Mantle is ending it and the usual restart follows`,
    });
    this._setStatus('down', `the helper is not answering (no reply to ${n} pings in a row); stopping it so it restarts`);
    try { proc.kill(); } catch (_) { /* reported below if it does not go */ }
    const check = setTimeout(() => {
      if (this.proc === proc && proc.exitCode === null && proc.signalCode === null) {
        this._setStatus('down', `the helper is not answering and Mantle could not end it (pid ${proc.pid}); restart Mantle, or end Mantle.Sidecar.exe in Task Manager`);
      }
    }, 5000);
    if (check.unref) check.unref();
  }
}

/** "a, b, c" of an object's first keys (names only, each cut), for a shape-only log line. */
function describeKeys(msg) {
  if (!msg || typeof msg !== 'object') return typeof msg;
  const keys = Object.keys(msg);
  const shown = keys.slice(0, 5).map((k) => clip(k.replace(/[^A-Za-z0-9_.:-]/g, '?'), 24));
  return (shown.join(', ') || 'none') + (keys.length > 5 ? `, +${keys.length - 5} more` : '');
}

/** A duration for words: "300 ms" under a second, else whole seconds like the timeout text. */
function fmtMs(ms) {
  return ms < 1000 ? `${Math.max(0, Math.round(ms))} ms` : `${Math.round(ms / 1000)}s`;
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

module.exports = { Sidecar, runPowerShell, READY_WAIT_MS };

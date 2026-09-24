'use strict';
/*
 * call-log.js - what main.js writes to the log about mantle:call results (qsx lane, 2026-09-23).
 *
 * createCallLog - A REPEATED FAILURE IS ONE LINE. The mantle:call logger wrote a line for every
 * ok:false result, and ui/desktop/desktop.js asks net.probe about Mission Control on
 * 127.0.0.1:7373 every 30 s, so on 1c6afe3 the log gained 436 identical "net.probe ... ->
 * ECONNREFUSED" lines in a morning (2,608 overall) and everything else was buried under them.
 * Now a failure is written once per command + arguments, the same failure again is only counted,
 * a DIFFERENT reason is written with how often the previous one repeated, and the first success
 * after a failure is written as a recovery with the count. Nothing is lost: every failure is a
 * line or a number on a later line.
 *
 * createSetLog - A BUTTON PRESS IS ALWAYS A LINE. qs.set is Owen changing something, and until
 * this was written it was never logged at all, so a switch that did nothing left no trace. Every
 * attempt is written with its result and latency - except the stream of successful sets from a
 * dragged slider (one every 3-60 ms), whose first set is written at once and whose rest are
 * summed up on one line when the drag stops: 40 identical lines a second would bury the log again.
 * A failure is always its own line, at once, even in the middle of a drag.
 */

const MAX_ARGS = 120;

function short(v, n) {
  const s = String(v);
  return s.length > (n || 80) ? s.slice(0, (n || 80) - 1) + '…' : s;
}

function createCallLog(opts) {
  const write = opts.write;
  const skip = opts.skip || (() => false);
  const maxKeys = opts.maxKeys || 200;
  const open = new Map();          // key -> { reason, repeats }; oldest first

  const keyOf = (name, args) => name + (args && Object.keys(args).length ? ' ' + JSON.stringify(args).slice(0, MAX_ARGS) : '');

  function failed(name, args, reason, always) {
    if (!always && skip(name)) return;
    const key = keyOf(name, args);
    const prev = open.get(key);
    if (prev && prev.reason === reason) { prev.repeats++; return; }
    if (prev) {
      write(`mantle: ${key} -> ${reason} (before this, "${short(prev.reason)}" failed ${prev.repeats + 1} time(s) in a row)`);
      open.delete(key);
    } else {
      write(`mantle: ${key} -> ${reason}`);
    }
    open.set(key, { reason, repeats: 0 });
    while (open.size > maxKeys) open.delete(open.keys().next().value);
  }

  function succeeded(name, args) {
    if (!open.size) return;
    const key = keyOf(name, args);
    const prev = open.get(key);
    if (!prev) return;
    open.delete(key);
    write(`mantle: ${key} recovered after ${prev.repeats + 1} failure(s) in a row (the last: ${short(prev.reason, 160)})`);
  }

  return {
    /** A command's answer: ok:false is a failure, anything else a success. */
    result(name, args, res) {
      if (res && typeof res === 'object' && res.ok === false) failed(name, args, res.reason || 'ok:false, no reason given');
      else succeeded(name, args);
    },
    /** A command that threw is always a failure worth a line, skipped or not (as before). */
    threw(name, args, err) {
      failed(name, args, 'threw: ' + (err && err.message ? err.message : String(err)), true);
    },
    /** For the tests: how many failures are being held quiet. */
    openCount: () => open.size,
  };
}

function fmt(v) {
  if (v === undefined) return '(none)';
  if (typeof v === 'string') return JSON.stringify(v);
  return String(v);
}

function createSetLog(opts) {
  const write = opts.write;
  const quietMs = opts.quietMs || 750;
  const setT = opts.setTimeout || setTimeout;
  const clearT = opts.clearTimeout || clearTimeout;
  const sliders = new Set(opts.sliders || ['volume', 'brightness']);
  const bursts = new Map();        // part -> { n, minMs, maxMs, lastValue, lastRead, timer }

  function line(part, value, reply, ms) {
    const r = reply || {};
    const res = r.ok ? `ok, reads ${fmt(r.value)}` : `NOT DONE: ${r.reason || 'no reason given'}`;
    return `mantle: qs.set ${part}=${fmt(value)} -> ${res} (${ms} ms)`;
  }

  function flush(part) {
    const b = bursts.get(part);
    if (!b) return;
    bursts.delete(part);
    if (b.timer) clearT(b.timer);
    if (b.n > 0) {
      write(`mantle: qs.set ${part}: ${b.n} more while it was dragged, the last ${fmt(b.lastValue)} ` +
            `(reads ${fmt(b.lastRead)}), all ok, ${b.minMs}-${b.maxMs} ms each`);
    }
  }

  return {
    record(part, value, reply, ms) {
      const ok = !!(reply && reply.ok);
      if (!sliders.has(part) || !ok) {
        flush(part);
        write(line(part, value, reply, ms));
        return;
      }
      let b = bursts.get(part);
      if (!b) {
        write(line(part, value, reply, ms));
        b = { n: 0, minMs: Infinity, maxMs: 0, lastValue: null, lastRead: null, timer: null };
        bursts.set(part, b);
      } else {
        b.n++;
        b.minMs = Math.min(b.minMs, ms);
        b.maxMs = Math.max(b.maxMs, ms);
        b.lastValue = value;
        b.lastRead = reply.value;
      }
      if (b.timer) clearT(b.timer);
      b.timer = setT(() => { b.timer = null; flush(part); }, quietMs);
      if (b.timer && typeof b.timer.unref === 'function') b.timer.unref();
    },
    flushAll() { for (const part of Array.from(bursts.keys())) flush(part); },
  };
}

module.exports = { createCallLog, createSetLog };

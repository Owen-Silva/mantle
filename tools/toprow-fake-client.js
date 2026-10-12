#!/usr/bin/env node
'use strict';
/*
 * toprow-fake-client.js -- a tiny client of the look-sync top-row hints protocol (v1), for tests and
 * latency measurement. Spec: ~/look-sync/CONTRACT.md, "Top-row hints (v1)". Receiver: lib/toprow-hints.js.
 *
 * Usage:
 *   node tools/toprow-fake-client.js [--pipe NAME] --app quartz|helm --hwnd N --top JSON [--hold MS|forever] [--wait MS]
 *       Sends one hint. Mantle forgets a hint when its client disconnects, so --hold keeps the
 *       connection open MS ms (or until Ctrl+C with "forever"); the default 0 sends and disconnects.
 *       --wait MS: keep trying to connect for up to MS ms (default 0: one try). Exit 2 = no server.
 *   node tools/toprow-fake-client.js [--pipe NAME] --raw LINE [--hold MS] [--wait MS]
 *       Sends LINE as it is (no envelope, no JSON check): the receiver's refusals are tested with it.
 *   node tools/toprow-fake-client.js [--pipe NAME] --app quartz|helm --hwnd N --stdin
 *       Line mode. Each stdin line is a TOP JSON (sent for the current hwnd), or "hwnd N" to switch
 *       window, or "app quartz|helm" to switch app. Prints "sent <wall ms> <seq>" per message written
 *       (wall ms = performance.timeOrigin + performance.now(), 0.1 ms), "dropped <seq> (no server)"
 *       when not connected. Reconnects at most once per 2 s; on connect it re-sends the latest TOP of
 *       every hwnd, as the apps do. EOF on stdin disconnects and exits.
 *
 *   --pipe  a full \\.\pipe\name or a bare name (default look-sync-toprow, the live Mantle's). A test
 *           Mantle listens on look-sync-toprow-test-<profile>.
 *   TOP     {"kind":"wash","rgb":[r,g,b],"alpha":a} | {"kind":"flat","rgb":[r,g,b]}
 *           | {"kind":"cols","cols":[[r,g,b],...]} | {"kind":"none"}
 *
 * Never throws when no server is listening.
 */
const net = require('net');
const readline = require('readline');
const { performance } = require('perf_hooks');

const RECONNECT_MS = 2000;

function args(argv) {
  const a = { pipe: 'look-sync-toprow', app: 'quartz', hwnd: null, top: null, raw: null, hold: 0, wait: 0, stdin: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i], v = argv[i + 1];
    if (k === '--pipe') { a.pipe = v; i++; }
    else if (k === '--app') { a.app = v; i++; }
    else if (k === '--hwnd') { a.hwnd = v; i++; }
    else if (k === '--top') { a.top = v; i++; }
    else if (k === '--raw') { a.raw = v; i++; }
    else if (k === '--hold') { a.hold = v === 'forever' ? Infinity : Number(v) || 0; i++; }
    else if (k === '--wait') { a.wait = Number(v) || 0; i++; }
    else if (k === '--stdin') a.stdin = true;
    else if (k === '-h' || k === '--help') a.help = true;
  }
  return a;
}
function pipePath(name) { return !name ? '\\\\.\\pipe\\look-sync-toprow' : name.startsWith('\\\\') ? name : '\\\\.\\pipe\\' + name; }
const wall = () => (performance.timeOrigin + performance.now()).toFixed(1);

function makeConn(pipe, onConnect) {
  let sock = null, up = false, lastTry = 0, timer = null, closed = false;
  function tryConnect() {
    if (closed || sock) return;
    const wait = lastTry + RECONNECT_MS - Date.now();
    if (lastTry && wait > 0) { if (!timer) timer = setTimeout(() => { timer = null; tryConnect(); }, wait); return; }
    lastTry = Date.now();
    let s;
    try { s = net.connect(pipe); } catch (_) { schedule(); return; }
    sock = s;
    s.on('connect', () => { up = true; try { onConnect(); } catch (_) { /* never throw */ } });
    s.on('error', () => { /* no server, or it went away: close follows */ });
    s.on('close', () => { up = false; sock = null; schedule(); });
  }
  function schedule() { if (!closed && !timer) timer = setTimeout(() => { timer = null; tryConnect(); }, Math.max(0, lastTry + RECONNECT_MS - Date.now())); }
  return {
    start: tryConnect,
    get up() { return up; },
    write(line, cb) { if (!up || !sock) return false; try { sock.write(line, cb); return true; } catch (_) { return false; } },
    close() { closed = true; if (timer) clearTimeout(timer); timer = null; if (sock) { try { sock.end(); } catch (_) { /* gone */ } } },
  };
}

function main() {
  const a = args(process.argv.slice(2));
  if (a.help || (!a.hwnd && a.raw == null) || (!a.stdin && !a.top && a.raw == null)) {
    process.stdout.write('usage: node tools/toprow-fake-client.js [--pipe NAME] --app quartz|helm --hwnd N (--top JSON [--hold MS|forever] [--wait MS] | --stdin)\n');
    process.exitCode = a.help ? 0 : 1;
    return;
  }
  const pipe = pipePath(a.pipe);
  const seqs = new Map(), latest = new Map();   // hwnd -> seq ; hwnd -> {app, top}
  let app = a.app, hwnd = String(a.hwnd);
  const nextSeq = (h) => { const s = (seqs.get(h) || 0) + 1; seqs.set(h, s); return s; };
  const line = (h, ap, top, seq) => JSON.stringify({ v: 1, app: ap, hwnd: h, seq, t: Date.now(), top }) + '\n';

  if (!a.stdin) {
    let top;
    if (a.raw == null) try { top = JSON.parse(a.top); } catch (e) { process.stderr.write(`--top is not JSON: ${e.message}\n`); process.exitCode = 1; return; }
    const t0 = Date.now();
    let sent = false;
    const conn = makeConn(pipe, () => {
      if (sent) return;
      sent = true;
      const seq = nextSeq(hwnd);
      conn.write(a.raw != null ? a.raw + '\n' : line(hwnd, app, top, seq), () => {
        process.stdout.write(`sent ${wall()} ${seq}\n`);
        if (a.hold === Infinity) return;
        setTimeout(() => { conn.close(); }, a.hold);
      });
    });
    conn.start();
    const giveUp = setInterval(() => {
      if (sent) { clearInterval(giveUp); return; }
      if (Date.now() - t0 >= a.wait) { clearInterval(giveUp); conn.close(); process.stdout.write(`no server on ${pipe}\n`); process.exitCode = 2; }
    }, 50);
    return;
  }

  const conn = makeConn(pipe, () => {
    // on (re)connect, re-send the latest look of every window, as the apps do
    for (const [h, v] of latest) {
      const seq = nextSeq(h);
      conn.write(line(h, v.app, v.top, seq), () => process.stdout.write(`sent ${wall()} ${seq}\n`));
    }
  });
  conn.start();
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (l) => {
    const s = l.trim();
    if (!s) return;
    let m;
    if ((m = /^hwnd\s+(\d+)$/i.exec(s))) { hwnd = m[1]; return; }
    if ((m = /^app\s+(quartz|helm)$/i.exec(s))) { app = m[1].toLowerCase(); return; }
    let top;
    try { top = JSON.parse(s); } catch (e) { process.stdout.write(`not JSON: ${e.message}\n`); return; }
    if (top && top.kind === 'none') latest.delete(hwnd); else latest.set(hwnd, { app, top });
    const seq = nextSeq(hwnd);
    const ok = conn.write(line(hwnd, app, top, seq), () => process.stdout.write(`sent ${wall()} ${seq}\n`));
    if (!ok) process.stdout.write(`dropped ${seq} (no server)\n`);
  });
  rl.on('close', () => { setTimeout(() => conn.close(), 50); });
}

try { main(); } catch (e) { process.stderr.write(`toprow-fake-client: ${e && e.message ? e.message : e}\n`); process.exitCode = 1; }

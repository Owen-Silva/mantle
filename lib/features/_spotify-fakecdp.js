'use strict';
/* _spotify-fakecdp.js - a FAKE Spotify desktop app for the tests (spotapp lane, 2026-09-25). Test-only;
 * never loaded as a feature (the leading underscore). Used by spotify-app.test.js and spotify.test.js.
 *
 * It is a local HTTP + WebSocket server shaped like Chromium's debugging port: GET /json/list lists
 * one page (https://xpui.app.spotify.com/index.html), and its socket answers Runtime.evaluate by
 * RUNNING the expression in a node:vm context that looks like Spotify's page: a React root whose
 * context value is a Platform with getRegistry().resolve(Symbol.for('PlayerAPI')) and
 * getGraphQLLoader(), and an rspackChunk runtime. So the real PAGE() code runs against it.
 * Nothing here talks to the real Spotify.
 */
const http = require('http');
const crypto = require('crypto');
const vm = require('vm');

const uri = (n) => 'spotify:track:' + String(n).padStart(22, 'A').slice(-22);
function track(n, extra) {
  return Object.assign({ uri: uri(n), uid: 'u' + n, name: 'Song ' + n, artists: [{ name: 'Artist ' + n }, { name: 'Feat ' + n }],
    images: [{ url: 'spotify:image:ab67616d0000b273' + String(n).padStart(24, '0'), label: 'standard' },
      { url: 'spotify:image:ab67616d00004851' + String(n).padStart(24, '0'), label: 'small' }], metadata: {} }, extra || {});
}

function createFakeSpotify(opts) {
  const o = Object.assign({ port: 0, internals: true, search: 'bundle', skipToThrows: false, stuck: false, pageUrl: 'https://xpui.app.spotify.com/index.html' }, opts || {});
  const F = {
    calls: [], evals: 0, expressions: [], sockets: new Set(), server: null, port: 0, opts: o,
    q: { current: track(1), queued: [track(2, { provider: 'queue' }), track(3, { provider: 'queue' })], nextUp: [track(10), track(11), track(12)] },
    searchHash: 'a'.repeat(64), loaderCalls: [],
  };
  const all = () => F.q.queued.concat(F.q.nextUp);
  const key = (x) => x.uid || x.uri;
  const player = {
    getQueue() { F.calls.push(['getQueue']); return Promise.resolve(JSON.parse(JSON.stringify(F.q))); },
    addToQueue(items) { F.calls.push(['addToQueue', items]); for (const it of items) F.q.queued.push(track(99, { uri: it.uri, uid: 'q' + F.calls.length, name: 'Added', provider: 'queue' })); return Promise.resolve(); },
    removeFromQueue(items) {
      F.calls.push(['removeFromQueue', items]);
      for (const it of items) for (const k of ['queued', 'nextUp']) F.q[k] = F.q[k].filter((x) => !(it.uid ? x.uid === it.uid : x.uri === it.uri));
      return Promise.resolve();
    },
    reorderQueue(items, where) {
      F.calls.push(['reorderQueue', items, where]);
      const it = items[0];
      const i = F.q.queued.findIndex((x) => x.uid === it.uid);
      const moved = F.q.queued.splice(i, 1)[0];
      const ref = where.before || where.after;
      const j = F.q.queued.findIndex((x) => x.uid === ref.uid);
      F.q.queued.splice(where.before ? j : j + 1, 0, moved);
      return Promise.resolve();
    },
    skipTo(ref) {
      F.calls.push(['skipTo', ref]);
      if (o.skipToThrows) return Promise.reject(new Error('Cannot read properties of undefined (reading \'track\')'));
      const list = all();
      const i = list.findIndex((x) => key(x) === key(ref));
      if (i < 0) return Promise.resolve();
      F.q.current = list[i];
      const qn = F.q.queued.length;
      if (i < qn) F.q.queued = F.q.queued.slice(i + 1); else { F.q.queued = []; F.q.nextUp = F.q.nextUp.slice(i - qn + 1); }
      return Promise.resolve();
    },
    skipToNext() {
      F.calls.push(['skipToNext']);
      const next = F.q.queued.length ? F.q.queued.shift() : F.q.nextUp.shift();
      if (next) F.q.current = next;
      return Promise.resolve();
    },
  };
  const loader = (def, vars) => {
    F.loaderCalls.push({ def: JSON.parse(JSON.stringify(def)), vars: JSON.parse(JSON.stringify(vars)) });
    if (o.search === 'broken') return Promise.resolve({ errors: [{ message: 'PersistedQueryNotFound' }] });
    return Promise.resolve({ data: { searchV2: { tracksV2: { items: [30, 31, 32].map((n) => ({ item: { data: {
      uri: uri(n), name: 'Found ' + n + ' for ' + vars.searchTerm, artists: { items: [{ profile: { name: 'Band ' + n } }] },
      albumOfTrack: { coverArt: { sources: [{ url: 'https://i.scdn.co/image/ab67616d00004851' + String(n).padStart(24, '0'), width: 64 }, { url: 'https://i.scdn.co/image/ab67616d0000b273' + String(n).padStart(24, '0'), width: 640 }] } } } } })) } } } });
  };
  function makeContext() {
    const platform = {
      version: '1.3.0.277',
      getRegistry() { return { resolve(sym) { return o.internals && sym === Symbol.for('PlayerAPI') ? player : null; } }; },
      getGraphQLLoader() { return loader; },
    };
    const leaf = { memoizedProps: { className: 'x' }, child: null, sibling: null };
    const provider = { memoizedProps: { value: o.internals === 'none' ? { unrelated: true } : platform, children: {} }, child: leaf, sibling: null };
    const root = { memoizedProps: null, child: { memoizedProps: { a: 1 }, child: provider, sibling: null }, sibling: null };
    const main = { __reactContainer$fake: root };
    const factories = { 1: function () { return 'nothing'; } };
    if (o.search === 'bundle') factories[2] = new Function('return new E.l("searchTracks","query","' + F.searchHash + '",null)');
    const sandbox = {
      document: { getElementById: (id) => (id === 'main' ? main : null), body: { children: [] }, querySelectorAll: () => [] },
      navigator: { userAgent: 'Mozilla/5.0 Chrome/146.0.7680.179 Spotify/1.3.0.277' },
      rspackChunk: { push(arr) { const cb = arr[2]; if (typeof cb === 'function') return cb({ m: factories }); return undefined; } },
    };
    sandbox.globalThis = sandbox;
    F.sandbox = sandbox;
    return vm.createContext(sandbox);
  }
  let context = makeContext();
  F.reload = () => { context = makeContext(); };    // Spotify's page reloaded: the cache is gone

  async function evaluate(expr) {
    F.evals++;
    F.expressions.push(expr);
    try {
      const v = await vm.runInContext(expr, context, { timeout: 2000 });
      return { result: { type: typeof v, value: JSON.parse(JSON.stringify(v === undefined ? null : v)) } };
    } catch (e) {
      return { result: { type: 'object', subtype: 'error' }, exceptionDetails: { text: 'Uncaught', exception: { description: String(e && e.message) } } };
    }
  }

  /* ---------------- a minimal RFC 6455 server (text frames, close, ping) */
  function frame(text) {
    const b = Buffer.from(text, 'utf8');
    let head;
    if (b.length < 126) head = Buffer.from([0x81, b.length]);
    else if (b.length < 65536) { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 126; head.writeUInt16BE(b.length, 2); }
    else { head = Buffer.alloc(10); head[0] = 0x81; head[1] = 127; head.writeBigUInt64BE(BigInt(b.length), 2); }
    return Buffer.concat([head, b]);
  }
  function onSocket(sock) {
    F.sockets.add(sock);
    sock.on('close', () => F.sockets.delete(sock));
    sock.on('error', () => {});
    let buf = Buffer.alloc(0);
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (buf.length < 2) return;
        const op = buf[0] & 0x0f, masked = !!(buf[1] & 0x80);
        let len = buf[1] & 0x7f, off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        const mask = masked ? buf.slice(off, off + 4) : null;
        if (masked) off += 4;
        if (buf.length < off + len) return;
        const payload = Buffer.from(buf.slice(off, off + len));
        if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
        buf = buf.slice(off + len);
        if (op === 0x8) { try { sock.end(Buffer.from([0x88, 0])); } catch (e) { /* gone */ } return; }
        if (op === 0x9) { sock.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload])); continue; }
        if (op !== 0x1) continue;
        let msg; try { msg = JSON.parse(payload.toString('utf8')); } catch (e) { continue; }
        F.calls.push(['cdp', msg.method]);
        if (o.stuck) continue;                         // a hung page: never answers
        if (msg.method !== 'Runtime.evaluate') { sock.write(frame(JSON.stringify({ id: msg.id, error: { code: -32601, message: `'${msg.method}' wasn't found` } }))); continue; }
        evaluate(msg.params.expression).then((result) => { try { sock.write(frame(JSON.stringify({ id: msg.id, result }))); } catch (e) { /* gone */ } });
      }
    });
  }

  F.start = (port) => new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      F.calls.push(['http', req.url]);
      if (req.url === '/json/list' || req.url === '/json') {
        const list = o.list || [{ id: 'PAGE1', type: 'page', title: 'Spotify', url: o.pageUrl, webSocketDebuggerUrl: `ws://127.0.0.1:${F.port}/devtools/page/PAGE1` },
          { id: 'W1', type: 'service_worker', url: 'https://xpui.app.spotify.com/sw.js', webSocketDebuggerUrl: `ws://127.0.0.1:${F.port}/devtools/page/W1` }];
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(list));
        return;
      }
      res.writeHead(404); res.end('no');
    });
    srv.on('upgrade', (req, sock) => {
      F.calls.push(['upgrade', req.url, req.headers.origin || null]);
      if (!/^\/devtools\/page\/PAGE1$/.test(req.url)) { sock.end('HTTP/1.1 404 Not Found\r\n\r\n'); return; }
      const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
      onSocket(sock);
    });
    srv.on('error', reject);
    srv.listen(port || o.port || 0, '127.0.0.1', () => { F.server = srv; F.port = srv.address().port; resolve(F.port); });
  });
  /* Spotify quits: the port closes and every socket drops. */
  F.stop = () => new Promise((resolve) => {
    for (const s of F.sockets) { try { s.destroy(); } catch (e) { /* gone */ } }
    F.sockets.clear();
    if (!F.server) { resolve(); return; }
    F.server.close(() => resolve());
    F.server = null;
  });
  F.player = player;
  return F;
}

/* a fetch for the artwork: i.scdn.co answers a tiny PNG, anything else fails */
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
function fakeFetch(log) {
  return async (url) => {
    if (log) log.push(url);
    if (!/^https:\/\/i\.scdn\.co\/image\//.test(url)) throw new Error('offline');
    if (/000000000000000000000012$/.test(url)) return { ok: false, status: 404, headers: { get: () => 'text/html' }, arrayBuffer: async () => new ArrayBuffer(0) };
    return { ok: true, status: 200, headers: { get: () => 'image/png' }, arrayBuffer: async () => PNG.buffer.slice(PNG.byteOffset, PNG.byteOffset + PNG.length) };
  };
}

function fakeProc(init) {
  const P = Object.assign({ exists: true, pids: [], visibleNow: false, closeWorks: true, calls: [], onLaunch: null }, init || {});
  return {
    P,
    exists() { return P.exists; },
    async running() { P.calls.push('running'); return P.pids.slice(); },
    async visible() { P.calls.push('visible'); return P.visibleNow; },
    async close() { P.calls.push('close'); if (P.closeWorks) P.pids = []; return { out: P.closeWorks ? 'SUCCESS' : '', err: P.closeWorks ? null : 'no window answered' }; },
    async kill() { P.calls.push('kill'); P.pids = []; return { out: 'SUCCESS', err: null }; },
    async launch(exe, args) { P.calls.push(['launch', exe, args]); P.pids = [4242]; if (P.onLaunch) await P.onLaunch(args); return { ok: true, pid: 4242 }; },
  };
}

module.exports = { createFakeSpotify, fakeFetch, fakeProc, track, uri };

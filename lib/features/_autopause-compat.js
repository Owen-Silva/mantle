'use strict';
/* _autopause-compat.js - the standalone bridge's HTTP API, served by Mantle (r5-autopause lane,
 * 2026-09-30), so Owen's other Spotify clients keep working unchanged once the PowerShell bridge is
 * retired: Quartz's browser prong (/pause, /resume ?src=owen-browser) and its new-tab now playing
 * (/now, /control), and the Opera GX extension (/ping, /pause, /resume ?src=browser).
 *
 * It only comes up while Mantle's auto-pause is IN CHARGE (the standalone helper's task is disabled or
 * gone and no bridge answers), on the first free port of 8787-8790 (the clients probe all four), and
 * goes down the moment the helper is back. Never in --test unless MANTLE_AUTOPAUSE_PORT names a port.
 *
 * Shapes are the bridge 1.5.3's (spotify-bridge.ps1 New-StatusJson / New-NowJson / Invoke-ControlRoute),
 * plus "server":"mantle" so the coexistence probe never mistakes this for the helper. Differences, on
 * purpose: ad ducking is not served (POST /config says so in words), and the debug routes are gone.
 *
 * SAFETY (the bridge allowed any web page): a request carrying an Origin is served only from a browser
 * EXTENSION (chrome-extension:// / moz-extension:// / extension://); a web page gets 403. A request with
 * NO Origin is a local app (Quartz's Node http, PowerShell) only while it also carries no Sec-Fetch-Site
 * (or "none" = typed by the user): browsers send Sec-Fetch-Site to 127.0.0.1, so a page's
 * <img src=".../pause"> or no-cors GET (no Origin) is refused with 403 before any route runs. The Host must
 * be 127.0.0.1 or localhost (no DNS rebinding). Bodies are capped at 4 KB, src is the bridge's
 * ^[A-Za-z0-9:._-]{1,80}$ (else 'browser'), and /control takes play|pause|toggle|next|prev only.
 */
const http = require('http');

const PORTS = [8787, 8788, 8789, 8790];
const SRC_RE = /^[A-Za-z0-9:._-]{1,80}$/;
const CMDS = { play: 'play', pause: 'pause', toggle: 'toggle', next: 'next', prev: 'previous' };

function srcKey(q) {
  const s = String(q.get('src') || '').trim().slice(0, 80);
  return SRC_RE.test(s) ? s : 'browser';
}
function originOk(o) { return !o || /^(chrome-extension|moz-extension|extension):\/\//i.test(String(o)); }
// No Origin: a browser still says where the request came from in Sec-Fetch-Site (127.0.0.1 is a
// trustworthy origin); Node and PowerShell callers send neither. "none" = the user typed the URL.
function fetchOk(origin, site) {
  if (origin) return originOk(origin);
  return site === undefined || String(site).trim().toLowerCase() === 'none';
}
function hostOk(h, port) { return new RegExp(`^(127\\.0\\.0\\.1|localhost)(:${port})?$`, 'i').test(String(h || '')); }

/**
 * createCompat({ engine, spotify(): {found, state, aumid}, media(): main's read, control(cmd): Promise<{ok, reason}>,
 *                log, now, ports })
 */
function createCompat(deps) {
  const d = deps || {};
  let server = null, port = null, starting = null;

  function statusJson(extra) {
    const sp = d.spotify();
    const snap = d.engine.snapshot(d.now());
    return Object.assign({
      ok: true, app: 'spotify-autopause', server: 'mantle', version: 'mantle', port,
      spotifyFound: !!sp.found, spotifyState: sp.found ? sp.state : 'none', heldByUs: snap.wePaused && snap.holds.length > 0,
      control: 'smtc', holds: snap.holds.map((h) => (h.native ? 'native' : h.key.replace(/^http:/, ''))),
      repauseCount: snap.episodeRepauses, repauseSuppressed: snap.suppressed, repauseSuppressedForMs: snap.suppressedForMs,
      browserHoldTtlMs: d.engine.config.httpHoldTtlMs, adDuck: null,
    }, extra || {});
  }

  function nowJson(q) {
    const m = d.media();
    const list = m && Array.isArray(m.sessions) ? m.sessions : [];
    const s = (m && m.shown) || list.find((x) => x && x.playing) || list[0] || null;
    if (!s) return { ok: true, source: '', title: '', artist: '', album: '', status: 'none', positionMs: 0, durationMs: 0, canNext: false, canPrev: false, canPlayPause: false, held: false, art: null, artHash: '' };
    const tl = s.timeline && s.timeline.available !== false ? s.timeline : {};
    const can = s.can || {};
    const snap = d.engine.snapshot(d.now());
    const out = {
      ok: true, source: s.aumid || '', title: s.title || '', artist: s.artist || '', album: s.album || '',
      status: String(s.status || 'none'), positionMs: Math.round(tl.positionNowMs || tl.positionMs || 0), durationMs: Math.round(tl.durationMs || 0),
      canNext: can.next === true, canPrev: can.previous === true, canPlayPause: can.toggle === true || can.play === true || can.pause === true,
      held: snap.wePaused && snap.holds.length > 0, art: null, artMime: '', artHash: '',
    };
    const url = typeof s.art === 'string' ? s.art : (s.art && typeof s.art.url === 'string' ? s.art.url : '');
    const mm = /^data:(image\/[a-z]+);base64,(.+)$/i.exec(url);
    if (mm) {
      let h = 0; const key = String(s.artKey || url.slice(-64));
      for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
      out.artHash = (h >>> 0).toString(16);
      out.artMime = mm[1];
      const want = q.get('art'), had = q.get('artHash');
      if (want !== '0' && had !== out.artHash) out.art = mm[2];
    }
    return out;
  }

  async function route(req, url, body) {
    const p = url.pathname, q = url.searchParams;
    if (p === '/ping' || p === '/status') return [200, statusJson()];
    if (p === '/pause') {
      const key = srcKey(q);
      const r = await d.engine.addHold(`http:${key}`, { native: false, kind: 'http' }, d.now());
      d.log(`a browser took a hold over HTTP (${r.action})`);
      if (d.changed) d.changed();
      return [200, statusJson({ action: r.action, reason: r.reason || '' })];
    }
    if (p === '/resume') {
      const key = srcKey(q);
      const r = await d.engine.removeHold(`http:${key}`, 'its browser handed it back');
      if (d.changed) d.changed();
      return [200, statusJson({ action: r.action, reason: r.reason || '' })];
    }
    if (p === '/now') return [200, nowJson(q)];
    if (p === '/sessions') {
      const snap = d.engine.snapshot(d.now());
      return [200, { ok: true, sessions: snap.tracks.map((t) => ({ kind: t.kind, realPlaying: t.real, held: t.held, status: t.status })) }];
    }
    if (p === '/control') {
      let cmd = q.get('cmd') || '';
      if (!cmd && body) { try { const j = JSON.parse(body); cmd = j && typeof j.cmd === 'string' ? j.cmd : ''; } catch (e) { cmd = ''; } }
      if (!Object.prototype.hasOwnProperty.call(CMDS, cmd)) return [200, { ok: false, cmd: String(cmd).slice(0, 16), reason: 'bad cmd' }];
      const snap = d.engine.snapshot(d.now());
      if ((cmd === 'play' || cmd === 'toggle') && snap.wePaused && snap.holds.length) return [200, { ok: false, cmd, reason: 'held', holds: snap.holds.length }];
      const r = await d.control(CMDS[cmd]);
      return [200, r.ok ? { ok: true, cmd, result: true, source: 'mantle' } : { ok: false, cmd, reason: r.reason || 'no session' }];
    }
    if (p === '/config') {
      if (req.method === 'POST') return [200, { ok: false, reason: 'Mantle does not turn Spotify’s ads down, so there is nothing to change here' }];
      return [200, { ok: true, config: { adDuck: { enabled: false } }, server: 'mantle' }];
    }
    return [404, { ok: false, reason: 'not found' }];
  }

  function send(res, code, obj) {
    const b = Buffer.from(JSON.stringify(obj), 'utf8');
    res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': b.length, 'Cache-Control': 'no-store', Connection: 'close',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
    res.end(b);
  }

  function handler(req, res) {
    const origin = req.headers.origin;
    res.setHeader('Vary', 'Origin');
    if (!hostOk(req.headers.host, port) || !fetchOk(origin, req.headers['sec-fetch-site'])) return send(res, 403, { ok: false, reason: 'only this PC’s apps and browser extensions may use this' });
    if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Private-Network': 'true' }); return res.end(); }
    if (req.method !== 'GET' && req.method !== 'POST') return send(res, 405, { ok: false, reason: 'GET or POST only' });
    let body = '', big = false;
    req.setEncoding('utf8');
    req.on('data', (c) => { if (body.length + c.length > 4096) { big = true; } else body += c; });
    req.on('end', () => {
      if (big) return send(res, 413, { ok: false, reason: 'body over 4 KB' });
      let url;
      try { url = new URL(req.url, 'http://127.0.0.1'); } catch (e) { return send(res, 400, { ok: false, reason: 'bad url' }); }
      route(req, url, body).then(([code, obj]) => send(res, code, obj), (e) => {
        d.log(`a compatible-API request threw: ${(e && e.stack) || e}`);
        send(res, 500, { ok: false, reason: 'Mantle could not do that' });
      });
    });
  }

  function listenOn(p) {
    return new Promise((resolve) => {
      const s = http.createServer(handler);
      s.once('error', () => { try { s.close(); } catch (e) { /* never bound */ } resolve(null); });
      s.listen(p, '127.0.0.1', () => resolve(s));
    });
  }

  async function start() {
    if (server) return port;
    if (starting) return starting;
    starting = (async () => {
      for (const p of d.ports || PORTS) {
        const s = await listenOn(p);
        if (s) { server = s; port = p; s.on('error', (e) => d.log(`the compatible API stopped: ${e && e.code}`)); d.log(`serving the bridge-compatible API on 127.0.0.1:${p}`); return p; }
      }
      d.log('the bridge-compatible API could not start: ports 8787-8790 are all taken');
      return null;
    })();
    try { return await starting; } finally { starting = null; }
  }

  function stop(why) {
    if (!server) return;
    const s = server;
    server = null; port = null;
    try { s.close(); if (typeof s.closeAllConnections === 'function') s.closeAllConnections(); } catch (e) { /* gone */ }
    d.log(`bridge-compatible API closed (${why || 'stopped'})`);
  }

  return { start, stop, port: () => port, running: () => !!server };
}

module.exports = { createCompat, PORTS, originOk, fetchOk, hostOk, srcKey };

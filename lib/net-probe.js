'use strict';
const http = require('http');

/*
 * "Is that local service up, and if not, why not?"
 *
 * WHY this is in main and not in the desktop page: a fetch() from a file:// page
 * can only ever tell the renderer "Failed to fetch" -- CORS collapses every cause
 * into one useless string. Node's http client gives the real one (ECONNREFUSED,
 * ETIMEDOUT, EHOSTUNREACH), and "Mission Control offline: connect ECONNREFUSED
 * 127.0.0.1:7373" is a sentence Owen can act on, which is the whole point of the
 * no-silent-failures rule.
 *
 * Deliberately limited to loopback: a renderer must not be able to use Mantle's
 * main process as a general-purpose network prober.
 */

const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const TIMEOUT_MS = 2000;

function probe(rawUrl) {
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(rawUrl);
    } catch (err) {
      resolve({ ok: false, reason: `"${rawUrl}" is not a URL` });
      return;
    }
    if (u.protocol !== 'http:') {
      resolve({ ok: false, reason: `only http:// is probed, not ${u.protocol}` });
      return;
    }
    if (!ALLOWED_HOSTS.has(u.hostname)) {
      resolve({ ok: false, reason: `only loopback is probed, not ${u.hostname}` });
      return;
    }

    const req = http.request({
      host: u.hostname,
      port: u.port || 80,
      path: u.pathname || '/',
      method: 'GET',
      timeout: TIMEOUT_MS,
      headers: { connection: 'close' },
    }, (res) => {
      res.resume();   // drain, we only wanted the status line
      resolve({ ok: true, status: res.statusCode, reason: `answered ${res.statusCode}` });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, reason: `no answer from ${u.host} within ${TIMEOUT_MS} ms` });
    });
    req.on('error', (err) => {
      resolve({ ok: false, reason: `${err.code || err.message} on ${u.host}` });
    });
    req.end();
  });
}

module.exports = { probe };

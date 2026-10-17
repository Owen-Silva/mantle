'use strict';
/*
 * _gcal-auth.js - "Sign in with Google": OAuth 2.0 for installed apps (lane mantle-gcal, 2026-10-16).
 *
 *   1. a one-shot HTTP listener on 127.0.0.1, on a free port the OS picks (never a fixed one);
 *   2. PKCE S256 + a random state;
 *   3. the consent page opens in the user's OWN default browser (openExternal), never a webview;
 *   4. the browser comes back to http://127.0.0.1:<port>/?code=..&state=..; a wrong or missing state is
 *      refused; the listener closes after the first real answer or after 5 minutes;
 *   5. the code + verifier are exchanged for tokens (google.exchange).
 * The listener answers only 127.0.0.1, serves one tiny page with no outside resources, and logs nothing
 * from the query string.
 */
const http = require('http');
const C = require('./_gcal-core');

const WAIT_MS = 5 * 60 * 1000;

function page(title, text) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>' + esc(title) + '</title>' +
    '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'">' +
    '<style>body{font:15px system-ui,sans-serif;background:#f3f3f3;color:#1b1b1b;display:grid;place-items:center;height:100vh;margin:0}' +
    'main{background:#fff;border-radius:12px;padding:28px 32px;box-shadow:0 1px 3px rgba(0,0,0,.12);max-width:420px}' +
    'h1{font-size:18px;margin:0 0 8px}p{margin:0;color:#555}@media (prefers-color-scheme:dark){body{background:#1c1c1c;color:#eee}main{background:#2a2a2a;box-shadow:none}p{color:#bbb}}</style>' +
    '</head><body><main><h1>' + esc(title) + '</h1><p>' + esc(text) + '</p></main></body></html>';
}

/* signIn({ client, google, openExternal, randomBytes, waitMs, onUrl }) -> Promise<token>
   Rejects with an Error carrying a plain-words .reason. */
function signIn({ client, google, openExternal, randomBytes, waitMs, createServer }) {
  if (!client || !client.clientId) return Promise.reject(Object.assign(new Error('no client'), { reason: 'choose your Google client file first' }));
  const pk = C.pkce(randomBytes);
  const state = C.newState(randomBytes);
  const mk = createServer || http.createServer;
  return new Promise((resolve, reject) => {
    let done = false, timer = null;
    const server = mk();
    const finish = (err, tok) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      try { server.close(); } catch (e) { /* already closed */ }
      // idle keep-alive sockets only: a page still being written to the browser is let finish
      if (typeof server.closeIdleConnections === 'function') try { server.closeIdleConnections(); } catch (e) { /* ignore */ }
      if (err) reject(err); else resolve(tok);
    };
    const fail = (reason) => finish(Object.assign(new Error(reason), { reason }));
    server.on('error', (e) => fail('the sign-in listener on this PC could not start (' + String((e && e.code) || e.message || e).slice(0, 60) + ')'));
    let redirectUri = null, exchanging = false;
    server.on('request', (req, res) => {
      let q;
      try { q = new URL(req.url, 'http://127.0.0.1').searchParams; } catch (e) { res.writeHead(400); res.end(); return; }
      if (req.method !== 'GET' || (!q.has('code') && !q.has('error'))) { res.writeHead(404); res.end(); return; }   // a favicon or a stray probe
      const send = (code, title, text) => { res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(page(title, text)); };
      if (!C.stateMatches(state, q.get('state') || '')) {
        send(400, 'Sign-in not accepted', 'This answer did not come from the sign-in Mantle started. Start again from Mantle Settings.');
        fail('the answer from the browser did not match the sign-in Mantle started, so it was refused');
        return;
      }
      if (q.has('error')) {
        const e = q.get('error');
        send(200, 'Not connected', 'Mantle was not given access. You can close this tab.');
        fail(e === 'access_denied' ? 'you said no on Google\'s page, so Mantle is not connected' : 'Google stopped the sign-in (' + String(e).slice(0, 40) + ')');
        return;
      }
      if (exchanging) { send(409, 'Already signing in', 'Mantle is already finishing this sign-in. You can close this tab.'); return; }
      exchanging = true;
      const no = (reason) => { send(200, 'Not connected', 'Mantle could not finish connecting: ' + reason + '.'); fail(reason); };
      google.exchange({ client, code: q.get('code'), verifier: pk.verifier, redirectUri })
        .then((tok) => {
          if (!tok.scopes.some((s) => s === C.SCOPE)) return no('Google did not give Mantle read access to your calendar; sign in again and tick the calendar box');
          if (!tok.refresh) return no('Google did not send a lasting sign-in; sign in again');
          send(200, 'Mantle is connected', 'Mantle can now show your Google Calendar. You can close this tab.');
          finish(null, tok);
        }, (e) => no(C.classify(e).reason));
    });
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      redirectUri = 'http://127.0.0.1:' + port + '/';
      let url;
      try { url = C.authUrl({ clientId: client.clientId, redirectUri, challenge: pk.challenge, state }); } catch (e) { fail(e.message); return; }
      timer = setTimeout(() => fail('the sign-in was not finished within 5 minutes'), waitMs || WAIT_MS);
      Promise.resolve().then(() => openExternal(url)).catch((e) => fail('your browser could not be opened (' + String((e && e.message) || e).slice(0, 60) + ')'));
    });
  });
}

module.exports = { signIn, page, WAIT_MS };

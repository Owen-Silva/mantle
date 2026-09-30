'use strict';
/*
 * net-probe.test.js - lib/net-probe.js: loopback only, bounded, plain words (core-lib, 2026-09-29).
 *
 *   node lib/net-probe.test.js
 *
 * A local http server on 127.0.0.1 stands in for Mission Control. Failed first: [::1] (IPv6
 * loopback) was refused as "not loopback" (URL.hostname keeps the brackets), and a closed port said
 * "ECONNREFUSED on 127.0.0.1:N" on the desktop strip instead of words.
 */
const http = require('http');
const net = require('net');
const { probe } = require('./net-probe');

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) passed++;
  else failures.push(name + (detail ? ' -- ' + detail : ''));
}
const listen = (srv, host) => new Promise((r, j) => { srv.once('error', j); srv.listen(0, host, () => r(srv.address().port)); });

(async () => {
  const ok = http.createServer((req, res) => { res.writeHead(204); res.end(); });
  const port = await listen(ok, '127.0.0.1');
  const r1 = await probe(`http://127.0.0.1:${port}/`);
  check('a loopback server that answers: ok with its status', r1.ok === true && r1.status === 204, JSON.stringify(r1));
  const r2 = await probe(`http://localhost:${port}/x?y=1`);
  check('localhost is loopback too', r2.ok === true || /nothing answered/.test(r2.reason), JSON.stringify(r2));

  // IPv6 loopback, when this machine has it.
  const ok6 = http.createServer((req, res) => { res.writeHead(200); res.end(); });
  let port6 = null;
  try { port6 = await listen(ok6, '::1'); } catch (_) { /* no IPv6 loopback here */ }
  if (port6) {
    const r6 = await probe(`http://[::1]:${port6}/`);
    check('[::1] is loopback (brackets and all)', r6.ok === true && r6.status === 200, JSON.stringify(r6));
    ok6.close();
  } else {
    check('[::1] is at least not refused as "not loopback"', !/only loopback/.test((await probe('http://[::1]:9/')).reason || ''));
  }

  // refusals, in words, with no request made
  const bad = [
    ['https://127.0.0.1/', /only http/],
    ['http://example.com/', /only this computer/],
    ['http://10.0.0.1:80/', /only this computer/],
    ['http://127.0.0.1.evil.example/', /only this computer/],
    ['not a url', /is not a web address/],
    ['', /is not a web address/],
  ];
  for (const [u, re] of bad) {
    const r = await probe(u);
    check(`refused: ${JSON.stringify(u)}`, r.ok === false && re.test(r.reason), JSON.stringify(r));
  }

  // a closed port: plain words, no error code
  const tmp = net.createServer();
  const closedPort = await listen(tmp, '127.0.0.1');
  await new Promise((r) => tmp.close(r));
  const rc = await probe(`http://127.0.0.1:${closedPort}/`);
  check('closed port: plain words, no error code', rc.ok === false && /nothing answered/.test(rc.reason) && !/ECONN|EADDR/.test(rc.reason), JSON.stringify(rc));

  // a server that accepts and never answers: bounded by the 2 s timeout
  const hang = net.createServer(() => { /* never answer */ });
  const hangPort = await listen(hang, '127.0.0.1');
  const t0 = Date.now();
  const rh = await probe(`http://127.0.0.1:${hangPort}/`);
  const ms = Date.now() - t0;
  check('a server that never answers: given up at ~2 s', rh.ok === false && ms >= 1800 && ms < 3500 && /no answer/.test(rh.reason), `${ms} ms ${JSON.stringify(rh)}`);
  hang.close();
  ok.close();

  for (const f of failures) console.log('FAIL ' + f);
  console.log(`NET PROBE TEST: ${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})();

'use strict';
/* _autopause-coexist.js - is the old standalone Spotify auto-pause helper in charge? (r5-autopause lane,
 * 2026-09-30). Two controllers must never fight over Spotify, so while the helper runs Mantle's
 * auto-pause stands by. Read only: nothing here starts, stops, enables or edits the helper.
 *
 * The helper = the earlier PowerShell bridge (~/spotify-autopause, never published), run by the "SpotifyAutoPause" scheduled task
 * (logon + a 1-minute keepalive repeat). It is IN CHARGE when either:
 *   - the task exists and is enabled: the bridge gets killed now and then (0xC000013A, twice on
 *     2026-09-10) and the task brings it back within a minute, so "enabled" counts even in that gap;
 *   - or a bridge answers /ping on 127.0.0.1:8787-8790 ({"app":"spotify-autopause"}), e.g. one
 *     started by hand with the task disabled.
 * A host built into Mantle or Quartz says {"server":"mantle"|"quartz"} and never counts: those cooperate
 * through ./_autopause-link.js instead (docs/autopause-protocol.md). Only the old bridge (no server field) does.
 *
 * The task's state is read from its XML (%SystemRoot%\System32\Tasks\SpotifyAutoPause, UTF-16; the
 * Settings <Enabled>false</Enabled> is what a disable writes; measured 2026-09-30: readable by the
 * user, 2129 chars). If the file cannot be read, schtasks.exe answers instead (never PowerShell).
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFile } = require('child_process');

const TASK = 'SpotifyAutoPause';
const PORTS = [8787, 8788, 8789, 8790];

function taskFile(env) {
  const root = (env && (env.SystemRoot || env.windir)) || 'C:\\Windows';
  return path.join(root, 'System32', 'Tasks', TASK);
}

/** 'enabled' | 'disabled' | 'absent' | 'unknown' from the task XML text. PURE. */
function taskStateFromXml(text) {
  const s = String(text || '');
  if (!/<Task[\s>]/.test(s)) return 'unknown';
  const m = /<Settings>[\s\S]*?<\/Settings>/.exec(s);
  const en = m ? /<Enabled>\s*(true|false)\s*<\/Enabled>/i.exec(m[0]) : null;
  return en && en[1].toLowerCase() === 'false' ? 'disabled' : 'enabled';
}

function decode(buf) {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.toString('utf16le');
  if (buf.length >= 2 && buf[1] === 0x00) return buf.toString('utf16le');
  return buf.toString('utf8');
}

function readTask(opts) {
  const o = opts || {};
  const file = o.file || taskFile(process.env);
  const rf = o.readFile || fs.readFile;
  return new Promise((resolve) => {
    rf(file, (err, buf) => {
      if (!err) return resolve(taskStateFromXml(decode(buf)));
      if (err.code === 'ENOENT') return resolve('absent');
      // Not readable: ask schtasks (a plain exe; CSV "\SpotifyAutoPause","N/A","Disabled").
      const ex = o.execFile || execFile;
      ex('schtasks.exe', ['/query', '/tn', TASK, '/fo', 'csv', '/nh'], { windowsHide: true, timeout: 4000 }, (e2, out) => {
        if (e2) return resolve(/cannot find|does not exist/i.test(String((e2 && e2.message) || '') + String(out || '')) ? 'absent' : 'unknown');
        return resolve(/"Disabled"/i.test(String(out)) ? 'disabled' : 'enabled');
      });
    });
  });
}

function ping(port, timeoutMs, get) {
  const g = get || http.get;
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    let req;
    try {
      req = g({ host: '127.0.0.1', port, path: '/ping', timeout: timeoutMs, headers: { 'X-Mantle': 'coexist' } }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { if (body.length < 65536) body += c; });
        res.on('end', () => {
          try {
            const j = JSON.parse(body);
            finish(j && !j.server && /spotify-autopause/i.test(String(j.app || '')) ? { port, version: String(j.version || '') } : null);
          } catch (e) { finish(null); }
        });
        res.on('error', () => finish(null));
      });
    } catch (e) { return finish(null); }
    req.on('timeout', () => { try { req.destroy(); } catch (e) { /* gone */ } finish(null); });
    req.on('error', () => finish(null));
  });
}

/** -> { inCharge, task, bridge: {port, version} | null, words } */
async function check(opts) {
  const o = opts || {};
  const task = await readTask(o);
  let bridge = null;
  if (task !== 'enabled') {
    const hits = await Promise.all((o.ports || PORTS).map((p) => ping(p, o.timeoutMs || 700, o.get)));
    bridge = hits.find(Boolean) || null;
  }
  const inCharge = task === 'enabled' || !!bridge;
  const words = inCharge
    ? 'The separate Spotify auto-pause helper on this PC is in charge, so Mantle’s stays off. Turn the helper off to use this one'
    : '';
  return { inCharge, task, bridge, words };
}

module.exports = { check, readTask, taskStateFromXml, ping, PORTS, TASK, taskFile };

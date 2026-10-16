#!/usr/bin/env node
// Brightness pop-up flash stats from mantle.log (P7). Reads the per-burst summary lines the sidecar
// writes ("osd: brightness pop-up: <state> (<how>), off screen X ms after Windows showed it, ...")
// and prints how long Windows' own pop-up was on screen: first showing, and in all per burst.
//   node tools/osd-bright-logstats.js [log ...]   (default: %APPDATA%/mantle/mantle.log*)
'use strict';
const fs = require('fs');
const path = require('path');

function parse(line) {
  const m = /osd: brightness pop-up: (\w+)(?: \((\w+)\))?, (.*)$/.exec(line);
  if (!m) return null;
  const rest = m[3];
  const num = (re) => { const x = re.exec(rest); return x ? Number(x[1]) : null; };
  return {
    state: m[1], how: m[2] || null,
    hiddenAfterMs: num(/off screen ([\d.]+) ms after Windows showed it/),
    changes: num(/(\d+) change\(s\)/),
    movedBack: num(/moved it back (\d+)x/),
    worstMs: num(/worst ([\d.]+) ms on screen/),
    totalMs: num(/([\d.]+) ms in all/),
    prepark: /prepark/.test(m[2] || ''),
    ignored: /ignored/.test(rest),
    sessionKind: /\(passive\)|DRY RUN/.test(line) ? 'dry' : 'live',
  };
}

function pct(a, p) {
  if (!a.length) return null;
  const s = a.slice().sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))];
}

function stats(rows) {
  const first = rows.map(r => r.hiddenAfterMs).filter(v => v != null);
  const total = rows.map(r => r.totalMs).filter(v => v != null);
  const r1 = (v) => v == null ? null : Math.round(v * 10) / 10;
  return {
    bursts: rows.length,
    byState: rows.reduce((o, r) => { const k = r.state + (r.how ? ' (' + r.how + ')' : ''); o[k] = (o[k] || 0) + 1; return o; }, {}),
    prepark: rows.filter(r => r.prepark).length,
    firstShow: { n: first.length, p50: r1(pct(first, 0.5)), p95: r1(pct(first, 0.95)), max: r1(first.length ? Math.max(...first) : null) },
    onScreenPerBurst: { n: total.length, p50: r1(pct(total, 0.5)), p95: r1(pct(total, 0.95)), max: r1(total.length ? Math.max(...total) : null) },
  };
}

module.exports = { parse, stats, pct };

if (require.main === module) {
  let files = process.argv.slice(2);
  if (!files.length) {
    const dir = path.join(process.env.APPDATA || '', 'mantle');
    files = ['mantle.log.2', 'mantle.log.1', 'mantle.log'].map(f => path.join(dir, f)).filter(f => fs.existsSync(f));
  }
  const rows = [];
  for (const f of files) {
    for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
      if (!/^\d\d:\d\d:\d\d\.\d+ mantle: osd: brightness pop-up: /.test(line)) continue;
      const r = parse(line); if (r) rows.push(r);
    }
  }
  console.log(JSON.stringify(stats(rows), null, 1));
}

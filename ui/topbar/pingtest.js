/* pingtest.js — "Run ping test" in the top bar's PING dropdown (lane pingtest, 2026-10-09).
 * Owen: "can you make a ping test?"; where: "In the PING dropdown"; extras: "Router ping" AND
 * "Download/upload speed".
 *
 * The sidecar runs it (sidecar/PingTest.cs) and keeps the last run; this file only draws it, inside
 * the PING dropdown topbar.js already renders: topbar.js calls PingTest.html() at the end of that
 * dropdown, hands row clicks with data-act="pt-…" to PingTest.act(), and gives PingTest.init() a
 * rerender() that redraws the dropdown when it is open on PING. Closing the dropdown does NOT cancel:
 * the run goes on in the sidecar and its result is here on reopen, with its time, until the next run.
 *
 * Amber (--lg-warn) for a bad value. Servers: average >= 100 ms, jitter >= 10 ms, any loss. The
 * router (your own Wi-Fi / network): average >= 20 ms, jitter >= 10 ms, any loss.
 * Jitter: the mean absolute difference of consecutive replies (how much the ping jumps).
 */
(function () {
  'use strict';
  const WARN = { avg: 100, routerAvg: 20, jitter: 10, loss: 0 };
  const DEFAULT_CAPS = { rounds: 20, periodMs: 750, downMs: 7000, downBytes: 35e6, upMs: 6000, upBytes: 20e6, answerMs: 5000 };

  let api = null;     // { call, on, rerender }
  let st = null;      // the sidecar's last pingtest state (phase "idle" before any run)
  let err = null;     // a refused start / cancel / read, in words
  let asking = false; // a state read in flight
  let readFailedAt = 0; // the last failed state read (retried at most every 5 s while the dropdown draws)
  /* HISTORY (Owen: "i want history of the tests and make it so i can save tests and name them and each
   * test should also say what wifi i was on"). Main keeps it (lib/features/_pingtest-history.js,
   * <userData>/ping-tests.json) and pushes `topbar.pingtests` on every change. */
  const H = { tab: 'test', list: null, open: null, edit: null, armed: null, filter: null, msg: null };
  // H.list: { tests, problem, max } | null; H.open: an entry's id; H.edit: { id, mode, value, a, b } (the name box);
  // H.armed: the id whose Delete was pressed once; H.filter: a Wi-Fi label; H.msg: a refused history action

  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const num = (v) => (v == null ? '--' : v < 10 ? (Math.round(v * 10) / 10).toFixed(1) : String(Math.round(v)));
  const ms = (v) => (v == null ? '--' : num(v) + ' ms');
  const mbps = (v) => (v == null ? '--' : (v >= 100 ? String(Math.round(v)) : (Math.round(v * 10) / 10).toFixed(1)) + ' Mbps');
  const mb = (b) => Math.round((b || 0) / 1e6) + ' MB';
  const clock = (t) => { try { return new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); } catch (_) { return ''; } };
  const caps = () => (st && st.caps) || DEFAULT_CAPS;

  function rerender() { if (api && api.rerender) api.rerender(); }

  function init(o) {
    api = o;
    o.on('topbar.pingtest', (s) => { if (s && typeof s === 'object') { st = s; err = null; rerender(); } });
    o.on('topbar.pingtests', (v) => { if (v && Array.isArray(v.tests)) { H.list = v; rerender(); } });
    read();
    hist({ action: 'list' });
    // the name box: its text survives the 1 s re-render of the dropdown (after() puts it back)
    document.addEventListener('input', (e) => {
      if (H.edit && e.target && e.target.classList && e.target.classList.contains('pt-name')) { H.edit.value = e.target.value; H.edit.a = e.target.selectionStart; H.edit.b = e.target.selectionEnd; }
    });
  }

  /** One history request to main; its answer carries the whole history back. */
  function hist(args) {
    if (!api) return Promise.resolve(null);
    return Promise.resolve(api.call('topbar.pingTests', args)).then((r) => {
      if (r && r.history && Array.isArray(r.history.tests)) H.list = r.history;
      H.msg = r && r.ok === false ? `${args.action === 'list' ? 'The history could not be read' : 'That did not happen'}: ${r.reason || 'no reason came back'}` : null;
      rerender();
      return r;
    });
  }

  // the last run, from the sidecar (it keeps it): on load, and again on open if that read failed
  function read() {
    if (!api || asking) return;
    asking = true;
    Promise.resolve(api.call('topbar.pingTest', { action: 'state' })).then((r) => {
      asking = false;
      if (r && r.ok === false) { readFailedAt = Date.now(); err = `The last ping test could not be read: ${r.reason || 'no reason came back'}`; rerender(); return; }
      if (readFailedAt) { readFailedAt = 0; err = null; rerender(); }
      if (r && r.phase && (!st || (r.run || 0) >= (st.run || 0))) { st = r; err = null; rerender(); }
    }, (e) => { asking = false; readFailedAt = Date.now(); err = `The last ping test could not be read: ${(e && e.message) || e}`; rerender(); });
  }

  /** A row click inside the dropdown; true when it was ours. */
  function act(name) {
    if (!/^pt-/.test(String(name || ''))) return false;
    if (!api) return true;
    const [verb, arg] = String(name).split(/:(.*)/s);
    if (verb !== 'pt-start' && verb !== 'pt-cancel') { histAct(verb, arg); return true; }
    const action = name === 'pt-cancel' ? 'cancel' : 'start';
    if (action === 'start') { st = Object.assign({}, st || {}, { phase: 'starting', running: true, rows: [], progress: 0, run: ((st && st.run) || 0) + 0.5 }); err = null; rerender(); }
    Promise.resolve(api.call('topbar.pingTest', { action })).then((r) => {
      if (r && r.ok === false) {
        err = `The ping test ${action === 'start' ? 'could not start' : 'could not be cancelled'}: ${r.reason || 'no reason came back'}`;
        if (action === 'start') read();   // put back what the sidecar really has
      } else if (r && r.phase && (!st || (r.run || 0) >= Math.floor(st.run || 0))) st = r;
      rerender();
    });
    return true;
  }

  function histAct(verb, arg) {
    const tests = (H.list && H.list.tests) || [];
    if (verb !== 'pt-del') H.armed = null;
    if (verb === 'pt-tab') { H.tab = arg === 'history' ? 'history' : 'test'; H.open = null; H.edit = null; H.msg = null; if (H.tab === 'history') hist({ action: 'list' }); }
    else if (verb === 'pt-open') { H.open = arg; H.edit = null; H.msg = null; }
    else if (verb === 'pt-back') { H.open = null; H.edit = null; H.msg = null; }
    else if (verb === 'pt-filter') { const ws = wifiLabels(tests); H.filter = arg === 'all' ? null : ws[+arg] || null; }
    else if (verb === 'pt-save' || verb === 'pt-rename') {
      const e = tests.find((x) => x.id === arg);
      const v = verb === 'pt-rename' && e && e.name ? e.name : '';
      H.edit = { id: arg, mode: verb === 'pt-save' ? 'save' : 'rename', value: v, a: v.length, b: v.length };
      H.msg = null;
    } else if (verb === 'pt-commit') { commit(); return; }
    else if (verb === 'pt-uncommit') { H.edit = null; }
    else if (verb === 'pt-del') {
      if (H.armed !== arg) { H.armed = arg; rerender(); return; }   // Delete asks once: the second press deletes
      H.armed = null;
      hist({ action: 'delete', id: arg }).then((r) => { if (r && r.ok !== false && H.open === arg) { H.open = null; rerender(); } });
      return;
    }
    rerender();
  }

  function commit() {
    const ed = H.edit;
    if (!ed) return;
    hist({ action: ed.mode, id: ed.id, name: ed.value }).then((r) => { if (r && r.ok !== false && H.edit === ed) { H.edit = null; rerender(); } });
  }

  /** topbar.js's keydown asks first: keys typed into the name box are the box's (Space, arrows,
   * letters); Enter saves, Escape leaves the box (the dropdown stays). true = handled here. */
  function key(e) {
    if (!H.edit || !e.target || !e.target.classList || !e.target.classList.contains('pt-name')) return false;
    if (e.key === 'Enter') { e.preventDefault(); H.edit.value = e.target.value; commit(); }
    else if (e.key === 'Escape') { e.preventDefault(); H.edit = null; rerender(); }
    return true;
  }

  /** After topbar.js drew the dropdown: the name box gets its text, caret and focus back. */
  function after(dd) {
    const box = H.edit && dd && dd.querySelector('.pt-name');
    if (!box) return;
    box.value = H.edit.value;
    const ed = H.edit;
    // a dropdown that grew waits hidden (topbar.css .dd.wait) until main has grown the window, and a
    // hidden box takes no focus: try again for up to a second
    // (topbar.js hides it AFTER this call when the window must grow first: so the focus is taken
    // once the dropdown is drawn and shown, never before)
    const focus = (n) => {
      if (H.edit !== ed || !box.isConnected) return;
      if (box.closest('.dd.wait') || (document.activeElement !== box && (box.focus({ preventScroll: true }), document.activeElement !== box))) {
        if (n > 0) setTimeout(() => focus(n - 1), 50);
        return;
      }
      try { box.setSelectionRange(ed.a == null ? box.value.length : ed.a, ed.b == null ? box.value.length : ed.b); } catch (_) { /* not a text box */ }
    };
    focus(0);                          // at once: a keystroke right after the 1 s redraw lands in the box
    setTimeout(() => focus(30), 0);    // and again once topbar.js has shown (or hidden) the dropdown
  }

  /* ---- pure: what is bad, and what it means -------------------------------------------------- */
  /** Which of a row's values are bad: { avg, jitter, loss } booleans. */
  function bad(row) {
    const router = row && row.kind === 'router';
    return {
      avg: row && row.avg != null && row.avg >= (router ? WARN.routerAvg : WARN.avg),
      jitter: row && row.jitter != null && row.jitter >= WARN.jitter,
      loss: row && row.loss != null && row.loss > WARN.loss,
    };
  }
  const anyBad = (row) => { const b = bad(row); return b.avg || b.jitter || b.loss; };

  /** One line: is the lag at home (the router is slow) or out on the internet? null when the data cannot say. */
  function verdict(s) {
    const rows = (s && s.rows) || [];
    const router = rows.find((r) => r.kind === 'router');
    const servers = rows.filter((r) => r.kind === 'server' && r.got > 0);
    if (!router || !router.got || !servers.length) return null;
    const best = servers.find((r) => r.best) || servers.slice().sort((a, b) => a.avg - b.avg)[0];
    const home = router.wifi ? 'your Wi-Fi' : 'your home network';
    if (anyBad(router)) {
      const b = bad(router), how = [];
      if (b.avg) how.push(`takes ${ms(router.avg)} on average`);
      if (b.jitter) how.push(`jumps by ${ms(router.jitter)}`);
      if (b.loss) how.push(`lost ${router.loss}% of the pings`);
      return { bad: true, text: `The lag starts at ${home}: your own router ${how.join(', ')}.` };
    }
    if (anyBad(best)) return { bad: true, text: `Your router answers in ${ms(router.avg)}, so ${home} is fine: the lag is out on the internet.` };
    return { bad: false, text: `No lag found: your router answers in ${ms(router.avg)} and the closest server in ${ms(best.avg)}.` };
  }

  /* ---- the HTML ------------------------------------------------------------------------------ */
  function stepWords(s) {
    const n = (s.rows || []).length;
    if (s.phase === 'starting') return 'Finding your router and the servers…';
    if (s.phase === 'ping') return `Pinging ${n} place${n === 1 ? '' : 's'}, ${caps().rounds} times each…`;
    if (s.phase === 'down') return `Download speed${s.down && s.down.server ? ' from ' + s.down.server : ''}… ${s.down && s.down.live != null ? mbps(s.down.live) : ''}`;
    if (s.phase === 'up') return `Upload speed${s.up && s.up.server ? ' to ' + s.up.server : ''}… ${s.up && s.up.live != null ? mbps(s.up.live) : ''}`;
    return '';
  }

  function table(s) {
    const rows = s.rows || [];
    if (!rows.length) return '';
    const label = s.label || 'Ping';
    let h = '<div class="pt-t" role="table">' +
      '<span class="pt-h">Place</span><span class="pt-h">Avg</span><span class="pt-h" title="The fastest and the slowest reply">Best–worst</span>' +
      '<span class="pt-h" title="How much the ping jumps from one reply to the next">Jitter</span><span class="pt-h" title="Pings that never came back">Loss</span>';
    rows.forEach((r) => {
      const b = bad(r), dead = !r.got && r.sent > 0;
      const name = r.kind === 'router' ? 'Your router' : r.name;
      const tip = r.kind === 'router' ? `${r.host}${r.iface ? ' on ' + r.iface : ''}` : `${label} ${r.name}: ${r.host}${r.via ? ' (' + r.via + ')' : ''}${r.method === 'tcp' ? ', by connection time' : ''}`;
      h += `<span class="pt-n${r.kind === 'router' ? ' rt' : ''}" title="${esc(tip)}">${esc(name)}${r.best ? ' <b class="pt-best">best</b>' : ''}</span>`;
      if (dead || (r.why && !r.got)) { h += `<span class="pt-x hi pt-span" title="${esc(r.why || '')}">${r.why && /look up/.test(r.why) ? 'name not found' : 'no reply'}</span>`; return; }
      if (!r.sent) { h += '<span class="pt-x pt-span pt-wait">waiting…</span>'; return; }
      h += `<span class="pt-x${b.avg ? ' hi' : ''}">${ms(r.avg)}</span>`;
      h += `<span class="pt-x">${r.min != null ? num(r.min) + '–' + num(r.max) : '--'}</span>`;
      h += `<span class="pt-x${b.jitter ? ' hi' : ''}">${ms(r.jitter)}</span>`;
      h += `<span class="pt-x${b.loss ? ' hi' : ''}">${r.loss != null ? r.loss + '%' : '--'}</span>`;
    });
    return h + '</div>';
  }

  function speed(s, running) {
    const d = s.down || {}, u = s.up || {};
    if (!d.state || !u.state || (d.state === 'waiting' && u.state === 'waiting')) return '';   // before any run, or before the speed phase
    const v = (x) => (x.state === 'ok' ? mbps(x.mbps) : x.state === 'running' ? (x.live != null ? mbps(x.live) : 'measuring…')
      : x.state === 'waiting' ? (running ? 'next' : 'not run') : x.state === 'cancelled' ? 'cancelled' : x.state === 'skipped' ? 'skipped' : 'failed');
    const row = (n, x) => `<div class="row2"><span class="n">${n}</span><span class="x${x.state === 'failed' || x.state === 'skipped' ? ' pt-hi' : ''}">${esc(v(x))}</span></div>`;
    return '<h4>Speed</h4>' + row('Download', d) + row('Upload', u) + [['Download', d], ['Upload', u]].map(([n, x]) => {
      // which server measured it, and why a fallback was used (ptfix: Cloudflare can answer 429)
      if (x.state !== 'ok' || !x.server) return '';
      return `<div class="info"${x.pick ? ` title="${esc('Region: ' + x.pick)}"` : ''}>${n}: ${esc(mbps(x.mbps))} (${esc(x.server)}${x.note ? '; ' + esc(x.note) : ''})</div>`;
    }).join('');
  }

  /** The servers the speed test used, by name: "Linode Fremont and Cloudflare". */
  function usedWith(s) {
    const names = [];
    [s.down, s.up].forEach((x) => { if (x && x.bytes && (x.server || x.host)) { const n = x.server || x.host; if (!names.includes(n)) names.push(n); } });
    return names.length ? names.join(' and ') : (s.host || 'speed.cloudflare.com');
  }

  /** The network a test ran on, in words; short = for a history row. Never a blank. */
  function netWords(w, short) {
    if (!w) return short ? 'network not recorded' : 'The network was not recorded for this test.';
    if (w.name) return short ? w.name : w.kind === 'wifi' ? `On Wi-Fi “${w.name}”` : w.kind === 'ethernet' ? 'On Ethernet (a cable)' : `On ${w.name}`;
    if (short) return w.kind === 'wifi' ? 'Wi-Fi (name hidden)' : 'no network';
    return w.why || (w.kind === 'wifi' ? 'On Wi-Fi: Windows did not give its name' : 'No network was found');
  }
  function wifiLabels(tests) { const seen = []; tests.forEach((t) => { const k = netWords(t.wifi, true); if (!seen.includes(k)) seen.push(k); }); return seen; }
  const stamp = (t) => { try { return new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); } catch (_) { return ''; } };
  const goRow = (act, label, kb, cls) => `<div class="r pt-go${cls ? ' ' + cls : ''}" data-act="${esc(act)}"><span class="ck"></span><span class="lb">${esc(label)}</span><span class="kb">${esc(kb || '')}</span><span class="ar"></span></div>`;

  /** A finished (or running) test's body: the network, the rows, the router line, the speeds, every reason. */
  function result(s, running) {
    const ran = !running && s.phase !== 'idle' && s.phase !== 'starting';
    let h = '';
    if (s.wifi || ran) h += `<div class="info pt-net${s.wifi && !s.wifi.name ? ' pt-hid' : ''}">${esc(netWords(s.wifi, false))}</div>`;
    if (s.wifiChanged) h += `<div class="info bad">${esc(s.wifiChanged.charAt(0).toUpperCase() + s.wifiChanged.slice(1))}</div>`;
    if (s.why) h += `<div class="info bad">${esc(s.why)}</div>`;
    h += table(s);
    if (s.routerWhy) h += `<div class="info bad">${esc(s.routerWhy)}</div>`;
    if (s.listWhy) h += `<div class="info bad">${esc(s.listWhy)}</div>`;
    (s.rows || []).filter((r) => !r.got && r.why && (!running || r.gaveUp)).forEach((r) => {
      h += `<div class="info bad">${esc(r.kind === 'router' ? 'Your router' : r.name)}: ${esc(r.why)}</div>`;
    });
    if (!running && s.phase !== 'ping') {
      const v = verdict(s);
      if (v) h += `<div class="info pt-verdict${v.bad ? ' bad' : ''}">${esc(v.text)}</div>`;
    }
    if ((s.rows || []).length && (ran || s.phase === 'down' || s.phase === 'up')) {
      h += `<div class="info pt-key">Jitter: how much the ping jumps between replies. Loss: pings that never came back. Amber: ${WARN.avg}+ ms (router ${WARN.routerAvg}+), jitter ${WARN.jitter}+ ms, any loss.</div>`;
    }
    h += speed(s, running);
    [s.down, s.up].forEach((x) => { if (x && x.why) h += `<div class="info bad">Speed test, ${esc(x.why)}</div>`; });
    if (ran && ((s.down && s.down.bytes) || (s.up && s.up.bytes))) {
      h += `<div class="info">Used ${mb((s.down ? s.down.bytes : 0) + (s.up ? s.up.bytes : 0))} of data with ${esc(usedWith(s))}.</div>`;
    }
    return h;
  }

  /** The name box (save / rename), or the Save… / Rename… / Delete rows, for one history entry. */
  function entryActions(e, full) {
    let h = '';
    if (H.edit && H.edit.id === e.id) {
      h += '<div class="pt-edit"><input class="pt-name" type="text" maxlength="60" spellcheck="false" placeholder="Name this test, e.g. upstairs" aria-label="Test name"></div>';
      h += goRow('pt-commit', H.edit.mode === 'save' ? 'Save' : 'Rename', 'Enter') + goRow('pt-uncommit', 'Cancel', 'Esc', 'pt-quiet');
      return h;
    }
    if (!e.saved) h += goRow(`pt-save:${e.id}`, 'Save…', 'name it, keep it for good');
    else h += goRow(`pt-rename:${e.id}`, 'Rename…', '');
    if (full) h += goRow(`pt-del:${e.id}`, H.armed === e.id ? 'Delete: click again to confirm' : 'Delete', '', H.armed === e.id ? 'armed' : 'pt-quiet');
    return h;
  }

  function testHtml() {
    if (readFailedAt && !asking && Date.now() - readFailedAt > 5000) read();   // e.g. the sidecar was not up yet at load
    const s = st || { phase: 'idle' };
    const c = caps();
    const total = Math.round((c.downBytes + c.upBytes) / 1e6);
    const secs = Math.round((c.rounds * c.periodMs + c.downMs + c.upMs) / 1000 / 5) * 5;
    const running = !!s.running;
    const ran = !running && s.phase !== 'idle' && s.phase !== 'starting';
    const when = s.endedAt ? clock(s.endedAt) : s.startedAt ? clock(s.startedAt) : '';
    const id = s.startedAt && s.run ? `${s.startedAt}-${s.run}` : null;
    const kept = id && H.list ? H.list.tests.find((x) => x.id === id) : null;
    let h = `<h4>Ping test${running ? '' : s.phase === 'done' ? ' · ' + esc(when) : s.phase === 'cancelled' ? ' · cancelled ' + esc(when) : s.phase === 'failed' ? ' · failed ' + esc(when) : ''}</h4>`;
    if (kept && kept.saved) h += `<div class="info">Saved as “${esc(kept.name)}”.</div>`;
    if (running) {
      h += `<progress class="pt-prog" max="1000" value="${Math.round(Math.max(0, Math.min(1, s.progress || 0)) * 1000)}"></progress>`;
      h += `<div class="info pt-step">${esc(stepWords(s))}</div>`;
    }
    h += result(s, running);
    if (s.phase === 'cancelled') h += '<div class="info">Cancelled: what it measured before that is above.</div>';
    if (s.test) h += `<div class="info">${esc(s.test)}</div>`;
    if (err) h += `<div class="info bad">${esc(err)}</div>`;
    if (H.msg) h += `<div class="info bad">${esc(H.msg)}</div>`;
    if (running) h += goRow('pt-cancel', 'Cancel', '');
    else {
      if (kept) h += entryActions(kept, false);
      h += goRow('pt-start', ran ? 'Run again' : 'Run ping test', `about ${secs} s · up to ${total} MB`);
      if (!ran) h += `<div class="info">Pings every ${esc(s.label || 'Valorant')} location and your router ${c.rounds} times, then measures download and upload speed with ${esc(s.host || 'speed.cloudflare.com')} (download from a nearby Linode server if Cloudflare is busy). Uses up to ${total} MB of data.</div>`;
    }
    return h;
  }

  function historyHtml() {
    const v = H.list || { tests: [], problem: null, max: 50 };
    const tests = v.tests || [];
    let h = '';
    if (v.problem) h += `<div class="info bad">${esc(v.problem.charAt(0).toUpperCase() + v.problem.slice(1))}</div>`;
    if (H.msg) h += `<div class="info bad">${esc(H.msg)}</div>`;
    const e = H.open ? tests.find((x) => x.id === H.open) : null;
    if (H.open && !e) H.open = null;
    if (e) {   // one test, in full
      h += `<h4>${e.saved ? esc(e.name) + ' · ' : ''}${esc(stamp(e.at))}</h4>`;
      h += result(Object.assign({ phase: 'done' }, e), false);
      h += entryActions(e, true);
      h += goRow('pt-back', 'Back to history', '', 'pt-quiet');
      return h;
    }
    if (!tests.length) return h + `<div class="info">No tests yet. Every finished test is kept here: the last ${v.max || 50}, and every one you save, for good.</div>`;
    const ws = wifiLabels(tests);
    if (H.filter && !ws.includes(H.filter)) H.filter = null;
    if (ws.length > 1) {
      h += '<div class="pt-chips">' + `<span class="r pt-chip${H.filter ? '' : ' on'}" data-act="pt-filter:all">All</span>` +
        ws.map((w, i) => `<span class="r pt-chip${H.filter === w ? ' on' : ''}" data-act="pt-filter:${i}" title="${esc(w)}">${esc(w)}</span>`).join('') + '</div>';
    }
    const shown = H.filter ? tests.filter((t) => netWords(t.wifi, true) === H.filter) : tests;
    const sp = (x) => (x && x.mbps != null ? (x.mbps >= 100 ? String(Math.round(x.mbps)) : (Math.round(x.mbps * 10) / 10).toFixed(1)) : '--');
    h += '<div class="pt-hl">';
    shown.forEach((t) => {
      const b = t.best;
      h += `<div class="r pt-hrow" data-act="pt-open:${esc(t.id)}" title="${esc(stamp(t.at))}">` +
        `<span class="pt-hn">${t.saved ? `<b>${esc(t.name)}</b> <i class="pt-saved">saved</i>` : esc(stamp(t.at))}</span>` +
        `<span class="pt-hw${t.wifi && t.wifi.name ? '' : ' pt-hid'}">${esc(netWords(t.wifi, true))}</span>` +
        `<span class="pt-hb${b && anyBad(b) ? ' hi' : ''}">${b ? esc(ms(b.avg)) : '--'}</span>` +
        `<span class="pt-hs">↓${sp(t.down)} ↑${sp(t.up)}</span></div>`;
    });
    h += '</div>';
    const unsaved = tests.filter((t) => !t.saved).length;
    h += `<div class="info">Click a test to see it in full, save it under a name, or delete it. Kept: the last ${v.max || 50} unsaved (${unsaved} now) and every saved one.</div>`;
    return h;
  }

  /** The ping test's part of the PING dropdown (appended by topbar.js): two tabs, Test and History. */
  function html() {
    const n = H.list && H.list.tests ? H.list.tests.length : 0;
    let h = '<div class="sep"></div><div class="pt">';
    h += `<div class="pt-tabs" role="tablist"><span class="r pt-tab${H.tab === 'test' ? ' on' : ''}" role="tab" data-act="pt-tab:test">Test</span>` +
      `<span class="r pt-tab${H.tab === 'history' ? ' on' : ''}" role="tab" data-act="pt-tab:history">History${n ? ' · ' + n : ''}</span></div>`;
    h += H.tab === 'history' ? historyHtml() : testHtml();
    return h + '</div>';
  }

  window.PingTest = { init, html, act, key, after, bad, verdict, netWords, WARN, state: () => st, history: () => H };
})();

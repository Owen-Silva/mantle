// test-elevate.js - the elevation broker (Elevate.cs, ELEVATE.md), with NO UAC prompt, ever.
//
//   MANTLE_SIDECAR_EXE=<your built exe> node sidecar/test-elevate.js
//
// HOW IT STAYS SAFE: it refuses to run elevated, and it sets MANTLE_ELEVATE_TEST=1 plus a
// scratch MANTLE_ELEVATE_DIR before spawning anything. A passive sidecar in test mode launches
// the administrator step with ShellExecuteEx "open" (the exe is asInvoker: no prompt), and the
// step itself refuses every real action after validating it. The `--elevated` checks spawn the
// step directly (a plain CreateProcess never elevates). The one sidecar started WITHOUT the
// variable gets requests that two independent guards refuse (passive, and test-only args).
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const T = require('./test-lib');
const elevate = require('../lib/elevate');

const PASSIVE_REFUSAL = T.PASSIVE_REFUSAL || 'refused: sidecar is passive (test mode)';
const DIR = path.join(os.tmpdir(), `mantle-elevate-test-${process.pid}-${Date.now()}`);
const SYS32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex32 = () => require('crypto').randomBytes(16).toString('hex');

function refuseIfElevated() {
  let groups = '';
  try { groups = execFileSync(path.join(SYS32, 'whoami.exe'), ['/groups'], { encoding: 'utf8' }); } catch (e) {
    console.log(`ELEVATE TEST: cannot tell whether this shell is elevated (${e.message}); not running`);
    process.exit(1);
  }
  if (/S-1-16-(12288|16384)/.test(groups)) {
    console.log('ELEVATE TEST: this shell is ELEVATED; the test only runs unelevated (an elevated step ignores test mode). Not running.');
    process.exit(1);
  }
}

/** Every file in the request folder except the nonce ledger. */
function leftovers() {
  try { return fs.readdirSync(DIR).filter((f) => f !== 'used-nonces.txt'); } catch (_) { return []; }
}

/** Write <nonce>.req.json the way the broker does (content-wise); it inherits the folder's ACL. */
function craft(nonce, body, name) {
  const file = path.join(DIR, name || `${nonce}.req.json`);
  const req = Object.assign({ v: 1, action: 'test.echo', args: { text: 'crafted' }, nonce, createdAt: Date.now(), by: process.pid }, body || {});
  fs.writeFileSync(file, JSON.stringify(req));
  return file;
}

/** SHA-256 (hex) of a file as it is now, the way the broker binds a request to its prompt. */
function sha(file) {
  try { return require('crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch (_) { return '0'.repeat(64); }
}

/** Run `exe --elevated <file> --sha256 <digest>` directly, not elevated. -> { code, answer | null, stderr }
 *  opts.sha: the digest to pass (default: the file's own, as the broker would); null = pass none. */
function step(exe, file, env, opts) {
  const o = opts || {};
  const digest = o.sha === undefined ? sha(file) : o.sha;
  const argv = ['--elevated', file].concat(digest === null ? [] : ['--sha256', digest]);
  return new Promise((resolve) => {
    const p = spawn(exe, argv, { env: env || process.env, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    p.stderr.on('data', (c) => { stderr += c.toString('utf8'); });
    const timer = setTimeout(() => { try { p.kill(); } catch (_) { /* gone */ } }, 15000);
    p.on('exit', (code) => {
      clearTimeout(timer);
      const m = /([0-9a-f]{32})\.req\.json$/.exec(file);
      const res = m ? path.join(DIR, `${m[1]}.res.json`) : null;
      let answer = null;
      if (res && fs.existsSync(res)) {
        try { answer = JSON.parse(fs.readFileSync(res, 'utf8')); } catch (_) { answer = { unreadable: true }; }
        try { fs.unlinkSync(res); } catch (_) { /* fine */ }
      }
      resolve({ code, answer, stderr });
    });
  });
}

/** lib/elevate.js's sidecar shape over test-lib's: send -> {ok,result|error}; on(ev) polls events. */
function adapter(s) {
  return {
    async send(cmd, args, o) {
      const r = await s.send(cmd, args, (o && o.timeoutMs) || 8000).catch((e) => ({ ok: false, error: e.message }));
      return r.ok ? { ok: true, result: r.result } : { ok: false, error: r.error };
    },
    on(ev, fn) {
      let i = s.events.length;
      const t = setInterval(() => { while (i < s.events.length) { const m = s.events[i++]; if (m.ev === ev) fn(m); } }, 25);
      return () => clearInterval(t);
    },
  };
}

(async () => {
  refuseIfElevated();
  const t = T.checker('ELEVATE');
  const exe = T.exePath();
  const logs = [];

  // ---- 1. source: nothing in Elevate.cs can run a shell, a command line or a request's path ----
  const src = fs.readFileSync(path.join(__dirname, 'Elevate.cs'), 'utf8').replace(/\r\n/g, '\n');   // ship trees are CRLF: '.' stops at \r, so '//.*$' would strip no comment
  const code = src.split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');     // comments out
  t.check('source: no Process.Start', !/Process\s*\.\s*Start\s*\(/.test(code) && !/new\s+ProcessStartInfo/.test(code));
  t.check('source: no cmd / powershell / script host / rundll32 / UseShellExecute',
    !/cmd(\.exe)?\b|powershell|pwsh|wscript|cscript|mshta|rundll32|UseShellExecute/i.test(code));
  t.check('source: no loading or instantiating code by name', !/Assembly\s*\.\s*Load|Activator\s*\.|Type\s*\.\s*GetType\s*\(/.test(code));
  const uses = (code.match(/ShellExecuteEx\w*\s*\(/g) || []).length;
  const decls = (code.match(/extern\s+bool\s+ShellExecuteExW\s*\(/g) || []).length;
  t.check('source: exactly one ShellExecuteEx call (plus its declaration)', decls === 1 && uses - decls === 1, `${uses - decls} calls, ${decls} declarations`);
  t.check('source: it launches THIS exe, nothing named in a request', /sei\.lpFile\s*=\s*ExePath\(\)\s*;/.test(code) &&
    /static string ExePath\(\)\s*\{\s*return Assembly\.GetExecutingAssembly\(\)\.Location;\s*\}/.test(code));
  t.check('source: its parameters are --elevated, the request path it wrote and that request\'s digest',
    /sei\.lpParameters\s*=\s*"--elevated \\""\s*\+\s*f\.ReqPath\s*\+\s*"\\" --sha256 "\s*\+\s*f\.Digest\s*;/.test(code));
  t.check('source: runas only outside the seam', /sei\.lpVerb\s*=\s*seam\s*\?\s*"open"\s*:\s*"runas"\s*;/.test(code) &&
    (code.match(/"runas"/g) || []).length === 1);
  t.check('source: the passive refusal comes before any launch',
    code.indexOf('if (Program.Passive && !seam) return FeatureTable.PassiveRefusal;') > 0 &&
    code.indexOf('if (Program.Passive && !seam) return FeatureTable.PassiveRefusal;') < code.indexOf('new Thread(delegate () { Launch('));
  // ELEVATE.md says the truth: every [Elevated] action in the sidecar is named in it.
  const md = fs.readFileSync(path.join(__dirname, 'ELEVATE.md'), 'utf8');
  const declared = new Set();
  for (const f of fs.readdirSync(__dirname).filter((x) => /\.cs$/.test(x))) {
    for (const line of fs.readFileSync(path.join(__dirname, f), 'utf8').split(/\r?\n/)) {
      const m = /^\s*\[Elevated\("([^"]+)"/.exec(line);
      if (m) declared.add(m[1]);
    }
  }
  const undocumented = [...declared].filter((a) => !md.includes('`' + a + '`'));
  t.check('ELEVATE.md names every [Elevated] action', declared.size > 1 && undocumented.length === 0, `missing: ${undocumented.join(', ')}`);
  const prog = fs.readFileSync(path.join(__dirname, 'Program.cs'), 'utf8');
  t.check('source: Program.Main dispatches --elevated before the pipe exists',
    prog.indexOf('return Elevate.RunElevated(args)') > 0 && prog.indexOf('return Elevate.RunElevated(args)') < prog.indexOf('_out = new StreamWriter('));

  if (!fs.existsSync(exe)) {
    t.check(`the exe exists (${exe})`, false, 'build one: sidecar/build.ps1 -Out <path>, then MANTLE_SIDECAR_EXE=<path>');
    process.exit(t.summary());
  }

  // ---- 2. a passive sidecar WITHOUT the test variable: two guards, never a launch ----
  for (const k of ['MANTLE_ELEVATE_TEST', 'MANTLE_ELEVATE_DIR']) delete process.env[k];
  const plain = await T.startPassive({ exe });
  try {
    const l = await plain.send('elevate.list', {}, 8000);
    t.check('no test variable: test.echo does not exist', l.ok && !l.result.actions.some((a) => a.action === 'test.echo') && l.result.test === false, JSON.stringify(l).slice(0, 200));
    t.check('no test variable: system.renamePc is listed with its words',
      l.ok && l.result.actions.some((a) => a.action === 'system.renamePc' && a.does === 'rename this PC'));
    t.check('no test variable: no [Elevated] method was left out', l.ok && l.result.problems.length === 0, JSON.stringify(l.result && l.result.problems));
    const bad = await plain.send('elevate.run', { action: 'system.renamePc', args: { name: 'bad name' } }, 8000);
    t.check('no test variable: the validator still refuses first', !bad.ok && /cannot contain spaces/.test(bad.error), bad.error);
    // Valid args AND a test-only knob: the passive guard refuses; if it ever did not, the
    // test-only guard would. Neither path launches anything.
    const good = await plain.send('elevate.run', { action: 'system.renamePc', args: { name: os.hostname() }, testSimulate: 'cancel' }, 8000);
    t.check('no test variable: a passive sidecar refuses to ask', !good.ok && good.error === PASSIVE_REFUSAL, good.error);
  } finally { await plain.stop(); }

  // ---- from here on: TEST MODE ----
  process.env.MANTLE_ELEVATE_TEST = '1';
  process.env.MANTLE_ELEVATE_DIR = DIR;
  const s = await T.startPassive({ exe });
  try {
    const l = await s.send('elevate.list', {}, 8000);
    t.check('test mode: test.echo and system.renamePc exist', l.ok && l.result.test === true &&
      ['test.echo', 'system.renamePc'].every((n) => l.result.actions.some((a) => a.action === n)), JSON.stringify(l).slice(0, 300));

    // ---- 3. whitelist ----
    for (const action of ['system.formatDisk', 'cmd.exe', '../x', '', 42]) {
      const r = await s.send('elevate.run', { action, args: {} }, 8000);
      t.check(`whitelist: ${JSON.stringify(action)} is refused`, !r.ok && /not an administrator action|no administrator action/.test(r.error), r.error);
    }
    t.check('whitelist: a refused action wrote no request', leftovers().length === 0, leftovers().join(','));

    // ---- 4. validator, broker side ----
    const refusals = [
      [{ name: 'has space' }, /cannot contain spaces/],
      [{ name: '12345' }, /only numbers/],
      [{ name: 'a'.repeat(16) }, /at most 15/],
      [{ name: 'bad_name' }, /only use letters/],
      [{ name: '-edge' }, /start or end with a hyphen/],
      [{ name: '' }, /cannot be empty/],
      [{ name: 7 }, /name is needed/],
      [{ name: 'OK', extra: 1 }, /"extra" is not something/],
    ];
    for (const [args, rx] of refusals) {
      const r = await s.send('elevate.run', { action: 'system.renamePc', args }, 8000);
      t.check(`validator (broker): renamePc ${JSON.stringify(args)} refused`, !r.ok && rx.test(r.error), r.error);
    }
    const echoBad = await s.send('elevate.run', { action: 'test.echo', args: { text: 'refuse-me' } }, 8000);
    t.check('validator (broker): test.echo refuse-me refused', !echoBad.ok && /refuses "refuse-me"/.test(echoBad.error), echoBad.error);
    const notObj = await s.send('elevate.run', { action: 'test.echo', args: [1, 2] }, 8000);
    t.check('validator (broker): args that are not an object are refused', !notObj.ok && /must be a JSON object/.test(notObj.error), notObj.error);
    t.check('validator (broker): nothing was written for a refusal', leftovers().length === 0, leftovers().join(','));

    // ---- 5. the round trip, through the real --elevated entry (verb "open") ----
    const run = await s.send('elevate.run', { action: 'test.echo', args: { text: 'hello' } }, 8000);
    t.check('round trip: elevate.run answers at once with a ticket', run.ok && typeof run.result.ticket === 'number' && run.result.test === true, JSON.stringify(run));
    if (run.ok) {
      const ev = await s.waitEvent('elevate', 20000, (e) => e.ticket === run.result.ticket).catch((e) => ({ err: e.message }));
      t.check('round trip: the outcome event carries the args back', ev.ok === true && ev.kind === 'ok' && ev.result && ev.result.args && ev.result.args.text === 'hello', JSON.stringify(ev).slice(0, 300));
      t.check('round trip: the step ran NOT elevated (test seam)', ev.result && ev.result.elevated === false);
      const st = await s.send('elevate.status', { ticket: run.result.ticket }, 8000);
      t.check('round trip: elevate.status remembers it', st.ok && st.result.state === 'done' && st.result.ok === true, JSON.stringify(st).slice(0, 200));
      t.check('round trip: no request or answer file is left', leftovers().length === 0, leftovers().join(','));
    }
    const unknownTicket = await s.send('elevate.status', { ticket: 999999 }, 8000);
    t.check('status: an unknown ticket says so', !unknownTicket.ok && /no administrator step has ticket/.test(unknownTicket.error), unknownTicket.error);

    // ---- 6. ERROR_CANCELLED ----
    const cancel = await s.send('elevate.run', { action: 'test.echo', args: { text: 'x' }, testSimulate: 'cancel' }, 8000);
    const cev = cancel.ok ? await s.waitEvent('elevate', 8000, (e) => e.ticket === cancel.result.ticket).catch((e) => ({ err: e.message })) : {};
    t.check('cancel: ERROR_CANCELLED maps to its words', cev.ok === false && cev.kind === 'cancelled' &&
      cev.reason === "you said no to the administrator prompt, so Mantle did not run Mantle's test action", JSON.stringify(cev));
    t.check('cancel: the request file was removed', leftovers().length === 0, leftovers().join(','));
    // A "No" is not asked again at once: a page stuck in a loop cannot hold the screen with prompts.
    const again = await s.send('elevate.run', { action: 'test.echo', args: { text: 'x' } }, 8000);
    t.check('after a No: the next ask right away is refused, in plain words', !again.ok && /you said no a moment ago/.test(again.error || ''), JSON.stringify(again));
    t.check('after a No: the refusal wrote no request', leftovers().length === 0, leftovers().join(','));
    await sleep(3200);

    // ---- 7. timeouts: never started, and started ----
    const hang = await s.send('elevate.run', { action: 'test.echo', args: { text: 'x' }, testSimulate: 'hang', testTimeoutMs: 1200 }, 8000);
    const busy = await s.send('elevate.run', { action: 'test.echo', args: { text: 'y' } }, 8000);
    t.check('one prompt at a time: a second ask is refused', !busy.ok && /already open/.test(busy.error), busy.error);
    const hev = hang.ok ? await s.waitEvent('elevate', 8000, (e) => e.ticket === hang.result.ticket).catch((e) => ({ err: e.message })) : {};
    t.check('timeout (never started): its words, and nothing changed', hev.kind === 'timeout' &&
      /did not answer in 1\.2 s, so nothing was changed/.test(hev.reason || ''), JSON.stringify(hev));
    t.check('timeout (never started): the request is gone, so a late yes runs nothing', leftovers().length === 0, leftovers().join(','));

    const slow = await s.send('elevate.run', { action: 'test.echo', args: { text: 'slow', sleepMs: 2500 }, testTimeoutMs: 800 }, 8000);
    const sev = slow.ok ? await s.waitEvent('elevate', 8000, (e) => e.ticket === slow.result.ticket).catch((e) => ({ err: e.message })) : {};
    t.check('timeout (started): says it may still happen', sev.kind === 'timeout' && /had already started, so it may still run Mantle's test action/.test(sev.reason || ''), JSON.stringify(sev));
    const late = await s.waitEvent('log', 10000, (e) => /answered after Mantle had given up: it DID run Mantle's test action/.test(e.message || '')).catch((e) => ({ err: e.message }));
    t.check('timeout (started): the late answer is logged, not dropped', !!late.message, JSON.stringify(late));

    // ---- 8. the elevated step on its own: stale, reused, foreign-writable, and friends ----
    const n1 = hex32();
    const ok1 = await step(exe, craft(n1, { args: { text: 'direct' } }));
    t.check('step: a good request runs (exit 0) and answers', ok1.code === 0 && ok1.answer && ok1.answer.ok === true && ok1.answer.nonce === n1 &&
      ok1.answer.result.args.text === 'direct', JSON.stringify(ok1).slice(0, 300));
    t.check('step: the request was used up', !fs.existsSync(path.join(DIR, `${n1}.req.json`)));
    const reuse = await step(exe, craft(n1, { args: { text: 'again' } }));
    t.check('step: a reused nonce is refused', reuse.code === 1 && reuse.answer && reuse.answer.ok === false && /already used once/.test(reuse.answer.reason), JSON.stringify(reuse.answer));

    const n2 = hex32();
    const stale = await step(exe, craft(n2, { createdAt: Date.now() - 120000 }));
    t.check('step: a stale request is refused', stale.code === 1 && /s old \(the limit is 60 s\)/.test((stale.answer || {}).reason || ''), JSON.stringify(stale.answer));
    const n3 = hex32();
    const future = await step(exe, craft(n3, { createdAt: Date.now() + 60000 }));
    t.check('step: a request from the future is refused', future.code === 1 && /dated in the future/.test((future.answer || {}).reason || ''), JSON.stringify(future.answer));

    const n4 = hex32();
    const foreignFile = craft(n4);
    execFileSync(path.join(SYS32, 'icacls.exe'), [foreignFile, '/grant', '*S-1-5-32-545:(W)'], { stdio: 'ignore' });
    const foreign = await step(exe, foreignFile);
    t.check('step: a request other users can write is refused', foreign.code === 1 && /request file can be changed by/.test((foreign.answer || {}).reason || ''), JSON.stringify(foreign.answer));

    const n5 = hex32();
    const unknown = await step(exe, craft(n5, { action: 'system.formatDisk', args: {} }));
    t.check('step: the whitelist is enforced on the elevated side', unknown.code === 1 && /not an administrator action/.test((unknown.answer || {}).reason || ''), JSON.stringify(unknown.answer));
    const n6 = hex32();
    const val = await step(exe, craft(n6, { action: 'system.renamePc', args: { name: 'bad name' } }));
    t.check('step: the validator is enforced on the elevated side (renamePc)', val.code === 1 && /cannot contain spaces/.test((val.answer || {}).reason || ''), JSON.stringify(val.answer));
    const n7 = hex32();
    const val2 = await step(exe, craft(n7, { args: { text: 'refuse-me' } }));
    t.check('step: the validator is enforced on the elevated side (test.echo)', val2.code === 1 && /refuses "refuse-me"/.test((val2.answer || {}).reason || ''), JSON.stringify(val2.answer));
    // A VALID real action in test mode is checked and NOT run. The name is this PC's own, so even
    // a broken guard would change nothing (and an unelevated step could not rename anyway).
    if (/^[A-Za-z0-9-]{1,15}$/.test(os.hostname()) && !/^\d+$/.test(os.hostname())) {
      const n8 = hex32();
      const real = await step(exe, craft(n8, { action: 'system.renamePc', args: { name: os.hostname() } }));
      t.check('step: test mode never runs a real action', real.code === 1 && /test mode .* NOT run/.test((real.answer || {}).reason || ''), JSON.stringify(real.answer));
    } else console.log(`(skipped the real-action guard check: this PC's name "${os.hostname()}" is not a valid new name)`);

    const n9 = hex32();
    const mism = await step(exe, craft(n9, { nonce: hex32() }));
    t.check('step: a nonce that does not match the file name is refused', mism.code === 1 && /does not match/.test((mism.answer || {}).reason || ''), JSON.stringify(mism.answer));
    const n10 = hex32();
    const gone = await step(exe, path.join(DIR, `${n10}.req.json`));
    t.check('step: a missing request is refused', gone.code === 1 && /request is gone/.test((gone.answer || {}).reason || ''), JSON.stringify(gone.answer));
    const outside = path.join(os.tmpdir(), `${hex32()}.req.json`);
    fs.writeFileSync(outside, '{}');
    const out = await step(exe, outside);
    t.check('step: a request outside the folder is refused (exit 2, no answer)', out.code === 2 && out.answer === null, JSON.stringify(out));
    try { fs.unlinkSync(outside); } catch (_) { /* fine */ }
    const oddName = craft(hex32(), {}, 'evil.req.json');
    const odd = await step(exe, oddName);
    t.check('step: a request with a made-up name is refused (exit 2)', odd.code === 2 && odd.answer === null, JSON.stringify(odd));
    try { fs.unlinkSync(oddName); } catch (_) { /* fine */ }

    // ---- 8b. the request is BOUND to its prompt, and the step never writes through a link ----
    const n12 = hex32();
    const f12 = craft(n12, { args: { text: 'what Owen was asked' } });
    const d12 = sha(f12);
    craft(n12, { args: { text: 'swapped in during the prompt' } });
    const swapped = await step(exe, f12, undefined, { sha: d12 });
    t.check('bound: a request changed after Windows was asked is refused', swapped.code === 1 && /changed after Windows asked/.test((swapped.answer || {}).reason || ''), JSON.stringify(swapped.answer));
    const n13 = hex32();
    const unbound = await step(exe, craft(n13), undefined, { sha: null });
    t.check('bound: a step started without the digest is refused', unbound.code === 1 && /not bound/.test((unbound.answer || {}).reason || ''), JSON.stringify(unbound.answer));
    const n13b = hex32();
    const badSha = await step(exe, craft(n13b), undefined, { sha: 'zz' });
    t.check('bound: a malformed digest is refused', badSha.code === 1 && /not bound/.test((badSha.answer || {}).reason || ''), JSON.stringify(badSha.answer));

    // Links: the elevated step must never write, truncate or delete a file OUTSIDE its folder through
    // a link planted in it (a same-user attacker's classic lever on an administrator process).
    const CAN = path.join(os.tmpdir(), `mantle-elevate-canary-${process.pid}-${Date.now()}`);
    fs.mkdirSync(CAN, { recursive: true });
    const ledger = path.join(DIR, 'used-nonces.txt');
    const canary = path.join(CAN, 'ledger-canary.txt');
    fs.writeFileSync(canary, 'CANARY-LEDGER');
    try { fs.unlinkSync(ledger); } catch (_) { /* none yet */ }
    fs.linkSync(canary, ledger);
    const n14 = hex32();
    const viaLedger = await step(exe, craft(n14));
    t.check('links: a hard-linked nonce ledger is refused', viaLedger.code === 1 && /link/.test((viaLedger.answer || {}).reason || ''), JSON.stringify(viaLedger.answer));
    t.check('links: the file behind the ledger link is untouched', fs.readFileSync(canary, 'utf8') === 'CANARY-LEDGER', fs.readFileSync(canary, 'utf8').slice(0, 80));
    try { fs.unlinkSync(ledger); } catch (_) { /* fine */ }

    const n15 = hex32();
    const reqCanary = path.join(CAN, 'request-canary.json');
    fs.writeFileSync(reqCanary, JSON.stringify({ v: 1, action: 'test.echo', args: { text: 'linked' }, nonce: n15, createdAt: Date.now(), by: process.pid }));
    const reqLink = path.join(DIR, `${n15}.req.json`);
    fs.linkSync(reqCanary, reqLink);
    const viaReq = await step(exe, reqLink);
    t.check('links: a hard-linked request is refused and not run', viaReq.code === 1 && /link/.test((viaReq.answer || {}).reason || ''), JSON.stringify(viaReq.answer));
    t.check('links: the file behind the request link still exists', fs.existsSync(reqCanary));
    try { fs.unlinkSync(reqLink); } catch (_) { /* used up */ }

    const n16 = hex32();
    const tmpCanary = path.join(CAN, 'answer-tmp-canary.txt');
    const resCanary = path.join(CAN, 'answer-canary.txt');
    fs.writeFileSync(tmpCanary, 'CANARY-TMP');
    fs.writeFileSync(resCanary, 'CANARY-RES');
    fs.linkSync(tmpCanary, path.join(DIR, `${n16}.res.json.tmp`));
    fs.linkSync(resCanary, path.join(DIR, `${n16}.res.json`));
    const viaAns = await step(exe, craft(n16, { args: { text: 'answer links' } }));
    t.check('links: planted answer links do not stop a good request', viaAns.code === 0 && viaAns.answer && viaAns.answer.ok === true, JSON.stringify(viaAns.answer));
    t.check('links: the files behind the answer links are untouched', fs.readFileSync(tmpCanary, 'utf8') === 'CANARY-TMP' && fs.readFileSync(resCanary, 'utf8') === 'CANARY-RES',
      fs.readFileSync(tmpCanary, 'utf8').slice(0, 40) + ' / ' + fs.readFileSync(resCanary, 'utf8').slice(0, 40));
    try { fs.unlinkSync(path.join(DIR, `${n16}.res.json.tmp`)); } catch (_) { /* replaced */ }

    // A symbolic link needs Developer Mode or an administrator; skipped (and said so) when Windows refuses one.
    const symCanary = path.join(CAN, 'symlink-canary.txt');
    fs.writeFileSync(symCanary, 'CANARY-SYM');
    let symOk = false;
    try { fs.unlinkSync(ledger); } catch (_) { /* none */ }
    try { fs.symlinkSync(symCanary, ledger, 'file'); symOk = true; } catch (e) { console.log(`(skipped the symlink check: Windows refused to make one here, ${e.code})`); }
    if (symOk) {
      const n17 = hex32();
      const viaSym = await step(exe, craft(n17));
      t.check('links: a symlinked nonce ledger is refused', viaSym.code === 1 && /link/.test((viaSym.answer || {}).reason || ''), JSON.stringify(viaSym.answer));
      t.check('links: the file behind the symlink is untouched', fs.readFileSync(symCanary, 'utf8') === 'CANARY-SYM');
      try { fs.unlinkSync(ledger); } catch (_) { /* fine */ }
    }
    // The folder as a junction (no privilege needed to make one): the step refuses with exit 2 and
    // writes NOTHING through it (before: it wrote its answer into the junction's target).
    const JT = path.join(CAN, 'junction-target');
    fs.mkdirSync(JT);
    const JL = path.join(CAN, 'junction');
    fs.symlinkSync(JT, JL, 'junction');
    const n18 = hex32();
    const viaJunction = path.join(JL, `${n18}.req.json`);
    fs.writeFileSync(viaJunction, JSON.stringify({ v: 1, action: 'test.echo', args: { text: 'junction' }, nonce: n18, createdAt: Date.now(), by: process.pid }));
    const jr = await step(exe, viaJunction, Object.assign({}, process.env, { MANTLE_ELEVATE_DIR: JL }));
    const jfiles = fs.readdirSync(JT);
    t.check('links: a request folder that is a junction is refused (exit 2)', jr.code === 2, JSON.stringify({ code: jr.code, answer: jr.answer }));
    t.check('links: nothing was written or used up behind the junction', jfiles.length === 1 && jfiles[0] === `${n18}.req.json`, jfiles.join(','));
    try { fs.unlinkSync(JL); } catch (_) { try { fs.rmdirSync(JL); } catch (__) { /* scratch */ } }
    try { fs.rmSync(CAN, { recursive: true, force: true }); } catch (_) { /* scratch */ }

    // The folder itself: open it to other users, the step refuses; the broker's next ask makes it private again.
    execFileSync(path.join(SYS32, 'icacls.exe'), [DIR, '/grant', '*S-1-5-32-545:(W)'], { stdio: 'ignore' });
    const n11 = hex32();
    const openDir = await step(exe, craft(n11));
    t.check('step: a request folder other users can write is refused', openDir.code === 1 && /request folder can be changed by/.test((openDir.answer || {}).reason || ''), JSON.stringify(openDir.answer));

    // ---- 9. lib/elevate.js over the same sidecar (this also re-privatises the folder) ----
    const ad = adapter(s);
    const lr = await elevate(ad, 'test.echo', { text: 'via lib' }, { why: 'test-elevate', log: (x) => logs.push(x) });
    t.check('lib: elevate() round-trips through the broker', lr.ok === true && lr.kind === 'ok' && lr.result.args.text === 'via lib', JSON.stringify(lr).slice(0, 300));
    t.check('lib: the broker made the folder private again', !/Users/.test(execFileSync(path.join(SYS32, 'icacls.exe'), [DIR], { encoding: 'utf8' }).split('\n').filter((x) => /BUILTIN\\Users/.test(x)).join('')));
    const lv = await elevate('test.echo', { text: 'refuse-me' }, { sidecar: ad, via: 'settings.test', log: (x) => logs.push(x) });
    t.check('lib: a validator refusal is kind "refused" with its words', lv.ok === false && lv.kind === 'refused' && /refuses "refuse-me"/.test(lv.reason), JSON.stringify(lv));
    t.check('lib: logs name the action, never the args', logs.length > 0 && logs.every((x) => !/via lib|refuse-me/.test(x)) && logs.some((x) => /test\.echo/.test(x)), logs.join(' | '));
  } finally {
    await s.stop();
    try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (_) { /* scratch */ }
  }
  process.exit(t.summary());
})().catch((e) => { console.log(`ELEVATE TEST: crashed: ${e.stack || e.message}`); process.exit(1); });

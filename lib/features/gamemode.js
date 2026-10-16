'use strict';
/* gamemode.js - Game mode (lane gamemode, 2026-09-25). Owen: "a custom gaming mode that optimizes
 * absolutly everything we possibly can to get the best performance in game".
 *
 * ON: by itself when a game is in front (lib/features/_gamemode-plan.js detectGame: Valorant,
 * Minecraft Java's javaw with a Minecraft window, Roblox, the other known games, anything on Windows'
 * own Game Bar list that fills its monitor, or exclusive full-screen Direct3D), or by hand from the
 * quick-settings tile. OFF: the game exits, it has not been in front for 90 s, the tile, the tray
 * switch, or Mantle quitting. Whatever was changed is put back, and a record in
 * <userData>/gamemode-restore.json (live: %APPDATA%\mantle) puts it back after a crash or a kill.
 *
 * WHAT IT DOES (each kept for a measured or documented reason - see the lane report):
 *   power       Best performance for the power source in use; the old choice back after. Energy saver
 *               pins efficiency on battery: said plainly, and only lifted when Owen switched that on.
 *   background  Efficiency mode (EcoQoS) + below-normal priority for Owen's other apps - never the
 *               game, anti-cheat, voice, music, recording, input-device software, anything playing
 *               sound, the app in front, Windows' own parts, or Mantle's sidecar.
 *   mantle      Mantle's own Electron processes get the same (the sidecar never: it runs the key hook).
 *   boost       (lane mantle-boost, 2026-10-15; option `boost`, default ON) the background easing above
 *               PLUS the memory side: a minute in, each background process that stayed idle hands its
 *               working set back to Windows ONCE (sidecar gamemode.trimbg). Never Helm or Claude (only
 *               eased), never an app's main process or a Chromium helper that is not a page, never
 *               anything playing sound. The tile says what it did: "Freed 1.2 GB and eased 4 background
 *               apps". Switched off, background apps are left as they are (and put back at once mid-game).
 *   wallpaper   Mantle's wallpaper held paused even for a windowed game; Lively (if it runs) paused
 *               with its own documented command `Lively.exe app --play false`.
 * WHAT IT NEVER DOES: open the game for anything but a name; change the game's priority; kill or
 * suspend anything; write the registry; turn on Do not disturb (Windows has no supported way).
 *
 * TEST (ctx.flags.test): a dry run. Everything is planned and shown; no write command is sent, and
 * the passive sidecar would refuse one anyway. */
const fs = require('fs');
const path = require('path');
const P = require('./_gamemode-plan');
const { plain } = require('../plain-error');   // a restore failure is said in words (its text is shown, not keyed)

const IDLE_MS = 3000, ON_MS = 5000, REST_MS = 5000, REPLAN_MS = 30000;
// What a restore could not put back is tried again this often, this many times (lane sysmon-game, 2026-09-29).
const RETRY_MS = 30000, RETRY_MAX = 20;
/** A failed call in words for the tile: never "sidecar", a command name or an error code. */
function plainError(err) {
  const e = String(err || '');
  if (!e || /not running|not ready|stopped|exited|restart|timed? ?out|timeout|closed|EPIPE|ECONN/i.test(e)) return "Mantle's background helper did not answer (it restarts by itself)";
  return e.replace(/\bsidecar\b/gi, 'background helper');
}
const CHUNK = 40;

module.exports = {
  name: 'gamemode',
  label: 'Game mode (quick settings)',
  defaultOn: true,
  chords: [],
  observe: [],
  // Mantle Settings > Mantle (lane settings, 2026-09-28): the same two switches as the quick-settings
  // card's, in the same settings store (lib/features.js OPTIONS). Read each time (set() below).
  options: [
    { key: 'auto', label: 'Turn on by itself for games', help: 'Game mode starts when a known game starts and ends when it exits', type: 'bool', default: true },
    { key: 'liftSaver', label: 'Lift Energy saver while gaming on battery', help: 'Energy saver forces Best power efficiency; this lifts it for the game and puts it back after', type: 'bool', default: false },
    { key: 'boost', label: 'Boost: free memory and power for the game', help: 'Background apps get Efficiency mode, and a minute in, idle ones hand their unused memory back to Windows once. Nothing is ever closed; everything goes back when the game ends', type: 'bool', default: true },
  ],
  install(ctx, opts) {
    const o = opts || {};                       // tests: { userData, mantlePids(), wallpaper, spawn, now, freemem(), trimAfterMs, idleCpuMs }
    const now = o.now || (() => Date.now());
    const freemem = o.freemem || (() => require('os').freemem());
    const TRIM_AFTER = o.trimAfterMs || P.TRIM_AFTER_MS;
    const dry = !!(ctx.flags && ctx.flags.test) || process.env.MANTLE_GAMEMODE_DRY === '1';
    const userData = o.userData || (() => { try { return require('electron').app.getPath('userData'); } catch (_) { return path.dirname(path.dirname(ctx.settings.file)); } })();
    const RECORD = path.join(userData, 'gamemode-restore.json');
    const S = {
      on: false, how: null, game: null, since: null, suppress: null, busy: null, actions: [], record: null,
      last: null, fromCrash: null, watching: false, reason: 'starting', lastFg: null, lastReplan: 0, replanSoon: false, timer: null, stopped: false,
      // what a restore could not put back yet: {rec, at, tries, text, gaveUp}; ticking = one tick at a time
      leftover: null, ticking: false, again: false, scErr: null,
      // Mantle resting while a game runs (lane memfix): {resting, why, since, text, hold, busy, last}
      rest: { resting: false, why: null, since: null, text: null, hold: null, busy: false, last: null }, runSeen: new Map(), lastRun: [],
      // the boost (lane mantle-boost): {state: off|waiting|trimming|done|failed|blocked|dry, ...} while on;
      // cpuBase = the idle rule's baseline; trimDone = pids trimmed this game (never twice);
      // crashTrim = the pids a crashed instance trimmed for a game that still runs
      boost: null, cpuBase: null, cpuBaseAt: 0, trimDone: new Set(), crashTrim: null, dryEased: [],
    };
    // TEST ONLY: MANTLE_GAMEMODE_TEST_GAME=<exe name>[,<exe name>] counts as a known game RUNNING (never a
    // real game's name: a stand-in exe), so the rest can be proved end to end in a --test instance.
    const TEST_GAMES = ctx.flags && ctx.flags.test && process.env.MANTLE_GAMEMODE_TEST_GAME
      ? String(process.env.MANTLE_GAMEMODE_TEST_GAME).split(',').map((s) => s.trim()).filter(Boolean) : [];
    const set = () => ({ auto: ctx.settings.get('auto', true) !== false, liftSaver: ctx.settings.get('liftSaver', false) === true,
                         boost: ctx.settings.get('boost', true) !== false });

    // A failed call throws PLAIN words for the tile; the raw error goes to the log once per change.
    const sc = async (cmd, args, ms) => {
      const r = await ctx.sidecar.send(cmd, args || {}, { timeoutMs: ms || 6000 });
      if (!r.ok) {
        const raw = `${cmd}: ${r.error}`;
        if (raw !== S.scErr) { S.scErr = raw; ctx.log(raw); }
        throw new Error(plainError(r.error));
      }
      return r.result;
    };
    function writeRecord(rec) {
      if (dry || !rec) return;
      const tmp = RECORD + '.tmp';
      fs.mkdirSync(path.dirname(RECORD), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(rec, null, 1));
      fs.renameSync(tmp, RECORD);
    }
    function saveRecord() { writeRecord(S.record); }
    function dropRecord() { try { fs.unlinkSync(RECORD); } catch (_) { /* none */ } }
    function readRecord() { try { return JSON.parse(fs.readFileSync(RECORD, 'utf8')); } catch (_) { return null; } }

    function view() {
      const st = set();
      return { on: S.on, how: S.how, game: S.game && { file: S.game.file, title: S.game.title, why: S.game.why }, since: S.since,
               busy: S.busy, auto: st.auto, liftSaver: st.liftSaver, boost: st.boost, dry, enabled: ctx.enabled(), watching: S.watching,
               boostNow: S.on && S.boost ? { state: S.boost.state, text: S.boost.text, freed: S.boost.freed, trimmed: S.boost.trimmed,
                                             apps: new Set(S.boost.eased.map((e) => P.baseName(e.file).toLowerCase())).size, warn: !!S.boost.warn } : null,
               reason: S.reason, actions: S.actions, last: S.last, fromCrash: S.fromCrash, record: dry ? null : RECORD,
               rest: { on: S.rest.resting, why: S.rest.why, since: S.rest.since, text: S.rest.text, busy: S.rest.busy, last: S.rest.last },
               leftover: S.leftover && { text: S.leftover.text, tries: S.leftover.tries, gaveUp: !!S.leftover.gaveUp } };
    }
    const push = () => ctx.broadcast('gamemode.state', view());
    ctx.replay('gamemode.state', view);
    const act = (key, label, status, text) => { S.actions = S.actions.filter((a) => a.key !== key).concat([{ key, label, status, text }]); };

    /* ---- power ------------------------------------------------------------------------------ */
    async function applyPower() {
      let st;
      try { st = await sc('powermode.get', {}, 4000); } catch (e) { act('power', 'Power mode', 'failed', `could not be read: ${e.message}`); return; }
      if (!st.ok || !st.available) { act('power', 'Power mode', 'blocked', st.reason || 'Windows would not say'); return; }
      const src = st.source === 'ac' || st.source === 'battery' ? st.source : null;
      const where = src === 'battery' ? 'on battery' : 'plugged in';
      if (st.saver) {
        if (set().liftSaver && src === 'battery' && !(S.record.saver)) {
          if (dry) act('saver', 'Energy saver', 'dry', 'test run: would lift Energy saver (turn-on level 0%) and put your level back after');
          else {
            try {
              const r = await sc('gamemode.saver', { at: 0 });
              if (!r.same && r.ok) { S.record.saver = { was: r.before, set: 0 }; saveRecord(); }
              act('saver', 'Energy saver', r.ok && r.saver < 1 ? 'done' : 'failed',
                r.ok ? (r.saver < 1 ? `lifted for the game (turn-on level ${r.before}% → 0%, put back after)` : 'Energy saver stayed on (it may have been turned on by hand): turn it off in quick settings') : r.reason);
              st = await sc('powermode.get', {}, 4000);
            } catch (e) { act('saver', 'Energy saver', 'failed', e.message); }
          }
        } else if (!S.record.saver) {
          act('saver', 'Energy saver', 'blocked', `Energy saver is on, so Windows keeps Best power efficiency ${where}` + (src === 'battery' && !set().liftSaver
            ? '. To lift it while you play, turn on "Lift Energy saver while gaming on battery" below' : ''));
        }
      } else act('saver', 'Energy saver', 'same', `off ${where}`);
      if (!st.settable) { act('power', 'Power mode', 'blocked', st.saver ? 'not changed while Energy saver is on' : st.reason || 'Windows will not take a power mode now'); return; }
      const mine = st.configured && st.configured[src === 'ac' ? 'ac' : 'battery'];
      if (!src) { act('power', 'Power mode', 'blocked', 'the power source is unknown'); return; }
      if (mine === 'performance') { act('power', 'Power mode', 'same', `Best performance is already your choice ${where}`); return; }
      if (dry) { act('power', 'Power mode', 'dry', `test run: would set Best performance ${where} (now ${mine}) and put it back after`); return; }
      try {
        const r = await sc('gamemode.power', { source: src, mode: 'performance' });
        if (r.ok && !r.same) { S.record.power[src] = { was: r.before, set: 'performance' }; saveRecord(); }
        act('power', 'Power mode', r.ok ? 'done' : 'failed', r.ok ? `Best performance ${where} (was ${r.before}; put back after)` : r.reason);
      } catch (e) { act('power', 'Power mode', 'failed', e.message); }
    }

    /* ---- processes ---------------------------------------------------------------------------- */
    function mantlePids() {
      if (o.mantlePids) return new Set(o.mantlePids());
      try { return new Set(require('electron').app.getAppMetrics().map((m) => m.pid)); } catch (_) { return new Set(); }
    }
    async function audioPids() {
      try {
        const a = await sc('audio', { op: 'sessions' }, 4000);
        return { pids: new Set((a.sessions || []).filter((s) => s.active && s.pid).map((s) => s.pid)), ok: a.ok !== false, reason: a.reason };
      } catch (e) { return { pids: new Set(), ok: false, reason: e.message }; }
    }
    /** "Discord.exe ×2, claude.exe": image names only (a path is cut to its file name), counts. */
    function exeNames(list) {
      const m = new Map();
      for (const x of list) { const k = P.baseName(x && x.file) || '?'; m.set(k, (m.get(k) || 0) + 1); }
      return [...m.entries()].map(([k, n]) => (n > 1 ? `${k} ×${n}` : k)).join(', ');
    }
    async function applyProcs(scan) {
      const au = await audioPids();
      if (!au.ok) { act('background', 'Background apps', 'blocked', `not changed: which apps play sound could not be read (${au.reason}), and a call or music must never be slowed`); return; }
      const done = new Set((S.record.procs || []).map((r) => r.pid));
      const pl = P.plan(scan.procs, { gamePid: S.game && S.game.pid, gameFile: S.game && S.game.file, fgPid: scan.fg && scan.fg.pid,
        sidecarPid: scan.ownPid, ownSession: scan.ownSession, mantlePids: mantlePids(), audioPids: au.pids,
        mainPid: o.mainPid !== undefined ? o.mainPid : process.pid });
      // Boost off: Owen's other apps are left as they are (Mantle's own processes are still eased).
      const boostOn = set().boost;
      const fresh = pl.targets.filter((t) => !done.has(t.pid) && (boostOn || t.group === 'mantle'));
      S.left = pl.left;
      // A slow scan was answered from the last finished one, and some processes had not been read yet
      // (sidecar THE SCAN WORKER): look again at the next tick rather than at the 30 s replan.
      if (pl.pending > 0 && !S.replanSoon) ctx.log(`${pl.pending} background process(es) were still being read; looking again at the next check`);
      S.replanSoon = pl.pending > 0;
      const lines = { background: [], mantle: [] }, failed = [];
      if (dry) {
        for (const t of fresh) lines[t.group].push(t);
      } else {
        for (let i = 0; i < fresh.length; i += CHUNK) {
          const part = fresh.slice(i, i + CHUNK);
          let res;
          try { res = (await sc('gamemode.apply', { items: part.map(P.applyItem) }, 10000)).results || []; }
          catch (e) { failed.push({ file: `${part.length} apps`, why: e.message }); continue; }
          part.forEach((t, k) => {
            const r = res[k];
            const e = P.recordEntry(t, r);
            if (e) { S.record.procs.push(e); lines[t.group].push(t); }
            else if (r && !r.ok && !r.gone) failed.push({ file: t.file, why: (r.eco && r.eco.why) || r.why || 'refused' });
          });
          saveRecord();
        }
      }
      // gamequiet (2026-09-28): which processes were slowed, by IMAGE NAME only ("Discord.exe": never a
      // title, path or command line), one line per new batch, so the next stutter can be checked.
      const slowed = lines.background.concat(lines.mantle);
      if (slowed.length || failed.length) ctx.log(`${dry ? 'dry run: would slow' : 'slowed'} ${slowed.length} process${slowed.length === 1 ? '' : 'es'} (Efficiency mode, below-normal): ${exeNames(slowed) || 'none'}${failed.length ? `; not changed: ${exeNames(failed)}` : ''}`);
      const all = (g) => (S.record.procs || []).filter((r) => r.group === g).concat(dry ? lines[g] : []);
      const verb = dry ? 'test run: would put' : '';
      const bg = all('background'), mt = all('mantle');
      if (dry) S.dryEased = lines.background.slice();
      act('background', 'Background apps', !boostOn && !bg.length ? 'skipped' : dry ? 'dry' : bg.length ? 'done' : 'same',
        (!boostOn && !bg.length ? 'left as they are: the boost is off' : bg.length ? `${verb ? verb + ' ' : ''}Efficiency mode${dry ? '' : ' on'} ${bg.length} app processes: ${P.names(bg, 6)}` : 'nothing to slow down') +
        (failed.length ? `. Not changed: ${P.names(failed, 4)} (${failed[0].why})` : '') +
        (pl.left.length ? `. Left alone: ${P.leftByWhy(pl.left).map((l) => l.text).join('; ')}` : ''));
      act('mantle', 'Mantle itself', dry ? 'dry' : mt.length ? 'done' : 'same',
        mt.length ? `${dry ? 'test run: would put ' : ''}${mt.length} Mantle process${mt.length === 1 ? '' : 'es'} in Efficiency mode at below-normal priority (its keyboard helper keeps normal speed, so keys never lag)` : 'nothing to change');
      boostAct();
    }

    /* ---- the boost: the memory side (lane mantle-boost, 2026-10-15) --------------------------------
     * Easing is applyProcs above. A minute after the CPU baseline (taken when game mode came on), each
     * eased background process that stayed idle hands its working set back to Windows ONCE. Nothing to
     * put back afterwards: trimmed pages come back by themselves when an app touches them. */
    function boostStart() {
      return { state: set().boost ? 'waiting' : 'off', text: null, warn: false, why: null, eased: [], freed: 0, trimmed: 0,
               at: null, freeBefore: null, freeAfter: null, suggest: null, skip: [], refused: [], wouldFree: 0, wouldTrim: 0 };
    }
    const lc = (s) => s.charAt(0).toLowerCase() + s.slice(1);
    /** The boost's words: B.text (the tile's line) and its Details row. */
    function boostAct() {
      const B = S.boost;
      if (!B) return;
      const eased = dry ? S.dryEased : ((S.record && S.record.procs) || []).filter((r) => r.group === 'background');
      B.eased = eased.map((e) => ({ file: e.file }));
      B.warn = false;
      const easedWords = eased.length ? `eased ${P.appCount(eased)}` : 'no background app needed easing';
      const left = B.skip.concat(B.refused);
      const leftWords = left.length ? `. Not trimmed: ${P.leftByWhy(left).map((l) => l.text).join('; ')}` : '';
      let status = 'done', row;
      if (B.state === 'off') {
        B.text = 'Boost is off: background apps are left as they are';
        status = 'skipped'; row = 'off: background apps are left as they are. Switch it on below, or in Settings > Gaming';
      } else if (B.state === 'waiting' || B.state === 'trimming') {
        B.text = `Boost: ${easedWords}; idle memory is handed back a minute in`;
        row = `${easedWords.charAt(0).toUpperCase()}${easedWords.slice(1)} (Efficiency mode, lower priority). A minute in, idle ones hand their unused memory back to Windows once`;
      } else if (B.state === 'dry') {
        status = 'dry';
        B.text = `Test run: the boost would free about ${P.bytes(B.wouldFree)} from ${B.wouldTrim} idle process${B.wouldTrim === 1 ? '' : 'es'} and ${easedWords.replace(/^eased/, 'ease')}`;
        row = B.text + leftWords;
      } else if (B.state === 'done') {
        const line = P.boostLine({ eased, freed: B.freed, trimmed: B.trimmed });
        const free = B.freeAfter != null ? `; ${P.bytes(B.freeAfter)} of memory free now` : '';
        B.text = `Boost: ${lc(line)}${free}`;
        row = `${line}${B.trimmed ? ` (${B.trimmed} idle process${B.trimmed === 1 ? '' : 'es'} handed their unused memory back once)` : '; no idle background process held enough memory to trim'}${free}` +
          (B.suggest ? `. ${B.suggest}` : '') + leftWords;
      } else {                                               // failed / blocked: said, in warning ink
        B.warn = true; status = B.state;
        B.text = set().boost ? `Boost: ${easedWords}, but idle memory was NOT handed back: ${B.why}` : `Boost is off, but ${B.why}`;
        row = set().boost ? `${easedWords.charAt(0).toUpperCase()}${easedWords.slice(1)}. Idle memory was NOT handed back: ${B.why}` : `Switched off, but ${B.why}`;
      }
      act('boost', 'Boost', status, row);
    }
    async function boostTrim(scan) {
      const B = S.boost;
      if (!B || B.state !== 'waiting' || !S.on) return;
      B.state = 'trimming';
      const au = await audioPids();
      if (!au.ok) {
        B.state = 'blocked'; B.why = `which apps play sound could not be read (${au.reason}), and a call or music must never be slowed`;
        ctx.log(`boost: idle memory not handed back: ${B.why}`); boostAct(); return;
      }
      const eased = dry ? S.dryEased : ((S.record && S.record.procs) || []);
      const tp = P.trimPlan(scan.procs, { eased, base: S.cpuBase, audioPids: au.pids, done: S.trimDone, idleCpuMs: o.idleCpuMs });
      B.skip = tp.skip;
      B.freeBefore = freemem();
      if (dry) {
        B.state = 'dry'; B.wouldTrim = tp.trim.length; B.wouldFree = tp.trim.reduce((n, t) => n + (t.ws || 0), 0);
        ctx.log(`boost (DRY RUN): would trim ${tp.trim.length} idle process${tp.trim.length === 1 ? '' : 'es'} (${P.bytes(B.wouldFree)} in use)`);
        boostAct(); return;
      }
      if (tp.trim.length) {
        // In small calls (P.trimCalls): the trim runs on the sidecar's shared slow lane, which serves icons,
        // the tray, media and launch between calls (lane mantle-m1). A call that fails stops the trim there.
        const results = [], tried = [];
        let trimmed = 0, freed = 0, threw = null;
        for (const part of P.trimCalls(tp.trim)) {
          let res;
          try { res = await sc('gamemode.trimbg', { items: part.map((t) => ({ pid: t.pid, created: t.created, file: t.file })) }, 15000); }
          catch (e) { threw = e; if (!trimmed) break; for (const t of part) { tried.push(t); results.push({ pid: t.pid, file: t.file, ok: false, why: plainError(e.message) }); } break; }
          for (const t of part) tried.push(t);
          if (Array.isArray(res.results)) results.push(...res.results);
          trimmed += res.trimmed || 0; freed += res.freed || 0;
        }
        // nothing handed back and a call failed: the boost failed, as one failed call always did
        if (threw && !trimmed) { B.state = 'failed'; B.why = threw.message; ctx.log(`boost: idle memory not handed back: ${threw.message}`); boostAct(); return; }
        // tried = done: a process is never trimmed twice in one game, refused or not
        for (const t of tried) S.trimDone.add(t.pid);
        B.trimmed = trimmed; B.freed = freed;
        B.refused = results.filter((r) => r && !r.ok && !r.gone).map((r) => ({ file: r.file, why: String(r.why || 'refused').replace(/^refused: /, '') }));
        const hard = B.refused.filter((r) => /^Windows refused|would not let/.test(r.why));
        if (hard.length && !B.trimmed) { B.state = 'failed'; B.why = hard[0].why; ctx.log(`boost: idle memory not handed back: ${hard[0].why}`); boostAct(); return; }
        if (S.record) { S.record.trim = { pids: [...S.trimDone] }; try { saveRecord(); } catch (_) { /* said by the record row */ } }
      }
      B.freeAfter = freemem(); B.at = now(); B.state = 'done';
      if (B.freeAfter < P.LOW_FREE_BYTES) {
        const big = P.biggestApp(scan.procs, { ownSession: scan.ownSession, gamePid: S.game && S.game.pid, gameFile: S.game && S.game.file,
          mainPid: o.mainPid !== undefined ? o.mainPid : process.pid, mantlePids: mantlePids() });
        B.suggest = `Still only ${P.bytes(B.freeAfter)} free` + (big ? `: closing ${big.name} would free up to ${P.bytes(big.ws)} (Mantle never closes apps)` : '');
      }
      ctx.log(`boost: ${B.trimmed} idle process${B.trimmed === 1 ? '' : 'es'} handed back ${P.bytes(B.freed)}; free memory ${P.bytes(B.freeBefore)} -> ${P.bytes(B.freeAfter)}` +
        (B.refused.length ? `; not trimmed: ${exeNames(B.refused)}` : ''));
      const at = S.since;
      const later = setTimeout(() => { if (S.on && S.since === at) ctx.log(`boost: a minute later ${P.bytes(freemem())} of memory free`); }, 60000);
      if (later.unref) later.unref();
      boostAct();
    }
    /** Mid-game switch: off puts the eased background apps back now; on eases at the next check. */
    let boostWas = set().boost;
    async function syncBoost(from) {
      const want = set().boost;
      if (want === boostWas) return;
      boostWas = want;
      ctx.log(`boost: switched ${want ? 'on' : 'off'} (${from})`);
      if (!S.on || !S.boost) return;
      if (want) { S.boost = boostStart(); S.cpuBase = null; S.replanSoon = true; boostAct(); push(); return; }
      S.boost.state = 'off';
      const bg = ((S.record && S.record.procs) || []).filter((r) => r.group === 'background');
      if (bg.length && !dry) {
        try {
          const out = await restore({ procs: bg }, 'the boost was switched off');
          const kept = out.keep ? out.keep.procs : [];
          S.record.procs = S.record.procs.filter((r) => r.group !== 'background').concat(kept);
          saveRecord();
          if (kept.length) { S.boost.state = 'failed'; S.boost.why = `not every background app was put back yet (${out.failed.join('; ')}); they are put back when game mode ends`; }
        } catch (e) { S.boost.state = 'failed'; S.boost.why = `the background apps were not put back yet (${e.message}); they are put back when game mode ends`; }
      }
      boostAct(); push();
    }

    /* ---- wallpaper, Lively, the rest ------------------------------------------------------------ */
    function wallpaperMod() { if (o.wallpaper !== undefined) return o.wallpaper; try { return require('../wallpaper'); } catch (_) { return null; } }
    function holdWallpaper(on) {
      const wp = wallpaperMod();
      if (!wp || typeof wp.gameHold !== 'function') { if (on) act('wallpaper', 'Wallpaper', 'blocked', 'this version of Mantle cannot pause its wallpaper for games'); return; }
      if (dry) { if (on) act('wallpaper', 'Wallpaper', 'dry', 'test run: would hold the wallpaper paused'); return; }
      const r = wp.gameHold(on ? `game mode: ${S.game ? S.game.file : 'on'}` : null);
      if (on) { S.record.wallpaper = true; saveRecord(); act('wallpaper', 'Wallpaper', 'done', 'held paused until game mode ends' + (r && r.pause && r.pause.paused ? '' : ' (no wallpaper is playing)')); }
    }
    function lively(scan, play) {
      const lp = (scan && scan.procs || []).find((p) => /^Lively\.exe$/i.test(p.file || ''));
      if (!play && !lp) { act('lively', 'Lively Wallpaper', 'same', 'not running (Mantle plays the wallpaper itself)'); return; }
      const exe = lp && lp.path || (S.record && S.record.lively && S.record.lively.path);
      if (!exe) { if (!play) act('lively', 'Lively Wallpaper', 'failed', 'running, but its path could not be read'); return; }
      const args = ['app', '--play', play ? 'true' : 'false'];
      if (dry) { act('lively', 'Lively Wallpaper', 'dry', `test run: would pause Lively with its own pause command`); return; }
      if (play && !lp) return;          // Lively has exited since: nothing to resume, and never start it
      try {
        (o.spawn || require('child_process').spawn)(exe, args, { windowsHide: true, detached: false, stdio: 'ignore' }).on('error', (e) => ctx.log(`Lively ${args.join(' ')}: ${e.message}`));
        if (!play) { S.record.lively = { path: exe }; saveRecord(); act('lively', 'Lively Wallpaper', 'done', 'paused with its own pause command; resumed after'); }
      } catch (e) { act('lively', 'Lively Wallpaper', 'failed', e.message); }
    }
    function infoRows() {
      act('notify', 'Notifications', 'info', "Windows' own rule does this: Settings > System > Notifications > Turn on do not disturb automatically > When playing a game. Windows gives apps no supported way to switch Do not disturb, so game mode does not");
      act('game', 'The game itself', 'info', 'left alone on purpose: never opened for anything but its name, priority untouched (anti-cheat)');
      act('topbar', 'Top bar', 'info', 'gives its strip back the moment a known game starts, then closes with the rest of Mantle\'s hidden windows (see "Mantle is resting")');
    }

    /* ---- Mantle rests while a game runs (lane memfix, 2026-09-26) -------------------------------
     * Known game RUNNING (P.runningGames, names only) or game mode on = main.js restMantle closes the
     * windows nothing needs in front of a game and hands their keys back to Windows; the last game
     * gone = everything comes back. Its words are on the tile (view().rest) and one line in the log. */
    async function syncRest(from) {
      if (S.rest.busy || S.stopped || !ctx.host || typeof ctx.host.rest !== 'function') return;
      const d = P.restStep(S.rest, { run: S.lastRun, on: S.on, how: S.how, game: S.game && S.game.why !== 'turned on by hand' ? S.game.file : null, enabled: ctx.enabled() });
      S.rest.hold = d.hold;
      if (!d.action) return;
      S.rest.busy = true; push();
      try {
        if (d.action === 'rest') {
          const r = await ctx.host.rest(true, d.why);
          if (r && r.ok) {
            const first = !S.rest.resting;
            Object.assign(S.rest, { resting: true, why: d.why, since: first ? now() : S.rest.since });
            if (first || !S.rest.text) {
              S.rest.text = r.text ? `Mantle is resting while ${d.why}: ${r.text}` : `Mantle is resting while ${d.why}`;
              ctx.log(`${S.rest.text} (${from})`);
            } else S.rest.text = S.rest.text.replace(/^Mantle is resting while .+?: /, `Mantle is resting while ${d.why}: `);
          } else {
            // Not resting is a fault here, not a state: it says why, and the next tick tries again.
            const t = `Mantle could not rest while ${d.why}: ${(r && r.reason) || 'no answer'}`;
            if (t !== S.rest.text) ctx.log(t);
            S.rest.text = t;
          }
        } else {
          const r = await ctx.host.rest(false, d.why);
          const mins = S.rest.since ? Math.round((now() - S.rest.since) / 60000) : 0;
          S.rest.last = { at: now(), why: d.why, minutes: mins, text: r && r.ok ? `Mantle rested ${mins < 1 ? 'under a minute' : `${mins} min`} (${S.rest.why}) and is back: ${d.why}` : `Mantle could not come back after the game: ${(r && r.reason) || 'no answer'}` };
          Object.assign(S.rest, { resting: false, why: null, since: null, text: null });
          ctx.log(`${S.rest.last.text}${r && r.back ? ` (${r.back.join(', ')})` : ''}`);
        }
      } catch (e) {
        S.rest.text = `Mantle could not ${d.action === 'rest' ? 'rest' : 'come back'}: ${e.message}`;
        ctx.log(S.rest.text);
      } finally { S.rest.busy = false; push(); }
    }

    /* ---- on / off -------------------------------------------------------------------------------- */
    async function turnOn(game, how) {
      if (S.on || S.busy) return;
      S.busy = 'on'; S.on = true; S.how = how; S.since = now();
      S.game = Object.assign({ lastFront: now() }, game);
      S.actions = [];
      // Anything the last game's restore could not put back yet rides along in this record, so it is
      // put back with this game's changes (and a crash now still has it on disk).
      const lo = S.leftover && !S.leftover.gaveUp ? S.leftover.rec : null;
      S.leftover = null;
      // The boost: what a crashed instance already trimmed for this same run of the game stays trimmed-once.
      const ct = S.crashTrim;
      S.trimDone = new Set(ct && game.pid && ct.gamePid === game.pid && P.sameFile(ct.gameFile, game.file) ? ct.pids : []);
      S.crashTrim = null;
      S.boost = boostStart(); S.cpuBase = null; S.dryEased = [];
      S.record = { v: 1, since: S.since, how, game: { file: game.file, pid: game.pid }, power: Object.assign({}, lo && lo.power),
                   saver: (lo && lo.saver) || null, procs: ((lo && lo.procs) || []).slice(), wallpaper: false, lively: null,
                   trim: { pids: [...S.trimDone] } };
      try { saveRecord(); } catch (e) { act('record', 'Restore record', 'failed', `could not be written (${e.message}): a crash now would leave changes behind until they are undone by hand`); }
      push();
      try {
        await applyPower();
        const scan = await sc('gamemode.scan', { procs: true, detail: true }, 10000);
        S.cpuBase = P.cpuBase(scan.procs); S.cpuBaseAt = now();     // the boost's idle rule starts here
        await applyProcs(scan);
        S.lastReplan = now();
        holdWallpaper(true);
        lively(scan, false);
        infoRows();
      } catch (e) { act('error', 'Game mode', 'failed', e.message); }
      S.busy = null;
      ctx.log(`on (${how}${dry ? ', DRY RUN' : ''}): ${game.why || game.file} | ${S.actions.filter((a) => a.status !== 'info').map((a) => `${a.key}=${a.status}`).join(' ')}`);
      push();
    }

    /** Puts back what `rec` says game mode changed. -> {text, failed:[words], keep: a record of ONLY what
     * could not be put back (null when everything was)}. Throws when the helper stops mid-way (the caller
     * then keeps the whole record: putting back twice is harmless, ecoIf/prioIf/onlyIf make it a no-op). */
    async function restore(rec, why) {
      const out = { procs: 0, gone: 0, skipped: 0, failed: [], keep: null };
      if (!rec) return out;
      const keep = { v: 1, since: rec.since, how: rec.how, game: rec.game, power: {}, saver: null, procs: [], wallpaper: false, lively: null };
      if (rec.lively) lively(await sc('gamemode.scan', { procs: true, detail: true }, 10000).catch(() => null), true);
      if (rec.wallpaper) { const wp = wallpaperMod(); if (wp && wp.gameHold) wp.gameHold(null); }
      const all = rec.procs || [];
      for (let i = 0; i < all.length; i += CHUNK) {
        const part = all.slice(i, i + CHUNK);
        const res = (await sc('gamemode.apply', { items: part.map(P.restoreItem) }, 10000)).results || [];
        part.forEach((entry, k) => {
          const r = res[k] && res[k].pid === entry.pid ? res[k] : res.find((x) => x && x.pid === entry.pid);
          if (!r) { out.failed.push(`${P.baseName(entry.file)}: no answer`); keep.procs.push(entry); }
          else if (r.gone) out.gone++;
          else if (r.ok && ((r.eco && r.eco.skipped) || (r.prio && r.prio.skipped))) out.skipped++;
          else if (r.ok) out.procs++;
          else { out.failed.push(`${r.file || entry.file}: ${r.why || (r.eco && r.eco.why) || (r.prio && r.prio.why) || 'refused'}`); keep.procs.push(entry); }
        });
      }
      for (const src of Object.keys(rec.power || {})) {
        const p = rec.power[src];
        const r = await sc('gamemode.power', { source: src, mode: p.was, onlyIf: p.set });
        const where = src === 'ac' ? 'plugged in' : 'on battery';
        out.power = (out.power ? out.power + '; ' : '') + (r.ok ? (r.skipped ? r.reason : `${where} back to ${p.was}`) : `power mode ${where} NOT put back: ${r.reason}`);
        if (!r.ok) { out.failed.push(`power mode ${where}: ${r.reason}`); keep.power[src] = p; }
      }
      if (rec.saver) {
        const r = await sc('gamemode.saver', { at: rec.saver.was, onlyIf: rec.saver.set });
        out.saver = r.ok ? (r.skipped ? r.reason : `Energy saver level back to ${rec.saver.was}%`) : `Energy saver level NOT put back: ${r.reason}`;
        if (!r.ok) { out.failed.push(out.saver); keep.saver = rec.saver; }
      }
      if (out.failed.length) out.keep = keep;
      out.text = `${out.procs} apps back to normal` + (out.gone ? `, ${out.gone} had exited` : '') + (out.skipped ? `, ${out.skipped} had changed their own setting (left)` : '') +
        (out.power ? `; ${out.power}` : '') + (out.saver ? `; ${out.saver}` : '') + (rec.wallpaper ? '; wallpaper let go' : '') + (rec.lively ? '; Lively resumed' : '') +
        (out.failed.length ? `; NOT put back: ${out.failed.join('; ')}` : '');
      ctx.log(`restore (${why}): ${out.text}`);
      return out;
    }

    async function turnOff(why) {
      if (!S.on || S.busy === 'off') return;
      while (S.busy === 'on') await new Promise((r) => setTimeout(r, 50));
      S.busy = 'off'; push();
      let out;
      try { out = dry ? { text: 'test run: nothing had been changed', failed: [] } : await restore(S.record, why); }
      catch (e) { out = { text: `could not finish (${plain(e.message)}); Mantle tries again in ${RETRY_MS / 1000} s`, failed: [e.message], keep: S.record }; }
      const game = S.game;
      const B = S.boost;
      const boosted = B && B.state === 'done' && B.trimmed ? `; the boost had freed ${P.bytes(B.freed)}` : '';
      S.last = { at: now(), why, game: game && game.file, minutes: Math.round((now() - S.since) / 60000), text: out.text + boosted, ok: !out.failed.length };
      S.boost = null; S.cpuBase = null;
      // lane sysmon-game, 2026-09-29: what could not be put back used to sit in S.record until the NEXT
      // game overwrote it (on disk too), so it was never put back at all. Now it is kept, on disk, tried
      // again every 30 s, and carried into the next game's record.
      if (!out.failed.length) dropRecord();
      else holdLeftover(out.keep || S.record, out.failed);
      S.record = null;
      S.on = false; S.how = null; S.game = null; S.since = null; S.busy = null; S.left = null;
      S.actions = [];
      ctx.log(`off: ${why}`);
      push();
    }

    /* ---- what could not be put back: kept and tried again ---------------------------------------- */
    function holdLeftover(rec, failed, tries) {
      S.leftover = { rec, at: now(), tries: tries || 0, gaveUp: false,
        text: `Not put back yet: ${failed.join('; ')}. Mantle tries again every ${RETRY_MS / 1000} s` };
      try { writeRecord(rec); } catch (e) { ctx.log(`restore record could not be written: ${e.message}`); }
    }
    async function retryLeftover(why) {
      const L = S.leftover;
      if (!L || L.gaveUp || S.on || S.busy) return;
      L.at = now(); L.tries++;
      let out;
      try { out = await restore(L.rec, why); } catch (e) { out = { failed: [e.message], keep: L.rec }; }
      if (S.leftover !== L) return;                 // a game started meanwhile and took it over
      if (!out.failed.length) {
        S.leftover = null; dropRecord();
        const later = `put back on a later try: ${out.text}`;
        if (S.fromCrash && !S.fromCrash.ok) Object.assign(S.fromCrash, { ok: true, text: later });
        else if (S.last) Object.assign(S.last, { ok: true, text: later });
        ctx.log(`restore retry ${L.tries}: everything put back`);
      } else if (L.tries >= RETRY_MAX) {
        dropRecord();
        S.leftover = Object.assign({}, L, { gaveUp: true,
          text: `Mantle could not put these back: ${out.failed.join('; ')}. Apps go back to normal when they restart; a power setting can be changed in Settings > System > Power & battery` });
        ctx.log(`gave up putting back after ${L.tries} tries`);
      } else holdLeftover(out.keep || L.rec, out.failed, L.tries);
      push();
    }

    /* ---- the watch -------------------------------------------------------------------------------- */
    async function tick() {
      S.timer = null;
      if (S.stopped || !ctx.enabled()) return;
      // One tick at a time: a focus event can ask for a tick while a slow one (turning on) still runs.
      if (S.ticking) { S.again = true; return; }
      S.ticking = true;
      try {
        if (!ctx.sidecar.ready) {
          const was = S.watching;
          S.watching = false; S.reason = "games are not being watched: Mantle's background helper is restarting";
          if (was) push();                            // the tile says so at once, not on the next change
          return;
        }
        // Always the Toolhelp list (names only, no handles, a few ms): a game whose exe path the
        // anti-cheat will not give out is still named by its pid (P.detectGame).
        const withProcs = true;
        const replan = S.on && (S.replanSoon || now() - S.lastReplan >= REPLAN_MS);
        const scan = await sc('gamemode.scan', { procs: withProcs, detail: replan }, 10000);
        if (!S.watching) { S.watching = true; ctx.health(true); push(); }
        S.lastFg = scan.fg; S.lastProcs = scan.procs;
        S.lastRun = P.runningGames(scan, { seen: S.runSeen, extra: TEST_GAMES });
        const d = P.step(S, scan, now(), { auto: set().auto });
        S.reason = d.why;
        if (d.action === 'on') await turnOn(d.game, 'auto');
        else if (d.action === 'off') await turnOff(d.why);
        else if (d.action === 'front') S.game.lastFront = now();
        else if (d.action === 'unsuppress') S.suppress = null;
        if (replan && d.action !== 'off' && S.on && !S.busy) {   // every 30 s: apps started since game mode came on
          S.lastReplan = now();
          await applyProcs(scan); push();
        }
        // The boost's one trim: a minute after its CPU baseline (taken from a detail scan).
        const B = S.boost;
        if (S.on && !S.busy && B && B.state === 'waiting') {
          if (!S.cpuBase) { if (replan) { S.cpuBase = P.cpuBase(scan.procs); S.cpuBaseAt = now(); } }
          else if (now() - S.cpuBaseAt >= TRIM_AFTER) {
            try {
              const ds = replan ? scan : await sc('gamemode.scan', { procs: true, detail: true }, 10000);
              await boostTrim(ds);
            } catch (e) {
              Object.assign(B, { state: 'failed', why: e.message });
              ctx.log(`boost: idle memory not handed back: ${e.message}`); boostAct();
            }
            push();
          }
        }
        await syncRest('the game watch');
        if (!S.on && !S.busy && S.leftover && !S.leftover.gaveUp && now() - S.leftover.at >= RETRY_MS) await retryLeftover('trying again');
      } catch (e) {
        S.watching = false; S.reason = `games are not being watched: ${e.message}`;
        ctx.health(false, S.reason); push();
      } finally {
        S.ticking = false;
        const again = S.again; S.again = false;
        schedule(again ? 150 : undefined);
      }
    }
    function schedule(ms) {
      if (S.stopped || !ctx.enabled()) return;
      clearTimeout(S.timer);
      // Resting: one names-only process list every 5 s is all Mantle does until the game exits.
      S.timer = setTimeout(tick, ms != null ? ms : S.on ? ON_MS : S.rest.resting ? REST_MS : IDLE_MS);
    }

    ctx.command('state', async () => view());
    ctx.command('set', async (a) => {
      if (!ctx.enabled()) return Object.assign(view(), { ok: false, reason: "game mode is switched off in Mantle's tray menu" });
      if (a && a.on) {
        if (S.on) return Object.assign(view(), { ok: true });
        const d = P.detectGame(S.lastFg, S.lastProcs);
        const g = d.game ? d : { file: d.file || 'the app in front', pid: d.pid || 0, title: d.title, why: 'turned on by hand' };
        await turnOn(Object.assign({}, g, { why: d.game ? d.why : 'turned on by hand' }), 'manual');
        S.rest.hold = null;
      } else {
        const g = S.game;
        if (S.how === 'auto' && g) S.suppress = { pid: g.pid, file: g.file };
        // Off by hand while a known game runs = Owen wants Mantle back for this run of it.
        S.rest.hold = S.lastRun.length ? S.lastRun.map((p) => p.pid) : null;
        await turnOff('turned off by hand');
      }
      await syncRest('by hand');
      return Object.assign(view(), { ok: true });
    });
    ctx.command('auto', async (a) => { ctx.settings.set('auto', !!(a && a.on)); ctx.log(`automatic: ${!!(a && a.on)}`); push(); return view(); });
    ctx.command('liftSaver', async (a) => { ctx.settings.set('liftSaver', !!(a && a.on)); ctx.log(`lift Energy saver while gaming: ${!!(a && a.on)}`); push(); return view(); });
    ctx.command('boost', async (a) => { ctx.settings.set('boost', !!(a && a.on)); await syncBoost('the game mode tile'); push(); return view(); });
    // Mantle Settings wrote one of them (same store): the quick-settings card follows at once.
    if (ctx.onOption) ctx.onOption('*', () => { syncBoost('Settings').catch(() => {}); push(); });

    ctx.sidecar.on('topbar', (ev) => { if (ev && ev.kind === 'focus') schedule(150); });
    ctx.sidecar.on('powermode', () => { if (S.on && !S.busy && S.record) applyPower().then(push).catch(() => {}); });
    // A record on disk at start = Mantle crashed or was killed mid-game: put it back first. Retried
    // after every sidecar restart until it has been done.
    let crashChecked = dry;
    ctx.sidecar.onReady(async () => {
      if (!crashChecked && !S.on) {
        crashChecked = true;
        const rec = readRecord();
        // the boost trims once per game run: a game that outlived the crash is not trimmed again
        if (rec && rec.trim && Array.isArray(rec.trim.pids) && rec.trim.pids.length && rec.game)
          S.crashTrim = { gamePid: rec.game.pid, gameFile: rec.game.file, pids: rec.trim.pids };
        if (rec) {
          S.fromCrash = { at: now(), game: rec.game && rec.game.file, text: 'putting back what the last game changed…', ok: false };
          push();
          // Whatever cannot be put back now is kept and tried again every 30 s (holdLeftover), not only
          // at the next Mantle start.
          try {
            const out = await restore(rec, 'left over from before Mantle restarted');
            S.fromCrash.text = out.text;
            S.fromCrash.ok = !out.failed.length;
            if (!out.failed.length) dropRecord();
            else holdLeftover(out.keep || rec, out.failed);
          } catch (e) {
            S.fromCrash.text = `could not put it back yet (${e.message}); Mantle tries again in ${RETRY_MS / 1000} s`;
            holdLeftover(rec, [e.message]);
          }
          push();
        }
      }
      schedule(0);
    });
    ctx.onEnabled((on) => { if (on) schedule(0); else { clearTimeout(S.timer); turnOff('switched off in the tray').then(() => syncRest('the tray switch')); } push(); });

    return {
      async stop(why) {
        S.stopped = true;
        clearTimeout(S.timer);
        // Resting and Mantle stays open ("Put Windows back (keep Mantle open)"): its launcher and
        // Alt+Tab come back; main.js does nothing here when Mantle is quitting.
        if (S.rest.resting && ctx.host && ctx.host.rest) Promise.resolve(ctx.host.rest(false, `game mode stopped${why ? ` (${why})` : ''}`)).catch(() => {});
        if (S.on) await turnOff(`Mantle is closing${why ? ` (${why})` : ''}`);
      },
      _S: S, _tick: tick, _record: RECORD,
    };
  },
};

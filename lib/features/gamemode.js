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

const IDLE_MS = 3000, ON_MS = 5000, REST_MS = 5000, REPLAN_MS = 30000;
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
  ],
  install(ctx, opts) {
    const o = opts || {};                       // tests: { userData, mantlePids(), wallpaper, spawn, now }
    const now = o.now || (() => Date.now());
    const dry = !!(ctx.flags && ctx.flags.test) || process.env.MANTLE_GAMEMODE_DRY === '1';
    const userData = o.userData || (() => { try { return require('electron').app.getPath('userData'); } catch (_) { return path.dirname(path.dirname(ctx.settings.file)); } })();
    const RECORD = path.join(userData, 'gamemode-restore.json');
    const S = {
      on: false, how: null, game: null, since: null, suppress: null, busy: null, actions: [], record: null,
      last: null, fromCrash: null, watching: false, reason: 'starting', lastFg: null, lastReplan: 0, timer: null, stopped: false,
      // Mantle resting while a game runs (lane memfix): {resting, why, since, text, hold, busy, last}
      rest: { resting: false, why: null, since: null, text: null, hold: null, busy: false, last: null }, runSeen: new Map(), lastRun: [],
    };
    // TEST ONLY: MANTLE_GAMEMODE_TEST_GAME=<exe name>[,<exe name>] counts as a known game RUNNING (never a
    // real game's name: a stand-in exe), so the rest can be proved end to end in a --test instance.
    const TEST_GAMES = ctx.flags && ctx.flags.test && process.env.MANTLE_GAMEMODE_TEST_GAME
      ? String(process.env.MANTLE_GAMEMODE_TEST_GAME).split(',').map((s) => s.trim()).filter(Boolean) : [];
    const set = () => ({ auto: ctx.settings.get('auto', true) !== false, liftSaver: ctx.settings.get('liftSaver', false) === true });

    const sc = async (cmd, args, ms) => {
      const r = await ctx.sidecar.send(cmd, args || {}, { timeoutMs: ms || 6000 });
      if (!r.ok) throw new Error(`${cmd}: ${r.error}`);
      return r.result;
    };
    function saveRecord() {
      if (dry || !S.record) return;
      const tmp = RECORD + '.tmp';
      fs.mkdirSync(path.dirname(RECORD), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(S.record, null, 1));
      fs.renameSync(tmp, RECORD);
    }
    function dropRecord() { try { fs.unlinkSync(RECORD); } catch (_) { /* none */ } }
    function readRecord() { try { return JSON.parse(fs.readFileSync(RECORD, 'utf8')); } catch (_) { return null; } }

    function view() {
      const st = set();
      return { on: S.on, how: S.how, game: S.game && { file: S.game.file, title: S.game.title, why: S.game.why }, since: S.since,
               busy: S.busy, auto: st.auto, liftSaver: st.liftSaver, dry, enabled: ctx.enabled(), watching: S.watching,
               reason: S.reason, actions: S.actions, last: S.last, fromCrash: S.fromCrash, record: dry ? null : RECORD,
               rest: { on: S.rest.resting, why: S.rest.why, since: S.rest.since, text: S.rest.text, busy: S.rest.busy, last: S.rest.last } };
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
          if (dry) act('saver', 'Energy saver', 'dry', 'dry run: would lift Energy saver (turn-on level 0%) and put your level back after');
          else {
            try {
              const r = await sc('gamemode.saver', { at: 0 });
              if (!r.same && r.ok) { S.record.saver = { was: r.before, set: 0 }; saveRecord(); }
              act('saver', 'Energy saver', r.ok && r.saver < 1 ? 'done' : 'failed',
                r.ok ? (r.saver < 1 ? `lifted for the game (turn-on level ${r.before}% → 0%, put back after)` : `the level is 0% but Energy saver stayed on (it was turned on by hand?)`) : r.reason);
              st = await sc('powermode.get', {}, 4000);
            } catch (e) { act('saver', 'Energy saver', 'failed', e.message); }
          }
        } else if (!S.record.saver) {
          act('saver', 'Energy saver', 'blocked', `Energy saver is on (${where}), so Windows runs Best power efficiency and no power mode can be set (the Power mode row above says how to change that)` + (src === 'battery' && !set().liftSaver
            ? '. Game mode leaves it on: switch on "Lift Energy saver while gaming" below to change that' : ''));
        }
      } else act('saver', 'Energy saver', 'same', `off ${where}`);
      if (!st.settable) { act('power', 'Power mode', 'blocked', st.saver ? 'not set: Energy saver is on (see Energy saver)' : st.reason || 'Windows will not take a power mode now'); return; }
      const mine = st.configured && st.configured[src === 'ac' ? 'ac' : 'battery'];
      if (!src) { act('power', 'Power mode', 'blocked', 'the power source is unknown'); return; }
      if (mine === 'performance') { act('power', 'Power mode', 'same', `Best performance is already your choice ${where}`); return; }
      if (dry) { act('power', 'Power mode', 'dry', `dry run: would set Best performance ${where} (now ${mine}) and put it back after`); return; }
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
    async function applyProcs(scan) {
      const au = await audioPids();
      if (!au.ok) { act('background', 'Background apps', 'blocked', `not changed: which apps play sound could not be read (${au.reason}), and a call or music must never be slowed`); return; }
      const done = new Set((S.record.procs || []).map((r) => r.pid));
      const pl = P.plan(scan.procs, { gamePid: S.game && S.game.pid, gameFile: S.game && S.game.file, fgPid: scan.fg && scan.fg.pid,
        sidecarPid: scan.ownPid, ownSession: scan.ownSession, mantlePids: mantlePids(), audioPids: au.pids });
      const fresh = pl.targets.filter((t) => !done.has(t.pid));
      S.left = pl.left;
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
      const all = (g) => (S.record.procs || []).filter((r) => r.group === g).concat(dry ? lines[g] : []);
      const verb = dry ? 'dry run: would put' : '';
      const bg = all('background'), mt = all('mantle');
      act('background', 'Background apps', dry ? 'dry' : bg.length ? 'done' : 'same',
        (bg.length ? `${verb ? verb + ' ' : ''}Efficiency mode${dry ? '' : ' on'} ${bg.length} app processes: ${P.names(bg, 6)}` : 'nothing to slow down') +
        (failed.length ? `. Not changed: ${P.names(failed, 4)} (${failed[0].why})` : '') +
        (pl.left.length ? `. Left alone: ${P.leftByWhy(pl.left).map((l) => l.text).join('; ')}` : ''));
      act('mantle', 'Mantle itself', dry ? 'dry' : mt.length ? 'done' : 'same',
        mt.length ? `${dry ? 'dry run: would put ' : ''}${mt.length} Mantle process${mt.length === 1 ? '' : 'es'} in Efficiency mode at below-normal priority (the sidecar stays normal: it runs the key hook)` : 'nothing to change');
    }

    /* ---- wallpaper, Lively, the rest ------------------------------------------------------------ */
    function wallpaperMod() { if (o.wallpaper !== undefined) return o.wallpaper; try { return require('../wallpaper'); } catch (_) { return null; } }
    function holdWallpaper(on) {
      const wp = wallpaperMod();
      if (!wp || typeof wp.gameHold !== 'function') { if (on) act('wallpaper', 'Wallpaper', 'blocked', 'this Mantle has no wallpaper hold (lib/wallpaper.js gameHold)'); return; }
      if (dry) { if (on) act('wallpaper', 'Wallpaper', 'dry', 'dry run: would hold the wallpaper paused'); return; }
      const r = wp.gameHold(on ? `game mode: ${S.game ? S.game.file : 'on'}` : null);
      if (on) { S.record.wallpaper = true; saveRecord(); act('wallpaper', 'Wallpaper', 'done', 'held paused until game mode ends' + (r && r.pause && r.pause.paused ? '' : ' (no wallpaper is playing)')); }
    }
    function lively(scan, play) {
      const lp = (scan && scan.procs || []).find((p) => /^Lively\.exe$/i.test(p.file || ''));
      if (!play && !lp) { act('lively', 'Lively Wallpaper', 'same', 'not running (Mantle plays the wallpaper itself)'); return; }
      const exe = lp && lp.path || (S.record && S.record.lively && S.record.lively.path);
      if (!exe) { if (!play) act('lively', 'Lively Wallpaper', 'failed', 'running, but its path could not be read'); return; }
      const args = ['app', '--play', play ? 'true' : 'false'];
      if (dry) { act('lively', 'Lively Wallpaper', 'dry', `dry run: would run Lively.exe ${args.join(' ')}`); return; }
      if (play && !lp) return;          // Lively has exited since: nothing to resume, and never start it
      try {
        (o.spawn || require('child_process').spawn)(exe, args, { windowsHide: true, detached: false, stdio: 'ignore' }).on('error', (e) => ctx.log(`Lively ${args.join(' ')}: ${e.message}`));
        if (!play) { S.record.lively = { path: exe }; saveRecord(); act('lively', 'Lively Wallpaper', 'done', `paused with its own command (Lively.exe ${args.join(' ')})`); }
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
      S.record = { v: 1, since: S.since, how, game: { file: game.file, pid: game.pid }, power: {}, saver: null, procs: [], wallpaper: false, lively: null };
      try { saveRecord(); } catch (e) { act('record', 'Restore record', 'failed', `could not be written (${e.message}): a crash now would leave changes behind until they are undone by hand`); }
      push();
      try {
        await applyPower();
        const scan = await sc('gamemode.scan', { procs: true, detail: true }, 10000);
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

    async function restore(rec, why) {
      const out = { procs: 0, gone: 0, skipped: 0, failed: [] };
      if (!rec) return out;
      if (rec.lively) lively(await sc('gamemode.scan', { procs: true, detail: true }, 10000).catch(() => null), true);
      if (rec.wallpaper) { const wp = wallpaperMod(); if (wp && wp.gameHold) wp.gameHold(null); }
      const items = (rec.procs || []).map(P.restoreItem);
      for (let i = 0; i < items.length; i += CHUNK) {
        const res = (await sc('gamemode.apply', { items: items.slice(i, i + CHUNK) }, 10000)).results || [];
        for (const r of res) {
          if (r.gone) out.gone++;
          else if (r.ok && ((r.eco && r.eco.skipped) || (r.prio && r.prio.skipped))) out.skipped++;
          else if (r.ok) out.procs++;
          else out.failed.push(`${r.file}: ${r.why || (r.eco && r.eco.why) || 'refused'}`);
        }
      }
      for (const src of Object.keys(rec.power || {})) {
        const p = rec.power[src];
        const r = await sc('gamemode.power', { source: src, mode: p.was, onlyIf: p.set });
        out.power = (out.power ? out.power + '; ' : '') + (r.ok ? (r.skipped ? r.reason : `${src === 'ac' ? 'plugged in' : 'on battery'} back to ${p.was}`) : `NOT put back ${src}: ${r.reason}`);
        if (!r.ok) out.failed.push(`power mode ${src}: ${r.reason}`);
      }
      if (rec.saver) {
        const r = await sc('gamemode.saver', { at: rec.saver.was, onlyIf: rec.saver.set });
        out.saver = r.ok ? (r.skipped ? r.reason : `Energy saver level back to ${rec.saver.was}%`) : `Energy saver level NOT put back: ${r.reason}`;
        if (!r.ok) out.failed.push(out.saver);
      }
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
      try { out = dry ? { text: 'dry run: nothing had been changed', failed: [] } : await restore(S.record, why); }
      catch (e) { out = { text: `could not finish (${e.message}); the record stays and is retried`, failed: [e.message] }; }
      const game = S.game;
      S.last = { at: now(), why, game: game && game.file, minutes: Math.round((now() - S.since) / 60000), text: out.text, ok: !out.failed.length };
      if (!out.failed.length) { dropRecord(); S.record = null; }
      S.on = false; S.how = null; S.game = null; S.since = null; S.busy = null; S.left = null;
      S.actions = [];
      ctx.log(`off: ${why}`);
      push();
    }

    /* ---- the watch -------------------------------------------------------------------------------- */
    async function tick() {
      S.timer = null;
      if (S.stopped || !ctx.enabled()) return;
      try {
        if (!ctx.sidecar.ready) { S.watching = false; S.reason = 'the sidecar is not running'; return; }
        // Always the Toolhelp list (names only, no handles, a few ms): a game whose exe path the
        // anti-cheat will not give out is still named by its pid (P.detectGame).
        const withProcs = true;
        const replan = S.on && now() - S.lastReplan >= REPLAN_MS;
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
        await syncRest('the game watch');
      } catch (e) {
        S.watching = false; S.reason = `games are not being watched: ${e.message}`;
        ctx.health(false, S.reason); push();
      } finally { schedule(); }
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
    // Mantle Settings wrote one of the two (same store): the quick-settings card follows at once.
    if (ctx.onOption) ctx.onOption('*', () => push());

    ctx.sidecar.on('topbar', (ev) => { if (ev && ev.kind === 'focus') schedule(150); });
    ctx.sidecar.on('powermode', () => { if (S.on && !S.busy && S.record) applyPower().then(push).catch(() => {}); });
    // A record on disk at start = Mantle crashed or was killed mid-game: put it back first. Retried
    // after every sidecar restart until it has been done.
    let crashChecked = dry;
    ctx.sidecar.onReady(async () => {
      if (!crashChecked && !S.on) {
        crashChecked = true;
        const rec = readRecord();
        if (rec) {
          S.fromCrash = { at: now(), game: rec.game && rec.game.file, text: 'putting back what the last game changed…', ok: false };
          push();
          try {
            const out = await restore(rec, 'left over from before Mantle restarted');
            S.fromCrash.text = out.text;
            S.fromCrash.ok = !out.failed.length;
            if (!out.failed.length) dropRecord();
          } catch (e) {
            crashChecked = false;
            S.fromCrash.text = `could not put it back yet (${e.message}); tried again when the sidecar restarts`;
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

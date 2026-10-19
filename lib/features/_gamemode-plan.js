'use strict';
/* _gamemode-plan.js - the PURE half of game mode (lane gamemode, 2026-09-25): is a game in front,
 * when does game mode end, and which processes it may touch. No Electron, no sidecar, no clock of
 * its own - lib/features/gamemode.test.js drives it with made-up process lists and states.
 *
 * The sidecar (sidecar/GameMode.cs) checks every write target AGAIN with its own never-touch list,
 * so a bug here can make game mode do less, never touch a game or its anti-cheat. */

/* Known games: in front = game mode, windowed or not. Launchers are NOT games (Riot Client shows
 * while Valorant loads; nothing to speed up there, and it is Vanguard's neighbour). */
const KNOWN_GAMES = ['VALORANT-Win64-Shipping.exe', 'RobloxPlayerBeta.exe', 'Minecraft.Windows.exe',
  'FortniteClient-Win64-Shipping.exe', 'cs2.exe', 'r5apex.exe', 'RocketLeague.exe', 'GTA5.exe', 'Overwatch.exe',
  'League of Legends.exe', 'EscapeFromTarkov.exe', 'Cyberpunk2077.exe'];
const JAVA = ['javaw.exe', 'java.exe'];
const LAUNCHERS = /^(RiotClient|LeagueClient|MinecraftLauncher|Minecraft Launcher|RobloxPlayerLauncher|RobloxStudio|EpicGamesLauncher|steam|Battle\.net)/i;

/* Never touched, with the words the panel shows. Same names as GameMode.cs NeverPrefixes. */
const NEVER = [
  { re: /^(VALORANT|Riot|vgc|vgtray|vgk|vanguard|League|EasyAntiCheat|EAAntiCheat|BEService|BattlEye|FACEIT)/i, why: 'a game or its anti-cheat' },
  { re: /^(javaw|java|Minecraft|Roblox|cs2|csgo|r5apex|Fortnite|RocketLeague|GTA5|Overwatch|EscapeFromTarkov|Cyberpunk2077)/i, why: 'a game' },
  { re: /^(GameBar|XboxPcApp|steam|EpicGames)/i, why: 'game platform' },
  { re: /^(Discord|TeamSpeak|ts3client|Mumble|Teams|ms-teams|Zoom|Skype|WhatsApp)/i, why: 'voice and calls' },
  { re: /^(Spotify|vlc|wmplayer|Music\.UI|Microsoft\.Media\.Player|audiodg)/i, why: 'music and video' },
  { re: /^(obs|Streamlabs|Medal)/i, why: 'recording' },
  { re: /^(lghub|Razer|SteelSeries|iCUE|Corsair|NVIDIA|nvcontainer)/i, why: 'mouse, keyboard and GPU software: slowing it adds input lag' },
  { re: /^(TabTip|GameInput|TextInputHost|ctfmon)/i, why: 'typing and controller input' },
  { re: /^(Defender|MsMpEng|MpDefender|SecurityHealth|NisSrv)/i, why: 'security' },
  { re: /^Mantle\.Sidecar/i, why: "Mantle's keyboard helper: slowing it would slow every key" },
  // lane mantle-boost, 2026-10-15: sound, input and the network path are never touched (the 10-14
  // freezes were Wi-Fi), nor Windows' shell. Same names as GameMode.cs OtherNeverPrefixes.
  { re: /^(RtkAud|Realtek|Nahimic|Dolby|Waves|MaxxAudio|voicemeeter|EarTrumpet|SoundSwitch|Krisp)/i, why: 'sound' },
  { re: /^(PowerToys|AutoHotkey|Logi|Wacom|WTablet|DS4Windows|x360ce|ViGEm|Synaptics|SynTP|ETDCtrl)/i, why: 'keyboard, mouse and controller software: slowing it adds input lag' },
  { re: /^(tailscale|openvpn|wireguard|NordVPN|ProtonVPN|ExpressVPN|Surfshark|mullvad|Cloudflare|warp-svc|ZeroTier|Killer)/i, why: 'the network: game traffic goes through it' },
  { re: /^explorer/i, why: "Windows' own shell" },
];

const AWAY_MS = 90 * 1000;   // a game not in front this long = game mode ends (a quick alt-tab does not)

function baseName(p) { return String(p || '').split(/[\\/]/).pop(); }
function sameFile(a, b) { return String(a || '').toLowerCase() === String(b || '').toLowerCase(); }

/** Is the foreground window a game? fg = the sidecar's gamemode.scan .fg (Foreground.Read + verdict);
 * procs = the same scan's Toolhelp list, when it has one. */
function detectGame(fg, procs) {
  if (!fg || !fg.pid || fg.self) return { game: false, why: fg && fg.self ? 'Mantle is in front' : 'no app is in front' };
  let file = baseName(fg.exe);
  // fg.exe comes from OpenProcess(QUERY_LIMITED), which an anti-cheat may refuse (valofix, 2026-09-26:
  // no line of the Valorant evening's log names VALORANT). The Toolhelp list names every process
  // without opening it, so the window's pid is looked up there.
  if (!file && Array.isArray(procs)) { const p = procs.find((q) => q && q.pid === fg.pid); if (p && p.file) file = p.file; }
  const title = String(fg.title || '');
  const base = { file, pid: fg.pid, title, exe: fg.exe || '' };
  if (!file) return Object.assign(base, { game: false, why: 'the app in front could not be named' });
  if (LAUNCHERS.test(file)) return Object.assign(base, { game: false, why: `${file} is a launcher, not the game` });
  if (KNOWN_GAMES.some((g) => sameFile(g, file))) return Object.assign(base, { game: true, how: 'known', why: `${file} is a known game` });
  if (JAVA.some((j) => sameFile(j, file)) && /^Minecraft/i.test(title))
    return Object.assign(base, { game: true, how: 'known', why: `${file} has a Minecraft window` });
  const v = fg.verdict || {};
  if (v.gameStore && fg.fullscreen)
    return Object.assign(base, { game: true, how: 'store', why: `${file} is on Windows' own game list (Game Bar) and fills its monitor` });
  if (v.quns === 3)
    return Object.assign(base, { game: true, how: 'exclusive', why: `${file} runs exclusive full-screen Direct3D` });
  return Object.assign(base, { game: false, why: fg.fullscreen ? `${file} fills the screen but is not a game` : `${file} is not a game` });
}

/**
 * One tick of the automatic switch. S = {on, how:'auto'|'manual', game:{pid,file,lastFront}, suppress:{pid}|null};
 * scan = {fg, procs?}; returns {action: null|'on'|'off'|'front'|'unsuppress', why, game}. Never mutates.
 * - auto on: a game in front (unless Owen turned game mode off by hand for that same game run)
 * - auto off: the game's process is gone, or it has not been in front for AWAY_MS
 * - manual on stays on until Owen turns it off
 */
function step(S, scan, now, opts) {
  const auto = !opts || opts.auto !== false;
  const away = (opts && opts.awayMs) || AWAY_MS;
  const d = detectGame(scan && scan.fg, scan && scan.procs);
  if (S.on) {
    if (S.how === 'manual') return { action: null, why: 'on by hand until turned off', game: d };
    const g = S.game || {};
    if (scan && Array.isArray(scan.procs) && !scan.procs.some((p) => p.pid === g.pid && sameFile(p.file, g.file)))
      return { action: 'off', why: `${g.file} exited` };
    if (d.game && d.pid === g.pid) return { action: 'front', why: d.why, game: d };
    if (now - (g.lastFront || now) >= away)
      return { action: 'off', why: `${g.file} has not been in front for ${Math.round(away / 1000)} s` };
    return { action: null, why: `${g.file} is running behind ${d.file || 'another window'}` };
  }
  if (S.suppress) {
    const alive = scan && Array.isArray(scan.procs) ? scan.procs.some((p) => p.pid === S.suppress.pid) : true;
    if (!alive) return { action: 'unsuppress', why: 'the game Owen turned game mode off for has exited' };
    if (d.game && d.pid === S.suppress.pid) return { action: null, why: `turned off by hand for this run of ${d.file}` };
  }
  if (!auto) return { action: null, why: 'automatic game mode is off', game: d };
  if (d.game) return { action: 'on', why: d.why, game: d };
  return { action: null, why: d.why, game: d };
}

/* RUNNING, in front or not (valofix, 2026-09-26). The top bar lets go of its strip the moment a known
 * game STARTS, before its window exists: a game that comes up under a reserved strip and a topmost bar
 * can end up in a maximised window (Valorant did, with PreferredFullscreenMode=0 in its own config).
 * VALORANT.exe is the stub Riot Client starts, which starts the Shipping exe: watched too, so the bar
 * is gone a few seconds earlier. Names only, from the Toolhelp list: no handle to any of them. */
const RUN_EXES = KNOWN_GAMES.concat(['VALORANT.exe']);

/**
 * scan = gamemode.scan {procs:true} ({fg, procs, ownSession}); o = {seen: Map pid -> file, kept by the
 * caller (a javaw pid once it was in front with a Minecraft window: Java has no name of its own),
 * extra: [exe names] (TEST ONLY stand-ins)}. -> [{pid, file}] in Owen's own session. The scan is not
 * mutated; `seen` is (added from the window in front, dropped once its pid is gone).
 */
function runningGames(scan, o) {
  const opts = o || {};
  const seen = opts.seen || new Map();
  const procs = scan && Array.isArray(scan.procs) ? scan.procs : [];
  const d = detectGame(scan && scan.fg, procs);
  if (d.game && JAVA.some((j) => sameFile(j, d.file))) seen.set(d.pid, d.file);
  const names = RUN_EXES.concat(Array.isArray(opts.extra) ? opts.extra : []);
  const own = scan && scan.ownSession != null ? scan.ownSession : null;
  const out = [], alive = new Set();
  for (const p of procs) {
    if (!p) continue;
    alive.add(p.pid);
    if (own != null && p.session != null && p.session !== own) continue;   // another user's session
    if (names.some((g) => sameFile(g, p.file)) || (seen.has(p.pid) && sameFile(seen.get(p.pid), p.file))) out.push({ pid: p.pid, file: p.file });
  }
  if (procs.length) for (const pid of [...seen.keys()]) if (!alive.has(pid)) seen.delete(pid);
  return out;
}

/* MANTLE RESTS while a game runs (lane memfix, 2026-09-26: Owen closed Mantle to play Valorant, "it
 * was taking up too much ram and it made my game stutter"). main.js restMantle closes the windows
 * nothing needs in front of a game; this decides WHEN. */

/** "VALORANT" for VALORANT.exe / VALORANT-Win64-Shipping.exe; names joined, each once. */
function gameLabel(files) {
  const out = [];
  for (const f of [].concat(files || [])) {
    const n = baseName(f).replace(/\.exe$/i, '').replace(/-Win64-Shipping$/i, '');
    if (n && !out.some((x) => x.toLowerCase() === n.toLowerCase())) out.push(n);
  }
  return out.join(', ');
}

/**
 * One tick. R = {resting, why, hold: [pids] | null}; x = {run: runningGames() list, on: game mode is on,
 * how, game: game mode's game file, enabled: game mode's tray switch}. -> {action: null|'rest'|'wake',
 * why, hold (the hold to keep: null once its game has exited)}. PURE, never mutates.
 *   rest: game mode is on, or a known game RUNS (in front or not), unless Owen turned game mode off by
 *         hand during this run of it (hold = the pids that were running then);
 *   wake: none of that any more, or game mode is switched off in the tray.
 */
function restStep(R, x) {
  const run = (x && Array.isArray(x.run)) ? x.run : [];
  const alive = new Set(run.map((p) => p.pid));
  const hold = R && Array.isArray(R.hold) && R.hold.some((pid) => alive.has(pid)) ? R.hold : null;
  const enabled = !x || x.enabled !== false;
  const runs = run.length > 0 && !hold;
  const want = enabled && (!!(x && x.on) || runs);
  let why = null;
  if (want) {
    const names = gameLabel(runs ? run.map((p) => p.file) : (x.game ? [x.game] : []));
    why = names ? `${names} runs` : (x.how === 'manual' ? 'game mode is on (by hand)' : 'game mode is on');
  }
  const resting = !!(R && R.resting);
  if (want && (!resting || R.why !== why)) return { action: 'rest', why, hold };
  if (!want && resting) {
    return { action: 'wake', hold,
      why: !enabled ? "game mode was switched off in Mantle's tray menu"
        : hold && run.length ? 'game mode was turned off by hand for this game'
        : `${(R && R.why || 'the game runs').replace(/ runs$/, '')} ${/ runs$/.test(R && R.why || '') ? 'exited' : 'ended'}` };
  }
  return { action: null, why: want ? why : null, hold };
}

/**
 * Does a rest's `why` (restStep's, the words main.js restMantle is handed) say a GAME runs, rather than
 * game mode being on by hand with no game? "VALORANT runs" -> true; "game mode is on (by hand)" -> false.
 * lane gamequiet, 2026-09-28: main.js reads it to keep the bar down and screen capture off while a game
 * runs. Next to restStep so the two words cannot drift (lib/features/gamemode.test.js pins them).
 */
function restIsGame(why) {
  return typeof why === 'string' && / runs$/.test(why) && !/^game mode is on/.test(why);
}

function never(file) {
  for (const n of NEVER) if (n.re.test(file || '')) return n.why;
  return null;
}

/**
 * Which processes get Efficiency mode (+ below-normal priority when normal). procs = gamemode.scan
 * {procs, detail} rows; c = {gamePid, gameFile, fgPid, sidecarPid, ownSession, mantlePids:Set,
 * audioPids:Set}. -> {targets:[{pid, created, file, path, prio, group}], left:[{file, why}], quiet:n, pending:n}
 * `quiet` = Windows' own parts and other sessions, counted but not listed.
 */
function plan(procs, c) {
  const targets = [], left = [];
  let quiet = 0, pending = 0;
  const list = Array.isArray(procs) ? procs : [];
  const byPid = new Map(list.map((p) => [p.pid, p]));
  // the game's whole tree (Minecraft's javaw children, a crash handler) and everything run from its exe
  const inGame = (p) => {
    if (!c.gamePid) return false;
    if (p.pid === c.gamePid) return true;
    if (c.gameFile && sameFile(p.file, c.gameFile)) return true;
    for (let q = p, n = 0; q && n < 16; q = byPid.get(q.ppid), n++) if (q.ppid === c.gamePid) return true;
    return false;
  };
  // an app with ANY process playing sound keeps ALL its processes (Chromium plays from a utility
  // process while the page that decodes the video is another one)
  const audioPaths = new Set();
  for (const p of list) if (c.audioPids && c.audioPids.has(p.pid) && p.path) audioPaths.add(p.path.toLowerCase());
  const winDir = String(c.winDir || 'C:\\Windows').toLowerCase().replace(/\\+$/, '') + '\\';
  for (const p of list) {
    if (!p || p.pid <= 8 || p.session !== c.ownSession) { quiet++; continue; }
    if (p.pid === c.sidecarPid) { left.push({ file: p.file, why: never('Mantle.Sidecar.exe') }); continue; }
    // Mantle's MAIN process owns the desktop layer, a child window inside Explorer's desktop
    // (Progman), so the two share input and Explorer waits on it. Measured 2026-10-15 (lane
    // gamestutter): under full CPU load an Electron main in Efficiency mode + below-normal kept its
    // foreign parent waiting 2,488 ms for one reply (23 ms worst at normal) and its own timers
    // stalled 2.5-5.5 s; on 10-11 Explorer quit and Mantle crashed 4.5 s after game mode slowed it.
    // It is idle while Mantle rests, so slowing it saved nothing.
    if (c.mainPid && p.pid === c.mainPid) { left.push({ file: p.file, why: "Mantle's main process: its desktop layer sits inside Explorer's desktop, so slowing it can stall Explorer" }); continue; }
    if (inGame(p)) { left.push({ file: p.file, why: 'the game' }); continue; }
    const nv = never(p.file);
    if (nv) { left.push({ file: p.file, why: nv }); continue; }
    if (p.pid === c.fgPid) { left.push({ file: p.file, why: 'in front' }); continue; }
    // pending = the sidecar's first look at this process was still running when it answered (a slow
    // scan served from the last finished one): not "could not be read", just not read yet. Counted, so
    // the caller looks again at the next tick instead of in 30 s.
    if (p.pending) { pending++; continue; }
    if (!p.path) { left.push({ file: p.file, why: p.why || 'could not be read' }); continue; }
    if (p.path.toLowerCase().startsWith(winDir)) { quiet++; continue; }
    if (p.elevated) { left.push({ file: p.file, why: 'runs as administrator; Mantle does not' }); continue; }
    if ((c.audioPids && c.audioPids.has(p.pid)) || audioPaths.has(p.path.toLowerCase())) {
      left.push({ file: p.file, why: 'playing sound' }); continue;
    }
    targets.push({ pid: p.pid, created: p.created, file: p.file, path: p.path, prio: p.prio,
                   group: c.mantlePids && c.mantlePids.has(p.pid) ? 'mantle' : 'background' });
  }
  return { targets, left, quiet, pending };
}

/** The sidecar request for a target (apply) and for a record entry (restore). */
function applyItem(t) {
  return { pid: t.pid, created: t.created, file: t.file, eco: { control: 1, state: 1 },
           prio: t.prio === 'normal' ? 'belownormal' : null, prioIf: 'normal' };
}
function restoreItem(r) {
  const it = { pid: r.pid, created: r.created, file: r.file };
  if (r.eco) { it.eco = r.eco.was || { control: 0, state: 0 }; it.ecoIf = r.eco.set; }
  if (r.prio) { it.prio = r.prio.was; it.prioIf = r.prio.set; }
  return it;
}
/** What to remember from an apply result so a restart can put it back (null = nothing changed). */
function recordEntry(t, res) {
  if (!res) return null;
  const e = { pid: t.pid, created: res.created || t.created, file: res.file || t.file, group: t.group };
  if (res.eco && res.eco.wrote) e.eco = { was: res.eco.before || null, set: { control: 1, state: 1 } };
  if (res.prio && res.prio.wrote) e.prio = { was: res.prio.before, set: 'belownormal' };
  return e.eco || e.prio ? e : null;
}

/** "claude ×3, msedgewebview2 ×9" - counts by name, most first, at most `max` names. */
function names(list, max) {
  const m = new Map();
  for (const x of list) {
    // Mantle's own helper by what it is, not its exe name (no "sidecar" on screen)
    const k = /^Mantle\.Sidecar/i.test(String(x.file || '')) ? 'Mantle helper' : String(x.file || '?').replace(/\.exe$/i, '');
    m.set(k, (m.get(k) || 0) + 1);
  }
  const arr = [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const shown = arr.slice(0, max || 6).map(([k, n]) => (n > 1 ? `${k} ×${n}` : k));
  return shown.join(', ') + (arr.length > shown.length ? ` and ${arr.length - shown.length} more` : '');
}
/** left[] grouped by reason: [{why, text}] */
function leftByWhy(left) {
  const g = new Map();
  for (const l of left) { if (!g.has(l.why)) g.set(l.why, []); g.get(l.why).push(l); }
  return [...g.entries()].map(([why, l]) => ({ why, text: `${names(l, 4)} (${why})` }));
}

/* ---- GAME-MODE BOOST (lane mantle-boost, 2026-10-15; design: design notes: valorant-stutter section 6)
 * On this 11.7 GB laptop Valorant's long frames doubled between ~80% and ~91% memory in use (10-14).
 * Game mode already eases background apps (Efficiency mode + below-normal); the boost adds the memory
 * side: ONE working-set trim per idle background process, a minute into the game, never repeated (a
 * re-grow means the app is in use, and trimming it again only adds page faults). Nothing is closed,
 * killed or suspended: trimmed pages come back by themselves when the app touches them. The sidecar
 * (GameMode.cs TrimBg) checks every target again, and also refuses an app's main process and every
 * Chromium helper that is not a page (graphics, network, sound, storage). */
const TRIM_AFTER_MS = 60 * 1000;          // the trim runs this long after the CPU baseline (game mode on)
const IDLE_CPU_MS = 600;                  // idle = at most this much CPU time over that minute (1% of one core)
const TRIM_MIN_BYTES = 16 * 1048576;      // smaller ones are not worth a page fault later
const LOW_FREE_BYTES = 1.5 * 1073741824;  // still under this free after the trim: name the biggest app
// Trims per gamemode.trimbg call (lane mantle-m1). The trim runs on the sidecar's SHARED slow lane (icons,
// the tray, media, launch); one call for every idle process held that lane for the whole trim. A few per
// call keeps each hold well under 0.5 s (sidecar/test-lane-load.js measures it), and the lane serves the
// others between calls. Also at most TRIM_CALL_BYTES of working set per call: handing memory back costs
// ~0.23 ms per MB (measured: 8 processes, 637 MB, 144 ms), so four 500 MB apps would near the goal.
const TRIM_CHUNK = 4;
const TRIM_CALL_BYTES = 1024 * 1048576;
/** The trim list split into gamemode.trimbg calls: at most TRIM_CHUNK processes and TRIM_CALL_BYTES of
 * working set each; a process bigger than that goes alone. Order kept. */
function trimCalls(trim) {
  const calls = [];
  let cur = [], bytes = 0;
  for (const t of trim || []) {
    const w = Math.max(0, Number(t && t.ws) || 0);
    if (cur.length && (cur.length >= TRIM_CHUNK || bytes + w > TRIM_CALL_BYTES)) { calls.push(cur); cur = []; bytes = 0; }
    cur.push(t); bytes += w;
  }
  if (cur.length) calls.push(cur);
  return calls;
}
// Eased, never trimmed: an agent may be mid-task in them, and a trim would slow it down.
const NO_TRIM = /^(Helm|claude)/i;

function bytes(n) {
  const v = Math.max(0, Number(n) || 0);
  return v >= 1073741824 ? `${(v / 1073741824).toFixed(1)} GB` : `${Math.round(v / 1048576)} MB`;
}
/** "4 background apps": distinct exe names, so msedgewebview2 ×9 is one app. */
function appCount(list) {
  const n = new Set(list.map((x) => baseName(x && x.file).toLowerCase())).size;
  return `${n} background app${n === 1 ? '' : 's'}`;
}

/** The CPU baseline the idle rule compares against: pid -> {created, cpuMs}, from a detail scan. */
function cpuBase(procs) {
  const m = new Map();
  for (const p of Array.isArray(procs) ? procs : []) if (p && p.created && typeof p.cpuMs === 'number') m.set(p.pid, { created: p.created, cpuMs: p.cpuMs });
  return m;
}

/**
 * Which of the processes game mode EASED get the boost's one trim. procs = a detail scan; c = {eased:
 * [record entries {pid, created, file, group}], base: cpuBase() from >= TRIM_AFTER_MS ago, audioPids: Set,
 * done: Set of pids trimmed already this game}. -> {trim:[{pid, created, file, ws}], skip:[{file, why}], small:n}.
 * Only what game mode already eased can be trimmed, so every never-touch rule of plan() holds here too.
 */
function trimPlan(procs, c) {
  const list = Array.isArray(procs) ? procs : [];
  const byPid = new Map(list.map((p) => [p.pid, p]));
  const parents = new Set();
  for (const p of list) { const q = byPid.get(p.ppid); if (q && q.pid !== p.pid && sameFile(q.file, p.file)) parents.add(q.pid); }
  const audioPaths = new Set();
  for (const p of list) if (c.audioPids && c.audioPids.has(p.pid) && p.path) audioPaths.add(p.path.toLowerCase());
  const trim = [], skip = [];
  let small = 0;
  for (const e of Array.isArray(c.eased) ? c.eased : []) {
    if (!e || e.group !== 'background') continue;
    if (c.done && c.done.has(e.pid)) continue;
    const p = byPid.get(e.pid);
    if (!p || (p.created && e.created && String(p.created) !== String(e.created))) continue;   // exited
    if (NO_TRIM.test(p.file || '')) { skip.push({ file: p.file, why: 'Helm and Claude are only eased: an agent may be working' }); continue; }
    if ((c.audioPids && c.audioPids.has(p.pid)) || (p.path && audioPaths.has(p.path.toLowerCase()))) { skip.push({ file: p.file, why: 'playing sound' }); continue; }
    if (parents.has(p.pid)) { skip.push({ file: p.file, why: "its app's main process" }); continue; }
    const b = c.base && c.base.get(p.pid);
    if (!b || String(b.created) !== String(p.created)) { skip.push({ file: p.file, why: 'started after the game' }); continue; }
    if (typeof p.cpuMs === 'number' && p.cpuMs - b.cpuMs > (c.idleCpuMs || IDLE_CPU_MS)) { skip.push({ file: p.file, why: 'busy in the last minute' }); continue; }
    if (!(p.ws >= TRIM_MIN_BYTES)) { small++; continue; }
    trim.push({ pid: p.pid, created: p.created, file: p.file, ws: p.ws });
  }
  return { trim, skip, small };
}

/**
 * The biggest app still holding memory (summed by exe name over the scan, never the game or anything
 * on the never-touch list): the words for "still under 1.5 GB free". null when nothing is worth naming.
 */
function biggestApp(procs, c) {
  const m = new Map();
  for (const p of Array.isArray(procs) ? procs : []) {
    if (!p || !(p.ws > 0) || p.session !== c.ownSession || p.pid === c.gamePid || p.pid === c.mainPid || never(p.file)) continue;
    if (c.mantlePids && c.mantlePids.has(p.pid)) continue;           // Mantle's own rest instead
    if (!p.path || p.path.toLowerCase().startsWith(String(c.winDir || 'C:\\Windows').toLowerCase())) continue;
    if (c.gameFile && sameFile(p.file, c.gameFile)) continue;
    const k = baseName(p.file).replace(/\.exe$/i, '');
    m.set(k, (m.get(k) || 0) + p.ws);
  }
  let best = null;
  for (const [name, ws] of m) if (!best || ws > best.ws) best = { name, ws };
  return best && best.ws >= 256 * 1048576 ? best : null;
}

/** The boost's one line: "Freed 1.2 GB and eased 4 background apps". b = {eased:[...], freed, trimmed}. */
function boostLine(b) {
  const eased = b.eased && b.eased.length ? `eased ${appCount(b.eased)}` : 'no background app to ease';
  if (!(b.trimmed > 0)) return `${eased.charAt(0).toUpperCase()}${eased.slice(1)}`;
  return `Freed ${bytes(b.freed)} and ${eased}`;
}

module.exports = { KNOWN_GAMES, RUN_EXES, NEVER, AWAY_MS, detectGame, runningGames, step, restStep, restIsGame, gameLabel, plan, never, applyItem, restoreItem, recordEntry, names, leftByWhy, baseName, sameFile,
  TRIM_AFTER_MS, IDLE_CPU_MS, TRIM_MIN_BYTES, LOW_FREE_BYTES, TRIM_CHUNK, TRIM_CALL_BYTES, trimCalls, NO_TRIM, bytes, appCount, cpuBase, trimPlan, biggestApp, boostLine };

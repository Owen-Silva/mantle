'use strict';
/*
 * run-line.test.js - Win+R's line parsing (lib/run-line.js) and Win+X's table (lib/quick-links.js),
 * in plain node with a FAKE disk: nothing is opened, nothing is run (lane keysrun, 2026-10-15).
 *
 *   node lib/run-line.test.js        prints "RUN LINE TEST: n passed, m failed"
 */
const fs = require('fs');
const R = require('./run-line');
const QL = require('./quick-links');

let passed = 0;
const failures = [];
function check(name, ok, detail) { if (ok) passed++; else failures.push(name + (detail !== undefined ? ' -- ' + detail : '')); }
const show = (x) => JSON.stringify(x);

const ENV = {
  APPDATA: 'C:\\Users\\o\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\o\\AppData\\Local',
  TEMP: 'C:\\Users\\o\\AppData\\Local\\Temp', USERPROFILE: 'C:\\Users\\o', SystemRoot: 'C:\\WINDOWS',
  ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)', ProgramData: 'C:\\ProgramData',
};
const KNOWN = { downloads: 'C:\\Users\\o\\Downloads', documents: 'C:\\Users\\o\\OneDrive\\Documents', desktop: 'C:\\Users\\o\\OneDrive\\Desktop' };
const DIRS = ['C:\\', 'C:\\Users', 'C:\\Users\\o', 'C:\\Users\\o\\AppData\\Roaming', 'C:\\Users\\o\\AppData\\Roaming\\.minecraft',
  'C:\\Users\\o\\AppData\\Roaming\\.minecraft\\saves', 'C:\\Users\\o\\AppData\\Local\\Temp', 'C:\\Users\\o\\Documents',
  'C:\\Program Files', 'C:\\Program Files\\My App', 'C:\\Users\\o\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup',
  'C:\\Users\\o\\Downloads', 'C:\\Users\\o\\OneDrive\\Documents', '\\\\nas\\share'];
const FILES = ['C:\\Program Files\\My App\\app.exe', 'C:\\Users\\o\\notes.txt', 'C:\\Users\\o\\AppData\\Roaming\\.minecraft\\options.txt'];
const norm = (p) => { let s = String(p).toLowerCase(); if (s.length > 3 && s.endsWith('\\')) s = s.slice(0, -1); return s; };
const D = new Set(DIRS.map(norm)), F = new Set(FILES.map(norm));
const statted = [];
const stat = async (p) => { statted.push(p); return D.has(norm(p)) ? 'dir' : F.has(norm(p)) ? 'file' : null; };
const deps = { env: ENV, profile: ENV.USERPROFILE, stat, known: KNOWN };
const plan = (line, extra) => R.plan(line, Object.assign({}, deps, extra || {}));

async function main() {
  /* ---- expandEnv: ExpandEnvironmentStrings semantics ---- */
  check('env: %appdata% (any case)', R.expandEnv('%appdata%', ENV) === ENV.APPDATA && R.expandEnv('%AppData%', ENV) === ENV.APPDATA);
  check('env: inside a path', R.expandEnv('%APPDATA%\\.minecraft', ENV) === ENV.APPDATA + '\\.minecraft');
  check('env: two in a row', R.expandEnv('%temp%%appdata%', ENV) === ENV.TEMP + ENV.APPDATA);
  check('env: an unknown name stays as typed', R.expandEnv('%nope%\\x', ENV) === '%nope%\\x');
  check('env: an unknown name\'s closing % opens the next', R.expandEnv('%nope%appdata%', ENV) === '%nope' + ENV.APPDATA, R.expandEnv('%nope%appdata%', ENV));
  check('env: %% and a lone % stay', R.expandEnv('100%% a%', ENV) === '100%% a%');
  check('env: no % is untouched', R.expandEnv('perfmon /report', ENV) === 'perfmon /report');
  check('env: names with ( ) work', R.expandEnv('%ProgramFiles(x86)%', ENV) === 'C:\\Program Files (x86)');

  /* ---- splitFirst / splits ---- */
  check('split: program and arguments', show(R.splitFirst('perfmon /report')) === show({ file: 'perfmon', params: '/report', quoted: false }));
  check('split: a quoted program keeps its spaces', R.splitFirst('"C:\\a b\\c.exe" -x "y z"').file === 'C:\\a b\\c.exe' && R.splitFirst('"C:\\a b\\c.exe" -x "y z"').params === '-x "y z"');
  check('split: arguments are verbatim (quotes, spacing, & and |)', R.splitFirst('cmd /k echo  "a"  & ver | more').params === '/k echo  "a"  & ver | more');
  check('split: an unclosed quote is the whole name', R.splitFirst('"C:\\a b').file === 'C:\\a b');
  check('split: a tab separates too', R.splitFirst('app\t-x').file === 'app' && R.splitFirst('app\t-x').params === '-x');
  const sp = R.splits('C:\\Program Files\\My App\\app.exe --flag');
  check('splits: longest first', sp[0].file === 'C:\\Program Files\\My App\\app.exe --flag' && sp[1].file === 'C:\\Program Files\\My App\\app.exe' && sp[1].params === '--flag' && sp[sp.length - 1].file === 'C:\\Program', show(sp));

  /* ---- plan: the kinds ---- */
  const P = async (name, line, want, extra) => {
    const got = await plan(line, extra);
    const ok = Object.keys(want).every((k) => got[k] === want[k]);
    check('plan: ' + name, ok, `${show(line)} -> ${show(got)}`);
    return got;
  };
  await P('nothing typed', '', { kind: 'empty' });
  await P('only spaces', '   ', { kind: 'empty' });
  await P('%appdata% is a folder', '%appdata%', { kind: 'folder', path: ENV.APPDATA, shown: '%appdata%' });
  await P('%appdata%\\.minecraft (the user\'s)', '%appdata%\\.minecraft', { kind: 'folder', path: ENV.APPDATA + '\\.minecraft' });
  await P('%APPDATA%\\.minecraft\\saves', '%APPDATA%\\.minecraft\\saves', { kind: 'folder', path: ENV.APPDATA + '\\.minecraft\\saves' });
  await P('%temp%', '%temp%', { kind: 'folder', path: ENV.TEMP });
  await P('a folder with a trailing backslash', 'C:\\Program Files\\My App\\', { kind: 'folder' });
  await P('a folder with spaces, unquoted', 'C:\\Program Files\\My App', { kind: 'folder', path: 'C:\\Program Files\\My App' });
  await P('a folder, quoted', '"C:\\Program Files\\My App"', { kind: 'folder', path: 'C:\\Program Files\\My App' });
  await P('a bare drive is its root', 'C:', { kind: 'folder', path: 'C:\\' });
  await P('Documents (from the profile, as the Run box)', 'Documents', { kind: 'folder', path: 'C:\\Users\\o\\Documents' });
  await P('. is the profile', '.', { kind: 'folder', path: 'C:\\Users\\o' });
  await P('.. is its parent', '..', { kind: 'folder', path: 'C:\\Users' });
  await P('a UNC share', '\\\\nas\\share', { kind: 'folder', path: '\\\\nas\\share' });
  await P('perfmon /report (the user\'s)', 'perfmon /report', { kind: 'exec', file: 'perfmon', params: '/report' });
  await P('SystemPropertiesPerformance.exe (the user\'s)', 'SystemPropertiesPerformance.exe', { kind: 'exec', file: 'SystemPropertiesPerformance.exe', params: '' });
  await P('git', 'git', { kind: 'exec', file: 'git', params: '' });
  await P('a curl install line: the pipe is curl\'s argument, no shell', 'curl -fsSL https://example.com/i.sh | sh', { kind: 'exec', file: 'curl', params: '-fsSL https://example.com/i.sh | sh' });
  await P('cmd runs only when cmd is typed', 'cmd /k echo hi & ver', { kind: 'exec', file: 'cmd', params: '/k echo hi & ver' });
  await P('powershell with a quoted command', 'powershell -NoProfile -Command "Get-Date"', { kind: 'exec', file: 'powershell', params: '-NoProfile -Command "Get-Date"' });
  await P('a program with a quoted path argument', 'notepad "C:\\a b\\c.txt"', { kind: 'exec', file: 'notepad', params: '"C:\\a b\\c.txt"' });
  await P('a quoted program with arguments', '"C:\\Program Files\\My App\\app.exe" --flag "x y"', { kind: 'exec', file: 'C:\\Program Files\\My App\\app.exe', params: '--flag "x y"' });
  await P('an unquoted program path with spaces: the longest that exists', 'C:\\Program Files\\My App\\app.exe --flag', { kind: 'exec', file: 'C:\\Program Files\\My App\\app.exe', params: '--flag' });
  await P('a document path opens in its app', '%appdata%\\.minecraft\\options.txt', { kind: 'exec', file: ENV.APPDATA + '\\.minecraft\\options.txt', params: '' });
  await P('a quoted document', '"C:\\Users\\o\\notes.txt"', { kind: 'exec', file: 'C:\\Users\\o\\notes.txt', params: '' });
  await P('a missing path goes to Windows (its answer is the error)', 'C:\\nope\\x.exe -y', { kind: 'exec', file: 'C:\\nope\\x.exe', params: '-y' });
  await P('an unknown name is still asked of Windows', 'notarealprogram', { kind: 'exec', file: 'notarealprogram' });
  await P('an unknown %var% stays literal', '%nope%', { kind: 'exec', file: '%nope%' });
  await P('shell:startup is a folder', 'shell:startup', { kind: 'folder', path: ENV.APPDATA + '\\Microsoft\\Windows\\Start Menu\\Programs\\Startup' });
  await P('shell:Downloads uses Windows\' known folder', 'shell:Downloads', { kind: 'folder', path: KNOWN.downloads });
  await P('shell:personal is Documents (OneDrive)', 'shell:personal', { kind: 'folder', path: KNOWN.documents });
  await P('shell:appdata\\.minecraft', 'shell:appdata\\.minecraft', { kind: 'folder', path: ENV.APPDATA + '\\.minecraft' });
  await P('shell:AppsFolder is virtual: Windows\' road', 'shell:AppsFolder', { kind: 'exec', file: 'shell:AppsFolder', params: '' });
  await P('shell:::{CLSID} is Windows\' road', 'shell:::{20D04FE0-3AEA-1069-A2D8-08002B30309D}', { kind: 'exec', params: '' });
  await P('https URL', 'https://example.com/a?b=c d', { kind: 'url', url: 'https://example.com/a?b=c d' });
  await P('www. gets http://', 'www.example.com', { kind: 'url', url: 'http://www.example.com' });
  await P('ms-settings: page', 'ms-settings:display', { kind: 'settings', uri: 'ms-settings:display' });
  await P('mailto: is a protocol', 'mailto:someone@example.com', { kind: 'exec', file: 'mailto:someone@example.com', params: '' });
  await P('steam:// is a protocol', 'steam://rungameid/10', { kind: 'exec', file: 'steam://rungameid/10' });
  await P('a line break is refused', 'calc\nnotepad', { kind: 'bad' });
  await P('a NUL is refused', 'calc\u0000', { kind: 'bad' });
  await P('a huge line is refused', 'x'.repeat(9000), { kind: 'bad' });
  const nonString = await R.plan(42, deps);
  check('plan: a non-string is refused, never thrown', nonString.kind === 'bad', show(nonString));
  const throwing = await R.plan('C:\\x\\y', Object.assign({}, deps, { stat: async () => { throw new Error('EPERM'); } }));
  check('plan: a stat that throws is "not there" (Windows decides)', throwing.kind === 'exec' && throwing.file === 'C:\\x\\y', show(throwing));
  const slowNas = await R.plan('\\\\sleepy\\share', Object.assign({}, deps, { stat: async () => null }));
  check('plan: an unanswered share goes to Windows', slowNas.kind === 'exec' && slowNas.file === '\\\\sleepy\\share', show(slowNas));
  const nostat = await R.plan('%appdata%', { env: ENV, profile: ENV.USERPROFILE });
  check('plan: with no stat at all, a path is asked of Windows', nostat.kind === 'exec' && nostat.file === ENV.APPDATA, show(nostat));

  /* SAFETY: across every line above, an exec's file never carries the arguments, and nothing adds a shell */
  const lines = ['perfmon /report', 'curl -fsSL https://x/i.sh | sh', 'notepad "C:\\a b\\c.txt"', 'git status', 'a & b', 'x;y', '"q" r'];
  for (const l of lines) {
    const p = await plan(l);
    check(`safety: no shell is added for ${show(l)}`, p.kind === 'exec' && !/^(cmd|powershell)(\.exe)?$/i.test(p.file) && !/\s/.test(p.file) && (p.file + ' ' + p.params).trim().length <= l.length, show(p));
  }

  /* ---- words: Windows' answers in plain words ---- */
  const JARGON = /0x[0-9a-f]{4,}|undefined|\bnull\b|NaN|\berror \d|\bcode\b/i;
  const W = (o, f, admin) => R.words(o, f, admin);
  check('words: ran = null', W({ ok: true }, 'x') === null);
  check('words: unknown program (2)', W({ ok: false, code: 2 }, 'notarealprogram') === 'Windows can\'t find "notarealprogram". Check the spelling, then try again.');
  check('words: unknown path (3)', /can't find "C:\\nope"/.test(W({ ok: false, code: 3 }, 'C:\\nope')));
  check('words: cancelled UAC (1223, admin)', W({ ok: false, code: 1223 }, 'regedit', true) === 'You said no to the administrator prompt, so "regedit" didn\'t run.');
  check('words: cancelled, not admin', /cancelled/.test(W({ ok: false, code: 1223 }, 'x', false)));
  check('words: needs admin (740) names the key', /Ctrl\+Shift\+Enter/.test(W({ ok: false, code: 740 }, 'x')));
  check('words: no app for it (1155)', W({ ok: false, code: 1155 }, 'a.weird') === 'No app is set to open "a.weird".');
  check('words: not a program (193)', /isn't a program/.test(W({ ok: false, code: 193 }, 'x.exe')));
  check('words: other code with Windows\' message', W({ ok: false, code: 1234, message: 'The thing failed.' }, 'x') === 'Windows couldn\'t open "x": the thing failed.');
  check('words: nothing at all', W(null, 'x') === 'Windows couldn\'t open "x".');
  check('words: a long name is cut in the middle', W({ ok: false, code: 2 }, 'a'.repeat(200)).length < 140);
  for (const c of [2, 3, 5, 8, 193, 216, 225, 740, 1155, 1156, 1223, 1260, 9999]) {
    const w = W({ ok: false, code: c, message: c === 9999 ? 'Unspecified failure' : undefined }, 'prog', c % 2 === 0);
    check(`words: ${c} is plain (no codes, no undefined)`, typeof w === 'string' && !JARGON.test(w) && /^[A-Z"]/.test(w), w);
  }

  /* ---- history ---- */
  const own = ['perfmon /report', '%appdata%'];
  const mru = ['%APPDATA%', 'git', '', 42, 'bad\nline', 'SystemPropertiesPerformance.exe'];
  const merged = R.mergeHistory(own, mru);
  check('history: Mantle\'s first, then RunMRU without repeats (case-blind), junk dropped', show(merged) === show(['perfmon /report', '%appdata%', 'git', 'SystemPropertiesPerformance.exe']), show(merged));
  check('history: capped at 50', R.mergeHistory(Array.from({ length: 80 }, (_, i) => 'c' + i), ['x']).length === R.HISTORY_MAX);
  check('history: remember puts it first, once', show(R.remember(own, '%APPDATA%')) === show(['%APPDATA%', 'perfmon /report']));
  check('history: remember ignores blank and bad lines', show(R.remember(own, '  ')) === show(own) && show(R.remember(own, 'a\nb')) === show(own));
  check('history: remember caps', R.remember(Array.from({ length: 60 }, (_, i) => 'c' + i), 'new').length === R.HISTORY_MAX);
  check('history: remember of a non-list starts one', show(R.remember(null, 'git')) === show(['git']));
  const H = ['perfmon /report', '%appdata%\\.minecraft', 'git', 'SystemPropertiesPerformance.exe', '%appdata%'];
  check('complete: starts-with first, then contains', show(R.complete(H, 'perf')) === show(['perfmon /report', 'SystemPropertiesPerformance.exe']), show(R.complete(H, 'perf')));
  check('complete: case-blind', show(R.complete(H, '%APPDATA%')) === show(['%appdata%\\.minecraft', '%appdata%']));
  check('complete: nothing typed = the newest', show(R.complete(H, '', 2)) === show(['perfmon /report', '%appdata%\\.minecraft']));
  check('complete: no match = none', R.complete(H, 'zzz').length === 0);

  /* ---- folder completion ---- */
  const listing = {
    [norm(ENV.APPDATA)]: [{ name: '.minecraft', dir: true }, { name: 'Microsoft', dir: true }, { name: '.mineprefs', dir: false }, { name: 'npm', dir: true }],
    [norm('C:\\Program Files')]: [{ name: 'My App', dir: true }, { name: 'Mozilla', dir: true }],
  };
  const list = async (d) => { const l = listing[norm(d)]; if (!l) throw new Error('ENOENT'); return l; };
  const cp = async (t) => R.completePath(t, { env: ENV, list });
  check('path: %appdata%\\.mine -> the folder first, written as typed', show(await cp('%appdata%\\.mine')) === show([{ text: '%appdata%\\.minecraft\\', dir: true }, { text: '%appdata%\\.mineprefs', dir: false }]), show(await cp('%appdata%\\.mine')));
  check('path: C:\\Program Files\\M', show((await cp('C:\\Program Files\\M')).map((x) => x.text)) === show(['C:\\Program Files\\Mozilla\\', 'C:\\Program Files\\My App\\']));
  check('path: case-blind prefix', (await cp('%APPDATA%\\MICRO')).length === 1);
  check('path: no backslash = none', (await cp('perfmon')).length === 0);
  check('path: a relative folder = none', (await cp('foo\\b')).length === 0);
  check('path: a folder that cannot be listed = none', (await cp('C:\\nope\\x')).length === 0);
  check('path: a bad line = none', (await cp('C:\\a\nb\\')).length === 0);

  /* ---- Win+X: the table ---- */
  const WANT = [['apps', 'Installed a&pps'], ['mobility', 'Mo&bility Center'], ['power', 'Power &Options'], ['events', 'Event &Viewer'],
    ['system', 'S&ystem'], ['devices', 'Device &Manager'], ['network', 'Net&work Connections'], ['disks', 'Dis&k Management'],
    ['computer', 'Computer Mana&gement'], ['terminal', 'Term&inal'], ['terminaladmin', 'Terminal (&Admin)'], ['taskmgr', '&Task Manager'],
    ['settings', 'Setti&ngs'], ['files', 'File &Explorer'], ['search', '&Search'], ['run', '&Run'], ['shutdown', 'Sh&ut down or sign out'], ['desktop', '&Desktop']];
  check('quick: every Win+X row, in Windows\' order, with Windows\' label', show(QL.LINKS.map((l) => [l.id, l.label])) === show(WANT), show(QL.LINKS.map((l) => l.label)));
  check('quick: the keys are Windows\' letters', QL.LINKS.map((l) => QL.parse(l.label).letter).join('') === 'pbOVyMwkgiATnESRuD', QL.LINKS.map((l) => QL.parse(l.label).letter).join(''));
  check('quick: no key is used twice', new Set(QL.LINKS.map((l) => QL.parse(l.label).key)).size === QL.LINKS.length);
  check('quick: the submenu is Windows\' (Sign out I, Sleep S, Hibernate H, Shut down U, Restart R)',
    QL.POWER.map((p) => QL.parse(p.label).key).join('') === 'ishur' && QL.POWER.map((p) => QL.parse(p.label).text).join('|') === 'Sign out|Sleep|Hibernate|Shut down|Restart');
  check('quick: Sign out, Shut down and Restart ask first', QL.POWER.filter((p) => p.confirm).map((p) => p.id).join() === 'signout,shutdown,restart');
  check('quick: byKey is case-blind', QL.byKey(QL.LINKS, 'M').id === 'devices' && QL.byKey(QL.LINKS, 'm').id === 'devices' && QL.byKey(QL.LINKS, 'a').id === 'terminaladmin');
  check('quick: byKey of nothing / two letters / unknown = null', QL.byKey(QL.LINKS, '') === null && QL.byKey(QL.LINKS, 'mm') === null && QL.byKey(QL.LINKS, 'z') === null);
  check('quick: byId', QL.byId('desktop').label === '&Desktop' && QL.byId('nope') === null);
  check('quick: parse', show(QL.parse('Device &Manager')) === show({ text: 'Device Manager', before: 'Device ', letter: 'M', after: 'anager', key: 'm' }) && QL.parse('No key').key === '');
  check('quick: every row runs a known kind or is the page\'s', QL.LINKS.every((l) => (l.run && ['settings', 'mantle', 'exec', 'terminal', 'desktop'].includes(l.run.kind)) || ['search', 'run', 'power'].includes(l.page)));
  check('quick: tools are bare Windows names (no paths, no arguments)', QL.LINKS.filter((l) => l.run && l.run.kind === 'exec').every((l) => /^[a-z]+\.(msc|exe)$/i.test(l.run.file)));
  check('quick: Mantle\'s own three', ['taskmgr', 'settings', 'files'].every((id) => /^mantle:/.test(QL.byId(id).run.path)));
  // Cross-check against THIS PC's own strings when they are here (the user's machine; a runner may lack the file)
  const mui = 'C:\\Windows\\System32\\en-US\\twinui.pcshell.dll.mui';
  if (fs.existsSync(mui)) {
    const t = fs.readFileSync(mui).toString('utf16le');
    const missing = QL.LINKS.map((l) => l.label).filter((l) => !t.includes(l));
    check('quick: every label is in Windows\' own menu strings on this PC', missing.length === 0, show(missing));
  }
  const sd = 'C:\\Windows\\System32\\en-US\\shutdownux.dll.mui';
  if (fs.existsSync(sd)) {
    const t = fs.readFileSync(sd).toString('utf16le');
    const missing = QL.POWER.map((p) => p.label).filter((l) => !t.includes(l));
    check('quick: every submenu label is in Windows\' own strings on this PC', missing.length === 0, show(missing));
  }
}

main().catch((e) => check('the run finished', false, e && e.stack)).then(() => {
  for (const f of failures) console.log('FAIL ' + f);
  console.log(`RUN LINE TEST: ${passed} passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
});

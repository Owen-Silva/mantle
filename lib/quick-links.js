/* quick-links.js - the launcher's Quick links mode (Win+X), Mantle's version of Windows' Win+X menu
 * (lane keysrun, 2026-10-15). ONE table, read by the page (ui/launcher, as a plain script) for the
 * rows and their keys, and by main (lib/features/quicklinks.js) for what each row does: the page
 * sends only a row's id, never a path or a command, so nothing a page says can choose what runs.
 *
 * LABELS AND KEYS are Windows' own, character for character: read on 2026-10-15 from Owen's build
 * (26300, en-US) in C:\Windows\System32\en-US\twinui.pcshell.dll.mui (the menu) and
 * shutdownux.dll.mui (the Shut down submenu); "&" marks the underlined letter, as there. The groups
 * and their order are the menu's (%LOCALAPPDATA%\Microsoft\Windows\WinX\Group3, 2, 1, top to bottom).
 * Mobility Center is in his WinX folder because this PC is a laptop, so it is here too.
 *
 * WHERE EACH ROW GOES: Windows' own tool for the system tools (ShellExecuteEx, through run.exec);
 * Mantle's Task Manager, Settings and Files for those three (each falls back to Windows' when it is
 * off, the launcher's rule); a Settings page through Mantle Settings where it claims the page; Search
 * and Run switch the launcher's mode; Shut down or sign out opens the submenu; Desktop is Win+D's
 * toggle (sidecar hotcorners.desktop).
 *
 * UMD: window.MantleQuickLinks in the sandboxed page, require() in main and the tests.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MantleQuickLinks = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var LINKS = [
    { id: 'apps', label: 'Installed a&pps', group: 1, run: { kind: 'settings', uri: 'ms-settings:appsfeatures' } },
    { id: 'mobility', label: 'Mo&bility Center', group: 1, run: { kind: 'exec', file: 'mblctr.exe' } },
    { id: 'power', label: 'Power &Options', group: 1, run: { kind: 'settings', uri: 'ms-settings:powersleep' } },
    { id: 'events', label: 'Event &Viewer', group: 1, run: { kind: 'exec', file: 'eventvwr.msc' } },
    { id: 'system', label: 'S&ystem', group: 1, run: { kind: 'settings', uri: 'ms-settings:about' } },
    { id: 'devices', label: 'Device &Manager', group: 1, run: { kind: 'exec', file: 'devmgmt.msc' } },
    { id: 'network', label: 'Net&work Connections', group: 1, run: { kind: 'settings', uri: 'ms-settings:network-status' } },
    { id: 'disks', label: 'Dis&k Management', group: 1, run: { kind: 'exec', file: 'diskmgmt.msc' } },
    { id: 'computer', label: 'Computer Mana&gement', group: 1, run: { kind: 'exec', file: 'compmgmt.msc' } },
    { id: 'terminal', label: 'Term&inal', group: 1, run: { kind: 'terminal' } },
    { id: 'terminaladmin', label: 'Terminal (&Admin)', group: 1, run: { kind: 'terminal', admin: true } },
    { id: 'taskmgr', label: '&Task Manager', group: 2, run: { kind: 'mantle', path: 'mantle:taskmgr' }, sub: 'Mantle' },
    { id: 'settings', label: 'Setti&ngs', group: 2, run: { kind: 'mantle', path: 'mantle:settings' }, sub: 'Mantle' },
    { id: 'files', label: 'File &Explorer', group: 2, run: { kind: 'mantle', path: 'mantle:files' }, sub: 'Mantle Files' },
    { id: 'search', label: '&Search', group: 2, page: 'search' },
    { id: 'run', label: '&Run', group: 2, page: 'run' },
    { id: 'shutdown', label: 'Sh&ut down or sign out', group: 3, page: 'power' },
    { id: 'desktop', label: '&Desktop', group: 3, run: { kind: 'desktop' } },
  ];

  /* The submenu, Windows' order. These go through the launcher's own power command (launcher.power),
     so Sign out, Shut down and Restart ASK FIRST as everywhere in Mantle: the key once arms the row,
     the same key again (or Enter) does it. */
  var POWER = [
    { id: 'signout', label: 'S&ign out', action: 'signout', confirm: true },
    { id: 'sleep', label: '&Sleep', action: 'sleep' },
    { id: 'hibernate', label: '&Hibernate', action: 'hibernate' },
    { id: 'shutdown', label: 'Sh&ut down', action: 'shutdown', confirm: true },
    { id: 'restart', label: '&Restart', action: 'restart', confirm: true },
  ];

  /** "Device &Manager" -> { text: 'Device Manager', before: 'Device ', letter: 'M', after: 'anager', key: 'm' } */
  function parse(label) {
    var s = String(label == null ? '' : label);
    var at = s.indexOf('&');
    if (at < 0 || at === s.length - 1) return { text: s, before: s, letter: '', after: '', key: '' };
    var letter = s.charAt(at + 1);
    return { text: s.slice(0, at) + s.slice(at + 1), before: s.slice(0, at), letter: letter, after: s.slice(at + 2), key: letter.toLowerCase() };
  }

  /** The row in `list` whose key is `key` (one character, any case), or null. */
  function byKey(list, key) {
    var k = String(key == null ? '' : key).toLowerCase();
    if (k.length !== 1) return null;
    for (var i = 0; i < list.length; i++) if (parse(list[i].label).key === k) return list[i];
    return null;
  }

  function byId(id) {
    for (var i = 0; i < LINKS.length; i++) if (LINKS[i].id === id) return LINKS[i];
    return null;
  }

  return { LINKS: LINKS, POWER: POWER, parse: parse, byKey: byKey, byId: byId };
}));

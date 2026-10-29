/* content.js - every word on the three welcome cards (lane mantle-firstrun, 2026-10-15).
 *
 * EVERY KEY AND FACT HERE IS CHECKED AGAINST MANTLE'S CODE by lib/welcome.test.js ("truth" checks):
 * a renamed menu item, a moved shortcut or a new hot-corner default fails that test instead of
 * leaving a card that tells a new user something false. Where each one comes from:
 *
 *   Win tap -> launcher            main.js hotkey winTap ("a tap of the Win key opens the Mantle launcher")
 *   Alt+Space -> launcher          main.js registerShortcuts
 *   Alt+Tab                        lib/switcher.js settings {altTab: true}
 *   Win+Shift+S                    lib/features/screenshot.js chords + autoSave default false (copied only)
 *   Win+Tab -> Task view           lib/features/taskview.js chords
 *   Win+I -> Mantle Settings       lib/features/settings.js CHORD
 *   hot corners                    lib/features/_corners.js DEFAULTS / ACTION_NAMES / CORNER_DWELL_MS
 *                                  (the page shows the LIVE corners from corners.state when it answers)
 *   the bar rises from the edge    main.js BAR_MODE 'hover' unless --dock; the logon task has no --dock
 *   pins carry over                lib/pinned.js (the apps pinned to the Windows taskbar)
 *   top bar                        lib/features/topbar.js (Mantle menu, app menus, CPU/RAM/GPU)
 *   launcher groups                ui/launcher/groups.js Apps / Settings / Files
 *   "More" (•••) menu items        ui/bar/bar.js: "Restore Windows taskbar", "Quit Mantle" (two clicks)
 *   tray after a restore           main.js trayTemplate "Restart Mantle to resume"
 *   kill switch                    main.js registerShortcuts Ctrl+Alt+Shift+Backspace
 *   start at sign-in               tools/install-autostart.ps1 (task "Mantle"), npm run autostart:remove
 *   Keyboard shortcuts page        ui/settings/settings.js V.shortcuts "Keyboard shortcuts"
 */
(function (root) {
  'use strict';
  var C = {
    title: 'Welcome to Mantle',
    cards: [
      {
        id: 'changed', step: 'What changed',
        title: 'A new shell, with Windows underneath',
        lead: 'Mantle takes over the taskbar and Start. Your apps, files and Windows settings are exactly where you left them.',
        items: [
          { icon: 'bar', name: 'The bar', text: 'Push the pointer to the bottom edge and it rises: your open apps and the ones pinned to your taskbar.' },
          { icon: 'top', name: 'The top bar', text: 'The Mantle menu and the menus of the app in front, with CPU, memory and GPU on the right.' },
          { icon: 'launcher', name: 'The launcher', text: 'Mantle’s Start. Tap Win and type to find apps, settings and files.' },
        ],
      },
      {
        id: 'keys', step: 'The keys',
        title: 'The keys you know, answered by Mantle',
        keys: [
          { keys: ['Win'], what: 'Open the launcher', note: 'Alt+Space works too' },
          { keys: ['Alt', 'Tab'], what: 'Switch windows' },
          { keys: ['Win', 'Shift', 'S'], what: 'Screenshot an area', note: 'Copied to the clipboard; Save keeps a file' },
          { keys: ['Win', 'Tab'], what: 'Task view' },
          { keys: ['Win', 'I'], what: 'Mantle Settings' },
        ],
        corners: {
          title: 'Hot corners',
          // the defaults; the page swaps in the live corners (corners.state) when they come back
          actions: { tl: 'taskview', tr: 'off', bl: 'off', br: 'desktop' },
          names: { tl: 'Top-left', tr: 'Top-right', bl: 'Bottom-left', br: 'Bottom-right' },
          labels: { off: 'Off', taskview: 'Task view', desktop: 'Show desktop', launcher: 'Launcher', qs: 'Quick settings', lock: 'Lock screen' },
          how: 'Rest the pointer in a corner for a moment.',
          off: 'Hot corners are off. Turn them on in Mantle Settings, under Mantle.',
        },
        foot: 'Every key Mantle answers is listed in Mantle Settings, under Keyboard shortcuts.',
      },
      {
        id: 'back', step: 'Switching back',
        title: 'Want Windows’ taskbar back?',
        lead: 'Windows’ taskbar is only hidden while Mantle runs. Going back takes one click.',
        ways: [
          { name: 'For now', text: 'Open the ••• menu on the bar and choose Restore Windows taskbar. Mantle keeps running: to get its bar back, choose Restart Mantle to resume from Mantle’s tray icon.', action: 'restore' },
          { name: 'Quit', text: 'Quit Mantle is in the same menu (it asks for a second click), or press', keys: ['Ctrl', 'Alt', 'Shift', 'Backspace'], after: 'anywhere.' },
          { name: 'For good', text: 'Mantle starts when you sign in, through a task named Mantle in Task Scheduler. Delete that task (or run', code: 'npm run autostart:remove', after: 'in Mantle’s folder), then quit Mantle.' },
        ],
        // A copy installed by Mantle-Setup.exe (welcome.state says packaged): this replaces 'For good' above.
        installed: { name: 'For good', text: 'Uninstall Mantle in Windows Settings, under Apps > Installed apps. It puts Windows back before it removes anything, and takes away Mantle’s start at sign-in if you chose it.' },
        restore: { label: 'Restore Windows taskbar now', busy: 'Restoring…', done: 'Windows’ taskbar is back. To get Mantle’s bar back, choose Restart Mantle to resume from Mantle’s tray icon.', failed: 'Could not restore: ' },
      },
    ],
    buttons: { next: 'Next', back: 'Back', skip: 'Skip', finish: 'Start using Mantle' },
  };
  if (typeof module === 'object' && module.exports) module.exports = C;
  else root.MantleWelcomeContent = C;
})(typeof window !== 'undefined' ? window : this);

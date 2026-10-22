/* accessibility.js — Settings > Accessibility, done natively (lane access, 2026-09-29).
 *
 * The user: Mantle Settings "should do everything windows can do and more and not ever rely on any old
 * windows feature". So every page of Windows' Accessibility is here, reading and changing the same
 * values Windows' own Settings does, through settings.accessibility.* (lib/features/_settings-sections/
 * accessibility.js -> sidecar/SysAccess*.cs). Nothing links out to ms-settings.
 *
 * Vision: Text size (with a live preview), Visual effects, Mouse pointer and touch, Text cursor,
 * Magnifier, Color filters, Contrast themes, Narrator. Hearing: Audio, Captions. Interaction: Speech,
 * Keyboard (Sticky / Filter / Toggle keys, on-screen keyboard, access keys, Print Screen), Mouse
 * (Mouse keys), Eye control. Starting Magnifier, Narrator, the on-screen keyboard, voice access or
 * live captions is a real action (a dry run in a test run, like every write).
 *
 * What Windows keeps from other programs is READ-ONLY with the exact reason on its row: the pointer
 * style and colour, colour filters on/off, mono audio, caption styles, the text cursor indicator,
 * voice typing and eye control. One settings read feeds every page; each row patches only itself.
 * Kit only (ui/settings/SECTIONS.md): no CSS of its own.
 */
(function () {
  'use strict';
  const C = (kit, name, args) => kit.call('settings.accessibility.' + name, args || {});
  const bad = (r, what) => (r && r.ok === false ? what + ': ' + (r.reason || 'no reason came back') : null);

  const SVG = {
    person: '<circle cx="8" cy="2.8" r="1.4"/><path d="M2.5 5.5l5.5 1.2 5.5-1.2M8 6.7v3.3l-2.6 4.5M8 10l2.6 4.5"/>',
    text: '<path d="M2 13l3.2-9h.6L9 13M3.2 10h4.6M10 13l2-5.5h.4L14.5 13M10.7 11.3h3.1"/>',
    sparkle: '<path d="M8 1.5l1.4 4.1 4.1 1.4-4.1 1.4L8 12.5 6.6 8.4 2.5 7l4.1-1.4z"/><path d="M13 11.5v3M11.5 13h3"/>',
    pointer: '<path d="M4 1.8v11l3-2.8 2 4.3 1.8-.8-2-4.2h4z"/>',
    caret: '<path d="M6 2.5h4M6 13.5h4M8 2.5v11"/>',
    magnifier: '<circle cx="6.8" cy="6.8" r="4.3"/><path d="M10 10l4.5 4.5M5 6.8h3.6M6.8 5v3.6"/>',
    filter: '<circle cx="6" cy="6" r="3.6"/><circle cx="10" cy="6" r="3.6"/><circle cx="8" cy="9.8" r="3.6"/>',
    contrast: '<circle cx="8" cy="8" r="6"/><path d="M8 2a6 6 0 0 1 0 12z" fill="currentColor"/>',
    narrator: '<path d="M2 3h12v7.5H7.5l-3 2.5v-2.5H2z"/><path d="M4.5 5.8h7M4.5 8h4.5"/>',
    captions: '<rect x="1.5" y="3" width="13" height="10" rx="1.5"/><path d="M7 6.8a1.8 1.8 0 1 0 0 2.4M12 6.8a1.8 1.8 0 1 0 0 2.4"/>',
    keyboard: '<rect x="1.5" y="4" width="13" height="8" rx="1.2"/><path d="M4 6.5h1M7 6.5h1M10 6.5h1M4 9.5h8"/>',
    mouse: '<rect x="4" y="1.5" width="8" height="13" rx="4"/><path d="M8 1.5v4.5M4 6h8"/>',
    eye: '<path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/>',
  };

  const onOff = (v) => (v === true || v === 1 ? 'On' : v === false || v === 0 ? 'Off' : 'Not reported');
  const secs = (s) => (s >= 60 ? (s / 60) + ' minute' + (s === 60 ? '' : 's') : s + ' seconds');

  /* ================================================================ one page = rows bound to keys
     Every page reads settings.accessibility.settings once on open and on update(); each row is
     { key, handle, kind } and patches only itself. build(el, kit, B) draws with B's row makers. */
  function pageOf(build) {
    return function (el, kit) {
      const rows = [];
      const set = (key, value) => C(kit, 'set', { key, value }).then((r) => { if (r.ok && !r.dryRun) setTimeout(read, 300); return r; });
      const add = (key, kind, h, o) => { rows.push({ key, kind, h, o: o || {} }); return h; };
      const B = {
        toggle: (key, row, label, help, o) => add(key, 'value', kit.toggle(Object.assign({ row, label, help, onChange: (on) => set(key, on) }, o)), o),
        choice: (key, row, label, help, options, o) => add(key, 'value', kit.choice(Object.assign({ row, label, help, options, style: 'dropdown', value: options[0].value, onChange: (v) => set(key, v) }, o)), o),
        slider: (key, row, label, help, min, max, o) => add(key, 'value', kit.slider(Object.assign({ row, label, help, min, max, value: min, onChange: (v) => set(key, v) }, o)), o),
        number: (key, row, label, help, min, max, o) => add(key, 'value', kit.number(Object.assign({ row, label, help, min, max, value: null, onChange: (n) => set(key, n) }, o)), o),
        // a read-only value: words(value, values) says it; its reason is the sidecar's readOnly
        status: (key, row, label, help, words, o) => add(key, 'status', kit.status(Object.assign({ row, label, help, value: 'Reading…' }, o)), Object.assign({ words }, o)),
        // start one of Windows' own tools (a real action: a dry run in a test run)
        tool: (tool, row, label, help, o) => add(tool, 'tool', kit.button(Object.assign({ row, label, help, text: 'Start', disabled: true,
          onClick: () => C(kit, 'start', { tool }).then((r) => { if (r.ok && !r.dryRun) { setTimeout(read, 1500); return Object.assign({}, r, { note: label + ' is starting' }); } return r; }) }, o)), o),
      };
      const extra = build(el, kit, B) || {};

      function apply(r) {
        const vals = r.values || {}, tools = r.tools || {};
        for (const x of rows) {
          if (x.kind === 'tool') {
            const t = tools[x.key];
            if (!t) { x.h.set({ disabled: true, reason: 'Windows did not report this tool' }); continue; }
            x.h.set({ text: t.running ? 'Running' : 'Start', disabled: !t.present || t.running || !!t.why, reason: t.why || null,
              info: t.running ? (x.o.running || 'Running now') : null });
            continue;
          }
          const v = vals[x.key];
          if (!v) { x.h.set({ disabled: true, reason: 'Windows did not report this setting' }); continue; }
          const unread = v.value === null && v.why ? 'Could not be read: ' + v.why : null;
          if (x.kind === 'status') {
            x.h.set({ value: unread ? '—' : x.o.words(v.value, vals), tone: x.o.tone ? x.o.tone(v.value) : 'info',
              info: v.readOnly ? 'Read only here: ' + v.readOnly : null, reason: unread });
            continue;
          }
          const gate = x.o.gate ? x.o.gate(vals) : null;
          const ro = v.readOnly ? 'Read only here: ' + v.readOnly : null;
          x.h.set(Object.assign({ disabled: !!(ro || unread || gate), reason: ro || unread || gate || null },
            v.value === null ? {} : { value: x.o.to ? x.o.to(v.value) : v.value }, x.o.patch ? x.o.patch(v, vals) : {}));
        }
        if (extra.apply) extra.apply(vals);
      }
      async function read() {
        const r = await C(kit, 'settings');
        if (!r || r.ok === false) {
          const why = bad(r, 'These settings could not be read');
          for (const x of rows) x.h.set(x.kind === 'status' ? { value: '—', reason: why } : { disabled: true, reason: why });
          if (extra.fail) extra.fail(why);
          return;
        }
        apply(r);
      }
      return read().then(() => ({ update: read, dispose() {} }));
    };
  }
  const R = (page, name) => 'accessibility.' + page + '.' + name;

  /* ================================================================ Vision */
  // Text size: the slider previews live under the pointer; the release writes (and broadcasts).
  const textSize = pageOf((el, kit, B) => {
    const base = 14;
    const sample = kit.h('div', { class: 'row-t' }, 'Drag the slider until this text is easy to read');
    const preview = kit.h('div', { class: 'row', 'data-row': R('text-size', 'preview') }, kit.h('div', { class: 'row-l' }, kit.h('div', { class: 'row-h' }, 'Text size preview'), sample));
    const show = (v) => { sample.style.fontSize = (base * v / 100).toFixed(1) + 'px'; sample.style.lineHeight = '1.25'; };
    show(100);
    let last = 100;   // what Windows says now: the preview springs back to it with the slider
    const size = B.slider('textSize', R('text-size', 'size'), 'Text size', 'Makes text bigger across Windows and apps; letting go of the slider applies it',
      100, 225, { unit: '%', onInput: show,
        onChange: (v) => C(kit, 'set', { key: 'textSize', value: v }).then((r) => {
          if (r.ok && !r.dryRun) { last = typeof r.value === 'number' ? r.value : v; }
          show(last);
          return r;
        }) });
    el.append(kit.card(preview, size));
    return { apply: (v) => { if (v.textSize && typeof v.textSize.value === 'number') { last = v.textSize.value; show(last); } } };
  });

  const DURATIONS = [5, 7, 15, 30, 60, 300].map((s) => ({ value: s, label: secs(s) }));
  const visualEffects = pageOf((el, kit, B) => {
    el.append(kit.card(
      B.toggle('scrollbars', R('visual-effects', 'scrollbars'), 'Always show scrollbars', 'Off: scrollbars shrink out of the way until you point at them'),
      B.toggle('transparency', R('visual-effects', 'transparency'), 'Transparency effects', 'Some windows and surfaces are slightly see-through'),
      B.toggle('animations', R('visual-effects', 'animations'), 'Animation effects', 'Windows and apps animate as they open, close and change'),
      B.choice('notifyDuration', R('visual-effects', 'notify-duration'), 'Dismiss notifications after this amount of time', 'How long a notification stays on screen', DURATIONS)));
  });

  const STYLE = { 0: 'White', 1: 'Black', 2: 'Inverted', 6: 'Custom' };
  const hex = (bgr) => '#' + [bgr & 255, (bgr >> 8) & 255, (bgr >> 16) & 255].map((x) => x.toString(16).padStart(2, '0')).join('').toUpperCase();
  const mousePointer = pageOf((el, kit, B) => {
    el.append(kit.group('Mouse pointer'), kit.card(
      B.status('pointerStyle', R('mouse-pointer', 'style'), 'Mouse pointer style', 'White, black, inverted or a colour of your choice', (v) => STYLE[v] || 'Style ' + v),
      B.status('pointerColor', R('mouse-pointer', 'color'), 'Pointer colour', 'Used by the custom style', (v, all) => (all.pointerStyle && all.pointerStyle.value === 6 ? hex(v) : 'Not in use (' + (STYLE[all.pointerStyle && all.pointerStyle.value] || 'another style') + ' style)')),
      B.slider('pointerSize', R('mouse-pointer', 'size'), 'Size', 'How big the mouse pointer is, from 1 (normal) to 15', 1, 15)),
    kit.group('Touch indicator'), kit.card(
      B.choice('touchIndicator', R('mouse-pointer', 'touch-indicator'), 'Touch indicator', 'Show a circle on the screen where you touch it',
        [{ value: 0, label: 'Off' }, { value: 1, label: 'On' }, { value: 2, label: 'On, darker and larger' }])));
  });

  const textCursor = pageOf((el, kit, B) => {
    el.append(kit.group('Text cursor indicator'), kit.card(
      B.status('cursorIndicator', R('text-cursor', 'indicator'), 'Text cursor indicator', 'A coloured marker on the text cursor so you can find it', (v) => onOff(v))),
    kit.group('Text cursor thickness'), kit.card(
      B.slider('caretWidth', R('text-cursor', 'thickness'), 'Text cursor thickness', 'The width of the blinking text cursor, in pixels', 1, 20, { unit: ' px' })));
  });

  const magnifier = pageOf((el, kit, B) => {
    el.append(kit.card(
      B.tool('magnifier', R('magnifier', 'start'), 'Magnifier', 'Zoom in on parts of the screen. Windows logo key + Plus starts it, Windows logo key + Esc closes it', { running: 'Magnifier is running: Windows logo key + Esc closes it' }),
      B.toggle('magSignIn', R('magnifier', 'sign-in'), 'Start Magnifier after sign-in', 'Every time you sign in to Windows')),
    kit.group('Zoom'), kit.card(
      B.number('magZoom', R('magnifier', 'zoom'), 'Zoom level', 'How far Magnifier zooms in when it starts (100% to 1600%)', 100, 1600, { step: 25, unit: '%' }),
      B.choice('magIncrement', R('magnifier', 'increment'), 'Zoom increment', 'How much each zoom in or out step changes it', [25, 50, 100, 150, 200, 400].map((n) => ({ value: n, label: n + '%' })))),
    kit.group('Appearance'), kit.card(
      B.toggle('magSmooth', R('magnifier', 'smooth'), 'Smooth edges of images and text', 'Softens the jagged edges of zoomed pixels'),
      B.toggle('magInvert', R('magnifier', 'invert'), 'Invert colours', 'Magnifier shows the screen with its colours reversed')),
    kit.reason('Magnifier reads its settings when it starts; while it is running, its own toolbar changes them.', { info: true }));
  });

  const FILTERS = [{ value: 0, label: 'Greyscale' }, { value: 1, label: 'Inverted' }, { value: 2, label: 'Greyscale inverted' },
    { value: 3, label: 'Red-green (green weak, deuteranopia)' }, { value: 4, label: 'Red-green (red weak, protanopia)' }, { value: 5, label: 'Blue-yellow (tritanopia)' }];
  const colorFilters = pageOf((el, kit, B) => {
    el.append(kit.card(
      B.status('colorFilters', R('color-filters', 'on'), 'Colour filters', 'Change the colours on the screen to make photos and colours easier to see', (v) => onOff(v)),
      B.choice('colorFilter', R('color-filters', 'filter'), 'Filter', 'The filter Windows uses when colour filters are on', FILTERS),
      B.toggle('colorFilterShortcut', R('color-filters', 'shortcut'), 'Keyboard shortcut for colour filters', 'Windows logo key + Ctrl + C turns them on or off')));
  });

  const contrastThemes = pageOf((el, kit, B) => {
    const theme = B.choice('contrastTheme', R('contrast-themes', 'theme'), 'Contrast themes', 'Colours with more contrast make text and apps easier to see',
      [{ value: 'none', label: 'None' }], {
        patch: (v) => {
          const list = (Array.isArray(v.themes) ? v.themes : []).map((t) => ({ value: t.value, label: t.label + (t.present ? '' : ' (not on this PC)') }));
          if (v.value === 'custom') list.push({ value: 'custom', label: 'Custom (' + (v.scheme || 'another theme') + ')' });
          return list.length ? { options: list } : {};
        },
      });
    el.append(kit.card(theme,
      B.toggle('contrastShortcut', R('contrast-themes', 'shortcut'), 'Keyboard shortcut for contrast themes', 'Left Alt + left Shift + Print Screen turns them on or off')));
  });

  const narrator = pageOf((el, kit, B) => {
    el.append(kit.card(
      B.tool('narrator', R('narrator', 'start'), 'Narrator', 'A screen reader that describes what is on the screen. Windows logo key + Ctrl + Enter starts or stops it', { running: 'Narrator is running: Windows logo key + Ctrl + Enter stops it' }),
      B.toggle('narratorShortcut', R('narrator', 'shortcut'), 'Keyboard shortcut for Narrator', 'Windows logo key + Ctrl + Enter starts and stops Narrator'),
      B.toggle('narratorSignIn', R('narrator', 'sign-in'), 'Start Narrator after sign-in', 'Every time you sign in to Windows')));
  });

  /* ================================================================ Hearing */
  const FLASH = [{ value: 'off', label: 'No flash' }, { value: 'title', label: 'Flash the title bar of the active window' },
    { value: 'window', label: 'Flash the active window' }, { value: 'display', label: 'Flash the entire screen' }];
  const audio = pageOf((el, kit, B) => {
    el.append(kit.card(
      B.status('monoAudio', R('audio', 'mono'), 'Mono audio', 'Combine the left and right channels into one', (v) => onOff(v)),
      B.choice('flashScreen', R('audio', 'flash'), 'Flash my screen during audio notifications', 'For when you cannot hear a notification sound', FLASH)));
  });

  const captions = pageOf((el, kit, B) => {
    el.append(kit.card(
      B.tool('liveCaptions', R('captions', 'live'), 'Live captions', 'Captions for any audio playing on this PC. Windows logo key + Ctrl + L starts it', { running: 'Live captions are running' }),
      B.status('captionStyle', R('captions', 'style'), 'Caption style', 'The font, colours and background of captions', () => 'Kept by Windows')));
  });

  /* ================================================================ Interaction */
  const speech = pageOf((el, kit, B) => {
    el.append(kit.card(
      B.tool('voiceAccess', R('speech', 'voice-access'), 'Voice access', 'Control this PC and type with your voice', { running: 'Voice access is running' }),
      B.status('voiceTyping', R('speech', 'voice-typing'), 'Voice typing', 'Type with your voice in any text box', () => 'Windows logo key + H')));
  });

  const PRINT_INFO = 'Mantle\'s own screenshot overlay answers Print Screen while its Screenshots feature is on (Settings > Mantle); this is what Windows does with the key only when Mantle lets it through';
  const keyboard = pageOf((el, kit, B) => {
    el.append(kit.group('Sticky keys'), kit.card(
      B.toggle('stickyOn', R('keyboard', 'sticky'), 'Sticky keys', 'Press one key at a time for shortcuts like Ctrl + C'),
      B.toggle('stickyShortcut', R('keyboard', 'sticky-shortcut'), 'Keyboard shortcut for Sticky keys', 'Press Shift five times to turn Sticky keys on or off. Off also stops its prompt popping up mid-game'),
      B.toggle('stickyIndicator', R('keyboard', 'sticky-indicator'), 'Show the Sticky keys icon on the taskbar'),
      B.toggle('stickyLock', R('keyboard', 'sticky-lock'), 'Lock shortcut keys when pressed twice in a row'),
      B.toggle('stickyTwoKeysOff', R('keyboard', 'sticky-two-keys'), 'Turn off Sticky keys when two keys are pressed at the same time'),
      B.toggle('stickySound', R('keyboard', 'sticky-sound'), 'Play a sound when shortcut keys are pressed and released')),
    kit.group('Filter keys'), kit.card(
      B.toggle('filterOn', R('keyboard', 'filter'), 'Filter keys', 'Ignore brief or repeated keystrokes'),
      B.toggle('filterShortcut', R('keyboard', 'filter-shortcut'), 'Keyboard shortcut for Filter keys', 'Hold the right Shift key for eight seconds to turn Filter keys on or off'),
      B.toggle('filterIndicator', R('keyboard', 'filter-indicator'), 'Show the Filter keys icon on the taskbar'),
      B.toggle('filterBeep', R('keyboard', 'filter-beep'), 'Beep when keys are pressed or accepted')),
    kit.group('Toggle keys'), kit.card(
      B.toggle('toggleOn', R('keyboard', 'toggle'), 'Toggle keys', 'Play a sound when you press Caps Lock, Num Lock or Scroll Lock'),
      B.toggle('toggleShortcut', R('keyboard', 'toggle-shortcut'), 'Keyboard shortcut for Toggle keys', 'Hold Num Lock for five seconds to turn Toggle keys on or off')),
    kit.group('On-screen keyboard, access keys, and Print screen'), kit.card(
      B.tool('osk', R('keyboard', 'osk'), 'On-screen keyboard', 'Type with a mouse, a pen or touch. Windows logo key + Ctrl + O starts it', { running: 'The on-screen keyboard is open' }),
      B.toggle('oskSignIn', R('keyboard', 'osk-sign-in'), 'Start the on-screen keyboard after sign-in', 'Every time you sign in to Windows'),
      B.toggle('accessKeys', R('keyboard', 'access-keys'), 'Underline access keys', 'Underline the letter that picks a menu item or button with Alt, even when Alt is not pressed'),
      B.toggle('printScreen', R('keyboard', 'print-screen'), 'Use the Print screen key to open Windows\' screen capture', 'Windows\' own Snipping overlay', { info: PRINT_INFO })),
    kit.group('Notification preferences'), kit.card(
      B.toggle('shortcutWarning', R('keyboard', 'shortcut-warning'), 'Show a warning message when turning on Sticky, Filter or Toggle keys from the keyboard'),
      B.toggle('shortcutSound', R('keyboard', 'shortcut-sound'), 'Make a sound when turning Sticky, Filter or Toggle keys on or off from the keyboard')));
  });

  const mouse = pageOf((el, kit, B) => {
    el.append(kit.group('Mouse keys'), kit.card(
      B.toggle('mouseKeysOn', R('mouse', 'keys'), 'Mouse keys', 'Move the mouse pointer with the number keys'),
      B.toggle('mouseKeysShortcut', R('mouse', 'keys-shortcut'), 'Keyboard shortcut for Mouse keys', 'Left Alt + left Shift + Num Lock turns Mouse keys on or off'),
      B.toggle('mouseKeysIndicator', R('mouse', 'keys-indicator'), 'Show the Mouse keys icon on the taskbar'),
      B.toggle('mouseKeysNumLock', R('mouse', 'keys-num-lock'), 'Only use Mouse keys when Num Lock is on'),
      B.toggle('mouseKeysModifiers', R('mouse', 'keys-modifiers'), 'Hold Ctrl to speed up and Shift to slow down'),
      B.slider('mouseKeysSpeed', R('mouse', 'keys-speed'), 'Mouse keys speed', 'The top speed of the pointer', 10, 360, { step: 10 }),
      B.slider('mouseKeysAccel', R('mouse', 'keys-acceleration'), 'Mouse keys acceleration', 'The time the pointer takes to reach top speed', 1000, 5000,
        { step: 100, format: (v) => (v / 1000).toFixed(1) + ' s' })));
  });

  const eyeControl = pageOf((el, kit, B) => {
    el.append(kit.card(B.status('eyeControl', R('eye-control', 'state'), 'Eye control', 'Use an eye tracker to control the mouse, type and speak', () => 'Needs an eye tracker')));
  });

  /* ================================================================ the section */
  const S = (row, label, keywords, uri) => Object.assign({ row, label, keywords }, uri ? { uri } : {});
  const pages = [
    { id: 'text-size', title: 'Text size', icon: SVG.text, help: 'Make text bigger across Windows and apps', render: textSize,
      search: [S(R('text-size', 'size'), 'Text size', 'bigger text font size make text bigger larger scale', 'ms-settings:easeofaccess-display'),
        S(R('text-size', 'preview'), 'Accessibility: text size preview', 'ease of access accessibility', 'ms-settings:easeofaccess')] },
    { id: 'visual-effects', title: 'Visual effects', icon: SVG.sparkle, help: 'Scrollbars, transparency, animations, notification time', render: visualEffects,
      search: [S(R('visual-effects', 'scrollbars'), 'Always show scrollbars', 'scroll bar hide auto hide', 'ms-settings:easeofaccess-visualeffects'),
        S(R('visual-effects', 'transparency'), 'Transparency effects', 'transparent see through glass blur'),
        S(R('visual-effects', 'animations'), 'Animation effects', 'animations motion reduce motion'),
        S(R('visual-effects', 'notify-duration'), 'Dismiss notifications after this amount of time', 'notification toast duration how long seconds')] },
    { id: 'mouse-pointer', title: 'Mouse pointer and touch', icon: SVG.pointer, help: 'Pointer style, size and the touch indicator', render: mousePointer,
      search: [S(R('mouse-pointer', 'size'), 'Mouse pointer size', 'cursor pointer size bigger large', 'ms-settings:easeofaccess-mousepointer'),
        S(R('mouse-pointer', 'style'), 'Mouse pointer style', 'cursor black white inverted colour color'),
        S(R('mouse-pointer', 'color'), 'Mouse pointer colour', 'cursor color colour custom'),
        S(R('mouse-pointer', 'touch-indicator'), 'Touch indicator', 'touch circle feedback finger')] },
    { id: 'text-cursor', title: 'Text cursor', icon: SVG.caret, help: 'Text cursor indicator and thickness', render: textCursor,
      search: [S(R('text-cursor', 'thickness'), 'Text cursor thickness', 'caret cursor thickness width blinking', 'ms-settings:easeofaccess-cursor'),
        S(R('text-cursor', 'indicator'), 'Text cursor indicator', 'caret indicator colour find cursor')] },
    { id: 'magnifier', title: 'Magnifier', icon: SVG.magnifier, help: 'Zoom in on parts of the screen', render: magnifier,
      search: [S(R('magnifier', 'start'), 'Magnifier', 'zoom magnify magnifying glass', 'ms-settings:easeofaccess-magnifier'),
        S(R('magnifier', 'sign-in'), 'Start Magnifier after sign-in', 'magnifier startup sign in'),
        S(R('magnifier', 'zoom'), 'Magnifier zoom level', 'zoom level percent magnifier'),
        S(R('magnifier', 'increment'), 'Magnifier zoom increment', 'zoom step increment magnifier'),
        S(R('magnifier', 'smooth'), 'Magnifier: smooth edges', 'smoothing magnifier edges'),
        S(R('magnifier', 'invert'), 'Magnifier: invert colours', 'invert colors magnifier')] },
    { id: 'color-filters', title: 'Color filters', icon: SVG.filter, help: 'Greyscale, inverted and colour-blindness filters', render: colorFilters,
      search: [S(R('color-filters', 'on'), 'Colour filters', 'color filters colorblind colour blind grayscale greyscale', 'ms-settings:easeofaccess-colorfilter'),
        S(R('color-filters', 'filter'), 'Colour filter', 'deuteranopia protanopia tritanopia inverted greyscale filter'),
        S(R('color-filters', 'shortcut'), 'Keyboard shortcut for colour filters', 'win ctrl c colour filter shortcut')] },
    { id: 'contrast-themes', title: 'Contrast themes', icon: SVG.contrast, help: 'Aquatic, Desert, Dusk, Night sky', render: contrastThemes,
      search: [S(R('contrast-themes', 'theme'), 'Contrast themes', 'high contrast aquatic desert dusk night sky', 'ms-settings:easeofaccess-highcontrast'),
        S(R('contrast-themes', 'shortcut'), 'Keyboard shortcut for contrast themes', 'high contrast shortcut alt shift print screen')] },
    { id: 'narrator', title: 'Narrator', icon: SVG.narrator, help: 'The screen reader', render: narrator,
      search: [S(R('narrator', 'start'), 'Narrator', 'screen reader read aloud blind', 'ms-settings:easeofaccess-narrator'),
        S(R('narrator', 'shortcut'), 'Keyboard shortcut for Narrator', 'narrator win ctrl enter shortcut'),
        S(R('narrator', 'sign-in'), 'Start Narrator after sign-in', 'narrator startup sign in')] },
    { id: 'audio', title: 'Audio', icon: 'sound', help: 'Mono audio, flash the screen for sounds', render: audio,
      search: [S(R('audio', 'mono'), 'Mono audio', 'mono audio one channel left right', 'ms-settings:easeofaccess-audio'),
        S(R('audio', 'flash'), 'Flash my screen during audio notifications', 'flash screen visual notification deaf sound sentry')] },
    { id: 'captions', title: 'Captions', icon: SVG.captions, help: 'Live captions and caption style', render: captions,
      search: [S(R('captions', 'live'), 'Live captions', 'subtitles closed captions live captions', 'ms-settings:easeofaccess-closedcaptioning'),
        S(R('captions', 'style'), 'Caption style', 'caption style font colour subtitles')] },
    { id: 'speech', title: 'Speech', icon: 'mic', help: 'Voice access and voice typing', render: speech,
      search: [S(R('speech', 'voice-access'), 'Voice access', 'voice control speech recognition dictation', 'ms-settings:easeofaccess-speechrecognition'),
        S(R('speech', 'voice-typing'), 'Voice typing', 'dictation win h voice typing')] },
    { id: 'keyboard', title: 'Keyboard', icon: SVG.keyboard, help: 'Sticky, Filter and Toggle keys, on-screen keyboard, Print Screen', render: keyboard,
      search: [S(R('keyboard', 'sticky'), 'Sticky keys', 'sticky keys shift five times', 'ms-settings:easeofaccess-keyboard'),
        S(R('keyboard', 'sticky-shortcut'), 'Keyboard shortcut for Sticky keys', 'shift 5 times sticky keys popup game'),
        S(R('keyboard', 'sticky-indicator'), 'Show the Sticky keys icon on the taskbar', 'sticky keys icon'),
        S(R('keyboard', 'sticky-lock'), 'Lock shortcut keys when pressed twice in a row', 'sticky keys lock'),
        S(R('keyboard', 'sticky-two-keys'), 'Turn off Sticky keys when two keys are pressed at the same time', 'sticky keys two keys'),
        S(R('keyboard', 'sticky-sound'), 'Play a sound when shortcut keys are pressed and released', 'sticky keys sound'),
        S(R('keyboard', 'filter'), 'Filter keys', 'filter keys bounce keys slow keys repeat'),
        S(R('keyboard', 'filter-shortcut'), 'Keyboard shortcut for Filter keys', 'right shift eight seconds filter keys'),
        S(R('keyboard', 'filter-indicator'), 'Show the Filter keys icon on the taskbar', 'filter keys icon'),
        S(R('keyboard', 'filter-beep'), 'Beep when keys are pressed or accepted', 'filter keys beep'),
        S(R('keyboard', 'toggle'), 'Toggle keys', 'toggle keys caps lock num lock sound'),
        S(R('keyboard', 'toggle-shortcut'), 'Keyboard shortcut for Toggle keys', 'num lock five seconds toggle keys'),
        S(R('keyboard', 'osk'), 'On-screen keyboard', 'on screen keyboard osk touch keyboard'),
        S(R('keyboard', 'osk-sign-in'), 'Start the on-screen keyboard after sign-in', 'osk startup sign in'),
        S(R('keyboard', 'access-keys'), 'Underline access keys', 'access keys underline alt menu'),
        S(R('keyboard', 'print-screen'), 'Use the Print screen key to open screen capture', 'print screen prtsc snipping screenshot key'),
        S(R('keyboard', 'shortcut-warning'), 'Show a warning when turning on Sticky, Filter or Toggle keys', 'warning message shortcut keys'),
        S(R('keyboard', 'shortcut-sound'), 'Make a sound when turning Sticky, Filter or Toggle keys on or off', 'sound shortcut keys')] },
    { id: 'mouse', title: 'Mouse', icon: SVG.mouse, help: 'Mouse keys', render: mouse,
      search: [S(R('mouse', 'keys'), 'Mouse keys', 'mouse keys numeric keypad number pad move pointer', 'ms-settings:easeofaccess-mouse'),
        S(R('mouse', 'keys-shortcut'), 'Keyboard shortcut for Mouse keys', 'alt shift num lock mouse keys'),
        S(R('mouse', 'keys-indicator'), 'Show the Mouse keys icon on the taskbar', 'mouse keys icon'),
        S(R('mouse', 'keys-num-lock'), 'Only use Mouse keys when Num Lock is on', 'mouse keys num lock'),
        S(R('mouse', 'keys-modifiers'), 'Hold Ctrl to speed up and Shift to slow down', 'mouse keys ctrl shift speed'),
        S(R('mouse', 'keys-speed'), 'Mouse keys speed', 'mouse keys speed'),
        S(R('mouse', 'keys-acceleration'), 'Mouse keys acceleration', 'mouse keys acceleration')] },
    { id: 'eye-control', title: 'Eye control', icon: SVG.eye, help: 'Control the pointer with an eye tracker', render: eyeControl,
      search: [S(R('eye-control', 'state'), 'Eye control', 'eye tracker eye control gaze', 'ms-settings:easeofaccess-eyecontrol')] },
  ];

  MantleSettings.section({
    id: 'accessibility',
    title: 'Accessibility',
    group: 'windows',
    icon: SVG.person,
    order: 90,
    help: 'Text size, contrast, Magnifier, Narrator, keyboard',
    keywords: 'accessibility ease of access vision hearing interaction a11y',
    pages,
  });
})();

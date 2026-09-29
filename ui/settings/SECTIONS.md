# Mantle Settings: section modules

Mantle Settings (Win+I, `lib/features/settings.js` + `ui/settings/`) is meant to replace Windows Settings
completely. Each Windows category is built as a **section module**: one page file, and optionally one
main-process file. A category lane adds its own files and never edits the Settings page itself.

| half | file | loaded by |
|---|---|---|
| page | `ui/settings/sections/<id>.js` | `ui/settings/kit.js`, from the list main gives (`settings.sections`) |
| main (optional) | `lib/features/_settings-sections/<id>.js` | `lib/features/settings.js` at install |

- `<id>` is the file name: lower-case letters, digits and `-`, starting with a letter (`system`,
  `time-language`). It may not be a built-in section's id (`home display sound bluetooth network power
  notifications apps mantle shortcuts about`); take a built-in over with `replaces` instead.
- Files starting with `_` and `*.test.js` are never loaded (`_example.js` in both folders is the worked
  example below).
- Nothing is hand-listed: add the file(s) and restart Mantle (the page lists them on every open).
- A module that fails to load, has the wrong shape, or throws is that section **DOWN**. It stays in the
  sidebar with a warning dot, its reason is on the dot's tooltip and on its page, and it replaces
  nothing. The rest of Settings works. A render() that throws shows "could not be drawn: <why>" with
  Try again.

## The page half

A page module calls `MantleSettings.section({...})` once, while it loads:

```js
MantleSettings.section({
  id: 'system',                     // = the file name
  title: 'System',
  group: 'windows',                 // 'windows' | 'mantle' (the sidebar group)
  icon: 'display',                  // optional: an icon name (below) or 16x16 SVG markup '<path d="..."/>'
  order: 10,                        // optional: see "Sidebar order"
  help: 'Display, sound, notifications, power',   // optional: the line under the title
  keywords: 'pc computer',          // optional: extra search words for the section itself
  replaces: ['display', 'sound'],   // optional: a built-in id or a list of them (see "Replacing")
  uri: 'ms-settings:system',        // optional: Windows pages this whole category replaces (its root; see "Claims")
  search: [                         // optional: rows of the section itself (STATIC metadata)
    { row: 'system.name', label: 'Device name', keywords: 'rename pc', uri: 'ms-settings:about' },
  ],
  // EITHER one page drawn directly:
  render(el, kit) { /* ... */ return { update() {}, dispose() {} }; },
  // OR subpages (the section opens on an overview listing them, like Windows 11):
  pages: [
    { id: 'sound' },                // a placeholder: the replaced built-in Sound page goes HERE
    { id: 'storage', title: 'Storage', icon: 'apps', help: 'Drives, cleanup and Storage Sense',
      search: [{ row: 'system.storage.sense', label: 'Storage Sense', keywords: 'cleanup free space', uri: 'ms-settings:storagesense' }],
      render(el, kit) { /* ... */ return { dispose() {} }; } },
  ],
});
```

**`search` is static metadata.** Search finds every section, page and row without drawing anything, so
list every row a person might look for, with the words they would type. A search entry's `row` must be
the `row` of the kit control that draws it: that is how a search hit or a deep link scrolls to it and
highlights it. Row ids are global: use `<id>.<page>.<name>` (`system.storage.sense`), or the built-in's
own id when you draw the same setting (`display.brightness`, so old deep links still land). Allowed row
characters: letters, digits, `_ . + -`, up to 80. `uri` claims a Windows Settings page: the launcher
catalog's entry for it joins your row instead of saying "Opens Windows Settings".

### Claims (where a Windows Settings page goes)

A `uri` (one `ms-settings:` page, or on a section / page a list of them) CLAIMS that Windows page for
Mantle: on a search row it lands on that row, on a page (`{ id, title, uri, ... }`) on that page, on
the section itself on its overview (a category root: `uri: 'ms-settings:privacy'`). Then, with no
list to keep by hand:

- **the launcher** (Win+S) lists the page (by Windows' name when `lib/launcher-index.js` SETTINGS has
  it, else by your row's label), says "Mantle Settings" and opens YOUR page. `lib/launcher-index.js`
  `sectionClaims()` reads the claims by running each page file in an empty vm context (only
  `MantleSettings.section` exists there; `render` is never called), so a page file must build its
  definition without touching the DOM while it loads. Windows' page opens only when Mantle Settings is
  off, resting or not running, and the launcher says why;
- **Settings' search** folds the Windows page's name and keywords into your entry;
- **links inside Mantle Settings** to that page (the built-in pages' "More in Windows Settings"
  footers, their "Open" buttons) go to your page instead of out to Windows.

The first file by name to claim a page keeps it. A DOWN section claims nothing (Windows' page is used
again, and says so). Claim every Windows page yours replaces; `kit.openWindows(uri)` still opens the
real one when you mean it (a setting only Windows' own Settings may change).

**render(el, kit)** draws into `el` (an empty `div` the page gives it) using the kit, and returns
`{ update?(), dispose() }` (or a promise of it). `update()` is called when the window is focused again
and when any Mantle switch or option changes (`settings.changed`): re-read your values there.
`dispose()` is called when the page is left, the window closes, or search replaces it; the kit then
stops every `kit.watch` and `kit.every` for you. The page draws the title (and the crumb) above `el`.

### Subpages

- With `pages`, the sidebar shows the category and the section opens on an overview card listing its
  pages (icon, title, `help`). Each page has `{ id, title, icon?, help?, uri?, search?, render }`.
- Without `pages`, `render` draws the section directly.
- Deep links are `settings.open { section, page, row }` (any may be left out). A `row` alone finds its
  own section and page. `{ section }` alone opens the overview.

### Replacing a built-in

`replaces` names built-in sections from `display sound bluetooth network power notifications apps`.
Home, Mantle, Keyboard shortcuts and About are Mantle's and cannot be replaced.

- The built-in leaves the sidebar. Its deep links (`settings.open { section: 'display' }`, rows like
  `display.brightness`, the launcher's Windows Settings mapping) and its search entries now land in
  your section.
- **With `pages`**, each replaced built-in becomes a page of yours, still drawn by the built-in code
  (live values and all) under your crumb: "System › Display". A placeholder `{ id: '<built-in>' }` in
  `pages` puts it where you want it; replaced built-ins you do not list come first, in `replaces` order.
  A page of yours WITH a `render` and the built-in's id replaces its content too (then reuse the
  built-in's row ids you draw).
- **Without `pages`**, your `render` supersedes the built-in whole.
- Two modules replacing the same built-in: the first by file name wins; the second is DOWN, naming the
  first. A DOWN module replaces nothing, so the built-in comes back.

### Sidebar order

Groups first (Home, then `windows`, then `mantle`), then `order` (smaller first), built-ins before
modules on a tie. A module with no `order` takes the smallest order of what it replaces, else 500.
Built-ins sit where Windows 11 has them: display 10, sound 11, notifications 12, power 13, bluetooth 20,
network 30, apps 50; mantle 1000, shortcuts 1010, about 1020. The planned categories:

| category | order | category | order |
|---|---|---|---|
| System | 10 | Accounts | 60 |
| Bluetooth & devices | 20 | Time & language | 70 |
| Network & internet | 30 | Gaming | 80 |
| Personalization | 40 | Accessibility | 90 |
| Apps | 50 | Privacy & security | 100 |
| | | Windows Update | 110 |

Icon names settings.js knows: `home display sound bluetooth network power notifications apps mantle
shortcuts about brightness mute refresh arrow chev warn lock moon mic game shield`. Anything else: pass
16x16 SVG markup (stroke `currentColor`, 1.3 wide, no fill: the kit wraps it like the built-in icons).

## The kit

Every control is the built-in rows' own markup, so every section looks identical in the ONE theme
(`ui/shared/glass-light.css`, `--lg-*` only). Do not add CSS of your own for a control the kit has;
ask the settings lane for a missing one.

**Every control shows its reason inline** (Owen's No Silent Failures rule). A control that cannot act
gets `reason: 'why'` (a warning line under it) and usually `disabled: true`; `info: 'words'` is a
quiet note. A change is shown at once and then the ANSWER has the last word:

| the answer of onChange / onClick / onAction | what the control does |
|---|---|
| `{ ok: false, reason }` or a throw | springs back to the old value, shows the reason under the row |
| `{ ok: true, dryRun: true, reason }` (a test run) | springs back, shows the reason as a quiet note |
| `{ ok: true, value }` | shows `value` (the read-back: what Windows says now) |
| anything else | keeps the new value |

Each control returns a handle `{ el, value, set(patch) }`. `set()` patches ONLY that row (label, help,
reason, info, disabled, admin, value, options, items...), so live values never rebuild the page. A
slider held under the pointer and a field being typed in are not moved by `set({ value })`.

| call | draws |
|---|---|
| `kit.group(title, { row?, aside? })` | a group heading (with an optional right-hand note) |
| `kit.card(...controls)` | a card holding controls / lists / nodes |
| `kit.toggle({ row, label, help?, icon?, value, onChange(bool) })` | On/Off switch |
| `kit.choice({ row, label, options: [{ value, label }], value, style?: 'segmented' \| 'dropdown', onChange(v) })` | segmented chips (default for up to 4 short options) or a dropdown |
| `kit.slider({ row, label, min, max, step?, value, unit?, format?(v), onInput?(v), onChange(v) })` | a slider with its value; `onInput` fires live (once a frame), `onChange` on release |
| `kit.number({ row, label, value, min?, max?, step?, unit?, onChange(n) })` | a number box (Enter or leaving it commits) |
| `kit.text({ row, label, value, placeholder?, password?, onChange(s) })` | a text box |
| `kit.button({ row, label, help?, text, tone?: 'acc' \| 'quiet', onClick() })` | a row with one button |
| `kit.folder({ row, label, value, onChange(path) })` | the path + Choose… (Mantle's folder dialog; refused in words in a test run) |
| `kit.status({ row, label, value, tone?: 'ok' \| 'warn' \| 'info' })` | a read-only value with a dot |
| `kit.list({ row, items: [{ key, label, help?, icon?, mono?, value?, reason?, admin?, actions: [{ id, text, tone?, admin?, disabled?, reason? }] }], empty, onAction(key, actionId, item) })` | a list of rows, each with its own buttons; its rows are `<row>.<key>`; `set({ items })` redraws only the items that changed |
| `kit.reason(text, { info? })` | a reason line on its own |
| `kit.admin()` | the ADMIN badge (shield). Any row takes `admin` for it; a list action too |
| `kit.h(tag, attrs, ...children)` / `kit.icon(name)` | plain DOM, for anything the controls do not cover |

Common options on every row: `row` (its id: search, deep links and highlight find it by this), `label`,
`help`, `mono` (help in monospace), `icon`, `admin`, `reason`, `info`, `disabled`.

**Administrator actions** (sidecar/ELEVATE.md): give the row `admin: '<does>'`, the action's `does` words
(`admin: 'rename this PC'`). The row then carries the shield AND says, before the click, "Windows will ask
for administrator permission to rename this PC." While the call waits it says "Waiting for the
administrator prompt…"; an answer with `cancelled: true` springs back with "You said no to the
administrator prompt; nothing changed."; an ok answer's `note` is shown under the row. `admin: true`
shows the shield only. The main half calls `env.elevate(action, args)`.

Talking to Mantle, all cleaned up on dispose:

| call | does |
|---|---|
| `kit.call(cmd, args)` | calls any Mantle command (`settings.<id>.<name>`, `qs.get`, ...). **Always resolves**: the answer, or `{ ok: false, reason }` |
| `kit.watch(event, fn)` | `mantle.on(event, fn)` until dispose (`qs`, `net`, `battery`, or your own `settings.<id>.<x>`). Returns off() |
| `kit.every(ms, fn)` | runs `fn` every `ms` (at least 250) while the window is visible, until dispose. Returns stop() |
| `kit.open({ section, page, row })` | goes somewhere else in Settings |
| `kit.openWindows(uri)` | opens a real Windows Settings page (`ms-settings:...`): the fallback for what is not native yet |
| `kit.highlight(row)` | scrolls to a row and flashes it (deep links do this for you) |
| `kit.test` / `kit.section` / `kit.page` / `kit.disposed` | a test run? / where you are / whether you were left |

## The main half

```js
module.exports = {
  id: 'system',                                   // = the file name
  commands: {                                     // each is settings.<id>.<name>
    async get(args, env) { return { ok: true, name: '...' }; },
    async rename(args, env) {
      if (env.test) return { ok: true, dryRun: true, reason: 'test run: nothing was changed' };
      return env.elevate('system.renamePc', { name: args.name });
    },
  },
  install(env) { const off = env.onRest(({ on, why }) => { /* a game started / ended */ }); return () => off(); },
};
```

- Commands are registered as **`settings.<id>.<name>`** (names: letters, digits, `_`). The page calls
  them with `kit.call('settings.system.get', args)`. A command gets `(args, env)`; `args` is always an
  object. A throw becomes `{ ok: false, reason: '<id>.<name> failed (<why>)' }`. Arguments of a failed
  call are logged by main as lengths only, but never name a request argument `id` (the sidecar
  protocol's own key, see lib/features/README.md).
- `install(env)` is optional, runs once when Settings installs (again after every game rest: Settings
  has `rest: true`, so it is stopped while a game runs), and returns a stop function (or `{ stop }`).
  It must not block; start async work inside it. If it throws, the section is DOWN.
- **In a test run (`env.test`) every write that would reach Windows must be a dry run**, answering
  `{ ok: true, dryRun: true, reason }`. Tests read, never write.
- **Privacy:** never log names, titles, SSIDs, device names or paths. Put them in results only.

`env`:

| member | what it is |
|---|---|
| `env.id` / `env.test` | the section id / a test run |
| `env.sidecar` | `ctx.sidecar` (`send(cmd, args, { timeoutMs })` never rejects; `on`, `onReady`, `ready`) |
| `env.log(text)` | one mantle.log line, `mantle: settings: section <id>: <text>` |
| `env.settings.get(key, dflt)` / `.set(key, value)` | JSON kept for this section only (inside Settings' own store) |
| `env.onRest(fn)` | `fn({ on, why })` when Mantle starts resting for a game and when it wakes. Returns off() (dropped at stop anyway) |
| `env.elevate(action, args)` | an administrator action through `lib/elevate.js`. Until that file exists it resolves `{ ok: false, reason: 'Mantle cannot ask for administrator rights yet' }`; never rejects |
| `env.push(event, payload)` | an event to the open Settings window; `event` must start with `settings.<id>.` (the page listens with `kit.watch`) |

A main module with no page file is DOWN ("it has main-side commands but no page"). A page with no main
file is fine.

`settings.pickPath { title, defaultPath }` is the folder dialog `kit.folder` uses (refused in words in
a test run).

## Worked example

`ui/settings/sections/_example.js` + `lib/features/_settings-sections/_example.js`: a one-page
"Example" section with one switch whose value lives in the main half, read on open and every 5 s, with
the read-back and the test-run dry run. Copy both to `<id>.js` (and rename `example`) to start.

## Proof

- `node lib/features/settings.test.js` pins the main half (loading from temp folders, `settings.<id>.<name>`,
  DOWN reasons, `env`, stop) and the page half's rules through `ui/settings/model.js` (`checkSection`,
  `sectionModel`: replacing, subpages, order, claims; `resolve`: deep links; `buildIndex`: search
  metadata; `more` / `claimOf`: links into Mantle).
- `node lib/launcher-index.test.js` runs the REAL section files' claims: every claimed page is a
  launcher row saying "Mantle Settings" whose dry run opens your section/page, and every page file
  loads in the claims sandbox.
- `ui/settings/test-sections/` holds made-up FIXTURES for the mock page:
  `index.html?sections=fx-system,fx-broken,fx-lonely,fx-bad,fx-main!` (an id ending in `!` is DOWN on
  the main side) shows a category with pages replacing Display and Sound, every kit control, a module
  that throws while loading, one with the wrong id, and a one-page section.

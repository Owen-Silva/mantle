# Administrator actions: the elevation broker (2026-09-28)

Some settings need an administrator, exactly as they do in Windows' own Settings: rename the PC,
switch an adapter on or off, DNS servers, Remote Desktop, developer mode, pausing Windows Update.
Mantle runs **not** elevated and stays that way. Each of those actions goes through **one UAC
prompt that Owen approves, one action per prompt**, like the shield buttons in Windows.

`sidecar/Elevate.cs` is the only way to get there. **Never** call `runas`, `Start-Process -Verb
RunAs`, a scheduled task, a service or anything else that gets administrator rights. If an
action needs an administrator, it is an `[Elevated]` method.

## Adding an action (category lanes)

In **your own** sidecar file, write two static methods: the action and its validator. Then put
`[Elevated]` on the action.

```csharp
static class NetDns {
  [Elevated("network.setDns", "CheckSetDns", "change this adapter's DNS servers")]
  static string SetDns(Dictionary<string, object> args, ref object result) {
    // runs ELEVATED, in a second copy of the sidecar. Program.Run's contract:
    // return null with `result` filled, or plain words saying what went wrong.
    result = Json.Obj("adapter", ..., "servers", ...);
    return null;
  }

  static string CheckSetDns(Dictionary<string, object> args) {
    string why = Elevate.OnlyKeys(args, "adapter", "servers");   // unknown keys are refused
    if (why != null) return why;
    // type-check and range-check EVERY value; return plain words, or null when fine
    return null;
  }
}
```

The class does **not** need `[MantleFeature]`. `Elevate.cs` finds every `[Elevated]` method in the
exe by reflection. Nothing else needs editing: not Program.cs, and not Lanes.

The attribute: `[Elevated(name, validator, does)]`

| part | rule |
|---|---|
| `name` | `area.action`, lower camel case (`system.renamePc`, `network.setDns`). Unique: a name registered twice is refused, and **neither** copy runs. `test.*` is reserved for test-only actions. |
| `validator` | The name of a `static string X(Dictionary<string, object> args)` **in the same class**. It is required. An action without a validator is left out and listed under `problems`. |
| `does` | Finishes the sentence "Windows will ask for administrator permission to ...". Lower case, up to 80 characters, e.g. `rename this PC`. The broker's own words use it too: "you said no to the administrator prompt, so Mantle did not rename this PC". |

Rules for the two methods:

- **The validator is the whole trust boundary.** It runs twice: in the non-elevated sidecar
  before any prompt is shown, and again in the elevated copy before the action runs.
  - Check the type of every value (`v is string`, `v is double`), its length and its range.
  - Refuse unknown keys with `Elevate.OnlyKeys`.
  - Anything that ends up in a path, a registry key, a device name or an API string gets a
    whitelist check (a regex or a known list), never just "not empty".
- **The action never runs a shell, a command line, a script, or a path or program named in the
  args.** Call the Win32, WMI or registry API directly. If Windows only offers a command-line
  tool, run it by its fixed absolute path under System32, with an argument list your own code
  builds from validated values. Say so in a comment.
- The action may only read the `args` the validator accepted. It runs in a separate elevated
  process, so it sees none of the sidecar's state.
- Return plain words on failure (`"Windows did not rename this PC (Access is denied, error 5)"`).
  If the change only takes effect later, say so in `result` (`restartNeeded`, `note`).
- One action is one change. Do not bundle "and also" work into it: every elevated action should
  be something Owen would recognise from the prompt's context.

`elevate.list` answers `{actions:[{action, does}], problems, test}`. `problems` names every
`[Elevated]` method that was left out, with the reason. Check that your action appears there.

## Calling it (main process / pages)

```js
const { elevate } = require('../elevate');     // lib/elevate.js
const r = await elevate(ctx.sidecar, 'system.renamePc', { name: 'OWEN-PC' },
                        { why: 'Settings > System > Rename', owner: win });
// { ok: true, result: {...} }  or  { ok: false, reason: 'plain words', kind }
```

- `sidecar`: `ctx.sidecar` (a feature's) or the raw `Sidecar` from lib/sidecar.js.
- `why`: who asked. It is logged next to the action name. The args are **never** logged.
- `owner`: optional. The BrowserWindow (or its HWND as a decimal string) that the UAC prompt
  belongs to.
- `kind`: one of these values.
  - `ok`
  - `cancelled`: Owen said no. This is not an error, so show it quietly.
  - `timeout`
  - `refused`: a validator or a safety check said no.
  - `failed`: the action ran and Windows said no.
  - `busy`: another prompt is already open.
  - `error`: the sidecar could not be asked.
- It never throws. It resolves when the step is over, or when it timed out (up to ~95 s).
- **One prompt at a time.** A second call while a prompt is open gets `kind: 'busy'` with plain
  words.

Mantle Settings hands its section modules `env.elevate(action, args, opts)`. That is
`lib/elevate.js` with the sidecar already bound.

## What the page must show (UI convention)

1. **Put the shield on the control.** Any control that leads to an elevated action carries the
   shield badge, as in Windows.
2. **Say it next to the badge, before the click.** Right beside the shield, the page says:
   **"Windows will ask for administrator permission to <does>."** For example: "Windows will ask
   for administrator permission to rename this PC." Use the action's `does` words, from
   `elevate.list` or the same string.
3. **Show that it is waiting.** While the call is waiting, the control is busy and the page
   says "Waiting for the administrator prompt...". The prompt can take as long as Owen needs.
4. **Show the outcome in the page, never only in the log.**
   - `ok`: show the result, and its `note` if it has one (e.g. "The new name takes effect after
     a restart").
   - `cancelled`: a neutral line, "You said no to the administrator prompt; nothing changed."
     Not red.
   - Anything else: the `reason` as given. It is already plain words.
5. **Batch nothing.** Do not queue several elevated actions behind one click. One click, one
   prompt, one change.

## How it works

```
page -> main: elevate(sidecar, action, args)
  sidecar  elevate.run {action, args, owner}
           1. whitelist + validator                      -> refused early, no prompt
           2. %LOCALAPPDATA%\Mantle\elevate\<nonce>.req.json
              (folder and file ACL'd to this user only, CreateNew)
           3. ShellExecuteEx verb "runas": Mantle.Sidecar.exe --elevated "<that path>"
              -> the UAC prompt
           4. answers AT ONCE {ticket}; a thread waits for the step to exit
  elevated copy (Program.Main -> Elevate.RunElevated)
           5. refuses a path outside the folder or not named <32 hex>.req.json (exit 2)
           6. refuses a folder or request that is a link, owned by or writable by anyone but
              you / SYSTEM / Administrators, missing, older than 60 s, dated in the future,
              over 64 KB, or whose nonce was already spent
           7. opens it share-READ + delete-on-close: nobody can swap it mid-check, and it is
              used up whatever the verdict
           8. whitelist + validator AGAIN, then ONE [Elevated] method
           9. <nonce>.res.json (atomic rename), exit
  sidecar  10. reads the answer (nonce must match), deletes it, pushes
               {"ev":"elevate", ticket, action, ok, kind, result | reason}
               (elevate.status {ticket} answers for a caller that missed the event)
```

**Why a ticket and not a reply that waits.** The prompt waits for Owen. A sidecar lane blocked
for a minute would starve every other command on it (Lanes.cs). So `elevate.run` returns at once,
and `lib/elevate.js` waits for the event.

**Timing.** The request goes stale after **60 s**, and the broker's timeout is **90 s**.

- If Owen says yes within 60 s, the action runs. It then has at least 30 s to finish.
- If Owen says yes later than 60 s, the step refuses the request as stale.
- If the broker times out while the request is still on disk, it deletes the request. The
  reason then says nothing changed, and a later "yes" finds nothing to run.
- If the step had already taken the request, the reason says it may still have happened.
- The waiter stays for a late answer, and logs what really happened.

**Words.**

| what happened | words |
|---|---|
| ERROR_CANCELLED (1223) | "you said no to the administrator prompt, so Mantle did not <does>" |
| the timeout | "the administrator step did not answer in 90 s, so nothing was changed" |
| a refusal or failure | the validator's words, or the check's own words, as given |

## Security rules (do not weaken)

- **The whitelist lives in the exe.** The elevated copy runs only methods it registered itself,
  after its own validator accepts the args. It never trusts the non-elevated side's checks.
- **Nothing executable comes from a request.** Nothing in a request is run as a shell or a
  command line, used as a path, or treated as code. Elevate.cs itself calls no `Process.Start`,
  no `cmd`, no PowerShell (`test-elevate.js` checks the source). The only launch is
  `ShellExecuteEx` of this same exe, with `--elevated` and the request path it just wrote.
- **The elevated copy starts in System32** (`lpDirectory`), not wherever Mantle was started.
- **The request is private, fresh and single-use.**
  - Its ACL is this user only, with no inherited entries.
  - The nonce comes from a CSPRNG and must match the file name.
  - A spent nonce is kept in `used-nonces.txt` for 10 minutes, which is longer than any
    request stays fresh.
- **Logs carry action names, kinds and tickets. Never args or reasons**, since a reason can
  quote an arg (a PC name, a DNS server).
- **The test seam can never raise UAC.** `MANTLE_ELEVATE_TEST=1` is honoured only in a process
  that is not elevated.
  - In a `--passive` sidecar it launches the step with verb `open` instead of `runas`. The exe's
    manifest is `asInvoker`, so there is no prompt.
  - Without the variable, a passive sidecar refuses `elevate.run` with the passive words.
  - In test mode the elevated step validates real actions and then refuses to run them.
  - `test.*` actions exist only in test mode.
  - `MANTLE_ELEVATE_DIR` moves the request folder, in test mode only.
  - A real `runas` launch does not inherit the caller's environment, and an elevated process
    ignores the variable anyway.

**What this does NOT protect against, said plainly:**

- **Malware running as Owen, not elevated.** It can already raise any UAC prompt it likes. It
  could also rewrite a request between the prompt and the read, or replace
  `Mantle.Sidecar.exe` itself. The exe lives in a user-writable folder, and the prompt shows it
  as an unsigned "Mantle.Sidecar.exe".
  - The broker caps the damage from a forged request: it is only ever a whitelisted action with
    args its validator accepts.
  - The exe is only as trustworthy as its folder. Installing a copy under Program Files would
    close that gap. That is not done.
- **Elevating as a different account** (a standard user typing an admin's password) is refused.
  The request is ACL'd to the asking user, and the step says it could not open it.

## Actions that exist

| name | does | file |
|---|---|---|
| `system.renamePc` `{name}` | rename this PC. Windows' rules: letters, numbers and hyphens, 1 to 15 characters, not only numbers, no hyphen first or last. `SetComputerNameEx(ComputerNamePhysicalDnsHostname)`. Result `{name, before, restartNeeded: true, note}`. | Elevate.cs (`ElevatePcName`), the worked example. The system lane calls it; it does not re-implement it. |
| `test.echo` `{text, sleepMs?}` | returns its args. Test mode only. | Elevate.cs |

## Tests

```
MANTLE_SIDECAR_EXE=<your built exe> node sidecar/test-elevate.js
node lib/elevate.test.js
```

`test-elevate.js` never shows a UAC prompt. It runs the broker through the `open` seam, and
spawns `--elevated` directly (a plain CreateProcess never elevates).

Not provable without Owen: a real UAC round trip. That covers the prompt appearing in front,
"yes" running the action elevated, and "no" giving ERROR_CANCELLED from the real API.

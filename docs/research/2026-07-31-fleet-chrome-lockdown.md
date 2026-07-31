# Fleet Chrome lockdown: what is configured and how to change it

2026-07-31. Operational state of mac1/mac2/mac3, written for whoever touches them next.

## Why any of this exists

A live-view sign-in put Chrome's autofill dropdown on screen for the watching teammate, listing
colleagues' email addresses. Behind it: **three people's personal Google accounts** signed into
one shared Chrome profile on all three Macs — two of them `@gmail.com` — with sync on and **801
saved credentials each**. The identical count is sync working as designed: one vault, replicated.

The app was incidental. The cause is a personal identity on shared infrastructure, and it leaks
through whatever that identity syncs to.

## Current state (verified)

| | mac1 | mac2 | mac3 |
|---|---|---|---|
| macOS | 15.5 | 26.4.1 | 26.4.1 |
| Chrome profiles | wiped | wiped | wiped |
| `SyncDisabled` | mandatory ✓ | mandatory ✓ | mandatory ✓ |
| `BrowserSignin: 0` | mandatory ✓ | mandatory ✓ | mandatory ✓ |
| `AutofillAddressEnabled: false` | mandatory ✓ | mandatory ✓ | mandatory ✓ |
| `AutofillCreditCardEnabled: false` | mandatory ✓ | mandatory ✓ | mandatory ✓ |
| `PasswordManagerEnabled: false` | mandatory ✓ | mandatory ✓ | mandatory ✓ |
| `AutoLaunchProtocolsFromOrigins` | mandatory ✓ | mandatory ✓ | mandatory ✓ |

Check it any time, no password needed:

```
./scripts/lock-chrome-policy.sh --check
```

## How the policy is delivered

`fleet/chrome-policy.mobileconfig`, installed by hand once per Mac via **System Settings →
General → Device Management**. There is no unattended path, and this is not an oversight:

- All six keys are **mandatory-only** — Chromium's templates declare no `can_be_recommended`, so
  a recommended-level write is rejected outright. Mandatory means `/Library/Managed Preferences`.
- On **macOS 26** a root-written plist there is ignored. The identical file — same md5, same
  `root:wheel 644` — reads back perfectly from disk while `CFPreferencesAppValueIsForced` returns
  false, because the directory belongs to the MDM subsystem and a loose file manages nothing.
  macOS 15 honours the same file, which is why one Mac worked and two did not.
- `profiles install` was removed on 26: *"profiles tool no longer supports installs. Use System
  Settings Profiles."*
- **No MDM enrolment is required** — a plain configuration profile installed by a local admin
  reaches Mandatory. Verified on all three (`forced=true`).

To change a policy: edit the `.mobileconfig`, bump `PayloadVersion`, rsync it to `/tmp` on each
Mac, and reinstall through System Settings. It replaces rather than duplicates.

## What each key buys, precisely

- **`BrowserSignin: 0`** is the strong one: Chrome cannot be signed into a profile at all, so
  there is no vault to download. **Website OAuth is unaffected** — verified with the policy live,
  the Google sign-in page loads normally. Only *browser-level* sign-in is blocked.
- **`SyncDisabled`** stops sync even if sign-in were somehow reached.
- **`AutofillAddressEnabled: false`** is what closes the dropdown that was actually observed.
  Single-field form history is keyed on the FIELD NAME, not the site — a box called `email` on
  any page offers every address ever typed into any box called `email`, which is the only store
  that can list several different people at once.
- **`PasswordManagerEnabled: false`** does **not** hide already-saved passwords. Chromium reads it
  only in `IsSavingAndFillingEnabled()`, never in `IsFillingEnabled()`, and **no Chrome policy
  disables filling**. It stops new saves; the store had to be cleared separately.
- **`AutoLaunchProtocolsFromOrigins`** lets the sign-in handoff launch `yarn://` without Chrome's
  "Open Yarn.app?" confirmation — browser chrome that a page-scoped CDP live view cannot show, so
  without it a remote sign-in stalls on a button the teammate cannot see.

## Clearing profiles: `./run browser-wipe [<mac>|all] [--go]`

Gated; without `--go` it previews and exits 2. Safe because it **quits Chrome first and refuses
if the browser will not exit**:

- Deleting through a running, signed-in Chrome emits `PasswordStoreChange::REMOVE`, a sync
  **tombstone** that removes the credential from that person's Google vault and every device they
  own. Irreversible. With Chrome closed nothing is connected to Google to report anything, so the
  deletion is purely local — the accounts keep their vaults.
- It removes **whole profile directories**, not selected files. Deleting `Login Data` alone leaves
  `sync_model_metadata`, so the next launch re-runs initial sync and re-downloads everything: a
  deletion that appears to work and silently reverses itself.

## Verification traps (all hit for real)

Three tools lied in three directions on the same afternoon. **Verify with the API the consumer
uses** — for Chrome policy that is `CFPreferencesCopyAppValue` + `CFPreferencesAppValueIsForced`,
which is what `policy_loader_mac.mm` calls, and what `lock-chrome-policy.sh --check` uses.

| Tool | Said | Truth |
|---|---|---|
| `defaults read com.google.Chrome SyncDisabled` | "does not exist" | policy in force (reads the user domain only) |
| `profiles list` | "no configuration profiles" | System-scope profile installed (needs root to list) |
| `pgrep -x "Google Chrome"` | not running | running in the console session (`ps -axo` found it) |

Also: `sudo defaults write "/Library/Managed Preferences/…"` **silently writes nothing** —
`cfprefsd` owns that path and declines to create files there, exiting 0.

## Open items

- **The `yarn://` origin is inferred, not confirmed against a live handoff.** It comes from
  Yarn.app's bundle: all three auth endpoints (`/auth/google`, `/auth/google-web`, `/auth/sso`)
  are on `https://y-prod-api.onrender.com`, which appears 19 times in `app.asar`; the scheme comes
  from `CFBundleURLTypes`. Strong evidence, not proof. **If a real sign-in still stops on "Open
  Yarn.app?", the dialog names the actual origin** — widen the entry and reinstall. A wrong value
  grades the host clean while every handoff stalls.
- **Safari is not covered.** It is installed on all three and has its own credential store
  (iCloud Keychain, domain `com.apple.Safari`). No Apple ID is currently signed in, so the gap is
  empty today. There is no Safari equivalent of `BrowserSignin: 0` without full MDM supervision.
- **Other Electron apps are not covered and mostly do not need to be** — they bundle their own
  Chromium with its own preference domain, but none has Chrome's password manager or Google
  profile sync, so there is no equivalent vault to leak.
- **Leftover hand-written plists** remain at `/Library/Managed Preferences/com.google.Chrome.plist`
  on all three. macOS superseded them when the profile installed (the file was replaced with a
  smaller managed one), so they are inert — but deleting them would remove a second mechanism
  that appears to do the same job.
- **A dedicated fleet Google account** remains the structural fix: an account with an empty vault
  has nothing to leak and needs no policy at all. Explicitly declined for now.

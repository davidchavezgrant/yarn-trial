# Session roaming — what we tried, why it's a dead end (2026-07-31)

> **CORRECTION NOTE (2026-07-31, later the same day).** A seven-agent deep-research pass plus
> first-person measurement re-examined this post-mortem. **The conclusion below stands —
> per-box sign-in is still the right answer — but several stated causes are wrong**, and two
> options were never considered (CDP-level cookie transfer; cloning the machine via a TCC-
> pre-granted VM golden image, which is standard practice at GitHub's and Cirrus's macOS CI
> fleets). Specifically: Yarn has **no** `Local State` and **no** Safe Storage Keychain item,
> so the OSCrypt portability problem is inapplicable here; its cookies are plaintext; the
> `so.yarn.MacRecorder` container is 216 KB of TipKit state and cannot have caused the crash;
> the "device/instance marker" dotfiles are leaked Chromium `mkstemp` temporaries; the
> quit-before-snapshot fix demonstrably never produced a quiesced profile (a 2.9 MB `DIPS-wal`
> persists with the app closed); and the crash was never diagnosed because nobody read a crash
> report — Yarn's own Sentry project has them. Read
> `docs/research/2026-07-31-session-roaming-deep-research.md` before acting on anything here.

A post-mortem so this isn't rediscovered. The question was: **can we route a demo run to any
free fleet Mac and have the target app already signed in, without signing that app in on every
box?** We built a credential vault to do it, chased it hard, and concluded it's the wrong tool for
this deployment. Per-box sign-in is the answer. This records the reasoning.

## The goal

The fleet is three colo Macs. A run can land on any of them. If the target app (Yarn's own
Electron app, Notion Calendar, a website) needs a login, the naive options are:
- **Route the same operator to the same box** (sticky routing) — wastes idle boxes.
- **Sign in on every box** (per-box sign-in) — N sign-ins, but simple and robust.

The vault was meant to beat both: sign in once, and have the session *roam* to whatever box runs.

## What we built (the vault)

`src/remote/control/credstore.ts` (AES-GCM sealed bundle store + ledger + audit),
`creds.ts` (checkout/checkin orchestration, local + remote capture), `runner/credbundle.ts` +
`tarball.ts` (snapshot a profile → tar → seal → distribute), runner `credexport`/`credimport`
verbs, dispatch auto-hooks (`YARN_VAULT`), `--use-mock-keychain` on the fleet Chrome, and a
keychain-equalization CLI. The core mechanism: **snapshot the app's on-disk profile directory,
encrypt it, ship it to another box, unpack it.**

It typechecked, unit-tested (1393 passing), deployed to the fleet, and the happy-path checkin
sealed a session on the first live try. Then it fell apart under real conditions.

## The saga (how it failed)

1. **Manual sign-out didn't heal.** After a manual in-app sign-out, the next run failed readiness
   instead of the vault restoring the session — the `skipped-owned` guard (don't clobber a box the
   operator "owns") declined to restore, because an in-app sign-out doesn't change `owners.json`.
   Fixable, but a symptom of a deeper problem.

2. **Restoring a bundle crash-looped the app.** Forcing a restore, Yarn on the box crash-looped —
   stacked `chrome_crashpad_handler` processes, no window. Root cause #1: `exportProfile` copied the
   live Chromium/Electron profile **while the app held it open**, so the cookie/IndexedDB
   LevelDB+SQLite files were captured mid-write — a torn database the app refuses to load. This is
   the exact rule `swapProfile` already followed and `exportProfile` broke.

3. **The quit-before-snapshot fix wasn't enough.** We fixed #2 (quit the app cleanly, so it flushes,
   before snapshotting; deployed; unit-tested with an ordering assertion). A **clean** snapshot of
   the laptop's Yarn *still* crash-looped on the box. Same version (0.0.119 both ends), so not a
   version mismatch. Root cause #2 is deeper.

4. **Root cause #2: Chromium/Electron profiles don't relocate across machines.** Investigating the
   laptop's profile:
   - The **session is a plaintext JWT in `config.json`** (`{"authToken":"eyJ…"}`, decodes to the
     account). ~300 bytes, a bearer token, **zero machine binding — trivially portable.**
   - Yarn is a **multi-container app**: `Application Support/Yarn` (bundle id `com.atacnic.hypersphere`)
     **plus a separate `so.yarn.MacRecorder` container** (the RecordKit screen-recording helper —
     the `recordkit-rpc` processes). The vault captures the first, not the second.
   - The 51 MB we were shipping was mostly **machine-bound junk**: GPU/Dawn shader caches
     (`GPUCache`, `DawnGraphiteCache`), RecordKit state, device/instance marker dotfiles. Copy that
     to a different machine and it crash-loops the app.
   - The `/Users/davidgrant` paths embedded in the profile were a red herring — all LevelDB `LOG`
     files, which relocate fine.

   **So the session was never the problem. The session is one small portable file. The vault was
   dragging the crash along with it by copying the whole profile.**

## Why it's a dead end (not just "fix Yarn")

The failure generalizes:

- **Copy-the-profile is the wrong primitive for a Chromium app.** It transplants machine-specific
  GPU caches, device state, and helper containers that abort the app. Nobody roams Chrome by copying
  `~/Library/Application Support`.
- **Extract-the-session works but doesn't generalize.** Sessions live in arbitrarily different
  places per app: a plaintext file (Yarn), HttpOnly cookies, IndexedDB, localStorage, the login
  keychain, a device-bound key. There is **no universal "where is the session"**. To generalize
  you'd need either a **per-app declaration** (ongoing engineering — a new extractor per target) or
  a **token crawler** that scavenges app data for secrets (fragile: misses opaque/encrypted/non-JWT
  sessions, false positives, and a permanent security liability). Neither is a clean general system.
- **Local and remote capture fail *together*, not independently.** They're the same operation
  (snapshot a session's on-disk state and move it), so every case where local capture can't produce
  a portable session — device-bound keys, keychain tokens, hardware attestation — is a case where
  remote capture produces an equally dead bundle. Remote capture is **not a hedge** against local
  capture's weaknesses.

## The conclusion

**Per-box sign-in is the general answer**, and the only one that needs zero per-app knowledge. A
human authenticating on a box works for file tokens, keychain tokens, device-bound sessions,
anything — because it produces the session in the app's own format, natively. Session roaming trades
that universality away for "fewer sign-ins," and only pays off when accounts × boxes is large enough
that per-app extractor work is cheaper than the sign-ins it saves. At 3 boxes and a demo account,
it isn't close.

The thing to keep from the whole exercise: **remote sign-in** (`signin.ts` / `liveview.*`) — a human
authenticates per box. It's not a capture mechanism; it's the ability to authenticate on the machine
that's the only one that can, and it's irreplaceable.

## If roaming is ever needed (productization) — the right way

Not copy-the-profile. **Intercept the token at authentication time and inject the minimal state.**
When the human signs in through a CDP-instrumented surface (which `liveview` already is for web, and
which Electron apps expose via the debug port), watch the network for the auth response and capture
the token in its canonical form — independent of where the app later stores it, and with none of the
machine-bound profile junk.

- **Web targets: essentially general.** Cookies *are* the web session; capture them with CDP
  (`Network.getAllCookies`) and inject with `Network.setCookie` on the target. No per-app knowledge.
- **Electron file-token apps (Yarn): cleaner but still per-app.** Capture the JWT from the login
  response (canonical, no crash), then inject to the known location (`config.json`). You still need
  the per-app fact "the token goes in `config.json`", but you never copy the profile and never hit
  the crash.

This moves the per-app knowledge from "where is it *stored*" (varied, and copying it drags junk) to
"where is it *issued* + where to *inject* it" (issued uniformly in an auth response; injected to a
small known place). It's the same per-app ceiling, but a strictly better mechanism — and for web it
collapses to general. Build it per-target if and when roaming is actually required; there is no
general system to build.

## Security note (about Yarn's own app)

Yarn stores its auth as an **unencrypted JWT in a plaintext file** — no keychain, no device binding.
Anyone who can read that file is authenticated as that user. That's why the session roams so easily,
and it's worth flagging to the Yarn team independent of any of this.

## What was kept / removed

- **Kept:** per-box `signin` / `liveview` (untouched); `swapProfile`'s quit-before-move (original).
- **Removed / reverted:** the vault (`credstore`, `creds`, `credbundle`, `tarball`, keychain
  equalization), the runner `credexport`/`credimport` verbs, the dispatch auto-hooks, and
  `--use-mock-keychain` if it isn't wanted for web persistence. See the removal commit.
- **Fleet note:** repeated crash-loop testing left the boxes in a messy state; a `session-wipe`
  reset + one real per-box sign-in returns them to a clean, working baseline.

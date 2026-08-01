# Session roaming, re-examined: what we got wrong and what the industry actually does

Deep research pass, 2026-07-31. Seven parallel research agents plus first-person measurement
on David's laptop and the repo. Commissioned by David after `session-roaming.md` concluded
that roaming a session between fleet Macs is a dead end.

**This document does not overturn that conclusion. It replaces its reasoning, which was
wrong in ways that matter, and it surfaces two options we never considered — one of which is
standard practice at the two largest macOS CI fleets in existence.**

> Read alongside, not instead of: `session-roaming.md` (the post-mortem this corrects),
> `docs/research/2026-07-30-cloud-vm-authentication-brief.md` (the customer-session/cloud-VM
> analysis, which remains sound and is a *different problem* — see §1).

---

## 0. The three questions, answered

**"Has anyone solved this?"** Yes, three separate industries have, and none of them do what we
did. Anti-detect browsers (Multilogin, GoLogin, AdsPower, Kameleo) sell portable team-shared
browser profiles as their entire product. Playwright ships `storageState()` as the documented
answer to "authenticate once, reuse across parallel workers." And Google productized cookie
roaming on ChromeOS as `FloatingSsoEnabled` — *"restore the user's web service authentication
state from the previous device onto the new device… by moving user's cookies across devices."*

**"Are we missing something obvious?"** Two things. The smaller one: **export the session as
data, not as a directory** — a few-KB normalized blob, which is what all three industries
above converge on. The bigger one: **clone the machine instead of the session**. GitHub's
`actions/runner-images` writes Accessibility and Screen Recording grants directly into the TCC
databases and ships them inside cloned VM templates. Our architecture treats each Mac as an
irreplaceable hand-provisioned asset because we believed TCC grants were machine-bound. They
are not.

**"Does the OS choice change our assumptions?"** Dramatically, and asymmetrically. On Linux
the cookie-encryption obstacle doesn't merely weaken — it disappears, because Chromium ships
the key as a compile-time constant. The whole TCC/LaunchAgent architecture also disappears.
But the app that motivated the entire exercise cannot run there. See §6.

---

## 1. The category error at the root of it

Two different problems got merged under one name, and the pessimism from the harder one
contaminated the easier one.

| | **Customer sessions → cloud VMs** | **Our demo account → our 3 colo Macs** |
|---|---|---|
| Analysed in | `2026-07-30-cloud-vm-authentication-brief.md` | `session-roaming.md` |
| Whose credentials | the customer's | ours |
| Consent | a real problem | not a problem |
| Fraud/anti-replay detection | the central obstacle | mostly latent |
| Passkeys, DBSC, device trust | the structural wall | inapplicable to a demo account |
| Trust boundary | crosses one | entirely inside one |

The cloud brief is correct and its verdict stands **for its problem**. But `session-roaming.md`
inherited its "the industry is hardening against this" framing for a case where we own both
ends. Moving our own demo account between three machines we administer is not
pass-the-cookie; it is closer to cloning a CI runner.

---

## 2. What actually killed the vault (all measured, none of it Chromium portability)

### 2a. We shipped 81 MB where the session was 176 bytes

Measured on David's laptop, `~/Library/Application Support/Yarn`:

| Component | Size |
|---|---|
| `Cache` + `Code Cache` + `GPUCache` + `DawnWebGPUCache` + `DawnGraphiteCache` | **~73 MB** |
| Everything session-bearing (`Cookies`, `Local Storage`, `IndexedDB`, `Session Storage`, `Service Worker`) | under 300 KB |
| `config.json` — the actual auth token | **176 bytes** |

About 90% of what we transported was cache, which is precisely the machine-bound category.

### 2b. The mechanical bug is in our own source, and it is a reuse error

`src/remote/runner/profiles.ts::livePaths()` documents its heuristic:

> *"The list errs towards including a location. Moving a cache that did not need moving costs
> a cold start; missing one that held a session cookie costs the isolation this module exists
> for."*

That trade is **right** for what `profiles.ts` was built to do — swap operators on one Mac —
and **exactly inverted** for cross-machine transfer, where moving a GPU cache costs a crash
rather than a cold start. `credbundle.ts::exportProfile` called `capturePaths()` verbatim,
inheriting a same-machine trade-off for a cross-machine job, **with no exclusion list at all**.

The industry spends real code on exactly this. GoLogin's OSS SDK has a dedicated
`profile-directories-to-remove.js` deleting `Cache`, `Code Cache`, `GPUCache`, `DawnCache`,
`Service Worker`, `IndexedDB`, `Extensions`, and on unpack removes `SingletonLock`,
`SingletonSocket`, `SingletonCookie`, `RunningChromeVersion`. Its archiver zips **only
`Default/` plus `First Run`**, so `Local State` structurally never travels.

### 2c. Every Chromium-level crash mechanism is ruled out by measurement

- **No `Local State` file exists** in Yarn's profile. Electron creates it lazily; none was
  ever written.
- **No `Yarn Safe Storage` Keychain item exists.** Electron names it `<app_name> Safe Storage`
  (`electron_browser_main_parts.cc:560`), so its absence *proves the app has never invoked
  OSCrypt or safeStorage.* The entire keychain-portability problem is inapplicable here.
- **Yarn's cookies are plaintext.** Read the SQLite directly: 2 cookies for
  `y-prod-react.onrender.com`, `encrypted_value` empty, `value` populated.
- **No `Singleton*` files** — the app never calls `requestSingleInstanceLock()`, so the
  hostname-stamped lock that produces "profile in use on another computer" isn't in play.
- **App-Bound Encryption is still Windows-only.** No macOS provider exists.
- Chromium **razes and recreates** torn SQLite/LevelDB rather than aborting, so a torn store
  yields a *signed-out* app, not a crash-loop.

What is left is the app's own startup JS — Sentry or RecordKit init throwing an unhandled
rejection in `app.whenReady()`. That matches the observed signature exactly.

### 2d. Corrections to `session-roaming.md`

| Claim in the post-mortem | Status |
|---|---|
| "Chromium/Electron profiles don't relocate across machines" | **True in general, inapplicable here** — the mechanism that makes it true (Keychain-held OSCrypt key) is provably absent in this app |
| The missing `so.yarn.MacRecorder` container crash-looped the app | **Not supported.** It's 216 KB containing one `.tipkit` directory. The account-scoped value (`organizationId => 162`) is in its sibling plist — sharpen the claim, don't drop it |
| `.com.atacnic.hypersphere.XXXXXX` are "device/instance marker dotfiles" | **Wrong.** Leaked Chromium `mkstemp` temporaries (`"." + BaseBundleID() + ".XXXXXX"`), harmless, mildly indicative of unclean exits |
| Stacked crashpad handlers prove a crash loop | **Weak.** Every Electron launch spawns one and electron#36003 documents orphans that won't exit. N handlers ≈ N launch attempts |
| The quit-before-snapshot fix produced a clean capture | **Contradicted.** A 2.9 MB `DIPS-wal` persists while the app is not running; a clean last-connection close checkpoints and unlinks the WAL |
| "No universal where-is-the-session" ⇒ extraction doesn't generalize | **Qualify — see §4** |

### 2e. The cheapest possible confirmation, unclaimed

The app ships `@sentry/electron`, `@sentry/node`, and a DSN for Sentry project
**4506445097730048**. Every crash-loop the vault caused on mac1 during restore testing was
reported to **Yarn's own Sentry project with a full stack trace.** The evidence that would
settle §2c is already in Jasper's dashboard. That is one message, and it's a useful bug report
for them regardless of what we decide.

---

## 3. How the people who solved this actually do it

### 3a. Anti-detect browsers: decompose, don't copy — and own the binary

Read from GoLogin's open-source SDK rather than marketing. Three moves:

1. **Cookies travel as records, not files** — JSON over their API, re-inserted by hand-writing
   the destination's cookie SQLite. There is **no crypto call anywhere in that module**.
2. **The profile remnant is sanitized**, not snapshotted (§2b).
3. **The binary is vendor-pinned** — a patched Chromium fork (`orbita-browser-<version>`),
   launched with `--password-store=basic`.

Move 3 is load-bearing and explains why the naive version fails. Since **M131 (schema v24)**,
Chromium prepends a SHA-256 of the domain inside the cookie plaintext and verifies it, and
`sqlite_persistent_cookie_store.cc` **drops** any cookie that fails to decrypt. GoLogin's
prefix-less rows would be discarded by a stock modern Chromium. Owning the binary is how they
take the OS credential store out of the loop entirely.

**Verified dead end:** `--use-mock-keychain` swaps in `FakeKeychainV2`, whose store is an
in-process vector with zero persistence — so it mints a **fresh random key every launch**,
making data unreadable across restarts *on the same machine*. It never makes profiles
portable. Removing it in `00cebec` was right; it should not come back.

### 3b. The primitive that dissolves the whole problem: CDP

**CDP returns HttpOnly cookie values in plaintext and accepts them on write.** No Keychain
prompt, no DPAPI, no App-Bound Encryption, no SQLite parsing, no per-app code. Every offline
extraction tool (`chrome-cookies-secure`, `browser_cookie3`, `pycookiecheat`) exists to solve
a problem CDP does not have. Browser Use's OSS library says so in its own docstring:
*"Extracts decrypted cookies via CDP, bypassing keychain encryption."*

This was **measured end-to-end against a purpose-built Electron app**, not inferred:

- Export via `context.cookies()` returned an HttpOnly session cookie in the clear.
- Importing into a **brand-new** `--user-data-dir` made the next navigation send it through
  the real network stack.

Three sharp edges, all measured:

- **`setStorageState()` does not work in Electron at all** — it calls `Target.createTarget`,
  which Electron refuses (windows come from the main process). The failure shape is that the
  *whole call throws*: one previously-visited-but-now-closed origin poisons the entire capture.
  Electron capture is one origin at a time, the one on screen.
- **Session cookies never persist to disk** (`expires: -1` is memory-only per standard
  CookieMonster behaviour). Import is a **per-launch** step, not one-time provisioning.
- **Custom `persist:` partitions are invisible to browser-scoped `Storage.getCookies`** — an
  empty result, not an error. Use page-scoped `newCDPSession(page)` + `Network.getAllCookies`.
  The irony: CDP marks that call *deprecated in favour of* the one that silently fails.
  *Checked: Yarn uses the default session (0 `partition:`/`fromPartition` hits in its asar,
  2 `defaultSession`), so it is unaffected — but build the general path page-scoped anyway.*

**Operational constraint:** since Chrome 136, `--remote-debugging-port` is ignored unless
paired with a non-default `--user-data-dir`. Our persistent-profile Chrome already satisfies
this, but it is now load-bearing rather than incidental.

### 3b′. The generality of CDP is on the wrong axis — and Yarn falls through it

CDP is general across **encryption schemes** (it reads the browser's already-decrypted view, so
OSCrypt, DPAPI and App-Bound Encryption are all irrelevant to it) but **not general across where
an app keeps its session.** It reaches only the web-storage layer — cookies, localStorage,
IndexedDB. An app whose session lives in a file it manages itself, in Electron `safeStorage`, or
in the login keychain is entirely outside CDP's view. Electron standardizes the *rendering
engine*, not the *storage location*, so "CDP transfer for any Electron app" is false — it covers
exactly the subclass "session lives in web storage."

**Yarn is the counterexample, verified.** Its cookie jar holds two cookies, both LogRocket
analytics (`_lr_tabs_…`, `_lr_hb_…`), non-HttpOnly, unrelated to auth. Yarn has **zero auth
cookies**; its entire session is the JWT in `config.json`. A CDP capture against Yarn would
faithfully return two analytics cookies and silently miss the session — the exact "looks like
success" failure mode. So the §7 recommendation "adopt CDP for web targets" is correct *and*
scoped: for Yarn itself the right primitive is copy-the-176-byte-file, and the general answer
across all storage strategies is the machine clone (§5), not CDP.

Storage strategy → is there a general data-level move:

| Where the session lives | General mechanism? |
|---|---|
| Cookie jar | **CDP transfer** — yes, encryption-agnostic |
| localStorage / IndexedDB | CDP + script injection — yes, with the origin-visit caveat |
| A file the app manages (**Yarn's `config.json`**) | No — "which file" is per-app |
| Electron `safeStorage` (Keychain-backed) | No — decrypted only in main-process memory, invisible to CDP |
| Login keychain directly | No |

Two things that look like they rescue generality and don't: `--inspect` exposes the Electron
*main* process, where a `safeStorage` token is briefly plaintext — but reading it needs the
app's internal variable names (per-app) and hardened builds disable the inspector. And
capture-at-auth (watch the network response as the human signs in) *is* general on the capture
side — you see the token in flight regardless of final storage — but **replay** still needs to
know where to inject it, which is per-app again. Capture generalizes; replay doesn't. The only
mechanism general across every Electron storage strategy is the machine clone, because it moves
the session in the app's native format without knowing where it is (§5).

### 3c. What `storageState` silently loses

- **sessionStorage** — never collected; actively cleared on restore.
- **Non-extractable `CryptoKey`** — serialized to `{}` with no error. If a target binds its
  session to one, no data-level transfer works **and you will not be told**. Detect it: check
  for `[object CryptoKey]` in IndexedDB before trusting a capture.
- **Blob/File in IndexedDB** — `{}`, silently.
- **Origins are captured by *visit*, not enumeration.** Attaching to a rich persistent profile
  and calling `storageState()` yields cookies and an **empty `origins` array**, which looks
  like success.

---

## 4. "No universal where-is-the-session" — qualify it, don't keep it as written

Half the variance in that claim is an illusion: **Chromium's cookie encryption and Electron's
`safeStorage` are the same mechanism** — AES under a random per-install key in the login
Keychain as `<App> Safe Storage`. So "HttpOnly cookies," "localStorage," "the login keychain,"
and "safeStorage" are not four adapters; for most apps they are one place with one decryptor.
Measured on David's Mac: **19 apps** carry such an item (Chrome, Slack, Signal, Notion, Teams,
Zoom, VS Code, Cursor, Claude, Obsidian, …). Yarn carries none, which is exactly why it is the
easy case and a bad one to generalize from.

The decisive evidence that *location* is tractable is the DFIR ecosystem: commercial forensics
tools and infostealer families (AMOS, Banshee, Cthulhu, Poseidon) treat "where does app X keep
its secret" as a **maintained, versioned target list** of hardcoded paths. A per-app adapter is
roughly two paths and one keychain key name — not a research project.

First-person spot-checks on this machine, both landing in the trivially-portable class:

| App | Storage | Encrypted? |
|---|---|---|
| Yarn | `config.json` → 176-byte JWT, `HS256`, claims `email`/`iat`/`id`, **no `exp`** | no |
| Cursor | `state.vscdb` `ItemTable` → `cursorAuth/accessToken` + `refreshToken`, 392 B each, UTF-8, JWT-shaped | no |

**So rewrite the justification, not the conclusion: the token's *location* generalizes fine;
its *reuse* is what doesn't.** What defeats reuse is keychain-bound keys that don't travel
(Signal's 2024 move from a plaintext key to `safeStorage` turned a portable app into one that
throws at `decryptString`), Secure Enclave keys, and server-side anti-replay.

Useful mechanism detail: macOS keychain ACL trust is keyed to the requesting app's **code
signature** (requirement string + `teamid:`/`cdhash:` partition), **not to the machine** — a
matching signed binary reads a copied item on another Mac. The barrier is the login password
and per-item ACL prompts, not machine binding.

---

## 5. The option we never considered: clone the machine

### 5a. TCC grants are not machine-bound

The TCC `access` table keys a grant on *service* + *client* (bundle ID or path) + optionally
`csreq` — **a code-signing requirement describing the binary, not the machine**. `boot_uuid` is
written as the literal string `'UNUSED'`. Both databases live on the Data volume. Clone the
volume, the grants come with it.

This is not inference. GitHub's `actions/runner-images` ships
[`configure-tccdb-macos.sh`](https://github.com/actions/runner-images/blob/main/images/macos/scripts/build/configure-tccdb-macos.sh),
INSERTing `kTCCServiceAccessibility`, `kTCCServiceScreenCapture` and `kTCCServicePostEvent`
with `auth_value=2` into both TCC databases — and one granted client path is Anka's
`ankarund`, proving those images are built and cloned as VM templates with grants intact.
Cirrus/Tart do the same.

### 5b. This resolves a contradiction with `LIMITATIONS.md` §12

§12 says TCC is *"SIP-protected; there is no API, no MDM shortcut we have, and no way to copy
the database."* Both it and the above are correct; the missing axis is **bare metal vs. VM**.
Writing TCC.db needs SIP off, and SIP off needs a recovery boot — **on bare metal that is a
physical power-button hold per machine; in a VM guest it is scriptable** (Tart exposes
`recovery = true`; Cirrus drives keystrokes into the recovery Terminal).

That reframes the decision, because Agent F's ranking rested on §12 being unavoidable: *"a
human must already visit each Mac once for TCC, so the marginal human cost of per-box sign-in
is near zero."* True today. **False in a VM world**, where TCC becomes a property of the image
and per-box sign-in becomes the *only* remaining per-box human touch.

| | Bare metal (today) | VM golden image |
|---|---|---|
| TCC grant | human at each Mac | written once into the image |
| SIP disable | physical power-button hold | scripted recovery boot |
| App sign-in | human per Mac per app | once, inside the image, before snapshot |
| Adding a runner | full provisioning + human touches | `tart clone` |

**The case for VMs is provisioning, not density.** Apple's SLA caps 2 guests/host
(technically enforced, `VZErrorDomain` code 6), so 3 hosts → 6 runners at best. Even 1 VM per
host captures the whole benefit.

### 5c. Stack, and the state of the tooling

**Tart + Orchard.** Cirrus Labs was acquired by OpenAI (2026-04-07); the repo is now
`openai/tart`, still maintained (v2.34.0, 2026-07-21), and **licensing fees were dropped**.
`tart clone` is APFS `clonefile()` — instant, copy-on-write. `--no-graphics` suppresses only
the host-side window; the guest keeps a full framebuffer and WindowServer, which structurally
avoids the bare-metal HDMI-dummy-plug problem. Orchard's controller/worker split maps nearly
one-to-one onto `src/remote/control/`.

Rejected with reasons: Anka (paid, now dominated by free Tart), Orka (demands Kubernetes for
3 Macs), UTM (`utmctl` doesn't work over SSH). **AWS EC2 Mac is disqualified specifically** —
*"SIP configurations do not transfer to snapshots or AMIs,"* so a TCC-pre-granted AMI cannot
be baked at all. Its instance scrub also takes up to 4.5 hours.

**MDM cannot substitute.** Apple's own PPPC schema: ScreenCapture *"can't be given in a
profile; it can only be denied,"* and profile-granted Accessibility is **deprecated as of
macOS 26.2, removed in 27.0**. The golden image is the only route to the permission we need.

### 5d. Pick the guest OS deliberately — it deletes two blockers

`Yarn.app/Contents/Info.plist` declares **`LSMinimumSystemVersion = 12.0`**. The guest does not
have to run Tahoe, and both version-specific blockers are recent:

- The **compositor bug** (trycua [#870](https://github.com/trycua/cua/issues/870) /
  [#912](https://github.com/trycua/cua/issues/912)) — windows registering with WindowServer but
  never compositing, breaking `screencapture`, SCK *and* VNC identically — is reported against
  **Tahoe** guests.
- The **periodic screen-capture re-consent dialog** that would pollute recorded frames arrived
  in **macOS 15**, and its suppression key (`forceBypassScreenCaptureAlert`) needs 15.1+ *and*
  a real MDM server.

A **Sonoma (14) guest** has neither and clears the app's minimum by two majors — removing the
MDM dependency entirely. Counterweight: 14 is n-2 and its security window closes around
September 2026. This is a real trade, but the default instinct — build on current macOS — is
the one choice that walks into both blockers at once.

### 5e. The compositor risk is narrower than it looks

Our two capture paths differ in exposure:

- **AX/cua path** — `recording.ts:165` polls cua's `get_window_state` with
  `screenshot_out_file`, i.e. the `CGWindowListCreateImage`/SCK family. **Directly exposed.**
- **CDP path** — `recording.ts:83` → `cdp.screenshot()` → `page.screenshot()` →
  `Page.captureScreenshot`, rendered from the **renderer process**, not the window server.
  **Not exposed to the same failure.**

Supporting evidence: `electron-attach.ts:34` already launches every target with
`--disable-backgrounding-occluded-windows --disable-renderer-backgrounding`, and its header
states the reason — *"a recorded run screenshots the page while the [window is occluded]."* The
CDP recorder was already built to produce frames from a window the OS is not drawing.

Record this as a **strong hypothesis, not immunity**, and test it directly: boot a guest,
attach to an Electron target over CDP, and compare `page.screenshot()` against
`get_window_state` side by side. If CDP frames come back and SCK frames are blank, the VM route
survives for every CDP target and only the native-AX class is blocked.

### 5f. The caveat that survives

Apple re-derives VM identity from the **host's** Secure Enclave on move: *"If someone moves a VM
to a different Mac host and restarts it, the framework automatically creates a new identity."*
Scope is iCloud and the data-protection keychain — it does not touch TCC, the login keychain, or
a plaintext file token. For Yarn's JWT this is a non-event. For an app storing its session in
the SEP-backed keychain, the VM route degrades to per-box sign-in for that app. **Keep
`signin`/`liveview`.**

### 5.5 On MacStadium: Orka is the managed version of this route (thread opened 2026-07-31, OPEN)

The fleet is hosted on **MacStadium**, which changes the build. MacStadium's own product,
**Orka** (Orchestration with Kubernetes for Apple), is the productized version of exactly the
golden-image clone route above — image-based macOS VM deployment on Apple silicon, on hardware
already being paid for. So the §5c stack ("build it with Tart + Orchard") is reordered:
**evaluate Orka as primary; Tart-on-bare-metal is the fallback.**

Reframe of Agent C's earlier Orka rejection ("demands a Kubernetes cluster for 3 Macs"): that
was scored for *self-hosting a fleet from scratch*, where Orka's K8s overhead loses to plain
Tart. On MacStadium the calculus inverts — the K8s layer is *managed*, and Orka is the native
way to deploy from an image. The thing that made Orka not worth it is the thing MacStadium runs
for you.

**Provider and orchestration are separable — this contains the risk.** MacStadium also rents
dedicated *bare-metal* Macs. If Orka's API disappoints, run Tart/Orchard on MacStadium bare
metal: same golden-image workflow, same already-paid hardware, open-source tooling you control.
So "is Orka good enough" is a *which-orchestrator* question, never a *does-the-route-work* one.

**What the two API surfaces are (a live confusion to resolve):** `api.macstadium.com` is very
likely the thin **account/portal API** (billing, IP allocation) — not the orchestration layer.
Orka's control plane is a **separate, Kubernetes-shaped API** served inside the customer's Orka
environment, with a CLI (`orka`/`orka3`) and, historically, a published Terraform provider (the
signal that it's genuinely automatable). The four operations the productization needs — capture
image, deploy VM (returns SSH/VNC), delete, list — map onto Orka's resource model. A tell worth
noting: `hosts.json` already speaks SSH:22 + VNC:5900, the exact access shape Orka hands back
for a deployed VM.

**OPEN verify-items (none of these are settled — do not treat as decided):**

1. **Does Orka image capture preserve SIP-disabled state and the guest `TCC.db`?** This is the
   make-or-break, and it is exactly what disqualified AWS EC2 Mac ("SIP configurations do not
   transfer to snapshots or AMIs"). Orka images are full VM disk images and SIP/boot-policy +
   TCC.db live on the guest disk, so *in principle* they should travel — unverified for Orka's
   2026 pipeline. Ask MacStadium directly.
2. **Are the current three Macs Orka VMs or dedicated bare-metal hosts?** `hosts.json` is
   consistent with either and it changes the next step. If they are already Orka VMs, the
   golden-image workflow is a snapshot-and-redeploy away and part of `LIMITATIONS.md` §12's
   per-machine pain may already be soluble.
3. **Is the Orka API good enough to drive a warm pool?** The afternoon test that settles it:
   script `capture image → deploy VM → SSH in → delete` end to end. If it flows, the queue
   design (§5.6) drops on top; if it fights, go Tart-on-bare-metal.
4. Confirm `api.macstadium.com` is account-only vs. the Orka control plane (item above).

Confidence note: the account-API-vs-Orka-API *split* is a stable architectural fact; the Orka
*specifics* (current endpoints, whether capture preserves SIP/TCC, API ergonomics) are from
prior knowledge that may be stale and were **not** web-verifiable in this pass (search budget
exhausted). Treat §5.5 as a scoped investigation plan, not findings.

### 5.6 Cold start is a utilization tax, not user latency — and the queue we need mostly exists

The instinct "fire onto a queue, boot the VM, return the result async" is correct and, for the
base case, sufficient with no cleverness. Runs here are non-interactive (Jasper: 30-min runs are
fine; Auto-Time compresses the final video), so a 60–90s boot prepended to a multi-minute run
and delivered async is invisible. The queue absorbs it by construction. Do not optimize what no
one waits on.

What cold start *actually* costs is **VM-slot utilization**, not wall-clock-to-first-frame.
Apple's 2-VMs-per-host cap makes slots the scarce resource; on MacStadium that ceiling is
elastic (rent more hosts) rather than a hard 6, so it becomes a cost dial. Every second a slot
spends booting is a second it is not generating a demo.

Mitigation ladder, by leverage:

1. **Cloning is already free** (`clonefile()` / Orka image deploy is the cheap part) — the cost
   is boot-to-**ready**, and most of *that* is the app launching and reaching signed-in home,
   which we already gate on (`waitForHome`). Optimize that segment, not the disk copy.
2. **Warm pool** — hold N VMs pre-deployed at the home screen, hand one out, destroy-and-replace
   after. On Orka this is just holding deployed VMs; on Tart it is a pool of booted clones. The
   pool must be *fresh clones replenished in the background*, because cold start and cleanliness
   are the same coin (a run should start from clean golden state — the whole teardown concern).
3. **Suspend/resume from a memory snapshot** — resume lands at the already-signed-in home screen
   in seconds and costs disk rather than a live slot (strictly better than warm-idle). **OPEN:**
   whether Tart/Virtualization.framework exposes save/restore for *macOS guests* specifically,
   and whether Orka exposes it at all, is unverified — macOS-guest save/restore has historically
   had more restrictions than Linux-guest. Verify before designing around it.

Freshness has a *session* dimension too: a long-suspended warm VM resumes with the session it
froze with. Yarn's token has no `exp`, so this is a non-issue for Yarn; for any rotating/expiring
session, a stale warm VM can resume already logged out — so pool freshness must account for
session lifetime, not just idle time.

**Most of the queue is already built.** `src/remote/` has a durable job queue, a liveness-based
per-machine lease (one run per slot), and `dispatch auto` queuing on the shortest line. The VM
delta is that the lease manages a *VM lifecycle* (deploy/suspend/destroy via Orka or Tart)
rather than assuming a persistent Mac. Client submits → orchestrator hands a warm/deployed VM or
boots a clone → run proceeds → artifact returns async. That extends the existing dispatch layer,
it does not replace it.

---

## 6. The OS question

### 6a. Linux genuinely deletes the crypto obstacle

Chromium's `async/browser/posix_key_provider.cc` does not derive a key at runtime — it ships
**the derived key as a literal**: `constexpr auto kV10Key = {0xfd, 0x62, 0x1f, 0xe5, ...}`,
commented as `PBKDF2-HMAC-SHA1(1 iteration, "peanuts", "saltysalt")`, verified arithmetically.
A `--password-store=basic` profile is portable with **zero extra secrets**, and a headless box
with no keyring daemon already falls back to it.

*(Path correction for our older notes: `components/os_crypt/sync/` no longer exists — "[OSCrypt]
Remove sync backend" landed 2026-04-17. The constants are still right; the paths aren't.)*

**One trap, flagged loudly.** Mixing is asymmetric: v10→keyring is safe, but **v11/v12→basic is
destructive** — undecryptable cookies are skipped, and if every cookie in an eTLD+1 group
fails, *the entire domain group is deleted*. Set `--password-store=basic` from first launch or
you destroy exactly the logins you were trying to move.

Also useful: **Electron's cookie store is unencrypted by default** — the `cookieEncryption`
fuse defaults to Disabled.

**Ranking: Linux (fully portable) > macOS (one Keychain secret away) > Windows pre-ABE >
Windows + App-Bound Encryption.** Windows is strictly worse — DPAPI is user+machine bound, and
Google's own policy doc names "data portability across computers" as the reason to disable ABE.

### 6b. The LaunchAgent architecture is a pure macOS artifact

X11 has **no permission gate whatsoever** — XTEST exists explicitly to test "with no user
intervention," and there is no responsible-process concept; a systemd unit with `DISPLAY` +
`XAUTHORITY` works indefinitely. On Wayland, both portal backends' source confirms a valid
`restore_token` skips the dialog (GNOME's `handle_start` only constructs it
`if (!restore_stream_from_data(...))`), so it's one click ever — or zero via
`chooser_type=none` or `ext-image-copy-capture-v1`, which also gives window-scoped capture and
a separate cursor session, mapping onto what SCK does for us. uinput injection has no gate.

Windows also has no capture permission, but session 0 isolation forces Microsoft to prescribe
*literally our LaunchAgent pattern*, only fiddlier.

Our own code is already mostly portable: three runtime dependencies total, and in the CDP path
`run.ts` (825 lines) has **zero** macOS references, `cdp.ts` (1154) has one, `step.ts` and
`target.ts` one each. `@trycua/cua-driver` publishes `linux-x64-gnu`, `linux-arm64-gnu` and
Windows builds. `native/axdom.swift` has **no Linux counterpart because it needs none** —
`AXPlatformNodeAuraLinux::GetAtkAttributes()` emits `class` and `id` from the same
`ComputeAttributes()` source macOS exposes as `AXDOMClassList`/`AXDOMIdentifier`, and
`Collection.GetMatches` queries them server-side in one round trip, which macOS cannot do.

### 6c. The honest risk is visual fidelity, not permissions

This is the part that decides it and the part most likely to fail. Selenium's video sidecar
defaults to 15 fps / CRF 28 — a test log. Playwright's video is 25 fps VP8 at 1 Mbps from
recompressed JPEGs, capped at 800×800; not a substitute. Real x264 `x11grab` is fine, **but
Linux looks like Linux**: wrong fonts, hinted/subpixel rasterization versus macOS grayscale AA
(subpixel fringing survives into H.264 as chroma noise), and GTK window furniture no font work
fixes. Mitigable by rendering at 2× with pinned fontconfig and downscaling — but our deliverable
is a polished customer-facing demo video, so this must be proven before it is relied on.

### 6d. The blocker: Yarn's app cannot move

It is a Mach-O `.app` using RecordKit/ScreenCaptureKit. **Darling: no** — its own docs call GUI
support "in active development," and the known-working list tops out at Emacs and a calculator;
no Chromium app is documented working. **Wine: category error.** **macOS VM on Linux:
SLA-prohibited.**

Economics if the web half moves: ~$42/runner-slot/month versus $149–898/Mac (**6–20× cheaper**),
and "one run per machine" dissolves entirely — Selenium's Helm chart defaults to pod-per-session.

One live thread: `https://calendar.notion.so/` returns HTTP 200 with a 957-byte SPA shell and no
"download the app" interstitial, so Notion Calendar plausibly *has* a usable web version even
though it ships no Linux desktop build. If it does, the canonical alternate target becomes
Linux-viable. Worth driving once to confirm.

---

## 7. Recommendation

**Do not rebuild the vault. Do these, in this order.**

1. **Ask Jasper for the Sentry stacks** (project 4506445097730048, `com.atacnic.hypersphere`
   0.0.119, the 2026-07-31 restore-test window). Zero cost, settles §2c, and is a genuine bug
   report for them. Also flag the security finding: a **never-expiring** plaintext bearer token
   in a `-rw-rw-rw-` file. Anyone who reads it is that user, permanently.

2. **Adopt CDP cookie transfer for web targets.** This is the standard answer, we already have
   the plumbing, and it sidesteps OSCrypt entirely. Page-scoped `Network.getAllCookies` /
   `Network.setCookie`, not the browser-scoped API. If we do it, **lease *and* write back** —
   the machine that ran must return the mutated snapshot or the next starts stale — and egress
   the fleet through one IP.

3. **Spike the VM route** (~half a day). Build a Sonoma guest under Tart, script SIP off, write
   TCC grants, sign Yarn in, snapshot, clone, and run. Test the compositor question directly
   (§5e) and whether RecordKit tolerates `tart clone`'s MAC regeneration. This is the option
   with the best ratio of payoff to novelty, and it is the only one that makes *both* TCC and
   sign-in per-image rather than per-machine.

4. **If sticking with bare metal, make per-box sign-in cheap rather than avoiding it.** TOTP
   codes are single-use *and regenerate every 30 s*, so three **sequential** scripted logins via
   a 1Password service account cost ~90 s and zero human touches. Note this is the same property
   that makes broadcast/fan-out impossible (RFC 6238 §5.2; RFC 6749 §4.1.2 on reused auth codes).

5. **Amend the docs rather than rewriting them** — `session-roaming.md` gets a correction header
   pointing here; `LIMITATIONS.md` §12 gets the bare-metal qualifier.

**Explicitly rejected**, with reasons: rebuilding profile-copy (wrong primitive); a token
crawler (§4 makes it unnecessary — CDP or a two-line adapter beats it); `--use-mock-keychain`
(re-keys every launch); broadcast sign-in (single-use OTP/auth codes, and no macOS GUI
input fan-out exists — ARD documents "control *or observe one* client computer"); network-mounted
profiles (Chromium's `process_singleton_posix.cc` makes `SingletonLock` a symlink to
`hostname-pid` and *"if the hostname differs an error is displayed and the second process
exits"* — a designed cross-host refusal); moving the whole fleet to Linux (the primary target
cannot run there).

---

## 8. What remains genuinely unknown

- Whether the crash was Sentry init, RecordKit init, or split account state (`organizationId
  => 162` lives under a third bundle id `livePaths()` cannot derive). **Nobody ever read a crash
  report.**
- Whether SCK produces real frames of an Electron window in a guest — contradictory evidence:
  `jonnyzzz/tart-skills` has working headless Tart screenshots on macOS 26, while trycua's own
  tracker reports the opposite. Both concern the library we depend on.
- Whether Yarn's app runs in a guest at all, and whether RecordKit keys off MAC or hardware UUID.
- Whether Linux render fidelity clears the demo-video bar (§6c).
- Whether Yarn's backend flags N identical devices — **ask Jasper, don't reverse-engineer.**
- Agent E could not verify Figma, Postman, WhatsApp, or ChatGPT Desktop session storage within
  budget; those are "not found," not "proven absent."

---

## Appendix — research artifacts

Full agent notes (scratchpad, not committed):
`research-A-antidetect.md` · `research-B-chromium-internals.md` · `research-C-vm-roaming.md` ·
`research-D-session-import.md` (799 lines, includes a purpose-built Electron test harness) ·
`research-E-token-locations.md` · `research-F-alternatives.md` · `research-G-non-macos.md` ·
plus first-person measurements in `local-forensics.md`, `app-bundle-facts.md`,
`vm-risk-local-check.md`, `local-verifications.md`, `tcc-contradiction-resolved.md`.

Key external sources: [Playwright auth](https://playwright.dev/docs/auth) ·
[actions/runner-images TCC script](https://github.com/actions/runner-images/blob/main/images/macos/scripts/build/configure-tccdb-macos.sh) ·
[openai/tart](https://github.com/openai/tart) · [openai/orchard](https://github.com/openai/orchard) ·
[steel-dev/steel-browser](https://github.com/steel-dev/steel-browser) ·
[trycua #870](https://github.com/trycua/cua/issues/870) · [trycua #912](https://github.com/trycua/cua/issues/912) ·
RFC 6238 §5.2 · RFC 6749 §4.1.2 · RFC 6819 §5.2.2.3.

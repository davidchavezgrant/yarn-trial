# FOR_AMAN — what we learned building this, for the person building the real one

2026-07-31. Written for the engineer implementing the production version.

This is the technical companion to `docs/research/2026-07-31-poc-gotchas-and-lessons.md`
(plain-english) and `docs/research/2026-07-30-cua-learnings-for-real-implementation.md`
(the actuator decision argued in full). This doc is organized around one question: **what
should you copy, what should you redesign, and what should you not build at all.**

Everything here was measured or hit in practice during the four-day POC. Where a number
appears, it's from a run log in `out/runs/` or a stamped artifact — the repo's rule is
that numbers come from the harness, never from memory (see §7 on why that rule exists).

The A/B statistics (grounded vs. ungrounded, vision on/off) are being re-run at real
sample sizes and are deliberately absent. Everything qualitative about grounding stands.

---

## TL;DR

- **The harness is the product, not the driver.** The agent loop, verification, grounding,
  and cleanup transferred unchanged across three actuator backends; build those, and treat
  the actuator as a swappable peripheral. (§0, §1)
- **Drive web and Electron over CDP, not accessibility APIs.** Attaching playwright-core to
  a Chrome/Electron you launch yourself deletes our four worst problems at once — the 300s
  session lifetime, runs killing each other, the consent gate, and the snapshot cap. (§1)
- **Verify every action by re-observing, and never let the model self-certify.** Clicks
  that "aren't supported" work, clicks that report success do nothing; only a fresh
  observation tells the truth, and the model will exploit any hole in the evidence rules
  you leave open. (§2)
- **The scariest failure passes every check: changing the wrong copy of a setting.** Apps
  keep the same setting at a global and a per-document scope; text evidence can't tell
  them apart, and every ungrounded run picked the wrong one. Grounding plus making the
  agent state its chosen scope is the mitigation. (§2, §3)
- **Ground each app with one automated exploration pass** (~40 min for a full app, ~3% of
  the onboarding budget) — it buys correctness, not just speed — and treat the resulting
  map like experimental input, because ours got contaminated twice. (§3)
- **macOS permissions attach to the process that asks, and children inherit them.** A run
  started over SSH sees an empty accessibility tree and a black screenshot with no error;
  every run must descend from the grant-holding process. This one fact dictates the fleet
  architecture. (§4)
- **Runs must mechanically undo their own changes.** Journal what actually changed by
  diffing observations (never the model's account), restore in reverse with
  harness-written checks, and only after the recording is saved. (§5)
- **Reliability and cursor-feel are separate problems.** The pointer never physically
  moves during a run; the human-feeling cursor is drawn in post from the run's own data,
  replaying real human motion — fitted to what Yarn's pipeline outputs, not raw mouse
  input. (§6)
- **Sign-in needs a human, and that decides the deployment model.** SSO+MFA can't be
  automated and credentials must never reach the model, so sessions live on persistent
  machines, signed in once per app by a person. (§8)
- **Recipe replay is built and proven:** a verified run compiles into a replayable
  sequence that re-runs with zero model calls, the model invoked only when a step breaks.
  The live round trip worked first try; the design constraints it imposes on action
  records (stable descriptors, expectation stored with the action) apply from day one. (§9)
- **Put every rule in code.** Each rule we kept by convention — prompt hygiene, log
  writing, provenance — was broken within a day; each one moved into code held. (§7)

---

## 0. The one-paragraph architecture

`agent.ts` runs the loop: observe → model proposes ONE action + a machine-checkable
expectation (tool use, one tool call per turn) → act → re-observe → verify → feed the
verdict back. Verification gates the run; the model never self-certifies. An exploration
pass (`explore.ts`) grounds each app once, emitting a prose map (injected into the system
prompt) and a graph (queried by code). A mutation journal + teardown puts the app back
after the run. Recording polls window snapshots into an mp4; a post-pass (`humanize.ts`)
draws a human cursor over it from the run's own trajectory data. Everything runs behind
one actuator seam (`Observation`/`ActionRequest`) that has hosted three backends: `ax`
(cua driver), `dom` (cua's browser_* tools), and `cdp` (playwright-core, no cua at all).

**Copy the loop, the verification stack, the grounding pipeline, and the journal/teardown
design. Redesign the actuator choice per target class. Don't build the cua workarounds.**

---

## 1. The actuator: what to build on

### The decision, condensed

We consumed `@trycua/cua-driver` as a sealed binary behind a 184-line boundary
(`src/core/driver.ts` — the only file importing it). Full audit in
`docs/research/2026-07-30-cua-dependency-audit.md`. The punchline: we used 17 of its ~45
tools, none of its typed SDK (every real call goes through `callTool(name, json)` — it's
a JSON tool bus for us), and five of our seven documented workarounds were re-adding
capability the driver has but doesn't expose. For a greenfield build:

| Target class | Recommendation | Why |
|---|---|---|
| Web apps (majority of customer targets) | **CDP direct** — playwright-core attaching to a Chrome you launch yourself with `--remote-debugging-port` and a persistent profile | Mature, hireable, no consent gate on your own profiles, no shared daemon, sign-ins persist in the profile |
| Electron apps | **CDP direct** — Electron passes Chromium switches through (verified: `open -a App --args --remote-debugging-port=9222` works) | Same. AX fallback for apps that strip the flag |
| Native-chrome bits (menus, dialogs, file pickers, OS shortcuts) | Thin Swift sidecar (AX + CGEvent primitives — all probe-verified from unsigned Swift) | CDP's Input domain reaches the renderer only; anything the OS handles never fires |
| Native Mac apps | cua's actual moat — was out of scope (David, 2026-07-30); the blocking fix is now **built but not live-validated** | Our one native failure (Hex Fiend) was an activation-policy issue: cua's foreground delivery fronts the app at window-server level for <1ms, which never makes it key/main in the NSApp sense, so menu items stay disabled. Calculator worked. The fix is implemented in `AxBackend.acquire` (src/backends/ax.ts): ONE genuine AppKit activation at run start (System Events `set frontmost` by pid — sticky per the TextEdit probe), outcome logged as `activation`. **Live-validated at the mechanism level 2026-07-31**: after an activated run, menu AXPress on a BACKGROUNDED TextEdit works (File ▸ New created a document, count 8→9; frontmost=false) — the exact operation the un-activated failure silently no-ops. The end-to-end native TASK still failed (0/11), but on a different class: multi-window targeting (driver attached to one of 8 open documents while actions landed in another; run `2026-07-31T10-29-05-036-textedit`). So: activation solved, window-targeting is the next native blocker — don't declare native working until a multi-window task passes. The window-follow fix is now implemented (front-window selection by z-order via `pickWindow`, re-resolved per observation and logged in the run transcript) — built and unit-tested, live re-validation pending |

### What CDP-direct deletes, by construction (`src/backends/cdp.ts`, ~630 lines, read the header)

Each of these cost us real debugging time on the cua path:

1. **The 300s session TTL.** cua sessions have a 300-second ABSOLUTE lifetime from
   `start_session` — not idle. Measured: a session kept busy every 5s died at 300.1s.
   It masqueraded as a step limit (explore averaged ~20s/action → death at action 15,
   reproducibly). Fix on the cua path: `start_session` is idempotent and refreshes the
   clock, so `driver.ts` heartbeats every 90s. Also: the driver uses TWO error codes for
   a dead session (`session_ended` AND `session_not_started`) — recovery must match both.
2. **The shared-daemon kill.** cua's `close()` calls `shutdown()` on the shared native
   core, so a second process opening and closing a session **kills any run in flight on
   the machine**. A one-off diagnostic script destroyed a 20-action exploration this way.
   This single fact forced the one-run-per-Mac lease, which on a fleet means parallelism
   = machine count.
3. **The consent gate.** cua's `browser_prepare` requires a per-call, five-minute,
   single-use approval token minted interactively. We tried four documented escapes; all
   failed. What works: the CLI checks for a TTY, not a person, so we mint the token under
   `expect` answering "APPROVE" (`mintApprovalToken()` in `src/backends/browser.ts` — the ugliest
   code in the repo). The lesson: the gate protects *arbitrary users'* profiles; a
   first-party fleet driving its own disposable profiles inherits a threat model it
   doesn't have. Don't consume someone else's safety gate — CDP on your own Chrome has
   none. (Also: `script -q /dev/null` supplies a pty but RACES the prompt; `expect`
   waits for the prompt text.)
4. **The node budget.** cua's semantic_v2 snapshots cap at 300 nodes, non-configurable
   (confirmed against the binary: output-only field). We built continuation-paging in
   `dom.ts` to exhaust it. Playwright's `ariaSnapshot({mode:"ai"})` returns the whole
   tree in one call.

CDP's own gotchas, so you don't rediscover them:
- **Input goes to the renderer.** Menu bar, browser chrome, OS dialogs, file pickers,
  permission sheets: unreachable. Keep an OS-level input path (sidecar) for those.
- **Chrome throttles backgrounded tabs** and a throttled tab times out every
  `page.screenshot` — and the DOM snapshot channel never notices, so the run looks
  healthy while the pixel channel silently loses every frame. `bringToFront` at attach.
- **libx264 refuses odd frame dimensions** (a 1200×953 viewport crashed the encoder).
  Pad to even.
- Use a non-default debug port (we use 9777) so you can coexist with anything else
  speaking CDP.

### Don't reach for cua's DOM backend — it's dominated in every branch

There are THREE ways to perceive a Chromium target, and it's worth being explicit that
cua's `browser_*` DOM path is never the right one:

| Path | How it perceives | The catch |
|---|---|---|
| `ax` (cua driver) | the macOS **AX tree** | Chromium drops `id`/`class`/`data-*`, so icon buttons arrive as `AXButton ""` (what the axdom sidecar recovers) |
| `dom` (cua `browser_*`) | `semantic_v2` snapshot **over CDP** | 300-node budget, non-configurable; needs the consent gate; on the shared daemon |
| `cdp` (playwright-core) | `ariaSnapshot({mode:"ai"})` **over CDP** | none — whole tree in one call, typed refs, boxes, `[selected]` values |

Two things people conflate as "cua stripped my data" are actually different problems: the
`id`/`class` stripping is the **AX path** (row 1, fixed by the sidecar); the 300-node cap
is the **DOM path** (row 2). They have nothing to do with each other.

The load-bearing point: **cua's DOM path and pure CDP talk to the same Chromium over the
same protocol** — cua's `browser_*` is a middleman in front of the exact channel `cdp`
speaks directly. So going through it can only ADD problems, never remove them, and it is
dominated in both branches that matter:

- **Debug port reachable** → pure `cdp` wins. Same protocol, but no 300-node budget (we
  built continuation-paging in `dom.ts` purely to climb out of it; Notion Calendar's week
  view is 1176 nodes, so the default `DOM_MAX_PAGES=1` showed the model only the top 300),
  no consent-token gate, no 300s TTL, no shared-daemon lease.
- **Debug port stripped** (Figma-style hardened Electron — it sanitizes its own argv and
  relaunches without the flag) → BOTH CDP paths are dead, so you fall back to `ax`. cua's
  DOM path needs the same port `cdp` needs, so it dies too — and if the port were open you
  wouldn't want the middleman anyway.

There is no target where cua-DOM is the right choice. We keep `dom.ts` only as the
historical record of how we learned "DOM and AX compose — a hybrid beats either"; the
lesson transferred to `cdp` + a thin AX sidecar. If you're grepping for a reason to use
it, there isn't one — pick `cdp` (port open) or `ax` (port closed).

### If you keep any cua

- Check whether the Rust core is actually open source (package.json points at
  `github.com/trycua/cua`, MIT — we never verified the core is in there vs just
  bindings). If open, fork/upstream is the right posture; if closed, treat it as a
  closed vendor with Accessibility + Screen Recording grants on your machines.
- **Never parse driver error prose with regexes.** We did (`session_ended` matching,
  refusal-shape checks) and each one silently breaks if the driver rewords. Pin a
  version and write contract tests against its actual output (our dispatch tests are
  the pattern).
- **`browser_*` refusals are NOT errors.** They arrive as
  `{"status":"refused","refusal":{...}}` with `isError` unset — exception-based handling
  walks straight past and the run dies three steps later blaming the wrong call. Check
  the payload shape on every browser tool.

### AX-path actuation facts (needed if you keep any AX driving at all)

- **AX is the actuator of last resort whenever there is no reachable DOM** — and the runner
  now applies that rule automatically: native apps get it as the primary, and an app target
  whose debug port never comes up (argv-sanitizing hardened Electron, or already running
  without the flag) falls back cdp→ax mid-acquisition, loudly. The decision is
  `fallbackEligible()` keyed on `EndpointUnavailableError` (src/backends/electron-attach.ts)
  — a TYPE check, because regex-over-error-prose broke twice — and the run log records
  `backend` (what actually drove) + `backendFallback: {from, reason, detail}`.
  **Live-validated 2026-07-31** (run `2026-07-31T10-35-19-459-yarn`): `--backend cdp`
  against a portless running Yarn printed the CDP UNAVAILABLE banner, continued on ax,
  and logged `backend:"ax"` + `backendFallback:{from:"cdp", reason:"running-without-port"}`.
  (That run then died on an unrelated pre-existing failure — the fallback window landed on
  an inactive Space, `TargetNotObservableError` — which is the AX path's known capture
  constraint, not the fallback's.)
- **The activation-policy fix is implemented in AxBackend** (src/backends/ax.ts): acquire
  ends with ONE genuine AppKit activation — System Events `set frontmost` by pid, non-fatal
  on refusal, sticky per the TextEdit probe (menu items stay enabled after backgrounding) —
  logged as `activation` in the run log. Live-validated at the mechanism level 2026-07-31:
  post-run, menu AXPress on a BACKGROUNDED TextEdit created a document (8→9, frontmost=false)
  — the operation the un-activated failure silently no-ops. End-to-end native tasks still
  blocked on multi-window targeting (see the actuator table's native row).
- **Warnings lie in both directions.** "Element does not advertise AXPress" clicks
  usually work; clicks that report success sometimes silently no-op. Only the next
  observation tells the truth — this is the core argument for verify-per-action. A
  silent no-op is the worst case: your next keystrokes land on whatever IS focused and
  trigger the app's global shortcuts (a stray "P" opened a random overlay).
- **`set_value` writes the AX value, fires no DOM event, and React re-renders over it.**
  Same for AXSlider. Actuate like a user: click, ⌘A (fields are often pre-filled —
  typing without select-all appends "New YorkParis"), type. `type_text` is never
  driver-verifiable ("sent via CGEvent") — confirm via the field's value next snapshot.
- **Element indices are per-snapshot walk order.** They renumber whenever the tree
  changes shape — which is exactly what an action causes. Never cache one; resolve by
  role + label against a fresh observation. This same fact shows up three more times
  below (journal matching, frontier keying, geometry verification) — it's load-bearing.
- **Delivery mode is app-specific.** Yarn: background clicks silently no-op, background
  scroll is refused outright — everything needs foreground. Notion Calendar: background
  mostly works. Menu-bar keyboard equivalents (⌘,) always need foreground; plain menu
  AXPress from background fails with -25202. Foreground delivery restores the
  *previously* frontmost app after each action, so recording staging must front the
  target first. And every foreground action is an activate→act→restore cycle — the focus
  churn this causes is itself what destabilizes Electron's AX tree (see §4).
- **Escape is not a universal dismiss.** Yarn's settings modal ignores it (an unlabeled
  42×42 X button closes it); popovers survive across driver sessions.

---

## 2. Verification: the part to copy wholesale

The design principle: **the model proposes, the harness disposes.** Every hole below was
found because a model exploited it — treat the evidence grammar as an adversarial
interface, because under pressure to report success, the model will find whatever
loophole exists.

### The gate (per step, deterministic — `verify()` in `src/core/harness.ts`)

- The model must state, WITH the action, substrings that will appear/disappear in the
  next observation's text (window title + all element labels + values). An act call with
  no checkable expectation is **rejected unexecuted** — it costs the model a turn. This
  matters more than it looks: OpenRouter doesn't strictly enforce tool schemas, so a
  "required" field can simply be missing.
- **Checks must discriminate.** An expectation already satisfied by the PRE-action
  observation proves nothing about the action and doesn't count. This one rule is what
  killed the largest class of false positives (e.g. verifying "GMT+2" when the screen
  already showed GMT+2 beside the unchanged setting).
- **Close the degenerate cases explicitly**, they will all be found: `textIncludes:[""]`
  passes any screen (every string contains ""); whitespace-only substrings pass
  everything; excludes-only evidence with no prior baseline proves nothing; on the
  `done` path there is no previous haystack so the discrimination guard doesn't run —
  which made `done(success, evidence:{textIncludes:[""]})` a free pass until it was
  stripped. Share one `checkableCount()` between the gate and the verifier so they can't
  disagree about what counts.
- **`done(success)` is graded by the harness** against a FRESH final observation. The
  model never declares victory; it submits evidence.
- The model MAY override a failed check with visual evidence (expected "CEST", saw
  "GMT+2" — correct), but the override is logged as such.

### The advisory layers (never gate alone)

- **Pixel delta** (per step): fraction of pixels changed since last observation. Exists
  because canvas/rendered content has NO AX representation — Yarn's library renders ~12
  video thumbnails; the AX tree reports one 20×20 icon among 377 elements. Without this
  channel, "the window never repainted" is invisible. Advisory because legit actions can
  change nothing and animations change everything.
- **Geometry** (per step, stronger than pixels): a drag on painted content often shifts
  NAMED elements around it when the app re-lays-out. `framesShifted()` compares element
  positions across observations and matches movement proportional to the drag (frames
  are logical points, drags are screenshot pixels — the ratio is a display property, so
  never bake a scale factor in; and accept the exact-half delta a 2x display produces).
  Key frames by NAME, not index; a name shared by siblings witnesses nothing.
- **Visual judge** (once, at `done`): a SEPARATE model call given the task, **the
  agent's claim**, and the final frame → PASS/FAIL/UNPROVEN. Two hard-won rules:
  - **It must receive the claim, not just the task.** Given only "show me how to change
    the cursor type", it PASSED a wrong-scope frame, reasoning the task only asks to
    locate the control. Given the agent's claim ("I changed the brand-wide default"),
    the same frame FAILS as contradicting it. Verify the claim.
  - **A missing verdict must be loud.** The judge silently vanished when its token
    budget ran out mid-reasoning (stop_reason max_tokens, only a thinking block, zero
    text) — on exactly the hardest frames — and an absent advisory printed identically
    to a passing one. Budget generously and print "no verdict" explicitly.
- Channels are recorded per step (`verifiedByChannel` in the run log) so a
  pixel-verified run can never be quoted as text-verified.

### The failure mode text can never catch: wrong scope

**The most important finding in the POC.** Yarn exposes ~10 settings at TWO independent
scopes: a brand-wide default (Brand Kit ▸ Screen Clips) and a per-project override
(Project actions ▸ Screen Clip Settings). Verified independent stores by writing one and
reading the other. On "change the cursor style", **all four ungrounded runs changed the
per-project override, passed every check, and truthfully reported success.** Substring
evidence proves *a* control reads the value; the disambiguating context (breadcrumb,
panel title) is exactly what a flattened haystack destroys. Any app with global defaults
+ per-document overrides has this class.

Mitigation (all partial, layered): the appmap graph tags controls with a `settingKey` +
`scope`; `findScopeAmbiguities()` detects settings at 2+ scopes; `scopeWarnings()`
injects both navigation routes into the prompt and **requires the agent to state which
scope it chose and why** — an unstated choice is indistinguishable from a wrong one. Do
NOT hardcode a preference (we tried "prefer broadest" — wrong the moment a task says
"for just this project"; verified the agent picks correctly from task context both
ways). Group the warnings by surface pair, not per setting: 10 settings sharing one pair
of panels was 10.8k chars listed separately vs 1.9k grouped.

### Perception and rendering die separately

Two runs kept a full, addressable AX tree for 15 steps — elements resolvable, `verify()`
grepping a plausible haystack — while the window never repainted once: 247 byte-identical
frames, current-time line frozen, five minutes of video of a still image. Healthy on the
channel that gates, dead on the channel that ships. Detection: `unpaintedStreak()` counts
trailing steps that verified nothing AND moved no pixels (a verified step proves life; an
unknown delta is not evidence and also clears it). Fires at 4; replayed over 48
historical logs it flags exactly the two frozen runs.

**But it reports, it must not abort** — we learned this the hard way: apps that embed
their own AI assistant (Yarn's thinks for up to five minutes) produce this exact
signature while working correctly. A frozen window and an app waiting on a slow model
are indistinguishable from outside. Related: `wait` must take a `seconds` argument (we
clamp at 10 min). Before it did, the longest expressible pause was the ~900ms settle,
so waiting out five minutes cost ~330 model round-trips against a 15-step budget.

---

## 3. Grounding: the explore pass

Cost: a *finished* pass on Yarn = 40 min / 96 actions ≈ 2.8% of the ~24h/app onboarding
budget Jasper described. (Ignore any "~5-6 min" figure in older docs — that measured a
pass truncated by a step budget.)

Two artifacts per app, and the split matters:
- `docs/appmaps/<app>.md` — prose, injected verbatim into the system prompt. Models use
  prose well.
- `docs/appmaps/<app>.json` — the graph: nodes carry `scope`, controls carry
  `settingKey`. Code queries it (scope warnings, journal tie-breaking, home reset); the
  model never reads it. Missing `.json` = graph features silently off.

Design decisions that took iteration to get right:

- **Terminate on an empty frontier, not a step budget.** Every observation already lists
  the app's interactive controls, so `seen − actuated − dismissed` is arithmetic. A step
  budget is wrong in both directions; asking the model "did you cover the app?" asks a
  transcript that by construction only contains what it visited. The frontier is a
  moving target (opening one surface adds twenty entries), hence the dismiss escape.
- **Bound bulk dismissal or "frontier empty" is meaningless.** An uncapped pass cleared
  104 unrelated controls in one dismissal sentence and declared itself done at 25
  actuated of 262 seen. `EXPLORE_DISMISS_CAP` (20) refuses a bulk dismissal that names
  no specific surface → same app went to 47 actuated / 396 seen. **Read
  `controls: N actuated / M dismissed / K seen` in the stamp, never the stop reason.**
- **Key frontier entries by (role, label, surface), never by handle** (walk order,
  renumbers — see §1). Siblings sharing all three collapse into one entry: a deliberate
  under-count so the frontier converges instead of regrowing on every redraw.
- **Salvage on crash.** `finish` was the only artifact writer, so any throw discarded
  the whole pass — silently, with the stale previous map still on disk looking current.
  Everything learned is already in the transcript: on a crash, one final model call
  (tool_choice pinned to `finish`, after answering any dangling tool_use) emits the map,
  stamped `salvaged` so readers know it's weaker.
- **Destructive controls: split the verb classes.** Externality verbs
  (send/publish/share/purchase/account) — hard refuse, always. Reversible-looking verbs
  (delete/reset/archive/export) are two-phase in any well-formed app: the press opens a
  confirmation that commits nothing. `EXPLORE_DESCENT=1` lets the pass press ONCE, the
  HARNESS classifies what surfaced (confirm-dialog / file-sheet / oauth-window /
  no-modal) and the HARNESS sends Escape — the model never acts inside the modal.
  Without this, 350 of 396 Yarn controls were permanently unmappable. Also: give the
  destructive-label guard its own switch — ours originally rode on the general
  `guidance` flag, so steering a pass silently disarmed delete-protection. And the label
  regex needs single-word forms: Logout, Signout, Clear.
- **Have the pass declare `home`**: the app's landing surface + the control that reaches
  it. It's a test fixture (runs reset to it so A/B arms are comparable), never shown to
  the task agent. Don't derive it from the graph — every structural signal picks wrong
  (exploration lives in settings panels, so subtree-size picks the *editor*, the most
  stateful possible start). Validate the declaration against the walk's own evidence
  (surface must be a recorded node, control must appear in an edge action), because this
  one field silently governs every future run's start state.
- The home probe is also the **sign-in wall detector**: a fresh install sits at a login
  screen, and the declared home control is exactly what's missing there. Ungated, the
  agent treats the wall as the task (one run opened an OAuth flow in Chrome before being
  killed). Refuse to run (distinct exit code) instead.

### Provenance, or: the appmap is an input that can be contaminated

The measurement rule (task prompts state the GOAL only, method knowledge lives in
declared inputs) has a side door: **the grounding artifact itself.** Our original appmaps
were partly hand-written and contained recipes for the exact tasks being measured — so
"grounded" runs measured recipe-following. The fix is structural: `docs/appmaps/` holds
ONLY stamped explore output (machine provenance header, content hash recorded in every
run log); hand-curated notes live in `docs/recipes/`, a separately-declared tier. Never
hand-edit a stamped map. In production this translates to: **grounding artifacts need
provenance metadata and an integrity story**, or your quality metrics quietly measure
your ops team's annotations.

---

## 4. macOS platform traps (each cost an afternoon; none reports an error)

Ordered roughly by how much architecture they dictate.

1. **TCC attributes grants to the responsible process; children inherit.** A run spawned
   from an sshd session asks for grants sshd doesn't have → **empty AX tree AND black
   screenshot, zero errors**, indistinguishable from an app that hasn't launched. This
   is why each fleet Mac runs our Electron app itself as the daemon (`--serve`,
   LaunchAgent bootstrapped into `gui/<uid>` — `user/<uid>` has no window-server session
   and fails identically silently), and every run is its child. **This fact alone shapes
   the entire fleet architecture. Design for it from day one.**
2. **Screen Recording has no "+" button.** macOS builds that Settings pane from
   processes that have called `CGRequestScreenCaptureAccess` — an app that never asked
   cannot be granted even manually. (From Electron: enumerating `desktopCapturer`
   sources triggers the call; discard the pixels.) And a grant does NOT apply to a
   running process — restart after granting or the host reports grants present and
   captures black.
3. **Spaces, not occlusion, are the perception boundary.** A window on an inactive
   Space (any fullscreen app owns its own Space) is unobservable AND unactuatable:
   Chromium tears down the AX tree and rendering for it, while `list_windows` still
   shows the window. Measured: same window, occluded-on-active-Space = fine (61/230
   elements, capture works); on-inactive-Space = 0 AX windows, capture fails.
   **Programmatic activation returns success and does nothing** across Spaces — macOS
   refuses background-initiated Space switches, from AppleScript, `open -a`, and the
   driver alike. Foregrounding DOES fix the look-alikes (no window / hidden /
   minimized) — try once, re-find the window (relaunch can mint a new window id), then
   fail honestly. Yarn's own build ships `--disable-features=MacWebContentsOcclusion`,
   which helps.
4. **Electron AX trees go dark under focus churn** — and foreground delivery's
   activate→act→restore cycle is itself the churn. Mid-run, the web-area subtree empties
   for a few observations, then returns. This is the "~1 run in 3 aborts" tax on the AX
   path (retries were clean every time; it's throughput, not capability — but it's the
   whole case for CDP perception). Warning: error messages that self-diagnose lie — the
   driver's "target not observable: most likely on an inactive Space" was demonstrably
   wrong at least once (frames showed the window rendering fine). Also **a locked screen
   produces the identical signature** (tree present-but-empty, screenshots of the lock
   wallpaper) — check `ioreg`'s `CGSSessionScreenIsLocked` and name it, or you'll chase
   AX ghosts.
5. **Chromium's AX tree drops DOM `id`/`class`** (not part of the ARIA mapping) → icon
   buttons with no aria-label arrive as anonymous `AXButton ""`. Chromium's Mac bridge
   still exposes the source node as nonstandard attributes (`AXDOMIdentifier`,
   `AXDOMClassList`, `AXHelp`, `AXDescription`, `AXPlaceholderValue`, `AXURL`) that sit
   behind the Accessibility **C API** — unreadable from Node, hence a Swift sidecar
   (`native/axdom`, ~120 lines). Measured on Yarn: 955/1044 anonymous nodes named, 37/64
   anonymous *interactive* controls. Join the two walks by **frame geometry** (indices
   aren't comparable across walks) and round the way Swift rounds — `Math.round` takes
   −0.5 → 0 where Swift takes it to −1; this was a real bug. **On CDP you get the DOM
   directly and this entire layer evaporates** — it exists only because cua's projection
   is sealed.
6. **Natively-fullscreen apps report ZERO windows to System Events** (`windows[0]`
   throws -1719). Absence of windows IS the fullscreen signal. Setting a position on a
   fullscreen window demotes it out of fullscreen. Both broke recording staging
   silently for a day.
7. **ScreenCaptureKit from unsigned binaries**: one-shot `SCScreenshotManager.captureImage`
   works; live `SCStream` works from an ad-hoc-signed swiftc binary **provided the
   process descends from the TCC grant holder** (liveview proves it on the fleet). The
   real gate is #1, not code signing. Inside a signed app all of this relaxes.
8. **LaunchServices can bind an app name to the wrong bundle** — a build shipping a
   nested copy of itself in `Contents/Resources` made `open -a` launch the inner one.
9. **Resolve paths from the module's own location, never cwd.** A LaunchAgent and a
   packaged .app both start at `/`; `mkdir -p` succeeds, `/out` gets created at the
   filesystem root, the appmap isn't found, and the run silently degrades to ungrounded.
   Split writable DATA from read-only RESOURCES (`src/paths.ts`, unchanged by the reorg) — packaging separates
   them.

---

## 5. Cleanup: the run puts the app back

A run is otherwise a one-way mutation — the canonical demo really did leave the brand
default changed, every later run started from a dirtied workspace, and on a fleet a
dirty job poisons the next one on that host. Three layers (`journal.ts`, `teardown.ts`,
`cleanup.ts`), all **mechanical — never the model's account of what it did**:

- **Journal:** `detectMutation()` diffs control VALUES between pre/post observations.
  Match controls by `(name, surface)` — never handle (§1). Entries append to a JSONL
  **the instant they're detected**, which is what makes a crashed run recoverable.
  `settingKey`/`scope` resolve from the appmap graph, with the observed surface breaking
  dual-scope ties; when it can't, leave scope UNSET — an inferred scope sends teardown
  to the wrong store. Two subtleties that produced real bugs:
  - A click on a menu OPTION commits its change as the menu closes, so the clicked
    element vanishes and a target-only diff sees nothing. Scan for the owning combobox
    that now reads the option's label (`optionCommit()`).
  - Never journal a coordinate click on an UNLABELED control: the after-lookup matches
    the first anonymous element on the surface — routinely a different control — and
    fabricates a mutation; then `controlReads("")` matches every anonymous element.
- **Teardown:** replays the journal in reverse. The target value is KNOWN, so **the
  harness writes the check**; the model can't widen it. The check is the named
  control's own value with **whole-value equality, case-folded** — not substring, not a
  haystack grep. Both weaker forms failed concretely: an open dropdown renders the
  original value as an option at exactly the moment the setting is NOT restored (grep
  scores that as restored), and substring said "Auto" was restored when the control
  read "Auto-hide". Isolate entries — one throwing entry must not abandon the rest.
  Guard every proposed restore action with the destructive-verb check: this loop runs
  unattended after the run already reported, and a restore never needs a destructive
  verb.
- **Standalone CLI** for the SIGKILL case (crashed run leaves a journal but no run
  log) — and it must call the SAME `runTeardown()`; two implementations of "restored"
  is how they diverge.
- **Ordering is load-bearing:** teardown runs AFTER the recording is stopped and
  assembled. The mp4 ends on the changed state; a video of the agent undoing its demo
  is not a deliverable. Also after: because it sits in the `finally`, step-limit exits
  and aborts — the runs nobody watched — get cleaned too.
- **Advisory by default** (`CLEANUP=advisory|block|off`): "did the task succeed" and
  "was the app left tidy" are different questions. An entry with no recorded prior
  value counts as neither restored nor failed. `off` exists because for filming, the
  changed end state IS the artifact. And in block mode, a teardown that THROWS must
  fail the run — ours initially passed the maximally-dirty exit because the error path
  set no `failed` count.
- **Created resources:** the agent declares them via a `claim` tool; the prompt directs
  work into a NEW scratch document. Claims are **reported, not deleted** — deletion has
  no second chance and the ledger is only as good as the model's discipline. Tell the
  model this plainly: a model told its mess is auto-handled is the one that stops
  preferring scratch. (Gap we know about: the task agent's claims live in memory until
  the run log writes; explore persists them to the journal at claim time. Do the
  latter.)

---

## 6. Recording and the humanized cursor

Architecture fact that simplifies everything (from Jasper directly): Yarn composites a
synthetic cursor in post and time-compresses demos ("Auto Time"), so **reliability and
feel fully decouple**. The agent's deliverable to the renderer is DATA: click point,
dispatch/completion timestamps, target element's role + rect, per-frame capture times,
window geometry. Model thinking gaps don't matter; the rendered timeline is synthetic.

### Capture

- **Never capture the display** — it records whatever else is on screen (it captured
  unrelated personal content during our testing; rejected outright). Poll window
  snapshots (~4fps, immune to occlusion) and assemble with ffmpeg. On CDP, capture the
  page viewport via `page.screenshot()` — no staging at all.
- **Wait for the window to report a stable size (3 identical polls) before recording.**
  Staging resizes the window; the capture surface follows late. We got 25 opening frames
  at the wrong size showing the PREVIOUS run's screen.
- **Sample adaptively:** 120ms for ~4s after each action (the app's response arrives
  within a second or two and can fall entirely between fixed-rate captures), 400ms
  idle. Collapse byte-identical gap frames (139 usable frames held only 19 distinct
  screens).
- Defend assembly: majority-vote on frame size + leading-black-band content check.
  Persist per-frame capture times — ffmpeg's list format clamps gaps and erases exactly
  the timing you need later.

### The humanize pass (`humanize.ts` → `motion-track.json` + `humanized.mp4`)

The physical pointer never moves during a run (measured: 1.2% of cursor samples, all
teleports) — AX/CGEvent actuation doesn't touch it. So the cursor is drawn afterward.
What we learned, in the order it surprised us:

- **Replay real human motion segments; don't synthesize curves.** Measured over 1,895
  human approach segments: motion is asymmetric (90% of distance in the first half of
  time), unsmooth (peak speed ~10× mean; a third of mid-flight samples nearly stopped),
  not straight (median 9% off-axis), and duration barely follows distance (Fitts's law
  fit: R²=0.09). An eased curve gets all four wrong. The BeCAPTCHA-Mouse literature
  agrees: submovement count is the single most discriminative human-vs-bot feature.
- **Fit to the signal the audience sees, not raw input.** Yarn's renderer decimates to
  every 3rd sample and drives a critically-damped spring (mass 1, stiffness 170,
  damping 26). That transform inverts conclusions: raw peak-speed/mean 10.4× → rendered
  2.5×; submovement peaks 7 → 2. Our first fit targeted raw data and was correct about
  hands, wrong about output. If their pipeline changes, refit.
- **Never animate what didn't happen:** actions that failed verification (a warned
  no-op click), the home reset's navigation (the driver's recorder backfills earlier
  turns — stamp recording-start and drop everything before it), an atomic `set_value`
  drawn as typing. When an action is dropped, drop its FOOTAGE too (from dispatch until
  consequences settle — not until the next dispatch, which swallows the anchor frames
  the next action needs).
- **Coordinate spaces shift WITHIN a run:** capture width changed four times in one run
  (window moved displays). Scale per turn; take the modal frame size, not frame zero
  (first frames carry transient geometry). The driver's own click_point can be wrong
  (41px off on a same-named offscreen twin button) — and the recorded rect was wrong
  WITH it, so no cross-check catches it; the before/after pixel diff is the only
  independent witness, correct against it conservatively.
- Feel details that mattered: park the idle wait at the NEXT target, not the previous
  one (post-click lingers read as "stuck"); switch pointer type when crossing into the
  target rect, not at the click; draw a hover tint (the app never paints one — no real
  mouseover ever fired); scatter landings inside the target (triangular distribution) —
  exact-center clicks were the most machine-like thing left; round positions to whole
  pixels; size cursor art by output-pixels-per-logical-point.

---

## 7. Measurement discipline (process, but it burned us twice, so it's here)

- **Goal-only prompts, enforced in code.** The rule "task prompts state the goal;
  method lives in the appmap" was violated twice in one day while enforced by memory —
  including in a take emailed to Jasper — and zero times after `auditTaskPrompt()`
  started refusing hinted prompts (`--hinted` opts in and stamps the log). Gate details
  that took iteration: count occurrences not unique hints (a dictated 4-click path
  deduped to one hint and passed), bound verb regexes ("clickable", "pressure" were
  false-flagging), keystroke glyphs are their own category, case-insensitive tool
  vocab. On a canvas, a coordinate in the prompt IS the answer — refuse it.
- **One run-log writer, in a `finally`.** We had two writers; they drifted; one path
  omitted the field the gallery filtered on, and **aborted runs wrote no log at all —
  every reliability figure before the fix was survivorship-biased.** Unique names
  minted with ms + counter (two same-second runs clobbered each other's artifacts).
- **Reset the app before every run** (to the appmap's declared `home`), and make a
  failed reset LOUD — ours failed silently (open dropdown hid the sidebar from AX) and
  voided an A/B pair. Escape-and-retry once.
- **Interrupts are data:** Ctrl-C between actions, not mid-action — the `finally` still
  assembles video, writes the log, runs teardown. Watch handler ordering: our overlay's
  SIGINT handler called `process.exit()` before the run loop's flag-based handler ran,
  which skipped log + teardown + session close on EVERY interactive stop, by default.
  If any component registers signal handlers, it defers when another handler exists.
- **Instruments lie; build negative controls.** The canvas probe twice reported false
  positives: its "null drag" actually scrubbed the playhead (the mousedown moved the
  clock being read as evidence — replaced with an idle wait), and a per-target readout
  was produced by ANY click (added a decoy click whose evidence can never count).
- Two env-var footguns worth stealing the fix for: `Number(env.X ?? d)` turns `X=`
  (empty interpolation in a plist) into 0 — which for CLEANUP_STEPS disables teardown —
  and a typo into NaN, false for every comparison. Die at import naming the variable;
  explicit 0 still parses.

---

## 8. Fleet + auth (if the real thing runs on managed machines)

The full constraint list is LIMITATIONS §12; the architecture-shaping subset:

- **Auth decides the deployment model.** Customer apps sit behind SSO+MFA, which is not
  automatable in the general case — so a signed-in session is a stateful, human-created
  asset that must persist. Ephemeral VMs destroy exactly that asset. The shape that
  falls out: **persistent machines that hold sessions**; sign-in is a first-class flow
  (once per app per machine — full-desktop screen share, or the liveview path: SCK
  single-window capture + input injection over a token-gated WS bridge, so the human
  sees only the window being signed into). **No credential ever enters the agent loop**
  — every observation and every frame reaches the model and the recording; an agent
  that types a password leaks it into two artifacts you hand to other people.
- **Per-operator profile swap** on shared machines (an app's data = its dirs under
  `~/Library`, derived from the bundle id — no per-app table). Quit the app FIRST: a
  running Electron app rewrites its cookie jar on quit and writes the outgoing
  operator's session into the incoming one's directory. Serialize swaps (interleaving
  destroyed a stashed profile). Known limit: keychain-stored sessions aren't isolated
  by this.
- **SSH hygiene:** sshd joins remote argv into ONE login-shell string — anything
  crossing as text is shell input on the far side regardless of quoting here (app names
  carry spaces; URLs carry `&`). Ship variable data as an encoded spec file; build
  command lines from fixed tokens only. One module owns ssh invocation, with explicit
  identity/known_hosts/config so nothing depends on or mutates the operator's `~/.ssh`.
  Pin hosts by host KEY — colo addresses move between machines.
- **Re-derive state; never trust records.** A job record saying "running" is a claim
  about a pid — ask the kernel at startup, mark orphans. Lease validity is process
  liveness, never a TTL; the claim is one `O_EXCL` create so check-and-claim is a
  single syscall. Atomic writes (temp + rename) — status polls land between truncate
  and write.
- **Dispatched runs outlive the dispatcher:** detached child owning its own log file,
  follow resumable by byte offset, artifacts pullable later. A closed laptop lid costs
  nothing against a 40-minute pass.
- **Sync grounding artifacts by their embedded `capturedAt`, never mtime** — git
  restamps on checkout, so a fresh clone looks newer than last week's finished pass and
  overwrites it.
- Retry model calls; when the provider aggregator names the failing upstream host in
  error metadata, route around it — backoff alone re-asks the same broken host.

---

## 9. What NOT to build (things we built, measured, and would drop or defer)

- **The axdom sidecar + frame-geometry join** — an artifact of cua's sealed projection.
  On CDP the DOM is just there. Only rebuild if you keep an AX-only path for
  flag-stripped Electron apps.
- **The session heartbeat, the shared-daemon lease, the consent-pty hack, semantic_v2
  paging, error-prose regexes** — all cua-shaped scar tissue. Deleted by construction
  on CDP.
- **Any per-app table in the harness.** Hard rule that held: nothing in the codebase
  knows a specific app (the one hardcoded APP_HOME table was a bug and got replaced by
  the appmap's `home` declaration). App knowledge lives in generated artifacts.
- **Vision in the task loop is possibly optional** — n=2-3, but the screenshot bought
  nothing measurable on navigational tasks (~11% of input tokens per call; AX text
  carries role/label/value and verification greps text anyway). KEEP vision in explore
  (built once, aimed at surfaces AX can't describe) and in the visual judge. Re-measure
  before deciding; that's part of the pending A/B work.
- **Canvas heroics, mostly.** We proved painted targets are drivable: drags actuate
  (with real caveats: an app that draws an indicator at the press point breaks "drag it
  back" — use app undo, after clicking into the canvas to focus it), the model locates
  painted targets well (worst error 7px, within hit radius — but CLAMP images to 1568px:
  above that the API resamples server-side and coordinates come back in a frame neither
  side owns, 1.7–2× off, not by a consistent ratio), and geometry verification catches
  re-layout. But `done(success)` can never be text-proven on a painted-only target —
  the harness must say so explicitly, or the model retries the drag forever. Decide
  per-product whether canvas targets are in scope before building any of this.
- **A native (SwiftUI) shell.** Sized twice, rejected twice: Electron is Yarn's actual
  deployment target and the driver ecosystem has first-party Electron support. Only
  revisit if the deliverable becomes signed-app-quality live capture.
- **Recipe compilation — now BUILT (`src/core/recipe.ts`, `replay.ts`, `recipe-cli.ts`);
  copy the design, not just the idea.** Grounding-time thinking → deterministic replay
  with the model only as exception handler; the live round trip (cdp Wikipedia run →
  compile → replay) passed with 0 model calls. The load-bearing decisions:
  - **Compile only from verified evidence.** The compiler refuses failed runs, unverified
    steps, pixel-only steps, and `--hinted` runs (compiling one launders the hint into a
    clean-looking recipe). A recipe asserts effects; an unverified step observed none.
  - **Strip volatile handles, keep stable descriptors.** `element_index`/`ref` are
    per-observation walk orders; each step re-resolves by (name → surface → role),
    narrowing progressively, and **ambiguity is an error, never a guess** — two same-named
    controls are the dual-scope trap again, now with no model watching.
  - **A recipe is not a trusted macro.** Every replayed step is gated by the same
    `verify()` as a live run — recorded expectation, fresh haystack, discrimination
    baseline — and the recipe's final evidence is checked against a fresh last
    observation. Skipping the checks because "it worked when recorded" is how drift
    ships broken demos.
  - **Rescue is bounded and harness-checked.** A broken step gets one mini-loop
    (default 3 actions) whose success check is the RECIPE's expectation — teardown's
    trick: the model cannot widen a check it didn't write. Unattended fleet mode runs
    with rescue off; a drifted app fails honestly and gets re-recorded.
  - Replays journal mutations and run teardown like any run; waits are dropped at
    compile (pacing is the replayer's, not one afternoon's slow render).

---

## 10. Where to look in this repo

| What | Where |
|---|---|
| Agent loop, evidence gates, done-grading | `src/core/agent.ts` (~1550 lines; system prompt is the top ~150) |
| `verify()`, `auditTaskPrompt()`, scope warnings, observe/projection | `src/core/harness.ts` (~2450 lines) |
| CDP backend + its rationale | `src/backends/cdp.ts` header |
| cua boundary (the whole thing) | `src/core/driver.ts` (196 lines) |
| Explore: frontier, dismissal, salvage, descent, home | `src/core/explore.ts` |
| Journal/teardown/cleanup | `src/core/journal.ts`, `src/core/teardown.ts`, `src/core/cleanup.ts` |
| Recipe replay: format, compiler, resolution, engine, rescue | `src/core/recipe.ts`, `src/core/replay.ts`, `src/core/recipe-cli.ts` |
| Humanize: track building, motion fitting, rendering | `src/cursor/humanize.ts`, `src/cursor/track.ts`, `src/cursor/render.ts`, `scripts/fit-motion.py` |
| Fleet: ssh, lease, jobs, profiles, provision | `src/remote/control/`, `src/remote/runner/` |
| Everything that constrains the agent, with severity | `LIMITATIONS.md` |
| Driver quirk catalogue | `docs/cua.md` |
| The actuator decision, argued | `docs/research/2026-07-30-cua-learnings-for-real-implementation.md` + `...cua-dependency-audit.md` |
| Wrong-scope finding, full data | `docs/research/2026-07-29-yarn-poc-findings.md` (read the correction note first) |

The meta-lesson, which is also the repo's most expensive lesson: **every rule enforced
by memory was violated within a day; every rule moved into code held.** Prompt hygiene,
evidence grammar, provenance stamps, log writing, destructive guards — all of them are
code because each was broken at least once as a convention. Start the real
implementation where that ended.

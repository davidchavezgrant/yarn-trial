# Architecture — yarn-trial self-driving demo agent

Decisions and their reasoning, in dependency order. Each has a "revisit if" so we know
when a decision has expired rather than treating it as doctrine. Context: NL task →
verified UI actions on a Mac app, recorded; runs on Yarn's machines (or a Yarn-controlled
VM), not interactively on a customer's. Full brief: `docs/jasper-email-yarn-trial-brief.md`.

## 1. One actuator seam, three backends

`src/core/driver.ts` is the only module that imports `@trycua/cua-driver`. Everything else
speaks Observation/ActionRequest. The driver is UniFFI bindings over a sealed Rust core —
we treat it as a peripheral we might swap, not a framework we build inside.

The swap has since happened without a fork: three backends live behind the seam.
`--backend ax` (default — cua driving the AX tree), `--backend dom` (cua's `browser_*`
tools over CDP), and `--backend cdp` (`src/backends/cdp.ts`: playwright-core attaching over
`--remote-debugging-port`, **no cua in the loop at all** — no 300s session TTL, no shared
daemon, no consent gate, no node budget; those four absences are its reason to exist).
Explore, teardown, the cleanup CLI and the trajectory feed all run on cdp too.

**Revisit if**: we fork the driver (see §5's exit path), or the cdp backend proves out on
Electron targets broadly enough to retire the others there.

## 2. Observe → act → verify loop, with verification as a gate

The agent loop (`src/core/agent.ts`) forces the model to declare an expectation before every
action, then greps a fresh observation for it. Three layers, deliberately different in
cost and authority:

1. **Text check** (per step, deterministic, authoritative) — `verify()` greps AX
   labels/values. Expectations must be checkable and *discriminating* (satisfied only
   after the action, not before). Vacuous expectations are rejected unexecuted.
2. **Pixel delta** (per step, deterministic, advisory) — fraction of pixels changed since
   last observation. Exists because rendered content (canvas) is invisible to AX; "the
   screen never repainted" is otherwise undetectable. Never fails a run alone.
3. **Visual judge** (once, at `done`, advisory by default) — a separate model call sees
   the task, the agent's *claim*, and the final frame; returns PASS/FAIL/UNPROVEN.
   Non-obvious: the judge must get the claim, not just the task — given only a vague
   task it passed a known-wrong-scope frame. `VISUAL_JUDGE=block` upgrades FAIL to a
   rejection.

Why layered rather than one strong check: text is cheap and authoritative but blind to
pixels; vision sees pixels but is a model opinion. Cheap-deterministic gates, expensive-
probabilistic advises.

## 3. Measurement rule: goal-only prompts, enforced in code

Task prompts state the GOAL only; method knowledge lives in appmaps (a declared,
budgeted input). `auditTaskPrompt()` (`src/core/harness.ts`) rejects hinted prompts;
`--hinted` opts in and stamps the run log. This is enforced in code because it was
violated twice on 2026-07-29 while enforced by memory. Corollary: run logs are written
only by the harness, never hand-copied; stamped appmaps are never hand-edited (curated
knowledge goes in `docs/recipes/`, a *different* declared input, `USE_RECIPE=1`).

**Revisit if**: never. This one is doctrine (set by David, 2026-07-29).

## 4. Grounding as a pipeline stage: explore → appmap → agent

`npm run explore` produces two artifacts per app: prose (`docs/appmaps/<app>.md`,
injected into the system prompt) and a graph (`<app>.json`, queried by code, not read by
the model). Measured value (2 samples/condition, all verification holes closed):
grounded runs use ≈2–2.5× fewer actions/tokens, and — more importantly — grounding buys
**correctness**: on dual-scope settings (global default vs per-document override) all
ungrounded runs picked the wrong scope. `findScopeAmbiguities()`/`scopeWarnings()` turn
the graph into prompt warnings (10 collisions on the current Yarn map — re-measure after
any pass rather than quoting this). A pass now runs until the frontier of un-operated
controls empties (no step budget, no time cap; `EXPLORE_DISMISS_CAP` keeps bulk dismissal
honest), salvages its map from the transcript if the driver dies, and declares the app's
`home` state for run resets. A finished Yarn pass measured 40 min / 96 actions — ~2.8% of
Jasper's ~24h/app budget (the old "~5–6 min" figure measured a budget-truncated pass).

**Revisit if**: exploration stops paying for itself on some app class, or recipe
compilation (below) subsumes it.

## 5. DOM enrichment via a native Swift sidecar (challenged and upheld 2026-07-29)

The driver projects each element to role/label/value/frame, so unlabeled icon buttons
arrive as `AXButton ""` — anonymous. Chromium's Mac AX bridge exposes the source DOM
node's id/class (`AXDOMIdentifier`/`AXDOMClassList`) plus help/description/placeholder/
URL; nobody reads them. `native/axdom` (120 lines of Swift, compiled, gitignored) walks
the same tree, emits those as JSONL keyed by frame geometry, and `src/core/axdom.ts` joins
them onto the driver's elements. Measured on Yarn: 955/1044 anonymous nodes named,
incl. 37/64 anonymous *interactive* controls.

Why this shape and not something else:
- **Native must exist somewhere**: the attributes live behind the Accessibility C API,
  which Node cannot call. The driver's Rust projection is a sealed published binary.
  FFI packages (koffi etc.) are still a native addon, with manual CF memory management
  in-process. A driver fork is the "right" fix but heavier than a trial warrants.
- **Separate process = hang isolation**: AX calls block synchronously on the target app;
  a wedged app costs a killed subprocess at a 4s timeout, not a frozen agent.
- **Distribution is fine**: CLT is needed only to *build*; the compiled binary runs on
  any Mac (Swift runtime ships with the OS since 10.14.4) and would ride inside a signed
  app bundle if this ever ships client-side.
- **Known limits**: does NOT cover canvas-rendered content (no DOM — that's layers 2–3
  in §2); 27/64 interactive controls have no DOM id/class either and stay anonymous;
  it is a second walk joined by a geometry heuristic — inherent redundancy.
- Every failure path (unbuilt, `AXDOM=0`, native AppKit app) degrades silently to the
  bare AX view; the run log records why.

**Exit path**: upstream the attribute passthrough into cua-driver, then delete `native/`
and the frame-join outright. Full rationale in the `src/core/axdom.ts` header.

## 6. Reliability and feel are decoupled (Jasper, 2026-07-28)

Yarn composites a synthetic cursor over recordings in post and has an Auto Time system
that erases inter-action latency. Consequences we build on:
- The agent optimizes for **robotic verified correctness**; humanlike motion is a
  render-time problem, fed by our StepRecords + action.json (click point + ISO timestamp
  per action, target role/rect). On the cdp backend the harness writes the same feed
  itself (`TrajectoryWriter`).
- We now prove the feed is sufficient by rendering it: `npm run humanize -- <stamp>`
  (`src/cursor/humanize.ts`/`track.ts`/`render.ts`) draws a human-feeling cursor over the
  recording — motion fitted to Yarn's *post-spring-filter* cursor corpus (fitting raw
  input data was measurably wrong), replayed human segments over synthesis, typing
  synthesized from the raw corpus's inter-key timing. Renders surface in the gallery.
- Model thinking gaps (~10s) are not a UX cost. Latency is off the frontier; of the
  original three caveats (one app, AX flakiness, latency), only the first two are real.
- Element roles in observations give pointer-type switching for free (AXTextField →
  I-beam).

## 7. Demonstrate by doing, with an irreversibility carve-out

"Show me how to X" means PERFORM X end-to-end and leave the app changed — the
deliverable is a demo video, so narrating without touching is a failed run. Unspecified
values are the agent's to choose (and state). Changes must be committed and confirmed to
survive. **Carve-out**: irreversible/externally-visible actions (delete, publish, send,
purchase) go up to the final confirmation and STOP, saying so. Verified: the delete-a-
draft run opens the menu showing Delete and never clicks (12 drafts before, 12 after).

## 8. POC priority: prove self-driving, defer productionization (David, 2026-07-29)

Foreground delivery and taking over the machine are fine; occlusion, window-scoped
capture, multitasking purity are out of scope. The POC may run on a Yarn-controlled VM,
mooting intrusiveness. Effort goes to: multi-step task reliability on the real target
app, and being able to see it happen. Canonical measurement target: **Yarn app**,
canonical task: **"show me how to change the cursor type"**.

**Deferred, with rationale on file**: native-AppKit generalization (out of scope per
David 2026-07-30 — focus on Electron; two probes ran anyway: Calculator succeeded,
Hex Fiend failed on activation policy —
`docs/research/2026-07-30-native-mac-apps-investigation.md`). Recipe compilation was
deferred here until 2026-07-31; it is now built — §8a.

## 8a. Recipe replay: thinking paid once, checking never skipped (2026-07-31)

`compileRecipe()` (`src/core/recipe.ts`) freezes a SUCCESSFUL run log into a replayable
sequence; `replayRecipe()` (`src/core/replay.ts`) re-runs it with zero model calls on
the happy path. The decisions that hold it together:

- **Compile only from verified evidence.** Failed runs, unverified steps, pixel-only
  steps and `--hinted` runs are refused — a recipe asserts effects, and compiling a
  hinted run would launder the hint into a clean-looking artifact.
- **Volatile handles are stripped; identity is (name, surface, role).** Element indices
  and CDP refs are per-observation walk orders. Each step re-resolves against a fresh
  observation, narrowing progressively; **ambiguity is an error, never a guess** — two
  same-named controls are the §4 dual-scope trap with no model watching.
- **A recipe is not a trusted macro.** Every replayed step is gated by the same
  `verify()` as a live run (recorded expectation, fresh haystack, discrimination
  baseline), and the recipe's final evidence is re-checked against a fresh last
  observation. Replays journal mutations and run teardown like any run.
- **The model is the exception handler, bounded and harness-checked.** A broken step
  gets one rescue mini-loop (RECIPE_RESCUE_STEPS, default 3) whose success check is the
  RECIPE's expectation — teardown's pattern: the model cannot widen a check it did not
  write. `--no-rescue` is the unattended default posture: a drifted app fails honestly
  and gets re-recorded.
- Compiled recipes live in `docs/recipes/*.recipe.json` — machine output, stamped with
  `compiledFrom` + the source run's grounding tier; the never-hand-edit rule applies.

Verified live 2026-07-31: a cdp Wikipedia run (2/2 text-verified) compiled and replayed
end-to-end — 2/2 steps, final goal check PASSED, 0 model calls.

**Revisit if**: replay failure rates on real drift show the rescue budget is wrong in
either direction, or recipes need parameterization (today a recipe replays its recorded
values verbatim; "search for X" with a different X is a new recording).

## 9. Web targets are a target KIND, not a specially-named app (2026-07-30)

`Target = {kind:"app",name} | {kind:"web",url,origin}` (`src/core/target.ts`) replaces the bare
app-name string. Web artifacts key on the origin (`docs/appmaps/web-www.notion.so.md`) while
`appSlug` keeps its exact prior behaviour for Mac apps, so no existing appmap, run log or job
id moves. `--url` is value-bearing and consumed by `parseTarget` before positionals are read.

**Three backends work on web, and they need different things:**
- **CDP-direct** (`--backend cdp`) — playwright-core, no cua: launches its own Chrome with a
  persistent profile (sign-ins survive between runs), `ariaSnapshot` returns the whole tree,
  no consent token. The strongest path for web targets.
- **DOM** (`--backend dom`, explore's default for web) — cua's `browser_*` tools; snapshots
  the page, so browser chrome never enters the frontier. Requires `browser_prepare`, which
  needs a per-call approval token minted under a pty (`mintApprovalToken`; LIMITATIONS §13).
- **AX** (`--backend ax`, agent's default for every target — pass `--backend` explicitly for
  web runs) — reads the window, needs no CDP and no token. Browser chrome is excluded by an
  `AXWebArea` subtree filter (`observe(..., {webAreaOnly})`).

What the URL buys beyond reachability: it is a verification channel a native app has no
equivalent of — navigation changes it, so a route check is discriminating by construction,
which is exactly what `verify()` demands.

## 10. Cleanup: the run puts the app back (2026-07-30)

A run used to be a one-way mutation; on a fleet, a job that dirties its host poisons
whatever runs there next. Three mechanical layers (`src/core/journal.ts`, `src/core/teardown.ts`,
`src/core/cleanup.ts`): a journal that diffs control VALUES across observations (what actually
changed, never the model's account; matched by (name, surface), never by handle; appended
the instant detected, so crashes are recoverable), a teardown that replays it in reverse
with harness-written checks against the named control's own value (not a haystack grep),
and a standalone CLI for the SIGKILL case. Ordering is load-bearing: teardown runs AFTER
the recording is assembled, so the video ends on the changed state. `CLEANUP=advisory`
(default) | `block` | `off` — task success and app tidiness are different questions.
Created resources go through the `claim` tool and are reported, not deleted.

## 11. The fleet: TCC shapes everything (2026-07-30)

Three colo Macs (`hosts.json`, pinned by host KEY, not address), driven from operators'
laptops via `./run` verbs (enroll/provision/dispatch/install/signin/doctor/liveview).
Load-bearing decisions:
- **The runner is the Electron app itself** (`--serve`, LaunchAgent in `gui/<uid>`):
  macOS attributes Accessibility/Screen Recording to the responsible process and children
  inherit them — an SSH-spawned run gets an empty AX tree and a black screenshot with NO
  error. Every run must descend from the grant-holding process (LIMITATIONS §12).
- **`src/remote/control/ssh.ts` is the only ssh builder**; variable data crosses as base64 specs,
  never argv text (sshd joins remote args into one login-shell string).
- **One run per Mac**, enforced by a liveness-based lease (`src/remote/runner/lease.ts`) — cua's
  shared-daemon shutdown makes a second session fatal to the first (LIMITATIONS §6).
- **A busy Mac queues instead of refusing** (2026-07-31): submits land as durable `queued`
  records in the job registry and the runner drains them oldest-first through the same
  swap→spawn path when the lease frees (`drain()` in `src/remote/runner/serve.ts`). The queue
  survives runner restarts because it IS the registry. `dispatch auto` still walks idle hosts
  first and only queues (shortest line) when nobody is idle; the fleet panel shows each
  waiting job with a cancel button, and following a queued job streams from its first line
  once it starts. Cancelling a queued job is `stop` with its jobId — no child exists yet, so
  it is a pure registry write.
- **Sign-in is human, once per app per Mac** (`./run signin` full-desktop screen share, or
  `./run liveview` window-scoped SCK capture + input injection in a browser tab). No
  credential ever enters the agent loop — every observation and frame reaches the model
  and the recording.
- **Per-operator profile swap** (`src/remote/runner/profiles.ts`) so shared Macs don't share
  sessions; swaps serialize, and the app quits first (Electron rewrites its cookie jar on
  quit).
- **Paths resolve from the install, not cwd** (`src/paths.ts`, DATA vs RESOURCES roots): a
  LaunchAgent and a packaged .app both start at `/`, and everything "works" while writing
  to `/out` and silently running ungrounded.

## 12. One shell, Electron, with the page held at arm's length

`./run` launches an Electron app (`electron/main.ts`) that renders markup and script from
`src/ui/ui-page.ts` against host logic in `src/ui/ui-core.ts`. Electron rather than a native app
or a browser page: Yarn's product *is* Electron, the driver has first-party support for
that host, and a signed bundle escapes the ScreenCaptureKit limit that pins recording at
~4fps today (`docs/research/2026-07-29-packaging-native-vs-electron.md`). A browser-based
shell existed earlier and was dropped — two transports for one UI was not worth the
maintenance.

The page reaches its host **only** through `window.__bus`, injected by the main process.
That seam survives the second shell it was built for because it is what keeps the renderer
free of Electron imports, and therefore testable in plain Node.

Per-app UI state (the typed task and the log scrollback) persists to `out/ui-state.json`
via IPC rather than `localStorage`: the renderer loads from a `data:` URL, which has an
opaque origin and no storage. Log lines are attributed to the app that is *running*, not
the app currently selected, so switching targets mid-run cannot splice one run's output
into another app's terminal.

The shell hosts **one run per HOST, not one per shell** (relaxed 2026-07-31): a local run
and runs on two colo Macs coexist, each behind its own controller; `RunController` still
refuses a second run on the same machine, per LIMITATIONS §6.

**Revisit if**: we package for distribution (signing/notarization is not done).

# Architecture — yarn-trial self-driving demo agent

Decisions and their reasoning, in dependency order. Each has a "revisit if" so we know
when a decision has expired rather than treating it as doctrine. Context: NL task →
verified UI actions on a Mac app, recorded; runs on Yarn's machines (or a Yarn-controlled
VM), not interactively on a customer's. Full brief: `docs/jasper-email-yarn-trial-brief.md`.

## 1. One driver boundary

`src/driver.ts` is the only module that imports `@trycua/cua-driver`. Everything else
speaks Observation/ActionRequest. The driver is UniFFI bindings over a sealed Rust core —
we treat it as a peripheral we might swap, not a framework we build inside.

**Revisit if**: we fork the driver (see §4's exit path), at which point the boundary is
where the fork's new capabilities surface.

## 2. Observe → act → verify loop, with verification as a gate

The agent loop (`src/agent.ts`) forces the model to declare an expectation before every
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
budgeted input). `auditTaskPrompt()` (`src/harness.ts`) rejects hinted prompts;
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
the graph into prompt warnings (16 collisions caught on Yarn). Exploration costs ~5–6
min/app against Jasper's ~24h/app budget.

**Revisit if**: exploration stops paying for itself on some app class, or recipe
compilation (below) subsumes it.

## 5. DOM enrichment via a native Swift sidecar (challenged and upheld 2026-07-29)

The driver projects each element to role/label/value/frame, so unlabeled icon buttons
arrive as `AXButton ""` — anonymous. Chromium's Mac AX bridge exposes the source DOM
node's id/class (`AXDOMIdentifier`/`AXDOMClassList`) plus help/description/placeholder/
URL; nobody reads them. `native/axdom` (120 lines of Swift, compiled, gitignored) walks
the same tree, emits those as JSONL keyed by frame geometry, and `src/axdom.ts` joins
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
and the frame-join outright. Full rationale in the `src/axdom.ts` header.

## 6. Reliability and feel are decoupled (Jasper, 2026-07-28)

Yarn composites a synthetic cursor over recordings in post and has an Auto Time system
that erases inter-action latency. Consequences we build on:
- The agent optimizes for **robotic verified correctness**; humanlike motion is Yarn's
  render-time problem, fed by our StepRecords + action.json (click point + ISO timestamp
  per action) — already the exact data their renderer needs.
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

**Deferred, with rationale on file**: recipe compilation (grounding-time thinking →
replayable deterministic sequences, model as exception handler — justified by cost +
determinism now that latency is moot); CDP for Electron targets (`src/dom.ts` started —
needs a debug port we can't assume, and §5 closed most of the gap); native-AppKit
generalization (both proven apps are Electron; the "arbitrary Mac apps" claim is
untested).

## 9. One shell, Electron, with the page held at arm's length

`./run` launches an Electron app (`electron/main.ts`) that renders markup and script from
`src/ui-page.ts` against host logic in `src/ui-core.ts`. Electron rather than a native app
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

**Revisit if**: we package for distribution (signing/notarization is not done), or the
shell needs to host more than one concurrent run — today `RunController` refuses a second,
per LIMITATIONS §6.

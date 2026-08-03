# Self-driving demo agent — overview

Prototype: a natural-language task → verified UI actions on a Mac app or website,
recorded. Setup instructions live in `README.md`; this file is what the prototype does
and what it's worth.

> "Show me how to change my timezone to Paris" → the agent performs the change in
> Notion Calendar, verifying every step, and records a window-scoped video of itself.

## How it works

```
NL task
  ▼
Agent loop (azure/gpt-5.6-sol over Azure Responses; claude-fable-5 direct)  src/core/agent/
  observe: AX elements (+ DOM id/class via native/axdom) + window screenshot
  decide:  ONE action + a checkable expectation (tool use)
  act:     via the actuator backend
  verify:  re-observe, check expectation, feed verdict back
  stop:    success | "stalled" (8 unverified steps) | "step-ceiling" (100, a backstop)
  ▼
Actuator seam (Observation/ActionRequest) — two backends:
  --backend cdp  (default)  src/backends/cdp.ts → playwright-core, NO cua in the loop
  --backend ax              src/backends/ax.ts → @trycua/cua-driver → AX actions;
                            primary for native Mac apps, automatic fallback when an
                            Electron target's debug port never comes up
  SNAP_PX=24|48 (opt-in)    src/core/agent/step.ts — before actuating a coordinate
                            action, re-address it by handle to the nearest interactive
                            control within tolerance
```

`src/core/agent.ts` is now a 13-line **entry point** over `src/core/agent/` (the path is
load-bearing — everything spawns `tsx src/core/agent.ts`); the loop itself is
`src/core/agent/run.ts`. `src/core/harness.ts` is likewise a barrel over
`src/core/harness/`, where model and transport resolution is `model.ts` and `verify()` /
`auditTaskPrompt()` are `verification.ts`. Import the submodule from outside core — the
barrel drags in the Anthropic SDK and the cua driver.

Design decisions and their reasoning live in `docs/architecture.md`.

- **Verification is first-class**, in four layers of decreasing authority:
  1. *Text* (per step, deterministic, gates the run) — the expectation must be checkable
     and *discriminating*, i.e. satisfied only after the action. An act call with nothing
     checkable is rejected without being executed.
  2. *Pixel delta* (per step, deterministic, advisory) — fraction of pixels changed since
     the last observation, because canvas content is invisible to AX.
  3. *Visual judge* (once, at `done`, advisory) — a separate model call sees the task, the
     agent's claim, and the final frame. `VISUAL_JUDGE=block` makes a FAIL reject success.
  4. *Offline run judge* (post-hoc, advisory) — `npm run judge -- <stamp>` re-grades a
     completed run in one adversarial model call: full step trajectory + step frames (when
     per-run) + the appmap's scope ambiguities as rubric. Grades against the TASK, not the
     claim, so a run that accurately reports doing the wrong thing still fails. Writes
     `out/bench/live/<stamp>/judge.json`; never touches the run log.

  Every step is logged to `out/bench/live/<stamp>-<app>/run.json` (action, expectation, verdict,
  pixel delta, screenshot). Known gap: text checks prove *a* control holds the value, not
  that it is the *intended* one — see LIMITATIONS §8; layer 4 exists to catch exactly that
  class after the fact (validated on the known wrong-scope runs).
- **The run puts the app back.** Every mutation is journaled as it is detected (a diff of
  control values across observations — never the model's own account), and after the
  recording is assembled, teardown replays the journal in reverse with harness-written
  checks. `CLEANUP=advisory` (default) reports what is still dirty; `block` fails a dirty
  exit; `off` is for filming. A killed run's journal replays later via
  `npm run cleanup -- <stamp>`. Created resources go through the `claim` tool and are
  reported, not deleted.
- **DOM enrichment without CDP.** `native/axdom` (Swift, `npm run build:native`) recovers
  the DOM id/class Chromium drops from its AX tree, naming 955 of 1044 anonymous Yarn
  nodes. Optional: unbuilt or `AXDOM=0` degrades silently to the bare AX view.
- **A run ends exactly three ways**, and the log names which in `stopReason` so the three
  are never conflated: success (the model called `done` and `gradeDone` accepted the
  evidence); `"stalled"` — `AGENT_STALL_STEPS` (default **8**) consecutive steps verified
  nothing, the only mechanical reading of "it truly cannot proceed"; `"step-ceiling"` — the
  `AGENT_STEPS` (default **100**) runaway backstop. **The 100 is a backstop, not a budget**:
  a run must never fail because it ran out of steps, and a test refuses any arm that pins
  `steps` below it (`stallSteps` is the knob for a route with a long unverified stretch). The
  stall counter resets on a *verified* step and nothing else — not a successful driver call,
  not moved pixels, not the model's own account of progress. A 15-step operating limit used
  to be the third exit and silently became a verdict: seven runs stopped at exactly 15 and
  were recorded as the agent giving up, on a flow whose only known-good run takes 19.
- **Pixel snap** (`SNAP_PX`, off by default; unset it changes no behaviour). A vision-only
  step addresses by screenshot pixel, so the model's point is treated as a *hypothesis*: if
  it lands within tolerance of an interactive control, the action is re-addressed to that
  control by handle, falling through to the raw coordinate when nothing is in range.
  Measured at 24 and 48px. The diagnostic (`snapName`, `snapDistancePx`,
  `snapMatchesDeclared`) is recorded whether or not the stage is on, because it splits
  vision-only failure into two classes with opposite remedies: the point missed the control
  the model named (spatial — refinable) versus landed on it exactly and still failed
  (semantic — not). A snapped arm is deliberately an **upper bound**. Vetoing the rewrite
  when the snapped control disagrees with the declared one was considered and rejected — a
  veto measures the harness's veto rate rather than vision-only actuation — so the confound
  is recorded per step instead of gated away.
- **Grounding** comes in three tiers, kept in separate directories so that measuring one
  doesn't quietly measure another. `USE_CURATED` and `USE_RECIPES` each REPLACE the appmap
  rather than adding to it, and the run log records which tier actually loaded:
  - `docs/appmaps/<app>.md` — output of the autonomous exploration pass
    (`src/core/explore.ts`), stamped with a provenance header. Runs until the frontier of
    un-operated controls empties: measured **40 min / 96 actions** on Yarn (2026-07-30).
    The earlier "~5-6 min" figure measured a step-budget truncation, not a finished pass.
    Emits a prose map plus a `<app>.json` graph whose scope metadata drives the ambiguity
    warnings. Read `controls: N actuated / M dismissed / K seen` in the stamp, not the
    stop reason — `frontier-empty` is reachable by dismissing (`EXPLORE_DISMISS_CAP`
    bounds bulk dismissal; `EXPLORE_DESCENT=1` opts into harness-guarded descent behind
    destructive-looking controls — LIMITATIONS §15).
  - `docs/curated/<app>.md` — hand-curated notes (`USE_CURATED=1`). Not measurable as
    grounding: a human wrote it, and nothing audits grounding TEXT the way
    `auditTaskPrompt` audits the task string.
  - `docs/recipes/<slug>.<backend>.<hash>[.ungrounded].recipe.md` — **recipes**
    (`USE_RECIPES=1`, added 2026-08-01): task-level prose harvested from a run the
    offline judge PASSED — "here is the route that worked for this goal". The middle tier
    between a map (topology, task-agnostic) and a compiled procedure (a frozen click sequence
    that errors rather than adapts). Harvesting is offline (`./run recipes harvest`) so
    it never lands inside a measured run, and it refuses any run the judge did not pass —
    an agent that accurately describes doing the wrong thing must not teach that onward.
    Keyed by app, backend AND lineage: a recipe written by an agent that HAD a map is a
    different artifact from one written by an agent that had none, and only the second can
    speak to whether the exploration pass needs to exist.
  - `docs/procedures/<slug>.<hash>.procedure.json` — **compiled replay procedures** (machine
    output, stamped like appmaps — never hand-edit; re-record instead). Filmable since
    2026-08-01 (`./run procedure replay <stamp> --record`).

  The separation exists because it was violated: task-specific procedures had been hand-added
  to appmaps that "grounded" runs were then measured against, which inflated grounding's
  apparent value. See the correction note in
  `docs/research/2026-07-29-yarn-poc-findings.md`. Two consequences of that lesson are
  enforced in code — an unstamped file in a machine-output directory is treated as curated,
  and the appmap graph's scope warnings reach the prompt ONLY on the explore tiers, so the
  curated and recipe arms cannot silently inherit the sweep's most valuable output.
- **Window-scoped recording** (`--record`): polls the driver's window snapshots —
  which capture the target window's own content even when occluded or backgrounded —
  and assembles them into an mp4. The recording physically cannot contain anything but
  the target window. Malformed frames are filtered by majority vote on frame size plus
  a content check. **Not** on another Space: off-Space the capture fails outright, along
  with all perception (LIMITATIONS §1). On `--backend cdp` the recording is the page
  viewport via `page.screenshot()` instead — no staging, no Space interaction.
- **Cursor humanization** (`npm run humanize -- <stamp>`): the recording has no cursor in
  it (AX actuation never moves the physical pointer), so a post-pass draws one from the
  run's own trajectory data — click points, timestamps, target role/rect — with motion
  fitted to real human cursor recordings. Emits `motion-track.json` (the handoff format
  for Yarn's own renderer) plus `humanized.mp4`; renders surface in the shell's gallery.
- **Web targets** are first-class: `--url https://site.com` on both agent and explore,
  with appmaps keyed by origin (`docs/appmaps/web-<host>.*`) and one-time sign-in via
  `./run browser-login <url>` persisting in a named browser profile.
- **Procedure replay** (`./run procedure compile <stamp>` / `replay <file|stamp>`): a
  successful run's verified steps freeze into a replayable sequence — volatile element
  handles stripped, each step re-resolved by (name, surface, role) against a fresh
  observation and gated by the SAME `verify()` as a live run, with the recorded
  expectations. **Zero model calls on the happy path**; a broken step gets one bounded
  model rescue checked against the procedure's own expectation (`--no-rescue` for the
  unattended fleet default: a drifted app fails honestly). Compilation refuses failed,
  unverified, pixel-only, and `--hinted` runs. Verified live: a cdp Wikipedia run
  compiled and replayed 2/2 steps + final goal check with 0 model calls.

## Running it

Prereqs: macOS 15+, Node 22+, `ffmpeg` (assembly), `python3` with PIL (frame QC),
Accessibility + Screen Recording permissions for your terminal, and a model credential in
the environment: `AZURE_OPENAI_ENDPOINT` + `AZURE_OPENAI_API_KEY` for the default
`azure/gpt-5.6-sol`, or `ANTHROPIC_API_KEY` for `claude-fable-5`, or `OPENROUTER_API_KEY`
for the fallback.
Starting from a fresh clone, follow **`README.md`** — it covers the TCC grants and the
per-app grounding pass step by step.

```sh
./run doctor                         # preflight: keys, permissions, deps, appmaps
./run                                # packaged Electron app (the deployment target)
./run "show me how to change the cursor type" "Yarn" [--record]
./run explore "Yarn"                 # grounding pass -> docs/appmaps/
./run "search for Fritz Lang" --url https://www.wikipedia.org
./run help                           # everything else, incl. the fleet verbs
```

`./run` sources `.env`/`../yarn/.env`/`~/.yarn-runner/env`, refuses to start a second
concurrent run on this machine (LIMITATIONS §6), and rebuilds the Electron bundle only
when sources changed. The underlying npm scripts still work if you prefer them:

```sh
npm install
npm run build:native                 # Swift sidecars: axdom + liveview (needs Xcode CLT)
npm run probe "Yarn"                 # permissions + perception smoke test
npm run explore -- "Yarn"            # grounding pass -> docs/appmaps/
npm test                             # unit tests (~900 across harness, fleet, shell)
npm run agent -- "show me how to change the cursor type" "Yarn" --record
npm run humanize -- <stamp>          # human-feeling cursor render for a recorded run
npm run cleanup -- <stamp>           # replay a killed run's mutation journal
npm run procedure -- compile <stamp>    # freeze a successful run into a replayable procedure
npm run procedure -- replay <file>      # replay it — zero model calls unless a step breaks
npm run app                          # Electron shell
```

**The fleet.** Three colo Macs run demos unattended, dispatched from any operator's
laptop: `./run enroll` / `provision` / `dispatch` / `install` / `signin` / `liveview`
(`src/remote/control/`, `src/remote/runner/`). Each Mac runs the Electron shell headless (`--serve`, a
LaunchAgent) because macOS attributes TCC grants to the responsible process — a run
spawned over SSH perceives nothing, silently (LIMITATIONS §12). One run per Mac,
enforced by a lease; a human signs each app in once per Mac. The shell's fleet panel
shows each Mac's state, and the gallery tags recordings with the Mac they came from.

**The shell.** `src/ui/ui-core.ts` holds the local host logic (app list, per-machine run
guard, spawn, hygiene gate, per-app UI state in `out/ui-state.json`),
`src/ui/ui-remote.ts` the fleet dispatch, and `src/ui/ui-page.ts` the markup + browser script;
the page reaches its host only through `window.__bus`, which `electron/main.ts` binds to
ipcRenderer. Keeping that seam means the host is swappable and the page stays testable
without Electron. The shell hosts **one run per host** — a local run and runs on two
colo Macs coexist. Electron is what matters for shipping — Yarn's product is Electron,
the driver has first-party support for that host, and a signed bundle escapes the
ScreenCaptureKit limit that caps recording at ~4fps today. Packaging (electron-builder,
signing, notarization) is not done yet; see
`docs/research/2026-07-29-packaging-native-vs-electron.md`.

`AGENT_MODEL` overrides the model. `src/step.mts` is a manual step driver for debugging
individual interactions (hard-coded to Notion Calendar).

## Honest limitations

- Proven breadth: two Electron apps (Notion Calendar, Yarn) and web targets, all with
  zero harness changes. **`app.notion.com` is now a first-class second app**, not one more
  web fixture: it carries a full cdp mirror across a simple task and a complex one, and the
  stage-4 arms that run against it measure cross-*app* transfer rather than only cross-task
  — the one axis every earlier pass held fixed, which made every finding so far
  indistinguishable from a fact about Yarn's DOM. The honest ceiling on that parity is
  structural: half the matrix cannot be mirrored. A web target on the `ax` backend is a hard refusal in three
  places (`src/core/agent/run.ts`, `src/core/explore.ts`, `src/backends/ax.ts`), and the
  `axdom` sidecar reads a native window's pid, which a CDP page has no equivalent of. So
  Notion mirrors the cdp cells and nothing else; the ax/cdp comparison, the
  native-equivalent tier and the min-context floor are Yarn-only by construction. What
  parity exists is 152 Notion runs against Yarn's 116 cdp runs (Notion crosses two tasks
  where the config sweep crosses one) — not against Yarn's 231, 115 of which are ax/axdom.
  Notion **Calendar**, the desktop app, is cut for good: installed on none of the three
  colo Macs, so those arms were guaranteed refusals. Native AppKit: one pass (Calculator),
  one diagnosed fail (Hex Fiend — foreground delivery never makes a native app key/main),
  and out of scope for now.
- Sample sizes are small and deliberately uneven: **n=3** for a measured task arm, **n=2**
  for an explore arm and for the diagnostics pair, **n=1** for a filmed take and for a
  compile. Nothing runs at n=4. A take is a deliverable and a compile is a deterministic
  file transform, so repeating either measures nothing. None of this is a measured failure
  rate.
- **Roughly one run in three aborts** on AX flakiness (empty tree, focus loss, dead driver
  session; measured 2026-07-29 on the AX backend). Retries were clean every time, so it
  is a throughput cost rather than a capability limit — but it is the main obstacle to
  unattended operation, and it is why the CDP-direct backend exists (LIMITATIONS §10,
  §14).
- **Verification cannot tell which control it verified.** Yarn exposes 10 settings (on
  the current map) at both a brand-wide and a per-project scope; every ungrounded run
  changed the wrong one while passing its checks. Mitigated by appmap scope warnings and
  the visual judge, and detectable after the fact by the offline run judge (which flagged
  every known wrong-scope run from the trajectory alone) — not solved in-run
  (LIMITATIONS §8).
- Target app must be on the active macOS Space. Off-Space, Chromium suspends the
  whole app while every driver call still reports success (LIMITATIONS §1).
- Electron's AX tree goes intermittently dark under focus churn; the agent falls
  back to keyboard navigation, and the pixel/visual layers make the degradation visible
  rather than silently "verified". Still the reliability frontier on the AX path.
- ~10–25s of model thinking between actions — fine async, wrong for a human watching
  live. Procedure replay removes it for repeated tasks (zero model calls on the happy
  path); the first run of any task still pays it.
- Recording is ~4fps snapshot-based on the AX path; real 30fps *recording* still wants a
  signed app, though `native/liveview` shows live SCK window streaming works from our own
  runner-spawned code (LIMITATIONS §3, §16).
- Recording staging fills the window's *current* display and leaves native fullscreen
  alone. (An earlier claim that the driver miscomposites 1x displays did not reproduce
  when measured, so windows are no longer moved between monitors — LIMITATIONS §3.)

## Measurement discipline

Two ways this prototype was caught flattering itself, both now enforced in code rather
than by anyone remembering:

- **Task prompts state the goal only.** Two early takes had the *method* written into
  the prompt and were reported as autonomous runs. `auditTaskPrompt` (`src/core/harness.ts`)
  now refuses a prompt that names driver internals or dictates interaction mechanics;
  `--hinted` opts in and stamps the run log so a dictated run can't be mistaken for an
  honest one later.
- **An action the harness can't check doesn't run.** A run once reported "success in 3
  actions" with zero steps actually verified. Every `act` call now requires checkable
  substrings, and the final verdict says how many steps went unverified.

Numbers in `docs/research/` carry correction notes where a measurement turned out to be
contaminated. Read those before quoting a figure.

## Docs

- `docs/architecture.md` — design decisions, why each was made, and when to revisit
- `docs/product.md` — status assessment and open product questions (non-technical)
- `docs/research/` — driver quirks, verified sequences, and measured results
  (`2026-07-31-poc-gotchas-and-lessons.md` is the consolidated handoff writeup)
- `docs/appmaps/` — grounding notes produced by the exploration pass (machine, stamped)
- `docs/curated/` — hand-written grounding prose (a human wrote it; not a harvested
  **recipe**, which is a formal tier — see `docs/recipes/` below)
- `docs/procedures/` — compiled replay procedures
- `docs/recipes/` — task write-ups harvested from judged-PASS runs (machine, stamped)
- `LIMITATIONS.md` — running log of what constrains the agent in practice
- `README.md` — fresh-clone setup on a new machine

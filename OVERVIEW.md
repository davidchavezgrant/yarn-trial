# Self-driving demo agent — overview

Prototype: a natural-language task → verified UI actions on a Mac app, recorded.
Setup instructions live in `README.md`; this file is what the prototype does and what
it's worth.

> "Show me how to change my timezone to Paris" → the agent performs the change in
> Notion Calendar, verifying every step, and records a window-scoped video of itself.

## How it works

```
NL task
  ▼
Agent loop (Claude Opus 5)              src/agent.ts
  observe: AX elements (+ DOM id/class via native/axdom) + window screenshot
  decide:  ONE action + a checkable expectation (tool use)
  act:     via the driver boundary
  verify:  re-observe, check expectation, feed verdict back
  ▼
Driver boundary (Observation/ActionRequest)   src/driver.ts
  ▼
@trycua/cua-driver → target app (AX actions, pid-targeted input)
```

Design decisions and their reasoning live in `docs/architecture.md`.

- **Verification is first-class**, in three layers of decreasing authority:
  1. *Text* (per step, deterministic, gates the run) — the expectation must be checkable
     and *discriminating*, i.e. satisfied only after the action. An act call with nothing
     checkable is rejected without being executed.
  2. *Pixel delta* (per step, deterministic, advisory) — fraction of pixels changed since
     the last observation, because canvas content is invisible to AX.
  3. *Visual judge* (once, at `done`, advisory) — a separate model call sees the task, the
     agent's claim, and the final frame. `VISUAL_JUDGE=block` makes a FAIL reject success.

  Every step is logged to `out/runs/<stamp>-<app>.json` (action, expectation, verdict,
  pixel delta, screenshot). Known gap: text checks prove *a* control holds the value, not
  that it is the *intended* one — see LIMITATIONS §8.
- **DOM enrichment without CDP.** `native/axdom` (Swift, `npm run build:native`) recovers
  the DOM id/class Chromium drops from its AX tree, naming 955 of 1044 anonymous Yarn
  nodes. Optional: unbuilt or `AXDOM=0` degrades silently to the bare AX view.
- **Grounding** comes in two tiers, kept separate so that measuring one doesn't
  quietly measure the other:
  - `docs/appmaps/<app>.md` — output of the autonomous exploration pass
    (`src/explore.ts`), stamped with a provenance header. Measured ~5-6 min per app
    (Yarn 23 actions, Notion Calendar 20). Emits a prose map plus a `<app>.json` graph
    whose scope metadata drives the ambiguity warnings.
  - `docs/recipes/<app>.md` — hand-curated notes, including verified task recipes.

  Both are auto-loaded into the agent's prompt and the run log records which was used.
  The split exists because it was violated: task-specific recipes had been hand-added
  to appmaps that "grounded" runs were then measured against, which inflated grounding's
  apparent value. See the correction note in
  `docs/research/2026-07-29-yarn-poc-findings.md`.
- **Window-scoped recording** (`--record`): polls the driver's window snapshots —
  which capture the target window's own content even when occluded or backgrounded —
  and assembles them into an mp4. The recording physically cannot contain anything but
  the target window. Malformed frames are filtered by majority vote on frame size plus
  a content check. **Not** on another Space: off-Space the capture fails outright, along
  with all perception (LIMITATIONS §1).

## Running it

Prereqs: macOS 15+, Node 22+, `ffmpeg` (assembly), `python3` with PIL (frame QC),
Accessibility + Screen Recording permissions for your terminal, and either
`ANTHROPIC_API_KEY` or `OPENROUTER_API_KEY` in the environment.
Starting from a fresh clone, follow **`README.md`** — it covers the TCC grants and the
per-app grounding pass step by step.

```sh
./run doctor                         # preflight: keys, permissions, deps, appmaps
./run                                # packaged Electron app (the deployment target)
./run "show me how to change the cursor type" "Yarn" [--record]
./run explore "Yarn"                 # grounding pass -> docs/appmaps/
```

`./run` sources `.env`/`../yarn/.env`, refuses to start a second concurrent run
(LIMITATIONS §6), and rebuilds the Electron bundle only when sources changed. The
underlying npm scripts still work if you prefer them:

```sh
npm install
npm run build:native                 # optional: DOM enrichment sidecar (needs Xcode CLT)
npm run probe "Notion Calendar"      # permissions + perception smoke test
npm run explore -- "Notion Calendar" # grounding pass -> docs/appmaps/
npm test                             # harness unit tests (55)
npm run agent -- "Show me how to change my timezone to Paris" "Notion Calendar" --record
npm run app                          # Electron shell
```

**The shell.** `src/ui-core.ts` holds the host logic (app list, single-run guard, spawn,
hygiene gate, per-app UI state in `out/ui-state.json`) and `src/ui-page.ts` the markup +
browser script; the page reaches its host only through `window.__bus`, which
`electron/main.ts` binds to ipcRenderer. Keeping that seam means the host is swappable and
the page stays testable without Electron. Electron is what matters for shipping — Yarn's
product is Electron, the driver has first-party support for that host, and a signed bundle
escapes the ScreenCaptureKit limit that caps recording at ~4fps today. Packaging
(electron-builder, signing, notarization) is not done yet; see
`docs/research/2026-07-29-packaging-native-vs-electron.md`.

`AGENT_MODEL` overrides the model. `src/step.mts` is a manual step driver for
debugging individual interactions.

## Honest limitations

- Two apps tested (Notion Calendar, Yarn), **both Electron** — nothing here tests a
  native AppKit AX tree, so "arbitrary Mac apps" is unproven. Sample sizes are 2-4 runs
  per condition, not a measured failure rate.
- **Roughly one run in three aborts** on AX flakiness (empty tree, focus loss, dead driver
  session). Retries were clean every time, so it is a throughput cost rather than a
  capability limit — but it is the main obstacle to unattended operation (LIMITATIONS §10).
- **Verification cannot tell which control it verified.** Yarn exposes 16 settings at both
  a brand-wide and a per-project scope; every ungrounded run changed the wrong one while
  passing its checks. Mitigated by appmap scope warnings and the visual judge, not solved
  (LIMITATIONS §8).
- Target app must be on the active macOS Space. Off-Space, Chromium suspends the
  whole app while every driver call still reports success (LIMITATIONS §1).
- Electron's AX tree goes intermittently dark under focus churn; the agent falls
  back to keyboard navigation, and the pixel/visual layers make the degradation visible
  rather than silently "verified". Still the reliability frontier.
- ~10s of model thinking between actions — fine async, wrong for a human watching
  live. Caching grounded runs as replayable recipes is the obvious next step.
- Recording is ~4fps snapshot-based; real 30fps window capture needs a signed app
  (`tools/winrec.swift` documents the ScreenCaptureKit boundary for unsigned CLIs).
- Recording staging fills the window's *current* display and leaves native fullscreen
  alone. (An earlier claim that the driver miscomposites 1x displays did not reproduce
  when measured, so windows are no longer moved between monitors — LIMITATIONS §3.)

## Measurement discipline

Two ways this prototype was caught flattering itself, both now enforced in code rather
than by anyone remembering:

- **Task prompts state the goal only.** Two early takes had the *method* written into
  the prompt and were reported as autonomous runs. `auditTaskPrompt` (`src/harness.ts`)
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
- `docs/appmaps/` — grounding notes produced by the exploration pass
- `docs/recipes/` — hand-curated grounding notes
- `LIMITATIONS.md` — running log of what constrains the agent in practice
- `README.md` — fresh-clone setup on a new machine

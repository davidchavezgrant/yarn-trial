# yarn-trial — Current Approach Brief

> **Superseded 2026-08-03 — the title lies now.** This describes the ~900-line 2026-07-29 prototype,
> not the current system. The step budgets in particular are dead: the agent's "15-step cap" and
> explore's "25-step budget" are both gone. A run ends exactly three ways — success; `stalled`, after
> 8 consecutive steps that verify nothing (`AGENT_STALL_STEPS`); or `step-ceiling` at 100
> (`AGENT_STEPS`), a runaway backstop and never a budget, because a run must never fail for running
> out of steps. Explore has no step budget at all — a pass runs until the frontier of un-operated
> controls empties, with `EXPLORE_MAX_ACTIONS` (default 10,000) as a non-binding backstop. Read this
> as a snapshot of the approach at the time. Current: `docs/architecture.md`,
> `docs/research/2026-08-03-findings-summary.md`.

*2026-07-29 · codebase analysis of `~/Code/work/yarn-trial` (~900 lines TS across 6 modules)*

## ELI5

We built a robot that can use a Mac app the way a person does. You tell it in plain
English what you want ("change my timezone to Paris"), and it looks at the screen,
figures out what to click, clicks it, and then **checks that the click actually did
what it expected** before moving on. If something surprising happens, it notices and
recovers instead of blindly plowing ahead. It also records a video of just the app
window while it works — so the output is a clean demo recording of the task being done.

To make it reliable, we first send a "scout" through the app once. The scout pokes
around safely, writes down where everything lives ("the timezone setting is hidden in
the grid header, not in Settings"), and the real agent reads those notes before
starting — so it goes straight to the answer instead of wandering.

## Architecture

Four modules, one strict boundary:

```
NL task ──▶ agent.ts ── autonomous loop (Claude Opus 5, tool use)
              │   observe: AX elements + window screenshot
              │   decide:  ONE action + a checkable expectation
              │   act:     via the driver boundary
              │   verify:  re-observe, string-match expectation, feed verdict back
              ▼
            driver.ts ── the ONLY module importing @trycua/cua-driver;
              │           everything above speaks Observation/ActionRequest
              ▼
            cua-driver ──▶ target app (AX actions, pid/window-targeted input)
```

- **`src/harness.ts`** — shared plumbing: Anthropic client (OpenRouter or direct),
  window finding, observation building (filtered AX element list + screenshot +
  lowercase "haystack" for verification), the `act` tool schema, and `DRIVER_RULES`
  (hard-won driver quirks injected into every system prompt).
- **`src/agent.ts`** — the task loop (15-step cap, one action/turn), StepRecord
  logging to `out/runs/<stamp>-<app>.json`, and the `--record` pipeline.
- **`src/explore.ts`** — the grounding pass: same loop, different contract (25-step
  budget, absolute safety rules, `record`/`finish` tools) → `docs/appmaps/<app>.md`,
  auto-loaded into the agent's system prompt when present. Hand-curated notes live
  separately in `docs/curated/<app>.md` so exploration output stays uncontaminated;
  both tiers ground the agent and the run log records which was used.
- **`src/probe.ts`** — permissions/perception smoke test. **`src/step.mts`** — manual
  step driver for debugging.

## The three load-bearing ideas

1. **Verification is first-class.** Every `act` call must include an expectation
   (`textIncludes`/`textExcludes` substrings checked against the next observation's
   window title + element labels/values). The harness — not the model — computes the
   verdict and feeds PASS/FAIL back. This turns "the model thinks it clicked" into
   "the UI observably changed," and every step is auditable in the run log
   (action, expectation, verdict, screenshot, timestamp).

2. **Grounding as a separate, cacheable pass.** Exploration takes ~5-6 min (measured)
   and runs once per app. Clean re-measure: it roughly halves actions and tokens, and
   more importantly it fixes wrong-scope changes that otherwise pass verification. This maps directly onto Jasper's ~24h per-app onboarding budget, and it's the
   embryo of procedure compilation: thinking at grounding time, cheap execution at run time.

3. **Window-scoped recording that can't leak.** `--record` polls the driver's
   per-window snapshots (~4fps) — which capture the target window's own content even
   when occluded or backgrounded — and assembles an mp4 with real inter-frame timing.
   The recording *physically cannot* contain other windows (this matters: display-level
   capture leaked personal content in earlier testing). Malformed frames (an upstream
   compositing bug during Space/display transitions) are filtered by majority-vote on
   frame size plus a black-band content check.

## Why this fits Yarn's pipeline (from Jasper's 07-28 reply)

Yarn re-renders the cursor in post from real human mouse-movement data and
time-compresses demos ("Auto Time"). That decouples **reliability** (our robotic,
verified AX actions) from **feel** (their human motion synthesis) — and our StepRecords
plus the driver's trajectory output are already the exact data feed their renderer
needs: click points, ISO timestamps, and element roles (which give pointer-type
switching — AXTextField → I-beam — for free). The ~10s model-thinking gaps between
actions stop mattering because the rendered timeline is synthetic. Of the demo's three
original caveats (one app; AX flakiness; latency), **only the first two are real**.

## Proven vs. claimed

**Proven (2026-07-27):** timezone→Paris and back on Notion Calendar, autonomous,
grounded, 3–5 actions, zero dead ends; clean recorded deliverables in `out/`.

**Claimed, unproven:** generalization to arbitrary apps — one app tested.

**Known frontier:**
- Electron's AX tree goes intermittently dark under focus churn; the agent falls back
  to keyboard nav + screenshot verification, but this is the reliability ceiling today.
- Recording is ~4fps snapshot-based; true 30fps window capture needs a signed app
  (`tools/winrec.swift` documents the ScreenCaptureKit boundary).
- Verification is substring matching against AX text — sufficient so far, but it can't
  check visual-only state changes.

## Next steps (agreed direction)

1. **Second-app generalization test** — the biggest open claim.
2. **Procedure compilation** — grounding-time thinking → replayable deterministic
   sequences, model only as exception handler (justified by cost + determinism now,
   not latency).
3. **Driver `browser_*` CDP tools** for Electron targets — may beat AX for Yarn's own app.

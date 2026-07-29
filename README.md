# Self-driving demo agent

Prototype: a natural-language task → verified UI actions on a Mac app, recorded.

> "Show me how to change my timezone to Paris" → the agent performs the change in
> Notion Calendar, verifying every step, and records a window-scoped video of itself.

## How it works

```
NL task
  ▼
Agent loop (Claude Opus 5)              src/agent.ts
  observe: AX elements + window screenshot
  decide:  ONE action + a checkable expectation (tool use)
  act:     via the driver boundary
  verify:  re-observe, check expectation, feed verdict back
  ▼
Driver boundary (Observation/ActionRequest)   src/driver.ts
  ▼
@trycua/cua-driver → target app (AX actions, pid-targeted input)
```

- **Verification is first-class.** Every action carries an expectation the harness
  checks against the next observation; failures are fed back so the model recovers
  instead of repeating. Every step is logged to `out/runs/<stamp>-<app>.json` (action,
  expectation, verdict, screenshot).
- **Grounding** comes in two tiers, kept separate so that measuring one doesn't
  quietly measure the other:
  - `docs/appmaps/<app>.md` — output of the autonomous exploration pass
    (`src/explore.ts`), stamped with a provenance header. ~25 min per app.
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

```sh
npm install
npm run probe "Notion Calendar"      # permissions + perception smoke test
npm run explore -- "Notion Calendar" # grounding pass -> docs/appmaps/
npm test                             # prompt-hygiene guard tests
npm run agent -- "Show me how to change my timezone to Paris" "Notion Calendar" --record
```

`AGENT_MODEL` overrides the model. `src/step.mts` is a manual step driver for
debugging individual interactions.

## Honest limitations

- Two apps tested (Notion Calendar, Yarn) — generalization beyond them is claimed,
  not proven, and there is **no measured failure rate**: one run per condition.
- Target app must be on the active macOS Space. Off-Space, Chromium suspends the
  whole app while every driver call still reports success (LIMITATIONS §1).
- Electron's AX tree goes intermittently dark under focus churn; the agent falls
  back to keyboard navigation + screenshot verification, but this is the
  reliability frontier.
- ~10s of model thinking between actions — fine async, wrong for a human watching
  live. Caching grounded runs as replayable recipes is the obvious next step.
- Recording is ~4fps snapshot-based; real 30fps window capture needs a signed app
  (`tools/winrec.swift` documents the ScreenCaptureKit boundary for unsigned CLIs).
- The cua driver composites window snapshots incorrectly for windows on non-retina
  displays (upstream bug); `--record` stages the window onto the main display.

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

- `docs/product.md` — status assessment and open product questions (non-technical)
- `docs/research/` — driver quirks, verified sequences, and measured results
- `docs/appmaps/` — grounding notes produced by the exploration pass
- `docs/recipes/` — hand-curated grounding notes
- `LIMITATIONS.md` — running log of what constrains the agent in practice

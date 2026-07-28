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
  instead of repeating. Every step is logged to `out/agent-run.json` (action,
  expectation, verdict, screenshot).
- **Grounding** (`src/explore.ts`): a one-time, safety-constrained exploration pass
  writes app notes to `docs/appmaps/<app>.md`, auto-loaded into the agent's prompt.
  On Notion Calendar this took ~25 minutes and cut the demo task from 5 actions to 3
  with zero dead ends.
- **Window-scoped recording** (`--record`): polls the driver's window snapshots —
  which capture the target window's own content even when occluded, backgrounded, or
  on another Space — and assembles them into an mp4. The recording physically cannot
  contain anything but the target window. Malformed frames are filtered by majority
  vote on frame size plus a content check.

## Running it

Prereqs: macOS 15+, Node 22+, `ffmpeg` (assembly), `python3` with PIL (frame QC),
Accessibility + Screen Recording permissions for your terminal, and either
`ANTHROPIC_API_KEY` or `OPENROUTER_API_KEY` in the environment.

```sh
npm install
npm run probe "Notion Calendar"      # permissions + perception smoke test
npm run explore -- "Notion Calendar" # grounding pass -> docs/appmaps/
npm run agent -- "Show me how to change my timezone to Paris" "Notion Calendar" --record
```

`AGENT_MODEL` overrides the model. `src/step.mts` is a manual step driver for
debugging individual interactions.

## Honest limitations

- One app tested so far — generalization is claimed, not proven.
- Electron's AX tree goes intermittently dark under focus churn; the agent falls
  back to keyboard navigation + screenshot verification, but this is the
  reliability frontier.
- ~10s of model thinking between actions — fine async, wrong for a human watching
  live. Caching grounded runs as replayable recipes is the obvious next step.
- Recording is ~4fps snapshot-based; real 30fps window capture needs a signed app
  (`tools/winrec.swift` documents the ScreenCaptureKit boundary for unsigned CLIs).
- The cua driver composites window snapshots incorrectly for windows on non-retina
  displays (upstream bug); `--record` stages the window onto the main display.

## Docs

- `docs/research/` — driver quirks and verified interaction sequences
- `docs/appmaps/` — grounding notes produced by the exploration pass

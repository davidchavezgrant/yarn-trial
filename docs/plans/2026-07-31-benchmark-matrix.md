# Benchmark matrix: backends × grounding × recipes (settled 2026-07-31)

**Status**: approved shape; NO runs fire without David's explicit go, phase by phase.
**Target**: Electron only — the Yarn app. Canonical task: "show me how to change the
cursor type". Optional second task: the Auto Time sync example.
**Fleet**: mac1/mac2/mac3, dispatched through the job queue (submit everything, let it drain).
**Prompts**: goal-only, always. `auditTaskPrompt` stays the gate; no arm ever gets a hinted
prompt. Arms differ only in declared inputs (backend, perception channels, grounding tier).

## The questions this answers (David's brief + follow-ups)

1. What is node discovery like on each backend (ax / dom / cdp), and how does it affect
   task outcomes?
2. How much does a grounding pass buy over ad-hoc discovery (no pass, agent discovers
   mid-task), and how does it affect outcomes?
3. How much do recipes help complete a task, and how do they affect outcomes?
4. Vision-only (added by David): can the agent complete tasks from screenshots alone,
   and does grounding rescue it? "A big thing we want to test."

**Design principle — decision-driven cells.** No full factorial: with n=3 per cell only
large effects are resolvable, so every arm maps to a fork in the implementation Aman
inherits ("ship the sidecar?", "send screenshots on cdp?", "can replays run unattended?").
Cells nothing would ever ship (dom + no-vision + ungrounded, stacked handicaps) are skipped.

## Phase 0 — prerequisites (not benchmarks)

- Yarn signed in on mac2 + mac3 (`./run signin mac2 "Yarn"`, `./run signin mac3 "Yarn"`).
  Found signed out 2026-07-31: mac2 at the SSO wall, mac3 no window.
- Plumbing (built in the `benchmarks` worktree): dispatch/runner carry `--backend`,
  `--no-ax`, `NO_GROUNDING`, `USE_RECIPE`; replay as a dispatchable job kind; recipe files
  fan out to the fleet; cdp arms need Yarn launched with `--remote-debugging-port` on the
  target Mac; bench orchestrator + manifest + report collector.

## Phase 1 — node discovery per backend (3 explore passes, ~40–60 min each, parallel)

| # | Run | Measures |
|---|-----|----------|
| 1 | `explore Yarn --backend ax` | controls seen/actuated/dismissed, axdom naming yield, obs latency, pass duration, map size (nodes/edges), scope ambiguities found |
| 2 | `explore Yarn --backend cdp` | same, off the full DOM snapshot (no node budget) |
| 3 | `explore Yarn --backend dom` | same, under cua's 300-node semantic_v2 budget + paging |

Each pass emits its own appmap; grounded arms below use *their own backend's* map so
discovery quality flows into outcomes unconfounded.

## Phase 2 — task matrix (36 runs, ~1–2 min each, queued fleet-wide)

Core backend × grounding (18):

| Arm | n |
|-----|---|
| ax / cdp / dom × ungrounded (`NO_GROUNDING=1`) | 3 each = 9 |
| ax / cdp / dom × grounded (own Phase-1 appmap) | 3 each = 9 |

Permutation slices (18):

| Arm | n | Decision it informs |
|-----|---|---------------------|
| ax grounded, axdom off (`AXDOM=0`) | 3 | is the Swift sidecar worth shipping (outcomes, not just naming counts) |
| ax grounded, `--no-vision` | 3 | what the screenshot channel buys on ax |
| cdp grounded, `--no-vision` | 3 | same on cdp (DOM snapshot is text-rich — vision may be worth less; fleet-scale cost) |
| ax, curated notes (`USE_RECIPE=1`) | 3 | explore pass vs 10 minutes of human notes |
| **vision-only** (`--no-ax`) × ungrounded | 3 | the floor: screenshots alone, cold |
| **vision-only** × grounded (explore appmap) | 3 | does prose grounding rescue a vision-only agent — the AX-hostile-app deploy story |
| **vision-only** × curated notes | 3 | same against the human-written tier |

Vision-only is ax-backend-only by construction (dom/cdp observations ARE ref lists).
The harness keeps full observations for `verify()` regardless — arms change what the
model sees, never what the run can prove.

Per-run metrics: completion + machine-checked goal; **wrong-scope rate** (brand default
vs per-document override — the correctness failure grounding is known to catch; read from
the mutation journal's `scope`); action count; verified/unverified by channel; expectation
rejections; wall-clock (job record `queuedAt`/`startedAt`/`endedAt` — queue wait is
excluded from run elapsed by design); per-step timestamps; tokens + model calls;
elements-per-observation.

## Phase 3 — recipes (3 compiles + 12 replays)

| # | Run | Measures |
|---|-----|----------|
| 1 | compile one clean grounded run per backend | compile success; what the gate refuses |
| 2 | replay × n=3 per backend (rescue on, default) | steps re-resolved vs rescued, model calls (target 0), wall-clock + tokens vs live grounded arm, success rate |
| 3 | replay × n=3, `--no-rescue`, ax | the unattended-fleet posture: does the happy path hold with ZERO model calls |

## Phase 4 (optional, ~5–8 runs) — second-task spot check

Auto Time sync task, ax only: ungrounded / grounded / replay × n=2–3. Guards against
everything above being cursor-task-specific.

## Totals

~62 runs: 3 explores + 36 tasks + 3 compiles + 12 replays + ~5–8 optional.
Wall-clock ≈ 4–5 hours after sign-ins; the explore passes dominate and run in parallel.

## Deliberately skipped

- Full factorial (~90+ runs): most cells answer no question; n=3 can't resolve
  interactions anyway — deepen a surprising cell after it surprises.
- `--no-ax` on dom/cdp: impossible by construction (refs are the observation).
- Cross-backend replay: recipes record their backend; not worth building for a benchmark.
- Perception-variant explore passes: the 40-min multiplier; discovery is measured once
  per backend.
- **Vision-only grounding (producing a map from screenshots)**: deferred. It is a
  2–3 day build, not a flag — the frontier ledger, actuation credit, dismissal caps, the
  `frontier-empty` stop condition, and the mutation journal are all founded on element
  identity (`frontierKey = role|name|surface`), and the settingKey graph (source of the
  scope-ambiguity warnings, grounding's strongest measured win) would not survive the
  translation. The vision-only *consumption* arms above answer the shippable question;
  build production only if the data says AX-unusable-everywhere apps matter. Dependency
  map lives in the 2026-07-31 session notes; re-derive from `src/core/harness/frontier.ts`.

## Report

`docs/research/2026-07-31-backend-grounding-recipe-benchmarks.md` (vault-symlinked):
tables per axis, timing breakdowns, raw run-log stamps for re-analysis, and a "for Aman"
section — which backend to build on, what grounding buys, whether replay is fleet-ready.

**Judge step (added 2026-07-31, after this plan was written).** Between runs landing and
reading the report: `./run bench judge` re-grades every terminal task/replay run with the
offline adversarial judge (`src/core/judge.ts`) — judge model pinned to
`openai/gpt-5.6-sol` so verdicts are comparable across agent-model arms. Idempotent
(`.judge.json` freezes each verdict; re-runs only judge newly landed runs). The report
gains a `## Judge` section: per-arm trajectory/visual rollups and a Disagreements list
(self-reported `success` vs judge verdict). This exists because self-reported success
provably passes wrong-scope runs — the exact confound the grounded-vs-ungrounded
comparison would otherwise flatten. Workflow: dispatch → `bench judge` → `bench collect`
→ read report. Disagreement rows are the wrong-scope findings AND the human-review queue.

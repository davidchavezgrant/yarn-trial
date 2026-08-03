# What the benchmark can and cannot tell us — a review of the experiment itself

**Date**: 2026-08-03 · **Scope**: the backend × grounding × recipe matrix
(`docs/plans/2026-07-31-benchmark-matrix.md`), its 100 collected runs as of the 08-01 report,
and the 203-run pass currently draining.

This is a review of the *method*, not a results report. The results live in
`docs/research/2026-08-01-backend-grounding-recipe-benchmarks.md` (auto-generated) and the
conclusions in `FOR_AMAN.md`. Nothing here regenerates; it is meant to be argued with.

---

## 0. Read this first — a live defect

`src/core/agent/run.ts:898` is a dangling `if` with no braces:

```ts
if (!outcome)

console.log(`\n=== runaway backstop (${MAX_STEPS} steps) reached without done ===`);
outcome = { success: false, summary: `runaway backstop (…) reached`, stopReason: "step-ceiling" };
```

The guard covers the `console.log` only. The assignment runs unconditionally, so any run that
leaves the loop with `break` has its verdict overwritten. Exactly one path does: the new stall
detector added in the same commit (`91c9993`, 21:26 local). Success and interrupt both `return`,
which is why they survive — the comment at line 582 explains that this was already a known trap.

Observed live at 01:33 UTC: run `2026-08-03T00-51-05-395` stalled at step 22 and recorded
`verdict success=false summary=runaway backstop (100 steps) reached`.

**Impact**: every stalled run in the pass now running is filed as `step-ceiling` instead of
`stalled`. That is the precise distinction commit `91c9993` was written to create, and
`collect.ts:492` keeps the two apart specifically so a budget can't be read as a capability
limit. The remedy the wrong label implies — "re-run with a bigger budget" — is the opposite of
what a stalled run needs. Success rates are unaffected; the failure taxonomy is not.

Fix is one line (`{ … }` around both statements). Mid-pass it means moving HEAD while the fleet
rsyncs per phase, so it is a judgment call, not an automatic yes.

---

## 1. What this experiment actually is

An agent drives a real macOS Electron app (Yarn) toward a goal stated in plain language, with
no hints. The matrix varies four things and measures what happens:

| Axis | Levels |
|---|---|
| Actuation backend | AX (accessibility tree + Swift DOM sidecar) · CDP (DevTools protocol direct) |
| Perception | screenshots on/off · DOM attributes on/off · vision-only |
| Grounding tier | none · explore-generated appmap · curated prose · harvested procedure · compiled replay |
| Task | settings toggle (canonical) · auto-time sync · video creation (phase 7, in flight) |

n=3 per cell, ~203 planned runs across three colo Macs, re-graded afterward by an offline
adversarial judge. ~$154 in model spend for the 100 runs collected so far.

The design is deliberately not a full factorial — each arm is tied to a build decision. That is
the right call and it is what makes the results usable. The problems below are mostly about
resolution and confounds, not about the shape.

---

## 2. What we can learn from it

Ordered by how much weight the evidence bears.

**Solid.**

- **Procedures work.** Phase 6: 12/12 pass across four arms, both backends, both lineages
  (harvested from grounded *and* from ungrounded source runs). The
  explore → run → judge → harvest → promote loop closes. This is the strongest positive result
  in the matrix and the only one at n=12.
- **Replay does not work.** `p3-replay-cdp` 1/3, `p3-replay-norescue` 0/3, filmed replays 0/1
  each, judge failed all six. Recipes compile and then fail to re-execute. The zero-model-call
  happy path — the entire value proposition — does not hold.
- **The lean configurations are not the weak ones.** On the settings task, `min-context`
  (no vision, no DOM attrs) is the cheapest arm *and* the shortest: 7.3 steps, $1.15, 3/3.
  Full-perception ax is 10 steps, $3.32. Whatever the expensive channels are buying, it is not
  visible in outcomes on this task.
- **CDP is cheaper per run without discovering less.** Per-screen observations are ~50–75 nodes
  against ax's ~165–185; cost is roughly a third; and the phase-1 maps it produced are *larger*
  (144–207 nodes vs 120–166). "Leaner, not blinder" holds at the discovery level.
- **The axdom Swift sidecar does not convert.** It names 955 of 1044 anonymous nodes and changes
  nothing measurable: grounded ax 3/3 at 10 steps with it, 3/3 at 10.3 steps without.
- **Self-reported success is more honest than feared.** One judge disagreement in ~50 judged
  runs, and it was the expected class (wrong scope on a replay). The wrong-scope failure is real
  but not endemic once scope warnings are in the prompt.

**Suggestive, worth acting on, not worth quoting as a number.**

- Grounding's value looks backend-dependent — it rescues ax and does nothing for cdp. See §3 for
  why the specific numbers won't support that sentence.
- Curated prose is the leanest tier that still passes (5.7 steps, $0.69) and, per the phase-6
  work, the only tier that produced brand-scope correctness. See §3 on why that tier is
  mislabeled.

**Operational facts, measured, useful regardless of the matrix.**

- ~$1–3 per settings task; $5–18 and 20–60 minutes per explore pass; 10–25s of model latency per
  action. That prices unattended demo generation as viable and interactive assistance as not.
- 29% of archived runs died at the sign-in gate. AX flakiness historically costs about one run in
  three. Queue wait routinely exceeds run time by 10×.

---

## 3. What we cannot learn from it

**The measurement is at its ceiling.** Eleven of fifteen phase-2 arms scored 3/3. When almost
every configuration passes, the design has no room left to discriminate, and the arms that *did*
differ are the ones with the least evidence behind them.

**n=3 on a binary outcome resolves almost nothing.** The headline comparison — ax ungrounded 1/3
against everything else at 3/3 — is a two-run difference. Worse, the other two ungrounded ax
variants scored 3/3 and 2/3 on the same task. Pooled, ungrounded ax is 6/9 and grounded ax is
12/12: Fisher's exact p ≈ 0.063, two-tailed. The spread *among the ungrounded variants* is as
large as the grounded-vs-ungrounded gap, which is what noise looks like.

**Every vision-only result is currently void.** Commit `91c9993` found that thirteen runs stopped
at exactly the old 15-step cap and that every vision-only arm was among them. Those 0/3 rows were
reported as perception failures; they may have been budget failures. Eleven re-runs are queued
right now. Until they land, "screenshots alone cannot do this" is unsupported — and it was one of
the four questions the matrix was built to answer.

**The curated tier is not a human-notes baseline.** `docs/recipes/yarn.md` names the benchmark
task's control, its surface, its options, and the brand-vs-document scope split, and its own
header says it was assembled from an explore pass. `auditTaskPrompt` gates the task string;
nothing audits grounding text. It is an upper bound on grounding, not "what ten minutes of human
notes buys" — which kills the most quotable comparison in the matrix.

**One app, effectively one task.** Every Notion arm was cut, so cross-app transfer is unmeasured.
Native AppKit is out of scope and one of two attempts failed. The canonical task is a 5–13 step
lookup-and-toggle; phase 4 is n=2 on one backend. Phase 7 is the first real long-horizon task and
it is incomplete.

**The model comparison is not a comparison.** Fable has one collected run. Each model ran at its
own maximum effort — defensible as a deployment question, but it means a difference cannot be
attributed to the model. They also bill on different physics: `cache_control` is silently ignored
for OpenAI models over OpenRouter, so the system prompt is charged in full every turn on one side
and not the other. Costs are published-rate estimates, not invoices.

**Verification cannot prove which control it verified** (LIMITATIONS §8). Success on a dual-scope
setting means a string appeared in a flattened bag of labels. The offline judge patches this
after the fact, but the judge is one model's opinion graded against a rubric derived from the
appmap — which is itself one of the treatments. And the judge is pinned to `gpt-5.6-sol`, the
same model under test in 100 of 101 arms: same-family grading throughout.

**The grounding inputs are n=1–2 and unstable.** Phase-1 passes are the input to every grounded
arm. Two runs of the identical ax arm produced 120 and 166 nodes; two runs of the identical cdp
arm produced 6609 and 293 `seen` controls. Two passes carry `⟲` restarts after AX blackouts. A
phase-2 result partly reflects which of two quite different maps happened to be written that day.
The vision map is the weakest of the set (89 nodes, 1 ambiguity) and n=1, and the cdp vision
explore failed outright, twice.

**Runs are not independent samples.** Host assignment follows queue order, so arms land on
whichever Mac is free — and the Macs are not interchangeable (mac1's flagless-Chrome wedge, mac3's
leftover tabs, per-host sign-in state). Host is an uncontrolled variable with nothing preventing
it from correlating with arm.

**Some of the data predates its own fixes.** Nine runs began from an arbitrary app state because
the perception-reduced maps declared no home — non-comparability perfectly correlated with the
variable being measured (LIMITATIONS §23). The wrong-scope metric would have come out with the
wrong *sign* (§22). The judge's answer key came from a file nothing writes (§21). All fixed, all
after data in the current report was collected.

**HEAD moved during the pass.** Six commits landed between 20:38 and 21:31 local while runs were
draining, and the fleet rsyncs the checkout per phase. Runs in one manifest ran different code.

---

## 4. How to improve the experiment

Ranked by leverage per unit of effort.

1. **Fix the stall/step-ceiling label** (§0) before more runs land.
2. **Stop spending samples on ceilings.** Eleven arms at 3/3 are re-confirming a known pass. Cut
   them to n=1 smoke tests; spend the freed budget on n=10 for the three or four cells that
   actually vary. A sequential rule does this automatically: stop a cell after three consecutive
   passes, keep sampling a cell that mixes.
3. **Give the matrix dynamic range back.** The settings task cannot discriminate — that is the
   single biggest threat to the whole exercise. Phase 7 is the right instinct. A task requiring
   multi-surface navigation and a non-string outcome would do more for the matrix's value than
   any additional arm.
4. **Block host assignment by arm** — round-robin so each arm gets one run per Mac. Free, and it
   removes an uncontrolled variable that is currently free to align with the treatment.
5. **Write a real human-notes recipe, blind.** Someone who has not seen the benchmark tasks
   spends ten minutes with the app and writes notes; timestamp it. That restores a tier the
   matrix claims to have and currently does not.
6. **Judge across families.** A two-of-three panel spanning providers, or at minimum a judge from
   a different family than the agent. Judging is cents against dollars per run.
7. **Report spread, not just means.** Every `x̄` at n=3 should carry min–max. "8.7 steps" is a
   different finding if it is 8/9/9 than if it is 5/7/14.
8. **Settle or delete `seen`.** The report already says do not quote it. That 6609 is list rows
   is a strong hypothesis, not a measurement — one CDP observation of Yarn's Library counting
   distinct triples settles it in two minutes.
9. **Pre-register the decision thresholds.** Each arm names the decision it informs, but not what
   result would move it. Without "grounding ships if it buys ≥ X", any outcome reads as support.
10. **Freeze HEAD for the duration of a pass.** The autopilot warns on movement; it should refuse,
    and the manifest should record the commit each run executed.
11. **Split harness failures out of the top-line.** With 29% sign-in deaths and 1-in-3 AX flakes,
    the `done/n` column mixes two populations that call for different responses.
12. **Re-run phase 1 at n=3 per backend, clean.** The maps are the input to everything downstream
    and they are the least-sampled, most-variable artifact in the experiment.

---

## 5. How to improve a production build

Based on what the data supports today.

**Ship.**

- **CDP-direct as the primary backend** for Electron and web targets, AX as fallback. Cheaper,
  leaner, no AX blackouts, no discovery penalty.
- **Lean perception by default.** Screenshots and DOM attributes off; escalate to vision on a
  stall. The stall detector is the natural trigger and it already exists.
- **Grounding as a cached artifact with a lifecycle**, never a runtime step — a 20–60 minute,
  $5–18 explore pass cannot sit in a request path. Explore once, harvest procedures from
  judge-passed runs, promote. That loop is the 12/12 result. Production still needs the two
  pieces the benchmark doesn't have: staleness detection tied to app version, and a defined
  behavior on cache miss.
- **Scope disambiguation as a required part of every grounding artifact.** It is the one failure
  class that produces confident wrong answers, `findScopeAmbiguities` + prompt injection
  demonstrably flips behavior in both directions, and the chosen scope should be recorded as
  structured data, not prose.

**Don't ship.**

- **The axdom Swift sidecar.** High naming yield, zero measured outcome effect, a native build
  dependency that degrades silently when the binary is missing.
- **Replay/recipes.** 1/3 with rescue, 0/3 without. Revisit if the compile step gets a real
  re-resolution strategy; today it is a feature that looks finished and isn't.

**Build, because the benchmark shows it is the actual risk.**

- **Verification for non-string outcomes.** Navigation is at ceiling; verification is not. The
  creation runs carry 8–14 unverifiable steps out of 15, and one *passed* with nine. "Can we
  grade creative work" is the real open question and nothing in the matrix answers it.
- **Three-state checks everywhere.** The recurring defect across this whole project is absence
  rendering as a value: a missing rubric passed, an unset scope read as zero, a dropped flag
  produced plausible data under the wrong label three separate times. Production rule: "could not
  check" must never serialize to the same value as "checked and fine."
- **Structural config forwarding.** The hand-written `dispatchOptionsFor` list caused three
  wrong-label incidents. Anything crossing a process boundary should be serialized wholesale and
  asserted on arrival.
- **Operating limits must never be recorded as verdicts.** The step-cap bug is the general case,
  and §0 is it recurring inside its own fix. Stop conditions need an explicit reason code that
  reaches the caller.

---

## 6. Status of the current pass

At 21:33 local: 203 planned, 161 submitted, 81 collected, 78 queued, 1 running, three Macs busy
with 33–36 jobs each. Phase 7 (video creation, 23 arms × 3) plus 11 vision-only re-runs.
Estimated 2–3 hours to drain.

A probe is armed and will report when the queue empties, when an hour passes with nothing
collected, or when a Mac drops off. Sections 2 and 3 get revised against phase-7 data once it
lands — in particular the vision-only verdict, which is void until the re-runs report.

# What the benchmark can and cannot tell us — a review of the experiment itself

**Date**: 2026-08-03 · **Scope**: the backend × grounding × procedure matrix
(`docs/plans/2026-07-31-benchmark-matrix.md`), read against the **completed** 165-run pass —
165/165 collected, 107 successes, $227.17, 817k output tokens.

This is a review of the *method*, not a results report. The results live in the auto-generated
report and the conclusions in `FOR_AMAN.md`. Nothing here regenerates; it is meant to be argued
with. Written mid-pass and revised once the data landed; the two headline findings **reversed**
between those drafts, which is itself the argument for not writing conclusions early.

---

## 0. The defect that ran through this pass — found, fixed, data repaired

`run.ts:898` was a dangling `if` with no braces, so the runaway-backstop assignment ran
unconditionally and overwrote the stall verdict one line after it was set. The stall detector
worked perfectly; only its answer was destroyed — the failure mode that looks exactly like a
feature nobody built.

Two sessions caught it independently, from different directions: live, watching a run stop at
step 22 and log `runaway backstop (100 steps) reached`; and statistically, noticing 30
`step-ceiling` failures with a median of 16 steps against a backstop of 100. Fixed in `ab31ba2`.

**The data is repaired**, re-derived from step counts — a run that stopped before its own cap
stalled. Final: **27 stalls, 3 genuine ceilings** (creation arms at their budget of 30)
[superseded 2026-08-03: the creation arms' 30-step pin has since been deleted — no arm sets
`dispatch.steps` at all now, so a `step-ceiling` label can only mean the 100-step runaway
backstop]. Before
the repair the pass carried 30 step-ceiling labels and zero stalls.

Worth keeping as the specimen it is: an operating limit recorded as a capability verdict, which
is the same error the 15-step budget made a day earlier, recurring *inside its own fix*.

---

## 1. What this experiment is

An agent drives a real macOS Electron app (Yarn) toward a goal stated in plain language, with no
hints. Four axes:

| Axis | Levels |
|---|---|
| Actuation backend | AX (accessibility tree + Swift DOM sidecar) · CDP (DevTools protocol direct) |
| Perception | screenshots on/off · DOM attributes on/off · vision-only |
| Grounding tier | none · explore-generated appmap · pixel-written appmap · curated prose · harvested recipe · compiled replay |
| Task | settings toggle · motion blur · **video creation** (the product flow) |

n=3 per cell across three colo Macs, re-graded by an offline adversarial judge.

---

## 2. What we can learn from it

**The strongest result: recipes work.** 12/12 across four arms, both backends, both lineages
(harvested from grounded *and* ungrounded source runs), plus 2/3 on the Fable twin. The
explore → run → judge → harvest → promote loop closes. Only result in the matrix at n=12.

**Replay does not work.** 1/3 with rescue, 0/3 without, 0/1 filmed, judge failed all six. The
zero-model-call happy path is the entire value proposition and it does not hold.

**The product flow reversed the grounding finding.** This is the most important thing the pass
produced, and it only appeared because a second task was added:

| | settings task | creation task |
|---|---|---|
| cdp ungrounded | 3/3 | **0/3** |
| cdp grounded | 3/3 | **3/3** |
| ax ungrounded | 1/3 | 3/3 |
| ax grounded | 3/3 | 2/3 |

On a dropdown toggle, cdp needs no grounding and ax appears to. On Yarn's actual product flow it
is the other way round. "Grounding's value is backend-dependent" — the headline of the 08-01
report — does not survive contact with a second task. What it actually depends on is the **task**.
Anyone shipping "skip grounding on cdp" off the settings data would have shipped the wrong thing.

**Vision-only works, but only from a map written in its own modality.** David's "big thing we
want to test", answered:

| vision-only arm | result |
|---|---|
| ungrounded | 0/3 |
| grounded on the **element**-written map | 0/3 |
| grounded on the **pixel**-written map | **2/3** |
| curated human prose | **2/3** |

An element-written appmap is worth nothing to an agent that sees only pixels; a pixel-written one
rescues it. That distinction was invisible until the budget bug was fixed — the pixel-map arm read
0/3 in the 08-01 report purely because 15 steps truncated it.

**Lean still beats rich on the settings task** — `min-context` (no vision, no DOM attrs) is 3/3
and the cheapest arm. On the creation task the lean cells hold at 2/3.

**Operational base rates**: $227 and 817k output tokens for 165 runs; 65% overall success;
explore passes 20–60 min and $5–18 each; 10–25s of model latency per action.

---

## 3. What we cannot learn from it

**The settings task is exhausted.** Every core and slice arm is now 3/3 except the single
full-perception ax cell. It has no discriminating power left and should not receive another
sample.

**"Grounding rescues ax" is now clearly unsupported.** Pooled across the three ungrounded ax
variants: 7/9, against 12/12 grounded. Fisher exact two-tailed **p = 0.171** — weaker than the
0.063 the mid-pass draft computed, because a re-run flipped `min-context-ungrounded` to 3/3. Only
`ax-ungrounded` is low at 1/3, and both its siblings are 3/3. The cell, not the treatment.

**Six runs are void, and the guard caught it at the wrong time.** Both cdp visionmap arms declared
`explore-vision` and ran with no map — `groundingChecked` flagged all six as
`grounding-mismatch`. So `cdp-grounded-visionmap`'s clean 3/3 measured something other than what
its name says, and the question the arm exists for — *is a pixel-written map any use to an agent
that can see elements?* — is unanswered. The detector worked; it fires at collect, after the runs
are paid for.

**The model comparison is not usable.** Fable is 6/9, but all three failures are 2-step `gave-up`
verdicts across three *different* arms. An identical early abort on three distinct configs is a
systematic signature — a refusal or a prompt-format mismatch — not three capability failures. Read
as a model gap it is simply wrong; the arms are plausibly 3/3 with one systematic abort each.
Diagnose the 2-step exit before anyone quotes 6/9.

**95 of 165 runs are unjudged** (judge coverage 70/165). Every wrong-scope claim, and every check
of self-reported success, is confined to the older runs. The creation task — where verification is
weakest — has no judge verdicts at all. [superseded 2026-08-03: the judge finished the pass —
**187 verdicts** (`c08097a`), and the Judge table in
`2026-08-01-backend-grounding-reuse-benchmarks.md` carries 30 `create-*` rows, four of them
disagreements. The creation task is judged; this also settles §4.3 and the first item of §6 below.]

**Verification still cannot prove which control it verified** (LIMITATIONS §8), and the creation
runs are where that bites: 8–14 unverifiable steps out of 15, one success passing with nine.

**Still one app.** Every Notion arm was cut, so cross-app transfer remains unmeasured, and every
finding above could be a fact about Yarn. [superseded 2026-08-03: no longer one app — Notion on the
**web** now runs over CDP at 77 arms / 152 runs against Yarn's 117 / 231, with discovery, the
configuration cells mirrored across two Notion tasks, reuse, the Fable model axis and 36 filmed
takes. Stage 4 varies app as well as task and model. Notion *Calendar* — the desktop app — is still
in no arm.]

**Still n=3.** Two of three is not distinguishable from three of three at this sample size.

---

## 4. How to improve the experiment

1. ~~Fix the stall/step-ceiling label~~ — **done** (`ab31ba2`), data repaired.
2. **Stop sampling the settings task.** It is at ceiling in eleven of twelve arms. Move those
   samples to the creation task, which demonstrably discriminates.
3. **Judge the remaining 95 runs** before anyone reads the creation results. Verification is the
   weakest link on exactly that task.
4. **Diagnose Fable's 2-step abort** before running any model comparison.
5. **Check declared grounding files exist at dispatch, not at collect.** Six runs were paid for
   before `groundingChecked` reported they had measured the wrong tier.
6. **Block host assignment by arm** — round-robin so each arm gets one run per Mac. Free, and it
   removes an uncontrolled variable currently free to align with the treatment.
7. **Write a blind human-notes procedure.** The curated tier names the benchmark's own answer and
   was assembled from an explore pass, so it is an upper bound on grounding, not human notes.
8. **Judge across families** — the judge shares a model family with the agent in 156 of 165 runs.
9. **Report spread, not just means.** At n=3, "8.7 steps" is a different finding if it is 8/9/9
   than if it is 5/7/14.
10. **Freeze HEAD for a pass.** Six commits landed while this one drained.
11. **Re-run Discovery at n=3 per backend.** The maps are the input to everything downstream and
    are the least-sampled, most-variable artifact in the experiment.

---

## 5. How to improve a production build

**Withdraw the "skip grounding on cdp" recommendation.** The settings data supported it; the
product flow refutes it (0/3 ungrounded vs 3/3 grounded). Ship grounding.

**Ship CDP-direct as the primary backend** for Electron and web — cheaper, leaner, no AX
blackouts, no discovery penalty. Keep AX as fallback.

**Ship grounding as a cached artifact with a lifecycle**, never a runtime step: a 20–60 minute,
$5–18 explore pass cannot sit in a request path. Explore once, harvest from judge-passed runs,
promote — that loop is the 12/12 result. Production still needs staleness detection tied to app
version, and defined behaviour on a cache miss.

**Cost the vision-only grounding pass.** It was deferred as "a 2–3 day build, not a flag" on the
assumption that vision-only consumption answered the shippable question. It did — and the answer
is that vision-only works *only* with a pixel-written map. That is the AX-hostile-app deploy
story, and it now has evidence behind it rather than a guess.

**Don't ship the axdom sidecar** — high naming yield, no measured outcome effect, a native build
dependency that degrades silently.

**Don't ship replay** — 1/3 with rescue, 0/3 without.

**Build verification for non-string outcomes.** Navigation is solved; grading creative work is
not, and the creation task is where the product lives.

**Three-state checks everywhere.** The recurring defect across this project is absence rendering
as a value: a missing rubric passed, an unset scope read as zero, a dropped flag produced
plausible wrong-labelled data three separate times, and this pass added a sixth — a stall verdict
overwritten by a backstop label. "Could not check" must never serialize to the success value.

---

## 6. Status

Pass complete: 165 submitted, 165 collected, 107 successes, three Macs idle. Outstanding before
these conclusions are final: judge the remaining 95 runs, re-run the six void visionmap runs, and
diagnose the Fable 2-step abort.

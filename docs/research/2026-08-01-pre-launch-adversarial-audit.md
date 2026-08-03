# Pre-launch adversarial audit of the benchmark matrix

**Date**: 2026-08-01 · **Trigger**: David, before firing phase 1 of the 58-arm matrix
**Method**: two adversarial agents, disjoint scopes, both told to assume the author is
confident and mistaken and to verify against code rather than comments.

- Agent A — **matrix design**: can each arm support the conclusion its `informs` claims?
- Agent B — **pipeline wiring**: does the code do what the matrix declares?

The split mattered. Every finding below was found by exactly one of them, and the two
highest-severity findings came from different agents. A single auditor covering both scopes
would have had to hold the arm semantics and the wire format in one head.

---

## Summary

| | found | fixed now | deferred with a reason |
|---|---|---|---|
| Agent A (design) | 12 | 5 | 7 |
| Agent B (wiring) | 8 | 8 | 0 |

Five findings would have produced **publishable-looking numbers that were wrong**. Those are
detailed below; the rest are in the fix log at the end.

Both agents independently reported `npm test` and `npx tsc --noEmit` green before and after —
the entire class of defect here is invisible to the test suite as it stood.

---

## The five that would have corrupted results

### 1. Two flags never crossed the wire (Agent B)

`dispatchOptionsFor` translates an arm into a job order by spelling out every field by hand. It
was missing `record` and `useRecipes`.

The recording flag is the worse of the two, because of how filmed arms are derived:

```ts
const filmed = (arm: Arm): Arm => ({ ...arm, phase: 5, n: 1, dispatch: { ...arm.dispatch, record: true } });
```

Filming is the *only* difference between a phase-5 arm and its phase-2 sibling. Drop the flag
and all 16 filmed runs become bit-identical re-runs under different arm ids — no footage, 16
rows reading "done", and nothing detecting it because the manifest never records `record`.

`useRecipes` would have made all 6 phase-6 runs measure the appmap tier. That one *is*
caught by `groundingChecked`, but only at collect time, after the runs are paid for.

**This is the third occurrence of the class** (`APPMAP_VARIANT=novision` was the second, and
cost two grounding passes their only consumer). The fix is therefore structural rather than two
more lines: `dispatchOptionsFor__ForwardsEveryDeclaredFlag` walks every arm's actual `dispatch`
object and asserts each set field arrives. The prior tests checked only that the *matrix
declared* the flags, which is why none of the three were caught.

It justified itself immediately — the edit adding the two missing lines deleted `noRescue`, and
the new test named it within seconds.

### 2. The judge's answer key came from a file nothing writes (Agent A)

`buildRubric` loaded the scope-collision list from the **plain** app slug (`docs/appmaps/yarn.json`).
No explore pass writes that any more — the writer emits variant slugs (`yarn.ax`,
`yarn.cdp.novision`, …). Two consequences, the second much worse:

- It graded against whatever legacy file survived, whose `settingKey` vocabulary differs from
  the maps arms are grounded on (`zoom-type` vs `default-zoom-type`, `window-padding` vs
  `screen-window-padding`).
- `buildRubric` returns `""` when the file is absent. **Delete the legacy maps — which every
  hygiene rule in this repo says to do — and every wrong-scope run silently passes.**

That verdict is not merely reported. It gates recipe harvesting, so a wrong-scope run could
have become promoted grounding that teaches the mistake to everything downstream.

Fixed: rubric keyed on the run's own backend; an empty rubric warns loudly.

### 3. A headline metric would have come out with the wrong sign (Agent A)

The mutation journal labels each change's `scope` by reading the appmap graph, and the graph was
loaded only when grounding prose loaded:

```ts
const graph = grounding.notes ? loadAppMapGraph(slug, backendKind) : undefined;
```

So an ungrounded run journalled every mutation with `scope` unset. The report's document-scope
column would have read **0 for every ungrounded arm** — because the scope was unknowable, not
because the runs were correct — and non-zero for the grounded arms that avoid the mistake. The
table would have shown grounding *causing* wrong-scope mutations.

This is the matrix's most important claim and the number most likely to be quoted.

Fixed: the graph loads unconditionally. It never reaches the model — `detectMutation` and
teardown read it, both on our side of the boundary. The prompt-facing half (`scopeWarnings`)
stays gated on the tier.

### 4. Start-state normalisation switched itself off for the arms being compared (Agent A)

Every run resets the app to its declared home, looked up in that arm's own map. Measured on the
committed maps:

| map | `homeLabels()` |
|---|---|
| `yarn.ax.json` | `["Library"]` |
| `yarn.cdp.json` | `["Library"]` |
| `yarn.ax.novision.json` | `[]` |
| `yarn.ax.vision.json` | `[]` |

Both perception-reduced passes failed to declare a home; both full-perception passes declared
one. That is a property of the treatment, so re-running phase 1 reproduces it. `resetToHome`
returned `"none"`, and only `"failed"` refuses — so nine runs began wherever the previous job on
that Mac left the app, while every arm they are compared against reset.

Non-comparability **perfectly correlated with the variable under test**: "dropping screenshots
costs N extra steps" would have silently included "and started from an arbitrary state".

Fixed: home falls back to the full-perception map for that backend. Home is a property of the
app, not of the channel that mapped it.

### 5. Both recipe arms read one file (both agents, independently)

`recipeFileFor` keyed on `(app, task)` only, so `p6-ax-recipe` and `p6-cdp-recipe`
resolved to the same path. Whichever was promoted last wins, and one arm grounds on the other
backend's vocabulary — with nothing downstream to catch it, since provenance reads `"recipe"`
either way.

Appmaps carry a backend axis for exactly this reason: the ax and cdp passes name the same
surfaces differently (`editor` vs `draft-editor`), and a grounded run resolves controls *by
name*.

Fixed: keyed on `(app, backend, task, lineage)`.

---

## The pattern

Four of the five are the same bug wearing different clothes: **an absence rendering as a value.**

- a grader with no answer key returning "pass"
- an unknowable scope rendering as zero
- a missing home declaration rendering as "no reset needed"
- a flag missing from a hand-written list producing a plausible run under the wrong label

None threw. None logged. All four produce correctly-shaped, publishable-looking output. The
defensive habit worth generalising: **never let "I could not check" and "I checked and it was
fine" produce the same output.**

---

## Fixed, lower severity

| finding | fix |
|---|---|
| Filmed-replay arms were impossible — `procedure-cli.ts` had no `--record` and the runner never passed one | implemented on both sides, with the live run's ordering (record before home reset, assemble before teardown) |
| Nothing synced `docs/recipes/` to the fleet, so phase 6 would ground on nothing | `syncRecipes` / `autoSyncRecipes`, mirroring procedures, gated on `useRecipes` |
| `bench harvest` wrote a post-terminal artifact without re-linking the archive | one `archiveRun` call; a purge would otherwise drop harvested recipes and force a re-spend |
| Dash attributed `p2-min-context-grounded` to a sibling's map (variant tested before `axdomOff`) and still named a deleted arm | `groundingArmId` derives from `armAppmapSlug` — one derivation instead of a parallel decision tree |
| `humanizePulled` shelled out with `cwd: process.cwd()` | `resourcesRoot()`; cwd is not a valid input here (see `paths.ts` header) |
| Phase 6 had no dispatch gate — a missing recipe only warned on the child's console | refuses dispatch, naming the expected path and the judge → harvest → promote workflow |

---

## Deferred, with reasons

**Relabelled rather than fixed** — the arms are honest now about what they can support:

- *Phase 6 cannot make a replacement claim* on its own. Its recipes are distilled from
  appmap-grounded runs, so they presuppose the sweep. **Partially addressed**: David added
  `p6-{ax,cdp}-recipe-from-ungrounded`, harvested from a judged-PASS ungrounded run, which is
  the only arm that can speak to whether the exploration pass needs to exist. It may prove
  unrunnable — a judged-PASS ungrounded run is rare because of the wrong-scope class — and that
  refusal is itself an answer.
- *The curated tier contains the benchmark's answer.* `docs/curated/yarn.md` names the canonical
  task's control, surface, exact options and the brand-vs-document split, and its own header says
  it was assembled from a 2026-07-29 exploration pass — so it is neither "human notes" nor
  uncontaminated. `auditTaskPrompt` gates the task string; **nothing audits grounding text**.
  Relabelled as an upper bound on grounding. A real fix means writing the file blind to the
  benchmark tasks and re-timing it.
- *The two vision-grounded arms differ in more than perception.* `yarn.ax.json` yields 17 scope
  ambiguities including `cursor-style`; `yarn.ax.vision.json` yields **zero**. So one arm gets
  the wrong-scope defence and the other does not. The conclusion must be stated as "vision-only
  grounding produced a map with no scope information", not "vision-only grounding failed".

**Accepted as known limits:**

- *Nothing grades recipe prose.* A mechanical check is one-directional in the wrong way — it
  could flag a missing text-verified surface but never an invented one, because a legitimate
  canvas step has no AX or DOM name to match against. It would prune exactly the vision-only
  knowledge that is hardest to acquire. Left empirical: phase 6 is itself judged.
- *The axdom axis cannot be varied independently at grounding time and run time* — there is no
  `APPMAP_AXDOM` mirroring `APPMAP_VARIANT`, so the sidecar question is answerable only as a
  package.
- *n=2 explore arms write one filename*, so phase 2's grounded arms are all conditional on one
  arbitrary draw from a distribution the matrix itself documents as wide. `collect` archives both
  maps per pass; the report should record which one grounded phase 2.
- *Compile source is first-match-wins*, so replay timings compare one arbitrary draw against a
  3-run mean. Selecting the median-steps clean source would fix it.
- *The report has no phase-6 section* and still emits a dead Notion-Calendar table.

---

## Method notes, for the next audit

- **Tell the auditor comments may lie.** This repo's comments are unusually dense and mostly
  accurate, which makes the inaccurate ones dangerous. Both agents were instructed to verify
  against code, and both found places where a comment described intent the code did not
  implement.
- **Disjoint scopes, stated as exclusions.** Each prompt named what the *other* agent was
  covering. Zero overlap in findings across 20 items.
- **Demand file:line evidence and "skip anything that works."** Both reports were almost entirely
  actionable; neither spent length restating the design.
- **The measured proofs were the valuable part.** Agent A ran `homeLabels()` against the
  committed maps and `findScopeAmbiguities()` across variants rather than reasoning about them;
  Agent B printed the actual `dispatchOptionsFor` output per arm. Those tables are what turned
  "this looks risky" into "this is broken, here is the value".

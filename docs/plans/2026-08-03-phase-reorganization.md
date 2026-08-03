# Stages, not phases — reorganizing the matrix before a clean run

**Status**: implemented 2026-08-03 in `a433309` — *"Collapse eight phases into five stages plus a
diagnostics track."* The `StageDef` table is in `src/bench/matrix.ts`, `type Phase = 1 | 2 | 3 | 4 |
5 | 9` (diagnostics off-ladder at 9), and `DEFAULT_PHASES` is derived rather than hand-listed —
`STAGES.filter((s) => s.inCorePass).map((s) => s.n)` at `src/bench/autopilot.ts:79`, evaluating to
`[1, 2, 3]` with judge→harvest→promote inserted before stage 3. The matrix now stands at 194 arms /
383 runs across those five stages. Every eight-phase list and `phase === n` quote below is the
before-state this plan argued against — evidence, not current code.

**Why now**: a clean run is the only cheap moment to renumber. There is no live manifest to migrate
and no half-collected pass to keep comparable.

---

## The problem, stated mechanically

Phases got bolted on because **a bare integer is carrying three different jobs at once**:

1. **dependency order** — what must finish before what
2. **the axis** — what the phase varies
3. **the kind of thing** — is this a measurement, an artifact producer, a deliverable, or a
   self-test of the harness

Nothing in the code separates them, so every new question takes the next free number and the
orchestrator learns about it through hand-edited number checks. There are five copies of the same
hand-maintained list:

```
autopilot.ts:116    [1, 2, 3, 4, 5, 6, 7, 8].includes(p)
orchestrate.ts:528  for (const phase of [1, 2, 3, 4, 5, 6, 7, 8] as Phase[])
orchestrate.ts:712  if (![1, 2, 3, 4, 5, 6, 7, 8].includes(phase))
orchestrate.ts:808  const valid = (p: number) => [1, 2, 3, 4, 5, 6, 7, 8].includes(p)
orchestrate.ts:836  nums.some((n) => ![1, 2, 3, 4, 5, 6, 7, 8].includes(n))
```

…and seven behaviours keyed on specific numbers:

```
autopilot.ts:115    "ascending, except 5 (filmed) always runs last"
autopilot.ts:127    judge→harvest→promote inserted "immediately before phase 6"
autopilot.ts:546    if (stage.phase === 6 && …)          recipe gate
autopilot.ts:550    if (stage.phase === 5) …             filming note
orchestrate.ts:409  (phase === 2 || phase === 5)         home-state guard
orchestrate.ts:432  if (phase === 6 …)                   recipe gate
orchestrate.ts:454  if (opts.go && (phase === 3 || phase === 4)) runCompiles
```

Commit `964ca05` — *"Teach the bench CLI that phase 7 exists"* — is that maintenance burden with a
name on it. `autopilot.ts:363` still tells the operator `--phases wants a comma list from 1-6`,
which has been wrong since phase 7 landed.

**And it just happened again, live.** Phase 8 was claimed twice inside one hour on 2026-08-02: by
`b02ac5a` (harness AX-offset diagnostics) and by the Notion draft. Two sessions each took "the next
number" because the next number is the only slot the design offers.

### The tell that the taxonomy is wrong

`b02ac5a` needed **two guard exceptions** to fit its arms into the structure:

> *"phase 8 may set `record` (its filmed half IS the measurement), and it is excluded from the
> filmed-twin derivation, which would otherwise film the same config twice."*

Both exist because every guard assumes a phase measures **the agent**. Phase 8 measures **the
instrument**. When a genuinely new kind of thing arrives and the only way to admit it is to punch
holes in two invariants, the invariants were attached to the wrong noun.

---

## The new shape

Five ordered stages plus one off-ladder track. Every stage varies one axis and answers one question.

| # | Stage | Kind | Question | Needs |
|---|---|---|---|---|
| 1 | **Discovery** | artifact | what can a pass find, per perception condition, per app | — |
| 2 | **Configuration** | measurement | which backend / perception / grounding tier wins, one task | 1 |
| 3 | **Reuse** | measurement | does a frozen artifact beat live grounding | 2 + judge/harvest/promote |
| 4 | **Generalization** | measurement | does stage 2 hold off this task, this model, this app | 2, 3 |
| 5 | **Deliverables** | deliverable | footage of the configs that won | 2, 4 |
| — | **Diagnostics** | diagnostic | is the instrument itself sound | — (any free fleet) |

### Where today's phases go

| today | → | why |
|---|---|---|
| p1 — 8 explore passes | **1 Discovery** | unchanged; add the second app's passes here rather than in its own phase |
| p2 — 15 config arms | **2 Configuration** | unchanged, the core |
| p7 — `vision-only-cdp-*` (4), `cdp-grounded-visionmap` (1) | **2 Configuration** | **re-homed.** Same task, same model — these are config cells the phase-2 grid was missing, not new questions. `p7-vision-only-cdp-curated`'s own `informs` says *"completes the grid ax already has"* |
| p3 — compile + replay | **3 Reuse** | merged with p6 |
| p6 — recipe arms | **3 Reuse** | merged with p3. Both consume a judged-PASS stage-2 run, and putting them together is the only way the report ever compares a **compiled step list** against **harvested prose** — today they sit three phases apart and nothing compares them |
| p4 — motion blur (2nd task) | **4 Generalization** | task axis |
| p7 — `create-*` (15) | **4 Generalization** | task axis |
| p7 — `claude-*` (3) | **4 Generalization** | model axis |
| Notion web arms | **4 Generalization** | app axis |
| p5 — filmed (48) | **5 Deliverables** | `--record` changes the action space, so these were never comparable to stage 2; and you film what won |
| p8 — AX-offset pair | **Diagnostics** | measures the harness, not the agent |

Phase 7 splits 18 / 5 across two stages. That is the "ad-hoc stuff in a separate phase" —
four unrelated questions sharing a number because they arrived on the same day.

---

## The structural fix: declare, don't renumber

Renumbering alone leaves the disease. Each stage should declare its own properties and the
orchestrator should read them:

```ts
export type StageKind = "artifact" | "measurement" | "deliverable" | "diagnostic";

export interface StageDef {
	id: StageId;                  // "discovery" | "configuration" | …
	n: number | null;             // display order; null = off-ladder (diagnostics)
	title: string;
	kind: StageKind;
	/** Topological order. Replaces "ascending, except 5 always runs last". */
	needs: StageId[];
	/** Workflow steps to insert before this stage. Replaces "insert before phase 6". */
	before?: Array<"judge" | "harvest" | "promote">;
	/** Replaces `phase === 3 || phase === 4`. */
	compiles?: boolean;
	/** Replaces `phase === 2 || phase === 5`. */
	homeGuard?: boolean;
	/** Replaces DEFAULT_PHASES = [1, 2, 3, 6]. */
	inCorePass?: boolean;
}
```

What that deletes:

- **five copies of the phase list** → `STAGES.map((s) => s.id)`, one source
- **`orderedPhases`' "except 5"** → a topological sort; `deliverables.needs` already says it
- **`planStages`' "before phase 6"** → `reuse.before = ["judge", "harvest", "promote"]`
- **`DEFAULT_PHASES`** → `STAGES.filter((s) => s.inCorePass)`
- **both of `b02ac5a`'s exceptions** → the filmed-twin derivation and the `record`-forbidden guard
  apply to `kind === "measurement"`, so a diagnostic stage is excluded by *definition* rather than
  by name. This is the test of whether the redesign is right: it should delete special cases, not
  add them.
- **the stale `"a comma list from 1-6"` message** → generated from `STAGES`

Adding a stage becomes adding one object. Nothing in the orchestrator changes.

**One test**: assert the `needs` graph is acyclic and every id is unique. That is the guard five
hand-maintained copies of an integer list never had.

---

## What this costs, honestly

**Files to touch**: `matrix.ts` (the `Phase` type and every arm), `orchestrate.ts` (five sites),
`autopilot.ts` (four sites), `watch.ts`, `manifest.ts`, `report.ts` (section headers), `dash.html`
(`a.phase === 1` at 2124, plus phase grouping), the `bench` CLI, and the tests.

**Three consequences worth deciding before starting:**

1. **Arm ids carry the phase prefix** (`p2-`, `p7-`). Renaming breaks the link to
   `out/bench/archive` and to the 08-01 report, so the clean run starts a fresh baseline rather
   than extending the old one. That is what a clean run means anyway — but it should be a decision,
   not a discovery. Alternative: keep the old ids as aliases in the manifest reader.

2. **Re-homing the five config arms multiplies downstream.** The creation arms derive from the
   phase-2 grid, so moving five arms into stage 2 grows stage 4's task slice from 15 to 20 arms —
   **+15 runs, unasked.** Derivation is the right pattern and this is its sharp edge. The fix is
   the one the methodology review already recommends: derive the generalization stage from an
   explicit *subset* — the configs that still differ, plus the winner — rather than from the whole
   grid. Eleven of fifteen phase-2 arms sat at 3/3; running a new task on all of them re-confirms a
   ceiling at full price.

3. **The model axis is smaller than it looks.** Stage 4's Claude arms answer *"does the config
   finding hold under another model"*. They do **not** answer the For Aman TODO, which asks which
   model *pipeline* to ship — self-grounded end to end, its own explores, its own maps, its own
   runs. That is a second full pass of stages 1–3, not a slice of stage 4. Worth naming now so the
   TODO does not get closed with the wrong evidence.

---

## Sequencing

1. **On drain** — fix `run.ts:898`, collect, judge, read phase 7 under its current numbering. Do
   not renumber data that already exists.
2. **Then** — implement the `StageDef` table and migrate the arms. One commit, no runs.
3. **Then** — the clean run, on stages 1–3 (the core pass), with 4 and 5 opt-in.
4. Diagnostics runs whenever the fleet is free; it is on nobody's critical path.

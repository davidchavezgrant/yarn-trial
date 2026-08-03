# Dash + bench data layer bug hunt — 2026-08-01

> **Ids superseded 2026-08-03.** A dated hunt; the findings stand, but the arm ids in the body no
> longer resolve. The eight-phase ladder has collapsed into five stages plus an off-ladder
> diagnostics track (`a433309`), and arm ids were renamed and are now canonicalised at the manifest
> boundary (`af7e5a4`) — so `p1-`, `p2-`, `p5-`, "phase 3" and the like name nothing in the current
> matrix. Read them as the phase-era labels they were.

Provenance: multi-agent hunt (5 scoped finders → 1 adversarial verifier per finding, 23 agents).
Every finding below marked CONFIRMED survived an independent skeptic instructed to refute it by
tracing the code; "corrected" notes are where the skeptic upheld the bug but fixed the mechanism.
Excluded by design: the model-hint bug (BENCH_PRIMARY_MODEL fix in flight the same day) and the
known orchestrate.ts `BenchDispatchOptions` cast staleness. Line numbers are against the working
tree as of the hunt, which included the uncommitted model-fix diff in dash.ts/matrix.ts/orchestrate.ts.

Severity is impact-ranked within each group. The short version: **the three collect.ts findings
and report.ts:64 can silently corrupt the benchmark's headline numbers; everything else lies only
on screen.**

---

## A. Measurement integrity (collect / report / judge) — these can misstate results

### A1. CONFIRMED [high] collect.ts:246 — judge verdicts can never be folded into the manifest
`parseJudgeMetrics` runs only inside `collectEntry`, which runs only for `!entry.collected`
entries. But entries become terminal-and-collected in the same update (collect.ts:263-276), and
`judgeBench` (judge.ts:89) refuses non-terminal entries. Both orderings fail: judge-before-collect
judges nothing (state still queued/running, run logs not yet pulled); judge-after-collect writes
`judge.json` artifacts that no later collect ever reads, because line 246 skips collected entries
forever. The comment at collect.ts:554-556 ("a later collect pass folds the verdict in") describes
code that does not exist.
**Scenario**: the documented workflow (runs land → `bench judge` → `bench collect`) leaves the
report's `## Judge` section permanently at "_No run has judge metrics yet_" — which is exactly
what the current 2026-08-01 report shows — and the Disagreements list (the wrong-scope class the
judge exists for) is never populated. One undocumented path works: the per-stamp core judge CLI
run *before* the entry's first collect.

### A2. CONFIRMED [high] collect.ts:257 — a failed pull with an intact job record permanently records a finished run as "crashed"
Collect defers only when `!pulled.ok && !job`. `pull()` returns `ok:false` *with* the job record
whenever any rsync leg fails (dispatch.ts:677 — the job query is a separate ssh call). Collect then
proceeds off the local tree that never received `run.json`: `metrics = {success:false}`,
failureKind `crashed`, `collected:true` — and line 246 guarantees it is never revisited. The
actual pull error is dropped; the log prints a "✓ done" line.
**Scenario**: a filmed phase-5 run (thousands of frame PNGs) hits PULL_TIMEOUT_MS or one network
blip during a collect tick. The run succeeded on the Mac; the manifest freezes it as a crash
forever. Arm success rate understated, top-up re-dispatches a duplicate run (real spend), three
blips on one host trip the poisonedHosts warning against a healthy Mac. Re-collect cannot repair it.

### A3. CONFIRMED [high] collect.ts:295 — lost-update race between collect and phase dispatch erases manifest entries
Collect reads the manifest once (line 241), holds the in-memory snapshot across a pass that can
run many minutes (per-entry ssh pulls; humanize execFile has a 10-minute timeout), and rewrites
the ENTIRE manifest per entry (275) plus unconditionally at 295. `runPhase`/`runCompiles`/
`runChallenger` do the same read-modify-write from the other side. Any submission recorded between
collect's read and next write is silently deleted. Dispatch-erases-collected-flag self-heals on
the next collect; collect-erases-submission does not — nothing re-creates the entry.
**Scenario**: dash runs `--collect` (60s loop); operator runs `./run bench phase 3 --go` mid-pull.
The 6 replay submissions vanish from the manifest; the fleet still executes them, collect never
pulls them, the report never counts them, and re-running the phase dispatches 6 duplicates.

### A4. CONFIRMED [medium] report.ts:64 — grounding-mismatch runs still count as successes in rollup()
`groundingChecked` stamps `failureKind:"grounding-mismatch"` without touching `success`;
manifest.ts:69-74 documents that the flag "disqualifies a row from its arm's average exactly as a
failure does"; nothing implements that. `rollup()` counts the run as a success AND
failureBreakdown counts it as a failure (successes + failures > n). The dash compounds it:
`entryView` (dash.ts:287) renders it "succeeded" — the "red row" promised in collect.ts:374 never
appears for a successful mismatched run.
**Scenario**: phase-1 map never syncs to mac2; all three p2-cdp-grounded runs load provenance
"none" but succeed by ad-hoc discovery. The grounded arm reports success 3/3 — ungrounded behavior
credited to the grounded arm in the benchmark's headline comparison.

### A5. CONFIRMED [medium] judge.ts:92 — `bench judge --cross` never cross-judges already-judged runs
The already-judged skip (`judge.json` exists → continue) sits before the cross-judge block, which
only executes after a fresh primary judge. The documented use — plain `bench judge` repeatedly
while the queue drains, then `--cross` once the challenger lands — cross-judges only the few
not-yet-judged stragglers and silently skips the bulk of the head-to-head.

### A6. CONFIRMED [medium] manifest.ts:191 — the archive's manifest backup is frozen at the first collect
`archiveBench` hard-links via `backupTree`, whose contract is skip-if-exists (paths.ts:289) —
sound for write-once run artifacts, wrong for `manifest.json`, which is replaced by temp+rename on
every write (new inode severs the archive's link). The archived manifest is permanently the
first-collect snapshot; the collect.ts:296-300 comment claims each collect banks judge verdicts
and costs into the backup. Reachable trigger (per verifier): raw deletion of out/bench/live, or
simply handing out/bench/archive/<date>/ to someone as the self-contained record collect.ts:287-289
says it is. (`runs purge/drop` exclude manifest date dirs, so they are NOT a trigger.)

### A7. CONFIRMED [low] report.ts:191 — the explore table silently drops the second sample of an n=2 explore arm
`exploreTable` resolves one entry per (arm, model) with `.find(x => x.collected)` — first in
manifest order. p1-explore-{ax,cdp} deliberately run n=2 for the error bar; the second pass's
discovery numbers (graphNodes, surfaces, controls, actions, tokens) appear nowhere in the report,
its cost is missing from the explore row's $ cell (though present in aggregate Cost), and the
dash's median-across-passes will disagree with the report's single draw over the same manifest.

## B. Dashboard lineage & graph anchoring (dash.ts data half)

### B1. CONFIRMED [high] dash.ts:1129 — groundingArmId mis-attributes the `-axmap` cross arms to the vision explore pass
`armAppmapSlug` (matrix.ts:708) derives the map tier from the arm's perception flags
(`visionOnly: Boolean(arm.dispatch.noAx)`), but the run-time loader derives it ONLY from
APPMAP_VARIANT env — which p2/p5-vision-only-grounded-axmap deliberately do not set, precisely so
they read the ELEMENT map (appmap.ts:485-498's own comment forbids this exact inference).
Executed over the matrix: both -axmap arms attribute to p1-explore-vision — identical to
-visionmap, whose entire point is being different. The attribution test (tests/dash.test.ts:861)
is circular: it checks against armAppmapSlug itself.
**Impact**: board nests the -axmap arms under the wrong explore pass; run detail loads the vision
graph for runs that grounded on the ax map; matchPath anchors steps/mutation rings against nodes
the run never saw; heat is credited to the wrong graph. Runs and measurements themselves are
unaffected (dashboard-only).

### B2. CONFIRMED [high] dash.ts:1217 — resolveGraph's archived per-pass appmap lookup is dead code for task/replay rows
`archiveDirFor(benchRoot, {...entry, armId: exploreArmId})` substitutes the arm id but keeps the
TASK run's jobId — a path nothing creates, since collect archives explore maps under the EXPLORE
run's own jobId (collect.ts:316-324, per-job keying added in 1ee8a44; the dash call site dates
from 5091715 when keying was per-arm). ENOENT is swallowed and every task/replay detail falls to
the live docs/appmaps file — the app-keyed copy the next pass overwrites. The "archived per-pass
copies first" resolution exists for exactly these rows and never fires for them.
**Scenario**: two-model self-grounded passes — model B's explore overwrites docs/appmaps, and a
model-A run's detail renders model B's graph while graphSource claims "(live)" truthfully but
uselessly. Same after any re-explore of a variant with older task runs on the board.

### B3. CONFIRMED [medium] dash.ts:1098 — heatFor counts ungrounded/curated/recipe runs into a graph's traversal heat
The filter is `groundingArmId(a) !== exploreArmId`, but groundingArmId ignores
`noGrounding`/`useCurated`/`useRecipes` (armAppmapSlug takes none as input) — so p2-*-ungrounded,
p2-curated, and all four p6 recipe arms (including recipe-from-ungrounded, defined by having
no map) count as consumers of their backend's explore graph. Edge thickness — "the map funneled
traffic down these edges" — aggregates runs the map never informed, inverting the
grounded-vs-ungrounded comparison the display feeds. Display-only.

### B4. CONFIRMED [medium] dash.ts:1175 — matchPath: an off-surface edge fallback outranks an exact control match on the current surface
`edges.find(e => e.from === surface) ?? edges[0]` — when the clicked name matches an edge from a
DIFFERENT surface, edges[0] asserts a surface transition even when a control with that exact
title exists on the current surface (the control branch is only reached when no edge anywhere
matches). The walk teleports; every later step's same-surface preference keys off the wrong
surface. Verifier nuance: the `?? edges[0]` fallback itself is load-bearing (the walk starts at
"root", which the yarn maps don't contain — first steps can only anchor through it); the defect is
its priority over same-surface control matches, e.g. "New Draft" (edge library→library/new-draft
AND a control on your-drafts).

### B5. CONFIRMED [low] dash.ts:1573 — the new model-divergence note false-fires on a machine that matches the fleet
**Feedback on the in-flight model fix**: `makeClient().model !== BENCH_PRIMARY_MODEL` compares the
Azure-STRIPPED deployment name (model.ts:65 returns `gpt-5.6-sol`) against the prefixed
`azure/gpt-5.6-sol` — unsatisfiable for any azure/* id, so any machine with Azure keys logs
"this machine's default model differs" in exactly the matched configuration the note exists to
greenlight. Normalize both sides (cost.ts:89 `normaliseModel` or strip the prefix) before comparing.

### B6. CONFIRMED [low] dash.ts:1592 — the Findings card can seed another pass's narrator note
`readPersistedNarrative` returns the newest event from the GLOBAL out/bench/live/narrative.jsonl
with no manifest-membership filter (the `date` param scopes only the legacy narrative.md
fallback); the seed guard checks only that this date's manifest has collected entries. Revisiting
pass A's dash after pass B has minted notes displays pass B's newest note as pass A's findings.

## C. Dashboard server & frontend

### C1. CONFIRMED [high] dash.ts:2559 + 2301 — SSE heartbeat and hot-reload broadcasts lack the dead-client guard push() has
`push()` (1623-1636) wraps its per-client `res.write` in try/catch, with a comment recording that
a throw here really did escape as an unhandled rejection. The heartbeat interval (2557-2560) and
the dev hot-reload broadcast (2301) do the identical fan-out over the same `clients` set with no
guard — same torn-down-socket race, same crash, different timer. (Verified directly during
write-up, not by the workflow's skeptic pass.)

### C2. CONFIRMED [high] dash.html:1284 — the log pane latches done on the first non-live reply
`pollPane` treats any reply without `live:true` as run-complete. The server produces live:false
for live runs two ways: (1) /api/logs' local fast path derives state from job.json, which
CLI-started local runs don't have — exactly the runs the synthetic "local" fleet card surfaces —
so their panes freeze on the first poll with a red "Unknown" chip while log.txt grows for 40
minutes; (2) a 10s ssh stall truncates the `{done:true}` terminal frame mid-stream and passes the
502 guard as state "unknown". `finalQueued` is never reset by a later live:true, so blips
accumulate to a permanent freeze; a pane opened mid-run streams the whole log from byte 0 in its
first reply, making the truncation-on-first-poll variant likely on long runs.

### C3. CONFIRMED [low] dash.html:894 — compileRow's cells are misaligned with the board header
compileRow emits the source-run cell in position 4 ("Acts With") with dashes under "Task" and
"Sees" — the hand-built row was not updated when 5eade56 reordered the header (taskRow/exploreRow
go through armCell and stayed aligned). Its own comment promises the Task column shows the source
stamp; srcCell even carries class="task".

## D. Plausible but unverified (verifier budget exhausted; frontend scope)

Deduplicated against the confirmed list (the finder overlap re-found B2, B3, C2, C3 — those are
confirmed above). Remaining five, unreviewed by a skeptic — treat as leads, not verdicts:

- [medium] dash.html:1626 — render()'s catch fallback sets `targetFilter="All"` (a value that
  selects nothing) and re-calls visibleStats() unguarded; the recovery path may freeze the page.
- [low] dash.html:1263 — the run-log pane loses reader scroll position on every SSE push.
- [low] dash.html:2038 — elapsed tickers rebase to fleet-poll-stale bases on manifest pushes;
  running timers can jump backwards.
- [low] dash.html:398 — filtered cost recompute counts tokenless entries (compiles/refusals) as
  priced runs, disagreeing with the server/report.
- [low] dash.html:925 — the detail cache never refreshes post-collect, freezing the full-tree's
  cross-run traversal heat at first-fetch time.

---

## Suggested fix order

1. **A2 + A3** (collect corruption: false "crashed" verdicts, lost submissions) — these destroy
   manifest truth and cost real re-dispatch money.
2. **A1 + A5** (judge folding + --cross) — the judge pipeline is currently write-only; the
   labeled-runs plan depends on it.
3. **A4** (grounding-mismatch counted as success) — one-line semantics fix in rollup(), plus
   entryView's status precedence.
4. **B1 + B3** (share a root: armAppmapSlug/groundingArmId ignore variant env + grounding-tier
   flags — fix the attribution function once, both fall) and **B2** (pass the explore run's jobId,
   which means resolving WHICH explore job grounded the run — or archiving maps under an arm-level
   alias too).
5. **C1** (3-line try/catch symmetry), **C2** (trust live:true only as a latch-up, never latch
   done off "unknown"), **B5** (normalize before comparing — worth folding into the uncommitted
   model fix before it lands), then the rest.

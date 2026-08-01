# 2026-08-01 phase-1 attempt 5 — archived for analysis, not results

Stopped by David mid-pass. **Nothing here is a benchmark result** — the pass never completed
and two arms are miscounted (see below). It is kept because the failures are the most
informative thing the night produced.

Dispatched 06:56 UTC, all nine arms, `--model azure/gpt-5.6-sol`. Stopped ~07:30.

## What each arm did

| arm | state | what actually happened |
|---|---|---|
| `p1-explore-cdp-no-vision` | **done** | The only success. Wrote `yarn.cdp.novision.{md,json}` — the first new map of the night, and proof the CDP paint fix holds. |
| `p1-explore-ax` | orphaned | Runner on mac1 restarted at 07:02:54; launchd took the job's process group with it. Salvaged 2 findings / 11 nodes of a 150-node pass. Correctly classified TECHNICAL. |
| `p1-explore-no-vision` | failed | Published **no** map — `docs/appmaps/yarn.ax.novision.*` on disk is from Jul 31 20:57. Cleanup: 0 restored, 1 failed, 1 still dirty. |
| `p1-explore-ax-noaxdom` | failed | Published **no** map — `yarn.ax.noaxdom.*` does not exist anywhere. Cleanup: 3 restored, 4 failed, 4 still dirty; one restore threw "not observable". |
| the other five | running/queued | Stopped before finishing. |

## The defect that makes two of these miscounted

`p1-explore-no-vision` and `p1-explore-ax-noaxdom` produced no usable grounding, but
`technicalFailure()` classified them NON-technical — so `submittedCount` counts them as
delivered samples and re-running the phase will NOT replace them.

Cause, and it is an interaction between two changes made hours apart on 2026-08-01:

1. `writeArtifacts` was changed to ALWAYS write the run-local `appmap.md`, including for a
   DEMOTED pass — one that did not sweep its frontier and is deliberately withheld from
   `docs/appmaps/`. That is correct on its own: the run folder should record what the pass
   produced.
2. `technicalFailure` detects a dead explore by looking for collect's note `"no appmap at …"`.
   But collect prefers the run-local copy, which (1) had just guaranteed always exists. The
   note can no longer fire.

Both archived run folders show it plainly: `appmap.md` and `appmap.json` are present, and
neither was published.

The unit test passes because it feeds the note directly rather than going through collect.

**The fix**: for an explore arm the question is not "is there a map" but "did it PUBLISH one".
Compare the run-local `appmap.md` against `docs/appmaps/<armAppmapSlug>.md` — absent, or
differing, means the pass was demoted and produced nothing usable.

There is a downstream catch — phase 2 would ground on nothing, record `provenance: "none"`,
and `groundingChecked` would flag the mismatch — but only after ~45 runs are spent.

## Other findings from this attempt, already fixed in code

- **Runner restarts orphan running jobs.** `./run provision` reinstalls the LaunchAgent, which
  boots the runner and kills whatever it was running. A concurrent session provisioning at
  07:02 cost `p1-explore-ax`. Provision should refuse while a runner is busy — **still owed**.
- **The dash pins its date at startup** (`parseDashArgs`) and never re-resolves, so four dash
  processes spent the night auto-collecting 2026-07-31 while the pass was 2026-08-01. That is
  why nothing collected until it was run by hand. **Still owed** (dash.ts is owned by a
  concurrent session).
- **The model was inferred from ambient keys.** Fixed: `BENCH_PRIMARY_MODEL` is stamped onto
  every dispatch by `runPhase`, and the manifest records it.
- **A foreground follow hitting a caller's 600s cap killed healthy runs.** Fixed by dispatching
  under `run_in_background`, and by `bench watch`, which holds no leash.

## Earlier attempts the same night

`killed-2026-08-01-attempt2/`, `killed-2026-08-01-attempt3/` and the 00:00 / 03:07 / 03:16 /
06:01 / 06:11 batches all died to the 600s-cap mechanism above rather than to anything about
the agent. None are results either.

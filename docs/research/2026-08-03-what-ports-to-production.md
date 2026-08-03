# What ports to production — reading the 49k lines

*2026-08-03. Companion to `docs/research/2026-08-03-findings-summary.md`, which says what the
agent can do. This one says what of the code survives a production build inside Yarn, and why
the total is as large as it is.*

The prototype is 49,412 lines of TypeScript across `src/` and the Electron shell, plus 28,169
lines of tests, measured at `6585784`. That is a lot for seven days, and the honest reaction to
it is "why?" The answer is that only about a third of it is the agent. The rest is what had to
exist around the agent to make it *trustworthy* and *demonstrable* on machines nobody was
sitting in front of.

## The count

Every module lands in exactly one bucket. **The line counts are measured; the buckets are a
judgement** — mine, argued below, and re-derivable with `scripts/loc-buckets.sh` so that a later
refactor tells you when this write-up has expired rather than letting it quietly rot.

| bucket | lines | share | what it means |
|---|---|---|---|
| **ships** | 15,547 | 31% | Moves to production largely intact |
| **redesign** | 7,798 | 15% | The design is a production concern; the code is rewritten against Yarn's infrastructure |
| **internal** | 5,553 | 11% | Worth keeping as a regression suite; not shipped product code |
| **scaffold** | 20,514 | 41% | Existed to run the trial |

Tests split roughly the same way: of 28,169 lines, ~9,700 exercise the engine and travel with
it; ~11,400 test fleet management, the shell and the cursor renderer, and evaporate with them.

## The 31% that ships

| lines | area |
|---|---|
| 4,131 | Harness and the verification layers — the four-layer gate in `architecture.md` §2 |
| 2,370 | Agent loop — observe / decide / act / verify, and the tool schema that forces an expectation |
| 2,175 | CDP backend + Electron attach — the driving mode the findings recommend as primary |
| 2,105 | Explore / grounding pipeline — appmap generation, frontier, scope-ambiguity detection |
| 1,527 | Core support — target kinds, axdom join, driver seam, destructive-boundary classifier, home state |
| 1,117 | Journal + teardown + cleanup — the run puts the app back |
| 902 | Procedures, recipes, replay |
| 793 | Shared types, env, install-path resolution |
| 427 | Offline run judge |

Two things about this list are worth more than their line counts.

**The verification stack is the largest single item, and that is the correct shape.** 4,131 lines
of harness against 2,370 lines of agent loop is a 1.7:1 ratio of checking to acting. That is
where the credibility comes from: the findings summary can say "the agent's own report is
trustworthy — the independent judge disagreed on 4 of 139 runs" only because there are four
independently-failing layers underneath it. A thinner agent would have been quicker to write
and would have produced numbers nobody should believe.

**Teardown is 1,117 lines because it refuses to trust the model.** The journal diffs *control
values* across observations rather than reading the agent's account of what it changed, matches
by (name, surface) rather than by handle, and appends the instant a change is detected so a
crash is recoverable. Every one of those decisions costs code, and every one of them is the
difference between "we undo what it says it did" and "we undo what actually happened." In
production, running against a customer's live workspace, this gets *more* load-bearing, not less.

## The 15% whose design ports but whose code doesn't

| lines | area |
|---|---|
| 3,768 | Job registry, liveness lease, per-operator profile swap, session/browser wipe |
| 3,003 | Liveview — watching a run happen, window-scoped, with input injection |
| 1,027 | CLI surface, which becomes an API or IPC surface |

These solve real production problems with implementations shaped entirely by the trial's
constraint of three colocated Macs driven from a laptop. The durable job queue that survives
runner restarts *because it is the registry* is a good design and Yarn will need one; it will
not need this one. Liveview is the same story — "let an operator watch and intervene" is a
product feature, and 3,000 lines of ScreenCaptureKit-over-WebSocket is one answer to it, not
the answer.

**This bucket carries the assumption that moves the total more than anything else in the
document.** It was written without reference to Yarn's existing services, because the trial ran
against a repo I didn't have. If Yarn already has job orchestration and host management, most
of these 7,798 lines are a design note. If it doesn't, more of them survive than I am crediting
here. Worth five minutes with whoever owns that infrastructure before anyone plans against this
table.

## The 11% that stays as tooling

5,553 lines of eval harness — the run matrix, phase orchestration, result collection, cost and
true-cost accounting, fleet-wide judging, recipe harvesting.

This is not shipped code and it is not waste. It is what produced every number in the findings
summary, and it is what caught five separate measurement errors that each made the prototype
look better than it was: hinted prompts described as autonomous, a run that passed with nothing
checked, a lenient pass/fail check, contaminated grounding notes, a hand-copied log. A
production build wants this as a regression suite, because the failure mode it defends against
— *the demo looks right and changed the wrong thing* — is the one the findings flag as still
unresolved.

## The 41% that was scaffolding

| lines | area | why it dies |
|---|---|---|
| 7,165 | Fleet management — SSH, provisioning, install, enrollment, hosts, team, dispatch | Bespoke colo-Mac administration from a laptop |
| 5,013 | Electron shell — the trial's own UI | Yarn's app is the UI |
| 4,739 | The published board — dashboards, graphs, snapshots | A research artifact; it did its job |
| 1,933 | Cursor renderer | Yarn already does this in post |
| 944 | Research probes | One-off questions, since answered |
| 720 | The `ax`/cua path and the "being driven" banner | Dominated by CDP; see below |

Two of these are worth a sentence each, because they are cases where building the thing was the
point even though the code doesn't survive.

**The cursor renderer (1,933 lines) was built to prove a claim, not to ship.** Yarn composites a
synthetic cursor in post and time-compresses demos, so the agent's 10-second thinking pauses
never reach a viewer — which is why latency came off the risk list. But "our step records are a
sufficient feed for your renderer" is a claim, and the cheapest way to make it checkable was to
render it. The part production needs is the 83-line trajectory writer that emits the feed. The
other 1,850 lines are the argument that the feed is real.

**The `ax`/cua path is only 720 lines here, but deleting it removes a dependency.** The findings
recommend CDP as primary; `architecture.md` §1 records that a third backend was already deleted
as dominated. If production targets Electron and web only, `@trycua/cua-driver` goes with it —
leaving two runtime dependencies total — and the 226-line `axdom` join plus its Swift sidecar
become unnecessary, because a first-party target can expose stable element identity directly
instead of having it reverse-engineered out of Chromium's accessibility bridge.

## Why a third ports, rather than nothing

Three decisions, all made early, are why the engine is liftable at all.

**One actuator seam.** Only `src/core/driver.ts` imports the driver; everything else speaks
`Observation` / `ActionRequest`. Swapping the entire substrate is a leaf-node change — which is
how a second backend got added, and a third deleted, without touching the loop. Had the driver's
types leaked into the agent, none of the 15,547 lines would move.

**Three runtime dependencies.** `@anthropic-ai/sdk`, `@trycua/cua-driver`, `playwright-core` —
and one of the three is the one you'd drop. There is no framework to unwind.

**Paths resolve from the install, not the working directory.** A dull 396-line module that
exists because a LaunchAgent and a packaged `.app` both start at `/`, and both would silently
write to `/out` and run ungrounded while appearing to work. Any production deployment has that
same problem.

## What transfers that isn't code

Probably the highest-value part of the handover, and it doesn't appear in any line count:

- **`LIMITATIONS.md`** (770 lines) — the failure modes found by hitting them. TCC permission
  inheritance, the shared-daemon fatality, the dual-scope wrong-setting trap, dropdowns
  invisible to capture. A rewrite rediscovers these expensively.
- **`architecture.md`'s revisit-if conditions** — every decision carries the condition under
  which it expires, so the next person can tell doctrine from an expired guess.
- **The measurement rule enforced in code, not by memory** (§3). Task prompts are audited for
  method hints and rejected; run logs are written only by the harness. Both exist because the
  rules were violated while being enforced by good intentions. That is a cultural artifact worth
  more than most of the modules above.

## What production adds that the trial never needed

"15,547 lines port" is not "15,547 lines and you're done." Absent entirely from this codebase:
authentication and multi-tenancy, concurrency beyond one run per host, the customer-facing
surface, retention and deletion policy for recordings that contain real workspace data
(findings summary, Q2 — still unresolved and still a product decision), and whatever it takes
to sign and notarize a bundle if any of this runs client-side.

## What would change these numbers

- **Yarn's existing infrastructure**, as above — the single biggest unknown.
- **Whether native Mac apps come back into scope.** Currently out (one pass, one diagnosed
  fail). If they return, the `ax` path and the Swift sidecar move from scaffold to ships, and
  the cua dependency stays.
- **Whether procedures get fixed or dropped.** 902 lines are in the ships bucket on the strength
  of recipes going 3/3; procedures went 1/3 with a repair model and 0/3 without. If procedures
  are abandoned rather than fixed, ~380 of those lines leave.
- **Whether the eval harness gets kept.** I have it as internal tooling because the findings
  argue reliability is the next problem. Treated as a trial artifact instead, `ships` stays put
  and 5,553 lines move to scaffold.

## Re-deriving this

    scripts/loc-buckets.sh            # the bucket table
    scripts/loc-buckets.sh --files    # every file with its bucket, for arguing with the calls

The classification lives in one `case` statement in that script. Disagreeing with a call means
editing one line and re-running, which is the intended way to have the argument.

It prints the commit it measured, because the first draft of this write-up didn't and drifted
four lines mid-analysis when a commit landed underneath it. Any figure above that disagrees with
a fresh run means the tree moved, and the run wins.

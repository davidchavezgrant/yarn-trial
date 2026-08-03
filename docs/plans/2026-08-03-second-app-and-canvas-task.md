# Phase 8 (second app) and the canvas task — drafted, not wired

**Status**: draft. Nothing is in `matrix.ts` yet, deliberately — the 203-run pass is draining and
the fleet rsyncs the checkout per phase. Moving HEAD mid-pass is the defect this repo already
warns about; wire this after the drain.

**Why these two**: the matrix is at its ceiling (11 of 15 phase-2 arms at 3/3), and the axis the
brief cares most about is unmeasured. Jasper's brief: *"This should theoretically work on
arbitrary apps, although we'd budget some setup time (e.g. 24 hours)."* Nothing in 203 runs
touches cross-app transfer. Every finding so far — CDP beats AX, lean beats rich, the sidecar is
worthless — is currently indistinguishable from a fact about Yarn's DOM.

---

## Part 1 — Phase 8: the second app

### Which app, and why it is GitHub Desktop

Inventoried across the fleet (2026-08-03, read-only ssh):

| app | mac1 | mac2 | mac3 |
|---|---|---|---|
| Yarn | ✓ | ✓ | ✓ |
| **GitHub Desktop** | ✓ | ✓ | ✓ |
| Claude | ✓ | ✓ | ✓ |
| Chrome / Safari | ✓ | ✓ | ✓ |
| Cursor | ✓ | — | — |
| Codex | — | ✓ | ✓ |
| Warp | ✓ | ✓ | — |
| After Effects, Cinema 4D | ✓ | — | — |

Only GitHub Desktop and Claude are Electron *and* on all three. This is the same wall that killed
the Notion slice — `matrix.ts:140` records it as logistical, not conceptual — so start from what
is installed rather than from what would be ideal.

GitHub Desktop wins on three counts, and the third is the important one:

1. **Electron, so the whole matrix runs unchanged.** `electron-attach.ts` resolves any `.app`
   bundle by name and relaunches it with `--remote-debugging-port`; there is no app allowlist.
   Both backends work without a harness change.
2. **It has the same dual-scope failure class Yarn has.** Git config is global (`~/.gitconfig`)
   versus repository-local (`<repo>/.git/config`) — structurally identical to Yarn's brand
   default versus per-document override, which is the correctness half of every phase-2 finding.
   Phase 4 chose motion blur over auto-zoom on exactly this criterion.
3. **The two scopes write to two different files, so the wrong-scope failure has objective ground
   truth for the first time.** LIMITATIONS §8 is the standing blocker on every correctness claim
   in this project: `verify()` proves *a* control reads the target value, never that it is the
   *intended* one, and the offline judge patching it is one model's opinion. Here the check is
   `git config --global --get user.email` against `git config --local --get user.email` over the
   ssh the collector already holds. No model in the loop.

That third point is worth more than the cross-app evidence. It is the only task in the matrix
whose correctness can be settled without asking a model.

### The task

```ts
export const SECOND_APP = "GitHub Desktop";

/**
 * Goal-only, and dual-scope by construction: git config is global or repository-local, and
 * GitHub Desktop exposes both (Preferences ▸ Git, Repository settings). Naming no repository
 * implies the global scope, the same way the cursor task implies the brand default.
 *
 * Chosen for the same reason phase 4 chose motion blur over auto-zoom: a single-scope task can
 * generalise the actions/tokens half of phase 2 and none of the correctness half.
 */
export const SECOND_APP_TASK = "show me how to change the email address used for commits";
```

### The arms

Derived from the phase-2 grid rather than hand-written, the rule `creationArms()` and `filmed()`
already follow — but a deliberate subset, because the point is to re-test the three findings that
would change what Aman builds, not to re-run everything.

```ts
/**
 * The six cells that produced phase 2's shippable conclusions. Re-run on a second app, they
 * answer the only question the matrix cannot currently answer: is any of this about the METHOD,
 * or is it about Yarn's DOM?
 */
const TRANSFER_CELLS = [
	"p2-ax-ungrounded",           // does ax need grounding — the 1/3 that started everything
	"p2-ax-grounded",             //   "
	"p2-cdp-ungrounded",          // is cdp grounding-independent, or is Yarn just easy on cdp
	"p2-cdp-grounded",            //   "
	"p2-min-context-grounded",    // does lean-beats-rich transfer, or is it a Yarn artifact
	"p2-ax-grounded-axdom-off",   // is the sidecar still worth nothing off its home app
];

const secondAppArms = (): Arm[] =>
	[...PHASE2_CORE, ...PHASE2_SLICES]
		.filter((a) => TRANSFER_CELLS.includes(a.id))
		.map((a) => ({
			...a,
			id: a.id.replace(/^p2-/, "p8-"),
			phase: 8 as Phase,
			app: SECOND_APP,
			task: SECOND_APP_TASK,
		}));

const PHASE8: Arm[] = [
	// Three passes, not two: min-context consumes APPMAP_VARIANT=novision, which only exists if
	// a no-vision pass wrote one. Grounding an arm on a map its treatment did not produce is
	// LIMITATIONS §23 with the sign flipped.
	...(["ax", "cdp"] as const).map((backend): Arm => ({
		id: `p8-explore-${backend}`,
		phase: 8, kind: "explore", app: SECOND_APP, n: 1,
		dispatch: { backend },
		informs: "does the discovery story hold on an app nobody tuned the harness against",
	})),
	{
		id: "p8-explore-no-vision",
		phase: 8, kind: "explore", app: SECOND_APP, n: 1,
		dispatch: { backend: "ax", noVision: true },
		informs: "the novision map min-context needs; also the second sample of vision's cost in discovery",
	},
	...secondAppArms(),
];
```

**One test to add.** `TRANSFER_CELLS` names arm ids as strings, and a typo silently drops a cell —
a smaller version of the `dispatchOptionsFor` failure that bit this repo three times. Assert every
id in the list resolves to an arm.

### What this costs

| | runs | wall clock | est. $ |
|---|---|---|---|
| 3 explore passes | 3 | 40–60 min (parallel, one per Mac) | $15–50 |
| 6 task arms × n=3 | 18 | ~45 min | $25–50 |
| **total** | **21** | **~2 h** | **$40–100** |

Cut to the four core cells (12 runs, 2 explores) if the budget is tight; that still answers the
headline. The last two arms are what turn "grounding is backend-dependent" and "don't ship the
sidecar" from Yarn facts into method facts.

### Prerequisites, and one genuinely new risk

- **Sign-in and a known repo, on all three Macs.** GitHub Desktop needs an account and one cloned
  repository in a known state, or every run dies at the equivalent of the exit-3 gate that killed
  29% of archived runs. Phase 0, not a benchmark step.
- **Confirm the debug port opens.** GitHub Desktop is Electron, but a hardened build can strip
  `--remote-debugging-port` — the same fuse problem the peek sentinel works around. Five minutes
  on a free Mac settles it, and if it fails the cdp arms are void, not merely worse.
- **NEW: teardown does not reach outside the app.** Cleanup restores in-app mutations from the
  journal. A run that rewrites `~/.gitconfig` leaves it rewritten for the next run on that Mac —
  start-state contamination that propagates *between arms*, which is worse than §23's version
  because it crosses runs rather than beginning them. Needs an explicit reset of both config
  scopes before each run, and it should be the same code that reads them for the ground-truth
  check.

### The honest limit of this evidence

GitHub Desktop is Electron. This measures transfer *within* the class the method was built for —
Chromium, DOM-rich, AX-backed. It does not test the class boundary. The apps that would are on the
fleet (After Effects, Cinema 4D, both native and custom-drawn), both on mac1 only, and native is
out of scope per the 07-30 decision. Say so in the report rather than letting "it transferred"
carry more weight than it earns.

---

## Part 2 — the canvas task: criteria first, then a probe

### The gap

**Nothing in the matrix has tested the vision axis.** Cursor type, motion blur, and the creation
task all route through menus, dropdowns, and text fields — surfaces that are pure text in both AX
and DOM. Dropping screenshots costs nothing on such a task, which is exactly what phase 2 measured:
`min-context` (no vision, no DOM attrs) was the cheapest arm *and* the shortest at 7.3 steps.

That result is currently unfalsifiable rather than strong. It says vision is worthless on tasks
where vision is irrelevant.

### The criterion

A task discriminates the vision axis only if **its route passes through a control with no text
handle in either channel**. Yarn has such surfaces — LIMITATIONS §5 measured 377 addressable
elements and exactly one AXImage while a dozen video thumbnails rendered — and the appmap names
them: canvas, timeline, Timeline Zoom, object toolbar, and the paint picker, where
"Radial/Linear expose on-canvas handles and gradient stop controls"
(`docs/appmaps/yarn.cdp.md:129`).

Second criterion, from phase 7's lesson: **the terminal state must be checkable without a model.**
Phase 7's difficulty is real but its output is prose in a rich editor — 8–14 unverifiable steps out
of 15, one success passing with nine. A hard task with a cheap check beats a hard task with an
expensive one; otherwise you stack a second measurement problem on the first.

### Candidate

```
"show me how to give the canvas a radial gradient background"
```

The terminal state is a background type — a value, checkable. The route passes through the canvas
paint picker, which is the part no text channel describes.

### Settle this before spending 45 runs

If "Radial" turns out to be a labeled button and clicking it completes the task, the route never
leaves text and the arm measures nothing new. That is a measurement, not a guess, and it costs one
CDP observation with the paint picker open, counting how many controls on the route carry a name —
two minutes on a free Mac. Same discipline the `seen`-is-list-rows hypothesis needs.

Only if the probe confirms unnamed controls on the route is the task worth arms. And then: **add
it to the four or five configs that still differ, not all fifteen.** Adding every task to every
config is how the plan reached 203 runs, most of them re-confirming a pass.

---

## Sequencing

1. **Now** — nothing. The pass is draining; the probe reports when it ends.
2. **On drain** — fix the dangling `if` at `run.ts:898`, collect, judge, read phase 7. It may have
   restored dynamic range on its own, which changes what comes next.
3. **Then** — phase 8. Highest value per run in the project, and the only thing that speaks to the
   brief's central promise.
4. **Then, conditionally** — the canvas task, if phase 7 came back at ceiling and the paint-picker
   probe confirms the route leaves the text channel.

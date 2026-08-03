# Phase 8 (Notion web) and the canvas task — drafted, not wired

**Status**: draft. Nothing is in `matrix.ts` yet, deliberately — the 203-run pass is draining and
the fleet rsyncs the checkout per phase. Moving HEAD mid-pass is the defect the methodology review
just wrote up.

**Target**: `app.notion.com` in Chrome. David's call (2026-08-03), and the brief's own example —
Jasper named Notion Calendar as the canonical case. GitHub Desktop was drafted first and is kept
as an appendix, because two things it surfaced are worth keeping on record.

**Why a second app at all**: the matrix is at its ceiling (11 of 15 phase-2 arms at 3/3), and
nothing in 203 runs touches cross-app transfer. Every finding — CDP beats AX, lean beats rich, the
sidecar is worthless — is currently indistinguishable from a fact about Yarn's DOM.

---

## Part 1 — Phase 8: Notion web

### What the target supports, measured before designing around it

Three checks against the code and the existing artifacts, because each one moves the arm list:

**1. The AX backend refuses web targets outright.** `run.ts:395`:

```ts
} else if (target.kind === "web") {
    throw new Error("web targets run on the cdp backend — pass --backend cdp …");
}
```

So on Notion web the backend axis is **gone**. Four of the six arms drafted for GitHub Desktop —
`ax-ungrounded`, `ax-grounded`, `ax-grounded-axdom-off`, `min-context-grounded` — are impossible by
construction, not merely worse. "Is grounding backend-dependent?" cannot be re-tested here. If that
question matters more than the brief's app, the target has to be an installed Electron app instead.

**2. Vision-only still works.** The throw sits in the non-cdp branch, so `cdp + noAx` is reachable.
The vision-only arms transfer intact.

**3. Sign-in is a one-time setup, not per-run friction.** The consent-token problem
(LIMITATIONS §13) applies to cua-driver's `browser_prepare` path and is explicitly moot on
`--backend cdp`, which launches its own Chrome against a **persistent** profile
(`out/chrome-profile/yarn-runner`, `cdp.ts:57`) built so a human signs in once and every later run
reattaches. Same shape as the Yarn sign-ins — phase 0, per Mac.

### What is lost, and the better question it buys

Losing the backend axis is a real cost. What replaces it is arguably a more valuable question.

On Yarn, `cdp-ungrounded` and `cdp-grounded` both scored 3/3. That has two readings and one app
cannot separate them:

- **(a)** cdp doesn't need grounding — the shippable conclusion as currently written.
- **(b)** Yarn is too small for grounding to matter on any capable backend.

Notion web is a much larger target. From its own explore stamp (`web-app.notion.com.cdp.json`):

| | Yarn (cdp) | Notion web (cdp) |
|---|---|---|
| graph nodes | 144–207 | **471** |
| surfaces | 12–44 | **119** |
| controls seen | 293–6609 | 1238 |
| actuated / dismissed | 119–136 / 32–135 | 167 / 1075 |
| chapters | — | 34 |
| pass duration | 29–49 min | **1h14m** |

If grounding separates the arms here where it tied on Yarn, reading (b) wins and the headline
recommendation changes from "skip grounding on cdp" to "grounding's value scales with app size."
That directly attacks the confound in the one conclusion Aman would otherwise build on.

### Scope ambiguities: the correctness half does not transfer cleanly

Ran `findScopeAmbiguities()` over both committed maps rather than assuming — the same evidence-first
move phase 4 made when it chose motion blur over auto-zoom.

**Yarn**: 14 ambiguities, every one a clean two-store pair of the same setting.

```
screen-clip-cursor-style: brand-kit/screen-clips/cursor-style [brand] | draft-editor/screen-clips/cursor-style [document]
screen-clip-motion-blur:  brand-kit/screen-clips/motion-blur  [brand] | draft-editor/screen-clips/motion-blur  [document]
… 12 more, all the same shape
```

**Notion web**: 11 ambiguities, and most are **false positives**.

```
groups-sort:  settings/people/groups/sort [workspace] | page/to-do-list/database/sort [document] | … 8 more
search-filter: sidebar/search-overlay/filter [workspace] | library/filter [workspace] | … 7 more
library-group, library-property-visibility, people-search …
```

Those are not one setting at two scopes. They are generic UI verbs — sort, filter, group, search —
that the explore model happened to give the same `settingKey` on unrelated surfaces. `settingKey`
is free text the model invents and nothing validates it (`appmap.ts:340`), and on an app with
repeated database chrome the detector collides constantly. Only `open-settings`,
`view-history-visibility`, and possibly `calendar-connection` look structurally real, and none is a
value with two independent stores.

Two consequences:

- **The wrong-scope correctness test needs a hand-validated pair before it means anything here.**
  Notion does have genuine account-vs-workspace splits (Language & region, notification defaults),
  and the detector missed them — so it has false negatives on this app too. Ten minutes against the
  live app picks a real pair; do not take the list at face value.
- **This is itself a production finding.** The scope mechanism — grounding's strongest measured win
  — is tuned to Yarn's shape and degrades to noise on a database-heavy app. Aman needs to know that
  before shipping it as a general capability.

### The task

Default, pending the hand check above:

```ts
export const SECOND_APP_URL = "https://app.notion.com";

/**
 * The brief's own example, adapted from Notion Calendar to Notion web (My settings ▸ Language &
 * region). Goal-only, names the outcome and never the route.
 *
 * Whether it is DUAL-SCOPE is unverified: the detector's list for this map is mostly generic-verb
 * collisions, and the account-vs-workspace splits it should have caught are absent. Validate one
 * real pair against the live app before treating any wrong-scope number from these arms as
 * meaningful; the actions/tokens half stands either way.
 */
export const SECOND_APP_TASK = "show me how to change the timezone";
```

### The arms

Derived from the phase-2/7 grid rather than hand-written — the rule `creationArms()` and `filmed()`
already follow. Every surviving cell is cdp, per the constraint above.

```ts
const TRANSFER_CELLS = [
	"p2-cdp-ungrounded",              // does grounding matter on a BIG app — the reason to do this
	"p2-cdp-grounded",                //   "
	"p2-cdp-grounded-no-vision",      // does lean-beats-rich transfer off Yarn
	"p7-vision-only-cdp-ungrounded",  // the vision-only floor on a second app
	"p7-vision-only-cdp-grounded",    // does grounding rescue vision-only where it did not on Yarn
];

const notionArms = (): Arm[] =>
	[...PHASE2_CORE, ...PHASE2_SLICES, ...PHASE7]
		.filter((a) => TRANSFER_CELLS.includes(a.id))
		.map((a) => ({
			...a,
			id: a.id.replace(/^p[27]-/, "p8-"),
			phase: 8 as Phase,
			app: "app.notion.com",
			task: SECOND_APP_TASK,
			dispatch: { ...a.dispatch, url: SECOND_APP_URL },
		}));

const PHASE8: Arm[] = [
	// Two passes: full perception, and the novision map that p8-cdp-grounded-no-vision consumes.
	// Grounding an arm on a map its own treatment did not produce is LIMITATIONS §23 with the
	// sign flipped.
	{
		id: "p8-explore-cdp",
		phase: 8, kind: "explore", app: "app.notion.com", n: 1,
		dispatch: { backend: "cdp", url: SECOND_APP_URL },
		informs: "does the discovery story hold on an app 3x Yarn's size that nobody tuned the harness against",
	},
	{
		id: "p8-explore-cdp-no-vision",
		phase: 8, kind: "explore", app: "app.notion.com", n: 1,
		dispatch: { backend: "cdp", noVision: true, url: SECOND_APP_URL },
		informs: "the novision map the no-vision arm needs; second sample of vision's cost in discovery",
	},
	...notionArms(),
];
```

**One test to add.** `TRANSFER_CELLS` names arm ids as strings and a typo silently drops a cell — a
smaller version of the `dispatchOptionsFor` failure that bit this repo three times. Assert every id
in the list resolves to an arm.

### What this costs

| | runs | wall clock | est. $ |
|---|---|---|---|
| 2 explore passes | 2 | ~1h15m (parallel, one per Mac) | $20–40 |
| 5 task arms × n=3 | 15 | ~30 min | $15–35 |
| **total** | **17** | **~2 h** | **$35–75** |

The explores dominate, and Notion's was the longest pass in the matrix at 1h14m — that number is
the reason the slice was cut the first time.

**Reuse or re-run?** `web-app.notion.com.cdp.json` already exists (2026-07-31, `provenance: explore`,
`frontier-empty`, 471 nodes). It predates the prompt and frontier fixes that forced a re-run of
every Yarn phase-1 pass, so reusing it means phase 8 grounds on code that no other arm ran.
Re-running is the clean call; if the 1h14m is not affordable, reuse it and label the row loudly.

### Prerequisites

- **Sign in to Notion once per Mac**, in the runner's persistent Chrome profile
  (`out/chrome-profile/yarn-runner`). Without it every run maps the login wall — which is exactly
  what the 07-30 `www.notion.so` pass did.
- **A workspace in a known state.** Notion mutates easily; the explore stamp already shows one
  accidentally created blank private page. Decide what "put it back" means before running, because
  teardown restores what the journal recorded and nothing else.
- **Delete the legacy plain-slug map.** `docs/appmaps/web-app.notion.com.json` (19:13) sits beside
  `…cdp.json` (20:57) at identical size. LIMITATIONS §21 is precisely about a stale plain-slug file
  being silently picked up as an answer key.

### The honest limits of this evidence

- **No backend comparison.** Stated above; it is the price of the target.
- **Notion web is a browser tab, not an app with AX permissions.** This measures transfer to another
  Chromium DOM surface — the class the cdp backend was built for. It does not test the class
  boundary (native, custom-drawn), and it does not test the AX path at all.
- **n=3 against a ceiling, still.** If Notion also comes back 3/3 across the board, the result is
  "the method survives a bigger app", which is worth knowing and is not a comparison.

### Appendix — GitHub Desktop, considered and set aside

Recorded rather than deleted, the way `matrix.ts:140` recorded Notion, because two findings outlive
the decision.

**Fleet inventory** (read-only ssh, 2026-08-03) — only GitHub Desktop and Claude are Electron *and*
installed on all three Macs:

| app | mac1 | mac2 | mac3 |
|---|---|---|---|
| Yarn, Claude, GitHub Desktop, Chrome, Safari | ✓ | ✓ | ✓ |
| Cursor | ✓ | — | — |
| Codex | — | ✓ | ✓ |
| Warp | ✓ | ✓ | — |
| After Effects, Cinema 4D | ✓ | — | — |

**The idea worth keeping**: git config is global (`~/.gitconfig`) or repository-local
(`<repo>/.git/config`) — the same dual-scope shape as Yarn's brand-vs-document override, except the
two scopes write to **two different files**. That would have made it the only task in the matrix
whose correctness could be settled by reading a file instead of asking a model, which is
LIMITATIONS §8 — the standing blocker on every correctness claim here. If the wrong-scope question
ever needs an objective answer, this is where to get one. An Electron target also keeps the AX
backend, which Notion web cannot.

---

## Part 2 — the canvas task: criteria first, then a probe

### The gap

**Nothing in the matrix has tested the vision axis.** Cursor type, motion blur, and the creation
task all route through menus, dropdowns, and text fields — pure text in both AX and DOM. Dropping
screenshots costs nothing on such a task, which is exactly what phase 2 measured: `min-context`
(no vision, no DOM attrs) was the cheapest arm *and* the shortest at 7.3 steps.

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

Terminal state is a background type — a value, checkable. The route passes through the canvas paint
picker, which is the part no text channel describes.

### Settle this before spending runs

If "Radial" turns out to be a labeled button and clicking it completes the task, the route never
leaves text and the arm measures nothing new. That is a measurement, not a guess, and it costs one
CDP observation with the paint picker open, counting how many controls on the route carry a name —
two minutes on a free Mac. Same discipline the `seen`-is-list-rows hypothesis needs.

Only if the probe confirms unnamed controls on the route is the task worth arms. And then: **add it
to the four or five configs that still differ, not all fifteen.** Adding every task to every config
is how the plan reached 203 runs, most of them re-confirming a pass.

---

## Sequencing

1. **Now** — nothing. The pass is draining; the probe reports when it ends.
2. **On drain** — fix the dangling `if` at `run.ts:898`, collect, judge, read phase 7. It may have
   restored dynamic range on its own, which changes what comes next.
3. **Before phase 8 fires** — sign Notion in on three Macs, hand-validate one real dual-scope pair
   (or accept that the correctness half is out of scope for this app), delete the legacy plain-slug
   map.
4. **Then** — phase 8, ~17 runs, ~2h.
5. **Then, conditionally** — the canvas task, if phase 7 came back at ceiling and the paint-picker
   probe confirms the route leaves the text channel.

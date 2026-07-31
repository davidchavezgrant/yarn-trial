# Conformity audit: 58 commits after the src/ reorg

2026-07-31. Two agents audited separate halves of the tree against the layout contract in
CLAUDE.md; every claim below was re-verified by hand before acting on it. Scope: everything
between the reorg commit `cfef698` and HEAD — 84 files, ~12k lines.

The headline is that the **structure held**: zero import cycles across 29k lines, dependency
direction correct (peripherals depend on core, never the reverse at runtime), the shared
substrate importing nothing but node built-ins, and 100% of test names conforming to
`Function__Behavior__When__Condition`. What the audit actually turned up were two *behavioural*
bugs hiding behind structural smells, plus three layering violations that were invisible to
review because an import line looks identical whether or not it crosses a boundary that matters.

All findings below are fixed unless marked otherwise.

---

## Two live bugs, both failing safely (which is why nobody noticed)

**Recipe replay could not handle dual-scope apps.** `surfaceOf()` in `src/core/recipe.ts` read
`targetSurface` off a `StepRecord` through an `as any`, and **nothing ever wrote the field**. So
`RecipeStep.target.surface` was always absent, `resolveTarget`'s surface-narrowing branch was
dead, and every compiled recipe carried name+role only — confirmed against the committed
Wikipedia recipe, whose targets have exactly those two. The cost lands precisely where this repo
documents its risk: an app with two same-named controls cannot be replayed at all, and the 10
dual-scope Yarn settings (brand vs document) are the documented example. It fails *safe* —
`resolveTarget` errors on ambiguity rather than clicking the wrong twin — which is why the
Wikipedia recipe replayed 2/2 and nothing looked broken. **The cast is what hid it: a typed read
would not have compiled.**

**Teardown's model call had no retry.** It was the only bare `messages.create` in core — explore,
the visual judge, `home.ts` and the agent loop all wrap `retryTransient`. Teardown is the worst
place to omit it: it runs unattended *after* the run has reported its verdict, so nothing above
it retries either, and a single transient 529 abandoned the restore and left the app dirty. On
the fleet that means the next job on that Mac starts from a workspace this run mutated — the
exact failure `cleanup.ts` exists to prevent.

---

## Three layering violations

**`src/backends/boundary.ts` was core logic in a deletable directory.** It was the one static
value-import from core into `src/backends/`, and it was load-bearing: with the directory removed,
`npm run explore` broke at module load. Nothing in the file is backend-specific — its only import
is a pair of core types, and it handles both the AX and cdp spellings of a role (`AXButton` /
`button`) precisely *because* it does not care which produced the observation. It landed there
during the reorg by name association. Moved to `src/core/boundary.ts`.

**`remote/runner/serve.ts` imported `src/ui/`** — the only backwards edge in the tree, and not
cosmetic. Static reachability showed the colo-Mac daemon transitively loading
`remote/control/ssh.ts` (operator-laptop identity, known_hosts, control sockets) at boot in order
to answer one query about its own `/Applications`. `listApps()` is pure local enumeration with no
UI in it; moved to `src/core/apps.ts`, with `ui-core.ts` re-exporting so no call site changed.
`readCapturedAt` had to move down with it — pulling it from `control/appmaps.ts` was itself part
of the chain dragging ssh in.

**Peripherals imported the `core/harness.ts` barrel for one symbol each**, and paid for all nine
submodules: measured **52ms and +5MB** with the cua driver and Anthropic SDK resident, versus
2–4ms and no measurable heap for the defining submodule. The runner is a LaunchAgent that lives
for days and spawns every run as a child, so a driver resident in the daemon is a native library
in a process that must never hold a session. After: `jobs.ts` and `serve.ts` load at +0MB.

Two edges into the heavy modules remain and are **load-bearing, not oversights**: `serve.ts` →
`harness/observation` (the daemon genuinely needs `screenIsLocked`; it parses driver code but
starts no session), and `ui-core.ts` → `harness/verification` (the shell must refuse a hinted
prompt *before* dispatch). Both are documented in the barrel's header.

**`tests/layering.test.ts` now enforces all of this** — four checks that read the import graph the
same way the audit did, verified to fail when each violation is reintroduced. This is the durable
output: three of the four were invisible to code review, which is a job for a graph walk rather
than a convention.

---

## Stale state that had started lying

**`src/bench/` carried a merged wire contract as if unbuilt.** `BenchDispatchOptions` redeclared
eleven fields against a `DispatchOptions` that did not yet have them, and `dispatch(opts as
DispatchOptions)` bridged the gap. All eleven landed and `JobKind` gained `"replay"` — so the type
was duplication and the cast had stopped bridging anything and started **suppressing real type
errors**. Demonstrated by adding a field the wire does not have: with the cast it compiled;
without it the compiler names it. A cast that outlives its reason is worse than the gap it
covered, because it silently accepts whatever the two sides drift into.

**`team.ts` mixed two directory accessors reading different env vars.** `runnerHome()`
(`YARN_RUNNER_HOME`, the operator's laptop) for the credentials bundle, `defaultRunnerDir()`
(`YARN_RUNNER_DIR`, the colo Mac's, relocated by the LaunchAgent) for the env file holding the
model key. They share a default, so it worked right up until someone set one of the two — at
which point team.ts writes the bundle and the key to different directories. The test helper had
the same confusion and is the proof: `inTempRunnerDir` set the *runner's* variable to redirect
operator-side code, and passed on the shared default.

**Docs described a deleted backend in the present tense.** `2932147` removed the `dom` backend;
three places still described it as a live choice, including a CLI signature advertising
`--backend ax|dom|cdp`. `docs/cua.md`'s DOM section keeps its measurements — the paging arithmetic
and the AX-vs-viewport coordinate delta are why we know what cua's browser surface costs — under
a note saying the backend that measured them no longer exists.

---

## Judgment calls: what the audit argued AGAINST changing

Worth as much as the findings, and recorded so nobody "fixes" them later:

- **`serve.ts`'s job state machine should not be split.** `submit`/`startJob`/`drain`/`finalise`/
  `reap` share `children`, `stopping`, `draining` and the lease, and the queue's correctness *is*
  the interaction between them. Splitting ~500 cohesive lines across files would turn readable
  local state into shared mutable module state. Only two clean extractions exist: liveview port
  management (~80 lines) and `doctor` (~130).
- **`ui-page.ts`'s 1,525 lines are largely defensible.** It is two `String.raw` literals for one
  document over shared `let` state; splitting would make that shared state *less* visible, not
  more. The one real seam is the fleet panel (~370 lines).
- **`provision.ts` / `install.ts` rsync duplication is deliberate**, and documented at the point
  of divergence: reusing `rsyncArgv` would exclude `node_modules` and silently ship a broken
  Electron bundle that installs cleanly and crashes on launch.

## Still open

- `agent/run.ts` (749 lines) and `explore/loop.ts` (711) are the only core modules with no test
  file.
- `CdpBackend` appears in ~7 core signatures as an `import type`. Erased at emit, so the runtime
  contract holds and a default `ax` run never loads `src/backends/` — but a typecheck without
  that directory still fails. Closing it means declaring the ~11-method interface core actually
  uses (`act`, `observe`, `close`, `goHome`, `find`, `screenshot`, …) in core and letting
  `CdpBackend` satisfy it structurally. The asymmetry worth knowing: `Driver` (the ax backend)
  lives *inside* core while `CdpBackend` lives outside it, though they are two branches of one
  choice — that is why the type leaks.
- `serve.ts` still imports `firstLine` directly from `control/ssh.ts` — a pure string helper in
  the wrong home. Smaller than what was fixed, same shape.

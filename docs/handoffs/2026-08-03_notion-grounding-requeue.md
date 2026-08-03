# Handoff — finish the Notion grounding passes

Paste the block below into the other session. It is written to be safe to run when
*another* session also holds queues: every step checks before it dispatches.

---

## PROMPT

You are finishing the **Notion grounding (explore) passes** for the benchmark's second app.
Another session did the diagnosis and the code fixes; your job is only to get the remaining
passes dispatched and landed. **Read all of this before dispatching anything** — a duplicate
grounding pass costs ~1–2 hours of a colo Mac.

### Ground rules

1. **Never dispatch before checking `./run hosts` and the target Mac's job registry.** Another
   session may have queued work between your last look and now. If a pass for the arm you were
   about to submit is already `running` or `queued` anywhere, do not submit it.
2. **Dispatch as `root`** — `YARN_OPERATOR=root ./run dispatch …`. The bench arms run as root and
   the root Chrome profile on each Mac is the one signed in to Notion. A dispatch under any other
   operator claims a *different* profile and will ask for a fresh sign-in.
3. **Always pass the target as `--url https://app.notion.com`**, never as a positional app name,
   and never with a trailing slash. The appmap slugger recognises a target by being a URL.
4. **Only touch grounding.** Task runs are not started yet and are not in scope.

### What is already true (verified 2026-08-03 ~15:15)

- `HEAD` must be at or after **`95e21a7`** for dispatch to work correctly. Three separate flag
  bugs were fixed today; see "Why the earlier attempts failed" below.
- **mac1 is provisioned with today's code. mac2 and mac3 are NOT.**
- Fleet at handoff: mac1 busy (a Notion explore), **mac2 idle**, mac3 busy (a Notion explore,
  ~83 min in).
- The four passes queued on mac1 were **cancelled deliberately** — they were mislabelled (see
  below). Nothing is queued now.

### Coverage: what exists and what is still needed

Three grounding arms, n=2 each. Both currently-running passes are **baseline**, because the
CLI dropped their perception flags before `95e21a7`:

| arm | dispatch flags | have | still needed |
|---|---|---|---|
| baseline (`explore-notion-cdp`, "No AX (Web)") | *(none)* | 2 running | **0** |
| no-vision (`explore-notion-cdp-no-vision`, "DOM Only (Web)") | `--no-vision` | 0 | **2** |
| vision-only (`explore-notion-cdp-vision`, "Vision Only (Web)") | `--no-ax` | 0 | **2** |

**Verify this before acting** — the two running passes may have finished or been superseded:

```bash
./run hosts
```

and for any running/queued Notion explore, confirm which arm it actually is by reading its job
record's `noVision` / `noAx` fields and its `artifacts.appmap` path. A real no-vision pass writes
`docs/appmaps/web-app.notion.com.cdp.novision.md`; a flagless one writes the plain
`web-app.notion.com.md`. **Trust the record, not the command that submitted it.**

### The sequence

Repeat until the table above is satisfied. **One pass per Mac at a time** — the lease enforces it.

**Step 1 — find a free Mac.**

```bash
./run hosts
```

**Step 2 — provision it, but ONLY if it is idle.**

```bash
./run provision --host <mac>
```

This is required for mac2 and mac3: they are on an older build whose dismissal gate is the thing
under test (see below). `provision` restarts the runner, so it **refuses a busy host** — do not
force it, and never provision a Mac with a run in flight (a restart marks the in-flight job
`orphaned`; it destroyed a completed 118-action pass on 2026-07-31).

**Step 3 — dispatch one missing arm.**

```bash
# no-vision ("DOM Only")
YARN_OPERATOR=root ./run dispatch <mac> explore --url https://app.notion.com --no-vision --no-follow

# vision-only ("Vision Only")
YARN_OPERATOR=root ./run dispatch <mac> explore --url https://app.notion.com --no-ax --no-follow
```

`--no-follow` matters: a foreground follow dies with your tool timeout and its cleanup has
previously stopped healthy runs.

**Step 4 — confirm the flags actually landed.** This is the step that would have caught today's
bug:

```bash
# the job record must show noVision:true (or noAx:true) and a VARIANT appmap path
```

If the record shows no flags and `appmap: docs/appmaps/web-app.notion.com.md`, the dispatch is a
baseline duplicate — cancel it (`stop` via the runner) and check you are on `95e21a7` or later.

**Step 5 — repeat as Macs free.** Expect ~1–2 h per pass.

### Landing them

When all six exist and have finished:

```bash
./run dispatch <mac> pull <jobId>     # per finished pass
```

The published map is guarded: a pass that did not sweep its frontier, or that produced under half
the committed node count, is **demoted** to its run folder and does not overwrite
`docs/appmaps/`. That is working as intended — do not hand-promote a demoted map.

### Why the earlier attempts failed (so you do not repeat them)

Four things, three of them now fixed in code:

1. **`--url` was never parsed by the dispatch CLI** (`e5950d5`). The URL landed in the app-name
   slot and the run died looking for `https://app.notion.com.app` in `/Applications`.
2. **The explore branch parsed no perception flags at all** (`95e21a7`). This is why both running
   passes are baseline. Fixed, but **verify per Step 4** rather than trusting it.
3. **The dash reported queued-then-cancelled passes as "Crashed after 1h55m"** (`c440878`) — they
   had `pid: 0` and never ran. If you see identical durations across several "crashes", suspect
   one cancellation rather than several failures.
4. **NOT fixed, and the reason these passes matter:** on Notion the dismissal gate was refusing
   **every** dismissal (13 attempted, 0 accepted), so the frontier climbs (57 → 452) and never
   burns down. `369cf8f` makes each refusal name the categories still open. **The passes you
   dispatch are the first test of whether that lets a Notion pass converge.** Watch whether the
   frontier peaks and falls (Yarn's does: 17 → 117 → 30) or only climbs. If it only climbs, say so
   — do not let a pass run to the 10,000-action backstop; report it and stop.

### What NOT to do

- Do not run `./run bench phase 1 --go`. Today's manifest is **empty** while real jobs run on the
  fleet, so bench believes nothing is in flight and would submit **22** runs, duplicating both
  running passes and re-running 16 Yarn explores that already completed.
- Do not provision a busy Mac, and do not use `--force`.
- Do not start task runs. Grounding only.
- Do not push. Commit freely; pushing is the user's call.

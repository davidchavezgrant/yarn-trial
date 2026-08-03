# Self-driving demo agent — setup on a new machine

Getting from a fresh clone to a verified agent run. ~10 minutes, most of it TCC prompts.
For what this thing *is* — how the agent loop works, what was measured, what it can't do —
read **`OVERVIEW.md`**.

## 1. Requirements

| | Why | Required? |
|---|---|---|
| macOS 15+, Apple Silicon | the driver's native library is per-OS/arch | yes |
| Node 22+ | ESM + `tsx` | yes |
| `AZURE_OPENAI_ENDPOINT` + `AZURE_OPENAI_API_KEY` (or `ANTHROPIC_API_KEY`, or `OPENROUTER_API_KEY`) | the model — `azure/gpt-5.6-sol` over Azure's Responses API is the default; `claude-fable-5` direct on a bare Anthropic key; `openai/gpt-5.6-sol:nitro` over OpenRouter is the last fallback. The **model id picks the transport**, not whichever key happens to be set. `AGENT_MODEL` overrides. | yes |
| `ffmpeg` | assembles `--record` frames into mp4; renders humanized cursors | only for recording |
| `python3` + PIL (`pip install pillow`) | pixel-delta verification, frame QC, cursor rendering | degrades without it |
| Xcode Command Line Tools | builds the Swift sidecars (`axdom` DOM enrichment, `liveview` remote sign-in) | build-time only; required for `./run liveview` |

The cua-driver native library ships inside the npm package — nothing to install
separately. (`./run doctor` also looks for `/Applications/CuaDriver.app`; that is the
standalone daemon build, which this repo does not use.)

## 2. Install

```sh
git clone git@github.com:davidchavezgrant/yarn-trial.git
cd yarn-trial
npm install
npm run build:native      # optional; skip if you don't have Xcode CLT
```

`npm run build:native` compiles two sidecars: `native/axdom` (recovers the DOM
`id`/`class` Chromium strips out of its AX tree — unbuilt, every run silently falls back
to the bare AX view; a quality lever, not a dependency) and `native/liveview`
(window-scoped remote sign-in — a hard dependency of `./run liveview` only).

## 3. API key

```sh
cat >> .env <<'EOF'
AZURE_OPENAI_ENDPOINT=https://<resource>.openai.azure.com/openai/v1/responses?api-version=...
AZURE_OPENAI_API_KEY=...
EOF
# or ANTHROPIC_API_KEY=sk-ant-...   (claude-fable-5, direct)
# or OPENROUTER_API_KEY=sk-or-...   (openai/gpt-5.6-sol:nitro, the fallback)
```

`./run` sources `.env`, then `../yarn/.env`, then `~/.yarn-runner/env`, then falls back
to whatever is already exported. `AGENT_MODEL` overrides the model id — and the id, not
the key, chooses the transport: `azure/<deployment>` is Azure Responses, a bare `claude-*`
is Anthropic-direct, anything with a slash goes to OpenRouter. Setting an id the matching
key can't serve is a refusal at startup, not a surprise mid-run.

**On a team?** Skip all of this: drop `team-credentials.json` (from `./run enroll
--export` on an enrolled machine) beside `./run`, in `~/.yarn-runner/`, or inside the
.app — the first `./run` installs the fleet ssh key and the model key for you.

## 4. Grant macOS permissions — the step that actually blocks people

The grants attach to **the process that launches the run**, not to the target app.

- Running from a terminal → grant your terminal (Terminal, iTerm, WezTerm…).
- Running the Electron shell (`./run`) → grant Electron too, separately.

System Settings → Privacy & Security → grant in **both** panes:

- **Accessibility** (reading the AX tree, sending AX actions)
- **Screen Recording** (window screenshots, recording)

Quit and reopen the app after granting — macOS only re-reads TCC at process start.

## 5. Verify

```sh
./run doctor                # keys, deps, permissions, which apps are grounded
npm run probe "Yarn"        # end-to-end smoke: permissions -> launch -> window -> elements
```

`probe` printing an element count and writing a screenshot means perception works. If it
reports zero elements, see §4 — or the target app is on another Space (LIMITATIONS §1).

## 6. Ground the target app, then run a task

The agent needs an appmap for the app it is driving. One pass per app — it runs until the
frontier of un-operated controls empties (a finished pass on Yarn measured ~40 min /
96 actions; small apps are much quicker):

```sh
./run explore "Yarn"                              # -> docs/appmaps/yarn.{md,json}
./run "show me how to change the cursor type" "Yarn"
./run "show me how to change the cursor type" "Yarn" --record   # -> out/bench/live/<run>/recording/
```

Web targets work the same way with `--url` (sign in once first with
`./run browser-login <url>` if the site needs it):

```sh
./run explore --url https://example.com
./run "search for Fritz Lang" --url https://www.wikipedia.org
```

Committed appmaps, so you can skip `explore` for these: **Yarn** (one per
backend/perception variant), **Notion Calendar** (prose only — no `.json`, so graph
features are off for it, and no arm reads it any more), and **three web targets** —
`app.notion.com`, `www.notion.so`, `example.com`. `app.notion.com` is the benchmark's
second app rather than a spare fixture: it has a full `.cdp` mirror and the stage-4 arms
that measure cross-*app* transfer run against it. Run logs land
in `out/bench/live/<stamp>-<app>/run.json`. If a run is killed before it can tidy up,
`npm run cleanup -- <stamp>` replays its mutation journal and puts the app back.

A completed run can be re-graded by an independent adversarial judge — it reads the
trajectory, the step frames, and the appmap's scope rubric, and is the check that catches
"right value, wrong scope" runs the in-run verification passes:

```sh
npm run judge -- <stamp>              # -> out/bench/live/<stamp>/judge.json (advisory)
```

Once a run succeeds, there are two ways to reuse it — a MACHINE replay and a knowledge
write-up, which are different things:

```sh
./run procedure compile <stamp>        # -> docs/procedures/<slug>.<hash>.procedure.json
./run procedure replay <file|stamp>    # zero model calls unless the app has drifted
./run procedure replay <stamp> --record   # filmed: no model latency to hide in post
```

A procedure is a frozen click sequence: targets re-resolve by exact (name, surface, role), so a
renamed control is an error rather than an adaptation. A **recipe** is the other half —
prose describing the route, for a later agent to read and adapt:

```sh
./run judge <stamp>                    # a recipe may only come from a judged-PASS run
./run recipes harvest <stamp>       # -> out/bench/live/<stamp>/recipe.md
./run recipes promote <stamp>       # -> docs/recipes/…  (makes it loadable)
USE_RECIPES=1 ./run "<same task>" "Yarn"
```

Harvesting is deliberately offline — it never runs inside a measured run, and it refuses any
run the independent judge did not pass, because an agent that accurately describes doing the
wrong thing would otherwise teach that to everything downstream.

### Where run data lives

**One directory per run**: `out/bench/live/<runKey>/` holds `run.json`, `journal.jsonl`,
`judge.json`, `appmap.md`, `recipe.md`, `procedure.json`, `steps/` and `recording/`. That
directory is the canonical record; `out/bench/archive/<runKey>/` is a hard-linked backup taken
when the run ends, so removing the live copy loses nothing.

```sh
./run runs list                 # outcome, size, backup state
./run runs drop <stamp>         # a failed run out of live, backup kept — then re-run it
./run runs purge [--yes]        # clear live, every backup kept
```

Both back a run up before deleting and refuse to delete anything they could not back up.

Other entry points: `./run` alone opens the Electron shell; `npm test` runs the unit
suite; `./run help` lists everything, including the fleet verbs (`enroll`, `hosts`,
`provision`, `dispatch`, `install`, `signin`, `signout`, `uninstall`, `liveview`) for
running demos on the colo Macs — a human signs each app in once per Mac via `./run
signin` (full screen share) or `./run liveview` (just that window, in your browser).

## Gotchas that look like bugs

- **The target app must be on the active Space.** Off-Space, Chromium suspends it while
  every driver call still reports success. Don't switch Spaces during a run, and don't
  demo on a machine with another app in fullscreen. Plain occlusion is fine — perception
  and window capture both see through covering windows. (LIMITATIONS §1)
- **One run at a time per machine.** A second driver session shuts down the shared daemon
  and kills both. `./run` refuses to start one; `pkill -f 'tsx src/'` clears a stuck run.
  Runs on *different* Macs coexist fine (the shell allows one per host), and
  `--backend cdp` runs open no driver session at all. (LIMITATIONS §6)
- **Roughly one run in three aborts** on AX flakiness (empty tree, focus loss, dead
  session). Retries have been clean every time. (LIMITATIONS §10)
- **Driver sessions die at 300s** from `start_session` — an absolute lifetime, not idle
  TTL. `src/core/driver.ts` heartbeats every 90s; anything bypassing it must too.
- **A run that stops at step 8 has not run out of steps.** Three terminations, named in
  the run log's `stopReason` (`src/core/agent/run.ts`'s stopping contract): success;
  `"stalled"` — `AGENT_STALL_STEPS` (default **8**) consecutive steps verified nothing,
  which is the stop that ends genuinely stuck runs; `"step-ceiling"` — the `AGENT_STEPS`
  (default **100**) *runaway backstop*. The 100 is not a budget. A run must never fail
  because it ran out of steps, so a test refuses any arm that pins `steps` below the
  backstop — widen `stallSteps` instead if a legitimate route needs a longer unverified
  stretch.
- **`SNAP_PX` makes an arm an upper bound, on purpose.** Off by default (unset changes no
  behaviour). Set, it treats the vision model's pixel as a *hypothesis* and re-addresses
  the action by handle to the nearest interactive control within tolerance — measured at
  24 and 48px — falling through to the raw coordinate when nothing is in range. It is
  deliberately **not** vetoed when the snapped control disagrees with the one the model
  named: a veto would measure the harness's veto rate instead of vision-only actuation.
  `snapMatchesDeclared` is recorded on every snapped step so the confound is readable in
  the data rather than hidden by a gate.
- **Task prompts must state the goal only.** `auditTaskPrompt()` rejects prompts that
  dictate method; `--hinted` opts in and stamps the run log. Don't bypass it to make a
  run look good.

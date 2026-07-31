# Self-driving demo agent — setup on a new machine

Getting from a fresh clone to a verified agent run. ~10 minutes, most of it TCC prompts.
For what this thing *is* — how the agent loop works, what was measured, what it can't do —
read **`OVERVIEW.md`**.

## 1. Requirements

| | Why | Required? |
|---|---|---|
| macOS 15+, Apple Silicon | the driver's native library is per-OS/arch | yes |
| Node 22+ | ESM + `tsx` | yes |
| `OPENROUTER_API_KEY` (or `ANTHROPIC_API_KEY`) | the model — GPT-5.6 Sol over OpenRouter, Claude Opus 5 on a bare Anthropic key. `AGENT_MODEL` overrides. | yes |
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
echo 'OPENROUTER_API_KEY=sk-or-...' > .env      # or ANTHROPIC_API_KEY=sk-ant-...
```

`./run` sources `.env`, then `../yarn/.env`, then `~/.yarn-runner/env`, then falls back
to whatever is already exported. `AGENT_MODEL` overrides the model id.

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
./run "show me how to change the cursor type" "Yarn" --record   # -> out/recording/
```

Web targets work the same way with `--url` (sign in once first with
`./run browser-login <url>` if the site needs it):

```sh
./run explore --url https://example.com
./run "search for Fritz Lang" --url https://www.wikipedia.org
```

Appmaps for Yarn, Notion Calendar (prose only — no `.json`, so graph features are off for
it) and two web targets are committed, so you can skip `explore` for those. Run logs land
in `out/runs/<stamp>-<app>.json`. If a run is killed before it can tidy up,
`npm run cleanup -- <stamp>` replays its mutation journal and puts the app back.

Once a run succeeds, freeze it and repeat it for free:

```sh
./run recipe compile <stamp>        # -> docs/recipes/<slug>.<hash>.recipe.json
./run recipe replay <file|stamp>    # zero model calls unless the app has drifted
```

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
- **Task prompts must state the goal only.** `auditTaskPrompt()` rejects prompts that
  dictate method; `--hinted` opts in and stamps the run log. Don't bypass it to make a
  run look good.

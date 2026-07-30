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
| `ffmpeg` | assembles `--record` frames into mp4 | only for recording |
| `python3` + PIL (`pip install pillow`) | pixel-delta verification, frame QC | degrades without it |
| Xcode Command Line Tools | builds the `axdom` DOM-enrichment sidecar | optional, build-time only |

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

`npm run build:native` compiles `native/axdom`, which recovers the DOM `id`/`class`
Chromium strips out of its AX tree. Unbuilt, every run silently falls back to the bare
AX view — it is a quality lever, not a dependency.

## 3. API key

```sh
echo 'OPENROUTER_API_KEY=sk-or-...' > .env      # or ANTHROPIC_API_KEY=sk-ant-...
```

`./run` sources `.env`, then `../yarn/.env`, then falls back to whatever is already
exported. `AGENT_MODEL` overrides the model id.

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

The agent needs an appmap for the app it is driving. One pass, ~5–6 min, once per app:

```sh
./run explore "Yarn"                              # -> docs/appmaps/yarn.{md,json}
./run "show me how to change the cursor type" "Yarn"
./run "show me how to change the cursor type" "Yarn" --record   # -> out/recording/
```

Appmaps for Yarn and Notion Calendar are committed, so you can skip `explore` for those.
Run logs land in `out/runs/<stamp>-<app>.json`.

Other entry points: `./run` (Electron shell), `npm test` (harness unit tests),
`./run --help`.

## Gotchas that look like bugs

- **The target app must be on the active Space.** Off-Space, Chromium suspends it while
  every driver call still reports success. Don't switch Spaces during a run, and don't
  demo on a machine with another app in fullscreen. Plain occlusion is fine — perception
  and window capture both see through covering windows. (LIMITATIONS §1)
- **One run at a time.** A second driver session shuts down the shared daemon and kills
  both. `./run` refuses to start one; `pkill -f 'tsx src/'` clears a stuck run.
  (LIMITATIONS §6)
- **Roughly one run in three aborts** on AX flakiness (empty tree, focus loss, dead
  session). Retries have been clean every time. (LIMITATIONS §10)
- **Driver sessions die at 300s** from `start_session` — an absolute lifetime, not idle
  TTL. `src/driver.ts` heartbeats every 90s; anything bypassing it must too.
- **Task prompts must state the goal only.** `auditTaskPrompt()` rejects prompts that
  dictate method; `--hinted` opts in and stamps the run log. Don't bypass it to make a
  run look good.

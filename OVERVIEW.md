# Self-driving demo agent — overview

Prototype: a natural-language task → verified UI actions on a Mac app or website,
recorded. Setup instructions live in `README.md`; this file is what the prototype does
and what it's worth.

> "Show me how to change my timezone to Paris" → the agent performs the change in
> Notion Calendar, verifying every step, and records a window-scoped video of itself.

## How it works

```
NL task
  ▼
Agent loop (GPT-5.6 Sol via OpenRouter; Opus 5 on a bare Anthropic key)   src/core/agent.ts
  observe: AX elements (+ DOM id/class via native/axdom) + window screenshot
  decide:  ONE action + a checkable expectation (tool use)
  act:     via the actuator backend
  verify:  re-observe, check expectation, feed verdict back
  ▼
Actuator seam (Observation/ActionRequest) — two backends:
  --backend cdp  (default)  src/backends/cdp.ts → playwright-core, NO cua in the loop
  --backend ax              src/backends/ax.ts → @trycua/cua-driver → AX actions;
                            primary for native Mac apps, automatic fallback when an
                            Electron target's debug port never comes up
```

Design decisions and their reasoning live in `docs/architecture.md`.

- **Verification is first-class**, in four layers of decreasing authority:
  1. *Text* (per step, deterministic, gates the run) — the expectation must be checkable
     and *discriminating*, i.e. satisfied only after the action. An act call with nothing
     checkable is rejected without being executed.
  2. *Pixel delta* (per step, deterministic, advisory) — fraction of pixels changed since
     the last observation, because canvas content is invisible to AX.
  3. *Visual judge* (once, at `done`, advisory) — a separate model call sees the task, the
     agent's claim, and the final frame. `VISUAL_JUDGE=block` makes a FAIL reject success.
  4. *Offline run judge* (post-hoc, advisory) — `npm run judge -- <stamp>` re-grades a
     completed run in one adversarial model call: full step trajectory + step frames (when
     per-run) + the appmap's scope ambiguities as rubric. Grades against the TASK, not the
     claim, so a run that accurately reports doing the wrong thing still fails. Writes
     `out/runs/<stamp>.judge.json`; never touches the run log.

  Every step is logged to `out/runs/<stamp>-<app>.json` (action, expectation, verdict,
  pixel delta, screenshot). Known gap: text checks prove *a* control holds the value, not
  that it is the *intended* one — see LIMITATIONS §8; layer 4 exists to catch exactly that
  class after the fact (validated on the known wrong-scope runs).
- **The run puts the app back.** Every mutation is journaled as it is detected (a diff of
  control values across observations — never the model's own account), and after the
  recording is assembled, teardown replays the journal in reverse with harness-written
  checks. `CLEANUP=advisory` (default) reports what is still dirty; `block` fails a dirty
  exit; `off` is for filming. A killed run's journal replays later via
  `npm run cleanup -- <stamp>`. Created resources go through the `claim` tool and are
  reported, not deleted.
- **DOM enrichment without CDP.** `native/axdom` (Swift, `npm run build:native`) recovers
  the DOM id/class Chromium drops from its AX tree, naming 955 of 1044 anonymous Yarn
  nodes. Optional: unbuilt or `AXDOM=0` degrades silently to the bare AX view.
- **Grounding** comes in two tiers, kept separate so that measuring one doesn't
  quietly measure the other:
  - `docs/appmaps/<app>.md` — output of the autonomous exploration pass
    (`src/core/explore.ts`), stamped with a provenance header. Runs until the frontier of
    un-operated controls empties: measured **40 min / 96 actions** on Yarn (2026-07-30).
    The earlier "~5-6 min" figure measured a step-budget truncation, not a finished pass.
    Emits a prose map plus a `<app>.json` graph whose scope metadata drives the ambiguity
    warnings. Read `controls: N actuated / M dismissed / K seen` in the stamp, not the
    stop reason — `frontier-empty` is reachable by dismissing (`EXPLORE_DISMISS_CAP`
    bounds bulk dismissal; `EXPLORE_DESCENT=1` opts into harness-guarded descent behind
    destructive-looking controls — LIMITATIONS §15).
  - `docs/recipes/<app>.md` — hand-curated notes, including verified task recipes.
  - `docs/recipes/<slug>.<hash>.recipe.json` — **compiled replay recipes** (machine
    output, stamped like appmaps — never hand-edit; re-record instead).

  Both are auto-loaded into the agent's prompt and the run log records which was used.
  The split exists because it was violated: task-specific recipes had been hand-added
  to appmaps that "grounded" runs were then measured against, which inflated grounding's
  apparent value. See the correction note in
  `docs/research/2026-07-29-yarn-poc-findings.md`.
- **Window-scoped recording** (`--record`): polls the driver's window snapshots —
  which capture the target window's own content even when occluded or backgrounded —
  and assembles them into an mp4. The recording physically cannot contain anything but
  the target window. Malformed frames are filtered by majority vote on frame size plus
  a content check. **Not** on another Space: off-Space the capture fails outright, along
  with all perception (LIMITATIONS §1). On `--backend cdp` the recording is the page
  viewport via `page.screenshot()` instead — no staging, no Space interaction.
- **Cursor humanization** (`npm run humanize -- <stamp>`): the recording has no cursor in
  it (AX actuation never moves the physical pointer), so a post-pass draws one from the
  run's own trajectory data — click points, timestamps, target role/rect — with motion
  fitted to real human cursor recordings. Emits `motion-track.json` (the handoff format
  for Yarn's own renderer) plus `humanized.mp4`; renders surface in the shell's gallery.
- **Web targets** are first-class: `--url https://site.com` on both agent and explore,
  with appmaps keyed by origin (`docs/appmaps/web-<host>.*`) and one-time sign-in via
  `./run browser-login <url>` persisting in a named browser profile.
- **Recipe replay** (`./run recipe compile <stamp>` / `replay <file|stamp>`): a
  successful run's verified steps freeze into a replayable sequence — volatile element
  handles stripped, each step re-resolved by (name, surface, role) against a fresh
  observation and gated by the SAME `verify()` as a live run, with the recorded
  expectations. **Zero model calls on the happy path**; a broken step gets one bounded
  model rescue checked against the recipe's own expectation (`--no-rescue` for the
  unattended fleet default: a drifted app fails honestly). Compilation refuses failed,
  unverified, pixel-only, and `--hinted` runs. Verified live: a cdp Wikipedia run
  compiled and replayed 2/2 steps + final goal check with 0 model calls.

## Running it

Prereqs: macOS 15+, Node 22+, `ffmpeg` (assembly), `python3` with PIL (frame QC),
Accessibility + Screen Recording permissions for your terminal, and either
`ANTHROPIC_API_KEY` or `OPENROUTER_API_KEY` in the environment.
Starting from a fresh clone, follow **`README.md`** — it covers the TCC grants and the
per-app grounding pass step by step.

```sh
./run doctor                         # preflight: keys, permissions, deps, appmaps
./run                                # packaged Electron app (the deployment target)
./run "show me how to change the cursor type" "Yarn" [--record]
./run explore "Yarn"                 # grounding pass -> docs/appmaps/
./run "search for Fritz Lang" --url https://www.wikipedia.org
./run help                           # everything else, incl. the fleet verbs
```

`./run` sources `.env`/`../yarn/.env`/`~/.yarn-runner/env`, refuses to start a second
concurrent run on this machine (LIMITATIONS §6), and rebuilds the Electron bundle only
when sources changed. The underlying npm scripts still work if you prefer them:

```sh
npm install
npm run build:native                 # Swift sidecars: axdom + liveview (needs Xcode CLT)
npm run probe "Yarn"                 # permissions + perception smoke test
npm run explore -- "Yarn"            # grounding pass -> docs/appmaps/
npm test                             # unit tests (~900 across harness, fleet, shell)
npm run agent -- "show me how to change the cursor type" "Yarn" --record
npm run humanize -- <stamp>          # human-feeling cursor render for a recorded run
npm run cleanup -- <stamp>           # replay a killed run's mutation journal
npm run recipe -- compile <stamp>    # freeze a successful run into a replayable recipe
npm run recipe -- replay <file>      # replay it — zero model calls unless a step breaks
npm run app                          # Electron shell
```

**The fleet.** Three colo Macs run demos unattended, dispatched from any operator's
laptop: `./run enroll` / `provision` / `dispatch` / `install` / `signin` / `liveview`
(`src/remote/control/`, `src/remote/runner/`). Each Mac runs the Electron shell headless (`--serve`, a
LaunchAgent) because macOS attributes TCC grants to the responsible process — a run
spawned over SSH perceives nothing, silently (LIMITATIONS §12). One run per Mac,
enforced by a lease; a human signs each app in once per Mac. The shell's fleet panel
shows each Mac's state, and the gallery tags recordings with the Mac they came from.

**The shell.** `src/ui/ui-core.ts` holds the local host logic (app list, per-machine run
guard, spawn, hygiene gate, per-app UI state in `out/ui-state.json`),
`src/ui/ui-remote.ts` the fleet dispatch, and `src/ui/ui-page.ts` the markup + browser script;
the page reaches its host only through `window.__bus`, which `electron/main.ts` binds to
ipcRenderer. Keeping that seam means the host is swappable and the page stays testable
without Electron. The shell hosts **one run per host** — a local run and runs on two
colo Macs coexist. Electron is what matters for shipping — Yarn's product is Electron,
the driver has first-party support for that host, and a signed bundle escapes the
ScreenCaptureKit limit that caps recording at ~4fps today. Packaging (electron-builder,
signing, notarization) is not done yet; see
`docs/research/2026-07-29-packaging-native-vs-electron.md`.

`AGENT_MODEL` overrides the model. `src/step.mts` is a manual step driver for debugging
individual interactions (hard-coded to Notion Calendar).

## Honest limitations

- Proven breadth: two Electron apps (Notion Calendar, Yarn) and web targets, all with
  zero harness changes. Native AppKit: one pass (Calculator), one diagnosed fail (Hex
  Fiend — foreground delivery never makes a native app key/main), and out of scope for
  now. Sample sizes are 2-4 runs per condition, not a measured failure rate.
- **Roughly one run in three aborts** on AX flakiness (empty tree, focus loss, dead driver
  session; measured 2026-07-29 on the AX backend). Retries were clean every time, so it
  is a throughput cost rather than a capability limit — but it is the main obstacle to
  unattended operation, and it is why the CDP-direct backend exists (LIMITATIONS §10,
  §14).
- **Verification cannot tell which control it verified.** Yarn exposes 10 settings (on
  the current map) at both a brand-wide and a per-project scope; every ungrounded run
  changed the wrong one while passing its checks. Mitigated by appmap scope warnings and
  the visual judge, and detectable after the fact by the offline run judge (which flagged
  every known wrong-scope run from the trajectory alone) — not solved in-run
  (LIMITATIONS §8).
- Target app must be on the active macOS Space. Off-Space, Chromium suspends the
  whole app while every driver call still reports success (LIMITATIONS §1).
- Electron's AX tree goes intermittently dark under focus churn; the agent falls
  back to keyboard navigation, and the pixel/visual layers make the degradation visible
  rather than silently "verified". Still the reliability frontier on the AX path.
- ~10–25s of model thinking between actions — fine async, wrong for a human watching
  live. Recipe replay removes it for repeated tasks (zero model calls on the happy
  path); the first run of any task still pays it.
- Recording is ~4fps snapshot-based on the AX path; real 30fps *recording* still wants a
  signed app, though `native/liveview` shows live SCK window streaming works from our own
  runner-spawned code (LIMITATIONS §3, §16).
- Recording staging fills the window's *current* display and leaves native fullscreen
  alone. (An earlier claim that the driver miscomposites 1x displays did not reproduce
  when measured, so windows are no longer moved between monitors — LIMITATIONS §3.)

## Measurement discipline

Two ways this prototype was caught flattering itself, both now enforced in code rather
than by anyone remembering:

- **Task prompts state the goal only.** Two early takes had the *method* written into
  the prompt and were reported as autonomous runs. `auditTaskPrompt` (`src/core/harness.ts`)
  now refuses a prompt that names driver internals or dictates interaction mechanics;
  `--hinted` opts in and stamps the run log so a dictated run can't be mistaken for an
  honest one later.
- **An action the harness can't check doesn't run.** A run once reported "success in 3
  actions" with zero steps actually verified. Every `act` call now requires checkable
  substrings, and the final verdict says how many steps went unverified.

Numbers in `docs/research/` carry correction notes where a measurement turned out to be
contaminated. Read those before quoting a figure.

## Docs

- `docs/architecture.md` — design decisions, why each was made, and when to revisit
- `docs/product.md` — status assessment and open product questions (non-technical)
- `docs/research/` — driver quirks, verified sequences, and measured results
  (`2026-07-31-poc-gotchas-and-lessons.md` is the consolidated handoff writeup)
- `docs/appmaps/` — grounding notes produced by the exploration pass
- `docs/recipes/` — hand-curated grounding notes
- `LIMITATIONS.md` — running log of what constrains the agent in practice
- `README.md` — fresh-clone setup on a new machine

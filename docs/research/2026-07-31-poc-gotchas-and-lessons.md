# Building the Self-Driving Demo Agent: Gotchas and Lessons from the POC

2026-07-31. Written for the engineer building the production version.

This covers everything we learned building the POC, from the first commit (July 27) through
the fleet work (July 30): an agent that takes a natural-language task, performs real,
verified UI actions on a Mac or web app, and produces a recorded demo. A/B statistics
(grounded vs. ungrounded, vision on vs. off) are deliberately omitted — they are being
re-run at proper sample sizes and will be appended. Everything else here is a measured
finding or a design decision with its reason.

Repo: `davidchavezgrant/yarn-trial`. Deeper reading: `LIMITATIONS.md` (the running log of
environmental constraints), `docs/research/2026-07-30-cua-learnings-for-real-implementation.md`
(the actuator decision in full), `docs/cua.md` (driver quirk catalogue).

---

## The short version

If you read nothing else:

1. **Build the harness, not the driver.** The agent loop, verification stack, grounding
   pipeline, and cleanup system are the product. The actuator (cua, CDP, AX) sits behind a
   small interface and is swappable — we proved this by running three backends behind the
   same seam.
2. **Verify every action by re-observing.** The platform lies in both directions: clicks
   that "aren't supported" work, and clicks that report success silently do nothing. Only
   a fresh observation tells the truth.
3. **The agent will cheat unless the harness stops it.** Vacuous checks, blank substrings,
   claims of success with no evidence — every one of these happened. The harness must
   refuse them mechanically, not trust the model.
4. **The most dangerous failure is changing the *wrong* setting and passing every check.**
   Apps keep the same setting at two scopes (a global default and a per-document
   override). Text verification proves *a* control reads the target value, never that it's
   the *intended* control. This is the single most important finding in the POC.
5. **Ground each app with an exploration pass, and guard the resulting map like
   experimental input** — because it is one. Ours got contaminated twice.
6. **Enforce discipline in code, not memory.** Every rule we kept "by agreement" was
   violated within a day. Every rule we moved into code held.
7. **macOS attributes permissions to the process that asks, and children inherit them.**
   A run spawned over SSH gets an empty accessibility tree and a black screenshot with
   *no error*. This one fact shapes the entire fleet architecture.
8. **Authentication decides the deployment model.** SSO with MFA cannot be automated in
   the general case, so signed-in sessions are human-created assets that must persist —
   which means persistent machines, not ephemeral VMs, and sign-in as a first-class
   product flow.
9. **Runs must clean up after themselves, mechanically.** Diff what actually changed;
   never trust the model's account of what it did.
10. **Reliability and feel are separate problems.** The agent's job is verified actions
    plus a *data* feed (click points, timestamps, target rects). The human-feeling cursor
    is drawn in post from real human motion data. Decoupling these was Jasper's insight
    and it held up completely.
11. **The worst failures are silent.** Nearly every expensive bug in this project reported
    no error: blind SSH runs, frozen windows that verified fine, a visual judge that
    vanished on hard frames, appmaps that quietly weren't loaded. Make every degradation
    loud and record it in the run log.

---

## 1. Verification: the core of the system

The loop is observe → model picks one action *plus an expectation* → act → re-observe →
verify. Everything below exists because some simpler version failed.

- **Expectation before action.** The model must state, before acting, what observable text
  will prove the action worked. An action with no checkable expectation is refused
  unexecuted. Without this, the model acts first and rationalizes afterward.
- **Checks must discriminate.** An expectation already satisfied *before* the action
  proves nothing about the action. We reject checks that pass against the pre-action
  observation. Likewise `done(success)` is graded by the harness against a fresh final
  observation — the model doesn't get to declare victory.
- **Close the trivial bypasses — they will be found.** `textIncludes: [""]` passes against
  any screen (every string contains the empty string). Excludes-only evidence with no
  prior baseline proves nothing. Blank and whitespace substrings are stripped, and "nothing
  left to check" fails as uncheckable. Assume any hole in the evidence grammar will
  eventually be exploited by a model under pressure to report success.
- **Driver warnings are unreliable in both directions.** "Element does not advertise
  AXPress" clicks usually work anyway; clicks that report success sometimes do nothing. A
  silent no-op click is especially nasty: the next keystrokes land on the wrong surface
  and can trigger the app's global shortcuts.
- **Three verification layers, deliberately different in authority:**
  1. *Text* (per step, deterministic): substring checks against accessibility labels and
     values. This is what gates a run.
  2. *Pixel delta* (per step, advisory): fraction of pixels changed since the last
     observation. Exists because rendered content (canvases, video previews) is invisible
     to the accessibility tree, so "the screen never repainted" is otherwise undetectable.
     Never fails a run alone — legitimate actions can change nothing visible, and
     animations change pixels meaninglessly.
  3. *Visual judge* (once, at done, advisory): a **separate** model call given the task,
     the agent's claim, and the final frame. Catches the wrong-scope case text can't.
- **The judge must see the agent's *claim*, not just the task.** Given only the task
  string, the judge passed a known-wrong frame, reasoning that "show me how to X" only
  asks to *locate* the control. With the agent's claim attached ("I changed the brand-wide
  default"), the same frame fails as contradicting it. Verify the claim, not the wording
  of the request.
- **An absent advisory verdict must be loud.** The judge silently returned nothing when
  its token budget ran out mid-reasoning — on exactly the frames that were hardest to
  judge — and a missing verdict printed identically to a passing one. Give judges
  generous budgets and report "no verdict" explicitly.
- **Perception and rendering die separately.** Two runs kept a full, addressable
  accessibility tree for 15 steps while the window never repainted once — 247
  byte-identical frames, five minutes of video of a still image. The run looked healthy
  on the channel that gates it and was dead on the channel that produces the deliverable.
  We detect this (trailing steps that verified nothing *and* moved no pixels) but only
  *report* it — see the next point.
- **You cannot abort on "looks frozen."** Apps that embed their own AI assistant think
  for minutes, and waiting them out is correct behavior — which from outside is
  indistinguishable from a dead window. `wait` must be a real action that can cover
  minutes, and idle-looking runs get a printed warning, not an abort.

## 2. The wrong-scope problem, and grounding

This is the finding to design around.

- **Apps keep the same setting at multiple scopes.** Yarn exposes ten Screen Clip settings
  both as a brand-wide default and as a per-project override — independent stores. On the
  task "change the cursor type," every ungrounded run changed the per-project override,
  passed all its verification checks, and truthfully reported success. It had changed the
  wrong thing. Any app with global defaults plus per-document overrides (editors, IDEs,
  design tools) has this failure class.
- **Text verification cannot catch it by construction.** Substring evidence proves *a*
  control reads the target value somewhere on screen. The disambiguating context —
  breadcrumb, panel title — is exactly what a flattened text haystack destroys.
- **Grounding is the mitigation, and it buys correctness, not just speed.** The
  exploration pass (below) records each setting with a `settingKey` and a `scope`; code
  detects settings that live at two scopes and injects a warning into the prompt naming
  both, each with its full navigation route.
- **Present both routes; don't pick one in the harness.** Our first version told the
  agent to "prefer the broadest scope" — flatly wrong whenever the task is about one
  document ("change it for just this project"). The harness lists the options and
  requires the agent to state which scope it chose and why. An *unstated* choice is what
  makes a wrong scope indistinguishable from a deliberate one.
- **Group scope warnings by surface pair, not per setting.** Ten settings sharing the
  same two panels produced 10.8k characters of warnings against a 5.9k-character appmap;
  grouped, 1.9k characters with the routes intact. Prompt real estate is a budget.

### The exploration pass (grounding pipeline)

An automated pass operates the app once and writes two artifacts per app: a prose map
(injected verbatim into the agent's system prompt — models read prose well) and a graph
(nodes with scopes, controls with setting keys — code queries this; the model never sees
it). Lessons:

- **Explore until the frontier of un-operated controls empties, not until a step budget
  runs out.** A step budget is wrong in both directions: it truncates passes that still
  have surfaces to open, and lets finished ones keep burning. Every observation already
  lists the app's interactive controls, so "seen minus actuated minus dismissed" is
  arithmetic — don't ask the model whether it covered the app; a transcript by
  construction contains only the surfaces it visited.
- **But bound bulk dismissal, or "frontier empty" is meaningless.** One uncapped pass
  cleared 104 unrelated controls with a single dismissal sentence and declared itself
  done at 25-of-262 controls operated. A cap (refuse bulk dismissals above ~20 that don't
  name a specific surface) took the same app to 47 actuated / 396 seen.
- **Key frontier entries by role + label + surface, never by element handle.** Handles
  are a walk order that renumbers every time the tree changes shape — which is exactly
  what operating a control causes.
- **Salvage the map when the pass dies mid-run.** Everything learned is already in the
  transcript; on a crash, one final model call emits the map from it, stamped "salvaged"
  so readers know it's weaker. Before this, a 15-action pass that died produced nothing —
  silently, with the stale previous map still on disk looking current.
- **A finished pass on a real app costs ~40 minutes / ~96 actions** (Yarn), roughly 3% of
  the ~24h-per-app grounding budget Jasper described. Earlier "5 minutes per app" figures
  measured budget-truncated passes and were not comparable.
- **Have the pass declare the app's "home" state** — the ordinary landing view and the
  control that reaches it. This is a test fixture (runs reset to it so results are
  comparable), never shown to the task agent. Don't derive it structurally from the
  graph: every structural signal picked the wrong node (exploration spends its time in
  settings panels, so subtree size picks a document editor). And verify the declaration
  against the walk's own evidence — this one field silently governs every future run's
  start state.
- **The home probe doubles as a sign-in-wall detector.** A freshly installed app sits at
  a login screen; its declared home control is exactly what's missing there. Left
  ungated, the agent treats the wall as the task — one real run opened an OAuth flow in
  Chrome before being killed. The agent refuses to run (exit code, clear message) rather
  than spend a budget fighting a wall it cannot pass.
- **Destructive controls: split "irreversible" from "reversible," and descend with the
  harness holding the leash.** Send/publish/purchase are refused always. Delete/export/
  reset are two-phase in any well-formed app — the press opens a confirmation that
  commits nothing — so exploration may press *once*, classify what surfaced, and the
  *harness itself* sends Escape. The model never acts inside the modal. Without descent,
  every surface behind a destructive-looking button is a permanent hole in the map (350
  of 396 Yarn controls were unreachable).

## 3. Measurement discipline: enforce it in code

The rule (set by David, non-negotiable): **never give the model information it would not
have in a real test case.** Task prompts state the goal only; method knowledge lives in
declared, budgeted inputs (the appmap).

- **Memory-enforced rules failed within a day. Twice.** Hinted prompts were measured as
  autonomous — including in a take emailed to the client. The fix was a code gate
  (`auditTaskPrompt()`) that makes the agent refuse a prompt that dictates method; an
  explicit `--hinted` flag opts in and stamps the run log. Zero violations since.
- **The gate had a side door: the grounding artifact.** The original appmaps were partly
  hand-written and contained recipes for the exact tasks being measured — so "grounded"
  runs measured recipe-following, not the pipeline. The fix is provenance: `docs/appmaps/`
  holds *only* stamped machine output from the exploration pass; hand-curated notes live
  in a separate, separately-declared tier (`docs/recipes/`). Every run log records which
  tier grounded it, plus the map's content hash. **Never hand-edit a stamped appmap.**
- **One log writer, in a `finally`, or your reliability numbers are survivorship-biased.**
  We had two writers that drifted: one path omitted the field the gallery filtered on,
  and aborted runs wrote *no log at all* — so every failure-rate figure quoted before the
  fix was conditional on the run surviving long enough to write its own obituary.
- **Artifacts are written only by the harness, under unique per-run names.** Never
  hand-copy a result file. Run keys carry milliseconds plus a counter — two runs minted
  in the same second once clobbered each other's logs and recordings.
- **Reset the app before every run**, or run N starts from whatever run N−1 left behind
  and nothing is comparable. And a failed reset must be loud — ours failed silently for a
  while (a dropdown left open hid the sidebar from the accessibility tree) and quietly
  voided an A/B pair.
- **Your instruments will lie; build negative controls.** The canvas probes twice
  reported false positives: a "null drag" that actually scrubbed the playhead (the
  mousedown itself moved the clock being read as evidence), and a click readout that any
  click produced. The fixes generalize — use an idle wait as the null action, and run a
  decoy action whose evidence can never count.

## 4. macOS and Electron platform traps

Each of these cost real time because none of them reports an error.

- **TCC (permissions) attaches to the *responsible process*, and children inherit it.**
  A run spawned from an SSH session is responsible to sshd, which has no grants: empty
  accessibility tree, black screenshot, **no error on either** — indistinguishable from
  an app that hasn't launched. Every fleet run must be a child of the process holding
  the grants (our Electron runner, installed as a LaunchAgent in the `gui/<uid>` domain —
  `user/<uid>` has no window-server session and doesn't work).
- **Screen Recording has no "+" button in System Settings.** The app must call
  `CGRequestScreenCaptureAccess` before it even *appears in the list* to be granted. And
  a new grant does not apply to a running process — restart after granting, or the host
  reports its grants present and still captures black.
- **Spaces, not occlusion, are the perception boundary.** A window on an inactive Space
  (e.g. when any fullscreen app is in front) is simultaneously unobservable and
  unactuatable — Chromium tears down the accessibility tree and rendering for it. Plain
  occlusion is fine: perception sees through covering windows. Critically, **programmatic
  activation reports success and does nothing** across Spaces — macOS refuses
  background-initiated Space switches. Foregrounding does fix the look-alike causes (no
  window, hidden, minimized), so attempt it once, then fail with an honest message.
- **Chromium builds its web-content accessibility tree lazily, and READING it is not what
  wakes it.** A freshly-launched Chrome exposes no `AXWebArea` at all — 37 chrome-only nodes —
  no matter how many times an AX-trusted client walks it. The wake is an app-element attribute
  WRITE: `AXEnhancedUserInterface` (what VoiceOver sets; the one Google Chrome honours) or
  `AXManualAccessibility` (the CEF/Electron equivalent, which Chrome ignores). Measured on
  virgin `--user-data-dir` Chromes: no wake after 8s of reads, none with `AXManualAccessibility`
  alone, web area up 2s after `AXEnhancedUserInterface`. Chrome answers `-25208 notImplemented`
  to the set **and wakes anyway**, so never gate on the return code. This cost three separate
  debugging attempts that each blamed TCC attribution: the wake latches for the process
  lifetime, so a developer's daily-driven Chrome is always already awake, and only a fleet Mac
  launching a fresh browser per sign-in shows the bug.
- **`defaults` cannot see managed preferences, and `pgrep -x` cannot see another session's
  apps.** Three verification tools lied in three different directions on the same afternoon:
  `defaults read com.google.Chrome SyncDisabled` reported "does not exist" while the policy was
  demonstrably in force (it reads the user domain only); `profiles list` reported no profiles
  while a System-scope one was installed (without root it lists user-scope only); `pgrep -x
  "Google Chrome"` found nothing while Chrome was running in the console session (`ps -axo`
  found it). The rule that survives: **verify with the API the consumer actually uses.** For
  Chrome policy that is `CFPreferencesCopyAppValue` + `CFPreferencesAppValueIsForced`, which is
  what `policy_loader_mac.mm` calls.
- **macOS 26 changed how Chrome policy is delivered, and the failure is invisible.** On macOS
  15 a root-written plist in `/Library/Managed Preferences` is honoured. On 26 the identical
  file — same md5, same `root:wheel 644` — is ignored: it reads back perfectly from disk while
  `CFPreferencesAppValueIsForced` returns false, because that directory belongs to the MDM
  subsystem and a loose file there manages nothing. `profiles install` is gone too ("profiles
  tool no longer supports installs. Use System Settings Profiles"). The working route is a
  configuration profile (`fleet/chrome-policy.mobileconfig`) installed by a human once per Mac;
  no MDM enrolment required, but no unattended path either. **Run `sw_vers` before comparing
  two machines** — an hour went into diffing byte-identical plists across a major OS difference
  nobody had checked for.
- **`sudo defaults write` to a managed-preferences path silently writes nothing.** `defaults`
  routes through `cfprefsd`, which owns that location and declines to create files there, then
  exits 0. The plist has to be written as a file (`tee`). Combined with the trap above, this
  manufactures the worst state available: a policy that looks set, reads back, and enforces
  nothing.
- **Natively-fullscreen apps report zero windows to AppleScript/System Events.** Absence
  of windows *is* the fullscreen signal. Also: setting a position on a fullscreen window
  demotes it out of fullscreen. This silently broke recording staging on every run for a
  day.
- **A locked screen mimics accessibility flakiness.** Tree present but empty, screenshots
  of the lock wallpaper. Detect it (`ioreg` works from any context) and name it.
- **Chromium's accessibility tree drops DOM `id`/`class`** (they're not part of the ARIA
  mapping), so unlabeled icon buttons arrive as anonymous `AXButton ""`. But Chromium's
  Mac bridge still exposes the source node as nonstandard attributes (`AXDOMIdentifier`,
  `AXDOMClassList`, help/description/placeholder/URL) that most drivers never read. A
  ~200-line Swift sidecar recovers them: on Yarn, 955 of 1,044 anonymous nodes gained a
  name. Join the two tree walks by frame geometry — element indices from independent
  walks are not comparable. (In a production build with CDP access you get the DOM
  directly and this whole layer disappears.)
- **Element handles are per-snapshot.** Always resolve targets against a fresh
  observation; indices renumber whenever the tree changes shape.
- **Delivery mode is app-specific.** Background-delivered clicks are silently no-ops in
  Yarn (every click needs foreground delivery); Notion Calendar mostly accepted
  background. Menu-bar keyboard equivalents (⌘,) need foreground. Foreground delivery
  restores the *previously* frontmost app after each action — so recording staging must
  make the target frontmost first.
- **`set_value` on a slider/field writes the AX value, fires no DOM event, and React
  re-renders right over it.** Type and click like a user; confirm via the field's value
  in the next observation (`type_text` is never driver-verifiable).
- **Raw accessibility flakiness costs roughly one run in three** on Electron targets:
  trees that empty while the window renders fine, focus that jumps mid-run. Retries were
  clean every time — it's a throughput cost, not a capability limit — but it's the
  biggest obstacle to unattended operation and the strongest argument for driving
  Electron via CDP instead.
- **Don't trust error messages' self-diagnosis.** The driver's "target not observable —
  most likely on an inactive Space" was demonstrably wrong at least once (the window was
  rendering fine; the tree had simply emptied). Read the evidence before believing the
  label. The same applies to your own error messages: report what was *observed*, not
  the most popular cause.
- **ScreenCaptureKit live streams deliver no frames to unsigned CLI binaries** (macOS
  26). Signed apps are unaffected — inside Yarn's signed app this constraint vanishes.
- **LaunchServices can bind an app name to the wrong bundle** — seen twice with a build
  shipping a nested copy of itself; `open -a` launched the inner bundle.

## 5. The cua driver: what we'd keep, what we'd leave

The POC used `@trycua/cua-driver` as the actuator. Full analysis in
`docs/research/2026-07-30-cua-learnings-for-real-implementation.md`; the essentials:

- **Sessions have a 300-second *absolute* lifetime from `start_session` — not an idle
  TTL.** A session kept busy every 5 seconds still died at 300.1s. This masqueraded as a
  step limit (exploration averaged ~20s/action, so death landed on action 15 every
  time). Fix: `start_session` is idempotent and refreshes the clock, so re-declare on a
  90-second heartbeat. And match *both* dead-session error codes (`session_ended` and
  `session_not_started`) in recovery, or you miss half the cases.
- **`close()` shuts down the shared daemon and kills every other run on the machine.**
  A one-off diagnostic script destroyed a 20-action exploration in flight. This forced
  the one-run-per-Mac lease — which on a fleet becomes a real scaling tax (parallelism =
  machine count).
- **Browser tools: a refusal is not an error.** `browser_prepare` returns
  `{status: "refused"}` with no error flag set, so exception-based handling walks
  straight past it and the run dies later blaming the wrong step. Check status
  explicitly on every browser call.
- **The driver's own reported click point can be wrong.** One run's Save button carried
  a click point 41px off the visible control (two same-named buttons, one offscreen) —
  and the recorded element rect was wrong *together with it*, so no consistency check
  between them could catch it. The before/after pixel diff is the independent witness.
- **Most of our workarounds were re-adding capability the driver has but doesn't
  expose** (DOM attributes, session lifetime, window-scoped recording). Consuming a
  sealed third-party binary means inheriting its threat model too — its consent gate
  protects arbitrary users' browser profiles, which a first-party fleet driving its own
  disposable profiles doesn't need, and answering it programmatically was the ugliest
  code in the repo.
- **The CDP-direct backend (playwright-core attaching to a Chrome/Electron we launch
  with `--remote-debugging-port`) deletes four liabilities by construction:** no session
  TTL, no shared daemon (no one-run-per-Mac cap), no consent gate, no node budget.
  Electron passes Chromium switches through — verified. Two CDP gotchas: Chrome
  throttles rendering for backgrounded tabs (screenshots time out — `bringToFront` at
  attach), and hardware encoders refuse odd frame dimensions (pad to even).
- **Recommendation carried forward:** CDP/Playwright backend first (covers customer web
  + Electron, the in-scope majority); keep the cua backend as the working bridge and the
  fallback for Electron apps that strip debugging flags; thin Swift sidecar for OS-level
  keys, native dialogs, and capture; native-Mac-app support only if the product grows
  that segment.

## 6. Canvas and painted content

Rendered content — timelines, previews, drawn widgets — has **no accessibility
representation at all**. Yarn's library showed a dozen video thumbnails; the tree
reported one 20×20 icon among 377 elements. Consequences:

- **Coordinate actions are necessary and verifiable — differently.** Drags and
  coordinate clicks join the action set, but their verification splits by channel: text
  says *what* changed; a pixel diff only says *something* moved. The channel is recorded
  per step, so a pixel-verified run can never be quoted as a text-verified one.
- **Geometry is a stronger witness than pixels.** A drag on painted content often moves
  *named elements around it* when the app re-lays-out. Comparing element positions
  across observations ("this button moved by about the drag distance, same direction")
  names what moved and how far. Match proportionally, not exactly — element frames are
  logical points and drags are screenshot pixels, and the ratio is a display property.
- **Vision-model coordinates: clamp images to 1568px on the long edge.** Larger sends
  get resampled server-side and coordinates come back in a frame neither side agreed on
  (a 3894px send returned points 1.7–2.0× off, and not by a consistent ratio). At
  1568px the same frame was accurate to a few pixels. Also: hit radius exceeds the drawn
  mark — a grab 7px off a 5px dot still worked, as draggable targets generally arrange.
- **"Drag it back" is not undo.** Canvases draw an indicator at the last press point —
  sitting exactly on what you dropped — so the reverse drag grabs the indicator instead.
  Use the app's undo, and click into the canvas first: shortcuts go to the focused
  control, and four undos "succeeded" while changing nothing because focus was elsewhere.
- **A local pixel diff cannot serve as a hit test** when any click draws feedback at the
  click point — a decoy click once scored higher than the target that demonstrably
  reacted. And whole-frame diffs are swamped by live previews/clocks; diff the row or
  strip the action ran along.
- **Be honest about the limit:** `done(success)` greps text against a fresh observation,
  which a painted-only target can never satisfy. Say so explicitly in the refusal, or
  the model retries the drag forever reading it as a miss.

## 7. Cleanup: the run puts the app back

A run used to be a one-way mutation — the canonical task really did leave the customer's
brand default changed, and the next run started from a workspace the previous one had
altered. On a fleet, a job that dirties its host poisons whatever runs there next.

- **Journal what actually changed, mechanically.** Diff control *values* between the pre-
  and post-action observations. Never trust the model's account of what it changed.
  Match controls across observations by (name, surface) — never by element handle.
  Append each entry the instant it's detected, so a crashed run leaves a recoverable
  journal.
- **Teardown replays the journal in reverse, and the harness writes the checks.** The
  target value is known, so the model cannot widen the check. And check the named
  control's *own value* with whole-value equality, not a haystack grep or substring: an
  open dropdown renders the original value as one of its options at exactly the moment
  the setting has *not* been put back (a grep scores that as restored), and substring
  matching declared "Auto" restored when the control read "Auto-hide".
- **A standalone cleanup command replays a journal after the process is gone** (the
  SIGKILL case) — and it must call the *same* teardown code; two implementations of
  "restored" is how they stop agreeing.
- **Ordering is load-bearing: teardown runs after the recording is assembled.** The
  video must end on the changed state — a demo of the agent undoing its own demo is not
  a deliverable.
- **Advisory by default.** "Did the task succeed" and "was the app left tidy" are
  different questions; don't let one verdict contaminate the other. (Same principle as
  the visual judge.) An entry with no recorded prior value counts as neither restored
  nor failed — the harness honestly declined to guess.
- **Created resources are reported, not deleted.** Deletion has no second chance, and
  the ledger is only as good as the model's discipline in declaring what it made. The
  prompt directs work into a fresh scratch document, and says plainly that claimed
  resources are reported — a model told its mess will be auto-deleted is the one that
  stops preferring scratch.
- **Skipping cleanup is a legitimate mode:** for filming, the changed end state *is* the
  artifact.

## 8. The fleet: persistent Macs, auth, and operations

The POC ended running on three colo Macs, dispatched from operators' laptops. The full
constraint list is LIMITATIONS §12; the shape-setting facts:

- **Auth decides everything.** Customer apps sit behind SSO+MFA, which is not automatable
  in the general case — so a signed-in session is a stateful, human-created asset that
  must persist between runs. That rules out ephemeral VMs and makes the deployment model
  *persistent machines that hold sessions*. Sessions are the scarce resource; machines
  exist to hold them.
- **Sign-in is a product surface, not an ops chore.** The prototype: a human opens a
  screen share (or a window-scoped live view) with the app already frontmost, signs in
  once per app per machine, and the tool closes the viewer itself once the app reaches
  its home state. **No credential ever enters the agent loop** — every observation and
  every recorded frame reaches the model and the demo video, so an agent that types a
  password is a live leak into two artifacts you hand to other people.
- **Per-operator profile swap on shared machines.** One signed-in app per Mac means
  whoever signs in owns it for everyone — the next person's demo shows someone else's
  documents. Swap the app's data directories per operator, and **quit the app first**:
  a running Electron app rewrites its cookie jar on quit and would write the outgoing
  operator's session into the incoming operator's directory. Serialize the swaps; two
  interleaved swaps destroyed a stashed profile. Known limit: apps keeping sessions in
  the login keychain aren't isolated by this.
- **A shared machine signed into a personal account leaks that account's whole vault.**
  Found the hard way: a live-view sign-in put Chrome's autofill dropdown on screen for the
  watching teammate, listing colleagues' email addresses. Behind it, all three Macs had THREE
  people's personal Google accounts in one shared Chrome profile — two `@gmail.com` — with sync
  on and **801 saved credentials each**. The identical count across three machines is sync
  working as designed: one vault, replicated. The app was incidental; the cause is a personal
  identity on shared infrastructure, and it leaks through whatever that identity syncs to.
- **Clearing synced passwords is only safe with the browser CLOSED.** Deleting through a
  running, signed-in Chrome emits `PasswordStoreChange::REMOVE`, a sync **tombstone** that
  removes the credential from the person's Google vault and every device they own —
  irreversible, and not a thing automation should do. With Chrome closed nothing is connected
  to Google to report the deletion, so removing the profile directory is purely local: the
  accounts keep their vaults, the machine forgets them. Automating it is therefore *safer* than
  the manual UI route, provided the tool quits the browser first and **refuses if it will not
  exit** (a delete underneath a live Chrome is written back on quit). Remove whole profile
  directories, not selected files: deleting `Login Data` alone leaves `sync_model_metadata`, and
  the next launch re-downloads everything — a deletion that appears to work and silently
  reverses itself. `./run browser-wipe` implements this.
- **A wipe is not a fix; policy is.** Sign the same account back in with sync and the vault
  returns. `SyncDisabled` and `BrowserSignin: 0` close it permanently — the second is stronger,
  since a browser that cannot be signed into a profile has no vault to download, and **website
  OAuth is unaffected** (verified: the Google sign-in page loads normally under both). Note
  `PasswordManagerEnabled: false` does NOT hide already-saved passwords — Chromium reads it only
  in `IsSavingAndFillingEnabled()`, never in `IsFillingEnabled()`, and no Chrome policy disables
  filling. Both keys are mandatory-only, hence the configuration profile above.
- **The OAuth handoff stops on browser chrome the page-scoped stream cannot show.** A sign-in
  ends with the page launching the app's URL scheme, and Chrome interposes "Open <App>?". A CDP
  live view streams the page only, so the flow just halts on a button the remote human cannot
  see. `AutoLaunchProtocolsFromOrigins` skips it for a named scheme from named origins. Read the
  scheme from the app's `CFBundleURLTypes` and the origin from its bundle rather than guessing:
  a wrong value grades the host clean while every handoff still stalls.
- **Never let variable text cross SSH as command text.** sshd joins remote arguments
  into one string for a login shell, so anything reaching it as text is shell input on
  the far side no matter how carefully quoted here. Task names carry spaces; URLs carry
  `&`. Variable data crosses as an encoded spec file; command lines are fixed tokens.
- **Pin fleet hosts by SSH host key, never by address** — colo addresses move between
  machines; the fingerprint is the only field that still says "same box."
- **A dispatched run must outlive the dispatcher.** Detached child owning its own log
  file, resumable log-follow by byte offset, artifacts pullable any time. A closed
  laptop lid must cost nothing against a 40-minute grounding pass.
- **Re-derive state; don't trust records.** A job record saying "running" is a claim
  about a pid — ask the kernel on startup and mark orphans, or a killed runner leaves a
  registry that lies. Same for leases: validity is process liveness, never a TTL, and
  the claim is a single `O_EXCL` file create so two racing operators can't both win.
- **Sync grounding artifacts by their own embedded timestamp, never file mtime** — git
  restamps every file on checkout, so a fresh clone looks newer than last week's
  finished pass and overwrites it.
- **Resolve paths from the install, not the working directory.** A LaunchAgent and a
  packaged app both start with cwd `/` — and everything keeps "working" while writing
  to `/out` and silently running ungrounded.
- **Parse env knobs strictly.** `Number(process.env.X ?? default)` has two silent
  failure shapes: `X=` (unset variable interpolated into a plist) becomes 0 — which for
  a cleanup-steps knob disables teardown outright — and a typo becomes NaN, which
  answers false to every comparison. Die at startup naming the variable.
- **Retry model calls, and route around a named failing provider.** Aggregators fan one
  model id across hosts and name the failing host in the error; backoff alone re-asks
  the same broken one. A mid-stream timeout once killed a 40-minute pass at action 1.

## 9. Recording and the human-feeling cursor

Two facts set the architecture, both confirmed with Jasper: the pipeline **reimposes a
synthetic cursor in post** (they want click points + timestamps as data), and their
timing system compresses model-thinking gaps automatically. So reliability (verified
robotic actions) and feel (human motion) fully decouple.

- **The physical pointer never moves during a run** — accessibility actuation doesn't
  touch it (measured: 1.2% of cursor samples showed any motion, all teleports). The
  cursor must be drawn in post, which means the run must persist the data the renderer
  needs: per-action click point and timestamps, the target element's role and rect
  (role → pointer type: I-beam over text fields, hand over links), per-frame capture
  times, and window geometry. Our recording pipeline computed all of these and
  originally *discarded* them.
- **Capture the window, not the display.** Display-level capture recorded the user's
  unrelated personal content during testing — rejected outright. Polling the driver's
  window snapshots is immune to occlusion; assemble the mp4 from those.
- **Capture-side hygiene beats post-hoc repair.** Wait for the window to report a stable
  size before recording (staging resizes it and the capture surface lags — we got 25
  opening frames of the *previous run's screen* at the wrong size). Sample densely right
  after each action (the app's response arrives within a second or two and can fall
  between fixed-rate captures) and slowly when idle.
- **Never animate what didn't happen.** A no-op click that failed verification, the home
  reset's own navigation (the driver's recorder backfills earlier turns), an atomic
  `set_value` drawn as keystrokes — each of these got rendered before we learned to
  drop it, and each reads as the agent doing something it didn't do. When an action is
  dropped, drop its *footage* too, or the view flickers with nothing driving it.
- **Fit motion to the signal the audience sees, not the raw input.** We first fitted
  human-motion synthesis to raw mouse data (ballistic launch + corrective strokes,
  ~7 velocity peaks per reach). Yarn's renderer then smooths motion through a spring
  filter that removes almost all of it — so we had optimized against the wrong signal
  and had to refit against the *post-pipeline* data. Generally: replaying real human
  segments beat synthesizing motion; the velocity profile matters more than path shape;
  and scale-replaying a long reach onto a short distance produces visible wander (short
  hops get synthesized).
- **Coordinate spaces shift *within* a run.** Capture width changed four times in one
  run (window moved between displays); the first frames carry transient geometry. Scale
  click points per turn, take the modal frame size (not frame zero), and correct click
  points against the before/after pixel diff — the one witness independent of both the
  driver's report and the recorded rect.
- **Details that made it read as human:** the cursor departs shortly after each action
  and *waits at the next target* (parking the thinking gap on the previous control reads
  as "stuck"); the pointer type switches when it crosses into the target's rect, not at
  the click; a synthetic hover tint on the target (the app never paints one — no real
  mouseover ever fired); landings scattered inside the target instead of the exact
  centre, which was the most machine-like thing left.

## 10. Two behavioral rules worth carrying over

- **"Show me how to X" means perform X**, end to end, leaving the app changed — the
  deliverable is a demo video, and narrating a path while touching nothing is a failed
  run. An unspecified value ("change the cursor type" — to what?) is the agent's to
  choose and state, not a reason to stop short. Changes must be committed (Save/Done)
  and confirmed to have survived.
- **Except irreversible or externally-visible actions** — delete, publish, send, share,
  purchase, account changes — which go to the final confirmation and stop, saying so.
  Without the carve-out, "show me how to delete a draft" deletes a draft. (Verified: 12
  drafts before, 12 after.)

## 11. What to build first (the condensed recommendation)

From `2026-07-30-cua-learnings-for-real-implementation.md`, which argues this in full:

1. **Lift the harness** — agent loop, verification stack, grounding pipeline,
   journal/teardown, run-log discipline — behind the existing observation/action seam.
   It has already hosted three backends; it is the proven 80% and is actuator-agnostic.
2. **CDP/Playwright backend first** for customer web and Electron targets; keep the cua
   backend as the day-one bridge and the fallback for apps that block debugging flags.
3. **Thin Swift sidecar** for OS-level keys, native dialogs, and window capture on the
   Mac fleet.
4. **Treat sign-in as a product component** — the auth constraint is why the fleet is
   persistent Macs at all.
5. **Recipe compilation is the production cost lever:** grounding-time thinking →
   deterministic replay with the model as exception handler only. Whatever backend you
   choose, recorded actions must be replayable without a model in the loop; CDP makes
   this trivial. (Designed, not yet built — the storage tier exists.)

And the meta-lesson that pays for everything above: **when a rule matters, put it in
code.** Every gate in this system — prompt hygiene, evidence grammar, provenance stamps,
harness-written logs, destructive-action guards — started as a rule someone broke while
meaning well.

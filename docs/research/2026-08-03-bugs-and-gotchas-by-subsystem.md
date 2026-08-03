# Bugs and gotchas, by subsystem — a build guide for the production version

2026-08-03. Written for the engineer implementing the real thing.

This is the **catalogue**: every bug and trap we hit over the seven-day POC, grouped by the
function of the system it belongs to, each with what we tried, what went wrong, how we fixed
it, and how to build that piece from scratch so it never happens to you.

It is a companion to, not a replacement for, three documents that came before it:

| doc | what it is |
|---|---|
| `docs/research/2026-07-31-poc-gotchas-and-lessons.md` | the plain-English narrative version, through 07-31 |
| `FOR_AMAN.md` | the technical handoff — what to copy, redesign, and not build |
| `LIMITATIONS.md` | the running severity-ranked constraint log, still the source of truth for environment limits |

What this one adds: coverage of 08-01 → 08-03 (the benchmark data layer, the stopping contract,
the snap stage, the recipe/procedure swap, the filmed-run collapse), and a per-subsystem
organisation so you can read only the section you are currently building.

**Vocabulary warning.** `recipe` and `procedure` swapped meanings on 2026-08-03. Throughout this
document: a **recipe** is *prose harvested from a successful run, for a model to read*; a
**procedure** is *compiled JSON that replays exact clicks with no model in the loop*. Any older
doc, filename or run log from before that date means the reverse.

---

## Contents

1. [The agent loop and how a run ends](#1-the-agent-loop-and-how-a-run-ends)
2. [Verification and evidence](#2-verification-and-evidence)
3. [Perception: observing the app](#3-perception-observing-the-app)
4. [Actuation: clicking, typing, focus](#4-actuation-clicking-typing-focus)
5. [Backends and app acquisition](#5-backends-and-app-acquisition)
6. [Grounding: the exploration pass](#6-grounding-the-exploration-pass)
7. [Reuse: procedures and recipes](#7-reuse-procedures-and-recipes)
8. [Cleanup: putting the app back](#8-cleanup-putting-the-app-back)
9. [Recording and the humanized cursor](#9-recording-and-the-humanized-cursor)
10. [Remote execution: the fleet](#10-remote-execution-the-fleet)
11. [macOS platform traps](#11-macos-platform-traps)
12. [Model transport, cost and configuration](#12-model-transport-cost-and-configuration)
13. [The measurement layer](#13-the-measurement-layer)
14. [Run data, artifacts and paths](#14-run-data-artifacts-and-paths)
15. [The five failure shapes that recurred](#15-the-five-failure-shapes-that-recurred)

---

## 1. The agent loop and how a run ends

### 1.1 A step budget silently became a verdict

- **Tried:** one number, `AGENT_STEPS`, as the operating limit — 15 at first, later 30 for
  creation tasks.
- **Broke:** a run that hit the limit recorded `success: false`, which collect mapped to
  `gave-up` — the same label as an agent that reasoned its way to a wrong conclusion. Seven
  script-writing runs stopped at exactly 15 and read as "the agent cannot make a video," when
  the only known-good run of that flow takes 19. Every pre-split `gave-up` count in the data is
  suspect for the same reason.
- **Fixed:** three named exits. `success`; `stopReason: "stalled"` (the agent genuinely cannot
  proceed); `stopReason: "step-ceiling"` (the harness cut it off). The ceiling moved to 100 and is
  a **runaway backstop, never a budget** — a run must never fail because it ran out of steps. A
  test fails the build if any arm pins `steps` below the backstop.
- **Build it as:** two separate numbers with two separate names from day one, and a rule that the
  harness ending a run is recorded as a fact about the *harness*, never folded into the agent's
  verdict. Keep harness-ended runs **out of the success denominator** entirely — a rate should read
  `2/2 +1⏹`, not 67%.

### 1.2 The stall detector: what may and may not reset it

- **Tried:** end a run after N consecutive steps that made no progress.
- **Broke:** "progress" is the whole difficulty. Resetting on a successful driver call, on moved
  pixels, or on the model's own account all let a stuck run continue indefinitely. Worse, `wait` is
  deliberately exempt from the discrimination requirement (the point of a wait is that already-true
  state *persists*), so a `wait` whose expectation is already on screen verifies against a screen
  nothing changed on — free, repeatable, indistinguishable from progress. A model alternating
  `wait` with unproductive actions never stalls and burns the full backstop.
- **Fixed:** the counter resets on a **verified step and nothing else**, and a verified `wait` is
  carved out explicitly. Default window 8, widened per-arm to 16 for tasks with legitimately long
  unverifiable stretches.
- **Build it as:** define stall on your single authoritative verification channel, and enumerate
  the actions that cannot count as progress *before* a model finds them.

### 1.3 The stall window was the one number an arm could not tune

- **Tried:** ship the stall detector, leave the constant global.
- **Broke:** `AGENT_STEPS` was tunable all the way down the dispatch wire; `AGENT_STALL_STEPS`,
  which is what actually ends a working run, had no wire field at all — not on the options type,
  the job spec, the job record, or the child env. The knob that mattered could not be turned. A
  default window of 8 then constrained hardest exactly the arms least able to satisfy it (a
  successful script run carried 11 unverified steps out of 19 — typing into a rich editor puts
  almost no checkable text on screen).
- **Fixed:** `stallSteps` crosses the wire, floor 2 (1 ends a run on its first unverifiable step),
  ceiling 100 (a window wider than the backstop can never fire).
- **Build it as:** when you promote a constant to "the thing that ends runs," promote its wire
  plumbing in the same change.

### 1.4 A dangling `if` destroyed every stall verdict one line after it was set

- **Broke:** `if (!outcome)` with no braces guarded a blank line, so the backstop assignment below
  ran unconditionally. Runs that stalled at 8 steps recorded "runaway backstop (100 steps)
  reached." The detection fired, broke the loop at the right moment, and had its answer
  overwritten. *That is the failure mode that looks exactly like a feature nobody built.*
- **Caught by:** the numbers disagreeing with each other — 30 "step-ceiling" failures with a
  median of 16 steps, against a backstop of 100. Not by a test, not by review.
- **Fixed:** braces, and a test that asserts the braces rather than the behaviour, because the
  behaviour was correct the whole time. 27 runs relabelled.
- **Build it as:** make outcome assignment a single expression or a state machine that cannot be
  written twice. And treat internally-inconsistent aggregates as a bug signal — that median was
  the only witness.

### 1.5 The exit the harness offered the model was unreachable

- **Tried:** a concede path — when the app goes dark, tell the model to call `finish` and salvage
  what it learned.
- **Broke:** the "call finish NOW" message was pushed into the transcript and thrown past on the
  same tick, so the model got two turns to attempt recovery and zero to give up. Invisible in
  review (message and throw read fine apart) and invisible in the logs (the transcript is never
  printed).
- **Fixed:** the recovery ladder is a pure function so its ordering is asserted rather than
  eyeballed — model's own moves → the move the model doesn't have (restart the app, re-acquire) →
  one turn to concede → fatal. Restoring the old behaviour fails exactly the two tests that
  describe it.
- **Build it as:** any "the model may now do X" affordance needs a test that the model can actually
  *reach* X. Do not grep console logs for a message sent to the model — it never appears there.

### 1.6 `wait` needs a duration argument, and it is not a nicety

- **Broke:** before `wait` took `seconds`, the longest expressible pause was the ~900ms settle. Apps
  that embed their own AI assistant (Yarn's thinks for up to five minutes) cost ~330 model
  round-trips against a 15-step budget to wait out.
- **Fixed:** `wait { seconds }`, clamped to 10 minutes.
- **Build it as:** waiting is a first-class action with a duration. Also: an unhandled action name
  must be a typed error the loop reports back as a rejected step, not a crash — the model
  self-corrects.

### 1.7 Interrupts are data, and handler ordering ate them

- **Broke:** the overlay component's SIGINT handler called `process.exit()` before the run loop's
  flag-based handler ran, which skipped the run log, teardown and session close on **every
  interactive stop, by default**.
- **Fixed:** Ctrl-C sets a flag honoured between actions (never mid-action); the `finally` still
  assembles video, writes the log, runs teardown. Any component registering a signal handler defers
  when another handler exists.
- **Build it as:** one signal owner, and everything that must survive an interrupt goes in a
  `finally` block owned by the run.

---

## 2. Verification and evidence

**Design principle, stated once:** the model proposes, the harness disposes. Treat the evidence
grammar as an adversarial interface — under pressure to report success, the model will find
whatever loophole exists. Every hole below was found because one did.

### 2.1 Expectation must be stated before the action, and be machine-checkable

- **Tried:** act, then ask the model whether it worked.
- **Broke:** the model acts first and rationalises afterward.
- **Fixed:** the act tool requires substrings that will appear/disappear in the *next* observation.
  An act call with no checkable expectation is **rejected unexecuted** — it costs the model a turn.
- **Build it as:** expectation and action in one tool call, and refuse the call rather than
  executing it and grading later.

### 2.2 A "required" tool field can simply be missing

- **Broke:** the `expectation` field arrived absent on the OpenRouter path, which does not strictly
  enforce tool schemas. The harness acted anyway and reported an unqualified success — which is how
  vacuously-verified steps entered the run logs.
- **Fixed:** the gate is unconditional rather than transport-specific.
- **Build it as:** assume any router, proxy or translation layer in front of the model can drop a
  required field. Validate tool input at your boundary, always.

### 2.3 Checks must discriminate against the pre-action state

- **Broke:** an expectation already satisfied *before* the action proves nothing about the action —
  e.g. verifying "GMT+2" when the screen already showed GMT+2 beside the unchanged setting.
- **Fixed:** an expectation satisfied by the pre-action observation does not count. This single rule
  killed the largest class of false positives.
- **Build it as:** keep the previous observation's haystack and require the check to flip.

### 2.4 The degenerate evidence cases, all found by a model

- `textIncludes: [""]` passes against any screen — every string contains the empty string.
- Whitespace-only substrings pass everything.
- Excludes-only evidence with no prior baseline proves nothing.
- On the `done` path there is **no previous haystack**, so the discrimination guard doesn't run —
  which made `done(success, evidence: {textIncludes: [""]})` a free pass until blanks were stripped.
- **Fixed:** blanks stripped before the presence check, then "nothing left to check" fails as
  uncheckable; a **shared `checkableCount()`** between the gate and the verifier so they cannot
  disagree about what counts.
- **Build it as:** one function defining "checkable," called by every gate. Enumerate the degenerate
  cases in tests explicitly.

### 2.5 `done(success)` must be graded by the harness against a fresh observation

- **Broke:** the model declaring victory is not evidence.
- **Fixed:** `done` submits evidence; the harness takes a fresh final observation and grades it.
- **Build it as:** never let the terminal state be self-asserted. Note the cost this imposes — see
  §9.5, where it forces the agent to navigate back and costs every filmed run two clicks. Pay it
  anyway; the alternative reopens the hole that made the numbers trustworthy.

### 2.6 The four layers, and why their authority differs

| layer | when | authority | exists because |
|---|---|---|---|
| Text (AX/DOM labels + values) | per step | **gates the run** | deterministic, cheap |
| Pixel delta | per step | advisory | canvas content has no AX/DOM representation at all |
| Geometry (element frames shifting) | per step | advisory, stronger than pixels | a drag re-lays-out *named* elements around painted content |
| Visual judge (separate model call) | once, at `done` | advisory (`block` mode available) | catches wrong-scope, which text cannot |
| Offline run judge | post-hoc | advisory | re-grades the whole trajectory adversarially against an answer key |

- **Build it as:** record the channel that verified each step (`verifiedByChannel`), so a
  pixel-verified run can never later be quoted as text-verified.

### 2.7 The judge must receive the agent's *claim* — but the *task* is the standard

Two mirror-image lessons, both learned by getting them wrong:

- **Visual judge:** given only the task string "show me how to change the cursor type," it **passed**
  a known-wrong-scope frame, reasoning that an instructional task only asks to *locate* the control.
  Given the agent's claim ("I changed the brand-wide default"), the same frame fails as contradicting
  it. → **attach the claim.**
- **Offline judge:** its first prompt draft graded the claim and **passed** a run that accurately
  described doing the wrong thing. → **the task is the standard**; the claim only disambiguates.
- **Build it as:** claim for disambiguation, task for the standard. Write both rules down next to
  the prompt, because they read as contradictory and are not.

### 2.8 An absent advisory verdict printed identically to a passing one

- **Broke:** the visual judge silently returned nothing when its token budget ran out mid-reasoning
  (`stop_reason: max_tokens`, only a thinking block, zero text) — on exactly the frames that were
  hardest to judge.
- **Fixed:** generous budgets, and "no verdict" printed explicitly.
- **Build it as:** see §15.1. This is the repo's most expensive bug shape.

### 2.9 Perception and rendering die separately

- **Broke:** two runs kept a full, addressable AX tree for 15 steps — elements resolvable,
  verification grepping a plausible haystack — while the window never repainted once. 247
  byte-identical frames; five minutes of video of a still image. Healthy on the channel that gates,
  dead on the channel that ships.
- **Fixed:** `unpaintedStreak()` counts trailing steps that verified nothing *and* moved no pixels.
  Replayed over 48 historical logs it flags exactly those two runs, at step 4.
- **Deliberately reports rather than aborts:** an app waiting on its own embedded model produces the
  identical signature while working correctly. What ends a dead window is the stall detector at 8
  (§1.2) — strictly weaker, on purpose.
- **Build it as:** detect it, name it, don't act on it. A frozen window and a slow app are
  indistinguishable from outside.

### 2.10 Verification cannot tell *which* control it verified — the wrong-scope class

**The single most important finding in the POC.**

- **Broke:** Yarn keeps ~10 settings at two independent scopes — a brand-wide default and a
  per-project override, verified to be separate stores. On "change the cursor style," **all four
  ungrounded runs changed the per-project override, passed every check, and truthfully reported
  success.** Substring evidence proves *a* control reads the target value; the disambiguating
  context (breadcrumb, panel title) is exactly what a flattened haystack destroys.
- **Mitigated, never solved:** the appmap graph tags controls with a `settingKey` + `scope`;
  `findScopeAmbiguities()` finds settings at 2+ scopes; `scopeWarnings()` injects **both** routes
  into the prompt and requires the agent to state which it chose and why.
- **Do not hardcode a preference.** "Prefer the broadest scope" is flatly wrong the moment a task
  says "for just this project." Verified the agent picks correctly from task context both ways.
- **Group warnings by surface pair, not per setting:** 10 settings sharing one pair of panels was
  10.8k characters listed separately vs 1.9k grouped. Prompt real estate is a budget.
- **Measured outcome:** only *human-written* notes made the agent change the global setting, 5/5.
  Every automatically-generated grounding tier sent it to the per-document one — though the
  generated map contains both routes. So this is about which route reads as the obvious choice.
- **Build it as:** assume any app with global defaults plus per-document overrides (editors, IDEs,
  design tools, browsers) has this class. Make the agent *state* its scope choice — an unstated
  choice is indistinguishable from a wrong one — and surface it in the demo itself ("this changed
  one draft, not your defaults").

---

## 3. Perception: observing the app

### 3.1 Chromium's AX tree drops DOM `id` and `class`

- **Broke:** they are not part of the ARIA mapping, so an icon button with no `aria-label` reaches
  the driver as `AXButton ""`.
- **Fixed:** Chromium's Mac bridge still exposes the source node as nonstandard AX attributes —
  `AXDOMIdentifier`, `AXDOMClassList`, `AXHelp`, `AXDescription`, `AXPlaceholderValue`, `AXURL` —
  which most drivers never read. Those live behind the Accessibility **C API**, unreachable from
  Node, so a ~120-line Swift sidecar walks the same tree and emits them as JSONL. Measured on Yarn:
  **955 of 1044 anonymous nodes gained a name**, including 37 of 64 anonymous *interactive*
  controls. Cost ~0.5s/observation, and output got *smaller* because dropping Chromium's placeholder
  text freed more than the descriptors added.
- **Join the two walks by frame geometry** — element indices come from independent walks and are not
  comparable. Nested wrappers share bounds; innermost wins by convention. Round the way Swift rounds
  (`Math.round` takes −0.5 → 0 where Swift takes it to −1 — this was a real bug).
- **Build it as:** on CDP you get the DOM directly and this entire layer evaporates. Only rebuild it
  if you keep an AX-only path for flag-stripped Electron apps.

### 3.2 Anonymous form controls on CDP broke everything keyed on a name

- **Broke:** Yarn's settings selects reach the CDP snapshot nameless — the visible "Cursor Style"
  text is a sibling row with no structural link. Everything keyed on `(name, surface)` — the
  mutation journal, teardown, wrong-scope accounting, recipes — silently skipped them. The e2e
  cursor run changed the brand default and left **no journal entry**, so nothing put it back.
- **Fixed:** synthesize names for anonymous **form** controls (combobox, textbox, checkbox, radio,
  switch, slider, spinbutton — never buttons/links) from the nearest same-row static text: preceding
  first, following only for the trailing-checkbox-label shape, scan ends cold at any other control.
  Garbage guards drop values, bare numbers, sentence-shaped helper copy, >60 chars. A tie
  (control–text–control) names **neither** — a wrong pairing is worse than anonymity. Authored names
  are never overwritten.
- **Build it as:** synthesize conservatively and mark synthesized rows. Genuinely nameless controls
  should skip the journal, correctly.

### 3.3 Text inside a control is never a sibling's label

- **Broke:** the second of two dropdowns sharing a row adopted the *first* one's value echo as its
  synthesized name. A name derived from a neighbour's current value changes whenever that value
  does, which breaks `(name, surface)` journal matching.
- **Fixed:** label events suppressed for rows nested inside real control roles. `cursor: pointer`
  generics are deliberately *not* suppressors — a clickable row container holding its label is
  exactly the wrapped-label shape synthesis exists to read.

### 3.4 A custom dropdown's current value is a text child, not a `[selected]` option

- **Broke:** Radix-style dropdowns mount options only while **open**, so the closed combobox has no
  `[selected]` child and parsed with value `""`. `optionCommit` could never match a clicked option's
  label to its owner.
- **Fixed:** lift the first text-bearing non-interactive descendant of a **combobox** into its value.
  Combobox only — a listbox's first text child is its first *option*, not a current value.

### 3.5 A portal popup makes the rest of the page inert

- **Broke:** while a Radix-style popup is open every element outside it loses its ref, so the
  pre-click observation contains only the popup — the owning combobox is *absent entirely*, not
  merely valueless.
- **Fixed:** the prior value survives in exactly one place: the popup's own listbox, whose
  `[selected]`-option lift recorded what was current when the menu opened. Accepted as the
  before-value only when the named owner is absent **and** the listbox is the single valued
  list-shaped element left — the inert state guarantees that; anything more crowded is ambiguity and
  journals nothing.
- **Build it as:** the empty-journal class took **three stacked fixes** (§3.2, §8.3, this one), each
  identical from outside — "journal is empty" — and each proven by probing the live app over the CDP
  tunnel rather than by reading more code.

### 3.6 The observation drops most of the tree, deliberately — know what it costs

- `observe()` keeps only elements with a label, value or DOM descriptor, plus 8 whitelisted roles.
- **Cost:** canvas/preview content has no AX representation at all. Measured on Yarn: 377 addressable
  elements, exactly **one** `AXImage` (a 20×20 icon), while a dozen video thumbnails rendered on
  screen.
- Restore containment with `in="<nearest named ancestor>"` so structure survives the flat list.
- Suppress generated ids (Radix `radix-_r_sj_`, MUI `:r3:`) — unstable across renders, identical
  across siblings.

### 3.7 Element handles are per-snapshot walk order

- They renumber whenever the tree changes shape — which is exactly what an action causes.
- **Never cache one.** Resolve by role + label against a fresh observation.
- This same fact shows up four more times in this document: journal matching (§8.1), frontier keying
  (§6.3), geometry verification (§2.6), and procedure resolution (§7.2). It is load-bearing.

### 3.8 A locked screen mimics accessibility flakiness

- **Broke:** tree present but empty, screenshots of the lock wallpaper — indistinguishable from AX
  going dark.
- **Fixed:** `screenIsLocked()` via `ioreg` (works from any runner context) names it.

### 3.9 Don't trust an error message's self-diagnosis

- The driver's "target not observable — most likely on an inactive Space" was demonstrably wrong at
  least once: the window was rendering fine and the tree had simply emptied.
- **Build it as:** report what was *observed*, not the most popular cause. Read the frames before
  believing the label — including your own labels.

### 3.10 Picking a window: ask "can it answer," never "does it exist"

- **Broke:** four AX passes died 15–20 minutes deep. A click opened an untitled window; the pick
  returned a different id, so control took the "moved" branch and adopted it **without asking whether
  it had content**. The harness chose a mute window for the agent and then reported the app as
  unobservable. Each earlier fix covered the case that had just bitten, and the fourth crash walked
  through the gap between them.
- **Fixed:** one ladder, asked of every candidate — front window → any other window of the app →
  re-activate and look again. Every rung tests *can this answer*. A dead held window needs no special
  case: the pool comes from the live listing, so it simply isn't in it.
- **Build it as:** one ladder, not three patched branches. And report re-activation **either way** —
  logging only success made a refused activation indistinguishable from one that never ran.

---

## 4. Actuation: clicking, typing, focus

### 4.1 Driver warnings lie in both directions

- "Element does not advertise AXPress" clicks usually work anyway.
- Clicks that report success sometimes silently no-op.
- A silent no-op is the worst case: subsequent keystrokes land on whatever *is* focused and trigger
  the app's global shortcuts (a stray "P" opened an unrelated overlay).
- The driver's "delivered N of M" counter is provably wrong — one run said "0 of 11" while the
  keystrokes created two scenes.
- **Build it as:** only re-observation tells the truth. This is the whole argument for
  verify-per-action.

### 4.2 `set_value` writes the AX value, fires no DOM event, and React re-renders over it

- Same for `AXSlider`. Actuate like a user: click, ⌘A (fields are often pre-filled — typing without
  select-all appends "New YorkParis"), type.
- `type_text` is never driver-verifiable ("sent via CGEvent") — confirm via the field's value in the
  next observation.

### 4.3 Delivery mode is app-specific and cannot be assumed

- Yarn: background-delivered clicks are **silently no-ops**; background scroll is refused outright.
  Everything needs foreground.
- Notion Calendar: background mostly worked.
- Menu-bar keyboard equivalents (⌘,) always need foreground; plain menu AXPress from background
  fails with -25202.
- Foreground delivery restores the *previously* frontmost app after each action — so recording
  staging must front the target first, and the resulting focus churn is itself what destabilizes
  Electron's AX tree.

### 4.4 Escape is not a universal dismiss

- Yarn's settings modal ignores it; an unlabeled 42×42 X button closes it.
- Popovers survive across driver sessions and don't always close on window-scoped Escape.
- Per-item "…" popups on Library cards do not respond to AXPress at all.

### 4.5 Filmed runs cost a 4× reliability drop for a benefit we never received

- **Tried:** in demo/recording mode, translate element clicks into **coordinate** clicks, on the
  theory that AXPress "moves no pointer" and the film needs pointer motion.
- **Broke:** filmed AX runs succeeded **2 of 13**; unfilmed AX, **26 of 39**. And the premise was
  false — our own cursor data measured that CGEvent actuation doesn't move the physical pointer
  either (1.2% of samples, all teleports). *Neither* actuator puts a cursor in the frame; it is
  composited in post from click points the run records either way.
- **Fixed:** filmed AX clicks went back to AXPress — element identity cannot miss. Result **2/13 →
  6/9**, equal to unfilmed. CDP keeps hover→dwell→click untouched, because `locator.click()` resolves
  the element and scrolls it into view, giving hover *and* reliability.
- **Kept:** `type_text` still takes the demo sequence, because AXPress "may focus nothing" and typed
  text once leaked into Yarn's composer.
- **Build it as:** before trading reliability for cinematography, check whether the cinematography
  benefit exists. And note `demoTranslatable` had **no test** — the behaviour behind a 4× collapse
  was never pinned, which is why it surfaced in a benchmark instead of in CI.

### 4.6 The "~43px AX offset" was never an offset — it was a snapshot mid-reflow

- **Chased for three days** as a coordinate-mapping bug, with three plausible hypotheses (AX frame
  cache lag, a transient toolbar, Electron window insets) and a research note proposing a constant to
  correct.
- **Instrumented instead of corrected:** window 1570×970, shot 1568×969, scale 0.9987, height gap
  0.24pt. *The transform's inputs were sound the whole time.*
- **The actual cause:** `--record` **stages the window to fill its display at run start**, so the
  first read lands while Chromium is still reflowing. The same button, one observation apart:
  `y=21` (failed) then `y=74` (ok) — 53px. There is no constant; correcting one would have baked in
  an error that is sometimes zero.
- **Why it hid for so long:** AXPress actuates by element identity and ignores coordinates, so
  unfilmed runs never noticed.
- **Fixed:** `freshSnapshot` reads until **two consecutive reads agree** on named elements' positions
  (bounded, last read used regardless). Two agreeing reads rather than a fixed sleep — a sleep long
  enough for the worst case is paid by every step, and one tuned to the average still misses.
- **Build it as:** instrument the transform before correcting it. On CDP this class is structurally
  absent — element boxes and screenshots come from the same renderer space.

### 4.7 The mirror-image symptom: the verification observation beat the render

- Same run: steps 5–7 re-click "Project actions" and fail, then step 9 finds the menu **already
  open**. The clicks landed; the observation was too early.
- **Not fixed** — it wants a bounded re-observe before a step is called failed, and that change can
  mask real failures, so it should be made deliberately and on its own.

### 4.8 Playwright `evaluate` strings are **expressions**

- **Broke:** an arrow-function *string* yields a function object that serializes to `undefined`. The
  focused-skip check, the containment check, the moved-focus check and the `getBoundingClientRect`
  fallback all silently answered false/null **since birth**.
- **Unmasked by:** an error message blaming `<undefined>`.
- **Fixed:** locator checks are real functions; page checks are IIFE expressions.

### 4.9 Typing focus is a direction-aware problem, and it took five fixes

Each round of demo-typing testing found a new way for text to land in the wrong place:

- **Async mount:** Yarn's TipTap editor mounts asynchronously — focus sits on `<body>` while early
  keystrokes vanish, then the editor grabs focus. The first guard aborted on that *good* transition.
  → a non-editable start **waits** for the editor to wake, then refuses with nothing typed.
- **Mid-sentence blur:** re-renders blur the field. → focus *leaving* an editable gets a return-poll
  (3s) before aborting with exact progress.
- **"Editable" is too loose:** a click that spawned the canvas comment composer moved focus to a
  perfectly editable element across the screen. → the active element's rect must **contain the
  clicked point** (±8px).
- **Spawned editors:** comment pins and text-overlay tools mount an editable *exactly where you
  click*, satisfying even the geometric check. → editables are marked in a page `WeakSet` **before**
  every demo click; typing accepts only **pre-existing** fields.
- **Build it as:** "focus is on something editable" is not an acceptance test. Require identity,
  predation, and geometry.

### 4.10 The snap stage: treat the vision model's pixel as a hypothesis

- **Context:** vision-only driving missed its intended target **75%** of the time against **11%**
  with element addressing — and the raw number couldn't say *why*.
- **Before building the fix, build the diagnostic.** Have the vision tool require the model to
  *declare which control it means*, then on every coordinate step record the nearest interactive
  control, its distance, whether the point was inside it, and whether its name matches the
  declaration. That splits failures into **SPATIAL** (right control, missed its pixels — refinement
  helps) and **SEMANTIC** (hit exactly the control it named, still failed — refinement cannot help).
  Costs one pass over an array. Compute it **unconditionally**, including on arms where nothing acts
  on it, so snap-vs-no-snap compares two measured populations rather than a measured arm against a
  blank one.
- **Three defects in the snap implementation, all invisible to a green suite** because every snap
  test asserted the *source text* of the module rather than its behaviour:
  1. Having found the nearest control by distance, the code **threw that element away and re-looked
     it up by (name, role)**. The lookup returns the *first* match — and on CDP the name is
     frequently empty (Yarn's settings selects arrive as `combobox [ref=..]` with no name at all), so
     an empty-named hit matched the first nameless combobox in the tree. The action went to the wrong
     control while the log recorded `snapApplied: true`. **Use the geometry you picked.**
  2. Ties went to the **outermost container** — every rect containing the point scores distance 0,
     `d < best.d` is strict, and the list is in tree order, so a click inside a button inside a
     `cursor: pointer` wrapper snapped to the wrapper. → tie-break on smallest area.
  3. A snapped step wrote **no target metadata** — `target` resolved 86 lines before the snap ran, so
     every downstream reader (channel attribution, harvest, the cursor pass) saw a target-less step.
     → snap runs *before* target resolution.
- **Deliberately not fixed:** the rewrite is **not** vetoed when the snapped control's name disagrees
  with what the model declared. A veto would measure the harness's veto rate rather than vision-only
  actuation, and would discard exactly the SPATIAL rescues the stage exists to test. The mismatch is
  **recorded** instead — read a snap arm as an **upper bound**, not a score.
- **Build it as:** snapping to elements presupposes elements. The genuine analogue for an app with no
  element channel snaps to *image structure* (edges, contrast, widget-shaped regions) and is a much
  larger build. Decide which case you are in before starting.

---

## 5. Backends and app acquisition

### 5.1 The decision, condensed

| target class | use | why |
|---|---|---|
| Web apps | **CDP direct** (playwright-core → a Chrome you launch with `--remote-debugging-port` and a persistent profile) | mature, hireable, no consent gate, no shared daemon, sign-ins persist in the profile |
| Electron apps | **CDP direct** (Electron passes Chromium switches through — verified) | same; AX fallback for apps that strip the flag |
| Native chrome (menus, dialogs, file pickers, OS shortcuts) | thin Swift sidecar (AX + CGEvent) | CDP's Input domain reaches the renderer only |
| Native Mac apps | the AX path | no DOM exists |

- **One actuator seam is why a third of this codebase ports at all.** Only one module imports the
  driver; everything else speaks `Observation` / `ActionRequest`. That is how a second backend got
  added and a third deleted without touching the loop.

### 5.2 What driving through a third-party driver cost us

Four liabilities, each of which cost real debugging time, and all four deleted by CDP-direct:

1. **A 300-second *absolute* session lifetime** from `start_session` — not idle. A session kept busy
   every 5s still died at 300.1s. It masqueraded as a step limit (explore averaged ~20s/action →
   death at action 15, reproducibly) and killed two exploration passes before diagnosis. Fix on that
   path: `start_session` is idempotent and refreshes the clock, so heartbeat every 90s. Match **both**
   dead-session error codes (`session_ended` *and* `session_not_started`) or you miss half the cases.
2. **`close()` shuts down the shared daemon and kills every other run on the machine.** A one-off
   diagnostic script destroyed a 20-action exploration in flight. This single fact forced the
   one-run-per-Mac lease, which on a fleet means parallelism = machine count.
3. **A per-call, five-minute, single-use consent token minted interactively.** Four documented
   escapes all failed. What worked: the CLI checks for a **TTY, not a person**, so the token is
   minted under `expect` answering "APPROVE" — the ugliest code in the repo. (`script -q /dev/null`
   also supplies a pty but **races** the prompt; `expect` waits for the prompt text.) The lesson: the
   gate protects *arbitrary users'* profiles; a first-party fleet driving its own disposable profiles
   inherits a threat model it doesn't have.
4. **A non-configurable 300-node snapshot budget** (confirmed against the binary: output-only field).
   We built continuation-paging to climb out of it. Playwright's `ariaSnapshot({mode:"ai"})` returns
   the whole tree in one call.

- **Also:** never parse driver error prose with regexes — each one silently breaks if the driver
  rewords. Use typed errors. And **a `browser_*` refusal is not an error**: it arrives as
  `{"status":"refused", ...}` with `isError` unset, so exception-based handling walks straight past
  and the run dies three steps later blaming the wrong call.

### 5.3 Never build a middleman in front of a protocol you can speak directly

- We built a third backend that spoke to the same Chromium over the same protocol as CDP, but through
  the driver. It could only **add** the four liabilities above, never remove one, and it was dominated
  in both branches that matter: port open → speak CDP; port stripped → both die and AX is the
  fallback. Deleted.
- Recorded here because the reasoning keeps getting rediscovered, and because two problems get
  conflated: the `id`/`class` stripping is the **AX** path; the node cap was the **DOM** path. They
  have nothing to do with each other.

### 5.4 CDP's own gotchas

- **Input goes to the renderer.** Menu bar, browser chrome, OS dialogs, file pickers, permission
  sheets: unreachable. Keep an OS-level input path for those.
- **Chrome throttles backgrounded tabs**, and a throttled tab times out every `page.screenshot` —
  while the DOM snapshot channel never notices. The run looks healthy while the pixel channel
  silently loses every frame. `bringToFront` at attach.
- **libx264 refuses odd frame dimensions** (a 1200×953 viewport crashed the encoder). Pad to even.
- Use a **non-default debug port** so you can coexist with anything else speaking CDP.

### 5.5 The AX arms were losing to a launch flag, not to the accessibility API

- **Broke:** six AX passes died with "no addressable elements," 15–20 minutes deep, every time around
  Yarn's recording helper. The recovery ladder ran all three rungs and reported the truth.
- **The cause is the launch, not the backend.** Electron derives its accessibility tree from the
  renderer's DOM, so a renderer Chromium has **backgrounded** publishes none — for the whole app, not
  one window. The helper occludes the main window, the renderer parks, everything goes dark.
  `set frontmost` cannot help: it restores app *activation*, not a parked *renderer*.
- **The CDP path never saw this** because its launch passes
  `--disable-backgrounding-occluded-windows --disable-renderer-backgrounding`. The AX path used
  `open -a` with no arguments. **So the two arms differed in how the app was launched, and the
  ax-vs-cdp comparison was measuring that asymmetry alongside the backends.**
- **Fixed:** AX launches with the same flags. Note it only takes effect when `open` actually *starts*
  the process — a run inheriting a live app inherits its flags too, so this depends on the cold start.
- **Build it as:** before attributing a result to a backend, diff how each backend *launches the app*.

### 5.6 The AX blackout is a property of the app, not the harness

- Clicking Yarn's record/create control opens a native recording helper and Yarn's AX tree goes
  **dark permanently**. Escape, cmd+W and re-activation do not bring it back. Two passes died on the
  identical three actions before diagnosis; the two AX passes that completed simply never clicked
  that control.
- **CDP is unaffected** — the renderer keeps serving the DOM while a helper window is frontmost.
- **The retry policy was laundering the result:** blacked-out runs were thrown out and re-run until
  they dodged the trap, so the published numbers described "AX given it avoided the record button,"
  with the trap appearing nowhere. Blackouts and relaunches now ride in the artifact's stamp.

### 5.7 Electron acquisition races

- **Cold-start singleton race:** `quitApp` returns on System Events' word while the Chromium main
  lingers holding the single-instance lock, so a prompt relaunch becomes a **flagless singleton
  takeover**. Fix: wait for the mains to actually exit (process truth, 15s budget, never a kill).
- **Diagnose, don't guess:** a still-flagged dying instance is separated into booting / dying /
  sanitizing verdicts, instead of a fixed 2s probe that misread normal teardown as app hardening.
- **Budget asymmetrically:** cold launches get 60s vs the usual 20 — a dead arm costs a run, forty
  seconds of polling costs nothing.
- **Process truth first:** never trust a live port to be the target app.
- **The final error reports what was observed** (probes, child exit, surviving mains with/without
  flag) so the next failed run diagnoses itself.

### 5.8 Order of operations in an entry point is a real bug class

Two replay defects, both from the same week, both invisible locally:

- **Replay quit the app *after* attaching to it.** The cold start sat inside the try block ahead of
  the AX `findWindow`, which reads as "before acquisition" on the AX path only — the CDP acquire is
  *earlier* in the function. Sequence on CDP: launch flagged → attach to page → quit the app →
  observe. Every fleet replay died. It never showed locally because the app was already running.
  **The test asserts the ordering, because ordering is the whole defect.**
- **Replay never marked its app target for attach.** Two other entry points upgrade an app target so
  acquisition may relaunch it with a debug port; the replay CLI never did. Invisible locally (a
  hand-run replay always followed some earlier command that had launched the app flagged), then
  **6 for 6 across two Macs** on the first fleet dispatch.
- **Which collect read as two poisoned hosts.** That heuristic is host-scoped, so a defect in a code
  path common to both hosts presents as both machines being broken. **Six identical failures across
  two hosts is evidence *against* a host cause.**

### 5.9 Falling back between backends must be typed, loud, and recorded

- The cdp→ax fallback fires on a **typed** `EndpointUnavailableError`, never a regex over error prose
  (regex-over-prose broke twice).
- The run log records `backend` (what actually **drove**, not what was asked for),
  `backendFallback: {from, reason, detail}`, and `activation`.
- Every app-target acquire ends with **one genuine AppKit activation** (System Events `set frontmost`
  by pid, non-fatal on refusal). This is the fix for the menu-validation no-op class: foreground
  delivery fronts the app at window-server level for <1ms, which never makes it key/main in the NSApp
  sense, so menu items stay disabled.

---

## 6. Grounding: the exploration pass

**Cost:** a *finished* pass on Yarn = **40 min / 96 actions**, ≈2.8% of the ~24h/app onboarding
budget. Ignore any "~5–6 min per app" figure in older docs — that measured a pass truncated by a step
budget and is not comparable.

**Two artifacts per app, and the split matters:** prose (injected verbatim into the system prompt —
models read prose well) and a graph (nodes carry `scope`, controls carry `settingKey`; code queries
it, the model never sees it). A missing graph = graph features silently off.

### 6.1 Terminate on an empty frontier, not a step budget

- Every observation already lists the app's interactive controls, so `seen − actuated − dismissed` is
  arithmetic.
- A step budget is wrong in both directions: it truncates passes that still have surfaces to open,
  and lets finished ones keep burning.
- **Don't ask the model whether it covered the app** — a transcript by construction contains only the
  surfaces it visited.

### 6.2 But "frontier empty" is reachable by dismissing

- **Broke:** one uncapped pass cleared **104 unrelated controls in a single dismissal sentence** and
  declared itself done at 25 actuated of 262 seen.
- **Fixed:** a cap (default 20) refuses a bulk dismissal that names no specific surface → the same app
  went to **47 actuated / 396 seen**. Dismissal later took a **category the harness can check**, not a
  sentence it cannot.
- **Read `controls: N actuated / M dismissed / K seen` in the stamp, never the stop reason.**

### 6.3 Key frontier entries by (role, label, surface), never by handle

- Handles are walk order and renumber (§3.7). Siblings sharing all three collapse into one entry: a
  deliberate under-count, so the frontier converges instead of regrowing on every redraw.
- **Frontier credit must mirror actuation precedence:** crediting both a resolved handle *and* the box
  under the action's x/y retired a second control the run never operated — because the actuator drops
  x/y when a handle is present. It overstated the coverage number the stamp reports.

### 6.4 A giant same-role cohort eats the pass

- **Broke:** Yarn's font picker put ~1,500 entries on the frontier; the dismiss cap forced them out 20
  at a time, and the CDP pass spent **13 of 118 actions (11%)** on bookkeeping — refreshing,
  re-navigating, reopening the picker purely to dismiss its contents under a named surface. It learned
  nothing in any of them, and the map records the picker as one leaf node.
- **Fixed:** retire a large same-role, same-surface cohort as a **unit**.

### 6.5 The single misplaced prompt line that was the actual bottleneck

- **Broke:** "settings you toggle while mapping are put back automatically after the pass" lived inside
  the *guarded-descent-is-on* block, and that flag defaults off. So in all five discovery passes the
  model was **never told its changes get reverted** — while being told, three lines earlier and
  unconditionally, "leave it in the state you found it."
- **Measured consequence:** "would change state" was the reason for **51% of skipped controls on ax,
  70% on cdp, 50% on no-vision**. The mechanical guards, by comparison, refused 7–12 controls per pass
  — about 1% of skips. *The prompt was the bottleneck by two orders of magnitude.*
- **Fixed:** the promise sits with the always-on rules; "leave it as you found it" is scoped to the
  **user's content**; "anything that would leave the app changed" is explicitly called out as **not** a
  licensed dismissal reason.
- **Build it as:** when a coverage metric is dominated by one refusal reason, read the prompt before
  reading the guards.

### 6.6 Salvage the map when the pass dies mid-run

- **Broke:** `finish` was the only artifact writer, so any throw discarded the whole pass — silently,
  with the stale previous map still on disk **looking current**.
- **Fixed:** everything learned is already in the transcript. On a crash, one final model call
  (tool_choice pinned to `finish`, after answering any dangling tool_use) emits the map, stamped
  `salvaged` so readers know it is weaker.

### 6.7 A conceded or cut-short pass must be demoted, unconditionally

- **Broke:** conceding sets the same "model called finish" flag as sweeping the frontier, so left alone
  it would publish over a complete map and count as a delivered sample — *a graceful exit that quietly
  improved the benchmark*.
- **Worse:** the demotion rule compared against half the committed map, so with **no** committed map
  the comparison was `size * 2 < 0` — always false — and it published unconditionally. Least
  protective exactly where there is no baseline, which is every arm's state after a wipe.
- **Fixed:** no baseline ⇒ demote. Conceding buys a clean stop reason and a findings write-up in the
  run folder, never publication.
- **Deliberately not built:** a quality score. Absolute size breaks on small apps; a coverage ratio
  counts dismissals, so the pre-fix passes that skipped 1,933 of 1,985 controls would score 0.97 while
  the best pass of the night scores 0.06. It would reward exactly the behaviour the dismissal cap
  removed. **The honest signal is structural — did the pass end on its own terms.**

### 6.8 Have the pass declare the app's `home`, and validate the declaration

- It is a **test fixture** (runs reset to it so arms are comparable), never shown to the task agent.
- **Do not derive it structurally from the graph** — every structural signal picks wrong. Exploration
  spends its time in settings panels, so subtree size picks the *document editor*, the most stateful
  possible start.
- **Validate the declaration against the walk's own evidence** (surface must be a recorded node;
  control must appear in an edge action) — this one field silently governs every future run's start
  state.
- **Match the label at the role position only.** Matching it anywhere in a rendered line meant a
  control reading `value="Library"` or nested `in="Library"` satisfied the home check — so the reset
  could click the wrong element and the probe could call a sign-in wall "ready."

### 6.9 The home probe doubles as a sign-in-wall detector

- A freshly installed app sits at a login screen, and its declared home control is exactly what is
  missing there.
- **Ungated, the agent treats the wall as the task** — one real run opened an OAuth flow in Chrome
  before being killed.
- Refuse to run with a distinct exit code and a clear message, rather than spending a budget fighting
  a wall it cannot pass. (Make that exit code a **technical** failure in your accounting — see §13.7.)

### 6.10 Destructive controls: split the verb classes, and hold the leash in the harness

- **Externality verbs** (send / publish / share / purchase / account) — hard refuse, always.
- **Reversible-looking verbs** (delete / reset / archive / export) are two-phase in any well-formed
  app: the press opens a confirmation that commits nothing. Opt-in descent lets the pass press
  **once**; the **harness** classifies what surfaced (confirm-dialog / file-sheet / oauth-window /
  no-modal) and the **harness** sends Escape. The model never acts inside the modal.
- **Without descent, 350 of 396 Yarn controls were permanently unmappable.**
- **Give the destructive-label guard its own switch** — ours originally rode on the general guidance
  flag, so steering a pass silently disarmed delete-protection.
- **The label regex needs single-word forms:** Logout, Signout, Clear were all missing, so an
  unattended pass could sign the fleet Mac out or clear its data mid-run.
- **Refuse app-closing keys too:** cmd+Q, cmd+H, cmd+M — a pass must not close the app it is
  exploring.

### 6.11 Cold-start the app before every pass, and refuse to map a gate

- **Broke:** explore normalised nothing (it is the thing that *discovers* home, so on a first pass
  there is nothing to reset to). At nine passes, wave 2 began wherever wave 1 left that box — and the
  arms that run twice specifically to measure run-to-run variance would have included **start-state**
  variance.
- **Fixed:** hard kill, let the next run launch it. A kill beats navigate-home on three counts: it
  needs no map (identical across all arms including tiers whose map records no home); it clears
  in-memory state a navigation cannot reach (open modals, scroll positions, undo stacks, half-filled
  fields); and "the app as it launches" is a *defined* state where "navigated back to what we think is
  home" is an inference.
- **App targets only** — on a web target the "app" is the profile Chrome that **holds the signed-in
  session**, and killing it turns a grounding run into a sign-in run.
- **The other half matters as much:** a cold start can land on something that is *not* the app, and
  mapping it produces a plausible artifact. One pass mapped Yarn's "Recording Setup" gate and another
  mapped the **macOS menu bar** — both reporting frontier-empty and success, both detectable only by
  reading surface names afterwards. The loop now requires the **first** observation to have app
  content.

### 6.12 Grounding artifacts are an input that can be contaminated

- **Broke, twice.** The original appmaps were partly hand-written and contained procedures for the
  exact tasks being measured — so "grounded" runs measured note-following, not the pipeline.
- **Fixed:** provenance. The generated directory holds **only** stamped machine output with a content
  hash recorded in every run log; hand-curated notes live in a separate, separately-declared tier.
  **Never hand-edit a stamped map** — regenerate it, or move the edit.
- **The same door reopened in new places:**
  - *The curated tier contains the benchmark's answer* — it names the canonical task's control,
    surface, exact options and the scope split, and its own header says it was assembled from an
    exploration pass. The prompt audit gates the **task string**; **nothing audits grounding text**.
    Relabelled as an upper bound rather than fixed.
  - *Scope warnings leaked into every tier* — the graph loaded whenever any grounding prose loaded, so
    the curated and recipe arms received the most correctness-relevant output of the exploration pass
    while their logs claimed a different tier. Now gated on provenance.
- **Build it as:** grounding artifacts need provenance metadata and an integrity story, or your
  quality metrics quietly measure your ops team's annotations.

### 6.13 Name the target the way the artifact slugger does

- **Broke:** an arm carrying a bare host slugged differently from the committed map (which was named
  from the full URL), so it loaded nothing and ran **ungrounded under a grounded label** — this repo's
  most-repeated failure, caught six times in one pass.
- **Fixed:** `groundingChecked` compares the tier that actually loaded against the tier the arm
  declared. **Build that check.** Also: one derivation for an artifact's filename, not four that drift.

---

## 7. Reuse: procedures and recipes

Two artifacts come out of a successful run, and conflating them costs you both.

| | appmap | **recipe** | **procedure** |
|---|---|---|---|
| answers | *where things are* | *how to do this class of task* | *replay these exact clicks* |
| scope | per app | per (app, backend, task, lineage) | per (app, task) |
| consumer | a model reads it | a model reads it | a machine executes it |
| brittleness | robust, topological | robust, adaptable prose | exact `(name, surface, role)`; a renamed control is an **error** |
| measured | — | **3/3**, 848 output tokens — cheapest grounding we measured | **1/3** with a repair model, **0/3** without |

**Where each belongs:** procedures for re-rendering a demo you have already shot (same customer, same
video, nightly, at no model cost). Recipes for onboarding a new app or task — the expensive problem,
and the one they solve.

### 7.1 Harvest offline, never at `done()`

- Two reasons, and the second is the one that matters:
  1. A model call inside every successful run pollutes the cost and latency of the very numbers you
     are measuring.
  2. **At `done` time the only available quality gate is the agent's own claim** — which is precisely
     what fails in the wrong-scope class, where four runs accurately described doing the wrong thing.
- **Fixed:** harvesting reads a *finished* run plus its independent judge verdict, and refuses
  anything the judge did not pass.
- **Refusals, each a way the prose would confidently lie:** run did not succeed; hinted prompt
  (writing a dictated route down as "discovered" turns a one-run violation into a permanent input); no
  judge verdict; judge trajectory ≠ PASS; no verified steps at all.

### 7.2 Compile only from verified evidence, and strip volatile handles

- The procedure compiler refuses failed runs, unverified steps, pixel-only steps, and hinted runs. *A
  procedure asserts effects; an unverified step observed none.*
- Each step re-resolves by (name → surface → role), narrowing progressively, and **ambiguity is an
  error, never a guess** — two same-named controls are the dual-scope trap again, now with no model
  watching.
- **A procedure is not a trusted macro.** Every replayed step is gated by the same verification as a
  live run — recorded expectation, fresh haystack, discrimination baseline. Skipping the checks
  because "it worked when recorded" is how drift ships broken demos.
- **Rescue is bounded and harness-checked:** a broken step gets one mini-loop whose success check is
  the *procedure's* expectation — teardown's trick, the model cannot widen a check it didn't write.
  Unattended fleet mode runs with rescue off; a drifted app fails honestly and gets re-recorded.
- Waits are dropped at compile — pacing is the replayer's, not one afternoon's slow render.

### 7.3 Keep pixel-verified steps in a **recipe** — the one place it differs from a procedure

- We copied the compiler's pixel-only refusal into the harvester and **it was wrong**. A replay must
  re-check an expectation mechanically, so "pixels changed" is correctly refused there. A recipe is
  *prose for a model*.
- **Canvas content is invisible to both AX and the DOM** — that is the entire reason a pixel-delta
  layer exists. A drag on an editor canvas or a timeline handle has no other evidence. Dropping those
  steps refuses a judged-PASS canvas run outright, or harvests it with a silent hole exactly where the
  hard part was.
- Label the channel in the prompt and tell the model to describe the step by **where** it happened and
  what visibly changes, never to invent a control name.

### 7.4 Two procedure defects that made replay look worse than it is

Neither was a bug in the checks — the checks were right both times.

- **Ambiguous target.** Yarn's Library carries two controls named "New Draft." Resolution refused
  rather than guess. *Refusing is correct when nothing distinguishes the candidates; it is the wrong
  answer when the recording knew which one it used and never wrote it down.* → steps record
  `targetOrdinal`, but **only** when name+role+surface genuinely fail to separate, consulted only
  after all three have, and **ignored outright when the twin count has changed** — an index into a
  different list is not evidence.
- **Verbatim value.** The procedure typed its recorded scratch name, so the second replay found the
  field already reading it: "expectation met, but every check was already satisfied before the
  action." → a generated suffix compiles to a `{{unique}}` token **in the typed text and in every
  check quoting it** — they must move together or replay types one value and asserts another. Six-plus
  digits is the line: "Scene 2 at 1080p" is content, not a token.

### 7.5 Key recipes by **lineage**, not just by task

- A recipe distilled from a run that **had** a map presupposes the mapping pass — you cannot conclude
  the pass is replaceable from an artifact that requires it.
- A recipe distilled from an **ungrounded** run is the honest replacement claim, and it is the only arm
  that can say whether the 40-minute pass needs to exist.
- They are different experiments and must not share a filename. **Derive the lineage from the source
  run's own recorded provenance, never from a label an operator types.**
- **Key on (app, backend, task, lineage) — and deliberately not model.** Keying on `(app, task)` alone
  made two backends' arms resolve to one path; whichever was promoted last won, and one arm grounded
  on the other backend's vocabulary with nothing downstream to catch it, since provenance reads
  "recipe" either way. Backends matter because the ax and cdp passes name the same surfaces
  differently (`editor` vs `draft-editor`) and a grounded run resolves controls **by name**.

### 7.6 Promotion is a separate step from harvesting

- Harvesting records what a run taught. Promoting makes it an **input** to future runs — and an input
  tier must never appear as a side effect of dispatching a stage.

### 7.7 Nothing grades the prose, and we could not find a good way to

- The judge grades the run; the harvest gate reads that verdict. What survives is **omission** (a
  missing Save step), **wrong generalisation**, and **ambiguous scope**.
- A mechanical completeness check was considered and **rejected**: it is one-directional in the wrong
  way. It could flag a missing text-verified surface but never an *invented* one, because a legitimate
  canvas step has no AX or DOM name to match against — so it would prune exactly the vision-only
  knowledge that is hardest to acquire.
- **Left empirical and downstream:** the arm that grounds on a recipe is itself judged, so a bad recipe
  shows up as that arm underperforming. Adequate for a benchmark; an **open problem if you ship
  recipes**.

### 7.8 Retired names must throw, not be ignored

- The recipe/procedure swap renamed seven environment variables. They are **fatal**, not ignored.
- **Why:** an unread variable does not fail — it grounds the run on a different tier under the wrong
  label. Clean logs, plausible numbers, wrong answer. That exact shape has cost this project a full
  benchmark pass more than once.
- **And put the guard on every path where the name gets typed.** Ours had one caller and a comment
  claiming it was called "wherever a tier is chosen." Both were wrong: rescue and settle knobs are not
  tier choices, and neither replay nor harvest reached that caller — so four of the seven names were
  unreachable by the guard on the only paths an operator types them. *A guard that is not on the path
  where a name gets typed cannot fire.*

---

## 8. Cleanup: putting the app back

A run is otherwise a one-way mutation — the canonical demo really did leave the brand default changed,
every later run started from a dirtied workspace, and on a fleet a dirty job poisons the next one on
that host.

### 8.1 Journal what actually changed, mechanically

- **Diff control *values*** between the pre- and post-action observations. **Never** the model's
  account of what it changed.
- **Match controls by `(name, surface)`, never by handle** (§3.7).
- **Append the instant a change is detected**, so a crashed run leaves a recoverable journal.
- `settingKey` / `scope` resolve from the appmap graph, with the observed surface breaking dual-scope
  ties; **when it can't, leave scope unset** — an inferred scope sends teardown to the wrong store.
- This required exposing the element's `value` in the observation type — it had been rendered into
  the model's text long before code could read it.

### 8.2 The graph must load **unconditionally**, not with the prompt

- **Broke:** the graph loaded only when grounding prose loaded, so ungrounded runs journalled every
  mutation with `scope` unset. The wrong-scope column would have read **0 for every ungrounded arm** —
  because the scope was *unknowable*, not because the runs were correct — inverting the sign on the
  benchmark's most important claim.
- **Fixed:** the graph loads unconditionally. It never reaches the model — the journal and teardown
  read it, both on our side of the boundary. Only the prompt-facing half stays gated on the tier.

### 8.3 A commit that closes its own surface is invisible to a naive diff

- **Broke:** a click on a menu **option** commits its change as the menu closes, so the clicked element
  vanishes and a target-only diff sees nothing.
- **Fixed:** scan for the owning combobox that now reads the option's label.
- **Then broke again on CDP:** the handoff was keyed on the clicked element **vanishing** — a proxy for
  "this was a menu option" that holds on AX and breaks on CDP, where a native `<select>`'s options are
  DOM children that never leave the snapshot. → **route by role** (`option`, `menuitemradio`) directly;
  AX menu items deliberately stay on the vanish path; self-toggling roles (`menuitemcheckbox`) are
  deliberately excluded.

### 8.4 Five teardown defects that let a run report clean while the workspace stayed modified

- **Fabrication:** coordinate clicks on **unlabeled** controls were journalled. The after-lookup matched
  the first anonymous element on the surface — routinely a different control — inventing a mutation.
  → nameless targets are never journalled.
- **Substring matching:** restoring "Auto" was satisfied by a control reading "Auto-hide," and a
  case-only change was declared already-restored. → **whole-value equality, case-folded, no wider.**
- **A haystack grep instead of the control's own value:** an open dropdown renders the original value as
  one of its options *at exactly the moment the setting has not been put back* — a grep scores that as
  a successful restore.
- **Surface wildcarding:** an element with surface `""` could satisfy a restore whose surface *was*
  recorded — and `""` is the common unlabeled-ancestor case, so a document-scope twin could satisfy a
  brand-scope restore. Leniency now applies only when the journal's surface is unknown.
- **Key collision:** collapsing the journal on `name + " " + surface` merged `"Screen Clip"+"Style"` with
  `"Screen"+"Clip Style"`. → key by JSON.
- **Plus the block gate:** a teardown that **threw** left a report with no failed count, so block mode
  passed the maximally-dirty exit. And one throwing entry abandoned every later entry. → entries are
  isolated; a throw is recorded as dirty.

### 8.5 Ordering is load-bearing

- **Teardown runs after the recording is stopped and assembled.** The mp4 must end on the changed state
  — a video of the agent undoing its own demo is not a deliverable.
- It sits in the `finally`, so aborts and harness-ended runs — the ones nobody watched — get cleaned
  too.

### 8.6 Advisory by default, with a real `off`

- "Did the task succeed" and "was the app left tidy" are different questions; don't let one verdict
  contaminate the other.
- An entry with **no recorded prior value counts as neither restored nor failed** — the harness honestly
  declined to guess, and counting that as a failure would fail a run for the harness's integrity.
- `off` exists because for filming, **the changed end state is the artifact**.
- **Known trap:** `off` currently skips **journalling** too, not just teardown. So a cleanup-off run
  leaves no mutation record at all, the standalone CLI has nothing to replay if one crashes, and a
  cleanup-off run cannot validate journalling. If a filmed take ever needs its mutations on record,
  **split the gate** — recording is not restoring.

### 8.7 A standalone replay for the SIGKILL case, calling the same code

- A crashed run leaves a journal but no run log, and on a fleet it poisons the next job on that host.
- The CLI must call the **same** teardown function — *two implementations of "restored" is how they stop
  agreeing.*
- `--app` matters because a SIGKILLed run writes a journal but no run log.
- **Guard every proposed restore action with the destructive-verb check:** that loop runs unattended
  after the run has already reported, and a restore never needs a destructive verb.

### 8.8 Created resources are **reported, not deleted**

- Deletion has no second chance, and the ledger is only as good as the model's discipline in declaring
  what it made.
- The prompt directs work into a **new scratch document**, and says plainly that claimed resources are
  reported — *a model told its mess is auto-handled is the one that stops preferring scratch.*
- **Known gap:** the task agent's claims live in memory until the run log writes, so a crashed run
  leaves no entries. The explore pass persists claims to the journal at claim time. **Do the latter.**

### 8.9 Cleanup mode must cross the dispatch wire as a named field

- A state-restoring maintenance run's whole point is its mutation — without a flag, teardown undoes the
  restore the moment it lands.
- Allowlist-validated by the runner before the lease is spent; persisted on the job record so queued
  jobs survive a runner restart.

---

## 9. Recording and the humanized cursor

**The architecture fact that simplifies everything** (confirmed with the client): the pipeline
**reimposes a synthetic cursor in post** and time-compresses demos automatically. So reliability
(verified robotic actions) and feel (human motion) **fully decouple**, and model thinking gaps stop
mattering — the rendered timeline is synthetic.

The agent's deliverable to the renderer is **data**: click point, dispatch/completion timestamps, the
target element's role and rect, per-frame capture times, and window geometry. Our pipeline computed all
of these and originally **discarded** them.

### 9.1 Never capture the display

- Display-level capture recorded unrelated personal content during our own testing. Rejected outright.
- Poll **window** snapshots (~4fps, immune to occlusion) and assemble with ffmpeg. On CDP, capture the
  page viewport — no staging at all.
- The macOS capture-indicator pill can get unioned into snapshots; parking the window top-left keeps it
  clear.

### 9.2 Capture-side hygiene beats post-hoc repair

- **Wait for the window to report a stable size** (3 identical polls) before recording. Staging resizes
  the window and the capture surface follows late — we got **25 opening frames at the wrong size showing
  the previous run's screen**.
- **Sample adaptively:** ~120ms for a few seconds after each action (the app's response arrives within a
  second or two and can fall entirely between fixed-rate captures), ~400ms idle. Collapse byte-identical
  gap frames (139 usable frames held only 19 distinct screens).
- **Defend assembly:** majority-vote on frame size plus a leading-black-band content check.
- **Persist per-frame capture times** — ffmpeg's list format clamps gaps and erases exactly the timing
  you need later.

### 9.3 The dwell must outlast the **camera**, not just the CSS transition

- **Broke:** demo mode dwelled 200ms before clicking, to let the app paint its `:hover`. The frame loop
  asks for 120ms but each screenshot costs ~220ms on top — across 146 frames of one run **not one gap
  came in under 220ms** (p90 579ms, max 634ms). *The dwell was shorter than the fastest gap the camera
  can manage*, so the moment demo mode exists to film was uncatchable, and the app's real hover was
  filmed **exactly zero times**.
- **What hid it was the fix for it:** the humanizer synthesized a hover tint unconditionally, so every
  recording looked like hover worked and the real one's absence never showed up as a symptom.
- **Fixed:** the dwell is **derived from** the worst observed frame gap, named so the relationship is
  greppable rather than folklore. Measured after: 3–4 frames inside every dwell, target rect changing
  50–64%, the app's own highlight on film. With the real one captured, the synthetic tint is **off** for
  CDP runs.
- **And the gate reads the run's own recorded dwell, not today's constant.** Keying it on backend alone
  would have stripped the synthetic highlight from ~30 earlier runs and put nothing back — silent
  degradation on re-render.

### 9.4 Never animate what didn't happen

Each of these got rendered before we learned to drop it, and each reads as the agent doing something it
didn't do:

- an action that failed verification (a warned no-op click);
- the home reset's own navigation (the driver's recorder backfills earlier turns — stamp
  recording-start and drop everything before it);
- an atomic `set_value` drawn as keystrokes;
- a fabricated typo-and-backspace branch, which rendered corrections that never happened (**deleted**).
- **When an action is dropped, drop its footage too** — from dispatch until consequences settle, *not*
  until the next dispatch, which swallows the anchor frames the next action needs. Otherwise the view
  flickers with nothing driving it.

### 9.5 The take should end at the last real work

- **Broke:** committing usually closes the surface that displays the change (Done shuts the settings
  panel), while `done` evidence is checked against a **fresh** final observation. So the agent must
  navigate back to put the proof on screen — ~2 clicks and 12s on every recorded run.
- **Do not fix this by letting `done` grade an earlier observation.** That is the hole that made the
  measurement trustworthy; reopening it for prettier videos trades the measurement for the
  cinematography.
- **Fixed:** cut the *footage* instead, exactly like stopping the recording before teardown. A trailing
  step is dropped from the video only when **all three** hold: it is trailing, it journalled no
  mutation, and it repeats an earlier step's exact target. The mutation test is what keeps "set the
  timezone to Paris and back" intact — its closing steps repeat earlier targets and **are** the task.
- Measured: 9 actions → 6 on film, 45.9s, ending on Done.

### 9.6 Replay real human motion; don't synthesize curves

Measured over 1,895 human approach segments: motion is **asymmetric** (90% of distance in the first half
of time), **unsmooth** (peak speed ~10× mean; a third of mid-flight samples nearly stopped), **not
straight** (median 9% off-axis), and **duration barely follows distance** (Fitts's law fit R²=0.09). An
eased curve gets all four wrong.

### 9.7 Fit to the signal the audience sees, not the raw input

- **Broke:** we fitted synthesis to raw mouse data. The client's renderer then decimates to every 3rd
  sample and drives a critically-damped spring, which removes almost all of it: raw peak-speed/mean
  10.4× → rendered 2.5×; submovement peaks 7 → 2.
- *We had optimized against the wrong signal and had to refit against the post-pipeline data.* If their
  pipeline changes, refit.
- Scale-replaying a long reach onto a short distance produces visible wander — short hops get
  synthesized.

### 9.8 Coordinate spaces shift **within** a run

- Capture width changed **four times in one run** (the window moved between displays); the first frames
  carry transient geometry.
- **Scale click points per turn**, and take the **modal** frame size, not frame zero.
- **The driver's own click point can be wrong** — 41px off on a same-named offscreen twin button — and
  the recorded element rect was wrong *with* it, so no cross-check between them catches it. The
  before/after pixel diff is the only independent witness; correct against it conservatively.

### 9.9 Feel details that mattered

- The cursor departs shortly after each action and **waits at the next target** — parking the thinking
  gap on the previous control reads as "stuck."
- Pointer type switches when **crossing into** the target's rect, not at the click (role → pointer:
  I-beam over text fields, hand over links — free from the observation).
- **Scatter landings inside the target** (triangular distribution) — exact-centre clicks were the most
  machine-like thing left.
- Round positions to whole pixels; size cursor art by output-pixels-per-logical-point.
- One drawing bug worth naming because it recurs: the arrow's white outline was **filled over by its own
  black body** — draw order matters.

---

## 10. Remote execution: the fleet

**The conclusion first:** remote execution works. ~200 runs were dispatched to three colocated Macs,
queued, filmed and pulled back automatically. **The problem is sign-in, not compute.**

### 10.1 Auth decides the deployment model

- Customer apps sit behind SSO+MFA, which is not automatable in the general case — so a **signed-in
  session is a stateful, human-created asset that must persist**. Ephemeral VMs destroy exactly that
  asset.
- The shape that falls out: **persistent machines that hold sessions**. Sessions are the scarce
  resource; machines exist to hold them.
- **No credential ever enters the agent loop** — every observation and every recorded frame reaches the
  model *and* the demo video. An agent that types a password is a live leak into two artifacts you hand
  to other people.

### 10.2 The credential vault: built, then removed

- **Tried:** copy the app's profile directory, encrypt it, ship it to any box.
- **Broke:** it moved **81 MB to carry what turned out to be a 176-byte token**, and restoring it
  crash-looped the app — the profile drags machine-bound state (the recorder's device registration, GPU
  caches, device files) even from a clean snapshot.
- **Fixed:** removed. Per-box sign-in is the general answer — it works for any app with zero per-app
  code.
- **If you ever need roaming, the right mechanism is intercept-at-auth** (CDP cookies for web; the
  config file for this app), **never profile-copy**. And there is no universal "where is the session"; a
  token crawler is a bad idea.

### 10.3 The real answer is to replicate the machine, not the session

- macOS VMs can be cloned from a **golden image** with both OS permissions (Accessibility, Screen
  Recording) and the app sign-in already inside. Adding a runner then costs a clone instead of a person.
  This is how major macOS CI fleets work.
- **We had assumed those permissions were bound to a physical Mac. They are not** — the TCC grant keys
  on service + client + code-signing requirement, and the boot identifier is a literal placeholder, so
  grants survive cloning. What actually differs is SIP: disabling it needs a recovery boot, which is a
  physical power-button hold on bare metal and a scripted step in a VM.
- **Three constraints before pricing it:** AWS EC2 Mac is specifically disqualified (its low-level
  security settings don't survive imaging — exactly the thing you need baked in); Apple's licence caps
  **2 VMs per physical host**, so this buys provisioning speed, not density; and an app storing its
  login in the hardware keychain still needs a human sign-in per box.

### 10.4 Sign-in is a product surface, not an ops chore

- A human opens a window-scoped live view with the app already frontmost, signs in once per app per
  machine, and **the tool closes the viewer itself** once the app reaches the home state a run would
  demand.
- **The OAuth handoff stops on browser chrome a page-scoped stream cannot show.** A sign-in ends with the
  page launching the app's URL scheme, and Chrome interposes "Open \<App\>?" — so the flow halts on a
  button the remote human cannot see. A protocol allowlist policy skips it. **Read the scheme from the
  app's bundle metadata rather than guessing:** a wrong value grades the host clean while every handoff
  still stalls.
- Screen Sharing prompts for the Mac's own login at least once per Mac, and that prompt cannot be
  pre-filled without putting a password in an argv. Putting the username in the URL turns two prompts
  into one.

### 10.5 A shared machine signed into a personal account leaks that account's whole vault

- **Found the hard way:** a live-view sign-in put Chrome's autofill dropdown on screen for the watching
  teammate, listing colleagues' email addresses. Behind it, all three Macs had **three people's personal
  Google accounts in one shared Chrome profile** — two `@gmail.com` — with sync on and **801 saved
  credentials each**. The identical count across three machines is sync working as designed: one vault,
  replicated.
- **The app was incidental.** The cause is a personal identity on shared infrastructure, and it leaks
  through whatever that identity syncs to.
- **Two dropdowns, two switches.** Single-field form history is keyed on the **field name, not the site**
  — a box called `email` on any page offers every address ever typed into any box called `email`, which
  is the only store that explains one list containing several different people. Closable by policy.
  Saved passwords are per-site and **not** closable: the "disable password manager" policy only stops new
  saves, and **no Chrome policy disables filling**.

### 10.6 Clearing synced passwords is only safe with the browser **closed**

- Deleting through a running, signed-in Chrome emits a sync **tombstone**, which removes the credential
  from the person's real Google vault and every device they own — irreversible, and not a thing
  automation should do.
- With the browser closed nothing is connected to Google to report the deletion, so removing the profile
  directory is purely **local**: the accounts keep their vaults, the machine forgets them. **Automating
  it is therefore safer than the manual UI route** — provided the tool quits the browser first and
  **refuses if it will not exit** (a delete underneath a live Chrome is written back on quit).
- **Remove whole profile directories, not selected files.** Deleting the login database alone leaves the
  sync metadata, and the next launch re-downloads everything — a deletion that appears to work and
  silently reverses itself.
- **A wipe is not a fix; policy is.** Sign the same account back in with sync and the vault returns.
  Disabling sync *and* browser sign-in closes it permanently — the second is stronger, since a browser
  that cannot be signed into a profile has no vault to download, and **website OAuth is unaffected**.

### 10.7 Never let variable text cross SSH as command text

- sshd **joins remote arguments into one string** for a login shell, so anything reaching it as text is
  shell input on the far side no matter how carefully quoted here. Task names carry spaces; URLs carry
  `&`.
- **Variable data crosses as an encoded spec file; command lines are fixed tokens only.**
- One module owns ssh invocation, with explicit identity/known_hosts/config so nothing depends on or
  mutates the operator's `~/.ssh`.
- **Pin hosts by SSH host key, never by address** — colo addresses move between machines; the
  fingerprint is the only field that still says "same box."

### 10.8 OpenSSH is first-value-wins for repeated `-o`

- **Broke:** per-tunnel anti-multiplexing options were appended **after** the shared base argv, so every
  tunnel silently joined the shared ControlMaster since the function shipped. Keepalives configured the
  short-lived mux client instead of the connection carrying the forward, and killing a tunnel child
  leaked its forward into the long-lived master — observed as **ghost listeners answering for the wrong
  host**.
- **Fixed:** the per-tunnel options precede the base spread; verified both ways with `ssh -G`, with a
  **positional** regression test.

### 10.9 A dispatched run must outlive the dispatcher

- Detached child owning its own log file, follow resumable by **byte offset**, artifacts pullable any
  time. A closed laptop lid must cost nothing against a 40-minute pass.
- **`--no-follow` matters more than it sounds:** a capped-lifetime caller (an agent session's 600s tool
  timeout) killed foreground follows mid-explore, and its cleanup then stopped the healthy runs.

### 10.10 Re-derive state; never trust records

- A job record saying "running" is a **claim about a pid** — ask the kernel at startup and mark orphans,
  or a killed runner leaves a registry that lies.
- **Lease validity is process liveness, never a TTL**, and the claim is a single `O_EXCL` create so
  check-and-claim is one syscall and two racing operators can't both win.
- Atomic writes (temp + rename) — status polls land between truncate and write.

### 10.11 Syncing code must not bounce the runner

- **Broke:** dispatch provisioned before dispatching so the Macs couldn't run stale code — but a full
  provision restarts the runner, and the restart's orphan sweep found the **in-flight** job's record with
  a dead pid and marked it orphaned. A completed 118-action grounding pass was recorded as orphaned.
- **Fixed:** a `syncOnly` mode ships the code and stops, before anything that installs or bounces.
  rsyncing source under a running job is safe on its own — Node has already loaded its modules, so only
  the **next** job picks up new code, which is exactly what a pre-dispatch sync wants.

### 10.12 rsync is the wrong tool for artifacts that both sides produce

- **Broke:** the grounding-artifact directory wasn't excluded from the blanket code sync, so every sync
  pushed whatever the operator's checkout held over the Macs' copies — a Mac's fresh 133-action map
  overwritten by a week-old local one, while the report still called those runs grounded. *Silent, and
  indistinguishable in the results from grounding simply not helping.*
- **rsync has no notion of which copy is newer; it just writes.** The right mechanism reads each side's
  embedded stamp and moves an artifact only when it is **genuinely newer**.
- **Sync by the artifact's own embedded timestamp, never file mtime** — git restamps every file on
  checkout, so a fresh clone looks newer than last week's finished pass.

### 10.13 Jobs do not migrate

- The queue is per host and `dispatch auto` picks at **submit** time — right then, wrong a minute later,
  because the host holding the line is not necessarily the one that finishes first. One Mac sat idle for
  six minutes while an explore waited behind a long pass.
- **Moving a queued job is safe precisely because it has no process yet** — cancelling destroys no work,
  only bookkeeping. Real work-stealing would need cross-host coordination the per-Mac registries don't
  have.

### 10.14 One stray browser instance swallows sign-ins

- LaunchServices delivers an OAuth handoff URL to whichever Chrome instance **registered first**, so a
  second port-less Chrome swallows sign-ins where no screencast can see them — the operator stares at a
  blank page while the Google tab opens in a browser nobody is watching.
- **Fixed:** enumerate **every** Chrome main (a single-argv lookup misses multi-instance states
  entirely), pick the flagged one, health-check it, and with prune set kill everything else
  **pid-precisely** — an AppleScript quit cannot address one instance of two. The kill list is a pure
  function so "the keeper is never in it" is a tested property.
- **Prune is opt-in and only the runner sets it:** fleet Macs are the runner's to police; an operator's
  personal Chrome is not ours to kill.

### 10.15 A web run closes the tab it opened — and blanks the last one

- Run residue in a shared browser is what an operator's sign-in viewer opens onto. Ownership is decided
  alongside the pick: a tab already on the target origin is **adopted** (it survives); a created tab or a
  colonised `about:blank` is the run's to remove.
- **Ownership is held as the page object, not a flag,** so re-pointing the current page mid-run can never
  make close() shut a tab the run did not open.
- **The last tab is blanked, not closed:** a window-less Chrome keeps answering its debug endpoint but
  refuses `connectOverCDP` ("Browser context management is not supported"), so closing the final tab
  breaks the next run's acquire.

### 10.16 A checkout on three machines drifts

- Nothing prevents a Mac from being behind, and a run against a stale checkout fails in whatever way that
  checkout was broken. **Check the doctor output before believing a fleet-wide result**, and warn loudly
  when HEAD moves between stages.
- **A synced runner-side fix is not a live one** — report runner age.
- **A control-side verb the runner's shim doesn't know is rejected client-side**, no matter how current
  the checkout: our SCK fallback was dark on every Mac because an allowlist never learned the verb. A
  test now scans every call site so a verb the shim refuses fails the build.

---

## 11. macOS platform traps

Ordered roughly by how much architecture they dictate. **None of them reports an error.**

### 11.1 TCC attributes grants to the *responsible* process, and children inherit

- A run spawned from an sshd session is asking for grants sshd does not have → **empty accessibility
  tree and a black screenshot, zero errors**, indistinguishable from an app that hasn't finished
  launching.
- **This is why each fleet Mac runs our own app as a LaunchAgent** and every run is its child. Bootstrap
  into `gui/<uid>` — `user/<uid>` has no window-server session and fails identically silently.
- **This one fact shapes the entire fleet architecture. Design for it from day one.**

### 11.2 Screen Recording has no "+" button

- macOS builds that Settings pane from processes that have **called** `CGRequestScreenCaptureAccess`. An
  app that never asked cannot be granted even manually. (From Electron, enumerating desktop-capturer
  sources triggers the call; discard the pixels.)
- **A new grant does not apply to a running process** — restart after granting, or the host reports its
  grants present and still captures black.

### 11.3 Spaces, not occlusion, are the perception boundary

- A window on an **inactive Space** (any fullscreen app owns its own Space) is simultaneously
  unobservable and unactuatable — Chromium tears down the accessibility tree and rendering for it —
  while the window server still lists the window, so naive "does the window exist?" checks pass.
- **Plain occlusion is fine.** Measured on the same window minutes apart: occluded-on-active-Space = 61
  of 230 elements, capture works. On-inactive-Space = 0 AX windows, capture fails.
- **Programmatic activation reports success and does nothing** across Spaces — macOS refuses
  background-initiated Space switches, from AppleScript, `open -a`, and the driver alike.
- Foregrounding **does** fix the look-alike causes (no window / hidden / minimized), so attempt it once,
  **re-find the window** (a relaunch can mint a new window id), then fail with an honest message.
- The operational rule is narrower than "no fullscreen apps": *do not switch to a different Space during
  a run.*

### 11.4 Chromium builds its web-content accessibility tree lazily, and **reading it is not what wakes it**

- A freshly-launched Chrome exposes **no web area at all** — 37 chrome-only nodes — no matter how many
  times an AX-trusted client walks it.
- The wake is an app-element attribute **write**: `AXEnhancedUserInterface` (what VoiceOver sets; the one
  Google Chrome honours) or `AXManualAccessibility` (the CEF/Electron equivalent, which Chrome ignores).
  Measured on virgin profiles: no wake after 8s of reads, none with the Electron attribute alone, web
  area up 2s after the VoiceOver one.
- **Chrome answers `-25208 notImplemented` to the set and wakes anyway** — never gate on the return code.
- **Cost three separate debugging attempts that each blamed TCC attribution**, because the wake latches
  for the process lifetime: a developer's daily-driven Chrome is always already awake, and only a fleet
  Mac launching a fresh browser per sign-in shows the bug.

### 11.5 Natively-fullscreen apps report **zero** windows to System Events

- `windows[0]` throws "Invalid index" (-1719). **Absence of windows is the fullscreen signal.**
- Setting a position on a fullscreen window **demotes it out of fullscreen**.
- Both silently broke recording staging on every run for a day.

### 11.6 Three verification tools lied in three directions on the same afternoon

- `defaults read` reported a policy "does not exist" while it was demonstrably in force — it reads the
  **user domain only**.
- `profiles list` reported no profiles while a System-scope one was installed — without root it lists
  **user-scope only**.
- `pgrep -x "Google Chrome"` found nothing while Chrome was running in the console session — `ps -axo`
  found it.
- **The rule that survives: verify with the API the consumer actually uses.** For Chrome policy that is
  `CFPreferencesCopyAppValue` + `CFPreferencesAppValueIsForced`, which is what Chromium's own policy
  loader calls.

### 11.7 macOS 26 changed how managed preferences are delivered, and the failure is invisible

- On macOS 15 a root-written plist in `/Library/Managed Preferences` is honoured. On 26 the **identical
  file** — same md5, same ownership and mode — is ignored: it reads back perfectly from disk while
  `CFPreferencesAppValueIsForced` returns false, because that directory belongs to the MDM subsystem and
  a loose file there manages nothing.
- `profiles install` is gone too. The working route is a configuration profile installed by a human once
  per Mac — no MDM enrolment required, but **no unattended path either**.
- **Run `sw_vers` before comparing two machines.** An hour went into diffing byte-identical plists across
  a major OS difference nobody had checked for.
- **And `sudo defaults write` to a managed-preferences path silently writes nothing** — `defaults` routes
  through `cfprefsd`, which owns that location, declines to create files there, and **exits 0**. Combined
  with the above, this manufactures the worst available state: a policy that looks set, reads back, and
  enforces nothing.

### 11.8 ScreenCaptureKit and code signing

- One-shot capture works from an unsigned `swiftc` binary. Live streaming works from an **ad-hoc-signed**
  binary too — **provided the process descends from the TCC grant holder**.
- **The real gate is §11.1, not code signing.** An original "SCK delivers no frames to unsigned CLIs"
  finding was measured from a bare terminal and was wrong about the cause.

### 11.9 A native `<select>` popup is an OS window

- Absent from `Page.captureScreenshot` **and** from window-scoped capture; present only in a display
  capture. Measured against a DOM listbox in the same page at the same instant.
- Worth knowing before you assume page-scoped capture is complete. (Application-scoped capture is the fix
  for this class.)

### 11.10 LaunchServices can bind an app name to the wrong bundle

- Seen twice with a build shipping a nested copy of itself inside its own resources: `open -a <name>`
  launched the **inner** bundle, which starts and then behaves like a different application.

### 11.11 Resolve paths from the install, not the working directory

- A LaunchAgent and a packaged `.app` **both start with cwd `/`**. `mkdir -p` succeeds, `/out` gets
  created at the filesystem root, the grounding artifact isn't found, and **the run silently degrades to
  ungrounded**.
- Split writable **data** from read-only **resources** — packaging separates them — and find the checkout
  by walking up from the module's own location, which is true regardless of who launched you.

---

## 12. Model transport, cost and configuration

### 12.1 The model **id** picks the transport, not which key happens to be present

- **Broke:** key presence *was* the rule, and it silently broke a two-provider split the moment both keys
  sat on one host — the aggregator won unconditionally, so a run that named a Claude model went through
  the router anyway. Visible only as a surprising provider name in an error, and **invisible when nothing
  failed**.
- **Fixed:** `vendor/deployment` → the vendor's native transport, translated at one boundary so no call
  site knows the difference. A bare model id → that vendor direct. Anything else shaped `vendor/model` →
  the aggregator, **which is the fallback, not the default**.
- Key presence now decides only the **default when nothing asked**.

### 12.2 A model override that changes the id but not the transport

- **Broke:** the judge built a client from the ambient default and *then* asked it for the judge model, so
  an override naming a different vendor got the wrong client and a 404 naming a model that vendor never
  had.
- **Fixed:** the client factory **takes the model as an argument**, so the id picks the transport for
  every caller with a model of its own, and the judge resolves the model **before** building the client.

### 12.3 A preflight that could never pass

- **Broke:** the key-liveness check sent `max_tokens: 1`. The Responses API enforces a minimum of 16 and
  answers `400 integer_below_min_value`, which the catch reported as "the model is unreachable — fix the
  key first." **The key was fine**, and every autopilot launch was refused.
- **What unmasked it:** a dead key answers **401** and this was a **400** — the request authenticated,
  reached the service, and failed parameter validation.
- **Build it as:** a preflight that cannot pass is worse than no preflight, because its failure names the
  wrong cause. Distinguish auth failures from parameter failures in the catch.

### 12.4 Prompt caching is not uniform across transports

- Cache-control blocks are accepted and **silently ignored** for some vendors' models behind an
  aggregator (the cache-creation token count comes back null), so the system prompt is billed in full
  every turn.
- One transport has no per-block cache directive at all, and our translation layer **drops** the field
  rather than faking it — nothing on that path ever had the behaviour to lose.
- **Build it as:** measure cache hits per transport; don't assume a field you sent was honoured.

### 12.5 Parse numeric env knobs strictly, and die at import

- `Number(process.env.X ?? default)` has **two** silent failure shapes:
  - `X=` (an unset shell variable interpolated into a plist or wrapper) becomes **0** — which for a
    cleanup-steps knob **disables teardown outright**;
  - a typo becomes **NaN**, which answers false to every comparison, so a budget of NaN means zero
    iterations, not unlimited.
- Neither says a word, because `??` cannot catch either — the variable *is* set, just not to a number.
- **Fixed:** treat unset/blank as the default; **die at import time naming the variable** on anything
  unparseable. Explicit `0` still parses.

### 12.6 Retry model calls, and route around a **named** failing provider

- Aggregators fan one model id across hosts and name the failing host in the error; backoff alone re-asks
  the same broken one.
- A mid-stream timeout once killed a 40-minute pass at action 1.

### 12.7 Reasoning effort is a policy decision, and it belongs to the deployment

- Max effort by default here, because latency is the pipeline's problem and reliability is ours — the
  client's own timing system compresses model-thinking gaps in post.
- The agent loop and the explore loop send effort; the small utility calls (judge, teardown, rescue) do
  not. Make that split explicit rather than incidental.

---

## 13. The measurement layer

*If you build an eval harness alongside the product — and you should, since the failure mode that matters
is "the demo looks right and changed the wrong thing" — these are its bugs.*

### 13.1 Enforce prompt hygiene in code, not memory

- **The rule:** never give the model information it would not have in a real test case. Task prompts state
  the **goal** only; method knowledge (which control, which keystroke) lives in a declared, budgeted
  input.
- **Broke twice in one day while enforced by memory** — including in a take emailed to the client, and
  both runs were reported as autonomous.
- **Fixed:** a code gate makes the agent refuse a prompt that dictates method; an explicit flag opts in
  and stamps the run log. **Zero violations since.**
- **Gate details that took iteration:** count occurrences, not unique hints (a dictated 4-click path
  deduped to one hint and passed a ≥2 threshold); keystroke glyphs are their own category (a `⌘` was dead
  inside a word-boundary group); tool-vocabulary matching needs the case-insensitive flag; bound the verb
  regexes on both sides ("clickable," "pressure" were false-flagging legitimate prompts); ordinary words
  must not read as internals ("axis" → AX). **On a canvas, a coordinate in the prompt *is* the answer —
  refuse it.**

### 13.2 One run-log writer, in a `finally`

- **Broke:** two writers drifted — one path omitted the field the gallery filtered on, and **aborted runs
  wrote no log at all**, so every reliability figure quoted before the fix was **survivorship-biased**.
- **Artifacts are written only by the harness, under unique per-run names.** Never hand-copy a result
  file.
- **Run keys carry milliseconds plus a per-process counter** — two runs minted in the same second once
  clobbered each other's logs, recordings and job directories.

### 13.3 Reset before every run, and make a failed reset loud

- Or run N starts from whatever run N−1 left behind and nothing is comparable.
- **Ours failed silently for a while** — a dropdown left open hid the sidebar from the accessibility tree
  — and quietly voided an A/B pair.

### 13.4 Normalisation that switches itself off for the arms being compared

- **Broke:** every run resets the app to its declared home, looked up in **that arm's own map** — and both
  perception-reduced discovery passes failed to declare a home while both full-perception passes declared
  one. The reset returned `"none"`, and only `"failed"` refused, so nine runs began wherever the previous
  job on that Mac left the app.
- **That is non-comparability perfectly correlated with the variable under test:** "dropping screenshots
  costs N extra steps" would have silently included "and started from an arbitrary state."
- **Fixed:** home falls back to the full-perception map for that backend. **Home is a property of the app,
  not of the channel that mapped it.**
- **Build it as: a control that reads its configuration from the thing under test is not a control.**

### 13.5 A hand-written forwarding list drops flags in silence — **three times**

- Translating a declared arm config into a job order by spelling out every field by hand means a new flag
  reaches the run only if someone also edited that function.

| flag dropped | consequence |
|---|---|
| the perception-variant selector | two grounding passes had no consumer; the planner printed a false claim |
| `record` | **all 88 filmed runs** would have been byte-identical duplicates of their unfilmed siblings under different labels — filmed arms are derived by adding *only* that flag, so dropping it erases the entire difference. No footage, 88 rows reading "done," and nothing detecting it |
| `useRecipes` | the recipe arms would have measured the appmap tier |

- **And the same defect existed independently on the *receiving* side:** the runner parsed eight fields out
  of the submit spec and not the two the reuse stage needed. **The path typechecks end to end because both
  halves declare the fields**, so the compiler never saw it. All 12 runs reported success on the wrong
  tier; only the provenance check caught it.
- **Fixed:** a test that walks **every arm's actual dispatch object** and asserts each set field arrives,
  and a second that walks the **sender's spec** and asserts the **receiver reads each field out of the
  request**. The earlier tests checked only that the matrix *declared* the flags, which is why none were
  caught. A first attempt at the receiver test only checked that the file **mentioned** the name — which
  passed on the shipped bug, because a line referenced the field the whole time it was being dropped.
- **Build it as: a wire contract needs a test that walks it, because every other signal says it works.**

### 13.6 A grader with no answer key returns a confident pass

- **Broke:** the offline judge loads the scope-collision list as its rubric, and was reading it from a slug
  no pass writes any more. Two consequences, the second much worse:
  - it graded against whatever legacy file survived, whose vocabulary differs from the maps arms are
    actually grounded on;
  - **the rubric builder returned `""` when the file was absent** — so delete the legacy files, which every
    hygiene rule says to do, and **every wrong-scope run silently passes**.
- **That verdict is not merely reported — it gates recipe harvesting**, so a wrong-scope run could have
  become promoted grounding that teaches the mistake to everything downstream.
- **Fixed:** rubric keyed on the run's own backend; an **empty rubric warns loudly** instead of passing
  quietly.

### 13.7 Classify failures, and take technical failures out of the sample

- **A failed run is data** — failure rate is a measured output, so nothing retries a benchmark run. But the
  pipeline must say **why**: readiness refusal (a host problem), gave-up (the agent's own verdict),
  hinted-refused, stopped by an operator, crashed (terminal with no log / orphan / signal). "1/3 success"
  means something completely different when the two failures are "signed out" versus "gave up."
- **Sign-in refusals were 29% of archived runs and each silently ate a sample.** They are technical
  failures now: they free their slot, and the autopilot stops the line on the first **new** one with the
  exact fix named.
- **Flag poisoned hosts:** a host whose last 3 collected runs all failed **the same way** is flagged with
  the remedy named. Same-kind required — three different failures are three unlucky runs. Advisory, never a
  kill. *(But see §5.8: identical failures across two hosts is evidence against a host cause.)*
- **Name the live-but-wedged case separately** from the dead one: log silence past a threshold, advisory,
  never a kill — a hard model turn is legitimately minutes of silence.

### 13.8 Collect's three data-integrity bugs

- **A failed pull with an intact job record permanently records a finished run as "crashed."** The pull
  returns not-ok *with* the record whenever any transfer leg fails; collect then proceeds off a local tree
  that never received the run log, banks `success: false`, and **never revisits it**. One network blip on a
  filmed run (thousands of frame PNGs) freezes a successful run as a crash forever, understates the arm,
  triggers a duplicate re-dispatch, and can trip the poisoned-host warning against a healthy Mac.
- **A lost-update race erases manifest entries.** Collect reads the manifest once, holds the snapshot
  across a pass that can run many minutes, and rewrites the entire file per entry — while dispatch does the
  same read-modify-write from the other side. Any submission recorded in between is silently deleted.
  Dispatch-erases-collected-flag self-heals; **collect-erases-submission does not**.
- **Judge verdicts could never be folded in.** Verdict parsing ran only for uncollected entries, but entries
  become terminal-and-collected in the same update, and the judge refuses non-terminal entries. Both
  orderings fail. A code comment described the folding path; **the code did not exist**.
- **Build it as:** re-read under a lock (or per-entry updates), distinguish "pull failed" from "run failed,"
  and make artifact-folding a separate idempotent pass that reads all entries.

### 13.9 A disqualifying flag that disqualifies nothing

- The provenance check stamps a failure kind without touching `success`, and the documentation said the flag
  "disqualifies a row from its arm's average exactly as a failure does." **Nothing implemented that.** The
  run counted as a success *and* as a failure in the breakdown (successes + failures > n), and the dashboard
  rendered it "succeeded."
- **Scenario:** a map never syncs to one Mac; all three grounded runs load provenance "none" but succeed by
  ad-hoc discovery. The grounded arm reports 3/3 — **ungrounded behaviour credited to the grounded arm in
  the headline comparison.**

### 13.10 Two surfaces recomputing the same rate will disagree

- Carving harness-ended runs out of the success denominator in the report left the dashboard computing the
  old rate. **That is worse than either convention alone, because a reader comparing them cannot tell which
  is lying.**
- **Fixed:** the dashboard carries the fields straight off the shared rollup rather than deriving them
  again, so the two cannot drift a second time.

### 13.11 Three unrelated things called "stalled"

- A run outcome (8 consecutive unverified steps); a **live** flag meaning a running job's log has gone quiet;
  and the orchestrator's 90-minute flat-progress abort that gives up on the **watch**, not on the runs. Two
  of the three rendered the same word on one screen, **where a recoverable job reads as a final verdict.**
- Renamed to "Log Silent" and "No frames for 12s."
- **Build it as:** naming collisions in an ops UI are correctness bugs.

### 13.12 Guard-rails an unattended pass actually needs

Mined from real failures, each one a pass that stopped for the wrong reason:

- **Pin the date at launch** and refuse over an interrupted prior-day pass rather than forking it (UTC
  rollover).
- **Check the grader key's liveness with a real call before anything dispatches** (see §12.3 for how that
  check itself failed).
- **Per-arm technical-failure retry budget** — a host that keeps killing runs stops the line instead of being
  re-bought — and exclude the delta-based host refusals from that budget so a resumed pass doesn't re-stop
  on fixed ones.
- **Optional hard spend ceiling**, off by default: a pass that stops at 3am costs more than it saves.
- **Stage-level stall detector** measured in minutes, because a job record wedged in `running` forever is
  invisible to any run-level timer.
- **Give a submit 60s, not 20.** Three consecutive submits reported "no answer" having delivered nothing —
  the runner was mid-launch of the target app, which on a cold Mac routinely outlasts 20s. **The asymmetry
  decides the number:** waiting 40s extra costs 40s once; giving up early costs a run *and* spends a retry
  budget that exists to stop a sick host.
- **Derive stage prerequisites from the arms, not from the stage.** Three gates were attached to the wrong
  noun and covered 4 of 10 consumers — a stage does not *have* a procedure gate, it *contains arms that
  ground on a procedure*.
- **Refuse only when refusing is total.** "Every procedure arm missing → refuse the stage" was right while a
  stage was a single tier; once stages mixed tiers, one unharvested artifact among twenty-two arms would
  have cancelled sixty runs.

### 13.13 Which discovery metrics to trust

- **`seen` and `surfaces` are unreliable.** One pass logged 6,609 controls seen against an identical run's
  293 — purely because it scrolled a long list. Both produced comparable maps.
- Use **graph nodes** (how much of the app was mapped) and **actuated** (how many controls were actually
  operated).

### 13.14 Your instruments will lie — build negative controls

- The canvas probe twice reported false positives: its "null drag" actually **scrubbed the playhead** (the
  mousedown itself moved the clock being read as evidence), and a per-target readout was produced by **any**
  click.
- **The fixes generalise:** use an idle wait as the null action, and run a **decoy** action whose evidence
  can never count.

### 13.15 Vision-model coordinates: clamp images to 1568px on the long edge

- Larger sends get resampled server-side and coordinates come back in a frame neither side agreed on — a
  3894px send returned points **1.7–2.0× off, and not by a consistent ratio**. At 1568px the same frame was
  accurate to a few pixels.

---

## 14. Run data, artifacts and paths

### 14.1 One directory per run

- **Tried:** sibling trees keyed by the same stamp.
- **Broke:** nothing was ever *lost* — the key correlated them — but every consumer needed its own fan-out,
  and each fan-out was a place to forget a branch. **The fleet pull forgot the step-frames directory for long
  enough that the offline judge returned "visual unavailable" for an entire matrix**: half its signal,
  silently blank.
- **Fixed:** one directory per run, one module owning the layout, one authoritative list of what a run
  produces.

### 14.2 Three writers escaped the run folder, and each failed only on the **second** run

- The frame the visual judge grades; teardown's restore evidence; every grounding pass's step frames (each
  overwrote the last).
- **A shared path works perfectly until a second run exists**, which is why no behavioural test caught them.
- **Fixed:** a **source-level** guard that fails the build on an observation written to a bare name.

### 14.3 Post-terminal writers must re-link the backup

- The backup is taken when a run terminates, so anything written afterwards — a compiled procedure, a
  harvested recipe, a judge verdict, a humanized render — lands in the live tree and **not** in the backup
  unless the writer explicitly re-links.
- Ours is re-callable for exactly this: it links what the backup is missing and leaves the rest.
- **The judge was the writer that never got it**, despite another module's comment stating the obligation
  generally.

### 14.4 Resolve each artifact independently, not the run's home once

- **Broke:** a snapshot reported 31 renders where the store held 46, and nothing was wrong with the store. The
  resolver returned the first run **directory** that exists (live before archive) and then looked for the
  render only inside that one. A run humanized *after* it was archived has its render in the archive copy
  while its live directory sits there render-less — **15 takes invisible**.
- **Build it as:** resolve per **artifact** through the fallback ladder, which is the whole reason the ladder
  exists.

### 14.5 Evict terminal failures from the live tree, don't delete them

- Archive first, refuse to delete what could not be backed up, note a refusal on the record and leave the live
  copy.
- **Hard-link the backup** — zero disk cost on hundreds of megabytes of frames, and it survives the live copy
  being deleted, which is what makes a drop command safe.
- **Caveat we hit:** hard-linking with skip-if-exists is sound for write-once run artifacts and **wrong for
  the manifest**, which is replaced by temp+rename on every write (a new inode severs the link). The archived
  manifest was permanently frozen at the first collect.

### 14.6 Give operators a command, not `rm`

- Back up before deleting, refuse when you can't, and refuse to purge while a run has no log (still executing).

---

## 15. The five failure shapes that recurred

*If you take nothing else from this document, take these. Each cost us more than once, in different modules,
wearing different clothes.*

### 15.1 Absence rendering as a value

**Never let "I could not check" and "I checked and it was fine" produce the same output.**

- A grader with no answer key returning `""` → pass (§13.6).
- An unknowable scope rendering as zero → the headline metric comes out with the **wrong sign**, showing
  grounding *causing* the problem it prevents (§8.2).
- A missing home declaration rendering as "no reset needed" (§13.4).
- An absent judge verdict printing identically to a passing one (§2.8).
- A demotion comparison against a nonexistent baseline evaluating to `size * 2 < 0` — **least protective
  exactly where there is no baseline** (§6.7).

None of these threw. None logged. All produced correctly-shaped, publishable-looking output.

### 15.2 A mechanism that reports success while doing the wrong thing quietly

- A transport that moves bytes without asking which copy is current (§10.12).
- A flag that typechecks on both ends of a wire and is read by neither (§13.5).
- A snap that logs `applied: true` while actuating an unrelated control (§4.10).
- A retired env var that is ignored rather than fatal, grounding the run on the wrong tier under the right
  label (§7.8).
- A guard installed on three entry points when operators use four (§7.8).

**The tell is always that every other signal says it works.** Test the *contract*, walking it end to end.

### 15.3 A ceiling acting as a verdict

Made three times, each one layer further out: the step budget (§1.1), the creation arms' 30-step cap, and the
stall window inherited by the arms least able to satisfy it. **Truncation and failure are different facts;
give them different names and different columns.**

### 15.4 Patching per-incident instead of asking the question once

- Window selection accreted three branches, and the fourth crash walked through the gap between them (§3.10).
- The teardown restore check was weakened three ways in three places before whole-value equality settled it
  (§8.4).
- **The fix shape is the same each time:** ask the question once, of every candidate, as a ladder — and make
  the decision a pure function so its ordering can be asserted rather than eyeballed.

### 15.5 Tests that assert the source text instead of the behaviour

- Every snap test asserted the source of the module rather than what it chose, and three real defects lived
  behind assertions that passed (§4.10).
- A receiver test that checked the file **mentioned** a field passed on the shipped bug (§13.5).
- **The fix is extraction:** pull the decision into a module-scope pure function so it can be tested at all.
  A regex over source cannot see which element was chosen.

---

## The meta-lesson

**Every rule enforced by memory was violated within a day. Every rule moved into code held.**

Prompt hygiene, the evidence grammar, provenance stamps, harness-written logs, destructive guards, wire
contracts, artifact scoping — all of them are code because each was first a convention, and each convention
was broken by someone meaning well, usually within 24 hours.

Start the real implementation where that ended.

---

## Where to look in this repo

| what | where |
|---|---|
| Agent loop, evidence gates, done-grading, the snap stage | `src/core/agent/` |
| `verify()`, prompt audit, scope warnings, observation projection | `src/core/harness/` |
| CDP backend + its rationale (read the header) | `src/backends/cdp.ts` |
| AX backend, activation policy, window-follow ladder | `src/backends/ax.ts` |
| Electron attach, launch flags, cold-start race | `src/backends/electron-attach.ts` |
| Explore: frontier, dismissal, salvage, descent, home, blackout ladder | `src/core/explore/` |
| Journal / teardown / standalone cleanup | `src/core/journal.ts`, `teardown.ts`, `cleanup.ts` |
| Procedures + replay | `src/core/procedure.ts`, `replay.ts`, `procedure-cli.ts` |
| Recipes: harvest gates, lineage | `src/core/recipe.ts`, `recipe-cli.ts`, `src/bench/harvest.ts` |
| Offline run judge | `src/core/judge.ts`, `src/bench/judge.ts` |
| Recording, humanize, motion fitting | `src/core/agent/recording.ts`, `src/cursor/` |
| Fleet: ssh, lease, jobs, profiles, provisioning | `src/remote/control/`, `src/remote/runner/` |
| Run-data layout and backups | `src/paths.ts`, `src/core/runs-cli.ts` |
| Benchmark matrix, collect, report, autopilot | `src/bench/` |
| Severity-ranked environment constraints | `LIMITATIONS.md` |
| What ports to production, with line counts | `docs/research/2026-08-03-what-ports-to-production.md` |
| The results themselves | `docs/research/2026-08-03-findings-summary.md` |

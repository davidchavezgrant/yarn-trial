# Self-driving demos — product status & open questions

*2026-07-29, updated 2026-07-31. Non-technical. Written for the onsite conversation about
prototype direction. The 07-30 pass folded in the clean re-measurement; the 07-31 pass
updates the run tallies, folds in the fleet (three colo Macs), web targets, the CDP
backend, automatic cleanup, and the cursor-rendering pipeline.*

---

## Where we are in one paragraph

The agent works. You give it a plain-English request, it looks at a real Mac app, decides
what to click, clicks it, checks that the screen actually changed the way it expected, and
keeps going until the task is done — recording video the whole time. It has completed real
multi-step work on two different apps, including a 17-step task that created a document,
wrote content into it, and changed a setting. It recovers from its own mistakes without
help — including on an app where it was given no notes at all. **The core bet is validated.**
Across 77 logged runs it completed the task in 70; of the seven failures, three ran out of
steps and four aborted because the app became unobservable (aborts used to write no log at
all — they do now, which is why the failure count grew faster than the failures did). Since
the last update it has also driven websites end to end (with no changes to the core loop)
and one native Mac app (Calculator — a second native app failed for a diagnosed,
fixable-in-principle reason, and native apps are out of scope for now). Runs now execute
unattended on three dedicated colo Macs, dispatched from a laptop, and every run puts the
app back the way it found it afterwards. The remaining risk is unchanged in kind: breadth
beyond web-technology apps, and how often a run gets through without the environment
tripping it.

---

## What is actually proven

A note on how to read this: the numbers below come from `docs/research/`, which carries
correction notes where a measurement turned out to be contaminated. Everything once marked
*pending* here has since been re-measured cleanly, with the contaminated inputs removed and
the loopholes closed in code. The short version: **what the agent can do is well established,
and the per-app setup pass now has a defensible number behind it.**

| Claim | Status | Evidence |
|---|---|---|
| Agent completes a real task from a plain-English request | **Proven** | Notion Calendar timezone change; Yarn cursor-style change |
| Works on genuinely multi-step, state-creating work | **Proven** | Yarn: new draft → wrote a 2-scene script → set the voice, 17 steps |
| Recovers from failure without a human | **Proven** | Three unaided recoveries in one run: a stray overlay swallowed typing, its scene-break syntax didn't parse, a field turned out not to be writable. It noticed each, changed approach, and reported honestly what it couldn't do |
| Finds its way around an app it has never seen | **Proven once** | Yarn task with all notes removed: found the setting in 13 steps by real search, including a wrong turn and a recovery. This is the strongest single result we have, and it needed no setup pass at all |
| Works with the way a user actually types | **Proven** | Conversational phrasing on both apps; see Q1 below |
| Produces a clean recording | **Proven** | `out/demo-goalonly-grounded.mp4` |
| Every action is checkable after the fact | **Proven** | Each step logs what was attempted, what was expected, whether it happened, and a screenshot |
| Every action *was* checked | **Recently true** | The check used to be lenient enough to pass steps that claimed nothing. Fixed; runs before that fix report optimistic pass counts |
| The per-app setup pass is worth its cost | **Proven** | Clean re-measure, contaminated notes removed: roughly half the steps and half the cost (2–2.5×). More importantly it fixes *which* control gets changed — see item 2 |
| Works on websites, not just Mac apps | **Proven** | `--url` runs completed on Wikipedia with zero changes to the core loop; sites get the same scouting pass and the same cleanup |
| Runs unattended on dedicated machines | **Proven** | Three colo Macs, dispatched from a laptop; a lease keeps runs from colliding; a human signs each app in once per Mac |
| The app is put back after a run | **Built, partly proven live** | Every change is journaled as it happens and undone after the recording is saved; verified live on web runs, not yet on a live Yarn run |
| Works on arbitrary apps | **Not proven** | Both deeply-proven apps are web technology in a Mac wrapper. One native app passed (Calculator), one failed with a diagnosed cause (Hex Fiend); native is out of scope for now. Still the headline open risk |
| Works *reliably* — same task, many times | **Partly measured** | 70 of 77 logged runs completed their task. Aborted runs now write logs too (they didn't before 07-30, which silently flattered earlier tallies), but the ~1-in-3 abort figure below predates that fix and hasn't been re-measured |

---

## What we learned that changes the plan

**1. The agent can work an unfamiliar app without help — that's the core result.**
Given no notes at all, it found a setting it had never seen in 13 steps: it searched the
wrong place, backed out, opened the wrong menu, triggered a feature that blinded it
entirely, recovered, and found the right page. That is genuine search with a real mistake
and a real recovery, and it is the result we're most confident in because nothing was
handed to it.

**2. The setup pass pays for itself — and what it really buys is correctness, not speed.**
We give each app a one-time "scouting" pass that writes down where things live. The early
comparisons were invalid: the notes had been hand-edited over time to include step-by-step
recipes for the exact tasks we were measuring, so we were partly measuring "does telling the
agent the answer help" — not a question. The pipeline has since been split so the two can't
be confused again (machine-written notes and hand-written recipes are separate tiers, and
each run records which it used), and the comparison was re-run clean.

Result: with scouting, roughly **half the steps and half the cost** — 4 steps vs 10 on the
Yarn task, 5 vs 7–10 on Notion. Useful, but not the important part.

The important part is that **the ungrounded runs were changing the wrong setting.** Yarn
exposes ten of its settings in two places (per the current scouting notes): a brand-wide
default and a per-project override that quietly wins for that one project. Asked to change the cursor style, every
single run without scouting notes edited the per-project override — and then correctly
reported success, because the setting it touched really did now read the new value. The
scouted runs changed the brand-wide default. Both pass every check we have; only one is
what a person meant. Any app with global defaults plus per-document overrides — editors,
IDEs, design tools, browsers — has this failure mode waiting in it. That is the argument
for scouting, and it is a correctness argument, not a cost one.

**3. The single biggest cost lever is remembering *how*, not *where*.**
One task was accidentally run with the method handed to the agent instead of discovered,
and it dropped from 17 steps to 6. The measurement was flawed as an autonomy result — and
the original log has since been lost to hand-copying, so the exact figure is unauditable —
but the direction is solid and worth pursuing: after a task succeeds once, save the exact
sequence and replay it, only waking the model when something doesn't match. Scouting makes
the first run cheaper; recipes make every run after it nearly free and fully deterministic.
This is still the clearest next investment; it just needs a clean measurement.

**4. Latency stopped being a problem.**
The agent thinks for ~10 seconds between actions. Yarn re-renders the cursor in post from
real human mouse data and time-compresses demos, so the delivered timeline is synthetic and
the pauses vanish. Of the three original caveats — one app, flakiness, latency — only the
first two are real.

**5. We kept catching ourselves measuring the wrong thing, and each time closed the hole.**
Worth stating plainly, because these are exactly the errors that make a prototype look
better than it is — and because the pattern is the point: each one was found by auditing our
own results, and each fix is enforced by the tool rather than by anyone remembering.

- Two demo takes had the *method* written into the request, so the agent was following
  instructions rather than working it out — and were described as autonomous. The tool now
  refuses to run a request that tells it how.
- A run reported "success in 3 steps" where **nothing had actually been checked** — the
  agent's own word. The tool now refuses to take an action it can't verify, and it caught a
  real bug on the very next run.
- The pass/fail check itself was too lenient: it approved steps whose claim was empty, and
  counted text the agent had just typed as proof the app had responded. Both closed.
- The setup-pass comparison used notes contaminated with the tasks under test (item 2).
- One run's log was overwritten by hand and can no longer be audited. Logs are now written
  only by the tool, under unique names.

None of these changed what the agent can do. Several changed the numbers, downward.

---

## Open product questions

These need a decision from Yarn, not more engineering. Roughly in order of how much they
change the build.

### Q1. "Show me how to X" — do we perform X, or point at it? — **decided: perform**

The two apps used to split on this. Notion **changed** the timezone; Yarn **opened** the
cursor-style menu and politely left the setting alone. The brief already answered it —
*"you can say 'Show me how to change my timezone to Paris' and the agent will perform the
action"* — so the polite version was a defect, and it has been fixed.

Settled 2026-07-29 and now built in: the agent performs the task end to end and leaves the
app in the changed state. If the request doesn't say which value to pick, it picks one and
says which. Changes have to be saved and confirmed to have stuck.

**With one carve-out, also built in and verified:** anything irreversible or visible to other
people — delete, publish, export, send, share, purchase, account changes — is taken as far as
the final confirmation dialog and stopped there, saying so. Tested on "show me how to delete
a draft": it opens the menu showing Delete and never clicks. 12 drafts before, 12 after.

What this leaves open is Q2, not Q1: performing means demos **mutate a real workspace**, so
whose workspace it is becomes the live question.

### Q2. Whose account, and whose data, appears in the demo?

Every recording so far shows a real workspace with real content in it. For a customer-facing
demo library this is the biggest unresolved product question:

- Demo accounts with seeded fake content (clean, safe, but "not your data")?
- The customer's own account (compelling, but recordings contain their real information and
  every run changes their state)?
- Something in between — their account, restricted to read-only paths?

Two pieces of this are now solved technically, which narrows the decision: on shared demo
machines each operator gets their own copy of an app's signed-in data (so one person's demo
never shows another's documents), and credentials never pass through the agent at all — a
human signs in once per app per machine, because every frame the agent sees goes to the
model and into the video. What remains — whose account a *customer-facing* demo shows — is
infrastructure and legal review. **Needs Yarn's call.**

### Q3. What does onboarding a new app actually cost, and who does it?

Today: one scouting pass — **measured at ~40 minutes / 96 actions** for a *finished* pass
on Yarn (the earlier "~5-6 minutes" figure measured a pass cut short by a step budget and
was retracted; small apps finish much faster), plus a human sanity-check of the notes. That
is ~2.8% of Jasper's ~24h per-app budget, so cost is still not the constraint; trust is.
One part of the answer is already fixed: **sign-in needs a human**, once per app per
machine — SSO with MFA is not automatable in the general case, and we deliberately keep
credentials away from the agent. The remaining questions are commercial rather than
technical:

- Is ~40 min + review acceptable per app, or does it need to be push-button?
- Does the rest of the scouting pass need a human in the loop for safety, or can it
  self-certify? (Related knob, already built: the pass refuses to press destructive-looking
  buttons by default, which leaves the workflows behind them unmapped; a guarded mode can
  peek behind them safely.)
- How many apps is the target — ten, hundreds? That decides whether we hand-tune per app or
  build for unattended scale.

### Q4. What reliability bar counts as shippable?

Two different numbers, and the gap between them is the whole answer. Of runs that got
started, **45 of 46 completed the task**. But roughly **one attempt in three never gets that
far** — the app's accessibility layer goes dark, focus jumps to another window, the driver
session dies — and those attempts write no log at all. Retrying has worked every time, so
today this is a throughput cost rather than a capability limit. It is also the single
biggest obstacle to running unattended.

So someone has to name the bar, and say which number it applies to: is a 1-in-3 retry rate
acceptable if the demo that comes out is right, or does it need to be right first time? That
determines whether the next block of work is "more apps" (breadth) or "same tasks many times"
(reliability). **I'd argue reliability first** — breadth on a flaky base just multiplies the
flakiness.

### Q5. What happens when the agent can't do it?

Right now it stops and says so honestly, which is the correct engineering behaviour but not
yet a product behaviour. Options: silently retry, fall back to a scripted recipe, hand off to
a human operator, or surface "we can't demo this yet." Related: a task can *partly* succeed —
Yarn's draft-rename attempt failed while the rest of the task worked. Is a partial demo
publishable?

### Q6. How much human imperfection do we want?

Yarn already re-renders the cursor from real human movement, and there's been talk of
synthetic typos and pointer-type switching. The agent's data feed supports all of it — click
points, timestamps, and what kind of control was touched (so a text field can show an I-beam).
The question is purely taste: how much imperfection reads as authentic before it reads as
sloppy? **Our side is ready either way; this is a call for whoever owns demo aesthetics.**

### Q7. Which apps matter first?

"Arbitrary apps" is the ambition, but the prototype should be pointed at the apps customers
actually ask for demos of. A ranked list of the top five would immediately sharpen the next
round of work — and would tell us whether the hard cases are browser apps, native Mac apps,
or Electron apps like Yarn itself.

---

## Honest risk assessment

| Risk | Severity | Note |
|---|---|---|
| Doesn't generalize past two apps | **High** | Biggest unknown. Both proven apps are web technology in a Mac wrapper; a true native Mac app is untested. Nothing so far suggests it won't work, but nothing proves it will |
| Runs abort on environment flakiness ~1 in 3 | **High** | The task itself succeeds 45 times in 46 once it starts. Getting it started reliably is the gap. Retries are clean, so it's throughput today — but it blocks unattended operation. Q4 |
| Recordings contain real workspace data | **High** | Product/legal, not technical. Q2 |
| Demos change the customer's live state | Medium | Follows directly from "perform, don't point at." Needs a deny-list and a reset story |
| Some app surfaces can't be driven at all | Medium | Yarn's own screen recorder is invisible to our automation. Every app will have a few of these; they need to be found during scouting, not during a demo |
| Per-app setup doesn't scale | Medium | Fine at ten apps, unclear at hundreds. Q3 |
| Demos change the wrong setting and still look correct | **High** | Re-measured and confirmed: without scouting notes, every run edited a per-project override instead of the global default, and reported success truthfully. Scouting fixes it; nothing verifies it independently (item 2) |
| Cost per demo | Low–Medium | Real but small today, and recipes should cut it hard |
| Latency | **Resolved** | Yarn's post pipeline absorbs it |

---

## What I'd do next, in order

1. **Attack the 1-in-3 abort rate.** Not the task logic — the environment around it: the
   accessibility layer going dark, focus loss, dead driver sessions. This is now the gap
   between "the task works" and "we can leave it running." Cheapest high-value work
   available, and on Yarn's own app there's a shortcut: they control it, so they can force
   accessibility on or expose a debug port and skip the flaky channel entirely.
2. **Third app, chosen by Yarn.** Directly attacks the generalization risk. Ideally something
   unlike the first two — a real native Mac app, or something visually driven, rather than
   another web app in a wrapper.
3. **Recipes.** The cost and determinism story for production, on the strength of the
   17-steps-to-6 direction rather than that specific number.
4. **Settle Q2.** Whose workspace the demos run in. Q1 is decided; this one is cheap to
   decide and blocks anything customer-facing.

---

## Source material

- Full measurements, and the correction notes qualifying them:
  `docs/research/2026-07-29-yarn-poc-findings.md` — read the correction note at the top
  before quoting any figure
- How it works, for a technical reader: `docs/research/2026-07-29-current-approach-brief.md`
- Constraints found in practice: `LIMITATIONS.md`
- Recordings and per-step run logs: `out/` (not in version control)

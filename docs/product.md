# Self-driving demos — product status & open questions

*2026-07-29. Non-technical. Written for the onsite conversation about prototype direction.*

---

## Where we are in one paragraph

The agent works. You give it a plain-English request, it looks at a real Mac app, decides
what to click, clicks it, checks that the screen actually changed the way it expected, and
keeps going until the task is done — recording video the whole time. It has completed real
multi-step work on two different apps, including a 17-step task that created a document,
wrote content into it, and changed a setting. It recovers from its own mistakes without
help — including on an app where it was given no notes at all. **The core bet is validated.**
What's unproven is breadth and consistency: two apps, a handful of tasks, one run each, and
no measured failure rate. The remaining risk is not "does this work" but "how often does it
work, and what does it cost per app."

---

## What is actually proven

A note on how to read this: the numbers below come from `docs/research/`, which carries
correction notes where a measurement turned out to be contaminated. Where a figure is
disputed by its own source, it is marked **pending** here rather than quoted as fact. The
short version: **what the agent can do is well established; how much our per-app setup pass
contributes is currently being re-measured.**

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
| The per-app setup pass is worth its cost | **Pending re-measurement** | The comparison was run against setup notes that had been hand-edited to include the very tasks being tested. Re-running now |
| Works on arbitrary apps | **Not proven** | Two apps. This is the headline open risk |
| Works *reliably* — same task, many times | **Not measured** | One run per condition. We have no failure rate |

---

## What we learned that changes the plan

**1. The agent can work an unfamiliar app without help — that's the core result.**
Given no notes at all, it found a setting it had never seen in 13 steps: it searched the
wrong place, backed out, opened the wrong menu, triggered a feature that blinded it
entirely, recovered, and found the right page. That is genuine search with a real mistake
and a real recovery, and it is the result we're most confident in because nothing was
handed to it.

**2. How much our setup pass adds is honestly unknown right now.**
We give each app a one-time "scouting" pass that writes down where things live. Early
comparisons suggested it saved anywhere from 20% to 3×, but those comparisons were
invalid: the notes had been hand-edited over time to include step-by-step recipes for the
exact tasks we were measuring. So we were partly measuring "does telling the agent the
answer help" — which is not a question. Clean passes are running now, and the pipeline has
been split so the two can't be confused again: machine-written notes and hand-written
recipes are separate tiers, and each run records which it used. **Treat any per-app setup
figure as pending.**

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

### Q1. "Show me how to X" — do we perform X, or point at it?

The two apps split on this. Notion **changed** the timezone. Yarn **opened** the cursor-style
menu to reveal the options and deliberately left the setting alone, explaining that the user
had only asked to be shown.

The brief already answers it — *"you can say 'Show me how to change my timezone to Paris' and
the agent will perform the action"* — so **perform** is the intent, and Yarn's polite version
is a defect. But it needs to be settled deliberately, because it has real consequences:

- Performing means demos **mutate the customer's real workspace**. Whose account are these
  demos recorded in? Q2.
- Some requests shouldn't be performed on a live account at all ("show me how to delete my
  workspace"). There will need to be a category of task that gets demonstrated, not done.

**Recommendation:** perform by default, with a small deny-list of destructive verbs.

### Q2. Whose account, and whose data, appears in the demo?

Every recording so far shows a real workspace with real content in it. For a customer-facing
demo library this is the biggest unresolved product question:

- Demo accounts with seeded fake content (clean, safe, but "not your data")?
- The customer's own account (compelling, but recordings contain their real information and
  every run changes their state)?
- Something in between — their account, restricted to read-only paths?

This drives infrastructure, legal review, and the deny-list above. **Needs Yarn's call.**

### Q3. What does onboarding a new app actually cost, and who does it?

Today: one scouting pass — **measured at ~5-6 minutes** of machine time (Yarn 4m57s / 23
actions; Notion Calendar 5m51s / 20 actions), plus a human sanity-check of the notes. That
is ~0.4% of Jasper's ~24h per-app budget, so cost is not the constraint; trust is. The open
questions are commercial rather than technical:

- Is 6 min + review acceptable per app, or does it need to be push-button?
- Does the scouting pass need a human in the loop for safety, or can it self-certify?
- How many apps is the target — ten, hundreds? That decides whether we hand-tune per app or
  build for unattended scale.

### Q4. What reliability bar counts as shippable?

We currently have **no failure rate** — one run per condition. Before this ships, someone has
to name the bar: is 8 in 10 good enough with a retry, or does it need 99 with a human
reviewing rejects? This determines whether the next block of work is "more apps" (breadth)
or "same tasks many times" (reliability). **I'd argue reliability first** — breadth on a
flaky base just multiplies the flakiness.

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
| Doesn't generalize past two apps | **High** | Biggest unknown. Nothing so far suggests it won't, but nothing proves it will |
| No known failure rate | **High** | Cannot promise reliability we haven't measured. Cheap to fix: repeat runs |
| Recordings contain real workspace data | **High** | Product/legal, not technical. Q2 |
| Demos change the customer's live state | Medium | Follows directly from "perform, don't point at." Needs a deny-list and a reset story |
| Some app surfaces can't be driven at all | Medium | Yarn's own screen recorder is invisible to our automation. Every app will have a few of these; they need to be found during scouting, not during a demo |
| Per-app setup doesn't scale | Medium | Fine at ten apps, unclear at hundreds. Q3 |
| Per-app setup may be worth less than we thought | Medium | Its measured value is currently withdrawn pending clean re-measurement (item 2). Note the zero-notes run succeeded anyway, so this is a cost question, not a capability one |
| Cost per demo | Low–Medium | Real but small today, and recipes should cut it hard |
| Latency | **Resolved** | Yarn's post pipeline absorbs it |

---

## What I'd do next, in order

1. **Measure reliability.** Same handful of tasks, repeated, both apps. Converts "it worked"
   into a number we can put in front of a customer. Cheapest high-value work available, and
   it's what the strengthened checks now make trustworthy.
2. **Finish the clean setup-pass measurement.** Already running. Turns the one figure
   currently withdrawn back into something quotable.
3. **Third app, chosen by Yarn.** Directly attacks the generalization risk. Ideally something
   unlike the first two — a browser app, or something visually driven.
4. **Recipes.** The cost and determinism story for production, on the strength of the
   17-steps-to-6 direction rather than that specific number.
5. **Settle Q1 and Q2.** Both are cheap to decide and both block anything customer-facing.

---

## Source material

- Full measurements, and the correction notes qualifying them:
  `docs/research/2026-07-29-yarn-poc-findings.md` — read the correction note at the top
  before quoting any figure
- How it works, for a technical reader: `docs/research/2026-07-29-current-approach-brief.md`
- Constraints found in practice: `LIMITATIONS.md`
- Recordings and per-step run logs: `out/` (not in version control)

# Self-driving demo agent — findings

~200 runs on Yarn, one model (GPT-5.6 Sol) plus a 9-run Claude Fable slice, two tasks
(settings change, script creation), 142 independently judged.

## What we learned

**Grounding's value depends on the actuator, not on grounding.** On CDP every tier passes 3/3 —
ungrounded included. On AX, ungrounded is 1/3 while grounded is 3/3. The map is insurance
against a weak actuator, not a general speed-up.

| arm | success | steps | output tokens |
|---|---|---|---|
| ax ungrounded | 1/3 | 8 | 3671 |
| ax grounded | 3/3 | 10 | 1418 |
| cdp ungrounded | 3/3 | 11 | 1559 |
| cdp grounded | 3/3 | 9 | 1362 |
| **procedure, harvested from a mapless run** | **3/3** | **8** | **848** |
| curated human notes | 3/3 | 6 | 817 |

**A write-up from a mapless run beats the 40-minute exploration pass.** Harvest a procedure from
an agent that had no map, and it matches curated human notes at 848 tokens — 40% under the
appmap tier, dead consistent across three runs. Per-app onboarding plausibly collapses from a
40-minute sweep to a handful of successful runs plus a harvest.

**Vision-only fails on perception, not aim.** Holding the backend constant on CDP — where
screenshot pixels are 1:1 with click coordinates by construction — a model working from pixels
misses its target 75% of the time against 11% with an element list. AX vision-only (79%) matches
CDP vision-only (75%), so the actuator was never the differentiator.

**Filming was costing us a 4x reliability drop, for nothing.** Recorded AX runs went 2/13 while
unfilmed went 26/39. Two causes, both harness defects: the window is resized at run start and the
first geometry read lands mid-reflow; and demo mode replaced `AXPress` with coordinate clicks to
"move the pointer" — which our own trajectory data shows CGEvent actuation doesn't do either.
Fixed: **2/13 → 6/9**, now equal to unfilmed.

**The "~43px AX coordinate offset", open three days, was not a coordinate bug.** The transform is
sound (window 1570x970, shot 1568x969, height gap 0.24pt). The same control reported y=21 then
y=74 one observation apart. It was a snapshot taken before the window finished reflowing.

**Self-reported success is trustworthy here.** 4 disagreements in 142 judged runs. That is a
change from July, when the wrong-scope class made self-report unreliable — what fixed it is that
scope disclosure is now graded and the runs disclose.

**Verification is decisive on product-shape work and mute on open-ended work.**

| | settings task | script creation |
|---|---|---|
| judge PASS / FAIL / UNPROVEN | 31 / 2 / 0 | 13 / 17 / 12 |
| visual verdict usable | 30 of 33 | 8 of 42 |
| steps with no checkable evidence | 32% | 71% |

Product-use demos — what Yarn ships — grade cleanly. Open-ended requests do not.

**Only human prose picks the brand-wide setting.** Across 44 judged runs, ungrounded,
explore-appmap and procedure tiers all changed the per-document override; curated notes changed
the brand default 5/5. The appmap contains both routes, so the difference is presentation, not
information. Worth knowing before a customer's demo edits one draft instead of their defaults.

**Fable is comparable**: 6/9, zero disagreements, on the same cells Sol ran.

## What we didn't learn

- **Whether a pixel-written map is useful to a normal agent.** The arm ran ungrounded (the map
  never got written) and was correctly disqualified. Reported and retracted.
- **Cross-app transfer.** Notion was cut; only a second *task* was measured, never a second app.
- **Whether recipe replay works.** 1/3 with model rescue, 0/3 without. Two causes found and
  fixed — ambiguous target names, values that are only new once — but not re-measured.
- **Whether snapping rescues vision-only.** Built, not yet run.
- **Whether creation-task runs would pass with more steps.** Three hit a 30-step cap with
  verified progress still occurring; the cap is gone but the re-runs are outstanding.

## What to build

1. **CDP as the actuator.** Zero coordinate failures, 11% target-miss, unaffected by filming, no
   cua session lifetime. Everything above says the AX path is the fallback.
2. **Procedure harvesting.** The cheapest grounding tier measured and the only one that removes
   the per-app exploration pass.
3. **Scope disclosure in the demo output.** It already makes self-report trustworthy; surfacing
   "this changed one draft, not your defaults" is a small step from there.
4. **Run the snap arms.** Vision-only reasoning with element-precise actuation — built, two
   tolerances, and it decides whether the larger visual-snap work is worth anything.

## What not to build

1. **Vision-only as a deployment path.** The ceiling is perception, and no actuator fix moves it.
2. **Recipe replay, until parameterised.** A frozen click sequence breaks on a duplicate control
   name or a value it typed last time; and a task whose steps produce no checkable text — the
   motion-blur route, most creative work — can never compile at all.
3. **Visual snapping (CV on screenshots).** The genuine fix for element-free apps, and a large
   build. Wait for the snap arms to say whether vision-only's misses are spatial or semantic.
4. **Chasing the AX coordinate transform.** It was never wrong.

## Reading the numbers

`seen` and `surfaces` in the discovery stage are ledger-derived and unreliable — one pass
reported 6609 controls seen against its own twin's 293, same code, because it scrolled a list.
Both distilled to comparable maps (207 vs 144 nodes). Use **graph nodes** and **actuated**.

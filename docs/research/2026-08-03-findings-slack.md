*Self-driving demo agent — what ~200 benchmark runs said*

Full write-up: `docs/research/2026-08-03-findings-summary.md`

*What we learned*

• *Grounding is insurance against a weak actuator, not a speed-up.* On CDP every grounding tier passes 3/3 — including no map at all. On the AX path, ungrounded is 1/3 and grounded is 3/3.

• *A write-up from a mapless run beats the 40-minute exploration pass.* Harvest a procedure from an agent that had no map: 3/3, 848 output tokens, matching hand-written human notes and ~40% under the appmap tier. Per-app onboarding may collapse from a 40-min sweep to a few good runs plus a harvest.

• *Vision-only fails on perception, not aim.* Same backend, same coordinate space: a model working from pixels alone misses its target 75% of the time vs 11% with an element list.

• *Filming was costing a 4x reliability drop for no benefit.* Recorded AX runs were 2/13 vs 26/39 unfilmed — both causes were our own harness. Fixed: 2/13 → 6/9, now equal to unfilmed.

• *Verification is decisive on product-use demos and mute on open-ended requests.* Settings-change tasks: 31 judge PASS / 2 FAIL / 0 unproven. Script-writing: 13 / 17 / 12, with 71% of steps producing nothing checkable.

• *Self-reported success is trustworthy here* — 4 disagreements across 142 independently judged runs.

• *Only human-written notes pick the brand-wide setting.* Every machine-derived tier edited the per-document override instead. The map contains both routes, so this is about how they're presented — worth fixing before a customer's demo edits one draft rather than their defaults.

*What we didn't learn*

• Cross-*app* transfer — only a second task was measured, never a second app.
• Whether recipe replay works: 1/3 with a model rescue, 0/3 without. Two causes found and fixed, not yet re-measured.
• Whether a map written from screenshots is useful to a normal agent — that arm ran ungrounded and was disqualified.

*What to build*

1. CDP as the actuator; AX as fallback only.
2. Procedure harvesting — cheapest tier measured, and the only one that removes the per-app exploration pass.
3. Surface scope in the demo output ("changed this draft, not your defaults").

*What not to build*

1. Vision-only as a deployment path — the ceiling is perception, no actuator fix moves it.
2. Recipe replay until it's parameterised — and note a task whose steps produce no checkable text can never compile at all.
3. Screenshot-based CV snapping — real fix for element-free apps, big build, and we have arms queued that will say whether it's worth it.

One caveat for anyone reading the dashboard: the `seen` / `surfaces` discovery columns are unreliable (one pass logged 6609 controls vs its own twin's 293, purely from scrolling a list). Use *graph nodes* and *actuated*.

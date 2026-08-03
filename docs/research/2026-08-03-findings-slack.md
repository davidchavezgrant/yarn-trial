*Self-driving demo agent — first benchmark pass, 198 runs. Here's what came out.*

It takes a plain-English task ("show me how to change the cursor type"), does it in Yarn, and films
the result. One app, two tasks, 187 of the runs re-graded afterwards by a separate judge model that
never saw the agent's own verdict. Full write-up if you want the detail:
`docs/research/2026-08-03-findings-summary.md`.

The short version:

• *It works on the demos we'd actually ship.* Every CDP arm passed 3/3 on the product-use task, and
the judge reached a verdict on 82 of 83 of those runs. Open-ended asks ("write me a two-scene
script") don't grade — it couldn't tell on 18 of 37, because there's no fact to check against.

• *Onboarding a new app is cheaper than the 40-minute crawl.* Let the agent work the app out once
with no map, then have it write down what worked: 3/3, at 848 output tokens against 1,362 for the
generated map it replaces. ~40% cheaper, and it's the only approach that removes the per-app
exploration pass entirely.

• *Grounding is insurance against a weak actuator, not a general speed-up.* On CDP even *zero*
grounding passes 3/3. On the accessibility path it's 1/3 ungrounded → 3/3 grounded. The map isn't
making the agent smarter; it's covering for the less precise way of clicking.

• *Screenshots alone aren't enough.* Given only pixels the agent missed what it was aiming at 75% of
the time; given the list of on-screen elements, 11%. That's the model's eyesight, not our click
code — so better clicking won't move it.

• *Recording was costing a 4x reliability drop, and both causes were ours.* Filmed runs on the
accessibility path went 2/13, against 26/39 unfilmed. Fixed — a window-resize race, plus a needless
swap to coordinate clicks — now 6/9, level with unfilmed.

• *One to watch: which setting got changed.* Yarn has brand-wide defaults and per-document
overrides. Every automatically-generated form of guidance sent the agent to the per-document one;
only human-written notes hit the brand default, 5 times out of 5. Worth fixing before a customer's
demo edits one draft instead of their defaults.

• *The agent's own success claim is trustworthy on this app* — the independent judge disagreed on 6
of 187 graded runs.

• *Running it remotely is tenable; sign-in is the blocker, not compute.* All 198 runs were
dispatched, queued, filmed and pulled back from three colocated Macs. Moving a live session between
machines failed outright; the answer is cloning pre-signed-in golden-image VMs, which is how GitHub
and Cirrus run their own Mac fleets.

Two more if the audience is technical:

• *Frozen click-by-click replays ("procedures") aren't ready* — 1/3 with a model on standby to
repair broken steps, 0/3 without. Two causes found and fixed, not yet re-measured.

• *About a third of the code ports as-is* — 15.5k of 49k lines is the engine (agent loop,
verification, grounding, put-the-app-back, the CDP driving mode). The rest is benchmark harness and
trial scaffolding. Caveat: the next bucket down is job queueing and host management, which you may
already have — I scoped it without access to your repo.
`docs/research/2026-08-03-what-ports-to-production.md` has the breakdown.

One caveat worth stating up front: this pass measured a second *task*, never a second *application*.
A Notion pass is queued but hasn't produced results, so nothing here is a cross-app transfer claim.

Happy to walk through any of it.

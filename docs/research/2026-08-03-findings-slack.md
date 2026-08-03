*Self-driving demo agent — ~200 benchmark runs, here's what came out*

It takes a plain-English task ("show me how to change the cursor type"), does it in Yarn, and films the result. Full write-up if you want the detail: `docs/research/2026-08-03-findings-summary.md`.

The short version:

• *It works on the thing we'd actually ship.* Product-use demos pass reliably, and we can check them automatically afterwards. Open-ended asks ("write me a two-scene script") don't — there's no fact to check the result against.

• *Onboarding a new app is cheaper than we thought.* Instead of a 40-minute automated crawl of every app, let the agent work it out once and write down what worked. Same success rate, ~40% less cost, and it's the only approach that removes the per-app setup entirely.

• *Screenshots alone aren't enough.* Given only pictures, the agent misses what it's aiming at 75% of the time. Given a list of the on-screen elements, 11%. That's the model's eyesight, not our clicking — so better clicking won't fix it.

• *One to watch:* when a setting exists in two places (brand-wide default vs. this-document override), every automatic form of guidance sent the agent to the document one. Worth fixing before a customer's demo edits one draft instead of their defaults.

• *Running it remotely is tenable.* Compute was never the problem — sign-in was. The fix is to clone whole pre-signed-in Mac VMs rather than trying to move a live session between machines, which is how GitHub and others run their Mac fleets.

• *About a third of the code is reusable as-is.* It came to ~49k lines, so: roughly 15k is the engine and ports largely intact (the loop, the checking, grounding, put-the-app-back, the CDP driving mode); ~8k solves real production problems in a way that's specific to running three Macs from a laptop, so the design ports and the code doesn't; ~5.5k is the benchmark, worth keeping as a regression suite; the remaining 20k was scaffolding — fleet admin, the trial's own UI, the results dashboards. One caveat on the middle bucket: that's job queueing and host management, which you may already have — I scoped it without access to your repo. Breakdown in `docs/research/2026-08-03-what-ports-to-production.md`.

Happy to walk through any of it.

# cua and the real implementation — what the trial taught, reframed for the team

2026-07-30. Companion to `2026-07-30-cua-dependency-audit.md` (the call-site inventory and
replacement-cost evidence; not repeated here). That audit answered "should the *trial repo*
migrate off cua mid-trial?" — no, wrong frontier — and keyed its recommendation to a
trigger: productization. **The trigger has fired.** The trial is over, David is joining,
and the question is no longer "migrate?" but "found?": which actuator does the *product*
get built on, from scratch, by a team, for customers. Incumbency is not an argument
anymore — in a greenfield build, cua has to win on merit per target class, and the trial's
own evidence says where it does and doesn't.

Two facts from David reframe the deployment picture relative to the trial docs:
**production targets are customers' apps, not Yarn's own** (the canonical-Yarn-target rule
was trial measurement discipline, nothing more), and **VMs are currently unrealistic
because of authentication** — customer apps sit behind SSO+MFA, which is not automatable
in the general case, so signed-in sessions must persist on real machines. §2 works out
what follows.

## 1. The most important reframe: most of what the trial built is not about cua

Partition the trial's output into what survives any actuator swap versus what is
vendor-specific. The ratio is the headline.

**Durable — the actual deliverable of the trial (transfers wholesale):**

- **The verification architecture.** Expectation-before-action; checks must be
  *discriminating* (satisfied only after the action); vacuous checks rejected unexecuted;
  pixel delta as the advisory channel for canvas content AX can't see; visual judge at
  `done` that must receive the agent's *claim*, not just the task. Every one of these
  closed a hole that produced a false success in practice. This is the part Jasper's
  reliability frontier actually needs, and none of it touches the actuator.
- **Scope ambiguity is a property of apps, not of automation stacks.** Global default vs
  per-document override, 10 dual-scope settings on Yarn alone, all 4 ungrounded runs
  changing the wrong one *while passing verification*. The appmap graph
  (`settingKey`+`scope`), `findScopeAmbiguities()`, and both-routes-presented prompting
  are the mitigation, and they'd be identical on Playwright.
- **Grounding as a pipeline stage.** explore → stamped appmap → agent: ≈2–2.5× fewer
  actions/tokens and — more importantly — scope *correctness*. Exploration cost 40min/96
  actions ≈ 2.8% of the ~24h/app budget. Provenance discipline (stamped machine output vs
  curated procedures as separately-declared inputs) exists because contamination happened
  twice; it's process, not code.
- **Measurement hygiene enforced in code.** Goal-only task prompts, `auditTaskPrompt()`,
  harness-written run logs. The rule was violated twice when enforced by memory and zero
  times since it moved into code.
- **Cleanup as a first-class phase.** Mechanical mutation journal (diff observed values,
  never trust the model's account), harness-written restore checks the model cannot
  widen, `controlReads()` instead of haystack greps, journal-append-on-detect for crash
  recovery. Any fleet needs this regardless of actuator.
- **Reliability and feel decouple** (Jasper, confirmed by the humanize work). The agent's
  deliverable to the renderer is *data* — click point, timestamps, target role + rect,
  before/after frames. StepRecords already carry all of it independently of cua's
  trajectory format. The physical pointer never moves during a run (cursor.jsonl: 1.2% of
  samples), so motion is synthesized from this data anyway. The contract to preserve in
  the real implementation is the data shape, not the recorder.
- **The projection layer is ours.** `observe()` already does the element filtering,
  ancestor naming, haystack building, pixel-space conversion. Whatever feeds it — cua,
  CDP, a Swift sidecar — plugs in beneath an interface we've already proven can host two
  backends (AX and DOM).
- **Agent-facing tool design.** One action per turn; per-ref capabilities; `find`/`query`
  as budget-escape hatches; `wait` as a real action (embedded-agent apps think for
  minutes); URL as the strongest evidence class on web targets.

**Vendor-specific — discarded or renegotiated in the real implementation:**

The 300s-TTL heartbeat, the shutdown-kills-daemon lease (→ one run per Mac), the
consent-pty hack, the axdom sidecar + frame-geometry join, semantic_v2 paging, the
delivery-mode quirk catalogue, error-prose regex matching. Per the audit: five of seven
documented workarounds are us re-adding capability the driver has but doesn't expose.
In a product codebase each of these is either an upstream ask or a reason to choose
differently.

One of them deserves to be named as a lesson: **the ugliest code in the repo
(`mintApprovalToken` answering a human-consent prompt under `expect`) exists solely
because we consumed a third-party safety gate designed for a threat model we don't
have.** cua must protect arbitrary users' browser profiles; a first-party fleet driving
its own disposable profiles needs no such gate — and direct CDP on machines we control
has none. Adopting a general-purpose tool means inheriting its whole threat model.

## 2. The deployment constraint that shapes everything: authentication

Production targets are **customers' apps, not Yarn's** — the trial's canonical-target rule
was a measurement convenience, and nothing in the harness is Yarn-specific (transfer to a
second app needed zero harness changes; that was the point of measuring it). Customers'
products means: overwhelmingly web apps and Electron, **behind sign-in, usually SSO+MFA**.

That last clause is the constraint that organizes the architecture. **VMs/ephemeral
environments are currently unrealistic because of authentication**: SSO with MFA is not
automatable in the general case (LIMITATIONS §12 states it as a requirement, not an
inconvenience), so a signed-in session is a *stateful, human-created asset* that must
persist between runs. Ephemeral compute destroys exactly that asset. The trial already
built the honest answer — `./run signin`: a human signs into the target app once per app
per machine, the session persists on the machine, and no credential ever enters the agent
loop (deliberately — every observation and frame reaches the model and the recording).
The same pattern holds for web targets via persistent named browser profiles (login once
per host, every later run inherits it).

So the deployment reality is **persistent, Yarn-controlled Macs holding signed-in
sessions** — the colo-fleet shape the trial ended with, not a container farm. Sessions
are the scarce resource; machines exist to hold them. Consequences:

- The per-Mac costs in LIMITATIONS §12 (human TCC grants, human sign-in, screen-share
  bootstrap) are not teething problems to engineer away — they're the product's unit of
  onboarding, roughly "per customer-app per machine," and worth designing *for* (making
  sign-in a first-class, auditable, re-runnable flow) rather than around.
- The one-run-per-Mac lease (forced by cua's shared-daemon shutdown, §6) is now a real
  scaling tax: parallelism = machine count, and machines are expensive precisely because
  they hold sessions. An actuator without a shared-daemon kill makes runs-per-Mac a
  scheduling decision instead of a hard limit — one of the concrete arguments below.
- If sessions-on-persistent-machines ever becomes the bottleneck, the leverage point is
  auth (persistent browser profiles on any host, customer-provisioned test accounts,
  session-transfer tooling), not virtualization.

## 3. The actuator decision decomposes by target class — there is no single "cua: yes/no"

Given persistent Macs as the substrate:

| Target class | Best actuator | Does cua earn its place? |
|---|---|---|
| **Customer web app** (the majority) | Chrome on the Mac fleet with persistent profiles, **CDP direct** (playwright-core attaching to a flag-launched Chrome we own) + thin Swift sidecar for OS-level keys + SCK one-shot capture (probe-verified unsigned) | Marginal. cua's `browser_*` is agent-shaped and pleasant, but Playwright is more mature, and attaching to our own Chrome deletes the consent gate outright — it existed to protect *other people's* profiles, and these are ours. |
| **Customer Electron app** | Launch with `--remote-debugging-port` ourselves (verified: Electron passes Chromium switches through), CDP direct; AX fallback for native chrome/menus/dialogs | Marginal, same reasoning. The trial's DOM-backend verdict — "DOM and AX compose; hybrid beats either" — holds, but the AX half is thin enough for a sidecar. One honest unknown: some customer Electron apps may strip or block debugging flags; the AX path is the fallback that keeps those serviceable. |
| **Native Mac app** | cua's AX actuation core — its genuine moat (background AXPress, foreground restore cycles, type_text fallbacks, years of edge cases) | **Yes — but this segment is currently out of scope** (David, 2026-07-30), and our single native probe failed on actuation anyway (Hex Fiend, 0/15: perception fine, app never became key). |

The pattern: **cua's irreplaceable surface is exactly the segment the product doesn't
target yet.** For the in-scope classes, mature-CDP-plus-thin-sidecar is equal or better,
removes a third-party auto-updating binary from the trust chain on the machines that hold
customer sessions, and — because it has no shared daemon — lifts the one-run-per-Mac cap.

("AX fallback for native chrome" is small but not zero — dialogs, menu-bar items, OS
permission prompts, file pickers; the sidecar estimate in the audit (~500–600 lines Swift,
primitives probe-verified) covers it.)

One product question still gates a row: **capture aesthetics.** Yarn composites
recordings into styled frames (Screen Clips: backgrounds, padding, shadows, synthetic
cursor). If a clean browser-viewport capture is an acceptable *input* to that pipeline for
web targets, recording simplifies to browser-native capture even on the Mac fleet; if the
deliverable must read as a genuine macOS window, the SCK sidecar path is the one that
matters. Either way the machines stay — auth decided that — but the recording stack
differs, so it's worth an early answer.

## 4. If cua stays anywhere, the relationship has to change

The trial consumed cua as a sealed published binary and paid for it (sealed element
projection → axdom; error-prose regex matching that "silently stops working if the driver
rewords"; a consent flow that changed under us between releases; near-daily releases with
a pinned-version skew already present, 0.12.5 npm vs 0.12.6 installed). A product team
should not hold that position. If cua survives the matrix anywhere:

- **Check the source question on day one.** package.json points at `github.com/trycua/cua`
  (MIT per the npm manifest). The trial never verified whether the driver's Rust core is
  actually in that repo or only the bindings. If the core is open, "sealed" was a
  consumption choice and fork/upstream is the correct posture; if closed, treat it as any
  other closed vendor with grants on your machines.
- **The upstream list already exists**, extracted from the workarounds: attribute
  passthrough (deletes axdom), configurable/removable session TTL, non-shared shutdown
  (deletes the one-run-per-Mac lease), window-scoped video, a headless/fleet consent path
  for driver-owned profiles, configurable semantic_v2 node budget. How that list is
  received is itself a signal worth having early.
- **Contract tests, not prose matching.** Anything that must parse driver output gets a
  pinned-version test (the dispatch tests are the pattern); no new regexes over error
  strings.

## 5. Recommendation for the real implementation

**Build the harness, not the driver — and lift it, don't rewrite it.** The agent loop,
verification stack, grounding pipeline, journal/teardown, and run-log discipline are the
proven 80% and are actuator-agnostic. Port them essentially as-is behind the existing
Observation/ActionRequest seam, which has already hosted two backends.

**Backends by target class, in this order:**
1. **CDP/Playwright backend first** — it covers the in-scope majority (customer web +
   Electron), uses tooling the team can hire for and Google/Microsoft maintain, has no
   consent gate on first-party machines, has no shared daemon (lifting the one-run-per-Mac
   cap on the machines auth forces us to keep), and pairs naturally with the persistent
   browser profiles that carry customer sign-ins between runs.
2. **Keep the cua backend as the bridge**, lifted verbatim from the trial repo, so there's
   a working end-to-end path from day one while the CDP backend matures — and as the
   fallback for customer Electron apps that block debugging flags. Strangle, don't
   big-bang. Its 184-line boundary is what makes this free.
3. **Thin Swift sidecar** (OS keys, SCK one-shot capture, native-chrome AX) — needed on
   the Mac fleet regardless; every primitive was probe-verified from unsigned Swift
   during the audit. Scope depends on the capture-aesthetics answer.
4. **Native-Mac-app support only if the product grows that segment** — and then decide
   fork-cua vs build, with the source-availability answer in hand. Until then it's YAGNI.

**Treat sign-in as a product surface, not an ops chore.** Authentication is why the fleet
is persistent Macs rather than ephemeral compute, so the signin flow (`./run signin` is
the prototype), session health-checking (the `home`-state probe), and the
no-credentials-in-the-loop rule are load-bearing product components. The trial's versions
are sketches of the right shape: human signs in once per app per machine, the machine
holds the session, the agent never sees a credential.

**And carry the process learnings as policy, not memory:** goal-only prompts audited in
code; grounding artifacts with provenance stamps; run logs written only by the harness;
verification holes closed structurally rather than by vigilance. The trial's most
expensive lessons were all of the form "a rule enforced by memory was violated within a
day" — the real implementation should start where that ended.

**Procedure compilation is the production lever either actuator must serve.** Grounding-time
thinking → deterministic replay with the model as exception handler is the cost/throughput
story for a fleet (and cua even ships an unused `replay_trajectory`). Whatever backend is
chosen, recorded actions must be replayable without a model in the loop; CDP makes this
trivial.

The one-sentence version for the team: **the trial's value is the harness, the
measurement discipline, and the auth-shaped deployment model — not the actuator; cua was
the right rental for a three-week trial and is the wrong foundation for a product whose
targets are customers' web and Electron apps on persistent, session-holding Macs — keep
it only as the bridge backend, the blocked-CDP fallback, and the candidate for a
native-Mac segment that doesn't exist yet.**

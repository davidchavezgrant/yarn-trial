# Yarn Onsite Plan — Self-Driving Demo Prototype

**Dates:** Wed Jul 29 – Thu Jul 30, 2026, in person (Soho NYC)
**Role context:** Work trial for Founding Engineer ($170–225K, 0.75–1.25%)
**Deliverable:** One clean, recorded end-to-end sequence — natural-language request → agent performs the UI actions in a Mac app. Reliability over speed; 30 min per task is acceptable.

---

## 1. Why this feature exists (company context)

Yarn (YC W24, Jasper Story CEO / Nicole Atack CTO, ~6–12 people, backed by YC + General Catalyst + Leonis) is "the all-in-one for GTM video" — priced upmarket ($1,240+/mo) as an agency replacement. Their current positioning is literally **"Agents for GTM video"**: the product already has Auto Time (LLM-edited demos), LLM-written talk tracks, and a personalization API.

The autonomy ladder: today a human records demo footage and Yarn polishes it. The redaction take-home = *clean* the footage. Self-driving demos = *author* the footage. If an agent can perform the demo while Yarn records in 5K with their cursor/zoom polish, the customer never touches a mouse — they type "show how to change the timezone to Paris" and get a finished branded video. Nothing about this is public; it's unannounced roadmap.

Useful onsite trivia: rendering core is deliberately WebGL ("maximize the visual ceiling"); docs internally call the product "Hypersphere" (likely codename); customers cited: DriverAI, Replo, Forge.

**Framing to volunteer in roadmap conversations:** the demo agent's output is itself Yarn input — the recorded run feeds straight into their existing editing/polish pipeline, and their 5K recorder already captures the screen. The agent is the missing top of their stack, not a side feature.

## 2. Recommended architecture

**Cua Driver as the hands and eyes; a thin Claude agent loop as the brain; verification and app-grounding as the differentiating reliability layer.**

```
NL request ("change timezone to Paris")
   │
   ▼
Planner/agent loop (Claude, computer-use)        ← the part you own
   │  reads: app knowledge base (UI map + skills)
   ▼
Cua Driver (MCP tools over stdio)                ← off the shelf, MIT
   • SOM mode: AX tree + screenshot, element-indexed
   • click / type_text / screenshot / get_window_state …
   ▼
Target app (Electron or native)
   │
   ▼
Verification loop: expected outcome declared before acting →
AX re-read → screenshot diff tiebreak → retry with fallback modality
```

### Why Cua Driver (their own hunch, confirmed)
- Open-sourced ~April 2026 (MIT). **First-class host-macOS control** — no VM. Exposes automation as MCP tools; first-party tutorials for driving it from Claude Agent SDK / Claude Code.
- Default perception is exactly right: **accessibility tree + screenshot combined (Set-of-Marks)** — the model picks element IDs, not raw pixels.
- **Electron is a documented strength**: SkyLight per-process event posting (no focus stealing), AX trees kept live on occluded Electron windows, Slack/VS Code/Discord reported working.
- Caveats: TCC grants must attach to the signed CuaDriver.app bundle (or embedded-daemon mode inheriting Yarn's grants — there's a formal embedding contract, which is the eventual production path for Yarn's app); API churn is real — **pin versions**; Chromium coerces synthetic right-clicks on web content; canvas/GPU surfaces need brief foreground activation.
- Fallbacks if Cua disappoints on-site: hand-rolled thin layer (pyobjc `ApplicationServices` + `macapptree` for tree dumps + CGEvent clicks) or macOS-use (browser-use org — earlier-stage, AX-first, no background mode).

### Why the reliability loop is where you differentiate
The Cua team's own framing: the driver doesn't fix brittleness — that's the agent loop. SOTA general agents hit ~30–50% on OSWorld (Agent S3 ~62–70%). One clean sequence in two days means engineering *against* brittleness:

1. **Expectation-before-action** (VeriGUI pattern): declare the expected post-state, act, then check — never trust "the model says it clicked."
2. **Cheap AX verification first**: re-read `kAXValueAttribute` / diff tree snapshots; screenshot diff only as tiebreaker. (Stretch: `AXObserver` notifications make this event-driven — no surveyed agent does this; nice talking point.)
3. **Modality ladder on failure**: AXPress → CGEvent click at AX-frame center → keyboard navigation. Web content inside Electron often ignores AXPress.
4. **Abort discipline**: max ~3 consecutive failures → re-plan from a fresh observation rather than flailing.
5. **Require evidence before declaring success** — screenshot of the achieved end state.

### The 24-hour grounding phase (their "setup time" budget)
Strong prior art, no one has shipped it for macOS desktop — genuinely open lane:
- **AppAgent** (closest match): exploration phase → per-element docs of observed effects → deployment phase consults them.
- **SkillWeaver**: propose → practice (~160 iterations) → distill into tested, reusable parameterized skills.
- **Agent S2**: narrative + episodic memory retrieved during planning.
- **Anthropic "Saved Workflows"**: record demonstrations, replay with adaptation to UI drift.

Prototype version (Day 2, timeboxed): an explorer that crawls the target app breadth-first — open every menu, visit every screen, snapshot AX tree + screenshot per state — and distills a **UI map** (states as nodes, actions as edges, elements addressed by AX path: role + title + hierarchy, never coordinates). The task agent gets the map in context: "Timezone lives under Settings → Date & time." Even a 30-minute crawl materially improves task success and *demonstrates the 24-hour concept*.

### Model guidance (Anthropic official, current tool generation)
- Pre-downscale screenshots yourself (~1280×720 baseline; 1080p on Opus 4.7) — oversized images get silently server-downscaled and corrupt coordinate mapping. Highest-impact accuracy fix.
- Text before image in message content. Medium/high thinking effort (max buys nothing for UI work).
- Rolling screenshot buffer (~3 recent full-res, older become text placeholders); zoom/crop for small targets, prefer keyboard nav over tiny clicks.
- Record full trajectory (JSONL + JPEGs) — doubles as debugging and as the demo artifact.

## 3. Key pitfalls checklist (tape to monitor)

1. **Electron AX tree is lazy**: set `AXManualAccessibility` on attach; on Electron <23 the call *lies* (returns error but works) — verify by re-reading the tree. Non-Electron Chromium: `AXEnhancedUserInterface`, unset after (breaks window managers).
2. Only ~33% of macOS apps have complete AX trees (Screen2AX) — keep the vision path alive; expect 10k-node trees with unlabeled `AXGroup`s in Electron.
3. Raise `AXUIElementSetMessagingTimeout`; retry `kAXErrorCannotComplete`; never cache `AXUIElementRef`s across UI changes — re-query.
4. Coordinates: AX frames and CGEvent are in **points**, screenshots in Retina **pixels**. Scale once, in one place.
5. Check `IsSecureEventInputEnabled()` before typing; workaround is AX value-setting, not keystrokes.
6. Activate app + raise window before synthetic input; verify via `frontmostApplication` (macOS 14 cooperative activation is flaky).
7. Tag synthetic events via `eventSourceUserData` → human can always yank control (good safety talking point).
8. Pin `cua-driver` versions on day 1; releases ship near-daily.

## 4. Decisions to settle Wednesday morning (15 min with founders)

1. **Target app** — Notion Calendar (their example) is a good pick: Electron, free, meaningful settings flows. Confirm, and confirm the exact demo task.
2. **Runs on**: my machine or a Yarn machine? (TCC permissions need setup either way — do this immediately, grants are the slowest dependency.)
3. **API keys**: Anthropic key preferred for the computer-use tool generation (OpenRouter fallback from take-home). Budget for a possible OmniParser/grounding-model path.
4. **Where code lives**: standalone prototype repo vs branch in their monorepo.
5. **Definition of done**: recorded clean sequence + short writeup? Presentation Thursday EOD?
6. **Recording**: their 5K recorder capturing the agent run would be the poetic move — ask if feasible, else QuickTime.

## 5. Pre-trial prep (Mon/Tue, on my Mac) — ~half a day

Goal: arrive Wednesday having already made every environment mistake once.

1. Install CuaDriver.app (one-line installer), grant Accessibility + Screen Recording to the bundle, run `cua-driver permissions status`. Pin the version.
2. Run the "Drive your first app" tutorial; wire `cua-driver mcp-config --client claude` into Claude Code and drive **Linear.app** (Electron — closest analog to their target) with a plain-English task.
3. Install Notion Calendar; verify its AX tree exposes settings (macapptree dump); note tree depth/labeling quality.
4. Skeleton repo: Python (uv) harness — Claude Agent SDK + cua-driver MCP + trajectory logging (JSONL + screenshots) + the verification loop stubbed. Bring it on a branch.
5. Skim Cua's "Inside macOS Window Internals" blog post (talking-point gold with a CTO who's a former particle physicist).
6. Before Wednesday: reply to their email — sign contractor doc, get repo access, ask for an Anthropic API key ahead of time, confirm target app preference.

## 6. Onsite shape

### Wednesday — walking skeleton first, no grounding yet
- **AM**: onboarding, repo walkthrough, roadmap conversation. Settle §4 decisions. Get TCC permissions granted on whatever machine runs the demo (start this immediately — it gates everything).
- **Midday**: primitives proven in isolation on the target app: attach → set `AXManualAccessibility` → dump tree → click a real button → type into a real field → screenshot.
- **PM**: end-to-end loop on a *trivial* task ("open settings") — agent, verification, trajectory logging all engaged. A boring task that works beats an impressive task that doesn't. EOD: skeleton demo runs; share a trajectory replay with the team.

### Thursday — grounding + the money shot
- **AM**: explorer crawl of the target app (timeboxed ~2h) → UI map artifact. Feed map to the agent; run the real task ("change timezone to Paris"). Iterate on failures via trajectory replays — fix the loop, not the run.
- **PM**: harden the one sequence (2–3 clean repetitions), then **record the clean take**. Reserve the last 90 min for: writeup (architecture, what's real vs. mocked, path to production — embedded Cua daemon inside Yarn's app so TCC rides on their signature; 24h grounding as a background service; skill library per customer app), and demo to the team.
- **Stretch goals if ahead**: AXObserver event-driven verification; second app to show generality; skill distillation (save the successful trajectory as a replayable parameterized skill — directly echoes Anthropic's Saved Workflows).

### Scope discipline
- Do NOT build the grounding crawler before the end-to-end skeleton works.
- Do NOT chase multi-app generality Wednesday; one app, one task, verified.
- If Cua Driver fights back >90 min on environment/TCC issues, drop to the hand-rolled pyobjc + macapptree + CGEvent path — the architecture survives the swap; only the actuator changes.

## 7. Risks

| Risk | Mitigation |
|---|---|
| TCC permission hell on an unfamiliar machine | Start grants first thing Wed AM; know the bundle-attribution rule cold |
| Target app's AX tree is garbage | Vision/SOM path; Screen2AX-style pseudo-tree is the escalation; pick task reachable via keyboard nav as plan C |
| Cua API churn / breakage | Versions pinned Monday; hand-rolled fallback rehearsed |
| Model flails mid-sequence (30–50% SOTA reality) | Verification loop + UI map + retry ladder; pick a task with few steps and unambiguous UI states |
| Demo-day nerves / one-shot failure | Record Thursday midday, not 5pm; keep the best trajectory replay as backup evidence |

## 8. Sources

Full research reports (company, Cua, macOS techniques) with source registries live in the session transcripts; key primary sources: trycua/cua repo + cua-driver README + "Inside macOS Window Internals"; Anthropic computer-use best-practices guide + quickstart; Electron accessibility docs + issue #37465/PR #38102; Screen2AX (arXiv 2507.16704); AppAgent / SkillWeaver / Voyager / Agent S2 papers; MacOS-Use repo; Multi.app remote-control engine post; yarn.so + YC profile + docs.yarn.so.

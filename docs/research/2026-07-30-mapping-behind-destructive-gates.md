# Mapping the workflows hidden behind the destructive-action gate

*2026-07-30 — research/design note. Question posed by David: the agent is told never to
take destructive or irreversible actions, but what if real flows live **behind** those
actions? Can we discover and map them? Reframe every affordance by the risk of the action
needed to observe it.*

---

## TL;DR

The current guard treats "destructive" as a single binary and **refuses the press**, so
every surface reachable only *through* a destructive-looking control is a permanent hole in
the map. On the committed Yarn appmap that is **350 of 396 seen controls dismissed, not
actuated** — the frontier reads "empty" because dismissal empties it, not because the app
was covered.

The fix is not to cross dangerous lines. It is to notice that **"destructive" is two
different gates fused into one regex**, and that a destructive *feature* exposes several
affordances at very different observation costs:

1. **Reversibility gate** — refused because the change can't be cleanly undone (setting
   writes, document mutations). These are *recoverable in principle*, and we already built
   the machinery to recover them (journal + teardown + scratch/claim). The task agent crosses
   these every run. The **explore** pass refuses them anyway, because it has no teardown.
2. **Externality gate** — refused because the action commits something *outside the machine*
   (send, publish, share, purchase, OAuth authorize, account change). These are genuinely
   one-way and must stay gated.

The central structural fact that unlocks everything: **a well-formed destructive action is
two-phase.** Pressing "Delete" opens a confirmation dialog; only pressing "Confirm" commits.
The first press is not destructive — it is the single richest observation in the app (it
enumerates consequences, sub-options, and hidden branches). The current guard refuses the
*first* press because its label matches the regex, so we refuse to open the very dialog that
would tell us what the flow does.

**Proposal:** an opt-in, grounding-time **safe-descent** capability that (a) splits the guard
into `externalityTarget()` (hard refuse) and `reversibleTarget()` (allow-with-restore),
(b) advances each gated flow to — but never through — its point of no return, on **scratch**
content wherever scratch is possible, (c) reads and records the boundary surface, then
Escapes, and (d) writes a `gated` annotation into the appmap saying what was seen at the
boundary and why the run stopped. This is the systematic, on-scratch, recorded generalization
of the carve-out the task agent already performs once per delete task.

---

## 1. What the gate is, mechanically

Two separate implementations, both keyed off one regex.

**Explore (hard refuse).** `src/explore.ts:692` calls `destructiveTarget(action, obs, web)`
before every action; a match is refused, counted in `refusals`, and handed back as a tool
error telling the model to "record what the control appears to do and dismiss it." The action
never runs. Governed by `EXPLORE_GUARD` (default on).

**Agent (prompt-only boundary).** `src/agent.ts:107` — "go as far as the final confirmation
step WITHOUT confirming, then call done." There is no code guard on the task agent; the
carve-out lives entirely in the system prompt. Verified once ("show me how to delete a
draft" opened the menu showing Delete and never clicked it; 12 drafts before, 12 after).

**The regex** (`harness.ts:1079`, `:1094` for web):

```
delete|remove|discard|erase|trash|clear|publish|export|download|send|share|
invite|buy|purchase|subscribe|unsubscribe|sign out|log out|revoke|deactivate|
reset|restore|merge|archive  (+ web: confirm|submit|post|reply|accept|...|checkout|pay;
                              − web: export, download — local side effects, not external)
```

Only **pressing** is guarded (`click|double_click|right_click`, plus web-`Enter`-on-a-named
control). The header comment already flags the hole: an unnamed `Enter` in a form still
submits. And crucially, the guard is **label-only and press-only** — it cannot tell "the
press that *opens* a delete dialog" from "the press that *commits* it," because both controls
say "Delete." It refuses both.

---

## 2. What is actually hidden today (measured, not asserted)

From the committed Yarn map (`docs/appmaps/yarn.json` coverage block, and `yarn.md`):

- **`controls: 47 actuated / 350 dismissed / 396 seen`.** 88% of seen controls were declined.
  The stop reason is `frontier-empty`, but the frontier emptied by *dismissal*, not coverage.
- **Export panel** — literally unmapped: *"Export is refused by the harness (destructive-verb
  list)."* We have no idea what options the export flow offers (format? includes background
  audio? scope?).
- **Publish panel** — unmapped, *"deliberately not opened (externally visible)."*
- **Brand options** (Rename / Duplicate / New / Archive Brand) — *"menu contents were captured
  by opening the menu only."* The dialogs those items open — the actual rename form, the
  archive confirmation and whatever it warns about — are dark.
- **Delete confirmations everywhere** — Delete Scene, Delete draft, Delete project, Delete
  Brand. The map records the *menu item* exists; it has never seen a single confirmation
  dialog. (A strings probe of the renderer bundle for "cannot be undone" / "are you sure"
  returned **0** — the warning copy is composed at runtime, so the dialogs are invisible to
  static analysis too. The only way to see them is to open them.)
- **OAuth integrations** (Figma / Google Slides / Notion MCP / YouTube / Screen Studio) —
  dismissed as "reach external services." What the connect flow *asks for* is unmapped.
- **Agent model / effort popups** — dismissed because *selecting* mutates the account-wide
  default. The option *lists* were recorded by opening the popup; the effect of choosing was
  not exercised.
- **Paint-type switches, voice picker, Remix Music, overlay insert** — dismissed as document
  mutations "I could not cleanly revert."

**The dismissal reasons are already a worklist.** `coverage.dismissals` is a deduped list of
honest prose reasons for every declined control. It is exactly the index of "flows behind the
gate," produced for free by the current pass. Any descent capability should consume it as its
input queue.

---

## 3. The reframing: observation risk is a gradient, and it attaches to the *action*, not the affordance

David's phrasing — "think of every affordance by the risk of the action needed to observe it"
— is the whole insight. The risk is a property of **the press that reveals the surface**, not
of the surface itself.

A "Delete draft" feature is not one affordance. It is a chain:

| Affordance | Action to observe it | Risk of that action |
|---|---|---|
| The `…` menu item labelled "Delete" | click the `…` | ~zero (opens a menu) |
| The confirmation dialog + its warning copy + its sub-options | click "Delete" (menu item) | **~zero** — it opens a modal, commits nothing |
| Any second branch in the dialog ("Delete just this / Delete all") | read the dialog | zero (reading) |
| The committed deletion | click "Confirm / Delete permanently" | **maximal — one-way** |

The current guard refuses at row 2 because the *label* says "Delete," and so rows 2–3 — which
are free to observe — are lost along with row 4, which must be. **We are paying maximal
caution to observe near-zero-risk surfaces.**

This generalizes into a tiered model of observation cost.

---

## 4. The affordance risk taxonomy

Order affordances by the risk of the action needed to *reach and read* them. Each tier is a
strictly larger blast radius; the map should record every affordance at **the highest tier it
can safely reach**, and say where it stopped.

- **Tier 0 — Inspect (no state change).** Open panels, menus, tabs, pickers; read labels and
  values. *Already the whole of what explore does today.* Risk: none.

- **Tier 1 — Open-the-gate (transient, self-dismissing).** Press a destructive-labelled
  control whose only immediate effect is to **surface a confirmation dialog**. Commits
  nothing; Escape/Cancel restores. This is where the delete/archive/publish *dialogs* live —
  the richest single map source in most apps — and it is currently refused wholesale.
  Risk: near-zero *if* the two-phase assumption holds (see §6 for when it doesn't).

- **Tier 2 — Reversible mutation (self-healing).** Actually change a setting or value, observe
  the downstream surface it unlocks, then write it back. The task agent does this every run;
  `journal.ts` + `teardown.ts` make it safe. Explore refuses it only because explore has no
  teardown. Risk: bounded — recoverable by construction.

- **Tier 3 — Reversible-by-creation (scratch).** Create a throwaway object (`claim`), then
  descend *its* destructive menus — Delete Scene on a scratch scene, Delete on a scratch
  draft — including through the confirm, because the thing destroyed was ours. Risk: contained
  to scratch; the agent has `claim`, explore does not.

- **Tier 4 — Externality-committing (one-way, off-machine).** Send, publish, share, purchase,
  OAuth-authorize, account change. **Never cross.** But you can still map the *shape* of what's
  behind it by reading the Tier-1 boundary surface (the OAuth consent screen's requested
  scopes; the publish dialog's visibility options) and backing out.

The key move: **most destructive features can be mapped at Tier 1 or Tier 3 without ever
touching Tier 4.** The current pass collapses all of them to "refuse."

---

## 5. Two gates, not one

The single regex must become two questions, because they have opposite answers.

**`reversibleTarget()` — can we undo this?** delete/discard/reset/archive/merge on *our own
scratch content*, setting toggles, value changes. Answer: descend, then reverse (Tier 2/3).
The reversal authority already exists — `detectMutation()` journals the change, `runTeardown()`
replays it backward, and `destructiveTarget()` guards the restore path so teardown never
presses a destructive verb. Safe-descent is the **mirror image** of teardown: teardown reverses
a mutation the task made; descent makes a mutation on scratch, reads the flow, and reverses it.
They can share the journal, so a crash mid-descent is recoverable by the existing
`npm run cleanup`.

**`externalityTarget()` — does this commit off-machine?** send/publish/share/invite/purchase/
OAuth/account. Answer: **hard refuse the commit**, always, in code, unattended or not. This is
the real safety boundary and it should be *stricter* than today's regex, not looser — because
once reversibility is handled separately, the externality guard no longer has to be blunt to be
safe.

Detecting externality by label alone is weak (a plain "Save" can sync to a server; "OK" can
send). So the externality guard needs an **observation backstop**, not just a regex:

- a **new window/browser surface** appears whose `AXWebArea` URL is an external provider
  (`accounts.google.com`, `figma.com/oauth`) → OAuth flow, abort + flag;
- a **native file/share sheet** opens (export-to-disk, share-to) → externality, abort + flag;
- the AX tree gains a **"cannot be undone" / "will be sent to" / "publicly visible"** string →
  treat as Tier 4 boundary, read and Escape.

These are observable *at the Tier-1 boundary*, which is exactly why opening the dialog (Tier 1)
is the enabling step: the dialog announces its own tier. You can only classify the gate
correctly by opening it one notch.

---

## 6. Knowing when to stop — the point-of-no-return problem

The two-phase assumption ("open ≠ commit") is what makes Tier 1 safe, and it is not universal.
Three honest failure modes and the rule that survives them:

1. **Single-press destroyers.** A bare "×" that deletes immediately, a toggle that syncs on
   change, `Enter` in a form (the documented existing hole). Here opening *is* committing.
2. **Innocuously-labelled commits.** The confirm button says "OK" or "Done," which no regex
   catches.
3. **Externality behind a reversible label.** "Save" triggers a server sync.

The rule that holds against all three: **inside a modal reached via a destructive gate, press
no button — only read and Escape.** Escape is always safe (teardown already relies on this).
You give up mapping *multi-step* destructive wizards (page 2 of 3) at Tier 1 — that needs Tier 3
scratch — but you gain a guarantee that Tier 1 never commits. And do Tier-1 descent **on
scratch wherever scratch exists**, so that if the two-phase assumption is *wrong* for this
control and the single press commits, the damage is confined to a throwaway object.

Concretely, the stop condition is: *the action produced a modal/sheet (AX tree gained a
dialog role or "cannot be undone"-class copy) → success, this was Tier 1, record and Escape.
The action did NOT produce a modal → it may have committed; treat as a mistake, and if it
wasn't on scratch, flag the run dirty for cleanup.*

---

## 7. Recording it: the `gated` annotation

Descent is worthless if the findings don't land in the map. Add to `AppMapNode` (or a parallel
`gated[]` block) a record of the boundary:

```
{ id: "project/delete", settingKey: "delete-project", tierReached: 1,
  boundary: "confirm dialog: 'Delete this project? This cannot be undone.'
             options: [Cancel, Delete]. No sub-branches.",
  stoppedBecause: "externality:one-way-delete",
  scratchUsed: true }
```

This does three things the current map cannot: it distinguishes *"not in this app"* from
*"gated, and here's what's behind it"* (the exact ambiguity `frontier-empty` hides); it gives
the task agent real grounding for a delete/export/publish task instead of a dead end; and it
makes the safety boundary **auditable** — you can see every place the pass stopped and why,
the same way `dismissals` is auditable now.

---

## 8. Static complement: mine the renderer bundle for the worklist

Secondary, cheaper, lower-yield. Yarn ships as an Electron webpack bundle
(`/Applications/Yarn.app/Contents/Resources/app.asar`, `.webpack/renderer/main_window/`). It
is minified but `asar list` and `strings` work read-only. You can mine it for **modal/route
component names and reachable action identifiers** to build the list of destructive flows that
*exist* before driving to them — turning descent from open-ended sweeping into a checklist.

Honest caveat from a quick probe today: grepping the bundle for confirmation copy
("cannot be undone", "are you sure", "permanently delete") returned **zero** hits — the copy is
composed at runtime from templates/i18n, so static mining gives you *that a delete flow exists*
(component/handler names) but **not** what its dialog says. The dialog text is only observable
dynamically, via Tier-1 descent. So static mining is a worklist generator, not a substitute for
driving.

---

## 9. Fit with the measurement rule (non-negotiable)

This must stay on the right side of the rule David set: *never give the model information it
would not have in a real test case; task prompts state the goal only.*

Safe-descent is an **exploration-time capability**, not a task-time one. Its output is the
appmap (`docs/appmaps/` — a declared, budgeted input), and the task agent still receives
goal-only prompts and still gets its scope warnings from the graph. Descent widens what the
grounding pass can see; it does not hand the task agent a recipe. The provenance split is
preserved: stamped explore output only, no hand-editing. And it is opt-in
(`EXPLORE_DESCENT=on`, off by default) precisely because it spends grounding budget and touches
live workspace state — the 24h/app budget makes that spend cheap, but it should be a declared
choice, logged in the stamp like `guard` and `dismiss-cap` are.

It also should **not** change how a run is *scored*: like the visual judge and cleanup, boundary
findings are grounding/advisory, never a gate on task success.

---

## 10. Failure modes & honest limits

- **Scratch isn't always possible.** Some destructive flows only exist on real content — archive
  *the* Default Brand, delete *the* only workspace, disconnect *the* live integration. You
  cannot cheaply mint a scratch brand. For these, Tier-1 boundary-reading (open, read, Escape)
  is the ceiling, and the map must say so rather than imply full coverage. This is already what
  the Yarn map did for Brand options — the proposal makes it systematic and recorded, not the
  accidental result of a refusal.
- **Two-phase assumption breaks** (§6). Mitigated by scratch-first + read-and-Escape, not
  eliminated. A single-press destroyer on non-scratch real content is the one case that can
  still bite; the externality guard should keep the hardest of those (send/publish/purchase)
  refused even on the *opening* press.
- **Budget and blast radius.** Descent is more intrusive than today's pass; it belongs behind an
  env flag, scratch-first, sharing the journal so a crash is recoverable by `npm run cleanup`.
- **n=1 everywhere.** Same caveat as all grounding numbers so far — the 350/396 figure is one
  map of one app on one day; re-measure after any change, per the standing rule.

---

## 11. Smallest viable experiment

1. Split `destructiveTarget()` → `externalityTarget()` (hard, code, always) +
   `reversibleTarget()` (advisory, descent-eligible). No behaviour change yet — both still refuse
   when `EXPLORE_DESCENT` is off, so existing runs are identical.
2. Give explore the `claim` tool it lacks and a `descend` intent: on a `reversibleTarget` hit,
   create scratch if the flow needs an object, press the opening control, assert a modal
   appeared, record the boundary, Escape. Journal every mutation so cleanup can finish.
3. Add the `gated`/`tierReached`/`boundary` fields to the map and surface a count in the stamp
   (`gated: N read / M refused`).
4. Run it once against Yarn with `EXPLORE_DESCENT=on` on a scratch project. Success = the Export
   and Publish dialogs, and at least one Delete confirmation, are **read and recorded** with the
   app left byte-for-byte as found (verified by cleanup reporting clean). Compare the new
   `actuated`/`gated` split against today's `47 actuated / 350 dismissed`.

The win to look for: the map stops saying "Export: refused, unmapped" and starts saying
"Export: dialog offers {formats, scope, includes-audio}; stopped at the render button
(externality:writes-file)." That is the difference between a hole and a boundary.

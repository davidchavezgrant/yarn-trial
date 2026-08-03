# Notion Calendar: "Change timezone to Paris" — verified action sequence

First end-to-end run of the target demo example (2026-07-27), driven manually through
`src/driver.ts` (cua-driver, in-process, window-scoped tools). Both directions verified:
EDT → Paris (GMT+2) and back to New York (EDT).

## The working sequence

1. **`right_click` the timezone gutter label** (AXStaticText "EDT" / "GMT+2", top-left of
   the time column). The element advertises `AXShowMenu`, not `AXPress` — right_click routes
   to AXShowMenu and opens the context menu. Settings (Cmd+,) is a dead end: it says
   "Configure your time zones directly on the grid."
2. **`click` the "Change time zone" menu item** → opens the timezone picker popover with a
   search field pre-filled with the current city (e.g. "New York").
3. **`click` the search field to focus it**, then `press_key` Cmd+A, then `type_text` the
   city ("Paris"). The field is pre-filled — typing without select-all appends
   ("New YorkParis") and matches nothing.
4. **`click` the result row** (AXStaticText matching the city name).
5. **Verify**: the gutter label changes (EDT → GMT+2), today's highlight and the
   current-time line shift to the new timezone.

## Driver/app quirks learned (feed these into the agent design)

- **AXPress warnings are unreliable in both directions.** Web-content elements report
  "does not advertise AXPress; may have been a no-op" yet often work (menu items, result
  rows). But sometimes it genuinely no-ops — and then subsequent keystrokes land on the
  wrong surface. A stray "P" hit Notion Calendar's global "show teammate calendar"
  shortcut and opened an unrelated overlay. **Every step must be verified by
  re-observation before the next step fires.**
- **Popovers survive across driver sessions** and window-scoped Escape doesn't always
  close them. Recovery: escape (foreground) repeatedly, re-snapshot, confirm no stray
  AXTextField overlays remain.
- **Element indices/tokens are per-snapshot.** Resolve elements by role + label/value
  substring against a fresh `get_window_state` immediately before each action.
- **Menu shortcuts need `delivery_mode: "foreground"`** (Cmd+, only dispatches via the
  NSMenu path; it fronts the app <1s and restores focus). Plain menu-item AXPress from the
  background fails with -25202.
- **`type_text` is always unverified** ("sent via CGEvent") — confirm by re-reading the
  field's AX value in the next snapshot, which does reflect typed text.
- **Electron AX tree**: the calendar window exposes a rich tree (~650–750 elements) once
  logged in; window pick must skip placeholder windows (untitled, 500×500) — prefer
  titled + largest.

## Artifacts

- Screenshots: `out/state-*.png` (state-14-selected.png = Paris applied; state-8-tzpicker.png = picker open).
- Step-driver tool promoted to `src/step.mts` (snapshot → resolve-by-label → act → verify loop).

## Update (same day): autonomous agent runs the sequence

`src/agent.ts` (Claude Opus 5 via `@anthropic-ai/sdk`, OpenRouter-compatible) now performs
this task autonomously: observe (AX elements + screenshot) → model picks one action + an
expectation via tool use → act → re-observe → verify → repeat, with StepRecords written to
`out/agent-run.json`. Both directions completed in 5 actions each:

- EDT → Paris: 4/5 steps harness-verified; on the last step the string check failed
  (expected "CEST") but the model correctly declared success from the observation (gutter
  showed GMT+2, dates/now-line shifted) — judgment over blind expectation matching.
- Paris → New York: 5/5 steps verified.

Both runs spent their first 2 actions exploring Settings before finding the grid path —
exactly the waste the brief's "24h grounding budget" (`AppMap` in `src/types.ts`) would
eliminate: a prior exploration pass would tell the agent the timezone lives on the grid.

## Update 2: grounding pass built and measured

`src/explore.ts` (`npm run explore -- "App Name"`) runs a model-driven exploration with a
step budget and safety rules (nothing destructive/externally visible; revert what you
touch), recording findings as it goes and emitting grounding notes to
`docs/appmaps/<app-slug>.md`. `src/agent.ts` auto-loads those notes into its system
prompt. Shared plumbing extracted to `src/harness.ts`.

Exploration run on Notion Calendar: 20 actions, 12 findings — full layout, task procedures,
and quirks we never found manually (⌘, doesn't open Settings through the driver;
background scroll unavailable; pressing "c" instantly creates+saves an event and escape
does NOT discard it — the explorer hit that trap and recovered by deleting via
Edit ▸ Delete, leaving the app clean).

Grounded vs ungrounded on the same task:

| Run | Actions | Dead ends | Verification |
|---|---|---|---|
| Paris, ungrounded | 5 | 2 (Settings detour) | 4/5 (model overrode last check on evidence) |
| Paris, grounded | 5 (1 was cleanup of a stale modal) | 0 | 5/5 |
| New York, grounded | 3 | 0 | 2/3 (1 missing-expectation flag) |

Harness fix from the runs: OpenRouter doesn't enforce tool schemas strictly, so a missing
`expectation` must be tolerated (flagged in the tool result, not crashed on).

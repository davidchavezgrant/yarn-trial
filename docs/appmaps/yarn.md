<!-- provenance: explore | app: Yarn | date: 2026-07-29 | backend: ax | actions: 15 | findings: 8 | finds: 0 | operator-guidance: yes | salvaged: session died before finish -->
<!-- Written by src/explore.ts. DO NOT HAND-EDIT: edits make this a curated recipe, not exploration output — move such notes to docs/recipes/<app>.md instead. -->

## What Yarn is
Yarn is an Electron/web app for AI-assisted product-demo videos. The whole UI is one web area; almost everything lives inside it (no useful app menus — the "Yarn" menu bar has only About/Services/Hide/Quit, and there is **no Preferences / cmd+, window**).

## Layout

**Left rail (always present, x≈0–172 in screenshot pixels)**
- Workspace badge "David's Workspace" (top, ~(90,52)).
- "Library" (~(57,77)), "Your Drafts" (~(69,100)).
- Open-draft tabs, one per row (Untitled ×9, "YT Long …", "[Growth] …", **"AutoTime" ~(64,474)**, "UntitledProduct Lau…"), then "New draft".
- Bottom: "Invite Members" ~(80,810), **"Brand Kit" ~(63,833)**, "Settings" ~(61,856).
- Quirk: AXPress (element_index) on these rail rows often silently no-ops. A **pixel click** works; if a single pixel click doesn't take, a **double_click** does.

**Editor (opens when a draft tab is selected; the app launched on draft "AutoTime")**
- Left column: title field "AutoTime", tabs **Agent | Script**, "Select voice" popup, "Project actions" (ellipsis) popup, then the Script/transcript (ProseMirror text areas, scene headers "Intro" 02:49 / "Releases" 00:33, "Edit Cut" skip markers). Bottom-left: agent chat composer ("Composer actions" +, "Effort: High", "Send").
- Top bar right of centre: "Window" popup, "Add Zoom" button (becomes "Fixed | – Zoom + | ⇤ ⇥" controls when a zoom/clip is selected), stopwatch speed field ("1.00"), animation popup, sound-effects popup, **ellipsis popup (`.editor-topbar-btn--morePopover`, ~(1545,49)) → small popover with "Background / Add BG" and "Audio / Unmute"**.
- Far top-right status bar: paint picker, captions, music ("ES_A A Winter to Remember – Trevor Kowalski"), "Publish" (globe), "Export".
- Centre: **preview canvas** (drawn; see below).
- Below canvas: transport row — play button, **current-time readout (e.g. "01:10:81") and total ("03:22:20")**, insert-bar buttons (overlay slide, media clip, text slide, record talk track, new comment), "Library" popup, "Timeline Zoom" popup.
- Bottom: **timeline** (drawn; see below).

**Brand Kit** (left rail → "Brand Kit"): header "Default Brand  Brand Kit" + second-level tab list at x≈205–340: Brand Overview, Templates, Workflows, Colors, Type, **Screen Clips**, Motion, Layout, Misc. Remembers the last tab you were on. Visited: *Motion* (just a "Motion notes" markdown textarea, placeholder "Describe animation style, timing, easing preferences...") and *Screen Clips*.

**Brand Kit → Screen Clips = "Screen Clip Settings"** — brand-wide defaults, fully in the accessibility tree:
- Cursor: Auto-Hide Cursor [Auto Hide | Off], Text Cursor [Hide | Show], Cursor Style combobox ("Arrow-first"), Cursor Scale slider (1.60).
- Screen Display: Screen Window Padding slider (18.0), Shadow Opacity (72%), Shadow Blur (32), Shadow Spread (-18), Shadow X Offset text field (0), Shadow Y Offset text field (12).
- Sound Effects: Cursor Clicks checkbox + combobox "Extra Soft"; Keyboard Presses checkbox + combobox "Set B" (with audio-preview button) + "Extra Soft".
- Visual Effects: Entrance/Exit Animation popup ("Fade Up"), Motion Blur [Off|Low|Medium|High] (Medium), Default Zoom Type [Glide|Fixed] (Glide, "Glide follows the cursor, fixed is static."), Default Zoom Level slider (54%).

**Per-project "Screen Recording Settings" popover** (was open at app launch, anchored top-right of the editor, screenshot bounds ≈x1232–1560, y45–725, "Done" button ≈(1507,707)). It has the *identical* control list as Brand Kit → Screen Clips but different values (e.g. Screen Window Padding **10.3** vs brand **18.0**), so the two are separate stores. **Its contents are NOT in the accessibility tree at all** — read it from the screenshot and click by pixel. I could not confirm which button reopens it (the topbar ellipsis opens only Background/Audio); most likely candidates not verified: the topbar animation/sound-effect popups or a clip-selected panel.

## Drawn (canvas-only) regions

1. **Preview canvas** — screenshot bounds ≈x543–1560, y82–655. Draws the composited video: purple background, a nested "Animal Switcher Draft" app window, tiger/monkey/elephant tiles, a "Save" button, burned-in caption text, and an inner mini-player with its own time readout ("00:05:87 / 00:28:84") and mini-timeline. Text that reflects its state: the transport readout below it (`01:10:81 / 03:22:20`) and the overlay label **"Previewing sync point"** (`.ag-editor-canvas-syncPointPreviewOverlay-label`, ≈(893,772) in AX-frame terms / drawn near canvas bottom). I did not manipulate the canvas itself.

2. **Timeline** — screenshot bounds ≈x543–1560, y710–880.
   - y≈727: time ruler, "Intro" scene label at left, tick labels 1:00 / 1:05 / 1:10 / 1:15; **playhead = thin vertical line with a small square handle on the ruler**.
   - y≈752: a thin search/scrub strip.
   - y≈805–835: purple screen-clip track ("Animals"), with **white sync-point dots** drawn along it.
   - y≈845–865: transcript/caption chunks ("monkey part of the script, …", "So now, we could just drag the sync point …", …).
   - **Input that works: press-drag on the ruler at the playhead.** Verified: drag (1167,727)→(900,727) moved the playhead and the readout changed 01:10:71 → 01:04:91; dragging back restored ≈01:10:81. Plain clicks elsewhere mostly just scrub/deselect.
   - **Verifiable in text: YES** — the transport current-time readout (element `.ag-editor-toolbar` static text, e.g. "01:10:81") is the readout for playhead position; total duration "03:22:20" sits beside it.
   - **Undo for scrubbing**: drag the playhead back (it is view state, not a document edit). For real clip edits use Edit ▸ Undo / cmd+Z.

3. **Timeline clip context menu** (drawn, not in AX tree): right-click the purple clip (e.g. pixel (800,818)) → menu with **"Add Skip… ⌘E", "Add Sync Point ⌘S", "Split clip ⇧⌘S", "Reset to original time", "Delete"**. Escape (foreground) closes it.

## How to

- **Open a draft / return to the editor**: pixel-click (or double-click) the draft name in the left rail, e.g. "AutoTime" at (64,474). Wait a beat — the editor renders blank for a moment while loading.
- **Change brand-wide screen-recording defaults** (cursor style, shadows, click sounds, zoom defaults): left rail → pixel-click "Brand Kit" (63,833) → pixel-click "Screen Clips" (264,205) → operate the real AX controls (buttons/comboboxes/sliders/text fields). Changes here do NOT retro-change an individual project's overrides.
- **Change the same settings for one project**: use the per-project "Screen Recording Settings" popover in the editor (pixel-only; "Done" at ≈(1507,707) closes it). Its values are independent of Brand Kit.
- **Scrub the timeline**: drag from the playhead square on the ruler (y≈727) to the target x; confirm via the "hh:mm:ss" readout at ≈(624,691).
- **Clip operations**: right-click the purple clip in the timeline, choose from the drawn menu; or use ⌘E (Add Skip), ⌘S (Add Sync Point), ⇧⌘S (Split clip) with the clip/playhead positioned.
- **Editor top-bar extras**: ellipsis at ≈(1545,49) → "Background / Add BG", "Audio / Unmute".

## Dead ends & quirks

- **Left-rail "Settings" does nothing** in this build: AXPress, single pixel click and double-click all left the page unchanged. There is no app Settings/Preferences screen and no cmd+, — all screen-recording defaults live in Brand Kit → Screen Clips.
- **No app-level Preferences window**; macOS menu bar offers only Reload/Force Reload/Dev Tools (View) and Close All (File). Edit ▸ Undo/Redo exist but were greyed out while focus was outside a text field.
- AXPress on `.globalLeftTabRail-tab` and `.brandStudioPage-sideMenu-tab` buttons is unreliable → use pixel clicks.
- The per-project Screen Recording Settings popover is invisible to accessibility; a single click on its "Cursor Style" value did not open a dropdown — expect to need precise pixel hits on the chevron, and drags for its sliders.
- The transcript panel exposes hundreds of per-word AXStaticText elements; ignore them and address the containing `.ag-editor-transcriptPanel-transcriptChunk-contents` text areas.
- The editor is *the* per-document surface; Brand Kit is the brand surface. Same setting names in both — always confirm which one the task means.

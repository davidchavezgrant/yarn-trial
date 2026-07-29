<!-- provenance: explore | app: Yarn | date: 2026-07-29 | backend: ax | actions: 10 | findings: 7 | finds: 0 | operator-guidance: yes -->
<!-- Written by src/explore.ts. DO NOT HAND-EDIT: edits make this a curated recipe, not exploration output — move such notes to docs/recipes/<app>.md instead. -->

## Layout

Yarn is an Electron/web app in ONE window (1920×1080 logical; screenshot ≈1568×881 — use screenshot pixels for coordinate actions). It boots straight into the **project editor** for the draft "AutoTime"; there is no separate document-open step.

**Left rail (always present, AX buttons):** workspace badge "David's Workspace", `Library`, `Your Drafts`, then a flat list of drafts (many `Untitled`, plus `AutoTime`, `UntitledProduct Launch Demo`, `YT Long …` etc.), `New draft`, and at the bottom `Invite Members`, `Brand Kit`, `Settings`. Clicking a draft name opens its editor; clicking `Brand Kit` replaces the editor with the brand page. Returning = click the draft name again.

**Editor surfaces (all in the same window):**
- **Script/Agent panel** (left, x≈195–520): title field "AutoTime", tabs `Agent` / `Script`, `Select voice` popup, `Project actions` (ellipses) popup, scene headers ("Intro" 02:49, "Releases" 00:33) with per-scene ellipses, `Camera` webcam blocks with `Webcam actions`, and the transcript as editable ProseMirror text (every sentence is its own `AXTextArea`). Bottom of this panel is the Agent composer (`editor-agentChat-input-editor`, `Composer actions`, `Effort: High`, `Send`).
- **Canvas / preview** (center, x≈545–1560, y≈84–655): fully DRAWN video frame (shows the recorded demo + burned-in caption text). Only AX child is the label `Previewing sync point` (`.ag-editor-canvas-syncPointPreviewOverlay-label`).
- **Top bar** (y≈49): `Window` popup, `Add Zoom` button, duration field `1.00`, animation popup (`.editor-topbar-btn--animation--screenVideo`), sound-effects popup, ellipses "more" popup. When a screen/zoom clip is SELECTED this bar swaps to zoom controls: `Fixed` popup, `−  Zoom  +`, instant-zoom start/end buttons.
- **Status bar** (top-right, y≈15): paint picker, captions button, music popup ("ES_A Winter to Remember – Trevor Kowalski"), `Publish`, `Export`.
- **Playback toolbar** (y≈691): play button, current-time readout (e.g. `01:10:66`), total `03:22:20`, insert buttons (overlay slide / media clip / text slide / record talk-track / new comment), `Library` popup, `Timeline Zoom` popup.
- **TIMELINE (drawn)** — see below.
- **Brand Kit page** (rail → `Brand Kit`): "Default Brand / Brand Kit" with sub-nav `Brand Overview, Templates, Workflows, Colors, Type, Screen Clips, Motion, Layout, Misc`. Opens on **Screen Clip Settings** (brand-wide defaults).

### The timeline (drawn region) — the important part
Bounds: screenshot x≈545–1560, y≈710–881 (below the canvas, right of the Script panel). It is essentially opaque to accessibility: its AX children are junk labels ("Fixed Zoom", "Overlay", "Edit Skip", transcript strings, ruler numbers) and most have 1-pixel frames at parked coordinates, so **you must read the timeline from the screenshot and act by pixel**.
Rows top→bottom:
- **Time ruler**, y≈727: scene name at left ("Intro"), tick labels ("55", "1:00", "1:05", "1:10" …).
- **Zoom lane**, y≈745–760: light "Fixed Zoom" clips with a magnifier glyph; a selected zoom clip is drawn blue (y≈783 band).
- Empty lanes (overlay/media) y≈765–800.
- **Screen-recording clip**, purple band y≈805–830, carrying small white dots = **sync points**; lighter blocks inside it are **Skip** segments (hover shows "Edit Skip" / "Adjust Skip start" / "Adjust Skip end").
- **Transcript chip row**, y≈851: one chip per spoken sentence ("So now, we could just drag the sync point to line it up w…").
- A vertical black **playhead** line spans all rows.

Readout / verification: the ONLY textual echo of a timeline position is the toolbar clock left of the timeline — `01:14:60` → `01:17:56` → `01:12:50` → `01:04:44` → `01:10:66` in this session, format mm:ss:ff, next to total `03:22:20`. There is **no numeric readout of a sync point's own time anywhere**, and selecting a clip produces no inspector text — only the top bar changing to zoom controls.

## How to
- **Scrub / set the playhead:** click anywhere in the timeline (ruler at y≈727 is safest). Verify via the toolbar clock text. Clicking a clip body also scrubs *and* selects.
- **Select a clip:** left-click it (e.g. purple band y≈817). Confirm by the top bar switching from `Add Zoom` to `Fixed` + `− Zoom +`.
- **Deselect:** click an empty timeline lane (e.g. x≈1450, y≈772). Escape does NOT deselect.
- **Clip context menu (drawn, not in AX):** right-click the purple clip. Items top→bottom at the click point: `Add Skip…  Cmd+E`, `Add Sync Point  Cmd+S`, `Split clip  Cmd+Shift+S`, `Reset to original time`, `Delete`. Read them off the screenshot and click by pixel; close with Escape (foreground).
- **Add a sync point:** park the playhead, then Cmd+S (or right-click → "Add Sync Point").
- **Move a sync point (re-time):** press-drag-release the dot horizontally, e.g. drag (1007,817) → (1070,817). Effect: the dot and every sync point/Skip to its right shift by the drag delta (re-timing pushes later content later). **Single clicks on a dot do nothing at all.**
- **Undo a timeline edit:** cmd+z with delivery_mode "foreground" (restores dot/Skip positions exactly; does not restore the playhead).
- **Edit script text:** click into the sentence `AXTextArea` in the Script panel (each sentence is a separate element) and type; editing the script desyncs the demo (that's what Auto-Time re-fixes).
- **Reach brand defaults:** rail → `Brand Kit` → sub-tab `Screen Clips` ("Screen Clip Settings"). Return to the editor via rail → `AutoTime`.

## Dead ends & quirks
- No app-level Preferences: the macOS menu bar has only Apple / Yarn (About, Services, Hide, Quit) / File (Close Window, Close All) / Edit (Undo, Redo, Cut/Copy/Paste, Substitutions, Speech, Writing Tools, AutoFill, Emoji) / View (Reload, Force Reload, Toggle Developer Tools, Actual Size, Zoom In/Out) / Window / Help. **cmd+, does nothing** — Settings is the in-app rail item.
- The timeline, the canvas and all popover/context menus are drawn: expect no AX elements. The AX tree also contains hundreds of duplicate 1-pixel-wide text nodes parked at frame x -1514/-269 — ignore them; they are off-screen/clipped content, not real controls.
- Frame coordinates printed beside elements are logical points offset by (-2181,+763); never feed them to click/drag. Screenshot pixels only.
- A click on a sync-point dot is a no-op; only press-drag-release manipulates it. A drag also scrubs the playhead to the release x.
- Escape closes the drawn context menu but leaves the clip selected (top bar stuck in zoom mode).
- Navigating away to Brand Kit and back preserves the editor state but re-centres the timeline scroll on the playhead, so pixel positions of clips/dots change between visits — re-read the screenshot before each pixel action.
- `Publish` and `Export` (status bar) are live outbound actions — do not press.

## Scope warning
Brand Kit → Screen Clips holds BRAND-WIDE defaults (Auto-Hide Cursor, Text Cursor, Cursor Style "Arrow-first", Cursor Scale 1.60, window padding/shadows, Sound Effects "Cursor Clicks: Extra Soft" / "Keyboard Presses: Set B / Extra Soft", Entrance/Exit Animation "Fade Up", Motion Blur Medium, Default Zoom Type Glide|Fixed, Default Zoom Level 54%). The editor top bar exposes the SAME settings for the current project/clip (animation popup — identical CSS class `.editor-topbar-btn--animation--screenVideo`, sound-effects popup, and the `Fixed` zoom-type popup on a selected clip). These are separate stores: changing the Brand Kit default will not alter this project's existing clip, and changing the clip will not alter the brand default. Pick the scope the task actually asks for.

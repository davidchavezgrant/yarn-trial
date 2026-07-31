# Yarn (Electron 38.2.0, v0.0.119) — grounding notes

From an exploration pass on 2026-07-29 (20 actions; the run's driver session was killed
before it could emit its own summary, so this is assembled from its recorded findings).
Yarn = Mac app for making product demo videos: screen recording + AI editing.

## Layout

- **Left rail** (always present): workspace popup ("David's Workspace") at top; **Library**,
  **Your Drafts**, **New draft**; created drafts appear here above "New draft"; bottom:
  **Invite Members**, **Brand Kit**, **Settings**.
- **Library** ("Your Library"): Search field, Grid/List toggle, unlabeled sort popup, blue
  **+ New Draft**. Body: "Collections" + "New Collection", then a grid of items. Each item's
  title is an inline-editable AXTextField; each has a per-item "…" popup (see quirks).
- **Brand Kit** (`Default Brand`): section list — Brand Overview, Templates, Workflows,
  Colors, Type, **Screen Clips**, Motion, Layout, Misc.
  - Most sections are a single notes textarea (Brand Overview, Motion, Misc).
  - Templates / Workflows are list pages with a blue **New Template** / **New Workflow**
    button; both empty in this workspace.
  - **Screen Clips = "Screen Clip Settings"**, the cursor/motion defaults page (below).
- **Settings**: a **modal dialog**, one scrollable page (not tabs).
  - Left: profile card (name/email), Edit profile photo, Sign out.
  - Right: **Preferences** — Auto-Add Screen Zooms (On|Off), Theme (Dark|Light|System,
    ⇧⌘\), **Agent model** popup (Opus 5), **Agent effort** popup (High), **Agent Fast Mode**
    default checkbox.
  - **Your Plan** (Free, credit counter, Upgrade), **Workspace settings** (name, icon,
    **Custom window sizes** list — the pre-recording window sizes, e.g. "Default 1440x897"),
    **Integrations** (Figma, Google Slides, Notion MCP, Team YouTube, Personal YouTube,
    Screen Studio Import), **Team Members** (Invite + role popups).
  - Everything below "Workspace settings" is off-screen until scrolled (AX frames collapse
    to 1px height).
- **Editor** (opened by creating a draft):
  - LEFT: draft title field + "Draft" badge; tabs **Agent** | **Script**; **Select voice**
    popup; **Project actions** (…) popup. Script tab = textarea "Type script or # for new
    scene". Bottom = AI composer ("Ask, edit, or make something…") with Composer actions (+),
    **Effort: High** popup, Send (disabled until text).
  - TOP-RIGHT: Open paint picker, an unlabeled button, **Add Music**, **Publish**, **Export**
    (disabled while empty).
  - CENTER: preview canvas. BELOW: play button, `00:00:00 / 00:05:00`, then five insert
    controls — [1] add text, [2] add image/media (opens an upload drop-zone overlay),
    [3] **record screen clip**, [4] captions, [5] comment — plus **Library** and
    **Timeline Zoom** popups; then the timeline ruler with tracks and **Add scene**.

## Screen Clip Settings (Brand Kit ▸ Screen Clips) — the cursor/motion surface

Directly relevant to the "make agent interactions feel human" problem:

- **CURSOR**: Auto-Hide Cursor (Auto Hide|Off), Text Cursor (Hide|Show), **Cursor Style**
  combobox — options **Arrow-first / Pointer-first / Original** — Cursor Scale slider (1.60).
- **SCREEN DISPLAY**: Screen Window Padding, Shadow Opacity/Blur/Spread sliders, Shadow X/Y
  offset fields.
- **SOUND EFFECTS**: Cursor Clicks checkbox + volume; Keyboard Presses checkbox + sound set
  ("Set B") + volume.
- **VISUAL EFFECTS**: Entrance/Exit Animation ("Fade Up"), Motion Blur (Off|Low|Medium|High),
  **Default Zoom Type** (Glide|Fixed — "Glide follows the cursor, fixed is static"), Default
  Zoom Level slider.

Per-draft overrides for the same live under Editor ▸ Project actions ▸ **Screen Clip
Settings…**.

## How to

- **Create a draft**: click **New draft** in the left rail — this immediately creates
  "Untitled" and opens the editor (no confirmation step).
- **Open per-draft settings**: Editor ▸ **Project actions** (…) → New Agent Chat (disabled),
  Copy Transcript, Make a copy, Download SRT…, **Screen Clip Settings…**, Show Version
  History…, **Brand ▸**, aspect ratio (Widescreen 16:9 / Laptop 16:10 / Square 1:1 /
  Vertical 9:16), Performance Mode (Efficiency/Default/Ultra), Delete (destructive).
- **Invite members**: rail ▸ Invite Members → "Invite Team Members" dialog with a multi-email
  textarea (comma-separated), **Send Invites** (disabled until an email is entered), Cancel.
- **Change cursor style / click sounds / zoom behaviour**: Brand Kit ▸ Screen Clips (above).
- **Change the agent model or effort**: Settings ▸ Preferences.

## Dead ends & quirks

- **Background clicks are silently no-ops in this app** — always use
  `delivery_mode: "foreground"` for clicks. Background scroll is unsupported outright
  (`background_unavailable`).
- **Escape does NOT close the Settings modal** — click the unlabeled 42×42 X button at the
  modal's top-right. (Escape does close menus and dropdowns.)
- The per-item **"…" popup on a Library card does not open via AXPress** — no state change.
  Try right_click on the row, or treat item menus as unreliable via AX.
- While a dropdown/menu is open, sidebar elements vanish from the AX tree (menu items
  overlay the page).
- Harness note: calling `record` in the same tool block as `act` suppresses that action's
  observation — issue them in separate turns.

## Editor: text entry quirks (found 2026-07-29 while driving a real task)

- **The draft title field ignores cmd+A** (no selection). To rename: use `set_value` on the
  title AXTextField, or clear it with repeated `option+delete` (word-wise) before typing.
  Typing without clearing appends ("UntitledCoffee App Tour").
- **Clicking the script textarea does not reliably focus it via AXPress.** A click that
  appears to succeed can leave focus elsewhere, so subsequent `type_text` keystrokes land in
  whatever field the app auto-focused or hit global shortcuts (observed: an accidental
  comment overlay; text leaking into the composer). What to do depends on the run mode:
  - **Unrecorded runs**: always pass `element_index` on `type_text` so the driver writes
    directly into the field.
  - **Recorded (demo) runs**: the harness translates `type_text` itself — it re-resolves the
    field against a fresh snapshot, clicks it by coordinate, then types the text as real
    keystrokes in chunks. Pass `element_index` naming the field and give the full text;
    `set_value` is not offered on recorded runs.
  Either way, distrust the driver's delivery counter ("delivered N of M character(s)") — it
  reported 0 delivered while every character landed (2026-07-31). The harness treats it as
  advisory and verifies from the fresh observation instead.
- **CDP backend (the app-target default): how to focus the script editor** (learned over
  three fleet runs, 2026-07-31). The script editor is ProseMirror; its inner nodes are the
  only addressable refs. To put the caret in it, `type_text` with the ref of the
  "Type script or # for new scene" placeholder row (or `click` it first) — the harness
  clicks painted-but-boxless rows by their rendered geometry and VERIFIES focus took before
  typing a single character. **Never type at the caret (ref-less `type_text`) unless you
  just confirmed where focus is: the agent composer at the bottom ("Ask, edit, or make
  something…") holds default focus and silently swallows stray keystrokes** — two runs
  typed their narration into it. Tab-traversal toward the editor does NOT reach it (it
  reaches the comment composer on the canvas instead). The placeholder row's ref resolves
  but its element measures NO box by any means, so if `type_text` with its ref fails,
  **click the empty script-panel area by coordinate** (the whitespace directly under the
  "Type script or # for new scene" line, read off the screenshot), then `type_text`
  without a ref at the caret.
- Creating a draft via "New draft" opens the editor immediately with the title "Untitled";
  the sidebar entry updates after the title field is committed (click away / switch tabs).

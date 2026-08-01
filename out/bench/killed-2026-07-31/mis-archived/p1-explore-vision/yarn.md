<!-- provenance: explore | app: Yarn | date: 2026-07-30 | backend: ax | actions: 96 | elapsed: 40m | findings: 36 | finds: 0 | controls: 47 actuated / 350 dismissed / 396 seen | surfaces: 34 | chapters: 9 | stopped: frontier-empty -->
<!-- controls actuated/seen is a LOWER BOUND ON BREADTH, not a coverage percentage: the denominator only grows as surfaces are opened, and operating a control is not understanding it. -->
<!-- Written by src/explore.ts. DO NOT HAND-EDIT: edits make this a curated recipe, not exploration output — move such notes to docs/recipes/<app>.md instead. -->

﻿# Yarn (Electron/Chromium app) — grounding notes

Single window titled "Yarn". Everything is web content; element_index works, but see quirks.

## Layout

**Left rail (always present)**
- Top: org badge **"David's Workspace"** (`.libraryPage-sideMenu-personalTab-orgBadgeBtn`) → **Workspace switcher** popover (workspace rows, "New workspace", "Sign out").
- **Library** → "Your Library" page: Search field, Grid/List toggle, sort-order popup (`.icon--name--sortOrder` → menu "Newest first"/"Oldest first"/"A - Z"/"Z - A"), blue **New Draft**, "Collections" section with **New Collection** tile, then a virtualized grid of project cards (inline rename field + "…" menu per card).
- **Your Drafts** → same list filtered to drafts.
- Then one rail row per project/draft (click opens the **project editor**), then **New draft**.
- Bottom: **Invite Members**, **Brand Kit**, **Settings**.

**Brand Kit** (rail → Brand Kit) = "Brand Studio" for the current brand ("Default Brand"). Tabs: Brand Overview, Templates, Workflows, Colors, Type, Screen Clips, Motion, Layout, Misc. Everything here is **brand-scoped**.
- *Brand Overview*: notes textarea + "Brand options" ellipsis (top-right) → Rename Brand / Duplicate Brand / New Brand / Archive Brand.
- *Templates*: overlay-template gallery (empty by default), Grid/List, "Sort by newest"/"Sort A-Z" checkboxes, **New Template**.
- *Workflows*: empty; only **New Workflow**.
- *Colors*: "Background" row (#6985FF, #26272A, #EDEEF8, #000000) and "Text Colors" row (#6985FF, #FFFFFF, #505155, #14181E). Each swatch is an AXPopUpButton "Open paint picker"; each has a neighbouring "Color actions" menu; "Add Background"/"Add Text Color" tiles. Bottom: "Color Notes" markdown area.
- *Type*: "Primary Font" search field (value **Inter**) + weight list, "Secondary Font" (value None), "Text Styles" + **New Text Style**, "Font Usage Notes".
- *Screen Clips* = **"Screen Clip Settings"**, the brand DEFAULTS for screen recordings: Cursor (Auto-Hide Cursor Auto Hide/Off, Text Cursor Hide/Show, Cursor Style combobox `Arrow-first` [also `Pointer-first`], Cursor Scale 1.60), Screen Display (Window Padding 18.0, Shadow Opacity 72%, Blur 32, Spread -18, X 0, Y 12), Sound Effects (Cursor Clicks ✓ + level `Extra Soft`; Keyboard Presses ✓ + set `Set B` (+`Original`) + level `Extra Soft`), Visual Effects (Entrance/Exit Animation `Fade Up`, Motion Blur Off/Low/**Medium**/High, Default Zoom Type **Glide**/Fixed, Default Zoom Level 54%).
- *Motion*, *Layout*, *Misc*: notes textareas only — **no functional controls**.

**Settings** (rail bottom → Settings) = app / account / workspace level modal (`.settingsModal`; close with the ✕ `.settingsModal-closeBtn`).
- Left column: avatar ("Edit profile photo" file input), name/email, **Sign out**.
- Right panel: **Preferences** — "Auto-Add Screen Zooms" On/Off, "Theme" Dark/Light/System (also Shift+Cmd+\), "Agent model" (Opus 5; Fable 5 / GPT-5.6 Sol / Opus 4.8 / Opus 5), "Agent effort" (Low/Medium/**High**/Extra High/Max), "Agent Fast Mode default" ✓. **Your Plan** (Free, Upgrade). **Workspace settings** — Workspace name field, Icon upload, "Custom window sizes" rows (Default 1440x897, Custom 1 1600x987, each with Remove) + Add Size. **Integrations** — Figma, Google Slides, Notion MCP, Team YouTube, Personal YouTube, Screen Studio Import. **Team Members** — Invite Members + member row with role popup.

**Project editor** (click any project in the rail)
- LEFT panel: tabs **Agent** / **Script**; project-title text field; "Select voice: Sarah" popup; "Project actions" ellipsis; ProseMirror transcript with per-scene headers ({{intro:a}}, {{intro:b}}, Connect HubSpot, Transition, Pull in data, Outro), each with an ellipsis menu (Copy Scene / Copy Transcript / Delete Scene). Bottom: agent composer ("Ask, edit, or make something…") with "Composer actions" +, "Effort: High" popup, Send.
- TOP-RIGHT status bar: composition paint picker, **captions** (speech bubble), **music** (note), **Publish** (globe), **Export**.
- CANVAS TOP BAR (selected clip): fill-type popup ("Timeline Clip"/"Graphics Video"), corner-radius number, Edit Trim, Convert to Camera, Mute, playback-rate number (1.00), dashed-circle **animation** popup, "…" more popover (Background → "Add BG" paint picker), and a detail-panel toggle (Layers tree for overlay clips).
- BOTTOM: play, timecodes, insert bar (overlay slide → brand template popover; media clip → "Add media" grid; text slide; record talk track; new comment), **Library** (Add-from-Library dialog: tabs Everything/Images/Screen Clips/Webcams/Videos/Projects, search, Upload Camera Footage, asset grid), **Timeline Zoom**, and the timeline with per-scene Add scene / skip buttons.

**Project actions menu** (ellipsis at top of Script panel) — all PROJECT-scoped: New Agent Chat (disabled), Copy Transcript, Make a copy, Download SRT…, **Screen Clip Settings…**, Show Version History…, **Brand ▸ Default Brand**, aspect ratio (Widescreen 16:9 / Laptop 16:10 / Square 1:1 / Vertical 9:16), Performance Mode (Efficiency / Default / Ultra), Delete.

## How to

- **Change screen-recording defaults for ALL new projects**: rail → Brand Kit → Screen Clips tab → edit control → changes save inline.
- **Change screen-recording settings for THIS project only**: editor → Script panel ellipsis ("Project actions") → "Screen Clip Settings…" → popover titled **"Screen Recording Settings"** with an identical control set → click **Done**. ⚠️ Separate store from Brand Kit; changing one does not change the other.
- **Change animation of the selected clip**: select clip → dashed-circle button in the clip top bar → popover with **Enter**/**Exit** tabs → click a preset (Appear/Fade In/Fade Up/Fade Down/Fade Left/Fade Right/Scale Up/Scale Down; Exit: Disappear/Fade Out/…). Escape (foreground) to close. The "…" in that popover header only toggles list↔dropdown view.
- **Change the animation default for new clips**: Brand Kit → Screen Clips → Visual Effects → Entrance/Exit Animation.
- **Change agent effort for one chat**: editor composer → "Effort: High" → 5-stop slider (Low/Medium/High/Extra/Max). **App-wide default**: Settings → Preferences → "Agent effort".
- **Style captions**: editor status bar → captions (speech-bubble) button; the clip toolbar switches into caption mode: Presets popup, font family ("Cereal"), size combobox ("Medium"), font-size number (48), text-colour paint picker, Effects popup, "Hidden" checkbox, "…". Click the captions button again to leave caption mode.
- **Change background music**: status bar music-note button → picker grid (No background track, Vintage Groove, LoFi tracks, …); selected track exposes "Remix Music to Fit"; upload tile at the bottom. Escape to close. Project-scoped; no app/brand music setting exists.
- **Change narration voice**: Script panel → "Select voice: Sarah" → dropdown with English/World/Creative tabs, 12 voices, footer "Fast Talking Speed". Project-scoped only.
- **Set a colour anywhere**: any "Open paint picker" AXPopUpButton opens the shared paint picker: 4 quick swatches (= Brand Kit Background palette), "Paint type" tabs Solid/Linear/Radial/Multi/Image/Shader, then type editors (Image: Replace image, Fit=Cover, Position=Center). Escape to close.
- **Create/switch/rename brands**: Brand Kit → Brand Overview → ellipsis "Brand options".
- **Rename / duplicate / delete a project**: Library card "…" menu (Make Private Draft, Rename, Make a copy, Delete) — click the ellipsis **by pixel**, AXPress is a no-op. "Make a copy" also exists in the editor's Project actions menu.
- **Rename the workspace**: Settings → Workspace settings → "Workspace name" (NOT in the workspace switcher).

## Dead ends & quirks

- **AXPress no-op**: `.AGLibraryProjectCard-footer-dropdownMenuBtn` (library card "…") must be clicked by pixel coordinate.
- **Scrolling is impossible**: "Background scroll is unavailable for Electron/Chromium windows on macOS". Long lists (Settings panel, Library grid, Add-media grid) can only be traversed via elements already in the tree.
- **"Add media" popover trap**: the insert-bar photo button opens a popover that does NOT close with escape, drops the whole web AX tree out of the snapshot (only the macOS menu bar is reported) and unfocuses the window. It is transient/inert — keep acting, click a real element, or use View ▸ Reload; the tree comes back and nothing is inserted. Prefer the bottom-right **Library** button (Add-from-Library dialog) which closes cleanly with escape.
- Never combine a `record` call and an `act` call in the same tool block — the act silently does not execute.
- Escape to close popovers needs delivery_mode "foreground".
- **Export** is refused by the harness (destructive-verb list) and **Publish** was deliberately not opened (externally visible) — their panels are unmapped.
- Brand Kit → Motion / Layout / Misc contain **only** notes textareas: animation/layout settings are NOT there (animation defaults are in Screen Clips → Visual Effects).
- There is **no** brand- or app-level default for narration voice or background music; both are project-only.
- macOS menu bar is generic Electron (File: Close Window/Close All; View: Reload/Force Reload/Toggle Developer Tools/zoom; Window; Help empty). There is **no** app Preferences item — Settings is only reachable from the left rail.

## Scope pairs to be careful about

| Setting | Brand/app scope | Document (project/clip) scope |
|---|---|---|
| Screen-clip cursor/shadow/sound/zoom/animation | Brand Kit → Screen Clips | Project actions → "Screen Clip Settings…" ("Screen Recording Settings" popover) |
| Entrance/Exit animation | Brand Kit → Screen Clips → Visual Effects | clip toolbar dashed-circle animation popover |
| Default zoom type/level | Brand Kit → Screen Clips; Settings → "Auto-Add Screen Zooms" (app default for new recordings) | per-project Screen Recording Settings; per-clip zoom buttons |
| Agent effort | Settings → Preferences → Agent effort | composer "Effort: High" popover |
| Background colour / palette | Brand Kit → Colors swatches | clip "…" → Add BG; clip swatch; status-bar composition paint |
| Fonts | Brand Kit → Type (Primary/Secondary, Text Styles) | captions bar font family/size |
| Sort order | Brand Kit → Templates checkboxes | Library sort-order menu (view preference) |
<!-- provenance: explore | app: Yarn | date: 2026-08-01 | backend: ax | vision: off | actions: 209 | elapsed: 32m | calls: 323 | tokens-in: 1863401 | tokens-out: 46605 | cache-read: 14355968 | cache-write: 0 | findings: 58 | finds: 0 | controls: 120 actuated / 285 dismissed / 594 seen | surfaces: 50 | chapters: 20 | stopped: frontier-empty | descent: off | gated: 0 read / 3 refused -->
<!-- controls actuated/seen is a LOWER BOUND ON BREADTH, not a coverage percentage: the denominator only grows as surfaces are opened, and operating a control is not understanding it. -->
<!-- Written by src/core/explore.ts. DO NOT HAND-EDIT: edits make this a curated recipe, not exploration output — move such notes to docs/recipes/<app>.md instead. -->

# Layout

## Library / drafts
- **Library** is the ordinary landing view. Return with sidebar **Library**. It has Search, Grid/List, an unlabeled sort popup, **New Draft**, Collections, and draft/template cards with editable titles and unlabeled action popups.
- **Your Drafts** is the drafts-only version of the grid; it omits Collections and non-draft items.
- The Library/Drafts sort popup offers **Newest first**, **Oldest first**, **A - Z**, and **Z - A**.
- Sidebar **Brand Kits** opens a kit picker; **Settings** opens the account/app/workspace preferences modal.

## Settings
- App preferences: Auto-Add Screen Zooms, Theme (Dark/Light/System), Agent model (Opus 5, Fable 5, Opus 4.8, GPT-5.6 Sol), Agent effort (Low through Max), and Agent Fast Mode default.
- Workspace settings include workspace name/icon, custom window sizes, integrations, and members.
- Invite, integration sign-in/connect, Upgrade, Sign out, Publish, and similar actions are externally visible/account actions.

## Brand Kit
- Enter with sidebar **Brand Kits**, then select a kit. Local sections: **Brand Overview**, **Templates**, **Workflows**, **Colors**, **Type**, **Screen Clips**, **Motion**, **Layout**, **Misc**.
- Brand Overview has notes and a Brand options menu: Rename Brand, Make Default, Duplicate Brand, New Brand, Archive Brand.
- Templates includes New Template and an inspector; **Edit Template...** opens the full template editor.
- Workflows opens an editor for Name, Description, and Prompt.
- Colors provides background/text palettes and the reusable paint picker.
- Type provides primary/secondary fonts and text styles.
- Screen Clips contains brand defaults for cursor, recording window/shadow, sounds, animations, motion blur, and zoom.
- Motion/Layout/Misc are brand guidance note fields.

## Draft editor
- Main areas: editable title, Agent/Script tabs, voice picker, Project actions, composer, preview, scene timeline, Library, Timeline Zoom, and Add scene.
- Top-right controls include project-background paint, a text-style toolbar toggle, Add Music, Publish, and Export.
- **Project actions** includes Screen Clip Settings, Make a copy, Version History, Brand assignment, Copy Transcript, Download SRT, aspect ratio, and Performance Mode.
- Timeline’s leftmost unlabeled editing popup opens the assigned brand’s overlay-template picker. **New Blank Overlay** enters overlay editing; **Insert** offers Text, Image, Video, Icon, Rectangle, Ellipse, Polygon, Line, Arrow, Pen, and Group.

## Template editor
- Agent/Layers tabs, canvas/timeline, Play, add Group/Text/Media/Shape/Comment, and inspector controls for duration, opacity, layout, background, motion blur, description, Webcam Preview, and Project BG Preview. Export and Publish Template are top right.

# How to

## Create a draft
1. From Library click **New Draft** (or sidebar **New draft**).
2. Rename by focusing the title, Cmd+A, typing the new name, and committing.
3. Use **Script** for scene titles/scripts; **Agent** for generated assistance.

## Change a draft’s brand
1. Open the draft.
2. Open **Project actions** → **Brand**.
3. Choose **Default Brand** or another kit. This applies immediately and is document-scoped.
4. **Edit Brands…** routes to Default Brand’s overview, not necessarily the assigned kit; use the Brand Kits picker afterward.

## Change screen-recording defaults vs one draft
- Workspace/brand default: **Brand Kits** → select kit → **Screen Clips**.
- One draft only: open draft → **Project actions** → **Screen Clip Settings...**.
- These panels look nearly identical but write different stores. Cursor Style values are Arrow-first, Pointer-first, Original. Click/keyboard volume values are Extra Soft, Soft, Medium, Loud; keyboard set values are Set A–D.

## Create or duplicate a brand
- Brand Overview → Brand options → **New Brand** creates and opens **Untitled Brand** immediately. Click its title, replace it, then click adjacent **Done**.
- Brand options → **Duplicate Brand** creates and opens `<original> Copy` with inherited content.
- **Make Default** applies immediately and changes the workspace primary brand.

## Create/edit a template
1. Brand Kit → **Templates** → **New Template** to open the full editor.
2. Use the canvas/timeline add controls and right inspector.
3. From a selected template in the list, **Edit Template...** reopens the editor.

## Create a workflow or text style
- Workflow: Brand Kit → **Workflows** → **New Workflow** → fill Name, Description, Prompt → **Done**.
- Text style: Brand Kit → **Type** → **New Text Style** → set name, preview, font family/weight/size, line height, letter spacing → **Done**.

## Use the paint picker
- Click a color swatch/paint button. Types: **Solid**, **Linear**, **Radial**, **Multi**, **Image**, **Shader**.
- Linear/Radial use editable gradient stops plus Flip/Rotate/Add Stop. Multi uses multi-point stops and Blend. Image offers Upload image then Fit/Position. Shader offers preset, four colors, Speed, Seed, Noise, Saturation.
- Escape closes without further selection.

## Add a scene or overlay
- **Add scene** inserts another 5-second Untitled Scene immediately.
- For an overlay, open timeline’s leftmost unlabeled popup → **New Blank Overlay** → **Insert**.
- Text exposes font/style/color/opacity. Rectangle/Ellipse/Polygon expose W/H, fill/stroke, numeric shape fields, opacity; Polygon adds N sides. **Group** groups selected elements and shows **Ungroup**.
- Image/Video open full-window library pickers; Escape cancels.

## Add music or references
- **Add Music** opens a track grid; clicking a track applies it immediately to the document. Choose **No background track** to remove one.
- Agent composer → **Composer actions** → **Add Reference...** opens a standard macOS Open dialog; choose a file and Open, or Cancel.

## Inspect version history
- Draft → Project actions → **Show Version History...**. Close exits. Selecting/reverting a version changes document content, so do not do this on user content without explicit intent.

# Dead ends & quirks
- The brand-level Screen Clips page and draft-level Screen Recording Settings are intentionally separate scopes; changing the wrong one can appear successful while affecting the wrong objects.
- Brand text styles are brand-scoped definitions; applying one from an overlay text toolbar changes the current document element.
- The draft top-toolbar button immediately right of project background is unlabeled and toggles the document text-style toolbar.
- Timeline Zoom changes view scale only, not content.
- Add scene, music choices, overlay templates, and primitive Insert choices apply immediately.
- Library asset cards represent user content; opening the picker is safe, but choosing an asset inserts it into the current document.
- Version reverts, scene Delete, workflow Delete, brand archive/rename, and card destructive actions must not be used on existing user content.
- Text fields are often prefilled: focus, Cmd+A, then type. Escape often needs foreground delivery to close overlays.
- Scratch artifacts created during exploration include `scratch-draft-map-ch4`, `Copy of scratch-draft-map-ch4`, `scratch-brand-map-7f3a Copy`, `scratch-brand-new-map-ch15`, scratch templates/styles/collection, and inserted scratch scenes/overlays; these are safe cleanup candidates.
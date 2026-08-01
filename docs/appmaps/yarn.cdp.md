<!-- provenance: explore | app: Yarn | date: 2026-08-01 | backend: cdp | actions: 257 | elapsed: 49m | calls: 397 | tokens-in: 1611929 | tokens-out: 56094 | cache-read: 8477184 | cache-write: 0 | findings: 76 | finds: 1 | controls: 136 actuated / 135 dismissed / 6609 seen | surfaces: 44 | chapters: 24 | stopped: frontier-empty | descent: off | gated: 0 read / 4 refused -->
<!-- controls actuated/seen is a LOWER BOUND ON BREADTH, not a coverage percentage: the denominator only grows as surfaces are opened, and operating a control is not understanding it. -->
<!-- Written by src/core/explore.ts. DO NOT HAND-EDIT: edits make this a curated recipe, not exploration output — move such notes to docs/recipes/<app>.md instead. -->

# Layout

## Library
- Ordinary landing view: **Library** (`/library/ag`). Return via the left-rail **Library** button.
- Main controls: Search, Grid/List, sort icon, **New Draft**, Collections/**New Collection**, and draft cards. Click a card body to open it; use its ellipsis for item actions.
- **Your Drafts** (`/library/drafts`) is the drafts-only overview with the same search/view/sort/new controls.
- Bottom rail: **Invite Members**, **Brand Kits**, **Settings**.

## Settings
- Open **Settings** from the bottom rail; it appears as a modal over Library.
- Preferences: Auto-Add Screen Zooms, Theme (Dark/Light/System), Agent model (Opus 5, Fable 5, Opus 4.8, GPT-5.6 Sol), Agent effort (Low through Max), and Agent Fast Mode default.
- Also contains subscription/credits, workspace name, custom/default canvas sizes, integrations, Screen Studio Import, and Invite Members.

## Brand Kits
- Click **Brand Kits**, then choose a brand. Brand tabs: **Brand Overview, Templates, Workflows, Colors, Type, Screen Clips, Motion, Layout, Misc**.
- Brand Overview: brand name, Overview notes, and Brand options.
- Templates: grid/list, sort, template list, right inspector, and **New Template**.
- Workflows: workflow list and **New Workflow**.
- Colors: Background/Text palettes, paint pickers, swatch actions, and Color Notes.
- Type: primary/secondary fonts, text styles, and Font Usage Notes.
- Screen Clips: brand-wide recording defaults.
- Motion/Layout/Misc: brand-scoped guideline notes.

## Draft editor
- **New draft** immediately creates an Untitled draft at `/ag-editor/{id}`.
- Layout: left Agent/Script panel, central canvas, bottom timeline, composer, and top controls for background paint, caption styling, music, web/publish/export, and **Project actions**.
- Project actions includes Brand assignment, aspect ratio, Performance Mode, Screen Clip Settings, Version History, Copy Transcript, Make a copy, and other project operations.
- **Add scene** appends a scene and timeline segment.

## Template editor
- Brand Kits > Templates > **New Template** immediately creates a template at `/template-editor/{id}`.
- Layout: Agent/Layers at left, canvas/timeline center, inspector right, and bottom tools **Group, Text, Media, Shape**.
- Template options: duplicate, performance mode, canvas size, playback loop, and delete.
- Shape menu: Rectangle, Circle, Triangle, Polygon, Line, Arrow, Icon, Pen.

# How to

## Create and rename a draft
1. From Library, click **New Draft**.
2. The editor creates the draft immediately.
3. Replace the top title textbox value to rename it.

## Work with draft cards
- Open: click the card body.
- Actions: card ellipsis > Move to workspace, Add to Collection, Rename, Make a copy, or Delete.
- Rename uses an inline textbox and saves on entry/blur.
- Add to Collection opens a checkbox picker; selecting a collection applies immediately.
- Move applies immediately and removes the card from the current workspace view.

## Add a scene
1. Open a draft.
2. Click **Add scene**.
3. A new Untitled Scene and 5-second timeline segment appear immediately.

## Change document aspect ratio or performance
1. Draft editor > **Project actions**.
2. Choose Widescreen 16:9, Laptop 16:10, Square 1:1, or Vertical 9:16; selection applies immediately.
3. For performance, choose Efficiency, Default, or Ultra; it also applies immediately.

## Assign a brand to a draft
1. Draft editor > **Project actions** > **Brand**.
2. Choose a listed brand. This is document-scoped.
3. **Edit Brands…** opens brand management.

## Change screen-clip settings at the correct scope
- Brand default: Brand Kits > brand > **Screen Clips**; edit and click **Save Changes**.
- Current draft override: Draft editor > Project actions > **Screen Clip Settings…**; edit and click **Done**.
- Both surfaces expose the same underlying settings: cursor auto-hide, text cursor, Cursor Style (Arrow-first/Pointer-first/Original), cursor scale, padding/shadows, sound effects, entrance/exit, motion blur, and zoom/camera behavior. Choose the surface matching the intended scope.

## Use draft background paint
1. Click **Open paint picker** above the canvas.
2. Choose Solid, Linear, Radial, Multi, Image, or Shader.
3. Gradient editors provide stops, colors, opacity, flip/rotate/add-stop; Multi adds draggable color points and Blend; Shader exposes Watercolor and numeric parameters.
4. Changes apply live at document scope.

## Style the draft caption
1. Click the unlabeled icon immediately right of the canvas paint control.
2. The caption is selected and a toolbar appears.
3. Use Presets, font family/weight/size, text paint, Effects, Hidden, or ellipsis controls.

## Generate images or video
1. Composer actions > **Switch to Media Gen**.
2. Choose Image or Video.
3. Image models: Gemini, GPT Image 1.5, Seedream-4; choose generation count, preferred layout, and optionally Save as default.
4. Video models: Kling-2.5, Sora-2 Pro, Veo-3.1; also choose 5/10 sec and layout. Credit estimate updates with settings.

## Voice assignment
1. In the draft editor, click **Select voice**.
2. Choose English, World, or Creative tab; optionally set Default Speed.
3. Click a voice; it assigns immediately and closes the picker.

## Create a brand or workflow
- New brand: Brand Overview > Brand options > **New Brand**. Rename through Brand options > **Rename Brand**, edit Brand name, then **Done**.
- Workflow: Brand Kits > Workflows > **New Workflow**, enter name/description, then **Save Changes**.

## Edit brand colors and type
- Colors: click a swatch or Add Background/Add Text Color; choose paint type and values, then top-level Save Changes. Swatch actions include Make Default, Duplicate, Remove.
- Type: choose primary/secondary searchable font comboboxes. **New Text Style** opens name, preview, family, weight, size, line height, and letter spacing. Click modal **Done**, then page-level **Save Changes**.

## Create and configure a template
1. Brand Kits > Templates > **New Template**.
2. Rename with the top title textbox.
3. Use Group/Text/Media/Shape to create layers.
4. Select a layer to edit Position, Layout, typography or paint, and optional Border/Shadow/Blur in the right inspector.
5. Click empty canvas for template-level Duration, Opacity, Background, Motion Blur, Description, Webcam Preview, and Project BG Preview.

## Add template shapes
- Rectangle/Circle create standard shape layers with Background and optional Border/Shadow/Blur.
- Triangle and Polygon create polygon layers; Triangle defaults to 3 sides, Polygon to 6. Edit side count and corner radius.
- Line creates a vector with stroke style and optional Arrow/Shadow/Blur.
- Arrow creates the same vector with Arrow placement/style/size enabled.
- Icon opens an SF Symbols-style searchable picker plus weight and paint controls.
- Pen arms a drawing mode; it does not create a layer on a single click.

## Duplicate items
- Draft: Project actions > **Make a copy**; immediate, navigates to `Copy of {title}`.
- Brand: Brand options > **Duplicate Brand**; immediate and opens the copied brand.
- Template: Template options > **Duplicate Template**; immediate, preserves layers/styles, and opens `{title} Copy`.

# Dead ends & quirks
- **Add Reference**, Media upload, Add Music upload, Screen Studio Import, and camera/screen recording produced no driveable in-page picker; they appear to invoke native/browser file or capture UI.
- Template Webcam Preview showed only **None**; its painted dropdown did not expose an accessible menu.
- Draft media and template Media panels can appear almost blank except for one unlabeled upload control; waiting did not reveal a library.
- Undo/Redo are the two adjacent unlabeled draft-header controls before Project actions.
- Template comments have a send arrow and are collaborative/external; do not send during routine navigation.
- Publish, Export, Invite Members, Upgrade, integration connect/sign-in, Sign out, and YouTube publishing are externally consequential.
- Archive Brand, Delete Template, and draft Delete are destructive. Do not use them on existing user content.
- Copy Transcript copies to clipboard but leaves the Project actions menu open.
- Settings changes are app/workspace scoped; Brand Kit values are brand scoped; draft Project actions and canvas styling are document scoped; template options and layer inspectors are per-template.

## Scratch objects created during exploration
Agent-owned objects include brands 250 and 255, templates 1096 and 1097, draft 1324060536 and duplicate 286870601, scratch workflow/text style, and scratch collections/workspace items with `scratch-*grounding*` names. These may be cleaned up; existing non-scratch user content was not intentionally modified.
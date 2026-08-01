<!-- provenance: explore | app: Yarn | date: 2026-08-01 | backend: cdp | actions: 219 | elapsed: 49m | calls: 380 | tokens-in: 1099426 | tokens-out: 51926 | cache-read: 6396416 | cache-write: 0 | findings: 55 | finds: 0 | controls: 106 actuated / 177 dismissed / 2054 seen | surfaces: 67 | chapters: 20 | stopped: frontier-empty | descent: off | gated: 0 read / 13 refused -->
<!-- controls actuated/seen is a LOWER BOUND ON BREADTH, not a coverage percentage: the denominator only grows as surfaces are opened, and operating a control is not understanding it. -->
<!-- Written by src/core/explore.ts. DO NOT HAND-EDIT: edits make this a curated recipe, not exploration output — move such notes to docs/recipes/<app>.md instead. -->

# Layout

## Library and workspace navigation
- Ordinary landing view: **Library** (`/library/ag`). The persistent left rail has the workspace switcher, **Library**, **Your Drafts**, recent drafts, **New draft**, **Invite Members**, **Brand Kits**, and **Settings**.
- Library offers Search, Grid/List, sort, **New Collection**, **New Draft**, and draft-card ellipsis menus.
- **Your Drafts** (`/library/drafts`) is the workspace-wide drafts list with Search, Grid/List, sort, New Draft, and per-card actions.
- A collection (`/library/collection/<id>`) has back, title, Search, Grid/List, sort, **New in Collection**, and an ellipsis containing only **Delete Collection**.
- Workspace switcher lists workspaces plus **New workspace** and **Sign out**.

## Settings
- **Settings** opens a large modal over the current view.
- Account/app preferences: Auto-Add Screen Zooms; Theme (Dark/Light/System); Agent model; conditional Agent Fast Mode default for Opus 5; Agent effort (Low/Medium/High/Extra High/Max); profile/photo; plan and Upgrade.
- Workspace settings: editable workspace name; Default/Custom recording sizes with Add Size/Remove; team-member actions; Figma, Google Slides, Notion MCP, YouTube and Screen Studio Import integrations; Invite Members.
- Upgrade opens a plans modal (Starter, Seed, Growth, Enterprise); its Upgrade/Book a Call controls are external commitments.

## Brand Kit
- **Brand Kits** opens `/brands?brandId=…`. Internal rail: **Brand Overview**, **Templates**, **Workflows**, **Colors**, **Type**, **Screen Clips**, **Motion**, **Layout**, **Misc**.
- Brand Overview: overview notes and **Brand options**. A non-default brand menu has Rename Brand, Make Default, Duplicate Brand, New Brand, Archive Brand.
- Templates opens the template list and **New Template** launches the full template editor.
- Workflows has New Workflow and staged Save Changes/Cancel.
- Colors has Background/Text swatches, add controls, notes, paint pickers, per-swatch actions, and staged Save Changes/Cancel.
- Type has searchable Primary/Secondary fonts, text-style rows, New Text Style, usage notes, and staged Save Changes/Cancel.
- Screen Clips holds **brand-scoped defaults** for cursor, screen window/shadow, sound, visual effects, zoom behavior, etc.
- Motion, Layout, and Misc are brand-scoped notes pages with staged Save Changes/Cancel.

## Template editor
- **New Template** opens `/template-editor/<id>` with editable title, Brand Studio return, New template, Template options, Agent/Layers tabs, Composer actions, Export, Publish Template, playback/timeline, and Group/Text/Media/Shape/Comment tools.
- Selecting the blank canvas exposes Duration, Opacity, layout choices, Background, Motion Blur, Description, paint/project background, and Webcam Preview.
- Template options: New Chat, Duplicate Template, Performance Mode, Canvas Size, Playback Loop, Delete Template.
- Adding Text creates `New Text` and opens the rich inspector for position/layout, font/style, size/line height/tracking, alignment, opacity, fill, Highlight, Stroke, Shadow, and Blur.

## Draft editor
- **New draft** opens `/ag-editor/<id>` with Agent/Script modes, editable title, voice picker, Project actions, Composer actions, background picker, Add Music, Publish/Export, canvas, playback/timeline tools, and Add scene.
- **Project actions** contains New Agent Chat, Copy Transcript, Make a copy, Download SRT, Screen Clip Settings, Show Version History, Brand submenu, canvas sizes, Performance Mode, and Delete.
- The top-right Screen Recording Settings panel is a **document-scoped override** of Brand Kit > Screen Clips defaults.
- Composer actions switches between Agent and Media Gen; Media Gen has Image/Video tabs and a Gemini model selector.
- Timeline tools include playback, Add Overlay, media panel, Record Camera / Screen, Record Talk Track, Timeline Zoom, and Add scene.
- Add Overlay opens the current brand’s template picker plus New Blank Overlay. A blank overlay’s Insert menu includes Text, Image, Video, Icon, Rectangle, Ellipse, Polygon, Line, Arrow, Pen, and Group.

# How to

## Create and rename a workspace
1. Click the workspace name in the left rail.
2. Click **New workspace**.
3. Enter a distinctive name and complete creation; Yarn opens its empty Library.

## Create or manage a brand
1. Click **Brand Kits**.
2. On Brand Overview, open **Brand options**.
3. **New Brand** creates and opens `Untitled Brand` immediately.
4. To rename: Brand options > **Rename Brand** > edit **Brand name** > **Done**.

## Create a template
1. Brand Kits > **Templates** > **New Template**.
2. Rename via the title field.
3. Select the canvas to edit template-wide inspector values, or use Text/Media/Shape to add layers.
4. Template options > **Duplicate Template** immediately creates and opens a copy; rename the new untitled copy.

## Create a workflow
1. Brand Kits > **Workflows** > **New Workflow**.
2. Fill Name, Description, and Prompt/Workflow instructions.
3. Click **Done**, then use the page’s **Save Changes** if changes remain staged.

## Add a brand text style
1. Brand Kits > **Type** > **New Text Style**.
2. Supply name and configure preview, family, weight, size, line height, and letter spacing.
3. Click **Done**, then **Save Changes** on the Type page.

## Change colors
1. Brand Kits > **Colors**.
2. Click a swatch to open the paint picker (Solid, Linear, Radial, Multi, Image, Shader).
3. For solid color use hue/opacity/eyedropper and HEX/RGB value controls.
4. Use a swatch’s **Color actions** for Make Default, Duplicate, or Remove.
5. Click **Save Changes**.

## Change screen-clip defaults vs one draft
- Brand-wide default: **Brand Kits > Screen Clips**, edit controls, then **Save Changes**.
- Current draft only: open the draft and click the top-right globe-like Screen Recording Settings icon, or Project actions > **Screen Clip Settings…**. Changes apply to that draft.
- Shared setting identity includes Auto-Hide Cursor, Text Cursor, Cursor Style (Arrow-first/Pointer-first/Original), Cursor Scale, window/shadow controls, sound effects, Motion Blur, cursor movement, and zoom settings. Do not confuse the two scopes.

## Create and organize drafts
- Workspace draft: left rail or Library > **New draft**.
- Draft inside a collection: open collection > **New in Collection**; it opens the normal editor and associates the draft automatically.
- Add existing draft to collection: Your Drafts card ellipsis > **Add to Collection** > click a collection; assignment is immediate.
- Rename card: card ellipsis > **Rename**, edit the focused inline textbox, press Enter. Escape cancels.
- Duplicate: card ellipsis or Project actions > **Make a copy**; the new copy opens immediately.
- Privacy: Library card ellipsis > **Make Private Draft**; applies immediately with a toast.

## Sort lists
1. Click the unlabeled sort button in Library or Your Drafts.
2. Choose Newest first, Oldest first, A - Z, or Z - A. Selection applies immediately.

## Work in the draft editor
- Script mode > **Add scene** immediately appends an `Untitled Scene` block.
- Click **Select voice**, choose English/World/Creative, optionally adjust Default Speed, then choose a voice; selection applies immediately.
- Composer actions > **Switch to Media Gen**; use Composer actions > **Switch to Agent** to return.
- **Add Music** > Upload background track accepts MP3/WAV/M4A, but opens a native file chooser.
- Project actions > **Show Version History…** opens a right-side panel; Close dismisses it.
- Project actions > hover **Brand …** > choose a brand for immediate document-scoped assignment, or **Edit Brands…** to navigate to Brand Kit.
- Project actions > **Brand … > Default Brand** assigns the workspace default to the current draft immediately.
- Timeline Zoom opens a slider; arrow keys adjust it and reveal Reset.

## Add an overlay
1. Click the timeline’s A-card **Add Overlay** icon.
2. Choose a brand template or **New Blank Overlay**.
3. In the blank overlay, open **Insert** and choose an object.
4. Text creates centered `New Text` and opens its compact font/style/fill/opacity inspector.
5. Rectangle creates a 200×200 shape and opens size/fill/radius/stroke/opacity controls.

# Dead ends & quirks
- Draft Project actions > Brand > **Edit Brands…** navigated to Brand Kit, but observed `/brands?brandId=238` rather than the draft’s then-assigned brand 240. Treat it as a route to brand management, not proof it opens the assigned brand.
- Collection ellipsis has Delete Collection only; no rename was found, and the collection title is not editable in that view.
- Integration buttons and Edit profile photo produced no in-page UI under CDP, likely popup/native flows.
- Upload background track and media uploads likely open undriveable native file choosers.
- Record Camera / Screen and Record Talk Track produced no in-page surface, likely due to native permissions/recording unavailable to this driver.
- Copy Transcript is a local clipboard action and showed no toast on an empty draft.
- Choosing a voice sometimes makes `Select voice` disappear from accessibility rather than exposing the selected name.
- Draft and template Delete actions can be immediate; never use them on user content. Collection Delete, Archive Brand, Suspend user, Sign out, Publish, Invite, Upgrade, and Book a Call are destructive or externally consequential.
- Settings changes are immediate in some places (Theme, agent defaults), while Brand Kit pages commonly require page-level Save Changes.

## Scratch cleanup
Created during exploration: workspace `scratch-workspace-grounding-2026-a1`; brand `scratch-brand-grounding-2026-a1`; templates `scratch-template-grounding-2026-a1` and `scratch-template-duplicate-grounding-2026-a1`; workflow `scratch-workflow-grounding-2026-a1`; text style `scratch-text-style-grounding-2026-a1`; collection `scratch-collection-grounding-2026-a1`; drafts `scratch-draft-grounding-2026-a1`, `scratch-draft-copy-grounding-2026-a1`, and `scratch-collection-draft-grounding-2026-a1`.
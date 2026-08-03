<!-- provenance: explore | app: Yarn | date: 2026-08-03 | backend: cdp | actions: 87 | elapsed: 16m | calls: 144 | tokens-in: 580962 | tokens-out: 20167 | cache-read: 2237952 | cache-write: 0 | findings: 29 | finds: 1 | controls: 62 actuated / 68 dismissed / 222 seen | surfaces: 12 | chapters: 8 | stopped: frontier-empty | descent: off | gated: 0 read / 4 refused -->
<!-- controls actuated/seen is a LOWER BOUND ON BREADTH, not a coverage percentage: the denominator only grows as surfaces are opened, and operating a control is not understanding it. -->
<!-- Written by src/core/explore.ts. DO NOT HAND-EDIT: edits make this a curated recipe, not exploration output — move such notes to docs/curated/<app>.md instead. -->

# Layout

- **Library** (`/library/ag`) is the ordinary landing view. Return from anywhere with left-rail **Library**. It has Search, Grid/List, sort, **New Draft**, collections, and **New Collection**.
- **Your Drafts** (`/library/drafts`) is the drafts-only list. Draft-card ellipsis: Move to collection, Rename, Make a copy, Delete.
- **Collection** (`/library/collection/{id}`) has Search, Grid/List, sort, **New in Collection**, and an ellipsis with **Delete Collection**.
- **Draft editor** (`/ag-editor/{id}`) has Agent/Script tabs, script and agent composer, canvas/timeline, Select voice, Project actions, Composer actions, background picker, Add Music, Add scene, Publish, Export, and Library.
- **Routines** (`/routines`) lists reusable generation flows; **New Routine** opens the routine editor.
- **Brand Kit** (`/brands?brandId=…`) is workspace/brand scope. Subpages: Overview, Templates, Workflows, Colors, Type, Screen Clips, Motion, Layout, Misc.
- **Settings** opens a modal (`#settings/subscription`) containing app preferences, plan, workspace settings, custom recording sizes, integrations, and members.
- The workspace-name button opens the workspace menu: switch workspace, **New workspace**, Demo mode, Sign out.

# How to

## Create a draft
1. From Library or Your Drafts, click **New Draft** (or left-rail **New draft**).
2. The new draft opens directly in the draft editor.
3. Edit its title at the top.

## Change project-specific screen-recording settings
1. In a draft, click **Project actions**.
2. Choose **Screen Clip Settings…**.
3. Edit Auto-Hide Cursor, Text Cursor, Cursor Style, Cursor Scale, window padding/shadow, sound effects, Entrance/Exit Animation, Motion Blur, Default Zoom Type, or Default Zoom Level.
4. Click **Done**.
These controls are **document scoped**.

## Change brand defaults for screen clips
1. Left rail → **Brand Kit** → **Screen Clips**.
2. Edit the corresponding cursor, shadow, sound, visual-effect, and zoom defaults.
3. Use page-level **Save Changes**; **Cancel** discards pending edits.
These controls are **brand/workspace scoped** and pair with the document overrides above.

## Use Project actions
- Draft editor → **Project actions**.
- Menu contains New Agent Chat, Copy Transcript, Make a copy, Download SRT…, Screen Clip Settings…, Show Version History…, Brand, Widescreen/Laptop/Square/Vertical canvas sizes, Performance Mode (Efficiency/Default/Ultra), and Delete.
- Canvas size and Performance Mode here are document scoped.

## Create a collection
1. Library → **New Collection**.
2. Enter Collection name and choose one of eight colors.
3. Click **Create Collection**; the new collection opens.
4. Use **New in Collection** to create content in it.
5. Collection ellipsis → **Delete Collection** is the cleanup route.

## Create a routine
1. Left rail → **Routines** → **New Routine**.
2. Enter a name and Agent instructions.
3. Optionally enable **Start from a project** and choose delivery outputs: Watch page, MP4 file, Draft project.
4. Click **Add Routine**.
5. The saved editor shows its POST endpoint, request-body example, copy controls, variables/callbackUrl guidance, and **Delete Routine**.

## Create and edit a template
1. Brand Kit → **Templates** → **New Template**. It immediately creates an unpublished template and opens the editor.
2. Rename via the title at top.
3. Use Agent/Layers, canvas/timeline, Group/Text/Media/Shape/Comment, and the right inspector (Duration, Opacity, layout, Background, Motion Blur, Description, Webcam Preview, Project BG Preview).
4. Template options provide New Chat, Duplicate Template, Performance Mode, Canvas Size, Playback Loop, and Delete Template.
5. **Publish Template** is externally visible; do not use unless explicitly requested.

## Manage Brand Kit workflows
1. Brand Kit → **Workflows** → **New Workflow**.
2. Fill Name, Description, and Prompt/Workflow instructions.
3. **Done** adds it to the pending list; click page-level **Save Changes** to persist.

## Manage colors and type
- **Colors:** Brand Kit → Colors. Edit Background/Text swatches, add colors, open a swatch for Make Default/Duplicate/Remove, and edit Color Notes. Save with **Save Changes**.
- **Type:** Brand Kit → Type. Primary/Secondary fonts are searchable. **New Text Style** opens Name, preview text, Font Family, Weight, Size, Line Height, Letter Spacing. Click **Done**, then page-level **Save Changes**. Editing an existing style adds **Remove Text Style**. Page-level **Cancel** discards all unsaved type changes.
- Font lists and color values use searchable/repetitive pickers; operate one representative value rather than exhaustively traversing them.

## Edit Brand Kit notes
- Overview has Overview notes.
- Motion, Layout, and Misc each have one principles/context text area.
- Brand edits stay dirty when switching Brand Kit subpages; use global **Save Changes** or **Cancel**.

## Change app/workspace settings
1. Left rail → **Settings**.
2. App preferences: Auto-Add Screen Zooms, Theme (Dark/Light/System; shortcut Shift+Command+\), Agent model, Agent effort, Agent Fast Mode default.
3. Scroll/jump to Workspace settings for workspace name/icon and custom recording window sizes (label + dimensions, Remove, Add Size).
4. Bottom integrations: Figma, Google Slides, Notion MCP, Team YouTube, Personal YouTube, Screen Studio Import.
5. Team Members appears at bottom; member ellipsis exposes **Suspend user**.
Authentication, importing, inviting, suspension, upgrade, and sign-out are account/external boundaries.

## Create a workspace
1. Click the workspace name in the upper-left.
2. Choose **New workspace**.
3. Enter the name and click **Create Workspace**.
4. Yarn switches to that workspace’s empty Library.

# Dead ends & quirks

- Brand Kit Screen Clips and draft Screen Clip Settings expose the same settings at different scopes. Use Brand Kit for defaults; use Project actions for one draft.
- Brand Kit edits remain pending across subpage navigation; navigation alone does not discard them.
- New Template creates immediately before naming; it is unpublished until Publish Template.
- Workflow modal **Done** is not persistence; page-level **Save Changes** is required.
- Draft-card Delete acted immediately with no confirmation in the claimed scratch test.
- Collection and Routine deletion controls were visible but blocked by the harness.
- Invite Members and publishing/authentication controls commit off-machine and were not opened.
- Native file/download flows such as workspace icon upload, Screen Studio Import, and Download SRT may leave the driveable web UI.
- Scratch cleanup still needed: workspace **Yarn Exploration Scratch Workspace**; collection **Exploration Scratch Collection** (425219657); routine **Exploration Scratch Routine** (17); unpublished template **Exploration Scratch Template**; workflow **Exploration Scratch Workflow**; and possibly custom window size **Exploration Size**. The scratch draft and unpersisted scratch text style were cleaned up.
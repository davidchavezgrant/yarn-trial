<!-- provenance: explore | app: Yarn | date: 2026-08-03 | backend: ax | actions: 168 | elapsed: 44m | calls: 279 | tokens-in: 2106278 | tokens-out: 43276 | cache-read: 11129856 | cache-write: 0 | findings: 53 | finds: 0 | controls: 106 actuated / 214 dismissed / 547 seen | surfaces: 37 | chapters: 16 | stopped: frontier-empty | descent: off | gated: 0 read / 5 refused -->
<!-- controls actuated/seen is a LOWER BOUND ON BREADTH, not a coverage percentage: the denominator only grows as surfaces are opened, and operating a control is not understanding it. -->
<!-- Written by src/core/explore.ts. DO NOT HAND-EDIT: edits make this a curated recipe, not exploration output — move such notes to docs/curated/<app>.md instead. -->

# Layout

- **Library** is Yarn’s ordinary landing view. Reach it with the left-rail **Library** button. It contains Search, Grid/List, sort, **New Draft**, **New Collection**, collection tiles, and project cards.
- **Your Drafts** is the left-rail filtered draft list. **Routines** is the automation list/editor.
- **Brand Kits** opens a brand picker. Selecting a brand opens **Brand Studio** with tabs: Brand Overview, Templates, Workflows, Colors, Type, Screen Clips, Motion, Layout, Misc.
- **Settings** is a centered, scrollable modal over Library. It includes Preferences, plan/workspace, custom recording sizes, integrations, and team members.
- A draft opens the full **project editor**: Agent/Script panel on the left; preview and insertion toolbar in the center; timeline below; composition/captions/music/publish/export at top right.
- A brand template opens the full **template editor**: Agent/Layers left, canvas/timeline center, template properties right.
- Click the workspace badge at upper left for workspace switching, New workspace, Demo mode, and Sign out.

# How to

## Library and collections

- Search: click the Library header **Search** field and type.
- Sort: click the sort icon, then choose **Newest first**, **Oldest first**, **A - Z**, or **Z - A**; selection applies immediately.
- Create a draft: click **New Draft** (or left-rail **New draft**). It immediately creates and opens an empty draft.
- Create a collection: **New Collection** → enter name → choose one of eight colors → **Create Collection**. Inside a collection, **New in Collection** immediately creates and opens a normal draft belonging to it.

## Settings

- Open **Settings** from the left rail. Preferences include Auto-Add Screen Zooms, Theme (Dark/Light/System), default Agent model, and Agent effort.
- Agent model options: Opus 5, Fable 5, Opus 4.8, GPT-5.6 Sol. Effort: Low, Medium, High, Extra High, Max.
- Custom window size: scroll to Workspace → **Add Size**; a row appears with default 1440x897 and editable name/dimensions.

## Routines

- **Routines** → **New Routine**. Enter both Name and Agent instructions to enable **Add Routine**.
- Optional delivery controls: Watch page, MP4 file, Draft project. MP4 requires `callbackUrl`; Watch page and Draft project do not.
- To base a routine on a draft: enable **Start from a project** → choose a project → save/add. On an existing routine, click **Save Changes** after changing the project.
- Saved routine detail shows POST run endpoint, request-body example, callback/variables, and copy buttons.

## Brand Studio

- **Brand Kits** → choose brand. Do not confuse this with assigning a brand to one draft.
- **Templates** → **New Template** opens the template editor. Name edits commit with Return. Template options contain Duplicate, Performance Mode (Efficiency/Default/Ultra), Canvas Size, Playback Loop, and Delete.
- **Workflows** → **New Workflow** → fill Name and Prompt (Description optional) → **Done** → page-level **Save Changes**.
- **Colors**: Background/Text swatches and add tiles. Clicking a swatch opens paint types Solid, Linear, Radial, Multi, Image, Shader. Gradient editing includes stops, position/hex/opacity, flip, rotate 90°, and add stop. Use page-level **Save Changes**.
- **Type**: searchable Primary/Secondary Font, weight list, text styles, Font Usage Notes. **New Text Style** → set name/preview/font/weight/size/line height/letter spacing → **Done** → page-level **Save Changes**.
- **Screen Clips** sets **brand defaults** for cursor, screen display/shadow, click and keyboard sounds, entrance/exit, motion blur, zoom type, and zoom level.
- Motion, Layout, and Misc are brand-scoped markdown/text guidance areas with no separate save button visible.

## Draft editor

- Rename via the title field. Voice picker tabs are English, World, Creative. At the bottom, click speed and choose Slowest/Slow/Default/Fast/Faster.
- **Project actions** includes canvas ratio, Performance Mode, Brand assignment, Screen Clip Settings, version history, Make a copy, Copy Transcript, and Download SRT.
- Assign a brand: Project actions → **Brand** → choose brand. **Edit Brands…** routes to Default Brand’s Brand Studio.
- Per-draft screen settings: Project actions → **Screen Clip Settings…** → change controls → **Done**. These are document overrides; they are distinct from Brand Studio > Screen Clips defaults.
- Version history: Project actions → **Show Version History…**. Close with **Close**. Selecting a version performs a content revert.
- Duplicate: Project actions → **Make a copy** immediately creates and opens `Copy of <name>`.
- Captions icon is a direct document/preview toggle, not a popover.
- Composition paint is document-scoped and supports Solid, Linear, Radial, Multi, Image, Shader.
- **Add Music** opens a popover with **Upload background track** (MP3, WAV, M4A), then the macOS file chooser.
- Composer plus menu → **Add Reference…** opens the standard Open dialog. Select a local file and click Open, or Cancel.
- Composer plus menu → **Switch to Media Gen**. Image models: Gemini, GPT Image 1.5, Seedream-4; preferred layout Auto/Landscape/Portrait. Video models: Kling-2.5, Sora-2 Pro, Veo-3.1; duration 5/10 sec and layout Auto/Landscape/Portrait. Model quantity dots set generations; **Save as default** persists the media preference.

## Draft overlays

- Click the timeline overlay picker → **New Blank Overlay**. This creates a four-second Overlay clip and enters overlay editing.
- **Insert** offers Text, Image, Video, Icon, Rectangle, Ellipse, Polygon, Line, Arrow, Pen, Group.
- Insert Text creates centered “New Text.” Compact controls cover sizing mode, Inter/weight/size, alignment, paint, opacity. **See All** adds skew, positioning, scale, min/max dimensions, overflow, highlight, stroke, shadow, blur, motion blur, visibility/hide, and mask.

## Template editor

- Toolbar inserts Group, Text, Media, Shape, Comment. Right panel has duration, opacity, layout, background, motion blur, description, webcam preview, and project-background preview.
- Template options → **Duplicate Template** immediately creates and opens `<name> Copy`.
- Performance and Canvas Size choices apply immediately and close the menu. Publish Template is externally visible; do not use casually.

## Developer controls

- Workspace badge → **Demo mode** Off reveals model and Dev controls; this is an app-level toggle.
- Draft **Dev** → **Show Inspector** exposes Node, Resolved, Collab, PM Doc views and network-delay simulation. Project actions also gains Labels, Messages, and Copy Project ID. These are diagnostics, not normal editing controls.

# Dead ends & quirks

- Brand Studio > Screen Clips is **brand-scoped defaults**; Project actions > Screen Clip Settings is the matching **document-scoped override**. Change the correct scope.
- Brand Studio color defaults and draft composition paint are also different stores/scopes.
- Draft Project actions > Brand assigns the current document; Brand Kits edits brand definitions.
- New Workflow and New Text Style modals only stage rows; page-level **Save Changes** is required.
- New Blank Overlay creates content immediately.
- Download SRT invokes a local save/download and may be blocked by the harness.
- Template and draft duplicate commands act immediately.
- Workspace creation, Invite Members, Sign out, Publish, Export, and routine callbacks can be externally/account visible; avoid unless explicitly requested.
- Standard macOS menu items and disabled window-management/Speech rows are not Yarn surfaces.
- Scratch objects created during exploration and suitable for cleanup: routine **Grounding Scratch Routine Chapter 2**; template **Grounding Scratch Template Chapter 3** and **Grounding Scratch Template Chapter 3 Copy**; workflow **Grounding Scratch Workflow Chapter 4**; text style **Grounding Scratch Text Style Chapter 5**; draft **Grounding Scratch Draft Chapter 7**; collection **Grounding Scratch Collection Chapter 10**; collection draft **Grounding Scratch Collection Draft Chapter 11**; copy **Copy of Grounding Scratch Collection Draft Chapter 11**; an additional collection-created draft initially named **Untitled**; workspace **Grounding Scratch Workspace Chapter 2** was already present in this run’s context.
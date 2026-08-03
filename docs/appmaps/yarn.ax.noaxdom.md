<!-- provenance: explore | app: Yarn | date: 2026-08-03 | backend: ax | actions: 152 | elapsed: 41m | calls: 234 | tokens-in: 2039579 | tokens-out: 33503 | cache-read: 8007168 | cache-write: 0 | findings: 39 | finds: 0 | controls: 102 actuated / 175 dismissed / 450 seen | surfaces: 31 | chapters: 14 | stopped: frontier-empty | descent: off | gated: 0 read / 2 refused -->
<!-- controls actuated/seen is a LOWER BOUND ON BREADTH, not a coverage percentage: the denominator only grows as surfaces are opened, and operating a control is not understanding it. -->
<!-- Written by src/core/explore.ts. DO NOT HAND-EDIT: edits make this a curated recipe, not exploration output — move such notes to docs/curated/<app>.md instead. -->

# Layout

- **Library** is the ordinary landing view and is always reachable from the persistent left rail via **Library**. It has Search, Grid/List, sort, **New Draft**, collection cards, and **New Collection**.
- The persistent rail also contains **Your Drafts**, **Routines**, pinned templates/drafts, **New draft**, **Invite Members**, **Brand Kit**, and **Settings**.
- **Your Drafts** is the private-drafts overview; it mirrors Library search/view/sort/New Draft controls.
- **Routines** lists routines. **New Routine** opens a full-page routine creator/editor.
- **Brand Kit** has a secondary sidebar: Brand Overview, Templates, Workflows, Colors, Type, Screen Clips, Motion, Layout, Misc.
- **Settings** opens a centered modal with preferences, plan/workspace, custom recording sizes, integrations, and team members.
- A draft opens the full **draft editor**: title/script/agent at left, preview canvas at right, timeline below, and document controls across the top.
- A template opens the full **template editor** with Agent/Layers, canvas/timeline, insertion controls, inspector, Export, and Publish Template.

# How to

## Create and edit drafts

1. From Library or Your Drafts, click **New Draft**. First use may show **Create Your Persona**; click **Skip** to enter without uploading, or provide at least one minute of MP3/WAV/MP4/MOV.
2. Edit the title in the top-left title field and scenes in the script pane. **Add scene** inserts a five-second Untitled Scene.
3. Use **Select voice** to choose a voice; **New Persona** opens a sample-upload modal requiring at least one minute of clean audio/video.
4. Use **Composer actions** for **Add Reference…** or **Switch to Media Gen**. In Media Gen, choose Image/Video, then open the model/credit popup.
   - Image models: Gemini, GPT Image 1.5, Seedream-4. Preferred Layout: Auto/Landscape/Portrait.
   - Video models: Kling-2.5, Sora-2 Pro, Veo-3.1. Preferred Duration: 5/10 sec; Layout: Auto/Landscape/Portrait.
5. **Insert** (K) opens Add Text, Add Image or Video, Add Chart, Add Rectangle, Browse Overlay Templates, Open Library, and Record Camera / Screen.
6. **Add Text** creates a selected timeline overlay. Its style popup offers Title/H1/H2/Sub/Body plus font family, weight, letter spacing, size, and line height. These are document-level overrides of Brand Kit text defaults.
7. **Turn on Captions** is an immediate document toggle; the label changes to **Turn off Captions**.
8. **Library** opens **Add from Library**, with Everything/Images/Screen Clips/Webcams/Videos/Projects tabs, search, Upload Video, and Upload Camera Footage.
9. **Add Music** opens an uploader for MP3/WAV/M4A.
10. **New Comment** (C) opens a playhead-anchored composer. The emoji button opens a searchable categorized picker. The arrow sends a workspace-visible comment.

## Draft project settings

- Open **Project actions** for Copy Transcript, Make a copy, Download SRT, Screen Clip Settings, Version History, Brand, aspect ratio, Performance Mode, and Delete.
- **Project actions > Screen Clip Settings…** opens document-scoped recording overrides. These mirror Brand Kit > Screen Clips: cursor visibility/style/scale, screen padding/shadow, sound effects, entrance/exit, motion blur, zoom type/level.
- **Project actions > Show Version History…** opens a right-side panel; versions are saved automatically while editing.
- **Project actions > Brand > Edit Brands…** navigates to Brand Kit for the selected brand and preserves the last-open Brand Kit section.
- Aspect ratios: Widescreen 16:9, Laptop 16:10, Square 1:1, Vertical 9:16. Performance: Efficiency, Default, Ultra. Both apply immediately.
- The top-bar color swatch opens document background painting: Solid, Linear, Radial, Multi, Image, Shader. Image has Upload/Fit/Position; observed Shader preset Watercolor has four colors plus Speed, Seed, Noise, Saturation.
- **Delete** in Project actions deletes the current draft; do not use on user content.

## Library collections

1. Click a collection card to open collection detail.
2. Detail has back to **Your Library**, Search, Grid/List, sort, **New in Collection**, and collection options.
3. **New in Collection** immediately creates and opens a new draft; it does not ask for a type.

## Brand Kit

- **Brand Overview**: edit the brand Overview notes; brand actions are under the ellipsis.
- **Templates**: use Grid/List and sort; **New Template** creates a template. Select one and click **Edit Template…** to enter the editor.
- Template inspector controls include Duration, Opacity, three layout choices, Background, Motion Blur, Description, Webcam Preview, and project background. Insert Group/Text/Media/Shape/Comment from the toolbar.
- **Workflows > New Workflow** creates a workflow. A workflow card opens Edit Workflow with Name, Description, Prompt/Workflow instructions, Cancel, Done, and Delete.
- **Colors**: background/text palettes, Add Background, Add Text Color, paint picker, per-color actions, and Color Notes.
- **Type**: Primary Font, Secondary Font, Text Styles, Font Usage Notes. Editing a style exposes name/preview, family, weight, size, line height, letter spacing, Remove, Cancel, Done. Weight options: Thin through Black.
- **Screen Clips** stores brand defaults for the same recording settings exposed per document under Project actions.
- **Motion**, **Layout**, and **Misc** are brand notes areas with Save Changes/Cancel.

## Routines

1. Click **Routines > New Routine**.
2. Enter Routine name, optional starting project, Delivery (Watch page / MP4 / Draft project), and Agent instructions.
3. The page displays a generated POST endpoint/request body with copy controls.
4. Name plus instructions enables **Add Routine**; after save, the page becomes the routine detail/editor and adds Delete Routine.

## Settings

- **Preferences**: Auto-Add Screen Zooms; Theme Dark/Light/System; Agent model; Agent effort. Theme shortcut is Shift-Command-Backslash.
- Model options observed: Opus 5, Fable 5, Opus 4.8, GPT-5.6 Sol. Effort: Low, Medium, High, Extra High, Max; some models also show Fast Mode.
- Custom recording window sizes have name/dimensions, Remove, and Add Size.
- Lower sections include Upgrade/plan, workspace name/icon, Figma, Google Slides, Notion MCP, YouTube, Screen Studio Import, and Team Members.

# Dead ends & quirks

- **Scope matters:** Brand Kit > Type and Screen Clips define brand defaults; selected text overlays and Project actions > Screen Clip Settings are document overrides. Use the document controls when changing one draft, Brand Kit when changing defaults.
- Draft **Default Brand > Edit Brands…** is navigation to Brand Kit, not a separate per-document brand editor.
- Creating a draft can trigger persona onboarding; **Skip** is the route into the editor without uploading.
- Empty drafts keep Export disabled. Publish/Export/Send/comment actions can be externally visible; do not operate without explicit intent.
- Native macOS Edit > Speech starts/stops system text-to-speech; AutoFill commands are disabled and not Yarn features.
- Native Help search is not a Yarn surface.
- Scratch objects created during exploration and safe for cleanup: **Exploration Scratch Routine 2**, **Exploration Scratch Draft**, **Exploration Scratch Collection**, **Exploration Scratch Collection Draft**, **Copy of Exploration Scratch Collection Draft**, and **Exploration Scratch Template**.
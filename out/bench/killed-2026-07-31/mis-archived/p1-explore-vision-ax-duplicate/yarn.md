<!-- provenance: explore | app: Yarn | date: 2026-07-31 | backend: ax | actions: 132 | elapsed: 34m | calls: 305 | tokens-in: 2085446 | tokens-out: 39467 | cache-read: 14891008 | cache-write: 0 | findings: 43 | finds: 0 | controls: 57 actuated / 1059 dismissed / 1116 seen | surfaces: 35 | chapters: 13 | stopped: frontier-empty | descent: off | gated: 0 read / 2 refused -->
<!-- controls actuated/seen is a LOWER BOUND ON BREADTH, not a coverage percentage: the denominator only grows as surfaces are opened, and operating a control is not understanding it. -->
<!-- Written by src/core/explore.ts. DO NOT HAND-EDIT: edits make this a curated recipe, not exploration output — move such notes to docs/recipes/<app>.md instead. -->

# Layout

## Global navigation
- **Library** is the ordinary landing view. Reach it with **Library** in the left sidebar. It has Search, Grid/List toggles, sort, **+ New Draft**, **+ New Collection**, draft cards, and card ellipsis menus.
- **Your Drafts** in the sidebar opens a drafts-only gallery with Search, Grid/List, sort, **+ New Draft**, and draft-card menus.
- The workspace header opens a popup listing the current workspace plus **New workspace** and **Sign out**.
- Bottom sidebar links: **Invite Members**, **Brand Kit**, and **Settings**.

## Settings
- **Settings** opens a modal over Library. Top preferences: Auto-Add Screen Zooms; Theme (Dark/Light/System); Agent model; Agent effort; Agent Fast Mode default; plan usage and Upgrade.
- Agent models: **Opus 5, Fable 5, Opus 4.8, GPT-5.6 Sol**.
- Agent effort: **Low, Medium, High, Extra High, Max**.
- Click blank space in the right pane, then use **Page Down** to reach lower sections; wheel scrolling was unreliable.
- Lower sections contain Workspace name/icon; Custom window sizes; Figma, Google Slides, Notion, YouTube, and Screen Studio integrations; Team Members.
- Existing custom sizes observed: Default 1440×897 and Custom 1 1600×987. Member ellipsis for the current user contains only **Suspend user**.
- Close Settings with its top-right **X**.

## Brand Kit (brand/workspace-wide defaults)
- **Brand Kit** reopens on the last-used tab. Tabs: **Brand Overview, Templates, Workflows, Colors, Type, Screen Clips, Motion, Layout, Misc**.
- **Brand Overview:** freeform Overview notes and Brand options (Rename Brand, Duplicate Brand, New Brand, Archive Brand).
- **Templates:** Grid/List, sort, New Template, template cards, editable name/description, Edit Template…, and Template options (Duplicate, Move to Brand, Delete).
- **Workflows:** empty in this workspace; offers New Workflow.
- **Colors:** Background and Text palettes plus Color Notes. Swatches open a paint picker with Solid/Linear/Radial/Multi/Image/Shader, hue, opacity, eyedropper, input-format switch, hex, and percentage. Swatch actions: Make Default, Duplicate, Remove.
- **Type:** Primary Font (currently Inter with Light/Regular/Medium/Semibold/Bold/Heavy/Black weights), Secondary Font (None), New Text Style, and Font Usage Notes. Font fields open a searchable, very large catalog.
- **Screen Clips:** brand defaults for cursor, screen display, sound effects, and visual effects. Includes cursor auto-hide/text cursor/style/scale; window padding/shadow/blur/spread/offsets; cursor-click and keyboard sounds; entrance/exit animation; motion blur; default zoom type/level.
- **Motion, Layout, Misc:** freeform notes fields for animation guidance, spacing/alignment rules, and miscellaneous brand guidance.

## Document editor (document scope)
- Open an existing draft card/sidebar draft to enter the editor. Left panel: title, Agent/Script tabs, voice picker, Project actions, scenes/transcript, and agent composer. Center/right: canvas, composition paint, captions, Add Music, Publish, Export, Insert, Add BG, Layers toggle, playback, insert toolbar, Library, Timeline Zoom, and timeline.
- **Project actions:** Copy Transcript, Make a copy, Download SRT…, Screen Clip Settings…, Show Version History…, Brand submenu, aspect ratio, Performance Mode, Delete. Aspect ratios: Widescreen 16:9, Laptop 16:10, Square 1:1, Vertical 9:16. Performance: Efficiency, Default, Ultra.
- **Voice picker:** English, World, Creative tabs plus speed. Current voice observed: Sarah. Speeds: Slowest, Slow, Default, Fast, Faster.
- **Scene ellipsis:** Copy Scene, Copy Transcript, Delete Scene. Empty scenes show inline Delete buttons.
- **Agent composer +:** Add Reference… and Switch to Media Gen.
- Top **Insert** menu: Text, Image, Video, Icon, Rectangle, Ellipse, Polygon, Line, Arrow, Pen, Group.
- **Add Music:** No background track, reusable tracks with preview icons, and upload.
- **Layers** panel may show “No layers” at a sync point.
- **Timeline Zoom:** popover with a continuous minus-to-plus slider.
- **Library:** full-width “Add from Library” modal with Everything, Images, Screen Clips, Webcams, Videos, Projects; per-tab search; media cards; Upload Camera Footage. Card ellipsis contains Delete. Projects are simple project/timestamp rows.
- Insert-toolbar overlay icon opens Graphics/Overlay templates; media icon opens a reusable asset gallery; the record/capture icon launches a separate capture workflow.

# How to

## Return to a stable starting point
1. Click **Library** in the global left sidebar.
2. Confirm the Library gallery is visible rather than leaving a run inside an open draft.

## Inspect a menu or picker safely
1. Open the control.
2. Read the options without selecting one.
3. Press **Escape** with foreground delivery to close it.
- Draft-card ellipses may require **right-click** because they advertise AXShowMenu; a normal click can silently do nothing.

## Change app defaults
1. Open **Settings**.
2. Use the appropriate top preference control.
3. For workspace/integration/member settings, click blank right-pane space and press **Page Down**.
4. Close with **X**.
- These affect app/workspace defaults, not the current document.

## Change brand defaults
1. Click **Brand Kit**.
2. Select the relevant tab.
3. Edit the desired control or notes field.
- **Type, Colors, Screen Clips, Motion, Layout, and Misc here are brand/workspace scope.** Font selection applies immediately.

## Change only the current draft
1. Open the draft.
2. Use **Project actions** for Brand, aspect ratio, Performance Mode, Screen Clip Settings, version history, transcript/SRT operations, or copy/delete actions.
3. Use the editor’s voice, music, background, caption, composition, insertion, and timeline controls for document-specific content/settings.
- Project-level Screen Clip Settings are document scope; Brand Kit > Screen Clips is the brand-wide default location.

## Sort Your Drafts
1. Click **Your Drafts**.
2. Open the sort popup.
3. Choose **Newest first, Oldest first, A - Z,** or **Z - A**.

## Add reusable media to a document
1. In the editor, click **Library**.
2. Choose Everything, Images, Screen Clips, Webcams, Videos, or Projects.
3. Search if needed and select the asset/project to add it.
4. Press Escape to cancel without adding.

# Dead ends & quirks
- **Invite Members** is an externally visible sharing action; do not open casually.
- Workspace creation/sign-out, integrations, Upgrade, Publish, uploads, and account/profile controls change external or persistent state.
- New Draft/Collection/Template/Workflow/Text Style and duplicate/copy/move actions create or change persistent content.
- Delete, Archive Brand, Remove, Suspend user, and library-card Delete are destructive.
- Brand Kit reopens on its last-selected tab, not necessarily Brand Overview.
- Settings wheel scrolling may fail; focus blank right-pane space and use Page Down.
- Font catalogs expose hundreds of rows. Use the search field rather than browsing; selecting a row immediately changes the brand font.
- The Keyboard Presses sound-set picker showed Set A/B/C/D with preview speakers, but AX marked menu rows disabled; preview controls may be separate from choosing the set.
- A canvas press can scrub/select/deselect even if it misses the intended drawn target. Prefer accessible elements; use screenshot pixels only for genuinely painted targets.
- **Avoid the editor record/capture toolbar icon.** It opened a blank inaccessible child, dimmed the editor, and could not be dismissed with Escape, Command-W, Command-`, File > Close All, Hide/Show All, Reload, or Force Reload. Recovery likely requires an external app restart.
- The exploration session ended with the editor visually restored after the blank-child episode, but the ordinary reset location remains **Library**.
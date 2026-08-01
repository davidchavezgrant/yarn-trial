<!-- provenance: explore | app: Yarn | date: 2026-08-01 | backend: ax | actions: 73 | elapsed: 18m | calls: 145 | tokens-in: 1071383 | tokens-out: 20993 | cache-read: 8301568 | cache-write: 0 | findings: 41 | finds: 0 | controls: 49 actuated / 198 dismissed / 1055 seen | surfaces: 33 | chapters: 7 | stopped: frontier-empty | descent: off | gated: 0 read / 0 refused | blackouts: 1 | relaunches: 1 -->
<!-- controls actuated/seen is a LOWER BOUND ON BREADTH, not a coverage percentage: the denominator only grows as surfaces are opened, and operating a control is not understanding it. -->
<!-- Written by src/core/explore.ts. DO NOT HAND-EDIT: edits make this a curated recipe, not exploration output — move such notes to docs/recipes/<app>.md instead. -->

# Layout

## Library (home)
- Dark overview reached with left-rail **Library**. Header: Search, Grid/List, sort, New Draft. Collections row includes New Collection; project cards have inline title fields and ellipsis menus.
- Sort choices: Newest first, Oldest first, A - Z, Z - A.
- Left rail also contains Your Drafts, open documents, New draft, Invite Members, Brand Kits, and Settings.

## Settings
- Open with left-rail **Settings**; close with X.
- Preferences: Auto-Add Screen Zooms; Theme Dark/Light/System; default Agent model (Opus 5, Fable 5, Opus 4.8, GPT-5.6 Sol); default Agent effort (Low/Medium/High/Extra High).
- Workspace: name/icon, custom recording window sizes, integrations, team members. Custom sizes use `WIDTHxHEIGHT`; Add Size immediately appends a row.
- Scope: preference defaults are app/user; workspace name/icon and custom sizes are workspace-level.

## Draft editor
- Left: editable title, Agent/Script tabs, voice picker, Project actions, script editor, agent composer.
- Main: composition Paint, captions, Music, Publish, Export, playback/timeline, overlay/media/text-slide/talk-track/comment insertion, Library picker, Timeline Zoom, Add scene.
- Project actions: Copy Transcript, Make a copy, Download SRT, Screen Clip Settings, Version History, Brand, aspect ratio, Performance Mode, Delete.
- Screen Clip Settings is a document override panel for cursor, window/shadow, click/key sounds, entrance/exit animation, motion blur, and default zoom.
- Voice picker tabs: English, World, Creative; bottom Default Speed control.
- Paint types: Solid, Linear, Radial, Multi, Image, Shader.
- Captions mode provides Presets, font, weight, size, paint, Effects, punctuation visibility, More.
- Music opens a background-track picker with No background track, previews, Remix Music to Fit, and custom upload.
- Timeline overlay insert opens brand templates and New Blank Overlay. Overlay mode has Insert, paint, and detail-panel controls. Insert supports Text, Image, Video, Icon, Rectangle, Ellipse, Polygon, Line, Arrow, Pen, Group.
- Media insert opens an asset grid plus laptop upload.

## Brand Kit
- Open with left-rail **Brand Kits**, then select a kit. Sections: Brand Overview, Templates, Workflows, Colors, Type, Screen Clips, Motion, Layout, Misc.
- Templates: grid/list, sort, New Template, template metadata, Edit Template, options.
- Workflows: New Workflow; editor fields Name, Description, Prompt/Workflow instructions.
- Colors: separate Background and Text palettes, full Paint editor, Add Background/Add Text Color, actions Make Default/Duplicate/Remove, Color Notes.
- Type: Primary/Secondary searchable font fields, weights, Text Styles, Font Usage Notes. Text-style editor fields name, preview text, family, weight, size, line height, letter spacing.
- Screen Clips contains brand defaults matching the draft Screen Clip Settings controls.
- Motion, Layout, Misc are brand-scoped markdown guidance pages.

# How to

## Create a draft
1. From Library click **New Draft** or left-rail **New draft**.
2. Rename through the title field.
3. Enter script in **Type script or # for new scene** or use Agent composer.

## Change a draft’s screen-recording appearance
1. Open the draft.
2. Open **Project actions**.
3. Choose **Screen Clip Settings…**.
4. Adjust controls; click **Done**.
- This changes only that document. For brand defaults use Brand Kit > Screen Clips.

## Change brand screen-clip defaults
1. Open **Brand Kits** and select the intended kit.
2. Click **Screen Clips**.
3. Set cursor, display/shadow, sound, animation, motion-blur, and zoom defaults.
- These are brand-scoped and pair with document overrides of the same names.

## Set a composition paint
1. Open a draft and click the composition paint control.
2. Pick Solid, Linear, Radial, Multi, Image, or Shader.
3. Edit stops/points/colors; gradient endpoints and multi-points are draggable directly on canvas.

## Insert and edit an overlay
1. Put the playhead where needed.
2. Click the first timeline insert button.
3. Choose a template or **New Blank Overlay**.
4. In overlay mode click **Insert** and choose an object type.
5. Select the object; use the top toolbar or right detail panel for position, layout, typography, fill, opacity, highlight, stroke, shadow, blur.

## Edit captions
1. Click the captions status icon.
2. Select the caption box.
3. Use Presets/font/weight/size/paint/Effects and punctuation visibility in the top toolbar.

## Add or edit a brand text style
1. Brand Kit > **Type**.
2. Click **New Text Style** or a row’s **Edit Style**.
3. Set name, preview, family, weight, size, line height, letter spacing.
4. Click **Done**.

## Add a workflow
1. Brand Kit > **Workflows** > **New Workflow**.
2. Fill Name, use-case Description, and Prompt/Workflow instructions.
3. Click **Done**.

# Dead ends & quirks
- Timeline text-slide control opened an inaccessible helper window titled “Untitled”; Escape and Cmd+W did not recover Yarn. Avoid this control in automation.
- Web controls may warn that AXPress is unavailable; ordinary click often still works.
- Text fields are often prefilled: click, Cmd+A, then type.
- Dropdown alternatives normally change the value without opening another surface.
- Brand Screen Clips and draft Screen Clip Settings are different stores: brand defaults versus per-document overrides.
- Motion, Layout, and Misc Brand Kit sections contain only guidance text areas, not numeric presets.
- Scratch artifacts created during mapping and eligible for cleanup include `scratch-draft-map-ch4` (with blank Overlay and “New Text”), `scratch-map-workflow-20250308`, `scratch-map-text-style-20250308`, `scratch-collection-map-7f3a`, scratch templates/brands/copies, and other names beginning `scratch-` or `Copy of scratch-`.
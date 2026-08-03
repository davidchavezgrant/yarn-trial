<!-- provenance: explore | app: Yarn | date: 2026-08-03 | backend: ax | vision: off | actions: 260 | elapsed: 47m | calls: 415 | tokens-in: 2882105 | tokens-out: 55703 | cache-read: 17033216 | cache-write: 0 | findings: 62 | finds: 0 | controls: 136 actuated / 255 dismissed / 1104 seen | surfaces: 47 | chapters: 24 | stopped: frontier-empty | descent: off | gated: 0 read / 4 refused | blackouts: 1 | relaunches: 1 -->
<!-- controls actuated/seen is a LOWER BOUND ON BREADTH, not a coverage percentage: the denominator only grows as surfaces are opened, and operating a control is not understanding it. -->
<!-- Written by src/core/explore.ts. DO NOT HAND-EDIT: edits make this a curated recipe, not exploration output — move such notes to docs/curated/<app>.md instead. -->

# Layout

## Library and navigation
- Yarn normally opens on **Library**. Persistent left rail: workspace selector, **Library**, **Your Drafts**, **Routines**, open drafts/Brand Kits, **New draft**, **Invite Members**, **Brand Kits**, **Settings**.
- Library has Search, Grid/List, sort, **New Draft**, Collections, and project cards. Project-card ellipsis menus require right-click/AXShowMenu.
- **Your Drafts** is a drafts-only gallery with Search, Grid/List, sort, New Draft, and card menus.
- Workspace selector lists workspaces, **New workspace**, Demo mode, and Sign out. New workspace opens a one-field modal and switches to the new empty Library.
- **New Collection** opens a name/color modal; collection pages have Search, Grid/List, sort, New in Collection, options, and Your Library back.

## Draft editor
- New Draft opens the full editor: title, Agent/Script tabs, voice picker, Project actions, composer, canvas/status controls, and timeline.
- Project actions includes transcript/copy/download, Screen Clip Settings, Version History, Brand assignment, aspect ratio, Performance Mode, developer items, and Delete.
- Timeline includes overlay insertion, media upload, text-slide/record, talk-track record, comments, Library, and Timeline Zoom.
- Status bar includes Dev, composition paint, captions, music, Publish, Export.

## Brand Kit
- Reach through Brand Kits or an open Brand Kit rail tab. Tabs: Brand Overview, Templates, Workflows, Colors, Type, Screen Clips, Motion, Layout, Misc.
- Brand options includes Rename, Duplicate, New, Make Default when applicable, and Archive.
- Draft Project actions > Brand > Edit Brands… navigates directly to the assigned brand’s Brand Kit editor.

## Settings and Routines
- Settings modal includes Auto-Add Screen Zooms, Theme, Agent model/effort, model-dependent Fast Mode, plan, workspace, integrations, and team members.
- Routines lists saved routines and New Routine. Editor includes name, optional base project, delivery, instructions, API documentation, and Add Routine.

# How to

## Drafts and cards
1. Click **New draft** or **New Draft**.
2. Edit the title directly.
3. For card operations, return to Library/Your Drafts and right-click the card ellipsis. Menu includes Move, Add to Collection, Rename, Make a copy, Delete.

## Brand, format, and performance
1. Draft > **Project actions**.
2. Brand submenu chooses a workspace brand; this is document assignment.
3. Aspect ratios: Widescreen 16:9, Laptop 16:10, Square 1:1, Vertical 9:16.
4. Performance Mode: Efficiency, Default, Ultra.

## Screen clip settings by scope
- Document: Draft > Project actions > **Screen Clip Settings…**.
- Brand default: Brand Kit > **Screen Clips**.
- Both expose cursor behavior/style/scale, window padding/shadow, cursor/keyboard SFX, entrance/exit, motion blur, default zoom type/level. They are separate stores.

## Voice and composer
- Click **Select voice**; tabs English, World, Creative. Creative includes Cartoon, Cowboy, Demon, Epic Movie Trailer, Grandpa, Mad Scientist, Tough Guy, Wizard. Speed options: Slowest, Slow, Default, Fast, Faster.
- Composer + > **Add Reference…** opens macOS Open.
- Composer + > **Switch to Media Gen**. Generator settings include Gemini, GPT Image 1.5, Seedream-4, per-model quantity, Preferred Layout, Save as default.

## Timeline and overlays
- Media button opens a minimal popover; click laptop-upload.
- **Library** opens Add from Library with Everything, Images, Screen Clips, Webcams, Videos, Projects, search, Upload Camera Footage.
- Comment bubble opens an @Agent composer; submitting creates a collaborator-visible comment.
- **Add Music** accepts MP3/WAV/M4A.
- **Timeline Zoom** is a continuous slider.
- Overlay button > template or **New Blank Overlay**. Insert supports Text, Image, Video, Icon, Rectangle, Ellipse, Polygon, Line, Arrow, Pen, Group.
- Image/Video use laptop-upload. Line/Arrow/Pen enter canvas draw mode; Escape cancels.
- Inspectors use **See All** for advanced positioning, scaling, constraints, appearance, motion blur, visibility, and mask.

## Brand Kit
- **Colors:** click swatch/add tile. Paint tabs Solid, Linear, Radial, Multi, Image, Shader.
- **Type:** New Text Style; name, preview, font family/weight/size, line height, letter spacing, Done.
- **Templates:** Grid/List, sort, New Template; selected template shows name/description, Edit Template, options.
- **Workflows:** New Workflow or select row; Name, Description, Prompt, Delete, Cancel, Done.
- Motion/Layout/Misc are notes pages with Save/Cancel.
- Brand options > Rename makes the title editable; New Brand immediately creates an Untitled Brand.

## Routines
1. Routines > **New Routine**.
2. Set name, optional base project, delivery, instructions.
3. MP4 requires callback URL; Draft project creates an editable Yarn project; Watch page is default.
4. Click Add Routine; the saved editor remains and exposes Delete Routine.

# Dead ends & quirks
- **Critical automation dead end:** timeline text-slide/record and adjacent record-talk-track buttons opened a blank separate “Untitled” Yarn window with no addressable content. Escape and Cmd+W did not recover. Avoid both.
- Project-card ellipsis often requires right-click.
- Do not revert user Version History or use destructive/external actions on user content.
- File-based operations use native macOS Open dialogs.
- Captions appeared to be a direct toggle; no settings surface appeared in an empty draft.
- Scratch cleanup candidates: Grounding Scratch Workspace Chapter 18; Grounding Scratch Collection Chapter 19; scratch brands/copies; Grounding Scratch Draft Chapter 23; Grounding Scratch Routine; scratch templates/copies.
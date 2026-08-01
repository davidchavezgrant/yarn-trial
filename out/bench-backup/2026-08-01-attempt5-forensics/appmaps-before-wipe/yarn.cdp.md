<!-- provenance: explore | app: Yarn | date: 2026-07-31 | backend: cdp | actions: 118 | elapsed: 36m | calls: 333 | tokens-in: 973711 | tokens-out: 52608 | cache-read: 8433152 | cache-write: 0 | findings: 45 | finds: 0 | controls: 55 actuated / 1933 dismissed / 1985 seen | surfaces: 63 | chapters: 11 | stopped: frontier-empty | descent: off | gated: 0 read / 4 refused -->
<!-- controls actuated/seen is a LOWER BOUND ON BREADTH, not a coverage percentage: the denominator only grows as surfaces are opened, and operating a control is not understanding it. -->
<!-- Written by src/core/explore.ts. DO NOT HAND-EDIT: edits make this a curated recipe, not exploration output — move such notes to docs/recipes/<app>.md instead. -->

# Layout

## Library and workspace chrome
- **Library** (`/library/ag`) is the ordinary landing view. Left sidebar **Library** returns here from editors. It shows Collections, **New Collection**, Search, Grid/List, sort, **New Draft**, and draft cards.
- **Your Drafts** (`/library/drafts`) is the draft-only version with the same search/view/sort/new-draft/card interactions.
- Top-left **David's Workspace** opens a menu with the current workspace, **New workspace**, and **Sign out**.
- Draft-card ellipsis menu: **Move to David's…**, **Rename**, **Make a copy**, **Delete**. Sort menu: **Newest first**, **Oldest first**, **A - Z**, **Z - A**.
- Bottom-left chrome: **Invite Members**, **Brand Kit**, **Settings**.

## Settings
- **Settings** opens a modal and adds `#settings/subscription` to the URL.
- Preferences: Auto-Add Screen Zooms; Theme (Dark/Light/System, shortcut Shift+Command+\); default Agent model; default Agent effort; Agent Fast Mode default.
- Agent models: Opus 5, Fable 5, Opus 4.8, GPT-5.6 Sol. Effort: Low, Medium, High, Extra High, Max.
- Plan section shows Free usage and Upgrade.
- Workspace section: workspace name, icon upload, recording sizes (Default 1440×897; Custom 1 1600×987; Add Size/remove rows).
- Integrations: Figma, Google Slides, Notion MCP, Team YouTube, Personal YouTube. Also Screen Studio Import.
- Team Members: Invite Members, member row, row ellipsis → **Suspend user**.

## Brand Kit (brand scope)
- **Brand Overview**: brand identity/notes field; brand ellipsis → Rename Brand, Duplicate Brand, New Brand, Archive Brand.
- **Templates**: Grid/List, newest/A-Z sorting, New Template, template cards. Selecting a card opens details with name, **Edit Template…**, ellipsis, and description. Ellipsis → Duplicate Template, Move to Brand, Delete Template.
- **Workflows**: workflow list; currently empty with **New Workflow**.
- **Colors**: Background and Text palettes plus Color Notes. Each swatch has a paint picker and actions menu (Make Default, Duplicate, Remove). Add Background/Add Text Color use paint pickers. Current background colors: #6985FF default, #26272A, #EDEEF8, #000000; text colors: #6985FF, #FFFFFF, #505155, #14181E.
- **Type**: Primary Font (currently Inter and its available weights), Secondary Font (None), Text Styles/New Text Style, Font Usage Notes. Font cards open a searchable, very large font-family picker.
- **Screen Clips**: brand defaults for future projects: Auto-Hide Cursor, Text Cursor, Cursor Style/Scale, window padding, shadow controls, Cursor Clicks and Keyboard Presses plus sound pickers, Entrance/Exit Animation, Motion Blur, cursor motion. Current defaults include Auto Hide, Hide text cursor, Arrow-first, 1.60 scale, padding 18, shadows 72%/32/-18/0/12, Fade Up, Medium blur, Glide.
- **Motion**, **Layout**, **Misc** are guidance-note pages, not structured setting panels.

## Template Editor (template/document scope)
- Opens from Templates → select template → **Edit Template…**.
- Has title, New template, options, composer, Export/Publish, Play, Add Group/Text/Media/Shape, Comment, and right Template inspector.
- Options: Duplicate/Delete; Performance Mode (Efficiency/Default/Ultra); Canvas Size (16:9, 16:10, 9:16, 1:1); Loop toggle.
- Inspector includes duration, opacity, description, background, motion blur, webcam preview, and project-background preview.

## Draft editor (document scope)
- Open a draft card to enter `/ag-editor/{id}`. Left column has **Agent** and **Script** tabs; central preview/timeline; project toolbar and actions.
- Top/project controls include title, background paint, comments, Add Music, captions toggle, Export, Add BG, Project actions, Composer, Publish, Insert, Layers toggle, playback/timeline, Add Scene.
- **Project actions → Screen Clip Settings…** opens per-document screen-recording settings mirroring Brand Kit defaults, with an additional Default Zoom Level. These are overrides for the open draft.
- **Project actions → Show Version History…** opens a right panel of timestamped versions; selecting one reverts the document.
- **Project actions → Brand** submenu shows current brand and **Edit Brands…**.
- Composer ellipsis: **Add Reference…**, **Switch to Media Gen**. Media Gen has Image/Video modes and model/credit pickers.
- Image models: Gemini, GPT Image 1.5, Seedream-4; generation count dots, Save as default, Preferred Layout Auto/Landscape/Portrait.
- Video models: Kling-2.5, Sora-2 Pro, Veo-3.1; generation count dots, Save as default, duration 5/10 sec, Preferred Layout Auto.
- Add Music opens a track picker with No background track, listed tracks, preview icons, and upload.
- Select a text/caption overlay to expose inline Presets, font, weight, size, color, Effects, visibility/status, and ellipsis.
- Insert menu: Text, Image, Video, Icon, Rectangle, Ellipse, Polygon, Line, Arrow, Pen, Group.
- Add Image or Video opens the asset grid with image/video thumbnails and upload.
- Timeline toolbar includes Add Image or Video, Record Camera / Screen, Record Talk Track (T), New Comment (C), and Timeline Zoom.

# How to

- **Return home:** click sidebar **Library**.
- **Open/edit a draft:** Library → click draft card. Use **Agent** for chat/composer and **Script** for scene text/durations.
- **Open a draft card menu:** click the card’s ellipsis, not the card body.
- **Sort Library/Your Drafts:** click the unlabeled sort icon beside Grid/List → choose Newest first, Oldest first, A - Z, or Z - A.
- **Change future-project screen-clip defaults:** Brand Kit → Screen Clips → adjust controls. This is **brand scope**.
- **Change only the current draft’s screen-clip behavior:** open draft → Project actions → Screen Clip Settings… → adjust controls. This is **document scope**. Do not use Brand Kit for a one-off override.
- **Manage brand type:** Brand Kit → Type → click Primary or Secondary Font → type in Search fonts → choose family. Selection applies immediately and persists to the brand.
- **Edit a brand template:** Brand Kit → Templates → select template → Edit Template….
- **Open template options:** in Template Editor click options/ellipsis; use nested Performance Mode or Canvas Size choices, or Loop.
- **Open version history:** draft → Project actions → Show Version History…. Close with **Close**; selecting a row performs a revert.
- **Reach Brand Kit from a draft:** Project actions → hover Brand → Edit Brands…. It opens the Brand Kit’s last-used subsection.
- **Use Media Gen:** draft composer ellipsis → Switch to Media Gen → choose Image or Video → click the model/credit label (for example Multi 21 cr or Multi 630 cr) → configure model/count/layout/duration → Send. Sending consumes credits.
- **Return from Media Gen:** composer actions → switch back to the normal composer.
- **Add music:** click Add Music → optionally preview tracks → select a track. Selection changes the draft; upload may open a native file picker.
- **Open document asset picker:** click Add Image or Video in the editor/timeline → choose an existing thumbnail. Upload may open a native picker.
- **Inspect scene commands:** Script tab → scene ellipsis → Copy Scene, Copy Transcript, or Delete Scene.
- **Add a comment:** click New Comment (C), edit the composer (prefilled `@Agent`), then send. Escape closes without sending.
- **Change project background:** click top-left color swatch → choose Solid/Linear/Radial/Multi/Image/Shader. Linear exposes stop rows, flip, rotate 90°, add stop, position, hex, opacity. Paint-type changes apply immediately.
- **Open Layers:** click far-right rectangle/Layers icon. In the observed draft it showed “No layers.”

# Dead ends & quirks

- **Scope warning:** Brand Kit → Screen Clips controls future/default brand values; draft → Screen Clip Settings controls only the open document. They are separate stores even when values look identical.
- Brand Kit Motion and Layout contain only prose guidance, not animation/layout defaults.
- Brand editing from a draft is under Project actions → Brand → Edit Brands…, and opens the Brand Kit’s last-used subsection rather than a separate picker.
- Settings is a modal route overlay, not a standalone sidebar page.
- Publish and Export are guarded/potentially external actions and could not be inspected safely. Publish may be one-way/external.
- Recording controls may begin capture or request permissions; they were identified by hover only.
- Upload controls may invoke native file pickers, which are not driveable through this UI backend.
- Integrations, YouTube sign-ins, workspace/account changes, member suspension, invitations, upgrades, and sign-out were not invoked.
- Version rows revert content; template/draft/card menus contain persistent duplicate/move/rename/delete actions; these were inspected but not executed.
- Font selection, paint-type selection, and many picker choices apply immediately; use Escape to close without selecting.
- Text Styles and Font Usage Notes info icons produced no visible additional help surface in this build.
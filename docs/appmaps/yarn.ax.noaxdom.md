<!-- provenance: explore | app: Yarn | date: 2026-08-01 | backend: ax | actions: 140 | elapsed: 27m | calls: 220 | tokens-in: 1448586 | tokens-out: 28504 | cache-read: 8284672 | cache-write: 0 | findings: 40 | finds: 0 | controls: 86 actuated / 227 dismissed / 483 seen | surfaces: 39 | chapters: 13 | stopped: frontier-empty | descent: off | gated: 0 read / 1 refused | blackouts: 1 | relaunches: 1 -->
<!-- controls actuated/seen is a LOWER BOUND ON BREADTH, not a coverage percentage: the denominator only grows as surfaces are opened, and operating a control is not understanding it. -->
<!-- Written by src/core/explore.ts. DO NOT HAND-EDIT: edits make this a curated recipe, not exploration output — move such notes to docs/recipes/<app>.md instead. -->

# Layout

- **Library** is the ordinary landing view. Return with the left-rail **Library** button. It has Search, Grid/List, sort, **New Draft**, **New Collection**, collections, and draft cards with per-card action popups.
- **Your Drafts** is a separate workspace-scoped list for drafts not filed in a collection. It repeats Search, Grid/List, sort, New Draft, and card actions.
- The top-left workspace popup lists workspaces and provides **New workspace** and **Sign out**.
- **Settings** opens a modal. Top preferences cover Auto-Add Screen Zooms, Theme, default Agent model, and default Agent effort. Scroll inside the modal/Page Down for workspace name/icon, custom window sizes, integrations, Screen Studio Import, and Team Members.
- **Brand Kits** at bottom-left is a brand switcher. Brand creation is instead under a Brand Kit header’s **Brand options** menu.
- A **Brand Kit** has Brand Overview, Templates, Workflows, Colors, Type, Screen Clips, Motion, Layout, and Misc. Brand Overview/Motion/Layout/Misc are notes surfaces; Colors, Type, Screen Clips, Templates, and Workflows contain richer editors.
- A **draft editor** has title, Agent/Script tabs, voice picker, Project actions, script area, agent composer, preview, timeline, paint/comment/music, Publish, and Export. Composer actions can switch to Media Gen.
- A **template editor** is a full canvas/timeline editor with Agent/Layers, composer, Group/Text/Media/Shape/Comment insertion, right inspector, Export, and Publish Template.
- A **collection** has back **Your Library**, Search, Grid/List, sort, **New in Collection**, and collection actions.

# How to

## Create and edit drafts

1. From Library or Your Drafts, click **New Draft**. It immediately creates an Untitled draft and opens the editor.
2. Click the title, select all, and type the new name.
3. Use **Script** and type into **Type script or # for new scene**; `#` is the scene-entry affordance.
4. Use **Select voice** to choose a voice; its nested **Default Speed** offers Slowest, Slow, Default, Fast, and Faster.
5. Open **Project actions** for Copy Transcript, Make a copy, Download SRT, Screen Clip Settings, Version History, Brand, aspect ratio, Performance Mode, and Delete.
6. Aspect ratio and Performance Mode here are document-scoped overrides.

## Change screen-recording settings at the correct scope

- **Brand defaults:** Brand Kit → **Screen Clips**.
- **One draft only:** draft → **Project actions** → **Screen Clip Settings…**.
- Both surfaces expose the same underlying settings: cursor auto-hide, text cursor, cursor style, cursor scale, window padding/shadow, cursor and keyboard sounds, entrance/exit animation, motion blur, default zoom type, and default zoom level.
- Cursor Style options are Arrow-first, Pointer-first, and Original. The document and brand controls are separate stores despite matching labels.

## Use Media Gen

1. Draft composer → **Composer actions** → **Switch to Media Gen**.
2. Choose Image or Video.
3. Image models: Gemini, GPT Image 1.5, Seedream-4. Video models: Kling-2.5, Sora-2 Pro, Veo-3.1.
4. Model popups also set generation count, preferred layout, and **Save as default**; video adds 5 sec/10 sec duration.
5. Entering a prompt and pressing Send starts generation and consumes credits; merely changing model preferences applies immediately.

## Add and edit a blank overlay

1. In a draft timeline, open the first unlabeled A-card popup.
2. Choose **New Blank Overlay**. This creates a four-second Overlay clip and enables Export.
3. Use overlay **Insert** for Text, Image, Video, Icon, Rectangle, Ellipse, Polygon, Line, Arrow, Pen, or Group.
4. Insert → **Text** creates a centered “New Text” layer and exposes paragraph/style, font, weight, size, alignment, paint, opacity, and actions controls.
5. The second unlabeled stacked-image timeline popup opens the media library; its bottom upload button opens the standard macOS Open chooser.

## Create a collection

1. Library → **New Collection**.
2. Replace the default name, choose one of eight color swatches, then click **Create Collection**.
3. The new collection opens immediately. Use **New in Collection** to create content directly inside it.

## Create and manage brands

1. Open any Brand Kit and use header **Brand options** → **New Brand**. This immediately creates and opens **Untitled Brand**; there is no modal.
2. Brand options → **Rename Brand** changes the heading to an inline field; replace the value and click **Done**.
3. **Duplicate Brand** immediately creates and opens `<name> Copy`.
4. On a non-primary brand, **Make Default** applies immediately without confirmation.
5. Bottom-left **Brand Kits** only switches/open brands; it does not create them.

## Edit brand content

- **Overview/Motion/Layout/Misc:** edit the notes textarea, then use **Save Changes** where shown.
- **Colors:** edit Background or Text Color swatches, Color Notes, then Save Changes. Paint modes are Solid, Linear, Radial, Multi, Image, and Shader. Linear exposes gradient stops, position/color/opacity, flip, rotate 90°, and add stop.
- **Type:** click Primary Font or Secondary Font, or **New Text Style**. A text style requires name, preview text, Font Family, Font Weight, Font Size, Line Height, and Letter Spacing; click Done, then **Save Changes** on the Type page.
- **Workflows:** click **New Workflow**, fill Name, Description, and Prompt, then Done; afterward use **Save Changes** on the Workflows page. Click a workflow row to edit it.
- **Templates:** Templates → **New Template** opens the full editor. The editable title is at top-left; insertion controls and timeline are along the bottom.

## Settings

- Settings → Agent model: Opus 5, Fable 5, Opus 4.8, GPT-5.6 Sol.
- Settings → Agent effort: Low, Medium, High, Extra High, Max.
- Theme options: Dark, Light, System; shortcut Shift+Cmd+\.
- For lower workspace settings, click inside the modal and Page Down/scroll.
- Screen Studio Import → **Import** opens a standard macOS Open chooser directly.

# Dead ends & quirks

- Empty drafts have Export disabled until timeline content exists.
- New Brand and Duplicate Brand act immediately; they do not open confirmation dialogs.
- Make Default also applies immediately.
- Workflows need all three fields before Done enables, and the page still requires Save Changes.
- Brand text styles similarly require modal Done followed by page-level Save Changes.
- The file chooser Search control is the small search icon inside the Search field; Cancel closes without importing.
- Avoid expanding macOS menu hierarchies and dismissing them with Escape: this driver previously produced several blank observations and forced an app restart. Prefer clicking a menu command or outside target.
- Publish, Publish Template, Invite Members, integrations, Sign out, and generation Send are externally visible/committing actions and were not executed.
- Scratch objects created for cleanup: workspace **Scratch Workspace Map M11**; drafts **Scratch Draft Map M11** and **Scratch Draft Script Map M11** (the rail also showed one **Untitled** scratch draft); template **Scratch Template Map M11**; workflow **Scratch Workflow Map M11**; brand text style **Scratch Text Style Map M11**; collection **Scratch Collection Map M11**; brands **Scratch Brand Map M11** and **Scratch Brand Map M11 Copy**. The script-map draft contains a blank overlay with a “New Text” layer.
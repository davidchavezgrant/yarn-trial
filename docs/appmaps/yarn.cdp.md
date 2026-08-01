<!-- provenance: explore | app: Yarn | date: 2026-08-01 | backend: cdp | actions: 177 | elapsed: 29m | calls: 244 | tokens-in: 906922 | tokens-out: 37430 | cache-read: 3690496 | cache-write: 0 | findings: 43 | finds: 0 | controls: 119 actuated / 32 dismissed / 293 seen | surfaces: 12 | chapters: 17 | stopped: frontier-empty | descent: off | gated: 0 read / 2 refused -->
<!-- controls actuated/seen is a LOWER BOUND ON BREADTH, not a coverage percentage: the denominator only grows as surfaces are opened, and operating a control is not understanding it. -->
<!-- Written by src/core/explore.ts. DO NOT HAND-EDIT: edits make this a curated recipe, not exploration output — move such notes to docs/recipes/<app>.md instead. -->

# Layout

## Library
- Ordinary landing view: **Library** at `/library/ag`; return with the persistent left-sidebar **Library** button.
- Sidebar: workspace switcher, Library, Your Drafts, existing brands/drafts, New draft, Invite Members, Brand Kits, Settings.
- Main Library controls: Search, Grid/List view, sort, **New Draft**, and **New Collection**.

## Brand Kit
- Open **Brand Kits** from the sidebar. Brand pages use `/brands?brandId={id}`.
- Internal rail: **Brand Overview, Templates, Workflows, Colors, Type, Screen Clips, Motion, Layout, Misc**.
- Brand Overview: overview notes and an ellipsis menu with New Brand, Duplicate Brand, Make Default, and related brand operations.
- Templates: Grid/List, sort, **New Template**, list, and right-side details pane.
- Workflows: brand-scoped workflow list/editor.
- Colors: brand-scoped Background and Text palettes, notes, and Save Changes/Cancel.
- Type: brand-scoped primary/secondary fonts, text styles, and usage notes.
- Screen Clips: brand-level defaults for cursor, display/shadow, sound, entrance/exit, motion blur, and zoom-related behavior.
- Motion, Layout, Misc: brand-scoped notes fields with pending Save Changes/Cancel behavior.

## Template editor
- **New Template** immediately creates a template and opens `/template-editor/{id}`; there is no wizard.
- Header: brand link, editable title, New template, Template options, Agent/Layers, version, Export, Publish Updates.
- Canvas/editor controls include Play, Group, Text, Media, Shape, Auto Hide Layers, timeline, composer, and right inspector.
- Template options contain performance mode, canvas size, Loop, Duplicate Template, and Delete.

## Draft editor
- **New draft** immediately creates a draft and opens `/ag-editor/{id}`.
- Header/editor: editable title, Agent/Script, Select voice, Project actions, composer, canvas background picker, Add Music, Publish, Export, playback, object toolbar, timeline, Timeline Zoom, and Add scene.
- **Project actions** contains Screen Clip Settings…, Show Version History…, Make a copy, Copy Transcript, canvas size, Brand, Performance Mode, and Delete.
- Screen Clip Settings is a right-side document-scoped panel; Version History is a separate right-side panel.

## Settings
- **Settings** opens an in-page modal and changes the hash to `#settings/subscription`.
- Preferences include Auto-Add Screen Zooms, Theme, Agent model, Agent effort, and conditional Agent Fast Mode default.
- Also contains plan/credits, workspace name and custom sizes, integration sign-ins, Import, Invite Members, Team Members, profile photo, and Sign out.
- Close with the top-right unlabeled X.

# How to

## Create and manage brands
1. Sidebar **Brand Kits** → Brand Overview → brand ellipsis.
2. **New Brand** creates and opens an `Untitled Brand` immediately; rename/edit from its Overview.
3. **Duplicate Brand** creates and opens `{source} Copy` immediately.
4. **Make Default** changes the workspace default immediately, with no confirmation or visible default badge.

## Create a template
1. Brand Kits → **Templates** → **New Template**.
2. The new template opens immediately in the template editor.
3. Edit the title in the header.
4. Use **Template options** for:
   - Performance Mode: Efficiency / Default / Ultra.
   - Canvas size: Widescreen 16:9 / Widescreen 16:10 / Portrait 9:16 / Square 1:1.
   - Loop On/Off.
   - Duplicate Template or Delete.
- These controls are template/document scoped and apply immediately.

## Create a workflow
1. Brand Kits → **Workflows** → **New Workflow**.
2. Enter name and description in the inline editor.
3. Choose **Save Changes**; Cancel abandons pending edits.

## Edit brand colors
1. Brand Kits → **Colors** → click a swatch’s **Open paint picker**.
2. Choose Solid, Linear, Radial, Multi, Image, or Shader.
3. Linear/Radial expose Flip, Rotate 90°, Add gradient stop, and per-stop position/color/opacity/remove controls.
4. Use page-level **Save Changes** to commit brand edits or **Cancel** to abandon them.

## Edit brand type
1. Brand Kits → **Type**.
2. Type into the Primary or Secondary **Search fonts...** textbox and choose a font.
3. **New Text Style** opens a modal for name, Preview text, Font Family, Font Weight, Font Size, Line Height, and Letter Spacing.
4. **Done** adds the style to the page; then use page-level **Save Changes** to commit it.

## Create or duplicate a draft
1. Sidebar **New draft** creates and opens a draft immediately.
2. Rename it using the header title textbox.
3. To duplicate: **Project actions** → **Make a copy**. The copy opens immediately as `Copy of {source title}`.

## Set a draft’s brand, canvas, and performance
- **Project actions** → **Brand** → choose a brand. This changes only the current draft and applies immediately.
- **Edit Brands…** leaves the editor and navigates to Brand Kit.
- Project actions canvas sizes: Widescreen (16:9), Laptop (16:10), Square (1:1), Vertical (9:16).
- Performance Mode: Efficiency, Default, Ultra.
- Canvas size and performance choices are document scoped and apply immediately.

## Configure screen clips at the correct scope
- Brand default: Brand Kits → **Screen Clips**.
- Current draft override: Draft editor → **Project actions** → **Screen Clip Settings…**.
- These two surfaces edit the same underlying settings at different scopes. Always choose the requested scope.
- Shared settings include Auto-Hide Cursor, Text Cursor, Cursor Style/Scale, Screen Window Padding, shadow opacity/blur/spread/X/Y, Cursor Clicks, Keyboard Presses, Entrance/Exit Animation, and Motion Blur.
- Cursor Style options include Arrow-first, Pointer-first, Original.
- Sound rows have enable checkboxes plus sound/set and loudness selectors.
- Entrance/Exit opens a two-tab picker:
  - Enter: Appear, Fade In, Fade Up/Down/Left/Right, Scale Up/Down.
  - Exit: Disappear, Fade Out, Fade Up/Down/Right/Left, Scale Up/Down.
- Draft panel also has Default Zoom Type:
  - Glide hides Fixed Zoom Easing.
  - Fixed exposes Smooth, Ease In-Out, Expo In-Out.
  - Default Zoom Level remains available for either type.
- Choices apply immediately in the panel; click **Done** to close.

## Choose a voice
1. Draft editor → **Select voice**.
2. Pick English, World, or Creative; adjust Default Speed if needed.
3. Choose a voice; it applies immediately and closes the picker.
- English includes Annie, Brynn, Cassidy, Fay, Jacob, Jada, James, Jeff, Kendra, Miranda, Robert, Sarah.
- World contains language-tagged German, Danish, Spanish, French, Italian, Japanese, Dutch, and Swedish voices.
- Creative includes Cartoon, Cowboy, Demon, Epic Movie Trailer, Grandpa, Mad Scientist, Tough Guy, Wizard.

## Add scenes
- Draft editor → **Add scene** appends an `Untitled Scene` immediately and increases duration.
- Each scene has its own Delete control.

## Switch composer modes and add references
- Composer actions → **Switch to Agent** or **Switch to Media Gen**.
- In Agent mode, Composer actions also shows **Add Reference...**.
- Add Reference invokes a native file chooser, which is outside this UI driver.

## Inspect version history
1. Draft editor → Project actions → **Show Version History...**.
2. A right panel lists timestamped autosaves and author.
3. Close with **Close**.
- Selecting an old version can revert the draft; reverts can be undone.

## Change a draft background
1. Click canvas **Open paint picker**.
2. Choose Solid, Linear, Radial, Multi, Image, or Shader.
3. Radial/Linear expose on-canvas handles and gradient stop controls.
4. Multi exposes point handles, Add multi-point gradient stop, remove, opacity, and Blend.
5. Image exposes Upload image, Fit, and Position.
6. Shader currently offers Watercolor with Base/Mid Accent/Accent colors plus Speed, Seed, Noise, and Saturation.
- This changes only the current draft.

## Change app preferences
1. Sidebar **Settings**.
2. Change Auto-Add Screen Zooms, Theme, Agent model, or Agent effort; preferences apply immediately.
3. Selecting Agent model **Opus 5** reveals **Agent Fast Mode default**, which controls whether new agent chats start in Fast Mode.

# Dead ends & quirks
- Create, duplicate, default, delete, and association actions frequently apply immediately without a wizard or confirmation.
- **Delete** in draft Project actions deleted an owned scratch immediately and returned to Library. Never use it on user content.
- Template/draft Duplicate opens the newly created copy immediately.
- Add Reference and image Upload cross into native file pickers, which cannot be driven through this page backend.
- Copy Transcript copies immediately with no confirmation UI.
- Voice selection may leave the trigger as an unlabeled icon rather than displaying the selected voice name.
- Team Members → current user ellipsis → Suspend user produced no confirmation or visible change; do not rely on it for self-removal.
- Version-history rows were not distinct accessible controls in this run; avoid reverting user content.
- Settings is an overlay, not a full page; URL hash changes while it is open.
- Scratch objects created by this exploration and safe for cleanup include brandId 261 `Scratch Explore Brand 261`, brandId 262 `Scratch Explore Brand 261 Copy`, templateIds 1101 and 1102, workflow `Scratch Explore Workflow 261`, text style `Scratch Explore Text Style 261`, and draftId 1169379015 `Copy of Scratch Explore Draft 1576458640`. The original scratch draftId 1576458640 was deleted during exploration.
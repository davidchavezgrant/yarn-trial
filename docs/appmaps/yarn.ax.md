<!-- provenance: explore | app: Yarn | date: 2026-08-01 | backend: ax | actions: 131 | elapsed: 24m | calls: 203 | tokens-in: 1312823 | tokens-out: 29690 | cache-read: 9075712 | cache-write: 0 | findings: 25 | finds: 0 | controls: 71 actuated / 188 dismissed / 1008 seen | surfaces: 27 | chapters: 12 | stopped: frontier-empty | descent: off | gated: 0 read / 3 refused -->
<!-- controls actuated/seen is a LOWER BOUND ON BREADTH, not a coverage percentage: the denominator only grows as surfaces are opened, and operating a control is not understanding it. -->
<!-- Written by src/core/explore.ts. DO NOT HAND-EDIT: edits make this a curated recipe, not exploration output — move such notes to docs/recipes/<app>.md instead. -->

# Layout

- **Library** is the ordinary landing view. Return with the left-sidebar **Library** button. It has Collections / **New Collection**, Search, Grid/List, sort, and **New Draft**. Existing cards and collections are user content.
- **Your Drafts** is a separate private-drafts list reached from the left sidebar; it has the same search/view/sort/New Draft controls.
- The workspace-name popup at top left opens the **workspace switcher**, listing workspaces, **New workspace**, and Sign out.
- **Brand Kit** is the workspace/brand-default area. Its tabs are **Brand Overview, Templates, Workflows, Colors, Type, Screen Clips, Motion, Layout, Misc**.
  - Overview: editable Overview notes and brand-options ellipsis.
  - Templates: **New Template** opens the full template editor.
  - Workflows: **New Workflow** and editable workflow rows.
  - Colors: Background paints, Text Colors, and Color Notes; swatches open the full paint picker.
  - Type: Primary/Secondary Font, Text Styles, and Font Usage Notes.
  - Screen Clips: workspace/brand-default recording appearance and behavior.
  - Motion/Layout/Misc: brand guidance text areas.
- **Settings** opens as a modal over the current page. It contains Preferences, plan, Workspace settings, Integrations, and Team Members in one vertically scrolling panel.
- **Draft editor** opens immediately from New Draft or a draft card. It has Agent/Script tabs at left, canvas and timeline center, document properties/actions, voice, captions, music, insert/record/comment controls, Publish and Export.
- **Template editor** is a separate full editor reached from Brand Kit > Templates > New Template. It has Agent/Layers, canvas/timeline, insert controls, template properties, Play, Export, and Publish Template.

# How to

## Create and rename a draft
1. From Library or Your Drafts, click **New Draft**.
2. In the editor, click the title field, press Command+A, type the new name, then Return.
3. The title and sidebar tab update immediately.

## Change a setting for only the current draft
1. Open the draft.
2. Open **Project actions**.
3. Choose **Screen Clip Settings…**.
4. Change the desired control and click **Done**.

This is document scope. Do not use Brand Kit when the request applies only to one draft.

## Change workspace/brand screen-clip defaults
1. Click **Brand Kit** in the sidebar.
2. Open **Screen Clips**.
3. Adjust Cursor, Screen Display, Sound Effects, Visual Effects, Default Zoom Type, or Default Zoom Level.
4. Click **Save Changes**; use **Cancel** to restore the prior values.

Brand Kit Screen Clips and Draft Editor Screen Clip Settings expose the same underlying settings at different scopes.

## Assign or edit a draft brand
1. In a draft, open **Project actions > Brand**.
2. Choose the brand assignment, or choose **Edit Brands…** to navigate to that brand’s Brand Kit.

## Change draft aspect ratio or performance mode
- **Project actions** > choose Widescreen 16:9, Laptop 16:10, Square 1:1, or Vertical 9:16. Selection applies immediately.
- **Project actions > Performance Mode** > Efficiency, Default, or Ultra. Selection applies immediately.

## Open version history
1. In a draft, open **Project actions**.
2. Choose **Show Version History…**.
3. A top-right history panel opens. Versions save automatically; revert is available and can itself be undone.

## Create a workflow
1. Go to **Brand Kit > Workflows > New Workflow**.
2. Fill Name, Description, and Prompt; **Done** is disabled until required fields are valid.
3. Click **Done**; the workflow appears in an unsaved edit state.
4. Click **Save Changes** to persist, or Cancel.

## Create a text style
1. Go to **Brand Kit > Type > New Text Style**.
2. Enter a non-default name; set preview text, Font Family, Font Weight, Font Size, Line Height, and Letter Spacing.
3. Click **Done**, then **Save Changes** on the Type page.
4. Existing style rows have drag reorder and **Edit Style**.

## Edit brand colors
1. Go to **Brand Kit > Colors**.
2. Click a Background or Text Color swatch, or use Add Background/Add Text Color.
3. Pick Solid, Linear, Radial, Multi, Image, or Shader.
4. Solid supports hue/opacity, eyedropper, input-format switch, hex, and opacity. Linear supports stop position/color/opacity, add stop, flip, and rotate 90°.
5. Save Changes or Cancel.

## Change brand fonts
1. Go to **Brand Kit > Type**.
2. Click Primary Font or Secondary Font.
3. Search the large font list and select a font.
4. Review the weight preview, then Save Changes or Cancel.

## Create a template
1. Go to **Brand Kit > Templates > New Template**.
2. Name the template in the full editor.
3. Use Agent/Layers, canvas/timeline, Group/Text/Media/Shape/Comment insert controls, and right-side properties (Duration, Opacity, Layout, Background, Motion Blur, Description, Webcam Preview, Project BG Preview).
4. **Publish Template** is externally visible; do not use it unless explicitly requested.

## Change Settings preferences
1. Click **Settings** in the sidebar.
2. Preferences include Auto-Add Screen Zooms, Theme, Agent model, Agent effort, and Agent Fast Mode default.
3. Agent effort options: Low, Medium, High, Extra High, Max. Agent model options observed: Opus 5, Fable 5, Opus 4.8, GPT-5.6 Sol.
4. Changes apply immediately; model-specific options can appear.
5. Use foreground Page Down to move through the modal. Lower sections contain Workspace settings, Integrations, and Team Members.

## Manage custom recording sizes
1. Open **Settings** and move down to **Workspace settings > Custom window sizes**.
2. Edit the size name and WIDTHxHEIGHT fields directly.
3. **Add Size** appends a row (default 1440x897 with a sequential Custom name); **Remove** removes a row.
4. There is no visible Save button; edits are immediate.

## Create or switch workspace
1. Click the workspace name at top left.
2. Select an existing workspace, or click **New workspace**.
3. Enter Workspace name and click **Create Workspace**; creation immediately switches to its empty Library.

# Dead ends & quirks

- Existing draft cards, collections, workflow rows, and other pre-existing content are user data: do not rename, move, overwrite, or delete them during navigation.
- Publish, Export, Invite Members, Upgrade, Sign out, integration sign-ins/connect, Import, profile-photo upload, and account/member actions are external or file/account flows.
- Settings > Team Members > member ellipsis contains **Suspend user**. It is an account-access action. Selecting it showed no confirmation dialog or visible status change; avoid it unless explicitly required and authorized.
- Settings wheel scrolling was unreliable in Electron. Foreground Page Down worked during exploration; clicking an offscreen AX element can also cause the panel to jump to it.
- Paint/font dropdowns can be very large; learn the interaction and use search rather than exhausting values.
- Brand Kit edits commonly reveal **Save Changes / Cancel**. Notes on Motion, Layout, Misc, Overview, Colors, and Type follow that pattern.
- Brand Kit > Screen Clips is the workspace/brand default; Draft Editor > Project actions > Screen Clip Settings is the per-document override.
- Project action aspect ratio and Performance Mode choices apply immediately and close the menu.
- Scratch cleanup items created during exploration: `Scratch-Workspace-Ch6-Map-47d9`, `scratch-draft-editor-map-c7-47d9`, `Copy of scratch-draft-editor-map-c7-47d9`, `scratch-template-explore-9f2a`, `scratch-workflow-map-c7-47d9`, and `scratch-text-style-map-c7-47d9`.
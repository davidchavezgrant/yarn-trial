<!-- provenance: explore-vision | app: Yarn | date: 2026-08-03 | backend: cdp | actions: 289 | elapsed: 1h02m | calls: 544 | tokens-in: 1823182 | tokens-out: 94947 | cache-read: 7255552 | cache-write: 0 | findings: 36 | finds: 0 | controls (DECLARED): 162 actuated / 751 dismissed / 907 seen | surfaces: 53 | chapters: 27 | stopped: frontier-empty | descent: off | gated: 0 read / 0 refused -->
<!-- controls tallies are DECLARED — self-reported by the model from screenshots, not measured against an element list. A control the pass never declared is invisible to these numbers. -->
<!-- Written by src/core/explore.ts. DO NOT HAND-EDIT: edits make this a curated recipe, not exploration output — move such notes to docs/curated/<app>.md instead. -->

# Layout

- **Your Library** — ordinary landing view; click **Library** in the left sidebar. Supports Grid/List views, live title Search, ordering toggle, **+ New Draft**, and **New Collection**.
- **Your Drafts** — click **Your Drafts** in the left sidebar for the draft list. A draft opens the full editor.
- **Draft editor** — title and Script/Agent area at left, canvas in the center, timeline and Add media/Add text/Add screen clip/Add BG below, voice/language controls, comments, and Export. The title is editable inline.
- **Routines** — click **Routines** in the sidebar. New routines open an in-place setup editor; saved routines reopen in the same style.
- **Brand Kit** — click **Brand Kit** at the bottom of the sidebar. Internal tabs: **Brand Overview, Templates, Workflows, Colors, Type, Screen Clips, Motion, Layout, Misc**.
- **Settings** — click **Settings** at bottom-left. This is a scrollable modal containing preferences, plan/credits, workspace settings, custom window sizes, and integrations.
- **Template editor** — Brand Kit > Templates > New Template, or select a template and choose **Edit Template...**. It has Agent/Layers tabs, canvas/timeline tools, version controls, Copy URL, Export, Publish Updates, and an inspector.
- **Developer Inspector** — from a draft's **Dev** menu choose **Show Inspector**. Composition > Resolved Node exposes document-level projectStyle JSON.

# How to

## Create and edit a draft
1. From Library click **+ New Draft**. Yarn immediately creates an **Untitled Draft** card and stays in Library.
2. Open the card.
3. Click the title at top-left to turn it into an inline field; replace the text to rename.
4. Use the **Script** tab and click the area reading **Type script or # for new scene** to enter script content.
5. The Agent composer is the field labeled **Ask, edit, or make something...**.

## Find a draft
- Library Search filters rows live by title. Grid/List toggles change presentation; List rows show title/type, owner, and updated time.
- Right-click a row for **Move to David's, Rename, Make a copy, Delete**. Only use destructive actions on known scratch content. Rename closed the menu without exposing an obvious editor in this build.

## Choose a draft voice
1. In a draft click the waveform/ellipsis voice control.
2. Choose a tab (**English, World, Creative**) and a voice. English displayed Annie, Cassidy, Jacob, James, Kendra, Robert, Brynn, Fay, Jada, Jeff, Miranda, and Sarah.
3. Selection applies immediately and closes the picker. **Default Speed** is in the same picker.

## Create a template
1. Open **Brand Kit > Templates**.
2. Click **New Template**; an **Untitled Template** is created immediately and the template editor opens.
3. The editor exposes Agent/Layers, prompt, timeline, version controls, Copy URL, Export, and Publish Updates.
4. Existing templates can be selected in the Templates list and opened with **Edit Template...**.

## Create a workflow
1. Open **Brand Kit > Workflows** and click **New Workflow**.
2. Fill **Name**, **Description**, and the rich editor whose placeholder is **Workflow instructions**.
3. **Done** enables only after all required fields are filled.
4. Done returns to the Workflows page and stages the new row; click **Save Changes** to commit or **Cancel** to discard.

## Create a routine
1. Open **Routines** and start a new routine.
2. Enter its name and **Agent instructions**; instructions are required before **Add Routine** enables.
3. Optional: check **Start from a project**, then select an existing draft/project. Duplicate Untitled names are indistinguishable.
4. Choose delivery options: **Watch page**, **MP4 file**, and/or **Draft project**.
5. Click **Add Routine**. It saves in place; the button disappears and the generated API endpoint remains.
6. Saved routines reopen in place and appear to persist edits directly—no explicit Save button was visible. Copy actions include **Copy full instructions for your agent**, **Copy endpoint**, and **Copy request**.

## Edit Brand Kit text guidance
- **Brand Overview**, **Motion**, **Layout**, and **Misc** each contain a brand/workspace-scoped rich text field.
- Editing reveals **Save Changes** and **Cancel**. Save commits; Cancel restores the previous text.

## Manage Brand Kit colors
1. Open **Brand Kit > Colors**.
2. Use **Add Background** or **Add Text Color**.
3. Background picker modes are **Solid, Linear, Radial, Multi, Image, Shader**.
4. Linear mode has a gradient bar, stop position/hex/opacity fields, reverse, duplicate, add, and remove-stop controls.
5. The page also has **Color Notes**; changes are brand/workspace scoped.

## Manage Brand Kit typography
1. Open **Brand Kit > Type**.
2. Click the current **Primary Font** or **Secondary Font** to open a searchable font picker. A selection is staged; use Save Changes or Cancel.
3. Click **New Text Style** to open a modal with Name, preview text, Font Family, Font Weight, Font Size, Line Height, and Letter Spacing.
4. **Done** stages the style on the Type page; **Save Changes** commits it.

## Configure Screen Clip defaults
- Open **Brand Kit > Screen Clips** for brand/workspace defaults.
- Cursor: Auto-Hide Cursor (Auto Hide/Off), Text Cursor (Hide/Show), Cursor Style (Arrow-first/Pointer-first/Original), Cursor Scale.
- Screen Display: padding and shadow opacity, blur, spread, X, and Y.
- Sound Effects: Cursor Clicks plus sound; Keyboard Presses plus key set and sound.
- Visual Effects: Entrance/Exit Animation and Motion Blur (Off/Low/Medium/High).
- Any edit is staged and reveals **Save Changes / Cancel**.

## Change app preferences
1. Open **Settings** from the sidebar.
2. Preferences include app-scoped Auto-Add Screen Zooms, Theme (Dark/Light/System; shortcut shown as Shift-Command-\\), default Agent model, default Agent effort, and Agent Fast Mode default.
3. Scroll for workspace name/icon, custom window sizes, and integrations.

## Inspect per-document Screen Clip overrides
1. Open the target draft.
2. Open **Dev > Show Inspector**.
3. Select **Composition**, then **Resolved Node**.
4. Read `projectStyle`: document-level keys include `screenClipMotionBlur`, `cursorScaleBoost`, `cursorSwapMode`, `hideInactiveCursor`, `hideTextCursor`, `windowPadding`, and `screenWindowShadow` opacity/blur/spread/offset values.
5. These are document overrides; Brand Kit > Screen Clips controls brand/workspace defaults. Do not confuse their scopes.

# Dead ends & quirks

- **+ New Draft** creates immediately but does not open a wizard/editor.
- **New Collection** and Settings > Workspace settings > **Add Size** produced no visible change in this build.
- Blank-draft **Add media**, **Add text**, **Export**, Agent **+**, and **Language** produced no visible surface. Add text/media/screen clip also appeared inactive on the tested 4-second scene.
- **Add BG** did not open a picker; the canvas merely refreshed to the existing scene.
- **Fit timeline** caused no visible change on the tested short scene.
- Canvas objects and timeline clips showed no selection/context affordances when clicked, double-clicked, or right-clicked in the tested state.
- The centered canvas **+** produced no visible insertion menu.
- World/Creative voice tabs caused no visible list change in this build.
- Brand Kit Brand Overview's top-right ellipsis and the top-left workspace label produced no visible menu.
- Integrations (Figma, Google Slides, Notion MCP, Team YouTube), Invite Members, Copy URL, publishing/export/sharing, and account/authentication actions were not committed because they can be externally visible.
- Scratch objects created during exploration and eligible for cleanup: **Untitled Draft**, **Untitled Template**, **Grounding Scratch Style**, **Grounding Map Routine 2**, and other clearly named Grounding/Copy scratch items. The workflow **Grounding Scratch Workflow** was left staged/unsaved during exploration.
<!-- provenance: explore | app: Yarn | date: 2026-08-03 | backend: ax | vision: off | actions: 153 | elapsed: 25m | calls: 242 | tokens-in: 1261278 | tokens-out: 31759 | cache-read: 7461376 | cache-write: 0 | findings: 35 | finds: 0 | controls: 90 actuated / 198 dismissed / 1095 seen | surfaces: 37 | chapters: 14 | stopped: frontier-empty | descent: off | gated: 0 read / 4 refused -->
<!-- controls actuated/seen is a LOWER BOUND ON BREADTH, not a coverage percentage: the denominator only grows as surfaces are opened, and operating a control is not understanding it. -->
<!-- Written by src/core/explore.ts. DO NOT HAND-EDIT: edits make this a curated recipe, not exploration output — move such notes to docs/curated/<app>.md instead. -->

# Layout

## Library and workspace navigation
- **Library** is the normal landing view. Use the left-sidebar **Library** button to return from editors. It contains Collections plus draft rows/cards, Search, Grid/List, an overflow menu, and **New Draft**.
- **Your Drafts** is the workspace-wide draft browser with the same Search, Grid/List, overflow, and New Draft controls.
- Opening a collection gives a collection-scoped browser with **Your Library** back navigation, Search, Grid/List, overflow, and **New in Collection**.
- The workspace popup at the top-left lists workspaces and contains **New workspace**, **Demo mode**, and **Sign out**.
- Sidebar **Routines** opens the routines list. **New Routine** opens the full routine editor.
- Sidebar **Brand Kits** is a popup; choose a kit to open its brand editor.
- Sidebar **Settings** opens the app/workspace settings overlay.

## Draft editor
- Left pane: **Agent / Script**, voice selector, talking speed, script textarea, composer, Composer actions, model, effort, Send.
- Center: preview plus playback controls and bottom timeline. Timeline controls include **Library**, **Timeline Zoom**, and **Add scene**.
- Top/right: editable title, **Project actions**, document paint picker, inspector toggle, **Add Music**, **Publish**, **Export**.
- **Project actions** contains Copy Transcript, Make a copy, Download SRT, Screen Clip Settings, Version History, Brand, aspect ratio, Performance Mode, debug display controls, Copy Project ID, and Delete.
- The unlabeled button immediately right of the top paint picker toggles the selected-element inspector.

## Brand Kit editor
Tabs are **Brand Overview, Templates, Workflows, Colors, Type, Screen Clips, Motion, Layout, Misc**.
- Overview: auto-saving notes and Brand options.
- Templates: **New Template** opens a full template editor.
- Workflows: **New Workflow** opens a Name/Description/Workflow instructions editor.
- Colors: Background and Text palettes plus notes and a six-mode paint picker.
- Type: Primary/Secondary fonts, text styles, usage notes; **New Text Style** opens a style modal.
- Screen Clips: brand defaults for cursor, screen/window shadow, sound, motion, and zoom.
- Motion/Layout/Misc: brand-scoped guidance notes with Save Changes/Cancel.

## Settings
Preferences include Auto-Add Screen Zooms, Theme, default agent model/effort/fast mode, plan usage, workspace name/icon, recording window sizes, integrations, and team members.

# How to

## Create or open a draft
1. Click sidebar **Library** or **Your Drafts**.
2. Click **New Draft** (or **New in Collection** inside a collection). Creation immediately opens the draft editor.
3. Edit the title in the top-left title field.
4. Use **Script** and the script textarea; type `#` for a new scene, or use timeline **Add scene**.

## Duplicate a draft
1. Open the draft.
2. Open **Project actions**.
3. Choose **Make a copy**. Yarn immediately creates and switches to a new draft prefixed “Copy of”.

## Change document aspect ratio, brand, or performance
1. Open the draft’s **Project actions**.
2. Choose the Brand submenu, an aspect ratio, or a Performance Mode value.
3. Choices apply immediately. Aspect ratios: Widescreen 16:9, Laptop 16:10, Square 1:1, Vertical 9:16. Performance: Efficiency, Default, Ultra.

## Change screen-clip behavior for one draft
1. Draft editor → **Project actions** → **Screen Clip Settings...**.
2. Adjust cursor, window/shadow, sound, entrance/exit, motion blur, or zoom controls.
3. Click **Done**.
- These are **document-scoped overrides**. To change brand defaults instead, use Brand Kit → **Screen Clips** and Save Changes.

## Associate a brand with one draft
1. Draft editor → **Project actions** → **Brand …**.
2. Choose Default Brand or a workspace brand kit; it applies immediately.
3. **Edit Brands…** opens Brand Kit editing instead of merely changing the association.

## Use version history
1. Draft editor → **Project actions** → **Show Version History...**.
2. Select snapshots from the right rail.
3. **Close** returns to the editor. Revert overwrites document state; do not use without explicit authorization.

## Add media or music
- Timeline **Library** opens Add from Library with tabs Everything, Images, Screen Clips, Webcams, Videos, Projects and Search. **Upload Camera Footage** starts local import.
- **Add Music** → **Upload background track** accepts MP3, WAV, or M4A.
- Composer actions → **Add Reference…** opens the native macOS Open chooser for a local file.

## Change voice
1. Click **Select voice: …** above the script.
2. Pick English, World, or Creative; Creative includes Cartoon, Cowboy, Demon, Epic Movie Trailer, Grandpa, Mad Scientist, Tough Guy, Wizard.
3. Use its talking-speed submenu: Slowest, Slow, Default, Fast, Faster.

## Change document paint
1. Click the top-bar **Open paint picker**.
2. Choose Solid, Linear, Radial, Multi, Image, or Shader.
3. Solid has hue, opacity, eyedropper, input format, hex and alpha. Linear/Radial use stops; Radial also exposes flip and rotate. Multi has multi-point stops and Blend. Image exposes Upload image then Fit/Position. Shader exposes a preset plus Base/Mid Accent/Accent colors and Speed/Seed/Noise/Saturation.
4. Press Escape to close.

## Format a selected element
1. Click the unlabeled top-bar button immediately right of the document paint picker (or Dev → Show Inspector).
2. Use Presets, font family/weight/size, paint, Effects, Hidden, and inspector overflow.

## Create a routine
1. Sidebar **Routines** → **New Routine**.
2. Enter Routine name; optionally choose Start from a project.
3. Select delivery: Watch page, MP4 file, and/or Draft project. MP4 delivery requires `callbackUrl`.
4. Enter Agent instructions and click **Add Routine** when enabled.
5. Lower editor content documents the POST endpoint, body example, and copy controls; HTTP 202 means queued.

## Create/edit brand assets
- Template: Brand Kits → kit → **Templates** → **New Template**. Editor has Agent/Layers, prompt/model/effort, canvas/timeline, add Group/Text/Media/Shape/Comment, Template inspector, Export, and externally visible Publish Template.
- Workflow: Brand Kits → kit → **Workflows** → **New Workflow**; enter Name, Description, Workflow instructions, then save. Opening the row later gives Edit Workflow with Cancel/Done/Delete.
- Text style: Brand Kits → kit → **Type** → **New Text Style**; set name, preview, family, weight, size, optional line height, letter spacing, then Done.
- Brand colors: Brand Kits → kit → **Colors**; open a swatch, use Solid/Linear/Radial/Multi/Image/Shader, then **Save Changes**. **Cancel** restores the saved palette.

## Change app/workspace defaults
1. Sidebar **Settings**.
2. Change preference values directly; settings include Auto-Add Screen Zooms, Theme, agent model/effort/fast mode, workspace identity, and custom recording sizes.
3. Theme shortcut shown in UI: Shift+Command+backslash.

# Dead ends & quirks
- Publish, Invite Members, Sign out, integrations, uploads, and other externally visible/account-changing actions were not committed.
- Project deletion, collection deletion, workflow deletion, and version-history reverts are destructive; do not perform on user content.
- Existing user drafts/templates were not opened or altered. Scratch objects created during mapping include “Grounding Scratch Workspace 2”, “Grounding Scratch Template Editor”, “Grounding Scratch Workflow”, “Grounding Scratch Collection Draft”, and “Copy of Grounding Scratch Collection Draft”.
- Create controls often open full editors rather than modals; do not assume they are simple leaves.
- Collection **New in Collection** immediately creates and opens a draft.
- **Make a copy** immediately creates and switches to the duplicate.
- Brand, aspect ratio, and Performance Mode menu choices apply immediately.
- The native file chooser used by Add Reference is local-file attachment, not an in-app asset picker.
- Version-history snapshot rows may be painted/non-AX-pressable in this driver.
- Several preview/timeline controls are unlabeled AX buttons. Prefer known labeled controls and element indices; avoid coordinate clicks unless no AX element exists.
- Generic macOS Edit → Substitutions/Speech and native window menus are not Yarn-specific settings.
- Brand Kit Screen Clips and draft Screen Clip Settings expose the same underlying concepts at different scopes: use the brand panel for defaults and the draft panel for one-document overrides.
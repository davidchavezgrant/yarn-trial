<!-- provenance: explore | app: Yarn | date: 2026-08-01 | backend: cdp | vision: off | actions: 186 | elapsed: 27m | calls: 354 | tokens-in: 678214 | tokens-out: 42600 | cache-read: 6523392 | cache-write: 0 | findings: 56 | finds: 2 | controls: 116 actuated / 229 dismissed / 503 seen | surfaces: 86 | chapters: 17 | stopped: frontier-empty | descent: off | gated: 0 read / 3 refused -->
<!-- controls actuated/seen is a LOWER BOUND ON BREADTH, not a coverage percentage: the denominator only grows as surfaces are opened, and operating a control is not understanding it. -->
<!-- Written by src/core/explore.ts. DO NOT HAND-EDIT: edits make this a curated recipe, not exploration output — move such notes to docs/recipes/<app>.md instead. -->

# Layout

- **Library** (`/library/ag`) is the ordinary landing view. Return from anywhere with left-rail **Library**. It has Search, Grid/List, **New Draft**, **New Collection**, collection buttons, and draft cards with unlabeled options buttons.
- **Your Drafts** (`/library/drafts`) is a dedicated draft overview with Search, Grid/List, New Draft, and draft-card options.
- **Workspace switcher**: click the workspace-name badge (for example, **David's Workspace**). It lists workspaces, **New workspace**, and Sign out.
- **Settings**: left rail **Settings** opens an overlay. It contains theme, AI model/effort, workspace name, custom canvas sizes, integrations, import/invite, subscription, profile, and sign out.
- **Brand Kits**: left rail **Brand Kits** opens the chooser/editor. Brand tabs are Brand Overview, Templates, Workflows, Colors, Type, Screen Clips, Motion, Layout, and Misc. **Brand options** contains Rename, Duplicate, New Brand, Make Default where applicable, and Archive.
- **Draft editor** (`/ag-editor/{id}`): opened via New Draft or a draft card. Main chrome includes title, Select voice, Project actions, Composer actions, paint, Add Music, Timeline Zoom, Add scene, Library, Export, Publish, and Send.
- **Template editor** (`/template-editor/{id}`): Brand Kits → Templates → New Template/Edit Template. Chrome includes title, Composer actions, Export/Publish, Play, Group, Text, Media, Shape…, Comment, Duration, Opacity, paint, description, and Auto Hide Layers.

# How to

## Drafts and collections

- **Create a draft**: Library → **New Draft** → rename the title in the editor. Creation navigates directly to the editor.
- **Duplicate a draft**: draft editor → **Project actions** → **Make a copy**. It immediately creates and opens `Copy of {original}` with no confirmation.
- **Rename from Library card**: click the card's unlabeled options button → choose the **third unlabeled menu item** → edit the inline title textbox. Escape cancels.
- **Create a collection**: Library → **New Collection** → enter name → **Create Collection**. The collection view has Your Library, Search, Grid/List, New in Collection, and an unlabeled header options menu containing Delete Collection.
- **Change draft canvas format**: editor → Project actions → Widescreen (16:9), Laptop (16:10), Square (1:1), or Vertical (9:16). Applies immediately.
- **Change render quality**: editor → Project actions → Efficiency, Default, or Ultra. Applies immediately.
- **Version history**: editor → Project actions → **Show Version History...**. Close with **Close**; no restore control was exposed in the tested scratch draft.
- **Copy transcript**: editor → Project actions → **Copy Transcript**. It closes the menu with no secondary dialog.
- **Add a scene**: editor → **Add scene**. Appends immediately; scene Delete buttons then appear.
- **Background music**: editor → **Add Music**. Full-screen picker offers No background track and track rows. Selecting a track assigns document content.
- **Timeline zoom**: click **Timeline Zoom** to reveal the inline slider.

## Document-specific styling and media generation

- **Assign a brand to a draft**: editor → Project actions → **Brand [current]** → choose Default Brand or a listed kit. **Edit Brands…** leaves the draft for a brand editor and may not open the expected brand; use Brand Kits when exact navigation matters.
- **Document screen-clip settings**: editor → Project actions → **Screen Clip Settings...**. This modal contains Auto Hide, cursor visibility, Cursor Style, sliders/shadow offsets, Cursor Clicks, Keyboard Presses, Fade animation, intensity, motion, easing, and Done.
  - Cursor Style: Arrow-first, Pointer-first, Original.
  - Cursor Clicks: Extra Soft, Soft, Medium, Loud.
  - Keyboard Presses: Set A, Set B, Set C, Set D.
  - Fade opens a picker. Enter: Appear, Fade In/Up/Down/Left/Right, Scale Up/Down. Exit: Disappear, Fade Out/Up/Down/Right/Left, Scale Up/Down. Choose an option, then Escape to close.
  - Motion: Glide/Fixed. Fixed reveals Smooth, Ease In-Out, Expo In-Out.
- **Select voice**: editor → **Select voice** → English/World/Creative → voice. World includes localized voices; Default Speed is in the picker.
- **Image generation**: Composer actions → **Switch to Media Gen** → Image. Models: Gemini, GPT Image 1.5, Seedream-4; Preferred Layout: Auto/Landscape/Portrait; optional Save as default.
- **Video generation**: Media Gen → Video. Models: Kling-2.5, Sora-2 Pro, Veo-3.1; Preferred Duration: 5 or 10 sec; Preferred Layout; optional Save as default.
- **Add Reference...** is in Composer actions.

## Brand kits

- **Create a brand**: Brand Kits → Brand options → **New Brand**. It creates immediately without a naming dialog; then Brand options → Rename Brand → enter name → Done.
- **Duplicate a brand**: Brand options → **Duplicate Brand**. Immediate clone and navigation to the new brand.
- **Make default brand**: Brand options → **Make Default**. Applies immediately at workspace scope.
- **Create a template**: Brand Kits → Templates → **New Template**. Navigates to template editor.
- **Template list operations**: Templates has Grid/List and Sort by newest/Sort A-Z. Each row has editable name/description, Edit Template…, and Template options.
  - Duplicate Template creates `{name} Copy` immediately.
  - Move to Brand opens a destination-brand submenu; selecting one moves immediately and removes the template from the current list.
  - Delete Template is destructive and guarded.
- **Add template text**: template editor → **Text**. The selected text inspector exposes alignment, X/Y/rotation, W/H, typography preset, font, weight, text/size/tracking, flips, opacity, and Solid fill.
- **Add a shape**: template editor → **Shape...** → Rectangle/Circle/Triangle/Polygon/Line/Arrow/Icon/Pen. Rectangle was verified; its inspector has alignment, transforms, W/H, opacity, corner/radius control, and fill.
- **Media**: template editor → **Media** opens a full-screen asset grid. Escape returns.
- **Create a workflow**: brand Workflows → **New Workflow** → fill Name, Description, Workflow instructions → Done. All three are required; then use Save Changes.
- **Brand colors**: Colors → open a swatch paint picker. Paint tabs: Solid, Linear, Radial, Multi, Image, Shader. Linear exposes stops, stop color/opacity/position, flip, rotate 90°, and add stop. Use Save Changes.
- **Brand typography**: Type contains primary/secondary font fields, New Text Style, reorder/edit controls, and Font usage notes. New Text Style requires style name and exposes preview, weight, size, Auto line-height, and letter spacing.
- **Brand screen-clip defaults**: Screen Clips has brand-scoped counterparts of document screen-clip settings. These are defaults; the draft modal is the document override.
- Motion, Layout, and Misc currently contain notes textboxes plus Save Changes/Cancel.

## Settings and workspaces

- **Change theme/model/effort**: Settings → click current value → choose an item. Theme: Dark/Light/System. Models observed: Opus 5, Fable 5, Opus 4.8, GPT-5.6 Sol. Effort: Low, Medium, High, Extra High, Max.
- **Add a custom canvas size**: Settings → **Add Size**. It immediately appends a row with editable name, dimensions, and Remove.
- **Create a workspace**: workspace badge → **New workspace** → type name → Create Workspace. It switches immediately to the new workspace's empty Library.

# Dead ends & quirks

- Persistent unlabeled left-rail buttons are recent/pinned shortcuts into specific drafts or brands, not stable navigation. Prefer Library, Your Drafts, or Brand Kits.
- `New in Collection` produced no observable change in an empty scratch collection.
- Library draft-card option menu items lack accessible labels; only the third was identified as Rename.
- Media thumbnails and music tracks are user content; do not select them merely for navigation.
- Publish, Send, Invite, Upgrade, integrations/account changes, and Sign out are externally visible or account-affecting and were not executed.
- Brand font defaults and template text-layer font controls are different stores. Brand Screen Clips and draft Screen Clip Settings are likewise brand-default vs document-override stores.
- Scratch cleanup candidates created during exploration: canvas-size row `Scratch Explore 7F3A`; brand kit `scratch-brand-map-7f3a`; templates `scratch-template-map-7f3a`, `scratch-map-template-duplicate-20250308`, and moved copy `scratch-map-template-duplicate-20250308 Copy`; workflow `scratch-workflow-map-7f3a`; text style draft `scratch-text-style-map-7f3a`; drafts `scratch-draft-map-7f3a` and `Copy of scratch-draft-map-7f3a`; collection `scratch-collection-map-7f3a`; workspace `scratch-workspace-map-ch12-7f3a`; brands 245 `scratch-brand-245-map-7f3a` and 246 `scratch-brand-246-duplicate-map-7f3a`.
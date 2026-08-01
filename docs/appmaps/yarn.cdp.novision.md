<!-- provenance: explore | app: Yarn | date: 2026-08-01 | backend: cdp | vision: off | actions: 188 | elapsed: 21m | calls: 277 | tokens-in: 513401 | tokens-out: 40772 | cache-read: 2919424 | cache-write: 0 | findings: 57 | finds: 2 | controls: 130 actuated / 40 dismissed / 308 seen | surfaces: 17 | chapters: 18 | stopped: frontier-empty | descent: off | gated: 0 read / 3 refused -->
<!-- controls actuated/seen is a LOWER BOUND ON BREADTH, not a coverage percentage: the denominator only grows as surfaces are opened, and operating a control is not understanding it. -->
<!-- Written by src/core/explore.ts. DO NOT HAND-EDIT: edits make this a curated recipe, not exploration output — move such notes to docs/recipes/<app>.md instead. -->

# Layout

## Persistent navigation and Library
- **Library** (`/library/ag`) is Yarn’s ordinary landing view. The persistent left rail contains **Library**, **Your Drafts**, **New draft**, **Invite Members**, **Brand Kits**, and **Settings**.
- Library has **Search**, Grid/List view buttons, **New Draft**, collections, **New Collection**, and draft cards. Card action menus are icon-only/unlabeled; their positions are hazardous (see quirks).
- **Your Drafts** (`/library/drafts`) has Search, Grid/List view, and New Draft.

## AG editor
- Opening some Library drafts leads to `/ag-editor/{id}`. Header controls include title, **Select voice**, **Project actions**, **Composer actions**, **Open paint picker**, **Add Music**, **Publish**, **Library**, **Timeline Zoom**, and **Add scene**.
- **Project actions** contains Copy Transcript, Make a copy, Download SRT…, Screen Clip Settings…, Show Version History…, a document brand selector, aspect-ratio presets, render-quality presets, and a final unlabeled Delete item.
- **Screen Clip Settings…** opens a document-scoped panel mirroring Brand Kit → Screen Clips. **Done** closes it.
- **Select voice** opens filters English/World/Creative, voices Annie, Brynn, Cassidy, Fay, Jacob, Jada, James, Jeff, Kendra, Miranda, Robert, Sarah, and Default Speed.
- **Open paint picker** provides Solid, Linear, Radial, Multi, Image, and Shader modes as a document background/paint override.
- **Show Version History…** opens a full-screen history overlay with Close.

## Project/draft editor
- Creating from Your Drafts can lead to `/project/{id}`. Header includes brand, collaborator/user, title, Library, and Composer actions. Editor commands include Add Trim, Fit, Export, Add Auto-Overlay, Seek Back, Add Skip, Send, Add Music, and Upgrade/Pro.
- Composer actions offers **Add Reference…** and **Switch to Media Gen**. Media Gen provides Image, Video, and generation-model/credit buttons; Switch to Agent returns to the normal composer.

## Brand Kit
- **Brand Kits** opens `/brands?brandId={id}` with sub-navigation: **Brand Overview**, **Templates**, **Workflows**, **Colors**, **Type**, **Screen Clips**, **Motion**, **Layout**, and **Misc**.
- Brand Overview: Brand options and Overview notes.
- Templates: Grid/List, Sort A-Z, Sort by newest, New Template.
- Workflows: saved workflows and New Workflow.
- Colors: brand palette rows with paint pickers, notes, Save Changes, Cancel.
- Type: primary/fallback font search, New Text Style, usage notes, and editable/reorderable text styles.
- Screen Clips: brand defaults corresponding to the AG editor’s document overrides.
- Motion/Layout/Misc: notes plus Save Changes/Cancel.

## Template editor
- **New Template** creates immediately and opens `/template-editor/{id}`. Header: title, New template in [brand], Template options, Composer actions, version selector, Export, Play, Group, Text, Media, Shape…, and Auto Hide Layers.
- Template options includes Duplicate Template, quality presets, aspect ratios, and Loop On/Off.

## Settings and workspace switcher
- **Settings** is a hash-route overlay (`#settings/subscription`) over the current page. It includes profile/account controls, On/Off, Dark/Light/System appearance, Fable 5, Low, subscription Upgrade, editable workspace name, reusable size presets, integrations/import/member controls.
- Clicking the workspace-name button opens the workspace switcher with existing workspaces, **New workspace**, and Sign out.

# How to

## Create a draft or collection
- From Library, click **New Draft**; from Your Drafts, click **New Draft**. Creation is immediate and opens an editor.
- From Library, click **New Collection** to create/manage collections.

## Rename a Library card
1. Open the card’s unlabeled action menu.
2. Choose the **third** menu item.
3. Fill the inline textbox labeled **Draft**.
4. Press Enter.

## Duplicate or delete a Library card
- Card menus have five inaccessible, unlabeled positions. The **first** and **fourth** positions both produced copies in testing; the fourth titled its result `Copy of …`.
- The **fifth/final** position deletes immediately with no confirmation. Only use it when ownership is certain.

## Change an AG document’s aspect ratio or quality
1. Open **Project actions**.
2. Choose an aspect ratio: Widescreen (16:9), Laptop (16:10), Square (1:1), or Vertical (9:16); or quality: Efficiency, Default, Ultra.
3. Selection applies immediately and closes the menu.
- These are document-scoped settings.

## Change an AG document’s brand
1. Open **Project actions**.
2. Open the item showing the current brand.
3. Choose Default Brand or a workspace brand; it applies immediately.
4. **Edit Brands…** navigates to Brand Kit for the selected/current brand.
- This is a document override. Brand Kit → Brand options → Make Default changes the workspace default instead.

## Configure screen clips for one AG document
1. Open **Project actions** → **Screen Clip Settings…**.
2. Adjust Auto Hide, Hide/Show, Cursor Style, sliders, shadow offsets, Cursor Clicks, Keyboard Presses, sound/intensity, entrance animation, or motion.
3. Click **Done**.
- Cursor Style options: Arrow-first, Pointer-first, Original.
- Cursor Clicks options: Extra Soft, Soft, Medium, Loud.
- Keyboard Presses options: Set A, Set B, Set C, Set D.
- A second unlabeled sound combobox after Keyboard Presses also offers Extra Soft/Soft/Medium/Loud; do not confuse it with Cursor Clicks.
- Choosing **Fixed** reveals easing: Smooth, Ease In-Out, Expo In-Out.
- These controls are document-scoped counterparts of Brand Kit → Screen Clips. Use identical setting identities such as `cursor-style`, `cursor-clicks`, `keyboard-presses`, and `screen-clip-easing` when distinguishing scope.

## Choose AG entrance/exit animation
1. In Screen Clip Settings, click **Fade Up** (or the animation affordance).
2. The settings panel closes and an animation picker appears.
3. **Enter** options: Appear, Fade In, Fade Up/Down/Left/Right, Scale Up/Down.
4. **Exit** options: Disappear, Fade Out, Fade Up/Down/Right/Left, Scale Up/Down.

## Choose a voice
1. Click **Select voice**.
2. Optionally filter English, World, or Creative.
3. Choose a voice and set Default Speed.
4. Voice choice applies immediately and closes the picker. After selection, the header voice button may become unlabeled in accessibility.

## Add a scene
- Click **Add scene**. It inserts a blank scene immediately; each scene has Delete. There is no naming dialog.

## Use the AG paint picker
1. Click **Open paint picker**.
2. Choose Solid, Linear, Radial, Multi, Image, or Shader.
3. Solid exposes Hue, Opacity, Eyedropper, input-format switch, hex, and opacity fields.
- This changes the current document, unlike Brand Kit → Colors which changes brand defaults.

## Create and configure a template
1. Brand Kits → Templates → **New Template**. Creation is immediate.
2. Rename via the title textbox.
3. Open **Template options** for Duplicate Template, quality, aspect ratio, and Loop.
- Quality: Efficiency, Default, Ultra.
- Aspect ratio: Widescreen 16:9, Widescreen 16:10, Portrait 9:16, Square 1:1.
- Loop toggles in place and changes its label between Loop On and Loop Off.
- Template settings are specific to that template asset.

## Create a workflow
1. Brand Kits → Workflows → **New Workflow**.
2. Fill Name, Description, and Workflow instructions.
3. Click **Done** when enabled. Saving returns to Workflows.

## Edit brand colors
1. Brand Kits → Colors → open a swatch’s paint picker.
2. Use Solid, Linear, Radial, Multi, Image, or Shader.
3. Click brand-level **Save Changes** to commit pending edits.
- Linear: stop controls, Flip gradient stops, Rotate gradient 90 deg, Add gradient stop, position/color/opacity.
- Multi: add/remove/edit points and Blend.
- Image: Upload image (likely native file picker).
- Shader: shader selector plus three colors and Speed, Seed, Noise, Saturation.

## Edit brand typography
1. Brand Kits → Type.
2. Use primary/fallback font search or **New Text Style**.
3. Edit style name, preview, Font Weight, Font Size, Auto/line height, Letter Spacing.
4. Click Done; Remove Text Style is destructive.

## Create or switch workspace
1. Open Settings.
2. Click the workspace-name button.
3. Choose an existing workspace, or **New workspace**.
4. For a new workspace, enter a name and click **Create Workspace** once enabled.
- Creation makes it current and navigates to its empty Library.

# Dead ends & quirks
- **Publish**, Send, Invite Members, Upgrade, Sign out, and similar controls are externally visible/account actions and were not committed.
- **Add Reference…** closes its menu but exposes no in-page UI; it likely invokes a native file picker, which this driver cannot operate. Image upload and Download SRT may likewise invoke native dialogs/downloads.
- AG Project actions’ **final unlabeled item is Delete**. It removes the document immediately and returns to Library with no confirmation.
- Library card action labels/icons are inaccessible. Position is the only reliable distinction; fifth is immediate Delete.
- The unnamed button beside Keyboard Presses in Screen Clip Settings produced no observable change. Use the labeled Keyboard Presses combobox itself.
- The second unlabeled Extra Soft/Soft/Medium/Loud selector after Keyboard Presses is distinct from labeled Cursor Clicks.
- Fade Up in Screen Clip Settings opens a separate animation picker rather than behaving like an ordinary in-panel toggle.
- Brand Color/Motion/Layout/Misc edits are pending until **Save Changes**.
- Brand options → Duplicate Brand and Templates → Duplicate Template create and open copies immediately, with no confirmation.
- Brand options → Make Default applies immediately at workspace scope.
- Settings changes are app/workspace scoped; document editor overrides are separate stores.

## Scratch items created during mapping (cleanup)
- Scratch brands: IDs **256** and **260**.
- Scratch templates: IDs **1098**, **1099**, **1100**.
- Scratch workflow: `Scratch Workflow Map 7f3a`.
- Scratch text style: `Scratch Text Style Map 7f3a`.
- Scratch draft/project: ID **1597197533**, title `Scratch Draft Map 7f3a`.
- Scratch workspace: `Scratch Workspace Chapter7 7f3a` (and current observed scratch workspace label `Scratch-Workspace-Map-Ch11B-7f3a`).
- Multiple owned scratch Library copies, including `Scratch Library Duplicate 7f3a`, `Copy of Scratch Library Duplicate 7f3a`, Untitled, and Untitled Draft cards.
- Scratch AG document IDs observed include **2108023259**, **1171973720**, and **540999278**; some scratch copies were already deleted during safe testing.
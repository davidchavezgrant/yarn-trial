<!-- provenance: explore | app: Yarn | date: 2026-08-01 | backend: cdp | vision: off | actions: 134 | elapsed: 17m | calls: 216 | tokens-in: 379501 | tokens-out: 32395 | cache-read: 2201600 | cache-write: 0 | findings: 46 | finds: 3 | controls: 80 actuated / 91 dismissed / 291 seen | surfaces: 23 | chapters: 13 | stopped: frontier-empty | descent: off | gated: 0 read / 1 refused -->
<!-- controls actuated/seen is a LOWER BOUND ON BREADTH, not a coverage percentage: the denominator only grows as surfaces are opened, and operating a control is not understanding it. -->
<!-- Written by src/core/explore.ts. DO NOT HAND-EDIT: edits make this a curated recipe, not exploration output — move such notes to docs/recipes/<app>.md instead. -->

# Layout

## Library
- Ordinary landing view: `/library/ag`. Return from anywhere with the left-rail **Library** button.
- Left rail: **Your Drafts**, **New draft**, **Invite Members**, **Brand Kits**, and **Settings**. Unlabeled icons beneath Your Drafts are workspace-dependent recent/pinned brand, template, and draft shortcuts—not stable feature sections.
- **Your Drafts** (`/library/drafts`) has Search, Grid/List, and New Draft. List shows compact rows; Grid restores cards.
- **New Collection** opens a Create Collection modal. A collection page has Search, Grid/List, sort/filter, **New in Collection**, collection options, and **Your Library**. Collection options currently contains only **Delete Collection**.

## Settings
- **Settings** opens a full overlay at `#settings/subscription`; the first unlabeled button closes it.
- One scrolling overlay contains profile/sign-out, an On/Off setting, appearance **Dark / Light / System**, model **Opus 5 / Low**, Upgrade, Workspace name, custom canvas sizes (**Add Size / Remove**), integrations (Figma, Google, Notion, two YouTube sign-ins), Import, and Invite Members.
- Sign-out, Upgrade, integrations, import, and invitations can be external/account-affecting.

## Brand Studio
- **Brand Kits** opens a chooser; choose a brand such as **Default Brand · Primary** to open `/brands?brandId=…`.
- Sections: **Brand Overview, Templates, Workflows, Colors, Type, Screen Clips, Motion, Layout, Misc**.
- Overview: notes plus **Brand options** menu: Rename Brand, Duplicate Brand, New Brand, Make Default (when applicable), Archive Brand.
- Templates: Grid/List, sort Newest/A–Z, New Template, card name/description, Edit Template, Template options.
- Workflows: New Workflow and workflow cards; editor asks Name, Description, Workflow instructions, Cancel, Done.
- Colors: brand color rows with paint picker and Color actions, notes, Save Changes/Cancel. Paint modes: Solid, Linear, Radial, Multi, Image, Shader.
- Type: primary/secondary font search, New Text Style, existing style Reorder/Edit, Font usage notes. Style editor has name, preview, weight, size, line height, letter spacing, Cancel/Done.
- Screen Clips stores **brand-scope defaults**. Motion, Layout, and Misc currently expose notes plus Save Changes/Cancel.

## Template editor
- Created from Brand Studio > Templates > **New Template** and opened at `/template-editor/<id>`.
- Top bar: brand link, title, New template in brand, Template options, Composer actions, Export, Publish Template, Play.
- Insert/tools: Group, Text, Media, Shape…, Comment. Inspector: Duration, Opacity, agent description, paint picker, Auto Hide Layers.
- Template options: Duplicate Template; quality Efficiency/Default/Ultra; aspect Widescreen 16:9, Widescreen 16:10, Portrait 9:16, Square 1:1; Loop On; Delete Template.
- Composer actions contains Add Reference… and Switch to Media Gen, matching the draft editor.

## Draft editor
- **New draft** creates immediately and navigates to `/ag-editor/<id>`; replace the title immediately to claim scratch.
- Top bar includes Select voice, Project actions, Composer actions, Open paint picker, Add Music, Publish, visible Send/Export. Canvas/timeline has Library, Timeline Zoom, and Add scene.
- Project actions: Copy Transcript, Make a copy, Download SRT…, aspect ratio, render quality, Brand picker, Screen Clip Settings…, Show Version History….
- Composer actions: Add Reference… and Switch to Media Gen. Media Gen replaces composer controls with Image, Video, and a credit-bearing generation button.
- Add Music is a stripped upload panel for MP3/WAV/M4A only.

# How to

## Create and claim a draft
1. From Library click **New draft**.
2. On `/ag-editor/<id>`, replace the title field with a distinctive scratch name.
3. Add scenes with **Add scene**; each click appends a blank scene directly, without a modal.

## Duplicate a draft
1. In a scratch draft open **Project actions**.
2. Click **Make a copy**.
3. Yarn immediately creates the copy and navigates to it; title becomes `Copy of <original>`.

## Change a draft’s aspect or quality
1. Open **Project actions**.
2. Choose aspect: Widescreen 16:9, Laptop 16:10, Square 1:1, or Vertical 9:16.
3. Or choose quality: Efficiency, Default, Ultra.
4. Selection applies immediately and closes the menu. These are document scope.

## Set a draft’s brand
1. Open **Project actions** > **Brand <current brand>**.
2. Choose a listed brand. This changes only the current document.
3. **Edit Brands…** instead navigates directly to Brand Studio for the current brand.

## Open or close version history
1. Draft > **Project actions** > **Show Version History…**.
2. History replaces most editor chrome at the same URL.
3. Click **Close** to return.

## Use Media Gen
1. Open **Composer actions** > **Switch to Media Gen**.
2. Choose Image or Video.
3. The `Multi…cr` control is the generation commit, not a mode selector. Video raised it from 30 to 630 credits in testing; do not click unless generation is intended.

## Add music
1. Click **Add Music**.
2. The panel offers only **Upload background track MP3 / WAV / M4A**.
3. That invokes a native file picker, which this automation cannot drive. Escape closes the panel.

## Create and claim a template
1. Brand Studio > **Templates** > **New Template**.
2. Yarn creates immediately and opens `/template-editor/<id>` with title Untitled.
3. Replace title with a distinctive scratch name.

## Duplicate or move a template
- Card > **Template options** > **Duplicate Template** creates an inline `<name> Copy` immediately.
- Card > **Template options** > **Move to Brand** opens destination brands plus Back. Choosing one moves immediately with no confirmation and removes the card from the current list.

## Create a workflow
1. Brand Studio > **Workflows** > **New Workflow**.
2. Fill Name, Description, and Workflow instructions.
3. Click **Done** to create and return to the list.

## Create a text style
1. Brand Studio > **Type** > **New Text Style**.
2. Set name, preview, Font Weight, Font Size, line height, and letter spacing.
3. Font weights include Thin through Black.
4. Click **Done**.

## Edit paint/gradients
- Open a paint picker in Colors or an editor and choose Solid/Linear/Radial/Multi/Image/Shader.
- Solid exposes Hue, Opacity, Eyedropper, HEX/input format, and values.
- Linear/Radial expose flip stops, rotate 90°, add stop, position, opacity, and stop-color editing; Radial also exposed Remove gradient stop.
- Brand Colors changes brand defaults; draft/template paint is document/template scope.

## Configure screen clips at the correct scope
- **Brand default:** Brand Studio > **Screen Clips**.
- **Current draft override:** Draft > **Project actions** > **Screen Clip Settings…** > **Done**.
- Both expose Auto Hide, Hide/Show, Cursor Style (Arrow-first/Pointer-first/Original), shadow offsets, Cursor Clicks, Keyboard Presses, Fade Up, Off/Low/Medium/High intensity, Glide/Fixed, and sliders. These are separate stores; do not edit the brand panel when asked for one draft, or vice versa.

## Create/duplicate a brand
- New: Brand Overview > **Brand options** > **New Brand**; enter Brand name and click Done.
- Duplicate: **Brand options** > **Duplicate Brand**; Yarn navigates to `<source> Copy`. Use Rename Brand, enter Brand name, Done.
- **Make Default** changes the workspace default immediately with no confirmation.

# Dead ends & quirks
- Draft/template **Add Reference…** produced no accessible in-page UI in an empty scratch item; it may invoke unavailable/native import behavior.
- Collection **New in Collection** produced no observable UI change in an empty collection.
- **Copy Transcript** closed the menu with no in-page confirmation; likely clipboard-only.
- Publish Template, Publish, Send, Export/download, Invite Members, integrations, sign-in/sign-out, and Upgrade can be external or committing; do not trigger casually.
- Delete Template, Delete Collection, Archive Brand, and scene Delete are destructive. Rename/move existing user content is also unsafe; use only scratch objects.
- A destination selection in Move to Brand is immediate—there is no confirmation.
- New workspace and workspace switching are account/workspace mutations even though they appear in the workspace-name menu.
- Unlabeled left-rail shortcuts are recent/pinned content and vary by workspace.
- Cleanup candidates created during this mapping include Scratch-Workflow-Map-2026-B, Scratch-Collection-Map-2026-D (1666803617), Scratch-Draft-Map-2026-E (820643665), Copy of Scratch-Draft-Map-2026-E (566010239), Scratch-Brand-Map-2026-F (213), Scratch-Brand-Duplicate-Map-2026-G (214), Scratch-Template-Map-2026 and its moved Copy, Scratch-Template-Map-2026-H (1051), and possibly Scratch-Text-Style-Map-2026-C if its editor was completed.
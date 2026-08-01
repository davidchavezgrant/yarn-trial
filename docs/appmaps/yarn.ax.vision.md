<!-- provenance: explore-vision | app: Yarn | date: 2026-08-01 | backend: ax | actions: 309 | elapsed: 1h03m | calls: 442 | tokens-in: 1359661 | tokens-out: 80234 | cache-read: 5998592 | cache-write: 0 | findings: 29 | finds: 0 | controls (DECLARED): 173 actuated / 360 dismissed / 530 seen | surfaces: 21 | chapters: 29 | stopped: frontier-empty | descent: off | gated: 0 read / 0 refused -->
<!-- controls tallies are DECLARED — self-reported by the model from screenshots, not measured against an element list. A control the pass never declared is invisible to these numbers. -->
<!-- Written by src/core/explore.ts. DO NOT HAND-EDIT: edits make this a curated recipe, not exploration output — move such notes to docs/recipes/<app>.md instead. -->

# Layout

## Your Library (home)
- Stable landing view. Return via **Library** in the left sidebar; from an editor, if Library does not respond, click **Your Drafts**, which returned to the Library landing view in this build.
- Left sidebar: workspace switcher, Library, Your Drafts, document rows, New draft, Invite Members, Brand Kits, Settings.
- Main area: Search, Grid/List, sort, **+ New Draft**, collections, **New Collection**, and draft cards.
- **Settings** and Cmd+, produced no visible settings surface in the observed build.

## Brand Kit
- From Library click **Brand Kits**, then select a kit. Secondary rail: Brand Overview, Templates, Workflows, Colors, Type, Screen Clips, Motion, Layout, Misc.
- **Templates**: grid/list/order controls and **New Template**. New Template can open the full Template Editor after delayed navigation.
- **Workflows**: empty list plus New Workflow; observed as a no-op.
- **Colors** (brand scope): Background Colors, Text Colors, Add tiles, and Color Notes. Clicking an existing swatch opens the color picker.
- **Type** (brand scope): Primary Font, Secondary Font, Text Styles, New Text Style, Font Usage Notes.
- **Screen Clips** (brand scope): cursor behavior/style/scale; window padding and shadow values; click/keyboard sounds; entrance/exit animation; motion blur.
- Motion and Layout repeatedly failed to navigate in the observed scratch brand.

## Draft Editor
- Header: editable document title, add/more affordances, Agent tab, top-right comments/music/language/display icons, Export.
- Script area starts as a single input. Entering `#` converts it into scene view.
- Scene view: canvas, per-scene script rows, canvas add control, multi-track timeline, play/fit/captions/media/record tools, and agent/comment composers.
- Right-click a document row in the editor sidebar for Move, Rename, Make a copy, Add to Collection, and Delete.

## Template Editor
- Reached from Brand Kit → Templates → New Template. A scratch **Untitled Template** was created.
- Header: editable title, +, …, Agent/Layers, Export, Publish Template.
- Right inspector (document/template scope): Duration, Opacity, three Layout modes, Background, Motion Blur, Description, Webcam Preview, Project BG Preview.
- Central canvas and four-second timeline with play/fit/text/media/duplicate/comment tools and Auto Hide Layers.

# How to

## Create a draft
1. On Your Library click **+ New Draft** or sidebar **New draft**.
2. In the editor, click the header title to edit it; only rename scratch content.
3. To create a scene, focus the Script input and type only `#` as a separate action.
4. After the UI reflows to **Untitled Scene**, refocus the scene title/body before typing the rest. A long automated string beginning with `#` can lose focus and spill into the floating comment composer.

## Return home from an editor
1. Click **Library**.
2. If it does not navigate, click **Your Drafts**; in the observed build this returned to the Your Library landing surface with Library selected.

## Edit a brand color
1. Library → **Brand Kits** → select kit → **Colors**.
2. Click an existing Background or Text swatch.
3. Use Solid/Linear/Radial/Multi/Image, 2D color field, hue/opacity sliders, eyedropper, HEX value, and numeric opacity.
4. This changes the brand-scoped palette, not a document background override.

## Change brand typography
1. Brand Kit → **Type**.
2. Click Primary Font or Secondary Font to open the searchable inline font catalogue.
3. Choose the desired family/weight. These are brand-scoped defaults.

## Change brand screen-clip defaults
1. Brand Kit → **Screen Clips**.
2. Adjust Cursor, Screen Display, Sound Effects, or Visual Effects.
3. Observed values included Cursor Scale 1.60; padding 18; shadow opacity 72%, blur 32, spread -18, X 0, Y 12; Fade Up; Motion Blur Medium.
4. This panel is brand scope. No reliable per-document screen-clip override was exposed; the draft display icon was inert.

## Create and inspect a template
1. Brand Kit → **Templates** → **New Template**.
2. Wait for navigation if nothing immediately changes; it eventually opened the Template Editor in this run.
3. Edit the header title for scratch content.
4. Use the right inspector for per-template Duration, Opacity, Layout, Background, Motion Blur, Description, Webcam Preview, and Project BG Preview.
5. Do not click Publish Template during exploratory/local-only work.

## Duplicate a scratch draft
1. In the editor’s left sidebar, right-click the scratch document row.
2. Choose **Make a copy**.
3. A copy appears as another row; the editor may remain on the original. A toast may describe the copy as moved into the current workspace/collection.

## Open document context actions
- Right-click a document row in the editor sidebar. Menu: Move to workspace, Rename, Make a copy, Add to Collection, Delete (and in one list state Make Private Draft).
- Only rename/move/delete scratch content.

# Dead ends & quirks
- A final sweep found no additional unseen navigation affordances beyond the sidebar, brand-kit rail, editor tabs/toolbars/overflow controls, and context menus already explored.
- Numerous controls render as active but produced no visible response in this build. Do not infer that a panel opened unless the UI visibly changes.
- Global **Settings** and Cmd+, were no-ops.
- New Collection, New Workspace, New Workflow, New Text Style, Add BG, draft background swatch, top-right comments/music/language/display controls, agent attachment, Export, and many canvas/timeline tools produced no visible surface.
- New Template initially appeared to no-op, but later did open the Template Editor; allow for delayed navigation.
- Brand Kit Motion and Layout repeatedly failed to navigate.
- Template inspector **Description** is not a normal text field here. Clicking it opened a large blank modal with only a bottom upload icon; it stayed blank after 60 seconds. Press Escape to close.
- Draft header ellipsis reveals narration voice **Annie** beside the waveform, but Annie/waveform did not open a picker.
- Clicking the agent quality label **High** did not open a menu and could shift focus to scene script.
- In scene view, right-clicking a timeline Overlay clip did not open a menu and instead focused Script.
- Right-clicking the canvas text object opened a tiny menu containing only **No actions**.
- Add to Collection from the sidebar document menu did not show a picker and left an unexpected highlighted/edit-like row; Escape restored normal state.
- Template-looking labels in the document sidebar may be ordinary/truncated document rows; use Brand Kit → Templates to identify real templates.
- Current pass created several scratch drafts/copies/templates/brands/collection objects with names beginning Scratch/Copy/Untitled. They are safe scratch artifacts but should be cleaned up separately if desired.
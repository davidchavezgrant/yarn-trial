<!-- provenance: explore-vision | app: Yarn | date: 2026-08-03 | backend: cdp | actions: 245 | elapsed: 58m | calls: 472 | tokens-in: 1262243 | tokens-out: 102581 | cache-read: 5850112 | cache-write: 0 | findings: 59 | finds: 0 | controls (DECLARED): 145 actuated / 220 dismissed / 363 seen | surfaces: 22 | chapters: 23 | stopped: frontier-empty | descent: off | gated: 0 read / 0 refused -->
<!-- controls tallies are DECLARED — self-reported by the model from screenshots, not measured against an element list. A control the pass never declared is invisible to these numbers. -->
<!-- Written by src/core/explore.ts. DO NOT HAND-EDIT: edits make this a curated recipe, not exploration output — move such notes to docs/recipes/<app>.md instead. -->

# Layout

## Your Library (home)
- **Library** in the left sidebar is the ordinary landing view and safest starting point.
- Main area: Collections, Search, Grid/List controls, Sort, draft cards, **New Collection**, and **New Draft**.
- Sidebar: Library, Your Drafts, recent drafts, Invite Members, Brand Kits, Settings.
- Right-click a draft card for its context menu; **Make a copy** acts immediately with no confirmation.

## Draft editor
- **New Draft** opens an autosaved **Untitled** draft directly, with no setup chooser.
- Top area includes title, Agent/Script, ellipsis, recording, canvas/view, comment, music, Globe, and Export affordances.
- Persistent agent composer is lower-left; the timeline spans the bottom.
- In Script view, focus the writing area and type `#` to add a scene. One observed press unexpectedly created two 5-second scenes.
- In Agent/canvas view, centered **+** immediately creates a large `New Text` object; it is not a menu.
- Selecting canvas content exposes document-scoped formatting. Text selection offers font, weight, size, alignment, and color. Group selection offers fill/color, layout/reorder, crop, border, corner radius, zoom status, and Ungroup.
- Selection toolbar’s leftmost waveform-like control is document **Voice**, not Exit. It opens English/World/Creative tabs and voices Annie, Cassidy, Jacob, James, Kendra, Robert, Brynn, Fay, Jada, Jeff, Miranda, and Sarah, plus Default Speed.
- Circular color control opens presets, Solid/Linear/Radial/Multi modes, saturation/brightness, hue, eyedropper, HEX, and opacity.
- Right-clicking a selected generated group showed only disabled **No actions**.
- Right-clicking a recent sidebar draft row opens Move to workspace, Rename, Make a copy, Add to Collection, and Delete.

## Settings
- **Settings** opens a centered modal.
- Preferences: app-wide Auto-Add Screen Zooms; Theme Dark/Light/System (`Shift+Command+\` quick switch); Agent model; Agent effort.
- Models: Opus 5, Fable 5, Opus 4.8, GPT-5.6 Sol. Opus 5 conditionally reveals checked **Agent Fast Mode default**.
- Efforts: Low, Medium, High, Extra High, Max.
- Workspace settings: name, icon upload, custom recording window sizes, Add Size, Figma and Google Slides sign-in.
- **Add Size** immediately creates a sequential editable row, initially 1440×897, with Remove.

## Workspace menu
- Click workspace name/logo at sidebar top. It lists workspaces, highlights the current workspace, and includes New workspace and Sign out. New workspace was disabled/inert.

# How to

## Create a draft
1. Click **Library**.
2. Click **New Draft**.
3. Yarn opens autosaved Untitled directly.

## Ask Yarn to generate
1. Open/create a draft.
2. Enter a request in the lower-left composer.
3. Click the black up-arrow Send.
4. Wait generously: an observed request looked inert, then completed about a minute later and populated Agent/canvas view.

## Add Script scenes
1. Select **Script**.
2. Focus the writing area.
3. Type `#`.
4. Verify scene count because one press created two scenes once.

## Add and format canvas text
1. In Agent/canvas view click centered **+** to create `New Text`.
2. Select/double-click text until its toolbar appears.
3. Font family opens a searchable long list. Weight choices: Light, Regular, Medium, Semibold, Bold, Heavy, Black.
4. A weight change may apply and clear selection.
5. Click blank canvas or press Escape to exit; do not use the leftmost toolbar control, which opens Voice.

## Change document narration voice
1. Select canvas/group content.
2. Click the leftmost voice control in the selection toolbar.
3. Choose a tab and voice. This is document-scoped.

## Change selected content color
1. Select the object/group.
2. Click the far-right circular color control.
3. Choose a preset/mode or edit HEX and opacity.

## Search library
1. Click **Library**.
2. Type a title substring in **Search**; draft cards filter live.

## Duplicate a draft
1. In Library, right-click the intended card.
2. Choose **Make a copy**.
3. Duplication is immediate with no confirmation.

## Configure new-chat defaults
1. Open **Settings**.
2. Set Agent model and Agent effort under Preferences.
3. These defaults are distinct from document-scoped Voice and canvas formatting.

# Dead ends & quirks
- Tested controls showing no visible response in the current blank/generated states include editor ellipsis, Music, comments, Export, screen recording, Add media, Record, Add text, Add screen zoom, Globe, two view icons, group Add BG/Ungroup/zoom display, and several group-style controls.
- Brand Kits and Your Drafts did not visibly navigate. Library List did not visibly replace Grid. Sort showed no menu/obvious reorder. New Collection and a visible collection label showed no visible flow/navigation.
- One late Library click from a populated editor did not navigate, though Library worked normally earlier.
- Timeline Trash does nothing with nothing selected. Tested timeline overlay/narration/scene right-clicks opened no menu; overlay double-click opened no editor. Preview Play did not start.
- Composer Low effort indicator and attachment button appeared inert; use Settings for default effort.
- Choosing SF Pro Display once closed its picker but toolbar still showed Cereal; verify font changes. Choosing Bold applied and deselected text.
- Workspace account card and New workspace were inert. External Invite Members, integration sign-ins, Sign out, Publish/Share were not completed.
- Scratch artifacts include multiple Untitled/Brew drafts, copy/copies, a New Text object, Script scenes, and custom size `Custom 2`.
- Three successive final sweeps found no unvisited visible navigation doors among sidebar destinations, workspace menu, Settings, Agent/Script, ellipsis and top toolbar, canvas controls, timeline toolbar, library controls, or context menus. Sidebar Rename/Delete/Add to Collection were skipped because the generic Untitled row could not be reliably proven exploration-owned after transcript reset.
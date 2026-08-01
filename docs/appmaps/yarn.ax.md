<!-- provenance: explore | app: Yarn | date: 2026-08-01 | backend: ax | actions: 115 | elapsed: 23m | calls: 197 | tokens-in: 1368325 | tokens-out: 25631 | cache-read: 8124928 | cache-write: 0 | findings: 29 | finds: 0 | controls: 69 actuated / 187 dismissed / 394 seen | surfaces: 35 | chapters: 11 | stopped: frontier-empty | descent: off | gated: 0 read / 4 refused -->
<!-- controls actuated/seen is a LOWER BOUND ON BREADTH, not a coverage percentage: the denominator only grows as surfaces are opened, and operating a control is not understanding it. -->
<!-- Written by src/core/explore.ts. DO NOT HAND-EDIT: edits make this a curated recipe, not exploration output — move such notes to docs/recipes/<app>.md instead. -->

# Layout

## Library (home)
- Stable landing/overview: click **Library** in the persistent left rail.
- Header: **Search**, **Grid/List**, sort popup, **New Draft**.
- **Collections** row contains collection buttons and **New Collection**.
- Draft cards show an ellipsis actions popup. Accessibility may expose duplicate ellipsis wrappers; verify that menu text actually appears after clicking.
- **Your Drafts** is a separate left-rail overview. Open documents, templates, and Brand Kits also appear as temporary left-rail tabs.

## Settings
- Open from left rail **Settings**; close with the modal’s top-right X.
- Preferences: Auto-Add Screen Zooms, Theme (Dark/Light/System), Agent model (Opus 5, Fable 5, Opus 4.8, GPT-5.6 Sol), Agent effort (Low/Medium/High/Extra High/Max), Agent Fast Mode.
- Workspace settings: name, icon, custom recording window sizes (**Add Size/Remove**).
- Also contains plan/Upgrade, integrations (Figma, Google Slides, Notion MCP, team/personal YouTube, Screen Studio Import), and team members.

## Brand Kit
- Click **Brand Kits** in the left rail, then choose a brand. The popup marks the primary brand.
- Tabs: **Brand Overview, Templates, Workflows, Colors, Type, Screen Clips, Motion, Layout, Misc**.
- **Templates**: Grid/List, newest/A–Z sort, New Template, template selection, name/description, Edit Template, options menu.
- **Workflows**: custom workflow list; opening one shows Name, Description (“When should the agent use this?”), Prompt/instructions, Delete/Cancel/Done.
- **Colors**: brand Background and Text palettes, color picker/actions, Add Background/Add Text Color, Color Notes.
- **Type**: Primary Font, Secondary Font, weights, New Text Style, Font Usage Notes.
- **Screen Clips**: brand defaults for cursor, screen/window display, sound effects, visual effects, default zoom type/level.
- **Motion/Layout/Misc**: freeform guidance fields.
- Brand options: Rename Brand, Make Default, Duplicate Brand, New Brand, Archive Brand.

## Draft editor
- Left panel has **Agent/Script**, voice picker, **Project actions**, transcript, composer, composer actions, and per-message effort.
- Preview/canvas is central; timeline and insertion toolbar are below.
- Top status controls: composition paint, captions, music, Publish, Export.
- Timeline insertion controls include overlays, media upload, recording/text-slide style actions, talk track, comments, Library, and Timeline Zoom.

## Per-document Screen Recording Settings
- Draft editor → **Project actions** → **Screen Clip Settings…**.
- Mirrors Brand Kit Screen Clips but changes only the current draft: cursor visibility/style/scale; padding and shadow; click/key sounds; entrance/exit animation; motion blur; default zoom type/level.
- Close with **Done**.

## Voice picker
- Click **Select voice**.
- Tabs: English, World, Creative. English includes Annie, Brynn, Cassidy, Fay, Jacob, Jada, James, Jeff, Kendra, Miranda, Robert, Sarah.
- Speaker icon previews a voice. **Default Speed** offers Slowest, Slow, Default, Fast, Faster.

## Overlay editor
- Timeline overlay-template picker → **New Blank Overlay** creates a four-second overlay and opens overlay editing.
- Top bar: **Insert**, background paint/Add BG, detail-panel button.
- Insert menu: Text, Image, Video, Icon, Rectangle, Ellipse, Polygon, Line, Arrow, Pen, Group.
- Selecting a text layer exposes layout, font, weight, size, alignment, fill, opacity, and detail panel.
- Detail panel includes position/alignment/X/Y/rotation; layout/W/H/scale/anchors; typography; opacity/corner radius/fill; Highlight/Stroke/Shadow/Blur.

## Caption styling
- Draft top captions icon switches the top bar into per-draft caption styling: Presets, font, weight, size, paint, Effects, Hidden, and more menu.

## Native pickers
- Composer actions → **Add Reference…** opens a macOS Open dialog; Cancel exits.
- Timeline media control opens a centered popover with a laptop-upload button, then a local file chooser.
- **Add Music** opens “Upload background track” (MP3/WAV/M4A), then a local file chooser.

# How to

## Create a draft
1. From Library, click **New Draft** (or left-rail **New draft**).
2. Name the scratch draft distinctly once the editor opens.
3. Use **Script** for transcript editing or **Agent** for assisted editing.

## Change a draft’s brand
1. Open the draft.
2. Open **Project actions** → **Brand**.
3. Choose a brand; this changes only the current document’s assignment.
4. **Edit Brands…** navigates to the brand-wide Brand Kit instead.

## Change aspect ratio or performance
1. Draft → **Project actions**.
2. Choose Widescreen (16:9), Laptop (16:10), Square (1:1), or Vertical (9:16); it applies immediately.
3. Performance Mode choices are Efficiency, Default, Ultra.

## Make a draft copy
1. Draft → **Project actions** → **Make a copy**.
2. Yarn immediately creates and opens “Copy of <original>”, inheriting timeline contents.

## Copy transcript / download subtitles
- Draft → **Project actions** → **Copy Transcript** copies to clipboard with no confirmation.
- Adjacent **Download SRT…** enters a native save flow.

## View version history
1. Draft → **Project actions** → **Show Version History…**.
2. A right popover shows timestamp/author entries and explains reversible reverts.
3. Close with **Close**. Revert changes document content, so confirm the intended version first.

## Create/edit a reusable workflow
1. Brand Kit → **Workflows** → New Workflow or open an existing workflow.
2. Fill Name, Description, and Prompt/instructions.
3. Click **Done**.

## Create/duplicate a brand
1. Open **Brand Kits** and start the new-brand flow.
2. Enter Brand name and optional Overview; **Done** opens its Brand Kit.
3. To duplicate: Brand options → **Duplicate Brand**; copy is created immediately as “<name> Copy”.

## Adjust screen-clip behavior at the correct scope
- Brand-wide default: Brand Kit → **Screen Clips**.
- Current-draft override: Draft → **Project actions** → **Screen Clip Settings…**.
- These are separate stores; do not edit Brand Kit when the task asks for one draft, or vice versa.

## Add an overlay text layer
1. Draft timeline overlay picker → **New Blank Overlay**.
2. Overlay top bar → **Insert** → **Text**.
3. Select the new “New Text” layer.
4. Use top-bar controls for quick formatting or the right detail panel for full geometry/typography/effects.

# Dead ends & quirks
- Clicking a web control may warn that it lacks AXPress but still work; trust the next observation.
- Library card ellipses can appear twice in accessibility (row and column wrappers); one may silently no-op.
- Aspect ratio, Make a copy, and Duplicate Brand apply immediately without confirmation.
- Copy Transcript has no visible confirmation.
- Publish/share/invite/export completion and destructive actions on pre-existing user content were not executed.
- Version reversion was not executed because it would alter existing document history.
- Local upload/reference controls proceed to native file dialogs; Cancel safely returns.
- Scratch artifacts created during mapping and safe to clean up: **Scratch Collection M11**, **Scratch Collection Draft M11**, copies named **Copy of Scratch Collection Draft M11**, **Scratch Template Map M11**, **Untitled Template**, **Scratch Brand Map M11**, **Scratch Brand Map M11 Copy**, and an **Untitled Brand** tab if still present. Scratch Collection Draft M11 contains a four-second Overlay with a New Text layer.
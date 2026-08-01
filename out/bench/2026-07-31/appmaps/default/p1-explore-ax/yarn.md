<!-- provenance: explore | app: Yarn | date: 2026-07-31 | backend: ax | actions: 133 | elapsed: 28m | calls: 229 | tokens-in: 1649907 | tokens-out: 35004 | cache-read: 9495552 | cache-write: 0 | findings: 37 | finds: 0 | controls: 46 actuated / 373 dismissed / 418 seen | surfaces: 31 | chapters: 13 | stopped: frontier-empty | descent: off | gated: 0 read / 2 refused -->
<!-- controls actuated/seen is a LOWER BOUND ON BREADTH, not a coverage percentage: the denominator only grows as surfaces are opened, and operating a control is not understanding it. -->
<!-- Written by src/core/explore.ts. DO NOT HAND-EDIT: edits make this a curated recipe, not exploration output — move such notes to docs/recipes/<app>.md instead. -->

# Layout

## Library (home)
- Yarn opens on **Library**. Return via the left-rail **Library** control.
- Left rail: workspace switcher, Library, Your Drafts, named draft/template shortcuts, **New draft**; bottom: Invite Members, **Brand Kit**, **Settings**.
- Library header: Search, Grid/List, sort popup, New Draft. Collections has New Collection. Draft cards have editable titles and ellipsis menus.

## Settings
- Open **Settings** from the bottom of the left rail; it appears as a scrollable modal. Close with the top-right X.
- Preferences: Auto-Add Screen Zooms; Theme (Dark/Light/System); Agent model; Agent effort; Agent Fast Mode.
- Agent model choices: Opus 5, Fable 5, Opus 4.8, GPT-5.6 Sol.
- Agent effort choices: Low, Medium, High, Extra High, Max.
- Scroll for plan/Upgrade, workspace name/icon, custom recording window sizes, integrations, and team members.
- Integrations shown: Figma, Google Slides, Notion MCP, Team/Personal YouTube, Screen Studio import.

## Brand Kit
- Open **Brand Kit** from the bottom of the left rail. Inner navigation: Brand Overview, Templates, Workflows, Colors, Type, Screen Clips, Motion, Layout, Misc.
- **Brand Overview:** Overview notes and Brand options (Rename, Duplicate, New, Archive).
- **Templates:** workspace template gallery with Grid/List, Newest/A–Z sorting, New Template. Selecting a template shows name, Edit Template…, Template options, and description.
- **Workflows:** workflow gallery; currently empty, with New Workflow.
- **Colors:** brand-wide Background and Text palettes, swatch paint pickers/actions, and Color Notes. Paint types: Solid, Linear, Radial, Multi, Image, Shader. Swatch actions: Make Default, Duplicate, Remove.
- **Type:** Primary Font, Secondary Font, New Text Style, Font Usage Notes.
- **Screen Clips:** brand-wide cursor, screen-window/shadow, sound, animation, motion-blur, and default-zoom defaults.
- **Motion / Layout / Misc:** one brand-wide notes field each.

## Document editor
- Open a named draft from the left rail or Library.
- Left panel tabs: **Agent** and **Script**. Center is the composition canvas. Top-right: composition paint, captions, music, Publish, Export, Insert, Add BG, detail-panel toggle. Bottom: playback, insert/record/comment tools, Library, Timeline Zoom, timeline.
- Project-title ellipsis opens **Project actions**: Copy Transcript, Make a copy, Download SRT…, Screen Clip Settings…, Show Version History…, Brand submenu, aspect ratio, Performance Mode, Delete.
- **Agent:** composer-actions (+) menu offers Add Reference… and Switch to Media Gen.
- **Script:** editable transcript grouped into scenes; placeholder says “Type script or # for new scene.”
- Detail-panel toggle opens **Layers**; with nothing selected it says “No layers.”

# How to

## Change app defaults for new agent chats
1. Left rail → **Settings**.
2. Open **Agent model** or **Agent effort** and choose an option; Agent Fast Mode is a checkbox.
3. Close with X.
These are app/workspace defaults for new chats, not current-chat controls.

## Edit brand-wide screen-clip defaults
1. Left rail → **Brand Kit** → **Screen Clips**.
2. Adjust cursor, padding/shadow, sounds, entrance/exit, motion blur, or default zoom.
These are brand-wide defaults.

## Edit one document’s screen-clip settings
1. Open the draft.
2. Open **Project actions** beside the project title.
3. Choose **Screen Clip Settings…**.
4. Adjust values in **Screen Recording Settings**.
5. Click **Done**.
These are document overrides. They mirror Brand Kit’s Screen Clips controls but are a separate scope/store.

## Choose document narration voice/speed
1. In the editor, click the voice selector.
2. Choose a language tab (English, World, Creative), voice, or **Default Speed**.
3. Speed choices: Slowest, Slow, Default, Fast, Faster.
English voices observed: Annie, Brynn, Cassidy, Fay, Jacob, Jada, James, Jeff, Kendra, Miranda, Robert, Sarah.

## Insert a canvas element
1. Editor top-right → **Insert**.
2. Choose Text, Image, Video, Icon, Rectangle, Ellipse, Polygon, Line, Arrow, Pen, or Group.
This immediately adds document content.

## Add music
1. Click the editor music control.
2. Choose No background track or a track; play icons preview.
3. The bottom upload area imports custom audio.
Choosing/uploading changes the document.

## Use Media Gen
1. Agent tab → composer-actions (+) → **Switch to Media Gen**.
2. Open the model popup and choose Gemini, GPT Image 1.5, or Seedream-4; quantity dots are per model.
3. Preferred Layout choices: Auto, Landscape, Portrait.
4. **Save as default** is stateful.

## Add existing library media to a document
1. Editor bottom → **Library**.
2. In **Add from Library**, choose Everything, Images, Screen Clips, Webcams, Videos, or Projects.
3. Search or select an asset; selecting inserts it.
4. **Upload Camera Footage** starts an import flow.

## Use the two bottom insertion popups
- First unlabeled popup immediately right of timecode (overlay-slide icon): opens **Default Brand Templates**; choose a template or New Blank Overlay.
- Second unlabeled popup (media/photo icon): opens recent-media thumbnails plus an upload control.
Both insert document content.

## Adjust timeline view
1. Editor bottom → **Timeline Zoom**.
2. Move the minus-to-plus slider.
This changes only the editor view, not document content.

## Edit colors without confusing scopes
- Brand palette: **Brand Kit → Colors**; swatch paint picker edits brand colors.
- Composition background: editor top status-bar paint; observed Solid #6985FF.
- Scene/background layer: editor **Add BG**; includes None, brand swatches, and paint editor; observed editor value #1A1A2E.
These are distinct controls/stores.

# Dead ends & quirks
- **Publish** is externally visible; do not use while merely navigating or setting up.
- Export was blocked by the safety harness, so its submenu was not mapped.
- New Draft, New Collection, New Template, New Workflow, edits, uploads, insertions, scene deletion, template edits, and Brand options mutate state and were intentionally not executed.
- Add Reference… opens a macOS Open panel; cancel reliably with **Cmd+.**.
- Paint pickers can be inspected without changing values; dismiss with **Escape**.
- Captions is a direct document toggle, not a settings panel. Selecting a caption exposes Presets, font, weight, size, paint, Effects, Hidden, and ellipsis formatting controls.
- Theme shortcut shown in Settings: **Shift+Cmd+\\**.
- After prolonged exploration, the Electron renderer became entirely black while menus/app process remained alive. Reload and Force Reload did not recover it. Treat this as an app/renderer failure, not a valid surface.
<!-- provenance: explore | app: Yarn | date: 2026-08-01 | backend: ax | vision: off | actions: 163 | elapsed: 30m | calls: 328 | tokens-in: 1316890 | tokens-out: 54149 | cache-read: 11244544 | cache-write: 0 | findings: 42 | finds: 0 | controls: 52 actuated / 1021 dismissed / 1070 seen | surfaces: 30 | chapters: 15 | stopped: frontier-empty | descent: off | gated: 0 read / 2 refused -->
<!-- controls actuated/seen is a LOWER BOUND ON BREADTH, not a coverage percentage: the denominator only grows as surfaces are opened, and operating a control is not understanding it. -->
<!-- Written by src/core/explore.ts. DO NOT HAND-EDIT: edits make this a curated recipe, not exploration output — move such notes to docs/recipes/<app>.md instead. -->

# Layout

## Global navigation
- Left rail **Library** is the ordinary landing view (“Your Library”). It has Search, Grid/List, sort, **New Draft**, **New Collection**, and project cards.
- Left rail **Your Drafts** opens a drafts-only list with the same search/display/sort/new-draft pattern.
- Left rail **Brand Kit** opens brand/workspace defaults. Inner tabs: Overview, Templates, Workflows, Colors, Type, Motion, Layout, Misc, and Screen Clips.
- Click **David's Workspace** at top-left for the workspace switcher. It lists the current workspace, New workspace, and Sign out.
- Global **Settings** opens a large scrollable modal containing profile, Preferences, plan, Workspace settings, Integrations, and Team Members.
- **Invite Members**, authentication, workspace creation/sign-out, and Upgrade are account/external actions and were not operated.

## Brand Kit (brand/workspace scope)
- **Overview:** editable Overview notes and an ellipsis menu: Rename Brand, Duplicate Brand, New Brand, Archive Brand.
- **Templates:** Grid/List, newest/A–Z sorting, New Template, asset list, editable name/description, Edit Template…, and Template options (Duplicate, Move to Brand, Delete).
- **Workflows:** empty in the observed brand; **New Workflow** creates persistent data.
- **Colors:** background palette, text palette, editable Color Notes, and paint pickers. Observed background colors: `#6985FF`, `#26272A`, `#EDEEF8`, `#000000`; text colors: `#6985FF`, `#FFFFFF`, `#505155`, `#14181E`.
- **Type:** Primary Font (Inter with Light/Regular/Medium/Semibold/Bold/Heavy/Black), Secondary Font (None), New Text Style, Font Usage Notes.
- **Motion**, **Layout**, and **Misc:** guidance-note fields only; they are not numeric defaults panels.
- **Screen Clips:** brand defaults for Auto-Hide Cursor, Text Cursor, Cursor Style/Scale, window padding, shadow opacity/blur/spread/X/Y, cursor-click and keyboard sounds, entrance/exit animation, Motion Blur, Default Zoom Type, and Default Zoom Level.

## Settings
- Preferences: Auto-Add Screen Zooms; Theme (Dark/Light/System, quick switch Shift+Command+\\); Agent model (Opus 5, Fable 5, Opus 4.8, GPT-5.6 Sol); Agent effort (Low, Medium, High, Extra High, Max); Agent Fast Mode default.
- Workspace settings: workspace name/icon, custom screen-recording sizes, Add Size, Integrations, Team Members. Observed sizes: Default 1440×897 and Custom 1 1600×987.
- Close the modal with its top-right X or Escape.

## Document editor (document scope)
- Opening a card enters the editor while retaining the global left rail. Main areas: Agent/Script tabs, title, voice picker, project-actions menu, scenes/transcript, composition/caption/music controls, Insert, right detail panel, playback/timeline toolbar, and Library/media insertion controls.
- **Project actions:** Copy Transcript, Make a copy, Download SRT…, Screen Clip Settings…, Show Version History…, Brand selector, aspect ratio, performance mode, Delete.
- Aspect ratios: Widescreen 16:9, Laptop 16:10, Square 1:1, Vertical 9:16. Performance modes: Efficiency, Default, Ultra.
- **Screen Clip Settings…** opens document-scoped overrides mirroring Brand Kit > Screen Clips. These are separate stores despite matching observed values.
- **Voice picker:** English, World, Creative tabs plus Default Speed. World includes German, Danish, Spanish, French, Italian, Japanese, Dutch, and Swedish voices. Creative includes Cartoon, Cowboy, Demon, Epic Movie Trailer, Grandpa, Mad Scientist, Tough Guy, Wizard.
- **Insert:** Text, Image, Video, Icon, Rectangle, Ellipse, Polygon, Line, Arrow, Pen, Group. Choosing one mutates the document.
- **Captions mode:** Presets, font, weight, size, text paint, Effects, visibility, more menu. Effects includes Background layout/opacity/radius/grouping/padding, Active Word, Future Word, Text Border, Text Shadow, Transitions.
- **Music:** No background track, built-in tracks, and an upload strip.
- **Add from Library:** modal tabs Everything, Images, Screen Clips, Webcams, Videos, Projects; each has search and a virtualized grid/list. Selecting an item inserts/reuses content.
- Bottom insertion popovers include Default Brand overlay templates/New Blank Overlay and a recent-media browser.
- Agent composer **+** offers Add Reference… and Switch to Media Gen. Its local Effort popover is a document/conversation runtime override of the global Agent effort default.
- Scene ellipsis menus: Copy Scene, Copy Transcript, Delete Scene. Empty scenes expose direct Delete.

# How to

- **Open a project:** click **Library** or **Your Drafts**, then click a project/draft card. Card titles are inline text fields.
- **Open a card menu reliably:** right-click the card title text field; choose Move to David's Workspace, Rename, Make a copy, or Delete. Plain-clicking the ellipsis sometimes silently no-ops.
- **Change Library sort:** click the sort dropdown; options are Newest first, Oldest first, A - Z, Z - A.
- **Open global settings:** click **Settings** in the left rail; scroll inside the large modal to Preferences, Workspace settings, Integrations, or Team Members; close with Escape or X.
- **Inspect global agent defaults:** Settings > Agent model / Agent effort. Escape closes a dropdown without changing it.
- **Edit brand screen-recording defaults:** Brand Kit > Screen Clips. These apply at brand scope.
- **Edit one document’s screen-recording settings:** open the document > project-actions ellipsis > **Screen Clip Settings…**. Click Done to apply or Escape to leave unchanged. Do not confuse this with Brand Kit defaults.
- **Open a paint picker:** click a color swatch or **Open paint picker**. Tabs are Solid, Linear, Radial, Multi, Image, Shader; Solid exposes color/hex, Hue, Opacity, Eyedropper, and format switcher. Escape closes unchanged.
- **Style captions:** click the top captions icon, then use Presets/font/weight/size/paint/Effects/visibility. Escape out of popovers to preserve settings.
- **Choose a voice:** click the current voice name (observed Sarah), switch English/World/Creative, optionally use Default Speed, then select a voice. Category switching alone is non-mutating.
- **Add background music:** click **Add Music**, then choose No background track or a built-in track. The bottom upload strip opens a macOS file dialog; in this environment cancel that dialog with Command+Period.
- **Browse reusable media:** bottom toolbar **Library** > choose a category tab > search/browse. Clicking an asset inserts it, so use Escape to inspect without mutation.
- **Toggle right properties panel:** click the unlabeled panel-right icon. With nothing selected it shows Layers / No layers; select a canvas or timeline layer before expecting properties.
- **Open scene actions:** click a populated scene header’s ellipsis. Use Escape to close without action.

# Dead ends & quirks
- Brand Kit > Motion and Layout are guidance notes only; numeric animation/zoom defaults are under Screen Clips.
- Brand Kit Screen Clips and editor Screen Clip Settings expose the same setting names but have different scopes (brand defaults versus document overrides).
- Global Agent effort is an app/workspace default; the Agent composer Effort popover is a document/conversation-local runtime override.
- Publish, Export, Invite Members, sign-in/out, integrations, Upgrade, uploads, and account/workspace changes are externally consequential and were not operated. Export was blocked by the safety harness, so formats were not inspected.
- New Draft/Collection/Template/Workflow/Text Style/Blank Overlay and insert controls create persistent content and were not invoked.
- Add Music upload opens a native Open dialog; Escape and Command+W did not close it, but Command+Period did.
- Search placeholders in Add from Library can lag after rapid tab switching; trust the selected tab and grid contents.
- Font, voice, media, and project rows are large repetitive leaf lists; individual choices were not selected because they mutate content.
- Escape should generally be sent to the foreground to close web overlays reliably.
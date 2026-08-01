<!-- provenance: explore | app: Yarn | date: 2026-08-01 | backend: ax | vision: off | actions: 141 | elapsed: 34m | calls: 243 | tokens-in: 1660410 | tokens-out: 34375 | cache-read: 11958272 | cache-write: 0 | findings: 42 | finds: 0 | controls: 85 actuated / 269 dismissed / 622 seen | surfaces: 44 | chapters: 13 | stopped: frontier-empty | descent: off | gated: 0 read / 2 refused | blackouts: 1 | relaunches: 1 -->
<!-- controls actuated/seen is a LOWER BOUND ON BREADTH, not a coverage percentage: the denominator only grows as surfaces are opened, and operating a control is not understanding it. -->
<!-- Written by src/core/explore.ts. DO NOT HAND-EDIT: edits make this a curated recipe, not exploration output — move such notes to docs/recipes/<app>.md instead. -->

# Layout

- **Library (home)** — left rail **Library**. Workspace overview with search, Grid/List, sort, **New Draft**, collections, **New Collection**, and project cards with ellipsis menus.
- **Your Drafts** — left rail **Your Drafts**. Same search/view/sort controls, filtered to Draft projects.
- **Workspace switcher** — click the workspace name at top left. Lists workspaces plus **New workspace** and **Sign out**.
- **Draft Editor** — open a project card or click **New draft/New Draft**. Left panel contains title, Agent/Script, voice, project actions, scenes/script, and agent composer. Top has composition paint, captions, music, Publish, Export. Bottom has playback, overlay/media/record/comment inserts, Library, timeline zoom, scene timeline, and Add scene.
- **Brand Kits** — left rail **Brand Kits** (or **Brand Kit** in a one-brand workspace), then choose a brand. Sections: Brand Overview, Templates, Workflows, Colors, Type, Screen Clips, Motion, Layout, Misc.
- **Settings** — left rail **Settings** opens one scrollable modal with preferences, plan/workspace settings, recording sizes, integrations, and members.
- **Collection** — Library → click a collection. Header has search, view, sort, **New in Collection**, ellipsis, and **Your Library** back button.

# How to

## Create and organize

- **Create a draft:** click left-rail **New draft**, Library **New Draft**, or collection **New in Collection**. Collection creation immediately makes an Untitled draft in that collection; there is no wizard.
- **Create a collection:** Library → **New Collection** → enter Collection name → choose one of eight colors → **Create**.
- **Create a workspace:** workspace switcher → **New workspace** → enter Workspace name → **Create Workspace**. Creation immediately switches workspace.
- **Project card menu:** open the card ellipsis (right-click if AX only advertises ShowMenu). Commands include Move to workspace, Add to Collection, Rename, Make a copy, Delete.
- **Sort Drafts:** click sort popup → Newest first, Oldest first, A - Z, or Z - A.

## Draft-level controls

- **Change the draft's brand/canvas/performance:** Draft Editor → **Project actions** → Brand, canvas size, or Performance Mode. These are document-scoped.
- **Screen recording settings for one draft:** Project actions → **Screen Clip Settings...**. Configure cursor, display/shadow, sound, entrance/exit, motion blur, zoom type/level, and Fixed Zoom Easing → **Done**. These mirror Brand Kit defaults but override only this document.
- **Version history:** Project actions → **Show Version History...**, or use the unlabeled top-right control whose hover label is **Versions**. Close with **Close**. Do not select/revert versions of user projects casually.
- **Composition/background paint:** top **Open paint picker** → choose Solid/Linear/Radial/Multi/Image/Shader and edit values.
- **Captions styling:** click the top captions icon. A toolbar appears with Presets, font, weight, size, paint, Effects, Hidden, and More.
- **Music:** top **Add Music** → choose a workspace track or No background track. A selection applies immediately and closes the picker; upload button opens a file chooser.
- **Voice:** **Select voice** → English, World, or Creative → choose voice; set Default Speed (Slowest/Slow/Default/Fast/Faster).
- **Add from Library:** bottom **Library** → choose Everything/Images/Screen Clips/Webcams/Videos/Projects, optionally search, then select an asset. Card ellipsis contains Delete only; never delete existing media.
- **Insert overlay:** bottom overlay control → choose a published brand template or **New Blank Overlay**. New Blank Overlay inserts a four-second Overlay scene and enters overlay editing.
- **Overlay layer:** Overlay Editor → **Insert** → Text/Image/Video/Icon/Rectangle/Ellipse/Polygon/Line/Arrow/Pen/Group. Text inserts immediately. Use the compact top toolbar or open the top-right detail panel; **See All** reveals advanced sizing, skew, positioning, clipping, motion blur, visibility, and mask.
- **Agent reference:** Agent composer → **Composer actions** → **Add Reference...** opens the macOS file chooser.

## Brand-level defaults

- **Brand notes:** Brand Overview → Overview notes.
- **Manage brand:** header ellipsis → Rename Brand, Make Default, Duplicate Brand, New Brand, Archive Brand.
- **Brand colors:** Colors → click a swatch → edit paint → **Save Changes**. Swatch actions: Make Default, Duplicate, Remove.
- **Brand typography:** Type → set Primary/Secondary fonts, create/edit Text Styles, and enter Font Usage Notes.
- **Brand screen-clip defaults:** Screen Clips → cursor, display/shadow, sound, visual effects, zoom defaults. These are brand-scoped defaults; use Draft Project actions → Screen Clip Settings for a per-document override.
- **Create/edit workflow:** Workflows → **New Workflow** or open one → Name, Description, Prompt/instructions → **Done**.
- **Template editor:** Templates → open/create template. Header provides template name, New template, options, Agent/Layers, Export, Publish Template. Bottom insertion toolbar has Group/Text/Media/Shape/Comment. Right panel edits template duration, opacity, layout, background, motion blur, description, webcam preview, and project-background preview.
- **Template options:** Duplicate Template; Performance Mode Efficiency/Default/Ultra; Canvas Size 16:9/16:10/9:16/1:1; Loop; Delete Template.
- **Template text:** click **Text** to insert/select. Layers tab lists layers. Right properties include alignment, X/Y/rotation, layout/sizing, typography, opacity/fill, Highlight/Stroke/Shadow/Blur.

## App settings

- Left rail **Settings**. Preferences include Auto-Add Screen Zooms, Theme (Dark/Light/System), Agent model (Opus 5/Fable 5/Opus 4.8/GPT-5.6 Sol), Agent effort (Low/Medium/High/Extra High/Max), and Agent Fast Mode default.
- The same modal also contains workspace name/icon, custom recording window sizes, integrations, and Team Members. Close with the unlabeled top-right X.

# Dead ends & quirks

- **Scope matters:** Brand Kit Type, Colors, and Screen Clips are brand defaults. Draft Project actions/paint/captions/overlay properties are document overrides. Template layer properties apply only to the template layer.
- Clicking the bottom **record screen clip** control launches a separate helper/recording flow that can take over accessibility and make Yarn unaddressable; avoid during routine navigation.
- Media upload and Add Reference open native macOS file choosers.
- Publish, Invite Members, integration sign-ins/connect, Upgrade, Sign out, and similar actions are externally/account-impacting.
- Delete/Archive/Remove actions are destructive. Do not use them on existing user content.
- Collection ellipsis contains only **Delete Collection**.
- Version rows may not expose AX buttons; avoid experimenting on user drafts.
- Existing project/media thumbnails are content, not navigation controls to exhaust.

## Scratch cleanup candidates

- Workspace: `Scratch-Workspace-Map-Ch11B-7f3a`
- Collection: `scratch-collection-empty-7f3a`
- Untitled scratch drafts created in that workspace/collection
- Earlier scratch content includes `Copy of scratch-draft-map-7f3a`, its New Blank Overlay, scratch brand/template/workflow objects recorded during exploration.
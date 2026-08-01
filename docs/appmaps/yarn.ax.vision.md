<!-- provenance: explore-vision | app: Yarn | date: 2026-08-01 | backend: ax | actions: 162 | elapsed: 29m | calls: 221 | tokens-in: 597258 | tokens-out: 43631 | cache-read: 2171392 | cache-write: 0 | findings: 14 | finds: 0 | controls (DECLARED): 112 actuated / 56 dismissed / 168 seen | surfaces: 8 | chapters: 15 | stopped: frontier-empty | descent: off | gated: 0 read / 0 refused -->
<!-- controls tallies are DECLARED — self-reported by the model from screenshots, not measured against an element list. A control the pass never declared is invisible to these numbers. -->
<!-- Written by src/core/explore.ts. DO NOT HAND-EDIT: edits make this a curated recipe, not exploration output — move such notes to docs/recipes/<app>.md instead. -->

# Layout

## Library / Drafts overview
- The ordinary landing view is **Your Library**, reached with **Library** in the persistent left sidebar.
- **Your Drafts** opens the drafts overview. Both views show draft/template cards, Search, Grid/List controls, sorting, and **New Draft**.
- **Grid** is usable; **List** appeared disabled and did not change the view.
- Sidebar also contains the workspace menu at top, recent items, New draft, Invite Members, Brand Kit, and Settings.
- Right-click a draft card for its context menu: **Move to David's**, **Rename**, **Make a copy**, **Delete**.

## Settings
- Click **Settings** in the lower-left sidebar.
- Preferences found: **Auto-Add Screen Zooms** (On/Off; On selected), **Theme** (Dark/Light/System; System selected; shortcut Shift+Command+\\), **Agent model** (Opus 5), **Agent effort** (High), and **Agent Fast Mode** (checked).
- Plan usage and Workspace settings appear below.
- These are app/workspace defaults for new recordings/chats, not confirmed per-document overrides.

## Draft editor
- Double-click a draft card to open the three-pane editor: Script/Agent pane left, canvas center, timeline below.
- Top-right: Color, Captions, Music, Language, Export; some drafts also show Add BG/canvas-view controls.
- Timeline toolbar: Play, Add text, Add media, Record, Frame, Comment, Delete, Fit.
- Agent composer is at lower left with effort label **High** and send arrow.
- In Script, click the ellipsis beside the current voice to open the voice picker. Tabs: **English**, **World**, **Creative**. English voices: Annie, Brynn, Cassidy, Fay, Jacob, Jada, James, Jeff, Kendra, Miranda, Robert, Sarah. Current tested voice: Sarah. **Default Speed** appears at bottom.

## Template editor
- Open a template card from Library. It is a distinct editor with Agent/Layers tabs and top actions **Export** and **Publish Template**.
- Right inspector contains template-scoped Duration, Opacity, three Layout choices, Background Add, Motion Blur Add, Description, Webcam Preview, and Project BG Preview.
- The ellipsis beside the title activates inline title editing rather than a command menu; Escape exits unchanged.

## Workspace menu
- Click the workspace name at top left. Menu contains the current workspace, **New workspace**, and **Sign out**.

# How to

- **Open and edit a draft:** Library or Your Drafts → double-click a draft card.
- **Open draft card commands:** right-click the card (more reliable than the tiny ellipsis) → choose Move, Rename, Make a copy, or Delete.
- **Change narration voice for one draft:** open draft → Script → click voice ellipsis → choose category → choose voice. This is document-scoped; selection changes the draft.
- **Change global defaults:** Settings → choose Auto-Add Screen Zooms, Theme, Agent model, Agent effort, or Agent Fast Mode.
- **Open a template:** Library → click/double-click a template card → use right inspector for template-scoped visual settings.
- **Rename a template:** in template editor click the title ellipsis/title area, edit inline, and commit; press Escape to cancel.
- **Return home:** click **Library** in the left sidebar.

# Dead ends & quirks

- Brand Kit was visible but produced no panel from Drafts or either editor in this workspace/state.
- Invite Members produced no visible dialog; no invite was sent.
- New Collection produced no visible modal or field.
- List view is gray/disabled; Grid is the practical overview.
- In draft/template editors, clicking effort **High** did not open an override menu. No confirmed per-document effort override exists; use Settings for the default.
- Draft top-toolbar Color/Captions/Music/Language and Add BG/canvas-view controls produced no visible popover in tested draft state, likely disabled/direct-mode controls.
- Clicking the timeline Comment icon in a draft with an unread comment produced no visible comment panel.
- Selecting scene rows/timeline scenes did not reveal an additional inspector.
- Template Layers, Play, Fit canvas, Settings, Brand Kit, and Invite Members produced no additional visible configuration surface in the tested empty template.
- Destructive Delete controls, New Draft/New draft, agent submission, script entry, publishing, copying, workspace creation, sign-out, and voice selection were deliberately not executed.
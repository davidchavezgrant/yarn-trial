<!-- provenance: explore-vision | app: Yarn | date: 2026-08-01 | backend: ax | actions: 242 | elapsed: 43m | calls: 301 | tokens-in: 888195 | tokens-out: 57458 | cache-read: 2854400 | cache-write: 0 | findings: 18 | finds: 0 | controls (DECLARED): 77 actuated / 106 dismissed / 183 seen | surfaces: 6 | chapters: 23 | stopped: frontier-empty | descent: off | gated: 0 read / 0 refused -->
<!-- controls tallies are DECLARED — self-reported by the model from screenshots, not measured against an element list. A control the pass never declared is invisible to these numbers. -->
<!-- Written by src/core/explore.ts. DO NOT HAND-EDIT: edits make this a curated recipe, not exploration output — move such notes to docs/recipes/<app>.md instead. -->

# Layout

## Your Library (ordinary landing view)
- Stable home surface, reached from an editor via left-sidebar **Your Drafts**.
- Main area: existing draft grid, **Collections**, **Search**, **Grid**, **List**, sort arrow, and **+ New Draft**.
- Left sidebar also shows workspace navigation, **Invite Members**, **Brand Kit**, and **Settings**.
- Double-click an existing draft card to enter its editor.

## Draft Editor
- Left sidebar: **Library**, **Your Drafts**, draft shortcuts, and **New draft**.
- Upper-left: **Agent** and **Script** tabs with scene script text.
- Center/right: preview, playback, timeline, and element toolbar.
- Upper-right: **Style**, **Comments**, **Music**, **Language**, **Export**, **Add BG**, and preview options.
- Small ellipsis beside the current voice opens the document voice picker.

## Voice Picker
- Per-document picker with **English**, **World**, and **Creative** tabs.
- Observed English voices: Annie, Cassidy, Jacob, James, Kendra, Robert, Brynn, Fay, Jada, Jeff, Miranda, Sarah.
- Also contains **Default Speed**.

## Context menus
- Right-click an **Untitled** draft shortcut in the editor sidebar: **Rename** only.
- Right-click a Library draft card: **Move to David's**, **Rename**, **Make a copy**, **Delete**.

# How to

## Return home
1. In Draft Editor, click **Your Drafts** in the left sidebar.
2. **Your Library** appears.

## Open an existing draft
1. From **Your Library**, double-click its draft card.

## Choose a document voice / inspect speed
1. Open a draft.
2. Click the small ellipsis beside the current voice.
3. Select **English**, **World**, or **Creative**.
4. Select a voice or use **Default Speed**.

## Open draft management
1. In **Your Library**, right-click a draft card.
2. Choose **Move to David's**, **Rename**, **Make a copy**, or **Delete**. These alter state; Delete is destructive.
3. Escape closes the menu safely.

## Open sidebar shortcut rename
1. In Draft Editor, right-click an **Untitled** sidebar shortcut.
2. The menu contains **Rename** only.
3. Escape closes it safely.

# Dead ends & quirks
- A final sweep covered all visible navigation affordances: workspace selector, Library/Your Drafts, Agent/Script, voice ellipsis, upper toolbar buttons, preview options, timeline toolbar, and visible context menus. No further surfaces were exposed.
- **Invite Members**, **Brand Kit**, **Settings**, and Cmd+, produced no visible response.
- **Style**, **Comments**, **Music**, **Language**, **Export**, **Add BG**, preview options, **Agent**, workspace selector, centered add-element +, and timeline insertion controls produced no visible panel/change in this workspace.
- Preview Play, preview-comment, and fit-timeline likewise showed no visible effect.
- Sidebar **Library** was inert inside the editor; use **Your Drafts**.
- Library **List** did not switch from Grid; sort arrow showed no menu/reordering.
- Clicking a card's visible ellipsis area opened the draft. Right-click the card for management actions.
- State-changing or external actions—scene/timeline editing, New draft, Rename, copy, move, delete, Agent send, and collaboration—were deliberately not exercised.
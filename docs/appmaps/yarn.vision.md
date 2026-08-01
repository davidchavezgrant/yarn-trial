<!-- provenance: explore-vision | app: Yarn | date: 2026-08-01 | backend: ax | actions: 71 | elapsed: 13m | calls: 92 | tokens-in: 280082 | tokens-out: 18625 | cache-read: 883712 | cache-write: 0 | findings: 9 | finds: 0 | controls (DECLARED): 48 actuated / 86 dismissed / 134 seen | surfaces: 3 | chapters: 7 | stopped: frontier-empty | descent: off | gated: 0 read / 0 refused -->
<!-- controls tallies are DECLARED — self-reported by the model from screenshots, not measured against an element list. A control the pass never declared is invisible to these numbers. -->
<!-- Written by src/core/explore.ts. DO NOT HAND-EDIT: edits make this a curated recipe, not exploration output — move such notes to docs/recipes/<app>.md instead. -->

# Layout

## Your Library
- Ordinary landing view; return via **Library** in the left sidebar (or **Your Drafts** from an open editor, which reliably returns to this overview).
- Main area shows **Your Library**, Collections, a grid of draft cards, Search, Grid/List, sort, **+ New Collection**, and **+ New Draft**.
- Left sidebar contains workspace switcher, **Library**, **Your Drafts**, recent draft rows, **New draft**, Invite Members, Brand Kit, and Settings.
- Grid is visibly active. List, sort, and Search did not respond usefully in this build.

## Draft Editor
- Open an existing draft by clicking its card. Clicking the card’s visible ellipsis area also opened the draft directly; it did not expose a context menu.
- Layout: script/agent panel at left, large canvas at right, timeline at bottom, and style/comments/music/language/export tools across the upper right.
- **Your Drafts** in the sidebar reliably returns to **Your Library**. Sidebar **Library** was inert while in the editor.

## Voice picker
- In editor **Script** mode, click the ellipsis beside the current voice/audio indicator near the top of the script pane.
- Tabs: **English**, **World**, **Creative**.
- English voices observed: Annie, Cassidy, Jacob, James, Kendra, Robert, Brynn, Fay, Jada, Jeff, Miranda, Sarah.
- Also contains **Default Speed**. Current draft voice was Sarah. Voice and speed are per-document settings.

# How to

## Open an existing draft
1. From **Your Library**, click a draft card.
2. The single-window Draft Editor opens.

## Return to the library
1. In Draft Editor, click sidebar **Your Drafts**.
2. The **Your Library** grid appears.

## Inspect or change a draft voice
1. Open the draft.
2. Ensure **Script** is selected.
3. Click the ellipsis beside the waveform/current voice indicator.
4. Choose English, World, or Creative and then a voice; adjust **Default Speed** if needed.
5. This changes the open draft, not a workspace default.

# Dead ends & quirks
- **Settings** on Your Library and in the editor produced no visible panel; Cmd+, also produced no visible change.
- **Brand Kit** produced no visible response, so no brand-wide defaults could be reached or paired with draft overrides.
- Editor Style color swatch, Comments, Music, Language, Export, Add BG, Agent tab, Canvas view, subtitle/media timeline controls, workspace switcher, Invite Members, Add scene, Preview, timeline text/camera tools, and tested right-clicks produced no visible response in this build.
- The waveform icon only made the current voice label visible; use its adjacent ellipsis to open the Voice picker.
- Library **List** and sort controls produced no visible change. Search could not be focused/typed into successfully.
- Do not rely on draft-card ellipses for overflow actions: the tested ellipsis opened the draft.
- Creation controls (**+ New Draft**, **New draft**, **+ New Collection**) were intentionally not operated because they create persistent content. Delete controls and AI Agent send were likewise skipped.
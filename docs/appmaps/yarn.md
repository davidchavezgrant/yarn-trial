<!-- provenance: explore | app: Yarn | date: 2026-07-29 | backend: ax | actions: 11 | findings: 7 | finds: 0 -->
<!-- Written by src/explore.ts. DO NOT HAND-EDIT: edits make this a curated recipe, not exploration output — move such notes to docs/recipes/<app>.md instead. -->

## Layout

Yarn is a single-window Electron/web app. There is **no macOS Preferences window** (cmd+, does nothing); all settings live inside the web UI.

- **Left sidebar** (always visible): workspace popup "David's Workspace", `Library`, `Your Drafts`, the project/draft list (several `Untitled`, "YT Long - How to buy wholesale for your store", "YT Short - Store Owner Responsibilities", …), `New draft`, and at the bottom `Invite Members`, `Brand Kit`, `Settings`.
- **Brand Kit** (sidebar → "Brand Kit"): nav column with `Brand Overview`, `Templates`, `Workflows`, `Colors`, `Type`, `Screen Clips`, `Motion`, `Layout`, `Misc`; a "Brand options" ⋯ popup at the top-right of the pane. Brand selector shows "Default Brand".
- **Brand Kit → Screen Clips** — page titled **"Screen Clip Settings"**, the BRAND-WIDE defaults:
  - Cursor: Auto-Hide Cursor [Auto Hide | Off]; Text Cursor [Hide | Show]; Cursor Style combobox (Arrow-first / Pointer-first / Original); Cursor Scale slider (1.60).
  - Screen Display: Screen Window Padding (18.0), Shadow Opacity (72%), Shadow Blur (32), Shadow Spread (-18) sliders; Shadow X Offset (0) and Shadow Y Offset (12) text fields.
  - Sound Effects: Cursor Clicks checkbox + volume combo ("Extra Soft"); Keyboard Presses checkbox + key-set combo ("Set B") + volume combo ("Extra Soft").
  - Visual Effects: Entrance/Exit Animation popup ("Fade Up"); Motion Blur [Off|Low|Medium|High]; Default Zoom Type [Glide|Fixed]; Default Zoom Level slider (54%).
- **Project editor** (click any draft in the sidebar): title text field, `Agent`/`Script` tabs, voice popup ("Select voice: Annie"), **Project actions ⋯ popup**, script/scene pane, video preview, timeline (Add scene, Library, Timeline Zoom), top-right paint picker, music popup ("Vintage Groove"), `Publish`, `Export`.
- **Project actions ⋯ menu** (right of the voice popup): New Agent Chat, Copy Transcript, Make a copy, Download SRT…, **Screen Clip Settings…**, Show Version History…, `Brand ▸ Default Brand`, aspect ratio (Widescreen 16:9 / Laptop 16:10 / Square 1:1 / Vertical 9:16), Performance Mode (Efficiency / Default / Ultra), Delete.
- **Per-project Screen Clip Settings** — popover titled **"Screen Recording Settings"**, identical control list to Brand Kit → Screen Clips but stored on THIS project. Closed with its **Done** button (bottom-right).
- **Settings modal** (sidebar → "Settings"; close with the X at its top-right): profile (photo, David / me@davidgrant.info, Sign out); Preferences = Auto-Add Screen Zooms [On|Off], Theme [Dark|Light|System] (also shift+cmd+\), Agent model popup (Opus 5), Agent effort popup (High), "Agent Fast Mode default" checkbox; Your Plan (Free, 0/2,000 credits, Upgrade); Workspace settings = workspace name field, icon upload, Custom window sizes (Default 1440x897, Custom 1 1600x987, Add Size / Remove); Integrations (Figma, Google Slides, Notion MCP, Team YouTube, Personal YouTube, Screen Studio Import); Team Members + Invite Members.
- **macOS menu bar** is minimal: Yarn (About, Services, Quit), File (Close Window, Close All), Edit (standard text items, mostly disabled), View (Reload, Force Reload, Toggle Developer Tools, Actual Size/Zoom), Window, Help (empty).

## How to

- **Change a cursor/shadow/zoom/sound setting as the brand-wide default**: sidebar → `Brand Kit` → `Screen Clips` → operate the control. Segmented buttons (Auto Hide/Off, Hide/Show, Off/Low/Medium/High, Glide/Fixed) apply on click; sliders are AXSlider; Shadow X/Y are text fields (click, cmd+a, type).
- **Change the same setting for one project only**: open the project from the sidebar → click `Project actions` (⋯ next to the voice popup) → `Screen Clip Settings…` → change the control → click `Done`. This does **not** touch the brand default, and the brand page does not override a project that already has its own value.
- **Set Cursor Style**: click the Cursor Style combobox, then click the desired row — "Arrow-first", "Pointer-first" or "Original".
- **Change project aspect ratio / performance mode / assigned brand**: Project actions ⋯ → the matching item (Widescreen 16:9 / Laptop 16:10 / Square 1:1 / Vertical 9:16; Efficiency / Default / Ultra; Brand ▸).
- **Theme, Auto-Add Screen Zooms, agent model/effort defaults, workspace name, custom recording window sizes, integrations, invites**: sidebar → `Settings`, then close via the X at the modal's top-right.
- **Per-chat agent effort** (vs the app default): the composer's "Effort: High" popup at the bottom of the script/agent pane.

## Dead ends & quirks

- Cursor/shadow/zoom/sound-effect settings are **NOT** in the sidebar `Settings` modal — only `Auto-Add Screen Zooms` (app-level recording preference) is there. They live in Brand Kit → Screen Clips (brand) or Project actions ⋯ → Screen Clip Settings… (project).
- **Escape does not close** the Settings modal or the "Screen Recording Settings" popover; use the X and `Done` respectively. Escape *does* close combobox dropdowns.
- Clicks on menu items / web buttons sometimes no-op on the first attempt; if the observation is unchanged, re-read indices and click again.
- While a web dropdown is open, the accessibility tree collapses to only macOS menu-bar items — the option rows are visible only in the screenshot.
- Element indices change on every observation; never reuse an index from an earlier snapshot (a stale index once landed on an AXMenuItem "" and silently did nothing).
- The main window reports an empty title; Help menu is empty; there is no in-app Preferences menu item.

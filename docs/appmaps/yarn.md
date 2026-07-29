<!-- provenance: explore | app: Yarn | date: 2026-07-29 | actions: 23 | findings: 0 -->
<!-- Written by src/explore.ts. DO NOT HAND-EDIT: edits make this a curated recipe, not exploration output — move such notes to docs/recipes/<app>.md instead. -->

## Layout

Yarn is an Electron/web app: one window "Yarn" containing a single AXWebArea. Everything is in-page; the macOS menu bar is nearly empty of app features.

**macOS menu bar** (only useful items)
- Yarn: About Yarn, Hide, Quit. **No Preferences/Settings item** — settings are in-app.
- File: Close Window (often disabled), Close All.
- Edit: standard, mostly DISABLED unless a text field is focused.
- View: Reload, Force Reload, Toggle Developer Tools, Actual Size / Zoom In / Zoom Out.
- Window / Help: standard / empty.

**Left sidebar (always present)**
- Top: AXPopUpButton "David's Workspace" (workspace switcher).
- `Library`, `Your Drafts`.
- List of draft shortcuts (each row is AXButton "Untitled" containing an inline-editable AXTextField), then `New draft`.
- Bottom: `Invite Members`, `Brand Kit`, `Settings`.

**Library** (sidebar → Library): title "Your Library"; Search AXTextField; `Grid` / `List` buttons; one unlabeled sort AXPopUpButton; blue `New Draft`; "Collections" section with `New Collection`; then an AXTable "grid" of draft cards. Each card = inline title AXTextField + "Draft" badge + "You – <time>" + an unlabeled "..." AXPopUpButton (per-item menu).

**Your Drafts**: page titled "Drafts", same controls as Library (Search, Grid/List, sort popup, New Draft, card grid) but no Collections section.

**Brand Kit** (sidebar → Brand Kit): breadcrumb "Default Brand Brand Kit" and a second-column nav: Brand Overview, Templates, Workflows, Colors, Type, Screen Clips, Motion, Layout, Misc. Reopening Brand Kit returns to the last-visited sub-section.
- *Brand Overview*: "Brand options" AXPopUpButton ("..." top-right) + "Overview notes" AXTextArea.
- *Templates*: Grid/List buttons, sort toggles exposed as AXCheckBox "Sort by newest" / "Sort A-Z", blue `New Template`; empty state "No templates yet for this brand."; right pane "Select a template to view its details."
- *Colors*: groups "Background" and "Text Colors"; each swatch = AXPopUpButton "Open paint picker" + adjacent AXButton "Color actions"; trailing "Add Background" / "Add Text Color" tiles; bottom "Color Notes" AXTextArea + "More information" (i) button.
- *Motion*: "Motion Principles" + "Motion notes" AXTextArea. *Misc*: "Misc Context" + "Misc notes" AXTextArea. (Type / Layout / Workflows not opened; Type & Layout follow the same notes/settings pattern.)
- *Screen Clips* (the big settings page, "Screen Clip Settings"): sections **Cursor** (Auto-Hide Cursor: `Auto Hide`/`Off`; Text Cursor: `Hide`/`Show`; Cursor Style AXComboBox = Arrow-first | Pointer-first | Original; Cursor Scale slider), **Screen Display** (Screen Window Padding, Shadow Opacity, Shadow Blur, Shadow Spread sliders; Shadow X/Y Offset text fields), **Sound Effects** (Cursor Clicks checkbox + preset combobox; Keyboard Presses checkbox + set combobox "Set B" + volume combobox), **Visual Effects** (Entrance/Exit Animation popup "Fade Up"; Motion Blur `Off|Low|Medium|High`; Default Zoom Type `Glide|Fixed`; Default Zoom Level slider).

**Settings** (sidebar bottom → Settings): a **modal dialog** with an X close button (top-right, an unlabeled AXButton ~42x42) — Escape does NOT reliably close it; click the X.
- Left pane: profile avatar ("Edit profile photo"), name/email, `Sign out` at bottom.
- Right pane (scrollable, sections in order):
  - **Preferences**: Auto-Add Screen Zooms `On`/`Off`; Theme `Dark`/`Light`/`System` (quick switch Shift+Cmd+\); Agent model popup (Opus 5 ✓, Fable 5, Opus 4.8, GPT-5.6 Sol); Agent effort popup (High); "Agent Fast Mode default" checkbox.
  - **Your Plan**: Free, "Resets on …", credits used, `Upgrade`.
  - **Workspace settings**: Workspace name text field; Icon upload button; Custom window sizes rows (name + "1440x897"-style fields with `Remove`) + `Add Size`.
  - **Integrations**: Figma / Google Slides ("Sign in with…"), Notion MCP (`Connect Notion`), Team YouTube, Personal YouTube, Screen Studio Import (`Import`).
  - **Team Members**: `Invite Members` + member rows with a role AXPopUpButton.
  - Lower sections are reported by AX at a collapsed y (~1657, 1x1 frames) until the dialog is scrolled — scroll the dialog to interact with them reliably.

## How to
- **Open app settings**: click sidebar `Settings` (bottom-left). Close with the unlabeled X button at the dialog's top-right (~42x42 element listed just after the sidebar items).
- **Change theme / default agent model**: Settings → Preferences → Theme buttons / `Agent model` popup → pick item. To close a popup without choosing, click the same popup button again (Escape doesn't work).
- **Reach screen-recording visual defaults** (cursor, shadows, sounds, zoom): sidebar `Brand Kit` → `Screen Clips`.
- **Per-draft actions in Library/Drafts**: `right_click` the card's unlabeled "..." AXPopUpButton (plain click is a no-op) → menu: "Move to David's Workspace", "Rename", "Make a copy", "Delete".
- **Rename a draft**: either right-click "..." → Rename (title field becomes editable with text selected; type, Enter commits, Escape cancels) or click the inline title AXTextField on the card / sidebar row, cmd+a, type.
- **Create things**: `New Draft` (Library/Drafts header) or sidebar `New draft`; `New Collection` (Library); `New Template` (Brand Kit → Templates).
- **Search drafts**: click the Search AXTextField in Library/Drafts header, then type.

## Dead ends & quirks
- No app Preferences menu item and cmd+, does nothing useful — Settings only via the sidebar.
- **Web popup menus ignore Escape.** The Agent-model style popups close by clicking the popup button again. The Library card "..." popover is worse: Escape, clicking the AXWindow (AXPress fails with -25206), and scrolling all fail; the only way out is to select a menu item (use the harmless "Rename", then Escape to cancel the inline edit).
- Background scrolling is unavailable for this Electron window ("background_unavailable"); scroll requests on the web area fail.
- Duplicate element sets: header controls and card rows appear twice in the AX tree (two "Your Library"/"Search"/"New Draft" entries, cards repeated). Either copy usually works; prefer the first occurrence.
- The card "..." AXPopUpButton advertises only AXShowMenu → must use right_click.
- Settings dialog's lower half (Workspace settings, Integrations, Team Members) reports 1x1 frames at the same y until scrolled — don't trust those coordinates.
- Brand Kit remembers the last sub-section; after navigating away and back you may not land on the page you expect.
- Traffic-light buttons appear as three unlabeled 16x16 AXButtons at the window's top-left — don't click them.

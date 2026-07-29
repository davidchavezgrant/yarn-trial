<!-- provenance: explore | app: Notion Calendar | date: 2026-07-29 | actions: 20 | findings: 12 -->
<!-- Written by src/explore.ts. DO NOT HAND-EDIT: edits make this a curated recipe, not exploration output — move such notes to docs/recipes/<app>.md instead. -->

## Layout

Notion Calendar is an Electron web app: everything (incl. Settings) lives inside ONE window; the window **title changes** to reflect the active surface (`Jul 26 – Aug 1, 2026 · Notion Calendar`, `Settings · Notion Calendar`, `Menu bar settings · …`, `<Event title> · …`). Use the title to verify navigation.

**Top bar (right→left):** avatar/profile button (~1182,49) · view picker button labelled with current view ("Week", ~1218,46) · "Today" · prev/next arrows (1373 / 1404) · "Search" button (1452,46) · right-panel toggle (1688,46).
**Top bar (left):** window traffic lights · "Hide sidebar" (80,45) · search icon (172,45) · new-event/compose icon (202,45).

**Left sidebar (~0–240 px):** mini month calendar (`July 2026`, chevrons at 178/204,93; each day is an AXButton) → **Scheduling** row (+ button at 208,329; eye at ~197,273) → "Meet with…" text field → calendar accounts group: `me@davidgrant.info` (account header), calendar rows `me@davidgrant.info Default` and `Holidays in United States` → "Add calendar account" → "Add Notion database" → "Notion" section → help "?" bottom-left.

**Right context panel** (toggle 1688,46): by default shows "Welcome to Notion Calendar" onboarding checklist (Use ⌘K command palette / Connect another calendar / Connect Notion workspace / Create scheduling link) + "Useful shortcuts" list. Selecting an event replaces it with the **Event detail** editor. Close the onboarding card with the X at (1688,115).

**Settings modal** (⌘, foreground, or menu Notion Calendar ▸ Settings…): left nav *Account* = General, Profile, Notifications, Menu bar, Conferencing; *Calendar accounts* = me@davidgrant.info, Add calendar account; *Notion workspaces* = Add Notion workspace. Close: X at (1304,225) or escape (foreground).
- **General:** Weekends / Declined events / Week numbers toggles; "Start week on:" (Sunday); "Press T to:" (Go to today); "Show upcoming meeting in context panel:" (4 hours before meeting); then Language (English), Time format (12-hour), Time zones + "Ask to change time zone to new locations", Location ("Open location links in:" Google Maps), Theme (Auto/Light/Dark radios), System startup ("Open calendar").
- **Notifications:** macOS notifications (→ System Preferences link), Default event reminders (only a link to Google Calendar Settings), Upcoming meeting notification timing (1 min before meeting) + sound (Blip).
- **Menu bar:** "Menu bar calendar" toggle, Include events (3 days), All-day events / Events without participants / Events without conferencing-location toggles, "Preview upcoming event in menu bar" (12 hours before event), Event title / Event time, and global shortcut recorder fields (control⌘K show menu-bar calendar, control⌘J join meeting).
- **Conferencing:** Google Meet "Connected by default"; Zoom [Connect]; Custom video link [Add]; default conferencing is set per calendar account.
- **Calendar account page (me@davidgrant.info / Google Calendar):** Default Notion workspace [Connect workspace], Default conferencing dropdown, "Use join and transcribe AI meeting notes shortcut" (No meetings), Calendars list, Remove account ▸ Disconnect (disabled).

**⌘K command palette** (field "Type a command…"): Calendar — Create event… (C), Meet with… (F), Show teammate calendar… (P), Create recurring scheduling link…, Create one-off scheduling link… (S), Add Notion database… (O). Navigation — Go to date… (.), Go to today (T), Left-align today (⌥T), next/prev week (J/K), Search events (/ or ⌘F). Time zones — Travel to time zone… (Z), Show additional time zones…. App — Show menu bar calendar (⌃⌘K), Hide sidebar (`), Set theme…. Calendars — Hide "<calendar>" calendar. View — Start week on…, Display day view (1/D), Display month view (M), Set number of displayed days…, Select all visible (⌘A), Default hour size (⇧⌘0), Zoom hours in/out (⇧⌘. / ⇧⌘,), Hide weekends (⇧⌘E), Hide declined events (⇧⌘D), Show week numbers. Settings & help — Invite…, Get mobile app, Show keyboard shortcuts (?), Go to settings (⌘,), Support & feedback (G then F). Accounts — Add Google Calendar account, Manage calendar accounts, Log out. Notion Calendar — Check for update, About.

**Mac menu bar:** Notion Calendar (About / Check for Updates… / Settings… / Quit), Edit (Undo, Cut/Copy/Paste, Delete, Select All Visible, Duplicate — Delete/Duplicate enabled only when an event is selected), View (Default Hour Size, Zoom Hours In/Out, Interface Scale, Reload, Toggle Developer Tools, Toggle Full Screen), Window, Help (Learn more, Notion Calendar, Settings…).

## How to

- **Open Settings:** `press_key ,` with modifiers `[cmd]`, delivery_mode **foreground**. Switch panes by clicking the nav labels (they are AXStaticText and warn "does not advertise AXPress" — the click works; verify via window title). Close with escape (foreground).
- **Open command palette:** `press_key k` + `[cmd]`, foreground. Type to filter, Enter to run, escape to close.
- **Change view:** click the view button labelled "Week" (top bar) → choose Day / Week / Month; or press D / W / M / 1. "Number of days ›" and "View settings ›" are submenus that need hover (AXPress on them just closes the menu — use ⌘K commands like "Set number of displayed days…" instead).
- **Open an event:** click the event's title text on the grid → right panel becomes the Event editor (title changes to the event name). Fields are AXTextFields: title, start time, end time, date, time zone, "Add participant or room", "Reminders". Edit pattern: click field → `cmd+a` → type. Buttons: Propose new time, RSVP Yes/No/Maybe, Add meeting note (+ chevron), conferencing row, calendar row, "Busy", "Default visibility". Deselect with escape.
- **Event actions:** right_click the event → menu with color swatches, RSVP Yes/No/Maybe (E then Y/N/M), Email participants (E then E), Join Google Meet meeting (⌘J), Block on calendar, Cut/Copy/Duplicate (⌘X/⌘C/⌘D), **Remove (delete — destructive)**. Escape (foreground) closes it.
- **Create event:** press `c` (or ⌘K → "Create event…"), or click the compose icon at (202,45).
- **Go to a date:** press `.` (Go to date…) or click a day in the sidebar mini-month; "Today" button / `t` returns to today.
- **Scheduling links:** click sidebar "Scheduling" → flyout with [Create recurring link] / [Create one-off link] (S). Escape closes the flyout.
- **Search events:** click "Search" (1452,46) or `/` / ⌘F.
- **Toggle a calendar's visibility:** hover the calendar row in the sidebar → click the small button at the row's right edge (~x=208). Click again to restore.

## Dead ends & quirks

- **Do not batch `record` with `act` in the same tool block** — the act is silently dropped (output `...`, nothing happens). Issue one `act` per block.
- Most web-content elements report "does not advertise AXPress (actions: AXShowMenu…)"; plain `click` still works. Only true context menus need `right_click` (events do; sidebar calendar rows do NOT — right-click just reveals their hover buttons).
- Elements below the visible fold report **1px-high frames** (Settings General below "Meetings", palette rows past ~10). They're still clickable by index, but scroll or filter for reliability.
- Sidebar calendar row's right-hand button **immediately hides that calendar** (no menu/confirmation) and all its events vanish; click it again to unhide. There is no color/settings context menu on calendar rows.
- Per-calendar default reminders are NOT in-app (Notifications pane only links to Google Calendar Settings). Default conferencing/default calendar live on the **calendar account** page, not in General.
- "Disconnect" for the calendar account is disabled. Avoid Zoom [Connect], "Add calendar account", "Add Notion workspace", "Invite…", "Log out" — external/irreversible.
- Escape and ⌘-shortcuts must use `delivery_mode: "foreground"`.
- Selecting an event replaces the onboarding panel; pressing escape / deselecting brings the "Welcome to Notion Calendar" panel back.

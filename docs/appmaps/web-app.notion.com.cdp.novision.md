<!-- provenance: explore | app: app.notion.com | date: 2026-08-03 | backend: cdp | vision: off | actions: 327 | elapsed: 1h06m | calls: 680 | tokens-in: 1879401 | tokens-out: 70652 | cache-read: 20064768 | cache-write: 0 | findings: 111 | finds: 6 | controls: 220 actuated / 611 dismissed / 1713 seen | surfaces: 184 | chapters: 30 | stopped: frontier-empty | descent: off | gated: 0 read / 10 refused -->
<!-- controls actuated/seen is a LOWER BOUND ON BREADTH, not a coverage percentage: the denominator only grows as surfaces are opened, and operating a control is not understanding it. -->
<!-- Written by src/core/explore.ts. DO NOT HAND-EDIT: edits make this a curated recipe, not exploration output — move such notes to docs/curated/<app>.md instead. -->

# Layout

- **Home** — ordinary landing/overview; return via sidebar tab **Home**. It contains Meetings, Recents/Favorites/Agents/Teamspaces/Private sections, Notion apps, Library, My Tasks, Marketplace, Help, and Trash. Right-click/open the Home tab menu for **Customize sections**.
- **Primary sidebar** — **Home**, **Chat**, **Meetings**, **Inbox**, **Search**, persistent **New chat** and **New page**.
- **Settings & members** — workspace header → **Settings**. Account tabs: profile, Preferences, Notifications, Mail & Calendar. Workspace tabs: General, People, Import, Notion AI, Connections, Notion MCP, Public pages, Emoji, Teamspaces, Security, Identity, Upgrade plan.
- **Library** — Home → **Library**. Routes/tabs: Teamspaces, Recents, Favorites, Shared, Private; overflow contains AI Meeting Notes. These are workspace-level content tables with database-like filters/settings.
- **Marketplace** — Home → **Marketplace**. Header routes: Discover, Templates, Agents, Consultants, Connections; **Purchased** opens Buyer profile overlay, **My profile** opens creator menu.
- **Page editor** — sidebar **New page** → Page, or open a page. Top-level page controls include Private/Share/Copy link/Favorite/Actions and icon/cover/comment affordances.
- **Database editor** — sidebar **New page** → Database. Database views expose Settings, Filter, Sort, Automations, AI Autofill, Search, New, property creation, view switcher, and rows in Side Peek.
- **Form editor** — a database Form view has Form builder and Responses tabs, Preview, Share form, Automations, AI Autofill, question creation/editing, and response table.
- **AI chat** — sidebar **New chat** opens `/ai`; supports prompt, Give context, Settings, model selector, voice, and starter actions.
- **AI meeting note** — Home/Meetings → **New AI meeting note** creates a private meeting page with Notes, Options, transcription controls, language, consent playback/copy, and browser limitations.

# How to

## Search and Inbox
- Open **Search** from sidebar. Use **Title only** directly; **Created by** opens a people picker; **In** opens a page picker; **Date** opens presets/calendar; **Filter** can add Teamspace. Filters apply immediately.
- Search settings contains app-scoped switches **Persist filters across sessions** and **Hide ‘Search all sources with AI’**.
- Inbox → **Edit filter** → choose Unread & read, Unread, Archived, or All workspace updates; selection applies immediately.

## Account and workspace settings
- Workspace header → **Settings**.
- **Preferences** contains account/app-scoped language, Enter behavior, text direction, week/date/time-zone behavior, desktop links, startup page, history, and discoverability.
- **General** is workspace-scoped: workspace name/icon, default page, sidebar apps, allowed email domain, analytics, directory/profile/hover-card policies, export and deletion.
- **People** manages Guests/Members/Groups/Contacts; invitations/import/contact actions are externally visible.
- **Notion AI → General** manages workspace AI data sharing, personalization/default instructions page, skills, and optional model. **Meeting notes** separates workspace policies from personal **Auto play consent message on start**.
- **Connections** has Discover/Installed/Manage; Manage includes connection/token policies and **Enable custom MCP servers**. Custom MCP form asks for a server URL and **Connect**.
- **Security** tabs are General, Members & guests, Data retention; most controls are plan-gated.
- **Teamspaces** has creation policy, filters/list, **New teamspace**, and per-row **Teamspace settings and members...**. Teamspace settings has General/Members/Security and is teamspace-scoped.

## Pages and databases
- Page **Actions → Customize page** for document-scoped Page discussions, Table of contents, and page style Default/Minimal.
- Page **Actions** also includes font (Default/Serif/Mono), Small text, Full width, Lock page, Import/Export, wiki, analytics, history, notifications, and connections.
- Database **Settings → Layout** chooses Table/Board/Timeline/Calendar/List/Gallery/Chart/Feed/Map. View-layout controls are document/view-scoped.
- **Settings → Property visibility** controls visibility/order and creates propertiesorganize. **New property** opens type picker; choosing a type creates it immediately and opens property settings.
- Filter: Settings → Filter → property → operator → value. Applies immediately; no Apply button.
- Sort: Settings → Sort → property → direction. Rules apply immediately and can be removed.
- Group: Settings → Group → property; configure grouping/sort/empty groups. Applies immediately.
- Conditional color: Settings → Conditional color → New color setting → property/operator/value. Applies immediately.
- View switcher overflow → **New view** → choose view type. Creation is immediate.
- Row → Side Peek. Use **Open in full page** or **Switch peek mode**. Row Actions → **Customize layout** opens the database page-layout editor; **Apply to all pages** affects that database's pages.
- Automations are plan-gated here. Property **AI Autofill** opens Database agent setup with instructions and create/update triggers; Custom Agent is trial-gated.

## Forms
- Form builder → **Edit form, add questions and more…** for form name, icon, New question, automations and deletion.
- **Add page module** → choose a question type. It is added immediately and opens Edit question with Required, Description, Long answer, type, linked property, sync, move, duplicate, delete.
- **Preview** opens respondent view in Side Peek. **Submit** is externally committing; required fields show an asterisk.
- **Responses** switches to a normal submissions database table.

## AI
- New chat → **Give context** → upload files or **Mention pages or people**; selecting context does not send until submit.
- Chat **Settings → My sources** toggles workspace, Calendar, Help Center, web, etc. **Add sources** is trial-gated.
- Chat **Settings → MCP servers → Add MCP server** routes to Connections; choose Custom MCP Beta for the URL form.
- **Open personalization settings** edits AI name/appearance and links to the configured instructions page.
- Settings → Notion AI → **Add a skill** → choose/create a page. Skill pages are normal pages with a template and Configure banner; text-editor-menu exposure is workspace-scoped.

## Meetings
- Home/Meetings → **New AI meeting note** creates immediately; rename only the scratch/new note.
- **Options → Language** chooses the document-scoped transcription language and closes the menu.
- **Browser limitation** opens Download Notion app/Learn more. **More transcription options** also explains that desktop is needed for full system-audio capture.
- **Options** additionally contains upload, instructions, consent, move/delete, calendar event, demo, feedback and help. Start transcribing records audio; do not trigger casually.

## Marketplace and Library
- Marketplace **Connections**: click **Filter by title**, type to filter immediately; **Types** is multi-select (Public API, AI connector, Embed, SCIM/SSO); category chips combine with filters.
- Marketplace **Purchased** opens Buyer profile with Templates/Agents/Services tabs and sortable empty-history tables.
- Library Private/Favorites/Shared use Filter/Sort/Settings like databases. Library Private Settings → Property visibility controls workspace Library columns, not page content.
- My Tasks → **Configure your task sources** selects task databases; **Don’t see your tasks?** opens an in-app walkthrough.

# Dead ends & quirks

- Clicking sidebar **Home** while a page is open may open the Home sidebar/menu alongside the current page rather than replacing the page route; it is still the stable navigation home.
- Direct `/trash` showed only “Back to my content”; Trash manager actions were not available safely in this build.
- Share, invite, submit, publish, provider OAuth, purchases, booking/contact, and account/session actions are externally consequential and were not committed.
- Import file/upload controls invoke an undriveable native file picker.
- Public pages/forms and Installed connections were empty in this workspace.
- Custom Agents, dashboard modules, automations, advanced security/identity, and several AI features are plan/trial-gated.
- Browser AI Meeting Notes cannot fully capture video-call/system audio; desktop app is recommended.
- Scratch cleanup needed: pages/databases/forms/teamspace and rows/properties/templates created during exploration, including **Scratch Exploration Page 2026-08-09**, **Scratch Exploration Database 2026-08-09**, **Scratch AI Meeting Note 2026-08-09**, **My Agent Skill** and **AI Skills**, plus scratch items dated 2025-03-08; scratch workspace **David Grant’s Space** was also created. Do not delete similarly named pre-existing user content unless ownership is verified.
<!-- provenance: explore | app: app.notion.com | date: 2026-07-31 | backend: cdp | actions: 369 | elapsed: 1h14m | calls: 689 | tokens-in: 2511458 | tokens-out: 99773 | cache-read: 17808896 | cache-write: 0 | findings: 128 | finds: 0 | controls: 167 actuated / 1075 dismissed / 1238 seen | surfaces: 119 | chapters: 34 | stopped: frontier-empty | descent: off | gated: 0 read / 5 refused -->
<!-- controls actuated/seen is a LOWER BOUND ON BREADTH, not a coverage percentage: the denominator only grows as surfaces are opened, and operating a control is not understanding it. -->
<!-- Written by src/core/explore.ts. DO NOT HAND-EDIT: edits make this a curated recipe, not exploration output — move such notes to docs/recipes/<app>.md instead. -->

# Layout

## Sidebar and ordinary start
- **Home** is the ordinary landing overview. Use sidebar tab `Home`; direct `/home` also redirects to it. It contains Recently visited, Learn, Upcoming events, My tasks, and template widgets.
- Sidebar primary tabs: `Home`, `Chat`, `Meetings`, `Inbox`, `Search`; lower items include `Library`, `Marketplace`, `What’s new, help, contact, more…`, and `Trash`.
- Click the workspace name at top left for the workspace/account switcher: Upgrade, Settings, Invite members, Add account, Account options, workspaces, New workspace, Log out.
- Sidebar page sections have overflow menus for item count/order/visibility and `Customize sidebar`; these are personal settings.

## Main sidebar surfaces
- **Chat** is the Notion AI chat/agent surface; `New chat` starts a chat.
- **Meetings** provides AI Meeting Notes, calendar connection, upcoming meetings, and new-note creation.
- **Inbox** is the notification/activity surface with an editable filter.
- **Search** opens a global overlay. It supports text search, Title only, Created by, In, Date, Filter, Display, and settings for persistent filters/AI sources.
- **Library** is the stable full-page content overview. Tabs: Recents, Favorites, Shared, Private, and hidden `AI Meeting Notes` under `1 more…`. Each tab has local Search, Filter, Settings, and where applicable Sort/Group.
- **Marketplace** has Discover, Templates, Agents, Consultants, Connections; header Search, My profile, Purchased. Catalog cards may install, duplicate, buy, or book.
- **Help** menu offers Documentation, expert/support contact, releases, and More. More includes Keyboard shortcuts, Local backups, X, Terms & privacy, Status, and Clear page cache.

## Settings & members
Open workspace menu → `Settings`. It is a modal with:
- **Account:** Profile, Preferences, Notifications, Mail & Calendar.
- **Workspace:** General, People, Import.
- **Features:** Notion AI, Connections, Notion MCP, Public pages, Emoji.
- **Admin:** Teamspaces.
- **Access & billing:** Upgrade plan.

Important scopes:
- **Preferences** are personal/app scope: theme, contrast, language/number/date/time settings, startup page, desktop-link behavior, view-history visibility, profile discoverability.
- **Profile** is account scope: name/avatar, email/password, 2FA/passkeys, devices, support access, account deletion.
- **Notifications** are personal/account scope; Slack/Discord dropdowns, workspace activity/email/page updates/digest, meeting activity.
- **General** is workspace scope: workspace name/icon, landing page, sidebar apps, email domains, export, analytics/directory/profile/hover-card policies, deletion.
- **People** is workspace membership scope: Guests/Members/Groups/Contacts, invites, roles, import contacts.
- **Import** creates workspace pages from files/apps; Discover and Completed tabs.
- **Notion AI** splits into General, AI connectors, and Meeting notes. Meeting-notes workspace controls (enablement, consent, audio, retention) are distinct from personal controls (sidebar visibility, auto-share, default database, consent playback).
- **Connections / Notion MCP** manage workspace integrations, tokens, MCP clients, and restrictions.
- **Public pages** is a workspace-wide inventory; actual publishing is per-page Share. It also lists domains and a live-site indicator policy.
- **Emoji / Teamspaces** are workspace scope. Add emoji and New teamspace create workspace-visible objects.
- **Upgrade plan** is billing; do not operate casually.

## Page and database surfaces
- A page’s top-right `Actions` menu is the main document-scoped control surface: font, Small text, Full width, Lock page, Customize page, AI commands, Suggest edits, Translate, Import, Export, analytics, notifications, connections, duplicate/move/trash.
- `Customize page` contains per-page discussions, table of contents, and inline-comments style.
- Use the separate top-right `Share` for access/publishing. A breadcrumb `Private` button is **Move page to…**, not Share.
- `To Do List` contains an inline task database with To Do/Done views. Toolbar: Filter, Sort, Automations, AI Autofill, Search, Settings, New, and Open as full page.
- Database `Settings` opens view settings: Layout, property visibility, Filter, Sort, Group, conditional color, source, schema properties, automations, AI autofill, data sources, lock, Calendar, and More settings.
- Layout types: Table, Board, Timeline, Calendar, List, Gallery, Chart, Feed, Map. `Open pages in` choices: Side peek, Center peek, Full page; load limit 10/25/50/100.
- More settings includes subtasks, dependencies, sprints, connections, page-layout customization, and Undo Task database.
- Clicking a database row opens Side Peek by default. Header includes Close, Open in full page, Share, Copy link, Favorite, Actions. `Switch peek mode` allows Side/Center/Full/New tab and editing the persistent view default.
- Database page-layout customization applies to **all rows**, not one row. Save applies globally to the database; Cancel discards.

# How to

## Search globally
1. Click sidebar `Search`.
2. Type in the search field.
3. Optionally use `Created by`, `In`, `Date`, or `Filter`.
4. Date filter supports Created/Last edited, Today, Last 7 days, Last 30 days, and calendar dates.
5. Escape closes nested pickers/overlay without applying.

## Find content without global search
1. Click `Library`.
2. Choose Recents, Favorites, Shared, Private, or `1 more…` → AI Meeting Notes.
3. Use the toolbar magnifier for a view-local `Type to search…` field.
4. Use Settings for property visibility/filter/sort/group. These settings apply immediately to that Library view.

## Open settings
1. Click the workspace name at top left.
2. Click `Settings`.
3. Choose the exact left-nav category; confirm scope before changing anything.
4. Close with the top-right close button or Escape.

## Configure Home
1. On Home, click top-right `Open menu`.
2. `Change default start page` offers Last visited page, Top page in sidebar, Library, Notion AI.
3. `Show/hide widgets` offers Greeting, Upcoming Events, My Tasks, Database Views, Learn, Featured Templates.
4. These are immediate personal settings; select only when requested.

## Change a page display setting
1. Open the page.
2. Click top-right `Actions`.
3. Use `Customize page` for discussions, table of contents, or inline-comment style.
4. Small text, Full width, Lock page, and some row-page table-of-contents controls are immediate document settings.

## Export a page/database
1. Open page `Actions` → `Export`.
2. Choose PDF, HTML, or Markdown & CSV.
3. For databases choose Current view or Default view; choose page content inclusion.
4. Set Include subpages/Create folders if needed.
5. Export downloads; Cancel discards dialog choices.

## Configure a database view
1. Open the database’s `Settings`.
2. Choose Layout, Property visibility, Filter, Sort, Group, or Conditional color.
3. Remember each view has independent configuration; To Do and Done are separate views.
4. To change row opening behavior: Layout → Open pages in → Side peek/Center peek/Full page.
5. Do not confuse the per-opening `Switch peek mode` with `Edit view default`, which persists for the view.

## Inspect/edit database schema
1. Database Settings → `Edit properties`.
2. Select a property (for example Status).
3. Property type/options/display are schema-wide changes. Status can display as Checkbox or Select.
4. Add property, duplicate, rename, or delete affects the whole database.

## Customize database row layout
1. Database Settings → More settings → `Customize page layout`; alternatively hover near a row title and click `Customize layout`, or use row Actions.
2. Choose Simple/Tabbed structure and modules/panel placement.
3. Adjust inline comments, discussions, property icons, full width, templates.
4. `Save` applies to all pages; `Cancel` discards.

## Inspect page analytics
1. Page Actions → `Updates & analytics`.
2. Updates lists edit events/version links.
3. Analytics offers Views, viewer history, creator/editor, and Last 7/28/90 Days or All Time.
4. Bottom `Settings` controls only personal `Show your view history`; workspace General controls whether page analytics are available.

## Use Marketplace
1. Click sidebar `Marketplace`.
2. Choose Templates, Agents, Consultants, or Connections.
3. Search/filter catalog; opening a connection card shows an in-app detail page.
4. `Purchased` is a modal with Templates/Agents/Services purchase history.
5. `Get connection`, template duplication, agent install, purchase, and Book are consequential—only use when explicitly requested.

# Dead ends & quirks
- Home’s main `New page` card creates a blank private page immediately. Do not click merely to inspect.
- Opening setup-guide `Give Notion AI some personality` marked the checklist item complete even without editing or Done.
- A normal Home click can occasionally open a small context menu; Escape then `/home` is a reliable fallback.
- `Private` beside a page title opens Move page to…, not sharing.
- The page Share panel could not be inspected because the harness treats opening it as an externally visible sharing action.
- Trash was not entered because it is destructive-sensitive.
- Page Actions → Import routes to workspace Import; it does not insert into the current page.
- `Source` in database view settings links another data source; it does not rename the current source.
- Full-page database title/breadcrumb click edits the data-source name; Escape cancels.
- `Undo Task database` removes task-database behavior; it is not a view reset.
- Database New creates a row immediately; the adjacent arrow opens database templates.
- Page Suggest edits enters mode immediately; leave it via `Turn off suggesting`.
- Settings toggles and view configuration commonly apply immediately. Inspect menus without selecting unless a change is requested.
- Connections, imports, invites, account links, publishing, billing, creation, deletion, and Marketplace installs/purchases/bookings are externally visible or state-changing.
- External Help/Marketplace links may leave app.notion.com; do not follow during in-app tasks.
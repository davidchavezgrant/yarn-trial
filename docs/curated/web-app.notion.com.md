# Notion (app.notion.com, web) — grounding notes

**Provenance, stated plainly because it changes what this file licenses:** assembled 2026-08-03
from the 2026-07-31 cdp exploration pass (369 actions, 1h14m, 119 surfaces, frontier-empty) and
its appmap, NOT from independent hands-on use of a human who has driven these two tasks by hand.
`docs/curated/yarn.md`, the sibling this tier is calibrated against, came from someone working the
app directly. So the curated arm on Notion is a weaker upper bound than the curated arm on Yarn,
and a Notion curated-vs-appmap comparison is closer to "does prose beat a graph of the same
knowledge" than to "does a human beat the machine". Read it that way, and if the curated tier wins
here, that is a finding about FORM, not about human expertise.

Like `yarn.md` this file is TASK-CONTAMINATED on purpose — it names the surfaces the benchmark's
two tasks need. That is what the tier is for (the grounding upper bound), but it means the curated
arms cannot be read as a generalization claim.

Notion = a workspace app: pages containing blocks, some of which are databases with multiple views.

## Layout

- **Left sidebar**: workspace name at the very top (click it for the workspace/account switcher —
  Upgrade, **Settings**, Invite members, Add account, workspaces, Log out). Primary tabs `Home`,
  `Chat`, `Meetings`, `Inbox`, `Search`. Lower: `Library`, `Marketplace`, help, `Trash`.
- **Home** is the landing overview (Recently visited, Learn, Upcoming events, My tasks, template
  widgets). `/home` redirects here.
- **Library** is the stable full-page content list — tabs Recents, Favorites, Shared, Private, and
  `AI Meeting Notes` hidden under `1 more…`. Use this, not Home, when you need to find a page you
  just made: Home's "Recently visited" is a widget and can lag.
- **A page** has a top-right `Actions` menu (document scope: font, Small text, Full width, Lock
  page, Customize page, Export, duplicate/move/trash) and a separate top-right `Share`.
- **A database inside a page** has its own toolbar: `Filter`, `Sort`, `Automations`, `AI Autofill`,
  a magnifier `Search`, `Settings`, `New`, and "Open as full page".

## The three scopes, which is the thing most worth knowing here

Notion nests scope more deeply than Yarn does, and the same word appears at more than one level:

- **View scope** — Layout, property visibility, Filter, Sort, Group, conditional colour. Set via the
  database's `Settings`. **Each view is configured independently**: a filter on the Board view does
  nothing to the Table view, and two views of one database routinely disagree. This is the scope the
  complex task's "shows only the unfinished ones" belongs to.
- **Database (schema) scope** — the properties themselves, via `Settings` → `Edit properties`. A
  property's type and its option set are schema-wide; renaming or deleting one affects every view and
  every row. Adding the Status property is here.
- **Workspace / account scope** — everything behind the workspace menu → `Settings`. `Preferences`
  is personal (theme, language, startup page); `General` is workspace (name, icon, landing page,
  export, analytics policy); `Profile` is account; `People` is membership. **Neither benchmark task
  needs any of these.** If a run is in this modal it has gone wrong.

Also genuinely confusing and worth pre-empting: **database "page layout" customization applies to
ALL rows**, not the row you opened it from. `Save` is global, `Cancel` discards.

## How to — create a table and populate it

1. Make a page to hold it. Sidebar `Library` → the `New` affordance, or Home's `New page` card —
   but see the quirk below, that card creates a blank private page the instant it is clicked.
2. In the page body, insert a database block by typing `/` and choosing a table. A `/`-menu is the
   normal Notion route for every block type and is far more reliable than hunting for a button.
3. Rows: the toolbar `New` **creates a row immediately** — there is no confirm step. The small arrow
   NEXT to `New` opens database templates instead, which is not what you want; aim for `New` itself.
4. To fill a cell, click it and type. Cells commit on Escape, Tab, or a click elsewhere.
5. Verify by reading the rows back off a fresh observation, not from the fact that typing appeared to
   work — see the caret warning below.

## How to — a task database with a status property, five tasks, and a filtered board view

The complex task is six surfaces and nothing completes it in one control. Order matters:

1. **Create the database** on a page, as above.
2. **Add the Status property**: database `Settings` → `Edit properties` → add a property of type
   **Status**. Notion's Status type is not a plain select — its options are pre-grouped into
   **To-do / In progress / Complete**, and that grouping is what "unfinished" should be expressed
   against. Status can also display as a Checkbox, which is a display choice and not a different
   property.
3. **Add five rows** and give them statuses spanning more than one group — the task says "across
   different statuses", so at least one row should sit outside Complete or the filter in step 5
   proves nothing.
4. **Add a board view** and set it up: `Settings` → **Layout** → `Board`, then `Group` → the Status
   property. Grouping a board by Status is the ordinary Notion idiom and the board will lay out one
   column per status.
5. **Filter to the unfinished ones**: on THAT view, `Filter` → Status → exclude Complete (or include
   To-do and In progress). Do this on the board view, not the table view — see view scope above.
   Getting this on the wrong view is the most likely silent failure of this task.

## Dead ends & quirks

- **Home's main `New page` card creates a blank private page immediately.** Do not click it to
  inspect what it does.
- **`Private` beside a page title is "Move page to…", not Share.** Nothing about it publishes.
- **Escape closes nested pickers and overlays WITHOUT applying.** Useful for backing out; also means
  a change you thought you made may not have landed. Re-observe rather than assuming.
- A normal Home click can occasionally open a small context menu; Escape then `/home` recovers.
- **On a full-page database, clicking the title/breadcrumb edits the DATA SOURCE name**, not the page
  title. Escape cancels.
- `Source` in view settings links a different data source — it does not rename the current one.
- `Undo Task database` removes task-database behaviour entirely. It is not a view reset.
- `Page Actions → Import` routes to workspace Import; it does not insert into the current page.
- `Suggest edits` enters a mode immediately; leave via `Turn off suggesting`.
- **Settings toggles and view configuration apply immediately** — there is no save step for most of
  them. Inspect menus without selecting unless you intend the change.
- The Share panel was never inspected by the exploration pass: the harness treats opening it as an
  externally visible sharing action and refused. Trash was not entered either, for the same class of
  reason. Both remain unmapped, and neither task needs them.
- **Do not touch**: Share/publishing, invites, Connections, Import, account links, billing/Upgrade,
  Marketplace installs, purchases and bookings, or Trash. All are externally visible or irreversible.

## Harness notes for this target

- Notion is a **web target and runs on the cdp backend only**. The ax backend refuses a URL outright
  (`src/core/agent/run.ts`, `src/core/explore.ts`, `src/backends/ax.ts` all throw), and `AXDOM=0` is
  meaningless here — on cdp the DOM *is* the element channel.
- **It needs a signed-in Chrome profile on the RUNNER**, not on the operator's Mac
  (`./run browser-login`). Measured 2026-08-03: mac1 had no app.notion.com session while mac2 and
  mac3 did, so an unlucky schedule looks like an agent failure.
- **Notion's editor is contenteditable and holds focus aggressively.** Prefer addressing a field by
  ref/handle over typing at the caret, and after any interrupted typing, re-observe before continuing
  — the line you were typing into may have moved under a re-render. This is the same failure class
  documented at length for Yarn's ProseMirror editor in `yarn.md`, and Notion's blocks behave the
  same way.
- Both benchmark tasks **create workspace content, and teardown does not remove it** — the mutation
  journal restores settings, not page and database creation. Seed the workspace to a known state and
  clear it between passes, or run n+1 and read the first sample as contaminated.

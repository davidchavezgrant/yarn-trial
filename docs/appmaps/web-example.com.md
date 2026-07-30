<!-- provenance: explore | app: example.com | date: 2026-07-30 | backend: ax | actions: 4 | elapsed: 2m | findings: 2 | finds: 0 | controls: 0 actuated / 8 dismissed / 8 seen | surfaces: 1 | chapters: 1 | stopped: frontier-empty -->
<!-- controls actuated/seen is a LOWER BOUND ON BREADTH, not a coverage percentage: the denominator only grows as surfaces are opened, and operating a control is not understanding it. -->
<!-- Written by src/explore.ts. DO NOT HAND-EDIT: edits make this a curated recipe, not exploration output — move such notes to docs/recipes/<app>.md instead. -->

## What this app is

`example.com` is **not an application**. It is the IANA/ICANN reserved placeholder domain: a single static HTML page, served at `http://example.com/`, with no navigation, no routes, no authentication, no settings, no persisted state, and no JavaScript behaviour.

## Layout

Root surface — `http://example.com/` (browser tab title "Example Domain"), the whole page:
- `<h1>` **"Example Domain"** (static text, ~(408,432) in a 1257px-wide screenshot)
- One paragraph: *"This domain is for use in documentation examples without needing permission. Avoid use in operations."*
- One link: **"Learn more"** (~(320,590)) → navigates OFF-SITE to `https://www.iana.org/domains/example`.

That is the entire DOM of interest (accessibility tree exposes exactly: AXWebArea "Example Domain", AXHeading, two AXStaticText, one AXLink).

There is no other surface reachable from the page. Everything else visible in the observation is **Chrome browser chrome**, not the app: address bar, Back/Forward/Reload, bookmarks bar (Bylines.Client / localhost:5213 / https://localhost:5443/login), extension buttons (MetaMask, Dark Reader), profile button, and the macOS menu bar.

The same browser window has a **second tab, "Acrobat extension Updates"** (`acrobat.adobe.com/dc-chrome-extension/index.html#/whats-new`) — a third-party Adobe marketing page opened by the Acrobat Chrome extension. It is *not* part of example.com. Switch tabs by clicking the tab AXRadioButton ("Example Domain" / "Acrobat extension Updates").

## How to

- **Open the app**: click the browser tab "Example Domain", or focus the address bar → cmd+a → type `example.com` → return.
- **Change the URL reliably**: click the address bar element, press cmd+a (to replace the pre-filled value), type the URL, verify the field value in the next observation, then press return. `set_value` on the omnibox silently reverts; plain `type_text` *appends* to the existing value (yielding e.g. `example.com/does-not-exist example.com`, which submits as a Google search).
- **Cancel an omnibox edit**: press escape with delivery_mode "foreground" — the field snaps back to `example.com`.
- **Read the page content**: it is static text in the observation; no scrolling needed (page fits in the viewport, no scrollbar content below the link).
- **Follow "Learn more"** (only if a task explicitly requires it): click the AXLink "Learn more". Expect to land on `iana.org/domains/example` — this leaves example.com; use Back to return.

## Dead ends & quirks

- **There are no settings, preferences, account, workspace, profile, search, forms, modals, drawers, tabs, or accordions anywhere on example.com.** If a task asks for any of those, they do not exist here — do not go hunting; report the absence.
- Consequently there are **no scope pairs** (no app-wide default vs. per-document override) to worry about: the site stores nothing.
- The only interactive element on the page is an outbound link; every "control" in the initial frontier except that link belonged to the unrelated Adobe tab.
- Non-root paths (e.g. `/does-not-exist`) were **not** verified — the omnibox quirk above blocked the probe, and the attempt was cancelled rather than turned into a web search. Assume only `/` is known-good.
- Chrome-level keyboard shortcuts (cmd+w/cmd+t/cmd+r) must be avoided: they hit the browser, not the page, and would end the session or lose state.
- The Adobe tab's buttons ("Start free trial", "Change your preferences", "View plans and pricing", …) are commercial/account actions on a third-party site; they were deliberately not operated.
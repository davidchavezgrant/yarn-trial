<!-- provenance: explore | app: www.notion.so | date: 2026-07-30 | backend: dom | actions: 24 | elapsed: 7m | findings: 9 | finds: 2 | controls: 1 actuated / 0 dismissed / 480 seen | surfaces: 1 | chapters: 3 | stopped: error | salvaged: session died before finish -->
<!-- controls actuated/seen is a LOWER BOUND ON BREADTH, not a coverage percentage: the denominator only grows as surfaces are opened, and operating a control is not understanding it. -->
<!-- Written by src/explore.ts. DO NOT HAND-EDIT: edits make this a curated recipe, not exploration output — move such notes to docs/recipes/<app>.md instead. -->

> Scope note: this run mapped **www.notion.so** while **logged out**. www.notion.so redirects to **www.notion.com** (the marketing site). The logged-in workspace app (app.notion.com / www.notion.so/<workspace>) was never reachable — no credentials.

> **CRITICAL DRIVER LIMITATION observed in this environment:** all pointer/keyboard input was refused (`browser_input_trust_unavailable`). click / hover / type_text / press_key all failed; only `navigate` (direct URL) worked. Consequently the entire map below was built by URL navigation, and **no dropdown, accordion, toggle or form could be operated**. If your driver *can* click, the header/footer links listed here are the intended navigation.

## Layout

**Marketing site — shared chrome (present on almost every page):**
- Header: logo "Notion – Home", dropdown buttons **Product**, **Solutions**, **Resources** (never opened — input refused), links **Developers**, **Enterprise**, **Pricing**, **Request a demo**, **Log in**, **Get Notion free**. Header contents vary slightly per page (e.g. `/desktop` shows an extra **AI** dropdown between Product and Solutions).
- Footer link groups: *Company* (About us, Careers, Security, Status, Terms & privacy, Your privacy rights); *Download* (iOS & Android, Mac & Windows, Calendar, Web Clipper); *Resources* (Help center, Pricing, Blog, Community, Connections, Templates, Partner programs); *Notion for* (Enterprise, Startups, Small business, Personal, Explore more); social links; buttons **English (US)**, **Cookie settings**, **Do Not Sell or Share My Info**.

**Routes confirmed to exist (loaded successfully):**
| URL | Contents |
|---|---|
| `/` (root, = notion.so redirect) | Home / marketing landing |
| `/pricing` | Plan cards + monthly/yearly billing-period toggle (not operable here) + FAQ accordion |
| `/product` | Same content as home |
| `/product/ai` | "Meet your 24/7 AI team" — Agents, Enterprise search, AI Meeting Notes, Admin controls; FAQ accordion |
| `/product/docs` | Docs |
| `/product/wikis` | Wikis |
| `/product/calendar` | Notion Calendar: Get free, Download for macOS, macOS/Windows/App Store/Google Play links, video player (Play/Mute/CC/Settings), FAQ disclosures |
| `/enterprise` | Enterprise page |
| `/desktop` | Download page: "Choose desktop platform and architecture" dropdown (defaults macOS Universal) + Download, See system requirements, Notion Calendar download |
| `/security` | Security & privacy hub: Our security practices, Submit Vulnerability Report, Trust Center, terms & privacy, service level terms, status page, security@/abuse@makenotion.com |
| `/help` | Help center: "Search help center" box, topic chips (Billing, Data sources, Restoring content, Adding members), Popular topics cards, Browse by team (Project management, Engineering, Design, Marketing, Startup, Enterprise), Notion Academy, What's new, Get in touch / Find a consultant / Join the community |
| `/templates` | Marketplace: sub-nav **Marketplace \| Templates \| Agents \| Consultants \| Connections**, "Search template gallery" combobox + search button, featured consultants/agents/templates, collections, categories, creators, "Become a creator" |
| `/blog` | "Tools & Craft" blog index; left category nav (Latest, Notion HQ, For Teams, Inspiration, Pioneers, Tech, First Block); pagination 1–5 + Next page |
| `/customers` | Customer Stories index: logo row (Toyota, Ramp, OpenAI, Clay, Cursor, Vercel, Faire), filter buttons **Team sizes** and **Industries**, featured story, story cards, pagination 1–5 + Next page |
| `/contact-sales` | Multi-step demo-request form; **bare layout, no header/footer**. Step 1 = "Work email" textbox + Next; later steps gated behind it |
| `/login` → `app.notion.com/login` | Email textbox + Continue; providers Google, ChatGPT, Apple, Microsoft, Passkey, SSO; "Sign up" link; footer "Language: English (US)" + "Help" |
| `/signup` → `app.notion.com/signup` | "Work email" textbox + Continue; providers Google, Microsoft, ChatGPT only (no Apple/Passkey/SSO) |

**Routes confirmed NOT to exist:** `/solutions` and `/solutions/engineering`. Both forward to `app.notion.com/<slug>` and render the sign-in gate (see quirks).

## How to
- **Reach any marketing page:** navigate directly to the `https://www.notion.com/<path>` URL from the table above. `www.notion.so/<path>` redirects to the same.
- **Log in:** navigate `https://www.notion.com/login` (lands on app.notion.com/login) → type into the "Email" textbox → click "Continue"; or click one of Google / ChatGPT / Apple / Microsoft / Passkey / SSO.
- **Sign up:** `https://www.notion.com/signup`; note the provider set is smaller than on login.
- **Request a demo / contact sales:** `https://www.notion.com/contact-sales` (also the header "Request a demo" link) → enter Work email → Next → remaining steps appear only after step 1.
- **Download the desktop app:** `/desktop` → pick platform in the "Choose desktop platform and architecture" dropdown → Download.
- **Search help articles:** `/help` → type in the "Search help center" textbox.
- **Search templates:** `/templates` → "Search template gallery" combobox → search button.
- **Change site language:** footer button "English (US)" on any marketing page (login page has its own "Language: English (US)" button).

## Dead ends & quirks
- **Input was refused for the whole run** (`browser_input_trust_unavailable`, macOS window-activation issue). Never verified: Product/Solutions/Resources dropdown contents, pricing FAQ accordions, the monthly/yearly pricing toggle, `/customers` Team sizes & Industries filters, blog category nav, any form submission.
- **Unknown paths are not 404s.** Any unrecognized `www.notion.com/<path>` is forwarded to `app.notion.com/<path>` and shows a workspace permission gate: *"You're almost there! Sign in to see this page in \<slug\>"* with the standard login form. Seeing that screen means the marketing route does not exist — do not read it as a real page.
- `www.notion.so` is a redirect surface only; the actual logged-out product marketing lives on `www.notion.com`.
- `/contact-sales` drops the global header/footer, so you cannot navigate away via nav links — use the URL bar.
- `/product` renders the same content as the home page (not a separate hub).
- Story/template/creator cards on `/customers` and `/templates` are content, not navigation; pagination links (1–5, Next page) are the only structural controls there.
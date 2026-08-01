<!-- provenance: explore | app: Yarn | date: 2026-07-31 | backend: ax | actions: 17 | elapsed: 4m | calls: 31 | tokens-in: 83227 | tokens-out: 6370 | cache-read: 453120 | cache-write: 0 | findings: 4 | finds: 0 | controls: 4 actuated / 86 dismissed / 90 seen | surfaces: 10 | chapters: 2 | stopped: frontier-empty | descent: off | gated: 0 read / 0 refused -->
<!-- controls actuated/seen is a LOWER BOUND ON BREADTH, not a coverage percentage: the denominator only grows as surfaces are opened, and operating a control is not understanding it. -->
<!-- Written by src/core/explore.ts. DO NOT HAND-EDIT: edits make this a curated recipe, not exploration output — move such notes to docs/recipes/<app>.md instead. -->

# Layout

- **Recording Setup (Untitled window)** — Yarn’s ordinary launch surface in this environment. It is a document-scoped permission gate shown before any recorder/editor UI. It states that Accessibility and Screen Recording permissions are required to record the screen and precise mouse movements.
  - **Accessibility → Open Settings** opens the external macOS Privacy & Security / Accessibility Access surface.
  - **Screen Recording → Open Settings** opens the external macOS Screen Recording permission surface.
- **About Yarn** — open via **Yarn > About Yarn**. Appears as a separate window titled “Yarn”; its contents are not exposed to this driver.
- **Yarn Help** — open via **Help > Yarn Help**. Help appears external or non-exposed; Yarn becomes dim/inactive and no help content appears in the target observation.
- The menu bar contains **Yarn, File, Edit, View, Window, Help**, but no Yarn Settings/Preferences command was present. While the permission gate or external Help state is active, document commands such as **File > New Window**, **Close**, and **Close All** can be disabled.

# How to

- **Grant Accessibility permission:** on Recording Setup, click the upper **Open Settings** aligned with **Accessibility**, then make the change in macOS System Settings. Merely opening Settings does not change Yarn state.
- **Grant Screen Recording permission:** click the lower **Open Settings** aligned with **Screen Recording**, then make the change in macOS System Settings. Merely opening Settings does not change Yarn state.
- **Open About:** choose **Yarn > About Yarn**. Close the auxiliary window before continuing.
- **Open Help:** choose **Help > Yarn Help**. Expect the target Yarn window to become inactive with no exposed help content; use Escape in the foreground to attempt to return.

# Dead ends & quirks

- The required macOS permissions were not changed for safety, so the recorder/editor and any per-recording controls remain inaccessible behind Recording Setup.
- Both **Open Settings** buttons leave Yarn visually unchanged and invoke System Settings outside the target window.
- **Yarn Help** produced no target-visible content even after a 60-second wait; treat it as an external/non-exposed surface.
- Clicking the inactive window through its AXWindow element can fail with an AXPress error; a painted blank-area click may be needed to try to foreground it.
- No app Settings/Preferences item was found in the Yarn menu, so there is no mapped app-wide defaults panel to pair with document overrides.
- **Services Settings…** is macOS configuration, not a Yarn surface. **Quit Yarn** and close commands were deliberately not operated.
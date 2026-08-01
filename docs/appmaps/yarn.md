<!-- provenance: explore | app: Yarn | date: 2026-08-01 | backend: ax | vision: off | actions: 8 | elapsed: 3m | calls: 17 | tokens-in: 34381 | tokens-out: 4308 | cache-read: 340480 | cache-write: 0 | findings: 2 | finds: 0 | controls: 6 actuated / 75 dismissed / 81 seen | surfaces: 9 | chapters: 1 | stopped: frontier-empty | descent: off | gated: 0 read / 0 refused -->
<!-- controls actuated/seen is a LOWER BOUND ON BREADTH, not a coverage percentage: the denominator only grows as surfaces are opened, and operating a control is not understanding it. -->
<!-- Written by src/core/explore.ts. DO NOT HAND-EDIT: edits make this a curated recipe, not exploration output — move such notes to docs/recipes/<app>.md instead. -->

# Layout

- **Untitled (home):** Yarn’s only app window in this run. It is a small window containing two identical **Open Settings** buttons, one above the other.
- **Yarn menu > Services:** Standard macOS Services submenu. It shows disabled **No Services Apply** plus **Services Settings…**.
- Standard macOS **Apple**, **Edit**, **Window**, and **Help** menus are present, but no functional Yarn-specific editor, library, document list, preference window, or other content surface was exposed.

# How to

- **Try to open Yarn settings:** On **Untitled**, click either **Open Settings** button. In this build/session, neither produced any visible response, including after waiting 60 seconds.
- **Open macOS Services settings:** Open the **Yarn** menu → **Services** → **Services Settings…**. This launches external macOS System Settings; it is not a Yarn preference panel.
- **Return/start:** Launch or foreground Yarn to reach the sole **Untitled** window.

# Dead ends & quirks

- There are two visually distinct but identically labeled **Open Settings** buttons. Both were operated and both were inert.
- **Yarn Help** produced no visible help surface.
- **Edit > AutoFill** and **Edit > Emoji & Symbols** produced no visible surface in Yarn.
- **About Yarn**, **Hide Yarn**, most File commands, and full-screen commands were disabled.
- **Services Settings…** is an external macOS configuration path, not an app setting.
- Apple-menu recent items and system/session actions, window-placement commands, Quit, Hide Others, and the sole window close button were deliberately not operated because they are external, destructive/disruptive, or unrelated to Yarn functionality.
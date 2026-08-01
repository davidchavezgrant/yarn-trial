<!-- provenance: explore-vision | app: Yarn | date: 2026-08-01 | backend: ax | actions: 5 | elapsed: 2m | calls: 10 | tokens-in: 10188 | tokens-out: 3594 | cache-read: 40448 | cache-write: 0 | findings: 1 | finds: 0 | controls (DECLARED): 2 actuated / 3 dismissed / 5 seen | surfaces: 1 | chapters: 1 | stopped: frontier-empty | descent: off | gated: 0 read / 0 refused -->
<!-- controls tallies are DECLARED — self-reported by the model from screenshots, not measured against an element list. A control the pass never declared is invisible to these numbers. -->
<!-- Written by src/core/explore.ts. DO NOT HAND-EDIT: edits make this a curated recipe, not exploration output — move such notes to docs/recipes/<app>.md instead. -->

# Layout

- **Recording Setup** is the launch/landing window currently shown by Yarn. It is a mandatory app-wide onboarding gate rather than a document editor.
- The window explains that Yarn needs two macOS permissions to record the screen and precise mouse movements:
  - **Accessibility** — click the adjacent **Open Settings** button.
  - **Screen Recording** — click the adjacent **Open Settings** button.
- Yarn also states that continuing consents to processing video and audio recordings under its Terms and Privacy Policy.

# How to

## Open the macOS permission panes
1. Launch Yarn to reach **Recording Setup**.
2. For mouse-control permission, click **Open Settings** on the **Accessibility** row.
3. For capture permission, click **Open Settings** on the **Screen Recording** row.
4. Make any permission change manually in macOS System Settings, then return to Yarn. Permission state was not changed during exploration.

# Dead ends & quirks

- The onboarding gate exposes no Continue/Skip control; the main Yarn interface could not be reached without satisfying the required macOS permissions.
- In this driver, clicking either **Open Settings** button did not visibly switch away from Yarn, even after waiting. The intended behavior is nevertheless clearly to open the corresponding macOS privacy pane.
- Standard **Cmd+,** did not open Yarn settings while the onboarding gate was displayed.
- Clicking the visible **Terms and Privacy Policy** text caused no visible navigation; it may be non-interactive copy.
- No document-level settings or per-document/app-wide setting pairs could be inspected because the permission gate prevented access to the main interface.
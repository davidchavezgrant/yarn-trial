import { appSlug } from "../paths.js";

/**
 * The harness barrel: convenience for core, and a COST for anything outside it.
 *
 * Importing this pulls all nine submodules, and with them the Anthropic SDK and the cua driver
 * — measured 2026-07-31: 52ms and +5MB, versus 2-4ms and no measurable heap for the submodule
 * that actually defines the symbol you wanted. Inside core that is fine (a run loads both
 * anyway, and there are no cycles: submodules import siblings directly, never this file).
 *
 * OUTSIDE core, import the submodule. The rule exists because of one caller in particular: the
 * per-Mac runner is a LaunchAgent that lives for days and spawns every run as a child, so a
 * driver loaded into the daemon is a native library resident in a process that must never hold
 * a session. Four call sites were doing exactly that for one symbol each and are now narrowed —
 * `appSlug` is in paths.ts, `mintRunKey`/`UNREADY_EXIT` in harness/run.ts, `screenIsLocked` in
 * harness/observation.ts, `auditTaskPrompt` in harness/verification.ts.
 *
 * Two edges into the heavy modules remain and are LOAD-BEARING, not oversights:
 * `serve.ts` -> harness/observation for `screenIsLocked` (the daemon has to know whether the
 * login window owns the display; it parses driver code but starts no session, +0MB measured),
 * and `ui-core.ts` -> harness/verification for `auditTaskPrompt` (the shell must refuse a
 * hinted prompt BEFORE dispatch, and that gate is the SDK's neighbour).
 */
export { appSlug };

export * from "./harness/run.js";
export * from "./harness/observation.js";
export * from "./harness/frontier.js";
export * from "./harness/declared-frontier.js";
export * from "./harness/model.js";
export * from "./harness/gates.js";
export * from "./harness/appmap.js";
export * from "./harness/verification.js";
export * from "./harness/actions.js";

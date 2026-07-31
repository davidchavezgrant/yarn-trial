import { envNum } from "../../env.js";

/**
 * The only backstop, and it counts actions rather than seconds on purpose. A wall-clock cap
 * used to sit beside it and was removed: some apps embed an agent of their own, and waiting
 * out a five-minute think is legitimate exploration that a clock cannot distinguish from a
 * hang. Actions are the honest unit — a pass that is stuck is stuck at some count, however
 * long each one took. What ends a pass normally is the frontier emptying (see harness.ts).
 *
 * Sized so it cannot be what ends a long pass. An action is a model call plus a driver call
 * plus an observation, which has never measured under ~10s (Yarn's finished pass ran ~25s),
 * so 24 hours is at most ~8,600 actions and realistically a third of that. 10,000 clears the
 * ceiling either way, which is the point: reaching it means something is looping, not that
 * the app was large.
 */
export const MAX_ACTIONS = envNum("EXPLORE_MAX_ACTIONS", 10_000);
/**
 * Most controls a single `dismiss` may retire when it does not name a specific surface.
 * Measured need: an uncapped pass cleared 104 unrelated top-level controls in one call and
 * declared the frontier empty at 25 actuated of 262 seen. Named panels are exempt — a list
 * of 80 identical rows is one honest decision; a hundred scattered controls are not.
 */
export const DISMISS_CAP = envNum("EXPLORE_DISMISS_CAP", 20);
/** The destructive-label pre-flight. Its own switch, deliberately not tied to `guidance`. */
export const GUARD_ON = (process.env.EXPLORE_GUARD ?? "on") !== "off";
/**
 * Guarded descent: on a REVERSIBLE-labelled control (delete/reset/archive/export — not the
 * off-machine verbs), press it ONCE to surface whatever it gates, read that boundary, and
 * Escape without committing. Off by default: it spends grounding budget and, unlike today's
 * pure refusal, actually presses a destructive-looking control — a declared choice, logged in
 * the stamp like the guard and the dismiss cap. Externality is refused regardless of this flag.
 */
export const DESCENT_ON = (process.env.EXPLORE_DESCENT ?? "off") === "on";
/**
 * Observations kept in one context window before it is reset. Each costs ~7k tokens (AX
 * text plus a screenshot), so ~12 is ~85k — comfortable, and bounded no matter how long the
 * pass runs. See the chapter comment at the reset site.
 */
export const CHAPTER_OBSERVATIONS = envNum("EXPLORE_CHAPTER", 12);
export const SETTLE_MS = 900;

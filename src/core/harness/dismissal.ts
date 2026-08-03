/**
 * Why a control was skipped — as a closed set the harness can CHECK, not free text.
 *
 * Measured on 2026-08-01 across three grounding passes: "would change state" was the reason
 * for 51%, 70% and 50% of every control skipped. The mechanical guards refused 7-12 controls
 * per pass by comparison — about 1% of skips. The model's own conservatism was the frontier's
 * bottleneck by two orders of magnitude, and it wrote fluent justifications the whole way:
 * "mapped but not operated to preserve state" reads perfectly reasonable and is exactly the
 * behaviour that lost an entire template editor.
 *
 * So a free-text reason cannot be the gate. A model asked for a justification will produce
 * one; asked for a justification from a list, it will pick the closest-fitting item. The only
 * thing that makes this more than theatre is VERIFYING the claim against the observation the
 * model was looking at — a label that does not match a guard pattern is not "dangerous", a
 * cohort of three is not "repetitive", and saying so costs the pass a turn and a correction.
 *
 * Note what is absent: there is no category for "operating this would change something". That
 * is deliberate — the reason that accounted for most of the loss is now INEXPRESSIBLE rather
 * than merely discouraged, which is a stronger guarantee than a prompt instruction.
 */
import type { InteractiveElement, ObservationBundle } from "./observation.js";
import { externalityTarget, reversibleTarget } from "./gates.js";

export const DISMISS_REASONS = ["external", "destroys-user-data", "repetitive-value", "content", "dead-end"] as const;
export type DismissReason = (typeof DISMISS_REASONS)[number];

/** What each category means, rendered into the tool schema so the model reads one definition. */
export const DISMISS_REASON_HELP: Record<DismissReason, string> = {
	external: "Commits off the machine — send, publish, share, invite, purchase, sign out, account changes. Refused by the guard anyway.",
	"destroys-user-data": "Deletes, renames, moves or overwrites something that already existed. Never applies to scratch you created yourself.",
	"repetitive-value": "One of a large list of interchangeable values — fonts, colours, languages, timezones. Operate ONE to learn the interaction, then dismiss the rest with this.",
	content: "A user's document, draft, row or transcript chunk — content to be acted on, not navigation that reveals a surface.",
	"dead-end": "You already operated something equivalent and it revealed nothing new.",
};

/** A cohort this size is a value list rather than a panel of distinct controls. Matches frontier.ts. */
const REPETITIVE_MIN = Number(process.env.EXPLORE_COLLAPSE_MIN ?? 25);

export interface DismissCheck {
	/** Undefined when the claim holds; otherwise what to tell the model. */
	refusal?: string;
}

/**
 * The categories still open after a refusal, named in the refusal itself.
 *
 * A refusal that ends "dismiss them under a reason that fits" does not say WHICH fits, and the
 * closed set is only in the tool schema — many turns back by the time the correction arrives.
 * Measured on the 2026-08-03 Notion pass (`explore-2026-08-03T12-16-55-470`): 4 dismissals
 * attempted, 4 refused, at actions 3, 23, 24 — and then none for the next 137 actions. The
 * frontier climbed 57 -> 394 and never fell. The only Notion pass that ever reached
 * frontier-empty ran three hours before this gate existed and dismissed 1075 controls.
 *
 * So the gate did not merely reprice dismissal on that app, it taught the model to stop asking.
 * That is a failure of the CORRECTION, not of the rule: `content` and `dead-end` were accepted
 * unconditionally the whole time and are exactly what a frontier of page links and document
 * rows is made of.
 *
 * This widens nothing. `DISMISS_REASONS` is unchanged and every check below is unchanged; a
 * refused claim is still refused. What changes is that the turn it costs now buys the model
 * something. Deliberately does NOT suggest the two guard-backed categories — proposing
 * `external` or `destroys-user-data` to a model that just failed one of them is an invitation
 * to relabel rather than reconsider, which is the theatre this file exists to prevent.
 */
const REMAINING_REASONS = "content (a user's own document, draft or row) or dead-end (you already operated something equivalent)";

/**
 * Verify a dismissal claim against the observation, so the category has to be earned.
 *
 * `web` selects the web verb sets, as everywhere else — a bare "Confirm" is an externality on
 * a website and ordinary navigation in a desktop app.
 *
 * Unverifiable is not the same as false. `content` and `dead-end` rest on judgements the
 * harness cannot make (is this row the user's data? did you already try an equivalent?), so
 * they pass — the point is to remove the ONE category that was doing the damage, not to
 * pretend every claim is machine-checkable.
 */
export function checkDismissal(
	reason: DismissReason,
	targets: InteractiveElement[],
	obs: ObservationBundle,
	opts: { web?: boolean; cohortSize?: (e: InteractiveElement) => number } = {},
): DismissCheck {
	const web = Boolean(opts.web);
	if (reason === "external") {
		// The guard reads labels; if none of these would trip it, the claim is decoration.
		const hit = targets.some((t) => externalityTarget({ name: "click", element_index: t.handle }, obs, web));
		if (!hit)
			return {
				refusal:
					`None of those labels commits off the machine, so "external" does not apply. ` +
					`If operating one would merely change something, that is not a reason to skip it — settings are reverted automatically after the pass. ` +
					`If these genuinely should be skipped, the categories still open are ${REMAINING_REASONS}.`,
			};

		return {};
	}
	if (reason === "destroys-user-data") {
		const hit = targets.some((t) => reversibleTarget({ name: "click", element_index: t.handle }, obs, web) || externalityTarget({ name: "click", element_index: t.handle }, obs, web));
		if (!hit)
			return {
				refusal:
					`Nothing in those labels deletes, removes or overwrites anything, so "destroys-user-data" does not apply. ` +
					`Creating something new is not destroying anything — press it, claim the result, and explore what opens. ` +
					`If these genuinely should be skipped, the categories still open are ${REMAINING_REASONS}.`,
			};

		return {};
	}
	if (reason === "repetitive-value") {
		// A "repetitive" cohort of three is a panel of distinct controls with a convenient label.
		const biggest = Math.max(0, ...targets.map((t) => opts.cohortSize?.(t) ?? 0));
		if (biggest < REPETITIVE_MIN)
			return {
				refusal:
					`"repetitive-value" is for a large list of interchangeable values (${REPETITIVE_MIN}+ of the same kind on one surface); ` +
					`the largest group here has ${biggest}. These look like distinct controls — operate them, or skip them under ${REMAINING_REASONS}.`,
			};

		return {};
	}

	// content / dead-end: judgement the harness cannot check. Accepted, and published with the
	// map so a reader can disagree with it.
	return {};
}

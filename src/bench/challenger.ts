/**
 * The challenger pass: OpenAI is the default and runs the comprehensive matrix; Claude is
 * tested only against whatever configuration that pass found to win.
 *
 * The arms cannot be named in matrix.ts because they are not known until phase 2 is
 * collected — resolved from the manifest, the same way phase 3 resolves its compile source.
 *
 * THE DESIGN FLAW THIS COMPENSATES FOR. Finding the winner with the primary model and then
 * testing the challenger only there bakes in the primary's optimum. If the two models have
 * different optima — say the challenger is better in the huge ungrounded discovery space
 * while the primary's winner is grounded — testing only at the primary's best systematically
 * disadvantages the challenger, and "the challenger adds nothing" would be an artifact of the
 * config choice. So the slice is always TWO arms: the winner, and a DIVERGENCE arm (the
 * hardest configuration measured), where capability differences are most likely to show.
 *
 * SAMPLE SIZE. Few arms, so samples concentrate: n=6 rather than the matrix's n=3. At n=3
 * with a binary outcome only a landslide is visible; at n=6 the continuous measures (steps,
 * verified fraction, rejections, judge verdicts) can show a moderate difference. If the
 * result is still close, that IS the answer — "comparable, choose on cost and latency" — and
 * no affordable sample size would sharpen it.
 *
 * WHAT NOT TO COMPARE. Token counts are NOT comparable across these models: Claude 4.7 and
 * later use a tokenizer that produces roughly 30% more tokens for the same text, so a
 * cross-model token delta measures tokenizers as much as efficiency. Compare STEPS and
 * ACTIONS, which are tokenizer-independent. The report carries this caveat next to the
 * numbers rather than trusting a reader to remember it.
 */
import type { Arm } from "./matrix.js";
import { armById, phaseArms } from "./matrix.js";
import type { Manifest, ManifestEntry } from "./manifest.js";

/** Samples per challenger arm — see the header on why this is not the matrix's n=3. */
export const CHALLENGER_N = 6;

export interface ArmScore {
	armId: string;
	runs: number;
	successRate: number;
	meanSteps?: number;
}

const mean = (xs: number[]): number | undefined => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : undefined);

/** Score every phase-2 TASK arm from one model's collected runs. Arms with no runs are absent. */
export function scoreArms(m: Manifest, model: string | undefined): ArmScore[] {
	const out: ArmScore[] = [];
	for (const arm of phaseArms(2).filter((a) => a.kind === "task")) {
		const runs = m.entries.filter((e) => e.armId === arm.id && e.model === model && e.collected);
		if (!runs.length) continue;
		const steps = runs.map((e) => e.metrics?.steps).filter((n): n is number => typeof n === "number");
		out.push({
			armId: arm.id,
			runs: runs.length,
			successRate: runs.filter((e) => e.metrics?.success === true).length / runs.length,
			...(mean(steps) !== undefined ? { meanSteps: mean(steps) } : {}),
		});
	}

	return out;
}

export interface ChallengerPlan {
	winner: ArmScore;
	divergence: ArmScore;
	arms: Arm[];
	/** Why each was chosen, for the operator and for the report. */
	notes: string[];
}

/**
 * Resolve the slice. Winner = highest success rate, ties broken by FEWER mean steps (two arms
 * that both always succeed are separated by how much work it took). Divergence = lowest
 * success rate, ties broken by MORE mean steps — the configuration that strained the primary
 * model hardest, which is where a different model is most likely to behave differently.
 *
 * Returns undefined when phase 2 has not been collected for that model: guessing a winner
 * from no data would send the whole challenger budget at an arbitrary arm.
 */
export function planChallenger(m: Manifest, primaryModel: string | undefined): ChallengerPlan | undefined {
	const scores = scoreArms(m, primaryModel);
	if (scores.length < 2) return undefined;

	const byBest = [...scores].sort((a, b) => b.successRate - a.successRate || (a.meanSteps ?? Infinity) - (b.meanSteps ?? Infinity));
	const byWorst = [...scores].sort((a, b) => a.successRate - b.successRate || (b.meanSteps ?? 0) - (a.meanSteps ?? 0));
	const winner = byBest[0];
	// Never send both budgets at the same arm: if the best and worst coincide (every arm tied
	// on success AND steps), fall back to the second-best so the slice still spans two configs.
	const divergence = byWorst[0].armId === winner.armId ? byBest[byBest.length - 1] : byWorst[0];

	const arms = [winner, divergence].map((s) => armById(s.armId)).filter((a): a is Arm => a !== undefined);

	return {
		winner,
		divergence,
		arms,
		notes: [
			`winner: ${winner.armId} — ${Math.round(winner.successRate * 100)}% over ${winner.runs} runs${winner.meanSteps ? `, ${winner.meanSteps.toFixed(1)} steps mean` : ""}`,
			`divergence: ${divergence.armId} — ${Math.round(divergence.successRate * 100)}% over ${divergence.runs} runs${divergence.meanSteps ? `, ${divergence.meanSteps.toFixed(1)} steps mean` : ""}`,
			`n=${CHALLENGER_N} per arm (concentrated: two arms, not spread thin at n=3)`,
			"compare on STEPS and ACTIONS, never tokens — Claude 4.7+ tokenises ~30% higher for the same text",
		],
	};
}

/**
 * Does the slice need the challenger to run its own explore first?
 *
 * Only when one of the two arms consumes a map. Each model grounds ITSELF (David's fairness
 * rule: a model that gets to discover on its own is being measured on the same pipeline the
 * other one used), so the challenger cannot inherit the primary's appmap — and an ungrounded
 * or curated arm needs no map at all, which is worth checking rather than always paying for
 * an explore that would go unused.
 */
export function challengerNeedsExplore(plan: ChallengerPlan): Arm | undefined {
	const grounded = plan.arms.some((a) => !a.dispatch.noGrounding && !a.dispatch.useRecipe);
	if (!grounded) return undefined;
	// Match the explore to a grounded arm's backend: an ax arm needs the ax pass, and a
	// vision-only arm needs the vision pass, whose map is a different artifact entirely.
	const armNeeding = plan.arms.find((a) => !a.dispatch.noGrounding && !a.dispatch.useRecipe);
	if (armNeeding?.dispatch.noAx) return armById("explore-vision");

	return armById(`explore-${armNeeding?.dispatch.backend ?? "ax"}`);
}

/** Collected challenger entries for an arm, for the head-to-head table. */
export const challengerEntries = (m: Manifest, armId: string, model: string): ManifestEntry[] =>
	m.entries.filter((e) => e.armId === armId && e.model === model && e.collected);

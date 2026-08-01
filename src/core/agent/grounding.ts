import fs from "node:fs";
import { appmapVariant } from "../harness.js";
import { appmapsDir, recipesDir } from "../../paths.js";

export interface GroundingMeta {
	/**
	 * "none" | "explore" (autonomous exploration output) | "explore-vision" (screenshots-only
	 * exploration — declared, self-reported coverage) | "curated" (human-edited — a recipe
	 * tier, not measurable as grounding)
	 */
	provenance: "none" | "explore" | "explore-vision" | "curated";
	path?: string;
	notes?: string;
}

export function loadGrounding(slug: string, backend?: string): GroundingMeta {
	if (process.env.NO_GROUNDING) return { provenance: "none" }; // A/B measurement escape hatch

	// docs/appmaps/ holds ONLY explore.ts output (stamped with a provenance header);
	// docs/recipes/ holds hand-curated notes. Both ground the agent, but they are
	// different classes of input and the run log must say which one was used.
	// Backend-specific first, plain second. A map is not backend-portable — the ax and cdp
	// passes name the same surfaces differently, and a run resolves controls by name — but
	// legacy and hand-curated maps live under the plain slug and must keep working.
	const variant = appmapVariant();
	const candidates = [...(backend ? [`${appmapsDir()}/${slug}.${backend}${variant}.md`] : []), `${appmapsDir()}/${slug}${variant}.md`];
	const explorePath = candidates.find((c) => fs.existsSync(c)) ?? candidates[candidates.length - 1];
	const recipePath = `${recipesDir()}/${slug}.md`;
	const useRecipe = process.env.USE_RECIPE ? fs.existsSync(recipePath) : false;
	const path = useRecipe ? recipePath : fs.existsSync(explorePath) ? explorePath : undefined;
	if (!path) return { provenance: "none" };

	const notes = fs.readFileSync(path, "utf8");
	// Two stamps are acceptable, and each names its own provenance: "explore-vision" is
	// exploration output too, but its coverage tallies are declared rather than mechanical,
	// so filing it as plain "explore" would launder the weaker tier in every run log.
	const stamp = /^<!-- provenance: (explore(?:-vision)?)\b/.exec(notes);
	if (!useRecipe && !stamp)
		console.log(
			`WARNING: ${path} has no explore-provenance stamp — treating as curated. ` +
				"Regenerate it with npm run explore, or move it to docs/recipes/.",
		);

	return { provenance: useRecipe || !stamp ? "curated" : (stamp[1] as "explore" | "explore-vision"), path, notes };
}

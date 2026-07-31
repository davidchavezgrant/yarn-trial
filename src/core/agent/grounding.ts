import fs from "node:fs";
import { appmapsDir, recipesDir } from "../../paths.js";

export interface GroundingMeta {
	/** "none" | "explore" (autonomous exploration output) | "curated" (human-edited — a recipe tier, not measurable as grounding) */
	provenance: "none" | "explore" | "curated";
	path?: string;
	notes?: string;
}

export function loadGrounding(slug: string): GroundingMeta {
	if (process.env.NO_GROUNDING) return { provenance: "none" }; // A/B measurement escape hatch

	// docs/appmaps/ holds ONLY explore.ts output (stamped with a provenance header);
	// docs/recipes/ holds hand-curated notes. Both ground the agent, but they are
	// different classes of input and the run log must say which one was used.
	const explorePath = `${appmapsDir()}/${slug}.md`;
	const recipePath = `${recipesDir()}/${slug}.md`;
	const useRecipe = process.env.USE_RECIPE ? fs.existsSync(recipePath) : false;
	const path = useRecipe ? recipePath : fs.existsSync(explorePath) ? explorePath : undefined;
	if (!path) return { provenance: "none" };

	const notes = fs.readFileSync(path, "utf8");
	const stamped = /^<!-- provenance: explore\b/.test(notes);
	if (!useRecipe && !stamped)
		console.log(
			`WARNING: ${path} has no explore-provenance stamp — treating as curated. ` +
				"Regenerate it with npm run explore, or move it to docs/recipes/.",
		);

	return { provenance: useRecipe || !stamped ? "curated" : "explore", path, notes };
}

import fs from "node:fs";
import { refuseRetiredEnv } from "../../env.js";
import { appmapAxdom, appmapVariant } from "../harness.js";
import { appmapsDir, curatedDir, recipesDir } from "../../paths.js";
import { recipeFileFor } from "../recipe.js";

export interface GroundingMeta {
	/**
	 * "none" | "explore" (autonomous exploration output) | "explore-vision" (screenshots-only
	 * exploration — declared, self-reported coverage) | "curated" (human-edited prose, not
	 * measurable as grounding) | "recipe" (prose harvested from a judged-PASS run of THIS
	 * task — machine output like explore, but task-level rather than topological, and derived
	 * from a previous agent's success rather than from a sweep)
	 *
	 * Both "curated" and "recipe" are recipes — prose an agent reads. The value names the ORIGIN,
	 * which is the only part that bears on whether a result is measurable: a human wrote one, an
	 * earlier run wrote the other. Runs before 2026-08-03 recorded the harvested tier as
	 * "procedure", when that word meant prose; the dataset was rewritten with the rename.
	 */
	provenance: "none" | "explore" | "explore-vision" | "curated" | "recipe";
	path?: string;
	notes?: string;
}

export function loadGrounding(slug: string, backend?: string, task?: string): GroundingMeta {
	// Before NO_GROUNDING, because a retired tier name must not be answered with a clean
	// ungrounded run either — every path out of here has to be a name that is actually read.
	refuseRetiredEnv();
	if (process.env.NO_GROUNDING) return { provenance: "none" }; // A/B measurement escape hatch

	// docs/appmaps/ holds ONLY explore.ts output (stamped with a provenance header);
	// docs/curated/ holds hand-written notes. Both ground the agent, but they are
	// different classes of input and the run log must say which one was used.
	// Backend-specific first, plain second. A map is not backend-portable — the ax and cdp
	// passes name the same surfaces differently, and a run resolves controls by name — but
	// legacy and hand-curated maps live under the plain slug and must keep working.
	// Both axes, in the order the writer assembles them: backend, then sidecar, then tier.
	const variant = `${appmapAxdom()}${appmapVariant()}`;
	const candidates = [...(backend ? [`${appmapsDir()}/${slug}.${backend}${variant}.md`] : []), `${appmapsDir()}/${slug}${variant}.md`];
	const explorePath = candidates.find((c) => fs.existsSync(c)) ?? candidates[candidates.length - 1];
	/**
	 * Taking the plain slug when a BACKEND-specific one was asked for is legitimate (legacy and
	 * hand-curated maps live there) and silent — which is how it becomes a footgun.
	 *
	 * The default backends differ between the two commands: `explore` defaults an app target to
	 * ax, because it has no cdp→ax fallback and would hard-fail on a native app; the task agent
	 * defaults to cdp, because it does. So the README's own sequence — `./run explore "Yarn"`
	 * then `./run "<task>" "Yarn"` — writes `yarn.ax.*` and then looks for `yarn.cdp.*`, lands
	 * here, and grounds the run on whatever stale plain-slug map happens to be on disk. Maps are
	 * NOT backend-portable: ax and cdp name the same surface `editor` and `draft-editor`, and a
	 * grounded run resolves controls by name.
	 */
	if (backend && explorePath !== candidates[0] && fs.existsSync(explorePath))
		console.log(
			`WARNING: no ${backend} appmap for ${slug} — grounding on ${explorePath.split("/").pop()}, which a different backend wrote. ` +
				`Surface and control names are not portable across backends; run \`./run explore "<app>" --backend ${backend}\` for a matching map.`,
		);
	const curatedPath = `${curatedDir()}/${slug}.md`;
	const useCurated = process.env.USE_CURATED ? fs.existsSync(curatedPath) : false;

	// The recipe tier: task-level knowledge harvested from a judged-PASS run of THIS task.
	// Keyed by (app, task) rather than by app alone, so a recipe for a different task on the
	// same app is never found — the whole point is that it describes one goal's route.
	//
	// A REPLACEMENT for the appmap, not an addition, matching USE_CURATED. That is what makes the
	// arm answer the question worth asking: can an agent's own written-up success stand in for
	// the 40-minute exploration pass? Stacking both would measure neither.
	// RECIPE_LINEAGE selects WHICH experiment's recipe to load, mirroring APPMAP_VARIANT.
	// Default "grounded"; "ungrounded" is the arm asking for a write-up by an agent that had no
	// map — the only version of this that can speak to replacing the exploration pass.
	const lineage = process.env.RECIPE_LINEAGE === "ungrounded" ? "ungrounded" : "grounded";
	const recipePath = task ? recipeFileFor(recipesDir(), slug, task, backend, lineage) : undefined;
	const useRecipe = process.env.USE_RECIPES && recipePath ? fs.existsSync(recipePath) : false;
	// A tier that was ASKED for and is not on disk must be loud. The silent fallback to the
	// appmap is how a fleet Mac that never received the file runs a differently-grounded arm
	// while every log reads clean; collect's groundingChecked catches it, but only hours later
	// at collect time, after the run has already been paid for.
	if (process.env.USE_RECIPES && !useRecipe)
		console.log(`WARNING: USE_RECIPES is set but no recipe at ${recipePath ?? "<no task given>"} — falling back to the appmap tier.`);
	if (process.env.USE_CURATED && !useCurated) console.log(`WARNING: USE_CURATED is set but no curated notes at ${curatedPath} — falling back to the appmap tier.`);

	const path = useRecipe ? recipePath! : useCurated ? curatedPath : fs.existsSync(explorePath) ? explorePath : undefined;
	if (!path) return { provenance: "none" };

	const notes = fs.readFileSync(path, "utf8");
	// Two stamps are acceptable, and each names its own provenance: "explore-vision" is
	// exploration output too, but its coverage tallies are declared rather than mechanical,
	// so filing it as plain "explore" would launder the weaker tier in every run log.
	const stamp = /^<!-- provenance: (explore(?:-vision)?|recipe)\b/.exec(notes);
	if (!useCurated && !useRecipe && !stamp)
		console.log(
			`WARNING: ${path} has no explore-provenance stamp — treating as curated. ` +
				"Regenerate it with npm run explore, or move it to docs/curated/.",
		);

	// A recipe MUST carry its stamp: it is machine output, and an unstamped file at that path
	// is a human's note wearing a generated filename. Same rule the appmap has, same reason.
	if (useRecipe && !stamp) console.log(`WARNING: ${path} has no recipe-provenance stamp — treating as curated.`);

	return { provenance: useCurated || !stamp ? "curated" : (stamp[1] as "explore" | "explore-vision" | "recipe"), path, notes };
}

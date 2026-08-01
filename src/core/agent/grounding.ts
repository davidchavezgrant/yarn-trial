import fs from "node:fs";
import { appmapAxdom, appmapVariant } from "../harness.js";
import { appmapsDir, proceduresDir, recipesDir } from "../../paths.js";
import { procedureFileFor } from "../procedure.js";

export interface GroundingMeta {
	/**
	 * "none" | "explore" (autonomous exploration output) | "explore-vision" (screenshots-only
	 * exploration — declared, self-reported coverage) | "curated" (human-edited — a recipe
	 * tier, not measurable as grounding) | "procedure" (harvested from a judged-PASS run of THIS
	 * task — machine output like explore, but task-level rather than topological, and derived
	 * from a previous agent's success rather than from a sweep)
	 */
	provenance: "none" | "explore" | "explore-vision" | "curated" | "procedure";
	path?: string;
	notes?: string;
}

export function loadGrounding(slug: string, backend?: string, task?: string): GroundingMeta {
	if (process.env.NO_GROUNDING) return { provenance: "none" }; // A/B measurement escape hatch

	// docs/appmaps/ holds ONLY explore.ts output (stamped with a provenance header);
	// docs/recipes/ holds hand-curated notes. Both ground the agent, but they are
	// different classes of input and the run log must say which one was used.
	// Backend-specific first, plain second. A map is not backend-portable — the ax and cdp
	// passes name the same surfaces differently, and a run resolves controls by name — but
	// legacy and hand-curated maps live under the plain slug and must keep working.
	// Both axes, in the order the writer assembles them: backend, then sidecar, then tier.
	const variant = `${appmapAxdom()}${appmapVariant()}`;
	const candidates = [...(backend ? [`${appmapsDir()}/${slug}.${backend}${variant}.md`] : []), `${appmapsDir()}/${slug}${variant}.md`];
	const explorePath = candidates.find((c) => fs.existsSync(c)) ?? candidates[candidates.length - 1];
	const recipePath = `${recipesDir()}/${slug}.md`;
	const useRecipe = process.env.USE_RECIPE ? fs.existsSync(recipePath) : false;

	// The procedure tier: task-level knowledge harvested from a judged-PASS run of THIS task.
	// Keyed by (app, task) rather than by app alone, so a procedure for a different task on the
	// same app is never found — the whole point is that it describes one goal's route.
	//
	// A REPLACEMENT for the appmap, not an addition, matching USE_RECIPE. That is what makes the
	// arm answer the question worth asking: can an agent's own written-up success stand in for
	// the 40-minute exploration pass? Stacking both would measure neither.
	// PROCEDURE_LINEAGE selects WHICH experiment's procedure to load, mirroring APPMAP_VARIANT.
	// Default "grounded"; "ungrounded" is the arm asking for a write-up by an agent that had no
	// map — the only version of this that can speak to replacing the exploration pass.
	const lineage = process.env.PROCEDURE_LINEAGE === "ungrounded" ? "ungrounded" : "grounded";
	const procedurePath = task ? procedureFileFor(proceduresDir(), slug, task, backend, lineage) : undefined;
	const useProcedure = process.env.USE_PROCEDURES && procedurePath ? fs.existsSync(procedurePath) : false;
	// A tier that was ASKED for and is not on disk must be loud. The silent fallback to the
	// appmap is how a fleet Mac that never received the file runs a differently-grounded arm
	// while every log reads clean; collect's groundingChecked catches it, but only hours later
	// at collect time, after the run has already been paid for.
	if (process.env.USE_PROCEDURES && !useProcedure)
		console.log(`WARNING: USE_PROCEDURES is set but no procedure at ${procedurePath ?? "<no task given>"} — falling back to the appmap tier.`);
	if (process.env.USE_RECIPE && !useRecipe) console.log(`WARNING: USE_RECIPE is set but no curated notes at ${recipePath} — falling back to the appmap tier.`);

	const path = useProcedure ? procedurePath! : useRecipe ? recipePath : fs.existsSync(explorePath) ? explorePath : undefined;
	if (!path) return { provenance: "none" };

	const notes = fs.readFileSync(path, "utf8");
	// Two stamps are acceptable, and each names its own provenance: "explore-vision" is
	// exploration output too, but its coverage tallies are declared rather than mechanical,
	// so filing it as plain "explore" would launder the weaker tier in every run log.
	const stamp = /^<!-- provenance: (explore(?:-vision)?|procedure)\b/.exec(notes);
	if (!useRecipe && !useProcedure && !stamp)
		console.log(
			`WARNING: ${path} has no explore-provenance stamp — treating as curated. ` +
				"Regenerate it with npm run explore, or move it to docs/recipes/.",
		);

	// A procedure MUST carry its stamp: it is machine output, and an unstamped file at that path
	// is a human's note wearing a generated filename. Same rule the appmap has, same reason.
	if (useProcedure && !stamp) console.log(`WARNING: ${path} has no procedure-provenance stamp — treating as curated.`);

	return { provenance: useRecipe || !stamp ? "curated" : (stamp[1] as "explore" | "explore-vision" | "procedure"), path, notes };
}

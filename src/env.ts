/**
 * A numeric knob from the environment.
 *
 * `Number(process.env.X ?? d)` has two silent failure shapes, both observed risks with
 * real consequences here: `X=` (empty, e.g. from an unset shell variable interpolated into
 * a launchctl plist) makes it 0 — which for CLEANUP_STEPS disables teardown entirely — and
 * a typo like `X=ten` makes it NaN, which every `<` comparison answers false, so a step
 * budget of NaN means zero iterations, not unlimited. Neither says a word. `??` cannot
 * catch either case because the variable IS set, just not to a number.
 *
 * Unset or blank means the default. Anything else must parse, or the process dies at
 * import time with the variable's name — a knob wrong enough to be unparseable is a knob
 * the operator thinks is doing something, and the loud path is the honest one.
 */
export function envNum(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw === undefined || raw.trim() === "") return fallback;
	const n = Number(raw);
	if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got "${raw}"`);

	return n;
}

/**
 * Names retired by the 2026-08-03 recipe/procedure swap, mapped to what replaced them.
 *
 * The words changed meaning rather than disappearing: a PROCEDURE is now machine-readable steps
 * and a RECIPE is now prose, which is the reverse of what these four names assumed. So a stale
 * `USE_PROCEDURES=1` — typed from memory, or copied out of a plan written before the rename — is
 * not a typo that fails; it is a variable nothing reads, and the run quietly grounds on the appmap
 * tier instead. Clean logs, plausible numbers, wrong label. That exact shape has cost this project
 * a full benchmark pass more than once, so a retired name is fatal rather than ignored.
 */
const RETIRED_ENV: Record<string, string> = {
	USE_RECIPE: "USE_CURATED",
	USE_PROCEDURES: "USE_RECIPES",
	PROCEDURE_LINEAGE: "RECIPE_LINEAGE",
	RECIPE_RESCUE: "PROCEDURE_RESCUE",
	RECIPE_RESCUE_STEPS: "PROCEDURE_RESCUE_STEPS",
};

/** Throw if the environment sets a name the rename retired. Called wherever a tier is chosen. */
export function refuseRetiredEnv(env: NodeJS.ProcessEnv = process.env): void {
	const stale = Object.keys(RETIRED_ENV).filter((k) => env[k] !== undefined && env[k] !== "");
	if (!stale.length) return;

	throw new Error(
		`${stale.join(", ")} ${stale.length > 1 ? "were" : "was"} retired when "recipe" and "procedure" swapped meanings on 2026-08-03 ` +
			`(procedure = machine-readable steps, recipe = prose). Use ${stale.map((k) => `${k} -> ${RETIRED_ENV[k]}`).join(", ")}. ` +
			"Left unread, the old name would silently ground this run on the appmap tier under the wrong label.",
	);
}

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
 * and a RECIPE is now prose, which is the reverse of what every name below assumed. So a stale
 * `USE_PROCEDURES=1` — typed from memory, or copied out of a plan written before the rename — is
 * not a typo that fails; it is a variable nothing reads, and the run quietly grounds on the appmap
 * tier instead. Clean logs, plausible numbers, wrong label. That exact shape has cost this project
 * a full benchmark pass more than once, so a retired name is fatal rather than ignored.
 *
 * The test of membership is mechanical and worth restating, because two names were missed for
 * days: a name belongs here when SOMETHING READS ITS REPLACEMENT AND NOTHING READS IT. Both
 * halves matter. `RECIPE_SETTLE_MS` and `PROCEDURE_MODEL` were renamed with the swap and left out
 * of this map, so setting either did what an unset variable does — replay took the 900ms default
 * and a harvest ran on the default model — which is the same silence the map exists to break.
 *
 * The right-hand side must name something that IS READ, or the guard trades one silent no-op for
 * another. It said `RECIPE_RESCUE -> PROCEDURE_RESCUE`, and nothing anywhere reads
 * PROCEDURE_RESCUE (only a doc comment in src/core/replay.ts mentions it): an operator who obeyed
 * the error set a variable with no reader and rescue stayed on, which is worse than the original
 * mistake because the guard vouched for it. Rescue is disabled by the `--no-rescue` flag or by
 * supplying no model client, so the flag is what this points at. A knob was NOT invented to
 * match the old name — a per-invocation policy belongs on the command line, and inventing an env
 * reader to satisfy a migration message would be the tail wagging the dog.
 */
const RETIRED_ENV: Record<string, string> = {
	USE_RECIPE: "USE_CURATED",
	USE_PROCEDURES: "USE_RECIPES",
	PROCEDURE_LINEAGE: "RECIPE_LINEAGE",
	RECIPE_SETTLE_MS: "PROCEDURE_SETTLE_MS",
	PROCEDURE_MODEL: "RECIPE_MODEL",
	RECIPE_RESCUE: "the --no-rescue flag (no env var replaces it; PROCEDURE_RESCUE is read by nothing)",
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

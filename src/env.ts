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

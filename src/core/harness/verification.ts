import Anthropic from "@anthropic-ai/sdk";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import type { Expectation, StepRecord } from "../../types.js";
import { retryTransient } from "./model.js";

/**
 * Did any named element move by roughly the distance a drag asked for?
 *
 * The third verification channel, and on a canvas the only one that is both structural and
 * quantitative. It exists because a drag on painted content is not necessarily invisible to
 * the accessibility tree: the dragged thing has no element, but content around it does, and
 * when the app re-lays-out that content its elements MOVE. Observed on one timeline — a
 * button's frame went -617 -> -540 on a drag, and back to -617 on undo.
 *
 * Stronger than the pixel channel, which only reports that some region changed colour: this
 * names WHICH element moved and by HOW FAR, and demands the distance match what was asked
 * for. Weaker than text, which says what a thing IS rather than where it sits.
 *
 * Nothing here is app-specific — it compares two observations' geometry and knows nothing
 * about what the elements are. The delta is a RATIO test rather than an equality one because
 * the two spaces differ (frames are logical points, drags are screenshot pixels) and the
 * scale factor is a display property; requiring only that the movement be proportional and
 * in the right direction avoids baking a display's scale into the harness.
 */
export function framesShifted(
	before: Map<string, { x: number; y: number }>,
	after: Map<string, { x: number; y: number }>,
	dragDx: number,
	dragDy: number,
): { shifted: boolean; movers: Array<{ name: string; dx: number; dy: number }> } {
	// Below this a drag is not asking for meaningful movement, and every ratio blows up.
	if (Math.abs(dragDx) < 8 && Math.abs(dragDy) < 8) return { shifted: false, movers: [] };

	const movers: Array<{ name: string; dx: number; dy: number }> = [];
	for (const [name, a] of before) {
		const b = after.get(name);
		// NaN marks a name that collided across siblings, so identity is not established.
		if (!b || Number.isNaN(a.x) || Number.isNaN(b.x)) continue;
		const dx = b.x - a.x, dy = b.y - a.y;
		if (dx === 0 && dy === 0) continue;
		// Proportional to the request, in the same direction, within a wide band: a real
		// re-layout moves content by the drag delta scaled to logical points, while an
		// unrelated repaint or a scroll moves things by an unrelated amount.
		const wanted = Math.hypot(dragDx, dragDy), got = Math.hypot(dx, dy);
		const sameDirection = dragDx * dx + dragDy * dy > 0;
		const ratio = got / wanted;
		// Inclusive of 0.5 with margin: frames are logical points and drags are screenshot
		// pixels, so at 2x backing scale — the common macOS case — an honest mover sits at
		// EXACTLY half the requested distance, and a strict > 0.5 rejected it, silently
		// killing this channel on that display class.
		if (sameDirection && ratio >= 0.45 && ratio < 1.6) movers.push({ name, dx, dy });
	}

	return { shifted: movers.length > 0, movers };
}

/**
 * Fraction of pixels that differ between two screenshots, 0..1, or undefined if the
 * comparison could not be made (missing file, size mismatch, no python/PIL).
 *
 * Why this exists: verify() greps AX labels and values, and rendered content is not in
 * that channel — measured on Yarn, the Library shows ~12 video thumbnails while the AX
 * tree reports one 20x20 image among 377 elements. So "the preview never re-rendered" is
 * invisible to text verification. This is the cheap, deterministic half of the fix: no
 * model call, just "did the pixels move".
 *
 * Deliberately a signal, not a gate — it is recorded per step and never fails a run on its
 * own. Legitimate actions can change nothing visible (a wait, an off-screen scroll), and
 * animation/carets can change pixels when nothing meaningful happened, so a threshold here
 * would produce confident wrong verdicts in both directions.
 */
export function pixelDelta(beforePath: string, afterPath: string): number | undefined {
	if (!fs.existsSync(beforePath) || !fs.existsSync(afterPath)) return undefined;

	const script = `
import sys
from PIL import Image, ImageChops
a = Image.open(sys.argv[1]).convert("RGB")
b = Image.open(sys.argv[2]).convert("RGB")
if a.size != b.size:
    print("SIZE_MISMATCH"); sys.exit(0)
# Downscale before diffing: 8x fewer pixels, and it suppresses single-pixel AA noise
# that would otherwise register as change on a static screen.
w, h = max(1, a.width // 8), max(1, a.height // 8)
a = a.resize((w, h)); b = b.resize((w, h))
diff = ImageChops.difference(a, b).convert("L")
changed = sum(1 for p in diff.getdata() if p > 12)
print(changed / float(w * h))
`;
	try {
		// -W ignore: Pillow deprecates getdata() with a warning PER CALL, and this runs every
		// step — the GUI console was mostly Pillow telling us about 2027. The replacement API
		// does not exist on older Pillows, so suppression beats migration here.
		const out = execFileSync("python3", ["-W", "ignore::DeprecationWarning", "-c", script, beforePath, afterPath], { encoding: "utf8" }).trim();
		if (out === "SIZE_MISMATCH") return undefined;
		const v = Number(out);

		return Number.isFinite(v) ? v : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Did a drag move something from where it was pressed to where it was released?
 *
 * The only evidence available on a painted target: it has no label to grep, so text
 * verification has nothing to work with. The test is deliberately about GEOMETRY, not
 * appearance — crop the neighbourhood of each endpoint and compare it against itself
 * before and after. A thing that moved vacates its origin and arrives at its destination,
 * whatever colour or shape it is. Nothing here knows what is being dragged.
 *
 * Both ends must change. One end alone is the common false positive: a canvas that draws an
 * indicator wherever you press lights up the origin on every drag, including one that
 * grabbed nothing.
 *
 * What it cannot do, and no amount of tuning will fix: say the thing landed in the RIGHT
 * place. That is why the channel is named in the result and why done(success) refuses it.
 */
export function dragMoved(
	beforePath: string,
	afterPath: string,
	from: { x: number; y: number },
	to: { x: number; y: number },
	radius = 14,
): { moved: boolean; origin?: number; dest?: number } {
	if (!fs.existsSync(beforePath) || !fs.existsSync(afterPath)) return { moved: false };

	const script = `
import sys
from PIL import Image, ImageChops
a = Image.open(sys.argv[1]).convert("RGB")
b = Image.open(sys.argv[2]).convert("RGB")
if a.size != b.size:
    print("SIZE_MISMATCH"); sys.exit(0)
r = int(sys.argv[6])
def frac(cx, cy):
    box = (max(0, cx - r), max(0, cy - r), min(a.width, cx + r), min(a.height, cy + r))
    if box[2] <= box[0] or box[3] <= box[1]: return 0.0
    d = ImageChops.difference(a.crop(box), b.crop(box)).convert("L").getdata()
    return sum(1 for p in d if p > 12) / float(len(d))
print(frac(int(sys.argv[3]), int(sys.argv[4])), frac(int(sys.argv[5]), int(sys.argv[4] if len(sys.argv) < 8 else sys.argv[7])))
`;
	try {
		const out = execFileSync(
			"python3",
			["-W", "ignore::DeprecationWarning", "-c", script, beforePath, afterPath, String(from.x), String(from.y), String(to.x), String(radius), String(to.y)],
			{ encoding: "utf8" },
		).trim();
		if (out === "SIZE_MISMATCH") return { moved: false };
		const [origin, dest] = out.split(/\s+/).map(Number);
		if (!Number.isFinite(origin) || !Number.isFinite(dest)) return { moved: false };
		// A tenth of a small crop is well clear of antialiasing while far below what an
		// arriving object produces (measured: 0.04-0.12 for a real move, 0 for inert canvas).
		const MIN = 0.02;

		return { moved: origin > MIN && dest > MIN, origin, dest };
	} catch {
		return { moved: false };
	}
}

export interface VisualVerdict {
	verdict: "PASS" | "FAIL" | "UNPROVEN";
	scope: string;
	why: string;
}

/**
 * Independent visual check of the FINAL state, used only at the done boundary.
 *
 * This is a SEPARATE model call from the acting agent, deliberately: this whole harness's
 * verification layer was rebuilt because a model was grading its own work, and a judge that
 * shares the actor's context inherits its rationalisations. The judge sees the goal and one
 * screenshot — not the action history, not the actor's summary.
 *
 * It exists because substring evidence proves *a* control reads the target value, never that
 * it is the *intended* control. Measured on the two real scope screenshots (both showing
 * Cursor Style = Pointer-first, one brand-wide and one per-draft): the judge passed the brand
 * frame and failed the per-draft one, citing the missing Brand Kit surface — the exact
 * failure that shipped four times under text-only checking.
 *
 * Advisory by default: its verdict is recorded and printed, and only blocks a success claim
 * under VISUAL_JUDGE=block. A confident wrong FAIL would stall a correct run, and a confident
 * wrong PASS is precisely the failure we are trying to remove, so it adds a gate rather than
 * replacing the deterministic text check.
 */
export async function visualJudge(
	client: Anthropic,
	model: string,
	goal: string,
	screenshotB64: string,
	claim?: string,
): Promise<VisualVerdict | undefined> {
	try {
		// retryTransient like every other model call in the run path: the catch below turns
		// an unreachable judge into `undefined`, and under VISUAL_JUDGE=block a missing
		// verdict waves the success claim through — a transient 429/529 degraded the gate to
		// "off" exactly when the operator opted into "block".
		const r = await retryTransient(() =>
			client.messages.create({
			model,
			// 700 was not enough: the model spends output tokens on reasoning before it writes
			// the verdict, and on a busy frame with a long claim it hit the cap having emitted
			// a thinking block and no text at all — stop_reason "max_tokens", zero text blocks.
			// The judge then looked "unavailable" on exactly the runs hardest to judge, which
			// is the worst possible direction for the bias to run.
			max_tokens: 2000,
			system:
				"You are an independent verifier for a UI automation run. You did NOT perform the actions and " +
				"have no stake in them succeeding; your job is to be hard to fool. You are given a goal and a " +
				"screenshot of the FINAL state. Decide whether the screenshot proves the goal was achieved.\n\n" +
				"Be strict about WHICH control shows the value. Many apps expose the same setting at more than " +
				"one scope (an app/brand-wide default vs a per-document override). A screenshot showing the " +
				"right value in the WRONG scope does NOT prove the goal.\n\n" +
				"Use UNPROVEN when the frame simply does not show the relevant surface — that is different from " +
				"FAIL, which means the frame shows the goal was NOT achieved.\n\n" +
				"Judge the AGENT'S CLAIM, not merely the task wording. A task may be vaguely phrased " +
				"(\"show me how to change X\"), but the agent states what it actually did; your job is to " +
				"decide whether the frame supports THAT. In particular, if the agent claims it changed a " +
				"global/brand-wide default, a frame showing only a per-document override panel is a FAIL — " +
				"do not accept \"the control is visible here\" as proof that the claimed change was made.\n\n" +
				"Reply exactly:\nVERDICT: PASS | FAIL | UNPROVEN\nSCOPE: which surface/scope the value is shown at\nWHY: one or two sentences",
			messages: [
				{
					role: "user",
					content: [
						{
						type: "text",
						text: `Task given to the agent: ${goal}` + (claim ? `\n\nWhat the agent claims it did: ${claim}` : "") + "\n\nFinal-state screenshot follows.",
					},
						{ type: "image", source: { type: "base64", media_type: "image/png", data: screenshotB64 } },
					],
				},
			],
		}),
		);
		const text = r.content
			.filter((b): b is Anthropic.TextBlock => b.type === "text")
			.map((b) => b.text)
			.join("\n");
		const verdict = /VERDICT:\s*(PASS|FAIL|UNPROVEN)/i.exec(text)?.[1]?.toUpperCase();
		// Say so. A judge that returns nothing used to do it silently, which made a missing
		// gate indistinguishable from a passing one in both the console and the run log —
		// and it went missing on a canvas run, where it is the only check on whether the
		// thing that moved was the thing we meant to move.
		if (!verdict) {
			const why = r.stop_reason === "max_tokens" ? "ran out of output tokens before writing one" : text.slice(0, 200).replace(/\s+/g, " ");
			console.log(`visual judge returned no parseable verdict: ${why}`);

			return undefined;
		}

		return {
			verdict: verdict as VisualVerdict["verdict"],
			scope: /SCOPE:\s*(.+)/i.exec(text)?.[1]?.trim() ?? "",
			why: /WHY:\s*([\s\S]+)/i.exec(text)?.[1]?.trim().slice(0, 400) ?? "",
		};
	} catch (err) {
		// Never fail a run because the judge was unreachable; it is an added gate.
		console.log(`visual judge unavailable: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`);

		return undefined;
	}
}

/**
 * Which evidence proved a step, and therefore how much the step is worth.
 *
 * - "text" — a substring appeared or disappeared in the AX tree. Discriminating and
 *   deterministic: it says WHAT changed.
 * - "geometry" — a NAMED element's frame moved by about the distance the drag asked for.
 *   Structural and quantitative: it says which element moved and how far, so it survives
 *   the objection that something merely repainted. Available whenever painted content sits
 *   near addressable content, which on a document surface is usual.
 * - "pixel" — the screen changed where the action was aimed, and did not change where it
 *   was not. The last resort, for painted regions with no neighbouring elements at all:
 *   it says SOMETHING moved, never that it moved somewhere correct.
 *
 * They are kept apart everywhere — in the result, in the step log, in the run summary —
 * because the whole risk with a canvas task is quoting the weak number as if it were the
 * strong one.
 */
export type VerifyChannel = "text" | "geometry" | "pixel";

export interface VerifyResult {
	verified: boolean;
	note: string;
	channel?: VerifyChannel;
}

/**
 * Check an expectation against the post-action observation text.
 *
 * Two ways to fail beyond a plain substring miss, both discovered by auditing real run
 * logs (2026-07-29):
 * - An expectation with no textIncludes/textExcludes used to pass vacuously — 2–6 steps
 *   per historical run were "verified" by an unfalsifiable prose description.
 * - A substring already on screen BEFORE the action passes the presence check while
 *   proving nothing about the action (e.g. text the agent itself typed two steps ago).
 *   When `prevHaystack` is supplied, at least one check must discriminate: an include
 *   absent before, or an exclude present before. Final-state checks (done) pass no
 *   prevHaystack — there the claim is about state, not change — and must therefore name
 *   text that should be PRESENT: with nothing before to compare against, an exclude alone
 *   is satisfied by any screen that never showed the string, so excludes-only evidence is
 *   rejected as unverifiable.
 */
/**
 * The non-blank strings in a model-supplied substring list, whatever actually arrived.
 *
 * Tool input is model output and OpenRouter does not enforce schemas, so `textIncludes` can
 * arrive as a number, a bare string, or an array with non-string entries. A malformed call
 * used to throw out of `.filter((t) => t.trim())` and abort an hours-long run; coercing here
 * makes it cost one turn instead — the empty result reads as "nothing checkable" downstream.
 */
const checkableStrings = (x: unknown): string[] =>
	Array.isArray(x) ? x.filter((t): t is string => typeof t === "string" && t.trim() !== "") : [];

/**
 * How many checkable substrings an expectation actually carries, blanks excluded.
 *
 * The gate that decides whether an act/done call is checkable at all must agree with
 * `verify()` about what counts, or a `textIncludes: [""]` passes the gate ("length 1") and is
 * then silently dropped by verify — the two disagreeing is exactly how the blank-substring
 * bypass slipped through. Both call this.
 */
export function checkableCount(expectation: Expectation | undefined): number {
	if (!expectation) return 0;

	return checkableStrings(expectation.textIncludes).length + checkableStrings(expectation.textExcludes).length;
}

export function verify(expectation: Expectation, haystack: string, prevHaystack?: string): VerifyResult {
	// Blank and whitespace-only substrings are dropped before anything else, because every
	// string contains "" and every rendered observation contains a space: an include of "" or
	// " " passes the presence check against ANY screen. On the done path there is no
	// prevHaystack, so the discrimination guard below never runs to catch it either — which
	// made `done(success, evidence: {textIncludes: [""]})` accepted against any final
	// observation, and `wait` + `textIncludes: [""]` a free "verified" step. A check the whole
	// screen satisfies is not a check; strip these, then treat "nothing left to check" exactly
	// as an empty expectation.
	const includes = checkableStrings(expectation.textIncludes);
	const excludes = checkableStrings(expectation.textExcludes);
	if (includes.length === 0 && excludes.length === 0)
		return { verified: false, note: "no checkable expectation (non-empty textIncludes/textExcludes)" };

	const missing = includes.filter((t) => !haystack.includes(t.toLowerCase()));
	const present = excludes.filter((t) => haystack.includes(t.toLowerCase()));
	if (missing.length || present.length) {
		const parts: string[] = [];
		if (missing.length) parts.push(`expected but not found: ${missing.join(", ")}`);
		if (present.length) parts.push(`expected absent but found: ${present.join(", ")}`);

		return { verified: false, note: parts.join("; ") };
	}

	// The excludes-only twin of the blank-substring hole above, caught at the point it would
	// otherwise PASS: with no prevHaystack the discrimination guard below never runs, so an
	// exclude naming a string that was never on ANY screen verifies against every final
	// observation. Against a prior haystack an exclude can discriminate (present before, gone
	// now); against a single final observation it cannot prove anything. An exclude that is
	// genuinely present still fails above with the note that says what was found.
	if (prevHaystack === undefined && includes.length === 0)
		return {
			verified: false,
			note: "excludes-only evidence cannot prove a final state — name text that should be PRESENT",
		};

	if (prevHaystack !== undefined) {
		const discriminating =
			includes.some((t) => !prevHaystack.includes(t.toLowerCase())) ||
			excludes.some((t) => prevHaystack.includes(t.toLowerCase()));
		if (!discriminating)
			return {
				verified: false,
				note:
					"expectation met, but every check was ALREADY satisfied before the action — no evidence " +
					"the action changed anything; expect substrings that appear or disappear as a RESULT of it",
			};
	}

	return { verified: true, note: "expectation met", channel: "text" };
}

/**
 * Task prompts must state the GOAL only. Method knowledge — which control to click, what
 * key to press, which driver call to use — belongs in the appmap (a declared, measurable
 * input), never in the task text, where it silently inflates results and makes a run look
 * autonomous when it was dictated. See docs/research/2026-07-29-prompt-hygiene.md.
 *
 * Detection is deliberately narrow and high-precision: driver/AX vocabulary, and
 * interaction-mechanic verbs (click/press/keystroke), which describe HOW to act rather
 * than WHAT to achieve. Outcome verbs ("create a draft", "set the voice", "open the
 * Script tab") are legitimate task specification and do not trip it.
 */
// `i` flag: a hinted prompt written with capitalised snake_case tool names ("Set_Value") is
// still a hinted prompt. AX role names are NOT in here: under /i an ax- prefix swallowed
// ordinary words — "axis", "axes", "axiom" — and hard-refused goal-only prompts a video tool
// will genuinely see. They get their own case-sensitive pattern below.
const DRIVER_VOCAB = /\b(set_value|type_text|press_key|right_click|double_click|element_index|delivery_mode|axpress)\b/gi;
// Real AX role names carry their case (AXButton, AXTextField): matching AX-then-letter
// case-sensitively keeps them flagged without reading "axis" as a driver internal.
const AX_ROLE = /\bAX[A-Za-z]\w*\b/g;
// Every verb bounded on BOTH sides, so "clickable" and "pressure" no longer read as method
// hints and refuse a legitimate goal-only prompt. These are the AMBIGUOUS mechanics — one may
// be incidental ("...the Save button"), so the threshold is two.
const MECHANIC_VERBS = /\b(?:click(?:s|ing|ed)?|right[- ]click\w*|double[- ]click\w*|press(?:es|ing|ed)?|keystroke\w*|select all|scroll\w*|hover\w*|drag\w*)\b/gi;
// A named keystroke is a pure method hint with no innocent reading, so ONE is enough — like a
// coordinate. The cmd glyph lives here rather than in MECHANIC_VERBS because `⌘` is a non-word
// character: a leading `\b` can never precede it, so inside the bounded group it was dead and
// a prompt handing over "⌘+," slipped through with zero hits.
const KEYSTROKE_HINT = /(?:cmd|ctrl|control|option|opt|alt|shift)\s*\+|⌘|⌥|⌃|⇧/gi;
/**
 * Screen coordinates, which arrived as a hint vector the moment painted targets became
 * actionable. A coordinate is the purest possible method hint: deriving it from the pixels
 * is the entire task on a canvas, so handing it over skips the only hard part. One is enough
 * to fail the prompt — unlike mechanic verbs, there is no innocent reading of "x=940".
 *
 * Both spellings the hint actually takes: an axis assignment, and a pair introduced by a
 * preposition. The pair requires that preposition so a bare "1080, 720" — a resolution, a
 * legitimate goal — does not trip it.
 */
const COORD_HINT = /\b[xy]\s*[=:]\s*-?\d+|\b(?:at|to|from)\s+\(?\s*\d{2,4}\s*,\s*\d{2,4}\s*\)?/gi;

export interface PromptAudit {
	hinted: boolean;
	reasons: string[];
}

export function auditTaskPrompt(task: string): PromptAudit {
	const reasons: string[] = [];
	const vocab = [...new Set([...(task.match(DRIVER_VOCAB) ?? []), ...(task.match(AX_ROLE) ?? [])].map((m) => m.toLowerCase()))];
	// OCCURRENCES, not unique spellings. A dictated click-path — "click Brand Kit, click
	// Screen Clips, click Cursor Style" — is four hints that all spell "click", and deduping
	// them to one collapsed a complete method recipe below the ≥2 threshold and passed it as
	// goal-only. The threshold still allows ONE incidental mechanic verb ("...the Save
	// button"); two or more describe HOW rather than WHAT.
	const mechanicHits = (task.match(MECHANIC_VERBS) ?? []).map((m) => m.toLowerCase());
	const mechanics = [...new Set(mechanicHits)];
	if (vocab.length > 0) reasons.push(`names driver/AX internals: ${vocab.join(", ")}`);
	if (mechanicHits.length >= 2) reasons.push(`describes interaction mechanics, not just the goal: ${mechanics.join(", ")}`);
	const keys = [...new Set((task.match(KEYSTROKE_HINT) ?? []).map((m) => m.toLowerCase().replace(/\s+/g, "")))];
	if (keys.length > 0) reasons.push(`names a keystroke, which is a method not a goal: ${keys.join(", ")}`);
	const coords = [...new Set(task.match(COORD_HINT) ?? [])];
	if (coords.length > 0) reasons.push(`gives screen coordinates, which the agent must derive itself: ${coords.join(", ")}`);

	return { hinted: reasons.length > 0, reasons };
}

/**
 * Verified-step tallies for a run log, split by evidence channel and never summed into one
 * number: a pixel step proves something moved where the action was aimed, a text step proves
 * WHAT changed. Reporting "8/8 verified" over a run carried by pixels would overstate it by
 * exactly the distinction the verification layers exist to keep.
 *
 * Shared so that every exit path — done() and the step limit alike — reports the same shape.
 */
export function verificationTallies(steps: StepRecord[]): {
	verifiedSteps: number;
	unverifiedSteps: number;
	verifiedByChannel: { text: number; geometry: number; pixel: number };
} {
	const unverified = steps.filter((s) => !s.verified).length;

	return {
		verifiedSteps: steps.length - unverified,
		unverifiedSteps: unverified,
		verifiedByChannel: {
			text: steps.filter((s) => s.verificationChannel === "text").length,
			geometry: steps.filter((s) => s.verificationChannel === "geometry").length,
			pixel: steps.filter((s) => s.verificationChannel === "pixel").length,
		},
	};
}

/** Below this fraction of pixels changed, a frame is treated as not having repainted. */
export const REPAINT_EPSILON = 0.001;

/**
 * How many trailing steps produced no evidence of a live app: nothing verified, nothing
 * repainted. `unpainted` because it counts the absence of a repaint, not a failure.
 *
 * A suspended Chromium window (off the active Space, or minimized) keeps answering AX
 * calls with its last tree, so nothing else in the loop notices it went dark: the agent
 * acts, verify() greps a stale-but-valid haystack, and the recorder saves the same frame
 * a few hundred times. Two Notion Calendar runs burned ~5 minutes each that way and
 * assembled a 247-identical-frame mp4.
 *
 * The pixel channel had already seen it — every step read 0.0% — but nothing consumed it.
 * A verified step proves the app is alive and clears the streak, and an unknown delta
 * (vision off, no prior frame) is not evidence either way, so it clears the streak too.
 *
 * Reporting only: the caller prints it and keeps going. It aborted runs for a day and had
 * to stop, because an app with an embedded agent produces the same signature while waiting
 * out a multi-minute think — see FROZEN_STEPS in agent.ts.
 */
export function unpaintedStreak(steps: StepRecord[]): number {
	let n = 0;
	for (let i = steps.length - 1; i >= 0; i--) {
		const s = steps[i];
		if (s.verified || s.pixelDelta === undefined || s.pixelDelta >= REPAINT_EPSILON) break;
		n++;
	}

	return n;
}

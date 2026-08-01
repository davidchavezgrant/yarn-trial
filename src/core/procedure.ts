/**
 * Procedures — task-level knowledge an agent writes for the agents that come after it.
 *
 * The gap this fills. An appmap is a MAP: it says the Cursor Style control lives at Brand Kit →
 * Screen Clips, and that the same setting also exists at document scope. It never says which
 * route to take, in what order, or that the change has to be committed before it survives a
 * panel close. A compiled recipe has all of that and is unusable as knowledge: it is a frozen
 * click sequence resolved by exact (name, surface, role), so it replays one task with one set of
 * values and errors out on anything adjacent. Between them sits the thing a human would actually
 * write down after doing something for the first time, and nothing produced it.
 *
 * HARVESTING IS OFFLINE, and that is the load-bearing design decision.
 *
 * Writing the procedure at `done()` would have been simpler and is wrong twice over. It adds a
 * model call to every successful run, so the tokens, cost and latency of every measured run
 * would include the harvest — polluting exactly the numbers phase 1 and 2 exist to produce. And
 * the offline judge's verdict does not exist yet at `done` time, so the only available quality
 * gate would be the agent's own claim about its own success. That gate is known to fail in the
 * one way that matters most here: all four ungrounded runs of the Yarn cursor task accurately
 * described what they had done, and what they had done was change a per-document override
 * instead of the brand default. A procedure harvested from one of those would teach every future
 * run to make the same mistake, and it would present as grounding getting better.
 *
 * So: harvest reads a COMPLETED run plus its judge verdict, and refuses anything the judge did
 * not pass. See `harvestRefusal` for the full set of refusals — each one is a specific way a
 * procedure could confidently lie.
 */
import fs from "node:fs";
import path from "node:path";
import { proceduresDir } from "../paths.js";
import { taskHash } from "./recipe.js";

export class ProcedureError extends Error {}

/** What the harvest reads. Structural, so it can be fed a run log without importing its shape. */
export interface HarvestSource {
	task?: string;
	app?: string;
	success?: boolean;
	backend?: string;
	hintedPrompt?: boolean;
	grounding?: { provenance?: string };
	steps?: Array<{
		index?: number;
		targetName?: string;
		targetRole?: string;
		targetSurface?: string;
		action?: unknown;
		verified?: boolean;
		verificationChannel?: string;
		expectation?: unknown;
	}>;
	finalCheck?: { evidence?: unknown };
}

/** The judge artifact, read only for its verdict. */
export interface JudgeVerdict {
	trajectory?: string;
	scopeDisclosed?: string;
}

/**
 * Where a promoted procedure lives: keyed by (app, BACKEND, task).
 *
 * Task, because a procedure for "change the cursor type" must not be found by a run doing
 * "create a two-scene script" — `taskHash` is shared with recipe.ts rather than reimplemented,
 * so the two artifacts derived from one run always agree on which task it was.
 *
 * Backend, for the reason appmaps already carry it (matrix.ts): a map is not backend-portable —
 * the ax and cdp passes name the same surfaces and controls differently, and a procedure names
 * both. Without this axis `p6-ax-procedure` and `p6-cdp-procedure` resolve to ONE file, the
 * second promote overwrites the first, and one arm silently grounds on the other backend's
 * write-up. Nothing downstream would catch it: provenance reads "procedure" either way.
 */
export const procedureFileFor = (dir: string, slug: string, task: string, backend?: string): string =>
	path.join(dir, `${slug}${backend ? `.${backend}` : ""}.${taskHash(task)}.procedure.md`);

/**
 * Why this run may not become a procedure, or undefined if it may.
 *
 * Every refusal is a way the resulting prose would be confidently wrong, and they are checked
 * before the model call so a refused run costs nothing.
 */
export function harvestRefusal(run: HarvestSource, judge: JudgeVerdict | undefined): string | undefined {
	if (!run.success) return "run did not succeed — a procedure from it would document a route that does not work";
	if (run.hintedPrompt)
		// The same laundering `compileRecipe` refuses. A hinted run was TOLD its route; writing
		// that route down as something an agent discovered turns a measurement violation into a
		// permanent, reusable input.
		return "run was --hinted — its route was dictated, not discovered; re-run goal-only and harvest that";
	if (!judge) return "no judge verdict — run `./run judge <stamp>` first; a procedure is only as trustworthy as the grader that passed it";
	if ((judge.trajectory ?? "").toUpperCase() !== "PASS")
		// The wrong-scope class. An accurate description of the wrong action is precisely what
		// the offline judge exists to catch, and precisely what must not be written down.
		return `judge returned TRAJECTORY ${judge.trajectory ?? "UNKNOWN"} — only a judged-PASS run may become a procedure`;
	/**
	 * ANY verified channel counts, not just text — and the difference matters more than it looks.
	 *
	 * `compileRecipe` refuses pixel-verified steps, correctly, because a REPLAY has to re-check
	 * an expectation mechanically and "some pixels changed" is not re-checkable. Copying that
	 * gate here was wrong: a procedure is prose for a model, not a machine replay, and the steps
	 * it most needs to carry are sometimes exactly the ones no text channel can see.
	 *
	 * Canvas content is invisible to AX and to the DOM — that is why pixelDelta exists as a
	 * verification layer at all. A drag across Yarn's editor canvas, a handle dragged on a
	 * timeline, anything inside the NLE behind the template flow: real, necessary actions whose
	 * only evidence is that the right region repainted. Discarding them would refuse a
	 * judged-PASS canvas run outright, or — worse — harvest it with a silent hole where the
	 * canvas work went, producing a confident procedure that omits the part that was hard.
	 */
	const verified = (run.steps ?? []).filter((s) => s.verified);
	if (!verified.length) return "no verified steps — there is no observed route to describe";

	return undefined;
}

/** The verified route, as the harvest prompt sees it: one line per step, no model output yet. */
export function routeOf(run: HarvestSource): string {
	return (run.steps ?? [])
		.filter((s) => s.verified)
		.map((s, i) => {
			const act = s.action && typeof s.action === "object" ? ((s.action as { name?: string }).name ?? "act") : "act";
			const where = [s.targetName, s.targetSurface ? `on ${s.targetSurface}` : undefined, s.targetRole].filter(Boolean).join(" ");
			// The CHANNEL travels with the step, because the model needs to describe a pixel-only
			// step differently: there is no label to tell the next agent to look for, so the
			// procedure has to say where to act and what should visibly change. Text and geometry
			// steps carry their actual expectation, which is a checkable string.
			const evidence =
				s.verificationChannel === "pixel"
					? " [verified: PIXELS ONLY — the region repainted; this target has no text label (canvas/rendered content)]"
					: s.verificationChannel === "geometry"
						? " [verified: geometry — a named element moved about the distance asked for]"
						: s.expectation
							? ` [verified: ${JSON.stringify(s.expectation)}]`
							: "";

			return `${i + 1}. ${act}${where ? ` — ${where}` : ""}${evidence}`;
		})
		.join("\n");
}

export const HARVEST_SYSTEM = [
	"You are writing a short procedure for the next agent that has to do this task in this app.",
	"",
	"You are given a task, and the VERIFIED route a previous agent actually took — every step in it",
	"was confirmed against the app's accessibility tree, and an independent judge confirmed the run",
	"achieved the task. This is what happened, not what someone intended.",
	"",
	"Write the procedure as markdown. Rules:",
	"- Describe the ROUTE: which surfaces to open, in order, and what to click on each.",
	"- Generalise one notch. If the run set a value, say where the value is set and note the one used;",
	"  the next agent may be asked for a different value on the same control.",
	"- Name the scope explicitly when the app has more than one place to change a thing (a brand-wide",
	"  default versus a per-document override are different settings, and picking the wrong one is the",
	"  single most common way this goes wrong).",
	"- Say what CONFIRMS success — the text that appears, the control that now reads the new value.",
	"- A step marked PIXELS ONLY acted on canvas or rendered content, which has no accessibility label",
	"  and no DOM node. Describe it by WHERE on the surface it happened and what should visibly change;",
	"  do not invent a control name for it, and do not drop it — those steps are often the hard part.",
	"- Include commit steps (Save/Apply/Done) and anything that had to happen before the change stuck.",
	"",
	"Do NOT:",
	"- Invent steps that are not in the route. If the route is short, the procedure is short.",
	"- Include element indices or pixel coordinates — they are meaningless in the next session.",
	"- Editorialise about the agent, the run, or the harness. Write for someone about to do the task.",
	"",
	"Under 300 words. No preamble, no closing summary — start with the first step.",
].join("\n");

export const harvestPrompt = (run: HarvestSource): string =>
	[
		`App: ${run.app ?? "unknown"}`,
		`Task: ${run.task ?? "unknown"}`,
		`Backend: ${run.backend ?? "unknown"}`,
		"",
		"Verified route:",
		routeOf(run),
		...(run.finalCheck?.evidence ? ["", `Final goal evidence: ${JSON.stringify(run.finalCheck.evidence)}`] : []),
	].join("\n");

/**
 * The provenance header, mirroring the appmap's. Same purpose: a reader — human or
 * `loadGrounding` — can tell at a glance that this is machine output and which run produced it.
 * A procedure with no stamp is treated as curated, exactly as an unstamped appmap is.
 */
export const procedureHeader = (run: HarvestSource, stamp: string, judge: JudgeVerdict): string =>
	`<!-- provenance: procedure | app: ${run.app ?? "unknown"} | task: ${run.task ?? ""} | from: ${stamp} | judge: ${judge.trajectory ?? "?"} | backend: ${run.backend ?? "?"} -->\n\n`;

/** Write a harvested procedure to a path, creating the directory. Returns the path. */
export function writeProcedure(file: string, body: string): string {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, body.endsWith("\n") ? body : `${body}\n`);

	return file;
}

/** Where this run's procedure would be promoted to, once harvested. */
export const promotedPath = (run: HarvestSource, slug: string): string => procedureFileFor(proceduresDir(), slug, run.task ?? "", run.backend);

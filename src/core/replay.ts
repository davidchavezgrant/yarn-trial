import type { ModelClient } from "./harness.js";
import Anthropic from "@anthropic-ai/sdk";
import type { CdpBackend } from "../backends/cdp.js";
import type { Driver } from "./driver.js";
import { envNum } from "../env.js";
import {
	type ObservationBundle,
	settleMsFor,
	toActionRequest,
	verify,
	type WindowRef,
} from "./harness.js";
import { appendMutation, detectMutation } from "./journal.js";
import { armAction, needsTarget, type Procedure, type ProcedureStep, resolveTarget, substituteUnique } from "./procedure.js";
import type { AppMap, StepRecord } from "../types.js";

/**
 * Replay a compiled procedure: the deterministic loop, with the model demoted to exception
 * handler.
 *
 * The happy path makes NO model calls. Each step re-resolves its target by (name, surface,
 * role) against a fresh observation, acts, and runs the SAME `verify()` a live run is gated
 * by — the recorded expectation, checked against the fresh haystack with the pre-action
 * haystack as the discrimination baseline. A procedure is not a macro that is trusted; it is a
 * run whose thinking is pre-paid and whose checking is not skipped.
 *
 * When a step breaks — target won't resolve, action throws, check fails — the model gets ONE
 * bounded rescue per step (PROCEDURE_RESCUE_STEPS actions, default 3) with the failing step's
 * intent and the recorded expectation as its goal. The expectation is the procedure's, not the
 * model's: rescue is teardown's trick reused — the harness owns the check, so a rescue
 * cannot talk its way into a pass (`src/core/teardown.ts` for the original argument). If
 * rescue is disabled (`PROCEDURE_RESCUE=0`, or no model client is supplied) a broken step fails
 * the replay, which is the honest fleet default: a drifted app needs re-recording, not
 * improvisation at 3am.
 *
 * Replayed runs journal their mutations exactly like live runs — the journal is mechanical
 * (a value diff), so it costs nothing and keeps `npm run cleanup` working on a replay that
 * dies mid-task. Teardown/claims stay the CALLER's concern, same as agent.ts, because
 * whether to restore is a policy question (CLEANUP env) the engine should not decide.
 */

const SETTLE_MS = 900;

export interface ReplayStepResult {
	step: ProcedureStep;
	index: number;
	outcome: "verified" | "rescued" | "failed";
	note: string;
	/** Model calls spent on this step. 0 on the deterministic path. */
	modelCalls: number;
}

export interface ReplayResult {
	ok: boolean;
	steps: ReplayStepResult[];
	/** The procedure's final goal evidence, checked against a fresh last observation. */
	finalCheck?: { verified: boolean; note: string };
	modelCalls: number;
	/** StepRecords in the run-log shape, so a replay writes the same artifact a run does. */
	records: StepRecord[];
}

export interface ReplayDeps {
	/** Exactly one of driver/cdp, mirroring runTeardown's contract. */
	driver?: Driver;
	cdp?: CdpBackend;
	win?: WindowRef;
	observe: (name: string) => Promise<ObservationBundle>;
	/** Rescue client; absent = deterministic-only, a broken step fails the replay. */
	client?: ModelClient;
	model?: string;
	rescue?: (args: RescueArgs) => Promise<{ ok: boolean; note: string; calls: number }>;
	graph?: AppMap;
	/** Value substituted for `{{unique}}`. Injected by tests; a clock stamp otherwise. */
	unique?: string;
	journalPath?: string;
	log?: (line: string) => void;
	/**
	 * Structured-event sink, the `log` callback's sibling: the engine has no run stamp (that
	 * is the CLI's business), so the caller decides where events land — procedure-cli.ts wires
	 * this to runEvent(stamp, …). Optional like log; absent means no event log, never an error.
	 */
	event?: (kind: string, detail: Record<string, unknown>) => void;
}

export interface RescueArgs {
	deps: ReplayDeps;
	step: ProcedureStep;
	index: number;
	obs: ObservationBundle;
	prevHaystack: string;
	problem: string;
}

async function act(deps: ReplayDeps, action: Record<string, unknown>): Promise<string> {
	if (deps.cdp) return (await deps.cdp.act(action)).slice(0, 300);
	const request = toActionRequest(action, deps.win!);

	return request ? (await deps.driver!.act(request)).text.slice(0, 300) : "waited";
}

export async function replayProcedure(procedure: Procedure, deps: ReplayDeps): Promise<ReplayResult> {
	if (!!deps.driver === !!deps.cdp) throw new Error("replayProcedure needs exactly one of driver/cdp");
	const log = deps.log ?? ((l: string) => console.log(l));
	const settleDefault = envNum("PROCEDURE_SETTLE_MS", SETTLE_MS);
	const results: ReplayStepResult[] = [];
	const records: StepRecord[] = [];
	let modelCalls = 0;

	/**
	 * One fresh value per replay for every `{{unique}}` the procedure carries.
	 *
	 * A procedure that types its recorded scratch name verbatim is only new once: the second
	 * replay finds the field already reading it and verify() refuses the step, correctly — the
	 * check was satisfied before the action, so nothing proves the action did anything. The
	 * placeholder is resolved here rather than at compile so each run gets its own, and the
	 * SAME one throughout, or the step would type one value and assert another.
	 *
	 * Injectable so a test can pin it; the default is a clock stamp, which is what makes a
	 * scratch name unique in the first place.
	 */
	const unique = deps.unique ?? String(Date.now());
	let obs = await deps.observe("replay-0");
	for (const [i, raw] of procedure.steps.entries()) {
		const step = substituteUnique(raw, unique);
		const index = i + 1;
		const prevHaystack = obs.haystack;
		const prevObs = obs;
		let outcome: ReplayStepResult["outcome"] = "failed";
		let note = "";
		let stepCalls = 0;

		// Resolve → act → settle → observe → verify. Failures fall through to rescue with
		// the specific problem named, so a rescue prompt says what actually broke.
		let problem: string | undefined;
		if (needsTarget(step)) {
			const resolved = resolveTarget(step.target!, obs);
			if ("error" in resolved) problem = resolved.error;
			else {
				try {
					await act(deps, armAction(step, resolved.handle, procedure.backend));
				} catch (err) {
					problem = `action failed: ${err instanceof Error ? err.message : String(err)}`;
				}
			}
		} else {
			try {
				await act(deps, armAction(step, undefined, procedure.backend));
			} catch (err) {
				problem = `action failed: ${err instanceof Error ? err.message : String(err)}`;
			}
		}

		if (!problem) {
			await new Promise((r) => setTimeout(r, settleMsFor({ name: step.action.name, ...step.action.args }, settleDefault)));
			obs = await deps.observe(`replay-${index}`);
			const verdict = verify(step.expectation, obs.haystack, prevHaystack);
			if (verdict.verified) {
				outcome = "verified";
				note = verdict.note;
			} else problem = `check failed: ${verdict.note}`;
		}

		if (problem && deps.rescue && deps.client) {
			log(`  step ${index} broke (${problem}) — invoking rescue`);
			deps.event?.("rescue", { step: index, problem: problem.slice(0, 200) });
			// Rescue sees the CURRENT observation (post-failed-action, where applicable):
			// that is the state it must repair from, not the state the step started in.
			obs = await deps.observe(`replay-${index}-pre-rescue`);
			const r = await deps.rescue({ deps, step, index, obs, prevHaystack, problem });
			stepCalls += r.calls;
			modelCalls += r.calls;
			if (r.ok) {
				outcome = "rescued";
				note = r.note;
				obs = await deps.observe(`replay-${index}-post-rescue`);
			} else note = `${problem}; rescue failed: ${r.note}`;
		} else if (problem) note = problem;

		results.push({ step, index, outcome, note, modelCalls: stepCalls });
		records.push({
			index,
			timestamp: new Date().toISOString(),
			action: { kind: "tool", name: step.action.name, args: step.action.args },
			expectation: step.expectation,
			verified: outcome !== "failed",
			verificationChannel: outcome === "failed" ? undefined : "text",
			verificationNote: note,
			modelReasoning: outcome === "rescued" ? `rescued after: ${note}` : `replayed from procedure ${procedure.compiledFrom}`,
		});
		const mark = outcome === "verified" ? "✓" : outcome === "rescued" ? "✓ (rescued)" : "✗";
		log(`  ${mark} [${index}/${procedure.steps.length}] ${step.action.name}${step.target ? ` "${step.target.name}"` : ""}${outcome === "failed" ? ` — ${note}` : ""}`);
		deps.event?.("step", {
			step: index,
			action: step.action.name,
			...(step.target?.name ? { target: step.target.name } : {}),
			outcome,
		});

		// Journal exactly as the live loop does: mechanical value diff, appended on detection,
		// so a replay that dies mid-task is recoverable by the same cleanup CLI.
		if (deps.journalPath && outcome !== "failed") {
			const mutation = detectMutation({ name: step.action.name, ...step.action.args }, prevObs, obs, deps.graph, index);
			if (mutation) appendMutation(deps.journalPath, mutation);
		}

		if (outcome === "failed")
			return { ok: false, steps: results, modelCalls, records };
	}

	// The procedure's own goal gate, replayed against a FRESH observation — same authority as
	// done(success) grading in the live loop. A procedure without one (old run log) passes on
	// steps alone, and the result says so.
	let finalCheck: ReplayResult["finalCheck"];
	if (procedure.finalEvidence) {
		const last = await deps.observe("replay-final");
		const v = verify(procedure.finalEvidence, last.haystack);
		finalCheck = { verified: v.verified, note: v.note };
		log(`  final goal check: ${v.verified ? "PASSED" : `failed — ${v.note}`}`);
		deps.event?.("goal-check", { verified: v.verified });
	}

	return { ok: finalCheck ? finalCheck.verified : true, steps: results, finalCheck, modelCalls, records };
}

const RESCUE_SYSTEM = `You are repairing ONE broken step of a recorded UI automation replay. The app has drifted from what the recording remembers — a control moved, was renamed, or a dialog is in the way.

You get the step's original intent, the recorded success check, and an observation. Perform at most the budgeted number of actions with the "act" tool to reach the state the check describes. The harness runs the RECORDED check after each of your actions; your own expectation field is a note, not the gate. Do not pursue the task beyond this one step, and do not touch unrelated controls.`;

/**
 * The default rescue: one bounded mini-loop per broken step, checked by the harness against
 * the PROCEDURE's expectation. Kept separate from replayProcedure so tests can inject a fake and
 * the deterministic engine stays free of SDK imports at call time.
 */
export async function modelRescue(a: RescueArgs): Promise<{ ok: boolean; note: string; calls: number }> {
	const { deps, step } = a;
	const budget = envNum("PROCEDURE_RESCUE_STEPS", 3);
	const { ACT_TOOL, observationBlocks } = await import("./harness.js");
	const { CDP_ACT_TOOL } = await import("../backends/cdp.js");
	let calls = 0;
	let obs = a.obs;

	const messages: Anthropic.MessageParam[] = [
		{
			role: "user",
			content: [
				{
					type: "text",
					text:
						`A replayed step failed. Repair it.\n\n` +
						`Step intent: ${step.action.name}${step.target ? ` on "${step.target.name}"${step.target.surface ? ` (surface: ${step.target.surface})` : ""}` : ""} with args ${JSON.stringify(step.action.args)}\n` +
						`What broke: ${a.problem}\n` +
						`Success check (harness-owned): ${JSON.stringify(step.expectation)}\n\nObservation follows.`,
				},
				...observationBlocks(obs, false),
			],
		},
	];

	for (let n = 1; n <= budget; n++) {
		const r = await deps.client!.messages.create({
			model: deps.model!,
			max_tokens: 2000,
			system: RESCUE_SYSTEM,
			tools: [deps.cdp ? CDP_ACT_TOOL : ACT_TOOL],
			messages,
		});
		calls++;
		const toolUse = r.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
		if (!toolUse) return { ok: false, note: `model stopped after ${n - 1} rescue action(s)`, calls };
		messages.push({ role: "assistant", content: r.content });

		const input = toolUse.input as { action: any };
		let resultText: string;
		try {
			resultText = await act(deps, input.action ?? {});
		} catch (err) {
			resultText = `ACTION FAILED: ${err instanceof Error ? err.message : String(err)}`;
		}
		await new Promise((res) => setTimeout(res, envNum("PROCEDURE_SETTLE_MS", SETTLE_MS)));
		obs = await deps.observe(`replay-rescue-${a.index}-${n}`);

		// The procedure's check, against the pre-step baseline — the rescue passes exactly when
		// the original step would have.
		const verdict = verify(step.expectation, obs.haystack, a.prevHaystack);
		if (verdict.verified) return { ok: true, note: `rescued in ${n} action(s)`, calls };

		messages.push({
			role: "user",
			content: [
				{
					type: "tool_result",
					tool_use_id: toolUse.id,
					content: [
						{ type: "text", text: `Driver result: ${resultText}\nCheck not yet satisfied: ${verdict.note}\nNew observation follows.` },
						...observationBlocks(obs, false),
					],
				},
			],
		});
	}

	return { ok: false, note: `check not satisfied within ${budget} rescue action(s)`, calls };
}
